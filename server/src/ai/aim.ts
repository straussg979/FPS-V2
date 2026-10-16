// Bot aiming: human-like view control.
// * The view turns towards a target with an exponential snap (fast first, slowing near the target) limited
//   by a maximum turn speed.
// * When a bot acquires a target its aim carries an error offset whose size depends on difficulty, distance
//   and how fast the target and the bot move; it shrinks while the bot keeps tracking (error_decay per
//   second) down to min_error.
// * While spraying, the bot pulls against the weapon's recoil by spray_control of the offset.
// * fireTolerance tells the brain when the crosshair is close enough to pull the trigger.

import { wrap180 } from "@cs/shared/math";
import { Random } from "@cs/shared/rng";

/** Heading/pitch that look along (dx, dy, dz). */
export function anglesTo(dx: number, dy: number, dz: number): [number, number] {
  return [Math.atan2(-dx, dy) * 180 / Math.PI, Math.atan2(dz, Math.hypot(dx, dy)) * 180 / Math.PI];
}

const pmod = (a: number, m: number) => ((a % m) + m) % m;

/* eslint-disable @typescript-eslint/no-explicit-any */
export class AimController {
  p: Record<string, any>;
  rng: Random;
  yaw = 0;
  pitch = 0;
  errX = 0;
  errY = 0;
  errScale = 0;
  private targetId: unknown = null;
  private jitterT = 0;

  constructor(profile: Record<string, any>, rng: Random | null = null) {
    this.p = profile;
    this.rng = rng ?? new Random();
  }

  /** Rotate the view towards (yaw, pitch); returns the remaining angle. */
  turnTowards(yaw: number, pitch: number, dt: number, speedScale = 1.0): number {
    const dy = wrap180(yaw - this.yaw);
    const dp = pitch - this.pitch;
    const dist = Math.hypot(dy, dp);
    if (dist < 1e-4) return 0.0;
    const k = 1.0 - Math.exp(-Number(this.p.snap ?? 10.0) * dt);
    let step = dist * k;
    const maxStep = Number(this.p.turn_speed ?? 400.0) * speedScale * dt;
    step = Math.min(step, maxStep);
    step = Math.max(step, Math.min(dist, 4.0 * dt));      // never stall on tiny remainders
    const f = step / dist;
    this.yaw = pmod(this.yaw + dy * f, 360.0);
    this.pitch = Math.max(-89.0, Math.min(89.0, this.pitch + dp * f));
    return dist - step;
  }

  lookAt(eye: ArrayLike<number>, point: ArrayLike<number>, dt: number, speedScale = 1.0): number {
    const [yaw, pitch] = anglesTo(point[0] - eye[0], point[1] - eye[1], point[2] - eye[2]);
    return this.turnTowards(yaw, pitch, dt, speedScale);
  }

  /** New target: roll a fresh aim error. */
  acquire(targetId: unknown, distance: number, targetSpeed: number, ownSpeed: number): void {
    if (targetId === this.targetId) return;
    this.targetId = targetId;
    const base = Number(this.p.aim_error ?? 2.0);
    let scale = base * (1.0 + targetSpeed / 6.0) * (1.0 + ownSpeed / 4.0);
    scale *= 0.7 + 0.3 * Math.min(distance / 25.0, 1.5);
    const a = this.rng.uniform(0, 2 * Math.PI);
    const r = scale * (0.5 + 0.5 * this.rng.random());
    this.errX = Math.cos(a) * r;
    this.errY = Math.sin(a) * r * 0.7;
    this.errScale = scale;
  }

  release(): void { this.targetId = null; }

  updateError(dt: number, targetSpeed = 0.0, distance = 0.0): void {
    const decay = Math.exp(-Number(this.p.error_decay ?? 1.5) * dt);
    // the residual error grows with distance, so long fights take longer and are less one-sided
    const floor = Number(this.p.min_error ?? 0.3) * (1.0 + targetSpeed / 5.0) * (1.0 + distance / 30.0);
    let mag = Math.hypot(this.errX, this.errY);
    if (mag > floor) { this.errX *= decay; this.errY *= decay; }
    // a little hand wobble, re-rolled a few times per second
    this.jitterT -= dt;
    if (this.jitterT <= 0) {
      this.jitterT = this.rng.uniform(0.15, 0.35);
      const j = floor * 0.5;
      this.errX += this.rng.uniform(-j, j);
      this.errY += this.rng.uniform(-j, j) * 0.6;
      mag = Math.hypot(this.errX, this.errY);
      const cap = Math.max(this.errScale, floor) * 1.2;
      if (mag > cap) { this.errX *= cap / mag; this.errY *= cap / mag; }
    }
  }

  /** Aim at point (+ current error), pulling against the recoil offset. Returns the angular distance (deg)
   * between the bullet line and the point. */
  track(eye: ArrayLike<number>, point: ArrayLike<number>, dt: number, recoil: [number, number] = [0, 0], speedScale = 1.0): number {
    const [yaw, pitch] = anglesTo(point[0] - eye[0], point[1] - eye[1], point[2] - eye[2]);
    const c = Number(this.p.spray_control ?? 0.5);
    const [rx, ry] = recoil;
    // bullets land at view + recoil offset (x right, y up): aim the other way
    this.turnTowards(yaw - this.errX + rx * c, pitch + this.errY - ry * c, dt, speedScale);
    const by = wrap180(this.yaw - rx - yaw);
    const bp = this.pitch + ry - pitch;
    return Math.hypot(by, bp);
  }

  /** Angle within which the bot pulls the trigger. */
  fireTolerance(distance: number, radius = 0.2): number {
    const ang = Math.atan2(radius, Math.max(distance, 0.5)) * 180 / Math.PI;
    return Math.max(ang, 0.35) * Number(this.p.fire_tolerance ?? 1.5);
  }
}
