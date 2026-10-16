// Controllers of the bots: movement, aim policy and shooting. The brain decides what to do a few times per
// second; these run every tick and decide how, on top of the layers every bot shares (AimController, the
// character controller, the inventory):
// * Mover follows navmesh paths from the team's PathService; walks when the possibility field puts enemies
//   near the path ahead; keeps spacing and waits behind a doorway a teammate is going through; never stops
//   inside a doorway.
// * AimPolicy places the crosshair while moving or holding: head height on the likeliest place an enemy can
//   appear in view, else along the path.
// * Shooter is the trigger discipline: fire only when the bullets land within the target's angular size,
//   bursts that shorten with range, pauses for the recoil to reset, no shooting through teammates; the flick
//   of a new target overshoots or undershoots; a pre-fire is a short burst at a believed position.
// * PeekHelper finds the side step that breaks line of sight to a threat and back.

import { MASK_BULLETS, MASK_SIGHT } from "@cs/shared/collision";
import { type V3, wrap180 } from "@cs/shared/math";
import { crc32 } from "@cs/shared/rng";
import type { WeaponState } from "@cs/shared/weapons";
import type { Soldier } from "../sim/soldier";
import { anglesTo } from "./aim";
import type { BotAgent } from "./bot";
import type { BrainV2 } from "./brain";
import type { Fact } from "./knowledge";
import type { Pt3 } from "./navmesh";
import { PENDING, type PathResult } from "./pathing";
import type { Contact } from "./perception";
import type { PathFollower } from "./steering";

export const HEAD = 1.55;
export const EYE = 1.62;

export const flat = (v: ArrayLike<number>): V3 => [v[0], v[1], 0];
export const len2 = (v: ArrayLike<number>) => Math.hypot(v[0], v[1]);
export const len3 = (v: ArrayLike<number>) => Math.hypot(v[0], v[1], v[2]);
export const sub3 = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const unit2 = (v: ArrayLike<number>): V3 => { const l = Math.hypot(v[0], v[1]); return l > 0 ? [v[0] / l, v[1] / l, 0] : [0, 0, 0]; };
export const dist3 = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** A fixed coin flip per bot, the same in every run. */
export function stableBit(name: string): boolean { return (crc32(name) & 1) === 1; }

export type GoalKey = string | null;

export class Mover {
  b: BrainV2;
  bot: BotAgent;
  goalKey: GoalKey = null;
  goal: V3 | null = null;
  waiting = 0;
  pendingT = 0;
  private progPos: V3 | null = null;
  private progT = 0;
  private escapes = 0;
  private detour: V3 | null = null;
  private detourUntil = 0;
  private spaceN = 0;
  private slow: number | null = null;

  constructor(brain: BrainV2) {
    this.b = brain;
    this.bot = brain.bot;
  }

  reset(): void {
    this.goalKey = null;
    this.goal = null;
    this.waiting = 0;
    this.progPos = null;
    this.progT = 0;
    this.escapes = 0;
    this.detour = null;
    this.detourUntil = 0;
    this.b.follower.stop();
  }

  /** Move towards goal (through `via` lane points). True when arrived. walk null = decide from danger;
   * run forces running (time pressure). */
  to(goal: V3, dt: number, key: string, walk: boolean | null = null, via: number[][] = [], look: V3 | null = null, run = false): boolean {
    const b = this.b;
    const bot = this.bot;
    const pos = bot.position();
    const f = b.follower;
    if (this.goalKey !== key || (f.failed && !f.active)) {
      const path = this.plan(pos, goal, via);
      if (path === PENDING) {
        this.pendingT += dt;
        b.look(look ?? [goal[0], goal[1], goal[2] + EYE], dt, 0.5);
        return false;
      }
      this.pendingT = 0;
      this.goalKey = key;
      this.goal = [goal[0], goal[1], goal[2]];
      if (path === null) return len2(sub3(goal, pos)) < 1.0;
      f.follow(path);
    }
    if (!f.active) return f.arrived || len2(sub3(goal, pos)) < 0.8;
    const st = f.update(dt, pos, bot.char.horizontalSpeed);
    const it = bot.intent;
    let wish = this.spacing(st.wish, pos);
    wish = this.unstick(wish, pos);
    it.wish = wish;
    it.crouch = st.crouch;
    it.jump = st.jump;
    if (walk === null) walk = !run && b.shouldWalk(pos);
    it.walk = walk;
    b.look(look ?? b.aimPolicy.travelPoint(pos, f), dt, 0.6);
    return false;
  }

  /** No progress for 2.5 s while trying to move: first another route (a different cost bias), then a step to
   * a nearby open tactical point, away from whatever blocks. */
  private unstick(wish: V3, pos: V3): V3 {
    const b = this.b;
    const now = b.bot.now;
    if (this.detour) {
      const d = flat(sub3(this.detour, pos));
      if (now > this.detourUntil || len2(d) < 0.5) this.detour = null;
      else return unit2(d);
    }
    if (wish[0] * wish[0] + wish[1] * wish[1] < 0.04) {
      this.progPos = null;                 // standing still on purpose (spacing, waiting)
      return wish;
    }
    if (!this.progPos || dist3(pos, this.progPos) > 0.6) {
      this.progPos = [pos[0], pos[1], pos[2]];
      this.progT = now;
      return wish;
    }
    if (now - this.progT < 2.5) return wish;
    this.progT = now;
    this.escapes++;
    if (this.escapes % 2 === 1) {
      b.biasKey = 1 + (b.biasKey % 3);
      b.follower.biasKey = b.biasKey;
      this.goalKey = null;                 // plan again next tick, on the other route
      return wish;
    }
    const tm = b.tm;
    let best: V3 | null = null, bs = -1e9;
    for (const i of tm.pointsNear(pos, 5.0, 1.0)) {
      const q = tm.pl[i];
      const v: V3 = [q[0] - pos[0], q[1] - pos[1], 0];
      const dist = len2(v);
      if (dist < 2.0 || !b.nav.walkableLine(pos, q)) continue;
      const score = -(v[0] / dist * wish[0] + v[1] / dist * wish[1]) + b.rng.random() * 0.5;
      if (score > bs) { best = [q[0], q[1], q[2]]; bs = score; }
    }
    if (best) {
      this.detour = best;
      this.detourUntil = now + 2.0;
      this.goalKey = null;
      return unit2(sub3(best, pos));
    }
    return wish;
  }

  private plan(pos: V3, goal: V3, via: number[][]): PathResult {
    const b = this.b;
    let pts = via.filter((p) => Math.hypot(p[0] - pos[0], p[1] - pos[1]) > 2.0);
    if (pts.length) {
      let k = 0, kd = Infinity;
      pts.forEach((p, i) => { const d = Math.hypot(p[0] - pos[0], p[1] - pos[1]); if (d < kd) { kd = d; k = i; } });
      pts = pts.slice(k);
    }
    const legs: number[][] = [[...pos], ...pts.map((v) => [...v]), [...goal]];
    let path: Pt3[] = [];
    for (let i = 0; i < legs.length - 1; i++) {
      let a = legs[i], c = legs[i + 1];
      if (a.length === 2) a = [a[0], a[1], path.length ? path[path.length - 1][2] : pos[2]];
      if (c.length === 2) c = [c[0], c[1], a[2]];
      const key = ["rotate", "regroup", "retake", "fallback"].includes(b.task.tag) ? 4 : b.biasKey;
      const leg = b.paths.request(a, c, key);
      if (leg === PENDING) return PENDING;
      if (leg === null) continue;
      path = path.length ? path.concat(leg.slice(1)) : leg;
    }
    return path.length >= 2 ? path : null;
  }

  /** Keep out of a teammate's back and out of a doorway someone is in (worked out every other tick). */
  private spacing(wish: V3, pos: V3): V3 {
    if (wish[0] * wish[0] + wish[1] * wish[1] < 1e-6) return wish;
    const b = this.b;
    const d = unit2(wish);
    this.spaceN++;
    let slow: number;
    if (this.spaceN % 2 === 1 && this.slow !== null) slow = this.slow;
    else {
      slow = this.slowFactor(d, pos);
      this.slow = slow;
    }
    if (slow <= 0) {
      this.waiting += 1 / 64;
      if (this.waiting > 2.5) {             // don't wait forever: sidestep past
        const s = stableBit(b.bot.name) ? 1 : -1;
        return unit2([d[0] * 0.4 - d[1] * s, d[1] * 0.4 + d[0] * s, 0]);
      }
      return [0, 0, 0];
    }
    this.waiting = 0;
    return slow < 1 ? [d[0] * slow, d[1] * slow, 0] : wish;
  }

  private slowFactor(d: V3, pos: V3): number {
    const b = this.b;
    let slow = 1.0;
    for (const m of b.team.matesOf(b.bot)) {
      const q = m.position();
      const vx = q[0] - pos[0], vy = q[1] - pos[1];
      const dist = Math.hypot(vx, vy);
      if (dist < 1e-3 || Math.abs(q[2] - pos[2]) > 1.5) continue;
      const ahead = (vx * d[0] + vy * d[1]) / dist;
      if (dist < 1.3 && ahead > 0.5) slow = Math.min(slow, dist < 0.9 ? 0 : 0.35);
      else if (dist < 3.0 && ahead > 0.6 && b.atDoor(q)) slow = 0;
    }
    if (slow < 1 && b.atDoor(pos)) slow = 1;   // never stop in a doorway
    return slow;
  }
}

/** Where to put the crosshair when there is no target. */
export class AimPolicy {
  b: BrainV2;
  point: V3 | null = null;
  next = 0;
  private alt: V3 | null = null;
  private altT = 0;
  private onAlt = false;

  constructor(brain: BrainV2) { this.b = brain; }

  reset(): void {
    this.point = null;
    this.next = 0;
  }

  travelPoint(pos: V3, follower: PathFollower): V3 {
    const b = this.b;
    const now = b.bot.now;
    if (now >= this.next || !this.point) {
      this.next = now + 0.25;
      const ahead = follower.lookAhead(pos, 4.0);
      let fwd: V3 | null = null;
      if (ahead) {
        fwd = flat(sub3(ahead, pos));
        if (fwd[0] * fwd[0] + fwd[1] * fwd[1] > 1e-6) fwd = unit2(fwd);
      }
      // along the route by default, a corner off it only when the team's picture clearly puts someone there
      const p = fwd ? b.likelyPoint(pos, fwd, 30.0, 80.0, false, 0.08)?.[0] ?? null : null;
      if (p) this.point = p;
      else if (ahead) this.point = [ahead[0], ahead[1], ahead[2] + 1.5];
    }
    return this.point ?? [pos[0], pos[1] + 4, pos[2] + EYE];
  }

  /** Holding: the most dangerous visible place, switching now and then between the top two. */
  holdPoint(pos: V3, defaultYaw: number | null, watch: V3 | null): V3 {
    const b = this.b;
    const now = b.bot.now;
    if (now >= this.next || !this.point) {
      this.next = now + b.rng.uniform(0.5, 0.9);
      const p = b.likelyPoint(pos, null, 45.0, 200.0, true, 0, watch);
      if (p) {
        this.point = p[0];
        this.alt = p[1];
        this.onAlt = false;
      } else if (watch) {
        this.point = watch;
        this.alt = null;
      } else if (defaultYaw !== null) {
        const h = defaultYaw * Math.PI / 180;
        this.point = [pos[0] - Math.sin(h) * 8, pos[1] + Math.cos(h) * 8, pos[2] + EYE];
        this.alt = null;
      }
    }
    if (this.alt && now >= this.altT) {
      // live on the likelier angle, check the other one briefly now and then
      this.onAlt = !this.onAlt;
      this.altT = now + (this.onAlt ? b.rng.uniform(0.6, 1.0) : b.rng.uniform(2.5, 4.5));
      const p = this.point;
      this.point = this.alt;
      this.alt = p;
    }
    return this.point ?? [pos[0], pos[1] + 4, pos[2] + EYE];
  }
}

/** Beyond these distances a weapon class is not worth firing (unless shot at). */
export const RANGE_LIMIT: Record<string, number> = { shotgun: 18.0, smg: 40.0, pistol: 40.0 };

/** Trigger discipline and aim at a visible target (one per bot). */
export class Shooter {
  b: BrainV2;
  bot: BotAgent;
  targetId: number | null = null;
  burst = 0;
  burstLimit = 3;
  pauseUntil = 0;
  preferHead = false;
  engagedSince = 0;
  prefireShots = 0;

  constructor(brain: BrainV2) {
    this.b = brain;
    this.bot = brain.bot;
  }

  reset(): void {
    this.targetId = null;
    this.burst = 0;
    this.burstLimit = 3;
    this.pauseUntil = 0;
    this.preferHead = false;
    this.engagedSince = 0;
    this.prefireShots = 0;
  }

  acquire(c: Contact, now: number): void {
    const bot = this.bot;
    if (this.targetId === c.agent.uid) return;
    this.targetId = c.agent.uid;
    this.engagedSince = now;
    this.preferHead = bot.rng.random() < Number(bot.profile.headshot ?? 0.3);
    this.burst = 0;
    const dist = dist3(c.pos, bot.position());
    this.burstLimit = this.burstFor(dist);
    // a flick onto a new target over- or undershoots, then the hand corrects
    const eye = bot.eye();
    const [yaw] = anglesTo(c.pos[0] - eye[0], c.pos[1] - eye[1], c.pos[2] + 1.4 - eye[2]);
    const turn = Math.abs(wrap180(yaw - bot.aim.yaw));
    const tvel = c.agent.velocity();
    bot.aim.acquire(c.agent.uid, dist, Math.hypot(tvel[0], tvel[1]), bot.char.horizontalSpeed);
    // the flick decides which side of the target the first-shot error falls on, never how big it is
    const over = this.b.human.flick(turn);
    if (over !== 0) {
      const sign = wrap180(yaw - bot.aim.yaw) > 0 ? 1 : -1;
      bot.aim.errX = Math.abs(bot.aim.errX) * sign * (over > 0 ? 1 : -1);
    }
  }

  release(): void {
    this.targetId = null;
    this.bot.aim.release();
  }

  burstFor(dist: number): number {
    const mx = Number(this.bot.profile.max_burst ?? 10);
    const r = this.bot.rng;
    if (dist < 9) return mx;
    if (dist < 20) return Math.min(mx, r.randint(3, 6));
    if (dist < 35) return Math.min(mx, r.randint(2, 3));
    return 1;
  }

  onFired(): void {
    this.burst++;
    if (this.burst >= this.burstLimit) {
      this.burst = 0;
      const d = this.b.targetDistance();
      const ws = this.bot.weapons.inv.current();
      let pause = 0.12 + Math.min(d, 40.0) * 0.009;
      if (ws && ws.d.fireMode === "auto" && d > 18) pause += 0.1;
      this.pauseUntil = this.bot.now + pause * this.bot.rng.uniform(0.8, 1.3);
      this.burstLimit = this.burstFor(d);
    }
  }

  /** Aim at a visible contact and pull the trigger when on target: [firing, angular offset, tolerance, use head]. */
  engage(c: Contact, dt: number, now: number): [boolean, number, number, boolean] {
    const bot = this.bot;
    const enemy = c.agent;
    const eye = bot.eye();
    const head = enemy.headPos();
    const chest = enemy.centerOfMass();
    const useHead = c.headVisible && (this.preferHead || !c.bodyVisible);
    const point = useHead ? head : chest;
    const dist = dist3(point, eye);
    const tvel = enemy.velocity();
    const tspeed = Math.hypot(tvel[0], tvel[1]);
    this.acquire(c, now);
    bot.aim.updateError(dt, tspeed, dist);
    this.b.ensureWeapon(dist);
    const ws = bot.weapons.inv.current();
    const recoil: [number, number] = ws ? ws.recoilOffset(Math.floor(ws.recoilIndex)) : [0, 0];
    const off = bot.aim.track(eye, [point[0] + tvel[0] * 0.05, point[1] + tvel[1] * 0.05, point[2] + tvel[2] * 0.05], dt, recoil);
    const tol = bot.aim.fireTolerance(dist, useHead ? 0.1 : 0.2);
    let can = ws !== null && off <= tol && now >= this.pauseUntil && !ws.busy(now);
    if (ws) {
      if (ws.d.magazine > 0 && ws.ammo === 0) {
        can = false;
        if (!ws.reloading) ws.startReload(now);
      }
      const limit = RANGE_LIMIT[ws.d.cls];
      const shotAt = now - this.b.lastHitT < 2.0;
      if (limit !== undefined && dist > limit && !(shotAt && ws.d.cls !== "shotgun")) can = false;
      if (ws.d.fireMode === "melee") can = dist < 1.8 && off < 12;
    }
    if (can && this.b.teammateInLine(eye, point)) can = false;
    if (can && ws) this.pull(ws, dist, now);
    const firing = can || (ws !== null && now - bot.lastFired < 0.12);
    return [firing, off, tol, useHead];
  }

  pull(ws: WeaponState, dist: number, now: number): void {
    const it = this.bot.intent;
    if (ws.d.fireMode === "auto") it.trigger = true;
    else {
      it.pressed = true;
      if (ws.d.fireMode !== "melee") this.pauseUntil = now + this.semiPause(ws, dist);
    }
  }

  semiPause(ws: WeaponState, dist: number): number {
    if (ws.d.fireMode === "bolt" || ws.d.fireMode === "pump") return ws.d.fireInterval + 0.15;
    const base = Math.max(ws.d.fireInterval, 0.12);
    return base + Math.min(dist, 40.0) * 0.006 * this.bot.rng.uniform(0.6, 1.4);
  }

  /** Short burst at a believed position the bot cannot see (yet). True while firing. */
  prefire(point: V3, _fact: Fact, dt: number, now: number): boolean {
    const bot = this.bot;
    const ws = bot.weapons.inv.current();
    if (!ws || ws.d.fireMode === "melee" || ws.ammo <= 0 || ws.busy(now)) return false;
    const eye = bot.eye();
    const rest = bot.aim.lookAt(eye, point, dt, 1.0);
    if (rest > 2.0 || now < this.pauseUntil) return true;
    if (this.b.teammateInLine(eye, point)) return false;
    this.pull(ws, dist3(point, eye), now);
    this.prefireShots++;
    if (this.prefireShots >= 3) {
      this.pauseUntil = now + 0.5;
      this.prefireShots = 0;
      return false;
    }
    return true;
  }
}

/** Side steps that break (hide) or open (peek) the line of sight to a point. */
export class PeekHelper {
  b: BrainV2;
  bot: BotAgent;

  constructor(brain: BrainV2) {
    this.b = brain;
    this.bot = brain.bot;
  }

  /** Sideways direction (unit) where, `step` metres away, the threat cannot see the bot. */
  hideDir(threat: V3, step = 0.9): V3 | null {
    const bot = this.bot;
    const pos = bot.position();
    const world = bot.game.world;
    const to = flat(sub3(threat, pos));
    if (to[0] * to[0] + to[1] * to[1] < 1e-4) return null;
    const u = unit2(to);
    const side: V3 = [-u[1], u[0], 0];
    for (const sgn of [1, -1]) {
      const d: V3 = [side[0] * sgn, side[1] * sgn, 0];
      const q: V3 = [pos[0] + d[0] * step, pos[1] + d[1] * step, pos[2]];
      if (!this.b.nav.walkableLine(pos, q)) continue;
      if (world.ray([q[0], q[1], q[2] + EYE], threat, MASK_SIGHT) !== null) return d;
      if (world.ray([q[0], q[1], q[2] + 1.05], threat, MASK_SIGHT) !== null) return d;
    }
    return null;
  }

  exposedTo(point: V3): boolean { return this.bot.game.world.ray(this.bot.eye(), point, MASK_SIGHT) === null; }
}

export function teammateInLine(bot: BotAgent, eye: V3, point: V3): boolean {
  const hit = bot.game.rayFirst(eye, point, MASK_BULLETS, bot);
  if (!hit || !hit.owner || hit.owner === bot) return false;
  const owner = hit.owner as unknown as Soldier;
  return owner.side === bot.side;
}
