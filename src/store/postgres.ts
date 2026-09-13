/**
 * Postgres storage implementation, targeting Neon.
 *
 * WHY THIS EXISTS
 * ---------------
 * The local development store is SQLite (`node:sqlite`). That cannot be used in
 * production on the free tiers this app targets:
 *
 *   - Render's free web service has an ephemeral filesystem, so a SQLite file is
 *     destroyed on every redeploy, restart and idle spin-down.
 *   - Vercel functions have no persistent disk at all.
 *
 * So production runs against Neon Postgres. This module mirrors the SQLite
 * implementation function for function, using Postgres-native SQL.
 *
 * PORTABILITY NOTES
 * -----------------
 *  - `INSERT ... ON CONFLICT ... DO UPDATE SET` is identical in both engines.
 *  - Placeholders differ: SQLite uses `?`, Postgres uses `$1, $2, ...`.
 *  - `INTEGER PRIMARY KEY AUTOINCREMENT` becomes `GENERATED ALWAYS AS IDENTITY`.
 *  - `REAL` becomes `DOUBLE PRECISION`.
 *  - `PRAGMA` has no Postgres equivalent; the busy timeout and WAL settings are
 *    SQLite-only concerns and are simply absent here.
 *  - Timestamps are stored as TEXT in ISO8601 in both engines. ISO8601 UTC
 *    strings sort lexicographically, so range queries and ORDER BY behave
 *    identically without depending on either engine's date types.
 *  - The unique constraint on contract_offer uses an expression index over
 *    COALESCE(term_months, 0), because Postgres treats NULLs as distinct in a
 *    plain UNIQUE constraint and SQLite does the same. Without this, a plan with
 *    no fixed term could be inserted repeatedly.
 */
import pg from "pg";
import type {
  MarketPeriod,
  TariffRow,
  LoadProfile,
  RunFinish,
  OfferRow,
  SourceRunRow,
} from "./types.ts";

const { Pool } = pg;

/**
 * Build the pool.
 *
 * GOTCHA HANDLED HERE: node-postgres documents that if the connection string
 * contains `sslmode`, `sslcert`, `sslkey` or `sslrootcert`, it *replaces* any
 * `ssl` option you pass and your settings are silently lost. Neon's own
 * connection strings include `sslmode=require`, so passing `ssl` alongside the
 * string does nothing. We therefore strip the SSL-related query parameters out
 * of the string and configure TLS explicitly, which is the only way to be sure
 * which behaviour is in force.
 *
 * TLS is always required: Neon rejects non-TLS connections outright. Whether the
 * certificate chain is verified is controlled by the caller's `sslmode`:
 *   sslmode=verify-full  -> verify against the system CA store (Neon's default
 *                           recommendation, and their certs chain to a public CA)
 *   anything else        -> encrypt, but do not fail the handshake on a chain
 *                           the host's CA store may not know
 */
function makePool(connectionString: string): pg.Pool {
  let sslMode: string | null = null;
  let cleaned = connectionString;

  try {
    const u = new URL(connectionString);
    sslMode = u.searchParams.get("sslmode");
    for (const p of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) {
      u.searchParams.delete(p);
    }
    cleaned = u.toString();
  } catch {
    // Not a parseable URL; fall back to the raw string with TLS on.
  }

  const verify = sslMode === "verify-full" || sslMode === "verify-ca";

  return new Pool({
    connectionString: cleaned,
    max: Number(process.env.PG_POOL_MAX ?? 5),
    idleTimeoutMillis: 10_000,
    // Neon suspends compute after 5 minutes idle on the free plan, so the first
    // connection after a pause pays a resume cost. 10s covers it comfortably.
    connectionTimeoutMillis: 10_000,
    ssl: { rejectUnauthorized: verify },
  });
}

export class PostgresStore {
  private pool: pg.Pool;
  private ready: Promise<void> | null = null;

  /**
   * @param connectionString Neon connection string (pooled for the web server,
   *   direct for bulk backfills).
   * @param poolOverride Injection point used by the test suite, which runs this
   *   class against PGlite — real Postgres compiled to WASM — so the
   *   hand-written SQL is executed rather than merely compiled.
   */
  constructor(connectionString: string, poolOverride?: pg.Pool) {
    this.pool = poolOverride ?? makePool(connectionString);
  }

  /** Idempotent schema creation. Safe to call on every cold start. */
  async migrate(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        // Statements are executed one at a time rather than as a single
        // multi-statement string. node-postgres would accept the batch via the
        // simple query protocol, but drivers using the extended protocol (and
        // some poolers) reject multiple commands in one prepared statement.
        // Splitting costs nothing and removes the dependency on that detail.
        for (const stmt of `
          CREATE TABLE IF NOT EXISTS source_run (
            id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            source_id    TEXT NOT NULL,
            started_at   TEXT NOT NULL,
            finished_at  TEXT,
            status       TEXT NOT NULL,
            http_status  INTEGER,
            records      INTEGER DEFAULT 0,
            error        TEXT,
            detail       TEXT
          );

          CREATE TABLE IF NOT EXISTS tariff_quarter (
            quarter      TEXT PRIMARY KEY,
            year         INTEGER NOT NULL,
            q            INTEGER NOT NULL,
            energy_c     DOUBLE PRECISION,
            network_c    DOUBLE PRECISION,
            mss_c        DOUBLE PRECISION,
            pso_c        DOUBLE PRECISION,
            total_c      DOUBLE PRECISION NOT NULL,
            source_id    TEXT NOT NULL,
            source_url   TEXT,
            fetched_at   TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS market_period (
            ts                  TEXT PRIMARY KEY,
            usep                DOUBLE PRECISION,
            demand_mw           DOUBLE PRECISION,
            solar_mw            DOUBLE PRECISION,
            primary_reserve     DOUBLE PRECISION,
            contingency_reserve DOUBLE PRECISION,
            regulation          DOUBLE PRECISION,
            map_price           DOUBLE PRECISION,
            mapt                DOUBLE PRECISION,
            lcp                 DOUBLE PRECISION,
            tpc_applied         TEXT,
            source_last_updated TEXT,
            source_id           TEXT NOT NULL,
            observed_at         TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS contract_offer (
            id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            retailer     TEXT NOT NULL,
            plan         TEXT NOT NULL,
            rate_c_kwh   DOUBLE PRECISION NOT NULL,
            term_months  INTEGER,
            notes        TEXT,
            source_id    TEXT NOT NULL,
            observed_at  TEXT NOT NULL
          );

          CREATE UNIQUE INDEX IF NOT EXISTS contract_offer_identity
            ON contract_offer (retailer, plan, COALESCE(term_months, 0));

          CREATE TABLE IF NOT EXISTS load_profile (
            id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            name           TEXT NOT NULL UNIQUE,
            annual_mwh     DOUBLE PRECISION NOT NULL,
            load_factor    DOUBLE PRECISION NOT NULL DEFAULT 0.62,
            peak_share     DOUBLE PRECISION NOT NULL DEFAULT 0.18,
            curtailable_mw DOUBLE PRECISION NOT NULL DEFAULT 0,
            updated_at     TEXT NOT NULL
          );
        `
          .split(/;\s*\n/)
          .map((s) => s.trim())
          .filter(Boolean)) {
          await this.pool.query(stmt);
        }
      })();
    }
    return this.ready;
  }

  async close() {
    await this.pool.end();
  }

  /* ---------------- source_run ---------------- */

  async beginRun(sourceId: string): Promise<number> {
    await this.migrate();
    const r = await this.pool.query(
      `INSERT INTO source_run (source_id, started_at, status) VALUES ($1, $2, $3) RETURNING id`,
      [sourceId, new Date().toISOString(), "FAILED"]
    );
    return Number(r.rows[0].id);
  }

  async finishRun(id: number, o: RunFinish): Promise<void> {
    await this.pool.query(
      `UPDATE source_run SET finished_at=$1, status=$2, http_status=$3, records=$4, error=$5, detail=$6 WHERE id=$7`,
      [
        new Date().toISOString(),
        o.status,
        o.httpStatus ?? null,
        o.records ?? 0,
        o.error ?? null,
        o.detail ?? null,
        id,
      ]
    );
  }

  async lastRun(sourceId: string): Promise<SourceRunRow | null> {
    await this.migrate();
    const r = await this.pool.query(
      `SELECT * FROM source_run WHERE source_id=$1 ORDER BY id DESC LIMIT 1`,
      [sourceId]
    );
    return (r.rows[0] as SourceRunRow) ?? null;
  }

  /* ---------------- tariff_quarter ---------------- */

  async upsertTariff(r: Omit<TariffRow, "fetched_at"> & { fetched_at?: string }) {
    await this.migrate();
    await this.pool.query(
      `INSERT INTO tariff_quarter
         (quarter, year, q, energy_c, network_c, mss_c, pso_c, total_c, source_id, source_url, fetched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (quarter) DO UPDATE SET
         energy_c=EXCLUDED.energy_c, network_c=EXCLUDED.network_c,
         mss_c=EXCLUDED.mss_c, pso_c=EXCLUDED.pso_c, total_c=EXCLUDED.total_c,
         source_id=EXCLUDED.source_id, source_url=EXCLUDED.source_url,
         fetched_at=EXCLUDED.fetched_at`,
      [
        r.quarter, r.year, r.q, r.energy_c, r.network_c, r.mss_c, r.pso_c,
        r.total_c, r.source_id, r.source_url, r.fetched_at ?? new Date().toISOString(),
      ]
    );
  }

  async listTariffs(): Promise<TariffRow[]> {
    await this.migrate();
    const r = await this.pool.query(`SELECT * FROM tariff_quarter ORDER BY year, q`);
    return r.rows as TariffRow[];
  }

  async latestTariff(): Promise<TariffRow | null> {
    await this.migrate();
    const r = await this.pool.query(
      `SELECT * FROM tariff_quarter ORDER BY year DESC, q DESC LIMIT 1`
    );
    return (r.rows[0] as TariffRow) ?? null;
  }

  /* ---------------- market_period ---------------- */

  async insertMarketPeriods(rows: Omit<MarketPeriod, "observed_at">[]): Promise<number> {
    if (!rows.length) return 0;
    await this.migrate();
    const at = new Date().toISOString();

    // One multi-row statement per chunk. 14 columns per row; Postgres caps a
    // statement at 65535 bind parameters, so 1000 rows (14k params) is safe.
    const CHUNK = 1000;
    let written = 0;

    for (let start = 0; start < rows.length; start += CHUNK) {
      const slice = rows.slice(start, start + CHUNK);
      const values: unknown[] = [];
      const tuples: string[] = [];

      slice.forEach((r, i) => {
        const b = i * 14;
        tuples.push(
          `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${b + 13},$${b + 14})`
        );
        values.push(
          r.ts, r.usep, r.demand_mw, r.solar_mw, r.primary_reserve,
          r.contingency_reserve, r.regulation, r.map_price, r.mapt, r.lcp,
          r.tpc_applied, r.source_last_updated, r.source_id, at
        );
      });

      await this.pool.query(
        `INSERT INTO market_period
           (ts, usep, demand_mw, solar_mw, primary_reserve, contingency_reserve, regulation,
            map_price, mapt, lcp, tpc_applied, source_last_updated, source_id, observed_at)
         VALUES ${tuples.join(",")}
         ON CONFLICT (ts) DO UPDATE SET
           usep=COALESCE(EXCLUDED.usep, market_period.usep),
           demand_mw=COALESCE(EXCLUDED.demand_mw, market_period.demand_mw),
           solar_mw=COALESCE(EXCLUDED.solar_mw, market_period.solar_mw),
           primary_reserve=COALESCE(EXCLUDED.primary_reserve, market_period.primary_reserve),
           contingency_reserve=COALESCE(EXCLUDED.contingency_reserve, market_period.contingency_reserve),
           regulation=COALESCE(EXCLUDED.regulation, market_period.regulation),
           map_price=COALESCE(EXCLUDED.map_price, market_period.map_price),
           mapt=COALESCE(EXCLUDED.mapt, market_period.mapt),
           lcp=COALESCE(EXCLUDED.lcp, market_period.lcp),
           tpc_applied=COALESCE(EXCLUDED.tpc_applied, market_period.tpc_applied),
           source_last_updated=COALESCE(EXCLUDED.source_last_updated, market_period.source_last_updated),
           source_id=EXCLUDED.source_id,
           observed_at=EXCLUDED.observed_at`,
        values
      );
      written += slice.length;
    }
    return written;
  }

  async listMarketPeriods(fromIso: string, toIso: string): Promise<MarketPeriod[]> {
    await this.migrate();
    const r = await this.pool.query(
      `SELECT ts, usep, demand_mw, solar_mw, primary_reserve, contingency_reserve, regulation,
              map_price, mapt, lcp, tpc_applied, source_last_updated, source_id, observed_at
         FROM market_period
        WHERE ts >= $1 AND ts < $2 AND usep IS NOT NULL
        ORDER BY ts`,
      [fromIso, toIso]
    );
    return r.rows as MarketPeriod[];
  }

  async marketRange() {
    await this.migrate();
    const r = await this.pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM market_period WHERE usep IS NOT NULL) AS n,
         (SELECT MIN(ts)    FROM market_period WHERE usep IS NOT NULL) AS lo,
         (SELECT MAX(ts)    FROM market_period WHERE usep IS NOT NULL) AS hi,
         (SELECT MAX(observed_at) FROM market_period) AS observed_at,
         (SELECT source_last_updated FROM market_period
            WHERE usep IS NOT NULL ORDER BY ts DESC LIMIT 1) AS src_hi`
    );
    return r.rows[0] as {
      n: number;
      lo: string | null;
      hi: string | null;
      observed_at: string | null;
      src_hi: string | null;
    };
  }

  /* ---------------- contract_offer ---------------- */

  async upsertOffer(o: {
    retailer: string;
    plan: string;
    rate_c_kwh: number;
    term_months: number | null;
    notes?: string | null;
  }) {
    await this.migrate();
    const existing = await this.pool.query(
      `SELECT id FROM contract_offer WHERE retailer=$1 AND plan=$2 AND COALESCE(term_months,0)=COALESCE($3,0)`,
      [o.retailer, o.plan, o.term_months]
    );
    if (existing.rows.length) {
      await this.pool.query(
        `UPDATE contract_offer SET rate_c_kwh=$1, notes=$2, observed_at=$3 WHERE id=$4`,
        [o.rate_c_kwh, o.notes ?? null, new Date().toISOString(), existing.rows[0].id]
      );
      return;
    }
    await this.pool.query(
      `INSERT INTO contract_offer (retailer, plan, rate_c_kwh, term_months, notes, source_id, observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        o.retailer, o.plan, o.rate_c_kwh, o.term_months,
        o.notes ?? null, "operator_entered", new Date().toISOString(),
      ]
    );
  }

  async listOffers(): Promise<OfferRow[]> {
    await this.migrate();
    const r = await this.pool.query(`SELECT * FROM contract_offer ORDER BY rate_c_kwh ASC`);
    return r.rows as OfferRow[];
  }

  async deleteOffer(id: number) {
    await this.migrate();
    await this.pool.query(`DELETE FROM contract_offer WHERE id=$1`, [id]);
  }

  /* ---------------- load_profile ---------------- */

  async upsertProfile(p: {
    name: string;
    annual_mwh: number;
    load_factor: number;
    peak_share: number;
    curtailable_mw: number;
  }) {
    await this.migrate();
    await this.pool.query(
      `INSERT INTO load_profile (name, annual_mwh, load_factor, peak_share, curtailable_mw, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (name) DO UPDATE SET
         annual_mwh=EXCLUDED.annual_mwh, load_factor=EXCLUDED.load_factor,
         peak_share=EXCLUDED.peak_share, curtailable_mw=EXCLUDED.curtailable_mw,
         updated_at=EXCLUDED.updated_at`,
      [p.name, p.annual_mwh, p.load_factor, p.peak_share, p.curtailable_mw, new Date().toISOString()]
    );
  }

  async getProfile(name: string): Promise<LoadProfile | null> {
    await this.migrate();
    const r = await this.pool.query(`SELECT * FROM load_profile WHERE name=$1`, [name]);
    return (r.rows[0] as LoadProfile) ?? null;
  }
}
