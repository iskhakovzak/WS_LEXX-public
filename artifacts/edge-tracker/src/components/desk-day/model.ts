/**
 * «Деск на тикере» — pure helpers (no React / DOM): trader colours, markers on the bar series, the visible window,
 * takeaway wording. Tested in __tests__/model.test.ts.
 */
import type { Candle } from "@/components/chart-engine/types";
import { timeToLogical } from "@/components/chart-engine/lib/time";
import type { DeskDay, DeskOffice, DeskTakeaway, DeskTrader } from "./api";
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

/**
 * Traders focused by default: the one named by the `alias` URL param (a link from the top of the day), else the viewer
 * when they traded the ticker, otherwise nobody (everything at full strength).
 */
export function defaultFocus(day: Pick<DeskDay, "traders">, alias?: number | null): string[] {
  const picked = alias != null ? day.traders.find((t) => t.alias === alias) : undefined;
  if (picked) return [picked.name];
  const me = day.traders.find((t) => t.me);
  return me ? [me.name] : [];
}

/**
 * The office position per chart bar (signed % of the day's peak): the value after the last minute with a fill that
 * starts before the bar ends; `startPct` before the first fill. Works for any bar size (1m / 5m / 15m).
 */
export function samplePath(office: Pick<DeskOffice, "path" | "startPct">, bars: readonly Pick<Candle, "t">[], barSec: number): number[] {
  const out: number[] = [];
  let j = 0, cur = office.startPct;
  for (const b of bars) {
    const end = b.t + barSec;
    while (j < office.path.length && office.path[j].t < end) { cur = office.path[j].pct; j++; }
    out.push(cur);
  }
  return out;
}

/** Bar index range [from, to] of an ISO time window on `bars` (a window inside one bar gives that bar); null off-chart. */
export function windowBars(bars: readonly Pick<Candle, "t">[], barSec: number, fromIso: string, toIso: string): { from: number; to: number } | null {
  if (!bars.length) return null;
  const a = Math.floor(Date.parse(fromIso) / 1000), b = Math.floor(Date.parse(toIso) / 1000);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const idx = (t: number) => {
    let lo = 0, hi = bars.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m].t <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans;
  };
  const last = bars[bars.length - 1].t + barSec;
  if (b < bars[0].t || a >= last) return null;
  return { from: Math.max(0, idx(a)), to: Math.max(0, idx(b)) };
}

/**
 * Zero-volume bars carry no trades: their wicks are stray quotes (the archive keeps e.g. META 2026-09-16 16:45 ET with a
 * 628–714 range on a 674 body), which would flatten the whole day on the price axis. Clamp them to the body.
 */
export function clampEmptyWicks(bars: readonly Candle[]): Candle[] {
  return bars.map((b) => (b.v > 0 ? b : { ...b, h: Math.max(b.o, b.c), l: Math.min(b.o, b.c) }));
}
