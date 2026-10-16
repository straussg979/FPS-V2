// The collision world: every solid the game tests against is an oriented box (the level's static boxes
// from the map builder, the destructible panels' standing rectangles, deployed shields, a mode's
// player-clip walls). The same module runs on the server (authoritative movement, bullets, sight) and
// in the browser (movement prediction), so both answer exactly the same.
//
// * sweep(center, half, delta, mask): the first time an axis-aligned box moving along delta touches a
//   box (exact separating axes over the 15 box-box axes), with the contact normal and point;
// * ray / rayAll / rayIntervals: segments against the boxes (slab test);
// * penetrations(center, half, mask): how deep a box sits in each body it overlaps (depenetration).

import { type M3, type V3, hprMatrix } from "./math";

export const GROUP_WORLD = 1;        // static level geometry and gadget solids: blocks everything
export const GROUP_CLIP = 2;         // invisible walls: block movement only
export const GROUP_PANEL = 4;        // destructible soft walls and floors
export const MASK_MOVEMENT = GROUP_WORLD | GROUP_CLIP | GROUP_PANEL;
export const MASK_SIGHT = GROUP_WORLD | GROUP_PANEL;
export const MASK_BULLETS = GROUP_WORLD | GROUP_PANEL;

const CELL = 4.0;
const WORLD_AXES: V3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

export interface Body {
  id: number;
  group: number;
  surface: string;
  panel?: number;            // destructible panel index
  owner?: unknown;           // a deployable (shield)
  boxes: Box[];
}

export interface Box {
  c: V3;
  h: V3;
  R: M3;                     // rows: the box's local x, y, z axes in world space
  axisAligned: boolean;
  axes: V3[];
  min: V3;
  max: V3;
  body: Body;
}

export interface SweepHit { fraction: number; normal: V3; pos: V3; box: Box }
export interface RayHit { fraction: number; normal: V3; pos: V3; body: Body; box: Box }
export interface RayInterval {
  body: Body;
  tIn: number; inPos: V3; inNormal: V3;
  tOut: number | null; outPos: V3 | null; outNormal: V3 | null;
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export function makeBox(c: V3, h: V3, R: M3, body: Body): Box {
  const ext: V3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) ext[k] = Math.abs(R[0][k]) * h[0] + Math.abs(R[1][k]) * h[1] + Math.abs(R[2][k]) * h[2];
  const axisAligned = Math.abs(R[0][0] - 1) < 1e-9 && Math.abs(R[1][1] - 1) < 1e-9 && Math.abs(R[2][2] - 1) < 1e-9;
  let axes: V3[] = WORLD_AXES;
  if (!axisAligned) {
    axes = [...WORLD_AXES, R[0], R[1], R[2]];
    for (const wa of WORLD_AXES) for (const u of R) {
      const cc = cross(wa, u);
      const n2 = dot(cc, cc);
      if (n2 > 1e-10) { const s = 1 / Math.sqrt(n2); axes.push([cc[0] * s, cc[1] * s, cc[2] * s]); }
    }
  }
  return { c, h, R, axisAligned, axes, body,
    min: [c[0] - ext[0], c[1] - ext[1], c[2] - ext[2]], max: [c[0] + ext[0], c[1] + ext[1], c[2] + ext[2]] };
}

const radius = (b: Box, L: V3) =>
  b.h[0] * Math.abs(dot(L, b.R[0])) + b.h[1] * Math.abs(dot(L, b.R[1])) + b.h[2] * Math.abs(dot(L, b.R[2]));

class Grid {
  cells = new Map<number, Box[]>();
  boxes: Box[] = [];
  stamp = new Uint32Array(0);
  query = 0;

  static key(ix: number, iy: number): number { return (ix + 32768) * 65536 + (iy + 32768); }

  build(boxes: Box[]): void {
    this.cells.clear();
    this.boxes = boxes;
    this.stamp = new Uint32Array(boxes.length);
    boxes.forEach((b, i) => {
      (b as Box & { _i?: number })._i = i;
      const x0 = Math.floor(b.min[0] / CELL), x1 = Math.floor(b.max[0] / CELL);
      const y0 = Math.floor(b.min[1] / CELL), y1 = Math.floor(b.max[1] / CELL);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const k = Grid.key(x, y);
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push(b);
      }
    });
  }

  next(): number {
    this.query = (this.query + 1) >>> 0;
    if (this.query === 0) { this.stamp.fill(0); this.query = 1; }
    return this.query;
  }

  /** Boxes whose AABB touches [min, max]. */
  inBox(min: V3, max: V3, mask: number, out: Box[]): void {
    const q = this.next();
    const x0 = Math.floor(min[0] / CELL), x1 = Math.floor(max[0] / CELL);
    const y0 = Math.floor(min[1] / CELL), y1 = Math.floor(max[1] / CELL);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const list = this.cells.get(Grid.key(x, y));
      if (!list) continue;
      for (const b of list) {
        const i = (b as Box & { _i: number })._i;
        if (this.stamp[i] === q) continue;
        this.stamp[i] = q;
        if (!(b.body.group & mask)) continue;
        if (b.max[0] < min[0] || b.min[0] > max[0] || b.max[1] < min[1] || b.min[1] > max[1] ||
            b.max[2] < min[2] || b.min[2] > max[2]) continue;
        out.push(b);
      }
    }
  }

  /** Visit the boxes in the grid cells a segment crosses, in order (2D DDA). ``visit`` returns true to
   * stop; it gets the entry fraction of the cell so a closest-hit search can stop early. */
  alongRay(s: V3, e: V3, mask: number, visit: (b: Box, cellT: number) => boolean): void {
    const q = this.next();
    const dx = e[0] - s[0], dy = e[1] - s[1];
    let ix = Math.floor(s[0] / CELL), iy = Math.floor(s[1] / CELL);
    const ex = Math.floor(e[0] / CELL), ey = Math.floor(e[1] / CELL);
    const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(CELL / dx) : Infinity;
    const tdy = dy !== 0 ? Math.abs(CELL / dy) : Infinity;
    let tmx = dx !== 0 ? ((dx > 0 ? (ix + 1) * CELL - s[0] : s[0] - ix * CELL) / Math.abs(dx)) : Infinity;
    let tmy = dy !== 0 ? ((dy > 0 ? (iy + 1) * CELL - s[1] : s[1] - iy * CELL) / Math.abs(dy)) : Infinity;
    let t = 0;
    const zmin = Math.min(s[2], e[2]), zmax = Math.max(s[2], e[2]);
    for (let guard = 0; guard < 4096; guard++) {
      const list = this.cells.get(Grid.key(ix, iy));
      if (list) {
        for (const b of list) {
          const i = (b as Box & { _i: number })._i;
          if (this.stamp[i] === q) continue;
          this.stamp[i] = q;
          if (!(b.body.group & mask) || b.max[2] < zmin || b.min[2] > zmax) continue;
          if (visit(b, t)) return;
        }
      }
      if (ix === ex && iy === ey) return;
      if (tmx < tmy) { t = tmx; tmx += tdx; ix += stepX; } else { t = tmy; tmy += tdy; iy += stepY; }
      if (t > 1) return;
    }
  }
}

export class CollisionWorld {
  staticGrid = new Grid();
  dynamicGrid = new Grid();
  staticBodies: Body[] = [];
  dynamicBodies = new Map<string, Body>();
  private nextId = 1;
  private dynamicDirty = false;
  version = 0;
  private scratch: Box[] = [];

  /** The level's boxes: [cx, cy, cz, hx, hy, hz, h, p, r, surface]. */
  constructor(boxes: Array<{ c: V3; h: V3; hpr: V3; surface: string }> = []) {
    const out: Box[] = [];
    for (const b of boxes) {
      const body: Body = { id: this.nextId++, group: GROUP_WORLD, surface: b.surface, boxes: [] };
      const box = makeBox(b.c, b.h, hprMatrix(b.hpr[0], b.hpr[1], b.hpr[2]), body);
      body.boxes.push(box);
      this.staticBodies.push(body);
      out.push(box);
    }
    this.staticGrid.build(out);
    this.dynamicGrid.build([]);
  }

  /** Add or replace a dynamic body (a panel's rectangles, a shield, a clip wall) under ``key``.
   * ``boxes`` are in world space: centre, half extents, rotation rows. */
  setDynamic(key: string, group: number, surface: string, boxes: Array<{ c: V3; h: V3; R: M3 }>,
             extra: { panel?: number; owner?: unknown } = {}): Body | null {
    if (!boxes.length) { this.removeDynamic(key); return null; }
    const body: Body = { id: this.nextId++, group, surface, boxes: [], ...extra };
    for (const b of boxes) body.boxes.push(makeBox(b.c, b.h, b.R, body));
    this.dynamicBodies.set(key, body);
    this.dynamicDirty = true;
    this.version++;
    return body;
  }

  removeDynamic(key: string): void {
    if (this.dynamicBodies.delete(key)) {
      this.dynamicDirty = true;
      this.version++;
    }
  }

  private dyn(): Grid {
    if (this.dynamicDirty) {
      const all: Box[] = [];
      for (const b of this.dynamicBodies.values()) all.push(...b.boxes);
      this.dynamicGrid.build(all);
      this.dynamicDirty = false;
    }
    return this.dynamicGrid;
  }

  candidates(min: V3, max: V3, mask: number): Box[] {
    const out = this.scratch;
    out.length = 0;
    this.staticGrid.inBox(min, max, mask, out);
    this.dyn().inBox(min, max, mask, out);
    return out;
  }

  // ------------------------------------------------------------------ sweeps
  /** Sweep the axis-aligned box (centre c, half extents h) by delta: null or the first contact; the
   * normal points from the obstacle towards the moving box. */
  sweep(c: V3, h: V3, delta: V3, mask: number = MASK_MOVEMENT): SweepHit | null {
    const end: V3 = [c[0] + delta[0], c[1] + delta[1], c[2] + delta[2]];
    const min: V3 = [Math.min(c[0], end[0]) - h[0], Math.min(c[1], end[1]) - h[1], Math.min(c[2], end[2]) - h[2]];
    const max: V3 = [Math.max(c[0], end[0]) + h[0], Math.max(c[1], end[1]) + h[1], Math.max(c[2], end[2]) + h[2]];
    let best: SweepHit | null = null;
    for (const b of this.candidates(min, max, mask)) {
      const r = sweepBox(c, h, delta, b);
      if (r && (!best || r.fraction < best.fraction)) best = r;
    }
    if (best) {
      const t = best.fraction;
      const n = best.normal;
      const cc: V3 = [c[0] + delta[0] * t, c[1] + delta[1] * t, c[2] + delta[2] * t];
      const ra = h[0] * Math.abs(n[0]) + h[1] * Math.abs(n[1]) + h[2] * Math.abs(n[2]);
      best.pos = closestOnBox(best.box, [cc[0] - n[0] * ra, cc[1] - n[1] * ra, cc[2] - n[2] * ra]);
    }
    return best;
  }

  // -------------------------------------------------------------------- rays
  /** The first box the segment start-end enters (starting inside a box is no hit, as Bullet). */
  ray(start: V3, end: V3, mask: number = MASK_SIGHT, ignore?: (b: Body) => boolean): RayHit | null {
    const dir: V3 = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
    let best: { t: number; n: V3; box: Box } | null = null;
    const test = (b: Box, cellT: number) => {
      if (best && cellT > best.t) return true;
      if (ignore && ignore(b.body)) return false;
      const r = rayBox(start, dir, b);
      if (r && r.t0 >= 0 && r.t0 <= 1 && r.n0 && (!best || r.t0 < best.t)) best = { t: r.t0, n: r.n0, box: b };
      return false;
    };
    this.staticGrid.alongRay(start, end, mask, test);
    this.dyn().alongRay(start, end, mask, test);
    if (!best) return null;
    const bb = best as { t: number; n: V3; box: Box };
    return { fraction: bb.t, normal: bb.n, box: bb.box, body: bb.box.body,
      pos: [start[0] + dir[0] * bb.t, start[1] + dir[1] * bb.t, start[2] + dir[2] * bb.t] };
  }

  /** Every body the segment enters, its first entry, sorted by fraction. */
  rayAll(start: V3, end: V3, mask: number = MASK_SIGHT): RayHit[] {
    const out = new Map<Body, RayHit>();
    const dir: V3 = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
    const visit = (b: Box) => {
      const r = rayBox(start, dir, b);
      if (!r || r.t0 < 0 || r.t0 > 1 || !r.n0) return false;
      const cur = out.get(b.body);
      if (!cur || r.t0 < cur.fraction) {
        out.set(b.body, { fraction: r.t0, normal: r.n0, box: b, body: b.body,
          pos: [start[0] + dir[0] * r.t0, start[1] + dir[1] * r.t0, start[2] + dir[2] * r.t0] });
      }
      return false;
    };
    this.staticGrid.alongRay(start, end, mask, visit);
    this.dyn().alongRay(start, end, mask, visit);
    return [...out.values()].sort((a, b) => a.fraction - b.fraction);
  }

  /** Per body the segment enters: its entry and, if the segment leaves it again, its exit (the way
   * Bullet's forward and backward rayTestAll give them: the first entry of any of its boxes and the last
   * exit). The bullets' penetration code walks these. */
  rayIntervals(start: V3, end: V3, mask: number = MASK_BULLETS): RayInterval[] {
    const dir: V3 = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
    const ent = new Map<Body, { t: number; n: V3 }>();
    const ext = new Map<Body, { t: number; n: V3 }>();
    const visit = (b: Box) => {
      const r = rayBox(start, dir, b);
      if (!r) return false;
      if (r.t0 >= 0 && r.t0 <= 1 && r.n0) {
        const cur = ent.get(b.body);
        if (!cur || r.t0 < cur.t) ent.set(b.body, { t: r.t0, n: r.n0 });
      }
      if (r.t1 >= 0 && r.t1 <= 1 && r.n1) {
        const cur = ext.get(b.body);
        if (!cur || r.t1 > cur.t) ext.set(b.body, { t: r.t1, n: r.n1 });
      }
      return false;
    };
    this.staticGrid.alongRay(start, end, mask, visit);
    this.dyn().alongRay(start, end, mask, visit);
    const at = (t: number): V3 => [start[0] + dir[0] * t, start[1] + dir[1] * t, start[2] + dir[2] * t];
    const out: RayInterval[] = [];
    for (const [body, e] of ent) {
      const x = ext.get(body);
      if (!x) out.push({ body, tIn: e.t, inPos: at(e.t), inNormal: e.n, tOut: null, outPos: null, outNormal: null });
      else {
        const tOut = Math.max(x.t, e.t);
        out.push({ body, tIn: e.t, inPos: at(e.t), inNormal: e.n, tOut, outPos: at(tOut), outNormal: x.n });
      }
    }
    return out;
  }

  // ------------------------------------------------------------ penetration
  /** The deepest overlap per body: [{depth, normal, body}] (the normal pushes the box out). */
  penetrations(c: V3, h: V3, mask: number = MASK_MOVEMENT): Array<{ depth: number; normal: V3; body: Body }> {
    const min: V3 = [c[0] - h[0], c[1] - h[1], c[2] - h[2]];
    const max: V3 = [c[0] + h[0], c[1] + h[1], c[2] + h[2]];
    const byBody = new Map<Body, { depth: number; normal: V3; body: Body }>();
    for (const b of this.candidates(min, max, mask)) {
      const p = penetration(c, h, b);
      if (!p) continue;
      const cur = byBody.get(b.body);
      if (!cur || p.depth > cur.depth) byBody.set(b.body, { depth: p.depth, normal: p.normal, body: b.body });
    }
    return [...byBody.values()];
  }

  /** Is the point inside any solid of the mask? */
  pointSolid(p: V3, mask: number = MASK_SIGHT): boolean {
    for (const b of this.candidates(p, p, mask)) {
      const d: V3 = [p[0] - b.c[0], p[1] - b.c[1], p[2] - b.c[2]];
      if (Math.abs(dot(d, b.R[0])) <= b.h[0] && Math.abs(dot(d, b.R[1])) <= b.h[1] && Math.abs(dot(d, b.R[2])) <= b.h[2]) return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------- primitives
export function closestOnBox(b: Box, p: V3): V3 {
  const d: V3 = [p[0] - b.c[0], p[1] - b.c[1], p[2] - b.c[2]];
  const out: V3 = [b.c[0], b.c[1], b.c[2]];
  for (let k = 0; k < 3; k++) {
    const u = b.R[k];
    const s = Math.max(-b.h[k], Math.min(b.h[k], dot(d, u)));
    out[0] += u[0] * s; out[1] += u[1] * s; out[2] += u[2] * s;
  }
  return out;
}

function sweepBox(c: V3, h: V3, v: V3, b: Box): SweepHit | null {
  let tEnter = -Infinity, tExit = Infinity;
  let nEnter: V3 | null = null;
  let minPen = Infinity;
  let nPen: V3 | null = null;
  const d: V3 = [c[0] - b.c[0], c[1] - b.c[1], c[2] - b.c[2]];
  for (const L of b.axes) {
    const ra = h[0] * Math.abs(L[0]) + h[1] * Math.abs(L[1]) + h[2] * Math.abs(L[2]);
    const r = ra + radius(b, L);
    const s = dot(d, L);
    const ds = dot(v, L);
    const pen = r - Math.abs(s);
    if (pen < minPen) { minPen = pen; nPen = s >= 0 ? L : [-L[0], -L[1], -L[2]]; }
    if (Math.abs(ds) < 1e-12) {
      if (Math.abs(s) >= r) return null;
      continue;
    }
    let t0 = (-r - s) / ds, t1 = (r - s) / ds;
    if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
    if (t0 > tEnter) { tEnter = t0; nEnter = s >= 0 ? L : [-L[0], -L[1], -L[2]]; }
    if (t1 < tExit) tExit = t1;
    if (tEnter > tExit) return null;
  }
  if (tExit < 0 || tEnter > 1) return null;
  if (tEnter < 0) {
    // overlapping already: a hit at 0 only when moving deeper (as Bullet reports a penetrating start)
    if (!nPen || minPen <= 1e-9) return null;
    if (dot(v, nPen) >= 0) return null;
    return { fraction: 0, normal: [nPen[0], nPen[1], nPen[2]], box: b, pos: [0, 0, 0] };
  }
  const n = nEnter as V3;
  return { fraction: tEnter, normal: [n[0], n[1], n[2]], box: b, pos: [0, 0, 0] };
}

/** Slab test: entry t0 (with the face normal) and exit t1 of the infinite line, or null if it misses. */
export function rayBox(s: V3, dir: V3, b: Box): { t0: number; n0: V3 | null; t1: number; n1: V3 | null } | null {
  const d: V3 = [s[0] - b.c[0], s[1] - b.c[1], s[2] - b.c[2]];
  let t0 = -Infinity, t1 = Infinity;
  let n0: V3 | null = null, n1: V3 | null = null;
  for (let k = 0; k < 3; k++) {
    const u = b.R[k];
    const o = dot(d, u), v = dot(dir, u), e = b.h[k];
    if (Math.abs(v) < 1e-12) {
      if (Math.abs(o) > e) return null;
      continue;
    }
    let a = (-e - o) / v, c = (e - o) / v;
    let sign = -1;
    if (a > c) { const tmp = a; a = c; c = tmp; sign = 1; }
    if (a > t0) { t0 = a; n0 = [u[0] * sign, u[1] * sign, u[2] * sign]; }
    if (c < t1) { t1 = c; n1 = [-u[0] * sign, -u[1] * sign, -u[2] * sign]; }
    if (t0 > t1) return null;
  }
  return { t0, n0, t1, n1 };
}

function penetration(c: V3, h: V3, b: Box): { depth: number; normal: V3 } | null {
  const d: V3 = [c[0] - b.c[0], c[1] - b.c[1], c[2] - b.c[2]];
  let depth: number | null = null;
  let normal: V3 | null = null;
  for (const L of b.axes) {
    const ra = h[0] * Math.abs(L[0]) + h[1] * Math.abs(L[1]) + h[2] * Math.abs(L[2]);
    const dist = dot(L, d);
    const overlap = ra + radius(b, L) - Math.abs(dist);
    if (overlap <= 0) return null;
    if (depth === null || overlap < depth - 1e-9) {
      depth = overlap;
      normal = dist >= 0 ? L : [-L[0], -L[1], -L[2]];
    }
  }
  return depth === null ? null : { depth, normal: [normal![0], normal![1], normal![2]] };
}

// ---------------------------------------------------------------- capsules
/** The segment start-end through the capsule of radius r around a-b, exactly:
 * {tIn, tOut, posIn, nIn, posOut, nOut} as fractions of the segment, or null if it misses or starts
 * inside. posOut is null if the segment ends inside. (engine/physics.segment_capsule) */
export function segmentCapsule(start: V3, end: V3, a: V3, b: V3, r: number):
    { tIn: number; tOut: number; posIn: V3; nIn: V3; posOut: V3 | null; nOut: V3 | null } | null {
  const sx = start[0], sy = start[1], sz = start[2];
  const dx = end[0] - sx, dy = end[1] - sy, dz = end[2] - sz;
  const dd = dx * dx + dy * dy + dz * dz;
  if (dd < 1e-18) return null;
  const ax = a[0], ay = a[1], az = a[2];
  let ux = b[0] - ax, uy = b[1] - ay, uz = b[2] - az;
  const length = Math.sqrt(ux * ux + uy * uy + uz * uz);
  const rr = r * r;
  const spans: Array<[number, number, number]> = [];
  const span = (qa: number, qb: number, qc: number): [number, number] | null => {
    const disc = qb * qb - qa * qc;
    if (disc < 0) return null;
    const q = Math.sqrt(disc);
    return [(-qb - q) / qa, (-qb + q) / qa];
  };
  let centres: Array<[number, number, number, number]>;
  if (length > 1e-9) {
    ux /= length; uy /= length; uz /= length;
    const mx = sx - ax, my = sy - ay, mz = sz - az;
    const du = dx * ux + dy * uy + dz * uz, mu = mx * ux + my * uy + mz * uz;
    const px = dx - ux * du, py = dy - uy * du, pz = dz - uz * du;
    const qx = mx - ux * mu, qy = my - uy * mu, qz = mz - uz * mu;
    const qa = px * px + py * py + pz * pz;
    const qc = qx * qx + qy * qy + qz * qz - rr;
    let cyl: [number, number] | null;
    if (qa < 1e-18) cyl = qc <= 0 ? [-Infinity, Infinity] : null;
    else cyl = span(qa, qx * px + qy * py + qz * pz, qc);
    if (cyl) {
      let slab: [number, number] | null;
      if (Math.abs(du) < 1e-18) slab = mu >= 0 && mu <= length ? [-Infinity, Infinity] : null;
      else {
        const t0 = -mu / du, t1 = (length - mu) / du;
        slab = t0 < t1 ? [t0, t1] : [t1, t0];
      }
      if (slab) {
        const lo = Math.max(cyl[0], slab[0]), hi = Math.min(cyl[1], slab[1]);
        if (lo <= hi) spans.push([lo, hi, 0]);
      }
    }
    centres = [[ax, ay, az, 1], [b[0], b[1], b[2], 2]];
  } else {
    centres = [[ax, ay, az, 1]];
  }
  for (const [cx, cy, cz, kind] of centres) {
    const mx = sx - cx, my = sy - cy, mz = sz - cz;
    const sp = span(dd, mx * dx + my * dy + mz * dz, mx * mx + my * my + mz * mz - rr);
    if (sp) spans.push([sp[0], sp[1], kind]);
  }
  if (!spans.length) return null;
  let tIn = Infinity, tOut = -Infinity, kIn = 0, kOut = 0;
  for (const s of spans) {
    if (s[0] < tIn) { tIn = s[0]; kIn = s[2]; }
    if (s[1] > tOut) { tOut = s[1]; kOut = s[2]; }
  }
  if (tIn < 0 || tIn > 1) return null;
  const surface = (t: number, kind: number): [V3, V3] => {
    const x = sx + dx * t, y = sy + dy * t, z = sz + dz * t;
    let nx: number, ny: number, nz: number;
    if (kind === 0) {
      const vx = x - ax, vy = y - ay, vz = z - az;
      const k = vx * ux + vy * uy + vz * uz;
      nx = vx - ux * k; ny = vy - uy * k; nz = vz - uz * k;
    } else {
      const c = centres[kind - 1];
      nx = x - c[0]; ny = y - c[1]; nz = z - c[2];
    }
    const n = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    return [[x, y, z], [nx / n, ny / n, nz / n]];
  };
  const [posIn, nIn] = surface(tIn, kIn);
  if (tOut > 1) return { tIn, tOut, posIn, nIn, posOut: null, nOut: null };
  const [posOut, nOut] = surface(tOut, kOut);
  return { tIn, tOut, posIn, nIn, posOut, nOut };
}
