/**
 * Candle archive — market-data provider (Yahoo chart API through the shared cookie/crumb session in
 * lib/marketDataService). One call = one symbol-day at one bar size, 04:00–20:00 ET. Bars are cleaned of stray prints
 * (lib/candleClean) before anyone stores them.
 */
import { fetchYahooWithSession } from "../marketDataService";
import { cleanCandles } from "../candleClean";
import { dayWindowEpochSeconds, parseDateStrict } from "../candleDay";
import type { Bar } from "./codec";
import type { ArchiveTf } from "./days";

export type ProviderDay =
  | { kind: "ok"; bars: Bar[] }
  /** The provider answered but had no bars (holiday, not trading that day). */
  | { kind: "empty" }
  /** The provider refuses this bar size for a day that old (HTTP 422). */
  | { kind: "unavailable" }
  /** Network / session / rate-limit / server error — try again later, never fall back to coarser bars on this. */
  | { kind: "error"; status: number | null; message: string };

const yahooUrl = (symbol: string, p1: number, p2: number, interval: string, prePost: boolean) => (s: { crumb: string }) => {
  const q = new URLSearchParams({ period1: String(p1), period2: String(p2), interval, includePrePost: prePost ? "true" : "false", events: "div,split", crumb: s.crumb });
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${q.toString()}`;
};

/** Extended-hours bars of one day at `tf`. */
export async function fetchProviderDay(symbol: string, day: string, tf: ArchiveTf): Promise<ProviderDay> {
  const parsed = parseDateStrict(day);
  if (!parsed) return { kind: "error", status: null, message: "bad day" };
  const { start, end } = dayWindowEpochSeconds(parsed, true);
  let resp: Response | null;
  try {
    resp = await fetchYahooWithSession(yahooUrl(symbol, start, end, tf, true));
  } catch (err) {
    return { kind: "error", status: null, message: err instanceof Error ? err.message : String(err) };
  }
  if (!resp) return { kind: "error", status: null, message: "no provider session" };
  if (resp.status === 422) return { kind: "unavailable" };
  // 404 / 400: Yahoo's answer for a symbol it does not know (delisted, renamed) — nothing to archive, not a failure.
  if (resp.status === 404 || resp.status === 400) return { kind: "empty" };
  if (!resp.ok) return { kind: "error", status: resp.status, message: `HTTP ${resp.status}` };
  let data: any;
  try { data = await resp.json(); } catch { return { kind: "error", status: resp.status, message: "bad JSON" }; }
  const result = data?.chart?.result?.[0];
  if (!result) {
    const desc = String(data?.chart?.error?.description ?? "");
    return /not available|must be within/i.test(desc) ? { kind: "unavailable" } : { kind: "empty" };
  }
  const ts: number[] = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const raw: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    if (t < start || t >= end) continue; // Yahoo sometimes appends the live bar of today
    const b = { t, o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i], v: q.volume?.[i] ?? 0 };
    if (b.o != null && b.h != null && b.l != null && b.c != null) raw.push(b as Bar);
  }
  const bars = cleanCandles(raw);
  return bars.length ? { kind: "ok", bars } : { kind: "empty" };
}

/**
 * Previous-session close for each of `days` from ONE daily-bars call covering them all (PDC for the archive row, so
 * old charts never need a provider call for it). Days whose previous session is not in the response are left out.
 */
export async function fetchPrevCloses(symbol: string, days: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!days.length) return out;
  const sorted = [...days].sort();
  const p1 = Math.floor(Date.parse(`${sorted[0]}T00:00:00Z`) / 1000) - 14 * 86400;
  const p2 = Math.floor(Date.parse(`${sorted[sorted.length - 1]}T00:00:00Z`) / 1000) + 86400;
  try {
    const resp = await fetchYahooWithSession(yahooUrl(symbol, p1, p2, "1d", false));
    if (!resp?.ok) return out;
    const data: any = await resp.json();
    const r = data?.chart?.result?.[0];
    const ts: number[] = r?.timestamp || [];
    const closes: (number | null)[] = r?.indicators?.quote?.[0]?.close || [];
    // Daily bar timestamps are the 09:30 ET open; the NY date of the open is the session date.
    const sessions: { day: string; close: number }[] = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (c == null || !Number.isFinite(c)) continue;
      sessions.push({ day: new Date((ts[i] - 4 * 3600) * 1000).toISOString().slice(0, 10), close: Math.round(c * 10_000) / 10_000 });
    }
    for (const d of days) {
      let prev: number | null = null;
      for (const s of sessions) { if (s.day < d) prev = s.close; else break; }
      // Only trust it when that session is within a week (otherwise the response simply did not reach back).
      const lastBefore = [...sessions].reverse().find((s) => s.day < d);
      if (prev != null && lastBefore && Date.parse(`${d}T00:00:00Z`) - Date.parse(`${lastBefore.day}T00:00:00Z`) <= 6 * 86_400_000) out.set(d, prev);
    }
  } catch {
    /* PDC is optional */
  }
  return out;
}
