import { useMemo } from "react";
import type { Trade } from "@workspace/api-client-react";
import type { StatTrade } from "./use-tagged-trades";
import { LIBRARY, HORIZONS, type Horizon } from "./library";

export type HorizonStats = { count: number; wins: number; winRate: number; avgR: number | null };
export type RecentTrade = { id: number; ticker: string; date: string; result: string; r: number | null; net: number | null; horizon: Horizon };

export type IndicatorStats = {
  count: number;
  wins: number;
  losses: number;
  winRate: number;
  avgR: number | null;
  /** Net of fees; null when no trade has pnl. */
  netPnl: number | null;
  byHorizon: Record<Horizon, HorizonStats>;
  recent: RecentTrade[];
};

export const EMPTY_STATS: IndicatorStats = {
  count: 0, wins: 0, losses: 0, winRate: 0, avgR: null, netPnl: null,
  byHorizon: { intraday: emptyH(), overnight: emptyH(), swing: emptyH() },
  recent: [],
};
function emptyH(): HorizonStats { return { count: 0, wins: 0, winRate: 0, avgR: null }; }

const TAG_ALIASES: Record<string, string[]> = {
  "s/r": ["support", "resistance", "s/r"],
  "h&s": ["head and shoulders", "h&s"],
  "dt/db": ["double top", "double bottom", "dt", "db", "dt/db"],
};

const phrases = (s: string) => new Set(s.toLowerCase().split(",").map((x) => x.trim()).filter(Boolean));
const tokens = (s: string) => new Set(s.toLowerCase().split(/[,;|\s]+/).map((x) => x.trim()).filter(Boolean));

export function horizonOf(t: Pick<Trade, "horizon">): Horizon {
  const h = t.horizon as string | null | undefined;
  return h === "overnight" || h === "swing" ? h : "intraday";
}

function summarize(list: StatTrade[]): Pick<HorizonStats, "count" | "wins" | "winRate" | "avgR"> {
  const wins = list.filter((t) => t.result === "win").length;
  const rs = list.filter((t) => t.rMultiple != null && Number.isFinite(Number(t.rMultiple))).map((t) => Number(t.rMultiple));
  return {
    count: list.length,
    wins,
    winRate: list.length ? Math.round((wins / list.length) * 100) : 0,
    avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
  };
}

/**
 * Per-indicator trade stats: a trade matches when its tags/setup mention one of the indicator tags.
 * `horizon` narrows the trades used ("all" = every trade).
 */
/**
 * `scopeTotal` — trades in scope for this horizon when `trades` is only the tagged subset (server-side filter);
 * null ⇒ `trades` is the whole book and is its own denominator.
 */
export function useIndicatorStats(trades: StatTrade[], horizon: Horizon | "all", scopeTotal: number | null = null) {
  return useMemo(() => {
    const prepared = trades
      .filter((t) => horizon === "all" || horizonOf(t) === horizon)
      .map((t) => ({
        t,
        tp: phrases(t.tags ?? ""), tt: tokens(t.tags ?? ""),
        sp: phrases(t.setup ?? ""), st: tokens(t.setup ?? ""),
      }));

    const map: Record<string, IndicatorStats> = {};
    const covered = new Set<number>();

    for (const ind of LIBRARY) {
      const expanded = new Set<string>();
      ind.tags.forEach((tag) => { expanded.add(tag); TAG_ALIASES[tag]?.forEach((a) => expanded.add(a)); });
      const multi = [...expanded].filter((x) => x.includes(" "));
      const single = [...expanded].filter((x) => !x.includes(" "));
      const matched = prepared
        .filter((p) => single.some((s) => p.tt.has(s) || p.st.has(s)) || multi.some((m) => p.tp.has(m) || p.sp.has(m)))
        .map((p) => p.t);
      matched.forEach((t) => covered.add(t.id));

      const base = summarize(matched);
      const withPnl = matched.filter((t) => t.pnl != null && Number.isFinite(Number(t.pnl)));
      const netPnl = withPnl.length ? withPnl.reduce((a, t) => a + Number(t.pnl) - (Number(t.fees) || 0), 0) : null;
      const byHorizon = {} as Record<Horizon, HorizonStats>;
      for (const h of HORIZONS) byHorizon[h] = summarize(matched.filter((t) => horizonOf(t) === h));

      const recent = [...matched]
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id))
        .slice(0, 6)
        .map((t) => ({
          id: t.id, ticker: t.ticker, date: t.date, result: t.result,
          r: t.rMultiple != null ? Number(t.rMultiple) : null,
          net: t.pnl != null ? Number(t.pnl) - (Number(t.fees) || 0) : null,
          horizon: horizonOf(t),
        }));

      map[ind.id] = { ...base, losses: matched.filter((t) => t.result === "loss").length, netPnl, byHorizon, recent };
    }

    const denom = scopeTotal != null && scopeTotal >= prepared.length ? scopeTotal : prepared.length;
    return { map, coverage: denom ? Math.round((covered.size / denom) * 100) : null, total: denom };
  }, [trades, horizon, scopeTotal]);
}
