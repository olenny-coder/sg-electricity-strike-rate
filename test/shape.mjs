/**
 * Contract test: asserts the API returns every field the web client reads.
 *
 * This exists because the client is typed against hand-written interfaces, and a
 * server-side rename would otherwise only surface as a blank panel in a browser.
 * Run against a live server:  node test/shape.mjs [baseUrl]
 */
const base = process.argv[2] ?? "http://127.0.0.1:8791";

let fails = 0;
let checks = 0;

function has(obj, path, label) {
  checks++;
  const v = path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
  if (v === undefined || v === null) {
    console.log(`  MISSING  ${label}: ${path}`);
    fails++;
    return false;
  }
  return true;
}

const get = async (p) => {
  const res = await fetch(base + p);
  if (!res.ok) throw new Error(`${p} -> HTTP ${res.status}`);
  return res.json();
};

console.log("=== dashboard ===");
const d = await get("/api/dashboard?days=90&mwh=4000&alpha=1.4&curtailable_mw=1");
[
  "ready", "window.periods", "status.count", "status.span_days", "status.stale",
  "status.emc_last_updated", "tariff.quarter", "tariff.total_c",
  "signal.verdict", "signal.score", "signal.headline", "signal.confidence",
  "signal.reasons", "signal.price_context.latest_usep",
  "signal.price_context.percentile_in_window", "signal.forward_view.direction",
  "signal.annualised", "signal.comparison.usep.avg",
  "signal.comparison.non_energy.total_c", "signal.comparison.scenarios",
  "signal.comparison.cheapest", "signal.forecast.points", "signal.forecast.method",
  "signal.forecast.backtest.interpretation", "signal.forecast.backtest.mape_pct",
  "signal.forecast.backtest.skill_pct", "peak_off_peak.spread_pct",
  "peak_off_peak.definition", "load_diagnostics.load_factor",
  "load_diagnostics.coverage", "shift.saving_sgd", "shift.captured_spread",
  "shift.moves", "shift.constraints.window_days", "intraday", "daily",
  "ancillary", "cheapest_windows", "offers", "facts.groups",
].forEach((p) => has(d, p, "dashboard"));

console.log("=== demand response ===");
const dr = await get("/api/dr?days=180&curtailable_mw=2");
[
  "eligible", "eligibility_note", "trigger.level", "trigger.basis", "trigger.source",
  "events.periods_with_lcp", "events.event_days", "events.lcp_mean", "events.lcp_max",
  "events.periods_above_trigger", "events.trigger_rate_pct", "events.annualised_events",
  "incentive.rate_used", "incentive.rate_source", "incentive.capped", "incentive.cap",
  "revenue.net_annual_sgd", "revenue.sgd_per_mw_year", "revenue.mwh_per_event",
  "cliff.note", "upside.annual_sgd", "upside.note", "assumptions", "explanation",
].forEach((p) => has(dr, p, "dr"));

console.log("=== sources ===");
const s = await get("/api/sources");
has(s, "sources", "sources");
has(s, "facts.groups", "sources");
for (const k of ["id", "name", "provides", "access", "url", "publisher", "status", "health", "stored", "active"]) {
  checks++;
  if (s.sources?.[0]?.[k] === undefined) {
    console.log(`  MISSING source field: ${k}`);
    fails++;
  }
}

console.log("=== offers ===");
const o = await get("/api/offers");
has(o, "offers", "offers");
console.log(`  loaded offers: ${o.offers.length}`);

console.log(
  fails === 0
    ? `\nALL ${checks} SHAPE CHECKS PASSED`
    : `\n${fails} of ${checks} SHAPE CHECK(S) FAILED`
);
process.exit(fails === 0 ? 0 : 1);
