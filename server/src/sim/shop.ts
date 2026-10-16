// Buying: the catalogue (weapons.json + match.json) and the purchase rules (buy zone, buy time, team items,
// carry limits, refunds). Every agent buys into its own inventory; refunds are for players, in buy time.

import type { Json } from "@cs/shared/data";
import type { WeaponDatabase, WeaponState } from "@cs/shared/weapons";
import type { MatchDirector } from "./director";
import type { Soldier } from "./soldier";

export const CATEGORIES: Array<[string, string]> = [["pistols", "Pistols"], ["smgs", "SMGs"], ["rifles", "Rifles"], ["heavy", "Heavy"],
  ["grenades", "Grenades"], ["gear", "Gear"]];

export interface ShopItem { key: string; kind: "weapon" | "grenade" | "equipment"; name: string; price: number; category: string;
  teams: string[]; info: string }

export function catalogue(db: WeaponDatabase, rules: Json, side: string): Record<string, ShopItem[]> {
  const cats: Record<string, ShopItem[]> = Object.fromEntries(CATEGORIES.map(([c]) => [c, []]));
  for (const [key, w] of Object.entries(db.weapons)) {
    if (!w.buyCategory || !w.teams.includes(side)) continue;
    const info = `${w.damage.toFixed(0)} dmg  |  ${w.rpm.toFixed(0)} rpm  |  ${w.magazine} rds  |  ` +
      `armour pen ${(w.armorPenetration * 100).toFixed(0)}%  |  kill $${w.killReward}`;
    cats[w.buyCategory].push({ key, kind: "weapon", name: w.name, price: w.price, category: w.buyCategory, teams: w.teams, info });
  }
  for (const [key, g] of Object.entries(db.grenades)) {
    cats.grenades.push({ key, kind: "grenade", name: g.name, price: g.price, category: "grenades", teams: ["attack", "defend"],
      info: `carry ${g.maxCarry}  |  kill $${g.raw.kill_reward ?? 300}` });
  }
  for (const [key, e] of Object.entries(rules.equipment ?? {}) as Array<[string, Json]>) {
    const teams: string[] = e.teams ?? ["attack", "defend"];
    if (!teams.includes(side)) continue;
    cats.gear.push({ key, kind: "equipment", name: e.name, price: Number(e.price), category: "gear", teams, info: e.info ?? "" });
  }
  for (const items of Object.values(cats)) items.sort((a, b) => a.price - b.price);
  return cats;
}

export function findItem(db: WeaponDatabase, rules: Json, side: string, key: string): ShopItem | null {
  for (const items of Object.values(catalogue(db, rules, side))) for (const it of items) if (it.key === key) return it;
  return null;
}

export class Shop {
  director: MatchDirector;
  private boughtLog = new Map<Soldier, Array<[string, number, WeaponState | string | null]>>();

  constructor(director: MatchDirector) {
    this.director = director;
  }

  get rules(): Json { return this.director.rules; }
  newRound(): void { this.boughtLog.clear(); }

  boughtBy(agent: Soldier): Array<[string, number, WeaponState | string | null]> {
    let l = this.boughtLog.get(agent);
    if (!l) this.boughtLog.set(agent, (l = []));
    return l;
  }

  price(agent: Soldier, item: ShopItem): number {
    if (item.key === "kevlar_helmet") {
      const d = agent.damageable;
      if (d.armor >= 100 && !d.helmet) return Number(this.rules.equipment.kevlar_helmet.helmet_upgrade_price ?? 350);
    }
    return item.price;
  }

  check(agent: Soldier, item: ShopItem): [boolean, string] {
    const d = this.director;
    const db = d.game.weaponDb;
    if (!agent.alive) return [false, "dead"];
    if (!d.match.canBuy()) return [false, "buy time is over"];
    if (!d.inBuyZone(agent)) return [false, "not in the buy zone"];
    if (!item.teams.includes(agent.side)) return [false, "not available to your team"];
    const inv = agent.weapons.inv;
    const dmg = agent.damageable;
    if (item.kind === "weapon") {
      const ws = inv.weapons[db.weapons[item.key].slot];
      if (ws && ws.d.key === item.key) return [false, "already carried"];
    } else if (item.kind === "grenade") {
      const g = db.grenades[item.key];
      if ((inv.grenades[item.key] ?? 0) >= g.maxCarry) return [false, "carrying the maximum"];
      if (inv.grenadeCount() >= Number(this.rules.grenade_limit ?? 4)) return [false, "grenade limit reached"];
    } else if (item.key === "kevlar" && dmg.armor >= 100) return [false, "already wearing armour"];
    else if (item.key === "kevlar_helmet" && dmg.armor >= 100 && dmg.helmet) return [false, "already wearing armour and helmet"];
    else if (item.key === "defuse_kit" && agent.hasKit) return [false, "already carried"];
    else if (item.key === "wall_charge") {
      const [ok, why] = d.tactical.canBuyCharge(agent);
      if (!ok) return [false, why];
    }
    if (agent.money < this.price(agent, item)) return [false, "not enough money"];
    return [true, ""];
  }

  buy(agent: Soldier, item: ShopItem): [boolean, string] {
    const [ok, why] = this.check(agent, item);
    if (!ok) return [false, why];
    const price = this.price(agent, item);
    agent.money -= price;
    const weapons = agent.weapons;
    const inv = weapons.inv;
    let bought: WeaponState | string | null = null;
    if (item.kind === "weapon") {
      const wdef = this.director.game.weaponDb.weapons[item.key];
      const old = inv.weapons[wdef.slot];
      if (old) weapons.dropWeaponState(old);
      const ws = inv.make(item.key);
      bought = ws;
      inv.weapons[wdef.slot] = ws;
      weapons.select(wdef.slot, true);
    } else if (item.kind === "grenade") {
      inv.giveGrenade(item.key, 1);
      bought = item.key;
      if (inv.slot === "melee" && !inv.has("primary") && !inv.has("secondary")) weapons.select("grenade", true);
    } else if (item.key === "kevlar" || item.key === "kevlar_helmet") {
      agent.damageable.armor = 100;
      if (item.key === "kevlar_helmet") agent.damageable.helmet = true;
    } else if (item.key === "defuse_kit") agent.hasKit = true;
    else if (item.key === "wall_charge") this.director.tactical.buyCharge(agent);
    if (agent.isHuman) {
      this.boughtBy(agent).push([item.key, price, bought]);
      this.director.game.fx.ui("buy", 0.6, agent);
    }
    return [true, `bought ${item.name} ($${price})`];
  }

  canRefund(agent: Soldier, item: ShopItem): boolean {
    if (!this.director.match.canBuy() || !this.director.inBuyZone(agent)) return false;
    const inv = agent.weapons.inv;
    const log = this.boughtBy(agent);
    for (let i = log.length - 1; i >= 0; i--) {
      const [key, , obj] = log[i];
      if (key !== item.key) continue;
      if (item.kind === "weapon") return Object.values(inv.weapons).includes(obj as WeaponState);
      if (item.kind === "grenade") return (inv.grenades[key] ?? 0) > 0;
    }
    return false;
  }

  refund(agent: Soldier, item: ShopItem): boolean {
    if (!this.canRefund(agent, item)) return false;
    const weapons = agent.weapons;
    const inv = weapons.inv;
    const log = this.boughtBy(agent);
    for (let i = log.length - 1; i >= 0; i--) {
      const [key, price] = log[i];
      if (key !== item.key) continue;
      if (item.kind === "weapon") {
        inv.weapons[this.director.game.weaponDb.weapons[key].slot] = null;
        weapons.select(inv.bestSlot(), true);
      } else if (item.kind === "grenade") {
        inv.grenades[key] -= 1;
        if (inv.grenades[key] <= 0) delete inv.grenades[key];
        if (inv.slot === "grenade" && !inv.has("grenade")) weapons.select(inv.bestSlot(), true);
      }
      agent.money += price;
      log.splice(i, 1);
      return true;
    }
    return false;
  }
}
