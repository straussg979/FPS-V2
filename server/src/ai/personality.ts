// Traits and roles: every bot plays with a recognisable style. Traits are drawn once per bot from a Random
// seeded with its name and the match seed (crc32), so "Anvil" plays the same way every round and every
// match with the same seed:
//   aggression  peeks and pushes rather than holds; takes entry
//   patience    holds longer, lurks, waits for teammates and utility
//   teamwork    keeps spacing for trades, trades, follows calls, calls more
//   utility     throws more and better-timed grenades
//   risk        takes duels at a disadvantage, re-peeks the same angle
// Values are Beta(2, 2) draws (most bots near the middle, a few extreme). Roles are assigned per round by
// the team strategy from traits and loadout.

import { Random, crc32 } from "@cs/shared/rng";
import type { BotAgent } from "./bot";

export const TRAITS = ["aggression", "patience", "teamwork", "utility", "risk"] as const;
export type Traits = Record<(typeof TRAITS)[number], number>;
export const ATTACK_ROLES = ["entry", "trade", "support", "lurker", "awper"];
export const DEFEND_ROLES = ["anchor", "rotator", "support", "awper"];

export function traitsFor(name: string, seed: number | null): Traits {
  const rng = new Random(crc32(`${name}:${seed ?? 0}`));
  const out = {} as Traits;
  for (const t of TRAITS) out[t] = Math.round(rng.betavariate(2.0, 2.0) * 1000) / 1000;
  return out;
}

function hasSniper(bot: BotAgent): boolean {
  const w = bot.weapons.primary;
  return w !== null && w.d.cls === "sniper";
}

/** Lexicographic max over key tuples (Python's max with a tuple key; the first wins ties). */
export function maxBy<T>(xs: T[], key: (x: T) => number[]): T {
  let best = xs[0], bk = key(xs[0]);
  for (const x of xs.slice(1)) {
    const k = key(x);
    for (let i = 0; i < k.length; i++) {
      if (k[i] > bk[i]) { best = x; bk = k; break; }
      if (k[i] < bk[i]) break;
    }
  }
  return best;
}

/** Role per bot for this round. */
export function assignRoles(bots: BotAgent[], side: string, rng: Random, lurker = true, carrier: unknown = null): Map<BotAgent, string> {
  const roles = new Map<BotAgent, string>();
  for (const b of bots) if (hasSniper(b)) roles.set(b, "awper");
  let left = bots.filter((b) => !roles.has(b));
  const tr = (b: BotAgent) => b.brain!.traits;
  if (side === "attack") {
    if (left.length) {
      const entry = maxBy(left, (b) => [tr(b).aggression, b !== carrier ? 1 : 0, rng.random()]);
      roles.set(entry, "entry");
      left = left.filter((b) => b !== entry);
    }
    if (left.length) {
      const sup = maxBy(left, (b) => [tr(b).utility + 0.15 * Object.values(b.weapons.inv.grenades).reduce((s, v) => s + v, 0), rng.random()]);
      roles.set(sup, "support");
      left = left.filter((b) => b !== sup);
    }
    if (lurker && left.length >= 2) {
      const lurk = maxBy(left, (b) => [tr(b).patience - 0.5 * tr(b).teamwork - (b === carrier ? 0.6 : 0), rng.random()]);
      roles.set(lurk, "lurker");
      left = left.filter((b) => b !== lurk);
    }
    for (const b of left) roles.set(b, "trade");
  } else {
    const keyed = left.map((b) => ({ b, k: [tr(b).patience - tr(b).aggression, rng.random()] }));
    keyed.sort((x, y) => y.k[0] - x.k[0] || y.k[1] - x.k[1]);
    keyed.forEach(({ b }, k) => {
      if (k < 2) roles.set(b, "anchor");
      else if (tr(b).utility > 0.6 && ![...roles.values()].includes("support")) roles.set(b, "support");
      else roles.set(b, "rotator");
    });
  }
  return roles;
}
