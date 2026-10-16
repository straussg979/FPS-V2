// Atmosphere on high / ultra: light shafts and dust motes.
//
// Light shafts. For every pixel (at half resolution) the view ray is marched from the camera to the scene, up to
// 35 m, in 20 jittered steps; each step asks the sun's cascaded shadow maps whether that point of air is in sunlight
// and, if so, adds in-scattered sunlight (a Henyey-Greenstein forward-scattering phase, so the shafts glow most
// looking toward the sun). Outdoors that is a light haze in the sunlit air; in a dark room it is the visible beam
// through a doorway or window. A full-resolution pass upsamples it and adds it to the HDR image before exposure,
// bloom and tone mapping.
//
// Dust motes. A few hundred specks drift in a box that follows the camera; each one is drawn only where the sun
// reaches it (the same shadow lookup), so they sparkle in the beams and vanish in the shade.

import * as THREE from "three";
import { FullScreenQuad, Pass } from "three/examples/jsm/postprocessing/Pass.js";
import { DEPTH_GLSL, isReversed } from "./depth";
import type { SunShadows } from "./shadows";

const VERT = /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }`;

const SHADOW_FUNCS = /* glsl */`
uniform sampler2D shadowMap[ CASCADES ];
uniform mat4 shadowMatrix[ CASCADES ];
uniform vec4 splits;
float sunAt( vec3 wp, float dist ) {
  int c = dist < splits.x ? 0 : dist < splits.y ? 1 : dist < splits.z ? 2 : dist < splits.w ? 3 : 4;
  vec4 sc;
  float d = 1.0;
#if CASCADES > 0
  if ( c == 0 ) { sc = shadowMatrix[ 0 ] * vec4( wp, 1.0 ); d = unpackRGBAToDepth( texture2D( shadowMap[ 0 ], sc.xy ) ); }
#endif
#if CASCADES > 1
  else if ( c == 1 ) { sc = shadowMatrix[ 1 ] * vec4( wp, 1.0 ); d = unpackRGBAToDepth( texture2D( shadowMap[ 1 ], sc.xy ) ); }
#endif
#if CASCADES > 2
  else if ( c == 2 ) { sc = shadowMatrix[ 2 ] * vec4( wp, 1.0 ); d = unpackRGBAToDepth( texture2D( shadowMap[ 2 ], sc.xy ) ); }
#endif
#if CASCADES > 3
  else if ( c == 3 ) { sc = shadowMatrix[ 3 ] * vec4( wp, 1.0 ); d = unpackRGBAToDepth( texture2D( shadowMap[ 3 ], sc.xy ) ); }
#endif
  else return 1.0;
  if ( sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 ) return 1.0;
  return sc.z - 0.002 <= d ? 1.0 : 0.0;
}`;

const MARCH = /* glsl */`
#include <packing>
${DEPTH_GLSL}
${SHADOW_FUNCS}
uniform sampler2D tDepth; uniform mat4 projInv; uniform mat4 camWorld; uniform vec3 sunDir; uniform float density; uniform float maxDist;
varying vec2 vUv;
float ign( vec2 p ) { return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) ); }
void main() {
  float d = classicDepth( texture2D( tDepth, vUv ).r );
  vec4 v = projInv * vec4( vec3( vUv, d ) * 2.0 - 1.0, 1.0 );
  vec3 viewP = v.xyz / v.w;
  float dist = min( length( viewP ), maxDist );
  if ( d >= 0.99999 ) dist = maxDist;
  vec3 dirV = normalize( viewP );
  vec3 dirW = normalize( ( camWorld * vec4( dirV, 0.0 ) ).xyz );
  vec3 origin = ( camWorld * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
  const int STEPS = 20;
  float stepLen = dist / float( STEPS );
  float t = stepLen * ign( gl_FragCoord.xy );
  float lit = 0.0;
  for ( int i = 0; i < STEPS; i ++ ) {
    lit += sunAt( origin + dirW * t, t );
    t += stepLen;
  }
  float g = 0.55, cosT = dot( dirW, sunDir );
  float phase = ( 1.0 - g * g ) / ( 12.566371 * pow( 1.0 + g * g - 2.0 * g * cosT, 1.5 ) );
  float inscatter = lit * stepLen * density * phase * 12.566371;
  gl_FragColor = vec4( inscatter, 0.0, 0.0, 1.0 );
}`;

const COMPOSITE = /* glsl */`
uniform sampler2D tDiffuse; uniform sampler2D tShaft; uniform vec3 sunColor; uniform vec2 lowTexel;
varying vec2 vUv;
void main() {
  vec4 c = texture2D( tDiffuse, vUv );
  float s = texture2D( tShaft, vUv ).r * 0.4;
  s += ( texture2D( tShaft, vUv + vec2( lowTexel.x, 0.0 ) ).r + texture2D( tShaft, vUv - vec2( lowTexel.x, 0.0 ) ).r
       + texture2D( tShaft, vUv + vec2( 0.0, lowTexel.y ) ).r + texture2D( tShaft, vUv - vec2( 0.0, lowTexel.y ) ).r ) * 0.15;
  gl_FragColor = vec4( c.rgb + sunColor * s, c.a );
}`;

export class LightShaftPass extends Pass {
  private rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  private march: THREE.ShaderMaterial | null = null;
  private comp: THREE.ShaderMaterial;
  private quad = new FullScreenQuad();
  private cascades = -1;
  strength = 1;

  constructor(private camera: THREE.PerspectiveCamera, private sun: SunShadows, private sunDirWorld: THREE.Vector3, private sunColor: THREE.Color) {
    super();
    this.comp = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: COMPOSITE, depthTest: false, depthWrite: false,
      uniforms: { tDiffuse: { value: null }, tShaft: { value: this.rt.texture }, sunColor: { value: new THREE.Color() }, lowTexel: { value: new THREE.Vector2() } } });
    this.enabled = false;
  }

  private build(n: number): void {
    this.cascades = n;
    this.march?.dispose();
    this.march = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: MARCH, depthTest: false, depthWrite: false,
      defines: { CASCADES: n, ...(isReversed() ? { REVERSED_Z: 1 } : {}) },
      uniforms: { tDepth: { value: null }, projInv: { value: new THREE.Matrix4() }, camWorld: { value: new THREE.Matrix4() }, sunDir: { value: new THREE.Vector3() },
        density: { value: 0.0016 }, maxDist: { value: 35 }, shadowMap: { value: Array.from({ length: n }, () => null) },
        shadowMatrix: { value: Array.from({ length: n }, () => new THREE.Matrix4()) }, splits: { value: new THREE.Vector4() } } });
  }

  override setSize(w: number, h: number): void {
    this.rt.setSize(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2)));
    this.comp.uniforms.lowTexel.value.set(2 / w, 2 / h);
  }

  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    const lights = this.sun.lights.filter((l) => l.castShadow && l.shadow.map);
    if (!lights.length || !readBuffer.depthTexture) {         // nothing to march through: pass the image on
      this.comp.uniforms.tDiffuse.value = readBuffer.texture;
      this.comp.uniforms.sunColor.value.setRGB(0, 0, 0);
      this.quad.material = this.comp;
      renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
      this.quad.render(renderer);
      return;
    }
    if (lights.length !== this.cascades) this.build(lights.length);
    const m = this.march!;
    const u = m.uniforms;
    u.tDepth.value = readBuffer.depthTexture;
    u.projInv.value.copy(this.camera.projectionMatrixInverse);
    u.camWorld.value.copy(this.camera.matrixWorld);
    u.sunDir.value.copy(this.sunDirWorld).normalize();
    lights.forEach((l, i) => { u.shadowMap.value[i] = l.shadow.map!.texture; u.shadowMatrix.value[i].copy(l.shadow.matrix); });
    const sp = this.sun.splitsOut;
    u.splits.value.set(sp[0] ?? 1e4, sp[1] ?? 1e4, sp[2] ?? 1e4, sp[3] ?? 1e4);
    this.quad.material = m;
    renderer.setRenderTarget(this.rt);
    this.quad.render(renderer);
    const c = this.comp.uniforms;
    c.tDiffuse.value = readBuffer.texture;
    c.sunColor.value.copy(this.sunColor).multiplyScalar(this.strength);
    this.quad.material = this.comp;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  override dispose(): void { this.rt.dispose(); this.march?.dispose(); this.comp.dispose(); this.quad.dispose(); }
}

/** Specks of dust that drift around the camera and catch the sun. */
export class DustMotes {
  points: THREE.Points;
  private mat: THREE.ShaderMaterial;

  constructor(parent: THREE.Object3D, private sun: SunShadows, count = 700) {
    const pos = new Float32Array(count * 3), seed = new Float32Array(count);
    let s = 3;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < count; i++) { pos[i * 3] = rnd() * 10; pos[i * 3 + 1] = rnd() * 10; pos[i * 3 + 2] = rnd() * 10; seed[i] = rnd(); }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("seed", new THREE.BufferAttribute(seed, 1));
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { camPos: { value: new THREE.Vector3() }, time: { value: 0 }, shadowMap: { value: null }, shadowMatrix: { value: new THREE.Matrix4() },
        sunColor: { value: new THREE.Color() }, scale: { value: 500 } },
      vertexShader: /* glsl */`
        attribute float seed; uniform vec3 camPos; uniform float time; uniform float scale; varying float vSeed; varying vec3 vWorld; varying float vFade;
        void main() {
          vec3 drift = vec3( sin( time * 0.13 + seed * 40.0 ), cos( time * 0.11 + seed * 23.0 ) * 0.6, sin( time * 0.07 + seed * 11.0 ) ) * 0.6 + vec3( 0.05, -0.02, 0.03 ) * time;
          vec3 p = mod( position + drift - camPos + 5.0, 10.0 ) - 5.0 + camPos;
          vWorld = p; vSeed = seed;
          vec4 mv = viewMatrix * vec4( p, 1.0 );
          float d = -mv.z;
          vFade = smoothstep( 0.3, 1.0, d ) * ( 1.0 - smoothstep( 3.5, 5.0, d ) );
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp( ( 0.006 + 0.006 * seed ) * scale / max( d, 0.2 ), 1.0, 4.0 );
        }`,
      fragmentShader: /* glsl */`
        #include <packing>
        uniform sampler2D shadowMap; uniform mat4 shadowMatrix; uniform vec3 sunColor; uniform float time; varying float vSeed; varying vec3 vWorld; varying float vFade;
        void main() {
          vec4 sc = shadowMatrix * vec4( vWorld, 1.0 );
          float lit = 1.0;
          if ( sc.x > 0.0 && sc.x < 1.0 && sc.y > 0.0 && sc.y < 1.0 ) lit = sc.z - 0.002 <= unpackRGBAToDepth( texture2D( shadowMap, sc.xy ) ) ? 1.0 : 0.0;
          float tw = 0.6 + 0.4 * sin( time * ( 1.0 + vSeed * 2.0 ) + vSeed * 30.0 );
          float a = lit * vFade * tw * 0.35;
          if ( a < 0.003 ) discard;
          gl_FragColor = vec4( sunColor * a, 1.0 );
        }`,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    this.points.visible = false;
    parent.add(this.points);
  }

  update(camWorld: THREE.Vector3, t: number, sunColor: THREE.Color, viewportHeight: number, fov: number): void {
    const l = this.sun.lights[0];
    const u = this.mat.uniforms;
    u.camPos.value.copy(camWorld);
    u.time.value = t;
    u.sunColor.value.copy(sunColor).multiplyScalar(0.25);
    u.scale.value = viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2));
    if (l?.shadow.map) { u.shadowMap.value = l.shadow.map.texture; u.shadowMatrix.value.copy(l.shadow.matrix); }
  }
}
