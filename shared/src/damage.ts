// Health, armour and damage resolution (CS-style armour model). Body armour protects chest, stomach and
// arms; the helmet protects the head. For a protected hit:
//   health_damage = damage * armor_penetration
//   armor_damage  = (damage - health_damage) * absorb_ratio
//   if the armour runs out, the unabsorbed remainder goes to health.

import type { V3 } from "./math";

const ARMORED_GROUPS = new Set(["chest", "stomach", "arm"]);

export interface DamageInfo {
  amount: number;
  armorPenetration: number;
  hitgroup: string;
  kind: "bullet" | "melee" | "explosion" | "fall";
  attacker: unknown;
  weapon: string;
  pos: V3;
  direction: V3;
  penetrated: number;
  headshot: boolean;
}

export function damageInfo(p: Partial<DamageInfo> & { amount: number }): DamageInfo {
  return { armorPenetration: 1, hitgroup: "chest", kind: "bullet", attacker: null, weapon: "", pos: [0, 0, 0],
    direction: [0, 0, 0], penetrated: 0, headshot: false, ...p };
}

export interface DamageResult {
  health: number;
  armor: number;
  killed: boolean;
  hitgroup: string;
  info: DamageInfo;
}

export class Damageable {
  health = 100;
  maxHealth = 100;
  armor = 0;
  helmet = false;
  alive = true;
  absorbRatio = 0.5;
  name: string;
  team: string;
  onDamage: Array<(r: DamageResult) => void> = [];
  /** Veto (friendly fire, freeze time): return false to ignore the hit. */
  filter: ((d: Damageable, info: DamageInfo) => boolean) | null = null;

  constructor(name = "", team = "", health = 100) {
    this.name = name;
    this.team = team;
    this.health = this.maxHealth = health;
  }

  protected(hitgroup: string, kind: string): boolean {
    if (this.armor <= 0) return false;
    if (kind === "explosion") return true;
    if (hitgroup === "head") return this.helmet;
    return ARMORED_GROUPS.has(hitgroup);
  }

  takeDamage(info: DamageInfo): DamageResult | null {
    if (!this.alive) return null;
    if (this.filter && !this.filter(this, info)) return null;
    const dmg = Math.max(info.amount, 0);
    let healthDmg = dmg;
    let armorDmg = 0;
    if (this.protected(info.hitgroup, info.kind)) {
      healthDmg = dmg * info.armorPenetration;
      armorDmg = (dmg - healthDmg) * this.absorbRatio;
      if (armorDmg > this.armor) {
        const overflow = (armorDmg - this.armor) / Math.max(this.absorbRatio, 1e-6);
        healthDmg += overflow;
        armorDmg = this.armor;
      }
      this.armor -= armorDmg;
      if (this.armor <= 0) {
        this.armor = 0;
        this.helmet = false;
      }
    }
    healthDmg = Math.min(healthDmg, this.health);
    this.health -= healthDmg;
    const killed = this.health <= 0;
    if (killed) {
      this.health = 0;
      this.alive = false;
    }
    const result: DamageResult = { health: healthDmg, armor: armorDmg, killed, hitgroup: info.hitgroup, info };
    for (const cb of this.onDamage.slice()) cb(result);
    return result;
  }

  reset(health?: number, armor?: number, helmet?: boolean): void {
    this.health = health ?? this.maxHealth;
    if (armor !== undefined) this.armor = armor;
    if (helmet !== undefined) this.helmet = helmet;
    this.alive = true;
  }
}

/** CS-style exponential range falloff: multiplier per 10 m travelled. */
export function falloff(damage: number, rangeModifier: number, distance: number): number {
  return damage * rangeModifier ** (distance / 10);
}
