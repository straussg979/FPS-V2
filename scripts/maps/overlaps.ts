// Coplanar-overlap check: npx tsx scripts/maps/overlaps.ts data/maps/qalat.json [data/maps/bazaar.json ...] [--raw] [--list N] [--grep TEXT]
// Builds each map's geometry (like the asset build) and reports pairs of faces from different pieces that lie in
// the same plane (within 2 mm), face the same way and overlap by more than 1 cm^2 - the surfaces that z-fight
// ("tear") on screen. It prints what the prefabs emit, grouped by prefab and material, then runs the same clean-up
// the asset build runs (shared/src/level/overlaps.ts: buried faces cut, the rest layered apart) and prints what is
// left in the shipped geometry, which must be zero. --raw stops after the first report; --list N prints N
// individual pairs with coordinates (filtered by --grep) and the categories that were still visible.
import fs from "node:fs";
import path from "node:path";
import { Level } from "../../shared/src/level/level";
import { FaceRecorder, MeshBuilder } from "../../shared/src/level/meshbuilder";
import { finalizeGeometry, findOverlaps, resolveStats } from "../../shared/src/level/overlaps";

const args = process.argv.slice(2);
const raw = args.includes("--raw");
const li = args.indexOf("--list");
const listN = li >= 0 ? Number(args[li + 1]) : 0;
const gi = args.indexOf("--grep");
const grep = gi >= 0 ? args[gi + 1] : "";
const files = args.filter((a) => a.endsWith(".json"));
let failures = 0;
for (const file of files) {
  const key = path.basename(file, ".json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const rec = new FaceRecorder();
  MeshBuilder.recorder = rec;
  const t0 = performance.now();
  const level = new Level(key, data, true);
  MeshBuilder.recorder = null;
  const found = findOverlaps(rec);
  const tris = [...level.ctx.builders.values()].reduce((s, b) => s + b.indices.length / 3, 0);
  console.log(`${key}: ${rec.shapes.length} shapes, ${rec.faces.length} planar faces, ${tris} triangles`);
  console.log(`  coplanar overlaps emitted by the prefabs: ${found.length} (${found.reduce((s, o) => s + o.area, 0).toFixed(2)} m^2)`);
  const describe = (o: { a: number; b: number }) => {
    const fa = rec.faces[o.a], fb = rec.faces[o.b];
    return `${rec.shapes[fa.shape].label}[${rec.shapes[fa.shape].mat}] / ${rec.shapes[fb.shape].label}[${rec.shapes[fb.shape].mat}]`;
  };
  const groups = new Map<string, { n: number; area: number }>();
  for (const o of found) {
    const k = describe(o);
    const g = groups.get(k) ?? { n: 0, area: 0 };
    g.n++;
    g.area += o.area;
    groups.set(k, g);
  }
  for (const [k, g] of [...groups].sort((x, y) => y[1].n - x[1].n).slice(0, 20)) console.log(`    ${String(g.n).padStart(5)}  ${g.area.toFixed(3).padStart(8)} m^2  ${k}`);
  for (const o of found.filter((x) => !grep || describe(x).includes(grep)).slice(0, listN)) {
    const fa = rec.faces[o.a], fb = rec.faces[o.b];
    console.log(`    pair n=${fa.n.map((v) => v.toFixed(2))} d=${fa.d.toFixed(4)}/${fb.d.toFixed(4)} area=${o.area.toFixed(4)} at ${fa.poly[0].map((v) => v.toFixed(2))} :: ${describe(o)}`);
  }
  if (raw) continue;
  const fin = finalizeGeometry(rec, level.ctx.builders, level.ctx.weather);
  const left = fin.left;
  const tris2 = [...level.ctx.builders.values()].reduce((s, b) => s + b.indices.length / 3, 0);
  console.log(`  buried faces cut: ${fin.hidden}; visible overlaps layered apart, per round: ${fin.rounds.join(" -> ")}; left in the shipped geometry: ${left}`);
  console.log(`  pieces moved apart: ${resolveStats.moved}, the most by ${(resolveStats.maxMove * 1000).toFixed(0)} mm; surface bake ${fin.bakeMs} ms`);
  const sum = (f: (k: string) => boolean) => [...level.ctx.builders.entries()].filter(([k]) => f(k)).reduce((a, [, b]) => a + b.indices.length / 3, 0);
  const common = sum((k) => !/@(hi|lo):/.test(k) && !k.endsWith("@backdrop")), hiT = sum((k) => k.includes("@hi:")), loT = sum((k) => k.includes("@lo:"));
  console.log(`  triangles after clean-up: ${tris2} (${((performance.now() - t0) / 1000).toFixed(1)} s); every cell far (low preset): ${common + loT}; every cell near: ${common + hiT}; backdrop ${sum((k) => k.endsWith("@backdrop"))}`);
  if (listN) {
    const g3 = new Map<string, number>();
    for (const o of resolveStats.firstRound) { const k = describe(o); g3.set(k, (g3.get(k) ?? 0) + 1); }
    for (const [k, n] of [...g3].sort((x, y) => y[1] - x[1]).slice(0, 25)) console.log(`    visible ${n}  ${k}`);
    if (left) for (const o of findOverlaps(rec).slice(0, listN)) console.log(`    left ${describe(o)} at ${rec.faces[o.a].poly[0].map((v) => v.toFixed(2))}`);
  }
  if (left) failures++;
}
if (failures) { console.log(`${failures} map(s) still have overlapping faces`); process.exit(1); }
if (!raw) console.log("OK: no coplanar overlaps in the shipped geometry");
