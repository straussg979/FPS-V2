// One tick of a player's input: view angles, the movement keys as two axes, the buttons held and the
// buttons pressed since the previous command. The browser builds one per server tick and sends it in the
// binary `in` message (codec.ts); the server applies it to the same movement and weapon code. A press
// lives for the tick of its command: one that nothing reads in that tick is dropped.

export const HOLD_ACTIONS = ["fire", "aim", "jump", "crouch", "walk", "lean_left", "lean_right", "use", "reload",
  "inspect", "gadget", "charge", "observe", "ping", "drop"] as const;
export const PRESS_ACTIONS = ["slot1", "slot2", "slot3", "slot4", "slot5", "last_weapon", "wheel_up", "wheel_down"] as const;
export const ACTIONS = [...HOLD_ACTIONS, ...PRESS_ACTIONS] as const;
export type Action = (typeof ACTIONS)[number] | "forward" | "back" | "left" | "right";

export const BIT: Record<string, number> = {};
ACTIONS.forEach((a, i) => { BIT[a] = 1 << i; });
const ALL_MASK = (1 << ACTIONS.length) - 1;
const HOLD_MASK = (1 << HOLD_ACTIONS.length) - 1;

export const WIRE_SIZE = 23;            // u32 seq, u32 view_tick, u8 view_frac, u16 yaw, i16 pitch, i8 f, i8 s, u32 held, u32 pressed

export interface InputCmd {
  seq: number;
  yaw: number;            // degrees 0..360
  pitch: number;          // degrees -89..89
  moveF: number;          // -1 back .. 1 forward
  moveS: number;          // -1 left .. 1 right
  held: number;
  pressed: number;
  viewTick: number;       // server tick the client showed remote players at (lag compensation)
  viewFrac: number;
}

export function emptyCmd(seq = 0, yaw = 0, pitch = 0): InputCmd {
  return { seq, yaw, pitch, moveF: 0, moveS: 0, held: 0, pressed: 0, viewTick: 0, viewFrac: 0 };
}

const axis = (v: number) => Math.max(-1, Math.min(1, v));
const pyRound = (x: number) => {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
};

export function packCmd(c: InputCmd, view: DataView, off: number): void {
  view.setUint32(off, c.seq >>> 0, true);
  view.setUint32(off + 4, c.viewTick >>> 0, true);
  view.setUint8(off + 8, Math.max(0, Math.min(255, pyRound(c.viewFrac * 256))));
  view.setUint16(off + 9, pyRound((((c.yaw % 360) + 360) % 360) / 360 * 65536) & 0xffff, true);
  view.setInt16(off + 11, Math.max(-8900, Math.min(8900, pyRound(c.pitch * 100))), true);
  view.setInt8(off + 13, pyRound(axis(c.moveF) * 127));
  view.setInt8(off + 14, pyRound(axis(c.moveS) * 127));
  view.setUint32(off + 15, c.held >>> 0, true);
  view.setUint32(off + 19, c.pressed >>> 0, true);
}

/** Decode one command; values are clamped and unknown button bits dropped (the client is never trusted). */
export function unpackCmd(view: DataView, off: number): InputCmd {
  return {
    seq: view.getUint32(off, true),
    viewTick: view.getUint32(off + 4, true),
    viewFrac: view.getUint8(off + 8) / 256,
    yaw: view.getUint16(off + 9, true) / 65536 * 360,
    pitch: Math.max(-89, Math.min(89, view.getInt16(off + 11, true) / 100)),
    moveF: Math.max(-1, view.getInt8(off + 13) / 127),
    moveS: Math.max(-1, view.getInt8(off + 14) / 127),
    held: (view.getUint32(off + 15, true) & HOLD_MASK) >>> 0,
    pressed: (view.getUint32(off + 19, true) & ALL_MASK) >>> 0,
  };
}

const AXES: Record<string, [number, number]> = { forward: [0, 1], back: [0, -1], right: [1, 1], left: [1, -1] };

/** The tick's command as the game code reads it: `down` for held buttons and the movement keys, `consume`
 * takes a press once. */
export class CmdInput {
  cmd: InputCmd;
  private left: number;

  constructor(cmd: InputCmd = emptyCmd()) {
    this.cmd = cmd;
    this.left = cmd.pressed;
  }

  down(action: Action): boolean {
    const ax = AXES[action];
    if (ax) return (ax[0] === 0 ? this.cmd.moveF : this.cmd.moveS) * ax[1] > 0.5;
    return (this.cmd.held & (BIT[action] ?? 0)) !== 0;
  }

  consume(action: Action): boolean {
    const bit = BIT[action] ?? 0;
    if (this.left & bit) {
      this.left &= ~bit;
      return true;
    }
    return false;
  }

  press(action: Action): void { this.left |= BIT[action] ?? 0; }
  clearPresses(): void { this.left = 0; }
  axes(): [number, number] { return [this.cmd.moveF, this.cmd.moveS]; }
}
