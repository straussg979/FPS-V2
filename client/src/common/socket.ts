// The browser side of /ws: JSON control events with acknowledgements ({e, d, id} -> {e: "ack", id, d}),
// server pushes ({e, d}), binary frames with a channel byte, and reconnection with exponential backoff
// (0.5 s doubling to 5 s, with jitter). The URL is always the page's own origin, so the same build works
// on localhost and behind Cloudflare (wss://<host>/ws).

/* eslint-disable @typescript-eslint/no-explicit-any */
type Handler = (data: any) => void;
export interface Ack { ok: boolean; text?: string; error?: string; [k: string]: any }

export class GameSocket {
  ws: WebSocket | null = null;
  connected = false;
  private handlers = new Map<string, Handler[]>();
  private anyHandlers: Array<(e: string, d: any) => void> = [];
  private binary: ((data: ArrayBuffer) => void) | null = null;
  private pending = new Map<number, (a: Ack) => void>();
  private nextId = 1;
  private backoff = 500;
  private closedForGood = false;
  url: string;

  constructor(path = "/ws") {
    this.url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;
  }

  connect(): void {
    if (this.closedForGood) return;
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.backoff = 500;
      this.fire("connect", null);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") {
        this.binary?.(ev.data as ArrayBuffer);
        return;
      }
      let m: any;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.e === "ack") {
        const cb = this.pending.get(m.id);
        if (cb) { this.pending.delete(m.id); cb(m.d ?? { ok: false }); }
        return;
      }
      if (m.e === "kicked" || m.e === "server:shutdown") this.closedForGood = m.e === "kicked";
      this.fire(m.e, m.d);
    };
    ws.onclose = (ev) => {
      const was = this.connected;
      this.connected = false;
      for (const cb of this.pending.values()) cb({ ok: false, text: "disconnected" });
      this.pending.clear();
      this.fire("disconnect", { code: ev.code, reason: ev.reason, was });
      if (this.closedForGood || ev.code === 4000) return;
      const wait = this.backoff * (0.75 + Math.random() * 0.5);
      this.backoff = Math.min(this.backoff * 2, 5000);
      setTimeout(() => this.connect(), wait);
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  close(): void {
    this.closedForGood = true;
    this.ws?.close();
  }

  on(event: string, cb: Handler): void {
    const l = this.handlers.get(event) ?? [];
    l.push(cb);
    this.handlers.set(event, l);
  }

  onAny(cb: (e: string, d: any) => void): void { this.anyHandlers.push(cb); }
  onBinary(cb: (data: ArrayBuffer) => void): void { this.binary = cb; }

  private fire(event: string, data: any): void {
    for (const cb of this.anyHandlers) cb(event, data);
    for (const cb of this.handlers.get(event) ?? []) cb(data);
  }

  /** A control event; resolves with the server's acknowledgement. */
  call(event: string, data: any = {}): Promise<Ack> {
    return new Promise((resolve) => {
      if (!this.ws || !this.connected) { resolve({ ok: false, text: "not connected" }); return; }
      const id = this.nextId++;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ e: event, d: data, id }));
      setTimeout(() => { if (this.pending.delete(id)) resolve({ ok: false, text: "no answer" }); }, 10000);
    });
  }

  /** A control event without waiting for its answer. */
  send(event: string, data: any = {}): void {
    if (this.ws && this.connected) this.ws.send(JSON.stringify({ e: event, d: data }));
  }

  sendBinary(channel: number, payload: Uint8Array): void {
    if (!this.ws || !this.connected) return;
    const frame = new Uint8Array(payload.length + 1);
    frame[0] = channel;
    frame.set(payload, 1);
    this.ws.send(frame);
  }
}
