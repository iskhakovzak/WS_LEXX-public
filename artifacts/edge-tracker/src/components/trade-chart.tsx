import { useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  CrosshairMode,
  LineStyle,
  createSeriesMarkers,
  type IChartApi,
  type UTCTimestamp,
  type SeriesMarker,
  type Time,
  type MouseEventParams,
} from "lightweight-charts";
import {
  Loader2, AlertTriangle, CalendarX, Clock, CandlestickChart, Maximize2, ChevronsUpDown, RotateCw,
  type LucideIcon,
} from "lucide-react";
import { ApiError, http } from "@/lib/api/http";
import { cn } from "@/lib/utils";
import { Segmented, FilterChip, Pill, toneOf, toneText, type Tone } from "@/components/ds";
import { Skeleton } from "@/components/ui/skeleton";
import { chartI18n } from "@/i18n/ns/chart";
import { commonI18n } from "@/i18n/ns/common";
import { roleLabel } from "@/components/chart-engine/lib/structure";
import { tradeWindow } from "@/components/chart-engine/lib/window";
import {
  type Candle, type CandlesResponse, type Execution, type ExecutionKind, type ExecutionsResponse, type Resolved, type ChartPrefs,
  fmtEtDay, fmtEtTime, timeToDate, fmtEtDateTime, fmtEtDateTimeSec, fmtEtTimeSec, fmtDuration, sessionOfEt, ET_SESSION_LABEL, etInfo, isPreMarket, isAfterHours, isRegularHours, toNum,
  computeSessionVwap, computeDayLevels, resolveExecutions, placeSimple, computeExcursion,
  readChartTheme, useThemeVersion, loadPrefs, savePrefs,
} from "@/components/trade-chart-parts/chart-utils";
import { fmtCompact, fmtCount, fmtPct, fmtPrice, fmtR, fmtUsd, localeTag } from "@/lib/format";

type TradeChartProps = {
  tradeId?: number | null;
  ticker: string;
  date: string;
  side?: string | null;
  entry?: number | string | null;
  exit?: number | string | null;
  stop?: number | string | null;
  /** Optional profit target — drawn as «Цель» line. */
  target?: number | string | null;
  /** Optional logged R-multiple; used when R can't be derived from prices. */
  rMultiple?: number | string | null;
  /** Optional base chart height in px (default 360). */
  height?: number;
  /**
   * Multi-day trades (overnight / swing): the exit day and horizon. With them the chart loads every day the position
   * was open (same range endpoint as the replay), not only the entry day.
   */
  exitDate?: string | null;
  horizon?: string | null;
  /** "open" keeps an unfinished multi-day trade running to today. */
  result?: string | null;
  className?: string;
};

type Interval = "1m" | "2m" | "3m" | "5m" | "15m" | "30m" | "60m" | "1d";
type ApiInterval = Exclude<Interval, "2m" | "3m">;
/** 2м / 3м are folded from 1-minute bars on the client (the candles API serves 1m / 5m / 15m / 30m / 60m / 1d). */
const GROUPED: Partial<Record<Interval, number>> = { "2m": 120, "3m": 180 };
const apiIntervalOf = (i: Interval): ApiInterval => (GROUPED[i] ? "1m" : (i as ApiInterval));

/** Fold sorted 1-minute candles into `sec`-long bars aligned to the clock (9:30 starts a 2m / 3m bar). */
function groupCandles(candles: readonly Candle[], sec: number): Candle[] {
  const out: Candle[] = [];
  for (const c of candles) {
    const t = Math.floor(c.t / sec) * sec;
    const last = out[out.length - 1];
    if (last && last.t === t) { last.h = Math.max(last.h, c.h); last.l = Math.min(last.l, c.l); last.c = c.c; last.v += c.v; }
    else out.push({ t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });
  }
  return out;
}

const TIMEFRAMES: readonly Interval[] = ["1m", "2m", "3m", "5m", "15m", "30m", "60m", "1d"];
const INTERVAL_SEC: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "60m": 3600, "1d": 86400 };
/** Dictionary key of an interval's chip label («1м» / «1m»). */
const TF_KEY = { "1m": "1m", "2m": "2m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m", "60m": "1h", "1d": "1d" } as const;
/** Chip label of an interval in the UI language; unknown codes are shown as they are. */
function intervalLabel(i: string | null | undefined): string {
  if (!i) return "";
  return i in TF_KEY ? chartI18n.t(`tf.${TF_KEY[i as Interval]}`) : i;
}

const KIND_LABEL = (k: ExecutionKind): string => chartI18n.t(`kind.${k}`);

/** The recognised role («Перезаход», «Частичный фикс», «Стоп?») when known, else the stored kind. */
const execLabel = (e: Execution): string => (e.role ? roleLabel(e.role, !!e.roleInferred) : KIND_LABEL(e.kind));

type Shape = "arrowUp" | "arrowDown" | "square" | "circle";
type BarPos = "aboveBar" | "belowBar" | "inBar";

type ExecStyle = { color: string; shape: Shape; position: BarPos };

function styleFor(kind: ExecutionKind, isShort: boolean, th: ReturnType<typeof readChartTheme>): ExecStyle {
  const opening = { shape: (isShort ? "arrowDown" : "arrowUp") as Shape, position: (isShort ? "aboveBar" : "belowBar") as BarPos };
  const closing = { shape: (isShort ? "arrowUp" : "arrowDown") as Shape, position: (isShort ? "belowBar" : "aboveBar") as BarPos };
  switch (kind) {
    case "entry": return { color: th.primary(), ...opening };
    case "add": return { color: th.c1(0.75), ...opening };
    case "trim": return { color: th.c3(), ...closing };
    case "exit": return { color: th.c5(), ...closing };
    case "stop": return { color: th.down(), shape: "square", position: "inBar" };
  }
}

const KIND_DOT: Record<ExecutionKind, string> = {
  entry: "bg-primary",
  add: "bg-[hsl(var(--chart-1)/0.75)]",
  trim: "bg-[hsl(var(--chart-3))]",
  exit: "bg-[hsl(var(--chart-5))]",
  stop: "bg-down",
};

type TooltipState = { x: number; y: number; rows: Resolved[] } | null;

function avgPrice(rows: Execution[]): number | null {
  if (!rows.length) return null;
  let pq = 0, q = 0, allQty = true;
  for (const r of rows) {
    const p = Number(r.price);
    const n = r.qty != null ? Number(r.qty) : NaN;
    if (Number.isFinite(n) && Number.isFinite(p)) { pq += p * n; q += n; } else allQty = false;
  }
  if (allQty && q > 0) return pq / q;
  const ps = rows.map((r) => Number(r.price)).filter(Number.isFinite);
  return ps.length ? ps.reduce((s, p) => s + p, 0) / ps.length : null;
}

function errorInfo(err: Error, date: string): { icon: LucideIcon; text: string; retry: boolean } {
  const reason = err instanceof ApiError ? err.field<string>("reason") : undefined;
  const t = chartI18n.t;
  if (err.message === "non_trading_day" && reason === "weekend") return { icon: CalendarX, text: t("card.weekend", { date }), retry: false };
  if (err.message === "non_trading_day" && reason === "future") return { icon: Clock, text: t("card.future", { date }), retry: false };
  if (err.message === "no candles available") return { icon: AlertTriangle, text: t("card.noCandlesDay", { date }), retry: true };
  if (err.message === "invalid date (expected calendar YYYY-MM-DD)" || err.message === "invalid ticker" || err.message === "INVALID_TICKER") return { icon: AlertTriangle, text: t("card.invalid", { message: err.message }), retry: false };
  return { icon: AlertTriangle, text: t("card.loadFailed", { message: err.message }), retry: true };
}

/** GET /api/candles/:ticker/range (multi-day trades). */
type RangeResponse = { ticker: string; from: string; to: string; interval: string; candles: Candle[]; prevClose: number | null };

/** Close of the last regular-session bar before `dayKey` (the trade day's previous close when context days are loaded). */
function prevRegularClose(candles: readonly Candle[], dayKey: string): number | null {
  for (let i = candles.length - 1; i >= 0; i--) {
    const info = etInfo(candles[i].t);
    if (info.dayKey < dayKey && isRegularHours(info)) return candles[i].c;
  }
  return null;
}

function MiniStat({ label, value, tone = "neutral", hint }: { label: string; value: ReactNode; tone?: Tone; hint?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl bg-[var(--glass-bg)] px-3 py-2">
      <div className="truncate text-2xs text-muted-foreground">{label}</div>
      <div className={cn("truncate text-sm font-semibold tabular-nums", toneText(tone))}>{value}</div>
      {hint && <div className="truncate text-2xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function TradeChart({ tradeId, ticker, date, side, entry, exit, stop, target, rMultiple, height = 360, className, exitDate, horizon, result }: TradeChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const resolvedByTimeRef = useRef(new Map<number, Resolved[]>());
  const candleByTimeRef = useRef(new Map<number, Candle>());
  const themeVersion = useThemeVersion();
  const { t: tc } = chartI18n.useT();

  const dateKey = (date || "").slice(0, 10);
  // Ask for 1-minute bars: the server answers with the finest the day has (permanent candle archive, else what the
  // provider still serves for a day that old) and says which in `interval`.
  const autoInterval: Interval = "1m";

  const [interval, setIntervalState] = useState<Interval>(autoInterval);
  const [prefs, setPrefs] = useState<ChartPrefs>(() => loadPrefs());
  const [tooltip, setTooltip] = useState<TooltipState>(null);
  const [hover, setHover] = useState<Candle | null>(null);
  const [containerSize, setContainerSize] = useState<{ width: number; height: number } | null>(null);


  const updatePrefs = useCallback((patch: Partial<ChartPrefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      savePrefs(next);
      return next;
    });
  }, []);

  const apiInterval = apiIntervalOf(interval);
  // Context days that would cost resolution are dropped by the server (it keeps the trade day's finest bars).
  const effectiveDaysBack = prefs.daysBack;
  // Overnight / swing: every day from the entry to the exit (same window as the replay). A horizon that was not passed
  // is implied by an exit on a later day.
  const exitKey = (exitDate || "").slice(0, 10);
  const win = useMemo(() => tradeWindow(
    { id: tradeId ?? 0, ticker, date: dateKey, exitDate: exitKey || null, result: result ?? null, horizon: horizon === "overnight" || horizon === "swing" ? horizon : exitKey > dateKey ? "overnight" : null },
    effectiveDaysBack,
  ), [tradeId, ticker, dateKey, exitKey, result, horizon, effectiveDaysBack]);
  const multiDay = win.multiDay && win.toKey > dateKey;
  const lastKey = multiDay ? win.toKey : dateKey;

  const executionsQuery = useQuery<ExecutionsResponse>({
    queryKey: ["trade-executions", tradeId],
    queryFn: ({ signal }) => http.get<ExecutionsResponse>(`/api/trades/${tradeId}/executions`, { signal }),
    enabled: Boolean(tradeId),
    staleTime: 30 * 1000,
  });
  const allExecutions = useMemo(() => executionsQuery.data?.executions ?? [], [executionsQuery.data]);
  // A 09:28 entry or a 16:04 exit lives outside regular hours: without extended bars the fill would be pinned to
  // the nearest regular bar (wrong time, wrong candle), so extended hours switch on whenever a fill needs them.
  const needExtended = useMemo(() => allExecutions.some((e) => { const s = e.executedAt ? sessionOfEt(e.executedAt) : null; return s === "premarket" || s === "postmarket"; }), [allExecutions]);
  const extended = prefs.extended || needExtended;

  const candlesQuery = useQuery<CandlesResponse>({
    queryKey: ["trade-candles", ticker, dateKey, extended, apiInterval, effectiveDaysBack, multiDay ? lastKey : null],
    queryFn: async ({ signal }) => {
      if (multiDay) {
        // Multi-day: the replay's range route (finest bars the trade days have; older context days may be dropped).
        const r = await http.get<RangeResponse>(`/api/candles/${encodeURIComponent(ticker)}/range?from=${win.fromKey}&to=${lastKey}&interval=${apiInterval}${extended ? "&extended=1" : ""}&trim=1`, { signal });
        const prevClose = r.from === dateKey ? r.prevClose : prevRegularClose(r.candles.filter((c) => etInfo(c.t).dayKey < dateKey), dateKey) ?? r.prevClose;
        return { ticker: r.ticker, date: dateKey, interval: r.interval, candles: r.candles, prevClose };
      }
      const url = `/api/candles/${encodeURIComponent(ticker)}?date=${encodeURIComponent(dateKey)}&interval=${apiInterval}${extended ? "&extended=1" : ""}${effectiveDaysBack > 0 ? `&daysBack=${effectiveDaysBack}` : ""}&levels=1`;
      return http.get<CandlesResponse>(url, { signal });
    },
    enabled: Boolean(ticker && dateKey),
    staleTime: 5 * 60 * 1000,
    placeholderData: (prev) => prev,
    retry: (count, err) => {
      const status = err instanceof ApiError ? err.status : undefined;
      if (status === 422 || status === 400) return false;
      return count < 1;
    },
  });

  const data = candlesQuery.data;
  // Finest bars this day has (learned from the 1-minute request): finer timeframes are shown disabled with the reason.
  const [finestSec, setFinestSec] = useState<number>(60);
  // Another trade in the same sheet: start again from the finest bars.
  useEffect(() => { setFinestSec(60); setIntervalState(autoInterval); }, [ticker, dateKey, autoInterval]);
  useEffect(() => {
    // Placeholder data is the previous trade's answer — wait for this trade's own.
    if (apiInterval !== "1m" || !data?.interval || candlesQuery.isPlaceholderData) return;
    setFinestSec(INTERVAL_SEC[data.interval] ?? 60);
    // The day only has coarser bars: select what is actually shown.
    if (data.interval !== "1m" && interval === "1m") setIntervalState(data.interval as Interval);
  }, [apiInterval, data?.interval, interval, candlesQuery.isPlaceholderData]);
  const finestLabel = intervalLabel(Object.keys(INTERVAL_SEC).find((k) => INTERVAL_SEC[k] === finestSec));
  // Defensive: Yahoo may append the live bar of *today* to historical data — keep bars up to the last trade day only.
  const candles = useMemo(() => {
    const day = (data?.candles ?? []).filter((c) => etInfo(c.t).dayKey <= lastKey);
    const sec = GROUPED[interval];
    return sec && data?.interval === "1m" ? groupCandles(day, sec) : day;
  }, [data, lastKey, interval]);
  /** Trading days of the trade on the chart (entry day → exit day), for the multi-day header. */
  const tradeDays = useMemo(() => {
    if (!multiDay) return 1;
    const days = new Set<string>();
    for (const c of candles) { const k = etInfo(c.t).dayKey; if (k >= dateKey && k <= lastKey) days.add(k); }
    return Math.max(1, days.size);
  }, [multiDay, candles, dateKey, lastKey]);
  const isLoading = candlesQuery.isLoading;
  const isFetching = candlesQuery.isFetching;
  const error = candlesQuery.error;
  const isShort = (side || "").toLowerCase().includes("short");

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setContainerSize({ width: r.width, height: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [data]);

  const addCount = useMemo(() => allExecutions.filter((e) => e.kind === "add").length, [allExecutions]);

  // ── Trade geometry: placement, averages, R, excursion ────────────────────
  const trade = useMemo(() => {
    const entryNum = toNum(entry);
    const exitNum = toNum(exit);
    const stopNum = toNum(stop);
    const targetNum = toNum(target);
    const resolved = resolveExecutions(candles, allExecutions);
    const openings = allExecutions.filter((e) => e.kind === "entry" || e.kind === "add");
    const closings = allExecutions.filter((e) => e.kind === "exit" || e.kind === "trim" || e.kind === "stop");
    const avgEntry = avgPrice(openings);
    const avgExit = avgPrice(closings);
    const effEntry = avgEntry ?? entryNum;
    const effExit = avgExit ?? exitNum;

    let entryIdx: number | null = null;
    let exitIdx: number | null = null;
    let entryAt: number | null = null;
    let exitAt: number | null = null;
    if (resolved.length) {
      const opens = resolved.filter((r) => r.exec.kind === "entry" || r.exec.kind === "add");
      const closes = resolved.filter((r) => r.exec.kind === "exit" || r.exec.kind === "trim" || r.exec.kind === "stop");
      entryIdx = opens.length ? Math.min(...opens.map((r) => r.idx)) : null;
      exitIdx = closes.length ? Math.max(...closes.map((r) => r.idx)) : null;
      const openAts = opens.map((r) => r.at).filter((x): x is number => x != null);
      const closeAts = closes.map((r) => r.at).filter((x): x is number => x != null);
      entryAt = openAts.length === opens.length && openAts.length ? Math.min(...openAts) : null;
      exitAt = closeAts.length === closes.length && closeAts.length ? Math.max(...closeAts) : null;
    } else {
      const p = placeSimple(candles, dateKey, entryNum, exitNum);
      entryIdx = p.entryIdx;
      exitIdx = p.exitIdx;
    }

    const risk = effEntry != null && stopNum != null && stopNum > 0 && Math.abs(effEntry - stopNum) > 1e-9 ? Math.abs(effEntry - stopNum) : null;
    const move = effEntry != null && effExit != null ? (isShort ? effEntry - effExit : effExit - effEntry) : null;
    const loggedR = toNum(rMultiple);
    const realizedR = risk != null && move != null ? move / risk : loggedR;
    // Fill instants cut the entry/exit bars down to the known path (open → fills → close), so the low that
    // printed before the entry fill no longer counts as MAE.
    // «After the exit» looks at the rest of the exit day (a multi-day trade exits on a later day).
    const exitDay = exitIdx != null && candles[exitIdx] ? etInfo(candles[exitIdx].t).dayKey : dateKey;
    const excursion = entryIdx != null && effEntry != null && candles.length
      ? computeExcursion(candles, entryIdx, exitIdx, effEntry, effExit, isShort, exitDay, { entryAt, exitAt })
      : null;
    const holdSeconds = entryAt != null && exitAt != null && exitAt >= entryAt ? exitAt - entryAt : null;
    const timed = entryAt != null && (exitIdx == null || exitAt != null);

    return { entryNum, exitNum, stopNum, targetNum, resolved, avgEntry, avgExit, effEntry, effExit, entryIdx, exitIdx, entryAt, exitAt, holdSeconds, timed, risk, move, realizedR, excursion, openings: openings.length, closings: closings.length };
  }, [candles, allExecutions, entry, exit, stop, target, rMultiple, isShort, dateKey]);

  const levels = useMemo(() => {
    const local = computeDayLevels(candles, dateKey);
    const srv = data?.sessionLevels;
    return {
      open: srv?.open ?? local.open,
      high: srv?.high ?? local.high,
      low: srv?.low ?? local.low,
      pmHigh: srv?.pmHigh ?? local.pmHigh,
      pmLow: srv?.pmLow ?? local.pmLow,
      prevClose: data?.prevClose ?? null,
    };
  }, [candles, dateKey, data]);

  // ── Chart build ──────────────────────────────────────────────────────────
  const chartHeight = prefs.tall ? Math.round(height * 1.5) : height;

  useEffect(() => {
    if (!containerRef.current || !candles.length) return;
    const th = readChartTheme();

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: "transparent" },
        textColor: th.muted(),
        fontFamily: th.font,
        fontSize: 11,
      },
      grid: {
        vertLines: { color: th.border(th.dark ? 0.45 : 0.6) },
        horzLines: { color: th.border(th.dark ? 0.45 : 0.6) },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: th.border(),
        tickMarkFormatter: (time: Time, tickMarkType: number) => {
          const d = timeToDate(time);
          if (!d) return "";
          return tickMarkType >= 3 ? fmtEtTime(d) : fmtEtDay(d);
        },
      },
      localization: {
        locale: localeTag(),
        timeFormatter: (time: Time) => {
          const d = timeToDate(time);
          return d ? fmtEtDateTime(d) : String(time);
        },
        priceFormatter: (p: number) => fmtPrice(p),
      },
      rightPriceScale: { borderColor: th.border() },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: th.muted(0.5), labelBackgroundColor: th.dark ? "rgba(40,42,46,1)" : "rgba(60,62,66,1)" },
        horzLine: { color: th.muted(0.5), labelBackgroundColor: th.dark ? "rgba(40,42,46,1)" : "rgba(60,62,66,1)" },
      },
      autoSize: true,
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    });
    chartRef.current = chart;

    // Session shading (pre/after hours)
    const bg = candles
      .map((c) => {
        const info = etInfo(c.t);
        const color = isPreMarket(info) ? th.c1(0.07) : isAfterHours(info) ? th.c3(0.07) : null;
        return color ? { time: c.t as UTCTimestamp, value: 1, color } : null;
      })
      .filter((x): x is { time: UTCTimestamp; value: number; color: string } => x !== null);
    if (bg.length) {
      const s = chart.addSeries(HistogramSeries, { priceScaleId: "session-bg", priceLineVisible: false, lastValueVisible: false, base: 0 });
      chart.priceScale("session-bg").applyOptions({ scaleMargins: { top: 0, bottom: 0 }, visible: false });
      s.setData(bg);
    }

    // Volume
    if (prefs.volume) {
      const vol = chart.addSeries(HistogramSeries, {
        priceScaleId: "vol",
        priceFormat: { type: "volume" },
        priceLineVisible: false,
        lastValueVisible: false,
      });
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false });
      vol.setData(candles.map((c) => ({ time: c.t as UTCTimestamp, value: Number.isFinite(c.v) ? c.v : 0, color: c.c >= c.o ? th.up(0.3) : th.down(0.3) })));
    }

    const series = chart.addSeries(CandlestickSeries, {
      upColor: th.up(),
      downColor: th.down(),
      borderUpColor: th.up(),
      borderDownColor: th.down(),
      wickUpColor: th.up(0.8),
      wickDownColor: th.down(0.8),
      priceLineVisible: false,
    });
    series.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: prefs.volume ? 0.22 : 0.08 } });
    series.setData(candles.map((c) => ({ time: c.t as UTCTimestamp, open: c.o, high: c.h, low: c.l, close: c.c })));
    candleByTimeRef.current = new Map(candles.map((c) => [c.t, c]));

    if (prefs.vwap) {
      const vwap = computeSessionVwap(candles);
      if (vwap.length) {
        const v = chart.addSeries(LineSeries, {
          color: th.c5(0.9),
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: false,
          title: "VWAP",
        });
        v.setData(vwap);
      }
    }

    const line = (price: number | null | undefined, color: string, title: string, style: LineStyle, width: 1 | 2 = 1) => {
      if (price == null || !Number.isFinite(price) || price <= 0) return;
      series.createPriceLine({ price, color, lineWidth: width, lineStyle: style, axisLabelVisible: true, title });
    };

    if (prefs.levels) {
      line(levels.open, th.c1(0.85), chartI18n.t("card.lineOpen"), LineStyle.Dashed);
      line(levels.prevClose, th.c3(0.9), chartI18n.t("card.linePrevClose"), LineStyle.Dashed);
      line(levels.pmHigh, th.muted(0.8), "PMH", LineStyle.Dotted);
      line(levels.pmLow, th.muted(0.8), "PML", LineStyle.Dotted);
    }

    // Stop is always shown (risk anchor); R ladder + entry/target are optional.
    line(trade.stopNum, th.down(0.9), trade.risk ? chartI18n.t("card.lineStopR") : chartI18n.t("card.lineStop"), LineStyle.Dashed);
    if (prefs.rLevels && trade.effEntry != null) {
      line(trade.effEntry, th.primary(0.9), trade.avgEntry != null && trade.openings > 1 ? chartI18n.t("card.lineAvgEntry") : chartI18n.t("card.lineEntry"), LineStyle.Solid);
      if (trade.risk) {
        for (const k of [1, 2, 3]) {
          const p = isShort ? trade.effEntry - k * trade.risk : trade.effEntry + k * trade.risk;
          line(p, th.up(0.55), `+${k}R`, LineStyle.SparseDotted);
        }
      }
    }
    if (trade.targetNum != null) line(trade.targetNum, th.up(0.95), chartI18n.t("card.lineTarget"), LineStyle.Solid);

    // Markers
    const markers: SeriesMarker<Time>[] = [];
    const byTime = new Map<number, Resolved[]>();
    if (trade.resolved.length) {
      const visible = trade.resolved.filter((r) => prefs.adds || r.exec.kind !== "add");
      const totals: Record<ExecutionKind, number> = { entry: 0, add: 0, trim: 0, exit: 0, stop: 0 };
      const counters: Record<ExecutionKind, number> = { entry: 0, add: 0, trim: 0, exit: 0, stop: 0 };
      for (const r of visible) totals[r.exec.kind]++;
      for (const r of visible) {
        const st = styleFor(r.exec.kind, isShort, th);
        counters[r.exec.kind]++;
        const n = totals[r.exec.kind] > 1 ? ` ${counters[r.exec.kind]}` : "";
        const q = r.exec.qty ? ` ×${Number(r.exec.qty)}` : "";
        markers.push({ time: r.candle.t as UTCTimestamp, position: st.position, color: st.color, shape: st.shape, text: `${execLabel(r.exec)}${n} ${fmtPrice(r.price)}${q}` });
        const list = byTime.get(r.candle.t) ?? [];
        list.push(r);
        byTime.set(r.candle.t, list);
      }
    } else {
      if (trade.entryIdx != null && trade.entryNum != null) {
        const st = styleFor("entry", isShort, th);
        markers.push({ time: candles[trade.entryIdx].t as UTCTimestamp, position: st.position, color: st.color, shape: st.shape, text: chartI18n.t("card.markEntry", { price: fmtPrice(trade.entryNum) }) });
      }
      if (trade.exitIdx != null && trade.exitNum != null) {
        const st = styleFor("exit", isShort, th);
        const r = trade.realizedR != null && trade.risk ? ` ${fmtR(trade.realizedR, 1)}` : "";
        markers.push({ time: candles[trade.exitIdx].t as UTCTimestamp, position: st.position, color: st.color, shape: st.shape, text: `${chartI18n.t("card.markExit", { price: fmtPrice(trade.exitNum) })}${r}` });
      }
    }
    resolvedByTimeRef.current = byTime;
    if (markers.length) {
      markers.sort((a, b) => Number(a.time) - Number(b.time));
      createSeriesMarkers(series, markers);
    }

    const onMove = (param: MouseEventParams) => {
      if (!param.time || !param.point) {
        setTooltip(null);
        setHover(null);
        return;
      }
      const t = Number(param.time);
      setHover(candleByTimeRef.current.get(t) ?? null);
      const rows = resolvedByTimeRef.current.get(t);
      setTooltip(rows && rows.length ? { x: param.point.x, y: param.point.y, rows } : null);
    };
    chart.subscribeCrosshairMove(onMove);
    chart.timeScale().fitContent();

    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      chartRef.current = null;
      setTooltip(null);
      setHover(null);
    };
  }, [candles, trade, levels, isShort, prefs.vwap, prefs.levels, prefs.rLevels, prefs.volume, prefs.adds, themeVersion]);

  // ── Derived display ──────────────────────────────────────────────────────
  const legendCandle = hover ?? candles[candles.length - 1] ?? null;
  const legendPrev = useMemo(() => {
    if (!legendCandle) return null;
    const i = candles.findIndex((c) => c.t === legendCandle.t);
    return i > 0 ? candles[i - 1].c : legendCandle.o;
  }, [legendCandle, candles]);
  const legendChg = legendCandle && legendPrev ? ((legendCandle.c - legendPrev) / legendPrev) * 100 : null;

  const r = trade.risk;
  const exc = trade.excursion;
  // $ per share: always 2 decimals (fmtPrice gave «$0.0000» for a zero excursion); zero carries no sign.
  const inR = (v: number | null | undefined, sign: 1 | -1 = 1) => (v == null ? null : r ? fmtR((sign * v) / r, 1) : fmtUsd(sign * Math.abs(v), { signed: true }));
  const gapPct = levels.open != null && levels.prevClose ? ((levels.open - levels.prevClose) / levels.prevClose) * 100 : null;
  const leftOnTable = exc?.afterExit != null && r ? exc.afterExit / r : null;

  const stats: { label: string; value: ReactNode; tone?: Tone; hint?: ReactNode }[] = [];
  const sideText = isShort ? commonI18n.t("trading.short") : commonI18n.t("trading.long");
  if (trade.effEntry != null) stats.push({ label: trade.openings > 1 ? tc("card.avgEntryN", { count: trade.openings }) : tc("card.entry"), value: fmtPrice(trade.effEntry), hint: sideText });
  if (trade.effExit != null) stats.push({ label: trade.closings > 1 ? tc("card.avgExitN", { count: trade.closings }) : tc("card.exit"), value: fmtPrice(trade.effExit), hint: trade.move != null && trade.effEntry ? fmtPct((trade.move / trade.effEntry) * 100) : undefined });
  if (r != null && trade.effEntry) stats.push({ label: tc("card.riskPerShare"), value: fmtPrice(r, { dollar: true }), hint: tc("card.riskHint", { pct: fmtPct((r / trade.effEntry) * 100, { signed: false }), price: fmtPrice(trade.stopNum) }) });
  if (trade.realizedR != null) {
    const logged = toNum(rMultiple);
    const hint = !r ? tc("card.fromJournal") : logged != null && Math.abs(logged - trade.realizedR) >= 0.1 ? tc("card.inJournal", { r: fmtR(logged, 1) }) : tc("card.byPrices");
    stats.push({ label: tc("card.result"), value: fmtR(trade.realizedR, 1), tone: toneOf(trade.realizedR), hint });
  }
  if (trade.entryAt != null) {
    const entrySession = sessionOfEt(trade.entryAt);
    const exitSession = trade.exitAt != null ? sessionOfEt(trade.exitAt) : null;
    const sessionNote = exitSession && exitSession !== entrySession
      ? `${entrySession ? ET_SESSION_LABEL[entrySession] : ""} → ${ET_SESSION_LABEL[exitSession]}`
      : entrySession ? ET_SESSION_LABEL[entrySession] : undefined;
    // Multi-day: the times carry their dates («12 окт. 15:55:35 ET → 14 окт. 09:41:02 ET»).
    const at = (v: number) => (multiDay ? fmtEtDateTimeSec(v) : `${fmtEtTimeSec(v)} ET`);
    stats.push({
      label: tc("card.hold"),
      value: trade.holdSeconds != null ? fmtDuration(trade.holdSeconds) : tc("card.open"),
      hint: `${multiDay ? at(trade.entryAt) : fmtEtTimeSec(trade.entryAt)}${trade.exitAt != null ? ` → ${multiDay ? at(trade.exitAt) : fmtEtTimeSec(trade.exitAt)}` : ""}${multiDay ? "" : " ET"}${sessionNote ? ` · ${sessionNote}` : ""}`,
    });
  }
  if (exc) {
    const pathHint = trade.timed ? tc("card.pathTimed") : tc("card.pathFull");
    stats.push({ label: tc("card.mfe"), value: inR(exc.mfe, 1), tone: exc.mfe > 0 ? "up" : "neutral", hint: pathHint });
    stats.push({ label: tc("card.mae"), value: inR(exc.mae, -1), tone: exc.mae > 0 ? "down" : "neutral", hint: pathHint });
    if (exc.afterExit != null) {
      stats.push({
        label: tc("card.afterExit"),
        value: inR(exc.afterExit, 1),
        tone: exc.afterExit > 0 ? "warn" : "neutral",
        hint: leftOnTable != null && leftOnTable >= 1 ? tc("card.earlyExit") : tc("card.toEod"),
      });
    }
  }
  if (gapPct != null) stats.push({ label: tc("card.gap"), value: fmtPct(gapPct), tone: toneOf(gapPct), hint: tc("card.gapHint", { price: fmtPrice(levels.prevClose) }) });
  if (levels.pmHigh != null && levels.pmLow != null) stats.push({ label: tc("card.premarket"), value: `${fmtPrice(levels.pmLow)}–${fmtPrice(levels.pmHigh)}`, hint: "PML–PMH" });
  else if (levels.high != null && levels.low != null) stats.push({ label: tc("card.dayRange"), value: `${fmtPrice(levels.low)}–${fmtPrice(levels.high)}` });

  const tfOptions = TIMEFRAMES.map((tf) => {
    const tooFine = (GROUPED[tf] ? 60 : INTERVAL_SEC[tf] ?? 60) < finestSec;
    return { value: tf, label: intervalLabel(tf), disabled: tooFine, title: tooFine ? tc("bars.coarseTitle") : undefined };
  });
  const ctxOptions = [0, 1, 2, 3, 5].map((n) => ({ value: String(n), label: n === 0 ? tc("card.ctxDay") : tc("card.ctxPlus", { n }) }));
  const kindsPresent = Array.from(new Set(allExecutions.map((e) => e.kind))).filter((k) => prefs.adds || k !== "add");

  return (
    <section className={cn("glass-panel overflow-hidden rounded-2xl", className)} aria-label={tc("card.aria", { ticker, date: multiDay ? `${dateKey} → ${lastKey}` : dateKey })}>
      {/* Header */}
      <div className="flex flex-col gap-3 px-4 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <CandlestickChart className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-foreground">{ticker}</h3>
            <span className="text-xs tabular-nums text-muted-foreground">{multiDay ? `${dateKey} → ${lastKey}` : dateKey}</span>
            <Pill tone={isShort ? "down" : "up"}>{sideText}</Pill>
            {multiDay && <Pill tone="accent" title={tc("card.spanTitle", { from: dateKey, to: lastKey })}>{tc("card.span", { count: tradeDays })}</Pill>}
            {finestSec > 60 && finestSec < 86400 ? (
              <Pill tone="warn" title={tc("bars.coarseTitle")}>{tc("bars.coarse", { tf: finestLabel })}</Pill>
            ) : data?.interval && data.interval !== apiInterval && (
              <Pill tone="warn">{tc("card.tfPill", { tf: intervalLabel(data.interval) })}</Pill>
            )}
            {allExecutions.length > 0 && <Pill tone="accent">{tc("card.fills", { count: allExecutions.length })}</Pill>}
            {isFetching && !isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-label={tc("card.refreshing")} />}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => chartRef.current?.timeScale().fitContent()}
              aria-label={multiDay ? tc("card.fitDays") : tc("card.fitDay")}
              title={multiDay ? tc("card.fitDays") : tc("card.fitDay")}
              className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--glass-hover-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Maximize2 className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => updatePrefs({ tall: !prefs.tall })}
              aria-pressed={prefs.tall}
              aria-label={prefs.tall ? tc("card.shorter") : tc("card.taller")}
              title={prefs.tall ? tc("card.shorterTitle") : tc("card.tallerTitle")}
              className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--glass-hover-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:text-primary"
            >
              <ChevronsUpDown className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Segmented size="sm" ariaLabel={tc("card.tfAria")} options={tfOptions} value={interval} onChange={(v) => setIntervalState(v)} />
          <Segmented
            size="sm"
            ariaLabel={tc("card.ctxAria")}
            options={ctxOptions}
            value={String(prefs.daysBack)}
            onChange={(v) => updatePrefs({ daysBack: Number(v) })}
          />
        </div>
        <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-0.5" role="group" aria-label={tc("card.layersAria")}>
          <FilterChip active={prefs.vwap} onClick={() => updatePrefs({ vwap: !prefs.vwap })} className="min-h-7 shrink-0 px-2.5 text-xs">
            <span className="h-0.5 w-3 rounded-full bg-[hsl(var(--chart-5))]" aria-hidden="true" /> VWAP
          </FilterChip>
          <FilterChip active={prefs.levels} onClick={() => updatePrefs({ levels: !prefs.levels })} className="min-h-7 shrink-0 px-2.5 text-xs">{tc("card.levels")}</FilterChip>
          <FilterChip active={prefs.rLevels} onClick={() => updatePrefs({ rLevels: !prefs.rLevels })} className="min-h-7 shrink-0 px-2.5 text-xs">{tc("card.rLevels")}</FilterChip>
          <FilterChip active={prefs.volume} onClick={() => updatePrefs({ volume: !prefs.volume })} className="min-h-7 shrink-0 px-2.5 text-xs">{tc("card.volume")}</FilterChip>
          <span className="shrink-0" title={needExtended ? tc("card.extendedForced") : undefined}>
            <FilterChip active={extended} onClick={() => updatePrefs({ extended: !prefs.extended })} className="min-h-7 shrink-0 px-2.5 text-xs">{tc("card.extended")}</FilterChip>
          </span>
          {addCount > 0 && (
            <FilterChip active={prefs.adds} onClick={() => updatePrefs({ adds: !prefs.adds })} count={addCount} className="min-h-7 shrink-0 px-2.5 text-xs">{tc("card.adds")}</FilterChip>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="px-2 pb-2 pt-2 sm:px-3">
        {isLoading ? (
          <div className="relative" style={{ height: chartHeight }} aria-busy="true" aria-label={tc("card.loadingAria")}>
            <Skeleton className="h-full w-full rounded-xl" />
            <span className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">{tc("card.loading")}</span>
          </div>
        ) : error && !data ? (
          (() => {
            const info = errorInfo(error as Error & { reason?: string; status?: number }, dateKey);
            const Icon = info.icon;
            return (
              <div className="flex min-h-[140px] flex-col items-center justify-center gap-3 px-4 py-6 text-center">
                <span className="grid h-10 w-10 place-items-center rounded-full bg-[hsl(var(--chart-3)/0.15)] text-[hsl(var(--chart-3))]">
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <p className="max-w-sm text-sm text-muted-foreground">{info.text}</p>
                {info.retry && (
                  <button
                    type="button"
                    onClick={() => candlesQuery.refetch()}
                    disabled={isFetching}
                    className="chip inline-flex min-h-8 items-center gap-1.5 px-3 text-sm font-medium disabled:opacity-50"
                  >
                    <RotateCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} aria-hidden="true" /> {commonI18n.t("actions.retry")}
                  </button>
                )}
              </div>
            );
          })()
        ) : !candles.length ? (
          <div className="flex min-h-[120px] items-center justify-center gap-2 px-4 text-sm text-muted-foreground">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" /> {tc("card.noCandles")}
          </div>
        ) : (
          <div ref={wrapperRef} className="relative">
            <div ref={containerRef} className="isolate w-full" style={{ height: chartHeight }} />

            {/* OHLC legend */}
            {legendCandle && (
              <div className="pointer-events-none absolute left-2 top-1 z-raised flex max-w-[calc(100%-5rem)] flex-wrap items-center gap-x-2.5 gap-y-0.5 rounded-lg px-1.5 py-1 text-2xs tabular-nums text-muted-foreground">
                <span className="text-foreground/90">{fmtEtDateTime(new Date(legendCandle.t * 1000))}</span>
                <span>O <span className="text-foreground">{fmtPrice(legendCandle.o)}</span></span>
                <span>H <span className="text-foreground">{fmtPrice(legendCandle.h)}</span></span>
                <span>L <span className="text-foreground">{fmtPrice(legendCandle.l)}</span></span>
                <span>C <span className="text-foreground">{fmtPrice(legendCandle.c)}</span></span>
                {legendChg != null && (
                  <span className={toneText(toneOf(legendChg))}>{fmtPct(legendChg)}</span>
                )}
                {prefs.volume && <span>V <span className="text-foreground">{fmtCompact(legendCandle.v)}</span></span>}
              </div>
            )}

            {/* Execution tooltip */}
            {tooltip && containerSize && (() => {
              const W = 224;
              const H = Math.min(200, 32 + tooltip.rows.length * 56);
              let left = tooltip.x + 14;
              let top = tooltip.y + 14;
              if (left + W > containerSize.width) left = tooltip.x - W - 14;
              if (top + H > containerSize.height) top = Math.max(4, tooltip.y - H - 14);
              left = Math.max(4, left);
              top = Math.max(4, top);
              return (
                <div className="glass-thick pointer-events-none absolute z-raised overflow-hidden rounded-xl" style={{ left, top, width: W }}>
                  {tooltip.rows.map((row, i) => (
                    <div key={row.exec.id} className={cn("px-3 py-2 text-xs", i > 0 && "border-t border-[var(--glass-border)]")}>
                      <div className="flex items-center gap-1.5">
                        <span className={cn("h-2 w-2 rounded-full", KIND_DOT[row.exec.kind])} aria-hidden="true" />
                        <span className="font-semibold text-foreground">{execLabel(row.exec)}</span>
                        <span className="tabular-nums text-foreground">{fmtPrice(row.price, { dollar: true })}</span>
                        {row.exec.qty && <span className="tabular-nums text-muted-foreground">× {fmtCount(Number(row.exec.qty))}</span>}
                      </div>
                      <div className="mt-0.5 text-2xs tabular-nums text-muted-foreground">
                        {row.at != null ? fmtEtDateTimeSec(row.at) : fmtEtDateTime(new Date(row.candle.t * 1000))}
                        {row.at == null && ` · ${tc("card.byPrice")}`}
                        {row.at != null && (() => { const s = sessionOfEt(row.at); return s && s !== "regular" ? ` · ${ET_SESSION_LABEL[s]}` : ""; })()}
                        {row.exec.qty && <> · {fmtUsd(row.price * Number(row.exec.qty), { decimals: 0 })}</>}
                      </div>
                      {r && trade.effEntry != null && (row.exec.kind === "exit" || row.exec.kind === "trim" || row.exec.kind === "stop") && (
                        <div className={cn("text-2xs font-medium tabular-nums", toneText(toneOf(isShort ? trade.effEntry - row.price : row.price - trade.effEntry)))}>
                          {fmtR((isShort ? trade.effEntry - row.price : row.price - trade.effEntry) / r, 2)}
                        </div>
                      )}
                      {row.exec.note && <div className="mt-0.5 truncate text-2xs italic text-foreground/80" title={row.exec.note}>{row.exec.note}</div>}
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        )}
      </div>

      {/* Footer: trade stats + legend */}
      {candles.length > 0 && (stats.length > 0 || kindsPresent.length > 0) && (
        <div className="space-y-2 border-t border-[var(--glass-border)] px-4 py-3">
          {stats.length > 0 && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-8">
              {stats.map((s) => <MiniStat key={s.label} {...s} />)}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
            {kindsPresent.map((k) => (
              <span key={k} className="inline-flex items-center gap-1">
                <span className={cn("h-2 w-2 rounded-full", KIND_DOT[k])} aria-hidden="true" /> {KIND_LABEL(k)}
              </span>
            ))}
            {!prefs.adds && addCount > 0 && <span>{tc("card.addsHidden", { count: addCount })}</span>}
            {allExecutions.length === 0 && (trade.entryNum != null || trade.exitNum != null) && (
              <span>{tc("card.byPriceNote")}</span>
            )}
            {exc && (() => {
              const tf = intervalLabel(GROUPED[interval] && data?.interval === "1m" ? interval : data?.interval ?? interval);
              return <span>{trade.timed ? tc("card.excursionBarsTimed", { tf }) : tc("card.excursionBars", { tf })}</span>;
            })()}
            {extended && <span>{tc("card.shading")}{needExtended && !prefs.extended ? ` · ${tc("card.shadingAuto")}` : ""}</span>}
          </div>
        </div>
      )}
    </section>
  );
}
