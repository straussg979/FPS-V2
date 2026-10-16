// `npm run dev`: the game assets are built once if missing (as `npm start` does), then the browser client is
// rebuilt by Vite on every change and the server runs from its TypeScript sources, restarting on changes
// (match workers load their sources through tsx too). Reload the page to pick up client changes.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

function run(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [tsx, ...args], { cwd: ROOT, stdio: "inherit" });
    p.on("exit", (code) => resolve(code ?? 1));
  });
}

if ((await run(["scripts/build.ts", "--only=assets"])) !== 0) process.exit(1);
await build({ configFile: path.join(ROOT, "client", "vite.config.ts"), logLevel: "warn", build: { watch: {} } });
console.log("[dev] client rebuilds on change");
const server = spawn(process.execPath, [tsx, "watch", "--clear-screen=false", "server/src/main.ts"], { cwd: ROOT, stdio: "inherit" });
const stop = () => { server.kill("SIGTERM"); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
