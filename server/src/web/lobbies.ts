// Bot-match lobbies. Pure state: the gateway calls these methods and broadcasts Lobby.state().
// States: open (members pick teams, the host sets the match up) -> starting (the match worker is loading) ->
// live -> ended (the host's "play again" returns to open with the same code). If the host leaves, the member
// who joined next becomes host. A lobby with no members closes (and its match stops).
// Teams: team 0 starts on attack (size_attack), team 1 on defence (size_defend). Each team takes up to its
// size in players, bots fill the rest. humans_vs_bots puts every player on team 0 against a team of bots.
// Up to 10 players; anyone else spectates.

import { randomInt } from "node:crypto";
import type { Json } from "@cs/shared/data";
import type { MatchConfig } from "../match/server";

export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";     // no I, O, 0 or 1
export const CODE_LEN = 6;
export const MAX_HUMANS = 10;
export const MAX_MEMBERS = 20;
export const OFFLINE_GRACE = 60.0;

export const DIFFICULTIES = ["easy", "normal", "hard", "expert"];
export const PRESETS = ["full", "short"];
export const SETTINGS: Settings = { map: "qalat", difficulty: "normal", size_attack: 5, size_defend: 5, humans_vs_bots: false,
  friendly_fire: false, preset: "full" };

export interface Settings { map: string; difficulty: string; size_attack: number; size_defend: number; humans_vs_bots: boolean; friendly_fire: boolean; preset: string }
export type TeamChoice = 0 | 1 | "spectate";

export class LobbyError extends Error {}

const now = () => performance.now() / 1000;

export class Member {
  online = true;
  offlineSince = 0;
  joined = now();
  constructor(public userId: number, public name: string, public team: TeamChoice = "spectate") {}
}

export function newCode(taken: Set<string> | Map<string, unknown>): string {
  for (;;) {
    let code = "";
    for (let i = 0; i < CODE_LEN; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    if (!taken.has(code)) return code;
  }
}

/** current with changes laid over it, every value checked (LobbyError). */
export function checkSettings(changes: Json, current: Settings = SETTINGS, maps: string[] = ["qalat"]): Settings {
  const out: Json = { ...current };
  for (const [k, v] of Object.entries(changes ?? {})) {
    if (!(k in SETTINGS)) throw new LobbyError(`unknown setting ${k}`);
    if ((k === "map" && !maps.includes(v as string)) || (k === "difficulty" && !DIFFICULTIES.includes(v as string))
      || (k === "preset" && !PRESETS.includes(v as string))) throw new LobbyError(`${k}: not allowed`);
    if ((k === "size_attack" || k === "size_defend") && (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 5)) throw new LobbyError(`${k}: 1-5`);
    if ((k === "humans_vs_bots" || k === "friendly_fire") && typeof v !== "boolean") throw new LobbyError(`${k}: true or false`);
    out[k] = v;
  }
  return out as Settings;
}

export class Lobby {
  settings: Settings;
  members = new Map<number, Member>();
  host: number;
  status: "open" | "starting" | "live" | "ended" = "open";
  matchId: string | null = null;
  created = now();
  lastResult: Json | null = null;

  constructor(public code: string, hostId: number, hostName: string, settings: Json = {}, public maps: string[] = ["qalat"]) {
    this.settings = checkSettings(settings, SETTINGS, maps);
    this.host = hostId;
    this.join(hostId, hostName);
  }

  size(team: number): number { return team === 0 ? this.settings.size_attack : this.settings.size_defend; }

  players(team: number | null = null): Member[] {
    return [...this.members.values()].filter((m) => m.team !== "spectate" && (team === null || m.team === team));
  }

  /** How many players a team takes. */
  capacity(team: number): number {
    if (this.settings.humans_vs_bots) return team === 0 ? this.size(0) : 0;
    return this.size(team);
  }

  /** A team with room for one more player, or "spectate". */
  private openTeam(prefer: TeamChoice | null = null): TeamChoice {
    if (this.players().length >= MAX_HUMANS) return "spectate";
    const order: Array<0 | 1> = prefer === 0 || prefer === 1 ? [prefer] : [];
    order.push(...([0, 1] as Array<0 | 1>).sort((a, b) => this.players(a).length - this.players(b).length || a - b));
    for (const t of order) if (this.players(t).length < this.capacity(t)) return t;
    return "spectate";
  }

  join(userId: number, name: string): Member {
    const m = this.members.get(userId);
    if (m) {
      m.online = true;
      return m;
    }
    if (this.members.size >= MAX_MEMBERS) throw new LobbyError("the lobby is full");
    const nm = new Member(userId, name, this.openTeam());
    this.members.set(userId, nm);
    if (!this.members.has(this.host)) this.host = userId;
    return nm;
  }

  /** Remove a member; true when the lobby is now empty. */
  leave(userId: number): boolean {
    if (!this.members.delete(userId)) return this.members.size === 0;
    if (this.host === userId && this.members.size) this.host = [...this.members.values()].reduce((a, m) => (m.joined < a.joined ? m : a)).userId;
    return this.members.size === 0;
  }

  setTeam(userId: number, team: TeamChoice): void {
    const m = this.member(userId);
    if (team === m.team) return;
    if (team === 0 || team === 1) {
      if (this.players(team).length >= this.capacity(team)) throw new LobbyError("that team is full");
      if (m.team === "spectate" && this.players().length >= MAX_HUMANS) throw new LobbyError(`at most ${MAX_HUMANS} players`);
    } else if (team !== "spectate") throw new LobbyError("team: 0, 1 or spectate");
    m.team = team;
  }

  update(userId: number, changes: Json): void {
    this.hostOnly(userId);
    if (this.status !== "open") throw new LobbyError("the match has started");
    this.settings = checkSettings(changes, this.settings, this.maps);
    // players who no longer fit move to a team with room or watch; the most recent joiners move first
    for (const m of [...this.players()].sort((a, b) => b.joined - a.joined)) {
      if (m.team !== "spectate" && this.players(m.team).length > this.capacity(m.team)) {
        m.team = "spectate";
        m.team = this.openTeam();
      }
    }
  }

  private member(userId: number): Member {
    const m = this.members.get(userId);
    if (!m) throw new LobbyError("not in this lobby");
    return m;
  }

  private hostOnly(userId: number): void { if (userId !== this.host) throw new LobbyError("only the host can do that"); }

  /** The host starts the match: the options for MatchManager.create (status starting). */
  start(userId: number): Partial<MatchConfig> {
    this.hostOnly(userId);
    if (this.status !== "open") throw new LobbyError("the match has already started");
    this.status = "starting";
    return this.matchOptions();
  }

  matchOptions(): Partial<MatchConfig> {
    const s = this.settings;
    const fill: [number, number] = [s.humans_vs_bots ? 0 : this.size(0), this.size(1)];
    const humans = [this.players(0).length, this.players(1).length];
    const roster: Record<string, number> = {};
    for (const m of this.players()) roster[String(m.userId)] = m.team as number;
    return { map: s.map, difficulty: s.difficulty, preset: s.preset, friendlyFire: s.friendly_fire, mode: "bots", fill,
      bots: [Math.max(0, fill[0] - humans[0]), Math.max(0, fill[1] - humans[1])], roster, startOnFirstJoin: false, joinTimeout: 25,
      endAction: "stop", title: `Lobby ${this.code}` };
  }

  started(matchId: string): void {
    this.status = "live";
    this.matchId = matchId;
  }

  failed(): void {
    this.status = "open";
    this.matchId = null;
  }

  ended(result: Json | null = null): void {
    if (result) this.lastResult = result;
    if (this.status === "starting" || this.status === "live") this.status = "ended";
  }

  /** Play again: back to open with the same code and teams. */
  reopen(userId: number): void {
    this.hostOnly(userId);
    if (this.status !== "ended") throw new LobbyError("the match is still running");
    this.status = "open";
    this.matchId = null;
  }

  teamOf(userId: number): TeamChoice | null { return this.members.get(userId)?.team ?? null; }

  state(): Json {
    return { code: this.code, host: this.host, status: this.status, match_id: this.matchId, settings: { ...this.settings }, maps: this.maps,
      members: [...this.members.values()].sort((a, b) => a.joined - b.joined).map((m) => ({ user_id: m.userId, name: m.name, team: m.team,
        online: m.online, host: m.userId === this.host })),
      capacity: [this.capacity(0), this.capacity(1)], max_humans: MAX_HUMANS, last_result: this.lastResult };
  }
}

export class LobbyManager {
  lobbies = new Map<string, Lobby>();
  userLobby = new Map<number, string>();
  constructor(public maps: string[] = ["qalat"]) {}

  get(code: string): Lobby | null { return this.lobbies.get((code || "").toUpperCase()) ?? null; }

  ofUser(userId: number): Lobby | null {
    const code = this.userLobby.get(userId);
    return code ? this.lobbies.get(code) ?? null : null;
  }

  byMatch(matchId: string): Lobby | null { return [...this.lobbies.values()].find((lb) => lb.matchId === matchId) ?? null; }

  /** A new lobby with this user as host: [lobby, [lobbies changed by leaving the old one]]. */
  create(userId: number, name: string, settings: Json = {}): [Lobby, Array<[Lobby, boolean]>] {
    const changed = this.leave(userId);
    const lb = new Lobby(newCode(this.lobbies), userId, name, settings, this.maps);
    this.lobbies.set(lb.code, lb);
    this.userLobby.set(userId, lb.code);
    return [lb, changed];
  }

  join(code: string, userId: number, name: string): [Lobby, Array<[Lobby, boolean]>] {
    const lb = this.get(code);
    if (!lb) throw new LobbyError("no lobby with that code");
    let changed: Array<[Lobby, boolean]> = [];
    if (this.userLobby.get(userId) !== lb.code) changed = this.leave(userId);
    lb.join(userId, name);
    this.userLobby.set(userId, lb.code);
    return [lb, changed];
  }

  /** The user leaves their lobby: [[lobby, closed]]. */
  leave(userId: number): Array<[Lobby, boolean]> {
    const code = this.userLobby.get(userId);
    this.userLobby.delete(userId);
    const lb = code ? this.lobbies.get(code) : undefined;
    if (!lb) return [];
    const empty = lb.leave(userId);
    if (empty) this.lobbies.delete(lb.code);
    return [[lb, empty]];
  }

  offline(userId: number): Lobby | null {
    const lb = this.ofUser(userId);
    const m = lb?.members.get(userId);
    if (m) {
      m.online = false;
      m.offlineSince = now();
    }
    return lb;
  }

  /** Members offline longer than grace and not playing the lobby's match leave: [[lobby, closed]]. */
  expire(inMatch: (userId: number, matchId: string) => boolean, grace = OFFLINE_GRACE): Array<[Lobby, boolean]> {
    const t = now();
    const out: Array<[Lobby, boolean]> = [];
    for (const lb of [...this.lobbies.values()]) {
      for (const m of [...lb.members.values()]) {
        if (m.online || t - m.offlineSince < grace) continue;
        if (lb.matchId !== null && inMatch(m.userId, lb.matchId)) continue;
        out.push(...this.leave(m.userId));
      }
    }
    return out;
  }
}
