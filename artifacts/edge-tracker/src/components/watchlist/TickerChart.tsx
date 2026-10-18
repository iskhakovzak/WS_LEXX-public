import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  createChart, CandlestickSeries, HistogramSeries, LineSeries, LineStyle,
  type IChartApi, type UTCTimestamp, type Time,
} from "lightweight-charts";
import { cn } from "@/lib/utils";
import { Segmented } from "@/components/ds";
import { http } from "@/lib/api/http";
import { addDays } from "@/lib/trading-date";
import type { Candle } from "@/components/chart-engine/types";
import { readChartTheme } from "@/components/chart-engine/theme";
import { useThemeVersion } from "@/components/chart-engine/hooks/useThemeVersion";
import { sessionVwap } from "@/components/chart-engine/lib/vwap";
import { tickMarkLabel, fmtEtDateTime, fmtEtDay } from "@/components/chart-engine/lib/time";
import { fetchSessionBars, levelsFromBars, sessionDays, type DayLevelSet } from "./use-market";
import { num } from "./lib";
import { fmtPrice } from "@/lib/format";
import { watchlistI18n } from "@/i18n/ns/watchlist";

type Tf = "5m" | "1m" | "D";
const TF_IDS: readonly Tf[] = ["5m", "1m", "D"];
const tfLabel = (tf: Tf) => watchlistI18n.t(tf === "5m" ? "chart.tf5m" : tf === "1m" ? "chart.tf1m" : "chart.tfD");

type ChartPayload = { bars: Candle[]; levels: DayLevelSet | null };

async function loadBars(ticker: string, tf: Tf): Promise<ChartPayload> {
  const days = sessionDays();
  if (tf === "D") {
    const from = addDays(days.lastSession, -180);
    const j = await http
      .get<{ candles?: Candle[] }>(`/api/candles/${encodeURIComponent(ticker)}/range?from=${from}&to=${days.lastSession}&interval=1d`)
      .catch(() => null);
    if (!j) return { bars: [], levels: null };
    return { bars: Array.isArray(j.candles) ? j.candles : [], levels: null };
  }
  // Intraday: the session + the previous one (levels need yesterday), pre/post market included.
  const j = await fetchSessionBars(ticker, days, tf, 1);
  const bars = Array.isArray(j.candles) ? j.candles : [];
  return { bars, levels: bars.length ? levelsFromBars(bars, j.prevClose ?? null, days) : null };
}

/**
 * Compact price chart for the ticker card: candles + volume, session VWAP and the key levels
 * (PDH / PDL / PMH / PML, the card's stop and target) as price lines. Built on lightweight-charts
 * with the chart-engine helpers (theme, VWAP, ET time) — chart-engine itself is untouched.
 */
export function TickerChart({
  ticker, stop, target, height = 280, className,
}: { ticker: string; stop?: string | number | null; target?: string | number | null; height?: number; className?: string }) {
  const { t } = watchlistI18n.useT();
  const [tf, setTf] = React.useState<Tf>("5m");
  const days = sessionDays();
  const q = useQuery<ChartPayload>({
    queryKey: ["watchlist-chart", ticker, tf, days.lastSession],
    queryFn: () => loadBars(ticker, tf),
    staleTime: tf === "D" ? 30 * 60_000 : 2 * 60_000,
    gcTime: 10 * 60_000,
    retry: 0,
  });

  const wrapRef = React.useRef<HTMLDivElement>(null);
  const themeV = useThemeVersion();
  const [hover, setHover] = React.useState<Candle | null>(null);
  const bars = q.data?.bars ?? [];
  const levels = q.data?.levels ?? null;
  const stopN = num(stop as string | null | undefined);
  const targetN = num(target as string | null | undefined);

  React.useEffect(() => {
    const el = wrapRef.current;
    if (!el || !bars.length) return;
    const th = readChartTheme();
    const intraday = tf !== "D";
    const chart: IChartApi = createChart(el, {
      width: el.clientWidth,
      height,
      layout: { background: { color: "transparent" }, textColor: th.muted(), fontSize: 11, fontFamily: th.font, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: th.border(0.35) } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.2 } },
      timeScale: {
        borderVisible: false, timeVisible: intraday, secondsVisible: false, rightOffset: 4,
        tickMarkFormatter: (t: Time, type: number) => tickMarkLabel(Number(t), type),
      },
      localization: {
        priceFormatter: (p: number) => fmtPrice(p),
        timeFormatter: (t: Time) => (intraday ? fmtEtDateTime(Number(t)) : fmtEtDay(Number(t))),
      },
      crosshair: {
        mode: 1,
        vertLine: { color: th.muted(0.5), labelBackgroundColor: th.labelBg },
        horzLine: { color: th.muted(0.5), labelBackgroundColor: th.labelBg },
      },
      // Inside a scrolling sheet the wheel must scroll the sheet: pan by drag, zoom by axis drag / pinch.
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true },
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: th.up(), downColor: th.down(), borderUpColor: th.up(), borderDownColor: th.down(), wickUpColor: th.up(0.8), wickDownColor: th.down(0.8),
      priceLineVisible: false,
    });
    candles.setData(bars.map((b) => ({ time: b.t as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c })));

    const vol = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    vol.setData(bars.map((b) => ({ time: b.t as UTCTimestamp, value: b.v, color: b.c >= b.o ? th.up(0.3) : th.down(0.3) })));

    if (intraday) {
      const vw = sessionVwap(bars);
      if (vw.length > 1) {
        const line = chart.addSeries(LineSeries, { color: th.c3(0.9), lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        line.setData(vw.map((p) => ({ time: p.t as UTCTimestamp, value: p.vwap })));
      }
    }

    const addLine = (price: number | null | undefined, title: string, color: string, style: LineStyle = LineStyle.Dashed) => {
      if (price == null || !(price > 0)) return;
      candles.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title });
    };
    if (intraday && levels) {
      addLine(levels.pdh, "PDH", th.muted(0.9));
      addLine(levels.pdl, "PDL", th.muted(0.9));
      addLine(levels.pmh, "PMH", th.c1(0.7), LineStyle.Dotted);
      addLine(levels.pml, "PML", th.c1(0.7), LineStyle.Dotted);
    }
    addLine(stopN, watchlistI18n.t("level.stop"), th.down(0.85), LineStyle.Solid);
    addLine(targetN, watchlistI18n.t("level.target"), th.up(0.85), LineStyle.Solid);

    // Intraday: show the current session (last ~ 130 bars of 5m / 240 of 1m); daily: last ~ 90 sessions.
    const visible = tf === "5m" ? 130 : tf === "1m" ? 240 : 90;
    if (bars.length > visible) chart.timeScale().setVisibleLogicalRange({ from: bars.length - visible, to: bars.length + 2 });
    else chart.timeScale().fitContent();

    const byTime = new Map(bars.map((b) => [b.t, b]));
    chart.subscribeCrosshairMove((p) => setHover(p.time != null ? byTime.get(Number(p.time)) ?? null : null));

    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth })) : null;
    ro?.observe(el);
    return () => { ro?.disconnect(); chart.remove(); };
  }, [bars, levels, tf, height, themeV, stopN, targetN]);

  const last = hover ?? bars[bars.length - 1] ?? null;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented ariaLabel={t("chart.tfAria")} size="sm" value={tf} onChange={setTf} options={TF_IDS.map((v) => ({ value: v, label: tfLabel(v) }))} />
        {last && (
          <span className="text-xs tabular-nums text-muted-foreground" aria-live="off">
            O <span className="text-foreground">{fmtPrice(last.o)}</span> · H <span className="text-foreground">{fmtPrice(last.h)}</span> · L <span className="text-foreground">{fmtPrice(last.l)}</span> · C <span className="text-foreground">{fmtPrice(last.c)}</span>
          </span>
        )}
        {tf !== "D" && <span className="ml-auto text-xs text-muted-foreground">{t("chart.legend")}</span>}
      </div>
      <div className="relative" style={{ height }}>
        <div ref={wrapRef} className="absolute inset-0" role="img" aria-label={t("chart.aria", { ticker, tf: tf === "D" ? t("chart.daily") : tf })} />
        {q.isLoading && <div className="absolute inset-0 animate-pulse rounded-xl bg-[var(--glass-bg)] motion-reduce:animate-none" aria-label={t("chart.loading")} />}
        {!q.isLoading && !bars.length && (
          <div className="absolute inset-0 grid place-items-center rounded-xl border border-dashed border-[var(--glass-border)] text-sm text-muted-foreground">
            {q.isError ? t("chart.unavailable") : t("chart.noBars")}
          </div>
        )}
      </div>
    </div>
  );
}
