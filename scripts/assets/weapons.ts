// Weapon and gadget models (data/weapon_models.json) as GLBs: bevelled boxes, cylinders and spheres batched
// per (animation group, material), one node per group (body, mag, bolt, slide, pump) so the viewmodel can
// animate them; glowing parts (sight reticles, LEDs) carry their emission as material extras.

import { materialInfo } from "../../shared/src/data";
import { MeshBuilder } from "../../shared/src/level/meshbuilder";
import type { V3 } from "../../shared/src/math";
import { GltfBuilder } from "./glb";

/* eslint-disable @typescript-eslint/no-explicit-any */
const AXIS_HPR: Record<string, V3> = { x: [0, 0, 90], y: [0, -90, 0], z: [0, 0, 0] };

export function modelMaterials(defs: Record<string, any>): Set<string> {
  const out = new Set(["glove", "sleeve_camo", "pbr_white_rough", "gun_metal"]);
  for (const d of Object.values(defs)) for (const p of d.parts) out.add(p.mat ?? "gun_metal");
  return out;
}

export function weaponGlb(key: string, d: any): Uint8Array {
  const builders = new Map<string, MeshBuilder>();
  const emissive: Array<[any, MeshBuilder]> = [];
  for (const part of d.parts) {
    const group = part.group ?? "body", mat = part.mat ?? "gun_metal";
    let mb: MeshBuilder;
    if (part.emit) {
      mb = new MeshBuilder();
      emissive.push([part, mb]);
    } else {
      const k = `${group}\u0000${mat}`;
      mb = builders.get(k) ?? new MeshBuilder();
      builders.set(k, mb);
    }
    const uv = materialInfo(mat).uvScale;
    if (part.shape === "box") mb.addChamferBox(part.pos, part.size, part.bevel ?? 0.004, part.hpr ?? [0, 0, 0], uv);
    else if (part.shape === "cyl") {
      const r = part.radius;
      mb.addCylinder(part.pos, r, part.length, Math.max(10, Math.min(28, Math.trunc(r * 900))), uv, true, AXIS_HPR[part.axis ?? "y"]);
    } else if (part.shape === "sphere") {
      const r = part.radius;
      mb.addSphere(part.pos, r, r < 0.02 ? 10 : 16, r < 0.02 ? 16 : 28, uv);
    }
  }
  const g = new GltfBuilder();
  const byGroup = new Map<string, any[]>();
  for (const [k, mb] of [...builders.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const [group, mat] = k.split("\u0000");
    const p = g.primitive(mb, mat);
    if (p) byGroup.set(group, [...(byGroup.get(group) ?? []), p]);
  }
  for (const [part, mb] of emissive) {
    const p = g.primitive(mb, part.mat ?? "pbr_white_rough", { emission: part.emit.slice(0, 3) });
    const group = part.group ?? "body";
    if (p) byGroup.set(group, [...(byGroup.get(group) ?? []), p]);
  }
  const nodes = [...byGroup.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([group, prims]) => g.node(group, g.mesh(`${key}:${group}`, prims)));
  g.zupRoot(key, nodes, { anchors: d.anchors ?? {} });
  return g.toGlb();
}
