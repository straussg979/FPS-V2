// ServerGame: one match's world - the level's collision, weapons and ballistics, destruction, gadgets, the
// charge, the director and its bots - advanced in a fixed 64 Hz tick:
//
//   players' commands (movement) -> world before physics (grenades, smoke) -> physics (grenades and
//   dropped weapons) -> players' weapons (shots tested as the shooter saw them) -> world after weapons
//   (match, bots, gadgets, destruction, pickups)
//
// Presentation calls go to a RecordingFx: the events the browsers draw.

import { type CollisionWorld, CollisionWorld as World, GROUP_CLIP, MASK_BULLETS, segmentCapsule } from "@cs/shared/collision";
import type { StepEvent } from "@cs/shared/character";
import type { CmdInput } from "@cs/shared/commands";
import type { Json } from "@cs/shared/data";
import type { DamageResult } from "@cs/shared/damage";
import { Level } from "@cs/shared/level/level";
import { type V3, hprMatrix } from "@cs/shared/math";
import { WeaponDatabase, weaponDb } from "@cs/shared/weapons";
import { NavLinks } from "../ai/navlinks";
import { NavMesh } from "../ai/navmesh";
import { TacticalMap } from "../ai/tactical_map";
import { Ballistics } from "./ballistics";
import { DestructionManager } from "./destruction";
import { MatchDirector } from "./director";
import { RecordingFx } from "./fx";
import type { Deployable } from "./gadgets";
import type { Grenade } from "./grenades";
import { HumanAgent } from "./human";
import { LagCompensation } from "./lagcomp";
import { PickupManager } from "./pickups";
import { SmokeField } from "./smoke";
import type { Soldier } from "./soldier";
import type { HitInterval, HitOwner } from "./types";

export const TICK_RATE = 64;

export interface FirstHit {
  pos: V3;
  normal: V3;
  fraction: number;
  owner: HitOwner | null;
  body: import("@cs/shared/collision").Body | null;
  deployable: Deployable | null;
  hitgroup: string;
  surface: string;
}

export interface NoiseEvent { t: number; pos: V3; loudness: number; radius: number; source: Soldier | null }

export interface Damageable3 extends HitOwner { centerOfMass(): V3 }

export interface MapCache {
  load(name: string): unknown;
  save(name: string, data: unknown): void;
}

export class ServerGame {
  world: CollisionWorld;
  level: Level;
  loop = { time: 0, tickCount: 0, dt: 1 / TICK_RATE };
  weaponDb: WeaponDatabase;
  ballistics: Ballistics;
  smoke = new SmokeField();
  fx = new RecordingFx();
  destruction: DestructionManager;
  pickups: PickupManager;
  lagcomp = new LagCompensation();
  lagCompensation = true;
  grenades: Grenade[] = [];
  noiseEvents: NoiseEvent[] = [];
  director: MatchDirector;
  log: (msg: string) => void;
  cache: MapCache | null;
  private nav: NavMesh | null = null;
  private tmap: TacticalMap | null = null;
  navLinks: NavLinks | null = null;
  private rewind: ((o: V3, e: V3, ignore: unknown) => HitInterval[]) | null = null;

  constructor(mapKey: string, mapData: Json, opts: { seed?: number | null; difficulty?: string | null; opponents?: number;
    teammates?: number; rules: Json; log?: (m: string) => void; cache?: MapCache | null }) {
    const t0 = Date.now();
    this.log = opts.log ?? ((m) => console.log(m));
    this.cache = opts.cache ?? null;
    this.level = new Level(mapKey, mapData, false);
    if (opts.rules.layout) this.level.applyMode(opts.rules.layout);
    this.world = new World(this.level.colliders.map((c) => ({ c: c.c, h: [c.size[0] / 2, c.size[1] / 2, c.size[2] / 2] as V3,
      hpr: c.hpr, surface: c.surface })));
    this.level.clips.forEach((c, i) => this.world.setDynamic(`clip:${i}`, GROUP_CLIP, "concrete",
      [{ c: c.center, h: [c.size[0] / 2, c.size[1] / 2, c.size[2] / 2], R: hprMatrix(c.hpr[0], c.hpr[1], c.hpr[2]) }]));
    this.weaponDb = weaponDb();
    this.ballistics = new Ballistics(this.weaponDb, {
      intervals: (o, e, ignore) => this.intervals(o, e, ignore),
      panelBulletHit: (panel, pos, dir, dmg, pellets) => this.destruction.bulletHit(panel, pos, dir, dmg, pellets),
    });
    this.destruction = new DestructionManager(this, this.level.panelSpecs, opts.seed ?? null);
    this.pickups = new PickupManager(this);
    this.spawnPickups();
    if (!this.level.supportsMatch()) throw new Error(`map ${mapKey} has no bomb sites and spawns for both teams`);
    this.navmesh();
    this.director = new MatchDirector(this, { side0: "attack", opponents: opts.opponents, teammates: opts.teammates, seed: opts.seed,
      difficulty: opts.difficulty, rules: opts.rules });
    this.log(`[server] ${this.level.name} ready in ${((Date.now() - t0) / 1000).toFixed(1)}s (${this.director.bots.length} bots)`);
  }

  // ------------------------------------------------------------ caches
  navmesh(): NavMesh {
    if (!this.nav) {
      const seeds = this.level.spawns.map((s) => s.pos);
      const allSeeds = [...seeds, ...(this.level.data.modes ? Object.values(this.level.data.modes as Json).flatMap((m: Json) =>
        (m.spawns ?? []).map((s: Json) => s.pos)) : [])];
      this.nav = NavMesh.cached(this.level.navColliders(), this.level.bounds, allSeeds, this.cache, this.level.mapKey, this.log);
      this.navLinks = new NavLinks(this.nav, this.destruction);
    }
    return this.nav;
  }

  tacticalMap(): TacticalMap {
    if (!this.tmap) {
      this.tmap = TacticalMap.cached(this.level, this.navmesh(), this.cache, this.log);
      this.destruction.listeners.push((p) => this.tmap!.onPanel(p));
    }
    return this.tmap;
  }

  // ------------------------------------------------------------ queries
  soldiers(): Soldier[] {
    return this.director ? (this.director.match.participants as Soldier[]) : [];
  }

  damageables(): Damageable3[] {
    const out: Damageable3[] = [];
    if (!this.director) return out;
    for (const b of this.director.bots) if (b.active) out.push(b);
    for (const h of this.director.humans) out.push(h);
    return out;
  }

  /** Hit boxes on a segment: the soldiers' capsules (now, or rewound for a lag-compensated shot) and the
   * gadgets' boxes. */
  hitboxIntervals(origin: V3, end: V3, ignore: unknown): HitInterval[] {
    const out: HitInterval[] = [];
    if (this.rewind) out.push(...this.rewind(origin, end, ignore));
    else {
      const dx = end[0] - origin[0], dy = end[1] - origin[1], dz = end[2] - origin[2];
      const dd = dx * dx + dy * dy + dz * dz;
      for (const s of this.soldiers()) {
        if (!s.hitEnabled || s === ignore) continue;
        const r = s.pose.rootPos;
        const rx = r[0] - origin[0], ry = r[1] - origin[1], rz = r[2] - origin[2];
        const t = dd > 0 ? Math.max(0, Math.min(1, (rx * dx + ry * dy + rz * dz) / dd)) : 0;
        const qx = rx - dx * t, qy = ry - dy * t, qz = rz - dz * t;
        if (qx * qx + qy * qy + qz * qz > 4.1 * 4.1) continue;
        for (const c of s.pose.capsules()) {
          const hit = segmentCapsule(origin, end, c.a, c.b, c.def.radius);
          if (!hit) continue;
          out.push({ tIn: hit.tIn, tOut: hit.posOut ? hit.tOut : 1, inPos: hit.posIn, inNormal: hit.nIn, outPos: hit.posOut,
            outNormal: hit.nOut, body: null, owner: s, hitgroup: c.def.hitgroup, surface: "flesh" });
        }
      }
    }
    const tac = this.director?.tactical;
    if (tac) {
      for (const d of [...tac.deployables, ...tac.drones, ...tac.cameras]) {
        if (d === ignore || !d.alive) continue;
        const iv = d.hitInterval(origin, end);
        if (iv) out.push(iv);
      }
    }
    return out;
  }

  /** Every solid on a bullet's path: world bodies with entry and exit, then the hit boxes. */
  intervals(origin: V3, end: V3, ignore: unknown): HitInterval[] {
    const out: HitInterval[] = this.world.rayIntervals(origin, end, MASK_BULLETS).map((iv) => ({
      tIn: iv.tIn, tOut: iv.tOut ?? 1, inPos: iv.inPos, inNormal: iv.inNormal, outPos: iv.outPos, outNormal: iv.outNormal,
      body: iv.body, owner: null, hitgroup: "", surface: iv.body.surface }));
    out.push(...this.hitboxIntervals(origin, end, ignore));
    return out;
  }

  /** Every first hit along a segment (world bodies and hit boxes), sorted. */
  rayAll(start: V3, end: V3, mask = MASK_BULLETS, ignore: unknown = null): FirstHit[] {
    const out: FirstHit[] = this.world.rayAll(start, end, mask).map((h) => ({ pos: h.pos, normal: h.normal, fraction: h.fraction,
      owner: null, body: h.body, deployable: (h.body.owner as Deployable | undefined) ?? null, hitgroup: "", surface: h.body.surface }));
    for (const iv of this.hitboxIntervals(start, end, ignore)) {
      out.push({ pos: iv.inPos, normal: iv.inNormal, fraction: iv.tIn, owner: iv.owner, body: null,
        deployable: iv.owner?.isGadget ? iv.owner as unknown as Deployable : null, hitgroup: iv.hitgroup, surface: iv.surface });
    }
    return out.sort((a, b) => a.fraction - b.fraction);
  }

  /** The first thing a segment hits that is not `ignore` (knife, hammer). */
  rayFirst(start: V3, end: V3, mask = MASK_BULLETS, ignore: unknown = null): FirstHit | null {
    return this.rayAll(start, end, mask, ignore)[0] ?? null;
  }

  // ------------------------------------------------------------ actions
  notifyNoise(pos: ArrayLike<number>, loudness: number, radius: number, source: unknown): void {
    const src = this.director?.agentOf(source) ?? null;
    this.noiseEvents.push({ t: this.loop.time, pos: [pos[0], pos[1], pos[2]], loudness, radius, source: src });
    if (this.noiseEvents.length > 96) this.noiseEvents.splice(0, this.noiseEvents.length - 96);
  }

  spawnGrenade(g: Grenade): void { this.grenades.push(g); }

  /** Round restart: grenades, smoke and dropped weapons go away, walls come back. */
  clearWorld(): void {
    for (const g of this.grenades) g.destroy();
    this.grenades = [];
    this.smoke.clear();
    this.pickups.clearDropped();
    this.destruction.reset();
  }

  spawnPickups(): void {
    for (const [kind, e] of this.level.props) {
      if (kind !== "pickup") continue;
      const item: string = e.item;
      let k: string, label: string;
      if (this.weaponDb.weapons[item]) { k = "weapon"; label = this.weaponDb.weapons[item].name; }
      else if (this.weaponDb.grenades[item]) { k = "grenade"; label = this.weaponDb.grenades[item].name; }
      else { k = item; label = ({ ammo: "ammo", armor: "armour + helmet", grenades: "grenades" } as Record<string, string>)[item] ?? item; }
      this.pickups.spawn(k, item, e.pos, e.heading ?? 0, null, e.static ?? true, Number(e.respawn ?? 3), e.label ?? label);
    }
  }

  // ------------------------------------------------------------ players
  addPlayer(name: string, teamIndex: number, seed: number): HumanAgent {
    const agent = new HumanAgent(this, name, seed);
    return this.director.addHuman(agent, teamIndex);
  }

  removePlayer(agent: HumanAgent): void { this.director.removeHuman(agent); }

  /** A player's footstep or landing: heard by everyone near (and by the bots). */
  playerStep(agent: HumanAgent, ev: StepEvent): void {
    if (ev.kind === "land") this.fx.ui("land", 0.4 * ev.loudness + 0.1, agent);
    else this.fx.footstep(ev.surface, ev.pos, ev.loudness, agent);
    if (ev.loudness > 0) this.notifyNoise(ev.pos, ev.loudness, 28 * ev.loudness, agent);
  }

  /** Where a player was hurt from (its HUD's damage arcs): the attacker, or the blast. */
  playerDamaged(agent: HumanAgent, res: DamageResult): void {
    const info = res.info;
    let source: V3 | null = null;
    const attacker = this.director.agentOf(info.attacker);
    if (info.kind !== "explosion" && attacker && attacker !== agent) source = attacker.position();
    else if (info.kind !== "fall") {
      const d = info.direction;
      const l = Math.hypot(d[0], d[1], d[2]);
      if (l > 1e-6) {
        const p = agent.motor.char.pos;
        source = [p[0] - d[0] / l * 5, p[1] - d[1] / l * 5, p[2] - d[2] / l * 5];
      }
    }
    if (source) this.fx.damageFrom(agent, source, res.health + res.armor);
  }

  // --------------------------------------------------------------- tick
  fixedUpdate(dt: number): void {
    const now = this.loop.time;
    const players = this.director.humans;
    const taken: CmdInput[][] = [];
    for (const h of players) {
      const cmds = h.takeInputs();
      if (cmds.length) {
        h.apply(cmds[0]);
        h.motor.fixedUpdate(dt, cmds[0]);
      }
      taken.push(cmds);
    }
    // world before physics: grenades, smoke
    for (const g of this.grenades) g.fixedUpdate(dt);
    this.grenades = this.grenades.filter((g) => !g.done);
    this.smoke.fixedUpdate(dt);
    // physics
    for (const g of this.grenades) g.physics(dt);
    // the players' weapons
    players.forEach((h, i) => {
      const cmds = taken[i];
      if (!cmds.length) return;
      h.apply(cmds[0]);
      this.weapons(h, cmds[0], dt, now);
      for (const extra of cmds.slice(1)) {
        h.apply(extra);
        h.motor.fixedUpdate(dt, extra);
        this.weapons(h, extra, dt, now);
      }
    });
    // world after weapons
    this.director.fixedUpdate(dt);
    this.destruction.flush();
    this.pickups.fixedUpdate(dt);
  }

  private weapons(h: HumanAgent, inp: CmdInput, dt: number, now: number): void {
    if (this.lagCompensation) {
      const at = this.lagcomp.viewTick(inp.cmd.viewTick, inp.cmd.viewFrac, this.loop.tickCount, dt);
      this.rewind = this.lagcomp.rewinder(at);
    }
    try {
      h.weapons.fixedUpdate(dt, now, inp);
    } finally {
      this.rewind = null;
    }
  }

  step(): void {
    const loop = this.loop;
    this.fixedUpdate(loop.dt);
    loop.tickCount++;
    loop.time += loop.dt;
    this.lagcomp.record(loop.tickCount, this.soldiers());
  }
}
