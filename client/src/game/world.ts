// The 3D scene: renderer, the Z-up game root, a procedural sky with image-based light from it, the sun with cascaded
// soft shadows (shadows.ts), height fog with aerial perspective, the level geometry, light fixtures, destructible
// panels, props, and the frame:
//
//   SSAO pre-pass (ssao.ts, medium+)  ->  backdrop (sky + far mountains, own camera range)  ->  scene
//   ->  light shafts (atmosphere.ts, high+)  ->  first-person weapon (own camera, depth clear)
//   ->  eye adaptation  ->  bloom  ->  colour grade (warm highlights, cool shadows) and vignette
//   ->  tone mapping (ACES or AgX) and sRGB  ->  SMAA (high / ultra) or FXAA
//
// Depth: 10 cm near plane, reversed-Z float depth where available (depth.ts). Graphics options are in graphics.ts
// and data/graphics_presets.json; applyGraphics() switches nearly all of them without a reload.

import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import { FXAAShader } from "three/examples/jsm/shaders/FXAAShader.js";
import { hprMatrix } from "@cs/shared/math";
import { GRAPHICS_PRESETS } from "@cs/shared/data";
import { Assets, MaterialLibrary, buildGLB, makeVolumes, parseGLB, volumeUniforms } from "./assets";
import { AE_DEFAULTS, AutoExposurePass } from "./autoexposure";
import { DustMotes, LightShaftPass } from "./atmosphere";
import { installReversedZPatches, patchSkyVertex, setReversed } from "./depth";
import { PanelSet } from "./panels";
import { type Gfx } from "./graphics";
import { SunShadows } from "./shadows";
import { SSAOPass } from "./ssao";
import { LocalLights } from "./locallights";
import { aoUniforms, surfaceConfig, surfaceKey, surfaceUniforms } from "./surface";

/* eslint-disable @typescript-eslint/no-explicit-any */
export { PRESET_NAMES } from "./graphics";

/** Camera layers: the play space, the backdrop (sky, far mountains) and transparent effects (no SSAO pre-pass). */
export const LAYER_MAIN = 0, LAYER_BACKDROP = 1, LAYER_FX = 2;
const NEAR = 0.1, FAR = 400, BACKDROP_NEAR = 1, BACKDROP_FAR = 4000;
/** Building-detail cells (shared/src/level/level.ts LevelContext.CELL). */
const LOD_CELL = 24;

const GradingShader = {
  uniforms: { tDiffuse: { value: null }, saturation: { value: 0.94 }, contrast: { value: 1.06 }, lift: { value: new THREE.Vector3() },
    gain: { value: new THREE.Vector3(1, 1, 1) }, vignette: { value: 0.3 }, vignetteStart: { value: 0.45 }, split: { value: 0.0 } },
  vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float saturation; uniform float contrast; uniform vec3 lift; uniform vec3 gain;
    uniform float vignette; uniform float vignetteStart; uniform float split; varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = c.rgb * gain + lift;
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, saturation);
      col = (col - 0.18) * contrast + 0.18;
      // split toning (scene-referred, before tone mapping): warm highlights, slightly cool shadows
      float hl = smoothstep(0.12, 1.2, l);
      col *= mix(vec3(0.965, 0.985, 1.04), vec3(1.045, 1.0, 0.94), hl) * split + (1.0 - split);
      float d = length(vUv - 0.5) * 1.4142;
      col *= 1.0 - vignette * smoothstep(vignetteStart, 1.0, d);
      gl_FragColor = vec4(max(col, 0.0), c.a);
    }`,
};

/** Game (Z-up) direction -> three world (Y-up) through the root's -90 degree turn about X. */
export const zupToWorld = (v: ArrayLike<number>): THREE.Vector3 => new THREE.Vector3(v[0], v[2], -v[1]);

/** The desktop renderer's fog in place of three's: exponential height fog, density a * exp(-b (z - base)),
 *  integrated along the view ray in closed form (dusty air pools low, the horizon fades out), capped at
 *  max_opacity, brightened toward the sun by a Henyey-Greenstein phase term. Aerial perspective on top: distant
 *  surfaces lose contrast toward a bluer haze away from the sun and a warmer one toward it. Map values from
 *  environment.fog; the chunks are patched once per page (one map per page), before the materials compile. */
function installHeightFog(fog: any, sunDirWorld: THREE.Vector3, sunColor: number[]): void {
  const f = (v: number) => v.toFixed(6);
  const scatter = Number(fog.sun_scatter ?? 0.25);
  const C = THREE.ShaderChunk as Record<string, string>;
  C.fog_pars_vertex = "#ifdef USE_FOG\n\tvarying float vFogDepth;\n\tvarying vec3 vFogWorld;\n#endif";
  C.fog_vertex = "#ifdef USE_FOG\n\tvFogDepth = - mvPosition.z;\n\tvFogWorld = transpose( mat3( viewMatrix ) ) * ( mvPosition.xyz - viewMatrix[ 3 ].xyz );\n#endif";
  C.fog_pars_fragment = `#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec3 vFogWorld;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif`;
  C.fog_fragment = `#ifdef USE_FOG
	{
		vec3 rd = vFogWorld - cameraPosition;                // world space is y-up: height is y
		float dist = length( rd );
		rd /= max( dist, 1e-4 );
		#ifdef FOG_EXP2
			float a = fogDensity;
		#else
			float a = 0.003;
		#endif
		float b = ${f(Math.max(Number(fog.height_falloff ?? 0.06), 1e-4))};
		float h0 = cameraPosition.y - ${f(Number(fog.base_height ?? 0))};
		float od = abs( rd.y ) > 1e-3 ? ( a / b ) * exp( -h0 * b ) * ( 1.0 - exp( -dist * rd.y * b ) ) / rd.y : a * exp( -h0 * b ) * dist;
		float fogFactor = min( 1.0 - exp( -max( od, 0.0 ) ), ${f(Number(fog.max_opacity ?? 0.85))} );
		float g = 0.72;
		float c = dot( rd, vec3( ${f(sunDirWorld.x)}, ${f(sunDirWorld.y)}, ${f(sunDirWorld.z)} ) );
		float hg = ( 1.0 - g * g ) / ( 12.566371 * pow( 1.0 + g * g - 2.0 * g * c, 1.5 ) );
		vec3 inscatter = fogColor + vec3( ${f(sunColor[0] * scatter)}, ${f(sunColor[1] * scatter)}, ${f(sunColor[2] * scatter)} ) * hg;
		// aerial perspective: a bluer, cooler haze away from the sun builds up with distance
		float aerial = ( 1.0 - exp( -dist * 0.0022 ) ) * ( 0.6 - 0.4 * c );
		inscatter = mix( inscatter, inscatter * vec3( 0.86, 0.95, 1.12 ), clamp( aerial, 0.0, 1.0 ) );
		gl_FragColor.rgb = mix( gl_FragColor.rgb, inscatter, fogFactor );
	}
#endif`;
}

/** The first-person weapon's pass. It shares the world's materials, so the screen-space AO (computed for the world
 *  view) is switched off while it draws. */
class WeaponPass extends RenderPass {
  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget, deltaTime: number, maskActive: boolean): void {
    const on = aoUniforms.uSSAOParams.value.z;
    aoUniforms.uSSAOParams.value.z = 0;
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
    aoUniforms.uSSAOParams.value.z = on;
  }
}

interface LodCell { hi: THREE.Object3D[]; lo: THREE.Object3D[]; min: [number, number]; max: [number, number]; near: boolean }

export class World {
  /** The graphics options in force; applyGraphics() changes them. */
  g: Gfx;
  /** MSAA is chosen when the render target is made (the page reloads to change it). */
  private msaa: boolean;
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  root = new THREE.Group();
  camera: THREE.PerspectiveCamera;
  /** Draws the backdrop (sky and far mountains) first, with a range of its own. */
  backdropCamera: THREE.PerspectiveCamera;
  assets: Assets;
  materials!: MaterialLibrary;
  panels: PanelSet | null = null;
  shadows!: SunShadows;
  /** The sun (cascade 0 of the shadows). */
  sun!: THREE.DirectionalLight;
  sunDir = new THREE.Vector3(0.45, -0.55, 0.7).normalize();
  sunDirWorld = new THREE.Vector3();
  sunColor = new THREE.Color();
  composer!: EffectComposer;
  vmPass: RenderPass | null = null;
  autoExposure: AutoExposurePass | null = null;
  reversedZ = false;
  private fxaa: ShaderPass | null = null;
  private smaa: SMAAPass | null = null;
  private ao: SSAOPass | null = null;
  private shafts: LightShaftPass | null = null;
  private motes: DustMotes | null = null;
  private locals: LocalLights | null = null;
  private localKey = "";
  private bloom: UnrealBloomPass | null = null;
  private bloomBase = 0.36;
  private grading: ShaderPass | null = null;
  private output: OutputPass | null = null;
  private env: any = {};
  private aeStrength = 1;
  private brightness = 0;
  private sky!: Sky;
  private weaponModels = new Map<string, Promise<THREE.Group | null>>();
  weaponDefs: Record<string, any> = {};
  mapEntry: any = null;
  private clipGroup: THREE.Group | null = null;
  private viewToZup = new THREE.Matrix4();
  private width = 1;
  private height = 1;
  private sizeKey = "";
  private t0 = performance.now();
  private lastUpdate = performance.now();
  private tmp = new THREE.Vector3();
  private tmpColor = new THREE.Color();
  /** Building detail per 24 m cell (shared/src/level/level.ts): the near "hi" variant (rounded, organic, small
   *  clutter) and the far "lo" one (plain boxes). Switched per cell by distance, with hysteresis. */
  private lodCells = new Map<string, LodCell>();

  constructor(canvas: HTMLCanvasElement, gfx: Gfx, manifestUrl: string) {
    this.g = { ...gfx };
    this.msaa = gfx.aa === "msaa";
    const q = new URLSearchParams(location.search);
    const wantReverse = q.get("depth") !== "standard";
    installReversedZPatches();
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance", stencil: false, reverseDepthBuffer: wantReverse } as any);
    this.reversedZ = !!(this.renderer.capabilities as any).reverseDepthBuffer;
    setReversed(this.reversedZ);
    console.info(`[gfx] depth: ${this.reversedZ ? "reversed-Z, 32-bit float" : "standard 24-bit"}, near ${NEAR} m`);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = this.g.shadows;
    // the shadow maps are drawn once per frame, by the first render call that needs them (render() sets needsUpdate):
    // the SSAO pre-pass and the backdrop pass would otherwise redraw them each time
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // the game's Z-up world inside Three's Y-up scene
    this.root.name = "zup";
    this.root.rotation.x = -Math.PI / 2;
    this.root.updateMatrixWorld(true);
    this.scene.add(this.root);
    volumeUniforms.uZupFromWorld.value.copy(this.root.matrixWorld).invert();
    this.camera = new THREE.PerspectiveCamera(74, 1, NEAR, FAR);
    this.camera.up.set(0, 0, 1);
    this.camera.layers.enable(LAYER_FX);
    this.root.add(this.camera);
    this.backdropCamera = new THREE.PerspectiveCamera(74, 1, BACKDROP_NEAR, BACKDROP_FAR);
    this.backdropCamera.layers.set(LAYER_BACKDROP);
    this.backdropCamera.matrixAutoUpdate = false;
    this.assets = new Assets(manifestUrl);
    this.applySurfaceConfig(this.g);
    // for tuning from the browser console
    (window as any).__gfx = { surfaceUniforms, aoUniforms, volumeUniforms, world: this };
  }

  /** Resize the canvas, the composer and every pass together, only when the size really changed. */
  setSize(width: number, height: number): void {
    const ratio = Math.min(window.devicePixelRatio || 1, this.g.pixelRatioCap) * this.g.renderScale;
    const key = `${width}x${height}@${ratio}|${!!this.composer}`;
    if (key === this.sizeKey) return;
    this.sizeKey = key;
    this.width = width;
    this.height = height;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
    if (this.composer) {
      this.composer.setPixelRatio(ratio);
      this.composer.setSize(width, height);
      if (this.fxaa) this.fxaa.material.uniforms.resolution.value.set(1 / (width * ratio), 1 / (height * ratio));
    }
  }

  /** Everything for a map; onStep(text) reports progress. Returns the map's JSON (for the collision world). */
  async load(mapName: string, onStep: (s: string) => void = () => {}): Promise<any> {
    onStep("manifest");
    const manifest = await this.assets.load();
    const entry = manifest.maps[mapName];
    if (!entry) throw new Error(`map ${mapName} is not built (npm run build)`);
    this.mapEntry = entry;
    this.materials = new MaterialLibrary(this.assets, this.renderer, this.g.textures, this.g.anisotropy);
    onStep("map data");
    const [data, glbBuf, volBuf] = await Promise.all([this.assets.json(entry.data), this.assets.buffer(entry.geometry), this.assets.buffer(entry.volume.file)]);
    makeVolumes(volBuf, entry.volume);
    // interiors: a bounce-light floor under the sky term and the strength of the baked fixtures
    volumeUniforms.uBounce.value = entry.environment?.bounce ?? 0.15;
    volumeUniforms.uLightGain.value = entry.environment?.light_gain ?? 1.5;
    onStep("sky");
    this.setupSky(entry.environment ?? {});
    if (entry.sky) await this.loadHdrSky(entry.sky, entry.environment ?? {}).catch((e) => console.warn("HDR sky:", e));
    onStep("geometry");
    const glb = parseGLB(glbBuf);
    // the level's own geometry carries the surface-detail attribute (the light fixtures do not); its thin pieces fade
    // with distance
    const level = buildGLB(glb, (name, extras) => this.materials.get(name, extras), true,
      (node) => (node.name === "fixtures" ? {} : { level: true, thin: node.extras?.layer === "thin" }));
    level.name = "level";
    level.traverse((o) => {
      const layer = o.userData?.layer;
      if (layer === "backdrop") {
        o.traverse((m) => { m.layers.set(LAYER_BACKDROP); if ((m as THREE.Mesh).isMesh) { m.castShadow = false; m.receiveShadow = false; } });
      }
      const m = typeof layer === "string" ? /^(hi|lo):(-?\d+)_(-?\d+)$/.exec(layer) : null;
      if (m) {
        const key = `${m[2]}_${m[3]}`;
        let c = this.lodCells.get(key);
        if (!c) {
          const ix = Number(m[2]), iy = Number(m[3]);
          c = { hi: [], lo: [], min: [ix * LOD_CELL, iy * LOD_CELL], max: [(ix + 1) * LOD_CELL, (iy + 1) * LOD_CELL], near: false };
          this.lodCells.set(key, c);
        }
        c[m[1] as "hi" | "lo"].push(o);
      }
    });
    this.root.add(level);
    this.applyDetail(true);
    const panelRoot = new THREE.Group();
    panelRoot.name = "panels";
    this.root.add(panelRoot);
    this.panels = new PanelSet(data, this.materials, panelRoot);
    this.panels.apply([], true);
    this.locals = new LocalLights(this.root, entry.lights ?? []);
    this.setupPost(entry.environment ?? {});
    onStep("textures");
    await Promise.race([this.materials.ready(), new Promise((r) => setTimeout(r, 30000))]);
    return data;
  }

  /** Distance (m) within which a cell shows its near variant, by the building-detail setting (0: never). */
  private lodDistance(): number { return this.g.buildingDetail === "high" ? 42 : this.g.buildingDetail === "medium" ? 24 : 0; }

  /** Per frame: each cell shows "hi" within the LOD distance of the camera (measured to the cell's rectangle) and
   *  "lo" beyond; a cell only switches once it is 4 m past the threshold, so standing at the edge does not flicker.
   *  Both variants are built at load time, so a switch is a visibility swap within one frame (never a half-built mesh). */
  private applyDetail(force = false): void {
    const D = this.lodDistance();
    const p = this.camera.position;               // Z-up, the camera hangs under the root
    for (const c of this.lodCells.values()) {
      const dx = Math.max(c.min[0] - p.x, 0, p.x - c.max[0]), dy = Math.max(c.min[1] - p.y, 0, p.y - c.max[1]);
      const d = Math.hypot(dx, dy);
      const near = D > 0 && (c.near ? d < D + 4 : d < D - 4);
      if (near === c.near && !force) continue;
      c.near = near;
      for (const o of c.hi) o.visible = near;
      for (const o of c.lo) o.visible = !near;
    }
  }

  /** A downloaded HDR sky (npm run fetch-assets) in place of the procedural one: background and image-based light.
   *  The sun disc is clamped (environment.sun_clamp) because the directional light already carries the sun. */
  private async loadHdrSky(url: string, env: any): Promise<void> {
    const loader = new RGBELoader().setDataType(THREE.FloatType);
    const tex = loader.parse(await this.assets.buffer(url)) as any;
    const data = tex.data as Float32Array<ArrayBuffer>, clamp = env.sun_clamp ?? 12;
    for (let i = 0; i < data.length; i++) if (data[i] > clamp) data[i] = clamp;
    const t = new THREE.DataTexture(data, tex.width, tex.height, THREE.RGBAFormat, THREE.FloatType);
    t.mapping = THREE.EquirectangularReflectionMapping;
    t.colorSpace = THREE.LinearSRGBColorSpace;
    t.magFilter = t.minFilter = THREE.LinearFilter;
    t.flipY = true;
    t.needsUpdate = true;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment?.dispose();
    this.scene.environment = pmrem.fromEquirectangular(t).texture;
    pmrem.dispose();
    const rot = THREE.MathUtils.degToRad(env.hdri_rotation ?? 0);
    this.scene.environmentRotation.set(0, rot, 0);
    this.scene.backgroundRotation.set(0, rot, 0);
    this.scene.background = t;
    this.scene.backgroundIntensity = env.sky_target ?? 1;
    this.sky.visible = false;
  }

  /** three's Sky is tuned for an exposure of about 0.5; the scene renders at 1.0, so the sky is scaled here. It sits
   *  on the far plane in either depth mode (depth.ts). */
  private makeSky(exposure: number): Sky {
    const sky = new Sky();
    const m = sky.material as THREE.ShaderMaterial;
    m.uniforms.skyExposure = { value: exposure };
    m.vertexShader = patchSkyVertex(m.vertexShader);
    m.fragmentShader = m.fragmentShader.replace("uniform float mieDirectionalG;", "uniform float mieDirectionalG;\nuniform float skyExposure;")
      .replace("gl_FragColor = vec4( retColor, 1.0 );", "gl_FragColor = vec4( retColor * skyExposure, 1.0 );");
    return sky;
  }

  private setupSky(env: any): void {
    const sd = env.sun_dir ?? [0.45, -0.55, 0.7];
    this.sunDir.set(sd[0], sd[1], sd[2]).normalize();
    this.sunDirWorld.copy(zupToWorld([this.sunDir.x, this.sunDir.y, this.sunDir.z])).normalize();
    const sky = this.makeSky(env.sky_exposure ?? 0.5);
    sky.scale.setScalar(450);
    const u = sky.material.uniforms;
    u.turbidity.value = 4.5;
    u.rayleigh.value = 1.4;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.82;
    u.sunPosition.value.copy(this.sunDirWorld);
    (sky.material as THREE.ShaderMaterial).depthWrite = false;
    sky.layers.set(LAYER_BACKDROP);
    this.sky = sky;
    // image-based light from the same sky (prefiltered once) over warm, sunlit ground
    const envScene = new THREE.Scene();
    const envSky = this.makeSky(env.sky_exposure ?? 0.5);
    envSky.scale.setScalar(100);
    Object.assign(envSky.material.uniforms.sunPosition.value, this.sunDirWorld);
    for (const k of ["turbidity", "rayleigh", "mieCoefficient", "mieDirectionalG"]) envSky.material.uniforms[k].value = u[k].value;
    envScene.add(envSky);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(90, 32), new THREE.MeshBasicMaterial({ color: new THREE.Color(...(env.ground ?? [0.2, 0.17, 0.13])).multiplyScalar(1.4) }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -2;
    envScene.add(ground);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envMap = pmrem.fromScene(envScene, 0.02).texture;
    pmrem.dispose();
    this.scene.environment = envMap;
    this.scene.environmentIntensity = 0.85 * (env.ibl_diffuse ?? 1.0);
    this.scene.add(sky);
    const sc = env.sun_color ?? [1.0, 0.93, 0.82];
    const intensity = env.sun_intensity ?? 3.2;
    this.sunColor.setRGB(sc[0], sc[1], sc[2]);
    this.shadows = new SunShadows(this.scene, this.sunDirWorld, this.sunColor, intensity, this.shadowConfig(this.g));
    this.shadows.setEnabled(this.g.shadows);
    this.sun = this.shadows.sun;
    // warm bounce: sunlit earth (albedo ~0.32, tinted by the ground colour) lighting walls from below
    const gc = env.ground ?? [0.2, 0.17, 0.13];
    const gl = Math.max(gc[0], gc[1], gc[2], 1e-3);
    const bounce = Number(env.bounce_ground ?? 0.5);
    surfaceUniforms.uBounceColor.value.setRGB(gc[0] / gl * 0.34 * sc[0], gc[1] / gl * 0.34 * sc[1], gc[2] / gl * 0.34 * sc[2]).multiplyScalar(intensity * bounce * 0.5);
    surfaceUniforms.uDustColor.value.setRGB(...((env.dust_color ?? [0.62, 0.53, 0.42]) as [number, number, number]));
    const fog = { ...env.fog, density: (env.fog?.density ?? 0.0028) * 0.65,
      max_opacity: (env.fog?.max_opacity ?? 0.85) * 0.8 };
    this.scene.fog = new THREE.FogExp2(new THREE.Color(0.66, 0.72, 0.80), fog.density);
    installHeightFog(fog, this.sunDirWorld, sc);
  }

  private shadowConfig(g: Gfx) {
    return { cascades: g.shadowCascades, size: g.shadowSize, distance: g.shadowDistance, taps: g.shadowTaps, softness: g.shadowSoftness, pcss: g.shadowPcss };
  }

  /** Shader-level options (they change the compiled programs): mark every material for recompiling. */
  private applySurfaceConfig(g: Gfx): boolean {
    const before = surfaceKey();
    surfaceConfig.taps = g.shadowTaps;
    surfaceConfig.pcss = g.shadowPcss;
    surfaceConfig.specularAA = g.specularAA;
    surfaceConfig.detailNormal = g.detailNormals;
    surfaceConfig.weather = g.weathering;
    const changed = surfaceKey() !== before;
    if (changed && this.materials) for (const m of this.materials.all()) m.needsUpdate = true;
    return changed;
  }

  /** Every pass is made once (the optional ones disabled), so applyGraphics() can switch them without a reload. */
  private setupPost(env: any): void {
    this.env = env;
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: this.msaa ? 4 : 0 });
    // a depth texture (the light shafts read it); float with reversed-Z, where it carries the precision
    target.depthTexture = new THREE.DepthTexture(1, 1, this.reversedZ ? THREE.FloatType : THREE.UnsignedIntType);
    const composer = new EffectComposer(this.renderer, target);
    const mainLayers = new THREE.Layers();
    mainLayers.set(LAYER_MAIN);
    this.ao = new SSAOPass(this.scene, this.camera, mainLayers);
    composer.addPass(this.ao);
    composer.addPass(new RenderPass(this.scene, this.backdropCamera));
    const main = new RenderPass(this.scene, this.camera);
    main.clear = false;
    main.clearDepth = true;
    composer.addPass(main);
    this.shafts = new LightShaftPass(this.camera, this.shadows, this.sunDirWorld, this.sunColor);
    composer.addPass(this.shafts);
    this.motes = new DustMotes(this.scene, this.shadows);
    this.motes.points.layers.set(LAYER_FX);
    this.vmPass = new WeaponPass(new THREE.Scene(), this.camera);
    this.vmPass.clear = false;
    this.vmPass.clearDepth = true;
    composer.addPass(this.vmPass);
    const post = env.post ?? {};
    this.renderer.toneMappingExposure = env.exposure ?? 1.0;
    // auto exposure stays in the chain (it carries the brightness setting); "off" sets its strength to zero
    this.autoExposure = new AutoExposurePass({ ...AE_DEFAULTS, ...(post.auto_exposure ?? {}) });
    this.aeStrength = this.autoExposure.settings.strength;
    this.autoExposure.brightness = this.brightness;
    composer.addPass(this.autoExposure);
    const b = post.bloom ?? {};
    this.bloomBase = (b.intensity ?? 0.45) * 0.8;
    // subtle: only the sun, hot highlights, flashes and fire cross the threshold
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), this.bloomBase, 0.5 + (b.scatter ?? 0.7) * 0.3, Math.max(b.threshold ?? 1.3, 1.4));
    composer.addPass(this.bloom);
    this.grading = new ShaderPass(GradingShader);
    composer.addPass(this.grading);
    this.output = new OutputPass();
    composer.addPass(this.output);
    this.smaa = new SMAAPass(1, 1);
    composer.addPass(this.smaa);
    this.fxaa = new ShaderPass(FXAAShader);
    composer.addPass(this.fxaa);
    this.composer = composer;
    this.sizeKey = "";
    this.applyGraphics(this.g, true);
    this.setSize(this.width, this.height);
  }

  /** The player's brightness (EV), on top of auto exposure. */
  setBrightness(ev: number): void {
    this.brightness = ev;
    if (this.autoExposure) this.autoExposure.brightness = ev;
  }

  /** Apply graphics options now. Texture size, anisotropy and MSAA wait for a reload (see RELOAD_KEYS). */
  applyGraphics(next: Gfx, force = false): void {
    const prev = this.g;
    const g = (this.g = { ...next, textures: prev.textures, anisotropy: prev.anisotropy });
    const changed = (k: keyof Gfx) => force || prev[k] !== g[k];
    if (changed("renderScale") || changed("pixelRatioCap")) { this.sizeKey = ""; this.setSize(this.width, this.height); }
    this.applySurfaceConfig(g);
    if (this.shadows) {
      if (changed("shadows")) {
        this.renderer.shadowMap.enabled = g.shadows;
        this.shadows.setEnabled(g.shadows);           // the light state changes: materials recompile once
      }
      if (this.shadows.configure(this.shadowConfig(g))) {
        // a different number of cascades is a different light setup: the programs recompile
        this.sun = this.shadows.sun;
        this.shadows.setEnabled(g.shadows);
        for (const m of this.materials?.all() ?? []) m.needsUpdate = true;
      }
    }
    if (changed("buildingDetail")) this.applyDetail(true);
    const lk = `${g.localLights}|${g.localShadows}|${g.shadows}`;
    if (this.locals && lk !== this.localKey) {
      this.localKey = lk;
      const preset: any = (GRAPHICS_PRESETS as any)[g.localShadows > 1 ? "ultra" : "high"] ?? {};
      this.locals.configure(g.localLights, g.shadows ? Math.min(g.localShadows, g.localLights) : 0, preset.local_shadow_tile ?? 512,
        Math.max(1, Math.ceil((preset.local_shadow_updates ?? 4) / 4)));
      for (const m of this.materials?.all() ?? []) m.needsUpdate = true;
    }
    this.renderer.toneMapping = g.toneMapping === "agx" ? THREE.AgXToneMapping : THREE.ACESFilmicToneMapping;
    if (!this.composer) return;
    this.ao?.setLevel(g.ao);
    if (this.shafts) this.shafts.enabled = g.volumetric && g.shadows;
    if (this.motes) this.motes.points.visible = g.dustMotes && g.shadows;
    if (this.autoExposure) {
      this.autoExposure.settings.strength = g.autoExposure ? this.aeStrength : 0;
      if (changed("autoExposure")) this.autoExposure.resetAdaptation();
    }
    if (this.bloom) {
      this.bloom.enabled = g.bloom && g.bloomStrength > 0;
      this.bloom.strength = this.bloomBase * g.bloomStrength;
    }
    if (this.grading) {
      const post = this.env.post ?? {}, gr = post.grading ?? {}, v = post.vignette ?? {};
      const un = this.grading.material.uniforms;
      un.saturation.value = (g.grading ? gr.saturation ?? 0.94 : 1) * g.saturation;
      un.contrast.value = (g.grading ? gr.contrast ?? 1.06 : 1) * g.contrast;
      if (g.grading && gr.lift) un.lift.value.fromArray(gr.lift); else un.lift.value.set(0, 0, 0);
      if (g.grading && gr.gain) un.gain.value.fromArray(gr.gain); else un.gain.value.set(1, 1, 1);
      un.split.value = g.grading ? gr.split_tone ?? 1 : 0;
      un.vignette.value = g.vignette ? v.strength ?? 0.3 : 0;
      un.vignetteStart.value = v.start ?? 0.45;
      this.grading.enabled = g.grading || g.vignette || g.saturation !== 1 || g.contrast !== 1;
    }
    if (this.smaa) this.smaa.enabled = g.aa === "smaa" || g.aa === "msaa";
    if (this.fxaa) this.fxaa.enabled = g.aa === "fxaa";
  }

  /** A weapon / gadget model as a Group of animation groups (cached prototype). */
  weaponModel(key: string): Promise<THREE.Group | null> {
    let p = this.weaponModels.get(key);
    if (!p) {
      const url = this.assets.manifest?.weapons?.[key];
      p = url ? this.assets.buffer(url).then((buf) => {
        const g = buildGLB(parseGLB(buf), (name, extras) => this.materials.get(name, extras));
        g.name = `weapon:${key}`;
        return g;
      }).catch(() => null) : Promise.resolve(null);
      this.weaponModels.set(key, p);
    }
    return p;
  }

  /** Static props of the map that are weapon models on display. */
  async props(props: Array<[string, any]>): Promise<void> {
    for (const [kind, e] of props) {
      if (kind !== "weapon_model") continue;
      const model = await this.weaponModel(e.model);
      if (!model) continue;
      const obj = model.clone();
      obj.position.fromArray(e.pos);
      obj.rotation.order = "ZXY";
      const pr = e.pr ?? [0, 0];
      obj.rotation.set(THREE.MathUtils.degToRad(pr[0]), THREE.MathUtils.degToRad(pr[1]), THREE.MathUtils.degToRad(e.heading ?? 0));
      obj.scale.setScalar(e.scale ?? 1);
      this.root.add(obj);
    }
  }

  /** Per frame: the shadow cascades are refitted to the view, building detail and local lights follow the camera,
   *  the backdrop camera follows the main one, the volume lookups follow the camera. */
  update(viewPos: THREE.Vector3): void {
    void viewPos;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastUpdate) / 1000);
    this.lastUpdate = now;
    this.camera.updateMatrixWorld();
    if (this.shadows && this.g.shadows) this.shadows.update(this.camera);
    this.applyDetail();
    this.locals?.update(dt, this.camera.position);
    const bc = this.backdropCamera;
    if (bc.fov !== this.camera.fov || bc.aspect !== this.camera.aspect) {
      bc.fov = this.camera.fov;
      bc.aspect = this.camera.aspect;
      bc.updateProjectionMatrix();
    }
    bc.matrixWorld.copy(this.camera.matrixWorld);
    bc.matrixWorldInverse.copy(this.camera.matrixWorldInverse);
    this.sky?.position.copy(this.camera.getWorldPosition(this.tmp));
    this.viewToZup.copy(volumeUniforms.uZupFromWorld.value).multiply(this.camera.matrixWorld);
    volumeUniforms.uViewToZup.value.setFromMatrix4(this.viewToZup);
    const px = this.height * this.renderer.getPixelRatio();
    surfaceUniforms.uProjScale.value = px / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    if (this.motes?.points.visible) {
      this.motes.update(this.tmp, (now - this.t0) / 1000, this.tmpColor.copy(this.sunColor).multiplyScalar(this.sun?.intensity ?? 3), px, this.camera.fov);
    }
  }

  /** A mode's player-clip walls (the duel arena): a faint barrier so players see where the map ends. */
  setClips(clips: Array<{ center: number[]; size: number[]; hpr: number[] }>): void {
    if (this.clipGroup) { this.root.remove(this.clipGroup); this.clipGroup = null; }
    if (!clips.length) return;
    const g = (this.clipGroup = new THREE.Group());
    const mat = new THREE.MeshBasicMaterial({ color: 0xff5a3c, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide });
    const edge = new THREE.LineBasicMaterial({ color: 0xff5a3c, transparent: true, opacity: 0.5 });
    for (const c of clips) {
      const geo = new THREE.BoxGeometry(c.size[0], c.size[1], c.size[2]);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(c.center[0], c.center[1], c.center[2]);
      const R = hprMatrix(c.hpr[0], c.hpr[1], c.hpr[2]);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.set(R[0][0], R[1][0], R[2][0], c.center[0], R[0][1], R[1][1], R[2][1], c.center[1], R[0][2], R[1][2], R[2][2], c.center[2], 0, 0, 0, 1);
      const lines = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edge);
      mesh.add(lines);
      mesh.renderOrder = 10;
      mesh.layers.set(LAYER_FX);
      lines.layers.set(LAYER_FX);
      g.add(mesh);
    }
    this.root.add(g);
  }

  /** Draw calls and triangles of the last whole frame (every pass, shadows included). */
  frameInfo = { calls: 0, triangles: 0 };

  render(): void {
    const info = this.renderer.info;
    info.autoReset = false;
    info.reset();
    this.renderer.shadowMap.needsUpdate = this.g.shadows;
    this.composer.render();
    this.frameInfo.calls = info.render.calls;
    this.frameInfo.triangles = info.render.triangles;
  }
}
