// Eye adaptation, as the desktop renderer did it: the view brightens in a dark room and darkens again
// outside, by a fraction of the difference, so a room still reads darker than the yard.
// All on the GPU, no read-back: the HDR scene's centre-weighted log-luminance goes into a 64x64 target,
// is reduced to 1x1 (a geometric mean, robust against small bright spots), moves toward this frame's value
// in a ping-pong pair of 1x1 targets (faster when it gets brighter, like the eye), and scales the scene
// before bloom and tone mapping. Settings: the map's environment.post.auto_exposure.

import * as THREE from "three";
import { FullScreenQuad, Pass } from "three/examples/jsm/postprocessing/Pass.js";

export interface AutoExposureSettings { strength: number; min_ev: number; max_ev: number; reference: number; speed_up: number; speed_down: number }
export const AE_DEFAULTS: AutoExposureSettings = { strength: 0.55, min_ev: -1.0, max_ev: 1.2, reference: -1.6, speed_up: 3.0, speed_down: 1.1 };

const VERT = /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }`;

const LUM = /* glsl */`
uniform sampler2D tScene; uniform vec2 cell; varying vec2 vUv;
void main() {
  vec2 origin = vUv - cell * 0.5;
  float sum = 0.0;
  for ( int y = 0; y < 4; ++y ) for ( int x = 0; x < 4; ++x ) {
    vec3 c = textureLod( tScene, origin + ( vec2( x, y ) + 0.5 ) * 0.25 * cell, 0.0 ).rgb;
    sum += clamp( log2( max( dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-5 ) ), -12.0, 8.0 );
  }
  vec2 d = ( vUv - 0.5 ) * vec2( 1.6, 1.0 );
  float w = 1.0 + 2.0 * exp( -dot( d, d ) * 6.0 );     // the eye adapts mostly to what you look at
  gl_FragColor = vec4( w * sum / 16.0, w, 0.0, 1.0 );
}`;

// each output texel sums a 4x4 block of the input (r: weighted log-luminance, g: weight)
const REDUCE = /* glsl */`
uniform sampler2D tIn;
void main() {
  ivec2 o = ivec2( gl_FragCoord.xy ) * 4;
  vec2 s = vec2( 0.0 );
  for ( int y = 0; y < 4; ++y ) for ( int x = 0; x < 4; ++x ) s += texelFetch( tIn, o + ivec2( x, y ), 0 ).rg;
  gl_FragColor = vec4( s, 0.0, 1.0 );
}`;

const ADAPT = /* glsl */`
uniform sampler2D tAvg; uniform sampler2D tPrev; uniform vec3 rates;
void main() {
  vec2 a = texelFetch( tAvg, ivec2( 0 ), 0 ).rg;
  float target = a.r / max( a.g, 1e-4 );
  float prev = texelFetch( tPrev, ivec2( 0 ), 0 ).r;
  float v = rates.z > 0.5 ? target : mix( prev, target, target > prev ? rates.x : rates.y );
  gl_FragColor = vec4( v, target, 0.0, 1.0 );
}`;

const APPLY = /* glsl */`
uniform sampler2D tDiffuse; uniform sampler2D tAdapt; uniform vec4 params; uniform float brightness; varying vec2 vUv;
// params: x reference log-luminance, y strength, z min EV, w max EV
void main() {
  float ev = clamp( ( params.x - texelFetch( tAdapt, ivec2( 0 ), 0 ).r ) * params.y, params.z, params.w ) + brightness;
  vec4 c = texture2D( tDiffuse, vUv );
  gl_FragColor = vec4( c.rgb * exp2( ev ), c.a );
}`;

function target(size: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(size, size, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter, depthBuffer: false });
}

export class AutoExposurePass extends Pass {
  /** The player's brightness setting, in EV on top of the adaptation. */
  brightness = 0;

  private lumRT = target(64);
  private reduceRT = [target(16), target(4), target(1)];
  private adaptRT = [target(1), target(1)];
  private cur = 0;
  private reset = 3;
  private lumMat: THREE.ShaderMaterial;
  private reduceMat: THREE.ShaderMaterial;
  private adaptMat: THREE.ShaderMaterial;
  private applyMat: THREE.ShaderMaterial;
  private quad = new FullScreenQuad();

  constructor(public settings: AutoExposureSettings) {
    super();
    const mat = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false });
    this.lumMat = mat(LUM, { tScene: { value: null }, cell: { value: new THREE.Vector2(1 / 64, 1 / 64) } });
    this.reduceMat = mat(REDUCE, { tIn: { value: null } });
    this.adaptMat = mat(ADAPT, { tAvg: { value: null }, tPrev: { value: null }, rates: { value: new THREE.Vector3() } });
    this.applyMat = mat(APPLY, { tDiffuse: { value: null }, tAdapt: { value: null }, params: { value: new THREE.Vector4() }, brightness: { value: 0 } });
  }

  /** Snap to the current view at once (after a respawn or a teleport). */
  resetAdaptation(): void { this.reset = 3; }

  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget, deltaTime: number): void {
    const s = this.settings;
    const draw = (m: THREE.ShaderMaterial, to: THREE.WebGLRenderTarget | null) => {
      this.quad.material = m;
      renderer.setRenderTarget(to);
      this.quad.render(renderer);
    };
    this.lumMat.uniforms.tScene.value = readBuffer.texture;
    draw(this.lumMat, this.lumRT);
    let src = this.lumRT;
    for (const rt of this.reduceRT) {
      this.reduceMat.uniforms.tIn.value = src.texture;
      draw(this.reduceMat, rt);
      src = rt;
    }
    const nxt = 1 - this.cur;
    const dt = Math.max(0, Math.min(deltaTime || 0, 0.25));
    this.adaptMat.uniforms.tAvg.value = src.texture;
    this.adaptMat.uniforms.tPrev.value = this.adaptRT[this.cur].texture;
    this.adaptMat.uniforms.rates.value.set(1 - Math.exp(-dt * s.speed_up), 1 - Math.exp(-dt * s.speed_down), this.reset > 0 ? 1 : 0);
    draw(this.adaptMat, this.adaptRT[nxt]);
    this.cur = nxt;
    this.reset = Math.max(0, this.reset - 1);
    this.applyMat.uniforms.tDiffuse.value = readBuffer.texture;
    this.applyMat.uniforms.tAdapt.value = this.adaptRT[nxt].texture;
    this.applyMat.uniforms.params.value.set(s.reference, s.strength, s.min_ev, s.max_ev);
    this.applyMat.uniforms.brightness.value = this.brightness;
    draw(this.applyMat, this.renderToScreen ? null : writeBuffer);
  }

  /** [adapted, this frame's] mean log2 luminance and the exposure in EV, for tuning (reads the GPU back). */
  probe(renderer: THREE.WebGLRenderer): { adapted: number; current: number; ev: number } {
    const px = new Uint16Array(4);
    renderer.readRenderTargetPixels(this.adaptRT[this.cur], 0, 0, 1, 1, px);
    const adapted = THREE.DataUtils.fromHalfFloat(px[0]), current = THREE.DataUtils.fromHalfFloat(px[1]);
    const s = this.settings;
    return { adapted, current, ev: Math.max(s.min_ev, Math.min(s.max_ev, (s.reference - adapted) * s.strength)) };
  }

  override dispose(): void {
    for (const rt of [this.lumRT, ...this.reduceRT, ...this.adaptRT]) rt.dispose();
    for (const m of [this.lumMat, this.reduceMat, this.adaptMat, this.applyMat]) m.dispose();
    this.quad.dispose();
  }
}
