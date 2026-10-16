// The connection to the match: the WebSocket (common/socket.ts, wss://<host>/ws, reconnecting with backoff),
// the binary codec (shared/codec.ts), the server clock estimate and the snapshot history the renderer
// interpolates from (100 ms behind, up to 50 ms of extrapolation, then hold). `?lag=100` (and `?jitter=`)
// on the game page adds an artificial round trip for testing: half on the way out, half on the way back.

import { CH_INPUT, CH_SNAP, type Snapshot, decodeSnapshot, encodeInput } from "@cs/shared/codec";
import type { InputCmd } from "@cs/shared/commands";
import { type Ack, GameSocket } from "../common/socket";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Entity { kind: number; f: Record<string, any> }
export interface HistoryEntry { tick: number; soldiers: Map<number, Record<string, any>> }

/** A client's picture of the world, built from the delta snapshots. */
export class NetState {
  entities = new Map<number, Entity>();
  match: Record<string, any> | null = null;
  self: Record<string, any> | null = null;
  seq = 0;
  tick = 0;

  apply(snap: Snapshot): void {
    if (snap.full) this.entities.clear();
    for (const [id, e] of snap.entities) {
      const cur = this.entities.get(id);
      if (!cur || cur.kind !== e.kind) this.entities.set(id, { kind: e.kind, f: { ...e.fields } });
      else Object.assign(cur.f, e.fields);
    }
    for (const id of snap.removed) this.entities.delete(id);
    this.match = snap.match;
    this.self = snap.self;
    this.seq = snap.seq;
    this.tick = snap.tick;
  }

  ofKind(kind: number): Array<[number, Record<string, any>]> {
    const out: Array<[number, Record<string, any>]> = [];
    for (const [id, e] of this.entities) if (e.kind === kind) out.push([id, e.f]);
    return out;
  }
}

type Listener = (...args: any[]) => void;

export class Net {
  socket = new GameSocket();
  state = new NetState();
  welcome: any = null;
  userId: number | null = null;
  self: Record<string, any> | null = null;
  selfAck = 0;
  history: HistoryEntry[] = [];
  tickRate = 64;
  interpTicks = 6.4;
  tickOffset: number | null = null;
  /** The render clock (see renderTick): its value, when it was last advanced, and its current rate (1 = real time). */
  private clock: number | null = null;
  private clockAt = 0;
  clockRate = 1;
  /** Render-clock statistics for the debug overlay: hard resets and the accumulated |rate - 1| time. */
  clockStats = { resets: 0, adjustSeconds: 0 };
  /** Recent clock-offset samples (server tick minus local tick at arrival) and when they arrived. */
  private offsetSamples: Array<[number, number]> = [];
  rtt: number | null = null;
  bytes = 0;
  since = performance.now();
  connected = false;
  private listeners = new Map<string, Listener[]>();
  private outAt = 0;
  private inAt = 0;
  log: Array<[number, string]> = [];

  constructor(public matchId: string, public mode: string, private opts: { team: number | null; lag: number; jitter: number }) {}

  on(name: string, cb: Listener): void { this.listeners.set(name, [...(this.listeners.get(name) ?? []), cb]); }
  private emit(name: string, ...args: any[]): void { for (const cb of this.listeners.get(name) ?? []) cb(...args); }
  private note(what: string): void { this.log.push([Math.round(performance.now()), what]); if (this.log.length > 50) this.log.shift(); }

  connect(): void {
    const s = this.socket;
    s.on("connect", async () => {
      this.note("connected");
      this.connected = true;
      this.emit("status", "joining");
      const join: any = { match_id: this.matchId, as: this.mode };
      if (this.opts.team === 0 || this.opts.team === 1) join.team = this.opts.team;
      const r = await s.call("match:join", join);
      if (!r.ok) this.emit("error", r.text ?? "could not join");
    });
    s.on("disconnect", (d) => {
      this.note(`disconnected ${d?.code ?? ""}`);
      this.connected = false;
      this.emit("status", "connection lost, reconnecting…");
    });
    s.on("hello", (m) => { this.userId = m.user_id; });
    s.on("match:welcome", (w) => { this.note(w.reconnect ? "welcome (reconnect)" : "welcome"); this.onWelcome(w); });
    s.on("match:closed", (m) => this.emit("closed", m));
    s.on("kicked", (m) => this.emit("kicked", m));
    s.on("server:shutdown", (m) => this.emit("status", m.text));
    s.on("pong", (m) => this.delayed("in", () => { this.rtt = performance.now() - m.t; }));
    s.on("shop", (m) => this.emit("shop", m));
    s.on("match:end", (m) => this.emit("end", m));
    s.on("match:moved", (m) => this.emit("moved", m));
    s.on("vote:state", (m) => this.emit("vote", m));
    s.onBinary((buf) => this.delayed("in", () => this.onSnap(buf)));
    setInterval(() => {
      const t = Math.round(performance.now());
      if (s.connected) this.delayed("out", () => s.send("ping", { t }));
    }, 2000);
    s.connect();
  }

  private onWelcome(w: any): void {
    this.welcome = w;
    this.state = new NetState();
    this.history.length = 0;
    this.tickOffset = null;
    this.clock = null;
    this.offsetSamples.length = 0;
    this.self = null;
    this.tickRate = w.tick_rate || 64;
    this.interpTicks = (w.interp_ms || 100) / 1000 * this.tickRate;
    this.since = performance.now();
    this.bytes = 0;
    this.emit("welcome", w);
  }

  private onSnap(buf: ArrayBuffer): void {
    if (!this.welcome) return;
    const data = new Uint8Array(buf);
    if (data[0] !== CH_SNAP) return;
    let snap: Snapshot;
    try {
      snap = decodeSnapshot(data.subarray(1));
    } catch (err) {
      this.emit("error", `bad snapshot: ${(err as Error).message}`);
      return;
    }
    this.state.apply(snap);
    this.bytes += buf.byteLength;
    this.noteOffset(snap.tick, performance.now());
    if (snap.self) {
      this.self = snap.self;
      this.selfAck = snap.ackCmd;
    }
    const soldiers = new Map<number, Record<string, any>>();
    for (const [id, e] of this.state.entities) if (e.kind === 1) soldiers.set(id, { ...e.f, pos: [...e.f.pos], vel: e.f.vel ? [...e.f.vel] : [0, 0, 0] });
    this.history.push({ tick: snap.tick, soldiers });
    while (this.history.length > 64) this.history.shift();
    this.emit("snapshot", snap);
  }

  /** Clock offset estimate. A snapshot that arrives late gives a smaller sample (sample = true offset - delay), so the
   *  largest sample of the last ~1.5 s is the least delayed one: jitter only ever lowers samples, never raises
   *  the estimate. The estimate moves toward that maximum slowly; only a large change (a stall, a reconnect)
   *  resets it. */
  private noteOffset(tick: number, now: number): void {
    const sample = tick - now * this.tickRate / 1000;
    const s = this.offsetSamples;
    s.push([now, sample]);
    while (s.length && now - s[0][0] > 1500) s.shift();
    let best = -Infinity;
    for (const [, v] of s) if (v > best) best = v;
    if (this.tickOffset === null || Math.abs(best - this.tickOffset) > this.tickRate / 4) this.tickOffset = best;
    else this.tickOffset += (best - this.tickOffset) * 0.1;
  }

  serverTick(now = performance.now()): number { return this.tickOffset === null ? 0 : now * this.tickRate / 1000 + this.tickOffset; }

  /** How far (ticks) the render clock is from where it is being steered to (debug overlay). */
  clockError(now = performance.now()): number {
    return this.clock === null || this.tickOffset === null ? 0 : this.serverTick(now) - this.interpTicks - this.clock;
  }

  /** The tick the world is drawn at (interpTicks behind the server). A monotonic clock: it advances with real time
   *  and is steered toward the target by running 1-3 % fast or slow, so it never goes backwards and never jumps
   *  when a snapshot arrives (only a gap of more than a quarter second, e.g. after a stall, resets it). The
   *  commands carry this value as their view tick, so the server rewinds to exactly what was on screen. */
  renderTick(now = performance.now()): number {
    if (this.tickOffset === null) return 0;
    const target = this.serverTick(now) - this.interpTicks;
    if (this.clock === null || Math.abs(target - this.clock) > this.tickRate / 4) {
      if (this.clock !== null) this.clockStats.resets++;
      this.clock = target;
      this.clockAt = now;
      this.clockRate = 1;
      return target;
    }
    const elapsed = now - this.clockAt;
    if (elapsed <= 0) return this.clock;
    // proportional steering: half a tick behind runs 1.5 % fast; never more than 3 % either way
    const err = target - this.clock;
    this.clockRate = 1 + Math.max(-0.03, Math.min(0.03, err * 0.03));
    this.clock += elapsed * this.tickRate / 1000 * this.clockRate;
    this.clockAt = now;
    this.clockStats.adjustSeconds += Math.abs(this.clockRate - 1) * elapsed / 1000;
    return this.clock;
  }

  /** The two history entries around `tick` and the blend between them. Past the newest snapshot the blend goes
   *  above 1 (overTicks says by how much); the caller extrapolates from it with a soft limit (main.ts). */
  bracket(tick: number): [HistoryEntry, HistoryEntry, number] | null {
    const h = this.history;
    if (!h.length) return null;
    this.overTicks = 0;
    if (tick <= h[0].tick) return this.br(h[0], h[0], 0);
    const last = h[h.length - 1];
    if (tick >= last.tick) {
      const prev = h.length > 1 ? h[h.length - 2] : last;
      this.overTicks = tick - last.tick;
      return this.br(prev, last, last.tick > prev.tick ? 1 + this.overTicks / (last.tick - prev.tick) : 1);
    }
    for (let i = h.length - 1; i > 0; i--) if (h[i - 1].tick <= tick) return this.br(h[i - 1], h[i], (tick - h[i - 1].tick) / Math.max(1, h[i].tick - h[i - 1].tick));
    return this.br(h[0], h[0], 0);
  }
  /** Ticks past the newest snapshot at the last bracket() call (0 while interpolating). */
  overTicks = 0;
  private brOut: [HistoryEntry, HistoryEntry, number] = [{ tick: 0, soldiers: new Map() }, { tick: 0, soldiers: new Map() }, 0];
  private br(a: HistoryEntry, b: HistoryEntry, t: number): [HistoryEntry, HistoryEntry, number] {
    const o = this.brOut;
    o[0] = a; o[1] = b; o[2] = t;
    return o;
  }

  sendCommands(cmds: InputCmd[]): void {
    if (!this.welcome || !this.socket.connected || !cmds.length) return;
    const data = encodeInput(this.state.seq, cmds);
    this.delayed("out", () => this.socket.sendBinary(CH_INPUT, data));
  }

  /** Run fn after the artificial one-way delay, keeping the order (TCP never reorders). */
  private delayed(dir: "in" | "out", fn: () => void): void {
    if (!this.opts.lag && !this.opts.jitter) { fn(); return; }
    const now = performance.now();
    const key = dir === "in" ? "inAt" : "outAt";
    const at = Math.max(this[key], now + this.opts.lag / 2 + Math.random() * this.opts.jitter);
    this[key] = at;
    setTimeout(fn, at - now);
  }

  control(event: string, data: any): Promise<Ack> { return this.socket.call(event, data); }

  kbps(now = performance.now()): number { return this.bytes / 1024 / Math.max(1, (now - this.since) / 1000); }
}
