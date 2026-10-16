// Path following for bots: navmesh path -> per-tick movement intent. The follower walks the funnel path
// corner to corner, skips ahead when a later corner can be reached in a straight line, crouches before
// crouch-only areas, and detects being stuck: first it tries a hop and a sidestep, then a new path.

import type { V3 } from "@cs/shared/math";
import type { NavMesh, Pt3 } from "./navmesh";

export const ARRIVE_RADIUS = 0.35;
export const CORNER_RADIUS = 0.45;
export const STUCK_TIME = 0.8;

export interface SteerOut { wish: V3; crouch: boolean; jump: boolean }

export class PathFollower {
  nav: NavMesh;
  path: Pt3[] = [];
  index = 0;
  goal: V3 | null = null;
  arrived = true;
  failed = false;
  protected stuckT = 0;
  protected bestDist = 1e9;
  protected unstick = 0;
  protected side = 1;
  protected skipCheck = 0;
  repaths = 0;
  stuckEvents = 0;

  constructor(nav: NavMesh) { this.nav = nav; }

  goTo(start: ArrayLike<number>, goal: ArrayLike<number>, costBias: ((r: number) => number) | null = null): boolean {
    const path = this.nav.findPath(start, goal, costBias);
    this.goal = [goal[0], goal[1], goal[2]];
    this.repaths = 0;
    if (!path) {
      this.path = [];
      this.arrived = false;
      this.failed = true;
      return false;
    }
    this.set(path);
    return true;
  }

  /** Use a precomputed path. */
  follow(points: Pt3[]): void {
    const last = points[points.length - 1];
    this.goal = [last[0], last[1], last[2]];
    this.set(points.slice());
  }

  protected set(path: Pt3[]): void {
    this.path = path;
    this.index = path.length > 1 ? 1 : 0;
    this.arrived = path.length <= 1;
    this.failed = false;
    this.stuckT = 0;
    this.bestDist = 1e9;
  }

  stop(): void {
    this.path = [];
    this.arrived = true;
    this.goal = null;
  }

  get active(): boolean { return this.path.length > 0 && !this.arrived; }

  remaining(pos: ArrayLike<number>): number {
    if (!this.active) return 0.0;
    let d = Math.hypot(pos[0] - this.path[this.index][0], pos[1] - this.path[this.index][1]);
    for (let k = this.index; k < this.path.length - 1; k++) {
      d += Math.hypot(this.path[k][0] - this.path[k + 1][0], this.path[k][1] - this.path[k + 1][1]);
    }
    return d;
  }

  /** Point `distance` metres further along the path (where a bot looks while moving). */
  lookAhead(pos: ArrayLike<number>, distance = 3.0): V3 | null {
    if (!this.active) return null;
    let p: ArrayLike<number> = [pos[0], pos[1], pos[2]];
    let left = distance;
    for (let k = this.index; k < this.path.length; k++) {
      const q = this.path[k];
      const seg = Math.hypot(p[0] - q[0], p[1] - q[1]);
      if (seg >= left) {
        const t = left / Math.max(seg, 1e-6);
        return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
      }
      left -= seg;
      p = q;
    }
    const last = this.path[this.path.length - 1];
    return [last[0], last[1], last[2]];
  }

  /** (wish_dir, crouch, jump) for this tick. */
  update(dt: number, pos: V3, _speed: number): SteerOut {
    const none: SteerOut = { wish: [0, 0, 0], crouch: false, jump: false };
    if (!this.active) return none;
    let target: Pt3, d: number;
    // advance through reached corners
    for (;;) {
      target = this.path[this.index];
      const last = this.index === this.path.length - 1;
      d = Math.hypot(target[0] - pos[0], target[1] - pos[1]);
      const r = last ? ARRIVE_RADIUS : CORNER_RADIUS;
      if (d < r && Math.abs(target[2] - pos[2]) < 1.2) {
        if (last) { this.arrived = true; return none; }
        this.index++;
        this.bestDist = 1e9;
        continue;
      }
      break;
    }
    // skip ahead if the corner after this one is in a straight walk
    this.skipCheck--;
    if (this.skipCheck <= 0 && this.index < this.path.length - 1) {
      this.skipCheck = 8;
      const nxt = this.path[this.index + 1];
      if (this.nav.walkableLine(pos, nxt)) {
        this.index++;
        this.bestDist = 1e9;
        target = this.path[this.index];
        d = Math.hypot(target[0] - pos[0], target[1] - pos[1]);
      }
    }
    let wish: V3 = [target[0] - pos[0], target[1] - pos[1], 0];
    const wl = Math.hypot(wish[0], wish[1]);
    if (wl * wl > 1e-8) wish = [wish[0] / wl, wish[1] / wl, 0];
    // stuck detection: the distance to the current corner must keep shrinking
    let jump = false;
    if (d < this.bestDist - 0.05) {
      this.bestDist = d;
      this.stuckT = 0;
    } else this.stuckT += dt;
    if (this.unstick > 0) {
      this.unstick -= dt;
      const sx = -wish[1] * this.side, sy = wish[0] * this.side;
      const w: V3 = [wish[0] * 0.4 + sx, wish[1] * 0.4 + sy, 0];
      const l = Math.hypot(w[0], w[1]);
      wish = l > 0 ? [w[0] / l, w[1] / l, 0] : w;
    } else if (this.stuckT > STUCK_TIME) {
      this.stuckEvents++;
      this.stuckT = 0;
      this.bestDist = 1e9;
      if (this.stuckEvents % 3 === 0) this.repath(pos);
      else {
        this.unstick = 0.35;
        this.side = -this.side;
        jump = true;
      }
    }
    const ahead: V3 = [pos[0] + wish[0] * 0.55, pos[1] + wish[1] * 0.55, pos[2]];
    const crouch = this.nav.isCrouch(pos) || this.nav.isCrouch(ahead);
    return { wish, crouch, jump };
  }

  protected repath(pos: V3): void {
    if (!this.goal) return;
    this.repaths++;
    const path = this.nav.findPath(pos, this.goal);
    if (!path) {
      this.failed = true;
      this.path = [];
      return;
    }
    this.set(path);
  }
}
