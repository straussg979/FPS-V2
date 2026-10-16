// The breach charge: carried by an attacker, planted at a bomb site, defused by a defender or detonated
// when its timer runs out. States: none -> carried <-> dropped -> planted -> (defused | exploded). While
// planted it beeps faster and faster. The detonation hurts everyone in range with a Gaussian falloff,
// through walls (as in CS).

import { MASK_SIGHT } from "@cs/shared/collision";
import { type Json } from "@cs/shared/data";
import { damageInfo } from "@cs/shared/damage";
import type { V3 } from "@cs/shared/math";
import type { ServerGame } from "./game";
import type { Soldier } from "./soldier";

export function bombDamage(distance: number, maxDamage: number, sigma: number, radius: number): number {
  if (distance >= radius) return 0;
  return maxDamage * Math.exp(-distance * distance / (2 * sigma * sigma));
}

export function beepInterval(timeLeft: number, total: number, slow: number, fast: number): number {
  const frac = Math.max(Math.min(timeLeft / Math.max(total, 1e-3), 1), 0);
  return fast + (slow - fast) * frac ** 1.4;
}

export type BombState = "none" | "carried" | "dropped" | "planted" | "defused" | "exploded";

export class Bomb {
  game: ServerGame;
  cfg: Json;
  timers: Json;
  state: BombState = "none";
  carrier: Soldier | null = null;
  pos: V3 = [0, 0, 0];
  heading = 0;
  site = "";
  private beepT = 0;

  constructor(game: ServerGame, rules: Json) {
    this.game = game;
    this.cfg = rules.bomb;
    this.timers = rules.timers;
  }

  setRules(rules: Json): void {
    this.cfg = rules.bomb;
    this.timers = rules.timers;
  }

  reset(): void {
    this.state = "none";
    this.carrier = null;
    this.site = "";
  }

  give(agent: Soldier): void {
    this.state = "carried";
    this.carrier = agent;
  }

  drop(pos: V3): void {
    this.state = "dropped";
    this.carrier = null;
    this.pos = this.ground(pos);
    this.heading = 37;
  }

  tryPickup(agent: Soldier, feet: V3): boolean {
    if (this.state !== "dropped" || agent.side !== "attack" || !agent.alive) return false;
    if (Math.hypot(feet[0] - this.pos[0], feet[1] - this.pos[1]) > 1.1 || Math.abs(feet[2] - this.pos[2]) > 1.2) return false;
    this.give(agent);
    return true;
  }

  plant(pos: V3, heading: number, site: string): void {
    this.state = "planted";
    this.carrier = null;
    this.site = site;
    this.pos = this.ground(pos);
    this.heading = heading;
    this.beepT = 0;
    this.game.fx.playAt("bomb_planted", this.pos, 1);
  }

  defused(): void {
    this.state = "defused";
    this.game.fx.playAt("bomb_defused", this.pos, 1);
  }

  explode(): void {
    const g = this.game;
    this.state = "exploded";
    g.fx.explosion([this.pos[0], this.pos[1], this.pos[2] + 0.3], 20, true);
    g.fx.playAt("explosion", this.pos, 1);
    g.notifyNoise(this.pos, 1, 120, null);
    const center: V3 = [this.pos[0], this.pos[1], this.pos[2] + 0.5];
    g.destruction.explosion(center, Number(this.cfg.wall_damage ?? 900), Number(this.cfg.wall_radius ?? 4.5));
    g.director?.tactical.onExplosion(center, 8);
    for (const target of g.damageables()) {
      if (!target.damageable.alive) continue;
      const tc = target.centerOfMass();
      const dv: V3 = [tc[0] - center[0], tc[1] - center[1], tc[2] - center[2]];
      const dist = Math.hypot(dv[0], dv[1], dv[2]);
      const dmg = bombDamage(dist, Number(this.cfg.max_damage), Number(this.cfg.sigma), Number(this.cfg.radius));
      if (dmg <= 0.5) continue;
      const k = 1 / Math.max(dist, 1e-3);
      const d: V3 = [dv[0] * k, dv[1] * k, dv[2] * k];
      const res = target.damageable.takeDamage(damageInfo({ amount: dmg, armorPenetration: 0.6, hitgroup: "chest", kind: "explosion",
        attacker: null, weapon: "bomb", pos: tc, direction: d }));
      if (res) target.onHit?.(res, tc, d);
    }
  }

  /** The beeps (game state: the attackers hear them, the timer drives them). */
  fixedUpdate(dt: number, timeLeft: number): void {
    if (this.state !== "planted") return;
    this.beepT -= dt;
    if (this.beepT <= 0) {
      this.beepT = beepInterval(timeLeft, Number(this.timers.bomb_timer), Number(this.cfg.beep_slow), Number(this.cfg.beep_fast));
      this.game.fx.playAt("bomb_beep", this.pos, 0.9);
    }
  }

  /** Is the player close enough and looking at the planted charge? */
  defuseTarget(eye: V3, direction: V3): boolean {
    if (this.state !== "planted") return false;
    const to: V3 = [this.pos[0] - eye[0], this.pos[1] - eye[1], this.pos[2] + 0.1 - eye[2]];
    const dist = Math.hypot(to[0], to[1], to[2]);
    const range = Number(this.cfg.defuse_range);
    if (dist > range + 1) return false;
    if (Math.hypot(eye[0] - this.pos[0], eye[1] - this.pos[1]) > range) return false;
    return (to[0] * direction[0] + to[1] * direction[1] + to[2] * direction[2]) / Math.max(dist, 1e-9) > Math.cos(40 * Math.PI / 180);
  }

  private ground(p: V3): V3 {
    const hit = this.game.world.ray([p[0], p[1], p[2] + 0.5], [p[0], p[1], p[2] - 3], MASK_SIGHT);
    return hit ? [...hit.pos] as V3 : [...p] as V3;
  }
}
