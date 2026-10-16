// Specialist gadgets and wall charges (data/specialists.json "gadgets"). Placed gadgets share a base class:
// an optional hit box (bullets destroy it like they hurt a character), an optional solid (the shield) and
// the EMP rule (electronics stop working for a while).
//
//   Attack                                     Defence
//     wall charge   door-sized opening           razor wire     slows and rattles
//     thermal lance same, through reinforcement  motion sensor  pings runners
//     pulse scanner reveals enemies within 15 m  shield         bullet-proof cover
//     hammer        smashes soft walls           jammer         stops charges and drones
//     EMP grenade   disables enemy electronics

import { GROUP_WORLD, MASK_SIGHT, rayBox, makeBox } from "@cs/shared/collision";
import { Damageable, damageInfo } from "@cs/shared/damage";
import { type Json, SPECIALISTS } from "@cs/shared/data";
import type { Panel } from "@cs/shared/destruction";
import { type M3, type V3, hprMatrix, rotate } from "@cs/shared/math";
import { grenadeDef } from "@cs/shared/weapons";
import type { ServerGame } from "./game";
import type { Tactical } from "./tactical";
import type { HitInterval, HitOwner } from "./types";

export function gadgetCfg(key: string): Json {
  return SPECIALISTS.gadgets[key] ?? {};
}

export function sideOf(obj: unknown): string | null {
  if (!obj) return null;
  return (obj as { side?: string }).side ?? null;
}

export function hprFacing(normal: V3): V3 {
  const l = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  const n = [normal[0] / l, normal[1] / l, normal[2] / l];
  return [Math.atan2(-n[0], n[1]) * 180 / Math.PI, Math.asin(Math.max(-1, Math.min(1, n[2]))) * 180 / Math.PI, 0];
}

let nextDeployableId = 1;

export class Deployable implements HitOwner {
  static kind = "";
  static model = "";
  readonly id = nextDeployableId++;
  kind: string;
  model: string;
  electronic = false;
  blocksExplosions = 0;     // destroyed by explosions within this radius (0: only by its hit box)
  tac: Tactical;
  game: ServerGame;
  owner: unknown;
  side: string;
  pos: V3;
  hpr: V3;
  cfg: Json;
  alive = true;
  controller: unknown = null;     // who drives / watches it (drones, cameras)
  disabledUntil = -1;
  damageable: Damageable;
  isGadget = true;
  hitbox: { size: V3; offset: V3 } | null = null;
  solidKey: string | null = null;

  constructor(tac: Tactical, owner: unknown, side: string, pos: V3, hpr: V3 = [0, 0, 0]) {
    const cls = this.constructor as typeof Deployable;
    this.kind = cls.kind;
    this.model = cls.model;
    this.tac = tac;
    this.game = tac.game;
    this.owner = owner;
    this.side = side;
    this.pos = [...pos] as V3;
    this.hpr = [...hpr] as V3;
    this.cfg = gadgetCfg(this.kind);
    this.damageable = new Damageable(this.kind, side, 1);
  }

  get now(): number { return this.game.loop.time; }
  get disabled(): boolean { return this.now < this.disabledUntil; }
  /** The frame the hit box and solid hang on (the drone's moves). */
  frame(): [V3, M3] { return [this.pos, hprMatrix(this.hpr[0], this.hpr[1], this.hpr[2])]; }

  addHitbox(size: V3, offset: V3 = [0, 0, 0], health = 1): void {
    this.hitbox = { size, offset };
    this.damageable = new Damageable(this.kind, this.side, health);
    this.damageable.filter = (_d, info) => sideOf(info.attacker) !== this.side;
    this.damageable.onDamage.push((res) => { if (res.killed && this.alive) this.destroy(); });
  }

  /** Solid cover: blocks movement, bullets and sight. */
  addSolid(size: V3, offset: V3 = [0, 0, 0], surface = "reinforced"): void {
    const [p, R] = this.frame();
    const o = rotate(offset, R);
    this.solidKey = `gadget:${this.id}`;
    this.game.world.setDynamic(this.solidKey, GROUP_WORLD, surface,
      [{ c: [p[0] + o[0], p[1] + o[1], p[2] + o[2]], h: [size[0] / 2, size[1] / 2, size[2] / 2], R }], { owner: this });
  }

  /** The hit box crossed by a segment (bullets, knives, pings). */
  hitInterval(start: V3, end: V3): HitInterval | null {
    if (!this.hitbox || !this.alive) return null;
    const [p, R] = this.frame();
    const o = rotate(this.hitbox.offset, R);
    const s = this.hitbox.size;
    const box = makeBox([p[0] + o[0], p[1] + o[1], p[2] + o[2]], [s[0] / 2, s[1] / 2, s[2] / 2], R,
      { id: -1, group: 0, surface: "metal", boxes: [] });
    const dir: V3 = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
    const r = rayBox(start, dir, box);
    if (!r || r.t0 < 0 || r.t0 > 1 || !r.n0) return null;
    const at = (t: number): V3 => [start[0] + dir[0] * t, start[1] + dir[1] * t, start[2] + dir[2] * t];
    return { tIn: r.t0, tOut: Math.min(r.t1, 1), inPos: at(r.t0), inNormal: r.n0, outPos: r.t1 <= 1 ? at(r.t1) : null,
      outNormal: r.t1 <= 1 ? r.n1 : null, body: null, owner: this, hitgroup: "chest", surface: "metal" };
  }

  emp(until: number): void {
    if (this.electronic) this.disabledUntil = Math.max(this.disabledUntil, until);
  }

  center(): V3 { return [this.pos[0], this.pos[1], this.pos[2] + 0.1]; }

  update(_dt: number, _now: number): void {}

  destroy(effect = true): void {
    if (!this.alive) return;
    this.alive = false;
    if (effect) {
      this.tac.log(`destroyed_${this.kind}`, `${this.kind} (${this.side}) destroyed`);
      const c = this.center();
      this.game.fx.sparks(c, 14);
      this.game.fx.playAt("impact_metal", c, 0.8);
    }
    if (this.solidKey) this.game.world.removeDynamic(this.solidKey);
  }
}

// --------------------------------------------------------------- attackers
/** Wall charge / thermal lance: stuck to a destructible panel, opens a door-sized hole when its timer runs
 * out (paused while jammed). */
export class Breacher extends Deployable {
  panel: Panel;
  normal: V3;
  left: number;
  jammed = false;
  cutKind = "charge";
  protected tick = 0;

  constructor(tac: Tactical, owner: unknown, side: string, panel: Panel, pos: V3, normal: V3) {
    super(tac, owner, side, pos, hprFacing(normal));
    this.panel = panel;
    this.normal = [...normal] as V3;
    this.left = Number(this.cfg.fuse ?? this.cfg.burn_time ?? 3.0);
  }

  override update(dt: number, now: number): void {
    this.jammed = this.tac.jammed(this.pos, this.side);
    if (this.jammed) return;
    this.left -= dt;
    this.effects(dt, now);
    if (this.left <= 0) this.fire();
  }

  protected effects(_dt: number, _now: number): void {}

  /** Remove a door-sized area: walls are opened from the floor up. */
  cut(): number {
    const p = this.panel;
    const dm = this.game.destruction;
    const w = Number(this.cfg.width ?? 1.1);
    const h = Number(this.cfg.height ?? 2.0);
    if (p.spec.kind === "floor") return dm.cutAt(p, this.pos, w, w / 2, w / 2, this.cutKind);
    const lp = p.toLocal(this.pos);
    const [a, b] = p.ax;
    const vert = Math.abs(p.R[b][2]) > 0.9 ? b : a;
    const horiz = vert === b ? a : b;
    const up = p.R[vert][2] > 0 ? 1 : -1;
    const bottom = up > 0 ? -p.size[vert] / 2 : p.size[vert] / 2;
    const lo = Math.min(bottom, bottom + up * h), hi = Math.max(bottom, bottom + up * h);
    const u0 = lp[horiz] - w / 2, u1 = lp[horiz] + w / 2;
    if (horiz === a) return dm.cut(p, u0, u1, lo, hi, this.pos, this.cutKind, this.normal);
    return dm.cut(p, lo, hi, u0, u1, this.pos, this.cutKind, this.normal);
  }

  fire(): void {}
}

export class WallCharge extends Breacher {
  static override kind = "wall_charge";
  static override model = "gadget_charge";

  constructor(tac: Tactical, owner: unknown, side: string, panel: Panel, pos: V3, normal: V3) {
    super(tac, owner, side, panel, pos, normal);
    this.electronic = true;
  }

  protected override effects(dt: number): void {
    this.tick -= dt;
    if (this.tick <= 0) {
      this.tick = this.left > 1 ? 0.5 : 0.18;
      this.game.fx.playAt("charge_beep", this.pos, 0.55);
    }
  }

  /** A charge is armed and dumb: an EMP only delays it. */
  override emp(): void { this.left = Math.max(this.left, 1.0); }

  override fire(): void {
    const g = this.game;
    const pos: V3 = [...this.pos] as V3;
    const n = this.normal;
    const cut = this.cut();
    this.tac.log("charge_fired", `wall charge fired on ${this.panel.spec.name || this.panel.index}: ${cut} chunks`);
    g.destruction.explosion([pos[0] - n[0] * 0.1, pos[1] - n[1] * 0.1, pos[2] - n[2] * 0.1], 160, 0.7);
    g.fx.explosion([pos[0] + n[0] * 0.2, pos[1] + n[1] * 0.2, pos[2] + n[2] * 0.2], 3.0);
    g.fx.playAt("explosion", pos, 0.9);
    g.notifyNoise(pos, 1, 50, this.owner);
    this.tac.onExplosion(pos, 2.2, this);
    // the blast goes through: whoever stands right behind the wall is hurt
    const far: V3 = [pos[0] - n[0] * 0.4, pos[1] - n[1] * 0.4, pos[2] - n[2] * 0.4];
    const r = Number(this.cfg.blast_radius ?? 3.0);
    const dmgMax = Number(this.cfg.blast_damage ?? 120);
    for (const t of g.damageables()) {
      if (!t.damageable.alive) continue;
      const c = t.centerOfMass();
      const dv: V3 = [c[0] - far[0], c[1] - far[1], c[2] - far[2]];
      const d = Math.hypot(dv[0], dv[1], dv[2]);
      if (d >= r) continue;
      if (g.world.ray(far, c, MASK_SIGHT)) continue;
      const dir: V3 = [dv[0] / Math.max(d, 1e-9), dv[1] / Math.max(d, 1e-9), dv[2] / Math.max(d, 1e-9)];
      const res = t.damageable.takeDamage(damageInfo({ amount: dmgMax * (1 - d / r) ** 1.2, armorPenetration: 0.6, hitgroup: "chest",
        kind: "explosion", attacker: this.owner, weapon: "wall_charge", pos: c, direction: dir }));
      if (res) t.onHit?.(res, c, dir);
    }
    this.destroy(false);
  }
}

export class ThermalLance extends Breacher {
  static override kind = "thermal_lance";
  static override model = "gadget_lance";

  constructor(tac: Tactical, owner: unknown, side: string, panel: Panel, pos: V3, normal: V3) {
    super(tac, owner, side, panel, pos, normal);
    this.cutKind = "thermal";
  }

  protected override effects(dt: number): void {
    this.tick -= dt;
    if (this.tick <= 0) {
      this.tick = 0.9;
      this.game.fx.playAt("thermal_burn", this.pos, 0.7);
    }
  }

  override fire(): void {
    const g = this.game;
    const cut = this.cut();
    this.tac.log("lance_fired", `thermal lance burned through ${this.panel.spec.name || this.panel.index}: ${cut} chunks`);
    g.fx.sparks(this.pos, 30);
    g.fx.playAt("wall_break", this.pos, 1);
    g.notifyNoise(this.pos, 1, 40, this.owner);
    this.tac.onExplosion(this.pos, 1.4, this);
    this.destroy(false);
  }
}

// ---------------------------------------------------------------- defenders
export class RazorWire extends Deployable {
  static override kind = "razor_wire";
  static override model = "gadget_wire";
  size: number[];
  private noise = new Map<unknown, number>();

  constructor(tac: Tactical, owner: unknown, side: string, pos: V3, heading: number) {
    super(tac, owner, side, pos, [heading, 0, 0]);
    this.blocksExplosions = 2.2;
    this.size = this.cfg.size ?? [1.8, 0.7];
  }

  contains(p: ArrayLike<number>): boolean {
    const h = this.hpr[0] * Math.PI / 180;
    const dx = p[0] - this.pos[0], dy = p[1] - this.pos[1];
    const lx = dx * Math.cos(h) + dy * Math.sin(h);
    const ly = -dx * Math.sin(h) + dy * Math.cos(h);
    return Math.abs(lx) <= this.size[0] / 2 + 0.25 && Math.abs(ly) <= this.size[1] / 2 + 0.25 && Math.abs(p[2] - this.pos[2]) < 0.7;
  }

  override update(_dt: number, now: number): void {
    const slow = Number(this.cfg.slow ?? 0.32);
    const every = Number(this.cfg.noise_every ?? 0.45);
    for (const [agent, char] of this.tac.characters()) {
      if (!this.contains(char.pos)) continue;
      this.tac.slow(agent, slow);
      if (char.horizontalSpeed > 0.4 && now >= (this.noise.get(agent) ?? 0)) {
        this.noise.set(agent, now + every);
        this.game.fx.playAt("wire_rattle", char.pos, 0.8);
        this.game.notifyNoise(char.pos, 0.9, 24, agent);
      }
    }
  }

  hammer(): void { this.destroy(); }
}

export class MotionSensor extends Deployable {
  static override kind = "motion_sensor";
  static override model = "gadget_sensor";
  normal: V3;
  private scan = 0;

  constructor(tac: Tactical, owner: unknown, side: string, pos: V3, normal: V3) {
    super(tac, owner, side, pos, hprFacing(normal));
    const l = Math.hypot(normal[0], normal[1], normal[2]) || 1;
    this.normal = [normal[0] / l, normal[1] / l, normal[2] / l];
    this.electronic = true;
    this.addHitbox([0.14, 0.08, 0.17], [0, 0.03, 0], Number(this.cfg.health ?? 1));
  }

  override update(dt: number): void {
    if (this.disabled) return;
    this.scan -= dt;
    if (this.scan > 0) return;
    this.scan = 0.2;
    const rng = Number(this.cfg.range ?? 8);
    const cosHalf = Math.cos(Number(this.cfg.fov ?? 120) / 2 * Math.PI / 180);
    const minSpeed = Number(this.cfg.min_speed ?? 2.2);
    const eye: V3 = [this.pos[0] + this.normal[0] * 0.06, this.pos[1] + this.normal[1] * 0.06, this.pos[2] + this.normal[2] * 0.06];
    for (const enemy of this.tac.enemiesOf(this.side)) {
      const c = enemy.centerOfMass();
      const d: V3 = [c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]];
      const dist = Math.hypot(d[0], d[1], d[2]);
      if (dist > rng || dist < 1e-3) continue;
      if ((d[0] * this.normal[0] + d[1] * this.normal[1] + d[2] * this.normal[2]) / dist < cosHalf) continue;
      const v = enemy.velocity();
      if (Math.hypot(v[0], v[1]) < minSpeed) continue;
      if (this.game.world.ray(eye, c, MASK_SIGHT)) continue;
      this.tac.ping(this.side, enemy.position(), "sensor", Number(this.cfg.ping_time ?? 2), enemy, this.owner);
    }
  }
}

export class DeployShield extends Deployable {
  static override kind = "deploy_shield";
  static override model = "gadget_shield";

  constructor(tac: Tactical, owner: unknown, side: string, pos: V3, heading: number) {
    super(tac, owner, side, pos, [heading, 0, 0]);
    this.blocksExplosions = 2.0;
    const [sx, sy, sz] = this.cfg.size ?? [1.05, 0.08, 1.1];
    this.addSolid([sx, sy, sz], [0, 0, 0.07 + sz / 2]);
  }

  override center(): V3 { return [this.pos[0], this.pos[1], this.pos[2] + 0.6]; }
  hammer(): void { this.destroy(); }
}

export class SignalJammer extends Deployable {
  static override kind = "signal_jammer";
  static override model = "gadget_jammer";
  radius: number;

  constructor(tac: Tactical, owner: unknown, side: string, pos: V3, heading: number) {
    super(tac, owner, side, pos, [heading, 0, 0]);
    this.electronic = true;
    this.addHitbox([0.32, 0.22, 0.16], [0, 0, 0.08], Number(this.cfg.health ?? 1));
    this.radius = Number(this.cfg.radius ?? 5);
  }

  get active(): boolean { return this.alive && !this.disabled; }
}

export function empGrenadeDef() {
  const c = gadgetCfg("emp_grenade");
  const ts = Number(c.throw_speed ?? 15);
  return grenadeDef("emp", { ...c, name: c.name ?? "EMP grenade", model: c.model ?? "grenade_emp", price: 0,
    max_carry: Number(c.count ?? 2), fuse: Number(c.fuse ?? 1.4), throw_speed: ts, lob_speed: ts * 0.55,
    restitution: Number(c.restitution ?? 0.4), friction: Number(c.friction ?? 0.6), speed: 1 });
}

export const DEPLOYABLES: Record<string, unknown> = { wall_charge: WallCharge, thermal_lance: ThermalLance, razor_wire: RazorWire,
  motion_sensor: MotionSensor, deploy_shield: DeployShield, signal_jammer: SignalJammer };
