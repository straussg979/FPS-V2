// A player's body in the fixed tick: input command -> character movement and lean. The server runs one
// per player; the browser runs the same one to predict its own soldier, then corrects it from the
// server's state (reconciliation).

import { CmdInput } from "./commands";
import { KinematicCharacter, Lean, type MoveInput, NO_MOVE, f32vec, leanClearance, normalized, rightOfYaw } from "./character";
import { type CollisionWorld, MASK_SIGHT } from "./collision";
import type { V3 } from "./math";

const f = Math.fround;

export interface MotorState {
  pos: V3; vel: V3; height: number; groundNormal: V3; jumpCooldown: number; landingTimer: number;
  airTime: number; stride: number; jumpBuffer: number; lean: number; speedScale: number; slow: number;
  yaw: number; pitch: number;
  onGround: boolean; crouched: boolean; walking: boolean; moveLock: boolean; leanLock: boolean; alive: boolean;
}

export class PlayerMotor {
  world: CollisionWorld;
  char: KinematicCharacter;
  lean = new Lean();
  yaw = 0;
  pitch = 0;
  jumpBuffer = 0;
  speedScale = 1;          // weapon weight and ADS (the weapon controller sets it every tick)
  slow = 1;                // razor wire
  moveLock = false;        // freeze time, planting, defusing, a view: look but do not move
  leanLock = false;
  alive = true;
  externalView = false;    // looking through a drone or camera: the body stands still

  constructor(world: CollisionWorld) {
    this.world = world;
    this.char = new KinematicCharacter(world);
  }

  spawn(pos: ArrayLike<number>, heading = 0): void {
    this.char.teleport(pos);
    this.char.vel = [0, 0, 0];
    this.char.prevPos = this.char.pos.slice() as V3;
    this.yaw = heading;
    this.pitch = 0;
    this.lean.reset();
  }

  basis(): [V3, V3] {
    const h = this.yaw * Math.PI / 180;
    return [f32vec(-Math.sin(h), Math.cos(h), 0), f32vec(Math.cos(h), Math.sin(h), 0)];
  }

  /** Eye position, including the lean (bullets start here). */
  eye(): V3 {
    const c = this.char;
    const r = rightOfYaw(this.yaw);
    const o = this.lean.offset();
    return [c.pos[0] + r[0] * o, c.pos[1] + r[1] * o, c.pos[2] + c.eyeHeight];
  }

  centerOfMass(): V3 {
    const c = this.char;
    return [c.pos[0], c.pos[1], c.pos[2] + c.height * 0.55];
  }

  forward(): V3 { return this.basis()[0]; }

  updateLean(dt: number, inp: CmdInput): void {
    let target = 0;
    if (this.alive && !this.leanLock) target = (inp.down("lean_right") ? 1 : 0) - (inp.down("lean_left") ? 1 : 0);
    const c = this.char;
    const [fl, fr] = target !== 0 || this.lean.amount !== 0
      ? leanClearance(this.world, [c.pos[0], c.pos[1], f(c.pos[2] + c.eyeHeight)], this.yaw, MASK_SIGHT) : [1, 1];
    this.lean.update(dt, target, fl, fr);
  }

  /** One command. The view angles come from the command (unless a view is being driven). */
  fixedUpdate(dt: number, inp: CmdInput): void {
    if (!this.externalView) {
      this.yaw = ((inp.cmd.yaw % 360) + 360) % 360;
      this.pitch = Math.max(-89, Math.min(89, inp.cmd.pitch));
    } else {
      this.char.step(dt, { ...NO_MOVE, crouch: !this.alive });
      this.updateLean(dt, inp);
      return;
    }
    const [fwd, side] = inp.axes();
    const [forward, right] = this.basis();
    let wish: V3 = [f(f(forward[0] * f(fwd)) + f(right[0] * f(side))), f(f(forward[1] * f(fwd)) + f(right[1] * f(side))),
      f(f(forward[2] * f(fwd)) + f(right[2] * f(side)))];
    if (wish[0] * wish[0] + wish[1] * wish[1] + wish[2] * wish[2] > 1e-6) wish = normalized(wish);
    if (inp.consume("jump")) this.jumpBuffer = 0.08;
    else this.jumpBuffer = Math.max(this.jumpBuffer - dt, 0);
    if (this.moveLock) { wish = [0, 0, 0]; this.jumpBuffer = 0; }
    let move: MoveInput = { wish, walk: inp.down("walk"), crouch: inp.down("crouch"), jump: this.jumpBuffer > 0,
      speedScale: this.speedScale * this.slow };
    if (!this.alive) move = { ...NO_MOVE, crouch: true };
    const wasGround = this.char.onGround;
    this.char.step(dt, move);
    if (move.jump && wasGround && !this.char.onGround) this.jumpBuffer = 0;
    this.updateLean(dt, inp);
  }

  state(): MotorState {
    const c = this.char;
    return { pos: c.pos.slice() as V3, vel: c.vel.slice() as V3, height: c.height, groundNormal: c.groundNormal.slice() as V3,
      jumpCooldown: c.jumpCooldown, landingTimer: c.landingTimer, airTime: c.airTime, stride: c.stride,
      jumpBuffer: this.jumpBuffer, lean: this.lean.amount, speedScale: this.speedScale, slow: this.slow, yaw: this.yaw,
      pitch: this.pitch, onGround: c.onGround, crouched: c.crouched, walking: c.walking, moveLock: this.moveLock,
      leanLock: this.leanLock, alive: this.alive };
  }

  setState(s: MotorState): void {
    const c = this.char;
    c.pos = f32vec(...s.pos);
    c.vel = f32vec(...s.vel);
    c.height = s.height;
    c.groundNormal = f32vec(...s.groundNormal);
    c.jumpCooldown = s.jumpCooldown;
    c.landingTimer = s.landingTimer;
    c.airTime = s.airTime;
    c.stride = s.stride;
    c.onGround = s.onGround;
    c.crouched = s.crouched;
    c.walking = s.walking;
    this.jumpBuffer = s.jumpBuffer;
    this.lean.amount = this.lean.prev = s.lean;
    this.speedScale = s.speedScale;
    this.slow = s.slow;
    this.moveLock = s.moveLock;
    this.leanLock = s.leanLock;
    this.alive = s.alive;
  }
}
