// Loading the built game assets (scripts/build.ts): the manifest, GLB geometry, materials with their
// textures, and the baked light volumes. Everything in the game world is in the game's own Z-up coordinates
// (metres, x east, y north, z up): the scene has one root group turned -90 degrees about X (world.ts), so
// positions from the server go straight into Three.js objects.

import * as THREE from "three";
import { surfaceKind, withSurface } from "./surface";

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function fetchJSON(url: string): Promise<any> {
  const r = await fetch(url, { credentials: "same-origin" });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

export async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url, { credentials: "same-origin" });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.arrayBuffer();
}

export class Assets {
  manifest: any = null;
  bytes = 0;
  onProgress: ((bytes: number) => void) | null = null;

  constructor(public manifestUrl: string) {}

  async load(): Promise<any> {
    this.manifest = await fetchJSON(this.manifestUrl);
    return this.manifest;
  }

  async buffer(url: string): Promise<ArrayBuffer> {
    const buf = await fetchBuffer(url);
    this.bytes += buf.byteLength;
    this.onProgress?.(this.bytes);
    return buf;
  }

  json(url: string): Promise<any> { return fetchJSON(url); }
}

// ------------------------------------------------------------------ GLB
const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const ARRAYS: Record<number, any> = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array, 5121: Uint8Array };
const ATTRIBUTES: Record<string, string> = { POSITION: "position", NORMAL: "normal", TANGENT: "tangent", TEXCOORD_0: "uv", COLOR_0: "color",
  JOINTS_0: "skinIndex", WEIGHTS_0: "skinWeight", _DETAIL: "detail" };

export interface GlbNode { name: string; mesh: Array<{ geometry: THREE.BufferGeometry; material: { name: string; extras: any } }> | null; children: number[];
  translation: number[] | null; rotation: number[] | null; extras: any }
export interface Glb { nodes: GlbNode[]; roots: number[] }

/** The subset of glTF that scripts/assets/glb.ts writes: indexed triangle meshes, a node tree, materials by name. */
export function parseGLB(buf: ArrayBuffer): Glb {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB file");
  const jsonLen = dv.getUint32(12, true);
  const doc = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)));
  const binStart = 20 + jsonLen + 8;
  const accessor = (i: number) => {
    const a = doc.accessors[i];
    const view = doc.bufferViews[a.bufferView];
    const Ctor = ARRAYS[a.componentType];
    const n = COMPONENTS[a.type];
    return { array: new Ctor(buf, binStart + (view.byteOffset || 0) + (a.byteOffset || 0), a.count * n), itemSize: n };
  };
  const meshes = (doc.meshes || []).map((m: any) => m.primitives.map((p: any) => {
    const g = new THREE.BufferGeometry();
    for (const [key, idx] of Object.entries(p.attributes)) {
      const name = ATTRIBUTES[key];
      if (!name) continue;
      const { array, itemSize } = accessor(idx as number);
      g.setAttribute(name, new THREE.BufferAttribute(array, itemSize));
    }
    if (p.indices !== undefined) g.setIndex(new THREE.BufferAttribute(accessor(p.indices).array, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    const mat = doc.materials[p.material] || { name: "default" };
    return { geometry: g, material: { name: mat.name, extras: mat.extras || {} } };
  }));
  const nodes: GlbNode[] = (doc.nodes || []).map((n: any) => ({ name: n.name, mesh: n.mesh !== undefined ? meshes[n.mesh] : null, children: n.children || [],
    translation: n.translation || null, rotation: n.rotation || null, extras: n.extras || {} }));
  return { nodes, roots: doc.scenes ? doc.scenes[doc.scene || 0].nodes : [] };
}

/** Three.js objects for a parsed GLB, in Z-up coordinates (the root's turn to glTF's Y-up is dropped). */
export function buildGLB(glb: Glb, makeMaterial: (name: string, extras: any) => THREE.Material, shadows = true,
                         nodeExtras: ((node: GlbNode) => any) | null = null): THREE.Group {
  const build = (i: number): THREE.Group => {
    const n = glb.nodes[i];
    const obj = new THREE.Group();
    obj.name = n.name;
    obj.userData = { ...n.extras };
    if (n.translation && !n.extras.zup_root) obj.position.fromArray(n.translation);
    if (n.rotation && !n.extras.zup_root) obj.quaternion.fromArray(n.rotation);
    const more = n.mesh && nodeExtras ? nodeExtras(n) : null;
    for (const prim of n.mesh ?? []) {
      const mesh = new THREE.Mesh(prim.geometry, makeMaterial(prim.material.name, more ? { ...prim.material.extras, ...more } : prim.material.extras));
      mesh.name = `${n.name}:${prim.material.name}`;
      mesh.castShadow = shadows && !prim.material.extras.emission;
      mesh.receiveShadow = shadows;
      obj.add(mesh);
    }
    for (const c of n.children) obj.add(build(c));
    return obj;
  };
  const root = new THREE.Group();
  for (const r of glb.roots) root.add(build(r));
  if (glb.roots.length === 1) root.userData = root.children[0].userData;
  return root;
}

// ------------------------------------------------------------ light volumes
/** The baked light volumes, read by every world material through these shared uniforms. */
export const volumeUniforms = {
  uVolSky: { value: null as THREE.Data3DTexture | null },
  uVolLight: { value: null as THREE.Data3DTexture | null },
  uVolDir: { value: null as THREE.Data3DTexture | null },
  uVolMin: { value: new THREE.Vector3() },
  uVolInvSize: { value: new THREE.Vector3(1, 1, 1) },
  uLightScale: { value: 16.0 },
  uLightGain: { value: 1.0 },
  uBounce: { value: 0.0 },
  uZupFromWorld: { value: new THREE.Matrix4() },
  uViewToZup: { value: new THREE.Matrix3() },
  uVolEnabled: { value: 0.0 },
};

export function makeVolumes(buf: ArrayBuffer, info: { dims: number[]; min: number[]; spacing: number[]; light_scale: number }): void {
  const [nx, ny, nz] = info.dims;
  const layer = nx * ny * nz * 4;
  const tex = (i: number) => {
    const t = new THREE.Data3DTexture(new Uint8Array(buf, i * layer, layer), nx, ny, nz);
    t.format = THREE.RGBAFormat;
    t.type = THREE.UnsignedByteType;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
    t.unpackAlignment = 1;
    t.needsUpdate = true;
    return t;
  };
  volumeUniforms.uVolSky.value = tex(0);
  volumeUniforms.uVolLight.value = tex(1);
  volumeUniforms.uVolDir.value = tex(2);
  volumeUniforms.uVolMin.value.fromArray(info.min);
  volumeUniforms.uVolInvSize.value.set(1 / (nx * info.spacing[0]), 1 / (ny * info.spacing[1]), 1 / (nz * info.spacing[2]));
  volumeUniforms.uLightScale.value = info.light_scale;
  volumeUniforms.uVolEnabled.value = 1.0;
}

// ---------------------------------------------------------------- materials
export class MaterialLibrary {
  private loader = new THREE.TextureLoader();
  private anisotropy: number;
  private cache = new Map<string, THREE.MeshStandardMaterial>();
  textures = new Map<string, THREE.Texture>();
  private pending: Array<Promise<void>> = [];

  constructor(public assets: Assets, renderer: THREE.WebGLRenderer, public size = 512, anisotropy = 4) {
    this.anisotropy = Math.min(anisotropy, renderer.capabilities.getMaxAnisotropy());
  }

  private texture(url: string, srgb: boolean): THREE.Texture {
    let t = this.textures.get(url);
    if (!t) {
      let done!: () => void;
      this.pending.push(new Promise<void>((r) => { done = r; }));
      t = this.loader.load(url, () => done(), undefined, () => done());
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = this.anisotropy;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      this.textures.set(url, t);
    }
    return t;
  }

  /** Resolves when every texture requested so far has loaded (or failed). */
  ready(): Promise<unknown> { return Promise.all(this.pending); }

  uvScale(name: string): number { return this.assets.manifest.materials[name]?.uv_scale ?? 2; }

  /** Every material made so far (graphics changes that alter the shaders mark them for recompiling). */
  all(): THREE.MeshStandardMaterial[] { return [...this.cache.values()]; }

  /** The material `name` (data/materials.json) with its textures; extras.emission makes it glow; extras.level marks the
   *  level's own geometry (it carries the surface-detail attribute), extras.thin its thin pieces (surface.ts). */
  get(name: string, extras: any = {}, volumes = true): THREE.MeshStandardMaterial {
    const key = `${name}|${extras.emission ? extras.emission.join(",") : ""}|${volumes}|${extras.level ? "L" : ""}${extras.thin ? "T" : ""}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const mats = this.assets.manifest.materials;
    const def = mats[name] ?? mats.concrete_wall ?? Object.values(mats)[0];
    const maps = def.maps[String(this.size)] ?? def.maps[Object.keys(def.maps)[0]];
    const orm = this.texture(maps.orm, false);
    // the packed occlusion / roughness / metalness texture is bound once (as the roughness map) and the surface patch
    // reads metalness and occlusion from it too: two texture units fewer per shader (the ultra preset with four sun
    // cascades and lamp shadows on a skinned soldier otherwise passes WebGL's 16-unit limit)
    const m = new THREE.MeshStandardMaterial({ map: this.texture(maps.albedo, true), normalMap: this.texture(maps.normal, false),
      roughnessMap: orm, roughness: def.roughness_scale, metalness: def.metallic_scale });
    m.userData.orm = true;
    m.normalScale.set(def.normal_strength, def.normal_strength);
    m.name = name;
    if (extras.emission) {
      const e = extras.emission as number[];
      const peak = Math.max(e[0], e[1], e[2], 1e-3);
      m.emissive = new THREE.Color(e[0] / peak, e[1] / peak, e[2] / peak);
      m.emissiveIntensity = Math.min(peak, 12.0);
    }
    const kind = surfaceKind(name);
    if (kind === "glass") m.envMapIntensity = 1.6;
    else if (kind === "metal") m.envMapIntensity = 1.25;
    if (volumes) withSurface(m, { level: !!extras.level, thin: !!extras.thin, kind });
    this.cache.set(key, m);
    return m;
  }
}
