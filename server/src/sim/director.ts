// The match director: connects the round logic (shared match.ts) to the world - spawning, round resets,
// kill attribution, friendly fire, freeze time, the charge and planting / defusing, and the bots that fill
// the teams (v2 brains, one team strategy per side).
//
// Web modes: `rules` is the preset (data/match.json + data/modes/*.json); `fill` keeps each team at a size
// with bots, adding and removing them at round boundaries as players join and leave (rebalanceBots);
// `roundHooks` run at every round reset before anyone spawns (the match worker balances teams there).

import { MASK_SIGHT } from "@cs/shared/collision";
import { BOTS, type Json } from "@cs/shared/data";
import { damageInfo, type DamageResult } from "@cs/shared/damage";
import type { Zone } from "@cs/shared/level/level";
import { Match, type Participant, SIDES, type Side, otherSide } from "@cs/shared/match";
import { type V3, anglesToDir, vnorm, vsub } from "@cs/shared/math";
import { Random } from "@cs/shared/rng";
import { flashDuration } from "@cs/shared/weapons";
import { BotAgent } from "../ai/bot";
import { TeamStrategy } from "../ai/strategy";
import { Bomb } from "./bomb";
import type { ServerGame } from "./game";
import { HumanAgent } from "./human";
import { Shop } from "./shop";
import type { Soldier } from "./soldier";
import { Tactical } from "./tactical";

const TEAM_THINK = 0.25;

export type DirectorListener = (kind: string, data: Record<string, unknown>) => void;

export class MatchDirector {
  game: ServerGame;
  rules: Json;
  rng: Random;
  seed: number | null;
  difficulty: string;
  nOpponents: number;
  nTeammates: number;
  humansList: HumanAgent[] = [];
  bots: BotAgent[] = [];
  match: Match;
  bomb: Bomb;
  shop: Shop;
  tactical: Tactical;
  private brains = new Map<Side, TeamStrategy>();
  teamBrains = new Map<Side, TeamStrategy>();
  listeners: DirectorListener[] = [];
  roundHooks: Array<(m: Match, swapped: boolean) => void> = [];
  fill: [number, number] | null = null;
  private teamT = 0;
  private botsBuy = false;
  private killZ: number;
  feed: Array<Record<string, unknown>> = [];

  constructor(game: ServerGame, opts: { side0?: Side; opponents?: number; teammates?: number; seed?: number | null;
    difficulty?: string | null; rules: Json }) {
    this.game = game;
    this.rules = opts.rules;
    this.seed = opts.seed ?? null;
    this.rng = new Random(this.seed);
    this.difficulty = opts.difficulty || this.rules.bots?.difficulty || BOTS.default_difficulty || "normal";
    this.nOpponents = opts.opponents ?? 5;
    this.nTeammates = opts.teammates ?? 0;
    this.match = new Match(this.rules, opts.side0 ?? "attack", (k, d) => this.event(k, d), (m, s) => this.roundReset(m, s));
    this.bomb = new Bomb(game, this.rules);
    this.shop = new Shop(this);
    this.tactical = new Tactical(game, this);
    this.assignTeamBrains();
    this.buildRoster();
    this.killZ = Number(game.level.bounds[0][2]) - 3;
  }

  // ------------------------------------------------------------ roster
  private buildRoster(): void {
    const side = this.match.teams[0].side;
    const names: Record<string, string[]> = { attack: [...BOTS.names.attack], defend: [...BOTS.names.defend] };
    for (const s of Object.values(names)) this.rng.shuffle(s);
    const enemy = otherSide(side);
    for (let i = 0; i < this.nTeammates; i++) this.addBot(names[side][i % names[side].length], side, 0);
    for (let i = 0; i < this.nOpponents; i++) this.addBot(names[enemy][i % names[enemy].length], enemy, 1);
  }

  private assignTeamBrains(): void {
    const out = new Map<Side, TeamStrategy>();
    for (const team of this.match.teams) {
      // a team keeps its AI when the sides swap; brains exist per side and follow the team
      let tb = this.brains.get(team.side);
      if (!tb) {
        tb = new TeamStrategy(this, team.side);
        this.brains.set(team.side, tb);
      }
      out.set(team.side, tb);
    }
    this.teamBrains = out;
  }

  private addBot(name: string, side: Side, teamIndex: number): BotAgent {
    const a = new BotAgent(this.game, name, side, this.difficulty, this.rng.randrange(1 << 30), this.seed ?? 0);
    this.match.add(a, teamIndex);
    a.attachBrain(this);
    this.bots.push(a);
    this.hookDamage(a);
    return a;
  }

  private hookDamage(a: Soldier): void {
    a.damageable.filter = (d, info) => this.filter(d, info.attacker);
    a.damageable.onDamage.push((res) => this.damaged(a, res));
  }

  private botName(side: Side): string {
    const taken = new Set(this.match.participants.map((a) => a.name));
    const names = [...BOTS.names[side]] as string[];
    this.rng.shuffle(names);
    for (const n of names) if (!taken.has(n)) return n;
    let k = 2;
    while (taken.has(`${names[0]} ${k}`)) k++;
    return `${names[0]} ${k}`;
  }

  removeBot(bot: BotAgent): void {
    this.passCharge(bot);
    bot.remove();
    if (bot.team) bot.team.members = bot.team.members.filter((m) => m !== bot);
    this.match.participants = this.match.participants.filter((m) => m !== bot);
    this.bots = this.bots.filter((b) => b !== bot);
    bot.team = null;
  }

  /** Each team to its fill size: a bot fewer for every player, one more for every free place (add: only
   * between rounds; a new bot spawns at the round reset). */
  rebalanceBots(add = true): number {
    if (!this.fill) return 0;
    let changed = 0;
    for (const team of this.match.teams) {
      const humans = this.humansList.filter((h) => h.team === team).length;
      const bots = this.bots.filter((b) => b.team === team);
      const want = Math.max(0, this.fill[team.index] - humans);
      while (bots.length > want) { this.removeBot(bots.pop() as BotAgent); changed--; }
      while (add && bots.length < want) { bots.push(this.addBot(this.botName(team.side), team.side, team.index)); changed++; }
    }
    if (changed) {
      this.nTeammates = this.bots.filter((b) => b.team === this.match.teams[0]).length;
      this.nOpponents = this.bots.filter((b) => b.team === this.match.teams[1]).length;
    }
    return changed;
  }

  /** The charge passes to another living attacker when its carrier leaves the team. */
  private passCharge(agent: Soldier): void {
    if (this.bomb.state !== "carried" || this.bomb.carrier !== agent) return;
    agent.weapons.inv.hasBomb = false;
    const others = (this.match.participants as Soldier[]).filter((a) => a !== agent && a.side === "attack" && a.alive);
    if (others.length) {
      const c = this.rng.choice(others);
      this.bomb.give(c);
      c.weapons.inv.hasBomb = true;
    } else this.bomb.reset();
  }

  moveHuman(agent: HumanAgent, teamIndex: number): void {
    const team = this.match.teams[teamIndex];
    if (agent.team === team) return;
    this.passCharge(agent);
    if (agent.team) agent.team.members = agent.team.members.filter((m) => m !== agent);
    agent.team = team;
    team.members.push(agent);
  }

  setRules(rules: Json): void {
    this.rules = rules;
    this.match.setRules(rules);
    this.bomb.setRules(rules);
  }

  agentOf(obj: unknown): Soldier | null {
    if (!obj) return null;
    if (obj instanceof HumanAgent || obj instanceof BotAgent) return obj;
    return null;
  }

  brainOf(side: string): TeamStrategy | undefined { return this.teamBrains.get(side as Side); }

  // ------------------------------------------------------------ humans
  /** Players in the match (on a team). */
  get humans(): HumanAgent[] { return this.humansList.filter((h) => h.team !== null); }
  allHumans(): HumanAgent[] { return this.humansList; }

  addHuman(agent: HumanAgent, teamIndex: number): HumanAgent {
    this.match.add(agent, teamIndex);
    this.hookDamage(agent);
    this.humansList.push(agent);
    const phase = this.match.phase;
    if (phase === "freeze" || phase === "prep") {
      this.rebalanceBots(false);          // the player takes a bot's place now
      const spots = this.game.level.spawns.filter((s) => s.team === agent.side);
      const taken = [...this.humans.filter((h) => h !== agent).map((h) => h.motor.char.pos), ...this.bots.filter((b) => b.active).map((b) => b.char.pos)];
      const free = spots.filter((s) => taken.every((p) => Math.hypot(s.pos[0] - p[0], s.pos[1] - p[1], s.pos[2] - p[2]) > 1));
      this.spawnHuman(agent, false, free.length ? free : spots.slice());
      this.tactical.fillKit(agent);
      agent.weapons.select(agent.weapons.inv.bestSlot(), true);
    } else if (phase !== "waiting") {
      agent.damageable.health = 0;
      agent.damageable.alive = false;
      agent.aliveFlag = false;
      agent.hitEnabled = false;
      agent.active = false;
    }
    return agent;
  }

  removeHuman(agent: HumanAgent): void {
    if (this.bomb.state === "carried" && this.bomb.carrier === agent) {
      this.bomb.drop(agent.position());
      agent.weapons.inv.hasBomb = false;
    }
    if (agent.team) agent.team.members = agent.team.members.filter((m) => m !== agent);
    this.match.participants = this.match.participants.filter((m) => m !== agent);
    this.humansList = this.humansList.filter((h) => h !== agent);
    agent.team = null;
    agent.aliveFlag = false;
    agent.hitEnabled = false;
    agent.active = false;
    this.match.checkRoundEnd();
  }

  // ------------------------------------------------------------- flow
  start(): void {
    this.feed = [];
    this.match.start();
  }

  /** No shooting in freeze time; during prep only the defenders may (nobody can be hurt yet). */
  combatLocked(agent: Soldier | null = null): boolean {
    const phase = this.match.phase;
    if (phase === "prep") return !agent || agent.side !== "defend";
    return phase === "freeze" || phase === "match_end";
  }

  moveLocked(agent: Soldier): boolean {
    const phase = this.match.phase;
    return phase === "freeze" || (phase === "prep" && agent.side !== "defend");
  }

  /** No preparation phase when a player attacks and only bots defend (data/match.json
   * skip_prep_vs_bot_defenders): the defending bots start the round already set up at their spots. */
  quickStart(): boolean {
    if (this.rules.skip_prep_vs_bot_defenders === false) return false;
    const humans = this.humans;
    return humans.some((h) => h.side === "attack") && !humans.some((h) => h.side === "defend");
  }

  fixedUpdate(dt: number): void {
    const g = this.game;
    const m = this.match;
    if (m.phase === "freeze") m.skipPrep = this.quickStart();
    m.update(dt);
    const now = g.loop.time;
    const humans = this.humans;
    for (const h of humans) { h.hint = ""; h.progress = null; }
    if (this.botsBuy && m.phase === "freeze") {
      this.botsBuy = false;
      for (const tb of this.teamBrains.values()) { tb.buy(); tb.roundStart(now); }
    }
    const tac = this.tactical;
    for (const h of humans) {
      const planting = this.updatePlant(h, dt);
      const defusing = this.updateDefuse(h, dt);
      const busy = tac.humanBusyFor(h);
      h.motor.moveLock = this.moveLocked(h) || planting || defusing || busy;
      h.motor.leanLock = busy;
    }
    if (m.phase === "planted" && m.bombTimeLeft() <= 0 && this.bomb.state === "planted") {
      m.onBombExploded();          // the round is the attackers' before the blast's kills count
      this.bomb.explode();
    }
    this.bomb.fixedUpdate(dt, m.bombTimeLeft());
    if (this.bomb.state === "dropped") {
      for (const h of humans) {
        if (h.side === "attack" && h.alive && this.bomb.tryPickup(h, h.motor.char.pos)) {
          h.weapons.inv.hasBomb = true;
          g.fx.message(h, "picked up the breach charge");
          g.fx.ui("pickup", 0.6, h);
        }
      }
      for (const b of this.bots) {
        if (b.active && b.alive && this.bomb.tryPickup(b, b.char.pos)) { b.weapons.inv.hasBomb = true; break; }
      }
    }
    for (const b of this.bots) {
      b.fixedUpdate(dt, now, b.active ? this.moveLocked(b) : true);
      if (b.active && b.alive && b.char.pos[2] < this.killZ) this.outOfWorld(b);
    }
    for (const h of humans) if (h.alive && h.motor.char.pos[2] < this.killZ) this.outOfWorld(h);
    this.separateCharacters();
    tac.fixedUpdate(dt);
    if (now >= this.teamT) {
      this.teamT = now + TEAM_THINK;
      for (const tb of this.teamBrains.values()) { tb.gadgets.update(now); tb.update(now); }
    }
    // the players' hit capsules follow their characters
    for (const h of humans) {
      const mo = h.motor;
      const c = mo.char;
      if (h.alive) h.pose.animate(dt, c.pos, mo.yaw, mo.pitch, c.crouchAmount, c.vel, c.onGround, c.walking, mo.lean.amount);
      else h.pose.animate(dt, c.pos, mo.yaw, mo.pitch, 0, [0, 0, 0], true);
      if (!h.alive) h.deadT += dt;
      else h.deadT = 0;
    }
    this.feed = this.feed.filter((f) => now - (f.t as number) < 7);
  }

  // --------------------------------------------------- round reset
  private roundReset(match: Match, swapped: boolean): void {
    const g = this.game;
    for (const hook of this.roundHooks.slice()) hook(match, swapped);
    this.rebalanceBots();
    this.assignTeamBrains();
    g.clearWorld();
    this.shop.newRound();
    this.bomb.reset();
    const survived = new Map<Participant, boolean>(match.participants.map((a) => [a, a.alive]));
    if (match.round === 1) for (const k of survived.keys()) survived.set(k, false);
    const spawns: Record<string, Array<{ team: string; pos: V3; heading: number }>> = {};
    for (const s of SIDES) {
      spawns[s] = g.level.spawns.filter((sp) => sp.team === s);
      this.rng.shuffle(spawns[s]);
    }
    for (const h of this.humans) this.spawnHuman(h, (survived.get(h) ?? false) && !swapped, spawns[h.side]);
    for (const b of this.bots) {
      const kept = (survived.get(b) ?? false) && !swapped;
      const w = b.weapons;
      b.damageable.reset(undefined, kept ? b.damageable.armor : 0, kept ? b.damageable.helmet : false);
      b.aliveFlag = true;
      if (!kept) {
        w.inv.clear();
        b.hasKit = false;
        w.giveLoadout(["knife", this.rules.teams[b.side].default_pistol], {});
      } else {
        w.inv.hasBomb = false;
        w.inv.refillAmmo();
        w.select(w.inv.bestSlot(), true);
      }
      if (b.side !== "defend") b.hasKit = false;
      const [pos, heading] = this.spawnSpot(spawns[b.side], b.side);
      b.spawn(pos, heading);
    }
    const carriers = (match.participants as Soldier[]).filter((a) => a.side === "attack");
    if (carriers.length) {
      const c = this.rng.choice(carriers);
      this.bomb.give(c);
      c.weapons.inv.hasBomb = true;
    }
    for (const h of this.humans) h.weapons.select(h.weapons.inv.bestSlot(), true);
    this.botsBuy = this.bots.length > 0;
    this.tactical.roundReset();
  }

  private spawnHuman(h: HumanAgent, kept: boolean, pool: Array<{ pos: V3; heading: number }>): void {
    const w = h.weapons;
    h.damageable.reset(undefined, kept ? h.damageable.armor : 0, kept ? h.damageable.helmet : false);
    h.aliveFlag = true;
    h.plantT = h.defuseT = h.deadT = 0;
    if (!kept) {
      w.inv.clear();
      h.hasKit = false;
      w.giveLoadout(["knife", this.rules.teams[h.side].default_pistol], {});
    } else {
      w.inv.hasBomb = false;
      w.inv.refillAmmo();
    }
    if (h.side !== "defend") h.hasKit = false;
    const sp = pool.length ? pool.shift() as { pos: V3; heading: number } : this.game.level.spawnPoint();
    h.spawn(sp.pos, sp.heading ?? 0);
    h.motor.alive = true;
    h.active = true;
  }

  private spawnSpot(pool: Array<{ pos: V3; heading: number }>, side: string): [V3, number] {
    if (pool.length) {
      const sp = pool.shift() as { pos: V3; heading: number };
      return [sp.pos, sp.heading ?? 0];
    }
    const spots = this.game.level.spawns.filter((s) => s.team === side);
    const sp = spots.length ? this.rng.choice(spots) : this.game.level.spawnPoint();
    const p = sp.pos;
    const q = this.game.navmesh().randomPoint(this.rng, p, 3.0);
    return [q ?? p, sp.heading ?? 0];
  }

  // ------------------------------------------------------- damage
  private filter(damageable: unknown, attackerObj: unknown): boolean {
    const victim = (this.match.participants as Soldier[]).find((a) => a.damageable === damageable) ?? null;
    return this.match.allowDamage(victim, this.agentOf(attackerObj));
  }

  private damaged(agent: Soldier, res: DamageResult): void {
    const attacker = this.agentOf(res.info.attacker);
    this.match.onDamage(agent, attacker, res.health);
    if (agent instanceof HumanAgent) this.game.playerDamaged(agent, res);
    if (res.killed) {
      const weapon = res.info.weapon || "";
      const reward = this.killReward(weapon);
      if (this.bomb.state === "carried" && this.bomb.carrier === agent) {
        if (agent instanceof HumanAgent) this.dropBomb(agent);
        else {
          this.bomb.drop(agent.position());
          agent.weapons.inv.hasBomb = false;
        }
      }
      const dir = res.info.direction;
      if (agent instanceof HumanAgent) {
        agent.die(Math.hypot(dir[0], dir[1], dir[2]) > 1e-6 ? dir : null);
        agent.motor.alive = false;
        this.dropHumanWeapon(agent);
      }
      this.teamBrains.get(agent.side as Side)?.onTeammateKilled(agent, attacker, this.game.loop.time);
      this.match.onKill(agent, attacker, weapon, reward, res.info.headshot, res.info.kind);
    }
  }

  /** Characters block each other: bots are pushed apart and off the players (a bot never pushes a
   * player); two players push each other apart. Each push is swept against the level. */
  private separateCharacters(): void {
    const chars = this.bots.filter((b) => b.active && b.alive).map((b) => b.char);
    const players = this.humans.filter((h) => h.alive).map((h) => h.motor.char);
    if (!chars.length && players.length < 2) return;
    const nBots = chars.length;
    const others = [...chars, ...players];
    const minD = others[0].radius * 2 * 0.95;
    for (let i = 0; i < others.length; i++) {
      const a = others[i];
      for (let k = i + 1; k < others.length; k++) {
        const b = others[k];
        if (Math.abs(a.pos[2] - b.pos[2]) > 1.6) continue;
        let dx = a.pos[0] - b.pos[0], dy = a.pos[1] - b.pos[1];
        const d2 = dx * dx + dy * dy;
        if (d2 >= minD * minD) continue;
        let d = Math.sqrt(d2);
        if (d < 1e-4) {
          const ang = this.rng.uniform(0, 2 * Math.PI);
          dx = Math.cos(ang); dy = Math.sin(ang); d = 1;
        }
        const push = (minD - Math.sqrt(d2)) / d;
        if (i < nBots && nBots <= k) nudge(a, [dx * push, dy * push, 0]);
        else {
          nudge(a, [dx * push * 0.5, dy * push * 0.5, 0]);
          nudge(b, [-dx * push * 0.5, -dy * push * 0.5, 0]);
        }
      }
    }
  }

  private outOfWorld(agent: Soldier): void {
    this.game.log(`[match] ${agent.name} fell out of the world`);
    agent.damageable.takeDamage(damageInfo({ amount: 1000, kind: "fall", weapon: "world" }));
    agent.die(null);
  }

  /** Like the bots, a dead player drops the best gun for anyone to pick up. */
  private dropHumanWeapon(agent: HumanAgent): void {
    const inv = agent.weapons.inv;
    const ws = inv.weapons.primary ?? inv.weapons.secondary;
    if (!ws) return;
    inv.weapons[ws.d.slot] = null;
    agent.weapons.dropWeaponState(ws, 1.0);
  }

  private killReward(weapon: string): number {
    const db = this.game.weaponDb;
    if (db.weapons[weapon]) return db.weapons[weapon].killReward;
    if (db.grenades[weapon]) return Number(db.grenades[weapon].raw.kill_reward ?? 300);
    return Number(this.rules.economy.kill_reward_default);
  }

  /** Flashbang: blind the bots that can see it. */
  applyFlash(pos: V3, radius: number, maxBlind: number): void {
    const g = this.game;
    for (const b of this.bots) {
      if (!(b.active && b.alive)) continue;
      const eye = b.eye();
      const to = vsub(pos, eye);
      const dist = Math.hypot(to[0], to[1], to[2]);
      if (dist >= radius) continue;
      const back = vnorm(vsub(eye, pos));
      if (g.world.ray(eye, [pos[0] + back[0] * 0.1, pos[1] + back[1] * 0.1, pos[2] + back[2] * 0.1], MASK_SIGHT)) continue;
      if (g.smoke.between(eye, pos) > 0.8) continue;
      const vd = b.viewDir();
      const k = 1 / Math.max(dist, 1e-3);
      const dur = flashDuration(dist, radius, vd[0] * to[0] * k + vd[1] * to[1] * k + vd[2] * to[2] * k, maxBlind);
      b.flashed(dur, dur / maxBlind);
    }
  }

  // ---------------------------------------------------------- bomb
  dropBomb(agent: Soldier): void {
    if (this.bomb.state !== "carried" || this.bomb.carrier !== agent) return;
    if (agent instanceof HumanAgent) {
      const inv = agent.weapons.inv;
      inv.hasBomb = false;
      const fwd = anglesToDir(agent.motor.yaw, 0);
      const p = agent.motor.char.pos;
      const k = agent.alive ? 1.2 : 0;
      this.bomb.drop([p[0] + fwd[0] * k, p[1] + fwd[1] * k, p[2]]);
      if (agent.alive) agent.weapons.select(inv.bestSlot(), true);
    } else {
      this.bomb.drop(agent.position());
      agent.weapons.inv.hasBomb = false;
    }
  }

  siteAt(pos: ArrayLike<number>): Zone | null {
    return this.game.level.zoneAt([pos[0], pos[1], pos[2] + 0.1], "bombsite");
  }

  botPlant(bot: BotAgent, site: Zone): boolean {
    if (this.match.phase !== "live" || this.bomb.state !== "carried" || this.bomb.carrier !== bot) return false;
    const w = bot.weapons;
    w.inv.hasBomb = false;
    w.select(w.inv.bestSlot(), true);
    const fwd = bot.forward();
    const p = bot.position();
    this.bomb.plant([p[0] + fwd[0] * 0.45, p[1] + fwd[1] * 0.45, p[2]], bot.aim.yaw, site.name);
    this.match.onBombPlanted(bot);
    return true;
  }

  botDefuse(bot: BotAgent): boolean {
    if (this.bomb.state !== "planted" || this.match.phase !== "planted") return false;
    this.bomb.defused();
    this.match.onBombDefused(bot);
    return true;
  }

  private feetZone(agent: HumanAgent, kind = "bombsite"): Zone | null {
    const c = agent.motor.char.pos;
    return this.game.level.zoneAt([c[0], c[1], c[2] + 0.1], kind);
  }

  inBuyZone(agent: Soldier): boolean {
    const zones = this.game.level.zones.filter((z) => z.kind === "buyzone");
    if (!zones.length) return true;
    const p = agent.position();
    return zones.some((z) => z.team === agent.side && [0, 1, 2].every((i) => z.min[i] <= p[i] && p[i] <= z.max[i]));
  }

  /** A player holding fire with the charge in a bomb site plants it (plant_time). */
  private updatePlant(h: HumanAgent, dt: number): boolean {
    const g = this.game;
    const w = h.weapons;
    const inv = w.inv;
    const holding = inv.slot === "bomb" && inv.hasBomb && h.alive && this.match.phase === "live" && h.input.down("fire");
    if (!holding) {
      if (h.plantT > 0) { h.plantT = 0; h.pose.stop("plant"); }
      if (inv.slot === "bomb" && inv.hasBomb && this.match.phase === "live" && !this.feetZone(h)) {
        const sites = g.level.zones.filter((z) => z.kind === "bombsite").map((z) => z.name);
        h.hint = `Plant at bomb site ${sites.join(" or ")}`;
      }
      return false;
    }
    const site = this.feetZone(h);
    if (!site || !h.motor.char.onGround) {
      h.hint = "You must be standing in a bomb site to plant";
      return false;
    }
    const plantTime = Number(this.rules.timers.plant_time);
    if (h.plantT === 0) h.pose.event("plant");
    const before = Math.floor(h.plantT * 3);
    h.plantT += dt;
    if (Math.floor(h.plantT * 3) !== before) g.fx.ui("plant_tap", 0.5, h);
    h.progress = ["plant", Math.min(h.plantT / plantTime, 1)];
    if (h.plantT >= plantTime) {
      h.plantT = 0;
      inv.hasBomb = false;
      const mo = h.motor;
      const fwd = anglesToDir(mo.yaw, 0);
      const p = mo.char.pos;
      this.bomb.plant([p[0] + fwd[0] * 0.45, p[1] + fwd[1] * 0.45, p[2]], mo.yaw, site.name);
      h.pose.stop("plant");
      w.select(inv.bestSlot(), true);
      this.match.onBombPlanted(h);
      return false;
    }
    return true;
  }

  /** A defender holding use while looking at the planted charge defuses it. */
  private updateDefuse(h: HumanAgent, dt: number): boolean {
    const g = this.game;
    if (h.side !== "defend" || !h.alive || this.bomb.state !== "planted") {
      if (h.defuseT > 0) h.pose.stop("defuse");
      h.defuseT = 0;
      return false;
    }
    const mo = h.motor;
    const onTarget = this.bomb.defuseTarget(mo.eye(), anglesToDir(mo.yaw, mo.pitch));
    const use = h.input.down("use");
    if (onTarget && !use) h.hint = "Hold [F] to defuse" + (h.hasKit ? "" : "  (no kit: 10 s)");
    if (!(onTarget && use)) {
      if (h.defuseT > 0) h.pose.stop("defuse");
      h.defuseT = 0;
      return false;
    }
    const total = Number(this.rules.timers[h.hasKit ? "defuse_time_kit" : "defuse_time"]);
    if (h.defuseT === 0) {
      g.fx.playAt("defuse_start", this.bomb.pos, 0.8);
      h.pose.event("defuse");
    }
    h.defuseT += dt;
    h.progress = ["defuse", Math.min(h.defuseT / total, 1)];
    if (h.defuseT >= total) {
      h.defuseT = 0;
      h.pose.stop("defuse");
      this.bomb.defused();
      this.match.onBombDefused(h);
      return false;
    }
    return true;
  }

  // --------------------------------------------------------- events
  /** Bot radio messages: to their team (the snapshots filter by team). */
  radio(agent: Soldier, text: string): void {
    for (const cb of this.listeners.slice()) cb("radio", { who: agent, text });
  }

  private event(kind: string, data: Record<string, unknown>): void {
    const g = this.game;
    if (kind === "kill") {
      this.feed.push({ t: g.loop.time, ...data });
      this.feed = this.feed.slice(-6);
    } else if (kind === "bomb_planted") {
      g.fx.sting("planted", 0.6);
    } else if (kind === "phase" && data.phase === "live") {
      g.fx.sting("round_start", 0.6);
    }
    for (const cb of this.listeners.slice()) cb(kind, data);
  }
}

function nudge(char: { pos: V3; trace(a: V3, b: V3): [number, V3, string] | null }, v: V3): void {
  const target: V3 = [char.pos[0] + v[0], char.pos[1] + v[1], char.pos[2] + v[2]];
  const hit = char.trace(char.pos, target);
  const f = Math.fround;
  if (!hit) char.pos = [f(target[0]), f(target[1]), f(target[2])];
  else {
    const k = Math.max(hit[0] - 0.05, 0);
    char.pos = [f(char.pos[0] + v[0] * k), f(char.pos[1] + v[1] * k), f(char.pos[2] + v[2] * k)];
  }
}
