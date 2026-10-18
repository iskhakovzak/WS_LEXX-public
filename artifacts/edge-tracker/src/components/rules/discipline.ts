import { addDays, nyDate } from "@/lib/trading-date";
import type { DisciplineTrade, Mistake, Violation } from "./types";
import { fmtDate } from "@/lib/format";
import { rulesI18n } from "@/i18n/ns/rules";
import { mistakeLabel } from "./constants";

export type DayStat = {
  date: string;
  trades: number;
  brokenTrades: number;
  violations: number;
  mistakes: number;
  r: number;
  /** Net $ for the day (gross − |fees|). */
  pnl: number;
  clean: boolean;
};

export type WeekStat = { week: string; label: string; violations: number; mistakes: number; trades: number };

export type BrokenItem = {
  key: string;
  label: string;
  source: "rule" | "mistake";
  count: number;
  trades: number;
  r: number | null;
  /** Net $ over the linked trades. */
  pnl: number | null;
  lastDate: string | null;
};

export type DisciplineSummary = {
  days: Map<string, DayStat>;
  activeDays: number;
  cleanDays: number;
  adherence: number | null;
  tradeCount: number;
  cleanTradeCount: number;
  tradeAdherence: number | null;
  currentStreak: number;
  bestStreak: number;
  violations: number;
  mistakes: number;
  unresolved: number;
  /** Σ negative R over broken trades (null without R). */
  costR: number | null;
  /** Σ negative net $ over broken trades (null without $). */
  costUsd: number | null;
  /** Σ cost_net the rules engine attributed to violations (what the breaches cost, net $). */
  violationCostUsd: number | null;
  brokenAvgR: number | null;
  cleanAvgR: number | null;
  weekly: WeekStat[];
  top: BrokenItem[];
};

/** Trading day (NY) a violation belongs to. */
export function violationDay(v: Violation): string {
  return v.day ?? v.tradeCloseDate ?? v.tradeDate ?? nyDate(new Date(v.occurredAt));
}

export function mistakeDate(m: Mistake): string {
  if (m.tradeDate) return m.tradeDate.slice(0, 10);
  const d = new Date(m.createdAt);
  return Number.isNaN(d.getTime()) ? m.createdAt.slice(0, 10) : nyDate(d);
}

/** Monday of the week containing `dateStr` (YYYY-MM-DD, calendar arithmetic only). */
export function mondayOf(dateStr: string): string {
  const dow = (new Date(`${dateStr}T12:00:00Z`).getUTCDay() + 6) % 7; // 0 = Monday
  return addDays(dateStr, -dow);
}

function avg(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function summarize(
  trades: DisciplineTrade[],
  mistakesAll: Mistake[],
  violationsAll: Violation[],
  from: string,
): DisciplineSummary {
  const today = nyDate();
  const mistakes = mistakesAll.filter((m) => mistakeDate(m) >= from);
  // Dismissed violations are not discipline breaches any more.
  const violations = violationsAll.filter((v) => v.resolution !== "dismissed" && violationDay(v) >= from);

  const days = new Map<string, DayStat>();
  const day = (date: string) => {
    let s = days.get(date);
    if (!s) {
      s = { date, trades: 0, brokenTrades: 0, violations: 0, mistakes: 0, r: 0, pnl: 0, clean: true };
      days.set(date, s);
    }
    return s;
  };

  // Count a trade as broken by the violations still standing (not by the server's raw count).
  const activeViolationsByTrade = new Map<number, number>();
  for (const v of violations) {
    if (v.tradeId != null) activeViolationsByTrade.set(v.tradeId, (activeViolationsByTrade.get(v.tradeId) ?? 0) + 1);
  }

  const brokenR: number[] = [];
  const cleanR: number[] = [];
  let costR = 0, costUsd = 0, hasR = false, hasPnl = false;
  let violationCost = 0, hasViolationCost = false;
  let violationCount = 0;
  let cleanTradeCount = 0;

  for (const t of trades) {
    const s = day(t.closeDate || t.date);
    s.trades++;
    const tv = activeViolationsByTrade.get(t.id) ?? 0;
    s.violations += tv;
    violationCount += tv;
    if (t.rMultiple != null) s.r += t.rMultiple;
    if (t.netPnl != null) s.pnl += t.netPnl;
    const broken = tv > 0 || t.mistakes > 0;
    if (broken) {
      s.brokenTrades++;
      s.clean = false;
      if (t.rMultiple != null) {
        brokenR.push(t.rMultiple);
        hasR = true;
        if (t.rMultiple < 0) costR += t.rMultiple;
      }
      if (t.netPnl != null) {
        hasPnl = true;
        if (t.netPnl < 0) costUsd += t.netPnl;
      }
    } else {
      cleanTradeCount++;
      if (t.rMultiple != null) cleanR.push(t.rMultiple);
    }
  }
  for (const v of violations) {
    if (v.costNet != null) { violationCost += v.costNet; hasViolationCost = true; }
    // Day-level violations (no trade) still break the day.
    if (v.tradeId == null) {
      const s = day(violationDay(v));
      s.violations++;
      violationCount++;
      s.clean = false;
    }
  }
  for (const m of mistakes) {
    const s = day(mistakeDate(m));
    s.mistakes++;
    s.clean = false;
  }

  const sortedDays = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  const cleanDays = sortedDays.filter((d) => d.clean).length;
  let best = 0, run = 0;
  for (const d of sortedDays) {
    run = d.clean ? run + 1 : 0;
    best = Math.max(best, run);
  }
  let current = 0;
  for (let i = sortedDays.length - 1; i >= 0; i--) {
    if (!sortedDays[i].clean) break;
    current++;
  }

  // Weekly frequency (Mon-based weeks covering the whole window).
  const weekly: WeekStat[] = [];
  const weekIdx = new Map<string, WeekStat>();
  for (let w = mondayOf(from); w <= today; w = addDays(w, 7)) {
    const ws: WeekStat = {
      week: w,
      label: fmtDate(w, "dayMonth"),
      violations: 0, mistakes: 0, trades: 0,
    };
    weekly.push(ws);
    weekIdx.set(w, ws);
  }
  for (const d of sortedDays) {
    const ws = weekIdx.get(mondayOf(d.date));
    if (!ws) continue;
    ws.violations += d.violations;
    ws.mistakes += d.mistakes;
    ws.trades += d.trades;
  }

  // Most broken: rules (auto) + mistake categories (manual), with cost on linked trades.
  const tradeById = new Map(trades.map((t) => [t.id, t]));
  const groups = new Map<string, { item: BrokenItem; tradeIds: Set<number> }>();
  const bump = (key: string, label: string, source: BrokenItem["source"], tradeId: number | null, date: string) => {
    let g = groups.get(key);
    if (!g) {
      g = { item: { key, label, source, count: 0, trades: 0, r: null, pnl: null, lastDate: null }, tradeIds: new Set() };
      groups.set(key, g);
    }
    g.item.count++;
    if (!g.item.lastDate || date > g.item.lastDate) g.item.lastDate = date;
    if (tradeId != null) g.tradeIds.add(tradeId);
  };
  for (const v of violations) {
    bump(`rule:${v.ruleId}`, v.ruleName ?? rulesI18n.t("ruleFallback"), "rule", v.tradeId, violationDay(v));
  }
  for (const m of mistakes) {
    bump(`m:${m.errorType}`, mistakeLabel(m.errorType), "mistake", m.tradeId, mistakeDate(m));
  }
  const rOf = (id: number): { r: number | null; pnl: number | null } => {
    const t = tradeById.get(id);
    if (t) return { r: t.rMultiple, pnl: t.netPnl };
    const v = violations.find((x) => x.tradeId === id);
    if (v) return { r: v.tradeR ?? null, pnl: v.tradeNetPnl ?? v.tradePnl ?? null };
    const m = mistakes.find((x) => x.tradeId === id);
    return { r: m?.tradeR ?? null, pnl: m?.tradePnl ?? null };
  };
  for (const g of groups.values()) {
    g.item.trades = g.tradeIds.size;
    let r = 0, p = 0, anyR = false, anyP = false;
    for (const id of g.tradeIds) {
      const x = rOf(id);
      if (x.r != null) { r += x.r; anyR = true; }
      if (x.pnl != null) { p += x.pnl; anyP = true; }
    }
    g.item.r = anyR ? r : null;
    g.item.pnl = anyP ? p : null;
  }
  const top = [...groups.values()].map((g) => g.item).sort((a, b) => b.count - a.count || (a.r ?? 0) - (b.r ?? 0));

  return {
    days,
    activeDays: sortedDays.length,
    cleanDays,
    adherence: sortedDays.length ? cleanDays / sortedDays.length : null,
    tradeCount: trades.length,
    cleanTradeCount,
    tradeAdherence: trades.length ? cleanTradeCount / trades.length : null,
    currentStreak: current,
    bestStreak: best,
    violations: violationCount,
    mistakes: mistakes.length,
    unresolved: mistakesAll.filter((m) => m.resolved !== "yes").length,
    costR: hasR ? costR : null,
    costUsd: hasPnl ? costUsd : null,
    violationCostUsd: hasViolationCost ? violationCost : null,
    brokenAvgR: avg(brokenR),
    cleanAvgR: avg(cleanR),
    weekly,
    top,
  };
}

/** Weekday-only calendar grid (Mon–Fri rows) for the last `weeks` weeks, oldest column first. */
export function calendarWeeks(weeks: number): string[][] {
  const today = nyDate();
  const start = addDays(mondayOf(today), -7 * (weeks - 1));
  const cols: string[][] = [];
  for (let w = 0; w < weeks; w++) {
    const col: string[] = [];
    for (let d = 0; d < 5; d++) col.push(addDays(start, w * 7 + d));
    cols.push(col);
  }
  return cols;
}

// ─── Archive (violations kept with comments when a rule is disabled / deleted or no longer produced) ───────────

/** Active violations, plus the archived ones when «Показать архив» is on (active first, deduped by id). */
export function withArchive(active: readonly Violation[], archived: readonly Violation[], show: boolean): Violation[] {
  if (!show || archived.length === 0) return active as Violation[];
  const ids = new Set(active.map((v) => v.id));
  return [...active, ...archived.filter((a) => !ids.has(a.id))];
}

/** Violations that count (statistics, «новые», $ cost): archived rows never do. */
export function countedViolations(list: readonly Violation[]): Violation[] {
  return list.filter((v) => !v.archived);
}
