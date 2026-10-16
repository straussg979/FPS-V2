// Map checker: npx tsx scripts/maps/check.ts data/maps/qalat.json [data/maps/bazaar.json ...] [--radar out_dir]
// Builds each map's level and navmesh (like the server does) and reports:
// * vertex / collider / light counts, and whether the server build and the asset build agree on collision;
// * paths from both spawns to every bomb site;
// * every test route, leg by leg (a waypoint off the navmesh, a missing path, or a big detour);
// * practice positions that are not on the navmesh;
// * buildings whose rooms cannot be reached from the attackers' spawn (a door blocked by a prop, say).
// With --radar it also writes <map>_radar.png, the same top-down image the game's radar uses.
import fs from "node:fs";
import path from "node:path";
import { Level } from "../../shared/src/level/level";
import { NavMesh } from "../../server/src/ai/navmesh";
import { radarPng } from "../assets/maps";

const args = process.argv.slice(2);
const ri = args.indexOf("--radar");
const radarDir = ri >= 0 ? args.splice(ri, 2)[1] : null;
let failures = 0;
for (const file of args) {
  const key = path.basename(file, ".json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const level = new Level(key, data, true);
  const server = new Level(key, data, false);
  const verts = [...level.ctx.builders.values()].reduce((s, b) => s + b.vertexCount, 0);
  console.log(`${key} (${level.name}): ${verts} vertices, ${level.colliders.length} colliders, ${level.panelSpecs.length} breakable panels, ${level.lights.length} lights`);
  let bad = 0;
  if (level.colliders.length !== server.colliders.length) { console.log("  !! collision differs between the server and the asset build"); bad++; }
  const seeds = [...level.spawns.map((s) => s.pos), ...Object.values(data.modes ?? {}).flatMap((m: any) => (m.spawns ?? []).map((s: any) => s.pos))];
  const nav = NavMesh.build(level.navColliders(), level.bounds, seeds);
  if (radarDir) fs.writeFileSync(path.join(radarDir, `${key}_radar.png`), radarPng(level, nav).png);
  for (const s of level.spawns) {
    const q = nav.snap(s.pos, 3);
    if (!q || Math.hypot(q[0] - s.pos[0], q[1] - s.pos[1]) > 0.5) { console.log(`  !! ${s.team} spawn ${s.pos} is not on the navmesh`); bad++; }
  }
  for (const team of ["attack", "defend"]) {
    const s = level.spawnPoint(team).pos;
    for (const z of level.zones.filter((zz) => zz.kind === "bombsite")) {
      const goal = nav.snap([(z.min[0] + z.max[0]) / 2, (z.min[1] + z.max[1]) / 2, 0.1], 8);
      const p = goal ? nav.findPath(s, goal) : null;
      console.log(`  ${team} spawn -> site ${z.name}: ${p ? nav.pathLength(p).toFixed(1) + " m" : "NO PATH"}`);
      if (!p) bad++;
    }
  }
  for (const r of data.test_routes ?? []) {
    const pts = [r.start.slice(0, 3), ...r.waypoints.map((w: number[]) => [w[0], w[1], w.length > 2 ? w[2] : 0.1])];
    let total = 0, ok = true;
    for (let i = 0; i < pts.length - 1 && ok; i++) {
      const a = nav.snap(pts[i], 1.5), b = nav.snap(pts[i + 1], 1.5);
      if (!a || !b) { console.log(`  !! route "${r.name}": ${JSON.stringify(!a ? pts[i] : pts[i + 1])} is off the navmesh`); ok = false; break; }
      const p = nav.findPath(a, b);
      if (!p) { console.log(`  !! route "${r.name}": no path ${JSON.stringify(pts[i])} -> ${JSON.stringify(pts[i + 1])}`); ok = false; break; }
      const L = nav.pathLength(p), direct = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (L > direct * 1.6 + 4) console.log(`  ?  route "${r.name}": leg ${i} detours (${L.toFixed(1)} m for ${direct.toFixed(1)} m)`);
      total += L;
    }
    console.log(`  route ${r.name}: ${ok ? total.toFixed(1) + " m" : "BROKEN"}`);
    if (!ok) bad++;
  }
  for (const side of ["attack", "defend"]) for (const e of data.practice_positions?.[side] ?? []) {
    const q = nav.snap([e[0], e[1], e[2]], 1.0);
    if (!q || Math.abs(q[2] - e[2]) > 0.5) { console.log(`  !! ${side} practice position ${e} is off the navmesh`); bad++; }
  }
  const spawn = level.spawnPoint("attack").pos;
  data.pieces.forEach((p: any, i: number) => {
    if (p.type !== "mud_house" && p.type !== "building") return;
    const [[x0, y0], [x1, y1]] = [p.min, p.max];
    const z = (p.z ?? 0) + 0.1;
    let n = 0, hit = 0, reach = 0;
    for (let x = x0 + 0.9; x < x1 - 0.8; x += 1.5) for (let y = y0 + 0.9; y < y1 - 0.8; y += 1.5) {
      n++;
      const q = nav.snap([x, y, z], 0.4);
      if (q && Math.abs(q[2] - z) < 0.5) { hit++; if (nav.findPath(spawn, q)) reach++; }
    }
    if (hit / Math.max(n, 1) < 0.5 || reach < hit) {
      console.log(`  !! piece ${i} (${p.type} ${JSON.stringify(p.min)}..${JSON.stringify(p.max)}): ${reach}/${n} interior points reachable`);
      bad++;
    }
  });
  console.log(`  ${bad ? bad + " problem(s)" : "OK"}`);
  failures += bad;
}
process.exitCode = failures ? 1 : 0;
