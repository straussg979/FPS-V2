// What the simulation's parts know of each other.

import type { Body } from "@cs/shared/collision";
import type { Damageable, DamageResult } from "@cs/shared/damage";
import type { V3 } from "@cs/shared/math";

/** Something a bullet, a blade or a blast can hurt: soldiers and gadgets with a hit box. */
export interface HitOwner {
  damageable: Damageable;
  onHit?(res: DamageResult, pos: V3, dir: V3): void;
  forward?(): V3;
  isGadget?: boolean;
  side?: string;
}

/** A solid a segment passes through: a world body (wall, panel, shield) or a hit box (a soldier's capsule,
 * a gadget's box), with where it enters and leaves (fractions of the segment). */
export interface HitInterval {
  tIn: number;
  tOut: number;
  inPos: V3;
  inNormal: V3;
  outPos: V3 | null;
  outNormal: V3 | null;
  body: Body | null;           // world solids
  owner: HitOwner | null;      // hit boxes
  hitgroup: string;
  surface: string;
}
