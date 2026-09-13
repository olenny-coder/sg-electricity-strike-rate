/**
 * Detached launcher for the Strike server.
 *
 * Why this exists: a server started as a child of an agent turn is killed when
 * that turn ends, which is fine for a one-off test and useless for something the
 * user is meant to open in a browser. This spawns node fully detached (its own
 * process group, stdio redirected to a log file) so the app stays up.
 *
 *   node tools/serve-detached.mjs [port]
 *
 * Stop it with:  node tools/stop.mjs      (or kill the pid in data/server.pid)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const port = process.argv[2] ?? process.env.PORT ?? "8791";
const logDir = path.join(root, "data");
fs.mkdirSync(logDir, { recursive: true });

const out = fs.openSync(path.join(logDir, "server.log"), "a");
const err = fs.openSync(path.join(logDir, "server.err.log"), "a");

const child = spawn(
  process.execPath,
  ["--disable-warning=ExperimentalWarning", path.join(root, "src", "server.ts")],
  {
    cwd: root,
    detached: true,
    // Redirect rather than the default pipe: pipes would tie the child to this
    // process and it would die with us.
    stdio: ["ignore", out, err],
    windowsHide: true,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
  }
);

child.unref();
fs.writeFileSync(path.join(logDir, "server.pid"), String(child.pid));

console.log(`Strike server launched detached (pid ${child.pid})`);
console.log(`  URL  : http://127.0.0.1:${port}`);
console.log(`  log  : data/server.log`);
console.log(`  pid  : data/server.pid`);
