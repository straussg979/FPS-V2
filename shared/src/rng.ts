// A port of CPython's `random.Random` (Mersenne Twister MT19937 and the methods the game uses), so a
// seeded match makes the same choices as the Python version did: the map's seeded prop jitter (crate
// stacks collide), spawn shuffles, bot traits and decisions.

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER = 0x80000000;
const LOWER = 0x7fffffff;
const TWOPI = 2 * Math.PI;
const LOG4 = Math.log(4.0);
const SG_MAGICCONST = 1.0 + Math.log(4.5);

export class Random {
  private mt = new Uint32Array(N);
  private mti = N + 1;
  private gaussNext: number | null = null;

  constructor(seed?: number | bigint | string | null) {
    this.seed(seed);
  }

  seed(seed?: number | bigint | string | null): void {
    this.gaussNext = null;
    let n: bigint;
    if (seed === undefined || seed === null) {
      n = BigInt(Math.floor(Math.random() * 2 ** 52)) ^ BigInt(Date.now());
    } else if (typeof seed === "string") {
      n = BigInt(crc32(seed)) * 2654435761n + BigInt(seed.length);
    } else if (typeof seed === "bigint") {
      n = seed;
    } else if (Number.isInteger(seed) && Math.abs(seed) <= Number.MAX_SAFE_INTEGER) {
      n = BigInt(seed);
    } else {
      n = pyHashFloat(seed);
    }
    if (n < 0n) n = -n;
    const key: number[] = [];
    if (n === 0n) key.push(0);
    while (n > 0n) {
      key.push(Number(n & 0xffffffffn));
      n >>= 32n;
    }
    this.initByArray(key);
  }

  private initGenrand(s: number): void {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
    }
    this.mti = N;
  }

  private initByArray(key: number[]): void {
    this.initGenrand(19650218);
    const mt = this.mt;
    let i = 1;
    let j = 0;
    let k = Math.max(N, key.length);
    for (; k; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(prev, 1664525)) + key[j] + j) >>> 0;
      i++;
      j++;
      if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
      if (j >= key.length) j = 0;
    }
    for (k = N - 1; k; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(prev, 1566083941)) - i) >>> 0;
      i++;
      if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
    }
    mt[0] = 0x80000000;
  }

  private genrand(): number {
    const mt = this.mt;
    let y: number;
    if (this.mti >= N) {
      let kk = 0;
      for (; kk < N - M; kk++) {
        y = (mt[kk] & UPPER) | (mt[kk + 1] & LOWER);
        mt[kk] = mt[kk + M] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      }
      for (; kk < N - 1; kk++) {
        y = (mt[kk] & UPPER) | (mt[kk + 1] & LOWER);
        mt[kk] = mt[kk + (M - N)] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      }
      y = (mt[N - 1] & UPPER) | (mt[0] & LOWER);
      mt[N - 1] = mt[M - 1] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      this.mti = 0;
    }
    y = mt[this.mti++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** [0, 1) with 53 random bits, exactly as CPython. */
  random(): number {
    const a = this.genrand() >>> 5;
    const b = this.genrand() >>> 6;
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
  }

  getrandbits(k: number): number {
    if (k <= 0) return 0;
    if (k <= 32) return this.genrand() >>> (32 - k);
    // up to 53 bits as a JS number (little-endian words, as CPython)
    let out = 0;
    let mult = 1;
    let left = k;
    while (left > 0) {
      let r = this.genrand();
      if (left < 32) r >>>= 32 - left;
      out += r * mult;
      mult *= 4294967296;
      left -= 32;
    }
    return out;
  }

  private randbelow(n: number): number {
    if (n <= 0) return 0;
    const k = bitLength(n);
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  }

  randrange(start: number, stop?: number): number {
    if (stop === undefined) return this.randbelow(start);
    return start + this.randbelow(stop - start);
  }

  randint(a: number, b: number): number {
    return this.randrange(a, b + 1);
  }

  uniform(a: number, b: number): number {
    return a + (b - a) * this.random();
  }

  choice<T>(seq: readonly T[]): T {
    return seq[this.randbelow(seq.length)];
  }

  shuffle<T>(x: T[]): void {
    for (let i = x.length - 1; i > 0; i--) {
      const j = this.randbelow(i + 1);
      const t = x[i];
      x[i] = x[j];
      x[j] = t;
    }
  }

  /** `random.choices(population, weights)[0]` */
  choices<T>(population: readonly T[], weights: readonly number[]): T {
    const cum: number[] = [];
    let total = 0;
    for (const w of weights) { total += w; cum.push(total); }
    const x = this.random() * total;
    // bisect_right(cum, x, 0, n - 1)
    let lo = 0;
    let hi = population.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (x < cum[mid]) hi = mid; else lo = mid + 1;
    }
    return population[lo];
  }

  sample<T>(population: readonly T[], k: number): T[] {
    const n = population.length;
    const result: T[] = new Array(k);
    let setsize = 21;
    if (k > 5) setsize += 4 ** Math.ceil(Math.log(k * 3) / Math.log(4));
    if (n <= setsize) {
      const pool = population.slice();
      for (let i = 0; i < k; i++) {
        const j = this.randbelow(n - i);
        result[i] = pool[j];
        pool[j] = pool[n - i - 1];
      }
    } else {
      const selected = new Set<number>();
      for (let i = 0; i < k; i++) {
        let j = this.randbelow(n);
        while (selected.has(j)) j = this.randbelow(n);
        selected.add(j);
        result[i] = population[j];
      }
    }
    return result;
  }

  gauss(mu = 0, sigma = 1): number {
    let z = this.gaussNext;
    this.gaussNext = null;
    if (z === null) {
      const x2pi = this.random() * TWOPI;
      const g2rad = Math.sqrt(-2.0 * Math.log(1.0 - this.random()));
      z = Math.cos(x2pi) * g2rad;
      this.gaussNext = Math.sin(x2pi) * g2rad;
    }
    return mu + z * sigma;
  }

  gammavariate(alpha: number, beta: number): number {
    if (alpha > 1.0) {
      const ainv = Math.sqrt(2.0 * alpha - 1.0);
      const bbb = alpha - LOG4;
      const ccc = alpha + ainv;
      for (;;) {
        const u1 = this.random();
        if (!(1e-7 < u1 && u1 < 0.9999999)) continue;
        const u2 = 1.0 - this.random();
        const v = Math.log(u1 / (1.0 - u1)) / ainv;
        const x = alpha * Math.exp(v);
        const z = u1 * u1 * u2;
        const r = bbb + ccc * v - x;
        if (r + SG_MAGICCONST - 4.5 * z >= 0.0 || r >= Math.log(z)) return x * beta;
      }
    }
    if (alpha === 1.0) return -Math.log(1.0 - this.random()) * beta;
    for (;;) {
      const u = this.random();
      const b = (Math.E + alpha) / Math.E;
      const p = b * u;
      let x: number;
      if (p <= 1.0) x = p ** (1.0 / alpha);
      else x = -Math.log((b - p) / alpha);
      const u1 = this.random();
      if (p > 1.0) { if (u1 <= x ** (alpha - 1.0)) return x * beta; }
      else if (u1 <= Math.exp(-x)) return x * beta;
    }
  }

  betavariate(alpha: number, beta: number): number {
    const y = this.gammavariate(alpha, 1.0);
    if (y) return y / (y + this.gammavariate(beta, 1.0));
    return 0.0;
  }
}

function bitLength(n: number): number {
  let k = 0;
  while (n >= 1) {
    n = Math.floor(n / 2);
    k++;
  }
  return k;
}

/** CPython's hash() of a float (what `random.Random(0.37...)` seeds with). */
export function pyHashFloat(v: number): bigint {
  const BITS = 61n;
  const MOD = (1n << 61n) - 1n;
  if (!Number.isFinite(v)) return 0n;
  if (Number.isInteger(v) && Math.abs(v) < 2 ** 53) {
    let h = BigInt(v) % MOD;
    if (h === -1n) h = -2n;
    return h;
  }
  let e = 0;
  let m = Math.abs(v);
  const sign = v < 0 ? -1n : 1n;
  // frexp
  if (m !== 0) {
    e = Math.floor(Math.log2(m)) + 1;
    m = m / 2 ** e;
    while (m >= 1) { m /= 2; e++; }
    while (m < 0.5) { m *= 2; e--; }
  }
  let x = 0n;
  while (m) {
    x = ((x << 28n) & MOD) | (x >> (BITS - 28n));
    m *= 268435456.0;
    e -= 28;
    const y = Math.floor(m);
    m -= y;
    x += BigInt(y);
    if (x >= MOD) x -= MOD;
  }
  const be = BigInt(e >= 0 ? e % 61 : 61 - 1 - ((-1 - e) % 61));
  x = ((x << be) & MOD) | (x >> (BITS - be));
  x = x * sign;
  if (x === -1n) x = -2n;
  return x;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** zlib.crc32 of a string's UTF-8 bytes. */
export function crc32(s: string | Uint8Array): number {
  const bytes = typeof s === "string" ? new TextEncoder().encode(s) : s;
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
