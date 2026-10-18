// Pure SQL builders for GET /api/trades/page (server-side pagination of the trade book).
// No DB / express imports on purpose: the module is unit-checkable offline (see routes/trades.ts for the handler).
//
// Every value goes through `Params` → `$n` placeholders; nothing from the request is interpolated into SQL text.
// Sort expressions and result buckets reuse the shared math from ./tradeMath (signedRSql / netPnlSql / resultSql…).

import { signedRSql, netPnlSql, resultSql, horizonSql } from "./tradeMath";

export const PAGE_SORT_COLS = ["date", "ticker", "side", "setup", "trader", "entry", "exit", "r", "result", "pnl", "gross", "fees", "exitEff", "mfeR", "left", "impact", "hold"] as const;
export type PageSortCol = (typeof PAGE_SORT_COLS)[number];
/** Sorts that order by $ (left falls back to $ left on the table) — not offered on a book whose $ the viewer may not see. */
export const MONEY_SORT_COLS: ReadonlySet<PageSortCol> = new Set<PageSortCol>(["pnl", "gross", "fees", "impact", "left"]);
/** Presets that select by $ ratios (fees vs pnl) — dropped on a book whose $ the viewer may not see. */
export const MONEY_PRESETS: ReadonlySet<string> = new Set(["fees"]);
export type PageDir = "asc" | "desc";
export const PAGE_OUTCOMES = ["win", "loss", "breakeven", "open"] as const;
export type PageOutcome = (typeof PAGE_OUTCOMES)[number];
export const PAGE_HORIZONS = ["intraday", "overnight", "swing"] as const;
export const PAGE_SOURCES = ["manual", "propreports"] as const;
/**
 * Review presets ("smart views") of the trades page:
 *   review  — closed trades nobody has looked at yet (no setup, no tags, no notes/review text);
 *   best    — net > 0 (client sorts by pnl desc);  worst — net < 0 (client sorts by pnl asc);
 *   scalp   — hold < SCALP_MAX_SEC (from the broker open/close wall-clock times in context_snapshot);
 *   fees    — |fees| >= FEES_SHARE * |gross| (commissions ate at least half of the move);
 *   revenge — entered < REVENGE_WINDOW_MIN after closing a losing trade the same day (same rule as behaviorEngine).
 */
export const PAGE_PRESETS = ["review", "best", "worst", "scalp", "fees", "revenge"] as const;
export type PagePreset = (typeof PAGE_PRESETS)[number];
export const SCALP_MAX_SEC = 120;
export const FEES_SHARE = 0.5;
export const REVENGE_WINDOW_MIN = 10;
export const DAYS_LIMIT_DEFAULT = 120;
export const DAYS_LIMIT_MAX = 1000;

export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX = 500;
export const PAGE_OFFSET_MAX = 100_000;
/** Max points of the cumulative-R curve shipped to the client (downsampled server-side). */
export const CURVE_MAX_POINTS = 400;

export interface TradesPageFilters {
  /** Trader scope from lib/auth scopeTrader: null = everyone (staff), otherwise one trader name (or the guest sentinel). */
  scope: string | null;
  ticker?: string;
  from?: string;
  to?: string;
  /** Matches `setup` OR `event_type` (the UI treats the event type as a fallback setup name). */
  setup?: string;
  playbookId?: number;
  horizon?: string;
  source?: "" | "manual" | "propreports";
  side?: string;
  outcome?: "" | PageOutcome;
  ids?: number[];
  sector?: string;
  session?: string;
  eventType?: string;
  /** Substring match on the tags column (case-insensitive). */
  tag?: string;
  /** Free text over ticker/date/setup/side/event/session/trader/tags/notes/review/sector/float/cap/pnl/r. */
  q?: string;
  /** Execution-quality filters (percent / R). Trades without a computed quality row never pass them. */
  exitEffMax?: number | null;
  mfeRMin?: number | null;
  leftMin?: number | null;
  /** Review preset (see PAGE_PRESETS). */
  preset?: PagePreset | "";
  /** The viewer may not see this book's $ (lib/playbookPrivacy canSeeBookMoney): `q` does not match pnl. */
  moneyBlind?: boolean;
}

export interface TradesPageSort { col: PageSortCol; dir: PageDir }

export interface PageCursor { s: PageSortCol; d: PageDir; v: string | number | null; id: number }

/** Positional parameter collector: `p.add(v)` → "$n". */
export class Params {
  readonly list: unknown[] = [];
  add(v: unknown): string {
    this.list.push(v);
    return `$${this.list.length}`;
  }
}

// ── Cursor (keyset) ───────────────────────────────────────────────────────────

function b64urlEncode(s: string): string {
  return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString("utf8");
}

export function encodeCursor(c: PageCursor): string {
  return b64urlEncode(JSON.stringify({ s: c.s, d: c.d, v: c.v, id: c.id }));
}

/** Strict decode: unknown column/direction, non-integer id or a wrong value type ⇒ null (caller answers 400). */
export function decodeCursor(raw: string | null | undefined): PageCursor | null {
  if (!raw || typeof raw !== "string" || raw.length > 400) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(b64urlDecode(raw));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (!(PAGE_SORT_COLS as readonly string[]).includes(String(o.s))) return null;
  if (o.d !== "asc" && o.d !== "desc") return null;
  if (typeof o.id !== "number" || !Number.isInteger(o.id) || o.id <= 0) return null;
  const v = o.v;
  if (v !== null && typeof v !== "string" && typeof v !== "number") return null;
  if (typeof v === "number" && !Number.isFinite(v)) return null;
  const col = o.s as PageSortCol;
  // The stored value must be of the column's type, otherwise the comparison would error at the DB.
  if (v !== null && SORT_COLS[col].type === "num" && typeof v !== "number") return null;
  if (v !== null && SORT_COLS[col].type === "text" && typeof v !== "string") return null;
  return { s: col, d: o.d, v: v as string | number | null, id: o.id };
}

// ── Column expressions ────────────────────────────────────────────────────────

const T = "t";
const Q = "q";
// Aggregates read derived columns (res / r / net / hold…) from a subquery `x`. Postgres flattens such a subquery and
// re-inlines each column expression at every reference — `res` and `r` are referenced ~20× in the summary, each a
// chain of TRANSLATE/LOWER calls — so `${inner} OFFSET 0` is used as an optimisation fence: every expression is
// computed once per row. Desk-wide (45k trades): summary 1.5–2 s → 0.3–0.6 s, days 2.4–3 s → 0.25–0.7 s, curve 0.5 → 0.2 s.

/** JSON paths into trade_quality.payload (same record the /api/trade-quality batch returns). */
const QUALITY_EXPR = {
  exitEff: `(${Q}.payload->'quality'->>'exitEfficiency')::numeric`,
  mfeR: `(${Q}.payload->'quality'->'mfe'->>'r')::numeric`,
  leftR: `(${Q}.payload->'quality'->'leftOnTable'->>'r')::numeric`,
  leftUsd: `(${Q}.payload->'quality'->'leftOnTable'->>'usd')::numeric`,
} as const;

/** Broker wall-clock timestamps (ET, "YYYY-MM-DDTHH:MM:SS") from context_snapshot; regex-guarded so a bad value is NULL, never a cast error. */
const TS_RE = `'^\\d{4}-\\d{2}-\\d{2}T[0-2]\\d:[0-5]\\d:[0-5]\\d'`;
function snapTsSql(a: string, key: "openedAt" | "closedAt"): string {
  const v = `(${a}.context_snapshot->>'${key}')`;
  return `(CASE WHEN ${v} ~ ${TS_RE} THEN LEFT(${v}, 19)::timestamp END)`;
}
export function openTsSql(a = T): string { return snapTsSql(a, "openedAt"); }
export function closeTsSql(a = T): string { return snapTsSql(a, "closedAt"); }
/** Hold in seconds (NULL without both timestamps or for negative spans). */
export function holdSecSql(a = T): string {
  return `(CASE WHEN ${closeTsSql(a)} >= ${openTsSql(a)} THEN EXTRACT(EPOCH FROM (${closeTsSql(a)} - ${openTsSql(a)})) END)`;
}
/** Nobody has reviewed the trade: no setup, no tags, no notes / review text. */
export function untaggedSql(a = T): string {
  const blank = (c: string) => `NULLIF(TRIM(COALESCE(${a}.${c}, '')), '') IS NULL`;
  return `(${["setup", "tags", "notes", "what_worked", "what_failed", "conclusion"].map(blank).join(" AND ")})`;
}

/** Sort expression per column; `type` drives cursor casting ("text" vs "num"). Nulls always sort last. */
export const SORT_COLS: Record<PageSortCol, { expr: (quality: boolean) => string; type: "text" | "num"; quality?: boolean }> = {
  date: { expr: () => `${T}.date`, type: "text" },
  ticker: { expr: () => `${T}.ticker`, type: "text" },
  side: { expr: () => `COALESCE(${T}.side, '')`, type: "text" },
  setup: { expr: () => `LOWER(COALESCE(NULLIF(${T}.setup, ''), ${T}.event_type, ''))`, type: "text" },
  trader: { expr: () => `COALESCE(${T}.trader, '')`, type: "text" },
  entry: { expr: () => `${T}.entry`, type: "num" },
  exit: { expr: () => `${T}.exit`, type: "num" },
  r: { expr: () => signedRSql(T), type: "num" },
  // Same ordering as the client (RESULT_ORDER): win 3 · breakeven 2 · open/unknown 1 · loss 0.
  result: { expr: () => `(CASE ${resultSql(T)} WHEN 'win' THEN 3 WHEN 'be' THEN 2 WHEN 'loss' THEN 0 ELSE 1 END)`, type: "num" },
  pnl: { expr: () => netPnlSql(T), type: "num" },
  gross: { expr: () => `${T}.pnl`, type: "num" },
  fees: { expr: () => `ABS(${T}.fees)`, type: "num" },
  exitEff: { expr: (q) => (q ? QUALITY_EXPR.exitEff : "NULL::numeric"), type: "num", quality: true },
  mfeR: { expr: (q) => (q ? QUALITY_EXPR.mfeR : "NULL::numeric"), type: "num", quality: true },
  left: { expr: (q) => (q ? `COALESCE(${QUALITY_EXPR.leftR}, ${QUALITY_EXPR.leftUsd})` : "NULL::numeric"), type: "num", quality: true },
  // |net| — "biggest money first" (the review queue: largest losses and outliers on top).
  impact: { expr: () => `ABS(${netPnlSql(T)})`, type: "num" },
  hold: { expr: () => `${holdSecSql(T)}::numeric`, type: "num" },
};

export function hasQualityFilters(f: TradesPageFilters): boolean {
  return f.exitEffMax != null || f.mfeRMin != null || f.leftMin != null;
}

/** Whether the query must join trade_quality (quality sort or quality filter). */
export function needsQualityJoin(f: TradesPageFilters, sort: TradesPageSort): boolean {
  return hasQualityFilters(f) || Boolean(SORT_COLS[sort.col].quality);
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

// ── WHERE ─────────────────────────────────────────────────────────────────────

export interface WhereOptions {
  /** Facet queries drop one dimension so counts are computed "as if that filter were not set". */
  skip?: "outcome" | "horizon" | "preset";
  /** trade_quality table exists in this DB (else quality filters match nothing, as on the client without a map). */
  quality: boolean;
}

/** Builds the WHERE clause (without the leading keyword). Always includes the soft-delete and scope predicates. */
export function buildWhere(f: TradesPageFilters, p: Params, opts: WhereOptions): string {
  const w: string[] = [`${T}.deleted_at IS NULL`];
  if (f.scope != null) w.push(`${T}.trader = ${p.add(f.scope)}`);
  if (f.ids && f.ids.length) w.push(`${T}.id = ANY(${p.add(f.ids)}::int[])`);
  if (f.ticker) w.push(`UPPER(${T}.ticker) = ${p.add(f.ticker.toUpperCase())}`);
  if (f.from) w.push(`${T}.date >= ${p.add(f.from)}`);
  if (f.to) w.push(`${T}.date <= ${p.add(f.to)}`);
  if (f.side) w.push(`${T}.side = ${p.add(f.side)}`);
  if (f.source === "propreports") w.push(`${T}.source = 'propreports'`);
  else if (f.source === "manual") w.push(`COALESCE(${T}.source, 'manual') <> 'propreports'`);
  if (f.setup) { const s = p.add(f.setup); w.push(`(${T}.setup = ${s} OR ${T}.event_type = ${s})`); }
  if (f.playbookId != null) w.push(`${T}.playbook_id = ${p.add(f.playbookId)}`);
  if (f.sector) w.push(`${T}.sector = ${p.add(f.sector)}`);
  if (f.session) w.push(`${T}.session = ${p.add(f.session)}`);
  if (f.eventType) w.push(`${T}.event_type = ${p.add(f.eventType)}`);
  if (f.horizon && opts.skip !== "horizon") w.push(`${horizonSql(T)} = ${p.add(f.horizon)}`);
  if (f.tag) w.push(`${T}.tags ILIKE ${p.add(`%${likeEscape(f.tag)}%`)} ESCAPE '\\'`);
  if (f.q) {
    const hay = `CONCAT_WS(' ', ${T}.ticker, ${T}.date, ${T}.setup, ${T}.side, ${T}.event_type, ${T}.session, ${T}.trader, ${T}.tags, ${T}.notes, ${T}.what_worked, ${T}.what_failed, ${T}.conclusion, ${T}.sector, ${T}.float, ${T}.market_cap, ${f.moneyBlind ? "" : `${T}.pnl::text, `}${T}.r_multiple::text)`;
    w.push(`${hay} ILIKE ${p.add(`%${likeEscape(f.q)}%`)} ESCAPE '\\'`);
  }
  if (f.outcome && opts.skip !== "outcome") {
    if (f.outcome === "open") w.push(`COALESCE(${resultSql(T)}, 'open') = 'open'`);
    else w.push(`${resultSql(T)} = ${p.add(f.outcome === "breakeven" ? "be" : f.outcome)}`);
  }
  if (f.preset && opts.skip !== "preset") w.push(presetPredicate(f.preset, f.scope, p, { from: f.from, to: f.to }));
  if (hasQualityFilters(f)) {
    if (!opts.quality) {
      w.push("FALSE"); // no quality table ⇒ nothing has a computed quality
    } else {
      // NULL comparisons are false ⇒ trades without a cached quality row are excluded (client semantics).
      if (f.exitEffMax != null) w.push(`${QUALITY_EXPR.exitEff} <= ${p.add(f.exitEffMax)}::numeric / 100`);
      if (f.mfeRMin != null) w.push(`${QUALITY_EXPR.mfeR} >= ${p.add(f.mfeRMin)}::numeric`);
      if (f.leftMin != null) w.push(`${QUALITY_EXPR.leftR} >= ${p.add(f.leftMin)}::numeric`);
    }
  }
  return w.join(" AND ");
}

/** Predicate of one review preset over alias `t` (all values parameterised). */
export function presetPredicate(preset: PagePreset, scope: string | null, p: Params, range?: { from?: string; to?: string }): string {
  const net = netPnlSql(T);
  const closed = `${resultSql(T)} IN ('win', 'loss', 'be')`;
  switch (preset) {
    case "review": return `(${closed} AND ${untaggedSql(T)})`;
    case "best": return `(${T}.pnl IS NOT NULL AND ${net} > 0)`;
    case "worst": return `(${T}.pnl IS NOT NULL AND ${net} < 0)`;
    case "scalp": return `(${holdSecSql(T)} < ${p.add(SCALP_MAX_SEC)})`;
    case "fees": return `(${T}.pnl IS NOT NULL AND COALESCE(${T}.fees, 0) <> 0 AND ABS(${T}.fees) >= ${p.add(FEES_SHARE)}::numeric * ABS(${T}.pnl))`;
    case "revenge": return `${T}.id IN (${revengeIdsSql(scope, p, range)})`;
  }
}

/**
 * Ids of «revenge» trades: entered < REVENGE_WINDOW_MIN after closing a losing trade the same day (same trader).
 * Kept unfenced on purpose: the planner runs this window in parallel workers, and buildDaysQuery evaluates it twice.
 */
export function revengeIdsSql(scope: string | null, p: Params, range?: { from?: string; to?: string }): string {
  const R = "rv0";
  // The window partitions by (trader, date), so cutting the same date range as the outer query changes no answer
  // inside it — it only skips the days the caller filtered out.
  let scopeSql = scope != null ? ` AND ${R}.trader = ${p.add(scope)}` : "";
  if (range?.from) scopeSql += ` AND ${R}.date >= ${p.add(range.from)}`;
  if (range?.to) scopeSql += ` AND ${R}.date <= ${p.add(range.to)}`;
  const o = openTsSql(R);
  return `SELECT rv.id FROM (
          SELECT ${R}.id, ${o} AS o, LAG(${closeTsSql(R)}) OVER w AS pc, LAG(${netPnlSql(R)}) OVER w AS pn
          FROM trades ${R} WHERE ${R}.deleted_at IS NULL${scopeSql}
          WINDOW w AS (PARTITION BY ${R}.trader, ${R}.date ORDER BY ${o} NULLS LAST, ${R}.id)
        ) rv WHERE rv.pn < 0 AND rv.o >= rv.pc AND rv.o < rv.pc + make_interval(mins => ${p.add(REVENGE_WINDOW_MIN)}::int)`;
}

/** FROM clause (table alias `t`, optional quality join `q`). */
export function buildFrom(joinQuality: boolean): string {
  return joinQuality ? `FROM trades ${T} LEFT JOIN trade_quality ${Q} ON ${Q}.trade_id = ${T}.id` : `FROM trades ${T}`;
}

// ── Page query (ids + sort value, keyset or offset) ───────────────────────────

export interface PageQueryInput {
  filters: TradesPageFilters;
  sort: TradesPageSort;
  limit: number;
  offset?: number;
  cursor?: PageCursor | null;
  quality: boolean;
}

/**
 * Keyset predicate for "rows after the cursor" under ORDER BY expr <dir> NULLS LAST, id DESC:
 *   v ≠ null: expr <op> v  OR (expr = v AND id < id)  OR expr IS NULL
 *   v = null: expr IS NULL AND id < id
 */
export function cursorPredicate(expr: string, type: "text" | "num", c: PageCursor, p: Params): string {
  const idP = p.add(c.id);
  if (c.v === null) return `(${expr} IS NULL AND ${T}.id < ${idP})`;
  const cast = type === "num" ? "::numeric" : "::text";
  const vP = `${p.add(c.v)}${cast}`;
  const op = c.d === "desc" ? "<" : ">";
  return `((${expr} ${op} ${vP}) OR (${expr} = ${vP} AND ${T}.id < ${idP}) OR (${expr} IS NULL))`;
}

/** SELECT id + sort value for one page (limit + 1 rows so the caller can tell `hasMore`). */
export function buildPageQuery(input: PageQueryInput): { sql: string; params: unknown[] } {
  const p = new Params();
  const join = input.quality && needsQualityJoin(input.filters, input.sort);
  const col = SORT_COLS[input.sort.col];
  const expr = col.expr(join);
  const where: string[] = [buildWhere(input.filters, p, { quality: input.quality })];
  if (input.cursor) where.push(cursorPredicate(expr, col.type, input.cursor, p));
  const order = `${expr} ${input.sort.dir === "asc" ? "ASC" : "DESC"} NULLS LAST, ${T}.id DESC`;
  const limitP = p.add(input.limit + 1);
  const offsetSql = !input.cursor && input.offset ? ` OFFSET ${p.add(input.offset)}` : "";
  const sql = `SELECT ${T}.id, ${expr} AS sv ${buildFrom(join)} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ${limitP}${offsetSql}`;
  return { sql, params: p.list };
}

/** Normalise the raw sort value from pg (numeric → number, else string) so it round-trips through the cursor. */
export function sortValueOf(raw: unknown, col: PageSortCol): string | number | null {
  if (raw == null) return null;
  if (SORT_COLS[col].type === "num") {
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return String(raw);
}

// ── Summary over the WHOLE filtered set ───────────────────────────────────────

export function buildSummaryQuery(f: TradesPageFilters, quality: boolean): { sql: string; params: unknown[] } {
  const p = new Params();
  const join = quality && hasQualityFilters(f);
  const inner = `SELECT ${T}.pnl, ${T}.fees, ${T}.source, ${T}.date, ${resultSql(T)} AS res, ${signedRSql(T)} AS r, ${netPnlSql(T)} AS net,
      ${untaggedSql(T)} AS untagged, ${holdSecSql(T)} AS hold
    ${buildFrom(join)} WHERE ${buildWhere(f, p, { quality })}`;
  const sql = `SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE res = 'win')::int AS wins,
      COUNT(*) FILTER (WHERE res = 'loss')::int AS losses,
      COUNT(*) FILTER (WHERE res = 'be')::int AS be,
      COUNT(*) FILTER (WHERE res IS NULL OR res = 'open')::int AS open,
      COUNT(pnl)::int AS pnl_count,
      SUM(pnl) FILTER (WHERE pnl IS NOT NULL) AS gross,
      SUM(ABS(COALESCE(fees, 0))) FILTER (WHERE pnl IS NOT NULL) AS fees,
      SUM(net) AS net,
      COUNT(r)::int AS r_count,
      SUM(r) AS sum_r,
      SUM(r) FILTER (WHERE r > 0) AS pos_r,
      SUM(-r) FILTER (WHERE r < 0) AS neg_r,
      SUM(r) FILTER (WHERE res = 'win') AS win_r_sum,
      COUNT(r) FILTER (WHERE res = 'win')::int AS win_r_n,
      SUM(r) FILTER (WHERE res = 'loss') AS loss_r_sum,
      COUNT(r) FILTER (WHERE res = 'loss')::int AS loss_r_n,
      MIN(date) AS first_date,
      MAX(date) AS last_date,
      COUNT(*) FILTER (WHERE source = 'propreports' OR (fees IS NOT NULL AND fees <> 0))::int AS fee_rows,
      SUM(net) FILTER (WHERE res = 'win') AS win_net_sum,
      COUNT(net) FILTER (WHERE res = 'win')::int AS win_net_n,
      SUM(net) FILTER (WHERE res = 'loss') AS loss_net_sum,
      COUNT(net) FILTER (WHERE res = 'loss')::int AS loss_net_n,
      SUM(net) FILTER (WHERE net > 0) AS pos_net,
      SUM(-net) FILTER (WHERE net < 0) AS neg_net,
      MAX(net) AS max_net,
      MIN(net) AS min_net,
      COUNT(*) FILTER (WHERE untagged AND res IN ('win', 'loss', 'be'))::int AS untagged,
      AVG(hold) AS avg_hold_sec,
      COUNT(DISTINCT date)::int AS days
    FROM (${inner} OFFSET 0) x`;
  return { sql, params: p.list };
}

/** Size and date span of the filtered set only — the «lite» answer (`?lite=1`) for callers that need a counter. */
export function buildCountQuery(f: TradesPageFilters, quality: boolean): { sql: string; params: unknown[] } {
  const p = new Params();
  const join = quality && hasQualityFilters(f);
  const sql = `SELECT COUNT(*)::int AS total, MIN(${T}.date) AS first_date, MAX(${T}.date) AS last_date
    ${buildFrom(join)} WHERE ${buildWhere(f, p, { quality })}`;
  return { sql, params: p.list };
}

/** Cumulative R over closed trades in chronological order, downsampled to ≤ CURVE_MAX_POINTS (last point always kept). */
export function buildCurveQuery(f: TradesPageFilters, quality: boolean): { sql: string; params: unknown[] } {
  const p = new Params();
  const join = quality && hasQualityFilters(f);
  const inner = `SELECT ${T}.id, ${T}.ticker, ${T}.date, ${T}.created_at, ${resultSql(T)} AS res, ${signedRSql(T)} AS r
    ${buildFrom(join)} WHERE ${buildWhere(f, p, { quality })}`;
  const maxP = p.add(CURVE_MAX_POINTS);
  const sql = `SELECT i, cum, label FROM (
      SELECT ROW_NUMBER() OVER w AS i, SUM(r) OVER w AS cum, ticker || ' · ' || date AS label, COUNT(*) OVER () AS n
      FROM (${inner} OFFSET 0) x
      WHERE r IS NOT NULL AND (res IS NULL OR res <> 'open')
      WINDOW w AS (ORDER BY date, created_at, id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
    ) c
    WHERE i = n OR MOD(i, GREATEST(1, CEIL(n::numeric / ${maxP}::numeric)::int)) = 0
    ORDER BY i`;
  return { sql, params: p.list };
}

/** Latest decided results (win/loss) newest first — the client folds them into the current streak. */
export function buildStreakQuery(f: TradesPageFilters, quality: boolean, limit = 200): { sql: string; params: unknown[] } {
  const p = new Params();
  const join = quality && hasQualityFilters(f);
  const sql = `SELECT ${resultSql(T)} AS res ${buildFrom(join)} WHERE ${buildWhere(f, p, { quality })} AND ${resultSql(T)} IN ('win', 'loss')
    ORDER BY ${T}.date DESC, ${T}.created_at DESC, ${T}.id DESC LIMIT ${p.add(limit)}`;
  return { sql, params: p.list };
}

/** Outcome counts with the outcome filter removed (segment counts in the filter bar). */
export function buildOutcomeFacetQuery(f: TradesPageFilters, quality: boolean): { sql: string; params: unknown[] } {
  const p = new Params();
  const join = quality && hasQualityFilters(f);
  const sql = `SELECT COALESCE(${resultSql(T)}, 'open') AS k, COUNT(*)::int AS n ${buildFrom(join)} WHERE ${buildWhere(f, p, { quality, skip: "outcome" })} GROUP BY 1`;
  return { sql, params: p.list };
}

/** Horizon counts with the horizon filter removed (chips in the filter bar). */
export function buildHorizonFacetQuery(f: TradesPageFilters, quality: boolean): { sql: string; params: unknown[] } {
  const p = new Params();
  const join = quality && hasQualityFilters(f);
  const sql = `SELECT ${horizonSql(T)} AS k, COUNT(*)::int AS n ${buildFrom(join)} WHERE ${buildWhere(f, p, { quality, skip: "horizon" })} GROUP BY 1`;
  return { sql, params: p.list };
}

/** Counts per review preset with the preset filter removed (badges on the preset bar). */
export function buildPresetFacetQuery(f: TradesPageFilters, quality: boolean): { sql: string; params: unknown[] } {
  const p = new Params();
  const join = quality && hasQualityFilters(f);
  const where = buildWhere(f, p, { quality, skip: "preset" });
  // Same predicates as presetPredicate(), but over columns computed once per row in a fenced subquery: the inlined
  // version evaluated the broker-timestamp regexes 4× per row for «scalp» and re-ran resultSql/netPnlSql per preset
  // (desk-wide 45k trades ~0.8 s → ~0.55 s; with a date range the revenge window is cut to that range: 0.9 s → 0.12 s).
  const scalp = p.add(SCALP_MAX_SEC);
  const share = p.add(FEES_SHARE);
  const revenge = revengeIdsSql(f.scope, p, { from: f.from, to: f.to });
  const sql = `SELECT
      COUNT(*) FILTER (WHERE res IN ('win', 'loss', 'be') AND untagged)::int AS "review",
      COUNT(*) FILTER (WHERE pnl IS NOT NULL AND net > 0)::int AS "best",
      COUNT(*) FILTER (WHERE pnl IS NOT NULL AND net < 0)::int AS "worst",
      COUNT(*) FILTER (WHERE c >= o AND EXTRACT(EPOCH FROM (c - o)) < ${scalp})::int AS "scalp",
      COUNT(*) FILTER (WHERE pnl IS NOT NULL AND COALESCE(fees, 0) <> 0 AND ABS(fees) >= ${share}::numeric * ABS(pnl))::int AS "fees",
      COUNT(*) FILTER (WHERE id IN (${revenge}))::int AS "revenge"
    FROM (SELECT ${T}.id, ${T}.pnl, ${T}.fees, ${resultSql(T)} AS res, ${netPnlSql(T)} AS net, ${untaggedSql(T)} AS untagged,
            ${openTsSql(T)} AS o, ${closeTsSql(T)} AS c
          ${buildFrom(join)} WHERE ${where} OFFSET 0) x`;
  return { sql, params: p.list };
}

/**
 * Per trading day aggregates over the filtered set (the day-grouped review list), newest first.
 * `seq` = net of each trade in intraday order (open time) — the client folds it into the intraday curve.
 * `before` pages backwards (date < before). `days_total` = number of days in the whole filtered set.
 */
export function buildDaysQuery(f: TradesPageFilters, quality: boolean, opts: { limit: number; before?: string }): { sql: string; params: unknown[] } {
  const p = new Params();
  const join = quality && hasQualityFilters(f);
  // Pick the page's days first (cheap: one column), then aggregate only their trades. Aggregating every day of the
  // book and cutting with LIMIT afterwards cost ~0.7–2 s on a 45k-trade desk for a 30-day page.
  // The filter runs once (`filtered`, materialized ids): with a costly predicate (preset «revenge» = a window over the
  // whole scope) evaluating WHERE a second time for the page's trades doubled the time.
  const where = buildWhere(f, p, { quality });
  const beforeSql = opts.before ? ` AND d < ${p.add(opts.before)}` : "";
  const limitP = p.add(opts.limit + 1);
  const inner = `SELECT ${T}.id, ${T}.date, ${T}.created_at, ${T}.pnl, ${T}.fees, ${resultSql(T)} AS res, ${netPnlSql(T)} AS net, ${signedRSql(T)} AS r,
      ${untaggedSql(T)} AS untagged, ${openTsSql(T)} AS o, ${closeTsSql(T)} AS c
    FROM trades ${T} WHERE ${T}.id IN (SELECT id FROM filtered WHERE d IN (SELECT d FROM page_days))`;
  const sql = `WITH filtered AS MATERIALIZED (
      SELECT ${T}.id, ${T}.date AS d ${buildFrom(join)} WHERE ${where}
    ), filtered_days AS (
      SELECT DISTINCT d FROM filtered
    ), page_days AS (
      SELECT d FROM filtered_days WHERE TRUE${beforeSql} ORDER BY d DESC LIMIT ${limitP}
    )
    SELECT g.*, (SELECT COUNT(*) FROM filtered_days) AS days_total FROM (
      SELECT x.date AS d,
        COUNT(*)::int AS n,
        COUNT(*) FILTER (WHERE res = 'win')::int AS wins,
        COUNT(*) FILTER (WHERE res = 'loss')::int AS losses,
        COUNT(*) FILTER (WHERE res = 'be')::int AS be,
        COUNT(*) FILTER (WHERE res IS NULL OR res = 'open')::int AS open,
        COUNT(pnl)::int AS pnl_count,
        SUM(pnl) AS gross,
        SUM(ABS(COALESCE(fees, 0))) FILTER (WHERE pnl IS NOT NULL) AS fees,
        SUM(net) AS net,
        MAX(net) AS max_net,
        MIN(net) AS min_net,
        COUNT(r)::int AS r_count,
        SUM(r) AS sum_r,
        COUNT(*) FILTER (WHERE untagged AND res IN ('win', 'loss', 'be'))::int AS untagged,
        TO_CHAR(MIN(o), 'HH24:MI') AS first_at,
        TO_CHAR(MAX(c), 'HH24:MI') AS last_at,
        ARRAY_AGG(ROUND(net::numeric, 2) ORDER BY o NULLS LAST, created_at, id) FILTER (WHERE net IS NOT NULL) AS seq
      FROM (${inner} OFFSET 0) x
      GROUP BY x.date
    ) g
    ORDER BY g.d DESC`;
  return { sql, params: p.list };
}

/** Option lists over the caller's whole scope (not the current filter): setups with counts, traders, sectors. */
export function buildOptionsQuery(scope: string | null): { sql: string; params: unknown[] } {
  const p = new Params();
  const base = scope != null ? `${T}.deleted_at IS NULL AND ${T}.trader = ${p.add(scope)}` : `${T}.deleted_at IS NULL`;
  const sql = `SELECT 'setup' AS kind, name, n FROM (
      SELECT COALESCE(NULLIF(${T}.setup, ''), ${T}.event_type) AS name, COUNT(*)::int AS n FROM trades ${T} WHERE ${base} GROUP BY 1
    ) s WHERE name IS NOT NULL AND name <> ''
    UNION ALL
    SELECT 'trader', ${T}.trader, COUNT(*)::int FROM trades ${T} WHERE ${base} AND ${T}.trader IS NOT NULL AND ${T}.trader <> '' GROUP BY 2
    UNION ALL
    SELECT 'sector', ${T}.sector, COUNT(*)::int FROM trades ${T} WHERE ${base} AND ${T}.sector IS NOT NULL AND ${T}.sector <> '' GROUP BY 2
    ORDER BY 1, 3 DESC, 2`;
  return { sql, params: p.list };
}

// ── Indexes for the hot paths (idempotent) ────────────────────────────────────

export const TRADES_PAGE_INDEX_SQL = [
  // Default sort + keyset (date DESC, id DESC) over live rows.
  `CREATE INDEX IF NOT EXISTS trades_live_date_id_idx ON trades (date DESC, id DESC) WHERE deleted_at IS NULL`,
  // Trader scope (every non-staff request) with the same order.
  `CREATE INDEX IF NOT EXISTS trades_live_trader_date_id_idx ON trades (trader, date DESC, id DESC) WHERE deleted_at IS NULL`,
  // Ticker deep links / history in the detail sheet.
  `CREATE INDEX IF NOT EXISTS trades_live_ticker_date_idx ON trades (ticker, date DESC) WHERE deleted_at IS NULL`,
  // Source filter (PropReports vs manual) is low-cardinality but partial on live rows keeps it tiny.
  `CREATE INDEX IF NOT EXISTS trades_live_source_idx ON trades (source) WHERE deleted_at IS NULL`,
];

// ── Streak fold (JS) ──────────────────────────────────────────────────────────

/** Current streak from decided results ordered newest first (same rule as the client computeStats). */
export function foldStreak(resultsNewestFirst: Array<"win" | "loss" | string | null>): { kind: "win" | "loss" | null; len: number } {
  let kind: "win" | "loss" | null = null;
  let len = 0;
  for (const r of resultsNewestFirst) {
    if (r !== "win" && r !== "loss") continue;
    if (kind == null) { kind = r; len = 1; }
    else if (kind === r) len++;
    else break;
  }
  return { kind, len };
}
