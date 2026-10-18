import { useMutation, useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { http } from "@/lib/api/http";
import { STALE } from "@/lib/api/keys";
import { riskMeQuery } from "@/lib/api/queries";
import { addDays, nyDate } from "@/lib/trading-date";
import { closeDate, feesOf, isOpen, netPnl, num as tmNum } from "@/lib/trade-math";
import { wallMinutes, type DayTrade } from "./risk-math";

export type Horizon = "intraday" | "overnight" | "swing";
export type RiskStatus = "ok" | "warn" | "breach" | "no_limits";
export type StopState = "ok" | "warn" | "stop" | "weekly" | "drawdown" | "no_limits";
export type PnlSource = "propreports" | "journal" | null;

export type RiskLimits = {
  trader: string;
  accountSize: number | null;
  dailyLossLimit: number | null;
  weeklyLossLimit: number | null;
  maxDrawdown: number | null;
  maxRiskPerTrade: number | null;
  maxPositionUsd: number | null;
  maxOvernightExposure: number | null;
  maxOpenPositions: number | null;
  allowOvernight: boolean;
  allowSwing: boolean;
  tier: string | null;
  notes: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
};

export type RiskAlert = {
  kind: string;
  label: string;
  level: "warn" | "breach";
  used: number;
  limit: number | null;
  pct: number | null;
  detail?: string;
  tradeId?: number;
};

export type RiskStop = {
  state: StopState;
  label: string;
  message: string;
  halted: boolean;
  dailyRemainingUsd: number | null;
  weeklyRemainingUsd: number | null;
  drawdownRemainingUsd: number | null;
  dailyPct: number | null;
  weeklyPct: number | null;
  drawdownPct: number | null;
};

export type RiskMetrics = {
  trader: string;
  status: RiskStatus;
  stop: RiskStop;
  halted: boolean;
  alerts: RiskAlert[];
  breaches: RiskAlert[];
  sources: { today: PnlSource; week: PnlSource | "mixed"; history: { propreports: number; journal: number } };
  today: {
    date: string;
    pnlNet: number | null;
    source: PnlSource;
    fees: number;
    r: number;
    trades: number;
    brokerTrades: number;
    openPositions: number;
    carriedPositions: number;
    carriedTonight: number;
    openRiskUsd: number;
    overnightExposureUsd: number;
    grossExposureUsd: number;
    dailyLimitUsedPct: number | null;
    dailyRemainingUsd: number | null;
    dailyRemainingAfterOpenRiskUsd: number | null;
  };
  week: { from: string; pnlNet: number | null; r: number; trades: number; limitUsedPct: number | null; remainingUsd: number | null };
  drawdown: {
    hasPnl: boolean;
    equityNet: number | null;
    peakNet: number | null;
    currentUsd: number;
    maxUsd: number;
    currentPct: number | null;
    limitUsedPct: number | null;
    remainingUsd: number | null;
    cumR: number;
    currentR: number;
    redDayStreak: number;
  };
};

export type RiskMe = RiskMetrics & { limits: RiskLimits | null; afterClose: boolean };

export type DeskRow = RiskMetrics & {
  role: string | null;
  banned: boolean;
  limits: RiskLimits | null;
  spark: number[];
  sparkUnit: "usd" | "r";
  lastTradeDate: string | null;
};

export type DeskBanner = { trader: string; state: StopState; label: string; message: string; halted: boolean };

export type RiskDesk = {
  date: string;
  nyMinutes: number;
  afterClose: boolean;
  summary: {
    traders: number;
    pnlNetToday: number | null;
    pnlSource: PnlSource | "mixed";
    rToday: number;
    tradesToday: number;
    breach: number;
    warn: number;
    noLimits: number;
    halted: number;
    nearStop: number;
    openPositions: number;
    carriedPositions: number;
    carriedTonight: number;
    openRiskUsd: number;
    overnightExposureUsd: number;
  };
  banner: DeskBanner[];
  traders: DeskRow[];
};

export type RiskPosition = {
  id: number;
  ticker: string;
  date: string;
  side: string | null;
  setup: string | null;
  trader: string;
  horizon: Horizon;
  qty: number | null;
  entry: number | null;
  stop: number | null;
  daysHeld: number;
  riskUsd: number | null;
  riskSource: "planned" | "stop" | null;
  riskMismatch: boolean;
  plannedRiskUsd: number | null;
  stopRiskUsd: number | null;
  exposureUsd: number | null;
  carried: boolean;
  carriedTonight: boolean;
  noStatus: boolean;
  source: "propreports" | "manual";
  sector: string | null;
  atr: number | null;
};

export type PositionTotals = { count: number; carried: number; carriedTonight: number; riskUsd: number; exposureUsd: number; overnightExposureUsd: number };

export type RiskPositions = {
  date: string;
  trader: string | null;
  afterClose: boolean;
  positions: RiskPosition[];
  totals: PositionTotals;
};

export type Catalyst = { date: string; type: string; description: string | null; impact: string };

export type OvernightTrader = {
  trader: string;
  limits: RiskLimits | null;
  positions: number[];
  exposureUsd: number;
  riskUsd: number;
  pctOfMaxOvernight: number | null;
  overnightAllowed: boolean | null;
  swingAllowed: boolean | null;
  stop: RiskStop;
  todayPnlNet: number | null;
  todaySource: PnlSource;
  dailyRemainingUsd: number | null;
};

export type OvernightBook = {
  date: string;
  trader: string | null;
  keyTime: string;
  nyMinutes: number;
  afterKey: boolean;
  preview: boolean;
  minutesToKey: number | null;
  minutesToClose: number | null;
  positions: RiskPosition[];
  catalysts: Record<string, Catalyst[]>;
  traders: OvernightTrader[];
  totals: PositionTotals;
};

export type RiskAlertRecord = {
  id: number;
  trader: string;
  date: string;
  kind: StopState;
  level: "warn" | "breach";
  used: number | null;
  limit: number | null;
  message: string;
  createdAt: string;
};

export type LimitEvent = {
  id: number;
  trader: string;
  before: Partial<RiskLimits> | null;
  after: Partial<RiskLimits>;
  reason: string | null;
  changedBy: string | null;
  changedAt: string;
};

export type HistoryPoint = {
  date: string;
  pnl: number | null;
  source: PnlSource;
  trades: number;
  r: number;
  fees: number;
  cum: number;
  equity: number | null;
  drawdown: number;
  cumR: number;
  drawdownR: number;
};

export type RiskHistory = {
  trader: string;
  from: string;
  to: string;
  unit: "usd" | "r";
  limits: RiskLimits | null;
  points: HistoryPoint[];
  sources: { propreports: number; journal: number };
  stats: {
    days: number;
    greenDays: number;
    redDays: number;
    redDayStreak: number;
    worstRedStreak: number;
    bestDay: number | null;
    worstDay: number | null;
    maxDrawdown: number;
    currentDrawdown: number;
  };
};

/** Quote shape from GET /api/stockdata/quote (only the fields the risk desk reads). */
export type Quote = {
  price: number | null;
  change: number | null;
  prevClose: number | null;
  atr: number | null;
  gapPct: number | null;
  name?: string | null;
  marketTime?: number | null;
};

export type EarningsHit = { date: string; callType: "BMO" | "AMC" | "TNS"; company?: string | null };
export type OfferingHit = { date: string; type: string; status: string; dealSizeM: number | null; dilutionPct: number | null };

const REFRESH_MS = 60_000;

export const riskKeys = {
  all: ["risk"] as const,
  me: () => ["risk", "me"] as const,
  desk: () => ["risk", "desk"] as const,
  history: (trader: string, days: number) => ["risk", "history", trader, days] as const,
  positions: (trader: string | null) => ["risk", "positions", trader ?? "*"] as const,
  limits: (trader: string) => ["risk", "limits", trader] as const,
  limitsHistory: (trader: string) => ["risk", "limits-history", trader] as const,
  overnight: (trader: string | null, preview: boolean) => ["risk", "overnight", trader ?? "*", preview] as const,
  alerts: (trader: string | null, days: number) => ["risk", "alerts", trader ?? "*", days] as const,
  quotes: (tickers: string[]) => ["risk", "quotes", tickers] as const,
  earnings: () => ["risk", "earnings-upcoming"] as const,
  offerings: () => ["risk", "offerings"] as const,
};

export function useRiskMe(enabled = true) {
  return useQuery({ ...riskMeQuery<RiskMe>(), enabled, refetchInterval: REFRESH_MS });
}

export function useRiskDesk(enabled = true) {
  return useQuery({
    queryKey: riskKeys.desk(),
    queryFn: () => http.get<RiskDesk>(`/api/risk/desk?date=${nyDate()}`),
    enabled,
    refetchInterval: REFRESH_MS,
  });
}

export function useRiskHistory(trader: string | null, days: number) {
  return useQuery({
    queryKey: riskKeys.history(trader ?? "", days),
    queryFn: () =>
      http.get<RiskHistory>(`/api/risk/history?trader=${encodeURIComponent(trader ?? "")}&days=${days}&date=${nyDate()}`),
    enabled: !!trader,
    placeholderData: keepPreviousData,
  });
}

export function useRiskPositions(trader: string | null, enabled = true) {
  const q = trader ? `trader=${encodeURIComponent(trader)}&` : "";
  return useQuery({
    queryKey: riskKeys.positions(trader),
    queryFn: () => http.get<RiskPositions>(`/api/risk/positions?${q}date=${nyDate()}`),
    enabled,
    refetchInterval: REFRESH_MS,
  });
}

export function useOvernightBook(trader: string | null, preview: boolean, enabled = true) {
  const q = trader ? `trader=${encodeURIComponent(trader)}&` : "";
  return useQuery({
    queryKey: riskKeys.overnight(trader, preview),
    queryFn: () => http.get<OvernightBook>(`/api/risk/overnight?${q}date=${nyDate()}${preview ? "&all=1" : ""}`),
    enabled,
    refetchInterval: REFRESH_MS,
    placeholderData: keepPreviousData,
  });
}

export function useRiskAlerts(trader: string | null, days = 14, enabled = true) {
  const q = trader ? `trader=${encodeURIComponent(trader)}&` : "";
  return useQuery({
    queryKey: riskKeys.alerts(trader, days),
    queryFn: () => http.get<{ from: string; trader: string | null; alerts: RiskAlertRecord[] }>(`/api/risk/alerts?${q}days=${days}`),
    enabled,
    refetchInterval: REFRESH_MS,
  });
}

export function useLimitsHistory(trader: string | null, enabled = true) {
  return useQuery({
    queryKey: riskKeys.limitsHistory(trader ?? ""),
    queryFn: () => http.get<LimitEvent[]>(`/api/risk/limits/${encodeURIComponent(trader ?? "")}/history`),
    enabled: enabled && !!trader,
  });
}

/** Batched quotes (≤50 per request, 60 s cache on the server). Missing symbols are simply absent. */
export function useQuotes(tickers: string[], enabled = true) {
  const key = Array.from(new Set(tickers.map((t) => t.toUpperCase()).filter(Boolean))).sort();
  return useQuery({
    queryKey: riskKeys.quotes(key),
    enabled: enabled && key.length > 0,
    queryFn: async () => {
      const chunks: string[][] = [];
      for (let i = 0; i < key.length; i += 50) chunks.push(key.slice(i, i + 50));
      const parts = await Promise.all(
        chunks.map((c) => http.get<Record<string, Quote>>(`/api/stockdata/quote?symbols=${encodeURIComponent(c.join(","))}`).catch(() => ({} as Record<string, Quote>))),
      );
      return Object.assign({}, ...parts) as Record<string, Quote>;
    },
    staleTime: 30_000,
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
    retry: 1,
  });
}

/** Earnings calendar for the next 10 trading days → ticker → {date, callType}. Degrades to {} when unavailable. */
export function useEarningsMap(enabled = true) {
  return useQuery({
    queryKey: riskKeys.earnings(),
    enabled,
    queryFn: async () => {
      type Day = { date: string; items: { ticker: string; callType: "BMO" | "AMC" | "TNS"; company?: string | null }[] };
      const j = await http.get<{ days: Day[] }>(`/api/earnings/upcoming?days=10&limit=60`).catch(() => ({ days: [] as Day[] }));
      const map: Record<string, EarningsHit> = {};
      for (const d of j.days ?? []) for (const it of d.items ?? []) {
        const t = it.ticker.toUpperCase();
        if (!map[t]) map[t] = { date: d.date, callType: it.callType, company: it.company ?? null };
      }
      return map;
    },
    staleTime: 10 * 60_000,
    retry: 0,
  });
}

/** Today's offerings / dilution watch → ticker → offering. Degrades to {} when unavailable. */
export function useOfferingsMap(enabled = true) {
  return useQuery({
    queryKey: riskKeys.offerings(),
    enabled,
    queryFn: async () => {
      type Row = { ticker: string; date: string; type: string; status: string; dealSizeM: number | null; dilutionPct: number | null };
      const j = await http.get<{ offerings: Row[] }>(`/api/offerings/watch`).catch(() => ({ offerings: [] as Row[] }));
      const map: Record<string, OfferingHit> = {};
      for (const o of j.offerings ?? []) {
        const t = o.ticker.toUpperCase();
        if (!map[t]) map[t] = { date: o.date, type: o.type, status: o.status, dealSizeM: o.dealSizeM, dilutionPct: o.dilutionPct };
      }
      return map;
    },
    staleTime: 10 * 60_000,
    retry: 0,
  });
}

// ─── the trader's trading day (intraday curve, trades list) ─────────────────

export type DayTradeRow = DayTrade & {
  date: string;
  gross: number | null;
  fees: number;
  setup: string | null;
  closeLabel: string | null;
  openLabel: string | null;
};

export type TraderDay = {
  /** Trading date shown: today when the trader has closed trades today, else the latest day in the last 10. */
  date: string | null;
  isToday: boolean;
  trades: DayTradeRow[];
  net: number | null;
  fees: number;
};

type RawTrade = {
  id: number; ticker: string | null; date: string | null; exitDate?: string | null; side: string | null; setup?: string | null;
  result?: string | null; pnl?: number | string | null; fees?: number | string | null; qty?: number | string | null;
  contextSnapshot?: { openedAt?: string | null; closedAt?: string | null } | null;
};

const hhmm = (s: string | null | undefined) => {
  const m = wallMinutes(s);
  return m == null ? null : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/** Pure: pick the day and map the rows (exported for checks). Net = gross − |fees| via lib/trade-math. */
export function buildTraderDay(raw: RawTrade[], today: string): TraderDay {
  const closed = raw.filter((t) => !isOpen(t) && closeDate(t) && (closeDate(t) as string).slice(0, 10) <= today);
  const dates = [...new Set(closed.map((t) => (closeDate(t) as string).slice(0, 10)))].sort();
  const date = dates.includes(today) ? today : dates[dates.length - 1] ?? null;
  const trades: DayTradeRow[] = date == null ? [] : closed
    .filter((t) => (closeDate(t) as string).slice(0, 10) === date)
    .map((t) => {
      const snap = t.contextSnapshot ?? null;
      const net = netPnl(t);
      return {
        id: t.id,
        ticker: String(t.ticker ?? ""),
        side: t.side ?? null,
        qty: tmNum(t.qty),
        net: net == null ? null : Math.round(net * 100) / 100,
        gross: tmNum(t.pnl),
        fees: feesOf(t),
        setup: t.setup ?? null,
        date,
        closeMin: wallMinutes(snap?.closedAt),
        openMin: wallMinutes(snap?.openedAt),
        closeLabel: hhmm(snap?.closedAt),
        openLabel: hhmm(snap?.openedAt),
      };
    })
    .sort((a, b) => (a.closeMin ?? Infinity) - (b.closeMin ?? Infinity) || a.id - b.id);
  const withNet = trades.filter((t) => t.net != null);
  return {
    date,
    isToday: date === today,
    trades,
    net: withNet.length ? Math.round(withNet.reduce((s, t) => s + (t.net ?? 0), 0) * 100) / 100 : null,
    fees: Math.round(trades.reduce((s, t) => s + t.fees, 0) * 100) / 100,
  };
}

/** Closed trades of the trader's current (or latest) trading day, NY date. GET /api/trades (touching window). */
export function useTraderDay(trader: string | null, enabled = true) {
  const today = nyDate();
  return useQuery({
    queryKey: ["risk", "day", trader ?? "", today] as const,
    enabled: enabled && !!trader,
    queryFn: async () => {
      const from = addDays(today, -10);
      const raw = await http.get<RawTrade[]>(`/api/trades?trader=${encodeURIComponent(trader ?? "")}&from=${from}&to=${today}`);
      return buildTraderDay(Array.isArray(raw) ? raw : [], today);
    },
    refetchInterval: REFRESH_MS,
    placeholderData: keepPreviousData,
  });
}

export type BehaviorFlags = {
  date: string;
  trades: number;
  /** Typical trades per day (median + k·MAD over 60 days), null when unknown. */
  norm: number | null;
  revenge: number;
  revengeCost: number | null;
  tilt: number;
  martingale: number;
  overtrading: boolean;
};

type BehaviorResp = {
  summary?: { trades?: number; tradesPerDayNorm?: number | null };
  patterns?: { key: string; n: number; net: number | null }[];
};

/**
 * Optional behaviour flags for one trading day from /api/behavior (raw fetch): revenge trades, tilt clusters,
 * size-up after loss, and trade count vs the trader's 60-day norm. Resolves to null when the API is unavailable.
 */
export function useBehaviorDay(trader: string | null, date: string | null, enabled = true) {
  return useQuery({
    queryKey: ["risk", "behavior", trader ?? "", date ?? ""] as const,
    enabled: enabled && !!trader && !!date,
    queryFn: async (): Promise<BehaviorFlags | null> => {
      const t = encodeURIComponent(trader ?? "");
      const d = date as string;
      const [day, hist] = await Promise.all([
        http.get<BehaviorResp>(`/api/behavior?trader=${t}&from=${d}&to=${d}`).catch(() => null),
        http.get<BehaviorResp>(`/api/behavior?trader=${t}&from=${addDays(d, -60)}&to=${d}`).catch(() => null),
      ]);
      if (!day) return null;
      const pat = (k: string) => day.patterns?.find((p) => p.key === k);
      const trades = day.summary?.trades ?? 0;
      const norm = hist?.summary?.tradesPerDayNorm ?? null;
      return {
        date: d,
        trades,
        norm,
        revenge: pat("revenge")?.n ?? 0,
        revengeCost: pat("revenge")?.net ?? null,
        tilt: pat("tilt")?.n ?? 0,
        martingale: pat("martingale")?.n ?? 0,
        overtrading: norm != null && trades > norm,
      };
    },
    staleTime: STALE.short,
    refetchInterval: REFRESH_MS,
    retry: 0,
  });
}

export type LimitsInput =Omit<RiskLimits, "trader" | "updatedBy" | "updatedAt"> & { reason?: string | null };

export function useSaveLimits(trader: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: LimitsInput) => {
      return http.put<RiskLimits>(`/api/risk/limits/${encodeURIComponent(trader)}`, body);
    },
    onSuccess: (saved) => {
      // optimistic-ish: patch desk row limits immediately, then refetch metrics
      qc.setQueryData<RiskDesk>(riskKeys.desk(), (old) =>
        old ? { ...old, traders: old.traders.map((t) => (t.trader === saved.trader ? { ...t, limits: saved } : t)) } : old,
      );
      qc.invalidateQueries({ queryKey: riskKeys.all });
    },
  });
}
