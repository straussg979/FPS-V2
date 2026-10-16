// Afghanistan prefabs: mud-brick houses with timber beams, qala (fort) walls and towers, domed roofs,
// bazaar shops (container shops and mud stalls), village props, and detailed vehicles (Hilux pickups and
// technicals, Corolla taxis, painted "jingle" trucks, motorbikes, a BTR wreck and a T-55 wreck).
// Like prefabs.ts, every piece only talks to the LevelContext: visual parts are batched per material,
// gameplay gets simple boxes for collision and the light bake.

import { Random } from "../rng";
import type { LevelContext, Piece } from "./level";
import { PREFABS, wall } from "./prefabs";
import { FLOATS_PER_VERTEX } from "./meshbuilder";
import { noise3 } from "./organic";

const D = Math.PI / 180;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = (e: Piece, k: string, d: any): any => (e[k] === undefined ? d : e[k]);

function rot2d(x: number, y: number, heading: number): [number, number] {
  const a = heading * D;
  const c = Math.cos(a), s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}

function local(origin: number[], heading: number, lx: number, ly: number, lz: number): number[] {
  const [wx, wy] = rot2d(lx, ly, heading);
  return [origin[0] + wx, origin[1] + wy, (origin[2] ?? 0) + lz];
}

/** A prefab's own frame (x right, y forward, z up) at ``base`` turned by ``hd``; ``r`` = [heading, pitch, roll]
 * offsets of a part in that frame. Visual parts never collide; ``solid`` and ``col`` add gameplay boxes. */
class Frame {
  constructor(public ctx: LevelContext, public base: number[], public hd: number) {}
  p(lx: number, ly: number, lz: number): number[] { return local(this.base, this.hd, lx, ly, lz); }
  r(r?: number[]): number[] { return [this.hd + (r?.[0] ?? 0), r?.[1] ?? 0, r?.[2] ?? 0]; }
  box(lx: number, ly: number, lz: number, size: number[], mat: string, r?: number[], uv = "world"): void {
    if (!this.ctx.geometry) return;
    this.ctx.box(this.p(lx, ly, lz), size, mat, { hpr: this.r(r), collide: false, occlude: false, uv });
  }
  bev(lx: number, ly: number, lz: number, size: number[], mat: string, bevel = 0.04, r?: number[]): void {
    if (!this.ctx.geometry) return;
    this.ctx.chamfer(this.p(lx, ly, lz), size, mat, bevel, this.r(r));
  }
  cyl(lx: number, ly: number, lz: number, radius: number, h: number, mat: string, seg = 16, r?: number[], caps = true): void {
    if (!this.ctx.geometry) return;
    this.ctx.cylinder(this.p(lx, ly, lz), radius, h, mat, seg, caps, this.r(r));
  }
  /** A corrugated sheet (both sides) of w x l in the frame's x / y, pitched by `pitch` degrees, corrugations
   *  running along y: the sine profile catches the light the way real sheet metal does. */
  wavy(lx: number, ly: number, lz: number, w: number, l: number, pitch: number, mat: string): void {
    if (!this.ctx.geometry) return;
    const mb = this.ctx.builder(mat);
    const uv = this.ctx.uvScale(mat);
    const period = 0.076, amp = 0.012, n = Math.max(2, Math.round(w / period * 4));
    const cp = Math.cos(pitch * D), sp = Math.sin(pitch * D);
    const h = this.hd * D;
    for (const side of [1, -1]) {
      const base = mb.vertexCount;
      for (const yy of [-l / 2, l / 2]) for (let i = 0; i <= n; i++) {
        const xx = -w / 2 + w * i / n;
        const ph = (xx / period) * Math.PI * 2;
        const zz = Math.sin(ph) * amp + side * 0.002;
        const dz = Math.cos(ph) * amp * Math.PI * 2 / period;
        // local point (x, y, z) pitched about x, then into the frame
        const [P] = this.ctx.xf(this.p(lx + xx, ly + yy * cp - zz * sp, lz + yy * sp + zz * cp));
        const nl = Math.hypot(dz, 1);
        const nx = -dz / nl * side, nzL = 1 / nl * side;
        const ny = -sp * nzL, nz = cp * nzL;
        const N = [nx * Math.cos(h) - ny * Math.sin(h), nx * Math.sin(h) + ny * Math.cos(h), nz];
        const T = [Math.cos(h), Math.sin(h), 0];
        mb.vertex(P, N, T, [N[1] * T[2] - N[2] * T[1], N[2] * T[0] - N[0] * T[2], N[0] * T[1] - N[1] * T[0]], xx / uv, yy / uv);
      }
      for (let i = 0; i < n; i++) {
        const a = base + i, b = a + 1, c = base + n + 1 + i + 1, d = base + n + 1 + i;
        if (side > 0) mb.indices.push(a, b, c, a, c, d); else mb.indices.push(a, c, b, a, d, c);
      }
    }
  }
  /** A cylinder lying along local x (axles, beams across x). */
  cylX(lx: number, ly: number, lz: number, radius: number, len: number, mat: string, seg = 16): void {
    this.cyl(lx, ly, lz, radius, len, mat, seg, [0, 0, 90]);
  }
  /** A cylinder lying along local y. */
  cylY(lx: number, ly: number, lz: number, radius: number, len: number, mat: string, seg = 16): void {
    this.cyl(lx, ly, lz, radius, len, mat, seg, [0, 90, 0]);
  }
  dome(lx: number, ly: number, lz: number, radius: number, mat: string, squash = 1, seg = 28): void {
    if (!this.ctx.geometry) return;
    this.ctx.dome(this.p(lx, ly, lz), radius, mat, squash, seg);
  }
  ball(lx: number, ly: number, lz: number, radius: number, mat: string, rings = 5, seg = 8): void {
    if (!this.ctx.geometry) return;
    const [c] = this.ctx.xf(this.p(lx, ly, lz));
    this.ctx.builder(mat).addSphere(c, radius, rings, seg, this.ctx.uvScale(mat));
  }
  solid(lx: number, ly: number, lz: number, size: number[], mat: string, r?: number[], occlude = true): void {
    this.ctx.box(this.p(lx, ly, lz), size, mat, { hpr: this.r(r), collide: true, occlude });
  }
  /** A solid whose near version is rounded (and organic for earth / plaster): same collider as solid(). */
  rsolid(lx: number, ly: number, lz: number, size: number[], mat: string, round: string[], radius: number, r?: number[], occlude = true): void {
    this.ctx.rbox(this.p(lx, ly, lz), size, mat, { hpr: this.r(r), collide: true, occlude, round, radius });
  }
  col(lx: number, ly: number, lz: number, size: number[], surface = "metal", r?: number[], occlude = false): void {
    this.ctx.collider(this.p(lx, ly, lz), size, this.r(r), surface);
    if (occlude) this.ctx.occluder(this.p(lx, ly, lz), size, this.r(r));
  }
  occ(lx: number, ly: number, lz: number, size: number[], r?: number[]): void {
    this.ctx.occluder(this.p(lx, ly, lz), size, this.r(r));
  }
  /** A wheel whose axle runs along local x: tyre, sidewall bulge, rim, hub and wheel nuts. */
  wheel(lx: number, ly: number, radius: number, width: number, rim = "steel", tyre = "rubber"): void {
    if (!this.ctx.geometry) return;
    const side = Math.sign(lx || 1);
    this.cylX(lx, ly, radius, radius, width, tyre, 20);
    this.cylX(lx + side * 0.004, ly, radius, radius * 0.93, width + 0.02, tyre, 20);
    this.cylX(lx + side * (width / 2 + 0.006), ly, radius, radius * 0.6, 0.02, rim, 16);
    this.cylX(lx + side * (width / 2 + 0.018), ly, radius, radius * 0.2, 0.03, rim, 10);
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * 2 * Math.PI;
      this.box(lx + side * (width / 2 + 0.02), ly + Math.cos(a) * radius * 0.36, radius + Math.sin(a) * radius * 0.36,
        [0.03, 0.035, 0.035], "steel");
    }
  }
}

function subtractSpans(lo: number, hi: number, gaps: Array<[number, number]>): Array<[number, number]> {
  let spans: Array<[number, number]> = [[lo, hi]];
  for (const [g0, g1] of gaps) {
    const out: Array<[number, number]> = [];
    for (const [a, b] of spans) {
      if (g1 <= a || g0 >= b) { out.push([a, b]); continue; }
      if (g0 > a) out.push([a, g0]);
      if (g1 < b) out.push([g1, b]);
    }
    spans = out;
  }
  return spans.filter(([a, b]) => b - a > 0.05);
}

const DOOR_MATS = ["door_blue", "door_green", "wood_dark", "door_blue", "metal_blue"];
const SHUTTER_MATS = ["door_blue", "door_green", "wood_dark", "metal_green"];

// ================================================================ houses
/** One side of a rectangular building, walked from its first to its last corner. ``out`` is the outward
 * normal; ``at(s)`` gives the wall's outer-face point at distance s from the side's start. */
interface Side {
  name: string; ax: "x" | "y"; start: number; dir: number; fixed: number; out: [number, number]; length: number;
}

function sidesOf(x0: number, y0: number, x1: number, y1: number): Side[] {
  return [
    { name: "s", ax: "x", start: x0, dir: 1, fixed: y0, out: [0, -1], length: x1 - x0 },
    { name: "e", ax: "y", start: y0, dir: 1, fixed: x1, out: [1, 0], length: y1 - y0 },
    { name: "n", ax: "x", start: x1, dir: -1, fixed: y1, out: [0, 1], length: x1 - x0 },
    { name: "w", ax: "y", start: y1, dir: -1, fixed: x0, out: [-1, 0], length: y1 - y0 },
  ];
}

/** A point on a side: ``along`` in the side's map axis coordinate, ``off`` metres outward of the face. */
function sidePoint(s: Side, along: number, off: number, z: number): number[] {
  if (s.ax === "x") return [along, s.fixed + s.out[1] * off, z];
  return [s.fixed + s.out[0] * off, along, z];
}

/** Heading whose local +y points outward of the side (local x then runs along the wall). */
function sideHeading(s: Side): number {
  return Math.atan2(-s.out[0], s.out[1]) / D;
}

/** Door leaf standing open against the inside of the wall, with planks and iron straps. */
function doorLeaf(ctx: LevelContext, s: Side, along: number, inset: number, width: number, height: number, z: number,
                  mat: string, hinge: number): void {
  const f = new Frame(ctx, sidePoint(s, along + hinge * s.dir * width, -inset, z), sideHeading(s));
  f.box(0, 0, height / 2, [width * 0.96, 0.05, height - 0.04], mat);
  for (const zz of [0.25, height / 2, height - 0.3]) f.box(0, -0.03, zz, [width * 0.94, 0.012, 0.08], "steel");
  f.box(0, -0.035, height * 0.55, [0.05, 0.015, 0.12], "brass");
}

/**
 * mud_house: an Afghan mud-brick (khesht) house. A building core (thick rendered mud walls, earth roof,
 * parapet) plus: a darker plinth around the base, timber ceiling beams whose ends poke through the walls,
 * wooden lintels over every opening, door leaves standing open, shutters and iron grilles on windows, wooden
 * roof spouts with rain streaks under them, a rounded parapet cap, optional brick domes and roof clutter.
 */
PREFABS.mud_house = (ctx, e) => {
  const [[x0, y0], [x1, y1]] = [e.min, e.max];
  const z = g(e, "z", 0.0);
  const h = g(e, "height", 3.0);
  const t = g(e, "wall", 0.45);
  const roofT = g(e, "roof_thickness", 0.35);
  const ext = g(e, "mat", "mud_wall");
  const extMat = ext;
  const rng = new Random(g(e, "seed", Math.trunc(Math.abs(x0 * 13 + y0 * 7)) + 3));
  const parapet = g(e, "parapet", 0.55);
  const core: Piece = {
    ...e, type: "building", height: h, wall: t, roof_thickness: roofT, mat: ext, mat_in: g(e, "mat_in", "mud_wall_light"),
    floor_mat: g(e, "floor_mat", "dirt"), roof_mat: g(e, "roof_mat", "mud_roof"), ceiling_mat: g(e, "ceiling_mat", "reed_ceiling"),
    edge_mat: g(e, "edge_mat", ext), parapet, frame_mat: g(e, "frame_mat", "wood_dark"),
  };
  PREFABS.building(ctx, core);
  const top = z + h + roofT;
  const ops: Piece = g(e, "openings", {});
  const sides = sidesOf(x0, y0, x1, y1);
  const doorMat = g(e, "door_mat", rng.choice(DOOR_MATS));
  const shutterMat = g(e, "shutter_mat", rng.choice(SHUTTER_MATS));
  const open = new Set<string>(g(e, "open_sides", []));
  for (const s of sides) {
    if (open.has(s.name)) continue;
    const list: Piece[] = ops[s.name] ?? [];
    const key = s.ax;
    const lo = Math.min(s.start, s.start + s.dir * s.length), hi = Math.max(s.start, s.start + s.dir * s.length);
    const hd = sideHeading(s);
    // corner pieces: the bands along x (south / north sides) run past the corners and cover them; the bands along y
    // stop against them, so two bands never overlap at a corner (their tops used to share a plane and z-fight)
    const cornerX = s.ax === "x";
    const ext = (out: number) => (cornerX ? out : -0.012);
    // plinth, split around doorways
    const doors: Array<[number, number]> = list.filter((op) => g(op, "bottom", 0) < 0.05).map((op) => [op[key] - op.width / 2 - 0.02, op[key] + op.width / 2 + 0.02]);
    if (g(e, "plinth", true)) {
      for (const [a, b] of subtractSpans(lo - ext(0.13), hi + ext(0.13), doors)) {
        const c = sidePoint(s, (a + b) / 2, 0.06, z + 0.24);
        // a worn, rounded top edge and an uneven face near the camera (rbox: plain box further away)
        ctx.rbox(c, [b - a, 0.14, 0.48], g(e, "plinth_mat", "mud_plinth"), { hpr: [hd, 0, 0], collide: false, occlude: false,
          round: ["+z", "+y"], radius: 0.05, step: 0.6 });
        // ground contact: a slight earth ramp against the foot and a little rubble (near detail only)
        if (ctx.geometry && b - a > 0.6) {
          const mid = ctx.xf(c)[0];
          ctx.withVariant("hi", mid, () => {
            const rc = ctx.xf(sidePoint(s, (a + b) / 2, 0.2, z - 0.015), [hd, 0, 0]);
            ctx.builder("dirt").addRoundedBox(rc[0], [b - a - 0.1, 0.32, 0.09], { hpr: rc[1], uvScale: ctx.uvScale("dirt"), radius: 0.04,
              round: ["+z", "+y", "-y", "+x", "-x"], step: 0.8, displace: ctx.organic("dirt") });
            const nr = Math.floor((b - a) / 2.5);
            for (let k = 0; k < nr; k++) {
              const u = a + 0.3 + rng.random() * (b - a - 0.6), sz = 0.05 + rng.random() * 0.07;
              ctx.chamfer(sidePoint(s, u, 0.25 + rng.random() * 0.25, z + sz * 0.3), [sz * 1.4, sz, sz * 0.8], g(e, "plinth_mat", "mud_plinth"), sz * 0.3,
                [hd + rng.uniform(0, 90), rng.uniform(-10, 10), 0]);
            }
          });
        }
      }
    }
    // rounded parapet cap and a slightly proud band where the roof slab sits
    if (parapet > 0) {
      const gaps: Array<[number, number]> = (g(e, "parapet_gaps", []) as Piece[]).filter((gp) => gp.side === s.name).map((gp) => [gp.from, gp.to]);
      for (const [a, b] of subtractSpans(lo - (cornerX ? 0.06 : -0.26), hi + (cornerX ? 0.06 : -0.26), gaps)) {
        ctx.chamfer(sidePoint(s, (a + b) / 2, -0.1, top + parapet + 0.04), [b - a, 0.32, 0.1], extMat, 0.04, [hd, 0, 0]);
      }
    }
    const bandLo = lo - ext(0.09), bandHi = hi + ext(0.09);
    const band = sidePoint(s, (bandLo + bandHi) / 2, 0.04, top - roofT / 2);
    ctx.rbox(band, [bandHi - bandLo, 0.08, roofT + 0.06], g(e, "band_mat", "mud_plinth"), { hpr: [hd, 0, 0], collide: false, occlude: false,
      round: ["+z", "-z", "+y"], radius: 0.025, step: 0.8 });
    // rain runs down from the parapet along the whole side (the shader draws the streaks, bake.ts the mask)
    ctx.weatherAt(sidePoint(s, (lo + hi) / 2, 0, top + parapet), s.out, hi - lo, 1.3, 0.35);
    if (ctx.geometry) ctx.withVariant("hi", ctx.xf(band)[0], () => {
      // reed matting showing under the earth roof's edge, and dirt drifted against the parapet on the roof
      ctx.box(sidePoint(s, (lo + hi) / 2, 0.035, top - roofT - 0.045), [hi - lo - 0.1, 0.07, 0.03], "reed_ceiling", { hpr: [hd, 0, 0], collide: false, occlude: false });
      if (parapet > 0) {
        const dc = ctx.xf(sidePoint(s, (lo + hi) / 2, -0.38, top - 0.03), [hd, 0, 0]);
        ctx.builder(g(e, "roof_mat", "mud_roof")).addRoundedBox(dc[0], [Math.max(0.2, hi - lo - 0.8), 0.32, 0.1], { hpr: dc[1], uvScale: ctx.uvScale("mud_roof"),
          radius: 0.05, round: ["+z", "-y", "+x", "-x"], step: 0.8, displace: ctx.organic("mud_roof") });
      }
    });
    // openings: lintels, doors, shutters, grilles
    for (const op of list) {
      const at = op[key], w = op.width;
      const ob = g(op, "bottom", 0.0), ot = g(op, "top", Math.min(2.2, h));
      const lintel = sidePoint(s, at, 0.03, z + ot + 0.09);
      // hand-cut timber: not quite level, not quite square
      ctx.chamfer(lintel, [w + 0.55, t + 0.1, 0.16], "wood_old", 0.025, [hd + rng.uniform(-0.6, 0.6), 0, rng.uniform(-0.8, 0.8)]);
      if (ob >= 0.05) ctx.weatherAt(sidePoint(s, at, 0, z + ob), s.out, w + 0.1, Math.min(1.1, ob), 0.6);
      if (rng.random() < 0.18) ctx.weatherAt(sidePoint(s, at, 0, z + ot + 1.3), s.out, w * 0.9, 1.2, -0.75);   // a kitchen: soot above
      if (ob < 0.05) {
        if (g(op, "door", true)) doorLeaf(ctx, s, at, t + 0.03, w, ot - 0.02, z, g(op, "mat", doorMat), rng.random() < 0.5 ? -1 : 1);
        // threshold stone
        ctx.box(sidePoint(s, at, -t / 2, z + 0.02), [w + 0.1, t + 0.3, 0.04], "stone_wall", { hpr: [hd, 0, 0], collide: false, occlude: false });
      } else {
        const sh = g(op, "shutters", true);
        if (sh) {
          for (const side of [-1, 1]) {
            const f = new Frame(ctx, sidePoint(s, at + side * s.dir * (w * 0.75 + 0.02), 0.04, z + (ob + ot) / 2), hd);
            f.box(0, 0, 0, [w / 2, 0.04, ot - ob - 0.04], g(op, "mat", shutterMat));
            for (const zz of [-(ot - ob) / 4, 0, (ot - ob) / 4]) f.box(0, 0.025, zz, [w / 2 - 0.06, 0.012, 0.035], "wood_dark");
          }
        }
        if (g(op, "grille", rng.random() < 0.6)) {
          const n = Math.max(Math.round(w / 0.16), 2);
          for (let i = 1; i < n; i++) {
            const a = at - w / 2 + (w * i) / n;
            ctx.box(sidePoint(s, a, -t / 2, z + (ob + ot) / 2), [0.022, 0.022, ot - ob], "steel", { hpr: [hd, 0, 0], collide: false, occlude: false });
          }
          ctx.box(sidePoint(s, at, -t / 2, z + ob + (ot - ob) * 0.5), [w, 0.032, 0.025], "steel", { hpr: [hd, 0, 0], collide: false, occlude: false });
        }
      }
    }
    // roof spouts (naw) and the dark rain streaks below them
    if (g(e, "spouts", true) && (s.name === "s" || s.name === "n" || s.length < 9)) {
      const n = Math.max(Math.floor(s.length / 4.5), 1);
      for (let i = 0; i < n; i++) {
        const a = lo + (hi - lo) * (i + 0.5) / n + rng.uniform(-0.4, 0.4);
        if (list.some((op) => Math.abs(op[key] - a) < op.width / 2 + 0.5)) continue;
        const f = new Frame(ctx, sidePoint(s, a, 0, top + 0.08), hd);
        f.box(0, 0.3, 0, [0.14, 0.62, 0.1], "wood_old", [0, -8, 0]);
        // the rain streak below it is now part of the wall's own surface (bake.ts + surface.ts), not a flat stain card
        ctx.weatherAt(sidePoint(s, a, 0, top + 0.05), s.out, 0.35 + rng.uniform(0, 0.15), 1.8, 1.0);
      }
    }
    // the timber ceiling beams (vigas) poke out along the long sides
    if (g(e, "beam_ends", true) && (s.ax === "x") === (x1 - x0 >= y1 - y0)) {
      const n = Math.max(Math.floor(s.length / 0.75), 2);
      for (let i = 0; i < n; i++) {
        const a = lo + (hi - lo) * (i + 0.5) / n;
        if (list.some((op) => Math.abs(op[key] - a) < op.width / 2 + 0.3 && g(op, "top", 2.2) > h - 0.5)) continue;
        const f = new Frame(ctx, sidePoint(s, a, 0.12, top - roofT - 0.1), hd);
        f.cylY(0, 0, 0, 0.075 + rng.uniform(-0.01, 0.015), 0.28 + rng.uniform(0, 0.12), "wood_old", 7);
      }
    }
  }
  // ceiling beams inside, spanning the short way
  if (g(e, "beams", true)) {
    const alongX = x1 - x0 >= y1 - y0;
    const L = alongX ? x1 - x0 : y1 - y0;
    const span = alongX ? y1 - y0 - 2 * t : x1 - x0 - 2 * t;
    const n = Math.max(Math.floor(L / 0.75), 2);
    for (let i = 0; i < n; i++) {
      const a = (alongX ? x0 : y0) + L * (i + 0.5) / n;
      const c = alongX ? [a, (y0 + y1) / 2, z + h - 0.08] : [(x0 + x1) / 2, a, z + h - 0.08];
      ctx.cylinder(c, 0.075, span, "wood_old", 7, false, alongX ? [0, 90, 0] : [0, 0, 90]);
    }
  }
  domesOf(ctx, e, top);
  roofClutter(ctx, e, top, rng);
};

/** Brick domes on a drum, as on Herat and Balkh houses. Each dome gets a low collider so its roof is solid. */
function domesOf(ctx: LevelContext, e: Piece, top: number): void {
  for (const d of g(e, "domes", []) as Piece[]) {
    const r = g(d, "r", 1.6);
    const mat = g(d, "mat", "mud_brick");
    const squash = g(d, "squash", 0.85);
    ctx.cylinder([d.x, d.y, top + 0.15], r + 0.05, 0.3, g(d, "drum_mat", "mud_wall"), 28, false);
    if (ctx.geometry) {
      // hand-laid: a slightly irregular profile (radial displacement) and a ring of brick at the base
      const mb = ctx.builder(mat);
      const v0 = mb.vertexCount;
      ctx.dome([d.x, d.y, top + 0.3], r, mat, squash, 28);
      const [c0] = ctx.xf([d.x, d.y, top + 0.3]);
      const v = mb.verts;
      for (let i = v0; i < mb.vertexCount; i++) {
        const o = i * FLOATS_PER_VERTEX;
        const dx = v[o] - c0[0], dy = v[o + 1] - c0[1], dz = v[o + 2] - c0[2];
        const k = 1 + 0.018 * (noise3(v[o] * 1.1, v[o + 1] * 1.1, v[o + 2] * 1.1, 41) - 0.5) * 2 * Math.min(1, dz / 0.3);
        v[o] = c0[0] + dx * k; v[o + 1] = c0[1] + dy * k; v[o + 2] = c0[2] + dz * k;
      }
      ctx.cylinder([d.x, d.y, top + 0.36], r + 0.035, 0.12, "mud_brick", 28, false);
    } else ctx.dome([d.x, d.y, top + 0.3], r, mat, squash, 28);
    ctx.cylinder([d.x, d.y, top + 0.3 + r * squash + 0.02], 0.22, 0.12, "mud_wall", 12);
    ctx.collider([d.x, d.y, top + (0.3 + r * squash * 0.55) / 2], [r * 1.5, r * 1.5, 0.3 + r * squash * 0.55], [0, 0, 0], "plaster");
    ctx.occluder([d.x, d.y, top + (0.3 + r * squash * 0.7) / 2], [r * 1.5, r * 1.5, 0.3 + r * squash * 0.7]);
  }
}

/** A water tank, a satellite dish, a firewood bundle or a laundry line on the roof. */
function roofClutter(ctx: LevelContext, e: Piece, top: number, rng: Random): void {
  const items: Piece[] = g(e, "roof_items", []);
  for (const it of items) {
    const f = new Frame(ctx, [it.x, it.y, top], g(it, "heading", 0));
    const kind = it.kind;
    if (kind === "tank") {
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) f.box(sx * 0.4, sy * 0.4, 0.35, [0.06, 0.06, 0.7], "steel");
      f.box(0, 0, 0.72, [1.0, 1.0, 0.05], "steel");
      f.cyl(0, 0, 1.25, 0.5, 1.0, "tank_black", 18);
      f.cyl(0, 0, 1.78, 0.18, 0.08, "tank_black", 12);
      f.col(0, 0, 0.9, [1.0, 1.0, 1.8], "metal");
    } else if (kind === "dish") {
      f.box(0, 0, 0.6, [0.05, 0.05, 1.2], "steel");
      f.cyl(0, 0.1, 1.15, 0.45, 0.04, "paint_white", 20, [0, 60, 0]);
      f.box(0, 0.35, 1.25, [0.03, 0.5, 0.03], "steel", [0, 30, 0]);
    } else if (kind === "wood") {
      for (let i = 0; i < 9; i++) {
        f.cylX(rng.uniform(-0.1, 0.1), (i % 3 - 1) * 0.16, 0.08 + Math.floor(i / 3) * 0.14, 0.07, 1.6 + rng.uniform(-0.2, 0.2), "wood_old", 7);
      }
      f.col(0, 0, 0.25, [1.6, 0.5, 0.5], "wood");
    } else if (kind === "laundry") {
      const L = g(it, "length", 4);
      for (const sx of [-1, 1]) f.box(sx * L / 2, 0, 0.9, [0.05, 0.05, 1.8], "wood_old");
      f.box(0, 0, 1.75, [L, 0.012, 0.012], "steel");
      const cloth = ["cloth_white", "carpet_red", "tarp_blue", "cloth_green", "carpet_blue"];
      let x = -L / 2 + 0.3;
      while (x < L / 2 - 0.4) {
        const w = rng.uniform(0.35, 0.8);
        f.box(x + w / 2, 0, 1.75 - 0.35, [w, 0.015, rng.uniform(0.4, 0.75)], rng.choice(cloth));
        x += w + rng.uniform(0.05, 0.25);
      }
    } else if (kind === "antenna") {
      f.box(0, 0, 2.0, [0.04, 0.04, 4.0], "steel");
      for (const zz of [3.2, 3.6, 3.9]) f.box(0, 0, zz, [0.9, 0.02, 0.02], "steel");
    }
  }
}

// ================================================================ qala walls and towers
/**
 * qala_wall: a thick rammed-earth / mud-brick wall. A battered (wider) footing, buttresses, a rounded cap,
 * optional crenellations, eroded notches along the top with rubble below, and gates with heavy timber
 * doors swung open. Openings work like ``wall`` ("at" along the wall from p0); "gate": true dresses one.
 */
PREFABS.qala_wall = (ctx, e) => {
  const p0: number[] = e.p0, p1: number[] = e.p1;
  const h = g(e, "height", 4.2);
  const t = g(e, "thickness", 0.8);
  const z0 = g(e, "z", 0.0);
  const mat = g(e, "mat", "mud_wall");
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  const L = Math.hypot(dx, dy);
  const hd = Math.atan2(dy, dx) / D;
  const rng = new Random(g(e, "seed", Math.trunc(Math.abs(p0[0] * 11 + p0[1] * 5)) + 7));
  const openings: Piece[] = (e.openings ?? []).map((op: Piece) => ({ ...op }));
  // eroded notches along the top (skipping gates)
  const notches = Math.trunc(g(e, "damage", 0));
  for (let i = 0; i < notches; i++) {
    const at = rng.uniform(1.2, L - 1.2);
    if (openings.some((op) => Math.abs(op.at - at) < op.width / 2 + 1.2)) continue;
    const w = rng.uniform(0.6, 1.6);
    openings.push({ at, width: w, bottom: h - rng.uniform(0.35, Math.min(1.1, h * 0.3)), top: h + 0.1, notch: true });
  }
  wall(ctx, { p0, p1, height: h, thickness: t, z: z0, mat: g(e, "mat_in", mat), mat2: mat, openings, frame_mat: null, top_exposed: !g(e, "merlons", false),
    soft: g(e, "soft", false), reinforce: g(e, "reinforce", false), breach: g(e, "breach", false), name: g(e, "name", "") });
  // the footing: one collider per span between doorways
  const doors: Array<[number, number]> = openings.filter((op) => g(op, "bottom", 0) < 0.05).map((op) => [op.at - op.width / 2, op.at + op.width / 2]);
  // frame: local x along the wall from p0, local y = the wall's left (+y side of heading)
  const f = new Frame(ctx, [p0[0], p0[1], z0], hd - 90);
  // in this frame local +y runs along the wall (heading - 90 turns +y onto the wall direction), +x is the right-hand side
  const footW = t + 0.36;
  if (g(e, "footing", true)) {
    for (const [a, b] of subtractSpans(-0.05, L + 0.05, doors)) {
      f.rsolid(0, (a + b) / 2, 0.45, [footW, b - a, 0.9], g(e, "foot_mat", "mud_plinth"), ["+x", "-x", "+z"], 0.08, undefined, false);
      f.bev(0, (a + b) / 2, 0.92, [footW - 0.08, b - a, 0.12], g(e, "foot_mat", "mud_plinth"), 0.05);
    }
  }
  // rounded cap along the remaining top
  const tops: Array<[number, number]> = openings.filter((op) => g(op, "top", 2.2) >= h - 0.01).map((op) => [op.at - op.width / 2, op.at + op.width / 2]);
  for (const [a, b] of subtractSpans(0, L, tops)) f.bev(0, (a + b) / 2, h + 0.05, [t + 0.08, b - a, 0.14], mat, 0.06);
  for (const op of openings.filter((o) => o.notch)) {
    // rubble below a notch
    for (let k = 0; k < 4; k++) {
      const s = op.at + rng.uniform(-op.width, op.width);
      const side = rng.random() < 0.5 ? -1 : 1;
      const sz = rng.uniform(0.2, 0.45);
      f.bev(side * (footW / 2 + rng.uniform(0.15, 0.6)), s, sz * 0.4, [sz * 1.3, sz, sz * 0.8], mat, 0.06, [rng.uniform(0, 90), rng.uniform(-10, 10), 0]);
    }
  }
  // crenellations
  if (g(e, "merlons", false)) {
    const n = Math.max(Math.floor(L / 1.3), 1);
    for (let i = 0; i < n; i++) {
      const s = (i + 0.5) * L / n;
      if (tops.some(([a, b]) => s > a - 0.4 && s < b + 0.4)) continue;
      f.solid(0, s, h + 0.4, [t * 0.8, 0.7, 0.7], mat, undefined, true);
      f.bev(0, s, h + 0.76, [t * 0.8 + 0.04, 0.74, 0.06], mat, 0.025);
    }
  }
  // buttresses
  const bs = g(e, "buttress", 0);
  if (bs > 0) {
    const n = Math.max(Math.floor(L / bs), 1);
    for (let i = 1; i < n; i++) {
      const s = i * L / n;
      if (openings.some((op) => Math.abs(op.at - s) < op.width / 2 + 0.9)) continue;
      for (const side of g(e, "buttress_sides", [-1, 1]) as number[]) {
        f.rsolid(side * (t / 2 + 0.22), s, h * 0.42, [0.44, 0.8, h * 0.84], mat, [side > 0 ? "+x" : "-x", "+y", "-y", "+z"], 0.1, undefined, false);
        f.bev(side * (t / 2 + 0.16), s, h * 0.86, [0.32, 0.78, 0.2], mat, 0.08, [0, 0, side * -20]);
      }
    }
  }
  // gates: thick posts, a heavy lintel beam and two timber leaves swung open
  for (const op of openings.filter((o) => o.gate)) {
    const w = op.width, top = g(op, "top", Math.min(2.2, h));
    const gm = g(op, "mat", rng.choice(["wood_dark", "door_blue", "door_green", "metal_blue"]));
    for (const s of [op.at - w / 2 - 0.3, op.at + w / 2 + 0.3]) f.solid(0, s, h / 2 + 0.1, [t + 0.5, 0.6, h + 0.2], mat, undefined, true);
    f.bev(0, op.at, top + 0.16, [t + 0.3, w + 0.9, 0.3], "wood_old", 0.04);
    for (const zz of [0.05, 0.1]) f.box(0, op.at, top + 0.33 + zz, [t + 0.1, w + 0.5, 0.05], "wood_dark");
    for (const sgn of [-1, 1]) {
      const swing = g(op, "swing", -1);       // -1: leaves open toward local -x (the right side seen from p0)
      const hingeS = op.at + sgn * (w / 2 - 0.04);
      const leafLen = w / 2 - 0.05;
      const cx = swing * (t / 2 + leafLen / 2 * 0.98);
      const cs = hingeS;
      // a leaf opened 90 degrees stands perpendicular to the wall at the hinge
      f.box(cx, cs - sgn * 0.04, (top - 0.05) / 2, [leafLen, 0.08, top - 0.06], gm);
      for (const zz of [0.3, top / 2, top - 0.35]) f.box(cx, cs - sgn * 0.09, zz, [leafLen - 0.05, 0.015, 0.1], "steel");
      for (let k = 0; k < 4; k++) f.box(cx - leafLen / 2 + 0.15 + k * (leafLen - 0.3) / 3, cs - sgn * 0.09, top * 0.62, [0.04, 0.02, 0.04], "brass");
    }
  }
};

/** burj: a tapering mud watchtower, square or round, with loopholes, a crown of merlons and a parapet. */
PREFABS.watchtower = (ctx, e) => {
  const base: number[] = e.base;
  const h = g(e, "height", 7.0);
  const s0 = g(e, "size", 3.2);
  const taper = g(e, "taper", 0.6);
  const mat = g(e, "mat", "mud_wall");
  const round = g(e, "round", true);
  const hd = g(e, "heading", 0);
  const f = new Frame(ctx, base, hd);
  const steps = 5;
  if (round && ctx.geometry) {
    // one smooth, gently tapering and slightly irregular earth drum (it was five stacked cylinders with steps)
    const mb = ctx.builder(mat);
    const [cb] = ctx.xf(base);
    const seg = 28, rings = Math.max(6, Math.ceil(h / 0.5));
    const uv = ctx.uvScale(mat);
    const v0 = mb.vertexCount;
    const radius = (z: number, a: number) => (s0 - taper * (z / h)) / 2 * (1 + 0.02 * (noise3(Math.cos(a) * 1.7 + cb[0], Math.sin(a) * 1.7 + cb[1], z * 0.8, 7) - 0.5) * 2);
    for (let j = 0; j <= rings; j++) {
      const zz = h * j / rings;
      for (let k = 0; k <= seg; k++) {
        const a = k / seg * Math.PI * 2;
        const rr = radius(zz, a);
        const dr = (radius(zz + 0.05, a) - radius(Math.max(0, zz - 0.05), a)) / 0.1;
        const n = [Math.cos(a), Math.sin(a), -dr];
        const nl = Math.hypot(n[0], n[1], n[2]);
        mb.vertex([cb[0] + Math.cos(a) * rr, cb[1] + Math.sin(a) * rr, cb[2] + zz], [n[0] / nl, n[1] / nl, n[2] / nl], [-Math.sin(a), Math.cos(a), 0],
          [0, 0, 1], a * s0 / 2 / uv, zz / uv);
      }
    }
    for (let j = 0; j < rings; j++) for (let k = 0; k < seg; k++) {
      const a = v0 + j * (seg + 1) + k, b = a + 1, c = a + seg + 2, d = a + seg + 1;
      mb.indices.push(a, b, c, a, c, d);
    }
  } else {
    for (let i = 0; i < steps; i++) {
      const za = (h * i) / steps, zb = (h * (i + 1)) / steps;
      const w = s0 - taper * ((i + 0.5) / steps);
      if (round) f.cyl(0, 0, (za + zb) / 2, w / 2, zb - za + 0.01, mat, 24, undefined, i === steps - 1);
      else f.box(0, 0, (za + zb) / 2, [w, w, zb - za + 0.01], mat);
    }
  }
  const topW = s0 - taper;
  if (round) f.cyl(0, 0, h + 0.08, topW / 2 + 0.12, 0.16, mat, 24);
  else f.bev(0, 0, h + 0.08, [topW + 0.24, topW + 0.24, 0.16], mat, 0.05);
  // merlons around the top
  const n = round ? 8 : 8;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    const r = topW / 2 + 0.02;
    const lx = round ? Math.cos(a) * r : Math.max(-1, Math.min(1, Math.cos(a) * 1.5)) * r;
    const ly = round ? Math.sin(a) * r : Math.max(-1, Math.min(1, Math.sin(a) * 1.5)) * r;
    f.bev(lx, ly, h + 0.5, [0.42, 0.42, 0.7], mat, 0.06, [(a / D), 0, 0]);
  }
  // loopholes: dark slits on two levels, splayed with a wooden lintel
  for (const zz of [h * 0.45, h * 0.78]) {
    for (let k = 0; k < 4; k++) {
      const a = (k * 90 + (zz > h * 0.6 ? 45 : 0)) * D;
      const w = s0 - taper * (zz / h);
      const r = w / 2 + 0.005;
      const ff = new Frame(ctx, f.p(Math.cos(a) * r, Math.sin(a) * r, zz), hd + a / D - 90);
      ff.box(0, 0, 0, [0.16, 0.03, 0.6], "shadow");
      ff.box(0, 0.01, 0.36, [0.36, 0.04, 0.08], "wood_old");
    }
  }
  // collision: one tapered stack approximated by two boxes
  const c = round ? 0.9 : 1.0;
  f.col(0, 0, h * 0.3, [s0 * c, s0 * c, h * 0.6], "plaster", undefined, true);
  f.col(0, 0, h * 0.8 + 0.25, [topW * c + 0.2, topW * c + 0.2, h * 0.4 + 0.5], "plaster", undefined, true);
};

/** rock_wall: a cliff face of jumbled boulders closing the map, at least ``height`` high everywhere. */
PREFABS.rock_wall = (ctx, e) => {
  const p0: number[] = e.p0, p1: number[] = e.p1;
  const h = g(e, "height", 9.0);
  const depth = g(e, "depth", 4.0);
  const mat = g(e, "mat", "rock");
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  const L = Math.hypot(dx, dy);
  const hd = Math.atan2(dy, dx) / D;
  const rng = new Random(g(e, "seed", Math.trunc(Math.abs(p0[0] * 3 + p0[1] * 17)) + 11));
  const f = new Frame(ctx, [p0[0], p0[1], g(e, "z", 0)], hd - 90);
  if (ctx.geometry) {
    let s = -1.5;
    while (s < L + 1.5) {
      const w = rng.uniform(2.2, 6.0);
      const hh = h * rng.uniform(0.95, 1.5);
      const dd = depth * rng.uniform(0.8, 1.3);
      // the main slab, tilted and turned so the face is never a flat wall
      f.bev(rng.uniform(-0.6, 0.6) + depth * 0.2, s + w / 2, hh / 2 - 0.4, [dd, w * 1.2, hh], mat, rng.uniform(0.6, 1.1),
        [rng.uniform(-22, 22), rng.uniform(-9, 9), rng.uniform(-10, 10)]);
      // a cap stone on top, set back
      if (rng.random() < 0.65) {
        const cs = rng.uniform(1.4, 2.8);
        f.bev(depth * 0.4 + rng.uniform(-0.3, 0.6), s + rng.uniform(0, w), hh - 0.3 + cs * 0.3, [cs * 1.5, cs * 1.3, cs], mat, 0.45,
          [rng.uniform(0, 90), rng.uniform(-15, 15), rng.uniform(-15, 15)]);
      }
      // scree and fallen blocks at the foot, toward the play area
      const nf = rng.random() < 0.8 ? 1 + Math.floor(rng.random() * 2) : 0;
      for (let k = 0; k < nf; k++) {
        const sz = rng.uniform(0.6, 1.7);
        f.bev(-depth / 2 - sz * 0.25, s + rng.uniform(0, w), sz * 0.35, [sz * 1.4, sz * 1.2, sz], mat, Math.min(0.3, sz * 0.25),
          [rng.uniform(0, 90), rng.uniform(-12, 12), rng.uniform(-12, 12)]);
      }
      s += w * rng.uniform(0.7, 0.9);
    }
  }
  f.col(depth * 0.15, L / 2, h / 2 + 2, [depth, L + 2, h + 4], "concrete", undefined, true);
};

/** rocks: a scatter of boulders, each solid (cover in the wadi). */
PREFABS.rocks = (ctx, e) => {
  const base: number[] = e.base;
  const n = Math.trunc(g(e, "count", 4));
  const s = g(e, "size", 1.2);
  const spread = g(e, "spread", 2.0);
  const rng = new Random(g(e, "seed", 5));
  const mat = g(e, "mat", "rock");
  for (let i = 0; i < n; i++) {
    const lx = i === 0 ? 0 : rng.uniform(-spread, spread), ly = i === 0 ? 0 : rng.uniform(-spread, spread);
    const sz = s * (i === 0 ? 1 : rng.uniform(0.35, 0.8));
    const hd = rng.uniform(0, 90);
    const dims = [sz * rng.uniform(1.1, 1.6), sz * rng.uniform(0.9, 1.3), sz * rng.uniform(0.6, 0.95)];
    const f = new Frame(ctx, [base[0] + lx, base[1] + ly, base[2] ?? 0], hd);
    f.bev(0, 0, dims[2] / 2 - 0.08, dims, mat, Math.min(0.3, sz * 0.22), [0, rng.uniform(-6, 6), rng.uniform(-6, 6)]);
    if (sz > 0.45) f.col(0, 0, dims[2] / 2 - 0.08, [dims[0] * 0.9, dims[1] * 0.9, dims[2]], "concrete", undefined, true);
  }
};

// ================================================================ bazaar
const GOODS_COLORS = ["jingle_red", "jingle_yellow", "jingle_green", "jingle_blue", "cloth_white", "carpet_red", "fruit_orange", "tarp_blue"];

function goods(f: Frame, kind: string, w: number, d: number, rng: Random): void {
  if (kind === "fruit") {
    // sloped display boards with crates of fruit in rows
    f.box(0, 0, 0.45, [w, d, 0.06], "wood_old", [0, -12, 0]);
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) f.box(sx * (w / 2 - 0.05), sy * (d / 2 - 0.05), 0.3, [0.06, 0.06, 0.6], "wood_old");
    const cols = Math.max(Math.floor(w / 0.55), 1);
    for (let i = 0; i < cols; i++) for (let j = 0; j < 2; j++) {
      const lx = -w / 2 + 0.3 + i * (w - 0.6) / Math.max(cols - 1, 1);
      const ly = (j - 0.5) * d * 0.5;
      const lz = 0.55 + (j === 0 ? 0.06 : -0.06);
      f.box(lx, ly, lz, [0.48, 0.36, 0.14], "plywood");
      const fruit = rng.choice(["fruit_orange", "fruit_green", "paint_red", "jingle_yellow"]);
      for (let k = 0; k < 6; k++) f.ball(lx + ((k % 3) - 1) * 0.13, ly + (Math.floor(k / 3) - 0.5) * 0.14, lz + 0.11, 0.07, fruit, 4, 6);
    }
  } else if (kind === "rugs") {
    for (let i = 0; i < 4; i++) f.box(0, (i - 1.5) * 0.02, 0.1 + i * 0.12, [w * 0.85, d * 0.8, 0.1], rng.choice(["carpet_red", "carpet_blue", "carpet_red"]), [rng.uniform(-4, 4), 0, 0]);
    f.box(0, 0, 1.0, [w * 0.9, d * 0.6, 0.06], "wood_old");
  } else if (kind === "tires") {
    for (let i = 0; i < Math.floor(w / 0.7); i++) {
      const n = 3 + Math.floor(rng.random() * 4);
      for (let k = 0; k < n; k++) f.cyl(-w / 2 + 0.35 + i * 0.7, rng.uniform(-0.1, 0.1), 0.1 + k * 0.2, 0.32, 0.19, "rubber", 16);
    }
  } else if (kind === "cans") {
    for (const zz of [0.4, 0.85, 1.3]) {
      f.box(0, 0, zz - 0.03, [w, d, 0.04], "wood_old");
      let x = -w / 2 + 0.1;
      while (x < w / 2 - 0.2) {
        const bw = rng.uniform(0.12, 0.3);
        f.box(x + bw / 2, 0, zz + 0.1, [bw, d * 0.7, rng.uniform(0.12, 0.3)], rng.choice(GOODS_COLORS));
        x += bw + 0.03;
      }
    }
  } else if (kind === "cloth") {
    for (let i = 0; i < Math.floor(w / 0.32); i++) {
      for (let k = 0; k < 3; k++) f.cylY(-w / 2 + 0.2 + i * 0.32, 0, 0.18 + k * 0.28, 0.13, d * 0.8, rng.choice(GOODS_COLORS), 10);
    }
  } else if (kind === "sacks") {
    for (let i = 0; i < 8; i++) {
      f.bev(-w / 2 + 0.4 + (i % 4) * (w - 0.8) / 3, (Math.floor(i / 4) - 0.5) * 0.5, 0.25, [0.55, 0.4, 0.5], "sack", 0.12, [rng.uniform(-10, 10), 0, 0]);
    }
  }
}

/**
 * shop: a bazaar shop opening on its local -y side. "container" style is a shipping container with one long side
 * cut open (very common in Afghan bazaars), "mud" style is a mud-brick stall with a timber front. Both get an
 * awning on poles, a rolled-up shutter, a counter, goods inside and a hanging bulb.
 */
PREFABS.shop = (ctx, e) => {
  const base: number[] = e.base;
  const hd = g(e, "heading", 0);
  const style = g(e, "style", "container");
  const W = g(e, "width", style === "container" ? 6.06 : 3.6);
  const Dp = g(e, "depth", style === "container" ? 2.44 : 3.0);
  const H = g(e, "height", style === "container" ? 2.59 : 2.8);
  const rng = new Random(g(e, "seed", Math.trunc(Math.abs(base[0] * 31 + base[1] * 17)) + 1));
  const kind = g(e, "goods", rng.choice(["fruit", "rugs", "tires", "cans", "cloth", "sacks"]));
  const f = new Frame(ctx, base, hd);
  const t = style === "container" ? 0.08 : 0.35;
  const wm = style === "container" ? g(e, "mat", rng.choice(["container_red", "container_green", "container_blue", "corrugated_rust"])) : g(e, "mat", "mud_wall");
  const inner = style === "container" ? wm : "mud_wall_light";
  // back and side walls (solid), roof, floor
  f.solid(0, Dp / 2 - t / 2, H / 2, [W, t, H], wm);
  for (const sx of [-1, 1]) f.solid(sx * (W / 2 - t / 2), 0, H / 2, [t, Dp, H], wm);
  f.solid(0, 0, H - 0.05, [W, Dp, 0.1], style === "container" ? wm : "mud_roof");
  f.box(0, 0, 0.02, [W - 2 * t, Dp - t, 0.04], style === "container" ? "wood_planks" : "dirt");
  if (style === "container") {
    // corner castings and top/bottom rails
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      f.box(sx * (W / 2 - 0.08), sy * (Dp / 2 - 0.08), H / 2, [0.17, 0.17, H + 0.01], "steel_painted");
      for (const zz of [0.08, H - 0.08]) f.box(sx * (W / 2 - 0.09), sy * (Dp / 2 - 0.09), zz, [0.2, 0.2, 0.17], "steel");     // proud of the post
    }
    for (const zz of [0.1, H - 0.1]) f.box(0, -Dp / 2 + 0.06, zz, [W, 0.12, 0.2], "steel_painted");
  } else {
    // timber front frame: posts and a beam
    for (const sx of [-1, 1]) f.box(sx * (W / 2 - 0.1), -Dp / 2 + 0.05, H / 2, [0.18, 0.12, H], "wood_old");
    f.bev(0, -Dp / 2 + 0.05, H - 0.2, [W + 0.3, 0.2, 0.22], "wood_old", 0.03);
    f.box(0, 0, H + 0.12, [W + 0.2, Dp + 0.2, 0.25], "mud_wall");
  }
  // rolled shutter above the opening
  f.cylX(0, -Dp / 2 + 0.12, H - 0.3, 0.14, W - 0.3, g(e, "shutter_mat", rng.choice(["metal_blue", "metal_green", "steel_painted"])), 12);
  // awning on two poles in front
  const aw = g(e, "awning", 1.6);
  if (aw > 0) {
    const am = g(e, "awning_mat", rng.choice(["tarp_blue", "canvas", "awning_stripe", "corrugated_rust", "carpet_red"]));
    const drop = 0.35;
    const ang = Math.atan2(drop, aw) / D;
    if (am.startsWith("corrugated")) f.wavy(0, -Dp / 2 - aw / 2, H - drop / 2 + 0.05, W + 0.2, Math.hypot(aw, drop), ang, am);
    else f.box(0, -Dp / 2 - aw / 2, H - drop / 2 + 0.05, [W + 0.2, Math.hypot(aw, drop), 0.04], am, [0, -ang, 0]);
    for (const sx of [-1, 1]) {
      f.box(sx * (W / 2 - 0.05), -Dp / 2 - aw + 0.05, (H - drop) / 2, [0.07, 0.07, H - drop], "wood_old");
      f.col(sx * (W / 2 - 0.05), -Dp / 2 - aw + 0.05, (H - drop) / 2, [0.12, 0.12, H - drop], "wood");
    }
    f.box(0, -Dp / 2 - aw + 0.05, H - drop - 0.04, [W + 0.1, 0.06, 0.08], "wood_old");
  }
  // counter across part of the front (cover) and the goods
  const cw = W * 0.45;
  f.solid(-W / 2 + t + cw / 2 + 0.1, -Dp / 2 + 0.45, 0.45, [cw, 0.6, 0.9], style === "container" ? "wood_planks" : "mud_plinth", undefined, false);
  f.box(-W / 2 + t + cw / 2 + 0.1, -Dp / 2 + 0.45, 0.92, [cw + 0.1, 0.7, 0.05], "wood_old");
  const gf = new Frame(ctx, f.p(W * 0.12, Dp * 0.12, 0), hd);
  goods(gf, kind, W * 0.55, Dp * 0.55, rng);
  f.col(W * 0.12, Dp * 0.12, 0.4, [W * 0.5, Dp * 0.45, 0.8], "wood");
  // goods hanging from the awning beam
  if (kind === "rugs" || kind === "cloth") {
    for (let i = 0; i < 3; i++) f.box(-W / 2 + 0.6 + i * 0.9, -Dp / 2 - 0.1, H - 0.9, [0.8, 0.02, 1.3], rng.choice(["carpet_red", "carpet_blue", "cloth_green"]));
  }
  if (g(e, "light", true)) ctx.light({ pos: f.p(0, 0.2, H - 0.25), kind: "point", fixture: "bulb", kelvin: 2700, intensity: 4, range: 6, shadows: false });
  if (e.sign) ctx.prop("sign", { text: e.sign, pos: f.p(0, -Dp / 2 - 0.02, H + 0.25), heading: hd, scale: g(e, "sign_scale", 0.3), color: g(e, "sign_color", [0.9, 0.85, 0.7, 1]) });
};

/** awning: a free-standing canopy on timber poles (a covered market lane or a tea-house terrace). */
PREFABS.awning = (ctx, e) => {
  const [[x0, y0], [x1, y1]] = [e.min, e.max];
  const h = g(e, "height", 3.0);
  const mat = g(e, "mat", "tarp_blue");
  const sp = g(e, "spacing", 3.0);
  const nx = Math.max(Math.round((x1 - x0) / sp), 1), ny = Math.max(Math.round((y1 - y0) / sp), 1);
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= ny; j++) {
    if (i > 0 && i < nx && j > 0 && j < ny) continue;
    const x = x0 + (x1 - x0) * i / nx, y = y0 + (y1 - y0) * j / ny;
    ctx.cylinder([x, y, h / 2], 0.06, h, "wood_old", 8);
    ctx.collider([x, y, h / 2], [0.12, 0.12, h], [0, 0, 0], "wood");
  }
  if (!ctx.geometry) return;
  for (let i = 0; i <= nx; i++) ctx.box([x0 + (x1 - x0) * i / nx, (y0 + y1) / 2, h], [0.1, y1 - y0, 0.1], "wood_old", { collide: false, occlude: false });
  // a sagging cloth: three strips at slightly different heights
  const segs = 3;
  for (let k = 0; k < segs; k++) {
    const ya = y0 + (y1 - y0) * k / segs, yb = y0 + (y1 - y0) * (k + 1) / segs;
    const sag = k === 1 ? -0.12 : 0;
    ctx.box([(x0 + x1) / 2, (ya + yb) / 2, h + 0.08 + sag], [x1 - x0 + 0.3, yb - ya + 0.02, 0.03], mat, { collide: false, occlude: g(e, "occlude", true) });
  }
};

/** bunting: strings of little coloured flags sagging between two points (bazaar lanes, shrines). */
PREFABS.bunting = (ctx, e) => {
  if (!ctx.geometry) return;
  const p0: number[] = e.p0, p1: number[] = e.p1;
  const z0 = g(e, "z", 4.0), z1 = g(e, "z1", z0);
  const sag = g(e, "sag", 0.6);
  const rng = new Random(g(e, "seed", 2));
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  const L = Math.hypot(dx, dy);
  const hd = Math.atan2(dy, dx) / D;
  const n = Math.max(Math.floor(L / 0.45), 2);
  const cols = g(e, "colors", ["jingle_red", "jingle_green", "jingle_yellow", "cloth_white", "jingle_blue"]);
  let prev: number[] | null = null;
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    const z = z0 + (z1 - z0) * s - sag * 4 * s * (1 - s);
    const p = [p0[0] + dx * s, p0[1] + dy * s, z];
    if (prev) {
      const seg = Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
      const pitch = Math.atan2(p[2] - prev[2], Math.hypot(p[0] - prev[0], p[1] - prev[1])) / D;
      ctx.box([(p[0] + prev[0]) / 2, (p[1] + prev[1]) / 2, (p[2] + prev[2]) / 2], [i % 2 ? 0.014 : 0.019, seg, i % 2 ? 0.014 : 0.019], "steel", { hpr: [hd - 90, pitch, 0], collide: false, occlude: false });
      ctx.box([(p[0] + prev[0]) / 2, (p[1] + prev[1]) / 2, (p[2] + prev[2]) / 2 - 0.13], [0.24, 0.006, 0.24], cols[i % cols.length], { hpr: [hd, 0, 45 + rng.uniform(-5, 5)], collide: false, occlude: false });
    }
    prev = p;
  }
};

/** power_line: wooden poles with cross-arms and three sagging wires through a list of points. */
PREFABS.power_line = (ctx, e) => {
  const pts: number[][] = e.points;
  const h = g(e, "height", 7.0);
  const sag = g(e, "sag", 0.7);
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pts[i];
    const nxt = pts[Math.min(i + 1, pts.length - 1)], prv = pts[Math.max(i - 1, 0)];
    const hd = Math.atan2(nxt[1] - prv[1], nxt[0] - prv[0]) / D;
    ctx.cylinder([x, y, h / 2], 0.12, h, "wood_old", 10);
    ctx.collider([x, y, h / 2], [0.24, 0.24, h], [0, 0, 0], "wood");
    if (ctx.geometry) {
      const f = new Frame(ctx, [x, y, 0], hd);
      f.box(0, 0, h - 0.4, [0.1, 1.6, 0.1], "wood_old");
      for (const ly of [-0.7, 0, 0.7]) f.cyl(0, ly, h - 0.28, 0.035, 0.14, "cloth_white", 8);
      if (i === Math.floor(pts.length / 2)) f.cyl(0.3, 0, h - 1.4, 0.22, 0.6, "steel_painted", 12);
    }
  }
  if (!ctx.geometry) return;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const hd = Math.atan2(b[1] - a[1], b[0] - a[0]) / D;
    const [ox, oy] = rot2d(1, 0, hd + 90);
    for (const off of [-0.7, 0, 0.7]) {
      const segs = 6;
      let prev: number[] | null = null;
      for (let k = 0; k <= segs; k++) {
        const s = k / segs;
        const p = [a[0] + (b[0] - a[0]) * s + ox * off, a[1] + (b[1] - a[1]) * s + oy * off, h - 0.22 - sag * 4 * s * (1 - s)];
        if (prev) {
          const seg = Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
          const pitch = Math.atan2(p[2] - prev[2], Math.hypot(p[0] - prev[0], p[1] - prev[1])) / D;
          // neighbouring segments overlap at the joint; alternating their thickness keeps their faces apart
          const wt = k % 2 ? 0.02 : 0.027;
          ctx.box([(p[0] + prev[0]) / 2, (p[1] + prev[1]) / 2, (p[2] + prev[2]) / 2], [wt, seg + 0.01, wt], "rubber", { hpr: [hd - 90, pitch, 0], collide: false, occlude: false });
        }
        prev = p;
      }
    }
  }
};

// ================================================================ village props
/** tree: a poplar (tall, narrow), a mulberry (broad) or an apricot (small) with a trunk collider. */
PREFABS.tree = (ctx, e) => {
  const base: number[] = e.base;
  const kind = g(e, "kind", "mulberry");
  const rng = new Random(g(e, "seed", Math.trunc(Math.abs(base[0] * 7 + base[1] * 3)) + 1));
  const h = g(e, "height", kind === "poplar" ? 11 : kind === "apricot" ? 4.5 : 7);
  const leaf = g(e, "mat", kind === "poplar" ? "foliage" : "foliage_dark");
  const f = new Frame(ctx, base, rng.uniform(0, 360));
  const tr = kind === "poplar" ? 0.16 : kind === "apricot" ? 0.12 : 0.24;
  const trunkH = kind === "poplar" ? h * 0.9 : h * 0.5;
  f.cyl(0, 0, trunkH / 2, tr, trunkH, "bark", 10, [0, rng.uniform(-3, 3), rng.uniform(-3, 3)]);
  f.col(0, 0, Math.min(trunkH, 3) / 2, [tr * 2, tr * 2, Math.min(trunkH, 3)], "wood");
  if (!ctx.geometry) return;
  if (kind === "poplar") {
    for (let i = 0; i < 7; i++) {
      const zz = h * 0.3 + (h * 0.65 * i) / 6;
      const r = 1.1 * Math.sin(Math.PI * (i + 0.6) / 7.2) + 0.25;
      f.ball(rng.uniform(-0.15, 0.15), rng.uniform(-0.15, 0.15), zz, r, leaf, 5, 9);
    }
  } else {
    // branches and a broad crown of clumps
    for (let k = 0; k < 4; k++) {
      const a = k * 90 + rng.uniform(-20, 20);
      const [bx, by] = rot2d(0, 0.9, a);
      f.cyl(bx * 0.5, by * 0.5, trunkH + 0.5, tr * 0.5, 1.6, "bark", 7, [a, 35, 0]);
    }
    const n = kind === "apricot" ? 6 : 10;
    const R = kind === "apricot" ? 1.6 : 2.8;
    for (let i = 0; i < n; i++) {
      const a = rng.uniform(0, 2 * Math.PI);
      const rr = rng.uniform(0, R * 0.75);
      f.ball(Math.cos(a) * rr, Math.sin(a) * rr, trunkH + rng.uniform(0.6, h - trunkH - 0.6), rng.uniform(R * 0.4, R * 0.62), i % 3 ? leaf : "foliage", 6, 10);
    }
  }
};

/** Small props of village life. kind: charpoy, tandoor, well, cart, firewood, hay, jerrycans, fuel_pump,
 *  sacks, water_jars, bench. */
PREFABS.prop = (ctx, e) => {
  const base: number[] = e.base;
  const hd = g(e, "heading", 0);
  const kind = g(e, "kind", "charpoy");
  const rng = new Random(g(e, "seed", Math.trunc(Math.abs(base[0] * 5 + base[1] * 9)) + 2));
  const f = new Frame(ctx, base, hd);
  if (kind === "charpoy") {
    // rope bed: frame, turned legs, woven top
    for (const sx of [-1, 1]) f.box(sx * 0.42, 0, 0.42, [0.07, 1.95, 0.07], "wood_old");
    for (const sy of [-1, 1]) f.box(0, sy * 0.95, 0.42, [0.9, 0.062, 0.062], "wood_old");     // slimmer: no shared faces with the side rails
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) f.cyl(sx * 0.42, sy * 0.95, 0.22, 0.045, 0.46, "wood_old", 8);
    f.box(0, 0, 0.44, [0.8, 1.85, 0.02], "rope");
    if (rng.random() < 0.5) f.box(0, 0.2, 0.47, [0.75, 1.0, 0.04], rng.choice(["carpet_red", "carpet_blue"]));
    f.col(0, 0, 0.23, [0.9, 2.0, 0.46], "wood");
  } else if (kind === "tandoor") {
    f.cyl(0, 0, 0.42, 0.55, 0.84, "mud_plinth", 18);
    f.cyl(0, 0, 0.85, 0.32, 0.02, "shadow", 14);
    f.cyl(0, 0, 0.88, 0.58, 0.08, "mud_wall", 18, undefined, false);
    f.col(0, 0, 0.45, [1.0, 1.0, 0.9], "plaster", undefined, true);
  } else if (kind === "well") {
    f.cyl(0, 0, 0.4, 0.9, 0.8, "stone_wall", 20, undefined, false);
    f.cyl(0, 0, 0.4, 0.72, 0.8, "stone_wall", 20, undefined, false);
    f.cyl(0, 0, 0.81, 0.82, 0.04, "shadow", 20);
    f.cyl(0, 0, 0.82, 0.91, 0.06, "stone_wall", 20, undefined, false);
    for (const sx of [-1, 1]) f.box(sx * 0.95, 0, 1.2, [0.12, 0.12, 2.4], "wood_old");
    f.cylX(0, 0, 2.2, 0.08, 2.1, "wood_old", 8);
    f.box(0, 0, 1.4, [0.01, 0.01, 1.6], "rope");
    f.cyl(0, 0, 0.62, 0.15, 0.25, "steel", 10);
    f.col(0, 0, 0.45, [1.8, 1.8, 0.9], "concrete", undefined, true);
  } else if (kind === "cart") {
    // two-wheeled hand cart (karachi)
    f.box(0, 0, 0.75, [1.1, 1.8, 0.05], "wood_planks");
    for (const sx of [-1, 1]) f.box(sx * 0.53, 0, 0.88, [0.04, 1.8, 0.22], "wood_old");
    for (const sx of [-1, 1]) f.box(sx * 0.4, -1.5, 0.82, [0.06, 1.4, 0.06], "wood_old", [0, -6, 0]);
    for (const sx of [-1, 1]) {
      f.cylX(sx * 0.62, 0.2, 0.42, 0.42, 0.08, "rubber", 18);
      f.cylX(sx * 0.65, 0.2, 0.42, 0.3, 0.02, "steel", 12);
    }
    f.cylX(0, 0.2, 0.42, 0.03, 1.3, "steel", 6);
    goods(new Frame(ctx, f.p(0, 0, 0.75), hd), rng.choice(["fruit", "sacks", "cans"]), 0.9, 1.4, rng);
    f.col(0, 0, 0.55, [1.3, 1.9, 1.1], "wood");
  } else if (kind === "firewood") {
    const L = g(e, "length", 2.0);
    for (let i = 0; i < 18; i++) f.cylX(rng.uniform(-0.1, 0.1), ((i % 6) - 2.5) * 0.15, 0.08 + Math.floor(i / 6) * 0.14, 0.075, L + rng.uniform(-0.3, 0.3), rng.choice(["wood_old", "bark"]), 7);
    f.col(0, 0, 0.25, [L, 0.95, 0.5], "wood");
  } else if (kind === "hay") {
    f.dome(0, 0, 0, g(e, "radius", 1.4), "hay", g(e, "squash", 1.2), 16);
    const r = g(e, "radius", 1.4);
    f.col(0, 0, r * 0.5, [r * 1.4, r * 1.4, r], "fabric", undefined, true);
  } else if (kind === "jerrycans") {
    const n = Math.trunc(g(e, "count", 4));
    for (let i = 0; i < n; i++) {
      const lx = (i % 4) * 0.2 - 0.3, lz = Math.floor(i / 4) * 0.46;
      f.bev(lx, 0, lz + 0.23, [0.17, 0.36, 0.46], rng.choice(["jingle_green", "jingle_yellow", "jingle_red", "vehicle_od"]), 0.03);
      f.box(lx, -0.08, lz + 0.48, [0.04, 0.12, 0.04], "steel");
    }
    f.col(0, 0, 0.25, [0.8, 0.4, 0.5], "metal");
  } else if (kind === "fuel_pump") {
    f.bev(0, 0, 0.12, [0.9, 0.6, 0.24], "concrete_barrier", 0.03);
    f.bev(0, 0, 1.0, [0.62, 0.42, 1.5], g(e, "mat", "jingle_green"), 0.04);
    f.box(0, -0.215, 1.35, [0.42, 0.01, 0.3], "glass_dark");
    f.box(0, -0.215, 1.05, [0.3, 0.01, 0.1], "headlight");
    for (const sx of [-1, 1]) {
      f.box(sx * 0.33, 0, 0.95, [0.06, 0.12, 0.2], "rubber");
      f.box(sx * 0.4, -0.1, 0.6, [0.03, 0.03, 0.7], "rubber", [0, 0, sx * 12]);
    }
    f.box(0, 0, 1.8, [0.66, 0.46, 0.08], "paint_white");
    f.col(0, 0, 0.9, [0.9, 0.6, 1.8], "metal", undefined, true);
  } else if (kind === "sacks") {
    const n = Math.trunc(g(e, "count", 6));
    for (let i = 0; i < n; i++) {
      const row = i % 3, layer = Math.floor(i / 3);
      f.bev((row - 1) * 0.58 + (layer % 2) * 0.2, rng.uniform(-0.05, 0.05), 0.2 + layer * 0.36, [0.55, 0.85, 0.4], "sack", 0.12, [rng.uniform(-8, 8), 0, 0]);
    }
    const layers = Math.ceil(n / 3);
    f.col(0, 0, layers * 0.18 + 0.02, [1.8, 0.9, layers * 0.36 + 0.04], "fabric", undefined, true);
  } else if (kind === "water_jars") {
    for (let i = 0; i < 3; i++) {
      f.cyl((i - 1) * 0.5, 0, 0.3, 0.2, 0.5, "clay", 12);
      f.ball((i - 1) * 0.5, 0, 0.55, 0.2, "clay", 5, 10);
      f.cyl((i - 1) * 0.5, 0, 0.78, 0.08, 0.12, "clay", 10);
    }
    f.col(0, 0, 0.4, [1.5, 0.45, 0.8], "plaster");
  } else if (kind === "bench") {
    const L = g(e, "length", 2.0);
    f.box(0, 0, 0.45, [L, 0.45, 0.06], "wood_old");
    for (const sx of [-1, 1]) f.box(sx * (L / 2 - 0.1), 0, 0.22, [0.07, 0.4, 0.44], "wood_old");
    f.col(0, 0, 0.24, [L, 0.45, 0.48], "wood");
  } else if (kind === "tires") {
    const n = Math.trunc(g(e, "count", 6));
    for (let k = 0; k < n; k++) f.cyl(rng.uniform(-0.04, 0.04), rng.uniform(-0.04, 0.04), 0.11 + k * 0.21, 0.36, 0.2, "rubber", 18);
    f.cyl(0, 0, n * 0.21 + 0.02, 0.2, 0.02, "shadow", 12);
    f.col(0, 0, n * 0.105, [0.7, 0.7, n * 0.21], "fabric", undefined, true);
  } else if (kind === "drums") {
    const n = Math.trunc(g(e, "count", 4));
    const cols = ["jingle_blue", "jingle_red", "metal_olive", "rust_metal", "jingle_yellow"];
    for (let k = 0; k < n; k++) {
      const lx = (k % 3) * 0.62 - 0.62, ly = Math.floor(k / 3) * 0.62;
      const m = cols[(k + Math.floor(rng.random() * 5)) % cols.length];
      f.cyl(lx, ly, 0.44, 0.29, 0.88, m, 18);
      for (const zz of [0.28, 0.6]) f.cyl(lx, ly, zz, 0.302, 0.035, m, 18, undefined, false);
      f.cyl(lx + 0.15, ly, 0.885, 0.04, 0.02, "steel", 8);
    }
    const rows = Math.ceil(n / 3);
    f.col(0, (rows - 1) * 0.31, 0.44, [1.86, rows * 0.62, 0.88], "metal", undefined, true);
  } else if (kind === "fountain") {
    const r = g(e, "radius", 2.2);
    f.cyl(0, 0, 0.3, r, 0.6, "stone_wall", 28, undefined, false);
    f.cyl(0, 0, 0.62, r + 0.08, 0.06, "concrete_barrier", 28, undefined, false);
    f.cyl(0, 0, 0.45, r - 0.05, 0.02, "water", 28);
    f.cyl(0, 0, 0.75, 0.25, 0.9, "concrete_barrier", 12);
    f.cyl(0, 0, 1.25, 0.7, 0.1, "concrete_barrier", 18);
    f.col(0, 0, 0.33, [r * 1.75, r * 1.75, 0.66], "concrete", undefined, true);
  } else if (kind === "samovar") {
    f.box(0, 0, 0.38, [1.2, 0.6, 0.76], "mud_plinth");
    f.cyl(-0.25, 0, 1.0, 0.2, 0.5, "brass", 14);
    f.dome(-0.25, 0, 1.25, 0.2, "brass", 0.7, 14);
    f.cyl(0.3, 0, 0.88, 0.14, 0.24, "steel", 12);
    for (let i = 0; i < 4; i++) f.cyl(0.1 + i * 0.1, 0.18, 0.8, 0.03, 0.07, "cloth_white", 8);
    f.col(0, 0, 0.45, [1.2, 0.6, 0.9], "plaster");
  }
};

/** minar: a roundabout monument - stepped plinth, a tiled column with a balcony and a small dome. */
PREFABS.minar = (ctx, e) => {
  const base: number[] = e.base;
  const f = new Frame(ctx, base, 0);
  const h = g(e, "height", 10);
  f.cyl(0, 0, 0.2, 3.2, 0.4, "concrete_barrier", 32);
  f.cyl(0, 0, 0.55, 2.4, 0.3, "stone_wall", 28);
  f.cyl(0, 0, 1.2, 1.3, 1.0, "stone_wall", 20);
  f.cyl(0, 0, 1.2 + h / 2, 0.75, h - 1.4, "tile_turquoise", 20);
  for (const zz of [2.2, h * 0.45, h * 0.75]) f.cyl(0, 0, zz, 0.82, 0.18, "mud_brick", 20);
  f.cyl(0, 0, h + 0.05, 1.15, 0.2, "mud_brick", 20);
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * 2 * Math.PI;
    f.box(Math.cos(a) * 1.05, Math.sin(a) * 1.05, h + 0.45, [0.08, 0.08, 0.6], "mud_brick");
  }
  f.cyl(0, 0, h + 0.8, 1.1, 0.1, "mud_brick", 20);
  f.cyl(0, 0, h + 1.3, 0.55, 1.0, "tile_turquoise", 16);
  f.dome(0, 0, h + 1.8, 0.62, "tile_turquoise", 1.1, 16);
  f.cyl(0, 0, h + 2.6, 0.04, 0.6, "brass", 6);
  f.col(0, 0, 0.35, [5.2, 5.2, 0.7], "concrete", undefined, true);
  f.col(0, 0, 1.0 + h / 2, [1.6, 1.6, h + 2], "concrete", undefined, true);
};

// ================================================================ vehicles
const vehicleBase = PREFABS.vehicle;

function glass(e: Piece): string { return g(e, "wreck", false) ? "shadow" : "glass_dark"; }

/** Toyota Hilux style pickup (and the "technical" with a roll bar and a mounted heavy machine gun). */
function hilux(ctx: LevelContext, e: Piece, technical: boolean): void {
  const f = new Frame(ctx, e.base, g(e, "heading", 0));
  const wreck = g(e, "wreck", false);
  const paint = wreck ? "burnt_metal" : g(e, "mat", "vehicle_white");
  const trim = wreck ? "burnt_metal" : "rubber";
  const chrome = wreck ? "burnt_metal" : "pbr_chrome";
  const gl = glass(e);
  const rng = new Random(g(e, "seed", 3));
  if (ctx.geometry) {
    // chassis, drivetrain
    for (const sx of [-1, 1]) f.box(sx * 0.42, 0, 0.5, [0.1, 4.9, 0.16], "steel");
    f.cylY(0, -0.6, 0.38, 0.06, 2.6, "steel", 8);
    f.cylX(0, -1.45, 0.38, 0.07, 1.4, "steel", 8);
    f.cylX(0, 1.55, 0.38, 0.06, 1.3, "steel", 8);
    // lower body, cut around the wheel arches
    const body: Array<[number, number, number, number]> = [
      [1.95, 2.72, 0.55, 1.05], [1.1, 1.95, 0.82, 1.05], [-1.0, 1.1, 0.5, 1.05], [-1.9, -1.0, 0.82, 1.05], [-2.68, -1.9, 0.55, 1.05],
    ];
    for (const [ya, yb, za, zb] of body) f.bev(0, (ya + yb) / 2, (za + zb) / 2, [1.82, yb - ya + 0.02, zb - za], paint, 0.05);
    for (const ly of [1.55, -1.45]) {
      f.box(0, ly, 0.66, [1.5, 0.92, 0.3], "shadow");                 // wheel wells
      for (const sx of [-1, 1]) f.bev(sx * 0.9, ly, 0.83, [0.08, 0.98, 0.07], trim, 0.02);   // arch lips
    }
    // hood, sloping a little toward the grille
    f.bev(0, 1.88, 1.09, [1.78, 1.6, 0.12], paint, 0.05, [0, -3, 0]);
    f.box(0, 1.9, 1.16, [0.5, 1.1, 0.02], paint);                        // power bulge
    // grille, lights, bumper, number plate
    f.box(0, 2.71, 0.88, [1.2, 0.04, 0.3], "shadow");
    for (let k = 0; k < 4; k++) f.box(0, 2.735, 0.77 + k * 0.075, [1.18, 0.02, 0.02], chrome);
    f.bev(0, 2.74, 0.9, [0.28, 0.03, 0.12], chrome, 0.01);
    for (const sx of [-1, 1]) {
      f.bev(sx * 0.72, 2.71, 0.93, [0.32, 0.05, 0.15], wreck ? "shadow" : "headlight", 0.02);
      f.box(sx * 0.82, 2.7, 0.8, [0.12, 0.05, 0.06], wreck ? "shadow" : "fruit_orange");
    }
    f.bev(0, 2.8, 0.6, [1.9, 0.18, 0.2], technical ? "steel" : chrome, 0.05);
    f.box(0, 2.9, 0.62, [0.5, 0.01, 0.12], "paint_white");
    if (technical || g(e, "bullbar", false)) {
      for (const sx of [-1, 1]) f.box(sx * 0.55, 2.95, 0.85, [0.06, 0.06, 0.6], "steel");
      f.box(0, 2.95, 1.12, [1.2, 0.06, 0.06], "steel");
      f.box(0, 2.95, 0.85, [1.2, 0.05, 0.05], "steel");
    }
    // cab: roof, pillars, glass
    f.bev(0, 0.42, 1.8, [1.62, 1.1, 0.08], paint, 0.04);
    f.box(0, 1.0, 1.43, [1.55, 0.03, 0.78], gl, [0, 32, 0]);
    for (const sx of [-1, 1]) {
      f.box(sx * 0.79, 1.0, 1.43, [0.07, 0.07, 0.8], paint, [0, 32, 0]);
      f.box(sx * 0.8, -0.12, 1.43, [0.07, 0.14, 0.74], paint);
      f.box(sx * 0.805, 0.4, 1.43, [0.02, 0.88, 0.62], gl);
      f.box(sx * 0.805, 0.4, 1.1, [0.025, 1.0, 0.04], trim);          // window seal line
      // doors: seams, handles; mirrors
      f.box(sx * 0.915, 0.42, 0.78, [0.01, 0.02, 0.5], "shadow");
      f.box(sx * 0.915, -0.15, 0.78, [0.01, 0.02, 0.5], "shadow");
      f.box(sx * 0.92, -0.05, 0.95, [0.02, 0.14, 0.04], chrome);
      f.box(sx * 1.0, 0.95, 1.22, [0.2, 0.05, 0.03], trim);
      f.bev(sx * 1.08, 0.95, 1.22, [0.05, 0.12, 0.17], trim, 0.015);
      // side step and mud flap
      f.box(sx * 0.95, -0.05, 0.42, [0.14, 1.9, 0.04], "steel");
      f.box(sx * 0.82, -2.0, 0.55, [0.2, 0.02, 0.32], "rubber");
    }
    f.box(0, -0.14, 1.43, [1.5, 0.03, 0.48], gl);
    // bed
    f.box(0, -1.42, 1.0, [1.66, 2.42, 0.04], wreck ? "burnt_metal" : "steel_painted");
    for (const sx of [-1, 1]) {
      f.bev(sx * 0.87, -1.42, 1.27, [0.07, 2.46, 0.46], paint, 0.02);
      f.box(sx * 0.87, -1.42, 1.51, [0.1, 2.46, 0.04], wreck ? "burnt_metal" : "rubber");
      f.box(sx * 0.9, -2.66, 1.2, [0.07, 0.04, 0.3], wreck ? "shadow" : "paint_red");
    }
    f.bev(0, -0.22, 1.27, [1.8, 0.07, 0.46], paint, 0.02);
    if (g(e, "tailgate_down", false)) f.box(0, -2.85, 0.98, [1.72, 0.42, 0.05], paint);
    else {
      f.bev(0, -2.64, 1.27, [1.8, 0.07, 0.46], paint, 0.02);
      f.box(0, -2.68, 1.4, [0.4, 0.01, 0.06], chrome);
    }
    f.bev(0, -2.75, 0.6, [1.86, 0.16, 0.16], "steel", 0.03);
    f.box(0, -2.84, 0.73, [0.45, 0.01, 0.12], "paint_white");
    // cargo
    const cargo = g(e, "cargo", technical ? "none" : rng.choice(["sacks", "cans", "none", "tire"]));
    if (cargo === "sacks") for (let i = 0; i < 5; i++) f.bev((i % 2 - 0.5) * 0.7, -0.8 - Math.floor(i / 2) * 0.7, 1.22 + (i === 4 ? 0.3 : 0), [0.6, 0.55, 0.38], "sack", 0.1, [rng.uniform(-10, 10), 0, 0]);
    if (cargo === "cans") for (let i = 0; i < 6; i++) f.bev(-0.6 + i * 0.24, -2.3, 1.25, [0.17, 0.36, 0.46], rng.choice(["jingle_green", "jingle_yellow", "jingle_red"]), 0.03);
    if (cargo === "tire" || technical) f.cyl(0.35, -1.0, 1.12, 0.38, 0.22, "rubber", 18);
    if (technical) {
      // roll bar
      for (const sx of [-1, 1]) f.box(sx * 0.75, -0.42, 1.65, [0.07, 0.07, 1.25], "steel");
      f.box(0, -0.42, 2.27, [1.57, 0.07, 0.07], "steel");
      for (const sx of [-1, 1]) f.box(sx * 0.75, -0.75, 1.75, [0.05, 0.75, 0.05], "steel", [0, 40, 0]);
      // pedestal-mounted heavy machine gun with a shield
      f.cyl(0, -1.4, 1.5, 0.07, 1.0, "steel", 10);
      f.cyl(0, -1.4, 1.03, 0.25, 0.05, "steel", 12);
      const gt = new Frame(ctx, f.p(0, -1.4, 2.05), g(e, "heading", 0) + g(e, "gun_heading", 15));
      gt.bev(0, 0.1, 0, [0.22, 0.75, 0.2], "gun_metal", 0.02);
      gt.cylY(0, 1.1, 0.02, 0.035, 1.5, "gun_metal", 8);
      gt.cylY(0, 0.75, 0.02, 0.06, 0.45, "gun_metal", 10);
      gt.cylY(0, 1.86, 0.02, 0.05, 0.12, "gun_metal", 8);
      gt.box(0, -0.4, -0.05, [0.06, 0.4, 0.06], "gun_metal");
      gt.bev(0.22, 0.1, -0.05, [0.2, 0.32, 0.22], "metal_olive", 0.02);
      gt.box(0, 0.45, 0.25, [0.7, 0.03, 0.45], "steel_painted", [0, 0, 0]);
    }
    // wheels
    if (!wreck) {
      for (const ly of [1.55, -1.45]) for (const sx of [-1, 1]) f.wheel(sx * 0.78, ly, 0.38, 0.26, g(e, "rim_mat", "steel"));
    } else {
      for (const [ly, sx] of [[1.55, 1], [-1.45, -1]] as Array<[number, number]>) f.wheel(sx * 0.78, ly, 0.38, 0.26, "burnt_metal", "burnt_metal");
      for (const [ly, sx] of [[1.55, -1], [-1.45, 1]] as Array<[number, number]>) f.cylX(sx * 0.78, ly, 0.24, 0.24, 0.12, "burnt_metal", 12);
    }
  }
  f.col(0, 0.05, 0.62, [1.86, 5.5, 0.92], "metal", undefined, true);
  f.col(0, 0.42, 1.45, [1.66, 1.25, 0.74], "metal", undefined, true);
  f.col(0, -1.42, 1.28, [1.84, 2.5, 0.52], "metal");
}

/** Corolla style sedan; Kabul taxis are yellow with a white top. */
function sedan(ctx: LevelContext, e: Piece): void {
  const f = new Frame(ctx, e.base, g(e, "heading", 0));
  const wreck = g(e, "wreck", false);
  const paint = wreck ? "burnt_metal" : g(e, "mat", "vehicle_yellow");
  const top = wreck ? "burnt_metal" : g(e, "mat2", "vehicle_white");
  const gl = glass(e);
  const chrome = wreck ? "burnt_metal" : "pbr_chrome";
  if (ctx.geometry) {
    const body: Array<[number, number, number, number]> = [
      [1.65, 2.22, 0.36, 0.84], [0.9, 1.65, 0.62, 0.84], [-0.85, 0.9, 0.3, 0.84], [-1.6, -0.85, 0.62, 0.84], [-2.18, -1.6, 0.36, 0.84],
    ];
    for (const [ya, yb, za, zb] of body) f.bev(0, (ya + yb) / 2, (za + zb) / 2, [1.7, yb - ya + 0.02, zb - za], paint, 0.06);
    for (const ly of [1.28, -1.22]) {
      f.box(0, ly, 0.48, [1.4, 0.78, 0.28], "shadow");
      for (const sx of [-1, 1]) f.bev(sx * 0.84, ly, 0.63, [0.07, 0.8, 0.06], "rubber", 0.02);
    }
    // hood and trunk lids
    f.bev(0, 1.55, 0.86, [1.66, 1.3, 0.06], paint, 0.03, [0, -4, 0]);
    f.bev(0, -1.75, 0.88, [1.64, 0.9, 0.06], paint, 0.03);
    // greenhouse: roof, windscreen, rear window, pillars, side glass
    f.bev(0, -0.15, 1.38, [1.4, 1.35, 0.06], top, 0.04);
    f.box(0, 0.8, 1.12, [1.42, 0.03, 0.62], gl, [0, 55, 0]);
    f.box(0, -1.07, 1.12, [1.42, 0.03, 0.6], gl, [0, -55, 0]);
    for (const sx of [-1, 1]) {
      f.box(sx * 0.73, 0.8, 1.12, [0.06, 0.06, 0.64], top, [0, 55, 0]);
      f.box(sx * 0.73, -1.07, 1.12, [0.06, 0.06, 0.62], top, [0, -55, 0]);
      f.box(sx * 0.735, -0.15, 1.12, [0.02, 1.25, 0.42], gl);
      f.box(sx * 0.74, -0.15, 1.12, [0.03, 0.08, 0.46], top);
      f.box(sx * 0.86, 0.1, 0.6, [0.01, 0.02, 0.42], "shadow");
      f.box(sx * 0.86, -0.75, 0.6, [0.01, 0.02, 0.42], "shadow");
      f.box(sx * 0.87, -0.1, 0.74, [0.02, 0.12, 0.03], chrome);
      f.box(sx * 0.87, -0.6, 0.74, [0.02, 0.12, 0.03], chrome);
      f.bev(sx * 0.92, 0.65, 0.98, [0.05, 0.1, 0.12], top, 0.015);
      f.box(sx * 0.6, 2.2, 0.68, [0.36, 0.05, 0.12], wreck ? "shadow" : "headlight");
      f.box(sx * 0.62, -2.17, 0.72, [0.34, 0.05, 0.14], wreck ? "shadow" : "paint_red");
      f.box(sx * 0.865, -0.2, 0.52, [0.01, 3.3, 0.05], "rubber");
    }
    f.box(0, 2.21, 0.58, [0.8, 0.04, 0.14], "shadow");
    f.bev(0, 2.24, 0.42, [1.72, 0.12, 0.16], paint, 0.04);
    f.bev(0, -2.21, 0.42, [1.72, 0.12, 0.16], paint, 0.04);
    f.box(0, 2.31, 0.44, [0.48, 0.01, 0.11], "paint_white");
    f.box(0, -2.28, 0.6, [0.48, 0.01, 0.11], "paint_white");
    if (g(e, "taxi", true) && !wreck) f.bev(0, -0.15, 1.47, [0.5, 0.18, 0.12], "jingle_yellow", 0.02);
    if (g(e, "roof_load", false)) {
      for (const sx of [-1, 1]) f.box(sx * 0.6, -0.15, 1.44, [0.04, 1.2, 0.04], "steel");
      f.bev(0, -0.15, 1.6, [1.2, 1.0, 0.3], "tarp_blue", 0.1);
    }
    if (!wreck) for (const ly of [1.28, -1.22]) for (const sx of [-1, 1]) f.wheel(sx * 0.74, ly, 0.31, 0.2, "steel");
    else for (const ly of [1.28, -1.22]) for (const sx of [-1, 1]) f.cylX(sx * 0.74, ly, 0.2, 0.2, 0.12, "burnt_metal", 12);
  }
  f.col(0, 0, 0.48, [1.74, 4.5, 0.8], "metal", undefined, true);
  f.col(0, -0.15, 1.1, [1.4, 1.8, 0.56], "metal", undefined, true);
}

/** Painted "jingle" truck (a Bedford with its tall decorated body, crown over the cab and chains of bells). */
function jingle(ctx: LevelContext, e: Piece): void {
  const hd = g(e, "heading", 0);
  const f = new Frame(ctx, e.base, hd);
  const rng = new Random(g(e, "seed", 7));
  const pal = ["jingle_red", "jingle_yellow", "jingle_green", "jingle_blue", "cloth_white", "fruit_orange"];
  const main = g(e, "mat", rng.choice(["jingle_red", "jingle_blue", "jingle_green"]));
  const chrome = "pbr_chrome";
  if (ctx.geometry) {
    for (const sx of [-1, 1]) f.box(sx * 0.48, -0.3, 0.75, [0.14, 7.8, 0.24], "steel");
    // bonnet, wings, grille (the classic Bedford snout)
    f.bev(0, 3.05, 1.45, [1.25, 1.5, 0.95], main, 0.12);
    f.bev(0, 3.82, 1.35, [1.1, 0.08, 0.85], chrome, 0.02);
    for (let k = 0; k < 7; k++) f.box(-0.45 + k * 0.15, 3.86, 1.35, [0.03, 0.02, 0.75], "shadow");
    for (const sx of [-1, 1]) {
      f.bev(sx * 0.98, 3.05, 1.18, [0.62, 1.55, 0.3], main, 0.12, [0, -6, 0]);
      f.cylY(sx * 0.95, 3.82, 1.42, 0.13, 0.12, chrome, 14);
      f.cylY(sx * 0.95, 3.89, 1.42, 0.1, 0.02, "headlight", 14);
      f.box(sx * 0.98, 3.1, 0.98, [0.55, 1.3, 0.04], "shadow");
    }
    f.bev(0, 3.98, 0.72, [2.3, 0.22, 0.26], chrome, 0.05);
    // cab
    f.bev(0, 1.6, 1.95, [2.3, 1.55, 1.5], main, 0.1);
    f.box(0.52, 2.39, 2.35, [0.9, 0.03, 0.6], "glass_dark", [-6, 12, 0]);
    f.box(-0.52, 2.39, 2.35, [0.9, 0.03, 0.6], "glass_dark", [6, 12, 0]);
    for (const sx of [-1, 1]) {
      f.box(sx * 1.16, 1.75, 2.35, [0.02, 0.8, 0.5], "glass_dark");
      // painted door panels
      for (let k = 0; k < 3; k++) f.box(sx * 1.16, 1.75, 1.35 + k * 0.22, [0.02, 1.0 - k * 0.15, 0.14], pal[(k + (sx > 0 ? 1 : 3)) % pal.length]);
      f.box(sx * 1.4, 2.2, 2.2, [0.5, 0.04, 0.04], "steel");
      f.bev(sx * 1.62, 2.2, 2.2, [0.06, 0.2, 0.36], chrome, 0.02);
      f.box(sx * 1.05, 1.0, 1.0, [0.3, 0.4, 0.06], "steel");
    }
    // the crown (taj) over the cab: a tall painted board leaning forward, studded with mirrors
    f.bev(0, 2.2, 3.15, [2.5, 0.25, 0.9], "wood_planks", 0.05, [0, -14, 0]);
    for (let k = 0; k < 4; k++) f.box(0, 2.38 - k * 0.0, 2.9 + k * 0.18, [2.4 - k * 0.3, 0.06, 0.12], pal[(k + 2) % pal.length], [0, -14, 0]);
    for (let k = 0; k < 7; k++) f.cyl(-1.05 + k * 0.35, 2.38, 3.35, 0.07, 0.02, chrome, 10, [0, 76, 0]);
    f.bev(0, 2.1, 3.7, [0.6, 0.2, 0.3], pal[3], 0.04, [0, -14, 0]);
    // cargo body: wooden box with painted panels outside
    const bodyY = -1.45, bodyL = 4.8, floorZ = 1.25, sideH = 2.1;
    f.box(0, bodyY, floorZ, [2.4, bodyL, 0.12], "wood_planks");
    for (const sx of [-1, 1]) {
      f.box(sx * 1.17, bodyY, floorZ + sideH / 2, [0.08, bodyL, sideH], "wood_planks");
      const cols = 6;
      for (let r = 0; r < 4; r++) for (let c = 0; c < cols; c++) {
        const m = pal[(r * 3 + c * 2 + (sx > 0 ? 1 : 0)) % pal.length];
        f.box(sx * 1.215, bodyY - bodyL / 2 + (c + 0.5) * bodyL / cols, floorZ + 0.3 + r * 0.5, [0.02, bodyL / cols - 0.1, 0.4], m);
      }
      // border strips and the chrome rub rail
      f.box(sx * 1.225, bodyY, floorZ + sideH - 0.04, [0.03, bodyL + 0.05, 0.08], chrome);
      f.box(sx * 1.225, bodyY, floorZ + 0.04, [0.03, bodyL + 0.05, 0.08], chrome);
    }
    f.box(0, bodyY + bodyL / 2, floorZ + sideH / 2, [2.4, 0.08, sideH], "wood_planks");
    // tailgate with its painted landscape (sky, mountains, a lake)
    f.box(0, bodyY - bodyL / 2, floorZ + sideH / 2, [2.4, 0.08, sideH], "wood_planks");
    const ty = bodyY - bodyL / 2 - 0.045;
    f.box(0, ty, floorZ + 1.6, [2.2, 0.02, 0.7], "jingle_blue");
    f.box(0, ty - 0.003, floorZ + 1.1, [2.2, 0.02, 0.35], "jingle_green");
    f.box(0, ty - 0.004, floorZ + 0.6, [2.2, 0.02, 0.6], "tarp_blue");
    f.box(-0.4, ty - 0.006, floorZ + 1.35, [0.7, 0.02, 0.3], "cloth_white", [0, 0, 18]);
    f.box(0.5, ty - 0.006, floorZ + 1.35, [0.8, 0.02, 0.3], "cloth_white", [0, 0, -14]);
    // load under a tarp
    const load = g(e, "load", rng.choice(["sacks", "tarp", "empty"]));
    if (load !== "empty") {
      f.bev(0, bodyY, floorZ + sideH + 0.25, [2.3, bodyL - 0.2, 0.8], load === "tarp" ? "tarp_blue" : "sack", 0.3);
      if (load === "tarp") for (let k = 0; k < 5; k++) f.box(0, bodyY - bodyL / 2 + 0.5 + k * (bodyL - 1) / 4, floorZ + sideH + 0.62, [2.35, 0.02, 0.02], "rope");
    }
    // chains of little bells along the bumper and under the body (the "jingles")
    const chainRow = (lx0: number, lx1: number, ly0: number, ly1: number, zTop: number, n: number) => {
      for (let k = 0; k < n; k++) {
        const s = (k + 0.5) / n;
        const lx = lx0 + (lx1 - lx0) * s, ly = ly0 + (ly1 - ly0) * s;
        const len = 0.18 + 0.1 * ((k % 3) / 2);
        f.box(lx, ly, zTop - len / 2, [0.012, 0.012, len], chrome);
        f.box(lx, ly, zTop - len - 0.02, [0.035, 0.035, 0.04], k % 2 ? chrome : "jingle_red");
      }
    };
    chainRow(-1.1, 1.1, 4.1, 4.1, 0.6, 28);
    chainRow(-1.15, 1.15, bodyY - bodyL / 2 - 0.1, bodyY - bodyL / 2 - 0.1, floorZ - 0.05, 28);
    for (const sx of [-1, 1]) chainRow(sx * 1.22, sx * 1.22, bodyY - bodyL / 2 + 0.3, bodyY + bodyL / 2 - 0.3, floorZ - 0.05, 34);
    // mud flaps and rear lights
    for (const sx of [-1, 1]) {
      f.box(sx * 0.95, -3.55, 0.6, [0.5, 0.02, 0.6], pal[sx > 0 ? 0 : 2]);
      f.box(sx * 1.0, bodyY - bodyL / 2 - 0.1, floorZ - 0.2, [0.25, 0.04, 0.12], "paint_red");
    }
    f.box(0, bodyY - bodyL / 2 - 0.1, floorZ - 0.25, [2.2, 0.12, 0.14], "steel");
    // wheels: single at the front, dual at the back
    for (const sx of [-1, 1]) {
      f.wheel(sx * 0.98, 3.05, 0.5, 0.3, "jingle_red");
      for (const ly of [-1.0, -2.25]) {
        f.wheel(sx * 0.92, ly, 0.5, 0.28, "jingle_red");
        f.cylX(sx * 0.62, ly, 0.5, 0.5, 0.28, "rubber", 20);
      }
    }
  }
  f.col(0, 2.4, 1.3, [2.35, 3.3, 2.6], "metal", undefined, true);
  f.col(0, -1.45, 1.75, [2.45, 4.9, 3.5], "wood", undefined, true);
}

/** Motorbike (a 125 cc Honda copy): frame, tank, seat, bars, wheels. */
function motorbike(ctx: LevelContext, e: Piece): void {
  const f = new Frame(ctx, e.base, g(e, "heading", 0));
  const paint = g(e, "mat", "jingle_red");
  const lean = g(e, "lean", 8);
  const r = [0, 0, lean];
  if (ctx.geometry) {
    for (const ly of [0.65, -0.65]) {
      f.cyl(0, ly, 0.31, 0.31, 0.09, "rubber", 18, [0, 0, 90 + lean]);
      f.cyl(0, ly, 0.31, 0.2, 0.1, "steel", 12, [0, 0, 90 + lean]);
    }
    f.box(0, 0, 0.55, [0.08, 1.2, 0.08], "steel", [0, 10, lean]);
    f.bev(0, 0.25, 0.82, [0.26, 0.45, 0.2], paint, 0.06, r);
    f.bev(0, -0.25, 0.82, [0.24, 0.6, 0.08], "rubber", 0.03, r);
    f.box(0, -0.15, 0.48, [0.22, 0.4, 0.25], "steel", r);
    f.box(0, 0.62, 0.65, [0.05, 0.05, 0.65], "steel", [0, -20, lean]);
    f.box(0, 0.5, 1.0, [0.7, 0.04, 0.04], "steel", r);
    f.bev(0, 0.62, 0.92, [0.16, 0.08, 0.14], "headlight", 0.03, r);
    f.box(0, -0.65, 0.62, [0.18, 0.4, 0.02], paint, r);
    f.box(0.08, -0.5, 0.35, [0.06, 0.7, 0.06], "pbr_chrome", r);
  }
  f.col(0, 0, 0.5, [0.5, 1.9, 1.0], "metal");
}

/** A burnt-out eight-wheeled armoured personnel carrier, sitting on its rims. */
function btr(ctx: LevelContext, e: Piece): void {
  const f = new Frame(ctx, e.base, g(e, "heading", 0));
  const m = g(e, "mat", "rust_metal"), m2 = "burnt_metal";
  const rng = new Random(g(e, "seed", 13));
  const tilt = [0, g(e, "pitch", 1.5), g(e, "roll", 3)];
  if (ctx.geometry) {
    f.bev(0, 0, 1.1, [2.4, 5.6, 0.8], m, 0.06, tilt);
    f.bev(0, 0, 1.75, [2.0, 5.2, 0.55], m, 0.06, tilt);
    for (const sx of [-1, 1]) f.box(sx * 1.25, 0, 1.68, [0.06, 5.4, 0.75], m, [0, tilt[1], tilt[2] + sx * 22]);
    f.box(0, 3.15, 1.25, [2.2, 0.06, 1.2], m, [0, -55 + tilt[1], tilt[2]]);
    f.box(0, 2.85, 1.85, [1.9, 0.06, 0.7], m, [0, 68 + tilt[1], tilt[2]]);
    f.box(0, -3.0, 1.45, [2.2, 0.06, 1.2], m, [0, 40 + tilt[1], tilt[2]]);
    for (const sx of [-1, 1]) {
      f.box(sx * 0.4, 2.72, 2.0, [0.5, 0.04, 0.28], "shadow", [0, 68, 0]);
      f.bev(sx * 0.9, 3.12, 1.55, [0.18, 0.1, 0.18], m2, 0.02);
    }
    // turret with its heavy machine gun (barrel drooping)
    f.cyl(0, 0.9, 2.2, 0.6, 0.4, m2, 18);
    f.dome(0, 0.9, 2.4, 0.6, m2, 0.55, 18);
    f.cylY(0, 2.0, 2.4, 0.06, 2.2, m2, 8);
    f.cylY(0, 1.45, 2.4, 0.12, 0.6, m2, 10);
    // hatches, one hanging open
    f.cyl(-0.5, -1.0, 2.05, 0.35, 0.05, m2, 14);
    f.cyl(0.5, -1.6, 2.35, 0.35, 0.05, m2, 14, [0, 0, 70]);
    // wheels: some gone, the rest burnt down to the rims
    const ys = [2.3, 1.0, -0.9, -2.2];
    for (const sx of [-1, 1]) for (const ly of ys) {
      if (rng.random() < 0.25) { f.cylX(sx * 1.2, ly, 0.35, 0.18, 0.2, "steel", 10); continue; }
      if (rng.random() < 0.5) f.wheel(sx * 1.25, ly, 0.55, 0.36, m2, "burnt_metal");
      else f.cylX(sx * 1.25, ly, 0.4, 0.4, 0.2, m2, 14);
    }
    // soot on the ground
    for (let k = 0; k < 6; k++) f.bev(rng.uniform(-2.5, 2.5), rng.uniform(-3.8, 3.8), 0.06, [rng.uniform(0.2, 0.6), rng.uniform(0.2, 0.5), 0.1], m2, 0.02, [rng.uniform(0, 90), 0, 0]);
  }
  f.col(0, 0, 1.2, [2.7, 6.3, 2.0], "metal", undefined, true);
  f.col(0, 0.9, 2.45, [1.2, 1.2, 0.6], "metal");
}

/** A rusting T-55 wreck: tracks with road wheels, fenders, the hemispherical turret and the long gun. */
function t55(ctx: LevelContext, e: Piece): void {
  const f = new Frame(ctx, e.base, g(e, "heading", 0));
  const m = g(e, "mat", "rust_metal"), m2 = "burnt_metal";
  const rng = new Random(g(e, "seed", 21));
  if (ctx.geometry) {
    // hull
    f.bev(0, 0, 1.15, [2.2, 6.0, 0.7], m, 0.05);
    f.box(0, 3.2, 1.0, [2.1, 0.06, 1.05], m, [0, -58, 0]);
    f.box(0, -3.05, 1.05, [2.1, 0.06, 0.9], m, [0, 15, 0]);
    // fenders with stowage boxes and the long fuel drums at the back
    for (const sx of [-1, 1]) {
      f.box(sx * 1.38, 0, 1.36, [0.6, 6.1, 0.04], m);
      for (const ly of [1.2, 0.0, -1.2]) f.bev(sx * 1.42, ly, 1.55, [0.42, 0.9, 0.34], m2, 0.03);
      f.cylY(sx * 0.6, -3.5, 1.45, 0.29, 0.9, m, 14);
    }
    // tracks: belts, links, road wheels, sprocket and idler
    for (const sx of [-1, 1]) {
      const tx = sx * 1.38;
      f.box(tx, 0, 0.06, [0.58, 5.7, 0.08], "gun_metal");
      f.box(tx, 0, 1.06, [0.58, 5.5, 0.06], "gun_metal");
      for (let k = 0; k < 28; k++) f.box(tx, -2.8 + k * 0.2, 0.11, [0.6, 0.06, 0.04], "gun_metal");
      for (let k = 0; k < 26; k++) f.box(tx, -2.6 + k * 0.2, 1.1, [0.6, 0.06, 0.04], "gun_metal");
      for (let k = 0; k < 5; k++) {
        const ly = 2.15 - k * 1.05;
        f.cylX(tx + sx * 0.05, ly, 0.42, 0.4, 0.5, m, 18);
        f.cylX(tx + sx * 0.31, ly, 0.42, 0.14, 0.03, m2, 10);
      }
      f.cylX(tx, 2.95, 0.55, 0.3, 0.5, m, 14);
      f.cylX(tx, -2.95, 0.6, 0.32, 0.5, m, 14);
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * 2 * Math.PI;
        f.box(tx + sx * 0.27, -2.95 + Math.cos(a) * 0.3, 0.6 + Math.sin(a) * 0.3, [0.04, 0.08, 0.08], m2);
      }
    }
    // the thrown left track lying on the ground beside the hull
    if (g(e, "thrown_track", true)) for (let k = 0; k < 14; k++) f.box(-2.3 - k * 0.02, -1.0 + k * 0.2, 0.04, [0.58, 0.16, 0.06], "gun_metal", [rng.uniform(-6, 6), 0, 0]);
    // turret (the T-55's cast dome), cupola, gun with its fume extractor
    const th = g(e, "turret", 25);
    const tf = new Frame(ctx, f.p(0, 0.65, 1.5), g(e, "heading", 0) + th);
    tf.cyl(0, 0, 0.08, 1.15, 0.16, m, 28);
    tf.dome(0, 0, 0.16, 1.12, m, 0.52, 28);
    tf.cyl(-0.45, -0.25, 0.75, 0.3, 0.2, m2, 14);
    tf.cyl(-0.45, -0.25, 0.87, 0.31, 0.05, m2, 14, [0, 0, 60]);
    tf.cyl(0.45, -0.3, 0.7, 0.24, 0.12, m2, 12);
    tf.bev(0, 1.05, 0.42, [0.62, 0.35, 0.5], m, 0.06);
    const gp = g(e, "gun_pitch", -6);
    tf.cyl(0, 1.25 + 2.6 * Math.cos(gp * D), 0.45 + 2.6 * Math.sin(gp * D), 0.085, 5.0, m2, 12, [0, 90 + gp, 0]);
    tf.cyl(0, 1.25 + 3.4 * Math.cos(gp * D), 0.45 + 3.4 * Math.sin(gp * D), 0.15, 0.5, m2, 12, [0, 90 + gp, 0]);
    tf.cyl(0, 1.25 + 5.05 * Math.cos(gp * D), 0.45 + 5.05 * Math.sin(gp * D), 0.11, 0.12, m2, 12, [0, 90 + gp, 0]);
    tf.box(0.62, -0.4, 0.45, [0.08, 0.5, 0.12], m2);
  }
  f.col(0, 0, 0.78, [3.35, 6.6, 1.55], "metal", undefined, true);
  f.col(0, 0.65, 1.9, [2.2, 2.2, 0.8], "metal", undefined, true);
}

/** Fuel tanker: a forward-control cab and a long tank with walkway, hoses and hazard plates. */
function tanker(ctx: LevelContext, e: Piece): void {
  const f = new Frame(ctx, e.base, g(e, "heading", 0));
  const wreck = g(e, "wreck", false);
  const paint = wreck ? "burnt_metal" : g(e, "mat", "jingle_blue");
  const tankM = wreck ? "rust_metal" : g(e, "tank_mat", "tank_white");
  if (ctx.geometry) {
    for (const sx of [-1, 1]) f.box(sx * 0.5, -0.5, 0.75, [0.14, 8.4, 0.24], "steel");
    f.bev(0, 3.2, 1.75, [2.4, 1.9, 2.1], paint, 0.12);
    f.box(0, 4.16, 2.2, [2.1, 0.03, 0.8], wreck ? "shadow" : "glass_dark", [0, 8, 0]);
    for (const sx of [-1, 1]) {
      f.box(sx * 1.21, 3.3, 2.25, [0.02, 1.0, 0.65], wreck ? "shadow" : "glass_dark");
      f.box(sx * 1.21, 3.3, 1.35, [0.02, 1.4, 0.06], "pbr_chrome");
      f.bev(sx * 1.4, 4.1, 2.3, [0.06, 0.18, 0.38], "pbr_chrome", 0.02);
      f.cyl(sx * 0.85, 4.18, 1.0, 0.13, 0.08, wreck ? "shadow" : "headlight", 12, [0, 90, 0]);
    }
    f.box(0, 4.18, 1.3, [1.4, 0.03, 0.4], "shadow");
    f.bev(0, 4.25, 0.72, [2.4, 0.2, 0.25], "steel", 0.04);
    f.box(0, 4.19, 2.95, [1.8, 0.12, 0.25], "jingle_yellow");
    // the tank
    f.cylY(0, -1.6, 1.95, 1.1, 6.6, tankM, 24);
    for (const ly of [1.75, -4.95]) f.cylY(0, ly, 1.95, 1.0, 0.12, tankM, 24);
    for (const ly of [0.6, -1.6, -3.8]) f.cylY(0, ly, 1.95, 1.13, 0.1, "steel", 24);
    f.box(0, -1.6, 3.12, [0.5, 6.4, 0.04], "diamond_plate");
    for (const ly of [0, -1.6, -3.2]) f.cyl(0, ly, 3.12, 0.25, 0.14, "steel", 12);
    for (const sx of [-1, 1]) f.box(sx * 0.3, -1.6, 3.4, [0.03, 6.4, 0.03], "steel");
    f.box(0, -4.98, 1.9, [0.6, 0.02, 0.4], "hazard");
    f.box(1.12, -1.6, 0.95, [0.3, 1.2, 0.35], "steel_painted");
    f.cylY(1.0, -3.4, 0.95, 0.06, 1.6, "rubber", 8);
    for (const sx of [-1, 1]) f.box(sx * 0.95, -5.0, 0.55, [0.5, 0.02, 0.5], "rubber");
    for (const sx of [-1, 1]) {
      if (!wreck) f.wheel(sx * 1.0, 3.0, 0.52, 0.32);
      else f.cylX(sx * 1.0, 3.0, 0.38, 0.38, 0.2, "burnt_metal", 14);
      for (const ly of [-2.6, -3.9]) {
        if (!wreck) { f.wheel(sx * 0.95, ly, 0.52, 0.3); f.cylX(sx * 0.63, ly, 0.52, 0.52, 0.3, "rubber", 20); }
        else f.cylX(sx * 0.95, ly, 0.36, 0.36, 0.25, "burnt_metal", 14);
      }
    }
  }
  f.col(0, 3.2, 1.45, [2.45, 2.0, 2.6], "metal", undefined, true);
  f.col(0, -1.6, 1.6, [2.3, 6.8, 2.6], "metal", undefined, true);
}

PREFABS.vehicle = (ctx, e) => {
  const kind = g(e, "kind", "truck");
  if (kind === "hilux") hilux(ctx, e, false);
  else if (kind === "technical") hilux(ctx, e, true);
  else if (kind === "sedan" || kind === "taxi") sedan(ctx, e);
  else if (kind === "jingle") jingle(ctx, e);
  else if (kind === "tanker") tanker(ctx, e);
  else if (kind === "motorbike") motorbike(ctx, e);
  else if (kind === "btr") btr(ctx, e);
  else if (kind === "t55") t55(ctx, e);
  else vehicleBase(ctx, e);
};
