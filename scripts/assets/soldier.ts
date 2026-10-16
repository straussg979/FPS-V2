// The soldier as a skinned GLB, generated from the game skeleton (shared/src/skeleton.ts) so the body the
// client draws is posed by exactly the bones the server's hit capsules hang on.
// The body is lofted: rings of points placed along the rest-pose skeleton (torso, neck, head, arms, legs),
// each ring weighted to one or two bones, so elbows, knees, hips and the spine bend smoothly. On top goes the
// face (nose, brows, eyes, ears, hair, an optional beard) and two kits for the Afghanistan setting:
// Vanguard (attack) - arid camo, a high-cut helmet with a headset and NVG mount, ballistic glasses, a shemagh,
// a plate carrier with pouches, hydration pack and radio, gloves, knee pads, tan boots;
// Bastion (defend) - olive camo field jacket, a wool pakol, a scarf, a chest rig of AK pouches, bare hands,
// brown boots. Side-only parts carry an "a:" / "d:" material prefix; the client keeps the side's own parts and
// binds the side's kit and a skin tone per soldier. Three levels of detail (LOD0-2) share the skeleton.
// Simpler than the desktop's sculpted MakeHuman body, but a real skinned mesh with the same skeleton.

import { type M4, type V3, vadd, vcross, vnorm, vscale, vsub } from "../../shared/src/math";
import { BONES, INDEX, INV_BIND, N_BONES, REST_WORLD } from "../../shared/src/skeleton";
import { GltfBuilder } from "./glb";

type W = Array<[string, number]>;
interface Ring { c: V3; u: V3; v: V3; rx: number; ry: number; w: W; n?: number }

const pos = (b: string): V3 => { const m = REST_WORLD[INDEX[b]]; return [m[12], m[13], m[14]]; };
const axis = (b: string, k: 0 | 1 | 2): V3 => { const m = REST_WORLD[INDEX[b]]; return vnorm([m[k * 4], m[k * 4 + 1], m[k * 4 + 2]]); };
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const X: V3 = [1, 0, 0], Y: V3 = [0, 1, 0], Z: V3 = [0, 0, 1];

/** One material's vertices: position, uv, the four strongest bones and their weights. */
class Part {
  p: number[] = []; uv: number[] = []; j: number[] = []; w: number[] = []; idx: number[] = [];
  get count(): number { return this.p.length / 3; }

  vertex(p: V3, uv: [number, number], weights: W): number {
    const list = weights.map(([b, w]) => [INDEX[b], w] as [number, number]).filter(([, w]) => w > 1e-4)
      .sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = list.reduce((s, [, w]) => s + w, 0) || 1;
    while (list.length < 4) list.push([0, 0]);
    this.p.push(...p);
    this.uv.push(...uv);
    for (const [b, w] of list) { this.j.push(b); this.w.push(w / sum); }
    return this.count - 1;
  }

  /** Rings joined into a tube; superellipse exponent n (2 = ellipse, higher = boxier); optional end caps. */
  loft(rings: Ring[], seg: number, capStart = false, capEnd = false, uvScale = 0.5): void {
    const base = this.count;
    let along = 0;
    rings.forEach((r, i) => {
      if (i) along += Math.hypot(...vsub(r.c, rings[i - 1].c) as [number, number, number]);
      const e = 2 / (r.n ?? 2);
      for (let k = 0; k <= seg; k++) {
        const a = (k / seg) * Math.PI * 2;
        const c = Math.cos(a), s = Math.sin(a);
        const cx = Math.sign(c) * Math.abs(c) ** e, sy = Math.sign(s) * Math.abs(s) ** e;
        const p = vadd(r.c, vadd(vscale(r.u, cx * r.rx), vscale(r.v, sy * r.ry)));
        this.vertex(p, [(k / seg) * Math.PI * (r.rx + r.ry) / uvScale, along / uvScale], r.w);
      }
    });
    const stride = seg + 1;
    for (let i = 0; i + 1 < rings.length; i++) for (let k = 0; k < seg; k++) {
      const a = base + i * stride + k, b = a + 1, c = a + stride, d = c + 1;
      this.idx.push(a, b, c, b, d, c);                  // counter-clockwise seen from outside
    }
    const cap = (ri: number, flip: boolean) => {
      const r = rings[ri];
      const centre = this.vertex(r.c, [0.5, 0.5], r.w);
      for (let k = 0; k < seg; k++) {
        const a = base + ri * stride + k, b = a + 1;
        if (flip) this.idx.push(centre, a, b); else this.idx.push(centre, b, a);
      }
    };
    if (capStart) cap(0, true);
    if (capEnd) cap(rings.length - 1, false);
  }

  /** Like loft, but only the arc a0..a1 of each ring (radians; pi/2 points along v): an open shell. */
  loftArc(rings: Ring[], seg: number, a0: number, a1: number, uvScale = 0.5): void {
    const base = this.count;
    rings.forEach((r) => {
      const e = 2 / (r.n ?? 2);
      for (let k = 0; k <= seg; k++) {
        const a = a0 + (k / seg) * (a1 - a0);
        const c = Math.cos(a), s = Math.sin(a);
        const cx = Math.sign(c) * Math.abs(c) ** e, sy = Math.sign(s) * Math.abs(s) ** e;
        this.vertex(vadd(r.c, vadd(vscale(r.u, cx * r.rx), vscale(r.v, sy * r.ry))), [k / seg / uvScale, r.c[2] / uvScale], r.w);
      }
    });
    const stride = seg + 1;
    for (let i = 0; i + 1 < rings.length; i++) for (let k = 0; k < seg; k++) {
      const a = base + i * stride + k, b = a + 1, c = a + stride, d = c + 1;
      this.idx.push(a, b, c, b, d, c);                  // counter-clockwise seen from outside
    }
  }

  /** A box in a bone-aligned frame (centre, half sizes along u / v / w), all on the given weights. */
  box(c: V3, u: V3, v: V3, w: V3, h: V3, weights: W): void {
    const corners: V3[] = [];
    for (const sz of [-1, 1]) for (const sy of [-1, 1]) for (const sx of [-1, 1]) {
      corners.push(vadd(c, vadd(vscale(u, sx * h[0]), vadd(vscale(v, sy * h[1]), vscale(w, sz * h[2])))));
    }
    const faces = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
    for (const f of faces) {                                   // separate corners per face: hard edges
      const ids = f.map((i, k) => this.vertex(corners[i], [[0, 0], [1, 0], [1, 1], [0, 1]][k] as [number, number], weights));
      this.idx.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]);
    }
  }

  normals(): Float32Array {
    const n = new Float32Array(this.p.length);
    const P = this.p;
    for (let t = 0; t < this.idx.length; t += 3) {
      const [a, b, c] = [this.idx[t], this.idx[t + 1], this.idx[t + 2]];
      const ab = [P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]];
      const ac = [P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]];
      const f = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
      for (const i of [a, b, c]) for (let k = 0; k < 3; k++) n[i * 3 + k] += f[k];
    }
    // weld normals of coincident vertices (tube seams), then normalise
    const key = (i: number) => `${P[i * 3].toFixed(4)},${P[i * 3 + 1].toFixed(4)},${P[i * 3 + 2].toFixed(4)}`;
    const groups = new Map<string, number[]>();
    for (let i = 0; i < this.count; i++) { const k = key(i); groups.set(k, [...(groups.get(k) ?? []), i]); }
    for (const ids of groups.values()) {
      if (ids.length < 2) continue;
      const s = [0, 0, 0];
      for (const i of ids) for (let k = 0; k < 3; k++) s[k] += n[i * 3 + k];
      for (const i of ids) for (let k = 0; k < 3; k++) n[i * 3 + k] = s[k];
    }
    for (let i = 0; i < this.count; i++) {
      const l = Math.hypot(n[i * 3], n[i * 3 + 1], n[i * 3 + 2]) || 1;
      for (let k = 0; k < 3; k++) n[i * 3 + k] /= l;
    }
    return n;
  }
}

/** The whole soldier at one level of detail: material name -> part.
 *
 * Material names the client resolves (client/src/game/soldiers.ts):
 *   kit_*        the side's kit (Vanguard / Bastion): uniform camo, vest cordura, hands (gloves / bare), boots;
 *   skin, hair   one of four skin tones per soldier, dark hair;  opt_beard  only on some soldiers;
 *   a:<mat>      Vanguard-only parts (helmet, headset, glasses, plate carrier, knee pads, shemagh);
 *   d:<mat>      Bastion-only parts (pakol cap, chest rig, scarf, field jacket);
 *   anything else is a plain material from data/materials.json. */
function body(seg: number): Map<string, Part> {
  const parts = new Map<string, Part>();
  const part = (m: string) => { let p = parts.get(m); if (!p) parts.set(m, (p = new Part())); return p; };
  const fine = seg >= 12;
  const mid = seg >= 9;
  const S3: W = [["spine_03", 1]], HEAD: W = [["head", 1]], PELV: W = [["pelvis", 1]];

  // ---------------------------------------------------------------- torso (shirt)
  const t: Array<[number, number, number, number, W]> = [
    [0.78, 0.152, 0.112, 0.000, PELV],
    [0.88, 0.166, 0.118, 0.000, PELV],
    [0.97, 0.150, 0.108, 0.006, [["pelvis", 0.5], ["spine_01", 0.5]]],
    [1.06, 0.144, 0.104, 0.010, [["spine_01", 0.6], ["spine_02", 0.4]]],
    [1.15, 0.156, 0.112, 0.014, [["spine_02", 0.5], ["spine_03", 0.5]]],
    [1.25, 0.176, 0.122, 0.014, S3],
    [1.34, 0.198, 0.124, 0.008, S3],
    [1.41, 0.190, 0.110, 0.000, S3],
    [1.455, 0.090, 0.070, 0.000, [["spine_03", 0.5], ["neck", 0.5]]],
  ];
  part("kit_uniform").loft(t.map(([z, rx, ry, y, w]) => ({ c: [0, y, z], u: X, v: Y, rx, ry, w, n: 2.6 })), seg, true, false);
  // collar and the shirt's button placket
  part("kit_uniform").loft([1.43, 1.47].map((z, i) => ({ c: [0, 0.004, z] as V3, u: X, v: Y, rx: [0.082, 0.07][i], ry: [0.07, 0.062][i],
    w: [["spine_03", 0.5], ["neck", 0.5]] as W, n: 2.2 })), seg);
  if (mid) part("kit_uniform").box([0, 0.128, 1.2], X, Y, Z, [0.012, 0.006, 0.16], S3);

  // ---------------------------------------------------------------- neck and head
  const neck = pos("neck");
  part("skin").loft([
    { c: [0, -0.004, 1.44], u: X, v: Y, rx: 0.056, ry: 0.054, w: [["spine_03", 0.4], ["neck", 0.6]] },
    { c: [0, -0.006, 1.52], u: X, v: Y, rx: 0.052, ry: 0.052, w: [["neck", 1]] },
    { c: lerp3(neck, pos("head"), 0.8), u: X, v: Y, rx: 0.054, ry: 0.056, w: [["neck", 0.3], ["head", 0.7]] },
  ], seg);
  // the head: chin to crown, the face pushed forward, the back of the skull rounded
  const prof: Array<[number, number, number, number]> = [
    [1.548, 0.026, 0.024, 0.060], [1.562, 0.054, 0.052, 0.040], [1.585, 0.066, 0.078, 0.020], [1.615, 0.073, 0.090, 0.012],
    [1.645, 0.078, 0.097, 0.008], [1.675, 0.080, 0.099, 0.002], [1.705, 0.081, 0.098, -0.004], [1.735, 0.074, 0.090, -0.010],
    [1.758, 0.056, 0.068, -0.014], [1.772, 0.026, 0.032, -0.016], [1.776, 0.004, 0.004, -0.016],
  ];
  const headRings = prof.filter((_, i) => fine || i % 2 === 0 || i === prof.length - 1)
    .map(([z, rx, ry, y]) => ({ c: [0, y, z] as V3, u: X, v: Y, rx, ry, w: HEAD, n: 2.15 }));
  part("skin").loft(headRings, seg);
  // face: nose, brow, ears, eyes, brows, mouth
  const face = (m: string, c: V3, h: V3, u: V3 = X, v: V3 = Y, w: V3 = Z) => part(m).box(c, u, v, w, h, HEAD);
  const tilt = vnorm([0, 0.35, 1]), noseV = vnorm(vcross(tilt, X));
  face("skin", [0, 0.104, 1.652], [0.011, 0.013, 0.022], X, noseV, tilt);
  face("skin", [0, 0.115, 1.636], [0.013, 0.008, 0.009]);
  face("skin", [0, 0.098, 1.704], [0.058, 0.01, 0.009]);
  for (const sx of [-1, 1]) {
    face("skin", [sx * 0.081, -0.004, 1.664], [0.007, 0.019, 0.03]);
    face("eye", [sx * 0.032, 0.095, 1.684], [0.013, 0.006, 0.006]);
    face("hair", [sx * 0.033, 0.1, 1.701], [0.019, 0.005, 0.0045]);
  }
  face("shadow", [0, 0.1, 1.612], [0.02, 0.004, 0.0028]);
  // short hair over the skull (shows under the pakol and the helmet's edge)
  part("hair").loft(prof.slice(5).map(([z, rx, ry, y], i) => ({ c: [0, y - 0.006, z + 0.004] as V3, u: X, v: Y,
    rx: Math.max(rx + 0.004, 0.004), ry: Math.max(ry + 0.002 - (i === 0 ? 0.012 : 0), 0.004), w: HEAD, n: 2.15 })), seg);
  // a beard on some soldiers: around the jaw from ear to ear, and a moustache
  part("opt_beard").loftArc(prof.slice(0, 4).map(([z, rx, ry, y]) => ({ c: [0, y, z] as V3, u: X, v: Y, rx: rx + 0.004, ry: ry + 0.004,
    w: HEAD, n: 2.15 })), seg, -0.08 * Math.PI, 1.08 * Math.PI);
  part("opt_beard").box([0, 0.101, 1.621], X, Y, Z, [0.022, 0.005, 0.0045], HEAD);                 // moustache
  for (const sx of [-1, 1]) part("opt_beard").box([sx * 0.074, 0.03, 1.63], X, Y, Z, [0.006, 0.03, 0.03], HEAD);   // sideburns

  // ---------------------------------------------------------------- Vanguard: helmet, headset, glasses, scarf
  const helm: Ring[] = [];
  const hm = fine ? 7 : 4;
  for (let i = 0; i <= hm; i++) {
    const a = (i / hm) * (Math.PI / 2);
    helm.push({ c: [0, -0.012, 1.69 + Math.sin(a) * 0.098], u: X, v: Y, rx: Math.max(Math.cos(a) * 0.1, 0.004),
      ry: Math.max(Math.cos(a) * 0.118, 0.004), w: HEAD, n: 2.3 });
  }
  part("a:kit_helmet").loft([{ ...helm[0], rx: 0.104, ry: 0.122, c: [0, -0.016, 1.682] }, ...helm], seg);
  for (const sx of [-1, 1]) {
    part("a:kit_helmet").box([sx * 0.101, -0.006, 1.712], X, Y, Z, [0.006, 0.055, 0.011], HEAD);       // rails
    part("a:rubber").box([sx * 0.091, -0.004, 1.664], X, Y, Z, [0.016, 0.03, 0.036], HEAD);          // headset cups
    if (fine && sx < 0) part("a:rubber").box([sx * 0.075, 0.07, 1.64], X, Y, Z, [0.003, 0.03, 0.003], HEAD);   // boom mic (clear of the beard)
  }
  part("a:steel").box([0, 0.112, 1.745], X, Y, Z, [0.02, 0.01, 0.015], HEAD);                       // NVG shroud
  if (mid) part("a:kit_vest").box([0, -0.118, 1.73], X, Y, Z, [0.035, 0.008, 0.02], HEAD);          // counterweight
  part("a:lens").box([0, 0.107, 1.686], X, Y, Z, [0.066, 0.005, 0.016], HEAD);                      // (proud of the face: no z-fight)                      // ballistic glasses
  part("a:rubber").box([0, 0.105, 1.703], X, Y, Z, [0.068, 0.006, 0.0035], HEAD);
  // shemagh bunched around the neck
  part("a:shemagh_tan").loft([[1.43, 0.098, 0.094], [1.465, 0.086, 0.084], [1.5, 0.07, 0.07]].map(([z, rx, ry]) => ({
    c: [0, 0.008, z] as V3, u: X, v: Y, rx, ry, w: [["spine_03", 0.4], ["neck", 0.6]] as W })), seg);

  // ---------------------------------------------------------------- Bastion: pakol, scarf
  const pak: Array<[number, number, number]> = [[1.712, 0.083, 0.097], [1.722, 0.094, 0.108], [1.742, 0.096, 0.11], [1.756, 0.088, 0.102],
    [1.76, 0.091, 0.105], [1.782, 0.09, 0.103], [1.79, 0.07, 0.08], [1.794, 0.004, 0.004]];
  part("d:wool").loft(pak.filter((_, i) => fine || i !== 3).map(([z, rx, ry]) => ({ c: [0, -0.01, z] as V3, u: X, v: Y, rx, ry, w: HEAD, n: 2.2 })), seg);
  part("d:shemagh_grey").loft([[1.42, 0.13, 0.1], [1.45, 0.1, 0.092], [1.49, 0.074, 0.074]].map(([z, rx, ry]) => ({
    c: [0, 0.004, z] as V3, u: X, v: Y, rx, ry, w: [["spine_03", 0.5], ["neck", 0.5]] as W })), seg);
  part("d:shemagh_grey").box([0.06, 0.13, 1.33], X, Y, Z, [0.035, 0.008, 0.1], S3);                  // the loose end over the chest

  // ---------------------------------------------------------------- Vanguard: plate carrier and pouches
  part("a:kit_vest").box([0, 0.135, 1.27], X, Y, Z, [0.13, 0.024, 0.15], S3);
  part("a:kit_vest").box([0, -0.128, 1.28], X, Y, Z, [0.13, 0.02, 0.155], S3);
  part("a:kit_vest").loft([1.1, 1.19].map((z) => ({ c: [0, 0.006, z] as V3, u: X, v: Y, rx: 0.172, ry: 0.138,
    w: [["spine_02", 0.5], ["spine_03", 0.5]] as W, n: 3.2 })), seg);
  for (const sx of [-1, 1]) part("a:kit_vest").box([sx * 0.095, 0.004, 1.43], X, Y, Z, [0.032, 0.13, 0.014], S3);   // shoulder straps (inside the plates' sides)
  for (const x of fine ? [-0.084, 0, 0.084] : [-0.07, 0.07]) {
    part("a:kit_vest").box([x, 0.172, 1.2], X, Y, Z, [0.034, 0.022, 0.06], S3);                     // mag pouches
    if (fine) part("a:gun_metal").box([x, 0.172, 1.268], X, Y, Z, [0.022, 0.012, 0.01], S3);        // the mags in the pouches
  }
  if (mid) {
    part("a:kit_vest").box([0, 0.165, 1.35], X, Y, Z, [0.08, 0.012, 0.045], S3);                    // admin pouch
    part("a:kit_vest").box([0, -0.16, 1.27], X, Y, Z, [0.105, 0.03, 0.15], S3);                     // hydration pack
    part("a:kit_vest").box([-0.11, -0.15, 1.17], X, Y, Z, [0.032, 0.025, 0.06], S3);               // radio
    part("a:rubber").box([-0.11, -0.15, 1.36], X, Y, Z, [0.004, 0.004, 0.13], S3);                 // antenna
  }

  // ---------------------------------------------------------------- Bastion: chest rig, field jacket
  part("d:kit_vest").box([0, 0.142, 1.17], X, Y, Z, [0.145, 0.026, 0.075], S3);
  for (const x of mid ? [-0.093, -0.031, 0.031, 0.093] : [-0.06, 0.06]) {
    part("d:kit_vest").box([x, 0.172, 1.19], X, Y, Z, [0.027, 0.016, 0.072], S3);                   // curved AK mag pouches
    if (fine) part("d:kit_vest").box([x, 0.172, 1.27], X, Y, Z, [0.029, 0.018, 0.01], S3);          // pouch flaps
  }
  for (const sx of [-1, 1]) {
    part("d:kit_vest").box([sx * 0.09, 0.125, 1.33], X, Y, Z, [0.018, 0.008, 0.094], S3);             // straps up the chest,
    part("d:kit_vest").box([sx * 0.09, 0.0, 1.43], X, Y, Z, [0.015, 0.12, 0.008], S3);              // over the shoulders,
    const d = vnorm([sx * 0.6, 0, 1]);
    part("d:kit_vest").box([0, -0.122, 1.29], vcross(Y, d), Y, d, [0.018, 0.008, 0.16], S3);        // and crossed on the back
  }
  // the jacket's hem flares over the belt; side pockets
  part("d:kit_uniform").loft([0.86, 0.82, 0.79].map((z, i) => ({ c: [0, 0.002, z] as V3, u: X, v: Y, rx: [0.172, 0.18, 0.182][i],
    ry: [0.126, 0.132, 0.134][i], w: PELV, n: 2.6 })), seg);
  if (mid) for (const sx of [-1, 1]) part("d:kit_uniform").box([sx * 0.11, 0.122, 0.86], X, Y, Z, [0.045, 0.012, 0.045], PELV);

  // ---------------------------------------------------------------- belt
  part("rubber").loft([0.9, 0.95].map((z) => ({ c: [0, 0, z] as V3, u: X, v: Y, rx: 0.172, ry: 0.124, w: PELV, n: 2.6 })), seg);
  part("steel").box([0, 0.125, 0.925], X, Y, Z, [0.024, 0.006, 0.018], PELV);
  if (mid) {
    part("a:kit_vest").box([0.14, 0.06, 0.9], X, Y, Z, [0.03, 0.03, 0.05], PELV);                  // dump pouch / holster
    part("d:kit_vest").box([-0.14, 0.05, 0.9], X, Y, Z, [0.028, 0.026, 0.045], PELV);             // canteen pouch
  }

  for (const [s, sx] of [["l", -1], ["r", 1]] as const) {
    // ---------------------------------------------------------------- arms and sleeves
    const sh = pos(`upperarm_${s}`), el = pos(`lowerarm_${s}`), wr = pos(`hand_${s}`);
    const ux = axis(`upperarm_${s}`, 0), uz = axis(`upperarm_${s}`, 2), fx = axis(`lowerarm_${s}`, 0), fz = axis(`lowerarm_${s}`, 2);
    const arm: Ring[] = [
      { c: lerp3(sh, pos(`clavicle_${s}`), 0.25), u: ux, v: uz, rx: 0.07, ry: 0.072, w: [[`clavicle_${s}`, 0.4], [`upperarm_${s}`, 0.6]] },
      { c: lerp3(sh, el, 0.15), u: ux, v: uz, rx: 0.068, ry: 0.066, w: [[`upperarm_${s}`, 1]] },
      { c: lerp3(sh, el, 0.55), u: ux, v: uz, rx: 0.06, ry: 0.058, w: [[`upperarm_${s}`, 1]] },
      { c: el, u: ux, v: uz, rx: 0.052, ry: 0.052, w: [[`upperarm_${s}`, 0.5], [`lowerarm_${s}`, 0.5]] },
      { c: lerp3(el, wr, 0.35), u: fx, v: fz, rx: 0.05, ry: 0.046, w: [[`lowerarm_${s}`, 1]] },
      { c: lerp3(el, wr, 0.84), u: fx, v: fz, rx: 0.041, ry: 0.037, w: [[`lowerarm_${s}`, 0.8], [`hand_${s}`, 0.2]] },
    ];
    part("kit_uniform").loft(arm, seg, true, false);
    // cuff, shoulder pocket and flag-patch panel
    part("kit_uniform").loft([0.8, 0.88].map((tt) => ({ c: lerp3(el, wr, tt), u: fx, v: fz, rx: 0.045, ry: 0.041,
      w: [[`lowerarm_${s}`, 1]] as W })), seg);
    if (mid) {
      const ay = axis(`upperarm_${s}`, 1);
      const out = vnorm(vcross(ay, Y));
      part("kit_uniform").box(vadd(lerp3(sh, el, 0.35), vscale(out, -sx * 0.058)), out, ay, vcross(out, ay), [0.012, 0.045, 0.035],
        [[`upperarm_${s}`, 1]]);
    }
    // hands: palm, four fingers as one mitt along the finger bones, thumb
    const hy = axis(`hand_${s}`, 1), hx = axis(`hand_${s}`, 0), hz = axis(`hand_${s}`, 2);
    part("kit_hands").loft([-0.01, 0.03, 0.07, 0.09].map((d, i) => ({
      c: vadd(wr, vscale(hy, d)), u: hx, v: hz, rx: [0.036, 0.042, 0.044, 0.042][i], ry: [0.028, 0.022, 0.018, 0.016][i],
      w: [[`hand_${s}`, 1]] as W, n: 2.4,
    })), Math.max(6, seg - 4), false, false);
    const f1 = pos(`fingers_01_${s}`), f2 = pos(`fingers_02_${s}`), f3 = pos(`fingers_03_${s}`), i1 = pos(`index_01_${s}`);
    const fc = (p: V3) => vadd(p, vscale(vsub(i1, f1), 0.5));
    part("kit_hands").loft([
      { c: fc(lerp3(wr, f1, 0.85)), u: hx, v: hz, rx: 0.042, ry: 0.015, w: [[`hand_${s}`, 0.5], [`fingers_01_${s}`, 0.5]], n: 2.6 },
      { c: fc(f2), u: hx, v: hz, rx: 0.04, ry: 0.013, w: [[`fingers_01_${s}`, 0.4], [`index_02_${s}`, 0.3], [`fingers_02_${s}`, 0.3]], n: 2.6 },
      { c: fc(f3), u: hx, v: hz, rx: 0.037, ry: 0.012, w: [[`fingers_02_${s}`, 0.5], [`index_03_${s}`, 0.5]], n: 2.6 },
      { c: fc(vadd(f3, vscale(hy, 0.022))), u: hx, v: hz, rx: 0.032, ry: 0.01, w: [[`fingers_03_${s}`, 1]], n: 2.6 },
    ], Math.max(6, seg - 4), false, true);
    const t1 = pos(`thumb_01_${s}`), t3 = pos(`thumb_03_${s}`);
    part("kit_hands").loft([
      { c: t1, u: hx, v: hz, rx: 0.014, ry: 0.013, w: [[`thumb_01_${s}`, 1]] },
      { c: pos(`thumb_02_${s}`), u: hx, v: hz, rx: 0.012, ry: 0.011, w: [[`thumb_02_${s}`, 1]] },
      { c: vadd(t3, vscale(vnorm(vsub(t3, t1)), 0.018)), u: hx, v: hz, rx: 0.01, ry: 0.009, w: [[`thumb_03_${s}`, 1]] },
    ], 6, false, true);

    // ---------------------------------------------------------------- legs (trousers), pockets, pads, boots
    const hip = pos(`thigh_${s}`), kn = pos(`calf_${s}`), an = pos(`foot_${s}`);
    const leg: Ring[] = [
      { c: vadd(hip, [0, 0, 0.04]), u: X, v: Y, rx: 0.1, ry: 0.102, w: [["pelvis", 0.5], [`thigh_${s}`, 0.5]] },
      { c: lerp3(hip, kn, 0.3), u: X, v: Y, rx: 0.092, ry: 0.094, w: [[`thigh_${s}`, 1]] },
      { c: lerp3(hip, kn, 0.75), u: X, v: Y, rx: 0.073, ry: 0.076, w: [[`thigh_${s}`, 1]] },
      { c: kn, u: X, v: Y, rx: 0.065, ry: 0.068, w: [[`thigh_${s}`, 0.5], [`calf_${s}`, 0.5]] },
      { c: lerp3(kn, an, 0.35), u: X, v: Y, rx: 0.066, ry: 0.07, w: [[`calf_${s}`, 1]] },
      { c: lerp3(kn, an, 0.72), u: X, v: Y, rx: 0.056, ry: 0.06, w: [[`calf_${s}`, 1]] },
    ];
    part("kit_uniform").loft(leg, seg, false, false);
    // cargo pocket on the outside of the thigh, with its flap
    const pk = lerp3(hip, kn, 0.5);
    part("kit_uniform").box(vadd(pk, [sx * 0.086, 0.012, 0]), X, Y, Z, [0.014, 0.05, 0.065], [[`thigh_${s}`, 1]]);
    if (mid) part("kit_uniform").box(vadd(pk, [sx * 0.092, 0.012, 0.062]), X, Y, Z, [0.012, 0.054, 0.012], [[`thigh_${s}`, 1]]);
    // knee pads (Vanguard)
    part("a:kit_vest").box(vadd(kn, [0, 0.064, 0.005]), X, Y, Z, [0.05, 0.018, 0.064], [[`calf_${s}`, 0.6], [`thigh_${s}`, 0.4]]);
    if (mid) part("a:rubber").box(vadd(kn, [0, 0.083, 0.012]), X, Y, Z, [0.038, 0.006, 0.042], [[`calf_${s}`, 0.6], [`thigh_${s}`, 0.4]]);
    // boots: shaft to mid-calf, the foot, toe cap, sole and heel, laces
    const fy = axis(`foot_${s}`, 1);
    part("kit_boots").loft([
      { c: lerp3(kn, an, 0.62), u: X, v: Y, rx: 0.062, ry: 0.066, w: [[`calf_${s}`, 1]] },
      { c: vadd(an, [0, 0, 0.06]), u: X, v: Y, rx: 0.054, ry: 0.058, w: [[`calf_${s}`, 0.5], [`foot_${s}`, 0.5]] },
      { c: vadd(an, [0, 0, -0.02]), u: X, v: Y, rx: 0.054, ry: 0.064, w: [[`foot_${s}`, 1]] },
    ], seg, false, false);
    const up = vcross(X, fy);
    part("kit_boots").box(vadd(vadd(an, vscale(fy, 0.06)), [0, 0, -0.04]), X, fy, up, [0.05, 0.1, 0.036], [[`foot_${s}`, 0.6], [`toe_${s}`, 0.4]]);
    part("kit_boots").box(vadd(vadd(an, vscale(fy, 0.15)), [0, 0, -0.047]), X, fy, up, [0.046, 0.03, 0.026], [[`toe_${s}`, 1]]);
    part("rubber").box(vadd(vadd(an, vscale(fy, 0.055)), [0, 0, -0.079]), X, fy, up, [0.054, 0.132, 0.008], [[`foot_${s}`, 0.6], [`toe_${s}`, 0.4]]);
    if (mid) for (let k = 0; k < 4; k++) {
      part("rubber").box(vadd(an, [0, 0.055 + k * 0.012, 0.03 - k * 0.022]), X, Y, Z, [0.03, 0.004, 0.003], [[`foot_${s}`, 1]]);
    }
  }
  return parts;
}

/** The soldier GLB: three LOD meshes skinned to the game skeleton (flat joint nodes in rest pose). */
export function soldierGlb(): Uint8Array {
  const g = new GltfBuilder();
  const joints = BONES.map((b, i) => g.node(b.name, null, [], null, null, Array.from(REST_WORLD[i] as M4)));
  const ibm = new Float32Array(N_BONES * 16);
  INV_BIND.forEach((m, i) => ibm.set(m as ArrayLike<number>, i * 16));
  const skin = g.skin(joints, g.accessor(ibm, 16, null));
  const lods = [14, 9, 6].map((seg, level) => {
    const prims: unknown[] = [];
    for (const [mat, p] of [...body(seg).entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      prims.push(g.skinnedPrimitive(Float32Array.from(p.p), p.normals(), Float32Array.from(p.uv), Uint16Array.from(p.j), Float32Array.from(p.w),
        p.count > 65535 ? Uint32Array.from(p.idx) : Uint16Array.from(p.idx), mat));
    }
    return g.node(`soldier_lod${level}`, g.mesh(`soldier_lod${level}`, prims), [], { lod: level }, null, null, skin);
  });
  g.zupRoot("soldier", [...joints, ...lods], { joints: N_BONES });
  return g.toGlb();
}
