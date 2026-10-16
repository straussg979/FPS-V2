// COLD SECTOR server: the website (Fastify), the game gateway (WebSocket on /ws, same port) and one worker
// thread per match. `npm start` builds what is missing and runs this; it binds HOST:PORT (127.0.0.1:5000 by
// default, so only a local proxy or Cloudflare Tunnel can reach it). SIGTERM / SIGINT shut down gracefully:
// no new connections, players told, matches stopped, the database closed.

import Fastify from "fastify";
import { loadConfig } from "./config";
import { openDb } from "./web/db";
import { Gateway } from "./web/gateway";
import { ProxyTrust } from "./web/proxy";
import { SessionCodec } from "./web/sessions";
import { registerViews } from "./web/views";

const log = (m: string) => console.log(m);

async function main(): Promise<void> {
  const cfg = loadConfig();
  const repo = await openDb(cfg.databaseUrl, log);
  const sessions = new SessionCodec(cfg.secretKey, cfg.cookieSecure);
  const proxy = new ProxyTrust(cfg.trustedProxy, cfg.cloudflareIps);
  const gateway = new Gateway(cfg, repo, sessions, proxy, log);
  const app = Fastify({ logger: false, trustProxy: false, bodyLimit: 64 * 1024, connectionTimeout: 30_000, requestTimeout: 30_000 });
  await registerViews(app, { cfg, repo, sessions, proxy, gateway, log });
  app.server.on("upgrade", (req, socket, head) => {
    const url = (req.url ?? "").split("?")[0];
    if (url !== "/ws") {
      socket.destroy();
      return;
    }
    gateway.upgrade(req, socket, head).catch((e) => {
      log(`[ws] upgrade: ${e}`);
      socket.destroy();
    });
  });
  await app.listen({ host: cfg.host, port: cfg.port });
  gateway.start();
  const shown = cfg.host === "0.0.0.0" || cfg.host === "::" ? "127.0.0.1" : cfg.host;
  log(`COLD SECTOR is running: http://${shown.includes(":") ? `[${shown}]` : shown}:${cfg.port}/`);
  if (cfg.siteUrl) log(`public address: ${cfg.siteUrl} (TRUSTED_PROXY=${cfg.trustedProxy})`);

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log(`[server] ${sig}: shutting down`);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    try {
      await gateway.stop();
      await app.close();
      await repo.close();
    } catch (e) {
      log(`[server] shutdown: ${e}`);
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
