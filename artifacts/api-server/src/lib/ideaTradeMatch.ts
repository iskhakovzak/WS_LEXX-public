/**
 * Idea → trade auto-link. Trades come only from PropReports (no manual trades), so a published idea is linked to
 * the author's own broker trade automatically: same ticker + side, entry inside the idea's active window
 * (publish moment → end of its valid_until NY session), the trade entered nearest to the publish moment wins.
 * One trade per idea and one idea per trade. Idempotent: every run recomputes the desired links of the ideas in
 * scope and only writes the difference.
 *
 * Link ownership (`trade_ideas.trade_link_source`):
 *   'auto'   — set here; moved / cleared by later runs (e.g. the trade was deleted or re-matched).
 *   'manual' — staff linked a trade by hand (legacy convert / «fromIdea»); never touched here. NULL with a
 *              converted_trade_id (rows from before this column) counts as manual too.
 *   'off'    — staff removed a link by hand: auto-matching stays off for this idea.
 * Auto-linked ideas get status 'converted' (like the manual flow) and go back to 'published' when unlinked.
 */
import { pool } from "@workspace/db";
import { logger } from "./logger";
import { addDays, isWeekend, nyDate } from "./tradingDate";

const NY = "America/New_York";

/** Next trading day (weekends skipped; holidays are not consulted). */
function nextSession(date: string, n = 1): string {
  let d = date;
  for (let i = 0; i < n; i++) { do { d = addDays(d, 1); } while (isWeekend(d)); }
  return d;
}

/** Default expiry of a published idea by horizon, counted from the publish (NY) date. */
export function defaultValidUntil(horizon: string | null, from: string = nyDate()): string {
  if (horizon === "overnight") return nextSession(from, 1);
  if (horizon === "swing") return nextSession(from, 10);
  return from;
}

export type IdeaForMatch = {
  id: number; trader: string; ticker: string; side: string;
  publishedAt: Date | string | null; createdAt: Date | string | null; ideaDate: string | null;
  validUntil: string | null; horizon: string | null;
};
export type IdeaWindow = { id: number; trader: string; ticker: string; side: "long" | "short"; startAt: string; startDay: string; endDay: string };

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Active window of an idea, or null when it cannot be matched (no side / no start). */
export function ideaWindow(i: IdeaForMatch): IdeaWindow | null {
  const side = String(i.side ?? "").trim().toLowerCase();
  if (side !== "long" && side !== "short") return null;
  const ticker = String(i.ticker ?? "").trim().toUpperCase();
  if (!ticker || !i.trader) return null;
  const startRaw = i.publishedAt ?? i.createdAt;
  const startMs = startRaw ? new Date(startRaw).getTime() : NaN;
  if (!Number.isFinite(startMs)) return null;
  const start = new Date(startMs);
  const startDay = nyDate(start);
  const valid = i.validUntil && YMD.test(i.validUntil) ? i.validUntil : defaultValidUntil(i.horizon, startDay);
  const endDay = valid < startDay ? startDay : valid;
  return { id: i.id, trader: i.trader, ticker, side, startAt: start.toISOString(), startDay, endDay };
}

export type MatchCandidate = { ideaId: number; tradeId: number; distanceMs: number };

/** Greedy nearest-first assignment: each idea gets at most one trade and each trade serves at most one idea. */
export function assignIdeaTrades(cands: MatchCandidate[]): Map<number, number> {
  const sorted = [...cands].sort((a, b) => a.distanceMs - b.distanceMs || a.ideaId - b.ideaId || a.tradeId - b.tradeId);
  const out = new Map<number, number>();
  const usedTrades = new Set<number>();
  for (const c of sorted) {
    if (out.has(c.ideaId) || usedTrades.has(c.tradeId)) continue;
    out.set(c.ideaId, c.tradeId);
    usedTrades.add(c.tradeId);
  }
  return out;
}

// ─── DB ─────────────────────────────────────────────────────────────────────

let ensured: Promise<void> | null = null;
export function ensureIdeaLinkColumns(): Promise<void> {
  if (!ensured) {
    ensured = pool
      .query(
        `ALTER TABLE trade_ideas ADD COLUMN IF NOT EXISTS trade_link_source TEXT;
         ALTER TABLE trade_ideas ADD COLUMN IF NOT EXISTS trade_linked_at TIMESTAMPTZ;`,
      )
      .then(() => undefined)
      .catch((err) => { ensured = null; throw err; });
  }
  return ensured;
}

/** Candidate (idea, trade) pairs from the author's PropReports trades inside each idea's window. */
async function loadCandidates(windows: IdeaWindow[], excludeTrades: number[]): Promise<MatchCandidate[]> {
  if (!windows.length) return [];
  const { rows } = await pool.query<{ idea_id: number; trade_id: number; distance_ms: number }>(
    `WITH i AS (
       SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::timestamptz[], $6::text[], $7::text[])
         AS i(id, trader, ticker, side, start_at, start_day, end_day)
     )
     SELECT i.id AS idea_id, t.id AS trade_id,
            (EXTRACT(EPOCH FROM (COALESCE(x.entry_at, i.start_at) - i.start_at)) * 1000)::float8 AS distance_ms
       FROM i
       JOIN trades t ON t.trader = i.trader AND UPPER(t.ticker) = i.ticker AND LOWER(COALESCE(t.side, '')) = i.side
                    AND t.deleted_at IS NULL
                    AND (t.source = 'propreports' OR t.context_snapshot ->> 'source' = 'propreports')
                    AND substring(t.date, 1, 10) BETWEEN i.start_day AND i.end_day
                    AND NOT (t.id = ANY($8::int[]))
       CROSS JOIN LATERAL (
         SELECT COALESCE(
           (SELECT MIN(e.executed_at) FROM trade_executions e
             WHERE e.trade_id = t.id AND e.executed_at IS NOT NULL AND e.kind IN ('entry', 'add')),
           CASE
             WHEN (t.context_snapshot ->> 'openedAt') ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2})?$'
               THEN (t.context_snapshot ->> 'openedAt')::timestamp AT TIME ZONE '${NY}'
             WHEN (t.context_snapshot ->> 'openedAt') ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}.*(Z|[+-]\\d{2}:?\\d{2})$'
               THEN (t.context_snapshot ->> 'openedAt')::timestamptz
           END
         ) AS entry_at
       ) x
      WHERE x.entry_at IS NULL  -- date-only trade: the day filter above is the window
         OR (x.entry_at >= i.start_at AND to_char(x.entry_at AT TIME ZONE '${NY}', 'YYYY-MM-DD') <= i.end_day)`,
    [
      windows.map((w) => w.id), windows.map((w) => w.trader), windows.map((w) => w.ticker), windows.map((w) => w.side),
      windows.map((w) => w.startAt), windows.map((w) => w.startDay), windows.map((w) => w.endDay), excludeTrades,
    ],
  );
  return rows.map((r) => ({ ideaId: Number(r.idea_id), tradeId: Number(r.trade_id), distanceMs: Number(r.distance_ms) }));
}

export type MatchSummary = { ideas: number; linked: number; unlinked: number; moved: number };
type IdeaLinkRow = {
  id: number; trader: string; ticker: string; side: string | null; status: string; published_at: Date | null; created_at: Date | null;
  idea_date: string | null; valid_until: string | null; horizon: string | null; converted_trade_id: number | null; trade_link_source: string | null;
};

/** Read-only plan: the auto-managed ideas in scope and the trade each one should link to. */
export async function planIdeaLinks(traders: string[] | null = null): Promise<{ ideas: IdeaLinkRow[]; desired: Map<number, number> }> {
  await ensureIdeaLinkColumns();
  const { rows } = await pool.query<IdeaLinkRow>(
    `SELECT id, trader, ticker, side, status, published_at, created_at, idea_date, valid_until, horizon, converted_trade_id, trade_link_source
       FROM trade_ideas
      WHERE deleted_at IS NULL AND trader IS NOT NULL AND status IN ('published', 'converted')
        AND ($1::text[] IS NULL OR trader = ANY($1::text[]))`,
    [traders],
  );
  const isManual = (r: IdeaLinkRow) =>
    r.trade_link_source === "manual" || r.trade_link_source === "off" || (r.converted_trade_id != null && r.trade_link_source !== "auto");
  const auto = rows.filter((r) => !isManual(r));
  // Trades already linked by hand (any author in scope) are not offered to other ideas.
  const { rows: manualRows } = await pool.query<{ t: number }>(
    `SELECT converted_trade_id AS t FROM trade_ideas
      WHERE converted_trade_id IS NOT NULL AND deleted_at IS NULL AND COALESCE(trade_link_source, 'manual') <> 'auto'`,
  );
  const windows = auto.map((r) => ideaWindow({
    id: r.id, trader: r.trader, ticker: r.ticker, side: r.side ?? "", publishedAt: r.published_at, createdAt: r.created_at,
    ideaDate: r.idea_date, validUntil: r.valid_until, horizon: r.horizon,
  })).filter((w): w is IdeaWindow => !!w);
  const desired = assignIdeaTrades(await loadCandidates(windows, manualRows.map((r) => Number(r.t))));
  return { ideas: auto, desired };
}

/**
 * Recomputes auto links for the ideas of `traders` (null = every author). Safe to call often; writes only changes.
 */
export async function matchIdeaTrades(traders: string[] | null = null): Promise<MatchSummary> {
  const { ideas: auto, desired } = await planIdeaLinks(traders);
  const out: MatchSummary = { ideas: auto.length, linked: 0, unlinked: 0, moved: 0 };
  for (const r of auto) {
    const want = desired.get(r.id) ?? null;
    const have = r.trade_link_source === "auto" ? r.converted_trade_id : null;
    if (want === have) continue;
    if (want != null) {
      const upd = await pool.query(
        `UPDATE trade_ideas SET converted_trade_id = $2, trade_link_source = 'auto', trade_linked_at = NOW(), status = 'converted'
          WHERE id = $1 AND (converted_trade_id IS NULL OR trade_link_source = 'auto') AND COALESCE(trade_link_source, '') <> 'off'`,
        [r.id, want],
      );
      if (upd.rowCount) { if (have == null) out.linked++; else out.moved++; }
    } else {
      const upd = await pool.query(
        `UPDATE trade_ideas SET converted_trade_id = NULL, trade_link_source = NULL, trade_linked_at = NULL,
                status = CASE WHEN status = 'converted' THEN 'published' ELSE status END
          WHERE id = $1 AND trade_link_source = 'auto'`,
        [r.id],
      );
      if (upd.rowCount) out.unlinked++;
    }
  }
  return out;
}

// ─── read-side freshness ────────────────────────────────────────────────────

const FRESH_MS = 5 * 60_000;
let lastFullRun = 0;
let inflight: Promise<unknown> | null = null;

/** Before serving ideas: full recompute at most every 5 minutes (shared in-flight run); never throws. */
export async function ensureIdeaLinksFresh(): Promise<void> {
  if (Date.now() - lastFullRun < FRESH_MS) return;
  if (!inflight) {
    inflight = matchIdeaTrades(null)
      .then(() => { lastFullRun = Date.now(); })
      .catch((err) => logger.warn({ err }, "ideas: auto-link failed"))
      .finally(() => { inflight = null; });
  }
  await inflight;
}

/** New broker trades for these traders (PropReports sync): relink their ideas now. */
export async function relinkIdeasForTraders(traders: string[]): Promise<void> {
  if (!traders.length) return;
  try {
    await matchIdeaTrades(traders);
  } catch (err) {
    logger.warn({ err }, "ideas: auto-link after sync failed");
  }
}
