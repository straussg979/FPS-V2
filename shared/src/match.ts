// Competitive match flow: rounds, economy and the charge objective (CS rules). Pure logic: the
// director feeds it events (damage, kills, plant, defuse, detonation) and reacts to its callbacks.
//
// Round phases: freeze (locked at spawn, buying) -> prep (Siege-style preparation when prep_time > 0:
// defenders move and set up, attackers scout with drones, nobody can be hurt) -> live (round timer;
// buy time continues a while) -> planted (the bomb timer replaces the round timer) -> round_end ->
// [halftime] -> the next freeze ... -> match_end.
//
// Overtime (rounds.overtime, the duels): a match tied after max_rounds goes on until a team leads by
// `lead`; every `swap_every` overtime rounds (and at its start) the sides swap and everyone's money is
// set to `money`; `max_rounds` of overtime without a winner is a draw. forfeit(team) ends it at once.
//
// Win conditions: all attackers dead before a plant -> defenders; all defenders dead -> attackers; the
// round time runs out without a plant -> defenders; the charge detonates -> attackers (even if every
// attacker is dead); the charge is defused -> defenders.

import type { Json } from "./data";

export type Side = "attack" | "defend";
export const SIDES: Side[] = ["attack", "defend"];
export const otherSide = (s: string): Side => (s === "attack" ? "defend" : "attack");

export class Stats {
  kills = 0;
  deaths = 0;
  assists = 0;
  headshots = 0;
  damage = 0;
  score = 0;
  mvps = 0;
  roundKills = 0;
}

let nextUid = 1;

/** Anything that plays on a team (players and bots). */
export class Participant {
  readonly uid = nextUid++;
  name: string;
  isHuman: boolean;
  team: Team | null = null;
  money = 0;
  stats = new Stats();
  aliveFlag = true;

  constructor(name: string, isHuman = false) {
    this.name = name;
    this.isHuman = isHuman;
  }

  get side(): Side | "" { return this.team ? this.team.side : ""; }
  get alive(): boolean { return this.aliveFlag; }

  addMoney(amount: number, cap: number): number {
    const before = this.money;
    this.money = Math.max(0, Math.min(this.money + Math.trunc(amount), cap));
    return this.money - before;
  }
}

export class Team {
  index: number;
  side: Side;
  score = 0;
  lossStreak = 0;
  members: Participant[] = [];
  plantedThisRound = false;

  constructor(index: number, side: Side) {
    this.index = index;
    this.side = side;
  }

  aliveMembers(): Participant[] { return this.members.filter((m) => m.alive); }
}

export interface RoundResult {
  number: number;
  winnerSide: Side;
  reason: "elimination" | "time" | "bomb_detonated" | "bomb_defused";
  winnerTeam: number;
  mvp: string;
}

export type Phase = "waiting" | "freeze" | "prep" | "live" | "planted" | "round_end" | "halftime" | "match_end";
export const PHASES: Phase[] = ["waiting", "freeze", "prep", "live", "planted", "round_end", "halftime", "match_end"];

export type MatchEvent = (kind: string, data: Record<string, unknown>) => void;

export class Match {
  rules: Json;
  timers: Json;
  eco: Json;
  roundRules: Json;
  teams: [Team, Team];
  participants: Participant[] = [];
  onEvent: MatchEvent;
  onRoundReset: (m: Match, swapped: boolean) => void;
  phase: Phase = "waiting";
  round = 0;
  phaseTime = 0;
  roundClock = 0;
  bombClock = 0;
  history: RoundResult[] = [];
  planter: Participant | null = null;
  defuser: Participant | null = null;
  private roundDamage = new Map<string, number>();
  overtime = false;
  forfeited: number | null = null;

  constructor(rules: Json, side0: Side = "attack", onEvent?: MatchEvent, onRoundReset?: (m: Match, s: boolean) => void) {
    this.rules = rules;
    this.timers = rules.timers;
    this.eco = rules.economy;
    this.roundRules = rules.rounds;
    this.teams = [new Team(0, side0), new Team(1, otherSide(side0))];
    this.onEvent = onEvent ?? (() => undefined);
    this.onRoundReset = onRoundReset ?? (() => undefined);
  }

  setRules(rules: Json): void {
    this.rules = rules;
    this.timers = rules.timers;
    this.eco = rules.economy;
    this.roundRules = rules.rounds;
  }

  // ----------------------------------------------------------- roster
  add(p: Participant, teamIndex: number): void {
    const team = this.teams[teamIndex];
    p.team = team;
    team.members.push(p);
    p.money = Math.trunc(this.eco.start_money);
    this.participants.push(p);
  }

  teamOfSide(side: string): Team { return this.teams[0].side === side ? this.teams[0] : this.teams[1]; }
  sideAlive(side: Side): number { return this.teamOfSide(side).aliveMembers().length; }
  get maxMoney(): number { return Math.trunc(this.eco.max_money); }

  // ---------------------------------------------------------- queries
  get freeze(): boolean { return this.phase === "freeze"; }
  get inPrep(): boolean { return this.phase === "prep"; }
  /** Set by the director while only bots defend and a player attacks: no preparation phase this round. */
  skipPrep = false;
  get isLive(): boolean { return this.phase === "live" || this.phase === "planted"; }
  get prepTime(): number { return Number(this.timers.prep_time ?? 0); }

  canBuy(): boolean {
    if (this.phase === "freeze" || this.phase === "prep") return true;
    return this.isLive && this.roundClock < Number(this.timers.buy_time);
  }

  buyTimeLeft(): number {
    if (this.phase === "freeze" || this.phase === "prep") return Number(this.timers.buy_time);
    if (this.isLive) return Math.max(Number(this.timers.buy_time) - this.roundClock, 0);
    return 0;
  }

  clock(): number {
    const t = this.timers;
    switch (this.phase) {
      case "freeze": return Math.max(Number(t.freeze_time) - this.phaseTime, 0);
      case "prep": return Math.max(this.prepTime - this.phaseTime, 0);
      case "live": return Math.max(Number(t.round_time) - this.roundClock, 0);
      case "planted": return Math.max(Number(t.bomb_timer) - this.bombClock, 0);
      case "round_end": return Math.max(Number(t.round_end_delay) - this.phaseTime, 0);
      case "halftime": return Math.max(Number(t.halftime_delay) - this.phaseTime, 0);
      default: return 0;
    }
  }

  roundTimeLeft(): number {
    if (this.phase === "freeze" || this.phase === "prep") return Number(this.timers.round_time);
    if (this.isLive) return Math.max(Number(this.timers.round_time) - this.roundClock, 0);
    return 0;
  }

  bombTimeLeft(): number { return Math.max(Number(this.timers.bomb_timer) - this.bombClock, 0); }

  isHalftimeRound(): boolean { return this.round === Math.trunc(this.roundRules.halftime_after); }

  // ------------------------------------------------------------ flow
  start(): void {
    this.round = 0;
    this.overtime = false;
    this.forfeited = null;
    for (const t of this.teams) { t.score = 0; t.lossStreak = 0; }
    for (const p of this.participants) { p.money = Math.trunc(this.eco.start_money); p.stats = new Stats(); }
    this.history = [];
    this.beginRound(false, true);
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.phaseTime = 0;
    this.onEvent("phase", { phase });
  }

  private beginRound(swapped: boolean, fresh = false): void {
    this.round += 1;
    this.roundClock = 0;
    this.bombClock = 0;
    this.planter = null;
    this.defuser = null;
    this.roundDamage.clear();
    for (const t of this.teams) t.plantedThisRound = false;
    for (const p of this.participants) p.stats.roundKills = 0;
    this.onRoundReset(this, swapped || fresh);
    this.onEvent("round_start", { round: this.round });
    this.setPhase("freeze");
  }

  update(dt: number): void {
    this.phaseTime += dt;
    if (this.phase === "waiting" || this.phase === "match_end") return;
    const t = this.timers;
    if (this.phase === "freeze") {
      if (this.phaseTime >= Number(t.freeze_time)) {
        if (this.prepTime > 0 && !this.skipPrep) this.setPhase("prep");
        else { this.setPhase("live"); this.onEvent("live", {}); }
      }
    } else if (this.phase === "prep") {
      if (this.phaseTime >= this.prepTime) { this.setPhase("live"); this.onEvent("live", {}); }
    } else if (this.phase === "live") {
      this.roundClock += dt;
      if (this.roundClock >= Number(t.round_time)) this.endRound("defend", "time");
    } else if (this.phase === "planted") {
      this.roundClock += dt;
      this.bombClock += dt;
    } else if (this.phase === "round_end") {
      if (this.phaseTime >= Number(t.round_end_delay)) this.afterRound();
    } else if (this.phase === "halftime") {
      if (this.phaseTime >= Number(t.halftime_delay)) {
        this.swapSides();
        this.beginRound(true);
      }
    }
  }

  // ---------------------------------------------------------- events in
  allowDamage(victim: Participant | null, attacker: Participant | null): boolean {
    if (!victim || !attacker || victim === attacker) return true;
    if (victim.team === attacker.team && !this.rules.friendly_fire) return false;
    if (this.phase === "freeze" || this.phase === "prep") return false;
    return true;
  }

  private dkey(a: Participant, v: Participant): string { return `${a.uid}:${v.uid}`; }

  onDamage(victim: Participant, attacker: Participant | null, amount: number): void {
    if (!attacker || attacker === victim) return;
    const k = this.dkey(attacker, victim);
    this.roundDamage.set(k, (this.roundDamage.get(k) ?? 0) + amount);
    attacker.stats.damage += amount;
  }

  onKill(victim: Participant, killer: Participant | null, weapon = "", reward: number | null = null,
         headshot = false, kind = "bullet"): void {
    victim.aliveFlag = false;
    victim.stats.deaths += 1;
    let assister: Participant | null = null;
    if (killer && killer !== victim) {
      if (killer.team === victim.team) {
        killer.addMoney(-300, this.maxMoney);
        killer.stats.score -= 1;
      } else {
        killer.stats.kills += 1;
        killer.stats.roundKills += 1;
        killer.stats.score += 2;
        if (headshot) killer.stats.headshots += 1;
        const amount = Math.trunc(reward === null ? this.eco.kill_reward_default : reward);
        const gained = killer.addMoney(amount, this.maxMoney);
        if (gained) this.onEvent("money", { who: killer, amount: gained, reason: `kill (${weapon})` });
      }
      const threshold = Number(this.eco.assist_damage ?? 41);
      let best = 0;
      for (const p of this.participants) {
        if (p === killer || p.team === victim.team) continue;
        const dmg = this.roundDamage.get(this.dkey(p, victim)) ?? 0;
        if (dmg >= threshold && dmg > best) { best = dmg; assister = p; }
      }
      if (assister) {
        assister.stats.assists += 1;
        assister.stats.score += 1;
      }
    }
    this.onEvent("kill", { killer, victim, weapon, headshot, assister, damage_kind: kind });
    this.checkRoundEnd();
  }

  onBombPlanted(planter: Participant): void {
    if (this.phase !== "live") return;
    this.planter = planter;
    if (planter.team) planter.team.plantedThisRound = true;
    planter.stats.score += 2;
    const gained = planter.addMoney(Math.trunc(this.eco.plant_reward), this.maxMoney);
    if (gained) this.onEvent("money", { who: planter, amount: gained, reason: "bomb planted" });
    this.bombClock = 0;
    this.setPhase("planted");
    this.onEvent("bomb_planted", { planter });
    this.checkRoundEnd();
  }

  onBombDefused(defuser: Participant): void {
    if (this.phase !== "planted") return;
    this.defuser = defuser;
    defuser.stats.score += 2;
    const gained = defuser.addMoney(Math.trunc(this.eco.defuse_reward), this.maxMoney);
    if (gained) this.onEvent("money", { who: defuser, amount: gained, reason: "bomb defused" });
    this.onEvent("bomb_defused", { defuser });
    this.endRound("defend", "bomb_defused");
  }

  onBombExploded(): void {
    if (this.phase !== "planted") return;
    this.onEvent("bomb_exploded", {});
    this.endRound("attack", "bomb_detonated");
  }

  checkRoundEnd(): void {
    if (!this.isLive) return;
    const att = this.sideAlive("attack");
    const dfn = this.sideAlive("defend");
    if (dfn === 0 && this.teamOfSide("defend").members.length) this.endRound("attack", "elimination");
    else if (att === 0 && this.phase === "live" && this.teamOfSide("attack").members.length) this.endRound("defend", "elimination");
  }

  // -------------------------------------------------------- round end
  private endRound(winnerSide: Side, reason: RoundResult["reason"]): void {
    if (!["live", "planted", "freeze", "prep"].includes(this.phase)) return;
    const winner = this.teamOfSide(winnerSide);
    const loser = this.teamOfSide(otherSide(winnerSide));
    winner.score += 1;
    const mvp = this.pickMvp(winner, reason);
    if (mvp) mvp.stats.mvps += 1;
    const result: RoundResult = { number: this.round, winnerSide, reason, winnerTeam: winner.index, mvp: mvp ? mvp.name : "" };
    this.history.push(result);
    this.payRound(winner, loser, reason);
    this.setPhase("round_end");
    this.onEvent("round_end", { result });
  }

  private pickMvp(winner: Team, reason: string): Participant | null {
    if (reason === "bomb_defused" && this.defuser) return this.defuser;
    if (reason === "bomb_detonated" && this.planter) return this.planter;
    if (!winner.members.length) return null;
    let best = winner.members[0];
    for (const p of winner.members) {
      if (p.stats.roundKills > best.stats.roundKills ||
          (p.stats.roundKills === best.stats.roundKills && p.stats.damage > best.stats.damage)) best = p;
    }
    return best.stats.roundKills > 0 ? best : null;
  }

  private payRound(winner: Team, loser: Team, reason: string): void {
    const winAmount = Math.trunc(this.eco.win[reason]);
    for (const p of winner.members) {
      const gained = p.addMoney(winAmount, this.maxMoney);
      if (gained) this.onEvent("money", { who: p, amount: gained, reason: "round won" });
    }
    winner.lossStreak = Math.max(winner.lossStreak - 1, 0);
    loser.lossStreak += 1;
    const bonuses: number[] = this.eco.loss_bonus;
    let bonus = Math.trunc(bonuses[Math.min(loser.lossStreak, bonuses.length) - 1]);
    if (loser.side === "attack" && loser.plantedThisRound) bonus += Math.trunc(this.eco.planted_loss_bonus);
    for (const p of loser.members) {
      const gained = p.addMoney(bonus, this.maxMoney);
      if (gained) this.onEvent("money", { who: p, amount: gained, reason: "round lost" });
    }
  }

  get overtimeRules(): Json | null { return this.roundRules.overtime || null; }

  private endMatch(): void {
    this.setPhase("match_end");
    const [a, b] = this.teams;
    const winner = a.score === b.score ? null : a.score > b.score ? a : b;
    this.onEvent("match_end", { winner });
  }

  private afterRound(): void {
    const target = Math.trunc(this.roundRules.win_score);
    const maxRounds = Math.trunc(this.roundRules.max_rounds);
    const [a, b] = this.teams;
    const ot = this.overtimeRules;
    if (this.overtime && ot) {
      const played = this.round - maxRounds;
      if (Math.abs(a.score - b.score) >= Math.trunc(ot.lead ?? 2) || played >= Math.trunc(ot.max_rounds ?? 30)) this.endMatch();
      else if (played % Math.trunc(ot.swap_every ?? 2) === 0) { this.setPhase("halftime"); this.onEvent("halftime", {}); }
      else this.beginRound(false);
      return;
    }
    if (this.teams.some((t) => t.score >= target)) { this.endMatch(); return; }
    if (this.round >= maxRounds) {
      if (ot && a.score === b.score) {
        this.overtime = true;
        this.setPhase("halftime");
        this.onEvent("overtime", {});
      } else this.endMatch();
      return;
    }
    if (this.isHalftimeRound()) {
      this.setPhase("halftime");
      this.onEvent("halftime", {});
      return;
    }
    this.beginRound(false);
  }

  private swapSides(): void {
    for (const t of this.teams) {
      t.side = otherSide(t.side);
      t.lossStreak = 0;
    }
    const ot = this.overtimeRules;
    const money = this.overtime && ot ? Math.trunc(ot.money ?? this.eco.start_money) : Math.trunc(this.eco.start_money);
    for (const p of this.participants) p.money = money;
    this.onEvent("sides_swapped", {});
  }

  forfeit(teamIndex: number): void {
    if (this.phase === "match_end") return;
    this.forfeited = teamIndex;
    this.setPhase("match_end");
    this.onEvent("match_end", { winner: this.teams[1 - teamIndex], forfeit: teamIndex });
  }

  forceEndRound(winnerSide: Side, reason: RoundResult["reason"] = "elimination"): void {
    if (this.phase === "freeze" || this.phase === "prep") this.setPhase("live");
    this.endRound(winnerSide, reason);
  }

  scoreline(): [number, number] { return [this.teamOfSide("attack").score, this.teamOfSide("defend").score]; }
}
