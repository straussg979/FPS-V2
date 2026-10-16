// Navigation mesh generated from the level's collision boxes (a small take on the Recast pipeline):
// 1. rasterise every collider into vertical columns of a 0.25 m grid (upright boxes conservatively, tilted
//    ones - ramps - at the cell centre); 2. merge each column's solid intervals: the top of each with crouch
//    height of free space above is a walkable node; 3. link nodes to their 8 neighbours within step height;
// 4. erode one ring (keeps cell centres clear of the 0.30 m hull); flag nodes near low ceilings "crouch";
// 5. keep what is reachable from the spawns; 6. merge nodes into rectangles; shared edges are portals.
// Queries: A* over the rectangles, then the funnel algorithm for the shortest corner path.

import type { Collider } from "@cs/shared/level/level";
import { hprMatrix } from "@cs/shared/math";
import { MOVEMENT } from "@cs/shared/character";
import type { Random } from "@cs/shared/rng";
import type { MapCache } from "../sim/game";

export const VERSION = 3;
const DIRS: Array<[number, number]> = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]];
const E = 0, N = 1, W = 2, S = 3;

export interface NavConfig { cell: number; radius: number; standHeight: number; crouchHeight: number; step: number; maxSlopeDeg: number; maxRect: number }
export const NAV_CONFIG: NavConfig = { cell: 0.25, radius: MOVEMENT.radius, standHeight: MOVEMENT.stand_height,
  crouchHeight: MOVEMENT.crouch_height, step: MOVEMENT.step_height, maxSlopeDeg: MOVEMENT.max_slope_deg, maxRect: 16 };

export type Pt2 = [number, number];
export type Pt3 = [number, number, number];
export type Portal = [number, number, number, number, number, number];   // rect, other, ax, ay, bx, by

/** Solid intervals per column: [col, z0, z1, top normal z]. */
export function rasterize(colliders: Collider[], x0: number, y0: number, nx: number, ny: number, cs: number,
                          out: { col: number[]; z0: number[]; z1: number[]; nz: number[] } = { col: [], z0: [], z1: [], nz: [] }) {
  const shrink = 0.01;
  for (const { c, size, hpr } of colliders) {
    const h = [size[0] / 2, size[1] / 2, size[2] / 2];
    const R = hprMatrix(hpr[0], hpr[1], hpr[2]);
    const ext = [0, 1, 2].map((k) => Math.abs(R[0][k]) * h[0] + Math.abs(R[1][k]) * h[1] + Math.abs(R[2][k]) * h[2]);
    const i0 = Math.max(Math.floor((c[0] - ext[0] - x0) / cs), 0), i1 = Math.min(Math.floor((c[0] + ext[0] - x0) / cs), nx - 1);
    const j0 = Math.max(Math.floor((c[1] - ext[1] - y0) / cs), 0), j1 = Math.min(Math.floor((c[1] + ext[1] - y0) / cs), ny - 1);
    if (i1 < i0 || j1 < j0) continue;
    const upright = Math.abs(R[2][2]) > 0.9999;
    const half = cs * 0.5 - shrink;
    for (let jj = j0; jj <= j1; jj++) {
      for (let ii = i0; ii <= i1; ii++) {
        const qx = x0 + (ii + 0.5) * cs - c[0];
        const qy = y0 + (jj + 0.5) * cs - c[1];
        if (upright) {
          let keep = true;
          for (const a of [0, 1]) {
            const u = R[a];
            const reach = h[a] + half * (Math.abs(u[0]) + Math.abs(u[1]));
            if (Math.abs(qx * u[0] + qy * u[1]) > reach) { keep = false; break; }
          }
          if (!keep || Math.abs(qx) > ext[0] + half || Math.abs(qy) > ext[1] + half) continue;
          out.col.push(jj * nx + ii);
          out.z0.push(c[2] - h[2]);
          out.z1.push(c[2] + h[2]);
          out.nz.push(1);
        } else {
          let lo = -Infinity, hi = Infinity, nz = 1;
          let keep = true;
          for (let a = 0; a < 3; a++) {
            const ax = R[a];
            const av = qx * ax[0] + qy * ax[1] - c[2] * ax[2];
            const b = ax[2];
            if (Math.abs(b) < 1e-9) {
              if (Math.abs(av) > h[a]) { keep = false; break; }
              continue;
            }
            const t1 = (-h[a] - av) / b, t2 = (h[a] - av) / b;
            lo = Math.max(lo, Math.min(t1, t2));
            const top = Math.max(t1, t2);
            if (top < hi) { hi = top; nz = Math.abs(b); }
          }
          if (!keep || !(lo < hi)) continue;
          out.col.push(jj * nx + ii);
          out.z0.push(lo);
          out.z1.push(hi);
          out.nz.push(nz);
        }
      }
    }
  }
  return out;
}

export class NavMesh {
  cfg: NavConfig = NAV_CONFIG;
  x0 = 0;
  y0 = 0;
  nx = 0;
  ny = 0;
  nodeCol = new Int32Array(0);
  nodeZ = new Float64Array(0);
  crouch = new Uint8Array(0);
  links = new Int32Array(0);          // 8 per node
  rectOf = new Int32Array(0);
  rects: number[][] = [];              // [i0, j0, w, h, crouch]
  rectZ: number[][] = [];
  portals: Portal[] = [];
  colFirst = new Int32Array(0);
  colCount = new Uint8Array(0);
  adj: number[][] = [];
  portalList: Portal[] = [];
  rectCenter: Pt2[] = [];
  rectCrouch: boolean[] = [];
  rectArea: number[] = [];
  private basePortals = 0;
  dyn = new Map<unknown, number[]>();
  buildInfo = "";

  // ---------------------------------------------------------------- build
  static build(colliders: Collider[], bounds: number[][], seeds: number[][], cfg: NavConfig = NAV_CONFIG, log?: (m: string) => void): NavMesh {
    const t0 = Date.now();
    const self = new NavMesh();
    self.cfg = cfg;
    const cs = cfg.cell;
    const [[bx0, by0], [bx1, by1]] = bounds;
    self.x0 = bx0 - 1;
    self.y0 = by0 - 1;
    self.nx = Math.ceil((bx1 - bx0 + 2) / cs);
    self.ny = Math.ceil((by1 - by0 + 2) / cs);
    const ncols = self.nx * self.ny;
    const r = rasterize(colliders, self.x0, self.y0, self.nx, self.ny, cs);
    // merge the intervals per column
    const order = r.col.map((_, i) => i).sort((a, b) => r.col[a] - r.col[b] || r.z0[a] - r.z0[b]);
    const gcol: number[] = [], gz0: number[] = [], gz1: number[] = [], gnz: number[] = [];
    let k = 0;
    while (k < order.length) {
      const col = r.col[order[k]];
      let m = k;
      while (m < order.length && r.col[order[m]] === col) m++;
      // intervals [k, m) of one column, sorted by bottom
      let start = k;
      while (start < m) {
        let run = r.z1[order[start]];
        let end = start + 1;
        while (end < m && !(r.z0[order[end]] > run + 1e-4)) { run = Math.max(run, r.z1[order[end]]); end++; }
        let top = -Infinity;
        for (let q = start; q < end; q++) top = Math.max(top, r.z1[order[q]]);
        let nz = 0;
        for (let q = start; q < end; q++) if (r.z1[order[q]] >= top - 1e-6) nz = Math.max(nz, r.nz[order[q]]);
        gcol.push(col); gz0.push(r.z0[order[start]]); gz1.push(top); gnz.push(nz);
        start = end;
      }
      k = m;
    }
    const minNz = Math.cos(cfg.maxSlopeDeg * Math.PI / 180);
    let nodeCol: number[] = [], nodeZ: number[] = [], clear: number[] = [];
    for (let i = 0; i < gcol.length; i++) {
      const gap = i + 1 < gcol.length && gcol[i + 1] === gcol[i] ? gz0[i + 1] - gz1[i] : Infinity;
      if (gap >= cfg.crouchHeight && gnz[i] >= minNz - 1e-6) { nodeCol.push(gcol[i]); nodeZ.push(gz1[i]); clear.push(gap); }
    }
    const nRaw = nodeCol.length;
    let links = self.link(nodeCol, nodeZ, ncols);
    // erosion: one ring around anything not walkable at the same level
    let keep = nodeCol.map((_, n) => { for (let d = 0; d < 8; d++) if (links[n * 8 + d] < 0) return false; return true; });
    ({ nodeCol, nodeZ, extra: clear, links } = subset(keep, nodeCol, nodeZ, clear, links));
    const nEroded = nodeCol.length;
    let crouch: number[] = clear.map((c) => (c < cfg.standHeight + 0.02 ? 1 : 0));
    const dil = crouch.slice();
    for (let n = 0; n < nodeCol.length; n++) for (let d = 0; d < 8; d++) {
      const nb = links[n * 8 + d];
      if (nb >= 0 && crouch[nb]) dil[n] = 1;
    }
    crouch = dil;
    // reachability from the spawns
    self.setNodes(nodeCol, nodeZ, crouch, links, ncols);
    const reach = new Uint8Array(nodeCol.length);
    const q: number[] = [];
    for (const s of seeds) {
      const n = self.locate(s);
      if (n >= 0 && !reach[n]) { reach[n] = 1; q.push(n); }
    }
    for (let qi = 0; qi < q.length; qi++) {
      const n = q[qi];
      for (let d = 0; d < 4; d++) {
        const m = links[n * 8 + d];
        if (m >= 0 && !reach[m]) { reach[m] = 1; q.push(m); }
      }
    }
    if (q.length) {
      const sub = subset(Array.from(reach, (v) => v === 1), nodeCol, nodeZ, crouch, links);
      nodeCol = sub.nodeCol; nodeZ = sub.nodeZ; crouch = sub.extra; links = sub.links;
    }
    self.setNodes(nodeCol, nodeZ, crouch, links, ncols);
    self.buildRects();
    self.buildPortals();
    self.buildInfo = `${nRaw} raw nodes, ${nEroded} after erosion, ${nodeCol.length} reachable, ${self.rects.length} polygons, ` +
      `${self.portals.length} portals in ${((Date.now() - t0) / 1000).toFixed(2)}s`;
    log?.(`[nav] ${self.buildInfo}`);
    return self;
  }

  private setNodes(nodeCol: number[], nodeZ: number[], crouch: number[], links: number[], ncols: number): void {
    this.nodeCol = Int32Array.from(nodeCol);
    this.nodeZ = Float64Array.from(nodeZ);
    this.crouch = Uint8Array.from(crouch);
    this.links = Int32Array.from(links);
    this.indexColumns(ncols);
  }

  private link(nodeCol: number[], nodeZ: number[], ncols: number): number[] {
    const { nx, ny } = this;
    const first = new Int32Array(ncols).fill(-1);
    const count = new Int32Array(ncols);
    for (let n = 0; n < nodeCol.length; n++) {
      if (first[nodeCol[n]] < 0) first[nodeCol[n]] = n;
      count[nodeCol[n]]++;
    }
    const links: number[] = new Array(nodeCol.length * 8).fill(-1);
    const step = this.cfg.step;
    for (let n = 0; n < nodeCol.length; n++) {
      const ci = nodeCol[n] % nx, cj = Math.floor(nodeCol[n] / nx);
      DIRS.forEach(([dx, dy], d) => {
        const ni = ci + dx, nj = cj + dy;
        if (ni < 0 || ni >= nx || nj < 0 || nj >= ny) return;
        const col = nj * nx + ni;
        const f = first[col];
        if (f < 0) return;
        let best = -1, bestDz = Infinity;
        for (let m = f; m < f + count[col]; m++) {
          const dz = Math.abs(nodeZ[m] - nodeZ[n]);
          if (dz <= step && dz < bestDz) { best = m; bestDz = dz; }
        }
        links[n * 8 + d] = best;
      });
    }
    return links;
  }

  private indexColumns(ncols: number): void {
    this.colFirst = new Int32Array(ncols).fill(-1);
    this.colCount = new Uint8Array(ncols);
    for (let n = 0; n < this.nodeCol.length; n++) {
      const c = this.nodeCol[n];
      if (this.colFirst[c] < 0) this.colFirst[c] = n;
      this.colCount[c]++;
    }
  }

  private buildRects(): void {
    const n = this.nodeCol.length;
    const L = this.links;
    const crouch = this.crouch;
    const rectOf = new Int32Array(n).fill(-1);
    const rects: number[][] = [];
    const M = this.cfg.maxRect;
    const nx = this.nx;
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => {
      const ja = Math.floor(this.nodeCol[a] / nx), jb = Math.floor(this.nodeCol[b] / nx);
      if (ja !== jb) return ja - jb;
      const ia = this.nodeCol[a] % nx, ib = this.nodeCol[b] % nx;
      if (ia !== ib) return ia - ib;
      return this.nodeZ[a] - this.nodeZ[b];
    });
    const free = (m: number, c: number) => m >= 0 && rectOf[m] < 0 && crouch[m] === c;
    const grow = (start: number, c: number, fwd: number, side: number): number[][] => {
      const run = [start];
      while (run.length < M && free(L[run[run.length - 1] * 8 + fwd], c)) run.push(L[run[run.length - 1] * 8 + fwd]);
      const runs = [run];
      while (runs.length < M) {
        let cand: number[] | null = [];
        const last = runs[runs.length - 1];
        for (let k = 0; k < last.length; k++) {
          const u = L[last[k] * 8 + side];
          if (!free(u, c) || (k > 0 && L[cand[cand.length - 1] * 8 + fwd] !== u)) { cand = null; break; }
          cand.push(u);
        }
        if (cand === null) break;
        runs.push(cand);
      }
      return runs;
    };
    for (const start of order) {
      if (rectOf[start] >= 0) continue;
      const c = crouch[start];
      const a = grow(start, c, E, N);
      const b = grow(start, c, N, E);
      const na = a.length * a[0].length, nb = b.length * b[0].length;
      let rows: number[][];
      if (nb > na) {
        rows = [];
        for (let r = 0; r < b[0].length; r++) rows.push(b.map((col) => col[r]));
      } else rows = a;
      const rid = rects.length;
      for (const row of rows) for (const m of row) rectOf[m] = rid;
      rects.push([this.nodeCol[start] % nx, Math.floor(this.nodeCol[start] / nx), rows[0].length, rows.length, c]);
    }
    this.rectOf = rectOf;
    this.rects = rects;
    this.rectZ = rects.map(() => [Infinity, -Infinity]);
    for (let m = 0; m < n; m++) {
      const rz = this.rectZ[rectOf[m]];
      rz[0] = Math.min(rz[0], this.nodeZ[m]);
      rz[1] = Math.max(rz[1], this.nodeZ[m]);
    }
  }

  private buildPortals(): void {
    const cs = this.cfg.cell, x0 = this.x0, y0 = this.y0, nx = this.nx;
    const out: Portal[] = [];
    for (const d of [E, N, W, S]) {
      const rows: Array<[number, number, number, number]> = [];       // ra, rb, line, along
      for (let src = 0; src < this.nodeCol.length; src++) {
        const dst = this.links[src * 8 + d];
        if (dst < 0) continue;
        const ra = this.rectOf[src], rb = this.rectOf[dst];
        if (ra === rb) continue;
        const ci = this.nodeCol[src] % nx, cj = Math.floor(this.nodeCol[src] / nx);
        if (d === E || d === W) rows.push([ra, rb, ci + (d === E ? 1 : 0), cj]);
        else rows.push([ra, rb, cj + (d === N ? 1 : 0), ci]);
      }
      rows.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2] || p[3] - q[3]);
      let s = 0;
      while (s < rows.length) {
        let e = s;
        while (e + 1 < rows.length && rows[e + 1][0] === rows[s][0] && rows[e + 1][1] === rows[s][1] && rows[e + 1][2] === rows[s][2] &&
               rows[e + 1][3] === rows[e][3] + 1) e++;
        const a0 = (rows[s][3] + 0.5) * cs, a1 = (rows[e][3] + 0.5) * cs, ln = rows[s][2] * cs;
        if (d === E || d === W) out.push([rows[s][0], rows[s][1], x0 + ln, y0 + a0, x0 + ln, y0 + a1]);
        else out.push([rows[s][0], rows[s][1], x0 + a0, y0 + ln, x0 + a1, y0 + ln]);
        s = e + 1;
      }
    }
    this.portals = out;
    this.makeAdjacency();
  }

  private makeAdjacency(): void {
    this.adj = this.rects.map(() => []);
    this.portalList = this.portals.map((p) => [...p] as Portal);
    this.portalList.forEach((p, k) => this.adj[p[0]].push(k));
    const cs = this.cfg.cell;
    this.rectCenter = this.rects.map(([a, b, w, h]) => [this.x0 + (a + w * 0.5) * cs, this.y0 + (b + h * 0.5) * cs]);
    this.rectCrouch = this.rects.map((r) => r[4] === 1);
    this.rectArea = this.rects.map((r) => r[2] * r[3]);
    this.basePortals = this.portalList.length;
    this.dyn = new Map();
  }

  // ------------------------------------------------- dynamic links (destruction)
  /** Off-mesh connection between two rects through the segment a-b: a hole blown through a wall
   * (two-way) or an open hatch (a one-way drop). A* and the funnel treat it like a portal. */
  addLink(tag: unknown, ra: number, rb: number, a: Pt2, b: Pt2, twoWay = true): void {
    let ks = this.dyn.get(tag);
    if (!ks) this.dyn.set(tag, (ks = []));
    const pairs: Array<[number, number]> = twoWay ? [[ra, rb], [rb, ra]] : [[ra, rb]];
    for (const [r0, r1] of pairs) {
      const k = this.portalList.length;
      this.portalList.push([r0, r1, a[0], a[1], b[0], b[1]]);
      this.adj[r0].push(k);
      ks.push(k);
    }
  }

  removeLinks(tag: unknown): void {
    for (const k of this.dyn.get(tag) ?? []) {
      const r0 = this.portalList[k][0];
      const i = this.adj[r0].indexOf(k);
      if (i >= 0) this.adj[r0].splice(i, 1);
    }
    this.dyn.delete(tag);
  }

  clearLinks(): void {
    if (this.portalList.length !== this.basePortals || this.dyn.size) this.makeAdjacency();
  }

  rectAt(pos: ArrayLike<number>, search = 3, maxDz = 0.6): number {
    const n = this.locate(pos, search);
    if (n < 0 || Math.abs(this.nodeZ[n] - pos[2]) > maxDz) return -1;
    return this.rectOf[n];
  }

  rectBelow(x: number, y: number, z: number, search = 2): number {
    const cs = this.cfg.cell;
    const i0 = Math.floor((x - this.x0) / cs), j0 = Math.floor((y - this.y0) / cs);
    for (let r = 0; r <= search; r++) {
      let best = -1, bestZ = -1e9;
      for (let i = i0 - r; i <= i0 + r; i++) for (let j = j0 - r; j <= j0 + r; j++) {
        if (i < 0 || i >= this.nx || j < 0 || j >= this.ny) continue;
        const col = j * this.nx + i;
        const first = this.colFirst[col];
        if (first < 0) continue;
        for (let n = first; n < first + this.colCount[col]; n++) if (bestZ < this.nodeZ[n] && this.nodeZ[n] < z) { best = n; bestZ = this.nodeZ[n]; }
      }
      if (best >= 0) return this.rectOf[best];
    }
    return -1;
  }

  // --------------------------------------------------------------- cache
  serialize(): Record<string, unknown> {
    return { version: VERSION, cfg: this.cfg, x0: this.x0, y0: this.y0, nx: this.nx, ny: this.ny, info: this.buildInfo,
      nodeCol: b64(this.nodeCol), nodeZ: b64(this.nodeZ), crouch: b64(this.crouch), links: b64(this.links), rectOf: b64(this.rectOf),
      rects: this.rects, rectZ: this.rectZ, portals: this.portals };
  }

  static deserialize(d: Record<string, unknown>): NavMesh | null {
    if (!d || d.version !== VERSION) return null;
    const self = new NavMesh();
    self.cfg = d.cfg as NavConfig;
    self.x0 = d.x0 as number; self.y0 = d.y0 as number; self.nx = d.nx as number; self.ny = d.ny as number;
    self.buildInfo = `${d.info} (cached)`;
    self.nodeCol = new Int32Array(unb64(d.nodeCol as string));
    self.nodeZ = new Float64Array(unb64(d.nodeZ as string));
    self.crouch = new Uint8Array(unb64(d.crouch as string));
    self.links = new Int32Array(unb64(d.links as string));
    self.rectOf = new Int32Array(unb64(d.rectOf as string));
    self.rects = d.rects as number[][];
    self.rectZ = d.rectZ as number[][];
    self.portals = d.portals as Portal[];
    self.indexColumns(self.nx * self.ny);
    self.makeAdjacency();
    return self;
  }

  static cached(colliders: Collider[], bounds: number[][], seeds: number[][], cache: MapCache | null, name: string,
                log?: (m: string) => void): NavMesh {
    const key = `nav_${name}_${hashKey([VERSION, NAV_CONFIG, bounds, seeds, colliders.map((c) => [...c.c, ...c.size, ...c.hpr])])}`;
    const hit = cache?.load(key);
    if (hit) {
      const nav = NavMesh.deserialize(hit as Record<string, unknown>);
      if (nav) { log?.(`[nav] ${name}: ${nav.buildInfo}`); return nav; }
    }
    const nav = NavMesh.build(colliders, bounds, seeds, NAV_CONFIG, log);
    cache?.save(key, nav.serialize());
    return nav;
  }

  // ------------------------------------------------------------- queries
  get nodeCount(): number { return this.nodeCol.length; }

  nodePos(n: number): Pt3 {
    const c = this.nodeCol[n];
    const cs = this.cfg.cell;
    return [this.x0 + (c % this.nx + 0.5) * cs, this.y0 + (Math.floor(c / this.nx) + 0.5) * cs, this.nodeZ[n]];
  }

  columnNode(i: number, j: number, z: number, tolUp = 0.7, tolDown = 3.0): number {
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return -1;
    const col = j * this.nx + i;
    const first = this.colFirst[col];
    if (first < 0) return -1;
    let best = -1, bestD = 1e9;
    for (let n = first; n < first + this.colCount[col]; n++) {
      const dz = this.nodeZ[n] - z;
      if (dz >= -tolDown && dz <= tolUp) {
        const d = dz <= 0 ? Math.abs(dz) : dz * 3;
        if (d < bestD) { best = n; bestD = d; }
      }
    }
    return best;
  }

  /** Node under pos (feet); searches nearby cells if just off the mesh. -1 if nothing is close. */
  locate(pos: ArrayLike<number>, search = 6): number {
    const cs = this.cfg.cell;
    const x = pos[0], y = pos[1], z = pos.length > 2 ? pos[2] : 0;
    const i = Math.floor((x - this.x0) / cs), j = Math.floor((y - this.y0) / cs);
    const n = this.columnNode(i, j, z);
    if (n >= 0) return n;
    let best = -1, bestD = 1e9;
    for (let r = 1; r <= search; r++) {
      for (let di = -r; di <= r; di++) {
        const djs = Math.abs(di) !== r ? [-r, r] : Array.from({ length: 2 * r + 1 }, (_, k) => k - r);
        for (const dj of djs) {
          const m = this.columnNode(i + di, j + dj, z, 1.2, 1.5);
          if (m >= 0) {
            const d = di * di + dj * dj;
            if (d < bestD) { best = m; bestD = d; }
          }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  snap(pos: ArrayLike<number>, search = 6): Pt3 | null {
    const n = this.locate(pos, search);
    return n < 0 ? null : this.nodePos(n);
  }

  heightAt(x: number, y: number, zHint: number): number | null {
    const n = this.locate([x, y, zHint], 1);
    return n < 0 ? null : this.nodeZ[n];
  }

  isCrouch(pos: ArrayLike<number>): boolean {
    const n = this.locate(pos, 1);
    return n >= 0 && this.crouch[n] === 1;
  }

  /** A straight walk from a to b stays on the mesh (no wall, no drop). */
  walkableLine(a: ArrayLike<number>, b: ArrayLike<number>, maxStep?: number): boolean {
    const cs = this.cfg.cell;
    const ax = a[0], ay = a[1], az = a[2];
    const dx = b[0] - ax, dy = b[1] - ay;
    const dist = Math.hypot(dx, dy);
    const n = this.locate([ax, ay, az], 1);
    if (n < 0) return false;
    let z = this.nodeZ[n];
    const steps = Math.max(Math.trunc(dist / (cs * 0.5)), 1);
    const step = maxStep === undefined ? this.cfg.step : maxStep;
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const i = Math.floor((ax + dx * t - this.x0) / cs), j = Math.floor((ay + dy * t - this.y0) / cs);
      const m = this.columnNode(i, j, z, step + 0.01, step + 0.01);
      if (m < 0) return false;
      z = this.nodeZ[m];
    }
    return b.length < 3 || Math.abs(z - b[2]) <= step + 0.3;
  }

  /** A random walkable point: anywhere (area weighted) or within radius of near. */
  randomPoint(rng: Random, near: ArrayLike<number> | null = null, radius = 0): Pt3 | null {
    if (near && radius > 0) {
      for (let k = 0; k < 24; k++) {
        const a = rng.uniform(0, 2 * Math.PI);
        const r = radius * Math.sqrt(rng.random());
        const n = this.locate([near[0] + Math.cos(a) * r, near[1] + Math.sin(a) * r, near[2]], 2);
        if (n >= 0 && Math.abs(this.nodeZ[n] - near[2]) < 2.5) return this.nodePos(n);
      }
      return null;
    }
    if (!this.rects.length) return null;
    const total = this.rectArea.reduce((s, v) => s + v, 0);
    const x = rng.random() * total;
    let acc = 0, k = 0;
    for (; k < this.rectArea.length; k++) { acc += this.rectArea[k]; if (acc >= x) break; }
    k = Math.min(k, this.rects.length - 1);
    const [i0, j0, w, h] = this.rects[k];
    const i = i0 + rng.randrange(w), j = j0 + rng.randrange(h);
    const n = this.columnNode(i, j, this.rectZ[k][1], 0.1, 50);
    return n < 0 ? null : this.nodePos(n);
  }

  // ---------------------------------------------------------------- paths
  /** Shortest path start -> goal as corners (start and goal included), or null. */
  findPath(start: ArrayLike<number>, goal: ArrayLike<number>, costBias: ((r: number) => number) | null = null,
           maxExpand = 20000): Pt3[] | null {
    const sn = this.locate(start), gn = this.locate(goal);
    if (sn < 0 || gn < 0) return null;
    const sr = this.rectOf[sn], gr = this.rectOf[gn];
    const sxy: Pt2 = [start[0], start[1]], gxy: Pt2 = [goal[0], goal[1]];
    let pts2: Pt2[];
    let chain: number[] = [];
    if (sr === gr) pts2 = [sxy, gxy];
    else {
      let best: Pt2[] | null = null;
      for (const mode of ["closest", "mid"] as const) {
        const ch = this.astar(sr, gr, sxy, gxy, costBias, maxExpand, mode);
        if (!ch) return null;
        const cand = stringPull(sxy, gxy, this.orientedPortals(ch));
        if (!best || length2(cand) < length2(best) - 1e-6) { best = cand; chain = ch; }
      }
      pts2 = best as Pt2[];
    }
    return this.withHeights(sn, gn, sxy, gxy, pts2, chain);
  }

  /** Corners with floor heights: every corner is a portal end point; take the floor of the rects it joins. */
  withHeights(sn: number, gn: number, sxy: Pt2, gxy: Pt2, pts2: Pt2[], chain: number[]): Pt3[] {
    const out: Pt3[] = [[sxy[0], sxy[1], this.nodeZ[sn]]];
    let j = 0;
    let z = this.nodeZ[sn];
    for (const [x, y] of pts2.slice(1, -1)) {
      let rects: [number, number] | null = null;
      while (j < chain.length) {
        const p = this.portalList[chain[j]];
        j++;
        if ((p[2] === x && p[3] === y) || (p[4] === x && p[5] === y)) { rects = [p[0], p[1]]; break; }
      }
      let zz = rects ? this.zInRects(x, y, rects) : null;
      if (zz === null) {
        const m = this.locate([x, y, z + 0.3], 2);
        zz = m >= 0 ? this.nodeZ[m] : z;
      }
      z = zz;
      out.push([x, y, z]);
    }
    out.push([gxy[0], gxy[1], this.nodeZ[gn]]);
    return out;
  }

  zInRects(x: number, y: number, rects: [number, number]): number | null {
    const cs = this.cfg.cell;
    for (const [ox, oy] of [[0.01, 0.01], [-0.01, 0.01], [0.01, -0.01], [-0.01, -0.01]]) {
      const i = Math.floor((x + ox - this.x0) / cs), j = Math.floor((y + oy - this.y0) / cs);
      if (i < 0 || i >= this.nx || j < 0 || j >= this.ny) continue;
      const col = j * this.nx + i;
      const first = this.colFirst[col];
      if (first < 0) continue;
      for (let n = first; n < first + this.colCount[col]; n++) if (rects.includes(this.rectOf[n])) return this.nodeZ[n];
    }
    return null;
  }

  orientedPortals(chain: number[]): Array<[Pt2, Pt2]> {
    return chain.map((k) => {
      const p = this.portalList[k];
      const a: Pt2 = [p[2], p[3]], b: Pt2 = [p[4], p[5]];
      const ca = this.rectCenter[p[0]], cb = this.rectCenter[p[1]];
      const dx = cb[0] - ca[0], dy = cb[1] - ca[1];
      return dx * (a[1] - b[1]) - dy * (a[0] - b[0]) > 0 ? [a, b] : [b, a];
    });
  }

  private astar(sr: number, gr: number, sxy: Pt2, gxy: Pt2, costBias: ((r: number) => number) | null, maxExpand: number,
                mode: "closest" | "mid"): number[] | null {
    const job = new AStarSearch(this, sr, gr, sxy, gxy, costBias, mode === "mid");
    const r = job.run(maxExpand);
    return r;
  }

  pathLength(path: Pt3[] | null): number {
    if (!path) return 0;
    let s = 0;
    for (let i = 0; i < path.length - 1; i++) s += Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
    return s;
  }
}

/** One A* over the rectangles (portal points scored at the closest point to the entry, or the midpoint),
 * resumable in budgeted steps. */
export class AStarSearch {
  nav: NavMesh;
  sr: number; gr: number; sxy: Pt2; gxy: Pt2;
  bias: ((r: number) => number) | null;
  mid: boolean;
  best = new Map<number, number>();
  at = new Map<number, Pt2>();
  came = new Map<number, [number, number]>();
  heap: Heap;
  tie = 1;
  expanded = 0;
  finished = false;
  found = false;

  constructor(nav: NavMesh, sr: number, gr: number, sxy: Pt2, gxy: Pt2, bias: ((r: number) => number) | null, mid: boolean) {
    this.nav = nav; this.sr = sr; this.gr = gr; this.sxy = sxy; this.gxy = gxy; this.bias = bias; this.mid = mid;
    this.best.set(sr, 0);
    this.at.set(sr, sxy);
    this.heap = new Heap();
    this.heap.push([Math.hypot(sxy[0] - gxy[0], sxy[1] - gxy[1]), 0, sr]);
  }

  /** Expand up to budget rects; returns how many were used. */
  step(budget: number): number {
    const nav = this.nav;
    const P = nav.portalList, crouch = nav.rectCrouch, adj = nav.adj, gxy = this.gxy;
    let used = 0;
    while (this.heap.size && used < budget) {
      const [f, , r] = this.heap.pop();
      if (r === this.gr) { this.finished = true; this.found = true; return used; }
      const g = this.best.get(r) as number;
      const atr = this.at.get(r) as Pt2;
      if (f - Math.hypot(atr[0] - gxy[0], atr[1] - gxy[1]) > g + 1e-6) continue;
      used++;
      this.expanded++;
      const [px, py] = atr;
      for (const k of adj[r]) {
        const p = P[k];
        const s = p[1];
        const ax = p[2], ay = p[3], ex = p[4] - ax, ey = p[5] - ay;
        let t: number;
        if (this.mid) t = 0.5;
        else {
          const L2 = ex * ex + ey * ey;
          t = L2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / L2));
        }
        const qx = ax + ex * t, qy = ay + ey * t;
        const cost = Math.hypot(qx - px, qy - py) + 0.05;
        let mult = crouch[s] ? 2.6 : 1;
        if (this.bias) mult *= this.bias(s);
        const ng = g + cost * mult;
        if (ng < (this.best.get(s) ?? 1e18)) {
          this.best.set(s, ng);
          this.at.set(s, [qx, qy]);
          this.came.set(s, [r, k]);
          this.heap.push([ng + Math.hypot(gxy[0] - qx, gxy[1] - qy), this.tie++, s]);
        }
      }
    }
    if (!this.heap.size) { this.finished = true; this.found = this.came.has(this.gr); }
    return used;
  }

  chain(): number[] | null {
    if (!this.came.has(this.gr)) return null;
    const out: number[] = [];
    let r = this.gr;
    while (r !== this.sr) {
      const [pr, k] = this.came.get(r) as [number, number];
      out.push(k);
      r = pr;
    }
    return out.reverse();
  }

  run(maxExpand: number): number[] | null {
    while (!this.finished) {
      if (this.expanded > maxExpand) return null;
      this.step(Math.max(1, maxExpand + 1 - this.expanded));
    }
    return this.found ? this.chain() : null;
  }
}

/** A binary min-heap of [f, tie, rect] (heapq order: by f, then tie). */
export class Heap {
  private a: Array<[number, number, number]> = [];
  get size(): number { return this.a.length; }
  private less(i: number, j: number): boolean {
    const x = this.a[i], y = this.a[j];
    return x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]);
  }
  push(v: [number, number, number]): void {
    const a = this.a;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop(): [number, number, number] {
    const a = this.a;
    const top = a[0];
    const last = a.pop() as [number, number, number];
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && this.less(l, m)) m = l;
        if (r < a.length && this.less(r, m)) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

function length2(pts: Pt2[]): number {
  let s = 0;
  for (let i = 0; i < pts.length - 1; i++) s += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  return s;
}

function subset(keep: boolean[], nodeCol: number[], nodeZ: number[], extra: number[], links: number[]) {
  const idx: number[] = [];
  let k = 0;
  for (const kk of keep) { idx.push(kk ? k : -1); if (kk) k++; }
  const nc: number[] = [], nz: number[] = [], ex: number[] = [], nl: number[] = [];
  keep.forEach((kk, n) => {
    if (!kk) return;
    nc.push(nodeCol[n]); nz.push(nodeZ[n]); ex.push(extra[n]);
    for (let d = 0; d < 8; d++) {
      const l = links[n * 8 + d];
      nl.push(l >= 0 && keep[l] ? idx[l] : -1);
    }
  });
  return { nodeCol: nc, nodeZ: nz, extra: ex, links: nl };
}

// ------------------------------------------------------------- string pulling
function tri2(a: Pt2, b: Pt2, c: Pt2): number {
  const ax = b[0] - a[0], ay = b[1] - a[1], bx = c[0] - a[0], by = c[1] - a[1];
  return bx * ay - ax * by;
}
const same = (a: Pt2, b: Pt2) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 < 1e-10;

/** The simple stupid funnel algorithm: the shortest path through portals given as (left, right). */
export function stringPull(start: Pt2, goal: Pt2, portals: Array<[Pt2, Pt2]>): Pt2[] {
  const ports: Array<[Pt2, Pt2]> = [[start, start], ...portals, [goal, goal]];
  const pts: Pt2[] = [start];
  let apex = start, left = start, right = start;
  let ai = 0, li = 0, ri = 0;
  let i = 1;
  const n = ports.length;
  let guard = 0;
  while (i < n && guard < 10000) {
    guard++;
    const [pl, pr] = ports[i];
    if (tri2(apex, right, pr) <= 0) {
      if (same(apex, right) || tri2(apex, left, pr) > 0) { right = pr; ri = i; }
      else {
        if (!same(pts[pts.length - 1], left)) pts.push(left);
        apex = left; ai = li;
        left = right = apex;
        li = ri = ai;
        i = ai + 1;
        continue;
      }
    }
    if (tri2(apex, left, pl) >= 0) {
      if (same(apex, left) || tri2(apex, right, pl) < 0) { left = pl; li = i; }
      else {
        if (!same(pts[pts.length - 1], right)) pts.push(right);
        apex = right; ai = ri;
        left = right = apex;
        li = ri = ai;
        i = ai + 1;
        continue;
      }
    }
    i++;
  }
  if (!same(pts[pts.length - 1], goal)) pts.push(goal);
  return pts;
}

// ---------------------------------------------------------------- helpers
export function b64(a: ArrayBufferView): string {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");
}

export function unb64(s: string): ArrayBuffer {
  const b = Buffer.from(s, "base64");
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

export function hashKey(v: unknown): string {
  // FNV-1a over the JSON (stable for a map, its colliders and the config)
  const s = JSON.stringify(v);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
