// Keyboard and mouse: pointer lock, rebindable actions and the desktop's mouse scale (degrees = counts x
// 0.022 x sensitivity). Crouch is C in the browser (Ctrl+W would close the tab) and the wall charge is V.

export const DEFAULT_BINDS: Record<string, string> = {
  forward: "KeyW", back: "KeyS", left: "KeyA", right: "KeyD", jump: "Space", crouch: "KeyC", walk: "ShiftLeft",
  lean_left: "KeyQ", lean_right: "KeyE", fire: "Mouse0", aim: "Mouse2", reload: "KeyR", use: "KeyF", inspect: "KeyY",
  drop: "KeyG", buy_menu: "KeyB", scoreboard: "Tab", slot1: "Digit1", slot2: "Digit2", slot3: "Digit3", slot4: "Digit4",
  slot5: "Digit5", gadget: "KeyX", charge: "KeyV", observe: "Digit6", ping: "Mouse1", last_weapon: "KeyZ",
  wheel_up: "WheelUp", wheel_down: "WheelDown", chat_all: "Enter", chat_team: "KeyU", vote_yes: "F1", vote_no: "F2",
};

export const BIND_LABELS: Array<[string, string]> = [
  ["forward", "Move forward"], ["back", "Move back"], ["left", "Strafe left"], ["right", "Strafe right"],
  ["walk", "Walk (quiet)"], ["crouch", "Crouch"], ["jump", "Jump"], ["lean_left", "Lean left"], ["lean_right", "Lean right"],
  ["fire", "Fire"], ["aim", "Aim / scope"], ["reload", "Reload"], ["use", "Use / defuse / reinforce"],
  ["drop", "Drop weapon"], ["inspect", "Inspect weapon"], ["slot1", "Primary weapon"], ["slot2", "Pistol"],
  ["slot3", "Knife"], ["slot4", "Grenades"], ["slot5", "Breach charge (bomb)"], ["last_weapon", "Last weapon"],
  ["gadget", "Specialist gadget"], ["charge", "Wall charge"], ["observe", "Drones / cameras"], ["ping", "Ping"],
  ["buy_menu", "Buy menu"], ["scoreboard", "Scoreboard"], ["chat_all", "Chat (all)"], ["chat_team", "Chat (team)"],
  ["vote_yes", "Vote yes"], ["vote_no", "Vote no"], ["wheel_up", "Previous weapon"], ["wheel_down", "Next weapon"],
];

export function keyLabel(code: string | undefined): string {
  if (!code) return "-";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return ({ Mouse0: "Left mouse", Mouse1: "Middle mouse", Mouse2: "Right mouse", Mouse3: "Mouse 4", Mouse4: "Mouse 5",
    WheelUp: "Wheel up", WheelDown: "Wheel down", Space: "Space", ShiftLeft: "Left Shift", ShiftRight: "Right Shift",
    ControlLeft: "Left Ctrl", ControlRight: "Right Ctrl", AltLeft: "Left Alt", Tab: "Tab", Enter: "Enter" } as Record<string, string>)[code] ?? code;
}

/** Actions the game handles itself (menus, chat) rather than sending to the server. */
const LOCAL_ACTIONS = new Set(["buy_menu", "scoreboard", "chat_all", "chat_team", "vote_yes", "vote_no"]);

export class Input {
  binds: Record<string, string>;
  byCode = new Map<string, string[]>();
  down = new Set<string>();               // actions held
  pressed = new Set<string>();            // actions pressed since the last command (edges)
  local: string[] = [];                   // local action presses: consumed by the UI
  dx = 0;
  dy = 0;
  sensitivity = 2.0;
  invertY = false;
  /** Actions that latch: one press holds them, the next releases (Settings > toggle aim / crouch / walk). */
  toggles = new Set<string>();
  /** Ask the browser for raw mouse movement (no OS acceleration) when locking the pointer. */
  rawInput = true;
  locked = false;
  enabled = true;                         // false while a menu or the chat has the keyboard
  onLockChange: ((locked: boolean) => void) | null = null;
  private captureNext: ((code: string) => void) | null = null;
  private lockAsked = 0;
  private lockRetries = 0;

  constructor(public element: HTMLElement, binds: Record<string, string> = {}) {
    this.binds = { ...DEFAULT_BINDS, ...binds };
    this.index();
    this.listen();
  }

  private index(): void {
    this.byCode.clear();
    for (const [action, code] of Object.entries(this.binds)) {
      if (!code) continue;
      const l = this.byCode.get(code) ?? [];
      l.push(action);
      this.byCode.set(code, l);
    }
  }

  setBinds(binds: Record<string, string>): void {
    this.binds = { ...DEFAULT_BINDS, ...binds };
    this.index();
  }

  private press(code: string): boolean {
    const actions = this.byCode.get(code);
    if (!actions) return false;
    for (const a of actions) {
      if (LOCAL_ACTIONS.has(a)) {
        if (!this.enabled && a !== "scoreboard") continue;
        this.local.push(a);
        if (a === "scoreboard") this.down.add(a);
        continue;
      }
      if (!this.enabled) continue;
      if (this.toggles.has(a)) {
        if (this.down.has(a)) this.down.delete(a);
        else { this.down.add(a); this.pressed.add(a); }
        continue;
      }
      if (!this.down.has(a)) this.pressed.add(a);
      if (!a.startsWith("wheel_") && !a.startsWith("slot") && a !== "last_weapon") this.down.add(a);
      else this.pressed.add(a);
    }
    return true;
  }

  private release(code: string): void {
    for (const a of this.byCode.get(code) ?? []) if (!this.toggles.has(a)) this.down.delete(a);
  }

  private listen(): void {
    const doc = document;
    doc.addEventListener("keydown", (e) => {
      if (e.repeat) { if (this.byCode.has(e.code) && this.locked) e.preventDefault(); return; }
      if (this.captureNext) { e.preventDefault(); const cb = this.captureNext; this.captureNext = null; cb(e.code); return; }
      if (!this.locked && !this.byCode.has(e.code)) return;
      if (!this.locked && !this.enabled) return;
      if (this.press(e.code)) e.preventDefault();
    });
    doc.addEventListener("keyup", (e) => this.release(e.code));
    doc.addEventListener("mousedown", (e) => {
      if (this.captureNext) { e.preventDefault(); const cb = this.captureNext; this.captureNext = null; cb(`Mouse${e.button}`); return; }
      if (!this.locked) return;
      this.press(`Mouse${e.button}`);
      e.preventDefault();
    });
    doc.addEventListener("mouseup", (e) => this.release(`Mouse${e.button}`));
    doc.addEventListener("mousemove", (e) => {
      if (!this.locked || !this.enabled) return;
      this.dx += e.movementX || 0;
      this.dy += e.movementY || 0;
    });
    doc.addEventListener("wheel", (e) => {
      const code = e.deltaY < 0 ? "WheelUp" : "WheelDown";
      if (this.captureNext) { e.preventDefault(); const cb = this.captureNext; this.captureNext = null; cb(code); return; }
      if (!this.locked) return;
      this.press(code);
      this.release(code);
      e.preventDefault();
    }, { passive: false });
    doc.addEventListener("pointerlockchange", () => {
      this.locked = doc.pointerLockElement === this.element;
      if (!this.locked) this.releaseAll();
      this.onLockChange?.(this.locked);
    });
    // Chrome refuses to re-capture the mouse for about a second after Esc released it. The click that asked
    // (Resume) still counts as a user gesture for a few seconds, so try again once the cooldown has passed.
    doc.addEventListener("pointerlockerror", () => {
      if (this.locked || this.lockRetries >= 2 || performance.now() - this.lockAsked > 3500) return;
      this.lockRetries++;
      setTimeout(() => { if (!this.locked) this.request(); }, 1100);
    });
    doc.addEventListener("contextmenu", (e) => { if (this.locked) e.preventDefault(); });
    window.addEventListener("blur", () => this.releaseAll());
  }

  lock(): void {
    this.lockAsked = performance.now();
    this.lockRetries = 0;
    this.request();
  }

  private request(): void {
    const el = this.element as HTMLElement & { requestPointerLock(opts?: unknown): Promise<void> | void };
    if (!this.rawInput) { el.requestPointerLock(); return; }
    try {
      const r = el.requestPointerLock({ unadjustedMovement: true });
      if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(() => el.requestPointerLock());
    } catch {
      el.requestPointerLock();
    }
  }

  unlock(): void { if (document.pointerLockElement) document.exitPointerLock(); }

  releaseAll(): void {
    this.down.clear();
    this.pressed.clear();
  }

  /** Degrees of yaw and pitch from the mouse since the last call. */
  look(): [number, number] {
    const k = 0.022 * this.sensitivity;
    const out: [number, number] = [-this.dx * k, -this.dy * k * (this.invertY ? -1 : 1)];
    this.dx = this.dy = 0;
    return out;
  }

  /** Movement axes (forward, strafe right) from the movement keys. */
  axes(): [number, number] {
    if (!this.enabled) return [0, 0];
    return [(this.down.has("forward") ? 1 : 0) - (this.down.has("back") ? 1 : 0), (this.down.has("right") ? 1 : 0) - (this.down.has("left") ? 1 : 0)];
  }

  isDown(action: string): boolean { return this.enabled && this.down.has(action); }

  takeLocal(): string[] {
    const out = this.local;
    this.local = [];
    return out;
  }

  /** One key/button for rebinding. */
  capture(cb: (code: string) => void): void { this.captureNext = cb; }
}
