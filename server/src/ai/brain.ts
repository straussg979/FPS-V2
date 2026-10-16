// Bot brain: utility-scored actions with commitment. A few times per second (think, staggered between bots)
// the brain builds a context of what the bot knows and scores every action it could take; the best one runs
// every tick until the next think. Scores come from considerations (health and armour, magazine, weapon
// versus range, numbers advantage, a teammate close enough to trade, time left, the bomb, how exposed the bot
// believes it is, cover nearby) shaped by the bot's traits and role. The running action keeps a bonus until
// its minimum time has passed and a challenger must beat it by a margin, so bots do not dither; a little
// noise (more on easy, under stress) keeps two bots in the same spot from always doing the same thing.
//
// Actions: engage (fight a visible enemy), retreat (into cover), reload, trade (a teammate just died close
// by), alert (investigate a sound / callout / hit), reposition (after a kill or a hit on a hold), avoid
// (a flash in view, a frag close), throw (a grenade the team ordered or the bot decided on), task (the
// team's order: move, hold, plant, defuse, gadgets...).
//
// What the bot knows about enemies lives in its knowledge (knowledge.ts) and the team's possibility field
// (belief.ts); nothing here reads an enemy's state except through a contact visible right now.

import { GRAVITY, LEAN_OFFSET, leanClearance, rightOfYaw } from "@cs/shared/character";
import { MASK_SIGHT } from "@cs/shared/collision";
import type { DamageResult } from "@cs/shared/damage";
import { type V3, wrap180 } from "@cs/shared/math";
import type { Random } from "@cs/shared/rng";
import type { WeaponState } from "@cs/shared/weapons";
import type { Deployable } from "../sim/gadgets";
import type { Soldier } from "../sim/soldier";
import { anglesTo } from "./aim";
import type { BotAgent } from "./bot";
import { AimPolicy, EYE, Mover, PeekHelper, RANGE_LIMIT, Shooter, dist3, flat, len2, sub3, teammateInLine, unit2 } from "./controllers";
import type { Humanizer } from "./humanize";
import { type BotKnowledge, Fact, factPoint } from "./knowledge";
import type { NavMesh, Pt3 } from "./navmesh";
import { FollowerV2, PENDING, type PathService } from "./pathing";
import type { Contact, Perception } from "./perception";
import { type Traits, traitsFor } from "./personality";
import type { TeamStrategy } from "./strategy";
import type { TacticalMap } from "./tactical_map";

// --------------------------------------------------------------------- orders
let nextTaskId = 1;

export type TaskThen = Task | ((bot: BotAgent) => Task | null) | null;

export class Task {
  readonly id = nextTaskId++;
  kind = "idle";              // idle | move | hold | plant | defuse | pickup | guard | hunt | save | use
  pos: V3 | null = null;
  via: number[][] = [];       // lane waypoints to pass on the way
  yaw: number | null = null;  // facing once there
  look: V3 | null = null;     // point to watch once there
  crouch = false;
  walk = false;
  walkNear = 0;               // walk (quietly, accurately) within this distance of pos
  wait = false;               // stay when arrived (until the team gives a new task)
  tag = "";
  issued = 0;
  // gadget work (gadget_ai.ts): on arrival look at `look` and call action(bot) every actionTime seconds until
  // it returns true; `until` ends a waiting task; then the bot moves on to `then`
  action: ((bot: BotAgent) => boolean) | null = null;
  actionTime = 0;
  until: ((bot: BotAgent) => boolean) | null = null;
  then: TaskThen = null;
  timeout = 0;

  constructor(kind = "idle", opts: Partial<Omit<Task, "id" | "kind">> = {}) {
    this.kind = kind;
    Object.assign(this, opts);
  }
}

export const BREACH_TAGS = ["breach", "breach_wait"];

export class ThrowOrder {
  velocity: V3 | null = null;
  aimT = 0;
  cands: V3[] | null = null;
  constructor(public key: string, public target: V3, public deadline: number) {}
}

/** Launch velocity that lands a grenade on target (no drag/bounces), or null. */
export function solveThrow(start: V3, target: V3, speed: number, world: { ray: (a: V3, b: V3, m: number) => unknown } | null = null,
  preferHigh = false): V3 | null {
  const dx = target[0] - start[0], dy = target[1] - start[1], dz = target[2] - start[2];
  const d = Math.hypot(dx, dy);
  if (d < 0.5) return [0, 0, speed * 0.3];
  const g = GRAVITY;
  const v2 = speed * speed;
  const disc = v2 * v2 - g * (g * d * d + 2 * dz * v2);
  if (disc < 0) return null;
  const root = Math.sqrt(disc);
  for (const sign of preferHigh ? [1, -1] : [-1, 1]) {
    const theta = Math.atan((v2 + sign * root) / (g * d));
    const vel: V3 = [dx / d * Math.cos(theta) * speed, dy / d * Math.cos(theta) * speed, Math.sin(theta) * speed];
    if (!world || arcClear(start, vel, d, world)) return vel;
  }
  return null;
}

function arcClear(start: V3, vel: V3, dist: number, world: { ray: (a: V3, b: V3, m: number) => unknown }): boolean {
  const horiz = Math.hypot(vel[0], vel[1]);
  const tEnd = dist / Math.max(horiz, 1e-3);
  const steps = Math.max(Math.trunc(tEnd / 0.06), 2);
  let prev: V3 = [start[0], start[1], start[2]];
  for (let k = 1; k <= steps; k++) {
    const t = tEnd * k / steps;
    const p: V3 = [start[0] + vel[0] * t, start[1] + vel[1] * t, start[2] + vel[2] * t - 0.5 * GRAVITY * t * t];
    if (world.ray(prev, p, MASK_SIGHT) !== null) return k >= steps - 1;   // touching down just before is fine
    prev = p;
  }
  return true;
}

// ----------------------------------------------------------------- context
/** What the bot knows at a think. */
export class Ctx {
  now = 0;
  hp = 100;
  ws: WeaponState | null = null;
  mag = 1;
  empty = false;
  visible: Contact[] = [];
  target: Contact | null = null;
  threat: V3 | null = null;
  threatDist = 99;
  point = -1;
  exposure = 0;
  allies = 0;
  enemies = 0;
  trade: [Fact, V3] | null = null;
  fact: Fact | null = null;
  lost: Fact | null = null;
  cover: [V3, number] | null = null;
  incoming: [string, V3] | null = null;
  dangerHere = 0;
  timeLeft: number | null = null;
  bomb = "";
  holding = false;
  outranged = false;
  stale = false;
}

export class Action {
  name = "action";
  minTime = 0.4;
  started = -1;
  constructor(public b: BrainV2) {}
  score(_ctx: Ctx): number { return 0; }
  start(_ctx: Ctx, now: number): void { this.started = now; }
  stop(): void {}
  run(_dt: number, _now: number): void {}
}

// ----------------------------------------------------------------- actions
class Fight extends Action {
  override name = "engage";
  override minTime = 0.3;
  target: Contact | null = null;
  hideUntil = 0;
  holdUntil = 0;
  hideDir: V3 | null = null;
  lastSeenT = -10;
  strafeDir = 1;
  strafeUntil = 0;

  override score(ctx: Ctx): number {
    if (ctx.target) {
      // out of the weapon's range, or a long-range duel going nowhere: not worth standing in the open for
      if (ctx.outranged || ctx.stale) return 0;
      if (ctx.threatDist < 12.0) return 1.1;
      if (ctx.hp < 35 && ctx.cover && ctx.threatDist > 15.0 && dist3(ctx.cover[0], this.b.bot.position()) < 3.2) return 0.9;
      return 1.0;
    }
    // keep fighting through our own un-peek: behind cover, holding the corner, re-peek
    if (this.target && this.target.agent.alive && ctx.now < this.holdUntil + 0.4) return 0.95;
    return 0;
  }

  override start(ctx: Ctx, now: number): void {
    super.start(ctx, now);
    if (ctx.target) this.target = ctx.target;
  }

  override run(dt: number, now: number): void {
    const b = this.b;
    const bot = b.bot;
    const it = bot.intent;
    const c = b.ctx.target ?? this.target;
    if (!c || !c.agent.alive) return;
    if (c !== this.target) this.target = c;
    b.perception.busyWith = c.agent.uid;
    if (!c.seen) {
      // hidden on purpose: step behind cover, hold the corner it would come round, then re-peek
      const f = new Fact(c.agent.uid, [c.pos[0], c.pos[1], c.pos[2]], 0.5, c.time, "sight");
      bot.aim.lookAt(bot.eye(), b.preaim(f, now), dt, 0.8);
      if (this.hideDir && now < this.hideUntil) it.wish = this.hideDir;
      else if (this.hideDir && now < this.holdUntil) it.crouch = b.traits.patience > 0.5;
      else if (this.hideDir) it.wish = [-this.hideDir[0], -this.hideDir[1], 0];      // swing back out
      b.reloadIf(now < this.holdUntil ? 0.99 : 0.0);
      return;
    }
    this.lastSeenT = now;
    const [firing, off, tol] = b.shooter.engage(c, dt, now);
    const ws = bot.weapons.inv.current();
    const dist = dist3(c.pos, bot.position());
    const speed = bot.char.horizontalSpeed;
    const enemy = c.agent;
    const runGun = ws !== null && ["smg", "shotgun", "knife"].includes(ws.d.cls) && dist < 9;
    if (ws && ws.d.fireMode === "melee") it.wish = b.dirTo(enemy.position());
    else if (runGun && firing) {
      const k = ws!.d.cls === "knife" ? 1.0 : 0.3;
      const d = b.dirTo(enemy.position());
      it.wish = [d[0] * k, d[1] * k, 0];
    } else if (firing || off <= tol * 2.5) {
      if (speed > 1.0) it.wish = unit2([-bot.char.vel[0], -bot.char.vel[1], 0]);
      it.crouch = ws !== null && !["smg", "shotgun", "knife"].includes(ws.d.cls) && dist > 22 && Number(bot.profile.strafe ?? 0) >= 0.3;
    } else it.wish = this.betweenBursts(c, dist, now);
    if (ws && ws.d.magazine > 0 && ws.ammo === 0 && dist > 8 && !this.hideDir) this.hide(c, now, ws.d.reloadEmptyTime);  // reload in cover
    bot.scoped = ws !== null && !!ws.d.scope && speed < 1.5;
    if (now - b.callT > 1.5) {
      b.callT = now;
      b.team.onSighting(bot, c, now);
    }
  }

  private hide(c: Contact, now: number, reload = 0): void {
    const b = this.b;
    const rng = b.bot.rng;
    if (!reload && b.human.mistake("over_peek")) {
      // stays out in the open between bursts (a mistake the easier bots make more often)
      this.hideDir = null;
      this.holdUntil = now + 1.0;
      return;
    }
    this.hideDir = b.peek.hideDir(c.agent.headPos());
    this.hideUntil = now + rng.uniform(0.35, 0.6);
    // how long to hold the corner before peeking again; a reload waits behind cover
    const hold = rng.uniform(0.05, 0.35) + 0.4 * b.traits.patience * (1.0 - 0.6 * b.traits.risk);
    this.holdUntil = this.hideUntil + Math.max(hold, reload);
  }

  private betweenBursts(c: Contact, dist: number, now: number): V3 {
    const b = this.b;
    const bot = b.bot;
    // long-range duel: step behind cover between bursts, then re-peek
    if (dist > 20 && now < b.shooter.pauseUntil - 0.15 && b.traits.risk < 0.75) {
      if (!this.hideDir || now > this.holdUntil + 1.0) this.hide(c, now);
      if (this.hideDir && now < this.hideUntil) return this.hideDir;
    }
    if (dist < 11 && Number(bot.profile.strafe ?? 0) > 0) {
      if (now >= this.strafeUntil) {
        this.strafeUntil = now + bot.rng.uniform(0.35, 0.7);
        this.strafeDir = -this.strafeDir;
      }
      const to = flat(sub3(c.pos, bot.position()));
      if (to[0] * to[0] + to[1] * to[1] > 1e-4) {
        const u = unit2(to);
        const side: V3 = [-u[1] * this.strafeDir, u[0] * this.strafeDir, 0];
        const p = bot.position();
        if (b.nav.walkableLine(p, [p[0] + side[0] * 1.2, p[1] + side[1] * 1.2, p[2]])) return side;
      }
    }
    return [0, 0, 0];
  }

  override stop(): void {
    this.b.perception.busyWith = null;
    this.hideDir = null;
  }
}

class FallBack extends Action {
  override name = "retreat";
  override minTime = 0.8;
  spot: V3 | null = null;
  threat: V3 | null = null;
  until = 0;

  override score(ctx: Ctx): number {
    const threat = ctx.threat;
    if (!threat || !ctx.cover) return 0;
    const b = this.b;
    const ws = ctx.ws;
    let need = 0;
    const sec = b.bot.weapons.secondary;
    // running for cover across open ground under fire is worse than fighting it out
    const close = dist3(ctx.cover[0], b.bot.position()) < 3.2;
    if (ws && ws.d.magazine > 0 && ws.ammo === 0) {
      const pistol = sec !== null && sec !== ws && sec.ammo > 0;
      if (ctx.threatDist > 25 || !pistol) need = 1.15;
    } else if (ctx.hp < 35 && ctx.target && ctx.threatDist > 15.0 && close) need = 0.97;
    else if (ctx.hp < 30 && ctx.enemies > ctx.allies && (close || !ctx.target)) need = 0.97;
    else if ((ctx.stale || ctx.outranged) && ctx.holding) need = 0.9;
    else if (ctx.visible.length >= 2 && ctx.enemies > ctx.allies && b.traits.risk < 0.6) need = 0.96;
    if (this.spot && ctx.now < this.until) need = Math.max(need, 0.9);
    return need;
  }

  override start(ctx: Ctx, now: number): void {
    super.start(ctx, now);
    this.spot = ctx.cover![0];
    this.threat = [...ctx.threat!] as V3;
    this.until = now + 2.5 + dist3(this.spot, this.b.bot.position()) / 4.0;
    this.b.say("Falling back!", "fallback", 6.0);
  }

  override run(dt: number, now: number): void {
    const b = this.b;
    const bot = b.bot;
    if (!this.threat) return;
    const look: V3 = [this.threat[0], this.threat[1], this.threat[2] + 1.45];
    if (!this.spot) {
      b.look(look, dt, 0.8);
      b.reloadIf(0.99);
      return;
    }
    if (len2(sub3(this.spot, bot.position())) > 0.5) {
      b.mover.to(this.spot, dt, `fallback:${this.spot[0].toFixed(1)}:${this.spot[1].toFixed(1)}`, false, [], look, true);
    } else {
      bot.intent.crouch = true;
      b.look(look, dt, 0.8);
    }
    b.reloadIf(0.99);
    if (now > this.until) this.spot = null;
  }
}

class Reload extends Action {
  override name = "reload";
  override minTime = 0.6;

  override score(ctx: Ctx): number {
    const ws = ctx.ws;
    if (!ws || ws.d.magazine <= 0 || ws.reloading || ctx.target) return 0;
    if (ws.ammo >= ws.d.magazine || ws.reserve <= 0) return 0;
    const safe = ctx.exposure < 0.08 && (!ctx.fact || ctx.now - ctx.fact.time > 2.0);
    if (ctx.mag < 0.25) return safe || this.b.human.mistake("reload_open") ? 0.92 : 0.6;
    if (safe && ctx.mag < 0.9) return 0.45 + 0.3 * (1.0 - ctx.mag);
    return 0;
  }

  override run(dt: number, now: number): void {
    const b = this.b;
    const ws = b.bot.weapons.inv.current();
    if (ws && !ws.reloading && ws.ammo < ws.d.magazine) ws.startReload(now);
    (b.actions.task as DoTask).run(dt, now);    // keep doing the order while the magazine goes in
  }
}

class Trade extends Action {
  override name = "trade";
  override minTime = 0.6;
  fact: Fact | null = null;
  spot: V3 | null = null;
  until = 0;
  wait = 0;

  override score(ctx: Ctx): number {
    if (!ctx.trade || ctx.target) return 0;
    const b = this.b;
    if (b.task.kind === "plant" || b.task.kind === "defuse") return 0;    // the carrier / defuser keeps to the objective
    if (ctx.mag < 0.2 || ctx.hp < 20) return 0;
    if (this.fact && ctx.now < this.until) return 0.9;
    return 0.84 + 0.12 * b.traits.teamwork;
  }

  override start(ctx: Ctx, now: number): void {
    super.start(ctx, now);
    [this.fact, this.spot] = ctx.trade!;
    const late = this.b.human.mistake("late_trade");
    this.until = now + 2.6 + (late ? 0.9 : 0);
    this.wait = now + (late ? 0.9 : 0);
    if (!late) this.b.say("I'll trade you!", "trade", 8.0);
  }

  override run(dt: number, now: number): void {
    const b = this.b;
    const bot = b.bot;
    if (b.ctx.trade) [this.fact, this.spot] = b.ctx.trade;      // what the bot knows may have sharpened
    if (!this.fact || !this.spot) return;
    const pt = factPoint(this.fact);
    if (now < this.wait) {
      b.look(pt, dt, 0.9);
      return;
    }
    if (b.peek.exposedTo(pt)) {
      b.look(pt, dt, 1.0);
      if (b.precise(this.fact, now) && b.canPrefire()) b.shooter.prefire(pt, this.fact, dt, now);
      return;
    }
    // swing from where the teammate died: the killer was in sight from there
    let goal = this.spot;
    if (dist3(goal, bot.position()) < 1.0) goal = [...this.fact.pos] as V3;
    b.mover.to(goal, dt, `trade:${Math.round(goal[0])}:${Math.round(goal[1])}`, false, [], pt, true);
  }
}

class Investigate extends Action {
  override name = "alert";
  override minTime = 0.5;
  key: string | null = null;
  holdUntil = 0;

  override score(ctx: Ctx): number {
    if (ctx.target) return 0;
    const f = ctx.fact ?? ctx.lost;
    if (!f) return 0;
    if (this.b.swinging(ctx.now)) return 0.95;            // our flash is popping: go now
    const age = ctx.now - f.time;
    if (age > 6.0) return 0;
    return 0.55 + 0.25 * Math.max(0, 1.0 - age / 4.0) + (ctx.holding ? 0.1 : 0);
  }

  override run(dt: number, now: number): void {
    const b = this.b;
    const bot = b.bot;
    const f = b.ctx.fact ?? b.ctx.lost;
    if (!f) {
      (b.actions.task as DoTask).run(dt, now);
      return;
    }
    const look = b.preaim(f, now);
    const t = b.task;
    if (b.swinging(now) && b.swing) {
      // swing wide onto the corner while they are blind
      const goal: V3 = [...b.swing[0].pos] as V3;
      b.mover.to(goal, dt, `swing:${Math.round(goal[0])}:${Math.round(goal[1])}`, false, [], look, true);
      return;
    }
    if (b.ctx.holding) {
      bot.intent.crouch = t.crouch;
      b.look(look, dt, 0.8);
      return;
    }
    const key = `${pyRound(f.pos[0] / 6)}:${pyRound(f.pos[1] / 6)}`;
    if (key !== this.key) {
      // new information close by: stop and hold the angle for a moment (the patient ones longer); a distant
      // or vague callout only turns the crosshair
      this.key = key;
      const p = bot.position();
      const d = Math.hypot(f.pos[0] - p[0], f.pos[1] - p[1]);
      const near = d < (f.source === "radio" ? 12.0 : 20.0);
      this.holdUntil = now + (near ? bot.rng.uniform(0.6, 1.2) + 1.0 * b.traits.patience : 0);
    }
    const pushing = b.traits.aggression > 0.6 && (f.source === "sound" || f.source === "radio") && b.ctx.allies >= b.ctx.enemies;
    if (pushing && dist3(f.pos, bot.position()) > 6.0) {
      const goal: V3 = [...f.pos] as V3;
      b.mover.to(goal, dt, `push:${Math.round(goal[0])}:${Math.round(goal[1])}`, true, [], look);
      return;
    }
    const hurry = ["rush", "retake", "flee", "plant"].includes(t.tag) || (b.ctx.timeLeft ?? 99) < 30.0;
    if (t.kind !== "idle" && !b.arrived && (now >= this.holdUntil || hurry)) {
      (b.actions.task as DoTask).run(dt, now, look);   // carry on, crosshair on the threat
      bot.intent.walk = !hurry;
      return;
    }
    b.look(look, dt, 0.8);
    bot.intent.walk = true;
  }
}

class Reposition extends Action {
  override name = "reposition";
  override minTime = 1.0;
  spot: V3 | null = null;

  override score(ctx: Ctx): number {
    const b = this.b;
    if ((ctx.target && !(ctx.stale || ctx.outranged)) || b.repositionT < 0 || ctx.now - b.repositionT > 6.0) return 0;
    if (this.spot) return 0.8;
    if (!ctx.holding) return 0;
    return 0.74 - 0.2 * b.traits.aggression;
  }

  override start(ctx: Ctx, now: number): void {
    super.start(ctx, now);
    this.spot = this.b.newHoldSpot();
    if (!this.spot) this.b.repositionT = -1;
  }

  override run(dt: number, now: number): void {
    const b = this.b;
    if (!this.spot) {
      b.repositionT = -1;
      return;
    }
    if (b.mover.to(this.spot, dt, `repos:${this.spot[0].toFixed(1)}:${this.spot[1].toFixed(1)}`)) {
      b.task.pos = [...this.spot] as V3;
      b.arrived = true;
      b.arriveT = now;
      this.spot = null;
      b.repositionT = -1;
    }
  }
}

class Avoid extends Action {
  override name = "avoid";
  override minTime = 0.2;

  override score(ctx: Ctx): number {
    if (!ctx.incoming) return 0;
    return ctx.incoming[0] === "flash" ? 1.25 : 1.1;
  }

  override run(dt: number, _now: number): void {
    const b = this.b;
    const bot = b.bot;
    const g = b.ctx.incoming;
    if (!g) return;
    const [kind, pos] = g;
    if (kind === "flash") {
      // look away: turn the back to the grenade
      const eye = bot.eye();
      b.look([eye[0] - (pos[0] - eye[0]), eye[1] - (pos[1] - eye[1]), eye[2]], dt, 1.0);
    } else {
      const d = flat(sub3(bot.position(), pos));
      if (d[0] * d[0] + d[1] * d[1] > 1e-4) bot.intent.wish = unit2(d);
    }
  }
}

class Throw extends Action {
  override name = "throw";
  override minTime = 0.3;
  override score(ctx: Ctx): number { return !this.b.throw || ctx.target ? 0 : 0.9; }
  override run(dt: number, now: number): void { if (!this.b.doThrow(dt, now)) this.b.throw = null; }
}

class DoTask extends Action {
  override name = "task";
  override minTime = 0;

  override score(ctx: Ctx): number {
    const b = this.b;
    if (b.committedObjective(ctx.now)) return 1.3;
    const kind = b.task.kind;
    if ((kind === "plant" || kind === "defuse") && !ctx.target) {
      // the objective comes first when nobody is in sight
      const here = kind === "plant" ? b.director.siteAt(b.bot.position()) !== null
        : dist3(b.director.bomb.pos, b.bot.position()) < 6.0;
      return here ? 0.97 : 0.7;
    }
    return 0.5;
  }

  override run(dt: number, now: number, lookOverride: V3 | null = null): void {
    const b = this.b;
    const c = b.ctx.target;
    if (!lookOverride && c && c.seen && (b.arrived || !b.task.pos)) lookOverride = [c.pos[0], c.pos[1], c.pos[2] + 1.45];   // keep an eye on it
    b.runTask(dt, now, lookOverride);
  }
}

const pyRound = (x: number) => { const r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r; };

// ------------------------------------------------------------------- brain
export class BrainV2 {
  bot: BotAgent;
  rng: Random;
  traits: Traits;
  human: Humanizer;
  knowledge: BotKnowledge;
  perception: Perception;
  follower: FollowerV2;
  biasKey: number;
  mover: Mover;
  aimPolicy: AimPolicy;
  shooter: Shooter;
  peek: PeekHelper;
  actions: Record<string, Action>;
  task = new Task();
  mode = "task";
  action!: Action;
  scores: Array<[string, number]> = [];
  nextThink = 0;
  target: Contact | null = null;
  ctx = new Ctx();
  arrived = false;
  arriveT = 0;
  plantT = 0;
  defuseT = 0;
  useT = 0;
  lean = 0;
  leanCheck = 0;
  gadgetTarget: Deployable | null = null;
  deferred: Task | null = null;
  throw: ThrowOrder | null = null;
  flashedUntil = 0;
  lastHitT = -10;
  callT = -10;
  radarT = 0;
  repositionT = -1;
  killT = -10;
  dealtT = -10;
  ignore = new Map<number, number>();
  nadeT = 0;
  swing: [Fact, number | null] | null = null;
  frozenUntil = 0;
  debug = "";
  private preaimKey: string | null = null;
  private preaimPt: V3 | null = null;
  private preaimUntil = 0;
  private dangerCache: [string | null, number, number] = [null, 0, 0];
  private walkT = -1;
  private walkVal = false;
  private spaceN = 0;
  private spaceStep: V3 | null = null;
  private lockedYaw: number | null = null;

  constructor(bot: BotAgent, team: TeamStrategy) {
    this.bot = bot;
    this.rng = bot.rng;
    this.traits = traitsFor(bot.name, bot.game.director?.seed ?? bot.traitsSeed);
    this.human = bot.human;
    this.knowledge = bot.knowledge;
    this.perception = bot.perception;
    this.follower = new FollowerV2(team.nav, team.paths);
    this.biasKey = 1 + bot.rng.randrange(3);
    this.follower.biasKey = this.biasKey;
    this.mover = new Mover(this);
    this.aimPolicy = new AimPolicy(this);
    this.shooter = new Shooter(this);
    this.peek = new PeekHelper(this);
    const list = [Fight, FallBack, Reload, Trade, Investigate, Reposition, Avoid, Throw, DoTask].map((C) => new C(this));
    this.actions = Object.fromEntries(list.map((a) => [a.name, a]));
    this.reset();
  }

  /** The bot's current team strategy (it follows the side at halftime). */
  get team(): TeamStrategy { return this.bot.game.director.brainOf(this.bot.side) as TeamStrategy; }
  get director() { return this.bot.game.director; }
  get tm(): TacticalMap { return this.team.tm; }
  get nav(): NavMesh { return this.team.nav; }
  get paths(): PathService { return this.team.paths; }
  get followerActive(): boolean { return this.follower.active; }

  reset(): void {
    this.task = new Task();
    this.mode = "task";
    this.action = this.actions.task;
    this.scores = [];
    this.nextThink = 0;
    this.target = null;
    this.ctx = new Ctx();
    this.arrived = false;
    this.arriveT = 0;
    this.plantT = 0;
    this.defuseT = 0;
    this.useT = 0;
    this.lean = 0;
    this.leanCheck = 0;
    this.gadgetTarget = null;
    this.deferred = null;
    this.throw = null;
    this.flashedUntil = 0;
    this.lastHitT = -10;
    this.callT = -10;
    this.radarT = 0;
    this.repositionT = -1;
    this.killT = -10;
    this.dealtT = -10;
    this.ignore = new Map();
    this.nadeT = 0;
    this.swing = null;
    this.frozenUntil = 0;
    this.debug = "";
    this.knowledge.reset();
    this.human.reset();
    this.shooter.reset();
    this.mover.reset();
    this.aimPolicy.reset();
    this.perception.busyWith = null;
    for (const a of Object.values(this.actions)) a.started = -1;
    this.preaimKey = null;
    this.preaimPt = null;
    this.preaimUntil = 0;
    this.dangerCache = [null, 0, 0];
    this.walkT = -1;
    this.walkVal = false;
    this.spaceN = 0;
    this.spaceStep = null;
  }

  // -------------------------------------------------------------- orders
  setTask(task: Task, force = false): void {
    if (!force && BREACH_TAGS.includes(this.task.tag) && !BREACH_TAGS.includes(task.tag)) {
      this.deferred = task;
      return;
    }
    task.issued = this.bot.now;
    this.task = task;
    this.mover.goalKey = null;
    this.arrived = false;
    this.plantT = 0;
    this.defuseT = 0;
    this.useT = 0;
  }

  nextTask(): void {
    let nxt: Task | null = typeof this.task.then === "function" ? this.task.then(this.bot) : this.task.then;
    if (this.deferred && !(nxt instanceof Task && BREACH_TAGS.includes(nxt.tag))) {
      nxt = this.deferred;
      this.deferred = null;
    }
    this.setTask(nxt instanceof Task ? nxt : new Task("idle"), true);
  }

  orderThrow(key: string, target: V3, within = 6.0): boolean {
    if ((this.bot.weapons.inv.grenades[key] ?? 0) <= 0) return false;
    this.throw = new ThrowOrder(key, [...target] as V3, this.bot.now + within);
    return true;
  }

  describe(): string {
    const t = this.task;
    const top = this.scores.slice(0, 3).map(([n, s]) => `${n}:${s.toFixed(2)}`).join(" ");
    return `${this.mode}/${t.kind}${t.tag ? ":" + t.tag : ""} [${this.team.roleOf(this.bot)}] ${top} ${this.debug}`;
  }

  // -------------------------------------------------------------- events
  onDamaged(res: DamageResult): void {
    const bot = this.bot;
    const now = bot.now;
    const attacker = this.director.agentOf(res.info.attacker);
    if (!attacker || attacker.side === bot.side) return;
    this.lastHitT = now;
    this.human.addStress(0.35);
    const c = this.perception.contacts.get(attacker.uid);
    if (!c || !c.seen) {
      if (res.info.kind !== "explosion") this.knowledge.onShot(res.info.direction, now);
      if (this.human.mistake("panic")) this.frozenUntil = now + this.rng.uniform(0.3, 0.7);   // flinches before it acts
      if (this.ctx.holding) this.repositionT = now;
    }
    this.nextThink = 0;
  }

  onSpotted(_enemy: Soldier): void { this.nextThink = Math.min(this.nextThink, this.bot.now + 0.02); }

  onHeard(_enemy: Soldier, _pos: V3, _loudness: number): void {
    if (this.action.name === "task" || this.action.name === "hold") this.nextThink = Math.min(this.nextThink, this.bot.now + 0.05);
  }

  onFlashed(duration: number): void {
    this.flashedUntil = this.bot.now + duration;
    this.human.addStress(0.3);
    this.bot.aim.release();
  }

  onFired(): void { this.shooter.onFired(); }

  /** Hit markers: this bot's shot hurt someone - the enemy it was shooting at. */
  onHits(results: DamageResult[]): void {
    const key = this.shooter.targetId;
    if (key === null) return;
    this.dealtT = this.bot.now;
    for (const r of results) this.knowledge.onHitEnemy(key, r.info.amount);
  }

  /** This bot killed an enemy. */
  onKill(victim: Soldier): void {
    this.killT = this.bot.now;
    this.knowledge.forget(victim.uid);
    if (this.ctx.holding) this.repositionT = this.bot.now;
  }

  // ---------------------------------------------------------------- tick
  update(dt: number, now: number, locked: boolean): void {
    const bot = this.bot;
    const it = bot.intent;
    it.wish = [0, 0, 0];
    it.walk = it.crouch = it.jump = false;
    it.trigger = false;
    const team = this.team;
    team.tick(now);
    if (this.follower.service !== team.paths) {
      this.follower.service = team.paths;           // sides swapped at halftime
      this.follower.nav = team.nav;
    }
    this.perception.update(now, team.enemies());
    this.human.update(dt);
    if (locked) {
      this.lockedLook(dt, now);
      return;
    }
    // re-score every 0.11-0.16 s; at most a few of the team in one tick
    if (now >= this.nextThink && team.thinkSlot(now)) {
      this.nextThink = now + this.rng.uniform(0.11, 0.16);
      this.think(now);
    }
    if (now < this.flashedUntil) {
      this.flashed();
      return;
    }
    if (now < this.frozenUntil) return;               // panicked for a moment
    this.action.run(dt, now);
    // standing on a teammate: checked 16 times a second, and the step apart held in between
    this.spaceN++;
    if (it.wish[0] * it.wish[0] + it.wish[1] * it.wish[1] < 0.01) {
      if (this.spaceN % 4 === 0) this.spaceStep = this.personalSpace();
      if (this.spaceStep) {
        it.wish = [...this.spaceStep] as V3;
        it.walk = true;
      }
    } else this.spaceStep = null;
    this.shootGadget(dt, now);
    this.chooseLean(now);
  }

  think(now: number): void {
    const ctx = this.context(now);
    this.ctx = ctx;
    const noise = this.human.noise();
    const scores: Array<[string, number]> = [];
    for (const [name, a] of Object.entries(this.actions)) {
      let s = a.score(ctx);
      if (s <= 0) continue;
      if (a === this.action) s += now - a.started >= a.minTime ? 0.08 : 0.25;
      else if (name !== "engage" && name !== "avoid" && name !== "task") s += this.rng.gauss(0.0, noise * 0.05);
      scores.push([name, s]);
    }
    // a stable sort by score, highest first (ties keep the action order)
    scores.sort((x, y) => y[1] - x[1]);
    this.scores = scores;
    const best = scores.length ? this.actions[scores[0][0]] : this.actions.task;
    if (best !== this.action) {
      this.action.stop();
      this.action = best;
      best.start(ctx, now);
    }
    this.mode = best.name;
    this.target = ctx.target;
    if (this.shooter.targetId !== null && best.name !== "engage") this.shooter.release();
    this.comms(ctx, now);
    this.considerUtility(ctx, now);
  }

  /** The bot's own grenades: a pop-flash over the corner a fresh fact puts an enemy behind (then swing while
   * it is blind), or a frag onto an enemy that is not moving off. */
  private considerUtility(ctx: Ctx, now: number): void {
    if (this.throw || ctx.target || now < this.nadeT) return;
    const f = ctx.fact;
    if (!f || f.source === "damage" || now - f.time > 2.5 || f.radius > 5.0) return;
    const bot = this.bot;
    const pos = bot.position();
    const d = Math.hypot(f.pos[0] - pos[0], f.pos[1] - pos[1]);
    if (d < 6.0 || d > 30.0) return;
    this.nadeT = now + 2.5;
    if (bot.game.world.ray(bot.eye(), factPoint(f, 1.4), MASK_SIGHT) === null) return;   // in plain view: for the gun
    if (this.team.recentNade(f.pos, now)) return;      // a teammate just threw there
    const inv = bot.weapons.inv.grenades;
    const u = this.traits.utility;
    if ((inv.flash ?? 0) > 0 && this.rng.random() < 0.3 + 0.5 * u && !this.human.mistake("skip_corner")) {
      if (this.orderThrow("flash", [f.pos[0], f.pos[1], f.pos[2] + 2.2], 2.0)) {
        this.swing = [f, null];
        this.team.nadeAt(f.pos, now);
        this.say("Flashing!", "popflash", 4.0);
      }
    } else if ((inv.frag ?? 0) > 0 && d > 9.0 && this.rng.random() < 0.25 + 0.5 * u) {
      if (this.orderThrow("frag", [f.pos[0], f.pos[1], f.pos[2] + 0.3], 2.0)) this.team.nadeAt(f.pos, now);
    }
  }

  /** Our own flash just popped (or is about to) over the corner: time to peek. */
  swinging(now: number): boolean {
    const sw = this.swing;
    if (!sw || sw[1] === null) return false;
    if (now > sw[1] + 3.2) {
      this.swing = null;
      return false;
    }
    return now >= sw[1] + 1.3;
  }

  private context(now: number): Ctx {
    const bot = this.bot;
    const ctx = new Ctx();
    ctx.now = now;
    ctx.hp = bot.damageable.health;
    const ws = bot.weapons.inv.current();
    ctx.ws = ws;
    if (ws && ws.d.magazine > 0) {
      ctx.mag = ws.ammo / ws.d.magazine;
      ctx.empty = ws.ammo === 0;
    }
    const per = this.perception;
    const team = this.team;
    for (const f of this.knowledge.fromPerception(now)) team.radarReport(f);
    for (const f of this.knowledge.popHeard()) team.onHeard(bot, f, now);
    const vis = [...per.contacts.values()].filter((c) => c.seen && c.agent.alive && now >= c.reactAt);
    ctx.visible = vis;
    ctx.target = this.pickTarget(vis);
    const pos = bot.position();
    if (!ctx.target) {
      let best: Contact | null = null;
      for (const c of per.contacts.values()) {
        if (c.agent.alive && !c.seen && c.source === "sight" && now - c.time < 3.0 && (!best || c.time > best.time)) best = c;
      }
      if (best) ctx.lost = new Fact(best.agent.uid, [best.pos[0], best.pos[1], best.pos[2]], 0.5, best.time, "sight");
    }
    if (ctx.target) ctx.threat = [...ctx.target.pos] as V3;
    else if (ctx.lost) ctx.threat = [...ctx.lost.pos] as V3;
    ctx.threatDist = ctx.threat ? dist3(ctx.threat, pos) : 99.0;
    ctx.timeLeft = this.director.match.roundTimeLeft();
    if (ctx.target && ws) {
      const limit = RANGE_LIMIT[ws.d.cls];
      if (limit !== undefined && ctx.threatDist > limit && now - this.lastHitT > 2.0) ctx.outranged = true;
    }
    ctx.stale = this.isStale(ctx, now);
    if (ctx.outranged && this.ctx.holding && this.repositionT < 0) this.repositionT = now;   // move off this spot
    ctx.point = this.tm.nearest(pos);
    ctx.allies = team.aliveBots().length + team.humansAlive();
    ctx.enemies = team.enemiesAlive;
    ctx.exposure = this.exposure(ctx.point);
    ctx.dangerHere = this.dangerNear(pos, 15.0);
    // radar glance (never mid-fight)
    if (!ctx.target && now >= this.radarT) {
      this.radarT = now + this.human.radarInterval();
      this.knowledge.radar(now, team.reports.slice(-30));
    }
    ctx.fact = this.relevantFact(now, pos);
    ctx.trade = team.tradeFact(bot, now);
    ctx.cover = ctx.threat ? this.findCover(ctx.threat) : null;
    ctx.incoming = this.incoming();
    ctx.bomb = this.director.bomb.state;
    const t = this.task;
    ctx.holding = (t.kind === "hold" || t.kind === "guard") && this.arrived;
    return ctx;
  }

  /** A visible enemy not worth fighting right now: a long-range duel in which neither side lands anything,
   * or one far off while the bot has a charge to plant in little time. */
  private isStale(ctx: Ctx, now: number): boolean {
    const c = ctx.target;
    if (!c || ctx.outranged) return false;
    const key = c.agent.uid;
    const d = ctx.threatDist;
    if (now - this.lastHitT < 2.0) return false;      // being shot: fight back (or take close cover)
    if (now < (this.ignore.get(key) ?? 0) && d > 18.0) return true;
    const engaged = this.shooter.targetId === key ? now - this.shooter.engagedSince : 0;
    if (d > 25.0 && engaged > 3.0 && now - this.dealtT > 3.0) {
      this.ignore.set(key, now + this.rng.uniform(4.0, 7.0));
      if (this.ctx.holding || this.task.wait) this.repositionT = now;
      return true;
    }
    return this.task.kind === "plant" && d > 15.0 && (ctx.timeLeft ?? 99) < 35.0;
  }

  private pickTarget(vis: Contact[]): Contact | null {
    if (!vis.length) return null;
    const me = this.bot.position();
    let best: Contact | null = null, bestS = -1;
    for (const c of vis) {
      const d = Math.max(dist3(c.pos, me), 1.0);
      let s = 10.0 / (d + 6.0);
      const e = c.agent;
      const fwd = e.forward();
      const toMe = flat(sub3(me, c.pos));
      if (toMe[0] * toMe[0] + toMe[1] * toMe[1] > 1e-4) {
        const u = unit2(toMe);
        if (fwd[0] * u[0] + fwd[1] * u[1] > 0.85) s *= 1.8;     // it is aiming at me
      }
      if (this.knowledge.hurt(e.uid)) s *= 1.3;
      if (e.uid === this.shooter.targetId) s *= 1.6;           // stay on the current target
      if (s > bestS) { best = c; bestS = s; }
    }
    return best;
  }

  private relevantFact(now: number, pos: V3): Fact | null {
    let best: Fact | null = null, bs = 0;
    for (const f of this.knowledge.recent(6.0, now)) {
      if (f.source === "sight") continue;
      const d = Math.hypot(f.pos[0] - pos[0], f.pos[1] - pos[1]);
      if (d > 35.0) continue;
      const s = (1.0 - (now - f.time) / 6.0) * (1.0 / (1.0 + d / 15.0));
      if (s > bs) { best = f; bs = s; }
    }
    return best;
  }

  /** A grenade in flight the bot can see: [kind, position] or null. */
  private incoming(): [string, V3] | null {
    const bot = this.bot;
    const eye = bot.eye();
    const fwd = bot.viewDir();
    for (const g of bot.game.grenades) {
      if (g.detonated || g.done || (g.d.key !== "flash" && g.d.key !== "frag")) continue;
      const p = g.pos;
      const v = sub3(p, eye);
      const dist = Math.hypot(v[0], v[1], v[2]);
      if (dist > 22.0 || dist < 0.3) continue;
      if ((v[0] * fwd[0] + v[1] * fwd[1] + v[2] * fwd[2]) / dist < 0.35) continue;
      if (bot.game.world.ray(eye, p, MASK_SIGHT) !== null) continue;
      if (g.d.key === "flash" && g.age > 0.5) return ["flash", [...p] as V3];
      if (g.d.key === "frag" && dist < 7.0 && g.age > 0.4) return ["frag", [...p] as V3];
    }
    return null;
  }

  private comms(ctx: Ctx, now: number): void {
    if (ctx.target && now - this.callT > 1.5) {
      this.callT = now;
      this.team.onSighting(this.bot, ctx.target, now);
    }
  }

  // ---------------------------------------------------------- knowledge
  /** Expected enemies that could see this point right now (team possibility field). */
  exposure(point: number): number {
    if (point < 0) return 0;
    const danger = this.team.danger();
    const vis = this.tm.visibleMask(point);
    let s = 0;
    for (let i = 0; i < vis.length; i++) if (vis[i]) s += danger[i];
    return s;
  }

  dangerNear(pos: V3, radius: number): number {
    const [key, t, val] = this.dangerCache;
    const k = `${pyRound(pos[0])}:${pyRound(pos[1])}:${pyRound(radius)}`;
    if (key === k && this.bot.now - t < 0.3) return val;
    const idx = this.tm.pointsNear(pos, radius);
    let v = 0;
    if (idx.length) {
      const danger = this.team.danger();
      for (const i of idx) v += danger[i];
    }
    this.dangerCache = [k, this.bot.now, v];
    return v;
  }

  /** Walk (quiet, accurate) close to where enemies probably are; re-decided every 0.1 s. */
  shouldWalk(pos: V3): boolean {
    const now = this.bot.now;
    if (now - this.walkT < 0.1) return this.walkVal;
    this.walkT = now;
    this.walkVal = this.computeWalk(pos);
    return this.walkVal;
  }

  private computeWalk(pos: V3): boolean {
    const t = this.task;
    if (["rush", "flee", "retake"].includes(t.tag) || this.team.plan === "rush") return false;
    const left = this.ctx.timeLeft;
    if (left !== null && left < 30.0) return false;
    const now = this.bot.now;
    for (const f of this.knowledge.recent(4.0, now)) {
      if (f.source !== "damage" && Math.hypot(f.pos[0] - pos[0], f.pos[1] - pos[1]) < 20.0) return true;
    }
    return this.dangerNear(pos, 15.0) > 0.08 + 0.15 * this.traits.aggression;
  }

  /** Head-height point where an enemy would most likely come into view: the visible corners and doorways
   * (tactical points next to hidden ones), weighted by how many enemies the team's picture puts in the hidden
   * places behind them - crosshair placement. Recent callouts and sounds count extra. */
  likelyPoint(pos: V3, fwd: V3 | null, maxRange: number, cone: number, second = false, minWeight = 0,
    focus: V3 | null = null): [V3, V3 | null] | null {
    const tm = this.tm;
    const i = tm.nearest(pos);
    if (i < 0) return null;
    let danger = this.team.danger();
    const now = this.bot.now;
    let extra: Float64Array | null = null;
    for (const f of this.knowledge.recent(5.0, now)) {
      if (f.source === "sound" || f.source === "radio" || f.source === "radar" || f.source === "intel") {
        const j = tm.nearest(f.pos);
        if (j >= 0) {
          if (!extra) extra = danger.slice();
          extra[j] += 2.0;
        }
      }
    }
    if (extra) danger = extra;
    const n = tm.n;
    const vis = tm.visibleMask(i);
    const w = new Float64Array(n);
    const src = tm.edgeSrc, dst = tm.edgeDst;
    for (let e = 0; e < src.length; e++) if (vis[src[e]] && !vis[dst[e]]) w[src[e]] += danger[dst[e]];
    const cc = fwd && cone < 360 ? Math.cos(cone * 0.5 * Math.PI / 180) : 0;
    let any = false;
    for (let k = 0; k < n; k++) {
      w[k] += danger[k] * vis[k];
      const dx = tm.xy[k * 2] - pos[0], dy = tm.xy[k * 2 + 1] - pos[1];
      const dist = Math.sqrt(dx * dx + dy * dy);
      w[k] *= (dist <= maxRange && dist > 1.5 ? 1 : 0) / (1.0 + dist / 20.0);
      if (focus) {
        const fd = Math.hypot(tm.xy[k * 2] - focus[0], tm.xy[k * 2 + 1] - focus[1]);
        w[k] *= 1.0 + 3.0 * Math.exp(-fd / 4.0);
        w[k] += 0.02 * vis[k] * Math.exp(-fd / 2.0);
      }
      if (fwd && cone < 360.0) {
        const cosang = (dx * fwd[0] + dy * fwd[1]) / (dist + 1e-6);
        if (!(cosang >= cc)) w[k] = 0;
      }
      if (w[k] !== 0) any = true;
    }
    if (!any) return null;
    // the two largest weights (the highest index wins ties, like a reversed ascending argsort)
    let o0 = -1, o1 = -1;
    for (let k = 0; k < n; k++) {
      if (o0 < 0 || w[k] >= w[o0]) { o1 = o0; o0 = k; }
      else if (o1 < 0 || w[k] >= w[o1]) o1 = k;
    }
    if (w[o0] < minWeight) return null;
    const p1 = tm.pl[o0];
    const a: V3 = [p1[0], p1[1], p1[2] + 1.55];
    if (!second) return [a, null];
    if (o1 >= 0 && w[o1] > w[o0] * 0.6) {
      const p2 = tm.pl[o1];
      return [a, [p2[0], p2[1], p2[2] + 1.55]];
    }
    return [a, null];
  }

  /** Where an enemy at fact f will come into view: the last visible corner of the walk towards it. */
  preaim(f: Fact, now: number): V3 {
    const key = `${pyRound(f.pos[0])}:${pyRound(f.pos[1])}`;
    if (key === this.preaimKey && now < this.preaimUntil && this.preaimPt) return this.preaimPt;
    const bot = this.bot;
    const eye = bot.eye();
    const world = bot.game.world;
    let point = factPoint(f, 1.55);
    if (world.ray(eye, point, MASK_SIGHT) !== null) {
      const path = this.paths.request(bot.position(), f.pos, 0);
      if (path !== null && path !== PENDING) {
        for (const corner of path.slice(1)) {
          const q: V3 = [corner[0], corner[1], corner[2] + 1.55];
          if (world.ray(eye, q, MASK_SIGHT) !== null) break;
          point = q;
        }
      }
    }
    this.preaimKey = key;
    this.preaimPt = point;
    this.preaimUntil = now + 0.8;
    return point;
  }

  /** Nearest walkable tactical point within 6 m that the threat cannot see (standing), checked with a ray. */
  findCover(threat: V3): [V3, number] | null {
    const tm = this.tm;
    const pos = this.bot.position();
    const ti = tm.nearest(threat);
    if (ti < 0) return null;
    const near = tm.pointsNear(pos, 6.0, 1.0);
    if (!near.length) return null;
    const seenBy = tm.visibleMask(ti);
    const cand = near.filter((i) => !seenBy[i]);
    if (!cand.length) return null;
    cand.sort((a, b) => Math.hypot(tm.pl[a][0] - pos[0], tm.pl[a][1] - pos[1]) - Math.hypot(tm.pl[b][0] - pos[0], tm.pl[b][1] - pos[1]));
    const world = this.bot.game.world;
    const teye: V3 = [threat[0], threat[1], threat[2] + 1.6];
    for (const i of cand.slice(0, 4)) {
      const p = tm.pl[i];
      if (world.ray(teye, [p[0], p[1], p[2] + 1.4], MASK_SIGHT) !== null) return [[p[0], p[1], p[2]], i];
    }
    return null;
  }

  /** Another place watching the same area as the current hold (repositioning). */
  newHoldSpot(): V3 | null {
    const tm = this.tm;
    const t = this.task;
    if (!t.pos) return null;
    const here = tm.nearest(t.pos);
    if (here < 0) return null;
    const site = tm.siteName(here);
    let opts = site ? tm.holds(site).map((h) => h.i) : [];
    if (!opts.length) opts = tm.pointsNear(t.pos, 9.0).filter((i) => tm.cover[i]);
    const mates = this.team.matesOf(this.bot).map((m) => m.brain?.task.pos).filter((p): p is V3 => !!p);
    let best: V3 | null = null, bs = -1e9;
    for (const i of opts) {
      const p = tm.pl[i];
      const d = Math.hypot(p[0] - t.pos[0], p[1] - t.pos[1]);
      if (d < 3.0 || d > 14.0) continue;
      if (mates.some((m) => Math.hypot(p[0] - m[0], p[1] - m[1]) < 3.0)) continue;
      const s = -d * 0.2 + this.rng.random();
      if (s > bs) { best = [p[0], p[1], p[2]]; bs = s; }
    }
    return best;
  }

  precise(f: Fact, now: number): boolean { return f.radius <= 2.5 && now - f.time <= 1.6; }

  canPrefire(): boolean {
    const diff = this.bot.difficulty;
    return diff === "hard" || diff === "expert" || (diff === "normal" && this.traits.aggression > 0.5);
  }

  // ------------------------------------------------------------ helpers
  look(point: V3, dt: number, speed = 0.7): void { this.bot.aim.lookAt(this.bot.eye(), point, dt, speed); }

  dirTo(p: V3): V3 {
    const d = flat(sub3(p, this.bot.position()));
    return d[0] * d[0] + d[1] * d[1] > 1e-4 ? unit2(d) : [0, 0, 0];
  }

  targetDistance(): number {
    const c = this.ctx.target;
    return c ? dist3(c.pos, this.bot.position()) : 15.0;
  }

  teammateInLine(eye: V3, point: V3): boolean { return teammateInLine(this.bot, eye, point); }

  atDoor(pos: ArrayLike<number>): boolean {
    const i = this.tm.nearest(pos);
    if (i < 0 || !(this.tm.kind[i] & 1)) return false;
    const p = this.tm.pl[i];
    return Math.hypot(p[0] - pos[0], p[1] - pos[1]) < 1.2;
  }

  say(text: string, key: string | null = null, every = 4.0): void { this.team.radioSay(this.bot, text, key, every); }

  reloadIf(frac: number): void {
    const ws = this.bot.weapons.inv.current();
    if (ws && ws.d.magazine > 0 && ws.ammo < ws.d.magazine * frac && !ws.reloading && ws.reserve > 0) ws.startReload(this.bot.now);
  }

  ensureWeapon(dist: number): void {
    const w = this.bot.weapons;
    const inv = w.inv;
    const ws = inv.current();
    const prim = w.primary, sec = w.secondary;
    const usable = (x: WeaponState | null): x is WeaponState => x !== null && (x.ammo > 0 || x.reserve > 0);
    if (!ws || ws.d.fireMode === "melee" || inv.slot === "grenade" || inv.slot === "bomb") {
      if (usable(prim)) w.select("primary");
      else if (usable(sec)) w.select("secondary");
      else if (inv.slot !== "melee") w.select("melee");
      return;
    }
    if (ws === prim && ws.ammo === 0 && usable(sec) && sec.ammo > 0 && dist < 25) w.select("secondary");   // faster than a reload
    else if (ws.ammo === 0 && ws.reserve === 0) {
      if (ws === prim && usable(sec)) w.select("secondary");
      else if (!usable(prim) && !usable(sec)) w.select("melee");
    }
  }

  committedObjective(_now: number): boolean {
    const timers = this.director.rules.timers;
    if (this.task.kind === "plant" && this.plantT > Number(timers.plant_time) * 0.75) return true;
    if (this.task.kind === "defuse" && this.defuseT > 0) {
      const total = Number(this.bot.hasKit ? timers.defuse_time_kit : timers.defuse_time);
      const left = this.director.match.bombTimeLeft();
      return left < total - this.defuseT + 1.5 || this.defuseT > total * 0.8;
    }
    return false;
  }

  // -------------------------------------------------------------- task
  runTask(dt: number, now: number, lookOverride: V3 | null = null): void {
    const bot = this.bot;
    const t = this.task;
    bot.scoped = false;
    const kind = t.kind;
    if (kind === "plant") { this.doPlant(dt); return; }
    if (kind === "defuse") { this.doDefuse(dt); return; }
    if (t.timeout && now - t.issued > t.timeout) { this.nextTask(); return; }
    if (!t.pos) {
      this.idleLook(dt);
      this.reloadIf(0.6);
      return;
    }
    if (!this.arrived) {
      let walk: boolean | null = t.walk ? true : null;
      if (t.walkNear > 0 && dist3(t.pos, bot.position()) < t.walkNear) walk = true;
      const run = ["rush", "flee", "retake"].includes(t.tag) || (this.ctx.timeLeft !== null && this.ctx.timeLeft < 20);
      if (this.mover.to(t.pos, dt, `task:${t.id}`, walk, t.via, lookOverride, run)) {
        this.arrived = true;
        this.arriveT = now;
        this.team.onArrived(bot, t);
      }
      return;
    }
    const it = bot.intent;
    it.crouch = t.crouch;
    if (len2(sub3(t.pos, bot.position())) > 1.2) {
      this.arrived = false;
      this.mover.goalKey = null;
      return;
    }
    if (kind === "use" && t.look) {
      const rest = bot.aim.lookAt(bot.eye(), t.look, dt, 0.8);
      if (rest < 2.5) {
        this.useT += dt;
        if (this.useT >= t.actionTime) {
          this.useT = 0;
          if (!t.action || t.action(bot)) this.nextTask();
        }
      }
      return;
    }
    if (t.until && t.until(bot)) { this.nextTask(); return; }
    if (lookOverride) this.look(lookOverride, dt, 0.8);
    else this.look(this.aimPolicy.holdPoint(bot.position(), t.yaw, t.look), dt, 0.7);
    if ((kind === "hunt" || kind === "pickup") && now - this.arriveT > 1.0) this.team.taskDone(bot, t);
  }

  private idleLook(dt: number): void {
    const bot = this.bot;
    this.look(this.aimPolicy.holdPoint(bot.position(), bot.aim.yaw, null), dt, 0.35);
  }

  /** Freeze time / waiting at spawn: look around a bit. */
  private lockedLook(dt: number, now: number): void {
    const bot = this.bot;
    if (now >= this.aimPolicy.next) {
      this.aimPolicy.next = now + this.rng.uniform(1.0, 2.5);
      this.lockedYaw = wrap180(bot.aim.yaw + this.rng.uniform(-50, 50));
    }
    bot.aim.turnTowards(this.lockedYaw ?? bot.aim.yaw, 0.0, dt, 0.3);
  }

  private doPlant(dt: number): void {
    const bot = this.bot;
    const t = this.task;
    const d = this.director;
    if (!bot.weapons.inv.hasBomb) {
      this.team.taskDone(bot, t);
      return;
    }
    const site = d.siteAt(bot.position());
    if (!this.arrived) {
      const walk = t.tag === "rush" || this.team.plan === "rush" ? false : null;
      if ((t.pos && this.mover.to(t.pos, dt, `plant:${t.id}`, walk, t.via)) || (site && t.pos && dist3(t.pos, bot.position()) < 1.5)) {
        this.arrived = true;
      }
      this.plantT = 0;
      return;
    }
    if (!site || !bot.char.onGround) {
      this.arrived = false;
      this.mover.goalKey = null;
      return;
    }
    if (bot.weapons.inv.slot !== "bomb") bot.weapons.select("bomb");
    bot.intent.crouch = true;
    bot.aim.turnTowards(bot.aim.yaw, -35.0, dt, 0.5);
    if (this.plantT === 0) this.say(`Planting at ${site.name}!`, "plant", 5.0);
    this.plantT += dt;
    if (Math.trunc((this.plantT - dt) * 3) !== Math.trunc(this.plantT * 3)) bot.game.fx.playAt("plant_tap", bot.position(), 0.5);
    if (this.plantT >= Number(d.rules.timers.plant_time)) {
      this.plantT = 0;
      d.botPlant(bot, site);
    }
  }

  private doDefuse(dt: number): void {
    const bot = this.bot;
    const d = this.director;
    const bomb = d.bomb;
    if (bomb.state !== "planted") {
      this.team.taskDone(bot, this.task);
      return;
    }
    const to = flat(sub3(bomb.pos, bot.position()));
    if (len2(to) > 1.3 || Math.abs(bomb.pos[2] - bot.position()[2]) > 1.2) {
      this.defuseT = 0;
      this.mover.to(bomb.pos, dt, "defuse", false, [], null, true);
      return;
    }
    bot.intent.crouch = true;
    bot.aim.lookAt(bot.eye(), bomb.pos, dt);
    if (this.defuseT === 0) {
      bot.game.fx.playAt("defuse_start", bomb.pos, 0.8);
      this.say("Defusing!" + (bot.hasKit ? "" : " (no kit)"), "defuse", 5.0);
    }
    this.defuseT += dt;
    const total = Number(bot.hasKit ? d.rules.timers.defuse_time_kit : d.rules.timers.defuse_time);
    if (this.defuseT >= total) {
      this.defuseT = 0;
      d.botDefuse(bot);
    }
  }

  // ---------------------------------------------------------- grenades
  doThrow(dt: number, now: number): boolean {
    const bot = this.bot;
    const o = this.throw;
    if (!o || now > o.deadline || (bot.weapons.inv.grenades[o.key] ?? 0) <= 0) return false;
    if (!o.velocity) {
      // the target is usually round a corner or across the map: try points along the walking route towards
      // it, farthest first, until one has a clear arc (two a tick)
      if (!o.cands) {
        o.cands = this.throwCandidates(o);
        if (!o.cands) return true;             // route still being searched: keep the order
      }
      const g = bot.game.weaponDb.grenades[o.key];
      const start = bot.eye();
      const world = bot.game.world;
      for (let k = 0; k < 2; k++) {
        if (!o.cands.length) return false;
        const c = o.cands.shift() as V3;
        o.velocity = solveThrow(start, c, g.throwSpeed, world) ?? solveThrow(start, c, g.throwSpeed, world, true);
        if (o.velocity) {
          o.target = c;
          break;
        }
      }
      if (!o.velocity) return true;
      bot.weapons.inv.grenade = o.key;
      bot.weapons.select("grenade", true);
    }
    const v = o.velocity;
    const [yaw, pitch] = anglesTo(v[0], v[1], v[2]);
    const left = bot.aim.turnTowards(yaw, pitch, dt, 0.8);
    o.aimT += dt;
    if (left < 2.0 && o.aimT > 0.45 && now >= bot.weapons.grenadeReady) {
      bot.weapons.throw(o.key, v);
      if (o.key === "flash" && this.swing && this.swing[1] === null) this.swing = [this.swing[0], now];
      const names: Record<string, string> = { flash: "Flashbang out!", smoke: "Smoke out!", frag: "Frag out!" };
      this.say(names[o.key] ?? "Grenade!", "nade", 2.0);
      this.throw = null;
    }
    return true;
  }

  /** Throw targets for an order, best first: the target itself, then points every 2.5 m back along the walking
   * route to it. null while the route is still being searched. */
  private throwCandidates(o: ThrowOrder): V3[] | null {
    const bot = this.bot;
    const up = o.key === "flash" ? 2.0 : 0.3;
    const tgt: V3 = [...o.target] as V3;
    const floor: V3 = [tgt[0], tgt[1], tgt[2] - (o.key === "flash" ? 2.2 : 0.3)];
    const out: V3[] = [tgt];
    const path = this.paths.request(bot.position(), floor, 0);
    if (path === PENDING) return null;
    if (path) {
      const pts: V3[] = [];
      let acc = 0;
      const rev: Pt3[] = [...path].reverse();
      for (let i = 0; i < rev.length - 1; i++) {
        const a = rev[i], b = rev[i + 1];
        const seg = Math.hypot(a[0] - b[0], a[1] - b[1]);
        let t = acc > 0 ? 2.5 - acc : 2.5;
        while (t < seg) {
          const k = t / seg;
          pts.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k + up]);
          t += 2.5;
        }
        acc = (acc + seg) % 2.5;
      }
      const me = bot.position();
      out.push(...pts.filter((q) => dist3(q, me) > 4.0).slice(0, 10));
    }
    return out;
  }

  // ------------------------------------------------------------ misc
  private flashed(): void {
    const bot = this.bot;
    const it = bot.intent;
    const cover = this.ctx.cover;
    if (cover) {
      const d = flat(sub3(cover[0], bot.position()));
      if (d[0] * d[0] + d[1] * d[1] > 0.25) it.wish = unit2(d);
    } else {
      const f = bot.forward();
      it.wish = [-f[0] * 0.8, -f[1] * 0.8, 0];
    }
  }

  /** Standing still on top of a teammate: the step apart, or null. */
  private personalSpace(): V3 | null {
    const bot = this.bot;
    const p = bot.position();
    for (const m of this.team.matesOf(bot)) {
      const q = m.position();
      let dx = p[0] - q[0], dy = p[1] - q[1];
      let d = Math.hypot(dx, dy);
      if (d < 1.1 && Math.abs(p[2] - q[2]) < 1.2) {
        if (d < 1e-3) { dx = bot.name > m.name ? 1 : -1; dy = 0; d = 1; }
        if (this.nav.walkableLine(p, [p[0] + dx / d * 0.8, p[1] + dy / d * 0.8, p[2]])) return [dx / d * 0.6, dy / d * 0.6, 0];
        return null;
      }
    }
    return null;
  }

  private shootGadget(dt: number, now: number): void {
    const g = this.gadgetTarget;
    if (!g) return;
    if (!g.alive || this.action.name !== "task" || ["plant", "defuse", "use"].includes(this.task.kind)) {
      this.gadgetTarget = null;
      return;
    }
    const bot = this.bot;
    const eye = bot.eye();
    const point = g.center();
    if (dist3(point, eye) > 25.0) {
      this.gadgetTarget = null;
      return;
    }
    const rest = bot.aim.lookAt(eye, point, dt, 1.0);
    const ws = bot.weapons.inv.current();
    if (!ws || ws.d.fireMode === "melee") {
      this.ensureWeapon(dist3(point, eye));
      return;
    }
    if (rest < 1.2 && now >= this.shooter.pauseUntil) {
      bot.intent.trigger = true;
      bot.intent.pressed = true;
      this.shooter.pauseUntil = now + 0.18;
    }
  }

  private watchPoint(): V3 | null {
    const c = this.ctx.target;
    if (this.action.name === "engage" && c && c.seen && c.agent.alive) return c.agent.headPos();
    if ((this.action.name === "task" || this.action.name === "alert") && this.arrived && this.aimPolicy.point) return this.aimPolicy.point;
    return null;
  }

  private chooseLean(now: number): void {
    const bot = this.bot;
    const it = bot.intent;
    if (it.wish[0] * it.wish[0] + it.wish[1] * it.wish[1] > 0.04 || ["retreat", "reposition", "trade"].includes(this.action.name)
      || bot.char.horizontalSpeed > 1.6) this.lean = 0;
    else if (now >= this.leanCheck) {
      this.leanCheck = now + this.rng.uniform(0.25, 0.4);
      const point = this.watchPoint();
      if (!point) this.lean = 0;
      else {
        const c = bot.char;
        const eye: V3 = [c.pos[0], c.pos[1], c.pos[2] + c.eyeHeight];
        const world = bot.game.world;
        const free = leanClearance(world, eye, bot.aim.yaw, MASK_SIGHT);
        const r = rightOfYaw(bot.aim.yaw);
        const visible: boolean[] = [];
        for (const [sign, f] of [[-1, free[0]], [0, 1], [1, free[1]]]) {
          const k = sign * LEAN_OFFSET * f;
          visible.push(f > 0.6 && world.ray([eye[0] + r[0] * k, eye[1] + r[1] * k, eye[2]], point, MASK_SIGHT) === null);
        }
        const keep = this.action.name === "engage" && this.lean !== 0 && visible[1 + Math.trunc(this.lean)];
        if (keep) { /* stay leaned */ }
        else if (visible[1]) this.lean = 0;
        else if (visible[2] && !visible[0]) this.lean = 1;
        else if (visible[0] && !visible[2]) this.lean = -1;
        else this.lean = 0;
      }
    }
    it.lean = this.lean;
  }
}
