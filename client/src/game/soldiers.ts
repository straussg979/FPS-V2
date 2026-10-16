// Other soldiers (and the own body seen from a spectator camera): the skinned soldier from the asset build
// (scripts/assets/soldier.ts), posed every frame by the shared skeleton and pose (shared/src/pose.ts) from
// the interpolated snapshot values - walk cycle, crouch, aim pitch, lean, the third-person animation events
// (reload, switch, throw, knife, hit, fire), planting and defusing - so the body is where the server's hit
// capsules are. The kit follows the side (Vanguard tan, Bastion slate), three levels of detail switch by
// distance, the real weapon model sits in the hand, the charge rides on its carrier's back, and a death
// drops the body as a ragdoll (verlet points on the joints, against the level's collision).

import * as THREE from "three";
import { ANIM_EVENTS } from "@cs/shared/codec";
import { MOVEMENT } from "@cs/shared/character";
import { SoldierPose } from "@cs/shared/pose";
import { BONES, INDEX, INV_BIND, N_BONES, PARENT } from "@cs/shared/skeleton";
import type { V3 } from "@cs/shared/math";
import { parseGLB } from "./assets";
import type { World } from "./world";

/* eslint-disable @typescript-eslint/no-explicit-any */
const KIT: Record<string, [string, string]> = {          // material in the GLB -> [Vanguard, Bastion]
  kit_uniform: ["camo_arid", "camo_olive"], kit_vest: ["cordura_coyote", "cordura_ranger"], kit_helmet: ["helmet_coyote", "helmet_coyote"],
  kit_hands: ["glove", "skin"], kit_boots: ["boot_tan", "boot_brown"],
};
const SKINS = ["skin_1", "skin_2", "skin_3", "skin_4"];
const BEARD_CHANCE = [0.35, 0.8];                        // Vanguard, Bastion

/** A small stable hash of the slot, so a soldier keeps the same face all match. */
function looks(slot: number): { skin: string; beard: number } {
  let h = (slot + 1) * 2654435761;
  h = (h ^ (h >>> 15)) >>> 0;
  return { skin: SKINS[h % SKINS.length], beard: ((h >>> 8) % 1000) / 1000 };
}
const LOD_DISTANCE = [14, 32];                          // metres: LOD0 below the first, LOD2 beyond the second
const LOD_HYSTERESIS = 0.08;
const STAND = MOVEMENT.stand_height, CROUCH = MOVEMENT.crouch_height;

type Ray = (a: V3, b: V3) => { pos: V3; normal: V3 } | null;
interface Template { lods: Array<Array<{ geometry: THREE.BufferGeometry; material: string }>> }

export interface SoldierState { fields: any; flags: Record<string, boolean>; weapon: { model: string; cls: string } | null }

// ------------------------------------------------------------------ ragdoll
const RAG = ["pelvis", "spine_03", "head", "upperarm_l", "lowerarm_l", "hand_l", "upperarm_r", "lowerarm_r", "hand_r",
  "thigh_l", "calf_l", "foot_l", "thigh_r", "calf_r", "foot_r"];
const R = Object.fromEntries(RAG.map((n, i) => [n, i])) as Record<string, number>;
const LINKS: Array<[string, string]> = [
  ["pelvis", "spine_03"], ["spine_03", "head"], ["spine_03", "upperarm_l"], ["spine_03", "upperarm_r"], ["upperarm_l", "upperarm_r"],
  ["upperarm_l", "lowerarm_l"], ["lowerarm_l", "hand_l"], ["upperarm_r", "lowerarm_r"], ["lowerarm_r", "hand_r"],
  ["pelvis", "thigh_l"], ["pelvis", "thigh_r"], ["thigh_l", "thigh_r"], ["thigh_l", "calf_l"], ["calf_l", "foot_l"], ["thigh_r", "calf_r"], ["calf_r", "foot_r"],
  // braces that keep the torso a torso
  ["upperarm_l", "thigh_l"], ["upperarm_r", "thigh_r"], ["upperarm_l", "thigh_r"], ["upperarm_r", "thigh_l"], ["head", "upperarm_l"], ["head", "upperarm_r"],
  ["spine_03", "thigh_l"], ["spine_03", "thigh_r"],
];
// joints may bend but not fold flat: these pairs keep at least this fraction of their rest distance
const MIN_LINKS: Array<[string, string, number]> = [
  ["thigh_l", "foot_l", 0.82], ["thigh_r", "foot_r", 0.82], ["upperarm_l", "hand_l", 0.6], ["upperarm_r", "hand_r", 0.6],
  ["pelvis", "head", 0.95], ["pelvis", "foot_l", 0.7], ["pelvis", "foot_r", 0.7],
];
// limb bones swung by the ragdoll: bone -> [joint particle, child particle]
const SEGMENTS: Record<string, [string, string]> = {
  upperarm_l: ["upperarm_l", "lowerarm_l"], lowerarm_l: ["lowerarm_l", "hand_l"], upperarm_r: ["upperarm_r", "lowerarm_r"], lowerarm_r: ["lowerarm_r", "hand_r"],
  thigh_l: ["thigh_l", "calf_l"], calf_l: ["calf_l", "foot_l"], thigh_r: ["thigh_r", "calf_r"], calf_r: ["calf_r", "foot_r"],
};

class Ragdoll {
  x: THREE.Vector3[] = []; px: THREE.Vector3[] = []; x0: THREE.Vector3[] = [];
  rest: number[] = [];
  minRest: number[] = [];
  m0: THREE.Matrix4[] = [];
  t = 0;
  private acc = 0;
  private static tmp = new THREE.Vector3();
  private f0 = new THREE.Matrix4();

  constructor(world: ArrayLike<number>[], vel: V3, yaw: number) {
    this.m0 = world.map((m) => new THREE.Matrix4().fromArray(m as number[]));
    const h = (yaw * Math.PI) / 180;
    const back = new THREE.Vector3(Math.sin(h), -Math.cos(h), 0);          // fall away from where they faced
    const sub = 1 / 180;
    for (const n of RAG) {
      const p = new THREE.Vector3().setFromMatrixPosition(this.m0[INDEX[n]]);
      const v = new THREE.Vector3(vel[0], vel[1], vel[2]);
      // the upper body is pushed back and the feet stay: the body tips over instead of dropping straight down
      const k = n === "head" ? 1 : n === "spine_03" || n.startsWith("upperarm") ? 0.85 : n.startsWith("lowerarm") || n.startsWith("hand") ? 0.7 : n === "pelvis" ? 0.35 : 0;
      v.addScaledVector(back, 2.4 * k).add(new THREE.Vector3((Math.random() - 0.5) * 0.5 * k, (Math.random() - 0.5) * 0.5 * k, 0));
      this.x.push(p.clone());
      this.x0.push(p.clone());
      this.px.push(p.clone().addScaledVector(v, -sub));
    }
    this.rest = LINKS.map(([a, b]) => this.x[R[a]].distanceTo(this.x[R[b]]));
    this.minRest = MIN_LINKS.map(([a, b, f]) => this.x[R[a]].distanceTo(this.x[R[b]]) * f);
    this.f0 = this.frame(this.x0);
  }

  /** Torso frame from pelvis, chest and hips: x right, z up the spine. */
  private frame(x: THREE.Vector3[]): THREE.Matrix4 {
    const z = x[R.spine_03].clone().sub(x[R.pelvis]).normalize();
    const r = x[R.thigh_r].clone().sub(x[R.thigh_l]);
    const xa = r.addScaledVector(z, -r.dot(z)).normalize();
    const y = new THREE.Vector3().crossVectors(z, xa);
    return new THREE.Matrix4().makeBasis(xa, y, z);
  }

  /** Verlet integration at a fixed 180 Hz sub-step (an accumulator), so a body falls the same way at 60 and 240 fps:
   *  the old per-frame sub-steps made the damping, friction and constraint stiffness depend on the frame rate. */
  step(dt: number, ray: Ray | null): void {
    if (this.t > 5) return;                                  // settled: stop simulating
    this.t += dt;
    this.acc = Math.min(this.acc + dt, 0.1);
    const h = 1 / 180;
    const d = Ragdoll.tmp, gz = -9.81 * h * h;
    while (this.acc >= h) {
      this.acc -= h;
      for (let i = 0; i < this.x.length; i++) {
        const x = this.x[i], p = this.px[i];
        d.copy(x).sub(p).multiplyScalar(0.995);
        p.copy(x);
        x.add(d);
        x.z += gz;
      }
      for (let it = 0; it < 6; it++) {
        for (let k = 0; k < LINKS.length; k++) {
          const xa = this.x[R[LINKS[k][0]]], xb = this.x[R[LINKS[k][1]]];
          d.copy(xb).sub(xa);
          const l = d.length() || 1e-6;
          d.multiplyScalar((l - this.rest[k]) / l * 0.5);
          xa.add(d);
          xb.sub(d);
        }
        for (let k = 0; k < MIN_LINKS.length; k++) {
          const xa = this.x[R[MIN_LINKS[k][0]]], xb = this.x[R[MIN_LINKS[k][1]]];
          d.copy(xb).sub(xa);
          const l = d.length() || 1e-6;
          if (l >= this.minRest[k]) continue;
          d.multiplyScalar((l - this.minRest[k]) / l * 0.5);
          xa.add(d);
          xb.sub(d);
        }
      }
      if (ray) {
        for (let i = 0; i < this.x.length; i++) {
          const x = this.x[i], p = this.px[i];
          const r = i === R.head ? 0.11 : 0.07;
          const hit = ray([p.x, p.y, p.z + 0.02], [x.x, x.y, x.z - r]);
          if (hit) {                                         // stop on the floor or a wall, with friction
            x.set(hit.pos[0] + hit.normal[0] * r, hit.pos[1] + hit.normal[1] * r, hit.pos[2] + hit.normal[2] * r);
            p.lerp(x, 0.6);
          }
        }
      }
    }
  }

  /** Bone matrices: the torso turns rigidly, the limbs swing to their particles, everything else follows. */
  matrices(out: THREE.Matrix4[]): void {
    const ft = this.frame(this.x);
    const rot = ft.clone().multiply(this.f0.clone().transpose());
    const pivot = (m0: THREE.Matrix4, r: THREE.Matrix4, from: THREE.Vector3, to: THREE.Vector3) =>
      new THREE.Matrix4().makeTranslation(to.x, to.y, to.z).multiply(r).multiply(new THREE.Matrix4().makeTranslation(-from.x, -from.y, -from.z)).multiply(m0);
    for (let i = 0; i < N_BONES; i++) {
      const name = BONES[i].name;
      const seg = SEGMENTS[name];
      if (name === "pelvis" || name === "root") out[i].copy(pivot(this.m0[i], rot, this.x0[R.pelvis], this.x[R.pelvis]));
      else if (seg) {
        const [j, c] = [R[seg[0]], R[seg[1]]];
        const a0 = this.x0[c].clone().sub(this.x0[j]).normalize().applyMatrix4(new THREE.Matrix4().extractRotation(rot));
        const a1 = this.x[c].clone().sub(this.x[j]).normalize();
        const swing = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(a0, a1));
        out[i].copy(pivot(this.m0[i], swing.multiply(rot), this.x0[j], this.x[j]));
      } else {
        const p = PARENT[i];
        out[i].copy(out[p]).multiply(this.m0[p].clone().invert()).multiply(this.m0[i]);
      }
    }
  }
}

// ------------------------------------------------------------------ soldier
export class Soldier {
  root = new THREE.Group();
  pose = new SoldierPose();
  bones: THREE.Bone[] = [];
  private skeleton: THREE.Skeleton;
  private lods: THREE.SkinnedMesh[][] = [];
  private weaponKey: string | null = null;
  private lastEvent = -1;
  private planting = false;
  private defusing = false;
  private ragdoll: Ragdoll | null = null;
  private charge: THREE.Object3D | null = null;
  private chargeWanted = false;
  private ragMats: THREE.Matrix4[] = Array.from({ length: N_BONES }, () => new THREE.Matrix4());
  alive = true;
  private lod = 0;
  private lodApplied = false;
  pos: V3 = [0, 0, 0];
  yaw = 0;
  vel: V3 = [0, 0, 0];

  constructor(public slot: number, public team: number, private world: World, private soldiers: Soldiers) {
    this.root.name = `soldier:${slot}`;
    for (let i = 0; i < N_BONES; i++) {
      const b = new THREE.Bone();
      b.name = BONES[i].name;
      b.matrixAutoUpdate = false;
      this.bones.push(b);
      this.root.add(b);
    }
    this.skeleton = new THREE.Skeleton(this.bones, INV_BIND.map((m) => new THREE.Matrix4().fromArray(m as unknown as number[])));
    void soldiers.template.then((t) => { if (t) this.dress(t); });
  }

  /** The skinned meshes for each level of detail, in the team's kit: its own "a:" (Vanguard) or "d:" (Bastion)
   * parts, the kit materials, and this soldier's skin tone and beard. */
  private dress(t: Template): void {
    const side = this.team === 1 ? 1 : 0;
    const mats = this.world.materials;
    const me = looks(this.slot);
    const resolve = (name: string): string | null => {
      const m = /^([ad]):(.*)$/.exec(name);
      if (m) {
        if ((m[1] === "a") !== (side === 0)) return null;
        name = m[2];
      }
      if (name === "opt_beard") {
        if (me.beard >= BEARD_CHANCE[side]) return null;
        name = "hair";
      }
      if (KIT[name]) name = KIT[name][side];
      return name === "skin" ? me.skin : name;
    };
    this.lods = t.lods.map((prims, level) => prims.map(({ geometry, material }) => ({ geometry, mat: resolve(material) }))
      .filter((p): p is { geometry: THREE.BufferGeometry; mat: string } => p.mat !== null).map(({ geometry, mat }) => {
      const m = new THREE.SkinnedMesh(geometry, mats.get(mat));
      m.bind(this.skeleton, new THREE.Matrix4());
      m.frustumCulled = false;                               // the bones move it, not its own transform
      m.castShadow = level < 2;
      m.receiveShadow = true;
      m.visible = level === 0;
      this.root.add(m);
      return m;
    }));
  }

  private async setWeapon(w: { model: string; cls: string } | null): Promise<void> {
    const key = w ? w.model : null;
    if (key === this.weaponKey) return;
    this.weaponKey = key;
    this.pose.setWeapon(key, w ? w.cls : "rifle");
    const holder = this.bones[INDEX.weapon];
    for (const c of [...holder.children]) holder.remove(c);
    if (!key) return;
    const proto = await this.world.weaponModel(key);
    if (!proto || this.weaponKey !== key) return;
    const gun = proto.clone();
    gun.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    holder.add(gun);
  }

  /** The charge on the back of the plate carrier while this soldier carries it (attackers and spectators see it). */
  private async setCharge(on: boolean): Promise<void> {
    if (on === this.chargeWanted) return;
    this.chargeWanted = on;
    if (on && !this.charge) {
      const proto = await this.world.weaponModel("bomb_charge");
      if (!proto) return;
      this.charge = proto.clone();
      this.charge.rotation.set(Math.PI / 2, 0, 0);
      this.charge.position.set(0, -0.03, 0.02);
      this.bones[INDEX.pack].add(this.charge);
    }
    if (this.charge) this.charge.visible = this.chargeWanted;
  }

  update(st: SoldierState, dt: number, camPos: THREE.Vector3, ray: Ray | null): void {
    const s = st.fields, flags = st.flags;
    const alive = !!flags.alive;
    void this.setWeapon(alive ? st.weapon : null);
    void this.setCharge(alive && !!flags.charge);
    if (alive && !this.alive) { this.pose.reset(); this.ragdoll = null; }
    if (!alive && this.alive) {
      // the body falls as a ragdoll from the pose it died in
      this.ragdoll = new Ragdoll(this.pose.worldMatrices(true), this.vel, this.yaw);
    }
    this.alive = alive;
    const ev = s.event ?? 0;
    if (this.lastEvent >= 0 && ev !== this.lastEvent && alive) {
      const kind = ANIM_EVENTS[ev & 7];
      if (kind) this.pose.event(kind);
    }
    this.lastEvent = ev;
    for (const [flag, clip] of [["planting", "plant"], ["defusing", "defuse"]] as const) {
      const on = !!flags[flag];
      const was = flag === "planting" ? this.planting : this.defusing;
      if (on && !was) this.pose.event(clip);
      if (!on && was) this.pose.stop(clip);
      if (flag === "planting") this.planting = on;
      else this.defusing = on;
    }
    if (this.ragdoll) {
      this.ragdoll.step(dt, ray);
      this.ragdoll.matrices(this.ragMats);
      for (let i = 0; i < N_BONES; i++) { this.bones[i].matrix.copy(this.ragMats[i]); this.bones[i].matrixWorldNeedsUpdate = true; }
      const p = this.ragdoll.x[R.pelvis];
      this.pos[0] = p.x; this.pos[1] = p.y; this.pos[2] = p.z;
    } else {
      const height = 1.0 + (s.height ?? 0.8);
      const crouch = Math.min(1, Math.max(0, (STAND - height) / (STAND - CROUCH)));
      this.pos[0] = s.pos[0]; this.pos[1] = s.pos[1]; this.pos[2] = s.pos[2];
      this.yaw = s.yaw ?? 0;
      if (s.vel) { this.vel[0] = s.vel[0]; this.vel[1] = s.vel[1]; this.vel[2] = s.vel[2]; } else this.vel[0] = this.vel[1] = this.vel[2] = 0;
      this.pose.animate(dt, s.pos, s.yaw, s.pitch ?? 0, crouch, s.vel ?? [0, 0, 0], !!flags.on_ground, !!flags.walking, s.lean ?? 0);
      const w = this.pose.worldMatrices(true);
      for (let i = 0; i < N_BONES; i++) {
        this.bones[i].matrix.fromArray(w[i] as unknown as number[]);
        this.bones[i].matrixWorldNeedsUpdate = true;
      }
    }
    // level of detail by distance to the camera
    // with hysteresis: a level changes only once the distance is 8 % past its switch point, so a soldier standing
    // at the switch distance does not flicker between two levels. Every level shares the one skeleton posed above,
    // so the level shown is always this frame's pose.
    const d = Math.hypot(this.pos[0] - camPos.x, this.pos[1] - camPos.y, this.pos[2] - camPos.z);
    let level = this.lod;
    while (level < 2 && d > LOD_DISTANCE[level] * (1 + LOD_HYSTERESIS)) level++;
    while (level > 0 && d < LOD_DISTANCE[level - 1] * (1 - LOD_HYSTERESIS)) level--;
    if (level !== this.lod || !this.lodApplied) {
      this.lod = level;
      this.lodApplied = this.lods.length > 0;
      for (let i = 0; i < this.lods.length; i++) for (const m of this.lods[i]) m.visible = i === level;
    }
  }

  fire(): void { this.pose.event("fire"); }

  showAllLods(): void { for (const meshes of this.lods) for (const m of meshes) m.visible = true; }

  muzzle(): V3 { return this.pose.muzzlePos(); }
}

export class Soldiers {
  parent = new THREE.Group();
  bySlot = new Map<number, Soldier>();
  template: Promise<Template | null>;
  /** The level's collision ray (for ragdolls). */
  ray: Ray | null = null;

  constructor(private world: World) {
    this.parent.name = "soldiers";
    world.root.add(this.parent);
    this.template = this.load();
  }

  private async load(): Promise<Template | null> {
    const url = this.world.assets.manifest?.soldier;
    if (!url) return null;
    const glb = parseGLB(await this.world.assets.buffer(url));
    const lods: Template["lods"] = [];
    glb.nodes.forEach((n) => {
      if (n.mesh && typeof n.extras.lod === "number") lods[n.extras.lod] = n.mesh.map((p) => ({ geometry: p.geometry, material: p.material.name }));
    });
    return { lods };
  }

  get(slot: number, team: number): Soldier {
    let s = this.bySlot.get(slot);
    if (s && s.team !== team && team !== 255) {
      this.parent.remove(s.root);
      s = undefined;
    }
    if (!s) {
      s = new Soldier(slot, team, this.world, this);
      this.bySlot.set(slot, s);
      this.parent.add(s.root);
    }
    return s;
  }

  /** states: slot -> state; hide: the slot not to draw (the own body in first person). */
  update(states: Map<number, SoldierState>, dt: number, hide: number): void {
    const cam = this.world.camera.position;
    for (const [slot, st] of states) {
      const s = this.get(slot, st.fields.team);
      s.root.visible = slot !== hide;
      s.update(st, dt, cam, this.ray);
    }
    for (const [slot, s] of this.bySlot) {
      if (!states.has(slot)) {
        this.parent.remove(s.root);
        this.bySlot.delete(slot);
      }
    }
  }

  muzzleOf(slot: number): V3 | null { return this.bySlot.get(slot)?.muzzle() ?? null; }

  /** Shader warm-up: one soldier of each side with every level of detail visible, so their skinned programs (and
   *  shadow programs) are compiled while the map loads, not when the first player walks into view. */
  async warmupObjects(): Promise<THREE.Object3D[]> {
    const t = await this.template;
    if (!t) return [];
    const out: THREE.Object3D[] = [];
    for (const team of [0, 1]) {
      const s = new Soldier(-100 - team, team, this.world, this);
      await Promise.resolve();
      s.showAllLods();
      const w = s.pose.worldMatrices(true);
      s.bones.forEach((b, i) => { b.matrix.fromArray(w[i] as unknown as number[]); b.matrixWorldNeedsUpdate = true; });
      out.push(s.root);
    }
    return out;
  }
}
