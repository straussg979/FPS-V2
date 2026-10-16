// Effects in the game world (Z-up): tracers, muzzle flashes, impact dust and sparks by surface, bullet holes,
// explosions, flashbangs, smoke clouds, and the server's world entities drawn as models (grenades, the
// charge, pickups, gadgets, drones).

import * as THREE from "three";
import { LAYER_FX, type World } from "./world";
import { depthBias } from "./depth";

/* eslint-disable @typescript-eslint/no-explicit-any */
function softDisc(size = 64, hard = 0): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (x + 0.5) / size * 2 - 1, dy = (y + 0.5) / size * 2 - 1;
    const v = Math.pow(Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy)), 1.6 - hard);
    const i = (y * size + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 255;
    data[i + 3] = Math.round(v * 255);
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.needsUpdate = true;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  return t;
}

/** A soft, ragged dark disc for blast marks. */
function scorchTexture(size = 128): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (x + 0.5) / size * 2 - 1, dy = (y + 0.5) / size * 2 - 1;
    const r = Math.hypot(dx, dy), a = Math.atan2(dy, dx);
    const edge = 0.75 + 0.12 * Math.sin(a * 7) + 0.06 * Math.sin(a * 17 + 1.3);
    const t = Math.max(0, 1 - r / edge);
    const i = (y * size + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 12;
    data[i + 3] = Math.round(255 * Math.min(1, t * 1.6) * 0.85);
  }
  const t = new THREE.DataTexture(data, size, size);
  t.needsUpdate = true;
  return t;
}

function holeTexture(size = 64): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (x + 0.5) / size * 2 - 1, dy = (y + 0.5) / size * 2 - 1;
    const r = Math.sqrt(dx * dx + dy * dy);
    const i = (y * size + x) * 4;
    const core = r < 0.28 ? 1 : 0;
    const ring = Math.max(0, 1 - Math.abs(r - 0.42) / 0.2) * 0.55 * (0.7 + 0.3 * Math.sin(Math.atan2(dy, dx) * 7));
    data[i] = data[i + 1] = data[i + 2] = core ? 10 : 40;
    data[i + 3] = Math.round(Math.min(1, Math.max(core, ring)) * 255 * (r < 1 ? 1 : 0));
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.needsUpdate = true;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface SpawnOpts { life?: number; size?: number; size1?: number | null; color?: number[]; alpha?: number; drag?: number; gravity?: number }

/** A pool of camera-facing particles in one Points object. */
class ParticlePool {
  pos: Float32Array; col: Float32Array; vel: Float32Array; life: Float32Array; age: Float32Array;
  size0: Float32Array; size1: Float32Array; alpha0: Float32Array; drag: Float32Array; grav: Float32Array; sizes: Float32Array;
  next = 0;
  points: THREE.Points;
  geometry: THREE.BufferGeometry;

  constructor(parent: THREE.Object3D, public count: number, o: { additive?: boolean; texture: THREE.Texture }) {
    this.pos = new Float32Array(count * 3);
    this.col = new Float32Array(count * 4);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.age = new Float32Array(count);
    this.size0 = new Float32Array(count);
    this.size1 = new Float32Array(count);
    this.alpha0 = new Float32Array(count);
    this.drag = new Float32Array(count);
    this.grav = new Float32Array(count);
    this.sizes = new Float32Array(count);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(this.col, 4));
    g.setAttribute("psize", new THREE.BufferAttribute(this.sizes, 1));
    const material = new THREE.ShaderMaterial({
      uniforms: { map: { value: o.texture }, scale: { value: 600 } },
      vertexShader: /* glsl */`
        attribute float psize; attribute vec4 color; varying vec4 vColor; uniform float scale;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = psize * scale / max(-mv.z, 0.05);
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D map; varying vec4 vColor;
        void main() {
          vec4 t = texture2D(map, gl_PointCoord);
          gl_FragColor = vec4(vColor.rgb, vColor.a * t.a);
          if (gl_FragColor.a < 0.004) discard;
        }`,
      transparent: true, depthWrite: false, blending: o.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = o.additive ? 3 : 2;
    parent.add(this.points);
    this.geometry = g;
  }

  spawn(p: ArrayLike<number>, v: ArrayLike<number>, o: SpawnOpts = {}): void {
    const i = this.next;
    this.next = (this.next + 1) % this.count;
    this.pos.set([p[0], p[1], p[2]], i * 3);
    this.vel.set([v[0], v[1], v[2]], i * 3);
    this.life[i] = o.life ?? 0.5;
    this.age[i] = 0;
    this.size0[i] = o.size ?? 0.1;
    this.size1[i] = o.size1 ?? o.size ?? 0.1;
    this.alpha0[i] = o.alpha ?? 1;
    this.drag[i] = o.drag ?? 1.5;
    this.grav[i] = o.gravity ?? 0;
    const c = o.color ?? [1, 1, 1];
    this.col.set([c[0], c[1], c[2], this.alpha0[i]], i * 4);
    this.idle = false;
  }

  private idle = false;

  update(dt: number, viewportHeight: number, fov: number): void {
    (this.points.material as THREE.ShaderMaterial).uniforms.scale.value = viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2));
    // an empty pool uploads nothing (it used to re-send every buffer every frame)
    if (this.idle) return;
    let live = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) { this.sizes[i] = 0; continue; }
      this.age[i] += dt;
      const t = this.age[i] / this.life[i];
      if (t >= 1) { this.life[i] = 0; this.sizes[i] = 0; this.col[i * 4 + 3] = 0; continue; }
      const k = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= k; this.vel[i * 3 + 1] *= k; this.vel[i * 3 + 2] = this.vel[i * 3 + 2] * k - this.grav[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.sizes[i] = this.size0[i] + (this.size1[i] - this.size0[i]) * t;
      this.col[i * 4 + 3] = this.alpha0[i] * (1 - t) * (t < 0.1 ? t / 0.1 : 1);
      live++;
    }
    const a = this.geometry.attributes;
    a.position.needsUpdate = true;
    a.color.needsUpdate = true;
    a.psize.needsUpdate = true;
    if (live === 0) this.idle = true;
  }
}

const SURFACE_LOOK: Record<string, { dust: number[]; sparks: number; blood?: boolean }> = {
  concrete: { dust: [0.62, 0.6, 0.56], sparks: 0 }, plaster: { dust: [0.78, 0.76, 0.7], sparks: 0 },
  brick: { dust: [0.58, 0.38, 0.3], sparks: 0 }, wood: { dust: [0.5, 0.38, 0.24], sparks: 0 },
  metal: { dust: [0.4, 0.4, 0.42], sparks: 6 }, metal_grate: { dust: [0.4, 0.4, 0.42], sparks: 5 },
  reinforced: { dust: [0.4, 0.4, 0.42], sparks: 8 }, dirt: { dust: [0.45, 0.37, 0.27], sparks: 0 },
  gravel: { dust: [0.55, 0.52, 0.47], sparks: 0 }, sand: { dust: [0.7, 0.62, 0.46], sparks: 0 },
  glass: { dust: [0.8, 0.85, 0.9], sparks: 0 }, fabric: { dust: [0.4, 0.4, 0.36], sparks: 0 },
  flesh: { dust: [0.45, 0.06, 0.05], sparks: 0, blood: true }, tile: { dust: [0.8, 0.8, 0.78], sparks: 0 },
};

const ONE = new THREE.Vector3(1, 1, 1);

export interface EntityDraw { id: number; key: string | null; pos: number[]; yaw?: number; roll?: number }

export class Effects {
  group = new THREE.Group();
  private sparks: ParticlePool; private dust: ParticlePool; private smokePool: ParticlePool; private flashes: ParticlePool;
  private tracerMax = 64;
  private tracerPos: Float32Array; private tracerCol: Float32Array; private tracerGeo: THREE.BufferGeometry;
  private tracers: Array<{ a: number[]; b: number[]; t: number; life: number }> = [];
  private holes: THREE.InstancedMesh; private holeMax = 256; private holeNext = 0;
  private flashLight = new THREE.PointLight(0xffb060, 0, 9, 2);
  private flashT = 0;
  private models = new Map<number, { obj: THREE.Group; key: string | null }>();
  private smokeClouds = new Map<number, { t: number; emitted: number }>();
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private scorch: THREE.InstancedMesh; private scorchMax = 24; private scorchNext = 0;
  private brass: THREE.InstancedMesh; private brassMax = 48;
  private casings: Array<{ p: THREE.Vector3; v: THREE.Vector3; r: THREE.Euler; spin: THREE.Vector3; floor: number; life: number; bounces: number }> = [];
  /** Height of the floor under a point (the game ray-casts its collision world). */
  floorAt: ((p: number[]) => number | null) | null = null;

  constructor(private world: World) {
    this.group.name = "effects";
    world.root.add(this.group);
    const disc = softDisc(64);
    this.sparks = new ParticlePool(this.group, 400, { additive: true, texture: softDisc(32, 1.2) });
    this.dust = new ParticlePool(this.group, 600, { texture: disc });
    this.smokePool = new ParticlePool(this.group, 900, { texture: disc });
    this.flashes = new ParticlePool(this.group, 64, { additive: true, texture: disc });
    const tg = new THREE.BufferGeometry();
    this.tracerPos = new Float32Array(this.tracerMax * 6);
    this.tracerCol = new Float32Array(this.tracerMax * 8);
    tg.setAttribute("position", new THREE.BufferAttribute(this.tracerPos, 3));
    tg.setAttribute("color", new THREE.BufferAttribute(this.tracerCol, 4));
    this.tracerGeo = tg;
    const lines = new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    lines.frustumCulled = false;
    this.group.add(lines);
    // decals: a polygon offset toward the camera whose sign follows the depth mode (depth.ts), small because the hole
    // already sits on the visible surface (placeDecal)
    const holeMat = new THREE.MeshBasicMaterial({ map: holeTexture(), transparent: true, depthWrite: false });
    depthBias(holeMat, 2, 2);
    this.holes = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.06, 0.06), holeMat, this.holeMax);
    this.holes.count = 0;
    this.holes.frustumCulled = false;
    this.group.add(this.holes);
    this.group.add(this.flashLight);
    // blast marks: a dark scorch on the floor under an explosion
    const scorchMat = new THREE.MeshBasicMaterial({ map: scorchTexture(), transparent: true, depthWrite: false });
    depthBias(scorchMat, 2, 2);
    this.scorch = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), scorchMat, this.scorchMax);
    this.scorch.count = 0;
    this.scorch.frustumCulled = false;
    this.group.add(this.scorch);
    // ejected brass that bounces
    this.brass = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.0055, 0.0055, 0.022, 6).rotateZ(Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0xc8a050, metalness: 0.9, roughness: 0.35 }), this.brassMax);
    this.brass.count = 0;
    this.brass.frustumCulled = false;
    this.group.add(this.brass);
    // particles, tracers and decals are drawn by the main camera but kept out of the SSAO pre-pass
    for (const o of [this.sparks.points, this.dust.points, this.smokePool.points, this.flashes.points, lines, this.holes, this.scorch, this.brass]) o.layers.set(LAYER_FX);
  }

  /** A spent casing thrown from `pos` with velocity `v` (m/s, game axes). */
  eject(pos: number[], v: number[]): void {
    if (this.casings.length >= this.brassMax) this.casings.shift();
    const floor = this.floorAt ? this.floorAt(pos) : null;
    this.casings.push({ p: new THREE.Vector3(pos[0], pos[1], pos[2]), v: new THREE.Vector3(v[0], v[1], v[2]),
      r: new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6),
      spin: new THREE.Vector3((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30),
      floor: floor ?? pos[2] - 1.6, life: 4, bounces: 0 });
  }

  private updateBrass(dt: number): void {
    let keep = 0;
    for (const c of this.casings) if ((c.life -= dt) > 0) this.casings[keep++] = c;
    this.casings.length = keep;
    let i = 0;
    for (const c of this.casings) {
      if (c.bounces < 3) {
        c.v.z -= 9.81 * dt;
        c.p.addScaledVector(c.v, dt);
        c.r.x += c.spin.x * dt; c.r.y += c.spin.y * dt; c.r.z += c.spin.z * dt;
        if (c.p.z < c.floor + 0.005) {                      // bounce, losing most of the energy
          c.p.z = c.floor + 0.005;
          c.v.z = -c.v.z * 0.35;
          c.v.x *= 0.5; c.v.y *= 0.5;
          c.spin.multiplyScalar(0.5);
          if (++c.bounces >= 3) { c.r.x = Math.PI / 2 * Math.round(c.r.x / (Math.PI / 2)); c.r.y = 0; }
        }
      }
      this.m4.compose(c.p, this.q.setFromEuler(c.r), ONE);
      this.brass.setMatrixAt(i++, this.m4);
    }
    this.brass.count = i;
    if (i) this.brass.instanceMatrix.needsUpdate = true;
  }

  private scorchMark(pos: number[], size: number): void {
    const floor = this.floorAt ? this.floorAt(pos) : null;
    if (floor === null || pos[2] - floor > 2.5) return;
    const i = this.scorchNext;
    this.scorchNext = (this.scorchNext + 1) % this.scorchMax;
    this.scorch.count = Math.max(this.scorch.count, i + 1);
    this.q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.random() * Math.PI * 2);
    this.m4.compose(new THREE.Vector3(pos[0], pos[1], floor + 0.01), this.q, new THREE.Vector3(size, size, 1));
    this.scorch.setMatrixAt(i, this.m4);
    this.scorch.instanceMatrix.needsUpdate = true;
  }

  tracer(a: number[], b: number[]): void {
    if (this.tracers.length >= this.tracerMax) this.tracers.shift();
    const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    this.tracers.push({ a: a.slice(), b: b.slice(), t: 0, life: Math.min(0.12 + d / 400, 0.3) });
  }

  muzzleFlash(p: number[], dir: number[], scale = 1): void {
    const s = 0.12 * scale;
    this.flashes.spawn(p, [0, 0, 0], { life: 0.05, size: s * 2.4, size1: s * 1.2, color: [1, 0.75, 0.4], alpha: 1, drag: 0 });
    this.flashes.spawn([p[0] + dir[0] * 0.08, p[1] + dir[1] * 0.08, p[2] + dir[2] * 0.08], [0, 0, 0], { life: 0.04, size: s * 1.6, color: [1, 0.85, 0.55], alpha: 0.9, drag: 0 });
    this.flashLight.position.set(p[0], p[1], p[2]);
    this.flashLight.intensity = Math.max(this.flashLight.intensity, 6 * scale);
    this.flashT = 0.05;
  }

  impact(pos: number[], n: number[], surface: string): void {
    const look = SURFACE_LOOK[surface] ?? SURFACE_LOOK.concrete;
    for (let i = 0; i < 5; i++) {
      const v = [n[0] * (0.6 + Math.random()) + (Math.random() - 0.5) * 0.8, n[1] * (0.6 + Math.random()) + (Math.random() - 0.5) * 0.8,
        n[2] * (0.6 + Math.random()) + (Math.random() - 0.5) * 0.8 + 0.3];
      this.dust.spawn(pos, v, { life: 0.5 + Math.random() * 0.5, size: 0.05, size1: 0.22 + Math.random() * 0.1, color: look.dust,
        alpha: look.blood ? 0.9 : 0.55, drag: 3.5, gravity: look.blood ? 6 : 0.4 });
    }
    for (let i = 0; i < look.sparks; i++) {
      this.sparks.spawn(pos, [n[0] * 3 + (Math.random() - 0.5) * 5, n[1] * 3 + (Math.random() - 0.5) * 5, n[2] * 3 + Math.random() * 3],
        { life: 0.15 + Math.random() * 0.2, size: 0.025, color: [1, 0.75, 0.35], alpha: 1, drag: 1, gravity: 9 });
    }
    if (surface !== "flesh" && surface !== "glass") this.hole(pos, n, surface);
  }

  /** Where a decal really goes (main.ts): kept inside the face it hit, moved onto the visible (displaced) surface;
   *  null skips it. Without a hook the hole goes 4 mm out from the hit point. */
  placeDecal: ((pos: number[], n: number[], surface: string, radius: number) => { pos: number[]; radius: number } | null) | null = null;

  private hole(pos: number[], n: number[], surface = "concrete"): void {
    const s0 = 0.7 + Math.random() * 0.6;
    const placed = this.placeDecal ? this.placeDecal(pos, n, surface, 0.03 * s0) : { pos: [pos[0] + n[0] * 0.004, pos[1] + n[1] * 0.004, pos[2] + n[2] * 0.004], radius: 0.03 * s0 };
    if (!placed) return;
    pos = placed.pos;
    const i = this.holeNext;
    this.holeNext = (this.holeNext + 1) % this.holeMax;
    this.holes.count = Math.max(this.holes.count, i + 1);
    const normal = new THREE.Vector3(n[0], n[1], n[2]).normalize();
    this.q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    this.q.premultiply(new THREE.Quaternion().setFromAxisAngle(normal, Math.random() * Math.PI * 2));
    const s = placed.radius / 0.03;
    this.m4.compose(new THREE.Vector3(pos[0], pos[1], pos[2]), this.q, new THREE.Vector3(s, s, s));
    this.holes.setMatrixAt(i, this.m4);
    this.holes.instanceMatrix.needsUpdate = true;
  }

  /** Shader warm-up: one hole, scorch mark and casing in front of the camera (on), then back to none (off). */
  warmup(on: boolean, at: number[] = [0, 0, 0]): void {
    if (on) {
      this.m4.makeTranslation(at[0], at[1], at[2]);
      for (const m of [this.holes, this.scorch, this.brass]) { m.setMatrixAt(0, this.m4); m.count = 1; m.instanceMatrix.needsUpdate = true; }
      this.flashLight.intensity = 0.001;
    } else {
      this.holes.count = 0; this.holeNext = 0; this.scorch.count = 0; this.scorchNext = 0; this.brass.count = 0;
      this.flashLight.intensity = 0;
    }
  }

  clearHoles(): void { this.holes.count = 0; this.holeNext = 0; this.scorch.count = 0; this.scorchNext = 0; }

  explosion(pos: number[], _radius: number, big = false): void {
    const k = big ? 3 : 1;
    this.flashes.spawn(pos, [0, 0, 0], { life: 0.18 * k, size: 2.5 * k, size1: 5 * k, color: [1, 0.7, 0.35], alpha: 1, drag: 0 });
    for (let i = 0; i < 26 * k; i++) {
      const a = Math.random() * Math.PI * 2, u = Math.random();
      const sp = (3 + Math.random() * 7) * Math.sqrt(k);
      const v = [Math.cos(a) * sp * (1 - u), Math.sin(a) * sp * (1 - u), u * sp + 1];
      this.dust.spawn(pos, v, { life: 1.2 + Math.random(), size: 0.4, size1: 2.2 * Math.sqrt(k), color: [0.25, 0.23, 0.21], alpha: 0.7, drag: 2.2, gravity: -0.3 });
      this.sparks.spawn(pos, [v[0] * 1.6, v[1] * 1.6, v[2] * 1.6], { life: 0.4 + Math.random() * 0.4, size: 0.05, color: [1, 0.7, 0.3], alpha: 1, drag: 0.8, gravity: 9 });
    }
    this.flashLight.position.set(pos[0], pos[1], pos[2] + 0.5);
    this.flashLight.intensity = 60 * k;
    this.flashLight.distance = 14 * k;
    this.flashT = 0.15 * k;
    this.scorchMark(pos, big ? 6 : 2.6);
  }

  flashbang(pos: number[]): void {
    this.flashes.spawn(pos, [0, 0, 0], { life: 0.25, size: 3, size1: 6, color: [1, 1, 1], alpha: 1, drag: 0 });
    this.flashLight.position.set(pos[0], pos[1], pos[2]);
    this.flashLight.intensity = 80;
    this.flashLight.distance = 16;
    this.flashT = 0.12;
  }

  emp(pos: number[], radius: number): void {
    for (let i = 0; i < 30; i++) {
      const a = Math.random() * Math.PI * 2;
      this.sparks.spawn(pos, [Math.cos(a) * radius, Math.sin(a) * radius, (Math.random() - 0.3) * 3], { life: 0.4, size: 0.04, color: [0.5, 0.8, 1], alpha: 1, drag: 2 });
    }
  }

  /** Smoke clouds from the server's SMOKE entities: [id, {pos, radius, age, duration}]. */
  smoke(clouds: Array<[number, any]>, dt: number): void {
    const seen = new Set<number>();
    for (const [id, f] of clouds) {
      seen.add(id);
      let c = this.smokeClouds.get(id);
      if (!c) { c = { t: 0, emitted: 0 }; this.smokeClouds.set(id, c); }
      c.t += dt;
      const fade = f.duration > 0 ? Math.max(0, Math.min(1, (f.duration - f.age) / 3)) : 1;
      const r = Math.max(f.radius, 0.5);
      const emit = Math.min(2, Math.floor(c.t * 60 - c.emitted));
      c.emitted += emit;
      for (let i = 0; i < emit; i++) {
        const a = Math.random() * Math.PI * 2, u = Math.sqrt(Math.random());
        this.smokePool.spawn([f.pos[0] + Math.cos(a) * r * 0.75 * u, f.pos[1] + Math.sin(a) * r * 0.75 * u, f.pos[2] + Math.random() * r * 0.8],
          [(Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3, 0.05], { life: 4 + Math.random() * 2, size: r * 0.9, size1: r * 1.3, color: [0.78, 0.78, 0.8], alpha: 0.55 * fade, drag: 0.4 });
      }
    }
    for (const id of [...this.smokeClouds.keys()]) if (!seen.has(id)) this.smokeClouds.delete(id);
  }

  /** The server's world entities as models. */
  entities(list: EntityDraw[]): void {
    const seen = new Set<number>();
    for (const e of list) {
      seen.add(e.id);
      let m = this.models.get(e.id);
      if (m && m.key !== e.key) { this.group.remove(m.obj); m = undefined; }
      if (!m) {
        const entry = { key: e.key, obj: new THREE.Group() };
        m = entry;
        this.models.set(e.id, entry);
        this.group.add(entry.obj);
        if (e.key) {
          void this.world.weaponModel(e.key).then((proto) => {
            if (proto && this.models.get(e.id) === entry) {
              const c = proto.clone();
              c.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
              entry.obj.add(c);
            }
          });
        }
      }
      m.obj.position.set(e.pos[0], e.pos[1], e.pos[2]);
      m.obj.rotation.order = "ZXY";
      m.obj.rotation.set(0, e.roll ?? 0, THREE.MathUtils.degToRad(e.yaw ?? 0));
    }
    for (const [id, m] of this.models) if (!seen.has(id)) { this.group.remove(m.obj); this.models.delete(id); }
  }

  update(dt: number, viewportHeight: number, fov: number): void {
    for (const p of [this.sparks, this.dust, this.smokePool, this.flashes]) p.update(dt, viewportHeight, fov);
    this.updateBrass(dt);
    if (this.flashT > 0) {
      this.flashT -= dt;
      if (this.flashT <= 0) { this.flashLight.intensity = 0; this.flashLight.distance = 9; }
      else this.flashLight.intensity *= Math.exp(-dt * 25);
    }
    let keep = 0;
    for (const tr of this.tracers) if ((tr.t += dt) < tr.life) this.tracers[keep++] = tr;
    const had = this.tracers.length > 0 || this.tracerGeo.drawRange.count > 0;
    this.tracers.length = keep;
    let n = 0;
    const P = this.tracerPos, C = this.tracerCol;
    for (const tr of this.tracers) {
      const k = tr.t / tr.life;
      const h0 = Math.max(0, k * 1.4 - 0.4), h1 = Math.min(1, k * 1.4 + 0.15);
      const a = tr.a, b = tr.b;
      for (let j = 0; j < 3; j++) { P[n * 6 + j] = a[j] + (b[j] - a[j]) * h0; P[n * 6 + 3 + j] = a[j] + (b[j] - a[j]) * h1; }
      const alpha = 0.9 * (1 - k * 0.5);
      const o = n * 8;
      C[o] = 1; C[o + 1] = 0.85; C[o + 2] = 0.5; C[o + 3] = alpha * 0.3; C[o + 4] = 1; C[o + 5] = 0.92; C[o + 6] = 0.7; C[o + 7] = alpha;
      n++;
    }
    if (had) {
      this.tracerGeo.setDrawRange(0, n * 2);
      this.tracerGeo.attributes.position.needsUpdate = true;
      this.tracerGeo.attributes.color.needsUpdate = true;
    }
  }
}
