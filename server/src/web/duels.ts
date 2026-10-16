// 1v1 duels before the match. Pure state with an injectable clock; the gateway drives it.
// * DuelQueue: the ranked queue. A search window starts at +-100 rating and widens by 50 every 10 s; two
//   players match when their ratings are within the wider of their two windows.
// * Challenges: a private challenge by username or by link (/duel/<token>); a token is good for one use
//   within 10 minutes.
// * ReadyChecks: before any duel both players have 20 s to accept. A decline or a timeout cancels it; in the
//   ranked queue, the player who did accept goes back into the queue.

import { randomBytes } from "node:crypto";

export const WINDOW_START = 100, WINDOW_STEP = 50, WINDOW_EVERY = 10;
export const CHALLENGE_TTL = 600;
export const READY_TIME = 20;

type Clock = () => number;
const mono: Clock = () => performance.now() / 1000;

export interface QueueEntry { userId: number; name: string; rating: number; rd: number; since: number }

export class DuelQueue {
  entries = new Map<number, QueueEntry>();
  constructor(private clock: Clock = mono) {}

  join(userId: number, name: string, rating: number, rd: number, since: number | null = null): QueueEntry {
    let e = this.entries.get(userId);
    if (!e) {
      e = { userId, name, rating, rd, since: since ?? this.clock() };
      this.entries.set(userId, e);
    }
    return e;
  }

  leave(userId: number): boolean { return this.entries.delete(userId); }
  has(userId: number): boolean { return this.entries.has(userId); }

  window(e: QueueEntry, now = this.clock()): number {
    return WINDOW_START + WINDOW_STEP * Math.floor(Math.max(0, now - e.since) / WINDOW_EVERY);
  }

  status(userId: number): Record<string, number> | null {
    const e = this.entries.get(userId);
    if (!e) return null;
    const now = this.clock();
    return { waiting: Math.round((now - e.since) * 10) / 10, rating: Math.round(e.rating), window: this.window(e, now), in_queue: this.entries.size };
  }

  /** Pair up who can play: the longest-waiting first, each with the closest rating in range. */
  match(): Array<[QueueEntry, QueueEntry]> {
    const now = this.clock();
    const pairs: Array<[QueueEntry, QueueEntry]> = [];
    const waiting = [...this.entries.values()].sort((a, b) => a.since - b.since);
    const used = new Set<number>();
    for (const a of waiting) {
      if (used.has(a.userId)) continue;
      let best: [number, QueueEntry] | null = null;
      for (const b of waiting) {
        if (b.userId === a.userId || used.has(b.userId)) continue;
        const diff = Math.abs(a.rating - b.rating);
        if (diff <= Math.max(this.window(a, now), this.window(b, now)) && (!best || diff < best[0])) best = [diff, b];
      }
      if (best) {
        used.add(a.userId);
        used.add(best[1].userId);
        pairs.push([a, best[1]]);
      }
    }
    for (const [a, b] of pairs) {
      this.entries.delete(a.userId);
      this.entries.delete(b.userId);
    }
    return pairs;
  }
}

export class Challenge {
  used = false;
  constructor(public token: string, public fromId: number, public fromName: string, public toId: number | null, public toName: string,
    public expires: number) {}

  info(): Record<string, string> { return { token: this.token, from: this.fromName, to: this.toName, url: `/duel/${this.token}` }; }
}

export class Challenges {
  byToken = new Map<string, Challenge>();
  constructor(private clock: Clock = mono, public ttl = CHALLENGE_TTL) {}

  create(fromId: number, fromName: string, toId: number | null = null, toName = ""): Challenge {
    const c = new Challenge(randomBytes(12).toString("base64url"), fromId, fromName, toId, toName, this.clock() + this.ttl);
    this.byToken.set(c.token, c);
    return c;
  }

  get(token: string): Challenge | null {
    const c = this.byToken.get(token || "");
    if (!c || c.used || c.expires <= this.clock()) return null;
    return c;
  }

  /** Accept: a valid challenge meant for this user (or anyone with the link), used up. */
  take(token: string, userId: number): Challenge | null {
    const c = this.get(token);
    if (!c || c.fromId === userId || (c.toId !== null && c.toId !== userId)) return null;
    c.used = true;
    return c;
  }

  decline(token: string, userId: number): Challenge | null {
    const c = this.get(token);
    if (!c || (c.toId !== null && c.toId !== userId) || c.fromId === userId) return null;
    c.used = true;
    return c;
  }

  expire(): void {
    const now = this.clock();
    for (const [k, c] of this.byToken) if (c.used || c.expires <= now) this.byToken.delete(k);
  }
}

export class ReadyCheck {
  ready = new Set<number>();
  declined: number | null = null;
  constructor(public token: string, public players: [[number, string], [number, string]], public ranked: boolean, public expires: number) {}

  get ids(): [number, number] { return [this.players[0][0], this.players[1][0]]; }

  state(): Record<string, unknown> {
    return { token: this.token, ranked: this.ranked, players: this.players.map(([, n]) => n), ready: this.players.map(([u]) => this.ready.has(u)) };
  }
}

export class ReadyChecks {
  checks = new Map<string, ReadyCheck>();
  constructor(private clock: Clock = mono, public seconds = READY_TIME) {}

  create(a: [number, string], b: [number, string], ranked: boolean): ReadyCheck {
    const rc = new ReadyCheck(randomBytes(8).toString("hex"), [a, b], ranked, this.clock() + this.seconds);
    this.checks.set(rc.token, rc);
    return rc;
  }

  ofUser(userId: number): ReadyCheck | null { return [...this.checks.values()].find((rc) => rc.ids.includes(userId)) ?? null; }

  /** "waiting" | "go" (both ready: removed) | "declined" (removed) | "unknown". */
  answer(token: string, userId: number, ready: boolean): [string, ReadyCheck | null] {
    const rc = this.checks.get(token);
    if (!rc || !rc.ids.includes(userId)) return ["unknown", null];
    if (!ready) {
      rc.declined = userId;
      this.checks.delete(token);
      return ["declined", rc];
    }
    rc.ready.add(userId);
    if (rc.ready.size === 2) {
      this.checks.delete(token);
      return ["go", rc];
    }
    return ["waiting", rc];
  }

  expired(): ReadyCheck[] {
    const now = this.clock();
    const out = [...this.checks.values()].filter((rc) => rc.expires <= now);
    for (const rc of out) this.checks.delete(rc.token);
    return out;
  }

  /** A player went away (closed the page): their check counts as declined. */
  cancelUser(userId: number): ReadyCheck | null {
    const rc = this.ofUser(userId);
    if (!rc) return null;
    return this.answer(rc.token, userId, false)[1];
  }
}
