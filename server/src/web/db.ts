// Database: SQLite (better-sqlite3, the default, user/web.db) or Postgres (DATABASE_URL=postgres://...),
// both through Drizzle. Tables: users, matches, match_players (one row per account that played a finished
// match), ratings (Glicko-2 per user and ranked mode) and rating_changes (the profile's history). The tables
// are created on start (CREATE TABLE IF NOT EXISTS); times are stored as epoch milliseconds.

import path from "node:path";
import Database from "better-sqlite3";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { bigint, boolean, doublePrecision, integer as pgInt, pgTable, serial, text as pgText, uniqueIndex as pgUnique } from "drizzle-orm/pg-core";
import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { USER_DIR } from "../paths";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ------------------------------------------------------------------ schemas
const sqlite = {
  users: sqliteTable("users", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    username: text("username").notNull(),
    usernameKey: text("username_key").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    created: integer("created").notNull(),
    lastLogin: integer("last_login"),
    isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
    bannedUntil: integer("banned_until"),
    banReason: text("ban_reason").notNull().default(""),
    settingsJson: text("settings_json").notNull().default("{}"),
  }),
  matches: sqliteTable("matches", {
    id: text("id").primaryKey(),
    mode: text("mode").notNull().default("bots"),
    ranked: integer("ranked", { mode: "boolean" }).notNull().default(false),
    map: text("map").notNull(),
    title: text("title").notNull().default(""),
    createdBy: integer("created_by"),
    created: integer("created").notNull(),
    ended: integer("ended"),
    status: text("status").notNull().default("running"),
    endReason: text("end_reason").notNull().default(""),
    resultJson: text("result_json").notNull().default("{}"),
  }),
  matchPlayers: sqliteTable("match_players", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    matchId: text("match_id").notNull(),
    userId: integer("user_id").notNull(),
    team: integer("team"),
    kills: integer("kills").notNull().default(0),
    deaths: integer("deaths").notNull().default(0),
    assists: integer("assists").notNull().default(0),
    damage: integer("damage").notNull().default(0),
    headshots: integer("headshots").notNull().default(0),
    rounds: integer("rounds").notNull().default(0),
    won: integer("won", { mode: "boolean" }),
  }, (t) => [uniqueIndex("match_players_match_user").on(t.matchId, t.userId)]),
  ratings: sqliteTable("ratings", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    mode: text("mode").notNull().default("duel"),
    rating: real("rating").notNull().default(1500),
    rd: real("rd").notNull().default(350),
    volatility: real("volatility").notNull().default(0.06),
    games: integer("games").notNull().default(0),
    updated: integer("updated").notNull(),
  }, (t) => [uniqueIndex("ratings_user_mode").on(t.userId, t.mode)]),
  ratingChanges: sqliteTable("rating_changes", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    matchId: text("match_id").notNull(),
    mode: text("mode").notNull().default("duel"),
    opponentId: integer("opponent_id"),
    before: real("before").notNull(),
    after: real("after").notNull(),
    rdAfter: real("rd_after").notNull(),
    score: real("score").notNull(),
    created: integer("created").notNull(),
  }),
};

const ms = (name: string) => bigint(name, { mode: "number" });
const pg = {
  users: pgTable("users", {
    id: serial("id").primaryKey(),
    username: pgText("username").notNull(),
    usernameKey: pgText("username_key").notNull().unique(),
    passwordHash: pgText("password_hash").notNull(),
    created: ms("created").notNull(),
    lastLogin: ms("last_login"),
    isAdmin: boolean("is_admin").notNull().default(false),
    bannedUntil: ms("banned_until"),
    banReason: pgText("ban_reason").notNull().default(""),
    settingsJson: pgText("settings_json").notNull().default("{}"),
  }),
  matches: pgTable("matches", {
    id: pgText("id").primaryKey(),
    mode: pgText("mode").notNull().default("bots"),
    ranked: boolean("ranked").notNull().default(false),
    map: pgText("map").notNull(),
    title: pgText("title").notNull().default(""),
    createdBy: pgInt("created_by"),
    created: ms("created").notNull(),
    ended: ms("ended"),
    status: pgText("status").notNull().default("running"),
    endReason: pgText("end_reason").notNull().default(""),
    resultJson: pgText("result_json").notNull().default("{}"),
  }),
  matchPlayers: pgTable("match_players", {
    id: serial("id").primaryKey(),
    matchId: pgText("match_id").notNull(),
    userId: pgInt("user_id").notNull(),
    team: pgInt("team"),
    kills: pgInt("kills").notNull().default(0),
    deaths: pgInt("deaths").notNull().default(0),
    assists: pgInt("assists").notNull().default(0),
    damage: pgInt("damage").notNull().default(0),
    headshots: pgInt("headshots").notNull().default(0),
    rounds: pgInt("rounds").notNull().default(0),
    won: boolean("won"),
  }, (t) => [pgUnique("match_players_match_user").on(t.matchId, t.userId)]),
  ratings: pgTable("ratings", {
    id: serial("id").primaryKey(),
    userId: pgInt("user_id").notNull(),
    mode: pgText("mode").notNull().default("duel"),
    rating: doublePrecision("rating").notNull().default(1500),
    rd: doublePrecision("rd").notNull().default(350),
    volatility: doublePrecision("volatility").notNull().default(0.06),
    games: pgInt("games").notNull().default(0),
    updated: ms("updated").notNull(),
  }, (t) => [pgUnique("ratings_user_mode").on(t.userId, t.mode)]),
  ratingChanges: pgTable("rating_changes", {
    id: serial("id").primaryKey(),
    userId: pgInt("user_id").notNull(),
    matchId: pgText("match_id").notNull(),
    mode: pgText("mode").notNull().default("duel"),
    opponentId: pgInt("opponent_id"),
    before: doublePrecision("before").notNull(),
    after: doublePrecision("after").notNull(),
    rdAfter: doublePrecision("rd_after").notNull(),
    score: doublePrecision("score").notNull(),
    created: ms("created").notNull(),
  }),
};

const DDL_SQLITE = `
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, username_key TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, created INTEGER NOT NULL, last_login INTEGER, is_admin INTEGER NOT NULL DEFAULT 0, banned_until INTEGER,
  ban_reason TEXT NOT NULL DEFAULT '', settings_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS matches (id TEXT PRIMARY KEY, mode TEXT NOT NULL DEFAULT 'bots', ranked INTEGER NOT NULL DEFAULT 0, map TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '', created_by INTEGER, created INTEGER NOT NULL, ended INTEGER, status TEXT NOT NULL DEFAULT 'running',
  end_reason TEXT NOT NULL DEFAULT '', result_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS match_players (id INTEGER PRIMARY KEY AUTOINCREMENT, match_id TEXT NOT NULL, user_id INTEGER NOT NULL, team INTEGER,
  kills INTEGER NOT NULL DEFAULT 0, deaths INTEGER NOT NULL DEFAULT 0, assists INTEGER NOT NULL DEFAULT 0, damage INTEGER NOT NULL DEFAULT 0,
  headshots INTEGER NOT NULL DEFAULT 0, rounds INTEGER NOT NULL DEFAULT 0, won INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS match_players_match_user ON match_players (match_id, user_id);
CREATE INDEX IF NOT EXISTS match_players_user ON match_players (user_id);
CREATE TABLE IF NOT EXISTS ratings (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, mode TEXT NOT NULL DEFAULT 'duel',
  rating REAL NOT NULL DEFAULT 1500, rd REAL NOT NULL DEFAULT 350, volatility REAL NOT NULL DEFAULT 0.06, games INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS ratings_user_mode ON ratings (user_id, mode);
CREATE TABLE IF NOT EXISTS rating_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, match_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'duel', opponent_id INTEGER, before REAL NOT NULL, after REAL NOT NULL, rd_after REAL NOT NULL, score REAL NOT NULL,
  created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS rating_changes_user ON rating_changes (user_id);
`;

const DDL_PG = `
CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT NOT NULL, username_key TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  created BIGINT NOT NULL, last_login BIGINT, is_admin BOOLEAN NOT NULL DEFAULT FALSE, banned_until BIGINT, ban_reason TEXT NOT NULL DEFAULT '',
  settings_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS matches (id TEXT PRIMARY KEY, mode TEXT NOT NULL DEFAULT 'bots', ranked BOOLEAN NOT NULL DEFAULT FALSE, map TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '', created_by INTEGER, created BIGINT NOT NULL, ended BIGINT, status TEXT NOT NULL DEFAULT 'running',
  end_reason TEXT NOT NULL DEFAULT '', result_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS match_players (id SERIAL PRIMARY KEY, match_id TEXT NOT NULL, user_id INTEGER NOT NULL, team INTEGER,
  kills INTEGER NOT NULL DEFAULT 0, deaths INTEGER NOT NULL DEFAULT 0, assists INTEGER NOT NULL DEFAULT 0, damage INTEGER NOT NULL DEFAULT 0,
  headshots INTEGER NOT NULL DEFAULT 0, rounds INTEGER NOT NULL DEFAULT 0, won BOOLEAN);
CREATE UNIQUE INDEX IF NOT EXISTS match_players_match_user ON match_players (match_id, user_id);
CREATE INDEX IF NOT EXISTS match_players_user ON match_players (user_id);
CREATE TABLE IF NOT EXISTS ratings (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, mode TEXT NOT NULL DEFAULT 'duel',
  rating DOUBLE PRECISION NOT NULL DEFAULT 1500, rd DOUBLE PRECISION NOT NULL DEFAULT 350, volatility DOUBLE PRECISION NOT NULL DEFAULT 0.06,
  games INTEGER NOT NULL DEFAULT 0, updated BIGINT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS ratings_user_mode ON ratings (user_id, mode);
CREATE TABLE IF NOT EXISTS rating_changes (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, match_id TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'duel',
  opponent_id INTEGER, before DOUBLE PRECISION NOT NULL, after DOUBLE PRECISION NOT NULL, rd_after DOUBLE PRECISION NOT NULL,
  score DOUBLE PRECISION NOT NULL, created BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS rating_changes_user ON rating_changes (user_id);
`;

export interface User {
  id: number; username: string; usernameKey: string; passwordHash: string; created: number; lastLogin: number | null;
  isAdmin: boolean; bannedUntil: number | null; banReason: string; settingsJson: string;
}
export interface MatchRow {
  id: string; mode: string; ranked: boolean; map: string; title: string; createdBy: number | null; created: number; ended: number | null;
  status: string; endReason: string; resultJson: string;
}
export interface Rating { id: number; userId: number; mode: string; rating: number; rd: number; volatility: number; games: number; updated: number }
export interface MatchPlayerRow {
  id: number; matchId: string; userId: number; team: number | null; kills: number; deaths: number; assists: number; damage: number;
  headshots: number; rounds: number; won: boolean | null;
}

export function userSettings(u: User): Record<string, unknown> {
  try {
    const v = JSON.parse(u.settingsJson || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export const isBanned = (u: User, now = Date.now()): boolean => u.bannedUntil !== null && u.bannedUntil > now;

/** The queries the site needs, the same for both databases. */
export class Repo {
  constructor(public db: any, public t: typeof sqlite, public dialect: "sqlite" | "postgres", private closeFn: () => Promise<void>) {}

  close(): Promise<void> { return this.closeFn(); }

  private async one<T>(q: Promise<T[]>): Promise<T | null> { return ((await q)[0] ?? null) as T | null; }

  // ------------------------------------------------------------- users
  userById(id: number): Promise<User | null> { return this.one(this.db.select().from(this.t.users).where(eq(this.t.users.id, id)).limit(1)); }

  userByName(name: string): Promise<User | null> {
    return this.one(this.db.select().from(this.t.users).where(eq(this.t.users.usernameKey, name.toLowerCase())).limit(1));
  }

  async createUser(username: string, passwordHash: string): Promise<User> {
    const rows = await this.db.insert(this.t.users).values({ username, usernameKey: username.toLowerCase(), passwordHash, created: Date.now(),
      settingsJson: "{}", banReason: "", isAdmin: false }).returning();
    return rows[0] as User;
  }

  async updateUser(id: number, values: Partial<User>): Promise<void> {
    await this.db.update(this.t.users).set(values).where(eq(this.t.users.id, id));
  }

  // ----------------------------------------------------------- matches
  async createMatch(row: { id: string; mode: string; map: string; title: string; ranked: boolean; createdBy: number | null }): Promise<void> {
    await this.db.insert(this.t.matches).values({ ...row, created: Date.now(), status: "running", endReason: "", resultJson: "{}" });
  }

  matchById(id: string): Promise<MatchRow | null> { return this.one(this.db.select().from(this.t.matches).where(eq(this.t.matches.id, id)).limit(1)); }

  async updateMatch(id: string, values: Partial<MatchRow>): Promise<void> {
    await this.db.update(this.t.matches).set(values).where(eq(this.t.matches.id, id));
  }

  async closeMatch(id: string, reason: string): Promise<void> {
    const m = await this.matchById(id);
    if (!m || m.ended !== null) return;
    const error = reason.startsWith("error") || reason.startsWith("worker");
    await this.updateMatch(id, { ended: Date.now(), status: error ? "error" : "ended", endReason: reason.slice(0, 200) });
  }

  async upsertMatchPlayer(row: Omit<MatchPlayerRow, "id">): Promise<void> {
    const t = this.t.matchPlayers;
    const old = await this.one<MatchPlayerRow>(this.db.select().from(t).where(and(eq(t.matchId, row.matchId), eq(t.userId, row.userId))).limit(1));
    if (old) await this.db.update(t).set(row).where(eq(t.id, old.id));
    else await this.db.insert(t).values(row);
  }

  // ----------------------------------------------------------- ratings
  async ratingOf(userId: number, mode = "duel"): Promise<Rating> {
    const t = this.t.ratings;
    const r = await this.one<Rating>(this.db.select().from(t).where(and(eq(t.userId, userId), eq(t.mode, mode))).limit(1));
    if (r) return r;
    const rows = await this.db.insert(t).values({ userId, mode, rating: 1500, rd: 350, volatility: 0.06, games: 0, updated: Date.now() }).returning();
    return rows[0] as Rating;
  }

  findRating(userId: number, mode = "duel"): Promise<Rating | null> {
    const t = this.t.ratings;
    return this.one(this.db.select().from(t).where(and(eq(t.userId, userId), eq(t.mode, mode))).limit(1));
  }

  async saveRating(r: Rating): Promise<void> {
    await this.db.update(this.t.ratings).set({ rating: r.rating, rd: r.rd, volatility: r.volatility, games: r.games, updated: r.updated })
      .where(eq(this.t.ratings.id, r.id));
  }

  async addRatingChange(row: { userId: number; matchId: string; opponentId: number | null; before: number; after: number; rdAfter: number;
    score: number }): Promise<void> {
    await this.db.insert(this.t.ratingChanges).values({ ...row, mode: "duel", created: Date.now() });
  }

  ratingHistory(userId: number): Promise<Array<{ before: number; after: number; score: number; created: number; matchId: string }>> {
    const t = this.t.ratingChanges;
    return this.db.select().from(t).where(eq(t.userId, userId)).orderBy(asc(t.created), asc(t.id));
  }

  playerMatches(userId: number): Promise<Array<{ mp: MatchPlayerRow; m: MatchRow }>> {
    const mp = this.t.matchPlayers, m = this.t.matches;
    return this.db.select({ mp, m }).from(mp).innerJoin(m, eq(mp.matchId, m.id)).where(eq(mp.userId, userId)).orderBy(desc(m.ended));
  }

  leaderboard(limit = 50): Promise<Array<{ r: Rating; u: User }>> {
    const r = this.t.ratings, u = this.t.users;
    return this.db.select({ r, u }).from(r).innerJoin(u, eq(r.userId, u.id)).where(and(eq(r.mode, "duel"), gt(r.games, 0)))
      .orderBy(desc(r.rating)).limit(limit);
  }
}

/** Open the database (DATABASE_URL: postgres:// or postgresql:// for Postgres, else the SQLite file). */
export async function openDb(url: string, log: (m: string) => void = console.log): Promise<Repo> {
  if (/^postgres(ql)?:\/\//.test(url)) {
    const { default: pgmod } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const pool = new pgmod.Pool({ connectionString: url, max: 10 });
    await pool.query(DDL_PG);
    log("[db] postgres");
    return new Repo(drizzle(pool), pg as unknown as typeof sqlite, "postgres", () => pool.end());
  }
  const file = url ? url.replace(/^sqlite:(\/\/\/?)?/, "") : path.join(USER_DIR, "web.db");
  const conn = new Database(file);
  conn.pragma("journal_mode = WAL");
  conn.pragma("busy_timeout = 5000");
  conn.exec(DDL_SQLITE);
  log(`[db] sqlite ${file}`);
  return new Repo(drizzleSqlite(conn), sqlite, "sqlite", async () => { conn.close(); });
}
