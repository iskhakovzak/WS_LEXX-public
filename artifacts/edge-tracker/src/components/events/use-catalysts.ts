// Data layer of «Катализаторы»: everything is pulled automatically — the macro calendar (holiday_calendar),
// earnings of the trader's tickers (watchlist ∪ most traded), the trader's own trades — and folded through the
// pure math in catalyst-math.ts. Only GET endpoints that already exist; `tickers=` on /earnings/upcoming is an
// additive hint (newer API keeps those tickers beyond the market-cap limit), the client filters either way.
import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useListEvents, type MarketEvent } from "@workspace/api-client-react";
import { http } from "@/lib/api/http";
import { KEYS, STALE } from "@/lib/api/keys";
import { addDays, nyDate } from "@/lib/trading-date";
import { useHolidaysRange } from "@/lib/market-intel";
import { useTradesWindow } from "@/hooks/use-trades-window";
import { useEarningsWatch, type CallType, type EarningsHistory, type UpcomingData, type UpcomingItem } from "@/components/shared/market/earnings-api";
import {
  buildDayBook, categoriesByDate, closedDates, edgeByCategory, earningsEdge, focusDay, frequentTickers, nyMinutesOf,
  prevTradingDay, type BookTrade, type MacroRow, type TickerHistory,
} from "./catalyst-math";
import { dayOf } from "./event-meta";
import { eventsI18n } from "@/i18n/ns/events";

const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;


type WatchRow = { ticker: string; status?: string | null; deletedAt?: string | null };

/** Active (not archived) watchlist tickers. Shares the ["watchlist"] cache with the watchlist page, so adds show up here at once. */
export function useWatchlistTickers() {
  return useQuery({
    queryKey: KEYS.watchlist(),
    queryFn: ({ signal }) => http.get<WatchRow[]>("/api/watchlist", { signal }),
    staleTime: STALE.short,
    select: (rows: WatchRow[]) =>
      (Array.isArray(rows) ? rows : [])
        .filter((r) => !r.deletedAt && !["passed", "archived"].includes(String(r.status ?? "").toLowerCase()))
        .map((r) => String(r.ticker ?? "").trim().toUpperCase())
        .filter((t) => TICKER_RE.test(t)),
  });
}

export type MyEarnings = UpcomingItem & { date: string; mine: "watch" | "traded" | "both" };

/** Upcoming earnings (≤ 10 trading days from today) restricted to `tickers`. */
export function useMyEarnings(tickers: string[]) {
  const csv = [...tickers].sort().join(",");
  return useQuery({
    queryKey: ["catalysts", "earnings", csv],
    queryFn: ({ signal }) => http.get<UpcomingData>(`/api/earnings/upcoming?days=10&limit=60${csv ? `&tickers=${encodeURIComponent(csv)}` : ""}`, { signal }),
    enabled: tickers.length > 0,
    staleTime: 15 * 60_000,
    retry: 1,
  });
}

/** Earnings histories (reaction gap/range per quarter) — shares the cache key with useEarningsHistory. */
export function useHistories(tickers: string[]) {
  const results = useQueries({
    queries: tickers.map((t) => ({
      queryKey: ["earnings", "history", t, ""],
      queryFn: ({ signal }: { signal?: AbortSignal }) => http.get<EarningsHistory>(`/api/earnings/history/${encodeURIComponent(t)}`, { signal }),
      staleTime: 60 * 60_000,
      retry: 0,
    })),
  });
  return useMemo(() => {
    const map = new Map<string, EarningsHistory>();
    let loading = 0, failed = 0;
    results.forEach((r, i) => {
      if (r.data) map.set(tickers[i], r.data);
      else if (r.isLoading) loading++;
      else if (r.isError) failed++;
    });
    return { map, loading, failed };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results.map((r) => r.dataUpdatedAt + ":" + r.status).join("|"), tickers.join(",")]);
}

export type CatalystData = ReturnType<typeof useCatalysts>;

/** Everything the page needs for one trader. */
export function useCatalysts(trader: string | null) {
  const today = nyDate();
  const trades = useTradesWindow({ trader: trader || null }, { staleTime: 60_000 });
  const holidays = useHolidaysRange(addDays(today, -400), addDays(today, 120));
  const watchlist = useWatchlistTickers();
  const notesQ = useListEvents();
  const watch = useEarningsWatch();

  const rows = useMemo<MacroRow[]>(() => (holidays.data?.events ?? []) as MacroRow[], [holidays.data]);
  const cats = useMemo(() => categoriesByDate(rows), [rows]);
  const closed = useMemo(() => closedDates(rows), [rows]);
  const tradeRows = useMemo<BookTrade[]>(() => (trades.data ?? []) as unknown as BookTrade[], [trades.data]);
  const book = useMemo(() => buildDayBook(tradeRows), [tradeRows]);
  const edge = useMemo(() => edgeByCategory(book, cats, closed), [book, cats, closed]);
  const frequent = useMemo(() => frequentTickers(tradeRows, 15, 3), [tradeRows]);
  /** All closed trades per ticker (any count) — «ваша история в тикере» next to a reporter. */
  const tickerStats = useMemo(() => {
    const m = new Map<string, { n: number; net: number; last: string }>();
    for (const t of frequentTickers(tradeRows, 10_000, 1)) m.set(t.ticker, { n: t.n, net: t.net, last: t.lastDate });
    return m;
  }, [tradeRows]);

  const watchSet = useMemo(() => new Set(watchlist.data ?? []), [watchlist.data]);
  const tradedSet = useMemo(() => new Set(frequent.map((f) => f.ticker)), [frequent]);
  const myTickers = useMemo(() => [...new Set([...watchSet, ...tradedSet])].filter((t) => TICKER_RE.test(t)), [watchSet, tradedSet]);

  const upcoming = useMyEarnings(myTickers);
  const mineOf = (t: string): MyEarnings["mine"] => (watchSet.has(t) && tradedSet.has(t) ? "both" : watchSet.has(t) ? "watch" : "traded");

  /** date → my reporting tickers that day (as published by the calendar). */
  const earningsByDate = useMemo(() => {
    const m = new Map<string, MyEarnings[]>();
    const want = new Set(myTickers);
    for (const d of upcoming.data?.days ?? []) {
      const items = d.items.filter((i) => want.has(i.ticker.toUpperCase())).map((i) => ({ ...i, date: d.date, mine: mineOf(i.ticker.toUpperCase()) }));
      if (items.length) m.set(d.date, items);
    }
    // Yesterday's after-close reporters (not in /upcoming, which starts today) from /earnings/watch.
    const w = watch.data;
    if (w?.amcDate && !m.has(w.amcDate)) {
      const items = w.amc.filter((i) => want.has(i.ticker.toUpperCase())).map((i) => ({ ...i, date: w.amcDate, mine: mineOf(i.ticker.toUpperCase()) }));
      if (items.length) m.set(w.amcDate, items);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upcoming.data, watch.data, myTickers.join(","), watchSet, tradedSet]);

  /** Earnings that move the open of `day`: BMO/TNS on the day + AMC of the previous trading day. */
  const reportersFor = useMemo(() => (day: string) => {
    const prev = prevTradingDay(day, closed);
    const same = (earningsByDate.get(day) ?? []).filter((e) => e.callType !== "AMC");
    const before = (earningsByDate.get(prev) ?? []).filter((e) => e.callType === "AMC");
    const after = (earningsByDate.get(day) ?? []).filter((e) => e.callType === "AMC");
    return { before, same, after, prev };
  }, [earningsByDate, closed]);

  const notes = useMemo(() => {
    const m = new Map<string, MarketEvent[]>();
    for (const e of notesQ.data ?? []) {
      const d = dayOf(e);
      m.set(d, [...(m.get(d) ?? []), e]);
    }
    return m;
  }, [notesQ.data]);

  const focus = focusDay(today, nyMinutesOf(), closed);

  return {
    today, focus,
    trades, tradeRows, holidays, rows, cats, closed, book, edge, frequent, tickerStats,
    watchlist, watchSet, tradedSet, myTickers,
    upcoming, watch, earningsByDate, reportersFor,
    notesQ, notes,
  };
}

/** Earnings edge per ticker from loaded histories (pure fold, memoised by the caller). */
export function edgesFrom(trades: BookTrade[], tickers: string[], histories: Map<string, EarningsHistory>) {
  return tickers
    .map((t) => histories.get(t))
    .filter((h): h is EarningsHistory => !!h && h.quarters.length > 0)
    .map((h) => earningsEdge(trades, { ticker: h.ticker, quarters: h.quarters } as TickerHistory));
}

export const callLabel = (c: CallType | string | null | undefined) =>
  eventsI18n.t(c === "BMO" ? "call.bmo" : c === "AMC" ? "call.amc" : "call.unknown");
