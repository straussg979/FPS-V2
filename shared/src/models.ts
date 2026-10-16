// What the simulation needs of the procedural weapon and gadget models (data/weapon_models.json): anchors
// (muzzle, grips) and bounds. The meshes themselves are built by the asset step.

import modelsJson from "../../data/weapon_models.json";
import type { V3 } from "./math";

/* eslint-disable @typescript-eslint/no-explicit-any */
export const MODEL_DEFS: Record<string, any> = Object.fromEntries(
  Object.entries(modelsJson as any).filter(([k]) => !k.startsWith("_")));

const boundsCache = new Map<string, { min: V3; max: V3 }>();

/** Axis-aligned bounds of a model in its own space (gun space: +Y forward, +Z up). */
export function modelBounds(key: string): { min: V3; max: V3 } {
  let b = boundsCache.get(key);
  if (b) return b;
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  const grow = (c: number[], h: number[]) => {
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], c[k] - h[k]); max[k] = Math.max(max[k], c[k] + h[k]); }
  };
  for (const p of MODEL_DEFS[key]?.parts ?? []) {
    const pos = p.pos ?? [0, 0, 0];
    if (p.shape === "box") grow(pos, (p.size as number[]).map((s) => s / 2));
    else if (p.shape === "sphere") grow(pos, [p.radius, p.radius, p.radius]);
    else if (p.shape === "cyl") {
      const r = p.radius, l = p.length / 2;
      const axis = p.axis ?? "y";
      grow(pos, axis === "x" ? [l, r, r] : axis === "z" ? [r, r, l] : [r, l, r]);
    }
  }
  if (!Number.isFinite(min[0])) { min.fill(-0.1); max.fill(0.1); }
  b = { min, max };
  boundsCache.set(key, b);
  return b;
}

export function modelRadius(key: string): number {
  return Number(MODEL_DEFS[key]?.radius ?? 0.035);
}
