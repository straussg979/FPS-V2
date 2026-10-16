// Checks on what a client sends (the client is never trusted). The game simulates movement, firing, ammo and
// buying from intents, so a client cannot claim a position, a hit or money; what is left to police is the
// rate and shape of its input:
// * at most RATE commands per second with a burst of BURST (a token bucket), extra ones dropped (the
//   long-run rate can't exceed real time, so a client can't speed its soldier up);
// * the message layout and values (shared/codec.ts decodeInput: version, count, length, clamped angles and
//   axes, unknown buttons dropped); sequence numbers must increase (HumanAgent.push);
// * view turns over 90 degrees in one command are counted for review, not blocked.

import { decodeInput } from "@cs/shared/codec";
import type { InputCmd } from "@cs/shared/commands";

export const RATE = 64.0;
export const BURST = 24.0;            // a browser that stalled for a frame sends its commands in one burst
export const FLICK = 90.0;

export class InputLimiter {
  tokens: number;
  private t: number;
  accepted = 0;
  dropped = 0;
  malformed = 0;
  flicks = 0;
  private lastYaw: number | null = null;

  constructor(public rate = RATE, public burst = BURST, private clock: () => number = () => performance.now() / 1000) {
    this.tokens = burst;
    this.t = clock();
  }

  private refill(): void {
    const now = this.clock();
    this.tokens = Math.min(this.burst, this.tokens + (now - this.t) * this.rate);
    this.t = now;
  }

  /** The commands of one input message that may be applied (possibly none). */
  accept(data: Uint8Array): InputCmd[] {
    let cmds: InputCmd[];
    try {
      [, cmds] = decodeInput(data);
    } catch {
      this.malformed++;
      return [];
    }
    this.refill();
    const out: InputCmd[] = [];
    for (const c of cmds) {
      if (this.tokens < 1.0) {
        this.dropped++;
        continue;
      }
      this.tokens -= 1.0;
      if (this.lastYaw !== null && Math.abs((((c.yaw - this.lastYaw + 180.0) % 360.0) + 360.0) % 360.0 - 180.0) > FLICK) this.flicks++;
      this.lastYaw = c.yaw;
      out.push(c);
    }
    this.accepted += out.length;
    return out;
  }

  stats(): Record<string, number> {
    return { accepted: this.accepted, dropped: this.dropped, malformed: this.malformed, flicks: this.flicks };
  }
}
