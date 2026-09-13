/**
 * Source: Singapore NEMS market data — USEP, demand, solar and ancillary prices.
 *
 * THE STORY OF THIS FILE (worth reading before trusting any number below)
 * ---------------------------------------------------------------------
 * The build spec names `energy-trading-api==0.0.34` as the PRIMARY USEP path:
 *
 *     from energy_trading_api import singaporeNEMS
 *     df = singaporeNEMS.singaporeUSEP(date="2026-09-01")
 *
 * That package was installed and invoked exactly as documented. It is a thin
 * `pandas.read_html()` over:
 *     https://www.emcsg.com/marketdata/priceinformation?...&dataType=USEP
 * EMC has since moved market data behind PingFederate SSO: that URL answers
 * HTTP 200 with an auto-POST SAML login form, `read_html` finds no tables, and
 * the wrapper returns `None`. Reproduced for current, recent and historical
 * dates (see `tools/usep_mandated.py`, whose output the Data Sources panel
 * displays verbatim). `www.emcsg.com` additionally 302-redirects every path to
 * the SSO host, and `www.sewplus.emcsg.com` needs an account.
 *
 * The data is nevertheless still public — EMC's NEMS portal exposes an
 * unauthenticated download API on a different host:
 *
 *   https://www.nems.emcsg.com/api/sitecore/DataSync/DataDownload
 *       ?value=10&fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD&tpcValue=1
 *
 *   value=10  -> RT48 EGO: Date, Period, Demand (MW), Solar (MW), TCL (MW),
 *                USEP ($/MWh), EHEUR, LCP, RUSEP, MAP, MAPT, TPC Applied,
 *                Last Updated          (48 half-hourly rows per day)
 *   value=11  -> RT48 Ancillary: Primary Reserve, Contingency Reserve,
 *                Regulation prices ($/MWh) - the basis for DR revenue
 *
 * Retention reaches back roughly three years (2023-06 verified present,
 * 2023-01 returns HTTP 204 No Content). Multi-month ranges are accepted in a
 * single request; ingestion is chunked anyway to stay a polite client.
 *
 * Every row stores EMC's own `Last Updated` stamp, so the freshness shown in
 * the UI is EMC's, not ours.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { store } from "../store/index.ts";
import type { MarketPeriod } from "../store/types.ts";
import type { SourceDescriptor } from "./types.ts";
import { ageHours } from "./types.ts";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

const NEMS_BASE = "https://www.nems.emcsg.com/api/sitecore/DataSync/DataDownload";

export const NEMS_SOURCE: SourceDescriptor = {
  id: "emc_nems_rt48",
  name: "Singapore NEMS — USEP, demand & ancillary prices",
  provides:
    "Half-hourly wholesale spot price (USEP), system demand, solar output and ancillary service reserve prices for Singapore.",
  unit: "SGD/MWh (prices); MW (demand, solar)",
  access: "open",
  url: "https://www.nems.emcsg.com/nems-prices",
  endpoint: `${NEMS_BASE}?value=10&fromDate={YYYY-MM-DD}&toDate={YYYY-MM-DD}&tpcValue=1`,
  publisher: "Energy Market Company (EMC) — NEMS portal",
  maxAgeHours: 24,
  notes:
    "Unauthenticated CSV download. Roughly 3 years of history. The 'Last Updated' column is EMC's own publication stamp and is stored per row.",
};

export const MANDATED_PACKAGE_SOURCE: SourceDescriptor = {
  id: "energy_trading_api_0_0_34",
  name: "energy-trading-api 0.0.34 (spec-mandated path)",
  provides:
    "The USEP access path named in the build spec. Documented here because it no longer works.",
  unit: "SGD/MWh",
  access: "broken",
  url: "https://github.com/jericmac/energy-trading-api-wrappers",
  endpoint:
    "https://www.emcsg.com/marketdata/priceinformation?doAccessData=true&USEP_accessAction=dataView&USEP_date={DD+Mon+YYYY}&dataType=USEP",
  publisher: "third-party wrapper over EMC market data",
  maxAgeHours: 24,
  limitation:
    "The wrapper scrapes an EMC endpoint that now requires PingFederate SSO. It returns None for every date. Superseded by the NEMS DataDownload feed above.",
};

/* ------------------------------------------------------------------ */
/* CSV plumbing                                                        */
/* ------------------------------------------------------------------ */

/** Split one CSV line, honouring double-quoted fields with "" escapes. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** "01-Sep-2026" -> "2026-09-01". Returns null when unparseable. */
function parseEmcDate(s: string): string | null {
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const mon = MONTHS[m[2].toLowerCase()];
  if (!mon) return null;
  return `${m[3]}-${String(mon).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

/**
 * "00:30-01:00" -> "T00:30:00+08:00".
 * The trading period is labelled by its start, so the left side is the anchor.
 * Singapore is a fixed UTC+8 offset with no DST, so this is unambiguous.
 */
function parseEmcPeriod(s: string): string | null {
  const m = s.match(/^(\d{2}):(\d{2})\s*-\s*\d{2}:\d{2}$/);
  if (!m) return null;
  return `T${m[1]}:${m[2]}:00+08:00`;
}

function num(s: string | undefined): number | null {
  if (s === undefined) return null;
  const t = s.trim();
  if (!t || t === "-" || /^n\/?a$/i.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

export interface NemsFetchResult {
  rows: MarketPeriod[];
  sourceLastUpdated: string | null;
  /** Periods the feed reported but that we could not parse. */
  skipped: number;
}

/** Fetch one series over an inclusive date range and parse it. */
export async function fetchNemsSeries(
  value: 10 | 11,
  fromDate: string,
  toDate: string
): Promise<NemsFetchResult> {
  const url = `${NEMS_BASE}?value=${value}&fromDate=${fromDate}&toDate=${toDate}&tpcValue=1`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (res.status === 204) return { rows: [], sourceLastUpdated: null, skipped: 0 };
  if (!res.ok) throw new Error(`NEMS HTTP ${res.status} for ${url}`);
  const text = await res.text();

  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim().length);
  if (lines.length < 2) return { rows: [], sourceLastUpdated: null, skipped: 0 };

  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const col = (...names: string[]) =>
    header.findIndex((h) => names.some((n) => h.includes(n)));

  const iDate = col("date");
  const iPeriod = col("period");
  const iUsep = col("usep ($/mwh)", "usep");
  const iDemand = col("demand");
  const iSolar = col("solar");
  const iPrim = col("primary reserve");
  const iCont = col("contingency reserve");
  const iReg = header.findIndex((h) => /^regulation/.test(h));
  const iTpc = col("tpc applied");
  const iUpd = col("last updated");
  // Full-length keys matter here: "map" would also match "mapt".
  const iMap = col("map ($/mwh)");
  const iMapt = col("mapt ($/mwh)");
  const iLcp = col("lcp");

  if (iDate < 0 || iPeriod < 0) {
    throw new Error(
      `Unexpected NEMS header for value=${value}: ${lines[0].slice(0, 200)}`
    );
  }

  const byTs = new Map<string, MarketPeriod>();
  let skipped = 0;
  let sourceLastUpdated: string | null = null;

  for (let i = 1; i < lines.length; i++) {
    const c = splitCsvLine(lines[i]);
    const d = parseEmcDate(c[iDate] ?? "");
    const p = parseEmcPeriod(c[iPeriod] ?? "");
    if (!d || !p) {
      skipped++;
      continue;
    }
    const ts = d + p;
    const upd = iUpd >= 0 ? (c[iUpd] ?? null) : null;
    if (upd && (!sourceLastUpdated || upd > sourceLastUpdated)) {
      sourceLastUpdated = upd;
    }

    const existing = byTs.get(ts) ?? {
      ts,
      usep: null,
      demand_mw: null,
      solar_mw: null,
      primary_reserve: null,
      contingency_reserve: null,
      regulation: null,
      map_price: null,
      mapt: null,
      lcp: null,
      tpc_applied: null,
      source_last_updated: upd,
      source_id: NEMS_SOURCE.id,
    };

    // Merge, so value=10 and value=11 calls can populate one period row.
    if (value === 10) {
      existing.usep = num(c[iUsep]);
      existing.demand_mw = num(c[iDemand]);
      existing.solar_mw = num(c[iSolar]);
      // The Temporary Price Cap fields and the Load Curtailment Price ride
      // along in the same EGO file and are what DR settlement is based on.
      if (iMap >= 0) existing.map_price = num(c[iMap]);
      if (iMapt >= 0) existing.mapt = num(c[iMapt]);
      if (iLcp >= 0) existing.lcp = num(c[iLcp]);
    } else {
      existing.primary_reserve = num(c[iPrim]);
      existing.contingency_reserve = num(c[iCont]);
      existing.regulation = iReg >= 0 ? num(c[iReg]) : null;
    }
    if (iTpc >= 0 && c[iTpc]) existing.tpc_applied = c[iTpc];
    if (upd) existing.source_last_updated = upd;

    byTs.set(ts, existing);
  }

  return { rows: [...byTs.values()], sourceLastUpdated, skipped };
}

/* ------------------------------------------------------------------ */
/* Ingestion                                                           */
/* ------------------------------------------------------------------ */

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SyncReport {
  from: string;
  to: string;
  requests: number;
  periodsStored: number;
  sourceLastUpdated: string | null;
  skipped: number;
  status: "OK" | "FAILED" | "EMPTY";
  error?: string;
}

/**
 * Backfill or refresh the half-hourly market dataset.
 *
 * The feed does not enforce its documented 31-day-per-file limit — a single
 * request can return the entire multi-year history. Ingestion is nevertheless
 * chunked: a failure then costs one chunk rather than the whole backfill, and
 * the client stays well-behaved. 90-day chunks keep a full 3-year backfill to a
 * handful of requests.
 *
 * USEP (value=10) is fetched across the whole window. Ancillary reserve prices
 * (value=11) are fetched only for the recent window, because DR analysis is
 * forward-looking and doubling every historical request would be wasteful.
 */
export async function syncNems(opts: {
  days?: number;
  fromDate?: string;
  toDate?: string;
  includeAncillary?: boolean;
  /** How far back to pull ancillary reserve prices. */
  ancillaryDays?: number;
  chunkDays?: number;
} = {}): Promise<SyncReport> {
  const includeAncillary = opts.includeAncillary ?? true;
  const ancillaryDays = opts.ancillaryDays ?? 180;
  const chunkDays = opts.chunkDays ?? 90;

  const today = new Date();
  const to = opts.toDate ?? isoDate(today);
  const from = opts.fromDate ?? isoDate(addDays(today, -(opts.days ?? 90) + 1));
  const ancillaryFrom = isoDate(
    new Date(Math.max(Date.parse(`${from}T00:00:00Z`), Date.parse(`${to}T00:00:00Z`) - ancillaryDays * 86_400_000))
  );

  const runId = await store.beginRun(NEMS_SOURCE.id);
  const report: SyncReport = {
    from,
    to,
    requests: 0,
    periodsStored: 0,
    sourceLastUpdated: null,
    skipped: 0,
    status: "EMPTY",
  };

  try {
    let cursor = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);

    while (cursor <= end) {
      const chunkEnd = new Date(
        Math.min(addDays(cursor, chunkDays - 1).getTime(), end.getTime())
      );
      const f = isoDate(cursor);
      const t = isoDate(chunkEnd);

      const eg = await fetchNemsSeries(10, f, t);
      report.requests++;
      report.skipped += eg.skipped;
      if (eg.sourceLastUpdated) report.sourceLastUpdated = eg.sourceLastUpdated;
      if (eg.rows.length) report.periodsStored += await store.insertMarketPeriods(eg.rows);

      // Only pull ancillary prices where they overlap the recent window.
      if (includeAncillary && t >= ancillaryFrom) {
        const af = f < ancillaryFrom ? ancillaryFrom : f;
        await sleep(150);
        const anc = await fetchNemsSeries(11, af, t);
        report.requests++;
        if (anc.rows.length) await store.insertMarketPeriods(anc.rows);
      }

      cursor = addDays(chunkEnd, 1);
      await sleep(150);
    }

    report.status = report.periodsStored > 0 ? "OK" : "EMPTY";
    await store.finishRun(runId, {
      status: report.status,
      httpStatus: 200,
      records: report.periodsStored,
      detail: `${report.periodsStored} half-hour periods stored for ${from}..${to} in ${report.requests} requests. ${report.skipped} unparseable rows skipped. EMC last updated: ${report.sourceLastUpdated ?? "n/a"}.`,
    });
  } catch (err) {
    report.status = "FAILED";
    report.error = err instanceof Error ? err.message : String(err);
    await store.finishRun(runId, {
      status: "FAILED",
      records: report.periodsStored,
      error: report.error,
    });
  }

  return report;
}

/* ------------------------------------------------------------------ */
/* Spec-mandated path — retained so its failure stays visible          */
/* ------------------------------------------------------------------ */

export interface MandatedProbe {
  ran: boolean;
  available: boolean;
  verdict: string;
  raw: unknown;
  reason?: string;
}

/**
 * Run the mandated `energy-trading-api` call in the project venv and read back
 * its verdict. The child writes JSON to a file rather than a pipe, so this
 * works regardless of process-confinement rules.
 */
export function probeMandatedPackage(): Promise<MandatedProbe> {
  const root = process.cwd();
  const py =
    process.platform === "win32"
      ? path.join(root, ".venv", "Scripts", "python.exe")
      : path.join(root, ".venv", "bin", "python");
  const script = path.join(root, "tools", "usep_mandated.py");
  const outFile = path.join(root, "data", "mandated_probe.json");

  if (!fs.existsSync(py) || !fs.existsSync(script)) {
    return Promise.resolve({
      ran: false,
      available: false,
      verdict:
        "The spec-mandated package was not exercised here; see notes for what it does.",
      raw: null,
      reason: !fs.existsSync(py)
        ? `no interpreter at ${py}`
        : "tools/usep_mandated.py missing",
    });
  }

  return new Promise((resolve) => {
    execFile(
      py,
      [script, "--out", outFile],
      { cwd: root, timeout: 120_000, windowsHide: true },
      () => {
        // The exit code is deliberately ignored; the JSON verdict is the result.
        try {
          const raw = JSON.parse(fs.readFileSync(outFile, "utf8"));
          resolve({
            ran: true,
            available: Boolean(raw.path_usable),
            verdict: String(raw.verdict ?? "no verdict recorded"),
            raw,
          });
        } catch (e) {
          resolve({
            ran: false,
            available: false,
            verdict: "Probe produced no readable result.",
            raw: null,
            reason: e instanceof Error ? e.message : String(e),
          });
        }
      }
    );
  });
}

/* ------------------------------------------------------------------ */
/* Status                                                             */
/* ------------------------------------------------------------------ */

export async function nemsStatus() {
  const [r, last] = await Promise.all([
    store.marketRange(),
    store.lastRun(NEMS_SOURCE.id),
  ]);
  const age = r.observed_at ? ageHours(r.observed_at) : null;
  const spanDays =
    r.lo && r.hi ? (Date.parse(r.hi) - Date.parse(r.lo)) / 86_400_000 : 0;
  return {
    count: r.n,
    first: r.lo,
    last: r.hi,
    observed_at: r.observed_at,
    age_hours: age === null ? null : Math.round(age * 10) / 10,
    stale: age === null ? true : age > NEMS_SOURCE.maxAgeHours,
    span_days: Math.round(spanDays * 10) / 10,
    emc_last_updated: r.src_hi,
    last_run_status: last?.status ?? "NEVER_RUN",
    last_run_detail: last?.detail ?? null,
    source: NEMS_SOURCE,
  };
}

/** Cheap liveness check against the live feed (last 2 days). */
export async function pingNems(): Promise<{
  ok: boolean;
  httpStatus: number | null;
  periods: number;
  detail: string;
}> {
  const today = new Date();
  const from = isoDate(addDays(today, -1));
  const to = isoDate(today);
  try {
    const r = await fetchNemsSeries(10, from, to);
    return {
      ok: r.rows.length > 0,
      httpStatus: 200,
      periods: r.rows.length,
      detail: r.rows.length
        ? `Feed returned ${r.rows.length} half-hour periods; EMC last updated ${r.sourceLastUpdated ?? "n/a"}.`
        : "Feed reachable but returned no periods.",
    };
  } catch (e) {
    return {
      ok: false,
      httpStatus: null,
      periods: 0,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}
