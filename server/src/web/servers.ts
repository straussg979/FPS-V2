// Public servers: data/servers.json, their matches, restarts, the server browser rows, vote kicks and kick
// bans. The gateway starts every server at boot. Each is one match worker in `server` mode: continuous rounds
// and matches, the map rotation, drop-in/out with bot backfill and auto-balance. A server whose worker dies
// restarts after 5 s, then 30 s, then 2 min (ten minutes of running resets the count). A rotation to a
// different map starts a new worker at once and the players follow (match:moved).
// Vote kick: any player on the server starts one against another player; it passes when more than half of
// the other players vote yes within 30 s. The kicked player can't rejoin that server for 30 minutes.

import fs from "node:fs";
import type { Json } from "@cs/shared/data";
import type { MatchConfig } from "../match/server";

export const BACKOFF = [5, 30, 120];
export const STABLE_AFTER = 600;
export const KICK_BAN = 1800;
export const VOTE_TIME = 30;
export const VOTE_COOLDOWN = 60;
const PRESETS = ["full", "short"];
const DIFFICULTIES = ["easy", "normal", "hard", "expert"];

export interface ServerSpec {
  id: string; name: string; region: string; rotation: string[]; maxPlayers: number; preset: string; fill: [number, number];
  difficulty: string; friendlyFire: boolean; pauseWhenEmpty: boolean;
}

export function serverOptions(s: ServerSpec, rotationIndex = 0, fastRounds = false): Partial<MatchConfig> {
  const idx = rotationIndex % s.rotation.length;
  return { map: s.rotation[idx], mode: "server", preset: s.preset, difficulty: s.difficulty, friendlyFire: s.friendlyFire, fill: [...s.fill],
    bots: [...s.fill], startOnFirstJoin: false, endAction: "rotate", rotation: [...s.rotation], rotationIndex: idx, balance: true,
    pauseWhenEmpty: s.pauseWhenEmpty, serverId: s.id, title: s.name, fastRounds, restartDelay: fastRounds ? 4 : 15 };
}

export function loadSpecs(file: string, maps: string[]): ServerSpec[] {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const out: ServerSpec[] = [];
  const seen = new Set<string>();
  for (const raw of data.servers ?? []) {
    const s: ServerSpec = { id: String(raw.id), name: String(raw.name ?? raw.id).slice(0, 60), region: String(raw.region ?? "").slice(0, 12),
      rotation: (raw.rotation?.length ? raw.rotation : ["qalat"]).map(String), maxPlayers: Number(raw.max_players ?? 10),
      preset: raw.preset ?? "short", fill: (raw.fill ?? [5, 5]).map(Number) as [number, number], difficulty: raw.difficulty ?? "normal",
      friendlyFire: !!raw.friendly_fire, pauseWhenEmpty: !!raw.pause_when_empty };
    if (seen.has(s.id)) throw new Error(`servers: duplicate id ${s.id}`);
    if (!/^[a-z0-9-]{1,32}$/.test(s.id)) throw new Error(`servers: ${s.id}: id must be 1-32 of a-z, 0-9 and -`);
    if (!PRESETS.includes(s.preset) || !DIFFICULTIES.includes(s.difficulty)) throw new Error(`servers: ${s.id}: bad preset or difficulty`);
    if (!(s.maxPlayers >= 1 && s.maxPlayers <= 10 && s.fill.length === 2 && s.fill.every((v) => v >= 0 && v <= 5))) {
      throw new Error(`servers: ${s.id}: max_players 1-10, fill two sizes 0-5`);
    }
    const missing = s.rotation.filter((m) => !maps.includes(m));
    if (missing.length) throw new Error(`servers: ${s.id}: unknown map ${missing[0]}`);
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

export class VoteKick {
  yes = new Set<number>();
  no = new Set<number>();
  constructor(public target: number, public targetName: string, public by: number, public electorate: Set<number>, public expires: number) {}

  needed(): number { return Math.floor(this.electorate.size / 2) + 1; }

  cast(userId: number, yes: boolean): void {
    if (!this.electorate.has(userId)) return;
    (yes ? this.yes : this.no).add(userId);
    (yes ? this.no : this.yes).delete(userId);
  }

  /** "passed", "failed" or null (still open). */
  outcome(now: number): string | null {
    if (this.yes.size >= this.needed()) return "passed";
    if (this.electorate.size - this.no.size < this.needed() || now >= this.expires) return "failed";
    return null;
  }

  state(now: number): Json {
    return { target: this.targetName, yes: this.yes.size, no: this.no.size, needed: this.needed(), left: Math.max(0, Math.round(this.expires - now)) };
  }
}

export class ServerState {
  matchId: string | null = null;
  status: "starting" | "running" | "restarting" | "stopped" = "stopped";
  failures = 0;
  retryAt: number | null = null;
  startedAt = 0;
  rotationIndex = 0;
  reason = "";
  kicks = new Map<number, number>();
  vote: VoteKick | null = null;
  voteCooldown = new Map<number, number>();
  constructor(public spec: ServerSpec) {}
}

export class PublicServers {
  states = new Map<string, ServerState>();
  constructor(specs: ServerSpec[], private startFn: (st: ServerState) => string, public clock: () => number = () => performance.now() / 1000,
    private log: (m: string) => void = console.log) {
    for (const s of specs) this.states.set(s.id, new ServerState(s));
  }

  get(id: string): ServerState | null { return this.states.get(id) ?? null; }
  byMatch(matchId: string): ServerState | null { return [...this.states.values()].find((s) => s.matchId === matchId) ?? null; }

  start(id: string): boolean {
    const st = this.states.get(id);
    if (!st) return false;
    try {
      st.matchId = this.startFn(st);
    } catch (e) {
      st.reason = (e as Error).message;
      this.retry(st);
      return false;
    }
    st.status = "starting";
    st.startedAt = this.clock();
    st.retryAt = null;
    return true;
  }

  startAll(): void { for (const id of this.states.keys()) this.start(id); }

  ready(matchId: string): void {
    const st = this.byMatch(matchId);
    if (st) st.status = "running";
  }

  private retry(st: ServerState): void {
    const delay = BACKOFF[Math.min(st.failures, BACKOFF.length - 1)];
    st.failures++;
    st.status = "restarting";
    st.retryAt = this.clock() + delay;
    this.log(`[servers] ${st.spec.id}: restarting in ${delay} s (${st.reason})`);
  }

  /** The worker says the next map is a different one: the next start uses it. */
  rotated(matchId: string, rotationIndex: number): void {
    const st = this.byMatch(matchId);
    if (st) st.rotationIndex = rotationIndex;
  }

  /** A server's worker ended: start it again (now after a rotation, else with backoff). */
  closed(matchId: string, reason: string): ServerState | null {
    const st = this.byMatch(matchId);
    if (!st || st.status === "stopped") return null;
    st.matchId = null;
    st.vote = null;
    st.reason = reason;
    if (reason === "rotate") {
      st.failures = 0;
      st.status = "restarting";
      st.retryAt = this.clock();
    } else {
      if (this.clock() - st.startedAt > STABLE_AFTER) st.failures = 0;
      this.retry(st);
    }
    return st;
  }

  /** Stop every server for good (shutdown). */
  stopAll(): void {
    for (const st of this.states.values()) {
      st.status = "stopped";
      st.retryAt = null;
    }
  }

  due(): string[] {
    const now = this.clock();
    return [...this.states].filter(([, st]) => st.status === "restarting" && st.retryAt !== null && st.retryAt <= now).map(([id]) => id);
  }

  bannedFor(id: string, userId: number): number {
    const st = this.states.get(id);
    if (!st) return 0;
    return Math.max(0, (st.kicks.get(userId) ?? 0) - this.clock());
  }

  startVote(id: string, by: number, target: number, targetName: string, players: Set<number>): [boolean, string] {
    const now = this.clock();
    const st = this.states.get(id);
    if (!st) return [false, "no such server"];
    if (st.vote) return [false, "a vote is already running"];
    if (target === by) return [false, "you can't kick yourself"];
    if (!players.has(target) || !players.has(by)) return [false, "both must be playing on this server"];
    if ((st.voteCooldown.get(by) ?? 0) > now) return [false, "wait before starting another vote"];
    const electorate = new Set([...players].filter((u) => u !== target));
    st.vote = new VoteKick(target, targetName, by, electorate, now + VOTE_TIME);
    st.vote.cast(by, true);
    st.voteCooldown.set(by, now + VOTE_COOLDOWN);
    return [true, ""];
  }

  cast(id: string, userId: number, yes: boolean): VoteKick | null {
    const st = this.states.get(id);
    if (!st || !st.vote) return null;
    st.vote.cast(userId, yes);
    return st.vote;
  }

  /** Votes that ended: [[server, vote, "passed" | "failed"]]; a passed vote bans its target. */
  resolveVotes(): Array<[ServerState, VoteKick, string]> {
    const now = this.clock();
    const out: Array<[ServerState, VoteKick, string]> = [];
    for (const st of this.states.values()) {
      const v = st.vote;
      if (!v) continue;
      const res = v.outcome(now);
      if (!res) continue;
      st.vote = null;
      if (res === "passed") st.kicks.set(v.target, now + KICK_BAN);
      out.push([st, v, res]);
    }
    return out;
  }

  /** One row per server for the browser. summaryOf(matchId) -> the match's stats or null. */
  rows(summaryOf: (matchId: string) => Json | null): Json[] {
    return [...this.states.values()].map((st) => {
      const s = (st.matchId ? summaryOf(st.matchId) : null) ?? {};
      const teams = s.teams ?? [{}, {}];
      const humans = teams.reduce((n: number, t: Json) => n + (t.humans ?? 0), 0);
      const bots = teams.reduce((n: number, t: Json) => n + (t.bots ?? 0), 0);
      return { id: st.spec.id, name: st.spec.name, region: st.spec.region, map: s.map ?? st.spec.rotation[st.rotationIndex % st.spec.rotation.length],
        players: humans, bots, max: st.spec.maxPlayers, round: s.round ?? 0, score: s.score ?? [0, 0], phase: s.phase ?? "",
        status: s.idle ? "idle" : st.status, match_no: s.match_no ?? 0, preset: st.spec.preset, difficulty: st.spec.difficulty };
    });
  }
}
