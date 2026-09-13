/**
 * API client + shared types for the Strike web client.
 *
 * Types mirror the server's response shapes. They are declared here rather than
 * generated so the client stays dependency-free, but every field maps to a real
 * server value.
 */

export interface SourceDescriptor {
  id: string;
  name: string;
  provides: string;
  unit: string | null;
  access: "open" | "scrape" | "auth_required" | "manual" | "broken";
  url: string;
  endpoint?: string;
  publisher: string;
  maxAgeHours: number;
  notes?: string;
  limitation?: string;
}

export interface SourceStatus extends SourceDescriptor {
  status: string;
  health: string;
  stored: Record<string, unknown>;
  last_run: {
    status: string;
    started_at: string;
    finished_at: string | null;
    records: number;
    error: string | null;
    detail: string | null;
    http_status: number | null;
  } | null;
  probe?: {
    ran: boolean;
    available: boolean;
    verdict: string;
    raw: unknown;
  } | null;
  active: boolean;
}

export interface Fact {
  label: string;
  value: string;
  detail?: string;
  source_url: string;
  verified: boolean;
}

export interface FactGroup {
  id: string;
  title: string;
  intro: string;
  facts: Fact[];
}

export interface MarketFactSheet {
  generated_at: string;
  disclaimer: string;
  groups: FactGroup[];
  regulatory_links: { label: string; url: string }[];
}

export interface Reason {
  text: string;
  evidence: string;
  direction: "lock" | "float" | "neutral";
}

export interface ScenarioCost {
  id: string;
  label: string;
  total_sgd: number;
  effective_c_kwh: number;
  delta_vs_tariff_sgd: number;
  delta_vs_tariff_pct: number;
  note: string;
}

export interface CostComparison {
  window: { from: string; to: string; days: number; mwh: number };
  usep: {
    avg: number;
    min: number;
    max: number;
    p10: number;
    p50: number;
    p90: number;
    volatility_pct: number;
  };
  non_energy: {
    network_c: number;
    mss_c: number;
    pso_c: number;
    total_c: number;
    quarter: string;
    source_url: string | null;
  };
  scenarios: ScenarioCost[];
  cheapest: string;
  fixed_offers: {
    retailer: string;
    plan: string;
    term_months: number | null;
    rate_c_kwh: number;
    observed_at: string;
  }[];
}

export interface StrikeSignal {
  verdict: "STRIKE_FIXED" | "FLOAT_WHOLESALE" | "HOLD_REGULATED" | "INSUFFICIENT_DATA";
  headline: string;
  confidence: "high" | "medium" | "low";
  score: number;
  reasons: Reason[];
  price_context: {
    latest_ts: string;
    latest_usep: number;
    percentile_in_window: number;
    window_p10: number;
    window_p50: number;
    window_p90: number;
    trend_7d_vs_30d_pct: number;
  } | null;
  forward_view: {
    horizon_hours: number;
    forecast_avg: number;
    recent_avg: number;
    direction: "rising" | "falling" | "flat";
    change_pct: number;
    backtest_mape_pct: number;
    backtest_skill_pct: number;
  } | null;
  annualised: {
    route: string;
    label: string;
    annual_sgd: number;
    effective_c_kwh: number;
    delta_vs_tariff_sgd: number;
  }[];
  tariff_c_kwh: number;
  tariff_quarter: string;
  comparison: CostComparison | null;
  peak_off_peak: {
    definition: string;
    peak_avg: number;
    peak_periods: number;
    offpeak_avg: number;
    offpeak_periods: number;
    spread: number;
    spread_pct: number;
  };
  forecast: {
    generated_at: string;
    horizon_hours: number;
    points: { ts: string; label: string; predicted: number; basis: number[] }[];
    method: string;
    backtest: {
      evaluated_periods: number;
      mae: number;
      mape_pct: number;
      baseline_mae: number;
      baseline_mape_pct: number;
      skill_pct: number;
      from: string;
      to: string;
      interpretation: string;
    };
  } | null;
}

export interface ShiftPlan {
  shifted_mwh: number;
  from_avg_price: number;
  to_avg_price: number;
  captured_spread: number;
  saving_sgd: number;
  shed_periods: number;
  absorb_periods: number;
  moves: {
    ts: string;
    shed_mwh: number;
    shed_price: number;
    absorb_ts: string;
    absorb_mwh: number;
    absorb_price: number;
  }[];
  constraints: {
    curtailable_mw: number;
    max_shed_per_period_mwh: number;
    window_days: number;
  };
  explanation: string;
}

export interface DrEstimate {
  eligible: boolean;
  eligibility_note: string;
  trigger: {
    source: "mapt" | "percentile";
    level: number;
    basis: string;
    periods_available: number;
  };
  events: {
    periods_above_trigger: number;
    trigger_rate_pct: number;
    periods_with_lcp: number;
    lcp_mean: number;
    lcp_max: number;
    event_days: number;
    annualised_events: number;
  };
  incentive: {
    rate_used: number;
    rate_source: string;
    capped: boolean;
    cap: number;
  };
  revenue: {
    mwh_per_event: number;
    curtailed_mwh_per_year: number;
    gross_annual_sgd: number;
    production_loss_sgd: number;
    net_annual_sgd: number;
    sgd_per_mw_year: number;
  };
  cliff: { floor_pct: number; note: string };
  upside: { annual_sgd: number; note: string };
  parameters: Record<string, unknown>;
  assumptions: string[];
  explanation: string;
}

export interface FairValueReference {
  energy_low_c: number;
  energy_reference_c: number;
  energy_high_c: number;
  anchor_spread_pct: number;
  all_in_reference_c: number;
  non_energy_c: number;
  inputs: {
    label: string;
    value_c: number;
    basis: string;
    source_url: string | null;
    observations: number;
  }[];
  market: {
    wholesale_all_in_c: number;
    regulated_all_in_c: number;
    wholesale_premium_c: number;
    wholesale_premium_pct: number;
    regulated_premium_c: number;
    regulated_premium_pct: number;
    wholesale_verdict: "below" | "at" | "above";
    regulated_verdict: "below" | "at" | "above";
  };
  corroboration: string;
  interpretation: string;
  caveats: string[];
}

export interface Dashboard {
  ready: boolean;
  reason?: string;
  generated_at?: string;
  window?: { days: number; from: string; to: string; periods: number };
  profile?: { name: string; annual_mwh: number; alpha: number; curtailable_mw: number };
  status: {
    count: number;
    first: string | null;
    last: string | null;
    age_hours: number | null;
    stale: boolean;
    span_days: number;
    emc_last_updated: string | null;
    last_run_status: string;
    last_run_detail: string | null;
    source: SourceDescriptor;
  };
  tariff: {
    quarter: string;
    total_c: number;
    energy_c: number | null;
    network_c: number | null;
    mss_c: number | null;
    pso_c: number | null;
    source_url: string | null;
    fetched_at: string;
  } | null;
  tariff_quarters?: {
    quarter: string;
    total_c: number;
    energy_c: number | null;
    network_c: number | null;
    mss_c: number | null;
    pso_c: number | null;
  }[];
  signal?: StrikeSignal;
  fair_value?: FairValueReference | null;
  load_diagnostics?: {
    window_days: number;
    window_mwh: number;
    peak_mw: number;
    min_mw: number;
    avg_mw: number;
    load_factor: number;
    peak_window_share: number;
    usable_periods: number;
    coverage: number;
  };
  shift?: ShiftPlan;
  dr?: DrEstimate | null;
  intraday?: { minute: number; label: string; mean_usep: number; samples: number }[];
  peak_off_peak?: {
    definition: string;
    peak_avg: number;
    peak_periods: number;
    offpeak_avg: number;
    offpeak_periods: number;
    spread: number;
    spread_pct: number;
  };
  daily?: { date: string; mean: number; min: number; max: number; samples: number }[];
  ancillary?: {
    ts: string;
    contingency: number | null;
    primary: number | null;
    regulation: number | null;
    mapt: number | null;
    lcp: number | null;
  }[];
  cheapest_windows?: { ts: string; label: string; price: number; vs_average_pct: number }[];
  offers?: Offer[];
  facts?: MarketFactSheet;
}

export interface Offer {
  id: number;
  retailer: string;
  plan: string;
  rate_c_kwh: number;
  term_months: number | null;
  notes: string | null;
  source_id: string;
  observed_at: string;
}

/**
 * Where the API lives.
 *
 * Empty by default, which means "same origin" — correct for the single-process
 * deployment where Fastify serves both the client and /api. Set VITE_API_BASE at
 * build time only for a split deployment, e.g. a static frontend on Vercel
 * calling an API on Render.
 */
const API_BASE: string = (import.meta.env?.VITE_API_BASE ?? "").replace(/\/+$/, "");

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const b = await res.json();
      if (b?.error) detail = b.error;
    } catch {
      /* keep the status text */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export const api = {
  dashboard: (p: { days: number; mwh: number; alpha: number; curtailable_mw: number }) =>
    json<Dashboard>(
      `/api/dashboard?days=${p.days}&mwh=${p.mwh}&alpha=${p.alpha}&curtailable_mw=${p.curtailable_mw}`
    ),
  sources: () =>
    json<{
      sources: SourceStatus[];
      facts: MarketFactSheet;
      generated_at: string;
      storage: {
        driver: "sqlite" | "postgres";
        target: string;
        detail: string;
        durable: boolean;
        warning: string | null;
      };
    }>(
      "/api/sources"
    ),
  tariff: () => json<{ quarters: unknown[]; latest: unknown }>("/api/tariff"),
  syncMarket: (body: { days?: number; from?: string; to?: string }) =>
    json<unknown>("/api/market/sync", { method: "POST", body: JSON.stringify(body) }),
  syncTariff: (lookback = 12) =>
    json<unknown>("/api/tariff/sync", {
      method: "POST",
      body: JSON.stringify({ lookback }),
    }),
  dr: (p: Record<string, number | string>) => {
    const qs = new URLSearchParams(
      Object.entries(p).map(([k, v]) => [k, String(v)])
    ).toString();
    return json<DrEstimate | { error: string }>(`/api/dr?${qs}`);
  },
  offers: () => json<{ offers: Offer[] }>("/api/offers"),
  addOffer: (o: {
    retailer: string;
    plan: string;
    rate_c_kwh: number;
    term_months: number | null;
    notes?: string;
  }) => json<{ offers: Offer[] }>("/api/offers", { method: "POST", body: JSON.stringify(o) }),
  deleteOffer: (id: number) =>
    json<{ offers: Offer[] }>(`/api/offers/${id}`, { method: "DELETE" }),
  saveProfile: (p: { annual_mwh: number; alpha: number; curtailable_mw: number }) =>
    json<unknown>("/api/profile", { method: "POST", body: JSON.stringify(p) }),
};
