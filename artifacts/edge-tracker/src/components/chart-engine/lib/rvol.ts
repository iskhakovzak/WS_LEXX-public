/**
 * Relative volume per bar: this bar's volume ÷ the mean volume of the same time-of-day slot on the
 * other days present in the series. Null when no other day has that slot (single-day data). Pure.
 */
import type { Candle } from "../types";
import { etParts } from "./time";

export function rvolSeries(bars: readonly Candle[]): (number | null)[] {
  const bySlot = new Map<number, { sum: number; n: number }>();
  const slot = new Int32Array(bars.length);
  const days = new Set<string>();
  for (let i = 0; i < bars.length; i++) {
    const p = etParts(bars[i].t);
    days.add(p.dayKey);
    slot[i] = p.mod;
    const v = Number.isFinite(bars[i].v) ? bars[i].v : 0;
    const s = bySlot.get(p.mod) ?? { sum: 0, n: 0 };
    s.sum += v; s.n += 1;
    bySlot.set(p.mod, s);
  }
  if (days.size < 2) return bars.map(() => null);
  return bars.map((b, i) => {
    const s = bySlot.get(slot[i]);
    if (!s || s.n < 2) return null;
    const v = Number.isFinite(b.v) ? b.v : 0;
    const others = (s.sum - v) / (s.n - 1);
    return others > 0 ? v / others : null;
  });
}
