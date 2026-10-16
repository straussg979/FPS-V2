// The bots' team radio: callouts arrive late and only as precise as words. A sighting becomes a callout
// after a per-message delay (lognormal around `delay`, clipped, longer when stressed); its position is
// snapped to the nearest tactical point fuzzed by `fuzz` metres. Sightings in one area within `batch`
// seconds are spoken as one line ("Two B Long, one tagged"); "tagged" only comes from the speaker's own hit
// markers. Listeners can miss a call; a dying bot gets one last call out. Footsteps are called twice as vague.

import type { V3 } from "@cs/shared/math";
import type { Random } from "@cs/shared/rng";
import { Fact } from "./knowledge";
import type { TacticalMap } from "./tactical_map";

const NUMBERS: Record<number, string> = { 1: "One", 2: "Two", 3: "Three", 4: "Four", 5: "Five" };

interface Message { deliver: number; seq: number; fact: Fact; speaker: string }
export interface Speaker { name: string }
export interface RadioTeam {
  now(): number;
  radio(speaker: Speaker, text: string, key?: string | null, every?: number): void;
  onRadioFact(f: Fact, speaker: string): void;
  enemiesAlive: number;
}

export class Radio {
  team: RadioTeam;
  tm: TacticalMap;
  rng: Random;
  delay: number;
  delayRange: [number, number];
  fuzz: number;
  batch: number;
  miss: number;
  queue: Message[] = [];
  private seq = 0;
  private lastCall = new Map<string, number>();
  private pendingLines = new Map<string, { area: string; heard: boolean; t: number; enemies: Set<number>; hurt: number; speaker: Speaker }>();
  private said = new Map<string, number>();

  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  constructor(team: RadioTeam, tm: TacticalMap, rng: Random, cfg: Record<string, any> | null = null) {
    this.team = team;
    this.tm = tm;
    this.rng = rng;
    const c = cfg ?? {};
    this.delay = Number(c.delay ?? 0.55);
    this.delayRange = (c.delay_range ?? [0.3, 1.2]) as [number, number];
    this.fuzz = Number(c.fuzz ?? 2.5);
    this.batch = Number(c.batch ?? 0.6);
    this.miss = Number(c.miss ?? 0.0);
  }

  reset(): void {
    this.queue = [];
    this.lastCall.clear();
    this.pendingLines.clear();
  }

  drawDelay(stressed = false): number {
    const [lo, hi] = this.delayRange;
    let d = this.delay * Math.exp(this.rng.gauss(0.0, 0.35));
    if (stressed) d *= 1.4;
    return Math.max(lo, Math.min(hi * (stressed ? 1.4 : 1.0), d));
  }

  /** `speaker` saw (or heard) an enemy at pos: a callout later reaches the team. */
  sighting(speaker: Speaker, enemy: number, pos: ArrayLike<number>, now: number, hurt = false, stressed = false, every = 1.5, heard = false): boolean {
    const k = `${speaker.name}\u0000${enemy}`;
    if (now - (this.lastCall.get(k) ?? -99) < every) return false;
    this.lastCall.set(k, now);
    const i = this.tm.nearest(pos);
    const area = i >= 0 ? this.tm.area(i) : "";
    const base = i >= 0 ? this.tm.pl[i] : pos;
    const a = this.rng.uniform(0, 2 * Math.PI);
    const r = this.fuzz * Math.sqrt(this.rng.random());
    const snapped: V3 = [base[0] + Math.cos(a) * r, base[1] + Math.sin(a) * r, base[2]];
    const fuzz = this.fuzz * (heard ? 2.0 : 1.0);
    const f = new Fact(enemy, snapped, fuzz + 1.0, now, "radio", { by: speaker.name, hurt, area });
    this.push(f, now + this.drawDelay(stressed), speaker.name);
    const lk = `${area}\u0000${heard}`;
    let line = this.pendingLines.get(lk);
    if (!line) this.pendingLines.set(lk, (line = { area, heard, t: now, enemies: new Set(), hurt: 0, speaker }));
    line.enemies.add(enemy);
    line.hurt += hurt ? 1 : 0;
    return true;
  }

  /** A dying bot that saw its killer gets one call out. */
  lastWords(speaker: Speaker, killer: number, pos: ArrayLike<number>, now: number, hurt: boolean): void {
    this.lastCall.delete(`${speaker.name}\u0000${killer}`);
    this.sighting(speaker, killer, pos, now, hurt, true, 0.0);
  }

  say(speaker: Speaker, text: string, key: string | null = null, every = 4.0): boolean {
    const k = `${speaker.name}:${key ?? text}`;
    const now = this.team.now();
    if (now - (this.said.get(k) ?? -99) < every) return false;
    this.said.set(k, now);
    this.team.radio(speaker, text, key, 0.5);
    return true;
  }

  private push(f: Fact, when: number, speaker: string): void {
    this.seq++;
    const m = { deliver: when, seq: this.seq, fact: f, speaker };
    // the queue stays sorted by (deliver, seq); it is short
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1].deliver > when) i--;
    this.queue.splice(i, 0, m);
  }

  update(now: number): Fact[] {
    const out: Fact[] = [];
    while (this.queue.length && this.queue[0].deliver <= now) {
      const m = this.queue.shift() as Message;
      if (this.miss > 0.0 && this.rng.random() < this.miss) continue;
      out.push(m.fact);
      this.team.onRadioFact(m.fact, m.speaker);
    }
    // spoken summary lines, once the batch window has passed
    for (const [key, ln] of [...this.pendingLines]) {
      if (now - ln.t < this.batch) continue;
      this.pendingLines.delete(key);
      const n = ln.enemies.size;
      if (ln.heard) {
        this.team.radio(ln.speaker, `Footsteps ${ln.area || "close"}`, `steps:${ln.area}`, 8.0);
        continue;
      }
      let text = `${NUMBERS[n] ?? String(n)} ${ln.area || "here"}`;
      if (ln.hurt) text += ln.hurt === 1 ? ", one tagged" : `, ${ln.hurt} tagged`;
      if (this.team.enemiesAlive === 1 && n === 1) text = `Last one ${ln.area || "here"}` + (ln.hurt ? ", he's low" : "");
      this.team.radio(ln.speaker, text, `call:${ln.area}`, 3.0);
    }
    return out;
  }
}
