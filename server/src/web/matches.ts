// The gateway's side of the matches. Every match runs in its own worker thread (match/worker.ts); the gateway
// posts joins, leaves and players' input to it and gets snapshots, welcomes and statistics back, handed to
// `deliver` (the gateway, gateway.ts), which sends them to the right connections. Workers never touch the
// database. A worker that dies is noticed: its players are told and the match is removed. MAX_MATCHES caps
// the workers per host.

import { randomBytes } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { Json } from "@cs/shared/data";
import { type InMessage, type MatchConfig, type OutMessage, matchConfig } from "../match/server";

export class MatchLimit extends Error {}

export type Deliver = (matchId: string, kind: string, payload: Json) => void;

export class MatchHandle {
  created = Date.now();
  status: "starting" | "running" | "closed" = "starting";
  users = new Map<number, { name: string; mode: string }>();
  stats: Json = {};
  roster: Record<string, { slot: number | null; team: number | null; name: string; mode: string }> = {};
  reason = "";
  closedWaiters: Array<() => void> = [];
  /** The user who started it (a quick match or a lobby's host); null for public servers. */
  owner: number | null = null;
  constructor(public config: MatchConfig, public worker: Worker) {}

  /** Bot matches and lobby matches can be stopped by whoever started them; duels and public servers can't. */
  stoppableBy(userId: number): boolean {
    return this.status !== "closed" && this.owner === userId && this.config.mode === "bots" && !this.config.serverId;
  }

  get id(): string { return this.config.matchId; }

  post(m: InMessage, transfer: ArrayBuffer[] = []): void {
    if (this.status === "closed") return;
    try {
      this.worker.postMessage(m, transfer);
    } catch {
      // the worker is gone; the exit handler closes the handle
    }
  }

  summary(): Json {
    const s = this.stats;
    const users = [...this.users.values()];
    return { id: this.id, title: this.config.title || this.id, map: s.map ?? this.config.map, status: this.status, mode: this.config.mode,
      server_id: this.config.serverId, open: this.config.mode === "bots" && !Object.keys(this.config.roster).length, teams: s.teams ?? null, match_no: s.match_no ?? 1, idle: s.idle ?? false, paused: s.paused ?? false,
      players: users.filter((u) => u.mode === "play").length, spectators: users.filter((u) => u.mode === "spectate").length,
      bots: s.bots ?? this.config.bots[0] + this.config.bots[1], phase: s.phase ?? "", round: s.round ?? 0, score: s.score ?? [0, 0],
      tick_ms: Math.round((s.tick_ms_mean ?? 0) * 100) / 100, cpu: Math.round((s.cpu ?? 0) * 1000) / 1000 };
  }
}

function workerFile(): { url: URL; execArgv: string[] } {
  if (import.meta.url.endsWith(".ts")) return { url: new URL("../match/worker-dev.mjs", import.meta.url), execArgv: [] };
  return { url: new URL("./worker.mjs", import.meta.url), execArgv: [] };
}

export class MatchManager {
  matches = new Map<string, MatchHandle>();

  constructor(public deliver: Deliver, public maxMatches = 4, public tickRate = 64, public snapshotRate = 32,
    public log: (m: string) => void = console.log) {}

  live(): MatchHandle[] { return [...this.matches.values()].filter((m) => m.status !== "closed"); }

  create(options: Partial<MatchConfig>): MatchHandle {
    if (this.live().length >= this.maxMatches) throw new MatchLimit(`this host runs at most ${this.maxMatches} matches`);
    const id = options.matchId ?? randomBytes(4).toString("hex");
    const cfg = matchConfig({ ...options, matchId: id, tickRate: this.tickRate, snapshotRate: this.snapshotRate });
    const wf = workerFile();
    const worker = new Worker(wf.url, { workerData: { config: cfg }, execArgv: wf.execArgv, name: `match-${id}` });
    const h = new MatchHandle(cfg, worker);
    this.matches.set(id, h);
    worker.on("message", (m: OutMessage) => this.onMessage(h, m));
    worker.on("error", (e) => {
      this.log(`[matches] ${id} crashed: ${e.stack ?? e}`);
      this.close(h, `error: ${e.message}`);
    });
    worker.on("exit", (code) => this.close(h, `worker exited (code ${code})`));
    this.log(`[matches] started ${id} (${cfg.mode}, ${cfg.map})`);
    return h;
  }

  get(id: string): MatchHandle | null {
    const h = this.matches.get(id);
    return h && h.status !== "closed" ? h : null;
  }

  list(): Json[] { return this.live().map((m) => m.summary()); }

  join(id: string, uid: number, name: string, mode: "play" | "spectate" = "play", team: number | null = null): boolean {
    const h = this.get(id);
    if (!h) return false;
    h.users.set(uid, { name, mode });
    h.post({ t: "join", uid, name, mode, team });
    return true;
  }

  input(id: string, uid: number, data: Uint8Array): void {
    const h = this.matches.get(id);
    if (h && h.status === "running" && h.users.has(uid)) {
      const copy = data.slice();
      h.post({ t: "input", uid, data: copy }, [copy.buffer as ArrayBuffer]);
    }
  }

  command(id: string, uid: number, kind: "buy" | "sell" | "specialist", item: string): void {
    const h = this.matches.get(id);
    if (h && h.status === "running" && h.users.has(uid)) h.post({ t: "cmd", uid, kind, item });
  }

  chat(id: string, uid: number, scope: string, text: string): void {
    const h = this.matches.get(id);
    if (h && h.status === "running" && h.users.has(uid)) h.post({ t: "chat", uid, scope, text });
  }

  /** User id -> roster entry of everyone playing (not spectating) in a match. */
  players(id: string): Record<string, { slot: number | null; team: number | null; name: string; mode: string }> {
    const h = this.get(id);
    return Object.fromEntries(Object.entries(h ? h.roster : {}).filter(([, r]) => r.mode === "play"));
  }

  disconnect(id: string, uid: number): void {
    const h = this.get(id);
    if (h && h.users.has(uid)) h.post({ t: "disconnect", uid });
  }

  leave(id: string, uid: number): void {
    const h = this.get(id);
    if (h && h.users.delete(uid)) h.post({ t: "leave", uid });
  }

  async stop(id: string, timeoutMs = 5000, reason?: string): Promise<void> {
    const h = this.matches.get(id);
    if (!h || h.status === "closed") return;
    const closed = new Promise<void>((resolve) => h.closedWaiters.push(resolve));
    h.post({ t: "stop", reason });
    const timer = setTimeout(() => { void h.worker.terminate(); }, timeoutMs);
    await closed;
    clearTimeout(timer);
  }

  async stopAll(timeoutMs = 5000): Promise<void> {
    await Promise.all(this.live().map((h) => this.stop(h.id, timeoutMs)));
  }

  private close(h: MatchHandle, reason: string): void {
    if (h.status === "closed") return;
    h.status = "closed";
    h.reason = reason;
    this.log(`[matches] ${h.id} closed: ${reason}`);
    this.deliver(h.id, "closed", reason);
    for (const w of h.closedWaiters.splice(0)) w();
    setTimeout(() => { if (this.matches.get(h.id) === h) this.matches.delete(h.id); }, 60_000).unref();
    void h.worker.terminate();
  }

  private onMessage(h: MatchHandle, m: OutMessage): void {
    switch (m.t) {
      case "snaps": this.deliver(h.id, "snaps", m.snaps); break;
      case "welcome": this.deliver(h.id, "welcome", { uid: m.uid, data: m.data }); break;
      case "stats": h.stats = m.data; break;
      case "ready": h.status = "running"; this.deliver(h.id, "ready", m.info); break;
      case "shop": this.deliver(h.id, "shop", { uid: m.uid, data: m.data }); break;
      case "roster": h.roster = m.roster; break;
      case "result": this.deliver(h.id, "result", m.data); break;
      case "rotate": this.deliver(h.id, "rotate", { map: m.map, rotation_index: m.rotationIndex }); break;
      case "log": this.log(m.text); break;
      case "closed": this.close(h, m.reason); break;
    }
  }
}
