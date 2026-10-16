// Lag compensation for the players' hitscan shots. A player sees other soldiers about 100 ms in the past
// (interpolation) plus half the round trip; so that aiming at what is on screen hits, the server tests the
// shot against the hit capsules as they were at the tick the player was looking at (the command's
// view_tick + view_frac), clamped to 200 ms ago. Walls are never rewound; knives, grenades, explosions
// and the bots' shots are not rewound either.

import { segmentCapsule } from "@cs/shared/collision";
import type { V3 } from "@cs/shared/math";
import type { Soldier } from "./soldier";
import type { HitInterval } from "./types";

export const TICKS = 14;
export const MAX_REWIND = 0.2;
const REACH = 2.6;

interface Entry {
  soldier: Soldier;
  enabled: boolean;
  root: V3;
  caps: Array<{ a: V3; b: V3; r: number; hitgroup: string }>;
}

export class LagCompensation {
  history: Array<[number, Map<Soldier, Entry>]> = [];
  rewoundShots = 0;

  record(tick: number, soldiers: Soldier[]): void {
    const entry = new Map<Soldier, Entry>();
    for (const s of soldiers) {
      entry.set(s, { soldier: s, enabled: s.hitEnabled, root: [...s.pose.rootPos] as V3,
        caps: s.hitEnabled ? s.pose.capsules().map((c) => ({ a: c.a, b: c.b, r: c.def.radius, hitgroup: c.def.hitgroup })) : [] });
    }
    this.history.push([tick, entry]);
    if (this.history.length > TICKS) this.history.shift();
  }

  clear(): void { this.history = []; }

  viewTick(viewTick: number, viewFrac: number, nowTick: number, dt: number): number {
    const view = viewTick + viewFrac;
    return Math.max(nowTick - MAX_REWIND / dt, Math.min(nowTick, view));
  }

  private bracket(at: number): [Map<Soldier, Entry>, Map<Soldier, Entry>, number] | null {
    const h = this.history;
    if (!h.length) return null;
    if (at <= h[0][0]) return [h[0][1], h[0][1], 0];
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i][0] <= at) {
        if (i === h.length - 1) return [h[i][1], h[i][1], 0];
        const t0 = h[i][0], t1 = h[i + 1][0];
        return [h[i][1], h[i + 1][1], (at - t0) / Math.max(t1 - t0, 1)];
      }
    }
    return [h[0][1], h[0][1], 0];
  }

  /** The hit capsules' intervals at tick `at` for a segment (null: no history, use the present). */
  rewinder(at: number): ((origin: V3, end: V3, ignore: unknown) => HitInterval[]) | null {
    const br = this.bracket(at);
    if (!br) return null;
    const [ea, eb, f] = br;
    this.rewoundShots++;
    return (origin, end, ignore) => {
      const dx = end[0] - origin[0], dy = end[1] - origin[1], dz = end[2] - origin[2];
      const dd = dx * dx + dy * dy + dz * dz;
      const out: HitInterval[] = [];
      for (const [s, e1] of eb) {
        const e0 = ea.get(s) ?? e1;
        if (!(f < 0.5 ? e0.enabled : e1.enabled)) continue;
        if (ignore && s === ignore) continue;
        if (!e0.caps.length || !e1.caps.length) continue;
        const rx = e1.root[0] - origin[0], ry = e1.root[1] - origin[1], rz = e1.root[2] - origin[2];
        const t = dd > 0 ? Math.max(0, Math.min(1, (rx * dx + ry * dy + rz * dz) / dd)) : 0;
        const qx = rx - dx * t, qy = ry - dy * t, qz = rz - dz * t;
        if (qx * qx + qy * qy + qz * qz > (REACH + 1.5) ** 2) continue;
        for (let k = 0; k < e1.caps.length; k++) {
          const c0 = e0.caps[k], c1 = e1.caps[k];
          const a: V3 = [c0.a[0] + (c1.a[0] - c0.a[0]) * f, c0.a[1] + (c1.a[1] - c0.a[1]) * f, c0.a[2] + (c1.a[2] - c0.a[2]) * f];
          const b: V3 = [c0.b[0] + (c1.b[0] - c0.b[0]) * f, c0.b[1] + (c1.b[1] - c0.b[1]) * f, c0.b[2] + (c1.b[2] - c0.b[2]) * f];
          const hit = segmentCapsule(origin, end, a, b, c1.r);
          if (!hit) continue;
          out.push({ tIn: hit.tIn, tOut: hit.posOut ? hit.tOut : 1, inPos: hit.posIn, inNormal: hit.nIn, outPos: hit.posOut,
            outNormal: hit.nOut, body: null, owner: s, hitgroup: c1.hitgroup, surface: "flesh" });
        }
      }
      return out;
    };
  }
}
