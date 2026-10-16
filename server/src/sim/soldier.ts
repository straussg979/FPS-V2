// What players and bots share: a match participant with a body in the world (a kinematic character,
// health and armour, a posed skeleton whose hit capsules bullets test, an inventory).

import type { KinematicCharacter } from "@cs/shared/character";
import { ANIM_EVENTS } from "@cs/shared/codec";
import { Damageable, type DamageResult } from "@cs/shared/damage";
import { Participant } from "@cs/shared/match";
import { type V3, anglesToDir } from "@cs/shared/math";
import { SoldierPose } from "@cs/shared/pose";
import type { Inventory, WeaponState } from "@cs/shared/weapons";
import type { ServerGame } from "./game";

export interface WeaponsOwner {
  inv: Inventory;
  readonly primary: WeaponState | null;
  readonly secondary: WeaponState | null;
  select(slot: string, force?: boolean): void;
  giveLoadout(weapons: string[], grenades: Record<string, number>): void;
  dropWeaponState(ws: WeaponState, throwSpeed?: number): void;
}

export abstract class Soldier extends Participant {
  game: ServerGame;
  damageable: Damageable;
  pose = new SoldierPose();
  hitEnabled = false;          // the hit capsules take part in shots (alive and in the world)
  active = false;              // in the world this round
  hasKit = false;
  animCounter = 0;             // animation events for the browsers' third-person bodies
  animKind = 0;
  abstract char: KinematicCharacter;
  abstract weapons: WeaponsOwner;

  constructor(game: ServerGame, name: string, isHuman: boolean, side: string) {
    super(name, isHuman);
    this.game = game;
    this.damageable = new Damageable(name, side);
  }

  abstract get yaw(): number;
  abstract get pitch(): number;
  abstract get leanAmount(): number;
  abstract eye(): V3;
  abstract centerOfMass(): V3;

  override get alive(): boolean { return this.damageable.alive; }

  position(): V3 { return [this.char.pos[0], this.char.pos[1], this.char.pos[2]]; }
  velocity(): V3 { return [this.char.vel[0], this.char.vel[1], this.char.vel[2]]; }
  headPos(): V3 { return this.pose.headPos(); }
  forward(): V3 { return anglesToDir(this.yaw, 0); }
  viewDir(): V3 { return anglesToDir(this.yaw, this.pitch); }

  /** A third-person animation event (reload, switch, throw, knife, hit, fire). */
  anim(kind: string, duration?: number, dir?: V3 | null): void {
    this.pose.event(kind, duration, dir ?? null);
    if (kind === "fire") return;
    this.animCounter = (this.animCounter + 1) & 31;
    this.animKind = Math.max(0, ANIM_EVENTS.indexOf(kind));
  }

  onHit(res: DamageResult, _pos: V3, dir: V3): void {
    if (!res.killed) this.anim("hit", undefined, dir);
  }

  die(direction: V3 | null): void {
    this.pose.die(direction);
    this.hitEnabled = false;
  }
}
