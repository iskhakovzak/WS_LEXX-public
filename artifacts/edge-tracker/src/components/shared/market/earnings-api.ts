import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { http } from "@/lib/api/http";
import { STALE } from "@/lib/api/keys";
import { fmtRelative } from "@/lib/format";

export type CallType = "BMO" | "AMC" | "TNS";

export type EarningsItem = {
  ticker: string;
  company: string;
  callType: CallType;
  epsActual: number | null;
  epsEstimate: number | null;
  epsSurprisePct: number | null;
  marketCap?: string | null;
  marketCapNum?: number | null;
  fiscalQuarter?: string | null;
  noOfEsts?: number | null;
  lastYearEps?: number | null;
  lastYearDate?: string | null;
  price: number | null;
  priceMoveDay: number | null;
  pricePreMarket: number | null;
  pricePostMarket: number | null;
  volume: number | null;
  avgVolume: number | null;
  relVol: number | null;
};

export type EarningsWatchData = {
  date: string;
  amcDate: string;
  bmo: EarningsItem[];
  amc: EarningsItem[];
  fetchedAt?: string;
  refreshed?: boolean;
  throttled?: boolean;
  nextRefreshAt?: string;
};

export type UpcomingItem = Pick<
  EarningsItem,
  "ticker" | "company" | "callType" | "epsEstimate" | "marketCap" | "marketCapNum" | "fiscalQuarter" | "noOfEsts" | "lastYearEps" | "lastYearDate"
>;

export type UpcomingData = {
  today: string;
  days: { date: string; total: number; items: UpcomingItem[] }[];
  fetchedAt: string;
};

export type HistoryQuarter = {
  fiscalQuarter: string | null;
  date: string;
  epsActual: number | null;
  epsEstimate: number | null;
  surprisePct: number | null;
  beat: boolean | null;
  reactionDate: string | null;
  gapPct: number | null;
  dayPct: number | null;
  closePct: number | null;
  rangePct: number | null;
};

export type EarningsHistory = {
  ticker: string;
  timing: CallType | null;
  quarters: HistoryQuarter[];
  streak: { kind: "beat" | "miss" | null; count: number };
  beats: number;
  misses: number;
  avgAbsGap: number | null;
  avgAbsClose: number | null;
  upReactions: number;
  downReactions: number;
  fetchedAt: string;
};


export const EARNINGS_WATCH_KEY = ["earnings", "watch"] as const;
export const EARNINGS_UPCOMING_KEY = ["earnings", "upcoming", 5] as const;

export function useEarningsWatch(enabled = true) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: EARNINGS_WATCH_KEY,
    queryFn: ({ signal }) => http.get<EarningsWatchData>("/api/earnings/watch", { signal }),
    staleTime: STALE.long,
    enabled,
  });
  const [refreshing, setRefreshing] = useState(false);
  /** Bypasses the server cache (?refresh=1). Server rate-limits to one forced refresh per minute. */
  const refresh = useCallback(async (): Promise<{ throttled: boolean; nextRefreshAt?: string }> => {
    setRefreshing(true);
    try {
      const data = await http.get<EarningsWatchData>("/api/earnings/watch?refresh=1");
      qc.setQueryData(EARNINGS_WATCH_KEY, data);
      return { throttled: !!data.throttled, nextRefreshAt: data.nextRefreshAt };
    } finally {
      setRefreshing(false);
    }
  }, [qc]);
  return { ...query, refresh, refreshing };
}

export function useEarningsUpcoming(enabled = true) {
  return useQuery({
    queryKey: EARNINGS_UPCOMING_KEY,
    queryFn: ({ signal }) => http.get<UpcomingData>("/api/earnings/upcoming?days=5&limit=25", { signal }),
    staleTime: 15 * 60 * 1000,
    enabled,
  });
}

export function useEarningsHistory(ticker: string | null | undefined, timing?: CallType | null) {
  const t = (ticker ?? "").trim().toUpperCase();
  const tm = timing === "BMO" || timing === "AMC" ? timing : "";
  return useQuery({
    queryKey: ["earnings", "history", t, tm],
    queryFn: ({ signal }) => http.get<EarningsHistory>(`/api/earnings/history/${encodeURIComponent(t)}${tm ? `?timing=${tm}` : ""}`, { signal }),
    enabled: /^[A-Z][A-Z0-9.\-]{0,9}$/.test(t),
    staleTime: 60 * 60 * 1000,
    retry: 1,
  });
}

export function relTime(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "";
  return fmtRelative(t, { now, style: "short" });
}
