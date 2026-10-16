// Drones (attackers) and security cameras (defenders). A drone is a tiny kinematic character (15 cm hull):
// it drives, hops up steps, falls through hatches and dies to one bullet. Cameras are map pieces the
// defenders look through; they pan within a limit and can be shot out. Both spot enemies for their team.

import { KinematicCharacter, MOVEMENT, type MovementConfig, NO_MOVE } from "@cs/shared/character";
import { MASK_SIGHT } from "@cs/shared/collision";
import { deepCopy } from "@cs/shared/data";
import type { CameraSpec } from "@cs/shared/level/level";
import { type M3, type V3, hprMatrix } from "@cs/shared/math";
import { Deployable, gadgetCfg } from "./gadgets";
import type { Tactical } from "./tactical";

export const DRONE_EYE = 0.11;

export function droneMovement(cfg: Record<string, number>): MovementConfig {
  const m = deepCopy(MOVEMENT);
  const speed = Number(cfg.speed ?? 3.4);
  Object.assign(m, { radius: 0.13, stand_height: 0.16, crouch_height: 0.16, step_height: 0.09, run_speed: speed,
    walk_speed: speed * 0.5, crouch_speed: speed * 0.5, jump_speed: Number(cfg.jump ?? 4.2), eye_offset: 0.05,
    ground_accel: 9.0, ground_friction: 7.0 });
  return m;
}

export function viewDir(yaw: number, pitch: number): V3 {
  const h = yaw * Math.PI / 180, p = pitch * Math.PI / 180;
  return [-Math.sin(h) * Math.cos(p), Math.cos(h) * Math.cos(p), Math.sin(p)];
}

export class Drone extends Deployable {
  static override kind = "drone";
  static override model = "gadget_drone";
  char: KinematicCharacter;
  yaw: number;
  pitch = 0;
  label: string;
  wish: V3 = [0, 0, 0];
  jump = false;
  private buzz = 0;

  constructor(tac: Tactical, owner: unknown, side: string, pos: V3, yaw: number, vel: V3 | null, label = "") {
    super(tac, owner, side, pos, [yaw, 0, 0]);
    this.electronic = true;
    this.char = new KinematicCharacter(this.game.world, droneMovement(this.cfg));
    this.char.depenInterval = 4;
    this.char.teleport(pos);
    if (vel) this.char.vel = [...vel] as V3;
    this.yaw = yaw;
    this.label = label;
    this.addHitbox([0.28, 0.22, 0.14], [0, 0, 0.08], Number(this.cfg.health ?? 1));
  }

  get jammed(): boolean { return this.disabled || this.tac.jammed(this.char.pos, this.side); }
  eye(): V3 { const c = this.char.pos; return [c[0], c[1], c[2] + DRONE_EYE]; }
  override center(): V3 { return this.eye(); }
  position(): V3 { return [...this.char.pos] as V3; }
  override frame(): [V3, M3] { return [this.char.pos, hprMatrix(this.yaw, 0, 0)]; }

  drive(wish: V3, jump = false): void {
    this.wish = [...wish] as V3;
    this.jump = jump;
  }

  override update(dt: number): void {
    if (this.jammed) {
      this.wish = [0, 0, 0];
      this.jump = false;
    }
    this.char.step(dt, { ...NO_MOVE, wish: this.wish, jump: this.jump });
    this.pos = [...this.char.pos] as V3;
    this.hpr = [this.yaw, 0, 0];
    this.jump = false;
    if (this.char.horizontalSpeed > 0.5) {
      this.buzz -= dt;
      if (this.buzz <= 0) {
        this.buzz = 0.6;
        this.game.fx.playAt("drone_motor", this.char.pos, 0.35);
        this.game.notifyNoise(this.char.pos, 0.25, 7, this.owner);
      }
    }
    if (this.char.pos[2] < -60) this.destroy();
  }
}

export class MapCamera extends Deployable {
  static override kind = "camera";
  static override model = "gadget_camera";
  static PAN = 55;
  static TILT: [number, number] = [-55, 20];
  baseYaw: number;
  basePitch: number;
  label: string;
  index: number;
  yaw: number;
  pitch: number;

  constructor(tac: Tactical, spec: CameraSpec, index: number) {
    super(tac, null, "defend", spec.pos, [spec.heading, 0, 0]);
    this.electronic = true;
    this.baseYaw = spec.heading;
    this.basePitch = spec.pitch ?? -15;
    this.label = spec.name || `Camera ${index + 1}`;
    this.index = index;
    this.yaw = this.baseYaw;
    this.pitch = this.basePitch;
    this.addHitbox([0.12, 0.3, 0.14], [0, 0.06, 0], Number(this.cfg.health ?? 1));
  }

  eye(): V3 {
    const d = viewDir(this.yaw, this.pitch);
    return [this.pos[0] + d[0] * 0.2, this.pos[1] + d[1] * 0.2, this.pos[2] + d[2] * 0.2];
  }

  get jammed(): boolean { return this.disabled; }

  look(dyaw: number, dpitch: number): void {
    const off = ((((this.yaw + dyaw - this.baseYaw + 180) % 360) + 360) % 360) - 180;
    this.yaw = this.baseYaw + Math.max(-MapCamera.PAN, Math.min(MapCamera.PAN, off));
    this.pitch = Math.max(MapCamera.TILT[0], Math.min(MapCamera.TILT[1], this.pitch + dpitch));
  }
}

export function canSee(tac: Tactical, eye: V3, target: V3, maxRange: number, forward: V3 | null = null, cosHalf = -1): boolean {
  const d: V3 = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
  const dist = Math.hypot(d[0], d[1], d[2]);
  if (dist > maxRange || dist < 1e-3) return false;
  if (forward && (d[0] * forward[0] + d[1] * forward[1] + d[2] * forward[2]) / dist < cosHalf) return false;
  return !tac.game.world.ray(eye, target, MASK_SIGHT);
}

export function viewCfg(kind: string) {
  return gadgetCfg(kind === "drone" ? "drone" : "camera");
}
