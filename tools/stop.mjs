/**
 * Stop a detached Strike server started by tools/serve-detached.mjs.
 *   node tools/stop.mjs
 */
import fs from "node:fs";
import path from "node:path";

const pidFile = path.resolve(process.cwd(), "data", "server.pid");

if (!fs.existsSync(pidFile)) {
  console.log("No data/server.pid found — nothing to stop.");
  process.exit(0);
}

const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
if (!Number.isFinite(pid)) {
  console.log("server.pid does not contain a valid pid.");
  process.exit(1);
}

try {
  process.kill(pid);
  fs.rmSync(pidFile, { force: true });
  console.log(`Stopped Strike server (pid ${pid}).`);
} catch (err) {
  console.log(
    `Could not stop pid ${pid}: ${err instanceof Error ? err.message : String(err)}`
  );
  fs.rmSync(pidFile, { force: true });
}
