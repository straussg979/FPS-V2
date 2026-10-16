// The game skeleton shared by every soldier (47 bones). The character faces +Y, Z is up and the origin is
// between the feet. Matrices are row-vector 4x4s (math.ts): a child's model matrix is local * parent.
//
//   root (death fall pivot at the feet)
//    +-> pelvis -> spine_01 -> spine_02 -> spine_03 -> neck -> head
//    |                                       +-> clavicle -> upperarm -> lowerarm -> hand -> 3 finger chains
//    |                                       +-> weapon, pack
//    +-> thigh -> calf -> foot -> toe          (both legs hang off the pelvis)
//
// Bone axes: the spine, neck and head point up (+Z); the arms, hands and fingers run along +Y of their
// frame, the legs down (-Z), the feet forward (+Y). The rest pose is an A-pose.

import { type M4, type V3, m4InvAffine, m4Mul, m4PosHpr } from "./math";

export interface Bone { name: string; parent: string; pos: V3; hpr: V3 }

export const UPPER_ARM = 0.30;
export const LOWER_ARM = 0.25;
export const PALM = 0.07;
export const STAND_PELVIS = 0.90;
const A_POSE = 40.0;
const D = Math.PI / 180;

function segHpr(d: V3): V3 {
  return [Math.atan2(-d[0], d[1]) / D, Math.atan2(d[2], Math.hypot(d[0], d[1])) / D, 0];
}

/** Heading, pitch, roll that aim local +Y along d (no roll). */
export const aimHpr = segHpr;

function arm(side: string, sx: number): Bone[] {
  const t = -sx;
  const a = A_POSE * D;
  const armHpr = segHpr([Math.sin(a) * sx, 0.05, -Math.cos(a)]);
  const bones: Bone[] = [
    { name: `clavicle_${side}`, parent: "spine_03", pos: [0.03 * sx, 0, 0.22], hpr: [0, 0, 0] },
    { name: `upperarm_${side}`, parent: `clavicle_${side}`, pos: [0.18 * sx, 0, 0.02], hpr: armHpr },
    { name: `upperarm_twist_${side}`, parent: `upperarm_${side}`, pos: [0, UPPER_ARM * 0.5, 0], hpr: [0, 0, 0] },
    { name: `lowerarm_${side}`, parent: `upperarm_${side}`, pos: [0, UPPER_ARM, 0], hpr: [0, 0, 0] },
    { name: `lowerarm_twist_${side}`, parent: `lowerarm_${side}`, pos: [0, LOWER_ARM * 0.5, 0], hpr: [0, 0, 0] },
    { name: `hand_${side}`, parent: `lowerarm_${side}`, pos: [0, LOWER_ARM, 0], hpr: [0, 0, 0] },
  ];
  const chains: Array<[string, V3, V3, [number, number]]> = [
    ["thumb", [0.024 * t, 0.025, -0.012], [-28 * t, 0, 0], [0.040, 0.032]],
    ["index", [0.022 * t, 0.088, 0], [0, 0, 0], [0.045, 0.026]],
    ["fingers", [-0.012 * t, 0.090, 0], [0, 0, 0], [0.046, 0.029]],
  ];
  for (const [name, root, hpr, [l1, l2]] of chains) {
    bones.push({ name: `${name}_01_${side}`, parent: `hand_${side}`, pos: root, hpr });
    bones.push({ name: `${name}_02_${side}`, parent: `${name}_01_${side}`, pos: [0, l1, 0], hpr: [0, 0, 0] });
    bones.push({ name: `${name}_03_${side}`, parent: `${name}_02_${side}`, pos: [0, l2, 0], hpr: [0, 0, 0] });
  }
  return bones;
}

function leg(side: string, sx: number): Bone[] {
  return [
    { name: `thigh_${side}`, parent: "pelvis", pos: [0.105 * sx, 0, -0.06], hpr: [0, 0, 0] },
    { name: `calf_${side}`, parent: `thigh_${side}`, pos: [0, 0, -0.43], hpr: [0, 0, 0] },
    { name: `foot_${side}`, parent: `calf_${side}`, pos: [0, 0, -0.33], hpr: [0, 0, 0] },
    { name: `toe_${side}`, parent: `foot_${side}`, pos: [0, 0.14, -0.06], hpr: [0, 0, 0] },
  ];
}

export const BONES: Bone[] = [
  { name: "root", parent: "", pos: [0, 0, 0], hpr: [0, 0, 0] },
  { name: "pelvis", parent: "root", pos: [0, 0, STAND_PELVIS], hpr: [0, 0, 0] },
  { name: "spine_01", parent: "pelvis", pos: [0, 0, 0.08], hpr: [0, 0, 0] },
  { name: "spine_02", parent: "spine_01", pos: [0, 0, 0.10], hpr: [0, 0, 0] },
  { name: "spine_03", parent: "spine_02", pos: [0, 0, 0.10], hpr: [0, 0, 0] },
  { name: "neck", parent: "spine_03", pos: [0, 0, 0.30], hpr: [0, 0, 0] },
  { name: "head", parent: "neck", pos: [0, 0.01, 0.09], hpr: [0, 0, 0] },
  ...arm("l", -1), ...arm("r", 1),
  ...leg("l", -1), ...leg("r", 1),
  { name: "weapon", parent: "spine_03", pos: [0.115, 0.17, 0.17], hpr: [0, 0, 0] },
  { name: "pack", parent: "spine_03", pos: [0, -0.17, 0.10], hpr: [0, 0, 0] },
];

export const N_BONES = BONES.length;
export const INDEX: Record<string, number> = Object.fromEntries(BONES.map((b, i) => [b.name, i]));
export const PARENT: number[] = BONES.map((b) => (b.parent ? INDEX[b.parent] : -1));

/** Model-space matrices from local (pos, hpr) per bone. */
export function solve(pos: ArrayLike<number>[], hpr: ArrayLike<number>[], out: M4[] = []): M4[] {
  const local = new Float64Array(16);
  for (let i = 0; i < N_BONES; i++) {
    const p = pos[i], h = hpr[i];
    m4PosHpr(p, h[0], h[1], h[2], local);
    const parent = PARENT[i];
    out[i] = parent < 0 ? Float64Array.from(local) : m4Mul(local, out[parent], out[i] ?? new Float64Array(16));
  }
  return out;
}

export const REST_POS: V3[] = BONES.map((b) => [...b.pos] as V3);
export const REST_HPR: V3[] = BONES.map((b) => [...b.hpr] as V3);
export const REST_WORLD: M4[] = solve(REST_POS, REST_HPR);
export const INV_BIND: M4[] = REST_WORLD.map((m) => m4InvAffine(m));

/** The local heading/pitch/roll of a bone whose rotation is `child` in some frame, under a parent whose
 * rotation is `parent` in the same frame (child * parent^T). */
export function relativeHpr(parent: V3, child: V3): V3 {
  const rot = (h: number, p: number, r: number) => {
    const ch = Math.cos(h * D), sh = Math.sin(h * D), cp = Math.cos(p * D), sp = Math.sin(p * D), cr = Math.cos(r * D), sr = Math.sin(r * D);
    return [[cr * ch - sr * sp * sh, cr * sh + sr * sp * ch, -sr * cp], [-cp * sh, cp * ch, sp], [sr * ch + cr * sp * sh, sr * sh - cr * sp * ch, cr * cp]];
  };
  const [[a0, a1, a2], [b0, b1, b2], [c0, c1, c2]] = rot(child[0], child[1], child[2]);
  const [[d0, d1, d2], [e0, e1, e2], [f0, f1, f2]] = rot(parent[0], parent[1], parent[2]);
  const m02 = a0 * f0 + a1 * f1 + a2 * f2;
  const m10 = b0 * d0 + b1 * d1 + b2 * d2;
  const m11 = b0 * e0 + b1 * e1 + b2 * e2;
  const m12 = b0 * f0 + b1 * f1 + b2 * f2;
  const m22 = c0 * f0 + c1 * f1 + c2 * f2;
  const p = Math.asin(Math.max(-1, Math.min(1, m12)));
  return [Math.atan2(-m10, m11) / D, p / D, Math.atan2(-m02, m22) / D];
}
