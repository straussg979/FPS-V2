// The HTTP side: pages (home, sign-up, log-in, play, a lobby, the server browser, a duel challenge link,
// the 3D game, profiles, the leaderboard), the JSON API (matches, servers, the player's settings), /healthz
// and the client build under /assets/. Every page but home, sign-up and log-in needs an account. The modes
// themselves run over the WebSocket (gateway.ts).
//
// Request handling: the proxy trust (proxy.ts) decides the client's address and scheme; the signed session
// cookie (sessions.ts) carries the log-in; every state-changing request must carry the session's CSRF
// token; HTML and API responses are never cached (Cache-Control: no-store) and get a strict CSP with no
// inline scripts.

import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Json } from "@cs/shared/data";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config";
import { CLIENT_DIST } from "../paths";
import { clientBuilt, entry, gameAssetManifest, serveAsset } from "./assets";
import { isBanned, type Repo, type User, userSettings } from "./db";
import type { Gateway } from "./gateway";
import { DIFFICULTIES, PRESETS } from "./lobbies";
import { MatchLimit } from "./matches";
import * as P from "./pages";
import { LOBBY_CODE_RE, MATCH_ID_RE, TOKEN_RE } from "./protocol";
import type { ProxyTrust } from "./proxy";
import { leaderboard, profile } from "./results";
import { LoginLimiter, PASSWORD_MAX, PASSWORD_MIN, checkPassword, dummyHash, hashPassword, needsRehash, usernameProblem } from "./security";
import { COOKIE, type Session, type SessionCodec } from "./sessions";

export const SETTINGS_MAX_BYTES = 16 * 1024;

declare module "fastify" {
  interface FastifyRequest {
    session: Session;
    sessionDirty: boolean;
    user: User | null;
    clientIp: string;
    clientProto: "http" | "https";
  }
}

export interface ViewDeps { cfg: Config; repo: Repo; sessions: SessionCodec; proxy: ProxyTrust; gateway: Gateway; log: (m: string) => void }

export async function registerViews(app: FastifyInstance, d: ViewDeps): Promise<void> {
  const { cfg, repo, sessions, gateway } = d;
  const limiter = new LoginLimiter(cfg.loginAttempts);
  await app.register(cookie);
  await app.register(formbody, { bodyLimit: 32 * 1024 });
  app.addContentTypeParser("text/plain", { parseAs: "string", bodyLimit: SETTINGS_MAX_BYTES + 1024 }, (_req, body, done) => done(null, body));

  app.decorateRequest("session", null as unknown as Session);
  app.decorateRequest("sessionDirty", false);
  app.decorateRequest("user", null);
  app.decorateRequest("clientIp", "");
  app.decorateRequest("clientProto", "http");

  app.addHook("onRequest", async (req) => {
    const r = d.proxy.resolve(req.raw.socket.remoteAddress, req.headers, (req.raw.socket as { encrypted?: boolean }).encrypted === true);
    req.clientIp = r.ip;
    req.clientProto = r.proto;
    if (req.url.startsWith("/assets/") || req.url === "/healthz") return;
    const s = sessions.decode(req.cookies[COOKIE]);
    req.session = s ?? sessions.fresh();
    req.sessionDirty = !s;
    if (req.session.u !== undefined) {
      const u = await repo.userById(req.session.u);
      if (u && !isBanned(u)) req.user = u;
      else {
        req.session = sessions.fresh();
        req.sessionDirty = true;
      }
    }
  });

  app.addHook("onSend", async (req, reply, payload) => {
    if (req.url.startsWith("/assets/")) return payload;
    if (req.session && req.sessionDirty) {
      reply.setCookie(COOKIE, sessions.encode(req.session), sessions.cookieOptions(req.session));
    }
    if (!reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
    const host = req.headers.host ?? "";
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "same-origin");
    reply.header("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; " +
      `media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self' wss://${host} ws://${host}; font-src 'self'; ` +
      "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'");
    return payload;
  });

  // ---------------------------------------------------------------- helpers
  const flash = (req: FastifyRequest, text: string, cat = "error") => {
    req.session.f = [...(req.session.f ?? []), [cat, text]];
    req.sessionDirty = true;
  };
  const ctx = (req: FastifyRequest): P.PageCtx => {
    const flashes = req.session.f ?? [];
    if (flashes.length) {
      delete req.session.f;
      req.sessionDirty = true;
    }
    const origin = cfg.siteUrl || `${req.clientProto}://${req.headers.host ?? "localhost"}`;
    return { user: req.user, csrf: sessions.csrf(req.session), flashes, entry, siteUrl: origin };
  };
  const page = (reply: FastifyReply, body: string, code = 200) => reply.code(code).type("text/html; charset=utf-8").send(body);
  const csrfOk = (req: FastifyRequest): boolean => {
    const body = req.body as Record<string, unknown> | undefined;
    const token = req.headers["x-csrf-token"] ?? (body && typeof body === "object" ? body.csrf_token : undefined);
    return sessions.checkCsrf(req.session, token);
  };
  const needUser = (req: FastifyRequest, reply: FastifyReply): User | null => {
    if (req.user) return req.user;
    if (req.url.startsWith("/api/")) void reply.code(401).send({ error: "login required" });
    else {
      flash(req, "Log in to play.", "info");
      void reply.redirect(`/login?next=${encodeURIComponent(req.url)}`, 303);
    }
    return null;
  };
  const safeNext = (target: unknown): string => {
    if (typeof target !== "string" || !target.startsWith("/") || target.startsWith("//") || target.startsWith("/\\")) return "/play";
    return target;
  };
  const startSession = async (req: FastifyRequest, user: User, remember: boolean) => {
    const fresh = sessions.fresh();             // a new session on log-in (no fixation)
    req.session = { ...fresh, u: user.id, ...(remember ? { r: 1 as const } : {}), ...(req.session.f ? { f: req.session.f } : {}) };
    req.sessionDirty = true;
    await repo.updateUser(user.id, { lastLogin: Date.now() });
  };
  const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");

  // ------------------------------------------------------------------ pages
  app.get("/healthz", async (_req, reply) => reply.header("cache-control", "no-store").send({ ok: true, matches: gateway.matches.live().length,
    connections: gateway.bySid.size, client: clientBuilt() }));

  app.get("/favicon.ico", async (_req, reply) => reply.redirect("/favicon.svg", 301));
  app.get("/favicon.svg", async (_req, reply) => {
    const file = path.join(CLIENT_DIST, "favicon.svg");
    if (!fs.existsSync(file)) return reply.code(404).send("not found");
    return reply.header("cache-control", "public, max-age=86400").type("image/svg+xml").send(fs.createReadStream(file));
  });
  app.get("/assets/*", async (req, reply) => serveAsset(req, reply, (req.params as { "*": string })["*"]));

  app.get("/", async (req, reply) => page(reply, P.homePage(ctx(req))));

  app.get("/signup", async (req, reply) => (req.user ? reply.redirect("/play", 303) : page(reply, P.signupPage(ctx(req), {}))));
  app.post("/signup", async (req, reply) => {
    if (req.user) return reply.redirect("/play", 303);
    if (!csrfOk(req)) return page(reply, P.errorPage(ctx(req), 400, "The form expired. Go back and try again."), 400);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = str(b.username, 40).trim(), pw = str(b.password, 400), confirm = str(b.confirm, 400);
    const errors: Record<string, string[]> = {};
    if (pw.length < PASSWORD_MIN || pw.length > PASSWORD_MAX) errors.password = [`${PASSWORD_MIN}-${PASSWORD_MAX} characters`];
    if (pw !== confirm) errors.confirm = ["passwords differ"];
    let problem = usernameProblem(name);
    if (!problem && (await repo.userByName(name))) problem = "that name is taken";
    if (problem) errors.username = [problem];
    if (Object.keys(errors).length) return page(reply, P.signupPage(ctx(req), { username: name, errors }), 400);
    let user: User;
    try {
      user = await repo.createUser(name, await hashPassword(pw));
    } catch {
      return page(reply, P.signupPage(ctx(req), { username: name, errors: { username: ["that name is taken"] } }), 400);
    }
    await startSession(req, user, false);
    return reply.redirect("/play", 303);
  });

  app.get("/login", async (req, reply) => {
    if (req.user) return reply.redirect("/play", 303);
    return page(reply, P.loginPage(ctx(req), { next: str((req.query as Json).next, 400) || undefined }));
  });
  app.post("/login", async (req, reply) => {
    if (req.user) return reply.redirect("/play", 303);
    const next = str((req.query as Json).next, 400) || undefined;
    if (!csrfOk(req)) return page(reply, P.errorPage(ctx(req), 400, "The form expired. Go back and try again."), 400);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = str(b.username, 40).trim(), pw = str(b.password, PASSWORD_MAX + 1);
    if (!name || !pw) return page(reply, P.loginPage(ctx(req), { username: name, next, errors: { username: name ? [] : ["required"], password: pw ? [] : ["required"] } }), 400);
    const keys = [`ip:${req.clientIp}`, `user:${name.toLowerCase()}`];
    const wait = limiter.retryAfter(...keys);
    if (wait > 0) {
      flash(req, `Too many failed attempts. Try again in ${Math.trunc(wait) + 1} s.`);
      return page(reply, P.loginPage(ctx(req), { username: name, next }), 429);
    }
    const user = await repo.userByName(name);
    const ok = await checkPassword(user ? user.passwordHash : await dummyHash(), pw);
    if (!ok || !user) {
      limiter.failed(...keys);
      flash(req, "Wrong username or password.");
      return page(reply, P.loginPage(ctx(req), { username: name, next }), 401);
    }
    if (isBanned(user)) {
      flash(req, `This account is banned until ${new Date(user.bannedUntil as number).toISOString().slice(0, 16).replace("T", " ")} UTC. ${user.banReason}`);
      return page(reply, P.loginPage(ctx(req), { username: name, next }), 403);
    }
    limiter.succeeded(...keys);
    if (needsRehash(user.passwordHash)) await repo.updateUser(user.id, { passwordHash: await hashPassword(pw) });
    await startSession(req, user, b.remember === "y" || b.remember === "on");
    return reply.redirect(safeNext(next), 303);
  });

  app.post("/logout", async (req, reply) => {
    if (req.user && csrfOk(req)) {
      req.session = sessions.fresh();
      req.sessionDirty = true;
    }
    return reply.redirect("/", 303);
  });

  app.get("/play", async (req, reply) => {
    const u = needUser(req, reply);
    if (!u) return reply;
    const rating = await repo.findRating(u.id);
    const lobby = gateway.lobbies.ofUser(u.id);
    const matches = gateway.matches.list().map((m) => ({ ...m, mine: !!gateway.matches.get(String(m.id))?.stoppableBy(u.id) }));
    return page(reply, P.playPage(ctx(req), { matches, maxMatches: gateway.matches.maxMatches, rating,
      lobby: lobby ? lobby.code : null, servers: gateway.browserRows(), maps: gateway.lobbies.maps }));
  });

  // stop a match you started (the Play page's Stop button)
  app.post("/matches/:id/stop", async (req, reply) => {
    const u = needUser(req, reply);
    if (!u) return reply;
    if (!csrfOk(req)) return page(reply, P.errorPage(ctx(req), 400, "The form expired. Go back and try again."), 400);
    const id = String((req.params as { id: string }).id);
    const [ok, why] = gateway.stopMatch(u.id, u.username, id);
    flash(req, ok ? `Match ${id} stopped.` : `Could not stop the match: ${why}`, ok ? "ok" : "error");
    return reply.redirect("/play", 303);
  });

  app.get("/lobby/:code", async (req, reply) => {
    const u = needUser(req, reply);
    if (!u) return reply;
    const code = (req.params as { code: string }).code;
    if (!LOBBY_CODE_RE.test(code)) return page(reply, P.errorPage(ctx(req), 404, "No such page."), 404);
    if (code !== code.toUpperCase()) return reply.redirect(`/lobby/${code.toUpperCase()}`, 303);
    if (!gateway.lobbies.get(code)) {
      flash(req, `There is no lobby ${code} (it closes when everyone has left).`);
      return reply.redirect("/play", 303);
    }
    return page(reply, P.lobbyPage(ctx(req), { code, maps: gateway.lobbies.maps, difficulties: DIFFICULTIES, presets: PRESETS }));
  });

  app.get("/servers", async (req, reply) => {
    if (!needUser(req, reply)) return reply;
    return page(reply, P.serversPage(ctx(req), gateway.browserRows()));
  });

  app.get("/duel/:token", async (req, reply) => {
    const u = needUser(req, reply);
    if (!u) return reply;
    const token = (req.params as { token: string }).token;
    if (!TOKEN_RE.test(token)) return page(reply, P.errorPage(ctx(req), 404, "No such page."), 404);
    const ch = gateway.challenges.get(token);
    if (!ch) {
      flash(req, "That challenge has expired or was already answered.");
      return reply.redirect("/play", 303);
    }
    const mine = ch.fromId === u.id;
    if (!mine && ch.toId !== null && ch.toId !== u.id) {
      flash(req, "That challenge is for another player.");
      return reply.redirect("/play", 303);
    }
    return page(reply, P.duelPage(ctx(req), ch, mine));
  });

  app.get("/profile", async (req, reply) => {
    const u = needUser(req, reply);
    if (!u) return reply;
    return reply.redirect(`/profile/${encodeURIComponent(u.username)}`, 303);
  });

  app.get("/profile/:name", async (req, reply) => {
    if (!needUser(req, reply)) return reply;
    const user = await repo.userByName((req.params as { name: string }).name);
    if (!user) return page(reply, P.errorPage(ctx(req), 404, "No such player."), 404);
    return page(reply, P.profilePage(ctx(req), user, await profile(repo, user.id)));
  });

  app.get("/leaderboard", async (req, reply) => {
    if (!needUser(req, reply)) return reply;
    return page(reply, P.leaderboardPage(ctx(req), await leaderboard(repo)));
  });

  app.post("/matches", async (req, reply) => {
    const u = needUser(req, reply);
    if (!u) return reply;
    if (!csrfOk(req)) return page(reply, P.errorPage(ctx(req), 400, "The form expired. Go back and try again."), 400);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const num = (k: string, lo: number, hi: number, def: number) => {
      const v = b[k] === undefined || b[k] === "" ? def : Number(b[k]);
      if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${k}: ${lo}-${hi}`);
      return v;
    };
    let opts: Json;
    try {
      const difficulty = str(b.difficulty) || "normal";
      if (!DIFFICULTIES.includes(difficulty)) throw new Error("difficulty: unknown");
      const map = str(b.map) || "qalat";
      if (!gateway.lobbies.maps.includes(map)) throw new Error("map: unknown");
      const watch = ["1", "on", "true"].includes(str(b.watch));
      let bots = [num("bots_team0", 0, 5, 0), num("bots_team1", 0, 5, 2)];
      if (watch && bots[0] === 0) bots = [5, bots[1] || 5];       // a bot match to watch needs bots on both sides
      opts = { map, difficulty, bots, watch, shortTimers: ["1", "on", "true"].includes(str(b.short_timers)),
        title: str(b.title, 40).trim(), endAction: "restart", fastRounds: cfg.devFastRounds };
    } catch (e) {
      flash(req, `Could not start a match: ${(e as Error).message}`);
      return reply.redirect("/play", 303);
    }
    try {
      const h = await gateway.createMatch(u, opts, "bots");
      return reply.redirect(`/game/${h.id}${opts.watch ? "?as=spectate" : ""}`, 303);
    } catch (e) {
      flash(req, `Could not start a match: ${e instanceof MatchLimit ? e.message : "server error"}`);
      return reply.redirect("/play", 303);
    }
  });

  app.get("/game/:id", async (req, reply) => {
    if (!needUser(req, reply)) return reply;
    const id = (req.params as { id: string }).id;
    if (!MATCH_ID_RE.test(id)) return page(reply, P.errorPage(ctx(req), 404, "No such page."), 404);
    const mode = str((req.query as Json).as) || "play";
    if (mode !== "play" && mode !== "spectate") return page(reply, P.errorPage(ctx(req), 400, "Bad request."), 400);
    const h = gateway.matches.get(id);
    if (!h) {
      flash(req, "That match has ended.");
      return reply.redirect("/play", 303);
    }
    const manifest = gameAssetManifest();
    if (!manifest || !clientBuilt()) {
      flash(req, "The game client has not been built on this server (npm run build).");
      return reply.redirect("/play", 303);
    }
    return page(reply, P.gamePage(ctx(req), h.summary(), mode, manifest));
  });

  // -------------------------------------------------------------------- API
  app.get("/api/matches", async (req, reply) => (needUser(req, reply) ? reply.send(gateway.matches.list()) : reply));
  app.get("/api/servers", async (req, reply) => (needUser(req, reply) ? reply.send(gateway.browserRows()) : reply));

  /** The player's game settings (sensitivity, binds, volumes...), kept on the account so they follow the player. */
  app.get("/api/settings", async (req, reply) => {
    const u = needUser(req, reply);
    return u ? reply.send(userSettings(u)) : reply;
  });
  app.put("/api/settings", { bodyLimit: SETTINGS_MAX_BYTES + 1024 }, async (req, reply) => {
    const u = needUser(req, reply);
    if (!u) return reply;
    if (!csrfOk(req)) return reply.code(403).send({ error: "csrf" });
    const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? null);
    if (rawBody.length > SETTINGS_MAX_BYTES) return reply.code(413).send({ error: "too large" });
    let data: unknown;
    try {
      data = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch {
      return reply.code(400).send({ error: "not JSON" });
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return reply.code(400).send({ error: "expected an object" });
    await repo.updateUser(u.id, { settingsJson: JSON.stringify(data) });
    return reply.send({ ok: true });
  });

  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith("/api/") || req.url.startsWith("/assets/") || !req.session) return reply.code(404).send({ error: "not found" });
    return page(reply, P.errorPage(ctx(req), 404, "No such page."), 404);
  });

  app.setErrorHandler(async (e, req, reply) => {
    const err = e as Error & { statusCode?: number };
    d.log(`[http] ${req.method} ${req.url}: ${err.stack ?? err}`);
    const code = (err as { statusCode?: number }).statusCode ?? 500;
    if (req.url.startsWith("/api/") || !req.session) return reply.code(code).send({ error: code >= 500 ? "server error" : err.message });
    return page(reply, P.errorPage(ctx(req), code, code >= 500 ? "Something went wrong." : err.message), code);
  });
}
