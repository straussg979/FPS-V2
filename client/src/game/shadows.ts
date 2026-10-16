// Sun shadows: cascaded shadow maps with stable, texel-snapped cascades and soft (PCSS-style) filtering.
//
// Cascades. The view frustum is cut into 1-4 slices ("practical" split: a mix of logarithmic and uniform); each
// slice gets its own directional shadow map fitted to the slice's bounding sphere. A sphere does not change size
// when the view turns, and the sphere's centre is snapped to the shadow map's texel grid in light space, so the
// shadow edges do not crawl or shimmer while you move or look around. Normal bias scales with each cascade's texel
// size (wide cascades need more), so walls show no acne stripes near or far and contact shadows stay attached.
//
// Filtering. One light (cascade 0) carries the sun's light; the others only carry shadow maps (intensity 0). The
// material patch (surface.ts) replaces three.js's per-light shadow loop with csmShadow(): pick the cascade by view
// depth, blend into the next one across the last 12 % of a slice (no seams), and filter with a Vogel disk of
// shadow_pcf_taps taps rotated per pixel. On medium and up a short blocker search first measures how far the
// occluder is: the penumbra widens with that distance (sharp at a wall's foot, soft at the end of a long shadow).

import * as THREE from "three";

export interface ShadowConfig { cascades: number; size: number; distance: number; taps: number; softness: number; pcss: boolean }

const UP = new THREE.Vector3(0, 1, 0);

export const shadowUniforms = {
  csmSplits: { value: new THREE.Vector4(1e4, 1e4, 1e4, 1e4) },       // far end of each slice (view depth, metres)
  csmTexelWorld: { value: new THREE.Vector4(0.05, 0.05, 0.05, 0.05) }, // metres per shadow texel
  csmDepthRange: { value: new THREE.Vector4(100, 100, 100, 100) },     // light camera far - near (depth 0..1 -> metres)
  csmSoftness: { value: 0.02 },                                        // penumbra width per metre of occluder distance
};

/** GLSL for the patched lights loop (surface.ts); CSM_TAPS and CSM_PCSS come from defines. */
export const SHADOW_GLSL = /* glsl */`
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
uniform vec4 csmSplits;
uniform vec4 csmTexelWorld;
uniform vec4 csmDepthRange;
uniform float csmSoftness;
float csmIgn( vec2 p ) { return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) ); }
vec2 csmVogel( int i, int n, float phi ) {
  float r = sqrt( ( float( i ) + 0.5 ) / float( n ) );
  float t = float( i ) * 2.39996323 + phi;
  return r * vec2( cos( t ), sin( t ) );
}
float csmSoft( sampler2D map, vec2 size, float bias, vec4 coord, float texelWorld, float depthRange ) {
  coord.xyz /= coord.w;
  coord.z += bias;
  if ( coord.x < 0.0 || coord.x > 1.0 || coord.y < 0.0 || coord.y > 1.0 || coord.z > 1.0 ) return 1.0;
  vec2 texel = 1.0 / size;
  float phi = csmIgn( gl_FragCoord.xy ) * 6.2831853;
  float radius = 1.0;
#ifdef CSM_PCSS
  // blocker search over about 0.6 m: how far is the occluder?
  float search = clamp( 0.6 / texelWorld, 1.5, 10.0 );
  float sum = 0.0, n = 0.0;
  for ( int i = 0; i < 6; i ++ ) {
    float d = unpackRGBAToDepth( texture2D( map, coord.xy + csmVogel( i, 6, phi ) * search * texel ) );
    if ( d < coord.z ) { sum += d; n += 1.0; }
  }
  if ( n == 0.0 ) return 1.0;
  float dist = ( coord.z - sum / n ) * depthRange;
  radius = clamp( dist * csmSoftness / texelWorld, 1.0, 8.0 );
#endif
  float lit = 0.0;
  for ( int i = 0; i < CSM_TAPS; i ++ ) {
    lit += step( coord.z, unpackRGBAToDepth( texture2D( map, coord.xy + csmVogel( i, CSM_TAPS, phi ) * radius * texel ) ) );
  }
  return lit / float( CSM_TAPS );
}
#define CSM_LOOKUP( i, t, r ) csmSoft( directionalShadowMap[ i ], directionalLightShadows[ i ].shadowMapSize, directionalLightShadows[ i ].shadowBias, vDirectionalShadowCoord[ i ], t, r )
float csmShadow( float depth ) {
  float s0, s1, b;
  if ( depth < csmSplits.x ) {
    s0 = CSM_LOOKUP( 0, csmTexelWorld.x, csmDepthRange.x );
    b = smoothstep( csmSplits.x * 0.88, csmSplits.x, depth );
    if ( b <= 0.0 ) return s0;
#if NUM_DIR_LIGHT_SHADOWS > 1
    s1 = CSM_LOOKUP( 1, csmTexelWorld.y, csmDepthRange.y );
#else
    s1 = 1.0;
#endif
    return mix( s0, s1, b );
  }
#if NUM_DIR_LIGHT_SHADOWS > 1
  if ( depth < csmSplits.y ) {
    s0 = CSM_LOOKUP( 1, csmTexelWorld.y, csmDepthRange.y );
    b = smoothstep( mix( csmSplits.x, csmSplits.y, 0.88 ), csmSplits.y, depth );
    if ( b <= 0.0 ) return s0;
  #if NUM_DIR_LIGHT_SHADOWS > 2
    s1 = CSM_LOOKUP( 2, csmTexelWorld.z, csmDepthRange.z );
  #else
    s1 = 1.0;
  #endif
    return mix( s0, s1, b );
  }
#endif
#if NUM_DIR_LIGHT_SHADOWS > 2
  if ( depth < csmSplits.z ) {
    s0 = CSM_LOOKUP( 2, csmTexelWorld.z, csmDepthRange.z );
    b = smoothstep( mix( csmSplits.y, csmSplits.z, 0.88 ), csmSplits.z, depth );
    if ( b <= 0.0 ) return s0;
  #if NUM_DIR_LIGHT_SHADOWS > 3
    s1 = CSM_LOOKUP( 3, csmTexelWorld.w, csmDepthRange.w );
  #else
    s1 = 1.0;
  #endif
    return mix( s0, s1, b );
  }
#endif
#if NUM_DIR_LIGHT_SHADOWS > 3
  if ( depth < csmSplits.w ) {
    s0 = CSM_LOOKUP( 3, csmTexelWorld.w, csmDepthRange.w );
    b = smoothstep( mix( csmSplits.z, csmSplits.w, 0.88 ), csmSplits.w, depth );
    return mix( s0, 1.0, b );
  }
#endif
  return 1.0;
}
#endif
`;

/** The cascade lights, refitted every frame to the camera. Lives in the scene (three's Y-up world space). */
export class SunShadows {
  lights: THREE.DirectionalLight[] = [];
  cfg: ShadowConfig;
  private corners = Array.from({ length: 8 }, () => new THREE.Vector3());
  private c = new THREE.Vector3();
  private x = new THREE.Vector3();
  private y = new THREE.Vector3();
  private z = new THREE.Vector3();
  /** The far end of each cascade from the last update (view distance, metres). */
  splitsOut: number[] = [];

  constructor(private scene: THREE.Scene, private dirWorld: THREE.Vector3, private color: THREE.Color, private intensity: number, cfg: ShadowConfig) {
    this.cfg = { ...cfg };
    this.build();
  }

  /** The sun light (cascade 0) - the one that lights things. */
  get sun(): THREE.DirectionalLight { return this.lights[0]; }

  configure(cfg: ShadowConfig): boolean {
    const rebuild = cfg.cascades !== this.cfg.cascades || cfg.size !== this.cfg.size;
    this.cfg = { ...cfg };
    shadowUniforms.csmSoftness.value = 0.02 * cfg.softness;
    if (rebuild) this.build();
    return rebuild;
  }

  setEnabled(on: boolean): void { for (const l of this.lights) l.castShadow = on; }

  private build(): void {
    for (const l of this.lights) {
      l.shadow.map?.dispose();
      this.scene.remove(l, l.target);
    }
    this.lights = [];
    const n = Math.max(1, Math.min(4, Math.round(this.cfg.cascades)));
    for (let i = 0; i < n; i++) {
      const l = new THREE.DirectionalLight(this.color, i === 0 ? this.intensity : 0);
      l.name = `sun:cascade${i}`;
      l.castShadow = true;
      l.layers.enableAll();                 // lights obey camera layers too: the backdrop camera needs the sun
      l.shadow.mapSize.set(this.cfg.size, this.cfg.size);
      l.shadow.bias = -0.00015;
      l.shadow.camera.near = 0.5;
      this.scene.add(l, l.target);
      this.lights.push(l);
    }
    shadowUniforms.csmSoftness.value = 0.02 * this.cfg.softness;
  }

  /** Slice ends: a practical split (75 % logarithmic, 25 % uniform) from 1 m to the shadow distance. */
  private splits(): number[] {
    const n = this.lights.length, d = this.cfg.distance, near = 1;
    const out: number[] = [];
    for (let i = 1; i <= n; i++) {
      const log = near * Math.pow(d / near, i / n), uni = near + (d - near) * i / n;
      out.push(0.75 * log + 0.25 * uni);
    }
    out[n - 1] = d;
    return out;
  }

  /** Fit every cascade to its slice of `camera` (world space). */
  update(camera: THREE.PerspectiveCamera): void {
    const n = this.lights.length;
    this.splitsOut = this.splits();
    const sp = shadowUniforms.csmSplits.value, tw = shadowUniforms.csmTexelWorld.value, dr = shadowUniforms.csmDepthRange.value;
    const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2), tanX = tanY * camera.aspect;
    camera.updateMatrixWorld();
    const mw = camera.matrixWorld;
    // the light's frame exactly as LightShadow builds it (Matrix4.lookAt with world up), for texel snapping
    this.z.copy(this.dirWorld).normalize();                        // from the scene toward the sun (eye - target)
    this.x.crossVectors(UP, this.z);
    if (this.x.lengthSq() < 1e-8) this.x.set(1, 0, 0);
    this.x.normalize();
    this.y.crossVectors(this.z, this.x);
    let prev = 0.1;
    for (let i = 0; i < n; i++) {
      const a = prev, b = this.splitsOut[i];
      prev = b;
      // bounding sphere of the slice: centre on the view axis, radius to the far corners (rotation invariant)
      let k = 0;
      for (const d of [a, b]) for (const sx of [-1, 1]) for (const sy of [-1, 1]) this.corners[k++].set(sx * tanX * d, sy * tanY * d, -d);
      const ra2 = (tanX * tanX + tanY * tanY) * a * a, rb2 = (tanX * tanX + tanY * tanY) * b * b;
      let zc = (b * b + rb2 - a * a - ra2) / (2 * (b - a));
      zc = Math.min(b, Math.max(a, zc));
      const radius = Math.sqrt(Math.max((b - zc) * (b - zc) + rb2, (zc - a) * (zc - a) + ra2)) * 1.02;
      this.c.set(0, 0, -zc).applyMatrix4(mw);
      const size = this.cfg.size;
      const texel = (2 * radius) / size;
      // snap the centre to whole texels in the light's x / y
      const cx = Math.floor(this.c.dot(this.x) / texel) * texel, cy = Math.floor(this.c.dot(this.y) / texel) * texel, cz = this.c.dot(this.z);
      this.c.set(0, 0, 0).addScaledVector(this.x, cx).addScaledVector(this.y, cy).addScaledVector(this.z, cz);
      const back = 70;                                              // casters up to 70 m toward the sun still count
      const l = this.lights[i];
      l.target.position.copy(this.c);
      l.position.copy(this.c).addScaledVector(this.z, radius + back);
      l.target.updateMatrixWorld();
      l.updateMatrixWorld();
      const cam = l.shadow.camera;
      cam.left = -radius; cam.right = radius; cam.top = radius; cam.bottom = -radius;
      cam.near = 0.5;
      cam.far = 2 * radius + back;
      cam.updateProjectionMatrix();
      // acne-free at every cascade: offset the lookup along the normal by ~1.5 texels, plus a small depth bias
      l.shadow.normalBias = texel * 1.5;
      l.shadow.bias = -0.00008 * (i + 1);
      sp.setComponent(i, b);
      tw.setComponent(i, texel);
      dr.setComponent(i, cam.far - cam.near);
    }
    for (let i = n; i < 4; i++) { sp.setComponent(i, 1e4); tw.setComponent(i, tw.getComponent(n - 1)); dr.setComponent(i, dr.getComponent(n - 1)); }
  }
}
