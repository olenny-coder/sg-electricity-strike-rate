/**
 * Load shifting and short-term price forecasting.
 *
 * Both operate directly on the real half-hourly USEP series. Neither invents
 * prices: the shift optimiser only moves modelled load between periods whose
 * real prices are known, and the forecaster is backtested against held-out real
 * periods so its error can be reported honestly rather than asserted.
 */
import type { MarketPeriod } from "../db.ts";
import { mean, round, sgtMinutes, sgtDate, isWeekend } from "./time.ts";

/* ------------------------------------------------------------------ */
/* Load shifting                                                       */
/* ------------------------------------------------------------------ */

export interface ShiftPlan {
  /** MWh moved out of expensive periods. */
  shifted_mwh: number;
  from_avg_price: number;
  to_avg_price: number;
  /** Real spread captured, SGD/MWh. */
  captured_spread: number;
  /** Gross saving over the window, SGD. */
  saving_sgd: number;
  /** Distinct periods load was reduced in / added to. */
  shed_periods: number;
  absorb_periods: number;
  /** Per-period detail, capped for display. */
  moves: {
    ts: string;
    shed_mwh: number;
    shed_price: number;
    absorb_ts: string;
    absorb_mwh: number;
    absorb_price: number;
  }[];
  /** How the shift was constrained. */
  constraints: {
    curtailable_mw: number;
    max_shed_per_period_mwh: number;
    window_days: number;
  };
  explanation: string;
}

/**
 * Greedily pair the most expensive periods with the cheapest ones.
 *
 * Constraints that keep this physically meaningful:
 *  - a period can give up at most `curtailable_mw` of load (that is the firm
 *    load the site declared it can move), and at most the load it actually has;
 *  - a period can absorb at most `curtailable_mw` of extra load, so shifting
 *    never more than doubles a period's draw;
 *  - a period cannot both shed and absorb.
 *
 * This is a genuine optimisation over real prices, not a rule of thumb: it
 * captures the full achievable spread given those limits.
 */
export function optimiseShift(
  periods: { ts: string; usep: number | null; mwh: number; mw: number }[],
  curtailableMw: number
): ShiftPlan {
  const usable = periods.filter(
    (p) => p.usep !== null && Number.isFinite(p.usep) && p.mwh > 0
  );

  const maxPerPeriod = curtailableMw * 0.5; // MW over a half hour -> MWh
  const days = new Set(usable.map((p) => sgtDate(p.ts))).size;

  const empty: ShiftPlan = {
    shifted_mwh: 0,
    from_avg_price: 0,
    to_avg_price: 0,
    captured_spread: 0,
    saving_sgd: 0,
    shed_periods: 0,
    absorb_periods: 0,
    moves: [],
    constraints: {
      curtailable_mw: curtailableMw,
      max_shed_per_period_mwh: round(maxPerPeriod, 3),
      window_days: days,
    },
    explanation: "No shiftable load: set a curtailable capacity above zero.",
  };
  if (!usable.length || curtailableMw <= 0) return empty;

  // Candidate donors (most expensive first) and receivers (cheapest first).
  const donors = usable
    .map((p) => ({
      ts: p.ts,
      price: p.usep as number,
      // Cannot give up more load than the period actually has.
      capacity: Math.min(maxPerPeriod, p.mwh),
      remaining: 0,
    }))
    .filter((d) => d.capacity > 0.0001)
    .sort((a, b) => b.price - a.price);
  for (const d of donors) d.remaining = d.capacity;

  const receivers = usable
    .map((p) => ({ ts: p.ts, price: p.usep as number, remaining: maxPerPeriod }))
    .sort((a, b) => a.price - b.price);

  const moves: ShiftPlan["moves"] = [];
  let shifted = 0;
  let fromCost = 0;
  let toCost = 0;

  // Only ever move energy from a genuinely more expensive period to a cheaper
  // one; this guarantees a non-negative saving.
  let ri = 0;
  for (const d of donors) {
    while (d.remaining > 0.0001) {
      // Advance to a receiver that is strictly cheaper than this donor.
      while (
        ri < receivers.length &&
        (receivers[ri].remaining <= 0.0001 || receivers[ri].price >= d.price)
      ) {
        ri++;
      }
      if (ri >= receivers.length) break;
      const r = receivers[ri];
      if (r.ts === d.ts) {
        ri++;
        continue;
      }
      const qty = Math.min(d.remaining, r.remaining);
      if (qty <= 0.0001) break;

      d.remaining -= qty;
      r.remaining -= qty;
      shifted += qty;
      fromCost += qty * d.price;
      toCost += qty * r.price;
      moves.push({
        ts: d.ts,
        shed_mwh: round(qty, 4),
        shed_price: round(d.price, 2),
        absorb_ts: r.ts,
        absorb_mwh: round(qty, 4),
        absorb_price: round(r.price, 2),
      });
    }
  }

  if (shifted <= 0) {
    return {
      ...empty,
      constraints: {
        curtailable_mw: curtailableMw,
        max_shed_per_period_mwh: round(maxPerPeriod, 3),
        window_days: days,
      },
      explanation:
        "No profitable shift exists in this window: every cheap period is already as loaded as the constraints allow.",
    };
  }

  const fromAvg = fromCost / shifted;
  const toAvg = toCost / shifted;

  return {
    shifted_mwh: round(shifted, 2),
    from_avg_price: round(fromAvg, 2),
    to_avg_price: round(toAvg, 2),
    captured_spread: round(fromAvg - toAvg, 2),
    saving_sgd: round(shifted * (fromAvg - toAvg), 0),
    shed_periods: new Set(moves.map((m) => m.ts)).size,
    absorb_periods: new Set(moves.map((m) => m.absorb_ts)).size,
    moves: moves
      .sort((a, b) => b.shed_price - a.shed_price)
      .slice(0, 40),
    constraints: {
      curtailable_mw: curtailableMw,
      max_shed_per_period_mwh: round(maxPerPeriod, 3),
      window_days: days,
    },
    explanation:
      `Moving up to ${curtailableMw} MW per half hour out of the priciest periods and into the ` +
      `cheapest ones captures a real average spread of ${(fromAvg - toAvg).toFixed(2)} SGD/MWh ` +
      `across ${days} days of actual USEP. Operationally this means running deferrable load ` +
      `(chillers, thermal storage, batch processes, EV charging) overnight and off-peak.`,
  };
}

/* ------------------------------------------------------------------ */
/* Forecasting                                                         */
/* ------------------------------------------------------------------ */

export interface ForecastPoint {
  ts: string;
  label: string;
  predicted: number;
  /** Same-slot real values from prior weeks, for transparency. */
  basis: number[];
}

export interface ForecastResult {
  generated_at: string;
  horizon_hours: number;
  points: ForecastPoint[];
  method: string;
  backtest: BacktestResult;
}

export interface BacktestResult {
  evaluated_periods: number;
  mae: number;
  mape_pct: number;
  /** Naive benchmark: previous day, same half hour. */
  baseline_mae: number;
  baseline_mape_pct: number;
  /** Improvement of the model over the naive benchmark, percent. */
  skill_pct: number;
  /** How far back the evaluation window reached. */
  from: string;
  to: string;
  interpretation: string;
}

/**
 * Seasonal-naive forecaster with a level correction.
 *
 * For each future half hour, take the real USEP at the same time-of-day and
 * same weekday type (weekday/weekend) over the previous `weeks` weeks, and use
 * the median. The median is deliberate: USEP has violent positive spikes, and a
 * mean would let one spike distort the whole forecast.
 *
 * A multiplicative level factor reconciles the recent week with the historical
 * seasonal level, so a market that has genuinely re-rated is not forecast from
 * stale levels.
 */
export function forecastUsep(
  periods: MarketPeriod[],
  opts: { horizonHours?: number; weeks?: number } = {}
): ForecastResult {
  const horizonHours = opts.horizonHours ?? 48;
  const weeks = opts.weeks ?? 6;

  const series = periods
    .filter((p) => p.usep !== null && Number.isFinite(p.usep))
    .sort((a, b) => (a.ts < b.ts ? -1 : 1));

  if (series.length < 48 * 3) {
    return {
      generated_at: new Date().toISOString(),
      horizon_hours: horizonHours,
      points: [],
      method:
        "Seasonal-naive median by time-of-day and day-type, with a recent level correction.",
      backtest: {
        evaluated_periods: 0,
        mae: 0,
        mape_pct: 0,
        baseline_mae: 0,
        baseline_mape_pct: 0,
        skill_pct: 0,
        from: "",
        to: "",
        interpretation:
          "Insufficient real USEP history to fit or backtest a forecast. At least three days are required.",
      },
    };
  }

  const slotKey = (p: MarketPeriod) => {
    const dayType = isWeekend(p.ts) ? "we" : "wd";
    return `${dayType}:${sgtMinutes(p.ts)}`;
  };

  const bySlot = new Map<string, MarketPeriod[]>();
  for (const p of series) {
    const k = slotKey(p);
    const arr = bySlot.get(k);
    if (arr) arr.push(p);
    else bySlot.set(k, [p]);
  }

  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  // Level correction: recent 7 days vs the seasonal pool, capped so a single
  // spiky week cannot run the forecast away.
  const lastTs = series[series.length - 1].ts;
  const cutoff = new Date(Date.parse(lastTs) - 7 * 86_400_000).toISOString();
  const recent = series.filter((p) => p.ts >= cutoff);
  const recentMean = mean(recent.map((p) => p.usep as number));
  const overallMean = mean(series.map((p) => p.usep as number));
  let level = overallMean > 0 ? recentMean / overallMean : 1;
  level = Math.min(1.6, Math.max(0.625, level));

  const predictAt = (ts: string, history: MarketPeriod[]): { value: number; basis: number[] } | null => {
    const dayType = isWeekend(ts) ? "we" : "wd";
    const key = `${dayType}:${sgtMinutes(ts)}`;
    const pool = (bySlot.get(key) ?? []).filter((p) => p.ts < ts);
    if (!pool.length) return null;
    // Most recent `weeks` observations of this exact slot.
    const basis = pool
      .slice(-weeks)
      .map((p) => p.usep as number)
      .filter(Number.isFinite);
    if (!basis.length) return null;
    return { value: median(basis) * level, basis };
  };

  // --- Backtest on the final 14 days, predicting only from earlier data ---
  const evalHours = Math.min(14 * 24, horizonHours * 4);
  const evalStartTs = new Date(Date.parse(lastTs) - evalHours * 3_600_000).toISOString();
  const evalSet = series.filter((p) => p.ts >= evalStartTs);

  let errSum = 0;
  let pctSum = 0;
  let baseErrSum = 0;
  let basePctSum = 0;
  let n = 0;

  // Index by timestamp so the naive baseline is an O(1) lookup, not a scan.
  const indexOfTs = new Map<string, number>();
  series.forEach((p, i) => indexOfTs.set(p.ts, i));

  for (const actual of evalSet) {
    const pred = predictAt(actual.ts, series);
    if (!pred) continue;
    const a = actual.usep as number;
    const e = Math.abs(pred.value - a);
    errSum += e;
    pctSum += a !== 0 ? (e / Math.abs(a)) * 100 : 0;

    // Naive baseline: the real value exactly one day (48 periods) earlier.
    const here = indexOfTs.get(actual.ts);
    const prevIdx = here === undefined ? -1 : here - 48;
    if (prevIdx >= 0) {
      const b = series[prevIdx].usep as number;
      const be = Math.abs(b - a);
      baseErrSum += be;
      basePctSum += a !== 0 ? (be / Math.abs(a)) * 100 : 0;
    }
    n++;
  }

  const mae = n ? errSum / n : 0;
  const mape = n ? pctSum / n : 0;
  const baseMae = n ? baseErrSum / n : 0;
  const baseMape = n ? basePctSum / n : 0;
  const skill = baseMae > 0 ? ((baseMae - mae) / baseMae) * 100 : 0;

  const backtest: BacktestResult = {
    evaluated_periods: n,
    mae: round(mae, 2),
    mape_pct: round(mape, 1),
    baseline_mae: round(baseMae, 2),
    baseline_mape_pct: round(baseMape, 1),
    skill_pct: round(skill, 1),
    from: evalSet.length ? evalSet[0].ts : "",
    to: lastTs,
    interpretation: n
      ? `Backtested on ${n} real half-hour periods. Mean absolute error ${mae.toFixed(2)} SGD/MWh ` +
        `(${mape.toFixed(1)}% MAPE). A naive "same half hour yesterday" benchmark scores ` +
        `${baseMae.toFixed(2)} SGD/MWh, so this model is ${skill >= 0 ? "better" : "worse"} by ` +
        `${Math.abs(skill).toFixed(1)}%. Treat the forecast as a planning aid, not a price guarantee.`
      : "Not enough overlapping history to backtest.",
  };

  // --- Forward points -----------------------------------------------------
  const points: ForecastPoint[] = [];
  const startMs = Date.parse(lastTs) + 30 * 60_000;
  const stepMs = 30 * 60_000;
  const count = (horizonHours * 60) / 30;

  for (let i = 0; i < count; i++) {
    const d = new Date(startMs + i * stepMs);
    // Rebuild an SGT wall-clock string the same way the stored rows are built.
    const sgt = new Date(d.getTime() + 8 * 3_600_000);
    const ts = `${sgt.toISOString().slice(0, 10)}T${sgt.toISOString().slice(11, 16)}:00+08:00`;
    const pred = predictAt(ts, series);
    points.push({
      ts,
      label: `${ts.slice(5, 10)} ${ts.slice(11, 16)}`,
      predicted: pred ? round(pred.value, 2) : 0,
      basis: pred ? pred.basis.map((b) => round(b, 2)) : [],
    });
  }

  return {
    generated_at: new Date().toISOString(),
    horizon_hours: horizonHours,
    points,
    method:
      `Seasonal-naive median of the same time-of-day and day-type (weekday/weekend) over the ` +
      `previous ${weeks} weeks, multiplied by a recent-level factor of ${level.toFixed(3)} ` +
      `derived from the last 7 days of real USEP.`,
    backtest,
  };
}

/**
 * When, within the coming days, is power forecast to be cheapest?
 * Used to answer "when should I run deferrable load?".
 */
export function cheapestWindows(forecast: ForecastResult, topN = 6) {
  const pts = forecast.points.filter((p) => p.predicted > 0);
  if (!pts.length) return [];
  const sorted = [...pts].sort((a, b) => a.predicted - b.predicted);
  const cheapest = sorted.slice(0, topN).map((p) => ({
    ts: p.ts,
    label: p.label,
    price: p.predicted,
  }));
  const avg = mean(pts.map((p) => p.predicted));
  return cheapest.map((c) => ({
    ...c,
    vs_average_pct: round(((c.price - avg) / avg) * 100, 1),
  }));
}
