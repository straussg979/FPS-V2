// The server's destructible panels: damage from bullets, melee, explosions, charges and the lance; their
// collision rebuilt once per tick (flush); listeners (the navmesh links, the tactical map) told which
// panels changed. The browser gets the chunk masks in the snapshots.

import { DESTRUCTION } from "@cs/shared/data";
import { Panel, surfaceStrength } from "@cs/shared/destruction";
import type { PanelSpec } from "@cs/shared/level/level";
import type { V3 } from "@cs/shared/math";
import { Random } from "@cs/shared/rng";
import type { ServerGame } from "./game";

export class DestructionManager {
  game: ServerGame;
  panels: Panel[];
  listeners: Array<(p: Panel | null) => void> = [];
  version = 0;
  rng: Random;

  constructor(game: ServerGame, specs: PanelSpec[], seed: number | null) {
    this.game = game;
    this.rng = new Random(seed !== null ? `destruction:${seed}` : null);
    this.panels = specs.map((s, i) => new Panel(s, i));
    for (const p of this.panels) p.syncCollision(game.world);
  }

  /** New round: every wall whole again, the plates come off. */
  reset(): void {
    const changed = this.panels.filter((p) => p.version > 0 || p.reinforced);
    for (const p of changed) {
      p.restore();
      p.syncCollision(this.game.world);
    }
    if (changed.length) {
      this.version++;
      for (const cb of this.listeners.slice()) cb(null);
    }
  }

  panelsNear(pos: ArrayLike<number>, radius: number): Panel[] {
    return this.panels.filter((p) => {
      const r = Math.hypot(p.size[0], p.size[1], p.size[2]) / 2 + radius;
      const dx = p.center[0] - pos[0], dy = p.center[1] - pos[1], dz = p.center[2] - pos[2];
      return dx * dx + dy * dy + dz * dz <= r * r;
    });
  }

  bulletHit(index: number, pos: V3, dir: V3, damage: number, pellets = 1): void {
    const p = this.panels[index];
    if (!p) return;
    const props = surfaceStrength(p.spec.surface);
    const dead = p.damage(pos, pellets <= 1 ? 0.05 : 0.09, damage * Number(props.bullet), "bullet");
    if (dead.length) this.onChunks(p, dead, pos, "bullet", dir);
  }

  meleeHit(index: number, pos: V3, dir: V3, damage: number, radius = 0.14): void {
    const p = this.panels[index];
    if (!p) return;
    const props = surfaceStrength(p.spec.surface);
    const dead = p.damage(pos, radius, damage * Number(props.melee), "melee");
    if (dead.length) this.onChunks(p, dead, pos, "melee", dir);
  }

  /** A hammer swing or any area damage with a given radius and amount (melee kind). */
  damagePanel(p: Panel, pos: V3, radius: number, amount: number, kind: string, dir: V3 | null): number {
    const dead = p.damage(pos, radius, amount, kind);
    if (dead.length) this.onChunks(p, dead, pos, kind, dir);
    return dead.length;
  }

  /** Blast at pos: chunks inside the destruction radius take power (with falloff). */
  explosion(pos: V3, power: number, radius?: number): number {
    const r = radius ?? power * Number(DESTRUCTION.explosion_radius_scale ?? 0.16) / 10;
    let n = 0;
    for (const p of this.panelsNear(pos, r)) {
      const props = surfaceStrength(p.spec.surface);
      const dead = p.damage(pos, r, power * Number(props.explosion), "explosion");
      if (dead.length) this.onChunks(p, dead, pos, "explosion", null);
      n += dead.length;
    }
    return n;
  }

  /** A door-sized opening (local rectangle) on a panel; returns the chunks removed. */
  cut(p: Panel, u0: number, u1: number, v0: number, v1: number, pos: V3, kind: string, dir: V3 | null): number {
    const dead = p.cut(u0, u1, v0, v1, kind);
    if (dead.length) this.onChunks(p, dead, pos, kind, dir);
    return dead.length;
  }

  cutAt(p: Panel, pos: V3, width: number, below: number, above: number, kind: string): number {
    const lp = p.toLocal(pos);
    const [a, b] = p.ax;
    return this.cut(p, lp[a] - width / 2, lp[a] + width / 2, lp[b] - below, lp[b] + above, pos, kind, p.normal);
  }

  private onChunks(p: Panel, dead: number[], point: V3, kind: string, _dir: V3 | null): void {
    const g = this.game;
    if (dead.length >= 2 || kind !== "bullet") {
      g.fx.playAt(p.spec.surface !== "wood" ? "wall_break" : "wood_break", point, Math.min(0.4 + 0.08 * dead.length, 1));
    }
    g.notifyNoise(point, 1, 30, null);
  }

  /** Rebuild changed panels' collision (once per tick, however many hits they took). */
  flush(): void {
    const changed = this.panels.filter((p) => p.dirty);
    for (const p of changed) p.syncCollision(this.game.world);
    if (changed.length) {
      this.version++;
      for (const cb of this.listeners.slice()) for (const p of changed) cb(p);
    }
  }
}
