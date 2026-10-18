/**
 * New York trading-day time helpers for candle code — pure (Intl only). routes/candles.ts re-exports them.
 */

const ET_OFFSET_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export type YMD = { y: number; m: number; d: number };

/** Strict calendar YYYY-MM-DD → parts, or null. */
export function parseDateStrict(dateStr: string): YMD | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return { y, m, d };
}

/** DST-aware: (date in ET, h:m wall time) → epoch seconds. */
export function etWallToUtcSeconds(parsed: YMD, h: number, m: number): number {
  const candidateUtcMs = Date.UTC(parsed.y, parsed.m - 1, parsed.d, h, m, 0);
  const parts = ET_OFFSET_FMT.formatToParts(new Date(candidateUtcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const etMs = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  const offsetMs = etMs - candidateUtcMs; // negative for ET (−4 h EDT, −5 h EST)
  return Math.floor((candidateUtcMs - offsetMs) / 1000);
}

/** Session window of a day in epoch seconds: 04:00–20:00 ET with extended hours, else 09:30–16:00 ET. */
export function dayWindowEpochSeconds(parsed: YMD, includeExtended: boolean): { start: number; end: number } {
  return includeExtended
    ? { start: etWallToUtcSeconds(parsed, 4, 0), end: etWallToUtcSeconds(parsed, 20, 0) }
    : { start: etWallToUtcSeconds(parsed, 9, 30), end: etWallToUtcSeconds(parsed, 16, 0) };
}

/** Regular-session bounds (09:30 / 16:00 ET) of a YYYY-MM-DD day in epoch seconds. */
export function rthBounds(day: string): { open: number; close: number } {
  const p = parseDateStrict(day);
  if (!p) throw new RangeError(`bad day ${day}`);
  return { open: etWallToUtcSeconds(p, 9, 30), close: etWallToUtcSeconds(p, 16, 0) };
}
