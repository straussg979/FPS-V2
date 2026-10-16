// Tactical map analysis for the bots: precomputed once per map, cached. Humans learn a map's angles; this
// gives the bots the same knowledge from the level geometry:
// 1. Occupancy: the colliders rasterised into a 3D grid (0.25 m, conservative); destructible panels into a
//    second grid that stores which panel fills a cell.
// 2. Tactical points: one per 3 m on every floor of the navmesh, every doorway, every hand-placed position
//    and lane waypoint (~1,500 on a full-size map), each with its callout area, bomb site and polygon.
// 3. Visibility between every pair within 55 m, eye to eye, standing and crouched, as bitsets. Pairs only a
//    panel blocks remember it: when it is shot open they are re-tested with real rays.
// 4. Cover: 16 directions at crouch and standing height, something solid within 1.2 m?
// 5. A point graph (neighbours within 4.5 m reachable in a short walk) and arrival times from both spawns.
// 6. Spots per bomb site: entries, holds (behind the entries they watch, with cover, little exposure),
//    forward spots, off-angles and crossfire pairs.

import { type CollisionWorld, MASK_SIGHT } from "@cs/shared/collision";
import type { Panel } from "@cs/shared/destruction";
import type { Collider, Level } from "@cs/shared/level/level";
import type { MapCache } from "../sim/game";
import { type NavMesh, b64, hashKey, rasterize, unb64 } from "./navmesh";

export const VERSION = 1;
export const N_DIRS = 16;

export const TCFG = { spacing: 3.0, maxRange: 55.0, eyeStand: 1.55, eyeCrouch: 1.05, cell: 0.25, dz: 0.25, step: 0.2,
  linkRange: 4.5, coverRange: 1.2, runSpeed: 5.4 };

const pyRound = (x: number) => { const r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r; };

// ------------------------------------------------------------------ occupancy
class Occupancy {
  cs = TCFG.cell;
  dz = TCFG.dz;
  x0: number; y0: number; z0: number;
  nx: number; ny: number; nz: number;
  hard: Uint8Array;
  soft: Uint8Array;

  constructor(colliders: Collider[], panels: Array<{ center: number[]; size: number[]; hpr: number[]; surface: string }>, bounds: number[][]) {
    const [[bx0, by0, bz0], [bx1, by1, bz1]] = bounds;
    this.x0 = bx0 - 1; this.y0 = by0 - 1; this.z0 = bz0 - 1;
    this.nx = Math.ceil((bx1 - bx0 + 2) / this.cs);
    this.ny = Math.ceil((by1 - by0 + 2) / this.cs);
    this.nz = Math.ceil((bz1 - bz0 + 6) / this.dz);
    this.hard = new Uint8Array(this.nx * this.ny * this.nz);
    this.soft = new Uint8Array(this.nx * this.ny * this.nz);
    const fill = (cols: Collider[], value: number, grid: Uint8Array) => {
      const r = rasterize(cols, this.x0, this.y0, this.nx, this.ny, this.cs);
      for (let k = 0; k < r.col.length; k++) {
        const c = r.col[k];
        const k0 = Math.min(Math.max(Math.floor((r.z0[k] - this.z0) / this.dz), 0), this.nz);
        const k1 = Math.min(Math.max(Math.ceil((r.z1[k] - this.z0) / this.dz), 0), this.nz);
        const iy = Math.floor(c / this.nx), ix = c % this.nx;
        const base = (iy * this.nx + ix) * this.nz;
        for (let z = k0; z < k1; z++) grid[base + z] = value;
      }
    };
    fill(colliders, 1, this.hard);
    panels.forEach((p, i) => fill([{ c: p.center as never, size: p.size as never, hpr: p.hpr as never, surface: p.surface }], i + 1, this.soft));
  }

  /** Line tests: [hard blocked, panel index + 1 blocking (0 none)] for a ray not hard-blocked. */
  trace(a: ArrayLike<number>, b: ArrayLike<number>, step: number): [boolean, number] {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const length = Math.hypot(dx, dy, dz);
    const n = Math.max(Math.ceil(length / step), 1);
    const { nx, ny, nz, cs } = this;
    let soft = 0;
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const ix = Math.floor((a[0] + dx * t - this.x0) / cs);
      const iy = Math.floor((a[1] + dy * t - this.y0) / cs);
      const iz = Math.floor((a[2] + dz * t - this.z0) / this.dz);
      if (ix < 0 || ix >= nx || iy < 0 || iy >= ny || iz < 0 || iz >= nz) continue;
      const f = (iy * nx + ix) * nz + iz;
      if (this.hard[f]) return [true, 0];
      if (this.soft[f] > soft) soft = this.soft[f];
    }
    return [false, soft];
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Hold { i: number; score: number; exposure: number; sees: number[]; off_angle: boolean; crouch: boolean; [k: string]: any }
export interface SiteSpots { entries: number[]; holds: Hold[]; crossfires: number[][]; forward: Array<{ i: number; sees: number[]; margin: number }> }

// --------------------------------------------------------------------- the map
export class TacticalMap {
  pos = new Float32Array(0);           // x, y, z per point
  kind = new Int8Array(0);             // 1 doorway, 2 hand-placed position, 4 lane waypoint
  rect = new Int32Array(0);
  areaId = new Int16Array(0);
  areas: string[] = [];
  siteId = new Int8Array(0);
  sites: string[] = [];
  vis = new Uint8Array(0);             // n rows of w bytes, bit (0x80 >> (j & 7)) of byte j >> 3
  visLow = new Uint8Array(0);
  cover = new Uint16Array(0);
  coverHigh = new Uint16Array(0);
  softPairs = new Int32Array(0);       // i, j, panel
  edges = new Float32Array(0);         // src, dst, length
  eta: Record<string, Float64Array> = {};
  spots: Record<string, SiteSpots> = {};
  buildInfo = "";
  n = 0;
  w = 0;
  private baseVis = new Uint8Array(0);
  pl: Array<[number, number, number]> = [];
  xy = new Float64Array(0);
  z = new Float64Array(0);
  edgeSrc = new Int32Array(0);
  edgeDst = new Int32Array(0);
  edgeLen = new Float64Array(0);
  private grid = new Map<number, number[]>();
  private nearCache = new Map<string, number>();
  private visCache = new Map<number, Uint8Array>();
  private softByPanel = new Map<number, number[]>();
  pending: number[] = [];

  // ------------------------------------------------------------- building
  static build(level: Level, nav: NavMesh, log?: (m: string) => void): TacticalMap {
    const t0 = Date.now();
    const self = new TacticalMap();
    const occ = new Occupancy(level.colliders, level.panelSpecs, level.bounds);
    const tOcc = (Date.now() - t0) / 1000;
    const [pts, kinds] = samplePoints(level, nav);
    const n = pts.length;
    self.pos = new Float32Array(n * 3);
    pts.forEach((p, i) => { self.pos[i * 3] = p[0]; self.pos[i * 3 + 1] = p[1]; self.pos[i * 3 + 2] = p[2]; });
    self.kind = Int8Array.from(kinds);
    self.rect = Int32Array.from(pts.map((p) => nav.rectAt(p, 4, 0.8)));
    self.areas = [...new Set([...pts.map((p) => level.calloutAt(p[0], p[1])), ""])].sort();
    const amap = new Map(self.areas.map((a, i) => [a, i]));
    self.areaId = Int16Array.from(pts.map((p) => amap.get(level.calloutAt(p[0], p[1])) as number));
    const zones = level.zones.filter((z) => z.kind === "bombsite");
    self.sites = zones.map((z) => z.name);
    self.siteId = new Int8Array(n).fill(-1);
    zones.forEach((z, k) => pts.forEach((p, i) => {
      if (p[0] >= z.min[0] && p[1] >= z.min[1] && p[2] >= z.min[2] - 0.5 && p[0] <= z.max[0] && p[1] <= z.max[1] && p[2] <= z.max[2]) self.siteId[i] = k;
    }));
    // visibility
    const t1 = Date.now();
    const w = (n + 7) >> 3;
    self.vis = new Uint8Array(n * w);
    self.visLow = new Uint8Array(n * w);
    const setBit = (arr: Uint8Array, i: number, j: number) => { arr[i * w + (j >> 3)] |= 0x80 >> (j & 7); };
    const soft: number[] = [];
    let nPairs = 0;
    for (let i = 0; i < n; i++) { setBit(self.vis, i, i); setBit(self.visLow, i, i); }
    for (let i = 0; i < n - 1; i++) {
      const p = pts[i];
      for (let j = i + 1; j < n; j++) {
        const q = pts[j];
        if (Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) > TCFG.maxRange) continue;
        nPairs++;
        const [hs, ss] = occ.trace([p[0], p[1], p[2] + TCFG.eyeStand], [q[0], q[1], q[2] + TCFG.eyeStand], TCFG.step);
        if (!hs && ss === 0) { setBit(self.vis, i, j); setBit(self.vis, j, i); }
        if (!hs && ss > 0) soft.push(i, j, ss - 1);
        const [hl, sl] = occ.trace([p[0], p[1], p[2] + TCFG.eyeCrouch], [q[0], q[1], q[2] + TCFG.eyeCrouch], TCFG.step);
        if (!hl && sl === 0) { setBit(self.visLow, i, j); setBit(self.visLow, j, i); }
      }
    }
    self.softPairs = Int32Array.from(soft);
    const tVis = (Date.now() - t1) / 1000;
    // cover
    self.cover = new Uint16Array(n);
    self.coverHigh = new Uint16Array(n);
    for (const [eye, out] of [[TCFG.eyeCrouch, self.cover], [TCFG.eyeStand, self.coverHigh]] as const) {
      for (let k = 0; k < N_DIRS; k++) {
        const ang = 2 * Math.PI * k / N_DIRS;
        for (let i = 0; i < n; i++) {
          const a = [pts[i][0], pts[i][1], pts[i][2] + eye];
          const b = [a[0] + Math.cos(ang) * TCFG.coverRange, a[1] + Math.sin(ang) * TCFG.coverRange, a[2]];
          const [hb, sb] = occ.trace(a, b, TCFG.step * 0.5);
          if (hb || sb > 0) out[i] |= 1 << k;
        }
      }
    }
    // the point graph and spawn arrival times
    self.edges = buildEdges(pts, nav);
    self.index();
    for (const side of ["attack", "defend"]) {
      const seeds = level.spawns.filter((s) => s.team === side).map((s) => s.pos);
      const d = self.dijkstra(seeds.map((p) => self.nearestRaw(p)));
      self.eta[side] = d.map((v) => v / TCFG.runSpeed);
    }
    self.spots = buildSpots(self, level);
    let visible = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (self.sees(i, j)) visible++;
    let doors = 0;
    for (const k of self.kind) if (k & 1) doors++;
    self.buildInfo = `${n} points (${doors} doorways), ${nPairs} pairs within ${TCFG.maxRange} m, ${visible} visible, ` +
      `${self.softPairs.length / 3} through breakable walls, ${self.edges.length / 6} links; occupancy ${tOcc.toFixed(1)}s, ` +
      `visibility ${tVis.toFixed(1)}s, total ${((Date.now() - t0) / 1000).toFixed(1)}s`;
    log?.(`[tactical] ${self.buildInfo}`);
    return self;
  }

  static cached(level: Level, nav: NavMesh, cache: MapCache | null, log?: (m: string) => void): TacticalMap {
    const key = `tactical_${level.mapKey}_${hashKey([VERSION, TCFG, `${nav.nodeCount}:${nav.rects.length}:${nav.portals.length}`,
      level.bounds, level.data.practice_positions, level.data.test_routes, level.spawns.map((s) => s.pos),
      level.colliders.map((c) => [...c.c, ...c.size, ...c.hpr]), level.panelSpecs.map((p) => [...p.center, ...p.size, ...p.hpr])])}`;
    const hit = cache?.load(key) as Record<string, any> | undefined;
    if (hit && hit.version === VERSION) {
      const tm = TacticalMap.deserialize(hit);
      log?.(`[tactical] ${level.mapKey}: ${tm.buildInfo} (cached)`);
      return tm;
    }
    const tm = TacticalMap.build(level, nav, log);
    cache?.save(key, tm.serialize());
    return tm;
  }

  serialize(): Record<string, unknown> {
    return { version: VERSION, areas: this.areas, sites: this.sites, info: this.buildInfo, spots: this.spots,
      pos: b64(this.pos), kind: b64(this.kind), rect: b64(this.rect), areaId: b64(this.areaId), siteId: b64(this.siteId),
      vis: b64(this.vis), visLow: b64(this.visLow), cover: b64(this.cover), coverHigh: b64(this.coverHigh),
      softPairs: b64(this.softPairs), edges: b64(this.edges), etaAttack: b64(this.eta.attack), etaDefend: b64(this.eta.defend) };
  }

  static deserialize(d: Record<string, any>): TacticalMap {
    const self = new TacticalMap();
    self.areas = d.areas; self.sites = d.sites; self.buildInfo = d.info; self.spots = d.spots;
    self.pos = new Float32Array(unb64(d.pos)); self.kind = new Int8Array(unb64(d.kind)); self.rect = new Int32Array(unb64(d.rect));
    self.areaId = new Int16Array(unb64(d.areaId)); self.siteId = new Int8Array(unb64(d.siteId));
    self.vis = new Uint8Array(unb64(d.vis)); self.visLow = new Uint8Array(unb64(d.visLow));
    self.cover = new Uint16Array(unb64(d.cover)); self.coverHigh = new Uint16Array(unb64(d.coverHigh));
    self.softPairs = new Int32Array(unb64(d.softPairs)); self.edges = new Float32Array(unb64(d.edges));
    self.eta = { attack: new Float64Array(unb64(d.etaAttack)), defend: new Float64Array(unb64(d.etaDefend)) };
    self.index();
    return self;
  }

  private index(): void {
    this.n = this.pos.length / 3;
    this.w = (this.n + 7) >> 3;
    this.baseVis = this.vis.slice();
    this.pl = [];
    this.xy = new Float64Array(this.n * 2);
    this.z = new Float64Array(this.n);
    this.grid = new Map();
    for (let i = 0; i < this.n; i++) {
      const p: [number, number, number] = [this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]];
      this.pl.push(p);
      this.xy[i * 2] = p[0];
      this.xy[i * 2 + 1] = p[1];
      this.z[i] = p[2];
      const k = gkey(Math.floor(p[0] / 4), Math.floor(p[1] / 4));
      let l = this.grid.get(k);
      if (!l) this.grid.set(k, (l = []));
      l.push(i);
    }
    const ne = this.edges.length / 3;
    this.edgeSrc = new Int32Array(ne);
    this.edgeDst = new Int32Array(ne);
    this.edgeLen = new Float64Array(ne);
    for (let e = 0; e < ne; e++) {
      this.edgeSrc[e] = this.edges[e * 3];
      this.edgeDst[e] = this.edges[e * 3 + 1];
      this.edgeLen[e] = this.edges[e * 3 + 2];
    }
    this.nearCache.clear();
    this.visCache.clear();
    this.softByPanel = new Map();
    for (let r = 0; r < this.softPairs.length / 3; r++) {
      const pid = this.softPairs[r * 3 + 2];
      let l = this.softByPanel.get(pid);
      if (!l) this.softByPanel.set(pid, (l = []));
      l.push(r);
    }
  }

  nearestRaw(p: ArrayLike<number>): number {
    let best = -1, bd = Infinity;
    for (let i = 0; i < this.n; i++) {
      const q = this.pl[i];
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]) + Math.abs(q[2] - p[2]) * 3;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  dijkstra(sources: number[]): Float64Array {
    const n = this.n;
    const adj: Array<Array<[number, number]>> = Array.from({ length: n }, () => []);
    for (let e = 0; e < this.edgeSrc.length; e++) adj[this.edgeSrc[e]].push([this.edgeDst[e], this.edgeLen[e]]);
    const dist = new Float64Array(n).fill(Infinity);
    const heap = new MinHeap();
    for (const s of sources) { dist[s] = 0; heap.push(0, s); }
    while (heap.size) {
      const [d0, u] = heap.pop();
      if (d0 > dist[u]) continue;
      for (const [v, c] of adj[u]) {
        const nd = d0 + c;
        if (nd < dist[v]) { dist[v] = nd; heap.push(nd, v); }
      }
    }
    for (let i = 0; i < n; i++) if (!Number.isFinite(dist[i])) dist[i] = 1e4;
    return dist;
  }

  // ------------------------------------------------------------- queries
  /** The point nearest to a feet position (same floor), or -1; cached per 0.25 m cell. */
  nearest(p: ArrayLike<number>, maxDz = 1.6): number {
    const px = p[0], py = p[1], pz = p[2];
    const key = `${Math.trunc(px * 4)},${Math.trunc(py * 4)},${Math.trunc(pz * 2)},${maxDz}`;
    const hit = this.nearCache.get(key);
    if (hit !== undefined) return hit;
    const gx = Math.floor(px / 4), gy = Math.floor(py / 4);
    let best = -1, bestD = 1e9;
    for (let r = 0; r < 4; r++) {
      for (let x = gx - r; x <= gx + r; x++) for (let y = gy - r; y <= gy + r; y++) {
        if (r && Math.abs(x - gx) !== r && Math.abs(y - gy) !== r) continue;
        for (const i of this.grid.get(gkey(x, y)) ?? []) {
          const q = this.pl[i];
          const dz = Math.abs(q[2] - pz);
          if (dz > maxDz) continue;
          const d = (q[0] - px) ** 2 + (q[1] - py) ** 2 + dz * dz * 9;
          if (d < bestD) { best = i; bestD = d; }
        }
      }
      if (best >= 0 && r >= 1) break;
    }
    if (this.nearCache.size > 60000) this.nearCache.clear();
    this.nearCache.set(key, best);
    return best;
  }

  sees(i: number, j: number, low = false): boolean {
    return ((low ? this.visLow : this.vis)[i * this.w + (j >> 3)] & (0x80 >> (j & 7))) !== 0;
  }

  /** Points seen from point i (0/1 per point; cached; callers must not modify it). */
  visibleMask(i: number, low = false): Uint8Array {
    const key = i * 2 + (low ? 1 : 0);
    let m = this.visCache.get(key);
    if (!m) {
      if (this.visCache.size > 256) this.visCache.clear();
      m = new Uint8Array(this.n);
      const row = low ? this.visLow : this.vis;
      const base = i * this.w;
      for (let j = 0; j < this.n; j++) m[j] = (row[base + (j >> 3)] >> (7 - (j & 7))) & 1;
      this.visCache.set(key, m);
    }
    return m;
  }

  inView(eye: ArrayLike<number>, yawDeg: number, fovDeg: number, maxRange = 60): Uint8Array {
    const out = new Uint8Array(this.n);
    const h = yawDeg * Math.PI / 180;
    const fx = -Math.sin(h), fy = Math.cos(h);
    const c = Math.cos(fovDeg * 0.5 * Math.PI / 180);
    for (let i = 0; i < this.n; i++) {
      const dx = this.xy[i * 2] - eye[0], dy = this.xy[i * 2 + 1] - eye[1];
      const dist = Math.hypot(dx, dy);
      const cosang = (dx * fx + dy * fy) / Math.max(dist, 1e-3);
      out[i] = (cosang >= c || dist < 2) && dist <= maxRange ? 1 : 0;
    }
    return out;
  }

  seenInView(i: number, eye: ArrayLike<number>, yawDeg: number, fovDeg: number, maxRange = 60): Uint8Array {
    const vis = this.visibleMask(i);
    const out = new Uint8Array(this.n);
    const h = yawDeg * Math.PI / 180;
    const fx = -Math.sin(h), fy = Math.cos(h);
    const c = Math.cos(fovDeg * 0.5 * Math.PI / 180);
    for (let j = 0; j < this.n; j++) {
      if (!vis[j]) continue;
      const dx = this.xy[j * 2] - eye[0], dy = this.xy[j * 2 + 1] - eye[1];
      const dist = Math.hypot(dx, dy);
      const cosang = (dx * fx + dy * fy) / Math.max(dist, 1e-3);
      if ((cosang >= c || dist < 2) && dist <= maxRange) out[j] = 1;
    }
    return out;
  }

  /** Is point i covered (within 1.2 m) in the direction (dx, dy)? */
  coverToward(i: number, dx: number, dy: number, high = false): boolean {
    const deg = ((Math.atan2(dy, dx) * 180 / Math.PI) % 360 + 360) % 360;
    const k = ((pyRound(deg / (360 / N_DIRS)) % N_DIRS) + N_DIRS) % N_DIRS;
    const bits = (high ? this.coverHigh : this.cover)[i];
    return (bits & ((1 << k) | (1 << ((k + 1) % N_DIRS)) | (1 << ((k - 1 + N_DIRS) % N_DIRS)))) !== 0;
  }

  /** Indices (ascending) of the points within radius (2D) and maxDz. */
  pointsNear(p: ArrayLike<number>, radius: number, maxDz = 2.0): number[] {
    const out: number[] = [];
    if (radius > 6) {
      for (let i = 0; i < this.n; i++) {
        if (Math.hypot(this.xy[i * 2] - p[0], this.xy[i * 2 + 1] - p[1]) <= radius && Math.abs(this.z[i] - p[2]) <= maxDz) out.push(i);
      }
      return out;
    }
    for (let x = Math.floor((p[0] - radius) / 4); x <= Math.floor((p[0] + radius) / 4); x++) {
      for (let y = Math.floor((p[1] - radius) / 4); y <= Math.floor((p[1] + radius) / 4); y++) {
        for (const i of this.grid.get(gkey(x, y)) ?? []) {
          if (Math.hypot(this.xy[i * 2] - p[0], this.xy[i * 2 + 1] - p[1]) <= radius && Math.abs(this.z[i] - p[2]) <= maxDz) out.push(i);
        }
      }
    }
    return out.sort((a, b) => a - b);
  }

  siteName(i: number): string {
    const s = this.siteId[i];
    return s >= 0 ? this.sites[s] : "";
  }

  area(i: number): string { return this.areas[this.areaId[i]]; }

  // --------------------------------------------------------- destruction
  onPanel(panel: Panel | null): void {
    if (!panel) {
      this.vis.set(this.baseVis);
      this.pending = [];
      this.visCache.clear();
      return;
    }
    const rows = this.softByPanel.get(panel.index);
    if (rows) this.pending.push(...rows);
  }

  /** Re-test pairs behind changed panels with real rays (time-sliced). */
  update(world: CollisionWorld, budget = 48): number {
    let done = 0;
    const eye = TCFG.eyeStand;
    while (this.pending.length && done < budget) {
      const r = this.pending.pop() as number;
      const i = this.softPairs[r * 3], j = this.softPairs[r * 3 + 1];
      const a = this.pl[i], b = this.pl[j];
      const hit = world.ray([a[0], a[1], a[2] + eye], [b[0], b[1], b[2] + eye], MASK_SIGHT);
      this.setVis(i, j, hit === null);
      done++;
    }
    return done;
  }

  private setVis(i: number, j: number, on: boolean): void {
    this.visCache.delete(i * 2);
    this.visCache.delete(j * 2);
    for (const [a, b] of [[i, j], [j, i]]) {
      if (on) this.vis[a * this.w + (b >> 3)] |= 0x80 >> (b & 7);
      else this.vis[a * this.w + (b >> 3)] &= ~(0x80 >> (b & 7)) & 0xff;
    }
  }

  holds(site: string): Hold[] { return this.spots[site]?.holds ?? []; }
  entries(site: string): number[] { return this.spots[site]?.entries ?? []; }
}

const gkey = (x: number, y: number) => (x + 4096) * 8192 + (y + 4096);

export class MinHeap {
  private a: Array<[number, number]> = [];
  get size(): number { return this.a.length; }
  push(k: number, v: number): void {
    const a = this.a;
    a.push([k, v]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] < a[i][0] || (a[p][0] === a[i][0] && a[p][1] <= a[i][1])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop(): [number, number] {
    const a = this.a;
    const top = a[0];
    const last = a.pop() as [number, number];
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        const lt = (x: number, y: number) => a[x][0] < a[y][0] || (a[x][0] === a[y][0] && a[x][1] < a[y][1]);
        if (l < a.length && lt(l, m)) m = l;
        if (r < a.length && lt(r, m)) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

// ------------------------------------------------------------------ helpers
type P3 = [number, number, number];

/** Grid points on every floor, doorways, hand-placed spots and lane waypoints. */
function samplePoints(level: Level, nav: NavMesh): [P3[], number[]] {
  const cs = nav.cfg.cell;
  const sp = TCFG.spacing;
  const n = nav.nodeCount;
  const xs = new Float64Array(n), ys = new Float64Array(n), zs = new Float64Array(n);
  const gx = new Float64Array(n), gy = new Float64Array(n), gz = new Float64Array(n);
  let gxmin = Infinity, gymin = Infinity, gzmin = Infinity;
  for (let k = 0; k < n; k++) {
    const col = nav.nodeCol[k];
    xs[k] = nav.x0 + (col % nav.nx + 0.5) * cs;
    ys[k] = nav.y0 + (Math.floor(col / nav.nx) + 0.5) * cs;
    zs[k] = nav.nodeZ[k];
    gx[k] = Math.floor(xs[k] / sp); gy[k] = Math.floor(ys[k] / sp); gz[k] = pyRound(zs[k] / 1.6);
    gxmin = Math.min(gxmin, gx[k]); gymin = Math.min(gymin, gy[k]); gzmin = Math.min(gzmin, gz[k]);
  }
  const key = new Float64Array(n), dc = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    key[k] = (gx[k] - gxmin) * 1_000_000 + (gy[k] - gymin) * 1000 + (gz[k] - gzmin);
    dc[k] = (xs[k] - (gx[k] + 0.5) * sp) ** 2 + (ys[k] - (gy[k] + 0.5) * sp) ** 2;
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => key[a] - key[b] || dc[a] - dc[b] || a - b);
  const pts: P3[] = [];
  const kinds: number[] = [];
  for (let i = 0; i < order.length; i++) {
    if (i === 0 || key[order[i]] !== key[order[i - 1]]) {
      const k = order[i];
      pts.push([xs[k], ys[k], zs[k]]);
      kinds.push(0);
    }
  }
  const extra: P3[] = [], ek: number[] = [];
  const seenDoors = new Set<string>();
  for (const p of nav.portals) {
    const [, , ax, ay, bx, by] = p;
    const zr = nav.rectZ[p[0]][0];
    const vertical = Math.abs(ax - bx) < 1e-6;
    const lo = vertical ? Math.min(ay, by) : Math.min(ax, bx), hi = vertical ? Math.max(ay, by) : Math.max(ax, bx);
    if (hi - lo + cs > 2.2) continue;
    const line = vertical ? ax : ay;
    const k = pyRound((line - (vertical ? nav.x0 : nav.y0)) / cs);
    const a0 = Math.floor((lo - (vertical ? nav.y0 : nav.x0)) / cs), a1 = Math.floor((hi - (vertical ? nav.y0 : nav.x0)) / cs);
    const blocked = (c: number, a: number) => (vertical ? nav.columnNode(c, a, zr, 0.6, 0.6) : nav.columnNode(a, c, zr, 0.6, 0.6)) < 0;
    const door = [k - 1, k].some((c) => blocked(c, a0 - 1) && blocked(c, a0 - 2) && blocked(c, a1 + 1) && blocked(c, a1 + 2));
    if (!door) continue;
    const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5;
    const dkey = `${Math.round(mx * 10)},${Math.round(my * 10)},${pyRound(zr)}`;
    if (seenDoors.has(dkey)) continue;
    seenDoors.add(dkey);
    const q = nav.snap([mx, my, zr], 3);
    if (q) { extra.push(q); ek.push(1); }
  }
  for (const side of ["defend", "attack"]) {
    for (const e of level.data.practice_positions?.[side] ?? []) {
      const q = nav.snap([e[0], e[1], e[2]], 6);
      if (q) { extra.push(q); ek.push(2); }
    }
  }
  for (const r of level.data.test_routes ?? []) {
    const z0 = r.start.length > 2 ? r.start[2] : 0;
    for (const w of [r.start.slice(0, 3), ...r.waypoints]) {
      const q = nav.snap([w[0], w[1], w.length > 2 ? w[2] : z0], 6);
      if (q) { extra.push(q); ek.push(4); }
    }
  }
  const allp = [...pts, ...extra];
  const allk = [...kinds, ...ek];
  // drop near duplicates, keeping the special points and merging their flags
  const idxOrder = allp.map((_, i) => i).sort((a, b) => (allk[b] > 0 ? 1 : 0) - (allk[a] > 0 ? 1 : 0) || a - b);
  const keep: number[] = [];
  const flags = allk.slice();
  const grid = new Map<number, number[]>();
  for (const i of idxOrder) {
    const p = allp[i];
    const cx = Math.floor(p[0] / 2), cy = Math.floor(p[1] / 2);
    let close = -1;
    outer: for (const x of [cx - 1, cx, cx + 1]) {
      for (const y of [cy - 1, cy, cy + 1]) {
        for (const j of grid.get(gkey(x, y)) ?? []) {
          const q = allp[j];
          const lim = allk[i] || allk[j] ? 1.0 : sp * 0.6;
          if (Math.abs(q[2] - p[2]) < 1.0 && Math.hypot(q[0] - p[0], q[1] - p[1]) < lim) { close = j; break outer; }
        }
      }
    }
    if (close < 0) {
      keep.push(i);
      let l = grid.get(gkey(cx, cy));
      if (!l) grid.set(gkey(cx, cy), (l = []));
      l.push(i);
    } else flags[close] |= allk[i];
  }
  keep.sort((a, b) => a - b);
  return [keep.map((i) => allp[i]), keep.map((i) => flags[i])];
}

function buildEdges(pts: P3[], nav: NavMesh): Float32Array<ArrayBuffer> {
  const n = pts.length;
  const L = TCFG.linkRange;
  const rows: number[] = [];
  const f = Math.fround;
  const grid = new Map<number, number[]>();
  pts.forEach((p, i) => {
    const k = gkey(Math.floor(p[0] / L), Math.floor(p[1] / L));
    let l = grid.get(k);
    if (!l) grid.set(k, (l = []));
    l.push(i);
  });
  pts.forEach((p, i) => {
    const cx = Math.floor(p[0] / L), cy = Math.floor(p[1] / L);
    for (const x of [cx - 1, cx, cx + 1]) for (const y of [cy - 1, cy, cy + 1]) {
      for (const j of grid.get(gkey(x, y)) ?? []) {
        if (j <= i) continue;
        const q = pts[j];
        const d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
        if (d > L || Math.abs(q[2] - p[2]) > 2.2) continue;
        if (nav.walkableLine(p, q) || nav.walkableLine(q, p)) rows.push(i, j, f(d), j, i, f(d));
        else {
          const path = nav.findPath(p, q, null, 80);
          if (path) {
            const length = nav.pathLength(path);
            if (length <= Math.min(1.6 * d, L * 1.5)) rows.push(i, j, f(length), j, i, f(length));
          }
        }
      }
    }
  });
  // join stranded groups (round corners) to their nearest reachable neighbour
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let e = 0; e < rows.length; e += 3) {
    const ra = find(rows[e]), rb = find(rows[e + 1]);
    if (ra !== rb) parent[ra] = rb;
  }
  const comp = Array.from({ length: n }, (_, i) => find(i));
  const counts = new Map<number, number>();
  for (const c of comp) counts.set(c, (counts.get(c) ?? 0) + 1);
  let main = 0, mc = -1;
  for (const [c, k] of [...counts.entries()].sort((a, b) => a[0] - b[0])) if (k > mc) { main = c; mc = k; }
  const others = comp.map((c, i) => (c === main ? i : -1)).filter((i) => i >= 0);
  for (const c of [...counts.keys()].sort((a, b) => a - b)) {
    if (c === main) continue;
    const members = comp.map((cc, i) => (cc === c ? i : -1)).filter((i) => i >= 0);
    let best: [number, number, number] | null = null;
    for (const i of members.slice(0, 6)) {
      const near = others.map((j) => [j, Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1], pts[j][2] - pts[i][2])])
        .sort((a, b) => a[1] - b[1]).slice(0, 3);
      for (const [j] of near) {
        const path = nav.findPath(pts[i], pts[j], null, 400);
        if (path) {
          const length = nav.pathLength(path);
          if (length < 12 && (!best || length < best[2])) best = [i, j, length];
        }
      }
    }
    if (best) rows.push(best[0], best[1], f(best[2]), best[1], best[0], f(best[2]));
  }
  return Float32Array.from(rows);
}

function angle(a: number[], b: number[]): number {
  const na = Math.hypot(a[0], a[1]), nb = Math.hypot(b[0], b[1]);
  if (na < 1e-6 || nb < 1e-6) return 0;
  const c = (a[0] * b[0] + a[1] * b[1]) / (na * nb);
  return Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI;
}

/** Attack routes of the map that end in a site and do not start at the defenders' spawn. */
export function lanesInto(level: Level, zone: { min: number[]; max: number[] }): number[][][] {
  const dspawn = level.spawns.filter((s) => s.team === "defend").map((s) => s.pos);
  const cx = dspawn.reduce((s, p) => s + p[0], 0) / Math.max(dspawn.length, 1);
  const cy = dspawn.reduce((s, p) => s + p[1], 0) / Math.max(dspawn.length, 1);
  const out: number[][][] = [];
  for (const r of level.data.test_routes ?? []) {
    const pts: number[][] = [r.start.slice(0, 3), ...r.waypoints];
    if (Math.hypot(pts[0][0] - cx, pts[0][1] - cy) < 15) continue;
    const end = pts[pts.length - 1];
    if (zone.min[0] - 0.5 <= end[0] && end[0] <= zone.max[0] + 0.5 && zone.min[1] - 0.5 <= end[1] && end[1] <= zone.max[1] + 0.5) out.push(pts);
  }
  return out;
}

function buildSpots(tm: TacticalMap, level: Level): Record<string, SiteSpots> {
  const out: Record<string, SiteSpots> = {};
  const n = tm.n;
  const P = (i: number) => tm.pl[i];
  const dist3 = (i: number, j: number) => Math.hypot(P(i)[0] - P(j)[0], P(i)[1] - P(j)[1], P(i)[2] - P(j)[2]);
  const etaA = tm.eta.attack, etaD = tm.eta.defend;
  const zones = new Map(level.zones.filter((z) => z.kind === "bombsite").map((z) => [z.name, z]));
  tm.sites.forEach((name, k) => {
    const z = zones.get(name) as { min: number[]; max: number[] };
    const dzone = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const p = P(i);
      const dx = Math.max(Math.max(z.min[0] - p[0], 0), p[0] - z.max[0]);
      const dy = Math.max(Math.max(z.min[1] - p[1], 0), p[1] - z.max[1]);
      dzone[i] = Math.hypot(dx, dy);
    }
    const inside = (i: number) => tm.siteId[i] === k;
    const centre = [(z.min[0] + z.max[0]) / 2, (z.min[1] + z.max[1]) / 2, (z.min[2] + z.max[2]) / 2];
    // entries: where the attack lanes cross into the site, plus doorways on its edge attackers reach first
    const cand: number[] = [];
    for (const lane of lanesInto(level, z)) {
      let prev: number[] | null = null;
      for (const q of lane) {
        if (z.min[0] <= q[0] && q[0] <= z.max[0] && z.min[1] <= q[1] && q[1] <= z.max[1]) {
          if (prev) {
            let hit = [prev[0], prev[1]];
            for (let s = 0; s <= 20; s++) {
              const t = s / 20;
              const c = [prev[0] + (q[0] - prev[0]) * t, prev[1] + (q[1] - prev[1]) * t];
              if (z.min[0] <= c[0] && c[0] <= z.max[0] && z.min[1] <= c[1] && c[1] <= z.max[1]) break;
              hit = c;
            }
            const zq = q.length > 2 ? q[2] : z.min[2] + 0.5;
            let best = 0, bd = Infinity;
            for (let i = 0; i < n; i++) {
              const d = Math.hypot(P(i)[0] - hit[0], P(i)[1] - hit[1]) + Math.abs(P(i)[2] - zq) * 3;
              if (d < bd) { bd = d; best = i; }
            }
            cand.push(best);
          }
          break;
        }
        prev = q;
      }
    }
    const linkedIn = new Uint8Array(n);
    for (let e = 0; e < tm.edgeSrc.length; e++) if (inside(tm.edgeDst[e])) linkedIn[tm.edgeSrc[e]] = 1;
    const doors: number[] = [];
    for (let i = 0; i < n; i++) if ((tm.kind[i] & 1) && dzone[i] > 0.2 && dzone[i] < 3.0 && linkedIn[i] && etaA[i] < etaD[i]) doors.push(i);
    const entries = thin([...cand, ...doors], dist3, 4.0);
    const holds: Hold[] = [];
    const margin = (i: number) => etaA[i] - etaD[i];
    const region: number[] = [];
    for (let i = 0; i < n; i++) {
      if (((inside(i) && margin(i) > 0) || (dzone[i] < 14 && margin(i) >= 8)) && !entries.includes(i)) region.push(i);
    }
    const beyond: number[] = [];
    for (let i = 0; i < n; i++) if (!inside(i) && dzone[i] > 6 && etaA[i] < etaD[i]) beyond.push(i);
    for (const h of region) {
      const seen = entries.filter((e) => tm.sees(h, e));
      if (seen.some((e) => etaA[h] < etaA[e] + 0.5)) continue;
      if (!seen.length) continue;
      let score = 0, bestE = -1, bestAngle = 0;
      for (const e of seen) {
        const d = dist3(h, e);
        if (d < 4) continue;
        const w = d >= 6 && d <= 25 ? 1 : 0.5;
        const v = [P(e)[0] - P(h)[0], P(e)[1] - P(h)[1]];
        const covered = tm.coverToward(h, v[0], v[1]) || (tm.sees(h, e) && !tm.sees(h, e, true));
        score += w * (covered ? 1.4 : 1);
        const walk = [centre[0] - P(e)[0], centre[1] - P(e)[1]];
        const ang = angle(walk, [P(h)[0] - P(e)[0], P(h)[1] - P(e)[1]]);
        if (ang > bestAngle) { bestE = e; bestAngle = ang; }
      }
      if (score <= 0) continue;
      let exposure = 0;
      for (const b of beyond) if (tm.sees(h, b)) exposure++;
      score -= 0.02 * exposure;
      score += tm.kind[h] & 2 ? 0.3 : 0;
      const depth = bestE >= 0 ? dist3(h, bestE) : 0;
      holds.push({ i: h, score: Math.round(score * 1000) / 1000, exposure, sees: seen, off_angle: bestAngle > 50 || depth > 18,
        crouch: seen.some((e) => !tm.sees(h, e, true)) && seen.some((e) => tm.sees(h, e)) });
    }
    holds.sort((a, b) => b.score - a.score);
    const picked: Hold[] = [];
    for (const hd of holds) {
      if (picked.every((o) => dist3(hd.i, o.i) > 3)) picked.push(hd);
      if (picked.length >= 16) break;
    }
    const cross: number[][] = [];
    picked.forEach((a, ai) => {
      for (const b of picked.slice(ai + 1)) {
        const common = a.sees.filter((e) => b.sees.includes(e));
        for (const e of common) {
          const va = [P(a.i)[0] - P(e)[0], P(a.i)[1] - P(e)[1]], vb = [P(b.i)[0] - P(e)[0], P(b.i)[1] - P(e)[1]];
          if (angle(va, vb) >= 60) { cross.push([a.i, b.i, e]); break; }
        }
      }
    });
    const forward: Array<{ i: number; sees: number[]; margin: number }> = [];
    const lanePts: number[] = [];
    for (let i = 0; i < n; i++) if (tm.kind[i] & 4) lanePts.push(i);
    for (let fi = 0; fi < n; fi++) {
      if (!(margin(fi) > 2 && margin(fi) < 8 && dzone[fi] < 30 && !inside(fi))) continue;
      const sees = lanePts.filter((l) => tm.sees(fi, l) && dist3(fi, l) > 6 && dist3(fi, l) < 35);
      if (sees.length && tm.cover[fi]) forward.push({ i: fi, sees, margin: Math.round(margin(fi) * 10) / 10 });
    }
    forward.sort((a, b) => b.sees.length - a.sees.length || b.margin - a.margin);
    const fthin: typeof forward = [];
    for (const d of forward) if (fthin.every((o) => dist3(d.i, o.i) >= 4)) fthin.push(d);
    out[name] = { entries, holds: picked, crossfires: cross, forward: fthin.slice(0, 8) };
  });
  return out;
}

function thin(idx: number[], dist: (i: number, j: number) => number, minD: number): number[] {
  const out: number[] = [];
  for (const i of idx) if (out.every((j) => dist(i, j) >= minD)) out.push(i);
  return out;
}
