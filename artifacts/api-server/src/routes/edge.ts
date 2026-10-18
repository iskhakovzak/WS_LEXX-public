/**
 * Edge finder: SQL aggregates for the analytics "edge matrix" and cost drag.
 *
 *   GET /edge/matrix  ?rows=setup&cols=horizon&trader=&from=&to=&horizon=&side=&account=&source=&setup=&ticker=&tod=15|30
 *                     → cells per (row, col) with counts, ΣR, Σnet and capped per-trade value arrays (client bootstrap CI)
 *   GET /edge/costs   ?group=trader|account|month|setup|horizon&…same filters
 *                     → gross vs net, fees per share / per trade, share of gross profit eaten, slippage
 *
 * Dimensions (rows/cols): setup, horizon, tod (15/30-min ET buckets from the first entry execution, else the time in
 * `date`, else session), hold (minutes between first entry and last exit execution, else hold_time text), catalyst
 * (event_type), cap, float (market_cap / float text parsed in SQL), gap (context_snapshot.gapPct or tags), weekday,
 * grade, conviction, plan (journal_days.followed_plan, probed with to_regclass), side, trader, account, source, month, ticker.
 *
 * Money is NET (pnl − |fees|, lib/tradeMath); R is the shared signedRSql. Period = close date (exit_date, else date).
 * Members are scoped to their own trades (lib/auth scopeTrader); guests see nothing. GET only, no tables created.
 */
import { Router, type IRouter, type Request } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { scopeTrader } from "../lib/auth";
import { signedRSql, netPnlSql, closeDateSql, horizonSql, decidedSql, closedSql, resultSql, num } from "../lib/tradeMath";
import { execSpanJoin } from "../lib/execSpan";
import { badRequest, unauthorized } from "../lib/http";

const router: IRouter = Router();

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Per-cell cap on the raw value arrays shipped to the client (bootstrap CI). */
const VALUES_CAP = 400;
const NY = "America/New_York";

export const EDGE_DIMENSIONS = [
  "setup", "horizon", "tod", "hold", "catalyst", "cap", "float", "gap", "weekday", "grade", "conviction", "plan",
  "side", "trader", "account", "source", "month", "ticker",
] as const;
export type EdgeDimension = (typeof EDGE_DIMENSIONS)[number];

const filterSchema = z.object({
  trader: z.string().trim().max(120).optional(),
  from: z.string().regex(YMD_RE).optional(),
  to: z.string().regex(YMD_RE).optional(),
  horizon: z.enum(["intraday", "overnight", "swing"]).optional(),
  side: z.string().trim().max(20).optional(),
  account: z.string().trim().max(120).optional(),
  source: z.enum(["manual", "propreports"]).optional(),
  setup: z.string().trim().max(200).optional(),
  ticker: z.string().trim().max(20).optional(),
  tod: z.coerce.number().int().refine((v) => v === 15 || v === 30, "tod must be 15 or 30").optional(),
});
type Filters = z.infer<typeof filterSchema>;

const matrixSchema = filterSchema.extend({
  rows: z.enum(EDGE_DIMENSIONS).default("setup"),
  cols: z.enum(EDGE_DIMENSIONS).default("horizon"),
});
const costsSchema = filterSchema.extend({
  group: z.enum(["trader", "account", "month", "setup", "horizon"]).default("trader"),
});

function normQuery(q: Request["query"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) {
    const s = Array.isArray(v) ? v[0] : v;
    if (typeof s === "string" && s.trim() !== "") out[k] = s;
  }
  return out;
}

/* ─── SQL fragments ───────────────────────────────────────────────────────── */


/** Minutes since NY midnight of the entry: execution → time inside `date` → NULL. */
const ENTRY_MIN_SQL = `(CASE
  WHEN e.first_entry IS NOT NULL THEN EXTRACT(HOUR FROM (e.first_entry AT TIME ZONE '${NY}'))::int * 60 + EXTRACT(MINUTE FROM (e.first_entry AT TIME ZONE '${NY}'))::int
  WHEN t.date ~ '^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}' THEN substring(t.date from 12 for 2)::int * 60 + substring(t.date from 15 for 2)::int
  ELSE NULL END)`;

/** Hold minutes: executions span → hold_time text ("1:30", "45 мин", "2h", "3 д"). */
// i18n-ignore-next (parses RU / EN hold-time units)
const HOLD_MIN_SQL = `(CASE
  WHEN e.first_entry IS NOT NULL AND e.last_exit IS NOT NULL AND e.last_exit > e.first_entry
    THEN EXTRACT(EPOCH FROM (e.last_exit - e.first_entry)) / 60
  WHEN t.hold_time ~ '^\\s*\\d{1,2}:\\d{2}\\s*$' THEN split_part(trim(t.hold_time), ':', 1)::numeric * 60 + split_part(trim(t.hold_time), ':', 2)::numeric
  WHEN t.hold_time ~ '\\d' THEN
    (substring(replace(t.hold_time, ',', '.') from '(\\d+(?:\\.\\d+)?)'))::numeric *
    (CASE WHEN t.hold_time ~* '\\d\\s*(d|д)' THEN 1440 WHEN t.hold_time ~* '\\d\\s*(h|ч)' THEN 60 ELSE 1 END)
  ELSE NULL END)`;

/** "652 M", "45,43B", "632m", "28.5" (bare < 10 000 ⇒ millions) → dollars, NULL when unparsable. */
function moneySql(col: string): string {
  const s = `lower(regexp_replace(replace(${col}, ',', '.'), '[\\s$]', '', 'g'))`;
  return `(CASE WHEN ${s} ~ '^[0-9]+(\\.[0-9]+)?[kmbt]?$' THEN
    (substring(${s} from '^([0-9]+(?:\\.[0-9]+)?)'))::numeric *
    (CASE right(${s}, 1) WHEN 'k' THEN 1e3 WHEN 'm' THEN 1e6 WHEN 'b' THEN 1e9 WHEN 't' THEN 1e12
          ELSE (CASE WHEN (substring(${s} from '^([0-9]+(?:\\.[0-9]+)?)'))::numeric < 1e4 THEN 1e6 ELSE 1 END) END)
  ELSE NULL END)`;
}

// i18n-ignore-next (stable bucket key: data, not display — the client maps it to a label in edge-api.ts)
const CAP_SQL = `(CASE
  WHEN ${moneySql("t.market_cap")} IS NULL THEN 'Нет капитализации'
  WHEN ${moneySql("t.market_cap")} < 50e6 THEN 'Нано < $50M'
  WHEN ${moneySql("t.market_cap")} < 300e6 THEN 'Микро $50–300M'
  WHEN ${moneySql("t.market_cap")} < 2e9 THEN 'Малая $300M–2B'
  WHEN ${moneySql("t.market_cap")} < 10e9 THEN 'Средняя $2–10B'
  ELSE 'Крупная > $10B' END)`;

// i18n-ignore-next (stable bucket key: data, not display — the client maps it to a label in edge-api.ts)
const FLOAT_SQL = `(CASE
  WHEN ${moneySql("t.float")} IS NULL THEN 'Нет флоата'
  WHEN ${moneySql("t.float")} < 10e6 THEN 'Флоат < 10M'
  WHEN ${moneySql("t.float")} < 50e6 THEN 'Флоат 10–50M'
  WHEN ${moneySql("t.float")} < 200e6 THEN 'Флоат 50–200M'
  ELSE 'Флоат > 200M' END)`;

const GAP_PCT_SQL = `(CASE WHEN (t.context_snapshot->>'gapPct') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (t.context_snapshot->>'gapPct')::numeric ELSE NULL END)`;
// i18n-ignore-next (stable bucket key: data, not display — the client maps it to a label in edge-api.ts)
const GAP_SQL = `(CASE
  WHEN ${GAP_PCT_SQL} IS NOT NULL THEN (CASE
    WHEN ${GAP_PCT_SQL} <= -10 THEN 'Гэп ≤ −10%'
    WHEN ${GAP_PCT_SQL} <= -3 THEN 'Гэп −3…−10%'
    WHEN ${GAP_PCT_SQL} < 3 THEN 'Гэп ±3%'
    WHEN ${GAP_PCT_SQL} < 10 THEN 'Гэп +3…10%'
    WHEN ${GAP_PCT_SQL} < 30 THEN 'Гэп +10…30%'
    ELSE 'Гэп > 30%' END)
  WHEN lower(COALESCE(t.tags, '')) ~ '(gap up|gap and go long)' THEN 'Гэп вверх'
  WHEN lower(COALESCE(t.tags, '')) ~ '(gap down|gap and go short)' THEN 'Гэп вниз'
  WHEN lower(COALESCE(t.tags, '')) LIKE '%gap%' THEN 'Другой гэп'
  ELSE 'Без гэпа' END)`;

const CLOSE_DAY_SQL = `substring(${closeDateSql("t")} from 1 for 10)`;
const CLOSE_DATE_CAST = `(CASE WHEN ${CLOSE_DAY_SQL} ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN ${CLOSE_DAY_SQL}::date ELSE NULL END)`;
// i18n-ignore-next (stable bucket key: data, not display — the client maps it to a label in edge-api.ts)
const WEEKDAY_SQL = `(CASE EXTRACT(DOW FROM ${CLOSE_DATE_CAST})::int
  WHEN 1 THEN 'Пн' WHEN 2 THEN 'Вт' WHEN 3 THEN 'Ср' WHEN 4 THEN 'Чт' WHEN 5 THEN 'Пт' WHEN 6 THEN 'Сб' WHEN 0 THEN 'Вс' ELSE 'Без даты' END)`;

function dimensionSql(dim: EdgeDimension, tod: number, hasJournal: boolean): string {
  switch (dim) {
    // i18n-ignore-next (stable bucket key: data, not display — the client maps it to a label in edge-api.ts)
    case "setup": return `COALESCE(NULLIF(trim(t.setup), ''), 'Без сетапа')`;
    case "horizon": return horizonSql("t");
    // i18n-ignore-next (stable bucket key: data, not display — the client maps it to a label in edge-api.ts)
    case "tod": return `(CASE WHEN ${ENTRY_MIN_SQL} IS NOT NULL THEN 'm' || (FLOOR(${ENTRY_MIN_SQL} / ${tod}) * ${tod})::int
      WHEN NULLIF(trim(t.session), '') IS NOT NULL THEN 's:' || trim(t.session) ELSE 'без времени' END)`;
    // i18n-ignore-next (stable bucket key: data, not display — the client maps it to a label in edge-api.ts)
    case "hold": return `(CASE WHEN ${HOLD_MIN_SQL} IS NULL THEN 'Не указано'
      WHEN ${HOLD_MIN_SQL} < 5 THEN 'До 5 мин' WHEN ${HOLD_MIN_SQL} < 15 THEN '5–15 мин' WHEN ${HOLD_MIN_SQL} < 60 THEN '15–60 мин'
      WHEN ${HOLD_MIN_SQL} < 240 THEN '1–4 ч' WHEN ${HOLD_MIN_SQL} < 1440 THEN 'Больше 4 ч' ELSE 'Больше дня' END)`;
    // i18n-ignore-next (stable bucket key: data, not display — the client maps it to a label in edge-api.ts)
    case "catalyst": return `COALESCE(NULLIF(trim(t.event_type), ''), 'Без катализатора')`;
    case "cap": return CAP_SQL;
    case "float": return FLOAT_SQL;
    case "gap": return GAP_SQL;
    case "weekday": return WEEKDAY_SQL;
    // i18n-ignore-next (stable bucket key: data, not display — the client maps it to a label in edge-api.ts)
    case "grade": return `COALESCE(NULLIF(trim(t.confidence_grade), ''), 'Без оценки')`;
    // i18n-ignore-next (stable bucket key: data, not display — the client maps it to a label in edge-api.ts)
    case "conviction": return `(CASE WHEN t.conviction IS NULL THEN 'Без уверенности' ELSE t.conviction::text || '/5' END)`;
    case "plan": return hasJournal
      // i18n-ignore-next (stable bucket key: data, not display — the client maps it to a label in edge-api.ts)
      ? `(CASE WHEN j.followed_plan IS TRUE THEN 'По плану' WHEN j.followed_plan IS FALSE THEN 'Не по плану' ELSE 'Не отмечено' END)`
      // i18n-ignore-next (stable bucket key: data, not display — the client maps it to a label in edge-api.ts)
      : `'Не отмечено'`;
    // i18n-ignore-next (stable bucket key: data, not display — the client maps it to a label in edge-api.ts)
    case "side": return `(CASE WHEN lower(COALESCE(t.side, '')) LIKE 's%' THEN 'Шорт' WHEN lower(COALESCE(t.side, '')) LIKE 'l%' THEN 'Лонг' ELSE 'Без стороны' END)`;
    // i18n-ignore-next (stable bucket key: data, not display — the client maps it to a label in edge-api.ts)
    case "trader": return `COALESCE(NULLIF(trim(t.trader), ''), 'Без трейдера')`;
    // i18n-ignore-next (stable bucket key: data, not display — the client maps it to a label in edge-api.ts)
    case "account": return `COALESCE(NULLIF(trim(t.broker_account), ''), 'Без счёта')`;
    // i18n-ignore-next (stable bucket key: data, not display — the client maps it to a label in edge-api.ts)
    case "source": return `(CASE WHEN t.source = 'propreports' THEN 'PropReports' ELSE 'Вручную' END)`;
    case "month": return `substring(${closeDateSql("t")} from 1 for 7)`;
    case "ticker": return `upper(COALESCE(NULLIF(trim(t.ticker), ''), '?'))`;
  }
}

/** WHERE clause shared by both endpoints. `scope` null ⇒ all traders (staff). */
function buildWhere(f: Filters, scope: string | null): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const cond: string[] = [`t.deleted_at IS NULL`];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (scope != null) cond.push(`t.trader = ${p(scope)}`);
  if (f.from) cond.push(`${CLOSE_DAY_SQL} >= ${p(f.from)}`);
  if (f.to) cond.push(`${CLOSE_DAY_SQL} <= ${p(f.to)}`);
  if (f.horizon) cond.push(`${horizonSql("t")} = ${p(f.horizon)}`);
  if (f.side) cond.push(`lower(COALESCE(t.side, '')) LIKE ${p(f.side.toLowerCase().startsWith("s") ? "s%" : "l%")}`);
  if (f.account) cond.push(`t.broker_account = ${p(f.account)}`);
  if (f.source === "propreports") cond.push(`t.source = 'propreports'`);
  if (f.source === "manual") cond.push(`COALESCE(t.source, '') <> 'propreports'`);
  if (f.setup) cond.push(`t.setup = ${p(f.setup)}`);
  if (f.ticker) cond.push(`upper(t.ticker) = ${p(f.ticker.toUpperCase())}`);
  return { where: cond.join(" AND "), params };
}

let journalProbe: Promise<boolean> | null = null;
function hasJournalDays(): Promise<boolean> {
  if (!journalProbe) {
    journalProbe = pool
      .query<{ ok: boolean }>(`SELECT to_regclass('journal_days') IS NOT NULL AS ok`)
      .then((r) => !!r.rows[0]?.ok)
      .catch(() => { journalProbe = null; return false; });
  }
  return journalProbe;
}

/** Earliest entry/add and latest exit/stop/trim execution per trade (`e`), joined only when a dimension reads it
 *  (tod / hold): one trader → per-trade index probe, desk-wide → one hash aggregate (lib/execSpan). */
function fromClause(hasJournal: boolean, exec: "lateral" | "global" | null): string {
  return `FROM trades t` + (exec ? `\n    ${execSpanJoin(exec)}` : "") +
    (hasJournal ? `\n    LEFT JOIN journal_days j ON j.trader = t.trader AND j.day = ${CLOSE_DATE_CAST}` : "");
}

/* ─── /edge/matrix ────────────────────────────────────────────────────────── */

export type EdgeCell = {
  row: string; col: string;
  n: number; closed: number; wins: number; losses: number; be: number;
  sumR: number; rN: number; posR: number; negR: number;
  gross: number; net: number; fees: number; pnlN: number; posNet: number; negNet: number;
  rValues: number[]; netValues: number[];
};

export type MatrixQuery = z.infer<typeof matrixSchema>;
export type CostsQuery = z.infer<typeof costsSchema>;

/** Pure SQL builder (exported for the offline check).
 *  `base` is MATERIALIZED: inlined, Postgres re-evaluates res / r / net at every reference in the aggregates
 *  (≈20 TRANSLATE/LOWER chains per row) — desk-wide 1.1 s → 0.25 s on 45k trades. */
export function buildMatrixQuery(q: MatrixQuery, scope: string | null, hasJournal: boolean): { sql: string; params: unknown[] } {
  const tod = q.tod ?? 30;
  const { where, params } = buildWhere(q, scope);
  const rowSql = dimensionSql(q.rows, tod, hasJournal);
  const colSql = q.cols === q.rows ? `'—'` : dimensionSql(q.cols, tod, hasJournal);
  const needsExec = [q.rows, q.cols].some((d) => d === "tod" || d === "hold");
  const exec = needsExec ? (scope != null ? "lateral" : "global") : null;
  const sql = `WITH base AS MATERIALIZED (
    SELECT ${rowSql} AS row_key, ${colSql} AS col_key,
           ${resultSql("t")} AS res, ${decidedSql("t")} AS decided, ${closedSql("t")} AS closed,
           ${signedRSql("t")} AS r, t.pnl::float8 AS gross, ${netPnlSql("t")}::float8 AS net, ABS(COALESCE(t.fees, 0))::float8 AS fees,
           substring(${closeDateSql("t")} from 1 for 10) AS close_day, t.date AS entry_key, t.id
    ${fromClause(hasJournal, exec)}
    WHERE ${where}
  )
  SELECT row_key, col_key,
         COUNT(*)::int AS n,
         COUNT(*) FILTER (WHERE closed)::int AS closed,
         COUNT(*) FILTER (WHERE res = 'win')::int AS wins,
         COUNT(*) FILTER (WHERE res = 'loss')::int AS losses,
         COUNT(*) FILTER (WHERE res = 'be')::int AS be,
         COALESCE(SUM(r), 0)::float8 AS sum_r,
         COUNT(r)::int AS r_n,
         COALESCE(SUM(r) FILTER (WHERE r > 0), 0)::float8 AS pos_r,
         COALESCE(SUM(r) FILTER (WHERE r < 0), 0)::float8 AS neg_r,
         COALESCE(SUM(gross) FILTER (WHERE closed), 0)::float8 AS gross,
         COALESCE(SUM(net) FILTER (WHERE closed), 0)::float8 AS net,
         COALESCE(SUM(fees) FILTER (WHERE closed AND gross IS NOT NULL), 0)::float8 AS fees,
         COUNT(net) FILTER (WHERE closed)::int AS pnl_n,
         COALESCE(SUM(net) FILTER (WHERE closed AND net > 0), 0)::float8 AS pos_net,
         COALESCE(SUM(net) FILTER (WHERE closed AND net < 0), 0)::float8 AS neg_net,
         (ARRAY_AGG(r ORDER BY close_day, entry_key, id) FILTER (WHERE r IS NOT NULL))[1:${VALUES_CAP}] AS r_values,
         (ARRAY_AGG(net ORDER BY close_day, entry_key, id) FILTER (WHERE closed AND net IS NOT NULL))[1:${VALUES_CAP}] AS net_values
  FROM base
  GROUP BY row_key, col_key
  ORDER BY row_key, col_key`;
  return { sql, params };
}

export function parseMatrixQuery(query: Record<string, unknown>): { ok: true; q: MatrixQuery } | { ok: false; details: unknown } {
  const parsed = matrixSchema.safeParse(normQuery(query as Request["query"]));
  return parsed.success ? { ok: true, q: parsed.data } : { ok: false, details: parsed.error.flatten() };
}

router.get("/edge/matrix", asyncHandler(async (req, res) => {
  const parsed = parseMatrixQuery(req.query);
  if (!parsed.ok) throw badRequest("BAD_REQUEST", parsed.details);
  const q = parsed.q;
  const scope = await scopeTrader(req, q.trader);
  if (scope === undefined) throw unauthorized();
  const hasJournal = (q.rows === "plan" || q.cols === "plan") ? await hasJournalDays() : false;
  const tod = q.tod ?? 30;
  const { sql, params } = buildMatrixQuery(q, scope, hasJournal);
  const { rows } = await pool.query<any>(sql, params);
  const cells: EdgeCell[] = rows.map((r) => ({
    row: String(r.row_key ?? ""), col: String(r.col_key ?? ""),
    n: r.n, closed: r.closed, wins: r.wins, losses: r.losses, be: r.be,
    sumR: r.sum_r, rN: r.r_n, posR: r.pos_r, negR: r.neg_r,
    gross: r.gross, net: r.net, fees: r.fees, pnlN: r.pnl_n, posNet: r.pos_net, negNet: r.neg_net,
    rValues: (r.r_values ?? []).map((v: unknown) => num(v) ?? 0),
    netValues: (r.net_values ?? []).map((v: unknown) => num(v) ?? 0),
  }));
  const rowKeys = [...new Set(cells.map((c) => c.row))];
  const colKeys = [...new Set(cells.map((c) => c.col))];
  res.json({
    rows: q.rows, cols: q.cols, tod, scope, rowKeys, colKeys, cells,
    total: cells.reduce((s, c) => s + c.n, 0),
    hasJournal,
    generatedAt: new Date().toISOString(),
  });
}));

/* ─── /edge/costs ─────────────────────────────────────────────────────────── */

export type EdgeCostRow = {
  key: string;
  trades: number; closed: number; tradesWithPnl: number; tradesWithFees: number;
  gross: number; grossWins: number; fees: number; net: number;
  /** fees / gross profit (sum of winning gross) — share of winnings eaten by costs. */
  feePctOfGrossWins: number | null;
  /** fees / |gross| — share of the absolute gross result. */
  feePctOfGross: number | null;
  shares: number; feePerShare: number | null; feePerTrade: number | null;
  slippageN: number; slippageSum: number; slippageAvg: number | null;
};

export function buildCostsQuery(q: CostsQuery, scope: string | null): { sql: string; params: unknown[] } {
  const { where, params } = buildWhere(q, scope);
  const keySql = dimensionSql(q.group, 30, false);
  const sql = `WITH base AS MATERIALIZED (
    SELECT ${keySql} AS key, ${closedSql("t")} AS closed,
           t.pnl::float8 AS gross, ${netPnlSql("t")}::float8 AS net,
           (CASE WHEN t.pnl IS NOT NULL THEN ABS(COALESCE(t.fees, 0)) END)::float8 AS fees,
           t.fees IS NOT NULL AND t.fees <> 0 AS has_fees,
           t.qty::float8 AS qty, t.slippage::float8 AS slippage
    ${fromClause(false, null)}
    WHERE ${where}
  )
  SELECT key,
         COUNT(*)::int AS trades,
         COUNT(*) FILTER (WHERE closed)::int AS closed,
         COUNT(gross) FILTER (WHERE closed)::int AS trades_with_pnl,
         COUNT(*) FILTER (WHERE closed AND has_fees)::int AS trades_with_fees,
         COALESCE(SUM(gross) FILTER (WHERE closed), 0)::float8 AS gross,
         COALESCE(SUM(gross) FILTER (WHERE closed AND gross > 0), 0)::float8 AS gross_wins,
         COALESCE(SUM(fees) FILTER (WHERE closed), 0)::float8 AS fees,
         COALESCE(SUM(net) FILTER (WHERE closed), 0)::float8 AS net,
         COALESCE(SUM(ABS(qty)) FILTER (WHERE closed AND gross IS NOT NULL), 0)::float8 AS shares,
         COUNT(slippage)::int AS slippage_n,
         COALESCE(SUM(slippage), 0)::float8 AS slippage_sum
  FROM base
  GROUP BY key
  ORDER BY key`;
  return { sql, params };
}

export function parseCostsQuery(query: Record<string, unknown>): { ok: true; q: CostsQuery } | { ok: false; details: unknown } {
  const parsed = costsSchema.safeParse(normQuery(query as Request["query"]));
  return parsed.success ? { ok: true, q: parsed.data } : { ok: false, details: parsed.error.flatten() };
}

router.get("/edge/costs", asyncHandler(async (req, res) => {
  const parsed = parseCostsQuery(req.query);
  if (!parsed.ok) throw badRequest("BAD_REQUEST", parsed.details);
  const q = parsed.q;
  const scope = await scopeTrader(req, q.trader);
  if (scope === undefined) throw unauthorized();
  const { sql, params } = buildCostsQuery(q, scope);
  const { rows } = await pool.query<any>(sql, params);
  const items: EdgeCostRow[] = rows.map((r) => ({
    key: String(r.key ?? ""),
    trades: r.trades, closed: r.closed, tradesWithPnl: r.trades_with_pnl, tradesWithFees: r.trades_with_fees,
    gross: r.gross, grossWins: r.gross_wins, fees: r.fees, net: r.net,
    feePctOfGrossWins: r.gross_wins > 0 ? r.fees / r.gross_wins : null,
    feePctOfGross: r.gross !== 0 ? r.fees / Math.abs(r.gross) : null,
    shares: r.shares,
    feePerShare: r.shares > 0 ? r.fees / r.shares : null,
    feePerTrade: r.trades_with_pnl > 0 ? r.fees / r.trades_with_pnl : null,
    slippageN: r.slippage_n, slippageSum: r.slippage_sum,
    slippageAvg: r.slippage_n > 0 ? r.slippage_sum / r.slippage_n : null,
  }));
  const total = items.reduce(
    (a, x) => ({
      trades: a.trades + x.trades, closed: a.closed + x.closed, tradesWithPnl: a.tradesWithPnl + x.tradesWithPnl,
      tradesWithFees: a.tradesWithFees + x.tradesWithFees, gross: a.gross + x.gross, grossWins: a.grossWins + x.grossWins,
      fees: a.fees + x.fees, net: a.net + x.net, shares: a.shares + x.shares, slippageN: a.slippageN + x.slippageN, slippageSum: a.slippageSum + x.slippageSum,
    }),
    { trades: 0, closed: 0, tradesWithPnl: 0, tradesWithFees: 0, gross: 0, grossWins: 0, fees: 0, net: 0, shares: 0, slippageN: 0, slippageSum: 0 },
  );
  res.json({
    group: q.group, scope, items,
    total: {
      ...total,
      feePctOfGrossWins: total.grossWins > 0 ? total.fees / total.grossWins : null,
      feePctOfGross: total.gross !== 0 ? total.fees / Math.abs(total.gross) : null,
      feePerShare: total.shares > 0 ? total.fees / total.shares : null,
      feePerTrade: total.tradesWithPnl > 0 ? total.fees / total.tradesWithPnl : null,
      slippageAvg: total.slippageN > 0 ? total.slippageSum / total.slippageN : null,
    },
    generatedAt: new Date().toISOString(),
  });
}));

export const edgeRouter = router;
export default router;
