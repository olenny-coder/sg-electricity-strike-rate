/**
 * Strike — persistence layer (node:sqlite, built into Node 22+/24).
 *
 * Design rule: every numeric value in this database carries provenance
 * (source_id, observed_at). Nothing is ever synthesised. Derived values name
 * the inputs they came from.
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

/**
 * Where the SQLite file lives.
 *
 * Overridable via STRIKE_DATA_DIR so a test can point at a throwaway directory.
 * That matters for the smoke test: the empty-state contract ("no data yet, and
 * say so honestly") can only be asserted against a database that is genuinely
 * empty, which is true on a fresh CI checkout but never true on a developer
 * machine that has already ingested. Without this the test would pass in CI and
 * fail locally, which is worse than no test.
 *
 * Only relevant to the SQLite driver; when DATABASE_URL is set this is unused.
 */
const DATA_DIR = path.resolve(process.env.STRIKE_DATA_DIR ?? path.join(process.cwd(), "data"));
fs.mkdirSync(DATA_DIR, { recursive: true });

export const DB_PATH = path.join(DATA_DIR, "strike.db");
export const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;
-- Ingestion runs concurrently (market feed + tariff feed). Without a busy
-- timeout a second writer fails outright with SQLITE_BUSY instead of waiting.
PRAGMA busy_timeout = 15000;

-- Provenance ledger: one row per ingestion attempt against one source.
CREATE TABLE IF NOT EXISTS source_run (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id    TEXT    NOT NULL,
  started_at   TEXT    NOT NULL,
  finished_at  TEXT,
  status       TEXT    NOT NULL,   -- OK | FAILED | AUTH_REQUIRED | EMPTY
  http_status  INTEGER,
  records      INTEGER DEFAULT 0,
  error        TEXT,
  detail       TEXT
);

-- Regulated tariff, one row per quarter, in cents/kWh EXCLUDING GST.
CREATE TABLE IF NOT EXISTS tariff_quarter (
  quarter      TEXT PRIMARY KEY,   -- e.g. '2026-Q3'
  year         INTEGER NOT NULL,
  q            INTEGER NOT NULL,
  energy_c     REAL,
  network_c    REAL,
  mss_c        REAL,
  pso_c        REAL,
  total_c      REAL NOT NULL,      -- sum of the four components
  source_id    TEXT NOT NULL,
  source_url   TEXT,
  fetched_at   TEXT NOT NULL
);

-- One row per half-hour trading period, straight from EMC's public NEMS feed.
-- All prices in SGD/MWh.
--
-- NOTE ON demand_mw: this is EMC's published "Demand (MW)" series, which is a
-- demand FORECAST. Per EMC's glossary it excludes transmission losses, intertie
-- flows and generation from exempted embedded generators, so it is definitionally
-- lower than metered system peak and must never be quoted as "the system demand
-- peak". It is used here only as a shape reference for modelling a buyer's load,
-- which is exactly what a forecast is good for.
CREATE TABLE IF NOT EXISTS market_period (
  ts                  TEXT PRIMARY KEY,  -- ISO8601 SGT (+08:00)
  usep                REAL,
  demand_mw           REAL,
  solar_mw            REAL,
  primary_reserve     REAL,
  contingency_reserve REAL,
  regulation          REAL,
  -- Temporary Price Cap fields. MAPT is the capped energy price; MAP is the
  -- market admin price. Both are published per period and are needed to derive
  -- the Demand Response trigger, which EMA sets at 1.5x the long-run marginal
  -- cost of a CCGT (and MAPT equals 3x LRMC, so the trigger is MAPT/2).
  map_price           REAL,
  mapt                REAL,
  -- Load Curtailment Price: the actual DR settlement price for the period.
  -- Non-zero only when curtailment was called.
  lcp                 REAL,
  tpc_applied         TEXT,
  source_last_updated TEXT,              -- EMC's own "Last Updated" stamp
  source_id           TEXT NOT NULL,
  observed_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mp_ts ON market_period(ts);

-- Fixed-price contract offers. Business rates are quoted privately, so these
-- are operator-entered and carry an explicit provenance + freshness stamp.
CREATE TABLE IF NOT EXISTS contract_offer (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  retailer     TEXT NOT NULL,
  plan         TEXT NOT NULL,
  rate_c_kwh   REAL NOT NULL,
  term_months  INTEGER,
  notes        TEXT,
  source_id    TEXT NOT NULL,      -- always 'operator_entered'
  observed_at  TEXT NOT NULL,
  UNIQUE(retailer, plan, term_months)
);

-- Saved buyer profiles so an energy manager can return to their own numbers.
CREATE TABLE IF NOT EXISTS load_profile (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  annual_mwh    REAL NOT NULL,
  load_factor    REAL NOT NULL DEFAULT 0.62,
  peak_share    REAL NOT NULL DEFAULT 0.18,  -- fraction of energy in 08:00-20:00
  curtailable_mw REAL NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL
);
`);

export const nowIso = () => new Date().toISOString();

/* ------------------------------------------------------------------ */
/* Migrations                                                          */
/* ------------------------------------------------------------------ */

/**
 * Additive column migrations.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table, so columns
 * added after a database has been created must be applied explicitly. Each
 * entry is idempotent: SQLite raises "duplicate column name" if the column is
 * already present, which is the signal to move on.
 */
function addColumnIfMissing(table: string, column: string, decl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as {
    name: string;
  }[];
  if (cols.some((c) => c.name === column)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  } catch (err) {
    // Only tolerate the duplicate-column race; anything else is a real problem.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(msg)) throw err;
  }
}

addColumnIfMissing("market_period", "map_price", "REAL");
addColumnIfMissing("market_period", "mapt", "REAL");
addColumnIfMissing("market_period", "lcp", "REAL");

/* ------------------------------------------------------------------ */
/* source_run                                                          */
/* ------------------------------------------------------------------ */

export interface RunHandle {
  id: number;
  finish(o: {
    status: "OK" | "FAILED" | "AUTH_REQUIRED" | "EMPTY";
    httpStatus?: number | null;
    records?: number;
    error?: string | null;
    detail?: string | null;
  }): void;
}

export function beginRun(sourceId: string): RunHandle {
  const info = db
    .prepare(`INSERT INTO source_run (source_id, started_at, status) VALUES (?,?,?)`)
    .run(sourceId, nowIso(), "FAILED");
  const id = Number(info.lastInsertRowid);
  return {
    id,
    finish(o) {
      db.prepare(
        `UPDATE source_run SET finished_at=?, status=?, http_status=?, records=?, error=?, detail=? WHERE id=?`
      ).run(
        nowIso(),
        o.status,
        o.httpStatus ?? null,
        o.records ?? 0,
        o.error ?? null,
        o.detail ?? null,
        id
      );
    },
  };
}

export function lastRun(sourceId: string) {
  return db
    .prepare(`SELECT * FROM source_run WHERE source_id=? ORDER BY id DESC LIMIT 1`)
    .get(sourceId) as any;
}

/* ------------------------------------------------------------------ */
/* tariff_quarter                                                      */
/* ------------------------------------------------------------------ */

export interface TariffRow {
  quarter: string;
  year: number;
  q: number;
  energy_c: number | null;
  network_c: number | null;
  mss_c: number | null;
  pso_c: number | null;
  total_c: number;
  source_id: string;
  source_url: string | null;
  fetched_at: string;
}

export function upsertTariff(
  r: Omit<TariffRow, "fetched_at"> & { fetched_at?: string }
) {
  db.prepare(
    `INSERT INTO tariff_quarter
       (quarter, year, q, energy_c, network_c, mss_c, pso_c, total_c, source_id, source_url, fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(quarter) DO UPDATE SET
       energy_c=excluded.energy_c, network_c=excluded.network_c,
       mss_c=excluded.mss_c, pso_c=excluded.pso_c, total_c=excluded.total_c,
       source_id=excluded.source_id, source_url=excluded.source_url,
       fetched_at=excluded.fetched_at`
  ).run(
    r.quarter,
    r.year,
    r.q,
    r.energy_c,
    r.network_c,
    r.mss_c,
    r.pso_c,
    r.total_c,
    r.source_id,
    r.source_url,
    r.fetched_at ?? nowIso()
  );
}

export function listTariffs(): TariffRow[] {
  return db
    .prepare(`SELECT * FROM tariff_quarter ORDER BY year, q`)
    .all() as unknown as TariffRow[];
}

export function latestTariff(): TariffRow | null {
  return (
    (db
      .prepare(`SELECT * FROM tariff_quarter ORDER BY year DESC, q DESC LIMIT 1`)
      .get() as unknown as TariffRow) ?? null
  );
}

/* ------------------------------------------------------------------ */
/* market_period                                                       */
/* ------------------------------------------------------------------ */

export interface MarketPeriod {
  ts: string;
  usep: number | null;
  demand_mw: number | null;
  solar_mw: number | null;
  primary_reserve: number | null;
  contingency_reserve: number | null;
  regulation: number | null;
  map_price: number | null;
  mapt: number | null;
  lcp: number | null;
  tpc_applied: string | null;
  source_last_updated: string | null;
  source_id: string;
  observed_at: string;
}

export function insertMarketPeriods(
  rows: Omit<MarketPeriod, "observed_at">[]
): number {
  const stmt = db.prepare(
    `INSERT INTO market_period
       (ts, usep, demand_mw, solar_mw, primary_reserve, contingency_reserve, regulation,
        map_price, mapt, lcp, tpc_applied, source_last_updated, source_id, observed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(ts) DO UPDATE SET
       usep=COALESCE(excluded.usep, market_period.usep),
       demand_mw=COALESCE(excluded.demand_mw, market_period.demand_mw),
       solar_mw=COALESCE(excluded.solar_mw, market_period.solar_mw),
       primary_reserve=COALESCE(excluded.primary_reserve, market_period.primary_reserve),
       contingency_reserve=COALESCE(excluded.contingency_reserve, market_period.contingency_reserve),
       regulation=COALESCE(excluded.regulation, market_period.regulation),
       map_price=COALESCE(excluded.map_price, market_period.map_price),
       mapt=COALESCE(excluded.mapt, market_period.mapt),
       lcp=COALESCE(excluded.lcp, market_period.lcp),
       tpc_applied=COALESCE(excluded.tpc_applied, market_period.tpc_applied),
       source_last_updated=COALESCE(excluded.source_last_updated, market_period.source_last_updated),
       source_id=excluded.source_id,
       observed_at=excluded.observed_at`
  );
  const at = nowIso();
  let n = 0;
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      stmt.run(
        r.ts,
        r.usep,
        r.demand_mw,
        r.solar_mw,
        r.primary_reserve,
        r.contingency_reserve,
        r.regulation,
        r.map_price,
        r.mapt,
        r.lcp,
        r.tpc_applied,
        r.source_last_updated,
        r.source_id,
        at
      );
      n++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return n;
}

/** Periods with a usable USEP, ascending. The basis for every wholesale calc. */
export function listMarketPeriods(fromIso: string, toIso: string) {
  return db
    .prepare(
      `SELECT ts, usep, demand_mw, solar_mw, primary_reserve, contingency_reserve, regulation,
              map_price, mapt, lcp, tpc_applied, source_last_updated, source_id, observed_at
         FROM market_period
        WHERE ts>=? AND ts<? AND usep IS NOT NULL
        ORDER BY ts`
    )
    .all(fromIso, toIso) as unknown as MarketPeriod[];
}

export function marketRange() {
  // EMC's "Last Updated" is a human string ("01 Sep 2026 11:31:31 PM"), so it
  // cannot be MAX()'d lexically. Take it from the newest stored period instead.
  return db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM market_period WHERE usep IS NOT NULL) n,
         (SELECT MIN(ts)   FROM market_period WHERE usep IS NOT NULL) lo,
         (SELECT MAX(ts)   FROM market_period WHERE usep IS NOT NULL) hi,
         (SELECT MAX(observed_at) FROM market_period) observed_at,
         (SELECT source_last_updated FROM market_period
            WHERE usep IS NOT NULL ORDER BY ts DESC LIMIT 1) src_hi`
    )
    .get() as unknown as {
    n: number;
    lo: string | null;
    hi: string | null;
    observed_at: string | null;
    src_hi: string | null;
  };
}

/* ------------------------------------------------------------------ */
/* contract_offer                                                      */
/* ------------------------------------------------------------------ */

export function upsertOffer(o: {
  retailer: string;
  plan: string;
  rate_c_kwh: number;
  term_months: number | null;
  notes?: string | null;
}) {
  db.prepare(
    `INSERT INTO contract_offer (retailer, plan, rate_c_kwh, term_months, notes, source_id, observed_at)
     VALUES (?,?,?,?,?,'operator_entered',?)
     ON CONFLICT(retailer, plan, term_months) DO UPDATE SET
       rate_c_kwh=excluded.rate_c_kwh, notes=excluded.notes, observed_at=excluded.observed_at`
  ).run(o.retailer, o.plan, o.rate_c_kwh, o.term_months, o.notes ?? null, nowIso());
}

export function listOffers() {
  return db
    .prepare(`SELECT * FROM contract_offer ORDER BY rate_c_kwh ASC`)
    .all() as unknown as {
    id: number;
    retailer: string;
    plan: string;
    rate_c_kwh: number;
    term_months: number | null;
    notes: string | null;
    source_id: string;
    observed_at: string;
  }[];
}

export function deleteOffer(id: number) {
  db.prepare(`DELETE FROM contract_offer WHERE id=?`).run(id);
}

/* ------------------------------------------------------------------ */
/* load_profile                                                        */
/* ------------------------------------------------------------------ */

export interface LoadProfile {
  id: number;
  name: string;
  annual_mwh: number;
  load_factor: number;
  peak_share: number;
  curtailable_mw: number;
  updated_at: string;
}

export function upsertProfile(p: {
  name: string;
  annual_mwh: number;
  load_factor: number;
  peak_share: number;
  curtailable_mw: number;
}) {
  db.prepare(
    `INSERT INTO load_profile (name, annual_mwh, load_factor, peak_share, curtailable_mw, updated_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(name) DO UPDATE SET
       annual_mwh=excluded.annual_mwh, load_factor=excluded.load_factor,
       peak_share=excluded.peak_share, curtailable_mw=excluded.curtailable_mw,
       updated_at=excluded.updated_at`
  ).run(
    p.name,
    p.annual_mwh,
    p.load_factor,
    p.peak_share,
    p.curtailable_mw,
    nowIso()
  );
}

export function getProfile(name: string): LoadProfile | null {
  return (
    (db.prepare(`SELECT * FROM load_profile WHERE name=?`).get(name) as
      | unknown
      | LoadProfile) ?? null
  );
}
