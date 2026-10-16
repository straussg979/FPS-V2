// Screen-space ambient occlusion, computed before the main pass so the materials can apply it to ambient light only
// (surface.ts) instead of darkening the finished image (sunlit surfaces keep their contrast, and the AO never
// paints dark halos over the sky or the first-person weapon).
//  1. a half-resolution pre-pass of the scene's opaque geometry: view-space normals plus depth;
//  2. normal-oriented hemisphere sampling around every pixel (8 / 12 / 16 samples by quality, 0.55-0.8 m radius),
//     with a range check so distant geometry does not occlude, rotated by a per-pixel interleaved-gradient angle;
//  3. a depth-aware 4x4 blur that smooths the rotation noise without crossing edges.
// The materials read the result (AO in r, view depth in g) and upsample bilaterally. Low quality = off.

import * as THREE from "three";
import { FullScreenQuad, Pass } from "three/examples/jsm/postprocessing/Pass.js";
import { DEPTH_GLSL, isReversed } from "./depth";
import { aoUniforms } from "./surface";

export type AoLevel = "off" | "low" | "medium" | "high";

const VERT = /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }`;

const AO_FRAG = /* glsl */`
#include <packing>
${DEPTH_GLSL}
uniform sampler2D tNormal; uniform sampler2D tDepth; uniform mat4 proj; uniform mat4 projInv; uniform vec2 size;
uniform float radius; uniform float near; uniform float far; uniform vec3 kernel[ SAMPLES ];
varying vec2 vUv;
vec3 viewPos( vec2 uv, float d ) {
  vec4 c = vec4( vec3( uv, classicDepth( d ) ) * 2.0 - 1.0, 1.0 );
  vec4 v = projInv * c;
  return v.xyz / v.w;
}
float ign( vec2 p ) { return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) ); }
void main() {
  float d = texture2D( tDepth, vUv ).r;
  if ( classicDepth( d ) >= 0.99999 ) { gl_FragColor = vec4( 1.0 ); return; }
  vec3 P = viewPos( vUv, d );
  vec3 N = normalize( texture2D( tNormal, vUv ).xyz * 2.0 - 1.0 );
  float a = ign( gl_FragCoord.xy ) * 6.2831853;
  vec3 rnd = vec3( cos( a ), sin( a ), 0.0 );
  vec3 T = normalize( rnd - N * dot( rnd, N ) );
  vec3 B = cross( N, T );
  mat3 tbn = mat3( T, B, N );
  float occ = 0.0;
  for ( int i = 0; i < SAMPLES; i ++ ) {
    vec3 S = P + tbn * kernel[ i ] * radius;
    vec4 o = proj * vec4( S, 1.0 );
    vec2 uv = o.xy / o.w * 0.5 + 0.5;
    if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) continue;
    float sd = texture2D( tDepth, uv ).r;
    float sz = perspectiveDepthToViewZ( classicDepth( sd ), near, far );
    float range = smoothstep( 0.0, 1.0, radius / max( abs( P.z - sz ), 1e-4 ) );
    occ += ( sz >= S.z + 0.025 ? 1.0 : 0.0 ) * range;
  }
  float ao = clamp( 1.0 - occ / float( SAMPLES ), 0.0, 1.0 );
  gl_FragColor = vec4( ao * ao, 0.0, 0.0, 1.0 );
}`;

const BLUR_FRAG = /* glsl */`
#include <packing>
${DEPTH_GLSL}
uniform sampler2D tAO; uniform sampler2D tDepth; uniform vec2 size; uniform float near; uniform float far;
varying vec2 vUv;
float lin( vec2 uv ) { return - perspectiveDepthToViewZ( classicDepth( texture2D( tDepth, uv ).r ), near, far ); }
void main() {
  float z0 = lin( vUv );
  float sum = 0.0, w = 0.0;
  for ( int y = -2; y < 2; y ++ ) for ( int x = -2; x < 2; x ++ ) {
    vec2 uv = vUv + ( vec2( float( x ), float( y ) ) + 0.5 ) / size;
    float wz = 1.0 / ( 0.02 + abs( lin( uv ) - z0 ) / max( z0, 0.5 ) * 30.0 );
    sum += texture2D( tAO, uv ).r * wz;
    w += wz;
  }
  // g carries this pixel's view depth, so the materials' upsample needs no second texture (one sampler fewer)
  gl_FragColor = vec4( sum / w, z0, 0.0, 1.0 );
}`;

/** Sits first in the composer; it renders into its own targets and leaves the image buffers alone. */
export class SSAOPass extends Pass {
  level: AoLevel = "off";
  private normalRT: THREE.WebGLRenderTarget;
  private aoRT: THREE.WebGLRenderTarget;
  private blurRT: THREE.WebGLRenderTarget;
  private normalMat = new THREE.MeshNormalMaterial();
  private aoMat: THREE.ShaderMaterial | null = null;
  private blurMat: THREE.ShaderMaterial;
  private quad = new FullScreenQuad();
  private aoCam = new THREE.PerspectiveCamera();
  private samples = 0;
  private w = 1;
  private h = 1;
  private clearTmp = new THREE.Color();

  constructor(private scene: THREE.Scene, private camera: THREE.PerspectiveCamera, private layers: THREE.Layers) {
    super();
    this.needsSwap = false;
    const depth = new THREE.DepthTexture(1, 1, isReversed() ? THREE.FloatType : THREE.UnsignedIntType);
    this.normalRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthTexture: depth, depthBuffer: true });
    this.aoRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.blurRT = this.aoRT.clone();
    this.blurMat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: BLUR_FRAG, depthTest: false, depthWrite: false,
      defines: isReversed() ? { REVERSED_Z: 1 } : {},
      uniforms: { tAO: { value: this.aoRT.texture }, tDepth: { value: depth }, size: { value: new THREE.Vector2() }, near: { value: 0.1 }, far: { value: 400 } } });
    this.enabled = false;
  }

  setLevel(level: AoLevel): void {
    this.level = level;
    this.enabled = level !== "off";
    aoUniforms.uSSAOParams.value.z = this.enabled ? 1 : 0;
    const samples = level === "low" ? 8 : level === "medium" ? 12 : 16;
    if (this.enabled && samples !== this.samples) this.makeAoMat(samples);
  }

  private makeAoMat(samples: number): void {
    this.samples = samples;
    this.aoMat?.dispose();
    // hemisphere kernel, denser toward the centre
    const kernel: THREE.Vector3[] = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < samples; i++) {
      const v = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 0.85 + 0.15).normalize();
      const s = (i + 1) / samples;
      v.multiplyScalar(0.15 + 0.85 * s * s);
      kernel.push(v);
    }
    this.aoMat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: AO_FRAG, depthTest: false, depthWrite: false,
      defines: { SAMPLES: samples, ...(isReversed() ? { REVERSED_Z: 1 } : {}) },
      uniforms: { tNormal: { value: this.normalRT.texture }, tDepth: { value: this.normalRT.depthTexture }, proj: { value: new THREE.Matrix4() },
        projInv: { value: new THREE.Matrix4() }, size: { value: new THREE.Vector2() }, radius: { value: 0.65 }, near: { value: 0.1 }, far: { value: 400 },
        kernel: { value: kernel } } });
  }

  override setSize(width: number, height: number): void {
    // composer sizes are in device pixels already
    this.w = Math.max(1, Math.round(width / 2));
    this.h = Math.max(1, Math.round(height / 2));
    for (const rt of [this.normalRT, this.aoRT, this.blurRT]) rt.setSize(this.w, this.h);
    aoUniforms.uSSAOParams.value.x = 1 / width;
    aoUniforms.uSSAOParams.value.y = 1 / height;
  }

  override render(renderer: THREE.WebGLRenderer): void {
    if (!this.enabled || !this.aoMat) return;
    const cam = this.aoCam;
    cam.fov = this.camera.fov; cam.aspect = this.camera.aspect; cam.near = this.camera.near; cam.far = this.camera.far;
    cam.projectionMatrix.copy(this.camera.projectionMatrix);
    cam.projectionMatrixInverse.copy(this.camera.projectionMatrixInverse);
    cam.layers.mask = this.layers.mask;
    // the main camera hangs under the Z-up root: use its world transform
    this.camera.matrixWorld.decompose(cam.position, cam.quaternion, cam.scale);
    cam.updateMatrixWorld(true);
    // 1: normals + depth of the opaque scene at half resolution (no shadow-map redraw)
    const prevOverride = this.scene.overrideMaterial, prevBg = this.scene.background;
    this.scene.overrideMaterial = this.normalMat;
    this.scene.background = null;
    renderer.getClearColor(this.clearTmp);
    const prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x7f7fff, 1);
    renderer.setRenderTarget(this.normalRT);
    renderer.clear(true, true, false);
    const needs = renderer.shadowMap.needsUpdate;
    renderer.shadowMap.needsUpdate = false;
    renderer.render(this.scene, cam);
    renderer.shadowMap.needsUpdate = needs;
    this.scene.overrideMaterial = prevOverride;
    this.scene.background = prevBg;
    renderer.setClearColor(this.clearTmp, prevAlpha);
    // 2: AO
    const u = this.aoMat.uniforms;
    u.proj.value.copy(this.camera.projectionMatrix);
    u.projInv.value.copy(this.camera.projectionMatrixInverse);
    u.size.value.set(this.w, this.h);
    u.near.value = this.camera.near;
    u.far.value = this.camera.far;
    u.radius.value = this.level === "high" ? 0.8 : this.level === "medium" ? 0.7 : 0.55;
    this.quad.material = this.aoMat;
    renderer.setRenderTarget(this.aoRT);
    this.quad.render(renderer);
    // 3: depth-aware blur
    const b = this.blurMat.uniforms;
    b.size.value.set(this.w, this.h);
    b.near.value = this.camera.near;
    b.far.value = this.camera.far;
    this.quad.material = this.blurMat;
    renderer.setRenderTarget(this.blurRT);
    this.quad.render(renderer);
    aoUniforms.tSSAO.value = this.blurRT.texture;
    aoUniforms.uSSAOCam.value.set(this.camera.near, this.camera.far);
  }

  override dispose(): void {
    for (const rt of [this.normalRT, this.aoRT, this.blurRT]) rt.dispose();
    this.aoMat?.dispose();
    this.blurMat.dispose();
    this.normalMat.dispose();
    this.quad.dispose();
  }
}
