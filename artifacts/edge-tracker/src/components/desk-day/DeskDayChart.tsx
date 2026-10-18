/**
 * «Деск на тикере» chart: the archived ticker-day (candles + volume, pre / after-hours shaded) with every desk trader's
 * legs drawn by DeskFillsPrimitive. Built on the shared chart engine (theme, time axis, session shading, canvas helpers).
 * Clicking a marker focuses that trader (same as clicking their legend row).
 */
import * as React from "react";
import { createChart, CandlestickSeries, HistogramSeries, CrosshairMode, type IChartApi, type ISeriesApi, type MouseEventParams, type Time, type UTCTimestamp } from "lightweight-charts";
import type { Candle, Timeframe } from "@/components/chart-engine/types";
import { TF_LABEL } from "@/components/chart-engine/types";
import { readChartTheme } from "@/components/chart-engine/theme";
import { aggregate } from "@/components/chart-engine/lib/aggregate";
import { fmtEtDateTime, fmtEtTime, isoToEpoch, tickMarkLabel } from "@/components/chart-engine/lib/time";
import { capVolumes } from "@/components/chart-engine/lib/view";
import { ROLE_LABEL } from "@/components/chart-engine/lib/structure";
import { useThemeVersion } from "@/components/chart-engine/hooks/useThemeVersion";
import { SessionShadingPrimitive } from "@/components/chart-engine/primitives/SessionShadingPrimitive";
import { cn } from "@/lib/utils";
import { fmtCount, fmtPrice, fmtR, localeTag } from "@/lib/format";
import { personName } from "@/i18n";
import { deskDayI18n } from "@/i18n/ns/deskDay";
import type { DeskDay, DeskLeg, DeskTrade } from "./api";
import { DeskFillsPrimitive, type DeskMarker } from "./DeskFillsPrimitive";
import { buildMarkers, initialWindow } from "./model";
import { resultLabel } from "./labels";

type Props = {
  day: DeskDay;
  bars: readonly Candle[];
  baseSec: number;
  colors: ReadonlyMap<string, string>;
  focus: readonly string[];
  onToggle: (name: string) => void;
  className?: string;
};

type Refs = { chart: IChartApi; candles: ISeriesApi<"Candlestick">; volume: ISeriesApi<"Histogram">; fills: DeskFillsPrimitive; session: SessionShadingPrimitive };

/** Tooltip lines of one marker (translated; $ / size only when the API sent them). */
function describe(m: DeskMarker, trade: DeskTrade | undefined, leg: DeskLeg | undefined): string[] {
  const t = deskDayI18n.t;
  const lines = [`${personName(m.trader)} · ${ROLE_LABEL[m.role]}${m.inferred ? "?" : ""}`];
  const at = leg?.at ? isoToEpoch(leg.at) : NaN;
  lines.push(`${fmtPrice(m.price)}${Number.isFinite(at) ? ` · ${fmtEtTime(at, true)} ET` : ""}`);
  const extra: string[] = [];
  if (leg?.qty != null) extra.push(t("tip.qty", { qty: fmtCount(leg.qty) }));
  if (leg && leg.pieces > 1) extra.push(t("tip.pieces", { count: leg.pieces }));
  if (leg?.perShare != null) extra.push(t("tip.move", { move: `${leg.perShare > 0 ? "+" : leg.perShare < 0 ? "−" : ""}${fmtPrice(Math.abs(leg.perShare))}` }));
  if (leg?.r != null) extra.push(fmtR(leg.r));
  if (extra.length) lines.push(extra.join(" · "));
  if (trade && leg && !leg.opening && trade.r != null && (m.role === "exit" || m.role === "stop" || m.role === "flip")) lines.push(`${resultLabel(trade.result)} · ${fmtR(trade.r)}`);
  return lines;
}

export function DeskDayChart({ day, bars: baseBars, baseSec, colors, focus, onToggle, className }: Props) {
  const { t } = deskDayI18n.useT();
  const themeVersion = useThemeVersion();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const refs = React.useRef<Refs | null>(null);
  const tfs: Timeframe[] = baseSec <= 60 ? ["1m", "5m"] : [];
  const [tf, setTf] = React.useState<Timeframe>("1m");
  const bars = React.useMemo<Candle[]>(() => (baseSec <= 60 && tf === "5m" ? aggregate(baseBars, baseSec, "5m") : [...baseBars]), [baseBars, baseSec, tf]);
  const barSec = baseSec <= 60 && tf === "5m" ? 300 : baseSec;
  const markers = React.useMemo(() => buildMarkers(day, bars, barSec, colors), [day, bars, barSec, colors]);
  const legOf = React.useMemo(() => {
    const m = new Map<string, { trade: DeskTrade; leg: DeskLeg }>();
    for (const tr of day.trades) tr.legs.forEach((leg, i) => m.set(`${tr.id}:${i}`, { trade: tr, leg }));
    return m;
  }, [day.trades]);
  const toggleRef = React.useRef(onToggle);
  toggleRef.current = onToggle;
  const markersRef = React.useRef(markers);
  markersRef.current = markers;
  /** View key the first range was set for; null after a rebuild so the new chart gets it too. */
  const lastView = React.useRef<string | null>(null);

  // ── build (bars / theme) ──
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el || !bars.length) return;
    const theme = readChartTheme();
    // Explicit size (not autoSize): the first view range is set right after the build and needs a real width.
    const chart = createChart(el, {
      width: el.clientWidth || 320, height: el.clientHeight || 340,
      layout: { background: { color: "transparent" }, textColor: theme.muted(), fontFamily: theme.font, fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: theme.border(theme.dark ? 0.22 : 0.35) }, horzLines: { color: theme.border(theme.dark ? 0.22 : 0.35) } },
      timeScale: {
        timeVisible: true, secondsVisible: false, borderColor: theme.border(), rightOffset: 4, barSpacing: 8, minBarSpacing: 0.5,
        tickMarkFormatter: (time: Time, type: number) => (typeof time === "number" ? tickMarkLabel(time, type) : ""),
      },
      localization: { locale: localeTag(), timeFormatter: (time: Time) => (typeof time === "number" ? fmtEtDateTime(time) : String(time)), priceFormatter: (p: number) => fmtPrice(p) },
      rightPriceScale: { borderColor: theme.border(), scaleMargins: { top: 0.08, bottom: 0.18 } },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: theme.muted(0.45), labelBackgroundColor: theme.labelBg, width: 1, style: 3 },
        horzLine: { color: theme.muted(0.45), labelBackgroundColor: theme.labelBg, width: 1, style: 3 },
      },
      handleScale: { axisPressedMouseMove: true, axisDoubleClickReset: true, mouseWheel: true, pinch: true },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: theme.up(), downColor: theme.down(), borderUpColor: theme.up(), borderDownColor: theme.down(), wickUpColor: theme.up(0.9), wickDownColor: theme.down(0.9),
      priceLineVisible: false, lastValueVisible: false,
    });
    candles.setData(bars.map((b) => ({ time: b.t as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c })));
    const volume = chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    const capped = capVolumes(bars.map((b) => b.v)).values;
    volume.setData(bars.map((b, i) => ({ time: b.t as UTCTimestamp, value: capped[i], color: b.c >= b.o ? theme.up(0.3) : theme.down(0.3) })));
    const session = new SessionShadingPrimitive(theme);
    chart.panes()[0]?.attachPrimitive(session);
    session.setBars(bars, true);
    const fills = new DeskFillsPrimitive(theme, { zOrder: "top" });
    candles.attachPrimitive(fills);
    const onClick = (param: MouseEventParams<Time>) => {
      const id = typeof param.hoveredObjectId === "string" && param.hoveredObjectId.startsWith("leg:") ? param.hoveredObjectId.slice(4) : null;
      const m = id ? markersRef.current.find((x) => x.key === id) : null;
      if (m) toggleRef.current(m.trader);
    };
    chart.subscribeClick(onClick);
    const ro = new ResizeObserver(() => { if (el.clientWidth && el.clientHeight) chart.resize(el.clientWidth, el.clientHeight); });
    ro.observe(el);
    refs.current = { chart, candles, volume, fills, session };
    lastView.current = null;
    return () => {
      ro.disconnect();
      chart.unsubscribeClick(onClick);
      refs.current = null;
      chart.remove();
    };
  }, [bars, themeVersion]);

  // ── markers + first view ──
  const viewKey = `${day.ticker}|${day.date}|${tf}`;
  React.useEffect(() => {
    const r = refs.current;
    if (!r) return;
    r.fills.setMarkers(markers, (m) => { const x = legOf.get(m.key); return describe(m, x?.trade, x?.leg); });
    if (lastView.current !== viewKey) {
      lastView.current = viewKey;
      const w = initialWindow(markers, bars.length, tf === "5m" ? 8 : 20);
      r.chart.timeScale().setVisibleLogicalRange({ from: w.from, to: w.to + 2 });
    }
  }, [markers, legOf, viewKey, bars.length, tf, themeVersion]);

  React.useEffect(() => { refs.current?.fills.setFocus(focus); }, [focus, markers, themeVersion]);

  return (
    <div className={cn("relative", className)}>
      {tfs.length > 1 && (
        <div className="absolute right-2 top-2 z-raised flex gap-1 rounded-full border border-[var(--glass-border)] bg-background/90 p-0.5" role="group" aria-label={t("tf")}>
          {tfs.map((x) => (
            <button
              key={x}
              type="button"
              aria-pressed={tf === x}
              onClick={() => setTf(x)}
              className={cn("rounded-full px-2.5 py-0.5 text-xs tabular-nums", tf === x ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              {TF_LABEL[x]}
            </button>
          ))}
        </div>
      )}
      <div ref={containerRef} className="h-[340px] w-full sm:h-[460px]" role="img" aria-label={t("chartAria", { ticker: day.ticker, date: day.date })} />
    </div>
  );
}
