/**
 * Initial backfill against a hosted Postgres database (Neon).
 *
 * WHY THIS EXISTS
 * ---------------
 * Setting DATABASE_URL by hand is where this deployment reliably goes wrong, and
 * the failure modes are all silent or confusing:
 *
 *   - `set DATABASE_URL=...` is cmd.exe syntax; PowerShell needs `$env:DATABASE_URL`.
 *   - The URL contains `&`, which ends a command in cmd.exe and starts a YAML
 *     anchor in a .env or render.yaml.
 *   - If the variable does not reach the process, the app does not crash: it
 *     quietly falls back to local SQLite, backfills 59,000 rows into a file that
 *     vanishes on the next restart, and reports success.
 *
 * So this script validates before it writes anything, refuses to touch SQLite,
 * redacts the password in every message, and tells you which shell syntax to use
 * if the variable is missing.
 *
 *   npm run backfill
 *   npm run backfill -- --from 2023-05-05
 */
import { syncNems } from "../src/sources/usep.ts";
import { syncRegulatedTariff } from "../src/sources/emaTariff.ts";
import { seedPublishedOffers } from "../src/seed.ts";
import { store, DRIVER, storageDescription } from "../src/store/index.ts";

const redact = (s) => s.replace(/:\/\/([^:]+):[^@]*@/, "://$1:***@");

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const url = process.env.DATABASE_URL;

console.log("=".repeat(72));
console.log("  Strike — backfill to hosted Postgres");
console.log("=".repeat(72));
console.log();

/* ---------------- 1. Is the variable set at all? ---------------- */

if (!url) {
  console.error("  DATABASE_URL is not set in this shell, so there is nothing to");
  console.error("  write to. Refusing to run rather than silently filling a local");
  console.error("  SQLite file that would be lost on the next restart.\n");
  console.error("  Use the syntax for the shell you are actually in:\n");
  console.error("    PowerShell:");
  console.error('      $env:DATABASE_URL = "postgresql://user:pass@host/db?sslmode=require"');
  console.error();
  console.error("    cmd.exe  (no quotes — the & will otherwise end the command):");
  console.error("      set DATABASE_URL=postgresql://user:pass@host/db?sslmode=require");
  console.error();
  console.error("  Then confirm it took, before running this again:");
  console.error("      PowerShell: $env:DATABASE_URL");
  console.error("      cmd.exe:    echo %DATABASE_URL%");
  process.exit(1);
}

/* ---------------- 2. Does it look like a real Postgres URL? ---------------- */

let parsed;
try {
  parsed = new URL(url);
} catch {
  console.error(`  DATABASE_URL is not a parseable URL: ${redact(url)}\n`);
  console.error("  This is usually the '&' being eaten by the shell. If the value was");
  console.error("  set from a command line, quote it, or drop the '&channel_binding'");
  console.error("  parameter entirely — it is optional for this app.");
  process.exit(1);
}

if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
  console.error(`  DATABASE_URL does not look like a Postgres URL: ${redact(url)}`);
  process.exit(1);
}

const params = [...parsed.searchParams.keys()];
const isPooled = parsed.hostname.includes("-pooler");

console.log("  Connection:");
console.log(`    host       ${parsed.hostname}`);
console.log(`    database   ${parsed.pathname.replace(/^\//, "")}`);
console.log(`    user       ${parsed.username}`);
console.log(`    params     ${params.length ? params.join(", ") : "(none)"}`);
console.log(`    endpoint   ${isPooled ? "pooled (PgBouncer)" : "direct"}`);
console.log();

if (!params.includes("sslmode")) {
  console.log("  note: no sslmode in the URL. Neon requires TLS; this app forces it");
  console.log("        regardless, so this is fine.\n");
}

if (isPooled) {
  console.log("  note: this is the POOLED endpoint. It works, and is the right choice");
  console.log("        for the web service. For a large one-off backfill Neon recommends");
  console.log("        the DIRECT hostname (no '-pooler') to avoid pool contention.");
  console.log("        Harmless to continue — just slightly slower.\n");
}

/* ---------------- 3. Did the driver actually select Postgres? ---------------- */

if (DRIVER !== "postgres") {
  console.error(`  Refusing to run: the store selected '${DRIVER}', not 'postgres'.`);
  console.error("  That should be impossible after the checks above, so something is");
  console.error("  wrong with how the variable reached this process.");
  process.exit(1);
}

const storage = storageDescription();
console.log(`  Store      ${storage.driver} -> ${storage.target}`);
console.log(`  Durable    ${storage.durable ? "yes" : "NO"}`);
if (storage.warning) console.log(`  Warning    ${storage.warning}`);
console.log();

/* ---------------- 4. Can we actually connect? ---------------- */

console.log("  Testing connection...");
try {
  const range = await store.marketRange();
  console.log(`  Connected. Currently ${range.n.toLocaleString()} market periods stored.`);
  if (range.hi) console.log(`  Newest stored period: ${range.hi}`);
  console.log();
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`  Connection FAILED: ${msg.split("\n")[0]}\n`);
  if (/password authentication/i.test(msg)) {
    console.error("  The credentials were rejected. If you reset the Neon password,");
    console.error("  the URL in this shell still holds the old one — set it again.");
  } else if (/ENOTFOUND|getaddrinfo/i.test(msg)) {
    console.error("  The hostname did not resolve. Check the endpoint id is complete;");
    console.error("  Neon hostnames look like ep-xxx-pooler.c-4.<region>.aws.neon.tech.");
  } else if (/self.signed|certificate/i.test(msg)) {
    console.error("  TLS problem. Try adding &sslmode=verify-full or removing other ssl params.");
  }
  process.exit(1);
}

/* ---------------- 5. Load the data ---------------- */

const from = arg("from", "2023-05-05");

console.log("=".repeat(72));
console.log("  Loading data — this takes a couple of minutes");
console.log("=".repeat(72));
console.log();

console.log("[1/3] Regulated tariff from EMA...");
const tariff = await syncRegulatedTariff(12, { force: false });
console.log(
  `      ${tariff.quartersStored} fetched, ${tariff.quartersSkipped} already present, ` +
    `${tariff.missing.length} unavailable`
);
console.log(`      ${tariff.reconciliationDetail}`);
console.log();

console.log(`[2/3] Market data from EMC, from ${from} to today...`);
const market = await syncNems({ fromDate: from });
console.log(`      ${market.periodsStored.toLocaleString()} half-hour periods in ${market.requests} requests`);
console.log(`      status: ${market.status}${market.error ? ` — ${market.error}` : ""}`);
console.log();

console.log("[3/3] Published retailer rates (anchor quotes)...");
await seedPublishedOffers();
const offers = await store.listOffers();
console.log(`      ${offers.length} offers loaded`);
console.log();

/* ---------------- 6. Confirm what is actually stored ---------------- */

const after = await store.marketRange();
console.log("=".repeat(72));
console.log("  Done");
console.log("=".repeat(72));
console.log(`  Market periods : ${after.n.toLocaleString()}`);
console.log(`  Range          : ${after.lo ?? "—"} to ${after.hi ?? "—"}`);
console.log(`  Tariff quarters: ${(await store.listTariffs()).length}`);
console.log(`  Fixed offers   : ${offers.length}`);
console.log();
console.log("  Next: open your Render URL and check that the dashboard is populated,");
console.log("  and that /api/health reports \"storage_durable\":true");
console.log();

process.exit(0);
