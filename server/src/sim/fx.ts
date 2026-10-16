// Presentation hooks: what the simulation shows and plays. Gameplay code never draws anything; it calls
// game.fx. The server records every call as an event for the browsers that may perceive it (the snapshot
// builder filters and encodes them). `listeners` are the in-game ears: the v2 attackers hear a defuse start.

import type { V3 } from "@cs/shared/math";

export interface FxEvent { kind: string; [k: string]: unknown }

export class RecordingFx {
  static MAX_EVENTS = 4096;
  events: FxEvent[] = [];
  listeners: Array<(name: string, pos: V3) => void> = [];

  private add(kind: string, data: Record<string, unknown>): void {
    if (this.events.length < RecordingFx.MAX_EVENTS) this.events.push({ kind, ...data });
  }

  drain(): FxEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  playAt(name: string, pos: ArrayLike<number>, volume = 1.0): void {
    const p: V3 = [pos[0], pos[1], pos[2]];
    for (const cb of this.listeners) cb(name, p);
    this.add("sound", { name, pos: p, volume });
  }

  playShot(profile: string, pos: ArrayLike<number>, shooter: unknown): void {
    this.add("shot_sound", { profile, pos: [pos[0], pos[1], pos[2]], shooter });
  }

  footstep(surface: string, pos: ArrayLike<number>, loudness: number, who: unknown = null): void {
    this.add("footstep", { surface, pos: [pos[0], pos[1], pos[2]], loudness, who });
  }

  /** A non-positional sound for one participant (buy, ping, radio click). */
  ui(name: string, volume = 0.7, to: unknown = null): void { this.add("ui", { name, volume, to }); }
  sting(name: string, volume = 1.0, to: unknown = null): void { this.add("sting", { name, volume, to }); }

  impact(pos: ArrayLike<number>, normal: ArrayLike<number>, surface: string, exitHole = false): void {
    this.add("impact", { pos: [pos[0], pos[1], pos[2]], normal: [normal[0], normal[1], normal[2]], surface, exit: exitHole });
  }

  tracer(start: ArrayLike<number>, end: ArrayLike<number>): void {
    this.add("tracer", { start: [start[0], start[1], start[2]], end: [end[0], end[1], end[2]] });
  }

  explosion(pos: ArrayLike<number>, radius: number, big = false): void {
    this.add(big ? "big_explosion" : "explosion", { pos: [pos[0], pos[1], pos[2]], radius });
  }

  flashbang(pos: ArrayLike<number>): void { this.add("flashbang", { pos: [pos[0], pos[1], pos[2]] }); }
  empBurst(pos: ArrayLike<number>, radius: number): void { this.add("emp", { pos: [pos[0], pos[1], pos[2]], radius }); }
  sparks(pos: ArrayLike<number>, n = 10): void { this.add("sparks", { pos: [pos[0], pos[1], pos[2]], n }); }

  // per participant
  hitMarker(to: unknown, killed = false, headshot = false): void { this.add("hit_marker", { to, killed, headshot }); }
  blind(to: unknown, duration: number, strength: number): void { this.add("blind", { to, duration, strength }); }
  damageFrom(to: unknown, source: ArrayLike<number>, amount: number): void {
    this.add("damage_from", { to, source: [source[0], source[1], source[2]], amount });
  }
  message(to: unknown, text: string): void { this.add("message", { to, text }); }
}
