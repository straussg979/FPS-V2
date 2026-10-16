// Local lights on medium and up: the map's lanterns, bulbs and window lights near the camera become real point
// lights (a small fixed pool, so the shaders never recompile), on top of the baked light volume that carries their
// soft bounce. They add what a bake cannot: highlights on timber and metal, light that moves over the players
// walking past, and - with local shadows on high / ultra - shadows of players and props cast by the lamp, rendered
// into the point-light shadow maps a few lights per frame (local_shadow_updates) instead of every frame.
// Lights are picked by distance a few times a second and fade in and out, so a light never pops.

import * as THREE from "three";

export interface MapLight { pos: number[]; color: number[]; range: number; kind: string }

interface Slot { light: THREE.PointLight; src: MapLight | null; want: number; level: number }

export class LocalLights {
  private slots: Slot[] = [];
  private lights: MapLight[];
  private t = 0;
  private shadowTurn = 0;
  private updatesPerFrame = 1;

  constructor(private parent: THREE.Object3D, lights: MapLight[]) {
    this.lights = lights.filter((l) => l.kind === "point" || !l.kind);
  }

  /** Pool size, how many of them cast shadows, shadow map size and shadow updates per frame. */
  configure(count: number, shadows: number, tile: number, updates: number): void {
    for (const s of this.slots) { s.light.shadow.map?.dispose(); this.parent.remove(s.light); }
    this.slots = [];
    for (let i = 0; i < count; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 8, 2);
      l.name = `local:${i}`;
      l.castShadow = i < shadows;
      l.shadow.mapSize.set(tile, tile);
      l.shadow.bias = -0.002;
      l.shadow.normalBias = 0.02;
      l.shadow.camera.near = 0.1;
      l.shadow.autoUpdate = false;
      this.parent.add(l);
      this.slots.push({ light: l, src: null, want: 0, level: 0 });
    }
    this.updatesPerFrame = Math.max(1, updates);
  }

  get count(): number { return this.slots.length; }

  /** Per frame, with the camera position in game (Z-up) coordinates. */
  update(dt: number, cam: THREE.Vector3): void {
    if (!this.slots.length) return;
    this.t -= dt;
    if (this.t <= 0) {
      this.t = 0.25;
      const near = this.lights.map((l) => ({ l, d: Math.hypot(l.pos[0] - cam.x, l.pos[1] - cam.y, l.pos[2] - cam.z) }))
        .filter((x) => x.d < Math.max(18, x.l.range * 1.5)).sort((a, b) => a.d - b.d).slice(0, this.slots.length).map((x) => x.l);
      // keep lights that stay chosen in their slots; free slots take the new ones (after fading out)
      for (const s of this.slots) s.want = s.src && near.includes(s.src) ? 1 : 0;
      for (const l of near) {
        if (this.slots.some((s) => s.src === l)) continue;
        const free = this.slots.find((s) => s.level <= 0.001 && s.want === 0);
        if (!free) continue;
        free.src = l;
        free.want = 1;
        free.light.position.set(l.pos[0], l.pos[1], l.pos[2]);
        const peak = Math.max(l.color[0], l.color[1], l.color[2], 1e-3);
        free.light.color.setRGB(l.color[0] / peak, l.color[1] / peak, l.color[2] / peak);
        free.light.userData.peak = peak;
        free.light.distance = Math.max(4, l.range);
        free.light.shadow.camera.far = free.light.distance;
        free.light.shadow.needsUpdate = true;
      }
    }
    const k = 1 - Math.exp(-dt * 6);
    for (const s of this.slots) {
      s.level += (s.want - s.level) * k;
      if (s.want === 0 && s.level < 0.002) { s.level = 0; s.src = null; }
      // a fraction of the fixture's strength: the bake already carries its diffuse bounce
      s.light.intensity = s.src ? s.level * 0.3 * (s.light.userData.peak ?? 1) : 0;
    }
    // shadow maps: a few per frame, round robin over the shadow-casting slots
    const casters = this.slots.filter((s) => s.light.castShadow && s.src);
    for (let i = 0; i < Math.min(this.updatesPerFrame, casters.length); i++) {
      casters[(this.shadowTurn + i) % casters.length].light.shadow.needsUpdate = true;
    }
    this.shadowTurn += this.updatesPerFrame;
  }
}
