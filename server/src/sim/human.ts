// A player on the server: movement (the shared PlayerMotor), weapons (WeaponController) and hit capsules,
// driven by the input commands its browser sends, applied in order. The soldier only moves when one of its
// commands is applied (as in Source): a tick without a command leaves it where it is, and late commands
// are worked off afterwards, up to four a tick. So the server applies exactly the commands the client
// predicted, never invented ones.

import { MASK_BULLETS } from "@cs/shared/collision";
import { CmdInput, type InputCmd, emptyCmd } from "@cs/shared/commands";
import { damageInfo } from "@cs/shared/damage";
import { type V3, anglesToDir } from "@cs/shared/math";
import { PlayerMotor } from "@cs/shared/motor";
import { Random } from "@cs/shared/rng";
import { type AimContext, Inventory, type WeaponState, applyOffset, throwVelocity } from "@cs/shared/weapons";
import type { ServerGame } from "./game";
import { Grenade } from "./grenades";
import type { Pickup } from "./pickups";
import { Soldier, type WeaponsOwner } from "./soldier";

const SLOT_KEYS: Array<[string, string]> = [["slot1", "primary"], ["slot2", "secondary"], ["slot3", "melee"], ["slot4", "grenade"],
  ["slot5", "bomb"]];
const ADS_TIME = 0.2;

export class HumanAgent extends Soldier {
  static MAX_QUEUE = 32;
  motor: PlayerMotor;
  weapons: WeaponController;
  input = new CmdInput();
  queue: InputCmd[] = [];
  lastCmd: InputCmd = emptyCmd();
  lastSeq = 0;
  dropped = 0;
  starved = 0;
  caughtUp = 0;
  plantT = 0;
  defuseT = 0;
  deadT = 0;
  hint = "";
  progress: [string, number] | null = null;
  userId: number | null = null;

  constructor(game: ServerGame, name: string, seed: number) {
    super(game, name, true, "");
    this.motor = new PlayerMotor(game.world);
    this.motor.char.onEvent = (ev) => game.playerStep(this, ev);
    this.weapons = new WeaponController(game, this, new Random(seed));
    this.pose.setWeapon(null);
  }

  get char() { return this.motor.char; }
  get yaw(): number { return this.motor.yaw; }
  get pitch(): number { return this.motor.pitch; }
  get leanAmount(): number { return this.motor.lean.amount; }
  eye(): V3 { return this.motor.eye(); }
  centerOfMass(): V3 { return this.motor.centerOfMass(); }

  /** A command from the client: sequence numbers must increase; at most MAX_QUEUE wait. */
  push(cmd: InputCmd): boolean {
    if (cmd.seq <= this.lastSeq || this.queue.length >= HumanAgent.MAX_QUEUE) {
      this.dropped++;
      return false;
    }
    this.lastSeq = cmd.seq;
    this.queue.push(cmd);
    return true;
  }

  apply(inp: CmdInput): void {
    this.input = inp;
    if (!this.motor.externalView) {
      this.motor.yaw = ((inp.cmd.yaw % 360) + 360) % 360;
      this.motor.pitch = Math.max(-89, Math.min(89, inp.cmd.pitch));
    }
  }

  /** This tick's commands: one normally, more while a backlog is worked off, none if nothing arrived
   * (input then keeps the last held buttons, without presses, for planting and defusing). */
  takeInputs(): CmdInput[] {
    const n = this.queue.length;
    if (n === 0) {
      const last = this.lastCmd;
      this.input = new CmdInput({ ...last, pressed: 0 });
      this.starved++;
      return [];
    }
    const k = n <= 2 ? 1 : n <= 6 ? 2 : n <= 12 ? 3 : 4;
    this.caughtUp += k - 1;
    const out: CmdInput[] = [];
    for (let i = 0; i < k; i++) {
      const cmd = this.queue.shift() as InputCmd;
      this.lastCmd = cmd;
      out.push(new CmdInput(cmd));
    }
    this.apply(out[0]);
    return out;
  }

  spawn(pos: ArrayLike<number>, yaw: number): void {
    this.motor.spawn(pos, yaw);
    this.pose.reset();
    this.hitEnabled = true;
  }
}

export class WeaponController implements WeaponsOwner {
  game: ServerGame;
  owner: HumanAgent;
  rng: Random;
  inv: Inventory;
  ads = 0;
  adsHeld = false;
  inspecting = false;
  meleeNext = 0;
  meleePending: [number, boolean] | null = null;
  grenadePhase: null | "priming" | "thrown" = null;
  grenadeLob = false;
  grenadeTimer = 0;
  switchLock = 0;
  now = 0;

  constructor(game: ServerGame, owner: HumanAgent, rng: Random) {
    this.game = game;
    this.owner = owner;
    this.rng = rng;
    this.inv = new Inventory(game.weaponDb, false, rng);
  }

  get primary() { return this.inv.weapons.primary ?? null; }
  get secondary() { return this.inv.weapons.secondary ?? null; }
  private get motor() { return this.owner.motor; }

  giveLoadout(weapons: string[], grenades: Record<string, number>): void {
    for (const k of weapons) this.inv.giveWeapon(k);
    for (const [k, n] of Object.entries(grenades)) this.inv.giveGrenade(k, n);
    this.inv.slot = "melee";
    this.select(this.inv.bestSlot(), true);
  }

  select(slot: string, force = false): void {
    const changed = this.inv.select(slot);
    if (!changed && !force) return;
    this.equipCurrent();
  }

  equipCurrent(): void {
    const now = this.now;
    this.inspecting = false;
    this.grenadePhase = null;
    this.meleePending = null;
    this.adsHeld = false;
    const ws = this.inv.current();
    const pose = this.owner.pose;
    this.owner.anim("switch");
    if (ws) {
      ws.deploy(now);
      pose.setWeapon(ws.d.model, ws.d.cls);
    } else if (this.inv.slot === "grenade" && this.inv.grenade) {
      pose.setWeapon(this.game.weaponDb.grenades[this.inv.grenade].model, "grenade");
      this.switchLock = now + 0.45;
    } else if (this.inv.slot === "bomb") {
      pose.setWeapon("bomb_charge", "bomb");
    } else pose.setWeapon(null);
    this.game.fx.ui("draw", 0.7, this.owner);
  }

  speedScale(): number {
    const ws = this.inv.current();
    let scale = ws ? ws.d.speed : 1;
    if (ws && this.ads > 0.5) {
      if (ws.zoomLevel > 0 && ws.d.scope) scale *= Number(ws.d.scope.speed ?? 0.6) / Math.max(ws.d.speed, 1e-3);
      else if (ws.d.ads) scale *= Number(ws.d.ads.speed ?? 0.8);
    }
    return scale;
  }

  adsParams(ws: WeaponState | null): [number, number] {
    let t = ADS_TIME, zoom = 1;
    if (ws) {
      if (ws.d.scope) {
        t = Number(ws.d.scope.time ?? 0.12);
        if (ws.zoomLevel > 0) zoom = ws.d.scope.zooms[ws.zoomLevel - 1];
      } else if (ws.d.ads) {
        t = Number(ws.d.ads.time ?? ADS_TIME);
        zoom = Number(ws.d.ads.zoom ?? 0.8);
      }
    }
    return [t, zoom];
  }

  private combatLocked(): boolean { return this.game.director?.combatLocked(this.owner) ?? false; }
  private observing(): boolean { return this.game.director?.tactical.observingFor(this.owner) ?? false; }

  fixedUpdate(dt: number, now: number, inp: CmdInput): void {
    this.now = now;
    this.advanceAds(dt);
    if (!this.owner.damageable.alive) return;
    if (this.observing()) return;
    for (const [action, slot] of SLOT_KEYS) if (inp.consume(action as never)) this.select(slot);
    if (inp.consume("wheel_up") && this.inv.cycle(-1)) this.equipCurrent();
    if (inp.consume("wheel_down") && this.inv.cycle(1)) this.equipCurrent();
    if (inp.consume("last_weapon") && this.inv.lastSlot && this.inv.has(this.inv.lastSlot)) this.select(this.inv.lastSlot);
    if (inp.consume("drop")) this.dropCurrent();
    if (inp.consume("use")) this.tryPickup();
    this.autoPickup();
    const ws = this.inv.current();
    if (ws) {
      ws.update(now, dt);
      if (inp.consume("reload") && ws.startReload(now)) this.inspecting = false;
      if (inp.consume("inspect") && !ws.busy(now)) this.inspecting = true;
      this.adsLogic(ws, inp);
      let trigger = inp.down("fire");
      let pressed = inp.consume("fire");
      if (this.combatLocked()) trigger = pressed = false;
      if (ws.d.fireMode === "melee") {
        const alt = inp.consume("aim");
        this.melee(ws, now, pressed || (trigger && now >= this.meleeNext), alt);
      } else if (ws.wantsShot(now, trigger, pressed)) this.fire(ws, now);
      this.handleEvents(ws);
    } else if (this.inv.slot === "grenade" && !this.combatLocked()) {
      this.grenadeLogic(dt, now, inp);
    } else if (this.inv.slot !== "bomb") {
      inp.consume("fire");
    }
    this.motor.speedScale = this.speedScale();
  }

  private advanceAds(dt: number): void {
    const [t] = this.adsParams(this.inv.current());
    const target = this.adsHeld ? 1 : 0;
    const step = dt / Math.max(t, 0.05);
    this.ads += Math.max(Math.min(target - this.ads, step), -step);
  }

  private adsLogic(ws: WeaponState, inp: CmdInput): void {
    const aimPressed = ws.d.fireMode !== "melee" ? inp.consume("aim") : false;
    if (ws.d.scope) {
      if (aimPressed && !ws.reloading) {
        const zooms = ws.d.scope.zooms ?? [0.4];
        ws.zoomLevel = (ws.zoomLevel + 1) % (zooms.length + 1);
        this.game.fx.ui("scope", 0.7, this.owner);
      }
      if (ws.reloading) ws.zoomLevel = 0;
      this.adsHeld = ws.zoomLevel > 0;
    } else if (ws.d.ads) {
      this.adsHeld = inp.down("aim") && !ws.reloading;
    } else this.adsHeld = false;
  }

  aimContext(ws: WeaponState): AimContext {
    const c = this.motor.char;
    return { speed: c.horizontalSpeed, maxSpeed: c.cfg.run_speed * ws.d.speed, onGround: c.onGround, crouched: c.crouched,
      ads: this.ads, scoped: ws.zoomLevel > 0 && this.ads > 0.9 };
  }

  private muzzlePoint(): V3 {
    const fwd = anglesToDir(this.motor.yaw, this.motor.pitch);
    const e = this.motor.eye();
    return [e[0] + fwd[0] * 0.6, e[1] + fwd[1] * 0.6, e[2] + fwd[2] * 0.6 - 0.06];
  }

  private fire(ws: WeaponState, now: number): void {
    const g = this.game;
    const eye = this.motor.eye();
    const offsets = ws.shotOffsets(this.aimContext(ws));
    const tracer = ws.isTracer();
    let hits = 0, killed = false, head = false;
    offsets.forEach(([dx, dy], i) => {
      const [yaw, pitch] = applyOffset(this.motor.yaw, this.motor.pitch, dx, dy);
      const d = anglesToDir(yaw, pitch);
      const res = g.ballistics.fire(eye, d, ws.d, this.owner);
      for (const imp of res.impacts) {
        g.fx.impact(imp.pos, imp.normal, imp.surface, imp.exit);
        if (!imp.character && i % 3 === 0) {
          g.fx.playAt(`impact_${g.ballistics.surface(imp.surface).sound ?? "concrete"}`, imp.pos, 0.6);
        }
      }
      for (const r of res.damage) { hits++; killed ||= r.killed; head ||= r.hitgroup === "head"; }
      if ((tracer && i === 0) || (ws.d.pellets > 1 && i < 2 && this.rng.random() < 0.3)) g.fx.tracer(this.muzzlePoint(), res.end);
    });
    ws.onFired(now);
    if (hits) {
      g.fx.hitMarker(this.owner, killed, head);
      g.fx.ui(head ? "hit_head" : "hit", 0.7, this.owner);
    }
    this.owner.anim("fire");
    g.fx.playShot(ws.d.sound, eye, this.owner);
    g.notifyNoise(eye, 1, 70, this.owner);
    this.inspecting = false;
    if (ws.d.scope && ws.d.scope.unscope_after_shot) this.adsHeld = false;
  }

  private handleEvents(ws: WeaponState): void {
    const fx = this.game.fx;
    for (const ev of ws.popEvents()) {
      const cls = ws.d.cls;
      if (ev.kind === "reload_start") {
        this.inspecting = false;
        const dur = ws.d.fireMode === "pump"
          ? Number(ws.d.raw.reload_start_time ?? 0.35) + Math.max(ws.d.magazine - ws.ammo, 1) * Number(ws.d.raw.reload_shell_time ?? 0.5)
          : ws.reloadKind === "empty" ? ws.d.reloadEmptyTime : ws.d.reloadTime;
        this.owner.anim("reload", dur);
        if (cls !== "shotgun") {
          const kind = ev.data?.kind === "empty" ? "empty" : "tactical";
          fx.ui(`reload_${ws.d.key}_${kind}`, 0.7, this.owner);
        }
      } else if (ev.kind === "shell") fx.ui("shell_insert", 0.7, this.owner);
      else if (ev.kind === "cycle") fx.ui(cls === "sniper" ? "bolt" : "pump", 0.7, this.owner);
      else if (ev.kind === "dry") fx.ui("dry_fire", 0.7, this.owner);
    }
  }

  // ------------------------------------------------------------- melee
  private melee(ws: WeaponState, now: number, light: boolean, heavy: boolean): void {
    if (this.meleePending && now >= this.meleePending[0]) {
      this.meleeHit(ws, this.meleePending[1]);
      this.meleePending = null;
    }
    if (now < this.meleeNext || now < ws.drawEnd || !(light || heavy)) return;
    const rpm = heavy ? Number(ws.d.raw.heavy_rpm ?? 60) : ws.d.rpm;
    this.meleeNext = now + 60 / rpm;
    this.meleePending = [now + (heavy ? 0.25 : 0.1), heavy];
    this.owner.anim("knife");
    this.game.fx.ui("knife_swing", 0.5, this.owner);
  }

  private meleeHit(ws: WeaponState, heavy: boolean): void {
    const g = this.game;
    const eye = this.motor.eye();
    const d = anglesToDir(this.motor.yaw, this.motor.pitch);
    const rng = Number(ws.d.raw.melee_range ?? 1.6);
    const hit = g.rayFirst(eye, [eye[0] + d[0] * rng, eye[1] + d[1] * rng, eye[2] + d[2] * rng], MASK_BULLETS, this.owner);
    if (!hit) return;
    const dmgBase = heavy ? Number(ws.d.raw.heavy_damage ?? 65) : ws.d.damage;
    if (hit.owner) {
      let dmg = dmgBase;
      const fwd = hit.owner.forward?.();
      if (fwd && fwd[0] * d[0] + fwd[1] * d[1] + fwd[2] * d[2] > 0.5) dmg *= Number(ws.d.raw.backstab_multiplier ?? 2.8);
      const r = hit.owner.damageable.takeDamage(damageInfo({ amount: dmg, armorPenetration: ws.d.armorPenetration,
        hitgroup: hit.hitgroup || "chest", kind: "melee", attacker: this.owner, weapon: ws.d.key, pos: hit.pos, direction: d }));
      if (r) {
        hit.owner.onHit?.(r, hit.pos, d);
        g.fx.hitMarker(this.owner, r.killed, false);
      }
      g.fx.impact(hit.pos, hit.normal, hit.surface || "flesh");
      g.fx.playAt("knife_hit_body", hit.pos, 1);
    } else {
      g.fx.impact(hit.pos, hit.normal, hit.surface);
      g.fx.playAt("knife_hit_wall", hit.pos, 1);
      if (hit.body?.panel !== undefined) g.destruction.meleeHit(hit.body.panel, hit.pos, d, dmgBase);
    }
  }

  // ---------------------------------------------------------- grenades
  private grenadeLogic(dt: number, now: number, inp: CmdInput): void {
    const fireDown = inp.down("fire");
    const aimDown = inp.down("aim");
    const fp = inp.consume("fire");
    const ap = inp.consume("aim");
    if (now < this.switchLock) return;
    if (this.grenadePhase === null && (fp || ap || fireDown || aimDown)) {
      this.grenadePhase = "priming";
      this.grenadeTimer = 0;
      this.game.fx.ui("pin", 0.7, this.owner);
    } else if (this.grenadePhase === "priming") {
      this.grenadeTimer += dt;
      this.grenadeLob = aimDown && !fireDown;
      if (this.grenadeTimer > 0.3 && !fireDown && !aimDown) this.throwGrenade();
    } else if (this.grenadePhase === "thrown") {
      this.grenadeTimer += dt;
      if (this.grenadeTimer > 0.55) {
        this.grenadePhase = null;
        if (this.inv.has("grenade")) {
          this.inv.select("grenade");
          if (!this.inv.grenade || !(this.inv.grenade in this.inv.grenades)) {
            this.inv.grenade = null;
            this.inv.select("grenade");
          }
          this.equipCurrent();
        } else {
          this.inv.slot = "melee";
          this.select(this.inv.bestSlot(), true);
        }
      }
    }
  }

  private throwGrenade(): void {
    const key = this.inv.useGrenade();
    this.grenadePhase = "thrown";
    this.grenadeTimer = 0;
    if (!key) return;
    const g = this.game.weaponDb.grenades[key];
    const m = this.motor;
    const vel = throwVelocity(m.yaw, m.pitch, this.grenadeLob ? g.lobSpeed : g.throwSpeed, m.char.vel);
    const fwd = anglesToDir(m.yaw, m.pitch);
    const h = m.yaw * Math.PI / 180;
    const e = m.eye();
    const start: V3 = [e[0] + fwd[0] * 0.25 + Math.cos(h) * 0.12, e[1] + fwd[1] * 0.25 + Math.sin(h) * 0.12, e[2] + fwd[2] * 0.25 - 0.08];
    this.game.spawnGrenade(new Grenade(this.game, g, start, vel, this.owner));
    this.owner.anim("throw");
    this.game.fx.ui("throw", 0.7, this.owner);
  }

  // ----------------------------------------------------------- pickups
  dropCurrent(): void {
    if (this.inv.slot === "bomb") {
      this.game.director?.dropBomb(this.owner);
      return;
    }
    const ws = this.inv.dropCurrent();
    if (!ws) return;
    this.dropWeaponState(ws);
    this.equipCurrent();
  }

  dropWeaponState(ws: WeaponState, throwSpeed = 4.0): void {
    ws.cancelReload();
    ws.zoomLevel = 0;
    const m = this.motor;
    const fwd = anglesToDir(m.yaw, m.pitch);
    const e = m.eye();
    const v = m.char.vel;
    this.game.pickups.spawn("weapon", ws, [e[0] + fwd[0] * 0.5, e[1] + fwd[1] * 0.5, e[2] + fwd[2] * 0.5], m.yaw,
      [fwd[0] * throwSpeed + v[0], fwd[1] * throwSpeed + v[1], fwd[2] * throwSpeed + 1.5 + v[2]]);
  }

  tryPickup(): boolean {
    const p = this.game.pickups.lookAt(this.motor.eye(), anglesToDir(this.motor.yaw, this.motor.pitch));
    return p ? this.take(p) : false;
  }

  private autoPickup(): void {
    for (const p of this.game.pickups.nearFeet(this.motor.char.pos)) {
      if (p.kind !== "weapon") continue;
      const slot = typeof p.item === "string" ? this.game.weaponDb.weapons[p.item].slot : p.item.d.slot;
      if (!this.inv.has(slot)) this.take(p);
    }
  }

  private take(p: Pickup): boolean {
    const fx = this.game.fx;
    const o = this.owner;
    if (p.kind === "weapon") {
      const item = typeof p.item === "string" ? this.inv.make(p.item) : p.item;
      const slot = item.d.slot;
      const old = this.inv.weapons[slot] ?? null;
      if (old) {
        old.cancelReload();
        const fwd = anglesToDir(this.motor.yaw, this.motor.pitch);
        const e = this.motor.eye();
        this.game.pickups.spawn("weapon", old, [e[0] + fwd[0] * 0.4, e[1] + fwd[1] * 0.4, e[2] + fwd[2] * 0.4], this.motor.yaw,
          [fwd[0] * 2.5, fwd[1] * 2.5, fwd[2] * 2.5 + 1]);
      }
      this.inv.giveWeapon(item);
      p.taken();
      this.inv.slot = "melee";
      this.select(slot, true);
      fx.message(o, `picked up ${item.d.name}`);
    } else if (p.kind === "ammo") {
      this.inv.refillAmmo();
      fx.message(o, "ammo refilled");
    } else if (p.kind === "armor") {
      o.damageable.armor = 100;
      o.damageable.helmet = true;
      fx.message(o, "armour + helmet");
    } else if (p.kind === "grenades") {
      this.inv.refillGrenades();
      fx.message(o, "grenades refilled");
    } else if (p.kind === "grenade") {
      if (!this.inv.giveGrenade(p.item as string)) return false;
      p.taken();
    }
    fx.ui("pickup", 0.7, o);
    return true;
  }
}
