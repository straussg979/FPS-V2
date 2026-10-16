// Destructible panels on the client: the shared Panel (shared/src/destruction.ts) holds which chunks stand
// (from the snapshots' panel block) and gives the collision boxes the movement prediction collides with;
// this module turns that state into the drawn mesh (both faces of every standing chunk plus the edges around
// holes, steel plates on reinforced walls). Intact panels are batched per material.

import * as THREE from "three";
import { BOX_FACES } from "@cs/shared/level/meshbuilder";
import { DESTRUCTION } from "@cs/shared/data";
import { Panel } from "@cs/shared/destruction";
import type { CollisionWorld } from "@cs/shared/collision";
import type { PanelSpec } from "@cs/shared/level/level";
import { Level } from "@cs/shared/level/level";
import type { MaterialLibrary } from "./assets";

const SIGNS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

interface Arrays { pos: number[]; nrm: number[]; tan: number[]; uv: number[]; idx: number[] }
const newArrays = (): Arrays => ({ pos: [], nrm: [], tan: [], uv: [], idx: [] });

const mulRow = (v: number[], R: number[][]): number[] => [v[0] * R[0][0] + v[1] * R[1][0] + v[2] * R[2][0],
  v[0] * R[0][1] + v[1] * R[1][1] + v[2] * R[2][1], v[0] * R[0][2] + v[1] * R[1][2] + v[2] * R[2][2]];

function toGeometry(A: Arrays): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(A.pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(A.nrm, 3));
  g.setAttribute("tangent", new THREE.Float32BufferAttribute(A.tan, 4));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(A.uv, 2));
  g.setIndex(A.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(A.idx, 1) : new THREE.Uint16BufferAttribute(A.idx, 1));
  g.computeBoundingSphere();
  return g;
}

/** Faces of boxes (local centre, half extents) on one box face, into the arrays. */
function faces(out: Arrays, p: Panel, boxes: Array<[number[], number[]]>, face: number, uvScale: number): void {
  const [n, t, b] = BOX_FACES[face];
  const nw = mulRow(n, p.R), tw = mulRow(t, p.R), bw = mulRow(b, p.R);
  for (const [cc, half] of boxes) {
    const hn = Math.abs(n[0] * half[0] + n[1] * half[1] + n[2] * half[2]);
    const ht = Math.abs(t[0] * half[0] + t[1] * half[1] + t[2] * half[2]);
    const hb = Math.abs(b[0] * half[0] + b[1] * half[1] + b[2] * half[2]);
    const base = out.pos.length / 3;
    for (const [su, sv] of SIGNS) {
      const local = [0, 1, 2].map((k) => cc[k] + n[k] * hn + su * t[k] * ht + sv * b[k] * hb);
      const w = p.toWorld(local);
      out.pos.push(w[0], w[1], w[2]);
      out.nrm.push(nw[0], nw[1], nw[2]);
      out.tan.push(tw[0], tw[1], tw[2], 1);
      out.uv.push((w[0] * tw[0] + w[1] * tw[1] + w[2] * tw[2]) / uvScale, (w[0] * bw[0] + w[1] * bw[1] + w[2] * bw[2]) / uvScale);
    }
    out.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

export class PanelSet {
  panels: Panel[];
  private meshes = new Map<number, THREE.Group>();
  private batch = new THREE.Group();
  private dirtyBatch = true;
  version = 0;                     // bumps when any collision changes
  private plateMat: string;

  constructor(mapData: unknown, private materials: MaterialLibrary, private parent: THREE.Group) {
    const level = new Level("client", mapData as never, false);
    this.panels = level.panelSpecs.map((s: PanelSpec, i: number) => new Panel(s, i));
    this.plateMat = DESTRUCTION.reinforce?.plate_mat ?? "steel_painted";
    this.batch.name = "panels:intact";
    parent.add(this.batch);
  }

  /** The snapshot's panel states (full: everything not listed is intact). */
  apply(states: Array<{ index: number; reinforced: boolean; intact: boolean; mask: Uint8Array }>, full: boolean): void {
    const seen = new Set<number>();
    for (const st of states) {
      const p = this.panels[st.index];
      if (!p) continue;
      seen.add(st.index);
      const was = [p.intact, p.reinforced];
      if (st.intact) p.restore();
      else p.setMask(st.mask, st.reinforced);
      if (was[0] !== p.intact || was[1] !== p.reinforced) this.dirtyBatch = true;
      this.rebuild(p);
    }
    if (full) {
      for (const p of this.panels) {
        if (seen.has(p.index) || (p.intact && !p.reinforced)) continue;
        p.restore();
        this.dirtyBatch = true;
        this.rebuild(p);
      }
    }
    if (states.length || full) this.version++;
    if (this.dirtyBatch) this.rebuildBatch();
  }

  /** The reinforcement plate material is first used mid-round; touch it now so the shader warm-up compiles it. */
  warmupMaterials(): void {
    const g = new THREE.Group();
    g.name = "panels:warmup";
    g.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), this.materials.get(this.plateMat)));
    this.parent.add(g);
    setTimeout(() => this.parent.remove(g), 0);
  }

  syncCollision(world: CollisionWorld): void { for (const p of this.panels) p.syncCollision(world); }

  private rebuild(p: Panel): void {
    const old = this.meshes.get(p.index);
    if (old) {
      this.parent.remove(old);
      old.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      this.meshes.delete(p.index);
    }
    const group = new THREE.Group();
    if (!p.intact && !p.reinforced) {
      const [a, b] = p.ax;
      const half = [0, 0, 0];
      half[a] = p.cu / 2;
      half[b] = p.cv / 2;
      half[p.thin] = p.size[p.thin] / 2;
      const standing: Array<[number, number]> = [];
      for (let i = 0; i < p.nu; i++) for (let j = 0; j < p.nv; j++) if (p.alive[i * p.nv + j]) standing.push([i, j]);
      if (standing.length) {
        const A = newArrays(), B = newArrays();
        const box = (cells: Array<[number, number]>) => cells.map(([i, j]) => [p.cellCenterLocal(i * p.nv + j), half] as [number[], number[]]);
        const uvA = this.materials.uvScale(p.spec.mat), uvB = this.materials.uvScale(p.spec.mat2);
        faces(A, p, box(standing), p.thin * 2, uvA);
        faces(B, p, box(standing), p.thin * 2 + 1, uvB);
        const alive = (i: number, j: number) => i >= 0 && j >= 0 && i < p.nu && j < p.nv && p.alive[i * p.nv + j] === 1;
        for (const [axis, sign, di, dj] of [[a, 1, 1, 0], [a, -1, -1, 0], [b, 1, 0, 1], [b, -1, 0, -1]]) {
          faces(A, p, box(standing.filter(([i, j]) => !alive(i + di, j + dj))), axis * 2 + (sign > 0 ? 0 : 1), uvA);
        }
        for (const [mat, arr] of [[p.spec.mat, A], [p.spec.mat2, B]] as const) {
          if (!arr.idx.length) continue;
          const m = new THREE.Mesh(toGeometry(arr), this.materials.get(mat));
          m.castShadow = m.receiveShadow = true;
          group.add(m);
        }
      }
    }
    if (p.reinforced) {
      const all: Array<[number[], number[]]> = [[[0, 0, 0], p.size.map((v) => v / 2)]];
      const byMat = new Map<string, Arrays>();
      for (let face = 0; face < 6; face++) {
        const mat = face === p.thin * 2 + 1 ? p.spec.mat2 : p.spec.mat;
        if (!byMat.has(mat)) byMat.set(mat, newArrays());
        faces(byMat.get(mat) as Arrays, p, all, face, this.materials.uvScale(mat));
      }
      const plates = newArrays();
      const [a, b] = p.ax;
      const t = p.size[p.thin] / 2;
      const boxes: Array<[number[], number[]]> = [];
      for (const side of [1, -1]) {
        const plate = [0, 0, 0], cen = [0, 0, 0];
        plate[a] = p.size[a] / 2 - 0.02; plate[b] = p.size[b] / 2 - 0.02; plate[p.thin] = 0.012;
        cen[p.thin] = side * (t + 0.012);
        boxes.push([cen, plate]);
        for (const k of [-0.35, 0.0, 0.35]) {
          const brace = [0, 0, 0], bc = [0, 0, 0];
          brace[a] = p.size[a] / 2 - 0.05; brace[b] = 0.05; brace[p.thin] = 0.03;
          bc[p.thin] = side * (t + 0.05);
          bc[b] = k * p.size[b];
          boxes.push([bc, brace]);
        }
      }
      for (let face = 0; face < 6; face++) faces(plates, p, boxes, face, this.materials.uvScale(this.plateMat));
      byMat.set(`plate:${this.plateMat}`, plates);
      for (const [mat, arr] of byMat) {
        const m = new THREE.Mesh(toGeometry(arr), this.materials.get(mat.replace("plate:", "")));
        m.castShadow = m.receiveShadow = true;
        group.add(m);
      }
    }
    if (group.children.length) {
      this.meshes.set(p.index, group);
      this.parent.add(group);
    }
  }

  private rebuildBatch(): void {
    this.dirtyBatch = false;
    for (const c of [...this.batch.children]) {
      this.batch.remove(c);
      (c as THREE.Mesh).geometry.dispose();
    }
    const byMat = new Map<string, Arrays>();
    for (const p of this.panels) {
      if (!p.intact || p.reinforced) continue;
      const all: Array<[number[], number[]]> = [[[0, 0, 0], p.size.map((v) => v / 2)]];
      for (let face = 0; face < 6; face++) {
        const mat = face === p.thin * 2 + 1 ? p.spec.mat2 : p.spec.mat;
        if (!byMat.has(mat)) byMat.set(mat, newArrays());
        faces(byMat.get(mat) as Arrays, p, all, face, this.materials.uvScale(mat));
      }
    }
    for (const [mat, A] of byMat) {
      const m = new THREE.Mesh(toGeometry(A), this.materials.get(mat));
      m.castShadow = m.receiveShadow = true;
      this.batch.add(m);
    }
  }
}
