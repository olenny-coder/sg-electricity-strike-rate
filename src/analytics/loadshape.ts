/**
 * Load shaping and three-way cost comparison.
 *
 * WHAT IS REAL AND WHAT IS MODELLED — read this before quoting any figure.
 *
 * REAL (from EMC's NEMS feed):
 *   - every half-hourly USEP, in SGD/MWh
 *   - every half-hourly national demand forecast, in MW
 *   - every half-hourly ancillary reserve price
 *
 * REAL (from EMA):
 *   - the regulated tariff and each of its four cost components, per quarter
 *
 * MODELLED (explicitly, and only here):
 *   - the buyer's own half-hourly consumption shape.
 *
 * The model anchors the buyer's load to the REAL shape of national demand
 * forecast: L(t) = k · D(t)^alpha, scaled so the window total equals the buyer's
 * stated consumption. `alpha` is a single interpretable knob:
 *
 *   alpha = 1.0  your load follows the national profile exactly
 *   alpha = 1.5  you are peakier than average (typical for cold chain / retail)
 *   alpha = 2.5  strongly peaky (office hours only, single-shift manufacturing)
 *   alpha = 0    perfectly flat (24/7 data centre with no cooling swing)
 *
 * Caveat on the anchor: EMC's published demand series is a forecast that
 * excludes transmission losses, intertie flows and exempted embedded
 * generation. Its level is therefore not system peak and is not treated as
 * such anywhere in this application — only its shape is used, and shape is what
 * a forecast is genuinely good for.
 *
 * Because the national shape is real, the timing of peaks and troughs is real;
 * only the amplitude of the buyer's response to that shape is assumed. The
 * model's derived load factor and peak-window share are shown back to the user
 * so they can sanity-check `alpha` against their own bills, and a raw
 * half-hourly import overrides the model entirely.
 */
import type { MarketPeriod } from "../db.ts";
import { mean, round, sgtDate, isPeakWindow, sgtMinutes } from "./time.ts";

export interface BuyerProfile {
  /** Display name for the profile. */
  name: string;
  /** Total metered consumption over a year, MWh. */
  annual_mwh: number;
  /** Load-shape exponent. 1.0 follows national demand; higher is peakier. */
  alpha: number;
  /** Firm load the site can curtail for demand response, MW. */
  curtailable_mw: number;
}

export const DEFAULT_PROFILE: BuyerProfile = {
  name: "default",
  annual_mwh: 4_000,
  alpha: 1.4,
  curtailable_mw: 1.0,
};

export interface ShapedPeriod extends MarketPeriod {
  /** Modelled consumption in MWh for this half hour. */
  mwh: number;
  /** Modelled load in MW, for convenience. */
  mw: number;
}

export interface ShapeDiagnostics {
  window_days: number;
  window_mwh: number;
  peak_mw: number;
  min_mw: number;
  avg_mw: number;
  load_factor: number;
  peak_window_share: number;
  /** Half-hour periods that had both USEP and demand available. */
  usable_periods: number;
  /** Fraction of the calendar window actually covered by stored data. */
  coverage: number;
}

export interface ShapedLoad {
  periods: ShapedPeriod[];
  diagnostics: ShapeDiagnostics;
}

/**
 * Build the buyer's half-hourly consumption across the supplied market window.
 *
 * Periods missing either USEP or demand are dropped rather than interpolated,
 * and `coverage` reports how much of the window survived, so a thin dataset
 * cannot masquerade as a full-cost answer.
 */
export function shapeLoad(
  periods: MarketPeriod[],
  profile: BuyerProfile
): ShapedLoad {
  const usable = periods.filter(
    (p) =>
      p.usep !== null &&
      Number.isFinite(p.usep) &&
      p.demand_mw !== null &&
      Number.isFinite(p.demand_mw) &&
      p.demand_mw > 0
  );

  if (!usable.length) {
    return {
      periods: [],
      diagnostics: {
        window_days: 0,
        window_mwh: 0,
        peak_mw: 0,
        min_mw: 0,
        avg_mw: 0,
        load_factor: 0,
        peak_window_share: 0,
        usable_periods: 0,
        coverage: 0,
      },
    };
  }

  // Distinct SGT calendar dates, for an honest coverage denominator.
  const days = new Set(usable.map((p) => sgtDate(p.ts)));
  const expected = days.size * 48;
  const coverage = expected ? usable.length / expected : 0;

  const windowDays = days.size;
  const windowMwh = (profile.annual_mwh * windowDays) / 365;

  // L(t) = k * D(t)^alpha, with k solved so the window total matches.
  const alpha = profile.alpha;
  const weights = usable.map((p) =>
    alpha === 0 ? 1 : Math.pow(p.demand_mw as number, alpha)
  );
  const weightSum = weights.reduce((a, b) => a + b, 0);
  // Half-hour periods are 0.5 h, so MW * 0.5 = MWh per period.
  const k = weightSum > 0 ? windowMwh / (weightSum * 0.5) : 0;

  const shaped: ShapedPeriod[] = usable.map((p, i) => {
    const mw = k * weights[i];
    return { ...p, mw, mwh: mw * 0.5 };
  });

  const mws = shaped.map((s) => s.mw);
  const peakMw = Math.max(...mws);
  const minMw = Math.min(...mws);
  const avgMw = mean(mws);
  const total = shaped.reduce((a, s) => a + s.mwh, 0);
  const peakMwh = shaped
    .filter((s) => isPeakWindow(s.ts))
    .reduce((a, s) => a + s.mwh, 0);

  return {
    periods: shaped,
    diagnostics: {
      window_days: windowDays,
      window_mwh: round(total, 1),
      peak_mw: round(peakMw, 2),
      min_mw: round(minMw, 2),
      avg_mw: round(avgMw, 2),
      load_factor: peakMw > 0 ? round(avgMw / peakMw, 3) : 0,
      peak_window_share: total > 0 ? round(peakMwh / total, 3) : 0,
      usable_periods: shaped.length,
      coverage: round(coverage, 3),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Cost comparison                                                     */
/* ------------------------------------------------------------------ */

export interface NonEnergyComponents {
  /** cents/kWh, ex-GST */
  network_c: number;
  mss_c: number;
  pso_c: number;
  total_c: number;
  quarter: string;
  source_url: string | null;
}

export interface ScenarioCost {
  id: string;
  label: string;
  /** Total SGD over the window. */
  total_sgd: number;
  /** Effective all-in price, cents/kWh. */
  effective_c_kwh: number;
  /** Versus the regulated tariff, in SGD (negative = cheaper than tariff). */
  delta_vs_tariff_sgd: number;
  /** Versus the regulated tariff, in percent. */
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
  non_energy: NonEnergyComponents;
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

/**
 * Cost the same real half-hourly load under each procurement route.
 *
 *  - Regulated tariff: one all-inclusive cents/kWh rate (energy + network +
 *    MSS + PSO all included by construction).
 *  - Wholesale exposure: real USEP per period, PLUS the non-energy charges a
 *    wholesale buyer still pays to SP Group and EMC (network, MSS, PSO). Those
 *    three are taken from the real published tariff components, which is the
 *    only defensible public source for them.
 *  - Fixed contract: the operator-entered rate applied to the same load.
 *
 * GST is excluded throughout, matching how EMA and EMC publish their prices.
 */
export function compareCosts(
  load: ShapedLoad,
  tariffTotalC: number,
  nonEnergy: NonEnergyComponents,
  offers: { retailer: string; plan: string; rate_c_kwh: number; term_months: number | null; observed_at: string }[]
): CostComparison | null {
  const { periods } = load;
  if (!periods.length) return null;

  const totalMwh = periods.reduce((a, p) => a + p.mwh, 0);
  if (totalMwh <= 0) return null;

  const useps = periods.map((p) => p.usep as number).sort((a, b) => a - b);
  const avgUsep = mean(useps);
  const cPerKwh = (sgd: number) => (sgd / (totalMwh * 1000)) * 100;

  // --- Regulated tariff -------------------------------------------------
  const tariffSgd = totalMwh * 1000 * (tariffTotalC / 100);

  // --- Wholesale exposure ----------------------------------------------
  // USEP is SGD/MWh; convert the non-energy adder from cents/kWh to SGD/MWh.
  const nonEnergySgdPerMwh = nonEnergy.total_c * 10;
  let wholesaleSgd = 0;
  for (const p of periods) {
    wholesaleSgd += p.mwh * ((p.usep as number) + nonEnergySgdPerMwh);
  }

  const q = (v: number) => useps[Math.min(useps.length - 1, Math.max(0, Math.round((useps.length - 1) * v)))];

  const scenarios: ScenarioCost[] = [
    {
      id: "regulated",
      label: "Regulated tariff (default)",
      total_sgd: round(tariffSgd, 0),
      effective_c_kwh: round(cPerKwh(tariffSgd), 2),
      delta_vs_tariff_sgd: 0,
      delta_vs_tariff_pct: 0,
      note: `EMA/SP published all-inclusive rate for ${nonEnergy.quarter}. No exposure to spot price moves.`,
    },
    {
      id: "wholesale",
      label: "Wholesale exposure (USEP + non-energy)",
      total_sgd: round(wholesaleSgd, 0),
      effective_c_kwh: round(cPerKwh(wholesaleSgd), 2),
      delta_vs_tariff_sgd: round(wholesaleSgd - tariffSgd, 0),
      delta_vs_tariff_pct: round(((wholesaleSgd - tariffSgd) / tariffSgd) * 100, 1),
      note: `Real USEP each half hour plus ${nonEnergy.total_c.toFixed(2)} c/kWh of network, MSS and market fees. You carry the price risk.`,
    },
  ];

  for (const o of offers) {
    const sgd = totalMwh * 1000 * (o.rate_c_kwh / 100);
    scenarios.push({
      id: `fixed:${o.retailer}:${o.plan}:${o.term_months ?? "na"}`,
      label: `${o.retailer} — ${o.plan}${o.term_months ? ` (${o.term_months}m)` : ""}`,
      total_sgd: round(sgd, 0),
      effective_c_kwh: round(o.rate_c_kwh, 2),
      delta_vs_tariff_sgd: round(sgd - tariffSgd, 0),
      delta_vs_tariff_pct: round(((sgd - tariffSgd) / tariffSgd) * 100, 1),
      note: "Operator-entered quoted rate. Verify against the retailer's fact sheet before signing.",
    });
  }

  const cheapest = scenarios.reduce((a, b) =>
    b.total_sgd < a.total_sgd ? b : a
  ).id;

  const dates = periods.map((p) => p.ts).sort();

  return {
    window: {
      from: dates[0],
      to: dates[dates.length - 1],
      days: load.diagnostics.window_days,
      mwh: round(totalMwh, 1),
    },
    usep: {
      avg: round(avgUsep, 2),
      min: round(useps[0], 2),
      max: round(useps[useps.length - 1], 2),
      p10: round(q(0.1), 2),
      p50: round(q(0.5), 2),
      p90: round(q(0.9), 2),
      volatility_pct: round(
        (Math.sqrt(mean(useps.map((u) => (u - avgUsep) ** 2))) / avgUsep) * 100,
        1
      ),
    },
    non_energy: nonEnergy,
    scenarios,
    cheapest,
    fixed_offers: offers,
  };
}

/** Non-energy adder derived from the REAL published tariff components. */
export function nonEnergyFromTariff(t: {
  network_c: number | null;
  mss_c: number | null;
  pso_c: number | null;
  quarter: string;
  source_url: string | null;
}): NonEnergyComponents {
  const network = t.network_c ?? 0;
  const mss = t.mss_c ?? 0;
  const pso = t.pso_c ?? 0;
  return {
    network_c: round(network, 2),
    mss_c: round(mss, 2),
    pso_c: round(pso, 2),
    total_c: round(network + mss + pso, 2),
    quarter: t.quarter,
    source_url: t.source_url,
  };
}

/** Peak vs off-peak price reality, straight from the real feed. */
export function peakOffPeak(periods: MarketPeriod[]) {
  const peak: number[] = [];
  const off: number[] = [];
  for (const p of periods) {
    if (p.usep === null || !Number.isFinite(p.usep)) continue;
    (isPeakWindow(p.ts) ? peak : off).push(p.usep);
  }
  const mp = mean(peak);
  const mo = mean(off);
  return {
    definition:
      "Peak = weekdays 08:00–19:59 SGT. Off-peak = nights, weekends and public-holiday hours.",
    peak_avg: round(mp, 2),
    peak_periods: peak.length,
    offpeak_avg: round(mo, 2),
    offpeak_periods: off.length,
    spread: round(mp - mo, 2),
    spread_pct: mo > 0 ? round(((mp - mo) / mo) * 100, 1) : 0,
  };
}

/** Average real USEP by half-hour of the day, for the intraday shape chart. */
export function intradayShape(periods: MarketPeriod[]) {
  const buckets = new Map<number, number[]>();
  for (const p of periods) {
    if (p.usep === null || !Number.isFinite(p.usep)) continue;
    const m = sgtMinutes(p.ts);
    const arr = buckets.get(m);
    if (arr) arr.push(p.usep);
    else buckets.set(m, [p.usep]);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([m, xs]) => ({
      minute: m,
      label: `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`,
      mean_usep: round(mean(xs), 2),
      samples: xs.length,
    }));
}
