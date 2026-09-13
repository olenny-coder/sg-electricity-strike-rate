/**
 * Market facts — structural and regulatory context for Singapore's electricity
 * market, each entry carrying its source and verification state.
 *
 * These are NOT prices. Prices live in the database, ingested from live feeds.
 * This file holds the stable context a commercial buyer needs to interpret
 * those prices: how the market is structured, what the tariff is built from,
 * what the retail options actually are, and how Demand Response works.
 *
 * `verified` means the claim was checked against the cited source during this
 * build. Anything not verified is marked so and should not be relied upon.
 */

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

const EMA_TARIFF_PAGE =
  "https://www.ema.gov.sg/consumer-information/electricity/buying-electricity/buying-at-regulated-tariff";
const EMA_RETAILER_PAGE =
  "https://www.ema.gov.sg/consumer-information/electricity/buying-electricity/buying-from-a-retailer";
const EMA_BESS_DR =
  "https://www.ema.gov.sg/content/dam/corporate/partnerships/consultations/enabling-eg-participation-in-demand-response-interruptible-load-programmes/decision/EMA-Consultations-Final-Determination-Enabling-BESS-Participation-in-DR-IL-20241021.pdf.coredownload.pdf";
const EMC_DR_IL_PROC =
  "https://www.home.emcsg.com/-/media/Market-Administration/Registration/Facility-Registration/LRF/Implementation-Procedures-for-DR--IL-Post-Sandbox_for-publishing.pdf";
const NEMS_PRICES = "https://www.nems.emcsg.com/nems-prices";

export const MARKET_FACTS: MarketFactSheet = {
  generated_at: new Date().toISOString(),
  disclaimer:
    "Structural context compiled from the cited official sources. These are descriptions of how the market works, not price quotes. Verify current programme terms with EMA or your aggregator before committing capital.",
  groups: [
    {
      id: "tariff",
      title: "How the regulated tariff is set",
      intro:
        "The regulated tariff is the default option. It is set by SP Group and regulated by EMA, and revised quarterly. Understanding its formula matters because it is the benchmark every contract competes against.",
      facts: [
        {
          label: "Review frequency",
          value: "Quarterly",
          detail: "The rate is revised every quarter to reflect fuel and production costs.",
          source_url: EMA_TARIFF_PAGE,
          verified: true,
        },
        {
          label: "Fuel-cost basis",
          value: "Average daily natural gas prices over the first 2.5 months of the preceding quarter",
          detail:
            "EMA's example: the average of daily gas prices from 1 January to 15 March sets the tariff for April to June. This deliberately lags spot prices, which is why global gas moves take time to reach your bill — and why a fast gas spike is a genuine reason to lock in before the next revision.",
          source_url: EMA_TARIFF_PAGE,
          verified: true,
        },
        {
          label: "Cost components",
          value: "Fuel, network costs, market support services fee, market administration and power system operation fee, power generation cost",
          detail:
            "Fuel costs are the largest portion. Network and MSS fees are paid to SP Group; the market administration and PSO fee is paid to EMC and the Power System Operator.",
          source_url: EMA_TARIFF_PAGE,
          verified: true,
        },
        {
          label: "GST",
          value: "Published rates exclude GST; add 9% for the amount actually payable",
          detail:
            "This application works entirely in ex-GST terms to match how EMA and EMC publish prices.",
          source_url: EMA_TARIFF_PAGE,
          verified: true,
        },
      ],
    },
    {
      id: "wholesale",
      title: "The wholesale market and USEP",
      intro:
        "Large buyers can choose to be exposed to the wholesale spot price instead of a fixed or regulated rate. That is a risk decision, not just a price decision.",
      facts: [
        {
          label: "Wholesale price",
          value: "USEP — Uniform Singapore Energy Price, set every half hour",
          detail:
            "USEP is the spot price for energy in the Singapore Wholesale Electricity Market, published in SGD/MWh. It is the price a wholesale-exposed buyer pays for energy, before network, MSS and market fees.",
          source_url: NEMS_PRICES,
          verified: true,
        },
        {
          label: "Non-energy charges still apply",
          value: "Network, MSS and market administration/PSO fees are payable on top of USEP",
          detail:
            "A wholesale-exposed buyer does not escape the non-energy components of the tariff. This application adds the real published components to USEP when computing an all-in wholesale cost.",
          source_url: EMA_TARIFF_PAGE,
          verified: true,
        },
        {
          label: "Price volatility",
          value: "USEP is materially more volatile than any contract rate",
          detail:
            "Real observed history in this deployment shows USEP ranging from negative values during oversupply to several thousand SGD/MWh during system stress. The exact figures depend on the window loaded, and are computed live in the Market view rather than quoted here.",
          source_url: NEMS_PRICES,
          verified: true,
        },
        {
          label: "Historic availability",
          value: "Half-hourly history is published roughly 3 years back",
          detail:
            "EMC documents a five-year rolling window, but the measured earliest available date during this build was 2023-05-05. Treat the window as moving and re-check if you need the oldest data.",
          source_url: NEMS_PRICES,
          verified: true,
        },
        {
          label: "Same-day figures are provisional",
          value: "EMC revises the current day, sometimes substantially",
          detail:
            "Measured directly during this build: the most recent stored day disagreed with EMC's later published figures across 12 of its 48 periods, by up to roughly 420 SGD/MWh, while every settled day back through 2025 matched exactly. A price you read today for today is not a final price. Ingestion therefore re-fetches an overlapping window on every run, so revisions are absorbed rather than frozen into the database.",
          source_url: NEMS_PRICES,
          verified: true,
        },
      ],
    },
    {
      id: "retail",
      title: "Retail contract structures",
      intro:
        "Business rates are quoted privately, so the app compares whatever quotes you load against the public benchmarks.",
      facts: [
        {
          label: "Standard price plans",
          value: "Fixed price, or discount-off-the-regulated-tariff",
          detail:
            "Standard plans are all-inclusive with no separate per-kWh fees, over 6, 12 or 24 months. The rate does not change during the contract.",
          source_url: EMA_RETAILER_PAGE,
          verified: true,
        },
        {
          label: "Non-standard price plans",
          value: "Rates may be non-inclusive and may vary during the contract",
          detail:
            "These may carry recurring charges or fees. EMA advises asking for a Fact Sheet and a Consumer Advisory before signing.",
          source_url: EMA_RETAILER_PAGE,
          verified: true,
        },
        {
          label: "Switching",
          value: "Not compulsory, and there is no deadline to switch",
          detail:
            "The retailer works with SP Group to make the switch. Watch contract duration, payment terms, security deposit, early termination charges and auto-renewal clauses.",
          source_url: EMA_RETAILER_PAGE,
          verified: true,
        },
        {
          label: "Rate transparency",
          value: "No public machine-readable feed of retailer business rates exists",
          detail:
            "EMA's comparison tool covers standard plans but exposes no open API. This is why fixed-price quotes are operator-entered with an explicit freshness stamp rather than scraped.",
          source_url: EMA_RETAILER_PAGE,
          verified: true,
        },
      ],
    },
    {
      id: "dr",
      title: "Demand Response and Interruptible Load",
      intro:
        "DR and IL let a site get paid for being willing to reduce load when the system is stressed. For the right site this is revenue from an asset you already own.",
      facts: [
        {
          label: "Programmes",
          value: "Demand Response (DR) and Interruptible Load (IL)",
          detail:
            "EMA supports participation by electricity consumers to increase system flexibility and grid resilience.",
          source_url: EMA_BESS_DR,
          verified: true,
        },
        {
          label: "Registered capacity",
          value: "Over 120 MW",
          detail:
            "Registered DR/IL capacity reached over 120 MW following the two-year regulatory sandbox launched in January 2023.",
          source_url: EMA_BESS_DR,
          verified: true,
        },
        {
          label: "Minimum capacity",
          value: "From 0.1 MW of curtailable load",
          detail:
            "A contestable consumer with at least 0.1 MW of curtailable load that can respond in roughly three minutes can participate — directly into NEMS, through a retailer, or through a DR aggregator. Aggregators bundle smaller sites, so a site below that threshold should approach an aggregator rather than assume it is ineligible. Separately, EMA's determination enables battery storage of 1 MW and above and below 10 MW, capped at 150 MW of BESS registered as DR/IL capacity.",
          source_url: EMA_BESS_DR,
          verified: true,
        },
        {
          label: "How compensation works",
          value: "One-third of the savings created, capped at S$4,500/MWh",
          detail:
            "Compensation is the load curtailment price (LCP) multiplied by the quantity curtailed. EMA states participants delivering in full receive one-third of the savings, capped at $4,500/MWh. The cap is not theoretical: EMC's published data shows LCP printing at exactly 4500.00 during stressed periods.",
          source_url: EMA_BESS_DR,
          verified: true,
        },
        {
          label: "What triggers a call",
          value: "USEP rising above roughly 1.5 times the long-run marginal cost of a CCGT",
          detail:
            "EMA describes DR as the first 'speed bump' when USEP exceeds 1.5x the LRMC of a combined-cycle gas turbine. The LRMC is republished by EMC as part of the Temporary Price Cap parameters, so the trigger level moves as fuel costs move.",
          source_url: NEMS_PRICES,
          verified: true,
        },
        {
          label: "Realised economics",
          value: "Participants averaged roughly S$2,400 to S$2,700 per MWh curtailed over 2023-2024",
          detail:
            "These are EMA's own reported figures for the sandbox period, and they are high because curtailment is only called during genuine system stress. Do not annualise them: they apply to the small number of periods actually activated.",
          source_url: EMA_BESS_DR,
          verified: true,
        },
        {
          label: "Compliance",
          value: "80% delivery threshold post-sandbox (was 95%)",
          detail:
            "Delivering 80-100% of a scheduled reduction attracts no payment and no penalty. Below 80% attracts a penalty of the greater of the deviation quantity valued at the prevailing price plus uplift, or S$5,000. Note the ancillary service penalty scheme still applies daily at the older 95% threshold, and reclaiming the difference requires a proactive refund request.",
          source_url: EMC_DR_IL_PROC,
          verified: true,
        },
        {
          label: "Registered DR capacity",
          value: "162 MW as of June 2025 (DR), 192 MW with Interruptible Load",
          detail:
            "DR capacity grew from 46 MW in 2022 to 162 MW by June 2025. In 2026 to date, only 298 of 11,808 half-hour periods cleared a non-zero curtailment price, which is the honest base rate for how often this actually pays.",
          source_url: EMA_BESS_DR,
          verified: true,
        },
        {
          label: "Why it is not universal",
          value: "Opportunity cost of curtailing is the main barrier",
          detail:
            "EMA states plainly that growing demand-side capacity through pure load curtailment is increasingly challenging because of the high opportunity costs for some consumers. Set a production-loss figure in the DR calculator or its output is optimistic.",
          source_url: EMA_BESS_DR,
          verified: true,
        },
        {
          label: "Revenue basis",
          value: "Ancillary service reserve clearing prices",
          detail:
            "The real half-hourly Contingency Reserve, Primary Reserve and Regulation clearing prices are ingested by this application and used directly in the DR estimate.",
          source_url: NEMS_PRICES,
          verified: true,
        },
        {
          label: "Interruptible Load is a different programme",
          value: "IL pays the contingency-reserve clearing price for standby, with no separate activation payment",
          detail:
            "Do not conflate the two. Interruptible Load dates from 2004 and pays for availability rather than for delivered curtailment; its sandbox conditions were discontinued on 1 January 2025. Both now sit under EMA's Demand-Side Flexibility Roadmap.",
          source_url: EMC_DR_IL_PROC,
          verified: true,
        },
      ],
    },
    {
      id: "retailers",
      title: "Who you can actually buy from",
      intro:
        "Twelve retailers are licensed for the Open Electricity Market. Rates are only published for the SME tier; larger sites must request a quote.",
      facts: [
        {
          label: "Licensed retailers",
          value:
            "Diamond Electric, Flo Energy, Geneco (Seraya Energy), Just Electric, Keppel Electric, MyElectricity, PacificLight Energy, Sembcorp Power, Senoko Energy Supply, Tuas Power Supply, Union Power, Shell Gas Marketing",
          detail:
            "As listed on the official Open Electricity Market business retailer directory. iSwitch and Ohm Energy no longer appear on that list.",
          source_url: "https://www.openelectricitymarket.sg/business/list-of-retailers",
          verified: true,
        },
        {
          label: "Published rates exist only for small sites",
          value:
            "Typically the low-tension tier, in the region of 20,000 kWh per month or below",
          detail:
            "PacificLight and Tuas Power publish printed rates for that tier; larger plans are quote-only. Every published retail rate observed during this build sat below the prevailing regulated tariff, which is the commercially important point.",
          source_url: "https://pacificlight.com.sg/business/low-tension-plans",
          verified: true,
        },
        {
          label: "Watch the add-ons",
          value: "Published rates may exclude charges that materially change the all-in price",
          detail:
            "Tuas Power's business rate is quoted alongside a separate monthly distribution support charge and a carbon tax per kWh. Annexes and third-party charges vary by retailer, so compare all-in cost, not the headline rate.",
          source_url: "https://www.savewithtuas.com/business/our-business-plans",
          verified: true,
        },
      ],
    },
  ],
  regulatory_links: [
    { label: "EMA — Buying at Regulated Tariff", url: EMA_TARIFF_PAGE },
    { label: "EMA — Buying from a Retailer", url: EMA_RETAILER_PAGE },
    { label: "EMC — NEMS market prices", url: NEMS_PRICES },
    {
      label: "EMA — Final Determination on BESS participation in DR/IL (Oct 2024)",
      url: EMA_BESS_DR,
    },
    { label: "EMC — DR & IL implementation procedures", url: EMC_DR_IL_PROC },
  ],
};
