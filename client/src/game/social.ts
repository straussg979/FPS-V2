// What the 3D client shows of the modes: chat (Enter: everyone, U: team), vote kicks (type "/kick name";
// F1 yes, F2 no), the duel's pause banner, and the end-of-match screen with the scoreboard and rating change.
// Text from other players only ever goes in with textContent.

import type { Ack } from "../common/socket";
import { el } from "./hud";
import type { Input } from "./input";

/* eslint-disable @typescript-eslint/no-explicit-any */
const CHAT_KEEP = 9000;

export interface SocialHooks {
  input: Input;
  send: (scope: string, text: string) => Promise<Ack>;
  control: (event: string, data: any) => Promise<Ack>;
  roster: () => any[];
  myTeam: () => number | null;
  onEnd: () => void;
}

export class Social {
  layer: HTMLDivElement;
  private log: HTMLUListElement;
  private box: HTMLFormElement;
  private scopeLabel: HTMLSpanElement;
  private field: HTMLInputElement;
  private voteBox: HTMLDivElement;
  private pauseBox: HTMLDivElement;
  private end: HTMLDivElement;
  scope = "all";
  open = false;
  paused = false;
  vote: any = null;
  ended = false;
  private lines: Array<[HTMLElement, number]> = [];

  constructor(root: HTMLElement, private hooks: SocialHooks) {
    this.layer = el("div", "social", root);
    this.log = el("ul", "chat-lines", this.layer);
    this.box = el("form", "chat-input hidden", this.layer);
    this.scopeLabel = el("span", "scope", this.box, "ALL");
    this.field = el("input", "", this.box);
    this.field.maxLength = 200;
    this.field.autocomplete = "off";
    this.field.setAttribute("aria-label", "Chat message");
    this.voteBox = el("div", "vote hidden", this.layer);
    this.pauseBox = el("div", "pause-banner hidden", this.layer);
    this.end = el("div", "endscreen hidden", root);
    this.box.addEventListener("submit", (e) => { e.preventDefault(); void this.submit(); });
    // while typing, keys stay in the box: the game's input (on document) must not see them
    this.field.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); this.close(); }
    });
    this.field.addEventListener("keyup", (e) => e.stopPropagation());
    document.addEventListener("keydown", (e) => this.onKey(e), true);
    setInterval(() => this.fade(), 500);
  }

  private onKey(e: KeyboardEvent): void {
    if (this.open || e.repeat) return;
    const input = this.hooks.input;
    if (!input.locked) return;
    const b = input.binds;
    if (e.code === (b.chat_all || "Enter") || e.code === (b.chat_team || "KeyU")) {
      e.preventDefault();
      e.stopPropagation();
      this.show(e.code === (b.chat_team || "KeyU") && this.hooks.myTeam() !== null ? "team" : "all");
    } else if (this.vote && (e.code === (b.vote_yes || "F1") || e.code === (b.vote_no || "F2"))) {
      e.preventDefault();
      e.stopPropagation();
      void this.hooks.control("vote:cast", { yes: e.code === (b.vote_yes || "F1") });
    }
  }

  show(scope: string): void {
    this.scope = scope;
    this.scopeLabel.textContent = scope === "team" ? "TEAM" : "ALL";
    this.open = true;
    this.hooks.input.enabled = false;
    this.hooks.input.releaseAll();
    this.box.classList.remove("hidden");
    this.layer.classList.add("typing");
    this.field.value = "";
    this.field.focus();
  }

  close(): void {
    this.open = false;
    this.hooks.input.enabled = true;
    this.box.classList.add("hidden");
    this.layer.classList.remove("typing");
    this.field.blur();
  }

  private async submit(): Promise<void> {
    const text = this.field.value.trim();
    this.close();
    if (!text) return;
    const kick = /^\/kick\s+(.+)$/i.exec(text);
    if (kick) {
      const name = kick[1].trim().toLowerCase();
      const p = this.hooks.roster().find((r) => !r.bot && r.name.toLowerCase() === name);
      if (!p) { this.system(`no player named ${kick[1].trim()}`); return; }
      const r = await this.hooks.control("vote:kick", { target: p.slot });
      if (!r.ok) this.system(r.text ?? "");
      return;
    }
    if (/^\/(yes|no)$/i.test(text)) {
      const r = await this.hooks.control("vote:cast", { yes: /yes/i.test(text) });
      if (!r.ok) this.system(r.text ?? "");
      return;
    }
    const r = await this.hooks.send(this.scope, text);
    if (!r.ok) this.system(r.text || "not sent");
  }

  line(parts: Array<[string, string]>, cls = ""): void {
    const li = el("li", cls, this.log);
    for (const [text, c] of parts) el("span", c || "", li, text);
    this.lines.push([li, performance.now()]);
    while (this.lines.length > 40) this.lines.shift()?.[0].remove();
    this.log.scrollTop = this.log.scrollHeight;
  }

  system(text: string): void { this.line([[text, "sys"]], "system"); }

  chat(ev: any): void {
    const who = `${ev.dead ? "(dead) " : ""}${ev.from}${ev.scope === "team" ? " (team)" : ev.scope === "spectators" ? " (spectator)" : ""}: `;
    const teamCls = ev.team === 0 ? "team0" : ev.team === 1 ? "team1" : "spec";
    this.line([[who, `who ${teamCls}`], [ev.text, "text"]]);
  }

  private fade(): void {
    const now = performance.now();
    for (const [li, t] of this.lines) li.classList.toggle("old", !this.open && now - t > CHAT_KEEP);
  }

  voteState(v: any): void {
    if (v.result) {
      this.vote = null;
      this.voteBox.classList.add("hidden");
      this.system(v.result === "passed" ? `${v.target} was kicked by vote` : `the vote to kick ${v.target} failed`);
      return;
    }
    if (!this.vote && v.by) this.system(`${v.by} started a vote to kick ${v.target}`);
    this.vote = v;
    this.voteBox.textContent = `Kick ${v.target}? ${v.yes} yes / ${v.no} no (${v.needed} needed) · ${v.left} s · F1 yes · F2 no`;
    this.voteBox.classList.remove("hidden");
  }

  setPaused(ev: any): void {
    this.paused = !!ev;
    this.pauseBox.classList.toggle("hidden", !ev);
    if (ev) this.pauseBox.textContent = `PAUSED · ${ev.who} disconnected · forfeits in ${ev.left} s unless they come back`;
  }

  showEnd(r: any, me: number | null): void {
    this.ended = true;
    this.hooks.onEnd();
    const box = el("div", "box");
    this.end.replaceChildren(box);
    const myTeam = this.hooks.myTeam();
    let title: string;
    if (r.winner_team === null || r.winner_team === undefined) title = "Draw";
    else if (myTeam === 0 || myTeam === 1) title = r.winner_team === myTeam ? "Victory" : "Defeat";
    else title = `Team ${r.winner_team + 1} wins`;
    el("h2", "", box, title);
    const raw = r.score || [0, 0];
    const score = myTeam === 1 ? [raw[1], raw[0]] : raw;
    let sub = `${score[0]} : ${score[1]}` + (r.overtime ? " after overtime" : "") + (r.forfeit != null ? ` · team ${r.forfeit + 1} forfeited` : "");
    if (r.mvp) sub += ` · MVP ${r.mvp}`;
    el("p", "sub", box, sub);
    const rating = r.ratings && me != null ? r.ratings[String(me)] : null;
    if (rating) el("p", "rating " + (rating.delta >= 0 ? "up" : "down"), box, `Rating ${rating.before} → ${rating.after} (${rating.delta >= 0 ? "+" : ""}${rating.delta})`);
    const table = el("table", "list", box);
    const head = el("tr", "", el("thead", "", table));
    for (const h of ["Player", "Team", "K", "D", "A", "ADR"]) el("th", "", head, h);
    const body = el("tbody", "", table);
    const rows = [...(r.players || []).map((p: any) => ({ ...p, human: true })), ...(r.bots || []).map((b: any) => ({ ...b, human: false }))];
    rows.sort((a, b) => (b.kills - a.kills) || (a.deaths - b.deaths));
    for (const p of rows) {
      const tr = el("tr", p.team === 0 ? "team0" : "team1", body);
      el("td", "", tr, p.human ? p.name : `${p.name} (bot)`);
      el("td", "", tr, p.team === 0 || p.team === 1 ? String(p.team + 1) : "-");
      el("td", "", tr, String(p.kills ?? 0));
      el("td", "", tr, String(p.deaths ?? 0));
      el("td", "", tr, p.human ? String(p.assists ?? 0) : "");
      el("td", "", tr, p.human ? String(Math.round((p.damage || 0) / Math.max(1, p.rounds || 1))) : "");
    }
    const actions = el("p", "actions", box);
    if (r.mode === "server") el("span", "muted", actions, `Next match in ${Math.round(r.next_in || 15)} s`);
    else {
      const a = el("a", "button", actions, r.lobby ? "Back to the lobby" : "Play again");
      a.href = r.lobby ? `/lobby/${r.lobby}` : "/play";
      const p = el("a", "button ghost", actions, "Profile");
      p.href = "/profile";
    }
    this.end.classList.remove("hidden");
    this.hooks.input.unlock();
  }

  hideEnd(): void {
    this.ended = false;
    this.end.classList.add("hidden");
  }
}
