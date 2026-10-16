// Vectors and rotations in the game's coordinates: Z up, a character faces +Y, heading/pitch/roll in
// degrees as Panda3D defines them (a heading turns counter-clockwise seen from above). Matrices are
// row-vector 4x4s (a point moves as p * M, the translation is the last row), stored row-major.

export type V3 = [number, number, number];
export type M3 = [V3, V3, V3];

export const DEG = Math.PI / 180;

export const v3 = (x = 0, y = 0, z = 0): V3 => [x, y, z];
export const vadd = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vsub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vscale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const vdot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vcross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const vlen = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const vlen2 = (a: V3): number => a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
export const vdist = (a: ArrayLike<number>, b: ArrayLike<number>): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const vdist2d = (a: ArrayLike<number>, b: ArrayLike<number>): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const vneg = (a: V3): V3 => [-a[0], -a[1], -a[2]];
export const vcopy = (a: ArrayLike<number>): V3 => [a[0], a[1], a[2]];
export const vlerp = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const vflat = (a: V3): V3 => [a[0], a[1], 0];

export function vnorm(a: V3): V3 {
  const l = vlen(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [a[0], a[1], a[2]];
}

/** 3x3 rotation for heading/pitch/roll (rows are the local axes in world space). */
export function hprMatrix(h: number, p: number, r: number = 0): M3 {
  const ch = Math.cos(h * DEG), sh = Math.sin(h * DEG);
  const cp = Math.cos(p * DEG), sp = Math.sin(p * DEG);
  const cr = Math.cos(r * DEG), sr = Math.sin(r * DEG);
  return [
    [cr * ch - sr * sp * sh, cr * sh + sr * sp * ch, -sr * cp],
    [-cp * sh, cp * ch, sp],
    [sr * ch + cr * sp * sh, sr * sh - cr * sp * ch, cr * cp],
  ];
}

/** p * R (local -> world rotation). */
export function rotate(p: ArrayLike<number>, R: M3): V3 {
  return [
    p[0] * R[0][0] + p[1] * R[1][0] + p[2] * R[2][0],
    p[0] * R[0][1] + p[1] * R[1][1] + p[2] * R[2][1],
    p[0] * R[0][2] + p[1] * R[1][2] + p[2] * R[2][2],
  ];
}

/** R * p (world -> local for a rotation matrix: the transpose). */
export function unrotate(p: ArrayLike<number>, R: M3): V3 {
  return [vdot(p as V3, R[0]), vdot(p as V3, R[1]), vdot(p as V3, R[2])];
}

/** Heading, pitch, roll of a rotation matrix (the inverse of hprMatrix). */
export function matrixHpr(m: M3): V3 {
  const p = Math.asin(Math.max(-1, Math.min(1, m[1][2])));
  const h = Math.atan2(-m[1][0], m[1][1]);
  const r = Math.atan2(-m[0][2], m[2][2]);
  return [h / DEG, p / DEG, r / DEG];
}

/** Panda heading/pitch (degrees) -> unit forward vector. */
export function anglesToDir(yaw: number, pitch: number): V3 {
  const h = yaw * DEG;
  const p = pitch * DEG;
  const cp = Math.cos(p);
  return [-Math.sin(h) * cp, Math.cos(h) * cp, Math.sin(p)];
}

/** Heading and pitch that look along d. */
export function anglesTo(dx: number, dy: number, dz: number): [number, number] {
  return [Math.atan2(-dx, dy) / DEG, Math.atan2(dz, Math.hypot(dx, dy)) / DEG];
}

export function rightOf(yaw: number): V3 {
  const h = yaw * DEG;
  return [Math.cos(h), Math.sin(h), 0];
}

export const wrap180 = (a: number): number => ((((a + 180) % 360) + 360) % 360) - 180;
export const mod = (a: number, n: number): number => ((a % n) + n) % n;
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Python's round(): halves to even. */
export function pyRound(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

// ------------------------------------------------------------- 4x4 row-vector matrices
export type M4 = Float64Array;

export function m4(): M4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** TransformState.makePosHpr(pos, hpr).getMat() */
export function m4PosHpr(pos: ArrayLike<number>, h: number, p: number, r: number, out: M4 = new Float64Array(16)): M4 {
  const R = hprMatrix(h, p, r);
  out[0] = R[0][0]; out[1] = R[0][1]; out[2] = R[0][2]; out[3] = 0;
  out[4] = R[1][0]; out[5] = R[1][1]; out[6] = R[1][2]; out[7] = 0;
  out[8] = R[2][0]; out[9] = R[2][1]; out[10] = R[2][2]; out[11] = 0;
  out[12] = pos[0]; out[13] = pos[1]; out[14] = pos[2]; out[15] = 1;
  return out;
}

/** a * b (row vectors: apply a, then b). */
export function m4Mul(a: M4, b: M4, out: M4 = new Float64Array(16)): M4 {
  for (let i = 0; i < 4; i++) {
    const a0 = a[i * 4], a1 = a[i * 4 + 1], a2 = a[i * 4 + 2], a3 = a[i * 4 + 3];
    out[i * 4] = a0 * b[0] + a1 * b[4] + a2 * b[8] + a3 * b[12];
    out[i * 4 + 1] = a0 * b[1] + a1 * b[5] + a2 * b[9] + a3 * b[13];
    out[i * 4 + 2] = a0 * b[2] + a1 * b[6] + a2 * b[10] + a3 * b[14];
    out[i * 4 + 3] = a0 * b[3] + a1 * b[7] + a2 * b[11] + a3 * b[15];
  }
  return out;
}

export function m4Point(m: M4, p: ArrayLike<number>): V3 {
  return [
    p[0] * m[0] + p[1] * m[4] + p[2] * m[8] + m[12],
    p[0] * m[1] + p[1] * m[5] + p[2] * m[9] + m[13],
    p[0] * m[2] + p[1] * m[6] + p[2] * m[10] + m[14],
  ];
}

export function m4Vec(m: M4, p: ArrayLike<number>): V3 {
  return [
    p[0] * m[0] + p[1] * m[4] + p[2] * m[8],
    p[0] * m[1] + p[1] * m[5] + p[2] * m[9],
    p[0] * m[2] + p[1] * m[6] + p[2] * m[10],
  ];
}

/** Inverse of an affine row-vector matrix. */
export function m4InvAffine(m: M4, out: M4 = new Float64Array(16)): M4 {
  const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const inv = 1 / det;
  out[0] = A * inv; out[1] = -(b * i - c * h) * inv; out[2] = (b * f - c * e) * inv; out[3] = 0;
  out[4] = B * inv; out[5] = (a * i - c * g) * inv; out[6] = -(a * f - c * d) * inv; out[7] = 0;
  out[8] = C * inv; out[9] = -(a * h - b * g) * inv; out[10] = (a * e - b * d) * inv; out[11] = 0;
  const tx = m[12], ty = m[13], tz = m[14];
  out[12] = -(tx * out[0] + ty * out[4] + tz * out[8]);
  out[13] = -(tx * out[1] + ty * out[5] + tz * out[9]);
  out[14] = -(tx * out[2] + ty * out[6] + tz * out[10]);
  out[15] = 1;
  return out;
}
