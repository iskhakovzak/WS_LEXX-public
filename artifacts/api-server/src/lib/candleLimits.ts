/**
 * How fine the bars of a past day can be — pure (no DB, no network), shared by routes/candles.ts (what the range
 * route serves) and routes/training.ts (which training tasks have minute bars).
 *
 * Yahoo serves 1-minute bars for days whose window starts within the last 30 days and 5/15/30-minute bars within
 * 60 (verified 2026-10-17 against the live API; the per-request span limit of 7–8 days is a different rule); hourly
 * for ~2 years. Ages here are counted from UTC midnight, so 29 / 59 keep a safe margin. A day archived while it was
 * fresh (candle_archive) or still in candles_cache keeps its fine bars forever, so «too old for Yahoo» does not mean
 * «no minute bars» — callers check those too.
 */

export type CandleInterval = "1m" | "5m" | "15m" | "30m" | "60m" | "1d";

export const YAHOO_1M_MAX_AGE_DAYS = 29;
export const YAHOO_INTRADAY_MAX_AGE_DAYS = 59;
export const YAHOO_HOURLY_MAX_AGE_DAYS = 730;

export const CANDLE_INTERVAL_SECONDS: Record<CandleInterval, number> = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "60m": 3600, "1d": 86400 };

/** Intraday intervals from fine to coarse. */
export const INTRADAY_LADDER: readonly CandleInterval[] = ["1m", "5m", "15m", "30m", "60m"];

/** Calendar days from the UTC midnight of `day` (YYYY-MM-DD) to `nowMs`. */
export function dayAgeDays(day: string, nowMs: number = Date.now()): number {
  return (nowMs - Date.parse(`${day.slice(0, 10)}T00:00:00Z`)) / 86400000;
}

/** Will Yahoo still serve `iv` bars for a day this old? */
export function intervalAllowedForAge(iv: CandleInterval, ageDays: number): boolean {
  if (iv === "1m") return ageDays <= YAHOO_1M_MAX_AGE_DAYS;
  if (iv === "5m" || iv === "15m" || iv === "30m") return ageDays <= YAHOO_INTRADAY_MAX_AGE_DAYS;
  if (iv === "60m") return ageDays <= YAHOO_HOURLY_MAX_AGE_DAYS;
  return true;
}

/** Finest interval Yahoo serves by age alone. */
export function intervalForAge(ageDays: number): CandleInterval {
  if (ageDays <= YAHOO_1M_MAX_AGE_DAYS) return "1m";
  if (ageDays <= YAHOO_INTRADAY_MAX_AGE_DAYS) return "5m";
  if (ageDays <= YAHOO_HOURLY_MAX_AGE_DAYS) return "60m";
  return "1d";
}

/**
 * Multi-day range: which interval to serve and from which day on. `ageBased` is what the OLDEST day allows by age.
 * When the caller asked for something finer, walk the ladder from the requested interval towards `ageBased` and take
 * the first interval that the trailing run of days (always including the last day — the trade day) can be served at,
 * by age or from the cache; older context days that cannot are dropped instead of coarsening the whole series.
 * Returns `fromIndex` = first day kept.
 */
export function pickServedInterval(
  days: readonly { str: string; age: number }[],
  requested: CandleInterval | null,
  ageBased: CandleInterval,
  cached: ReadonlyMap<CandleInterval, ReadonlySet<string>>,
): { interval: CandleInterval; fromIndex: number } {
  if (!requested || requested === "1d" || !days.length) return { interval: ageBased, fromIndex: 0 };
  if (intervalAllowedForAge(requested, days[0].age)) return { interval: requested, fromIndex: 0 };
  const reqSec = CANDLE_INTERVAL_SECONDS[requested];
  const capSec = CANDLE_INTERVAL_SECONDS[ageBased];
  for (const iv of INTRADAY_LADDER) {
    const sec = CANDLE_INTERVAL_SECONDS[iv];
    if (sec < reqSec || sec >= capSec) continue;
    const inCache = cached.get(iv);
    const ok = (d: { str: string; age: number }) => intervalAllowedForAge(iv, d.age) || !!inCache?.has(d.str);
    let i = days.length;
    while (i > 0 && ok(days[i - 1])) i--;
    if (i < days.length) return { interval: iv, fromIndex: i };
  }
  return { interval: ageBased, fromIndex: 0 };
}

/** Finest intraday bars a single day can be charted with (extended-hours cache flags for 1m / 5m). */
export function dayResolution(day: string, cached: { m1: boolean; m5: boolean }, nowMs: number = Date.now()): "1m" | "5m" | "60m" {
  const age = dayAgeDays(day, nowMs);
  if (cached.m1 || intervalAllowedForAge("1m", age)) return "1m";
  if (cached.m5 || intervalAllowedForAge("5m", age)) return "5m";
  return "60m";
}
