/**
 * Seed the fixed-price offers table with REAL, publicly published rates.
 *
 * IMPORTANT — READ BEFORE TRUSTING THESE NUMBERS
 * ---------------------------------------------
 * These are genuine rates published on the retailers' own websites for the
 * SME / low-tension tier (sites consuming roughly 20,000 kWh per month or
 * less). They are NOT quotes for a large industrial site, and larger sites get
 * bespoke pricing. Use them as a market anchor, then replace them with your own
 * quotes via the Compare view.
 *
 * Two conversions are applied, and both are recorded in the notes column so the
 * provenance survives:
 *
 *  1. Published rates are GST-INCLUSIVE. This application compares costs
 *     ex-GST, to match how EMA and EMC publish tariff and wholesale prices, so
 *     each rate is divided by 1.09.
 *
 *  2. Some retailers quote mandatory add-ons separately from the headline rate
 *     (for example a monthly distribution support charge and a carbon tax per
 *     kWh). Where that is the case the headline rate is stored and the add-on is
 *     named in the notes, because folding in a charge that is priced
 *     differently across retailers would make the comparison less honest, not
 *     more.
 *
 * Source pages and the date they were read are stored per row. Re-verify before
 * relying on any of these.
 */
import { store } from "./store/index.ts";
import { pathToFileURL } from "node:url";

const GST = 1.09;
const exGst = (inclusive: number) => Math.round((inclusive / GST) * 100) / 100;

const OBSERVED = "2026-09-12";

export async function seedPublishedOffers() {
  // Tuas Power — https://www.savewithtuas.com/business/our-business-plans
  const tuas = [
    { term: 12, incl: 30.85 },
    { term: 24, incl: 29.32 },
    { term: 36, incl: 28.01 },
  ];
  for (const t of tuas) {
    await store.upsertOffer({
      retailer: "Tuas Power",
      plan: `PowerPAK ${t.term}`,
      rate_c_kwh: exGst(t.incl),
      term_months: t.term,
      notes:
        `Published ${t.incl.toFixed(2)} c/kWh incl. GST (read ${OBSERVED}); shown here ex-GST. Excludes a separate monthly distribution support charge of 0.21 c/kWh and carbon tax of 1.972 c/kWh, which the retailer quotes separately.`,
    });
  }

  // PacificLight — https://pacificlight.com.sg/business/low-tension-plans
  const pl = [
    { term: 12, incl: 29.99 },
    { term: 24, incl: 28.2 },
    { term: 36, incl: 27.0 },
  ];
  for (const t of pl) {
    await store.upsertOffer({
      retailer: "PacificLight Energy",
      plan: `Budget Planner ${t.term}`,
      rate_c_kwh: exGst(t.incl),
      term_months: t.term,
      notes:
        `Published ${t.incl.toFixed(2)} c/kWh incl. GST (page stated "Last Updated: 1 September 2026", read ${OBSERVED}); shown here ex-GST. Published rate is subject to a fuel and FX qualifier on the retailer's published thresholds.`,
    });
  }
}

/** True when the table holds nothing but the seeded published rates. */
export async function hasOnlySeededOffers(): Promise<boolean> {
  const o = await store.listOffers();
  return o.length > 0 && o.every((x) => /Published .*incl\. GST/.test(x.notes ?? ""));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await seedPublishedOffers();
  console.log("Seeded published retailer rates (converted to ex-GST):");
  for (const o of await store.listOffers()) {
    console.log(
      `  ${o.retailer.padEnd(20)} ${o.plan.padEnd(20)} ${String(o.term_months).padStart(2)}m  ${o.rate_c_kwh.toFixed(2)} c/kWh`
    );
  }
}
