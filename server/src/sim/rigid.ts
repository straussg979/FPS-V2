// Small rigid bodies (grenades, dropped weapons): gravity, damping and bounces off the level's boxes. They
// collide with the world and the panels, not with characters, bullets or player clips.

import { GRAVITY } from "@cs/shared/character";
import { type CollisionWorld, MASK_SIGHT } from "@cs/shared/collision";
import type { V3 } from "@cs/shared/math";

export class RigidBody {
  pos: V3;
  vel: V3;
  half: V3;
  restitution: number;
  friction: number;
  linearDamping: number;
  resting = false;
  lastImpact = 0;           // speed lost in the last bounce (for the bounce sound)

  constructor(pos: V3, vel: V3, half: V3, restitution: number, friction: number, linearDamping = 0.05) {
    this.pos = [...pos] as V3;
    this.vel = [...vel] as V3;
    this.half = half;
    this.restitution = restitution;
    this.friction = friction;
    this.linearDamping = linearDamping;
  }

  get speed(): number { return Math.hypot(this.vel[0], this.vel[1], this.vel[2]); }

  step(dt: number, world: CollisionWorld): void {
    this.lastImpact = 0;
    // pushed out of anything it started in (a panel rebuilt around it, a shield deployed on it)
    for (const p of world.penetrations(this.pos, this.half, MASK_SIGHT)) {
      this.pos[0] += p.normal[0] * (p.depth + 0.002);
      this.pos[1] += p.normal[1] * (p.depth + 0.002);
      this.pos[2] += p.normal[2] * (p.depth + 0.002);
      this.resting = false;
    }
    if (this.resting) {
      // still supported?
      const below = world.sweep(this.pos, this.half, [0, 0, -0.02], MASK_SIGHT);
      if (below) return;
      this.resting = false;
    }
    this.vel[2] -= GRAVITY * dt;
    const damp = Math.pow(1 - this.linearDamping, dt);
    this.vel = [this.vel[0] * damp, this.vel[1] * damp, this.vel[2] * damp];
    let remaining = dt;
    for (let it = 0; it < 4 && remaining > 1e-6; it++) {
      const delta: V3 = [this.vel[0] * remaining, this.vel[1] * remaining, this.vel[2] * remaining];
      const hit = world.sweep(this.pos, this.half, delta, MASK_SIGHT);
      if (!hit) {
        this.pos = [this.pos[0] + delta[0], this.pos[1] + delta[1], this.pos[2] + delta[2]];
        break;
      }
      const n = hit.normal;
      const f = hit.fraction;
      this.pos = [this.pos[0] + delta[0] * f + n[0] * 0.002, this.pos[1] + delta[1] * f + n[1] * 0.002,
        this.pos[2] + delta[2] * f + n[2] * 0.002];
      remaining *= 1 - f;
      const before = this.speed;
      const vn = this.vel[0] * n[0] + this.vel[1] * n[1] + this.vel[2] * n[2];
      if (vn < 0) {
        const vt: V3 = [this.vel[0] - n[0] * vn, this.vel[1] - n[1] * vn, this.vel[2] - n[2] * vn];
        const keepT = Math.max(0, 1 - this.friction * 0.35);
        const bounce = -vn * this.restitution;
        this.vel = [vt[0] * keepT + n[0] * bounce, vt[1] * keepT + n[1] * bounce, vt[2] * keepT + n[2] * bounce];
      }
      this.lastImpact = Math.max(this.lastImpact, before - this.speed);
      if (n[2] > 0.7 && this.speed < 0.35) {
        this.vel = [0, 0, 0];
        this.resting = true;
        break;
      }
    }
  }
}
