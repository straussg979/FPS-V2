// Checks behind the launchers (start.cmd, start.sh). Plain JavaScript, so it runs before `npm install`.
//   node scripts/preflight.mjs --deps        Node.js version, installed and up-to-date dependencies, native modules
//                                            exit 0 = ready, 10 = run `npm install`, 1 = cannot continue
//   node scripts/preflight.mjs --port        prints the port to use: PORT from .env (default 5000), or the next free
//                                            one if something else listens there (messages go to stderr)
//   node scripts/preflight.mjs --open PORT   waits until the server answers /healthz, then opens the browser
//                                            (skipped with COLD_SECTOR_NO_BROWSER=1)

import { exec } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const say = (m) => process.stderr.write(`${m}\n`);
const arg = process.argv[2];

function env() {
  const out = { ...process.env };
  try {
    for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !(m[1] in process.env)) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* no .env: defaults */ }
  return out;
}

function deps() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) {
    say(`Node.js ${process.versions.node} is too old: COLD SECTOR needs Node.js 22 or newer (https://nodejs.org/).`);
    return 1;
  }
  say(`[ok] Node.js ${process.versions.node}`);
  const modules = path.join(ROOT, "node_modules");
  const stamp = path.join(modules, ".package-lock.json");
  if (!fs.existsSync(stamp)) { say("[..] dependencies are not installed yet"); return 10; }
  if (fs.statSync(path.join(ROOT, "package-lock.json")).mtimeMs > fs.statSync(stamp).mtimeMs + 1000) {
    say("[..] package-lock.json changed since the last install");
    return 10;
  }
  const require = createRequire(path.join(ROOT, "server", "package.json"));
  for (const m of ["fastify", "ws", "three", "vite", "tsx", "drizzle-orm", "better-sqlite3", "@node-rs/argon2"]) {
    try {
      const mod = require(m);
      if (m === "better-sqlite3") new mod(":memory:").close();           // the native part loads and works
      if (m === "@node-rs/argon2" && typeof mod.hash !== "function") throw new Error("no hash()");
    } catch (e) {
      say(`[..] ${m} is missing or broken (${String(e.message).split("\n")[0]})`);
      return 10;
    }
  }
  say("[ok] dependencies installed");
  return 0;
}

function free(host, port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

async function port() {
  const e = env();
  const host = e.HOST || "127.0.0.1", want = Number(e.PORT || 5000);
  if (await free(host, want)) { process.stdout.write(`${want}\n`); return 0; }
  for (let p = want + 1; p < want + 100; p++) {
    if (await free(host, p)) {
      say(`[!!] port ${want} is in use by another program; using ${p} this time (set PORT in .env to choose).`);
      process.stdout.write(`${p}\n`);
      return 0;
    }
  }
  say(`[!!] no free port near ${want}`);
  return 1;
}

async function open(p) {
  if (process.env.COLD_SECTOR_NO_BROWSER === "1") return 0;
  const url = `http://127.0.0.1:${p}/`;
  const until = Date.now() + 10 * 60 * 1000;                // the first start builds for about a minute
  while (Date.now() < until) {
    try {
      const r = await fetch(`${url}healthz`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const cmd = process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd);
  return 0;
}

const code = arg === "--deps" ? deps() : arg === "--port" ? await port() : arg === "--open" ? await open(process.argv[3] || "5000") : 1;
process.exit(code);
