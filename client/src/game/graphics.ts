// Individual graphics options. A preset (data/graphics_presets.json) fills them all in; changing any one of them
// makes the preset "custom". Most apply at once (World.applyGraphics); RELOAD_KEYS need the page reloaded because
// they are baked in when the map's materials and render targets are made.

import { GRAPHICS_PRESETS } from "@cs/shared/data";

export const PRESET_NAMES = ["low", "medium", "high", "ultra"];

export type AoQuality = "off" | "low" | "medium" | "high";
export type AntiAliasing = "off" | "fxaa" | "smaa" | "msaa";
export type ToneMap = "aces" | "agx";
export type Detail = "low" | "medium" | "high";

export interface Gfx {
  renderScale: number;      // fraction of the screen resolution (live)
  pixelRatioCap: number;    // highest device pixel ratio used on hi-dpi screens (live)
  textures: number;         // texture size cap (reload)
  anisotropy: number;       // texture filtering (reload)
  shadows: boolean;         // sun shadows (live)
  shadowSize: number;       // shadow map resolution per cascade (live)
  shadowDistance: number;   // metres covered by the shadow cascades (live)
  shadowCascades: number;   // 1-4 cascaded shadow maps (live)
  shadowTaps: number;       // filter taps per shadow lookup (live, recompiles)
  shadowSoftness: number;   // penumbra scale (live)
  shadowPcss: boolean;      // contact-hardening soft shadows (live, recompiles)
  ao: AoQuality;            // screen-space ambient occlusion on ambient light (live)
  bloom: boolean;           // (live)
  bloomStrength: number;    // multiplier on the map's bloom (live)
  grading: boolean;         // the map's colour grade (live)
  vignette: boolean;        // (live)
  aa: AntiAliasing;         // fxaa / smaa are live, msaa needs a reload
  autoExposure: boolean;    // eye adaptation (live)
  saturation: number;       // multiplier (live)
  contrast: number;         // multiplier (live)
  fpsCap: number;           // 0 = unlimited (live)
  specularAA: boolean;      // roughness widened where normals vary within a pixel (live, recompiles)
  detailNormals: boolean;   // finer normal-map layer up close (live, recompiles)
  weathering: boolean;      // dust, streaks, damp, soot, peeling plaster, chipped paint (live, recompiles)
  volumetric: boolean;      // light shafts through doorways and windows (live)
  dustMotes: boolean;       // motes drifting in the sunbeams (live)
  toneMapping: ToneMap;     // ACES filmic or AgX (live)
  buildingDetail: Detail;   // rounded / organic building geometry near the camera (live)
  localLights: number;      // real-time point lights from the map's fixtures near you (live, recompiles)
  localShadows: number;     // how many of them cast shadows (live, recompiles)
}

export const RELOAD_KEYS: Array<keyof Gfx> = ["textures", "anisotropy"];

/* eslint-disable @typescript-eslint/no-explicit-any */
export function presetGfx(name: string): Gfx {
  const p: any = GRAPHICS_PRESETS[name] ?? GRAPHICS_PRESETS.medium;
  const aa = String(p.antialiasing ?? "fxaa");
  return {
    renderScale: p.render_scale ?? 1,
    pixelRatioCap: name === "low" ? 1 : name === "medium" ? 1.5 : 2,
    textures: Math.min(p.texture_size ?? 1024, 1024),
    anisotropy: p.anisotropy ?? 4,
    shadows: (p.shadow_resolution ?? 0) > 0,
    shadowSize: Math.min(p.shadow_resolution ?? 1024, 4096),
    shadowDistance: p.shadow_distance ?? 60,
    shadowCascades: Math.max(1, Math.min(4, p.shadow_cascades ?? 1)),
    shadowTaps: Math.max(1, Math.min(32, p.shadow_pcf_taps ?? 8)),
    shadowSoftness: p.shadow_softness ?? 1,
    shadowPcss: !!p.shadow_pcss,
    ao: (["off", "low", "medium", "high"].includes(p.ssao) ? p.ssao : "off") as AoQuality,
    bloom: !!p.bloom,
    bloomStrength: 1,
    grading: !!p.color_grading,
    vignette: !!p.vignette,
    aa: aa.includes("msaa") ? "msaa" : aa.includes("smaa") ? "smaa" : aa.includes("fxaa") ? "fxaa" : "off",
    autoExposure: p.auto_exposure !== false,
    saturation: 1,
    contrast: 1,
    fpsCap: 0,
    specularAA: !!p.specular_aa,
    detailNormals: !!p.detail_normals,
    weathering: p.weathering !== false,
    volumetric: !!p.volumetric_light,
    dustMotes: !!p.dust_motes,
    toneMapping: p.tone_mapping === "agx" ? "agx" : "aces",
    buildingDetail: (["low", "medium", "high"].includes(p.building_detail) ? p.building_detail : "high") as Detail,
    localLights: Math.max(0, Math.min(8, p.local_lights ?? 0)),
    localShadows: p.local_shadows ? Math.max(0, Math.min(4, p.local_shadow_lights ?? 0)) : 0,
  };
}

/** The preset whose values these are, or "custom". fpsCap and the colour sliders don't count: they are taste. */
export function matchPreset(g: Gfx): string {
  const ignore = new Set(["fpsCap", "saturation", "contrast", "bloomStrength", "toneMapping"]);
  for (const name of PRESET_NAMES) {
    const p = presetGfx(name) as any;
    if (Object.keys(p).every((k) => ignore.has(k) || p[k] === (g as any)[k])) return name;
  }
  return "custom";
}

/** A stored gfx block (any shape) completed from the preset. */
export function normalizeGfx(raw: any, presetName: string): Gfx {
  const base = presetGfx(PRESET_NAMES.includes(presetName) ? presetName : "medium") as any;
  if (!raw || typeof raw !== "object") return base;
  for (const k of Object.keys(base)) if (raw[k] !== undefined && typeof raw[k] === typeof base[k]) base[k] = raw[k];
  if (![512, 1024].includes(base.textures)) base.textures = 1024;
  if (!["off", "fxaa", "smaa", "msaa"].includes(base.aa)) base.aa = "fxaa";
  if (!["off", "low", "medium", "high"].includes(base.ao)) base.ao = "off";
  if (![0, 30, 60, 90, 120, 144, 165, 240].includes(base.fpsCap)) base.fpsCap = 0;
  if (!["aces", "agx"].includes(base.toneMapping)) base.toneMapping = "aces";
  if (!["low", "medium", "high"].includes(base.buildingDetail)) base.buildingDetail = "high";
  base.renderScale = Math.max(0.5, Math.min(1.5, base.renderScale));
  base.shadowCascades = Math.max(1, Math.min(4, Math.round(base.shadowCascades)));
  base.shadowTaps = Math.max(1, Math.min(32, Math.round(base.shadowTaps)));
  return base as Gfx;
}
