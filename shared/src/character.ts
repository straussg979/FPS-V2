// Kinematic character controller (collide-and-slide on box sweeps), shared by players, bots and drones,
// on the server and in the browser's prediction: the same code gives the same result on both.
//
// * The hull is a world-aligned box (Source/CS style); ``pos`` is the point between the feet.
// * Each tick the move is swept through the collision world; on a hit the character moves up to the
//   contact (minus a skin), its velocity is clipped against the plane and the rest of the time is used
//   (max 4 bumps; creases between two planes slide along their line).
// * Stairs: a blocked ground move is retried from step height up; the farther one wins.
// * Ground: a short downward sweep finds walkable ground; while grounded the probe reaches step
//   height so walking down stairs snaps instead of skipping.
// * Crouching shrinks the hull; standing up checks headroom; crouching in the air tucks the legs up.
// * Source-style friction and acceleration (counter-strafing, walk/crouch accuracy).
//
// Every stored vector component is rounded to 32-bit floats (Math.fround), as the Python original's
// Panda3D vectors were, so movement numbers match the desktop version tick for tick.

import movementJson from "../../data/movement.json";
import { type CollisionWorld, MASK_MOVEMENT } from "./collision";
import type { V3 } from "./math";

const f = Math.fround;

export const SKIN = 0.012;
const MAX_BUMPS = 4;
const MAX_DEPEN_STEP = 0.1;
const EDGE_SUPPORT_NZ = 0.35;
export const GRAVITY = 20.0;

export type MovementConfig = typeof movementJson;
export const MOVEMENT: MovementConfig = movementJson;

export interface MoveInput {
  wish: V3;            // world-space horizontal unit vector
  walk: boolean;
  crouch: boolean;
  jump: boolean;
  speedScale: number;
}

export const NO_MOVE: MoveInput = { wish: [0, 0, 0], walk: false, crouch: false, jump: false, speedScale: 1 };

export interface StepEvent {
  kind: "footstep" | "land" | "jump";
  pos: V3;
  surface: string;
  loudness: number;
  speed: number;
}

// float32 vectors
const V = (x = 0, y = 0, z = 0): V3 => [f(x), f(y), f(z)];
const add = (a: V3, b: V3): V3 => [f(a[0] + b[0]), f(a[1] + b[1]), f(a[2] + b[2])];
const sub = (a: V3, b: V3): V3 => [f(a[0] - b[0]), f(a[1] - b[1]), f(a[2] - b[2])];
const scale = (a: V3, s: number): V3 => { const k = f(s); return [f(a[0] * k), f(a[1] * k), f(a[2] * k)]; };
const neg = (a: V3): V3 => [-a[0], -a[1], -a[2]];
const dot = (a: V3, b: V3) => f(f(f(a[0] * b[0]) + f(a[1] * b[1])) + f(a[2] * b[2]));
const len2 = (a: V3) => dot(a, a);
const len = (a: V3) => f(Math.sqrt(len2(a)));
const crossV = (a: V3, b: V3): V3 =>
  [f(f(a[1] * b[2]) - f(a[2] * b[1])), f(f(a[2] * b[0]) - f(a[0] * b[2])), f(f(a[0] * b[1]) - f(a[1] * b[0]))];
export function normalized(a: V3): V3 {
  const l2 = len2(a);
  if (l2 === 0) return a.slice() as V3;
  if (Math.abs(l2 - 1) <= 1e-12) return a.slice() as V3;
  const r = f(1 / f(Math.sqrt(l2)));
  return [f(a[0] * r), f(a[1] * r), f(a[2] * r)];
}
export const f32vec = V;

function pyRound(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

export class KinematicCharacter {
  world: CollisionWorld;
  cfg: MovementConfig;
  mask: number;
  radius: number;
  standHeight: number;
  crouchHeight: number;
  stepHeight: number;
  minWalkNormal: number;
  pos: V3 = V();
  vel: V3 = V();
  height: number;
  prevPos: V3 = V();
  prevHeight: number;
  onGround = false;
  groundNormal: V3 = V(0, 0, 1);
  groundSurface = "default";
  crouched = false;
  walking = false;
  jumpCooldown = 0;
  landingTimer = 0;
  airTime = 0;
  lastFallSpeed = 0;
  stride = 0;
  lastHitPos: V3 = V();
  onEvent: ((e: StepEvent) => void) | null = null;
  depenInterval = 1;           // bots: check for overlaps every N ticks only
  private depenK = 0;

  constructor(world: CollisionWorld, cfg: MovementConfig = MOVEMENT, mask = MASK_MOVEMENT) {
    this.world = world;
    this.cfg = cfg;
    this.mask = mask;
    this.radius = cfg.radius;
    this.standHeight = cfg.stand_height;
    this.crouchHeight = cfg.crouch_height;
    this.stepHeight = cfg.step_height;
    this.minWalkNormal = Math.cos(cfg.max_slope_deg * Math.PI / 180);
    this.height = this.standHeight;
    this.prevHeight = this.height;
  }

  key(height: number): number { return pyRound(height * 100); }

  center(feet: V3, height?: number): V3 {
    const h = height === undefined ? this.height : height;
    return [feet[0], feet[1], f(feet[2] + this.key(h) / 200.0)];
  }

  half(height: number): V3 { return [this.radius, this.radius, this.key(height) / 200.0]; }

  get eyeHeight(): number { return this.height - this.cfg.eye_offset; }

  get horizontalSpeed(): number { return Math.hypot(this.vel[0], this.vel[1]); }

  teleport(pos: ArrayLike<number>): void {
    this.pos = V(pos[0], pos[1], pos[2]);
    this.prevPos = this.pos.slice() as V3;
    this.vel = V();
    this.onGround = false;
    this.depenetrate();
    this.groundCheck(0.5);
  }

  // ------------------------------------------------------------ traces
  trace(start: V3, end: V3, height?: number): [number, V3, string] | null {
    const d = sub(end, start);
    if (len2(d) < 1e-12) return null;
    const h = height === undefined ? this.height : height;
    const c0 = this.center(start, h), c1 = this.center(end, h);
    const res = this.world.sweep(c0, this.half(h), [c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]], this.mask);
    if (!res) return null;
    let n = V(...res.normal);
    if (len2(n) < 1e-8) n = neg(normalized(d));
    else n = normalized(n);
    this.lastHitPos = V(...res.pos);
    return [f(res.fraction), n, res.box.body.surface];
  }

  surfaceNormalBelow(hitPos: V3, feet: V3): [V3, string] | null {
    let away = V(hitPos[0] - feet[0], hitPos[1] - feet[1], 0);
    if (len2(away) > 1e-8) away = normalized(away);
    const probe = add(V(...hitPos), scale(away, 0.03));
    const res = this.world.ray(add(probe, V(0, 0, 0.08)), sub(probe, V(0, 0, 0.12)), this.mask);
    if (res) {
      const n = V(...res.normal);
      if (len2(n) > 1e-8) return [normalized(n), res.body.surface];
    }
    return null;
  }

  depenetrate(iterations = 3): boolean {
    let moved = false;
    for (let it = 0; it < iterations; it++) {
      const c = this.center(this.pos);
      const pens = this.world.penetrations(c, this.half(this.height), this.mask).filter((p) => p.depth > 1e-4);
      // summed in a fixed order, so the result never depends on the bodies' order
      pens.sort((a, b) => (b.depth - a.depth) || (a.normal[0] - b.normal[0]) || (a.normal[1] - b.normal[1]) ||
        (a.normal[2] - b.normal[2]));
      let push = V();
      for (const p of pens) push = add(push, scale(V(...p.normal), p.depth + SKIN * 0.5));
      if (this.onGround && push[2] < 0) push[2] = 0;
      if (len2(push) < 1e-10) break;
      const l = len(push);
      if (l > MAX_DEPEN_STEP) push = scale(push, MAX_DEPEN_STEP / l);
      this.pos = add(this.pos, push);
      moved = true;
    }
    return moved;
  }

  // ----------------------------------------------------------- physics
  friction(dt: number): void {
    const speed = Math.hypot(this.vel[0], this.vel[1]);
    if (speed < 1e-4) { this.vel[0] = 0; this.vel[1] = 0; return; }
    const control = Math.max(speed, this.cfg.stop_speed);
    const drop = control * this.cfg.ground_friction * dt;
    const s = Math.max(speed - drop, 0.0) / speed;
    this.vel[0] = f(this.vel[0] * s);
    this.vel[1] = f(this.vel[1] * s);
  }

  accelerate(wish: V3, wishSpeed: number, accel: number, dt: number, cap: number | null = null): void {
    if (wishSpeed <= 0) return;
    const current = dot(this.vel, wish);
    const limit = cap === null ? wishSpeed : Math.min(wishSpeed, cap);
    const addv = limit - current;
    if (addv <= 0) return;
    const accelSpeed = Math.min(accel * dt * wishSpeed, addv);
    this.vel = add(this.vel, scale(wish, accelSpeed));
  }

  static clip(vel: V3, normal: V3, overbounce = 1.001): V3 {
    let backoff = dot(vel, normal);
    if (backoff < 0) backoff = f(backoff * overbounce); else backoff = f(backoff / overbounce);
    return sub(vel, scale(normal, backoff));
  }

  slideMove(pos0: V3, vel0: V3, dt: number): [V3, V3, boolean] {
    let pos = pos0.slice() as V3;
    let vel = vel0.slice() as V3;
    const primal = vel.slice() as V3;
    const planes: V3[] = [];
    let timeLeft = dt;
    let blocked = false;
    for (let bump = 0; bump < MAX_BUMPS; bump++) {
      const delta = scale(vel, timeLeft);
      const dist = len(delta);
      if (dist < 1e-6) break;
      const hit = this.trace(pos, add(pos, delta));
      if (!hit) { pos = add(pos, delta); break; }
      const [frac, n0] = hit;
      let n = n0;
      pos = add(add(pos, scale(delta, frac)), scale(n, SKIN));
      timeLeft *= (1.0 - frac);
      const r = f(1 / dist);
      const direction: V3 = [f(delta[0] * r), f(delta[1] * r), f(delta[2] * r)];
      if (n[2] < this.minWalkNormal) {
        blocked = true;
        if (this.onGround && n[2] > -0.3) {
          n = V(n[0], n[1], 0);
          if (len2(n) < 1e-6) n = neg(direction);
          n = normalized(n);
        }
      }
      planes.push(n);
      vel = KinematicCharacter.clip(vel, n);
      for (let k = 0; k < planes.length - 1; k++) {
        const other = planes[k];
        if (dot(vel, other) < -1e-5) {
          let crease = crossV(other, n);
          if (len2(crease) < 1e-8) vel = V();
          else { crease = normalized(crease); vel = scale(crease, dot(crease, vel)); }
          break;
        }
      }
      if (dot(vel, primal) <= 0) { vel = V(); break; }
    }
    return [pos, vel, blocked];
  }

  stepSlideMove(dt: number): void {
    const startPos = this.pos.slice() as V3;
    const startVel = this.vel.slice() as V3;
    const [downPos, downVel, blocked] = this.slideMove(startPos, startVel, dt);
    if (!(blocked && this.onGround)) { this.pos = downPos; this.vel = downVel; return; }
    const upTarget = add(startPos, V(0, 0, this.stepHeight));
    let hit = this.trace(startPos, upTarget);
    let upPos = startPos.slice() as V3;
    if (!hit) upPos = upTarget;
    else upPos[2] = f(upPos[2] + Math.max(this.stepHeight * hit[0] - SKIN, 0.0));
    if (upPos[2] - startPos[2] < 0.05) { this.pos = downPos; this.vel = downVel; return; }
    const [stepPos, stepVel] = this.slideMove(upPos, startVel, dt);
    const drop = (upPos[2] - startPos[2]) + 0.05;
    hit = this.trace(stepPos, sub(stepPos, V(0, 0, drop)));
    if (hit) {
      if (hit[1][2] < this.minWalkNormal) {
        let real: [V3, string] | null = null;
        if (hit[1][2] > EDGE_SUPPORT_NZ) real = this.surfaceNormalBelow(this.lastHitPos, stepPos);
        if (real === null || real[0][2] < this.minWalkNormal) { this.pos = downPos; this.vel = downVel; return; }
      }
      stepPos[2] = f(stepPos[2] - Math.max(drop * hit[0] - SKIN, 0.0));
    } else {
      stepPos[2] = f(stepPos[2] - drop);
    }
    const dd = f(f(f(downPos[0] - startPos[0]) ** 2) + f(f(downPos[1] - startPos[1]) ** 2));
    const ds = f(f(f(stepPos[0] - startPos[0]) ** 2) + f(f(stepPos[1] - startPos[1]) ** 2));
    if (ds > dd + 1e-6) { this.pos = stepPos; this.vel = V(stepVel[0], stepVel[1], 0); }
    else { this.pos = downPos; this.vel = downVel; }
  }

  groundCheck(probe: number, jumped = false): void {
    const wasOnGround = this.onGround;
    if (jumped || (!wasOnGround && this.vel[2] > 1.0)) { this.onGround = false; return; }
    let hit = this.trace(this.pos, sub(this.pos, V(0, 0, probe)));
    if (hit && EDGE_SUPPORT_NZ < hit[1][2] && hit[1][2] < 0.999) {
      const real = this.surfaceNormalBelow(this.lastHitPos, this.pos);
      if (real && real[0][2] >= this.minWalkNormal) hit = [hit[0], real[0], real[1]];
    }
    if (hit && hit[1][2] >= this.minWalkNormal) {
      const [frac, n, surface] = hit;
      this.pos[2] = f(this.pos[2] - Math.max(probe * frac - SKIN, 0.0));
      this.onGround = true;
      this.groundNormal = n;
      this.groundSurface = surface || "default";
      this.vel[2] = 0;
    } else {
      this.onGround = false;
    }
    if (this.onGround && !wasOnGround) this.onLand();
  }

  onLand(): void {
    const fall = this.lastFallSpeed;
    if (this.airTime > 0.12 && fall > 2.5) {
      this.landingTimer = this.cfg.landing_recover_time * Math.min(fall / 7.0, 1.4);
      let loud = this.cfg.footsteps.land_loudness * Math.min(fall / 6.0, 1.0);
      if (this.walking || this.crouched) loud *= 0.5;
      this.emit("land", loud, fall);
    }
    this.airTime = 0.0;
  }

  updateCrouch(dt: number, wantCrouch: boolean): void {
    const target = wantCrouch ? this.crouchHeight : this.standHeight;
    if (Math.abs(this.height - target) < 1e-4) {
      this.height = target;
      this.crouched = this.height < this.standHeight - 1e-3;
      return;
    }
    const rate = (this.standHeight - this.crouchHeight) / Math.max(this.cfg.crouch_time, 1e-3);
    const step = rate * dt;
    if (target < this.height) {
      const newH = Math.max(this.height - step, target);
      const shrink = this.height - newH;
      if (!this.onGround && this.cfg.crouch_jump_tuck !== false) this.pos[2] = f(this.pos[2] + shrink);
      this.height = newH;
    } else {
      const grow = Math.min(step, target - this.height);
      if (this.onGround) {
        const hit = this.trace(this.pos, add(this.pos, V(0, 0, grow)));
        this.height += hit === null ? grow : Math.max(grow * hit[0] - SKIN, 0.0);
      } else {
        let hit = this.trace(this.pos, sub(this.pos, V(0, 0, grow)));
        const down = hit === null ? grow : Math.max(grow * hit[0] - SKIN, 0.0);
        this.pos[2] = f(this.pos[2] - down);
        this.height += down;
        const rest = grow - down;
        if (rest > 1e-4) {
          hit = this.trace(this.pos, add(this.pos, V(0, 0, rest)));
          this.height += hit === null ? rest : Math.max(rest * hit[0] - SKIN, 0.0);
        }
      }
    }
    this.crouched = this.height < this.standHeight - 1e-3;
  }

  emit(kind: StepEvent["kind"], loudness: number, speed = 0): void {
    if (this.onEvent) this.onEvent({ kind, pos: this.pos.slice() as V3, surface: this.groundSurface, loudness, speed });
  }

  footsteps(dt: number): void {
    if (!this.onGround) return;
    const speed = Math.hypot(this.vel[0], this.vel[1]);
    if (speed < 0.5) { this.stride = Math.min(this.stride, 0.35); return; }
    const fs = this.cfg.footsteps;
    let stride: number, loud: number;
    if (this.crouched) { stride = fs.crouch_stride; loud = fs.crouch_loudness; }
    else if (this.walking) { stride = fs.walk_stride; loud = fs.walk_loudness; }
    else { stride = fs.run_stride; loud = fs.run_loudness; }
    loud *= loud > 0 ? Math.min(speed / (this.cfg.run_speed * 0.8), 1.0) : 0.0;
    this.stride += speed * dt;
    if (this.stride >= stride) {
      this.stride -= stride;
      this.emit("footstep", loud, speed);
    }
  }

  maxSpeed(inp: MoveInput): number {
    const c = this.cfg;
    let base: number;
    if (this.crouched && this.onGround) base = c.crouch_speed;
    else if (inp.walk) base = c.walk_speed;
    else base = c.run_speed;
    if (this.landingTimer > 0) {
      const t = this.landingTimer / c.landing_recover_time;
      base *= 1.0 - (1.0 - c.landing_slowdown) * Math.min(t, 1.0);
    }
    return base * inp.speedScale;
  }

  step(dt: number, inp: MoveInput): void {
    this.prevPos = this.pos.slice() as V3;
    this.prevHeight = this.height;
    const c = this.cfg;
    this.walking = inp.walk;
    this.jumpCooldown = Math.max(this.jumpCooldown - dt, 0.0);
    this.landingTimer = Math.max(this.landingTimer - dt, 0.0);
    this.depenK++;
    if (this.depenK >= this.depenInterval) {
      this.depenK = 0;
      this.depenetrate(2);
    }
    this.updateCrouch(dt, inp.crouch);
    let jumped = false;
    if (inp.jump && this.onGround && this.jumpCooldown <= 0.0) {
      this.vel[2] = f(c.jump_speed);
      this.onGround = false;
      this.jumpCooldown = c.jump_cooldown + 0.3;
      jumped = true;
      const loud = (inp.walk || this.crouched) ? 0.0 : c.footsteps.run_loudness * 0.6;
      this.emit("jump", loud);
    }
    const wishSpeed = this.maxSpeed(inp);
    if (this.onGround) {
      this.vel[2] = 0;
      this.friction(dt);
      this.accelerate(inp.wish, wishSpeed, c.ground_accel, dt);
      const horiz = Math.hypot(this.vel[0], this.vel[1]);
      const limit = c.run_speed * inp.speedScale;
      if (horiz > limit) {
        const s = limit / horiz;
        this.vel[0] = f(this.vel[0] * s);
        this.vel[1] = f(this.vel[1] * s);
      }
      const n = this.groundNormal;
      if (n[2] > 0.01) this.vel[2] = f(-(n[0] * this.vel[0] + n[1] * this.vel[1]) / n[2]);
      this.stepSlideMove(dt);
    } else {
      this.accelerate(inp.wish, wishSpeed, c.air_accel, dt, c.air_wish_cap);
      this.vel[2] = f(this.vel[2] - GRAVITY * dt * 0.5);
      [this.pos, this.vel] = this.slideMove(this.pos, this.vel, dt);
      this.vel[2] = f(this.vel[2] - GRAVITY * dt * 0.5);
      this.airTime += dt;
      this.lastFallSpeed = Math.max(-this.vel[2], 0.0);
    }
    const probe = (this.onGround && !jumped) ? this.stepHeight : 0.04;
    this.groundCheck(probe, jumped);
    if (this.onGround) this.airTime = 0.0;
    this.footsteps(dt);
  }

  interpolatedPos(alpha: number): V3 {
    const p = this.prevPos, q = this.pos;
    return [p[0] + (q[0] - p[0]) * alpha, p[1] + (q[1] - p[1]) * alpha, p[2] + (q[2] - p[2]) * alpha];
  }

  /** Crouch blend 0 (standing) .. 1 (crouched). */
  get crouchAmount(): number {
    return (this.standHeight - this.height) / Math.max(this.standHeight - this.crouchHeight, 1e-3);
  }
}

// ------------------------------------------------------------------- lean
export const LEAN_OFFSET = 0.36;       // metres the eye moves sideways at full lean
export const LEAN_ROLL = 12.0;         // degrees the view rolls at full lean
const LEAN_TIME = 0.16;
export const LEAN_MARGIN = 0.14;       // closest the eye gets to a wall
const HEAD_ABOVE_PIVOT = 0.72;

export class Lean {
  amount = 0.0;
  prev = 0.0;

  update(dt: number, target: number, freeLeft = 1.0, freeRight = 1.0): void {
    this.prev = this.amount;
    const step = dt / LEAN_TIME;
    this.amount += Math.max(-step, Math.min(step, target - this.amount));
    this.amount = Math.max(-freeLeft, Math.min(freeRight, this.amount));
  }

  reset(): void { this.amount = this.prev = 0.0; }
  value(alpha = 1): number { return this.prev + (this.amount - this.prev) * alpha; }
  offset(alpha = 1): number { return this.value(alpha) * LEAN_OFFSET; }
  roll(alpha = 1): number { return this.value(alpha) * LEAN_ROLL; }

  /** Spine roll (degrees) that puts the head over the leaned eye. */
  static bodyRoll(amount: number): number {
    return Math.asin(Math.max(-1, Math.min(1, amount * LEAN_OFFSET / HEAD_ABOVE_PIVOT))) * 180 / Math.PI;
  }
}

export function rightOfYaw(yaw: number): V3 {
  const h = yaw * Math.PI / 180;
  return V(Math.cos(h), Math.sin(h), 0);
}

/** (free_left, free_right): the fraction of a full lean the geometry allows at this eye. */
export function leanClearance(world: CollisionWorld, eye: V3, yaw: number, mask: number): [number, number] {
  const r = rightOfYaw(yaw);
  const out: number[] = [];
  for (const sign of [-1, 1]) {
    const end = add(eye, scale(r, sign * (LEAN_OFFSET + LEAN_MARGIN)));
    const hit = world.ray(eye, end, mask);
    if (!hit) out.push(1.0);
    else {
      const d = Math.hypot(hit.pos[0] - eye[0], hit.pos[1] - eye[1], hit.pos[2] - eye[2]);
      out.push(Math.max(0.0, Math.min(1.0, (d - LEAN_MARGIN) / LEAN_OFFSET)));
    }
  }
  return [out[0], out[1]];
}
