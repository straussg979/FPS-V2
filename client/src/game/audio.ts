// Sound on Web Audio: the game's synthesised sounds (WAV), positioned with HRTF panners and a rolloff per
// category; a sound with a wall between it and the listener plays low-passed and quieter, gunshots far away
// use their "_far" recording. Ambience beds (wind, room tone, tunnel) cross-fade by where the listener is.

import type { Assets } from "./assets";

const CATEGORY_DISTANCE: Record<string, number> = { shot: 9.0, impact: 2.0, step: 1.5, explosion: 14.0, misc: 2.5, ambient: 8.0 };
const FAR_DISTANCE = 45.0;
const HALL_HEIGHT = 4.5;             // a roof higher than this: a big room, a longer tail
const OCCLUDED_GAIN = 0.6;

function category(name: string): string {
  if (name.startsWith("shot_")) return "shot";
  if (name.startsWith("impact_")) return "impact";
  if (name.startsWith("step_") || name === "land") return "step";
  if (name.startsWith("explosion")) return "explosion";
  if (name.startsWith("amb_")) return "ambient";
  return "misc";
}

type V = number[];

export class AudioSystem {
  ctx: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer | Promise<AudioBuffer | null>>();
  volume: Record<string, number> = { master: 0.8, effects: 1.0, ui: 0.8, ambient: 0.6 };
  listener = { pos: [0, 0, 0] as V, fwd: [0, 1, 0] as V, up: [0, 0, 1] as V };
  occlusion: ((a: V, b: V) => boolean) | null = null;
  /** Height of the roof above a point, or null under open sky (the game ray-casts its collision world). */
  roofHeight: ((p: V) => number | null) | null = null;
  private rr = new Map<string, number>();
  private loops = new Map<string, { src: AudioBufferSourceNode; g: GainNode }>();
  private out!: GainNode;
  private effects!: GainNode;
  private ui!: GainNode;
  private ambientBus!: GainNode;

  constructor(public assets: Assets) {}

  /** Browsers only start audio after a user gesture (the click that locks the pointer). */
  unlock(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: "interactive" });
      this.out = this.ctx.createGain();
      this.out.connect(this.ctx.destination);
      this.effects = this.ctx.createGain();
      this.effects.connect(this.out);
      this.ui = this.ctx.createGain();
      this.ui.connect(this.out);
      this.ambientBus = this.ctx.createGain();
      this.ambientBus.connect(this.out);
      this.setVolumes(this.volume);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  setVolumes(v: Record<string, number>): void {
    this.volume = { ...this.volume, ...v };
    if (!this.ctx) return;
    this.out.gain.value = this.volume.master;
    this.effects.gain.value = this.volume.effects;
    this.ui.gain.value = this.volume.ui;
    this.ambientBus.gain.value = this.volume.ambient;
  }

  private variants(name: string): string[] | null { return this.assets.manifest?.sounds?.[name] ?? null; }

  private async buffer(url: string): Promise<AudioBuffer | null> {
    const b = this.buffers.get(url);
    if (b) return b;
    const ctx = this.ctx as AudioContext;
    const p = fetch(url).then((r) => r.arrayBuffer()).then((buf) => ctx.decodeAudioData(buf)).then((ab) => { this.buffers.set(url, ab); return ab; }).catch(() => null);
    this.buffers.set(url, p);
    return p;
  }

  preload(names: string[]): void {
    if (!this.ctx) return;
    for (const n of names) for (const url of this.variants(n) ?? []) void this.buffer(url);
  }

  private pick(name: string): string | null {
    const v = this.variants(name);
    if (!v || !v.length) return null;
    const i = (this.rr.get(name) ?? 0) % v.length;
    this.rr.set(name, i + 1);
    return v[i];
  }

  setListener(pos: V, fwd: V, up: V): void {
    this.listener = { pos, fwd, up };
    if (!this.ctx) return;
    const l = this.ctx.listener;
    if (l.positionX) {
      l.positionX.value = pos[0]; l.positionY.value = pos[1]; l.positionZ.value = pos[2];
      l.forwardX.value = fwd[0]; l.forwardY.value = fwd[1]; l.forwardZ.value = fwd[2];
      l.upX.value = up[0]; l.upY.value = up[1]; l.upZ.value = up[2];
    } else {
      l.setPosition(pos[0], pos[1], pos[2]);
      l.setOrientation(fwd[0], fwd[1], fwd[2], up[0], up[1], up[2]);
    }
  }

  private async play(url: string | null, o: { pos?: V | null; volume?: number; cat?: string; bus?: AudioNode | null; occluded?: boolean; rate?: number } = {}): Promise<void> {
    if (!this.ctx || !url) return;
    const buf = await this.buffer(url);
    if (!buf) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = o.rate ?? 1;
    let node: AudioNode = src;
    const gain = ctx.createGain();
    gain.gain.value = (o.volume ?? 1) * (o.occluded ? OCCLUDED_GAIN : 1);
    if (o.occluded) {
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 900;
      node.connect(lp);
      node = lp;
    }
    node.connect(gain);
    if (o.pos) {
      const p = ctx.createPanner();
      p.panningModel = "HRTF";
      p.distanceModel = "inverse";
      p.refDistance = CATEGORY_DISTANCE[o.cat ?? "misc"] ?? 2.5;
      p.rolloffFactor = 0.6;
      p.maxDistance = 10000;
      p.positionX.value = o.pos[0]; p.positionY.value = o.pos[1]; p.positionZ.value = o.pos[2];
      gain.connect(p);
      p.connect(o.bus ?? this.effects);
    } else gain.connect(o.bus ?? this.ui);
    src.start();
  }

  private occluded(pos: V): boolean { return this.occlusion ? this.occlusion(this.listener.pos, pos) : false; }

  playAt(name: string, pos: V, volume = 1): void {
    if (!this.ctx) return;
    void this.play(this.pick(name), { pos, volume, cat: category(name), occluded: this.occluded(pos) });
  }

  shot(profile: string, pos: V, own = false): void {
    if (!this.ctx) return;
    if (own) {
      void this.play(this.pick(`shot_${profile}`), { volume: 0.9, bus: this.effects });
      // a shot under a roof rings on: a room tail, or a hall tail under a high roof
      const l = this.listener.pos;
      const roof = this.roofHeight ? this.roofHeight([l[0], l[1], l[2] - 1.0]) : null;
      if (roof !== null) void this.play(this.pick(roof > HALL_HEIGHT ? "tail_hall" : "tail_room"), { volume: 0.35, bus: this.effects });
      return;
    }
    const l = this.listener.pos;
    const d = Math.hypot(pos[0] - l[0], pos[1] - l[1], pos[2] - l[2]);
    const far = d > FAR_DISTANCE && this.variants(`shot_${profile}_far`);
    const occluded = this.occluded(pos);
    void this.play(this.pick(far ? `shot_${profile}_far` : `shot_${profile}`), { pos, volume: 1, cat: "shot", occluded });
    if (d < FAR_DISTANCE && this.roofHeight) {
      const roof = this.roofHeight(pos);
      if (roof !== null) void this.play(this.pick(roof > HALL_HEIGHT ? "tail_hall" : "tail_room"), { pos, volume: 0.4, cat: "shot", occluded });
    }
  }

  footstep(surface: string, pos: V, loudness: number, own = false): void {
    if (!this.ctx || loudness <= 0.01) return;
    const name = this.variants(`step_${surface}`) ? `step_${surface}` : "step_default";
    if (own) { void this.play(this.pick(name), { volume: 0.2 * loudness, bus: this.effects }); return; }
    void this.play(this.pick(name), { pos, volume: 0.65 * loudness, cat: "step", occluded: this.occluded(pos) });
  }

  ui2d(name: string, volume = 0.7): void {
    if (!this.ctx) return;
    void this.play(this.pick(name), { volume, bus: this.ui });
  }

  /** The looping ambience beds at target gains. */
  async ambience(mix: Record<string, number>): Promise<void> {
    if (!this.ctx) return;
    const ctx = this.ctx;
    for (const name of ["amb_wind", "amb_room", "amb_tunnel"]) {
      const target = mix[name] ?? 0;
      let lp = this.loops.get(name);
      if (!lp && target > 0) {
        const url = this.pick(name);
        const buf = url ? await this.buffer(url) : null;
        if (!buf || this.loops.get(name)) continue;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        const g = ctx.createGain();
        g.gain.value = 0;
        src.connect(g);
        g.connect(this.ambientBus);
        src.start();
        lp = { src, g };
        this.loops.set(name, lp);
      }
      if (lp) lp.g.gain.setTargetAtTime(target, ctx.currentTime, 0.8);
    }
  }
}
