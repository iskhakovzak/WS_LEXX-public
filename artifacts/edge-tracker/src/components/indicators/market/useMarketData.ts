/**
 * Daily index history for the market view: one GET /api/stockdata/chart per symbol (2 years, daily bars).
 * The API caches each chart in memory for 5 minutes, so Yahoo sees at most 8 calls per 5 minutes no matter how
 * many people open the page; on the client every symbol is cached for 10 minutes and shared across mounts.
 * A failing symbol degrades only the cards/drivers that need it.
 */
import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { http } from "@/lib/api/http";
import { nyDate } from "@/lib/trading-date";
import { SYMBOLS, SYMBOL_KEYS, type Bar, type MarketData, type SymbolKey } from "./engine";

type ChartResp = { candles?: Array<{ t: number; o: number | null; h: number | null; l: number | null; c: number | null }> };

async function fetchBars(symbol: string, signal?: AbortSignal): Promise<Bar[]> {
  const data = await http.get<ChartResp>("/api/stockdata/chart", { query: { symbol, range: "2y", interval: "1d" }, signal });
  const byDate = new Map<string, Bar>();
  for (const c of data.candles ?? []) {
    if (c.c == null || !Number.isFinite(c.c)) continue;
    const d = nyDate(new Date(c.t));
    // Index quotes (VIX, yields) come without o/h/l on some days — fall back to the close.
    byDate.set(d, { d, o: c.o ?? c.c, h: c.h ?? c.c, l: c.l ?? c.c, c: c.c });
  }
  return [...byDate.values()].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
}

export const MARKET_KEY = "market-history";

export function useMarketData() {
  const results = useQueries({
    queries: SYMBOL_KEYS.map((k) => ({
      queryKey: [MARKET_KEY, SYMBOLS[k]],
      queryFn: ({ signal }: { signal?: AbortSignal }) => fetchBars(SYMBOLS[k], signal),
      staleTime: 10 * 60_000,
      gcTime: 60 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    })),
  });

  const stamp = results.map((r) => r.dataUpdatedAt).join(",");
  const data = useMemo(() => {
    const out: MarketData = {};
    SYMBOL_KEYS.forEach((k, i) => { const d = results[i].data; if (d) out[k] = d; });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp]);

  const failed = SYMBOL_KEYS.filter((_, i) => results[i].isError) as SymbolKey[];
  const spyIdx = SYMBOL_KEYS.indexOf("spy");
  return {
    data,
    /** SPY drives the frame: without it there is nothing to show. */
    isLoading: results[spyIdx].isLoading,
    isError: results[spyIdx].isError,
    failed,
    updatedAt: Math.max(0, ...results.map((r) => r.dataUpdatedAt || 0)),
    refetch: () => results.forEach((r) => void r.refetch()),
    isFetching: results.some((r) => r.isFetching),
  };
}
