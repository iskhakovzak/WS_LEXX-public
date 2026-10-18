import { useMemo } from "react";
import type { Trade } from "@workspace/api-client-react";
import { useTradesWindow } from "@/hooks/use-trades-window";
import { netPnl, resultOf } from "@/lib/trade-math";

/** The viewer's own record on one ticker (net $ = pnl − |fees|, win rate = W / (W + L)). */
export type TickerHistory = {
  n: number;
  wins: number;
  losses: number;
  net: number;
  /** null when no decided trades. */
  wr: number | null;
  avg: number | null;
  lastDate: string | null;
  /** Newest first. */
  trades: Trade[];
};

export function summarizeTrades(trades: Trade[]): TickerHistory {
  let wins = 0, losses = 0, net = 0, withNet = 0;
  let lastDate: string | null = null;
  for (const t of trades) {
    const r = resultOf(t);
    if (r === "win") wins++;
    else if (r === "loss") losses++;
    const n = netPnl(t);
    if (n != null) { net += n; withNet++; }
    const d = String(t.date ?? "").slice(0, 10);
    if (d && (!lastDate || d > lastDate)) lastDate = d;
  }
  const sorted = [...trades].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  return {
    n: trades.length, wins, losses, net,
    wr: wins + losses > 0 ? wins / (wins + losses) : null,
    avg: withNet ? net / withNet : null,
    lastDate, trades: sorted,
  };
}

/**
 * Per-ticker history of the signed-in trader, from the trade book (same ["/api/trades", {trader}] cache
 * other pages use). Empty map for viewers without a trader name.
 */
export function useTickerHistory(me: string | null) {
  const q = useTradesWindow({ trader: me }, { enabled: !!me, staleTime: 5 * 60_000 });
  const map = useMemo(() => {
    const groups = new Map<string, Trade[]>();
    for (const t of (Array.isArray(q.data) ? q.data : []) as Trade[]) {
      const k = String(t.ticker ?? "").trim().toUpperCase();
      if (!k) continue;
      const arr = groups.get(k);
      if (arr) arr.push(t); else groups.set(k, [t]);
    }
    const out = new Map<string, TickerHistory>();
    for (const [k, arr] of groups) out.set(k, summarizeTrades(arr));
    return out;
  }, [q.data]);
  return { map, isLoading: !!me && q.isLoading };
}
