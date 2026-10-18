/**
 * «Деск на тикере» chart: the archived ticker-day (candles + volume, pre / after-hours shaded) with every desk trader's
 * legs drawn by DeskFillsPrimitive. Built on the shared chart engine (theme, time axis, session shading, canvas helpers).
 * Clicking a marker focuses that trader (same as clicking their legend row).
 * «Позиция офиса» (toggle): a pane under the price with the desk's net position in % of the day's peak (+ above zero,
 * − below), dashed price lines at the office's average entry / exit and shaded main-position / exit zones.
 */
import * as React from "react";
import {
  createChart, BaselineSeries, CandlestickSeries, HistogramSeries, CrosshairMode, LineStyle,
  type IChartApi, type IPriceLine, type ISeriesApi, type MouseEventParams, type Time, type UTCTimestamp,
} from "lightweight-charts";
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
import { deskDayI18n } from "@/i18n/ns/deskDay";
import type { DeskDay, DeskLeg, DeskOffice, DeskTrade } from "./api";
import { DeskFillsPrimitive, type DeskMarker } from "./DeskFillsPrimitive";
import { OfficeZonesPrimitive, type OfficeZoneBox } from "./OfficeZonesPrimitive";
import { buildMarkers, initialWindow, samplePath, windowBars } from "./model";
import { resultLabel, traderLabel } from "./labels";

type Props = {
  day: DeskDay;
  bars: readonly Candle[];
  baseSec: number;
  colors: ReadonlyMap<string, string>;
  focus: readonly string[];
  onToggle: (name: string) => void;
  /** The office position layer is on (the toggle lives on the chart; the state in the page). */
  showOffice: boolean;
  onShowOffice: (on: boolean) => void;
  className?: string;
};

type Refs = {
  chart: IChartApi; candles: ISeriesApi<"Candlestick">; volume: ISeriesApi<"Histogram">; fills: DeskFillsPrimitive; session: SessionShadingPrimitive;
  zones: OfficeZonesPrimitive; pos: ISeriesApi<"Baseline"> | null; lines: IPriceLine[];
};

/** Tooltip lines of one marker (translated; $ / size only when the API sent them). */
function describe(day: DeskDay, m: DeskMarker, trade: DeskTrade | undefined, leg: DeskLeg | undefined): string[] {
  const t = deskDayI18n.t;
  const lines = [`${traderLabel(day, m.trader)} · ${ROLE_LABEL[m.role]}${m.inferred ? "?" : ""}`];
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

/** Pushes the office layer onto a built chart: position pane, average entry / exit lines, zones. */
function drawOffice(r: Refs, office: DeskOffice | null, on: boolean, bars: readonly Candle[], barSec: number): void {
  const t = deskDayI18n.t;
  const theme = readChartTheme();
  if (r.pos) { r.chart.removeSeries(r.pos); r.pos = null; }
  for (const l of r.lines) r.candles.removePriceLine(l);
  r.lines = [];
  r.zones.setZones([]);
  if (!office || !on) return;
  const vals = samplePath(office, bars, barSec);
  const pos = r.chart.addSeries(BaselineSeries, {
    baseValue: { type: "price", price: 0 },
    topLineColor: theme.up(1), topFillColor1: theme.up(0.32), topFillColor2: theme.up(0.04),
    bottomLineColor: theme.down(1), bottomFillColor1: theme.down(0.04), bottomFillColor2: theme.down(0.32),
    lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: true,
    priceFormat: { type: "custom", formatter: (p: number) => `${Math.round(p)}%`, minMove: 1 },
    title: t("office.toggle"),
  }, 1);
  pos.setData(bars.map((b, i) => ({ time: b.t as UTCTimestamp, value: vals[i] })));
  // Narrow screens: the price keeps most of the height, the pane stays a strip.
  const narrow = typeof window !== "undefined" && window.matchMedia?.("(max-width: 639px)").matches;
  pos.getPane().setStretchFactor(1);
  r.chart.panes()[0]?.setStretchFactor(narrow ? 4 : 3);
  r.pos = pos;
  // Narrow screens: no line titles (they cover the candles); the axis labels keep the prices, the summary line says which.
  const line = (price: number | null, title: string, color: string) => {
    if (price != null) r.lines.push(r.candles.createPriceLine({ price, color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: narrow ? "" : title }));
  };
  line(office.avgEntry, t("office.avgEntry"), theme.primary(0.95));
  line(office.avgExit, t("office.avgExit"), theme.muted(0.95));
  const zones: OfficeZoneBox[] = [];
  for (const [kind, z] of [["build", office.build], ["exit", office.exit]] as const) {
    const w = z ? windowBars(bars, barSec, z.from, z.to) : null;
    if (z && w) zones.push({ kind, from: w.from, to: w.to, low: z.low, high: z.high, text: t(kind === "build" ? "office.zoneBuild" : "office.zoneExit") });
  }
  r.zones.setZones(zones);
}

export function DeskDayChart({ day, bars: baseBars, baseSec, colors, focus, onToggle, showOffice, onShowOffice, className }: Props) {
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
      localization: { locale: localeTag(), timeFormatter: (time: Time) => (typeof time === "number" ? fmtEtDateTime(time) : String(time)) },
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
      // Per series (not chart-wide localization): the office pane formats its own scale in %.
      priceFormat: { type: "custom", formatter: (p: number) => fmtPrice(p), minMove: 0.01 },
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
    const zones = new OfficeZonesPrimitive(theme);
    candles.attachPrimitive(zones);
    const onClick = (param: MouseEventParams<Time>) => {
      const id = typeof param.hoveredObjectId === "string" && param.hoveredObjectId.startsWith("leg:") ? param.hoveredObjectId.slice(4) : null;
      const m = id ? markersRef.current.find((x) => x.key === id) : null;
      if (m) toggleRef.current(m.trader);
    };
    chart.subscribeClick(onClick);
    const ro = new ResizeObserver(() => { if (el.clientWidth && el.clientHeight) chart.resize(el.clientWidth, el.clientHeight); });
    ro.observe(el);
    refs.current = { chart, candles, volume, fills, session, zones, pos: null, lines: [] };
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
    r.fills.setMarkers(markers, (m) => { const x = legOf.get(m.key); return describe(day, m, x?.trade, x?.leg); });
    if (lastView.current !== viewKey) {
      lastView.current = viewKey;
      const w = initialWindow(markers, bars.length, tf === "5m" ? 8 : 20);
      r.chart.timeScale().setVisibleLogicalRange({ from: w.from, to: w.to + 2 });
    }
  }, [day, markers, legOf, viewKey, bars.length, tf, themeVersion]);

  // ── office layer (after the build: a rebuilt chart starts without it) ──
  React.useEffect(() => {
    const r = refs.current;
    if (r) drawOffice(r, day.office, showOffice, bars, barSec);
  }, [day.office, showOffice, bars, barSec, themeVersion, t]);

  React.useEffect(() => { refs.current?.fills.setFocus(focus); }, [focus, markers, themeVersion]);

  const officeOn = showOffice && !!day.office;
  return (
    <div className={cn("relative", className)}>
      <div className="absolute right-2 top-2 z-raised flex items-center gap-1.5">
      {day.office && (
        <button
          type="button"
          aria-pressed={showOffice}
          aria-label={t("office.toggleAria")}
          onClick={() => onShowOffice(!showOffice)}
          className={cn(
            "rounded-full border border-[var(--glass-border)] px-2.5 py-1 text-xs",
            showOffice ? "bg-primary text-primary-foreground" : "bg-background/90 text-muted-foreground hover:text-foreground",
          )}
        >
          {t("office.toggle")}
        </button>
      )}
      {tfs.length > 1 && (
        <div className="flex gap-1 rounded-full border border-[var(--glass-border)] bg-background/90 p-0.5" role="group" aria-label={t("tf")}>
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
      </div>
      <div
        ref={containerRef}
        className={cn("w-full", officeOn ? "h-[400px] sm:h-[540px]" : "h-[340px] sm:h-[460px]")}
        role="img"
        aria-label={t("chartAria", { ticker: day.ticker, date: day.date })}
      />
    </div>
  );
}
