/**
 * «Деск на тикере» — pure helpers (no React / DOM): trader colours, markers on the bar series, the visible window,
 * takeaway wording. Tested in __tests__/model.test.ts.
 */
import type { Candle } from "@/components/chart-engine/types";
import { timeToLogical } from "@/components/chart-engine/lib/time";
import type { DeskDay, DeskTakeaway, DeskTrader } from "./api";
import type { DeskMarker } from "./DeskFillsPrimitive";

/**
 * Trader colours: distinct hues that read on dark and light backgrounds and stay away from the candles' pure
 * up-green / down-red. Assigned in legend order (best result first), so the same day always looks the same.
 */
export const TRADER_COLORS = [
  "#3b82f6", "#f59e0b", "#a855f7", "#14b8a6", "#ec4899", "#84cc16",
  "#06b6d4", "#b45309", "#94a3b8", "#d946ef", "#6366f1", "#ea580c",
] as const;

export function traderColors(traders: readonly Pick<DeskTrader, "name">[]): Map<string, string> {
  return new Map(traders.map((t, i) => [t.name, TRADER_COLORS[i % TRADER_COLORS.length]]));
}

const epoch = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};

/**
 * One marker per leg with a known time, placed at its fractional logical index on `bars` (a fill inside a bar sits
 * on that bar; the index is rounded to the bar so markers line up with the candles).
 */
export function buildMarkers(day: Pick<DeskDay, "trades">, bars: readonly Candle[], barSec: number, colors: ReadonlyMap<string, string>): DeskMarker[] {
  if (!bars.length) return [];
  const first = bars[0].t, last = bars[bars.length - 1].t + barSec;
  const out: DeskMarker[] = [];
  for (const t of day.trades) {
    t.legs.forEach((l, i) => {
      const at = epoch(l.at);
      if (at == null || at < first || at >= last) return;
      out.push({
        key: `${t.id}:${i}`, trader: t.trader, tradeId: t.id, role: l.role, inferred: l.inferred, buy: l.buy, price: l.price,
        idx: Math.floor(timeToLogical(bars as Candle[], at, barSec)),
        color: colors.get(t.trader) ?? TRADER_COLORS[0],
      });
    });
  }
  return out;
}

/** Bar range to show first: the desk's fills with some room around them (whole data when there are none). */
export function initialWindow(markers: readonly Pick<DeskMarker, "idx">[], barCount: number, pad = 20): { from: number; to: number } {
  if (!barCount) return { from: 0, to: 0 };
  if (!markers.length) return { from: 0, to: barCount - 1 };
  let lo = Infinity, hi = -Infinity;
  for (const m of markers) { lo = Math.min(lo, m.idx); hi = Math.max(hi, m.idx); }
  return { from: Math.max(0, lo - pad), to: Math.min(barCount - 1, hi + pad) };
}

/** Takeaway lines to show (at most `max`, in the server's priority order). Kinds the client cannot word are skipped. */
export function pickTakeaways(list: readonly DeskTakeaway[], max = 2): DeskTakeaway[] {
  const known = new Set<DeskTakeaway["kind"]>(["best", "averaging", "timing", "sides"]);
  return list.filter((t) => known.has(t.kind)).slice(0, max);
}

/** Traders focused by default: the viewer when they traded the ticker, otherwise nobody (everything at full strength). */
export function defaultFocus(day: Pick<DeskDay, "traders">): string[] {
  const me = day.traders.find((t) => t.me);
  return me ? [me.name] : [];
}

/**
 * Zero-volume bars carry no trades: their wicks are stray quotes (the archive keeps e.g. META 2026-09-16 16:45 ET with a
 * 628–714 range on a 674 body), which would flatten the whole day on the price axis. Clamp them to the body.
 */
export function clampEmptyWicks(bars: readonly Candle[]): Candle[] {
  return bars.map((b) => (b.v > 0 ? b : { ...b, h: Math.max(b.o, b.c), l: Math.min(b.o, b.c) }));
}
