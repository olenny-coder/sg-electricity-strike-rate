/**
 * Postgres storage-layer test.
 *
 * WHY THIS EXISTS
 * ---------------
 * The production store is Postgres (Neon), but the local development store is
 * SQLite. That means the Postgres SQL is the one part of the codebase with no
 * test coverage by simply running the app — a typo there would only surface on
 * the first production deploy.
 *
 * This runs the real `PostgresStore` against PGlite, which is Postgres compiled
 * to WebAssembly. That is genuine Postgres parsing and execution, not a mock, so
 * the DDL and DML are actually validated.
 *
 * WHAT IT DOES NOT COVER
 * ----------------------
 * Network concerns: connection pooling, TLS negotiation and Neon's PgBouncer
 * behaviour. Those depend on the driver and the host, not on the SQL, and cannot
 * be exercised without a live Neon endpoint.
 *
 *   node test/postgres.mjs
 */
import { PGlite } from "@electric-sql/pglite";

const pg = new PGlite();

// Inject PGlite in place of a node-postgres Pool. Both expose
// query(text, values) -> { rows }, which is all PostgresStore uses.
const { PostgresStore } = await import("../src/store/postgres.ts");
const store = new PostgresStore("postgresql://unused", pg);

let failures = 0;
const check = (label, cond, extra = "") => {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ""}`);
    failures++;
  }
};

console.log("=== schema (CREATE TABLE / identity columns / expression index) ===");
await store.migrate();

const tables = await pg.query(
  `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`
);
const names = tables.rows.map((r) => r.tablename);
for (const t of ["source_run", "tariff_quarter", "market_period", "contract_offer", "load_profile"]) {
  check(`table ${t} exists`, names.includes(t), `found: ${names.join(", ")}`);
}

// Idempotency matters: migrate() runs on every cold start.
await store.migrate();
check("migrate() is idempotent", true);

const idx = await pg.query(
  `SELECT indexname FROM pg_indexes WHERE tablename='contract_offer'`
);
check(
  "contract_offer expression index created",
  idx.rows.some((r) => r.indexname === "contract_offer_identity"),
  JSON.stringify(idx.rows)
);

console.log("\n=== tariff_quarter: upsert and read back ===");
await store.upsertTariff({
  quarter: "2026-Q3",
  year: 2026,
  q: 3,
  energy_c: 25.5,
  network_c: 6.1,
  mss_c: 0.23,
  pso_c: 0.08,
  total_c: 31.91,
  source_id: "ema_regulated_tariff",
  source_url: "https://example.test/q3.csv",
});
let t = await store.latestTariff();
check("latestTariff returns the row", t?.quarter === "2026-Q3");
check("components round-trip exactly", t?.total_c === 31.91, String(t?.total_c));

// The upsert must UPDATE rather than duplicate.
await store.upsertTariff({
  quarter: "2026-Q3",
  year: 2026,
  q: 3,
  energy_c: 25.5,
  network_c: 6.1,
  mss_c: 0.23,
  pso_c: 0.08,
  total_c: 31.91,
  source_id: "ema_regulated_tariff",
  source_url: "https://example.test/q3.csv",
});
const all = await store.listTariffs();
check("ON CONFLICT DO UPDATE did not duplicate", all.length === 1, `rows=${all.length}`);

console.log("\n=== market_period: multi-row insert, then upsert-merge ===");
const mk = (i, over = {}) => ({
  ts: `2026-09-01T${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}:00+08:00`,
  usep: 200 + i,
  demand_mw: 6800 + i,
  solar_mw: 0,
  primary_reserve: 35 + i,
  contingency_reserve: 47 + i,
  regulation: 9,
  map_price: 267,
  mapt: 692.63,
  lcp: 0,
  tpc_applied: "No",
  source_last_updated: "01 Sep 2026 11:31:31 PM",
  source_id: "emc_nems_rt48",
  ...over,
});

const batch = Array.from({ length: 48 }, (_, i) => mk(i));
const written = await store.insertMarketPeriods(batch);
check("multi-row insert wrote 48 rows", written === 48, `wrote=${written}`);

const range = await store.marketRange();
check("marketRange counts rows", range.n === 48, `n=${range.n}`);
check("marketRange reports newest ts", range.hi?.includes("2026-09-01"), String(range.hi));
check(
  "marketRange picks publisher stamp from newest row",
  range.src_hi === "01 Sep 2026 11:31:31 PM",
  String(range.src_hi)
);

// Re-insert the same period with only USEP changed. The COALESCE in the
// upsert must keep the previously known ancillary values rather than null them.
await store.insertMarketPeriods([mk(0, { usep: 999, contingency_reserve: null })]);
const after = await store.listMarketPeriods(
  "2026-09-01T00:00:00+08:00",
  "2026-09-02T00:00:00+08:00"
);
const first = after.find((r) => r.ts === "2026-09-01T00:00:00+08:00");
check("upsert updated USEP", first?.usep === 999, String(first?.usep));
check(
  "upsert preserved unrelated column (COALESCE kept contingency_reserve)",
  first?.contingency_reserve === 47,
  String(first?.contingency_reserve)
);
check("no duplicate rows after re-upsert", after.length === 48, `rows=${after.length}`);

console.log("\n=== market_period: window bounds are an exact string comparison ===");
// Bounds are emitted in the stored format (+08:00), so lexicographic
// comparison in SQL is a correct time comparison.
const win = await store.listMarketPeriods(
  "2026-09-01T05:00:00+08:00",
  "2026-09-01T06:00:00+08:00"
);
check("half-open window returns exactly 2 periods", win.length === 2, `rows=${win.length}`);
check(
  "window starts at the lower bound",
  win[0]?.ts === "2026-09-01T05:00:00+08:00",
  String(win[0]?.ts)
);

console.log("\n=== contract_offer: NULL term uniqueness (the COALESCE index) ===");
await store.upsertOffer({
  retailer: "Tuas Power",
  plan: "PowerPAK 24",
  rate_c_kwh: 26.9,
  term_months: 24,
  notes: "test",
});
await store.upsertOffer({
  retailer: "Tuas Power",
  plan: "PowerPAK 24",
  rate_c_kwh: 25.5,
  term_months: 24,
  notes: "updated",
});
let offers = await store.listOffers();
check("upsert updated rather than duplicated", offers.length === 1, `rows=${offers.length}`);
check("rate was updated", offers[0]?.rate_c_kwh === 25.5, String(offers[0]?.rate_c_kwh));

// A NULL term must still be unique. A plain UNIQUE constraint in Postgres would
// treat every NULL as distinct and allow unlimited duplicates.
await store.upsertOffer({
  retailer: "PacificLight",
  plan: "Custom",
  rate_c_kwh: 27,
  term_months: null,
});
await store.upsertOffer({
  retailer: "PacificLight",
  plan: "Custom",
  rate_c_kwh: 26,
  term_months: null,
});
offers = await store.listOffers();
const pl = offers.filter((o) => o.retailer === "PacificLight");
check("NULL term_months did not duplicate", pl.length === 1, `rows=${pl.length}`);
check("NULL-term row was updated", pl[0]?.rate_c_kwh === 26, String(pl[0]?.rate_c_kwh));

await store.deleteOffer(pl[0].id);
offers = await store.listOffers();
check("deleteOffer removed the row", offers.length === 1, `rows=${offers.length}`);

console.log("\n=== source_run: begin / finish / lastRun ===");
const runId = await store.beginRun("emc_nems_rt48");
check("beginRun returns an identity id", Number.isInteger(runId) && runId > 0, String(runId));
await store.finishRun(runId, {
  status: "OK",
  httpStatus: 200,
  records: 48,
  detail: "test run",
});
const last = await store.lastRun("emc_nems_rt48");
check("lastRun returns the finished run", last?.status === "OK", String(last?.status));
check("lastRun persisted the record count", last?.records === 48, String(last?.records));

console.log("\n=== load_profile: upsert on a named unique key ===");
await store.upsertProfile({
  name: "default",
  annual_mwh: 4000,
  load_factor: 1.4,
  peak_share: 0,
  curtailable_mw: 1,
});
await store.upsertProfile({
  name: "default",
  annual_mwh: 8000,
  load_factor: 1.8,
  peak_share: 0,
  curtailable_mw: 2.5,
});
const prof = await store.getProfile("default");
check("profile upserted, not duplicated", prof?.annual_mwh === 8000, String(prof?.annual_mwh));
check("profile curtailable_mw updated", prof?.curtailable_mw === 2.5, String(prof?.curtailable_mw));

await pg.close();

console.log(
  failures === 0
    ? "\nALL POSTGRES STORAGE CHECKS PASSED"
    : `\n${failures} POSTGRES STORAGE CHECK(S) FAILED`
);
process.exit(failures === 0 ? 0 : 1);
