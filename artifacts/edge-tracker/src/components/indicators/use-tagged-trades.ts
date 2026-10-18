// Tagged trades for «Справочник» stats: GET /api/indicators/tagged-trades (columnar, ten fields, ~2 MB for the whole
// desk) instead of GET /api/trades?tagged=1 (every column, ~60 MB). An API build without the slim route (404)
// falls back to the full list, so the page works on both.
import { useQuery } from "@tanstack/react-query";
import type { Trade } from "@workspace/api-client-react";
import { http } from "@/lib/api/http";
import { nullIfMissing } from "@/lib/api/errors";
import { STALE } from "@/lib/api/keys";

/** The fields the indicator stats read. */
export type StatTrade = Pick<Trade, "id" | "ticker" | "date" | "result" | "rMultiple" | "pnl" | "fees" | "tags" | "setup" | "horizon">;

type Columnar = {
  n: number; dict: string[];
  id: number[]; ticker: number[]; date: string[]; result: number[]; r: (number | null)[];
  pnl: (number | null)[]; fees: (number | null)[]; tags: number[]; setup: number[]; horizon: number[];
};

/** Columnar payload → rows (dictionary index -1 = null). Exported for tests. */
export function decodeTagged(c: Columnar): StatTrade[] {
  const s = (k: number | undefined) => (k == null || k < 0 ? null : c.dict[k] ?? null);
  const out: StatTrade[] = new Array(c.n);
  for (let i = 0; i < c.n; i++) {
    out[i] = {
      id: c.id[i],
      ticker: s(c.ticker[i]) ?? "",
      date: c.date[i],
      result: s(c.result[i]) ?? "",
      rMultiple: c.r[i],
      pnl: c.pnl[i],
      fees: c.fees[i],
      tags: s(c.tags[i]),
      setup: s(c.setup[i]),
      horizon: s(c.horizon[i]),
    } as StatTrade;
  }
  return out;
}


export function useTaggedTrades() {
  return useQuery<StatTrade[]>({
    queryKey: ["indicators", "tagged-trades"],
    staleTime: STALE.long,
    queryFn: async ({ signal }) => {
      const slim = await http.get<Columnar>("/api/indicators/tagged-trades", { signal }).catch(nullIfMissing);
      if (slim && Array.isArray(slim.id)) return decodeTagged(slim);
      const full = await http.get<Trade[]>("/api/trades?tagged=1", { signal }).catch(nullIfMissing);
      return Array.isArray(full) ? full : [];
    },
  });
}
