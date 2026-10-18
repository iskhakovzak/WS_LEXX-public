/**
 * Отчёт дисциплины по правилам за период — чистая агрегация (без БД), считается «на лету» при каждом запросе,
 * поэтому всегда совпадает со свежими сделками из бэк-офиса и не требует ручного «пересканировать».
 *
 * По каждому правилу:
 *   - соблюдение % по торговым дням (только дни, где у сделок есть нужные правилу данные) и % по сделкам;
 *   - тренд: соблюдение по неделям + последние 20 торговых дней против предыдущих 20;
 *   - цена: Σ impactNet нарушений (контрфактическая оценка, см. lib/rulesEval), нетто сделок-нарушений против
 *     остальных сделок (среднее на сделку), для самооценки — средний день «нарушил» против «соблюдал»;
 *   - примеры нарушений (сначала самые дорогие) со ссылками на сделку / разбор дня.
 * Плюс календарь дисциплины по дням, серии чистых дней и подсказки параметров для шаблонов (по истории трейдера).
 */
import { kindMeta, describeThreshold } from "./rulesCatalog";
import { renderViolation } from "./rulesI18n";
import type { Lang } from "../i18n";
import { coversTrade, evalRule, evalSelfCheck, notionalOf, type RiskLimits, type RuleRow, type SelfMark, type Severity, type TradeForRule, type ViolationDraft } from "./rulesEval";
import { addDays } from "./tradingDate";

export interface ReportRuleInput extends RuleRow {
  origin: "personal" | "office";
  desk: boolean;
  note: string | null;
  createdBy: string | null;
  createdAt?: string | null;
}

export interface PersistedViolation { id: number; status: "open" | "acknowledged" | "resolved"; resolution: string | null }

export interface ReportInput {
  trader: string;
  rules: ReportRuleInput[];
  /** Все сделки трейдера (не только окно: серии через дни), отсортированы по дню и времени входа. */
  trades: TradeForRule[];
  limits: RiskLimits;
  from: string;
  to: string;
  marks: SelfMark[];
  /** `${ruleId}:${key}` → сохранённое нарушение (статус разбора). */
  persisted?: Map<string, PersistedViolation>;
  /** Language of labels, summaries and violation texts (default ru). */
  lang?: Lang;
}

export interface SideStats { n: number; net: number; avg: number | null }

export interface ViolationExample {
  key: string;
  tradeId: number | null;
  ticker: string | null;
  day: string;
  net: number | null;
  impact: number | null;
  message: string;
  severity: Severity;
  violationId: number | null;
  status: string | null;
}

export interface WeekPoint { week: string; days: number; violatedDays: number; compliance: number | null; violations: number }

export interface RuleReport {
  id: number;
  name: string;
  kind: string;
  kindLabel: string;
  group: string;
  auto: boolean;
  origin: "personal" | "office";
  desk: boolean;
  trader: string;
  note: string | null;
  createdBy: string | null;
  enabled: boolean;
  threshold: Record<string, unknown>;
  summary: string;
  /** checked — есть данные; no_data — у сделок периода нет нужных полей; no_marks — самооценка без отметок; disabled. */
  status: "checked" | "no_data" | "no_marks" | "disabled";
  /** Сравнение «нарушения против остальных»: по сделкам (авто) или по дням (самооценка). */
  unit: "trade" | "day";
  days: number;
  violatedDays: number;
  compliance: number | null;
  tradeCompliance: number | null;
  coveredTrades: number;
  violations: number;
  broken: SideStats;
  clean: SideStats;
  /** Σ impactNet: отрицательное — правило «стоит тебе» столько. */
  impact: number | null;
  /** (средняя сделка с нарушением − средняя чистая) × число нарушений: вторая, «статистическая» оценка. */
  edgeGap: number | null;
  recentCompliance: number | null;
  prevCompliance: number | null;
  weekly: WeekPoint[];
  lastViolation: string | null;
  cleanStreak: number;
  unmarkedDays: number;
  examples: ViolationExample[];
}

export interface CalendarDay {
  day: string;
  trades: number;
  net: number;
  violations: number;
  ruleIds: number[];
  clean: boolean;
  worst: Severity | null;
  selfMarked: number;
}

export interface RulesReport {
  trader: string;
  from: string;
  to: string;
  totals: {
    tradingDays: number;
    cleanDays: number;
    compliance: number | null;
    trades: number;
    broken: SideStats;
    clean: SideStats;
    impact: number | null;
    currentStreak: number;
    bestStreak: number;
    activeRules: number;
    autoRules: number;
    selfRules: number;
    recentCompliance: number | null;
    prevCompliance: number | null;
    weekly: WeekPoint[];
  };
  rules: RuleReport[];
  calendar: CalendarDay[];
  stats: {
    medianTradesPerDay: number | null;
    p90TradesPerDay: number | null;
    p95Qty: number | null;
    p95Notional: number | null;
    p90Loss: number | null;
    medianHoldSec: number | null;
    withTime: number;
    withSize: number;
    withExecutions: number;
  };
}

const SEV_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3, critical: 4 };
const r2 = (v: number) => Math.round(v * 100) / 100;

export function mondayOf(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return addDays(day, -dow);
}

function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function side(trades: TradeForRule[]): SideStats {
  let net = 0;
  let k = 0;
  for (const t of trades) if (t.netPnl != null) { net += t.netPnl; k++; }
  return { n: trades.length, net: r2(net), avg: k ? r2(net / k) : null };
}

function dayStats(days: string[], netByDay: Map<string, number>): SideStats {
  let net = 0;
  for (const d of days) net += netByDay.get(d) ?? 0;
  return { n: days.length, net: r2(net), avg: days.length ? r2(net / days.length) : null };
}

function weeksBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let w = mondayOf(from); w <= to; w = addDays(w, 7)) out.push(w);
  return out;
}

function compliance(days: string[], violated: Set<string>): number | null {
  if (!days.length) return null;
  let bad = 0;
  for (const d of days) if (violated.has(d)) bad++;
  return r2(1 - bad / days.length);
}

function weekly(weeks: string[], days: string[], violated: Set<string>, countByDay: Map<string, number>): WeekPoint[] {
  const byWeek = new Map<string, string[]>();
  for (const d of days) {
    const w = mondayOf(d);
    if (!byWeek.has(w)) byWeek.set(w, []);
    byWeek.get(w)!.push(d);
  }
  return weeks.map((w) => {
    const ds = byWeek.get(w) ?? [];
    const vd = ds.filter((d) => violated.has(d)).length;
    return { week: w, days: ds.length, violatedDays: vd, compliance: ds.length ? r2(1 - vd / ds.length) : null, violations: ds.reduce((s, d) => s + (countByDay.get(d) ?? 0), 0) };
  });
}

function streaks(days: string[], violated: Set<string>): { current: number; best: number } {
  let best = 0;
  let run = 0;
  for (const d of days) {
    run = violated.has(d) ? 0 : run + 1;
    best = Math.max(best, run);
  }
  let current = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (violated.has(days[i])) break;
    current++;
  }
  return { current, best };
}

/** Последние 20 торговых дней против предыдущих 20 (соблюдение). */
function recentVsPrev(days: string[], violated: Set<string>): { recent: number | null; prev: number | null } {
  const recent = days.slice(-20);
  const prev = days.slice(-40, -20);
  return { recent: compliance(recent, violated), prev: prev.length >= 5 ? compliance(prev, violated) : null };
}

export function buildRulesReport(input: ReportInput): RulesReport {
  const { trader, rules, trades, limits, from, to, marks } = input;
  const inWindow = (d: string) => d >= from && d <= to;
  const windowTrades = trades.filter((t) => inWindow(t.closeDate));
  const tradeById = new Map(trades.map((t) => [t.id, t]));
  const netByDay = new Map<string, number>();
  const tradesByDay = new Map<string, number>();
  for (const t of windowTrades) {
    tradesByDay.set(t.closeDate, (tradesByDay.get(t.closeDate) ?? 0) + 1);
    if (t.netPnl != null) netByDay.set(t.closeDate, (netByDay.get(t.closeDate) ?? 0) + t.netPnl);
  }
  const windowMarks = marks.filter((m) => inWindow(m.day) && m.ok != null);
  const daySet = new Set<string>(windowTrades.map((t) => t.closeDate));
  for (const m of windowMarks) daySet.add(m.day);
  const tradingDays = [...daySet].sort();
  const weeks = weeksBetween(from, to);

  const allViolatedDays = new Set<string>();
  const brokenAll = new Map<number, number>(); // tradeId → min impact
  const calViol = new Map<string, { count: number; rules: Set<number>; worst: Severity | null }>();
  const ruleReports: RuleReport[] = [];

  for (const rule of rules) {
    const meta = kindMeta(rule.kind, input.lang);
    const auto = meta ? meta.auto : true;
    const base = {
      id: rule.id, name: rule.name, kind: rule.kind, kindLabel: meta?.label ?? rule.kind, group: meta?.group ?? "process", auto,
      origin: rule.origin, desk: rule.desk, trader: rule.trader, note: rule.note, createdBy: rule.createdBy, enabled: rule.enabled,
      threshold: rule.threshold ?? {}, summary: describeThreshold(rule.kind, rule.threshold, limits, input.lang),
    };
    const empty: SideStats = { n: 0, net: 0, avg: null };
    if (!rule.enabled) {
      ruleReports.push({
        ...base, status: "disabled", unit: auto ? "trade" : "day", days: 0, violatedDays: 0, compliance: null, tradeCompliance: null, coveredTrades: 0,
        violations: 0, broken: empty, clean: empty, impact: null, edgeGap: null, recentCompliance: null, prevCompliance: null,
        weekly: [], lastViolation: null, cleanStreak: 0, unmarkedDays: 0, examples: [],
      });
      continue;
    }

    let drafts: ViolationDraft[];
    let applicableDays: string[];
    let coveredTrades: TradeForRule[];
    let unmarkedDays = 0;
    if (auto) {
      drafts = evalRule(rule, trades, limits).filter((d) => inWindow(d.day));
      const needs = meta?.needs ?? [];
      coveredTrades = windowTrades.filter((t) => coversTrade(needs, t));
      const covDays = new Set(coveredTrades.map((t) => t.closeDate));
      for (const d of drafts) covDays.add(d.day);
      applicableDays = needs.length ? [...covDays].sort() : tradingDays.filter((d) => tradesByDay.has(d) || covDays.has(d));
    } else {
      drafts = evalSelfCheck(rule, trader, windowMarks);
      const marked = new Set(windowMarks.filter((m) => m.ruleId === rule.id).map((m) => m.day));
      applicableDays = [...marked].sort();
      coveredTrades = windowTrades.filter((t) => marked.has(t.closeDate));
      unmarkedDays = tradingDays.filter((d) => tradesByDay.has(d) && !marked.has(d)).length;
    }

    const violated = new Set(drafts.map((d) => d.day));
    const countByDay = new Map<string, number>();
    for (const d of drafts) {
      countByDay.set(d.day, (countByDay.get(d.day) ?? 0) + 1);
      allViolatedDays.add(d.day);
      const c = calViol.get(d.day) ?? { count: 0, rules: new Set<number>(), worst: null };
      c.count++;
      c.rules.add(rule.id);
      if (!c.worst || SEV_RANK[d.severity] > SEV_RANK[c.worst]) c.worst = d.severity;
      calViol.set(d.day, c);
      if (d.tradeId != null) {
        const prev = brokenAll.get(d.tradeId);
        const imp = d.impactNet ?? 0;
        brokenAll.set(d.tradeId, prev == null ? imp : Math.min(prev, imp));
      }
    }

    const brokenIds = new Set(drafts.map((d) => d.tradeId).filter((x): x is number => x != null));
    let broken: SideStats;
    let clean: SideStats;
    let unit: "trade" | "day";
    if (auto) {
      unit = "trade";
      broken = side(windowTrades.filter((t) => brokenIds.has(t.id)));
      clean = side(coveredTrades.filter((t) => !brokenIds.has(t.id)));
    } else {
      unit = "day";
      broken = dayStats(applicableDays.filter((d) => violated.has(d)), netByDay);
      clean = dayStats(applicableDays.filter((d) => !violated.has(d)), netByDay);
    }

    const impacts = drafts.map((d) => d.impactNet).filter((x): x is number => x != null);
    const impact = auto && impacts.length ? r2(impacts.reduce((a, b) => a + b, 0)) : auto && drafts.length === 0 ? 0 : null;
    const edgeGap = broken.avg != null && clean.avg != null && broken.n > 0 ? r2((broken.avg - clean.avg) * broken.n) : null;
    const rv = recentVsPrev(applicableDays, violated);
    const st = streaks(applicableDays, violated);
    const examples: ViolationExample[] = [...drafts]
      .sort((a, b) => (a.impactNet ?? 0) - (b.impactNet ?? 0) || b.day.localeCompare(a.day))
      .slice(0, 8)
      .map((d) => {
        const tr = d.tradeId != null ? tradeById.get(d.tradeId) : undefined;
        const p = input.persisted?.get(`${rule.id}:${d.key}`);
        return {
          key: d.key, tradeId: d.tradeId, ticker: tr?.ticker ?? null, day: d.day, net: tr?.netPnl ?? null, impact: d.impactNet ?? null,
          message: input.lang && input.lang !== "ru" ? (renderViolation(d.msg, input.lang) ?? d.message) : d.message, severity: d.severity, violationId: p?.id ?? null, status: p ? (p.resolution === "dismissed" ? "dismissed" : p.status) : null,
        };
      });
    const status: RuleReport["status"] = !auto ? (applicableDays.length ? "checked" : "no_marks") : coveredTrades.length || drafts.length ? "checked" : windowTrades.length ? "no_data" : "checked";

    ruleReports.push({
      ...base,
      status,
      unit,
      days: applicableDays.length,
      violatedDays: violated.size,
      compliance: status === "checked" ? compliance(applicableDays, violated) : null,
      tradeCompliance: auto && coveredTrades.length ? r2(1 - Math.min(brokenIds.size, coveredTrades.length) / coveredTrades.length) : null,
      coveredTrades: coveredTrades.length,
      violations: drafts.length,
      broken,
      clean,
      impact: status === "checked" ? impact : null,
      edgeGap,
      recentCompliance: status === "checked" ? rv.recent : null,
      prevCompliance: status === "checked" ? rv.prev : null,
      weekly: weekly(weeks, applicableDays, violated, countByDay),
      lastViolation: drafts.length ? drafts.reduce((m, d) => (d.day > m ? d.day : m), drafts[0].day) : null,
      cleanStreak: st.current,
      unmarkedDays,
      examples,
    });
  }

  // ── Итоги ─────────────────────────────────────────────────────────────────────────────────────
  const brokenTrades = windowTrades.filter((t) => brokenAll.has(t.id));
  const cleanTrades = windowTrades.filter((t) => !brokenAll.has(t.id));
  const impactsAll = [...brokenAll.values()];
  const active = ruleReports.filter((r) => r.enabled);
  const st = streaks(tradingDays, allViolatedDays);
  const rv = recentVsPrev(tradingDays, allViolatedDays);
  const countAll = new Map<string, number>();
  for (const [d, c] of calViol) countAll.set(d, c.count);

  const calendar: CalendarDay[] = tradingDays.map((day) => {
    const c = calViol.get(day);
    return {
      day,
      trades: tradesByDay.get(day) ?? 0,
      net: r2(netByDay.get(day) ?? 0),
      violations: c?.count ?? 0,
      ruleIds: c ? [...c.rules] : [],
      clean: !c,
      worst: c?.worst ?? null,
      selfMarked: windowMarks.filter((m) => m.day === day).length,
    };
  });

  // ── Подсказки параметров по истории ─────────────────────────────────────────────────────────
  const perDay = [...tradesByDay.values()];
  const qtys = windowTrades.map((t) => t.qty).filter((x): x is number => x != null && x > 0);
  const notionals = windowTrades.map((t) => notionalOf(t)).filter((x): x is number => x != null);
  const losses = windowTrades.map((t) => t.netPnl).filter((x): x is number => x != null && x < 0).map((x) => -x);
  const holds = windowTrades.map((t) => t.holdSec).filter((x): x is number => x != null);
  const rnd = (v: number | null, step = 1) => (v == null ? null : Math.round(v / step) * step);

  return {
    trader,
    from,
    to,
    totals: {
      tradingDays: tradingDays.length,
      cleanDays: tradingDays.filter((d) => !allViolatedDays.has(d)).length,
      compliance: active.length ? compliance(tradingDays, allViolatedDays) : null,
      trades: windowTrades.length,
      broken: side(brokenTrades),
      clean: side(cleanTrades),
      impact: active.some((r) => r.auto) ? r2(impactsAll.reduce((a, b) => a + b, 0)) : null,
      currentStreak: st.current,
      bestStreak: st.best,
      activeRules: active.length,
      autoRules: active.filter((r) => r.auto).length,
      selfRules: active.filter((r) => !r.auto).length,
      recentCompliance: active.length ? rv.recent : null,
      prevCompliance: active.length ? rv.prev : null,
      weekly: weekly(weeks, tradingDays, allViolatedDays, countAll),
    },
    rules: ruleReports,
    calendar,
    stats: {
      medianTradesPerDay: rnd(quantile(perDay, 0.5)),
      p90TradesPerDay: rnd(quantile(perDay, 0.9)),
      p95Qty: rnd(quantile(qtys, 0.95), 10),
      p95Notional: rnd(quantile(notionals, 0.95), 500),
      p90Loss: rnd(quantile(losses, 0.9), 5),
      medianHoldSec: rnd(quantile(holds, 0.5)),
      withTime: windowTrades.filter((t) => t.entryMin != null).length,
      withSize: windowTrades.filter((t) => notionalOf(t) != null).length,
      withExecutions: windowTrades.filter((t) => (t.execFills ?? 0) >= 3).length,
    },
  };
}

/** Предпросмотр одного (ещё не созданного) правила: сколько нарушений и сколько они стоили бы за период. */
export function previewRule(rule: ReportRuleInput, input: Omit<ReportInput, "rules">): RuleReport {
  const rep = buildRulesReport({ ...input, rules: [rule] });
  return rep.rules[0];
}
