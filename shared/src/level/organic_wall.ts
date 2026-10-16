// The drawn surface of a wall with openings, built as one watertight, rounded and slightly organic shell (the
// colliders stay the plain rectangles wall() always made; this is visual only).
//
// The wall's solid region (rectangles in the wall's own u / z plane, extruded through its thickness) is cut into a
// grid. The grid's lines are every rectangle boundary, extra lines beside every exposed edge for the rounding, and
// a regular spacing for the displacement; because every cell shares the same lines, neighbouring cells meet vertex
// to vertex (no T-junctions, so no hairline cracks of light at the joins). Each solid cell emits its outer faces.
//
// Rounding is one global function of position: the solid eroded by the radius r away from its exposed edges (the
// openings, the free ends, an exposed top; never the foot), and every surface point pushed back onto the eroded
// solid's offset: p' = q + r (p - q) / |p - q| with q the nearest point of the eroded solid. Convex edges (a door
// jamb meeting the wall face, the crown of a wall) become quarter circles, and since the function only depends on
// position, faces of different cells that share a vertex move it identically. The drawn surface never leaves the
// collider box except by the few millimetres of displacement, so players and bullets meet what they see. Then the
// organic displacement field (organic.ts) gives the gentle bulges, a slight lean-in toward the top (taper) and an
// uneven crown on exposed tops.

import { hprMatrix, type M3, type V3 } from "../math";
import { FLOATS_PER_VERTEX, MeshBuilder } from "./meshbuilder";
import { type Displace, noise3 } from "./organic";

export interface OrganicWallSpec {
  /** Wall start on its centre line (world), its heading (degrees, the u axis), its base height. */
  origin: V3;
  heading: number;
  length: number;
  thickness: number;
  /** Solid rectangles [u0, u1, z0, z1] (z from the wall's base). */
  rects: Array<[number, number, number, number]>;
  /** Material of the +w side and the edges, and of the -w side. */
  mat: MeshBuilder;
  mat2: MeshBuilder;
  uvScale: number;
  uvScale2: number;
  exposed: { top: boolean; start: boolean; end: boolean };
  radius: number;
  step: number;
  displace: Displace | null;
  /** Crown: up to this much uneven height (metres) along an exposed top; taper: this much lean-in at the top. */
  crown?: number;
  taper?: number;
}

type Seg = { a: [number, number]; b: [number, number]; n: [number, number] };

export function organicWall(s: OrganicWallSpec): void {
  const L = s.length, t = s.thickness, ht = t / 2;
  const r = Math.max(0, Math.min(s.radius, ht * 0.9, 0.5));
  const R: M3 = hprMatrix(s.heading, 0, 0);
  const zTop = Math.max(...s.rects.map((q) => q[3]));
  const band = r > 0 ? [r, r * (1 - Math.tan(Math.PI / 8))] : [];
  const uniq = (c: number[], lo: number, hi: number) => {
    const out: number[] = [];
    for (const x of c.filter((v) => v >= lo - 1e-9 && v <= hi + 1e-9).sort((a, b) => a - b)) if (!out.length || x - out[out.length - 1] > 2e-4) out.push(x);
    return out;
  };
  // phase 1: the grid of the rectangle boundaries alone tells which edges are exposed
  const baseU: number[] = [0, L], baseZ: number[] = [0, zTop];
  for (const [u0, u1, z0, z1] of s.rects) { baseU.push(u0, u1); baseZ.push(z0, z1); }
  let us = uniq(baseU, 0, L), zs = uniq(baseZ, 0, zTop);
  let nu = 0, nz = 0;
  let solid = new Uint8Array(0);
  const build = () => {
    nu = us.length - 1; nz = zs.length - 1;
    solid = new Uint8Array(nu * nz);
    for (let i = 0; i < nu; i++) for (let j = 0; j < nz; j++) {
      const uc = (us[i] + us[i + 1]) / 2, zc = (zs[j] + zs[j + 1]) / 2;
      solid[i * nz + j] = s.rects.some(([u0, u1, z0, z1]) => uc > u0 && uc < u1 && zc > z0 && zc < z1) ? 1 : 0;
    }
  };
  build();
  const at = (i: number, j: number) => (i >= 0 && j >= 0 && i < nu && j < nz ? solid[i * nz + j] : -1);
  const exposedSide = (i: number, j: number, di: number, dj: number): boolean => {
    const nb = at(i + di, j + dj);
    if (nb === 0) return true;
    if (nb === 1) return false;
    if (dj === -1) return false;                                // the foot: never
    if (dj === 1) return s.exposed.top;
    return di === -1 ? s.exposed.start : s.exposed.end;
  };
  // phase 2: rounding bands only beside exposed edges (inside the solid), plus the regular spacing
  const uC = [...us], zC = [...zs];
  for (let i = 0; i < nu; i++) for (let j = 0; j < nz; j++) {
    if (!at(i, j)) continue;
    for (const d of band) {
      if (exposedSide(i, j, -1, 0)) uC.push(us[i] + d);
      if (exposedSide(i, j, 1, 0)) uC.push(us[i + 1] - d);
      if (exposedSide(i, j, 0, -1)) zC.push(zs[j] + d);
      if (exposedSide(i, j, 0, 1)) zC.push(zs[j + 1] - d);
    }
  }
  const stepCuts = (lo: number, hi: number, c: number[]) => { const n = Math.ceil((hi - lo) / s.step); for (let i = 1; i < n; i++) c.push(lo + (hi - lo) * i / n); };
  if (s.step > 0) { stepCuts(0, L, uC); stepCuts(0, zTop, zC); }
  us = uniq(uC, 0, L); zs = uniq(zC, 0, zTop);
  build();
  const ws = uniq([-ht, ht, ...band.flatMap((d) => [-ht + d, ht - d])], -ht, ht);
  // exposed boundary segments of the solid region (cell sides facing empty cells or exposed bounds), merged
  const segs: Seg[] = [];
  const push = (a: [number, number], b: [number, number], n: [number, number]) => {
    const last = segs[segs.length - 1];
    if (last && last.n[0] === n[0] && last.n[1] === n[1] && Math.abs(last.b[0] - a[0]) < 1e-9 && Math.abs(last.b[1] - a[1]) < 1e-9) last.b = b;
    else segs.push({ a, b, n });
  };
  for (const [di, dj] of [[-1, 0], [1, 0]]) for (let i = 0; i < nu; i++) for (let j = 0; j < nz; j++) {
    if (!at(i, j) || !exposedSide(i, j, di, dj)) continue;
    const u = di < 0 ? us[i] : us[i + 1];
    push([u, zs[j]], [u, zs[j + 1]], [-di, 0]);               // n: inward normal (into the solid)
  }
  for (const [di, dj] of [[0, -1], [0, 1]]) for (let j = 0; j < nz; j++) for (let i = 0; i < nu; i++) {
    if (!at(i, j) || !exposedSide(i, j, di, dj)) continue;
    const z = dj < 0 ? zs[j] : zs[j + 1];
    push([us[i], z], [us[i + 1], z], [0, -dj]);
  }
  // the global rounding: local (u, w, z) -> rounded local position and normal
  const roundLocal = (u: number, w: number, z: number): { p: V3; n: V3 | null } => {
    if (r <= 0) return { p: [u, w, z], n: null };
    let best = Infinity, bu = 0, bz = 0, tnx = 0, tnz = 0;
    for (const sg of segs) {
      const ax = sg.a[0], az = sg.a[1], bx = sg.b[0], bzz = sg.b[1];
      const dx = bx - ax, dz = bzz - az, l2 = dx * dx + dz * dz;
      const k = l2 > 0 ? Math.max(0, Math.min(1, ((u - ax) * dx + (z - az) * dz) / l2)) : 0;
      const px = ax + dx * k, pz = az + dz * k;
      const d = Math.hypot(u - px, z - pz);
      if (d < best - 1e-7) { best = d; bu = px; bz = pz; tnx = sg.n[0]; tnz = sg.n[1]; }
      else if (Math.abs(d - best) <= 1e-7) { tnx += sg.n[0]; tnz += sg.n[1]; }
    }
    let qu = u, qz = z;
    if (best < r) {
      let gx: number, gz: number;
      if (best > 1e-7) { gx = (u - bu) / best; gz = (z - bz) / best; } else { const l = Math.hypot(tnx, tnz) || 1; gx = tnx / l; gz = tnz / l; }
      qu = u + gx * (r - best);
      qz = z + gz * (r - best);
    }
    const qw = Math.max(-ht + r, Math.min(ht - r, w));
    const dx = u - qu, dw = w - qw, dz = z - qz;
    const len = Math.hypot(dx, dw, dz);
    if (len < 1e-9) return { p: [u, w, z], n: null };
    return { p: [qu + dx / len * r, qw + dw / len * r, qz + dz / len * r], n: [dx / len, dw / len, dz / len] };
  };
  const toWorld = (l: V3): V3 => [s.origin[0] + l[0] * R[0][0] + l[1] * R[1][0] + l[2] * R[2][0],
    s.origin[1] + l[0] * R[0][1] + l[1] * R[1][1] + l[2] * R[2][1], s.origin[2] + l[0] * R[0][2] + l[1] * R[1][2] + l[2] * R[2][2]];
  const dirW = (l: V3): V3 => [l[0] * R[0][0] + l[1] * R[1][0] + l[2] * R[2][0], l[0] * R[0][1] + l[1] * R[1][1] + l[2] * R[2][1], l[0] * R[0][2] + l[1] * R[1][2] + l[2] * R[2][2]];
  const wAxis = dirW([0, 1, 0]);
  const crown = s.crown ?? 0, taper = s.taper ?? 0;
  const D = (p: V3): V3 => {
    const d: V3 = s.displace ? s.displace(p) : [0, 0, 0];
    const zl = p[2] - s.origin[2];
    if (taper > 0 && zTop > 0) {
      // lean in toward the top on both faces (the foot keeps the collider's width)
      const wl = (p[0] - s.origin[0]) * wAxis[0] + (p[1] - s.origin[1]) * wAxis[1];
      const k = -Math.sign(wl) * taper * Math.min(1, Math.max(0, zl / zTop)) * Math.min(1, Math.abs(wl) / Math.max(ht, 1e-3));
      d[0] += wAxis[0] * k; d[1] += wAxis[1] * k;
    }
    if (crown > 0 && s.exposed.top && zl > zTop - 0.2) {
      const f = Math.min(1, (zl - (zTop - 0.2)) / 0.2);
      d[2] -= crown * f * noise3(p[0] * 1.3, p[1] * 1.3, 5.5, 23);
    }
    return d;
  };
  const eps = 0.02;
  // recording: the two batches are one group, the rectangles are the solid volume
  const rec = MeshBuilder.recorder;
  const prevGroup = MeshBuilder.group;
  if (rec) MeshBuilder.group = rec.shapes.length;
  const tok1 = s.mat.beginShape();
  const tok2 = s.mat2 === s.mat ? -2 : s.mat2.beginShape();
  for (const [u0, u1, z0, z1] of s.rects) {
    const c = toWorld([(u0 + u1) / 2, 0, (z0 + z1) / 2]);
    s.mat.recordBox(c, [(u1 - u0) / 2, ht, (z1 - z0) / 2], R);
  }
  /** One face: a grid over (a-cuts x b-cuts) at fixed coordinate `fix` on axis `axisN` with outward sign `sn`. */
  const face = (axisN: 0 | 1 | 2, sn: number, fix: number, axisA: 0 | 1 | 2, aCuts: number[], axisB: 0 | 1 | 2, bCuts: number[]) => {
    const mb = axisN === 1 && sn < 0 ? s.mat2 : s.mat;
    const uvScale = mb === s.mat2 && mb !== s.mat ? s.uvScale2 : s.uvScale;
    const nL: V3 = [0, 0, 0]; nL[axisN] = sn;
    const aL: V3 = [0, 0, 0]; aL[axisA] = 1;
    const bL: V3 = [0, 0, 0]; bL[axisB] = 1;
    const cr: V3 = [aL[1] * bL[2] - aL[2] * bL[1], aL[2] * bL[0] - aL[0] * bL[2], aL[0] * bL[1] - aL[1] * bL[0]];
    const flip = cr[0] * nL[0] + cr[1] * nL[1] + cr[2] * nL[2] < 0;
    const tw = dirW(aL), bw = dirW(bL), nw = dirW(nL);
    const base = mb.vertexCount, i0 = mb.indices.length;
    for (const bv of bCuts) for (const av of aCuts) {
      const l: V3 = [0, 0, 0];
      l[axisN] = fix; l[axisA] = av; l[axisB] = bv;
      const flatW = toWorld(l);
      const rl = roundLocal(l[0], l[1], l[2]);
      const pw = toWorld(rl.p);
      let n = rl.n ? dirW(rl.n) : nw;
      let tt = tw;
      if (rl.n) {
        const td = tt[0] * n[0] + tt[1] * n[1] + tt[2] * n[2];
        let x: V3 = [tt[0] - n[0] * td, tt[1] - n[1] * td, tt[2] - n[2] * td];
        let xl = Math.hypot(x[0], x[1], x[2]);
        if (xl < 0.3) { x = [bw[1] * n[2] - bw[2] * n[1], bw[2] * n[0] - bw[0] * n[2], bw[0] * n[1] - bw[1] * n[0]]; xl = Math.hypot(x[0], x[1], x[2]) || 1; }
        tt = [x[0] / xl, x[1] / xl, x[2] / xl];
      }
      let b: V3 = [n[1] * tt[2] - n[2] * tt[1], n[2] * tt[0] - n[0] * tt[2], n[0] * tt[1] - n[1] * tt[0]];
      const d0 = D(pw);
      const dtp = D([pw[0] + tt[0] * eps, pw[1] + tt[1] * eps, pw[2] + tt[2] * eps]), dtm = D([pw[0] - tt[0] * eps, pw[1] - tt[1] * eps, pw[2] - tt[2] * eps]);
      const dbp = D([pw[0] + b[0] * eps, pw[1] + b[1] * eps, pw[2] + b[2] * eps]), dbm = D([pw[0] - b[0] * eps, pw[1] - b[1] * eps, pw[2] - b[2] * eps]);
      const Pt: V3 = [tt[0] + (dtp[0] - dtm[0]) / (2 * eps), tt[1] + (dtp[1] - dtm[1]) / (2 * eps), tt[2] + (dtp[2] - dtm[2]) / (2 * eps)];
      const Pb: V3 = [b[0] + (dbp[0] - dbm[0]) / (2 * eps), b[1] + (dbp[1] - dbm[1]) / (2 * eps), b[2] + (dbp[2] - dbm[2]) / (2 * eps)];
      let nn: V3 = [Pt[1] * Pb[2] - Pt[2] * Pb[1], Pt[2] * Pb[0] - Pt[0] * Pb[2], Pt[0] * Pb[1] - Pt[1] * Pb[0]];
      const nl = Math.hypot(nn[0], nn[1], nn[2]) || 1;
      nn = [nn[0] / nl, nn[1] / nl, nn[2] / nl];
      if (nn[0] * n[0] + nn[1] * n[1] + nn[2] * n[2] < 0) nn = [-nn[0], -nn[1], -nn[2]];
      n = nn;
      const ptl = Math.hypot(Pt[0], Pt[1], Pt[2]) || 1;
      tt = [Pt[0] / ptl, Pt[1] / ptl, Pt[2] / ptl];
      b = [n[1] * tt[2] - n[2] * tt[1], n[2] * tt[0] - n[0] * tt[2], n[0] * tt[1] - n[1] * tt[0]];
      const uu = (flatW[0] * tw[0] + flatW[1] * tw[1] + flatW[2] * tw[2]) / uvScale, vv = (flatW[0] * bw[0] + flatW[1] * bw[1] + flatW[2] * bw[2]) / uvScale;
      mb.vertex([pw[0] + d0[0], pw[1] + d0[1], pw[2] + d0[2]], n, tt, b, flip ? -uu : uu, vv);
    }
    const na = aCuts.length;
    const V = mb.verts, F = FLOATS_PER_VERTEX;
    const tri = (a: number, bb: number, c: number) => {
      const ax = V[bb * F] - V[a * F], ay = V[bb * F + 1] - V[a * F + 1], az = V[bb * F + 2] - V[a * F + 2];
      const bx = V[c * F] - V[a * F], by = V[c * F + 1] - V[a * F + 1], bz = V[c * F + 2] - V[a * F + 2];
      const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
      if (cx * cx + cy * cy + cz * cz <= 1e-14) return;
      if (flip) mb.indices.push(a, c, bb); else mb.indices.push(a, bb, c);
    };
    for (let j = 0; j < bCuts.length - 1; j++) for (let i = 0; i < na - 1; i++) {
      const a = base + j * na + i, bb = a + 1, c = a + na + 1, d = a + na;
      tri(a, bb, c);
      tri(a, c, d);
    }
    const corner = (ia: number, ib: number): V3 => { const l: V3 = [0, 0, 0]; l[axisN] = fix; l[axisA] = aCuts[ia]; l[axisB] = bCuts[ib]; return toWorld(l); };
    const la = aCuts.length - 1, lb = bCuts.length - 1;
    const poly = flip ? [corner(0, 0), corner(0, lb), corner(la, lb), corner(la, 0)] : [corner(0, 0), corner(la, 0), corner(la, lb), corner(0, lb)];
    mb.recordFace(nw, poly, i0);
  };
  for (let i = 0; i < nu; i++) for (let j = 0; j < nz; j++) {
    if (!at(i, j)) continue;
    const ua = [us[i], us[i + 1]], za = [zs[j], zs[j + 1]];
    face(1, 1, ht, 0, ua, 2, za);                               // +w face
    face(1, -1, -ht, 0, ua, 2, za);                             // -w face
    if (at(i - 1, j) !== 1) face(0, -1, us[i], 1, ws, 2, za);
    if (at(i + 1, j) !== 1) face(0, 1, us[i + 1], 1, ws, 2, za);
    if (at(i, j - 1) !== 1) face(2, -1, zs[j], 0, ua, 1, ws);
    if (at(i, j + 1) !== 1) face(2, 1, zs[j + 1], 0, ua, 1, ws);
  }
  s.mat.endShape(tok1);
  if (tok2 !== -2) s.mat2.endShape(tok2);
  MeshBuilder.group = prevGroup;
}
