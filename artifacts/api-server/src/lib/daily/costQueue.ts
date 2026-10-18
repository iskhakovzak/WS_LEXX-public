/**
 * Curator queue by money (daily loop, feature 4): the desk's most expensive problems first, not by arrival time.
 *
 * For the traders a viewer curates, for the last finished trading day D (plus a short carry window of the previous
 * trading days for items the curator has not looked at yet) every (trader, day) gets the reasons it cost money:
 *
 *   stop_breach  — loss beyond a limit: the day net past the daily loss limit (trader_risk_limits), or a breach alert
 *                  (risk_alert_log: used − limit for daily stop / weekly / drawdown). Weekly and drawdown breaches are
 *                  states that last for days: they cost only the loss ADDED that day (owner decision 2026-10-18), so one
 *                  old drawdown does not top the queue every day; a green day keeps the chip without $.
 *   focus_broken — the day's focus was broken (lib/daily/service eveningFor → FocusVerdict.costNet).
 *   disputed     — the trader pressed «not a mistake» on the focus hit: the curator should look (instead of focus_broken).
 *   fees         — fees ≥ 50 % of a positive gross (and ≥ $5): the commissions ate the profit; priced like the engine's
 *                  «day:fees» (lib/daily/detectors): cost = −(fees above a healthy 25 % of the gross).
 *   loss_streak  — ≥ 3 losing trading days in a row ending on the day (cost = Σ net of the streak).
 *   giveback     — the day's running net peaked ≥ $50 and closed at ≤ 20 % of the peak (cost = close − peak); the
 *                  engine's «day:giveback» thresholds (lib/daily/detectors).
 *   rule         — active rule violations of the day (rule_violations.cost_net, one figure per trade).
 *
 * costNet of a row = Σ reason costs (≤ 0; a focus hit and the same day reason are counted once, see dedupeOverlap);
 * rows sort ascending (most negative first). The pure parts (reasons, sums, ranking, window) are exported for tests;
 * `buildCostQueue` loads the whole roster in one round of grouped queries; focus verdicts come from the stored evening
 * snapshots (daily_reviews.verdict), only missing ones go through service.eveningFor (time-boxed, rest in background).
 * The $ / % thresholds above are the defaults: the fees / giveback ones and the carry window are desk settings
 * (lib/settings registry: daily.fees*, daily.giveback*, curator.queueCarryDays), shared with the engine.
 * Money is NET (pnl − |fees|); dates are New York trading days.
 */
import { pool } from "@workspace/db";
import { closeDateSql, netPnlSql, num } from "../tradeMath";
import { addDays, nyDate, nyMinutes } from "../tradingDate";
import { violationDaySql } from "../violationWindow";
import { prevTradingDay, tradingPhase } from "../curatorLogic";
import { logger } from "../logger";
import { setting } from "../settings/registry";
import { dayThresholds } from "./detectors";
import type { CostQueueItem, EveningCard, FocusVerdict, TextItem } from "./types";

export const COST_QUEUE = {
  /** Trading days before D that stay in the queue while unresolved (desk setting curator.queueCarryDays). */
  get carryDays(): number { return setting("curator.queueCarryDays"); },
  streakMin: 3,
  /** Daily aggregates loaded for the loss streak. */
  historyDays: 45,
  /** How long a request waits for verdicts missing from daily_reviews (the rest is computed in the background). */
  focusBudgetMs: 600,
  focusConcurrency: 6,
};

export type ReasonKind = CostQueueItem["reasons"][number]["kind"];
export type CostReason = CostQueueItem["reasons"][number];
/** A queue row plus the curator's state: `resolved` = the curator already reviewed the day / breach or left a note after it. */
export type CostQueueRow = CostQueueItem & { resolved: boolean };

const r2 = (v: number) => Math.round(v * 100) / 100;
const text = (kind: ReasonKind, params: TextItem["params"] = {}): TextItem => ({ key: `costQueue.detail.${kind}`, params });

// ─── window ─────────────────────────────────────────────────────────────────

/** The last finished trading day for a curator's `today`: today after the close, else the previous trading day. */
export function lastFinishedDay(today: string, nowNy: { date: string; minutes: number }): string {
  if (today < nowNy.date) return tradingPhase(today, 0) === "weekend" ? prevTradingDay(today) : today;
  if (tradingPhase(today, nowNy.minutes) === "afterclose") return today;
  return prevTradingDay(today);
}

/** [D, D−1 trading day, …] — D first, then `carry` previous trading days. */
export function queueDays(day: string, carry: number = COST_QUEUE.carryDays): string[] {
  const out = [day];
  for (let i = 0; i < carry; i++) out.push(prevTradingDay(out[out.length - 1]));
  return out;
}

// ─── reasons (pure) ─────────────────────────────────────────────────────────

export type DayTrade = { id: number; ticker: string; net: number | null; exitAt: number | null };
export type BreachAlert = { id: number; kind: string; used: number | null; limit: number | null; reviewed: boolean };

/** Trades of a day in realisation order (exit time, else id). */
export function inExitOrder(trades: readonly DayTrade[]): DayTrade[] {
  return [...trades].sort((a, b) => (a.exitAt ?? Number.MAX_SAFE_INTEGER) - (b.exitAt ?? Number.MAX_SAFE_INTEGER) || a.id - b.id);
}

/** Loss beyond a limit: the day net past the daily loss limit and/or breach alerts (the deepest overshoot wins). */
export function stopBreachReason(dayNet: number | null, dailyLimit: number | null, trades: readonly DayTrade[], alerts: readonly BreachAlert[]): CostReason | null {
  const options: { cost: number | null; scope: string; used: number | null; limit: number | null; tradeId?: number }[] = [];
  if (dayNet != null && dailyLimit != null && dailyLimit > 0 && dayNet < -dailyLimit) {
    let cum = 0;
    let tradeId: number | undefined;
    for (const t of inExitOrder(trades)) {
      cum += t.net ?? 0;
      if (cum < -dailyLimit) { tradeId = t.id; break; }
    }
    options.push({ cost: r2(dayNet + dailyLimit), scope: "daily", used: r2(-dayNet), limit: dailyLimit, tradeId });
  }
  const addedToday = dayNet != null && dayNet < 0 ? dayNet : null;
  for (const a of alerts) {
    const over = a.used != null && a.limit != null && a.used > a.limit ? r2(-(a.used - a.limit)) : null;
    const lasting = a.kind !== "stop";
    const cost = !lasting || over == null ? over : addedToday == null ? null : r2(Math.max(over, addedToday));
    options.push({ cost, scope: lasting ? a.kind : "daily", used: a.used, limit: a.limit });
  }
  if (!options.length) return null;
  const worst = options.reduce((m, o) => ((o.cost ?? 0) < (m.cost ?? 0) ? o : m));
  return {
    kind: "stop_breach",
    costNet: worst.cost,
    text: text("stop_breach", { scope: worst.scope, used: worst.used, limit: worst.limit }),
    ...(worst.tradeId != null ? { tradeId: worst.tradeId } : {}),
  };
}

/** Fees ≥ 50 % of a positive gross: the commissions ate the profit. Cost = the fees above a healthy 25 % of the gross
 * (what trading less would have saved), the same price as the engine's «day:fees». */
export function feesReason(gross: number | null, fees: number): CostReason | null {
  const f = Math.abs(fees);
  const k = dayThresholds();
  if (gross == null || gross <= 0 || f < k.feesMinUsd || f < k.feesShare * gross) return null;
  return { kind: "fees", costNet: r2(-(f - k.feesHealthyShare * gross)), text: text("fees", { fees: r2(f), gross: r2(gross), pct: Math.round((f / gross) * 100) }) };
}

/** Losing trading days in a row ending on `day` (days without trades are skipped). `days` = the trader's daily nets. */
export function lossStreak(days: readonly { date: string; net: number | null }[], day: string): { days: number; net: number; from: string | null } {
  const upTo = days.filter((d) => d.date <= day && d.net != null).sort((a, b) => b.date.localeCompare(a.date));
  if (!upTo.length || upTo[0].date !== day) return { days: 0, net: 0, from: null };
  let n = 0;
  let net = 0;
  let from: string | null = null;
  for (const d of upTo) {
    if ((d.net ?? 0) >= 0) break;
    n += 1;
    net += d.net ?? 0;
    from = d.date;
  }
  return { days: n, net: r2(net), from };
}

export function lossStreakReason(days: readonly { date: string; net: number | null }[], day: string): CostReason | null {
  const s = lossStreak(days, day);
  if (s.days < COST_QUEUE.streakMin) return null;
  return { kind: "loss_streak", costNet: s.net, text: text("loss_streak", { days: s.days, net: s.net, from: s.from }) };
}

/** Running net of the day by exit order: peak and close. */
export function giveback(trades: readonly DayTrade[]): { peak: number; close: number; tradeId: number | null } {
  let cum = 0;
  let peak = 0;
  let afterPeakWorst: { id: number; net: number } | null = null;
  for (const t of inExitOrder(trades)) {
    cum += t.net ?? 0;
    if (cum > peak) { peak = cum; afterPeakWorst = null; continue; }
    if (t.net != null && t.net < 0 && (!afterPeakWorst || t.net < afterPeakWorst.net)) afterPeakWorst = { id: t.id, net: t.net };
  }
  return { peak: r2(peak), close: r2(cum), tradeId: afterPeakWorst?.id ?? null };
}

export function givebackReason(trades: readonly DayTrade[]): CostReason | null {
  const g = giveback(trades);
  const k = dayThresholds();
  if (g.peak < k.givebackMinUsd || g.close > g.peak * k.givebackKeepShare) return null;
  return {
    kind: "giveback",
    costNet: r2(g.close - g.peak),
    text: text("giveback", { peak: g.peak, close: g.close }),
    ...(g.tradeId != null ? { tradeId: g.tradeId } : {}),
  };
}

/** `rule` = the rule's kind (RuleKind, lib/rulesEval): rendered per reader, never the stored (Russian) rule name. */
export type DayViolation = { tradeId: number | null; costNet: number | null; rule: string };

/** Active rule violations of the day: one cost per trade (the deepest), day-level ones added as they are. */
export function rulesReason(violations: readonly DayViolation[]): CostReason | null {
  if (!violations.length) return null;
  const perTrade = new Map<number, number>();
  let dayLevel = 0;
  let known = false;
  for (const v of violations) {
    if (v.costNet == null) continue;
    known = true;
    if (v.tradeId == null) dayLevel += v.costNet;
    else perTrade.set(v.tradeId, Math.min(perTrade.get(v.tradeId) ?? 0, v.costNet));
  }
  const cost = known ? r2(dayLevel + [...perTrade.values()].reduce((a, b) => a + b, 0)) : null;
  const tradeId = [...perTrade.entries()].sort((a, b) => a[1] - b[1])[0]?.[0] ?? violations.find((v) => v.tradeId != null)?.tradeId ?? null;
  const rules = [...new Set(violations.map((v) => v.rule).filter(Boolean))];
  return {
    kind: "rule",
    costNet: cost,
    text: text("rule", { count: violations.length, rule: rules[0] ?? null, rules: rules.length }),
    ...(tradeId != null ? { tradeId } : {}),
  };
}

/** The day's focus verdict: disputed («not a mistake») goes to the curator instead of «broken». */
export function focusReason(v: FocusVerdict | null | undefined): CostReason | null {
  if (!v) return null;
  const tradeId = v.hits.slice().sort((a, b) => (a.net ?? 0) - (b.net ?? 0))[0]?.tradeId;
  const extra = tradeId != null ? { tradeId } : {};
  if (v.disputed) return { kind: "disputed", costNet: v.costNet, text: text("disputed", { mistake: v.mistake, count: v.hits.length }), ...extra };
  if (v.status === "broken") return { kind: "focus_broken", costNet: v.costNet, text: text("focus_broken", { mistake: v.mistake, count: v.hits.length }), ...extra };
  return null;
}

// ─── assembly + ranking (pure) ──────────────────────────────────────────────

const REASON_ORDER: Record<ReasonKind, number> = { stop_breach: 0, focus_broken: 1, disputed: 2, rule: 3, giveback: 4, fees: 5, loss_streak: 6 };

export function sumCost(reasons: readonly CostReason[]): number {
  return r2(reasons.reduce((a, r) => a + Math.min(0, r.costNet ?? 0), 0));
}

/** Which day reason a focus mistake is the same money as (day:fees ↔ fees …). rule:* → the rule reason. */
function overlapOf(mistake: string): ReasonKind | null {
  if (mistake === "day:fees") return "fees";
  if (mistake === "day:giveback") return "giveback";
  if (mistake === "day:after_limit") return "stop_breach";
  return mistake.startsWith("rule:") ? "rule" : null;
}

/**
 * A focus hit and a day reason can be the same money (focus «day:fees» and the fees reason). The focus reason stays
 * (the curator sees it is the trader's focus); the overlapping reason keeps only the cost beyond it — fees / giveback
 * fully covered disappear, a rule / stop reason stays (maybe at $0) because it still says what happened.
 */
export function dedupeOverlap(reasons: readonly CostReason[]): CostReason[] {
  const focus = reasons.find((r) => (r.kind === "focus_broken" || r.kind === "disputed") && (r.costNet ?? 0) < 0);
  const mistake = focus ? String(focus.text.params?.mistake ?? "") : "";
  const kind = mistake ? overlapOf(mistake) : null;
  if (!focus || !kind) return [...reasons];
  const out: CostReason[] = [];
  for (const r of reasons) {
    if (r.kind !== kind || r.costNet == null) { out.push(r); continue; }
    const rest = r2(Math.min(0, r.costNet - (focus.costNet ?? 0)));
    if (rest === 0 && (kind === "fees" || kind === "giveback")) continue;
    out.push({ ...r, costNet: rest });
  }
  return out;
}

/** One queue row from its reasons (null when nothing cost money / needs a look). Reasons: costliest first. */
export function makeItem(trader: string, date: string, reasons: readonly (CostReason | null)[], resolved: boolean): CostQueueRow | null {
  const list = dedupeOverlap(reasons.filter((r): r is CostReason => r != null));
  if (!list.length) return null;
  list.sort((a, b) => (a.costNet ?? 0) - (b.costNet ?? 0) || REASON_ORDER[a.kind] - REASON_ORDER[b.kind]);
  return { trader, date, costNet: sumCost(list), reasons: list, resolved };
}

/** Most negative first; ties: more reasons, newer day, name. */
export function rankQueue<T extends CostQueueItem>(items: readonly T[]): T[] {
  return [...items].sort((a, b) =>
    a.costNet - b.costNet || b.reasons.length - a.reasons.length || b.date.localeCompare(a.date) || a.trader.localeCompare(b.trader, "ru"));
}

/** Breach alerts attached to queue days: daily stops to their own day (alerts after D → D); state-like limits
 * (weekly, drawdown) re-fire every day, so only the newest one per trader and kind counts. */
export function attachAlerts<A extends { trader: string; date: string; kind: string }>(alerts: readonly A[], days: readonly string[]): Map<string, A[]> {
  const top = days[0];
  const out = new Map<string, A[]>();
  const newest = new Map<string, A>();
  for (const a of alerts) {
    const date = a.date > top ? top : a.date;
    if (!days.includes(date)) continue;
    if (a.kind === "stop") {
      const k = `${a.trader}|${date}`;
      out.set(k, [...(out.get(k) ?? []), { ...a, date }]);
      continue;
    }
    const k = `${a.trader}|${a.kind}`;
    const prev = newest.get(k);
    if (!prev || a.date > prev.date) newest.set(k, { ...a, date });
  }
  for (const a of newest.values()) {
    const k = `${a.trader}|${a.date}`;
    out.set(k, [...(out.get(k) ?? []), a]);
  }
  return out;
}

// ─── DB ─────────────────────────────────────────────────────────────────────

export interface CostQueueDeps {
  /** lib/daily/service eveningFor — the focus verdict of a day; omitted / stub → no focus reasons. */
  eveningFor?: (trader: string, date: string) => Promise<EveningCard | null>;
  /** Wall clock (tests). */
  now?: { date: string; minutes: number };
}

async function rowsOf<T = any>(sql: string, params: unknown[]): Promise<T[]> {
  try {
    const { rows } = await pool.query(sql, params);
    return rows as T[];
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "costQueue: query failed");
    return [];
  }
}

function loadData(traders: readonly string[], days: readonly string[], today: string) {
  const top = days[0];
  const low = days[days.length - 1];
  const from = addDays(top, -COST_QUEUE.historyDays);
  const cd = closeDateSql("t");
  const net = netPnlSql("t");
  const real = `t.pnl IS NOT NULL AND LOWER(TRIM(COALESCE(t.result, ''))) <> 'open'`;
  return Promise.all([
    rowsOf<{ trader: string; d: string; net: unknown; gross: unknown; fees: unknown; n: number }>(
      `SELECT t.trader, LEFT(${cd}, 10) AS d, SUM(${net}) FILTER (WHERE ${real})::float AS net,
              SUM(t.pnl) FILTER (WHERE ${real})::float AS gross, COALESCE(SUM(ABS(t.fees)), 0)::float AS fees, COUNT(*)::int AS n
         FROM trades t
        WHERE t.deleted_at IS NULL AND t.trader = ANY($1) AND LEFT(${cd}, 10) BETWEEN $2 AND $3
        GROUP BY 1, 2`,
      [traders, from, top],
    ),
    rowsOf<{ id: number; trader: string; d: string; ticker: string; net: unknown; exit_at: Date | null }>(
      `SELECT t.id, t.trader, LEFT(${cd}, 10) AS d, t.ticker, (CASE WHEN ${real} THEN ${net} END)::float AS net, x.exit_at
         FROM trades t
         LEFT JOIN LATERAL (SELECT MAX(e.executed_at) AS exit_at FROM trade_executions e WHERE e.trade_id = t.id) x ON TRUE
        WHERE t.deleted_at IS NULL AND t.trader = ANY($1) AND LEFT(${cd}, 10) = ANY($2)`,
      [traders, days],
    ),
    rowsOf<{ trader: string; daily: unknown }>(`SELECT trader, daily_loss_limit AS daily FROM trader_risk_limits WHERE trader = ANY($1)`, [traders]),
    rowsOf<{ id: number; trader: string; date: string; kind: string; used: unknown; limit: unknown; reviewed: boolean }>(
      `SELECT a.id, a.trader, a.date, a.kind, a.used, a."limit", (r.id IS NOT NULL) AS reviewed
         FROM risk_alert_log a
         LEFT JOIN risk_breach_reviews r ON r.alert_id = a.id AND r.archived_at IS NULL
        WHERE a.level = 'breach' AND a.trader = ANY($1) AND a.date BETWEEN $2 AND $3`,
      [traders, low, today > top ? today : top],
    ),
    rowsOf<{ trader: string; d: string; trade_id: number | null; cost_net: unknown; rule: string | null }>(
      `SELECT v.trader, ${violationDaySql("v")} AS d, v.trade_id, v.cost_net, r.kind AS rule
         FROM rule_violations v LEFT JOIN trading_rules r ON r.id = v.rule_id
        WHERE v.archived_at IS NULL AND v.trader = ANY($1) AND ${violationDaySql("v")} = ANY($2)`,
      [traders, days],
    ),
    rowsOf<{ trader: string; date: string }>(
      `SELECT trader, date FROM eod_days WHERE reviewed_at IS NOT NULL AND trader = ANY($1) AND date = ANY($2)`,
      [traders, days],
    ),
    rowsOf<{ trader: string; last: Date }>(
      `SELECT trader, MAX(created_at) AS last FROM curator_notes WHERE archived_at IS NULL AND trader = ANY($1) AND created_at >= $2::date GROUP BY trader`,
      [traders, low],
    ),
    // Evening verdict snapshots (lib/daily/service eveningFor stores one per finished day) — no engine run per trader.
    rowsOf<StoredVerdictRow>(
      `SELECT trader, date, verdict -> 'focus' AS focus, disputed, disputed_mistake
         FROM daily_reviews WHERE trader = ANY($1) AND date = ANY($2) AND verdict IS NOT NULL`,
      [traders, days],
    ),
  ]);
}

export type StoredVerdictRow = { trader: string; date: string; focus: FocusVerdict | null; disputed: boolean; disputed_mistake: string | null };

/** A stored verdict with the trader's later «not a mistake» applied (markReviewed does not rewrite the snapshot). */
export function storedVerdict(r: Pick<StoredVerdictRow, "focus" | "disputed" | "disputed_mistake">): FocusVerdict | null {
  const v = r.focus;
  if (!v || typeof v !== "object" || !v.mistake) return null;
  const disputed = !!v.disputed || (r.disputed && (!r.disputed_mistake || r.disputed_mistake === v.mistake));
  return { ...v, hits: Array.isArray(v.hits) ? v.hits : [], disputed };
}

const warming = new Set<string>();

/**
 * Focus verdicts for (trader, day) pairs without a stored snapshot, through the service (eveningFor stores the snapshot
 * of a finished day). Waits at most `budgetMs`; the rest keeps computing in the background so the next request (the page
 * polls every minute) reads them from daily_reviews. A pair already being computed is not started twice.
 */
export async function warmVerdicts(
  pairs: readonly [string, string][],
  eveningFor: NonNullable<CostQueueDeps["eveningFor"]>,
  budgetMs: number = COST_QUEUE.focusBudgetMs,
): Promise<Map<string, FocusVerdict | null>> {
  const out = new Map<string, FocusVerdict | null>();
  const todo = pairs.filter(([t, d]) => !warming.has(`${t}|${d}`));
  for (const [t, d] of todo) warming.add(`${t}|${d}`);
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const [trader, date] = todo[next++];
      try {
        const card = await eveningFor(trader, date);
        out.set(`${trader}|${date}`, card?.focus ?? null);
      } catch (err) {
        logger.warn({ err: (err as Error).message, trader, date }, "costQueue: eveningFor failed");
      } finally {
        warming.delete(`${trader}|${date}`);
      }
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => { timer = setTimeout(resolve, budgetMs); });
  await Promise.race([Promise.all(Array.from({ length: Math.min(COST_QUEUE.focusConcurrency, todo.length) }, worker)), budget]);
  if (timer) clearTimeout(timer);
  return new Map(out);
}

/** The curator queue by money for `traders` as of the curator's `today` (NY date). One round of grouped queries. */
export async function buildCostQueue(traders: readonly string[], today: string, deps: CostQueueDeps = {}): Promise<CostQueueRow[]> {
  if (!traders.length) return [];
  const now = deps.now ?? { date: nyDate(), minutes: nyMinutes() };
  const day = lastFinishedDay(today, now);
  const days = queueDays(day);
  const [aggRows, tradeRows, limitRows, alertRows, violationRows, eodRows, noteRows, verdictRows] = await loadData(traders, days, today);

  const key = (t: string, d: string) => `${t}|${d}`;
  const history = new Map<string, { date: string; net: number | null }[]>();
  const agg = new Map<string, { net: number | null; gross: number | null; fees: number; n: number }>();
  for (const r of aggRows) {
    const t = String(r.trader);
    history.set(t, [...(history.get(t) ?? []), { date: String(r.d), net: num(r.net) }]);
    agg.set(key(t, String(r.d)), { net: num(r.net), gross: num(r.gross), fees: num(r.fees) ?? 0, n: Number(r.n) || 0 });
  }
  const tradesBy = new Map<string, DayTrade[]>();
  for (const r of tradeRows) {
    const k = key(String(r.trader), String(r.d));
    tradesBy.set(k, [...(tradesBy.get(k) ?? []), { id: Number(r.id), ticker: String(r.ticker ?? ""), net: num(r.net), exitAt: r.exit_at ? new Date(r.exit_at).getTime() : null }]);
  }
  const limits = new Map(limitRows.map((r) => [String(r.trader), num(r.daily)]));
  const alerts = attachAlerts(alertRows.map((a) => ({ ...a, trader: String(a.trader), date: String(a.date), kind: String(a.kind) })), days);
  const violations = new Map<string, DayViolation[]>();
  for (const v of violationRows) {
    const k = key(String(v.trader), String(v.d));
    violations.set(k, [...(violations.get(k) ?? []), { tradeId: v.trade_id == null ? null : Number(v.trade_id), costNet: num(v.cost_net), rule: String(v.rule ?? "") }]);
  }
  const eodReviewed = new Set(eodRows.map((r) => key(String(r.trader), String(r.date))));
  const lastNote = new Map(noteRows.map((r) => [String(r.trader), new Date(r.last).getTime()]));
  // The curator looked at the day: reviewed the closed day, reviewed every breach of it, or left a note after its close.
  const resolvedOf = (t: string, d: string): boolean => {
    if (eodReviewed.has(key(t, d))) return true;
    const al = alerts.get(key(t, d)) ?? [];
    if (al.length && al.every((a) => a.reviewed)) return true;
    const note = lastNote.get(t);
    return note != null && note >= Date.parse(`${d}T20:00:00Z`);
  };

  const traded = (t: string, d: string) => (agg.get(key(t, d))?.n ?? 0) > 0;
  const verdicts = new Map<string, FocusVerdict | null>(verdictRows.map((r) => [key(String(r.trader), String(r.date)), storedVerdict(r)]));
  const missing: [string, string][] = [];
  for (const t of traders) for (const d of days) if (traded(t, d) && !verdicts.has(key(t, d)) && (d === day || !resolvedOf(t, d))) missing.push([t, d]);
  if (deps.eveningFor && missing.length) for (const [k, v] of await warmVerdicts(missing, deps.eveningFor)) verdicts.set(k, v);

  const items: CostQueueRow[] = [];
  for (const t of traders) {
    // A streak spans days: it belongs to the trader's newest traded day of the window only.
    const streakDay = days.find((d) => traded(t, d));
    for (const d of days) {
      const k = key(t, d);
      const resolved = resolvedOf(t, d);
      if (d !== day && resolved) continue;
      const a = agg.get(k);
      const trades = tradesBy.get(k) ?? [];
      const al = (alerts.get(k) ?? []).map((x) => ({ id: Number(x.id), kind: x.kind, used: num(x.used), limit: num(x.limit), reviewed: !!x.reviewed }));
      const item = makeItem(t, d, [
        stopBreachReason(a?.net ?? null, limits.get(t) ?? null, trades, d === day ? al : al.filter((x) => !x.reviewed)),
        focusReason(verdicts.get(k)),
        a ? feesReason(a.gross, a.fees) : null,
        d === streakDay ? lossStreakReason(history.get(t) ?? [], d) : null,
        givebackReason(trades),
        rulesReason(violations.get(k) ?? []),
      ], resolved);
      // A carried day stays only when it cost money or needs a look (a breach, a disputed focus).
      if (item && (d === day || item.costNet < 0 || item.reasons.some((r) => r.kind === "stop_breach" || r.kind === "disputed"))) items.push(item);
    }
  }
  return rankQueue(items);
}
