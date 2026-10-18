/**
 * Client-side timeframe aggregation (1m → 5m / 15m / 1h / D). Pure.
 */
import type { Bar, Candle, Timeframe } from "../types";
import { TF_SECONDS } from "../types";
import { etParts } from "./time";
import { chartI18n } from "@/i18n/ns/chart";

/** Bucket start (epoch seconds) for a bar time on the given timeframe. */
export function bucketStart(t: number, tf: Timeframe): number {
  if (tf === "D") {
    // One bar per New-York calendar day, keyed by the ET midnight of that day.
    const p = etParts(t);
    return t - (p.hour * 3600 + p.minute * 60 + p.second);
  }
  const sec = TF_SECONDS[tf];
  if (tf === "1h") {
    // Hourly bars aligned to the 9:30 open (9:30–10:30, …) like TradingView's RTH-aligned hours.
    return Math.floor((t - 1800) / 3600) * 3600 + 1800;
  }
  return Math.floor(t / sec) * sec;
}

/**
 * Fold `bars` (sorted, base interval `baseSec`) into `tf`. Returns the input untouched when the
 * timeframe equals the base. Bars coarser than the target are returned as-is (never split).
 */
export function aggregate(bars: readonly Candle[], baseSec: number, tf: Timeframe): Bar[] {
  const target = TF_SECONDS[tf];
  if (!bars.length) return [];
  if (target <= baseSec) return bars.map((b) => ({ ...b, n: 1 }));
  const out: Bar[] = [];
  let cur: Bar | null = null;
  let curKey = NaN;
  for (const b of bars) {
    const key = bucketStart(b.t, tf);
    if (cur && key === curKey) {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += Number.isFinite(b.v) ? b.v : 0;
      cur.n += 1;
    } else {
      cur = { t: tf === "D" ? b.t : key, o: b.o, h: b.h, l: b.l, c: b.c, v: Number.isFinite(b.v) ? b.v : 0, n: 1 };
      curKey = key;
      out.push(cur);
    }
  }
  return out;
}

/** Timeframes that make sense for a base interval (never finer than the data). */
export function availableTimeframes(baseSec: number, all: readonly Timeframe[]): Timeframe[] {
  return all.filter((tf) => TF_SECONDS[tf] >= baseSec);
}

/**
 * Why a timeframe cannot be drawn from bars of `baseSec` (null when it can). The server serves the finest bars the day
 * has: 1-minute ones only for the last 7 days (or when they were cached while fresh), 5-minute for the last 60 days,
 * hourly for older days — a finer timeframe cannot be built from coarser bars.
 */
export function timeframeUnavailableReason(tf: Timeframe, baseSec: number): string | null {
  if (TF_SECONDS[tf] >= baseSec) return null;
  if (baseSec <= 300) return chartI18n.t("tfReason.min1");
  if (baseSec <= 3600) return chartI18n.t("tfReason.min5");
  return chartI18n.t("tfReason.intraday");
}

/** Short label of the base bar size for notices: «1 мин», «5 мин», «1 ч» (EN/UZ «1m», «5m», «1h»). */
export function baseBarLabel(baseSec: number): string {
  if (baseSec >= 86400) return chartI18n.t("bars.daily");
  if (baseSec >= 3600) return chartI18n.t("bars.hours", { n: Math.round(baseSec / 3600) });
  return chartI18n.t("bars.minutes", { n: Math.round(baseSec / 60) });
}

/** Effective bar length in seconds for a timeframe (daily bars are one ET day). */
export function barSeconds(tf: Timeframe, baseSec: number): number {
  return Math.max(TF_SECONDS[tf], baseSec);
}
