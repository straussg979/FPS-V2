// Modular level pieces. Each prefab turns one map JSON
// entry into geometry (per-material batches), collision boxes, occluders for the light bake, and
// gameplay data (spawns, zones, callouts, cameras, lights, props).

import { pyRound } from "../math";
import { Random } from "../rng";
import type { LevelContext, Piece } from "./level";
import { organicWall } from "./organic_wall";

type Prefab = (ctx: LevelContext, e: Piece) => void;
export const PREFABS: Record<string, Prefab> = {};

const D = Math.PI / 180;

function rot2d(x: number, y: number, heading: number): [number, number] {
  const a = heading * D;
  const c = Math.cos(a), s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}

/** Local (x right, y forward, z up) offset -> world point for a heading. */
function local(origin: number[], heading: number, lx: number, ly: number, lz: number): number[] {
  const [wx, wy] = rot2d(lx, ly, heading);
  return [origin[0] + wx, origin[1] + wy, origin[2] + lz];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = (e: Piece, k: string, d: any): any => (e[k] === undefined ? d : e[k]);

// ------------------------------------------------------------------ basics
PREFABS.box = (ctx, e) => {
  const size = e.size;
  let pos: number[];
  if (e.base) pos = [e.base[0], e.base[1], e.base[2] + size[2] / 2];
  else pos = e.pos;
  const hpr = e.hpr ?? [g(e, "heading", 0), 0, 0];
  ctx.box(pos, size, g(e, "mat", "concrete_wall"), { hpr, uv: g(e, "uv", "world"), collide: g(e, "collide", true),
    occlude: g(e, "occlude", true), skipFaces: e.skip_faces ?? [], surface: e.surface });
};

PREFABS.floor = (ctx, e) => {
  const [[x0, y0], [x1, y1]] = [e.min, e.max];
  const t = g(e, "thickness", 0.3);
  const z = g(e, "z", 0.0);
  ctx.box([(x0 + x1) / 2, (y0 + y1) / 2, z - t / 2], [x1 - x0, y1 - y0, t], g(e, "mat", "concrete_floor"),
    { collide: g(e, "collide", true), occlude: g(e, "occlude", true) });
};

/** How a wall's surface is rounded by its collision surface type (null: kept as plain boxes). */
function wallStyle(surface: string): { radius: number; crown: number; taper: number } | null {
  if (surface === "plaster" || surface === "dirt") return { radius: 0.075, crown: 0.025, taper: 0.008 };
  if (surface === "brick") return { radius: 0.05, crown: 0.012, taper: 0.004 };
  if (surface === "concrete") return { radius: 0.025, crown: 0, taper: 0 };
  return null;
}

export function wall(ctx: LevelContext, e0: Piece): void {
  let p0: number[] = e0.p0, p1: number[] = e0.p1;
  const h = g(e0, "height", 3.0);
  const t = g(e0, "thickness", 0.25);
  const z0 = g(e0, "z", 0.0);
  let dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  let length = Math.hypot(dx, dy);
  const heading = Math.atan2(dy, dx) / D;
  let shift = 0;
  if (e0.extend) {
    const ux0 = dx / length, uy0 = dy / length;
    p0 = [p0[0] - ux0 * t / 2, p0[1] - uy0 * t / 2];
    p1 = [p1[0] + ux0 * t / 2, p1[1] + uy0 * t / 2];
    dx = p1[0] - p0[0];
    dy = p1[1] - p0[1];
    length += t;
    shift = t / 2;
  }
  const openings: Piece[] = (e0.openings ?? []).map((op: Piece) => ({ ...op, at: op.at + shift }));
  const e: Piece = { ...e0, openings };
  const mat = g(e, "mat", "concrete_wall");
  const mat2 = g(e, "mat2", mat);
  let rects: Array<[number, number, number, number]> = [[0, length, 0, h]];
  for (const op of openings) {
    const c = op.at, w = op.width;
    const ob = g(op, "bottom", 0.0), ot = g(op, "top", Math.min(2.2, h));
    const s0 = c - w / 2, s1 = c + w / 2;
    const next: Array<[number, number, number, number]> = [];
    for (const [a, b, zb, zt] of rects) {
      if (s1 <= a || s0 >= b || ot <= zb || ob >= zt) { next.push([a, b, zb, zt]); continue; }
      if (s0 > a) next.push([a, s0, zb, zt]);
      if (s1 < b) next.push([s1, b, zb, zt]);
      const loA = Math.max(a, s0), loB = Math.min(b, s1);
      if (ob > zb) next.push([loA, loB, zb, ob]);
      if (ot < zt) next.push([loA, loB, ot, zt]);
    }
    rects = next;
  }
  const ux = dx / length, uy = dy / length;
  const plain = () => { for (const [a, b, zb, zt] of rects) {
    if (b - a < 1e-3 || zt - zb < 1e-3) continue;
    const mid = (a + b) / 2;
    const center = [p0[0] + ux * mid, p0[1] + uy * mid, z0 + (zb + zt) / 2];
    const size = [b - a, t, zt - zb];
    const hpr = [heading, 0, 0];
    if (e.soft) {
      ctx.panel(center, size, mat, mat2, { hpr, reinforce: g(e, "reinforce", false), breach: g(e, "breach", false),
        name: g(e, "name", ""), surface: e.surface });
    } else if (mat2 !== mat) {
      ctx.box(center, size, mat, { hpr, collide: true, occlude: true, skipFaces: ["-y"] });
      ctx.box(center, size, mat2, { hpr, collide: false, occlude: false, skipFaces: ["+x", "-x", "+y", "+z", "-z"] });
    } else {
      ctx.box(center, size, mat, { hpr, collide: true, occlude: true });
    }
  } };
  // the drawn wall: near the camera a rounded, gently uneven shell (organic_wall.ts); further away (and for the
  // server, which builds no geometry) the plain boxes. The colliders are the plain boxes' either way.
  const style = !e.soft && ctx.geometry ? wallStyle(ctx.surface(mat2)) : null;
  if (!style) plain();
  else {
    const [o, hpr] = ctx.xf([p0[0], p0[1], z0], [heading, 0, 0]);
    const mid = ctx.xf([p0[0] + ux * length / 2, p0[1] + uy * length / 2, z0])[0];
    ctx.withVariant("lo", mid, plain);
    const solid = rects.filter(([a, b, zb, zt]) => b - a >= 1e-3 && zt - zb >= 1e-3);
    if (solid.length) ctx.withVariant("hi", mid, () => organicWall({ origin: o, heading: hpr[0], length, thickness: t, rects: solid,
      mat: ctx.builder(mat), mat2: ctx.builder(mat2), uvScale: ctx.uvScale(mat), uvScale2: ctx.uvScale(mat2),
      exposed: { top: g(e0, "top_exposed", !e0.roofed), start: !!(e0.ends ?? [])[0], end: !!(e0.ends ?? [])[1] },
      radius: style.radius, step: 0.6, displace: ctx.organic(mat2), crown: style.crown, taper: style.taper }));
  }
  const frame = e.frame_mat;
  if (frame) {
    for (const op of openings) {
      const c = op.at, w = op.width;
      const ob = g(op, "bottom", 0.0), ot = g(op, "top", Math.min(2.2, h));
      for (const side of [-1, 1]) {
        const s = c + side * (w / 2 - 0.04);
        // hand-made frames are never quite plumb
        const lean = (((Math.abs(Math.floor(s * 97 + z0 * 13 + p0[0] * 7)) % 11) - 5) / 5) * 0.4;
        ctx.box([p0[0] + ux * s, p0[1] + uy * s, z0 + (ob + ot) / 2], [0.08, t + 0.04, ot - ob], frame,
          { hpr: [heading, 0, lean], collide: false, occlude: false });
      }
      const cx = p0[0] + ux * c, cy = p0[1] + uy * c;
      // the head piece fits between the two jambs (it used to overlap them, so their faces z-fought at the corners)
      ctx.box([cx, cy, z0 + ot - 0.04], [Math.max(w - 0.16, 0.01), t + 0.04, 0.08], frame, { hpr: [heading, 0, 0], collide: false, occlude: false });
      if (ob > 0.05) {
        // a worn sill: rounded near the camera
        ctx.rbox([cx, cy, z0 + ob + 0.03], [w + 0.1, t + 0.12, 0.06], frame, { hpr: [heading, 0, 0], collide: false, occlude: false,
          round: ["+z", "+y", "-y", "+x", "-x"], radius: 0.02, step: 0, displace: false });
      }
    }
  }
}
PREFABS.wall = wall;

PREFABS.stairs = (ctx, e) => {
  const base = e.base;
  const heading = g(e, "heading", 0.0);
  const steps = Math.trunc(e.steps);
  const rise = e.rise / steps;
  const run = g(e, "run", 0.28);
  const width = g(e, "width", 1.4);
  const mat = g(e, "mat", "concrete_floor");
  const solid = g(e, "solid", true);
  for (let i = 0; i < steps; i++) {
    const top = rise * (i + 1);
    const [hgt, zc] = solid ? [top, top / 2] : [0.12, top - 0.06];
    ctx.box(local(base, heading, 0, run * (i + 0.5), zc), [width, run, hgt], mat, { hpr: [heading, 0, 0], collide: true, occlude: true });
  }
  if (e.rails) {
    const railMat = g(e, "rail_mat", "steel");
    const total = run * steps;
    for (const side of [-1, 1]) {
      for (let k = 0; k <= steps; k += Math.max(Math.floor(steps / 3), 1)) {
        ctx.box(local(base, heading, side * (width / 2 - 0.03), run * k, rise * k + 0.5), [0.05, 0.05, 1.0], railMat,
          { hpr: [heading, 0, 0], collide: false, occlude: false });
      }
      const ang = Math.atan2(rise * steps, total) / D;
      ctx.box(local(base, heading, side * (width / 2 - 0.03), total / 2, rise * steps / 2 + 1.0),
        [0.06, Math.hypot(total, rise * steps), 0.06], railMat, { hpr: [heading, ang, 0], collide: false, occlude: false });
    }
  }
};

PREFABS.ramp = (ctx, e) => {
  const base = e.base;
  const heading = g(e, "heading", 0.0);
  const length = e.length, height = e.height, width = g(e, "width", 2.0);
  const t = 0.3;
  const a = Math.atan2(height, length);
  const mat = g(e, "mat", "concrete_floor");
  ctx.wedge(base, width, length, height, heading, mat);
  const center = local(base, heading, 0, length / 2 + Math.sin(a) * t / 2, height / 2 - Math.cos(a) * t / 2);
  ctx.collider(center, [width, Math.hypot(length, height), t], [heading, a / D, 0], ctx.surface(mat));
  const steps = 8;
  for (let i = 1; i < steps; i++) {
    const y0 = length * i / steps;
    const hh = height * i / steps - t / Math.cos(a) - 0.02;
    if (hh <= 0.05) continue;
    ctx.collider(local(base, heading, 0, y0 + length / steps / 2, hh / 2), [width, length / steps, hh], [heading, 0, 0], ctx.surface(mat));
  }
  ctx.occluder(local(base, heading, 0, length * 0.6, height * 0.3), [width, length * 0.6, height * 0.6], [heading, 0, 0]);
};

// ------------------------------------------------------------------- props
function crate(ctx: LevelContext, e: Piece): void {
  const base = e.base;
  const s = g(e, "size", 1.0);
  const size = e.dims ?? [s, s, s];
  const heading = g(e, "heading", 0.0);
  const mat = g(e, "mat", "plywood");
  const frame = g(e, "frame_mat", "wood_planks");
  const c = [base[0], base[1], base[2] + size[2] / 2];
  ctx.box(c, size, mat, { hpr: [heading, 0, 0], uv: "fit", collide: true, occlude: true });
  if (!ctx.geometry) return;
  const b = 0.07;
  const hx = size[0] / 2, hy = size[1] / 2, hz = size[2] / 2;
  const nc = { hpr: [heading, 0, 0], collide: false, occlude: false };
  // the three directions of frame bars differ by a few millimetres in section, so where they cross no two faces
  // share a plane (they z-fought at every corner)
  const b2 = b - 0.008, b3 = b - 0.016;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    ctx.box(local(c, heading, sx * (hx - b / 2 + 0.01), sy * (hy - b / 2 + 0.01), 0), [b, b, size[2] + 0.02], frame, nc);
  }
  for (const sz of [-1, 1]) {
    for (const sy of [-1, 1]) ctx.box(local(c, heading, 0, sy * (hy - b / 2 + 0.01), sz * (hz - b / 2 + 0.01)), [size[0] - 0.004, b2, b2], frame, nc);
    for (const sx of [-1, 1]) ctx.box(local(c, heading, sx * (hx - b / 2 + 0.01), 0, sz * (hz - b / 2 + 0.01)), [b3, size[1] - 0.008, b3], frame, nc);
  }
}
PREFABS.crate = crate;

PREFABS.crate_stack = (ctx, e) => {
  const base = e.base;
  const s = g(e, "size", 1.0);
  const rng = new Random(g(e, "seed", 1));
  for (const [ix, iy, iz] of e.layout ?? [[0, 0, 0], [1, 0, 0], [0, 0, 1]]) {
    const jitter = rng.uniform(-4, 4);
    crate(ctx, { base: [base[0] + ix * (s + 0.04), base[1] + iy * (s + 0.04), base[2] + iz * s], size: s,
      heading: g(e, "heading", 0) + jitter, mat: g(e, "mat", "plywood"), frame_mat: g(e, "frame_mat", "wood_planks") });
  }
};

PREFABS.container = (ctx, e) => {
  const base = e.base;
  const hd = g(e, "heading", 0.0);
  const L = g(e, "length", 6.06);
  const W = 2.44, H = 2.59;
  const t = 0.08;
  const mat = g(e, "mat", "container_red");
  const steel = g(e, "frame_mat", "metal_olive");
  const part = (lx: number, ly: number, lz: number, size: number[], m: string, collide = true, uv = "world") =>
    ctx.box(local(base, hd, lx, ly, lz), size, m, { hpr: [hd, 0, 0], collide, occlude: true, uv });
  part(-W / 2 + t / 2, 0, H / 2, [t, L, H], mat);
  part(W / 2 - t / 2, 0, H / 2, [t, L, H], mat);
  part(0, 0, H - t / 2, [W, L, t], mat);
  part(0, 0, 0.1, [W, L, 0.2], g(e, "floor_mat", "wood_planks"));
  part(0, -L / 2 + t / 2, H / 2, [W, t, H], mat);
  if (!g(e, "open", false)) part(0, L / 2 - t / 2, H / 2, [W, t, H], mat);
  else {
    for (const side of [-1, 1]) {
      ctx.box(local(base, hd, side * (W / 2 + 0.06), L / 2 + W / 4, H / 2), [0.06, W / 2, H - 0.1], mat,
        { hpr: [hd, 0, 0], collide: true, occlude: true });
    }
  }
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) part(sx * (W / 2 - 0.08), sy * (L / 2 - 0.08), H / 2, [0.17, 0.17, H + 0.01], steel, false);
    part(sx * (W / 2 - 0.05), 0, H - 0.08, [0.12, L, 0.16], steel, false);
    part(sx * (W / 2 - 0.05), 0, 0.08, [0.12, L, 0.16], steel, false);
  }
};

PREFABS.sandbags = (ctx, e) => {
  const p0 = e.p0, p1 = e.p1;
  const layers = Math.trunc(g(e, "layers", 5));
  const z0 = g(e, "z", 0.0);
  const rng = new Random(g(e, "seed", 3));
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  const length = Math.hypot(dx, dy);
  const heading = Math.atan2(dy, dx) / D;
  const bagL = 0.58, bagW = 0.34, bagH = 0.15;
  const depth = g(e, "depth", 2);
  if (ctx.geometry) {
    for (let layer = 0; layer < layers; layer++) {
      const n = Math.max(Math.trunc(length / bagL), 1);
      const off = (layer % 2) * bagL / 2;
      const dcount = layer < layers - 1 ? depth : Math.max(depth - 1, 1);
      for (let d = 0; d < dcount; d++) {
        for (let i = 0; i < n; i++) {
          const s = off + bagL * (i + 0.5);
          if (s > length - bagL * 0.25) continue;
          const lat = (d - (depth - 1) / 2) * bagW;
          const cx = p0[0] + dx / length * s - dy / length * lat;
          const cy = p0[1] + dy / length * s + dx / length * lat;
          const cz = z0 + layer * bagH * 0.92 + bagH / 2;
          const jh = heading + rng.uniform(-5, 5);
          const sz = [bagL * rng.uniform(0.94, 1.02), bagW * rng.uniform(0.92, 1.0), bagH * rng.uniform(0.9, 1.05)];
          ctx.box([cx, cy, cz], sz, g(e, "mat", "sandbag"), { hpr: [jh, rng.uniform(-3, 3), rng.uniform(-3, 3)],
            collide: false, occlude: false });
        }
      }
    }
  }
  const totalH = layers * bagH * 0.92 + bagH * 0.08;
  const mid = [p0[0] + dx / 2, p0[1] + dy / 2, z0 + totalH / 2];
  ctx.collider(mid, [length, bagW * depth, totalH], [heading, 0, 0], "fabric");
  ctx.occluder(mid, [length, bagW * depth, totalH], [heading, 0, 0]);
};

PREFABS.barrel = (ctx, e) => {
  const base = e.base;
  const r = 0.29, h = 0.88;
  const mat = g(e, "mat", "metal_olive");
  const c = [base[0], base[1], base[2] + h / 2];
  ctx.cylinder(c, r, h, mat, 20);
  for (const z of [0.28, 0.6]) ctx.cylinder([base[0], base[1], base[2] + z], r + 0.012, 0.035, mat, 20, false);
  ctx.collider(c, [r * 2, r * 2, h], [0, 0, 0], "metal");
};

PREFABS.pillar = (ctx, e) => {
  const base = e.base;
  const h = g(e, "height", 3.0);
  if (e.round) {
    const r = g(e, "radius", 0.25);
    const c = [base[0], base[1], base[2] + h / 2];
    ctx.cylinder(c, r, h, g(e, "mat", "concrete_wall"), 24);
    ctx.collider(c, [r * 2, r * 2, h], [0, 0, 0], "concrete");
    ctx.occluder(c, [r * 2, r * 2, h]);
  } else {
    const s = g(e, "size", 0.4);
    ctx.box([base[0], base[1], base[2] + h / 2], [s, s, h], g(e, "mat", "concrete_wall"));
  }
};

function railing(ctx: LevelContext, e: Piece): void {
  const p0 = e.p0, p1 = e.p1;
  const z = g(e, "z", 0.0);
  const h = g(e, "height", 1.05);
  const mat = g(e, "mat", "steel");
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  const length = Math.hypot(dx, dy);
  const heading = Math.atan2(dy, dx) / D;
  const n = Math.max(Math.trunc(length / 1.5), 1);
  const nc = { hpr: [heading, 0, 0], collide: false, occlude: false };
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    ctx.box([p0[0] + dx * s, p0[1] + dy * s, z + h / 2], [0.05, 0.05, h], mat, nc);
  }
  // rails a little slimmer than the posts, so their faces never share a plane with a post's
  for (const zz of [h, h * 0.5]) ctx.box([p0[0] + dx / 2, p0[1] + dy / 2, z + zz], [length, 0.042, 0.042], mat, nc);
  ctx.collider([p0[0] + dx / 2, p0[1] + dy / 2, z + h / 2], [length, 0.08, h], [heading, 0, 0], "metal");
}
PREFABS.railing = railing;

PREFABS.catwalk = (ctx, e) => {
  const p0 = e.p0, p1 = e.p1;
  const z = e.z;
  const w = g(e, "width", 1.6);
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  const length = Math.hypot(dx, dy);
  const heading = Math.atan2(dy, dx) / D;
  const nx = -dy / length, ny = dx / length;
  ctx.box([p0[0] + dx / 2, p0[1] + dy / 2, z - 0.06], [length, w, 0.12], g(e, "mat", "diamond_plate"), { hpr: [heading, 0, 0] });
  const legMat = g(e, "leg_mat", "steel");
  const n = Math.max(Math.trunc(length / 3.0), 1);
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    for (const side of [-1, 1]) {
      const x = p0[0] + dx * s + nx * side * (w / 2 - 0.08);
      const y = p0[1] + dy * s + ny * side * (w / 2 - 0.08);
      if (g(e, "legs", true)) ctx.box([x, y, z / 2 - 0.06], [0.12, 0.12, z - 0.12], legMat, { collide: true, occlude: false });
    }
  }
  if (g(e, "rails", true)) {
    for (const side of g(e, "rail_sides", [-1, 1])) {
      const q0 = [p0[0] + nx * side * (w / 2 - 0.03), p0[1] + ny * side * (w / 2 - 0.03)];
      const q1 = [p1[0] + nx * side * (w / 2 - 0.03), p1[1] + ny * side * (w / 2 - 0.03)];
      railing(ctx, { p0: q0, p1: q1, z, mat: legMat });
    }
  }
};

PREFABS.pbr_gallery = (ctx, e) => {
  const base = e.base;
  const heading = g(e, "heading", 0.0);
  const mats: string[] = e.mats ?? [];
  const spacing = g(e, "spacing", 1.6);
  mats.forEach((m, i) => {
    const x = (i - (mats.length - 1) / 2) * spacing;
    const p = local(base, heading, x, 0, 0);
    ctx.box([p[0], p[1], p[2] + 0.45], [0.6, 0.6, 0.9], g(e, "pedestal_mat", "concrete_dark"));
    ctx.sphere([p[0], p[1], p[2] + 0.9 + 0.42], 0.42, m);
    ctx.collider([p[0], p[1], p[2] + 1.32], [0.84, 0.84, 0.84]);
  });
};

PREFABS.light = (ctx, e) => ctx.light(e);

PREFABS.spawn = (ctx, e) => {
  const [pos, hpr] = ctx.xf(e.pos, [g(e, "heading", 0.0), 0, 0]);
  ctx.spawns.push({ team: g(e, "team", "attack"), pos, heading: hpr[0] });
};

PREFABS.weapon_display = (ctx, e) => ctx.prop("weapon_model", e);
PREFABS.dummy = (ctx, e) => ctx.prop("dummy", e);
PREFABS.pickup = (ctx, e) => ctx.prop("pickup", e);
PREFABS.sign = (ctx, e) => ctx.prop("sign", e);

PREFABS.group = (ctx, e) => {
  ctx.pushTransform(g(e, "offset", [0, 0, 0]), g(e, "heading", 0.0));
  for (const child of e.pieces ?? []) ctx.buildPiece(child);
  ctx.popTransform();
};

// ================================================================ military
function line(p0: number[], p1: number[]): [number, number, number, number] {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  return [dx, dy, Math.hypot(dx, dy), Math.atan2(dy, dx) / D];
}

function along(p0: number[], dx: number, dy: number, length: number, s: number, lateral = 0): [number, number] {
  const ux = dx / length, uy = dy / length;
  return [p0[0] + ux * s - uy * lateral, p0[1] + uy * s + ux * lateral];
}

function slab(ctx: LevelContext, x0: number, y0: number, x1: number, y1: number, zTop: number, thickness: number,
              topMat: string, bottomMat?: string | null, sideMat?: string | null, collide = true): void {
  const c = [(x0 + x1) / 2, (y0 + y1) / 2, zTop - thickness / 2];
  const size = [x1 - x0, y1 - y0, thickness];
  const bm = bottomMat || topMat;
  const sm = sideMat || topMat;
  if (topMat === bm && bm === sm) {
    ctx.rbox(c, size, topMat, { collide, occlude: true, round: ["+z", "+x", "-x", "+y", "-y"], radius: 0.025, step: 0, displace: false });
    return;
  }
  ctx.box(c, size, topMat, { skipFaces: ["-z", "+x", "-x", "+y", "-y"], collide, occlude: true });
  ctx.box(c, size, bm, { skipFaces: ["+z", "+x", "-x", "+y", "-y"], collide: false, occlude: false });
  ctx.box(c, size, sm, { skipFaces: ["+z", "-z"], collide: false, occlude: false });
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
  return spans.filter(([a, b]) => b - a > 1e-3);
}

function subtractRects(rect: number[], holes: number[][]): number[][] {
  let rects = [rect];
  for (const [hx0, hy0, hx1, hy1] of holes) {
    const out: number[][] = [];
    for (const [x0, y0, x1, y1] of rects) {
      if (hx1 <= x0 || hx0 >= x1 || hy1 <= y0 || hy0 >= y1) { out.push([x0, y0, x1, y1]); continue; }
      if (hy0 > y0) out.push([x0, y0, x1, hy0]);
      if (hy1 < y1) out.push([x0, hy1, x1, y1]);
      const my0 = Math.max(y0, hy0), my1 = Math.min(y1, hy1);
      if (hx0 > x0) out.push([x0, my0, hx0, my1]);
      if (hx1 < x1) out.push([hx1, my0, x1, my1]);
    }
    rects = out;
  }
  return rects.filter((r) => r[2] - r[0] > 1e-3 && r[3] - r[1] > 1e-3);
}

function roofTop(e: Piece): number { return g(e, "roof_thickness", 0.3); }

PREFABS.building = (ctx, e) => {
  const [[x0, y0], [x1, y1]] = [e.min, e.max];
  const z = g(e, "z", 0.0);
  const h = g(e, "height", 3.2);
  const t = g(e, "wall", 0.3);
  const roofT = g(e, "roof_thickness", 0.3);
  const ext = g(e, "mat", "plaster_tan");
  const inn = g(e, "mat_in", "plaster");
  const ops = g(e, "openings", {} as Piece);
  const frame = e.frame_mat ?? null;
  const conv = (side: string, start: number, sign: number) =>
    (ops[side] ?? []).map((op: Piece) => ({ ...op, at: (op[side === "s" || side === "n" ? "x" : "y"] - start) * sign }));
  const openSides: string[] = g(e, "open_sides", []);
  const ys = openSides.includes("s") ? y0 : y0 + t;
  const yn = openSides.includes("n") ? y1 : y1 - t;
  const sides: Array<[string, number[], number[], Piece[]]> = [
    ["s", [x0, y0 + t / 2], [x1, y0 + t / 2], conv("s", x0, 1)],
    ["e", [x1 - t / 2, ys], [x1 - t / 2, yn], conv("e", ys, 1)],
    ["n", [x1, y1 - t / 2], [x0, y1 - t / 2], conv("n", x1, -1)],
    ["w", [x0 + t / 2, yn], [x0 + t / 2, ys], conv("w", yn, -1)],
  ];
  const soft = g(e, "soft", {} as Piece);
  for (const [side, p0, p1, openings] of sides) {
    if (openSides.includes(side)) continue;
    // the roof slab sits on the walls (no rounded top); the south / north walls run past the corners, so their
    // ends are the building's outer corners and are rounded
    const w: Piece = { p0, p1, height: h, thickness: t, z, mat: inn, mat2: ext, openings, frame_mat: frame, roofed: g(e, "roof", true),
      ends: side === "s" || side === "n" ? [true, true] : [false, false] };
    if (soft[side]) {
      Object.assign(w, { soft: true, reinforce: g(soft[side], "reinforce", false), breach: g(soft[side], "breach", false),
        name: g(soft[side], "name", side), surface: g(soft[side], "surface", ctx.surface(ext)) });
    }
    wall(ctx, w);
  }
  if (g(e, "floor_mat", "concrete_floor")) {
    ctx.box([(x0 + x1) / 2, (y0 + y1) / 2, z - 0.03], [x1 - x0 - 2 * t + 0.02, y1 - y0 - 2 * t + 0.02, 0.1],
      g(e, "floor_mat", "concrete_floor"), { collide: true, occlude: false });
  }
  // concrete and brick buildings (not the mud-house core): AC units and cables on the walls, rebar stubs left on an
  // unfinished flat roof - small clutter, near-detail variant only
  if (ctx.geometry && !e.parapet && ext !== "mud_wall" && ["plaster", "concrete", "brick"].includes(ctx.surface(ext))) {
    const r = new Random(Math.trunc(Math.abs(x0 * 17 + y0 * 29)) + 5);
    const mid = ctx.xf([(x0 + x1) / 2, (y0 + y1) / 2, z])[0];
    ctx.withVariant("hi", mid, () => {
      const units = 1 + Math.floor(r.random() * 2);
      for (let k = 0; k < units; k++) {
        const side = r.choice(["s", "n", "e", "w"]);
        if (openSides.includes(side)) continue;
        const alongX = side === "s" || side === "n";
        const sign = side === "s" || side === "w" ? -1 : 1;
        const span = alongX ? [x0 + 1, x1 - 1] : [y0 + 1, y1 - 1];
        if (span[1] <= span[0]) continue;
        const a = span[0] + r.random() * (span[1] - span[0]);
        const out = 0.2;
        const c = alongX ? [a, (sign < 0 ? y0 : y1) + sign * out, z + h * 0.72] : [(sign < 0 ? x0 : x1) + sign * out, a, z + h * 0.72];
        const hd = alongX ? 0 : 90;
        ctx.box(c, alongX ? [0.8, 0.36, 0.55] : [0.36, 0.8, 0.55], "steel_painted", { collide: false, occlude: false });
        const f = alongX ? [c[0], c[1] + sign * 0.185, c[2]] : [c[0] + sign * 0.185, c[1], c[2]];
        ctx.cylinder(f, 0.2, 0.012, "steel", 16, true, alongX ? [0, 90, 0] : [0, 0, 90]);
        // its cable running up to the roof
        const cz = (c[2] + 0.28 + z + h + roofTop(e)) / 2;
        ctx.box(alongX ? [a + 0.3, (sign < 0 ? y0 : y1) + sign * 0.02, cz] : [(sign < 0 ? x0 : x1) + sign * 0.02, a + 0.3, cz],
          [0.018, 0.018, z + h + roofTop(e) - c[2] - 0.28], "rubber", { hpr: [hd, 0, 0], collide: false, occlude: false });
      }
      if (g(e, "roof", true)) {
        const tz = z + h + roofTop(e);
        for (const [cx, cy] of [[x0 + 0.15, y0 + 0.15], [x1 - 0.15, y0 + 0.15], [x0 + 0.15, y1 - 0.15], [x1 - 0.15, y1 - 0.15]]) {
          for (let k = 0; k < 3; k++) ctx.cylinder([cx + (k - 1) * 0.06, cy + ((k * 7) % 3 - 1) * 0.05, tz + 0.18], 0.008, 0.36, "rust_metal", 6, true, [0, r.uniform(-6, 6), r.uniform(-6, 6)]);
        }
      }
    });
  }
  if (g(e, "roof", true)) {
    const roofMat = g(e, "roof_mat", "roof_membrane"), ceilMat = g(e, "ceiling_mat", inn);
    const top = z + h + roofT;
    const holes: number[][] = [];
    for (const hd of g(e, "hatches", [] as Piece[])) {
      const [sx, sy] = g(hd, "size", [1.2, 1.2]);
      const hx0 = hd.x - sx / 2, hy0 = hd.y - sy / 2;
      holes.push([hx0, hy0, hx0 + sx, hy0 + sy]);
      ctx.panel([hd.x, hd.y, top - roofT / 2], [sx, sy, roofT], g(hd, "mat", roofMat), ceilMat,
        { reinforce: g(hd, "reinforce", true), breach: g(hd, "breach", false), kind: "floor", name: g(hd, "name", "hatch"),
          surface: g(hd, "surface", "wood") });
      for (const [cx, cy, rx, ry] of [[hd.x, hy0 - 0.04, sx + 0.16, 0.08], [hd.x, hy0 + sy + 0.04, sx + 0.16, 0.08],
        [hx0 - 0.04, hd.y, 0.08, sy], [hx0 + sx + 0.04, hd.y, 0.08, sy]]) {
        ctx.box([cx, cy, top + 0.03], [rx, ry, 0.06], e.frame_mat || "steel_painted", { collide: false, occlude: false });
      }
    }
    for (const [rx0, ry0, rx1, ry1] of subtractRects([x0, y0, x1, y1], holes)) {
      slab(ctx, rx0, ry0, rx1, ry1, top, roofT, roofMat, ceilMat, g(e, "edge_mat", ext));
    }
    const par = g(e, "parapet", 0.0);
    if (par > 0) {
      const pt = 0.2;
      const gaps: Piece[] = g(e, "parapet_gaps", []);
      const defs: Array<[string, number[]]> = [["s", [(x0 + x1) / 2, y0 + pt / 2, x1 - x0, pt]],
        ["n", [(x0 + x1) / 2, y1 - pt / 2, x1 - x0, pt]], ["w", [x0 + pt / 2, (y0 + y1) / 2, pt, y1 - y0 - 2 * pt]],
        ["e", [x1 - pt / 2, (y0 + y1) / 2, pt, y1 - y0 - 2 * pt]]];
      for (const [side, [cx, cy, sx, sy]] of defs) {
        const alongX = side === "s" || side === "n";
        const lo = alongX ? cx - sx / 2 : cy - sy / 2;
        const hi = alongX ? cx + sx / 2 : cy + sy / 2;
        for (const [a, b] of subtractSpans(lo, hi, gaps.filter((gp) => gp.side === side).map((gp) => [gp.from, gp.to]))) {
          // a softly rounded crown near the camera (the collider is the plain box either way)
          if (alongX) ctx.rbox([(a + b) / 2, cy, top + par / 2], [b - a, sy, par], ext, { collide: true, occlude: true, round: ["+z", "+y", "-y"], radius: 0.06 });
          else ctx.rbox([cx, (a + b) / 2, top + par / 2], [sx, b - a, par], ext, { collide: true, occlude: true, round: ["+z", "+x", "-x"], radius: 0.06 });
        }
      }
    }
  }
};

PREFABS.twall = (ctx, e) => {
  const p0 = e.p0, p1 = e.p1;
  const z0 = g(e, "z", 0.0);
  const h = g(e, "height", 3.6);
  const mat = g(e, "mat", "concrete_barrier");
  const [dx, dy, length, heading] = line(p0, p1);
  const seg = g(e, "segment", 1.5);
  const n = Math.max(pyRound(length / seg), 1);
  const segLen = length / n;
  const rng = new Random(g(e, "seed", Math.trunc(Math.abs(p0[0] * 7 + p0[1] * 13)) + 1));
  const foot = g(e, "foot", 1.0);
  if (ctx.geometry) {
    for (let i = 0; i < n; i++) {
      const s = (i + 0.5) * segLen;
      const [cx, cy] = along(p0, dx, dy, length, s);
      const lean = rng.uniform(-0.4, 0.4);
      const hh = h + rng.uniform(-0.03, 0.03);
      ctx.box([cx, cy, z0 + 0.5 + (hh - 0.5) / 2], [segLen - 0.04, 0.26, hh - 0.5], mat, { hpr: [heading, 0, lean], collide: false, occlude: false });
      ctx.box([cx, cy, z0 + 0.22], [segLen - 0.04, foot, 0.44], mat, { hpr: [heading, 0, 0], collide: false, occlude: false });
      ctx.box([cx, cy, z0 + 0.5], [segLen - 0.05, 0.5, 0.16], mat, { hpr: [heading, 0, 0], collide: false, occlude: false });
    }
  }
  const mid = [p0[0] + dx / 2, p0[1] + dy / 2];
  ctx.collider([mid[0], mid[1], z0 + h / 2], [length, 0.32, h], [heading, 0, 0], "concrete");
  ctx.collider([mid[0], mid[1], z0 + 0.22], [length, foot, 0.44], [heading, 0, 0], "concrete");
  ctx.occluder([mid[0], mid[1], z0 + h / 2], [length, 0.3, h], [heading, 0, 0]);
};

PREFABS.jersey = (ctx, e) => {
  const p0 = e.p0, p1 = e.p1;
  const z0 = g(e, "z", 0.0);
  const mat = g(e, "mat", "concrete_barrier");
  const [dx, dy, length, heading] = line(p0, p1);
  const n = Math.max(pyRound(length / 3.0), 1);
  const segLen = length / n;
  if (ctx.geometry) {
    for (let i = 0; i < n; i++) {
      const [cx, cy] = along(p0, dx, dy, length, (i + 0.5) * segLen);
      const L = segLen - 0.06;
      const nc = { hpr: [heading, 0, 0], collide: false, occlude: false };
      ctx.box([cx, cy, z0 + 0.13], [L, 0.62, 0.26], mat, nc);
      ctx.box([cx, cy, z0 + 0.38], [L, 0.44, 0.24], mat, nc);
      ctx.box([cx, cy, z0 + 0.65], [L, 0.24, 0.3], mat, nc);
    }
  }
  const mid = [p0[0] + dx / 2, p0[1] + dy / 2];
  ctx.collider([mid[0], mid[1], z0 + 0.4], [length, 0.5, 0.8], [heading, 0, 0], "concrete");
  ctx.occluder([mid[0], mid[1], z0 + 0.4], [length, 0.5, 0.8], [heading, 0, 0]);
};

PREFABS.gabion = (ctx, e) => {
  const p0 = e.p0, p1 = e.p1;
  const z0 = g(e, "z", 0.0);
  const layers = Math.trunc(g(e, "layers", 1));
  const fill = g(e, "mat", "sandbag");
  const wire = g(e, "wire_mat", "steel");
  const [dx, dy, length, heading] = line(p0, p1);
  const n = Math.max(pyRound(length / 1.05), 1);
  const cell = length / n;
  const H = 1.25;
  if (ctx.geometry) {
    const nc = { hpr: [heading, 0, 0], collide: false, occlude: false };
    for (let layer = 0; layer < layers; layer++) {
      const zc = z0 + layer * H;
      for (let i = 0; i < n; i++) {
        const [cx, cy] = along(p0, dx, dy, length, (i + 0.5) * cell);
        ctx.box([cx, cy, zc + H / 2], [cell - 0.03, 1.02, H - 0.02], fill, nc);
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
          const [px, py] = along([cx, cy], dx, dy, length, sx * (cell / 2 - 0.02), sy * 0.52);
          ctx.box([px, py, zc + H / 2], [0.035, 0.035, H], wire, nc);
        }
        for (const sy of [-1, 1]) {
          const [px, py] = along([cx, cy], dx, dy, length, 0, sy * 0.52);
          for (const zz of [0.02, H - 0.02, H / 2]) ctx.box([px, py, zc + zz], [cell, 0.03, 0.03], wire, nc);
        }
      }
    }
  }
  const mid = [p0[0] + dx / 2, p0[1] + dy / 2];
  ctx.collider([mid[0], mid[1], z0 + layers * H / 2], [length, 1.05, layers * H], [heading, 0, 0], "dirt");
  ctx.occluder([mid[0], mid[1], z0 + layers * H / 2], [length, 1.05, layers * H], [heading, 0, 0]);
};

PREFABS.boom_gate = (ctx, e) => {
  const base = e.base;
  const heading = g(e, "heading", 0.0);
  const length = g(e, "length", 4.0);
  ctx.box(local(base, heading, 0, 0, 0.55), [0.4, 0.4, 1.1], "steel_painted", { hpr: [heading, 0, 0] });
  const nc = { hpr: [heading, 0, 0], collide: false, occlude: false };
  if (g(e, "raised", false)) {
    ctx.box(local(base, heading, 0, 0, 1.15 + length / 2), [0.12, 0.12, length], "hazard", nc);
  } else {
    ctx.box(local(base, heading, length / 2, 0, 1.0), [length, 0.12, 0.12], "hazard", nc);
    ctx.box(local(base, heading, length - 0.1, 0, 0.5), [0.1, 0.1, 1.0], "steel_painted", nc);
  }
};

PREFABS.vehicle = (ctx, e) => {
  const base = e.base;
  const hd = g(e, "heading", 0.0);
  const paint = g(e, "mat", "vehicle_od");
  const kind = g(e, "kind", "truck");
  const part = (lx: number, ly: number, lz: number, size: number[], m: string, collide = false) =>
    ctx.box(local(base, hd, lx, ly, lz), size, m, { hpr: [hd, 0, 0], collide, occlude: false });
  const wheel = (lx: number, ly: number, r: number, w: number) => {
    ctx.cylinder(local(base, hd, lx, ly, r), r, w, "rubber", 16, true, [hd, 0, 90]);
    ctx.cylinder(local(base, hd, lx + Math.sign(lx || 1) * (w / 2 + 0.005), ly, r), r * 0.55, 0.02, "steel", 12, true, [hd, 0, 90]);
  };
  if (kind === "truck") {
    if (ctx.geometry) {
      part(0, 0, 0.95, [1.0, 7.0, 0.3], "steel");
      part(0, 2.55, 1.15, [2.2, 1.3, 0.75], paint);
      part(0, 1.35, 1.95, [2.4, 1.6, 1.7], paint);
      part(0, 2.16, 2.25, [2.1, 0.03, 0.62], "glass_dark");
      for (const sx of [-1, 1]) {
        part(sx * 1.205, 1.4, 2.3, [0.02, 1.0, 0.55], "glass_dark");
        part(sx * 1.35, 2.15, 2.25, [0.2, 0.06, 0.32], "steel");
      }
      part(0, 3.25, 0.85, [2.4, 0.18, 0.3], "steel");
      part(0, -1.7, 1.42, [2.5, 4.7, 0.16], "wood_planks");
      for (const sx of [-1, 1]) part(sx * 1.2, -1.7, 1.85, [0.08, 4.7, 0.7], paint);
      part(0, -1.7, 2.75, [2.46, 4.6, 1.5], g(e, "cover_mat", "canvas"));
      part(0, -4.0, 1.85, [2.5, 0.08, 0.7], paint);
      for (const sx of [-1, 1]) part(sx * 0.95, 0.25, 1.0, [0.5, 1.1, 0.5], "steel");
      for (const [ly, r] of [[2.45, 0.55], [-1.15, 0.55], [-2.55, 0.55]]) for (const sx of [-1, 1]) wheel(sx * 1.05, ly, r, 0.4);
    }
    ctx.collider(local(base, hd, 0, 1.8, 1.45), [2.4, 3.0, 2.9], [hd, 0, 0], "metal");
    ctx.collider(local(base, hd, 0, -1.7, 1.8), [2.5, 4.7, 3.0], [hd, 0, 0], "metal");
    ctx.occluder(local(base, hd, 0, 0, 1.6), [2.4, 7.0, 3.0], [hd, 0, 0]);
  } else {
    if (ctx.geometry) {
      part(0, 0, 0.95, [2.1, 4.6, 0.75], paint);
      part(0, 1.55, 1.38, [2.0, 1.4, 0.14], paint);
      part(0, -0.45, 1.68, [2.0, 2.4, 0.66], paint);
      part(0, 0.77, 1.68, [1.9, 0.04, 0.5], "glass_dark");
      for (const sx of [-1, 1]) for (const ly of [0.15, -0.95]) part(sx * 1.005, ly, 1.72, [0.02, 0.9, 0.42], "glass_dark");
      part(0, -1.66, 1.68, [1.9, 0.03, 0.42], "glass_dark");
      part(0, 2.33, 0.75, [2.15, 0.15, 0.32], "steel");
      part(0, -2.5, 1.2, [0.9, 0.3, 0.9], "rubber");
      for (const ly of [1.55, -1.45]) for (const sx of [-1, 1]) wheel(sx * 0.98, ly, 0.45, 0.35);
    }
    ctx.collider(local(base, hd, 0, 0, 1.0), [2.15, 4.7, 2.0], [hd, 0, 0], "metal");
    ctx.occluder(local(base, hd, 0, 0, 1.0), [2.1, 4.6, 2.0], [hd, 0, 0]);
  }
};

PREFABS.canopy = (ctx, e) => {
  const [[x0, y0], [x1, y1]] = [e.min, e.max];
  const h = g(e, "height", 6.0);
  const spacing = g(e, "spacing", 5.0);
  const col = g(e, "col_mat", "steel_painted");
  const roof = g(e, "roof_mat", "corrugated_grey");
  const over = g(e, "overhang", 0.6);
  const nx = Math.max(pyRound((x1 - x0) / spacing), 1);
  const ny = Math.max(pyRound((y1 - y0) / spacing), 1);
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= ny; j++) {
    if (i > 0 && i < nx && j > 0 && j < ny) continue;
    ctx.box([x0 + (x1 - x0) * i / nx, y0 + (y1 - y0) * j / ny, h / 2], [0.3, 0.3, h], col, { collide: true, occlude: false });
  }
  if (ctx.geometry) {
    for (let i = 0; i <= nx; i++) {
      ctx.box([x0 + (x1 - x0) * i / nx, (y0 + y1) / 2, h - 0.25], [0.25, y1 - y0 + 0.3, 0.5], col, { collide: false, occlude: false });
    }
    for (let j = 0; j <= ny * 2; j++) {
      ctx.box([(x0 + x1) / 2, y0 + (y1 - y0) * j / (ny * 2), h + 0.06], [x1 - x0, 0.12, 0.12], col, { collide: false, occlude: false });
    }
  }
  ctx.box([(x0 + x1) / 2, (y0 + y1) / 2, h + 0.17], [x1 - x0 + 2 * over, y1 - y0 + 2 * over, 0.1], roof, { collide: true, occlude: true });
  const walls = g(e, "walls", {} as Piece);
  const wm = g(e, "wall_mat", roof);
  const defs: Record<string, [number[], number[], string, number, number]> = {
    s: [[x0, y0], [x1, y0], "x", x0, 1], n: [[x1, y1], [x0, y1], "x", x1, -1],
    e: [[x1, y0], [x1, y1], "y", y0, 1], w: [[x0, y1], [x0, y0], "y", y1, -1],
  };
  for (const [side, spec] of Object.entries(walls) as Array<[string, Piece]>) {
    const [p0, p1, key, start, sign] = defs[side];
    const ops = (spec.openings ?? []).map((op: Piece) => ({ ...op, at: (op[key] - start) * sign }));
    wall(ctx, { p0, p1, height: h + 0.12, thickness: 0.12, mat: wm, openings: ops, extend: true, soft: g(spec, "soft", false),
      reinforce: g(spec, "reinforce", false), breach: g(spec, "breach", false), name: g(spec, "name", side) });
  }
};

PREFABS.mast = (ctx, e) => {
  const [bx, by, bz] = e.base;
  const height = g(e, "height", 18.0);
  const w0 = g(e, "width", 3.0);
  const w1 = g(e, "top_width", 1.0);
  const mat = g(e, "mat", "steel");
  const sections = Math.trunc(g(e, "sections", 8));
  const sh = height / sections;
  if (ctx.geometry) {
    const nc = { collide: false, occlude: false };
    for (let k = 0; k < sections; k++) {
      const za = bz + k * sh, zb = bz + (k + 1) * sh;
      const wa = w0 + (w1 - w0) * k / sections;
      const wb = w0 + (w1 - w0) * (k + 1) / sections;
      const wm = (wa + wb) / 2;
      const lean = Math.atan2((wa - wb) / 2, sh) / D;
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
        ctx.box([bx + sx * wm / 2, by + sy * wm / 2, (za + zb) / 2], [0.1, 0.1, sh * 1.02], mat, { ...nc, hpr: [0, sy * lean, -sx * lean] });
      }
      const diag = Math.hypot(wm, sh);
      const ang = Math.atan2(sh, wm) / D;
      for (const side of [-1, 1]) for (const a of [ang, -ang]) {
        ctx.box([bx, by + side * wm / 2, (za + zb) / 2], [diag, 0.05, 0.05], mat, { ...nc, hpr: [0, 0, a] });
        ctx.box([bx + side * wm / 2, by, (za + zb) / 2], [diag, 0.05, 0.05], mat, { ...nc, hpr: [90, 0, a] });
      }
      ctx.box([bx, by, zb], [wb, wb, 0.06], mat, nc);
    }
  }
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    ctx.collider([bx + sx * w0 / 2, by + sy * w0 / 2, bz + 3.0], [0.2, 0.2, 6.0], [0, 0, 0], "metal");
  }
  const top = bz + height;
  ctx.cylinder([bx, by, top + 2.0], 0.05, 4.0, mat, 8);
  ctx.cylinder([bx + 0.3, by, top + 1.2], 0.03, 2.4, mat, 6);
  ctx.cylinder([bx + w1 / 2 + 0.4, by, top - 2.5], 0.7, 0.18, "paint_white", 24, true, [90, 0, 70]);
  ctx.cylinder([bx, by - w1 / 2 - 0.3, top - 4.5], 0.5, 0.15, "paint_white", 24, true, [0, 70, 0]);
  if (g(e, "light", true)) {
    ctx.light({ pos: [bx, by, top + 4.15], kind: "point", color: [1.0, 0.08, 0.04], intensity: 6.0, range: 6.0, shadows: false });
  }
};

PREFABS.furniture = (ctx, e) => {
  const kind = g(e, "kind", "table");
  const base = e.base;
  const hd = g(e, "heading", 0.0);
  const n = Math.trunc(g(e, "count", 1));
  const part = (lx: number, ly: number, lz: number, size: number[], m: string, collide = false) => {
    if (ctx.geometry || collide) ctx.box(local(base, hd, lx, ly, lz), size, m, { hpr: [hd, 0, 0], collide, occlude: false });
  };
  const coll = (lx: number, ly: number, lz: number, size: number[], surface = "metal") =>
    ctx.collider(local(base, hd, lx, ly, lz), size, [hd, 0, 0], surface);
  if (kind === "bunk") {
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) part(sx * 0.42, sy * 0.95, 0.9, [0.05, 0.05, 1.8], "steel_painted");
    for (const z of [0.38, 1.38]) {
      part(0, 0, z, [0.9, 1.95, 0.06], "steel_painted");
      part(0, 0, z + 0.1, [0.82, 1.85, 0.14], "mattress");
    }
    coll(0, 0, 0.9, [0.9, 2.0, 1.8], "fabric");
  } else if (kind === "locker") {
    const w = 0.42;
    for (let i = 0; i < n; i++) {
      const lx = (i - (n - 1) / 2) * w;
      part(lx, 0, 0.93, [w - 0.01, 0.5, 1.86], "steel_painted");
      part(lx, -0.252, 1.5, [0.2, 0.01, 0.05], "steel");
      part(lx + w * 0.3, -0.252, 1.0, [0.03, 0.02, 0.15], "steel");
    }
    coll(0, 0, 0.93, [w * n, 0.5, 1.86]);
  } else if (kind === "shelf" || kind === "rack") {
    const L = g(e, "length", 2.0);
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) part(sx * (L / 2 - 0.03), sy * 0.27, 1.0, [0.05, 0.05, 2.0], "steel_painted");
    const rng = new Random(g(e, "seed", 5));
    for (const z of [0.15, 0.75, 1.35, 1.95]) {
      part(0, 0, z, [L, 0.6, 0.04], "steel_painted");
      if (z < 1.9) {
        let x = -L / 2 + 0.1;
        while (x < L / 2 - 0.35) {
          const bw = rng.uniform(0.3, 0.6);
          const bh = rng.uniform(0.18, 0.42);
          const m = rng.choice(["metal_olive", "plywood", "metal_olive", "canvas"]);
          part(x + bw / 2, rng.uniform(-0.05, 0.05), z + 0.02 + bh / 2, [bw, 0.45, bh], m);
          x += bw + rng.uniform(0.04, 0.2);
        }
      }
    }
    coll(0, 0, 1.0, [L, 0.6, 2.0]);
  } else if (kind === "table" || kind === "desk" || kind === "workbench") {
    const L = g(e, "length", 1.8), W = g(e, "width", 0.8);
    const top = kind === "workbench" ? "steel" : kind === "table" ? "wood_planks" : "steel_painted";
    const hgt = kind === "workbench" ? 0.9 : 0.76;
    part(0, 0, hgt - 0.025, [L, W, 0.05], top);
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      part(sx * (L / 2 - 0.06), sy * (W / 2 - 0.06), (hgt - 0.05) / 2, [0.05, 0.05, hgt - 0.05], "steel_painted");
    }
    if (kind === "desk") part(L / 2 - 0.25, 0, 0.4, [0.4, W - 0.06, 0.66], "steel_painted");
    if (kind === "workbench") {
      part(0, 0, 0.2, [L - 0.1, W - 0.1, 0.03], "steel_painted");
      part(-L / 2 + 0.2, -W / 2 + 0.1, hgt + 0.08, [0.2, 0.12, 0.12], "steel");
    }
    coll(0, 0, hgt / 2, [L, W, hgt]);
  } else if (kind === "generator") {
    part(0, 0, 0.55, [1.0, 2.0, 1.1], "vehicle_od");
    part(0, 0, 1.12, [0.9, 1.8, 0.05], "steel");
    part(0, 0.9, 1.3, [0.12, 0.12, 0.5], "steel");
    coll(0, 0, 0.6, [1.0, 2.0, 1.2]);
  } else if (kind === "fuel_tank") {
    const L = g(e, "length", 6.0);
    const r = g(e, "radius", 1.2);
    ctx.cylinder(local(base, hd, 0, 0, r + 0.5), r, L, g(e, "mat", "paint_white"), 24, true, [hd, 90, 0]);
    for (const sy of [-1, 1]) part(0, sy * (L / 2 - 0.8), 0.45, [r * 1.6, 0.3, 0.9], "concrete_barrier");
    part(0, 0, 2 * r + 0.55, [0.6, 0.6, 0.12], "steel");
    coll(0, 0, r + 0.5, [2 * r, L, 2 * r + 0.2]);
  } else if (kind === "flagpole") {
    const h = g(e, "height", 9.0);
    part(0, 0, 0.2, [1.2, 1.2, 0.4], "concrete_barrier", true);
    ctx.cylinder(local(base, hd, 0, 0, 0.4 + h / 2), 0.06, h, "steel", 10);
    if (ctx.geometry) ctx.box(local(base, hd, 0.65, 0, h - 0.4), [1.2, 0.02, 0.8], g(e, "flag_mat", "paint_red"), { hpr: [hd, 0, 0], collide: false, occlude: false });
    coll(0, 0, 0.4 + h / 2, [0.15, 0.15, h]);
  } else if (kind === "ammo_boxes") {
    const rng = new Random(g(e, "seed", 9));
    for (let i = 0; i < n; i++) {
      const lx = (i % 3) * 0.62 - 0.62;
      const lz = Math.floor(i / 3) * 0.32;
      part(lx + rng.uniform(-0.03, 0.03), rng.uniform(-0.03, 0.03), lz + 0.16, [0.58, 0.32, 0.3], "metal_olive");
    }
    const rows = Math.floor((n + 2) / 3);
    coll(0, 0, rows * 0.16, [1.9, 0.35, rows * 0.32]);
  } else if (kind === "cabinet") {
    part(0, 0, 0.7, [0.9, 0.5, 1.4], "steel_painted");
    part(0, -0.252, 1.05, [0.85, 0.01, 0.02], "steel");
    coll(0, 0, 0.7, [0.9, 0.5, 1.4]);
  }
};

PREFABS.camera = (ctx, e) => {
  const [c, r] = ctx.xf(e.pos, [g(e, "heading", 0.0), 0, 0]);
  ctx.cameras.push({ name: g(e, "name", ""), pos: c, heading: r[0], pitch: Number(g(e, "pitch", -15.0)) });
};

PREFABS.zone = (ctx, e) => {
  ctx.zones.push({ name: e.name, kind: g(e, "kind", "bombsite"), team: g(e, "team", ""), min: [e.min[0], e.min[1], e.min[2]], max: [e.max[0], e.max[1], e.max[2]] });
};

PREFABS.callout = (ctx, e) => {
  ctx.callouts.push({ name: e.name, min: [...e.min], max: [...e.max] });
};

PREFABS.paint_line = (ctx, e) => {
  if (!ctx.geometry) return;
  const [dx, dy, length, heading] = line(e.p0, e.p1);
  const z = g(e, "z", 0.0);
  ctx.box([e.p0[0] + dx / 2, e.p0[1] + dy / 2, z + 0.004], [length, g(e, "width", 0.12), 0.01], g(e, "mat", "paint_white"),
    { hpr: [heading, 0, 0], collide: false, occlude: false });
};

// ------------------------------------------------------------------ terrain
function valueNoise(seed: number, cell: number): (x: number, y: number) => number {
  const rng = new Random(seed * 7919 + 17);
  const lattice = new Float64Array(257 * 257);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng.random();
  return (x, y) => {
    const gx = x / cell, gy = y / cell;
    let ix = Math.floor(gx), iy = Math.floor(gy);
    let fx = gx - ix, fy = gy - iy;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    ix = ((ix % 256) + 256) % 256;
    iy = ((iy % 256) + 256) % 256;
    const a = lattice[ix * 257 + iy], b = lattice[(ix + 1) * 257 + iy];
    const c = lattice[ix * 257 + iy + 1], d = lattice[(ix + 1) * 257 + iy + 1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
}

/** Backdrop hills around the playable area (visual only, no collision). */
PREFABS.terrain = (ctx, e) => {
  if (!ctx.geometry) return;
  const [[x0, y0], [x1, y1]] = e.inner;
  const extent = g(e, "extent", 480.0);
  const step = g(e, "step", 8.0);
  const start = g(e, "start", 20.0);
  const ramp = g(e, "ramp", 120.0);
  const hmax = g(e, "height", 26.0);
  const seed = g(e, "seed", 7);
  const mat = g(e, "mat", "sand");
  const uv = g(e, "uv_scale", ctx.uvScale(mat) * 2.5);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const n1 = valueNoise(seed, 90), n2 = valueNoise(seed + 1, 35), n3 = valueNoise(seed + 2, 14);
  const height = (X: number, Y: number) => {
    const dx = Math.max(x0 - X, X - x1, 0), dy = Math.max(y0 - Y, Y - y1, 0);
    const dd = Math.hypot(dx, dy);
    let t = Math.min(Math.max((dd - start) / ramp, 0), 1);
    t = t * t * (3 - 2 * t);
    const nn = n1(X + 1000, Y + 1000) * 0.6 + n2(X + 1000, Y + 1000) * 0.3 + n3(X + 1000, Y + 1000) * 0.1;
    return t * hmax * (0.35 + 0.65 * nn) - 0.08;
  };
  const xs: number[] = [], ys: number[] = [];
  for (let x = cx - extent; x <= cx + extent + step * 0.5; x += step) xs.push(x);
  for (let y = cy - extent; y <= cy + extent + step * 0.5; y += step) ys.push(y);
  // the backdrop layer: drawn first by the client's backdrop camera (its own near / far range), not by the main pass
  const mb = ctx.builder(`${mat}@backdrop`);
  const base = mb.vertexCount;
  for (const X of xs) for (const Y of ys) {
    const Z = height(X, Y);
    const dzdx = (height(X + 1, Y) - height(X - 1, Y)) / 2;
    const dzdy = (height(X, Y + 1) - height(X, Y - 1)) / 2;
    const tl = Math.hypot(1, dzdx), bl = Math.hypot(1, dzdy);
    const T = [1 / tl, 0, dzdx / tl], B = [0, 1 / bl, dzdy / bl];
    const N = [T[1] * B[2] - T[2] * B[1], T[2] * B[0] - T[0] * B[2], T[0] * B[1] - T[1] * B[0]];
    const nl = Math.hypot(N[0], N[1], N[2]);
    mb.vertex([X, Y, Z], [N[0] / nl, N[1] / nl, N[2] / nl], T, B, X / uv, Y / uv);
  }
  const ny = ys.length;
  for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < ny - 1; j++) {
    if (xs[i] >= x0 && xs[i + 1] <= x1 && ys[j] >= y0 && ys[j + 1] <= y1) continue;
    const a = base + i * ny + j, b = base + (i + 1) * ny + j, c = base + (i + 1) * ny + j + 1, d = base + i * ny + j + 1;
    mb.indices.push(a, b, c, a, c, d);
  }
};
