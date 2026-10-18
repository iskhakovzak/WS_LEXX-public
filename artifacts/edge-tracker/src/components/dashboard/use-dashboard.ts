// Dashboard data hooks. Every date is the New York trading date (@/lib/trading-date); every
// number comes from the API, which uses the shared trade math (net = gross − |fees|, signed R,
// win rate = W/(W+L), PF = ΣR⁺/|ΣR⁻|). Nothing here recomputes R or P&L.
import { useCallback, useEffect, useState } from "react";
import { dashboardI18n } from "@/i18n/ns/dashboard";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { http } from "@/lib/api/http";
import { apiErrorStatus, nullIfMissing } from "@/lib/api/errors";
import { POLL, STALE } from "@/lib/api/keys";
import { riskMeQuery } from "@/lib/api/queries";
import { nyDate } from "@/lib/trading-date";
import type { Horizon } from "@/lib/trade-math";

export type Scope = "me" | "team";
/** Server window of the dashboard equity curve (GET /api/dashboard/equity?period=). */
export type EquityPeriod = "week" | "30d" | "90d" | "ytd" | "all";
export type EquityMetric = "r" | "pnl";
export type { Horizon };

export type MiniTrade = {
  id: number;
  ticker: string;
  date: string;
  side?: string | null;
  setup?: string | null;
  result?: string | null;
  trader?: string | null;
  horizon?: Horizon;
};

export type OpenPosition = {
  id: number;
  ticker: string;
  date: string;
  side: string | null;
  setup: string | null;
  trader: string | null;
  horizon: Horizon;
  source: string | null;
  qty: number | null;
  riskUsd: number | null;
  entry: number | null;
  stop: number | null;
  /** Distance to stop as % of entry. */
  stopPct: number | null;
  daysHeld: number;
  nextEvent: { date: string; type: string | null } | null;
};

/** Aggregate block shared by today / week / horizon rows (net $ by default). */
export type Agg = {
  trades: number;
  closed: number;
  wins: number;
  losses: number;
  be: number;
  /** Net $ (= pnlNet); null when no trade in the window has P&L. */
  pnl: number | null;
  pnlNet: number | null;
  pnlGross: number | null;
  fees: number | null;
  pnlCount: number;
  r: number;
  rCount: number;
  winRate: number | null;
  expectancyR: number | null;
  profitFactorR: number | null;
};

export type Violation = {
  id: number;
  trader: string;
  severity: string;
  message: string;
  tradeId: number | null;
  ruleName: string | null;
  occurredAt?: string;
};

export type DashboardToday = {
  date: string;
  scope: Scope | "trader";
  trader: string | null;
  viewer: { name: string; staff: boolean };
  today: Agg & {
    opened: number;
    open: number;
    byHorizon: { horizon: Horizon; trades: number; pnl: number | null; pnlGross: number | null; fees: number | null; r: number }[] | null;
  };
  positions: OpenPosition[] | null;
  exposure: { open: number; carried: number; openRiskUsd: number | null; carriedRiskUsd: number } | null;
  week: Agg & {
    from: string;
    to: string;
    tradingDays: number;
    greenDays: number;
    days: { date: string; pnl: number | null; r: number; wins: number; losses: number }[];
  };
  attention: {
    openTrades: { count: number; items: MiniTrade[] };
    unreviewed: { count: number; items: MiniTrade[] };
    checkin: { done: boolean };
    draftIdeas: { count: number };
    ideasToReview: { count: number; items: { id: number; ticker: string; trader: string | null; side: string | null }[] };
    violations: { count: number; items: Violation[] };
    /** Staff only. */
    curatorQueue: { count: number; items: MiniTrade[] } | null;
  };
  gamePlan: {
    exists: boolean;
    id: number | null;
    bias: string | null;
    riskMode: string | null;
    inPlayCount: number;
    myReadAt: string | null;
    updatedAt: string | null;
  } | null;
  journal: { reviewed: boolean; traders: string[] } | null;
  sync: { lastSyncedAt: string | null; imported: number } | null;
  /** Additive (may be absent on an older API): tickers traded in the last 14 days + in-play watchlist. */
  myTickers?: string[];
  streaks: {
    current: { count: number; type: "win" | "loss" | "none" };
    bestWin: number;
    bestLoss: number;
    greenDays: number;
    checkinDays: number;
    recent: string[];
  };
  market: {
    nyDate: string;
    nyMinutes: number;
    session: string;
    weekend: boolean;
    holidayToday: string | null;
    holidays: { date: string; name: string }[];
  };
};

export type EquityDay = {
  date: string;
  trades: number;
  wins: number;
  losses: number;
  be: number;
  pnl: number | null;
  pnlGross: number | null;
  fees: number | null;
  r: number;
  cumPnl: number;
  cumPnlGross: number;
  cumR: number;
};

export type DashboardEquity = {
  period: EquityPeriod | "7d";
  scope: string;
  from: string;
  to: string;
  hasPnl: boolean;
  days: EquityDay[];
  totals: {
    trades: number;
    wins: number;
    losses: number;
    be: number;
    winRate: number | null;
    pnl: number | null;
    pnlGross: number | null;
    fees: number | null;
    r: number;
    expectancyR: number | null;
    profitFactorR: number | null;
    maxDrawdownR: number;
    maxDrawdownNet: number | null;
    tradingDays: number;
    greenDays: number;
    bestR: { date: string; r: number } | null;
    worstR: { date: string; r: number } | null;
    bestNet: { date: string; pnl: number } | null;
    worstNet: { date: string; pnl: number } | null;
  };
};

export type RecentTrade = {
  id: number;
  ticker: string;
  date: string;
  exitDate: string | null;
  closeDate: string;
  setup: string | null;
  side: string | null;
  result: string;
  trader: string | null;
  horizon: Horizon;
  source: string | null;
  /** Net $ (same as pnlNet). */
  pnl: number | null;
  pnlNet: number | null;
  pnlGross: number | null;
  fees: number;
  rMultiple: number | null;
  unreviewed: boolean;
  createdAt: string;
};

/** GET where 403 (section not for this role) and 404 / non-JSON (section not deployed) mean "not available" → null. */
function getOptional<T>(path: string, signal?: AbortSignal): Promise<T | null> {
  return http.get<T>(path, { signal }).catch((e: unknown) => (apiErrorStatus(e) === 403 ? null : nullIfMissing(e)));
}

function scopeQuery(scope: Scope) {
  return scope === "team" ? "scope=team" : "scope=me";
}

export function useDashboardToday(scope: Scope, enabled = true) {
  const date = nyDate();
  return useQuery({
    queryKey: ["/api/dashboard/today", { scope, date }],
    queryFn: ({ signal }) => http.get<DashboardToday>(`/api/dashboard/today?${scopeQuery(scope)}&date=${date}`, { signal }),
    staleTime: STALE.live,
    refetchOnWindowFocus: true,
    refetchInterval: POLL.twoMinutes,
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useDashboardEquity(scope: Scope, period: EquityPeriod, enabled = true) {
  const date = nyDate();
  return useQuery({
    queryKey: ["/api/dashboard/equity", { scope, period, date }],
    queryFn: ({ signal }) => http.get<DashboardEquity>(`/api/dashboard/equity?${scopeQuery(scope)}&period=${period}&date=${date}`, { signal }),
    staleTime: STALE.default,
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** Key starts with the generated recent-trades key so trade mutations invalidate it too. */
export function useRecentTrades(scope: Scope, enabled = true) {
  return useQuery({
    queryKey: ["/api/dashboard/recenttrades", { scope }],
    queryFn: ({ signal }) => http.get<RecentTrade[]>(`/api/dashboard/recenttrades?limit=8&${scopeQuery(scope)}`, { signal }),
    staleTime: STALE.default,
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
    enabled,
  });
}

/* ───────────── Other sections' endpoints (404 ⇒ hidden) ───────────── */

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

/** GET /api/risk/me (Risk desk). */
export type RiskMe = {
  trader: string;
  status: "ok" | "warn" | "breach" | "no_limits";
  halted: boolean;
  stop: { state: string; halted: boolean; label: string; message: string; dailyRemainingUsd: number | null };
  alerts: RiskAlert[];
  breaches: RiskAlert[];
  today: {
    pnlNet: number | null;
    fees: number;
    r: number;
    trades: number;
    openPositions: number;
    carriedPositions: number;
    carriedTonight: number;
    openRiskUsd: number;
    overnightExposureUsd: number;
    dailyLimitUsedPct: number | null;
    dailyRemainingUsd: number | null;
    dailyRemainingAfterOpenRiskUsd: number | null;
    source: string | null;
  };
  week: { from: string; pnlNet: number | null; r: number; trades: number; limitUsedPct: number | null; remainingUsd: number | null };
  drawdown: { currentUsd: number; maxUsd: number; limitUsedPct: number | null; remainingUsd: number | null; redDayStreak: number };
  limits: {
    dailyLossLimit: number | null;
    weeklyLossLimit: number | null;
    maxDrawdown: number | null;
    maxRiskPerTrade: number | null;
    maxOpenPositions: number | null;
    maxOvernightExposure: number | null;
    allowOvernight: boolean;
    allowSwing: boolean;
    tier: string | null;
    accountSize: number | null;
  } | null;
  dailyLossLimit: number | null;
  todayPnl: number | null;
};

/** Shares one cache entry with the risk page and the shell badge (lib/api/queries → riskMeQuery). */
export function useRiskMe(enabled = true) {
  return useQuery({
    ...riskMeQuery<RiskMe>(),
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: POLL.twoMinutes,
    enabled,
  });
}

/** GET /api/risk/desk (staff): one row per trader with limit status. */
export type RiskDeskRow = {
  trader: string;
  status: "ok" | "warn" | "breach" | "no_limits";
  halted: boolean;
  stop: { state: string; halted: boolean; label: string; message: string };
  today: RiskMe["today"];
  week: RiskMe["week"];
  limits: RiskMe["limits"];
  spark: number[];
  sparkUnit: "usd" | "r";
  lastTradeDate: string | null;
  role: string | null;
  banned: boolean;
};

export type RiskDesk = {
  date: string;
  summary: {
    traders: number;
    pnlNetToday: number | null;
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
  banner: { trader: string; state: string; label: string; message: string; halted: boolean }[];
  traders: RiskDeskRow[];
};

export function useRiskDesk(enabled: boolean) {
  return useQuery({
    queryKey: ["/api/risk/desk", { date: nyDate() }],
    queryFn: ({ signal }) => getOptional<RiskDesk>(`/api/risk/desk?date=${nyDate()}`, signal),
    staleTime: STALE.default,
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: POLL.twoMinutes,
    enabled,
  });
}

/** GET /api/eod/status — day close state per trader (404 ⇒ section not deployed). */
export type EodTraderStatus = {
  trader: string;
  status: "open" | "closed" | "reviewed";
  trades: number;
  reviewedTrades: number;
  missing: unknown[];
  closedAt: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  curatorScore: number | null;
  discipline: number | null;
};
export type EodStatus = { date: string; today: string; traders: EodTraderStatus[] };

export function useEodStatus(enabled = true) {
  const date = nyDate();
  return useQuery({
    queryKey: ["/api/eod/status", { date }],
    queryFn: ({ signal }) => getOptional<EodStatus>(`/api/eod/status?date=${date}`, signal),
    staleTime: STALE.short,
    retry: false,
    refetchOnWindowFocus: true,
    enabled,
  });
}

/** GET /api/propreports/status — live sync state (404 ⇒ integration not deployed). */
export type PropReportsStatus = {
  config?: { configured?: boolean; enabled?: boolean } | null;
  scheduler?: { running?: boolean; nextRunAt?: string | null } | null;
  accounts?: { total: number; mapped: number; unmapped: number; lastSyncedAt: string | null } | null;
  trades?: { imported: number; lastSyncedAt: string | null; legacyWithoutId?: number } | null;
  pendingCount?: number;
  lastRun?: { status?: string; finishedAt?: string | null; startedAt?: string | null; error?: string | null; imported?: number } | null;
};

export function usePropReportsStatus(enabled = true) {
  return useQuery({
    queryKey: ["/api/propreports/status"],
    queryFn: ({ signal }) => getOptional<PropReportsStatus>("/api/propreports/status", signal),
    staleTime: STALE.short,
    retry: false,
    refetchOnWindowFocus: true,
    enabled,
  });
}

/** GET /api/events/today — market events today (+ earnings), flagged by my positions / trades. */
export type TodayEvent = {
  id: number;
  ticker: string | null;
  date: string;
  eventType: string | null;
  headline: string | null;
  session: string | null;
  tradesToday: number;
  holding: boolean;
};
export type TodayEarnings = { ticker: string; date: string; session: string | null; company: string | null; epsEstimate: number | null };
export type EventsToday = { date: string; events: TodayEvent[]; earnings: TodayEarnings[] | null };

export function useEventsToday(enabled = true) {
  const date = nyDate();
  return useQuery({
    queryKey: ["/api/events/today", { date }],
    queryFn: ({ signal }) => getOptional<EventsToday>(`/api/events/today?date=${date}`, signal),
    staleTime: STALE.long,
    retry: false,
    enabled,
  });
}

/** Day-close state of one trader on one date (GET /api/eod/status?date&trader). */
export function useEodDay(date: string | null, trader: string | null, enabled = true) {
  return useQuery({
    queryKey: ["/api/eod/status", { date, trader }],
    queryFn: ({ signal }) => getOptional<EodStatus>(`/api/eod/status?date=${date}&trader=${encodeURIComponent(trader ?? "")}`, signal),
    staleTime: STALE.short,
    retry: false,
    enabled: enabled && !!date && !!trader,
  });
}

/* ───────────── Local, per-viewer preferences ───────────── */

export type SectionId =
  | "attention"
  | "equity"
  | "recent"
  | "desk"
  | "streaks"
  | "positions"
  | "checkin"
  | "brief"
  | "quote"
  | "sectors"
  | "macro"
  | "dna"
  | "psychology";

const SECTION_FLAGS: Record<SectionId, { staffOnly?: boolean; extra?: boolean }> = {
  attention: {}, equity: {}, recent: {}, desk: { staffOnly: true }, streaks: {}, positions: {},
  // Optional extras below the cockpit — off by default, switch on in «Настроить».
  checkin: { extra: true }, brief: { extra: true }, quote: { extra: true }, sectors: { extra: true },
  macro: { extra: true }, dna: { extra: true }, psychology: { extra: true },
};

/** Label / hint are read in the current language on access; flags are plain. */
export const SECTION_META: Record<SectionId, { label: string; hint: string; staffOnly?: boolean; extra?: boolean }> = Object.fromEntries(
  (Object.keys(SECTION_FLAGS) as SectionId[]).map((id) => [id, {
    ...SECTION_FLAGS[id],
    get label() { return dashboardI18n.t(`sections.${id}.label`); },
    get hint() { return dashboardI18n.t(`sections.${id}.hint`); },
  }]),
) as Record<SectionId, { label: string; hint: string; staffOnly?: boolean; extra?: boolean }>;

export const DEFAULT_ORDER: SectionId[] = [
  "attention",
  "equity",
  "recent",
  "desk",
  "streaks",
  "positions",
  "checkin",
  "brief",
  "sectors",
  "macro",
  "dna",
  "quote",
  "psychology",
];

/** Width class of a block in the 12-col bento: pairs sit side by side, `full` takes the row. */
export const SECTION_WIDTH: Record<SectionId, "wide" | "narrow" | "full"> = {
  attention: "narrow",
  equity: "wide",
  recent: "wide",
  desk: "narrow",
  streaks: "narrow",
  positions: "full",
  checkin: "wide",
  brief: "full",
  quote: "narrow",
  sectors: "wide",
  macro: "narrow",
  dna: "narrow",
  psychology: "full",
};

export type DashboardPrefs = {
  order: SectionId[];
  hidden: SectionId[];
  scope: Scope;
  period: EquityPeriod;
  metric: EquityMetric;
};

const PREFS_KEY = "ws_lexx_dashboard_prefs_v5";
/** Previous layout (bundled «ritual» / «market» blocks): migrated once — scope/period/metric/order kept, new defaults hidden. */
const LEGACY_PREFS_KEY = "ws_lexx_dashboard_prefs_v4";
const LEGACY_SPLIT: Record<string, SectionId[]> = { ritual: ["checkin", "brief", "quote"], market: ["sectors", "macro", "dna"] };

/** Sensible defaults: the cockpit on top, extras off (traders keep the morning check-in); staff see the desk instead of streaks. */
function defaultPrefs(scope: Scope): DashboardPrefs {
  const extras = DEFAULT_ORDER.filter((id) => SECTION_META[id].extra && (scope === "team" || id !== "checkin"));
  return {
    order: DEFAULT_ORDER,
    hidden: scope === "team" ? ["streaks", ...extras] : extras,
    scope,
    period: "week",
    metric: "pnl",
  };
}

const PERIODS: EquityPeriod[] = ["week", "30d", "90d", "ytd", "all"];

function expandLegacy(ids: unknown[]): string[] {
  return ids.flatMap((x) => (typeof x === "string" && LEGACY_SPLIT[x] ? LEGACY_SPLIT[x] : [x as string]));
}

function sanitize(raw: unknown, fallbackScope: Scope, legacy = false): DashboardPrefs {
  const base = defaultPrefs(fallbackScope);
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Partial<DashboardPrefs>;
  const known = new Set<SectionId>(DEFAULT_ORDER);
  const rawOrder = Array.isArray(r.order) ? (legacy ? expandLegacy(r.order) : r.order) : [];
  const order = rawOrder.filter((x): x is SectionId => known.has(x as SectionId));
  for (const id of DEFAULT_ORDER) if (!order.includes(id)) order.push(id);
  const rawHidden = Array.isArray(r.hidden) ? (legacy ? expandLegacy(r.hidden) : r.hidden) : null;
  const userHidden = rawHidden ? rawHidden.filter((x): x is SectionId => known.has(x as SectionId)) : base.hidden;
  // Legacy layouts were saved with everything on; apply the decluttered defaults on top of what the user hid.
  const hidden = legacy ? Array.from(new Set([...base.hidden, ...userHidden])) : userHidden;
  return {
    order: Array.from(new Set(order)),
    hidden,
    scope: r.scope === "team" || r.scope === "me" ? r.scope : fallbackScope,
    period: PERIODS.includes(r.period as EquityPeriod) ? (r.period as EquityPeriod) : base.period,
    metric: r.metric === "r" ? "r" : "pnl",
  };
}

function loadPrefs(key: string, legacyKey: string, fallbackScope: Scope): DashboardPrefs {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return sanitize(JSON.parse(raw), fallbackScope);
    const old = localStorage.getItem(legacyKey);
    return sanitize(old ? JSON.parse(old) : null, fallbackScope, true);
  } catch {
    return sanitize(null, fallbackScope);
  }
}

/** Prefs are keyed by the signed-in identity, so two people on one browser do not share a layout. */
export function useDashboardPrefs(fallbackScope: Scope, viewerKey: string | null) {
  const key = `${PREFS_KEY}:${viewerKey ?? "guest"}`;
  const legacyKey = `${LEGACY_PREFS_KEY}:${viewerKey ?? "guest"}`;
  const [prefs, setPrefs] = useState<DashboardPrefs>(() => loadPrefs(key, legacyKey, fallbackScope));

  // Identity changed (login/logout) → reload that viewer's prefs.
  useEffect(() => {
    setPrefs(loadPrefs(key, legacyKey, fallbackScope));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(prefs));
    } catch {
      /* storage unavailable — prefs live for this session only */
    }
  }, [prefs, key]);

  const update = useCallback((patch: Partial<DashboardPrefs>) => setPrefs((p) => ({ ...p, ...patch })), []);
  const reset = useCallback(() => setPrefs(defaultPrefs(fallbackScope)), [fallbackScope]);
  return { prefs, update, reset };
}
