// The shader patch every world material gets (MeshStandardMaterial + onBeforeCompile). On top of three.js's
// physically based shading it adds:
//  * the baked light volumes (sky / sun visibility and the map's fixtures, built by scripts/assets/maps.ts);
//  * the sun as one light with cascaded, soft shadows (shadows.ts) instead of three's one-light-per-shadow loop;
//  * a warm ground bounce: shaded walls pick up the orange of the sunlit earth around them;
//  * ambient occlusion on ambient light only: the baked per-vertex AO of the level geometry and the screen-space
//    AO (ssao.ts), bilaterally upsampled from half resolution so it does not bleed over edges;
//  * specular anti-aliasing (roughness widened where the normal varies within a pixel) and, close up, a second
//    finer layer of the material's own normal map so walls stay crisp;
//  * weathering in world space for the level: dust at the foot of walls, rain streaks below spouts and sills,
//    soot above tandoors, a damp band and sun-bleached tops on mud walls, plaster fallen off with brick behind it,
//    chipped paint on doors and shutters;
//  * a minimum fill on soldiers in dark rooms (a player in a doorway is never invisible);
//  * for thin pieces (wires, bars, grilles) a screen-door fade once they are thinner than a pixel, so they fade
//    out instead of flickering.
// Which parts compile depends on the material (level geometry carries the detail attribute) and on the graphics
// settings (shadow taps, PCSS, specular AA, detail normals, reversed-Z), all part of the program cache key.

import * as THREE from "three";
import { volumeUniforms } from "./assets";
import { SHADOW_GLSL, shadowUniforms } from "./shadows";
import { DEPTH_GLSL, isReversed } from "./depth";

export const aoUniforms = {
  tSSAO: { value: null as THREE.Texture | null },
  uSSAOParams: { value: new THREE.Vector4(1, 1, 0, 1) },       // 1/width, 1/height (full res), on, strength
  uSSAOCam: { value: new THREE.Vector2(0.1, 400) },            // main camera near, far
};

export const surfaceUniforms = {
  uBounceColor: { value: new THREE.Color(0, 0, 0) },           // irradiance from the sunlit ground on a vertical wall
  uDustColor: { value: new THREE.Color(0.62, 0.53, 0.42) },
  uProjScale: { value: 500 },                                  // pixels per metre at 1 m (thin-piece fade)
  uPlayerFill: { value: 0.18 },
  uWeather: { value: 1 },
};

/** Settings that change the compiled shaders. */
export const surfaceConfig = { taps: 8, pcss: true, specularAA: true, detailNormal: true, weather: true };
export function surfaceKey(): string {
  const c = surfaceConfig;
  return `cs-surf|${c.taps}|${c.pcss ? 1 : 0}|${c.specularAA ? 1 : 0}|${c.detailNormal ? 1 : 0}|${c.weather ? 1 : 0}|${isReversed() ? 1 : 0}`;
}

export type SurfaceKind = "mud" | "paint" | "glass" | "metal" | "wood" | "generic";
export function surfaceKind(name: string): SurfaceKind {
  if (/^(mud_|plaster|hedge|clay)/.test(name)) return "mud";
  if (/^(door_|metal_blue|metal_green|jingle_)/.test(name)) return "paint";
  if (/^glass/.test(name)) return "glass";
  if (/^(steel|pbr_chrome|gun_metal|brass|rust_metal|burnt_metal|tank_|diamond_plate|corrugated|container_)/.test(name)) return "metal";
  if (/^(wood|plywood|bark)/.test(name)) return "wood";
  return "generic";
}

const VERTEX_HEAD = /* glsl */`
uniform mat4 uZupFromWorld;
varying vec3 vVolPos;
#ifdef LEVEL_SURFACE
attribute vec4 detail;
varying vec4 vDetail;
#endif
`;
const VERTEX_BODY = /* glsl */`
{
  vec4 vp = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    vp = instanceMatrix * vp;
  #endif
  vVolPos = ( uZupFromWorld * modelMatrix * vp ).xyz;
  #ifdef LEVEL_SURFACE
  vDetail = detail;
  #endif
}
`;

const FRAGMENT_HEAD = /* glsl */`
uniform highp sampler3D uVolSky;
uniform highp sampler3D uVolLight;
uniform highp sampler3D uVolDir;
uniform vec3 uVolMin;
uniform vec3 uVolInvSize;
uniform float uLightScale;
uniform float uLightGain;
uniform float uBounce;
uniform mat3 uViewToZup;
uniform float uVolEnabled;
uniform sampler2D tSSAO;
uniform vec4 uSSAOParams;
uniform vec2 uSSAOCam;
uniform vec3 uBounceColor;
uniform vec3 uDustColor;
uniform float uProjScale;
uniform float uPlayerFill;
uniform float uWeather;
varying vec3 vVolPos;
#ifdef LEVEL_SURFACE
varying vec4 vDetail;
#endif
`;

// after <packing> and the shadow declarations: our functions
const FRAGMENT_FUNCS = /* glsl */`
${DEPTH_GLSL}
${SHADOW_GLSL}
float csHash( vec3 p ) { p = fract( p * 0.3183099 + 0.1 ); p *= 17.0; return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) ); }
float csNoise( vec3 x ) {
  vec3 i = floor( x ), f = fract( x );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( mix( csHash( i ), csHash( i + vec3( 1, 0, 0 ) ), f.x ), mix( csHash( i + vec3( 0, 1, 0 ) ), csHash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
              mix( mix( csHash( i + vec3( 0, 0, 1 ) ), csHash( i + vec3( 1, 0, 1 ) ), f.x ), mix( csHash( i + vec3( 0, 1, 1 ) ), csHash( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
}
float csIgn( vec2 p ) { return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) ); }
// screen-space AO, upsampled from half resolution with weights that ignore samples from another depth
float csSSAO() {
  if ( uSSAOParams.z < 0.5 ) return 1.0;
  vec2 lowSize = vec2( textureSize( tSSAO, 0 ) );
  vec2 pos = gl_FragCoord.xy * uSSAOParams.xy * lowSize - 0.5;
  vec2 f = fract( pos );
  vec2 base = ( floor( pos ) + 0.5 ) / lowSize;
  float z = vViewPosition.z;
  float sum = 0.0, wsum = 0.0;
  for ( int j = 0; j < 2; j ++ ) for ( int i = 0; i < 2; i ++ ) {
    vec2 uv = base + vec2( float( i ), float( j ) ) / lowSize;
    vec2 s = texture2D( tSSAO, uv ).rg;
    float ao = s.r, vz = s.g;
    float wb = ( i == 0 ? 1.0 - f.x : f.x ) * ( j == 0 ? 1.0 - f.y : f.y );
    float wd = 1.0 / ( 0.02 + abs( vz - z ) / max( z, 0.5 ) * 40.0 );
    sum += ao * wb * wd;
    wsum += wb * wd;
  }
  return mix( 1.0, sum / max( wsum, 1e-5 ), uSSAOParams.w );
}
`;

// weathering of the level's albedo / roughness (after the maps are read)
const FRAGMENT_WEATHER = /* glsl */`
#if defined( LEVEL_SURFACE ) && defined( WEATHER )
{
  vec3 wp = vVolPos;
  vec3 nG = normalize( uViewToZup * vNormal );
  float vertical = 1.0 - smoothstep( 0.45, 0.8, abs( nG.z ) );
  vec2 along = normalize( vec2( -nG.y, nG.x ) + 1e-4 );
  float u = dot( wp.xy, along );
  // dust gathered at the foot of walls and props
  if ( vDetail.y >= 0.0 ) {
    float dust = ( 1.0 - smoothstep( 0.0, 0.75, vDetail.y + ( csNoise( wp * 3.1 ) - 0.5 ) * 0.25 ) ) * vertical;
    dust *= 0.65 + 0.35 * csNoise( wp * 7.0 );
    diffuseColor.rgb = mix( diffuseColor.rgb, uDustColor * ( 0.85 + 0.3 * csNoise( wp * 13.0 ) ), dust * 0.6 * uWeather );
    roughnessFactor = mix( roughnessFactor, 1.0, dust * 0.5 );
  }
  // rain streaks: narrow vertical runs, strongest just below the source
  float streak = max( vDetail.z, 0.0 ) * vertical;
  if ( streak > 0.001 ) {
    float runs = smoothstep( 0.35, 0.85, csNoise( vec3( u * 11.0, wp.z * 0.45, 3.7 ) ) ) * ( 0.6 + 0.4 * csNoise( vec3( u * 31.0, wp.z * 2.0, 1.3 ) ) );
    float s = streak * runs * uWeather;
    diffuseColor.rgb *= 1.0 - 0.38 * s;
    roughnessFactor = mix( roughnessFactor, roughnessFactor * 0.8, s );
  }
  float soot = max( -vDetail.z, 0.0 );
  if ( soot > 0.001 ) diffuseColor.rgb *= 1.0 - 0.8 * soot * ( 0.6 + 0.4 * csNoise( wp * 4.0 ) ) * uWeather;
  #ifdef SURF_MUD
  {
    // a damp band at the base (darker, smoother), bleached tops where the sun bakes the wall
    if ( vDetail.y >= 0.0 ) {
      float damp = ( 1.0 - smoothstep( 0.05, 0.42 + 0.12 * csNoise( vec3( u * 2.0, 0.0, 9.0 ) ), vDetail.y ) ) * vertical;
      diffuseColor.rgb *= 1.0 - 0.18 * damp * uWeather;
      float top = smoothstep( 2.2, 3.6, vDetail.y ) * ( 0.5 + 0.5 * csNoise( wp * 1.7 ) );
      diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * 1.12 + 0.025, top * 0.5 * uWeather );
    }
    // plaster fallen off: patches where fired brick shows through, with a darker rim
    float patchN = csNoise( wp * vec3( 0.9, 0.9, 1.4 ) + 11.0 ) * 0.7 + csNoise( wp * 3.5 ) * 0.3;
    float patchM = smoothstep( 0.68, 0.72, patchN ) * vertical * uWeather;
    float rim = smoothstep( 0.63, 0.68, patchN ) * ( 1.0 - patchM ) * vertical * uWeather;
    if ( patchM > 0.0 ) {
      vec2 bp = vec2( u / 0.24, wp.z / 0.075 );
      bp.x += mod( floor( bp.y ), 2.0 ) * 0.5;
      vec2 fb = fract( bp );
      float mortar = 1.0 - smoothstep( 0.0, 0.08, min( min( fb.x, 1.0 - fb.x ) * 0.32, min( fb.y, 1.0 - fb.y ) ) );
      vec3 brick = vec3( 0.47, 0.30, 0.21 ) * ( 0.75 + 0.5 * csHash( floor( vec3( bp, 1.0 ) ) ) );
      vec3 b2 = mix( brick, vec3( 0.55, 0.5, 0.42 ), mortar );
      diffuseColor.rgb = mix( diffuseColor.rgb, b2, patchM );
      roughnessFactor = mix( roughnessFactor, 0.95, patchM );
    }
    diffuseColor.rgb *= 1.0 - 0.22 * rim;
  }
  #endif
  #ifdef SURF_PAINT
  {
    // chipped paint: bare weathered timber shows through in worn spots
    float chip = smoothstep( 0.66, 0.7, csNoise( wp * 9.0 ) * 0.6 + csNoise( wp * 31.0 ) * 0.4 ) * uWeather;
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.36, 0.27, 0.18 ) * ( 0.8 + 0.4 * csNoise( wp * 50.0 ) ), chip );
    roughnessFactor = mix( roughnessFactor, 0.9, chip );
    diffuseColor.rgb *= 0.92 + 0.08 * csNoise( wp * 2.0 );       // uneven, sun-faded paint
  }
  #endif
}
#endif
#ifdef THIN_FADE
{
  // a wire or bar thinner than a pixel: keep only its pixel-coverage worth of fragments (a stable screen door), so it
  // fades out smoothly with distance instead of flickering in and out between pixels
  float px = vDetail.w * uProjScale / max( vViewPosition.z, 0.1 );
  if ( px < 1.0 && csIgn( gl_FragCoord.xy ) > px ) discard;
}
#endif
#ifdef SURF_GLASS
  roughnessFactor = min( roughnessFactor, 0.08 );
#endif
`;

const FRAGMENT_NORMAL = /* glsl */`
#if defined( DETAIL_NORMAL ) && defined( USE_NORMALMAP_TANGENTSPACE )
{
  // a finer layer of the same normal map up close (fades out by 10 m), so surfaces stay crisp at arm's length
  float dfade = 1.0 - smoothstep( 3.0, 10.0, vViewPosition.z );
  if ( dfade > 0.0 ) {
    vec3 dn = texture2D( normalMap, vNormalMapUv * 4.37 + 0.31 ).xyz * 2.0 - 1.0;
    normal = normalize( normal + tbn * vec3( dn.xy * normalScale * 0.5 * dfade, 0.0 ) );
  }
}
#endif
`;

// sampled once, before the lights: the normal is known by then
const FRAGMENT_SAMPLE = /* glsl */`
vec3 volN = normalize( uViewToZup * normal );
vec3 volUvw = ( vVolPos + volN * 0.45 - uVolMin ) * uVolInvSize;
vec4 vol0 = uVolEnabled > 0.5 ? texture( uVolSky, volUvw ) : vec4( 1.0 );
// sky light that reaches enclosed spaces bounced off sunlit ground and walls: a floor under the sky term
float volSky = max( vol0.r, uBounce );
float volSun = vol0.g;
vec3 volLight = vec3( 0.0 );
if ( uVolEnabled > 0.5 ) {
  vec3 le = texture( uVolLight, volUvw ).rgb;
  vec3 ld = texture( uVolDir, volUvw ).rgb * 2.0 - 1.0;
  float wrap = length( ld ) > 0.2 ? 0.12 + 0.88 * max( dot( volN, normalize( ld ) ), 0.0 ) : 0.6;
  volLight = le * le * uLightScale * uLightGain * wrap;
}
`;

const FRAGMENT_SPEC_AA = /* glsl */`
#ifdef SPECULAR_AA
{
  // geometric specular anti-aliasing (Kaplanyan / Tokuyoshi): roughness grows with the normal's variance in the pixel
  vec3 du = dFdx( normal ), dv = dFdy( normal );
  float variance = 0.5 * ( dot( du, du ) + dot( dv, dv ) );
  float kernel = min( variance * 0.75, 0.22 );
  material.roughness = sqrt( clamp( material.roughness * material.roughness + kernel, 0.0, 1.0 ) );
}
#endif
`;

// the sun: one light, cascaded soft shadows, the baked sun visibility on top
const SUN_BLOCK = /* glsl */`
#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )
{
  DirectionalLight directionalLight = directionalLights[ 0 ];
  getDirectionalLightInfo( directionalLight, directLight );
  float sunShadow = 1.0;
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
  if ( receiveShadow ) sunShadow = csmShadow( vViewPosition.z );
  #endif
  directLight.color *= sunShadow * volSun;
  RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
}
#endif
`;

const FRAGMENT_APPLY = /* glsl */`
irradiance *= volSky;
#if defined( RE_IndirectSpecular )
  iblIrradiance *= volSky;
  radiance *= mix( volSky * volSky, 1.0, 0.15 );
#endif
irradiance += volLight;
// warm bounce from the sunlit ground: half of a wall's view is earth; outdoors only (the sky term says how open)
irradiance += uBounceColor * ( 0.5 - 0.5 * volN.z ) * vol0.r;
#ifdef USE_SKINNING
irradiance += vec3( uPlayerFill ) * ( 1.0 - vol0.r );
#endif
`;

const FRAGMENT_AO = /* glsl */`
#ifdef ORM_PACKED
{
  // the material's own occlusion, from the packed ORM texture (three's aoMap chunk, sharing the roughness sampler)
  float ormAO = texture2D( roughnessMap, vRoughnessMapUv ).r;
  reflectedLight.indirectDiffuse *= ormAO;
  #if defined( USE_ENVMAP ) && defined( STANDARD )
  reflectedLight.indirectSpecular *= computeSpecularOcclusion( saturate( dot( geometryNormal, geometryViewDir ) ), ormAO, material.roughness );
  #endif
}
#endif
{
  float aoX = csSSAO();
  #ifdef LEVEL_SURFACE
  aoX *= mix( 1.0, vDetail.x, 0.85 );
  #endif
  reflectedLight.indirectDiffuse *= aoX;
  reflectedLight.indirectSpecular *= mix( 1.0, aoX, 0.7 );
}
`;

const ORM_METAL = /* glsl */`
#ifdef ORM_PACKED
  metalnessFactor *= texture2D( roughnessMap, vRoughnessMapUv ).b;
#endif
`;

function directionalBlock(src: string): [number, number] {
  const start = src.indexOf("#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )");
  if (start < 0) return [-1, -1];
  const end = src.indexOf("#endif", src.indexOf("#pragma unroll_loop_end", start)) + "#endif".length;
  return [start, end];
}

export interface SurfaceOptions { level?: boolean; thin?: boolean; kind?: SurfaceKind }

/** Patch a standard material with everything above. */
export function withSurface<T extends THREE.MeshStandardMaterial>(material: T, o: SurfaceOptions = {}): T {
  const kind = o.kind ?? surfaceKind(material.name);
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, volumeUniforms, shadowUniforms, aoUniforms, surfaceUniforms);
    const c = surfaceConfig;
    const defs: string[] = [`#define CSM_TAPS ${c.taps}`];
    if (c.pcss) defs.push("#define CSM_PCSS");
    if (c.specularAA) defs.push("#define SPECULAR_AA");
    if (c.detailNormal && kind !== "glass" && kind !== "metal") defs.push("#define DETAIL_NORMAL");
    if (c.weather) defs.push("#define WEATHER");
    if (isReversed()) defs.push("#define REVERSED_Z");
    if (o.level) defs.push("#define LEVEL_SURFACE");
    if (o.level && o.thin) defs.push("#define THIN_FADE");
    if (material.userData.orm && material.roughnessMap) defs.push("#define ORM_PACKED");
    defs.push(`#define SURF_${kind.toUpperCase()}`);
    const head = defs.join("\n") + "\n";
    shader.vertexShader = head + VERTEX_HEAD + shader.vertexShader.replace("#include <project_vertex>", `#include <project_vertex>\n${VERTEX_BODY}`);
    let begin = THREE.ShaderChunk.lights_fragment_begin;
    const [a, b] = directionalBlock(begin);
    if (a >= 0) begin = begin.slice(0, a) + SUN_BLOCK + begin.slice(b);
    shader.fragmentShader = head + FRAGMENT_HEAD + shader.fragmentShader
      .replace("#include <shadowmap_pars_fragment>", `#include <shadowmap_pars_fragment>\n${FRAGMENT_FUNCS}`)
      .replace("#include <metalnessmap_fragment>", `#include <metalnessmap_fragment>\n${ORM_METAL}\n${FRAGMENT_WEATHER}`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>\n${FRAGMENT_NORMAL}`)
      .replace("#include <lights_physical_fragment>", `${FRAGMENT_SAMPLE}\n#include <lights_physical_fragment>\n${FRAGMENT_SPEC_AA}`)
      .replace("#include <lights_fragment_begin>", begin)
      .replace("#include <lights_fragment_end>", `${FRAGMENT_APPLY}\n#include <lights_fragment_end>`)
      .replace("#include <aomap_fragment>", `#include <aomap_fragment>\n${FRAGMENT_AO}`);
  };
  material.customProgramCacheKey = () => `${surfaceKey()}|${o.level ? 1 : 0}|${o.thin ? 1 : 0}|${kind}`;
  return material;
}
