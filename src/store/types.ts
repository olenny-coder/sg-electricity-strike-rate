/** Row and result shapes shared by both storage drivers. */

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

export interface OfferRow {
  id: number;
  retailer: string;
  plan: string;
  rate_c_kwh: number;
  term_months: number | null;
  notes: string | null;
  source_id: string;
  observed_at: string;
}

export interface LoadProfile {
  id: number;
  name: string;
  annual_mwh: number;
  load_factor: number;
  peak_share: number;
  curtailable_mw: number;
  updated_at: string;
}

export interface SourceRunRow {
  id: number;
  source_id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  http_status: number | null;
  records: number;
  error: string | null;
  detail: string | null;
}

export type RunStatus = "OK" | "FAILED" | "AUTH_REQUIRED" | "EMPTY";

export interface RunFinish {
  status: RunStatus;
  httpStatus?: number | null;
  records?: number;
  error?: string | null;
  detail?: string | null;
}

export interface MarketRange {
  n: number;
  lo: string | null;
  hi: string | null;
  observed_at: string | null;
  src_hi: string | null;
}

/**
 * The storage contract. Every method is async so the SQLite and Postgres
 * drivers are interchangeable at the call site.
 */
export interface Store {
  migrate(): Promise<void>;

  beginRun(sourceId: string): Promise<number>;
  finishRun(id: number, o: RunFinish): Promise<void>;
  lastRun(sourceId: string): Promise<SourceRunRow | null>;

  upsertTariff(
    r: Omit<TariffRow, "fetched_at"> & { fetched_at?: string }
  ): Promise<void>;
  listTariffs(): Promise<TariffRow[]>;
  latestTariff(): Promise<TariffRow | null>;

  insertMarketPeriods(rows: Omit<MarketPeriod, "observed_at">[]): Promise<number>;
  listMarketPeriods(fromIso: string, toIso: string): Promise<MarketPeriod[]>;
  marketRange(): Promise<MarketRange>;

  upsertOffer(o: {
    retailer: string;
    plan: string;
    rate_c_kwh: number;
    term_months: number | null;
    notes?: string | null;
  }): Promise<void>;
  listOffers(): Promise<OfferRow[]>;
  deleteOffer(id: number): Promise<void>;

  upsertProfile(p: {
    name: string;
    annual_mwh: number;
    load_factor: number;
    peak_share: number;
    curtailable_mw: number;
  }): Promise<void>;
  getProfile(name: string): Promise<LoadProfile | null>;
}

/** Which driver is active, for display in the Data sources panel. */
export type DriverKind = "sqlite" | "postgres";
