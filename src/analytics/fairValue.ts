/**
 * Fair value reference price.
 *
 * WHAT "FAIR VALUE" MEANS HERE, AND WHY IT IS DEFENSIBLE
 * -----------------------------------------------------
 * In commodity markets, fair value is the price at which supply is economic over
 * the long run — not a prediction, and not an average of recent prices. For
 * electricity in Singapore that is the long-run marginal cost (LRMC) of new
 * combined-cycle gas turbine capacity, because CCGTs serve the overwhelming
 * majority of demand.
 *
 * This module builds the reference from two INDEPENDENT published anchors, both
 * already ingested from official sources. Nothing is assumed:
 *
 *   1. LRMC derived from the Temporary Price Cap.
 *      EMC publishes the TPC energy price each half hour as a column in the EGO
 *      feed (MAPT). EMA sets the cap at a multiple of the CCGT LRMC, and the
 *      multiple in force is 3x, so LRMC = MAPT / 3. This is a real, per-period
 *      number, averaged over the analysis window.
 *
 *   2. The regulated tariff's energy component.
 *      EMA publishes it each quarter, set from lagged natural gas prices — the
 *      actual cost of the fuel that generates the electricity.
 *
 * The two are computed by different organisations from different inputs by
 * different methods. When they agree, the reference is well corroborated; when
 * they diverge, the spread between them is itself informative and is shown
 * rather than averaged away.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is not a forecast, and not a price you can transact at. It is the level
 * against which a quoted price can be judged cheap or dear. A contract below
 * fair value is not automatically a good deal — the retailer may be pricing in
 * something you have not seen — but a contract materially ABOVE it deserves a
 * direct question about why.
 *
 * A third anchor, the vesting contract Base Vesting Price, would strengthen this
 * further. It is not included because it is not ingested, and inventing it would
 * defeat the purpose.
 */
import type { MarketPeriod } from "../store/types.ts";
import { mean, round } from "./time.ts";

/** EMA's cap multiple over CCGT LRMC, verified from the published parameters. */
const TPC_MULTIPLE = 3;

export interface FairValueInput {
  label: string;
  /** Energy-only reference, cents/kWh ex-GST. */
  value_c: number;
  /** How the number was obtained. */
  basis: string;
  source_url: string | null;
  /** How many real observations sit behind it. */
  observations: number;
}

export interface FairValueReference {
  energy_low_c: number;
  energy_reference_c: number;
  energy_high_c: number;
  /** Spread between anchors as a percentage of the reference. */
  anchor_spread_pct: number;
  all_in_reference_c: number;
  non_energy_c: number;
  inputs: FairValueInput[];
  market: {
    wholesale_all_in_c: number;
    regulated_all_in_c: number;
    /** Wholesale minus reference, in cents/kWh. */
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

/** "at" within this band, as a percentage either side of the reference. */
const AT_BAND_PCT = 7.5;

function classify(delta_pct: number): "below" | "at" | "above" {
  if (delta_pct > AT_BAND_PCT) return "above";
  if (delta_pct < -AT_BAND_PCT) return "below";
  return "at";
}

export function computeFairValue(args: {
  periods: MarketPeriod[];
  tariffEnergyC: number | null;
  tariffQuarter: string;
  tariffSourceUrl: string | null;
  nonEnergyC: number;
  wholesaleAllInC: number;
  regulatedAllInC: number;
}): FairValueReference | null {
  const { periods, tariffEnergyC, nonEnergyC } = args;

  /* ---- Anchor 1: LRMC implied by the published Temporary Price Cap ------ */
  const maptValues = periods
    .map((p) => p.mapt)
    .filter((v): v is number => v !== null && Number.isFinite(v) && v > 0);

  const lrmcUsdPerMwh = maptValues.length ? mean(maptValues) / TPC_MULTIPLE : null;
  // SGD/MWh -> cents/kWh is a divide by 10.
  const lrmcC = lrmcUsdPerMwh === null ? null : lrmcUsdPerMwh / 10;

  const inputs: FairValueInput[] = [];

  if (lrmcC !== null) {
    inputs.push({
      label: "Long-run marginal cost of a CCGT",
      value_c: round(lrmcC, 2),
      basis: `Derived from EMC's published Temporary Price Cap energy price (MAPT), which is set at ${TPC_MULTIPLE}x the CCGT long-run marginal cost. MAPT averaged ${mean(maptValues).toFixed(2)} S$/MWh across ${maptValues.length.toLocaleString()} real half-hour periods, so LRMC = MAPT / ${TPC_MULTIPLE}.`,
      source_url: null,
      observations: maptValues.length,
    });
  }

  /* ---- Anchor 2: the regulated tariff's energy component ---------------- */
  if (tariffEnergyC !== null) {
    inputs.push({
      label: `Regulated tariff energy component (${args.tariffQuarter})`,
      value_c: round(tariffEnergyC, 2),
      basis:
        "Published directly by EMA as part of the quarterly tariff breakdown, set from the average daily natural gas price over the first 2.5 months of the preceding quarter. This is the actual fuel cost of supply, lagged by design.",
      source_url: args.tariffSourceUrl,
      observations: 1,
    });
  }

  if (!inputs.length) return null;

  const values = inputs.map((i) => i.value_c);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const reference = mean(values);
  const spread = reference > 0 ? ((high - low) / reference) * 100 : 0;
  const allIn = reference + nonEnergyC;

  const wholesalePremium = args.wholesaleAllInC - allIn;
  const regulatedPremium = args.regulatedAllInC - allIn;
  const wholesalePct = allIn > 0 ? (wholesalePremium / allIn) * 100 : 0;
  const regulatedPct = allIn > 0 ? (regulatedPremium / allIn) * 100 : 0;

  const corroboration =
    inputs.length >= 2
      ? `Two independent anchors: ${low.toFixed(2)} to ${high.toFixed(2)} c/kWh — a spread of ${spread.toFixed(1)}%. Computed by different organisations from different inputs, so their agreement is meaningful corroboration.`
      : "Only one anchor is available in the stored data, so the reference carries no independent corroboration. Widen the analysis window or sync the tariff to strengthen it.";

  const wv = classify(wholesalePct);
  const rv = classify(regulatedPct);

  const interpretation =
    wv === "above"
      ? `Wholesale is trading ${wholesalePct.toFixed(1)}% ABOVE the long-run cost of supply. Prices above fair value tend not to persist once new capacity or demand response responds, which argues against locking in a long contract at today's level.`
      : wv === "below"
        ? `Wholesale is trading ${Math.abs(wholesalePct).toFixed(1)}% BELOW the long-run cost of supply. Generation is not recovering its full cost at these levels, which is historically a favourable time to fix a price — but confirm the retailer is not pricing in something you have not seen.`
        : `Wholesale is trading within ${AT_BAND_PCT}% of the long-run cost of supply — broadly fair value. Neither fixing nor floating has a clear structural advantage, so the decision should turn on your risk appetite and the quoted spreads.`;

  const caveats = [
    "Fair value is an economic reference, not a tradeable price. No market participant is obliged to transact at it.",
    "The LRMC anchor is derived from a cap that EMA reviews, so the multiple can change; the derivation is stated above so you can see exactly what was assumed.",
    "The tariff energy anchor is deliberately lagged by about 2.5 months, so it reflects the fuel market as it was, not as it is. During a fast move in gas prices the two anchors will legitimately diverge.",
    "Vesting contract reference prices would be a useful third anchor. They are not included because they are not ingested, and estimating them would make the reference less trustworthy, not more.",
  ];

  return {
    energy_low_c: round(low, 2),
    energy_reference_c: round(reference, 2),
    energy_high_c: round(high, 2),
    anchor_spread_pct: round(spread, 1),
    all_in_reference_c: round(allIn, 2),
    non_energy_c: round(nonEnergyC, 2),
    inputs,
    market: {
      wholesale_all_in_c: round(args.wholesaleAllInC, 2),
      regulated_all_in_c: round(args.regulatedAllInC, 2),
      wholesale_premium_c: round(wholesalePremium, 2),
      wholesale_premium_pct: round(wholesalePct, 1),
      regulated_premium_c: round(regulatedPremium, 2),
      regulated_premium_pct: round(regulatedPct, 1),
      wholesale_verdict: wv,
      regulated_verdict: rv,
    },
    corroboration,
    interpretation,
    caveats,
  };
}
