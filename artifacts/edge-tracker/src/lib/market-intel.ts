import { useQuery } from "@tanstack/react-query";
import { http } from "@/lib/api/http";


export type TickerFundamentals = {
  ticker: string;
  marketCap: string | null;
  float: string | null;
  sharesOutstanding: string | null;
  shortInterest: number | null;
  atr: number | null;
  relativeVolume: number | null;
  beta: number | null;
  averageDailyVolume: string | null;
  sector: string | null;
  industry: string | null;
  longName: string | null;
};

export type NewsItem = {
  guid: string;
  title: string;
  source: string | null;
  url: string | null;
  category: string;
  summary: string | null;
  publishedAt: string | null;
};

export type SectorPoint = {
  symbol: string;
  name: string;
  price: number | null;
  changePct: number | null;
  prevClose: number | null;
  trend5d: number | null;
};

export type HolidayEvent = {
  id: number;
  date: string;
  type: string;
  name: string;
  description: string | null;
  importance: "high" | "medium" | "low" | string;
};

export type MarketBrief = {
  generatedAt: string;
  date: string;
  futures: { symbol: string; name: string; price: number | null; changePct: number | null; prevClose: number | null; preMarketPrice: number | null; preMarketChangePct: number | null; postMarketPrice: number | null; postMarketChangePct: number | null }[];
  overnight?: { symbol: string; name: string; region: string; price: number | null; changePct: number | null }[];
  macro?: { symbol: string; name: string; kind: string; price: number | null; changePct: number | null }[];
  premarketMovers: { ticker: string; catalyst: string | null; sector: string | null; preMarketPct: number | null; preMarketPrice: number | null; prevClose: number | null }[];
  gapLeaders: { ticker: string; catalyst: string | null; sector: string | null; gapPct: number | null; price: number | null }[];
  sectorRotation: { symbol: string; name: string; changePct: number | null; trend5d: number | null }[];
  earningsToday: { ticker: string; headline: string | null }[];
  economicEvents: HolidayEvent[];
  yesterdayThemes: { what_works_now: string | null; market_theme: string | null; best_tickers: string | null; date?: string } | null;
  topNews?: { ticker: string; headline: string; event_type: string; date: string; percent_move: number | null; sector: string | null }[];
  aiSummary?: string | null;
  lookback?: { startDate: string; endDate: string; label: string; days: number } | null;
  cached?: boolean;
  fetchedAt?: string;
};

export async function fetchTickerFundamentals(ticker: string, force = false): Promise<TickerFundamentals | null> {
  if (!ticker) return null;
  return http
    .get<TickerFundamentals>(`/api/stockdata/fundamentals?ticker=${encodeURIComponent(ticker)}${force ? "&force=1" : ""}`)
    .catch(() => null);
}

export function useTickerFundamentals(ticker: string | null | undefined, opts: { enabled?: boolean } = {}) {
  return useQuery<TickerFundamentals | null>({
    queryKey: ["ticker-fundamentals", ticker],
    queryFn: () => fetchTickerFundamentals(ticker!),
    enabled: Boolean(ticker && (opts.enabled ?? true)),
    staleTime: 30 * 60 * 1000,
    retry: 1,
  });
}

export function useTickerNews(
  ticker: string | null | undefined,
  opts: { enabled?: boolean; limit?: number; before?: string | Date | null } = {}
) {
  const limit = opts.limit ?? 12;
  const beforeIso = opts.before
    ? (opts.before instanceof Date ? opts.before.toISOString() : new Date(opts.before).toISOString())
    : null;
  return useQuery<{ ticker: string; items: NewsItem[]; before: string | null }>({
    queryKey: ["ticker-news", ticker, limit, beforeIso],
    queryFn: () => {
      const params = new URLSearchParams({ ticker: ticker!, limit: String(limit) });
      if (beforeIso) params.set("before", beforeIso);
      return http.get<{ ticker: string; items: NewsItem[]; before: string | null }>(
        `/api/news?${params.toString()}`
      );
    },
    enabled: Boolean(ticker && (opts.enabled ?? true)),
    staleTime: 30 * 60 * 1000,
  });
}

export type AnalystActionKind = "upgrade" | "downgrade" | "initiated" | "maintain" | "reiterated" | "other";

export type AnalystAction = {
  id: number;
  ticker: string;
  firm: string;
  action: AnalystActionKind;
  actionRaw: string;
  toGrade: string | null;
  fromGrade: string | null;
  source: string;
  sourceUrl: string | null;
  gradedAt: string | null;
  priceTarget: string | null;
  priceTargetFrom: string | null;
  marketCap: string | null;
  marketCapNum: number | null;
  sector: string | null;
  longName: string | null;
};

export type AnalystActionGroup = {
  ticker: string;
  marketCap: string | null;
  marketCapNum: number | null;
  sector: string | null;
  longName: string | null;
  totalActions: number;
  upgradeCount: number;
  downgradeCount: number;
  lastGradedAt: string | null;
  actions: AnalystAction[];
};

export type AnalystActionsResponse = {
  items: AnalystAction[];
  count: number;
  availableFirms: string[];
  filters: Record<string, unknown>;
};

export type AnalystActionsGroupedResponse = {
  groups: AnalystActionGroup[];
  totalGroups: number;
  totalActions: number;
  availableFirms: string[];
  filters: Record<string, unknown>;
};

type AnalystActionsOpts = {
  minMarketCap?: number;
  action?: "all" | "upgrade" | "downgrade" | "initiated" | "maintain" | "reiterated" | "moves";
  before?: string | null;
  after?: string | null;
  ticker?: string | null;
  firm?: string | null;
  limit?: number;
  enabled?: boolean;
};

function buildAnalystParams(opts: AnalystActionsOpts): URLSearchParams {
  const params = new URLSearchParams();
  if (opts.minMarketCap != null) params.set("minMarketCap", String(opts.minMarketCap));
  if (opts.action) params.set("action", opts.action);
  if (opts.before) params.set("before", opts.before);
  if (opts.after) params.set("after", opts.after);
  if (opts.ticker) params.set("ticker", opts.ticker);
  if (opts.firm) params.set("firm", opts.firm);
  if (opts.limit) params.set("limit", String(opts.limit));
  return params;
}

export function useAnalystActions(opts: AnalystActionsOpts = {}) {
  const qs = buildAnalystParams(opts).toString();
  return useQuery<AnalystActionsResponse>({
    queryKey: ["analyst-actions", "flat", qs],
    queryFn: () => http.get<AnalystActionsResponse>(`/api/analyst-actions?${qs}`),
    enabled: opts.enabled ?? true,
    staleTime: 5 * 60 * 1000,
  });
}

export function useAnalystActionsGrouped(opts: AnalystActionsOpts = {}) {
  const params = buildAnalystParams(opts);
  params.set("groupBy", "ticker");
  const qs = params.toString();
  return useQuery<AnalystActionsGroupedResponse>({
    queryKey: ["analyst-actions", "grouped", qs],
    queryFn: () => http.get<AnalystActionsGroupedResponse>(`/api/analyst-actions?${qs}`),
    enabled: opts.enabled ?? true,
    staleTime: 5 * 60 * 1000,
  });
}

export type AnalystScanResult = {
  ok: boolean;
  scanned: number;
  tickersWithData: number;
  rowsTotal: number;
  rowsInserted: number;
  errors: number;
  durationMs: number;
  watchlistSize: number;
};

export async function refreshAnalystActions(payload: { tickers?: string[]; concurrency?: number } = {}): Promise<AnalystScanResult> {
  return http.post<AnalystScanResult>("/api/analyst-actions/refresh", payload);
}

export function useSectors() {
  return useQuery<{ sectors: SectorPoint[]; fetchedAt: string | null }>({
    queryKey: ["sectors"],
    queryFn: () => http.get<{ sectors: SectorPoint[]; fetchedAt: string | null }>(`/api/sectors`),
    refetchInterval: 60 * 1000,
    staleTime: 30 * 1000,
  });
}

export function useTodayHolidays() {
  return useQuery<{ today: HolidayEvent[]; upcoming: HolidayEvent[] }>({
    queryKey: ["holidays-today"],
    queryFn: () => http.get<{ today: HolidayEvent[]; upcoming: HolidayEvent[] }>(`/api/holidays/today`),
    staleTime: 60 * 60 * 1000,
  });
}

export function useHolidaysRange(from: string, to: string) {
  return useQuery<{ events: HolidayEvent[] }>({
    queryKey: ["holidays-range", from, to],
    queryFn: () => http.get<{ events: HolidayEvent[] }>(`/api/holidays?from=${from}&to=${to}`),
    enabled: !!from && !!to,
    staleTime: 60 * 60 * 1000,
  });
}

export function useMarketBrief(opts: { enabled?: boolean } = {}) {
  return useQuery<MarketBrief>({
    queryKey: ["market-brief"],
    queryFn: () => http.get<MarketBrief>(`/api/market-brief`),
    enabled: opts.enabled ?? true,
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });
}
