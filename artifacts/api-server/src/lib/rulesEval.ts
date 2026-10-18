/**
 * Проверка правил дисциплины по сделкам — чистые функции (без БД), используются сканером (lib/rulesEngine),
 * отчётом (lib/rulesReport) и предпросмотром правила.
 *
 * Деньги — НЕТТО (брутто − |комиссии|). День нарушения — торговый день Нью-Йорка.
 * У каждого нарушения две оценки в $:
 *   costNet   — исторический контракт: убыток сделки (≤ 0; выигрыш = 0), для дневного лимита — перебор сверх лимита;
 *   impactNet — контрфактическая оценка со знаком: насколько итог был бы другим без нарушения
 *               (сделки «которых не должно быть» — их нетто целиком; размер сверх лимита — доля нетто от лишнего размера;
 *               убыток сверх лимита на сделку — только перебор). Отрицательное = нарушение стоило денег.
 */
import { hhmmToMinutes } from "./rulesCatalog";
import { renderViolation, type ViolationMsg } from "./rulesI18n";

export type RuleKind =
  | "max_trades_per_day"
  | "no_trade_after_n_losses"
  | "max_loss_per_day_pct"
  | "max_daily_loss_usd"
  | "position_size_pct"
  | "max_position_usd"
  | "max_risk_per_trade_usd"
  | "max_consecutive_losses"
  | "no_overnight"
  | "no_swing"
  | "trade_without_checklist"
  | "max_trades_per_ticker_day"
  | "max_loss_per_trade_usd"
  | "min_pause_after_loss"
  | "no_size_up_after_loss"
  | "no_trade_first_minutes"
  | "trading_window"
  | "min_hold_seconds"
  | "max_position_shares"
  | "no_averaging_down"
  | "banned_tickers"
  | "self_check";

export type RuleThreshold = Record<string, unknown>;

export interface RuleRow {
  id: number;
  trader: string;
  name: string;
  kind: string;
  threshold: RuleThreshold;
  enabled: boolean;
}

export interface RiskLimits {
  accountSize: number | null;
  dailyLossLimit: number | null;
  maxPositionUsd: number | null;
  maxRiskPerTrade: number | null;
  allowOvernight: boolean;
  allowSwing: boolean;
}

export const NO_LIMITS: RiskLimits = { accountSize: null, dailyLossLimit: null, maxPositionUsd: null, maxRiskPerTrade: null, allowOvernight: true, allowSwing: true };

export interface TradeForRule {
  id: number;
  trader: string | null;
  /** Entry day (YYYY-MM-DD). */
  date: string;
  /** Realised day: exit date for multi-day holds. */
  closeDate: string;
  result: "win" | "loss" | "be" | "open" | null;
  pnl: number | null;
  /** Net P&L = gross − |fees|. */
  netPnl: number | null;
  signedR: number | null;
  entry: number | null;
  stop: number | null;
  qty: number | null;
  riskUsd: number | null;
  horizon: "intraday" | "overnight" | "swing";
  source: string | null;
  playbookId: number | null;
  setupScore: number | null;
  /** Max |running position| × price over the trade's executions (null without executions). */
  maxNotional: number | null;
  checklistRuns: number;
  // ── Необязательные поля (новые виды правил) ──
  ticker?: string | null;
  side?: "long" | "short" | null;
  /** Время первого входа / последнего выхода, epoch ms. */
  entryAt?: number | null;
  exitAt?: number | null;
  /** Минуты от полуночи Нью-Йорка для входа (9:30 = 570). */
  entryMin?: number | null;
  /** Удержание, секунды. */
  holdSec?: number | null;
  /** Число реальных исполнений (≥ 3 — есть доборы/частичные выходы, по ним можно судить об усреднении). */
  execFills?: number | null;
  /** Доля позиции, добранная против себя по худшей цене (0 — не было); null — неизвестно. */
  avgDownShare?: number | null;
}

export type Severity = "low" | "medium" | "high" | "critical";

export interface ViolationDraft {
  ruleId: number;
  trader: string;
  tradeId: number | null;
  /** Trading day the violation belongs to (YYYY-MM-DD, New York). */
  day: string;
  /** Stable key within a rule: one row per (rule, trade) or (rule, day). */
  key: string;
  /** Russian rendering of `msg` (stored in rule_violations.message as the fallback). */
  message: string;
  /** The reason as data (lib/rulesI18n): rendered in the reader's language. */
  msg: ViolationMsg;
  severity: Severity;
  details: Record<string, unknown>;
  /** $ cost of the violation, net (≤ 0 when it lost money); null when unknown. */
  costNet: number | null;
  /** Signed counterfactual impact, net $ (negative = the violation cost money); null when unknown. */
  impactNet?: number | null;
}

function groupBy(trades: TradeForRule[], key: (t: TradeForRule) => string): Map<string, TradeForRule[]> {
  const m = new Map<string, TradeForRule[]>();
  for (const t of trades) {
    const k = key(t);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(t);
  }
  return m;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Violation reason as data + its Russian rendering (the stored fallback). */
function reason(key: string, params: Record<string, string | number> = {}): { msg: ViolationMsg; message: string } {
  const msg: ViolationMsg = { key, params };
  return { msg, message: renderViolation(msg, "ru") ?? key };
}
const r2 = (v: number) => Math.round(v * 100) / 100;
/** Cost of a trade-level violation: the trade's net loss (0 when it made money), null when P&L is unknown. */
const lossOf = (t: TradeForRule) => (t.netPnl == null ? null : Math.min(0, t.netPnl));
/** Whole net of a trade that should not have been taken. */
const netOf = (t: TradeForRule) => (t.netPnl == null ? null : r2(t.netPnl));
/** Part of the net that came from size above the limit. */
const excessShare = (t: TradeForRule, limit: number, size: number) => (t.netPnl == null || size <= 0 ? null : r2(t.netPnl * Math.max(0, 1 - limit / size)));

/** Notional position size: executions first, else entry × qty. */
export function notionalOf(t: TradeForRule): number | null {
  if (t.maxNotional != null && t.maxNotional > 0) return t.maxNotional;
  if (t.entry != null && t.qty != null && t.entry > 0 && t.qty > 0) return t.entry * t.qty;
  return null;
}
/** $ at risk: stored risk_usd first, else |entry − stop| × qty. */
export function riskOf(t: TradeForRule): number | null {
  if (t.riskUsd != null && t.riskUsd > 0) return t.riskUsd;
  if (t.entry != null && t.stop != null && t.qty != null && t.qty > 0 && t.entry !== t.stop) return Math.abs(t.entry - t.stop) * t.qty;
  return null;
}
/** Positive threshold number or null when empty/invalid. */
function th(v: unknown): number | null {
  const n = numOrNull(v);
  return n != null && n > 0 ? n : null;
}
function exitMs(t: TradeForRule): number | null {
  if (t.exitAt != null) return t.exitAt;
  if (t.entryAt != null && t.holdSec != null) return t.entryAt + t.holdSec * 1000;
  return null;
}
function clock(min: number): string {
  const m = Math.round(min);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

/** Day-loss rule shared by $ and % variants: running NET day P&L by realised day. */
function dayLossViolations(rule: RuleRow, trades: TradeForRule[], limit: number, how: Record<string, string | number>): ViolationDraft[] {
  const out: ViolationDraft[] = [];
  const byDay = groupBy(trades.filter((t) => t.netPnl != null), (t) => t.closeDate);
  for (const [day, list] of byDay) {
    let running = 0;
    let breached = false;
    for (const t of list) {
      running += t.netPnl ?? 0;
      if (breached) {
        out.push({
          ruleId: rule.id, trader: rule.trader, tradeId: t.id, day, key: `t${t.id}`, severity: "critical",
          ...reason("dayLimitAfter", { limitUsd: limit, runningUsd: running, ...how }),
          details: { day, runningNet: running, limitUsd: limit, afterBreach: true },
          costNet: lossOf(t),
          impactNet: netOf(t),
        });
      } else if (running <= -limit) {
        breached = true;
        const over = Math.min(0, running + limit);
        out.push({
          ruleId: rule.id, trader: rule.trader, tradeId: t.id, day, key: `t${t.id}`, severity: "high",
          ...reason("dayLimitHit", { limitUsd: limit, runningUsd: running, day, ...how }),
          details: { day, runningNet: running, limitUsd: limit, afterBreach: false },
          costNet: over,
          impactNet: r2(over),
        });
      }
    }
  }
  return out;
}

export function evalRule(rule: RuleRow, trades: TradeForRule[], limits: RiskLimits = NO_LIMITS): ViolationDraft[] {
  const out: ViolationDraft[] = [];
  const t = rule.threshold ?? {};
  const push = (tr: TradeForRule, day: string, severity: Severity, text: { msg: ViolationMsg; message: string }, details: Record<string, unknown>, impactNet: number | null, costNet: number | null = lossOf(tr)) =>
    out.push({ ruleId: rule.id, trader: rule.trader, tradeId: tr.id, day, key: `t${tr.id}`, severity, ...text, details, costNet, impactNet });

  switch (rule.kind as RuleKind) {
    case "max_trades_per_day": {
      const n = th(t.n) ?? 5;
      for (const [day, list] of groupBy(trades, (x) => x.date)) {
        for (let i = n; i < list.length; i++) {
          push(list[i], day, "high", reason("maxTrades", { n, no: i + 1, day }), { day, totalTradesThatDay: list.length, limit: n }, netOf(list[i]));
        }
      }
      break;
    }
    case "no_trade_after_n_losses": {
      const n = th(t.n) ?? 3;
      for (const [day, list] of groupBy(trades, (x) => x.date)) {
        let losses = 0;
        for (const tr of list) {
          if (losses >= n) {
            push(tr, day, "critical", reason("afterLosses", { n, day }), { day, lossesBefore: losses, limit: n }, netOf(tr));
          }
          if (tr.result === "loss") losses++;
          else if (tr.result === "win") losses = 0;
        }
      }
      break;
    }
    case "max_daily_loss_usd": {
      const limit = th(t.usd) ?? limits.dailyLossLimit;
      if (limit == null) break;
      out.push(...dayLossViolations(rule, trades, limit, th(t.usd) ? {} : { how: "desk" }));
      break;
    }
    case "max_loss_per_day_pct": {
      const pct = th(t.pct) ?? 2;
      const capital = th(t.capital) ?? limits.accountSize ?? 50000;
      out.push(...dayLossViolations(rule, trades, (capital * pct) / 100, { how: "pct", pct, capitalUsd: capital }));
      break;
    }
    case "max_position_usd":
    case "position_size_pct": {
      let maxSize: number | null;
      let how: Record<string, string | number>;
      if (rule.kind === "max_position_usd") {
        maxSize = th(t.usd) ?? limits.maxPositionUsd;
        how = th(t.usd) ? {} : { how: "desk" };
      } else {
        const pct = th(t.pct) ?? 10;
        const capital = th(t.capital) ?? limits.accountSize ?? 50000;
        maxSize = (capital * pct) / 100;
        how = { how: "capPct", pct };
      }
      if (maxSize == null) break;
      for (const tr of trades) {
        const size = notionalOf(tr);
        if (size != null && size > maxSize) {
          push(tr, tr.date, "medium", reason("positionSize", { sizeUsd: size, maxUsd: maxSize, ...how }),
            { positionSize: size, maxSize, fromExecutions: tr.maxNotional != null }, excessShare(tr, maxSize, size));
        }
      }
      break;
    }
    case "max_risk_per_trade_usd": {
      const limit = th(t.usd) ?? limits.maxRiskPerTrade;
      if (limit == null) break;
      for (const tr of trades) {
        const risk = riskOf(tr);
        if (risk != null && risk > limit) {
          push(tr, tr.date, "high", reason("riskPerTrade", { riskUsd: risk, limitUsd: limit, ...(th(t.usd) ? {} : { how: "desk" }) }),
            { riskUsd: risk, limitUsd: limit }, excessShare(tr, limit, risk));
        }
      }
      break;
    }
    case "max_consecutive_losses": {
      const n = th(t.n) ?? 4;
      let streak = 0;
      for (const tr of trades) {
        if (tr.result === "loss") {
          streak++;
          if (streak >= n) {
            push(tr, tr.closeDate, "high", reason("consecutive", { streak, n }), { streak, limit: n, date: tr.date }, netOf(tr));
          }
        } else if (tr.result === "win") {
          streak = 0;
        }
      }
      break;
    }
    case "no_overnight":
    case "no_swing": {
      const swingOnly = rule.kind === "no_swing";
      for (const tr of trades) {
        const hit = swingOnly ? tr.horizon === "swing" : tr.horizon !== "intraday";
        if (!hit) continue;
        push(tr, tr.date, "high", swingOnly ? reason("swing") : reason("overnight", { horizon: tr.horizon }),
          { horizon: tr.horizon, exitDate: tr.closeDate }, netOf(tr));
      }
      break;
    }
    case "trade_without_checklist": {
      for (const tr of trades) {
        // Broker-imported round trips never went through the journal's checklist: not a discipline fault.
        if (tr.source === "propreports") continue;
        if (tr.checklistRuns > 0 || tr.setupScore != null) continue;
        push(tr, tr.date, "medium", tr.playbookId ? reason("noChecklistSetup") : reason("noChecklist"), { playbookId: tr.playbookId }, netOf(tr));
      }
      break;
    }

    // ── Новые виды ──────────────────────────────────────────────────────────────────────────────
    case "max_trades_per_ticker_day": {
      const n = th(t.n) ?? 2;
      for (const [k, list] of groupBy(trades.filter((x) => !!x.ticker), (x) => `${x.date}|${x.ticker}`)) {
        const [day, ticker] = k.split("|");
        for (let i = n; i < list.length; i++) {
          push(list[i], day, "medium", reason("tickerEntries", { ticker, no: i + 1, n }), { ticker, entryNo: i + 1, limit: n }, netOf(list[i]));
        }
      }
      break;
    }
    case "max_loss_per_trade_usd": {
      const limit = th(t.usd) ?? limits.maxRiskPerTrade;
      if (limit == null) break;
      for (const tr of trades) {
        if (tr.netPnl == null || tr.netPnl >= -limit) continue;
        push(tr, tr.closeDate, tr.netPnl <= -2 * limit ? "critical" : "high",
          reason("lossPerTrade", { lossUsd: tr.netPnl, limitUsd: limit, ...(th(t.usd) ? {} : { how: "desk" }) }),
          { lossUsd: tr.netPnl, limitUsd: limit }, r2(tr.netPnl + limit));
      }
      break;
    }
    case "min_pause_after_loss": {
      const min = th(t.min) ?? 10;
      for (const [day, list] of groupBy(trades, (x) => x.date)) {
        let lastLossExit: number | null = null;
        for (const tr of list) {
          if (tr.entryAt != null && lastLossExit != null) {
            const gapMin = (tr.entryAt - lastLossExit) / 60000;
            if (gapMin >= 0 && gapMin < min) {
              push(tr, day, "high", reason("pause", { gap: gapMin < 1 ? "<1" : Math.floor(gapMin), min }), { gapMin: r2(gapMin), limitMin: min }, netOf(tr));
            }
          }
          const ex = exitMs(tr);
          if (tr.result === "loss" && ex != null) lastLossExit = Math.max(lastLossExit ?? 0, ex);
        }
      }
      break;
    }
    case "no_size_up_after_loss": {
      const factor = Math.max(1, th(t.factor) ?? 1.3);
      for (const [day, list] of groupBy(trades, (x) => x.date)) {
        let prevLoss: number | null = null;
        for (const tr of list) {
          const size = notionalOf(tr);
          if (size != null && prevLoss != null && size >= prevLoss * factor) {
            push(tr, day, "high", reason("sizeUp", { sizeUsd: size, factor, prevUsd: prevLoss }),
              { notional: size, prevLossNotional: prevLoss, factor }, excessShare(tr, prevLoss, size));
          }
          if (tr.result === "loss" && size != null) prevLoss = size;
        }
      }
      break;
    }
    case "no_trade_first_minutes": {
      const n = th(t.n) ?? 5;
      for (const tr of trades) {
        if (tr.entryMin == null) continue;
        if (tr.entryMin >= 570 && tr.entryMin < 570 + n) {
          push(tr, tr.date, "medium", reason("firstMinutes", { time: clock(tr.entryMin), n }), { entryMin: tr.entryMin, limitMin: n }, netOf(tr));
        }
      }
      break;
    }
    case "trading_window": {
      const start = hhmmToMinutes(t.start ?? 930) ?? 570;
      const end = hhmmToMinutes(t.end ?? 1555) ?? 955;
      for (const tr of trades) {
        if (tr.entryMin == null) continue;
        if (tr.entryMin < start || tr.entryMin >= end) {
          push(tr, tr.date, "medium", reason("window", { time: clock(tr.entryMin), start: clock(start), end: clock(end) }), { entryMin: tr.entryMin, start, end }, netOf(tr));
        }
      }
      break;
    }
    case "min_hold_seconds": {
      const sec = th(t.sec) ?? 30;
      for (const tr of trades) {
        if (tr.holdSec == null || tr.holdSec >= sec) continue;
        push(tr, tr.closeDate, "low", reason("hold", { hold: Math.round(tr.holdSec), sec }), { holdSec: tr.holdSec, limitSec: sec }, netOf(tr));
      }
      break;
    }
    case "max_position_shares": {
      const limit = th(t.qty) ?? 500;
      for (const tr of trades) {
        if (tr.qty == null || tr.qty <= limit) continue;
        push(tr, tr.date, "medium", reason("shares", { qty: Math.round(tr.qty), limitQty: limit }), { qty: tr.qty, limit }, excessShare(tr, limit, tr.qty));
      }
      break;
    }
    case "no_averaging_down": {
      for (const tr of trades) {
        if (!tr.avgDownShare || tr.avgDownShare <= 0) continue;
        push(tr, tr.date, "critical", reason("avgDown", { pct: Math.round(tr.avgDownShare * 100) }),
          { avgDownShare: tr.avgDownShare }, tr.netPnl == null ? null : r2(tr.netPnl * tr.avgDownShare));
      }
      break;
    }
    case "banned_tickers": {
      const list = Array.isArray(t.tickers) ? (t.tickers as unknown[]).map((x) => String(x).toUpperCase()) : [];
      if (!list.length) break;
      for (const tr of trades) {
        const tk = (tr.ticker ?? "").toUpperCase();
        if (tk && list.includes(tk)) push(tr, tr.date, "high", reason("banned", { ticker: tk }), { ticker: tk }, netOf(tr));
      }
      break;
    }
    case "self_check":
      // Самооценка не проверяется по сделкам: см. evalSelfCheck.
      break;
  }
  return out;
}

export interface SelfMark {
  ruleId: number;
  day: string;
  ok: boolean | null;
  note?: string | null;
}

/** Reason of a self-check violation (the trader marked «нарушил», optionally with a note — user content). */
export function selfCheckReason(note: string | null | undefined): { msg: ViolationMsg; message: string } {
  return note ? reason("selfNote", { note }) : reason("self");
}

/** Нарушения правила-самооценки: дни, где трейдер отметил «нарушил». */
export function evalSelfCheck(rule: RuleRow, trader: string, marks: SelfMark[]): ViolationDraft[] {
  return marks
    .filter((m) => m.ruleId === rule.id && m.ok === false)
    .map((m) => ({
      ruleId: rule.id, trader, tradeId: null, day: m.day, key: `d:${trader}:${m.day}`, severity: "medium" as Severity,
      ...selfCheckReason(m.note),
      details: { selfCheck: true }, costNet: null, impactNet: null,
    }));
}

/** Есть ли у сделки данные, нужные виду правила (для честного «не проверяемо» вместо «100%»). */
export function coversTrade(needs: readonly string[], t: TradeForRule): boolean {
  for (const need of needs) {
    switch (need) {
      case "pnl": if (t.netPnl == null) return false; break;
      case "time": if (t.entryMin == null) return false; break;
      case "hold": if (t.holdSec == null) return false; break;
      case "size": if (notionalOf(t) == null) return false; break;
      case "qty": if (t.qty == null || t.qty <= 0) return false; break;
      case "executions": if ((t.execFills ?? 0) < 3) return false; break;
      case "stop": if (riskOf(t) == null) return false; break;
      case "checklist": if (t.source === "propreports") return false; break;
    }
  }
  return true;
}

/** Доля позиции, добранная против себя по худшей цене (по исполнениям сделки). */
export function averagingDownShare(side: "long" | "short" | null | undefined, execs: { kind: string; price: number; qty: number | null }[]): number {
  if (!side || execs.length < 3) return 0;
  let pos = 0;
  let cost = 0;
  let maxPos = 0;
  let badQty = 0;
  for (const e of execs) {
    const q = Math.abs(e.qty ?? 0);
    if (!q || !(e.price > 0)) continue;
    if (e.kind === "entry" || e.kind === "add") {
      if (e.kind === "add" && pos > 0) {
        const avg = cost / pos;
        const worse = side === "long" ? e.price < avg : e.price > avg;
        if (worse) badQty += q;
      }
      pos += q;
      cost += q * e.price;
      maxPos = Math.max(maxPos, pos);
    } else {
      const avg = pos > 0 ? cost / pos : 0;
      pos = Math.max(0, pos - q);
      cost = avg * pos;
    }
  }
  return maxPos > 0 ? Math.round((badQty / maxPos) * 100) / 100 : 0;
}
