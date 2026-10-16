// The build behind `npm start` (and `npm run build`, which forces it): whatever is missing or out of date of
// 1. the server bundle (esbuild: server/dist/main.mjs and the match worker server/dist/worker.mjs),
// 2. the browser client (Vite: client/dist, content-hashed modules and styles with a manifest),
// 3. the game assets (client/dist/assets/g): map geometry GLBs, light volumes, radar images, procedural PBR
//    textures at 512 and 1024 px, weapon and gadget models, the skinned soldier, synthesised sounds, and a content-hashed
//    manifest, plus the HDR skies `npm run fetch-assets` downloaded. Texture sets are cached in build/cache,
//    so only changed materials are generated again.
// Compressible outputs also get .br and .gz twins that the server sends when the browser accepts them.
// Each part is skipped when a hash of its inputs matches the last build.

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FORCE = process.argv.includes("--force");
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",") ?? null;
const BUILD = path.join(ROOT, "build");
const STAMP = path.join(BUILD, "stamp.json");
const DIST = path.join(ROOT, "client", "dist");
const GAME = path.join(DIST, "assets", "g");
const COMPRESS = new Set([".js", ".css", ".json", ".glb", ".wav", ".bin", ".svg", ".map"]);
const log = (m: string) => console.log(m);

// ------------------------------------------------------------------ hashing
function walk(p: string, out: string[] = []): string[] {
  if (!fs.existsSync(p)) return out;
  const st = fs.statSync(p);
  if (st.isFile()) out.push(p);
  else for (const e of fs.readdirSync(p).sort()) if (!["node_modules", "dist", ".vite"].includes(e)) walk(path.join(p, e), out);
  return out;
}

function hashOf(paths: string[]): string {
  const h = createHash("sha1");
  for (const p of paths.flatMap((x) => walk(path.join(ROOT, x)))) {
    h.update(path.relative(ROOT, p));
    h.update(fs.readFileSync(p));
  }
  return h.digest("hex").slice(0, 16);
}

const readStamp = (): Record<string, string> => { try { return JSON.parse(fs.readFileSync(STAMP, "utf8")); } catch { return {}; } };
const writeStamp = (s: Record<string, string>) => { fs.mkdirSync(BUILD, { recursive: true }); fs.writeFileSync(STAMP, JSON.stringify(s, null, 1)); };

function precompress(file: string): void {
  if (!COMPRESS.has(path.extname(file))) return;
  const data = fs.readFileSync(file);
  if (data.length < 1024) return;
  fs.writeFileSync(`${file}.br`, brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 10, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } }));
  fs.writeFileSync(`${file}.gz`, gzipSync(data, { level: 9 }));
}

// ------------------------------------------------------------------ server
const SERVER_EXTERNAL = ["fastify", "@fastify/*", "ws", "better-sqlite3", "drizzle-orm", "drizzle-orm/*", "@node-rs/argon2", "pg", "tsx", "tsx/*"];

async function buildServer(): Promise<void> {
  const esbuild = await import("esbuild");
  const t0 = Date.now();
  await esbuild.build({
    entryPoints: { main: path.join(ROOT, "server/src/main.ts"), worker: path.join(ROOT, "server/src/match/worker.ts") },
    outdir: path.join(ROOT, "server/dist"), outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", target: "node22",
    external: SERVER_EXTERNAL, sourcemap: true, logLevel: "warning",
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
  log(`[build] server bundle in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// ------------------------------------------------------------------ client
async function buildClient(): Promise<void> {
  const vite = await import("vite");
  const t0 = Date.now();
  // the previous build's modules go; the game assets (assets/g) stay
  const assets = path.join(DIST, "assets");
  if (fs.existsSync(assets)) for (const f of fs.readdirSync(assets)) if (f !== "g") fs.rmSync(path.join(assets, f), { recursive: true, force: true });
  await vite.build({ configFile: path.join(ROOT, "client/vite.config.ts"), logLevel: "warn" });
  for (const f of walk(assets)) if (!f.startsWith(GAME)) precompress(f);
  log(`[build] client in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// ------------------------------------------------------------------ assets
class Writer {
  manifest: Record<string, unknown> = {};
  keep = new Set<string>();
  written = 0;
  bytes = 0;

  /** Write data as rel with a content hash before the extension; returns its URL. */
  put(rel: string, data: Uint8Array): string {
    const ext = path.extname(rel);
    const h = createHash("sha1").update(data).digest("hex").slice(0, 10);
    const name = `${rel.slice(0, -ext.length)}-${h}${ext}`;
    const file = path.join(GAME, name);
    if (!fs.existsSync(file) || fs.statSync(file).size !== data.length) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
      precompress(file);
      this.written++;
    }
    this.keep.add(file);
    if (fs.existsSync(`${file}.br`)) { this.keep.add(`${file}.br`); this.keep.add(`${file}.gz`); }
    this.bytes += data.length;
    return `/assets/g/${name.split(path.sep).join("/")}`;
  }

  prune(): number {
    let n = 0;
    for (const f of walk(GAME)) if (!this.keep.has(f)) { fs.rmSync(f); n++; }
    return n;
  }
}

async function textures(names: string[], defs: Record<string, Record<string, unknown>>, w: Writer): Promise<Record<string, unknown>> {
  const genHash = createHash("sha1").update(fs.readFileSync(path.join(ROOT, "scripts/assets/texgen.ts"))).digest("hex").slice(0, 8);
  const cacheDir = path.join(BUILD, "cache", "textures");
  const out: Record<string, unknown> = {};
  const todo: string[] = [];
  const keyOf = (n: string) => `${n}-${createHash("sha1").update(genHash + JSON.stringify(defs[n])).digest("hex").slice(0, 10)}`;
  const files = (n: string) => path.join(cacheDir, keyOf(n));
  for (const n of names) if (!fs.existsSync(path.join(files(n), "done"))) todo.push(n);
  if (todo.length) {
    const t0 = Date.now();
    const threads = Math.max(1, Math.min(todo.length, os.availableParallelism() - 1, 8));
    log(`[assets] generating ${todo.length} texture sets on ${threads} threads (once; cached in build/cache)`);
    await new Promise<void>((resolve, reject) => {
      let next = 0, done = 0;
      const workers = Array.from({ length: threads }, () => new Worker(new URL("./assets/texworker-boot.mjs", import.meta.url)));
      const feed = (wk: Worker) => {
        if (next >= todo.length) { void wk.terminate(); return; }
        const n = todo[next++];
        wk.postMessage({ name: n, def: defs[n], size: 1024 });
      };
      for (const wk of workers) {
        wk.on("message", (m: { name: string; maps: Record<string, Record<string, Uint8Array>> }) => {
          const dir = files(m.name);
          fs.mkdirSync(dir, { recursive: true });
          for (const [map, bySize] of Object.entries(m.maps)) for (const [size, data] of Object.entries(bySize)) fs.writeFileSync(path.join(dir, `${map}_${size}.jpg`), data);
          fs.writeFileSync(path.join(dir, "done"), "");
          done++;
          if (done === todo.length) resolve();
          feed(wk);
        });
        wk.on("error", reject);
        feed(wk);
      }
    });
    log(`[assets] textures in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  for (const n of names) {
    const d = defs[n];
    const maps: Record<string, Record<string, string>> = {};
    for (const size of ["512", "1024"]) {
      maps[size] = {};
      for (const m of ["albedo", "normal", "orm"]) maps[size][m] = w.put(`textures/${n}/${m}_${size}.jpg`, fs.readFileSync(path.join(files(n), `${m}_${size}.jpg`)));
    }
    out[n] = { surface: d.surface ?? "default", uv_scale: Number(d.uv_scale ?? 2), normal_strength: Number(d.normal_strength ?? 1),
      roughness_scale: Number(d.roughness_scale ?? 1), metallic_scale: Number(d.metallic_scale ?? 1), maps };
  }
  return out;
}

/** The map's HDR sky if `npm run fetch-assets` downloaded one (assets-cache/hdri); else the client draws a procedural sky. */
function skyFile(env: { hdri?: string; hdri_candidates?: string[] }, put: (p: string) => string): string | null {
  for (const id of [env.hdri, ...(env.hdri_candidates ?? [])]) {
    const p = path.join(ROOT, "assets-cache", "hdri", `${id}.hdr`);
    if (id && fs.existsSync(p)) return put(p);
  }
  return null;
}

async function buildAssets(): Promise<void> {
  const t0 = Date.now();
  const { Level } = await import("../shared/src/level/level");
  const { FaceRecorder, MeshBuilder } = await import("../shared/src/level/meshbuilder");
  const { finalizeGeometry } = await import("../shared/src/level/overlaps");
  const { NavMesh } = await import("../server/src/ai/navmesh");
  const { DESTRUCTION } = await import("../shared/src/data");
  const { FIXTURE_MATERIALS, bakeVolumes, clientLights, mapGlb, radarPng } = await import("./assets/maps");
  const { modelMaterials, weaponGlb } = await import("./assets/weapons");
  const { soldierGlb } = await import("./assets/soldier");
  const { buildLibrary } = await import("./assets/synth");
  const { fileCache } = await import("../server/src/paths");
  fs.mkdirSync(GAME, { recursive: true });
  const w = new Writer();
  const defs: Record<string, Record<string, unknown>> = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(ROOT, "data/materials.json"), "utf8")))
    .filter(([k]) => !k.startsWith("_"))) as Record<string, Record<string, unknown>>;
  const models = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(ROOT, "data/weapon_models.json"), "utf8"))).filter(([k]) => !k.startsWith("_")));
  const used = new Set<string>(modelMaterials(models as Record<string, never>));
  used.add(DESTRUCTION.reinforce?.plate_mat ?? "steel_painted");
  for (const m of ["uniform_tan", "uniform_slate", "glove", "metal_tan", "metal_olive", "rubber", "sleeve_camo", ...FIXTURE_MATERIALS]) used.add(m);
  // the soldier's kits, skin tones and face (scripts/assets/soldier.ts, client/src/game/soldiers.ts)
  for (const m of ["camo_arid", "camo_olive", "cordura_coyote", "cordura_ranger", "helmet_coyote", "boot_tan", "boot_brown", "skin_1", "skin_2",
    "skin_3", "skin_4", "hair", "eye", "lens", "wool", "shemagh_tan", "shemagh_grey", "steel", "gun_metal", "shadow"]) used.add(m);
  // maps first: their materials decide which textures are needed
  const maps: Record<string, unknown> = {};
  const mapFiles = fs.readdirSync(path.join(ROOT, "data/maps")).filter((f) => f.endsWith(".json")).sort();
  const levels = mapFiles.map((f) => {
    const key = f.slice(0, -5);
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data/maps", f), "utf8"));
    // record every face while building, then clean the drawn geometry up: buried faces cut, coplanar faces
    // (z-fighting) layered apart, surface detail baked (shared/src/level/overlaps.ts; scripts/maps/overlaps.ts reports
    // the same and must say zero)
    const rec = new FaceRecorder();
    MeshBuilder.recorder = rec;
    const level = new Level(key, data, true);
    MeshBuilder.recorder = null;
    const fin = finalizeGeometry(rec, level.ctx.builders, level.ctx.weather);
    log(`[assets] ${key}: ${fin.hidden} buried faces cut, coplanar overlaps ${fin.rounds.join(" -> ")} -> ${fin.left} left, surface bake ${fin.bakeMs} ms`);
    if (fin.left) throw new Error(`map ${key}: ${fin.left} coplanar overlaps left (npx tsx scripts/maps/overlaps.ts data/maps/${f})`);
    for (const m of level.ctx.builders.keys()) used.add(m.split("@")[0]);
    for (const p of level.panelSpecs) { used.add(p.mat); used.add(p.mat2); }
    return { key, data, level };
  });
  const names = [...used].filter((n) => defs[n]).sort();
  const texPromise = textures(names, defs, w);
  for (const { key, data, level } of levels) {
    const vol = bakeVolumes(level, log);
    const nav = NavMesh.cached(level.navColliders(), level.bounds, [...level.spawns.map((s) => s.pos),
      ...Object.values(data.modes ?? {}).flatMap((m) => ((m as { spawns?: Array<{ pos: number[] }> }).spawns ?? []).map((s) => s.pos))],
      fileCache(path.join(ROOT, "user", "cache")), key, log);
    const radar = radarPng(level, nav);
    maps[key] = {
      name: level.name,
      geometry: w.put(`maps/${key}.glb`, mapGlb(level)),
      data: w.put(`maps/${key}.json`, new TextEncoder().encode(JSON.stringify(data))),
      volume: { file: w.put(`maps/${key}.vol.bin`, vol.blob), ...vol.info },
      radar: { file: w.put(`maps/${key}_radar.png`, radar.png), ...radar.info },
      sky: skyFile(data.environment ?? {}, (p) => w.put(`maps/${key}_sky.hdr`, fs.readFileSync(p))),
      lights: clientLights(level),
      environment: data.environment ?? {},
    };
    log(`[assets] map ${key}: ${[...level.ctx.builders.values()].reduce((s, b) => s + b.vertexCount, 0)} vertices, ${level.colliders.length} boxes, ${level.panelSpecs.length} panels`);
  }
  const weapons: Record<string, string> = {};
  for (const [k, d] of Object.entries(models)) weapons[k] = w.put(`weapons/${k}.glb`, weaponGlb(k, d));
  const soldier = w.put("characters/soldier.glb", soldierGlb());
  const t1 = Date.now();
  const wdefs = JSON.parse(fs.readFileSync(path.join(ROOT, "data/weapons.json"), "utf8")).weapons;
  const lib = buildLibrary(Object.entries(wdefs).map(([key, v]) => {
    const x = v as Record<string, number | string>;
    return { key, magazine: Number(x.magazine ?? 0), fireMode: String(x.fire_mode ?? "semi"), cls: String(x.class ?? x.cls ?? "rifle"),
      reloadTime: Number(x.reload_time ?? 2.5), reloadEmptyTime: Number(x.reload_empty_time ?? x.reload_time ?? 3) };
  }));
  const sounds: Record<string, string[]> = {};
  for (const [name, variants] of lib) sounds[name] = variants.map((d, i) => w.put(`sounds/${name}_${i}.wav`, d));
  log(`[assets] ${[...lib.values()].reduce((s, v) => s + v.length, 0)} sounds in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  const materials = await texPromise;
  const manifest = { format: 1, maps, weapons, soldier, materials, sounds, texture_sizes: [512, 1024] };
  const url = w.put("manifest.json", new TextEncoder().encode(JSON.stringify(manifest)));
  fs.writeFileSync(path.join(DIST, "game-assets.json"), JSON.stringify({ manifest: url }));
  const removed = w.prune();
  log(`[build] game assets: ${w.written} written, ${removed} stale removed, ${(w.bytes / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

// -------------------------------------------------------------------- main
/** Builds whatever is missing or out of date (scripts/start.ts calls this before starting the server). */
export async function build(): Promise<void> {
  const stamp = readStamp();
  const parts: Array<[string, string[], () => Promise<void>, string]> = [
    ["server", ["server/src", "shared/src", "data", "package-lock.json"], buildServer, "server/dist/main.mjs"],
    ["client", ["client/src", "client/public", "client/vite.config.ts", "shared/src", "data", "package-lock.json"], buildClient, "client/dist/.vite/manifest.json"],
    ["assets", ["scripts/assets", "shared/src/level", "shared/src/math.ts", "data", "assets-cache/hdri"], buildAssets, "client/dist/game-assets.json"],
  ];
  for (const [name, inputs, run, output] of parts) {
    if (ONLY && !ONLY.includes(name)) continue;
    const h = hashOf(inputs);
    if (!FORCE && stamp[name] === h && fs.existsSync(path.join(ROOT, output))) continue;
    await run();
    stamp[name] = h;
    writeStamp(stamp);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
