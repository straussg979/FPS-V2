// AI bot agent: body, movement, weapons - driven by the brain (brain.ts). A bot is a match participant like
// a player: the same character controller, inventory, gunplay (recoil patterns, movement inaccuracy, fire
// rates, reloads) and ballistics, so it obeys every rule a player does - it has to stop to shoot
// accurately, it runs out of ammo and it can be wall-banged. Only the decisions come from the brain.

import { KinematicCharacter, Lean, leanClearance, rightOfYaw } from "@cs/shared/character";
import { MASK_BULLETS, MASK_SIGHT } from "@cs/shared/collision";
import { BOTS } from "@cs/shared/data";
import { type DamageResult, damageInfo } from "@cs/shared/damage";
import { type V3, anglesToDir } from "@cs/shared/math";
import { Random } from "@cs/shared/rng";
import { type AimContext, Inventory, type WeaponState, applyOffset } from "@cs/shared/weapons";
import type { ServerGame } from "../sim/game";
import { Grenade } from "../sim/grenades";
import { Soldier, type WeaponsOwner } from "../sim/soldier";
import { AimController } from "./aim";
import type { BrainV2 } from "./brain";
import { Humanizer } from "./humanize";
import { BotKnowledge } from "./knowledge";
import { Perception } from "./perception";

/** What the brain wants this tick. */
export class Intent {
  wish: V3 = [0, 0, 0];
  walk = false;
  crouch = false;
  jump = false;
  trigger = false;
  pressed = false;
  lean = 0;                     // -1 left .. +1 right (peeking)
}

/** How long the reload clip lasts: the weapon's own reload time (shotguns: the shells). */
function reloadDuration(ws: WeaponState): number {
  const d = ws.d;
  if (d.fireMode === "pump") {
    const shells = Math.max(d.magazine - ws.ammo, 1);
    return Number(d.raw.reload_start_time ?? 0.35) + shells * Number(d.raw.reload_shell_time ?? 0.5);
  }
  return ws.reloadKind === "empty" ? d.reloadEmptyTime : d.reloadTime;
}

/** Inventory + weapon handling for a bot (the player's WeaponController without input). */
export class BotWeapons implements WeaponsOwner {
  bot: BotAgent;
  game: ServerGame;
  inv: Inventory;
  meleeNext = 0;
  grenadeReady = 0;

  constructor(bot: BotAgent) {
    this.bot = bot;
    this.game = bot.game;
    this.inv = new Inventory(bot.game.weaponDb, false, bot.rng);
  }

  giveLoadout(weapons: string[], grenades: Record<string, number> = {}): void {
    for (const k of weapons) this.inv.giveWeapon(k);
    for (const [k, n] of Object.entries(grenades)) this.inv.giveGrenade(k, n);
    this.inv.slot = "melee";
    this.select(this.inv.bestSlot(), true);
  }

  select(slot: string, force = false): void {
    const changed = this.inv.select(slot);
    if (changed || force) this.equip();
  }

  private equip(): void {
    const now = this.game.loop.time;
    const ws = this.inv.current();
    const pose = this.bot.pose;
    this.bot.anim("switch");
    if (ws) {
      ws.deploy(now);
      pose.setWeapon(ws.d.model, ws.d.cls);
    } else if (this.inv.slot === "grenade" && this.inv.grenade) {
      pose.setWeapon(this.game.weaponDb.grenades[this.inv.grenade].model, "grenade");
      this.grenadeReady = now + 0.45;
    } else if (this.inv.slot === "bomb") pose.setWeapon("bomb_charge", "bomb");
    else pose.setWeapon(null);
  }

  dropWeaponState(ws: WeaponState, throwSpeed = 3.0): void {
    ws.cancelReload();
    ws.zoomLevel = 0;
    const bot = this.bot;
    const fwd = anglesToDir(bot.aim.yaw, 0);
    const e = bot.eye();
    const v = bot.char.vel;
    this.game.pickups.spawn("weapon", ws, [e[0] + fwd[0] * 0.4, e[1] + fwd[1] * 0.4, e[2] - 0.4], bot.aim.yaw,
      [fwd[0] * throwSpeed + v[0], fwd[1] * throwSpeed + v[1], 1.0 + v[2]]);
  }

  get primary(): WeaponState | null { return this.inv.weapons.primary ?? null; }
  get secondary(): WeaponState | null { return this.inv.weapons.secondary ?? null; }

  update(dt: number, now: number, intent: Intent): void {
    const ws = this.inv.current();
    if (!ws) return;
    ws.update(now, dt);
    if (ws.d.fireMode === "melee") {
      if (intent.pressed || intent.trigger) this.melee(ws, now);
    } else if (ws.wantsShot(now, intent.trigger, intent.pressed)) this.fire(ws, now);
    for (const ev of ws.popEvents()) {
      if (ev.kind === "reload_start") this.bot.anim("reload", reloadDuration(ws));
      if (ev.kind === "reload_start" && ws.d.cls !== "shotgun") {
        const kind = ev.data?.kind === "empty" ? "empty" : "tactical";
        this.game.fx.playAt(`reload_${ws.d.key}_${kind}`, this.bot.eye(), 0.55);
      } else if (ev.kind === "shell") this.game.fx.playAt("shell_insert", this.bot.eye(), 0.5);
    }
  }

  aimContext(ws: WeaponState): AimContext {
    const c = this.bot.char;
    const scoped = !!ws.d.scope && this.bot.scoped;
    return { speed: c.horizontalSpeed, maxSpeed: c.cfg.run_speed * ws.d.speed, onGround: c.onGround, crouched: c.crouched, ads: 0, scoped };
  }

  private fire(ws: WeaponState, now: number): void {
    const bot = this.bot;
    const g = this.game;
    const eye = bot.eye();
    const offsets = ws.shotOffsets(this.aimContext(ws));
    const muzzle = bot.pose.muzzlePos();
    const tracer = ws.isTracer();
    offsets.forEach(([dx, dy], i) => {
      const [yaw, pitch] = applyOffset(bot.aim.yaw, bot.aim.pitch, dx, dy);
      const d = anglesToDir(yaw, pitch);
      const res = g.ballistics.fire(eye, d, ws.d, bot);
      if (res.damage.length && bot.brain) bot.brain.onHits(res.damage);
      for (const imp of res.impacts.slice(0, 3)) g.fx.impact(imp.pos, imp.normal, imp.surface, imp.exit);
      if ((tracer && i === 0) || (ws.d.pellets > 1 && i < 2 && bot.rng.random() < 0.3)) g.fx.tracer(muzzle, res.end);
    });
    ws.onFired(now);
    bot.anim("fire");
    g.fx.playShot(ws.d.sound, muzzle, bot);
    g.notifyNoise(eye, 1.0, 70.0, bot);
    bot.onFired();
  }

  private melee(ws: WeaponState, now: number): void {
    if (now < this.meleeNext || now < ws.drawEnd) return;
    this.meleeNext = now + 60.0 / ws.d.rpm;
    const bot = this.bot;
    const g = this.game;
    bot.anim("knife");
    const eye = bot.eye();
    const d = anglesToDir(bot.aim.yaw, bot.aim.pitch);
    const range = Number(ws.d.raw.melee_range ?? 1.6);
    g.fx.playAt("knife_swing", eye, 0.5);
    const hit = g.rayFirst(eye, [eye[0] + d[0] * range, eye[1] + d[1] * range, eye[2] + d[2] * range], MASK_BULLETS, bot);
    if (!hit) return;
    if (hit.owner && hit.owner !== bot) {
      let dmg = ws.d.damage;
      const fwd = hit.owner.forward?.();
      if (fwd && fwd[0] * d[0] + fwd[1] * d[1] + fwd[2] * d[2] > 0.5) dmg *= Number(ws.d.raw.backstab_multiplier ?? 2.8);
      const r = hit.owner.damageable.takeDamage(damageInfo({ amount: dmg, armorPenetration: ws.d.armorPenetration,
        hitgroup: hit.hitgroup || "chest", kind: "melee", attacker: bot, weapon: ws.d.key, pos: hit.pos, direction: d }));
      if (r) hit.owner.onHit?.(r, hit.pos, d);
      g.fx.impact(hit.pos, hit.normal, hit.surface || "flesh");
      g.fx.playAt("knife_hit_body", hit.pos, 1);
    } else {
      g.fx.impact(hit.pos, hit.normal, hit.surface);
      g.fx.playAt("knife_hit_wall", hit.pos, 1);
      if (hit.body?.panel !== undefined) g.destruction.meleeHit(hit.body.panel, hit.pos, d, ws.d.damage);
    }
  }

  /** Throw a grenade with the given launch velocity (the brain solves the arc). */
  throw(key: string, velocity: V3): boolean {
    if ((this.inv.grenades[key] ?? 0) <= 0) return false;
    this.inv.grenade = key;
    if (!this.inv.useGrenade()) return false;
    const bot = this.bot;
    const g = this.game.weaponDb.grenades[key];
    const fwd = anglesToDir(bot.aim.yaw, 0);
    const e = bot.eye();
    const start: V3 = [e[0] + fwd[0] * 0.3, e[1] + fwd[1] * 0.3, e[2] - 0.1];
    this.game.spawnGrenade(new Grenade(this.game, g, start, [velocity[0], velocity[1], velocity[2]], bot));
    this.game.fx.playAt("throw", start, 0.5);
    bot.anim("throw");
    this.inv.slot = "melee";
    this.select(this.inv.bestSlot(), true);
    return true;
  }
}

export class BotAgent extends Soldier {
  rng: Random;
  difficulty: string;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  profile: Record<string, any>;
  char: KinematicCharacter;
  aim: AimController;
  lean = new Lean();
  slow = 1.0;                     // razor wire
  human: Humanizer;
  knowledge: BotKnowledge;
  perception: Perception;
  weapons: BotWeapons;
  scoped = false;
  intent = new Intent();
  now = 0;
  prevYaw = 0;
  lastFired = -10;
  shotsFired = 0;
  brain: BrainV2 | null = null;
  traitsSeed: number;
  private bombClip = new Set<string>();

  constructor(game: ServerGame, name: string, side: string, difficulty: string, seed: number, matchSeed: number) {
    super(game, name, false, side);
    this.rng = new Random(seed);
    this.difficulty = difficulty;
    this.traitsSeed = matchSeed;
    this.profile = { ...(BOTS.difficulty[difficulty] ?? BOTS.difficulty.normal) };
    this.char = new KinematicCharacter(game.world);
    this.char.depenInterval = 8;
    this.char.onEvent = (ev) => {
      if (ev.kind === "land" || ev.loudness <= 0.01) return;
      game.fx.footstep(ev.surface, ev.pos, ev.loudness * 0.9, this);
      game.notifyNoise(ev.pos, ev.loudness, 28.0 * ev.loudness, this);
    };
    this.aim = new AimController(this.profile, this.rng);
    this.human = new Humanizer(this, BOTS.v2?.humanize ?? null);
    this.knowledge = new BotKnowledge(this);
    this.perception = new Perception(this, BOTS.vision ?? {}, this.profile, this.human, this.knowledge);
    this.weapons = new BotWeapons(this);
  }

  /** Called by the director once the bot is on a team. */
  attachBrain(director: import("../sim/director").MatchDirector): void {
    // the brain module is loaded lazily through the strategy to avoid an import cycle at start-up
    this.brain = director.brainOf(this.side)!.makeBrain(this);
  }

  get yaw(): number { return this.aim.yaw; }
  get pitch(): number { return this.aim.pitch; }
  get leanAmount(): number { return this.lean.amount; }

  eye(): V3 {
    const c = this.char;
    const r = rightOfYaw(this.aim.yaw);
    const o = this.lean.offset();
    return [c.pos[0] + r[0] * o, c.pos[1] + r[1] * o, c.pos[2] + c.eyeHeight];
  }

  centerOfMass(): V3 {
    const c = this.char;
    return [c.pos[0], c.pos[1], c.pos[2] + c.height * 0.62];
  }

  spawn(pos: ArrayLike<number>, yaw: number): void {
    this.char.teleport(pos);
    this.char.vel = [0, 0, 0];
    this.char.prevPos = [...this.char.pos] as V3;
    this.aim.yaw = this.prevYaw = yaw;
    this.aim.pitch = 0;
    this.aim.release();
    this.lean.reset();
    this.pose.reset();
    this.pose.animate(0, this.char.pos, yaw, 0, 0, [0, 0, 0], true);
    this.perception.reset();
    this.intent = new Intent();
    this.scoped = false;
    this.bombClip = new Set();
    this.active = true;
    this.hitEnabled = true;
    this.brain?.reset();
  }

  remove(): void {
    this.active = false;
    this.hitEnabled = false;
  }

  fixedUpdate(dt: number, now: number, locked: boolean): void {
    this.now = now;
    if (!this.active) return;
    this.prevYaw = this.aim.yaw;
    const c = this.char;
    if (!this.alive) {
      this.pose.animate(dt, c.pos, this.aim.yaw, this.aim.pitch, 0, [0, 0, 0], true);
      return;
    }
    if (this.brain) {
      this.brain.update(dt, now, locked);
      this.bombClips();
    }
    const it = this.intent;
    if (locked) {
      it.wish = [0, 0, 0];
      it.jump = false;
      it.trigger = it.pressed = false;
    }
    this.weapons.update(dt, now, it);
    const ws = this.weapons.inv.current();
    let scale = ws ? ws.d.speed : 1.0;
    if (this.scoped && ws && ws.d.scope) scale *= Number(ws.d.scope.speed ?? 0.6) / Math.max(ws.d.speed, 1e-3);
    c.step(dt, { wish: it.wish, walk: it.walk, crouch: it.crouch, jump: it.jump, speedScale: scale * this.slow });
    it.pressed = false;
    const target = locked ? 0 : it.lean;
    const free: [number, number] = target !== 0 || this.lean.amount !== 0
      ? leanClearance(this.game.world, [c.pos[0], c.pos[1], c.pos[2] + c.eyeHeight], this.aim.yaw, MASK_SIGHT) : [1, 1];
    this.lean.update(dt, target, free[0], free[1]);
    const crouch = (c.standHeight - c.height) / Math.max(c.standHeight - c.crouchHeight, 1e-3);
    this.pose.animate(dt, c.pos, this.aim.yaw, this.aim.pitch, crouch, c.vel, c.onGround, it.walk, this.lean.amount);
    this.autoPickup();
  }

  /** Planting and defusing poses while the brain's own plant or defuse timer runs. */
  private bombClips(): void {
    const b = this.brain as BrainV2;
    for (const [clip, busy] of [["plant", b.plantT > 0], ["defuse", b.defuseT > 0]] as const) {
      if (busy !== this.bombClip.has(clip)) {
        if (busy) {
          this.pose.event(clip);
          this.bombClip.add(clip);
        } else {
          this.pose.stop(clip);
          this.bombClip.delete(clip);
        }
      }
    }
  }

  override onHit(res: DamageResult, pos: V3, dir: V3): void {
    const d = dir && Math.hypot(dir[0], dir[1], dir[2]) > 1e-9 ? dir : null;
    if (!res.killed) this.anim("hit", undefined, d);
    else {
      this.die(d);
      this.dropOnDeath();
    }
    this.brain?.onDamaged(res);
  }

  private dropOnDeath(): void {
    const w = this.weapons;
    const ws = w.primary ?? w.secondary;
    if (ws) {
      w.inv.weapons[ws.d.slot] = null;
      ws.cancelReload();
      const p = this.position();
      this.game.pickups.spawn("weapon", ws, [p[0], p[1], p[2] + 0.3], this.aim.yaw,
        [this.rng.uniform(-1, 1), this.rng.uniform(-1, 1), 1.5]);
    }
    this.pose.setWeapon(null);
  }

  onFired(): void {
    this.lastFired = this.now;
    this.shotsFired++;
    this.brain?.onFired();
  }

  onSpotted(enemy: Soldier): void { this.brain?.onSpotted(enemy); }
  onHeard(enemy: Soldier, pos: V3, loudness: number): void { this.brain?.onHeard(enemy, pos, loudness); }

  flashed(duration: number, _strength: number): void {
    if (duration > 0.3) {
      this.perception.flashed(duration);
      this.brain?.onFlashed(duration);
    }
  }

  /** Walk over a weapon for an empty slot to take it (like a player). */
  private autoPickup(): void {
    for (const p of this.game.pickups.nearFeet(this.char.pos)) {
      if (p.kind !== "weapon") continue;
      let item = p.item;
      const slot = typeof item === "string" ? this.game.weaponDb.weapons[item].slot : item.d.slot;
      if (!this.weapons.inv.weapons[slot]) {
        if (typeof item === "string") item = this.weapons.inv.make(item);
        this.weapons.inv.giveWeapon(item);
        p.taken();
        if (slot === "primary" || this.weapons.inv.slot === "melee" || this.weapons.inv.slot === "secondary") this.weapons.select(slot, true);
      }
    }
  }

  describe(): string {
    const ws = this.weapons.inv.current();
    const w = ws ? ws.d.key : this.weapons.inv.slot;
    return `${this.name} [${this.side}] hp ${this.damageable.health.toFixed(0)} ${w} ${this.brain?.describe() ?? ""}`;
  }
}

export function dist2d(a: ArrayLike<number>, b: ArrayLike<number>): number { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
