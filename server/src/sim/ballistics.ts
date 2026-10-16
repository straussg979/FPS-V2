// Hitscan ballistics with material-based wall penetration. A bullet is a segment from the shooter's eye;
// every solid on it is an interval [t_in, t_out] (overlapping world solids are merged). Walking them:
//   * a hit box -> damage (range falloff, hit-group multiplier, armour) and stop;
//   * a world solid -> an entry impact; crossing it costs thickness_cm * surface.pen_cost of the weapon's
//     penetration budget. Out of budget the bullet stops; otherwise it loses damage, leaves an exit
//     impact and carries on.

import { type DamageResult, damageInfo, falloff } from "@cs/shared/damage";
import { surfaceProps } from "@cs/shared/data";
import type { V3 } from "@cs/shared/math";
import type { WeaponDatabase, WeaponDef } from "@cs/shared/weapons";
import type { HitInterval } from "./types";

const MAX_CROSSINGS = 4;

export interface Impact {
  pos: V3;
  normal: V3;
  surface: string;
  exit: boolean;
  character: boolean;
  hitgroup: string;
  distance: number;
}

export interface ShotResult {
  impacts: Impact[];
  damage: DamageResult[];
  end: V3;
  penetrations: number;
  hitOwners: unknown[];
}

export interface BallisticsHost {
  intervals(origin: V3, end: V3, ignoreOwner: unknown): HitInterval[];
  panelBulletHit(panel: number, pos: V3, dir: V3, damage: number, pellets: number): void;
}

export class Ballistics {
  db: WeaponDatabase;
  host: BallisticsHost;

  constructor(db: WeaponDatabase, host: BallisticsHost) {
    this.db = db;
    this.host = host;
  }

  surface(name: string) { return surfaceProps(name); }

  fire(origin: V3, direction: V3, w: WeaponDef, attacker: unknown, damageScale = 1): ShotResult {
    const l0 = Math.hypot(direction[0], direction[1], direction[2]) || 1;
    const d: V3 = [direction[0] / l0, direction[1] / l0, direction[2] / l0];
    const length = w.maxRange;
    const end: V3 = [origin[0] + d[0] * length, origin[1] + d[1] * length, origin[2] + d[2] * length];
    const at = (t: number): V3 => [origin[0] + d[0] * t * length, origin[1] + d[1] * t * length, origin[2] + d[2] * t * length];
    const result: ShotResult = { impacts: [], damage: [], end: [...end] as V3, penetrations: 0, hitOwners: [] };
    const intervals = this.host.intervals(origin, end, attacker).sort((a, b) => a.tIn - b.tIn);
    let power = w.penetration;
    let damage = w.damage * damageScale;
    let crossed = 0;
    let cursor = 0;
    let i = 0;
    const n = intervals.length;
    while (i < n) {
      const iv = intervals[i];
      if (iv.tOut <= cursor + 1e-6) { i++; continue; }
      const dist = Math.max(iv.tIn, cursor) * length;
      if (iv.owner) {
        const hitgroup = iv.hitgroup || "chest";
        const dmg = falloff(damage, w.rangeModifier, dist) * this.db.hitgroupMultiplier(hitgroup, w);
        result.impacts.push({ pos: iv.inPos, normal: iv.inNormal, surface: iv.surface || "flesh", exit: false, character: true,
          hitgroup, distance: dist });
        const res = iv.owner.damageable.takeDamage(damageInfo({ amount: dmg, armorPenetration: w.armorPenetration, hitgroup,
          kind: "bullet", attacker, weapon: w.key, pos: iv.inPos, direction: d, penetrated: crossed, headshot: hitgroup === "head" }));
        if (res) {
          result.damage.push(res);
          result.hitOwners.push(iv.owner);
          iv.owner.onHit?.(res, iv.inPos, d);
        }
        result.end = [...iv.inPos] as V3;
        result.penetrations = crossed;
        return result;
      }
      // a world solid: merge everything overlapping into one segment
      const entryNew = iv.tIn >= cursor - 1e-6;
      const surf = this.surface(iv.surface);
      if (entryNew) {
        result.impacts.push({ pos: iv.inPos, normal: iv.inNormal, surface: iv.surface, exit: false, character: false, hitgroup: "",
          distance: dist });
        if (iv.body?.panel !== undefined) this.host.panelBulletHit(iv.body.panel, iv.inPos, d, damage, w.pellets);
      }
      const segStart = Math.max(iv.tIn, cursor);
      let segEnd = iv.tOut;
      let cost = (segEnd - segStart) * length * 100 * surf.pen_cost;
      let keep = surf.damage_keep ?? 0.85;
      let exitIv = iv;
      let j = i + 1;
      while (j < n && intervals[j].tIn <= segEnd + 1e-5 && !intervals[j].owner) {
        const nxt = intervals[j];
        if (nxt.tOut > segEnd) {
          const s2 = this.surface(nxt.surface);
          cost += (nxt.tOut - segEnd) * length * 100 * s2.pen_cost;
          keep = Math.min(keep, s2.damage_keep ?? 0.85);
          segEnd = nxt.tOut;
          exitIv = nxt;
        }
        j++;
      }
      if (segEnd >= 1 - 1e-6 || exitIv.outPos === null || cost >= power || crossed >= MAX_CROSSINGS) {
        result.end = entryNew ? [...iv.inPos] as V3 : at(segStart);
        result.penetrations = crossed;
        return result;
      }
      damage *= keep * (1 - 0.6 * cost / Math.max(power, 1e-6));
      power -= cost;
      crossed++;
      result.impacts.push({ pos: exitIv.outPos, normal: exitIv.outNormal as V3, surface: exitIv.surface, exit: true, character: false,
        hitgroup: "", distance: segEnd * length });
      cursor = segEnd;
      i = j;
      if (damage < 1) {
        result.end = [...exitIv.outPos] as V3;
        result.penetrations = crossed;
        return result;
      }
    }
    result.penetrations = crossed;
    return result;
  }
}
