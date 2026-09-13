/**
 * Demand Response revenue estimation.
 *
 * THE PROGRAMME'S ACTUAL ECONOMICS (this shapes the whole module)
 * --------------------------------------------------------------
 * Singapore's DR programme does NOT pay for standing by. It pays an ENERGY
 * incentive, and only when curtailment is actually called:
 *
 *   - Eligibility: contestable consumer offering at least 0.1 MW of
 *     curtailment, able to respond in about three minutes.
 *   - Trigger: EMA calls DR when USEP rises above roughly 1.5x the long-run
 *     marginal cost of a combined-cycle gas turbine.
 *   - Payment: LCP x LCQ — the Load Curtailment Price times the quantity
 *     curtailed. EMA describes this as the participant receiving one third of
 *     the savings created, capped at S$4,500/MWh.
 *   - Cliff: delivering 80-100% of a scheduled reduction earns NOTHING. There
 *     is no pro-rata payment.
 *   - Interruptible Load is a different programme: it pays the contingency
 *     reserve clearing price for availability, with no separate activation
 *     payment.
 *
 * WHAT THIS MODULE DOES WITH REAL DATA
 * ------------------------------------
 * The EGO feed carries both the Temporary Price Cap fields and the real LCP
 * per half hour. So rather than assume a call frequency, this module:
 *
 *   1. Derives the trigger level from the REAL published cap: MAPT is 3x LRMC,
 *      so EMA's 1.5x LRMC trigger is MAPT/2. Wherever MAPT is published, the
 *      trigger is a real number, period by period.
 *   2. Counts how often real USEP actually crossed that trigger.
 *   3. Prices the events at the REAL observed LCP where the market published
 *      one, so the incentive rate is measured rather than assumed.
 *
 * Revenue is then: real event count x committed MW x duration x real LCP. The
 * only assumption left is how much of your committed capacity you actually
 * deliver, which is a property of your site, not of the market.
 */
import type { MarketPeriod } from "../db.ts";
import { mean, round, isPeakWindow, sgtDate, quantile } from "./time.ts";

export interface DrParameters {
  /** Firm curtailment the site commits to, MW. Must be at least 0.1 MW. */
  curtailable_mw: number;
  /** How long each activation lasts, in hours (one "instance" is up to 4 h). */
  event_hours: number;
  /** Fraction of committed MW actually delivered during an activation. */
  delivery_rate: number;
  /** Cost of lost production per MWh curtailed, SGD/MWh. */
  production_loss_per_mwh: number;
  /**
   * Override the incentive rate. Leave at 0 to use the real observed LCP.
   * EMA reported realised outcomes of roughly S$2,400-2,700/MWh over 2023-2024,
   * so treat materially higher figures with suspicion.
   */
  incentive_override: number;
}

export const DEFAULT_DR_PARAMS: DrParameters = {
  curtailable_mw: 1.0,
  event_hours: 2,
  delivery_rate: 1.0,
  production_loss_per_mwh: 0,
  incentive_override: 0,
};

/** EMA's published cap on the DR incentive. */
export const DR_INCENTIVE_CAP = 4500;
/** Programme minimum curtailable capacity, MW. */
export const DR_MIN_MW = 0.1;
/** Below this delivery fraction against a schedule, a penalty applies. */
export const DR_COMPLIANCE_FLOOR = 0.8;

export interface DrEstimate {
  eligible: boolean;
  eligibility_note: string;
  /** Real trigger level derived from the published cap. */
  trigger: {
    source: "mapt" | "percentile";
    level: number;
    basis: string;
    periods_available: number;
  };
  /** Real observed activation statistics. */
  events: {
    /** Half-hour periods where real USEP crossed the trigger. */
    periods_above_trigger: number;
    trigger_rate_pct: number;
    /** Periods where the market actually published a non-zero LCP. */
    periods_with_lcp: number;
    lcp_mean: number;
    lcp_max: number;
    /** Distinct days with at least one lcp-bearing period. */
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
  /** The 80-100% delivery cliff, stated explicitly. */
  cliff: {
    floor_pct: number;
    note: string;
  };
  /** Max theoretical value if every stressed period were called. */
  upside: {
    annual_sgd: number;
    note: string;
  };
  parameters: DrParameters;
  assumptions: string[];
  explanation: string;
}

function emptyEstimate(params: DrParameters, note: string): DrEstimate {
  return {
    eligible: false,
    eligibility_note: note,
    trigger: { source: "percentile", level: 0, basis: note, periods_available: 0 },
    events: {
      periods_above_trigger: 0,
      trigger_rate_pct: 0,
      periods_with_lcp: 0,
      lcp_mean: 0,
      lcp_max: 0,
      event_days: 0,
      annualised_events: 0,
    },
    incentive: { rate_used: 0, rate_source: note, capped: false, cap: DR_INCENTIVE_CAP },
    revenue: {
      mwh_per_event: 0,
      curtailed_mwh_per_year: 0,
      gross_annual_sgd: 0,
      production_loss_sgd: 0,
      net_annual_sgd: 0,
      sgd_per_mw_year: 0,
    },
    cliff: { floor_pct: DR_COMPLIANCE_FLOOR, note },
    upside: { annual_sgd: 0, note },
    parameters: params,
    assumptions: [],
    explanation: note,
  };
}

export function estimateDr(
  periods: MarketPeriod[],
  params: DrParameters
): DrEstimate | null {
  if (!periods.length) return null;

  if (params.curtailable_mw < DR_MIN_MW) {
    return emptyEstimate(
      params,
      `Below the programme minimum. EMA requires an offer of at least ${DR_MIN_MW} MW of curtailment responding in about three minutes. At ${params.curtailable_mw} MW this site does not qualify directly — an aggregator bundling several sites is the realistic route.`
    );
  }

  const dates = [...new Set(periods.map((p) => sgtDate(p.ts)))].sort();
  const windowDays = dates.length;
  if (!windowDays) return null;
  const from = dates[0];
  const to = dates[dates.length - 1];
  const annualisation = 365 / windowDays;

  // --- Trigger level, derived from the REAL published cap ---------------
  const withMapt = periods.filter((p) => p.mapt !== null && (p.mapt as number) > 0);
  const useps = periods
    .map((p) => p.usep)
    .filter((v): v is number => v !== null && Number.isFinite(v));

  let triggerLevel: number;
  let triggerSource: "mapt" | "percentile";
  let triggerBasis: string;

  if (withMapt.length >= periods.length * 0.5) {
    // MAPT equals 3x the CCGT long-run marginal cost, and EMA triggers DR at
    // 1.5x LRMC, so the trigger is exactly half of the published cap price.
    const maptMean = mean(withMapt.map((p) => p.mapt as number));
    triggerLevel = maptMean / 2;
    triggerSource = "mapt";
    triggerBasis = `Derived from the real published Temporary Price Cap. MAPT averaged ${maptMean.toFixed(2)} S$/MWh across ${withMapt.length} periods; MAPT is 3x the CCGT long-run marginal cost, and EMA triggers DR at 1.5x LRMC, so the trigger is MAPT / 2 = ${triggerLevel.toFixed(2)} S$/MWh.`;
  } else {
    triggerLevel = quantile([...useps].sort((a, b) => a - b), 0.98);
    triggerSource = "percentile";
    triggerBasis = `Temporary Price Cap fields are not present in the stored data, so the trigger is proxied by the 98th percentile of real USEP (${triggerLevel.toFixed(2)} S$/MWh). Re-sync market data to populate the cap fields for an exact trigger.`;
  }

  const above = periods.filter(
    (p) => p.usep !== null && (p.usep as number) >= triggerLevel
  ).length;
  const triggerRate = (above / (useps.length || 1)) * 100;

  // --- Real observed LCP --------------------------------------------------
  const lcpPeriods = periods.filter((p) => p.lcp !== null && (p.lcp as number) > 0);
  const lcpValues = lcpPeriods.map((p) => p.lcp as number);
  const lcpMean = mean(lcpValues);
  const lcpMax = lcpValues.length ? Math.max(...lcpValues) : 0;
  const eventDays = new Set(lcpPeriods.map((p) => sgtDate(p.ts))).size;

  // --- Incentive rate -----------------------------------------------------
  let rate: number;
  let rateSource: string;
  if (params.incentive_override > 0) {
    rate = params.incentive_override;
    rateSource = "Operator override.";
  } else if (lcpValues.length >= 4) {
    rate = lcpMean;
    rateSource = `Real mean Load Curtailment Price across ${lcpValues.length} periods the market actually settled a curtailment in (${from} to ${to}), peak ${lcpMax.toFixed(2)} S$/MWh.`;
  } else if (lcpValues.length > 0) {
    rate = lcpMean;
    rateSource = `Only ${lcpValues.length} settled curtailment periods in this window, so the real LCP mean of ${lcpMean.toFixed(2)} S$/MWh is a thin basis. Widen the analysis window.`;
  } else {
    // No curtailment was called at all in this window.
    rate = 0;
    rateSource =
      "No curtailment event settled in this window, so there is no observed price. The programme has published no rate card; EMA reported realised outcomes of roughly S$2,400-2,700/MWh over 2023-2024. Enter an override to model revenue.";
  }
  const capped = rate > DR_INCENTIVE_CAP;
  const effectiveRate = Math.min(rate, DR_INCENTIVE_CAP);

  // --- Revenue ------------------------------------------------------------
  // An "instance" is up to 4 hours / 8 half-hour periods.
  const mwhPerEvent = params.curtailable_mw * params.event_hours * params.delivery_rate;

  // Expectation is driven by real observed activation, annualised.
  const observedEvents = lcpPeriods.length / Math.max(1, params.event_hours * 2);
  const annualEvents = observedEvents * annualisation;
  const curtailedPerYear = annualEvents * mwhPerEvent;

  const grossAnnual = curtailedPerYear * effectiveRate;
  const lossAnnual = curtailedPerYear * params.production_loss_per_mwh;
  const netAnnual = grossAnnual - lossAnnual;

  // Upside: if every period above trigger were called at the observed rate.
  const upsideMwh = above * 0.5 * params.curtailable_mw * annualisation * params.delivery_rate;
  const upsideAnnual = upsideMwh * effectiveRate;

  const assumptions = [
    triggerBasis,
    `Event duration modelled at ${params.event_hours} h per activation (an instance may run up to 4 h).`,
    `Delivery rate ${(params.delivery_rate * 100).toFixed(0)}% of committed ${params.curtailable_mw} MW.`,
    params.production_loss_per_mwh === 0
      ? "No production loss assumed. This is optimistic for any site where curtailing stops revenue-generating equipment — set a figure, or the net number is not trustworthy."
      : `Production loss ${params.production_loss_per_mwh} SGD/MWh deducted.`,
    `Trigger crossings measured on real USEP: ${above} of ${useps.length} periods (${triggerRate.toFixed(2)}%) reached ${triggerLevel.toFixed(0)} S$/MWh or above.`,
    `Settled curtailment periods actually observed in this window: ${lcpPeriods.length} across ${eventDays} days.`,
    `Annualised from ${windowDays} days of real data (${from} to ${to}).`,
    "CRITICAL CAVEAT ON THE REVENUE FIGURE: this assumes you are scheduled in every period the market settled a curtailment, and that you capture the full clearing price each time. In practice you are one participant among many; whether you are called depends on your aggregator's bid and on system need, and the clearing price is struck against the total quantity offered nationally. A single site will capture materially less than this. Read the figure as an upper bound anchored to observed market activity, not as a budget line.",
  ];

  return {
    eligible: true,
    eligibility_note: `At ${params.curtailable_mw} MW the site clears EMA's ${DR_MIN_MW} MW minimum${params.curtailable_mw >= 1 ? ", and also clears the 1 MW threshold that lets battery storage participate" : ""}. Response must be achievable in about three minutes.`,
    trigger: {
      source: triggerSource,
      level: round(triggerLevel, 2),
      basis: triggerBasis,
      periods_available: withMapt.length,
    },
    events: {
      periods_above_trigger: above,
      trigger_rate_pct: round(triggerRate, 2),
      periods_with_lcp: lcpPeriods.length,
      lcp_mean: round(lcpMean, 2),
      lcp_max: round(lcpMax, 2),
      event_days: eventDays,
      annualised_events: round(annualEvents, 1),
    },
    incentive: {
      rate_used: round(effectiveRate, 2),
      rate_source: rateSource,
      capped,
      cap: DR_INCENTIVE_CAP,
    },
    revenue: {
      mwh_per_event: round(mwhPerEvent, 2),
      curtailed_mwh_per_year: round(curtailedPerYear, 1),
      gross_annual_sgd: round(grossAnnual, 0),
      production_loss_sgd: round(lossAnnual, 0),
      net_annual_sgd: round(netAnnual, 0),
      sgd_per_mw_year:
        params.curtailable_mw > 0 ? round(netAnnual / params.curtailable_mw, 0) : 0,
    },
    cliff: {
      floor_pct: DR_COMPLIANCE_FLOOR * 100,
      note: `Delivering between ${DR_COMPLIANCE_FLOOR * 100}% and 100% of a scheduled reduction earns no payment at all — there is no pro-rata settlement. Below ${DR_COMPLIANCE_FLOOR * 100}% a penalty applies, with a floor of S$5,000. Model your realistic delivery rate above rather than assuming perfect performance.`,
    },
    upside: {
      annual_sgd: round(upsideAnnual, 0),
      note: `If every half hour that traded at or above the trigger were called at the observed incentive rate, curtailment of ${params.curtailable_mw} MW would be worth about ${Math.round(upsideAnnual).toLocaleString("en-SG")} SGD a year. This is a ceiling, not a forecast: DR is called on system need, not on price alone.`,
    },
    parameters: params,
    assumptions,
    explanation:
      effectiveRate > 0
        ? `Real market data shows ${lcpPeriods.length} settled curtailment periods in ${windowDays} days. At ${params.curtailable_mw} MW committed for ${params.event_hours} h per activation, that annualises to about ${Math.round(netAnnual).toLocaleString("en-SG")} SGD net. Note how small this is relative to an energy bill — DR is a marginal credit for most sites, not a procurement strategy.`
        : `No curtailment has been called in this window, so no revenue can be evidenced. That is the normal case: in 2026 to date only a small fraction of periods settled a non-zero curtailment price. Treat any DR revenue projection that assumes frequent calls with scepticism.`,
  };
}

/** Real ancillary price history plus the DR trigger, for charting. */
export function ancillarySeries(periods: MarketPeriod[], maxPoints = 400) {
  const rows = periods.filter((p) => p.contingency_reserve !== null);
  const step = Math.max(1, Math.floor(rows.length / maxPoints));
  const out: {
    ts: string;
    contingency: number | null;
    primary: number | null;
    regulation: number | null;
    mapt: number | null;
    lcp: number | null;
  }[] = [];
  for (let i = 0; i < rows.length; i += step) {
    out.push({
      ts: rows[i].ts,
      contingency: rows[i].contingency_reserve,
      primary: rows[i].primary_reserve,
      regulation: rows[i].regulation,
      mapt: rows[i].mapt,
      lcp: rows[i].lcp,
    });
  }
  return out;
}
