/**
 * Storage facade.
 *
 * Picks a driver at startup:
 *
 *   DATABASE_URL set  -> Postgres (Neon in production)
 *   DATABASE_URL unset -> SQLite via node:sqlite (zero-config local development)
 *
 * The SQLite path is the default so `npm start` works on a clean checkout with
 * no database to provision. Postgres is what production runs on, because the
 * free hosting tiers this app targets either have no persistent disk (Vercel
 * functions) or an ephemeral one (Render free web services).
 *
 * Every method is async, so callers do not care which driver is live.
 */
import type {
  Store,
  TariffRow,
  MarketPeriod,
  OfferRow,
  LoadProfile,
  SourceRunRow,
  RunFinish,
  MarketRange,
  DriverKind,
} from "./types.ts";

import {
  beginRun as sqliteBeginRun,
  upsertTariff as sqliteUpsertTariff,
  listTariffs as sqliteListTariffs,
  latestTariff as sqliteLatestTariff,
  insertMarketPeriods as sqliteInsertMarketPeriods,
  listMarketPeriods as sqliteListMarketPeriods,
  marketRange as sqliteMarketRange,
  upsertOffer as sqliteUpsertOffer,
  listOffers as sqliteListOffers,
  deleteOffer as sqliteDeleteOffer,
  upsertProfile as sqliteUpsertProfile,
  getProfile as sqliteGetProfile,
  lastRun as sqliteLastRun,
  db as sqliteHandle,
  DB_PATH,
} from "../db.ts";

import { PostgresStore } from "./postgres.ts";

const DATABASE_URL = process.env.DATABASE_URL?.trim();

export const DRIVER: DriverKind = DATABASE_URL ? "postgres" : "sqlite";

/* ------------------------------------------------------------------ */
/* SQLite driver                                                       */
/* ------------------------------------------------------------------ */

/**
 * `run.finish()` is a closure over an open handle, so the id alone is not
 * enough to complete a run. Keep the handles in-process, keyed by id.
 */
const openRuns = new Map<number, { finish: (o: RunFinish) => void }>();

const sqliteStore: Store = {
  async migrate() {
    // The schema is created when src/db.ts is imported, and additive column
    // migrations run there too. Nothing further is required.
  },

  async beginRun(sourceId) {
    const h = sqliteBeginRun(sourceId);
    openRuns.set(h.id, h);
    return h.id;
  },

  async finishRun(id, o) {
    const h = openRuns.get(id);
    if (h) {
      h.finish(o);
      openRuns.delete(id);
    }
  },

  async lastRun(sourceId) {
    return (sqliteLastRun(sourceId) as SourceRunRow) ?? null;
  },

  async upsertTariff(r) {
    sqliteUpsertTariff(r);
  },
  async listTariffs() {
    return sqliteListTariffs() as TariffRow[];
  },
  async latestTariff() {
    return (sqliteLatestTariff() as TariffRow) ?? null;
  },

  async insertMarketPeriods(rows) {
    return sqliteInsertMarketPeriods(rows);
  },
  async listMarketPeriods(fromIso, toIso) {
    return sqliteListMarketPeriods(fromIso, toIso) as MarketPeriod[];
  },
  async marketRange() {
    const r = sqliteMarketRange();
    return { n: r.n, lo: r.lo, hi: r.hi, observed_at: r.observed_at, src_hi: r.src_hi } as MarketRange;
  },

  async upsertOffer(o) {
    sqliteUpsertOffer(o);
  },
  async listOffers() {
    return sqliteListOffers() as OfferRow[];
  },
  async deleteOffer(id) {
    sqliteDeleteOffer(id);
  },

  async upsertProfile(p) {
    sqliteUpsertProfile(p);
  },
  async getProfile(name) {
    return (sqliteGetProfile(name) as LoadProfile) ?? null;
  },
};

/* ------------------------------------------------------------------ */
/* Selection                                                           */
/* ------------------------------------------------------------------ */

let store: Store;
let pgStore: PostgresStore | null = null;

if (DATABASE_URL) {
  pgStore = new PostgresStore(DATABASE_URL);
  store = pgStore as unknown as Store;
} else {
  store = sqliteStore;
}

export { store };

/** Human-readable description of where data is being persisted. */
export function storageDescription(): {
  driver: DriverKind;
  target: string;
  detail: string;
} {
  if (DRIVER === "postgres") {
    // Never echo credentials — reduce the URL to its host.
    let host = "postgres";
    try {
      host = new URL(DATABASE_URL as string).host;
    } catch {
      /* malformed URL; keep the generic label */
    }
    return {
      driver: "postgres",
      target: host,
      detail:
        "Neon Postgres. Required in production: serverless functions have no persistent disk and Render's free web service filesystem is ephemeral.",
    };
  }
  return {
    driver: "sqlite",
    target: DB_PATH,
    detail:
      "Local SQLite file. Fine for development; not durable on any free hosting tier, so production sets DATABASE_URL.",
  };
}

/** Close the pool on shutdown so the process can exit cleanly. */
export async function closeStore(): Promise<void> {
  if (pgStore) await pgStore.close();
}

export type {
  Store,
  TariffRow,
  MarketPeriod,
  OfferRow,
  LoadProfile,
  SourceRunRow,
  RunFinish,
  MarketRange,
  DriverKind,
};
