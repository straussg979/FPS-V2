// Thrown grenades: small rigid bodies with fuses.
// * Frag: explodes after its fuse; damage max * (1 - d/r)^p, needs line of sight to the target's centre.
// * Smoke: pops when it has come to rest (or after its fuse) and spawns a smoke cloud.
// * Flash: blinds anyone with line of sight, scaled by distance and how directly they looked at it.
// * EMP (Static's gadget): disables enemy electronics in its radius.

import { MASK_SIGHT } from "@cs/shared/collision";
import { damageInfo } from "@cs/shared/damage";
import { type V3, anglesToDir, vnorm, vsub } from "@cs/shared/math";
import { modelRadius } from "@cs/shared/models";
import { type GrenadeDef, blastDamage, flashDuration } from "@cs/shared/weapons";
import type { ServerGame } from "./game";
import { RigidBody } from "./rigid";
import type { SmokeCloud } from "./smoke";

let nextGrenadeId = 1;

export class Grenade {
  readonly id = nextGrenadeId++;
  game: ServerGame;
  d: GrenadeDef;
  thrower: unknown;
  age = 0;
  stillTime = 0;
  detonated = false;
  done = false;
  cloud: SmokeCloud | null = null;
  body: RigidBody;
  lastSpeed: number;

  constructor(game: ServerGame, d: GrenadeDef, pos: V3, vel: V3, thrower: unknown) {
    this.game = game;
    this.d = d;
    this.thrower = thrower;
    const r = modelRadius(d.model);
    this.body = new RigidBody(pos, vel, [r, r, r], d.restitution, d.friction, 0.05);
    this.lastSpeed = this.body.speed;
  }

  get pos(): V3 { return this.body.pos; }
  get vel(): V3 { return this.body.vel; }

  physics(dt: number): void {
    if (!this.done && !(this.detonated && this.d.key === "smoke" && this.body.resting)) this.body.step(dt, this.game.world);
  }

  fixedUpdate(dt: number): void {
    if (this.done) return;
    this.age += dt;
    const speed = this.body.speed;
    if (this.lastSpeed - speed > 2 && this.age > 0.05) {
      this.game.fx.playAt("grenade_bounce", this.pos, Math.min((this.lastSpeed - speed) / 8, 1));
    }
    this.lastSpeed = speed;
    if (!this.detonated) {
      if (this.d.key === "smoke") {
        this.stillTime = speed < 0.25 ? this.stillTime + dt : 0;
        if (this.stillTime >= Number(this.d.raw.settle_time ?? 0.35) || this.age >= this.d.fuse) this.detonate();
      } else if (this.age >= this.d.fuse) this.detonate();
    } else if (this.d.key === "smoke") {
      if (!this.cloud || this.cloud.age >= this.cloud.duration) this.destroy();
    }
  }

  detonate(): void {
    this.detonated = true;
    const g = this.game;
    const p: V3 = [...this.pos] as V3;
    const kind = this.d.key;
    const raw = this.d.raw;
    if (kind === "frag") {
      g.fx.explosion(p, Number(raw.radius ?? 9));
      g.fx.playAt("explosion", p, 1);
      g.destruction.explosion(p, Number(raw.wall_damage ?? 260), Number(raw.wall_radius ?? 1.1));
      g.director?.tactical.onExplosion(p, 2.5);
      this.applyBlast(p);
      g.notifyNoise(p, 1, 60, this.thrower);
      this.destroy();
    } else if (kind === "flash") {
      g.fx.flashbang(p);
      g.fx.playAt("flashbang", p, 1);
      this.applyFlash(p);
      g.notifyNoise(p, 1, 45, this.thrower);
      this.destroy();
    } else if (kind === "emp") {
      const r = Number(raw.radius ?? 7);
      g.fx.empBurst(p, r);
      g.fx.playAt("emp", p, 1);
      const side = (this.thrower as { side?: string } | null)?.side ?? "";
      g.director?.tactical.emp(p, r, Number(raw.duration ?? 12), side);
      g.notifyNoise(p, 0.7, 30, this.thrower);
      this.destroy();
    } else if (kind === "smoke") {
      this.cloud = g.smoke.add(p, Number(raw.radius ?? 3.7), Number(raw.duration ?? 18));
      g.fx.playAt("smoke_pop", p, 0.8);
      this.body.vel = [0, 0, 0];
      this.body.resting = true;
    }
  }

  private applyBlast(p: V3): void {
    const g = this.game;
    const raw = this.d.raw;
    const r = Number(raw.radius ?? 9), dmgMax = Number(raw.damage ?? 98), power = Number(raw.falloff_power ?? 1.4);
    for (const target of g.damageables()) {
      const center = target.centerOfMass();
      const dist = Math.hypot(center[0] - p[0], center[1] - p[1], center[2] - p[2]);
      if (dist >= r || !target.damageable.alive) continue;
      const hit = g.world.ray([p[0], p[1], p[2] + 0.15], center, MASK_SIGHT);
      if (hit && Math.hypot(hit.pos[0] - center[0], hit.pos[1] - center[1], hit.pos[2] - center[2]) > 0.3) continue;
      const dir = vnorm(vsub(center, p));
      const res = target.damageable.takeDamage(damageInfo({ amount: blastDamage(dist, r, dmgMax, power),
        armorPenetration: Number(raw.armor_penetration ?? 0.5), hitgroup: "chest", kind: "explosion", attacker: this.thrower,
        weapon: "frag", pos: center, direction: dir }));
      if (res) target.onHit?.(res, center, dir);
      if (res && target !== this.thrower) g.fx.hitMarker(this.thrower, res.killed, false);
    }
  }

  private applyFlash(p: V3): void {
    const g = this.game;
    const r = Number(this.d.raw.radius ?? 28), maxBlind = Number(this.d.raw.max_blind ?? 4.6);
    const d = g.director;
    if (!d) return;
    d.applyFlash(p, r, maxBlind);
    for (const h of d.humans) {
      if (!h.alive) continue;
      const eye = h.eye();
      const to = vsub(p, eye);
      const dist = Math.hypot(to[0], to[1], to[2]);
      if (dist >= r) continue;
      const back = vnorm(vsub(eye, p));
      if (g.world.ray(eye, [p[0] + back[0] * 0.1, p[1] + back[1] * 0.1, p[2] + back[2] * 0.1], MASK_SIGHT)) continue;
      if (g.smoke.between(eye, p) > 0.8) continue;
      const fwd = anglesToDir(h.motor.yaw, h.motor.pitch);
      const k = 1 / Math.max(dist, 1e-3);
      const cosA = fwd[0] * to[0] * k + fwd[1] * to[1] * k + fwd[2] * to[2] * k;
      const duration = flashDuration(dist, r, cosA, maxBlind);
      if (duration > 0.15) g.fx.blind(h, duration, duration / maxBlind);
    }
  }

  destroy(): void { this.done = true; }
}
