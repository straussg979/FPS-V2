// Configuration from environment variables (and an optional .env file in the repository root; every
// variable is documented in .env.example). Nothing here is required for a local start.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT, USER_DIR } from "./paths";

/** KEY=value lines of .env into process.env (variables already set win). */
export function loadDotEnv(file = path.join(ROOT, ".env")): void {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const env = (name: string, def = ""): string => (process.env[name] ?? def).trim();
const bool = (name: string, def: boolean): boolean => {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? def : ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
};
const int = (name: string, def: number): number => {
  const v = Number.parseInt(env(name), 10);
  return Number.isFinite(v) ? v : def;
};
const origin = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};

export type TrustedProxy = "none" | "cloudflare" | "local";

export interface Config {
  secretKey: string;
  databaseUrl: string;
  host: string;
  port: number;
  siteUrl: string;
  trustedProxy: TrustedProxy;
  cloudflareIps: string[] | null;
  cookieSecure: boolean;
  allowedOrigins: string[];
  tickRate: number;
  snapshotRate: number;
  interpMs: number;
  maxMatches: number;
  loginAttempts: number;
  serversFile: string;
  duelSpectatorDelay: number;
  devFastRounds: boolean;
  pingInterval: number;
}

export function loadConfig(): Config {
  loadDotEnv();
  fs.mkdirSync(USER_DIR, { recursive: true });
  let secret = env("SECRET_KEY");
  if (!secret) {
    // development only: a key that lasts as long as user/secret_key (sessions survive restarts)
    const keyFile = path.join(USER_DIR, "secret_key");
    try {
      secret = fs.readFileSync(keyFile, "utf8").trim();
    } catch {
      secret = "";
    }
    if (!secret) {
      secret = randomBytes(32).toString("hex");
      fs.writeFileSync(keyFile, secret, { mode: 0o600 });
    }
  }
  const trusted = env("TRUSTED_PROXY", "none").toLowerCase();
  if (!["none", "cloudflare", "local"].includes(trusted)) throw new Error(`TRUSTED_PROXY must be none, cloudflare or local, not ${trusted}`);
  const ips = env("CLOUDFLARE_IPS").split(",").map((s) => s.trim()).filter(Boolean);
  const siteUrl = env("SITE_URL").replace(/\/+$/, "");
  const behindHttps = trusted === "cloudflare" || siteUrl.startsWith("https://");
  const allowed = env("ALLOWED_ORIGINS").split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean);
  if (siteUrl && origin(siteUrl)) allowed.push(origin(siteUrl));
  return {
    secretKey: secret,
    databaseUrl: env("DATABASE_URL"),
    host: env("HOST", "127.0.0.1") || "127.0.0.1",
    port: int("PORT", 5000),
    siteUrl,
    trustedProxy: trusted as TrustedProxy,
    cloudflareIps: ips.length ? ips : null,
    cookieSecure: bool("SESSION_COOKIE_SECURE", behindHttps),
    allowedOrigins: allowed,
    tickRate: int("TICK_RATE", 64),
    snapshotRate: int("SNAPSHOT_RATE", 32),
    interpMs: int("INTERP_MS", 100),
    maxMatches: int("MAX_MATCHES", 4),
    loginAttempts: int("LOGIN_ATTEMPTS", 5),
    serversFile: process.env.SERVERS_FILE !== undefined ? env("SERVERS_FILE") : path.join(ROOT, "data", "servers.json"),
    duelSpectatorDelay: Number.parseFloat(env("DUEL_SPECTATOR_DELAY", "10")) || 10,
    devFastRounds: bool("DEV_FAST_ROUNDS", false),
    pingInterval: int("WS_PING_SECONDS", 20),
  };
}
