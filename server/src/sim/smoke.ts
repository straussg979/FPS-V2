// Smoke clouds as game state, aged in the fixed tick: they block bot vision, flashes and (their dense core)
// what the server sends a client.

import type { V3 } from "@cs/shared/math";

export class SmokeCloud {
  pos: V3;
  radius: number;
  age = 0;
  duration: number;

  constructor(pos: V3, radius: number, duration: number) {
    this.pos = pos;
    this.radius = radius;
    this.duration = duration;
  }

  /** 0..1 opacity for gameplay checks. */
  get density(): number {
    const grow = Math.min(this.age / 1.5, 1);
    const fade = Math.min(Math.max((this.duration - this.age) / 3, 0), 1);
    return grow * fade;
  }

  get done(): boolean { return this.age >= this.duration; }
}

export class SmokeField {
  clouds: SmokeCloud[] = [];

  add(pos: ArrayLike<number>, radius: number, duration: number): SmokeCloud {
    const c = new SmokeCloud([pos[0], pos[1], pos[2]], radius, duration);
    this.clouds.push(c);
    return c;
  }

  fixedUpdate(dt: number): void {
    for (const c of this.clouds) c.age += dt;
    this.clouds = this.clouds.filter((c) => !c.done);
  }

  clear(): void { this.clouds = []; }

  /** Total smoke opacity along a segment. */
  between(a: ArrayLike<number>, b: ArrayLike<number>): number {
    let total = 0;
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const L = Math.hypot(dx, dy, dz);
    if (L < 1e-3) return 0;
    const ux = dx / L, uy = dy / L, uz = dz / L;
    for (const c of this.clouds) {
      const t = Math.max(0, Math.min(L, (c.pos[0] - a[0]) * ux + (c.pos[1] - a[1]) * uy + (c.pos[2] - a[2]) * uz));
      const cx = a[0] + ux * t - c.pos[0], cy = a[1] + uy * t - c.pos[1], cz = a[2] + uz * t - c.pos[2];
      if (Math.hypot(cx, cy, cz) < c.radius) total += c.density;
    }
    return Math.min(total, 1);
  }
}
