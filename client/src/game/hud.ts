// The HUD in HTML/CSS over the canvas (styles/game.css): health, armour, ammo, money with pop-ups, round
// timer and score, alive pips, kill feed, crosshair, hit markers, damage arcs and flash, flash-bang whiteout,
// messages, the scoreboard (Tab), the buy menu (B) and the radar on a 2D canvas.

import { PHASES, PROGRESS_KINDS } from "@cs/shared/codec";

/* eslint-disable @typescript-eslint/no-explicit-any */
export const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", parent: HTMLElement | null = null, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
};

const PHASE_NAMES: Record<string, string> = { waiting: "WARMUP", freeze: "BUY", prep: "PREPARATION", live: "", planted: "CHARGE PLANTED",
  round_end: "ROUND OVER", halftime: "HALF TIME", match_end: "MATCH OVER" };

export interface RadarDot { pos: [number, number]; color: string; big?: boolean; fade?: number; yaw?: number; diamond?: boolean; blink?: boolean }
export interface RadarSite { name: string; pos: [number, number] }
export interface CompassMarker { pos: [number, number]; label: string; color: string }
export interface RadarOptions { show: boolean; rotate: boolean; zoom: number }
export interface SpecialistChoice { key: string; name: string; role: string; desc: string; current: boolean; color: number[] }
export interface BuyModel { money: number; note: string; categories: Array<[string, any[]]>; onBuy: (k: string) => void; onSell: (k: string) => void;
  specialists: SpecialistChoice[]; onSpecialist: (k: string) => void }

export class Hud {
  layer: HTMLDivElement;
  private scoreL: HTMLSpanElement; private scoreR: HTMLSpanElement;
  private clock: HTMLDivElement; private phase: HTMLDivElement;
  private pipsL: HTMLDivElement; private pipsR: HTMLDivElement;
  private vitals: HTMLDivElement; private health: HTMLDivElement; private armor: HTMLDivElement;
  private money: HTMLDivElement; private moneyPops: HTMLDivElement;
  private ammoBox: HTMLDivElement; private weaponName: HTMLDivElement; private ammo: HTMLDivElement;
  private feed: HTMLDivElement; private center: HTMLDivElement;
  private progress: HTMLDivElement; private progressBar: HTMLDivElement; private progressText: HTMLDivElement;
  private status: HTMLDivElement; hint: HTMLDivElement;
  crosshair: HTMLDivElement;
  private hitmarker: HTMLDivElement; private damage: HTMLDivElement; private arcs: HTMLDivElement;
  private arcList: Array<{ el: HTMLElement; t: number }> = [];
  private blind: HTMLDivElement; private scope: HTMLDivElement;
  private radarCanvas: HTMLCanvasElement; private radarCtx: CanvasRenderingContext2D;
  private compassCanvas: HTMLCanvasElement; private compassCtx: CanvasRenderingContext2D;
  private compassBearing = NaN;
  private compassKey = "";
  private location: HTMLDivElement; private badges: HTMLDivElement;
  private healthBar: HTMLDivElement; private armorBar: HTMLDivElement;
  sites: RadarSite[] = [];
  radarOptions: RadarOptions = { show: true, rotate: true, zoom: 1 };
  radarImg: HTMLImageElement | null = null;
  private radarInfo: any = null;
  private board: HTMLDivElement; private buy: HTMLDivElement;
  buyKeys = new Map<string, string>();
  private feedItems: Array<{ row: HTMLElement; t: number }> = [];
  private centerUntil = 0;
  private hitT = 0; private damageT = 0; private blindT = 0; private blindStrength = 0; private blindDur = 1;

  constructor(root: HTMLElement) {
    this.layer = el("div", "hud", root);
    const top = el("div", "hud-top", this.layer);
    this.scoreL = el("span", "score team0", top, "0");
    const clockBox = el("div", "clock", top);
    this.clock = el("div", "time", clockBox, "0:00");
    this.phase = el("div", "phase", clockBox, "");
    this.scoreR = el("span", "score team1", top, "0");
    this.pipsL = el("div", "pips left", top);
    this.pipsR = el("div", "pips right", top);
    this.vitals = el("div", "hud-vitals", this.layer);
    this.health = el("div", "health", this.vitals, "100");
    this.armor = el("div", "armor", this.vitals, "0");
    this.healthBar = el("div", "bar hp", this.health);
    this.armorBar = el("div", "bar ap", this.armor);
    this.badges = el("div", "hud-badges", this.layer);
    this.location = el("div", "hud-location", this.layer);
    this.money = el("div", "hud-money", this.layer, "$0");
    this.moneyPops = el("div", "money-pops", this.layer);
    this.ammoBox = el("div", "hud-ammo", this.layer);
    this.weaponName = el("div", "weapon", this.ammoBox, "");
    this.ammo = el("div", "ammo", this.ammoBox, "");
    this.feed = el("div", "hud-feed", this.layer);
    this.center = el("div", "hud-center", this.layer);
    this.progress = el("div", "hud-progress", this.layer);
    this.progressBar = el("div", "bar", this.progress);
    this.progressText = el("div", "label", this.progress);
    this.status = el("div", "hud-status", this.layer);
    this.hint = el("div", "hud-hint", this.layer);
    this.crosshair = el("div", "crosshair", this.layer);
    for (const s of ["t", "b", "l", "r", "d", "c"]) el("i", s, this.crosshair);
    this.hitmarker = el("div", "hitmarker", this.layer);
    this.damage = el("div", "damage-flash", this.layer);
    this.arcs = el("div", "damage-arcs", this.layer);
    this.blind = el("div", "blind", this.layer);
    this.scope = el("div", "scope", this.layer);
    this.radarCanvas = el("canvas", "radar", this.layer);
    this.radarCanvas.width = this.radarCanvas.height = 220;
    this.radarCtx = this.radarCanvas.getContext("2d") as CanvasRenderingContext2D;
    this.compassCanvas = el("canvas", "hud-compass", this.layer);
    this.compassCanvas.width = 360;
    this.compassCanvas.height = 28;
    this.compassCtx = this.compassCanvas.getContext("2d") as CanvasRenderingContext2D;
    this.board = el("div", "scoreboard hidden", this.layer);
    this.buy = el("div", "buymenu hidden", this.layer);
  }

  /** The crosshair from the settings: style (classic, t, dot, circle), size, gap, thickness, colour, outline, opacity. */
  applyCrosshair(c: any): void {
    const x = this.crosshair;
    x.style.setProperty("--size", `${c.size}px`);
    x.style.setProperty("--thick", `${c.thickness}px`);
    x.style.setProperty("--color", c.color);
    x.style.setProperty("--base-gap", `${c.gap}px`);
    x.style.setProperty("--xh-opacity", String(c.opacity ?? 1));
    x.dataset.style = c.style ?? "classic";
    x.classList.toggle("dot", !!c.dot);
    x.classList.toggle("outline", c.outline !== false);
  }

  /** HUD layout options: scale, opacity and which parts are shown. */
  applyLayout(o: { scale: number; opacity: number; hitmarkers: boolean; damageFlash: boolean; damageArcs: boolean; killFeed: boolean; palette: string }): void {
    const l = this.layer;
    l.style.setProperty("--hud-scale", String(o.scale));
    l.style.setProperty("--hud-opacity", String(o.opacity));
    l.classList.toggle("no-hitmarkers", !o.hitmarkers);
    l.classList.toggle("no-damageflash", !o.damageFlash);
    l.classList.toggle("no-damagearcs", !o.damageArcs);
    l.classList.toggle("no-killfeed", !o.killFeed);
    const root = l.parentElement;
    if (root) root.dataset.palette = o.palette;
  }

  setStatus(text: string): void { this.status.textContent = text || ""; this.status.classList.toggle("show", !!text); }

  message(text: string, seconds = 3): void {
    this.center.textContent = text;
    this.center.className = "hud-center show";
    this.centerUntil = performance.now() + seconds * 1000;
  }

  killFeed(ev: any, mySlot: number | null): void {
    const row = el("div", "kill");
    el("span", "who", row, ev.killer ? ev.killer.name : "");
    el("span", "weapon", row, ` [${ev.weapon || "?"}${ev.headshot ? " ◎" : ""}] `);
    el("span", "who", row, ev.victim ? ev.victim.name : "?");
    if (ev.killer && ev.killer.slot === mySlot) row.classList.add("mine");
    if (ev.victim && ev.victim.slot === mySlot) row.classList.add("me");
    this.feed.prepend(row);
    this.feedItems.push({ row, t: performance.now() });
    while (this.feed.children.length > 6) this.feed.lastChild?.remove();
  }

  moneyPop(amount: number, reason: string): void {
    const p = el("div", amount >= 0 ? "pop plus" : "pop minus", this.moneyPops, `${amount >= 0 ? "+" : "-"}$${Math.abs(amount)}${reason ? "  " + reason.replace(/_/g, " ") : ""}`);
    setTimeout(() => p.remove(), 2600);
  }

  hit(killed: boolean, head: boolean): void {
    this.hitT = 0.25;
    this.hitmarker.className = `hitmarker show${killed ? " kill" : ""}${head ? " head" : ""}`;
  }

  hurt(): void { this.damageT = 0.4; }

  /** A red arc toward where the damage came from (bearing in degrees, 0 = ahead, positive = right). */
  damageArc(bearing: number, amount: number): void {
    const a = el("div", "arc", this.arcs);
    a.style.transform = `rotate(${bearing}deg)`;
    a.style.opacity = String(Math.min(1, 0.45 + amount / 60));
    this.arcList.push({ el: a, t: 1.6 });
  }

  flash(duration: number, strength: number): void {
    this.blindT = duration;
    this.blindDur = Math.max(duration, 0.1);
    this.blindStrength = strength;
  }

  setScope(on: boolean): void {
    this.scope.classList.toggle("show", on);
    this.crosshair.classList.toggle("hidden", on);
  }

  match(m: any, myTeam: number | null): void {
    if (!m) return;
    const phase = PHASES[m.phase] ?? "";
    const clock = Math.max(0, m.clock);
    this.clock.textContent = `${Math.floor(clock / 60)}:${String(Math.floor(clock % 60)).padStart(2, "0")}`;
    this.clock.classList.toggle("low", phase === "live" && clock < 10);
    this.phase.textContent = PHASE_NAMES[phase] ?? phase;
    const side0 = m.team0_side === 0 ? "ATK" : "DEF", side1 = m.team0_side === 0 ? "DEF" : "ATK";
    this.scoreL.textContent = `${side0} ${m.score[0]}`;
    this.scoreR.textContent = `${m.score[1]} ${side1}`;
    this.scoreL.classList.toggle("mine", myTeam === 0);
    this.scoreR.classList.toggle("mine", myTeam === 1);
    const pips = (box: HTMLElement, n: number) => {
      if (box.childElementCount !== n) { box.textContent = ""; for (let i = 0; i < n; i++) el("i", "", box); }
    };
    pips(this.pipsL, m.alive[0]);
    pips(this.pipsR, m.alive[1]);
  }

  vitalsUpdate(s: any, itemName: string, alive: boolean): void {
    this.vitals.classList.toggle("hidden", !alive);
    this.ammoBox.classList.toggle("hidden", !alive);
    this.money.classList.toggle("hidden", !s);
    if (!s) return;
    this.setNum(this.health, this.healthBar, s.health);
    this.health.classList.toggle("low", s.health <= 25);
    this.setNum(this.armor, this.armorBar, s.armor);
    this.money.classList.toggle("hidden", s.money === undefined);
    if (s.money !== undefined) this.money.textContent = `$${s.money}`;
    this.weaponName.textContent = itemName;
    const isGun = s.ammo > 0 || s.reserve > 0;
    this.ammo.textContent = isGun ? `${s.ammo} / ${s.reserve}` : "";
    this.ammo.classList.toggle("low", isGun && s.ammo <= 3);
    if (s.progress_kind) {
      this.progress.classList.add("show");
      this.progressBar.style.width = `${Math.round(s.progress * 100)}%`;
      this.progressText.textContent = (PROGRESS_KINDS[s.progress_kind] ?? "").toUpperCase();
    } else this.progress.classList.remove("show");
  }

  private setNum(box: HTMLElement, bar: HTMLElement, v: number): void {
    const t = String(v);
    if (box.firstChild?.nodeType === 3) { if (box.firstChild.nodeValue !== t) box.firstChild.nodeValue = t; }
    else box.insertBefore(document.createTextNode(t), box.firstChild);
    bar.style.width = `${Math.max(0, Math.min(100, v))}%`;
  }

  /** The callout you stand in (bottom left, under the radar). */
  setLocation(name: string): void { if (this.location.textContent !== name) this.location.textContent = name; }

  /** The charge, defuse-kit and helmet icons next to the health. */
  setBadges(charge: boolean, kit: boolean, helmet: boolean): void {
    const key = `${charge}${kit}${helmet}`;
    if (this.badges.dataset.k === key) return;
    this.badges.dataset.k = key;
    this.badges.textContent = "";
    if (helmet) el("span", "badge helmet", this.badges, "HELMET");
    if (charge) el("span", "badge charge", this.badges, "CHARGE");
    if (kit) el("span", "badge kit", this.badges, "KIT");
  }

  /** A big banner: round won or lost with the reason and the MVP, YOU DIED. */
  banner(title: string, sub = "", seconds = 3, cls = ""): void {
    this.center.textContent = "";
    this.center.className = `hud-center show banner ${cls}`;
    el("div", "title", this.center, title);
    if (sub) el("div", "sub", this.center, sub);
    this.centerUntil = performance.now() + seconds * 1000;
  }

  /** The crosshair opens with the weapon's current spread (pixels added to the configured gap). */
  setSpread(px: number): void { this.crosshair.style.setProperty("--gap", `${Math.round(Math.max(0, Math.min(80, px)))}px`); }

  update(dt: number): void {
    const now = performance.now();
    if (this.centerUntil && now > this.centerUntil) { this.center.classList.remove("show"); this.centerUntil = 0; }
    for (const it of this.feedItems) if (now - it.t > 7000) it.row.classList.add("old");
    this.feedItems = this.feedItems.filter((it) => { if (now - it.t < 9000) return true; it.row.remove(); return false; });
    if (this.hitT > 0) { this.hitT -= dt; if (this.hitT <= 0) this.hitmarker.classList.remove("show"); }
    if (this.damageT > 0) this.damageT -= dt;
    this.damage.style.opacity = String(Math.max(0, this.damageT / 0.4) * 0.5);
    for (const a of this.arcList) {
      a.t -= dt;
      if (a.t < 0.6) a.el.style.opacity = String(Math.max(0, a.t / 0.6) * 0.9);
      if (a.t <= 0) a.el.remove();
    }
    this.arcList = this.arcList.filter((a) => a.t > 0);
    if (this.blindT > 0) this.blindT -= dt;
    const b = this.blindT > 0 ? Math.min(1, this.blindT / Math.min(this.blindDur, 1.5)) * this.blindStrength : 0;
    this.blind.style.opacity = String(Math.max(0, Math.min(1, b)));
  }

  // ---------------------------------------------------------------- radar
  setRadar(image: HTMLImageElement, info: any): void { this.radarImg = image; this.radarInfo = info; }

  compassCanvasVisible(on: boolean): void { this.compassCanvas.classList.toggle("hidden", !on); }

  /** The compass strip under the score: the view's bearing (game yaw 0 = north, counter-clockwise). */
  compass(yaw: number, me: number[] | null = null, markers: CompassMarker[] = []): void {
    const bearing = (((-yaw) % 360) + 360) % 360;
    const key = markers.map((m) => m.label + m.pos[0].toFixed(0) + m.pos[1].toFixed(0)).join() + (me ? me[0].toFixed(1) + me[1].toFixed(1) : "");
    if (Math.abs(bearing - this.compassBearing) < 0.2 && key === this.compassKey) return;
    this.compassBearing = bearing;
    this.compassKey = key;
    const c = this.compassCtx, W = this.compassCanvas.width, H = this.compassCanvas.height;
    const span = 120, px = W / span;                       // degrees shown across the strip
    c.clearRect(0, 0, W, H);
    c.textAlign = "center";
    c.textBaseline = "top";
    const names: Record<number, string> = { 0: "N", 45: "NE", 90: "E", 135: "SE", 180: "S", 225: "SW", 270: "W", 315: "NW" };
    for (let d = Math.ceil((bearing - span / 2) / 5) * 5; d <= bearing + span / 2; d += 5) {
      const x = W / 2 + (d - bearing) * px;
      const deg = ((d % 360) + 360) % 360;
      const edge = 1 - Math.abs(x - W / 2) / (W / 2);
      c.globalAlpha = Math.max(0, Math.min(1, edge * 2));
      c.fillStyle = names[deg] ? "#fff" : "rgba(255,255,255,0.75)";
      if (names[deg]) {
        c.font = "700 13px system-ui, sans-serif";
        c.fillText(names[deg], x, 2);
      } else if (deg % 15 === 0) {
        c.font = "10px system-ui, sans-serif";
        c.fillText(String(deg), x, 4);
      }
      c.fillRect(Math.round(x), names[deg] || deg % 15 === 0 ? 18 : 21, 1, names[deg] || deg % 15 === 0 ? 8 : 5);
    }
    // sites, pings and the planted charge, by their bearing from you
    if (me) {
      c.font = "700 11px system-ui, sans-serif";
      for (const m of markers) {
        const b = ((Math.atan2(m.pos[0] - me[0], m.pos[1] - me[1]) * 180) / Math.PI + 360) % 360;
        const d = ((b - bearing + 540) % 360) - 180;
        const x = W / 2 + Math.max(-span / 2, Math.min(span / 2, d)) * px;
        c.globalAlpha = Math.abs(d) > span / 2 ? 0.5 : 1;
        c.fillStyle = m.color;
        c.fillRect(Math.round(x) - 7, 14, 14, 12);
        c.fillStyle = "#101418";
        c.fillText(m.label, x, 15);
      }
    }
    c.globalAlpha = 1;
    c.fillStyle = "#ffcf5a";
    c.beginPath();
    c.moveTo(W / 2 - 5, H);
    c.lineTo(W / 2 + 5, H);
    c.lineTo(W / 2, H - 6);
    c.fill();
  }

  radar(me: number[] | null, yaw: number, dots: RadarDot[]): void {
    const c = this.radarCtx, W = this.radarCanvas.width, H = this.radarCanvas.height;
    c.clearRect(0, 0, W, H);
    c.save();
    c.beginPath();
    c.arc(W / 2, H / 2, W / 2 - 2, 0, Math.PI * 2);
    c.clip();
    this.radarCanvas.classList.toggle("hidden", !this.radarOptions.show);
    c.fillStyle = "rgba(10,14,18,0.75)";
    c.fillRect(0, 0, W, H);
    const scale = 2.2 * this.radarOptions.zoom;          // pixels per metre
    const rot = this.radarOptions.rotate ? yaw : 0;
    if (this.radarImg && this.radarInfo && me) {
      const inf = this.radarInfo;
      c.translate(W / 2, H / 2);
      c.rotate(rot * Math.PI / 180);
      const imgW = inf.nx * inf.cell * scale, imgH = inf.ny * inf.cell * scale;
      const left = (inf.x0 - me[0]) * scale, top = -((inf.y0 + inf.ny * inf.cell) - me[1]) * scale;
      c.globalAlpha = 0.9;
      c.imageSmoothingEnabled = true;
      c.drawImage(this.radarImg, left, top, imgW, imgH);
      const blinkOn = Math.floor(performance.now() / 400) % 2 === 0;
      for (const d of dots) {
        if (d.blink && !blinkOn) continue;
        const x = (d.pos[0] - me[0]) * scale, y = -(d.pos[1] - me[1]) * scale;
        c.globalAlpha = d.fade ?? 1;
        c.fillStyle = d.color;
        c.beginPath();
        if (d.diamond) {                                     // the charge
          c.moveTo(x, y - 6); c.lineTo(x + 5, y); c.lineTo(x, y + 6); c.lineTo(x - 5, y);
        } else if (d.yaw !== undefined) {                    // a teammate: an arrow along their view
          const a = (-d.yaw * Math.PI) / 180;
          const pt = (r: number, ang: number) => [x + Math.sin(a + ang) * r, y - Math.cos(a + ang) * r];
          const [p0, p1, p2] = [pt(6, 0), pt(5, 2.5), pt(5, -2.5)];
          c.moveTo(p0[0], p0[1]); c.lineTo(p1[0], p1[1]); c.lineTo(p2[0], p2[1]);
        } else c.arc(x, y, d.big ? 4.5 : 3.5, 0, Math.PI * 2);
        c.fill();
      }
      c.globalAlpha = 1;
      c.setTransform(1, 0, 0, 1, 0, 0);
      // site letters, kept at the edge when out of range
      c.font = "700 14px system-ui, sans-serif";
      c.textAlign = "center";
      c.textBaseline = "middle";
      const r = (rot * Math.PI) / 180, R = W / 2 - 12;
      for (const st of this.sites) {
        let dx = (st.pos[0] - me[0]) * scale, dy = -(st.pos[1] - me[1]) * scale;
        [dx, dy] = [dx * Math.cos(r) - dy * Math.sin(r), dx * Math.sin(r) + dy * Math.cos(r)];
        const len = Math.hypot(dx, dy);
        if (len > R) { dx *= R / len; dy *= R / len; }
        c.fillStyle = "rgba(0,0,0,0.6)";
        c.fillText(st.name, W / 2 + dx + 1, H / 2 + dy + 1);
        c.fillStyle = "#ffd36a";
        c.fillText(st.name, W / 2 + dx, H / 2 + dy);
      }
    }
    c.save();
    c.translate(W / 2, H / 2);
    if (!this.radarOptions.rotate) c.rotate((-yaw * Math.PI) / 180);
    c.fillStyle = "#fff";
    c.beginPath();
    c.moveTo(0, -7);
    c.lineTo(-5, 5);
    c.lineTo(5, 5);
    c.closePath();
    c.fill();
    c.restore();
    c.restore();
    c.strokeStyle = "rgba(255,255,255,0.25)";
    c.lineWidth = 2;
    c.beginPath();
    c.arc(W / 2, H / 2, W / 2 - 2, 0, Math.PI * 2);
    c.stroke();
  }

  // ----------------------------------------------------------- scoreboard
  showBoard(on: boolean, roster: any[], stats: Map<number, any>, myTeam: number | null, scores: number[] | null, history: Array<{ team: number; reason: string }> = []): void {
    this.board.classList.toggle("hidden", !on);
    if (!on) return;
    this.board.textContent = "";
    if (history.length) {                                // round history: who won each round, and how
      const icons: Record<string, string> = { elimination: "✕", time: "◷", detonation: "✹", defuse: "✓", bomb_detonated: "✹", bomb_defused: "✓" };
      const row = el("div", "history", this.board);
      history.forEach((h, i) => {
        const cell = el("span", `round team${h.team}`, row, icons[h.reason] ?? "•");
        cell.title = `Round ${i + 1}: ${h.reason.replace(/_/g, " ")}`;
      });
    }
    for (const team of [0, 1]) {
      const col = el("div", `col team${team}${team === myTeam ? " mine" : ""}`, this.board);
      el("h3", "", col, `Team ${team === 0 ? "A" : "B"}  ${scores ? scores[team] : ""}`);
      const table = el("table", "", col);
      const head = el("tr", "", table);
      for (const h of ["", "Name", "K", "D", "A", "$"]) el("th", "", head, h);
      for (const p of roster.filter((r) => r.team === team)) {
        const st = stats.get(p.slot) ?? {};
        const tr = el("tr", st.alive === false ? "dead" : "", table);
        el("td", "", tr, p.bot ? "BOT" : "");
        el("td", "name", tr, p.name);
        el("td", "", tr, String(st.kills || 0));
        el("td", "", tr, String(st.deaths || 0));
        el("td", "", tr, String(st.assists || 0));
        el("td", "money", tr, st.money !== undefined ? `$${st.money}` : "");
      }
    }
  }

  // ------------------------------------------------------------- buy menu
  showBuy(on: boolean, model: BuyModel | null = null): void {
    this.buy.classList.toggle("hidden", !on);
    if (!on || !model) return;
    this.buy.textContent = "";
    el("h2", "", this.buy, `Buy  ·  $${model.money}`);
    if (model.note) el("p", "note", this.buy, model.note);
    const grid = el("div", "grid", this.buy);
    let n = 1;
    this.buyKeys = new Map();
    for (const [cat, items] of model.categories) {
      const col = el("div", "cat", grid);
      el("h4", "", col, cat);
      for (const it of items) {
        const b = el("button", `item${it.owned ? " owned" : ""}`, col);
        b.type = "button";
        b.disabled = !!it.disabled && !it.owned;
        if (n <= 9) { el("kbd", "", b, String(n)); this.buyKeys.set(`Digit${n}`, it.key); }
        el("span", "name", b, it.name);
        el("span", "price", b, it.owned ? "sell" : `$${it.price}`);
        b.addEventListener("click", () => (it.owned ? model.onSell(it.key) : model.onBuy(it.key)));
        n++;
      }
    }
    if (model.specialists.length) {
      // the last tab of the desktop buy menu: who you play this round (one of each per team; bots take the rest)
      el("h4", "spec-title", this.buy, "Specialist  (press 0 to cycle)");
      const row = el("div", "specialists", this.buy);
      for (const sp of model.specialists) {
        const b = el("button", `spec${sp.current ? " current" : ""}`, row);
        b.type = "button";
        b.title = sp.desc;
        b.style.setProperty("--spec", `rgb(${sp.color.map((c) => Math.round(c * 255)).join(",")})`);
        el("span", "name", b, sp.name);
        el("span", "role", b, sp.role);
        b.addEventListener("click", () => model.onSpecialist(sp.key));
      }
      const cur = model.specialists.findIndex((s) => s.current);
      this.buyKeys.set("Digit0", "specialist:" + model.specialists[(cur + 1) % model.specialists.length].key);
    }
    el("p", "help", this.buy, "Click or press the number to buy, click an owned item to sell it back. B or Esc closes.");
  }
}
