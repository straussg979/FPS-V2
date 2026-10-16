// The Siege layer of a match, owned by the director. Per round every participant gets a kit from its
// specialist (data/specialists.json): one unique gadget plus the common equipment (drones and wall charges
// for attackers, reinforcements for defenders). This module owns everything placed in the world during a
// round (gadgets, drones, the map cameras), the team pings, and the players' controls:
//
//   X          specialist gadget (place / throw / swing / scan)
//   V          wall charge (attackers)
//   6          drones (attackers) or cameras (defenders); in a view: mouse looks, WASD drives a drone,
//              left mouse pings, Q/E switch, 6 leaves
//   F (hold)   reinforce the wall you look at (defenders, 2 per round)
//   middle     ping what you look at for your team
//
// Bots use the same entry points (deploy, reinforce, throwDrone, pulse...) through the gadget AI.

import type { KinematicCharacter } from "@cs/shared/character";
import { MASK_BULLETS, MASK_SIGHT } from "@cs/shared/collision";
import { damageInfo } from "@cs/shared/damage";
import type { Json } from "@cs/shared/data";
import { SPECIALISTS } from "@cs/shared/data";
import type { Panel } from "@cs/shared/destruction";
import type { V3 } from "@cs/shared/math";
import { throwVelocity } from "@cs/shared/weapons";
import type { MatchDirector } from "./director";
import type { ServerGame } from "./game";
import { Breacher, type Deployable, DeployShield, MotionSensor, RazorWire, SignalJammer, ThermalLance, WallCharge,
  empGrenadeDef, sideOf } from "./gadgets";
import { Grenade } from "./grenades";
import type { HumanAgent } from "./human";
import { Drone, MapCamera, viewDir } from "./observation";
import type { Soldier } from "./soldier";

const SIDES = ["attack", "defend"];

export class Kit {
  specialist = "recruit";
  gadget = "";
  gadgetLeft = 0;
  charges = 0;
  boughtCharges = 0;
  drones = 0;
  reinforcements = 0;
  readyT = 0;               // gadget cooldown (pulse, hammer)
  swingT: number | null = null;
  pulseUntil = 0;
}

class HumanTac {
  view: Drone | MapCamera | null = null;
  viewLostT = 0;
  action: { kind: string; t: number; total: number; panel: Panel } | null = null;
  lastAngles: [number, number] | null = null;
}

export class Ping {
  side: string; pos: V3; kind: string; until: number; agent: Soldier | null; by: unknown; born: number;
  constructor(side: string, pos: V3, kind: string, until: number, agent: Soldier | null, by: unknown, born: number) {
    this.side = side; this.pos = pos; this.kind = kind; this.until = until; this.agent = agent; this.by = by; this.born = born;
  }
  where(): V3 {
    const a = this.agent;
    if (a && a.alive) { const p = a.position(); return [p[0], p[1], p[2] + 1]; }
    return this.pos;
  }
}

export class Tactical {
  game: ServerGame;
  director: MatchDirector;
  cfg: Json = SPECIALISTS;
  gcfg: Json = SPECIALISTS.gadgets;
  choices = new Map<Soldier, string>();
  private htac = new Map<Soldier, HumanTac>();
  kits = new Map<Soldier, Kit>();
  deployables: Deployable[] = [];
  drones: Drone[] = [];
  cameras: MapCamera[] = [];
  pings: Ping[] = [];
  private slowMap = new Map<Soldier, number>();
  verbose = false;
  stats: Record<string, number> = {};

  constructor(game: ServerGame, director: MatchDirector) {
    this.game = game;
    this.director = director;
  }

  get now(): number { return this.game.loop.time; }

  log(key: string, text: string): void {
    this.stats[key] = (this.stats[key] ?? 0) + 1;
    if (this.verbose) this.game.log(`[tac] t=${this.now.toFixed(1)} ${text}`);
  }

  // -------------------------------------------------------- specialists
  specialist(key: string): Json {
    for (const s of SIDES) for (const sp of this.cfg[s]) if (sp.key === key) return sp;
    return this.cfg.recruit;
  }

  kit(agent: Soldier): Kit {
    let k = this.kits.get(agent);
    if (!k) this.kits.set(agent, (k = new Kit()));
    return k;
  }

  /** A player picks a specialist: at once during freeze/prep if the old gadget is untouched, else next round. */
  choose(agent: Soldier, key: string): boolean {
    const side = agent.side;
    if (!SIDES.includes(side) || ![...this.cfg[side].map((s: Json) => s.key), "recruit"].includes(key)) return false;
    this.choices.set(agent, key);
    const m = this.director.match;
    const kit = this.kit(agent);
    const old = this.specialist(kit.specialist);
    const unused = kit.gadgetLeft === Number(this.gcfg[old.gadget ?? ""]?.count ?? 0);
    if ((m.phase === "freeze" || m.phase === "prep") && unused) {
      const before = new Map(m.participants.filter((a) => a.side === side).map((a) => [a, this.kit(a as Soldier).specialist]));
      this.assign(side);
      for (const a of m.participants as Soldier[]) {
        if (a.side === side && (a === agent || this.kit(a).specialist !== before.get(a))) this.fillKit(a);
      }
    }
    return true;
  }

  private assign(side: string): void {
    const d = this.director;
    const members = d.match.participants.filter((a) => a.side === side) as Soldier[];
    const keys: string[] = this.cfg[side].map((s: Json) => s.key);
    const taken = new Set<string>();
    const humans = d.humans.filter((h) => members.includes(h));
    for (const h of humans) {
      let hk = this.choices.get(h) ?? keys[0];
      if (taken.has(hk) && hk !== "recruit") hk = keys.find((k) => !taken.has(k)) ?? "recruit";
      this.kit(h).specialist = hk;
      taken.add(hk);
    }
    const bots = members.filter((a) => !humans.includes(a as HumanAgent)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const free = keys.filter((k) => !taken.has(k));
    bots.forEach((b, i) => { this.kit(b).specialist = i < free.length ? free[i] : "recruit"; });
  }

  fillKit(agent: Soldier): void {
    const kit = this.kit(agent);
    const sp = this.specialist(kit.specialist);
    kit.gadget = sp.gadget ?? "";
    kit.gadgetLeft = kit.gadget ? Number(this.gcfg[kit.gadget]?.count ?? 0) : 0;
    const common = this.cfg.common[agent.side] ?? {};
    const recruit = kit.specialist === "recruit";
    kit.charges = kit.boughtCharges = 0;
    kit.drones = kit.reinforcements = 0;
    if (agent.side === "attack") {
      kit.charges = Number(common.free_wall_charges ?? 1) + (recruit ? Number(common.recruit_bonus_charges ?? 1) : 0);
      kit.drones = this.modeRules.drones ?? true ? Number(common.drones ?? 2) : 0;
    } else {
      kit.reinforcements = Number(common.reinforcements ?? 2) + (recruit ? Number(common.recruit_bonus_reinforcements ?? 1) : 0);
    }
    kit.readyT = 0;
    kit.swingT = null;
  }

  canBuyCharge(agent: Soldier): [boolean, string] {
    if (agent.side !== "attack") return [false, "not available to your team"];
    if (this.kit(agent).boughtCharges >= Number(this.gcfg.wall_charge.max ?? 2)) return [false, "carrying the maximum"];
    return [true, ""];
  }

  buyCharge(agent: Soldier): void {
    const kit = this.kit(agent);
    kit.charges++;
    kit.boughtCharges++;
  }

  // -------------------------------------------------------------- round
  roundReset(): void {
    this.exitAllViews();
    for (const d of [...this.deployables, ...this.drones, ...this.cameras]) d.destroy(false);
    this.deployables = [];
    this.drones = [];
    this.cameras = [];
    this.pings = [];
    for (const st of this.htac.values()) st.action = null;
    this.slowMap.clear();
    if (this.modeRules.cameras ?? true) this.game.level.cameras.forEach((spec, i) => this.cameras.push(new MapCamera(this, spec, i)));
    for (const side of SIDES) this.assign(side);
    for (const a of this.director.match.participants as Soldier[]) if (SIDES.includes(a.side)) this.fillKit(a);
  }

  clear(): void {
    this.exitAllViews();
    for (const d of [...this.deployables, ...this.drones, ...this.cameras]) d.destroy(false);
    this.deployables = [];
    this.drones = [];
    this.cameras = [];
    this.pings = [];
  }

  // ------------------------------------------------------------ queries
  get modeRules(): Json { return this.director.rules.tactical ?? {}; }

  characters(): Array<[Soldier, KinematicCharacter]> {
    const d = this.director;
    const out: Array<[Soldier, KinematicCharacter]> = [];
    for (const h of d.humans) if (h.alive) out.push([h, h.motor.char]);
    for (const b of d.bots) if (b.active && b.alive) out.push([b, b.char]);
    return out;
  }

  slow(agent: Soldier, factor: number): void {
    this.slowMap.set(agent, Math.min(this.slowMap.get(agent) ?? 1, factor));
  }

  enemiesOf(side: string): Soldier[] {
    return (this.director.match.participants as Soldier[]).filter((a) => SIDES.includes(a.side) && a.side !== side && a.alive &&
      a.active);
  }

  jammed(pos: ArrayLike<number>, side: string): boolean {
    for (const d of this.deployables) {
      if (d instanceof SignalJammer && d.side !== side && d.active &&
          Math.hypot(d.pos[0] - pos[0], d.pos[1] - pos[1], d.pos[2] - pos[2]) <= d.radius) return true;
    }
    return false;
  }

  views(side: string): Array<Drone | MapCamera> {
    if (side === "attack") return this.drones.filter((d) => d.alive && d.side === side);
    return this.cameras.filter((c) => c.alive);
  }

  teamPings(side: string): Ping[] { return this.pings.filter((p) => p.side === side); }

  // -------------------------------------------------------------- pings
  ping(side: string, pos: ArrayLike<number>, kind: string, duration: number, agent: Soldier | null = null, by: unknown = null): void {
    const now = this.now;
    const p3: V3 = [pos[0], pos[1], pos[2]];
    for (const p of this.pings) {
      if (p.side === side && agent && p.agent === agent) {
        p.until = Math.max(p.until, now + duration);
        p.pos = p3;
        if (kind !== "mark") p.kind = kind;
        return;
      }
    }
    this.pings.push(new Ping(side, p3, kind, now + duration, agent, by, now));
    if (agent) this.director.brainOf(side)?.intel(agent, p3, now);
  }

  /** Ping along a view ray: an enemy (or their gadget) if one is hit, else the spot. */
  spotFrom(side: string, eye: V3, direction: V3, by: unknown = null, maxRange = 60): boolean {
    const end: V3 = [eye[0] + direction[0] * maxRange, eye[1] + direction[1] * maxRange, eye[2] + direction[2] * maxRange];
    const hits = this.game.rayAll(eye, end, MASK_BULLETS);
    for (const h of hits) {
      const owner = h.owner;
      if (owner && owner !== by) {
        const gadget = !!owner.isGadget;
        const agent = gadget ? null : (owner as unknown as Soldier);
        if (agent && agent.side !== side && agent.alive) {
          this.ping(side, agent.position(), "spot", Number(this.gcfg.ping.time ?? 4), agent, by);
          return true;
        }
        if (gadget && sideOf(owner) !== side) {
          this.ping(side, (owner as unknown as Deployable).center(), "gadget", Number(this.gcfg.ping.time ?? 4), null, by);
          return true;
        }
        continue;
      }
      if (!owner) {
        this.ping(side, h.pos, "mark", 3, null, by);
        return false;
      }
    }
    return false;
  }

  // ------------------------------------------------------- world events
  onExplosion(pos: ArrayLike<number>, radius: number, source: unknown = null): void {
    for (const d of [...this.deployables, ...this.drones]) {
      if (d === source || !d.alive) continue;
      const r = radius + (d.blocksExplosions || 0.4);
      const c = d.center();
      if (Math.hypot(c[0] - pos[0], c[1] - pos[1], c[2] - pos[2]) <= r) d.destroy();
    }
  }

  emp(pos: ArrayLike<number>, radius: number, duration: number, side: string): number {
    let n = 0;
    const until = this.now + duration;
    for (const d of [...this.deployables, ...this.drones, ...this.cameras]) {
      const c = d.center();
      if (d.alive && d.side !== side && d.electronic && Math.hypot(c[0] - pos[0], c[1] - pos[1], c[2] - pos[2]) <= radius) {
        d.emp(until);
        n++;
      }
    }
    this.log("emp", `EMP disabled ${n} device(s)`);
    return n;
  }

  pulse(agent: Soldier): number {
    const cfg = this.gcfg.pulse_scanner;
    const r = Number(cfg.radius ?? 15);
    const pos = agent.position();
    let n = 0;
    for (const e of this.enemiesOf(agent.side)) {
      const ep = e.position();
      if (Math.hypot(ep[0] - pos[0], ep[1] - pos[1], ep[2] - pos[2]) <= r) {
        this.ping(agent.side, ep, "pulse", Number(cfg.reveal_time ?? 3.5), e, agent);
        n++;
      }
    }
    this.game.fx.playAt("pulse", [pos[0], pos[1], pos[2] + 1.2], 0.8);
    this.kit(agent).pulseUntil = this.now + 0.6;
    this.log("pulse", `${agent.name} pulsed: ${n} contact(s)`);
    return n;
  }

  // ---------------------------------------------------------- placing
  aimRay(eye: V3, direction: V3, maxRange: number) {
    return this.game.world.ray(eye, [eye[0] + direction[0] * maxRange, eye[1] + direction[1] * maxRange, eye[2] + direction[2] * maxRange],
      MASK_SIGHT);
  }

  breachSpot(eye: V3, direction: V3, kind: string): [Panel, V3, V3] | string {
    const cfg = this.gcfg[kind];
    const hit = this.aimRay(eye, direction, Number(cfg.place_range ?? 1.6));
    if (!hit) return "move closer to a wall";
    if (hit.body.panel === undefined) return "only destructible walls and hatches";
    const panel = this.game.destruction.panels[hit.body.panel];
    if (panel.reinforced && kind !== "thermal_lance") return "the wall is reinforced - use a thermal lance";
    let n: V3 = [...hit.normal] as V3;
    const pos: V3 = [...hit.pos] as V3;
    if (panel.spec.kind !== "floor") {
      const [a, b] = panel.ax;
      const vert = Math.abs(panel.R[b][2]) > 0.9 ? b : a;
      const bottom = panel.center[2] - panel.size[vert] / 2;
      pos[2] = bottom + Math.min(1.0, panel.size[vert] / 2);
      n = [n[0], n[1], 0];
      const l = Math.hypot(n[0], n[1]) || 1;
      n = [n[0] / l, n[1] / l, 0];
    }
    for (const d of this.deployables) {
      if (d instanceof Breacher && d.alive && Math.hypot(d.pos[0] - pos[0], d.pos[1] - pos[1], d.pos[2] - pos[2]) < 0.9) {
        return "already a charge there";
      }
    }
    return [panel, [pos[0] + n[0] * 0.012, pos[1] + n[1] * 0.012, pos[2] + n[2] * 0.012], n];
  }

  floorSpot(eye: V3, yaw: number, pitch: number, maxRange: number): V3 | null {
    const hit = this.aimRay(eye, viewDir(yaw, pitch), maxRange);
    if (hit && hit.normal[2] > 0.7) return [...hit.pos] as V3;
    const flat = viewDir(yaw, 0);
    const reach = hit ? Math.min(maxRange, Math.max(Math.hypot(hit.pos[0] - eye[0], hit.pos[1] - eye[1], hit.pos[2] - eye[2]) - 0.4, 0.4))
      : maxRange;
    const p: V3 = [eye[0] + flat[0] * reach, eye[1] + flat[1] * reach, eye[2] + flat[2] * reach];
    const down = this.game.world.ray(p, [p[0], p[1], p[2] - 2.6], MASK_SIGHT);
    if (!down || down.normal[2] < 0.7) return null;
    return [...down.pos] as V3;
  }

  /** Place a gadget the way a player would (aim from eye). Players and bots alike. */
  deploy(agent: Soldier, kind: string, eye: V3, yaw: number, pitch: number): [boolean, string] {
    const kit = this.kit(agent);
    const side = agent.side;
    if (kind === "wall_charge") {
      if (kit.charges <= 0) return [false, "no wall charges"];
    } else if (kit.gadget !== kind || kit.gadgetLeft <= 0) return [false, "nothing left"];
    const cfg = this.gcfg[kind];
    const direction = viewDir(yaw, pitch);
    let obj: Deployable;
    if (kind === "wall_charge" || kind === "thermal_lance") {
      const spot = this.breachSpot(eye, direction, kind);
      if (typeof spot === "string") return [false, spot];
      const [panel, pos, n] = spot;
      obj = kind === "wall_charge" ? new WallCharge(this, agent, side, panel, pos, n) : new ThermalLance(this, agent, side, panel, pos, n);
      this.game.fx.playAt("charge_place", pos, 0.7);
    } else if (kind === "motion_sensor") {
      const hit = this.aimRay(eye, direction, Number(cfg.place_range ?? 2.2));
      if (!hit) return [false, "aim at a wall or the floor"];
      obj = new MotionSensor(this, agent, side,
        [hit.pos[0] + hit.normal[0] * 0.005, hit.pos[1] + hit.normal[1] * 0.005, hit.pos[2] + hit.normal[2] * 0.005], hit.normal);
      this.game.fx.playAt("charge_place", hit.pos, 0.5);
    } else if (kind === "razor_wire" || kind === "deploy_shield" || kind === "signal_jammer") {
      const pos = this.floorSpot(eye, yaw, pitch, Number(cfg.place_range ?? 1.6));
      if (!pos) return [false, "no floor there"];
      obj = kind === "razor_wire" ? new RazorWire(this, agent, side, pos, yaw)
        : kind === "deploy_shield" ? new DeployShield(this, agent, side, pos, yaw) : new SignalJammer(this, agent, side, pos, yaw);
      this.game.fx.playAt(kind === "deploy_shield" ? "shield_deploy" : "wire_place", pos, 0.7);
    } else return [false, "not a placeable gadget"];
    this.deployables.push(obj);
    if (kind === "wall_charge") kit.charges--;
    else kit.gadgetLeft--;
    this.log(kind, `${agent.name} placed ${(cfg.name ?? kind).toLowerCase()} at (${obj.pos.map((v) => v.toFixed(1)).join(", ")})`);
    return [true, cfg.name ?? kind];
  }

  /** The specialist key (X): place, throw, swing or scan. */
  useGadget(agent: Soldier, eye: V3, yaw: number, pitch: number, inherit: V3 = [0, 0, 0]): [boolean, string] {
    const kit = this.kit(agent);
    const g = kit.gadget;
    if (!g) return [false, "recruits have no gadget"];
    if (kit.gadgetLeft <= 0) return [false, `no ${(this.gcfg[g].name ?? g).toLowerCase()} left`];
    const now = this.now;
    if (now < kit.readyT) return [false, ""];
    const cfg = this.gcfg[g];
    if (["wall_charge", "thermal_lance", "razor_wire", "motion_sensor", "deploy_shield", "signal_jammer"].includes(g)) {
      return this.deploy(agent, g, eye, yaw, pitch);
    }
    if (g === "pulse_scanner") {
      const n = this.pulse(agent);
      kit.gadgetLeft--;
      kit.readyT = now + Number(cfg.cooldown ?? 8);
      return [true, `pulse: ${n} contact${n !== 1 ? "s" : ""}`];
    }
    if (g === "breach_hammer") {
      kit.readyT = now + Number(cfg.cooldown ?? 1.1);
      kit.swingT = now + Number(cfg.swing_time ?? 0.45);
      this.game.fx.playAt("knife_swing", eye, 0.6);
      agent.anim("knife");
      return [true, ""];
    }
    if (g === "emp_grenade") {
      const gd = empGrenadeDef();
      const vel = throwVelocity(yaw, pitch, gd.throwSpeed, inherit);
      const fwd = viewDir(yaw, 0);
      const start: V3 = [eye[0] + fwd[0] * 0.3, eye[1] + fwd[1] * 0.3, eye[2] - 0.1];
      this.game.spawnGrenade(new Grenade(this.game, gd, start, vel, agent));
      this.game.fx.playAt("throw", start, 0.5);
      agent.anim("throw");
      kit.gadgetLeft--;
      kit.readyT = now + 0.8;
      return [true, ""];
    }
    return [false, ""];
  }

  hammerHit(agent: Soldier, eye: V3, yaw: number, pitch: number): void {
    const cfg = this.gcfg.breach_hammer;
    const d = viewDir(yaw, pitch);
    const rng = Number(cfg.range ?? 2.0);
    const hit = this.game.rayFirst(eye, [eye[0] + d[0] * rng, eye[1] + d[1] * rng, eye[2] + d[2] * rng], MASK_BULLETS, agent);
    if (!hit) {
      const probe: V3 = [eye[0] + d[0] * 1.5, eye[1] + d[1] * 1.5, eye[2] + d[2] * 1.5 - 1.4];
      for (const dep of this.deployables) if (dep instanceof RazorWire && dep.alive && dep.contains(probe)) dep.hammer();
      return;
    }
    const g = this.game;
    const owner = hit.owner;
    const dep = hit.deployable ?? (owner?.isGadget ? owner as unknown as Deployable : null);
    if (dep) dep.destroy();
    else if (hit.body?.panel !== undefined) {
      const panel = g.destruction.panels[hit.body.panel];
      if (panel.reinforced) {
        g.fx.sparks(hit.pos, 8);
        g.fx.playAt("impact_metal", hit.pos, 0.9);
        return;
      }
      g.destruction.damagePanel(panel, hit.pos, Number(cfg.radius ?? 0.42), Number(cfg.damage ?? 400), "melee", d);
    } else if (owner && owner !== agent) {
      const res = owner.damageable.takeDamage(damageInfo({ amount: Number(cfg.player_damage ?? 80), armorPenetration: 0.85,
        hitgroup: hit.hitgroup || "chest", kind: "melee", attacker: agent, weapon: "breach_hammer", pos: hit.pos, direction: d }));
      if (res) owner.onHit?.(res, hit.pos, d);
    }
    for (const w of this.deployables) if (w instanceof RazorWire && w.alive && w.contains(hit.pos)) w.hammer();
    g.fx.playAt("hammer_hit", hit.pos, 1);
    g.fx.impact(hit.pos, hit.normal, "concrete");
    g.notifyNoise(hit.pos, 1, 35, agent);
  }

  // ---------------------------------------------------------- reinforce
  reinforceTarget(eye: V3, direction: V3): Panel | null {
    const reach = Number(this.gcfg.reinforce.range ?? 1.8);
    const hit = this.aimRay(eye, direction, reach + 1.4);
    if (!hit || hit.body.panel === undefined) return null;
    const panel = this.game.destruction.panels[hit.body.panel];
    if (!panel.spec.reinforceable) return null;
    if (panel.spec.kind !== "floor" && Math.hypot(hit.pos[0] - eye[0], hit.pos[1] - eye[1], hit.pos[2] - eye[2]) > reach) return null;
    return panel;
  }

  finishReinforce(agent: Soldier, panel: Panel): boolean {
    const kit = this.kit(agent);
    if (kit.reinforcements <= 0 || !panel.canReinforce()) return false;
    panel.reinforce();
    kit.reinforcements--;
    this.log("reinforce", `${agent.name} reinforced ${panel.spec.name || panel.index}`);
    this.game.fx.playAt("reinforce", panel.center, 0.9);
    return true;
  }

  // ------------------------------------------------------------- drones
  throwDrone(agent: Soldier, pos: V3, yaw: number): Drone | null {
    const kit = this.kit(agent);
    if (kit.drones <= 0) return null;
    kit.drones--;
    const fwd = viewDir(yaw, 0);
    const vel: V3 = [fwd[0] * 3.5, fwd[1] * 3.5, 2.2];
    const n = this.drones.filter((d) => d.owner === agent).length + 1;
    const drone = new Drone(this, agent, agent.side, [pos[0] + fwd[0] * 0.45, pos[1] + fwd[1] * 0.45, pos[2] + 0.6], yaw, vel,
      `${agent.name} drone ${n}`);
    this.drones.push(drone);
    this.game.fx.playAt("throw", [pos[0], pos[1], pos[2] + 1], 0.5);
    this.log("drone", `${agent.name} threw a drone`);
    return drone;
  }

  // ------------------------------------------------------ players' views
  state(agent: Soldier): HumanTac {
    let st = this.htac.get(agent);
    if (!st) this.htac.set(agent, (st = new HumanTac()));
    return st;
  }

  observingFor(agent: Soldier | null): boolean {
    const st = agent ? this.htac.get(agent) : undefined;
    return !!st && st.view !== null;
  }

  viewOf(agent: Soldier): Drone | MapCamera | null { return this.htac.get(agent)?.view ?? null; }

  tell(agent: Soldier, text: string): void {
    if (text) this.game.fx.message(agent, text);
  }

  enterView(view: Drone | MapCamera, agent: HumanAgent): void {
    const st = this.state(agent);
    if (st.view && st.view !== view && st.view instanceof Drone) {
      st.view.controller = null;
      st.view.drive([0, 0, 0]);
    }
    st.view = view;
    st.lastAngles = [agent.motor.yaw, agent.motor.pitch];
    if (view instanceof Drone) view.controller = "human";
    agent.input.clearPresses();
    agent.motor.externalView = true;
    this.game.fx.ui("camera_switch", 0.5, agent);
  }

  exitView(agent: HumanAgent): void {
    const st = this.htac.get(agent);
    if (!st || !st.view) return;
    if (st.view instanceof Drone) {
      st.view.controller = null;
      st.view.drive([0, 0, 0]);
    }
    st.view = null;
    agent.motor.externalView = false;
    agent.input.clearPresses();
  }

  private exitAllViews(): void {
    for (const h of this.director.allHumans()) this.exitView(h);
  }

  cycleView(step: number, agent: HumanAgent): void {
    const st = this.state(agent);
    const views = this.views(agent.side);
    if (!views.length) { this.exitView(agent); return; }
    const i = st.view ? views.indexOf(st.view) : -1;
    this.enterView(views[(((i + step) % views.length) + views.length) % views.length], agent);
  }

  private turn(v: Drone | MapCamera, dx: number, dy: number): void {
    if (v instanceof MapCamera) v.look(-dx, -dy);
    else {
      v.yaw = (((v.yaw - dx) % 360) + 360) % 360;
      v.pitch = Math.max(-70, Math.min(70, v.pitch - dy));
    }
  }

  private toggleView(h: HumanAgent): void {
    const st = this.state(h);
    if (st.view) { this.exitView(h); return; }
    if (h.side === "attack") {
      const own = this.drones.filter((x) => x.alive && x.owner === h);
      if (!own.length && this.kit(h).drones > 0) {
        const drone = this.throwDrone(h, h.motor.char.pos, h.motor.yaw);
        if (drone) { this.enterView(drone, h); return; }
      }
      const views = own.length ? own : this.views("attack");
      if (!views.length) { this.tell(h, "no drones left"); return; }
      this.enterView(views[views.length - 1], h);
    } else {
      const views = this.views("defend");
      if (!views.length) { this.tell(h, "every camera is destroyed"); return; }
      this.enterView(views[0], h);
    }
  }

  private driveView(h: HumanAgent): void {
    const inp = h.input;
    const st = this.state(h);
    // the player turns the view with its view angles (the mouse, on its screen)
    const yaw = inp.cmd.yaw, pitch = inp.cmd.pitch;
    if (st.lastAngles && st.view) {
      const dyaw = ((((yaw - st.lastAngles[0] + 180) % 360) + 360) % 360) - 180;
      this.turn(st.view, -dyaw, -(pitch - st.lastAngles[1]));
    }
    st.lastAngles = [yaw, pitch];
    if (inp.consume("observe")) { this.exitView(h); return; }
    if (inp.consume("lean_right") || inp.consume("wheel_down")) this.cycleView(1, h);
    else if (inp.consume("lean_left") || inp.consume("wheel_up")) this.cycleView(-1, h);
    const v = st.view;
    if (!v) return;
    if (inp.consume("fire") && !v.jammed) {
      this.spotFrom(h.side, v.eye(), viewDir(v.yaw, v.pitch), v);
      this.game.fx.ui("ping", 0.4, h);
    }
    if (v instanceof Drone && v.controller === "human") {
      const [f, s] = inp.axes();
      const hd = v.yaw * Math.PI / 180;
      let wish: V3 = [-Math.sin(hd) * f + Math.cos(hd) * s, Math.cos(hd) * f + Math.sin(hd) * s, 0];
      const l = Math.hypot(wish[0], wish[1]);
      if (l * l > 1e-6) wish = [wish[0] / l, wish[1] / l, 0];
      v.drive(wish, inp.consume("jump"));
    }
  }

  private updateHuman(h: HumanAgent, dt: number): void {
    const d = this.director;
    const g = this.game;
    const inp = h.input;
    const m = d.match;
    const st = this.state(h);
    if (!SIDES.includes(h.side)) return;
    if (!h.alive || ["round_end", "halftime", "match_end", "waiting"].includes(m.phase)) {
      this.exitView(h);
      st.action = null;
      return;
    }
    if (st.view) {
      if (!st.view.alive) {
        st.viewLostT = 1;
        this.exitView(h);
      } else {
        this.driveView(h);
        return;
      }
    }
    if (inp.consume("observe")) { this.toggleView(h); return; }
    if (m.phase === "prep" && !h.hint) {
      h.hint = h.side === "attack" ? "Preparation: scout with a drone [6]" : "Preparation: reinforce walls [F], set up your gadget [X], cameras [6]";
    }
    const mo = h.motor;
    const eye = mo.eye();
    const direction = viewDir(mo.yaw, mo.pitch);
    const kit = this.kit(h);
    const locked = d.combatLocked(h);
    if (inp.consume("ping")) {
      this.spotFrom(h.side, eye, direction, h);
      g.fx.ui("ping", 0.4, h);
    }
    if (kit.swingT !== null && this.now >= kit.swingT) {
      kit.swingT = null;
      this.hammerHit(h, eye, mo.yaw, mo.pitch);
    }
    if (inp.consume("gadget")) {
      if (locked && !["razor_wire", "deploy_shield", "signal_jammer", "motion_sensor"].includes(kit.gadget)) this.tell(h, "wait for the round to start");
      else {
        const [, msg] = this.useGadget(h, eye, mo.yaw, mo.pitch, mo.char.vel);
        if (msg) this.tell(h, msg);
      }
    }
    if (inp.consume("charge") && h.side === "attack") {
      if (locked) this.tell(h, "wait for the round to start");
      else {
        const [, msg] = this.deploy(h, "wall_charge", eye, mo.yaw, mo.pitch);
        this.tell(h, msg);
      }
    }
    if (h.side === "defend") {
      const panel = this.reinforceTarget(eye, direction);
      const holding = inp.down("use");
      if (st.action) {
        if (!holding || panel !== st.action.panel) st.action = null;
        else {
          st.action.t += dt;
          h.progress = ["reinforce", Math.min(st.action.t / st.action.total, 1)];
          if (st.action.t >= st.action.total) {
            if (this.finishReinforce(h, panel)) this.tell(h, `reinforced (${kit.reinforcements} left)`);
            st.action = null;
          }
        }
      } else if (panel) {
        if (kit.reinforcements <= 0) h.hint = "No reinforcements left";
        else if (!panel.canReinforce()) h.hint = panel.reinforced ? "Already reinforced" : "Too damaged to reinforce";
        else {
          h.hint = `Hold [F] to reinforce (${kit.reinforcements} left)`;
          if (holding) {
            st.action = { kind: "reinforce", panel, t: 0, total: Number(this.gcfg.reinforce.time ?? 2.5) };
            g.fx.playAt("hammer_hit", panel.center, 0.4);
          }
        }
      }
    }
  }

  humanBusyFor(agent: Soldier): boolean {
    const st = this.htac.get(agent);
    return !!st && (st.view !== null || st.action !== null);
  }

  // --------------------------------------------------------------- tick
  fixedUpdate(dt: number): void {
    const now = this.now;
    for (const h of this.director.humans) this.updateHuman(h, dt);
    // last tick's wire contacts slow movement this tick
    const slow = this.slowMap;
    this.slowMap = new Map();
    for (const h of this.director.humans) h.motor.slow = slow.get(h) ?? 1;
    for (const b of this.director.bots) b.slow = slow.get(b) ?? 1;
    for (const owner of this.director.match.participants as Soldier[]) {
      const kit = this.kits.get(owner);
      if (kit && kit.swingT !== null && now >= kit.swingT && !owner.isHuman && owner.alive) {
        kit.swingT = null;
        this.hammerHit(owner, owner.eye(), owner.yaw, owner.pitch);
      }
    }
    for (const dep of this.deployables) if (dep.alive) dep.update(dt, now);
    for (const dr of this.drones) if (dr.alive) dr.update(dt);
    for (const cam of this.cameras) if (cam.alive) cam.update(dt, now);
    this.deployables = this.deployables.filter((x) => x.alive);
    this.drones = this.drones.filter((x) => x.alive);
    this.pings = this.pings.filter((p) => p.until > now);
    this.spotFromViews(now);
    for (const st of this.htac.values()) if (st.viewLostT > 0) st.viewLostT -= dt;
  }

  /** Drones driven by bots spot enemies twice a second (players ping by hand). */
  private spotFromViews(now: number): void {
    if (Math.floor(now * 2) === Math.floor((now - 1 / 64) * 2)) return;
    const watched = [...this.htac.values()].map((s) => s.view).filter((v) => v);
    for (const v of this.drones) {
      if (v.alive && v.controller !== null && v.controller !== "human" && !watched.includes(v)) this.scanView(v, v.side, v.controller);
    }
  }

  /** Ping every enemy a drone or camera can see right now. */
  scanView(v: Drone | MapCamera, side: string, by: unknown = null): number {
    if (!v.alive || v.jammed) return 0;
    const eye = v.eye();
    const fwd = viewDir(v.yaw, 0);
    const cosHalf = Math.cos(Number(v.cfg.fov ?? 85) * 0.6 * Math.PI / 180);
    const rng = Number(v.cfg.view_range ?? 30);
    const kind = v instanceof Drone ? "drone" : "camera";
    let n = 0;
    for (const e of this.enemiesOf(side)) {
      const c = e.centerOfMass();
      const dv: V3 = [c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]];
      const dist = Math.hypot(dv[0], dv[1], dv[2]);
      if (dist > rng || (dv[0] * fwd[0] + dv[1] * fwd[1] + dv[2] * fwd[2]) / Math.max(dist, 1e-3) < cosHalf) continue;
      if (!this.game.world.ray(eye, c, MASK_SIGHT)) {
        this.ping(side, e.position(), kind, 3, e, by);
        n++;
      }
    }
    return n;
  }
}
