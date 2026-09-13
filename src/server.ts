/**
 * Strike API server.
 *
 * Serves the analytics API and, in the single-process deployment, the built web
 * client. Storage is chosen by environment: SQLite locally, Postgres (Neon) when
 * DATABASE_URL is set.
 *
 *   npm run build:web && npm start          local, SQLite
 *   DATABASE_URL=... npm start              Postgres
 */
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import fs from "node:fs";

import { store, storageDescription, closeStore } from "./store/index.ts";
import {
  syncNems,
  pingNems,
  probeMandatedPackage,
  nemsStatus,
  NEMS_SOURCE,
  MANDATED_PACKAGE_SOURCE,
} from "./sources/usep.ts";
import { syncRegulatedTariff, EMA_TARIFF_SOURCE } from "./sources/emaTariff.ts";
import { MARKET_FACTS } from "./sources/facts.ts";
import {
  shapeLoad,
  intradayShape,
  peakOffPeak,
  nonEnergyFromTariff,
  DEFAULT_PROFILE,
  type BuyerProfile,
} from "./analytics/loadshape.ts";
import { optimiseShift, cheapestWindows } from "./analytics/priceActions.ts";
import { estimateDr, DEFAULT_DR_PARAMS, ancillarySeries } from "./analytics/dr.ts";
import { computeSignal } from "./analytics/signal.ts";
import { computeFairValue } from "./analytics/fairValue.ts";
import { sgtDate, round } from "./analytics/time.ts";

const PORT = Number(process.env.PORT ?? 8791);
// Render and most PaaS providers route to the container, so the default there
// must be 0.0.0.0. Locally, loopback-only is the safer default.
const HOST =
  process.env.HOST ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  // Behind a PaaS proxy the client IP arrives in X-Forwarded-For.
  trustProxy: true,
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Format an instant the same way market rows are stored: ISO8601 with a fixed
 * +08:00 offset.
 *
 * This matters. Stored timestamps look like "2026-09-12T23:30:00+08:00". Bound
 * values produced by `toISOString()` look like "2026-09-12T15:30:00.000Z".
 * Comparing those two strings lexicographically is not a valid time comparison —
 * it happens to work across different months and quietly misclassifies rows
 * within the same day. Emitting bounds in the stored format makes the string
 * comparison exact, in both SQLite and Postgres.
 */
function sgtIso(d: Date): string {
  return new Date(d.getTime() + 8 * 3_600_000).toISOString().slice(0, 19) + "+08:00";
}

/** Upper sentinel: later than any realistic period, in the same format. */
const FAR_FUTURE = "9999-12-31T00:00:00+08:00";

function num(v: unknown, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/**
 * Load only the requested window.
 *
 * The analytics window is derived from the newest stored period rather than
 * wall-clock time, so a dataset that is a few days behind still shows a full
 * window instead of a shortened one. Fetching just the window also keeps the
 * payload bounded — important on a Neon free compute, where pulling the entire
 * multi-year history on every request would burn I/O for nothing.
 */
async function loadWindow(days: number) {
  const range = await store.marketRange();
  if (!range.n || !range.hi) return { periods: [], range, from: FAR_FUTURE };
  const from = sgtIso(new Date(Date.parse(range.hi) - days * 86_400_000));
  const periods = await store.listMarketPeriods(from, FAR_FUTURE);
  return { periods, range, from };
}

/** Buyer profile from query params, validated against sensible bounds. */
async function profileFrom(q: Record<string, unknown>): Promise<BuyerProfile> {
  const saved = await store.getProfile("default");
  return {
    name: "default",
    annual_mwh: Math.max(1, num(q.mwh, saved?.annual_mwh ?? DEFAULT_PROFILE.annual_mwh)),
    alpha: Math.min(3, Math.max(0, num(q.alpha, saved?.load_factor ?? DEFAULT_PROFILE.alpha))),
    curtailable_mw: Math.max(
      0,
      num(q.curtailable_mw, saved?.curtailable_mw ?? DEFAULT_PROFILE.curtailable_mw)
    ),
  };
}

/* ------------------------------------------------------------------ */
/* CORS                                                                */
/* ------------------------------------------------------------------ */

/**
 * Allow the API to be called from a separately-hosted frontend (for example a
 * static frontend on Vercel talking to this API on Render).
 *
 * ALLOWED_ORIGINS is a comma-separated allowlist. When it is unset, same-origin
 * use needs no CORS headers at all, so nothing is emitted — which is the secure
 * default rather than reflecting arbitrary origins.
 */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (ALLOWED_ORIGINS.length) {
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
      reply.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
      reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
      reply.header("Access-Control-Max-Age", "86400");
    }
    if (req.method === "OPTIONS") return reply.code(204).send();
  });
}

/* ------------------------------------------------------------------ */
/* Source registry                                                     */
/* ------------------------------------------------------------------ */

app.get("/api/sources", async () => {
  const [ms, mandated, t, tariffCount, nemsRun, tariffRun, mandatedRun] =
    await Promise.all([
      nemsStatus(),
      probeMandatedPackage().catch(() => null),
      store.latestTariff(),
      store.listTariffs(),
      store.lastRun(NEMS_SOURCE.id),
      store.lastRun(EMA_TARIFF_SOURCE.id),
      store.lastRun(MANDATED_PACKAGE_SOURCE.id),
    ]);

  const sources = [
    {
      ...NEMS_SOURCE,
      status: ms.count > 0 ? "OK" : "EMPTY",
      health: ms.count > 0 ? "live" : "no data",
      stored: {
        records: ms.count,
        first: ms.first,
        last: ms.last,
        span_days: ms.span_days,
        age_hours: ms.age_hours,
        stale: ms.stale,
        publisher_last_updated: ms.emc_last_updated,
      },
      last_run: nemsRun,
      active: true,
    },
    {
      ...EMA_TARIFF_SOURCE,
      status: t ? "OK" : "EMPTY",
      health: t ? "live" : "no data",
      stored: {
        records: tariffCount.length,
        latest_quarter: t?.quarter ?? null,
        latest_total_c: t?.total_c ?? null,
      },
      last_run: tariffRun,
      active: true,
    },
    {
      ...MANDATED_PACKAGE_SOURCE,
      status: mandated?.available ? "OK" : "AUTH_REQUIRED",
      health: mandated?.available ? "returned data" : "returns no data",
      stored: { records: 0 },
      last_run: mandatedRun,
      probe: mandated,
      active: false,
    },
  ];

  return {
    generated_at: new Date().toISOString(),
    storage: storageDescription(),
    sources,
    facts: MARKET_FACTS,
  };
});

/* ------------------------------------------------------------------ */
/* Tariff                                                              */
/* ------------------------------------------------------------------ */

app.get("/api/tariff", async () => {
  const [quarters, latest] = await Promise.all([
    store.listTariffs(),
    store.latestTariff(),
  ]);
  return {
    latest,
    quarters,
    non_energy: latest
      ? nonEnergyFromTariff({
          network_c: latest.network_c,
          mss_c: latest.mss_c,
          pso_c: latest.pso_c,
          quarter: latest.quarter,
          source_url: latest.source_url,
        })
      : null,
  };
});

app.post("/api/tariff/sync", async (req) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  return syncRegulatedTariff(num(b.lookback, 12));
});

/* ------------------------------------------------------------------ */
/* Market data                                                         */
/* ------------------------------------------------------------------ */

app.get("/api/market/status", async () => nemsStatus());
app.get("/api/market/ping", async () => pingNems());

app.post("/api/market/sync", async (req) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const days = Math.min(1200, Math.max(1, num(b.days, 90)));
  const r = await syncNems({
    days,
    fromDate: typeof b.from === "string" ? b.from : undefined,
    toDate: typeof b.to === "string" ? b.to : undefined,
  });
  return { sync: r, status: await nemsStatus() };
});

/* ------------------------------------------------------------------ */
/* Dashboard — the main aggregate the UI renders                        */
/* ------------------------------------------------------------------ */

app.get("/api/dashboard", async (req) => {
  const q = (req.query ?? {}) as Record<string, unknown>;
  const days = Math.min(400, Math.max(3, num(q.days, 90)));
  const profile = await profileFrom(q);

  const { periods, range } = await loadWindow(days);

  if (!periods.length) {
    return {
      ready: false,
      reason:
        "No half-hourly market data has been ingested yet. Run a market data sync to populate real USEP history.",
      status: await nemsStatus(),
      tariff: await store.latestTariff(),
      facts: MARKET_FACTS,
    };
  }

  const [latest, tariffQuarters, offers] = await Promise.all([
    store.latestTariff(),
    store.listTariffs(),
    store.listOffers(),
  ]);

  const load = shapeLoad(periods, profile);
  const tariffForCalc = latest ?? {
    quarter: "unknown",
    total_c: 0,
    network_c: null,
    mss_c: null,
    pso_c: null,
    source_url: null,
  };

  const signal = computeSignal({
    periods,
    load,
    profile,
    tariff: {
      quarter: tariffForCalc.quarter,
      total_c: tariffForCalc.total_c,
      network_c: tariffForCalc.network_c,
      mss_c: tariffForCalc.mss_c,
      pso_c: tariffForCalc.pso_c,
      source_url: tariffForCalc.source_url,
    },
    offers,
  });

  const shift = optimiseShift(
    load.periods.map((p) => ({ ts: p.ts, usep: p.usep, mwh: p.mwh, mw: p.mw })),
    profile.curtailable_mw
  );

  const dr = estimateDr(periods, {
    ...DEFAULT_DR_PARAMS,
    curtailable_mw: profile.curtailable_mw,
  });

  // Fair value reference, built from the two independent published anchors that
  // are already stored: the LRMC implied by the Temporary Price Cap, and the
  // tariff's own energy component.
  const fairValue = signal.comparison
    ? computeFairValue({
        periods,
        tariffEnergyC: tariffForCalc.energy_c,
        tariffQuarter: tariffForCalc.quarter,
        tariffSourceUrl: tariffForCalc.source_url,
        nonEnergyC: signal.comparison.non_energy.total_c,
        wholesaleAllInC: signal.comparison.usep.avg / 10 + signal.comparison.non_energy.total_c,
        regulatedAllInC: tariffForCalc.total_c,
      })
    : null;

  // Daily real averages for the history chart.
  const byDay = new Map<string, number[]>();
  for (const p of periods) {
    if (p.usep === null) continue;
    const d = sgtDate(p.ts);
    const arr = byDay.get(d);
    if (arr) arr.push(p.usep);
    else byDay.set(d, [p.usep]);
  }
  const daily = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, xs]) => ({
      date,
      mean: round(xs.reduce((a, b) => a + b, 0) / xs.length, 2),
      min: round(Math.min(...xs), 2),
      max: round(Math.max(...xs), 2),
      samples: xs.length,
    }));

  return {
    ready: true,
    generated_at: new Date().toISOString(),
    window: { days, from: periods[0].ts, to: periods[periods.length - 1].ts, periods: periods.length },
    profile,
    status: await nemsStatus(),
    tariff: latest,
    tariff_quarters: tariffQuarters,
    signal,
    fair_value: fairValue,
    load_diagnostics: load.diagnostics,
    shift,
    dr,
    intraday: intradayShape(periods),
    peak_off_peak: peakOffPeak(periods),
    daily,
    ancillary: ancillarySeries(periods.slice(-48 * 30), 300),
    cheapest_windows: signal.forecast ? cheapestWindows(signal.forecast, 6) : [],
    offers,
    facts: MARKET_FACTS,
  };
});

/* ------------------------------------------------------------------ */
/* Demand response                                                     */
/* ------------------------------------------------------------------ */

app.get("/api/dr", async (req) => {
  const q = (req.query ?? {}) as Record<string, unknown>;
  const days = Math.min(400, Math.max(3, num(q.days, 90)));
  const { periods } = await loadWindow(days);
  if (!periods.length) return { error: "No market data ingested." };

  return estimateDr(periods, {
    curtailable_mw: Math.max(0, num(q.curtailable_mw, 1)),
    event_hours: Math.min(4, Math.max(0.5, num(q.event_hours, 2))),
    delivery_rate: Math.min(1, Math.max(0, num(q.delivery_rate, 1))),
    production_loss_per_mwh: Math.max(0, num(q.production_loss_per_mwh, 0)),
    incentive_override: Math.max(0, num(q.incentive_override, 0)),
  });
});

/* ------------------------------------------------------------------ */
/* Profile and offers                                                  */
/* ------------------------------------------------------------------ */

app.post("/api/profile", async (req) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  await store.upsertProfile({
    name: "default",
    annual_mwh: Math.max(1, num(b.annual_mwh, DEFAULT_PROFILE.annual_mwh)),
    load_factor: Math.min(3, Math.max(0, num(b.alpha, DEFAULT_PROFILE.alpha))),
    peak_share: 0,
    curtailable_mw: Math.max(0, num(b.curtailable_mw, DEFAULT_PROFILE.curtailable_mw)),
  });
  return { ok: true, profile: await profileFrom({}) };
});

app.get("/api/offers", async () => ({ offers: await store.listOffers() }));

app.post("/api/offers", async (req, reply) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const retailer = String(b.retailer ?? "").trim();
  const plan = String(b.plan ?? "").trim();
  const rate = Number(b.rate_c_kwh);
  if (!retailer || !plan) {
    return reply.code(400).send({ error: "retailer and plan are required" });
  }
  if (!Number.isFinite(rate) || rate <= 0 || rate > 200) {
    return reply
      .code(400)
      .send({ error: "rate_c_kwh must be a positive number of cents per kWh (sanity limit 200)" });
  }
  const term =
    b.term_months === null || b.term_months === undefined || b.term_months === ""
      ? null
      : Math.max(1, num(b.term_months, 12));

  await store.upsertOffer({
    retailer,
    plan,
    rate_c_kwh: rate,
    term_months: term,
    notes: typeof b.notes === "string" ? b.notes : null,
  });
  return { ok: true, offers: await store.listOffers() };
});

app.delete("/api/offers/:id", async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  if (!Number.isFinite(id)) return reply.code(400).send({ error: "bad id" });
  await store.deleteOffer(id);
  return { ok: true, offers: await store.listOffers() };
});

/* ------------------------------------------------------------------ */
/* Scheduled ingestion endpoint                                        */
/* ------------------------------------------------------------------ */

/**
 * Daily ingestion entry point for a platform scheduler.
 *
 * Vercel Cron calls this with `Authorization: Bearer $CRON_SECRET` when
 * CRON_SECRET is set on the project. If CRON_SECRET is not configured the route
 * refuses to run, so an unprotected public endpoint can never be used to trigger
 * unbounded outbound fetching.
 *
 * Note this endpoint exists for platform schedulers. The recommended production
 * setup runs ingestion in a GitHub Actions job instead, which writes straight to
 * Neon and does not depend on the web service being awake.
 */
app.get("/api/cron/sync", async (req, reply) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return reply
      .code(503)
      .send({ error: "CRON_SECRET is not configured; scheduled ingestion is disabled." });
  }
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${secret}`) {
    return reply.code(401).send({ error: "unauthorized" });
  }

  const q = (req.query ?? {}) as Record<string, unknown>;
  const days = Math.min(1200, Math.max(1, num(q.days, 7)));

  const market = await syncNems({ days });
  const tariff = await syncRegulatedTariff(12);

  const status = await nemsStatus();
  app.log.info(
    { periods: market.periodsStored, quarters: tariff.quartersStored },
    "scheduled ingestion complete"
  );

  return {
    ok: true,
    market: {
      periods_stored: market.periodsStored,
      requests: market.requests,
      status: market.status,
      error: market.error ?? null,
    },
    tariff: {
      quarters_stored: tariff.quartersStored,
      reconciles: tariff.reconciles,
      detail: tariff.reconciliationDetail,
    },
    totals: { periods: status.count, newest: status.last },
  };
});

app.get("/api/health", async () => {
  const range = await store.marketRange();
  const storage = storageDescription();
  return {
    ok: true,
    storage,
    // Surfaced at the top level so a naive uptime check can alert on it.
    storage_durable: storage.durable,
    periods: range.n,
    newest: range.hi,
    uptime_s: Math.round(process.uptime()),
  };
});

/* ------------------------------------------------------------------ */
/* Static client                                                       */
/* ------------------------------------------------------------------ */

const distDir = path.resolve(process.cwd(), "web", "dist");
if (fs.existsSync(distDir)) {
  await app.register(fastifyStatic, { root: distDir, prefix: "/" });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.sendFile("index.html");
  });
} else {
  app.get("/", async (_req, reply) =>
    reply
      .type("text/html")
      .send(
        `<h1>Strike API is running</h1><p>The web client has not been built yet. Run <code>npm run build:web</code>, then restart.</p><p>API is available under <code>/api/*</code>.</p>`
      )
  );
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    app.log.info(`received ${signal}, shutting down`);
    try {
      await app.close();
      await closeStore();
    } finally {
      process.exit(0);
    }
  });
}

await app.listen({ port: PORT, host: HOST });
const storage = storageDescription();
app.log.info(`Strike listening on http://${HOST}:${PORT}`);
app.log.info(`Storage: ${storage.driver} (${storage.target})`);

/*
 * A missing DATABASE_URL in a hosted environment destroys data silently rather
 * than crashing, so it is reported in a form that cannot be scrolled past and is
 * also exposed on /api/health for alerting.
 */
if (storage.warning) {
  app.log.warn("=".repeat(78));
  app.log.warn("  STORAGE WARNING");
  app.log.warn(`  ${storage.warning}`);
  app.log.warn("=".repeat(78));
}
