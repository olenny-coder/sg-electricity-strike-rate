/**
 * Source: EMA / SP Group regulated electricity tariff.
 *
 * WHY THIS WORKS
 * --------------
 * EMA publishes the current quarterly tariff as prose on its page, and the
 * component breakdown as a CSV asset referenced by the page's chart config.
 * Both are public and unauthenticated.
 *
 *   Page : https://www.ema.gov.sg/consumer-information/electricity/
 *          buying-electricity/buying-at-regulated-tariff
 *   CSV  : https://www.ema.gov.sg/content/dam/corporate/consumer-information/
 *          electricity/electricity-tariff-q<Q>-<YYYY>.csv
 *
 * CSV columns (cents/kWh, EXCLUDING GST):
 *   Energy Costs, Network Costs, MSS Fee, Market Admin and PSO Fee
 *
 * The four components sum exactly to the headline tariff EMA states, which is
 * used here as a self-check: if the sum drifts from the published total, the
 * run is flagged rather than silently stored.
 */
import { store } from "../store/index.ts";
import type { SourceDescriptor } from "./types.ts";
import { round } from "./types.ts";

const PAGE_URL =
  "https://www.ema.gov.sg/consumer-information/electricity/buying-electricity/buying-at-regulated-tariff";
const CSV_BASE =
  "https://www.ema.gov.sg/content/dam/corporate/consumer-information/electricity/electricity-tariff-";

export const EMA_TARIFF_SOURCE: SourceDescriptor = {
  id: "ema_regulated_tariff",
  name: "Regulated Tariff (EMA / SP Group)",
  provides:
    "Quarterly regulated electricity tariff and its four cost components for commercial and industrial buyers who stay on the default tariff.",
  unit: "cents/kWh (ex-GST)",
  access: "open",
  url: PAGE_URL,
  endpoint: `${CSV_BASE}q{Q}-{YYYY}.csv`,
  publisher: "Energy Market Authority (EMA) / SP Group",
  maxAgeHours: 24 * 90, // a quarter
  notes:
    "Components cross-check against the headline tariff EMA publishes, so a corrupted scrape is detected rather than stored. Ingestion skips quarters it already holds, because a published quarter is final — this keeps request volume to roughly one fetch per quarter.",
  limitation:
    "ema.gov.sg is behind Imperva bot management and can answer an automated client with a ~1 KB JavaScript challenge instead of the page, arriving with HTTP 200. The tariff CSVs live on a static /content/dam/ path and are NOT challenged, so the figures stay verifiable; only the optional prose cross-check is lost when this happens. The adapter detects the challenge explicitly rather than parsing an empty page.",
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

/** Singapore has no DST; tariff quarters are plain calendar quarters. */
export function currentQuarter(at: Date = new Date()): { year: number; q: number } {
  // Interpret "now" in SGT (UTC+8) so quarter boundaries match EMA's.
  const sgt = new Date(at.getTime() + 8 * 3_600_000);
  return { year: sgt.getUTCFullYear(), q: Math.floor(sgt.getUTCMonth() / 3) + 1 };
}

/** Walk backwards `count` quarters from the current one, newest first. */
export function recentQuarters(count: number, at: Date = new Date()) {
  const { year, q } = currentQuarter(at);
  const out: { year: number; q: number; label: string }[] = [];
  let y = year;
  let qq = q;
  for (let i = 0; i < count; i++) {
    out.push({ year: y, q: qq, label: `${y}-Q${qq}` });
    qq--;
    if (qq === 0) {
      qq = 4;
      y--;
    }
  }
  return out;
}

interface ParsedCsv {
  energy_c: number;
  network_c: number;
  mss_c: number;
  pso_c: number;
}

function parseTariffCsv(text: string): ParsedCsv | null {
  // Strip a UTF-8 BOM that EMA's CSVs carry.
  const clean = text.replace(/^\uFEFF/, "").trim();
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) return null;
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const values = lines[1].split(",").map((v) => Number(v.trim()));

  const idx = (...names: string[]) =>
    header.findIndex((h) => names.some((n) => h.includes(n)));

  const iEnergy = idx("energy");
  const iNetwork = idx("network");
  const iMss = idx("mss", "market support");
  const iPso = idx("pso", "admin");

  if ([iEnergy, iNetwork, iMss, iPso].some((i) => i < 0)) return null;
  if ([iEnergy, iNetwork, iMss, iPso].some((i) => !Number.isFinite(values[i]))) return null;

  return {
    energy_c: values[iEnergy],
    network_c: values[iNetwork],
    mss_c: values[iMss],
    pso_c: values[iPso],
  };
}

/**
 * Detect a bot-management challenge.
 *
 * ema.gov.sg sits behind Imperva (Incapsula). Repeated automated requests get a
 * JavaScript challenge instead of the page: the response is a ~950-byte HTML
 * shell with an iframe pointing at `/_Incapsula_Resource` and the text
 * "Request unsuccessful". Critically it arrives with **HTTP 200**, so a naive
 * scraper would treat it as success and parse nothing.
 *
 * The static CSV assets under /content/dam/ are NOT challenged, so the tariff
 * figures themselves remain reliably fetchable; only the prose headline is
 * affected. This distinction is why the CSV is the primary source.
 */
const WAF_MARKERS = [
  /_Incapsula_Resource/i,
  /Request unsuccessful/i,
  /Incapsula incident ID/i,
  /main-iframe/i,
];

export function isBotChallenge(body: string): boolean {
  return WAF_MARKERS.some((re) => re.test(body));
}

export type HeadlineResult =
  | {
      status: "OK";
      centsExGst: number;
      centsIncGst: number;
      quarterLabel: string;
      quote: string;
      url: string;
    }
  | { status: "BLOCKED" | "UNPARSED" | "UNREACHABLE"; note: string };

/**
 * Scrape the prose headline so the stored figure can be reconciled against an
 * independent statement of it.
 *
 * This is a corroboration step, not the primary source, so a bot challenge here
 * degrades the run to "unreconciled" rather than failing it.
 */
export async function fetchHeadlineTariff(): Promise<HeadlineResult> {
  let res: Response;
  try {
    res = await fetch(PAGE_URL, { headers: { "User-Agent": UA } });
  } catch (err) {
    return {
      status: "UNREACHABLE",
      note: err instanceof Error ? err.message : String(err),
    };
  }
  if (!res.ok) {
    return { status: "UNREACHABLE", note: `HTTP ${res.status}` };
  }

  const html = await res.text();

  if (isBotChallenge(html)) {
    return {
      status: "BLOCKED",
      note:
        "ema.gov.sg returned an Imperva bot-management challenge instead of the page (HTTP 200 with a ~1 KB shell). " +
        "The component CSV is unaffected, so the tariff itself is still verified — only this independent prose cross-check is unavailable.",
    };
  }

  // e.g. "For July to September 2026, the regulated tariff is 31.91 cents/kWh
  //       (before GST), or 34.78 cents/kWh (with GST)."
  const re =
    /For\s+([A-Z][a-z]+\s+to\s+[A-Z][a-z]+\s+\d{4}),?\s+the\s+regulated\s+tariff\s+is\s+([\d.]+)\s*cents\/kWh\s*\(before\s+GST\),?\s*or\s+([\d.]+)\s*cents\/kWh\s*\(with\s+GST\)/i;
  const m = html.replace(/&#34;/g, '"').match(re);
  if (!m) {
    return {
      status: "UNPARSED",
      note: `Fetched ${html.length} bytes but the headline sentence did not match the expected pattern.`,
    };
  }
  return {
    status: "OK",
    quarterLabel: m[1],
    centsExGst: Number(m[2]),
    centsIncGst: Number(m[3]),
    quote: m[0],
    url: PAGE_URL,
  };
}

export interface TariffSyncResult {
  quartersProbed: number;
  quartersStored: number;
  /** Quarters already present, so not re-fetched. */
  quartersSkipped: number;
  missing: string[];
  headline: Extract<HeadlineResult, { status: "OK" }> | null;
  headlineStatus: HeadlineResult["status"];
  headlineNote: string | null;
  reconciles: boolean | null;
  reconciliationDetail: string;
}


/**
 * Fetch and store the last `lookback` quarters.
 *
 * REQUEST DISCIPLINE
 * ------------------
 * ema.gov.sg is behind Imperva bot management. Probing all twelve quarters on
 * every run is what triggered a challenge during development, so two safeguards
 * are in place:
 *
 *   1. Quarters already stored are skipped. A published quarter's figures are
 *      final, so re-fetching them buys nothing. The first run fetches up to
 *      `lookback` files; later runs normally fetch one (the current quarter).
 *   2. A short delay is inserted between fetches that do happen.
 *
 * Some past quarters legitimately 404 (EMA did not publish every quarter under
 * this asset name); those are reported as `missing`, never interpolated.
 */
export async function syncRegulatedTariff(
  lookback = 12,
  opts: { force?: boolean } = {}
): Promise<TariffSyncResult> {
  const runId = await store.beginRun(EMA_TARIFF_SOURCE.id);
  const quarters = recentQuarters(lookback);
  const missing: string[] = [];
  const alreadyHave = new Set((await store.listTariffs()).map((t) => t.quarter));
  let stored = 0;
  let skipped = 0;

  try {
    for (const { year, q, label } of quarters) {
      // Published quarters are final; only re-fetch when explicitly forced.
      if (!opts.force && alreadyHave.has(label)) {
        skipped++;
        continue;
      }

      const url = `${CSV_BASE}q${q}-${year}.csv`;
      let res: Response;
      try {
        res = await fetch(url, { headers: { "User-Agent": UA } });
      } catch {
        missing.push(label);
        continue;
      }
      if (!res.ok) {
        missing.push(label);
        continue;
      }

      const body = await res.text();

      // A challenge here would be a 200 with an HTML shell, not a CSV. Fail
      // loudly rather than storing a parsed-from-nothing value.
      if (isBotChallenge(body)) {
        missing.push(`${label} (bot challenge)`);
        continue;
      }

      const parsed = parseTariffCsv(body);
      if (!parsed) {
        missing.push(label);
        continue;
      }
      const total = round(
        parsed.energy_c + parsed.network_c + parsed.mss_c + parsed.pso_c,
        4
      );
      await store.upsertTariff({
        quarter: label,
        year,
        q,
        energy_c: parsed.energy_c,
        network_c: parsed.network_c,
        mss_c: parsed.mss_c,
        pso_c: parsed.pso_c,
        total_c: total,
        source_id: EMA_TARIFF_SOURCE.id,
        source_url: url,
      });
      stored++;

      // Be a polite client: this host rate-limits aggressively.
      await new Promise((r) => setTimeout(r, 300));
    }

    const headlineResult = await fetchHeadlineTariff();
    const headline = headlineResult.status === "OK" ? headlineResult : null;
    const latest = await store.latestTariff();

    // Reconcile the newest stored component sum against EMA's own prose figure.
    // This is corroboration against an independent statement, so an unavailable
    // or blocked headline downgrades the result rather than failing the run.
    let reconciles: boolean | null = null;
    let detail: string;

    if (headline && latest) {
      const diff = Math.abs(latest.total_c - headline.centsExGst);
      reconciles = diff < 0.005;
      detail = reconciles
        ? `Component sum ${latest.total_c.toFixed(2)} c/kWh reconciles exactly with EMA's published ${headline.centsExGst.toFixed(2)} c/kWh (${headline.quarterLabel}).`
        : `MISMATCH: component sum ${latest.total_c.toFixed(2)} c/kWh vs EMA published ${headline.centsExGst.toFixed(2)} c/kWh.`;
    } else if (headlineResult.status === "BLOCKED") {
      detail = `Not independently reconciled: ${headlineResult.note}`;
    } else {
      detail = `Not independently reconciled (${headlineResult.status}). ${headlineResult.note}`;
    }

    const failed = reconciles === false;

    await store.finishRun(runId, {
      status: failed ? "FAILED" : stored ? "OK" : "EMPTY",
      httpStatus: 200,
      records: stored,
      error: failed ? detail : null,
      detail:
        `${stored} stored, ${skipped} already present, ${missing.length} unavailable. ${detail}`,
    });

    return {
      quartersProbed: quarters.length,
      quartersStored: stored,
      quartersSkipped: skipped,
      missing,
      headline,
      headlineStatus: headlineResult.status,
      headlineNote: headlineResult.status === "OK" ? null : headlineResult.note,
      reconciles,
      reconciliationDetail: detail,
    };
  } catch (err) {
    await store.finishRun(runId, {
      status: "FAILED",
      records: stored,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export async function storedTariffs() {
  return store.listTariffs();
}
