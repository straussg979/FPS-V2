// Level loading: map JSON -> collision boxes, destructible panels, gameplay data (spawns, zones,
// callouts, cameras, lights) and, for the asset build, geometry batched per material. Every map is data
// built from prefabs (prefabs.ts); a prefab only talks to the LevelContext.

import { materialInfo } from "../data";
import type { V3 } from "../math";
import { MeshBuilder } from "./meshbuilder";
import type { WeatherSource } from "./bake";
import { type Displace, surfaceField } from "./organic";
import { PREFABS } from "./prefabs";
import "./afghan";                     // registers the Afghanistan prefabs (mud houses, qala walls, vehicles...)

export interface Collider { c: V3; size: V3; hpr: V3; surface: string }

export interface PanelSpec {
  center: V3;
  size: V3;                 // full extents in the panel's own frame
  hpr: V3;
  mat: string;              // +thin side and the edges of holes
  mat2: string;             // -thin side
  surface: string;
  reinforceable: boolean;
  breach: boolean;          // bots may blow this wall open
  kind: "wall" | "floor";
  name: string;
}

export interface Zone { name: string; kind: string; team: string; min: V3; max: V3 }
export interface Callout { name: string; min: number[]; max: number[] }
export interface Spawn { team: string; pos: V3; heading: number }
export interface CameraSpec { name: string; pos: V3; heading: number; pitch: number }
export interface Occluder { c: V3; size: V3; hpr: V3 }

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Piece = Record<string, any>;

export class LevelContext {
  geometry: boolean;
  builders = new Map<string, MeshBuilder>();
  colliders: Collider[] = [];
  occluders: Occluder[] = [];
  lights: Piece[] = [];
  spawns: Spawn[] = [];
  props: Array<[string, Piece]> = [];
  zones: Zone[] = [];
  callouts: Callout[] = [];
  panels: PanelSpec[] = [];
  cameras: CameraSpec[] = [];
  /** Rain-streak / soot sources for the surface bake (bake.ts); geometry builds only. */
  weather: WeatherSource[] = [];
  private stack: Array<[V3, number]> = [[[0, 0, 0], 0]];

  constructor(geometry: boolean) {
    this.geometry = geometry;
  }

  // ---------------------------------------------------------- transforms
  pushTransform(offset: number[], heading: number): void {
    const [[ox, oy, oz], h] = this.stack[this.stack.length - 1];
    const a = h * Math.PI / 180;
    const wx = ox + offset[0] * Math.cos(a) - offset[1] * Math.sin(a);
    const wy = oy + offset[0] * Math.sin(a) + offset[1] * Math.cos(a);
    this.stack.push([[wx, wy, oz + offset[2]], h + heading]);
  }

  popTransform(): void { this.stack.pop(); }

  xf(p: number[], hpr: number[] = [0, 0, 0]): [V3, V3] {
    const [[ox, oy, oz], h] = this.stack[this.stack.length - 1];
    if (h === 0 && ox === 0 && oy === 0 && oz === 0) return [[p[0], p[1], p[2]], [hpr[0], hpr[1], hpr[2]]];
    const a = h * Math.PI / 180;
    const x = ox + p[0] * Math.cos(a) - p[1] * Math.sin(a);
    const y = oy + p[0] * Math.sin(a) + p[1] * Math.cos(a);
    return [[x, y, oz + p[2]], [hpr[0] + h, hpr[1], hpr[2]]];
  }

  xfDir(d: number[]): V3 {
    const a = this.stack[this.stack.length - 1][1] * Math.PI / 180;
    return [d[0] * Math.cos(a) - d[1] * Math.sin(a), d[0] * Math.sin(a) + d[1] * Math.cos(a), d[2]];
  }

  // ------------------------------------------------------------ emitters
  /** The batch for a material. Keys: "<mat>" (shared by every distance), "<mat>@thin" (thin pieces, faded with
   *  distance), "<mat>@backdrop" (the far terrain), "<mat>@hi:<cell>" / "<mat>@lo:<cell>" (the two building-detail
   *  variants of a 24 m cell). The GLB writes one node per suffix (scripts/assets/maps.ts). */
  builder(mat: string): MeshBuilder {
    // inside a level-of-detail variant every batch is per variant and per cell
    const key = this.variant && !mat.includes("@") ? `${mat}@${this.variant}:${this.cell}` : mat;
    let b = this.builders.get(key);
    if (!b) { this.builders.set(key, (b = new MeshBuilder())); b.name = mat.split("@")[0]; }
    return b;
  }

  // ------------------------------------------------------- level of detail
  /** Building detail comes in two variants per 24 m cell: "hi" (rounded, organic, small clutter) drawn near the
   *  camera, "lo" (the plain boxes) drawn further away; the client switches them per cell with hysteresis. */
  variant: "" | "hi" | "lo" = "";
  cell = "";
  static CELL = 24;
  cellOf(p: ArrayLike<number>): string {
    return `${Math.floor(p[0] / LevelContext.CELL)}_${Math.floor(p[1] / LevelContext.CELL)}`;
  }
  /** Run `fn` with the given variant (visual geometry only goes to that variant's batches). */
  withVariant(v: "hi" | "lo", worldPoint: ArrayLike<number>, fn: () => void): void {
    const pv = this.variant, pc = this.cell, pm = MeshBuilder.variant;
    this.variant = v;
    this.cell = this.cellOf(worldPoint);
    MeshBuilder.variant = v;
    try { fn(); } finally { this.variant = pv; this.cell = pc; MeshBuilder.variant = pm; }
  }
  /** The organic displacement for a material's surface type (organic.ts), or null. */
  organic(mat: string): Displace | null { return surfaceField(this.surface(mat)); }

  /** A box whose far version is the plain box (with its collider, exactly as box() makes it) and whose near version
   *  has rounded edges and, for organic surfaces, the displacement (visual only). */
  rbox(center: number[], size: number[], mat: string, opts: { hpr?: number[]; collide?: boolean; occlude?: boolean; surface?: string;
    round?: string[]; radius?: number; step?: number; displace?: boolean; skipFaces?: string[] } = {}): void {
    if (!this.geometry || this.variant) { this.box(center, size, mat, opts); return; }
    const [c, r] = this.xf(center, opts.hpr ?? [0, 0, 0]);
    this.withVariant("lo", c, () => this.box(center, size, mat, opts));
    this.withVariant("hi", c, () => this.builder(mat).addRoundedBox(c, [size[0], size[1], size[2]], { hpr: r, uvScale: this.uvScale(mat),
      radius: opts.radius ?? 0.05, round: opts.round, step: opts.step ?? 0.6, displace: opts.displace === false ? null : this.organic(mat),
      skipFaces: opts.skipFaces }));
  }

  /** Thin pieces (two small dimensions: bars, wires, rails) go to their own batch, which fades them with distance. */
  static isThin(size: ArrayLike<number>): boolean {
    const s = [size[0], size[1], size[2]].sort((a, b) => a - b);
    return s[1] < 0.06 && s[2] > s[1] * 4;
  }

  /** The batch for a material, or its thin-piece batch. */
  drawBuilder(mat: string, thin: boolean): MeshBuilder {
    const b = this.builder(thin && !this.variant ? `${mat}@thin` : mat);
    if (thin) b.name = mat;
    return b;
  }

  uvScale(mat: string): number { return materialInfo(mat).uvScale; }
  surface(mat: string): string { return materialInfo(mat).surface; }

  box(center: number[], size: number[], mat: string, opts: { hpr?: number[]; uv?: string; collide?: boolean;
    occlude?: boolean; skipFaces?: string[]; surface?: string } = {}): void {
    const [c, r] = this.xf(center, opts.hpr ?? [0, 0, 0]);
    const s: V3 = [size[0], size[1], size[2]];
    if (this.geometry) this.drawBuilder(mat, LevelContext.isThin(s)).addBox(c, s, r, this.uvScale(mat), opts.skipFaces ?? [], opts.uv ?? "world");
    if (opts.collide ?? true) this.colliders.push({ c, size: s, hpr: r, surface: opts.surface || this.surface(mat) });
    if (opts.occlude ?? true) this.occluders.push({ c, size: s, hpr: r });
  }

  wedge(base: number[], width: number, length: number, height: number, heading: number, mat: string): void {
    const [b, r] = this.xf(base, [heading, 0, 0]);
    if (this.geometry) this.builder(mat).addWedge(b, width, length, height, r[0], this.uvScale(mat));
  }

  cylinder(center: number[], radius: number, height: number, mat: string, segments = 20, caps = true,
           hpr: number[] = [0, 0, 0]): void {
    const [c, r] = this.xf(center, hpr);
    if (this.geometry) this.drawBuilder(mat, radius < 0.03 && height > radius * 8).addCylinder(c, radius, height, segments, this.uvScale(mat), caps, r);
  }

  sphere(center: number[], radius: number, mat: string): void {
    const [c] = this.xf(center);
    if (this.geometry) this.builder(mat).addSphere(c, radius, 24, 48, this.uvScale(mat));
  }

  /** Hemisphere dome on its rim at ``base`` (visual only; prefabs add their own collider). */
  dome(base: number[], radius: number, mat: string, squash = 1, segments = 32): void {
    const [c] = this.xf(base);
    if (this.geometry) this.builder(mat).addDome(c, radius, squash, Math.max(6, Math.round(segments / 3)), segments, this.uvScale(mat));
  }

  /** Box with bevelled edges (visual only): rounded-looking bodywork, rocks, beams. */
  chamfer(center: number[], size: number[], mat: string, bevel = 0.04, hpr: number[] = [0, 0, 0]): void {
    const [c, r] = this.xf(center, hpr);
    if (this.geometry) this.builder(mat).addChamferBox(c, [size[0], size[1], size[2]], bevel, r, this.uvScale(mat), "world");
  }

  panel(center: number[], size: number[], mat: string, mat2: string | null, opts: { hpr?: number[]; reinforce?: boolean;
    breach?: boolean; kind?: "wall" | "floor"; name?: string; occlude?: boolean; surface?: string } = {}): void {
    const [c, r] = this.xf(center, opts.hpr ?? [0, 0, 0]);
    this.panels.push({ center: c, size: [size[0], size[1], size[2]], hpr: r, mat, mat2: mat2 || mat,
      surface: opts.surface || this.surface(mat), reinforceable: !!opts.reinforce, breach: !!opts.breach,
      kind: opts.kind ?? "wall", name: opts.name ?? "" });
    if (opts.occlude ?? true) this.occluders.push({ c, size: [size[0], size[1], size[2]], hpr: r });
  }

  collider(center: number[], size: number[], hpr: number[] = [0, 0, 0], surface = "concrete"): void {
    const [c, r] = this.xf(center, hpr);
    this.colliders.push({ c, size: [size[0], size[1], size[2]], hpr: r, surface });
  }

  occluder(center: number[], size: number[], hpr: number[] = [0, 0, 0]): void {
    const [c, r] = this.xf(center, hpr);
    this.occluders.push({ c, size: [size[0], size[1], size[2]], hpr: r });
  }

  light(e: Piece): void {
    const [pos] = this.xf(e.pos);
    const out: Piece = { ...e, pos };
    if (e.dir) out.dir = this.xfDir(e.dir);
    this.lights.push(out);
  }

  prop(kind: string, e: Piece): void {
    const out: Piece = { ...e };
    for (const key of ["pos", "base"]) {
      if (key in out) {
        const [p, hpr] = this.xf(out[key], [out.heading ?? 0, 0, 0]);
        out[key] = p;
        out.heading = hpr[0];
      }
    }
    this.props.push([kind, out]);
  }

  /** A weathering source (local coordinates like everything else): streaks (strength > 0) or soot (< 0) on the
   *  walls facing `out` below `p`. */
  weatherAt(p: number[], out: number[], width: number, length: number, strength: number): void {
    if (!this.geometry) return;
    const [c] = this.xf(p);
    const d = this.xfDir([out[0], out[1], 0]);
    this.weather.push({ p: c, out: [d[0], d[1]], width, length, strength });
  }

  buildPiece(e: Piece): void {
    const fn = PREFABS[e.type];
    if (!fn) return;
    const rec = MeshBuilder.recorder;
    const prev = rec?.label ?? "";
    if (rec && e.type !== "group") rec.label = `${e.type}${e.kind ? ":" + e.kind : ""}${e.name ? " " + e.name : ""}`;
    // the dust gradient is measured from the piece's base (walls, houses, props); floors and terrain have none
    const prevBase = MeshBuilder.baseZ;
    if (e.type !== "group") {
      const z = e.z ?? e.base?.[2] ?? (e.type === "floor" || e.type === "terrain" || e.type === "paint_line" ? null : 0);
      MeshBuilder.baseZ = z === null ? null : this.xf([0, 0, z])[0][2];
    }
    fn(this, e);
    MeshBuilder.baseZ = prevBase;
    if (rec) rec.label = prev;
  }
}

/** The built level: what the simulation needs (and the geometry when built with it). */
export class Level {
  data: Piece;
  name: string;
  mapKey: string;
  colliders: Collider[];
  panelSpecs: PanelSpec[];
  spawns: Spawn[];
  zones: Zone[];
  callouts: Callout[];
  cameras: CameraSpec[];
  props: Array<[string, Piece]>;
  lights: Piece[];
  clips: Array<{ center: V3; size: V3; hpr: V3 }> = [];
  modeLayout: string | null = null;
  ctx: LevelContext;

  constructor(mapKey: string, data: Piece, geometry = false) {
    this.mapKey = mapKey;
    this.data = data;
    this.name = data.name ?? mapKey;
    const ctx = new LevelContext(geometry);
    for (const piece of data.pieces ?? []) ctx.buildPiece(piece);
    this.ctx = ctx;
    this.colliders = ctx.colliders;
    this.panelSpecs = ctx.panels;
    this.spawns = ctx.spawns;
    this.zones = ctx.zones;
    this.callouts = ctx.callouts;
    this.cameras = ctx.cameras;
    this.props = ctx.props;
    this.lights = ctx.lights;
  }

  get bounds(): [V3, V3] { return this.data.bounds; }

  /** Static colliders plus every destructible panel as a solid box (the navmesh: holes become links). */
  navColliders(): Collider[] {
    return [...this.colliders, ...this.panelSpecs.map((p) => ({ c: p.center, size: p.size, hpr: p.hpr, surface: p.surface }))];
  }

  /** A mode's layout of this map (modes.<name> in its JSON): only the listed bomb sites, its own spawns
   * and invisible player-clip walls (movement only). */
  applyMode(name: string): Piece {
    const spec = this.data.modes?.[name];
    if (!spec) throw new Error(`map ${this.name} has no ${name} layout`);
    if (spec.sites) {
      const keep = new Set(spec.sites);
      this.zones = this.zones.filter((z) => z.kind !== "bombsite" || keep.has(z.name));
    }
    if (spec.spawns) this.spawns = spec.spawns.map((s: Spawn) => ({ ...s, pos: [...s.pos] as V3 }));
    for (const c of spec.clips ?? []) this.clips.push({ center: [...c.center] as V3, size: [...c.size] as V3, hpr: (c.hpr ?? [0, 0, 0]) as V3 });
    this.modeLayout = name;
    return spec;
  }

  zoneAt(pos: ArrayLike<number>, kind = "bombsite"): Zone | null {
    for (const z of this.zones) {
      if (z.kind === kind && [0, 1, 2].every((i) => z.min[i] <= pos[i] && pos[i] <= z.max[i])) return z;
    }
    return null;
  }

  calloutAt(x: number, y: number): string {
    let best = "", bestArea = Infinity;
    for (const c of this.callouts) {
      const [x0, y0] = c.min, [x1, y1] = c.max;
      if (x0 <= x && x <= x1 && y0 <= y && y <= y1) {
        const area = (x1 - x0) * (y1 - y0);
        if (area < bestArea) { best = c.name; bestArea = area; }
      }
    }
    return best;
  }

  spawnPoint(team?: string): Spawn {
    for (const s of this.spawns) if (!team || s.team === team) return s;
    return { team: "attack", pos: [0, 0, 1], heading: 0 };
  }

  supportsMatch(): boolean {
    const sites = this.zones.filter((z) => z.kind === "bombsite");
    const teams = new Set(this.spawns.map((s) => s.team));
    return sites.length >= 1 && teams.has("attack") && teams.has("defend");
  }
}
