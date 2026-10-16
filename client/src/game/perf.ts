// Debug overlay (F3): frames per second, a frame-time graph, the 99th-percentile frame time, hitches (frames over
// 33 ms) per minute, the render clock's rate steering (net.ts renderTick) and prediction corrections per second,
// plus the renderer's draw calls and triangles. The numbers are collected all the time (cheap: a ring buffer of
// frame times); the overlay itself is only drawn while it is shown. snapshot() returns the same numbers for tests.

const N = 600;                 // frames kept (10 s at 60 fps)
const HITCH_MS = 33.4;

export interface PerfSnapshot { fps: number; avgMs: number; p99Ms: number; maxMs: number; hitchesPerMin: number; correctionsPerMin: number;
  clockAdjustPct: number; clockResets: number; calls: number; triangles: number }

export class PerfOverlay {
  private times = new Float32Array(N);
  private n = 0;
  private head = 0;
  private hitches: number[] = [];          // timestamps (ms) of hitches in the last minute
  private corrections: number[] = [];      // timestamps of prediction corrections in the last minute
  private el: HTMLElement;
  private text: HTMLElement;
  private canvas: HTMLCanvasElement;
  private shown = false;
  private lastText = 0;
  private sorted = new Float32Array(N);
  private adjustAt: Array<[number, number]> = [];

  constructor(root: HTMLElement, private info: () => { calls: number; triangles: number; clockAdjust: number; clockResets: number; offset: number }) {
    this.el = document.createElement("div");
    this.el.className = "perf-overlay";
    Object.assign(this.el.style, { position: "absolute", left: "8px", bottom: "8px", zIndex: "40", padding: "6px 8px", background: "rgba(10,12,14,0.72)",
      color: "#d8f0d0", font: "11px/1.35 ui-monospace, Menlo, Consolas, monospace", pointerEvents: "none", borderRadius: "4px", whiteSpace: "pre" });
    this.text = document.createElement("div");
    this.canvas = document.createElement("canvas");
    this.canvas.width = 300;
    this.canvas.height = 70;
    Object.assign(this.canvas.style, { display: "block", marginTop: "4px", width: "300px", height: "70px" });
    this.el.append(this.text, this.canvas);
    this.el.style.display = "none";
    root.append(this.el);
    document.addEventListener("keydown", (e) => {
      if (e.code === "F3") { e.preventDefault(); this.toggle(); }
    });
  }

  toggle(on = !this.shown): void {
    this.shown = on;
    this.el.style.display = on ? "block" : "none";
  }

  /** One drawn frame: its duration (ms since the previous one) and the render clock's current rate. */
  frame(ms: number, clockRate: number): void {
    if (!(ms > 0) || ms > 5000) return;
    this.times[this.head] = ms;
    this.head = (this.head + 1) % N;
    this.n = Math.min(this.n + 1, N);
    const now = performance.now();
    if (ms > HITCH_MS) this.hitches.push(now);
    while (this.hitches.length && now - this.hitches[0] > 60000) this.hitches.shift();
    while (this.corrections.length && now - this.corrections[0] > 60000) this.corrections.shift();
    void clockRate;
    if (this.shown) this.draw(now);
  }

  correction(): void { this.corrections.push(performance.now()); }

  snapshot(): PerfSnapshot {
    const n = this.n;
    let sum = 0, max = 0;
    for (let i = 0; i < n; i++) { const t = this.times[i]; sum += t; if (t > max) max = t; }
    const s = this.sorted.subarray(0, n);
    s.set(this.times.subarray(0, n));
    s.sort();
    const inf = this.info();
    const now = performance.now();
    this.adjustAt.push([now, inf.clockAdjust]);
    while (this.adjustAt.length > 2 && now - this.adjustAt[0][0] > 10000) this.adjustAt.shift();
    const [t0, a0] = this.adjustAt[0];
    const pct = now > t0 ? (inf.clockAdjust - a0) / ((now - t0) / 1000) * 100 : 0;
    const span = Math.min(60, now / 1000);
    return { fps: n ? 1000 / (sum / n) : 0, avgMs: n ? sum / n : 0, p99Ms: n ? s[Math.min(n - 1, Math.floor(n * 0.99))] : 0, maxMs: max,
      hitchesPerMin: this.hitches.length * 60 / Math.max(1, span), correctionsPerMin: this.corrections.length * 60 / Math.max(1, span),
      clockAdjustPct: pct, clockResets: inf.clockResets, calls: inf.calls, triangles: inf.triangles };
  }

  private draw(now: number): void {
    if (now - this.lastText > 250) {
      this.lastText = now;
      const s = this.snapshot();
      const corrSec = this.corrections.filter((t) => now - t < 1000).length;
      this.text.textContent = `${s.fps.toFixed(0)} fps   avg ${s.avgMs.toFixed(2)} ms   p99 ${s.p99Ms.toFixed(1)} ms   max ${s.maxMs.toFixed(1)} ms\n` +
        `hitches >33 ms: ${s.hitchesPerMin.toFixed(1)}/min\n` +
        `render clock: steering ${s.clockAdjustPct.toFixed(2)} % of the time   resets ${s.clockResets}   offset ${this.info().offset.toFixed(2)} ticks\n` +
        `prediction corrections: ${corrSec}/s   ${s.correctionsPerMin.toFixed(0)}/min\n` +
        `draw calls ${s.calls}   triangles ${(s.triangles / 1000).toFixed(0)}k`;
    }
    const c = this.canvas.getContext("2d");
    if (!c) return;
    const W = this.canvas.width, H = this.canvas.height;
    c.clearRect(0, 0, W, H);
    c.fillStyle = "rgba(255,255,255,0.06)";
    c.fillRect(0, 0, W, H);
    const y = (ms: number) => H - Math.min(ms, 50) / 50 * H;
    c.strokeStyle = "rgba(255,255,255,0.25)";
    c.beginPath();
    for (const ms of [8.33, 16.67, 33.3]) { c.moveTo(0, y(ms)); c.lineTo(W, y(ms)); }
    c.stroke();
    const count = Math.min(this.n, W);
    for (let i = 0; i < count; i++) {
      const ms = this.times[(this.head - count + i + N) % N];
      c.fillStyle = ms > HITCH_MS ? "#ff5a4a" : ms > 17.5 ? "#ffd36a" : "#7fe08a";
      c.fillRect(W - count + i, y(ms), 1, H - y(ms));
    }
  }
}
