// Depth precision. The main camera used to run from 3 cm to 600 m on a 24-bit integer depth buffer: almost all of
// the precision sat in the first metres, so walls tens of metres away had centimetre-sized depth steps and every
// pair of nearly-touching faces z-fought ("tearing"). Now:
//  * the near plane is 10 cm (the first-person weapon has its own camera and a depth clear, viewmodel.ts);
//  * where the browser has EXT_clip_control, depth is reversed-Z into a 32-bit float buffer (1 at the near plane,
//    0 far away): float precision is spread evenly over distance, sub-millimetre at 100 m. three.js does most of it
//    (projection matrices, depth functions, clears) when the renderer is made with reverseDepthBuffer; this
//    module patches the few places that read or write depth themselves: the shadow-map depth (stored the classic
//    way, so shadow lookups do not change), the sky (pinned to the far plane), polygon offsets (their sign flips)
//    and our own passes (SSAO, light shafts) through the REVERSED_Z define;
//  * the far mountains and the sky are drawn first by a backdrop camera with its own near / far range (world.ts),
//    so the main frustum only spans the play space.
// ?depth=standard on the game URL turns reversed-Z off for comparison.

import * as THREE from "three";

let patched = false;

/** Shader patches for reversed-Z; harmless when it is off (they test USE_REVERSEDEPTHBUF, which three defines). */
export function installReversedZPatches(): void {
  if (patched) return;
  patched = true;
  const lib = THREE.ShaderLib as Record<string, { fragmentShader: string; vertexShader: string }>;
  // shadow maps (and any depth material) keep storing classic 0 = near .. 1 = far depth: the light's projection is
  // reversed too, so z/w is 1 - classic depth there
  lib.depth.fragmentShader = lib.depth.fragmentShader.replace(
    "float fragCoordZ = 0.5 * vHighPrecisionZW[0] / vHighPrecisionZW[1] + 0.5;",
    `#ifdef USE_REVERSEDEPTHBUF
	float fragCoordZ = 1.0 - vHighPrecisionZW[0] / vHighPrecisionZW[1];
#else
	float fragCoordZ = 0.5 * vHighPrecisionZW[0] / vHighPrecisionZW[1] + 0.5;
#endif`);
}

/** The sky dome sits on the far plane: depth 1 classically, 0 with reversed-Z. */
export function patchSkyVertex(src: string): string {
  return src.replace("gl_Position.z = gl_Position.w; // set z to camera.far",
    "#ifdef USE_REVERSEDEPTHBUF\n\t\t\tgl_Position.z = 0.0;\n\t\t\t#else\n\t\t\tgl_Position.z = gl_Position.w;\n\t\t\t#endif");
}

let reversed = false;
export function setReversed(on: boolean): void { reversed = on; }
export function isReversed(): boolean { return reversed; }

/** Polygon offset that pulls a decal toward the camera in either depth mode (the sign flips with reversed-Z). */
export function depthBias(m: THREE.Material, factor: number, units: number): void {
  m.polygonOffset = true;
  const s = reversed ? 1 : -1;
  m.polygonOffsetFactor = s * Math.abs(factor);
  m.polygonOffsetUnits = s * Math.abs(units);
}

/** GLSL for our own passes: classic depth (0 near .. 1 far) from a depth-buffer sample. */
export const DEPTH_GLSL = /* glsl */`
float classicDepth( float d ) {
#ifdef REVERSED_Z
  return 1.0 - d;
#else
  return d;
#endif
}`;
