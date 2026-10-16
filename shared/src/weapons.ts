// Weapon and grenade definitions (data/weapons.json), the gunplay model and the inventory.
//
// * Inaccuracy is the half-angle of a random cone: base (stand | crouch) + move * speed fraction (0 at
//   34 % of max speed: accurate walking, 1 at full speed) + air (airborne) + accumulated fire (each shot
//   adds fire_add, decaying with fire_recovery). First shots of a still, crouched player are pin-point.
// * Recoil is a fixed, learnable spray pattern: shot n is offset by pattern[n] (degrees, x right, y up)
//   from where the player aims. The view follows view_follow of it; the rest the player pulls down.
//   When the trigger is released the pattern index recovers.

import { type Json, WEAPONS_JSON } from "./data";
import { Random } from "./rng";

export const WALK_ACCURATE_FRACTION = 0.34;

export interface Inaccuracy {
  stand: number; crouch: number; move: number; air: number; fire_add: number; fire_recovery: number; ads: number;
  scoped?: Record<string, number>;
}

export interface WeaponDef {
  key: string;
  name: string;
  cls: string;
  slot: string;
  model: string;
  price: number;
  fireMode: string;           // auto | semi | bolt | pump | melee
  rpm: number;
  magazine: number;
  reserve: number;
  damage: number;
  inaccuracy: Inaccuracy;
  recoil: { pattern: number[][]; view_follow: number; recovery: number; punch: number };
  pellets: number;
  headMultiplier: number;
  armorPenetration: number;
  rangeModifier: number;
  maxRange: number;
  penetration: number;
  reloadTime: number;
  reloadEmptyTime: number;
  drawTime: number;
  speed: number;
  pelletSpread: number;
  ads: Json | null;
  scope: Json | null;
  tracerEvery: number;
  shell: string;
  sound: string;
  muzzleFlash: number;
  killReward: number;
  teams: string[];
  buyCategory: string;
  raw: Json;
  fireInterval: number;
}

export interface GrenadeDef {
  key: string;
  name: string;
  model: string;
  price: number;
  maxCarry: number;
  fuse: number;
  throwSpeed: number;
  lobSpeed: number;
  restitution: number;
  friction: number;
  speed: number;
  raw: Json;
}

function weaponDef(key: string, w: Json): WeaponDef {
  const pattern: number[][] = w.recoil.pattern?.length && w.recoil.pattern[0][0] === 0 && w.recoil.pattern[0][1] === 0
    ? w.recoil.pattern : [[0, 0], ...(w.recoil.pattern ?? [])];
  const rpm = Number(w.rpm);
  return {
    key, name: w.name, cls: w.class, slot: w.slot, model: w.model ?? "", price: Number(w.price ?? 0),
    fireMode: w.fire_mode, rpm, magazine: Number(w.magazine), reserve: Number(w.reserve), damage: Number(w.damage),
    inaccuracy: { ads: 1, ...w.inaccuracy },
    recoil: { view_follow: 0.5, recovery: 12, punch: 0.5, ...w.recoil, pattern },
    pellets: Number(w.pellets ?? 1), headMultiplier: Number(w.head_multiplier ?? 4),
    armorPenetration: Number(w.armor_penetration ?? 0.5), rangeModifier: Number(w.range_modifier ?? 0.9),
    maxRange: Number(w.max_range ?? 200), penetration: Number(w.penetration ?? 0),
    reloadTime: Number(w.reload_time ?? 2.5), reloadEmptyTime: Number(w.reload_empty_time ?? 2.5),
    drawTime: Number(w.draw_time ?? 0.6), speed: Number(w.speed ?? 1), pelletSpread: Number(w.pellet_spread ?? 0),
    ads: w.ads ?? null, scope: w.scope ?? null, tracerEvery: Number(w.tracer_every ?? 0), shell: w.shell ?? "rifle",
    sound: w.sound ?? "rifle_heavy", muzzleFlash: Number(w.muzzle_flash ?? 1), killReward: Number(w.kill_reward ?? 300),
    teams: w.teams ?? ["attack", "defend"], buyCategory: w.buy_category ?? "", raw: w, fireInterval: 60 / rpm,
  };
}

export function grenadeDef(key: string, g: Json): GrenadeDef {
  return {
    key, name: g.name, model: g.model ?? key, price: Number(g.price ?? 0), maxCarry: Number(g.max_carry ?? 1),
    fuse: Number(g.fuse ?? 1.6), throwSpeed: Number(g.throw_speed ?? 16), lobSpeed: Number(g.lob_speed ?? 9),
    restitution: Number(g.restitution ?? 0.4), friction: Number(g.friction ?? 0.6), speed: Number(g.speed ?? 1), raw: g,
  };
}

export class WeaponDatabase {
  weapons: Record<string, WeaponDef> = {};
  grenades: Record<string, GrenadeDef> = {};
  hitgroups: Record<string, number | string>;
  armor: Json;

  constructor(data: Json = WEAPONS_JSON) {
    this.hitgroups = data.hitgroups ?? {};
    this.armor = data.armor ?? { absorb_ratio: 0.5, max: 100 };
    for (const [k, w] of Object.entries(data.weapons ?? {})) this.weapons[k] = weaponDef(k, w);
    for (const [k, g] of Object.entries(data.grenades ?? {})) this.grenades[k] = grenadeDef(k, g);
  }

  hitgroupMultiplier(hitgroup: string, w: WeaponDef): number {
    const m = this.hitgroups[hitgroup] ?? 1.0;
    return m === "weapon" ? w.headMultiplier : Number(m);
  }
}

let db: WeaponDatabase | null = null;
export function weaponDb(): WeaponDatabase {
  if (!db) db = new WeaponDatabase();
  return db;
}

export interface AimContext {
  speed: number;
  maxSpeed: number;
  onGround: boolean;
  crouched: boolean;
  ads: number;
  scoped: boolean;
}

export interface WeaponEvent { kind: string; time: number; data?: Json }

export class WeaponState {
  d: WeaponDef;
  rng: Random;
  ammo: number;
  reserve: number;
  infiniteReserve: boolean;
  nextFire = 0;
  lastShot = -10;
  recoilIndex = 0;
  fireInacc = 0;
  reloadEnd: number | null = null;
  reloadKind = "";
  shellNext: number | null = null;
  drawEnd = 0;
  shotCount = 0;
  triggerHeld = false;
  events: WeaponEvent[] = [];
  zoomLevel = 0;

  constructor(d: WeaponDef, rng?: Random, infiniteReserve = false) {
    this.d = d;
    this.rng = rng ?? new Random();
    this.ammo = d.magazine;
    this.reserve = d.reserve;
    this.infiniteReserve = infiniteReserve;
  }

  get reloading(): boolean { return this.reloadEnd !== null || this.shellNext !== null; }
  busy(now: number): boolean { return now < this.drawEnd || this.reloading; }

  deploy(now: number): void {
    this.cancelReload();
    this.drawEnd = now + this.d.drawTime;
    this.nextFire = Math.max(this.nextFire, this.drawEnd);
    this.zoomLevel = 0;
    this.events.push({ kind: "draw", time: now });
  }

  cancelReload(): void {
    this.reloadEnd = null;
    this.shellNext = null;
  }

  recoilOffset(index?: number): [number, number] {
    const pattern = this.d.recoil.pattern;
    let i = index === undefined ? this.recoilIndex : index;
    i = Math.max(0, Math.min(i, pattern.length - 1));
    const i0 = Math.floor(i);
    const i1 = Math.min(i0 + 1, pattern.length - 1);
    const t = i - i0;
    return [pattern[i0][0] * (1 - t) + pattern[i1][0] * t, pattern[i0][1] * (1 - t) + pattern[i1][1] * t];
  }

  viewOffset(): [number, number] {
    const [x, y] = this.recoilOffset();
    const f = this.d.recoil.view_follow;
    return [x * f, y * f];
  }

  inaccuracy(ctx: AimContext): number {
    const ia = this.d.inaccuracy;
    const values: Record<string, number> = { stand: ia.stand, crouch: ia.crouch, move: ia.move, air: ia.air };
    if (ctx.scoped && ia.scoped) Object.assign(values, ia.scoped);
    const b = ctx.crouched && ctx.onGround ? values.crouch : values.stand;
    const lo = ctx.maxSpeed * WALK_ACCURATE_FRACTION;
    let frac = (ctx.speed - lo) / Math.max(ctx.maxSpeed - lo, 1e-3);
    frac = Math.min(Math.max(frac, 0), 1);
    let total = b + values.move * frac;
    if (!ctx.onGround) total += values.air;
    total += this.fireInacc;
    if (ctx.ads > 0 && !ctx.scoped) total *= 1 + (ia.ads - 1) * ctx.ads;
    return total;
  }

  update(now: number, dt: number): void {
    if (now - this.lastShot > this.d.fireInterval * 1.25) {
      this.recoilIndex = Math.max(0, this.recoilIndex - this.d.recoil.recovery * dt);
    }
    if (this.d.inaccuracy.fire_recovery > 0) this.fireInacc *= Math.exp(-dt / this.d.inaccuracy.fire_recovery);
    if (this.reloadEnd !== null && now >= this.reloadEnd) this.finishReload(now);
    if (this.shellNext !== null && now >= this.shellNext) this.insertShell(now);
  }

  private finishReload(now: number): void {
    const need = this.d.magazine - this.ammo;
    const take = this.infiniteReserve ? need : Math.min(need, this.reserve);
    this.ammo += take;
    if (!this.infiniteReserve) this.reserve -= take;
    this.reloadEnd = null;
    this.events.push({ kind: "reload_done", time: now });
  }

  private insertShell(now: number): void {
    if (this.ammo < this.d.magazine && (this.reserve > 0 || this.infiniteReserve)) {
      this.ammo += 1;
      if (!this.infiniteReserve) this.reserve -= 1;
      this.events.push({ kind: "shell", time: now });
    }
    if (this.ammo >= this.d.magazine || (this.reserve <= 0 && !this.infiniteReserve)) {
      this.shellNext = null;
      this.events.push({ kind: "reload_done", time: now });
    } else {
      this.shellNext = now + Number(this.d.raw.reload_shell_time ?? 0.5);
    }
  }

  canReload(): boolean {
    return this.d.magazine > 0 && this.ammo < this.d.magazine && (this.reserve > 0 || this.infiniteReserve) && !this.reloading;
  }

  startReload(now: number): boolean {
    if (!this.canReload() || now < this.drawEnd) return false;
    this.zoomLevel = 0;
    if (this.d.fireMode === "pump") {
      this.shellNext = now + Number(this.d.raw.reload_start_time ?? 0.35) + Number(this.d.raw.reload_shell_time ?? 0.5);
      this.reloadKind = "shells";
    } else {
      const empty = this.ammo === 0;
      this.reloadKind = empty ? "empty" : "tactical";
      this.reloadEnd = now + (empty ? this.d.reloadEmptyTime : this.d.reloadTime);
    }
    this.events.push({ kind: "reload_start", time: now, data: { kind: this.reloadKind } });
    return true;
  }

  reloadProgress(now: number): number {
    if (this.reloadEnd === null) return 0;
    const total = this.reloadKind === "empty" ? this.d.reloadEmptyTime : this.d.reloadTime;
    return 1 - Math.max(this.reloadEnd - now, 0) / Math.max(total, 1e-3);
  }

  /** Whether a shot happens this tick: fire modes, empty magazines (dry fire + auto reload) and shotgun
   * reload interrupts. */
  wantsShot(now: number, triggerDown: boolean, pressed: boolean): boolean {
    const heldBefore = this.triggerHeld;
    this.triggerHeld = triggerDown;
    if (!triggerDown && !pressed) return false;
    if (now < this.drawEnd) return false;
    if (this.shellNext !== null) {
      if (this.ammo > 0 && (pressed || !heldBefore)) this.shellNext = null;
      else return false;
    }
    if (this.reloadEnd !== null) return false;
    if (now < this.nextFire) return false;
    if (["semi", "bolt", "pump", "melee"].includes(this.d.fireMode) && heldBefore && !pressed) return false;
    if (this.d.magazine > 0 && this.ammo <= 0) {
      if (pressed || !heldBefore) {
        this.events.push({ kind: "dry", time: now });
        this.nextFire = now + 0.25;
        this.startReload(now);
      }
      return false;
    }
    return true;
  }

  /** Angular offsets (degrees, x right / y up) of each pellet of the next shot: recoil + spread. */
  shotOffsets(ctx: AimContext): Array<[number, number]> {
    const [rx, ry] = this.recoilOffset(Math.floor(this.recoilIndex));
    const inacc = this.inaccuracy(ctx);
    const out: Array<[number, number]> = [];
    const theta = this.rng.uniform(0, 2 * Math.PI);
    const r = inacc * this.rng.random();
    const sx = r * Math.cos(theta), sy = r * Math.sin(theta);
    for (let i = 0; i < Math.max(this.d.pellets, 1); i++) {
      let px = 0, py = 0;
      if (this.d.pellets > 1) {
        const pt = this.rng.uniform(0, 2 * Math.PI);
        const pr = this.d.pelletSpread * Math.sqrt(this.rng.random());
        px = pr * Math.cos(pt);
        py = pr * Math.sin(pt);
      }
      out.push([rx + sx + px, ry + sy + py]);
    }
    return out;
  }

  onFired(now: number): void {
    if (this.d.magazine > 0) this.ammo -= 1;
    this.shotCount += 1;
    const due = now - this.nextFire < this.d.fireInterval ? this.nextFire : now;
    this.nextFire = due + this.d.fireInterval;
    this.lastShot = now;
    const last = this.d.recoil.pattern.length - 1;
    this.recoilIndex = Math.min(Math.floor(this.recoilIndex) + 1, last);
    this.fireInacc += this.d.inaccuracy.fire_add;
    this.events.push({ kind: "fire", time: now, data: { shot: this.shotCount } });
    if ((this.d.fireMode === "bolt" || this.d.fireMode === "pump") && (this.ammo > 0 || this.d.fireMode === "pump")) {
      this.events.push({ kind: "cycle", time: now });
    }
    if (this.d.scope && this.d.scope.unscope_after_shot) this.zoomLevel = 0;
  }

  isTracer(): boolean {
    const n = this.d.tracerEvery;
    return n > 0 && this.shotCount % n === 0;
  }

  popEvents(): WeaponEvent[] {
    const ev = this.events;
    this.events = [];
    return ev;
  }
}

/** Offset view angles by (dx right, dy up) degrees. */
export function applyOffset(yaw: number, pitch: number, dx: number, dy: number): [number, number] {
  return [yaw - dx, Math.max(-89.9, Math.min(89.9, pitch + dy))];
}

// ------------------------------------------------------------------ inventory
export const SLOT_ORDER = ["primary", "secondary", "melee", "grenade", "bomb"] as const;
export const GRENADE_ORDER = ["frag", "flash", "smoke"];

export class Inventory {
  db: WeaponDatabase;
  infiniteReserve: boolean;
  rng: Random;
  weapons: Record<string, WeaponState | null> = { primary: null, secondary: null, melee: null };
  grenades: Record<string, number> = {};
  hasBomb = false;
  slot = "melee";
  grenade: string | null = null;
  lastSlot: string | null = null;

  constructor(db: WeaponDatabase, infiniteReserve = false, rng?: Random) {
    this.db = db;
    this.infiniteReserve = infiniteReserve;
    this.rng = rng ?? new Random();
  }

  make(key: string): WeaponState { return new WeaponState(this.db.weapons[key], this.rng, this.infiniteReserve); }

  giveWeapon(item: string | WeaponState): WeaponState | null {
    const ws = typeof item === "string" ? this.make(item) : item;
    const old = this.weapons[ws.d.slot] ?? null;
    this.weapons[ws.d.slot] = ws;
    return old;
  }

  giveGrenade(key: string, count = 1): boolean {
    const g = this.db.grenades[key];
    const have = this.grenades[key] ?? 0;
    if (have >= g.maxCarry) return false;
    this.grenades[key] = Math.min(have + count, g.maxCarry);
    return true;
  }

  refillAmmo(): void {
    for (const ws of Object.values(this.weapons)) if (ws) ws.reserve = ws.d.reserve;
  }

  refillGrenades(): void {
    for (const [k, g] of Object.entries(this.db.grenades)) this.grenades[k] = g.maxCarry;
  }

  current(): WeaponState | null {
    if (this.slot === "grenade" || this.slot === "bomb") return null;
    return this.weapons[this.slot] ?? null;
  }

  has(slot: string): boolean {
    if (slot === "grenade") return Object.values(this.grenades).some((c) => c > 0);
    if (slot === "bomb") return this.hasBomb;
    return !!this.weapons[slot];
  }

  /** Switch slot; pressing the grenade slot again cycles grenade types. */
  select(slot: string): boolean {
    if (!this.has(slot)) return false;
    if (slot === "grenade") {
      const available = GRENADE_ORDER.filter((g) => (this.grenades[g] ?? 0) > 0);
      if (this.slot === "grenade" && this.grenade && available.includes(this.grenade) && available.length > 1) {
        this.grenade = available[(available.indexOf(this.grenade) + 1) % available.length];
        return true;
      }
      if (!this.grenade || !available.includes(this.grenade)) this.grenade = available[0];
    }
    if (slot === this.slot && slot !== "grenade") return false;
    this.lastSlot = this.slot;
    this.slot = slot;
    return true;
  }

  cycle(direction: number): boolean {
    const owned = SLOT_ORDER.filter((s) => this.has(s));
    if (!owned.length) return false;
    const i = owned.indexOf(this.slot as (typeof SLOT_ORDER)[number]);
    const at = i >= 0 ? i : 0;
    return this.select(owned[(((at + direction) % owned.length) + owned.length) % owned.length]);
  }

  bestSlot(): string {
    for (const s of SLOT_ORDER) if (this.has(s)) return s;
    return "melee";
  }

  clear(): void {
    this.weapons = { primary: null, secondary: null, melee: null };
    this.grenades = {};
    this.hasBomb = false;
    this.grenade = null;
    this.slot = "melee";
    this.lastSlot = null;
  }

  grenadeCount(): number { return Object.values(this.grenades).reduce((a, b) => a + b, 0); }

  dropCurrent(): WeaponState | null {
    if (this.slot === "melee" || this.slot === "grenade" || this.slot === "bomb") return null;
    const ws = this.weapons[this.slot] ?? null;
    this.weapons[this.slot] = null;
    this.slot = this.bestSlot();
    return ws;
  }

  useGrenade(): string | null {
    const key = this.grenade;
    if (!key || (this.grenades[key] ?? 0) <= 0) return null;
    this.grenades[key] -= 1;
    if (this.grenades[key] <= 0) delete this.grenades[key];
    return key;
  }

  speedScale(): number {
    const ws = this.current();
    return ws ? ws.d.speed : 1;
  }
}

/** Grenades leave slightly above the crosshair (like CS) plus the thrower's velocity. */
export function throwVelocity(yaw: number, pitch: number, speed: number, inherit: ArrayLike<number>): [number, number, number] {
  const p = Math.min(pitch + 8, 89) * Math.PI / 180;
  const h = yaw * Math.PI / 180;
  return [-Math.sin(h) * Math.cos(p) * speed + inherit[0], Math.cos(h) * Math.cos(p) * speed + inherit[1],
    Math.sin(p) * speed + inherit[2]];
}

export function blastDamage(distance: number, radius: number, maxDamage: number, power: number): number {
  if (distance >= radius) return 0;
  return maxDamage * (1 - distance / radius) ** power;
}

export function flashDuration(distance: number, radius: number, cosAngle: number, maxBlind: number): number {
  if (distance >= radius) return 0;
  const facing = cosAngle > 0.6 ? 1.0 : cosAngle > 0.0 ? 0.55 : 0.25;
  return maxBlind * facing * (1 - distance / radius) ** 0.6;
}
