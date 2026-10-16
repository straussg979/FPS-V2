// Coplanar-overlap detection and clean-up for the level geometry. Two faces of different pieces that lie in the same
// plane (within 2 mm), face the same way and overlap by more than a square centimetre z-fight - the GPU cannot tell
// which is in front, so the image tears into stripes of both, worst at a distance and in motion. Faces facing
// opposite ways never fight (one is always back-face culled), and faces that only touch along an edge do not either.
//
// finalizeGeometry() is what the asset build runs on every map (scripts/maps/overlaps.ts reports the same):
//  1. removeHiddenFaces(): a face buried in solid (a wall's foot in the floor slab, the end of a wall against the
//     next one, a plinth's back in the wall) is never visible: it is cut, so only one surface exists there;
//  2. resolveOverlaps(): the remaining coplanar faces are layered apart: the largest face of a group stays, every
//     other is moved a few millimetres out along the normal with its whole piece (a trim, a lintel, a floor patch),
//     so the piece stays closed; repeated until nothing is left;
//  3. the builders are compacted and the surface detail is baked (bake.ts).
// Only drawn geometry changes; colliders are separate data and never move.

import { FLOATS_PER_VERTEX, type FaceRecord, type FaceRecorder, type MeshBuilder } from "./meshbuilder";
import type { V3 } from "../math";
import { bakeDetail, type WeatherSource } from "./bake";

export const PLANE_EPS = 0.002;          // metres: faces closer than this count as coplanar
export const AREA_EPS = 1e-4;            // square metres of overlap before it counts (1 cm^2)
export const NUDGE = 0.004;              // metres a detail piece is moved out per layer

export interface Overlap { a: number; b: number; area: number }

type P2 = [number, number];

function basis(n: V3): [V3, V3] {
  const up: V3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const t: V3 = [up[1] * n[2] - up[2] * n[1], up[2] * n[0] - up[0] * n[2], up[0] * n[1] - up[1] * n[0]];
  const l = Math.hypot(t[0], t[1], t[2]);
  t[0] /= l; t[1] /= l; t[2] /= l;
  const b: V3 = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]];
  return [t, b];
}

function area2(p: P2[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1]; }
  return a / 2;
}

/** Sutherland-Hodgman: the part of convex polygon `subject` inside convex polygon `clip` (both counter-clockwise). */
function clipPoly(subject: P2[], clip: P2[]): P2[] {
  let out = subject;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    const inside = (p: P2) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= -1e-9;
    const inp = out;
    out = [];
    for (let j = 0; j < inp.length; j++) {
      const p = inp[j], q = inp[(j + 1) % inp.length];
      const pi = inside(p), qi = inside(q);
      if (pi) out.push(p);
      if (pi !== qi) {
        const dx = q[0] - p[0], dy = q[1] - p[1];
        const ex = b[0] - a[0], ey = b[1] - a[1];
        const den = dx * ey - dy * ex;
        if (Math.abs(den) > 1e-12) {
          const t = ((a[0] - p[0]) * ey - (a[1] - p[1]) * ex) / den;
          out.push([p[0] + dx * t, p[1] + dy * t]);
        }
      }
    }
  }
  return out;
}

interface Prepared { f: FaceRecord; i: number; p2: P2[]; min: P2; max: P2; area: number }

/** All pairs of coplanar, same-facing, overlapping faces from different pieces (and the same level-of-detail variant). */
export function findOverlaps(rec: FaceRecorder): Overlap[] {
  // bucket by (quantised normal, plane offset in 2 mm cells); the neighbouring offset cell is checked too
  const buckets = new Map<string, number[]>();
  const keyN = (n: V3) => `${Math.round(n[0] * 2000)},${Math.round(n[1] * 2000)},${Math.round(n[2] * 2000)}`;
  const faces = rec.faces;
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
    const k = `${keyN(f.n)}|${Math.floor(f.d / PLANE_EPS)}`;
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = []));
    b.push(i);
  }
  const prepared = new Map<number, Prepared>();
  const prep = (i: number): Prepared => {
    let p = prepared.get(i);
    if (p) return p;
    const f = faces[i];
    const [t, b] = basis(f.n);
    let p2: P2[] = f.poly.map((q) => [q[0] * t[0] + q[1] * t[1] + q[2] * t[2], q[0] * b[0] + q[1] * b[1] + q[2] * b[2]] as P2);
    if (area2(p2) < 0) p2 = p2.reverse();
    const min: P2 = [Infinity, Infinity], max: P2 = [-Infinity, -Infinity];
    for (const q of p2) { min[0] = Math.min(min[0], q[0]); min[1] = Math.min(min[1], q[1]); max[0] = Math.max(max[0], q[0]); max[1] = Math.max(max[1], q[1]); }
    p = { f, i, p2, min, max, area: Math.abs(area2(p2)) };
    prepared.set(i, p);
    return p;
  };
  const out: Overlap[] = [];
  const seen = new Set<string>();
  for (const [k, list] of buckets) {
    const [nk, dk] = k.split("|");
    const cand = [...list, ...(buckets.get(`${nk}|${Number(dk) + 1}`) ?? [])];
    if (cand.length < 2) continue;
    const ps = cand.map(prep).filter((p) => p.area > AREA_EPS * 0.5).sort((x, y) => x.min[0] - y.min[0]);
    for (let x = 0; x < ps.length; x++) {
      const A = ps[x];
      for (let y = x + 1; y < ps.length; y++) {
        const B = ps[y];
        if (B.min[0] >= A.max[0] - 1e-6) break;
        if (A.f.shape === B.f.shape) continue;
        const va = rec.shapes[A.f.shape], vb = rec.shapes[B.f.shape];
        if (va.group === vb.group) continue;
        if (va.variant && vb.variant && va.variant !== vb.variant) continue;
        if (B.min[1] >= A.max[1] - 1e-6 || A.min[1] >= B.max[1] - 1e-6) continue;
        if (Math.abs(A.f.d - B.f.d) > PLANE_EPS) continue;
        const dotn = A.f.n[0] * B.f.n[0] + A.f.n[1] * B.f.n[1] + A.f.n[2] * B.f.n[2];
        if (dotn < 0.99995) continue;
        const inter = clipPoly(A.p2, B.p2);
        if (inter.length < 3) continue;
        const a = Math.abs(area2(inter));
        if (a < AREA_EPS) continue;
        const key = A.i < B.i ? `${A.i}:${B.i}` : `${B.i}:${A.i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ a: A.i, b: B.i, area: a });
      }
    }
  }
  return out;
}

function faceArea(f: FaceRecord): number {
  const [t, b] = basis(f.n);
  return Math.abs(area2(f.poly.map((q) => [q[0] * t[0] + q[1] * t[1] + q[2] * t[2], q[0] * b[0] + q[1] * b[1] + q[2] * b[2]] as P2)));
}

/** Faces buried in solid: a face whose every sample point (the centre, the corners and a 25 cm grid over it), 1.5 mm
 *  in front of it, lies inside some other piece's box is never visible. Its triangles are removed (made degenerate;
 *  compact() drops them). Returns how many were removed. */
export function removeHiddenFaces(rec: FaceRecorder): number {
  const CELL = 2;
  const grid = new Map<string, number[]>();
  const large: number[] = [];
  const boxes: Array<{ c: V3; h: V3; R: number[][] }> = [];
  const owner: number[] = [];
  rec.shapes.forEach((s, si) => { for (const b of s.boxes) { boxes.push(b); owner.push(si); } });
  boxes.forEach((b, i) => {
    const ext = [0, 1, 2].map((k) => Math.abs(b.R[0][k]) * b.h[0] + Math.abs(b.R[1][k]) * b.h[1] + Math.abs(b.R[2][k]) * b.h[2]);
    const lo = [0, 1, 2].map((k) => Math.floor((b.c[k] - ext[k]) / CELL)), hi = [0, 1, 2].map((k) => Math.floor((b.c[k] + ext[k]) / CELL));
    if ((hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1) > 400) { large.push(i); return; }   // ground slabs: always tested
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
      const k = `${x},${y},${z}`;
      let l = grid.get(k);
      if (!l) grid.set(k, (l = []));
      l.push(i);
    }
  });
  const inside = (p: V3, own: number): boolean => {
    const l = grid.get(`${Math.floor(p[0] / CELL)},${Math.floor(p[1] / CELL)},${Math.floor(p[2] / CELL)}`) ?? [];
    const so = rec.shapes[own];
    for (const list of [l, large]) for (const i of list) {
      if (owner[i] === own) continue;
      const os = rec.shapes[owner[i]];
      if (so.variant && os.variant && so.variant !== os.variant) continue;
      const b = boxes[i];
      const dx = p[0] - b.c[0], dy = p[1] - b.c[1], dz = p[2] - b.c[2];
      // local = R * d (rows of R are the box axes in world space)
      if (Math.abs(dx * b.R[0][0] + dy * b.R[0][1] + dz * b.R[0][2]) > b.h[0] + 1e-5) continue;
      if (Math.abs(dx * b.R[1][0] + dy * b.R[1][1] + dz * b.R[1][2]) > b.h[1] + 1e-5) continue;
      if (Math.abs(dx * b.R[2][0] + dy * b.R[2][1] + dz * b.R[2][2]) > b.h[2] + 1e-5) continue;
      return true;
    }
    return false;
  };
  let removed = 0;
  const off = 0.0015;
  const test = (f: FaceRecord, p: V3) => inside([p[0] + f.n[0] * off, p[1] + f.n[1] * off, p[2] + f.n[2] * off], f.shape);
  for (const f of rec.faces) {
    if (f.removed) continue;
    const c: V3 = [0, 0, 0];
    for (const q of f.poly) { c[0] += q[0] / f.poly.length; c[1] += q[1] / f.poly.length; c[2] += q[2] / f.poly.length; }
    // quick rejection: the centre and the corners
    let hidden = test(f, c);
    for (const q of f.poly) {
      if (!hidden) break;
      hidden = test(f, [q[0] + (c[0] - q[0]) * 0.02, q[1] + (c[1] - q[1]) * 0.02, q[2] + (c[2] - q[2]) * 0.02]);
    }
    // then a dense grid over the face (every 25 cm at most), so a face only partly covered is never cut
    if (hidden && f.poly.length === 4) {
      const [p0, p1, , p3] = f.poly;
      const eu: V3 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], ev: V3 = [p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]];
      const nu = Math.min(160, Math.max(2, Math.ceil(Math.hypot(eu[0], eu[1], eu[2]) / 0.25) + 1));
      const nv = Math.min(160, Math.max(2, Math.ceil(Math.hypot(ev[0], ev[1], ev[2]) / 0.25) + 1));
      for (let i = 0; i < nu && hidden; i++) for (let j = 0; j < nv && hidden; j++) {
        const a = 0.01 + 0.98 * i / (nu - 1), b = 0.01 + 0.98 * j / (nv - 1);
        hidden = test(f, [p0[0] + eu[0] * a + ev[0] * b, p0[1] + eu[1] * a + ev[1] * b, p0[2] + eu[2] * a + ev[2] * b]);
      }
    } else if (hidden) {
      // other polygons (chamfer faces, caps): the edge midpoints pulled 2 % in
      for (let i = 0; i < f.poly.length && hidden; i++) {
        const q = f.poly[i], r = f.poly[(i + 1) % f.poly.length];
        const m: V3 = [(q[0] + r[0]) / 2, (q[1] + r[1]) / 2, (q[2] + r[2]) / 2];
        hidden = test(f, [m[0] + (c[0] - m[0]) * 0.02, m[1] + (c[1] - m[1]) * 0.02, m[2] + (c[2] - m[2]) * 0.02]);
      }
    }
    if (!hidden) continue;
    const idx = rec.shapes[f.shape].builder.indices;
    for (let i = f.i0; i < f.i1; i++) idx[i] = idx[f.i0];
    f.removed = true;
    removed++;
  }
  rec.faces = rec.faces.filter((f) => !f.removed);
  return removed;
}

export const resolveStats: { maxMove: number; moved: number; firstRound: Overlap[] } = { maxMove: 0, moved: 0, firstRound: [] };

/** Fix the remaining overlaps in place. Overlapping faces in one plane are layered: the largest face of a group
 *  stays, every other is lifted NUDGE metres per layer out along the normal (one more layer than the faces it
 *  overlaps that were placed before it, largest first), by moving its whole piece. A piece keeps moving the way it
 *  already went (no two pieces trade places round after round); one overlapped on opposite faces (a floor patch: top
 *  and bottom) moves one way only, which clears both. Repeated until nothing is left (or a few rounds). Returns the
 *  number of overlaps found in each round. */
export function resolveOverlaps(rec: FaceRecorder, rounds = 16): number[] {
  const counts: number[] = [];
  const total = new Map<number, V3>();          // how far each piece has been moved so far
  resolveStats.firstRound = [];
  for (let round = 0; round < rounds; round++) {
    const found = findOverlaps(rec);
    counts.push(found.length);
    if (!found.length) break;
    if (round === 0) resolveStats.firstRound = found;
    const nb = new Map<number, number[]>();
    for (const o of found) {
      (nb.get(o.a) ?? nb.set(o.a, []).get(o.a)!).push(o.b);
      (nb.get(o.b) ?? nb.set(o.b, []).get(o.b)!).push(o.a);
    }
    const areas = new Map<number, number>();
    for (const i of nb.keys()) areas.set(i, faceArea(rec.faces[i]));
    const order = [...nb.keys()].sort((x, y) => (areas.get(y)! - areas.get(x)!) || (rec.faces[x].shape - rec.faces[y].shape));
    const layer = new Map<number, number>();
    for (const i of order) {
      let l = -1;
      for (const j of nb.get(i)!) if (layer.has(j)) l = Math.max(l, layer.get(j)!);
      layer.set(i, l + 1);
    }
    // per shape: the largest lift wanted along each distinct normal
    const lifts = new Map<number, Array<{ n: V3; k: number }>>();
    for (const [i, k] of layer) {
      if (k === 0) continue;
      const f0 = rec.faces[i];
      const prev = total.get(f0.shape);
      const n: V3 = prev && prev[0] * f0.n[0] + prev[1] * f0.n[1] + prev[2] * f0.n[2] < -1e-9 ? [-f0.n[0], -f0.n[1], -f0.n[2]] : f0.n;
      let l = lifts.get(f0.shape);
      if (!l) lifts.set(f0.shape, (l = []));
      const same = l.find((e) => e.n[0] * n[0] + e.n[1] * n[1] + e.n[2] * n[2] > 0.999);
      if (same) { same.k = Math.max(same.k, k); continue; }
      const opp = l.findIndex((e) => e.n[0] * n[0] + e.n[1] * n[1] + e.n[2] * n[2] < -0.999);
      if (opp >= 0) {
        const e = l[opp];
        if (n[2] > e.n[2] + 1e-6 || (Math.abs(n[2] - e.n[2]) <= 1e-6 && k > e.k)) l[opp] = { n, k: Math.max(k, e.k) };
        else e.k = Math.max(k, e.k);
        continue;
      }
      l.push({ n, k });
    }
    // a lift applies to the shape's whole group (the pieces of one organic wall move as one)
    const members = new Map<number, number[]>();
    rec.shapes.forEach((sh, i) => { (members.get(sh.group) ?? members.set(sh.group, []).get(sh.group)!).push(i); });
    const byGroup = new Map<number, Array<{ n: V3; k: number }>>();
    for (const [shape, l] of lifts) {
      const gid = rec.shapes[shape].group;
      const cur = byGroup.get(gid);
      if (!cur) byGroup.set(gid, l.map((e) => ({ ...e })));
      else for (const e of l) { const same = cur.find((c) => c.n[0] * e.n[0] + c.n[1] * e.n[1] + c.n[2] * e.n[2] > 0.999); if (same) same.k = Math.max(same.k, e.k); else cur.push({ ...e }); }
    }
    const facesOf = new Map<number, FaceRecord[]>();
    for (const f of rec.faces) { let l = facesOf.get(f.shape); if (!l) facesOf.set(f.shape, (l = [])); l.push(f); }
    for (const [gid, l] of byGroup) {
      const m: V3 = [0, 0, 0];
      for (const e of l) { m[0] += e.n[0] * NUDGE * e.k; m[1] += e.n[1] * NUDGE * e.k; m[2] += e.n[2] * NUDGE * e.k; }
      for (const shape of members.get(gid) ?? [gid]) {
        const t = total.get(shape) ?? [0, 0, 0];
        t[0] += m[0]; t[1] += m[1]; t[2] += m[2];
        total.set(shape, t);
        const s = rec.shapes[shape];
        const v = s.builder.verts;
        for (let i = s.v0; i < s.v1; i++) {
          const o = i * FLOATS_PER_VERTEX;
          v[o] += m[0]; v[o + 1] += m[1]; v[o + 2] += m[2];
        }
        for (const b of s.boxes) { b.c[0] += m[0]; b.c[1] += m[1]; b.c[2] += m[2]; }
        for (const f of facesOf.get(shape) ?? []) {
          for (const q of f.poly) { q[0] += m[0]; q[1] += m[1]; q[2] += m[2]; }
          f.d = f.n[0] * f.poly[0][0] + f.n[1] * f.poly[0][1] + f.n[2] * f.poly[0][2];
        }
      }
    }
  }
  resolveStats.moved = total.size;
  resolveStats.maxMove = Math.max(0, ...[...total.values()].map((t) => Math.hypot(t[0], t[1], t[2])));
  return counts;
}

/** The asset build's clean-up of a level's geometry: buried faces removed, coplanar overlaps layered apart, the
 *  builders compacted, the surface detail baked. Returns numbers for the build log and the overlap report. */
export function finalizeGeometry(rec: FaceRecorder, builders: Map<string, MeshBuilder>, weather: WeatherSource[] = []):
    { hidden: number; rounds: number[]; left: number; bakeMs: number } {
  const hidden = removeHiddenFaces(rec);
  const rounds = resolveOverlaps(rec);
  const left = findOverlaps(rec).length;
  for (const b of builders.values()) b.compact();
  const bake = bakeDetail(rec, builders.entries(), weather);
  return { hidden, rounds, left, bakeMs: bake.ms };
}
