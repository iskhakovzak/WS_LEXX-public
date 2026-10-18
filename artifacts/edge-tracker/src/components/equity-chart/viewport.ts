/**
 * Viewport math (pure): the visible window of the index axis, zoom around an anchor, pan, presets, tweening.
 *
 * A view is [from, to] in slot units — candle i spans [i, i + 1]. A little padding is allowed on both sides
 * so the first / last candle never sticks to the axis; the window can't be narrower than `minSpan` candles.
 */
import { addDays, nyDate } from "@/lib/trading-date";
import { equityChartI18n } from "@/i18n/ns/equityChart";

export interface View { from: number; to: number }

export type Preset = "1w" | "1m" | "3m" | "ytd" | "all";

export const PRESET_VALUES: readonly Preset[] = ["1w", "1m", "3m", "ytd", "all"];
/** Window presets with labels in the UI language (call at render time). */
export function presets(): { value: Preset; label: string; title: string }[] {
  return PRESET_VALUES.map((value) => ({ value, label: equityChartI18n.t(`presets.${value}`), title: equityChartI18n.t(`presets.${value}Title`) }));
}

/** Side padding in slots: half a candle on short series, a touch more on long ones. */
export function padFor(n: number): number {
  return n <= 1 ? 3 : n < 12 ? 0.75 : Math.min(3, 0.6 + n * 0.004);
}

/** Narrowest window: 8 slots (a 1-day series is not one giant candle), never wider than the full view. */
export function minSpanFor(n: number): number {
  const full = fullView(n);
  return Math.min(Math.max(8, n * 0.01), full.to - full.from);
}

export function fullView(n: number): View {
  const pad = padFor(n);
  return { from: -pad, to: Math.max(1, n) + pad };
}

/** Keeps the span inside [minSpan, full] and the window inside the padded data range. */
export function clampView(v: View, n: number): View {
  const full = fullView(n);
  const fullSpan = full.to - full.from;
  let span = Math.max(minSpanFor(n), Math.min(fullSpan, v.to - v.from));
  if (!Number.isFinite(span) || span <= 0) span = fullSpan;
  let from = v.from;
  if (!Number.isFinite(from)) from = full.from;
  if (span >= fullSpan) return { ...full };
  // Center a narrow window on short data instead of pinning (1-day series).
  from = Math.min(Math.max(from, full.from), full.to - span);
  return { from, to: from + span };
}

/** Zoom by `factor` (< 1 = in) keeping `anchor` (slot coordinate) under the cursor. */
export function zoomAt(v: View, anchor: number, factor: number, n: number): View {
  const f = Math.max(0.05, Math.min(20, factor));
  return clampView({ from: anchor - (anchor - v.from) * f, to: anchor + (v.to - anchor) * f }, n);
}

export function pan(v: View, delta: number, n: number): View {
  return clampView({ from: v.from + delta, to: v.to + delta }, n);
}

/** First trading date of a preset (inclusive) or null for «Всё». */
export function presetStart(p: Preset, today: string = nyDate()): string | null {
  if (p === "all") return null;
  if (p === "ytd") return `${today.slice(0, 4)}-01-01`;
  if (p === "1w") return addDays(today, -6);
  const [y, m, d] = today.split("-").map(Number);
  const back = p === "1m" ? 1 : 3;
  return new Date(Date.UTC(y, m - 1 - back, d)).toISOString().slice(0, 10);
}

/** First candle whose last day is on / after `date` (keys sorted); n when none. */
export function indexFrom(tos: string[], date: string): number {
  let lo = 0, hi = tos.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tos[mid] < date) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Window of a preset over candles ending on `tos` (the last day of each candle). */
export function presetView(tos: string[], p: Preset, today?: string): View {
  const n = tos.length;
  const start = presetStart(p, today);
  const full = fullView(n);
  if (start == null || !n) return full;
  const i = indexFrom(tos, start);
  if (i <= 0) return full;
  // Data older than the preset exists: show from the preset start up to «now» (right padding kept).
  const from = Math.min(i, n - 1) - 0.4;
  return clampView({ from, to: full.to }, n);
}

/** Presets that would show the same as «Всё» (data shorter than the preset) are pointless — disable them. */
export function presetUseful(tos: string[], p: Preset, today?: string): boolean {
  if (p === "all") return true;
  const start = presetStart(p, today);
  return start != null && tos.length > 0 && tos[0] < start;
}

/** Window for a date range [from, to] (e.g. a week clicked in the weekly view, opened by days). */
export function rangeView(tos: string[], from: string, to: string): View {
  const n = tos.length;
  const a = indexFrom(tos, from);
  const b = Math.max(a, indexFrom(tos, to));
  const mid = (a + Math.min(b, n - 1) + 1) / 2;
  const span = Math.max(Math.min(b, n - 1) - a + 1 + 4, minSpanFor(n), 10);
  return clampView({ from: mid - span / 2, to: mid + span / 2 }, n);
}

/** Visible candle indices [i0, i1] (inclusive, clamped). */
export function visibleRange(v: View, n: number): [number, number] {
  return [Math.max(0, Math.floor(v.from)), Math.min(n - 1, Math.ceil(v.to) - 1)];
}

/** Moves the window just enough to show candle `i` with a 1-slot margin. */
export function ensureVisible(v: View, i: number, n: number): View {
  const span = v.to - v.from;
  if (i < v.from + 1) return clampView({ from: i - 1, to: i - 1 + span }, n);
  if (i + 1 > v.to - 1) return clampView({ from: i + 2 - span, to: i + 2 }, n);
  return v;
}

export const easeOutCubic = (t: number) => 1 - (1 - Math.max(0, Math.min(1, t))) ** 3;

export function lerpView(a: View, b: View, t: number): View {
  return { from: a.from + (b.from - a.from) * t, to: a.to + (b.to - a.to) * t };
}

export function sameView(a: View, b: View, eps = 1e-3): boolean {
  return Math.abs(a.from - b.from) < eps && Math.abs(a.to - b.to) < eps;
}
