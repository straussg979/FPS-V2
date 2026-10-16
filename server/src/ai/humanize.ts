// Human error for the bots: reactions, attention, flicks, stress, mistakes. None of this changes the aim
// profile (data/bots.json "difficulty"); it only shapes the errors the way people make them:
// * reaction time: lognormal (sigma reaction_sigma) with the profile's mean, clipped at 0.85 x the fastest;
// * attention: a bot fighting one enemy notices a second one late, later still far from its aim (tunnel);
// * flicks: a big turn onto a new target overshoots or undershoots and the aim's error decay corrects it;
// * stress (0..1): rises when hit or flashed, decays in a few seconds; noisier choices, likelier mistakes;
// * mistakes by difficulty: over-peeking, skipping a corner, reloading in the open, trading late, ignoring
//   a callout, freezing when flanked.

import type { Random } from "@cs/shared/rng";

/* eslint-disable @typescript-eslint/no-explicit-any */
export const DEFAULTS: Record<string, Record<string, any>> = {
  easy: { tunnel: 1.8, flick: [0.18, 0.12], stress_gain: 1.0, decision_noise: 0.35, over_peek: 0.35, skip_corner: 0.3,
    reload_open: 0.35, late_trade: 0.5, ignore_call: 0.25, panic: 0.35, radar_glance: [3.0, 6.0] },
  normal: { tunnel: 1.5, flick: [0.12, 0.09], stress_gain: 0.8, decision_noise: 0.2, over_peek: 0.15, skip_corner: 0.15,
    reload_open: 0.15, late_trade: 0.25, ignore_call: 0.1, panic: 0.15, radar_glance: [2.0, 4.0] },
  hard: { tunnel: 1.35, flick: [0.09, 0.07], stress_gain: 0.6, decision_noise: 0.12, over_peek: 0.07, skip_corner: 0.07,
    reload_open: 0.06, late_trade: 0.12, ignore_call: 0.05, panic: 0.06, radar_glance: [1.5, 3.0] },
  expert: { tunnel: 1.25, flick: [0.06, 0.05], stress_gain: 0.45, decision_noise: 0.06, over_peek: 0.03, skip_corner: 0.03,
    reload_open: 0.02, late_trade: 0.05, ignore_call: 0.0, panic: 0.02, radar_glance: [1.0, 2.5] },
};

export class Humanizer {
  rng: Random;
  c: Record<string, any>;
  sigma: number;
  stress = 0;

  constructor(bot: { rng: Random; difficulty: string }, cfg?: Record<string, any> | null) {
    this.rng = bot.rng;
    const diff = bot.difficulty || "normal";
    this.c = { ...(DEFAULTS[diff] ?? DEFAULTS.normal) };
    if (cfg) Object.assign(this.c, cfg[diff] ?? {});
    this.sigma = Number(this.c.reaction_sigma ?? 0.25);
  }

  reset(): void { this.stress = 0; }

  reaction(lo: number, hi: number): number {
    const mean = 0.5 * (lo + hi);
    const s = this.sigma;
    const mu = Math.log(Math.max(mean, 1e-3)) - 0.5 * s * s;
    const r = Math.exp(this.rng.gauss(mu, s));
    return Math.min(Math.max(r, 0.85 * lo), 2.5 * hi);
  }

  /** Reaction multiplier for a newly seen enemy (angle in degrees from where the bot aims). */
  attention(angleFromAim: number, busy: boolean): number {
    if (!busy) return 1.0;
    const t = Number(this.c.tunnel);
    return angleFromAim > 40.0 ? t : 1.0 + (t - 1.0) * 0.4;
  }

  /** Overshoot (+) or undershoot (-) in degrees for a turn of turnDeg onto a target. */
  flick(turnDeg: number): number {
    if (turnDeg < 12.0) return 0.0;
    const [mean, sd] = this.c.flick;
    const frac = this.rng.gauss(mean, sd) * (this.rng.random() < 0.7 ? 1 : -1);
    return turnDeg * frac;
  }

  addStress(amount: number): void { this.stress = Math.min(1.0, this.stress + amount * Number(this.c.stress_gain)); }
  update(dt: number): void { this.stress = Math.max(0.0, this.stress - dt / 4.0); }
  noise(): number { return Number(this.c.decision_noise) * (1.0 + this.stress); }

  mistake(kind: string): boolean {
    const p = Number(this.c[kind] ?? 0.0) * (1.0 + 0.5 * this.stress);
    return this.rng.random() < p;
  }

  radarInterval(): number {
    const [lo, hi] = this.c.radar_glance;
    return this.rng.uniform(lo, hi);
  }
}
