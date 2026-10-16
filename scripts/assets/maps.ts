// Per-map assets, built from the same level code the server simulates with (shared/src/level):
// * a GLB of the static geometry, one primitive per material, plus the light fixtures as emissive meshes;
// * the light volume: three RGBA8 3D textures on a coarse probe grid (sky visibility + sun visibility, local
//   light irradiance sqrt-encoded, its main direction), baked by marching rays through a 0.5 m occupancy
//   grid of the opaque pieces. The client's materials read it, so interiors are dark where the sky can't
//   reach and lit where the fixtures are, without dozens of real-time lights;
// * the radar image: one pixel per navmesh cell (floors by height, walls, bomb sites, breakable walls);
// * the map's own JSON (the client builds the identical collision world, panels and zones from it).

import { CollisionWorld } from "../../shared/src/collision";
import { hprMatrix, type M3, type V3 } from "../../shared/src/math";
import { Level } from "../../shared/src/level/level";
import { MeshBuilder } from "../../shared/src/level/meshbuilder";
import { NavMesh } from "../../server/src/ai/navmesh";
import { GltfBuilder } from "./glb";
import { encodePng } from "./png";

/* eslint-disable @typescript-eslint/no-explicit-any */
export const LIGHT_SCALE = 16.0;

export function kelvinToRgb(kelvin: number): [number, number, number] {
  const t = kelvin / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * (t - 60) ** -0.1332047592;
    g = 288.1221695283 * (t - 60) ** -0.0755148492;
    b = 255;
  }
  return [r, g, b].map((c) => (Math.min(Math.max(c, 0), 255) / 255) ** 2.2) as [number, number, number];
}

export function lightColor(e: any): [number, number, number] {
  const rgb = e.kelvin !== undefined ? kelvinToRgb(Number(e.kelvin)) : (e.color ?? [1, 1, 1]);
  return rgb as [number, number, number];
}

// ------------------------------------------------------------------ geometry
/** Materials of the light fittings (the build generates their textures). */
export const FIXTURE_MATERIALS = ["steel_painted", "steel", "pbr_white_rough"];

/** Real light fittings, not glowing blocks: a housing in painted steel, a stem or bracket up to the ceiling when
 *  the lamp hangs below one (found by a ray against the level), and only the part that emits light glowing -
 *  a panel's recessed diffuser, a bulkhead lamp's glass dome inside its cage, a flood's front lens. */
function fixtures(level: Level): { housing: MeshBuilder; metal: MeshBuilder; glow: Array<[MeshBuilder, number[]]> } {
  const world = new CollisionWorld(level.colliders.map((c) => ({ c: c.c, h: [c.size[0] / 2, c.size[1] / 2, c.size[2] / 2] as V3, hpr: c.hpr, surface: c.surface })));
  const housing = new MeshBuilder(), metal = new MeshBuilder();
  const glow: Array<[MeshBuilder, number[]]> = [];
  const ceilingAbove = (p: V3, top: number): number | null => {
    const hit = world.ray([p[0], p[1], top + 0.005], [p[0], p[1], top + 2.5]);
    return hit ? hit.pos[2] : null;
  };
  const stem = (p: V3, top: number) => {             // a rod and a ceiling plate when the lamp hangs below a ceiling
    const ceil = ceilingAbove(p, top);
    if (ceil === null || ceil - top < 0.03) return;
    const len = ceil - top;
    metal.addCylinder([p[0], p[1], top + len / 2], 0.012, len, 8, 1, false);
    metal.addCylinder([p[0], p[1], ceil - 0.01], 0.05, 0.02, 16);
  };
  for (const e of level.lights as any[]) {
    const style = e.fixture ?? "bulb";
    if (!style) continue;
    const rgb = lightColor(e);
    const intensity = Number(e.intensity ?? 10);
    const p = e.pos as V3;
    const lit = new MeshBuilder();
    let strength: number;
    if (style === "panel") {
      // ceiling troffer: a shallow steel tray, the diffuser recessed into its underside
      const top = p[2] + 0.06;
      housing.addChamferBox([p[0], p[1], p[2] + 0.03], [1.24, 0.34, 0.06], 0.008);
      lit.addBox([p[0], p[1], p[2] - 0.002], [1.14, 0.25, 0.006]);
      stem([p[0] - 0.45, p[1], 0] as V3, top);
      stem([p[0] + 0.45, p[1], 0] as V3, top);
      strength = Math.min(Math.max(intensity * 0.55, 3), 10);
    } else if (style === "flood") {
      // flood light: a housing on a yoke bracket, the lens facing down
      const top = p[2] + 0.22;
      housing.addChamferBox([p[0], p[1], p[2] + 0.08], [0.34, 0.26, 0.14], 0.012);
      for (const s of [-1, 1]) metal.addBox([p[0] + s * 0.185, p[1], p[2] + 0.13], [0.015, 0.04, 0.17]);
      metal.addBox([p[0], p[1], top - 0.008], [0.39, 0.04, 0.016]);
      housing.addChamferBox([p[0], p[1], p[2] + 0.005], [0.3, 0.22, 0.012], 0.004);   // bezel
      lit.addBox([p[0], p[1], p[2] - 0.003], [0.26, 0.18, 0.006]);
      stem(p, top);
      strength = Math.min(Math.max(intensity * 0.45, 6), 18);
    } else {
      // bulkhead lamp: a base, a glass dome and a cage of four ribs
      const top = p[2] + 0.1;
      housing.addCylinder([p[0], p[1], p[2] + 0.075], 0.085, 0.05, 20);
      lit.addSphere([p[0], p[1], p[2] + 0.04], 0.062, 10, 16);
      for (const a of [0, 45, 90, 135]) {
        const r = (a * Math.PI) / 180;
        metal.addBox([p[0], p[1], p[2] + 0.04], [0.15 * Math.abs(Math.cos(r)) + 0.008, 0.15 * Math.abs(Math.sin(r)) + 0.008, 0.008], [a, 0, 0]);
      }
      metal.addCylinder([p[0], p[1], p[2] + 0.005], 0.07, 0.008, 16, 1, false);
      stem(p, top);
      strength = Math.min(Math.max(intensity * 1.2, 4), 9);
    }
    glow.push([lit, rgb.map((c) => Math.round(c * strength * 1000) / 1000)]);
  }
  return { housing, metal, glow };
}

/** The level's geometry: one primitive per material in a "level" node; builders keyed "<material>@<layer>" go into a
 *  node per layer (extras.layer: the client draws "backdrop" - the far mountains - with its own camera range, fades
 *  "thin" pieces with distance and switches the "hi:<cell>" / "lo:<cell>" building-detail variants by distance). */
export function mapGlb(level: Level): Uint8Array {
  const g = new GltfBuilder();
  const layers = new Map<string, Array<[string, MeshBuilder]>>();
  for (const [key, mb] of [...level.ctx.builders.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const at = key.indexOf("@");
    const mat = at < 0 ? key : key.slice(0, at), layer = at < 0 ? "" : key.slice(at + 1);
    if (!layers.has(layer)) layers.set(layer, []);
    layers.get(layer)!.push([mat, mb]);
  }
  const children: number[] = [];
  for (const [layer, list] of layers) {
    const prims = list.map(([mat, mb]) => g.primitive(mb, mat, null, true)).filter(Boolean);
    if (!prims.length) continue;
    const name = layer ? `level:${layer}` : "level";
    children.push(g.node(name, g.mesh(name, prims), [], layer ? { layer } : null));
  }
  const fx = fixtures(level);
  if (fx.glow.length) {
    const fp = [g.primitive(fx.housing, "steel_painted"), g.primitive(fx.metal, "steel"),
      ...fx.glow.map(([mb, glow]) => g.primitive(mb, "pbr_white_rough", { emission: glow }))].filter(Boolean);
    children.push(g.node("fixtures", g.mesh("fixtures", fp)));
  }
  g.zupRoot("map", children);
  return g.toGlb();
}

// ------------------------------------------------------------------- volumes
interface Occ { occ: Uint8Array; dims: [number, number, number]; bmin: number[]; voxel: number }

function voxelize(occluders: Array<{ c: number[]; size: number[]; hpr: number[] }>, bmin: number[], bmax: number[], voxel: number): Occ {
  const dims = [0, 1, 2].map((a) => Math.max(Math.ceil((bmax[a] - bmin[a]) / voxel), 1)) as [number, number, number];
  const [nx, ny, nz] = dims;
  const occ = new Uint8Array(nx * ny * nz);
  const vc = (a: number, i: number) => bmin[a] + (i + 0.5) * voxel;
  for (const o of occluders) {
    const half = o.size.map((s) => s / 2);
    const rotated = o.hpr.some((v) => Math.abs(v) > 1e-6);
    const R: M3 = hprMatrix(o.hpr[0], o.hpr[1], o.hpr[2]);
    const ext = rotated ? [0, 1, 2].map((a) => Math.abs(R[0][a]) * half[0] + Math.abs(R[1][a]) * half[1] + Math.abs(R[2][a]) * half[2]) : half;
    const lo = [0, 1, 2].map((a) => o.c[a] - ext[a]), hi = [0, 1, 2].map((a) => o.c[a] + ext[a]);
    if (!rotated) {
      // conservative: voxels whose centre lies within a quarter voxel of the box, at least one thick
      const i0 = [0, 1, 2].map((a) => Math.max(0, Math.ceil((lo[a] - voxel * 0.25 - bmin[a]) / voxel - 0.5)));
      const i1 = [0, 1, 2].map((a, k) => Math.min(dims[a], Math.max(Math.floor((hi[a] + voxel * 0.25 - bmin[a]) / voxel - 0.5) + 1, i0[k] + 1)));
      for (let x = i0[0]; x < i1[0]; x++) for (let y = i0[1]; y < i1[1]; y++) for (let z = i0[2]; z < i1[2]; z++) occ[(z * ny + y) * nx + x] = 1;
      continue;
    }
    const i0 = [0, 1, 2].map((a) => Math.max(0, Math.floor((lo[a] - bmin[a]) / voxel)));
    const i1 = [0, 1, 2].map((a) => Math.min(dims[a], Math.ceil((hi[a] - bmin[a]) / voxel)));
    const tol = voxel * 0.3;
    for (let x = i0[0]; x < i1[0]; x++) for (let y = i0[1]; y < i1[1]; y++) for (let z = i0[2]; z < i1[2]; z++) {
      const d = [vc(0, x) - o.c[0], vc(1, y) - o.c[1], vc(2, z) - o.c[2]];
      let inside = true;
      for (let k = 0; k < 3 && inside; k++) inside = Math.abs(d[0] * R[k][0] + d[1] * R[k][1] + d[2] * R[k][2]) <= half[k] + tol;
      if (inside) occ[(z * ny + y) * nx + x] = 1;
    }
  }
  return { occ, dims, bmin, voxel };
}

/** Whether the segment a -> b (skipping `skipA` / `skipB` metres at the ends) crosses no solid voxel. */
function open(o: Occ, a: number[], b: number[], skipA: number, skipB: number): boolean {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const len = Math.hypot(dx, dy, dz);
  const step = o.voxel * 0.5;
  const [nx, ny, nz] = o.dims;
  for (let s = skipA; s < len - skipB; s += step) {
    const t = s / len;
    const ix = Math.floor((a[0] + dx * t - o.bmin[0]) / o.voxel);
    const iy = Math.floor((a[1] + dy * t - o.bmin[1]) / o.voxel);
    const iz = Math.floor((a[2] + dz * t - o.bmin[2]) / o.voxel);
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) continue;
    if (o.occ[(iz * ny + iy) * nx + ix]) return false;
  }
  return true;
}

function hemisphereDirs(n: number): number[][] {
  const out: number[][] = [];
  for (let k = 0; k < n; k++) {
    const u1 = (k + 0.5) / n, u2 = ((k + 0.5) * 0.6180339887) % 1;
    const r = Math.sqrt(u1), phi = 2 * Math.PI * u2;
    out.push([r * Math.cos(phi), r * Math.sin(phi), Math.sqrt(1 - u1)]);
  }
  return out;
}

export interface VolumeInfo { dims: number[]; min: number[]; spacing: number[]; layers: string[]; light_scale: number }

export function bakeVolumes(level: Level, log: (m: string) => void): { blob: Uint8Array; info: VolumeInfo } {
  const t0 = Date.now();
  const data = level.data;
  const [bmin, bmax] = data.bounds as number[][];
  const sp: number[] = data.skyvis_spacing ?? [1.5, 1.5, 1.0];
  const o = voxelize(level.ctx.occluders, bmin, bmax, 0.5);
  const pd = [0, 1, 2].map((a) => Math.max(Math.round((bmax[a] - bmin[a]) / sp[a]), 1));
  const [px, py, pz] = pd;
  const n = px * py * pz;
  const probe = (i: number) => {
    const x = i % px, y = Math.floor(i / px) % py, z = Math.floor(i / (px * py));
    return [bmin[0] + (x + 0.5) * sp[0], bmin[1] + (y + 0.5) * sp[1], bmin[2] + (z + 0.5) * sp[2]];
  };
  const env = data.environment ?? {};
  let sun = env.sun_dir ?? [0.45, -0.55, 0.7];
  const sl = Math.hypot(sun[0], sun[1], sun[2]);
  sun = sun.map((v: number) => v / sl);
  let side = [sun[1], -sun[0], 0];
  const sdl = Math.hypot(side[0], side[1]) || 1;
  side = side.map((v) => v / sdl);
  const up = [side[1] * sun[2] - side[2] * sun[1], side[2] * sun[0] - side[0] * sun[2], side[0] * sun[1] - side[1] * sun[0]];
  const sunDirs = [[0, 0], [0.03, 0], [-0.03, 0], [0, 0.03], [0, -0.03]].map(([a, b]) => {
    const d = [0, 1, 2].map((k) => sun[k] + side[k] * a + up[k] * b);
    const l = Math.hypot(d[0], d[1], d[2]);
    return d.map((v) => v / l);
  });
  const dirs = hemisphereDirs(32);
  const sky = new Float32Array(n), sunv = new Float32Array(n);
  const irr = new Float32Array(n * 3), dir = new Float32Array(n * 3);
  const buried = new Uint8Array(n);
  const [nx, ny] = o.dims;
  for (let i = 0; i < n; i++) {
    const p = probe(i);
    const ix = Math.floor((p[0] - bmin[0]) / o.voxel), iy = Math.floor((p[1] - bmin[1]) / o.voxel), iz = Math.floor((p[2] - bmin[2]) / o.voxel);
    if (ix >= 0 && iy >= 0 && iz >= 0 && ix < nx && iy < ny && iz < o.dims[2] && o.occ[(iz * ny + iy) * nx + ix]) buried[i] = 1;
    let esc = 0;
    for (const d of dirs) if (open(o, p, [p[0] + d[0] * 40, p[1] + d[1] * 40, p[2] + d[2] * 40], 0.3, 0)) esc++;
    sky[i] = esc / dirs.length;
    let sv = 0;
    for (const d of sunDirs) if (open(o, p, [p[0] + d[0] * 60, p[1] + d[1] * 60, p[2] + d[2] * 60], 0.3, 0)) sv++;
    sunv[i] = sv / sunDirs.length;
  }
  for (const e of level.lights) {
    const pos = e.pos as number[];
    const range = Number(e.range ?? 10);
    const col = lightColor(e).map((c) => c * Number(e.intensity ?? 10));
    const mean = (col[0] + col[1] + col[2]) / 3;
    const sd = e.dir ? (() => { const l = Math.hypot(e.dir[0], e.dir[1], e.dir[2]) || 1; return e.dir.map((v: number) => v / l); })() : [0, 0, -1];
    const lo = Math.cos(Number(e.outer ?? 40) * Math.PI / 180), hi = Math.cos(Number(e.inner ?? 25) * Math.PI / 180);
    const x0 = Math.max(0, Math.floor((pos[0] - range - bmin[0]) / sp[0])), x1 = Math.min(px - 1, Math.ceil((pos[0] + range - bmin[0]) / sp[0]));
    const y0 = Math.max(0, Math.floor((pos[1] - range - bmin[1]) / sp[1])), y1 = Math.min(py - 1, Math.ceil((pos[1] + range - bmin[1]) / sp[1]));
    const z0 = Math.max(0, Math.floor((pos[2] - range - bmin[2]) / sp[2])), z1 = Math.min(pz - 1, Math.ceil((pos[2] + range - bmin[2]) / sp[2]));
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = (z * py + y) * px + x;
      const p = probe(i);
      const dl = [pos[0] - p[0], pos[1] - p[1], pos[2] - p[2]];
      const dist = Math.hypot(dl[0], dl[1], dl[2]);
      if (dist >= range) continue;
      let atten = Math.max(0, Math.min(1, 1 - (dist / range) ** 4)) ** 2 / (dist * dist + 1);
      const L = dl.map((v) => v / Math.max(dist, 1e-6));
      if (e.kind === "spot") {
        const cd = -(L[0] * sd[0] + L[1] * sd[1] + L[2] * sd[2]);
        const t = Math.max(0, Math.min(1, (cd - lo) / Math.max(hi - lo, 1e-4)));
        atten *= t * t * (3 - 2 * t);
      }
      if (atten <= 0 || !open(o, p, pos, 0.25, 0.45)) continue;
      for (let k = 0; k < 3; k++) {
        irr[i * 3 + k] += atten * col[k];
        dir[i * 3 + k] += L[k] * atten * mean;
      }
    }
  }
  // probes inside solid geometry take their open neighbours' values
  const fields = [sky, sunv];
  for (let pass = 0; pass < 3; pass++) {
    const fill: Array<[number, number[]]> = [];
    for (let i = 0; i < n; i++) {
      if (!buried[i]) continue;
      const x = i % px, y = Math.floor(i / px) % py, z = Math.floor(i / (px * py));
      const acc = new Array(2 + 6).fill(0);
      let cnt = 0;
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const xx = (x + dx + px) % px, yy = (y + dy + py) % py, zz = (z + dz + pz) % pz;
        const j = (zz * py + yy) * px + xx;
        if (buried[j]) continue;
        cnt++;
        acc[0] += sky[j]; acc[1] += sunv[j];
        for (let k = 0; k < 3; k++) { acc[2 + k] += irr[j * 3 + k]; acc[5 + k] += dir[j * 3 + k]; }
      }
      if (cnt) fill.push([i, acc.map((v) => v / cnt)]);
    }
    if (!fill.length) break;
    for (const [i, a] of fill) {
      fields[0][i] = a[0]; fields[1][i] = a[1];
      for (let k = 0; k < 3; k++) { irr[i * 3 + k] = a[2 + k]; dir[i * 3 + k] = a[5 + k]; }
      buried[i] = 0;
    }
  }
  const u8 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  const blob = new Uint8Array(n * 4 * 3);
  for (let i = 0; i < n; i++) {
    blob.set([u8(sky[i]), u8(sunv[i]), 0, 255], i * 4);
    blob.set([u8(Math.sqrt(irr[i * 3] / LIGHT_SCALE)), u8(Math.sqrt(irr[i * 3 + 1] / LIGHT_SCALE)), u8(Math.sqrt(irr[i * 3 + 2] / LIGHT_SCALE)), 255], n * 4 + i * 4);
    let d = [dir[i * 3], dir[i * 3 + 1], dir[i * 3 + 2]];
    const l = Math.hypot(d[0], d[1], d[2]);
    d = l > 1e-9 ? d.map((v) => v / l) : [0, 0, -1];
    blob.set([u8(d[0] * 0.5 + 0.5), u8(d[1] * 0.5 + 0.5), u8(d[2] * 0.5 + 0.5), 255], n * 8 + i * 4);
  }
  log(`[assets] ${level.mapKey}: light volume ${px}x${py}x${pz} (${level.lights.length} lights) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { blob, info: { dims: pd, min: bmin, spacing: sp, layers: ["sky_sun", "light", "light_dir"], light_scale: LIGHT_SCALE } };
}

// --------------------------------------------------------------------- radar
const FLOOR = [0.34, 0.37, 0.35], UPPER = [0.52, 0.55, 0.50], LOWER = [0.20, 0.24, 0.32], TUNNEL = [0.30, 0.38, 0.52];
const WALL = [0.80, 0.82, 0.76], PANEL = [0.72, 0.46, 0.22], SITE = [0.85, 0.22, 0.16];

export function radarPng(level: Level, nav: NavMesh): { png: Uint8Array; info: Record<string, number> } {
  const { nx, ny } = nav;
  const cs = nav.cfg.cell;
  const ncols = nx * ny;
  const count = new Uint16Array(ncols), ztop = new Float32Array(ncols).fill(-Infinity), zlow = new Float32Array(ncols).fill(Infinity);
  for (let k = 0; k < nav.nodeCount; k++) {
    const c = nav.nodeCol[k];
    count[c]++;
    ztop[c] = Math.max(ztop[c], nav.nodeZ[k]);
    zlow[c] = Math.min(zlow[c], nav.nodeZ[k]);
  }
  const img = new Float32Array(ncols * 4);
  for (let c = 0; c < ncols; c++) {
    img[c * 4 + 3] = 0.55;
    if (!count[c]) continue;
    const t = Math.max(0, Math.min(1, ztop[c] / 4));
    let col = [0, 1, 2].map((k) => FLOOR[k] * (1 - t) + UPPER[k] * t);
    const under = ztop[c] < -0.6;
    if (under) col = LOWER;
    else if (count[c] > 1 && ztop[c] - zlow[c] > 2) col = col.map((v, k) => v * 0.4 + TUNNEL[k] * 0.6);
    img.set([...col, 0.92], c * 4);
  }
  const walk = (i: number, j: number) => count[((j + ny) % ny) * nx + ((i + nx) % nx)] > 0;
  const xs = (i: number) => nav.x0 + (i + 0.5) * cs, ys = (j: number) => nav.y0 + (j + 0.5) * cs;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const c = j * nx + i;
    if (count[c]) {
      for (const z of level.zones) {
        if (z.kind !== "bombsite") continue;
        const x = xs(i), y = ys(j);
        if (x >= z.min[0] && x <= z.max[0] && y >= z.min[1] && y <= z.max[1]) for (let k = 0; k < 3; k++) img[c * 4 + k] = img[c * 4 + k] * 0.6 + SITE[k] * 0.4;
      }
      continue;
    }
    let near = false;
    for (let dj = -1; dj <= 1 && !near; dj++) for (let di = -1; di <= 1 && !near; di++) near = walk(i + di, j + dj);
    if (near) img.set([...WALL, 0.95], c * 4);
  }
  for (const p of level.panelSpecs) {
    if (p.kind !== "wall") continue;
    const h = (p.hpr?.[0] ?? 0) * Math.PI / 180;
    const hx = Math.max(p.size[0] / 2, cs * 0.6), hy = Math.max(p.size[1] / 2, cs * 0.6);
    const r = Math.hypot(hx, hy);
    const i0 = Math.max(0, Math.trunc((p.center[0] - r - nav.x0) / cs)), i1 = Math.min(nx, Math.trunc((p.center[0] + r - nav.x0) / cs) + 1);
    const j0 = Math.max(0, Math.trunc((p.center[1] - r - nav.y0) / cs)), j1 = Math.min(ny, Math.trunc((p.center[1] + r - nav.y0) / cs) + 1);
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
      const dx = xs(i) - p.center[0], dy = ys(j) - p.center[1];
      const lx = dx * Math.cos(h) + dy * Math.sin(h), ly = -dx * Math.sin(h) + dy * Math.cos(h);
      if (Math.abs(lx) <= hx && Math.abs(ly) <= hy) img.set([...PANEL, 0.95], (j * nx + i) * 4);
    }
  }
  // PNG rows top to bottom: north (high j) first
  const px = new Uint8Array(ncols * 4);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const src = (j * nx + i) * 4, dst = ((ny - 1 - j) * nx + i) * 4;
    for (let k = 0; k < 4; k++) px[dst + k] = Math.round(Math.max(0, Math.min(1, img[src + k])) * 255);
  }
  return { png: encodePng(px, nx, ny, 4), info: { x0: nav.x0, y0: nav.y0, cell: cs, nx, ny } };
}

/** The lights as the client needs them: position, linear colour x intensity, range, spot cone. */
export function clientLights(level: Level): any[] {
  return level.lights.map((e) => ({ pos: e.pos, color: lightColor(e).map((c) => c * Number(e.intensity ?? 10)), range: Number(e.range ?? 10),
    kind: e.kind ?? "point", dir: e.dir ?? null, outer: e.outer ?? 40, inner: e.inner ?? 25 }));
}
