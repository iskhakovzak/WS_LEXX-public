import { http, ApiError } from "@/lib/api/http";
import { KEYS } from "@/lib/api/keys";
import { gpI18n } from "@/i18n/ns/gamePlan";
import { nyDate } from "@/lib/trading-date";
import type { Tone } from "@/components/ds";

export type MarketBias = "bull" | "bear" | "neutral" | "mixed";
export type TickerBias = "bull" | "bear" | "neutral";
export type Horizon = "intraday" | "overnight" | "swing";
export type RiskMode = "normal" | "reduced" | "aggressive";
export type Grade = "A+" | "A" | "B";
export type Impact = "high" | "medium" | "low";

export type LevelSet = { support: number[]; resistance: number[]; note?: string };

/** Screenshot attached to a plan (bytes live in /api/plan-media/:id). */
export type MediaRef = { id: number; caption: string };

export type InPlayItem = {
  ticker: string;
  catalyst: string;
  bias: TickerBias;
  grade?: Grade | null;
  levels: { support: number[]; resistance: number[] };
  plan: string;
  horizon: Horizon;
  risk_note: string;
  // Added in the media/scenarios pass — older plans don't have them, read defensively.
  scenarioA?: string;
  scenarioB?: string;
  trigger?: string;
  invalidation?: string;
  tvLink?: string;
  media?: MediaRef[];
};

export type MacroItem = { time: string; title: string; impact: Impact };

export type GamePlan = {
  id: number;
  date: string;
  author: string;
  updatedBy: string | null;
  marketView: string;
  bias: MarketBias;
  riskMode: RiskMode;
  keyLevels: { SPY?: LevelSet; QQQ?: LevelSet };
  inPlay: InPlayItem[];
  riskNotes: string;
  macro: MacroItem[];
  focus?: string;
  maxLossUsd?: number | null;
  maxTrades?: number | null;
  media?: MediaRef[];
  tvLinks?: string[];
  createdAt: string;
  updatedAt: string;
  readCount: number;
};

/** The writable part of a plan — same shape for the desk plan and a personal plan. */
export type PlanDoc = {
  marketView: string;
  bias: MarketBias;
  riskMode: RiskMode;
  keyLevels: { SPY?: LevelSet; QQQ?: LevelSet };
  inPlay: InPlayItem[];
  riskNotes: string;
  macro: MacroItem[];
  focus: string;
  maxLossUsd: number | null;
  maxTrades: number | null;
  media: MediaRef[];
  tvLinks: string[];
  /** Personal plan only: rule of the day = a daily-loop MistakeId; absent = never chosen (prefilled with the focus), null = none. */
  ownRule?: string | null;
};

export type PlanStatus = "draft" | "ready";
export type TraderPlan = {
  id: number;
  trader: string;
  date: string;
  status: PlanStatus;
  doc: Partial<PlanDoc>;
  createdAt: string;
  updatedAt: string;
};
export type MyPlanResponse = { date: string; plan: TraderPlan | null; prevDate: string | null };
export type TraderPlansResponse = { date: string; team: boolean; plans: TraderPlan[]; missing: string[] };

export type PlanTemplate = {
  id: number;
  author: string;
  kind: "desk" | "personal";
  name: string;
  doc: Partial<PlanDoc>;
  shared: boolean;
  createdAt: string;
};

export type GamePlanResponse = {
  date: string;
  today: string;
  plan: GamePlan | null;
  myReadAt: string | null;
  prevDate: string | null;
  nextDate: string | null;
};

export type GamePlanSummary = {
  id: number;
  date: string;
  author: string;
  bias: MarketBias;
  riskMode: RiskMode;
  marketView: string;
  tickers: string[];
  inPlayCount: number;
  macroCount: number;
  mediaCount?: number;
  readCount: number;
  updatedAt: string;
};

export type ReadsResponse = {
  planId: number;
  total: number;
  readCount: number;
  read: { trader: string; role: string; readAt: string; stale: boolean }[];
  unread: { trader: string; role: string }[];
};

export type PlanPayload = PlanDoc;

// ── API ───────────────────────────────────────────────────────────────────────
/** An API build without the game-plan routes answers a bare 404 → a readable message (UI matches «не подключён»). */
function notDeployed(e: unknown): never {
  if (e instanceof ApiError && e.status === 404 && !e.field("error")) {
    throw new ApiError({ status: 404, code: e.code, message: gpI18n.t("labels.notDeployed"), body: e.body, method: e.method, url: e.url });
  }
  throw e;
}

export const gpKeys = {
  day: (date: string) => ["game-plan", "day", date] as const,
  history: ["game-plan", "history"] as const,
  reads: (id: number) => ["game-plan", "reads", id] as const,
  my: (date: string) => KEYS.myPlan(date),
  traders: (date: string) => ["game-plan", "traders", date] as const,
  templates: (kind: "desk" | "personal") => ["game-plan", "templates", kind] as const,
};

export const gpApi = {
  day: (date: string) => http.get<GamePlanResponse>("/api/game-plan", { query: { date } }).catch(notDeployed),
  history: (limit = 90) => http.get<GamePlanSummary[]>("/api/game-plan/history", { query: { limit } }).catch(notDeployed),
  reads: (id: number) => http.get<ReadsResponse>(`/api/game-plan/${id}/reads`).catch(notDeployed),
  save: (date: string, body: PlanPayload) => http.put<GamePlan>(`/api/game-plan/${encodeURIComponent(date)}`, body).catch(notDeployed),
  remove: (date: string) => http.del<{ ok: true }>(`/api/game-plan/${encodeURIComponent(date)}`).catch(notDeployed),
  markRead: (id: number) => http.post<{ readAt: string }>(`/api/game-plan/${id}/read`).catch(notDeployed),
  my: (date: string) => http.get<MyPlanResponse>("/api/game-plan/my", { query: { date } }).catch(notDeployed),
  saveMy: (date: string, body: PlanDoc & { status: PlanStatus }, signal?: AbortSignal) =>
    http.put<TraderPlan>(`/api/game-plan/my/${encodeURIComponent(date)}`, body, { signal }).catch(notDeployed),
  traders: (date: string) => http.get<TraderPlansResponse>("/api/game-plan/traders", { query: { date } }).catch(notDeployed),
  templates: (kind: "desk" | "personal") => http.get<PlanTemplate[]>("/api/game-plan/templates", { query: { kind } }).catch(notDeployed),
  saveTemplate: (body: { name: string; kind: "desk" | "personal"; shared?: boolean; doc: PlanDoc }) =>
    http.post<PlanTemplate>("/api/game-plan/templates", body).catch(notDeployed),
  removeTemplate: (id: number) => http.del<{ ok: true }>(`/api/game-plan/templates/${id}`).catch(notDeployed),
};

// ── Dates (desk calendar = New York) ──────────────────────────────────────────
/** Today on the desk calendar (America/New_York). */
export function nyToday(): string {
  return nyDate();
}

export function isIsoDate(v: string | null | undefined): v is string {
  return !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v + "T00:00:00Z"));
}

/** Shift by trading days (skips Sat/Sun). */
export function shiftTradingDay(date: string, dir: 1 | -1): string {
  const d = new Date(date + "T12:00:00Z");
  do {
    d.setUTCDate(d.getUTCDate() + dir);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

/** Local Date at noon for display formatting (avoids TZ off-by-one). */
export function dateObj(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d, 12);
}

// ── Labels / tones ────────────────────────────────────────────────────────────
// Labels are getters: they read the current UI language at render time (never frozen at module load).
const L = (key: Parameters<typeof gpI18n.t>[0]) => gpI18n.t(key);
export const MARKET_BIAS: Record<MarketBias, { readonly label: string; tone: Tone }> = {
  bull: { get label() { return L("labels.bias.bull"); }, tone: "up" },
  bear: { get label() { return L("labels.bias.bear"); }, tone: "down" },
  neutral: { get label() { return L("labels.bias.neutral"); }, tone: "neutral" },
  mixed: { get label() { return L("labels.bias.mixed"); }, tone: "warn" },
};
export const TICKER_BIAS: Record<TickerBias, { readonly label: string; tone: Tone }> = {
  bull: { get label() { return L("labels.tickerBias.bull"); }, tone: "up" },
  bear: { get label() { return L("labels.tickerBias.bear"); }, tone: "down" },
  neutral: { get label() { return L("labels.tickerBias.neutral"); }, tone: "neutral" },
};
export const HORIZON: Record<Horizon, { readonly label: string; tone: Tone; readonly hint: string }> = {
  intraday: { get label() { return L("labels.horizon.intraday"); }, tone: "accent", get hint() { return L("labels.horizon.intradayHint"); } },
  overnight: { get label() { return L("labels.horizon.overnight"); }, tone: "warn", get hint() { return L("labels.horizon.overnightHint"); } },
  swing: { get label() { return L("labels.horizon.swing"); }, tone: "purple", get hint() { return L("labels.horizon.swingHint"); } },
};
export const RISK_MODE: Record<RiskMode, { readonly label: string; tone: Tone; readonly hint: string }> = {
  normal: { get label() { return L("labels.riskMode.normal"); }, tone: "neutral", get hint() { return L("labels.riskMode.normalHint"); } },
  reduced: { get label() { return L("labels.riskMode.reduced"); }, tone: "warn", get hint() { return L("labels.riskMode.reducedHint"); } },
  aggressive: { get label() { return L("labels.riskMode.aggressive"); }, tone: "up", get hint() { return L("labels.riskMode.aggressiveHint"); } },
};
export const IMPACT: Record<Impact, { readonly label: string; tone: Tone }> = {
  high: { get label() { return L("labels.impact.high"); }, tone: "down" },
  medium: { get label() { return L("labels.impact.medium"); }, tone: "warn" },
  low: { get label() { return L("labels.impact.low"); }, tone: "neutral" },
};
