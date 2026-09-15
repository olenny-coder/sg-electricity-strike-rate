/**
 * End-to-end smoke test.
 *
 * Boots the real server against a throwaway, EMPTY database and asserts the
 * contract the client depends on. Run locally with `npm run test:smoke`.
 *
 * WHY THIS REPLACED TWO INLINE SHELL STEPS
 * ----------------------------------------
 * CI previously did this with two separate `run:` blocks, each starting a server
 * in the background with `&` and relying on a `trap` to kill it. That had three
 * problems:
 *
 *   1. A second server on the same port races the first one's shutdown, so the
 *      second step fails with EADDRINUSE depending on timing.
 *   2. The assertions used nested quoting inside YAML, which is exactly the kind
 *      of thing that silently mis-parses.
 *   3. None of it could be run locally, because a developer machine already has
 *      data, so the empty-state assertion would fail.
 *
 * STRIKE_DATA_DIR solves the third problem: the server is pointed at a fresh
 * temporary directory, so the database is genuinely empty and the empty-state
 * contract is deterministic in both environments.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.SMOKE_PORT ?? 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = process.cwd();

let failures = 0;
const pass = (label, detail = "") =>
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
const fail = (label, detail = "") => {
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  failures++;
};

/* ---------------- isolation ---------------- */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "strike-smoke-"));
const logFile = path.join(dataDir, "server.log");
const out = fs.openSync(logFile, "w");

function cleanup() {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

const server = spawn(
  process.execPath,
  ["--disable-warning=ExperimentalWarning", path.join(ROOT, "src", "server.ts")],
  {
    cwd: ROOT,
    // Redirect to a file rather than the default pipe. A piped stdio would tie
    // the child to this process and can fail outright under process confinement.
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      STRIKE_DATA_DIR: dataDir,
      LOG_LEVEL: "warn",
      // Deliberately unset so the run does not depend on a database being
      // reachable, and so the SQLite path is exercised.
      DATABASE_URL: "",
      CRON_SECRET: "",
    },
  }
);

let exited = null;
server.on("exit", (code) => {
  exited = code ?? 0;
});

async function shutdown() {
  if (exited === null) {
    server.kill();
    // Give it a moment, then stop caring.
    await new Promise((r) => setTimeout(r, 500));
    if (exited === null) server.kill("SIGKILL");
  }
  try {
    fs.closeSync(out);
  } catch {
    /* already closed */
  }
}

async function get(pathname) {
  const res = await fetch(`${BASE}${pathname}`);
  return { status: res.status, body: await res.text() };
}

/* ---------------- wait for readiness ---------------- */

console.log(`Booting server on ${BASE} with an empty database...`);

let ready = false;
for (let i = 0; i < 60; i++) {
  if (exited !== null) break;
  try {
    const r = await fetch(`${BASE}/api/health`);
    if (r.ok) {
      ready = true;
      break;
    }
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 500));
}

if (!ready) {
  console.log("\nServer did not become ready. Log follows:\n");
  try {
    console.log(fs.readFileSync(logFile, "utf8"));
  } catch {
    /* nothing to show */
  }
  await shutdown();
  cleanup();
  console.log("SMOKE TEST FAILED (server never became ready)");
  process.exit(1);
}
pass("server boots and answers /api/health");

/* ---------------- assertions ---------------- */

console.log("\nContract:");

// 1. Health reports the storage driver.
const health = JSON.parse((await get("/api/health")).body);
if (health.ok === true && typeof health.storage_durable === "boolean") {
  pass("health reports storage driver and durability", `driver=${health.storage.driver}`);
} else {
  fail("health reports storage driver and durability", JSON.stringify(health).slice(0, 120));
}

// 2. The empty-state contract. This is the important one: with no data the API
//    must say so plainly rather than serving zeroes that look like real prices.
const dash = JSON.parse(
  (await get("/api/dashboard?days=90&mwh=4000&alpha=1.4&curtailable_mw=1")).body
);
if (dash.ready === false) {
  pass("dashboard refuses to fabricate data when empty");
} else {
  fail("dashboard refuses to fabricate data when empty", `ready=${dash.ready}`);
}
if (typeof dash.reason === "string" && dash.reason.length > 20) {
  pass("dashboard explains why it has nothing to show", `"${dash.reason.slice(0, 60)}..."`);
} else {
  fail("dashboard explains why it has nothing to show", String(dash.reason));
}

// 3. The client is served, and SPA deep links resolve to it.
const root = await get("/");
if (root.status === 200 && root.body.includes('id="root"')) {
  pass("client shell is served at /");
} else {
  fail("client shell is served at /", `HTTP ${root.status}`);
}
const deep = await get("/some/deep/link");
if (deep.status === 200 && deep.body.includes('id="root"')) {
  pass("SPA deep links fall back to the shell");
} else {
  fail("SPA deep links fall back to the shell", `HTTP ${deep.status}`);
}

// 4. Unknown API routes 404 as JSON rather than returning HTML.
const missing = await get("/api/does-not-exist");
if (missing.status === 404 && missing.body.includes("error")) {
  pass("unknown API routes return JSON 404, not the SPA");
} else {
  fail("unknown API routes return JSON 404, not the SPA", `HTTP ${missing.status}`);
}

// 5. Source provenance is exposed.
const sources = JSON.parse((await get("/api/sources")).body);
if (Array.isArray(sources.sources) && sources.sources.length >= 3) {
  pass("source registry is exposed", `${sources.sources.length} sources`);
} else {
  fail("source registry is exposed");
}

// 6. The ingestion endpoint must refuse when no secret is configured, so it can
//    never act as an open trigger for unbounded outbound fetching.
const cron = await get("/api/cron/sync");
if (cron.status === 503 || cron.status === 401) {
  pass("scheduled-ingestion endpoint refuses without a secret", `HTTP ${cron.status}`);
} else {
  fail("scheduled-ingestion endpoint refuses without a secret", `HTTP ${cron.status}`);
}

/* ---------------- teardown ---------------- */

await shutdown();
cleanup();

console.log(
  failures === 0
    ? "\nSMOKE TEST PASSED"
    : `\nSMOKE TEST FAILED (${failures} assertion(s))`
);
process.exit(failures === 0 ? 0 : 1);
