// Hand-built mud brick and plaster is never straight: walls bulge and sag by a centimetre or two, tops are worn
// round, bases are thicker. This is the displacement field the building geometry is pushed through (meshbuilder
// addRoundedBox, organic_wall.ts): a smooth 3D vector field that depends only on the world position, so two faces
// that share an edge move together (no cracks), and so the client can evaluate the same field to sit a bullet hole
// on the visible surface (main.ts placeDecal). Its amplitude is chosen by collision surface type, which the client
// also knows.

import type { V3 } from "../math";

export type Displace = (p: V3) => V3;

/** Displacement amplitude (metres) by collision surface: rendered mud and plaster the most, brick a little, concrete
 *  barely. Anything else is not displaced. */
export const SURFACE_AMP: Record<string, number> = { plaster: 0.012, dirt: 0.012, brick: 0.007, concrete: 0.0025 };

function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 144665) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

/** Smooth value noise in [0, 1]. */
export function noise3(x: number, y: number, z: number, seed = 0): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const v = (dx: number, dy: number, dz: number) => hash3(ix + dx, iy + dy, iz + dz, seed);
  const x00 = v(0, 0, 0) + (v(1, 0, 0) - v(0, 0, 0)) * fx, x10 = v(0, 1, 0) + (v(1, 1, 0) - v(0, 1, 0)) * fx;
  const x01 = v(0, 0, 1) + (v(1, 0, 1) - v(0, 0, 1)) * fx, x11 = v(0, 1, 1) + (v(1, 1, 1) - v(0, 1, 1)) * fx;
  const y0 = x00 + (x10 - x00) * fy, y1 = x01 + (x11 - x01) * fy;
  return y0 + (y1 - y0) * fz;
}

/** Two octaves (0.9 m and 0.33 m), centred on zero: -1..1, mostly -0.6..0.6. */
function fbm(x: number, y: number, z: number, seed: number): number {
  return (noise3(x / 0.9, y / 0.9, z / 0.9, seed) - 0.5) * 1.5 + (noise3(x / 0.33, y / 0.33, z / 0.33, seed + 17) - 0.5) * 0.5;
}

/** The organic displacement for an amplitude (null when it is zero). */
export function organicField(amp: number, seed = 1): Displace | null {
  if (!(amp > 0)) return null;
  return (p) => [amp * fbm(p[0], p[1], p[2], seed), amp * fbm(p[0] + 31.7, p[1] - 12.1, p[2] + 5.3, seed + 3),
    amp * 0.5 * fbm(p[0] - 7.9, p[1] + 19.3, p[2] - 3.1, seed + 7)];
}

/** The field for a collision surface type (shared by the build and the client's decals). */
export function surfaceField(surface: string): Displace | null {
  return organicField(SURFACE_AMP[surface] ?? 0, 1);
}
