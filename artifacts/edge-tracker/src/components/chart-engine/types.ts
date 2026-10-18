/**
 * WS Chart — shared types. Pure data shapes, no React / DOM.
 */
import { chartI18n } from "@/i18n/ns/chart";

/** One OHLCV bar. `t` is a UTC epoch in seconds (as served by /api/candles). */
export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

/** Aggregated bar: same shape + number of base bars folded in. */
export type Bar = Candle & { n: number };

export type Timeframe = "1m" | "2m" | "3m" | "5m" | "15m" | "1h" | "D";

export const TIMEFRAMES: readonly Timeframe[] = ["1m", "2m", "3m", "5m", "15m", "1h", "D"];
export const TF_SECONDS: Record<Timeframe, number> = { "1m": 60, "2m": 120, "3m": 180, "5m": 300, "15m": 900, "1h": 3600, D: 86400 };
/** Chip label of a timeframe in the UI language («1м» / «1m»); getters, so every read follows the current language. */
export const TF_LABEL: Readonly<Record<Timeframe, string>> = {
  get "1m"() { return chartI18n.t("tf.1m"); },
  get "2m"() { return chartI18n.t("tf.2m"); },
  get "3m"() { return chartI18n.t("tf.3m"); },
  get "5m"() { return chartI18n.t("tf.5m"); },
  get "15m"() { return chartI18n.t("tf.15m"); },
  get "1h"() { return chartI18n.t("tf.1h"); },
  get D() { return chartI18n.t("tf.D"); },
};

/** Interval names the candles API speaks. */
export type ApiInterval = "1m" | "5m" | "15m" | "30m" | "60m" | "1d";
export const API_INTERVAL_SECONDS: Record<ApiInterval, number> = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "60m": 3600, "1d": 86400 };

export type Session = "pre" | "rth" | "post" | "closed";

export type Side = "long" | "short";

export type ExecutionKind = "entry" | "add" | "trim" | "exit" | "stop";

/**
 * What a fill did in the trade, as recognised by the API (api-server lib/tradeStructure):
 * Вход · Перезаход · Переворот · Добор · Частичный фикс · Выход · Стоп.
 */
export type TradeRole = "entry" | "reentry" | "flip" | "add" | "partial_exit" | "exit" | "stop";

/** One leg of the structure (fills of one order filled in pieces form one leg). Sizes / $ are null for others' trades. */
export type StructureLeg = {
  index: number;
  role: TradeRole;
  label: string;
  opening: boolean;
  executionIds: number[];
  pieces: number;
  price: number;
  qty: number | null;
  at: string | null;
  atEnd: string | null;
  positionBefore: number | null;
  positionAfter: number | null;
  avgAfter: number | null;
  fraction: number | null;
  perShare: number | null;
  realized: number | null;
  r: number | null;
  inferred: boolean;
  reason: string | null;
};

export type StructureStats = {
  source: "fills" | "report" | "manual";
  fidelity: "fills" | "averages";
  side: Side;
  legs: number;
  entries: number;
  adds: number;
  partials: number;
  exits: number;
  splitFills: number;
  avgEntry: number | null;
  avgExit: number | null;
  maxPosition: number | null;
  openQty: number | null;
  realized: number | null;
  rTotal: number | null;
  riskPerShare: number | null;
  stopPrice: number | null;
  stopHit: boolean;
  stopInferred: boolean;
  stopReason: string | null;
  reentryIndex: number;
  prevId: number | null;
  nextId: number | null;
  flipIn: boolean;
  flipOut: boolean;
  carriedIn: boolean;
  scaledEntryLikely: boolean;
  scaledExitLikely: boolean;
  firstAt: string | null;
  lastAt: string | null;
  notes: string[];
  /** One Russian line: «вход частями · перезаход №1» (absent on older servers). */
  summary?: string;
};

/** Another trade of the same ticker and session (re-entries / flips), with its legs for the chart. */
export type SiblingTrade = {
  id: number;
  side: Side;
  reentryIndex: number;
  isCurrent: boolean;
  summary: string;
  legs: { role: TradeRole; label: string; price: number; at: string | null; opening: boolean }[];
};

export type TradeStructureDto = { legs: StructureLeg[]; stats: StructureStats; siblings: SiblingTrade[] };

/** GET /api/trades/:id/executions. `structure` is null when the API could not compute it (older servers: absent). */
export type ExecutionsResponse = { tradeId: number; executions: Execution[]; structure?: TradeStructureDto | null };

/** Execution as served by GET /api/trades/:id/executions (numbers arrive as strings). */
export type Execution = {
  id: number;
  tradeId?: number;
  kind: ExecutionKind;
  price: string | number;
  qty: string | number | null;
  executedAt: string | null;
  note?: string | null;
  sortOrder?: number;
  /** Recognised role (absent on older servers — then derived from `kind`). */
  role?: TradeRole | null;
  roleLabel?: string | null;
  roleInferred?: boolean;
  legIndex?: number | null;
};

/** A fill resolved onto a bar series. */
export type Fill = {
  id: number;
  kind: ExecutionKind;
  price: number;
  /** Shares; null when the journal has no quantity for this execution. */
  qty: number | null;
  /** Exact execution instant (epoch seconds) or null when only a price is known. */
  time: number | null;
  /** Index of the bar the fill belongs to. */
  idx: number;
  /** True when the fill was placed by price match (no timestamp). */
  byPrice: boolean;
  label: string;
  /** What the fill did (Вход / Добор / Частичный фикс / …). */
  role: TradeRole;
  /** The role is a heuristic guess (a stop without a known stop level). */
  inferred: boolean;
  /** Fills of one order folded into this marker (> 1 = filled in pieces). */
  pieces: number;
  /** The structure leg behind this marker, when the API sent one. */
  leg: StructureLeg | null;
};

/** The subset of the journal trade the engine needs. Matches `Trade` from @workspace/api-client-react structurally. */
export type TradeLike = {
  id: number;
  ticker: string;
  date: string;
  side?: string | null;
  entry?: number | string | null;
  exit?: number | string | null;
  stop?: number | string | null;
  qty?: number | null;
  pnl?: number | null;
  fees?: number | null;
  riskUsd?: number | null;
  result?: string | null;
  horizon?: string | null;
  exitDate?: string | null;
  contextSnapshot?: unknown;
  /** First entry / last exit fill time (ISO) when the caller already knows them (used when executions are unavailable). */
  entryTime?: string | null;
  exitTime?: string | null;
  /** Owner of the trade (shown in pickers). */
  trader?: string | null;
  /**
   * Set by the API when the viewer may not see this trade's money (another trader's trade): $ fields arrive as null
   * and the chart shows per-share moves and R only — it never re-derives $.
   */
  redacted?: boolean | null;
};

export type PositionPoint = {
  idx: number;
  t: number;
  /** Open quantity after this bar's fills. */
  qty: number;
  /** Average entry price of the open quantity (null when flat). */
  avg: number | null;
  /** Unrealised P&L in $ marked at the bar close. */
  unrealized: number;
  /** Realised P&L in $ so far (partial exits). */
  realized: number;
  /** unrealized + realized. */
  total: number;
};

export type PositionState = {
  qty: number;
  avg: number | null;
  realized: number;
  unrealized: number | null;
  total: number | null;
  fillsSoFar: number;
  /** True when quantities were unknown and $ figures are scaled by the trade qty. */
  qtyAssumed: boolean;
};

export type ExcursionResult = {
  /** Per-share figures (≥ 0). */
  mfe: number;
  mae: number;
  mfeUsd: number | null;
  maeUsd: number | null;
  /** Percent of the average entry. */
  mfePct: number | null;
  maePct: number | null;
  /** In R — only when a risk per share is known. */
  mfeR: number | null;
  maeR: number | null;
  mfeAt: number | null;
  maeAt: number | null;
  mfePrice: number | null;
  maePrice: number | null;
  /** True when the entry/exit bar's range before/after the fill had to be excluded. */
  approximate: boolean;
  barsUsed: number;
};

export type VwapPoint = { t: number; vwap: number; sd: number };

export type DayLevels = {
  pdh: number | null;
  pdl: number | null;
  pdc: number | null;
  pmh: number | null;
  pml: number | null;
  open: number | null;
  orb5: { h: number; l: number } | null;
  orb15: { h: number; l: number } | null;
};

export type ProfileRow = { price: number; vol: number };
export type VolumeProfile = {
  rows: ProfileRow[];
  binSize: number;
  poc: number | null;
  vah: number | null;
  val: number | null;
  maxVol: number;
  totalVol: number;
};

export type MarketEventLite = {
  id: number;
  ticker: string;
  date: string;
  eventType?: string | null;
  headline: string;
  session?: string | null;
};

export type DrawingType = "hline" | "trend" | "rect" | "fib";
export type DrawingPoint = { time: number; price: number };
export type Drawing = {
  id: string;
  type: DrawingType;
  points: DrawingPoint[];
  color?: string;
  createdAt: number;
};

export type ChartMode = "analysis" | "replay" | "training";

/**
 * One finished training attempt (paper trading over a past session with the future hidden). Money is the trainee's
 * own paper size — never another trader's $. Stored per browser (see lib/training-sim TRAINING_HISTORY_KEY).
 */
export type TrainingResult = {
  at: number;
  tradeId: number;
  ticker: string;
  day: string;
  /** 0–100: share of the best possible move in the watched bars that the trainee captured. */
  score: number | null;
  pnlUsd: number;
  r: number | null;
  perShare: number | null;
  /** Trainee per share − the real trade per share (null when either is unknown). */
  vsRealPerShare: number | null;
  trades: number;
  /** Task source («mine» / «desk» / «day»); tradeId is 0 for a ticker-day task. Absent in older records. */
  source?: "mine" | "desk" | "day";
  /** The real trade per share and in R (null / absent when there was no trade or no stop). */
  realPerShare?: number | null;
  realR?: number | null;
};

export type SparkPoint = { x: number; y: number };
export type SparkData = {
  closes: number[];
  times: number[];
  entryIdx: number | null;
  exitIdx: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  side: Side;
  min: number;
  max: number;
};
