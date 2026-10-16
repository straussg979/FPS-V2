// The server-rendered pages (the old Jinja templates as functions). `html` escapes every interpolated value
// unless it is wrapped in raw() or is the result of another html`` call. Pages load no inline script: the
// site's and the game's modules come from the client build (content-hashed under /assets/).

import type { Json } from "@cs/shared/data";
import type { User } from "./db";
import { mapInfo } from "../paths";

/** <option>s for a map <select>: the map's key as the value, its display name as the label. */
function mapOptions(maps: string[]): Raw {
  const info = mapInfo();
  return raw(maps.map((m) => `<option value="${esc(m)}">${esc(info[m]?.name ?? m)}</option>`).join(""));
}

/** The map cards on the Play page: name, description and the two bomb sites. */
function mapCards(maps: string[]): Raw {
  const info = mapInfo();
  return raw(maps.map((m) => {
    const i = info[m] ?? { name: m, description: "", briefing: {} };
    const b = i.briefing ?? {};
    const sites = ["A", "B"].filter((s) => b[s]).map((s) => `<li><strong>${s}</strong> ${esc(b[s])}</li>`).join("");
    return `<article class="card map-card"><h3>${esc(i.name)}</h3>${b.region ? `<p class="muted">${esc(b.region)}</p>` : ""}` +
      `<p>${esc(i.description)}</p>${sites ? `<ul class="map-sites">${sites}</ul>` : ""}</article>`;
  }).join(""));
}

export class Raw {
  constructor(public s: string) {}
  toString(): string { return this.s; }
}
export const raw = (s: string): Raw => new Raw(s);

export function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function value(v: unknown): string {
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(value).join("");
  if (v === null || v === undefined || v === false) return "";
  return esc(v);
}

export function html(strings: TemplateStringsArray, ...vals: unknown[]): Raw {
  let out = strings[0];
  vals.forEach((v, i) => { out += value(v) + strings[i + 1]; });
  return new Raw(out);
}

export interface Entry { js: string; css: string[] }
export interface PageCtx {
  user: User | null;
  csrf: string;
  flashes: Array<[string, string]>;
  entry: (name: "site" | "game") => Entry;
  siteUrl: string;               // origin for share links
}

function scripts(e: Entry): Raw {
  return html`<script type="module" src="${e.js}" data-cfasync="false"></script>`;
}

function styles(e: Entry): Raw {
  return html`${e.css.map((c) => html`<link rel="stylesheet" href="${c}">`)}`;
}

export function layout(ctx: PageCtx, p: { title?: string; main: Raw; head?: Raw; bodyClass?: string; entry?: "site" | "game" | null }): string {
  const e = ctx.entry(p.entry ?? "site");
  const u = ctx.user;
  const nav = u ? html`
        <a href="/play">Play</a>
        <a href="/servers">Servers</a>
        <a href="/leaderboard">Leaderboard</a>
        <a class="who" href="/profile/${encodeURIComponent(u.username)}">${u.username}</a>
        <form method="post" action="/logout" class="inline">
          <input type="hidden" name="csrf_token" value="${ctx.csrf}">
          <button type="submit" class="link">Log out</button>
        </form>` : html`
        <a href="/login">Log in</a>
        <a href="/signup" class="button small">Sign up</a>`;
  return `<!doctype html>${html`
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${p.title ?? "COLD SECTOR"}</title>
  ${styles(e)}
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  ${p.head ?? ""}
</head>
<body class="${p.bodyClass ?? ""}">
  <header class="top">
    <a class="brand" href="/">COLD SECTOR</a>
    <nav>${nav}
    </nav>
  </header>
  ${ctx.flashes.length ? html`<div class="flashes">${ctx.flashes.map(([cat, msg]) => html`<p class="flash ${cat}">${msg}</p>`)}</div>` : ""}
  <main>${p.main}</main>
  ${p.entry === null ? "" : scripts(e)}
</body>
</html>`}`;
}

const readyDialog = html`
<dialog id="ready-check" class="ready">
  <h2>Duel found</h2>
  <p id="ready-text"></p>
  <p class="muted"><span id="ready-left">20</span> s to accept · <span id="ready-who"></span></p>
  <p class="row">
    <button type="button" class="button" id="ready-yes">Accept</button>
    <button type="button" class="button ghost" id="ready-no">Decline</button>
  </p>
</dialog>`;

export function homePage(ctx: PageCtx): string {
  const cta = ctx.user ? html`<a class="button" href="/play">Play</a>` : html`
    <p><a class="button" href="/signup">Create an account</a>
       <a class="button ghost" href="/login">Log in</a></p>
    <p class="muted">An account is needed to play or watch.</p>`;
  return layout(ctx, { entry: null, main: html`
<section class="hero">
  <h1>COLD SECTOR</h1>
  <p class="lede">A tactical shooter: one life per round, a charge to plant or stop, walls that come apart.
    Play against bots, duel another player, or drop into a public server.</p>
  ${cta}
</section>` });
}

interface FormField { name: string; label: string; type: string; value?: string; autocomplete: string; errors?: string[]; maxlength?: number }
function field(f: FormField): Raw {
  return html`
  <label>
    <span>${f.label}</span>
    <input id="${f.name}" name="${f.name}" type="${f.type}" value="${f.value ?? ""}" autocomplete="${f.autocomplete}" required${raw(f.maxlength ? ` maxlength="${f.maxlength}"` : "")}>
    ${(f.errors ?? []).map((e) => html`<em class="error">${e}</em>`)}
  </label>`;
}

export function loginPage(ctx: PageCtx, form: { username?: string; errors?: Record<string, string[]>; next?: string }): string {
  return layout(ctx, { title: "Log in · COLD SECTOR", entry: null, main: html`
<section class="card narrow">
  <h1>Log in</h1>
  <form method="post" novalidate${raw(form.next ? ` action="/login?next=${encodeURIComponent(form.next)}"` : "")}>
    <input type="hidden" name="csrf_token" value="${ctx.csrf}">
    ${field({ name: "username", label: "Username", type: "text", value: form.username, autocomplete: "username", errors: form.errors?.username, maxlength: 20 })}
    ${field({ name: "password", label: "Password", type: "password", autocomplete: "current-password", errors: form.errors?.password, maxlength: 128 })}
    <label class="check"><input id="remember" name="remember" type="checkbox" value="y"> <span>Keep me logged in</span></label>
    <button type="submit" class="button">Log in</button>
  </form>
  <p class="muted">No account? <a href="/signup">Sign up</a>.</p>
</section>` });
}

export function signupPage(ctx: PageCtx, form: { username?: string; errors?: Record<string, string[]> }): string {
  return layout(ctx, { title: "Sign up · COLD SECTOR", entry: null, main: html`
<section class="card narrow">
  <h1>Sign up</h1>
  <form method="post" novalidate>
    <input type="hidden" name="csrf_token" value="${ctx.csrf}">
    ${field({ name: "username", label: "Username", type: "text", value: form.username, autocomplete: "username", errors: form.errors?.username, maxlength: 20 })}
    ${field({ name: "password", label: "Password", type: "password", autocomplete: "new-password", errors: form.errors?.password, maxlength: 128 })}
    ${field({ name: "confirm", label: "Repeat password", type: "password", autocomplete: "new-password", errors: form.errors?.confirm, maxlength: 128 })}
    <p class="muted">3-20 characters (letters, digits, _ and -); a password of at least 8.</p>
    <button type="submit" class="button">Create account</button>
  </form>
</section>` });
}

const HUB_ICONS: Record<string, string> = {
  play: '<path d="M6 4l14 8-14 8V4z"/>',
  duel: '<path d="M14.5 3.5 20.5 3.5 20.5 9.5 9 21 3 15z"/><path d="M3 21l4-4"/>',
  servers: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  matches: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  maps: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/>',
};
function hubIcon(id: string): Raw {
  return raw(`<svg viewBox="0 0 24 24" aria-hidden="true">${HUB_ICONS[id] ?? ""}</svg>`);
}

/** The Play page: a side-tabbed hub on a plain background. */
export function playPage(ctx: PageCtx, d: { matches: Json[]; maxMatches: number; rating: { rating: number; games: number } | null; lobby: string | null;
  servers: Json[]; maps: string[] }): string {
  const r = d.rating;
  const u = ctx.user;
  const players = d.servers.reduce((n: number, s: Json) => n + (Number(s.players) || 0), 0);
  const tab = (id: string, label: string, badge = "") => html`
      <button type="button" data-tab-btn="${id}">${hubIcon(id)}<span>${label}</span>${badge ? html`<em>${badge}</em>` : ""}</button>`;
  const head = (title: string, blurb: string) => html`
      <header class="hub-head"><h3>${title}</h3><p>${blurb}</p></header>`;
  return layout(ctx, { title: "Play · COLD SECTOR", bodyClass: "hub-page", main: html`
<div id="site" class="hub" data-page="play" data-csrf="${ctx.csrf}">
  <aside class="hub-rail">
    <div class="hub-brand">
      <div class="eyebrow">Cold Sector</div>
      <h2>Main menu</h2>
      <div class="who">${u ? u.username : ""}</div>
      <div class="sub">Duel rating <strong>${Math.round(r ? r.rating : 1500)}</strong>
        ${r && r.games ? html`· ${r.games} ranked` : html`· unranked`}</div>
    </div>
    <nav class="hub-nav" aria-label="Play menu">
      ${tab("play", "Play")}
      ${tab("duel", "Duel")}
      ${tab("servers", "Public servers", players ? String(players) : "")}
      ${tab("matches", "Running matches", d.matches.length ? String(d.matches.length) : "")}
      ${tab("maps", "Maps")}
    </nav>
    <div class="hub-links">
      ${u ? html`<a class="button ghost" href="/profile/${encodeURIComponent(u.username)}">Profile</a>` : ""}
      <a class="button ghost" href="/leaderboard">Leaderboard</a>
    </div>
  </aside>

  <section class="hub-main">
    <div class="hub-panel" data-tab="play">
      ${head("Play", "Start a bot match now, or open a lobby and share its code with friends.")}
      <div class="hub-body hub-split">
        <article class="hub-card">
          <h4>Quick match</h4>
          <p class="muted">A bot match without a lobby: anyone can join it from the list.</p>
          <form method="post" action="/matches" class="grid">
            <input type="hidden" name="csrf_token" value="${ctx.csrf}">
            <div class="two">
              <label><span>Map</span><select name="map">${mapOptions(d.maps)}</select></label>
              <label><span>Difficulty</span>
                <select name="difficulty"><option>easy</option><option selected>normal</option><option>hard</option><option>expert</option></select></label>
              <label><span>Bots, attackers</span><input name="bots_team0" type="number" min="0" max="5" value="0"></label>
              <label><span>Bots, defenders</span><input name="bots_team1" type="number" min="0" max="5" value="2"></label>
            </div>
            <label><span>Title</span><input name="title" maxlength="40" placeholder="optional"></label>
            <label class="check"><input type="checkbox" name="short_timers" value="1" checked>
              <span>Short timers (2 s freeze, no preparation)</span></label>
            <label class="check"><input type="checkbox" name="watch" value="1">
              <span>Just watch: bots on both sides (5 v 5 when both counts are 0), you spectate</span></label>
            <button type="submit" class="button primary">Start a match</button>
          </form>
        </article>
        <article class="hub-card">
          <h4>Bot match lobby</h4>
          <p class="muted">A lobby with a code to share: up to 10 players, bots fill the empty places.</p>
          <p><button type="button" class="button" id="lobby-create">Create a lobby</button></p>
          <form id="lobby-join" class="row">
            <input name="code" maxlength="6" placeholder="Lobby code" autocomplete="off" aria-label="Lobby code">
            <button type="submit" class="button ghost">Join</button>
          </form>
          ${d.lobby ? html`<p class="muted">You are in lobby <a href="/lobby/${d.lobby}">${d.lobby}</a>.</p>` : ""}
        </article>
      </div>
    </div>

    <div class="hub-panel" data-tab="duel">
      ${head("Duel", "1v1 on site A, first to 9. Ranked duels use a Glicko-2 rating and a 20 s ready check.")}
      <div class="hub-body">
        <article class="hub-card">
          <h4>Ranked</h4>
          <div class="rating-big"><strong>${Math.round(r ? r.rating : 1500)}</strong>
            <span class="muted">${r && r.games ? `${r.games} ranked duels` : "unranked yet"}</span></div>
          <p class="row">
            <button type="button" class="button" id="queue-join">Find a ranked duel</button>
            <button type="button" class="button ghost hidden" id="queue-leave">Leave the queue</button>
          </p>
          <p class="muted" id="queue-status"></p>
        </article>
        <article class="hub-card">
          <h4>Challenge a player</h4>
          <form id="challenge" class="row">
            <input name="username" maxlength="20" placeholder="Player name (or leave empty for a link)" autocomplete="off" aria-label="Player to challenge">
            <button type="submit" class="button ghost">Challenge</button>
          </form>
          <p class="muted" id="challenge-status"></p>
          <ul class="incoming" id="incoming"></ul>
        </article>
      </div>
    </div>

    <div class="hub-panel" data-tab="servers">
      ${head("Public servers", "Always running: drop in and out, bots keep the teams full.")}
      <div class="hub-body">
        <ul class="servers-mini">
          ${d.servers.length ? d.servers.map((s) => html`<li><strong>${s.name}</strong> <span class="muted">${s.players}/${s.max} players · ${s.status}</span></li>`)
            : html`<li class="muted">None on this host.</li>`}
        </ul>
        <p><a class="button" href="/servers">Open the server browser</a></p>
      </div>
    </div>

    <div class="hub-panel" data-tab="matches">
      ${head(`Running matches (${d.matches.length} / ${d.maxMatches})`, "Join an open match, or watch any of them.")}
      <div class="hub-body">
        ${d.matches.length ? html`
        <table class="list">
          <thead><tr><th>Match</th><th>Mode</th><th>Status</th><th>Players</th><th>Bots</th><th>Round</th><th>Score</th><th></th></tr></thead>
          <tbody>
          ${d.matches.map((m) => html`
            <tr>
              <td>${m.title}</td><td>${m.mode}</td><td>${m.status} ${m.phase}</td><td>${m.players}</td>
              <td>${m.bots}</td><td>${m.round}</td><td>${m.score[0]} : ${m.score[1]}</td>
              <td class="actions">
                ${m.open ? html`<a class="button small" href="/game/${m.id}">Join</a>` : ""}
                <a class="button small ghost" href="/game/${m.id}?as=spectate">Watch</a>
                ${m.mine ? html`<form method="post" action="/matches/${m.id}/stop" class="inline" data-confirm="Stop this match? Everyone in it is sent back to the Play page.">
                  <input type="hidden" name="csrf_token" value="${ctx.csrf}">
                  <button type="submit" class="button small danger" title="You started this match">Stop</button>
                </form>` : ""}
              </td>
            </tr>`)}
          </tbody>
        </table>` : html`<p class="muted">None yet. Start one from the Play tab.</p>`}
      </div>
    </div>

    <div class="hub-panel" data-tab="maps">
      ${head("Maps · Afghanistan", "Two maps, each with two charge sites.")}
      <div class="hub-body"><div class="map-grid">${mapCards(d.maps)}</div></div>
    </div>
  </section>
</div>
${readyDialog}` });
}

export function lobbyPage(ctx: PageCtx, d: { code: string; maps: string[]; difficulties: string[]; presets: string[] }): string {
  const presetName: Record<string, string> = { full: "Full (first to 13, 24 rounds)", short: "Short (first to 7, 12 rounds)" };
  return layout(ctx, { title: `Lobby ${d.code} · COLD SECTOR`, main: html`
<div id="site" data-page="lobby" data-code="${d.code}" data-user="${ctx.user?.id ?? ""}">
<section class="lobby-head card">
  <div>
    <h1>Lobby <span class="code" id="lobby-code">${d.code}</span></h1>
    <p class="muted">Share the code or the link: <input class="share" readonly id="lobby-link" value="${ctx.siteUrl}/lobby/${d.code}" aria-label="Lobby link"></p>
  </div>
  <div class="lobby-status">
    <p id="lobby-status" class="status">Connecting…</p>
    <p class="row">
      <button type="button" class="button" id="lobby-start" disabled>Start the match</button>
      <a class="button hidden" id="lobby-go" href="#">Go to the match</a>
      <button type="button" class="button ghost hidden" id="lobby-again">Play again</button>
      <button type="button" class="button ghost" id="lobby-leave">Leave</button>
    </p>
  </div>
</section>
<section class="lobby-grid">
  <article class="card team t0">
    <h2>Team 1 · attack first <span class="muted" id="cap0"></span></h2>
    <ul id="team0" class="members"></ul>
    <button type="button" class="button small ghost" data-team="0">Join this team</button>
  </article>
  <article class="card team t1">
    <h2>Team 2 · defend first <span class="muted" id="cap1"></span></h2>
    <ul id="team1" class="members"></ul>
    <button type="button" class="button small ghost" data-team="1">Join this team</button>
  </article>
  <article class="card team spec">
    <h2>Spectators</h2>
    <ul id="teamspectate" class="members"></ul>
    <button type="button" class="button small ghost" data-team="spectate">Spectate</button>
  </article>
  <article class="card settings">
    <h2>Match settings <span class="muted" id="host-note"></span></h2>
    <form id="lobby-settings">
      <label><span>Map</span><select name="map">${mapOptions(d.maps)}</select></label>
      <label><span>Rules</span><select name="preset">${d.presets.map((p) => html`<option value="${p}">${presetName[p] ?? p}</option>`)}</select></label>
      <label><span>Bot difficulty</span><select name="difficulty">${d.difficulties.map((x) => html`<option>${x}</option>`)}</select></label>
      <label><span>Team 1 size</span><input type="number" name="size_attack" min="1" max="5"></label>
      <label><span>Team 2 size</span><input type="number" name="size_defend" min="1" max="5"></label>
      <label class="check"><input type="checkbox" name="humans_vs_bots"><span>Humans vs bots (every player on team 1, no bot teammates)</span></label>
      <label class="check"><input type="checkbox" name="friendly_fire"><span>Friendly fire</span></label>
    </form>
  </article>
  <article class="card chat-card">
    <h2>Chat</h2>
    <ul id="chat-log" class="chat-log"></ul>
    <form id="chat-form" class="row">
      <input name="text" maxlength="200" autocomplete="off" placeholder="Say something" aria-label="Message">
      <button type="submit" class="button small">Send</button>
    </form>
  </article>
  <article class="card result hidden" id="last-result">
    <h2>Last match</h2>
    <div id="result-body"></div>
  </article>
</section>
</div>` });
}

export function serversPage(ctx: PageCtx, servers: Json[]): string {
  return layout(ctx, { title: "Servers · COLD SECTOR", main: html`
<div id="site" data-page="servers">
<article class="card wide">
  <h2>Public servers <span class="muted" id="browser-note">live</span></h2>
  <table class="list" id="browser">
    <thead><tr><th>Server</th><th>Map</th><th>Players</th><th>Round</th><th>Score</th><th>Ping</th><th></th></tr></thead>
    <tbody>
    ${servers.length ? servers.map((s) => html`<tr data-id="${s.id}"><td>${s.name} <span class="muted">${s.region}</span></td><td>${s.map}</td>
        <td>${s.players}/${s.max} <span class="muted">+${s.bots} bots</span></td><td>${s.round}</td>
        <td>${s.score[0]} : ${s.score[1]}</td><td class="ping">–</td><td class="actions"></td></tr>`)
      : html`<tr><td colspan="7" class="muted">No public servers on this host.</td></tr>`}
    </tbody>
  </table>
  <p class="muted" id="browser-error"></p>
</article>
</div>` });
}

export function duelPage(ctx: PageCtx, ch: { token: string; fromName: string; toName: string }, mine: boolean): string {
  return layout(ctx, { title: "Duel · COLD SECTOR", main: html`
<div id="site" data-page="duel" data-token="${ch.token}" data-mine="${mine ? 1 : 0}">
<article class="card narrow">
  ${mine ? html`
    <h2>Your challenge</h2>
    <p>Send this link to the player you want to duel${ch.toName ? ` (${ch.toName})` : ""}. It works once, for 10 minutes.</p>
    <input class="share" readonly value="${ctx.siteUrl}/duel/${ch.token}" aria-label="Challenge link">
    <p class="muted" id="duel-status">Keep this page open: the duel starts when they accept.</p>` : html`
    <h2>${ch.fromName} challenges you to a duel</h2>
    <p class="muted">1v1, first to 9 rounds, unranked.</p>
    <p class="row">
      <button type="button" class="button" id="duel-accept">Accept</button>
      <button type="button" class="button ghost" id="duel-decline">Decline</button>
    </p>
    <p class="muted" id="duel-status"></p>`}
</article>
</div>
${readyDialog}` });
}

const fmtDate = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "");

export function profilePage(ctx: PageCtx, user: User, s: Json): string {
  const r = s.rating;
  let spark: Raw | string = "";
  if (s.history.length) {
    const vals = s.history.map((h: Json) => h.after);
    const lo = Math.min(...vals) - 20, hi = Math.max(...vals) + 20, n = vals.length;
    const pts = vals.map((v: number, i: number) => `${(400 * i / Math.max(n - 1, 1)).toFixed(1)},${(80 - 80 * (v - lo) / Math.max(hi - lo, 1)).toFixed(1)}`).join(" ");
    spark = html`
  <h2>Rating history</h2>
  <svg class="spark" viewBox="0 0 400 80" preserveAspectRatio="none" role="img" aria-label="Rating history">
    <polyline fill="none" stroke="currentColor" stroke-width="2" points="${pts}"/>
  </svg>
  <p class="muted">${s.history[0].before} → ${s.history[n - 1].after} over ${n} ranked duels</p>`;
  }
  return layout(ctx, { title: `${user.username} · COLD SECTOR`, entry: null, main: html`
<section class="card wide">
  <h1>${user.username}</h1>
  <div class="stats">
    <div><span>Duel rating</span><strong>${Math.round(r ? r.rating : 1500)}</strong>
      <em class="muted">${r && r.games ? `± ${Math.round(2 * r.rd)} · ${r.games} ranked` : "no ranked duels yet"}</em></div>
    <div><span>Matches</span><strong>${s.matches}</strong><em class="muted">${s.wins} won · ${s.losses} lost</em></div>
    <div><span>K/D</span><strong>${s.kd.toFixed(2)}</strong><em class="muted">${s.kills} / ${s.deaths}</em></div>
    <div><span>ADR</span><strong>${Math.round(s.adr)}</strong><em class="muted">damage per round</em></div>
    <div><span>Headshots</span><strong>${Math.round(s.hs)}%</strong><em class="muted">of kills</em></div>
  </div>
  ${spark}
  <h2>Recent matches</h2>
  ${s.recent.length ? html`
  <table class="list">
    <thead><tr><th>When</th><th>Mode</th><th>Result</th><th>Score</th><th>K</th><th>D</th><th>ADR</th></tr></thead>
    <tbody>
    ${s.recent.map((m: Json) => {
      const t = m.team ?? 0;
      return html`<tr><td>${fmtDate(m.ended)}</td><td>${m.mode}${m.ranked ? " (ranked)" : ""}</td>
        <td>${m.won === true ? "won" : m.won === false ? "lost" : "draw"}${m.forfeit ? " (forfeit)" : ""}</td>
        <td>${m.score ? `${m.score[t]} : ${m.score[1 - t]}` : ""}</td>
        <td>${m.kills}</td><td>${m.deaths}</td><td>${Math.round(m.damage / Math.max(m.rounds, 1))}</td></tr>`;
    })}
    </tbody>
  </table>` : html`<p class="muted">No finished matches yet.</p>`}
</section>` });
}

export function leaderboardPage(ctx: PageCtx, rows: Json[]): string {
  return layout(ctx, { title: "Leaderboard · COLD SECTOR", entry: null, main: html`
<section class="card wide">
  <h1>Ranked duels</h1>
  <p class="muted">Glicko-2 rating; ± is twice the rating deviation (how sure the rating is).</p>
  ${rows.length ? html`
  <table class="list">
    <thead><tr><th>#</th><th>Player</th><th>Rating</th><th>±</th><th>Duels</th></tr></thead>
    <tbody>
    ${rows.map((r, i) => html`<tr><td>${i + 1}</td><td><a href="/profile/${encodeURIComponent(r.name)}">${r.name}</a></td>
        <td>${r.rating}</td><td>${2 * r.rd}</td><td>${r.games}</td></tr>`)}
    </tbody>
  </table>` : html`<p class="muted">Nobody has played a ranked duel yet.</p>`}
</section>` });
}

export function gamePage(ctx: PageCtx, match: Json, mode: string, assetManifest: string): string {
  return layout(ctx, { title: `${match.title} · COLD SECTOR`, bodyClass: "game", entry: "game",
    head: html`<meta name="csrf-token" content="${ctx.csrf}">`, main: html`
<div id="game3d" data-match="${match.id}" data-mode="${mode}" data-assets="${assetManifest}">
  <canvas tabindex="0"></canvas>
  <div class="overlay">
    <div class="box">
      <div class="text">Loading…</div>
      <div class="brief hidden"></div>
      <p class="keys">WASD move · mouse aim · left fire · right aim · R reload · Space jump · C crouch ·
        Shift walk · Q/E lean · F use/defuse · 1-5 weapons · B buy · Tab scores · Enter chat · U team chat · Esc menu</p>
    </div>
  </div>
</div>` });
}

export function errorPage(ctx: PageCtx, code: number, text: string): string {
  return layout(ctx, { title: `${code} · COLD SECTOR`, entry: null, main: html`
<section class="card narrow">
  <h1>${code}</h1>
  <p>${text}</p>
  <p><a class="button ghost" href="/">Home</a></p>
</section>` });
}
