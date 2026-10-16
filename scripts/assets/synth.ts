// Procedural sound synthesis: every sound in the game is generated from noise,
// filtered noise and damped oscillators, so the project ships no third-party audio. Building blocks:
// band (FFT band-pass with soft edges), env (attack/decay envelopes), modes (damped sinusoids), and a
// gunshot = broadband crack + low thump + filtered decaying tail. Mono 16-bit WAV at 22.05 kHz (the browser
// low-passes live for occlusion, so the old "_muffled" variants are not made).

import { Random } from "../../shared/src/rng";

export const RATE = 22050;
type S = Float32Array;

const nOf = (dur: number) => Math.round(dur * RATE);
const tOf = (dur: number): S => { const n = nOf(dur); const t = new Float32Array(n); for (let i = 0; i < n; i++) t[i] = i / RATE; return t; };

class Rng {
  r: Random;
  constructor(seed: number) { this.r = new Random(seed); }
  normal(n: number): S { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = this.r.gauss(0, 1); return a; }
  uniform(lo: number, hi: number): number { return this.r.uniform(lo, hi); }
  uniformArr(lo: number[], hi: number[]): number[] { return lo.map((l, i) => this.r.uniform(l, hi[i])); }
  random(): number { return this.r.random(); }
  integers(lo: number, hi: number): number { return this.r.randrange(lo, hi); }
}

const noise = (dur: number, rng: Rng): S => rng.normal(nOf(dur));

// --------------------------------------------------------------- FFT (pow2)
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / size;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let s = 0; s < n; s += size) {
      let cr = 1, ci = 0;
      for (let k = 0; k < size / 2; k++) {
        const a = s + k, b = a + size / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/** FFT band-pass with logistic soft edges. */
export function band(x: S, lo: number, hi: number, soft = 0.25): S {
  const n0 = x.length;
  let n = 1;
  while (n < n0) n <<= 1;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n0; i++) re[i] = x[i];
  fft(re, im, false);
  const sl = Math.max(lo * soft, 1), sh = Math.max(hi * soft, 1);
  for (let k = 0; k < n; k++) {
    const f = (k <= n / 2 ? k : n - k) * RATE / n;
    const wl = 1 / (1 + Math.exp(Math.max(-60, Math.min(60, -(f - lo) / sl))));
    const wh = 1 / (1 + Math.exp(Math.max(-60, Math.min(60, (f - hi) / sh))));
    re[k] *= wl * wh; im[k] *= wl * wh;
  }
  fft(re, im, true);
  const out = new Float32Array(n0);
  for (let i = 0; i < n0; i++) out[i] = re[i] / n;
  return out;
}

export function env(t: S, attack: number, decay: number, start = 0): S {
  const out = new Float32Array(t.length);
  for (let i = 0; i < t.length; i++) {
    const tt = t[i] - start;
    if (tt < 0) continue;
    out[i] = Math.min(1, Math.max(0, tt / Math.max(attack, 1e-4))) * Math.exp(-Math.max(tt - attack, 0) / Math.max(decay, 1e-4));
  }
  return out;
}

function modes(t: S, freqs: number[], decays: number[], amps: number[], start = 0): S {
  const out = new Float32Array(t.length);
  for (let i = 0; i < t.length; i++) {
    const tt = t[i] - start;
    if (tt < 0) continue;
    let v = 0;
    for (let k = 0; k < freqs.length; k++) v += amps[k] * Math.sin(2 * Math.PI * freqs[k] * tt) * Math.exp(-tt / decays[k]);
    out[i] = v;
  }
  return out;
}

// sample-wise arithmetic
const mul = (a: S, b: S | number): S => a.map((v, i) => v * (typeof b === "number" ? b : b[i]));
function add(...xs: Array<S | null>): S {
  const parts = xs.filter((x): x is S => !!x);
  const n = Math.max(...parts.map((p) => p.length));
  const out = new Float32Array(n);
  for (const p of parts) for (let i = 0; i < p.length; i++) out[i] += p[i];
  return out;
}
const fn = (t: S, f: (tt: number, i: number) => number): S => { const o = new Float32Array(t.length); for (let i = 0; i < t.length; i++) o[i] = f(t[i], i); return o; };
const tanh = (x: S, k: number): S => x.map((v) => Math.tanh(v * k));

function click(t: S, start: number, rng: Rng, hi = 6000, decay = 0.006, amp = 1.0, body = 1800): S {
  const nz = mul(band(noise(t.length / RATE, rng), 800, hi), env(t, 0.0005, decay, start));
  const m = modes(t, [body, body * 2.3, body * 3.9], [0.01, 0.006, 0.004], [0.5, 0.3, 0.2], start);
  return mul(add(mul(nz, 0.8), m), amp);
}

export function normalize(x: S, peak = 0.9): S {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  if (!m) m = 1;
  return x.map((v) => v / m * peak);
}

export function wav(x: S): Uint8Array {
  const n = x.length;
  const buf = new Uint8Array(44 + n * 2);
  const v = new DataView(buf.buffer);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };
  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), true);
  return buf;
}

// ------------------------------------------------------------------ recipes
const GUN_PROFILES: Record<string, { crack: [number, number]; thump: number; tail: number; tailBand: [number, number]; body: number; dur: number }> = {
  rifle_heavy: { crack: [700, 9000], thump: 72, tail: 0.9, tailBand: [180, 2400], body: 1.0, dur: 1.3 },
  rifle_light: { crack: [900, 11000], thump: 88, tail: 0.75, tailBand: [220, 3000], body: 0.85, dur: 1.1 },
  smg: { crack: [1100, 10000], thump: 110, tail: 0.45, tailBand: [300, 3500], body: 0.6, dur: 0.7 },
  pistol: { crack: [1000, 9000], thump: 120, tail: 0.5, tailBand: [300, 3200], body: 0.55, dur: 0.8 },
  sniper: { crack: [500, 12000], thump: 55, tail: 1.6, tailBand: [120, 2000], body: 1.4, dur: 2.2 },
  shotgun: { crack: [400, 7000], thump: 60, tail: 1.1, tailBand: [120, 1800], body: 1.3, dur: 1.5 },
};

function gunshot(profile: string, rng: Rng): S {
  const p = GUN_PROFILES[profile];
  const t = tOf(p.dur);
  const crack = mul(band(noise(p.dur, rng), ...p.crack), env(t, 0.0003, 0.018));
  const e = env(t, 0.001, 0.07);
  const thump = fn(t, (tt, i) => Math.sin(2 * Math.PI * p.thump * tt * (1 + 0.6 * Math.exp(-tt / 0.03))) * e[i] * p.body);
  const mech = click(t, 0, rng, 7000, 0.01, 0.3);
  const tail = mul(mul(band(noise(p.dur, rng), ...p.tailBand), env(t, 0.01, p.tail * 0.35)), 0.35);
  const echo = mul(mul(band(noise(p.dur, rng), 150, 1500), env(t, 0.03, p.tail * 0.5, 0.08)), 0.18);
  const x = add(crack, mul(thump, 0.9), mech, tail, echo);
  return normalize(tanh(normalize(x, 1.0), 1.6), 0.95);
}

function gunshotFar(profile: string, rng: Rng): S {
  const p = GUN_PROFILES[profile];
  const dur = p.dur + 0.9;
  const t = tOf(dur);
  const n = noise(dur, rng);
  const crack = mul(band(n, 300, 2400), env(t, 0.001, 0.03));
  const boom = mul(mul(band(n, 40, 380), env(t, 0.004, 0.16)), p.body);
  const roll = mul(mul(band(n, 90, 900), env(t, 0.06, p.tail * 0.8, 0.05)), 0.45);
  const echo = mul(mul(band(n, 150, 1200), env(t, 0.02, 0.3, 0.35)), 0.25);
  return normalize(tanh(normalize(add(mul(crack, 0.8), boom, roll, echo), 1.0), 1.3), 0.85);
}

function impact(kind: string, rng: Rng): S {
  const t = tOf(0.45);
  const n = noise(0.45, rng);
  let x: S;
  if (kind === "metal") {
    x = add(modes(t, rng.uniformArr([1800, 3100, 4700, 6900], [2300, 3800, 5400, 7600]), [0.12, 0.08, 0.05, 0.03], [0.6, 0.4, 0.3, 0.2]),
      mul(mul(band(n, 2000, 10500), env(t, 0.0005, 0.01)), 0.6));
  } else if (kind === "wood") {
    x = add(modes(t, rng.uniformArr([380, 900], [460, 1100]), [0.04, 0.02], [0.8, 0.4]), mul(mul(band(n, 500, 5000), env(t, 0.0005, 0.02)), 0.6));
  } else if (kind === "dirt" || kind === "gravel") {
    x = add(mul(band(n, 80, 1500), env(t, 0.001, 0.05)), mul(mul(band(n, 2000, 8000), env(t, 0.01, 0.08, 0.02)), kind === "gravel" ? 0.25 : 0.08));
  } else if (kind === "glass") {
    x = add(modes(t, rng.uniformArr([2500, 4200, 6100], [3200, 5000, 7300]), [0.2, 0.15, 0.1], [0.4, 0.3, 0.3]), mul(mul(band(n, 3000, 10500), env(t, 0.0005, 0.08)), 0.5));
  } else if (kind === "flesh" || kind === "dummy") {
    x = add(mul(band(n, 60, 900), env(t, 0.001, 0.04)), kind === "dummy" ? modes(t, [520], [0.03], [0.4]) : null);
  } else if (kind === "fabric") {
    x = mul(band(n, 100, 2000), env(t, 0.001, 0.03));
  } else {
    x = add(mul(band(n, 900, 9000), env(t, 0.0003, 0.012)), mul(mul(band(n, 200, 4000), env(t, 0.002, 0.06)), 0.5),
      mul(mul(band(n, 3000, 9000), env(t, 0.02, 0.1, 0.03)), 0.12));
  }
  return normalize(x, 0.8);
}

function footstep(kind: string, rng: Rng): S {
  const t = tOf(0.25);
  const n = noise(0.25, rng);
  const heel = mul(band(n, 60, 700), env(t, 0.002, 0.025));
  let x: S;
  if (kind === "metal" || kind === "metal_grate") {
    x = add(mul(heel, 0.6), mul(modes(t, rng.uniformArr([600, 1500, 2600], [800, 1800, 3000]), [0.08, 0.05, 0.03], [0.4, 0.25, 0.15]), 0.5));
  } else if (kind === "wood") x = add(heel, modes(t, rng.uniformArr([180, 420], [220, 500]), [0.05, 0.03], [0.4, 0.2]));
  else if (kind === "dirt" || kind === "gravel") x = add(mul(heel, 0.7), mul(mul(band(n, 1500, 9000), env(t, 0.005, 0.06, 0.01)), kind === "gravel" ? 0.6 : 0.3));
  else if (kind === "fabric") x = mul(band(n, 80, 1500), env(t, 0.004, 0.05));
  else x = add(heel, mul(mul(band(n, 2000, 8000), env(t, 0.001, 0.015)), 0.4));
  return normalize(x, 0.7);
}

function explosion(rng: Rng): S {
  const t = tOf(3.0);
  const n = noise(3.0, rng);
  const boom = mul(band(n, 25, 400), env(t, 0.002, 0.35));
  const crack = mul(band(n, 600, 10000), env(t, 0.0005, 0.03));
  const rumble = mul(mul(band(n, 30, 200), env(t, 0.05, 0.9)), 0.6);
  const debris = mul(mul(band(n, 1500, 7000), env(t, 0.2, 0.5, 0.25)), 0.15);
  return normalize(tanh(normalize(add(boom, mul(crack, 0.7), rumble, debris), 1.0), 2.0), 0.95);
}

function flashbang(rng: Rng): S {
  const t = tOf(1.8);
  const n = noise(1.8, rng);
  const x = add(mul(band(n, 200, 10500), env(t, 0.0003, 0.05)), mul(mul(band(n, 60, 600), env(t, 0.002, 0.25)), 0.8),
    mul(mul(band(n, 500, 4000), env(t, 0.02, 0.4, 0.02)), 0.2));
  return normalize(tanh(normalize(x, 1.0), 2.2), 0.95);
}

function smokePop(rng: Rng): S {
  const t = tOf(3.5);
  const n = noise(3.5, rng);
  return normalize(add(mul(band(n, 100, 3000), env(t, 0.001, 0.04)), mul(mul(band(n, 2500, 10000), env(t, 0.15, 1.6, 0.05)), 0.35)), 0.8);
}

function whoosh(rng: Rng, dur = 0.3, lo = 300, hi = 3000): S {
  const t = tOf(dur);
  const b = band(noise(dur, rng), lo, hi);
  return normalize(fn(t, (tt, i) => b[i] * Math.sin(Math.min(1, Math.max(0, tt / dur)) * Math.PI) ** 2), 0.6);
}

function ring(): S {
  const t = tOf(4.0);
  const e1 = env(t, 0.2, 1.4), e2 = env(t, 0.3, 1.2);
  return normalize(fn(t, (tt, i) => Math.sin(2 * Math.PI * 3400 * tt) * e1[i] * 0.5 + Math.sin(2 * Math.PI * 3410 * tt) * e2[i] * 0.3), 0.35);
}

function uiTick(freq: number, dur = 0.06): S {
  const t = tOf(dur);
  const e1 = env(t, 0.001, dur / 4), e2 = env(t, 0.001, dur / 6);
  return normalize(fn(t, (tt, i) => Math.sin(2 * Math.PI * freq * tt) * e1[i] + Math.sin(2 * Math.PI * freq * 2.01 * tt) * e2[i] * 0.3), 0.5);
}

function tone(freqs: number[], dur: number, attack = 0.005, decay = 0.2, square = 0): S {
  const t = tOf(dur);
  const e = env(t, attack, decay);
  return fn(t, (tt, i) => {
    let x = 0;
    freqs.forEach((f, k) => {
      let w = Math.sin(2 * Math.PI * f * tt);
      if (square > 0) w = Math.tanh(w * (1 + 6 * square));
      x += w / (1 + k * 0.4);
    });
    return x * e[i];
  });
}

const bombBeep = (): S => normalize(tone([2900, 5810], 0.09, 0.002, 0.03, 0.2), 0.7);

function chord(notes: number[], dur: number, step = 0, decay = 0.6): S {
  const t = tOf(dur);
  let x = new Float32Array(t.length);
  notes.forEach((f, k) => {
    const start = k * step;
    const e = env(t, 0.03, decay, start);
    x = add(x, fn(t, (tt, i) => { const u = Math.max(tt - start, 0); return (Math.sin(2 * Math.PI * f * u) + 0.3 * Math.sin(2 * Math.PI * 2 * f * u)) * e[i]; }));
  });
  return normalize(x, 0.6);
}

function concat(...xs: S[]): S {
  const out = new Float32Array(xs.reduce((s, x) => s + x.length, 0));
  let o = 0;
  for (const x of xs) { out.set(x, o); o += x.length; }
  return out;
}

function alert(rng: Rng): S {
  const a = tone([880, 1760], 0.18, 0.005, 0.12, 0.4), b = tone([660, 1320], 0.18, 0.005, 0.12, 0.4);
  const x = concat(a, b, a, b);
  return normalize(add(x, mul(band(noise(x.length / RATE, rng), 1500, 4000), 0.03)), 0.6);
}

function sequence(dur: number, events: Array<[number, string]>, rng: Rng): S {
  const t = tOf(dur);
  let x = new Float32Array(t.length);
  for (const [at, kind] of events) {
    if (at >= dur) continue;
    if (kind === "click") x = add(x, click(t, at, rng, 6000, 0.004, 0.7, 2400));
    else if (kind === "clack") x = add(x, click(t, at, rng, 6000, 0.012, 1.0, 1100), click(t, at + 0.05, rng, 6000, 0.008, 0.6, 1500));
    else if (kind === "slide") x = add(x, mul(mul(band(noise(dur, rng), 1500, 7000), env(t, 0.02, 0.06, at)), 0.4));
    else if (kind === "thump") x = add(x, mul(mul(band(noise(dur, rng), 80, 900), env(t, 0.001, 0.03, at)), 0.8));
    else if (kind === "cloth") x = add(x, mul(mul(band(noise(dur, rng), 400, 4000), env(t, 0.05, 0.12, at)), 0.25));
  }
  return normalize(x, 0.6);
}

function reloadEvents(cls: string, kind: string, d: number): Array<[number, string]> {
  if (cls === "pistol") {
    const ev: Array<[number, string]> = [[0.05, "cloth"], [0.28 * d, "click"], [0.7 * d, "thump"], [0.72 * d, "click"]];
    if (kind === "empty") ev.push([0.82 * d, "clack"]);
    return ev;
  }
  if (cls === "sniper") return [[0.05, "cloth"], [0.26 * d, "click"], [0.64 * d, "click"], [0.8 * d, "clack"], [0.9 * d, "clack"]];
  const outT = kind !== "empty" ? 0.3 : 0.25, inT = kind !== "empty" ? 0.72 : 0.63;
  const ev: Array<[number, string]> = [[0.05, "cloth"], [outT * d, "click"], [outT * d + 0.05, "slide"], [inT * d, "thump"], [inT * d + 0.01, "click"]];
  if (kind === "empty") ev.push([0.83 * d, "clack"]);
  return ev;
}

function crumble(rng: Rng, kind: string): S {
  const t = tOf(0.9);
  const n = noise(0.9, rng);
  let x = mul(band(n, 300, 6000), env(t, 0.0005, 0.05));
  const b = band(n, 500, 5000);
  for (let k = 0; k < 7; k++) {
    const at = 0.08 + rng.uniform(0, 0.6);
    if (kind === "wood") x = add(x, mul(modes(t, rng.uniformArr([300, 800], [450, 1100]), [0.03, 0.02], [0.5, 0.25], at), rng.uniform(0.2, 0.6)));
    else x = add(x, mul(mul(b, env(t, 0.001, 0.02, at)), rng.uniform(0.2, 0.6)));
  }
  x = add(x, mul(mul(band(n, 200, 1500), env(t, 0.05, 0.4, 0.05)), 0.25));
  return normalize(x, 0.85);
}

function burn(rng: Rng): S {
  const t = tOf(3.0);
  const n = noise(3.0, rng);
  let x = mul(mul(band(n, 1500, 9000), env(t, 0.1, 2.2)), 0.6);
  const b = band(n, 2000, 8000);
  for (let k = 0; k < 40; k++) x = add(x, mul(mul(b, env(t, 0.0005, 0.01, rng.uniform(0.1, 2.8))), rng.uniform(0.2, 0.8)));
  return normalize(x, 0.8);
}

function clanks(rng: Rng): S {
  const t = tOf(2.4);
  let x = new Float32Array(t.length);
  for (const at of [0, 0.55, 1.1, 1.65, 2.1]) x = add(x, modes(t, rng.uniformArr([300, 700, 1400], [380, 820, 1600]), [0.2, 0.12, 0.06], [0.7, 0.4, 0.2], at));
  return normalize(x, 0.8);
}

function empBurst(rng: Rng): S {
  const t = tOf(1.2);
  const n = noise(1.2, rng);
  const e = env(t, 0.005, 0.5);
  return normalize(add(fn(t, (tt, i) => Math.sin(2 * Math.PI * (200 + 1800 * tt) * tt) * e[i] * 0.5), mul(band(n, 2000, 10500), env(t, 0.0005, 0.15))), 0.85);
}

function rattle(rng: Rng): S {
  const t = tOf(0.6);
  let x = new Float32Array(t.length);
  for (let k = 0; k < 14; k++) x = add(x, modes(t, rng.uniformArr([2200, 3700], [2800, 4600]), [0.03, 0.02], [0.3, 0.2], rng.uniform(0, 0.45)));
  return normalize(x, 0.7);
}

function droneWhine(rng: Rng): S {
  const t = tOf(1.0);
  const b = band(noise(1.0, rng), 300, 2500);
  return normalize(fn(t, (tt, i) => Math.sin(2 * Math.PI * 410 * tt) * 0.3 + Math.sin(2 * Math.PI * 820 * tt) * 0.15 + b[i] * 0.25), 0.4);
}

function radioSquelch(rng: Rng): S {
  const t = tOf(0.16);
  return normalize(add(mul(mul(band(noise(0.16, rng), 900, 3200), env(t, 0.004, 0.05)), 0.5), mul(tone([1250], 0.16, 0.002, 0.03), 0.25)), 0.4);
}

function seamless(x: S, fade: number): S {
  const f = nOf(fade);
  const n = x.length - f;
  const y = x.slice(0, n);
  for (let i = 0; i < f; i++) { const r = i / Math.max(f - 1, 1); y[i] = x[i] * r + x[n + i] * (1 - r); }
  return y;
}

function roomTail(rng: Rng, size = 0.22): S {
  const t = tOf(size * 3.5);
  const n = noise(size * 3.5, rng);
  let x = mul(mul(band(n, 250, 4000), env(t, 0.004, size)), 0.7);
  const b = band(n, 400, 5000);
  for (const [d, a] of [[0.013, 0.7], [0.027, 0.55], [0.041, 0.45], [0.063, 0.3]]) x = add(x, mul(mul(b, env(t, 0.0005, 0.012, d)), a));
  return normalize(x, 0.6);
}

function windLoop(rng: Rng, dur = 14): S {
  const fade = 2;
  const t = tOf(dur + fade);
  const gust = fn(t, (tt) => 0.55 + 0.25 * Math.sin(2 * Math.PI * tt / 5.3 + 1) + 0.2 * Math.sin(2 * Math.PI * tt / 2.3 + 0.3));
  const base = mul(band(noise(dur + fade, rng), 50, 650), gust);
  const wb = band(noise(dur + fade, rng), 520, 760, 0.05);
  const whistle = fn(t, (tt, i) => wb[i] * (0.5 + 0.5 * Math.sin(2 * Math.PI * tt / 7)) ** 2);
  const hiss = mul(mul(band(noise(dur + fade, rng), 2000, 7000), gust), 0.12);
  return normalize(seamless(add(base, mul(whistle, 0.5), hiss), fade), 0.5);
}

function roomLoop(rng: Rng, dur = 8): S {
  const fade = 1;
  const t = tOf(dur + fade);
  const n = noise(dur + fade, rng);
  const hum = fn(t, (tt) => Math.sin(2 * Math.PI * 50 * tt) * 0.25 + Math.sin(2 * Math.PI * 100 * tt) * 0.16 + Math.sin(2 * Math.PI * 150 * tt) * 0.05);
  return normalize(seamless(add(hum, mul(band(n, 70, 450), 0.6), mul(band(n, 1000, 4000), 0.03)), fade), 0.35);
}

function tunnelLoop(rng: Rng, dur = 10): S {
  const fade = 1.5;
  const t = tOf(dur + fade);
  const b = band(noise(dur + fade, rng), 25, 180);
  let x = fn(t, (tt, i) => b[i] * (0.8 + 0.2 * Math.sin(2 * Math.PI * tt / 3.7)));
  for (let k = 0; k < 7; k++) x = add(x, modes(t, rng.uniformArr([1300, 2600], [1900, 3400]), [0.025, 0.012], [0.25, 0.1], rng.uniform(0, dur)));
  return normalize(seamless(x, fade), 0.45);
}

function creak(rng: Rng): S {
  const dur = 1.4;
  const t = tOf(dur);
  const f0 = rng.uniform(130, 210), fm = rng.uniform(1.2, 2.6);
  const grainB = band(noise(dur, rng), 15, 70);
  const e = env(t, 0.25, 0.45, 0.1);
  let ph = 0;
  const x = fn(t, (tt, i) => {
    ph += 2 * Math.PI * f0 * (1 + 0.12 * Math.sin(2 * Math.PI * fm * tt)) / RATE;
    return (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.25 * Math.sin(3.1 * ph)) * (1 + 0.6 * grainB[i]) * e[i];
  });
  return normalize(band(x, 80, 2500), 0.5);
}

function birds(rng: Rng): S {
  const dur = 1.2;
  const t = tOf(dur);
  const x = new Float32Array(t.length);
  let at = rng.uniform(0, 0.1);
  const count = rng.integers(3, 6);
  for (let c = 0; c < count; c++) {
    const ln = rng.uniform(0.05, 0.1);
    let f0 = rng.uniform(2600, 3400), f1 = rng.uniform(3600, 4600);
    if (rng.random() < 0.5) [f0, f1] = [f1, f0];
    let ph = 0;
    for (let i = 0; i < t.length; i++) {
      const tt = Math.min(Math.max(t[i] - at, 0), ln);
      ph += 2 * Math.PI * (f0 + (f1 - f0) * tt / ln) / RATE;
      if (t[i] >= at && t[i] < at + ln) x[i] += Math.sin(ph) * Math.sin(Math.PI * tt / ln) ** 2;
    }
    at += ln + rng.uniform(0.04, 0.14);
  }
  return normalize(x, 0.35);
}

function farClank(rng: Rng): S {
  const t = tOf(1.2);
  const x = add(modes(t, rng.uniformArr([220, 540, 1100], [300, 640, 1300]), [0.25, 0.15, 0.08], [0.6, 0.35, 0.2]),
    modes(t, rng.uniformArr([230, 560], [310, 650]), [0.2, 0.1], [0.3, 0.15], rng.uniform(0.15, 0.3)));
  return normalize(band(x, 100, 1500), 0.45);
}

const note = (n: number) => 440 * 2 ** ((n - 69) / 12);

function voice(t: S, f: number, start: number, length: number, attack: number, release: number, bright = 0.3): S {
  return fn(t, (tt0) => {
    const tt = tt0 - start;
    if (tt < 0) return 0;
    const a = (Math.min(1, Math.max(0, tt / attack)) * Math.min(1, Math.max(0, (length + release - tt) / release))) ** 1.5;
    return (Math.sin(2 * Math.PI * f * tt0) + Math.sin(2 * Math.PI * f * 1.003 * tt0) + bright * Math.sin(2 * Math.PI * 2 * f * tt0)
      + bright * 0.4 * Math.sin(2 * Math.PI * 3 * f * tt0)) * a;
  });
}

const pluck = (t: S, f: number, start: number, decay = 0.6): S => fn(t, (tt0) => {
  const tt = tt0 - start;
  return tt < 0 ? 0 : (Math.sin(2 * Math.PI * f * tt) + 0.3 * Math.sin(4 * Math.PI * f * tt)) * Math.exp(-tt / decay);
});

function drum(t: S, start: number, rng: Rng, f = 55): S {
  const hit = mul(mul(band(noise(t.length / RATE, rng), 100, 3000), env(t, 0.001, 0.03, start)), 0.4);
  return add(fn(t, (tt0) => {
    if (tt0 < start) return 0;
    const tt = tt0 - start;
    return Math.sin(2 * Math.PI * f * tt * (1 + 1.5 * Math.exp(-tt / 0.04))) * Math.exp(-tt / 0.25);
  }), hit);
}

function sting(kind: string, rng: Rng): S {
  if (kind === "round_start") {
    const t = tOf(2.4);
    let x = add(mul(drum(t, 0, rng, 50), 0.9), mul(drum(t, 0.45, rng, 50), 0.6));
    for (const [n, s] of [[52, 0], [57, 0.45], [64, 0.9]]) x = add(x, mul(voice(t, note(n), s, 0.5, 0.03, 0.8, 0.6), 0.35));
    return normalize(band(x, 30, 5000), 0.6);
  }
  if (kind === "win") {
    const t = tOf(3.2);
    let x = mul(drum(t, 0, rng, 55), 0.6);
    [57, 61, 64, 69].forEach((n, k) => { x = add(x, mul(voice(t, note(n), 0.05 * k, 1.6, 0.08, 1.4, 0.5), 0.3), mul(pluck(t, note(n + 12), 0.08 * k, 1.0), 0.15)); });
    return normalize(band(x, 30, 6000), 0.6);
  }
  if (kind === "lose") {
    const t = tOf(3.2);
    let x = new Float32Array(t.length);
    [57, 53, 50].forEach((n, k) => { x = add(x, mul(voice(t, note(n), 0.35 * k, k < 2 ? 0.6 : 1.6, 0.06, 1.2, 0.3), 0.35)); });
    x = add(x, mul(voice(t, note(38), 0.7, 1.6, 0.4, 1.2, 0.1), 0.4));
    return normalize(band(x, 30, 3000), 0.55);
  }
  const t = tOf(3.0);
  let x = new Float32Array(t.length);
  for (let k = 0; k < 5; k++) x = add(x, mul(drum(t, k * 0.5, rng, 45), 0.7 - k * 0.1));
  x = add(x, mul(voice(t, note(57), 0, 2.2, 1.2, 0.7, 0.4), 0.25), mul(voice(t, note(58), 0.4, 1.8, 1.2, 0.7, 0.4), 0.2));
  return normalize(band(x, 30, 4000), 0.6);
}

export interface WeaponSound { key: string; magazine: number; fireMode: string; cls: string; reloadTime: number; reloadEmptyTime: number }

/** Every sound: name -> variants (WAV bytes). */
export function buildLibrary(weapons: WeaponSound[], seed = 21, onProgress: (name: string) => void = () => {}): Map<string, Uint8Array[]> {
  const rng = new Rng(seed);
  const lib = new Map<string, Uint8Array[]>();
  const addS = (name: string, gen: () => S, variants = 1) => {
    const out: Uint8Array[] = [];
    for (let v = 0; v < variants; v++) out.push(wav(gen()));
    lib.set(name, out);
    onProgress(name);
  };
  for (const prof of Object.keys(GUN_PROFILES)) {
    addS(`shot_${prof}`, () => gunshot(prof, rng), 3);
    addS(`shot_${prof}_far`, () => gunshotFar(prof, rng), 2);
  }
  for (const k of ["concrete", "metal", "wood", "dirt", "gravel", "glass", "flesh", "dummy", "fabric", "plaster", "tile"]) addS(`impact_${k}`, () => impact(k, rng), 3);
  for (const k of ["concrete", "metal", "metal_grate", "wood", "dirt", "gravel", "tile", "fabric", "default", "brick", "plaster"]) addS(`step_${k}`, () => footstep(k, rng), 4);
  addS("explosion", () => explosion(rng), 2);
  addS("flashbang", () => flashbang(rng));
  addS("smoke_pop", () => smokePop(rng));
  addS("ear_ring", () => ring());
  addS("grenade_bounce", () => mul(impact("metal", rng), 0.6), 3);
  addS("knife_swing", () => whoosh(rng, 0.25, 600, 5000), 2);
  addS("throw", () => whoosh(rng, 0.35, 300, 2500));
  addS("knife_hit_body", () => impact("flesh", rng), 2);
  addS("knife_hit_wall", () => impact("metal", rng), 2);
  addS("dry_fire", () => sequence(0.15, [[0, "click"]], rng));
  addS("draw", () => sequence(0.4, [[0, "cloth"], [0.18, "click"]], rng));
  addS("pump", () => sequence(0.5, [[0.05, "clack"], [0.25, "clack"]], rng));
  addS("bolt", () => sequence(0.9, [[0.15, "click"], [0.3, "clack"], [0.55, "clack"], [0.7, "click"]], rng));
  addS("shell_insert", () => sequence(0.25, [[0, "slide"], [0.08, "click"]], rng), 2);
  addS("scope", () => sequence(0.15, [[0, "click"]], rng));
  addS("pin", () => sequence(0.3, [[0, "click"], [0.05, "slide"]], rng));
  addS("pickup", () => sequence(0.3, [[0, "cloth"], [0.1, "click"]], rng));
  addS("land", () => footstep("concrete", rng));
  addS("hit", () => uiTick(1800, 0.05));
  addS("bomb_beep", bombBeep);
  addS("bomb_planted", () => alert(rng));
  addS("bomb_defused", () => chord([1046, 784, 523], 1.2, 0.12, 0.35));
  addS("plant_tap", () => uiTick(2200, 0.04));
  addS("defuse_start", () => sequence(0.5, [[0, "click"], [0.1, "slide"], [0.3, "click"]], rng));
  addS("round_win", () => chord([523, 659, 784, 1046], 1.8, 0.09, 0.8));
  addS("round_lose", () => chord([440, 349, 294, 220], 1.8, 0.12, 0.8));
  addS("buy", () => sequence(0.3, [[0, "cloth"], [0.12, "click"]], rng));
  addS("hit_head", () => uiTick(2600, 0.12));
  for (const w of weapons) {
    if (w.magazine <= 0 || w.fireMode === "pump") continue;
    for (const [kind, dur] of [["tactical", w.reloadTime], ["empty", w.reloadEmptyTime]] as const) {
      addS(`reload_${w.key}_${kind}`, () => sequence(dur + 0.2, reloadEvents(w.cls, kind, dur), rng));
    }
  }
  addS("radio", () => radioSquelch(rng));
  addS("wall_break", () => crumble(rng, "plaster"), 3);
  addS("wood_break", () => crumble(rng, "wood"), 2);
  addS("charge_place", () => sequence(0.4, [[0, "thump"], [0.08, "click"], [0.2, "click"]], rng));
  addS("charge_beep", () => normalize(tone([1900, 3800], 0.07, 0.002, 0.03, 0.3), 0.6));
  addS("thermal_burn", () => burn(rng));
  addS("hammer_hit", () => normalize(add(impact("concrete", rng), mul(crumble(rng, "plaster"), 0.6)), 0.9), 2);
  addS("reinforce", () => clanks(rng));
  addS("pulse", () => normalize(add(mul(chord([660, 990], 0.9, 0, 0.5), 0.6), mul(tone([1320], 0.9, 0.3, 0.4), 0.3)), 0.6));
  addS("emp", () => empBurst(rng));
  addS("wire_place", () => sequence(0.6, [[0, "cloth"], [0.1, "slide"], [0.3, "clack"]], rng));
  addS("wire_rattle", () => rattle(rng), 2);
  addS("sensor_alert", () => normalize(tone([1500, 3000], 0.12, 0.002, 0.05, 0.5), 0.5));
  addS("shield_deploy", () => normalize(add(impact("metal", rng), sequence(0.45, [[0.1, "clack"]], rng)), 0.8));
  addS("jammer", () => normalize(add(mul(tone([120, 240, 360], 1.0, 0.1, 0.8), 0.5), mul(band(noise(1.0, rng), 800, 3000), 0.1)), 0.4));
  addS("drone_motor", () => droneWhine(rng));
  addS("camera_switch", () => normalize(add(sequence(0.2, [[0, "click"]], rng), mul(mul(band(noise(0.2, rng), 1500, 6000), env(tOf(0.2), 0.001, 0.08)), 0.4)), 0.6));
  addS("ping", () => normalize(tone([1760, 2640], 0.25, 0.002, 0.15), 0.55));
  addS("tail_room", () => roomTail(rng), 2);
  addS("tail_hall", () => roomTail(rng, 0.45));
  addS("amb_wind", () => windLoop(rng));
  addS("amb_room", () => roomLoop(rng));
  addS("amb_tunnel", () => tunnelLoop(rng));
  addS("amb_creak", () => creak(rng), 3);
  addS("amb_birds", () => birds(rng), 3);
  addS("amb_clank", () => farClank(rng), 2);
  for (const kind of ["round_start", "win", "lose", "planted"]) addS(`sting_${kind}`, () => sting(kind, rng));
  return lib;
}
