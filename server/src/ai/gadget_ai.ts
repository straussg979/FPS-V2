// Bots and the Siege layer: one GadgetAI per team strategy.
// Defenders, at the start of the prep phase, queue setup work before walking to their hold spots: reinforce
// the walls and hatch of the site they guard (breach walls first) and put their gadget down - wire across an
// attack lane, sensors facing an entrance, the shield and the jammer at their spot. Dead defenders keep
// watching the cameras.
// Attackers throw a drone during prep and drive it along a lane towards the target site (the drone spots
// defenders for the team). In the round they breach: before the execute one bot blows (or burns, or hammers)
// a breach wall of the site open and the team pushes through the hole. Vesper pulses near the site, Static
// throws an EMP at enemy electronics the team has seen, and everybody shoots enemy cameras, sensors, jammers
// and drones they have seen when there is no fight going on.

import { MASK_SIGHT } from "@cs/shared/collision";
import type { Panel } from "@cs/shared/destruction";
import type { V3 } from "@cs/shared/math";
import type { Random } from "@cs/shared/rng";
import type { MatchDirector } from "../sim/director";
import type { ServerGame } from "../sim/game";
import { type Deployable, ThermalLance, WallCharge, empGrenadeDef } from "../sim/gadgets";
import { Grenade } from "../sim/grenades";
import { type Drone, type MapCamera, viewDir } from "../sim/observation";
import type { Kit, Tactical } from "../sim/tactical";
import { anglesTo } from "./aim";
import type { BotAgent } from "./bot";
import { Task, solveThrow } from "./brain";
import { dist3 } from "./controllers";
import type { NavMesh } from "./navmesh";
import { PathFollower } from "./steering";
import type { TeamStrategy } from "./strategy";

export const GADGET_SIGHT = 30.0;

export function zoneDist(z: { min: number[]; max: number[] }, p: ArrayLike<number>): number {
  const dx = Math.max(z.min[0] - p[0], 0.0, p[0] - z.max[0]);
  const dy = Math.max(z.min[1] - p[1], 0.0, p[1] - z.max[1]);
  return Math.hypot(dx, dy);
}

function vertAxis(panel: Panel): number {
  const [a, b] = panel.ax;
  return Math.abs(panel.R[b][2]) > 0.9 ? b : a;
}

interface Driver { drone: Drone; f: PathFollower; goal: V3; start: number }

export class GadgetAI {
  team: TeamStrategy;
  director: MatchDirector;
  game: ServerGame;
  rng: Random;
  prepDone = false;
  liveDone = false;
  claimed = new Set<number>();          // panels being reinforced / breached
  drivers = new Map<number, Driver>();  // drone id -> driver
  breach: { bot: BotAgent; panel: Panel; deadline: number } | null = null;
  empDone = false;
  private watch = new Map<number, [Drone | MapCamera, number]>();   // dead bot uid -> (view, until)
  private scanT = 0;
  private breachSite: string | null = null;
  seen = new Set<number>();             // enemy gadgets the team has had in view

  constructor(team: TeamStrategy) {
    this.team = team;
    this.director = team.director;
    this.game = team.game;
    this.rng = team.rng;
    this.reset();
  }

  get nav(): NavMesh { return this.team.nav; }

  reset(): void {
    this.prepDone = false;
    this.liveDone = false;
    this.claimed = new Set();
    this.drivers = new Map();
    this.breach = null;
    this.empDone = false;
    this.watch = new Map();
    this.scanT = 0;
    this.breachSite = null;
    this.seen = new Set();
  }

  get tac(): Tactical { return this.director.tactical; }

  update(now: number): void {
    this.look();
    const m = this.director.match;
    if (m.phase === "freeze") {
      this.prepDone = this.liveDone = false;
      return;
    }
    if (m.phase === "prep" && !this.prepDone) {
      this.prepDone = true;
      if (this.team.side === "defend") this.defendSetup();
      else this.launchDrones(now);
    }
    if (m.phase === "live" && !this.prepDone) {
      // the round went live without a preparation phase
      this.prepDone = true;
      if (this.team.side === "defend") {
        if (this.director.quickStart()) this.instantSetup();
        else this.defendSetup();
      }
    }
    if ((m.phase === "live" || m.phase === "planted") && !this.liveDone) {
      this.liveDone = true;
      this.parkDrones();
    }
    this.driveDrones(now);
    if (m.phase === "live" || m.phase === "planted") this.live(now);
  }

  // ------------------------------------------------------------ sight
  private look(): void {
    const tac = this.tac;
    const side = this.team.side;
    const gadgets = [...tac.deployables, ...tac.drones].filter((g) => g.alive && g.side !== side && !this.seen.has(g.id));
    if (!gadgets.length) return;
    const eyes = this.team.aliveBots();
    for (const g of gadgets) if (this.gadgetInSight(g, eyes)) this.seen.add(g.id);
  }

  /** In a bot's view cone, 30 m, a clear ray. */
  private gadgetInSight(g: Deployable, eyes: BotAgent[]): boolean {
    const p = g.center();
    const world = this.game.world;
    for (const b of eyes) {
      const e = b.eye();
      const v: V3 = [p[0] - e[0], p[1] - e[1], p[2] - e[2]];
      const dist = Math.hypot(v[0], v[1], v[2]);
      if (dist > GADGET_SIGHT || dist < 1e-3) continue;
      const fwd = b.viewDir();
      if ((v[0] * fwd[0] + v[1] * fwd[1] + v[2] * fwd[2]) / dist < Math.cos(Number(b.profile.fov ?? 110) * 0.5 * Math.PI / 180)) continue;
      const hit = world.ray(e, p, MASK_SIGHT);
      if (!hit || dist3(hit.pos, p) < 0.3) return true;
    }
    return false;
  }

  // ------------------------------------------------------------ defence
  private siteOf(bot: BotAgent): string {
    const area = this.team.areaOf.get(bot.uid) ?? "mid";
    if (this.team.sites.has(area)) return area;
    const pos = bot.position();
    let best = "", bd = Infinity;
    for (const [n, c] of this.team.siteCenters) { const d = dist3(c, pos); if (d < bd) { bd = d; best = n; } }
    return best;
  }

  /** Where to stand to work on a panel: on the site side (reinforce) or outside (breach). */
  private standFor(panel: Panel, site: string, inside: boolean): V3 | null {
    const c = panel.center;
    const z = this.team.sites.get(site)!;
    if (panel.spec.kind === "floor") {
      const below: V3 = [c[0], c[1], c[2] - panel.size[panel.thin] / 2 - 0.2];
      const hit = this.game.world.ray(below, [below[0], below[1], below[2] - 8], MASK_SIGHT);
      if (!hit || !inside) return null;
      return this.nav.snap([c[0], c[1], hit.pos[2]], 4);
    }
    let n = panel.normal;
    n = [n[0], n[1], 0];
    const l = Math.hypot(n[0], n[1]);
    if (l * l < 1e-6) return null;
    n = [n[0] / l, n[1] / l, 0];
    const vert = vertAxis(panel);
    const floorZ = c[2] - panel.size[vert] / 2;
    const off = panel.size[panel.thin] / 2 + 0.75;
    const sc = this.team.siteCenters.get(site)!;
    const cands: V3[] = [[c[0] + n[0] * off, c[1] + n[1] * off, floorZ], [c[0] - n[0] * off, c[1] - n[1] * off, floorZ]];
    cands.sort((p, q) => (zoneDist(z, p) + 0.01 * dist3(p, sc)) - (zoneDist(z, q) + 0.01 * dist3(q, sc)));
    const p = inside ? cands[0] : cands[1];
    const q = this.nav.snap(p, 4);
    if (!q || Math.abs(q[2] - floorZ) > 0.6 || Math.hypot(q[0] - p[0], q[1] - p[1]) > 1.0) return null;
    return q;
  }

  /** A wall panel that reaches the floor and is big enough to walk through once opened, or a hatch. */
  static doorSized(panel: Panel): boolean {
    if (panel.spec.kind === "floor") return true;
    const vert = vertAxis(panel);
    const [a, b] = panel.ax;
    const horiz = vert === b ? a : b;
    const bottom = panel.center[2] - panel.size[vert] / 2;
    return panel.size[vert] >= 2.0 && panel.size[horiz] >= 1.2 && bottom < 0.3;
  }

  private panelsFor(site: string, reinforceable = true, breach = false): Panel[] {
    const z = this.team.sites.get(site)!;
    return this.game.destruction.panels.filter((p) => !(reinforceable && !p.spec.reinforceable) && !(breach && !p.spec.breach)
      && zoneDist(z, p.center) <= 1.5 && GadgetAI.doorSized(p));
  }

  private defendSetup(): void {
    const tac = this.tac;
    for (const b of this.team.aliveBots()) {
      const hold = b.brain!.task;
      const kit = tac.kit(b);
      const site = this.siteOf(b);
      const chain: Task[] = [];
      // reinforcements: breach walls first, then the hatch, then the rest
      const panels = this.panelsFor(site).filter((p) => !this.claimed.has(p.index) && p.canReinforce());
      const key = (p: Panel) => [p.spec.breach ? 0 : 1, p.spec.kind !== "floor" ? 1 : 0, dist3(p.center, b.position())];
      panels.sort((p, q) => { const a = key(p), c = key(q); return a[0] - c[0] || a[1] - c[1] || a[2] - c[2]; });
      for (const p of panels) {
        if (chain.length >= kit.reinforcements) break;
        const stand = this.standFor(p, site, true);
        if (!stand) continue;
        this.claimed.add(p.index);
        chain.push(new Task("use", { pos: stand, look: this.aimPoint(p, stand), action: this.reinforceAction(p),
          actionTime: Number(tac.gcfg.reinforce?.time ?? 2.5), tag: "reinforce", timeout: 25.0 }));
      }
      const g = this.gadgetTask(kit, site, hold);
      if (g) chain.push(g);
      if (!chain.length) continue;
      chain.forEach((t, i) => { t.then = i + 1 < chain.length ? chain[i + 1] : hold; });
      b.brain!.setTask(chain[0]);
    }
  }

  /** Quick start (no preparation phase against a player): every defending bot starts the round set up - its
   * site's walls reinforced, standing at its hold spot facing the way it would hold - and only walks off to put
   * its gadget down. */
  private instantSetup(): void {
    const tac = this.tac;
    for (const b of this.team.aliveBots()) {
      const hold = b.brain!.task;
      const kit = tac.kit(b);
      const site = this.siteOf(b);
      const panels = this.panelsFor(site).filter((p) => !this.claimed.has(p.index) && p.canReinforce());
      const key = (p: Panel) => [p.spec.breach ? 0 : 1, p.spec.kind !== "floor" ? 1 : 0, dist3(p.center, b.position())];
      panels.sort((p, q) => { const a = key(p), c = key(q); return a[0] - c[0] || a[1] - c[1] || a[2] - c[2]; });
      for (const p of panels) {
        if (kit.reinforcements <= 0) break;
        this.claimed.add(p.index);
        tac.finishReinforce(b, p);
      }
      const spot = hold.pos ? this.nav.snap(hold.pos, 2) : null;
      if (spot) {
        const yaw = hold.yaw ?? b.aim.yaw;
        b.char.teleport(spot);
        b.char.vel = [0, 0, 0];
        b.char.prevPos = [...b.char.pos] as V3;
        b.aim.yaw = b.prevYaw = yaw;
        b.pose.animate(0, b.char.pos, yaw, 0, 0, [0, 0, 0], true);
      }
      const g = this.gadgetTask(kit, site, hold);
      if (g) {
        let t: Task = g;
        while (t.then instanceof Task) t = t.then;
        t.then = hold;
        b.brain!.setTask(g, true);
      } else b.brain!.setTask(hold, true);
    }
  }

  private aimPoint(panel: Panel, stand: V3): V3 {
    const c = panel.center;
    if (panel.spec.kind === "floor") return [c[0], c[1], c[2] - panel.size[panel.thin] / 2];
    // the point of the wall right in front of where we stand, at chest height
    const lp = panel.toLocal(stand);
    const vert = vertAxis(panel);
    const [a, b] = panel.ax;
    const horiz = vert === b ? a : b;
    const loc = [0, 0, 0];
    loc[horiz] = Math.max(-panel.size[horiz] / 2 + 0.3, Math.min(panel.size[horiz] / 2 - 0.3, lp[horiz]));
    loc[vert] = (-panel.size[vert] / 2 + Math.min(1.2, panel.size[vert] / 2)) * (panel.R[vert][2] > 0 ? 1 : -1);
    return panel.toWorld(loc);
  }

  private reinforceAction(panel: Panel): (bot: BotAgent) => boolean {
    return (bot) => {
      if (this.tac.reinforceTarget(bot.eye(), viewDir(bot.aim.yaw, bot.aim.pitch)) === panel) this.tac.finishReinforce(bot, panel);
      return true;
    };
  }

  private gadgetTask(kit: Kit, site: string, hold: Task): Task | null {
    const g = kit.gadget;
    if (kit.gadgetLeft <= 0 || !["razor_wire", "motion_sensor", "deploy_shield", "signal_jammer"].includes(g)) return null;
    if (g === "deploy_shield" || g === "signal_jammer") {
      if (!hold.pos) return null;
      const fwd = viewDir(hold.yaw ?? 0, 0);
      const spot: V3 = [hold.pos[0] + fwd[0] * 0.9, hold.pos[1] + fwd[1] * 0.9, hold.pos[2]];
      return new Task("use", { pos: [...hold.pos] as V3, look: [spot[0], spot[1], hold.pos[2] + 0.05], action: this.deployAction(g),
        actionTime: 0.6, tag: "gadget", timeout: 20.0 });
    }
    const entries = this.entries(site);
    if (!entries.length) return null;
    if (g === "razor_wire") {
      let first: Task | null = null, prev: Task | null = null;
      for (const [outside, inward] of entries.slice(0, kit.gadgetLeft)) {
        const t = new Task("use", { pos: [outside[0] - inward[0] * 1.3, outside[1] - inward[1] * 1.3, outside[2]],
          look: [outside[0], outside[1], outside[2] + 0.05], action: this.deployAction(g), actionTime: 0.6, tag: "gadget", timeout: 20.0 });
        if (prev) prev.then = t;
        first = first ?? t;
        prev = t;
      }
      return first;
    }
    // motion sensor: on a wall behind the entrance, facing it
    const [outside, inward] = entries[0];
    const inner: V3 = [outside[0] + inward[0] * 2.5, outside[1] + inward[1] * 2.5, outside[2]];
    const eye: V3 = [inner[0], inner[1], inner[2] + 1.6];
    const hit = this.game.world.ray(eye, [eye[0] + inward[0] * 6, eye[1] + inward[1] * 6, eye[2]], MASK_SIGHT);
    if (!hit || Math.abs(hit.normal[2]) > 0.5) return null;
    const mount: V3 = [hit.pos[0], hit.pos[1], hit.pos[2] + 0.6];
    const stand = this.nav.snap([hit.pos[0] - inward[0] * 1.4, hit.pos[1] - inward[1] * 1.4, outside[2]], 4) ?? inner;
    return new Task("use", { pos: [...stand] as V3, look: mount, action: this.deployAction(g), actionTime: 0.6, tag: "gadget", timeout: 20.0 });
  }

  /** Points just outside the site where the attack lanes come in, with the inward direction. */
  private entries(site: string): Array<[V3, V3]> {
    const z = this.team.sites.get(site)!;
    const out: Array<[V3, V3]> = [];
    for (const lane of this.team.lanes.get(site) ?? []) {
      const pts = lane.points;
      for (let i = 1; i < pts.length; i++) {
        if (zoneDist(z, pts[i]) !== 0) continue;
        const a = pts[i - 1], b = pts[i];
        let d: V3 = [b[0] - a[0], b[1] - a[1], 0];
        const l = Math.hypot(d[0], d[1]);
        if (l * l < 1e-6) break;
        d = [d[0] / l, d[1] / l, 0];
        // walk back from the boundary crossing until 1.2 m outside
        let p: V3 = [b[0], b[1], b[2] ?? 0];
        for (let k = 0; k < 60; k++) {
          if (zoneDist(z, p) >= 1.2) break;
          p = [p[0] - d[0] * 0.2, p[1] - d[1] * 0.2, p[2]];
        }
        const q = this.nav.snap(p, 3);
        if (q) out.push([q, d]);
        break;
      }
    }
    this.rng.shuffle(out);
    return out;
  }

  private deployAction(kind: string): (bot: BotAgent) => boolean {
    return (bot) => {
      this.tac.deploy(bot, kind, bot.eye(), bot.aim.yaw, bot.aim.pitch);
      return true;
    };
  }

  // ------------------------------------------------------------- drones
  private launchDrones(now: number): void {
    const tac = this.tac;
    const site = this.team.site || [...this.team.sites.keys()][0];
    if (!site) return;
    for (const b of this.team.aliveBots()) {
      if (this.rng.random() < 0.25) continue;
      const drone = tac.throwDrone(b, b.char.pos, b.aim.yaw);
      if (!drone) continue;
      drone.controller = b;
      const lanes = this.team.lanes.get(site) ?? [];
      let goal: V3 = this.team.siteCenters.get(site)!;
      if (lanes.length) {
        const lane = this.rng.choice(lanes);
        const pts = lane.points;
        if (pts.length) {
          const q = pts[Math.min(pts.length - 1, lane.stage + 2)];
          goal = [q[0], q[1], q[2] ?? 0];
        }
      }
      this.drivers.set(drone.id, { drone, f: new PathFollower(this.nav), goal, start: now + 0.8 });
    }
  }

  private driveDrones(now: number): void {
    const dt = 0.25;
    for (const [key, dr] of [...this.drivers]) {
      const { drone, f, goal, start } = dr;
      if (!drone.alive || drone.controller === null || drone.controller === "human") {
        this.drivers.delete(key);
        continue;
      }
      if (now < start || !drone.char.onGround) continue;
      const p = drone.char.pos;
      if (!f.active && !f.failed && !f.arrived) {
        f.goTo(p, goal);
        if (f.failed) {
          this.drivers.delete(key);
          continue;
        }
      }
      if (f.arrived || f.failed) {
        drone.drive([0, 0, 0]);
        drone.yaw = (drone.yaw + 35.0) % 360.0;     // look around
        continue;
      }
      const st = f.update(dt, p, drone.char.horizontalSpeed);
      drone.drive(st.wish, st.jump);
      if (st.wish[0] * st.wish[0] + st.wish[1] * st.wish[1] > 1e-6) drone.yaw = Math.atan2(-st.wish[0], st.wish[1]) * 180 / Math.PI;
    }
  }

  private parkDrones(): void {
    for (const { drone } of this.drivers.values()) {
      drone.drive([0, 0, 0]);
      drone.controller = null;
    }
    this.drivers.clear();
  }

  // --------------------------------------------------------------- live
  private live(now: number): void {
    if (now < this.scanT) return;
    this.scanT = now + 0.5;
    const tac = this.tac;
    const side = this.team.side;
    const bots = this.team.aliveBots();
    for (const b of bots) {
      const kit = tac.kit(b);
      // Vesper: pulse when close to the target site
      if (kit.gadget === "pulse_scanner" && kit.gadgetLeft > 0 && now >= kit.readyT && side === "attack") {
        const site = this.team.site;
        if (site && zoneDist(this.team.sites.get(site)!, b.position()) < 14.0) {
          tac.useGadget(b, b.eye(), b.aim.yaw, b.aim.pitch);
          this.team.radio(b, "Pulse out.", "pulse", 8.0);
        }
      }
      // shoot enemy gadgets in view when there is no fight
      if (b.brain!.mode === "task" && !b.brain!.gadgetTarget) {
        const tgt = this.visibleGadget(b);
        if (tgt) b.brain!.gadgetTarget = tgt;
      }
    }
    if (side === "attack") {
      this.breachUpdate(bots, now);
      this.emp(bots);
    } else this.watchCameras(now);
  }

  /** The closest enemy gadget in front (22 m), limited to gadgets the team has had in view; map cameras are
   * public. */
  private visibleGadget(bot: BotAgent): Deployable | null {
    const tac = this.tac;
    const eye = bot.eye();
    let best: Deployable | null = null, bd = 22.0;
    const cands: Deployable[] = [...tac.deployables.filter((d) => d.side !== bot.side && d.damageable && d.alive),
      ...tac.drones.filter((d) => d.side !== bot.side && d.alive)];
    if (bot.side === "attack") cands.push(...tac.cameras.filter((c) => c.alive));
    const fwd = viewDir(bot.aim.yaw, 0);
    for (const d of cands) {
      const c = d.center();
      const v: V3 = [c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]];
      const dist = Math.hypot(v[0], v[1], v[2]);
      if (dist > bd || dist < 0.5 || (v[0] * fwd[0] + v[1] * fwd[1] + v[2] * fwd[2]) / dist < 0.2) continue;
      const hit = this.game.world.ray(eye, c, MASK_SIGHT);
      if (hit && dist3(hit.pos, c) > 0.25) continue;
      best = d;
      bd = dist;
    }
    if (best && !this.seen.has(best.id) && best.kind !== "camera") return null;
    return best;
  }

  /** Dead defenders sit on the cameras and call out what they see. */
  private watchCameras(now: number): void {
    const tac = this.tac;
    const cams = tac.cameras.filter((c) => c.alive && !c.jammed);
    const dead = this.team.bots().filter((b) => !b.alive);
    if (!cams.length || !dead.length) return;
    for (const b of dead) {
      let [view, until] = this.watch.get(b.uid) ?? [null, 0];
      if (!view || !view.alive || now >= until) {
        view = this.rng.choice(cams);
        until = now + 5.0;
        this.watch.set(b.uid, [view, until]);
      }
      tac.scanView(view, "defend", b);
    }
  }

  // ------------------------------------------------------------- breach
  /** A teammate is still opening the wall: the execute waits for it. */
  breachBusy(): boolean {
    const br = this.breach;
    if (!br) return false;
    const b = br.bot;
    return b.alive && ["breach", "breach_wait"].includes(b.brain!.task.tag) && b.now < br.deadline;
  }

  private breachUpdate(bots: BotAgent[], now: number): void {
    const team = this.team;
    if (team.phase !== "stage" || !team.site) return;
    const br = this.breach;
    if (br) {
      if (!bots.includes(br.bot) || now > br.deadline) this.breach = null;
      return;
    }
    if (this.breachSite === team.site) return;
    // only from the group gathered outside the site, not on the way there
    const staged = bots.filter((b) => team.stageArrived.has(b.uid));
    if (!staged.length) return;
    this.breachSite = team.site;
    const tac = this.tac;
    const panels = this.panelsFor(team.site, false, true).filter((p) => p.destroyedFraction() < 0.5 && p.spec.kind === "wall");
    if (!panels.length) return;
    const carrier = this.director.bomb.carrier;
    const options: Array<[number, BotAgent, Panel, string, V3]> = [];
    for (const b of staged) {
      const kit = tac.kit(b);
      for (const p of panels) {
        let ok: boolean, tool: string;
        if (p.reinforced) { ok = kit.gadget === "thermal_lance" && kit.gadgetLeft > 0; tool = "thermal_lance"; }
        else if (kit.gadget === "breach_hammer" && kit.gadgetLeft > 0) { ok = true; tool = "breach_hammer"; }
        else { ok = kit.charges > 0; tool = "wall_charge"; }
        if (!ok) continue;
        const stand = this.standFor(p, team.site, false);
        if (!stand) continue;
        const dist = dist3(stand, b.position());
        if (dist > 32.0) continue;
        options.push([dist + (b === carrier ? 25.0 : 0), b, p, tool, stand]);
      }
    }
    if (!options.length) {
      tac.log("breach_none", `no breach at ${team.site}: ${panels.length} wall(s), ${panels.filter((p) => p.reinforced).length} reinforced, no tool or no way round`);
      return;
    }
    options.sort((x, y) => x[0] - y[0]);
    const [, b, p, tool, stand] = options[0];
    const look = this.aimPoint(p, stand);
    let n: V3 = [stand[0] - look[0], stand[1] - look[1], 0];
    const nl = Math.hypot(n[0], n[1]);
    if (nl * nl < 1e-6) return;
    n = [n[0] / nl, n[1] / nl, 0];
    const back = this.nav.snap([stand[0] + n[0] * 2.6, stand[1] + n[1] * 2.6, stand[2]], 4) ?? stand;
    const prevTask = b.brain!.task;
    const site = team.site;
    const resume = (): Task => {
      // through the new hole into the site
      const spot = team.siteCenters.get(site)!;
      return prevTask.kind !== "plant" ? new Task("move", { pos: [...spot] as V3, look: [spot[0], spot[1], spot[2] + 1.2], wait: true, tag: "clear" })
        : prevTask;
    };
    const chargeGone = (bot: BotAgent): boolean => !tac.deployables.some((d) => (d instanceof WallCharge || d instanceof ThermalLance)
      && d.alive && d.owner === bot);
    let task: Task;
    if (tool === "breach_hammer") {
      let swings = 0;
      const swing = (bot: BotAgent): boolean => {
        tac.useGadget(bot, bot.eye(), bot.aim.yaw, bot.aim.pitch);
        swings++;
        return p.destroyedFraction() > 0.35 || swings >= 8;
      };
      task = new Task("use", { pos: stand, look, action: swing, actionTime: 1.2, tag: "breach", timeout: 25.0, then: resume });
    } else {
      const place = (bot: BotAgent): boolean => {
        const [ok, msg] = tool === "wall_charge" ? tac.deploy(bot, "wall_charge", bot.eye(), bot.aim.yaw, bot.aim.pitch)
          : tac.useGadget(bot, bot.eye(), bot.aim.yaw, bot.aim.pitch);
        if (!ok) tac.log("breach_failed", `${bot.name} could not breach: ${msg}`);
        return true;
      };
      const wait = new Task("hold", { pos: back, look, wait: true, until: chargeGone, tag: "breach_wait", timeout: 12.0, then: resume });
      task = new Task("use", { pos: stand, look, action: place, actionTime: 0.7, tag: "breach", timeout: 25.0, then: wait });
    }
    b.brain!.deferred = null;
    b.brain!.setTask(task, true);
    tac.log("breach_plan", `${b.name} will breach ${p.spec.name || p.index} with the ${tool.replace(/_/g, " ")}`);
    this.breach = { bot: b, panel: p, deadline: now + 30.0 };
    team.radio(b, ({ wall_charge: "Placing a breach charge.", thermal_lance: "Burning through the wall.",
      breach_hammer: "Opening the wall up." } as Record<string, string>)[tool], "breach", 10.0);
  }

  private emp(bots: BotAgent[]): void {
    const team = this.team;
    if (this.empDone || (team.phase !== "exec" && team.phase !== "go") || !team.site) return;
    const tac = this.tac;
    const siteC = team.siteCenters.get(team.site)!;
    const targets = [...tac.deployables, ...tac.cameras].filter((d) => d.side !== "attack" && d.alive && d.electronic
      && (d.kind === "camera" || this.seen.has(d.id)) && dist3(d.center(), siteC) < 16.0);
    const thrower = bots.find((b) => tac.kit(b).gadget === "emp_grenade" && tac.kit(b).gadgetLeft > 0);
    if (!targets.length || !thrower) return;
    const tp = thrower.position();
    const tgt = targets.reduce((a, d) => (dist3(d.center(), tp) < dist3(a.center(), tp) ? d : a));
    const start = thrower.eye();
    if (dist3(tgt.center(), start) > 28.0) return;
    const gd = empGrenadeDef();
    const vel = solveThrow(start, tgt.center(), gd.throwSpeed, this.game.world);
    if (!vel) return;
    const [yaw, pitch] = anglesTo(vel[0], vel[1], vel[2]);
    thrower.aim.yaw = yaw;
    thrower.aim.pitch = Math.max(-60.0, Math.min(60.0, pitch - 8.0));
    const f = viewDir(yaw, 0);
    this.game.spawnGrenade(new Grenade(this.game, gd, [start[0] + f[0] * 0.3, start[1] + f[1] * 0.3, start[2]], vel, thrower));
    tac.kit(thrower).gadgetLeft -= 1;
    this.empDone = true;
    team.radio(thrower, "EMP out!", "emp", 6.0);
  }
}
