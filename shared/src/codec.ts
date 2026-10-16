// The binary game messages, one module for the server and the browser (so the two can never drift).
//
// * `in` (client -> server): u8 version, u32 ack_snap, u8 n, then n input commands (commands.ts, 23 bytes)
// * `snap` (server -> client):
//     u8 version, u8 flags (1 full, 2 has the self block), u32 seq, u32 base_seq, u32 server_tick, u32 ack_cmd
//     match block (MATCH fields), self block (SELF fields, the receiving player only)
//     u16 n, n x (u16 id, u8 kind, u16 field mask, the masked fields of that kind)
//     u16 n, n x u16 removed ids
//     u16 n, n x (u8 event kind, its fields)
//     u16 n, n x (u16 panel index, u8 flags (1 reinforced, 2 intact), u16 m, m bytes of standing chunks)
//
// A field is (name, type, count, scale): type b B h H i I f, or s / S for a UTF-8 string with a u8 / u16
// length; a value travels as round(real * scale). All integers little-endian. On the wire (WebSocket) a
// message is one binary frame: u8 channel (1 = snap, 2 = in) then the message.

import { type InputCmd, WIRE_SIZE, packCmd, unpackCmd } from "./commands";

export const PROTOCOL_VERSION = 4;
export const FULL = 1;
export const HAS_SELF = 2;
export const POS = 256.0;
export const VEL = 256.0;
export const YAW = 65536.0 / 360.0;
export const PITCH = 100.0;

export type FieldType = "b" | "B" | "h" | "H" | "i" | "I" | "f" | "s" | "S";
export interface Field { name: string; type: FieldType; count: number; scale: number }
const F = (name: string, type: FieldType, count = 1, scale = 1): Field => ({ name, type, count, scale });

export const KIND_SOLDIER = 1, KIND_GRENADE = 2, KIND_SMOKE = 3, KIND_BOMB = 4, KIND_PICKUP = 5, KIND_GADGET = 6, KIND_DRONE = 7;

export const SOLDIER_FLAGS = ["alive", "crouched", "walking", "scoped", "planting", "defusing", "reloading", "charge",
  "on_ground", "bot", "human"] as const;

export const KINDS: Record<number, { name: string; fields: Field[] }> = {
  [KIND_SOLDIER]: { name: "soldier", fields: [
    F("pos", "h", 3, POS), F("vel", "h", 3, VEL), F("yaw", "H", 1, YAW), F("pitch", "h", 1, PITCH), F("flags", "H"),
    F("height", "B", 1, 100), F("lean", "b", 1, 127), F("item", "B"), F("team", "B"), F("health", "B"), F("armor", "B"),
    F("event", "B"),                    // animation event counter: reload / switch / throw / knife / hit (low bits kind)
  ] },
  [KIND_GRENADE]: { name: "grenade", fields: [F("pos", "h", 3, POS), F("vel", "h", 3, VEL), F("item", "B")] },
  [KIND_SMOKE]: { name: "smoke", fields: [F("pos", "h", 3, POS), F("radius", "B", 1, 10), F("age", "H", 1, 100), F("duration", "B")] },
  [KIND_BOMB]: { name: "bomb", fields: [F("state", "B"), F("pos", "h", 3, POS)] },
  [KIND_PICKUP]: { name: "pickup", fields: [F("pos", "h", 3, POS), F("yaw", "H", 1, YAW), F("item", "B")] },
  [KIND_GADGET]: { name: "gadget", fields: [F("pos", "h", 3, POS), F("yaw", "H", 1, YAW), F("model", "B"), F("team", "B"), F("state", "B")] },
  [KIND_DRONE]: { name: "drone", fields: [F("pos", "h", 3, POS), F("yaw", "H", 1, YAW), F("team", "B"), F("state", "B")] },
};
export const BOMB_STATES = ["none", "carried", "dropped", "planted", "defused", "exploded"];
export const GADGET_KINDS = ["wall_charge", "thermal_lance", "razor_wire", "motion_sensor", "deploy_shield", "signal_jammer", "camera"];
export const GRENADE_KEYS = ["frag", "flash", "smoke", "emp"];
export const ANIM_EVENTS = ["", "reload", "switch", "throw", "knife", "hit", "fire"];

export const PHASES = ["waiting", "freeze", "prep", "live", "planted", "round_end", "halftime", "match_end"];
export const MATCH: Field[] = [
  F("phase", "B"), F("clock", "H", 1, 10), F("round", "B"), F("score", "B", 2), F("team0_side", "B"), F("alive", "B", 2),
  F("bomb", "B"), F("buy_time", "B"),
];
export const SELF_FLAGS = ["on_ground", "crouched", "walking", "move_lock", "lean_lock", "helmet", "kit", "charge", "alive",
  "observing", "noclip", "can_buy"] as const;
export const SELF: Field[] = [
  F("slot", "H"),
  F("pos", "f", 3), F("vel", "f", 3), F("height", "f"), F("ground_normal", "f", 3), F("jump_cooldown", "f"),
  F("landing_timer", "f"), F("air_time", "f"), F("stride", "f"), F("jump_buffer", "f"), F("lean", "f"),
  F("speed_scale", "f"), F("slow", "f"), F("yaw", "f"), F("pitch", "f"),
  F("flags", "H"),
  F("health", "B"), F("armor", "B"), F("money", "H"), F("inv_slot", "B"), F("item", "B"), F("ammo", "H"),
  F("reserve", "H"), F("weapons", "B", 2), F("grenades", "B", 4), F("zoom", "B"), F("ads", "B", 1, 255),
  F("progress_kind", "B"), F("progress", "B", 1, 255),
  F("gadget", "B"), F("gadget_left", "B"), F("charges", "B"), F("drones", "B"), F("reinforcements", "B"), F("view", "H"),
  F("view_pos", "f", 3), F("view_yaw", "f"), F("view_pitch", "f"),                      // the drone or camera looked through
];
export const INV_SLOTS = ["primary", "secondary", "melee", "grenade", "bomb"];
export const PROGRESS_KINDS = ["", "plant", "defuse", "reinforce"];

export const EV_TRACER = 1, EV_IMPACT = 2, EV_SOUND = 3, EV_FOOTSTEP = 4, EV_SHOT = 5, EV_EXPLOSION = 6, EV_FLASH = 7,
  EV_HIT = 8, EV_BLIND = 9, EV_RADAR = 10, EV_JSON = 255;
export const EVENTS: Record<number, { name: string; fields: Field[] }> = {
  [EV_TRACER]: { name: "tracer", fields: [F("start", "h", 3, POS), F("end", "h", 3, POS)] },
  [EV_IMPACT]: { name: "impact", fields: [F("pos", "h", 3, POS), F("normal", "b", 3, 127), F("surface", "s")] },
  [EV_SOUND]: { name: "sound", fields: [F("pos", "h", 3, POS), F("volume", "B", 1, 100), F("name", "s")] },
  [EV_FOOTSTEP]: { name: "footstep", fields: [F("pos", "h", 3, POS), F("loudness", "B", 1, 100), F("surface", "s")] },
  [EV_SHOT]: { name: "shot", fields: [F("slot", "H"), F("pos", "h", 3, POS), F("profile", "s")] },
  [EV_EXPLOSION]: { name: "explosion", fields: [F("pos", "h", 3, POS), F("radius", "B", 1, 4), F("kind", "B")] },
  [EV_FLASH]: { name: "flash", fields: [F("pos", "h", 3, POS)] },
  [EV_HIT]: { name: "hit", fields: [F("flags", "B")] },
  [EV_BLIND]: { name: "blind", fields: [F("duration", "B", 1, 20), F("strength", "B", 1, 255)] },
  [EV_RADAR]: { name: "radar", fields: [F("slot", "H"), F("pos", "h", 3, POS)] },
  [EV_JSON]: { name: "json", fields: [F("data", "S")] },
};

export const PANEL_REINFORCED = 1, PANEL_INTACT = 2;
export const CH_SNAP = 1, CH_INPUT = 2;
export const MAX_COMMANDS = 4;
export const INPUT_HEADER = 6;

// ------------------------------------------------------------------ helpers
export const qClamp = (v: number, scale: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.round(v * scale)));
export const qPos = (p: ArrayLike<number>): number[] =>
  [qClamp(p[0], POS, -32768, 32767), qClamp(p[1], POS, -32768, 32767), qClamp(p[2], POS, -32768, 32767)];
export const qYaw = (yaw: number): number => Math.round((((yaw % 360) + 360) % 360) * YAW) & 0xffff;
export function bits(names: readonly string[], on: Set<string> | ((n: string) => boolean)): number {
  let v = 0;
  const has = typeof on === "function" ? on : (n: string) => on.has(n);
  names.forEach((n, i) => { if (has(n)) v |= 1 << i; });
  return v;
}
export function flagSet(names: readonly string[], v: number): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  names.forEach((n, i) => { out[n] = (v & (1 << i)) !== 0; });
  return out;
}

const SIZE: Record<string, number> = { b: 1, B: 1, h: 2, H: 2, i: 4, I: 4, f: 4 };
const enc = new TextEncoder();
const dec = new TextDecoder();

export class Writer {
  buf: Uint8Array;
  view: DataView;
  off = 0;

  constructor(size = 1024) {
    this.buf = new Uint8Array(size);
    this.view = new DataView(this.buf.buffer);
  }

  ensure(n: number): void {
    if (this.off + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.off + n) size *= 2;
    const nb = new Uint8Array(size);
    nb.set(this.buf.subarray(0, this.off));
    this.buf = nb;
    this.view = new DataView(nb.buffer);
  }

  u8(v: number): void { this.ensure(1); this.view.setUint8(this.off, v); this.off += 1; }
  u16(v: number): void { this.ensure(2); this.view.setUint16(this.off, v, true); this.off += 2; }
  u32(v: number): void { this.ensure(4); this.view.setUint32(this.off, v >>> 0, true); this.off += 4; }
  bytes(b: Uint8Array): void { this.ensure(b.length); this.buf.set(b, this.off); this.off += b.length; }

  num(type: FieldType, v: number): void {
    this.ensure(4);
    const d = this.view, o = this.off;
    switch (type) {
      case "b": d.setInt8(o, v); break;
      case "B": d.setUint8(o, v); break;
      case "h": d.setInt16(o, v, true); break;
      case "H": d.setUint16(o, v, true); break;
      case "i": d.setInt32(o, v, true); break;
      case "I": d.setUint32(o, v >>> 0, true); break;
      case "f": d.setFloat32(o, v, true); break;
      default: throw new Error(`num ${type}`);
    }
    this.off += SIZE[type];
  }

  str(s: string, wide: boolean): void {
    let b = enc.encode(s);
    b = b.subarray(0, wide ? 65535 : 255);
    if (wide) this.u16(b.length); else this.u8(b.length);
    this.bytes(b);
  }

  /** Flat field values (already quantised integers / floats; strings as strings), masked. */
  fields(fields: Field[], values: Array<number | string>, mask = -1): void {
    let k = 0;
    fields.forEach((f, i) => {
      if (mask !== -1 && !((mask >> i) & 1)) return;
      for (let c = 0; c < f.count; c++) {
        const v = values[k++];
        if (f.type === "s" || f.type === "S") this.str(String(v), f.type === "S");
        else this.num(f.type, v as number);
      }
    });
  }

  done(): Uint8Array { return this.buf.slice(0, this.off); }
}

export class Reader {
  view: DataView;
  bytesArr: Uint8Array;
  off: number;

  constructor(data: Uint8Array, off = 0) {
    this.bytesArr = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.off = off;
  }

  get left(): number { return this.bytesArr.length - this.off; }
  u8(): number { const v = this.view.getUint8(this.off); this.off += 1; return v; }
  u16(): number { const v = this.view.getUint16(this.off, true); this.off += 2; return v; }
  u32(): number { const v = this.view.getUint32(this.off, true); this.off += 4; return v; }
  bytes(n: number): Uint8Array { const b = this.bytesArr.slice(this.off, this.off + n); this.off += n; return b; }

  num(type: FieldType): number {
    const d = this.view, o = this.off;
    let v: number;
    switch (type) {
      case "b": v = d.getInt8(o); break;
      case "B": v = d.getUint8(o); break;
      case "h": v = d.getInt16(o, true); break;
      case "H": v = d.getUint16(o, true); break;
      case "i": v = d.getInt32(o, true); break;
      case "I": v = d.getUint32(o, true); break;
      case "f": v = d.getFloat32(o, true); break;
      default: throw new Error(`num ${type}`);
    }
    this.off += SIZE[type];
    return v;
  }

  str(wide: boolean): string {
    const n = wide ? this.u16() : this.u8();
    const s = dec.decode(this.bytesArr.subarray(this.off, this.off + n));
    this.off += n;
    return s;
  }

  /** Fields -> {name: value or array}, scaled back to real units. */
  fields(fields: Field[], mask = -1): Record<string, number | number[] | string> {
    const out: Record<string, number | number[] | string> = {};
    fields.forEach((f, i) => {
      if (mask !== -1 && !((mask >> i) & 1)) return;
      if (f.type === "s" || f.type === "S") { out[f.name] = this.str(f.type === "S"); return; }
      const vals: number[] = [];
      for (let c = 0; c < f.count; c++) vals.push(this.num(f.type) / f.scale);
      out[f.name] = f.count > 1 ? vals : vals[0];
    });
    return out;
  }
}

export const allMask = (fields: Field[]): number => (1 << fields.length) - 1;

/** One packed event. */
export function packEvent(kind: number, values: Array<number | string>): Uint8Array {
  const w = new Writer(64);
  w.u8(kind);
  w.fields(EVENTS[kind].fields, values);
  return w.done();
}

export function jsonEvent(data: unknown): Uint8Array {
  return packEvent(EV_JSON, [JSON.stringify(data)]);
}

// ------------------------------------------------------------------ snapshots
export interface SnapEntity { id: number; kind: number; mask: number; values: number[] }
export interface SnapPanel { index: number; flags: number; mask: Uint8Array }

export function encodeSnapshot(seq: number, baseSeq: number, tick: number, ackCmd: number, matchVals: number[],
                               selfVals: number[] | null, entities: SnapEntity[], removed: number[], events: Uint8Array[],
                               full: boolean, panels: SnapPanel[]): Uint8Array {
  const w = new Writer(512);
  w.u8(PROTOCOL_VERSION);
  w.u8((full ? FULL : 0) | (selfVals ? HAS_SELF : 0));
  w.u32(seq);
  w.u32(baseSeq);
  w.u32(tick);
  w.u32(ackCmd);
  w.fields(MATCH, matchVals);
  if (selfVals) w.fields(SELF, selfVals);
  w.u16(entities.length);
  for (const e of entities) {
    w.u16(e.id);
    w.u8(e.kind);
    w.u16(e.mask);
    w.fields(KINDS[e.kind].fields, e.values, e.mask);
  }
  w.u16(removed.length);
  for (const id of removed) w.u16(id);
  w.u16(events.length);
  for (const ev of events) w.bytes(ev);
  w.u16(panels.length);
  for (const p of panels) {
    w.u16(p.index);
    w.u8(p.flags);
    w.u16(p.mask.length);
    w.bytes(p.mask);
  }
  return w.done();
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface DecodedEvent { type: string; [k: string]: any }
export interface Snapshot {
  seq: number; baseSeq: number; tick: number; ackCmd: number; full: boolean;
  match: Record<string, any>;
  self: Record<string, any> | null;
  entities: Map<number, { kind: number; fields: Record<string, any> }>;
  removed: number[];
  events: DecodedEvent[];
  panels: Array<{ index: number; reinforced: boolean; intact: boolean; mask: Uint8Array }>;
}

export function decodeEvent(r: Reader): DecodedEvent {
  const kind = r.u8();
  const spec = EVENTS[kind];
  if (!spec) throw new Error(`unknown event ${kind}`);
  const f = r.fields(spec.fields);
  if (kind === EV_JSON) return { type: "json", ...JSON.parse(f.data as string) };
  return { type: spec.name, ...f };
}

export function decodeSnapshot(data: Uint8Array): Snapshot {
  const r = new Reader(data);
  const version = r.u8();
  if (version !== PROTOCOL_VERSION) throw new Error(`protocol version ${version}`);
  const flags = r.u8();
  const seq = r.u32(), baseSeq = r.u32(), tick = r.u32(), ackCmd = r.u32();
  const match = r.fields(MATCH);
  const self = flags & HAS_SELF ? r.fields(SELF) : null;
  const entities = new Map<number, { kind: number; fields: Record<string, any> }>();
  let n = r.u16();
  for (let i = 0; i < n; i++) {
    const id = r.u16(), kind = r.u8(), mask = r.u16();
    entities.set(id, { kind, fields: r.fields(KINDS[kind].fields, mask) });
  }
  n = r.u16();
  const removed: number[] = [];
  for (let i = 0; i < n; i++) removed.push(r.u16());
  n = r.u16();
  const events: DecodedEvent[] = [];
  for (let i = 0; i < n; i++) events.push(decodeEvent(r));
  n = r.u16();
  const panels: Snapshot["panels"] = [];
  for (let i = 0; i < n; i++) {
    const index = r.u16(), pflags = r.u8(), m = r.u16();
    panels.push({ index, reinforced: (pflags & PANEL_REINFORCED) !== 0, intact: (pflags & PANEL_INTACT) !== 0, mask: r.bytes(m) });
  }
  if (r.left !== 0) throw new Error(`${r.left} trailing bytes`);
  return { seq, baseSeq, tick, ackCmd, full: (flags & FULL) !== 0, match, self, entities, removed, events, panels };
}

// ------------------------------------------------------------------ input
export function encodeInput(ackSnap: number, cmds: InputCmd[]): Uint8Array {
  const out = new Uint8Array(INPUT_HEADER + cmds.length * WIRE_SIZE);
  const v = new DataView(out.buffer);
  v.setUint8(0, PROTOCOL_VERSION);
  v.setUint32(1, ackSnap >>> 0, true);
  v.setUint8(5, cmds.length);
  cmds.forEach((c, i) => packCmd(c, v, INPUT_HEADER + i * WIRE_SIZE));
  return out;
}

/** -> [ack_snap, commands]; throws on a malformed message (the client is never trusted). */
export function decodeInput(data: Uint8Array): [number, InputCmd[]] {
  if (data.length < INPUT_HEADER) throw new Error("short input message");
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (v.getUint8(0) !== PROTOCOL_VERSION) throw new Error("protocol version");
  const n = v.getUint8(5);
  if (n < 1 || n > MAX_COMMANDS || data.length !== INPUT_HEADER + n * WIRE_SIZE) throw new Error("bad command count or length");
  const cmds: InputCmd[] = [];
  for (let i = 0; i < n; i++) cmds.push(unpackCmd(v, INPUT_HEADER + i * WIRE_SIZE));
  return [v.getUint32(1, true), cmds];
}

export const MAX_INPUT_BYTES = INPUT_HEADER + MAX_COMMANDS * WIRE_SIZE;

/** Item table: index -> item key for the `item` fields (0 = nothing). */
export function itemTable(weaponKeys: string[]): string[] {
  return ["", ...[...weaponKeys].sort(), ...GRENADE_KEYS, "bomb_charge", "pickup_ammo", "pickup_armor", "pickup_grenades"];
}
