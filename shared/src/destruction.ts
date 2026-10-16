// Destructible soft walls and floors (Siege-style). A panel is a thin box cut into chunks of about 25 cm,
// each with hit points from its surface (data/destruction.json): bullets chip the chunk they hit, melee
// smashes a small area, explosions destroy everything inside a radius, wall charges and the thermal lance
// cut a door-sized opening. The standing chunks are merged into as few boxes as possible for collision.
// Defenders can reinforce marked walls: bullet-proof, only the thermal lance gets through.
//
// The server owns the panels; the browser rebuilds a damaged panel's collision and mesh from the chunk
// mask in the snapshots (packMask / unpackMask), with the same rectangle merge.

import { type CollisionWorld, GROUP_PANEL } from "./collision";
import { DESTRUCTION, type Json } from "./data";
import type { PanelSpec } from "./level/level";
import { type M3, type V3, hprMatrix, pyRound } from "./math";

export const CHUNK = Number(DESTRUCTION.chunk_size ?? 0.25);

export function surfaceStrength(surface: string): Json {
  const s = DESTRUCTION.surfaces;
  return s[surface] ?? s.default;
}

/** Greedy cover of the standing cells by rectangles [i0, i1, j0, j1] inclusive. */
export function mergeRects(alive: Uint8Array, nu: number, nv: number): Array<[number, number, number, number]> {
  const used = new Uint8Array(nu * nv);
  const out: Array<[number, number, number, number]> = [];
  const at = (i: number, j: number) => i * nv + j;
  for (let j = 0; j < nv; j++) {
    let i = 0;
    while (i < nu) {
      if (!alive[at(i, j)] || used[at(i, j)]) { i++; continue; }
      let i2 = i;
      while (i2 + 1 < nu && alive[at(i2 + 1, j)] && !used[at(i2 + 1, j)]) i2++;
      let j2 = j;
      for (;;) {
        if (j2 + 1 >= nv) break;
        let ok = true;
        for (let k = i; k <= i2; k++) if (!alive[at(k, j2 + 1)] || used[at(k, j2 + 1)]) { ok = false; break; }
        if (!ok) break;
        j2++;
      }
      for (let a = i; a <= i2; a++) for (let b = j; b <= j2; b++) used[at(a, b)] = 1;
      out.push([i, i2, j, j2]);
      i = i2 + 1;
    }
  }
  return out;
}

export function packMask(alive: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(alive.length / 8));
  for (let k = 0; k < alive.length; k++) if (alive[k]) out[k >> 3] |= 1 << (k & 7);
  return out;
}

export function unpackMask(mask: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let k = 0; k < n; k++) out[k] = (mask[k >> 3] >> (k & 7)) & 1;
  return out;
}

export class Panel {
  spec: PanelSpec;
  index: number;
  center: V3;
  size: V3;
  thin: number;
  ax: [number, number];
  nu: number;
  nv: number;
  cu: number;
  cv: number;
  R: M3;
  maxHp: number;
  hp: Float32Array;
  alive: Uint8Array;            // i-major: index i * nv + j
  reinforced = false;
  intact = true;
  dirty = true;
  version = 0;
  cuPos: Float64Array;          // per cell: local coordinate along ax[0]
  cvPos: Float64Array;

  constructor(spec: PanelSpec, index: number) {
    this.spec = spec;
    this.index = index;
    this.center = [...spec.center] as V3;
    this.size = [...spec.size] as V3;
    this.thin = this.size.indexOf(Math.min(...this.size));
    this.ax = [0, 1, 2].filter((i) => i !== this.thin) as [number, number];
    const [a, b] = this.ax;
    this.nu = Math.max(1, pyRound(this.size[a] / CHUNK));
    this.nv = Math.max(1, pyRound(this.size[b] / CHUNK));
    this.cu = this.size[a] / this.nu;
    this.cv = this.size[b] / this.nv;
    this.R = hprMatrix(spec.hpr[0], spec.hpr[1], spec.hpr[2]);
    this.maxHp = Number(surfaceStrength(spec.surface).hp);
    const n = this.nu * this.nv;
    this.hp = new Float32Array(n).fill(this.maxHp);
    this.alive = new Uint8Array(n).fill(1);
    this.cuPos = new Float64Array(n);
    this.cvPos = new Float64Array(n);
    for (let i = 0; i < this.nu; i++) for (let j = 0; j < this.nv; j++) {
      this.cuPos[i * this.nv + j] = (i + 0.5) * this.cu - this.size[a] / 2;
      this.cvPos[i * this.nv + j] = (j + 0.5) * this.cv - this.size[b] / 2;
    }
  }

  // ------------------------------------------------------------ frames
  toLocal(p: ArrayLike<number>): V3 {
    const d = [p[0] - this.center[0], p[1] - this.center[1], p[2] - this.center[2]];
    const R = this.R;
    return [d[0] * R[0][0] + d[1] * R[0][1] + d[2] * R[0][2], d[0] * R[1][0] + d[1] * R[1][1] + d[2] * R[1][2],
      d[0] * R[2][0] + d[1] * R[2][1] + d[2] * R[2][2]];
  }

  toWorld(l: ArrayLike<number>): V3 {
    const R = this.R;
    return [l[0] * R[0][0] + l[1] * R[1][0] + l[2] * R[2][0] + this.center[0],
      l[0] * R[0][1] + l[1] * R[1][1] + l[2] * R[2][1] + this.center[1],
      l[0] * R[0][2] + l[1] * R[1][2] + l[2] * R[2][2] + this.center[2]];
  }

  get normal(): V3 { return [...this.R[this.thin]] as V3; }

  cellCenterLocal(k: number): V3 {
    const v: V3 = [0, 0, 0];
    v[this.ax[0]] = this.cuPos[k];
    v[this.ax[1]] = this.cvPos[k];
    return v;
  }

  destroyedFraction(): number {
    let n = 0;
    for (const a of this.alive) n += a;
    return 1 - n / this.alive.length;
  }

  allAlive(): boolean {
    for (const a of this.alive) if (!a) return false;
    return true;
  }

  /** Fraction of chunks standing in a window (panel-local metres). */
  intactFractionAround(u: number, v0: number, v1: number, width: number): number {
    let n = 0, s = 0;
    for (let k = 0; k < this.alive.length; k++) {
      if (Math.abs(this.cuPos[k] - u) <= width / 2 && this.cvPos[k] >= v0 && this.cvPos[k] <= v1) { n++; s += this.alive[k]; }
    }
    return n ? s / n : 1;
  }

  // ------------------------------------------------------------ damage
  /** Damage chunks within radius of a world point; returns the indices destroyed. */
  damage(point: ArrayLike<number>, radius: number, amount: number, kind: string): number[] {
    if (this.reinforced && kind !== "thermal") return [];
    const lp = this.toLocal(point);
    const halfT = this.size[this.thin] / 2;
    if (Math.abs(lp[this.thin]) > halfT + radius + 0.05) return [];
    const [a, b] = this.ax;
    const dead: number[] = [];
    let any = false;
    for (let k = 0; k < this.alive.length; k++) {
      if (!this.alive[k]) continue;
      const dx = Math.max(Math.abs(this.cuPos[k] - lp[a]) - this.cu / 2, 0);
      const dy = Math.max(Math.abs(this.cvPos[k] - lp[b]) - this.cv / 2, 0);
      const d = Math.hypot(dx, dy);
      if (d > radius) continue;
      any = true;
      const fall = 1 - 0.5 * Math.min(Math.max(d / Math.max(radius, 1e-3), 0), 1);
      this.hp[k] -= Math.fround(amount * fall);
      if (this.hp[k] <= 0) dead.push(k);
    }
    if (!any || !dead.length) return [];
    this.kill(dead);
    return dead;
  }

  /** Remove every chunk whose centre lies in the panel-local rectangle. */
  cut(u0: number, u1: number, v0: number, v1: number, kind: string): number[] {
    if (this.reinforced && kind !== "thermal") return [];
    const dead: number[] = [];
    for (let k = 0; k < this.alive.length; k++) {
      if (this.alive[k] && this.cuPos[k] >= u0 && this.cuPos[k] <= u1 && this.cvPos[k] >= v0 && this.cvPos[k] <= v1) dead.push(k);
    }
    if (!dead.length) return [];
    if (this.reinforced) this.reinforced = false;      // the lance burns through the plates too
    this.kill(dead);
    return dead;
  }

  private kill(dead: number[]): void {
    for (const k of dead) { this.alive[k] = 0; this.hp[k] = 0; }
    this.dirty = true;
    this.intact = false;
    this.version++;
  }

  canReinforce(): boolean {
    const cfg = DESTRUCTION.reinforce;
    return this.spec.reinforceable && !this.reinforced && this.destroyedFraction() <= Number(cfg.max_damaged_fraction ?? 0.15);
  }

  reinforce(): void {
    this.reinforced = true;
    this.alive.fill(1);
    this.hp.fill(this.maxHp);
    this.version++;
    this.intact = true;
    this.dirty = true;
  }

  restore(): void {
    this.alive.fill(1);
    this.hp.fill(this.maxHp);
    this.intact = true;
    this.reinforced = false;
    this.version = 0;
    this.dirty = true;
  }

  /** The standing chunks as world boxes (a reinforced panel is one whole box). */
  boxes(): Array<{ c: V3; h: V3; R: M3 }> {
    const rects = this.reinforced ? [[0, this.nu - 1, 0, this.nv - 1] as [number, number, number, number]]
      : mergeRects(this.alive, this.nu, this.nv);
    const [a, b] = this.ax;
    return rects.map(([i0, i1, j0, j1]) => {
      const half: V3 = [0, 0, 0];
      half[a] = (i1 - i0 + 1) * this.cu / 2;
      half[b] = (j1 - j0 + 1) * this.cv / 2;
      half[this.thin] = this.size[this.thin] / 2;
      const off: V3 = [0, 0, 0];
      off[a] = (this.cuPos[i0 * this.nv] + this.cuPos[i1 * this.nv]) / 2;
      off[b] = (this.cvPos[j0] + this.cvPos[j1]) / 2;
      // a box in the panel's frame: its axes are the panel's rows, its half extents in that frame
      return { c: this.toWorld(off), h: half, R: this.R };
    });
  }

  /** Put this panel's current collision into a collision world. */
  syncCollision(world: CollisionWorld): void {
    this.dirty = false;
    world.setDynamic(`panel:${this.index}`, GROUP_PANEL, this.reinforced ? "reinforced" : this.spec.surface, this.boxes(),
      { panel: this.index });
  }

  packedMask(): Uint8Array { return packMask(this.alive); }

  setMask(mask: Uint8Array, reinforced: boolean): void {
    this.alive = unpackMask(mask, this.nu * this.nv);
    this.reinforced = reinforced;
    this.intact = !reinforced && this.allAlive();
    this.dirty = true;
  }
}
