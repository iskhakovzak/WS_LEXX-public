import { Router, type IRouter } from "express";
import { z } from "zod";
import { eq, desc, isNull, and, sql, inArray } from "drizzle-orm";
import { db, pool, tradesTable, preTradeChecklistResponsesTable } from "@workspace/db";
import { logActivity } from "../lib/activity";
import { activityTitle } from "../lib/activityText";
import { asyncHandler } from "../lib/asyncHandler";
import { logger } from "../lib/logger";
import { scopeTrader } from "../lib/auth";
import { can, } from "../lib/permissions";
import { normResult, num } from "../lib/tradeMath";
import { refreshTradeStructures } from "../lib/tradeStructureStore";
import {
  PAGE_SORT_COLS,
  PAGE_OUTCOMES,
  PAGE_HORIZONS,
  PAGE_SOURCES,
  PAGE_PRESETS,
  DAYS_LIMIT_DEFAULT,
  DAYS_LIMIT_MAX,
  MONEY_PRESETS,
  MONEY_SORT_COLS,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  PAGE_OFFSET_MAX,
  TRADES_PAGE_INDEX_SQL,
  buildPageQuery,
  buildSummaryQuery,
  buildCountQuery,
  buildCurveQuery,
  buildStreakQuery,
  buildOutcomeFacetQuery,
  buildHorizonFacetQuery,
  buildOptionsQuery,
  buildPresetFacetQuery,
  buildDaysQuery,
  decodeCursor,
  encodeCursor,
  foldStreak,
  hasQualityFilters,
  sortValueOf,
  type TradesPageFilters,
} from "../lib/tradesPageQuery";
import { findChecklistResponseFor } from "./checklist";
import { captureAndAttach } from "../lib/marketContext";
import { maybeAutoGenerateReview } from "../lib/aiReview";
import { sanitizeMultiLineUrls } from "../lib/safe-url";
import { invalidateDashboardCache } from "../lib/hotCache";
import { scanRulesForTrader } from "../lib/rulesEngine";
import { isReadableExampleTrade, loadMoneyViewer } from "../lib/playbookAccess";
import { canSeeBookMoney, redactBookDay, redactBookSummary, redactTradeRow, redactTradeRows, type Redacted } from "../lib/playbookPrivacy";
import {
  ListTradesQueryParams,
  CreateTradeBody,
  GetTradeParams,
  UpdateTradeParams,
  UpdateTradeBody,
  DeleteTradeParams,
  ListTradesResponse,
  GetTradeResponse,
  UpdateTradeResponse,
} from "@workspace/api-zod";
import { AppError, badRequest, notFound, unauthorized } from "../lib/http";

const router: IRouter = Router();

type TradeRow = typeof tradesTable.$inferSelect;

// Numeric columns arrive as strings from pg; `x ? Number(x) : null` turned a legitimate
// 0 (e.g. pnl = 0, slippage = 0) into null — use an explicit null check instead.
function numOrNull(x: string | number | null | undefined): number | null {
  if (x == null || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

export function toTradeResponseShape(t: TradeRow) {
  return {
    id: t.id,
    ticker: t.ticker,
    date: t.date,
    setup: t.setup ?? null,
    side: t.side ?? null,
    eventType: t.eventType ?? null,
    entry: numOrNull(t.entry),
    exit: numOrNull(t.exit),
    stop: numOrNull(t.stop),
    result: t.result,
    pnl: numOrNull(t.pnl),
    rMultiple: numOrNull(t.rMultiple),
    holdTime: t.holdTime ?? null,
    slippage: numOrNull(t.slippage),
    marketCap: t.marketCap ?? null,
    float: t.float ?? null,
    relativeVolume: numOrNull(t.relativeVolume),
    atr: numOrNull(t.atr),
    sector: t.sector ?? null,
    session: t.session ?? null,
    screenshotUrl: t.screenshotUrl ?? null,
    screenshotNotes: t.screenshotNotes ?? null,
    notes: t.notes ?? null,
    whatWorked: t.whatWorked ?? null,
    whatFailed: t.whatFailed ?? null,
    conclusion: t.conclusion ?? null,
    trader: t.trader ?? null,
    tags: t.tags ?? null,
    eventId: t.eventId ?? null,
    patternId: t.patternId ?? null,
    beta: numOrNull(t.beta),
    shortInterest: numOrNull(t.shortInterest),
    adv: t.adv ?? null,
    longName: t.longName ?? null,
    contextSnapshot: t.contextSnapshot ?? null,
    conviction: t.conviction ?? null,
    confidenceGrade: t.confidenceGrade ?? null,
    horizon: (t.horizon === "intraday" || t.horizon === "overnight" || t.horizon === "swing") ? t.horizon : null,
    exitDate: t.exitDate ?? null,
    qty: t.qty != null ? Number(t.qty) : null,
    fees: t.fees != null ? Number(t.fees) : null,
    riskUsd: t.riskUsd != null ? Number(t.riskUsd) : null,
    // Broker layer (PropReports). null/undefined ⇒ manual trade.
    source: t.source === "propreports" || t.source === "manual" ? t.source : null,
    externalId: t.externalId ?? null,
    brokerAccount: t.brokerAccount ?? null,
    syncedAt: t.syncedAt ? new Date(t.syncedAt).toISOString() : null,
    createdAt: t.createdAt.toISOString(),
  };
}

// Access to someone else's trade goes through the permission matrix (lib/permissions):
// "trades.read.team" for reads, "trades.write.any" for changes. One's own trades are always allowed.
async function forbiddenFor(req: Parameters<typeof can>[0], cap: "trades.read.team" | "trades.write.any", owner: string | null): Promise<boolean> {
  return !(await can(req, cap, { trader: owner })) && owner !== req.authUser?.name;
}

// Optional window for the legacy list (P1-5). Without any of these the endpoint behaves exactly as before
// (whole scoped book, newest createdAt first). The generated ListTradesQueryParams strips unknown keys, so these
// are parsed separately and never reach the generated schema.
//   from/to  YYYY-MM-DD — trades that TOUCH the window: entered on/before `to` AND realised (exit date, else
//            entry date) on/after `from`, plus still-open positions entered on/before `to` (carried positions).
//            A superset of "closeDate in [from,to]" and of "entry date in [from,to]" — callers refine client-side.
//   limit    ≥1 (clamped to 5000) — newest by trade date first (date desc, id desc) when set.
//   tagged   1|true — only trades with a non-empty setup or tags (the indicators page needs nothing else).
//   lite     1|true — omit the bulky `contextSnapshot` (raw broker snapshot, ~35% of the payload) — calendar /
//            journal views that never read it. Field stays in the shape as null.
const LEGACY_YMD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
const LegacyWindowQuery = z.object({
  from: LEGACY_YMD,
  to: LEGACY_YMD,
  limit: z.coerce.number().int().min(1).transform((n) => Math.min(n, 5000)).optional(),
  tagged: z.enum(["1", "true", "0", "false"]).optional(),
  lite: z.enum(["1", "true", "0", "false"]).optional(),
});

router.get("/trades", asyncHandler(async (req, res): Promise<void> => {
  const query = ListTradesQueryParams.safeParse(req.query);
  if (!query.success) {
    throw query.error;
  }
  const win = LegacyWindowQuery.safeParse(compactQuery(req.query as Record<string, unknown>));
  if (!win.success) {
    throw win.error;
  }
  const { setup, eventType, session, trader, result } = query.data;
  const { from, to, limit } = win.data;
  const tagged = win.data.tagged === "1" || win.data.tagged === "true";
  const conditions: ReturnType<typeof eq>[] = [isNull(tradesTable.deletedAt) as unknown as ReturnType<typeof eq>];
  if (setup) conditions.push(eq(tradesTable.setup, setup));
  if (eventType) conditions.push(eq(tradesTable.eventType, eventType));
  if (session) conditions.push(eq(tradesTable.session, session));
  if (result) conditions.push(eq(tradesTable.result, result));
  if (to) conditions.push(sql`${tradesTable.date} <= ${to}` as unknown as ReturnType<typeof eq>);
  if (from) {
    conditions.push(sql`(COALESCE(NULLIF(${tradesTable.exitDate}, ''), ${tradesTable.date}) >= ${from}
      OR LOWER(TRIM(COALESCE(${tradesTable.result}, ''))) = 'open')` as unknown as ReturnType<typeof eq>);
  }
  if (tagged) {
    conditions.push(sql`(NULLIF(TRIM(COALESCE(${tradesTable.setup}, '')), '') IS NOT NULL
      OR NULLIF(TRIM(COALESCE(${tradesTable.tags}, '')), '') IS NOT NULL)` as unknown as ReturnType<typeof eq>);
  }

  // Scope via lib/auth scopeTrader (same rule as /trades/page): staff may pass ?trader= (none = whole desk),
  // every other member lists only their own book, a guest gets the no-match sentinel (empty list).
  const scope = await scopeTrader(req, trader ?? null);
  if (scope === undefined) throw unauthorized();
  if (scope !== null) conditions.push(eq(tradesTable.trader, scope));

  const base = db.select().from(tradesTable).where(and(...conditions));
  const rows = limit != null
    ? await base.orderBy(desc(tradesTable.date), desc(tradesTable.id)).limit(limit)
    : await base.orderBy(desc(tradesTable.createdAt));

  // $ privacy (lib/playbookPrivacy): a trader only ever lists their own book; anyone else's $ is nulled for non-staff.
  const lite = win.data.lite === "1" || win.data.lite === "true";
  const shaped = rows.map(toTradeResponseShape);
  if (lite) for (const t of shaped) t.contextSnapshot = null;
  res.json(redactTradeRows(ListTradesResponse.parse(shaped), await loadMoneyViewer(req)));
}));

// ── Paginated book: GET /trades/page ─────────────────────────────────────────
// One request = one page of rows + summary over the WHOLE filtered set + facet counts for the filter bar.
// Keyset (`cursor`, stable under inserts) or offset (`offset`, for "jump to page N") — never both.
// Scope via lib/auth scopeTrader (staff may pass ?trader=, everyone else sees their own book).
// Contract (query → response) is documented in the handler body; the pure SQL builders live in lib/tradesPageQuery.ts.

let pageIndexesEnsured: Promise<void> | null = null;
function ensurePageIndexes(): Promise<void> {
  if (!pageIndexesEnsured) {
    pageIndexesEnsured = (async () => {
      for (const stmt of TRADES_PAGE_INDEX_SQL) await pool.query(stmt);
    })().catch((err) => {
      pageIndexesEnsured = null;
      throw err;
    });
  }
  return pageIndexesEnsured;
}
ensurePageIndexes().catch((err) => logger.warn({ err }, "trades/page: ensure indexes failed at init"));

// trade_quality is created lazily by routes/trade-quality.ts; re-check every minute so a fresh DB picks it up.
let qualityTableCheck: { ok: boolean; exp: number } | null = null;
async function qualityTableExists(): Promise<boolean> {
  const now = Date.now();
  if (qualityTableCheck && qualityTableCheck.exp > now) return qualityTableCheck.ok;
  try {
    const { rows } = await pool.query<{ ok: boolean }>(`SELECT to_regclass('public.trade_quality') IS NOT NULL AS ok`);
    qualityTableCheck = { ok: Boolean(rows[0]?.ok), exp: now + 60_000 };
  } catch {
    qualityTableCheck = { ok: false, exp: now + 10_000 };
  }
  return qualityTableCheck.ok;
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const str = (max: number) => z.string().trim().max(max).optional();
const ymd = z.string().regex(YMD_RE).optional();
const numOpt = z.coerce.number().finite().optional();

const TradesPageQuery = z.object({
  trader: str(80),
  ticker: str(16),
  date: ymd,
  from: ymd,
  to: ymd,
  setup: str(120),
  playbookId: z.coerce.number().int().positive().optional(),
  horizon: z.enum(PAGE_HORIZONS).optional(),
  source: z.enum(PAGE_SOURCES).optional(),
  side: str(10),
  outcome: z.enum(PAGE_OUTCOMES).optional(),
  // `result` is accepted as an alias of `outcome` (same vocabulary as /trades?result=).
  result: z.enum(PAGE_OUTCOMES).optional(),
  ids: z.string().regex(/^\d+(,\d+)*$/).max(4000).optional(),
  sector: str(80),
  session: str(20),
  eventType: str(20),
  tag: str(60),
  q: str(120),
  exitEffMax: numOpt,
  mfeRMin: numOpt,
  leftMin: numOpt,
  preset: z.enum(PAGE_PRESETS).optional(),
  sort: z.enum(PAGE_SORT_COLS).default("date"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
  offset: z.coerce.number().int().min(0).max(PAGE_OFFSET_MAX).default(0),
  cursor: z.string().max(400).optional(),
  // lite=1: only summary.total / firstDate / lastDate + horizon & option facets (no rows, curve, streak, presets).
  lite: z.enum(["1", "true", "0", "false"]).optional(),
});

/** Empty strings (`?setup=&tag=`) mean "not set" — strip them before validation. */
function compactQuery(q: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(q)) {
    const s = Array.isArray(v) ? v[v.length - 1] : v;
    if (s === undefined || s === null || s === "") continue;
    out[k] = s;
  }
  return out;
}

type TradesPageQueryT = z.infer<typeof TradesPageQuery>;
function pageFiltersOf(q: TradesPageQueryT, scope: string | null): TradesPageFilters {
  const ids = q.ids ? Array.from(new Set(q.ids.split(",").map((s) => Number(s)).filter((n) => Number.isInteger(n) && n > 0))).slice(0, 500) : undefined;
  return {
    scope,
    ticker: q.ticker || undefined,
    from: q.date ?? q.from,
    to: q.date ?? q.to,
    setup: q.setup || undefined,
    playbookId: q.playbookId,
    horizon: q.horizon,
    source: q.source ?? "",
    side: q.side || undefined,
    outcome: q.outcome ?? q.result ?? "",
    ids,
    sector: q.sector || undefined,
    session: q.session || undefined,
    eventType: q.eventType || undefined,
    tag: q.tag || undefined,
    q: q.q || undefined,
    exitEffMax: q.exitEffMax ?? null,
    mfeRMin: q.mfeRMin ?? null,
    leftMin: q.leftMin ?? null,
    preset: q.preset ?? "",
  };
}

/** Filters of a book whose $ the viewer may not see: no $ preset, no free-text match on pnl. */
function moneyBlindFilters(f: TradesPageFilters, showMoney: boolean): TradesPageFilters {
  if (showMoney) return f;
  return { ...f, moneyBlind: true, preset: f.preset && MONEY_PRESETS.has(f.preset) ? "" : f.preset };
}

router.get("/trades/page", asyncHandler(async (req, res): Promise<void> => {
  /*
   * Query:  trader? ticker? date? from? to? setup? playbookId? horizon? source? side? outcome|result? ids? sector? session?
   *         eventType? tag? q? exitEffMax? mfeRMin? leftMin? sort=date|ticker|side|setup|trader|entry|exit|r|result|pnl|gross|fees|exitEff|mfeR|left
   *         dir=asc|desc limit=1..500 (50) offset=0.. | cursor=<opaque>
   * Answer: { items: Trade[], page: { limit, offset, returned, hasMore, nextCursor, sort, dir },
   *           summary: { total, wins, losses, be, open, decided, winRate, gross, fees, net, pnlCount, totalR, rCount, avgR,
   *                      avgWinR, avgLossR, expectancyR, posR, negR, profitFactor, firstDate, lastDate, feeRows, streak, curve },
   *           facets: { outcomes: {all,win,loss,breakeven,open}, horizons: {intraday,overnight,swing}, setups: [{name,count}], traders: string[], sectors: string[] },
   *           quality: { available, applied } }
   */
  const parsed = TradesPageQuery.safeParse(compactQuery(req.query as Record<string, unknown>));
  if (!parsed.success) {
    throw parsed.error;
  }
  const q = parsed.data;
  const scope = await scopeTrader(req, q.trader);
  if (scope === undefined) throw unauthorized();

  // $ privacy: on a book whose $ the viewer may not see, $ sorts fall back to date and $ filters are off — the
  // order / matches would reveal amounts the rows no longer carry.
  const mv = await loadMoneyViewer(req);
  const showMoney = canSeeBookMoney(mv, scope);
  const sort = { col: !showMoney && MONEY_SORT_COLS.has(q.sort) ? "date" as const : q.sort, dir: q.dir };
  let cursor = null;
  if (q.cursor) {
    cursor = decodeCursor(q.cursor);
    if (!cursor) throw new AppError("INVALID_FIELD", undefined, { field: "cursor" });
    if (cursor.s !== sort.col || cursor.d !== sort.dir) throw new AppError("INVALID_FIELD", undefined, { field: "cursor" });
  }
  const filters = moneyBlindFilters(pageFiltersOf(q, scope), showMoney);

  await ensurePageIndexes().catch((err) => req.log.warn({ err: err instanceof Error ? err.message : String(err) }, "trades/page: ensure indexes failed"));
  const quality = await qualityTableExists();

  // lite=1 (counters, global search, pickers): rows + total / date span + option facets only — the summary aggregates,
  // curve, streak, outcome and preset counts are the costly part on a 45k-trade desk and are skipped.
  const lite = q.lite === "1" || q.lite === "true";
  const none = <T,>() => Promise.resolve({ rows: [] as T[] });
  const pageQ = buildPageQuery({ filters, sort, limit: q.limit, offset: q.offset, cursor, quality });
  const summaryQ = lite ? buildCountQuery(filters, quality) : buildSummaryQuery(filters, quality);
  const curveQ = buildCurveQuery(filters, quality);
  const streakQ = buildStreakQuery(filters, quality);
  const outcomeQ = buildOutcomeFacetQuery(filters, quality);
  const horizonQ = buildHorizonFacetQuery(filters, quality);
  const optionsQ = buildOptionsQuery(scope);
  const presetQ = buildPresetFacetQuery(filters, quality);

  const [pageRes, summaryRes, curveRes, streakRes, outcomeRes, horizonRes, optionsRes, presetRes] = await Promise.all([
    pool.query<{ id: number; sv: unknown }>(pageQ.sql, pageQ.params),
    pool.query<Record<string, unknown>>(summaryQ.sql, summaryQ.params),
    lite ? none<{ i: string | number; cum: string | number; label: string }>() : pool.query<{ i: string | number; cum: string | number; label: string }>(curveQ.sql, curveQ.params),
    lite ? none<{ res: string | null }>() : pool.query<{ res: string | null }>(streakQ.sql, streakQ.params),
    lite ? none<{ k: string; n: number }>() : pool.query<{ k: string; n: number }>(outcomeQ.sql, outcomeQ.params),
    pool.query<{ k: string; n: number }>(horizonQ.sql, horizonQ.params),
    pool.query<{ kind: string; name: string; n: number }>(optionsQ.sql, optionsQ.params),
    // Preset badges are a nicety: a failure there must not break the book.
    lite ? none<Record<string, number>>() : pool.query<Record<string, number>>(presetQ.sql, presetQ.params).catch((err) => {
      req.log.warn({ err: err instanceof Error ? err.message : String(err) }, "trades/page: preset facets failed");
      return { rows: [] as Record<string, number>[] };
    }),
  ]);

  const hasMore = pageRes.rows.length > q.limit;
  const pageRows = hasMore ? pageRes.rows.slice(0, q.limit) : pageRes.rows;
  const pageIds = pageRows.map((r) => r.id);
  const last = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && last ? encodeCursor({ s: sort.col, d: sort.dir, v: sortValueOf(last.sv, sort.col), id: last.id }) : null;

  // Rows by PK in page order (reuses the canonical response shape; the heavy work was the id query).
  const items: Redacted<ReturnType<typeof toTradeResponseShape>>[] = [];
  if (pageIds.length) {
    const rows = await db.select().from(tradesTable).where(inArray(tradesTable.id, pageIds));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of pageIds) { const r = byId.get(id); if (r) items.push(redactTradeRow(toTradeResponseShape(r), mv)); }
  }

  const s = summaryRes.rows[0] ?? {};
  const total = Number(s.total ?? 0), wins = Number(s.wins ?? 0), losses = Number(s.losses ?? 0), be = Number(s.be ?? 0), open = Number(s.open ?? 0);
  const pnlCount = Number(s.pnl_count ?? 0), rCount = Number(s.r_count ?? 0), winRN = Number(s.win_r_n ?? 0), lossRN = Number(s.loss_r_n ?? 0);
  const sumR = num(s.sum_r) ?? 0, posR = num(s.pos_r) ?? 0, negR = num(s.neg_r) ?? 0;
  const avgWinR = winRN ? (num(s.win_r_sum) ?? 0) / winRN : null;
  const avgLossR = lossRN ? (num(s.loss_r_sum) ?? 0) / lossRN : null;
  const closed = wins + losses + be;
  const decided = wins + losses;
  const expectancyR = closed && (avgWinR != null || avgLossR != null) ? (wins / closed) * (avgWinR ?? 0) + (losses / closed) * (avgLossR ?? 0) : null;

  const outcomes = { all: 0, win: 0, loss: 0, breakeven: 0, open: 0 };
  for (const r of outcomeRes.rows) {
    const k = r.k === "be" ? "breakeven" : r.k;
    if (k in outcomes) outcomes[k as keyof typeof outcomes] += Number(r.n);
    outcomes.all += Number(r.n);
  }
  const horizons: Record<string, number> = {};
  for (const r of horizonRes.rows) horizons[r.k] = Number(r.n);
  const setups: { name: string; count: number }[] = [];
  const traders: string[] = [];
  const sectors: string[] = [];
  for (const r of optionsRes.rows) {
    if (r.kind === "setup") setups.push({ name: r.name, count: Number(r.n) });
    else if (r.kind === "trader") traders.push(r.name);
    else if (r.kind === "sector") sectors.push(r.name);
  }
  traders.sort((a, b) => a.localeCompare(b));
  sectors.sort((a, b) => a.localeCompare(b));
  if (lite) {
    // No $ in the lite summary (count and dates only) — nothing to redact beyond the rows themselves.
    res.json({
      items,
      page: { limit: q.limit, offset: cursor ? null : q.offset, returned: items.length, hasMore, nextCursor, sort: sort.col, dir: sort.dir },
      summary: { total, firstDate: (s.first_date as string | null) ?? null, lastDate: (s.last_date as string | null) ?? null, lite: true },
      facets: { outcomes: null, horizons, setups, traders, sectors, presets: null },
      quality: { available: quality, applied: hasQualityFilters(filters) },
      preset: filters.preset || null,
      lite: true,
    });
    return;
  }
  const presetRow = presetRes.rows[0];
  const presets: Record<string, number> | null = presetRow ? Object.fromEntries(PAGE_PRESETS.map((k) => [k, Number(presetRow[k] ?? 0)])) : null;
  const winNetN = Number(s.win_net_n ?? 0), lossNetN = Number(s.loss_net_n ?? 0);
  const posNet = num(s.pos_net) ?? 0, negNet = num(s.neg_net) ?? 0;

  const summary = {
    total, wins, losses, be, open, decided,
    winRate: decided ? wins / decided : null,
    gross: pnlCount ? num(s.gross) : null,
    fees: pnlCount ? (num(s.fees) ?? 0) : null,
    net: pnlCount ? num(s.net) : null,
    pnlCount,
    totalR: sumR, rCount,
    avgR: rCount ? sumR / rCount : null,
    avgWinR, avgLossR, expectancyR,
    posR, negR,
    // PF = ΣR⁺ / |ΣR⁻|; null (never ∞) without losing R.
    profitFactor: negR > 0 ? posR / negR : null,
    firstDate: (s.first_date as string | null) ?? null,
    lastDate: (s.last_date as string | null) ?? null,
    feeRows: Number(s.fee_rows ?? 0),
    streak: foldStreak(streakRes.rows.map((r) => r.res)),
    curve: curveRes.rows.map((r) => ({ i: Number(r.i), r: Math.round((num(r.cum) ?? 0) * 100) / 100, label: r.label })),
    // $-based review metrics (additive; R is optional on this desk — most trades carry no stop).
    avgWinNet: winNetN ? (num(s.win_net_sum) ?? 0) / winNetN : null,
    avgLossNet: lossNetN ? (num(s.loss_net_sum) ?? 0) / lossNetN : null,
    posNet, negNet,
    // PF in $ = Σnet⁺ / |Σnet⁻|; null (never ∞) without a losing trade.
    profitFactorNet: negNet > 0 ? posNet / negNet : null,
    maxNet: num(s.max_net),
    minNet: num(s.min_net),
    untagged: Number(s.untagged ?? 0),
    avgHoldSec: num(s.avg_hold_sec),
    days: Number(s.days ?? 0),
  };

  res.json({
    items,
    page: { limit: q.limit, offset: cursor ? null : q.offset, returned: items.length, hasMore, nextCursor, sort: sort.col, dir: sort.dir },
    // A matrix grant (team.read) may scope a non-staff viewer to someone else's book: counts and R stay, $ do not.
    summary: showMoney ? { ...summary, redacted: false } : redactBookSummary(summary),
    facets: { outcomes, horizons, setups, traders, sectors, presets },
    quality: { available: quality, applied: hasQualityFilters(filters) },
    // Echo so the client can tell this API applied the preset (an older build silently ignores the param).
    preset: filters.preset || null,
  });
}));

// ── Day-grouped review list: GET /trades/days ────────────────────────────────
// Same filters/scope as /trades/page (sort/cursor ignored) → per trading day aggregates, newest first.
//   extra query: limit=1..1000 (120), before=YYYY-MM-DD (page backwards: days strictly before it)
//   answer: { days: [{ date, count, wins, losses, be, open, winRate, gross, fees, net, maxNet, minNet, rCount, totalR,
//             untagged, firstAt, lastAt, seq: number[] }], hasMore, nextBefore, totalDays }
const TradesDaysQuery = TradesPageQuery.extend({
  limit: z.coerce.number().int().min(1).max(DAYS_LIMIT_MAX).default(DAYS_LIMIT_DEFAULT),
  before: ymd,
});

router.get("/trades/days", asyncHandler(async (req, res): Promise<void> => {
  const parsed = TradesDaysQuery.safeParse(compactQuery(req.query as Record<string, unknown>));
  if (!parsed.success) {
    throw parsed.error;
  }
  const q = parsed.data;
  const scope = await scopeTrader(req, q.trader);
  if (scope === undefined) throw unauthorized();
  const quality = await qualityTableExists();
  const showMoney = canSeeBookMoney(await loadMoneyViewer(req), scope);
  const filters = moneyBlindFilters(pageFiltersOf(q, scope), showMoney);
  const daysQ = buildDaysQuery(filters, quality, { limit: q.limit, before: q.before });
  const { rows } = await pool.query<Record<string, unknown>>(daysQ.sql, daysQ.params);
  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const days = page.map((r) => {
    const wins = Number(r.wins ?? 0), losses = Number(r.losses ?? 0);
    const pnlCount = Number(r.pnl_count ?? 0);
    const seq = Array.isArray(r.seq) ? (r.seq as unknown[]).map((v) => num(v) ?? 0) : [];
    return {
      date: String(r.d),
      count: Number(r.n ?? 0),
      wins, losses,
      be: Number(r.be ?? 0),
      open: Number(r.open ?? 0),
      winRate: wins + losses ? wins / (wins + losses) : null,
      gross: pnlCount ? num(r.gross) : null,
      fees: pnlCount ? (num(r.fees) ?? 0) : null,
      net: pnlCount ? num(r.net) : null,
      maxNet: num(r.max_net),
      minNet: num(r.min_net),
      rCount: Number(r.r_count ?? 0),
      totalR: num(r.sum_r) ?? 0,
      untagged: Number(r.untagged ?? 0),
      firstAt: (r.first_at as string | null) ?? null,
      lastAt: (r.last_at as string | null) ?? null,
      seq,
    };
  });
  const lastDay = days[days.length - 1];
  res.json({
    days: showMoney ? days.map((d) => ({ ...d, redacted: false })) : days.map(redactBookDay),
    hasMore,
    nextBefore: hasMore && lastDay ? lastDay.date : null,
    totalDays: rows.length ? Number(rows[0].days_total ?? days.length) : 0,
    preset: filters.preset || null,
  });
}));

router.post("/trades", asyncHandler(async (req, res): Promise<void> => {
  const parsed = CreateTradeBody.safeParse(req.body);
  if (!parsed.success) {
    throw parsed.error;
  }
  const skipChecklist = req.query.skipChecklist === "true" || req.body?.skipChecklist === true;
  const submittedResponseId = typeof req.body?.checklistResponseId === "number" ? req.body.checklistResponseId : null;
  let validatedChecklist: { id: number; passed: boolean } | null = null;
  if (submittedResponseId) {
    const [row] = await db
      .select({
        id: preTradeChecklistResponsesTable.id,
        passed: preTradeChecklistResponsesTable.passed,
        ticker: preTradeChecklistResponsesTable.ticker,
        tradeDate: preTradeChecklistResponsesTable.tradeDate,
        trader: preTradeChecklistResponsesTable.trader,
      })
      .from(preTradeChecklistResponsesTable)
      .where(eq(preTradeChecklistResponsesTable.id, submittedResponseId))
      .limit(1);
    if (!row) {
      throw new AppError("CHECKLIST_INVALID_ID", 422, undefined, { responseId: submittedResponseId });
    }
    if (row.ticker.toUpperCase() !== parsed.data.ticker.toUpperCase() || row.tradeDate !== parsed.data.date) {
      throw new AppError("CHECKLIST_MISMATCH", 422, undefined, { responseId: submittedResponseId });
    }
    const traderClaimed = parsed.data.trader ?? null;
    if (row.trader && traderClaimed && row.trader !== traderClaimed) {
      throw new AppError("CHECKLIST_MISMATCH", 422, undefined, { responseId: submittedResponseId });
    }
    validatedChecklist = { id: row.id, passed: row.passed };
  } else if (!skipChecklist) {
    validatedChecklist = await findChecklistResponseFor({
      ticker: parsed.data.ticker,
      tradeDate: parsed.data.date,
      trader: parsed.data.trader ?? null,
    });
  }
  if (!skipChecklist && !validatedChecklist) {
    throw new AppError("CHECKLIST_REQUIRED", 422);
  }
  if (!skipChecklist && validatedChecklist && !validatedChecklist.passed) {
    throw new AppError("CHECKLIST_NOT_PASSED", 422, undefined, { responseId: validatedChecklist.id });
  }
  const insertData: Record<string, unknown> = { ...parsed.data };
  // Canonical result code on write (win / loss / be / open), never a synonym (ARCHITECTURE.md §3.5).
  if (typeof insertData.result === "string") insertData.result = normResult(insertData.result) ?? insertData.result;
  if (insertData.screenshotUrl !== undefined) insertData.screenshotUrl = sanitizeMultiLineUrls(insertData.screenshotUrl as string | null | undefined);
  const auth = req.authUser;
  if (auth && !insertData.trader) {
    insertData.trader = auth.name;
  } else if (auth && !(await can(req, "trades.write.any", { trader: insertData.trader as string }))) {
    // Without the "write any" capability a trade is always booked under the caller's own name.
    insertData.trader = auth.name;
  }
  const [trade] = await db.insert(tradesTable).values(insertData as any).returning();
  if (validatedChecklist) {
    await db.update(preTradeChecklistResponsesTable)
      .set({ tradeId: trade.id })
      .where(eq(preTradeChecklistResponsesTable.id, validatedChecklist.id));
  }
  captureAndAttach(trade.id, {
    tradeDate: trade.date,
    sector: trade.sector ?? null,
    ticker: trade.ticker,
    session: trade.session ?? null,
  }).catch(() => {});
  maybeAutoGenerateReview({ tradeId: trade.id, result: trade.result, trader: trade.trader });
  logActivity({ action: "created", section: "trades", entityId: String(trade.id), entityTitle: trade.ticker, trader: trade.trader ?? undefined, details: `${trade.side ?? ""} ${trade.result} ${trade.pnl ? "$" + trade.pnl : ""}`.trim() });
  if (trade.trader) {
    scanRulesForTrader(trade.trader).catch((e) => req.log.warn({ err: e instanceof Error ? e.message : String(e) }, "rules engine scan failed"));
  }
  invalidateDashboardCache();
  res.status(201).json(GetTradeResponse.parse(toTradeResponseShape(trade)));
}));

router.get("/trades/:id", asyncHandler(async (req, res): Promise<void> => {
  const params = GetTradeParams.safeParse(req.params);
  if (!params.success) {
    throw params.error;
  }
  const [trade] = await db.select().from(tradesTable).where(and(eq(tradesTable.id, params.data.id), isNull(tradesTable.deletedAt)));
  if (!trade) {
    throw notFound("TRADE_NOT_FOUND");
  }
  // Another trader's trade: via the matrix (trades.read.team), or because it is an example of a setup the viewer
  // reads (the playbook's «Открыть сделку»). Either way a non-staff viewer gets its $ redacted.
  if (await forbiddenFor(req, "trades.read.team", trade.trader ?? null) && !(await isReadableExampleTrade(req, trade.id))) throw new AppError("OWN_TRADES_ONLY");
  res.json(redactTradeRow(GetTradeResponse.parse(toTradeResponseShape(trade)), await loadMoneyViewer(req)));
}));

router.patch("/trades/:id", asyncHandler(async (req, res): Promise<void> => {
  const params = UpdateTradeParams.safeParse(req.params);
  if (!params.success) {
    throw params.error;
  }
  const parsed = UpdateTradeBody.safeParse(req.body);
  if (!parsed.success) {
    throw parsed.error;
  }
  const skipChecklist = req.query.skipChecklist === "true" || req.body?.skipChecklist === true;
  const ENTRY_DECISION_FIELDS = ["ticker", "date", "side", "setup", "entry", "stop", "eventType"] as const;
  const touchesEntryDecision = ENTRY_DECISION_FIELDS.some((f) => Object.prototype.hasOwnProperty.call(req.body ?? {}, f));
  const [existing] = await db
    .select({ id: tradesTable.id, ticker: tradesTable.ticker, date: tradesTable.date, trader: tradesTable.trader, source: tradesTable.source })
    .from(tradesTable)
    .where(eq(tradesTable.id, params.data.id));
  if (!existing) {
    throw notFound("TRADE_NOT_FOUND");
  }
  if (await forbiddenFor(req, "trades.write.any", existing.trader)) throw new AppError("OWN_TRADES_ONLY");
  // Broker-imported trades: the entry already happened at the broker, a pre-trade checklist cannot be filled in
  // retroactively. Post-hoc classification (setup / event type / a reference stop for R) is review, not an entry
  // decision — same as setups-auto/accept, which writes trades.setup directly. Broker-owned fields still go through the gate.
  const POST_HOC_FIELDS = new Set(["setup", "eventType", "stop"]);
  const importedPostHoc = existing.source === "propreports"
    && ENTRY_DECISION_FIELDS.every((f) => !Object.prototype.hasOwnProperty.call(req.body ?? {}, f) || POST_HOC_FIELDS.has(f));
  if (touchesEntryDecision && !skipChecklist && !importedPostHoc) {
    const [linked] = await db
      .select({ id: preTradeChecklistResponsesTable.id, passed: preTradeChecklistResponsesTable.passed })
      .from(preTradeChecklistResponsesTable)
      .where(eq(preTradeChecklistResponsesTable.tradeId, existing.id))
      .limit(1);
    const effective = linked
      ?? (await findChecklistResponseFor({
        ticker: existing.ticker,
        tradeDate: existing.date,
        trader: existing.trader ?? null,
      }));
    if (!effective) {
      throw new AppError("CHECKLIST_REQUIRED", 422);
    }
    if (!effective.passed) {
      throw new AppError("CHECKLIST_NOT_PASSED", 422, undefined, { responseId: effective.id });
    }
  }
  const updateData: Record<string, unknown> = { ...parsed.data };
  if (typeof updateData.result === "string") updateData.result = normResult(updateData.result) ?? updateData.result;
  // Reassigning a trade to another trader needs the "write any" capability.
  if (!(await can(req, "trades.write.any", { trader: (updateData.trader as string | null | undefined) ?? existing.trader }))) delete updateData.trader;
  if (updateData.screenshotUrl !== undefined) updateData.screenshotUrl = sanitizeMultiLineUrls(updateData.screenshotUrl as string | null | undefined);
  const [trade] = await db
    .update(tradesTable)
    .set(updateData)
    .where(eq(tradesTable.id, params.data.id))
    .returning();
  if (!trade) {
    throw notFound("TRADE_NOT_FOUND");
  }
  const dateChanged = Object.prototype.hasOwnProperty.call(req.body ?? {}, "date");
  const sectorChanged = Object.prototype.hasOwnProperty.call(req.body ?? {}, "sector");
  const sessionChanged = Object.prototype.hasOwnProperty.call(req.body ?? {}, "session");
  if (dateChanged || sectorChanged || sessionChanged || !trade.contextSnapshot) {
    captureAndAttach(trade.id, {
      tradeDate: trade.date,
      sector: trade.sector ?? null,
      ticker: trade.ticker,
      session: trade.session ?? null,
    }).catch(() => {});
  }
  const resultChanged = Object.prototype.hasOwnProperty.call(req.body ?? {}, "result");
  if (resultChanged) {
    maybeAutoGenerateReview({ tradeId: trade.id, result: trade.result, trader: trade.trader });
  }
  // Stop / risk / side / symbol / day feed the fill roles (Стоп, Перезаход …) — recompute in the background.
  if (["stop", "riskUsd", "side", "ticker", "date", "qty"].some((f) => Object.prototype.hasOwnProperty.call(req.body ?? {}, f))) {
    void refreshTradeStructures([trade.id]).catch((e) => logger.warn({ err: e instanceof Error ? e.message : String(e), tradeId: trade.id }, "trade structure refresh failed"));
  }
  logActivity({ action: "updated", section: "trades", entityId: String(trade.id), entityTitle: trade.ticker, trader: trade.trader ?? undefined });
  invalidateDashboardCache();
  res.json(UpdateTradeResponse.parse(toTradeResponseShape(trade)));
}));

router.delete("/trades/:id", asyncHandler(async (req, res): Promise<void> => {
  const params = DeleteTradeParams.safeParse(req.params);
  if (!params.success) {
    throw params.error;
  }
  const [owner] = await db.select({ trader: tradesTable.trader }).from(tradesTable).where(eq(tradesTable.id, params.data.id));
  if (owner && (await forbiddenFor(req, "trades.write.any", owner.trader))) throw new AppError("OWN_TRADES_ONLY");
  const [trade] = await db
    .update(tradesTable)
    .set({ deletedAt: new Date() })
    .where(eq(tradesTable.id, params.data.id))
    .returning();
  if (!trade) {
    throw notFound("TRADE_NOT_FOUND");
  }
  logActivity({ action: "deleted", section: "trades", entityId: String(trade.id), entityTitle: trade.ticker, trader: trade.trader ?? undefined });
  invalidateDashboardCache();
  res.sendStatus(204);
}));

router.post("/trades/:id/restore", asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("INVALID_ID");
  const [owner] = await db.select({ trader: tradesTable.trader }).from(tradesTable).where(eq(tradesTable.id, id));
  if (owner && (await forbiddenFor(req, "trades.write.any", owner.trader))) throw new AppError("OWN_TRADES_ONLY");
  const [trade] = await db
    .update(tradesTable)
    .set({ deletedAt: null })
    .where(eq(tradesTable.id, id))
    .returning();
  if (!trade) throw notFound("TRADE_NOT_FOUND");
  logActivity({ action: "created", section: "trades", entityId: String(trade.id), entityTitle: activityTitle("trade_restored", { ticker: trade.ticker }), trader: trade.trader ?? undefined, params: { titleKey: "trade_restored", ticker: trade.ticker } });
  invalidateDashboardCache();
  res.json({ success: true });
}));

// ── Bulk actions ────────────────────────────────────────────────────────────
// POST /trades/bulk { action, ids, tags?, result? }
// Traders only affect their own trades (others are counted as `forbidden`).
// setResult intentionally does not trigger AI auto-review (bulk would fan out).
// setSetup — post-hoc setup classification (review), like setups-auto/accept: no pre-trade checklist gate.
const BULK_ACTIONS = ["delete", "restore", "addTags", "removeTags", "setResult", "setSetup"] as const;
type BulkAction = (typeof BULK_ACTIONS)[number];
const BULK_RESULTS = ["win", "loss", "breakeven", "open"] as const;
const BULK_MAX_IDS = 500;

function splitTags(s: string | null | undefined): string[] {
  return (s ?? "").split(",").map((t) => t.trim()).filter(Boolean);
}

router.post("/trades/bulk", asyncHandler(async (req, res): Promise<void> => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const action = b.action as BulkAction;
  if (typeof action !== "string" || !(BULK_ACTIONS as readonly string[]).includes(action)) throw new AppError("INVALID_FIELD", undefined, { field: "action" });
  const ids = Array.isArray(b.ids)
    ? Array.from(new Set(b.ids.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0)))
    : [];
  if (ids.length === 0 || ids.length > BULK_MAX_IDS) throw new AppError("TOO_MANY", undefined, { field: "ids", max: BULK_MAX_IDS });
  let tags: string[] = [];
  if (action === "addTags" || action === "removeTags") {
    tags = Array.isArray(b.tags)
      ? Array.from(new Set(b.tags.filter((t): t is string => typeof t === "string").map((t) => t.replace(/,/g, " ").trim().slice(0, 40)).filter(Boolean)))
      : [];
    if (tags.length === 0 || tags.length > 20) throw new AppError("INVALID_FIELD", undefined, { field: "tags" });
  }
  let result: string | null = null;
  if (action === "setResult") {
    if (typeof b.result !== "string" || !(BULK_RESULTS as readonly string[]).includes(b.result)) throw new AppError("INVALID_FIELD", undefined, { field: "result" });
    result = b.result;
  }
  let setup: string | null = null;
  if (action === "setSetup") {
    if (b.setup !== null && (typeof b.setup !== "string" || b.setup.trim().length > 120)) throw new AppError("INVALID_FIELD", undefined, { field: "setup" });
    setup = typeof b.setup === "string" && b.setup.trim() ? b.setup.trim() : null;
  }

  const rows = await db
    .select({ id: tradesTable.id, trader: tradesTable.trader, tags: tradesTable.tags, deletedAt: tradesTable.deletedAt })
    .from(tradesTable)
    .where(inArray(tradesTable.id, ids));
  // One matrix check per distinct owner (bulk actions are writes; "setResult"/tags/delete/restore alike).
  const ownerOk = new Map<string | null, boolean>();
  for (const owner of new Set(rows.map((r) => r.trader ?? null))) ownerOk.set(owner, !(await forbiddenFor(req, "trades.write.any", owner)));
  const allowed = rows.filter((r) => ownerOk.get(r.trader ?? null));
  const forbidden = rows.length - allowed.length;
  const targets = action === "restore" ? allowed.filter((r) => r.deletedAt) : allowed.filter((r) => !r.deletedAt);
  const targetIds = targets.map((r) => r.id);

  if (targetIds.length > 0) {
    if (action === "delete") {
      await db.update(tradesTable).set({ deletedAt: new Date() }).where(inArray(tradesTable.id, targetIds));
    } else if (action === "restore") {
      await db.update(tradesTable).set({ deletedAt: null }).where(inArray(tradesTable.id, targetIds));
    } else if (action === "setResult" && result) {
      await db.update(tradesTable).set({ result }).where(inArray(tradesTable.id, targetIds));
    } else if (action === "setSetup") {
      await db.update(tradesTable).set({ setup }).where(inArray(tradesTable.id, targetIds));
    } else {
      const lower = new Set(tags.map((t) => t.toLowerCase()));
      for (const r of targets) {
        const cur = splitTags(r.tags);
        const next = action === "addTags"
          ? [...cur, ...tags.filter((t) => !cur.some((c) => c.toLowerCase() === t.toLowerCase()))]
          : cur.filter((c) => !lower.has(c.toLowerCase()));
        if (next.join(", ") === cur.join(", ")) continue;
        await db.update(tradesTable).set({ tags: next.length ? next.join(", ") : null }).where(eq(tradesTable.id, r.id));
      }
    }
    logActivity({
      action: action === "delete" ? "deleted" : action === "restore" ? "created" : "updated",
      section: "trades",
      entityId: targetIds.join(","),
      entityTitle: activityTitle("trades_bulk", { count: targetIds.length }),
      params: { titleKey: "trades_bulk", count: targetIds.length },
      trader: req.authUser?.name,
      details: action === "setResult" ? `result=${result}` : action === "setSetup" ? `setup=${setup ?? "—"}` : tags.length ? `${action}: ${tags.join(", ")}` : action,
    });
    invalidateDashboardCache();
  }
  res.json({ action, updated: targetIds, skipped: ids.length - targetIds.length - forbidden, forbidden });
}));

export default router;
