// World pickups: dropped weapons (rigid bodies) and the map's racks and crates (static, they come back
// after being taken). A player picks up what the crosshair points at within reach (use) or walks over a
// weapon whose slot is empty.

import type { V3 } from "@cs/shared/math";
import { modelBounds } from "@cs/shared/models";
import type { WeaponState } from "@cs/shared/weapons";
import type { ServerGame } from "./game";
import { RigidBody } from "./rigid";

export const REACH = 2.3;
let nextPickupId = 1;

export class Pickup {
  readonly id = nextPickupId++;
  mgr: PickupManager;
  kind: string;                  // weapon | grenade | ammo | armor | grenades
  item: string | WeaponState;
  static: boolean;
  respawn: number;
  heading: number;
  hiddenTimer = 0;
  label: string;
  body: RigidBody;
  removed = false;

  constructor(mgr: PickupManager, kind: string, item: string | WeaponState, pos: V3, heading = 0, vel: V3 | null = null,
              isStatic = false, respawn = 0, label = "") {
    this.mgr = mgr;
    this.kind = kind;
    this.item = item;
    this.static = isStatic;
    this.respawn = respawn;
    this.heading = heading;
    this.label = label;
    let half: V3;
    const game = mgr.game;
    let model: string | null = null;
    if (kind === "weapon") model = game.weaponDb.weapons[typeof item === "string" ? item : item.d.key].model;
    else if (kind === "grenade") model = game.weaponDb.grenades[item as string].model;
    if (model) {
      const b = modelBounds(model);
      half = [Math.max((b.max[0] - b.min[0]) / 2, 0.02), Math.max((b.max[1] - b.min[1]) / 2, 0.02), Math.max((b.max[2] - b.min[2]) / 2, 0.02)];
      // the rigid body is an axis-aligned box: the longest side either way round
      const m = Math.max(half[0], half[1]);
      half = [m, m, half[2]];
    } else {
      half = kind === "armor" ? [0.25, 0.175, 0.125] : [0.3, 0.2, 0.15];
    }
    this.body = new RigidBody(pos, vel ?? [0, 0, 0], half, 0.15, 0.9, 0.05);
    if (isStatic || !vel) this.body.resting = isStatic;
  }

  get pos(): V3 { return this.body.pos; }
  available(): boolean { return this.hiddenTimer <= 0 && !this.removed; }

  taken(): void {
    if (this.static && this.respawn > 0) this.hiddenTimer = this.respawn;
    else this.destroy();
  }

  fixedUpdate(dt: number): void {
    if (this.hiddenTimer > 0) this.hiddenTimer -= dt;
    else if (!this.static) this.body.step(dt, this.mgr.game.world);
  }

  destroy(): void {
    this.removed = true;
    const i = this.mgr.items.indexOf(this);
    if (i >= 0) this.mgr.items.splice(i, 1);
  }
}

export class PickupManager {
  static MAX_DROPPED = 24;
  game: ServerGame;
  items: Pickup[] = [];

  constructor(game: ServerGame) {
    this.game = game;
  }

  spawn(kind: string, item: string | WeaponState, pos: ArrayLike<number>, heading = 0, vel: V3 | null = null, isStatic = false,
        respawn = 0, label = ""): Pickup {
    const p = new Pickup(this, kind, item, [pos[0], pos[1], pos[2]], heading, vel, isStatic, respawn, label);
    this.items.push(p);
    const dropped = this.items.filter((i) => !i.static);
    if (dropped.length > PickupManager.MAX_DROPPED) dropped[0].destroy();
    return p;
  }

  fixedUpdate(dt: number): void {
    for (const p of this.items.slice()) p.fixedUpdate(dt);
  }

  clearDropped(): void {
    for (const p of this.items.filter((i) => !i.static)) p.destroy();
  }

  /** What the crosshair points at within reach (its box), else the nearest in a narrow cone. */
  lookAt(eye: V3, dir: V3): Pickup | null {
    let best: Pickup | null = null, bestT = Infinity;
    for (const p of this.items) {
      if (!p.available()) continue;
      const t = rayAabb(eye, dir, REACH, p.pos, p.body.half);
      if (t !== null && t < bestT) { best = p; bestT = t; }
    }
    if (best) return best;
    let bd = 1e9;
    const cos12 = Math.cos(12 * Math.PI / 180);
    for (const p of this.items) {
      if (!p.available()) continue;
      const to = [p.pos[0] - eye[0], p.pos[1] - eye[1], p.pos[2] - eye[2]];
      const d = Math.hypot(to[0], to[1], to[2]);
      if (d > REACH || d < 1e-3) continue;
      if ((to[0] * dir[0] + to[1] * dir[1] + to[2] * dir[2]) / d > cos12 && d < bd) { best = p; bd = d; }
    }
    return best;
  }

  nearFeet(feet: V3, radius = 0.9): Pickup[] {
    return this.items.filter((p) => !p.static && p.available() &&
      Math.hypot(p.pos[0] - feet[0], p.pos[1] - feet[1], p.pos[2] - feet[2]) < radius);
  }
}

function rayAabb(o: V3, d: V3, len: number, c: V3, h: V3): number | null {
  let t0 = 0, t1 = len;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-12) {
      if (Math.abs(o[k] - c[k]) > h[k]) return null;
      continue;
    }
    let a = (c[k] - h[k] - o[k]) / d[k], b = (c[k] + h[k] - o[k]) / d[k];
    if (a > b) { const t = a; a = b; b = t; }
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return null;
  }
  return t0;
}
