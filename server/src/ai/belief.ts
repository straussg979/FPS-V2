// Where unseen enemies could be by now: the possibility field. Each team keeps one picture of the enemy
// team over the tactical points. For every point, ready[p] is the earliest time an enemy could be there:
// * round start: ready = start + eta[enemy spawn];
// * facts (a sighting, a sound, a callout, a ping) say an enemy was within radius of a position at time t;
// * spreading: ready[q] <= ready[p] + dist(p, q) / speed along the point graph;
// * clearing: a point a teammate looks at right now holds nobody now and becomes a barrier: an enemy can
//   only arrive there after the moment it was seen empty, coming from somewhere unseen.
// Enemies seen or heard recently get their own track (the same field, seeded from their latest fact) which
// stays sharp for track_time and then dissolves into the general field. `danger` turns this into expected
// enemies per point. Updates are time-sliced: `step` advances one field by one hop per call.

import type { Fact } from "./knowledge";
import type { TacticalMap } from "./tactical_map";

export const INF = 1e9;

interface Graph { src: Int32Array; dst: Int32Array; dstU: Int32Array; starts: Int32Array; length: Float64Array; cache: Map<number, Float64Array> }

export class Field {
  tm: TacticalMap;
  speed: number;
  ready: Float64Array;
  seen: Float64Array;           // last time each point was seen empty

  constructor(tm: TacticalMap, speed: number) {
    this.tm = tm;
    this.speed = speed;
    this.ready = new Float64Array(tm.n).fill(INF);
    this.seen = new Float64Array(tm.n).fill(-INF);
  }

  seed(idx: ArrayLike<number>, t: number): void {
    for (let k = 0; k < idx.length; k++) { const i = idx[k]; if (t < this.ready[i]) this.ready[i] = t; }
  }

  relax(g: Graph, iters = 2): void {
    const ng = g.dstU.length;
    if (!g.src.length) return;
    let travel = g.cache.get(this.speed);
    if (!travel) {
      travel = g.length.map((l) => l / this.speed);
      g.cache.set(this.speed, travel);
    }
    const best = new Float64Array(ng);
    const ready = this.ready, seen = this.seen;
    for (let it = 0; it < iters; it++) {
      // an enemy possible at src walks to dst; it cannot be in dst before dst was last seen empty, and needs
      // part of the way after that (points are ~3 m regions)
      for (let gi = 0; gi < ng; gi++) {
        const s0 = g.starts[gi], s1 = gi + 1 < ng ? g.starts[gi + 1] : g.src.length;
        let m = Infinity;
        for (let e = s0; e < s1; e++) {
          const tv = travel[e];
          const v = Math.max(ready[g.src[e]] + tv, seen[g.dst[e]] + 0.5 * tv);
          if (v < m) m = v;
        }
        best[gi] = m;
      }
      for (let gi = 0; gi < ng; gi++) { const d = g.dstU[gi]; if (best[gi] < ready[d]) ready[d] = best[gi]; }
    }
  }

  clear(mask: Uint8Array, now: number): void {
    for (let i = 0; i < mask.length; i++) if (mask[i]) { this.seen[i] = now; this.ready[i] = INF; }
  }

  possible(now: number): Uint8Array {
    const out = new Uint8Array(this.ready.length);
    for (let i = 0; i < out.length; i++) out[i] = this.ready[i] <= now ? 1 : 0;
    return out;
  }
}

export class Track {
  enemy: number | null;
  fact: Fact;
  field: Field;
  born: number;
  updated: number;

  constructor(tm: TacticalMap, enemy: number | null, fact: Fact, speed: number) {
    this.enemy = enemy;
    this.fact = fact;
    this.field = new Field(tm, speed);
    this.born = fact.time;
    this.updated = fact.time;
    let idx = tm.pointsNear(fact.pos, Math.max(fact.radius, 1.6), 2.2);
    if (!idx.length) {
      const i = tm.nearest(fact.pos);
      idx = i >= 0 ? [i] : [];
    }
    this.field.seed(idx, fact.time);
  }
}

export class PossibilityField {
  tm: TacticalMap;
  enemySide: string;
  runSpeed: number;
  walkSpeed: number;
  trackTime: number;
  maxTracks: number;
  general: Field;
  tracks = new Map<number, Track>();
  enemiesAlive = 5;
  prior: Float64Array;
  private graph: Graph;
  private turn = 0;
  now = 0;

  constructor(tm: TacticalMap, enemySide: string, runSpeed = 5.4, walkSpeed = 2.75, trackTime = 20.0, maxTracks = 5) {
    this.tm = tm;
    this.enemySide = enemySide;
    this.runSpeed = runSpeed;
    this.walkSpeed = walkSpeed;
    this.trackTime = trackTime;
    this.maxTracks = maxTracks;
    this.general = new Field(tm, runSpeed);
    this.prior = new Float64Array(tm.n).fill(1);
    this.graph = sortedGraph(tm);
  }

  /** New round: enemies leave their spawn at `start`. */
  reset(start: number, enemiesAlive: number, prior: Float64Array | null = null): void {
    this.general = new Field(this.tm, this.runSpeed);
    const eta = this.tm.eta[this.enemySide];
    for (let i = 0; i < this.tm.n; i++) this.general.ready[i] = start + eta[i];
    this.tracks = new Map();
    this.enemiesAlive = enemiesAlive;
    if (prior) this.prior = prior;
    this.now = start;
  }

  /** An enemy (fact.enemy, or null if unknown) was near fact.pos at fact.time. */
  addFact(fact: Fact): void {
    const key = fact.enemy !== null ? fact.enemy : -this.tracks.size - 1000;
    const old = this.tracks.get(key);
    if (old && old.fact.time >= fact.time) return;
    const speed = fact.source === "sight" && fact.speed < 3.0 ? this.walkSpeed : this.runSpeed;
    const tr = new Track(this.tm, fact.enemy, fact, speed);
    // catch up with the time that has passed since the fact
    tr.field.seen = this.general.seen.slice();
    tr.field.relax(this.graph, 3);
    this.tracks.set(key, tr);
    if (this.tracks.size > this.maxTracks) {
      let oldest: number | null = null, ou = Infinity;
      for (const [k, t] of this.tracks) if (t.updated < ou) { ou = t.updated; oldest = k; }
      if (oldest !== null) this.dissolve(oldest);
    }
    // an enemy was here, so the general field must allow it as well
    const idx: number[] = [];
    for (let i = 0; i < this.tm.n; i++) if (tr.field.ready[i] <= fact.time + 1e-6) idx.push(i);
    this.general.seed(idx, fact.time);
  }

  enemyDied(enemy: number): void {
    this.tracks.delete(enemy);
    this.enemiesAlive = Math.max(this.enemiesAlive - 1, 0);
  }

  /** Points the team sees right now (empty of enemies, or the enemies there are facts). */
  observe(mask: Uint8Array, now: number): void {
    this.now = now;
    this.general.clear(mask, now);
    for (const tr of this.tracks.values()) tr.field.clear(mask, now);
  }

  /** Advance one field (time-sliced). */
  step(now: number): void {
    this.now = now;
    const fields = [this.general, ...[...this.tracks.values()].map((t) => t.field)];
    this.turn = (this.turn + 1) % fields.length;
    fields[this.turn].relax(this.graph, 1);
    if (this.turn === 0) {
      for (const [k, t] of [...this.tracks]) if (now - t.fact.time > this.trackTime) this.dissolve(k);
    }
  }

  private dissolve(key: number): void {
    const tr = this.tracks.get(key);
    if (!tr) return;
    this.tracks.delete(key);
    const g = this.general.ready, r = tr.field.ready;
    for (let i = 0; i < g.length; i++) if (r[i] < g[i]) g[i] = r[i];
  }

  possible(now: number | null = null): Uint8Array {
    const t = now ?? this.now;
    const m = this.general.possible(t);
    for (const tr of this.tracks.values()) {
      const r = tr.field.ready;
      for (let i = 0; i < m.length; i++) if (r[i] <= t) m[i] = 1;
    }
    return m;
  }

  /** Expected number of enemies per point (sums to about the number of living enemies). */
  danger(now: number | null = null): Float64Array {
    const t = now ?? this.now;
    const n = this.tm.n;
    const out = new Float64Array(n);
    let tracked = 0;
    const w = new Float64Array(n);
    for (const tr of this.tracks.values()) {
      const r = tr.field.ready;
      let k = 0;
      for (let i = 0; i < n; i++) if (r[i] <= t) k++;
      if (!k) continue;
      // the longer ago, the more it has spread; nearer points stay likelier
      const age = Math.max(t - tr.fact.time, 0.0);
      let s = 0;
      for (let i = 0; i < n; i++) {
        w[i] = r[i] <= t ? 1.0 / (1.0 + Math.max(r[i] - tr.fact.time, 0) / (2.0 + age)) : 0;
        s += w[i];
      }
      s = Math.max(s, 1e-9);
      for (let i = 0; i < n; i++) out[i] += w[i] / s;
      tracked++;
    }
    const free = Math.max(this.enemiesAlive - tracked, 0);
    if (free) {
      const r = this.general.ready;
      let s = 0;
      for (let i = 0; i < n; i++) { w[i] = r[i] <= t ? this.prior[i] : 0; s += w[i]; }
      if (s > 0) for (let i = 0; i < n; i++) out[i] += free * w[i] / s;
    }
    return out;
  }

  tracked(): number { return this.tracks.size; }

  /** Seconds since each point was last seen (large = never). */
  age(now: number | null = null): Float64Array {
    const t = now ?? this.now;
    return this.general.seen.map((s) => t - s);
  }
}

/** Edges sorted by destination, with the start index of every destination group. */
function sortedGraph(tm: TacticalMap): Graph {
  const ne = tm.edgeSrc.length;
  const order = Array.from({ length: ne }, (_, i) => i).sort((a, b) => tm.edgeDst[a] - tm.edgeDst[b] || a - b);
  const src = Int32Array.from(order.map((e) => tm.edgeSrc[e]));
  const dst = Int32Array.from(order.map((e) => tm.edgeDst[e]));
  const length = Float64Array.from(order.map((e) => tm.edgeLen[e]));
  const starts: number[] = [];
  for (let e = 0; e < ne; e++) if (e === 0 || dst[e] !== dst[e - 1]) starts.push(e);
  return { src, dst, dstU: Int32Array.from(starts.map((s) => dst[s])), starts: Int32Array.from(starts), length, cache: new Map() };
}

/** Tactical points a bot at `eye` looking along `yaw` sees now: inside its view cone, in the precomputed line
 * of sight of its nearest point, and not behind a smoke cloud. */
export function viewMask(tm: TacticalMap, eye: ArrayLike<number>, yaw: number, fov: number, maxRange = 60.0,
  smokes: Array<[ArrayLike<number>, number]> = []): Uint8Array {
  const i = tm.nearest([eye[0], eye[1], eye[2] - 1.6]);
  if (i < 0) return new Uint8Array(tm.n);
  const m = tm.seenInView(i, eye, yaw, fov, maxRange);
  m[i] = 1;
  for (const [c, r] of smokes) {
    const cx = c[0] - eye[0], cy = c[1] - eye[1];
    const cd = Math.hypot(cx, cy);
    if (cd < 1e-3) return new Uint8Array(tm.n);
    // angular half-width of the cloud seen from the eye
    const half = Math.asin(Math.min(r / cd, 1.0));
    const ch = Math.cos(half);
    for (let j = 0; j < tm.n; j++) {
      if (!m[j]) continue;
      const dx = tm.xy[j * 2] - eye[0], dy = tm.xy[j * 2 + 1] - eye[1];
      const dist = Math.hypot(dx, dy);
      const cosang = (dx * cx + dy * cy) / Math.max(dist * cd, 1e-6);
      if (cosang > ch && dist > cd - r) m[j] = 0;
    }
  }
  return m;
}
