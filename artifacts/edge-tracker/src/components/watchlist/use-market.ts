import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { http } from "@/lib/api/http";
import { STALE, POLL } from "@/lib/api/keys";
import { addDays, nyDate, prevWeekday } from "@/lib/trading-date";
import type { Candle } from "@/components/chart-engine/types";
import { dayLevels } from "@/components/chart-engine/lib/levels";
import { sessionVwap } from "@/components/chart-engine/lib/vwap";
import { etParts } from "@/components/chart-engine/lib/time";
import { type EarningsHit, type NewsDigest, type Quote } from "./lib";
import { watchlistI18n } from "@/i18n/ns/watchlist";

/** Quote refresh choices (ms). 0 = paused. The API caches each symbol for 60 s, so faster polling buys nothing. */
export type QuoteInterval = 60_000 | 120_000 | 300_000 | 0;
const intervalOption = (value: QuoteInterval) => ({
  value,
  get label() { return value === 0 ? watchlistI18n.t("quote.pause") : watchlistI18n.t("quote.min", { count: value / 60_000 }); },
});
export const QUOTE_INTERVALS: readonly { readonly value: QuoteInterval; readonly label: string }[] = [
  intervalOption(60_000), intervalOption(120_000), intervalOption(300_000), intervalOption(0),
];

/** Day levels refresh: PDH/PDL never change intraday; VWAP moves slowly. One candles call per ticker per 5 min. */
const LEVELS_INTERVAL_MS = 5 * 60_000;
const LEVELS_MAX_TICKERS = 40;
const LEVELS_CONCURRENCY = 2;

function isWeekend(date: string): boolean {
  const wd = new Date(`${date}T12:00:00Z`).getUTCDay();
  return wd === 0 || wd === 6;
}
function nextWeekday(date: string): string {
  let d = addDays(date, 1);
  while (isWeekend(d)) d = addDays(d, 1);
  return d;
}

/**
 * Session calendar for levels (NY): on a trading day the levels belong to today (PDH = yesterday's high);
 * on a weekend they belong to the next session (PDH = Friday's high) and VWAP is not shown.
 */
export function sessionDays(today = nyDate()) {
  const weekend = isWeekend(today);
  return {
    today,
    weekend,
    /** Last date with bars to request (≤ today, weekday). */
    lastSession: weekend ? prevWeekday(today) : today,
    /** The session the levels are for. */
    levelsDay: weekend ? nextWeekday(today) : today,
  };
}

/**
 * Live market layer for the watchlist: batched quotes (auto-refresh at `intervalMs` while the tab is visible),
 * a cache-only news digest, today's / recent earnings and the earnings calendar of the next days.
 * Everything degrades gracefully when an endpoint is missing.
 */
export function useWatchlistMarket(tickers: string[], intervalMs: number) {
  const key = useMemo(() => Array.from(new Set(tickers.map((t) => t.toUpperCase()))).sort(), [tickers]);
  const enabled = key.length > 0;
  const live = intervalMs > 0;

  const quotes = useQuery<Record<string, Quote>>({
    queryKey: ["watchlist-quotes", key],
    enabled,
    queryFn: async () => {
      const chunks: string[][] = [];
      for (let i = 0; i < key.length; i += 50) chunks.push(key.slice(i, i + 50));
      const parts = await Promise.all(
        chunks.map((c) => http.get<Record<string, Quote>>("/api/stockdata/quote", { query: { symbols: c.join(",") } })),
      );
      return Object.assign({}, ...parts);
    },
    staleTime: STALE.default,
    refetchInterval: live ? intervalMs : false,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
    retry: 1,
  });

  const news = useQuery<Record<string, NewsDigest>>({
    queryKey: ["watchlist-news-summary", key],
    enabled,
    queryFn: async () => {
      const j = await http
        .get<{ tickers?: Record<string, NewsDigest> }>("/api/news/summary", { query: { tickers: key.slice(0, 100).join(",") } })
        .catch(() => null);
      return j?.tickers ?? {};
    },
    staleTime: STALE.long,
    refetchInterval: live ? POLL.fiveMinutes : false,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
    retry: 0,
  });

  const earnings = useQuery<Record<string, EarningsHit>>({
    queryKey: ["watchlist-earnings-map"],
    enabled,
    queryFn: async () => {
      type Row = { ticker: string; callType: "BMO" | "AMC" | "TNS"; epsSurprisePct: number | null; priceMoveDay: number | null };
      const j = await http.get<{ bmo?: Row[]; amc?: Row[] }>("/api/earnings/watch").catch(() => null);
      if (!j) return {};
      const map: Record<string, EarningsHit> = {};
      for (const e of j.amc ?? []) map[e.ticker.toUpperCase()] = { callType: e.callType, when: "recent", epsSurprisePct: e.epsSurprisePct, priceMoveDay: e.priceMoveDay };
      for (const e of j.bmo ?? []) map[e.ticker.toUpperCase()] = { callType: e.callType, when: "today", epsSurprisePct: e.epsSurprisePct, priceMoveDay: e.priceMoveDay };
      return map;
    },
    staleTime: 15 * 60_000,
    retry: 0,
  });

  const upcoming = useQuery<Record<string, UpcomingEarnings>>({
    queryKey: ["watchlist-earnings-upcoming"],
    enabled,
    queryFn: async () => {
      type Day = { date: string; items?: { ticker: string; callType: "BMO" | "AMC" | "TNS" }[] };
      const j = await http.get<{ today?: string; days?: Day[] }>("/api/earnings/upcoming?days=5&limit=60").catch(() => null);
      if (!j) return {};
      const map: Record<string, UpcomingEarnings> = {};
      for (const d of j.days ?? []) {
        for (const e of d.items ?? []) {
          const t = e.ticker.toUpperCase();
          if (!map[t]) map[t] = { date: d.date, callType: e.callType };
        }
      }
      return map;
    },
    staleTime: 60 * 60_000,
    retry: 0,
  });

  return {
    quotes: quotes.data ?? {},
    quotesLoading: quotes.isLoading && enabled,
    quotesError: quotes.isError,
    quotesFetching: quotes.isFetching,
    quotesUpdatedAt: quotes.dataUpdatedAt,
    refetchQuotes: () => { void quotes.refetch(); void news.refetch(); },
    news: news.data ?? {},
    earnings: earnings.data ?? {},
    upcoming: upcoming.data ?? {},
  };
}

export type UpcomingEarnings = { date: string; callType: "BMO" | "AMC" | "TNS" };

/** Key levels of the session for one ticker (from 5-minute bars incl. pre/post market). */
export type DayLevelSet = {
  pdh: number | null; pdl: number | null; pdc: number | null;
  pmh: number | null; pml: number | null;
  /** Session VWAP of today (null on weekends / before the open). */
  vwap: number | null;
  levelsDay: string;
};

// Tiny shared semaphore: at most LEVELS_CONCURRENCY candle requests in flight across the page.
let inFlight = 0;
const waiters: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= LEVELS_CONCURRENCY) await new Promise<void>((resolve) => waiters.push(resolve));
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    waiters.shift()?.();
  }
}

type CandlesResponse = { candles?: Candle[]; prevClose?: number | null };

export async function fetchSessionBars(ticker: string, days = sessionDays(), interval: "1m" | "5m" = "5m", daysBack = 1): Promise<CandlesResponse> {
  const url = `/api/candles/${encodeURIComponent(ticker)}?date=${days.lastSession}&interval=${interval}&daysBack=${daysBack}&extended=1`;
  return http.get<CandlesResponse>(url).catch(() => ({ candles: [] }));
}

export function levelsFromBars(bars: readonly Candle[], prevClose: number | null, days = sessionDays()): DayLevelSet {
  const lv = dayLevels(bars, days.levelsDay, prevClose);
  let vwap: number | null = null;
  if (!days.weekend) {
    const pts = sessionVwap(bars);
    const last = pts[pts.length - 1];
    if (last && etParts(last.t).dayKey === days.levelsDay) vwap = last.vwap;
  }
  return { pdh: lv.pdh, pdl: lv.pdl, pdc: lv.pdc, pmh: lv.pmh, pml: lv.pml, vwap, levelsDay: days.levelsDay };
}

/**
 * PDH / PDL / PMH / PML / VWAP for the listed tickers. Cache-friendly: past days are stored by the API forever,
 * today's bars for 5 min; the client refetches every 5 min (only while live) with ≤ 2 requests in flight.
 */
export function useWatchlistLevels(tickers: string[], live: boolean) {
  const days = sessionDays();
  const list = useMemo(() => Array.from(new Set(tickers.map((t) => t.toUpperCase()))).slice(0, LEVELS_MAX_TICKERS), [tickers]);
  const results = useQueries({
    queries: list.map((t) => ({
      queryKey: ["watchlist-levels", t, days.lastSession],
      queryFn: () => withSlot(async () => {
        const j = await fetchSessionBars(t, days);
        const bars = Array.isArray(j.candles) ? j.candles : [];
        return bars.length ? levelsFromBars(bars, j.prevClose ?? null, days) : null;
      }),
      staleTime: LEVELS_INTERVAL_MS,
      gcTime: 30 * 60_000,
      refetchInterval: live && !days.weekend ? LEVELS_INTERVAL_MS : (false as const),
      refetchIntervalInBackground: false,
      retry: 0,
    })),
  });
  const signature = results.map((r) => r.dataUpdatedAt).join(",");
  return useMemo(() => {
    const map: Record<string, DayLevelSet | null> = {};
    list.forEach((t, i) => { if (results[i]?.data !== undefined) map[t] = results[i].data ?? null; });
    return map;
    // `results` is a new array every render; `signature` captures what changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, signature]);
}
