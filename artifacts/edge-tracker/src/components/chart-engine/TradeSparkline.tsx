/**
 * <TradeSparkline/> — a tiny canvas price path of a trade with entry/exit dots, for trade lists.
 * Lazy: data is fetched only once the element is near the viewport (IntersectionObserver), results are
 * cached in memory per trade, so scrolling a list back and forth does not refetch.
 * Reads only: GET /api/trades/:id, GET /api/candles/:ticker/range (shared per URL), GET /api/trade-executions/batch
 * (fill times of all rows in one request; falls back to GET /api/trades/:id/executions).
 */
import * as React from "react";
import { chartI18n } from "@/i18n/ns/chart";
import { http } from "@/lib/api/http";
import { isNotFound } from "@/lib/api/errors";
import { cn } from "@/lib/utils";
import type { Candle, Execution, SparkData, TradeLike } from "./types";
import { buildSparkData } from "./lib/sparkline";
import { isoToEpoch } from "./lib/time";
import { isOpening, sideOf, toNum } from "./lib/position";
import { readChartTheme } from "./theme";
import { tradeWindow } from "./hooks/useChartData";

export type TradeSparklineProps = {
  /** Fetch everything by trade id (GET /api/trades/:id). */
  tradeId?: number;
  /** Or pass the trade (saves one request). */
  trade?: TradeLike;
  /** Or pass ready data (no requests at all). */
  data?: SparkData | null;
  width?: number;
  height?: number;
  /** Colour by P&L sign (default) or always neutral. */
  tone?: "pnl" | "neutral";
  className?: string;
  title?: string;
  /** "trade" (default): the trade with ~2 h around it; "day": the whole trading day 4:00–20:00 ET, the trade highlighted. */
  span?: "trade" | "day";
};

const cache = new Map<string, Promise<SparkData | null>>();
const MAX_CACHE = 400;

/** Drop the in-memory cache (e.g. after a trade is edited). */
export function invalidateSparkline(tradeId?: number): void {
  if (tradeId == null) cache.clear();
  else { cache.delete(`id:${tradeId}`); cache.delete(`day:${tradeId}`); }
}


/** Candles are shared by URL: two trades on the same ticker / day draw from one request. */
const candleCache = new Map<string, Promise<{ candles: Candle[] } | null>>();
function getCandles(url: string): Promise<{ candles: Candle[] } | null> {
  const hit = candleCache.get(url);
  if (hit) return hit;
  if (candleCache.size >= MAX_CACHE) { const first = candleCache.keys().next().value; if (first !== undefined) candleCache.delete(first); }
  const p = http.get<{ candles: Candle[] }>(url).catch(() => null).then((r) => { if (!r) candleCache.delete(url); return r; });
  candleCache.set(url, p);
  return p;
}

type FillLite = Pick<Execution, "kind" | "price" | "executedAt">;
/**
 * Fill times for many rows in one request (GET /api/trade-executions/batch): requests made in the same tick are
 * merged. Ids the batch does not return (no access this way, or an older API without the route) fall back to the
 * single GET /api/trades/:id/executions.
 */
let batchSupported = true;
let pending: { id: number; resolve: (v: FillLite[] | null) => void }[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const single = (id: number) =>
  http.get<{ executions: Execution[] }>(`/api/trades/${id}/executions`).catch(() => null).then((r) => r?.executions ?? null);
async function flushFills() {
  flushTimer = null;
  const queue = pending;
  pending = [];
  for (let i = 0; i < queue.length; i += 100) {
    const chunk = queue.slice(i, i + 100);
    let items: Record<string, FillLite[]> | null = null;
    if (batchSupported) {
      try {
        const r = await http.get<{ items?: Record<string, FillLite[]> }>(`/api/trade-executions/batch?ids=${[...new Set(chunk.map((q) => q.id))].join(",")}`);
        items = r?.items ?? {};
      } catch (e) {
        if (isNotFound(e)) batchSupported = false;
        /* else network / other — per-trade fallback below */
      }
    }
    for (const q of chunk) {
      const hit = items?.[String(q.id)];
      if (hit) q.resolve(hit);
      else void single(q.id).then(q.resolve, () => q.resolve(null));
    }
  }
}
function getFills(id: number): Promise<FillLite[] | null> {
  return new Promise((resolve) => {
    pending.push({ id, resolve });
    if (!flushTimer) flushTimer = setTimeout(() => void flushFills(), 20);
  });
}

async function loadForTrade(trade: TradeLike, span: "trade" | "day" = "trade"): Promise<SparkData | null> {
  const { fromKey, toKey, dateKey } = tradeWindow(trade, 0);
  const [range, fills] = await Promise.all([
    getCandles(`/api/candles/${encodeURIComponent(trade.ticker)}/range?from=${fromKey}&to=${toKey}&interval=5m&extended=1`),
    trade.id > 0 ? getFills(trade.id) : Promise.resolve(null),
  ]);
  const ex = fills ? { executions: fills } : null;
  const bars = (range?.candles ?? []).filter((c) => Number.isFinite(c.c));
  if (!bars.length) return null;
  const execs = ex?.executions ?? [];
  const opening = execs.filter((e) => isOpening(e.kind) && e.executedAt);
  const closing = execs.filter((e) => !isOpening(e.kind) && e.executedAt);
  // Executions win; otherwise the caller's known fill times (e.g. a playbook example of another trader's trade).
  const entryTime = opening.length ? isoToEpoch(opening[0].executedAt) : trade.entryTime ? isoToEpoch(trade.entryTime) : null;
  const exitTime = closing.length ? isoToEpoch(closing[closing.length - 1].executedAt) : trade.exitTime ? isoToEpoch(trade.exitTime) : null;
  const side = sideOf(trade);
  void dateKey;
  return buildSparkData({
    bars, side,
    entryTime: Number.isFinite(entryTime as number) ? entryTime : null,
    exitTime: Number.isFinite(exitTime as number) ? exitTime : null,
    entryPrice: toNum(trade.entry) ?? (opening.length ? toNum(opening[0].price) : null),
    exitPrice: toNum(trade.exit) ?? (closing.length ? toNum(closing[closing.length - 1].price) : null),
    points: span === "day" ? 160 : 120, padBars: span === "day" ? null : 24,
  });
}

function loadCached(key: string, loader: () => Promise<SparkData | null>): Promise<SparkData | null> {
  const hit = cache.get(key);
  if (hit) return hit;
  if (cache.size >= MAX_CACHE) { const first = cache.keys().next().value; if (first !== undefined) cache.delete(first); }
  const p = loader().catch(() => null);
  cache.set(key, p);
  return p;
}

function useNearViewport<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = React.useRef<T | null>(null);
  const [near, setNear] = React.useState(false);
  React.useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    if (typeof IntersectionObserver === "undefined") { setNear(true); return; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setNear(true); io.disconnect(); }
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  return [ref, near];
}

export function TradeSparkline({ tradeId, trade, data: dataProp, width = 120, height = 36, tone = "pnl", className, title, span = "trade" }: TradeSparklineProps) {
  const [ref, near] = useNearViewport<HTMLCanvasElement>();
  const [data, setData] = React.useState<SparkData | null | undefined>(dataProp);
  const id = trade ? trade.id : tradeId;
  const key = dataProp !== undefined || id == null ? null : span === "day" ? `day:${id}` : `id:${id}`;

  React.useEffect(() => {
    if (dataProp !== undefined) { setData(dataProp); return; }
    if (!near || !key) return;
    let alive = true;
    const loader = trade
      ? () => loadForTrade(trade, span)
      : async () => { const t = await http.get<TradeLike>(`/api/trades/${tradeId}`).catch(() => null); return t ? loadForTrade(t, span) : null; };
    loadCached(key, loader).then((d) => { if (alive) setData(d); });
    return () => { alive = false; };
  }, [near, key, dataProp, trade, tradeId, span]);

  React.useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!data || data.closes.length < 2) return;
    const th = readChartTheme();
    const pnlSign = data.entryPrice != null && data.exitPrice != null ? (data.side === "short" ? data.entryPrice - data.exitPrice : data.exitPrice - data.entryPrice) : null;
    const color = tone === "neutral" || pnlSign == null ? th.muted : pnlSign >= 0 ? th.up : th.down;
    const pad = 3;
    const span = data.max - data.min || 1;
    const n = data.closes.length;
    const x = (i: number) => pad + (i / (n - 1)) * (width - pad * 2);
    const y = (p: number) => pad + (1 - (p - data.min) / span) * (height - pad * 2);
    // Faint context, bold in-trade segment.
    const a = data.entryIdx ?? 0, b = data.exitIdx ?? n - 1;
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    const stroke = (from: number, to: number, c: string, w: number) => {
      if (to <= from) return;
      ctx.beginPath();
      ctx.moveTo(x(from), y(data.closes[from]));
      for (let i = from + 1; i <= to; i++) ctx.lineTo(x(i), y(data.closes[i]));
      ctx.strokeStyle = c; ctx.lineWidth = w; ctx.stroke();
    };
    stroke(0, a, th.muted(0.45), 1);
    stroke(b, n - 1, th.muted(0.45), 1);
    if (b > a) {
      const g = ctx.createLinearGradient(0, 0, 0, height);
      g.addColorStop(0, color(0.28)); g.addColorStop(1, color(0.02));
      ctx.beginPath();
      ctx.moveTo(x(a), height - pad);
      for (let i = a; i <= b; i++) ctx.lineTo(x(i), y(data.closes[i]));
      ctx.lineTo(x(b), height - pad); ctx.closePath();
      ctx.fillStyle = g; ctx.fill();
    }
    stroke(a, b, color(1), 1.5);
    const dot = (i: number | null, price: number | null, fill: string) => {
      if (i == null) return;
      const py = price != null && Number.isFinite(price) ? y(price) : y(data.closes[i]);
      ctx.beginPath(); ctx.arc(x(i), py, 2.4, 0, Math.PI * 2);
      ctx.fillStyle = fill; ctx.fill();
      ctx.strokeStyle = th.bg(1); ctx.lineWidth = 1; ctx.stroke();
    };
    dot(data.entryIdx, data.entryPrice, th.primary(1));
    dot(data.exitIdx, data.exitPrice, color(1));
  }, [data, width, height, tone, ref]);

  const label = title ?? (data
    ? [chartI18n.t("sparkline.aria", { count: data.closes.length }), data.entryPrice != null ? chartI18n.t("sparkline.entry", { price: data.entryPrice }) : null, data.exitPrice != null ? chartI18n.t("sparkline.exit", { price: data.exitPrice }) : null].filter(Boolean).join(", ")
    : chartI18n.t("sparkline.empty"));
  return (
    <canvas
      ref={ref}
      role="img"
      aria-label={label}
      title={title}
      className={cn("block shrink-0", data === null && "opacity-30", className)}
      style={{ width, height }}
    />
  );
}
