// A small glTF 2.0 binary (GLB) writer: meshes, a node tree, named materials. Geometry stays in the game's
// Z-up coordinates; the scene root carries the rotation to glTF's Y-up (so any GLB viewer shows it upright)
// and is marked extras.zup_root so the game client, which works in Z-up, drops it. Materials carry only a
// name (and extras); the client binds textures by name, so one GLB serves every texture quality.

import { DETAIL_OFFSET, FLOATS_PER_VERTEX, type MeshBuilder } from "../../shared/src/level/meshbuilder";

const FLOAT = 5126, UINT16 = 5123, UINT32 = 5125;
const ARRAY_BUFFER = 34962, ELEMENT_ARRAY_BUFFER = 34963;
const TYPES: Record<number, string> = { 1: "SCALAR", 2: "VEC2", 3: "VEC3", 4: "VEC4", 16: "MAT4" };
const ZUP_TO_YUP = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];

/* eslint-disable @typescript-eslint/no-explicit-any */
export class GltfBuilder {
  private chunks: Uint8Array[] = [];
  private length = 0;
  bufferViews: any[] = [];
  accessors: any[] = [];
  meshes: any[] = [];
  nodes: any[] = [];
  materials: any[] = [];
  skins: any[] = [];
  private matIndex = new Map<string, number>();
  roots: number[] = [];

  private view(data: Uint8Array, target: number | null): number {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) { this.chunks.push(new Uint8Array(pad)); this.length += pad; }
    const v: any = { buffer: 0, byteOffset: this.length, byteLength: data.byteLength };
    if (target !== null) v.target = target;
    this.chunks.push(data);
    this.length += data.byteLength;
    this.bufferViews.push(v);
    return this.bufferViews.length - 1;
  }

  accessor(data: Float32Array | Uint16Array | Uint32Array, comps: number, target: number | null = ARRAY_BUFFER, minmax = false): number {
    const ctype = data instanceof Float32Array ? FLOAT : data instanceof Uint16Array ? UINT16 : UINT32;
    const count = data.length / comps;
    const acc: any = { bufferView: this.view(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), target), componentType: ctype, count, type: TYPES[comps] };
    if (minmax) {
      const mn = new Array(comps).fill(Infinity), mx = new Array(comps).fill(-Infinity);
      for (let i = 0; i < count; i++) for (let c = 0; c < comps; c++) {
        const v = data[i * comps + c];
        if (v < mn[c]) mn[c] = v;
        if (v > mx[c]) mx[c] = v;
      }
      acc.min = mn;
      acc.max = mx;
    }
    this.accessors.push(acc);
    return this.accessors.length - 1;
  }

  material(name: string, extras: Record<string, unknown> | null = null): number {
    const key = extras ? name + JSON.stringify(extras) : name;
    let idx = this.matIndex.get(key);
    if (idx === undefined) {
      const m: any = { name };
      if (extras) m.extras = extras;
      this.materials.push(m);
      idx = this.materials.length - 1;
      this.matIndex.set(key, idx);
    }
    return idx;
  }

  /** A primitive from MeshBuilder rows (pos3 normal3 tangent3 binormal3 uv2). */
  primitive(mb: MeshBuilder, material: string, extras: Record<string, unknown> | null = null, withDetail = false): any | null {
    const nv = mb.vertexCount;
    if (!nv) return null;
    const v = mb.verts;
    const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), tan = new Float32Array(nv * 4), uv = new Float32Array(nv * 2);
    const det = withDetail ? new Float32Array(nv * 4) : null;
    for (let i = 0; i < nv; i++) {
      const o = i * FLOATS_PER_VERTEX;
      const n = [v[o + 3], v[o + 4], v[o + 5]], t = [v[o + 6], v[o + 7], v[o + 8]], b = [v[o + 9], v[o + 10], v[o + 11]];
      pos.set([v[o], v[o + 1], v[o + 2]], i * 3);
      nrm.set(n, i * 3);
      const cx = n[1] * t[2] - n[2] * t[1], cy = n[2] * t[0] - n[0] * t[2], cz = n[0] * t[1] - n[1] * t[0];
      const handed = cx * b[0] + cy * b[1] + cz * b[2] < 0 ? -1 : 1;
      tan.set([t[0], t[1], t[2], handed], i * 4);
      uv.set([v[o + 12], v[o + 13]], i * 2);
      if (det) det.set([v[o + DETAIL_OFFSET], v[o + DETAIL_OFFSET + 1], v[o + DETAIL_OFFSET + 2], v[o + DETAIL_OFFSET + 3]], i * 4);
    }
    const idx = nv <= 65535 ? Uint16Array.from(mb.indices) : Uint32Array.from(mb.indices);
    const attributes: Record<string, number> = { POSITION: this.accessor(pos, 3, ARRAY_BUFFER, true), NORMAL: this.accessor(nrm, 3), TANGENT: this.accessor(tan, 4),
      TEXCOORD_0: this.accessor(uv, 2) };
    // the level's surface detail (baked AO, dust height, weathering, thin size): a custom glTF attribute
    if (det) attributes._DETAIL = this.accessor(det, 4);
    return { attributes, indices: this.accessor(idx, 1, ELEMENT_ARRAY_BUFFER), material: this.material(material, extras), mode: 4 };
  }

  /** A skinned primitive from raw arrays (positions, normals, uvs, 4 joints and 4 weights per vertex). */
  skinnedPrimitive(pos: Float32Array, nrm: Float32Array, uv: Float32Array, joints: Uint16Array, weights: Float32Array,
                   idx: Uint16Array | Uint32Array, material: string): any {
    return { attributes: { POSITION: this.accessor(pos, 3, ARRAY_BUFFER, true), NORMAL: this.accessor(nrm, 3), TEXCOORD_0: this.accessor(uv, 2),
      JOINTS_0: this.accessor(joints, 4), WEIGHTS_0: this.accessor(weights, 4) }, indices: this.accessor(idx, 1, ELEMENT_ARRAY_BUFFER),
      material: this.material(material), mode: 4 };
  }

  skin(joints: number[], inverseBindMatrices: number): number {
    this.skins.push({ joints, inverseBindMatrices });
    return this.skins.length - 1;
  }

  mesh(name: string, primitives: any[]): number {
    this.meshes.push({ name, primitives });
    return this.meshes.length - 1;
  }

  node(name: string, mesh: number | null = null, children: number[] = [], extras: Record<string, unknown> | null = null, rotation: number[] | null = null,
       matrix: number[] | null = null, skin: number | null = null): number {
    const nd: any = { name };
    if (matrix) nd.matrix = matrix;
    if (skin !== null) nd.skin = skin;
    if (mesh !== null) nd.mesh = mesh;
    if (children.length) nd.children = children;
    if (rotation) nd.rotation = rotation;
    if (extras) nd.extras = extras;
    this.nodes.push(nd);
    return this.nodes.length - 1;
  }

  zupRoot(name: string, children: number[], extras: Record<string, unknown> = {}): number {
    const i = this.node(name, null, children, { zup_root: true, ...extras }, ZUP_TO_YUP);
    this.roots.push(i);
    return i;
  }

  toGlb(): Uint8Array {
    const binPad = (4 - (this.length % 4)) % 4;
    const binLen = this.length + binPad;
    const doc = { asset: { version: "2.0", generator: "COLD SECTOR scripts/assets/glb.ts" }, scene: 0, scenes: [{ nodes: this.roots }], nodes: this.nodes,
      meshes: this.meshes, materials: this.materials, accessors: this.accessors, bufferViews: this.bufferViews, buffers: [{ byteLength: binLen }],
      ...(this.skins.length ? { skins: this.skins } : {}) };
    let json = new TextEncoder().encode(JSON.stringify(doc));
    const jpad = (4 - (json.length % 4)) % 4;
    if (jpad) { const j2 = new Uint8Array(json.length + jpad).fill(0x20); j2.set(json); json = j2; }
    const total = 12 + 8 + json.length + 8 + binLen;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
    dv.setUint32(12, json.length, true); dv.setUint32(16, 0x4e4f534a, true);
    out.set(json, 20);
    let o = 20 + json.length;
    dv.setUint32(o, binLen, true); dv.setUint32(o + 4, 0x004e4942, true);
    o += 8;
    for (const c of this.chunks) { out.set(c, o); o += c.byteLength; }
    return out;
  }
}
