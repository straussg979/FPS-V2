// The first-person weapon: the weapon model with the team's arms (gloves or bare hands, camo sleeves), hip <-> aim-down-sights pose, sway, bob, recoil
// kick, the draw, and the keyframed reload / bolt / pump / inspect / melee / grenade tracks
// (data/weapon_anims.json). It renders in its own scene with its own field of view after a depth clear (the
// world's post chain's second render pass), lit by a copy of the sun and the environment, so it never clips
// into walls.

import * as THREE from "three";
import animsJson from "../../../data/weapon_anims.json";
import type { World } from "./world";

/* eslint-disable @typescript-eslint/no-explicit-any */
const ANIMS: Record<string, any> = animsJson as any;

class Spring {
  value = new THREE.Vector3();
  vel = new THREE.Vector3();
  constructor(public k: number) {}
  impulse(x: number, y: number, z: number): void { this.vel.x += x; this.vel.y += y; this.vel.z += z; }
  update(dt: number): THREE.Vector3 {
    const damp = 2 * Math.sqrt(this.k);
    const steps = Math.max(1, Math.floor(dt / 0.008) + 1);
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.vel.x += (-this.value.x * this.k - this.vel.x * damp) * h;
      this.vel.y += (-this.value.y * this.k - this.vel.y * damp) * h;
      this.vel.z += (-this.value.z * this.k - this.vel.z * damp) * h;
      this.value.addScaledVector(this.vel, h);
    }
    return this.value;
  }
}

const ease = (t: number) => t * t * (3 - 2 * t);

export function sampleTrack(track: any, channel: string, t: number, dflt: number[] | null): number[] | null {
  const keys = track[channel];
  if (!keys || !keys.length) return dflt;
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, v0] = keys[i], [t1, v1] = keys[i + 1];
    if (t <= t1) {
      if (t1 - t0 < 1e-6) return v1;
      if (channel === "mag_vis") return v0;
      const k = ease((t - t0) / (t1 - t0));
      return v0.map((a: number, j: number) => a + (v1[j] - a) * k);
    }
  }
  return keys[keys.length - 1][1];
}

const d2r = THREE.MathUtils.degToRad;
/** Heading about Z, pitch about X, roll about Y on a Z-up object. */
function setHpr(obj: THREE.Object3D, h: number, p: number, r: number): void {
  obj.rotation.order = "ZXY";
  obj.rotation.set(d2r(p), d2r(r), d2r(h));
}

interface Entry { key: string; root: THREE.Group; groups: Record<string, THREE.Object3D>; rest: Record<string, THREE.Vector3>; armL: THREE.Group | null;
  armLRest: THREE.Vector3 | null; meta: any; anchors: any }

export interface VmContext { ads: number; adsTime: number; mouse: [number, number]; bobPhase: number; bobWeight: number; crouch: number; land: number; aspect: number }

export class Viewmodel {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(54, 1, 0.01, 20);
  private zup = new THREE.Group();
  private anchor = new THREE.Group();
  private pivot = new THREE.Group();
  private sun = new THREE.DirectionalLight(0xffffff, 1);
  private sunSource: THREE.DirectionalLight | null = null;
  baseFov = 54;
  /** Settings > weapon bob and sway (0..1). */
  motionScale = 1;
  private entries = new Map<string, Entry>();
  current: Entry | null = null;
  private cls = "";
  private wanted: string | null = null;
  private kickPos = new Spring(260);
  private kickRot = new Spring(220);
  private sway = new Spring(90);
  private idleT = 0;
  ads = 0;
  private drawT = 1;
  private drawDur = 0.5;
  private track: any = null; private trackT = 0; private trackDur = 1; private trackHold = false;
  private part: any = null; private partT = 0; private partDur = 1;
  private slideBack = 0;
  private slideLocked = false;
  hidden = false;
  private tmpKp = new THREE.Vector3();
  private tmpKr = new THREE.Vector3();

  constructor(private world: World) {
    this.zup.rotation.x = -Math.PI / 2;
    this.scene.add(this.zup);
    this.camera.up.set(0, 0, 1);
    this.zup.add(this.camera);
    this.zup.add(this.anchor);
    // the camera space the model offsets are written in: +Y forward, +Z up
    const pandaCam = new THREE.Group();
    pandaCam.rotation.x = -Math.PI / 2;
    this.anchor.add(pandaCam);
    pandaCam.add(this.pivot);
    this.zup.add(this.sun, this.sun.target);
  }

  syncEnvironment(scene: THREE.Scene, sun: THREE.DirectionalLight): void {
    this.scene.environment = scene.environment;
    this.scene.environmentIntensity = scene.environmentIntensity;
    this.sun.color.copy(sun.color);
    this.sun.intensity = sun.intensity;
    this.sunSource = sun;
  }

  private async entry(key: string): Promise<Entry | null> {
    const hit = this.entries.get(key);
    if (hit) return hit;
    const proto = await this.world.weaponModel(key);
    if (!proto) return null;
    const root = proto.clone();
    root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; } });
    const defs = this.world.weaponDefs;
    const meta = defs[key]?.viewmodel ?? {};
    const anchors = proto.userData.anchors ?? defs[key]?.anchors ?? {};
    const groups: Record<string, THREE.Object3D> = {};
    // the GLB root holds the z-up root node, which holds one node per animation group
    const holder = root.children.length === 1 && root.children[0].children.length ? root.children[0] : root;
    for (const c of holder.children) groups[c.name] = c;
    const rest: Record<string, THREE.Vector3> = {};
    for (const [n, g] of Object.entries(groups)) rest[n] = g.position.clone();
    const hip = meta.offset ?? [0.13, 0.3, -0.15];
    const toGun = (p: number[]) => [p[0] - hip[0], p[1] - hip[1], p[2] - hip[2]];
    root.add(this.arm(anchors.grip_r ?? [0, -0.03, -0.04], toGun(meta.elbow_r ?? [0.28, -0.12, -0.38]), 1));
    let armL: THREE.Group | null = null;
    if (!meta.one_handed) {
      armL = this.arm(anchors.grip_l ?? [0, 0.3, -0.01], toGun(meta.elbow_l ?? [-0.22, 0.02, -0.4]), -1);
      root.add(armL);
    }
    root.visible = false;
    this.pivot.add(root);
    const e: Entry = { key, root, groups, rest, armL, armLRest: armL ? armL.position.clone() : null, meta, anchors };
    this.entries.set(key, e);
    return e;
  }

  /** The arms in the player's team kit: Vanguard gloves and arid camo, Bastion bare hands and olive camo. */
  setKit(team: number): void {
    const k = team === 1 ? 1 : 0;
    if (k === this.kit) return;
    this.kit = k;
    const [hand, sleeve] = this.kitMats();
    for (const m of this.handMeshes) m.material = hand;
    for (const m of this.sleeveMeshes) m.material = sleeve;
  }

  private kit = 0;
  private handMeshes: THREE.Mesh[] = [];
  private sleeveMeshes: THREE.Mesh[] = [];
  private kitMats(): [THREE.Material, THREE.Material] {
    const mats = this.world.materials;
    return this.kit === 1 ? [mats.get("skin_2"), mats.get("camo_olive")] : [mats.get("glove"), mats.get("camo_arid")];
  }

  private arm(hand: number[], elbow: number[], side: number): THREE.Group {
    const [glove, sleeve] = this.kitMats();
    const arm = new THREE.Group();
    arm.position.fromArray(hand);
    const dx = elbow[0] - hand[0], dy = elbow[1] - hand[1], dz = elbow[2] - hand[2];
    const length = Math.hypot(dx, dy, dz);
    const seg = new THREE.Group();
    setHpr(seg, Math.atan2(-dx, dy) * 180 / Math.PI, Math.atan2(dz, Math.hypot(dx, dy)) * 180 / Math.PI, 0);
    arm.add(seg);
    const box = (m: THREE.Material, sx: number, sy: number, sz: number, x: number, y: number, z: number) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), m);
      b.position.set(x, y, z);
      b.frustumCulled = false;
      return b;
    };
    const hands = [box(glove, 0.05, 0.085, 0.045, 0, 0, 0), box(glove, 0.02, 0.075, 0.035, side * -0.03, 0.025, 0),
      box(glove, 0.06, length * 0.36, 0.055, 0, length * 0.18 + 0.04, 0)];
    const sleeves = [box(sleeve, 0.095, length * 0.66, 0.088, 0, length * 0.62, 0),
      box(sleeve, 0.102, 0.05, 0.095, 0, length * 0.3 + 0.02, 0)];          // the cuff
    this.handMeshes.push(...hands);
    this.sleeveMeshes.push(...sleeves);
    seg.add(...hands, ...sleeves);
    return arm;
  }

  async equip(key: string | null, cls: string, drawTime: number): Promise<void> {
    this.wanted = key;
    const e = key ? await this.entry(key) : null;
    if (this.wanted !== key) return;
    if (this.current) this.current.root.visible = false;
    this.current = e;
    this.cls = cls || "";
    if (e) e.root.visible = !this.hidden;
    this.drawT = 0;
    this.drawDur = Math.max(drawTime || 0.5, 0.05);
    this.track = null;
    this.part = null;
    this.slideLocked = false;
    this.kickPos.value.set(0, 0, 0);
    this.kickRot.value.set(0, 0, 0);
  }

  play(name: string, duration: number, hold = false): void {
    this.track = ANIMS[name] ?? null;
    this.trackT = 0;
    this.trackDur = Math.max(duration, 0.01);
    this.trackHold = hold;
  }

  playPart(name: string, duration: number): void {
    this.part = ANIMS[name] ?? null;
    this.partT = 0;
    this.partDur = Math.max(duration, 0.01);
  }

  onFire(punch: number, emptyAfter = false): void {
    const r = (a: number, b: number) => a + Math.random() * (b - a);
    const s = 0.6 + 0.4 * Math.min(punch, 3.0);
    const aim = this.ads > 0.5 ? 0.45 : 1.0;
    this.kickPos.impulse(r(-0.05, 0.05) * aim, -0.9 * s * aim, 0.12 * s * aim);
    this.kickRot.impulse(r(-6, 6) * s * aim, 55.0 * s * aim, r(-12, 12) * s * aim);
    this.slideBack = 1;
    if (emptyAfter && this.cls === "pistol") this.slideLocked = true;
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    if (this.current) this.current.root.visible = !hidden;
  }

  /** The muzzle in game (Z-up) coordinates as it appears on screen (own tracers start there). */
  muzzleWorld(mainCamera: THREE.PerspectiveCamera, depth = 0.6): number[] {
    const camPos = new THREE.Vector3().setFromMatrixPosition(mainCamera.matrixWorld);
    if (!this.current) return [camPos.x, -camPos.z, camPos.y];
    const a = this.current.anchors.muzzle ?? [0, 0.6, 0.03];
    const p = new THREE.Vector3(a[0], a[1], a[2]);
    this.current.root.updateWorldMatrix(true, false);
    p.applyMatrix4(this.current.root.matrixWorld).project(this.camera);
    const ray = new THREE.Vector3(p.x, p.y, 0.5).unproject(mainCamera).sub(camPos).normalize();
    const out = camPos.addScaledVector(ray, depth);
    return [out.x, -out.z, out.y];
  }

  update(dt: number, eye: THREE.Object3D, ctx: VmContext): void {
    this.anchor.position.copy(eye.position);
    this.anchor.quaternion.copy(eye.quaternion);
    this.camera.position.copy(eye.position);
    this.camera.quaternion.copy(eye.quaternion);
    if (this.sunSource) {
      // the world's sun lives in three's Y-up world space; this scene works in Z-up under its root: same direction
      const s = this.sunSource;
      const dx = s.position.x - s.target.position.x, dy = s.position.y - s.target.position.y, dz = s.position.z - s.target.position.z;
      const l = Math.hypot(dx, dy, dz) || 1;
      this.sun.position.set(eye.position.x + dx / l * 10, eye.position.y - dz / l * 10, eye.position.z + dy / l * 10);
      this.sun.target.position.copy(eye.position);
      this.sun.target.updateMatrixWorld();
    }
    const e = this.current;
    this.idleT += dt;
    const step = dt / Math.max(ctx.adsTime || 0.2, 0.05);
    this.ads += Math.max(Math.min((ctx.ads || 0) - this.ads, step), -step);
    const ads = ease(this.ads);
    const fov = this.baseFov * (1 - 0.22 * ads);
    if (Math.abs(this.camera.fov - fov) > 1e-3 || this.camera.aspect !== ctx.aspect) {
      this.camera.fov = fov;
      this.camera.aspect = ctx.aspect;
      this.camera.updateProjectionMatrix();
    }
    if (!e) return;
    const meta = e.meta;
    const hip = meta.offset ?? [0.13, 0.3, -0.15];
    const sight = e.anchors.sight ?? [0, 0.1, 0.1];
    const adsPos = [-sight[0], (meta.ads_distance ?? 0.2) - sight[1], -sight[2]];
    const pos = hip.map((v: number, i: number) => v * (1 - ads) + adsPos[i] * ads);
    const baseHpr = (meta.hpr ?? [0, 0, 0]).map((v: number) => v * (1 - ads));
    const [mdx, mdy] = ctx.mouse;
    const lag = (1 - 0.75 * ads) * this.motionScale;
    this.sway.impulse(mdx * 0.9 * lag, -mdy * 0.9 * lag, mdx * 0.6 * lag);
    const sw = this.sway.update(dt);
    const clamp = (v: number) => Math.max(-6, Math.min(6, v));
    const sway = [clamp(sw.x), clamp(sw.y), clamp(sw.z)];
    const breathe = [Math.sin(this.idleT * 1.1) * 0.0012 * (1 - 0.8 * ads), 0, Math.sin(this.idleT * 1.7) * 0.0015 * (1 - 0.8 * ads)];
    const ph = ctx.bobPhase;
    const w = ctx.bobWeight * (1 - 0.85 * ads) * this.motionScale;
    const bob = [Math.sin(ph) * 0.009 * w, 0, (-Math.abs(Math.sin(ph)) * 0.010 + 0.004) * w];
    const bobRot = [Math.sin(ph) * 0.8 * w, 0, Math.sin(ph) * 1.6 * w];
    const crouch = ctx.crouch * (1 - ads);
    if (this.drawT < 1) this.drawT = Math.min(this.drawT + dt / this.drawDur, 1);
    const d = 1 - Math.pow(1 - this.drawT, 3);
    const drawPos = [0, 0, -0.22 * (1 - d)];
    const drawRot = [0, -55 * (1 - d), 0];
    const kp = this.tmpKp.copy(this.kickPos.update(dt)).multiplyScalar(0.01);
    const kr = this.tmpKr.copy(this.kickRot.update(dt)).multiplyScalar(0.05);
    const swayPos = [-sway[0] * 0.002, 0, -sway[1] * 0.002];
    this.pivot.position.set(pos[0] + swayPos[0] + breathe[0] + bob[0] + drawPos[0] + kp.x, pos[1] + swayPos[1] + breathe[1] + bob[1] + drawPos[1] + kp.y,
      pos[2] + swayPos[2] + breathe[2] + bob[2] + drawPos[2] + kp.z - 0.012 * crouch + ctx.land * 0.25);
    setHpr(this.pivot, baseHpr[0] + sway[0] * 0.6 + bobRot[0] + drawRot[0] + kr.x, baseHpr[1] + sway[1] * 0.5 + bobRot[1] + drawRot[1] + kr.y,
      baseHpr[2] + sway[2] * 0.9 + bobRot[2] + drawRot[2] + kr.z - 4.0 * crouch);
    let gunPos = [0, 0, 0], gunRot = [0, 0, 0];
    const parts: Record<string, number[] | null> = { mag_pos: [0, 0, 0], bolt_pos: [0, 0, 0], pump_pos: [0, 0, 0], slide_pos: null };
    let magVis = 1, handL = 0;
    if (this.track) {
      this.trackT += dt / this.trackDur;
      let t = this.trackT;
      if (t >= 1 && !this.trackHold) this.track = null;
      else {
        t = Math.min(t, 1);
        const tr = this.track;
        gunPos = sampleTrack(tr, "gun_pos", t, gunPos) as number[];
        gunRot = sampleTrack(tr, "gun_rot", t, gunRot) as number[];
        for (const ch of ["mag_pos", "bolt_pos", "pump_pos"]) parts[ch] = sampleTrack(tr, ch, t, parts[ch]);
        if (tr.slide_pos) parts.slide_pos = sampleTrack(tr, "slide_pos", t, [0, 0, 0]);
        magVis = (sampleTrack(tr, "mag_vis", t, [1]) as number[])[0];
        handL = (sampleTrack(tr, "hand_l", t, [0]) as number[])[0];
      }
    }
    if (this.part) {
      this.partT += dt / this.partDur;
      if (this.partT >= 1) this.part = null;
      else {
        for (const ch of ["bolt_pos", "pump_pos"]) {
          const v = sampleTrack(this.part, ch, this.partT, null);
          if (v) parts[ch] = v;
        }
        const gp = sampleTrack(this.part, "gun_pos", this.partT, [0, 0, 0]) as number[];
        const gr = sampleTrack(this.part, "gun_rot", this.partT, [0, 0, 0]) as number[];
        gunPos = gunPos.map((a, i) => a + gp[i]);
        gunRot = gunRot.map((a, i) => a + gr[i]);
      }
    }
    e.root.position.fromArray(gunPos);
    setHpr(e.root, gunRot[0], gunRot[1], gunRot[2]);
    const g = e.groups;
    const add = (name: string, off: number[] | null) => { if (g[name] && off) { g[name].position.copy(e.rest[name]); g[name].position.x += off[0]; g[name].position.y += off[1]; g[name].position.z += off[2]; } };
    if (g.mag) { add("mag", parts.mag_pos); g.mag.visible = magVis >= 0.5; }
    add("bolt", parts.bolt_pos);
    add("pump", parts.pump_pos);
    if (g.slide) {
      this.slideBack = Math.max(this.slideBack - dt / 0.07, 0);
      if (parts.slide_pos) {
        add("slide", parts.slide_pos);
        if (!this.track) this.slideLocked = false;
      } else add("slide", [0, -0.028 * (this.slideLocked ? 1 : Math.sin(this.slideBack * Math.PI * 0.5)), 0]);
    }
    if (e.armL && e.armLRest) {
      const pp = parts.pump_pos as number[];
      const base = g.pump ? e.armLRest.clone().add(new THREE.Vector3(pp[0], pp[1], pp[2])) : e.armLRest.clone();
      if (handL > 0) {
        const m = e.anchors.mag ?? [0, 0.1, -0.08];
        const mp = parts.mag_pos as number[];
        e.armL.position.copy(base.lerp(new THREE.Vector3(m[0] + mp[0] - 0.01, m[1] + mp[1], m[2] + mp[2] - 0.05), handL));
      } else e.armL.position.copy(base);
    }
  }
}
