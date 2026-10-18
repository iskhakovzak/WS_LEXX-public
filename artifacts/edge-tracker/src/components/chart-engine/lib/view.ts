/**
 * Viewport and volume helpers for the chart — pure.
 */

export type LogicalRange = { from: number; to: number };

export type ViewMode = "day" | "trade";
export const isViewMode = (v: unknown): v is ViewMode => v === "day" || v === "trade";

/**
 * The view a trader expects when a trade opens.
 *  - "day" (default): every bar of the trade's day(s) — premarket 4:00 → after-hours 20:00 ET, each day a multi-day
 *    trade spans — so the whole session is in sight and the fills sit in context.
 *  - "trade": some lead-in before the entry (at least 30 bars), the whole trade and some room after the exit.
 * Without a trade: the trade day(s) / the regular session of the day; without that: the last 120 bars.
 */
export function defaultViewRange(o: {
  count: number;
  entryIdx: number | null;
  exitIdx: number | null;
  dayRange: { from: number; to: number } | null;
  /** Index span of all bars on the trade's day(s) (extended hours included). */
  daySpan?: { from: number; to: number } | null;
  mode?: ViewMode;
}): LogicalRange | null {
  if (o.count <= 0) return null;
  const mode = o.mode ?? "trade";
  if (mode === "day" && o.daySpan) return { from: o.daySpan.from - 2, to: o.daySpan.to + 3 };
  if (o.entryIdx != null) {
    const a = o.entryIdx, b = Math.max(a, o.exitIdx ?? a);
    const span = b - a;
    return { from: a - Math.max(30, Math.round(span * 0.6)), to: b + Math.max(20, Math.round(span * 0.5)) };
  }
  if (o.dayRange) return { from: o.dayRange.from - 5, to: o.dayRange.to + 5 };
  return { from: Math.max(0, o.count - 120), to: o.count + 5 };
}

/** First / last index of bars whose New York day is in [fromKey, toKey] (bars sorted by time). */
export function daySpanOf(dayKeys: readonly string[], fromKey: string, toKey: string): { from: number; to: number } | null {
  let from = -1, to = -1;
  for (let i = 0; i < dayKeys.length; i++) {
    const d = dayKeys[i];
    if (d < fromKey || d > toKey) continue;
    if (from < 0) from = i;
    to = i;
  }
  return from < 0 ? null : { from, to };
}

/**
 * Keep the replay cursor in view: when it leaves the window (or gets within 3 bars of the right edge), re-centre it at
 * ~70 % of the current width. Returns null when the current view is fine.
 */
export function followCursor(view: LogicalRange | null, cursor: number, minSpan = 40): LogicalRange | null {
  const span = view ? Math.max(minSpan, view.to - view.from) : 100;
  if (view && cursor <= view.to - 3 && cursor >= view.from) return null;
  return { from: cursor - span * 0.7, to: cursor + span * 0.3 };
}

/**
 * Volume capped at a high percentile so one opening-print spike does not flatten every other bar. The legend keeps
 * showing the true volume; only the bar heights are capped.
 */
export function capVolumes(vols: readonly number[], q = 0.98): { cap: number; values: number[] } {
  const clean = vols.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const sorted = clean.filter((v) => v > 0).sort((a, b) => a - b);
  if (!sorted.length) return { cap: 0, values: clean };
  const cap = sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
  return { cap, values: clean.map((v) => Math.min(v, cap)) };
}
