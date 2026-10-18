/**
 * Simulator persistence and data sources (SQL only; logic lives in engine.ts / scenario.ts / service.ts).
 *
 * Tables: sim_games, sim_prefs — migration src/db/migrations/0200_sim_games.sql.
 *
 * Own mode («Мои худшие дни», own.ts / ownService.ts) needs no migration: an own game is stored with mode 'intraday'
 * and difficulty 'medium' (the CHECK constraints of 0200) and is marked by params.own (the real trade). Own games are
 * excluded from the weekly board and the fair progress: the player knows the ticker, the date and how the day went.
 *
 * Bars:
 *   - intraday: only the permanent candle archive (lib/candleArchive) — listArchivedDays picks days with 1-minute /
 *     5-minute bars and already knows each day's gap, range and desk trades; readArchivedDays decodes the bars and
 *     never calls the provider. candles_cache is not read (a nightly job prunes it).
 *   - swing: daily bars from the provider's daily range (routes/candles fetchDailyRange: one call per symbol, kept in
 *     memory for 12 h). The archive only holds days the desk traded, too sparse for months of daily candles; when it
 *     grows, loadDailySeries is the one function to point at it.
 */
import { pool } from "@workspace/db";
import { logger } from "../logger";
import { cleanCandles } from "../candleClean";
import { listArchivedDays, readArchivedDays, type ArchiveListItem } from "../candleArchive";
import { fetchDailyRange } from "../candles/market";
import { addDays, nyDate } from "../tradingDate";
import type { SimBar, SimEvent, SimResult } from "./engine";
import type { Difficulty, Levels, SimMode, SimTf } from "./scenario";
import type { OwnParams } from "./own";

/* ─────────────────────────── Intraday (candle archive) ─────────────────────────── */

export type ArchivedBars = { bars: SimBar[]; tf: string; prevClose: number | null };

/** One archived day's bars (cleaned), or null when the archive does not have it. Never calls the provider. */
export async function loadDayBars(ticker: string, day: string): Promise<ArchivedBars | null> {
  const a = (await readArchivedDays(ticker, [day])).get(day);
  if (!a || !a.bars.length) return null;
  return { bars: cleanCandles(a.bars), tf: a.tf, prevClose: a.prevClose };
}

/** Weekdays strictly between two dates (holidays count — one is tolerated by the callers). */
export function weekdaysBetween(a: string, b: string): number {
  let n = 0;
  for (let d = addDays(a, 1); d < b; d = addDays(d, 1)) {
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

/**
 * The archived trading day before `day`: its bars (chart context — only when they are as fine as the game's bars)
 * and its regular-session high / low / close (PDH / PDL / PDC). Null when the archive has no day close enough.
 */
export async function loadPrevDay(ticker: string, day: string, maxBarSec: number): Promise<{ bars: SimBar[]; levels: { h: number; l: number; c: number } } | null> {
  const { items } = await listArchivedDays({ symbol: ticker, from: addDays(day, -7), to: addDays(day, -1), limit: 10 });
  const prev = items[0];
  if (!prev || weekdaysBetween(prev.day, day) > 1 || prev.high == null || prev.low == null || prev.close == null) return null;
  const sec = prev.tf === "1m" ? 60 : prev.tf === "5m" ? 300 : Infinity;
  const bars = sec <= maxBarSec ? (await loadDayBars(ticker, prev.day))?.bars ?? [] : [];
  return { bars, levels: { h: prev.high, l: prev.low, c: prev.close } };
}

export type IntradayCandidate = {
  ticker: string; day: string; tf: "1m" | "5m"; desk: number; gapPct: number | null; rangePct: number | null; prevClose: number | null;
};

async function allArchivedDays(f: { to: string; tf: "1m" | "5m" | "60m"; symbol?: string }, cap = 20_000): Promise<ArchiveListItem[]> {
  const out: ArchiveListItem[] = [];
  for (let offset = 0; offset < cap; offset += 2000) {
    const { items, total } = await listArchivedDays({ ...f, limit: 2000, offset });
    out.push(...items);
    if (out.length >= total || items.length < 2000) break;
  }
  return out;
}

/** Archived symbol-days with 1-minute bars (and 5-minute ones unless `need1m`), finest timeframe per day. */
export async function intradayCandidates(lastDay: string, need1m: boolean): Promise<IntradayCandidate[]> {
  const lists = await Promise.all(need1m ? [allArchivedDays({ to: lastDay, tf: "1m" })] : [allArchivedDays({ to: lastDay, tf: "1m" }), allArchivedDays({ to: lastDay, tf: "5m" })]);
  const byKey = new Map<string, IntradayCandidate>();
  for (const list of lists) {
    for (const it of list) {
      if (!/^[A-Z]{1,5}$/.test(it.symbol) || (it.tf !== "1m" && it.tf !== "5m")) continue;
      const k = `${it.symbol}:${it.day}`;
      if (byKey.has(k)) continue; // 1-minute list comes first
      byKey.set(k, { ticker: it.symbol, day: it.day, tf: it.tf, desk: it.deskTrades, gapPct: it.gapPct, rangePct: it.rangePct, prevClose: it.prevClose });
    }
  }
  return [...byKey.values()];
}

/* ─────────────────────────── Swing (daily range) ─────────────────────────── */

export type SwingCandidate = { ticker: string; desk: number };

/** Symbols the desk trades most (swing / overnight count triple): the swing pool. */
export async function swingCandidates(limit = 40): Promise<SwingCandidate[]> {
  const { rows } = await pool.query<{ tk: string; w: number }>(
    `SELECT ticker AS tk, (count(*) + 2 * count(*) FILTER (WHERE horizon IN ('swing', 'overnight')))::int AS w
       FROM trades WHERE deleted_at IS NULL AND ticker ~ '^[A-Z]{1,5}$'
      GROUP BY 1 ORDER BY 2 DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({ ticker: r.tk, desk: Number(r.w) || 0 }));
}

const DAILY_TTL = 12 * 3600_000;
const dailyMemo = new Map<string, { at: number; v: { bars: SimBar[]; dates: string[] } }>();

/** About two years of daily bars up to `lastDay`, oldest first, with their dates. Empty when the provider fails. */
export async function loadDailySeries(ticker: string, lastDay: string): Promise<{ bars: SimBar[]; dates: string[] }> {
  const k = `${ticker}:${lastDay}`;
  const hit = dailyMemo.get(k);
  if (hit && Date.now() - hit.at < DAILY_TTL) return hit.v;
  let v: { bars: SimBar[]; dates: string[] } = { bars: [], dates: [] };
  try {
    const raw = (await fetchDailyRange(ticker, addDays(lastDay, -730), lastDay)) ?? [];
    const bars = cleanCandles(raw.filter((b) => b.o > 0 && b.c > 0));
    // A daily bar's timestamp is the session open; its New York date is the trading day.
    const dates = bars.map((b) => nyDate(new Date(b.t * 1000)));
    v = { bars: bars.map((b, i) => ({ ...b, t: Date.parse(`${dates[i]}T00:00:00Z`) / 1000 })), dates };
  } catch (err) {
    logger.warn({ err, ticker }, "sim: daily range failed");
  }
  if (dailyMemo.size > 200) dailyMemo.delete(dailyMemo.keys().next().value as string);
  if (v.bars.length) dailyMemo.set(k, { at: Date.now(), v });
  return v;
}

/** Contiguous runs as [from, to] index pairs: a run breaks where more than one weekday is missing between two
 *  days (one is a holiday; two or more means a hole and the chart would silently skip days). */
export function contiguousRuns(dates: readonly string[]): [number, number][] {
  const out: [number, number][] = [];
  let from = 0;
  for (let i = 1; i <= dates.length; i++) {
    const broken = i === dates.length || weekdaysBetween(dates[i - 1], dates[i]) > 1;
    if (broken) { out.push([from, i - 1]); from = i; }
  }
  return dates.length ? out : [];
}

/* ─────────────────────────── Fees ─────────────────────────── */

let feeCache: { rate: number; at: number } | null = null;
const FEE_TTL = 6 * 3600_000;
export const DEFAULT_FEE_PER_SHARE = 0.005;

/** The desk's real cost per share per fill over the last 90 days (all fees / both sides of every share). */
export async function deskFeePerShare(today: string): Promise<number> {
  if (feeCache && Date.now() - feeCache.at < FEE_TTL) return feeCache.rate;
  let rate = DEFAULT_FEE_PER_SHARE;
  try {
    const { rows } = await pool.query<{ rate: string | null }>(
      `SELECT sum(abs(fees)) / NULLIF(sum(qty) * 2, 0) AS rate FROM trades
        WHERE deleted_at IS NULL AND qty > 0 AND fees IS NOT NULL AND ticker ~ '^[A-Z]{1,5}$' AND left(date, 10) >= $1`,
      [addDays(today, -90)],
    );
    const v = Number(rows[0]?.rate);
    if (Number.isFinite(v) && v >= 0.0005 && v <= 0.05) rate = Math.round(v * 100000) / 100000;
  } catch (err) {
    logger.warn({ err }, "sim: desk fee rate failed, using default");
  }
  feeCache = { rate, at: Date.now() };
  return rate;
}

/* ─────────────────────────── Games ─────────────────────────── */

export type GameParams = {
  feePerShare: number;
  riskUnit: number;
  defaultQty: number;
  maxNotional: number;
  levels: Levels;
  /** Fake times of every bar (what the client sees). */
  times: number[];
  longName?: string | null;
  /** Own mode: the real trade (server only until the reveal). */
  own?: OwnParams;
};

export type GameRow = {
  id: number;
  userId: number;
  mode: SimMode;
  difficulty: Difficulty;
  ticker: string;
  day: string;
  dayTo: string | null;
  tf: SimTf;
  bars: SimBar[];
  startIdx: number;
  endIdx: number;
  cursor: number;
  params: GameParams;
  events: SimEvent[];
  status: "active" | "finished" | "abandoned";
  result: (SimResult & Record<string, unknown>) | null;
  createdAt: string;
  finishedAt: string | null;
};

type DbGame = {
  id: string; user_id: number; mode: SimMode; difficulty: Difficulty; ticker: string; day: string; day_to: string | null; tf: SimTf;
  bars: [number, number, number, number, number, number][]; start_idx: number; end_idx: number; cursor_idx: number;
  params: GameParams; events: SimEvent[]; status: GameRow["status"]; result: GameRow["result"]; created_at: Date; finished_at: Date | null;
};

function fromDb(r: DbGame): GameRow {
  return {
    id: Number(r.id), userId: r.user_id, mode: r.mode, difficulty: r.difficulty, ticker: r.ticker, day: r.day, dayTo: r.day_to, tf: r.tf,
    bars: (r.bars ?? []).map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v })),
    startIdx: r.start_idx, endIdx: r.end_idx, cursor: r.cursor_idx, params: r.params, events: r.events ?? [], status: r.status,
    result: r.result, createdAt: new Date(r.created_at).toISOString(), finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
  };
}

export async function insertGame(g: Omit<GameRow, "id" | "status" | "result" | "createdAt" | "finishedAt" | "events">): Promise<GameRow> {
  const bars = g.bars.map((b) => [b.t, b.o, b.h, b.l, b.c, b.v]);
  const { rows } = await pool.query<DbGame>(
    `INSERT INTO sim_games (user_id, mode, difficulty, ticker, day, day_to, tf, bars, start_idx, end_idx, cursor_idx, params)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12::jsonb)
     RETURNING *`,
    [g.userId, g.mode, g.difficulty, g.ticker, g.day, g.dayTo, g.tf, JSON.stringify(bars), g.startIdx, g.endIdx, g.cursor, JSON.stringify(g.params)],
  );
  return fromDb(rows[0]);
}

export async function loadGame(id: number): Promise<GameRow | null> {
  const { rows } = await pool.query<DbGame>(`SELECT * FROM sim_games WHERE id = $1`, [id]);
  return rows[0] ? fromDb(rows[0]) : null;
}

export async function activeGameId(userId: number): Promise<number | null> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM sim_games WHERE user_id = $1 AND status = 'active' ORDER BY id DESC LIMIT 1`, [userId]);
  return rows[0] ? Number(rows[0].id) : null;
}

export async function saveProgress(id: number, cursor: number, events: SimEvent[]): Promise<void> {
  await pool.query(`UPDATE sim_games SET cursor_idx = $2, events = $3::jsonb, updated_at = NOW() WHERE id = $1 AND status = 'active'`, [id, cursor, JSON.stringify(events)]);
}

export async function saveFinished(id: number, cursor: number, events: SimEvent[], result: SimResult & Record<string, unknown>): Promise<void> {
  await pool.query(
    `UPDATE sim_games SET cursor_idx = $2, events = $3::jsonb, status = 'finished', result = $4::jsonb,
            net_pnl = $5, r_total = $6, pct = $7, bh_pct = $8, beat_bh = $9, trades_count = $10, finished_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'active'`,
    [id, cursor, JSON.stringify(events), JSON.stringify(result), result.net, result.r, result.pct, result.bh.pct, result.beatBh, result.trades],
  );
}

export async function markAbandoned(id: number): Promise<void> {
  await pool.query(`UPDATE sim_games SET status = 'abandoned', updated_at = NOW() WHERE id = $1 AND status = 'active'`, [id]);
}

/** (ticker, day) of the user's recent games of a mode — not offered again. */
export async function recentScenarioKeys(userId: number, mode: SimMode, limit = 300): Promise<Set<string>> {
  const { rows } = await pool.query<{ ticker: string; day: string }>(
    `SELECT ticker, day FROM sim_games WHERE user_id = $1 AND mode = $2 ORDER BY id DESC LIMIT $3`,
    [userId, mode, limit],
  );
  return new Set(rows.map((r) => `${r.ticker}:${r.day}`));
}

/* ─────────────────────────── Desk trades (reveal) ─────────────────────────── */

export type DeskTradeRow = {
  id: number; trader: string; side: string | null; entry: string | null; exit: string | null; stop: string | null; qty: string | null;
  pnl: string | null; fees: string | null; risk_usd: string | null; r_multiple: string | null; result: string | null; horizon: string | null;
  date: string; exit_date: string | null;
  execs: { kind: string; price: string; qty: string | null; at: string | null }[];
};

export async function deskTradesForDay(ticker: string, day: string): Promise<DeskTradeRow[]> {
  const { rows } = await pool.query<DeskTradeRow>(
    `SELECT t.id, t.trader, t.side, t.entry, t.exit, t.stop, t.qty, t.pnl, t.fees, t.risk_usd, t.r_multiple, t.result, t.horizon,
            left(t.date, 10) AS date, t.exit_date,
            COALESCE(json_agg(json_build_object('kind', e.kind, 'price', e.price, 'qty', e.qty, 'at', e.executed_at)
                       ORDER BY e.executed_at, e.sort_order, e.id) FILTER (WHERE e.id IS NOT NULL), '[]'::json) AS execs
       FROM trades t LEFT JOIN trade_executions e ON e.trade_id = t.id
      WHERE t.deleted_at IS NULL AND t.ticker = $1 AND left(t.date, 10) = $2
      GROUP BY t.id ORDER BY t.id LIMIT 300`,
    [ticker, day],
  );
  return rows;
}

export async function deskTradesForRange(ticker: string, from: string, to: string): Promise<DeskTradeRow[]> {
  const { rows } = await pool.query<DeskTradeRow>(
    `SELECT t.id, t.trader, t.side, t.entry, t.exit, t.stop, t.qty, t.pnl, t.fees, t.risk_usd, t.r_multiple, t.result, t.horizon,
            left(t.date, 10) AS date, t.exit_date, '[]'::json AS execs
       FROM trades t
      WHERE t.deleted_at IS NULL AND t.ticker = $1 AND t.horizon IN ('swing', 'overnight')
        AND left(t.date, 10) <= $3 AND COALESCE(left(t.exit_date, 10), left(t.date, 10)) >= $2
      ORDER BY t.date LIMIT 300`,
    [ticker, from, to],
  );
  return rows;
}

/** How many intraday desk trades a ticker had inside a swing window (shown when nobody swung it). */
export async function deskIntradayCount(ticker: string, from: string, to: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM trades WHERE deleted_at IS NULL AND ticker = $1 AND left(date, 10) BETWEEN $2 AND $3`,
    [ticker, from, to],
  );
  return Number(rows[0]?.n) || 0;
}

export async function longNameOf(ticker: string): Promise<string | null> {
  const { rows } = await pool.query<{ n: string | null }>(
    `SELECT long_name AS n FROM trades WHERE ticker = $1 AND long_name IS NOT NULL AND long_name <> '' ORDER BY id DESC LIMIT 1`,
    [ticker],
  );
  return rows[0]?.n ?? null;
}

/* ─────────────────────────── Progress ─────────────────────────── */

export type FinishedRow = {
  id: number; mode: SimMode; difficulty: Difficulty; ticker: string; day: string; dayTo: string | null; tf: SimTf;
  net: number; r: number; pct: number; bhPct: number; beatBh: boolean; trades: number; finishedAt: string;
  /** Own mode game; `ownDiff` = sim net − real net ($). */
  own: boolean; ownDiff: number | null;
};

export async function finishedGames(userId: number, limit = 500): Promise<FinishedRow[]> {
  const { rows } = await pool.query(
    `SELECT id, mode, difficulty, ticker, day, day_to, tf, net_pnl, r_total, pct, bh_pct, beat_bh, trades_count, finished_at,
            (params ? 'own') AS own, (result->'own'->>'diff')::numeric AS own_diff
       FROM sim_games WHERE user_id = $1 AND status = 'finished' ORDER BY finished_at DESC LIMIT $2`,
    [userId, limit],
  );
  return rows.map((r) => ({
    id: Number(r.id), mode: r.mode, difficulty: r.difficulty, ticker: r.ticker, day: r.day, dayTo: r.day_to, tf: r.tf,
    net: Number(r.net_pnl) || 0, r: Number(r.r_total) || 0, pct: Number(r.pct) || 0, bhPct: Number(r.bh_pct) || 0, beatBh: !!r.beat_bh,
    trades: Number(r.trades_count) || 0, finishedAt: new Date(r.finished_at).toISOString(),
    own: !!r.own, ownDiff: r.own_diff == null ? null : Number(r.own_diff),
  }));
}

export type BoardRow = { userId: number; name: string; games: number; r: number; wins: number; best: number; beatBh: number; me: boolean };

/** Leaderboard of [from, to) — New York calendar dates. Only players who opted in, plus the viewer. Fair games only
 *  (own-mode games are replays of a known day). */
export async function weeklyBoard(from: string, to: string, viewerId: number): Promise<{ rows: BoardRow[]; hidden: number }> {
  const { rows } = await pool.query(
    `SELECT g.user_id, u.name, count(*)::int AS games, COALESCE(sum(g.r_total), 0) AS r,
            count(*) FILTER (WHERE g.net_pnl > 0)::int AS wins, COALESCE(max(g.r_total), 0) AS best,
            count(*) FILTER (WHERE g.beat_bh)::int AS beat, COALESCE(bool_or(p.leaderboard_visible), false) AS visible
       FROM sim_games g JOIN users u ON u.id = g.user_id LEFT JOIN sim_prefs p ON p.user_id = g.user_id
      WHERE g.status = 'finished' AND NOT (g.params ? 'own')
        AND g.finished_at >= ($1::date)::timestamp AT TIME ZONE 'America/New_York'
        AND g.finished_at < ($2::date)::timestamp AT TIME ZONE 'America/New_York'
      GROUP BY g.user_id, u.name`,
    [from, to],
  );
  const shown = rows.filter((r) => r.visible || Number(r.user_id) === viewerId);
  return {
    hidden: rows.length - shown.length,
    rows: shown
      .map((r) => ({
        userId: Number(r.user_id), name: r.name, games: r.games, r: Math.round(Number(r.r) * 100) / 100, wins: r.wins,
        best: Math.round(Number(r.best) * 100) / 100, beatBh: r.beat, me: Number(r.user_id) === viewerId,
      }))
      .sort((a, b) => b.r - a.r || b.games - a.games),
  };
}

export async function getPrefs(userId: number): Promise<{ leaderboardVisible: boolean }> {
  const { rows } = await pool.query<{ v: boolean }>(`SELECT leaderboard_visible AS v FROM sim_prefs WHERE user_id = $1`, [userId]);
  return { leaderboardVisible: !!rows[0]?.v };
}

export async function setPrefs(userId: number, leaderboardVisible: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO sim_prefs (user_id, leaderboard_visible) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET leaderboard_visible = EXCLUDED.leaderboard_visible, updated_at = NOW()`,
    [userId, leaderboardVisible],
  );
}
