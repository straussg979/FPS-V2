// The site's live pages: play (lobbies, the duel queue and challenges), a lobby, the server browser and a
// duel link. One WebSocket per page; every event is a declared control event (server/src/web/protocol.ts).
// Text from other players is only ever set with textContent.

import "../styles/site.css";
import { type Ack, GameSocket } from "../common/socket";

/* eslint-disable @typescript-eslint/no-explicit-any */
const root = document.getElementById("site");
const page = root ? root.dataset.page ?? "" : "";
const $ = <T extends HTMLElement = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);
const need = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector<T>(sel) as T;

function el(tag: string, attrs: Record<string, any> = {}, ...children: Array<Node | string | null>): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, String(v));
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

if (root) {
  const socket = new GameSocket();
  const call = (event: string, data: any = {}): Promise<Ack> => socket.call(event, data);
  (window as any).__site = { socket, events: [] as any[], page };
  socket.onAny((name, data) => {
    const ev = (window as any).__site.events;
    ev.push([name, data]);
    if (ev.length > 200) ev.shift();
  });
  socket.on("kicked", (m) => { const s = $("#queue-status") ?? $("#lobby-status") ?? $("#browser-error"); if (s) s.textContent = `Disconnected: ${m.reason}`; });
  socket.on("disconnect", () => { const s = $("#lobby-status"); if (s) s.textContent = "Reconnecting…"; });

  // forms that ask first (e.g. stopping your own match); no inline scripts, so the strict CSP holds
  for (const f of document.querySelectorAll<HTMLFormElement>("form[data-confirm]")) {
    f.addEventListener("submit", (e) => { if (!window.confirm(f.dataset.confirm ?? "Are you sure?")) e.preventDefault(); });
  }

  // ------------------------------------------------------------ ready-check (duels)
  const dialog = $<HTMLDialogElement>("#ready-check");
  let readyToken: string | null = null;
  let readyTimer: number | undefined;
  const queueUi = (inQueue: boolean) => {
    $("#queue-join")?.classList.toggle("hidden", inQueue);
    $("#queue-leave")?.classList.toggle("hidden", !inQueue);
  };
  const showReady = (m: any) => {
    if (!dialog) return;
    readyToken = m.match_token;
    need("#ready-text").textContent = `${m.ranked ? "Ranked duel" : "Duel"} against ${m.opponent}` + (m.opponent_rating != null ? ` (${m.opponent_rating})` : "");
    need("#ready-who").textContent = "waiting for both players";
    need<HTMLButtonElement>("#ready-yes").disabled = false;
    let left = Math.round(m.seconds || 20);
    need("#ready-left").textContent = String(left);
    clearInterval(readyTimer);
    readyTimer = window.setInterval(() => { left = Math.max(0, left - 1); need("#ready-left").textContent = String(left); }, 1000);
    if (!dialog.open) dialog.showModal();
  };
  const closeReady = () => {
    clearInterval(readyTimer);
    readyToken = null;
    if (dialog && dialog.open) dialog.close();
  };
  if (dialog) {
    need("#ready-yes").addEventListener("click", async () => {
      need<HTMLButtonElement>("#ready-yes").disabled = true;
      const r = await call("ready", { match_token: readyToken, ready: true });
      if (!r.ok) need("#ready-who").textContent = r.text ?? "";
    });
    need("#ready-no").addEventListener("click", async () => { await call("ready", { match_token: readyToken, ready: false }); closeReady(); });
    dialog.addEventListener("cancel", (e) => e.preventDefault());
  }
  socket.on("queue:found", showReady);
  socket.on("ready:state", (m) => {
    if (m.status === "waiting") {
      const who = (m.players || []).map((n: string, i: number) => `${n}: ${m.ready[i] ? "ready" : "…"}`).join(" · ");
      const w = $("#ready-who");
      if (w) w.textContent = who;
    } else if (m.status === "go") {
      const w = $("#ready-who");
      if (w) w.textContent = "starting…";
    } else if (m.status === "cancelled") {
      closeReady();
      const s = $("#queue-status") ?? $("#duel-status");
      if (s) s.textContent = m.requeued ? "The other player didn't accept: back in the queue." : `Duel cancelled (${m.reason}).`;
      queueUi(!!m.requeued);
    }
  });
  socket.on("match:start", (m) => { closeReady(); location.href = m.url; });

  // ------------------------------------------------------------------ play page
  const addIncoming = (m: any) => {
    const list = $("#incoming");
    if (!list || list.querySelector(`[data-token="${CSS.escape(m.token)}"]`)) return;
    const li: HTMLElement = el("li", { "data-token": m.token }, el("span", { text: `${m.from} challenges you` }),
      el("button", { class: "button small", type: "button", text: "Accept", onclick: async () => {
        const r = await call("challenge:respond", { token: m.token, accept: true });
        if (!r.ok) li.replaceChildren(el("span", { class: "muted", text: r.text ?? "" }));
      } }),
      el("button", { class: "button small ghost", type: "button", text: "Decline", onclick: async () => {
        await call("challenge:respond", { token: m.token, accept: false });
        li.remove();
      } }));
    list.append(li);
  };
  socket.on("challenge:incoming", addIncoming);
  socket.on("challenge:declined", (m) => { const s = $("#challenge-status") ?? $("#duel-status"); if (s) s.textContent = `${m.by} declined your challenge.`; });

  if (page === "play") {
    // side tabs: remembered per browser, and #duel style links open a tab directly
    const tabs = [...document.querySelectorAll<HTMLButtonElement>("[data-tab-btn]")];
    const panels = [...document.querySelectorAll<HTMLElement>(".hub-panel")];
    const show = (id: string) => {
      if (!panels.some((p) => p.dataset.tab === id)) id = "play";
      for (const b of tabs) { b.classList.toggle("on", b.dataset.tabBtn === id); b.setAttribute("aria-current", b.dataset.tabBtn === id ? "page" : "false"); }
      for (const p of panels) p.classList.toggle("on", p.dataset.tab === id);
      try { localStorage.setItem("coldsector.hubTab", id); } catch { /* ignore */ }
    };
    for (const b of tabs) b.addEventListener("click", () => { show(b.dataset.tabBtn ?? "play"); history.replaceState(null, "", `#${b.dataset.tabBtn}`); });
    let first = location.hash.slice(1);
    if (!first) { try { first = localStorage.getItem("coldsector.hubTab") || "play"; } catch { first = "play"; } }
    show(first);
    need("#lobby-create").addEventListener("click", async () => {
      const r = await call("lobby:create", {});
      if (r.ok) location.href = `/lobby/${r.code}`;
      else alert(r.text);
    });
    need<HTMLFormElement>("#lobby-join").addEventListener("submit", (e) => {
      e.preventDefault();
      const code = ((e.target as HTMLFormElement).elements.namedItem("code") as HTMLInputElement).value.trim().toUpperCase();
      if (/^[A-Z0-9]{6}$/.test(code)) location.href = `/lobby/${code}`;
    });
    need("#queue-join").addEventListener("click", async () => {
      const r = await call("queue:join", { mode: "duel_ranked" });
      if (r.ok) queueUi(true);
      else need("#queue-status").textContent = r.text ?? "";
    });
    need("#queue-leave").addEventListener("click", async () => {
      await call("queue:leave", {});
      queueUi(false);
      need("#queue-status").textContent = "";
    });
    socket.on("queue:status", (m) => {
      queueUi(true);
      need("#queue-status").textContent = `Searching for ${Math.round(m.waiting)} s · rating ${m.rating} ± ${m.window} · ${m.in_queue} in the queue`;
    });
    need<HTMLFormElement>("#challenge").addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = ((e.target as HTMLFormElement).elements.namedItem("username") as HTMLInputElement).value.trim();
      const r = await call("challenge:send", name ? { username: name } : {});
      if (!r.ok) { need("#challenge-status").textContent = r.text ?? ""; return; }
      location.href = r.url;                // the challenge page waits for the answer and shows the link
    });
  }

  // ------------------------------------------------------------------- duel link
  if (page === "duel") {
    const token = root.dataset.token;
    const status = need("#duel-status");
    const accept = $("#duel-accept");
    if (accept) {
      accept.addEventListener("click", async () => {
        const r = await call("challenge:respond", { token, accept: true });
        status.textContent = r.ok ? "Accepted: confirm when the ready-check opens." : r.text ?? "";
      });
      need("#duel-decline").addEventListener("click", async () => {
        await call("challenge:respond", { token, accept: false });
        location.href = "/play";
      });
    }
  }

  // ------------------------------------------------------------------------ lobby
  if (page === "lobby") {
    const code = root.dataset.code;
    const me = Number(root.dataset.user);
    let state: any = null, lastMatch: string | null = null, sawOpen = false;
    const form = need<HTMLFormElement>("#lobby-settings");
    const status = need("#lobby-status");
    const memberLi = (m: any) => {
      const li = el("li", { class: m.online ? "" : "offline" }, el("span", { text: m.name }));
      if (m.host) li.append(el("span", { class: "tag", text: "host" }));
      if (m.user_id === me) li.append(el("span", { class: "tag", text: "you" }));
      if (!m.online) li.append(el("span", { class: "tag", text: "away" }));
      return li;
    };
    const renderResult = (r: any) => {
      need("#last-result").classList.remove("hidden");
      const head = el("p", { text: r.winner_team == null ? `Draw ${r.score[0]} : ${r.score[1]}`
        : `Team ${r.winner_team + 1} won ${r.score[r.winner_team]} : ${r.score[1 - r.winner_team]}` + (r.mvp ? ` · MVP ${r.mvp}` : "") });
      const rows = (r.players || []).map((p: any) => el("tr", {}, el("td", { text: p.name }), el("td", { text: `Team ${p.team + 1}` }),
        el("td", { text: String(p.kills) }), el("td", { text: String(p.deaths) }), el("td", { text: String(p.assists) }),
        el("td", { text: String(Math.round(p.damage / Math.max(1, p.rounds))) })));
      const table = el("table", { class: "list" }, el("thead", {}, el("tr", {}, ...["Player", "Team", "K", "D", "A", "ADR"].map((h) => el("th", { text: h })))),
        el("tbody", {}, ...rows));
      need("#result-body").replaceChildren(head, table);
    };
    const render = (s: any) => {
      state = s;
      const host = s.host === me;
      for (const t of ["0", "1", "spectate"]) need(`#team${t}`).replaceChildren(...s.members.filter((m: any) => String(m.team) === t).map(memberLi));
      const n0 = s.members.filter((m: any) => m.team === 0).length, n1 = s.members.filter((m: any) => m.team === 1).length;
      need("#cap0").textContent = `${n0}/${s.capacity[0]} players` + (s.settings.humans_vs_bots ? "" : `, ${Math.max(0, s.settings.size_attack - n0)} bots`);
      need("#cap1").textContent = s.capacity[1] ? `${n1}/${s.capacity[1]} players, ${Math.max(0, s.settings.size_defend - n1)} bots` : `${s.settings.size_defend} bots`;
      for (const [k, v] of Object.entries(s.settings)) {
        const f = form.elements.namedItem(k) as HTMLInputElement | null;
        if (!f || f === document.activeElement) continue;
        if (f.type === "checkbox") f.checked = !!v;
        else f.value = String(v);
      }
      for (const f of Array.from(form.elements) as HTMLInputElement[]) f.disabled = !host || s.status !== "open";
      need("#host-note").textContent = host ? "(you are the host)" : "(the host decides)";
      const labels: Record<string, string> = { open: "Waiting for the host to start", starting: "Starting…", live: "The match is on", ended: "The match is over" };
      status.textContent = labels[s.status] ?? s.status;
      const start = need<HTMLButtonElement>("#lobby-start");
      start.disabled = !host || s.status !== "open";
      start.classList.toggle("hidden", s.status !== "open");
      need("#lobby-again").classList.toggle("hidden", !(host && s.status === "ended"));
      const go = need<HTMLAnchorElement>("#lobby-go");
      const mine = s.members.find((m: any) => m.user_id === me);
      if (s.status === "live" && s.match_id) {
        go.href = `/game/${s.match_id}?as=${mine && mine.team !== "spectate" ? "play" : "spectate"}`;
        go.classList.remove("hidden");
        if (sawOpen && lastMatch !== s.match_id) { lastMatch = s.match_id; location.href = go.href; }
      } else go.classList.add("hidden");
      if (s.status === "open" || s.status === "starting") sawOpen = true;
      if (s.last_result) renderResult(s.last_result);
    };
    socket.on("connect", async () => {
      const r = await call("lobby:join", { code });
      if (r.ok) render(r.state);
      else { status.textContent = r.text ?? ""; setTimeout(() => { location.href = "/play"; }, 2500); }
    });
    socket.on("lobby:state", (s) => { if (s.code === code) render(s); });
    for (const b of Array.from(document.querySelectorAll<HTMLElement>("[data-team]"))) {
      b.addEventListener("click", async () => {
        const team = b.dataset.team === "spectate" ? "spectate" : Number(b.dataset.team);
        const r = await call("lobby:team", { team });
        if (!r.ok) status.textContent = r.text ?? "";
      });
    }
    form.addEventListener("change", async (e) => {
      const f = e.target as HTMLInputElement;
      let v: string | number | boolean = f.type === "checkbox" ? f.checked : f.value;
      if (f.type === "number") v = Math.max(1, Math.min(5, Math.round(Number(v) || 1)));
      const r = await call("lobby:update", { settings: { [f.name]: v } });
      if (!r.ok) { status.textContent = r.text ?? ""; if (state) render(state); }
    });
    need("#lobby-start").addEventListener("click", async () => {
      need<HTMLButtonElement>("#lobby-start").disabled = true;
      const r = await call("lobby:start", {});
      if (!r.ok) { status.textContent = r.text ?? ""; need<HTMLButtonElement>("#lobby-start").disabled = false; }
    });
    need("#lobby-again").addEventListener("click", () => void call("lobby:reopen", {}));
    need("#lobby-leave").addEventListener("click", async () => { await call("lobby:leave", {}); location.href = "/play"; });
    need<HTMLInputElement>("#lobby-link").addEventListener("focus", (e) => (e.target as HTMLInputElement).select());
    socket.on("chat:msg", (m) => {
      const log = need("#chat-log");
      log.append(el("li", {}, el("b", { text: `${m.from}: ` }), el("span", { text: m.text })));
      while (log.children.length > 100) log.firstChild?.remove();
      log.scrollTop = log.scrollHeight;
    });
    need<HTMLFormElement>("#chat-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = (e.target as HTMLFormElement).elements.namedItem("text") as HTMLInputElement;
      const text = input.value.trim();
      if (!text) return;
      const r = await call("chat", { scope: "lobby", text });
      if (r.ok) input.value = "";
      else status.textContent = r.text ?? "";
    });
  }

  // ------------------------------------------------------------- server browser
  if (page === "servers") {
    let ping: number | null = null;
    const body = need("#browser tbody");
    const row = (s: any) => {
      const full = s.players >= s.max;
      const up = s.status === "running" || s.status === "idle";
      const join = el("button", { class: "button small", type: "button", text: full ? "Full" : "Join" }) as HTMLButtonElement;
      join.disabled = full || !up;
      const watch = el("button", { class: "button small ghost", type: "button", text: "Watch" }) as HTMLButtonElement;
      watch.disabled = !up;
      const go = (as: string) => async () => {
        const r = await call("server:join", { server_id: s.id, as });
        if (r.ok) location.href = r.url;
        else need("#browser-error").textContent = r.text ?? "";
      };
      join.addEventListener("click", go("play"));
      watch.addEventListener("click", go("spectate"));
      return el("tr", { "data-id": s.id },
        el("td", {}, el("span", { text: s.name }), " ", el("span", { class: "muted", text: s.region })),
        el("td", { text: s.map }),
        el("td", {}, el("span", { text: `${s.players}/${s.max}` }), " ", el("span", { class: "muted", text: `+${s.bots} bots` })),
        el("td", { text: up ? `${s.round}${s.status === "idle" ? " (paused, empty)" : ""}` : s.status }),
        el("td", { text: `${s.score[0]} : ${s.score[1]}` }),
        el("td", { class: "ping", text: ping == null ? "–" : `${Math.round(ping)} ms` }),
        el("td", { class: "actions" }, join, " ", watch));
    };
    const render = (list: any[]) => {
      (window as any).__site.servers = list;
      if (!list.length) { body.replaceChildren(el("tr", {}, el("td", { colspan: "7", class: "muted", text: "No public servers on this host." }))); return; }
      body.replaceChildren(...list.map(row));
    };
    socket.on("connect", async () => {
      const r = await call("browser:watch", {});
      if (r.ok) render(r.servers);
      const t = performance.now();
      await call("ping", { t: Math.round(t) });
      ping = performance.now() - t;
    });
    socket.on("browser:update", (m) => render(m.servers));
  }
  socket.connect();
}
