// What a bot perceives of its enemies: sight and sound. Vision runs a few times per second (staggered
// between bots). An enemy is seen when it is inside the bot's view cone (difficulty `fov`; a wider
// peripheral cone at close range), within range, not hidden by smoke, and a ray from the bot's eye reaches
// its head or chest. A flashed bot sees nothing until the flash wears off. Hearing uses the game's noise
// events: enemy noises within radius * hearing become a "sound" contact at a fuzzy position.
//
// A newly seen enemy only becomes a target once its reaction time has passed (humanize.ts): a lognormal
// draw with the profile's mean, faster for an enemy it just lost sight of or expected (its own knowledge put
// an enemy near there in the last 4 s), slower when busy with another enemy far from its aim.

import { MASK_SIGHT } from "@cs/shared/collision";
import { type V3, wrap180 } from "@cs/shared/math";
import type { Soldier } from "../sim/soldier";
import type { BotAgent } from "./bot";
import type { Humanizer } from "./humanize";
import type { BotKnowledge } from "./knowledge";

export class Contact {
  aimPoint: V3 = [0, 0, 0];
  headVisible = false;
  bodyVisible = false;
  constructor(
    public agent: Soldier,
    public pos: V3,              // last known feet position
    public time: number,         // when that was
    public source: string,       // sight | sound
    public seen = false,         // visible this scan
    public since = 0,            // start of the current continuous sighting
    public reactAt = 0,          // when the bot may start shooting at it
  ) {}
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export class Perception {
  bot: BotAgent;
  cfg: Record<string, any>;
  p: Record<string, any>;
  human: Humanizer;
  knowledge: BotKnowledge;
  contacts = new Map<number, Contact>();
  nextScan: number;
  blindUntil = 0;
  noiseSeen = 0;
  busyWith: number | null = null;     // uid of the enemy the brain is fighting

  constructor(bot: BotAgent, visionCfg: Record<string, any>, profile: Record<string, any>, humanizer: Humanizer, knowledge: BotKnowledge) {
    this.bot = bot;
    this.cfg = visionCfg;
    this.p = profile;
    this.human = humanizer;
    this.knowledge = knowledge;
    this.nextScan = bot.rng.uniform(0.0, Number(visionCfg.scan_interval ?? 0.1));
  }

  reset(): void {
    this.contacts.clear();
    this.blindUntil = 0;
  }

  get blind(): boolean { return this.bot.now < this.blindUntil; }

  update(now: number, enemies: Soldier[]): void {
    if (now >= this.nextScan) {
      this.nextScan = now + Number(this.cfg.scan_interval ?? 0.1);
      this.scan(now, enemies);
    }
    this.hear();
    // forget stale information
    for (const [k, c] of [...this.contacts]) if (!c.agent.alive || now - c.time > 25.0) this.contacts.delete(k);
  }

  private scan(now: number, enemies: Soldier[]): void {
    const bot = this.bot;
    const eye = bot.eye();
    const yaw = bot.aim.yaw * Math.PI / 180;
    const fx = -Math.sin(yaw), fy = Math.cos(yaw);
    const halfFov = Number(this.p.fov ?? 110) * 0.5 * Math.PI / 180;
    const halfPer = Number(this.cfg.peripheral ?? 160) * 0.5 * Math.PI / 180;
    const perRange = Number(this.cfg.peripheral_range ?? 14.0);
    const rngMax = Number(this.cfg.range ?? 90.0);
    const smokeBlock = Number(this.cfg.smoke_block ?? 0.55);
    const blind = this.blind;
    const game = bot.game;
    for (const e of enemies) {
      let c = this.contacts.get(e.uid);
      let visible = false, headVis = false, bodyVis = false;
      let point: V3 | null = null;
      if (e.alive && !blind) {
        const head = e.headPos();
        const chest = e.centerOfMass();
        const dx = chest[0] - eye[0], dy = chest[1] - eye[1], dz = chest[2] - eye[2];
        const dist = Math.hypot(dx, dy, dz);
        if (dist <= rngMax) {
          const hd = Math.hypot(dx, dy);
          const cosang = (dx * fx + dy * fy) / Math.max(hd, 1e-4);
          const ang = Math.acos(Math.max(-1.0, Math.min(1.0, cosang)));
          if (ang <= halfFov || (ang <= halfPer && dist <= perRange)) {
            headVis = this.clear(eye, head);
            bodyVis = this.clear(eye, chest);
            if (headVis || bodyVis) {
              const target = headVis && !bodyVis ? head : chest;
              if (game.smoke.between(eye, target) < smokeBlock) { visible = true; point = target; }
            }
          }
        }
      }
      if (visible) {
        if (!c || !c.seen) {
          const [lo, hi] = this.p.reaction ?? [0.3, 0.5];
          let react = this.human.reaction(lo, hi);
          const pos = e.position();
          if (c && now - c.time < 2.0 && c.source === "sight") react *= 0.4;   // just lost sight of it
          else if (this.expected(pos, now)) react *= 0.75;
          const busy = this.busyWith !== null && this.busyWith !== e.uid;
          if (busy) {
            const to = Math.atan2(-(pos[0] - eye[0]), pos[1] - eye[1]) * 180 / Math.PI;
            react *= this.human.attention(Math.abs(wrap180(to - bot.aim.yaw)), true);
          }
          c = new Contact(e, pos, now, "sight", true, now, now + react);
          this.contacts.set(e.uid, c);
          bot.onSpotted(e);
        }
        c.pos = e.position();
        c.time = now;
        c.source = "sight";
        c.seen = true;
        c.aimPoint = point as V3;
        c.headVisible = headVis;
        c.bodyVisible = bodyVis;
      } else if (c && c.seen) c.seen = false;
    }
  }

  private expected(pos: V3, now: number): boolean {
    for (const f of this.knowledge.recent(4.0, now)) if (Math.hypot(f.pos[0] - pos[0], f.pos[1] - pos[1]) <= f.radius + 6.0) return true;
    return false;
  }

  private clear(eye: V3, point: V3): boolean { return this.bot.game.world.ray(eye, point, MASK_SIGHT) === null; }

  private hear(): void {
    const bot = this.bot;
    const events = bot.game.noiseEvents;
    if (!events.length || events[events.length - 1].t <= this.noiseSeen) return;
    const pos = bot.position();
    const hear = Number(this.p.hearing ?? 1.0);
    let newest = this.noiseSeen;
    for (const ev of events) {
      if (ev.t <= this.noiseSeen) continue;
      newest = Math.max(newest, ev.t);
      const src = ev.source;
      if (!src || src === bot || src.side === bot.side || !src.alive) continue;
      const d = Math.hypot(ev.pos[0] - pos[0], ev.pos[1] - pos[1], ev.pos[2] - pos[2]);
      if (d > ev.radius * hear) continue;
      let c = this.contacts.get(src.uid);
      if (c && c.seen) continue;
      const fuzz = Math.min(d * 0.08, 4.0);
      const guess: V3 = [ev.pos[0] + bot.rng.uniform(-fuzz, fuzz), ev.pos[1] + bot.rng.uniform(-fuzz, fuzz), ev.pos[2]];
      if (!c) {
        c = new Contact(src, guess, ev.t, "sound");
        this.contacts.set(src.uid, c);
      } else if (ev.t >= c.time) {
        c.pos = guess; c.time = ev.t; c.source = "sound";
      }
      bot.onHeard(src, guess, ev.loudness);
    }
    this.noiseSeen = newest;
  }

  flashed(duration: number): void {
    this.blindUntil = Math.max(this.blindUntil, this.bot.now + duration);
    for (const c of this.contacts.values()) c.seen = false;
  }

  visible(): Contact[] { return [...this.contacts.values()].filter((c) => c.seen && c.agent.alive); }

  /** Visible enemy the bot has reacted to (closest first). */
  target(now: number): Contact | null {
    let best: Contact | null = null, bestD = 1e9;
    const me = this.bot.position();
    for (const c of this.contacts.values()) {
      if (c.seen && c.agent.alive && now >= c.reactAt) {
        const d = (c.pos[0] - me[0]) ** 2 + (c.pos[1] - me[1]) ** 2 + (c.pos[2] - me[2]) ** 2;
        if (d < bestD) { best = c; bestD = d; }
      }
    }
    return best;
  }

  latest(maxAge: number, now: number, sources = ["sight", "sound", "damage", "team"]): Contact | null {
    let best: Contact | null = null;
    for (const c of this.contacts.values()) {
      if (c.agent.alive && now - c.time <= maxAge && sources.includes(c.source)) if (!best || c.time > best.time) best = c;
    }
    return best;
  }

  threatDir(now: number): V3 | null {
    const c = this.latest(6.0, now);
    if (!c) return null;
    const me = this.bot.position();
    const dx = c.pos[0] - me[0], dy = c.pos[1] - me[1];
    const l = Math.hypot(dx, dy);
    return l * l > 1e-4 ? [dx / l, dy / l, 0] : null;
  }
}
