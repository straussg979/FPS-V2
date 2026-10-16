// The client build at /assets/ (client/dist/assets): the site's and the game's modules and styles (Vite) and
// the generated game assets (scripts/build.ts: maps, models, textures, sounds). Every file there has a
// content hash in its name, so it is sent with Cache-Control: public, max-age=31536000, immutable: browsers
// and Cloudflare keep it until a build changes the name. A precompressed .br or .gz twin goes out when the
// browser accepts it (Content-Encoding; Cloudflare passes it through). The assets are not secret and need no
// log-in, so a CDN can cache them; playing still needs an account.

import fs from "node:fs";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { CLIENT_DIST } from "../paths";
import type { Entry } from "./pages";

export const IMMUTABLE = "public, max-age=31536000, immutable";
const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".glb": "model/gltf-binary", ".bin": "application/octet-stream", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".ktx2": "image/ktx2", ".woff2": "font/woff2",
  ".map": "application/json", ".hdr": "image/vnd.radiance",
};

const ASSETS_DIR = path.join(CLIENT_DIST, "assets");

export async function serveAsset(req: FastifyRequest, reply: FastifyReply, name: string): Promise<unknown> {
  const root = path.resolve(ASSETS_DIR);
  const file = path.resolve(root, name);
  if (!file.startsWith(root + path.sep) || file.endsWith(".gz") || file.endsWith(".br")) return reply.code(404).send("not found");
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(file);
  } catch {
    return reply.code(404).header("cache-control", "no-store").send("not found");
  }
  if (!st.isFile()) return reply.code(404).send("not found");
  const accept = String(req.headers["accept-encoding"] ?? "");
  let send = file, enc: string | null = null;
  for (const [ext, name2] of [[".br", "br"], [".gz", "gzip"]] as const) {
    if (accept.includes(name2) && fs.existsSync(file + ext)) {
      send = file + ext;
      enc = name2;
      break;
    }
  }
  reply.header("content-type", TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream");
  reply.header("cache-control", IMMUTABLE);
  reply.header("vary", "Accept-Encoding");
  reply.header("access-control-allow-origin", "*");
  reply.header("x-content-type-options", "nosniff");
  if (enc) reply.header("content-encoding", enc);
  reply.header("content-length", String((await fs.promises.stat(send)).size));
  return reply.send(fs.createReadStream(send));
}

interface ViteManifest { [src: string]: { file: string; css?: string[]; isEntry?: boolean; imports?: string[] } }

let cache: { mtime: number; manifest: ViteManifest } | null = null;
let gameCache: { mtime: number; url: string } | null = null;

function viteManifest(): ViteManifest | null {
  const file = path.join(CLIENT_DIST, ".vite", "manifest.json");
  try {
    const mtime = fs.statSync(file).mtimeMs;
    if (!cache || cache.mtime !== mtime) cache = { mtime, manifest: JSON.parse(fs.readFileSync(file, "utf8")) };
    return cache.manifest;
  } catch {
    return null;
  }
}

/** The built module and styles of a client entry ("site" or "game"). */
export function entry(name: "site" | "game"): Entry {
  const m = viteManifest();
  const key = `src/${name}/main.ts`;
  const e = m?.[key];
  if (!m || !e) return { js: "", css: [] };
  const css = new Set<string>();
  const walk = (k: string) => {
    const it = m[k];
    if (!it) return;
    for (const c of it.css ?? []) css.add(`/${c}`);
    for (const i of it.imports ?? []) walk(i);
  };
  walk(key);
  return { js: `/${e.file}`, css: [...css] };
}

/** The URL of the game asset manifest (written by the asset build), or "" before the first build. */
export function gameAssetManifest(): string {
  const file = path.join(CLIENT_DIST, "game-assets.json");
  try {
    const mtime = fs.statSync(file).mtimeMs;
    if (!gameCache || gameCache.mtime !== mtime) gameCache = { mtime, url: JSON.parse(fs.readFileSync(file, "utf8")).manifest ?? "" };
    return gameCache.url;
  } catch {
    return "";
  }
}

export function clientBuilt(): boolean { return viteManifest() !== null; }
