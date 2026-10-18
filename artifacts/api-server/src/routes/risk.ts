/**
 * Risk desk v2: per-trader limits (trader_risk_limits) + live usage computed from trades.
 *
 *   GET  /risk/me                 caller's limits, today/week/drawdown usage, stop state, alerts, P&L source
 *   GET  /risk/desk               curator/admin: one row per trader + desk banner (red-day stops)
 *   GET  /risk/limits/:trader     self or curator/admin
 *   PUT  /risk/limits/:trader     curator/admin only (zod, upsert, sets updated_by, writes limit change log)
 *   GET  /risk/limits/:trader/history   limit change log
 *   GET  /risk/history            ?trader=&days=60 — daily net P&L, equity, drawdown, red-day streak
 *   GET  /risk/positions          ?trader= — open book with horizon / days held / $ at risk / exposure / sector / ATR
 *   GET  /risk/overnight          ?trader=&all=1 — overnight book (15:45 ET key): carried positions by trader,
 *                                 limits, sector/ATR from cache, Big7 catalysts in the holding window
 *   GET  /risk/alerts             ?trader=&days=14 — red-day stop / warn records (also mirrored to notifications)
 *   GET  /risk/check              ?riskUsd&exposureUsd&horizon&ticker — pre-trade check of a hypothetical position
 *
 * Risk processes (curator cabinet, additive):
 *   GET  /risk/templates          tiers as limit templates + per-trader drift from the template
 *   POST /risk/templates/apply    {items:[{trader,tierKey}], reason?} — apply a tier template (bulk), log + audit + notify
 *   GET  /risk/breaches           ?trader=&days=30 — breach records (risk_alert_log level=breach) with their «Разбор»
 *   POST /risk/breaches/:alertId/review      {reason, comment?, actions[], consequence} — upsert «Разбор нарушения»
 *   POST /risk/breach-reviews/:id/action     {actionId, status} — mark an agreed action done / dropped
 *   POST /risk/breach-reviews/:id/archive    soft delete of a review
 *   GET  /risk/summary            ?date= — daily risk summary for the curator (data only, nothing is sent)
 * Escalation: ≥70% → risk_warn (trader + staff); stop → risk_breach (trader + assigned staff, else every curator);
 * a 2nd breach day within 7 days → risk_repeat_breach to the head of desk (admins, else curators).
 *
 * Trading date = America/New_York (lib/tradingDate). `?date=YYYY-MM-DD` overrides for back-testing.
 * P&L source of truth: broker (PropReports) rows when a trader-day has any, else journal trades; each
 * number carries its `source`. Net = pnl − |fees| (lib/tradeMath), realised on COALESCE(exit_date, date).
 */
import { Router, type IRouter, type Request } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { nyDate, nyMinutes, addDays } from "../lib/tradingDate";
import { signedRSql, netPnlSql, closeDateSql, horizonSql } from "../lib/tradeMath";
import { can, requireAnyCap, requireCap, resolveTraderParam } from "../lib/permissions";
import { logger } from "../lib/logger";
import { assignedStaffOf, notifyUser } from "../lib/notifyUtils";
import { notifLinks } from "../lib/notificationCore";
import { claimOnce, inBackground, staffOrFallback } from "../lib/notifyEvents";
import { haltedStopText, limitsDiff, limitsDiffItems, limitsDiffParams, riskDedupKey, riskNotice, uniqueRecipients } from "../lib/notifyEventsCore";
import { logAudit } from "../lib/audit";
import { ensureCuratorTables, rowToBreachReview } from "../lib/curatorStore";
import {
  BREACH_CONSEQUENCE_KEYS, BREACH_REASON_KEYS, STAGE_TIER_KEYS,
  breachConsequences, breachReasons, breachStats, normalizeBreachActions, repeatBreachKey, stageLabel, templateDiff, type LimitDiff,
} from "../lib/curatorLogic";
import { applyTierTemplate, loadTierTemplates } from "./scaling";
import { badRequest, errorMessage, forbidden, notFound, unauthorized } from "../lib/http";
import { langOf, type Lang } from "../i18n";
import { riskT } from "../i18n/ns";

const router: IRouter = Router();

// ─── constants / helpers ────────────────────────────────────────────────────

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
export const WARN_PCT = 70;
/** Overnight-book key time: 15:45 ET (minutes since NY midnight). */
export const OVERNIGHT_KEY_MINUTES = 15 * 60 + 45;
const CLOSE_MINUTES = 16 * 60;

function clientDate(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  return YMD_RE.test(s) ? s : nyDate();
}

function daysBetween(a: string, b: string): number {
  const ms = new Date(`${b}T12:00:00Z`).getTime() - new Date(`${a}T12:00:00Z`).getTime();
  return Math.max(0, Math.round(ms / 86_400_000));
}

/** Monday of the week containing ymd. */
export function weekStart(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  const dow = d.getUTCDay(); // 0 = Sun
  return addDays(ymd, dow === 0 ? -6 : 1 - dow);
}

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};
export const round2 = (x: number) => Math.round(x * 100) / 100;

/** Whether "now" (NY) is past the overnight key time for the given trading date (false for other dates). */
function afterKeyTime(date: string, now = new Date()): boolean {
  return date === nyDate(now) && nyMinutes(now) >= OVERNIGHT_KEY_MINUTES;
}

// ─── tables (additive; created lazily on first request) ─────────────────────

let ensured: Promise<void> | null = null;
function ensureTables(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS risk_alert_log (
        id SERIAL PRIMARY KEY,
        trader TEXT NOT NULL,
        date TEXT NOT NULL,
        kind TEXT NOT NULL,
        level TEXT NOT NULL,
        used NUMERIC(14,2),
        "limit" NUMERIC(14,2),
        message TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (trader, date, kind)
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS trader_risk_limit_events (
        id SERIAL PRIMARY KEY,
        trader TEXT NOT NULL,
        before JSONB,
        after JSONB NOT NULL,
        reason TEXT,
        changed_by TEXT,
        changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await pool.query(`CREATE INDEX IF NOT EXISTS trader_risk_limit_events_trader_idx ON trader_risk_limit_events (trader, changed_at DESC)`);
    })().catch((e) => {
      ensured = null; // retry on next request
      throw e;
    });
  }
  return ensured;
}

/** Optional trades columns (PropReports contract). Detected once; SQL degrades gracefully without them. */
let colsPromise: Promise<Set<string>> | null = null;
function tradeColumns(): Promise<Set<string>> {
  if (!colsPromise) {
    colsPromise = pool
      .query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'trades'`)
      .then((r) => new Set(r.rows.map((x) => x.column_name)))
      .catch(() => { colsPromise = null; return new Set<string>(); });
  }
  return colsPromise;
}

async function brokerSql(): Promise<string> {
  const cols = await tradeColumns();
  const parts: string[] = [];
  if (cols.has("source")) parts.push(`t.source = 'propreports'`);
  if (cols.has("context_snapshot")) parts.push(`t.context_snapshot ->> 'source' = 'propreports'`);
  return parts.length ? `(${parts.join(" OR ")})` : "FALSE";
}

// ─── data access ────────────────────────────────────────────────────────────

export type Limits = {
  trader: string;
  accountSize: number | null;
  dailyLossLimit: number | null;
  weeklyLossLimit: number | null;
  maxDrawdown: number | null;
  maxRiskPerTrade: number | null;
  maxPositionUsd: number | null;
  maxOvernightExposure: number | null;
  maxOpenPositions: number | null;
  allowOvernight: boolean;
  allowSwing: boolean;
  tier: string | null;
  notes: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
};

function toLimits(r: any): Limits {
  return {
    trader: String(r.trader),
    accountSize: num(r.account_size),
    dailyLossLimit: num(r.daily_loss_limit),
    weeklyLossLimit: num(r.weekly_loss_limit),
    maxDrawdown: num(r.max_drawdown),
    maxRiskPerTrade: num(r.max_risk_per_trade),
    maxPositionUsd: num(r.max_position_usd),
    maxOvernightExposure: num(r.max_overnight_exposure),
    maxOpenPositions: r.max_open_positions == null ? null : Number(r.max_open_positions),
    allowOvernight: r.allow_overnight !== false,
    allowSwing: r.allow_swing !== false,
    tier: r.tier ?? null,
    notes: r.notes ?? null,
    updatedBy: r.updated_by ?? null,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  };
}

async function loadLimits(trader: string | null): Promise<Map<string, Limits>> {
  const { rows } = await pool
    .query(`SELECT * FROM trader_risk_limits WHERE ($1::text IS NULL OR trader = $1)`, [trader])
    .catch(() => ({ rows: [] as any[] }));
  return new Map(rows.map((r: any) => [String(r.trader), toLimits(r)]));
}

export type PnlSource = "propreports" | "journal" | null;
export type DayRow = {
  trader: string;
  date: string;
  /** Net P&L for the day from the resolved source (null when no $ data). */
  pnl: number | null;
  source: PnlSource;
  trades: number;
  brokerTrades: number;
  r: number;
  fees: number;
};

/**
 * Daily aggregates per trader, realised on close date. Broker rows win over journal rows for a day
 * (PropReports is the source of truth); journal numbers are used only on days with no broker data.
 */
async function loadDaily(trader: string | null, upTo: string): Promise<DayRow[]> {
  const broker = await brokerSql();
  const net = netPnlSql("t");
  const { rows } = await pool.query(
    `SELECT t.trader, LEFT(${closeDateSql("t")}, 10) AS d,
            SUM(${net}) FILTER (WHERE t.pnl IS NOT NULL AND LOWER(TRIM(t.result)) IS DISTINCT FROM 'open' AND NOT ${broker})::float AS journal_net,
            COUNT(*) FILTER (WHERE t.pnl IS NOT NULL AND LOWER(TRIM(t.result)) IS DISTINCT FROM 'open' AND NOT ${broker})::int AS journal_pnl_rows,
            SUM(${net}) FILTER (WHERE t.pnl IS NOT NULL AND LOWER(TRIM(t.result)) IS DISTINCT FROM 'open' AND ${broker})::float AS broker_net,
            COUNT(*) FILTER (WHERE t.pnl IS NOT NULL AND LOWER(TRIM(t.result)) IS DISTINCT FROM 'open' AND ${broker})::int AS broker_pnl_rows,
            COUNT(*) FILTER (WHERE ${broker})::int AS broker_trades,
            COALESCE(SUM(ABS(t.fees)) FILTER (WHERE ${broker}), 0)::float AS broker_fees,
            COALESCE(SUM(ABS(t.fees)) FILTER (WHERE NOT ${broker}), 0)::float AS journal_fees,
            COUNT(*)::int AS trades,
            COALESCE(SUM(${signedRSql("t")}), 0)::float AS r
     FROM trades t
     WHERE t.deleted_at IS NULL AND t.trader IS NOT NULL AND t.trader <> ''
       AND ($1::text IS NULL OR t.trader = $1)
       AND LEFT(${closeDateSql("t")}, 10) <= $2
     GROUP BY t.trader, LEFT(${closeDateSql("t")}, 10)
     ORDER BY d ASC`,
    [trader, upTo],
  );
  return rows.map((r: any) => resolveDay(r));
}

/** Pure: pick the day's P&L source (exported for the offline check). */
export function resolveDay(r: {
  trader: string; d: string; journal_net: unknown; journal_pnl_rows: unknown; broker_net: unknown; broker_pnl_rows: unknown;
  broker_trades: unknown; broker_fees: unknown; journal_fees: unknown; trades: unknown; r: unknown;
}): DayRow {
  const brokerTrades = Number(r.broker_trades) || 0;
  const brokerRows = Number(r.broker_pnl_rows) || 0;
  const journalRows = Number(r.journal_pnl_rows) || 0;
  const useBroker = brokerTrades > 0;
  const pnl = useBroker ? (brokerRows ? num(r.broker_net) : null) : journalRows ? num(r.journal_net) : null;
  return {
    trader: String(r.trader),
    date: String(r.d),
    pnl,
    source: useBroker ? "propreports" : pnl != null ? "journal" : null,
    trades: Number(r.trades) || 0,
    brokerTrades,
    r: Number(r.r) || 0,
    fees: useBroker ? Number(r.broker_fees) || 0 : Number(r.journal_fees) || 0,
  };
}

export type Horizon = "intraday" | "overnight" | "swing";
export type Position = {
  id: number;
  ticker: string;
  date: string;
  side: string | null;
  setup: string | null;
  trader: string;
  horizon: Horizon;
  qty: number | null;
  entry: number | null;
  stop: number | null;
  daysHeld: number;
  riskUsd: number | null;
  riskSource: "planned" | "stop" | null;
  /** Planned risk_usd disagrees with |entry−stop|×qty by >25% — the trader's stop moved or the plan is stale. */
  riskMismatch: boolean;
  plannedRiskUsd: number | null;
  stopRiskUsd: number | null;
  exposureUsd: number | null;
  /** Carried past its entry day (or explicitly overnight/swing) ⇒ gap risk. */
  carried: boolean;
  /** Will be in the overnight book tonight: carried, or still open after 15:45 ET today. */
  carriedTonight: boolean;
  /** result IS NULL and no exit — shown in the book with a "без статуса" flag. */
  noStatus: boolean;
  source: "propreports" | "manual";
  sector: string | null;
  /** 14-day ATR from ticker_data_cache (may be stale; the client refreshes it from quotes). */
  atr: number | null;
};

/** Pure: build a Position from a trades row (exported for the offline check). */
export function toPosition(p: any, today: string, afterKey: boolean): Position {
  const horizon: Horizon = p.horizon === "overnight" || p.horizon === "swing" ? p.horizon : "intraday";
  const qty = num(p.qty);
  const entry = num(p.entry);
  const stop = num(p.stop);
  const planned = num(p.risk_usd);
  const fromStop = entry != null && stop != null && qty != null ? Math.abs(entry - stop) * Math.abs(qty) : null;
  const date = String(p.date);
  const daysHeld = YMD_RE.test(date) ? daysBetween(date, today) : 0;
  const carried = horizon !== "intraday" || daysHeld > 0;
  const plannedAbs = planned != null ? Math.abs(planned) : null;
  const mismatch = plannedAbs != null && fromStop != null && Math.abs(plannedAbs - fromStop) > 0.25 * Math.max(plannedAbs, fromStop, 1);
  return {
    id: Number(p.id),
    ticker: String(p.ticker ?? ""),
    date,
    side: p.side ?? null,
    setup: p.setup ?? null,
    trader: String(p.trader),
    horizon,
    qty,
    entry,
    stop,
    daysHeld,
    // Prefer the live stop distance when it disagrees with a stale plan.
    riskUsd: mismatch && fromStop != null ? round2(fromStop) : plannedAbs != null ? round2(plannedAbs) : fromStop != null ? round2(fromStop) : null,
    riskSource: mismatch && fromStop != null ? "stop" : plannedAbs != null ? "planned" : fromStop != null ? "stop" : null,
    riskMismatch: mismatch,
    plannedRiskUsd: plannedAbs != null ? round2(plannedAbs) : null,
    stopRiskUsd: fromStop != null ? round2(fromStop) : null,
    exposureUsd: entry != null && qty != null ? round2(Math.abs(entry * qty)) : null,
    carried,
    carriedTonight: carried || afterKey,
    noStatus: !!p.no_status,
    source: p.is_broker ? "propreports" : "manual",
    sector: p.sector ?? null,
    atr: num(p.atr),
  };
}

async function loadPositions(trader: string | null, today: string): Promise<Position[]> {
  const broker = await brokerSql();
  const { rows } = await pool.query(
    `SELECT t.id, t.ticker, LEFT(t.date, 10) AS date, t.side, t.setup, t.trader,
            ${horizonSql("t")} AS horizon,
            t.qty::float AS qty, t.risk_usd::float AS risk_usd,
            t.entry::float AS entry, t.stop::float AS stop,
            (t.result IS NULL OR TRIM(t.result) = '') AS no_status,
            ${broker} AS is_broker,
            c.sector AS sector, c.atr::float AS atr
     FROM trades t
     LEFT JOIN ticker_data_cache c ON c.ticker = UPPER(t.ticker)
     WHERE t.deleted_at IS NULL
       AND (LOWER(TRIM(t.result)) = 'open' OR ((t.result IS NULL OR TRIM(t.result) = '') AND NULLIF(t.exit_date, '') IS NULL AND t.exit IS NULL))
       AND t.trader IS NOT NULL AND ($1::text IS NULL OR t.trader = $1)
     ORDER BY t.date ASC, t.id ASC
     LIMIT 500`,
    [trader],
  );
  const afterKey = afterKeyTime(today);
  return rows.map((p: any) => toPosition(p, today, afterKey));
}

// ─── metrics ────────────────────────────────────────────────────────────────

export type Alert = {
  kind: "daily" | "weekly" | "drawdown" | "overnight" | "positions" | "trade_risk" | "position_size" | "overnight_not_allowed" | "swing_not_allowed";
  label: string;
  level: "warn" | "breach";
  used: number;
  limit: number | null;
  pct: number | null;
  detail?: string;
  tradeId?: number;
};

export function pctOf(used: number, limit: number | null): number | null {
  if (limit == null || limit < 0) return null;
  if (limit === 0) return used > 0 ? 100 : 0; // explicit zero limit: anything is a breach
  return Math.round((used / limit) * 1000) / 10;
}

export type StopState = "ok" | "warn" | "stop" | "weekly" | "drawdown" | "no_limits";
export type Stop = {
  state: StopState;
  label: string;
  /** Russian one-liner with exact numbers, e.g. «осталось $120 до дневного стопа». */
  message: string;
  halted: boolean;
  dailyRemainingUsd: number | null;
  weeklyRemainingUsd: number | null;
  drawdownRemainingUsd: number | null;
  dailyPct: number | null;
  weeklyPct: number | null;
  drawdownPct: number | null;
};

const usd0 = (v: number) => `$${Math.round(Math.abs(v)).toLocaleString("en-US")}`;

/**
 * Pure red-day stop state machine (exported for the offline check).
 * Priority: max drawdown ≥100% → weekly ≥100% → daily ≥100% (stop) → any ≥70% (warn) → ok.
 */
export function computeStop(args: { todayLoss: number; weekLoss: number; currentDd: number; limits: Limits | null }, lang: Lang = "ru"): Stop {
  const { todayLoss, weekLoss, currentDd, limits: L } = args;
  const t = riskT.tFor(lang);
  const dailyPct = pctOf(todayLoss, L?.dailyLossLimit ?? null);
  const weeklyPct = pctOf(weekLoss, L?.weeklyLossLimit ?? null);
  const drawdownPct = pctOf(currentDd, L?.maxDrawdown ?? null);
  const rem = (limit: number | null | undefined, used: number) => (limit == null ? null : round2(Math.max(0, limit - used)));
  const base = {
    dailyRemainingUsd: rem(L?.dailyLossLimit, todayLoss),
    weeklyRemainingUsd: rem(L?.weeklyLossLimit, weekLoss),
    drawdownRemainingUsd: rem(L?.maxDrawdown, currentDd),
    dailyPct,
    weeklyPct,
    drawdownPct,
  };
  if (!L || (L.dailyLossLimit == null && L.weeklyLossLimit == null && L.maxDrawdown == null)) {
    return { ...base, state: "no_limits", label: t("stop.no_limits.label"), message: t("stop.no_limits.message"), halted: false };
  }
  if (drawdownPct != null && drawdownPct >= 100) {
    return { ...base, state: "drawdown", label: t("stop.drawdown.label"), halted: true,
      message: t("stop.drawdown.message", { used: usd0(currentDd), limit: usd0(L.maxDrawdown!) }) };
  }
  if (weeklyPct != null && weeklyPct >= 100) {
    return { ...base, state: "weekly", label: t("stop.weekly.label"), halted: true,
      message: t("stop.weekly.message", { used: usd0(weekLoss), limit: usd0(L.weeklyLossLimit!) }) };
  }
  if (dailyPct != null && dailyPct >= 100) {
    return { ...base, state: "stop", label: t("stop.stop.label"), halted: true,
      message: t("stop.stop.message", { used: usd0(todayLoss), limit: usd0(L.dailyLossLimit!) }) };
  }
  const worst = Math.max(dailyPct ?? -1, weeklyPct ?? -1, drawdownPct ?? -1);
  if (worst >= WARN_PCT) {
    const parts: string[] = [];
    if (dailyPct != null && dailyPct >= WARN_PCT) parts.push(t("stop.warn.daily", { left: usd0(base.dailyRemainingUsd ?? 0), pct: Math.round(dailyPct) }));
    if (weeklyPct != null && weeklyPct >= WARN_PCT) parts.push(t("stop.warn.weekly", { left: usd0(base.weeklyRemainingUsd ?? 0), pct: Math.round(weeklyPct) }));
    if (drawdownPct != null && drawdownPct >= WARN_PCT) parts.push(t("stop.warn.drawdown", { left: usd0(base.drawdownRemainingUsd ?? 0), pct: Math.round(drawdownPct) }));
    const msg = parts.join("; ");
    return { ...base, state: "warn", label: t("stop.warn.label"), halted: false, message: msg.charAt(0).toUpperCase() + msg.slice(1) + "." };
  }
  const msg = base.dailyRemainingUsd != null
    ? dailyPct != null
      ? t("stop.ok.dailyPct", { left: usd0(base.dailyRemainingUsd), pct: Math.round(dailyPct) })
      : t("stop.ok.daily", { left: usd0(base.dailyRemainingUsd) })
    : base.weeklyRemainingUsd != null
      ? t("stop.ok.weekly", { left: usd0(base.weeklyRemainingUsd) })
      : t("stop.ok.drawdown", { left: usd0(base.drawdownRemainingUsd ?? 0) });
  return { ...base, state: "ok", label: t("stop.ok.label"), halted: false, message: msg };
}

/** Pure (exported for the offline check). `extra` = hypothetical position for /risk/check. */
export function computeMetrics(trader: string, days: DayRow[], positions: Position[], limits: Limits | null, today: string, lang: Lang = "ru") {
  const ws = weekStart(today);
  const todayRow = days.find((d) => d.date === today);
  const weekRows = days.filter((d) => d.date >= ws && d.date <= today);
  const weekPnlRows = weekRows.filter((d) => d.pnl != null);

  // equity / drawdown on days that have $ data
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  let cumR = 0;
  let peakR = 0;
  for (const d of days) {
    cumR += d.r;
    if (cumR > peakR) peakR = cumR;
    if (d.pnl == null) continue;
    cum += d.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDd) maxDd = peak - cum;
  }
  const hasPnl = days.some((d) => d.pnl != null);
  const currentDd = hasPnl ? round2(peak - cum) : 0;

  // red-day streak (most recent days with $ data; falls back to R when no $)
  let redStreak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    const v = hasPnl ? days[i].pnl : days[i].r;
    if (v == null) continue;
    if (v < 0) redStreak++;
    else break;
  }

  const openRisk = positions.reduce((s, p) => s + (p.riskUsd ?? 0), 0);
  const carried = positions.filter((p) => p.carried);
  const tonight = positions.filter((p) => p.carriedTonight);
  const overnightExposure = tonight.reduce((s, p) => s + (p.exposureUsd ?? 0), 0);
  const grossExposure = positions.reduce((s, p) => s + (p.exposureUsd ?? 0), 0);

  const todayPnl = todayRow?.pnl ?? null;
  const weekPnl = weekPnlRows.length ? round2(weekPnlRows.reduce((s, d) => s + (d.pnl ?? 0), 0)) : null;
  const todayLoss = Math.max(0, -(todayPnl ?? 0));
  const weekLoss = Math.max(0, -(weekPnl ?? 0));

  const L = limits;
  const stop = computeStop({ todayLoss, weekLoss, currentDd, limits: L }, lang);
  const AL = riskT.tFor(lang);
  const dailyRemaining = stop.dailyRemainingUsd;

  const alerts: Alert[] = [];
  const check = (kind: Alert["kind"], label: string, used: number, limit: number | null, detail?: string, tradeId?: number) => {
    const pct = pctOf(used, limit);
    if (pct == null) return;
    if (pct >= 100) alerts.push({ kind, label, level: "breach", used: round2(used), limit, pct, detail, tradeId });
    else if (pct >= WARN_PCT) alerts.push({ kind, label, level: "warn", used: round2(used), limit, pct, detail, tradeId });
  };
  if (L) {
    check("daily", AL("alerts.daily"), todayLoss, L.dailyLossLimit);
    check("weekly", AL("alerts.weekly"), weekLoss, L.weeklyLossLimit);
    check("drawdown", AL("alerts.drawdown"), currentDd, L.maxDrawdown);
    check("overnight", AL("alerts.overnight"), overnightExposure, L.maxOvernightExposure);
    check("positions", AL("alerts.positions"), positions.length, L.maxOpenPositions);
    const worstRisk = positions.reduce<Position | null>((w, p) => ((p.riskUsd ?? 0) > (w?.riskUsd ?? 0) ? p : w), null);
    if (worstRisk?.riskUsd != null) check("trade_risk", AL("alerts.trade_risk"), worstRisk.riskUsd, L.maxRiskPerTrade, worstRisk.ticker, worstRisk.id);
    const worstSize = positions.reduce<Position | null>((w, p) => ((p.exposureUsd ?? 0) > (w?.exposureUsd ?? 0) ? p : w), null);
    if (worstSize?.exposureUsd != null) check("position_size", AL("alerts.position_size"), worstSize.exposureUsd, L.maxPositionUsd, worstSize.ticker, worstSize.id);
    const on = positions.filter((p) => p.horizon === "overnight" || (p.horizon === "intraday" && p.carriedTonight));
    if (!L.allowOvernight && on.length) {
      alerts.push({ kind: "overnight_not_allowed", label: AL("alerts.overnight_not_allowed"), level: "breach", used: on.length, limit: 0, pct: null, detail: on.map((p) => p.ticker).join(", "), tradeId: on[0].id });
    }
    const sw = positions.filter((p) => p.horizon === "swing");
    if (!L.allowSwing && sw.length) {
      alerts.push({ kind: "swing_not_allowed", label: AL("alerts.swing_not_allowed"), level: "breach", used: sw.length, limit: 0, pct: null, detail: sw.map((p) => p.ticker).join(", "), tradeId: sw[0].id });
    }
  }
  alerts.sort((a, b) => (a.level === b.level ? (b.pct ?? 999) - (a.pct ?? 999) : a.level === "breach" ? -1 : 1));
  const status: "ok" | "warn" | "breach" | "no_limits" = !L
    ? "no_limits"
    : alerts.some((a) => a.level === "breach")
      ? "breach"
      : alerts.length
        ? "warn"
        : "ok";

  const weekSources = new Set(weekPnlRows.map((d) => d.source).filter(Boolean));
  const histBroker = days.filter((d) => d.source === "propreports").length;
  const histJournal = days.filter((d) => d.source === "journal").length;

  return {
    trader,
    status,
    stop,
    halted: stop.halted,
    alerts,
    breaches: alerts.filter((a) => a.level === "breach"),
    sources: {
      today: (todayRow?.source ?? null) as PnlSource,
      week: (weekSources.size === 0 ? null : weekSources.size === 1 ? [...weekSources][0] : "mixed") as PnlSource | "mixed",
      history: { propreports: histBroker, journal: histJournal },
    },
    today: {
      date: today,
      pnlNet: todayPnl == null ? null : round2(todayPnl),
      source: (todayRow?.source ?? null) as PnlSource,
      fees: round2(todayRow?.fees ?? 0),
      r: round2(todayRow?.r ?? 0),
      trades: todayRow?.trades ?? 0,
      brokerTrades: todayRow?.brokerTrades ?? 0,
      openPositions: positions.length,
      carriedPositions: carried.length,
      carriedTonight: tonight.length,
      openRiskUsd: round2(openRisk),
      overnightExposureUsd: round2(overnightExposure),
      grossExposureUsd: round2(grossExposure),
      dailyLimitUsedPct: pctOf(todayLoss, L?.dailyLossLimit ?? null),
      dailyRemainingUsd: dailyRemaining,
      /** Remaining daily room if every open stop is hit. */
      dailyRemainingAfterOpenRiskUsd: dailyRemaining == null ? null : round2(dailyRemaining - openRisk),
    },
    week: {
      from: ws,
      pnlNet: weekPnl,
      r: round2(weekRows.reduce((s, d) => s + d.r, 0)),
      trades: weekRows.reduce((s, d) => s + d.trades, 0),
      limitUsedPct: pctOf(weekLoss, L?.weeklyLossLimit ?? null),
      remainingUsd: stop.weeklyRemainingUsd,
    },
    drawdown: {
      hasPnl,
      equityNet: hasPnl ? round2(cum) : null,
      peakNet: hasPnl ? round2(peak) : null,
      currentUsd: currentDd,
      maxUsd: round2(maxDd),
      currentPct: L?.accountSize ? Math.round((currentDd / (L.accountSize + peak)) * 1000) / 10 : null,
      limitUsedPct: pctOf(currentDd, L?.maxDrawdown ?? null),
      remainingUsd: stop.drawdownRemainingUsd,
      cumR: round2(cumR),
      currentR: round2(peakR - cumR),
      redDayStreak: redStreak,
    },
  };
}
export type Metrics = ReturnType<typeof computeMetrics>;

/** Last N trading days cumulative net (or R when no $ data) for sparklines. */
function sparkline(days: DayRow[], n = 20): number[] {
  const hasPnl = days.some((d) => d.pnl != null);
  const vals = days.map((d) => (hasPnl ? d.pnl ?? 0 : d.r));
  let c = 0;
  const cum = vals.map((v) => (c += v));
  return cum.slice(-n).map(round2);
}

function groupBy<T extends { trader: string }>(rows: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const arr = m.get(r.trader);
    if (arr) arr.push(r);
    else m.set(r.trader, [r]);
  }
  return m;
}

// ─── red-day notifications (deduped per trader/date/state) ──────────────────

/**
 * Records warn / stop / weekly / drawdown transitions once per trader per trading day and mirrors them to the
 * in-app notifications table (trader + assigned curator / risk manager). Fire-and-forget; never throws.
 */
async function recordStopAlerts(m: Metrics, limits: Limits | null, date: string): Promise<void> {
  // `m` may be rendered in the reader's language; the alert log stores the RU text (the history fallback).
  const s = computeStop({ todayLoss: Math.max(0, -(m.today.pnlNet ?? 0)), weekLoss: Math.max(0, -(m.week.pnlNet ?? 0)), currentDd: m.drawdown.currentUsd, limits }, "ru");
  if (s.state === "ok" || s.state === "no_limits") return;
  const limit = s.state === "weekly" ? limits?.weeklyLossLimit : s.state === "drawdown" ? limits?.maxDrawdown : limits?.dailyLossLimit;
  const used = s.state === "weekly" ? Math.max(0, -(m.week.pnlNet ?? 0)) : s.state === "drawdown" ? m.drawdown.currentUsd : Math.max(0, -(m.today.pnlNet ?? 0));
  try {
    await ensureTables();
    const { rows } = await pool.query(
      `INSERT INTO risk_alert_log (trader, date, kind, level, used, "limit", message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (trader, date, kind) DO NOTHING
       RETURNING id`,
      [m.trader, date, s.state, s.halted ? "breach" : "warn", round2(used), limit ?? null, s.message],
    );
    if (!rows.length) return; // this state was already recorded today
    // Notifications only for the live trading day (a ?date= back-test must not alert anyone).
    if (date !== nyDate()) return;
    // Repeat breach within a week → head of desk (own dedup key; independent of the trader/curator notice below).
    if (s.halted) inBackground("risk.repeat_breach", () => escalateRepeatBreach(m.trader, date, { state: s.state, used: round2(used), limit: limit ?? 0 }));
    const notice = riskNotice({
      trader: m.trader, state: s.state, halted: s.halted,
      todayLoss: Math.max(0, -(m.today.pnlNet ?? 0)), weekLoss: Math.max(0, -(m.week.pnlNet ?? 0)), currentDd: m.drawdown.currentUsd,
      dailyLimit: limits?.dailyLossLimit ?? null, weeklyLimit: limits?.weeklyLossLimit ?? null, maxDrawdown: limits?.maxDrawdown ?? null,
      dailyPct: s.dailyPct, weeklyPct: s.weeklyPct, drawdownPct: s.drawdownPct, warnPct: WARN_PCT,
    });
    if (!notice) return;
    // At most one notification per type (risk_warn / risk_breach) per trader per trading day.
    if (!(await claimOnce(riskDedupKey(notice.type, m.trader, date)))) return;
    const common = { type: notice.type, link: notifLinks.risk(m.trader), entityType: "risk", entityId: `${m.trader}:${date}`, source: "risk" } as const;
    await notifyUser({ ...common, userName: m.trader, params: { ...notice.params, variant: "trader" } });
    // Warn → assigned staff only; stop (100%) → assigned staff, or every curator when nobody is assigned.
    const staff = uniqueRecipients(s.halted ? await staffOrFallback(m.trader) : await assignedStaffOf(m.trader), m.trader);
    for (const name of staff) await notifyUser({ ...common, userName: name, params: { ...notice.params, variant: "staff" } });
  } catch (err) {
    logger.warn({ err, trader: m.trader }, "risk: stop alert notification failed");
  }
}

/** Heads of desk: active admins; when the desk has none — every active curator. The trader is never included. */
async function headsOfDesk(trader: string): Promise<string[]> {
  const { rows } = await pool.query<{ name: string; role: string }>(
    `SELECT name, role FROM users WHERE active = true AND role IN ('admin', 'curator') AND COALESCE(banned, false) = false`,
  ).catch(() => ({ rows: [] as { name: string; role: string }[] }));
  const admins = rows.filter((r) => r.role === "admin").map((r) => r.name);
  return uniqueRecipients(admins.length ? admins : rows.map((r) => r.name), trader);
}

/** Second (or later) breach day within 7 calendar days → one critical notification to the head of desk per day. */
async function escalateRepeatBreach(trader: string, date: string, stop: { state: string; used: number; limit: number }): Promise<void> {
  const from = addDays(date, -6);
  const { rows } = await pool.query<{ date: string }>(
    `SELECT DISTINCT date FROM risk_alert_log WHERE trader = $1 AND level = 'breach' AND date BETWEEN $2 AND $3`,
    [trader, from, date],
  );
  const stats = breachStats(rows.map((r) => String(r.date)), date);
  if (!stats.repeat) return;
  if (!(await claimOnce(repeatBreachKey(trader, date)))) return;
  const heads = await headsOfDesk(trader);
  for (const name of heads) {
    await notifyUser({
      userName: name, type: "risk_repeat_breach", severity: "critical", source: "risk",
      params: { trader, days: stats.days7, prior: stats.prior.join(", "), state: stop.state, used: stop.used, limit: stop.limit },
      link: `/curator?trader=${encodeURIComponent(trader)}&tab=risk`, entityType: "risk", entityId: `${trader}:${date}:repeat`,
    });
  }
}

// ─── routes ─────────────────────────────────────────────────────────────────

router.get("/risk/me", asyncHandler(async (req, res): Promise<void> => {
  const me = req.authUser?.name;
  if (!me) throw unauthorized();
  const today = clientDate(req.query.date);
  const [limitsMap, days, positions] = await Promise.all([loadLimits(me), loadDaily(me, today), loadPositions(me, today)]);
  const limits = limitsMap.get(me) ?? null;
  const m = computeMetrics(me, days, positions, limits, today, langOf(req));
  void recordStopAlerts(m, limits, today);
  res.json({
    ...m,
    limits,
    today: { ...m.today, pnl: m.today.pnlNet, openRisk: m.today.openRiskUsd },
    afterClose: afterKeyTime(today),
    // Flat fields read by the dashboard limit bar / calculator / settings.
    dailyLossLimit: limits?.dailyLossLimit ?? null,
    todayPnl: m.today.pnlNet,
  });
}));

router.get("/risk/desk", asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireCap(req, res, "risk.read.team"))) return;
  const today = clientDate(req.query.date);
  const [limitsMap, days, positions, usersRes] = await Promise.all([
    loadLimits(null),
    loadDaily(null, today),
    loadPositions(null, today),
    pool.query(`SELECT name, role, COALESCE(banned, false) AS banned FROM users WHERE active = true`),
  ]);
  const users = new Map<string, { role: string; banned: boolean }>(
    usersRes.rows.map((u: any) => [String(u.name), { role: String(u.role), banned: !!u.banned }]),
  );
  const recentFrom = addDays(today, -60);
  const daysBy = groupBy(days);
  const posBy = groupBy(positions);

  // Desk roster: active traders + anyone with limits, open positions or recent trades.
  const names = new Set<string>();
  for (const [name, u] of users) if (u.role === "trader") names.add(name);
  for (const name of limitsMap.keys()) names.add(name);
  for (const name of posBy.keys()) names.add(name);
  for (const [name, rows] of daysBy) if (rows.some((d) => d.date >= recentFrom)) names.add(name);

  const STATUS_ORDER = { breach: 0, warn: 1, ok: 2, no_limits: 3 } as const;
  const rows = [...names].map((name) => {
    const d = daysBy.get(name) ?? [];
    const m = computeMetrics(name, d, posBy.get(name) ?? [], limitsMap.get(name) ?? null, today, langOf(req));
    void recordStopAlerts(m, limitsMap.get(name) ?? null, today);
    const last = d.length ? d[d.length - 1].date : null;
    return {
      ...m,
      role: users.get(name)?.role ?? null,
      banned: users.get(name)?.banned ?? false,
      limits: limitsMap.get(name) ?? null,
      spark: sparkline(d),
      sparkUnit: d.some((x) => x.pnl != null) ? "usd" : "r",
      lastTradeDate: last,
    };
  }).sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (a.today.pnlNet ?? 0) - (b.today.pnlNet ?? 0) || a.trader.localeCompare(b.trader));

  const sumNullable = (vals: (number | null)[]) => {
    const xs = vals.filter((v): v is number => v != null);
    return xs.length ? round2(xs.reduce((s, v) => s + v, 0)) : null;
  };
  const halted = rows.filter((r) => r.stop.halted);
  const warned = rows.filter((r) => r.stop.state === "warn");
  const sourceCounts = { propreports: rows.filter((r) => r.today.source === "propreports").length, journal: rows.filter((r) => r.today.source === "journal").length };

  res.json({
    date: today,
    nyMinutes: nyMinutes(),
    afterClose: afterKeyTime(today),
    summary: {
      traders: rows.length,
      pnlNetToday: sumNullable(rows.map((r) => r.today.pnlNet)),
      pnlSource: sourceCounts.propreports && sourceCounts.journal ? "mixed" : sourceCounts.propreports ? "propreports" : sourceCounts.journal ? "journal" : null,
      rToday: round2(rows.reduce((s, r) => s + r.today.r, 0)),
      tradesToday: rows.reduce((s, r) => s + r.today.trades, 0),
      breach: rows.filter((r) => r.status === "breach").length,
      warn: rows.filter((r) => r.status === "warn").length,
      noLimits: rows.filter((r) => r.status === "no_limits").length,
      halted: halted.length,
      nearStop: warned.length,
      openPositions: positions.length,
      carriedPositions: positions.filter((p) => p.carried).length,
      carriedTonight: positions.filter((p) => p.carriedTonight).length,
      openRiskUsd: round2(positions.reduce((s, p) => s + (p.riskUsd ?? 0), 0)),
      overnightExposureUsd: round2(positions.filter((p) => p.carriedTonight).reduce((s, p) => s + (p.exposureUsd ?? 0), 0)),
    },
    /** Desk banner: who is stopped / close to a stop, with exact numbers. */
    banner: [...halted, ...warned].map((r) => ({ trader: r.trader, state: r.stop.state, label: r.stop.label, message: r.stop.message, halted: r.stop.halted })),
    traders: rows,
  });
}));

router.get("/risk/limits/:trader", asyncHandler(async (req, res): Promise<void> => {
  if (!req.authUser) throw unauthorized();
  const trader = String(req.params.trader ?? "").trim();
  if (!trader || trader.length > 100) throw badRequest("INVALID_TRADER");
  if (trader !== req.authUser.name && !(await can(req, "risk.read.team", { trader }))) {
    throw forbidden();
  }
  const map = await loadLimits(trader);
  res.json(map.get(trader) ?? null);
}));

router.get("/risk/limits/:trader/history", asyncHandler(async (req, res): Promise<void> => {
  if (!req.authUser) throw unauthorized();
  const trader = String(req.params.trader ?? "").trim();
  if (!trader || trader.length > 100) throw badRequest("INVALID_TRADER");
  if (trader !== req.authUser.name && !(await can(req, "risk.read.team", { trader }))) throw forbidden();
  await ensureTables();
  const { rows } = await pool.query(
    `SELECT id, trader, before, after, reason, changed_by, changed_at FROM trader_risk_limit_events WHERE trader = $1 ORDER BY changed_at DESC LIMIT 50`,
    [trader],
  );
  res.json(rows.map((r: any) => ({
    id: Number(r.id),
    trader: String(r.trader),
    before: r.before ?? null,
    after: r.after,
    reason: r.reason ?? null,
    changedBy: r.changed_by ?? null,
    changedAt: new Date(r.changed_at).toISOString(),
  })));
}));

const money = z.union([z.number(), z.string().trim().regex(/^-?\d+(\.\d+)?$/).transform(Number)])
  .pipe(z.number().finite().min(0).max(1e12))
  .nullable()
  .optional();

const LimitsBody = z.object({
  accountSize: money,
  dailyLossLimit: money,
  weeklyLossLimit: money,
  maxDrawdown: money,
  maxRiskPerTrade: money,
  maxPositionUsd: money,
  maxOvernightExposure: money,
  maxOpenPositions: z.number().int().min(0).max(1000).nullable().optional(),
  allowOvernight: z.boolean().optional(),
  allowSwing: z.boolean().optional(),
  tier: z.string().trim().max(40).nullable().optional().transform((v) => (v ? v : null)),
  notes: z.string().max(2000).nullable().optional().transform((v) => (v && v.trim() ? v.trim() : null)),
  /** Why the limits changed — stored in the change log (not in trader_risk_limits). */
  reason: z.string().max(500).nullable().optional().transform((v) => (v && v.trim() ? v.trim() : null)),
}).strict();

router.put("/risk/limits/:trader", asyncHandler(async (req, res): Promise<void> => {
  const trader = String(req.params.trader ?? "").trim();
  if (!trader || trader.length > 100) throw badRequest("INVALID_TRADER");
  if (!(await requireCap(req, res, "risk.limits.edit", { trader }))) return;
  const parsed = LimitsBody.safeParse(req.body ?? {});
  if (!parsed.success) throw parsed.error;
  const { rows: exists } = await pool.query(`SELECT 1 FROM users WHERE name = $1 LIMIT 1`, [trader]);
  if (!exists.length) throw notFound("TRADER_NOT_FOUND");

  const before = (await loadLimits(trader)).get(trader) ?? null;
  const b = parsed.data;
  const { rows } = await pool.query(
    `INSERT INTO trader_risk_limits AS l (
       trader, account_size, daily_loss_limit, weekly_loss_limit, max_drawdown, max_risk_per_trade,
       max_position_usd, max_overnight_exposure, max_open_positions, allow_overnight, allow_swing,
       tier, notes, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10, TRUE),COALESCE($11, TRUE),$12,$13,$14,NOW())
     ON CONFLICT (trader) DO UPDATE SET
       account_size = EXCLUDED.account_size,
       daily_loss_limit = EXCLUDED.daily_loss_limit,
       weekly_loss_limit = EXCLUDED.weekly_loss_limit,
       max_drawdown = EXCLUDED.max_drawdown,
       max_risk_per_trade = EXCLUDED.max_risk_per_trade,
       max_position_usd = EXCLUDED.max_position_usd,
       max_overnight_exposure = EXCLUDED.max_overnight_exposure,
       max_open_positions = EXCLUDED.max_open_positions,
       allow_overnight = COALESCE($10, l.allow_overnight),
       allow_swing = COALESCE($11, l.allow_swing),
       tier = EXCLUDED.tier,
       notes = EXCLUDED.notes,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()
     RETURNING *`,
    [
      trader,
      b.accountSize ?? null,
      b.dailyLossLimit ?? null,
      b.weeklyLossLimit ?? null,
      b.maxDrawdown ?? null,
      b.maxRiskPerTrade ?? null,
      b.maxPositionUsd ?? null,
      b.maxOvernightExposure ?? null,
      b.maxOpenPositions ?? null,
      b.allowOvernight ?? null,
      b.allowSwing ?? null,
      b.tier ?? null,
      b.notes ?? null,
      req.authUser!.name,
    ],
  );
  const after = toLimits(rows[0]);
  // Change log (best-effort; the limits are already saved).
  try {
    await ensureTables();
    const strip = (l: Limits | null) => {
      if (!l) return null;
      const copy: Partial<Limits> = { ...l };
      delete copy.updatedBy;
      delete copy.updatedAt;
      return copy;
    };
    await pool.query(
      `INSERT INTO trader_risk_limit_events (trader, before, after, reason, changed_by) VALUES ($1, $2, $3, $4, $5)`,
      [trader, before ? JSON.stringify(strip(before)) : null, JSON.stringify(strip(after)), b.reason ?? null, req.authUser!.name],
    );
  } catch { /* ignore */ }
  const actor = req.authUser!.name;
  if (actor !== trader) {
    inBackground("risk.limits.change", async () => {
      const diff = limitsDiff(before, after);
      if (!diff.length && !b.reason) return; // nothing the trader would notice
      await notifyUser({
        userName: trader, type: "limit_change", actor, source: "risk",
        params: { variant: "manual", actor, ...(b.reason ? { reason: b.reason.slice(0, 200) } : {}), ...limitsDiffParams(before, after) },
        link: notifLinks.risk(trader), entityType: "risk_limits", entityId: trader,
      });
    });
  }
  res.json(after);
}));

/** Resolve ?trader= for self-or-team endpoints (risk.read.team). null trader = whole desk (desk scope only). */
/** Throws 400 / 401 / 403 AppErrors. */
async function resolveTraderScope(req: Request, allowAll: boolean): Promise<{ ok: true; trader: string | null }> {
  const raw = typeof req.query.trader === "string" ? req.query.trader.trim() : "";
  if (raw.length > 100) throw badRequest("INVALID_TRADER");
  const scope = await resolveTraderParam(req, "risk.read.team", raw, { allowAll });
  if (!scope.ok) throw scope.appError;
  return { ok: true, trader: scope.trader };
}

router.get("/risk/history", asyncHandler(async (req, res): Promise<void> => {
  const scope = await resolveTraderScope(req, false);
  const trader = scope.trader!;
  const today = clientDate(req.query.date);
  const daysParam = Number(req.query.days ?? 60);
  const span = Number.isFinite(daysParam) ? Math.min(730, Math.max(5, Math.round(daysParam))) : 60;
  const from = addDays(today, -(span - 1));

  const [days, limitsMap] = await Promise.all([loadDaily(trader, today), loadLimits(trader)]);
  const limits = limitsMap.get(trader) ?? null;
  const hasPnl = days.some((d) => d.pnl != null);

  let cum = 0, peak = 0, cumR = 0, peakR = 0;
  const all = days.map((d) => {
    cumR += d.r;
    if (cumR > peakR) peakR = cumR;
    if (d.pnl != null) {
      cum += d.pnl;
      if (cum > peak) peak = cum;
    }
    return {
      date: d.date,
      pnl: d.pnl == null ? null : round2(d.pnl),
      source: d.source,
      trades: d.trades,
      r: round2(d.r),
      fees: round2(d.fees),
      cum: round2(cum),
      equity: limits?.accountSize != null ? round2(limits.accountSize + cum) : null,
      drawdown: round2(cum - peak),
      cumR: round2(cumR),
      drawdownR: round2(cumR - peakR),
    };
  });
  const points = all.filter((p) => p.date >= from);

  let redStreak = 0, worstRedStreak = 0, run = 0;
  for (const p of points) {
    const v = hasPnl ? p.pnl : p.r;
    if (v == null) continue;
    if (v < 0) { run++; worstRedStreak = Math.max(worstRedStreak, run); } else run = 0;
  }
  for (let i = points.length - 1; i >= 0; i--) {
    const v = hasPnl ? points[i].pnl : points[i].r;
    if (v == null) continue;
    if (v < 0) redStreak++; else break;
  }
  const valued = points.map((p) => (hasPnl ? p.pnl : p.r)).filter((v): v is number => v != null);
  const green = valued.filter((v) => v > 0).length;
  const red = valued.filter((v) => v < 0).length;

  res.json({
    trader,
    from,
    to: today,
    unit: hasPnl ? "usd" : "r",
    limits,
    points,
    sources: { propreports: points.filter((p) => p.source === "propreports").length, journal: points.filter((p) => p.source === "journal").length },
    stats: {
      days: points.length,
      greenDays: green,
      redDays: red,
      redDayStreak: redStreak,
      worstRedStreak,
      bestDay: valued.length ? Math.max(...valued) : null,
      worstDay: valued.length ? Math.min(...valued) : null,
      maxDrawdown: points.length ? Math.min(0, ...points.map((p) => (hasPnl ? p.drawdown : p.drawdownR))) : 0,
      currentDrawdown: points.length ? (hasPnl ? points[points.length - 1].drawdown : points[points.length - 1].drawdownR) : 0,
    },
  });
}));

function positionTotals(positions: Position[]) {
  return {
    count: positions.length,
    carried: positions.filter((p) => p.carried).length,
    carriedTonight: positions.filter((p) => p.carriedTonight).length,
    riskUsd: round2(positions.reduce((s, p) => s + (p.riskUsd ?? 0), 0)),
    exposureUsd: round2(positions.reduce((s, p) => s + (p.exposureUsd ?? 0), 0)),
    overnightExposureUsd: round2(positions.filter((p) => p.carriedTonight).reduce((s, p) => s + (p.exposureUsd ?? 0), 0)),
  };
}

router.get("/risk/positions", asyncHandler(async (req, res): Promise<void> => {
  const scope = await resolveTraderScope(req, true);
  const today = clientDate(req.query.date);
  const positions = await loadPositions(scope.trader, today);
  res.json({
    date: today,
    trader: scope.trader,
    afterClose: afterKeyTime(today),
    positions,
    totals: positionTotals(positions),
  });
}));

/**
 * Overnight book: what the desk carries through the close. Before 15:45 ET only positions already carried
 * (overnight/swing or opened on an earlier day) are in the book; after 15:45 every open position is.
 * `?all=1` previews the book as if the key time had passed.
 */
router.get("/risk/overnight", asyncHandler(async (req, res): Promise<void> => {
  const scope = await resolveTraderScope(req, true);
  const today = clientDate(req.query.date);
  const preview = req.query.all === "1" || req.query.all === "true";
  const [positions, limitsMap, days] = await Promise.all([
    loadPositions(scope.trader, today),
    loadLimits(scope.trader),
    loadDaily(scope.trader, today),
  ]);
  const afterKey = afterKeyTime(today);
  const book = positions.filter((p) => p.carriedTonight || preview);
  const tickers = [...new Set(book.map((p) => p.ticker.toUpperCase()).filter(Boolean))];

  // Big7 / manual catalysts inside the next 10 calendar days (earnings & offerings are merged client-side).
  const horizonEnd = addDays(today, 10);
  const { rows: cats } = tickers.length
    ? await pool.query(
        `SELECT ticker, date, type, description, impact FROM big7_catalysts WHERE UPPER(ticker) = ANY($1) AND date >= $2 AND date <= $3 ORDER BY date ASC`,
        [tickers, today, horizonEnd],
      ).catch(() => ({ rows: [] as any[] }))
    : { rows: [] as any[] };
  const catalysts: Record<string, { date: string; type: string; description: string | null; impact: string }[]> = {};
  for (const c of cats) {
    const t = String(c.ticker).toUpperCase();
    (catalysts[t] ??= []).push({ date: String(c.date), type: String(c.type), description: c.description ?? null, impact: String(c.impact ?? "medium") });
  }

  const daysBy = groupBy(days);
  const posBy = groupBy(positions);
  const traders = [...new Set([...book.map((p) => p.trader)])].sort((a, b) => a.localeCompare(b)).map((name) => {
    const L = limitsMap.get(name) ?? null;
    const m = computeMetrics(name, daysBy.get(name) ?? [], posBy.get(name) ?? [], L, today, langOf(req));
    const mine = book.filter((p) => p.trader === name);
    const exposure = round2(mine.reduce((s, p) => s + (p.exposureUsd ?? 0), 0));
    return {
      trader: name,
      limits: L,
      positions: mine.map((p) => p.id),
      exposureUsd: exposure,
      riskUsd: round2(mine.reduce((s, p) => s + (p.riskUsd ?? 0), 0)),
      pctOfMaxOvernight: pctOf(exposure, L?.maxOvernightExposure ?? null),
      overnightAllowed: L ? L.allowOvernight : null,
      swingAllowed: L ? L.allowSwing : null,
      stop: m.stop,
      todayPnlNet: m.today.pnlNet,
      todaySource: m.today.source,
      dailyRemainingUsd: m.today.dailyRemainingUsd,
    };
  });

  const now = new Date();
  const nowMin = nyMinutes(now);
  res.json({
    date: today,
    trader: scope.trader,
    keyTime: "15:45",
    nyMinutes: nowMin,
    afterKey,
    preview,
    minutesToKey: today === nyDate(now) ? Math.max(0, OVERNIGHT_KEY_MINUTES - nowMin) : null,
    minutesToClose: today === nyDate(now) ? Math.max(0, CLOSE_MINUTES - nowMin) : null,
    positions: book,
    catalysts,
    traders,
    totals: positionTotals(book),
  });
}));

router.get("/risk/alerts", asyncHandler(async (req, res): Promise<void> => {
  const scope = await resolveTraderScope(req, true);
  const daysRaw = Number(req.query.days ?? 14);
  const span = Number.isFinite(daysRaw) ? Math.min(180, Math.max(1, Math.round(daysRaw))) : 14;
  const from = addDays(nyDate(), -(span - 1));
  await ensureTables();
  const { rows } = await pool.query(
    `SELECT id, trader, date, kind, level, used::float AS used, "limit"::float AS "limit", message, created_at
     FROM risk_alert_log WHERE ($1::text IS NULL OR trader = $1) AND date >= $2
     ORDER BY created_at DESC LIMIT 200`,
    [scope.trader, from],
  );
  res.json({
    from,
    trader: scope.trader,
    alerts: rows.map((r: any) => ({
      id: Number(r.id), trader: String(r.trader), date: String(r.date), kind: String(r.kind), level: String(r.level),
      used: num(r.used), limit: num(r.limit), message: alertMessage(r, langOf(req)), createdAt: new Date(r.created_at).toISOString(),
    })),
  });
}));

/** Pre-trade check: would this hypothetical position (for the caller) breach anything? */
router.get("/risk/check", asyncHandler(async (req, res): Promise<void> => {
  const me = req.authUser?.name;
  if (!me) throw unauthorized();
  const q = z.object({
    riskUsd: z.coerce.number().min(0).max(1e9).optional(),
    exposureUsd: z.coerce.number().min(0).max(1e12).optional(),
    horizon: z.enum(["intraday", "overnight", "swing"]).optional(),
    ticker: z.string().trim().max(12).optional(),
    date: z.string().optional(),
  }).safeParse(req.query);
  if (!q.success) throw q.error;
  const today = clientDate(q.data.date);
  const [limitsMap, days, positions] = await Promise.all([loadLimits(me), loadDaily(me, today), loadPositions(me, today)]);
  const limits = limitsMap.get(me) ?? null;
  const before = computeMetrics(me, days, positions, limits, today, langOf(req));
  const horizon = q.data.horizon ?? "intraday";
  const hypothetical: Position = {
    id: -1, ticker: (q.data.ticker ?? "NEW").toUpperCase(), date: today, side: null, setup: null, trader: me, horizon,
    qty: null, entry: null, stop: null, daysHeld: 0,
    riskUsd: q.data.riskUsd ?? null, riskSource: q.data.riskUsd != null ? "planned" : null, riskMismatch: false,
    plannedRiskUsd: q.data.riskUsd ?? null, stopRiskUsd: null,
    exposureUsd: q.data.exposureUsd ?? null, carried: horizon !== "intraday", carriedTonight: horizon !== "intraday" || afterKeyTime(today),
    noStatus: false, source: "manual", sector: null, atr: null,
  };
  const after = computeMetrics(me, days, [...positions, hypothetical], limits, today, langOf(req));
  const newAlerts = after.alerts.filter((a) => !before.alerts.some((b) => b.kind === a.kind && b.level === a.level));
  const horizonBlocked = !!limits && ((horizon === "overnight" && !limits.allowOvernight) || (horizon === "swing" && !limits.allowSwing));
  const remainingAfter = after.today.dailyRemainingAfterOpenRiskUsd;
  res.json({
    ok: !before.halted && !horizonBlocked && !newAlerts.some((a) => a.level === "breach") && (remainingAfter == null || remainingAfter >= 0),
    halted: before.halted,
    stop: before.stop,
    horizonBlocked,
    alerts: newAlerts,
    dailyRemainingUsd: before.today.dailyRemainingUsd,
    dailyRemainingAfterUsd: remainingAfter,
    limits,
  });
}));

// ─── desk snapshot (shared with routes/curator.ts) ──────────────────────────

export type DeskSnapshotRow = {
  trader: string;
  role: string | null;
  banned: boolean;
  metrics: Metrics;
  limits: Limits | null;
  days: DayRow[];
  lastTradeDate: string | null;
};

/**
 * Same roster and metrics as GET /risk/desk (active traders + anyone with limits, open positions or trades in the
 * last 60 days), as data for other endpoints. `trader` narrows to one person. Records stop alerts like /risk/desk.
 */
export async function deskSnapshot(today: string, trader: string | null = null, lang: Lang = "ru"): Promise<{ rows: DeskSnapshotRow[]; positions: Position[] }> {
  const [limitsMap, days, positions, usersRes] = await Promise.all([
    loadLimits(trader),
    loadDaily(trader, today),
    loadPositions(trader, today),
    pool.query(`SELECT name, role, COALESCE(banned, false) AS banned FROM users WHERE active = true AND ($1::text IS NULL OR name = $1)`, [trader]),
  ]);
  const users = new Map<string, { role: string; banned: boolean }>(
    usersRes.rows.map((u: any) => [String(u.name), { role: String(u.role), banned: !!u.banned }]),
  );
  const recentFrom = addDays(today, -60);
  const daysBy = groupBy(days);
  const posBy = groupBy(positions);
  const names = new Set<string>();
  for (const [name, u] of users) if (u.role === "trader") names.add(name);
  for (const name of limitsMap.keys()) names.add(name);
  for (const name of posBy.keys()) names.add(name);
  for (const [name, rows] of daysBy) if (rows.some((d) => d.date >= recentFrom)) names.add(name);
  if (trader) names.add(trader);
  const rows = [...names].map((name) => {
    const d = daysBy.get(name) ?? [];
    const limits = limitsMap.get(name) ?? null;
    const m = computeMetrics(name, d, posBy.get(name) ?? [], limits, today, lang);
    void recordStopAlerts(m, limits, today);
    return { trader: name, role: users.get(name)?.role ?? null, banned: users.get(name)?.banned ?? false, metrics: m, limits, days: d, lastTradeDate: d.length ? d[d.length - 1].date : null };
  }).sort((a, b) => a.trader.localeCompare(b.trader, "ru"));
  return { rows, positions };
}

// ─── limit templates by tier ────────────────────────────────────────────────

const limitFieldsOf = (l: Limits | null) => (l ? {
  accountSize: l.accountSize, dailyLossLimit: l.dailyLossLimit, weeklyLossLimit: l.weeklyLossLimit, maxDrawdown: l.maxDrawdown,
  maxRiskPerTrade: l.maxRiskPerTrade, maxPositionUsd: l.maxPositionUsd, maxOvernightExposure: l.maxOvernightExposure,
  maxOpenPositions: l.maxOpenPositions, allowOvernight: l.allowOvernight, allowSwing: l.allowSwing,
} : null);

export type TemplateStatus = { tier: string | null; tierName: string | null; hasLimits: boolean; drift: LimitDiff[] };

/** Per-trader template status: tier, drift from the tier template (empty = matches), or no limits at all. */
export async function templateStatus(traders: string[], lang: Lang = "ru"): Promise<Map<string, TemplateStatus>> {
  const [tiers, limitsMap] = await Promise.all([loadTierTemplates().catch(() => [] as Awaited<ReturnType<typeof loadTierTemplates>>), loadLimits(null)]);
  const out = new Map<string, TemplateStatus>();
  for (const name of traders) {
    const l = limitsMap.get(name) ?? null;
    const tier = l?.tier ? tiers.find((t) => t.key === l.tier) ?? null : null;
    out.set(name, {
      tier: l?.tier ?? null,
      tierName: tier?.name ?? (l?.tier ? stageLabel(l.tier, lang) ?? l.tier : null),
      hasLimits: !!l && (l.dailyLossLimit != null || l.weeklyLossLimit != null || l.maxDrawdown != null),
      drift: tier ? templateDiff(limitFieldsOf(l), tier, lang) : [],
    });
  }
  return out;
}

router.get("/risk/templates", asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireCap(req, res, "risk.read.team"))) return;
  const tiers = await loadTierTemplates();
  const { rows: users } = await pool.query<{ name: string }>(
    `SELECT name FROM users WHERE active = true AND role = 'trader' AND COALESCE(banned, false) = false ORDER BY name`,
  );
  const limitsMap = await loadLimits(null);
  const names = [...new Set([...users.map((u) => u.name), ...limitsMap.keys()])].sort((a, b) => a.localeCompare(b, "ru"));
  const status = await templateStatus(names);
  res.json({
    tiers: tiers.map((t) => ({ ...t, stage: (STAGE_TIER_KEYS as readonly string[]).includes(t.key) ? t.key : null, stageLabel: stageLabel(t.key, langOf(req)) ?? null })),
    traders: names.map((name) => ({ trader: name, limits: limitsMap.get(name) ?? null, ...status.get(name)! })),
    canEdit: await can(req, "risk.limits.edit"),
  });
}));

const ApplyTemplateBody = z.object({
  items: z.array(z.object({ trader: z.string().trim().min(1).max(100), tierKey: z.string().trim().min(1).max(40) }).strict()).min(1).max(50),
  reason: z.string().max(500).nullable().optional().transform((v) => (v && v.trim() ? v.trim() : null)),
}).strict();

const stripMeta = (l: Limits | null) => {
  if (!l) return null;
  const copy: Partial<Limits> = { ...l };
  delete copy.updatedBy;
  delete copy.updatedAt;
  return copy;
};

router.post("/risk/templates/apply", asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireCap(req, res, "risk.limits.edit"))) return;
  const parsed = ApplyTemplateBody.safeParse(req.body ?? {});
  if (!parsed.success) throw parsed.error;
  const actor = req.authUser!.name;
  const lang = langOf(req);
  const { items, reason } = parsed.data;
  await ensureTables();
  const results: { trader: string; ok: boolean; error?: string; code?: string; tier?: string; fromTier?: string | null; resync?: boolean; changes?: string[] }[] = [];
  for (const it of items) {
    if (!(await can(req, "risk.limits.edit", { trader: it.trader }))) { results.push({ trader: it.trader, ok: false, error: errorMessage("FORBIDDEN", lang), code: "FORBIDDEN" }); continue; }
    const { rows: exists } = await pool.query(`SELECT 1 FROM users WHERE name = $1 LIMIT 1`, [it.trader]);
    if (!exists.length) { results.push({ trader: it.trader, ok: false, error: errorMessage("TRADER_NOT_FOUND", lang), code: "TRADER_NOT_FOUND" }); continue; }
    const before = (await loadLimits(it.trader)).get(it.trader) ?? null;
    const applied = await applyTierTemplate(it.trader, it.tierKey, actor, reason, lang);
    if (!applied.ok) { results.push({ trader: it.trader, ok: false, error: applied.error }); continue; }
    const after = (await loadLimits(it.trader)).get(it.trader) ?? null;
    const changes = limitsDiff(before, after, lang);
    // Stored change-log reason: written in the curator's language (staff read the history).
    const tl = riskT.tFor(lang);
    const logHead = `${tl("template.logReason", { tier: applied.tier.name })}${applied.resync ? tl("template.logResync") : ""}`;
    const logReason = reason ? tl("template.logWithReason", { text: logHead, reason }) : logHead;
    try {
      await pool.query(
        `INSERT INTO trader_risk_limit_events (trader, before, after, reason, changed_by) VALUES ($1, $2, $3, $4, $5)`,
        [it.trader, before ? JSON.stringify(stripMeta(before)) : null, JSON.stringify(stripMeta(after)), logReason, actor],
      );
    } catch { /* change log is best-effort */ }
    await logAudit({
      actor, action: "risk.limits.template", targetType: "trader_risk_limits", targetId: it.trader,
      details: { tierKey: applied.tier.key, fromTier: applied.fromTier, resync: applied.resync, historyId: applied.historyId, changes: limitsDiffItems(before, after), reason },
    });
    if (actor !== it.trader && (changes.length || !applied.resync)) {
      const trader = it.trader;
      const tierLabel = applied.tier.name;
      const resync = applied.resync;
      const diffParams = limitsDiffParams(before, after);
      inBackground("risk.limits.template", () => notifyUser({
        userName: trader, type: "limit_change", actor, source: "risk",
        params: { variant: "template", actor, tier: tierLabel, resync: resync ? 1 : 0, ...(reason ? { reason: reason.slice(0, 200) } : {}), ...diffParams },
        link: notifLinks.risk(trader), entityType: "risk_limits", entityId: trader,
      }));
    }
    results.push({ trader: it.trader, ok: true, tier: applied.tier.key, fromTier: applied.fromTier, resync: applied.resync, changes });
  }
  const okCount = results.filter((r) => r.ok).length;
  res.status(okCount ? 200 : 400).json({ applied: okCount, failed: results.length - okCount, results, error: okCount ? undefined : results[0]?.error });
}));

// ─── «Разбор нарушения» ─────────────────────────────────────────────────────

/** Breach kind label in `lang` (risk namespace `breachKind.*`); unknown kinds pass through. */
export function breachKindLabel(kind: string, lang: Lang = "ru"): string {
  return riskT.tryFor(lang, `breachKind.${kind}`) ?? kind;
}
/** RU labels (kept for older imports). */
export const BREACH_KIND_LABELS: Record<string, string> = { stop: breachKindLabel("stop"), weekly: breachKindLabel("weekly"), drawdown: breachKindLabel("drawdown") };

/** Alert / breach log message in `lang`: halted kinds are re-rendered from their numbers, others keep the stored RU text. */
function alertMessage(r: { kind: unknown; used: unknown; limit: unknown; message: unknown }, lang: Lang): string {
  const used = num(r.used);
  const limit = num(r.limit);
  const text = lang !== "ru" && used != null && limit != null ? haltedStopText(String(r.kind), used, limit, lang) : null;
  return text ? text.message : String(r.message ?? "");
}

async function canReviewBreach(req: Request, trader: string | null): Promise<boolean> {
  const target = trader ? { trader } : undefined;
  return (await can(req, "risk.limits.edit", target)) || (await can(req, "journal.review", target));
}

router.get("/risk/breaches", asyncHandler(async (req, res): Promise<void> => {
  const scope = await resolveTraderScope(req, true);
  const daysRaw = Number(req.query.days ?? 30);
  const span = Number.isFinite(daysRaw) ? Math.min(365, Math.max(1, Math.round(daysRaw))) : 30;
  const today = nyDate();
  const from = addDays(today, -(span - 1));
  await Promise.all([ensureTables(), ensureCuratorTables()]);
  const { rows } = await pool.query(
    `SELECT a.id, a.trader, a.date, a.kind, a.level, a.used::float AS used, a."limit"::float AS "limit", a.message, a.created_at,
            CASE WHEN r.id IS NULL THEN NULL ELSE row_to_json(r.*) END AS review
       FROM risk_alert_log a
       LEFT JOIN risk_breach_reviews r ON r.alert_id = a.id AND r.archived_at IS NULL
      WHERE a.level = 'breach' AND ($1::text IS NULL OR a.trader = $1) AND a.date >= $2
      ORDER BY a.date DESC, a.created_at DESC LIMIT 300`,
    [scope.trader, from],
  );
  const byTrader = new Map<string, string[]>();
  for (const r of rows) byTrader.set(String(r.trader), [...(byTrader.get(String(r.trader)) ?? []), String(r.date)]);
  const lang = langOf(req);
  const breaches = rows.map((r: any) => {
    const st = breachStats(byTrader.get(String(r.trader)) ?? [], String(r.date));
    return {
      id: Number(r.id), trader: String(r.trader), date: String(r.date), kind: String(r.kind), kindLabel: breachKindLabel(String(r.kind), lang),
      used: num(r.used), limit: num(r.limit), message: alertMessage(r, lang), createdAt: new Date(r.created_at).toISOString(),
      repeat: st.repeat, breachDays7: st.days7,
      review: r.review ? rowToBreachReview(r.review) : null,
    };
  });
  res.json({
    from, to: today, trader: scope.trader,
    breaches,
    unreviewed: breaches.filter((b) => !b.review).length,
    reasons: breachReasons(lang), consequences: breachConsequences(lang),
    canReview: await canReviewBreach(req, scope.trader),
  });
}));

const ReviewBody = z.object({
  reason: z.enum(BREACH_REASON_KEYS),
  comment: z.string().max(4000).nullable().optional().transform((v) => (v && v.trim() ? v.trim() : null)),
  actions: z.array(z.object({
    id: z.string().max(40).optional(),
    title: z.string().max(300),
    dueOn: z.string().regex(YMD_RE).nullable().optional(),
    status: z.enum(["open", "done", "dropped"]).optional(),
  }).strict()).max(10).default([]),
  consequence: z.enum(BREACH_CONSEQUENCE_KEYS).default("none"),
}).strict();

router.post("/risk/breaches/:alertId/review", asyncHandler(async (req, res): Promise<void> => {
  const alertId = Number(req.params.alertId);
  if (!Number.isInteger(alertId) || alertId <= 0) throw badRequest("INVALID_ID");
  await Promise.all([ensureTables(), ensureCuratorTables()]);
  const { rows: al } = await pool.query(`SELECT id, trader, date, kind, level, message FROM risk_alert_log WHERE id = $1`, [alertId]);
  const alert = al[0];
  if (!alert) throw notFound("BREACH_NOT_FOUND");
  const trader = String(alert.trader);
  if (!(await requireAnyCap(req, res, ["risk.limits.edit", "journal.review"], { trader }))) return;
  const parsed = ReviewBody.safeParse(req.body ?? {});
  if (!parsed.success) throw parsed.error;
  const b = parsed.data;
  const actor = req.authUser!.name;
  const actions = normalizeBreachActions(b.actions);
  const { rows } = await pool.query(
    `INSERT INTO risk_breach_reviews (alert_id, trader, date, kind, reason, comment, actions, consequence, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$9)
     ON CONFLICT (alert_id) DO UPDATE SET
       reason = EXCLUDED.reason, comment = EXCLUDED.comment, actions = EXCLUDED.actions, consequence = EXCLUDED.consequence,
       updated_by = EXCLUDED.updated_by, updated_at = NOW(), archived_at = NULL, archived_by = NULL
     RETURNING *, (xmax = 0) AS inserted`,
    [alertId, trader, String(alert.date), String(alert.kind), b.reason, b.comment, JSON.stringify(actions), b.consequence, actor],
  );
  const review = rowToBreachReview(rows[0]);
  const created = rows[0].inserted === true;
  await logAudit({ actor, action: created ? "risk.breach.review" : "risk.breach.review.update", targetType: "risk_alert_log", targetId: String(alertId), details: { trader, reason: b.reason, consequence: b.consequence, actions: actions.length } });
  if (created && actor !== trader) {
    const date = String(alert.date);
    const agreed = actions.length ? actions.map((a) => a.title).join("; ").slice(0, 300) : null;
    inBackground("risk.breach.review", () => notifyUser({
      userName: trader, type: "risk_breach_review", actor, source: "risk",
      params: { actor, date, reasonCode: b.reason, consequenceCode: b.consequence, actions: agreed },
      link: notifLinks.risk(trader), entityType: "risk_breach", entityId: String(alertId),
    }));
  }
  res.status(created ? 201 : 200).json(review);
}));

const ActionStatusBody = z.object({ actionId: z.string().min(1).max(40), status: z.enum(["open", "done", "dropped"]) }).strict();

router.post("/risk/breach-reviews/:id/action", asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("INVALID_ID");
  await ensureCuratorTables();
  const { rows: ex } = await pool.query(`SELECT * FROM risk_breach_reviews WHERE id = $1 AND archived_at IS NULL`, [id]);
  if (!ex[0]) throw notFound("BREACH_REVIEW_NOT_FOUND");
  if (!(await requireAnyCap(req, res, ["risk.limits.edit", "journal.review"], { trader: String(ex[0].trader) }))) return;
  const parsed = ActionStatusBody.safeParse(req.body ?? {});
  if (!parsed.success) throw badRequest("VALIDATION");
  const actions = (Array.isArray(ex[0].actions) ? ex[0].actions : []) as { id: string; status: string }[];
  if (!actions.some((a) => a.id === parsed.data.actionId)) throw notFound("AGREEMENT_NOT_FOUND");
  const next = actions.map((a) => (a.id === parsed.data.actionId ? { ...a, status: parsed.data.status } : a));
  const { rows } = await pool.query(
    `UPDATE risk_breach_reviews SET actions = $2::jsonb, updated_by = $3, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id, JSON.stringify(next), req.authUser!.name],
  );
  res.json(rowToBreachReview(rows[0]));
}));

router.post("/risk/breach-reviews/:id/archive", asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("INVALID_ID");
  await ensureCuratorTables();
  const { rows: ex } = await pool.query(`SELECT trader FROM risk_breach_reviews WHERE id = $1 AND archived_at IS NULL`, [id]);
  if (!ex[0]) throw notFound("BREACH_REVIEW_NOT_FOUND");
  if (!(await requireAnyCap(req, res, ["risk.limits.edit", "journal.review"], { trader: String(ex[0].trader) }))) return;
  await pool.query(`UPDATE risk_breach_reviews SET archived_at = NOW(), archived_by = $2 WHERE id = $1`, [id, req.authUser!.name]);
  await logAudit({ actor: req.authUser!.name, action: "risk.breach.review.archive", targetType: "risk_breach_reviews", targetId: String(id), details: { trader: ex[0].trader } });
  res.json({ ok: true });
}));

// ─── daily risk summary for the curator (data only) ─────────────────────────

router.get("/risk/summary", asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireCap(req, res, "risk.read.team"))) return;
  const today = clientDate(req.query.date);
  const lang = langOf(req);
  const { rows, positions } = await deskSnapshot(today, null, lang);
  await Promise.all([ensureTables(), ensureCuratorTables()]);
  const from7 = addDays(today, -6);
  const from14 = addDays(today, -13);
  const [breachRes, unreviewedRes] = await Promise.all([
    pool.query(`SELECT trader, date, kind FROM risk_alert_log WHERE level = 'breach' AND date BETWEEN $1 AND $2`, [from7, today]),
    pool.query(
      `SELECT a.id, a.trader, a.date, a.kind, a.message FROM risk_alert_log a
         LEFT JOIN risk_breach_reviews r ON r.alert_id = a.id AND r.archived_at IS NULL
        WHERE a.level = 'breach' AND a.date >= $1 AND r.id IS NULL ORDER BY a.date DESC`,
      [from14],
    ),
  ]);
  const breachDates = new Map<string, string[]>();
  for (const r of breachRes.rows) breachDates.set(String(r.trader), [...(breachDates.get(String(r.trader)) ?? []), String(r.date)]);
  const tpl = await templateStatus(rows.map((r) => r.trader), lang);
  const active = rows.filter((r) => r.role === "trader" || r.limits || r.metrics.today.trades > 0 || r.metrics.today.openPositions > 0);
  const pnlVals = active.map((r) => r.metrics.today.pnlNet).filter((v): v is number => v != null);
  const brief = (r: DeskSnapshotRow) => ({
    trader: r.trader, state: r.metrics.stop.state, label: r.metrics.stop.label, message: r.metrics.stop.message,
    pnlNet: r.metrics.today.pnlNet, dailyPct: r.metrics.stop.dailyPct, weeklyPct: r.metrics.stop.weeklyPct, drawdownPct: r.metrics.stop.drawdownPct,
  });
  const kindLabel = (k: unknown) => breachKindLabel(String(k), lang);
  res.json({
    date: today,
    totals: {
      traders: active.length,
      trading: active.filter((r) => r.metrics.today.trades > 0).length,
      pnlNetToday: pnlVals.length ? round2(pnlVals.reduce((s, v) => s + v, 0)) : null,
      openPositions: positions.length,
      openRiskUsd: round2(positions.reduce((s, p) => s + (p.riskUsd ?? 0), 0)),
      carriedTonight: positions.filter((p) => p.carriedTonight).length,
      overnightExposureUsd: round2(positions.filter((p) => p.carriedTonight).reduce((s, p) => s + (p.exposureUsd ?? 0), 0)),
    },
    halted: active.filter((r) => r.metrics.stop.halted).map(brief),
    nearStop: active.filter((r) => r.metrics.stop.state === "warn").map(brief),
    breachesToday: breachRes.rows.filter((r: any) => String(r.date) === today).map((r: any) => ({ trader: String(r.trader), kind: String(r.kind), kindLabel: kindLabel(r.kind) })),
    repeatBreachers: [...breachDates.entries()]
      .map(([trader, dates]) => ({ trader, days7: new Set(dates).size, dates: [...new Set(dates)].sort() }))
      .filter((x) => x.days7 >= 2)
      .sort((a, b) => b.days7 - a.days7),
    unreviewedBreaches: unreviewedRes.rows.map((r: any) => ({ id: Number(r.id), trader: String(r.trader), date: String(r.date), kind: String(r.kind), kindLabel: kindLabel(r.kind), message: String(r.message) })), // RU log text (no numbers in this query)
    noLimits: active.filter((r) => !tpl.get(r.trader)?.hasLimits).map((r) => r.trader),
    templateDrift: active
      .map((r) => ({ trader: r.trader, tier: tpl.get(r.trader)?.tier ?? null, tierName: tpl.get(r.trader)?.tierName ?? null, fields: (tpl.get(r.trader)?.drift ?? []).map((d) => d.label) }))
      .filter((x) => x.fields.length > 0),
    overnight: active
      .filter((r) => r.metrics.today.carriedTonight > 0)
      .map((r) => ({ trader: r.trader, positions: r.metrics.today.carriedTonight, exposureUsd: r.metrics.today.overnightExposureUsd, allowed: r.limits?.allowOvernight ?? null, limitUsd: r.limits?.maxOvernightExposure ?? null })),
  });
}));

export default router;
