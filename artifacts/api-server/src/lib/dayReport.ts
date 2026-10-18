/**
 * «Разбор дня» — детерминированный отчёт по одному торговому дню трейдера (чистые функции, без БД/сети/ИИ).
 *
 * Отвечает на «что сегодня было, где заработал, где потерял, что исправить завтра»:
 *   1. шапка: нетто/брутто/комиссии, W/L, win rate, PF ($ нетто, null вместо ∞), лучшая/худшая сделка,
 *      сравнение с 20 предыдущими торговыми днями (z-score + «день лучше N% дней»);
 *   2. внутридневная кривая эквити по фактическому времени закрытия (exit-исполнение), пик и max DD;
 *   3. таймлайн сделок по ET-времени: тикер, удержание, результат, пауза между сделками;
 *   4. разрезы: тикер / час входа (ET) / сторона;
 *   5. «утечки» (правила с суммами в $): комиссия > |брутто|, сделки после пика дня (отдача), вход < N мин
 *      после убытка, рост размера после убытка, торговля после дневного лимита;
 *   6. «что получилось»: топ-3 сделки, тикеры/сетапы с преимуществом в этот день;
 *   7. «план на завтра»: 3–5 рекомендаций по шаблонам из флагов.
 *
 * Деньги — нетто = брутто − |комиссии| (lib/tradeMath.netPnl). Время — America/New_York.
 */
import { netPnl, num, normResult } from "./tradeMath";
import { dayReportT } from "../i18n/ns";
import { localeTagFor, type Lang } from "../i18n";

/* ─── Типы ─────────────────────────────────────────────────────────────────── */

export type Side = "long" | "short";
export type TimeSource = "executions" | "snapshot" | "none";

export interface DayTrade {
  id: number;
  ticker: string;
  side: Side | null;
  setup: string | null;
  playbookId: number | null;
  result: "win" | "loss" | "be" | "open" | null;
  gross: number | null;
  fees: number;
  /** Нетто = брутто − |комиссии|; null для открытых / без P&L. */
  net: number | null;
  qty: number | null;
  entry: number | null;
  exit: number | null;
  /** Время первого входа (epoch ms) или null. */
  entryAt: number | null;
  /** Время последнего выхода (epoch ms) или null. */
  exitAt: number | null;
  timeSource: TimeSource;
}

/** Свободная строка сделки (JSON API /trades или строка БД) — всё необязательно. */
export interface LooseTradeRow {
  id?: unknown; ticker?: unknown; side?: unknown; setup?: unknown; playbookId?: unknown; playbook_id?: unknown;
  result?: unknown; pnl?: unknown; fees?: unknown; qty?: unknown; entry?: unknown; exit?: unknown;
  /** Исполнения (из trade_executions): первый вход / последний выход — Date | ISO с зоной. */
  firstEntryAt?: unknown; lastExitAt?: unknown;
  /** Снапшот PropReports: настенное время ET без зоны ("2026-10-15T15:59:16"). */
  contextSnapshot?: { openedAt?: unknown; closedAt?: unknown } | null;
  openedAt?: unknown; closedAt?: unknown;
}

export interface DailyNet { date: string; net: number }

export interface DayReportInput {
  trader: string;
  date: string;
  trades: DayTrade[];
  /** Дневные нетто предыдущих торговых дней (любой порядок; берутся последние 20 до `date`). */
  history: DailyNet[];
  /** Дневной лимит убытка в $ (положительное число) или null, если не задан. */
  dailyLossLimit: number | null;
  options?: DayReportOptions;
}

export interface DayReportOptions {
  /** Вход быстрее этого числа минут после убыточного выхода = «реванш». По умолчанию 2. */
  revengeMin?: number;
  /** Рост размера после убытка: qty > предыдущий убыточный qty × factor. По умолчанию 1.2. */
  sizeUpFactor?: number;
  /** Окно сравнения, торговых дней. По умолчанию 20. */
  lookbackDays?: number;
  /** Language of the texts (default RU). */
  lang?: Lang;
}

export interface TradeRef {
  id: number; ticker: string; side: Side | null; net: number | null; gross: number | null; fees: number;
  qty: number | null; entryTime: string | null; exitTime: string | null; holdMin: number | null; setup: string | null;
}

export interface Summary {
  trades: number; closed: number; open: number;
  wins: number; losses: number; be: number;
  winRate: number | null;
  net: number; gross: number; fees: number;
  /** Доля комиссий от брутто (fees / gross) при gross > 0, иначе null. */
  feeShareOfGross: number | null;
  /** PF в $ нетто: Σ выигрышей / |Σ проигрышей|; null, если проигрышей нет. */
  profitFactor: number | null;
  avgWin: number | null; avgLoss: number | null; expectancy: number | null;
  best: TradeRef | null; worst: TradeRef | null;
  volumeShares: number;
}

export interface Comparison {
  days: number;
  avg: number | null; std: number | null;
  z: number | null;
  /** Доля дней окна с нетто ниже сегодняшнего (0..1), ничьи — пополам. */
  betterThanPct: number | null;
  rank: number | null;
  bestDay: DailyNet | null; worstDay: DailyNet | null;
  label: string;
}

export interface EquityPoint { t: number | null; time: string | null; tradeId: number | null; ticker: string | null; net: number; cum: number }

export interface Equity {
  timeSource: TimeSource;
  points: EquityPoint[];
  peak: { value: number; time: string | null; tradeId: number | null };
  trough: { value: number; time: string | null; tradeId: number | null };
  maxDrawdown: { value: number; fromTime: string | null; toTime: string | null; fromTradeId: number | null; toTradeId: number | null };
  final: number;
  /** Отдано от пика к закрытию дня (peak − final, ≥ 0). */
  giveback: number;
}

export interface TimelineRow extends TradeRef {
  index: number;
  result: DayTrade["result"];
  /** Пауза от последнего выхода до входа этой сделки, мин; null для первой и для входа при открытой позиции. */
  gapMin: number | null;
  /** Вход, когда предыдущая позиция ещё открыта. */
  overlap: boolean;
  cumAfter: number | null;
  afterLoss: boolean;
}

export interface Bucket {
  key: string; label: string; trades: number; wins: number; losses: number;
  winRate: number | null; net: number; gross: number; fees: number;
}

export type LeakKind = "fee_over_gross" | "after_peak" | "revenge" | "size_up" | "after_limit";

export interface Leak {
  kind: LeakKind;
  title: string;
  detail: string;
  count: number;
  tradeIds: number[];
  /** Σ нетто помеченных сделок. */
  netUsd: number;
  /** Цена утечки в $ (≥ 0) — что день потерял из-за паттерна. */
  costUsd: number;
  severity: "high" | "medium" | "low";
}

export interface EdgeItem { key: string; label: string; trades: number; wins: number; losses: number; net: number; winRate: number | null }

export interface Strengths { topTrades: TradeRef[]; tickers: EdgeItem[]; setups: EdgeItem[]; sides: EdgeItem[]; bestHour: Bucket | null }

export interface PlanItem { id: string; text: string; reason: string; costUsd: number | null; source: LeakKind | "stat" }

export interface DayReport {
  trader: string;
  date: string;
  weekday: string;
  summary: Summary;
  comparison: Comparison;
  equity: Equity;
  timeline: TimelineRow[];
  breakdown: { byTicker: Bucket[]; byHour: Bucket[]; bySide: Bucket[] };
  leaks: Leak[];
  leaksTotalUsd: number;
  strengths: Strengths;
  plan: PlanItem[];
  dailyLossLimit: number | null;
  firstEntry: string | null;
  lastExit: string | null;
  activeMinutes: number | null;
}

/* ─── Время ET ─────────────────────────────────────────────────────────────── */

const NY_TZ = "America/New_York";
const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: NY_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function nyParts(ms: number): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const p: Record<string, string> = {};
  for (const x of partsFmt.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

/** "HH:MM:SS" по Нью-Йорку. */
export function etTime(ms: number | null): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  const p = nyParts(ms);
  return `${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}:${String(p.s).padStart(2, "0")}`;
}

/** Час входа по ET (0..23). */
export function etHour(ms: number): number {
  return nyParts(ms).h;
}

/** Настенное время ET ("2026-10-15T15:59:16", без зоны) → epoch ms с учётом DST. Строка с зоной — как обычный ISO. */
export function etWallToMs(v: unknown): number | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim();
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) return null;
  const want = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  // Подбор смещения: guess → какое настенное время в NY → поправка (две итерации покрывают переход DST).
  let guess = want + 5 * 3600_000;
  for (let i = 0; i < 3; i++) {
    const p = nyParts(guess);
    const wall = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    const diff = want - wall;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

function toMs(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(v.trim())) return etWallToMs(v);
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function weekdayOf(ymd: string, lang: Lang = "ru"): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Intl.DateTimeFormat(localeTagFor(lang), { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(y, (m || 1) - 1, d || 1, 12)));
}

/* ─── Нормализация ─────────────────────────────────────────────────────────── */

function sideOf(v: unknown): Side | null {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return null;
  return s.startsWith("s") || s.startsWith("ш") ? "short" : "long"; // i18n-ignore (parses RU side input)
}

/** Строка API/БД → DayTrade. Время: исполнения → снапшот PropReports (openedAt/closedAt, ET) → нет. */
export function toDayTrade(r: LooseTradeRow): DayTrade {
  const fees = Math.abs(num(r.fees) ?? 0);
  const gross = num(r.pnl);
  const execEntry = toMs(r.firstEntryAt);
  const execExit = toMs(r.lastExitAt);
  const snap = r.contextSnapshot ?? null;
  const snapEntry = etWallToMs(snap?.openedAt ?? r.openedAt);
  const snapExit = etWallToMs(snap?.closedAt ?? r.closedAt);
  const entryAt = execEntry ?? snapEntry;
  const exitAt = execExit ?? snapExit;
  const timeSource: TimeSource = execExit != null || execEntry != null ? "executions" : snapExit != null || snapEntry != null ? "snapshot" : "none";
  let result = normResult(r.result);
  const net = netPnl({ pnl: r.pnl, fees: r.fees });
  if (result == null && net != null) result = net > 0 ? "win" : net < 0 ? "loss" : "be";
  const setup = typeof r.setup === "string" && r.setup.trim() ? r.setup.trim() : null;
  const pb = num(r.playbookId ?? r.playbook_id);
  return {
    id: Number(r.id),
    ticker: String(r.ticker ?? "").trim().toUpperCase() || "—",
    side: sideOf(r.side),
    setup,
    playbookId: pb != null ? Math.trunc(pb) : null,
    result,
    gross,
    fees,
    net: result === "open" ? null : net,
    qty: num(r.qty),
    entry: num(r.entry),
    exit: num(r.exit),
    entryAt,
    exitAt,
    timeSource,
  };
}

/* ─── Утилиты ──────────────────────────────────────────────────────────────── */

const r2 = (x: number) => Math.round(x * 100) / 100;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** "$23.10" / "−$23.10" / "+$23.10". */
export function usd(v: number, signed = false): string {
  const a = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v < 0 ? "−" : signed && v > 0 ? "+" : ""}$${a}`;
}

function holdOf(t: DayTrade): number | null {
  return t.entryAt != null && t.exitAt != null && t.exitAt >= t.entryAt ? r2((t.exitAt - t.entryAt) / 60000) : null;
}

function refOf(t: DayTrade): TradeRef {
  return {
    id: t.id, ticker: t.ticker, side: t.side, net: t.net != null ? r2(t.net) : null, gross: t.gross != null ? r2(t.gross) : null,
    fees: r2(t.fees), qty: t.qty, entryTime: etTime(t.entryAt), exitTime: etTime(t.exitAt), holdMin: holdOf(t), setup: t.setup,
  };
}

/** Порядок входа: время входа → время выхода → id. */
function byEntry(a: DayTrade, b: DayTrade): number {
  const ka = a.entryAt ?? a.exitAt ?? Number.MAX_SAFE_INTEGER;
  const kb = b.entryAt ?? b.exitAt ?? Number.MAX_SAFE_INTEGER;
  return ka - kb || a.id - b.id;
}

/** Порядок реализации P&L: время выхода → время входа → id. */
function byExit(a: DayTrade, b: DayTrade): number {
  const ka = a.exitAt ?? a.entryAt ?? Number.MAX_SAFE_INTEGER;
  const kb = b.exitAt ?? b.entryAt ?? Number.MAX_SAFE_INTEGER;
  return ka - kb || a.id - b.id;
}

const isWin = (t: DayTrade) => t.result === "win" || (t.result == null && (t.net ?? 0) > 0);
const isLoss = (t: DayTrade) => t.result === "loss" || (t.result == null && (t.net ?? 0) < 0);

function bucketize(trades: DayTrade[], keyOf: (t: DayTrade) => string | null, labelOf: (k: string) => string): Bucket[] {
  const m = new Map<string, DayTrade[]>();
  for (const t of trades) {
    const k = keyOf(t);
    if (k == null) continue;
    const arr = m.get(k) ?? [];
    arr.push(t);
    m.set(k, arr);
  }
  return [...m.entries()].map(([key, ts]) => {
    const wins = ts.filter(isWin).length;
    const losses = ts.filter(isLoss).length;
    return {
      key, label: labelOf(key), trades: ts.length, wins, losses,
      winRate: wins + losses ? wins / (wins + losses) : null,
      net: r2(sum(ts.map((t) => t.net ?? 0))), gross: r2(sum(ts.map((t) => t.gross ?? 0))), fees: r2(sum(ts.map((t) => t.fees))),
    };
  });
}

/* ─── Разделы ──────────────────────────────────────────────────────────────── */

export function computeSummary(trades: DayTrade[]): Summary {
  const closed = trades.filter((t) => t.net != null);
  const wins = closed.filter(isWin);
  const losses = closed.filter(isLoss);
  const be = closed.length - wins.length - losses.length;
  const winSum = sum(wins.map((t) => t.net!));
  const lossSum = sum(losses.map((t) => t.net!));
  const gross = sum(closed.map((t) => t.gross ?? 0));
  const fees = sum(trades.map((t) => t.fees));
  const net = sum(closed.map((t) => t.net!));
  const sorted = [...closed].sort((a, b) => b.net! - a.net! || a.id - b.id);
  return {
    trades: trades.length,
    closed: closed.length,
    open: trades.length - closed.length,
    wins: wins.length,
    losses: losses.length,
    be,
    winRate: wins.length + losses.length ? wins.length / (wins.length + losses.length) : null,
    net: r2(net),
    gross: r2(gross),
    fees: r2(fees),
    feeShareOfGross: gross > 0 ? fees / gross : null,
    profitFactor: lossSum < 0 ? r2(winSum / Math.abs(lossSum)) : null,
    avgWin: wins.length ? r2(winSum / wins.length) : null,
    avgLoss: losses.length ? r2(lossSum / losses.length) : null,
    expectancy: closed.length ? r2(net / closed.length) : null,
    best: sorted.length ? refOf(sorted[0]) : null,
    worst: sorted.length ? refOf(sorted[sorted.length - 1]) : null,
    volumeShares: sum(trades.map((t) => Math.abs(t.qty ?? 0))),
  };
}

export function computeComparison(todayNet: number, date: string, history: DailyNet[], lookback = 20, hasTrades = true, lang: Lang = "ru"): Comparison {
  const t = dayReportT.tFor(lang);
  const window = history
    .filter((h) => h.date < date && Number.isFinite(h.net))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, lookback);
  const n = window.length;
  const empty: Comparison = { days: n, avg: null, std: null, z: null, betterThanPct: null, rank: null, bestDay: null, worstDay: null, label: "" };
  if (!n) return { ...empty, label: t("cmp.none") };
  const nets = window.map((h) => h.net);
  const avg = sum(nets) / n;
  const std = n > 1 ? Math.sqrt(sum(nets.map((x) => (x - avg) ** 2)) / (n - 1)) : null;
  const z = std != null && std > 0 ? r2((todayNet - avg) / std) : null;
  const below = nets.filter((x) => x < todayNet).length;
  const ties = nets.filter((x) => x === todayNet).length;
  const betterThanPct = (below + ties / 2) / n;
  const rank = 1 + nets.filter((x) => x > todayNet).length;
  const bestDay = window.reduce((a, b) => (b.net > a.net ? b : a));
  const worstDay = window.reduce((a, b) => (b.net < a.net ? b : a));
  const pct = Math.round(betterThanPct * 100);
  const label = !hasTrades
    ? t("cmp.noTrades", { n, avg: usd(avg, true) })
    : `${t("cmp.better", { pct, n })}${z != null ? t("cmp.z", { z: `${z > 0 ? "+" : ""}${z.toFixed(2)}` }) : ""}`;
  return { days: n, avg: r2(avg), std: std != null ? r2(std) : null, z, betterThanPct, rank, bestDay, worstDay, label };
}

export function computeEquity(trades: DayTrade[]): Equity {
  const closed = trades.filter((t) => t.net != null).sort(byExit);
  const srcs = new Set(closed.map((t) => t.timeSource));
  const timeSource: TimeSource = srcs.has("executions") ? "executions" : srcs.has("snapshot") ? "snapshot" : "none";
  const firstEntry = closed.reduce<number | null>((m, t) => (t.entryAt != null && (m == null || t.entryAt < m) ? t.entryAt : m), null);
  const points: EquityPoint[] = [{ t: firstEntry, time: etTime(firstEntry), tradeId: null, ticker: null, net: 0, cum: 0 }];
  let cum = 0;
  let peak = { value: 0, time: points[0].time, tradeId: null as number | null };
  let trough = { value: 0, time: points[0].time, tradeId: null as number | null };
  let dd = { value: 0, fromTime: null as string | null, toTime: null as string | null, fromTradeId: null as number | null, toTradeId: null as number | null };
  for (const t of closed) {
    cum = r2(cum + t.net!);
    const time = etTime(t.exitAt ?? t.entryAt);
    points.push({ t: t.exitAt ?? t.entryAt, time, tradeId: t.id, ticker: t.ticker, net: r2(t.net!), cum });
    if (cum > peak.value) peak = { value: cum, time, tradeId: t.id };
    if (cum < trough.value) trough = { value: cum, time, tradeId: t.id };
    const drop = r2(peak.value - cum);
    if (drop > dd.value) dd = { value: drop, fromTime: peak.time, toTime: time, fromTradeId: peak.tradeId, toTradeId: t.id };
  }
  return { timeSource, points, peak, trough, maxDrawdown: dd, final: cum, giveback: r2(Math.max(0, peak.value - cum)) };
}

export function computeTimeline(trades: DayTrade[]): TimelineRow[] {
  const ordered = [...trades].sort(byEntry);
  // Нарастающий итог — по порядку закрытия.
  const cumById = new Map<number, number>();
  let cum = 0;
  for (const t of [...trades].filter((x) => x.net != null).sort(byExit)) { cum = r2(cum + t.net!); cumById.set(t.id, cum); }
  let lastExit: number | null = null;
  return ordered.map((t, i) => {
    const rawGap = t.entryAt != null && lastExit != null ? r2((t.entryAt - lastExit) / 60000) : null;
    // Вход при ещё открытой предыдущей позиции — «параллельно» (пауза не определена).
    const overlap = rawGap != null && rawGap < 0;
    const gapMin = overlap ? null : rawGap;
    // «После убытка»: последняя сделка, закрытая до этого входа, была убыточной.
    const prevClosed = ordered
      .filter((p) => p !== t && p.exitAt != null && t.entryAt != null && p.exitAt <= t.entryAt)
      .sort((a, b) => b.exitAt! - a.exitAt!)[0];
    const afterLoss = !!prevClosed && isLoss(prevClosed);
    const row: TimelineRow = {
      ...refOf(t), index: i + 1, result: t.result, gapMin, overlap,
      cumAfter: cumById.get(t.id) ?? null, afterLoss,
    };
    if (t.exitAt != null) lastExit = lastExit == null ? t.exitAt : Math.max(lastExit, t.exitAt);
    return row;
  });
}

export function computeBreakdown(trades: DayTrade[], lang: Lang = "ru"): DayReport["breakdown"] {
  const sideLabel = (k: string) => dayReportT.tryFor(lang, `side.${k}`) ?? k;
  const closed = trades.filter((t) => t.net != null);
  const byNet = (a: Bucket, b: Bucket) => b.net - a.net || a.key.localeCompare(b.key);
  return {
    byTicker: bucketize(closed, (t) => t.ticker, (k) => k).sort(byNet),
    byHour: bucketize(closed, (t) => (t.entryAt != null ? String(etHour(t.entryAt)).padStart(2, "0") : null), (k) => `${k}:00–${String(+k + 1).padStart(2, "0")}:00`)
      .sort((a, b) => a.key.localeCompare(b.key)),
    bySide: bucketize(closed, (t) => t.side, sideLabel).sort(byNet),
  };
}

/* ─── Утечки ───────────────────────────────────────────────────────────────── */

function leak(kind: LeakKind, title: string, detail: string, ts: DayTrade[], costUsd: number): Leak {
  const netUsd = r2(sum(ts.map((t) => t.net ?? 0)));
  const cost = r2(Math.max(0, costUsd));
  return {
    kind, title, detail, count: ts.length, tradeIds: ts.map((t) => t.id), netUsd, costUsd: cost,
    severity: cost >= 50 || ts.length >= 3 ? "high" : cost >= 10 ? "medium" : "low",
  };
}

export function computeLeaks(trades: DayTrade[], equity: Equity, dailyLossLimit: number | null, opts: Required<DayReportOptions>): Leak[] {
  const L = dayReportT.tFor(opts.lang);
  const closed = trades.filter((t) => t.net != null);
  const out: Leak[] = [];

  // 1. Комиссия больше |брутто| — сделка заведомо не окупила издержки.
  const feeHeavy = closed.filter((t) => t.fees > 0 && t.fees > Math.abs(t.gross ?? 0));
  if (feeHeavy.length) {
    const fees = sum(feeHeavy.map((t) => t.fees));
    out.push(leak("fee_over_gross", L("leak.feeTitle"),
      L("leak.feeDetail", { n: feeHeavy.length, fees: usd(fees), net: usd(sum(feeHeavy.map((t) => t.net!)), true) }),
      feeHeavy, fees));
  }

  // 2. Сделки, закрытые после пика дня (отдача): берём только реально закрытые позже пика.
  if (equity.giveback > 0 && equity.peak.tradeId != null) {
    const peakIdx = equity.points.findIndex((p) => p.tradeId === equity.peak.tradeId);
    const afterIds = new Set(equity.points.slice(peakIdx + 1).map((p) => p.tradeId).filter((x): x is number => x != null));
    const after = closed.filter((t) => afterIds.has(t.id));
    if (after.length) {
      out.push(leak("after_peak", L("leak.peakTitle"),
        L("leak.peakDetail", { peak: usd(equity.peak.value, true), time: equity.peak.time ?? "—", final: usd(equity.final, true), giveback: usd(equity.giveback), n: after.length }),
        after, equity.giveback));
    }
  }

  // 3/4. Вход вскоре после убытка (реванш) и рост размера после убытка.
  const ordered = closed.filter((t) => t.entryAt != null).sort(byEntry);
  const revenge: DayTrade[] = [];
  const sizeUp: DayTrade[] = [];
  for (const t of ordered) {
    const prev = ordered
      .filter((p) => p !== t && p.exitAt != null && p.exitAt <= t.entryAt!)
      .sort((a, b) => b.exitAt! - a.exitAt!)[0];
    if (!prev || !isLoss(prev)) continue;
    if ((t.entryAt! - prev.exitAt!) / 60000 < opts.revengeMin) revenge.push(t);
    if (t.qty != null && prev.qty != null && prev.qty > 0 && Math.abs(t.qty) > Math.abs(prev.qty) * opts.sizeUpFactor) sizeUp.push(t);
  }
  if (revenge.length) {
    const net = sum(revenge.map((t) => t.net!));
    out.push(leak("revenge", L("leak.revengeTitle", { min: opts.revengeMin }),
      L("leak.revengeDetail", { n: revenge.length, min: opts.revengeMin, net: usd(net, true) }),
      revenge, -net));
  }
  if (sizeUp.length) {
    const net = sum(sizeUp.map((t) => t.net!));
    out.push(leak("size_up", L("leak.sizeTitle"),
      L("leak.sizeDetail", { n: sizeUp.length, factor: opts.sizeUpFactor, net: usd(net, true) }),
      sizeUp, -net));
  }

  // 5. Торговля после достижения дневного лимита убытка.
  if (dailyLossLimit != null && dailyLossLimit > 0) {
    const hit = equity.points.find((p) => p.tradeId != null && p.cum <= -dailyLossLimit);
    if (hit) {
      const hitAt = hit.t;
      const after = closed.filter((t) => t.id !== hit.tradeId && (hitAt == null
        ? equity.points.findIndex((p) => p.tradeId === t.id) > equity.points.indexOf(hit)
        : (t.entryAt ?? t.exitAt ?? 0) >= hitAt));
      if (after.length) {
        const net = sum(after.map((t) => t.net!));
        // Цена нарушения лимита — все убытки, взятые сверх лимита (прибыльные сделки их не «отменяют»).
        const lossesAfter = sum(after.map((t) => Math.min(0, t.net!)));
        out.push(leak("after_limit", L("leak.limitTitle"),
          L("leak.limitDetail", { limit: usd(dailyLossLimit), time: hit.time ?? "—", n: after.length, net: usd(net, true), losses: usd(lossesAfter) }),
          after, -lossesAfter));
        out[out.length - 1].severity = "high";
      }
    }
  }

  return out.sort((a, b) => b.costUsd - a.costUsd || a.kind.localeCompare(b.kind));
}

/* ─── Сильные стороны ──────────────────────────────────────────────────────── */

function edgeOf(b: Bucket): EdgeItem {
  return { key: b.key, label: b.label, trades: b.trades, wins: b.wins, losses: b.losses, net: b.net, winRate: b.winRate };
}

export function computeStrengths(trades: DayTrade[], breakdown: DayReport["breakdown"]): Strengths {
  const closed = trades.filter((t) => t.net != null);
  const top = closed.filter((t) => t.net! > 0).sort((a, b) => b.net! - a.net! || a.id - b.id).slice(0, 3).map(refOf);
  const hasEdge = (b: Bucket) => b.net > 0 && (b.winRate ?? 0) >= 0.5;
  const setups = bucketize(closed, (t) => t.setup, (k) => k).filter(hasEdge).sort((a, b) => b.net - a.net).map(edgeOf);
  const bestHour = [...breakdown.byHour].filter((b) => b.net > 0).sort((a, b) => b.net - a.net)[0] ?? null;
  return {
    topTrades: top,
    tickers: breakdown.byTicker.filter(hasEdge).map(edgeOf),
    setups,
    sides: breakdown.bySide.filter(hasEdge).map(edgeOf),
    bestHour,
  };
}

/* ─── План на завтра ───────────────────────────────────────────────────────── */

export function buildPlan(r: Pick<DayReport, "summary" | "leaks" | "breakdown" | "strengths" | "equity" | "dailyLossLimit" | "timeline">, opts: Required<DayReportOptions>): PlanItem[] {
  const P = dayReportT.tFor(opts.lang);
  const plan: PlanItem[] = [];
  const add = (p: PlanItem) => { if (!plan.some((x) => x.id === p.id)) plan.push(p); };

  for (const l of r.leaks) {
    const cost = l.costUsd > 0 ? P("plan.costToday", { cost: usd(l.costUsd).replace("−", "") }) : P("plan.countToday", { n: l.count, net: usd(l.netUsd, true) });
    switch (l.kind) {
      case "revenge":
        add({ id: "revenge", source: l.kind, costUsd: l.costUsd || null, reason: l.detail,
          text: P("plan.revenge", { min: Math.max(3, opts.revengeMin + 1), cost }) });
        break;
      case "size_up":
        add({ id: "size_up", source: l.kind, costUsd: l.costUsd || null, reason: l.detail,
          text: P("plan.sizeUp", { cost }) });
        break;
      case "after_peak": {
        const lock = r2(Math.max(r.equity.peak.value * 0.5, 0));
        add({ id: "after_peak", source: l.kind, costUsd: l.costUsd || null, reason: l.detail,
          text: P("plan.afterPeak", { peak: usd(r.equity.peak.value, true), lock: usd(lock, true), cost }) });
        break;
      }
      case "fee_over_gross":
        add({ id: "fee_over_gross", source: l.kind, costUsd: l.costUsd || null, reason: l.detail,
          text: P("plan.feeOverGross", { cost }) });
        break;
      case "after_limit":
        add({ id: "after_limit", source: l.kind, costUsd: l.costUsd || null, reason: l.detail,
          text: P("plan.afterLimit", { limit: usd(r.dailyLossLimit ?? 0).replace("−", ""), cost }) });
        break;
    }
  }

  const s = r.summary;
  // Убыточный тикер с ≥2 убытками — не возвращаться.
  const badTicker = r.breakdown.byTicker.filter((b) => b.losses >= 2 && b.net < 0).sort((a, b) => a.net - b.net)[0];
  if (badTicker) {
    add({ id: `ticker_${badTicker.key}`, source: "stat", costUsd: r2(-badTicker.net), reason: P("plan.tickerReason", { ticker: badTicker.label, losses: badTicker.losses, net: usd(badTicker.net, true) }),
      text: P("plan.ticker", { ticker: badTicker.label, net: usd(badTicker.net, true) }) });
  }
  // Удержание убытков дольше прибылей.
  const holds = (pred: (t: TimelineRow) => boolean) => r.timeline.filter((t) => pred(t) && t.holdMin != null).map((t) => t.holdMin!);
  const hw = holds((t) => (t.net ?? 0) > 0);
  const hl = holds((t) => (t.net ?? 0) < 0);
  const avg = (xs: number[]) => (xs.length ? sum(xs) / xs.length : null);
  const aw = avg(hw), al = avg(hl);
  if (aw != null && al != null && al > aw * 1.5 && al >= 2) {
    add({ id: "hold_losers", source: "stat", costUsd: null, reason: P("plan.holdReason", { losers: al.toFixed(1), winners: aw.toFixed(1) }),
      text: P("plan.hold", { losers: al.toFixed(0), winners: aw.toFixed(0) }) });
  }
  // Высокая доля комиссий.
  if (s.feeShareOfGross != null && s.feeShareOfGross >= 0.2 && !plan.some((p) => p.id === "fee_over_gross")) {
    add({ id: "fee_share", source: "stat", costUsd: s.fees, reason: P("plan.feeShareReason", { fees: usd(s.fees), pct: Math.round(s.feeShareOfGross * 100) }),
      text: P("plan.feeShare", { pct: Math.round(s.feeShareOfGross * 100) }) });
  }
  // Убыточное окно по часу.
  const badHour = r.breakdown.byHour.filter((b) => b.net < 0 && b.trades >= 2).sort((a, b) => a.net - b.net)[0];
  if (badHour) {
    add({ id: `hour_${badHour.key}`, source: "stat", costUsd: r2(-badHour.net), reason: P("plan.hourReason", { hour: badHour.label, n: badHour.trades, net: usd(badHour.net, true) }),
      text: P("plan.hour", { hour: badHour.label, net: usd(badHour.net, true), n: badHour.trades }) });
  }
  // Повторить сильное.
  const bestTicker = r.strengths.tickers[0];
  if (bestTicker && plan.length < 5) {
    add({ id: `repeat_${bestTicker.key}`, source: "stat", costUsd: null, reason: P("plan.repeatReason", { ticker: bestTicker.label, wins: bestTicker.wins, n: bestTicker.trades, net: usd(bestTicker.net, true) }),
      text: P("plan.repeat", { ticker: bestTicker.label, net: usd(bestTicker.net, true) }) });
  }
  if (r.strengths.bestHour && plan.length < 3) {
    const h = r.strengths.bestHour;
    add({ id: `besthour_${h.key}`, source: "stat", costUsd: null, reason: P("plan.bestHourReason", { hour: h.label, net: usd(h.net, true) }),
      text: P("plan.bestHour", { hour: h.label, net: usd(h.net, true) }) });
  }
  if (plan.length < 3 && s.closed > 0) {
    add({ id: "journal", source: "stat", costUsd: null, reason: P("plan.journalReason"),
      text: P("plan.journal", { n: s.closed }) });
  }
  if (plan.length < 3 && s.closed > 0) {
    add({ id: "max_loss", source: "stat", costUsd: null, reason: r.dailyLossLimit ? P("plan.limitReason", { limit: usd(r.dailyLossLimit) }) : P("plan.noLimitReason"),
      text: r.dailyLossLimit
        ? P("plan.limit", { limit: usd(r.dailyLossLimit), half: usd(r2(r.dailyLossLimit / 2)).replace("−", "") })
        : P("plan.noLimit") });
  }
  return plan.slice(0, 5);
}

/* ─── Сборка ───────────────────────────────────────────────────────────────── */

export function buildDayReport(input: DayReportInput): DayReport {
  const opts: Required<DayReportOptions> = {
    revengeMin: input.options?.revengeMin ?? 2,
    sizeUpFactor: input.options?.sizeUpFactor ?? 1.2,
    lookbackDays: input.options?.lookbackDays ?? 20,
    lang: input.options?.lang ?? "ru",
  };
  const trades = input.trades;
  const summary = computeSummary(trades);
  const comparison = computeComparison(summary.net, input.date, input.history, opts.lookbackDays, summary.closed > 0, opts.lang);
  const equity = computeEquity(trades);
  const timeline = computeTimeline(trades);
  const breakdown = computeBreakdown(trades, opts.lang);
  const leaks = computeLeaks(trades, equity, input.dailyLossLimit, opts);
  const strengths = computeStrengths(trades, breakdown);
  const plan = buildPlan({ summary, leaks, breakdown, strengths, equity, dailyLossLimit: input.dailyLossLimit, timeline }, opts);
  const entries = trades.map((t) => t.entryAt).filter((x): x is number => x != null);
  const exits = trades.map((t) => t.exitAt).filter((x): x is number => x != null);
  const firstEntryMs = entries.length ? Math.min(...entries) : null;
  const lastExitMs = exits.length ? Math.max(...exits) : null;
  return {
    trader: input.trader,
    date: input.date,
    weekday: weekdayOf(input.date, opts.lang),
    summary,
    comparison,
    equity,
    timeline,
    breakdown,
    leaks,
    // Утечки пересекаются (одна сделка может быть и «реваншем», и «после пика») — сумма уникальных потерь по сделкам.
    leaksTotalUsd: r2(uniqueLeakCost(leaks, trades)),
    strengths,
    plan,
    dailyLossLimit: input.dailyLossLimit,
    firstEntry: etTime(firstEntryMs),
    lastExit: etTime(lastExitMs),
    activeMinutes: firstEntryMs != null && lastExitMs != null && lastExitMs > firstEntryMs ? Math.round((lastExitMs - firstEntryMs) / 60000) : null,
  };
}

/** Без двойного счёта: убыточные помеченные сделки по разу (−нетто) + комиссии прибыльных «комиссионных» сделок. */
function uniqueLeakCost(leaks: Leak[], trades: DayTrade[]): number {
  const ids = new Set<number>();
  const feeIds = new Set<number>();
  for (const l of leaks) for (const id of l.tradeIds) (l.kind === "fee_over_gross" ? feeIds : ids).add(id);
  let total = 0;
  for (const t of trades) {
    if (t.net == null) continue;
    if (t.net < 0 && (ids.has(t.id) || feeIds.has(t.id))) total += -t.net;
    else if (feeIds.has(t.id)) total += t.fees;
  }
  return total;
}
