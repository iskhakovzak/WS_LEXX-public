import { Router, type IRouter, type Request } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { can, requireCap } from "../lib/permissions";
import { logger } from "../lib/logger";
import { nyDate, addDays, isWeekend } from "../lib/tradingDate";
import { signedRSql, netPnlSql, closeDateSql, horizonSql, resultSql } from "../lib/tradeMath";
import { notifyUser, notifyUsers } from "../lib/notifyUtils";
import { notifLinks } from "../lib/notificationCore";
import { inBackground, staffOrFallback } from "../lib/notifyEvents";
import { preview as textPreview } from "../lib/notifyEventsCore";
import { activeViolationSql, archiveReasonLabel, isArchiveReason, reportArchiveSql } from "../lib/violationArchive";
import { AppError, notFound, unauthorized } from "../lib/http";
import { langOf, type Lang } from "../i18n";
import { riskT } from "../i18n/ns";
import { violationMessage } from "../lib/rulesI18n";

/**
 * «Отчёт недели 1:1» — the weekly trader ↔ curator review document.
 *
 *   GET   /api/weekly-review?trader=&week=YYYY-Www      one aggregate payload for the memo (single round-trip)
 *   GET   /api/weekly-review/overview?week=YYYY-Www     curator/admin: every trader for the week (status + key numbers,
 *                                                       risk status vs limits, gross/fees/PF, curator note — «Партнёрам»)
 *   PUT   /api/weekly-review/self                       trader's self-assessment (own week only); submit=true ⇒ status submitted
 *   PUT   /api/weekly-review/curator                    curator/admin: comment + score + 1–3 goals ⇒ status reviewed
 *   PATCH /api/weekly-review/goals                      owner or staff: done / partial / missed on a week's goals
 *
 * Trading week = Mon–Fri in America/New_York; trades are bucketed by close date (exit date for multi-day holds).
 * All R / net P&L / result math comes from lib/tradeMath (shared with the client).
 */
const router: IRouter = Router();

// ── Table ─────────────────────────────────────────────────────────────────────
let ensured: Promise<void> | null = null;
function ensureTables(): Promise<void> {
  if (!ensured) {
    ensured = pool
      .query(
        `CREATE TABLE IF NOT EXISTS weekly_reviews (
           id SERIAL PRIMARY KEY,
           trader TEXT NOT NULL,
           week TEXT NOT NULL,
           week_start DATE NOT NULL,
           self_review JSONB NOT NULL DEFAULT '{}'::jsonb,
           curator_review JSONB NOT NULL DEFAULT '{}'::jsonb,
           goals JSONB NOT NULL DEFAULT '[]'::jsonb,
           status TEXT NOT NULL DEFAULT 'draft',
           submitted_at TIMESTAMPTZ,
           reviewed_at TIMESTAMPTZ,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           UNIQUE (trader, week)
         );
         CREATE INDEX IF NOT EXISTS weekly_reviews_week_idx ON weekly_reviews(week);`,
      )
      .then(() => undefined)
      .catch((err) => {
        ensured = null;
        throw err;
      });
  }
  return ensured;
}
ensureTables().catch((err) => logger.warn({ err }, "weekly-review: ensure tables failed at init"));

// ── Week helpers (ISO weeks, UTC calendar maths on YYYY-MM-DD strings) ────────
const WEEK_RE = /^(\d{4})-W(\d{2})$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "YYYY-Www" for the ISO week containing the date. */
export function weekKeyOf(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // Mon = 0
  d.setUTCDate(d.getUTCDate() - day + 3); // Thursday of this week decides the year
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Monday of an ISO week key, or null when the key is malformed. */
export function weekStartOf(key: string): string | null {
  const m = WEEK_RE.exec(key);
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (week - 1) * 7);
  const start = monday.toISOString().slice(0, 10);
  return weekKeyOf(start) === key ? start : null;
}

export type WeekBounds = { key: string; start: string; end: string; prevKey: string; nextKey: string };

export function weekBounds(key: string): WeekBounds | null {
  const start = weekStartOf(key);
  if (!start) return null;
  return {
    key,
    start,
    end: addDays(start, 4),
    prevKey: weekKeyOf(addDays(start, -7)),
    nextKey: weekKeyOf(addDays(start, 7)),
  };
}

/** Accepts "YYYY-Www" or any "YYYY-MM-DD"; empty ⇒ the current New York trading week. */
function resolveWeek(raw: unknown): WeekBounds | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return weekBounds(weekKeyOf(nyDate()));
  if (WEEK_RE.test(s)) return weekBounds(s);
  if (YMD_RE.test(s) && !isNaN(Date.parse(`${s}T00:00:00Z`))) return weekBounds(weekKeyOf(s));
  return null;
}

// ── Auth ──────────────────────────────────────────────────────────────────────
// Access via the permissions matrix (lib/permissions.ts, DB role): journal.read.team to look at
// other traders' weeks, journal.review for the curator overview / curator notes / marking goals of others.

type Scope = { ok: true; trader: string; staff: boolean; me: string };

/** Traders see only themselves; curators/admins pick any trader (default: themselves). Throws 400 / 401 / 403. */
async function resolveScope(req: Request, claimed: unknown): Promise<Scope> {
  const auth = req.authUser;
  if (!auth) throw unauthorized();
  const name = typeof claimed === "string" ? claimed.trim() : "";
  if (name.length > 100) throw new AppError("INVALID_TRADER");
  const staff = await can(req, "journal.read.team", name && name !== auth.name ? { trader: name } : undefined);
  if (!staff && name && name !== auth.name) throw new AppError("WEEKLY_OWN_ONLY");
  return { ok: true, trader: name || auth.name, staff, me: auth.name };
}

// ── Pure aggregation (exported for the offline check) ─────────────────────────
export type WeekRow = {
  wk?: number;
  trades: number; wins: number; losses: number; be: number; open: number;
  r_sum: number | null; r_count: number; pos_r: number | null; neg_r: number | null; pos_n: number; neg_n: number;
  net: number | null; gross: number | null; fees: number | null; pnl_count: number;
  pos_net: number | null; neg_net: number | null;
};

export type DayRow = { date: string; trades: number; net: number | null; pnl_count: number; r: number | null; r_count: number; wins: number; losses: number };

export type Kpi = {
  trades: number; closed: number; wins: number; losses: number; be: number; open: number;
  winRate: number | null;
  totalR: number; rCount: number; expectancyR: number | null; profitFactorR: number | null;
  avgWinR: number | null; avgLossR: number | null;
  netPnl: number | null; grossPnl: number | null; fees: number; pnlCount: number;
  profitFactorUsd: number | null; expectancyUsd: number | null;
  unit: "usd" | "r";
  tradingDays: number; greenDays: number; redDays: number;
  bestDay: { date: string; value: number } | null;
  worstDay: { date: string; value: number } | null;
};

const n = (v: unknown): number => (v == null || v === "" || !Number.isFinite(Number(v)) ? 0 : Number(v));
const nn = (v: unknown): number | null => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export const EMPTY_WEEK: WeekRow = {
  trades: 0, wins: 0, losses: 0, be: 0, open: 0, r_sum: 0, r_count: 0, pos_r: 0, neg_r: 0, pos_n: 0, neg_n: 0,
  net: null, gross: null, fees: 0, pnl_count: 0, pos_net: 0, neg_net: 0,
};

/** Pool several weekly rows (sums; ratios recomputed from the pooled sums). `divisor` scales the count-like fields. */
export function poolWeeks(rows: WeekRow[]): WeekRow {
  const out: WeekRow = { ...EMPTY_WEEK };
  for (const w of rows) {
    out.trades += n(w.trades); out.wins += n(w.wins); out.losses += n(w.losses); out.be += n(w.be); out.open += n(w.open);
    out.r_sum = n(out.r_sum) + n(w.r_sum); out.r_count += n(w.r_count);
    out.pos_r = n(out.pos_r) + n(w.pos_r); out.neg_r = n(out.neg_r) + n(w.neg_r);
    out.pos_n += n(w.pos_n); out.neg_n += n(w.neg_n);
    out.pnl_count += n(w.pnl_count);
    if (w.pnl_count > 0) {
      out.net = n(out.net) + n(w.net); out.gross = n(out.gross) + n(w.gross);
      out.pos_net = n(out.pos_net) + n(w.pos_net); out.neg_net = n(out.neg_net) + n(w.neg_net);
    }
    out.fees = n(out.fees) + n(w.fees);
  }
  if (out.pnl_count === 0) { out.net = null; out.gross = null; }
  return out;
}

/** KPI object from one (possibly pooled) weekly row + its days. `scale` divides count-like totals (4-week average ⇒ 4). */
export function kpiOf(w: WeekRow, days: DayRow[], scale = 1): Kpi {
  const decided = w.wins + w.losses;
  const posR = n(w.pos_r), negR = n(w.neg_r);
  const posNet = n(w.pos_net), negNet = n(w.neg_net);
  const hasPnl = w.pnl_count > 0;
  const unit: Kpi["unit"] = hasPnl ? "usd" : "r";
  const valued = days
    .map((d) => ({ date: d.date, value: hasPnl ? (d.pnl_count > 0 ? n(d.net) : null) : d.r_count > 0 ? n(d.r) : null }))
    .filter((d): d is { date: string; value: number } => d.value != null);
  const best = valued.length ? valued.reduce((a, b) => (b.value > a.value ? b : a)) : null;
  const worst = valued.length ? valued.reduce((a, b) => (b.value < a.value ? b : a)) : null;
  const sc = (x: number) => (scale === 1 ? x : r2(x / scale));
  return {
    trades: sc(w.trades), closed: sc(w.wins + w.losses + w.be), wins: sc(w.wins), losses: sc(w.losses), be: sc(w.be), open: sc(w.open),
    winRate: decided ? r3(w.wins / decided) : null,
    totalR: sc(r2(n(w.r_sum))), rCount: sc(w.r_count),
    expectancyR: w.r_count ? r3(n(w.r_sum) / w.r_count) : null,
    profitFactorR: negR < 0 ? r2(posR / Math.abs(negR)) : null,
    avgWinR: n(w.pos_n) > 0 ? r2(posR / n(w.pos_n)) : null,
    avgLossR: n(w.neg_n) > 0 ? r2(negR / n(w.neg_n)) : null,
    netPnl: hasPnl ? sc(r2(n(w.net))) : null,
    grossPnl: hasPnl ? sc(r2(n(w.gross))) : null,
    fees: sc(r2(n(w.fees))), pnlCount: sc(w.pnl_count),
    profitFactorUsd: negNet < 0 ? r2(posNet / Math.abs(negNet)) : null,
    expectancyUsd: hasPnl && w.pnl_count ? r2(n(w.net) / w.pnl_count) : null,
    unit,
    tradingDays: sc(days.filter((d) => d.trades > 0).length),
    greenDays: sc(valued.filter((d) => d.value > 0).length),
    redDays: sc(valued.filter((d) => d.value < 0).length),
    bestDay: best ? { date: best.date, value: r2(best.value) } : null,
    worstDay: worst ? { date: worst.date, value: r2(worst.value) } : null,
  };
}

/** Consecutive weekdays ending at `end` (skipping back over a missing `end` once) found in `dates`. */
export function weekdayStreak(dates: Set<string>, end: string, maxDays = 120): number {
  let d = end;
  while (isWeekend(d)) d = addDays(d, -1);
  if (!dates.has(d)) d = addDays(d, -1);
  let count = 0;
  while (count < maxDays) {
    if (isWeekend(d)) { d = addDays(d, -1); continue; }
    if (!dates.has(d)) break;
    count++;
    d = addDays(d, -1);
  }
  return count;
}

/** Consecutive trading days (days with trades) ending at `end` without a mistake/violation. */
export function cleanStreak(tradeDays: string[], dirtyDays: Set<string>, end: string): number {
  const days = tradeDays.filter((d) => d <= end).sort();
  let count = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (dirtyDays.has(days[i])) break;
    count++;
  }
  return count;
}

export type RiskEvent = { date: string; kind: string; label: string; level: "warn" | "breach"; used: number; limit: number | null; pct: number | null; detail?: string };

export function riskEventsOf(
  days: DayRow[],
  weekNet: number | null,
  trades: Array<{ id: number; ticker: string; date: string; riskUsd: number | null; horizon: string }>,
  limits: { dailyLossLimit: number | null; weeklyLossLimit: number | null; maxRiskPerTrade: number | null; allowOvernight: boolean; allowSwing: boolean } | null,
  weekEnd: string,
  warnPct = 70,
  lang: Lang = "ru",
): RiskEvent[] {
  if (!limits) return [];
  const L = riskT.tFor(lang);
  const out: RiskEvent[] = [];
  const push = (date: string, kind: string, label: string, used: number, limit: number | null, detail?: string) => {
    if (limit == null || limit <= 0) return;
    const pct = Math.round((used / limit) * 1000) / 10;
    if (pct >= 100) out.push({ date, kind, label, level: "breach", used: r2(used), limit, pct, detail });
    else if (pct >= warnPct) out.push({ date, kind, label, level: "warn", used: r2(used), limit, pct, detail });
  };
  for (const d of days) {
    if (d.pnl_count > 0 && n(d.net) < 0) push(d.date, "daily", L("alerts.daily"), -n(d.net), limits.dailyLossLimit);
  }
  if (weekNet != null && weekNet < 0) push(weekEnd, "weekly", L("alerts.weekly"), -weekNet, limits.weeklyLossLimit);
  for (const t of trades) {
    if (t.riskUsd != null) push(t.date, "trade_risk", L("alerts.trade_risk"), t.riskUsd, limits.maxRiskPerTrade, t.ticker);
    if (!limits.allowOvernight && t.horizon === "overnight") out.push({ date: t.date, kind: "overnight_not_allowed", label: L("alerts.overnight_not_allowed"), level: "breach", used: 1, limit: 0, pct: null, detail: t.ticker });
    if (!limits.allowSwing && t.horizon === "swing") out.push({ date: t.date, kind: "swing_not_allowed", label: L("alerts.swing_not_allowed"), level: "breach", used: 1, limit: 0, pct: null, detail: t.ticker });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.level === b.level ? 0 : a.level === "breach" ? -1 : 1));
}

// ── SQL ───────────────────────────────────────────────────────────────────────
const CLOSE = closeDateSql("t");
const CDATE = `LEFT(${CLOSE}, 10)`;
const DATE_OK = `${CLOSE} ~ '^\\d{4}-\\d{2}-\\d{2}'`;

/** Per-trade base rows for one trader in [$2, $3] by close date. */
const BASE = `
  SELECT t.id, t.ticker, LEFT(t.date, 10) AS date, ${CDATE} AS cdate, t.setup, t.side, t.playbook_id,
         ${horizonSql("t")} AS horizon, ${resultSql("t")} AS res,
         ${signedRSql("t")}::float AS r, ${netPnlSql("t")}::float AS net, t.pnl::float AS gross,
         ABS(COALESCE(t.fees, 0))::float AS fees, t.risk_usd::float AS risk_usd, t.qty::float AS qty,
         t.entry::float AS entry, t.exit::float AS exit, t.stop::float AS stop, NULLIF(t.exit_date, '') AS exit_date
    FROM trades t
   WHERE t.trader = $1 AND t.deleted_at IS NULL AND ${DATE_OK} AND ${CDATE} BETWEEN $2 AND $3`;

const AGG = `
  COUNT(*)::int AS trades,
  COUNT(*) FILTER (WHERE res = 'win')::int AS wins,
  COUNT(*) FILTER (WHERE res = 'loss')::int AS losses,
  COUNT(*) FILTER (WHERE res = 'be')::int AS be,
  COUNT(*) FILTER (WHERE res = 'open')::int AS open,
  SUM(r) FILTER (WHERE res <> 'open')::float AS r_sum,
  COUNT(r) FILTER (WHERE res <> 'open')::int AS r_count,
  SUM(r) FILTER (WHERE r > 0)::float AS pos_r,
  SUM(r) FILTER (WHERE r < 0)::float AS neg_r,
  COUNT(r) FILTER (WHERE r > 0)::int AS pos_n,
  COUNT(r) FILTER (WHERE r < 0)::int AS neg_n,
  SUM(net)::float AS net, SUM(gross)::float AS gross, SUM(fees)::float AS fees, COUNT(net)::int AS pnl_count,
  SUM(net) FILTER (WHERE net > 0)::float AS pos_net,
  SUM(net) FILTER (WHERE net < 0)::float AS neg_net`;

type TradeLite = {
  id: number; ticker: string; date: string; cdate: string; setup: string | null; side: string | null; playbookId: number | null;
  horizon: "intraday" | "overnight" | "swing"; result: string | null; r: number | null; net: number | null; gross: number | null;
  fees: number; riskUsd: number | null; qty: number | null; entry: number | null; exit: number | null; stop: number | null;
};

function toTradeLite(x: any): TradeLite {
  return {
    id: Number(x.id), ticker: String(x.ticker ?? ""), date: String(x.date ?? ""), cdate: String(x.cdate ?? ""),
    setup: x.setup ?? null, side: x.side ?? null, playbookId: x.playbook_id == null ? null : Number(x.playbook_id),
    horizon: x.horizon === "overnight" || x.horizon === "swing" ? x.horizon : "intraday",
    result: x.res ?? null, r: nn(x.r), net: nn(x.net), gross: nn(x.gross), fees: n(x.fees),
    riskUsd: nn(x.risk_usd), qty: nn(x.qty), entry: nn(x.entry), exit: nn(x.exit), stop: nn(x.stop),
  };
}

type Goal = { id: string; text: string; status: "open" | "done" | "partial" | "missed"; by: string; createdAt: string; statusBy?: string; statusAt?: string };

const REVIEW_COLS = `id, trader, week, TO_CHAR(week_start, 'YYYY-MM-DD') AS "weekStart", self_review AS "selfReview",
  curator_review AS "curatorReview", goals, status, submitted_at AS "submittedAt", reviewed_at AS "reviewedAt",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

function presentReview(row: any | undefined) {
  if (!row) return null;
  const iso = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
  return {
    id: Number(row.id), trader: String(row.trader), week: String(row.week), weekStart: String(row.weekStart),
    selfReview: row.selfReview ?? {}, curatorReview: row.curatorReview ?? {},
    goals: Array.isArray(row.goals) ? (row.goals as Goal[]) : [],
    status: String(row.status ?? "draft") as "draft" | "submitted" | "reviewed",
    submittedAt: iso(row.submittedAt), reviewedAt: iso(row.reviewedAt), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt),
  };
}

/** trader_risk_limits row → limits object (null when the curator has not set limits). */
function limitsOf(lim: any | undefined) {
  if (!lim) return null;
  return {
    accountSize: nn(lim.account_size), dailyLossLimit: nn(lim.daily_loss_limit), weeklyLossLimit: nn(lim.weekly_loss_limit),
    maxDrawdown: nn(lim.max_drawdown), maxRiskPerTrade: nn(lim.max_risk_per_trade), maxPositionUsd: nn(lim.max_position_usd),
    maxOvernightExposure: nn(lim.max_overnight_exposure), maxOpenPositions: lim.max_open_positions == null ? null : Number(lim.max_open_positions),
    allowOvernight: lim.allow_overnight !== false, allowSwing: lim.allow_swing !== false, tier: lim.tier ?? null,
  };
}

export type RiskStatus = "ok" | "warn" | "breach" | "none";

/** Week-level risk status for the desk overview: worst event level; "none" when no limits are set. */
export function riskSummaryOf(events: RiskEvent[], hasLimits: boolean, weeklyLossPct: number | null) {
  const breaches = events.filter((e) => e.level === "breach").length;
  const warns = events.length - breaches;
  const status: RiskStatus = !hasLimits ? "none" : breaches ? "breach" : warns ? "warn" : "ok";
  return {
    status, breaches, warns, weeklyLossPct,
    events: events.slice(0, 3).map((e) => ({ date: e.date, label: e.label, level: e.level, pct: e.pct, detail: e.detail ?? null })),
  };
}

// ── GET /weekly-review ────────────────────────────────────────────────────────
router.get("/weekly-review", asyncHandler(async (req, res): Promise<void> => {
  const scope = await resolveScope(req, req.query.trader);
  const week = resolveWeek(req.query.week);
  if (!week) throw new AppError("INVALID_WEEK");
  await ensureTables();

  const { trader } = scope;
  const from5 = addDays(week.start, -28); // 4 previous weeks + the current one
  const from12 = addDays(week.start, -84); // streak lookback
  const p3 = [trader, from5, week.end];
  const pw = [trader, week.start, week.end];

  // A past week's report keeps the violations of rules disabled / deleted since (flagged); the current week and all
  // discipline scores (dirty days → clean streak) read active violations only.
  const pastWeek = week.end < nyDate();
  const [weeks, days, byHorizon, bySetup, list, mistakes, violations, dirtyDays, journal, limitsRes, positions, reviews, ratings] = await Promise.all([
    pool.query(`SELECT ((cdate::date - $2::date) / 7)::int AS wk, ${AGG} FROM (${BASE}) b GROUP BY wk ORDER BY wk`, p3),
    pool.query(
      `SELECT cdate AS date, COUNT(*)::int AS trades, SUM(net)::float AS net, COUNT(net)::int AS pnl_count,
              SUM(r) FILTER (WHERE res <> 'open')::float AS r, COUNT(r) FILTER (WHERE res <> 'open')::int AS r_count,
              COUNT(*) FILTER (WHERE res = 'win')::int AS wins, COUNT(*) FILTER (WHERE res = 'loss')::int AS losses
         FROM (${BASE}) b GROUP BY cdate ORDER BY cdate`,
      p3,
    ),
    pool.query(`SELECT horizon, ${AGG} FROM (${BASE}) b GROUP BY horizon ORDER BY trades DESC`, pw),
    pool.query(`SELECT COALESCE(NULLIF(TRIM(setup), ''), '—') AS setup, MIN(playbook_id)::int AS playbook_id, ${AGG} FROM (${BASE}) b GROUP BY 1 ORDER BY trades DESC LIMIT 40`, pw),
    pool.query(`SELECT * FROM (${BASE}) b ORDER BY cdate, id LIMIT 1000`, pw),
    pool.query(
      `SELECT e.id, e.error_type AS "errorType", e.description, e.severity, e.lesson, e.resolved,
              COALESCE(e.ticker, t.ticker) AS ticker, e.trade_id AS "tradeId", LEFT(t.date, 10) AS "tradeDate",
              ${signedRSql("t")}::float AS "tradeR", ${netPnlSql("t")}::float AS "tradeNet", e.created_at AS "createdAt"
         FROM trading_errors e
         LEFT JOIN trades t ON t.id = e.trade_id AND t.deleted_at IS NULL
        WHERE e.trader = $1
          AND ((t.id IS NOT NULL AND ${DATE_OK} AND ${CDATE} BETWEEN $2 AND $3)
               OR (t.id IS NULL AND TO_CHAR(e.created_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') BETWEEN $2 AND $3))
        ORDER BY COALESCE(t.date, TO_CHAR(e.created_at, 'YYYY-MM-DD')) DESC, e.id DESC LIMIT 200`,
      pw,
    ),
    pool.query(
      `SELECT v.id, v.severity, v.message, v.details, v.trade_id AS "tradeId", v.occurred_at AS "occurredAt",
              r.name AS "ruleName", r.kind AS "ruleKind", t.ticker, LEFT(t.date, 10) AS "tradeDate",
              ${signedRSql("t")}::float AS "tradeR", ${netPnlSql("t")}::float AS "tradeNet",
              v.archived_reason AS "archivedReason"
         FROM rule_violations v
         LEFT JOIN trading_rules r ON r.id = v.rule_id
         LEFT JOIN trades t ON t.id = v.trade_id AND t.deleted_at IS NULL
        WHERE v.trader = $1 AND ${pastWeek ? reportArchiveSql("v") : activeViolationSql("v")}
          AND ((t.id IS NOT NULL AND ${DATE_OK} AND ${CDATE} BETWEEN $2 AND $3)
               OR (t.id IS NULL AND TO_CHAR(v.occurred_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') BETWEEN $2 AND $3))
        ORDER BY COALESCE(t.date, TO_CHAR(v.occurred_at, 'YYYY-MM-DD')) DESC, v.id DESC LIMIT 200`,
      pw,
    ),
    pool.query(
      `SELECT DISTINCT ${CDATE} AS d FROM trades t
        WHERE t.trader = $1 AND t.deleted_at IS NULL AND ${DATE_OK} AND ${CDATE} BETWEEN $2 AND $3
          AND (EXISTS (SELECT 1 FROM trading_errors e WHERE e.trade_id = t.id)
               OR EXISTS (SELECT 1 FROM rule_violations v WHERE v.trade_id = t.id AND ${activeViolationSql("v")}))`,
      [trader, from12, week.end],
    ),
    pool.query(
      `SELECT TO_CHAR(day, 'YYYY-MM-DD') AS date, mood, discipline, followed_plan AS "followedPlan",
              (LENGTH(plan) > 0) AS "hasPlan", (LENGTH(well) + LENGTH(mistakes) + LENGTH(lessons) > 0) AS "hasReview"
         FROM journal_days WHERE trader = $1 AND day BETWEEN $2::date AND $3::date ORDER BY day`,
      [trader, from12, week.end],
    ).catch(() => ({ rows: [] as any[] })),
    pool.query(`SELECT * FROM trader_risk_limits WHERE trader = $1 LIMIT 1`, [trader]).catch(() => ({ rows: [] as any[] })),
    pool.query(
      `SELECT t.id, t.ticker, LEFT(t.date, 10) AS date, t.side, t.setup, ${horizonSql("t")} AS horizon,
              t.qty::float AS qty, t.entry::float AS entry, t.stop::float AS stop, t.risk_usd::float AS risk_usd,
              NULLIF(t.exit_date, '') AS exit_date, ${resultSql("t")} AS res
         FROM trades t
        WHERE t.trader = $1 AND t.deleted_at IS NULL AND LEFT(t.date, 10) <= $2
          AND (LOWER(TRIM(t.result)) = 'open' OR LEFT(NULLIF(t.exit_date, ''), 10) > $2)
        ORDER BY t.date ASC, t.id ASC LIMIT 200`,
      [trader, week.end],
    ),
    pool.query(`SELECT ${REVIEW_COLS} FROM weekly_reviews WHERE trader = $1 AND week IN ($2, $3)`, [trader, week.key, week.prevKey]),
    pool.query(
      `SELECT id, curator, week, discipline, risk_management AS "riskManagement", execution, journaling, improvement, overall, comment, created_at AS "createdAt"
         FROM trader_ratings WHERE trader = $1 AND week = $2 ORDER BY created_at DESC`,
      [trader, week.start],
    ).catch(() => ({ rows: [] as any[] })),
  ]);

  // Weekly buckets: wk 0..3 = previous four weeks, wk 4 = the requested week.
  const byWk = new Map<number, WeekRow>();
  for (const r of weeks.rows as any[]) byWk.set(Number(r.wk), r as WeekRow);
  const allDays: DayRow[] = (days.rows as any[]).map((d) => ({
    date: String(d.date), trades: n(d.trades), net: nn(d.net), pnl_count: n(d.pnl_count), r: nn(d.r), r_count: n(d.r_count), wins: n(d.wins), losses: n(d.losses),
  }));
  const daysIn = (start: string, end: string) => allDays.filter((d) => d.date >= start && d.date <= end);
  const prevStart = addDays(week.start, -7);
  const cur = byWk.get(4) ?? EMPTY_WEEK;
  const prev = byWk.get(3) ?? EMPTY_WEEK;
  const prevWeeks = [0, 1, 2, 3].map((i) => byWk.get(i) ?? EMPTY_WEEK);
  const current = kpiOf(cur, daysIn(week.start, week.end));
  const previous = kpiOf(prev, daysIn(prevStart, addDays(prevStart, 4)));
  const avg4 = kpiOf(poolWeeks(prevWeeks), daysIn(from5, addDays(week.start, -1)), 4);
  const weeksWithTrades = prevWeeks.filter((w) => n(w.trades) > 0).length;

  // Mon–Fri day series for the chart (always five points).
  const weekDays = [0, 1, 2, 3, 4].map((i) => {
    const date = addDays(week.start, i);
    const d = allDays.find((x) => x.date === date);
    return { date, trades: d?.trades ?? 0, net: d?.pnl_count ? r2(n(d.net)) : null, r: d?.r_count ? r2(n(d.r)) : null, wins: d?.wins ?? 0, losses: d?.losses ?? 0 };
  });

  const trades = (list.rows as any[]).map(toTradeLite);
  const valued = trades.filter((t) => t.result && t.result !== "open" && (current.unit === "usd" ? t.net != null : t.r != null));
  const score = (t: TradeLite) => (current.unit === "usd" ? (t.net as number) : (t.r as number));
  const sortedDesc = [...valued].sort((a, b) => score(b) - score(a));
  const bestTrades = sortedDesc.filter((t) => score(t) > 0).slice(0, 3);
  const worstTrades = [...sortedDesc].reverse().filter((t) => score(t) < 0).slice(0, 3);

  const groupKpi = (rows: any[], keyField: string) =>
    rows.map((g) => ({ key: String(g[keyField]), playbookId: g.playbook_id == null ? null : Number(g.playbook_id), ...kpiOf(g as WeekRow, []) }));

  const mistakeRows = (mistakes.rows as any[]).map((m) => ({
    id: Number(m.id), errorType: String(m.errorType ?? ""), description: String(m.description ?? ""), severity: String(m.severity ?? "medium"),
    lesson: m.lesson ?? null, resolved: m.resolved === "yes", ticker: m.ticker ?? null, tradeId: m.tradeId == null ? null : Number(m.tradeId),
    tradeDate: m.tradeDate ?? null, tradeR: nn(m.tradeR), tradeNet: nn(m.tradeNet), createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : String(m.createdAt ?? ""),
  }));
  const violationRows = (violations.rows as any[]).map((v) => ({
    id: Number(v.id), severity: String(v.severity ?? "medium"), message: violationMessage(v.message, v.details, langOf(req)), ruleName: v.ruleName ?? null, ruleKind: v.ruleKind ?? null,
    ticker: v.ticker ?? null, tradeId: v.tradeId == null ? null : Number(v.tradeId), tradeDate: v.tradeDate ?? null, tradeR: nn(v.tradeR), tradeNet: nn(v.tradeNet),
    occurredAt: v.occurredAt instanceof Date ? v.occurredAt.toISOString() : String(v.occurredAt ?? ""),
    // Set only for violations of a rule disabled / deleted after the fact (past weeks) — shown with a muted badge.
    archivedReason: isArchiveReason(v.archivedReason) ? v.archivedReason : null,
    archivedLabel: archiveReasonLabel(v.archivedReason, langOf(req)),
  }));
  /** $ and R cost = losing part of the distinct trades linked to mistakes/violations. */
  const costOf = (rows: Array<{ tradeId: number | null; tradeR: number | null; tradeNet: number | null }>) => {
    const seen = new Set<number>();
    let usd = 0, r = 0, usdN = 0, rN = 0;
    for (const x of rows) {
      if (x.tradeId == null || seen.has(x.tradeId)) continue;
      seen.add(x.tradeId);
      if (x.tradeNet != null) { usdN++; if (x.tradeNet < 0) usd += x.tradeNet; }
      if (x.tradeR != null) { rN++; if (x.tradeR < 0) r += x.tradeR; }
    }
    return { trades: seen.size, usd: usdN ? r2(usd) : null, r: rN ? r2(r) : null };
  };

  // Discipline / journal
  const journalRows = journal.rows as any[];
  const journalDates = new Set(journalRows.map((j) => String(j.date)));
  const inWeek = journalRows.filter((j) => j.date >= week.start && j.date <= week.end);
  const avg = (xs: number[]) => (xs.length ? r2(xs.reduce((s, v) => s + v, 0) / xs.length) : null);
  const tradeDays = allDays.filter((d) => d.trades > 0).map((d) => d.date);
  const dirty = new Set((dirtyDays.rows as any[]).map((d) => String(d.d)));
  const dirtyInWeek = [...dirty].filter((d) => d >= week.start && d <= week.end).length;
  const discipline = {
    journalDays: inWeek.length,
    journalWithReview: inWeek.filter((j) => j.hasReview).length,
    journalWithPlan: inWeek.filter((j) => j.hasPlan).length,
    tradingDays: current.tradingDays,
    journalStreak: weekdayStreak(journalDates, week.end),
    cleanDays: Math.max(0, current.tradingDays - dirtyInWeek),
    cleanStreak: cleanStreak(tradeDays, dirty, week.end),
    avgMood: avg(inWeek.map((j) => nn(j.mood)).filter((v): v is number => v != null)),
    avgDiscipline: avg(inWeek.map((j) => nn(j.discipline)).filter((v): v is number => v != null)),
    followedPlanDays: inWeek.filter((j) => j.followedPlan === true).length,
    days: inWeek.map((j) => ({ date: String(j.date), mood: nn(j.mood), discipline: nn(j.discipline), followedPlan: j.followedPlan ?? null, hasReview: !!j.hasReview })),
  };

  // Risk
  const limits = limitsOf(limitsRes.rows[0]);
  const riskEvents = riskEventsOf(daysIn(week.start, week.end), current.netPnl, trades, limits, week.end, 70, langOf(req));
  const weeklyLossPct = limits?.weeklyLossLimit && current.netPnl != null && current.netPnl < 0 ? Math.round((-current.netPnl / limits.weeklyLossLimit) * 1000) / 10 : null;

  const openPositions = (positions.rows as any[]).map((p) => {
    const qty = nn(p.qty), entry = nn(p.entry), stop = nn(p.stop), planned = nn(p.risk_usd);
    const fromStop = entry != null && stop != null && qty != null ? Math.abs(entry - stop) * Math.abs(qty) : null;
    const date = String(p.date);
    const daysHeld = YMD_RE.test(date) ? Math.max(0, Math.round((Date.parse(`${week.end}T12:00:00Z`) - Date.parse(`${date}T12:00:00Z`)) / 86_400_000)) : 0;
    const horizon = p.horizon === "overnight" || p.horizon === "swing" ? p.horizon : "intraday";
    return {
      id: Number(p.id), ticker: String(p.ticker ?? ""), date, side: p.side ?? null, setup: p.setup ?? null, horizon,
      qty, entry, stop, daysHeld, stillOpen: p.res === "open", exitDate: p.exit_date ?? null,
      riskUsd: planned != null ? r2(Math.abs(planned)) : fromStop != null ? r2(fromStop) : null,
      exposureUsd: entry != null && qty != null ? r2(Math.abs(entry * qty)) : null,
    };
  });

  const reviewRows = reviews.rows as any[];
  const review = presentReview(reviewRows.find((r) => r.week === week.key));
  const prevReview = presentReview(reviewRows.find((r) => r.week === week.prevKey));

  res.json({
    trader,
    viewer: { name: scope.me, staff: scope.staff, isOwner: scope.me === trader },
    week: { ...week, isCurrent: week.key === weekKeyOf(nyDate()), today: nyDate() },
    kpis: { current, previous, avg4, avg4Weeks: weeksWithTrades },
    days: weekDays,
    byHorizon: groupKpi(byHorizon.rows as any[], "horizon"),
    bySetup: groupKpi(bySetup.rows as any[], "setup"),
    bestTrades,
    worstTrades,
    mistakes: { items: mistakeRows, cost: costOf(mistakeRows) },
    violations: { items: violationRows, cost: costOf(violationRows) },
    discipline,
    risk: { limits, events: riskEvents, weeklyLossPct },
    openPositions,
    ratings: (ratings.rows as any[]).map((r) => ({
      id: Number(r.id), curator: String(r.curator), overall: n(r.overall), discipline: n(r.discipline), riskManagement: n(r.riskManagement),
      execution: n(r.execution), journaling: n(r.journaling), improvement: n(r.improvement), comment: r.comment ?? null,
    })),
    review,
    prevReview,
    prevGoals: prevReview?.goals ?? [],
  });
}));

// ── GET /weekly-review/overview (staff) ───────────────────────────────────────
router.get("/weekly-review/overview", asyncHandler(async (req, res): Promise<void> => {
  if (!req.authUser) throw unauthorized();
  if (!(await requireCap(req, res, "journal.review", null, "STAFF_ONLY"))) return;
  const week = resolveWeek(req.query.week);
  if (!week) throw new AppError("INVALID_WEEK");
  await ensureTables();

  const ALL_BASE = `
    SELECT t.trader, ${resultSql("t")} AS res, ${signedRSql("t")}::float AS r, ${netPnlSql("t")}::float AS net,
           t.pnl::float AS gross, ABS(COALESCE(t.fees, 0))::float AS fees, ${CDATE} AS cdate, t.id,
           t.ticker, LEFT(t.date, 10) AS date, ${horizonSql("t")} AS horizon, t.risk_usd::float AS risk_usd
      FROM trades t
     WHERE t.trader IS NOT NULL AND t.trader <> '' AND t.deleted_at IS NULL AND ${DATE_OK} AND ${CDATE} BETWEEN $1 AND $2`;
  const [agg, users, reviewRows, mistakes, violations, journal, dailyRows, riskTradeRows, limitRows] = await Promise.all([
    pool.query(`SELECT trader, ${AGG}, COUNT(DISTINCT cdate)::int AS trading_days FROM (${ALL_BASE}) b GROUP BY trader`, [week.start, week.end]),
    pool.query(`SELECT name, role FROM users WHERE active = true AND COALESCE(banned, false) = false ORDER BY name`),
    pool.query(`SELECT ${REVIEW_COLS} FROM weekly_reviews WHERE week = $1`, [week.key]),
    pool.query(
      `SELECT e.trader, COUNT(*)::int AS cnt FROM trading_errors e
         LEFT JOIN trades t ON t.id = e.trade_id AND t.deleted_at IS NULL
        WHERE (t.id IS NOT NULL AND ${DATE_OK} AND ${CDATE} BETWEEN $1 AND $2)
           OR (t.id IS NULL AND TO_CHAR(e.created_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') BETWEEN $1 AND $2)
        GROUP BY e.trader`,
      [week.start, week.end],
    ),
    pool.query(
      `SELECT v.trader, COUNT(*)::int AS cnt FROM rule_violations v
         LEFT JOIN trades t ON t.id = v.trade_id AND t.deleted_at IS NULL
        WHERE ${activeViolationSql("v")} AND ((t.id IS NOT NULL AND ${DATE_OK} AND ${CDATE} BETWEEN $1 AND $2)
           OR (t.id IS NULL AND TO_CHAR(v.occurred_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') BETWEEN $1 AND $2))
        GROUP BY v.trader`,
      [week.start, week.end],
    ),
    pool.query(`SELECT trader, COUNT(*)::int AS cnt FROM journal_days WHERE day BETWEEN $1::date AND $2::date GROUP BY trader`, [week.start, week.end])
      .catch(() => ({ rows: [] as any[] })),
    // Week risk status per trader (same rules as the trader's memo): daily nets, limit-relevant trades, limits.
    pool.query(
      `SELECT trader, cdate AS date, COUNT(*)::int AS trades, SUM(net)::float AS net, COUNT(net)::int AS pnl_count
         FROM (${ALL_BASE}) b GROUP BY trader, cdate ORDER BY trader, cdate`,
      [week.start, week.end],
    ),
    pool.query(
      `SELECT trader, id, ticker, date, risk_usd, horizon FROM (${ALL_BASE}) b
        WHERE risk_usd IS NOT NULL OR horizon <> 'intraday' LIMIT 5000`,
      [week.start, week.end],
    ),
    pool.query(`SELECT * FROM trader_risk_limits`).catch(() => ({ rows: [] as any[] })),
  ]);

  const aggBy = new Map<string, any>((agg.rows as any[]).map((r) => [String(r.trader), r]));
  const revBy = new Map<string, any>((reviewRows.rows as any[]).map((r) => [String(r.trader), r]));
  const cnt = (rows: any[]) => new Map<string, number>(rows.map((r) => [String(r.trader), n(r.cnt)]));
  const mBy = cnt(mistakes.rows as any[]), vBy = cnt(violations.rows as any[]), jBy = cnt(journal.rows as any[]);
  const roleBy = new Map<string, string>((users.rows as any[]).map((u) => [String(u.name), String(u.role)]));
  function group<T>(rows: any[], map: (r: any) => T): Map<string, T[]> {
    const m = new Map<string, T[]>();
    for (const r of rows) { const k = String(r.trader); const l = m.get(k) ?? []; l.push(map(r)); m.set(k, l); }
    return m;
  }
  const daysBy = group<DayRow>(dailyRows.rows as any[], (d) => ({
    date: String(d.date), trades: n(d.trades), net: nn(d.net), pnl_count: n(d.pnl_count), r: null, r_count: 0, wins: 0, losses: 0,
  }));
  const riskTradesBy = group(riskTradeRows.rows as any[], (t) => ({
    id: Number(t.id), ticker: String(t.ticker ?? ""), date: String(t.date ?? ""), riskUsd: nn(t.risk_usd), horizon: String(t.horizon ?? "intraday"),
  }));
  const limitsBy = new Map<string, ReturnType<typeof limitsOf>>((limitRows.rows as any[]).map((l) => [String(l.trader), limitsOf(l)]));

  const names = new Set<string>();
  for (const [name, role] of roleBy) if (role === "trader") names.add(name);
  for (const name of aggBy.keys()) names.add(name);
  for (const name of revBy.keys()) names.add(name);

  const STATUS_ORDER: Record<string, number> = { submitted: 0, draft: 1, none: 2, reviewed: 3 };
  const traders = [...names].map((name) => {
    const a = aggBy.get(name);
    const k = a ? kpiOf(a as WeekRow, []) : kpiOf(EMPTY_WEEK, []);
    const rv = presentReview(revBy.get(name));
    const goals = rv?.goals ?? [];
    const lim = limitsBy.get(name) ?? null;
    const events = riskEventsOf(daysBy.get(name) ?? [], k.netPnl, riskTradesBy.get(name) ?? [], lim, week.end, 70, langOf(req));
    const weeklyLossPct = lim?.weeklyLossLimit && k.netPnl != null && k.netPnl < 0 ? Math.round((-k.netPnl / lim.weeklyLossLimit) * 1000) / 10 : null;
    return {
      trader: name,
      role: roleBy.get(name) ?? null,
      trades: k.trades, closed: k.closed, netPnl: k.netPnl, totalR: k.totalR, winRate: k.winRate, expectancyR: k.expectancyR, profitFactorR: k.profitFactorR,
      grossPnl: k.grossPnl, profitFactorUsd: k.profitFactorUsd,
      posNet: a && n(a.pnl_count) > 0 ? r2(n(a.pos_net)) : null,
      negNet: a && n(a.pnl_count) > 0 ? r2(n(a.neg_net)) : null,
      risk: riskSummaryOf(events, !!lim, weeklyLossPct),
      curatorComment: rv?.curatorReview?.comment ? textPreview(String(rv.curatorReview.comment), 160) : null,
      focus: rv?.selfReview?.focus ? textPreview(String(rv.selfReview.focus), 160) : null,
      fees: k.fees, unit: k.unit, tradingDays: a ? n(a.trading_days) : 0,
      mistakes: mBy.get(name) ?? 0, violations: vBy.get(name) ?? 0, journalDays: jBy.get(name) ?? 0,
      status: rv?.status ?? "none",
      selfDone: !!(rv && (rv.selfReview?.well || rv.selfReview?.badly || rv.selfReview?.focus)),
      curatorScore: rv?.curatorReview?.score ?? null,
      curatorBy: rv?.curatorReview?.by ?? null,
      goals: goals.length,
      goalsDone: goals.filter((g) => g.status === "done").length,
      submittedAt: rv?.submittedAt ?? null, reviewedAt: rv?.reviewedAt ?? null,
    };
  }).sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || b.trades - a.trades || a.trader.localeCompare(b.trader, "ru"));

  const sumN = (xs: Array<number | null>) => { const v = xs.filter((x): x is number => x != null); return v.length ? r2(v.reduce((s, x) => s + x, 0)) : null; };
  res.json({
    week: { ...week, isCurrent: week.key === weekKeyOf(nyDate()), today: nyDate() },
    summary: {
      traders: traders.length,
      active: traders.filter((t) => t.trades > 0).length,
      netPnl: sumN(traders.map((t) => t.netPnl)),
      grossPnl: sumN(traders.map((t) => t.grossPnl)),
      fees: r2(traders.reduce((s, t) => s + t.fees, 0)),
      posNet: sumN(traders.map((t) => t.posNet)),
      negNet: sumN(traders.map((t) => t.negNet)),
      riskBreaches: traders.filter((t) => t.risk.status === "breach").length,
      riskWarns: traders.filter((t) => t.risk.status === "warn").length,
      totalR: r2(traders.reduce((s, t) => s + t.totalR, 0)),
      trades: traders.reduce((s, t) => s + t.trades, 0),
      submitted: traders.filter((t) => t.status === "submitted").length,
      reviewed: traders.filter((t) => t.status === "reviewed").length,
      pending: traders.filter((t) => t.status !== "reviewed").length,
      mistakes: traders.reduce((s, t) => s + t.mistakes, 0),
      violations: traders.reduce((s, t) => s + t.violations, 0),
    },
    traders,
  });
}));

// ── Writes ────────────────────────────────────────────────────────────────────
const weekField = z.string().trim().regex(WEEK_RE, "week must be YYYY-Www");
const traderField = z.string().trim().min(1).max(100);
const longText = z.string().trim().max(6000).default("");

const SelfBody = z.object({
  trader: traderField.optional(),
  week: weekField,
  well: longText,
  badly: longText,
  focus: longText,
  lessons: longText,
  mood: z.number().int().min(1).max(5).nullable().optional(),
  submit: z.boolean().optional(),
});

const GoalInput = z.object({
  id: z.string().trim().max(40).optional(),
  text: z.string().trim().min(1).max(300),
});

const CuratorBody = z.object({
  trader: traderField,
  week: weekField,
  comment: longText,
  score: z.number().int().min(1).max(10).nullable().optional(),
  goals: z.array(GoalInput).max(3).default([]),
  finalize: z.boolean().optional(),
});

const GoalsStatusBody = z.object({
  trader: traderField.optional(),
  week: weekField,
  goals: z.array(z.object({ id: z.string().trim().min(1).max(40), status: z.enum(["open", "done", "partial", "missed"]) })).min(1).max(10),
});


async function loadReview(trader: string, week: string) {
  const { rows } = await pool.query(`SELECT ${REVIEW_COLS} FROM weekly_reviews WHERE trader = $1 AND week = $2 LIMIT 1`, [trader, week]);
  return presentReview(rows[0]);
}

router.put("/weekly-review/self", asyncHandler(async (req, res): Promise<void> => {
  const auth = req.authUser;
  if (!auth) throw unauthorized();
  const parsed = SelfBody.safeParse(req.body ?? {});
  if (!parsed.success) throw parsed.error;
  const b = parsed.data;
  const trader = b.trader ?? auth.name;
  // Self-assessment is personal: only the trader writes it (staff cannot fill it in on someone's behalf).
  if (trader !== auth.name) throw new AppError("SELF_REVIEW_TRADER_ONLY");
  const bounds = weekBounds(b.week);
  if (!bounds) throw new AppError("INVALID_WEEK");
  await ensureTables();
  const self = { well: b.well, badly: b.badly, focus: b.focus, lessons: b.lessons, mood: b.mood ?? null, updatedAt: new Date().toISOString() };
  const submit = b.submit === true;
  const before = submit ? await loadReview(trader, b.week) : null;
  const { rows } = await pool.query(
    `INSERT INTO weekly_reviews (trader, week, week_start, self_review, status, submitted_at)
     VALUES ($1, $2, $3::date, $4::jsonb, CASE WHEN $5 THEN 'submitted' ELSE 'draft' END, CASE WHEN $5 THEN NOW() END)
     ON CONFLICT (trader, week) DO UPDATE SET
       self_review = EXCLUDED.self_review,
       status = CASE WHEN weekly_reviews.status = 'reviewed' THEN 'reviewed' WHEN $5 THEN 'submitted' ELSE weekly_reviews.status END,
       submitted_at = CASE WHEN $5 AND weekly_reviews.submitted_at IS NULL THEN NOW() ELSE weekly_reviews.submitted_at END,
       updated_at = NOW()
     RETURNING ${REVIEW_COLS}`,
    [trader, b.week, bounds.start, JSON.stringify(self), submit],
  );
  // First submission of the week → the trader's assigned staff (fallback: every curator/admin).
  if (submit && !before?.submittedAt && before?.status !== "reviewed") {
    const week = b.week;
    inBackground("weekly-review.submit", async () => {
      await notifyUsers(await staffOrFallback(trader), {
        type: "weekly_review", actor: trader, source: "weekly-review",
        params: { variant: "submitted", week, trader, mood: b.mood ?? null, focus: b.focus ? textPreview(b.focus, 100) : null },
        link: notifLinks.weeklyReview({ trader, week }), entityType: "weekly_review", entityId: `${trader}:${week}`,
      }, trader);
    });
  }
  res.json(presentReview(rows[0]));
}));

router.put("/weekly-review/curator", asyncHandler(async (req, res): Promise<void> => {
  const auth = req.authUser;
  if (!auth) throw unauthorized();
  if (!(await requireCap(req, res, "journal.review", null, "STAFF_ONLY"))) return;
  const parsed = CuratorBody.safeParse(req.body ?? {});
  if (!parsed.success) throw parsed.error;
  const b = parsed.data;
  const bounds = weekBounds(b.week);
  if (!bounds) throw new AppError("INVALID_WEEK");
  const { rows: known } = await pool.query(`SELECT 1 FROM users WHERE name = $1 LIMIT 1`, [b.trader]);
  if (!known.length) throw notFound("TRADER_NOT_FOUND");
  await ensureTables();
  const existing = await loadReview(b.trader, b.week);
  const now = new Date().toISOString();
  // Keep ids/status of goals the curator kept (matched by id, else by text), so progress marks survive edits.
  const prevGoals = existing?.goals ?? [];
  const goals: Goal[] = b.goals.map((g, i) => {
    const match = prevGoals.find((p) => (g.id && p.id === g.id) || p.text === g.text);
    return match
      ? { ...match, text: g.text }
      : { id: `${Date.now().toString(36)}${i}${Math.random().toString(36).slice(2, 6)}`, text: g.text, status: "open", by: auth.name, createdAt: now };
  });
  const curator = { comment: b.comment, score: b.score ?? null, by: auth.name, updatedAt: now };
  const finalize = b.finalize !== false;
  const { rows } = await pool.query(
    `INSERT INTO weekly_reviews (trader, week, week_start, curator_review, goals, status, reviewed_at)
     VALUES ($1, $2, $3::date, $4::jsonb, $5::jsonb, CASE WHEN $6 THEN 'reviewed' ELSE 'draft' END, CASE WHEN $6 THEN NOW() END)
     ON CONFLICT (trader, week) DO UPDATE SET
       curator_review = EXCLUDED.curator_review,
       goals = EXCLUDED.goals,
       status = CASE WHEN $6 THEN 'reviewed' ELSE weekly_reviews.status END,
       reviewed_at = CASE WHEN $6 THEN NOW() ELSE weekly_reviews.reviewed_at END,
       updated_at = NOW()
     RETURNING ${REVIEW_COLS}`,
    [b.trader, b.week, bounds.start, JSON.stringify(curator), JSON.stringify(goals), finalize],
  );
  // Finalised → the trader (first time «разбор завершён», later saves «разбор обновлён»); never self-notify.
  if (finalize && b.trader !== auth.name) {
    const again = existing?.status === "reviewed";
    const actor = auth.name;
    const trader = b.trader;
    const week = b.week;
    inBackground("weekly-review.finalize", () => notifyUser({
      userName: trader, type: "weekly_review", actor, source: "weekly-review",
      params: {
        variant: again ? "updated" : "ready", week, actor, score: b.score ?? null, goals: goals.length,
        comment: b.comment ? textPreview(b.comment, 120) : null,
      },
      link: notifLinks.weeklyReview({ trader, week }), entityType: "weekly_review", entityId: `${trader}:${week}`,
    }));
  }
  res.json(presentReview(rows[0]));
}));

router.patch("/weekly-review/goals", asyncHandler(async (req, res): Promise<void> => {
  const auth = req.authUser;
  if (!auth) throw unauthorized();
  const parsed = GoalsStatusBody.safeParse(req.body ?? {});
  if (!parsed.success) throw parsed.error;
  const b = parsed.data;
  const trader = b.trader ?? auth.name;
  if (trader !== auth.name && !(await can(req, "journal.review", { trader }))) throw new AppError("GOALS_OWN_ONLY");
  await ensureTables();
  const existing = await loadReview(trader, b.week);
  if (!existing) throw new AppError("WEEKLY_NOT_FOUND");
  const now = new Date().toISOString();
  const byId = new Map(b.goals.map((g) => [g.id, g.status]));
  let touched = 0;
  const goals = existing.goals.map((g) => {
    const s = byId.get(g.id);
    if (!s || s === g.status) return g;
    touched++;
    return { ...g, status: s, statusBy: auth.name, statusAt: now };
  });
  if (!touched) { res.json(existing); return; }
  const { rows } = await pool.query(
    `UPDATE weekly_reviews SET goals = $3::jsonb, updated_at = NOW() WHERE trader = $1 AND week = $2 RETURNING ${REVIEW_COLS}`,
    [trader, b.week, JSON.stringify(goals)],
  );
  res.json(presentReview(rows[0]));
}));

export default router;
