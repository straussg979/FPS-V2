// The own weapon's presentation, predicted cosmetically: the muzzle flash, the sound, a tracer along the
// crosshair, the viewmodel animations and the ammo count react to the player's commands at once; damage,
// hits and the real ammo come from the server, which never shares its spread seed. Timings and classes come
// from data/weapons.json (the server's own definitions).

import { WEAPONS_JSON } from "@cs/shared/data";
import type { Viewmodel } from "./viewmodel";

/* eslint-disable @typescript-eslint/no-explicit-any */
const TRACK_FOR: Record<string, string> = { pistol: "reload_pistol", sniper: "reload_sniper" };
const DEFS: any = WEAPONS_JSON;

export interface WeaponHooks { fire: (def: any, empty: boolean, tracer: boolean) => void; sound: (name: string) => void }
export interface CmdView { seq: number; down: (a: string) => boolean; pressed: (a: string) => boolean }

export function describeItem(key: string): { kind: string; model: string | null; cls: string; def: any } {
  if (!key) return { kind: "", model: null, cls: "", def: null };
  if (key === "bomb_charge") return { kind: "bomb", model: "bomb_charge", cls: "bomb", def: null };
  const w = DEFS.weapons[key];
  if (w) return { kind: w.class === "knife" ? "knife" : "gun", model: w.model, cls: w.class, def: w };
  const g = DEFS.grenades[key];
  if (g) return { kind: "grenade", model: g.model, cls: "grenade", def: g };
  return { kind: "", model: null, cls: "", def: null };
}

export class LocalWeapons {
  key: string | null = null;
  def: any = null;
  kind = "";
  cls = "";
  private nextFire = 0;
  private reloadUntil = 0;
  private drawUntil = 0;
  private shots: Array<{ seq: number }> = [];
  private time = 0;
  private fireWasDown = false;
  private grenadePhase: null | "priming" | "thrown" = null;
  private grenadeT = 0;
  private shotCount = 0;

  constructor(private vm: Viewmodel, private hooks: WeaponHooks) {}

  /** The item in hand per the server's self block. */
  setItem(key: string): void {
    if (key === this.key) return;
    this.key = key;
    const d = describeItem(key);
    this.def = d.def;
    this.kind = d.kind;
    this.cls = d.cls;
    const drawTime = d.def?.draw_time ?? (d.kind === "grenade" ? 0.45 : 0.5);
    this.drawUntil = this.time + drawTime;
    this.reloadUntil = 0;
    this.grenadePhase = null;
    void this.vm.equip(d.model, d.cls, drawTime);
  }

  /** Ammo to show: the server's count less the shots it has not acknowledged yet. */
  ammo(serverAmmo: number, ack: number): number {
    this.shots = this.shots.filter((s) => s.seq > ack);
    return Math.max(0, serverAmmo - this.shots.length);
  }

  /** One command tick (1/64 s). */
  tick(dt: number, cmd: CmdView, self: any, ack: number, canAct: boolean): void {
    this.time += dt;
    if (!canAct || (!this.def && this.kind !== "bomb")) { this.fireWasDown = cmd.down("fire"); return; }
    const now = this.time;
    const fire = cmd.down("fire");
    const firePressed = cmd.pressed("fire") || (fire && !this.fireWasDown);
    this.fireWasDown = fire;
    if (cmd.pressed("inspect") && now >= this.reloadUntil && now >= this.drawUntil) this.vm.play("inspect", 3.0);
    if (this.kind === "gun") {
      const d = this.def;
      const ammo = this.ammo(self ? self.ammo : 0, ack);
      const reserve = self ? self.reserve : 0;
      const busy = now < this.reloadUntil || now < this.drawUntil;
      if (cmd.pressed("reload") && !busy && ammo < d.magazine && reserve > 0) this.reload(ammo === 0);
      const want = d.fire_mode === "auto" ? fire : firePressed;
      if (want && !busy && now >= this.nextFire) {
        if (ammo > 0) {
          this.nextFire = now + 60 / d.rpm;
          this.shots.push({ seq: cmd.seq });
          this.shotCount++;
          this.vm.onFire(d.recoil ? d.recoil.punch : 1, ammo - 1 === 0);
          this.hooks.fire(d, ammo - 1 === 0, (d.tracer_every ?? 0) > 0 && this.shotCount % d.tracer_every === 0);
          if (d.fire_mode === "pump") this.vm.playPart("pump_cycle", Math.min(60 / d.rpm * 0.8, 0.6));
          else if (d.fire_mode === "bolt") this.vm.playPart("bolt_cycle", 60 / d.rpm * 0.9);
        } else if (firePressed) {
          this.hooks.sound("dry_fire");
          this.nextFire = now + 0.25;
          if (reserve > 0) this.reload(true);
        }
      }
    } else if (this.kind === "knife") {
      if ((firePressed || cmd.pressed("aim")) && now >= this.nextFire && now >= this.drawUntil) {
        const heavy = !firePressed;
        const rpm = heavy ? this.def.heavy_rpm ?? 60 : this.def.rpm;
        this.nextFire = now + 60 / rpm;
        this.vm.play(heavy ? "knife_stab" : "knife_slash", 60 / rpm * 0.9);
        this.hooks.sound("knife_swing");
      }
    } else if (this.kind === "grenade") {
      const aim = cmd.down("aim");
      if (this.grenadePhase === null && (firePressed || cmd.pressed("aim")) && now >= this.drawUntil) {
        this.grenadePhase = "priming";
        this.grenadeT = 0;
        this.vm.play("grenade_prime", 0.35, true);
        this.hooks.sound("pin");
      } else if (this.grenadePhase === "priming") {
        this.grenadeT += dt;
        if (this.grenadeT > 0.3 && !fire && !aim) {
          this.grenadePhase = "thrown";
          this.grenadeT = 0;
          this.vm.play("grenade_throw", 0.5);
          this.hooks.sound("throw");
        }
      } else if (this.grenadePhase === "thrown") {
        this.grenadeT += dt;
        if (this.grenadeT > 0.55) this.grenadePhase = null;
      }
    }
  }

  private reload(empty: boolean): void {
    const d = this.def;
    if (d.class === "shotgun") {
      const start = d.reload_start_time ?? 0.35;
      this.vm.play("shotgun_load_start", start, true);
      this.reloadUntil = this.time + start + (d.reload_shell_time ?? 0.5);
      setTimeout(() => this.vm.play("shotgun_shell", d.reload_shell_time ?? 0.5, true), start * 1000);
      return;
    }
    const time = empty && d.reload_empty_time ? d.reload_empty_time : d.reload_time;
    let name = TRACK_FOR[d.class] ?? "reload_rifle";
    if (empty && (name === "reload_rifle" || name === "reload_pistol")) name += "_empty";
    this.vm.play(name, time);
    this.reloadUntil = this.time + time;
    this.shots = [];
  }
}
