/**
 * Strike — operational CLI.
 *
 *   node src/cli.ts sync [--days 90] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *   node src/cli.ts tariff [--lookback 12]
 *   node src/cli.ts probe                 # report status of every source
 *   node src/cli.ts status                # what is currently stored
 */
import { syncNems, pingNems, probeMandatedPackage, nemsStatus } from "./sources/usep.ts";
import { syncRegulatedTariff, storedTariffs } from "./sources/emaTariff.ts";
import { store } from "./store/index.ts";

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const SGT = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-SG", { timeZone: "Asia/Singapore" })
    : "—";

async function cmdSync() {
  const days = Number(arg("days", "90"));
  const from = arg("from");
  const to = arg("to");
  console.log(
    `Syncing NEMS market data${from ? ` from ${from}` : ` for last ${days} days`}${to ? ` to ${to}` : ""}...`
  );
  const r = await syncNems({ days, fromDate: from, toDate: to });
  console.log(JSON.stringify(r, null, 2));
  const s = await nemsStatus();
  console.log(
    `\nStored: ${s.count} periods, ${SGT(s.first)} .. ${SGT(s.last)}\nEMC last updated: ${s.emc_last_updated}`
  );
}

async function cmdTariff() {
  const lookback = Number(arg("lookback", "12"));
  const force = process.argv.includes("--force");
  const r = await syncRegulatedTariff(lookback, { force });
  console.log("Quarters probed :", r.quartersProbed);
  console.log("Quarters fetched:", r.quartersStored);
  console.log("Already present :", r.quartersSkipped, "(published quarters are final)");
  console.log("Unavailable     :", r.missing.join(", ") || "none");
  if (r.headline) {
    console.log(`\nEMA headline: ${r.headline.quote}`);
  } else {
    console.log(`\nEMA headline: unavailable (${r.headlineStatus})`);
    if (r.headlineNote) console.log(`  ${r.headlineNote}`);
  }
  console.log("\nReconciliation  :", r.reconciliationDetail);
  console.log("\nStored quarters:");
  for (const t of await storedTariffs()) {
    console.log(
      `  ${t.quarter}  total ${t.total_c.toFixed(2)} c/kWh  ` +
        `(energy ${t.energy_c?.toFixed(2)}, network ${t.network_c?.toFixed(2)}, ` +
        `mss ${t.mss_c?.toFixed(2)}, pso ${t.pso_c?.toFixed(2)})`
    );
  }
}

async function cmdProbe() {
  console.log("=== NEMS feed (live) ===");
  const p = await pingNems();
  console.log(`  ok=${p.ok} http=${p.httpStatus} periods=${p.periods}\n  ${p.detail}`);

  console.log("\n=== Spec-mandated energy-trading-api 0.0.34 ===");
  const m = await probeMandatedPackage();
  console.log(`  ran=${m.ran} usable=${m.available}\n  ${m.verdict}`);
  if (m.reason) console.log(`  reason: ${m.reason}`);

  console.log("\n=== Regulated tariff ===");
  const t = await store.latestTariff();
  console.log(
    t
      ? `  latest stored ${t.quarter}: ${t.total_c.toFixed(2)} c/kWh ex-GST from ${t.source_url}`
      : "  nothing stored"
  );
}

async function cmdStatus() {
  const s = await nemsStatus();
  console.log("Market data  :", `${s.count} half-hour periods`);
  console.log("  range      :", `${SGT(s.first)} .. ${SGT(s.last)}`);
  console.log("  span days  :", s.span_days);
  console.log("  age hours  :", s.age_hours, s.stale ? "(STALE)" : "(fresh)");
  console.log("  last run   :", s.last_run_status);
  const t = await store.latestTariff();
  console.log(
    "Tariff       :",
    t ? `${t.quarter} ${t.total_c.toFixed(2)} c/kWh ex-GST` : "nothing stored"
  );
}

const cmd = process.argv[2];
const table: Record<string, () => Promise<void> | void> = {
  sync: cmdSync,
  tariff: cmdTariff,
  probe: cmdProbe,
  status: cmdStatus,
};

const fn = table[cmd];
if (!fn) {
  console.error("Usage: node src/cli.ts <sync|tariff|probe|status> [options]");
  process.exit(2);
}
await fn();
