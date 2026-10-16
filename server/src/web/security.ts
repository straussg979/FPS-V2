// Passwords (argon2id), username rules, the failed-login limit and token buckets. The login limit follows
// the original rules: 5 failures per minute per IP and per username lock the key out; each further lockout
// doubles, up to an hour.

import { hash, verify } from "@node-rs/argon2";
import { wordFilter } from "./chat";

export const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
const RESERVED = new Set(["admin", "administrator", "bot", "bots", "server", "system", "moderator", "spectator", "cold_sector",
  "coldsector", "null", "none", "root"]);
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

// argon2id (the library's default algorithm) with OWASP's recommended parameters
const OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export async function hashPassword(password: string): Promise<string> { return hash(password, OPTS); }

export async function checkPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

/** Whether a stored hash uses weaker parameters than today's (it is replaced at the next log-in). */
export function needsRehash(stored: string): boolean {
  const m = /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(stored);
  if (!m) return true;
  return Number(m[1]) < OPTS.memoryCost || Number(m[2]) < OPTS.timeCost;
}

/** Why a username cannot be registered, or null. */
export function usernameProblem(name: string): string | null {
  if (!USERNAME_RE.test(name || "")) return "3-20 characters: letters, digits, _ and -";
  const low = name.toLowerCase();
  if (RESERVED.has(low) || low.startsWith("bot_")) return "that name is reserved";
  if (!wordFilter().usernameOk(name)) return "please choose another name";
  return null;
}

/** A password hash to verify against when the username does not exist, so both cases take as long. */
let dummy: Promise<string> | null = null;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword("not a real password, only spends the same time");
  return dummy;
}

/** Failed log-ins counted per key (an IP, a username) in a sliding window: `limit` failures in `window`
 * seconds lock the key out; each further lockout doubles, up to `maxLockout`. */
export class LoginLimiter {
  private fails = new Map<string, number[]>();
  private locked = new Map<string, [number, number]>();      // key -> (until, lockouts so far)

  constructor(public limit = 5, public window = 60, public lockout = 60, public maxLockout = 3600,
    private clock: () => number = () => performance.now() / 1000) {}

  /** Seconds until these keys may try again (0: now). */
  retryAfter(...keys: string[]): number {
    const now = this.clock();
    return Math.max(0, ...keys.map((k) => (this.locked.get(k)?.[0] ?? 0) - now));
  }

  failed(...keys: string[]): void {
    const now = this.clock();
    for (const k of keys) {
      let hits = [...(this.fails.get(k) ?? []).filter((t) => now - t < this.window), now];
      if (hits.length >= this.limit) {
        const n = this.locked.get(k)?.[1] ?? 0;
        this.locked.set(k, [now + Math.min(this.maxLockout, this.lockout * 2 ** n), n + 1]);
        hits = [];
      }
      this.fails.set(k, hits);
    }
    if (this.fails.size > 10000) {                 // forget stale keys
      for (const [k, v] of this.fails) if (!v.length || now - v[v.length - 1] >= this.window) this.fails.delete(k);
      for (const [k, v] of this.locked) if (v[0] <= now - this.maxLockout) this.locked.delete(k);
    }
  }

  succeeded(...keys: string[]): void {
    for (const k of keys) {
      this.fails.delete(k);
      this.locked.delete(k);
    }
  }
}

/** Rate limit: `rate` per second, bursts of `burst`. */
export class TokenBucket {
  tokens: number;
  private t: number;
  constructor(public rate: number, public burst: number, private clock: () => number = () => performance.now() / 1000) {
    this.tokens = burst;
    this.t = clock();
  }

  take(n = 1): boolean {
    const now = this.clock();
    this.tokens = Math.min(this.burst, this.tokens + (now - this.t) * this.rate);
    this.t = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}
