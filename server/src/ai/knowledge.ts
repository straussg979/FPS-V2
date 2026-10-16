// What a bot knows about its enemies, and where it learned it. Every piece of information is a Fact with
// its source and precision:
//   sight   the bot sees the enemy (Perception's vision scan); exact
//   sound   footsteps, shots, grenades heard: the position gets fuzzier with distance
//   damage  shot by an enemy the bot did not see: only the direction the shot came from, with a guessed range
//   radio   a teammate's callout: area precision, delayed (comms.ts)
//   radar   a glance at the HUD radar, which shows every enemy a teammate spots, for 3 s
//   intel   pings from drones, cameras and gadgets
// Nothing here ever asks an enemy where it is; Perception's vision scan is the only code that does.

import type { V3 } from "@cs/shared/math";

export const PRECISION: Record<string, number> = { sight: 0.3, radar: 1.0, intel: 1.0, radio: 3.5 };

export class Fact {
  speed: number;                          // how fast it could be moving since
  by: string;                             // who reported it
  hurt: boolean;                          // "tagged": damaged by the reporter (hit markers)
  direction: V3 | null;                   // damage: unit vector from the victim towards the shooter
  area: string;

  constructor(
    public enemy: number | null,          // uid of the enemy, null when unknown
    public pos: V3,                       // estimated feet position
    public radius: number,                // uncertainty (m)
    public time: number,                  // when it was true
    public source: string,                // sight | sound | damage | radio | radar | intel
    opts: { speed?: number; by?: string; hurt?: boolean; direction?: V3 | null; area?: string } = {},
  ) {
    this.speed = opts.speed ?? 5.4;
    this.by = opts.by ?? "";
    this.hurt = opts.hurt ?? false;
    this.direction = opts.direction ?? null;
    this.area = opts.area ?? "";
  }

  age(now: number): number { return now - this.time; }
  /** How far from pos the enemy can be by now. */
  reach(now: number): number { return this.radius + this.speed * Math.max(now - this.time, 0.0); }
}

interface KBot {
  position(): V3;
  perception: { contacts: Map<number, { seen: boolean; pos: V3; source: string; time: number }> };
}

export class BotKnowledge {
  bot: KBot;
  facts = new Map<number, Fact>();        // latest fact per enemy
  anonymous: Fact[] = [];                 // unknown enemies (damage from an unseen shooter)
  damageDealt = new Map<number, number>();
  radarNext = 0;
  private heardT = new Map<number, number>();
  heard: Fact[] = [];
  aliveEnemies = 5;

  constructor(bot: KBot) { this.bot = bot; }

  reset(): void {
    this.facts.clear();
    this.anonymous = [];
    this.damageDealt.clear();
    this.heardT.clear();
    this.heard = [];
    this.radarNext = 0;
  }

  add(f: Fact): boolean {
    if (f.enemy === null) {
      this.anonymous.push(f);
      if (this.anonymous.length > 8) this.anonymous = this.anonymous.slice(-8);
      return true;
    }
    const old = this.facts.get(f.enemy);
    if (old) {
      // a newer but vaguer fact does not replace a sharper one that is still as good
      if (f.time < old.time) return false;
      if (old.source === "sight" && f.source !== "sight" && old.reach(f.time) <= f.radius) return false;
    }
    this.facts.set(f.enemy, f);
    return true;
  }

  /** New sight and sound facts from the bot's own Perception; returns the sightings. */
  fromPerception(now: number): Fact[] {
    const seen: Fact[] = [];
    for (const [key, c] of this.bot.perception.contacts) {
      if (c.seen) {
        const f = new Fact(key, [c.pos[0], c.pos[1], c.pos[2]], PRECISION.sight, now, "sight", { speed: 5.4 });
        this.facts.set(key, f);
        seen.push(f);
      } else if (c.source === "sound" && c.time > (this.heardT.get(key) ?? -1)) {
        this.heardT.set(key, c.time);
        const me = this.bot.position();
        const d = Math.hypot(c.pos[0] - me[0], c.pos[1] - me[1]);
        const f = new Fact(key, [c.pos[0], c.pos[1], c.pos[2]], Math.min(d * 0.08, 4.0) + 1.0, c.time, "sound");
        this.add(f);
        this.heard.push(f);
      }
    }
    return seen;
  }

  popHeard(): Fact[] {
    const out = this.heard;
    this.heard = [];
    return out;
  }

  /** Hit by an enemy the bot cannot see: only the direction is known (the bullet's travel direction). */
  onShot(direction: V3, now: number, guess = 15.0): Fact {
    const p = this.bot.position();
    let dx = direction[0], dy = direction[1];
    if (dx * dx + dy * dy < 1e-6) { dx = 0; dy = 1; }
    const l = Math.hypot(dx, dy);
    const back: V3 = [-dx / l, -dy / l, 0];
    const f = new Fact(null, [p[0] + back[0] * guess, p[1] + back[1] * guess, p[2]], guess * 0.8, now, "damage", { direction: back });
    this.anonymous.push(f);
    return f;
  }

  onHitEnemy(enemy: number, damage: number): void {
    this.damageDealt.set(enemy, (this.damageDealt.get(enemy) ?? 0) + damage);
  }

  /** A glance at the HUD radar: the team's sightings of the last 3 s. */
  radar(now: number, sightings: Array<[number, number, V3]>): number {
    let n = 0;
    for (const [t, key, pos] of sightings) {
      if (now - t <= 3.0) n += this.add(new Fact(key, [pos[0], pos[1], pos[2]], PRECISION.radar, t, "radar")) ? 1 : 0;
    }
    return n;
  }

  forget(enemy: number): void { this.facts.delete(enemy); }

  latest(maxAge: number, now: number, sources: string[] | null = null): Fact | null {
    let best: Fact | null = null;
    for (const f of [...this.facts.values(), ...this.anonymous]) {
      if (now - f.time <= maxAge && (!sources || sources.includes(f.source))) {
        if (!best || f.time > best.time) best = f;
      }
    }
    return best;
  }

  recent(maxAge: number, now: number, sources: string[] | null = null): Fact[] {
    return [...this.facts.values(), ...this.anonymous].filter((f) => now - f.time <= maxAge && (!sources || sources.includes(f.source)));
  }

  nearest(maxAge: number, now: number, sources: string[] | null = null): Fact | null {
    const me = this.bot.position();
    let best: Fact | null = null, bd = 1e9;
    for (const f of this.recent(maxAge, now, sources)) {
      const d = Math.hypot(f.pos[0] - me[0], f.pos[1] - me[1]);
      if (d < bd) { best = f; bd = d; }
    }
    return best;
  }

  hurt(enemy: number, threshold = 40.0): boolean { return (this.damageDealt.get(enemy) ?? 0) >= threshold; }
}

export function factPoint(f: Fact, height = 1.45): V3 { return [f.pos[0], f.pos[1], f.pos[2] + height]; }
