// A soldier's pose on the game skeleton, animated procedurally each tick. The server uses it for the hit
// capsules (what shots test), the browser to pose the soldier bodies, so what you see is what you hit.
//
// * Aim pitch is spread over spine_01 (25 %), spine_03 (30 %) and the weapon (45 %); the head follows.
// * Walking swings the legs with the distance travelled (stride per gait) and bobs the pelvis.
// * Crouching lowers the pelvis and folds hips and knees; leaning rolls the upper body.
// * The arms reach the weapon's grips with two-bone IK; clips (reload, switch, throw, knife, plant,
//   defuse: data/character_anims.json) move the weapon and the hands.
// * Death tips the body over around the feet, away from the killing shot.

import animsJson from "../../data/character_anims.json";
import modelsJson from "../../data/weapon_models.json";
import { Lean } from "./character";
import { type M4, type V3, hprMatrix, m4, m4Mul, m4Point, m4PosHpr, rotate } from "./math";
import { BONES, INDEX as B, INV_BIND, N_BONES, PARENT, REST_HPR, REST_POS, REST_WORLD, STAND_PELVIS, UPPER_ARM,
  LOWER_ARM, PALM, aimHpr, relativeHpr } from "./skeleton";

const FOREARM = LOWER_ARM + PALM;
const SHOULDER: V3 = [0.21, 0, 0.24];
export const CROUCH_PELVIS = 0.50;
const D = Math.PI / 180;

export const HOLDS: Record<string, { pos: V3; hands: number }> = {
  long: { pos: [0.115, 0.17, 0.17], hands: 2 },
  pistol: { pos: [0.04, 0.42, 0.16], hands: 2 },
  knife: { pos: [0.21, 0.30, -0.20], hands: 1 },
  grenade: { pos: [0.22, 0.20, 0.10], hands: 1 },
  bomb: { pos: [0.0, 0.30, -0.16], hands: 2 },
};
export const CLASS_HOLD: Record<string, string> = { rifle: "long", smg: "long", sniper: "long", shotgun: "long", pistol: "pistol",
  knife: "knife", grenade: "grenade", bomb: "bomb" };

/* eslint-disable @typescript-eslint/no-explicit-any */
const CLIPS: Record<string, any> = Object.fromEntries(Object.entries(animsJson as any).filter(([k]) => !k.startsWith("_")));
const MODELS: Record<string, any> = modelsJson as any;

// ------------------------------------------------------------------ hit capsules
export interface CapsuleDef { name: string; hitgroup: string; bone: number; a: V3; b: V3; radius: number; sphere: boolean }

const restPos = (n: string): V3 => { const m = REST_WORLD[B[n]]; return [m[12], m[13], m[14]]; };

function capsuleDefs(): CapsuleDef[] {
  const raw: Array<[string, string, string, V3, V3 | null, number]> = [
    ["head", "head", "head", [0, 0.011, 1.625], null, 0.112],
    ["neck", "chest", "neck", restPos("neck"), [0, 0.005, restPos("neck")[2] + 0.085], 0.06],
    ["chest", "chest", "spine_03", [-0.045, 0, 1.33], [0.045, 0, 1.33], 0.17],
    ["stomach", "stomach", "spine_01", [-0.025, 0, 1.06], [0.025, 0, 1.06], 0.125],
    ["pelvis", "stomach", "pelvis", [-0.09, 0, 0.89], [0.09, 0, 0.89], 0.13],
  ];
  for (const s of ["l", "r"]) {
    raw.push([`upper_arm_${s}`, "arm", `upperarm_${s}`, restPos(`upperarm_${s}`), restPos(`lowerarm_${s}`), 0.055]);
    raw.push([`forearm_${s}`, "arm", `lowerarm_${s}`, restPos(`lowerarm_${s}`), restPos(`hand_${s}`), 0.045]);
    raw.push([`thigh_${s}`, "leg", `thigh_${s}`, restPos(`thigh_${s}`), restPos(`calf_${s}`), 0.085]);
    raw.push([`calf_${s}`, "leg", `calf_${s}`, restPos(`calf_${s}`), restPos(`foot_${s}`), 0.065]);
  }
  // end points in the bone's own frame (the rest pose's inverse)
  return raw.map(([name, hitgroup, bone, a, b, radius]) => {
    const inv = INV_BIND[B[bone]];
    return { name, hitgroup, bone: B[bone], radius, sphere: b === null, a: m4Point(inv, a), b: m4Point(inv, b ?? a) };
  });
}
export const CAPSULES: CapsuleDef[] = capsuleDefs();

/** Bones whose world matrix the capsules (and the head point and weapon) need, parents first. */
const NEEDED: number[] = (() => {
  const keep = new Set<number>();
  for (const name of [...CAPSULES.map((c) => BONES[c.bone].name), "weapon", "pack", "head"]) {
    let i = B[name];
    while (i >= 0 && !keep.has(i)) { keep.add(i); i = PARENT[i]; }
  }
  return [...keep].sort((x, y) => x - y);
})();

export interface Capsule { def: CapsuleDef; a: V3; b: V3 }

// ------------------------------------------------------------------ helpers
function smooth(t: number): number {
  t = Math.min(Math.max(t, 0), 1);
  return t * t * (3 - 2 * t);
}

type HandTarget = [string, number, number, number] | null;
type Channel = number | [HandTarget, HandTarget, number];

function channel(keys: any[], name: string, t: number): Channel | null {
  let prev: any = null, nxt: any = null;
  for (const k of keys) {
    if (!(name in k)) continue;
    if (k.t <= t) prev = k;
    else if (nxt === null) nxt = k;
  }
  if (prev === null && nxt === null) return null;
  if (prev === null) prev = nxt;
  if (nxt === null) nxt = prev;
  const span = nxt.t - prev.t;
  const w = span > 1e-9 ? smooth((t - prev.t) / span) : 0;
  const a = prev[name], b = nxt[name];
  if (typeof a === "number" && typeof b === "number") return a + (b - a) * w;
  return [a, b, w];
}

function twoBoneElbow(s: V3, h: V3, l1: number, l2: number, pole: V3): V3 {
  const d: V3 = [h[0] - s[0], h[1] - s[1], h[2] - s[2]];
  const dist = Math.hypot(d[0], d[1], d[2]);
  const pl = Math.hypot(pole[0], pole[1], pole[2]) || 1;
  if (dist < 1e-4) return [s[0] + pole[0] / pl * l1, s[1] + pole[1] / pl * l1, s[2] + pole[2] / pl * l1];
  const distC = Math.min(Math.max(dist, Math.abs(l1 - l2) + 1e-3), l1 + l2 - 1e-3);
  const axis: V3 = [d[0] / dist, d[1] / dist, d[2] / dist];
  const a = (l1 * l1 - l2 * l2 + distC * distC) / (2 * distC);
  const hh = Math.sqrt(Math.max(l1 * l1 - a * a, 0));
  const pd = pole[0] * axis[0] + pole[1] * axis[1] + pole[2] * axis[2];
  let perp: V3 = [pole[0] - axis[0] * pd, pole[1] - axis[1] * pd, pole[2] - axis[2] * pd];
  if (perp[0] ** 2 + perp[1] ** 2 + perp[2] ** 2 < 1e-8) perp = [axis[0] * axis[2], axis[1] * axis[2], -1 + axis[2] * axis[2]];
  const n = Math.hypot(perp[0], perp[1], perp[2]) || 1;
  return [s[0] + axis[0] * a + perp[0] / n * hh, s[1] + axis[1] * a + perp[1] / n * hh, s[2] + axis[2] * a + perp[2] / n * hh];
}

interface ActiveClip { t: number; dur: number; loop: boolean; stop: boolean }

// ------------------------------------------------------------------ the pose
export class SoldierPose {
  hpr: V3[] = REST_HPR.map((v) => [...v] as V3);
  pos: V3[] = REST_POS.map((v) => [...v] as V3);
  rootPos: V3 = [0, 0, 0];
  rootYaw = 0;
  hold = "long";
  weaponModel = "";
  grips: [V3, V3] = [[0, 0.05, -0.05], [0, 0.05, -0.05]];
  muzzleAnchor: V3 = [0, 0.5, 0];
  phase = 0;
  moveWeight = 0;
  crouch = 0;
  aimPitch = 0;
  kick = 0;
  deadT = -1;
  fallDir = 1;
  alive = true;
  activeClips = new Map<string, ActiveClip>();
  flinch: [number, number, number] = [0, 0, 0];
  private sig = "";
  private world: M4[] | null = null;
  private worldAll = false;
  private dirty = true;

  // ------------------------------------------------------------ weapon
  setWeapon(model: string | null, cls = "rifle"): void {
    if ((model ?? "") === this.weaponModel && model) return;
    this.weaponModel = model ?? "";
    this.hold = CLASS_HOLD[cls] ?? "long";
    this.pos[B.weapon] = [...HOLDS[this.hold].pos] as V3;
    this.dirty = true;
    if (!model) {
      this.grips = [[0, 0.05, -0.05], [0, 0.05, -0.05]];
      this.muzzleAnchor = [0, 0.5, 0];
      return;
    }
    const anchors = MODELS[model]?.anchors ?? {};
    this.grips = [anchors.grip_r ?? [0, 0, 0], anchors.grip_l ?? [0, 0, 0]];
    this.muzzleAnchor = anchors.muzzle ?? [0, 0.5, 0];
  }

  // ------------------------------------------------------------ events
  /** fire, reload (duration), switch, throw, knife, plant / defuse (loop until stop), hit (flinch). */
  event(name: string, duration?: number, direction?: V3 | null): void {
    if (name === "fire") { this.kick = Math.min(this.kick + 0.6, 1); return; }
    if (name === "hit") { this.doFlinch(direction ?? null); return; }
    if (name === "reload" && this.hold === "pistol") name = "reload_pistol";
    const d = CLIPS[name];
    if (!d) return;
    if (["switch", "throw", "knife", "plant", "defuse"].includes(name)) {
      for (const other of ["reload", "reload_pistol"]) {
        const c = this.activeClips.get(other);
        if (c && !c.stop) { c.stop = true; c.dur *= 0.25; }
      }
    }
    this.activeClips.set(name, { t: 0, dur: Math.max(Number(duration ?? d.duration), 0.05), loop: !!d.loop, stop: false });
    this.sig = "";
  }

  stop(name: string): void {
    const c = this.activeClips.get(name);
    if (c) c.stop = true;
  }

  private doFlinch(direction: V3 | null): void {
    if (!direction) { this.flinch = [-6, 0, 0.3]; return; }
    // the shot direction in the body's frame: the torso gives way along it
    const h = this.rootYaw * D;
    const lx = direction[0] * Math.cos(h) + direction[1] * Math.sin(h);
    const ly = -direction[0] * Math.sin(h) + direction[1] * Math.cos(h);
    this.flinch = [-6 * (ly > 0 ? 1 : -1) * Math.min(Math.abs(ly) + 0.3, 1), 6 * lx, 0.3];
    this.sig = "";
  }

  private clipChannels(dt: number): Record<string, Channel> {
    const out: Record<string, Channel> = {};
    const done: string[] = [];
    for (const [name, c] of this.activeClips) {
      const keys = CLIPS[name].keys;
      if (c.stop) {
        c.t -= dt / c.dur;
        if (c.t <= 0) { done.push(name); continue; }
      } else {
        c.t += dt / c.dur;
        if (c.t >= 1) {
          if (c.loop) c.t = 1;
          else { done.push(name); continue; }
        }
      }
      for (const ch of ["weapon_p", "weapon_r", "weapon_h", "weapon_x", "weapon_y", "weapon_z", "spine_p", "neck_p", "crouch"]) {
        const v = channel(keys, ch, c.t);
        if (v !== null) {
          const cur = (out[ch] as number | undefined) ?? 0;
          out[ch] = ch === "crouch" ? Math.max(cur, v as number) : cur + (v as number);
        }
      }
      for (const ch of ["hand_l", "hand_r"]) {
        const v = channel(keys, ch, c.t);
        if (v !== null) out[ch] = v;
      }
    }
    for (const n of done) this.activeClips.delete(n);
    return out;
  }

  // ------------------------------------------------------------- state
  place(pos: ArrayLike<number>, yaw: number): void {
    this.rootPos = [pos[0], pos[1], pos[2]];
    this.rootYaw = yaw;
    this.dirty = true;
  }

  reset(): void {
    this.sig = "";
    this.activeClips.clear();
    this.flinch = [0, 0, 0];
    this.deadT = -1;
    this.alive = true;
    this.hpr[B.root] = [0, 0, 0];
    this.pos[B.root] = [0, 0, 0];
    this.dirty = true;
  }

  die(direction?: V3 | null): void {
    this.alive = false;
    this.deadT = 0;
    const h = this.rootYaw * D;
    const fwd: V3 = [-Math.sin(h), Math.cos(h), 0];
    this.fallDir = 1;
    if (direction && direction[0] * fwd[0] + direction[1] * fwd[1] + direction[2] * fwd[2] > 0) this.fallDir = -1;
  }

  /** Pose for this tick. pitch = aim pitch; lean -1..1 rolls the upper body. */
  animate(dt: number, pos: ArrayLike<number>, yaw: number, pitch: number, crouch: number, vel: ArrayLike<number>,
          onGround: boolean, walking = false, lean = 0): void {
    this.place(pos, yaw);
    if (this.deadT >= 0) {
      if (this.deadT < 1) this.animateDeath(dt);
      return;
    }
    const speed = Math.hypot(vel[0], vel[1]);
    const sig = `${pos[0].toFixed(3)},${pos[1].toFixed(3)},${pos[2].toFixed(3)},${yaw.toFixed(1)},${pitch.toFixed(1)},` +
      `${crouch.toFixed(2)},${lean.toFixed(2)},${this.hold},${this.weaponModel}`;
    if (sig === this.sig && speed < 0.05 && this.moveWeight < 0.01 && this.kick <= 0 && !this.activeClips.size &&
        this.flinch[2] <= 0) return;
    this.sig = sig;
    this.dirty = true;
    const ch = this.activeClips.size ? this.clipChannels(dt) : {};
    const num = (k: string) => (typeof ch[k] === "number" ? ch[k] as number : 0);
    crouch = Math.max(crouch, num("crouch"));
    let [fp, fr, ft] = this.flinch;
    if (ft > 0) {
      const k = ft / 0.3;
      this.flinch = [fp, fr, Math.max(ft - dt, 0)];
      fp *= k;
      fr *= k;
    } else { fp = fr = 0; }
    this.crouch = crouch;
    this.aimPitch = Math.max(-80, Math.min(80, pitch));
    const moving = onGround ? Math.min(speed / 2, 1) : 0;
    // frame-rate independent easing; at the server's 64 Hz tick it is bit-identical to the old fixed factor
    // (10/64 per tick), so the hit capsules do not change, while a 240 Hz client eases at the same speed
    this.moveWeight += (moving - this.moveWeight) * (1 - Math.pow(1 - 10 / 64, dt * 64));
    const stride = crouch > 0.5 ? 1.0 : walking ? 1.15 : 1.6;
    this.phase = (this.phase + speed * dt / stride * Math.PI) % (2 * Math.PI);
    this.kick = Math.max(this.kick - dt * 8, 0);
    const h = yaw * D;
    const fwd = [-Math.sin(h), Math.cos(h)], right = [Math.cos(h), Math.sin(h)];
    let vf = 1, vs = 0;
    if (speed > 0.1) {
      vf = (vel[0] * fwd[0] + vel[1] * fwd[1]) / speed;
      vs = (vel[0] * right[0] + vel[1] * right[1]) / speed;
    }
    const w = this.moveWeight;
    const amp = crouch > 0.5 ? 16 : walking ? 22 : 32;
    const s = Math.sin(this.phase);
    const bob = Math.abs(Math.cos(this.phase)) * 0.03 * w;
    this.pos[B.pelvis] = [0, 0, STAND_PELVIS + (CROUCH_PELVIS - STAND_PELVIS) * crouch - bob];
    this.hpr[B.pelvis] = [0, 0, vs * s * 4 * w];
    const tilt = -12 * crouch - 4 * w * vf;
    const a = this.aimPitch;
    const roll = Lean.bodyRoll(lean);
    this.hpr[B.spine_01] = [0, tilt + a * 0.25 + fp, roll + fr];
    this.hpr[B.spine_03] = [0, a * 0.30 - this.kick * 3 + num("spine_p"), 0];
    this.hpr[B.neck] = [0, a * 0.45 - tilt + num("neck_p"), -roll * 0.35];
    const hold = HOLDS[this.hold].pos;
    this.pos[B.weapon] = [hold[0] + num("weapon_x"), hold[1] - this.kick * 0.03 + num("weapon_y"), hold[2] + num("weapon_z")];
    const gunP = a * 0.45 + this.kick * 4 + num("weapon_p");
    const gunH = num("weapon_h"), gunR = num("weapon_r");
    this.hpr[B.weapon] = [gunH, gunP, gunR];
    const hipBase = 80 * crouch, kneeBase = -95 * crouch;
    for (const [side, sign] of [["l", 1], ["r", -1]] as const) {
      const swing = s * sign * amp * w;
      this.hpr[B[`thigh_${side}`]] = [0, hipBase + swing * vf, -swing * vs * 0.6];
      const lift = Math.max(0, Math.sin(this.phase + (sign > 0 ? 0 : Math.PI) + 1.2));
      this.hpr[B[`calf_${side}`]] = [0, kneeBase - lift * (crouch < 0.5 ? 40 : 18) * w, 0];
    }
    this.poseArms(gunH, gunP, gunR, ch.hand_l as Channel | undefined, ch.hand_r as Channel | undefined);
  }

  private poseArms(gunH: number, gunP: number, gunR: number, clipL?: Channel, clipR?: Channel): void {
    const g = this.pos[B.weapon];
    const rot = hprMatrix(gunH, gunP, gunR);
    const gunPoint = (p: ArrayLike<number>): V3 => { const v = rotate(p, rot); return [g[0] + v[0], g[1] + v[1], g[2] + v[2]]; };
    const resolve = (target: HandTarget, def: V3): V3 => {
      if (!target) return def;
      const [space, x, y, z] = target;
      return space === "gun" ? gunPoint([x, y, z]) : [x, y, z];
    };
    const blend = (clip: Channel | undefined, def: V3): V3 => {
      if (!clip || typeof clip === "number") return def;
      const [a, b, w] = clip;
      const pa = resolve(a, def), pb = resolve(b, def);
      return [pa[0] + (pb[0] - pa[0]) * w, pa[1] + (pb[1] - pa[1]) * w, pa[2] + (pb[2] - pa[2]) * w];
    };
    let handR = gunPoint(this.grips[0]);
    let handL: V3 = HOLDS[this.hold].hands === 2 ? gunPoint(this.grips[1]) : [-0.22, 0.12, -0.32];
    handL = blend(clipL, handL);
    handR = blend(clipR, handR);
    for (const [side, sx, hand] of [["l", -1, handL], ["r", 1, handR]] as const) {
      const sh: V3 = [SHOULDER[0] * sx, SHOULDER[1], SHOULDER[2]];
      const elbow = twoBoneElbow(sh, hand, UPPER_ARM, FOREARM, [sx * 0.8, -0.3, -1.0]);
      const upper = aimHpr([elbow[0] - sh[0], elbow[1] - sh[1], elbow[2] - sh[2]]);
      this.hpr[B[`upperarm_${side}`]] = upper;
      this.hpr[B[`lowerarm_${side}`]] = relativeHpr(upper, aimHpr([hand[0] - elbow[0], hand[1] - elbow[1], hand[2] - elbow[2]]));
    }
  }

  private animateDeath(dt: number): void {
    if (this.deadT >= 1) return;
    this.deadT = Math.min(this.deadT + dt * 1.8, 1);
    const t = this.deadT * this.deadT;
    this.hpr[B.root] = [0, 86 * t * this.fallDir, 0];
    this.pos[B.root] = [0, 0, 0.13 * t];
    this.pos[B.pelvis] = [0, 0, STAND_PELVIS + (CROUCH_PELVIS - STAND_PELVIS) * Math.min(this.crouch + t * 0.3, 1)];
    for (const side of ["l", "r"]) {
      this.hpr[B[`thigh_${side}`]] = [0, 40 * t * (this.fallDir < 0 ? 1 : 0.4), 0];
      this.hpr[B[`calf_${side}`]] = [0, -60 * t, 0];
    }
    this.hpr[B.spine_03] = [0, -10 * t * this.fallDir, 0];
    this.dirty = true;
  }

  // ------------------------------------------------------------ queries
  rootMatrix(): M4 { return m4PosHpr(this.rootPos, this.rootYaw, 0, 0); }

  /** World matrices of the bones the capsules, the head and the weapon hang on (all = every bone). */
  worldMatrices(all = false): M4[] {
    if (this.world && !this.dirty && (!all || this.worldAll)) return this.world;
    const root = this.rootMatrix();
    const out: M4[] = this.world ?? new Array(N_BONES);
    const local = m4();
    const list = all ? BONES.map((_, i) => i) : NEEDED;
    for (const i of list) {
      const p = this.pos[i], h = this.hpr[i];
      m4PosHpr(p, h[0], h[1], h[2], local);
      const parent = PARENT[i] < 0 ? root : out[PARENT[i]];
      out[i] = m4Mul(local, parent, out[i] ?? new Float64Array(16));
    }
    this.world = out;
    this.worldAll = all;
    this.dirty = false;
    return out;
  }

  capsules(): Capsule[] {
    const w = this.worldMatrices();
    return CAPSULES.map((def) => ({ def, a: m4Point(w[def.bone], def.a), b: m4Point(w[def.bone], def.b) }));
  }

  /** The head's centre in world space (what bots aim at). */
  headPos(): V3 {
    return m4Point(this.worldMatrices()[B.head], [0, 0, 0.065]);
  }

  muzzlePos(): V3 {
    return m4Point(this.worldMatrices()[B.weapon], this.muzzleAnchor);
  }
}
