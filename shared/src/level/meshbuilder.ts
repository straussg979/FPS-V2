// Procedural mesh construction: triangles with full tangent frames (normal, tangent, binormal), batched
// per material. Box faces use world-space planar UVs by default (u = P.T / scale, v = P.B / scale), so
// adjacent pieces line up and texel density is uniform across the map.
//
// While a level is built for the asset build, every shape (one addBox / addRoundedBox / ... call) and its planar
// faces can be recorded (FaceRecorder): shared/src/level/overlaps.ts uses them to cut buried faces and to separate
// coplanar ones (z-fighting), bake.ts to bake ambient occlusion. Recording never changes what is emitted.

import { type M3, type V3, hprMatrix } from "../math";
import type { Displace } from "./organic";

export const FLOATS_PER_VERTEX = 18;   // pos3 normal3 tangent3 binormal3 uv2 detail4
/** detail4, read by the client's surface shader (client/src/game/surface.ts):
 *  x: baked ambient occlusion (1 open .. 0 enclosed; finalizeGeometry bakes it),
 *  y: height above the piece's base in metres (dust gathers at the foot of walls; -1 = none),
 *  z: weathering: > 0 rain-streak strength (under spouts, sills, parapets), < 0 soot (above tandoors),
 *  w: cross-section of thin pieces in metres (wires, bars, grilles; 0 = not thin): they fade out with distance
 *     instead of flickering in and out between pixels. */
export const DETAIL_OFFSET = 14;

// (normal, tangent, binormal) with T = B x N: textures are never mirrored seen from outside
export const BOX_FACES: Array<[V3, V3, V3]> = [
  [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  [[-1, 0, 0], [0, -1, 0], [0, 0, 1]],
  [[0, 1, 0], [-1, 0, 0], [0, 0, 1]],
  [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
  [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
];
export const FACE_NAMES = ["+x", "-x", "+y", "-y", "+z", "-z"];

const rot = (p: V3, R: M3): V3 => [
  p[0] * R[0][0] + p[1] * R[1][0] + p[2] * R[2][0],
  p[0] * R[0][1] + p[1] * R[1][1] + p[2] * R[2][1],
  p[0] * R[0][2] + p[1] * R[1][2] + p[2] * R[2][2],
];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** One planar face as emitted (before any rounding or displacement), for the coplanar-overlap check and resolver:
 *  its shape, outward normal, plane offset (n . p), corner polygon, and its triangles (indices[i0, i1)). */
export interface FaceRecord { shape: number; n: V3; d: number; poly: V3[]; i0: number; i1: number; removed?: boolean }
/** One shape: the builder that holds it, its vertex range, its material and the prefab that made it; boxes also
 *  keep their solid volume (centre, half extents, rotation rows) for the hidden-face test and the AO bake. */
export interface ShapeRecord { builder: MeshBuilder; v0: number; v1: number; mat: string; label: string; boxes: Array<{ c: V3; h: V3; R: M3 }>;
  /** Shapes of one group move together when overlaps are resolved (an organic wall: one piece in several batches). */
  group: number;
  /** Level-of-detail variant ("hi" / "lo"; "" = both): faces only meet faces and volumes of their own variant. */
  variant: string }

/** Collects faces and shapes while a level is built (scripts/maps/overlaps.ts and the asset build turn it on). */
export class FaceRecorder {
  faces: FaceRecord[] = [];
  shapes: ShapeRecord[] = [];
  label = "";
}

/** Options of addRoundedBox. */
export interface RoundedBoxOpts {
  hpr?: V3;
  uvScale?: number;
  uvMode?: "world" | "fit";
  /** Radius of the rounded edges in metres (clamped to fit). */
  radius?: number;
  /** Which sides take part in the rounding (FACE_NAMES; default all). An edge is rounded when both its sides are;
   *  a side that is not listed stays flat (a wall's foot on the ground, a joint with the next piece). */
  round?: readonly string[];
  /** Arc segments per rounded edge (1-4). */
  segments?: number;
  /** Largest grid cell in metres (0: only the cuts the rounding needs). Displacement needs a grid to show. */
  step?: number;
  /** Extra cut positions per local axis, so pieces that meet share their edge vertices exactly (no T-junctions). */
  cuts?: [number[], number[], number[]];
  /** World-space displacement field (organic.ts); shared vertices move together, so no cracks open. */
  displace?: Displace | null;
  skipFaces?: readonly string[];
}

export class MeshBuilder {
  verts: number[] = [];
  indices: number[] = [];
  /** The material this builder is batched under (LevelContext sets it). */
  name = "";
  /** When set, every shape and planar face is recorded (see FaceRecorder). */
  static recorder: FaceRecorder | null = null;
  /** Group / variant tags for the shapes recorded from now on (LevelContext sets them for organic walls and LODs). */
  static group = -1;
  static variant = "";
  /** Height the dust gradient is measured from (LevelContext sets the current piece's base). */
  static baseZ: number | null = null;
  private shape = -1;
  /** Cross-section of the shape being emitted when it is a thin piece (set by addBox / addCylinder). */
  private thin = 0;

  get vertexCount(): number { return this.verts.length / FLOATS_PER_VERTEX; }

  /** Start a recorded shape; returns a token for endShape (-1 when not recording, -2 when nested). */
  beginShape(): number {
    const r = MeshBuilder.recorder;
    if (r && this.shape >= 0) return -2;               // nested inside a shape already being recorded
    if (!r) return (this.shape = -1);
    r.shapes.push({ builder: this, v0: this.vertexCount, v1: this.vertexCount, mat: this.name, label: r.label, boxes: [],
      group: MeshBuilder.group >= 0 ? MeshBuilder.group : r.shapes.length, variant: MeshBuilder.variant });
    return (this.shape = r.shapes.length - 1);
  }

  endShape(token = 0): void {
    if (token === -2) return;
    const r = MeshBuilder.recorder;
    if (r && this.shape >= 0) r.shapes[this.shape].v1 = this.vertexCount;
    this.shape = -1;
  }

  /** Record a planar face of the current shape: its triangles are indices[i0, current end). */
  recordFace(n: ArrayLike<number>, poly: V3[], i0: number): void {
    const r = MeshBuilder.recorder;
    if (!r || this.shape < 0) return;
    const nn: V3 = [n[0], n[1], n[2]];
    r.faces.push({ shape: this.shape, n: nn, d: dot(nn, poly[0]), poly, i0, i1: this.indices.length });
  }

  /** Record the solid volume of the current shape (a box). */
  recordBox(c: V3, h: V3, R: M3): void {
    const r = MeshBuilder.recorder;
    if (r && this.shape >= 0) r.shapes[this.shape].boxes.push({ c: [c[0], c[1], c[2]], h: [h[0], h[1], h[2]], R });
  }

  /** Drop degenerate triangles (removed faces) and the vertices nothing uses any more. */
  compact(): void {
    const idx = this.indices;
    const keep: number[] = [];
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i], b = idx[i + 1], c = idx[i + 2];
      if (a === b || b === c || a === c) continue;
      keep.push(a, b, c);
    }
    const map = new Int32Array(this.vertexCount).fill(-1);
    const verts: number[] = [];
    let n = 0;
    for (let i = 0; i < keep.length; i++) {
      const v = keep[i];
      if (map[v] < 0) {
        map[v] = n++;
        const o = v * FLOATS_PER_VERTEX;
        for (let k = 0; k < FLOATS_PER_VERTEX; k++) verts.push(this.verts[o + k]);
      }
      keep[i] = map[v];
    }
    this.verts = verts;
    this.indices = keep;
  }

  /** One vertex: position, normal, tangent, binormal, uv (and the default detail: open, height above the base,
   *  no weathering, thin size). */
  vertex(p: ArrayLike<number>, n: ArrayLike<number>, t: ArrayLike<number>, b: ArrayLike<number>, u: number, v: number): void {
    const bz = MeshBuilder.baseZ;
    this.verts.push(p[0], p[1], p[2], n[0], n[1], n[2], t[0], t[1], t[2], b[0], b[1], b[2], u, v,
      1, bz === null ? -1 : Math.max(0, p[2] - bz), 0, this.thin);
  }

  /** Append raw vertices (FLOATS_PER_VERTEX floats each) and local triangle indices. */
  add(verts: ArrayLike<number>, idx: ArrayLike<number>): void {
    const base = this.vertexCount;
    for (let i = 0; i < verts.length; i++) this.verts.push(verts[i]);
    for (let i = 0; i < idx.length; i++) this.indices.push(idx[i] + base);
  }

  addQuad(corners: V3[], n: V3, t: V3, b: V3, uvs: Array<[number, number]>): void {
    const base = this.vertexCount;
    for (let i = 0; i < 4; i++) this.vertex(corners[i], n, t, b, uvs[i][0], uvs[i][1]);
    this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** Box of ``size`` (full extents) at ``center``. uv "world": world-planar UVs; "fit": each face maps to
   * [0, repeats] with repeats = face size / uvScale rounded to >= 1. */
  addBox(center: V3, size: V3, hpr: V3 = [0, 0, 0], uvScale = 1, skipFaces: readonly string[] = [],
         uvMode = "world", uvOffset: [number, number] = [0, 0]): void {
    const half: V3 = [size[0] / 2, size[1] / 2, size[2] / 2];
    const R = hprMatrix(hpr[0], hpr[1], hpr[2]);
    const signs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const tok = this.beginShape();
    this.recordBox(center, half, R);
    const sorted = [size[0], size[1], size[2]].sort((a, b) => a - b);
    // a thin piece: two small dimensions (a bar, a wire, a rail) - not a thin panel like a door leaf or a floor
    this.thin = sorted[1] < 0.06 && sorted[2] > sorted[1] * 4 ? Math.max(sorted[0], 1e-3) : 0;
    BOX_FACES.forEach(([n, t, b], i) => {
      if (skipFaces.includes(FACE_NAMES[i])) return;
      const hn = Math.abs(dot(n, half)), ht = Math.abs(dot(t, half)), hb = Math.abs(dot(b, half));
      const nw = rot(n, R), tw = rot(t, R), bw = rot(b, R);
      const corners: V3[] = [];
      const uvs: Array<[number, number]> = [];
      for (const [su, sv] of signs) {
        const local: V3 = [n[0] * hn + su * t[0] * ht + sv * b[0] * hb, n[1] * hn + su * t[1] * ht + sv * b[1] * hb,
          n[2] * hn + su * t[2] * ht + sv * b[2] * hb];
        const w = rot(local, R);
        const world: V3 = [w[0] + center[0], w[1] + center[1], w[2] + center[2]];
        corners.push(world);
        if (uvMode === "fit") {
          const ru = Math.max(Math.round(2 * ht / uvScale), 1), rv = Math.max(Math.round(2 * hb / uvScale), 1);
          uvs.push([(su * 0.5 + 0.5) * ru + uvOffset[0], (sv * 0.5 + 0.5) * rv + uvOffset[1]]);
        } else {
          uvs.push([dot(world, tw) / uvScale + uvOffset[0], dot(world, bw) / uvScale + uvOffset[1]]);
        }
      }
      this.addQuad(corners, nw, tw, bw, uvs);
      this.recordFace(nw, corners, this.indices.length - 6);
    });
    this.thin = 0;
    this.endShape(tok);
  }

  /** A box with rounded edges and an optional organic surface, for plinths, parapets, sills, footings, buttresses
   *  and slab edges. Every face is a grid; the grid's cuts are shared per axis, so the faces meet edge to edge. Grid
   *  points near a rounded edge are projected onto a quarter circle (the clamp-to-inner-box construction:
   *  p' = q + r (p - q) / |p - q|, q = p clamped to the box shrunk by r on the rounded sides), which gives smooth
   *  normals and a round corner where three rounded sides meet; flat faces follow the same profile at their border,
   *  so nothing cracks open. Then the displacement field moves every vertex (normals and tangents re-derived by
   *  finite differences). UVs come from the flat face, so textures do not stretch round the edges. The flat box is
   *  what gets recorded: the drawn surface only loses material inside it (plus the displacement), and the collider
   *  (made separately) never changes. */
  addRoundedBox(center: V3, size: V3, o: RoundedBoxOpts = {}): void {
    const hpr = o.hpr ?? [0, 0, 0];
    const R = hprMatrix(hpr[0], hpr[1], hpr[2]);
    const h: V3 = [size[0] / 2, size[1] / 2, size[2] / 2];
    const uvScale = o.uvScale ?? 1;
    const round = new Set(o.round ?? FACE_NAMES);
    const skip = new Set(o.skipFaces ?? []);
    const segs = Math.max(1, Math.min(4, Math.round(o.segments ?? 2)));
    // the radius must fit every rounded axis
    let r = Math.max(0, o.radius ?? 0);
    for (let k = 0; k < 3; k++) {
      const lo = round.has(FACE_NAMES[k * 2 + 1]), hi = round.has(FACE_NAMES[k * 2]);
      if (lo || hi) r = Math.min(r, h[k] * (lo && hi ? 0.9 : 1.8));
    }
    const rLo = [0, 1, 2].map((k) => (r > 0 && round.has(FACE_NAMES[k * 2 + 1]) ? r : 0));
    const rHi = [0, 1, 2].map((k) => (r > 0 && round.has(FACE_NAMES[k * 2]) ? r : 0));
    // per-axis cut positions (local), shared by every face that spans the axis
    const band: number[] = [];
    for (let k = 0; k < segs; k++) band.push(1 - Math.tan((Math.PI / 4) * k / segs));          // fractions of r from the edge
    const cuts: number[][] = [0, 1, 2].map((k) => {
      const c = [-h[k], h[k]];
      if (rLo[k] > 0) for (const f of band) c.push(-h[k] + f * rLo[k]);
      if (rHi[k] > 0) for (const f of band) c.push(h[k] - f * rHi[k]);
      const step = o.step ?? 0;
      const inner0 = -h[k] + rLo[k], inner1 = h[k] - rHi[k];
      if (step > 0 && inner1 - inner0 > step) {
        const n = Math.ceil((inner1 - inner0) / step);
        for (let i = 1; i < n; i++) c.push(inner0 + (inner1 - inner0) * i / n);
      }
      for (const x of o.cuts?.[k] ?? []) if (x > -h[k] + 1e-4 && x < h[k] - 1e-4) c.push(x);
      c.sort((a, b) => a - b);
      const out: number[] = [];
      for (const x of c) if (!out.length || x - out[out.length - 1] > 1e-5) out.push(x);
      return out;
    });
    const tok = this.beginShape();
    this.recordBox(center, h, R);
    const lo = [0, 1, 2].map((k) => -h[k] + rLo[k]), hi = [0, 1, 2].map((k) => h[k] - rHi[k]);
    const D = o.displace ?? null;
    const eps = 0.02;
    const place = (p: V3, faceN: V3, faceT: V3, rounded: boolean): { w: V3; n: V3; t: V3 } => {
      let lp = p, ln = faceN, lt = faceT;
      if (r > 0) {
        // every face follows the rounded profile at its border (a flat end cap is cut to the rounded edge's shape),
        // but only the rounded faces take the curved normals
        const q: V3 = [Math.min(hi[0], Math.max(lo[0], p[0])), Math.min(hi[1], Math.max(lo[1], p[1])), Math.min(hi[2], Math.max(lo[2], p[2]))];
        const d: V3 = [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
        const len = Math.hypot(d[0], d[1], d[2]);
        if (len > 1e-9) {
          const dn: V3 = [d[0] / len, d[1] / len, d[2] / len];
          lp = [q[0] + dn[0] * r, q[1] + dn[1] * r, q[2] + dn[2] * r];
          if (rounded) {
            ln = dn;
            const td = dot(faceT, ln);
            lt = norm([faceT[0] - ln[0] * td, faceT[1] - ln[1] * td, faceT[2] - ln[2] * td]);
            if (!Number.isFinite(lt[0]) || Math.hypot(lt[0], lt[1], lt[2]) < 0.5) lt = norm(cross(ln, faceN));
          }
        }
      }
      const rw = rot(lp, R);
      let w: V3 = [rw[0] + center[0], rw[1] + center[1], rw[2] + center[2]];
      let n = rot(ln, R), t = rot(lt, R);
      if (D) {
        const b = cross(n, t);
        const d0 = D(w);
        const dtp = D([w[0] + t[0] * eps, w[1] + t[1] * eps, w[2] + t[2] * eps]), dtm = D([w[0] - t[0] * eps, w[1] - t[1] * eps, w[2] - t[2] * eps]);
        const dbp = D([w[0] + b[0] * eps, w[1] + b[1] * eps, w[2] + b[2] * eps]), dbm = D([w[0] - b[0] * eps, w[1] - b[1] * eps, w[2] - b[2] * eps]);
        const Pt: V3 = [t[0] + (dtp[0] - dtm[0]) / (2 * eps), t[1] + (dtp[1] - dtm[1]) / (2 * eps), t[2] + (dtp[2] - dtm[2]) / (2 * eps)];
        const Pb: V3 = [b[0] + (dbp[0] - dbm[0]) / (2 * eps), b[1] + (dbp[1] - dbm[1]) / (2 * eps), b[2] + (dbp[2] - dbm[2]) / (2 * eps)];
        let nn = norm(cross(Pt, Pb));
        if (dot(nn, n) < 0) nn = [-nn[0], -nn[1], -nn[2]];
        n = nn;
        t = norm(Pt);
        w = [w[0] + d0[0], w[1] + d0[1], w[2] + d0[2]];
      }
      return { w, n, t };
    };
    BOX_FACES.forEach(([n, t, b], fi) => {
      if (skip.has(FACE_NAMES[fi])) return;
      const an = n.findIndex((x) => x !== 0), at = t.findIndex((x) => x !== 0), ab = b.findIndex((x) => x !== 0);
      const sn = n[an], st = t[at], sb = b[ab];
      const us = cuts[at].map((x) => x * st).sort((a, c) => a - c);
      const vs = cuts[ab].map((x) => x * sb).sort((a, c) => a - c);
      const rounded = r > 0 && round.has(FACE_NAMES[fi]);
      const tw = rot(t, R), bw = rot(b, R);
      const base = this.vertexCount;
      const i0 = this.indices.length;
      const ht = h[at], hb = h[ab];
      for (const v of vs) for (const u of us) {
        const p: V3 = [0, 0, 0];
        p[an] = sn * h[an];
        p[at] = u * st;
        p[ab] = v * sb;
        const flatW = rot(p, R);
        const fw: V3 = [flatW[0] + center[0], flatW[1] + center[1], flatW[2] + center[2]];
        let uu: number, vv: number;
        if (o.uvMode === "fit") {
          const ru = Math.max(Math.round(2 * ht / uvScale), 1), rv = Math.max(Math.round(2 * hb / uvScale), 1);
          uu = (u / ht * 0.5 + 0.5) * ru; vv = (v / hb * 0.5 + 0.5) * rv;
        } else { uu = dot(fw, tw) / uvScale; vv = dot(fw, bw) / uvScale; }
        const pl = place(p, n, t, rounded);
        const bt = cross(pl.n, pl.t);
        this.vertex(pl.w, pl.n, pl.t, bt, uu, vv);
      }
      const nu = us.length;
      const V = this.verts, F = FLOATS_PER_VERTEX;
      const tri = (a: number, bb: number, c: number) => {      // skip the slivers a flat cap's collapsed border leaves
        const ax = V[bb * F] - V[a * F], ay = V[bb * F + 1] - V[a * F + 1], az = V[bb * F + 2] - V[a * F + 2];
        const bx = V[c * F] - V[a * F], by = V[c * F + 1] - V[a * F + 1], bz = V[c * F + 2] - V[a * F + 2];
        const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
        if (cx * cx + cy * cy + cz * cz > 1e-14) this.indices.push(a, bb, c);
      };
      for (let j = 0; j < vs.length - 1; j++) for (let i = 0; i < nu - 1; i++) {
        const a = base + j * nu + i, bb = a + 1, c = a + nu + 1, d = a + nu;
        tri(a, bb, c);
        tri(a, c, d);
      }
      const corners: V3[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([su, sv]) => {
        const p: V3 = [0, 0, 0];
        p[an] = sn * h[an]; p[at] = su * st * ht; p[ab] = sv * sb * hb;
        const w = rot(p, R);
        return [w[0] + center[0], w[1] + center[1], w[2] + center[2]] as V3;
      });
      this.recordFace(rot(n, R), corners, i0);
    });
    this.endShape(tok);
  }

  /** Box with 45-degree bevelled edges and corners (26 faces). */
  addChamferBox(center: V3, size: V3, bevel = 0.01, hpr: V3 = [0, 0, 0], uvScale = 1, uvSpace = "local"): void {
    const h: V3 = [size[0] / 2, size[1] / 2, size[2] / 2];
    const b = Math.min(bevel, h[0] * 0.49, h[1] * 0.49, h[2] * 0.49);
    const R = hprMatrix(hpr[0], hpr[1], hpr[2]);
    const tok = this.beginShape();
    this.recordBox(center, h, R);
    const verts: Array<{ s: V3; axis: number; p: V3 }> = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const s: V3 = [sx, sy, sz];
      for (let axis = 0; axis < 3; axis++) {
        const p: V3 = [s[0] * (h[0] - b), s[1] * (h[1] - b), s[2] * (h[2] - b)];
        p[axis] = s[axis] * h[axis];
        verts.push({ s, axis, p });
      }
    }
    for (const nx of [-1, 0, 1]) for (const ny of [-1, 0, 1]) for (const nz of [-1, 0, 1]) {
      const n: V3 = [nx, ny, nz];
      if (!nx && !ny && !nz) continue;
      const nzAxes = [0, 1, 2].filter((a) => n[a] !== 0);
      const uniq: V3[] = [];
      for (const v of verts) {
        if (!nzAxes.includes(v.axis)) continue;
        if (nzAxes.some((a) => v.s[a] !== n[a])) continue;
        if (!uniq.some((q) => Math.abs(q[0] - v.p[0]) < 1e-8 && Math.abs(q[1] - v.p[1]) < 1e-8 && Math.abs(q[2] - v.p[2]) < 1e-8)) uniq.push(v.p);
      }
      const nn = norm(n);
      const up: V3 = Math.abs(nn[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
      const t = norm(cross(up, nn));
      const bt = cross(nn, t);
      const cen: V3 = [0, 0, 0];
      for (const p of uniq) { cen[0] += p[0] / uniq.length; cen[1] += p[1] / uniq.length; cen[2] += p[2] / uniq.length; }
      const ordered = uniq.map((p) => ({ p, a: Math.atan2(dot([p[0] - cen[0], p[1] - cen[1], p[2] - cen[2]], bt),
        dot([p[0] - cen[0], p[1] - cen[1], p[2] - cen[2]], t)) })).sort((x, y) => x.a - y.a).map((x) => x.p);
      const tw = rot(t, R), bw = rot(bt, R), nw = rot(nn, R);
      const base = this.vertexCount;
      const i0 = this.indices.length;
      const poly: V3[] = [];
      for (const local of ordered) {
        const r = rot(local, R);
        const world: V3 = [r[0] + center[0], r[1] + center[1], r[2] + center[2]];
        poly.push(world);
        const src = uvSpace === "world" ? world : local;
        const u = dot(src, uvSpace === "world" ? tw : t) / uvScale;
        const v = dot(src, uvSpace === "world" ? bw : bt) / uvScale;
        this.vertex(world, nw, tw, bw, u, v);
      }
      for (let i = 1; i < ordered.length - 1; i++) this.indices.push(base, base + i, base + i + 1);
      this.recordFace(nw, poly, i0);
    }
    this.endShape(tok);
  }

  /** Convex planar polygon (counter-clockwise seen from the normal side), world UVs. */
  addPolygon(points: V3[], normal: V3, tangent: V3, binormal: V3, uvScale = 1): void {
    const tok = this.beginShape();
    const base = this.vertexCount;
    const i0 = this.indices.length;
    for (const p of points) this.vertex(p, normal, tangent, binormal, dot(p, tangent) / uvScale, dot(p, binormal) / uvScale);
    for (let i = 1; i < points.length - 1; i++) this.indices.push(base, base + i, base + i + 1);
    this.recordFace(normal, points.map((p) => [p[0], p[1], p[2]] as V3), i0);
    this.endShape(tok);
  }

  /** Solid ramp: bottom-front-centre at base, rising height over length along local +Y. */
  addWedge(base: V3, width: number, length: number, height: number, heading = 0, uvScale = 1): void {
    const R = hprMatrix(heading, 0, 0);
    const tok = this.beginShape();
    const w2 = width / 2, L = length, H = height;
    const xf = (p: V3): V3 => { const r = rot(p, R); return [r[0] + base[0], r[1] + base[1], r[2] + base[2]]; };
    const d = (v: V3): V3 => norm(rot(v, R));
    const slopeN = d([0, -H, L]);
    const slopeB = d([0, L, H]);
    this.addPolygon([xf([-w2, 0, 0]), xf([w2, 0, 0]), xf([w2, L, H]), xf([-w2, L, H])], slopeN, d([1, 0, 0]), slopeB, uvScale);
    this.addPolygon([xf([w2, L, 0]), xf([-w2, L, 0]), xf([-w2, L, H]), xf([w2, L, H])], d([0, 1, 0]), d([-1, 0, 0]), d([0, 0, 1]), uvScale);
    this.addPolygon([xf([w2, 0, 0]), xf([-w2, 0, 0]), xf([-w2, L, 0]), xf([w2, L, 0])], d([0, 0, -1]), d([-1, 0, 0]), d([0, 1, 0]), uvScale);
    this.addPolygon([xf([w2, 0, 0]), xf([w2, L, 0]), xf([w2, L, H])], d([1, 0, 0]), d([0, 1, 0]), d([0, 0, 1]), uvScale);
    this.addPolygon([xf([-w2, L, 0]), xf([-w2, 0, 0]), xf([-w2, L, H])], d([-1, 0, 0]), d([0, -1, 0]), d([0, 0, 1]), uvScale);
    this.endShape(tok);
  }

  /** Vertical cylinder; center is the middle of the axis. */
  addCylinder(center: V3, radius: number, height: number, segments = 24, uvScale = 1, caps = true, hpr: V3 = [0, 0, 0]): void {
    const R = hprMatrix(hpr[0], hpr[1], hpr[2]);
    const tok = this.beginShape();
    this.thin = radius < 0.03 && height > radius * 8 ? radius * 2 : 0;
    const xf = (p: V3): V3 => { const r = rot(p, R); return [r[0] + center[0], r[1] + center[1], r[2] + center[2]]; };
    const circ = 2 * Math.PI * radius;
    const rep = Math.max(Math.round(circ / uvScale), 1);
    const base = this.vertexCount;
    for (const [z, vv] of [[-height / 2, 0], [height / 2, height / uvScale]]) {
      for (let i = 0; i <= segments; i++) {
        const a = 2 * Math.PI * i / segments;
        const c = Math.cos(a), s = Math.sin(a);
        this.vertex(xf([c * radius, s * radius, z]), rot([c, s, 0], R), rot([-s, c, 0], R), rot([0, 0, 1], R),
          a / (2 * Math.PI) * rep, vv);
      }
    }
    const sN = segments + 1;
    for (let i = 0; i < segments; i++) this.indices.push(base + i, base + i + 1, base + sN + i + 1, base + i, base + sN + i + 1, base + sN + i);
    if (caps) {
      for (const top of [false, true]) {
        const z = top ? height / 2 : -height / 2;
        const nz = top ? 1 : -1;
        const cb = this.vertexCount;
        const ci0 = this.indices.length;
        const nW = rot([0, 0, nz], R), tW = rot([nz, 0, 0], R), bW = rot([0, 1, 0], R);
        this.vertex(xf([0, 0, z]), nW, tW, bW, 0, 0);
        for (let i = 0; i < segments; i++) {
          const a = 2 * Math.PI * i / segments;
          const x = Math.cos(a) * radius, y = Math.sin(a) * radius;
          this.vertex(xf([x, y, z]), nW, tW, bW, x * nz / uvScale, y / uvScale);
        }
        for (let i = 0; i < segments; i++) {
          const j = (i + 1) % segments;
          if (top) this.indices.push(cb, cb + 1 + i, cb + 1 + j);
          else this.indices.push(cb, cb + 1 + j, cb + 1 + i);
        }
        if (MeshBuilder.recorder) {
          const poly: V3[] = [];
          for (let i = 0; i < segments; i++) { const a = 2 * Math.PI * i / segments; poly.push(xf([Math.cos(a) * radius, Math.sin(a) * radius, z])); }
          this.recordFace(nW, top ? poly : poly.reverse(), ci0);
        }
      }
    }
    this.thin = 0;
    this.endShape(tok);
  }

  addSphere(center: V3, radius: number, rings = 24, segments = 48, uvScale = 1): void {
    const tok = this.beginShape();
    const base = this.vertexCount;
    const ru = Math.max(Math.round(2 * Math.PI * radius / uvScale), 1);
    const rv = Math.max(Math.round(Math.PI * radius / uvScale), 1);
    for (let r = 0; r <= rings; r++) {
      const th = Math.PI * r / rings;
      for (let k = 0; k <= segments; k++) {
        const ph = 2 * Math.PI * k / segments;
        const n: V3 = [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)];
        const t: V3 = [-Math.sin(ph), Math.cos(ph), 0];
        this.vertex([n[0] * radius + center[0], n[1] * radius + center[1], n[2] * radius + center[2]], n, t, cross(n, t),
          ph / (2 * Math.PI) * ru, (1 - th / Math.PI) * rv);
      }
    }
    const s = segments + 1;
    for (let r = 0; r < rings; r++) for (let k = 0; k < segments; k++) {
      const a = base + r * s + k, b = a + 1, c = a + s + 1, d = a + s;
      this.indices.push(a, d, c, a, c, b);
    }
    this.endShape(tok);
  }

  /** Upper hemisphere (a dome) standing on its rim at ``center``; ``squash`` scales its height
   * (1 = round, < 1 a shallow vault, > 1 an onion-ish profile). Open at the bottom. */
  addDome(center: V3, radius: number, squash = 1, rings = 12, segments = 32, uvScale = 1): void {
    const tok = this.beginShape();
    const base = this.vertexCount;
    const ru = Math.max(Math.round(2 * Math.PI * radius / uvScale), 1);
    const rv = Math.max(Math.round(Math.PI * radius * 0.5 / uvScale), 1);
    for (let r = 0; r <= rings; r++) {
      const th = (Math.PI / 2) * r / rings;              // 0 at the apex, pi/2 at the rim
      for (let k = 0; k <= segments; k++) {
        const ph = 2 * Math.PI * k / segments;
        const p: V3 = [Math.sin(th) * Math.cos(ph) * radius, Math.sin(th) * Math.sin(ph) * radius, Math.cos(th) * radius * squash];
        const n = norm([Math.sin(th) * Math.cos(ph) * squash, Math.sin(th) * Math.sin(ph) * squash, Math.cos(th)]);
        const t: V3 = [-Math.sin(ph), Math.cos(ph), 0];
        this.vertex([p[0] + center[0], p[1] + center[1], p[2] + center[2]], n, t, cross(n, t),
          ph / (2 * Math.PI) * ru, (1 - th / (Math.PI / 2)) * rv);
      }
    }
    const s = segments + 1;
    for (let r = 0; r < rings; r++) for (let k = 0; k < segments; k++) {
      const a = base + r * s + k, b = a + 1, c = a + s + 1, d = a + s;
      this.indices.push(a, d, c, a, c, b);
    }
    this.endShape(tok);
  }

  /** Transform every vertex by a row-vector 4x4 matrix (positions; frames re-normalised). */
  transformed(m: Float64Array | number[]): MeshBuilder {
    const out = new MeshBuilder();
    out.indices = this.indices.slice();
    const v = this.verts;
    for (let i = 0; i < v.length; i += FLOATS_PER_VERTEX) {
      const p = [v[i] * m[0] + v[i + 1] * m[4] + v[i + 2] * m[8] + m[12], v[i] * m[1] + v[i + 1] * m[5] + v[i + 2] * m[9] + m[13],
        v[i] * m[2] + v[i + 1] * m[6] + v[i + 2] * m[10] + m[14]];
      out.verts.push(p[0], p[1], p[2]);
      for (const a of [3, 6, 9]) {
        const d: V3 = [v[i + a] * m[0] + v[i + a + 1] * m[4] + v[i + a + 2] * m[8], v[i + a] * m[1] + v[i + a + 1] * m[5] + v[i + a + 2] * m[9],
          v[i + a] * m[2] + v[i + a + 1] * m[6] + v[i + a + 2] * m[10]];
        const n = norm(d);
        out.verts.push(n[0], n[1], n[2]);
      }
      for (let k = 12; k < FLOATS_PER_VERTEX; k++) out.verts.push(v[i + k]);
    }
    return out;
  }

  merge(other: MeshBuilder): void { this.add(other.verts, other.indices); }
}
