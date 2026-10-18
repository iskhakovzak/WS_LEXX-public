// Shapes returned by GET /api/trades/:id/quality and /api/trade-quality?ids=… (server: lib/tradeQuality.ts, v2).
import { chartI18n } from "@/i18n/ns/chart";

export type Excursion = {
  perShare: number;
  r: number | null;
  usd: number | null;
  /** Epoch seconds of the extreme: the fill instant when the extreme is a fill price, else the bar time. */
  at: number;
  /** Whole minutes from entry (legacy, rounded down); prefer `seconds`. */
  minutes: number;
  /** Seconds from the entry fill to the extreme (v2; absent on v1 cache rows). */
  seconds?: number;
  bars: number;
  price: number;
};

export type QualityReason =
  | "no_bars" | "no_entry" | "open_position" | "fills_placed_by_price" | "qty_assumed" | "no_bars_after_exit"
  | "coarse_bars" | "no_stop" | "no_risk" | "exit_not_in_bars" | "entry_not_in_bars" | "atr_from_day_range" | "no_atr";

export type TradeQuality = {
  version: 1 | 2;
  status: "ok" | "partial" | "unavailable";
  reasons: QualityReason[];
  interval: string;
  barsUsed: number;
  side: "long" | "short";
  qty: number | null;
  qtyAssumed: boolean;
  avgEntry: number | null;
  avgExit: number | null;
  stop: number | null;
  riskPerShare: number | null;
  riskSource: "stop" | "riskUsd" | null;
  /** Entry / exit instants (epoch s): the fill times when the fills are timed, else bar times. */
  entryAt: number | null;
  exitAt: number | null;
  holdMinutes: number | null;
  /** Exact hold (v2): last exit fill − first entry fill in seconds; bar-based when fills are untimed. */
  holdSeconds?: number | null;
  /** v2: fills carried their own timestamps, so the opening/closing bars were cut at the fill (partial-bar rule). */
  timedFills?: boolean;
  mfe: Excursion | null;
  mae: Excursion | null;
  captured: { perShare: number; r: number | null; usd: number | null } | null;
  unrealised: { perShare: number; r: number | null; usd: number | null } | null;
  exitEfficiency: number | null;
  rangeEfficiency: number | null;
  leftOnTable: { perShare: number; r: number | null; usd: number | null; windowMinutes: number; bars: number; bestPrice: number; at: number; toCloseOfDay: number | null } | null;
  entryEfficiency: number | null;
  heat: { perShare: number; r: number | null; usd?: number | null; workedAtMinutes: number | null; workedAtSeconds?: number | null; threshold: "1R" | "mfe" } | null;
  stopAtr: { atr: number; source: "trade" | "dayRange"; distanceAtr: number } | null;
  gaps: { count: number; worstPerShare: number | null; worstR: number | null; list: { day: string; perShare: number; r: number | null }[] } | null;
  placement: "time" | "price" | "mixed";
  fillsUsed: number;
};

export type QualityRecord = {
  tradeId: number;
  afterExitMinutes: number;
  computedAt: string;
  cached: boolean;
  window: { from: string; to: string; interval: string; daysLoaded: number; fromCacheOnly?: boolean } | null;
  quality: TradeQuality;
};

export type QualityBatchResponse = {
  afterExitMinutes: number;
  items: QualityRecord[];
  pending: number[];
  version: number;
};

/** Why the quality is partial / unavailable, in the UI language. */
export function reasonLabel(r: QualityReason): string {
  return chartI18n.tryT(`quality.reason.${r}`) ?? r;
}

export const DEFAULT_AFTER_EXIT = 30;
export const AFTER_EXIT_OPTIONS = [15, 30, 60, 120] as const;
