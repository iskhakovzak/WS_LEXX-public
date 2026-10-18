// Windowed trade list (audit P1-5): the legacy GET /api/trades accepts optional from/to/trader/limit/tagged.
// Pages that only need a period, one trader or the tagged subset ask for exactly that instead of the whole book.
//
// The generated `useListTrades` serialises any key of its params object, so the extra keys are passed through
// with a cast (no codegen). While the running API predates the filters it ignores them and returns the whole
// scoped book — `select` re-applies the same window client-side, so the page is correct on both builds.
import { useCallback, useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getListTradesQueryKey, useListTrades, type ListTradesParams, type Trade } from "@workspace/api-client-react";
import { closeDate, isOpen } from "@/lib/trade-math";
import { fetchTradesPage, TRADES_PAGE_KEY } from "@/hooks/use-trades-page";

export type TradesWindow = {
  /** YYYY-MM-DD — keep trades realised on/after this day (plus still-open positions). */
  from?: string | null;
  /** YYYY-MM-DD — keep trades entered on/before this day. */
  to?: string | null;
  /** One trader (staff only server-side; traders are always scoped to themselves). */
  trader?: string | null;
  /** Newest N by trade date. */
  limit?: number | null;
  /** Only trades with a setup or tags. */
  tagged?: boolean;
};

type WindowParams = { trader?: string; from?: string; to?: string; limit?: number; tagged?: "1" };

export function tradesWindowParams(w: TradesWindow): WindowParams | undefined {
  const p: WindowParams = {};
  if (w.trader) p.trader = w.trader;
  if (w.from) p.from = w.from;
  if (w.to) p.to = w.to;
  if (w.limit != null && w.limit > 0) p.limit = Math.floor(w.limit);
  if (w.tagged) p.tagged = "1";
  return Object.keys(p).length ? p : undefined;
}

const blank = (s: string | null | undefined) => !s || !s.trim();

/** Client mirror of the server window (routes/trades.ts LegacyWindowQuery). */
export function inTradesWindow(t: Pick<Trade, "date" | "exitDate" | "result" | "trader" | "setup" | "tags">, w: TradesWindow): boolean {
  if (w.trader && (t.trader ?? "").trim() !== w.trader.trim()) return false;
  const entry = String(t.date ?? "").slice(0, 10);
  if (w.to && entry > w.to) return false;
  if (w.from) {
    const realised = String(closeDate(t) ?? entry).slice(0, 10);
    if (realised < w.from && !isOpen(t)) return false;
  }
  if (w.tagged && blank(t.setup) && blank(t.tags)) return false;
  return true;
}

export function applyTradesWindow(trades: Trade[], w: TradesWindow): Trade[] {
  const out = trades.filter((t) => inTradesWindow(t, w));
  if (w.limit != null && w.limit > 0 && out.length > w.limit) {
    return [...out].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id)).slice(0, w.limit);
  }
  return out;
}

/**
 * useListTrades with a server-side window. Query key stays ["/api/trades", params] so
 * invalidateTradeDependents() keeps refreshing it after trade mutations.
 */
export function useTradesWindow(w: TradesWindow, opts: { enabled?: boolean; staleTime?: number } = {}) {
  const { from, to, trader, limit, tagged } = w;
  const params = useMemo(() => tradesWindowParams({ from, to, trader, limit, tagged }), [from, to, trader, limit, tagged]);
  const select = useCallback(
    (rows: Trade[]) => (params ? applyTradesWindow(Array.isArray(rows) ? rows : [], { from, to, trader, limit, tagged }) : rows),
    [params, from, to, trader, limit, tagged],
  );
  const generated = params as unknown as ListTradesParams | undefined;
  return useListTrades(generated, {
    query: {
      queryKey: getListTradesQueryKey(generated),
      enabled: opts.enabled ?? true,
      staleTime: opts.staleTime ?? 30_000,
      placeholderData: keepPreviousData,
      select,
    },
  });
}

export type TradesBookFacets = {
  /** Trades in the caller's scope (whole book, not windowed). */
  total: number;
  traders: string[];
  horizons: Record<string, number>;
  /** Latest entry date in scope. */
  lastDate: string | null;
};

/**
 * Cheap scope-wide facts (trader list, totals, horizon counts) from GET /api/trades/page?limit=1 — so a page
 * that windows its trade list does not need the whole book just to fill a trader selector or a counter.
 * null when the endpoint is unavailable (old build) — callers fall back to what the windowed list gives.
 */
export function useTradesBookFacets(opts: { trader?: string | null; enabled?: boolean } = {}) {
  const trader = opts.trader || "";
  return useQuery<TradesBookFacets | null>({
    queryKey: [TRADES_PAGE_KEY, "facets", trader],
    enabled: opts.enabled ?? true,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      // lite=1: the API skips rows / curve / streak / preset counts (an older API ignores it and answers in full).
      const p = new URLSearchParams({ limit: "1", lite: "1" });
      if (trader) p.set("trader", trader);
      try {
        const r = await fetchTradesPage(p, signal);
        return {
          total: Number(r.summary?.total ?? 0),
          traders: Array.isArray(r.facets?.traders) ? r.facets.traders : [],
          horizons: r.facets?.horizons ?? {},
          lastDate: r.summary?.lastDate ?? null,
        };
      } catch (err) {
        if (signal?.aborted) throw err;
        return null;
      }
    },
  });
}
