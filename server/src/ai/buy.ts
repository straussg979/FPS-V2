// Bot purchases: a team-wide buy decision, then each bot spends its money. The team decides like a CS team:
// pistol round (first round of each half): armour or utility; full buy when the team can afford rifles and
// armour on average; eco when it cannot, so the loss bonus builds up; force buy in between, or when losing
// the round would lose the match. A rich bot always buys even during a team eco. One bot per team is the
// designated sniper when it can afford the SR-90 with armour.

import type { Json } from "@cs/shared/data";
import type { Match } from "@cs/shared/match";
import type { Random } from "@cs/shared/rng";
import type { WeaponDatabase } from "@cs/shared/weapons";
import { type Shop, findItem } from "../sim/shop";
import type { BotAgent } from "./bot";

export const PRIMARY_BY_SIDE: Record<string, string> = { attack: "r7", defend: "c9" };

export function teamBuyMode(members: Array<{ money: number }>, match: Match, side: string, eco: Json): string {
  const rounds = match.rules.rounds;
  const firstOfHalf = match.round === 1 || match.round === Number(rounds.halftime_after) + 1;
  if (firstOfHalf) return "pistol";
  if (!members.length) return "eco";
  const avg = members.reduce((s, m) => s + m.money, 0) / members.length;
  const win = Number(rounds.win_score);
  const enemy = match.teams.find((t) => t.side !== side);
  const full = Number(eco.full_buy ?? 3800);
  if (enemy && enemy.score === win - 1) return avg >= full ? "full" : "force";
  if (avg >= full) return "full";
  if (avg >= Number(eco.save_below ?? 2400)) return "force";
  return "eco";
}

export function botBuy(bot: BotAgent, shop: Shop, db: WeaponDatabase, rules: Json, mode: string, _eco: Json, awper: boolean,
  kitBuyer: boolean, rng: Random): string[] {
  const side = bot.side;
  const bought: string[] = [];
  const buy = (key: string): boolean => {
    const it = findItem(db, rules, side, key);
    if (!it) return false;
    const [ok] = shop.buy(bot, it);
    if (ok) bought.push(key);
    return ok;
  };
  const afford = (key: string, keep = 0): boolean => {
    const it = findItem(db, rules, side, key);
    return it !== null && bot.money - shop.price(bot, it) >= keep;
  };
  const hasPrimary = bot.weapons.primary !== null;
  if (mode === "pistol") {
    if (rng.random() < 0.65) buy("kevlar");
    else {
      buy("flash");
      buy("smoke");
    }
    if (side === "defend" && kitBuyer && bot.money >= 400) buy("defuse_kit");
    return bought;
  }
  if (mode === "eco" && bot.money < 4500) {
    if (bot.money > 1200 && rng.random() < 0.5) buy("flash");
    return bought;
  }
  if (mode === "force" && bot.money < 4500) {
    if (!hasPrimary) {
      for (const key of [PRIMARY_BY_SIDE[side], "mx5", "s12"]) {
        if (afford(key, key !== PRIMARY_BY_SIDE[side] ? 650 : 0)) {
          buy(key);
          break;
        }
      }
    }
    if (afford("kevlar")) buy("kevlar");
    if (afford("flash", 200)) buy("flash");
    return bought;
  }
  // full buy
  if (!hasPrimary) {
    if (awper && afford("sr90", 1000)) buy("sr90");
    else if (afford(PRIMARY_BY_SIDE[side])) buy(PRIMARY_BY_SIDE[side]);
    else if (afford("mx5")) buy("mx5");
  }
  if (afford("kevlar_helmet")) buy("kevlar_helmet");
  else if (afford("kevlar")) buy("kevlar");
  if (side === "defend" && kitBuyer && afford("defuse_kit")) buy("defuse_kit");
  for (const [key, chance] of [["smoke", 0.8], ["flash", 0.9], ["frag", 0.6], ["flash", 0.4]] as const) {
    if (rng.random() < chance && afford(key, 100)) buy(key);
  }
  return bought;
}
