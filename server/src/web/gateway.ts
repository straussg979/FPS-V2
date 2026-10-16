// The game gateway on /ws: who is connected, which match each account is in, the match workers and the
// modes (lobbies, the ranked duel queue, challenges and ready-checks, public servers with vote kicks, chat).
//
// Every connection belongs to a logged-in account: the upgrade reads the signed session cookie and refuses
// anonymous or banned users and foreign Origin headers. One connection per account: a second one replaces
// the first. The server pings every ~20 s and drops connections that stop answering.
//
// Wire format: text frames are JSON {e: event, d: data, id?: n}; a control event with an id is answered
// with {e: "ack", id, d: {ok, ...}}. Binary frames carry a channel byte: CH_INPUT (browser -> server, a
// player's input commands, relayed straight to the match worker, which decodes, validates and rate-limits
// them again) and CH_SNAP (server -> browser, snapshots). Control events are checked against protocol.ts
// and rate-limited per connection.

import { randomInt } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { CH_INPUT, CH_SNAP, INPUT_HEADER } from "@cs/shared/codec";
import type { Json } from "@cs/shared/data";
import { type WebSocket, WebSocketServer } from "ws";
import type { Config } from "../config";
import { availableMaps } from "../paths";
import { ChatLimiter, wordFilter } from "./chat";
import { isBanned, type Repo, type User } from "./db";
import { Challenges, DuelQueue, type ReadyCheck, ReadyChecks } from "./duels";
import { type Lobby, LobbyError, LobbyManager } from "./lobbies";
import { MatchLimit, MatchManager } from "./matches";
import { MAX_INPUT_BYTES, SchemaError, validate } from "./protocol";
import type { ProxyTrust } from "./proxy";
import { record } from "./results";
import { PublicServers, type ServerState, loadSpecs, serverOptions } from "./servers";
import { COOKIE, type SessionCodec, cookieValue } from "./sessions";
import { TokenBucket } from "./security";

export const CONTROL_RATE = 5, CONTROL_BURST = 20;       // control events per second per connection
export const INPUT_RATE = 160, INPUT_BURST = 64;         // input frames per second (normally 64)
const HOUSEKEEPING_MS = 500;
const BROWSER_EVERY = 2.0;
const MAX_TEXT = 8 * 1024;

let nextSid = 1;

export class Connection {
  sid = nextSid++;
  matchId: string | null = null;
  mode: "play" | "spectate" = "play";
  control = new TokenBucket(CONTROL_RATE, CONTROL_BURST);
  inputs = new TokenBucket(INPUT_RATE, INPUT_BURST);
  refused = 0;
  alive = true;
  connected = Date.now();
  rooms = new Set<string>();
  constructor(public ws: WebSocket, public userId: number, public name: string, public ip: string) {}

  send(event: string, data: Json = {}): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify({ e: event, d: data }));
  }
}

type Reply = Json;

export class Gateway {
  bySid = new Map<number, Connection>();
  byUser = new Map<number, Connection>();
  userMatch = new Map<number, [string, "play" | "spectate"]>();      // survives reconnects
  matches: MatchManager;
  lobbies: LobbyManager;
  queue = new DuelQueue();
  challenges = new Challenges();
  readies = new ReadyChecks();
  chatLimit = new ChatLimiter();
  servers: PublicServers;
  maps = availableMaps();
  wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  private rooms = new Map<string, Set<Connection>>();
  private timer: NodeJS.Timeout | null = null;
  private pinger: NodeJS.Timeout | null = null;
  private browserT = 0;
  stopping = false;

  constructor(public cfg: Config, public repo: Repo, public sessions: SessionCodec, public proxy: ProxyTrust,
    public log: (m: string) => void = console.log) {
    this.matches = new MatchManager((mid, kind, payload) => this.deliver(mid, kind, payload), cfg.maxMatches, cfg.tickRate, cfg.snapshotRate, log);
    this.lobbies = new LobbyManager(this.maps.length ? this.maps : ["qalat"]);
    const specs = cfg.serversFile ? (() => {
      try {
        return loadSpecs(cfg.serversFile, this.maps);
      } catch (e) {
        log(`[servers] ${(e as Error).message}`);
        return [];
      }
    })() : [];
    this.servers = new PublicServers(specs, (st) => this.startServer(st), undefined, log);
  }

  start(): void {
    this.timer = setInterval(() => {
      try {
        this.housekeeping();
      } catch (e) {
        this.log(`[gateway] housekeeping: ${(e as Error).stack}`);
      }
    }, HOUSEKEEPING_MS);
    this.pinger = setInterval(() => this.pingAll(), this.cfg.pingInterval * 1000);
    this.servers.startAll();
  }

  /** Stop accepting, tell everyone, stop every match (results of finished matches are already stored). */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.pinger) clearInterval(this.pinger);
    this.servers.stopAll();
    for (const c of this.bySid.values()) {
      c.send("server:shutdown", { text: "The server is restarting. Reconnect in a moment." });
      c.ws.close(1012, "server restarting");
    }
    await this.matches.stopAll(4000);
    this.wss.close();
  }

  // ------------------------------------------------------------ helpers
  toUser(userId: number, event: string, data: Json): boolean {
    const c = this.byUser.get(userId);
    if (!c) return false;
    c.send(event, data);
    return true;
  }

  toMatch(matchId: string, event: string, data: Json, users: Iterable<number> | null = null): void {
    const h = this.matches.matches.get(matchId);
    for (const uid of users ?? (h ? h.users.keys() : [])) {
      const c = this.byUser.get(uid);
      if (c && c.matchId === matchId) c.send(event, data);
    }
  }

  private join_room(c: Connection, room: string): void {
    let s = this.rooms.get(room);
    if (!s) this.rooms.set(room, (s = new Set()));
    s.add(c);
    c.rooms.add(room);
  }

  private leaveRoom(c: Connection, room: string): void {
    this.rooms.get(room)?.delete(c);
    c.rooms.delete(room);
  }

  private toRoom(room: string, event: string, data: Json): void {
    for (const c of this.rooms.get(room) ?? []) c.send(event, data);
  }

  lobbyChanged(lb: Lobby, closed = false): void {
    if (closed) {
      if (lb.matchId) void this.matches.stop(lb.matchId);
      return;
    }
    this.toRoom(`lobby:${lb.code}`, "lobby:state", lb.state());
  }

  // ------------------------------------------------------------ matches
  async createMatch(user: { id: number } | null, options: Json, mode: "bots" | "duel" | "server"): Promise<ReturnType<MatchManager["create"]>> {
    const h = this.matches.create({ ...options, mode });
    if (mode === "bots" && user) h.owner = user.id;
    await this.repo.createMatch({ id: h.id, mode, map: h.config.map, title: h.config.title || "", ranked: !!options.ranked, createdBy: user ? user.id : null });
    return h;
  }

  /** Stop a match its creator started (quick matches, lobby matches). Everyone in it is told who stopped it. */
  stopMatch(userId: number, name: string, matchId: string): [boolean, string] {
    const h = this.matches.get(matchId);
    if (!h) return [false, "that match is not running"];
    if (!h.stoppableBy(userId)) return [false, "only whoever started a bot or lobby match can stop it"];
    this.log(`[matches] ${matchId} stopped by ${name}`);
    void this.matches.stop(matchId, 5000, `stopped by ${name}`);
    return [true, ""];
  }

  private startServer(st: ServerState): string {
    const h = this.matches.create(serverOptions(st.spec, st.rotationIndex, this.cfg.devFastRounds));
    void this.repo.createMatch({ id: h.id, mode: "server", map: h.config.map, title: h.config.title, ranked: false, createdBy: null })
      .catch((e) => this.log(`[db] ${e}`));
    return h.id;
  }

  private deliver(matchId: string, kind: string, payload: Json): void {
    if (kind === "snaps") {
      for (const [uid, parts] of payload as Array<[number, Uint8Array[]]>) {
        const c = this.byUser.get(uid);
        if (!c || c.matchId !== matchId || c.ws.readyState !== c.ws.OPEN) continue;
        for (const part of parts) {
          const frame = Buffer.allocUnsafe(part.length + 1);
          frame[0] = CH_SNAP;
          frame.set(part, 1);
          c.ws.send(frame, { binary: true });
        }
      }
    } else if (kind === "welcome") {
      const c = this.byUser.get(payload.uid);
      if (c && c.matchId === matchId) {
        const lb = this.lobbies.byMatch(matchId);
        const h = this.matches.get(matchId);
        c.send("match:welcome", { ...payload.data, match_id: matchId, interp_ms: this.cfg.interpMs, snapshot_rate: this.cfg.snapshotRate,
          you: c.name, can_stop: !!h && h.stoppableBy(c.userId), ...(lb ? { lobby: lb.code } : {}) });
      }
    } else if (kind === "shop") {
      const c = this.byUser.get(payload.uid);
      if (c && c.matchId === matchId) c.send("shop", payload.data);
    } else if (kind === "ready") this.servers.ready(matchId);
    else if (kind === "result") void this.result(matchId, payload);
    else if (kind === "rotate") this.servers.rotated(matchId, Number(payload.rotation_index ?? 0));
    else if (kind === "closed") void this.closed(matchId, String(payload));
  }

  private async result(matchId: string, result: Json): Promise<void> {
    let changes: Json = {};
    try {
      changes = await record(this.repo, matchId, result);
    } catch (e) {                                  // a result must never take the gateway down
      this.log(`[results] could not record ${matchId}: ${(e as Error).stack}`);
    }
    const lb = this.lobbies.byMatch(matchId);
    const pick = (p: Json) => Object.fromEntries(["name", "team", "kills", "deaths", "assists", "damage", "headshots", "rounds", "score"].map((k) => [k, p[k]]));
    const end: Json = { match_id: matchId, mode: result.mode, ranked: result.ranked, winner_team: result.winner_team, score: result.score,
      rounds: result.rounds, overtime: result.overtime, forfeit: result.forfeit, mvp: result.mvp, match_no: result.match_no,
      players: (result.players ?? []).map(pick), bots: result.bots ?? [], lobby: lb ? lb.code : null,
      ratings: Object.fromEntries(Object.entries(changes).map(([u, ch]) => [String(u), ch])),
      names: Object.fromEntries((result.players ?? []).map((p: Json) => [String(p.user_id), p.name])) };
    const h = this.matches.matches.get(matchId);
    if (h && h.config.endAction === "rotate") end.next_in = h.config.restartDelay;
    this.toMatch(matchId, "match:end", end);
    if (lb) {
      lb.ended(end);
      this.lobbyChanged(lb);
    }
  }

  private async closed(matchId: string, reason: string): Promise<void> {
    let movedTo: string | null = null;
    const st = this.servers.byMatch(matchId);
    if (st) {
      this.servers.closed(matchId, reason);
      if (reason === "rotate" && !this.stopping && this.servers.start(st.spec.id)) movedTo = st.matchId;
    }
    for (const [u, [m]] of [...this.userMatch]) {
      if (m !== matchId) continue;
      this.userMatch.delete(u);
      const c = this.byUser.get(u);
      if (!c) continue;
      c.matchId = null;
      if (movedTo && st) c.send("match:moved", { match_id: movedTo, server_id: st.spec.id });
      else c.send("match:closed", { match_id: matchId, reason });
    }
    const lb = this.lobbies.byMatch(matchId);
    if (lb) {
      lb.ended();
      this.lobbyChanged(lb);
    }
    try {
      await this.repo.closeMatch(matchId, reason);
    } catch (e) {
      this.log(`[db] ${e}`);
    }
  }

  // --------------------------------------------------------- connections
  /** The HTTP upgrade on /ws: origin, session, account, then the WebSocket. */
  async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const refuse = (code: number, text: string) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (this.stopping) return refuse(503, "Service Unavailable");
    const { ip, proto } = this.proxy.resolve(req.socket.remoteAddress, req.headers, (req.socket as { encrypted?: boolean }).encrypted === true);
    const origin = req.headers.origin;
    if (origin && !this.originAllowed(origin, proto, req.headers.host)) {
      this.log(`[ws] refused origin ${origin} from ${ip}`);
      return refuse(403, "Forbidden");
    }
    const s = this.sessions.decode(cookieValue(req.headers.cookie, COOKIE));
    if (!s || s.u === undefined) return refuse(401, "Unauthorized");
    let user: User | null = null;
    try {
      user = await this.repo.userById(s.u);
    } catch {
      return refuse(500, "Internal Server Error");
    }
    if (!user || isBanned(user)) return refuse(403, "Forbidden");
    const u = user;
    this.wss.handleUpgrade(req, socket, head, (ws) => this.connect(ws, u, ip));
  }

  originAllowed(origin: string, proto: string, host: string | undefined): boolean {
    if (this.cfg.allowedOrigins.includes(origin)) return true;
    return !!host && origin === `${proto}://${host}`;
  }

  private connect(ws: WebSocket, user: User, ip: string): void {
    const c = new Connection(ws, user.id, user.username, ip);
    const old = this.byUser.get(user.id);
    this.bySid.set(c.sid, c);
    this.byUser.set(user.id, c);
    if (old && old.sid !== c.sid) {
      this.bySid.delete(old.sid);
      old.send("kicked", { reason: "connected from another tab" });
      old.ws.close(4000, "replaced");
      for (const r of [...old.rooms]) this.leaveRoom(old, r);
    }
    const prev = this.userMatch.get(user.id);
    if (prev) [c.matchId, c.mode] = prev;            // rejoin on match:join (the page asks again)
    const lb = this.lobbies.ofUser(user.id);
    const m = lb?.members.get(user.id);
    if (m) m.online = true;
    ws.on("pong", () => { c.alive = true; });
    ws.on("message", (data, isBinary) => {
      try {
        if (isBinary) this.onBinary(c, data as Buffer);
        else void this.onText(c, data.toString());
      } catch (e) {
        this.log(`[ws] ${c.name}: ${(e as Error).stack}`);
      }
    });
    ws.on("close", () => this.disconnect(c));
    ws.on("error", () => ws.terminate());
    c.send("hello", { user: user.username, user_id: user.id, server_time: Date.now() / 1000 });
  }

  private pingAll(): void {
    for (const c of this.bySid.values()) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {
        c.ws.terminate();
      }
    }
  }

  private disconnect(c: Connection): void {
    for (const r of [...c.rooms]) this.leaveRoom(c, r);
    if (!this.bySid.delete(c.sid)) return;
    if (this.byUser.get(c.userId) !== c) return;
    this.byUser.delete(c.userId);
    if (c.matchId) this.matches.disconnect(c.matchId, c.userId);
    this.queue.leave(c.userId);
    const rc = this.readies.cancelUser(c.userId);
    if (rc) this.readyFailed(rc, c.userId);
    const lb = this.lobbies.offline(c.userId);
    if (lb) this.lobbyChanged(lb);
  }

  private onBinary(c: Connection, data: Buffer): void {
    if (data.length < 1 || data[0] !== CH_INPUT) return void c.refused++;
    if (!c.matchId || c.mode !== "play") return;
    const n = data.length - 1;
    if (n < INPUT_HEADER || n > MAX_INPUT_BYTES) return void c.refused++;
    if (!c.inputs.take()) return void c.refused++;
    this.matches.input(c.matchId, c.userId, new Uint8Array(data.buffer, data.byteOffset + 1, n));
  }

  private async onText(c: Connection, text: string): Promise<void> {
    if (text.length > MAX_TEXT) return void c.refused++;
    let msg: Json;
    try {
      msg = JSON.parse(text);
    } catch {
      return void c.refused++;
    }
    if (!msg || typeof msg !== "object" || typeof msg.e !== "string") return void c.refused++;
    const id = Number.isInteger(msg.id) ? msg.id : null;
    const reply = (d: Reply) => { if (id !== null && c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify({ e: "ack", id, d })); };
    if (!c.control.take()) return reply(this.refuse(c, "rate", "too many requests"));
    let args: Json;
    try {
      args = validate(msg.e, msg.d);
    } catch (e) {
      return reply(this.refuse(c, "schema", (e as SchemaError).message));
    }
    try {
      reply(await this.handle(c, msg.e, args));
    } catch (e) {
      if (e instanceof LobbyError) reply({ ok: false, error: "lobby", text: e.message });
      else {
        this.log(`[ws] ${msg.e} from ${c.name}: ${(e as Error).stack}`);
        reply({ ok: false, error: "server", text: "something went wrong" });
      }
    }
  }

  private refuse(c: Connection, code: string, text: string): Reply {
    c.refused++;
    this.log(`[ws] refused ${code} from ${c.name}: ${text}`);
    return { ok: false, error: code, text };
  }

  // ------------------------------------------------------------- events
  private async handle(c: Connection, event: string, a: Json): Promise<Reply> {
    const fail = (code: string, text: string) => ({ ok: false, error: code, text });
    switch (event) {
      case "ping":
        c.send("pong", { t: a.t, server_time: Date.now() / 1000 });
        return { ok: true };
      case "match:list": return { ok: true, matches: this.matches.list() };
      case "match:join": {
        const [ok, why] = this.join(c, a.match_id, a.as ?? "play", a.team ?? null);
        return ok ? { ok } : { ok, error: "join", text: why };
      }
      case "match:stop": {
        const [ok, why] = this.stopMatch(c.userId, c.name, a.match_id);
        return ok ? { ok: true } : fail("stop", why);
      }
      case "match:leave":
        this.leave(c);
        return { ok: true };
      case "buy": case "sell": case "specialist":
        if (!c.matchId || c.mode !== "play") return fail("state", "not playing");
        this.matches.command(c.matchId, c.userId, event, a.item);
        return { ok: true, queued: true };
      case "lobby:create": {
        const [lb, changed] = this.lobbies.create(c.userId, c.name, a.settings ?? {});
        for (const [old, closed] of changed) {
          this.leaveRoom(c, `lobby:${old.code}`);
          this.lobbyChanged(old, closed);
        }
        this.join_room(c, `lobby:${lb.code}`);
        this.lobbyChanged(lb);
        return { ok: true, code: lb.code, state: lb.state() };
      }
      case "lobby:join": {
        const [lb, changed] = this.lobbies.join(String(a.code).toUpperCase(), c.userId, c.name);
        for (const [old, closed] of changed) {
          this.leaveRoom(c, `lobby:${old.code}`);
          this.lobbyChanged(old, closed);
        }
        this.join_room(c, `lobby:${lb.code}`);
        this.lobbyChanged(lb);
        return { ok: true, code: lb.code, state: lb.state(), you: c.userId };
      }
      case "lobby:leave":
        for (const [lb, closed] of this.lobbies.leave(c.userId)) {
          this.leaveRoom(c, `lobby:${lb.code}`);
          this.lobbyChanged(lb, closed);
        }
        return { ok: true };
      case "lobby:update": {
        const lb = this.myLobby(c);
        lb.update(c.userId, a.settings);
        this.lobbyChanged(lb);
        return { ok: true };
      }
      case "lobby:team": {
        const lb = this.myLobby(c);
        lb.setTeam(c.userId, a.team);
        this.lobbyChanged(lb);
        return { ok: true };
      }
      case "lobby:start": {
        const lb = this.myLobby(c);
        const opts: Json = lb.start(c.userId);
        opts.fastRounds = this.cfg.devFastRounds;
        try {
          const h = await this.createMatch({ id: c.userId }, opts, "bots");
          lb.started(h.id);
          this.lobbyChanged(lb);
          return { ok: true, match_id: h.id };
        } catch (e) {
          lb.failed();
          this.lobbyChanged(lb);
          if (e instanceof MatchLimit) return fail("full", e.message);
          throw e;
        }
      }
      case "lobby:reopen": {
        const lb = this.myLobby(c);
        lb.reopen(c.userId);
        this.lobbyChanged(lb);
        return { ok: true };
      }
      case "queue:join": {
        const busy = this.busy(c);
        if (busy) return fail("busy", busy);
        const r = await this.repo.ratingOf(c.userId);
        this.queue.join(c.userId, c.name, r.rating, r.rd);
        const st = this.queue.status(c.userId);
        c.send("queue:status", st);
        return { ok: true, status: st };
      }
      case "queue:leave":
        this.queue.leave(c.userId);
        return { ok: true };
      case "challenge:send": {
        const name = a.username as string | undefined;
        let target: User | null = null;
        if (name) {
          target = await this.repo.userByName(name);
          if (!target) return fail("challenge", "no player with that name");
          if (target.id === c.userId) return fail("challenge", "you can't challenge yourself");
        }
        const ch = this.challenges.create(c.userId, c.name, target ? target.id : null, target ? target.username : "");
        const delivered = target ? this.toUser(target.id, "challenge:incoming", ch.info()) : false;
        return { ok: true, ...ch.info(), delivered };
      }
      case "challenge:respond": {
        const token = a.token as string;
        if (!a.accept) {
          const ch = this.challenges.decline(token, c.userId);
          if (ch) this.toUser(ch.fromId, "challenge:declined", { token, by: c.name });
          return { ok: true };
        }
        const busy = this.busy(c);
        if (busy) return fail("busy", busy);
        const ch = this.challenges.take(token, c.userId);
        if (!ch) return fail("challenge", "this challenge has expired or was already answered");
        if (!this.byUser.has(ch.fromId)) return fail("challenge", `${ch.fromName} is not online right now`);
        this.queue.leave(c.userId);
        this.queue.leave(ch.fromId);
        const rc = this.readies.create([ch.fromId, ch.fromName], [c.userId, c.name], false);
        await this.readyFound(rc);
        return { ok: true, match_token: rc.token };
      }
      case "ready": {
        const [status, rc] = this.readies.answer(a.match_token, c.userId, a.ready);
        if (!rc) return fail("ready", "this ready-check is over");
        if (status === "declined") await this.readyFailed(rc, c.userId);
        else if (status === "go") {
          for (const [uid] of rc.players) this.toUser(uid, "ready:state", { ...rc.state(), status: "go" });
          await this.startDuel(rc);
        } else for (const [uid] of rc.players) this.toUser(uid, "ready:state", { ...rc.state(), status: "waiting" });
        return { ok: true, status };
      }
      case "browser:watch":
        this.join_room(c, "browser");
        return { ok: true, servers: this.browserRows() };
      case "browser:unwatch":
        this.leaveRoom(c, "browser");
        return { ok: true };
      case "server:join": {
        const st = this.servers.get(a.server_id);
        if (!st || !st.matchId || !this.matches.get(st.matchId)) return fail("server", "that server is not running right now");
        const wait = this.servers.bannedFor(st.spec.id, c.userId);
        if (wait > 0) return fail("kicked", `you were kicked from this server (${Math.floor(wait / 60) + 1} min left)`);
        const mode = a.as ?? "play";
        if (mode === "play" && Object.keys(this.matches.players(st.matchId)).length >= st.spec.maxPlayers) return fail("full", "the server is full (you can spectate)");
        return { ok: true, match_id: st.matchId, url: `/game/${st.matchId}?as=${mode}` };
      }
      case "vote:kick": {
        const h = c.matchId ? this.matches.get(c.matchId) : null;
        if (!h || !h.config.serverId) return fail("vote", "vote kicks are for public servers");
        const players = this.matches.players(h.id);
        const entry = Object.entries(players).find(([, r]) => r.slot === a.target);
        if (!entry) return fail("vote", "that is not a player");
        const target = Number(entry[0]);
        const [ok, why] = this.servers.startVote(h.config.serverId, c.userId, target, entry[1].name, new Set(Object.keys(players).map(Number)));
        if (!ok) return fail("vote", why);
        const st = this.servers.get(h.config.serverId) as ServerState;
        this.toMatch(h.id, "vote:state", { ...st.vote!.state(this.servers.clock()), by: c.name });
        return { ok: true };
      }
      case "vote:cast": {
        const h = c.matchId ? this.matches.get(c.matchId) : null;
        if (!h || !h.config.serverId) return fail("vote", "no vote here");
        const v = this.servers.cast(h.config.serverId, c.userId, a.yes);
        if (!v) return fail("vote", "no vote is running");
        this.toMatch(h.id, "vote:state", v.state(this.servers.clock()));
        for (const [st, vote, res] of this.servers.resolveVotes()) this.voteDone(st, vote, res);
        return { ok: true };
      }
      case "chat": {
        const [ok, wait] = this.chatLimit.allow(c.userId);
        if (!ok) return fail("rate", `slow down (${Math.round(wait)} s)`);
        const [text, masked] = wordFilter().clean(a.text);
        if (!text) return fail("chat", "empty message");
        if (a.scope === "lobby") {
          const lb = this.lobbies.ofUser(c.userId);
          if (!lb) return fail("chat", "you are not in a lobby");
          this.toRoom(`lobby:${lb.code}`, "chat:msg", { from: c.name, text, scope: "lobby" });
        } else {
          if (!c.matchId) return fail("chat", "you are not in a match");
          this.matches.chat(c.matchId, c.userId, a.scope, text);
        }
        return { ok: true, text, masked };
      }
    }
    return fail("unknown", "unknown event");
  }

  private myLobby(c: Connection): Lobby {
    const lb = this.lobbies.ofUser(c.userId);
    if (!lb) throw new LobbyError("you are not in a lobby");
    return lb;
  }

  join(c: Connection, matchId: string, mode: "play" | "spectate", team: number | null): [boolean, string] {
    const h = this.matches.get(matchId);
    if (!h) return [false, "no such match"];
    const sid = h.config.serverId;
    if (sid) {
      const wait = this.servers.bannedFor(sid, c.userId);
      if (wait > 0) return [false, `you were kicked from this server (${Math.floor(wait / 60) + 1} min left)`];
    }
    const lb = this.lobbies.byMatch(matchId);
    if (lb && mode === "play") {
      const t = lb.teamOf(c.userId);
      if (t === 0 || t === 1) team = t;
      else mode = "spectate";
    }
    if (h.config.mode === "duel" && !(String(c.userId) in h.config.roster)) mode = "spectate";
    if (c.matchId && c.matchId !== matchId) {
      this.matches.leave(c.matchId, c.userId);
      this.userMatch.delete(c.userId);
    }
    const prev = h.users.get(c.userId);
    if (prev) mode = prev.mode as "play" | "spectate";      // a reconnect keeps the slot
    else if (sid && mode === "play") {
      const st = this.servers.get(sid);
      if (st && Object.keys(this.matches.players(matchId)).length >= st.spec.maxPlayers) return [false, "the server is full (you can spectate)"];
    }
    c.matchId = matchId;
    c.mode = mode;
    this.userMatch.set(c.userId, [matchId, mode]);
    this.matches.join(matchId, c.userId, c.name, mode, team);
    return [true, ""];
  }

  leave(c: Connection): void {
    if (c.matchId) this.matches.leave(c.matchId, c.userId);
    this.userMatch.delete(c.userId);
    c.matchId = null;
  }

  inMatch(userId: number, matchId: string): boolean { return this.userMatch.get(userId)?.[0] === matchId; }

  // --------------------------------------------------------------- duels
  private busy(c: Connection): string | null {
    const h = c.matchId ? this.matches.get(c.matchId) : null;
    if (h && c.mode === "play" && h.config.mode === "duel") return "you are in a duel";
    if (this.readies.ofUser(c.userId)) return "a duel is waiting for your answer";
    return null;
  }

  private async readyFound(rc: ReadyCheck): Promise<void> {
    const [[a, an], [b, bn]] = rc.players;
    for (const [uid, other, otherName] of [[a, b, bn], [b, a, an]] as Array<[number, number, string]>) {
      const r = rc.ranked ? await this.repo.ratingOf(other) : null;
      this.toUser(uid, "queue:found", { match_token: rc.token, ranked: rc.ranked, opponent: otherName, opponent_rating: r ? Math.round(r.rating) : null,
        seconds: this.readies.seconds });
    }
  }

  /** A ready-check was declined or timed out: tell both; in ranked, who accepted queues again. */
  private async readyFailed(rc: ReadyCheck, declinedBy: number | null = null): Promise<void> {
    for (const [uid, name] of rc.players) {
      const back = rc.ranked && uid !== declinedBy && (declinedBy !== null || rc.ready.has(uid)) && this.byUser.has(uid);
      if (back) {
        const r = await this.repo.ratingOf(uid);
        this.queue.join(uid, name, r.rating, r.rd);
      }
      this.toUser(uid, "ready:state", { match_token: rc.token, status: "cancelled", requeued: back, reason: declinedBy !== null ? "declined" : "timeout" });
    }
  }

  private async startDuel(rc: ReadyCheck): Promise<void> {
    let [[a, an], [b, bn]] = rc.players;
    if (randomInt(2) === 1) [[a, an], [b, bn]] = [[b, bn], [a, an]];
    const fast = this.cfg.devFastRounds;
    const opts = { preset: "duel", ranked: rc.ranked, roster: { [String(a)]: 0, [String(b)]: 1 }, bots: [0, 0], startOnFirstJoin: false,
      joinTimeout: 60, endAction: "stop", spectatorDelay: this.cfg.duelSpectatorDelay, title: `${an} vs ${bn}`, fastRounds: fast,
      restartDelay: fast ? 4 : 10 };
    try {
      const h = await this.createMatch(null, opts, "duel");
      for (const uid of [a, b]) this.toUser(uid, "match:start", { match_id: h.id, url: `/game/${h.id}`, mode: "duel" });
    } catch (e) {
      for (const [uid] of rc.players) this.toUser(uid, "ready:state", { match_token: rc.token, status: "cancelled", reason: (e as Error).message });
    }
  }

  // -------------------------------------------------------- housekeeping
  private housekeeping(): void {
    for (const [a, b] of this.queue.match()) {
      const rc = this.readies.create([a.userId, a.name], [b.userId, b.name], true);
      void this.readyFound(rc);
    }
    for (const rc of this.readies.expired()) void this.readyFailed(rc);
    this.challenges.expire();
    for (const [lb, closed] of this.lobbies.expire((u, m) => this.inMatch(u, m))) this.lobbyChanged(lb, closed);
    if (!this.stopping) for (const sid of this.servers.due()) this.servers.start(sid);
    for (const [st, vote, res] of this.servers.resolveVotes()) this.voteDone(st, vote, res);
    const now = performance.now() / 1000;
    if (now - this.browserT >= BROWSER_EVERY) {
      this.browserT = now;
      if (this.rooms.get("browser")?.size) this.toRoom("browser", "browser:update", { servers: this.browserRows() });
      for (const uid of this.queue.entries.keys()) {
        const st = this.queue.status(uid);
        if (st) this.toUser(uid, "queue:status", st);
      }
      for (const st of this.servers.states.values()) {
        if (st.vote && st.matchId) this.toMatch(st.matchId, "vote:state", st.vote.state(this.servers.clock()));
      }
    }
  }

  browserRows(): Json[] {
    return this.servers.rows((mid) => this.matches.get(mid)?.summary() ?? null);
  }

  private voteDone(st: ServerState, vote: { target: number; targetName: string; yes: Set<number>; needed(): number }, res: string): void {
    const mid = st.matchId;
    if (mid) this.toMatch(mid, "vote:state", { target: vote.targetName, result: res, yes: vote.yes.size, needed: vote.needed() });
    if (res !== "passed" || !mid) return;
    const c = this.byUser.get(vote.target);
    this.matches.leave(mid, vote.target);
    this.userMatch.delete(vote.target);
    if (c && c.matchId === mid) {
      c.matchId = null;
      c.send("kicked", { reason: "kicked by vote (30 minutes)" });
    }
  }
}
