// Where things are on disk: the repository root (found from this module, so it works from server/src under
// tsx and from server/dist after the build), the data files, the built client and the writable user folder
// (database, map caches, logs).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function findRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "data", "maps")) && fs.existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

export const ROOT = findRoot();
export const DATA_DIR = path.join(ROOT, "data");
export const MAPS_DIR = path.join(DATA_DIR, "maps");
export const USER_DIR = process.env.USER_DIR ? path.resolve(process.env.USER_DIR) : path.join(ROOT, "user");
export const CACHE_DIR = path.join(USER_DIR, "cache");
export const CLIENT_DIST = path.join(ROOT, "client", "dist");
export const TEMPLATES_DIR = path.join(ROOT, "server", "templates");
export const STATIC_DIR = path.join(ROOT, "server", "static");

export function mapPath(name: string): string { return path.join(MAPS_DIR, `${name}.json`); }

export function availableMaps(): string[] {
  try {
    return fs.readdirSync(MAPS_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
  } catch {
    return [];
  }
}

/** Display name, description and briefing of every map (read once; the map JSON files are the source). */
let mapInfoCache: Record<string, { name: string; description: string; briefing: Record<string, string> }> | null = null;
export function mapInfo(): Record<string, { name: string; description: string; briefing: Record<string, string> }> {
  if (mapInfoCache) return mapInfoCache;
  const out: Record<string, { name: string; description: string; briefing: Record<string, string> }> = {};
  for (const key of availableMaps()) {
    try {
      const d = JSON.parse(fs.readFileSync(mapPath(key), "utf8"));
      out[key] = { name: String(d.name ?? key), description: String(d.description ?? ""), briefing: d.briefing ?? {} };
    } catch {
      out[key] = { name: key, description: "", briefing: {} };
    }
  }
  return (mapInfoCache = out);
}

/** A directory of JSON files for the navmesh and tactical map caches (keys are content hashes). */
export function fileCache(dir = CACHE_DIR): { load(name: string): unknown; save(name: string, data: unknown): void } {
  return {
    load(name) {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8"));
      } catch {
        return undefined;
      }
    },
    save(name, data) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const tmp = path.join(dir, `${name}.${process.pid}.tmp`);
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, path.join(dir, `${name}.json`));
      } catch {
        // a cache that cannot be written only costs build time next start
      }
    },
  };
}
