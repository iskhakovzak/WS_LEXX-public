/**
 * Поведенческий движок «Поведение» — чистые функции без I/O (routes/behavior.ts подаёт сделки из БД,
 * офлайн-проверка в scratchpad подаёт сделки из JSON). Никаких LLM: только детерминированные правила.
 *
 * Деньги — всегда нетто ($, pnl − |fees| из lib/tradeMath); R не требуется (у брокерских сделок стопа нет).
 * Торговая дата = дата NY; время входа/выхода — из исполнений (trade_executions), иначе из снапшота PropReports.
 *
 * Паттерны (каждый: частота, $-стоимость vs норма трейдера, примеры, severity, тренд по неделям):
 *   revenge      — новая сделка < N мин после убытка (усиливается размером / тем же тикером);
 *   martingale   — рост размера после убытка (мартингейл);
 *   overtrading  — сделок за день выше личной нормы (медиана + k·MAD);
 *   fatigue      — ухудшение результата к концу дня (по номеру сделки и по часу);
 *   chase        — «отыгрыш» после красного утра (сделки после 11:00 в дни с убытком до 11:00);
 *   tilt         — кластер ≥3 убытков подряд с ускорением частоты сделок после него;
 *   disposition  — ранний выход из прибыльных / пересиживание убыточных;
 *   firstTrade   — первая сделка дня против остальных;
 *   euphoria     — хуже результат после крупного выигрыша.
 *
 * Стоимость паттерна = Σ нетто сделок в паттерне − n × средний нетто сравнимой группы («норма»).
 * Отрицательная стоимость = паттерн стоил денег.
 */

import { insightFor, type PatternInsight } from "./behaviorInsights";
import { behaviorT, fmtDurFor } from "./behaviorI18n";
import { DEFAULT_LANG, type Lang } from "../i18n";

export type BehaviorResult = "win" | "loss" | "be" | "open" | null;

export type BehaviorTrade = {
  id: number;
  ticker: string;
  /** Торговая дата NY (YYYY-MM-DD) — день входа. */
  date: string;
  side: "long" | "short" | null;
  result: BehaviorResult;
  /** Нетто $ (pnl − |fees|), null если P&L не заполнен. */
  net: number | null;
  gross: number | null;
  qty: number | null;
  entry: number | null;
  /** Время входа / выхода, epoch ms (UTC). */
  entryAt: number | null;
  exitAt: number | null;
  /** Минуты от полуночи NY для входа (9:30 → 570). */
  entryMin: number | null;
  holdMin: number | null;
  horizon: "intraday" | "overnight" | "swing";
  setup: string | null;
  /** true — сетап взят из авто-классификатора (trade_setup_suggestions), а не из сделки. */
  setupAuto?: boolean;
};

export type PatternKey =
  | "revenge" | "martingale" | "overtrading" | "fatigue" | "chase" | "tilt" | "disposition" | "firstTrade" | "euphoria";

export type Severity = "none" | "low" | "medium" | "high";

export type PatternExample = { id: number; ticker: string; date: string; net: number | null; note: string; entryMin: number | null };

export type TrendDirection = "better" | "worse" | "flat" | "insufficient";
export type TrendWindow = { from: string | null; to: string | null; days: number; trades: number; n: number; cost: number | null; costPerDay: number | null; rate: number | null };
/** Последние 30 дней периода против всего, что раньше. */
export type PatternTrend = { recent: TrendWindow; prior: TrendWindow; direction: TrendDirection };
export type WeekPoint = { week: string; n: number; cost: number | null; net: number | null };

export type PatternReport = {
  key: PatternKey;
  title: string;
  description: string;
  /** Сколько сделок попало в паттерн. */
  n: number;
  /** Доля от всех сделок периода. */
  share: number;
  /** Сколько торговых дней затронуто. */
  days: number;
  /** Σ нетто сделок в паттерне (null если нет P&L). */
  net: number | null;
  avgNet: number | null;
  /** Средний нетто сравнимой группы (норма). */
  baselineAvg: number | null;
  baselineLabel: string;
  /** Стоимость = net − n × baselineAvg; отрицательная = паттерн стоил денег. */
  cost: number | null;
  severity: Severity;
  winRate: number | null;
  examples: PatternExample[];
  /** Все id сделок паттерна (для ссылки /trades?ids=…), не больше 300. */
  tradeIds: number[];
  weekly: WeekPoint[];
  /** Параметры/пояснение правила (для UI). */
  rule: string;
  /** Доп. метрики паттерна (например, средние удержания). */
  extra: Record<string, number | string | null>;
  /** Последние 30 дней vs раньше (по стоимости на торговый день, без стоимости — по частоте). */
  trend: PatternTrend;
  /** Почему вредит + правило-рекомендация + действие «Сделать правилом». */
  insight: PatternInsight;
};

/** `key` is a stable code of the bucket (hour / minutes-after-loss curves); `label` is in the reader's language. */
export type Bucket = { key?: string; label: string; n: number; net: number | null; avgNet: number | null; winRate: number | null };

export type DisciplineDay = {
  date: string;
  score: number;
  trades: number;
  net: number | null;
  /** Штрафные баллы по компонентам (положительные числа). */
  penalties: Partial<Record<PatternKey, number>>;
  /** Own-contract verdict points of the day (lib/daily DISCIPLINE_POINTS; kept +, broken −), when a contract was set. */
  contract?: number;
};

export type BehaviorOptions = {
  /** Порог «реванша»: минут после убытка. */
  revengeMin?: number;
  /** Множитель MAD для нормы сделок/день. */
  overtradingK?: number;
  /** Множитель размера для мартингейла. */
  martingaleRatio?: number;
  /** Окно эйфории после крупного выигрыша, минут. */
  euphoriaMin?: number;
  /** Граница «утра» для отыгрыша, минуты NY (11:00 = 660). */
  morningEndMin?: number;
};

export type BehaviorReport = {
  options: Required<BehaviorOptions>;
  summary: {
    trades: number;
    closed: number;
    withPnl: number;
    withTime: number;
    days: number;
    net: number | null;
    grossProfit: number;
    grossLoss: number;
    avgNet: number | null;
    medianTradesPerDay: number;
    madTradesPerDay: number;
    tradesPerDayNorm: number;
    medianGapMin: number | null;
    avgHoldWinMin: number | null;
    avgHoldLossMin: number | null;
    from: string | null;
    to: string | null;
  };
  patterns: PatternReport[];
  /** Нетто по номеру сделки внутри дня. */
  byTradeNumber: Bucket[];
  /** Нетто по минутам после убытка (сколько прошло от выхода убыточной сделки до входа). */
  byMinutesAfterLoss: Bucket[];
  /** Нетто по часу входа (NY). */
  byHour: Bucket[];
  discipline: DisciplineDay[];
  disciplineWeekly: { week: string; avg: number; days: number }[];
  disciplineFormula: string;
  disciplineAvg: number | null;
  profile: TraderProfile;
};

export type ProfileBucket = Bucket & { auto?: number };

export type TraderProfile = {
  style: {
    key: "scalper" | "intraday" | "swing" | "unknown";
    label: string;
    description: string;
    medianHoldMin: number | null;
    tradesPerDay: number;
    scalpShare: number | null;
    carryShare: number;
  };
  hours: { best: Bucket | null; worst: Bucket | null; minN: number };
  setups: { best: ProfileBucket | null; worst: ProfileBucket | null; coverage: number; autoShare: number; minN: number; rows: ProfileBucket[] };
  /** «Стоимость плохих привычек»: объединение сделок всех паттернов со стоимостью < 0 (без двойного счёта). */
  habits: {
    total: number | null;
    sumOfCosts: number;
    trades: number;
    days: number;
    baselineAvg: number | null;
    byPattern: { key: PatternKey; title: string; cost: number }[];
    monthly: { month: string; cost: number | null; n: number }[];
  };
  discipline: { avg: number | null; recent: number | null; prior: number | null; delta: number | null; direction: TrendDirection };
};

export type TimelineFlag = { key: PatternKey; note: string };
export type TimelineTrade = {
  id: number; ticker: string; side: "long" | "short" | null; result: BehaviorResult;
  net: number | null; cum: number; qty: number | null; entry: number | null;
  entryAt: number | null; exitAt: number | null; entryMin: number | null; exitMin: number | null; holdMin: number | null;
  setup: string | null; flags: TimelineFlag[];
};
export type DayTimeline = {
  date: string;
  trades: TimelineTrade[];
  summary: {
    n: number; net: number | null; wins: number; losses: number; score: number | null;
    penalties: Partial<Record<PatternKey, number>>;
    peak: number; trough: number;
    /** Момент срыва: первая сделка с поведенческим флагом (реванш / тильт / мартингейл / эйфория / отыгрыш). */
    breakdown: { id: number; entryMin: number | null; key: PatternKey; note: string; cumBefore: number; netAfter: number | null } | null;
  };
  norms: { tradesPerDayNorm: number; medianGapMin: number | null; revengeMin: number; euphoriaMin: number };
};

const DEFAULTS: Required<BehaviorOptions> = {
  revengeMin: 10,
  overtradingK: 2,
  martingaleRatio: 1.3,
  euphoriaMin: 30,
  morningEndMin: 660,
};

/** How the daily discipline index is computed (text for the UI), in `lang`. */
export function disciplineFormulaFor(lang: Lang = DEFAULT_LANG): string {
  return behaviorT.tFor(lang)("formula");
}
export const DISCIPLINE_FORMULA = disciplineFormulaFor(DEFAULT_LANG);

/* ─── Утилиты ─────────────────────────────────────────────────────────────── */

const round2 = (v: number) => Math.round(v * 100) / 100;

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Масштабированное MAD (×1.4826 ≈ σ для нормального распределения). */
export function mad(values: number[]): number {
  if (!values.length) return 0;
  const m = median(values);
  return 1.4826 * median(values.map((v) => Math.abs(v - m)));
}

function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function sumNet(trades: BehaviorTrade[]): { sum: number | null; n: number } {
  let sum = 0, n = 0;
  for (const t of trades) if (t.net != null) { sum += t.net; n++; }
  return { sum: n ? round2(sum) : null, n };
}

function avgNet(trades: BehaviorTrade[]): number | null {
  const { sum, n } = sumNet(trades);
  return sum == null ? null : sum / n;
}

function winRateOf(trades: BehaviorTrade[]): number | null {
  let w = 0, l = 0;
  for (const t of trades) { if (t.result === "win") w++; else if (t.result === "loss") l++; }
  return w + l ? w / (w + l) : null;
}

/** Понедельник ISO-недели для даты YYYY-MM-DD (календарная арифметика без таймзон). */
export function weekKey(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = (dt.getUTCDay() + 6) % 7; // Пн = 0
  dt.setUTCDate(dt.getUTCDate() - dow);
  return dt.toISOString().slice(0, 10);
}

/**
 * Текст удержания из журнала → минуты: "5m", "17s", "2h 29m", "1:30", "45 мин", "3 д", "2h".
 * Null, если не распознано.
 */
export function parseHoldText(text: string | null | undefined): number | null {
  if (!text) return null;
  const s = text.trim().toLowerCase().replace(",", ".");
  if (!s) return null;
  const clock = /^(\d{1,3}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]) + (clock[3] ? Number(clock[3]) / 60 : 0);
  let total = 0, matched = false;
  // Input parsing (journal hold text in RU / EN / UZ), not UI text.
  const re = /(\d+(?:\.\d+)?)\s*(d|day|days|kun|д|дн|h|hr|soat|ч|m|min|daq|daqiqa|мин|м|s|sec|son|soniya|сек|с)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    const v = Number(m[1]);
    const u = m[2];
    if (u === "d" || u === "day" || u === "days" || u === "kun" || u === "д" || u === "дн") total += v * 1440; // i18n-ignore (input units)
    else if (u === "h" || u === "hr" || u === "soat" || u === "ч") total += v * 60; // i18n-ignore (input units)
    else if (u === "s" || u === "sec" || u === "son" || u === "soniya" || u === "сек" || u === "с") total += v / 60; // i18n-ignore (input units)
    else total += v;
  }
  if (matched) return total;
  const bare = /^(\d+(?:\.\d+)?)$/.exec(s);
  return bare ? Number(bare[1]) : null;
}

function notional(t: BehaviorTrade): number | null {
  if (t.qty == null) return null;
  if (t.entry != null && t.entry > 0) return Math.abs(t.qty) * t.entry;
  return Math.abs(t.qty);
}

/** Сделки по дням в порядке входа (время → id). */
export function groupByDay(trades: BehaviorTrade[]): Map<string, BehaviorTrade[]> {
  const byDay = new Map<string, BehaviorTrade[]>();
  for (const t of trades) {
    if (!byDay.has(t.date)) byDay.set(t.date, []);
    byDay.get(t.date)!.push(t);
  }
  for (const list of byDay.values()) {
    list.sort((a, b) => {
      if (a.entryAt != null && b.entryAt != null && a.entryAt !== b.entryAt) return a.entryAt - b.entryAt;
      if (a.entryAt != null && b.entryAt == null) return -1;
      if (a.entryAt == null && b.entryAt != null) return 1;
      return a.id - b.id;
    });
  }
  return new Map([...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

/* ─── Severity и сборка отчёта по паттерну ────────────────────────────────── */

export function severityOf(cost: number | null, n: number, grossProfit: number): Severity {
  if (cost == null || n < 3 || cost >= 0) return "none";
  const loss = Math.abs(cost);
  if (grossProfit > 0) {
    const share = loss / grossProfit;
    return share >= 0.1 ? "high" : share >= 0.03 ? "medium" : "low";
  }
  return loss >= 500 ? "high" : loss >= 100 ? "medium" : "low";
}

type PatternDraft = {
  key: PatternKey;
  title: string;
  description: string;
  rule: string;
  /** `same` / `sizeUp`: revenge amplifiers (counted from flags, never from the note text). */
  flagged: { trade: BehaviorTrade; note: string; same?: boolean; sizeUp?: boolean }[];
  baseline: BehaviorTrade[];
  baselineLabel: string;
  extra?: Record<string, number | string | null>;
  /** true — стоимость не считается (эффект не подтверждён), severity = none. */
  noCost?: boolean;
};

/** Окна тренда: последние 30 календарных дней периода (до последней торговой даты) и всё, что раньше. */
type TrendCtx = { recentFrom: string; first: string | null; last: string | null; daysRecent: number; daysPrior: number; tradesRecent: number; tradesPrior: number };

function trendCtxOf(byDay: Map<string, BehaviorTrade[]>): TrendCtx {
  const dates = [...byDay.keys()];
  const last = dates[dates.length - 1] ?? null;
  const recentFrom = last ? shiftDate(last, -29) : "9999-12-31";
  let daysRecent = 0, daysPrior = 0, tradesRecent = 0, tradesPrior = 0;
  for (const [d, list] of byDay) {
    if (d >= recentFrom) { daysRecent++; tradesRecent += list.length; } else { daysPrior++; tradesPrior += list.length; }
  }
  return { recentFrom, first: dates[0] ?? null, last, daysRecent, daysPrior, tradesRecent, tradesPrior };
}

function trendOf(trades: BehaviorTrade[], base: number | null, noCost: boolean, tc: TrendCtx): PatternTrend {
  const win = (recent: boolean): TrendWindow => {
    const list = trades.filter((t) => (t.date >= tc.recentFrom) === recent);
    let sum = 0, withPnl = 0;
    for (const t of list) if (t.net != null) { sum += t.net; withPnl++; }
    const days = recent ? tc.daysRecent : tc.daysPrior;
    const all = recent ? tc.tradesRecent : tc.tradesPrior;
    const cost = !noCost && base != null && withPnl ? round2(sum - withPnl * base) : !noCost && base != null && days ? 0 : null;
    return {
      from: recent ? (tc.last ? tc.recentFrom : null) : tc.daysPrior ? tc.first : null,
      to: recent ? tc.last : tc.daysPrior ? shiftDate(tc.recentFrom, -1) : null,
      days, trades: all, n: list.length, cost,
      costPerDay: cost != null && days ? round2(cost / days) : null,
      rate: all ? list.length / all : null,
    };
  };
  const recent = win(true), prior = win(false);
  let direction: TrendDirection = "insufficient";
  if (recent.days >= 5 && prior.days >= 5) {
    if (recent.costPerDay != null && prior.costPerDay != null) {
      const diff = recent.costPerDay - prior.costPerDay;
      const thr = Math.max(3, 0.25 * Math.max(Math.abs(recent.costPerDay), Math.abs(prior.costPerDay)));
      direction = diff > thr ? "better" : diff < -thr ? "worse" : "flat";
    } else if (recent.rate != null && prior.rate != null) {
      const diff = recent.rate - prior.rate;
      direction = diff > 0.02 ? "worse" : diff < -0.02 ? "better" : "flat";
    }
  }
  return { recent, prior, direction };
}

function buildPattern(d: PatternDraft, total: number, grossProfit: number, tc: TrendCtx, opts: Required<BehaviorOptions>, lang: Lang): PatternReport {
  const trades = d.flagged.map((f) => f.trade);
  const { sum: net } = sumNet(trades);
  const a = avgNet(trades);
  const base = avgNet(d.baseline);
  const withPnl = trades.filter((t) => t.net != null).length;
  const cost = !d.noCost && net != null && base != null ? round2(net - withPnl * base) : null;
  const byWeek = new Map<string, { n: number; net: number; withPnl: number }>();
  for (const t of trades) {
    const k = weekKey(t.date);
    const w = byWeek.get(k) ?? { n: 0, net: 0, withPnl: 0 };
    w.n++;
    if (t.net != null) { w.net += t.net; w.withPnl++; }
    byWeek.set(k, w);
  }
  const weekly: WeekPoint[] = [...byWeek.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([week, w]) => ({
    week, n: w.n,
    net: w.withPnl ? round2(w.net) : null,
    cost: w.withPnl && base != null ? round2(w.net - w.withPnl * base) : null,
  }));
  const examples = [...d.flagged]
    .sort((x, y) => (x.trade.net ?? 0) - (y.trade.net ?? 0))
    .slice(0, 8)
    .map((f) => ({ id: f.trade.id, ticker: f.trade.ticker, date: f.trade.date, net: f.trade.net, note: f.note, entryMin: f.trade.entryMin }));
  return {
    key: d.key, title: d.title, description: d.description, rule: d.rule,
    n: trades.length,
    share: total ? trades.length / total : 0,
    days: new Set(trades.map((t) => t.date)).size,
    net, avgNet: a == null ? null : round2(a),
    baselineAvg: base == null ? null : round2(base), baselineLabel: d.baselineLabel,
    cost,
    severity: severityOf(cost, trades.length, grossProfit),
    winRate: winRateOf(trades),
    examples,
    tradeIds: trades.map((t) => t.id).slice(0, 300),
    weekly,
    extra: d.extra ?? {},
    trend: trendOf(trades, base, !!d.noCost, tc),
    insight: insightFor({ key: d.key, extra: d.extra ?? {}, opts }, lang),
  };
}

/* ─── Детекторы ────────────────────────────────────────────────────────────── */

type Ctx = {
  lang: Lang;
  t: ReturnType<typeof behaviorT.tFor>;
  trades: BehaviorTrade[];
  byDay: Map<string, BehaviorTrade[]>;
  opts: Required<BehaviorOptions>;
  medianGapMin: number | null;
  tradesPerDayNorm: number;
  medianTradesPerDay: number;
};

const minutesBetween = (fromMs: number, toMs: number) => (toMs - fromMs) / 60000;

function detectRevenge(c: Ctx): PatternDraft {
  const flagged: PatternDraft["flagged"] = [];
  const flaggedIds = new Set<number>();
  for (const day of c.byDay.values()) {
    let lastLoss: BehaviorTrade | null = null;
    for (const t of day) {
      if (lastLoss && lastLoss.exitAt != null && t.entryAt != null) {
        const gap = minutesBetween(lastLoss.exitAt, t.entryAt);
        if (gap >= 0 && gap < c.opts.revengeMin) {
          const n0 = notional(lastLoss), n1 = notional(t);
          const sizeUp = n0 != null && n1 != null && n0 > 0 && n1 / n0 >= 1.25;
          const same = t.ticker === lastLoss.ticker;
          const parts = [c.t("patterns.revenge.note", { gap: gap < 1 ? "<1" : Math.round(gap), ticker: lastLoss.ticker, net: fmtUsd(lastLoss.net) })];
          if (same) parts.push(c.t("patterns.revenge.sameTicker"));
          if (sizeUp) parts.push(c.t("patterns.revenge.sizeUp", { ratio: (n1! / n0!).toFixed(1) }));
          flagged.push({ trade: t, note: parts.join(", "), same, sizeUp });
          flaggedIds.add(t.id);
        }
      }
      if (t.result === "loss") lastLoss = t;
    }
  }
  const sameTicker = flagged.filter((f) => f.same).length;
  const sizeUp = flagged.filter((f) => f.sizeUp).length;
  return {
    key: "revenge", title: c.t("patterns.revenge.title"),
    description: c.t("patterns.revenge.description", { min: c.opts.revengeMin }),
    rule: c.t("patterns.revenge.rule", { min: c.opts.revengeMin }),
    flagged, baseline: c.trades.filter((t) => !flaggedIds.has(t.id)), baselineLabel: c.t("patterns.revenge.baseline"),
    extra: { sameTicker, sizeUp },
  };
}

function detectMartingale(c: Ctx): PatternDraft {
  const flagged: PatternDraft["flagged"] = [];
  const flaggedIds = new Set<number>();
  let chains = 0, longestChain = 0;
  for (const day of c.byDay.values()) {
    let prev: BehaviorTrade | null = null;
    let chain = 0;
    for (const t of day) {
      if (prev && prev.result === "loss") {
        const n0 = notional(prev), n1 = notional(t);
        if (n0 != null && n1 != null && n0 > 0 && n1 / n0 >= c.opts.martingaleRatio) {
          chain++;
          if (chain === 1) chains++;
          longestChain = Math.max(longestChain, chain);
          const np = { ratio: (n1 / n0).toFixed(1), ticker: prev.ticker, net: fmtUsd(prev.net) };
          flagged.push({ trade: t, note: chain > 1 ? c.t("patterns.martingale.step", { ...np, n: chain }) : c.t("patterns.martingale.note", np) });
          flaggedIds.add(t.id);
        } else chain = 0;
      } else chain = 0;
      prev = t;
    }
  }
  return {
    key: "martingale", title: c.t("patterns.martingale.title"),
    description: c.t("patterns.martingale.description"),
    rule: c.t("patterns.martingale.rule", { ratio: c.opts.martingaleRatio }),
    flagged, baseline: c.trades.filter((t) => !flaggedIds.has(t.id)), baselineLabel: c.t("patterns.martingale.baseline"),
    extra: { chains, longestChain },
  };
}

function detectOvertrading(c: Ctx): PatternDraft {
  const flagged: PatternDraft["flagged"] = [];
  const flaggedIds = new Set<number>();
  let busyDays = 0;
  for (const [, day] of c.byDay) {
    if (day.length <= c.tradesPerDayNorm) continue;
    busyDays++;
    day.forEach((t, i) => {
      if (i + 1 > c.tradesPerDayNorm) {
        flagged.push({ trade: t, note: c.t("patterns.overtrading.note", { no: i + 1, norm: c.tradesPerDayNorm, total: day.length }) });
        flaggedIds.add(t.id);
      }
    });
  }
  return {
    key: "overtrading", title: c.t("patterns.overtrading.title"),
    description: c.t("patterns.overtrading.description"),
    rule: c.t("patterns.overtrading.rule", { k: c.opts.overtradingK, norm: c.tradesPerDayNorm }),
    flagged, baseline: c.trades.filter((t) => !flaggedIds.has(t.id)), baselineLabel: c.t("patterns.overtrading.baseline"),
    extra: { busyDays, norm: c.tradesPerDayNorm, medianPerDay: c.medianTradesPerDay },
  };
}

function detectFatigue(c: Ctx): PatternDraft {
  const cut = Math.max(2, Math.ceil(c.medianTradesPerDay));
  const early: BehaviorTrade[] = [];
  const flagged: PatternDraft["flagged"] = [];
  for (const day of c.byDay.values()) {
    day.forEach((t, i) => {
      if (i + 1 > cut) flagged.push({ trade: t, note: c.t("patterns.fatigue.note", { no: i + 1, total: day.length }) });
      else early.push(t);
    });
  }
  return {
    key: "fatigue", title: c.t("patterns.fatigue.title"),
    description: c.t("patterns.fatigue.description"),
    rule: c.t("patterns.fatigue.rule", { cut }),
    flagged, baseline: early, baselineLabel: c.t("patterns.fatigue.baseline", { cut }),
    extra: { cut },
  };
}

function detectChase(c: Ctx): PatternDraft {
  // Порог «красного утра»: медиана |дневного нетто| (не меньше 1 $).
  const dayNets: number[] = [];
  for (const day of c.byDay.values()) { const s = sumNet(day).sum; if (s != null) dayNets.push(Math.abs(s)); }
  const threshold = Math.max(1, median(dayNets.filter((v) => v > 0)));
  const flagged: PatternDraft["flagged"] = [];
  const baseline: BehaviorTrade[] = [];
  let redMornings = 0;
  for (const day of c.byDay.values()) {
    const morning = day.filter((t) => t.entryMin != null && t.entryMin < c.opts.morningEndMin);
    const later = day.filter((t) => t.entryMin != null && t.entryMin >= c.opts.morningEndMin);
    const mNet = sumNet(morning).sum;
    const red = mNet != null && mNet <= -threshold;
    if (red) redMornings++;
    for (const t of later) {
      if (red) flagged.push({ trade: t, note: c.t("patterns.chase.note", { net: fmtUsd(mNet), time: fmtMin(t.entryMin) }) });
      else baseline.push(t);
    }
  }
  return {
    key: "chase", title: c.t("patterns.chase.title"),
    description: c.t("patterns.chase.description"),
    rule: c.t("patterns.chase.rule", { time: fmtMin(c.opts.morningEndMin), usd: round2(threshold) }),
    flagged, baseline, baselineLabel: c.t("patterns.chase.baseline"),
    extra: { threshold: round2(threshold), redMornings },
  };
}

function detectTilt(c: Ctx): PatternDraft {
  const flagged: PatternDraft["flagged"] = [];
  const flaggedIds = new Set<number>();
  let clusters = 0;
  const gapRef = c.medianGapMin;
  for (const day of c.byDay.values()) {
    let streak = 0;
    for (let i = 0; i < day.length; i++) {
      const t = day[i];
      if (t.result === "loss") streak++;
      else if (t.result === "win" || t.result === "be") streak = 0;
      if (streak < 3) continue;
      // После 3-го убытка подряд: ускорилась ли частота следующих сделок?
      const after = day.slice(i + 1, i + 4);
      const gaps: number[] = [];
      let prevExit = t.exitAt;
      for (const a of after) {
        if (prevExit != null && a.entryAt != null) gaps.push(Math.max(0, minutesBetween(prevExit, a.entryAt)));
        prevExit = a.exitAt ?? prevExit;
      }
      if (!after.length || !gaps.length) continue;
      const g = median(gaps);
      const fast = gapRef != null ? g < gapRef * 0.5 : g < 3;
      if (!fast) continue;
      clusters++;
      let k = i + 1;
      let taken = 0;
      while (k < day.length && taken < 5) {
        const a = day[k];
        if (!flaggedIds.has(a.id)) {
          flagged.push({ trade: a, note: c.t("patterns.tilt.note", { streak, gap: g < 1 ? "<1" : Math.round(g), norm: gapRef == null ? "—" : Math.round(gapRef) }) });
          flaggedIds.add(a.id);
        }
        taken++;
        if (a.result === "win") break;
        k++;
      }
      streak = 0;
      i = k;
    }
  }
  return {
    key: "tilt", title: c.t("patterns.tilt.title"),
    description: c.t("patterns.tilt.description"),
    rule: c.t("patterns.tilt.rule", { gap: gapRef == null ? "—" : c.t("patterns.tilt.gapMin", { n: Math.round(gapRef) }) }),
    flagged, baseline: c.trades.filter((t) => !flaggedIds.has(t.id)), baselineLabel: c.t("patterns.tilt.baseline"),
    extra: { clusters },
  };
}

function detectDisposition(c: Ctx): PatternDraft {
  const winners = c.trades.filter((t) => t.result === "win" && t.holdMin != null);
  const losers = c.trades.filter((t) => t.result === "loss" && t.holdMin != null);
  const avgW = winners.length ? winners.reduce((s, t) => s + t.holdMin!, 0) / winners.length : null;
  const avgL = losers.length ? losers.reduce((s, t) => s + t.holdMin!, 0) / losers.length : null;
  const medW = median(winners.map((t) => t.holdMin!));
  const limit = Math.max(1, medW * 2);
  const flagged: PatternDraft["flagged"] = [];
  const baseline: BehaviorTrade[] = [];
  for (const t of losers) {
    if (t.holdMin! > limit) flagged.push({ trade: t, note: c.t("patterns.disposition.note", { hold: fmtDurFor(c.lang, t.holdMin), med: fmtDurFor(c.lang, medW) }) });
    else baseline.push(t);
  }
  const ratio = avgW && avgL ? avgL / avgW : null;
  const effect = ratio != null && ratio >= 1.25;
  return {
    key: "disposition", title: c.t("patterns.disposition.title"),
    description: effect
      ? c.t("patterns.disposition.description")
      : c.t("patterns.disposition.descriptionNone", { ratio: ratio == null ? "—" : "×" + ratio.toFixed(2) }),
    rule: c.t("patterns.disposition.rule", { med: fmtDurFor(c.lang, medW) }),
    flagged, baseline, baselineLabel: c.t("patterns.disposition.baseline"),
    noCost: !effect,
    extra: {
      avgHoldWinMin: avgW == null ? null : round2(avgW),
      avgHoldLossMin: avgL == null ? null : round2(avgL),
      ratio: avgW && avgL ? round2(avgL / avgW) : null,
      medianHoldWinMin: round2(medW),
    },
  };
}

function detectFirstTrade(c: Ctx): PatternDraft {
  const flagged: PatternDraft["flagged"] = [];
  const rest: BehaviorTrade[] = [];
  for (const day of c.byDay.values()) {
    day.forEach((t, i) => {
      if (i === 0) flagged.push({ trade: t, note: t.entryMin != null ? c.t("patterns.firstTrade.noteAt", { time: fmtMin(t.entryMin) }) : c.t("patterns.firstTrade.note") });
      else rest.push(t);
    });
  }
  return {
    key: "firstTrade", title: c.t("patterns.firstTrade.title"),
    description: c.t("patterns.firstTrade.description"),
    rule: c.t("patterns.firstTrade.rule"),
    flagged, baseline: rest, baselineLabel: c.t("patterns.firstTrade.baseline"),
  };
}

function detectEuphoria(c: Ctx): PatternDraft {
  const wins = c.trades.filter((t) => t.result === "win" && t.net != null).map((t) => t.net!);
  const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const q75 = quantile(wins, 0.75) ?? 0;
  const big = Math.max(avgWin * 2, q75, 1);
  const flagged: PatternDraft["flagged"] = [];
  const flaggedIds = new Set<number>();
  let bigWins = 0;
  for (const day of c.byDay.values()) {
    let lastBig: BehaviorTrade | null = null;
    for (const t of day) {
      if (lastBig && lastBig.exitAt != null && t.entryAt != null) {
        const gap = minutesBetween(lastBig.exitAt, t.entryAt);
        if (gap >= 0 && gap < c.opts.euphoriaMin) {
          flagged.push({ trade: t, note: c.t("patterns.euphoria.note", { gap: gap < 1 ? "<1" : Math.round(gap), ticker: lastBig.ticker, net: fmtUsd(lastBig.net) }) });
          flaggedIds.add(t.id);
        }
      }
      if (t.result === "win" && t.net != null && t.net >= big) { lastBig = t; bigWins++; }
    }
  }
  return {
    key: "euphoria", title: c.t("patterns.euphoria.title"),
    description: c.t("patterns.euphoria.description"),
    rule: c.t("patterns.euphoria.rule", { usd: round2(big), min: c.opts.euphoriaMin }),
    flagged, baseline: c.trades.filter((t) => !flaggedIds.has(t.id)), baselineLabel: c.t("patterns.euphoria.baseline"),
    extra: { bigWinThreshold: round2(big), bigWins },
  };
}

/* ─── Кривые ───────────────────────────────────────────────────────────────── */

type BucketDef = { key: string; label: string };

function bucketize(groups: Map<string, BehaviorTrade[]>, order: readonly BucketDef[]): Bucket[] {
  return order.map(({ key, label }) => {
    const list = groups.get(key) ?? [];
    const { sum } = sumNet(list);
    const a = avgNet(list);
    return { key, label, n: list.length, net: sum, avgNet: a == null ? null : round2(a), winRate: winRateOf(list) };
  });
}

const TRADE_NO_BUCKETS: readonly BucketDef[] = ["1", "2", "3", "4", "5", "6–8", "9+"].map((k) => ({ key: k, label: k }));
function tradeNoBucket(i: number): string {
  if (i <= 5) return String(i);
  return i <= 8 ? "6–8" : "9+";
}

/** Minutes since the last losing exit: codes (stable) → labels in `lang`. */
const AFTER_LOSS_KEYS = ["0-2", "2-5", "5-10", "10-20", "20-60", "60+", "none"] as const;
function afterLossBucketsFor(lang: Lang): BucketDef[] {
  const t = behaviorT.tFor(lang);
  return AFTER_LOSS_KEYS.map((key) => {
    if (key === "none") return { key, label: t("buckets.notAfterLoss") };
    if (key === "60+") return { key, label: t("buckets.minPlus", { from: 60 }) };
    const [from, to] = key.split("-");
    return { key, label: t("buckets.minRange", { from, to }) };
  });
}
function afterLossBucket(gapMin: number | null): (typeof AFTER_LOSS_KEYS)[number] {
  if (gapMin == null) return "none";
  if (gapMin < 2) return "0-2";
  if (gapMin < 5) return "2-5";
  if (gapMin < 10) return "5-10";
  if (gapMin < 20) return "10-20";
  if (gapMin < 60) return "20-60";
  return "60+";
}

/** Entry hour buckets (NY): codes "pre" | "9:30" | "10" … "15" | "16+"; only "pre" has a translated label. */
const HOUR_KEYS = ["pre", "9:30", "10", "11", "12", "13", "14", "15", "16+"] as const;
function hourBucketKey(min: number): string {
  if (min < 570) return "pre";
  if (min < 600) return "9:30";
  if (min >= 960) return "16+";
  return String(Math.floor(min / 60));
}
const hourLabelFor = (key: string, lang: Lang) => (key === "pre" ? behaviorT.tFor(lang)("buckets.preOpen") : key);
/** Hour bucket labels in `lang` (setups-auto matrix uses the labels as keys of one response). */
export function hourBucketsFor(lang: Lang = DEFAULT_LANG): string[] {
  return HOUR_KEYS.map((k) => hourLabelFor(k, lang));
}
/** Label of the hour bucket of an entry minute, in `lang`. */
function hourBucket(min: number, lang: Lang = DEFAULT_LANG): string {
  return hourLabelFor(hourBucketKey(min), lang);
}
const HOUR_BUCKETS: string[] = hourBucketsFor(DEFAULT_LANG);

/* ─── Индекс дисциплины ───────────────────────────────────────────────────── */

const PENALTY: Record<PatternKey, { per: number; cap: number }> = {
  revenge: { per: 10, cap: 30 },
  martingale: { per: 10, cap: 20 },
  overtrading: { per: 5, cap: 20 },
  tilt: { per: 15, cap: 30 },
  chase: { per: 10, cap: 10 },
  euphoria: { per: 5, cap: 10 },
  fatigue: { per: 0, cap: 0 },
  disposition: { per: 0, cap: 0 },
  firstTrade: { per: 0, cap: 0 },
};

function disciplineDays(byDay: Map<string, BehaviorTrade[]>, drafts: Map<PatternKey, PatternDraft>, contract?: ReadonlyMap<string, number>): DisciplineDay[] {
  const perDay = new Map<string, Partial<Record<PatternKey, number>>>();
  const bump = (date: string, key: PatternKey, count: number) => {
    const cfg = PENALTY[key];
    if (!cfg.per) return;
    const m = perDay.get(date) ?? {};
    m[key] = Math.min(cfg.cap, (m[key] ?? 0) + cfg.per * count);
    perDay.set(date, m);
  };
  for (const key of ["revenge", "martingale", "overtrading", "euphoria"] as PatternKey[]) {
    for (const f of drafts.get(key)?.flagged ?? []) bump(f.trade.date, key, 1);
  }
  // Кластеры тильта: штраф за кластер (по дням — по первому помеченному трейду кластера).
  const tiltDays = new Map<string, Set<string>>();
  for (const f of drafts.get("tilt")?.flagged ?? []) {
    const s = tiltDays.get(f.trade.date) ?? new Set<string>();
    s.add(f.note);
    tiltDays.set(f.trade.date, s);
  }
  for (const [date, s] of tiltDays) bump(date, "tilt", s.size);
  const chaseDays = new Set((drafts.get("chase")?.flagged ?? []).map((f) => f.trade.date));
  for (const d of chaseDays) bump(d, "chase", 1);

  const out: DisciplineDay[] = [];
  for (const [date, list] of byDay) {
    const penalties = perDay.get(date) ?? {};
    const total = Object.values(penalties).reduce((a, b) => a + (b ?? 0), 0), c = contract?.get(date);
    out.push({ date, score: Math.max(0, Math.min(100, 100 - total + (c ?? 0))), trades: list.length, net: sumNet(list).sum, penalties, ...(c != null ? { contract: c } : {}) });
  }
  return out;
}

/* ─── Главная функция ─────────────────────────────────────────────────────── */

type Detection = {
  opts: Required<BehaviorOptions>;
  trades: BehaviorTrade[];
  byDay: Map<string, BehaviorTrade[]>;
  ctx: Ctx;
  drafts: Map<PatternKey, PatternDraft>;
  madTradesPerDay: number;
};

/** Нормы трейдера + все детекторы (общая часть отчёта и ленты дня). */
function detect(input: BehaviorTrade[], options: BehaviorOptions, lang: Lang = DEFAULT_LANG): Detection {
  const opts: Required<BehaviorOptions> = { ...DEFAULTS, ...stripUndefined(options) };
  // Открытые сделки не участвуют в оценке результата, но учитываются в частоте.
  const trades = input.filter((t) => t.result !== "open");
  const byDay = groupByDay(trades);
  const perDay = [...byDay.values()].map((d) => d.length);
  const medianTradesPerDay = median(perDay);
  const madTradesPerDay = mad(perDay);
  const tradesPerDayNorm = Math.max(Math.ceil(medianTradesPerDay + opts.overtradingK * madTradesPerDay), Math.ceil(medianTradesPerDay) + 2);

  // Обычная пауза между сделками (от выхода предыдущей до входа следующей) — для тильта.
  const gaps: number[] = [];
  for (const day of byDay.values()) {
    for (let i = 1; i < day.length; i++) {
      const p = day[i - 1], t = day[i];
      if (p.exitAt != null && t.entryAt != null) gaps.push(Math.max(0, minutesBetween(p.exitAt, t.entryAt)));
    }
  }
  const medianGapMin = gaps.length ? median(gaps) : null;

  const ctx: Ctx = { lang, t: behaviorT.tFor(lang), trades, byDay, opts, medianGapMin, tradesPerDayNorm, medianTradesPerDay };
  const drafts = new Map<PatternKey, PatternDraft>();
  for (const d of [
    detectRevenge(ctx), detectMartingale(ctx), detectOvertrading(ctx), detectFatigue(ctx), detectChase(ctx),
    detectTilt(ctx), detectDisposition(ctx), detectFirstTrade(ctx), detectEuphoria(ctx),
  ]) drafts.set(d.key, d);
  return { opts, trades, byDay, ctx, drafts, madTradesPerDay };
}

/** The behaviour report; all texts in `lang`. `contract` = own-contract points per day (lib/daily/service contractDeltas). */
export function analyzeBehavior(input: BehaviorTrade[], options: BehaviorOptions = {}, lang: Lang = DEFAULT_LANG, contract?: ReadonlyMap<string, number>): BehaviorReport {
  const { opts, trades, byDay, ctx, drafts, madTradesPerDay } = detect(input, options, lang);
  const { medianGapMin, tradesPerDayNorm, medianTradesPerDay } = ctx;

  let grossProfit = 0, grossLoss = 0;
  for (const t of trades) if (t.net != null) { if (t.net > 0) grossProfit += t.net; else grossLoss += t.net; }
  const tc = trendCtxOf(byDay);
  const patterns = [...drafts.values()].map((d) => buildPattern(d, trades.length, grossProfit, tc, opts, lang));
  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2, none: 3 };
  patterns.sort((a, b) => order[a.severity] - order[b.severity] || (a.cost ?? 0) - (b.cost ?? 0));

  // Кривые.
  const byNo = new Map<string, BehaviorTrade[]>();
  const byAfterLoss = new Map<string, BehaviorTrade[]>();
  const byHour = new Map<string, BehaviorTrade[]>();
  for (const day of byDay.values()) {
    let lastLossExit: number | null = null;
    day.forEach((t, i) => {
      const k = tradeNoBucket(i + 1);
      (byNo.get(k) ?? byNo.set(k, []).get(k)!).push(t);
      const gap = lastLossExit != null && t.entryAt != null ? Math.max(0, minutesBetween(lastLossExit, t.entryAt)) : null;
      const b = afterLossBucket(gap);
      (byAfterLoss.get(b) ?? byAfterLoss.set(b, []).get(b)!).push(t);
      if (t.entryMin != null) {
        const h = hourBucketKey(t.entryMin);
        (byHour.get(h) ?? byHour.set(h, []).get(h)!).push(t);
      }
      if (t.result === "loss" && t.exitAt != null) lastLossExit = t.exitAt;
      else if (t.result === "win" || t.result === "be") lastLossExit = null;
    });
  }

  const discipline = disciplineDays(byDay, drafts, contract);
  const wk = new Map<string, { sum: number; days: number }>();
  for (const d of discipline) {
    const k = weekKey(d.date);
    const w = wk.get(k) ?? { sum: 0, days: 0 };
    w.sum += d.score; w.days++;
    wk.set(k, w);
  }
  const disciplineWeekly = [...wk.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([week, w]) => ({ week, avg: round2(w.sum / w.days), days: w.days }));

  const winners = trades.filter((t) => t.result === "win" && t.holdMin != null);
  const losers = trades.filter((t) => t.result === "loss" && t.holdMin != null);
  const dates = [...byDay.keys()];
  const { sum: net, n: withPnl } = sumNet(trades);
  const byHourBuckets = bucketize(byHour, HOUR_KEYS.map((k) => ({ key: k, label: hourLabelFor(k, lang) })));
  const disciplineAvg = discipline.length ? round2(discipline.reduce((s, d) => s + d.score, 0) / discipline.length) : null;

  return {
    options: opts,
    summary: {
      trades: input.length,
      closed: trades.length,
      withPnl,
      withTime: trades.filter((t) => t.entryAt != null).length,
      days: byDay.size,
      net,
      grossProfit: round2(grossProfit),
      grossLoss: round2(grossLoss),
      avgNet: withPnl ? round2(net! / withPnl) : null,
      medianTradesPerDay,
      madTradesPerDay: round2(madTradesPerDay),
      tradesPerDayNorm,
      medianGapMin: medianGapMin == null ? null : round2(medianGapMin),
      avgHoldWinMin: winners.length ? round2(winners.reduce((s, t) => s + t.holdMin!, 0) / winners.length) : null,
      avgHoldLossMin: losers.length ? round2(losers.reduce((s, t) => s + t.holdMin!, 0) / losers.length) : null,
      from: dates[0] ?? null,
      to: dates[dates.length - 1] ?? null,
    },
    patterns,
    byTradeNumber: bucketize(byNo, TRADE_NO_BUCKETS),
    byMinutesAfterLoss: bucketize(byAfterLoss, afterLossBucketsFor(lang)),
    byHour: byHourBuckets,
    discipline,
    disciplineWeekly,
    disciplineFormula: disciplineFormulaFor(lang),
    disciplineAvg,
    profile: buildProfile({ trades, byDay, drafts, patterns, byHour: byHourBuckets, discipline, disciplineAvg, tc, medianTradesPerDay, lang }),
  };
}

/* ─── Профиль трейдера ────────────────────────────────────────────────────── */

function buildProfile(a: {
  trades: BehaviorTrade[];
  byDay: Map<string, BehaviorTrade[]>;
  drafts: Map<PatternKey, PatternDraft>;
  patterns: PatternReport[];
  byHour: Bucket[];
  discipline: DisciplineDay[];
  disciplineAvg: number | null;
  tc: TrendCtx;
  medianTradesPerDay: number;
  lang: Lang;
}): TraderProfile {
  const { trades } = a;
  // Стиль: по медиане удержания, доле скальпов (< 2 мин) и доле переносов через ночь.
  const holds = trades.filter((t) => t.holdMin != null && t.horizon === "intraday").map((t) => t.holdMin!);
  const medianHold = holds.length ? median(holds) : null;
  const scalpShare = holds.length ? holds.filter((h) => h < 2).length / holds.length : null;
  const carryShare = trades.length ? trades.filter((t) => t.horizon !== "intraday").length / trades.length : 0;
  let style: TraderProfile["style"]["key"] = "unknown";
  if (carryShare >= 0.3) style = "swing";
  else if (medianHold != null) style = medianHold < 5 || (scalpShare ?? 0) >= 0.5 ? "scalper" : "intraday";
  const t = behaviorT.tFor(a.lang);
  const styleDesc = style === "unknown"
    ? t("style.unknownDesc")
    : t("style.desc", { hold: fmtDurFor(a.lang, medianHold), perDay: a.medianTradesPerDay }) +
      (scalpShare != null ? t("style.scalps", { pct: Math.round(scalpShare * 100) }) : "") +
      (carryShare > 0 ? t("style.carry", { pct: Math.round(carryShare * 100) }) : "");

  // Лучший / худший час: только часы с достаточной выборкой.
  const minHourN = Math.max(8, Math.round(trades.length * 0.03));
  const hours = a.byHour.filter((b) => b.n >= minHourN && b.net != null);
  const bestHour = hours.length ? hours.reduce((x, y) => ((y.net ?? 0) > (x.net ?? 0) ? y : x)) : null;
  const worstHour = hours.length ? hours.reduce((x, y) => ((y.net ?? 0) < (x.net ?? 0) ? y : x)) : null;

  // Сетапы: сетап сделки, иначе принятое/предложенное авто-классификатором (route подставляет setupAuto).
  const setupGroups = new Map<string, BehaviorTrade[]>();
  let withSetup = 0, autoCount = 0;
  for (const t of trades) {
    if (!t.setup) continue;
    withSetup++;
    if (t.setupAuto) autoCount++;
    (setupGroups.get(t.setup) ?? setupGroups.set(t.setup, []).get(t.setup)!).push(t);
  }
  const minSetupN = 5;
  const setupRows: ProfileBucket[] = [...setupGroups.entries()].map(([label, list]) => {
    const { sum } = sumNet(list);
    const avg = avgNet(list);
    return { label, n: list.length, net: sum, avgNet: avg == null ? null : round2(avg), winRate: winRateOf(list), auto: list.filter((t) => t.setupAuto).length };
  }).sort((x, y) => (y.net ?? 0) - (x.net ?? 0));
  const eligible = setupRows.filter((r) => r.n >= minSetupN && r.net != null);
  const bestSetup = eligible.length && (eligible[0].net ?? 0) > 0 ? eligible[0] : null;
  const worstSetup = eligible.length && (eligible[eligible.length - 1].net ?? 0) < 0 ? eligible[eligible.length - 1] : null;

  // Плохие привычки: объединение сделок паттернов со стоимостью < 0, норма — средний нетто остальных сделок.
  const costly = a.patterns.filter((p) => p.cost != null && p.cost < 0);
  const habitIds = new Set<number>();
  for (const p of costly) for (const f of a.drafts.get(p.key)?.flagged ?? []) habitIds.add(f.trade.id);
  const habitTrades = trades.filter((t) => habitIds.has(t.id));
  const clean = trades.filter((t) => !habitIds.has(t.id));
  const cleanAvg = avgNet(clean);
  const habitCost = (list: BehaviorTrade[]): number | null => {
    const { sum, n } = sumNet(list);
    if (cleanAvg == null) return null;
    return round2((sum ?? 0) - n * cleanAvg);
  };
  const byMonth = new Map<string, BehaviorTrade[]>();
  for (const t of habitTrades) { const m = t.date.slice(0, 7); (byMonth.get(m) ?? byMonth.set(m, []).get(m)!).push(t); }
  const months = new Set([...a.byDay.keys()].map((d) => d.slice(0, 7)));
  const monthly = [...months].sort().map((m) => {
    const list = byMonth.get(m) ?? [];
    return { month: m, cost: list.length ? habitCost(list) : cleanAvg == null ? null : 0, n: list.length };
  });

  // Дисциплина: последние 30 дней периода vs раньше.
  const recentDays = a.discipline.filter((d) => d.date >= a.tc.recentFrom);
  const priorDays = a.discipline.filter((d) => d.date < a.tc.recentFrom);
  const avgScore = (l: DisciplineDay[]) => (l.length ? round2(l.reduce((s, d) => s + d.score, 0) / l.length) : null);
  const dRecent = avgScore(recentDays), dPrior = avgScore(priorDays);
  const dDelta = dRecent != null && dPrior != null ? round2(dRecent - dPrior) : null;
  const dDirection: TrendDirection = recentDays.length < 5 || priorDays.length < 5 || dDelta == null
    ? "insufficient" : dDelta >= 3 ? "better" : dDelta <= -3 ? "worse" : "flat";

  return {
    style: {
      key: style, label: t(`style.${style}`), description: styleDesc,
      medianHoldMin: medianHold == null ? null : round2(medianHold),
      tradesPerDay: a.medianTradesPerDay,
      scalpShare: scalpShare == null ? null : round2(scalpShare),
      carryShare: round2(carryShare),
    },
    hours: { best: bestHour && (bestHour.net ?? 0) > 0 ? bestHour : null, worst: worstHour && (worstHour.net ?? 0) < 0 ? worstHour : null, minN: minHourN },
    setups: {
      best: bestSetup, worst: worstSetup,
      coverage: trades.length ? round2(withSetup / trades.length) : 0,
      autoShare: withSetup ? round2(autoCount / withSetup) : 0,
      minN: minSetupN,
      rows: setupRows.slice(0, 30),
    },
    habits: {
      total: habitTrades.length ? habitCost(habitTrades) : costly.length ? null : 0,
      sumOfCosts: round2(costly.reduce((s, p) => s + (p.cost ?? 0), 0)),
      trades: habitTrades.length,
      days: new Set(habitTrades.map((t) => t.date)).size,
      baselineAvg: cleanAvg == null ? null : round2(cleanAvg),
      byPattern: costly.map((p) => ({ key: p.key, title: p.title, cost: p.cost! })).sort((x, y) => x.cost - y.cost),
      monthly,
    },
    discipline: { avg: a.disciplineAvg, recent: dRecent, prior: dPrior, delta: dDelta, direction: dDirection },
  };
}

/* ─── Лента дня (таймлайн сессии) ─────────────────────────────────────────── */

/** Флаги, которые рисуются маркерами на ленте (первая сделка и «поздние» — не поведенческий срыв). */
const MARKER_KEYS: PatternKey[] = ["revenge", "tilt", "martingale", "euphoria", "chase", "overtrading", "disposition"];
const BREAKDOWN_KEYS: PatternKey[] = ["revenge", "tilt", "martingale", "euphoria", "chase"];

/**
 * Сделки одного дня по времени с накопленным нетто и маркерами паттернов. Нормы (сделок/день, пауза,
 * порог крупного выигрыша…) считаются по всему `input` — route подаёт тот же период, что и отчёт.
 */
export function dayTimeline(input: BehaviorTrade[], date: string, options: BehaviorOptions = {}, lang: Lang = DEFAULT_LANG): DayTimeline {
  const { opts, byDay, ctx, drafts } = detect(input, options, lang);
  const day = byDay.get(date) ?? [];
  const ids = new Set(day.map((t) => t.id));
  const flags = new Map<number, TimelineFlag[]>();
  for (const key of MARKER_KEYS) {
    for (const f of drafts.get(key)?.flagged ?? []) {
      if (!ids.has(f.trade.id)) continue;
      (flags.get(f.trade.id) ?? flags.set(f.trade.id, []).get(f.trade.id)!).push({ key, note: f.note });
    }
  }
  let cum = 0, peak = 0, trough = 0, wins = 0, losses = 0;
  const rows: TimelineTrade[] = day.map((t) => {
    cum = round2(cum + (t.net ?? 0));
    peak = Math.max(peak, cum); trough = Math.min(trough, cum);
    if (t.result === "win") wins++; else if (t.result === "loss") losses++;
    return {
      id: t.id, ticker: t.ticker, side: t.side, result: t.result, net: t.net, cum, qty: t.qty, entry: t.entry,
      entryAt: t.entryAt, exitAt: t.exitAt, entryMin: t.entryMin,
      exitMin: t.exitAt != null && t.entryMin != null && t.entryAt != null ? t.entryMin + (t.exitAt - t.entryAt) / 60000 : null,
      holdMin: t.holdMin, setup: t.setup, flags: flags.get(t.id) ?? [],
    };
  });
  let breakdown: DayTimeline["summary"]["breakdown"] = null;
  for (let i = 0; i < rows.length; i++) {
    const f = rows[i].flags.find((x) => BREAKDOWN_KEYS.includes(x.key));
    if (!f) continue;
    const before = i ? rows[i - 1].cum : 0;
    const after = sumNet(day.slice(i)).sum;
    breakdown = { id: rows[i].id, entryMin: rows[i].entryMin, key: f.key, note: f.note, cumBefore: before, netAfter: after };
    break;
  }
  const disc = day.length ? disciplineDays(new Map([[date, day]]), drafts).find((d) => d.date === date) ?? null : null;
  return {
    date,
    trades: rows,
    summary: {
      n: rows.length, net: sumNet(day).sum, wins, losses,
      score: disc ? disc.score : null,
      penalties: disc?.penalties ?? {},
      peak: round2(peak), trough: round2(trough), breakdown,
    },
    norms: { tradesPerDayNorm: ctx.tradesPerDayNorm, medianGapMin: ctx.medianGapMin == null ? null : round2(ctx.medianGapMin), revengeMin: opts.revengeMin, euphoriaMin: opts.euphoriaMin },
  };
}

/** Календарный сдвиг даты YYYY-MM-DD на n дней (без таймзон). */
export function shiftDate(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

export { HOUR_BUCKETS, hourBucket };

/** Flagged trade ids + the personal norm (avg net of the comparable group) per pattern — windowed costs (lib/daily/engine). */
export function patternFlags(input: BehaviorTrade[], options: BehaviorOptions = {}): Map<PatternKey, { ids: number[]; baselineAvg: number | null; noCost: boolean }> {
  return new Map([...detect(input, options).drafts].map(([k, d]) => [k, { ids: d.flagged.map((f) => f.trade.id), baselineAvg: avgNet(d.baseline), noCost: !!d.noCost }]));
}


/* ─── Форматирование для заметок ──────────────────────────────────────────── */

function fmtUsd(v: number | null): string {
  if (v == null) return "—";
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}$${Math.abs(v).toFixed(0)}`;
}
function fmtMin(min: number | null): string {
  if (min == null) return "—";
  return `${Math.floor(min / 60)}:${String(Math.floor(min % 60)).padStart(2, "0")}`;
}
function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
