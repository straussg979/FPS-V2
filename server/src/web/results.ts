// Match results into the database. A match worker sends a `result` when a match ends; `record` stores it: the
// matches row (the worker's own for its first match; a public server's later matches get "<match id>.<n>"),
// one match_players row per account that played, and for a ranked duel both players' Glicko-2 ratings and
// their rating_changes. A forfeit counts as a loss for the player who forfeited; a draw as half a win each.
// A crash sends no result, so it never changes a rating.

import type { Json } from "@cs/shared/data";
import type { MatchRow, Rating, Repo } from "./db";
import * as ranking from "./ranking";

export interface RatingDelta { before: number; after: number; delta: number; rd: number }

/** Store a result; returns {user id: delta} for a ranked duel (else {}). */
export async function record(repo: Repo, matchId: string, result: Json): Promise<Record<number, RatingDelta>> {
  const n = Number(result.match_no ?? 1);
  let row = await repo.matchById(matchId);
  if (n > 1 || !row || (row.resultJson !== "" && row.resultJson !== "{}" && row.ended !== null)) {
    const rid = `${matchId}.${n}`.slice(0, 16);
    const base = row;
    row = await repo.matchById(rid);
    if (!row) {
      await repo.createMatch({ id: rid, mode: result.mode ?? base?.mode ?? "bots", map: result.map ?? "qalat", title: base?.title ?? "",
        ranked: !!result.ranked, createdBy: base?.createdBy ?? null });
      row = (await repo.matchById(rid)) as MatchRow;
    }
  }
  await repo.updateMatch(row.id, { mode: result.mode ?? row.mode, ranked: !!result.ranked, map: result.map ?? row.map,
    resultJson: JSON.stringify(result), status: "ended", ended: Date.now(), endReason: result.forfeit !== null && result.forfeit !== undefined ? "forfeit" : "finished" });
  const winner = result.winner_team;
  for (const p of result.players ?? []) {
    if (typeof p.user_id !== "number") continue;
    const team = p.team ?? null;
    await repo.upsertMatchPlayer({ matchId: row.id, userId: p.user_id, team, kills: p.kills | 0, deaths: p.deaths | 0, assists: p.assists | 0,
      headshots: p.headshots | 0, damage: p.damage | 0, rounds: p.rounds | 0, won: winner === null || winner === undefined || team === null ? null : team === winner });
  }
  if (result.mode === "duel" && result.ranked) return rateDuel(repo, row.id, result);
  return {};
}

async function rateDuel(repo: Repo, matchId: string, result: Json): Promise<Record<number, RatingDelta>> {
  const players = (result.players ?? []).filter((p: Json) => typeof p.user_id === "number" && (p.team === 0 || p.team === 1));
  if (players.length !== 2 || players[0].team === players[1].team) return {};
  const [a, b] = [...players].sort((x: Json, y: Json) => x.team - y.team);
  const winner = result.winner_team;
  const scoreA = winner === null || winner === undefined ? 0.5 : winner === a.team ? 1.0 : 0.0;
  const ra = await repo.ratingOf(a.user_id), rb = await repo.ratingOf(b.user_id);
  const [newA, newB] = ranking.duel([ra.rating, ra.rd, ra.volatility], [rb.rating, rb.rd, rb.volatility], scoreA);
  const out: Record<number, RatingDelta> = {};
  const rows: Array<[Json, Rating, ranking.Glicko, number, Json]> = [[a, ra, newA, scoreA, b], [b, rb, newB, 1.0 - scoreA, a]];
  for (const [p, r, nw, score, opp] of rows) {
    const old = r.rating;
    [r.rating, r.rd, r.volatility] = nw;
    r.games += 1;
    r.updated = Date.now();
    await repo.saveRating(r);
    await repo.addRatingChange({ userId: p.user_id, matchId, opponentId: opp.user_id, before: old, after: r.rating, rdAfter: r.rd, score });
    out[p.user_id] = { before: Math.round(old), after: Math.round(r.rating), delta: Math.round(r.rating - old), rd: Math.round(r.rd) };
  }
  return out;
}

/** Totals for the profile page: K/D, ADR, headshot %, wins, rating and its history, recent matches. */
export async function profile(repo: Repo, userId: number): Promise<Json> {
  const rows = await repo.playerMatches(userId);
  let kills = 0, deaths = 0, damage = 0, rounds = 0, hs = 0, wins = 0, losses = 0;
  for (const { mp } of rows) {
    kills += mp.kills; deaths += mp.deaths; damage += mp.damage; rounds += mp.rounds; hs += mp.headshots;
    if (mp.won === true) wins++;
    if (mp.won === false) losses++;
  }
  const rating = await repo.findRating(userId);
  const history = await repo.ratingHistory(userId);
  const recent = rows.slice(0, 20).map(({ mp, m }) => {
    let res: Json = {};
    try { res = JSON.parse(m.resultJson || "{}"); } catch { res = {}; }
    return { id: m.id, mode: m.mode, ranked: m.ranked, map: m.map, ended: m.ended, score: res.score ?? null, team: mp.team, won: mp.won,
      kills: mp.kills, deaths: mp.deaths, damage: mp.damage, rounds: mp.rounds, forfeit: res.forfeit !== null && res.forfeit !== undefined };
  });
  return { matches: rows.length, kills, deaths, kd: kills / Math.max(deaths, 1), adr: damage / Math.max(rounds, 1), hs: 100 * hs / Math.max(kills, 1),
    wins, losses, rating, history: history.map((h) => ({ after: Math.round(h.after), before: Math.round(h.before), score: h.score,
      created: h.created, match_id: h.matchId })), recent };
}

export async function leaderboard(repo: Repo, limit = 50): Promise<Json[]> {
  const rows = await repo.leaderboard(limit);
  return rows.map(({ r, u }) => ({ name: u.username, rating: Math.round(r.rating), rd: Math.round(r.rd), games: r.games }));
}
