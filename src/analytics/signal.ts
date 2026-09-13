/**
 * The "strike" decision engine.
 *
 * This module is deliberately transparent. Every recommendation is decomposed
 * into the real numbers that produced it, so an energy manager can disagree with
 * the conclusion and still use the evidence.
 *
 * It answers one question: for this site's load, should we lock a fixed-price
 * contract now, stay on the regulated tariff, or keep floating on wholesale?
 */
import type { MarketPeriod } from "../db.ts";
import {
  compareCosts,
  nonEnergyFromTariff,
  peakOffPeak,
  type CostComparison,
  type BuyerProfile,
  type ShapedLoad,
} from "./loadshape.ts";
import { forecastUsep, type ForecastResult } from "./priceActions.ts";
import { mean, quantile, round, sgtDate } from "./time.ts";

export type Verdict = "STRIKE_FIXED" | "FLOAT_WHOLESALE" | "HOLD_REGULATED" | "INSUFFICIENT_DATA";

export interface Reason {
  /** Plain-language finding. */
  text: string;
  /** The real number behind it. */
  evidence: string;
  /** Does this push toward locking a contract, or away from it? */
  direction: "lock" | "float" | "neutral";
}

export interface StrikeSignal {
  verdict: Verdict;
  headline: string;
  confidence: "high" | "medium" | "low";
  /** 0-100: how strongly the evidence favours the verdict. */
  score: number;
  reasons: Reason[];
  /** Where today's real price sits in the recent distribution. */
  price_context: {
    latest_ts: string;
    latest_usep: number;
    percentile_in_window: number;
    window_p10: number;
    window_p50: number;
    window_p90: number;
    trend_7d_vs_30d_pct: number;
  } | null;
  /** Forward view derived from the backtested forecast. */
  forward_view: {
    horizon_hours: number;
    forecast_avg: number;
    recent_avg: number;
    direction: "rising" | "falling" | "flat";
    change_pct: number;
    backtest_mape_pct: number;
    backtest_skill_pct: number;
  } | null;
  /** Annualised cost under each route, at the buyer's real consumption. */
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
  peak_off_peak: ReturnType<typeof peakOffPeak>;
  forecast: ForecastResult | null;
}

const fmtSgd = (n: number) =>
  `S$${n.toLocaleString("en-SG", { maximumFractionDigits: 0 })}`;

/**
 * Produce the recommendation.
 *
 * Thresholds are explicit and stated in the reasons, because a black-box score
 * is useless to someone signing a two-year contract.
 */
export function computeSignal(args: {
  periods: MarketPeriod[];
  load: ShapedLoad;
  profile: BuyerProfile;
  tariff: { quarter: string; total_c: number; network_c: number | null; mss_c: number | null; pso_c: number | null; source_url: string | null };
  offers: { retailer: string; plan: string; rate_c_kwh: number; term_months: number | null; observed_at: string }[];
}): StrikeSignal {
  const { periods, profile, tariff, offers } = args;

  const nonEnergy = nonEnergyFromTariff({
    network_c: tariff.network_c,
    mss_c: tariff.mss_c,
    pso_c: tariff.pso_c,
    quarter: tariff.quarter,
    source_url: tariff.source_url,
  });

  const comparison = compareCosts(args.load, tariff.total_c, nonEnergy, offers);
  const pop = peakOffPeak(periods);

  const base: StrikeSignal = {
    verdict: "INSUFFICIENT_DATA",
    headline: "Not enough real market data to make a recommendation.",
    confidence: "low",
    score: 0,
    reasons: [],
    price_context: null,
    forward_view: null,
    annualised: [],
    tariff_c_kwh: tariff.total_c,
    tariff_quarter: tariff.quarter,
    comparison,
    peak_off_peak: pop,
    forecast: null,
  };

  if (!periods.length || !comparison) return base;

  const useps = periods
    .map((p) => p.usep)
    .filter((v): v is number => v !== null && Number.isFinite(v));
  if (useps.length < 48) return base;

  const sorted = [...useps].sort((a, b) => a - b);
  const avgUsep = mean(useps);
  const latest = periods[periods.length - 1];
  const latestUsep = latest.usep as number;

  const p10 = quantile(sorted, 0.1);
  const p50 = quantile(sorted, 0.5);
  const p90 = quantile(sorted, 0.9);

  const below = sorted.filter((u) => u <= latestUsep).length;
  const percentile = (below / sorted.length) * 100;

  // 7-day vs 30-day momentum on real prices.
  const lastTs = latest.ts;
  const d7 = new Date(Date.parse(lastTs) - 7 * 86_400_000).toISOString();
  const d30 = new Date(Date.parse(lastTs) - 30 * 86_400_000).toISOString();
  const avg7 = mean(
    periods.filter((p) => p.ts >= d7 && p.usep !== null).map((p) => p.usep as number)
  );
  const avg30 = mean(
    periods.filter((p) => p.ts >= d30 && p.usep !== null).map((p) => p.usep as number)
  );
  const momentum = avg30 > 0 ? ((avg7 - avg30) / avg30) * 100 : 0;

  // Forward view.
  const forecast = forecastUsep(periods, { horizonHours: 48 });
  const fPts = forecast.points.filter((p) => p.predicted > 0);
  const forecastAvg = mean(fPts.map((p) => p.predicted));
  const fcChange = avg7 > 0 ? ((forecastAvg - avg7) / avg7) * 100 : 0;

  // --- Route economics, all in cents/kWh for comparison ------------------
  const wholesaleAllInC = avgUsep / 10 + nonEnergy.total_c;
  const tariffC = tariff.total_c;
  const bestOffer = offers.length
    ? offers.reduce((a, b) => (b.rate_c_kwh < a.rate_c_kwh ? b : a))
    : null;

  const annualMwh = profile.annual_mwh;
  const toAnnual = (c: number) => annualMwh * 1000 * (c / 100);

  const routes = [
    { route: "regulated", label: `Regulated tariff (${tariff.quarter})`, c: tariffC },
    { route: "wholesale", label: "Wholesale exposure (recent real USEP)", c: wholesaleAllInC },
  ];
  if (bestOffer) {
    routes.push({
      route: "fixed",
      label: `Best fixed offer — ${bestOffer.retailer} ${bestOffer.plan}`,
      c: bestOffer.rate_c_kwh,
    });
  }

  const annualised = routes.map((r) => {
    const annual = toAnnual(r.c);
    const tariffAnnual = toAnnual(tariffC);
    return {
      route: r.route,
      label: r.label,
      annual_sgd: round(annual, 0),
      effective_c_kwh: round(r.c, 2),
      delta_vs_tariff_sgd: round(annual - tariffAnnual, 0),
    };
  });

  // --- Scoring -----------------------------------------------------------
  // Positive score => locking a fixed price is attractive.
  const reasons: Reason[] = [];
  let score = 50;

  // 1. Fixed offer versus tariff.
  if (bestOffer) {
    const gap = tariffC - bestOffer.rate_c_kwh;
    const gapPct = (gap / tariffC) * 100;
    if (gap > 0) {
      const pts = Math.min(25, gapPct * 2.5);
      score += pts;
      reasons.push({
        text: `The best quoted fixed rate undercuts the regulated tariff, so locking in cuts cost immediately.`,
        evidence: `${bestOffer.rate_c_kwh.toFixed(2)} c/kWh fixed vs ${tariffC.toFixed(2)} c/kWh regulated — ${gapPct.toFixed(1)}% below, worth ${fmtSgd(Math.abs(toAnnual(gap)))} a year at ${annualMwh.toLocaleString()} MWh.`,
        direction: "lock",
      });
    } else {
      const pts = Math.min(25, Math.abs(gapPct) * 2.5);
      score -= pts;
      reasons.push({
        text: `The best quoted fixed rate is above the regulated tariff, so locking in would cost more than doing nothing.`,
        evidence: `${bestOffer.rate_c_kwh.toFixed(2)} c/kWh fixed vs ${tariffC.toFixed(2)} c/kWh regulated — ${Math.abs(gapPct).toFixed(1)}% above, costing ${fmtSgd(Math.abs(toAnnual(gap)))} a year.`,
        direction: "float",
      });
    }
  } else {
    reasons.push({
      text: "No fixed-price quotes have been entered, so contract-versus-market cannot be assessed.",
      evidence: "Business electricity rates in Singapore are quoted privately; add quotes to enable this comparison.",
      direction: "neutral",
    });
  }

  // 2. Wholesale versus tariff.
  const wsGap = tariffC - wholesaleAllInC;
  const wsGapPct = (wsGap / tariffC) * 100;
  if (wsGap > 1) {
    const pts = Math.min(20, wsGapPct * 1.5);
    score -= pts;
    reasons.push({
      text: "Wholesale exposure has recently been cheaper than the regulated tariff.",
      evidence: `Real USEP averaged ${avgUsep.toFixed(2)} SGD/MWh over the window; adding ${nonEnergy.total_c.toFixed(2)} c/kWh of network, MSS and market fees gives ${wholesaleAllInC.toFixed(2)} c/kWh all-in, ${wsGapPct.toFixed(1)}% below the ${tariffC.toFixed(2)} c/kWh tariff.`,
      direction: "float",
    });
  } else if (wsGap < -1) {
    const pts = Math.min(20, Math.abs(wsGapPct) * 1.5);
    score += pts;
    reasons.push({
      text: "Wholesale exposure has recently been MORE expensive than the regulated tariff.",
      evidence: `All-in wholesale works out at ${wholesaleAllInC.toFixed(2)} c/kWh versus ${tariffC.toFixed(2)} c/kWh regulated — ${Math.abs(wsGapPct).toFixed(1)}% worse. Floating on spot has not paid recently.`,
      direction: "lock",
    });
  }

  // 3. Volatility — the core risk argument for fixing.
  const vol = comparison.usep.volatility_pct;
  if (vol > 45) {
    score += 12;
    reasons.push({
      text: "Wholesale prices are highly volatile, which is the strongest argument for a fixed price.",
      evidence: `USEP dispersion is ${vol.toFixed(1)}% of its mean, ranging ${comparison.usep.min.toFixed(0)} to ${comparison.usep.max.toFixed(0)} SGD/MWh. At ${annualMwh.toLocaleString()} MWh a bad quarter is expensive.`,
      direction: "lock",
    });
  } else if (vol < 22) {
    score -= 8;
    reasons.push({
      text: "Wholesale prices have been unusually stable, which lowers the cost of staying exposed.",
      evidence: `USEP dispersion is only ${vol.toFixed(1)}% of its mean over the window.`,
      direction: "float",
    });
  }

  // 4. Momentum and forward view.
  const direction: "rising" | "falling" | "flat" =
    fcChange > 4 ? "rising" : fcChange < -4 ? "falling" : "flat";

  if (direction === "rising") {
    score += 10;
    reasons.push({
      text: "Prices are forecast to rise, so waiting is likely to be more expensive than acting.",
      evidence: `The next ${forecast.horizon_hours}h is forecast ${forecastAvg.toFixed(0)} SGD/MWh, ${fcChange.toFixed(1)}% above the last 7 days' real average of ${avg7.toFixed(0)} (backtest error ${forecast.backtest.mape_pct}% MAPE).`,
      direction: "lock",
    });
  } else if (direction === "falling") {
    score -= 10;
    reasons.push({
      text: "Prices are forecast to fall, so there is value in waiting before committing.",
      evidence: `The next ${forecast.horizon_hours}h is forecast ${forecastAvg.toFixed(0)} SGD/MWh, ${Math.abs(fcChange).toFixed(1)}% below the last 7 days' real average of ${avg7.toFixed(0)}.`,
      direction: "float",
    });
  }

  // 5. Where we are in the range — the timing signal.
  if (percentile < 25) {
    score -= 8;
    reasons.push({
      text: "The current price sits in the cheap part of its recent range.",
      evidence: `Latest real USEP ${latestUsep.toFixed(2)} SGD/MWh is at the ${percentile.toFixed(0)}th percentile of the last ${new Set(periods.map((p) => sgtDate(p.ts))).size} days (p10 ${p10.toFixed(0)}, p50 ${p50.toFixed(0)}, p90 ${p90.toFixed(0)}).`,
      direction: "float",
    });
  } else if (percentile > 75) {
    score += 8;
    reasons.push({
      text: "The current price sits in the expensive part of its recent range.",
      evidence: `Latest real USEP ${latestUsep.toFixed(2)} SGD/MWh is at the ${percentile.toFixed(0)}th percentile of the window (p50 ${p50.toFixed(0)}, p90 ${p90.toFixed(0)}). Locking now removes further upside.`,
      direction: "lock",
    });
  }

  // 6. Peak/off-peak spread — a load-shifting argument, not a contract one.
  if (pop.spread_pct > 10) {
    reasons.push({
      text: "There is a real peak/off-peak spread you can capture without changing supplier.",
      evidence: `Real peak average ${pop.peak_avg.toFixed(0)} SGD/MWh vs off-peak ${pop.offpeak_avg.toFixed(0)} — a ${pop.spread_pct.toFixed(1)}% spread. Shifting deferrable load is a saving available on any contract.`,
      direction: "neutral",
    });
  }

  score = Math.max(0, Math.min(100, score));
  const confidence: StrikeSignal["confidence"] =
    periods.length > 48 * 60 ? "high" : periods.length > 48 * 14 ? "medium" : "low";

  let verdict: Verdict;
  let headline: string;
  if (score >= 66) {
    verdict = "STRIKE_FIXED";
    headline = "Strike: locking a fixed price now is well supported by the data.";
  } else if (score >= 54) {
    verdict = "STRIKE_FIXED";
    headline = "Lean toward locking: the evidence modestly favours a fixed price.";
  } else if (score <= 34) {
    verdict = "FLOAT_WHOLESALE";
    headline = "Float: wholesale exposure has been the cheaper route and is not deteriorating.";
  } else if (score <= 46) {
    verdict = "FLOAT_WHOLESALE";
    headline = "Lean toward floating: exposure looks cheaper than committing today.";
  } else {
    verdict = "HOLD_REGULATED";
    headline = "Hold on the regulated tariff: no route is clearly better right now.";
  }

  if (offers.length === 0 && verdict === "STRIKE_FIXED") {
    verdict = "HOLD_REGULATED";
    headline =
      "Hold for now: wholesale looks expensive, but no fixed quotes are loaded to compare against.";
  }

  return {
    verdict,
    headline,
    confidence,
    score: Math.round(score),
    reasons,
    price_context: {
      latest_ts: latest.ts,
      latest_usep: round(latestUsep, 2),
      percentile_in_window: round(percentile, 1),
      window_p10: round(p10, 2),
      window_p50: round(p50, 2),
      window_p90: round(p90, 2),
      trend_7d_vs_30d_pct: round(momentum, 1),
    },
    forward_view: fPts.length
      ? {
          horizon_hours: forecast.horizon_hours,
          forecast_avg: round(forecastAvg, 2),
          recent_avg: round(avg7, 2),
          direction,
          change_pct: round(fcChange, 1),
          backtest_mape_pct: forecast.backtest.mape_pct,
          backtest_skill_pct: forecast.backtest.skill_pct,
        }
      : null,
    annualised,
    tariff_c_kwh: tariffC,
    tariff_quarter: tariff.quarter,
    comparison,
    peak_off_peak: pop,
    forecast,
  };
}
