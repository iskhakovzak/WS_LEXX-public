/**
 * Day levels: previous-day high/low/close, premarket high/low, opening-range (5/15 min). Pure.
 */
import type { Candle, DayLevels } from "../types";
import { etParts, RTH_OPEN_MIN, sessionOfMinutes } from "./time";

/**
 * Levels for the trade day `dayKey` (ET). PDH/PDL/PDC come from the latest earlier day present in
 * `bars` (regular hours); `prevCloseHint` (from the API) wins for PDC when the prior day is not loaded.
 */
export function dayLevels(bars: readonly Candle[], dayKey: string, prevCloseHint: number | null = null): DayLevels {
  let pdh: number | null = null, pdl: number | null = null, pdc: number | null = null;
  let pmh: number | null = null, pml: number | null = null, open: number | null = null;
  let o5h = -Infinity, o5l = Infinity, o15h = -Infinity, o15l = Infinity;
  let prevDay = "";
  for (const c of bars) {
    const p = etParts(c.t);
    const ses = sessionOfMinutes(p.mod);
    if (p.dayKey < dayKey) {
      if (ses !== "rth") continue;
      if (p.dayKey !== prevDay) { prevDay = p.dayKey; pdh = c.h; pdl = c.l; pdc = c.c; }
      else { pdh = Math.max(pdh ?? c.h, c.h); pdl = Math.min(pdl ?? c.l, c.l); pdc = c.c; }
      continue;
    }
    if (p.dayKey !== dayKey) continue;
    if (ses === "pre") {
      pmh = pmh == null ? c.h : Math.max(pmh, c.h);
      pml = pml == null ? c.l : Math.min(pml, c.l);
    } else if (ses === "rth") {
      if (open == null) open = c.o;
      const rel = p.mod - RTH_OPEN_MIN;
      if (rel >= 0 && rel < 5) { o5h = Math.max(o5h, c.h); o5l = Math.min(o5l, c.l); }
      if (rel >= 0 && rel < 15) { o15h = Math.max(o15h, c.h); o15l = Math.min(o15l, c.l); }
    }
  }
  if (pdc == null && prevCloseHint != null && Number.isFinite(prevCloseHint)) pdc = prevCloseHint;
  return {
    pdh, pdl, pdc, pmh, pml, open,
    orb5: Number.isFinite(o5h) ? { h: o5h, l: o5l } : null,
    orb15: Number.isFinite(o15h) ? { h: o15h, l: o15l } : null,
  };
}
