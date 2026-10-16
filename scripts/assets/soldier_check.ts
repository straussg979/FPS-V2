// Soldier mesh check: npx tsx scripts/assets/soldier_check.ts
// Builds the skinned soldier (scripts/assets/soldier.ts) and reports, per level of detail, pairs of triangles that
// lie in the same plane (within 1.5 mm), face the same way and overlap: layered parts (a vest panel on the torso, a
// strap on the vest, glasses on the face, a sole on a boot) that would z-fight in game. Vanguard-only (a:) and
// Bastion-only (d:) parts never meet, they are drawn on different soldiers. Zero is the goal.
import { soldierGlb } from "./soldier";

const glb = soldierGlb();
const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
const jsonLen = dv.getUint32(12, true);
const doc = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)));
const bin = 20 + jsonLen + 8;
const acc = (i: number): ArrayLike<number> => {
  const a = doc.accessors[i], v = doc.bufferViews[a.bufferView];
  const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type as "SCALAR"] as number;
  const C = a.componentType === 5126 ? Float32Array : a.componentType === 5123 ? Uint16Array : a.componentType === 5125 ? Uint32Array : Uint8Array;
  return new C(glb.buffer, glb.byteOffset + bin + (v.byteOffset || 0) + (a.byteOffset || 0), a.count * n);
};
type T = { p: number[][]; n: number[]; d: number; mat: string };
let total = 0;
for (const node of doc.nodes) {
  if (node.mesh === undefined || node.extras?.lod === undefined) continue;
  const tris: T[] = [];
  for (const prim of doc.meshes[node.mesh].primitives) {
    const mat = doc.materials[prim.material]?.name ?? "?";
    const P = acc(prim.attributes.POSITION), I = acc(prim.indices);
    for (let t = 0; t < I.length; t += 3) {
      const p = [0, 1, 2].map((k) => [P[I[t + k] * 3], P[I[t + k] * 3 + 1], P[I[t + k] * 3 + 2]]);
      const e1 = p[1].map((v, i) => v - p[0][i]), e2 = p[2].map((v, i) => v - p[0][i]);
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const l = Math.hypot(n[0], n[1], n[2]);
      if (l < 1e-10) continue;
      n[0] /= l; n[1] /= l; n[2] /= l;
      tris.push({ p, n, d: n[0] * p[0][0] + n[1] * p[0][1] + n[2] * p[0][2], mat });
    }
  }
  const side = (m: string) => (m.startsWith("a:") ? "a" : m.startsWith("d:") ? "d" : "");
  let bad = 0;
  const buckets = new Map<string, T[]>();
  for (const t of tris) {
    const k = `${Math.round(t.n[0] * 500)},${Math.round(t.n[1] * 500)},${Math.round(t.n[2] * 500)}|${Math.round(t.d / 0.0015)}`;
    (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(t);
  }
  const ex: string[] = [];
  for (const list of buckets.values()) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    const sa = side(a.mat), sb = side(b.mat);
    if (sa && sb && sa !== sb) continue;
    if (Math.abs(a.d - b.d) > 0.0015) continue;
    const ax = Math.abs(a.n[0]) > 0.5 ? [1, 2] : Math.abs(a.n[1]) > 0.5 ? [0, 2] : [0, 1];
    const to2 = (q: number[]) => [q[ax[0]], q[ax[1]]];
    const inside = (pt: number[], tri: number[][]) => {
      const [p0, p1, p2] = tri.map(to2), q = to2(pt);
      const s = (u: number[], v: number[], w: number[]) => (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]);
      const d1 = s(p0, p1, q), d2 = s(p1, p2, q), d3 = s(p2, p0, q);
      const eps = 1e-9;
      return (d1 > eps && d2 > eps && d3 > eps) || (d1 < -eps && d2 < -eps && d3 < -eps);
    };
    const ca = [0, 1, 2].map((k) => (a.p[0][k] + a.p[1][k] + a.p[2][k]) / 3), cb = [0, 1, 2].map((k) => (b.p[0][k] + b.p[1][k] + b.p[2][k]) / 3);
    if (inside(ca, b.p) || inside(cb, a.p) || a.p.some((q) => inside(q, b.p)) || b.p.some((q) => inside(q, a.p))) {
      bad++;
      if (ex.length < 10) ex.push(`${a.mat} / ${b.mat} at ${ca.map((v) => v.toFixed(3))}`);
    }
  }
  console.log(`LOD ${node.extras.lod}: ${tris.length} triangles, ${bad} coplanar overlapping pairs`);
  for (const e of ex) console.log("   ", e);
  total += bad;
}
if (total) process.exitCode = 1;
