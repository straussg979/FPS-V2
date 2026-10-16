// Team strategy: plans, roles and team knowledge for the bots. One TeamStrategy per side gives orders
// (Tasks) and keeps what the team knows:
// * the possibility field (belief.ts) of where the enemy team can be: the team's eyes clear it (one bot's view
//   per few ticks, round robin); the radar, callouts and pings put enemies back on it;
// * the radio (comms.ts): sightings become callouts a moment later, snapped to the area;
// * the radar (`reports`): what the team has seen in the last few seconds, exactly what a player's HUD radar
//   shows; bots glance at it now and then, never mid-fight;
// * kills from the kill feed; path searches in a shared PathService with a per-tick budget.
// Nothing here reads an enemy's position, the hidden charge carrier or an unseen gadget.
//
// Attack plans (one per round, weighted, with an anti-repetition decay; eco rounds favour rush and contact):
//   default  spread for map control, then a mid-round call to the site with fewer defenders seen
//   execute  stage on one or two lanes, timed utility, entry first and his trader behind, then clear
//   split    two lanes at once        fake  two bots show at one site, the rest hit the other
//   contact  walk one lane quietly until the first information, then execute the nearest site
//   rush     down the shortest lane, running
// Roles (personality.ts): entry, trade, support, lurker, AWPer.
// Defence setups (weighted by what the team saw attackers do earlier): 2-1-2, stack, aggro, retake. Hold
// spots that died twice are used less; rotators move on credible information only; a lone anchor facing
// three or more falls back for the retake; after a plant everyone retakes together (or saves).

import { MASK_SIGHT } from "@cs/shared/collision";
import { BOTS, type Json } from "@cs/shared/data";
import type { Zone } from "@cs/shared/level/level";
import type { Participant, Side } from "@cs/shared/match";
import type { V3 } from "@cs/shared/math";
import { Random } from "@cs/shared/rng";
import type { MatchDirector } from "../sim/director";
import type { ServerGame } from "../sim/game";
import type { Soldier } from "../sim/soldier";
import { PossibilityField, viewMask } from "./belief";
import type { BotAgent } from "./bot";
import { BrainV2, Task } from "./brain";
import { botBuy, teamBuyMode } from "./buy";
import { Radio } from "./comms";
import { dist3 } from "./controllers";
import { GadgetAI, zoneDist } from "./gadget_ai";
import { Fact } from "./knowledge";
import type { NavMesh, Pt3 } from "./navmesh";
import { PathService } from "./pathing";
import type { Contact } from "./perception";
import { assignRoles, maxBy } from "./personality";
import type { TacticalMap } from "./tactical_map";

export const SITE_AREA = 30.0;
export const PLANS = ["default", "execute", "split", "fake", "contact", "rush"];
// starting weights from head-to-heads (executes with utility won most, fakes least); within a match they
// follow the results (`worked`)
export const PLAN_WEIGHTS: Record<string, number> = { default: 0.8, execute: 1.7, split: 0.8, fake: 0.25, contact: 0.6, rush: 0.4 };
export const SETUP_WEIGHTS: Record<string, number> = { "2-1-2": 1.0, stack: 0.35, aggro: 0.15, retake: 0.8 };
const THINKS_PER_TICK = 3;

export interface Lane { name: string; points: number[][]; stage: number }
interface HoldSpec { pos: V3; yaw: number; crouch: boolean }
/* eslint-disable @typescript-eslint/no-explicit-any */
type HoldLike = { i?: number; pos?: ArrayLike<number>; sees?: number[]; yaw?: number | null; crouch?: boolean; score?: number; [k: string]: any };

export function zoneCenter(z: Zone): V3 { return [(z.min[0] + z.max[0]) / 2, (z.min[1] + z.max[1]) / 2, z.min[2] + 0.5]; }

/** Weighted choice that gets less likely the more often an option was picked lately. */
export function pickVaried(weights: Record<string, number>, history: string[], rng: Random, decay = 0.45, window = 5, repeat = 0.4): string {
  const recent = history.slice(-window);
  const opts = Object.keys(weights);
  const ws = opts.map((o) => {
    let w = weights[o] * decay ** recent.filter((h) => h === o).length;
    if (history.length && history[history.length - 1] === o) w *= repeat;
    if (history.length >= 5 && history.filter((h) => h === o).length / history.length >= 0.36) w *= 0.1;
    return w;
  });
  return rng.choices(opts, ws)[0];
}

/** Map routes ending in a bomb site, starting away from the defenders' spawn. */
export function buildLanes(level: { zones: Zone[]; data: Json }, defendSpawn: V3): Map<string, Lane[]> {
  const sites = level.zones.filter((z) => z.kind === "bombsite");
  const lanes = new Map<string, Lane[]>(sites.map((z) => [z.name, []]));
  for (const r of level.data.test_routes ?? []) {
    const pts: number[][] = [r.start.slice(0, 3), ...r.waypoints.map((w: number[]) => [...w])];
    if (Math.hypot(pts[0][0] - defendSpawn[0], pts[0][1] - defendSpawn[1]) < 15.0) continue;
    const end = pts[pts.length - 1];
    for (const z of sites) {
      if (zoneDist(z, end) < 0.5) {
        let stageI = 0;
        for (let i = pts.length - 1; i >= 0; i--) if (zoneDist(z, pts[i]) >= 10.0) { stageI = i; break; }
        lanes.get(z.name)!.push({ name: r.name, points: pts, stage: stageI });
      }
    }
  }
  return lanes;
}

function along(path: ArrayLike<number>[], dist: number): V3 {
  let left = dist;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    const seg = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (seg >= left) {
      const t = left / Math.max(seg, 1e-6);
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    }
    left -= seg;
  }
  const l = path[path.length - 1];
  return [l[0], l[1], l[2]];
}

function mean(points: V3[]): V3 {
  const n = points.length;
  return [points.reduce((s, p) => s + p[0], 0) / n, points.reduce((s, p) => s + p[1], 0) / n, points.reduce((s, p) => s + p[2], 0) / n];
}

const up = (p: ArrayLike<number>, h: number): V3 => [p[0], p[1], p[2] + h];

export class TeamStrategy {
  director: MatchDirector;
  side: Side;
  game: ServerGame;
  cfg: Json;
  tm: TacticalMap;
  nav: NavMesh;
  paths: PathService;
  enemySide: Side;
  field: PossibilityField;
  rng: Random;
  sites: Map<string, Zone>;
  siteCenters: Map<string, V3>;
  spawnCenter: Record<string, V3> = {};
  lanes: Map<string, Lane[]>;
  holds: Record<string, HoldSpec[]>;
  lurks: V3[];
  lurkInfo: number[][];
  siteHistory: Record<string, number> = {};
  reports: Array<[number, number, V3]> = [];
  private radioT = new Map<string, number>();
  roles = new Map<BotAgent, string>();
  enemiesAlive = 5;
  planHistory: string[] = [];
  setupHistory: string[] = [];
  siteSeen: Record<string, number> = {};
  spotDeaths = new Map<number, number>();
  attacked: Record<string, number> = {};
  learned: Float64Array;
  worked: Record<string, number> = {};
  comms: Radio;
  gadgets: GadgetAI;
  buyMode = "full";
  private ptRect: Int32Array;
  private nRects: number;
  private dangerBiasT = -10;
  private rotPts = new Map<string, V3 | null>();
  private attPts = new Map<string, V3 | null>();
  private siteDist = new Map<string, Float64Array | null>();
  private siteHoldsCache = new Map<string, HoldLike[]>();
  // round state
  plan = "";
  site = "";
  phase = "setup";
  groups = new Map<number, { lane: Lane; stage: V3; lurk?: boolean }>();
  stageArrived = new Set<number>();
  firstStageT: number | null = null;
  execT: number | null = null;
  commitT = 0;
  plantedHandled = false;
  retakePhase = "";
  gatherT = 0;
  defuser: BotAgent | null = null;
  pickupBot: BotAgent | null = null;
  rotated: Record<string, number> = {};
  areaOf = new Map<number, string>();
  shuffleT = 0;
  lastContactT = -100;
  roundStartT = 0;
  liveT = 0;
  deaths: Array<{ t: number; pos: V3; victim: Soldier; guess: V3 | null }> = [];
  nades: Array<[number, [number, number]]> = [];
  facts: Fact[] = [];
  private radarSeen = new Map<number, number>();
  private pendingRadar: Array<[number, Fact]> = [];
  private tickT = -1;
  private tickN = 0;
  private thinkT = -1;
  private thinks = 0;
  private stagger = 0;
  private botsT = -1;
  private botsCache: BotAgent[] = [];
  private observeI = 0;
  private dangerVal: Float64Array | null = null;
  private dangerT = -1;
  goT: number | null = null;
  defuseHeard: number | null = null;
  stageT = 0;
  fake: { site: string; bots: number[]; lane: Lane; shown: number | null } | null = null;
  lurkGo = false;
  setup = "";
  retakeUtil = false;
  fellBack = new Set<number>();
  rotationSite = "";
  rotationT = 0;
  early: Record<string, Set<number>> = {};
  learnedNow: Float64Array;
  private learnedRound = new Set<string>();
  peeks = new Map<number, V3>();

  constructor(director: MatchDirector, side: Side) {
    this.director = director;
    this.side = side;
    const game = director.game;
    this.game = game;
    this.cfg = BOTS.v2 ?? {};
    this.tm = game.tacticalMap();
    this.nav = game.navmesh();
    this.paths = new PathService(this.nav, Number(this.cfg.path_budget ?? 140));
    this.enemySide = side === "attack" ? "defend" : "attack";
    this.field = new PossibilityField(this.tm, this.enemySide);
    this.learned = new Float64Array(this.tm.n);
    this.learnedNow = new Float64Array(this.tm.n);
    this.rng = new Random(director.rng.random());
    const level = game.level;
    this.sites = new Map(level.zones.filter((z) => z.kind === "bombsite").map((z) => [z.name, z]));
    this.siteCenters = new Map([...this.sites].map(([n, z]) => [n, zoneCenter(z)]));
    for (const s of ["attack", "defend"]) {
      const v = level.spawns.filter((sp) => sp.team === s).map((sp) => [...sp.pos] as V3);
      if (v.length) this.spawnCenter[s] = mean(v);
    }
    this.lanes = buildLanes(level, this.spawnCenter.defend ?? [0, 0, 0]);
    const pp = level.data.practice_positions ?? {};
    this.holds = this.classify(pp.defend ?? []);
    this.lurks = (pp.attack ?? []).map((p: number[]) => [p[0], p[1], p[2]] as V3);
    this.lurkInfo = pp.attack ?? [];
    for (const n of this.sites.keys()) this.siteHistory[n] = 0;
    this.resetRound();
    const team = this;
    this.comms = new Radio({
      now: () => team.game.loop.time,
      radio: (sp, text, key, every) => team.radio(sp as BotAgent, text, key ?? null, every ?? 3.0),
      onRadioFact: (f, speaker) => team.onRadioFact(f, speaker),
      get enemiesAlive() { return team.enemiesAlive; },
    }, this.tm, this.rng, this.cfg.radio);
    this.gadgets = new GadgetAI(this);
    for (const k of [1, 2, 3]) this.paths.setBias(k, TeamStrategy.bias(this.rng.randrange(1 << 30)));
    // bias 4 avoids where the team thinks enemies are (rotations, retakes): the field's danger summed per
    // navmesh rect, refreshed every 2 s
    this.ptRect = Int32Array.from(this.tm.pl.map((q) => { const n = this.nav.locate(q); return n >= 0 ? this.nav.rectOf[n] : -1; }));
    this.nRects = this.nav.rects.length;
    // per-site points that need a full path search, once while loading: the defenders' way in, the
    // attackers' way back, and walking distances from each site over the tactical map
    for (const [name, c] of this.siteCenters) {
      for (const [spawn, out, d] of [["defend", this.rotPts, 9.0], ["attack", this.attPts, 10.0]] as const) {
        const sp = this.spawnCenter[spawn];
        const path = sp ? this.nav.findPath(c, sp) : null;
        out.set(name, path ? along(path, d) : null);
      }
      const ci = this.tm.nearest(c);
      this.siteDist.set(name, ci >= 0 ? this.tm.dijkstra([ci]) : null);
    }
    director.listeners.push((k, d) => this.onEvent(k, d));
    game.fx.listeners.push((name, pos) => this.onSound(name, pos));
  }

  static bias(seed: number): (rect: number) => number {
    return (rect) => {
      const h = Number((BigInt(rect) * 2654435761n + BigInt(seed)) & 0xffffn);
      return 1.0 + 0.35 * h / 0xffff;
    };
  }

  makeBrain(bot: BotAgent): BrainV2 { return new BrainV2(bot, this); }

  get active(): boolean { return this.director.teamBrains.get(this.side) === this; }

  // ------------------------------------------------------------- setup
  private classify(positions: number[][]): Record<string, HoldSpec[]> {
    const out: Record<string, HoldSpec[]> = { A: [], B: [], mid: [] };
    for (const p of positions) {
      const pos: V3 = [p[0], p[1], p[2]];
      let best = "mid", bestD = SITE_AREA;
      for (const [name, c] of this.siteCenters) {
        const d = Math.hypot(pos[0] - c[0], pos[1] - c[1]);
        if (d < bestD) { best = name; bestD = d; }
      }
      (out[best] ??= []).push({ pos, yaw: Number(p[3]), crouch: !!p[4] });
    }
    return out;
  }

  // ------------------------------------------------------------- roster
  bots(): BotAgent[] {
    const now = this.game.loop.time;
    if (now !== this.botsT) {
      this.botsT = now;
      this.botsCache = this.director.bots.filter((b) => b.side === this.side && b.active);
    }
    return this.botsCache;
  }

  aliveBots(): BotAgent[] { return this.bots().filter((b) => b.alive); }
  members(): Participant[] { return this.director.match.participants.filter((a) => a.side === this.side); }

  private enemiesT = -1;
  private enemiesCache: Soldier[] = [];
  /** Living enemies (cached per tick). */
  enemies(): Soldier[] {
    const t = this.game.loop.time;
    if (this.enemiesT !== t) {
      this.enemiesT = t;
      this.enemiesCache = (this.director.match.participants as Soldier[]).filter((a) => a.side && a.side !== this.side && a.alive && a.active);
    }
    return this.enemiesCache;
  }

  thinkSlot(now: number): boolean {
    if (now !== this.thinkT) {
      this.thinkT = now;
      this.thinks = 0;
    }
    if (this.thinks >= THINKS_PER_TICK) return false;
    this.thinks++;
    return true;
  }

  matesOf(bot: BotAgent): BotAgent[] { return this.bots().filter((b) => b.alive && b !== bot); }

  humansAlive(): number {
    const bots = new Set<Participant>(this.director.bots);
    return this.members().filter((a) => !bots.has(a) && a.alive).length;
  }

  roleOf(bot: BotAgent): string { return this.roles.get(bot) ?? ""; }

  // ------------------------------------------------------------- round
  resetRound(): void {
    this.plan = "";
    this.site = "";
    this.phase = "setup";
    this.groups = new Map();
    this.stageArrived = new Set();
    this.firstStageT = null;
    this.execT = null;
    this.commitT = 0;
    this.plantedHandled = false;
    this.retakePhase = "";
    this.gatherT = 0;
    this.defuser = null;
    this.pickupBot = null;
    this.rotated = {};
    this.reports = [];
    this.areaOf = new Map();
    this.shuffleT = 0;
    this.lastContactT = -100;
    this.roundStartT = 0;
    this.roles = new Map();
    this.deaths = [];
    this.nades = [];
    this.facts = [];
    this.radarSeen = new Map();
    this.pendingRadar = [];
    this.tickT = -1;
    this.tickN = 0;
    this.thinkT = -1;
    this.thinks = 0;
    this.stagger = this.side === "attack" ? 0 : 1;
    this.botsT = -1;
    this.botsCache = [];
    this.observeI = 0;
    this.dangerVal = null;
    this.dangerT = -1;
    this.goT = null;
    this.defuseHeard = null;
    this.stageT = 0;
    this.fake = null;
    this.lurkGo = false;
    this.setup = "";
    this.retakeUtil = false;
    this.fellBack = new Set();
    this.rotationSite = "";
    this.rotationT = 0;
    this.early = {};
    this.learnedNow = new Float64Array(this.tm.n);
    this.learnedRound = new Set();
    this.peeks = new Map();
    this.comms?.reset();
  }

  // ---------------------------------------------------------------- buy
  buy(): void {
    const d = this.director;
    const members = this.members();
    const cfg = BOTS.economy ?? {};
    const mode = teamBuyMode(members, d.match, this.side, cfg);
    const bots = [...this.bots()].sort((a, b) => b.money - a.money);
    let awper = bots.find((b) => b.money >= Number(cfg.awp_min ?? 5900)) ?? null;
    if (awper && this.rng.random() < 0.5) awper = null;
    let kits = 0;
    for (const b of bots) {
      const kit = this.side === "defend" && kits < 2;
      const got = botBuy(b, d.shop, this.game.weaponDb, d.rules, mode, cfg, b === awper, kit, this.rng);
      if (got.includes("defuse_kit")) kits++;
    }
    this.buyMode = mode;
  }

  roundStart(now: number): void {
    this.resetRound();
    this.gadgets.reset();
    this.roundStartT = now;
    const d = this.director;
    const timers = d.rules.timers;
    const live = now + Number(timers.freeze_time) + (d.match.skipPrep ? 0 : Number(timers.prep_time ?? 0));
    this.liveT = live;
    const leave = this.enemySide === "attack" ? live : now + Number(timers.freeze_time);
    this.enemiesAlive = (d.match.participants as Soldier[]).filter((a) => a.side === this.enemySide && a.active).length;
    this.field.reset(leave, this.enemiesAlive, this.prior());
    const bots = this.bots();
    if (!bots.length) return;
    const carrier = this.side === "attack" ? d.bomb.carrier : null;
    this.roles = assignRoles(bots, this.side, this.rng, bots.length >= 4, carrier);
    if (this.side === "attack") this.attackPlan(bots, now);
    else this.defendSetup(bots, now);
  }

  private prior(): Float64Array {
    const tm = this.tm;
    const p = new Float64Array(tm.n).fill(1);
    if (this.enemySide === "defend") {
      for (let i = 0; i < tm.n; i++) if (tm.siteId[i] >= 0) p[i] += 2.0;
      for (const site of tm.sites) {
        for (const h of tm.holds(site)) p[h.i] += 3.0;
        for (const f of tm.spots[site]?.forward ?? []) p[f.i] += 1.0;
      }
    } else for (let i = 0; i < tm.n; i++) if (tm.kind[i] & 4) p[i] += 1.5;
    // where this team has seen enemies in earlier rounds (decayed per round)
    let mx = 0;
    for (const v of this.learned) mx = Math.max(mx, v);
    if (mx > 0) for (let i = 0; i < tm.n; i++) p[i] += 4.0 * this.learned[i] / Math.max(mx, 1.0);
    return p;
  }

  // ------------------------------------------------------------ per tick
  /** Called by the first brain to update each tick: radio, radar, field, paths. */
  tick(now: number): void {
    if (now === this.tickT) return;
    this.tickT = now;
    this.paths.update();
    if (this.tm.pending.length) this.tm.update(this.game.world, 24);     // sight lines through opened walls
    this.comms.update(now);
    while (this.pendingRadar.length && this.pendingRadar[0][0] <= now) this.field.addFact((this.pendingRadar.shift() as [number, Fact])[1]);
    this.tickN++;
    const mphase = this.director.match.phase;
    if (now - this.dangerBiasT > 2.0 && (mphase === "live" || mphase === "planted")) {
      this.dangerBiasT = now;
      const d = this.danger();
      const per = new Float64Array(this.nRects);
      for (let i = 0; i < this.ptRect.length; i++) if (this.ptRect[i] >= 0) per[this.ptRect[i]] += d[i];
      const table = Array.from(per, (v) => 1.0 + 3.0 * Math.min(v, 1.0));
      this.paths.setBias(4, (r) => table[r]);
    }
    const bots = this.aliveBots();
    const phase = this.tickN + this.stagger;
    if (bots.length && phase % 3 === 0 && (mphase === "prep" || mphase === "live" || mphase === "planted")) {
      // one bot's view every third tick; the two teams' upkeep is staggered
      const b = bots[this.observeI % bots.length];
      this.observeI++;
      const mask = this.view(b);
      if (mask) {
        this.field.observe(mask, now);
        this.dangerVal = null;
      }
    }
    if (phase % 4 === 2) {
      // one field one hop (about 3 m) every fourth tick
      this.field.step(now);
      this.dangerVal = null;
    }
  }

  private view(b: BotAgent): Uint8Array | null {
    if (b.perception.blind) return null;
    const eye = b.eye();
    const smokes: Array<[V3, number]> = this.game.smoke.clouds.filter((c) => c.density > 0.5).map((c) => [c.pos, c.radius]);
    const m = viewMask(this.tm, eye, b.aim.yaw, Number(b.profile.fov ?? 110), 60.0, smokes);
    // an enemy in sight is a fact (the radar), not an empty point
    for (const c of b.perception.contacts.values()) if (c.seen) for (const i of this.tm.pointsNear(c.pos, 2.5)) m[i] = 0;
    return m;
  }

  /** Expected enemies per tactical point (recomputed when the field changed, at most every 0.1 s). */
  danger(): Float64Array {
    const now = this.game.loop.time;
    if (!this.dangerVal || now - this.dangerT > 0.1) {
      this.dangerVal = this.field.danger(now);
      this.dangerT = now;
    }
    return this.dangerVal;
  }

  // ------------------------------------------------------- knowledge in
  /** A teammate sees an enemy: it shows on the radar now, and in the team's picture. */
  radarReport(fact: Fact): void {
    const k = fact.enemy as number;
    if (fact.time - (this.radarSeen.get(k) ?? -9) < 0.3) return;
    this.radarSeen.set(k, fact.time);
    this.reports.push([fact.time, k, [...fact.pos] as V3]);
    if (this.reports.length > 60) this.reports = this.reports.slice(-60);
    this.lastContactT = fact.time;
    const f = new Fact(k, fact.pos, 1.0, fact.time, "radar");
    this.facts.push(f);
    this.pendingRadar.push([fact.time + 0.5, f]);
    this.earlyNote(f);
  }

  /** A bot fighting an enemy calls it out (comms.ts delays and snaps it). */
  onSighting(bot: BotAgent, contact: Contact, now: number): void {
    const brain = bot.brain!;
    const key = contact.agent.uid;
    this.comms.sighting(bot, key, contact.pos, now, brain.knowledge.hurt(key), brain.human.stress > 0.5);
  }

  /** Footsteps or shots a bot heard: a vaguer callout. */
  onHeard(bot: BotAgent, fact: Fact, now: number): void {
    if (fact.enemy === null) return;
    this.comms.sighting(bot, fact.enemy, fact.pos, now, false, false, 6.0, true);
  }

  onRadioFact(fact: Fact, speaker: string): void {
    this.field.addFact(fact);
    this.facts.push(fact);
    this.lastContactT = Math.max(this.lastContactT, fact.time);
    this.earlyNote(fact);
    for (const b of this.aliveBots()) {
      if (b.name === speaker || b.brain!.human.mistake("ignore_call")) continue;
      b.brain!.knowledge.add(fact);
    }
  }

  /** A ping (drone, camera, gadget): on the HUD for the whole team. */
  intel(enemy: Soldier, pos: V3, now: number): void {
    this.reports.push([now, enemy.uid, [...pos] as V3]);
    this.lastContactT = now;
    const f = new Fact(enemy.uid, [pos[0], pos[1], pos[2]], 1.0, now, "intel");
    this.facts.push(f);
    this.field.addFact(f);
    this.earlyNote(f);
    for (const b of this.aliveBots()) b.brain!.knowledge.add(f);
  }

  /** Remember where enemies showed in the first 40 s, and near which site (adaptation). */
  private earlyNote(f: Fact): void {
    if (f.time - this.liveT > 40.0 || f.enemy === null) return;
    if (f.radius <= 1.5) {
      const i = this.tm.nearest(f.pos);
      const k = `${f.enemy}:${i}`;
      if (i >= 0 && !this.learnedRound.has(k)) {
        this.learnedRound.add(k);
        this.learnedNow[i] += 1.0;
      }
    }
    for (const [name, z] of this.sites) if (zoneDist(z, f.pos) < 18.0) (this.early[name] ??= new Set()).add(f.enemy);
  }

  onTeammateKilled(victim: Soldier, killer: Soldier | null, now: number): void {
    const pos = victim.position();
    const vb = victim as BotAgent;
    const brain = vb.brain ?? null;
    const yaw = brain ? vb.aim.yaw : victim.yaw;
    if (killer && killer.side !== this.side && brain) {
      const c = vb.perception.contacts.get(killer.uid);
      if (c && c.source === "sight" && (c.seen || now - c.time < 1.0)) this.comms.lastWords(vb, killer.uid, c.pos, now, brain.knowledge.hurt(killer.uid));
      if ((brain.task.kind === "hold" || brain.task.kind === "guard") && brain.arrived) {
        const i = this.tm.nearest(pos);
        if (i >= 0) this.spotDeaths.set(i, (this.spotDeaths.get(i) ?? 0) + 1);
      }
    }
    this.deaths.push({ t: now, pos: [...pos] as V3, victim, guess: this.killerGuess(pos, yaw) });
    this.deaths = this.deaths.slice(-8);
    this.lastContactT = now;
  }

  /** Where the teammate was looking when it died: the likeliest visible spot in that direction. */
  private killerGuess(pos: V3, yaw: number | null): V3 | null {
    const tm = this.tm;
    const i = tm.nearest(pos);
    if (i < 0 || yaw === null) return null;
    const vis = tm.seenInView(i, pos, yaw, 40.0, 35.0);
    const danger = this.danger();
    let best = -1, bw = -Infinity;
    for (let j = 0; j < tm.n; j++) {
      if (!vis[j]) continue;
      const dist = Math.hypot(tm.xy[j * 2] - pos[0], tm.xy[j * 2 + 1] - pos[1]);
      if (dist <= 4.0) continue;
      const w = danger[j] + 0.02 / (1.0 + Math.abs(dist - 14.0));
      if (w > bw) { bw = w; best = j; }
    }
    if (best < 0) return null;
    const p = tm.pl[best];
    return [p[0], p[1], p[2]];
  }

  /** A teammate died close by in the last 3 s: [what this bot knows about the killer, where the teammate died],
   * for the two closest teammates only. */
  tradeFact(bot: BotAgent, now: number): [Fact, V3] | null {
    const me = bot.position();
    let best: [Fact, V3] | null = null, bd = 22.0;
    for (const d of this.deaths) {
      if (now - d.t > 3.0 || d.victim === bot) continue;
      const dist = dist3(d.pos, me);
      if (dist >= bd) continue;
      const vp = d.pos;
      const closer = this.matesOf(bot).filter((m) => dist3(m.position(), vp) < dist).length;
      if (closer >= 2) continue;
      const own = bot.brain!.knowledge.recent(3.0, now).filter((f) => ["sight", "sound", "radio", "radar"].includes(f.source)
        && Math.hypot(f.pos[0] - vp[0], f.pos[1] - vp[1]) < 25.0);
      let f: Fact;
      if (own.length) f = own.reduce((a, x) => (x.time > a.time ? x : a));
      else if (d.guess) f = new Fact(null, d.guess, 4.0, d.t, "damage");
      else f = new Fact(null, [vp[0], vp[1], vp[2]], 3.0, d.t, "damage");
      best = [f, [...vp] as V3];
      bd = dist;
    }
    return best;
  }

  nadeAt(pos: ArrayLike<number>, now: number): void {
    this.nades.push([now, [pos[0], pos[1]]]);
    this.nades = this.nades.filter((n) => now - n[0] < 8.0);
  }

  recentNade(pos: ArrayLike<number>, now: number, radius = 7.0, within = 4.0): boolean {
    return this.nades.some(([t, p]) => now - t < within && Math.hypot(p[0] - pos[0], p[1] - pos[1]) < radius);
  }

  radioSay(bot: BotAgent, text: string, key: string | null = null, every = 4.0): void { this.comms.say(bot, text, key, every); }

  radio(bot: BotAgent, text: string, key: string | null = null, every = 3.0): void {
    const now = this.game.loop.time;
    const k = `${this.side}:${key ?? text}`;
    if (now - (this.radioT.get(k) ?? -100) < every) return;
    this.radioT.set(k, now);
    this.director.radio(bot, text);
  }

  say(bot: BotAgent, text: string, key: string | null = null, every = 3.0): void { this.radio(bot, text, key, every); }

  private onEvent(kind: string, data: Record<string, any>): void {
    if (!this.active) return;
    if (kind === "kill") {
      const victim = data.victim as Soldier | null, killer = data.killer as Soldier | null;
      if (victim && victim.side === this.enemySide) {
        this.enemiesAlive = Math.max(this.enemiesAlive - 1, 0);
        this.field.enemyDied(victim.uid);
        for (const b of this.aliveBots()) b.brain!.knowledge.forget(victim.uid);
        const kb = killer as BotAgent | null;
        if (kb && kb.brain && kb.side === this.side) kb.brain.onKill(victim);
      }
    } else if (kind === "round_end") {
      // what worked: plans / setups that won get picked a little more often
      const won = data.result.winnerSide === this.side;
      const key = this.side === "attack" ? this.plan : this.setup;
      if (key) this.worked[key] = Math.min(Math.max((this.worked[key] ?? 1.0) * (won ? 1.25 : 0.85), 0.5), 2.0);
    } else if (kind === "bomb_planted" && this.side === "defend") {
      // the planter was at the charge (it shows on everyone's radar)
      const b = this.director.bomb;
      const f = new Fact(null, [...b.pos] as V3, 1.5, this.game.loop.time, "intel");
      this.field.addFact(f);
      this.facts.push(f);
    }
  }

  recentFacts(now: number, maxAge = 8.0): Fact[] {
    this.facts = this.facts.filter((f) => now - f.time < 20.0);
    return this.facts.filter((f) => now - f.time <= maxAge);
  }

  /** [different enemies reported near the site, utility there, a teammate died there]. */
  siteEvidence(site: string, now: number, maxAge = 8.0): [number, boolean, boolean] {
    const z = this.sites.get(site)!;
    const keys = new Set(this.recentFacts(now, maxAge).filter((f) => f.enemy !== null && zoneDist(z, f.pos) < 16.0).map((f) => f.enemy));
    const util = this.game.smoke.clouds.some((c) => c.density > 0.3 && zoneDist(z, c.pos) < 12.0);
    const died = this.deaths.some((d) => now - d.t < maxAge && zoneDist(z, d.pos) < 12.0);
    return [keys.size, util, died];
  }

  onArrived(bot: BotAgent, task: Task): void {
    if (task.tag === "stage") {
      this.stageArrived.add(bot.uid);
      if (this.firstStageT === null) this.firstStageT = bot.now;
    }
  }

  taskDone(bot: BotAgent, task: Task): void {
    if (["hunt", "pickup", "plant", "defuse"].includes(task.kind)) bot.brain!.setTask(new Task("idle"));
  }

  // -------------------------------------------------------------- attack
  private attackPlan(bots: BotAgent[], now: number): void {
    const sites = [...this.sites.keys()].filter((s) => this.lanes.get(s)?.length);
    if (!sites.length) return;
    // site: what worked, minus where defenders were seen early, minus repetition
    const recentSites = this.planHistory.slice(-3).filter((h) => h.includes(":")).map((h) => h.split(":")[1]);
    const sw = sites.map((s) => {
      let w = 1.0 + 0.3 * (this.siteHistory[s] ?? 0) - 0.15 * (this.siteSeen[s] ?? 0);
      w *= 0.6 ** recentSites.filter((x) => x === s).length;
      return Math.max(w, 0.15);
    });
    this.site = this.rng.choices(sites, sw)[0];
    const weights: Record<string, number> = {};
    for (const [p, w] of Object.entries(PLAN_WEIGHTS)) weights[p] = w * (this.worked[p] ?? 1.0);
    if (this.lanes.get(this.site)!.length < 2 || bots.length < 4) delete weights.split;
    if (bots.length < 4 || sites.length < 2) delete weights.fake;
    if (this.buyMode === "eco") for (const p of ["rush", "contact"]) weights[p] *= 3.0;
    this.plan = pickVaried(weights, this.planHistory.map((h) => h.split(":")[0]), this.rng);
    this.planHistory.push(`${this.plan}:${this.site}`);
    this.commitT = this.liveT + this.rng.uniform(22.0, 40.0);
    const lurker = bots.find((b) => this.roles.get(b) === "lurker") ?? null;
    const lanes0 = this.lanes.get(this.site)!;
    if (this.plan === "rush") {
      const lane = lanes0.reduce((a, l) => (l.points.length < a.points.length ? l : a));
      for (const b of bots) this.goSite(b, lane, "rush");
      this.phase = "exec";
      this.execT = now;
      this.say(bots[0], `Rush ${this.site}, go go go!`);
      return;
    }
    if (this.plan === "default") {
      const pool = Array.from({ length: this.lurks.length }, (_, i) => i);
      this.rng.shuffle(pool);
      const carrier = this.director.bomb.carrier;
      for (const b of bots) {
        if (b === carrier || !pool.length) {
          this.stage(b, this.rng.choice(lanes0));
          continue;
        }
        const info = this.lurkInfo[pool.pop() as number];
        b.brain!.setTask(new Task("hold", { pos: this.snap(info), yaw: Number(info[3]), crouch: !!info[4], wait: true, tag: "control", walkNear: 10.0 }));
      }
      this.phase = "control";
      this.say(bots[0], "Default, take map control.");
      return;
    }
    if (this.plan === "contact") {
      const lane = this.rng.choice(lanes0);
      for (const b of bots) this.stage(b, lane, true);
      this.phase = "contact";
      this.say(bots[0], `Walk ${this.site}, quiet until contact.`);
      return;
    }
    const lanes = [...lanes0];
    this.rng.shuffle(lanes);
    if (this.plan === "fake") {
      const other = this.rng.choice(sites.filter((s) => s !== this.site));
      const fakers = bots.filter((b) => b !== this.director.bomb.carrier && b !== lurker)
        .map((b, i) => ({ b, i, k: -(this.roles.get(b) === "support" ? 1 : 0) - b.brain!.traits.utility }))
        .sort((x, y) => x.k - y.k || x.i - y.i).slice(0, 2).map((x) => x.b);
      const flane = this.rng.choice(this.lanes.get(other)!);
      for (const b of fakers) this.stage(b, flane, false, other, "fake");
      this.fake = { site: other, bots: fakers.map((b) => b.uid), lane: flane, shown: null };
      for (const b of bots.filter((x) => !fakers.includes(x))) this.stage(b, lanes[0]);
      this.phase = "stage";
      this.stageT = now;
      this.say(bots[0], `Fake ${other}, we hit ${this.site}.`);
      return;
    }
    let use = this.plan === "split" ? lanes.slice(0, 2) : lanes.slice(0, 1);
    if (this.plan === "execute" && bots.length >= 4 && lanes.length > 1 && this.rng.random() < 0.3) use = lanes.slice(0, 2);
    // entry and trade together on the first lane, support with them; others spread
    const rank: Record<string, number> = { entry: 0, trade: 1, support: 2, awper: 3, lurker: 4 };
    const order = bots.map((b, i) => ({ b, i })).sort((x, y) => (rank[this.roles.get(x.b) ?? ""] ?? 5) - (rank[this.roles.get(y.b) ?? ""] ?? 5) || x.i - y.i).map((x) => x.b);
    order.forEach((b, i) => {
      if (b === lurker && (this.plan === "execute" || this.plan === "split")) {
        this.lurk(b);
        return;
      }
      const role = this.roles.get(b);
      this.stage(b, role === "entry" || role === "trade" ? use[0] : use[i % use.length]);
    });
    this.phase = "stage";
    this.stageT = now;
    this.say(bots[0], `Let's take ${this.site}` + (use.length > 1 ? ", split." : "."));
  }

  private stage(bot: BotAgent, lane: Lane, walk = false, site: string | null = null, tag = "stage"): void {
    const pts = lane.points;
    const stage = this.snap(pts[lane.stage]);
    this.groups.set(bot.uid, { lane, stage });
    const sc = this.siteCenters.get(site ?? this.site)!;
    bot.brain!.setTask(new Task("move", { pos: stage, via: pts.slice(0, lane.stage), look: up(sc, 1.0), wait: true, tag, walk, walkNear: 14.0 }));
  }

  /** A flank spot away from the site being hit, watching the defenders' way across. */
  private lurk(bot: BotAgent): void {
    const others = [...this.sites.keys()].filter((s) => s !== this.site && this.lanes.get(s)?.length);
    if (!others.length) {
      this.stage(bot, this.rng.choice(this.lanes.get(this.site)!));
      return;
    }
    const lane = this.rng.choice(this.lanes.get(others[0])!);
    const stage = this.snap(lane.points[lane.stage]);
    this.groups.set(bot.uid, { lane, stage, lurk: true });
    bot.brain!.setTask(new Task("hold", { pos: stage, via: lane.points.slice(0, lane.stage), look: up(this.siteCenters.get(others[0])!, 1.2),
      wait: true, tag: "lurk", walk: true }));
    this.say(bot, `Lurking ${others[0]}.`, "lurk", 30.0);
  }

  /** Into the site along the rest of the lane: the carrier plants, the others clear spots. */
  private goSite(bot: BotAgent, lane: Lane, tag = "clear"): void {
    const pts = lane.points;
    const via = tag !== "rush" ? pts.slice(lane.stage) : pts.slice();
    if (this.director.bomb.carrier === bot) {
      bot.brain!.setTask(new Task("plant", { pos: this.plantSpot(), via, tag: "plant" }));
      return;
    }
    const [spot, look] = this.clearSpot(bot, lane);
    bot.brain!.setTask(new Task("move", { pos: spot, via, look, wait: true, tag }));
  }

  /** A defenders' hold spot of the site that nobody is clearing yet, near this lane's entry. */
  private clearSpot(bot: BotAgent, lane: Lane): [V3, V3] {
    const tm = this.tm;
    const taken = this.aliveBots().filter((b) => b !== bot && b.brain!.task.pos && ["clear", "rush"].includes(b.brain!.task.tag))
      .map((b) => b.brain!.task.pos as V3);
    const entry = lane.points[lane.points.length - 1];
    let best: V3 | null = null, bs = 1e9;
    for (const h of tm.holds(this.site)) {
      const p = tm.pl[h.i];
      if (taken.some((t) => Math.hypot(p[0] - t[0], p[1] - t[1]) < 3.0)) continue;
      const s = Math.hypot(p[0] - entry[0], p[1] - entry[1]) + this.rng.uniform(0, 6);
      if (s < bs) { best = [p[0], p[1], p[2]]; bs = s; }
    }
    const sc = this.siteCenters.get(this.site)!;
    return [best ?? this.snap(sc), up(sc, 1.2)];
  }

  private plantSpot(): V3 {
    const z = this.sites.get(this.site)!;
    const c = this.siteCenters.get(this.site)!;
    for (let k = 0; k < 20; k++) {
      const p = this.nav.randomPoint(this.rng, [c[0], c[1], z.min[2] + 0.6], 4.0);
      if (p && zoneDist(z, p) === 0) return [p[0], p[1], p[2]];
    }
    return this.snap(c);
  }

  private updateAttack(bots: BotAgent[], now: number): void {
    const d = this.director;
    const bomb = d.bomb;
    const left = d.match.roundTimeLeft();
    if (bomb.state === "planted") {
      if (!this.plantedHandled) {
        this.plantedHandled = true;
        this.siteHistory[bomb.site] = (this.siteHistory[bomb.site] ?? 0) + 1;
        this.postPlant(bots);
      } else if (d.match.bombTimeLeft() < 7.0 && this.phase !== "flee") {
        this.phase = "flee";
        this.flee(bots, bomb.pos);
      }
      return;
    }
    const carrier = bomb.carrier;
    if (carrier && carrier.isHuman && ["stage", "control", "contact"].includes(this.phase)) {
      for (const [name, z] of this.sites) {
        if (zoneDist(z, carrier.position()) < 15.0 && name !== this.site && this.lanes.get(name)?.length) {
          this.site = name;
          this.execute(bots, now);
          return;
        }
      }
    }
    if (bomb.state === "dropped") {
      if (!this.pickupBot || !this.pickupBot.alive || !bots.includes(this.pickupBot)) {
        this.pickupBot = bots.reduce((a, b) => (dist3(b.position(), bomb.pos) < dist3(a.position(), bomb.pos) ? b : a));
        this.pickupBot.brain!.setTask(new Task("pickup", { pos: [...bomb.pos] as V3, tag: "bomb" }));
        this.say(this.pickupBot, "I'll get the charge.");
      }
    } else if (this.pickupBot) {
      const pb = this.pickupBot;
      this.pickupBot = null;
      if (pb.alive && bomb.carrier === pb) {
        this.say(pb, "I have the charge.");
        if (this.phase === "exec" || this.phase === "go") pb.brain!.setTask(new Task("plant", { pos: this.plantSpot(), tag: "plant" }));
        else this.stage(pb, this.rng.choice(this.lanes.get(this.site)!));
      }
    }
    if (this.phase === "control") {
      if (now >= this.commitT || left < 50.0) this.midRoundCall(bots, now);
    } else if (this.phase === "contact") {
      const hit = this.recentFacts(now, 3.0).some((f) => now - f.time < 3.0) || this.deaths.some((dd) => now - dd.t < 3.0);
      const arrived = bots.filter((b) => this.stageArrived.has(b.uid)).length;
      if (hit || arrived >= Math.max(1, Math.trunc(bots.length / 2)) || left < 45.0) {
        const me = bots[0].position();
        const cands = [...this.sites.keys()].filter((s) => this.lanes.get(s)?.length);
        this.site = cands.reduce((a, s) => (dist3(this.siteCenters.get(s)!, me) < dist3(this.siteCenters.get(a)!, me) ? s : a));
        this.execute(bots, now);
      }
    } else if (this.phase === "stage") {
      if (this.fake && !this.fakeDone(now) && left >= 40.0) return;
      const main = bots.filter((b) => (!this.fake || !this.fake.bots.includes(b.uid)) && !this.groups.get(b.uid)?.lurk);
      // staged: arrived, or close to the staging point (perhaps busy fighting there)
      const staged = main.filter((b) => this.stageArrived.has(b.uid) || (this.groups.has(b.uid) && dist3(b.position(), this.groups.get(b.uid)!.stage) < 8.0));
      if (staged.length && this.firstStageT === null) this.firstStageT = now;
      let ready = staged.length >= Math.max(1, Math.ceil(main.length * 0.6));
      if (this.plan === "split") {
        const lanes = new Set(staged.filter((b) => this.groups.has(b.uid)).map((b) => this.groups.get(b.uid)!.lane.name));
        const all = new Set([...this.groups.values()].map((g) => g.lane.name));
        ready = ready && lanes.size >= Math.min(2, all.size);
      }
      const waited = (this.firstStageT !== null && now - this.firstStageT > 12.0) || now - this.stageT > 35.0;
      const breaching = this.gadgets.breachBusy() && left >= 40.0 && now - this.stageT < 30.0;
      if ((ready || waited || left < 35.0) && !breaching) this.execute(bots, now);
    } else if (this.phase === "exec") {
      if (this.goT !== null && now >= this.goT) {
        this.goT = null;
        this.go(bots);
      }
    } else if (this.phase === "go") {
      const c = bomb.carrier as BotAgent | null;
      if (c && !c.isHuman && c.alive && c.brain && c.brain.task.kind !== "plant") c.brain.setTask(new Task("plant", { pos: this.plantSpot(), tag: "plant" }));
      const lurker = bots.find((b) => this.roles.get(b) === "lurker");
      if (lurker && !this.lurkGo && (now - (this.execT ?? now) > 6.0 || left < 30.0)) {
        this.lurkGo = true;
        this.hitRotation(lurker);
      }
      if (left < 25.0) {
        for (const b of bots) if (b.brain!.task.kind === "hold" && b.brain!.task.tag !== "rotation") this.goSite(b, this.laneFor(b));
      }
    }
  }

  /** The fake has been shown: utility thrown or contact at the fake site, or time. */
  private fakeDone(now: number): boolean {
    const fk = this.fake!;
    const at = this.aliveBots().filter((b) => fk.bots.includes(b.uid) && this.stageArrived.has(b.uid));
    if (fk.shown === null && at.length) {
      fk.shown = now;
      const sc = this.siteCenters.get(fk.site)!;
      for (const b of at) for (const key of ["smoke", "flash", "frag"]) if (b.brain!.orderThrow(key, up(sc, 1.0), 4.0)) break;
      this.say(at[0], `Showing ${fk.site}.`, "fake", 20.0);
    }
    if (fk.shown === null) return now - this.liveT > 35.0;
    return now - fk.shown > 5.0;
  }

  /** Default: commit where the team saw or heard fewer defenders. */
  private midRoundCall(bots: BotAgent[], now: number): void {
    const counts = new Map<string, number>();
    for (const name of this.sites.keys()) {
      if (!this.lanes.get(name)?.length) continue;
      const [n, util, died] = this.siteEvidence(name, now, 25.0);
      counts.set(name, n + (died ? 1.0 : 0) + (util ? 0.5 : 0));
    }
    const low = Math.min(...counts.values());
    const cands = [...counts].filter(([, c]) => c === low).map(([n]) => n);
    this.site = cands.includes(this.site) ? this.site : this.rng.choice(cands);
    this.planHistory[this.planHistory.length - 1] = `${this.plan}:${this.site}`;
    const lurker = bots.find((b) => this.roles.get(b) === "lurker");
    for (const b of bots) {
      if (b === lurker) this.lurk(b);
      else this.stage(b, this.rng.choice(this.lanes.get(this.site)!));
    }
    this.phase = "stage";
    this.stageT = now;
    this.firstStageT = null;
    this.stageArrived = new Set();
    this.say(bots[0], `Regroup for ${this.site}.`);
  }

  /** Utility first, then go a moment later. */
  private execute(bots: BotAgent[], now: number): void {
    this.phase = "exec";
    this.execT = now;
    const site = this.site;
    const throwers = bots.map((b, i) => ({ b, i })).sort((x, y) =>
      (this.roles.get(x.b) !== "support" ? 1 : 0) - (this.roles.get(y.b) !== "support" ? 1 : 0)
      || y.b.brain!.traits.utility - x.b.brain!.traits.utility || x.i - y.i).map((x) => x.b);
    let flash: BotAgent | null = null, smoke: BotAgent | null = null;
    for (const b of throwers) {
      if (!flash && (b.weapons.inv.grenades.flash ?? 0) > 0) {
        if (b.brain!.orderThrow("flash", this.entryFlashPoint(b, site), 3.0)) {
          flash = b;
          continue;
        }
      }
      if (!smoke && (b.weapons.inv.grenades.smoke ?? 0) > 0) {
        const p = this.rotationPoint(site);
        if (p && b.brain!.orderThrow("smoke", p, 4.0)) smoke = b;
      }
    }
    this.goT = now + (flash ? 1.3 : smoke ? 0.4 : 0.0);
    if (this.goT <= now) this.go(bots);
    if (flash) this.say(flash, `Flash going ${site}.`, "flashgo", 10.0);
  }

  /** A point just inside the site past the entry nearest to the thrower. */
  private entryFlashPoint(bot: BotAgent, site: string): V3 {
    const tm = this.tm;
    const ents = tm.entries(site);
    const sc = this.siteCenters.get(site)!;
    if (!ents.length) return up(sc, 2.0);
    const p = bot.position();
    const e = ents.reduce((a, i) => (Math.hypot(tm.pl[i][0] - p[0], tm.pl[i][1] - p[1]) < Math.hypot(tm.pl[a][0] - p[0], tm.pl[a][1] - p[1]) ? i : a));
    const q = tm.pl[e];
    let vx = sc[0] - q[0], vy = sc[1] - q[1];
    const l = Math.hypot(vx, vy);
    if (l * l > 1e-4) { vx /= l; vy /= l; }
    return [q[0] + vx * 4.0, q[1] + vy * 4.0, q[2] + 2.2];
  }

  private go(bots: BotAgent[]): void {
    this.phase = "go";
    const lurker = bots.find((b) => this.roles.get(b) === "lurker");
    for (const b of bots) {
      if (b === lurker && (this.plan === "execute" || this.plan === "split") && b.brain!.task.tag === "lurk") continue;
      this.goSite(b, this.laneFor(b));
    }
    this.say(bots[0], `Go ${this.site}! Go!`);
  }

  private laneFor(b: BotAgent): Lane {
    const g = this.groups.get(b.uid);
    const lanes = this.lanes.get(this.site) ?? [];
    if (g && !g.lurk && lanes.includes(g.lane)) return g.lane;
    const p = b.position();
    const dd = (ln: Lane) => Math.hypot(ln.points[ln.stage][0] - p[0], ln.points[ln.stage][1] - p[1]);
    return lanes.reduce((a, ln) => (dd(ln) < dd(a) ? ln : a));
  }

  /** The lurker comes in behind the defenders rotating to the site. */
  private hitRotation(bot: BotAgent): void {
    const p = this.rotationPoint(this.site);
    if (!p) {
      this.goSite(bot, this.laneFor(bot));
      return;
    }
    bot.brain!.setTask(new Task("move", { pos: p, look: up(this.siteCenters.get(this.site)!, 1.2), wait: true, tag: "rotation", walkNear: 12.0 }));
    this.say(bot, "Coming from behind.", "lurkgo", 30.0);
  }

  /** Play for time: hide a corner away from the charge, out of sight of the defenders' way in, each next to a
   * peek spot that sees the charge from a different side. The defuse start is heard: then everyone swings. */
  private postPlant(bots: BotAgent[]): void {
    const bomb = this.director.bomb;
    const spots = this.hideSpots(bomb.pos, bots.length);
    this.peeks = new Map();
    bots.forEach((b, k) => {
      if (k >= spots.length) return;
      const [hide, peek] = spots[k];
      this.peeks.set(b.uid, peek);
      const look = dist3(peek, hide) > 0.5 ? null : up(bomb.pos, 0.6);
      b.brain!.setTask(new Task("guard", { pos: hide, look, wait: true, tag: "post" }));
    });
    this.phase = "post";
    this.defuseHeard = null;
    this.say(bots[0], `Charge planted at ${bomb.site}. Hide and listen for the defuse.`);
  }

  /** (hide, peek) pairs: hide points 6-20 m from the charge that neither the charge nor the defenders' way in
   * can see, each with a peek point within 3.5 m that sees the charge. */
  private hideSpots(target: V3, n: number): Array<[V3, V3]> {
    const tm = this.tm;
    const ti = tm.nearest(target);
    if (ti < 0) return this.crossfireOn(target, n).map(([p]) => [p, p]);
    const bsite = this.director.bomb.site;
    const rot = bsite ? this.rotationPoint(bsite) : null;
    const ri = rot ? tm.nearest(rot) : -1;
    const vs = tm.visibleMask(ti), vl = tm.visibleMask(ti, true);
    const seesBomb = (i: number) => vs[i] || vl[i];
    const seenIn = ri >= 0 ? tm.visibleMask(ri) : new Uint8Array(tm.n);
    const dist = new Float64Array(tm.n);
    const dx = new Float64Array(tm.n), dy = new Float64Array(tm.n);
    const cand: number[] = [];
    for (let i = 0; i < tm.n; i++) {
      dx[i] = tm.xy[i * 2] - target[0];
      dy[i] = tm.xy[i * 2 + 1] - target[1];
      dist[i] = Math.hypot(dx[i], dy[i]);
      if (!seesBomb(i) && !seenIn[i] && dist[i] > 6.0 && dist[i] < 20.0 && Math.abs(tm.z[i] - target[2]) < 3.0) cand.push(i);
    }
    // on the attackers' side of the charge: the retake gathers on the defenders' side
    const etaA = tm.eta.attack, etaD = tm.eta.defend;
    const keyed = cand.map((i) => ({ i, k: Math.abs(dist[i] - 11.0) + (etaA && etaD && etaD[i] < etaA[i] ? 8.0 : 0) + this.rng.random() * 4.0 }));
    keyed.sort((a, b) => a.k - b.k);
    const order = keyed.slice(0, 60).map((x) => x.i);
    const out: Array<[V3, V3]> = [];
    const angs: number[] = [];
    const used: Array<ArrayLike<number>> = [];
    for (const i of order) {
      const peeks = tm.pointsNear(tm.pl[i], 3.5, 1.0).filter((j) => seesBomb(j) && dist[j] > 4.0);
      if (!peeks.length) continue;
      const d2 = (j: number) => (tm.xy[j * 2] - tm.xy[i * 2]) ** 2 + (tm.xy[j * 2 + 1] - tm.xy[i * 2 + 1]) ** 2;
      const j = peeks.reduce((a, x) => (d2(x) < d2(a) ? x : a));
      const a = Math.atan2(dy[j], dx[j]);
      if (angs.some((b) => Math.abs((((a - b + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI) < 40 * Math.PI / 180)) continue;
      if (used.some((u) => Math.hypot(tm.xy[i * 2] - u[0], tm.xy[i * 2 + 1] - u[1]) < 4.0)) continue;
      out.push([[...tm.pl[i]] as V3, [...tm.pl[j]] as V3]);
      angs.push(a);
      used.push(tm.pl[i]);
      if (out.length >= n) break;
    }
    if (out.length < n) out.push(...this.crossfireOn(target, n - out.length).map(([p]) => [p, p] as [V3, V3]));
    return out;
  }

  /** Positional sounds the team can hear: a defuse starting on the planted charge. */
  private onSound(name: string, pos: V3): void {
    if (name !== "defuse_start" || this.side !== "attack" || !this.active) return;
    if (this.director.bomb.state !== "planted") return;
    const near = this.aliveBots().filter((b) => dist3(b.position(), pos) < 45.0);
    if (!near.length) return;
    const now = this.game.loop.time;
    this.defuseHeard = now;
    const f = new Fact(null, [pos[0], pos[1], pos[2]], 1.0, now, "sound");
    this.field.addFact(f);
    for (const b of near) {
      b.brain!.knowledge.add(f);
      b.brain!.nextThink = now;
    }
    this.say(near[0], "They're defusing!", "defusing", 5.0);
    this.stopDefuse();
  }

  /** Everyone swings at once: to its peek spot, crosshair on the charge. */
  private stopDefuse(): void {
    const bomb = this.director.bomb;
    const target = up(bomb.pos, 0.5);
    for (const b of this.aliveBots()) {
      const t = b.brain!.task;
      if (t.tag !== "post" || !t.pos) continue;
      let peek = this.peeks.get(b.uid) ?? null;
      if (!peek || dist3(peek, t.pos) < 0.5) peek = this.snap(bomb.pos);
      b.brain!.setTask(new Task("move", { pos: [...peek] as V3, look: target, wait: true, tag: "retake" }));
    }
  }

  /** Spots with a view of the charge, hidden from the defenders' way in, at different angles. */
  private crossfireOn(target: V3, n: number): Array<[V3, boolean]> {
    const tm = this.tm;
    const world = this.game.world;
    const ti = tm.nearest(target);
    const bsite = this.director.bomb.site;
    const rot = bsite ? this.rotationPoint(bsite) : null;
    const ri = rot ? tm.nearest(rot) : -1;
    if (ti < 0) return Array.from({ length: n }, () => [this.snap(target), false]);
    const vl = tm.visibleMask(ti, true);
    const scored: Array<[number, number]> = [];
    for (let i = 0; i < tm.n; i++) {
      const dist = Math.hypot(tm.xy[i * 2] - target[0], tm.xy[i * 2 + 1] - target[1]);
      if (!vl[i] || dist <= 5.0 || dist >= 18.0) continue;
      let s = this.rng.random() * 0.6 + (tm.cover[i] ? 0.8 : 0) - Math.abs(dist - 11.0) * 0.05;
      if (ri >= 0 && tm.sees(ri, i)) s -= 1.0;
      scored.push([s, i]);
    }
    scored.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    const out: Array<[V3, boolean]> = [];
    const angs: number[] = [];
    for (const [, i] of scored) {
      const a = Math.atan2(tm.xy[i * 2 + 1] - target[1], tm.xy[i * 2] - target[0]);
      if (angs.some((b) => Math.abs((((a - b + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI) < 50 * Math.PI / 180)) continue;
      const p = tm.pl[i];
      const q: V3 = [p[0], p[1], p[2]];
      if (world.ray(up(q, 1.0), up(target, 0.3), MASK_SIGHT) !== null) continue;
      out.push([q, !tm.sees(ti, i) || this.rng.random() < 0.4]);
      angs.push(a);
      if (out.length >= n) break;
    }
    while (out.length < n) out.push([this.snap([target[0] + this.rng.uniform(-5, 5), target[1] + this.rng.uniform(-5, 5), target[2]]), false]);
    return out;
  }

  /** Get out of the blast before the charge goes off. */
  private flee(bots: BotAgent[], bombPos: V3): void {
    for (const b of bots) {
      const p = b.position();
      if (dist3(p, bombPos) > 32.0) continue;
      let ax = p[0] - bombPos[0], ay = p[1] - bombPos[1];
      if (ax * ax + ay * ay < 1e-4) { ax = 1; ay = 0; }
      const l = Math.hypot(ax, ay);
      ax /= l; ay /= l;
      let best: V3 | null = null;
      for (let k = 0; k < 16; k++) {
        const q = this.nav.randomPoint(this.rng, [p[0] + ax * 26, p[1] + ay * 26, p[2]], 10.0);
        if (q && dist3(q, bombPos) > 30.0) { best = [q[0], q[1], q[2]]; break; }
      }
      if (!best) best = this.snap(this.spawnCenter.attack ?? p);
      b.brain!.setTask(new Task("move", { pos: best, wait: true, tag: "flee" }));
    }
    this.radio(bots[0], "Charge is about to blow, get clear!");
  }

  // ------------------------------------------------------------- defence
  private defendSetup(bots: BotAgent[], now: number): void {
    const n = bots.length;
    const sites = [...this.sites.keys()].sort();
    const hit: Record<string, number> = Object.fromEntries(sites.map((s) => [s, this.attacked[s] ?? 0]));
    const weights: Record<string, number> = {};
    for (const [k, w] of Object.entries(SETUP_WEIGHTS)) weights[k] = w * (this.worked[k] ?? 1.0);
    const hv = Object.values(hit);
    if (n < 4 || (hv.length ? Math.max(...hv) : 0) - (hv.length ? Math.min(...hv) : 0) < 2) weights.stack *= 0.3;
    if (n < 3) { delete weights.aggro; delete weights.retake; }
    this.setup = pickVaried(weights, this.setupHistory, this.rng, 0.6, 4);
    this.setupHistory.push(this.setup);
    const rank: Record<string, number> = { anchor: 0, awper: 1, support: 2, rotator: 3 };
    const ordered = bots.map((b, i) => ({ b, i })).sort((x, y) => (rank[this.roles.get(x.b) ?? ""] ?? 4) - (rank[this.roles.get(y.b) ?? ""] ?? 4) || x.i - y.i).map((x) => x.b);
    let plan: string[];
    if (this.setup === "stack") {
      const stack = maxBy(sites, (s) => [hit[s], this.rng.random()]);
      plan = [stack, stack, stack, ...sites.filter((s) => s !== stack).slice(0, 1), ...Array(Math.max(n - 4, 0)).fill("mid")];
    } else if (this.setup === "retake") {
      plan = [...sites.slice(0, 2), ...Array(Math.max(n - 2, 0)).fill("mid")];
    } else {
      const table: Record<number, string[]> = { 1: ["mid"], 2: sites.slice(0, 2), 3: [...sites.slice(0, 2), "mid"],
        4: [sites[0], sites[0], sites[sites.length - 1], "mid"], 5: [sites[0], sites[0], sites[sites.length - 1], sites[sites.length - 1], "mid"] };
      plan = [...(table[n] ?? [...sites, ...sites, ...sites].slice(0, n))];
      if (n === 4 && this.rng.random() < 0.5) plan = [sites[0], sites[sites.length - 1], sites[sites.length - 1], "mid"];
    }
    plan = plan.slice(0, n);
    // anchors first to the sites, rotators to mid (a stable sort)
    plan = [...plan.filter((a) => a !== "mid"), ...plan.filter((a) => a === "mid")];
    const used = new Set<number>();
    const bySite = new Map<string, BotAgent[]>();
    ordered.forEach((b, k) => {
      if (k >= plan.length) return;
      const area = plan[k];
      if (!bySite.has(area)) bySite.set(area, []);
      bySite.get(area)!.push(b);
    });
    for (const [area, group] of bySite) {
      if (area === "mid") for (const b of group) this.holdIn(b, "mid", used);
      else this.holdSite(group, area, used);
    }
    if (this.setup === "aggro") {
      const pushers = bots.filter((b) => this.roles.get(b) !== "anchor" && b.brain!.traits.aggression > 0.4);
      for (const b of pushers.slice(0, 2)) this.forward(b, now);
    }
    this.phase = "hold";
    this.shuffleT = now + this.rng.uniform(20.0, 30.0);
  }

  private holdTask(h: HoldLike, tag = "hold", walkNear = 0): Task {
    const tm = this.tm;
    const p = h.pos ?? tm.pl[h.i as number];
    let look: V3 | null = null;
    if (h.sees && h.sees.length) look = up(tm.pl[this.rng.choice(h.sees)], 1.5);
    else if (h.yaw !== undefined && h.yaw !== null) {
      const r = h.yaw * Math.PI / 180;
      look = [p[0] - Math.sin(r) * 10.0, p[1] + Math.cos(r) * 10.0, p[2] + 1.5];
    }
    return new Task("hold", { pos: [p[0], p[1], p[2]], look, crouch: !!h.crouch, wait: true, tag, walkNear });
  }

  /** The tactical map's hold spots plus the map's hand-placed defender positions, each with the entries it sees. */
  private siteHolds(site: string): HoldLike[] {
    const hit = this.siteHoldsCache.get(site);
    if (hit) return hit;
    const tm = this.tm;
    const out: HoldLike[] = [...tm.holds(site)];
    const top = out.length ? Math.max(...out.map((h) => h.score ?? 0)) : 1.0;
    const ents = tm.entries(site);
    for (const a of this.holds[site] ?? []) {
      const i = tm.nearest(a.pos);
      if (i < 0) continue;
      const sees = ents.filter((e) => tm.sees(i, e) || tm.sees(i, e, true));
      out.push({ i, pos: [...a.pos], score: top * 1.1, sees, crouch: a.crouch, yaw: a.yaw, authored: true });
    }
    this.siteHoldsCache.set(site, out);
    return out;
  }

  /** k hold spots: a crossfire for two, spots that died before used less. */
  private pickHolds(site: string, k: number, used: Set<number>): HoldLike[] {
    const tm = this.tm;
    const holds = this.siteHolds(site).filter((h) => !used.has(h.i as number));
    if (!holds.length) return [];
    const wcache = new Map<HoldLike, number>();
    const w = (h: HoldLike) => {
      let v = wcache.get(h);
      if (v === undefined) {
        v = Math.max(h.score ?? 0, 0.1) * 0.35 ** (this.spotDeaths.get(h.i as number) ?? 0) * this.rng.uniform(0.6, 1.4);
        wcache.set(h, v);
      }
      return v;
    };
    if (k >= 2) {
      const cross = (tm.spots[site]?.crossfires ?? []).filter((c) => !used.has(c[0]) && !used.has(c[1]));
      if (cross.length && this.rng.random() < 0.8) {
        const byi = new Map(tm.holds(site).map((h) => [h.i, h]));
        const c = maxBy(cross, (cc) => [w(byi.get(cc[0])!) + w(byi.get(cc[1])!)]);
        const out: HoldLike[] = [{ ...byi.get(c[0])!, sees: [c[2]] }, { ...byi.get(c[1])!, sees: [c[2]] }];
        const rest = holds.filter((h) => h.i !== c[0] && h.i !== c[1]).sort((a, b) => w(b) - w(a));
        return [...out, ...rest.slice(0, k - 2)];
      }
    }
    return [...holds].sort((a, b) => w(b) - w(a)).slice(0, k);
  }

  private holdSite(group: BotAgent[], site: string, used: Set<number>, tag = "hold", walkNear = 0): void {
    const tm = this.tm;
    // match spots to guns: the shortest angles to the SMGs and shotguns, the longest to the rifles and sniper
    const reach = (h: HoldLike) => {
      const ents = h.sees ?? [];
      if (!ents.length) return 15.0;
      const i = h.i as number;
      return ents.reduce((s, e) => s + Math.hypot(tm.xy[e * 2] - tm.xy[i * 2], tm.xy[e * 2 + 1] - tm.xy[i * 2 + 1]), 0) / ents.length;
    };
    const wants = (b: BotAgent) => {
      const w = b.weapons.primary;
      const cls = w ? w.d.cls : "pistol";
      return ({ smg: 0.0, shotgun: 0.0, pistol: 0.3, rifle: 0.7, sniper: 1.0 } as Record<string, number>)[cls] ?? 0.6;
    };
    const picks = this.pickHolds(site, group.length, used).map((h, i) => ({ h, i, r: reach(h) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.h);
    const sortedGroup = group.map((b, i) => ({ b, i, w: wants(b) })).sort((a, b) => a.w - b.w || a.i - b.i).map((x) => x.b);
    sortedGroup.forEach((b, k) => {
      if (k >= picks.length) return;
      const h = picks[k];
      used.add(h.i as number);
      this.areaOf.set(b.uid, site);
      b.brain!.setTask(this.holdTask(h, tag, walkNear));
    });
    for (const b of sortedGroup.slice(picks.length)) this.holdIn(b, site, new Set(), tag, walkNear);
  }

  private holdIn(bot: BotAgent, area: string, used: Set<unknown>, tag = "hold", walkNear = 0): void {
    let pool = (this.holds[area] ?? []).filter((h) => !used.has(h));
    if (!pool.length) pool = this.holds[area] ?? [];
    if (!pool.length) pool = Object.values(this.holds).flat();
    if (!pool.length) return;
    const h = this.rng.choice(pool);
    used.add(h);
    this.areaOf.set(bot.uid, area);
    bot.brain!.setTask(new Task("hold", { pos: [...h.pos] as V3, yaw: h.yaw, crouch: h.crouch, wait: true, tag, walkNear }));
  }

  /** Early information: a forward spot, then back to the site after a while. */
  private forward(b: BotAgent, now: number): void {
    let site = this.areaOf.get(b.uid);
    if (!site || !this.sites.has(site)) site = this.rng.choice([...this.sites.keys()].sort());
    const fw = this.tm.spots[site]?.forward ?? [];
    if (!fw.length) return;
    const f = this.rng.choice(fw.slice(0, 4));
    const hold = b.brain!.task;
    const t = this.holdTask({ i: f.i, sees: f.sees.slice(0, 3), crouch: false }, "forward");
    t.timeout = (this.liveT - now) + this.rng.uniform(12.0, 20.0);
    t.then = hold;
    b.brain!.setTask(t);
    this.say(b, `Playing forward ${this.tm.area(f.i)}.`, "fwd", 30.0);
  }

  private updateDefend(bots: BotAgent[], now: number): void {
    const d = this.director;
    const bomb = d.bomb;
    if (bomb.state === "planted") {
      if (!this.plantedHandled && bomb.site) this.attacked[bomb.site] = (this.attacked[bomb.site] ?? 0) + 1;
      this.retake(bots, now);
      return;
    }
    for (const name of this.sites.keys()) {
      const [n, util, died] = this.siteEvidence(name, now);
      const credible = n >= 2 || (n >= 1 && (util || died)) || (died && util);
      if (!credible || now - (this.rotated[name] ?? -100) < 15.0) continue;
      const cur = this.rotationSite;
      if (cur && cur !== name && now - this.rotationT < 30.0) {
        // already rotated the other way: only clearly stronger evidence turns them round
        if (n < this.siteEvidence(cur, now, 12.0)[0] + 2) continue;
      }
      this.rotated[name] = now;
      this.rotationSite = name;
      this.rotationT = now;
      this.attacked[name] = (this.attacked[name] ?? 0) + 1;
      const sc = this.siteCenters.get(name)!;
      const here = bots.filter((b) => this.areaOf.get(b.uid) === name);
      let movers = bots.filter((b) => this.areaOf.get(b.uid) !== name
        && !(this.roles.get(b) === "anchor" && this.sites.has(this.areaOf.get(b.uid) ?? "")));
      movers = movers.map((b, i) => ({ b, i, d: dist3(b.position(), sc) })).sort((a, b) => a.d - b.d || a.i - b.i).map((x) => x.b);
      if (movers.length > 2) movers = movers.slice(0, -1);     // someone stays to watch the other site
      if (movers.length) {
        // not one by one into a contested site: to the defenders' side of it, together
        for (const b of movers) {
          const p = this.regroupPoint(b, sc);
          this.areaOf.set(b.uid, name);
          b.brain!.setTask(new Task("hold", { pos: p, look: up(sc, 1.4), wait: true, tag: "rotate", walkNear: 8.0 }));
        }
        this.say(movers[0], `Rotating ${name}, wait for each other.`, `rot:${name}`, 10.0);
      }
      // a lone anchor against three or more falls back for the retake
      if (n >= 3 && here.length <= 1) {
        for (const b of here) {
          if (this.fellBack.has(b.uid)) continue;
          this.fellBack.add(b.uid);
          const p = this.regroupPoint(b, sc);
          b.brain!.setTask(new Task("hold", { pos: p, look: up(sc, 1.4), wait: true, tag: "fallback" }));
          this.say(b, `Too many ${name}, falling back.`, "fb", 10.0);
        }
      }
      break;
    }
    if (now >= this.shuffleT && now - this.lastContactT > 12.0) {
      this.shuffleT = now + this.rng.uniform(18.0, 30.0);
      const b = this.rng.choice(bots);
      const br = b.brain!;
      if (br.task.kind === "hold" && br.mode === "task" && br.task.tag === "hold") {
        const area = this.areaOf.get(b.uid) ?? "mid";
        if (this.sites.has(area)) {
          const used = new Set(bots.filter((m) => m !== b && m.brain!.task.pos).map((m) => this.tm.nearest(m.brain!.task.pos!)));
          this.holdSite([b], area, used);
        } else this.holdIn(b, area, new Set());
      }
    }
    const left = d.match.roundTimeLeft();
    if (left < 35.0 && now - this.lastContactT > 15.0 && bots.length > this.enemiesAlive) {
      const have = bots.filter((b) => b.brain!.task.tag === "hunt").length;
      const hunters = bots.filter((b) => b.brain!.task.tag !== "hunt").map((b, i) => ({ b, i }))
        .sort((x, y) => y.b.brain!.traits.aggression - x.b.brain!.traits.aggression || x.i - y.i).slice(0, Math.max(0, 1 - have)).map((x) => x.b);
      for (const b of hunters) b.brain!.setTask(new Task("hunt", { pos: this.likeliest(), tag: "hunt", walk: true }));
    }
  }

  private likeliest(): V3 {
    const dg = this.danger();
    let i = -1, best = 0;
    for (let k = 0; k < dg.length; k++) if (dg[k] > best) { best = dg[k]; i = k; }
    if (i < 0) i = this.rng.randrange(this.tm.n);
    const p = this.tm.pl[i];
    return [p[0], p[1], p[2]];
  }

  private retake(bots: BotAgent[], now: number): void {
    const before = this.retakePhase;
    this.retakeBase(bots, now);
    if (before === "gather" && this.retakePhase === "go" && !this.retakeUtil) {
      this.retakeUtil = true;
      const bomb = this.director.bomb;
      for (const b of bots) {
        if ((b.weapons.inv.grenades.flash ?? 0) > 0 && b.brain!.orderThrow("flash", up(bomb.pos, 2.5), 3.0)) {
          this.say(b, "Flash in, retake!", "rflash", 10.0);
          break;
        }
      }
      for (const b of bots) {
        if ((b.weapons.inv.grenades.smoke ?? 0) > 0) {
          const p = this.attackSidePoint(bomb.pos);
          if (p && b.brain!.orderThrow("smoke", p, 4.0)) break;
        }
      }
    }
  }

  private retakeBase(bots: BotAgent[], now: number): void {
    const d = this.director;
    const bomb = d.bomb;
    const left = d.match.bombTimeLeft();
    const t = d.rules.timers;
    const eta = (b: BotAgent) => dist3(b.position(), bomb.pos) / 5.0 + Number(b.hasKit ? t.defuse_time_kit : t.defuse_time);
    if (!this.plantedHandled) {
      // regroup out of sight of the site first, then retake together
      this.plantedHandled = true;
      this.retakePhase = "gather";
      this.gatherT = now;
      this.defuser = null;
      this.radio(bots[0], `Charge is down at ${bomb.site}. Group up for the retake!`);
      for (const b of bots) b.brain!.setTask(new Task("move", { pos: this.regroupPoint(b, bomb.pos), look: up(bomb.pos, 1.4), tag: "regroup", wait: true }));
    }
    if (this.retakePhase === "gather") {
      const ready = bots.filter((b) => b.brain!.task.tag === "regroup" && b.brain!.arrived);
      const pressed = left - Math.max(...bots.map(eta)) < 8.0;
      if (ready.length >= Math.min(2, bots.length) || pressed || now - this.gatherT > 10.0) {
        this.retakePhase = "go";
        this.radio(bots[0], "Go go go, retake!");
        for (const b of bots) b.brain!.setTask(new Task("move", { pos: this.snap(bomb.pos), tag: "retake", wait: true }));
      } else return;
    }
    // who defuses: kit holders and the closest go first
    if (this.defuser && (!this.defuser.alive || !bots.includes(this.defuser))) this.defuser = null;
    if (!this.defuser) {
      const cand = bots.reduce((a, b) => (eta(b) < eta(a) ? b : a));
      const need = eta(cand);
      if (need > left + 0.5) {
        if (this.retakePhase !== "save") {
          this.retakePhase = "save";
          this.radio(cand, "No time, save!");
          const spawn = this.spawnCenter.defend;
          if (spawn) for (const b of bots) b.brain!.setTask(new Task("hold", { pos: this.snap(spawn), tag: "save", wait: true }));
        }
        return;
      }
      const close = dist3(cand.position(), bomb.pos) < 14.0;
      const quiet = now - this.lastContactT > 2.0;
      if ((close && quiet) || need > left - 4.0) {
        this.defuser = cand;
        cand.brain!.setTask(new Task("defuse", { pos: [...bomb.pos] as V3, tag: "defuse" }));
        for (const b of bots) {
          if (b === cand) continue;
          const look = this.reports.length ? this.reports[this.reports.length - 1][2] : bomb.pos;
          b.brain!.setTask(new Task("guard", { pos: this.snap([bomb.pos[0] + this.rng.uniform(-5, 5), bomb.pos[1] + this.rng.uniform(-5, 5), bomb.pos[2]]),
            look: up(look, 1.4), wait: true, tag: "cover" }));
        }
      }
    }
  }

  private siteOfPoint(p: ArrayLike<number>): string {
    return [...this.sites].reduce((a, cur) => (zoneDist(cur[1], p) < zoneDist(a[1], p) ? cur : a))[0];
  }

  /** A point on the attackers' way back to the charge, to smoke it off. */
  private attackSidePoint(target: V3): V3 | null { return this.attPts.get(this.siteOfPoint(target)) ?? null; }

  /** Where defenders coming from their spawn enter the site (precomputed). */
  rotationPoint(site: string): V3 | null { return this.rotPts.get(site) ?? null; }

  /** A spot about 16 m short of the site on the bot's side, out of the fight (the retake gathers there). */
  private regroupPoint(bot: BotAgent, bombPos: V3): V3 {
    const p = bot.position();
    if (dist3(p, bombPos) < 18.0) return p;
    const dist = this.siteDist.get(this.siteOfPoint(bombPos));
    if (!dist) return p;
    const tm = this.tm;
    let best = -1, bd = Infinity;
    for (let i = 0; i < tm.n; i++) {
      if (!(dist[i] > 13.0 && dist[i] < 20.0)) continue;
      const v = Math.hypot(tm.xy[i * 2] - p[0], tm.xy[i * 2 + 1] - p[1]) + 0.5 * Math.abs(dist[i] - 16.0);
      if (v < bd) { bd = v; best = i; }
    }
    if (best < 0) return p;
    const q = tm.pl[best];
    return [q[0], q[1], q[2]];
  }

  // ---------------------------------------------------------------- misc
  /** Adaptation: remember where enemies showed early. */
  roundOver(): void {
    for (const [name, keys] of Object.entries(this.early)) this.siteSeen[name] = 0.6 * (this.siteSeen[name] ?? 0) + keys.size;
    for (let i = 0; i < this.learned.length; i++) this.learned[i] = this.learned[i] * 0.75 + this.learnedNow[i];
  }

  snap(p: ArrayLike<number>): V3 {
    const z = p.length > 2 ? p[2] : 0;
    const q = this.nav.snap([p[0], p[1], z], 10);
    return q ? [q[0], q[1], q[2]] : [p[0], p[1], z];
  }

  update(now: number): void {
    const d = this.director;
    const ph = d.match.phase;
    if (ph !== "live" && ph !== "planted") {
      if (ph === "round_end" && this.phase !== "over") {
        this.roundOver();
        this.phase = "over";
      }
      return;
    }
    const bots = this.aliveBots();
    if (!bots.length) return;
    if (this.side === "attack") this.updateAttack(bots, now);
    else this.updateDefend(bots, now);
  }
}

export type { Pt3 };
