// Procedural, tileable PBR textures. Every map tiles seamlessly because
// all noise is built from periodic primitives:
// * fbm: spectral synthesis, random-phase white noise shaped by a 1/f^beta power spectrum and inverse-FFT'd;
// * worley: cellular noise on a wrapped jittered grid (F1, F2, cell id);
// * patterns: bricks, planks, tiles, corrugation, diamond plate computed from UVs, perturbed with noise.
// Generators return linear arrays in [0, 1] (albedo sRGB-encoded); the normal map comes from the height
// field (OpenGL convention, +Y = +V). Array row j is v = (j + 0.5) / size.

import { Random } from "../../shared/src/rng";

type A = Float32Array;
type RGB = [number, number, number];

// ------------------------------------------------------------------ FFT
class FFT {
  n: number;
  private cos: Float64Array;
  private sin: Float64Array;
  private rev: Uint32Array;

  constructor(n: number) {
    this.n = n;
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos(2 * Math.PI * i / n);
      this.sin[i] = Math.sin(2 * Math.PI * i / n);
    }
    const bits = Math.log2(n);
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
  }

  /** In-place complex FFT of (re, im) at offset with stride; inverse uses +i and no scaling. */
  run(re: Float64Array, im: Float64Array, off: number, stride: number, inverse: boolean, tr: Float64Array, ti: Float64Array): void {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      tr[j] = re[off + i * stride];
      ti[j] = im[off + i * stride];
    }
    const sgn = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let s = 0; s < n; s += size) {
        for (let k = 0; k < half; k++) {
          const c = this.cos[k * step], si = sgn * this.sin[k * step];
          const a = s + k, b = a + half;
          const xr = tr[b] * c - ti[b] * si, xi = tr[b] * si + ti[b] * c;
          tr[b] = tr[a] - xr; ti[b] = ti[a] - xi;
          tr[a] += xr; ti[a] += xi;
        }
      }
    }
    for (let i = 0; i < n; i++) {
      re[off + i * stride] = tr[i];
      im[off + i * stride] = ti[i];
    }
  }

  run2d(re: Float64Array, im: Float64Array, inverse: boolean): void {
    const n = this.n;
    const tr = new Float64Array(n), ti = new Float64Array(n);
    for (let y = 0; y < n; y++) this.run(re, im, y * n, 1, inverse, tr, ti);
    for (let x = 0; x < n; x++) this.run(re, im, x, n, inverse, tr, ti);
  }
}

// ---------------------------------------------------------------- TexGen
export class TexGen {
  n: number;
  rng: Random;
  u: A;
  v: A;
  private fft: FFT;
  private freq: Float64Array;

  constructor(size: number, seed: number) {
    this.n = size;
    this.rng = new Random(seed);
    const n = size;
    this.u = new Float32Array(n * n);
    this.v = new Float32Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      this.u[y * n + x] = (x + 0.5) / n;
      this.v[y * n + x] = (y + 0.5) / n;
    }
    this.fft = new FFT(n);
    this.freq = new Float64Array(n);
    for (let i = 0; i < n; i++) this.freq[i] = i < n / 2 ? i : i - n;
  }

  get size2(): number { return this.n * this.n; }
  zeros(): A { return new Float32Array(this.size2); }
  full(v: number): A { return new Float32Array(this.size2).fill(v); }
  map(f: (i: number) => number): A {
    const out = new Float32Array(this.size2);
    for (let i = 0; i < out.length; i++) out[i] = f(i);
    return out;
  }

  /** Tileable fractal noise, zero mean / unit std. beta: spectral slope; fmin/fmax: band limits in cycles
   * per texture; aniso: stretch (sx > sy gives streaks along u). */
  fbm(beta = 2.0, fmin = 1.0, fmax: number | null = null, aniso: [number, number] = [1, 1]): A {
    const n = this.n;
    const [sx, sy] = aniso;
    const re = new Float64Array(n * n), im = new Float64Array(n * n);
    for (let y = 0; y < n; y++) {
      const fy = this.freq[y] / sy;
      for (let x = 0; x < n; x++) {
        const fx = this.freq[x] / sx;
        let f = Math.sqrt(fx * fx + fy * fy);
        if (x === 0 && y === 0) continue;
        if (f < fmin) continue;
        let amp = f ** (-beta / 2);
        if (fmax !== null) amp *= Math.min(1, Math.max(0, (fmax * 1.25 - f) / (fmax * 0.25)));
        if (amp === 0) { f = 0; continue; }
        const ph = this.rng.random() * 2 * Math.PI;
        re[y * n + x] = amp * Math.cos(ph);
        im[y * n + x] = amp * Math.sin(ph);
      }
    }
    this.fft.run2d(re, im, true);
    const out = new Float32Array(n * n);
    let mean = 0;
    for (let i = 0; i < out.length; i++) mean += re[i];
    mean /= out.length;
    let v2 = 0;
    for (let i = 0; i < out.length; i++) { const d = re[i] - mean; v2 += d * d; }
    const std = Math.sqrt(v2 / out.length);
    const k = std > 1e-12 ? 1 / std : 1;
    for (let i = 0; i < out.length; i++) out[i] = (re[i] - mean) * k;
    return out;
  }

  /** Wrapped cellular noise: [F1, F2, cell id] with distances in cell units. */
  worley(cells: number, jitter = 0.9): [A, A, Int32Array] {
    const n = this.n;
    const px = new Float32Array(cells * cells), py = new Float32Array(cells * cells);
    for (let i = 0; i < cells * cells; i++) {
      px[i] = (this.rng.random() - 0.5) * jitter + 0.5;
      py[i] = (this.rng.random() - 0.5) * jitter + 0.5;
    }
    const f1 = new Float32Array(n * n), f2 = new Float32Array(n * n), cid = new Int32Array(n * n);
    for (let y = 0; y < n; y++) {
      const gy = (y + 0.5) / n * cells, iy = Math.floor(gy), fy = gy - iy;
      for (let x = 0; x < n; x++) {
        const gx = (x + 0.5) / n * cells, ix = Math.floor(gx), fx = gx - ix;
        let d1 = 10, d2 = 10, id = 0;
        for (let oy = -1; oy <= 1; oy++) {
          const cy = ((iy + oy) % cells + cells) % cells;
          for (let ox = -1; ox <= 1; ox++) {
            const cx = ((ix + ox) % cells + cells) % cells;
            const k = cy * cells + cx;
            const dx = ox + px[k] - fx, dy = oy + py[k] - fy;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < d1) { d2 = d1; d1 = d; id = k; } else if (d < d2) d2 = d;
          }
        }
        const i = y * n + x;
        f1[i] = d1; f2[i] = d2; cid[i] = id;
      }
    }
    return [f1, f2, cid];
  }

  /** Tileable Gaussian blur (sigma in pixels) via FFT. */
  blur(img: A, sigma: number): A {
    if (sigma <= 0) return img;
    const n = this.n;
    const re = new Float64Array(n * n), im = new Float64Array(n * n);
    for (let i = 0; i < re.length; i++) re[i] = img[i];
    this.fft.run2d(re, im, false);
    for (let y = 0; y < n; y++) {
      const fy = this.freq[y] / n;
      for (let x = 0; x < n; x++) {
        const fx = this.freq[x] / n;
        const k = Math.exp(-2 * Math.PI * Math.PI * sigma * sigma * (fx * fx + fy * fy));
        re[y * n + x] *= k;
        im[y * n + x] *= k;
      }
    }
    this.fft.run2d(re, im, true);
    const out = new Float32Array(n * n);
    const s = 1 / (n * n);
    for (let i = 0; i < out.length; i++) out[i] = re[i] * s;
    return out;
  }

  /** Domain-warp by per-pixel offsets (in texture units), wrapped. */
  warp(img: A, du: A, dv: A): A {
    const n = this.n;
    const out = new Float32Array(n * n);
    for (let i = 0; i < out.length; i++) {
      const x = (((this.u[i] + du[i]) * n - 0.5) % n + n) % n;
      const y = (((this.v[i] + dv[i]) * n - 0.5) % n + n) % n;
      const x0 = Math.floor(x), y0 = Math.floor(y);
      const tx = x - x0, ty = y - y0;
      const x1 = (x0 + 1) % n, y1 = (y0 + 1) % n;
      const a = img[y0 * n + x0] * (1 - tx) + img[y0 * n + x1] * tx;
      const b = img[y1 * n + x0] * (1 - tx) + img[y1 * n + x1] * tx;
      out[i] = a * (1 - ty) + b * ty;
    }
    return out;
  }

  /** Tangent-space normal (OpenGL +Y) from height, encoded to [0, 1] (3 channels). */
  normalFromHeight(h: A, strength: number): A {
    const n = this.n;
    const scale = strength * n / 256;
    const out = new Float32Array(n * n * 3);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const xp = (x + 1) % n, xm = (x - 1 + n) % n, yp = (y + 1) % n, ym = (y - 1 + n) % n;
      const dx = (h[y * n + xp] - h[y * n + xm]) * 0.5 * scale;
      const dy = (h[yp * n + x] - h[ym * n + x]) * 0.5 * scale;
      const l = Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y * n + x) * 3;
      out[i] = -dx / l * 0.5 + 0.5;
      out[i + 1] = -dy / l * 0.5 + 0.5;
      out[i + 2] = 1 / l * 0.5 + 0.5;
    }
    return out;
  }

  /** Cheap AO: points below their blurred neighbourhood are occluded. */
  cavity(h: A, sigma: number, strength: number): A {
    const b = this.blur(h, sigma);
    return this.map((i) => sat(1 - (b[i] - h[i]) * strength));
  }
}

export const sat = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smooth = (e0: number, e1: number, x: number) => {
  const t = sat((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const remap = (x: number, lo: number, hi: number) => lo + (hi - lo) * x;
const fract = (x: number) => x - Math.floor(x);
const pmod = (x: number, m: number) => ((x % m) + m) % m;
/** numpy's (sin(x) * k) % 1.0 (always in [0, 1)). */
const hashv = (x: number, k: number) => pmod(Math.sin(x) * k, 1.0);

function rgb(c: number[] | undefined, d: RGB): RGB {
  const v = (c ?? d) as RGB;
  return Math.max(...v) > 1 ? [v[0] / 255, v[1] / 255, v[2] / 255] : [v[0], v[1], v[2]];
}

/** Albedo buffer helpers (3 floats per pixel). */
class Col {
  constructor(public a: A) {}
  static fill(n: number, c: RGB): Col {
    const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = c[0]; a[i * 3 + 1] = c[1]; a[i * 3 + 2] = c[2]; }
    return new Col(a);
  }
  static tint(n: number, base: RGB, variation: A, amount = 1): Col {
    const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const k = 1 + amount * variation[i];
      a[i * 3] = base[0] * k; a[i * 3 + 1] = base[1] * k; a[i * 3 + 2] = base[2] * k;
    }
    return new Col(a);
  }
  /** this = this * (1 - t) + other(i) * t */
  mix(t: (i: number) => number, other: (i: number, c: number) => number): void {
    const n = this.a.length / 3;
    for (let i = 0; i < n; i++) {
      const w = t(i);
      if (w === 0) continue;
      for (let c = 0; c < 3; c++) this.a[i * 3 + c] = this.a[i * 3 + c] * (1 - w) + other(i, c) * w;
    }
  }
  scale(f: (i: number, c: number) => number): void {
    const n = this.a.length / 3;
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) this.a[i * 3 + c] *= f(i, c);
  }
  get(i: number, c: number): number { return this.a[i * 3 + c]; }
}

export interface Maps { albedo: A; height: A; roughness: A; metallic: A; ao: A }
/* eslint-disable @typescript-eslint/no-explicit-any */
type Params = Record<string, any>;

// ============================================================ generators
function genConcrete(g: TexGen, p: Params): Maps {
  const N = g.size2;
  const base = rgb(p.color, [150, 148, 142]);
  const large = g.fbm(2.4, 1, 24), mid = g.fbm(2.0, 8, 128), fine = g.fbm(1.2, 64);
  const st = g.fbm(2.6, 1, 16);
  const stains = g.map((i) => sat(smooth(0.4, 1.6, st[i]) * (p.stains ?? 0.5) * 1.6));
  const col = Col.tint(N, base, g.map((i) => large[i] * 0.07 + mid[i] * 0.04 + fine[i] * 0.03));
  const stainCol = [base[0] * 0.78, base[1] * 0.74, base[2] * 0.68];
  col.mix((i) => stains[i] * 0.7, (i, c) => stainCol[c] * (1 + 0.05 * mid[i]));
  const [f1] = g.worley(Math.trunc(48 * (p.pore_scale ?? 1.0)), 1.0);
  const pm = g.fbm(2.0, 2, 32);
  const pore = g.map((i) => smooth(0.16, 0.05, f1[i]) * (pm[i] > -0.2 ? 1 : 0) * (p.pores ?? 0.5));
  const [c1, c2] = g.worley(6, 1.0);
  const edge = g.map((i) => c2[i] - c1[i]);
  const cz = g.fbm(2.5, 1, 8);
  const zone = g.map((i) => smooth(0.3, 1.4, cz[i]) * (p.cracks ?? 0.3) * 2.0);
  const w1 = g.fbm(2.0, 4, 64), w2 = g.fbm(2.0, 4, 64);
  const we = g.warp(edge, g.map((i) => w1[i] * 0.004), g.map((i) => w2[i] * 0.004));
  const cracks = g.map((i) => sat(smooth(0.035, 0.0, we[i]) * zone[i]));
  const height = g.map((i) => 0.5 + mid[i] * 0.06 + fine[i] * 0.05 + large[i] * 0.03 - pore[i] * 0.35 - cracks[i] * 0.4);
  col.scale((i) => (1 - 0.45 * pore[i]) * (1 - 0.6 * cracks[i]));
  const [rlo, rhi] = p.roughness ?? [0.72, 0.95];
  const rough = g.map((i) => remap(sat(0.5 + fine[i] * 0.15 + mid[i] * 0.15 - stains[i] * 0.25), rlo, rhi));
  const cav = g.cavity(height, 3.0, 4.0);
  const ao = g.map((i) => cav[i] * (1 - 0.3 * pore[i]));
  return { albedo: col.a, height, roughness: rough, metallic: g.zeros(), ao };
}

function genAsphalt(g: TexGen, p: Params): Maps {
  const N = g.size2;
  const base = rgb(p.color, [52, 52, 55]);
  const [f1, , cid] = g.worley(110, 1.0);
  const sv = g.map((i) => hashv(cid[i] * 12.9898, 43758.5453));
  const stones = g.map((i) => smooth(0.55, 0.25, f1[i]));
  const large = g.fbm(2.4, 1, 16), fine = g.fbm(1.0, 128);
  const col = Col.tint(N, base, g.map((i) => large[i] * 0.08 + fine[i] * 0.05));
  const lo = [0.30, 0.30, 0.31], hi = [0.62, 0.60, 0.56];
  col.mix((i) => stones[i] * sat(sv[i] + 0.3) * 0.65, (i, c) => { const t = sv[i] ** 3; return lo[c] * (1 - t) + hi[c] * t; });
  const [c1, c2] = g.worley(5, 1.0);
  const w1 = g.fbm(2, 4, 64), w2 = g.fbm(2, 4, 64), cz = g.fbm(2.4, 1, 8);
  const we = g.warp(g.map((i) => c2[i] - c1[i]), g.map((i) => w1[i] * 0.006), g.map((i) => w2[i] * 0.006));
  const cracks = g.map((i) => sat(smooth(0.03, 0.0, we[i]) * smooth(0.2, 1.2, cz[i]) * (p.cracks ?? 0.5) * 2));
  const wn = g.fbm(2.8, 1, 8);
  const wear = g.map((i) => smooth(-0.2, 1.4, wn[i]));
  col.scale((i) => (1 + 0.15 * wear[i]) * (1 - 0.7 * cracks[i]));
  const height = g.map((i) => 0.5 + stones[i] * 0.25 * sv[i] + fine[i] * 0.05 - cracks[i] * 0.5);
  const rough = g.map((i) => sat(0.88 - stones[i] * sv[i] * 0.18 - wear[i] * 0.08 + fine[i] * 0.04));
  return { albedo: col.a, height, roughness: rough, metallic: g.zeros(), ao: g.cavity(height, 2.0, 5.0) };
}

function genGravel(g: TexGen, p: Params): Maps {
  const N = g.size2;
  const base = rgb(p.color, [112, 98, 80]);
  const height = g.full(0.3);
  const a1 = g.fbm(2.2, 1, 32), a2 = g.fbm(1.0, 64);
  const col = Col.tint(N, base, g.map((i) => a1[i] * 0.12 + a2[i] * 0.06));
  for (const [cells] of [[22, 0.9], [40, 0.8], [70, 0.6]]) {
    const [f1, , cid] = g.worley(cells, 1.0);
    const fn = g.fbm(1.0, 128);
    for (let i = 0; i < N; i++) {
      const val = hashv(cid[i] * 78.233 + cells, 43758.5453);
      const dome = sat(1 - (f1[i] / 0.48) ** 2);
      const mask = dome * (val < (p.density ?? 0.75) ? 1 : 0);
      const h = Math.sqrt(dome) * mask * (0.5 + 0.5 * val);
      if (h > height[i]) {
        height[i] = h;
        const t = sat(dome * 3);
        const k = (0.6 + 0.6 * val) * (1 + 0.08 * fn[i]);
        const stone = [0.55 * k, 0.52 * k, 0.48 * k];
        for (let c = 0; c < 3; c++) col.a[i * 3 + c] = col.a[i * 3 + c] * (1 - t) + stone[c] * t;
      }
    }
  }
  const fine = g.fbm(1.2, 64);
  for (let i = 0; i < N; i++) height[i] += fine[i] * 0.03;
  const rough = g.map((i) => sat(0.93 - height[i] * 0.12));
  return { albedo: col.a, height, roughness: rough, metallic: g.zeros(), ao: g.cavity(height, 4.0, 3.0) };
}

function genDirt(g: TexGen, p: Params): Maps {
  const N = g.size2;
  const base = rgb(p.color, [104, 88, 66]);
  const large = g.fbm(2.3, 1, 16), mid = g.fbm(1.8, 8, 96), fine = g.fbm(1.0, 96);
  const col = Col.tint(N, base, g.map((i) => large[i] * 0.06 + mid[i] * 0.05 + fine[i] * 0.05));
  const dry = g.map((i) => smooth(-0.5, 1.5, large[i]));
  const k = [1.12, 1.08, 1.03];
  col.mix((i) => dry[i] * 0.5, (i, c) => col.get(i, c) * k[c]);
  const [f1, , cid] = g.worley(60, 1.0);
  const val = g.map((i) => hashv(cid[i] * 3.7, 9123.3));
  const pebble = g.map((i) => sat(1 - (f1[i] / 0.35) ** 2) * (val[i] > 0.72 ? 1 : 0));
  const pc = [0.5, 0.47, 0.42];
  col.mix((i) => pebble[i] * 0.8, (i, c) => pc[c] * (0.7 + 0.5 * val[i]));
  const height = g.map((i) => 0.45 + mid[i] * 0.08 + fine[i] * 0.06 + large[i] * 0.05 + pebble[i] * 0.3);
  const rough = g.map((i) => sat(0.9 + fine[i] * 0.04 - (1 - dry[i]) * 0.06));
  return { albedo: col.a, height, roughness: rough, metallic: g.zeros(), ao: g.cavity(height, 3.0, 4.0) };
}

function genBrick(g: TexGen, p: Params): Maps {
  const N = g.size2;
  const courses = Math.trunc(p.courses ?? 16), perRow = Math.trunc(p.bricks_per_row ?? 5);
  const mortar = p.mortar ?? 0.06;
  const base = rgb(p.color, [128, 62, 44]), mortarCol = rgb(p.mortar_color, [150, 146, 138]);
  const chip = g.fbm(1.6, 16, 256), surface = g.fbm(1.5, 8, 256), sootN = g.fbm(2.4, 1, 8), mN = g.fbm(1.2, 32), hN = g.fbm(1.0, 128);
  const albedo = new Float32Array(N * 3), height = g.zeros(), rough = g.zeros();
  const brickMask = g.zeros();
  const aspect = courses / perRow;
  for (let i = 0; i < N; i++) {
    const row = Math.floor(g.v[i] * courses), fv = g.v[i] * courses - row;
    const off = pmod(row, 2) * 0.5;
    const cf = g.u[i] * perRow + off, bi = Math.floor(cf), fu = cf - bi;
    const id = row * 131 + pmod(bi, perRow) * 17;
    const rnd = hashv(id * 12.9898, 43758.5453), rnd2 = hashv(id * 78.233, 12543.123);
    const edge = Math.min(Math.min(fu, 1 - fu) * aspect, Math.min(fv, 1 - fv)) + chip[i] * 0.035;
    const bm = smooth(mortar * 0.5, mortar * 0.5 + 0.06, edge);
    const bevel = smooth(mortar * 0.5, mortar * 0.5 + 0.18, edge);
    const tone = (rnd - 0.5) * 0.35, burnt = rnd2 > 0.88 ? 1 : 0;
    const soot = smooth(0.2, 1.6, sootN[i]);
    const bk = [0.55, 0.5, 0.5];
    for (let c = 0; c < 3; c++) {
      let b = base[c] * (1 + tone + 0.08 * surface[i]);
      b = b * (1 - burnt * 0.7) + b * bk[c] * burnt * 0.7;
      b *= 1 - 0.25 * soot;
      const m = mortarCol[c] * (1 + 0.08 * mN[i]);
      albedo[i * 3 + c] = m * (1 - bm) + b * bm;
    }
    brickMask[i] = bm;
    height[i] = 0.25 + bm * (0.55 + 0.25 * bevel) + surface[i] * 0.04 * bm + hN[i] * 0.02;
    rough[i] = sat(bm > 0.5 ? 0.82 + surface[i] * 0.05 : 0.95);
  }
  const cav = g.cavity(height, 4.0, 3.0);
  return { albedo, height, roughness: rough, metallic: g.zeros(), ao: g.map((i) => cav[i] * (0.75 + 0.25 * brickMask[i])) };
}

function woodGrain(g: TexGen, alongU: boolean, ringFreq: number, stretch = 12.0): [A, A] {
  const a: [number, number] = alongU ? [stretch, 1] : [1, stretch];
  const streak = g.fbm(1.6, 2, 256, a);
  const warp = g.fbm(2.2, 1, 32, a);
  const rings = g.map((i) => Math.sin(((alongU ? g.v[i] : g.u[i]) + warp[i] * 0.02) * ringFreq * 2 * Math.PI + streak[i] * 1.5) * 0.5 + 0.5);
  return [streak, rings];
}

function genPlanks(g: TexGen, p: Params): Maps {
  const N = g.size2;
  const planks = Math.trunc(p.planks ?? 8), lengths = Math.trunc(p.segments ?? 2);
  const base = rgb(p.color, [122, 88, 58]);
  const [streak, rings] = woodGrain(g, true, 30.0);
  const wn = g.fbm(2.3, 1, 12), hn = g.fbm(1.0, 128);
  const albedo = new Float32Array(N * 3), height = g.zeros(), rough = g.zeros();
  const [rlo, rhi] = p.roughness ?? [0.55, 0.85];
  const weathered = p.weathered ?? 0.5;
  for (let i = 0; i < N; i++) {
    const row = Math.floor(g.v[i] * planks), fv = g.v[i] * planks - row;
    const rr = hashv(row * 91.7, 4375.85);
    const sf = g.u[i] * lengths + rr, seg = Math.floor(sf), fu = sf - seg;
    const pid = row * 37 + pmod(seg, lengths);
    const tone = hashv(pid * 12.9898, 43758.5453) - 0.5;
    const gap = smooth(0.0, 0.035, Math.min(fv, 1 - fv)) * smooth(0.0, 0.006, Math.min(fu, 1 - fu));
    const wear = smooth(0.2, 1.5, wn[i]);
    const wk = [0.72, 0.72, 0.75];
    for (let c = 0; c < 3; c++) {
      let v = base[c] * (1 + 0.28 * tone + 0.1 * streak[i] - 0.12 * rings[i]);
      const t = wear * weathered;
      v = v * (1 - t) + v * wk[c] * t;
      albedo[i * 3 + c] = v * (0.25 + 0.75 * gap);
    }
    height[i] = 0.3 + gap * (0.6 + streak[i] * 0.03 + rings[i] * 0.02) + hn[i] * 0.01;
    rough[i] = sat(remap(sat(0.5 + streak[i] * 0.2 + wear * 0.3), rlo, rhi));
  }
  return { albedo, height, roughness: rough, metallic: g.zeros(), ao: g.cavity(height, 3.0, 3.0) };
}

function genPlywood(g: TexGen, p: Params): Maps {
  const N = g.size2;
  const base = rgb(p.color, [186, 152, 108]);
  const [streak, rings] = woodGrain(g, true, 6.0, 5.0);
  const patches = g.fbm(2.6, 1, 8);
  const [f1] = g.worley(16, 0.0);
  const [kf1, , kid] = g.worley(5, 0.9);
  const dn = g.fbm(2.2, 1, 16);
  const albedo = new Float32Array(N * 3), height = g.zeros(), rough = g.zeros();
  for (let i = 0; i < N; i++) {
    const su = pmod(g.u[i], 0.5), seamU = Math.min(su, 0.5 - su);
    const seam = smooth(0.0, 0.004, seamU);
    const holes = smooth(0.12, 0.05, f1[i]) * (seamU < 0.03 ? 1 : 0);
    const kval = hashv(kid[i] * 3.1, 999.7);
    const knots = smooth(0.12, 0.02, kf1[i]) * (kval > 0.6 ? 1 : 0);
    const dirt = smooth(0.3, 1.6, dn[i]);
    const dk = [0.7, 0.68, 0.66];
    for (let c = 0; c < 3; c++) {
      let v = base[c] * (1 + 0.12 * streak[i] - 0.1 * rings[i] + 0.06 * patches[i]);
      v *= (1 - 0.45 * knots) * (0.4 + 0.6 * seam) * (1 - 0.6 * holes);
      v = v * (1 - dirt * 0.5) + v * dk[c] * dirt * 0.5;
      albedo[i * 3 + c] = v;
    }
    height[i] = 0.5 + streak[i] * 0.02 + seam * 0.2 - holes * 0.3 - knots * 0.05;
    rough[i] = sat(0.78 + streak[i] * 0.04 + dirt * 0.08);
  }
  return { albedo, height, roughness: rough, metallic: g.zeros(), ao: g.cavity(height, 2.0, 3.0) };
}

function paintWear(g: TexGen, amount: number): [A, A] {
  const chips = g.fbm(1.9, 2, 256), lo = g.fbm(2.5, 1, 8);
  const scratches = g.fbm(1.4, 32, 512, [40, 1]);
  const mask = g.map((i) => sat(smooth(1.6 - amount * 1.2, 1.9 - amount * 1.2, chips[i] + lo[i] * 0.6)));
  const sm = g.map((i) => sat(smooth(2.4, 2.9, scratches[i]) * amount));
  return [mask, sm];
}

function genPaintedMetal(g: TexGen, p: Params): Maps {
  const N = g.size2;
  const paint = rgb(p.color, [78, 84, 58]);
  const metal = [0.56, 0.57, 0.58], rust = [0.36, 0.17, 0.08];
  const v1 = g.fbm(2.2, 1, 32), v2 = g.fbm(1.0, 128);
  const col = Col.tint(N, paint, g.map((i) => v1[i] * 0.05 + v2[i] * 0.02));
  const [chip, scratch] = paintWear(g, p.wear ?? 0.5);
  const rn = g.fbm(2.2, 1, 64);
  const rustMask = g.map((i) => sat(smooth(0.6, 1.8, rn[i]) * (p.rust ?? 0.3) * 2.5) * (chip[i] > 0.3 ? 1 : 0));
  const bare = g.map((i) => sat(chip[i] + scratch[i]));
  const m1 = g.fbm(1.0, 128), r1 = g.fbm(1.5, 32), gn = g.fbm(2.4, 2, 32), f1 = g.fbm(1.2, 64), h1 = g.fbm(1.0, 128);
  col.mix((i) => bare[i], (i, c) => metal[c] * (1 + 0.1 * m1[i]));
  col.mix((i) => rustMask[i], (i, c) => rust[c] * (1 + 0.2 * r1[i]));
  const grime = g.map((i) => smooth(0.0, 1.8, gn[i]) * 0.3);
  const gc = [0.25, 0.23, 0.2];
  col.mix((i) => grime[i], (_i, c) => gc[c]);
  const metallic = g.map((i) => sat(bare[i] * (1 - rustMask[i]) * (1 - grime[i] * 2)));
  const pr = p.paint_roughness ?? 0.55;
  const rough = g.map((i) => sat((metallic[i] > 0.5 ? 0.38 : pr) + grime[i] * 0.3 + rustMask[i] * 0.4 + f1[i] * 0.03));
  const height = g.map((i) => 0.6 - chip[i] * 0.08 - scratch[i] * 0.04 + rustMask[i] * 0.05 + h1[i] * 0.01);
  return { albedo: col.a, height, roughness: rough, metallic, ao: g.cavity(height, 2.0, 3.0) };
}

function genCorrugated(g: TexGen, p: Params): Maps {
  const N = g.size2;
  const ridges = Math.trunc(p.ridges ?? 12);
  const profile = g.map((i) => Math.sin(g.u[i] * ridges * 2 * Math.PI));
  let d: Maps;
  if (p.painted ?? true) d = genPaintedMetal(g, p);
  else {
    const n1 = g.fbm(2, 1, 64);
    d = { albedo: Col.tint(N, [0.62, 0.63, 0.64], g.map((i) => n1[i] * 0.06)).a, roughness: g.full(0.45), metallic: g.full(1), height: g.full(0.5), ao: g.full(1) };
  }
  const sn = g.fbm(2.0, 2, 128, [1, 20]);
  const streaks = g.map((i) => smooth(0.5, 2.0, sn[i]));
  for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) d.albedo[i * 3 + c] *= 1 - 0.25 * streaks[i];
  d.roughness = g.map((i) => sat(d.roughness[i] + streaks[i] * 0.15));
  const h0 = d.height;
  d.height = g.map((i) => 0.5 + 0.45 * profile[i] + h0[i] * 0.1);
  const cav = g.cavity(d.height, 2.0, 2.0);
  d.ao = g.map((i) => sat(0.75 + 0.25 * profile[i]) * cav[i]);
  return d;
}

function genDiamondPlate(g: TexGen, p: Params): Maps {
  const N = g.size2;
  const reps = Math.trunc(p.reps ?? 10);
  const bump = g.zeros();
  for (let i = 0; i < N; i++) {
    const su = g.u[i] * reps, sv = g.v[i] * reps;
    const cu = su - Math.floor(su) - 0.5, cv = sv - Math.floor(sv) - 0.5;
    const cell = pmod(Math.floor(su) + Math.floor(sv), 2);
    const a = cell > 0 ? cu + cv : cu - cv, b = cell > 0 ? cu - cv : cu + cv;
    bump[i] = Math.sqrt(sat(1 - (Math.abs(a) / 0.36) ** 2 - (Math.abs(b) / 0.09) ** 2));
  }
  const n1 = g.fbm(1.2, 32), n2 = g.fbm(2.2, 2, 32);
  const col = Col.tint(N, [0.58, 0.59, 0.60], g.map((i) => n1[i] * 0.04 + n2[i] * 0.04));
  const dn = g.fbm(2.0, 4, 64), d2 = g.fbm(1.0, 128);
  const dust = g.map((i) => sat(smooth(-0.6, 1.4, dn[i]) * (1 - bump[i]) * 0.85));
  const dc = [0.32, 0.30, 0.27];
  col.mix((i) => dust[i], (i, c) => dc[c] * (1 + 0.1 * d2[i]));
  const sc = g.fbm(1.4, 32, 512, [30, 1]), r1 = g.fbm(1.2, 64), h1 = g.fbm(1.0, 128);
  const rough = g.map((i) => sat(0.36 + dust[i] * 0.5 - bump[i] * 0.08 + smooth(2.2, 2.8, sc[i]) * 0.08 + r1[i] * 0.03));
  const metal = g.map((i) => sat(0.95 - dust[i]));
  const height = g.map((i) => 0.4 + bump[i] * 0.5 + h1[i] * 0.01);
  return { albedo: col.a, height, roughness: rough, metallic: metal, ao: g.cavity(height, 2.5, 2.5) };
}

function genPlaster(g: TexGen, p: Params): Maps {
  const N = g.size2;
  const base = rgb(p.color, [200, 194, 180]);
  const large = g.fbm(2.5, 1, 16), mid = g.fbm(2.0, 8, 128), fine = g.fbm(1.0, 128);
  const col = Col.tint(N, base, g.map((i) => large[i] * 0.04 + mid[i] * 0.02 + fine[i] * 0.015));
  const dn = g.fbm(2.6, 1, 12);
  const dirt = g.map((i) => smooth(0.3, 1.8, dn[i]) * (p.dirt ?? 0.5));
  const dk = [0.75, 0.72, 0.66];
  col.mix((i) => dirt[i], (i, c) => col.get(i, c) * dk[c]);
  const [f1, , did] = g.worley(9, 1.0);
  const dents = g.map((i) => smooth(0.18, 0.0, f1[i]) * (hashv(did[i] * 7.1, 3133.7) > 0.75 ? 1 : 0));
  col.scale((i) => 1 - 0.25 * dents[i]);
  const height = g.map((i) => 0.5 + mid[i] * 0.04 + fine[i] * 0.03 - dents[i] * 0.25);
  const rough = g.map((i) => sat(0.88 + fine[i] * 0.03 - dirt[i] * 0.05));
  return { albedo: col.a, height, roughness: rough, metallic: g.zeros(), ao: g.cavity(height, 3.0, 3.0) };
}

function genFabric(g: TexGen, p: Params): Maps {
  const N = g.size2;
  const threads = Math.trunc(p.threads ?? 96);
  const base = rgb(p.color, [150, 132, 96]);
  const weave = g.map((i) => {
    const over = pmod(Math.floor(g.u[i] * threads) + Math.floor(g.v[i] * threads), 2);
    return over > 0 ? Math.abs(Math.sin(g.v[i] * threads * 2 * Math.PI)) : Math.abs(Math.sin(g.u[i] * threads * 2 * Math.PI));
  });
  const irregular = g.fbm(1.4, 16, 256), lo = g.fbm(2.4, 1, 16);
  const col = Col.tint(N, base, g.map((i) => irregular[i] * 0.06 + lo[i] * 0.08 + (weave[i] - 0.5) * 0.12));
  const dn = g.fbm(2.4, 1, 12);
  const dirt = g.map((i) => smooth(0.2, 1.6, dn[i]) * (p.dirt ?? 0.5));
  const dk = [0.68, 0.62, 0.55];
  col.mix((i) => dirt[i], (i, c) => col.get(i, c) * dk[c]);
  const height = g.map((i) => 0.4 + weave[i] * 0.35 + irregular[i] * 0.03);
  const rough = g.map((i) => sat(0.95 - weave[i] * 0.04));
  return { albedo: col.a, height, roughness: rough, metallic: g.zeros(), ao: g.cavity(height, 1.5, 3.0) };
}

function genTiles(g: TexGen, p: Params): Maps {
  const N = g.size2;
  const count = Math.trunc(p.count ?? 4);
  const base = rgb(p.color, [150, 152, 140]), grout = rgb(p.grout_color, [90, 90, 86]);
  const n1 = g.fbm(1.5, 16), dn = g.fbm(2.4, 1, 16), gn = g.fbm(1.0, 128), hn = g.fbm(1.0, 128);
  const albedo = new Float32Array(N * 3), height = g.zeros(), rough = g.zeros();
  const tr = p.tile_roughness ?? 0.35;
  for (let i = 0; i < N; i++) {
    const su = g.u[i] * count, sv = g.v[i] * count;
    const tid = Math.floor(su) * 17 + Math.floor(sv) * 131;
    const rnd = hashv(tid * 12.9898, 43758.5453);
    const fu = fract(su), fv = fract(sv);
    const edge = Math.min(Math.min(fu, 1 - fu), Math.min(fv, 1 - fv));
    const tile = smooth(0.012, 0.03, edge), bevel = smooth(0.012, 0.06, edge);
    const dirt = smooth(0.0, 1.5, dn[i]);
    for (let c = 0; c < 3; c++) {
      let v = base[c] * (1 + (rnd - 0.5) * 0.12 + 0.04 * n1[i]);
      v = v * (1 - dirt * 0.4) + v * 0.75 * dirt * 0.4;
      const gc = grout[c] * (1 + 0.1 * gn[i]);
      albedo[i * 3 + c] = gc * (1 - tile) + v * tile;
    }
    height[i] = 0.3 + tile * (0.5 + bevel * 0.15) + hn[i] * 0.01;
    rough[i] = sat(tile > 0.5 ? tr + dirt * 0.3 : 0.9);
  }
  return { albedo, height, roughness: rough, metallic: g.zeros(), ao: g.cavity(height, 2.0, 3.0) };
}

function genBrushedMetal(g: TexGen, p: Params): Maps {
  const N = g.size2;
  const base = rgb(p.color, [150, 152, 155]);
  const brush = g.fbm(1.2, 16, 512, [60, 1]), n2 = g.fbm(2.2, 2, 32);
  const col = Col.tint(N, base, g.map((i) => brush[i] * 0.04 + n2[i] * 0.03));
  const dn = g.fbm(2.0, 4, 64);
  const dust = g.map((i) => sat(smooth(0.4, 2.2, dn[i]) * 0.6));
  const dc = [0.30, 0.28, 0.25];
  col.mix((i) => dust[i], (_i, c) => dc[c]);
  const r0 = p.roughness ?? 0.35;
  return { albedo: col.a, height: g.map((i) => 0.5 + brush[i] * 0.01), roughness: g.map((i) => sat(r0 + brush[i] * 0.04 + dust[i] * 0.45)),
    metallic: g.map((i) => sat(1 - dust[i])), ao: g.full(1) };
}

function genFlat(g: TexGen, p: Params): Maps {
  return { albedo: Col.fill(g.size2, rgb(p.color, [200, 200, 200])).a, height: g.full(0.5), roughness: g.full(p.roughness ?? 0.5),
    metallic: g.full(p.metallic ?? 0.0), ao: g.full(1) };
}

function genHazard(g: TexGen, p: Params): Maps {
  const N = g.size2;
  const stripes = Math.trunc(p.stripes ?? 4);
  const yellow = rgb(p.color, [200, 160, 20]), black = [0.04, 0.04, 0.04];
  const col = new Col(new Float32Array(N * 3));
  for (let i = 0; i < N; i++) {
    const t = pmod((g.u[i] + g.v[i]) * stripes, 1.0);
    const mask = smooth(0.48, 0.52, t) * smooth(1.0, 0.96, t);
    for (let c = 0; c < 3; c++) col.a[i * 3 + c] = yellow[c] * (1 - mask) + black[c] * mask;
  }
  const [chip, scratch] = paintWear(g, p.wear ?? 0.6);
  const under = rgb(p.under, [120, 118, 112]);
  const un = g.fbm(1.0, 64), gn = g.fbm(2.4, 1, 16);
  col.mix((i) => sat(chip[i] + scratch[i]), (i, c) => under[c] * (1 + 0.1 * un[i]));
  const grime = g.map((i) => smooth(0.0, 1.6, gn[i]) * 0.4);
  col.scale((i) => 1 - grime[i] * 0.5);
  const height = g.map((i) => 0.5 - chip[i] * 0.05);
  return { albedo: col.a, height, roughness: g.map((i) => sat(0.55 + grime[i] * 0.3 + chip[i] * 0.2)), metallic: g.zeros(), ao: g.cavity(height, 2.0, 2.0) };
}

function genPlastic(g: TexGen, p: Params): Maps {
  const N = g.size2;
  const base = rgb(p.color, [60, 62, 58]);
  const stipple = g.fbm(1.0, 128), n1 = g.fbm(2.2, 1, 16);
  const col = Col.tint(N, base, g.map((i) => n1[i] * 0.04 + stipple[i] * 0.02));
  const sn = g.fbm(1.5, 16, 256, [12, 1]);
  const scuffs = g.map((i) => smooth(2.0, 2.8, sn[i]));
  const wear = p.wear ?? 0.5;
  col.mix((i) => scuffs[i] * wear, (i, c) => col.get(i, c) * 1.35 + 0.03);
  const dn = g.fbm(2.4, 1, 16);
  const dirt = g.map((i) => smooth(0.2, 1.8, dn[i]) * 0.25);
  col.scale((i) => 1 - dirt[i] * 0.4);
  const r0 = p.roughness ?? 0.55;
  return { albedo: col.a, height: g.map((i) => 0.5 + stipple[i] * 0.06 - scuffs[i] * 0.02),
    roughness: g.map((i) => sat(r0 + stipple[i] * 0.04 + scuffs[i] * 0.15 + dirt[i] * 0.2)), metallic: g.zeros(), ao: g.full(1) };
}

function genGunmetal(g: TexGen, p: Params): Maps {
  const N = g.size2;
  const base = rgb(p.color, [52, 54, 56]);
  const grain = g.fbm(1.0, 96), n2 = g.fbm(2.2, 2, 32);
  const col = Col.tint(N, base, g.map((i) => grain[i] * 0.05 + n2[i] * 0.05));
  const wn = g.fbm(1.6, 8, 256, [6, 1]);
  const wear = g.map((i) => smooth(2.1, 2.7, wn[i]));
  const wk = p.wear ?? 0.4;
  const wc = [0.48, 0.48, 0.47];
  col.mix((i) => wear[i] * wk, (_i, c) => wc[c]);
  const r0 = p.roughness ?? 0.5, m0 = p.metallic ?? 0.8;
  return { albedo: col.a, height: g.map((i) => 0.5 + grain[i] * 0.03), roughness: g.map((i) => sat(r0 + grain[i] * 0.05 - wear[i] * 0.2)),
    metallic: g.map((i) => sat(m0 + wear[i] * 0.2)), ao: g.full(1) };
}

function genCamo(g: TexGen, p: Params): Maps {
  const N = g.size2;
  const palette: RGB[] = (p.palette ?? [[120, 112, 84], [86, 92, 62], [62, 56, 42], [150, 136, 104]]).map((c: number[]) => rgb(c, [0, 0, 0]));
  const col = Col.fill(N, palette[0]);
  palette.slice(1).forEach((c, i) => {
    const blob0 = g.fbm(2.6, 2, 24), w1 = g.fbm(2.0, 4, 64), w2 = g.fbm(2.0, 4, 64);
    const blob = g.warp(blob0, g.map((k) => w1[k] * 0.02), g.map((k) => w2[k] * 0.02));
    col.mix((k) => smooth(0.35 + 0.15 * i, 0.45 + 0.15 * i, blob[k]), (_k, ch) => c[ch]);
  });
  const threads = Math.trunc(p.threads ?? 160);
  const weave = g.map((i) => {
    const over = pmod(Math.floor(g.u[i] * threads) + Math.floor(g.v[i] * threads), 2);
    return over > 0 ? Math.abs(Math.sin(g.v[i] * threads * Math.PI)) : Math.abs(Math.sin(g.u[i] * threads * Math.PI));
  });
  const n1 = g.fbm(1.2, 32), dn = g.fbm(2.4, 1, 12);
  col.scale((i) => (0.88 + 0.12 * weave[i]) * (1 + 0.05 * n1[i]));
  const dirt = g.map((i) => smooth(0.2, 1.8, dn[i]) * (p.dirt ?? 0.4));
  const dk = [0.7, 0.65, 0.58];
  col.mix((i) => dirt[i], (i, c) => col.get(i, c) * dk[c]);
  const height = g.map((i) => 0.4 + weave[i] * 0.3);
  return { albedo: col.a, height, roughness: g.map((i) => sat(0.9 - weave[i] * 0.05)), metallic: g.zeros(), ao: g.cavity(height, 1.2, 2.0) };
}

export const GENERATORS: Record<string, (g: TexGen, p: Params) => Maps> = {
  concrete: genConcrete, asphalt: genAsphalt, gravel: genGravel, dirt: genDirt, brick: genBrick, planks: genPlanks, plywood: genPlywood,
  painted_metal: genPaintedMetal, corrugated: genCorrugated, diamond_plate: genDiamondPlate, plaster: genPlaster, fabric: genFabric,
  tiles: genTiles, brushed_metal: genBrushedMetal, flat: genFlat, hazard: genHazard, plastic: genPlastic, gunmetal: genGunmetal, camo: genCamo,
};

export interface Packed { size: number; albedo: Uint8Array; normal: Uint8Array; orm: Uint8Array }

/** A material's packed 8-bit maps: albedo RGB (sRGB), normal RGB, ORM (AO, roughness, metallic). Rows are
 * top-down in the output (row 0 = v near 1), ready for an image file. */
export function generate(kind: string, params: Params, size: number, seed: number): Packed {
  const fn = GENERATORS[kind];
  if (!fn) throw new Error(`unknown procedural material type ${kind}`);
  const g = new TexGen(size, seed);
  const d = fn(g, params);
  const normal = g.normalFromHeight(d.height, params.normal_strength ?? 6.0);
  const n = size;
  const to8 = (v: number) => Math.round(sat(v) * 255);
  const albedo = new Uint8Array(n * n * 3), nrm = new Uint8Array(n * n * 3), orm = new Uint8Array(n * n * 3);
  for (let y = 0; y < n; y++) {
    const outRow = n - 1 - y;
    for (let x = 0; x < n; x++) {
      const i = y * n + x, o = (outRow * n + x) * 3;
      for (let c = 0; c < 3; c++) {
        albedo[o + c] = to8(d.albedo[i * 3 + c]);
        nrm[o + c] = to8(normal[i * 3 + c]);
      }
      orm[o] = to8(d.ao[i]);
      orm[o + 1] = to8(Math.max(0.03, d.roughness[i]));
      orm[o + 2] = to8(d.metallic[i]);
    }
  }
  return { size, albedo, normal: nrm, orm };
}

/** Deterministic seed per material name (the original formula). */
export function seedFor(name: string): number {
  let s = 0;
  for (let i = 0; i < name.length; i++) s += (i + 1) * name.charCodeAt(i);
  return s * 7919;
}

/** Half-size box filter of an RGB8 image (1024 -> 512). */
export function downsample(rgb: Uint8Array, size: number): Uint8Array {
  const h = size / 2;
  const out = new Uint8Array(h * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < h; x++) {
    for (let c = 0; c < 3; c++) {
      const a = rgb[((2 * y) * size + 2 * x) * 3 + c], b = rgb[((2 * y) * size + 2 * x + 1) * 3 + c];
      const d = rgb[((2 * y + 1) * size + 2 * x) * 3 + c], e = rgb[((2 * y + 1) * size + 2 * x + 1) * 3 + c];
      out[(y * h + x) * 3 + c] = (a + b + d + e + 2) >> 2;
    }
  }
  return out;
}
