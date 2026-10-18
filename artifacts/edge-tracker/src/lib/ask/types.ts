/** Types of the Ask query parser (shared by parse, kit, phrases and the per-language rule books). */
import type { Correction } from "./prepare";

export type AskSide = "Long" | "Short";
export type AskOutcome = "win" | "loss" | "breakeven";
export type AskIntent =
  | "list" | "count" | "sum" | "avg" | "winrate" | "fees" | "pf" | "hold" | "size" | "drawdown"
  | "best" | "worst" | "compare" | "streak" | "insight";
export type AskDim =
  | "ticker" | "day" | "hour" | "weekday" | "month" | "week" | "side" | "trade" | "setup" | "slot" | "holdBucket" | "sizeBucket" | "trader";
export type AskMetric = "net" | "winRate" | "avg" | "n" | "fees" | "pf";
export type AskTokenKind =
  | "trader" | "ticker" | "setup" | "side" | "outcome" | "date" | "time" | "weekday" | "price" | "hold" | "qty" | "after" | "last"
  | "intent" | "group" | "compare" | "scope";

export interface AskToken {
  /** Unique within one query (kind + span start). */
  key: string;
  kind: AskTokenKind;
  /** Chip text: «Период: 01.10–31.10.2026» (UI language). */
  label: string;
  /** Short phrase used in the answer sentence: «в октябре», «после 11:00» (UI language). */
  phrase: string;
  /** The original text the rule consumed. */
  text: string;
  /** Span in the original string; -1 for derived tokens (not removable). */
  start: number;
  end: number;
}

export interface AskDateRange { from: string; to: string; phrase: string }
export interface AskTimeRange { fromMin: number | null; toMin: number | null; phrase: string }
export interface AskNumRange { min: number | null; max: number | null }
export interface AskAfter { kind: "win" | "loss"; n: number }

/** Every filter a query (or one side of a comparison) can carry. */
export interface AskFilter {
  trader: string | null;
  tickers: string[];
  setups: string[];
  side: AskSide | null;
  outcome: AskOutcome | null;
  date: AskDateRange | null;
  /** Entry time window in ET minutes since midnight; `toMin` exclusive. */
  time: AskTimeRange | null;
  /** 0 = Monday … 4 = Friday (close date). */
  weekdays: number[] | null;
  /** Entry price, USD. */
  price: AskNumRange | null;
  /** Hold time, seconds. */
  holdSec: AskNumRange | null;
  /** Position size, shares. */
  qty: AskNumRange | null;
  /** Previous trade(s) of the same trader on the same day were losses / wins. */
  after: AskAfter | null;
  /** Only the last N trades (after the other filters). */
  lastN: number | null;
}

export type AskCompareDim = "ticker" | "side" | "time" | "date" | "weekday" | "setup" | "trader" | "outcome";
export interface AskCompareSide { label: string; patch: Partial<AskFilter> }
export interface AskCompare { dim: AskCompareDim; a: AskCompareSide; b: AskCompareSide }

export interface AskQuery extends AskFilter {
  raw: string;
  /** Staff asked about the whole desk («все трейдеры», «по трейдерам»). */
  allTraders: boolean;
  intent: AskIntent;
  /** Subject of best/worst («лучший тикер» ⇒ ticker). */
  target: AskDim | null;
  groupBy: AskDim | null;
  metric: AskMetric;
  /** best/worst: how many rows the answer is about (1 = «лучший день», 5 = «худшие дни»). */
  topN: number;
  compare: AskCompare | null;
  /** streak: which streak and over what (trades or days). */
  streak: { kind: "win" | "loss" | null; unit: "trade" | "day" } | null;
  /** insight: «когда я теряю больше всего» (worst) / «когда я зарабатываю» (best). */
  insight: "best" | "worst" | null;
  tokens: AskToken[];
  /** Words the parser did not understand (original spelling). */
  unknown: string[];
  /** Typos / keyboard-layout fixes applied before parsing. */
  corrections: Correction[];
  /** At least one thing was understood. */
  ok: boolean;
}

export interface ParseContext {
  /** NY trading date YYYY-MM-DD (nyDate()). */
  today: string;
  /** Known trader names (staff can name a trader: «Ориф, MRK, 15 октября»). */
  traders?: readonly string[];
  /** Tickers present in the book (protects them from layout «fixes»). */
  tickers?: readonly string[];
  /** Setup names present in the book: matched as bare words («news», «gap and go»). */
  setups?: readonly string[];
}
