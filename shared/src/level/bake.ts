// Per-vertex surface detail baked into the level geometry by the asset build (the detail4 attribute, meshbuilder.ts):
//  * ambient occlusion: from every vertex, 12 short rays (75 cm) over the hemisphere around its normal are tested
//    against the solid boxes of the level; the more that hit, and the closer, the darker. Inner corners, wall
//    bases, the undersides of beams and roof edges get contact darkening, even on the low preset (it is free at
//    run time). Rays use a fixed, per-vertex-rotated pattern, so the bake is deterministic;
//  * weathering sources the prefabs registered: rain streaks below spouts, sills and parapets (> 0), soot above
//    tandoors and kitchen openings (< 0). The shader turns the mask into streaks and stains (client surface.ts).

import { DETAIL_OFFSET, FLOATS_PER_VERTEX, type FaceRecorder, type MeshBuilder } from "./meshbuilder";
import type { V3 } from "../math";

/** A weathering source: below `p` (on walls facing `out`), within `width` along the wall and `length` downward. */
export interface WeatherSource { p: V3; out: [number, number]; width: number; length: number; strength: number }

const RAYS: V3[] = (() => {
  // 12 cosine-weighted directions around +z (golden-angle spiral)
  const out: V3[] = [];
  for (let i = 0; i < 12; i++) {
    const r = Math.sqrt((i + 0.5) / 12), a = i * 2.39996323;
    out.push([r * Math.cos(a), r * Math.sin(a), Math.sqrt(Math.max(0, 1 - r * r))]);
  }
  return out;
})();

/** Bake AO and weathering into every level builder (not the backdrop). Uses the recorded solid boxes. */
export function bakeDetail(rec: FaceRecorder, builders: Iterable<[string, MeshBuilder]>, weather: WeatherSource[]): { vertices: number; ms: number } {
  const t0 = Date.now();
  const CELL = 1;
  const grid = new Map<number, number[]>();
  const large: number[] = [];
  // the low-detail variant's volumes (the same solids as the near variant's) plus everything without variants
  const boxes = rec.shapes.filter((s) => s.variant !== "hi").flatMap((s) => s.boxes);
  const key = (x: number, y: number, z: number) => ((x + 512) * 1024 + (y + 512)) * 64 + (z + 16);
  boxes.forEach((b, i) => {
    const ext = [0, 1, 2].map((k) => Math.abs(b.R[0][k]) * b.h[0] + Math.abs(b.R[1][k]) * b.h[1] + Math.abs(b.R[2][k]) * b.h[2]);
    const lo = [0, 1, 2].map((k) => Math.floor((b.c[k] - ext[k]) / CELL)), hi = [0, 1, 2].map((k) => Math.floor((b.c[k] + ext[k]) / CELL));
    if ((hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1) > 600) { large.push(i); return; }
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
      const k = key(x, y, z);
      let l = grid.get(k);
      if (!l) grid.set(k, (l = []));
      l.push(i);
    }
  });
  const stamp = new Int32Array(boxes.length).fill(-1);
  let query = 0;
  // segment p + d * t, t in [0, L]: nearest hit fraction against oriented boxes (slab test in box space)
  const hitT = (p: V3, d: V3, L: number): number => {
    query++;
    let best = L;
    const test = (i: number) => {
      if (stamp[i] === query) return;
      stamp[i] = query;
      const b = boxes[i];
      const rx = p[0] - b.c[0], ry = p[1] - b.c[1], rz = p[2] - b.c[2];
      let t0 = 0, t1 = best;
      for (let k = 0; k < 3; k++) {
        const R = b.R[k];
        const o = rx * R[0] + ry * R[1] + rz * R[2], v = d[0] * R[0] + d[1] * R[1] + d[2] * R[2];
        if (Math.abs(v) < 1e-9) { if (Math.abs(o) > b.h[k]) return; continue; }
        let a = (-b.h[k] - o) / v, c = (b.h[k] - o) / v;
        if (a > c) { const s = a; a = c; c = s; }
        if (a > t0) t0 = a;
        if (c < t1) t1 = c;
        if (t0 > t1) return;
      }
      if (t0 > 1e-4 && t0 < best) best = t0;
    };
    const e: V3 = [p[0] + d[0] * L, p[1] + d[1] * L, p[2] + d[2] * L];
    const x0 = Math.floor(Math.min(p[0], e[0]) / CELL), x1 = Math.floor(Math.max(p[0], e[0]) / CELL);
    const y0 = Math.floor(Math.min(p[1], e[1]) / CELL), y1 = Math.floor(Math.max(p[1], e[1]) / CELL);
    const z0 = Math.floor(Math.min(p[2], e[2]) / CELL), z1 = Math.floor(Math.max(p[2], e[2]) / CELL);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      const l = grid.get(key(x, y, z));
      if (l) for (const i of l) test(i);
    }
    for (const i of large) test(i);
    return best;
  };
  // weathering sources in a 2D grid
  const WCELL = 4;
  const wgrid = new Map<string, WeatherSource[]>();
  for (const w of weather) {
    const r = w.width / 2 + 0.5;
    for (let x = Math.floor((w.p[0] - r) / WCELL); x <= Math.floor((w.p[0] + r) / WCELL); x++)
      for (let y = Math.floor((w.p[1] - r) / WCELL); y <= Math.floor((w.p[1] + r) / WCELL); y++) {
        const k = `${x},${y}`;
        (wgrid.get(k) ?? wgrid.set(k, []).get(k)!).push(w);
      }
  }
  const cache = new Map<string, [number, number]>();
  const L = 0.75;
  let n = 0;
  for (const [name, mb] of builders) {
    if (name.endsWith("@backdrop")) continue;
    const v = mb.verts;
    for (let i = 0; i < v.length; i += FLOATS_PER_VERTEX) {
      n++;
      const p: V3 = [v[i], v[i + 1], v[i + 2]], nr: V3 = [v[i + 3], v[i + 4], v[i + 5]];
      const ck = `${Math.round(p[0] * 200)},${Math.round(p[1] * 200)},${Math.round(p[2] * 200)},${Math.round(nr[0] * 10)},${Math.round(nr[1] * 10)},${Math.round(nr[2] * 10)}`;
      let res = cache.get(ck);
      if (!res) {
        // ambient occlusion
        const t = Math.abs(nr[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
        let tx = t[1] * nr[2] - t[2] * nr[1], ty = t[2] * nr[0] - t[0] * nr[2], tz = t[0] * nr[1] - t[1] * nr[0];
        const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
        const bx = nr[1] * tz - nr[2] * ty, by = nr[2] * tx - nr[0] * tz, bz = nr[0] * ty - nr[1] * tx;
        const rot = ((Math.abs(Math.floor(p[0] * 37 + p[1] * 59 + p[2] * 83)) % 97) / 97) * Math.PI * 2;
        const cr = Math.cos(rot), sr = Math.sin(rot);
        const start: V3 = [p[0] + nr[0] * 0.012, p[1] + nr[1] * 0.012, p[2] + nr[2] * 0.012];
        let occ = 0;
        for (const r of RAYS) {
          const a = r[0] * cr - r[1] * sr, b = r[0] * sr + r[1] * cr;
          const d: V3 = [tx * a + bx * b + nr[0] * r[2], ty * a + by * b + nr[1] * r[2], tz * a + bz * b + nr[2] * r[2]];
          const h = hitT(start, d, L);
          if (h < L) occ += Math.sqrt(1 - h / L);
        }
        const ao = Math.max(0.3, 1 - 0.85 * occ / RAYS.length);
        // weathering
        let wx = 0;
        if (Math.abs(nr[2]) < 0.6) {
          for (const w of wgrid.get(`${Math.floor(p[0] / WCELL)},${Math.floor(p[1] / WCELL)}`) ?? []) {
            if (nr[0] * w.out[0] + nr[1] * w.out[1] < 0.6) continue;
            const dz = w.p[2] - p[2];
            if (dz < -0.05 || dz > w.length) continue;
            const along = Math.abs((p[0] - w.p[0]) * -w.out[1] + (p[1] - w.p[1]) * w.out[0]);
            const off = Math.abs((p[0] - w.p[0]) * w.out[0] + (p[1] - w.p[1]) * w.out[1]);
            if (off > 0.6 || along > w.width / 2 + 0.25) continue;
            const fu = 1 - Math.max(0, along - w.width / 2) / 0.25;
            const fz = 1 - Math.max(0, dz) / w.length;
            const m = w.strength * fu * fz * fz;
            if (Math.abs(m) > Math.abs(wx)) wx = m;
          }
        }
        res = [ao, wx];
        cache.set(ck, res);
      }
      v[i + DETAIL_OFFSET] = res[0];
      v[i + DETAIL_OFFSET + 2] = res[1];
    }
  }
  return { vertices: n, ms: Date.now() - t0 };
}
