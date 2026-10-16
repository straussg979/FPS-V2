// One match: a ServerGame run in real time at 64 Hz with its clients (a worker thread runs one; worker.ts).
// Each tick it takes the gateway's messages, advances the world, and every `snapshotEvery` ticks sends each
// connected client its snapshot. It never touches the database; results go to the gateway.
//
// Modes (MatchConfig.mode):
// * bots: a lobby's match (or a quick match from the play page). Bots keep each team at its size (`fill`);
//   the match starts when every lobby member has joined (or `joinTimeout` after the first); after the end it
//   restarts or stops (`endAction`).
// * duel: 1v1 (data/modes/duel.json). Both players must join within `joinTimeout` (else the absent one
//   forfeits). A player who disconnects pauses the match for up to `pauseBudget` seconds in total, then
//   forfeits; leaving forfeits at once. Spectators see everything, `spectatorDelay` seconds late.
// * server: a public server. Never ends: after a match the scoreboard holds `restartDelay` seconds, then the
//   next map of the rotation starts (here when it is the same map, otherwise the gateway starts a new
//   match). Joiners go to the team with fewer players and take a bot's place; teams are rebalanced at the
//   start and at halftime; with `pauseWhenEmpty` an empty server stops at the next round boundary.
// A disconnected player keeps its slot for `reconnectGrace` seconds.

import { jsonEvent } from "@cs/shared/codec";
import { emptyCmd } from "@cs/shared/commands";
import { type Json, loadPreset } from "@cs/shared/data";
import { crc32 } from "@cs/shared/rng";
import { ClientView, SnapshotBuilder } from "../net/snapshots";
import { InputLimiter } from "../net/validate";
import { findItem } from "../sim/shop";
import { type MapCache, ServerGame } from "../sim/game";
import type { HumanAgent } from "../sim/human";

export const FAST_TIMERS = { freeze_time: 1.5, prep_time: 0.0, buy_time: 6.0, round_time: 12.0, round_end_delay: 1.5,
  halftime_delay: 2.0, bomb_timer: 15.0 };

export interface MatchConfig {
  matchId: string;
  map: string;
  seed: number | null;
  difficulty: string | null;
  bots: [number, number];               // bots on team 0 and team 1 at the start
  tickRate: number;
  snapshotRate: number;
  shortTimers: boolean;                 // 2 s freeze, no preparation phase
  fastRounds: boolean;                  // every timer short (FAST_TIMERS)
  startOnFirstJoin: boolean;
  reconnectGrace: number;
  restartDelay: number;
  title: string;
  mode: "bots" | "duel" | "server";
  preset: string;                       // full | short | duel
  friendlyFire: boolean | null;
  fill: [number, number] | null;
  roster: Record<string, number>;       // user id -> team expected to play (lobbies, duels)
  joinTimeout: number;
  ranked: boolean;
  pauseBudget: number;
  spectatorDelay: number;
  endAction: "restart" | "stop" | "rotate";
  rotation: string[];
  rotationIndex: number;
  balance: boolean;
  pauseWhenEmpty: boolean;
  serverId: string;
}

export function matchConfig(c: Partial<MatchConfig> & { matchId: string }): MatchConfig {
  return { map: "qalat", seed: null, difficulty: null, bots: [0, 0], tickRate: 64, snapshotRate: 32, shortTimers: false,
    fastRounds: false, startOnFirstJoin: true, reconnectGrace: 60, restartDelay: 15, title: "", mode: "bots", preset: "full",
    friendlyFire: null, fill: null, roster: {}, joinTimeout: 60, ranked: false, pauseBudget: 60, spectatorDelay: 0,
    endAction: "restart", rotation: [], rotationIndex: 0, balance: false, pauseWhenEmpty: false, serverId: "", ...c };
}

export function buildRules(cfg: MatchConfig): Json {
  const rules = loadPreset(cfg.preset);
  if (cfg.friendlyFire !== null) rules.friendly_fire = cfg.friendlyFire;
  if (cfg.shortTimers) {
    rules.timers.freeze_time = 2.0;
    rules.timers.prep_time = 0.0;
  }
  if (cfg.fastRounds) Object.assign(rules.timers, FAST_TIMERS);
  return rules;
}

export type OutMessage =
  | { t: "ready"; info: Json }
  | { t: "welcome"; uid: number; data: Json }
  | { t: "snaps"; snaps: Array<[number, Uint8Array[]]> }
  | { t: "stats"; data: Json }
  | { t: "roster"; roster: Json }
  | { t: "result"; data: Json }
  | { t: "rotate"; map: string; rotationIndex: number }
  | { t: "shop"; uid: number; data: Json }
  | { t: "closed"; reason: string }
  | { t: "log"; text: string };

export type InMessage =
  | { t: "join"; uid: number; name: string; mode: "play" | "spectate"; team: number | null }
  | { t: "input"; uid: number; data: Uint8Array }
  | { t: "disconnect"; uid: number }
  | { t: "leave"; uid: number }
  | { t: "cmd"; uid: number; kind: "buy" | "sell" | "specialist"; item: string }
  | { t: "chat"; uid: number; scope: string; text: string }
  | { t: "stop"; reason?: string };

class Client {
  connected = true;
  disconnectedAt = 0;
  delayed: Array<[number, Uint8Array]> = [];     // (release time, bytes): a delayed spectator's stream
  constructor(public userId: number, public name: string, public view: ClientView, public agent: HumanAgent | null = null,
    public limiter: InputLimiter | null = null, public joined = 0) {}
}

export class MatchServer {
  cfg: MatchConfig;
  out: (m: OutMessage, transfer?: ArrayBuffer[]) => void;
  log: (m: string) => void;
  rules: Json;
  game: ServerGame;
  builder: SnapshotBuilder;
  clients = new Map<number, Client>();
  snapshotEvery: number;
  started = false;
  matchEndT: number | null = null;
  running = true;
  reason = "stopped";
  private tickMs: number[] = [];
  private cpu0 = process.cpuUsage();
  private wall0 = performance.now();
  droppedTicks = 0;
  matchNo = 1;
  rotationIndex: number;
  private roundsPlayed = new Map<number, number>();
  private departed = new Map<number, Json>();
  private pauseLeft = new Map<number, number>();
  pausedBy: number | null = null;
  private pauseNote = 0;
  idle = false;
  private created = performance.now() / 1000;
  private firstJoin: number | null = null;
  private rosterSent = "";
  private soldiersSent = "";

  constructor(cfg: MatchConfig, mapData: Json, out: (m: OutMessage, transfer?: ArrayBuffer[]) => void, log: (m: string) => void,
    cache: MapCache | null) {
    this.cfg = cfg;
    this.out = out;
    this.log = log;
    this.rules = buildRules(cfg);
    this.game = new ServerGame(cfg.map, mapData, { seed: cfg.seed, difficulty: cfg.difficulty, opponents: cfg.bots[1], teammates: cfg.bots[0],
      rules: this.rules, log, cache });
    const g = this.game;
    g.loop.dt = 1 / cfg.tickRate;
    const d = g.director;
    d.fill = cfg.fill ? [cfg.fill[0], cfg.fill[1]] : null;
    this.builder = new SnapshotBuilder(g);
    this.snapshotEvery = Math.max(1, Math.round(cfg.tickRate / cfg.snapshotRate));
    this.rotationIndex = cfg.rotationIndex;
    for (const uid of Object.keys(cfg.roster)) this.pauseLeft.set(Number(uid), cfg.pauseBudget);
    d.listeners.push((k, data) => this.onMatchEvent(k, data));
    d.roundHooks.push((m, swapped) => this.roundHook(swapped));
    if (!cfg.startOnFirstJoin && !Object.keys(cfg.roster).length) this.start();
  }

  get duel(): boolean { return this.cfg.mode === "duel"; }
  private now(): number { return performance.now() / 1000; }
  private players(): Client[] { return [...this.clients.values()].filter((c) => c.agent !== null); }

  private event(payload: Json, to: null | HumanAgent | ["team", number] | ["spectators"] = null): void {
    this.builder.pending.push([to, jsonEvent(payload)]);
  }

  private welcome(c: Client, extra: Json = {}): void {
    const info = { mode: this.cfg.mode, preset: this.cfg.preset, ranked: this.cfg.ranked, title: this.cfg.title, server_id: this.cfg.serverId,
      match_no: this.matchNo, spectator_delay: c.agent ? 0 : this.cfg.spectatorDelay, ...extra };
    this.out({ t: "welcome", uid: c.userId, data: this.builder.welcome(c.view, info) });
  }

  /** Who plays: to the gateway (user ids, for vote kicks and team chat) and to the clients (the roster event:
   * every soldier, bots included) whenever it changed. */
  private sendRoster(force = false): void {
    const roster: Json = {};
    for (const [uid, c] of this.clients) {
      roster[uid] = { slot: c.agent ? this.builder.slotOf(c.agent) : null, team: c.view.team, name: c.name, mode: c.agent ? "play" : "spectate" };
    }
    const rs = JSON.stringify(roster);
    if (force || rs !== this.rosterSent) {
      this.rosterSent = rs;
      this.out({ t: "roster", roster });
    }
    const soldiers = this.builder.roster();
    const ss = JSON.stringify(soldiers);
    if (force || ss !== this.soldiersSent) {
      this.soldiersSent = ss;
      this.event({ kind: "roster", roster: soldiers });
    }
  }

  private start(): void {
    this.roundsPlayed = new Map();
    this.departed = new Map();
    this.game.director.start();
    this.started = true;
  }

  private onMatchEvent(kind: string, data: Json): void {
    if (kind === "round_end") {
      for (const [uid, c] of this.clients) if (c.agent && c.agent.team) this.roundsPlayed.set(uid, (this.roundsPlayed.get(uid) ?? 0) + 1);
    } else if (kind === "match_end") {
      this.matchEndT = this.game.loop.time;
      this.pausedBy = null;
      this.out({ t: "result", data: this.result(data) });
    } else if (kind === "round_start") this.sendRoster();
  }

  private statsOf(uid: number, c: Client | undefined): Json | null {
    if (!c || !c.agent) return this.departed.get(uid) ?? null;
    const a = c.agent;
    const st = a.stats;
    return { user_id: uid, name: c.name, team: a.team ? a.team.index : null, kills: st.kills, deaths: st.deaths, assists: st.assists,
      headshots: st.headshots, damage: Math.round(st.damage), score: st.score, mvps: st.mvps, rounds: this.roundsPlayed.get(uid) ?? 0 };
  }

  result(data: Json): Json {
    const m = this.game.director.match;
    const winner = data.winner;
    const players: Json[] = [];
    for (const uid of new Set([...this.clients.keys(), ...this.departed.keys()])) {
      const s = this.statsOf(uid, this.clients.get(uid));
      if (s) players.push(s);
    }
    const bots = this.game.director.bots.map((b) => ({ name: b.name, team: b.team ? b.team.index : null, kills: b.stats.kills,
      deaths: b.stats.deaths, score: b.stats.score }));
    // the match's MVP: the best score (kills break ties); nobody when nobody scored
    const everyone: Array<[number, number, string]> = [...players.map((p) => [p.score, p.kills, p.name] as [number, number, string]),
      ...bots.map((b) => [b.score, b.kills, b.name] as [number, number, string])];
    let best: [number, number, string] | null = null;
    for (const e of everyone) if (!best || e[0] > best[0] || (e[0] === best[0] && e[1] > best[1])) best = e;
    const mvp = best && (best[0] > 0 || best[1] > 0) ? best[2] : "";
    return { match_no: this.matchNo, mode: this.cfg.mode, preset: this.cfg.preset, map: this.cfg.map, ranked: this.cfg.ranked,
      server_id: this.cfg.serverId, winner_team: winner ? winner.index : null, forfeit: data.forfeit ?? null,
      score: m.teams.map((t) => t.score), rounds: m.history.length, overtime: m.overtime, players, bots, mvp,
      history: m.history.map((r) => ({ round: r.number, winner_team: r.winnerTeam, reason: r.reason })) };
  }

  handle(msg: InMessage): void {
    switch (msg.t) {
      case "input": {
        const c = this.clients.get(msg.uid);
        if (!c || !c.agent || !c.limiter) return;
        for (const cmd of c.limiter.accept(msg.data)) c.agent.push(cmd);
        break;
      }
      case "join": this.join(msg.uid, msg.name, msg.mode, msg.team); break;
      case "disconnect": {
        const c = this.clients.get(msg.uid);
        if (c) {
          c.connected = false;
          c.disconnectedAt = this.game.loop.time;
          c.delayed = [];
          this.idleInput(c);
        }
        break;
      }
      case "leave": {
        const uid = msg.uid;
        if (this.duel && String(uid) in this.cfg.roster && this.started && this.game.director.match.phase !== "match_end" && this.clients.has(uid)) {
          this.forfeit(uid, "left");
        }
        this.remove(uid);
        break;
      }
      case "cmd": {
        const c = this.clients.get(msg.uid);
        if (c && c.agent) this.command(c, msg.kind, msg.item);
        break;
      }
      case "chat": this.chat(msg.uid, msg.scope, msg.text); break;
      case "stop":
        if (msg.reason) this.reason = msg.reason;
        this.running = false;
        break;
    }
  }

  private chat(uid: number, scope: string, text: string): void {
    const c = this.clients.get(uid);
    if (!c) return;
    const a = c.agent;
    const team = a && a.team ? a.team.index : null;
    const ev: Json = { kind: "chat", from: c.name, slot: a ? this.builder.slotOf(a) : null, team, scope, text, dead: !!(a && !a.alive) };
    if (!a) {
      ev.scope = "spectators";
      this.event(ev, ["spectators"]);
    } else if (scope === "team" && team !== null) this.event(ev, ["team", team]);
    else this.event(ev);
  }

  /** Buy or sell through the shop's checks. */
  private command(c: Client, kind: "buy" | "sell" | "specialist", key: string): void {
    const d = this.game.director;
    const agent = c.agent as HumanAgent;
    if (kind === "specialist") {                   // the buy menu's last tab
      const ok = d.tactical.choose(agent, key);
      const name = ok ? d.tactical.specialist(key).name ?? key : "";
      this.out({ t: "shop", uid: c.userId, data: { kind, item: key, ok, text: ok ? `specialist: ${name}` : "not available" } });
      return;
    }
    const side = agent.team ? agent.team.side : null;
    const item = side ? findItem(this.game.weaponDb, d.rules, side, key) : null;
    let ok: boolean, text: string;
    if (!item) [ok, text] = [false, "not for sale"];
    else if (kind === "buy") [ok, text] = d.shop.buy(agent, item);
    else {
      ok = d.shop.refund(agent, item);
      text = ok ? `sold ${item.name}` : "can't sell that now";
    }
    this.out({ t: "shop", uid: c.userId, data: { kind, item: key, ok, text } });
  }

  /** A dropped connection must not keep the last buttons held. */
  private idleInput(c: Client): void {
    const a = c.agent;
    if (!a) return;
    a.queue = [];
    a.lastCmd = { ...emptyCmd(), seq: a.lastSeq, yaw: a.motor.yaw, pitch: a.motor.pitch };
  }

  /** The team with fewer players; a tie goes to the team that is behind, then the smaller one. */
  private autoTeam(): number {
    const d = this.game.director;
    const m = d.match;
    const humans = m.teams.map((t) => d.humans.filter((h) => h.team === t).length);
    const sizes = m.teams.map((t) => t.members.length);
    const key = (i: number) => [humans[i], m.teams[i].score - m.teams[1 - i].score, sizes[i], i];
    const a = key(0), b = key(1);
    for (let k = 0; k < 4; k++) if (a[k] !== b[k]) return a[k] < b[k] ? 0 : 1;
    return 0;
  }

  private join(uid: number, name: string, mode: "play" | "spectate", team: number | null): void {
    const g = this.game;
    let c = this.clients.get(uid);
    if (c) {                                         // reconnect: same slot, a fresh baseline
      c.connected = true;
      c.view.full = true;
      c.view.sent = new Map();
      c.delayed = [];
      if (c.agent) {                                 // a reloaded page numbers its commands from 1 again
        c.agent.lastSeq = 0;
        this.idleInput(c);
      }
      this.welcome(c, { reconnect: true });
      if (this.pausedBy === uid) this.resume();
      return;
    }
    if (String(uid) in this.cfg.roster && mode === "play") team = this.cfg.roster[String(uid)];
    else if (this.duel && mode === "play") mode = "spectate";      // nobody else plays in a duel
    if (mode === "spectate") c = new Client(uid, name, new ClientView(uid, null, null), null, null, this.now());
    else {
      const ti = team === 0 || team === 1 ? team : this.autoTeam();
      const agent = g.addPlayer(name, ti, crc32(`${this.cfg.matchId}:${uid}`) & 0x7fffffff);
      agent.userId = uid;
      c = new Client(uid, name, new ClientView(uid, agent, ti), agent, new InputLimiter(), this.now());
    }
    this.clients.set(uid, c);
    this.departed.delete(uid);
    this.idle = false;
    if (this.firstJoin === null) this.firstJoin = this.now();
    if (!this.started && this.mayStart()) this.start();
    this.welcome(c);
    this.sendRoster();
    this.log(`[match ${this.cfg.matchId}] ${name} joined (${mode}, team ${c.view.team})`);
  }

  private mayStart(): boolean {
    const roster = Object.keys(this.cfg.roster);
    if (roster.length) return roster.every((u) => this.clients.get(Number(u))?.agent);
    return this.cfg.startOnFirstJoin;
  }

  private remove(uid: number): void {
    const c = this.clients.get(uid);
    if (!c) return;
    this.clients.delete(uid);
    if (c.agent) {
      const s = this.statsOf(uid, c);
      if (s && (s.rounds || s.kills || s.deaths)) this.departed.set(uid, s);
      this.game.removePlayer(c.agent);
    }
    this.sendRoster();
    this.log(`[match ${this.cfg.matchId}] ${c.name} left`);
  }

  // ----------------------------------------------------------- duels
  private forfeit(uid: number, why: string): void {
    const d = this.game.director;
    const c = this.clients.get(uid);
    let team: number | null = this.cfg.roster[String(uid)] ?? null;
    if (team === null && c && c.agent && c.agent.team) team = c.agent.team.index;
    if (team === null || d.match.phase === "match_end") return;
    const name = c ? c.name : String(uid);
    this.log(`[match ${this.cfg.matchId}] ${name} forfeits (${why})`);
    this.event({ kind: "forfeit", who: name, why });
    this.pausedBy = null;
    d.match.forfeit(team);
  }

  private resume(): void {
    const u = this.pausedBy as number;
    this.pausedBy = null;
    this.event({ kind: "resumed" });
    this.log(`[match ${this.cfg.matchId}] resumed (${this.clients.get(u)?.name ?? u} back, ${Math.max(this.pauseLeft.get(u) ?? 0, 0).toFixed(0)} s of pause left)`);
  }

  /** While paused nobody moves: commands are acknowledged and dropped. */
  private drainPaused(): void {
    for (const c of this.players()) {
      const a = c.agent as HumanAgent;
      if (a.queue.length) {
        const last = a.queue[a.queue.length - 1];
        a.queue = [];
        a.lastCmd = { ...emptyCmd(), seq: last.seq, yaw: last.yaw, pitch: last.pitch };
      }
    }
  }

  /** Joining, pauses and forfeits; false while the world must not advance. */
  private duelTick(dt: number): boolean {
    const d = this.game.director;
    const roster = Object.keys(this.cfg.roster).map(Number);
    if (!this.started) {
      const waited = this.now() - this.created > this.cfg.joinTimeout;
      if (this.firstJoin !== null && waited) {
        const present = roster.filter((u) => this.clients.has(u));
        if (!present.length) {
          this.reason = "no_show";
          this.running = false;
          return false;
        }
        this.start();
        for (const u of roster) {
          if (!this.clients.has(u)) {
            d.match.forfeit(this.cfg.roster[String(u)]);
            this.event({ kind: "forfeit", who: String(u), why: "did not join" });
            break;
          }
        }
      } else if (this.firstJoin === null && waited) {
        this.reason = "no_show";
        this.running = false;
      }
      return false;
    }
    if (d.match.phase === "match_end") return true;
    const away = roster.filter((u) => this.clients.has(u) && !this.clients.get(u)!.connected);
    if (!away.length) {
      if (this.pausedBy !== null) this.resume();
      return true;
    }
    if (this.pausedBy === null) {
      this.pausedBy = away[0];
      this.pauseNote = 0;
      this.log(`[match ${this.cfg.matchId}] paused: ${this.clients.get(away[0])!.name} disconnected (${(this.pauseLeft.get(away[0]) ?? 0).toFixed(0)} s of pause left)`);
    }
    for (const u of away) {
      this.pauseLeft.set(u, (this.pauseLeft.get(u) ?? this.cfg.pauseBudget) - dt);
      if ((this.pauseLeft.get(u) as number) <= 0) {
        this.forfeit(u, "disconnected");
        return true;
      }
    }
    this.pauseNote -= dt;
    if (this.pauseNote <= 0) {
      this.pauseNote = 1.0;
      const u = this.pausedBy as number;
      this.event({ kind: "paused", who: this.clients.get(u)?.name ?? "?", left: Math.round(Math.max(this.pauseLeft.get(u) ?? 0, 0)) });
    }
    this.drainPaused();
    return false;
  }

  // -------------------------------------------------- public servers
  /** At every round reset, before anyone spawns: balance the teams (start and halftime), and stop an empty
   * server (pauseWhenEmpty). */
  private roundHook(swapped: boolean): void {
    if (this.cfg.balance && swapped) this.balance();
    if (this.cfg.pauseWhenEmpty && !this.players().some((c) => c.connected)) this.idle = true;
  }

  private balance(): void {
    const d = this.game.director;
    const moved: Client[] = [];
    for (let k = 0; k < 10; k++) {
      const teams = d.match.teams.map((t) => this.players().filter((c) => c.agent!.team === t));
      const big = teams[0].length > teams[1].length ? 0 : 1;
      if (teams[big].length - teams[1 - big].length < 2) break;
      const c = teams[big].reduce((a, x) => (x.joined > a.joined ? x : a));      // the most recent joiner moves
      d.moveHuman(c.agent as HumanAgent, 1 - big);
      c.view.team = 1 - big;
      moved.push(c);
    }
    for (const c of moved) {
      this.log(`[match ${this.cfg.matchId}] balance: ${c.name} to team ${c.view.team}`);
      c.view.full = true;
      c.view.sent = new Map();
      this.welcome(c, { moved: true });
    }
    if (moved.length) this.sendRoster();
  }

  /** After the scoreboard: what endAction says. */
  private nextMatch(): void {
    const action = this.cfg.endAction;
    if (action === "stop") {
      this.reason = "ended";
      this.running = false;
      return;
    }
    if (action === "rotate") {
      const rot = this.cfg.rotation.length ? this.cfg.rotation : [this.cfg.map];
      this.rotationIndex = (this.rotationIndex + 1) % rot.length;
      const nxt = rot[this.rotationIndex];
      if (nxt !== this.cfg.map) {
        this.out({ t: "rotate", map: nxt, rotationIndex: this.rotationIndex });
        this.reason = "rotate";
        this.running = false;
        return;
      }
    }
    this.matchNo++;
    this.event({ kind: "new_match", match_no: this.matchNo, map: this.cfg.map });
    this.start();
  }

  // ------------------------------------------------------------- tick
  tick(): void {
    const g = this.game;
    const t0 = performance.now();
    let advance = this.started;
    if (this.duel) advance = this.duelTick(g.loop.dt) && advance;
    else if (!this.started && Object.keys(this.cfg.roster).length && this.firstJoin !== null && this.now() - this.firstJoin > this.cfg.joinTimeout) {
      this.start();                                  // a lobby member never came: bots fill in
      advance = true;
    }
    if (this.idle) {
      if (this.players().some((c) => c.connected)) this.idle = false;
      else advance = false;
    }
    if (advance) g.step();
    this.builder.addFx(g.fx.drain());
    const now = g.loop.time;
    for (const [uid, c] of [...this.clients]) {
      if (this.duel && c.agent) continue;            // duel players are handled by the pause budget
      if (!c.connected && now - c.disconnectedAt > this.cfg.reconnectGrace) this.remove(uid);
    }
    if (!advance) {
      // the clock that disconnect timers use keeps running while the world is paused
      g.loop.time += g.loop.dt;
      g.loop.tickCount++;
    }
    if (this.matchEndT !== null && now - this.matchEndT > this.cfg.restartDelay) {
      this.matchEndT = null;
      this.nextMatch();
    }
    if (g.loop.tickCount % this.snapshotEvery === 0 && this.clients.size) {
      this.builder.capture();
      const wall = this.now();
      const snaps: Array<[number, Uint8Array[]]> = [];
      const transfer: ArrayBuffer[] = [];
      for (const [uid, c] of this.clients) {
        if (!c.connected) continue;
        const data = this.builder.build(c.view, g.loop.tickCount);
        let due: Uint8Array[] = [data];
        if (!c.agent && this.cfg.spectatorDelay > 0) {
          c.delayed.push([wall + this.cfg.spectatorDelay, data]);
          due = [];
          while (c.delayed.length && c.delayed[0][0] <= wall) due.push((c.delayed.shift() as [number, Uint8Array])[1]);
        }
        if (due.length) {
          snaps.push([uid, due]);
          for (const d of due) transfer.push(d.buffer as ArrayBuffer);
        }
      }
      this.builder.endSnapshot();
      if (snaps.length) this.out({ t: "snaps", snaps }, transfer);
    } else if (!this.clients.size) this.builder.clearEvents();
    this.tickMs.push(performance.now() - t0);
  }

  stats(): Json {
    const ms = [...this.tickMs].sort((a, b) => a - b);
    if (!ms.length) ms.push(0);
    const cpu = process.cpuUsage(this.cpu0);
    const wall = performance.now();
    const d = this.game.director;
    const m = d.match;
    const teams = m.teams.map((t) => ({ side: t.side, score: t.score, humans: this.players().filter((c) => c.agent!.team === t).length,
      bots: d.bots.filter((b) => b.team === t).length }));
    const inputs: Json = {};
    for (const [uid, c] of this.clients) {
      if (c.limiter && c.agent) inputs[uid] = { ...c.limiter.stats(), queue_dropped: c.agent.dropped, starved: c.agent.starved, caught_up: c.agent.caughtUp };
    }
    const out = { tick_ms_mean: ms.reduce((s, v) => s + v, 0) / ms.length, tick_ms_p95: ms[Math.trunc(0.95 * (ms.length - 1))],
      tick_ms_max: ms[ms.length - 1], cpu: (cpu.user + cpu.system) / 1000 / Math.max(wall - this.wall0, 1e-3),
      dropped_ticks: this.droppedTicks, players: this.players().length, spectators: [...this.clients.values()].filter((c) => !c.agent).length,
      bots: d.bots.filter((b) => b.active).length, phase: m.phase, round: m.round, score: m.teams.map((t) => t.score), teams,
      map: this.cfg.map, match_no: this.matchNo, rotation_index: this.rotationIndex, idle: this.idle, started: this.started,
      paused: this.pausedBy !== null, overtime: m.overtime,
      bandwidth: Object.fromEntries([...this.clients].map(([uid, c]) => [uid, c.view.bytesSent])), inputs };
    this.tickMs = [];
    this.cpu0 = process.cpuUsage();
    this.wall0 = wall;
    return out;
  }

  /** The real-time loop: one tick every 1/tickRate s; more than 8 ticks behind, the backlog is dropped. */
  run(inbox: () => InMessage[], onStats: () => void): Promise<void> {
    const dt = 1000 / this.cfg.tickRate;
    let next = performance.now();
    let lastStats = next;
    return new Promise((resolve) => {
      const loop = () => {
        for (const m of inbox()) this.handle(m);
        if (!this.running) { resolve(); return; }
        let now = performance.now();
        let n = 0;
        while (now >= next && this.running) {
          this.tick();
          next += dt;
          now = performance.now();
          if (now - next > 8 * dt) {
            this.droppedTicks += Math.trunc((now - next) / dt);
            next = now;
          }
          if (++n >= 8) break;
        }
        if (now - lastStats >= 1000) {
          lastStats = now;
          onStats();
        }
        if (!this.running) { resolve(); return; }
        setTimeout(loop, Math.max(0, next - performance.now() - 0.5));
      };
      loop();
    });
  }
}

