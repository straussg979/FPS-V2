// The game's data files (data/*.json), loaded as they are. Bundled into the server and the client at
// build time, so both read exactly the same numbers.

import botsJson from "../../data/bots.json";
import charAnimsJson from "../../data/character_anims.json";
import destructionJson from "../../data/destruction.json";
import graphicsJson from "../../data/graphics_presets.json";
import matchJson from "../../data/match.json";
import materialsJson from "../../data/materials.json";
import duelJson from "../../data/modes/duel.json";
import shortJson from "../../data/modes/short.json";
import specialistsJson from "../../data/specialists.json";
import surfacesJson from "../../data/surfaces.json";
import weaponsJson from "../../data/weapons.json";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Json = any;

export const BOTS: Json = botsJson;
export const CHARACTER_ANIMS: Json = charAnimsJson;
export const DESTRUCTION: Json = destructionJson;
export const GRAPHICS_PRESETS: Json = graphicsJson;
export const MATCH_RULES: Json = matchJson;
export const MATERIALS: Json = materialsJson;
export const SPECIALISTS: Json = specialistsJson;
export const SURFACES: Record<string, Json> = Object.fromEntries(
  Object.entries(surfacesJson as Json).filter(([k]) => !k.startsWith("_")));
export const WEAPONS_JSON: Json = weaponsJson;
export const MODES: Record<string, Json> = { duel: duelJson, short: shortJson };

export function surfaceProps(name: string): Json {
  return SURFACES[name] ?? SURFACES.default;
}

/** A material's gameplay surface and texture scale (metres per repeat). */
export function materialInfo(name: string): { name: string; surface: string; uvScale: number } {
  const d = (MATERIALS as Json)[name];
  if (!d || name.startsWith("_")) return materialInfo("concrete_wall");
  return { name, surface: d.surface ?? "default", uvScale: Number(d.uv_scale ?? 2.0) };
}

export function deepCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

/** base with override laid over it, nested objects merged key by key (keys starting with _ skipped). */
export function mergeRules(base: Json, override: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (k.startsWith("_")) continue;
    if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) {
      out[k] = mergeRules(out[k], v);
    } else out[k] = v;
  }
  return out;
}

export const PRESETS = ["full", "short", "duel"] as const;

/** data/match.json with a mode's overrides (data/modes/<name>.json). */
export function loadPreset(name?: string | null): Json {
  const rules = deepCopy(MATCH_RULES);
  if (!name || name === "full") return rules;
  const mode = MODES[name];
  if (!mode) throw new Error(`unknown rules preset ${name}`);
  return mergeRules(rules, mode);
}
