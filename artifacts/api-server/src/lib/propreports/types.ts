/**
 * PropReports integration — shared types.
 *
 * A Fill is one execution (one row of the PropReports Fills CSV / `fills` API action).
 * A RoundTrip is what the journal calls a trade: per account+symbol, position 0 → ≠0 → 0
 * (or still open at the end of the data). Scale-ins / partial exits become executions.
 */

export type FillSide = "B" | "S" | "T" | "C"; // Buy, Sell, Short, Cover (PropReports B/S codes)

export const FEE_KEYS = ["comm", "ecn", "sec", "orf", "taf", "nfa", "cat", "nscc", "acc", "clr", "misc"] as const;
export type FeeKey = (typeof FEE_KEYS)[number];
/** Canonical keys (FEE_KEYS) plus any extra fee column detected in the file (slug of its header, see fees.ts). */
export type FeeBreakdown = Record<string, number>;

/** Fee column labels (codes as is); the localized ones (comm / clr / misc) come from the `propreports` namespace `fee.*` via feeLabel(). */
export const FEE_LABEL_RU: Record<FeeKey, string> = {
  comm: "Комиссия", // i18n-ignore (RU fallback; display via feeLabel → propreports fee.comm)
  ecn: "ECN",
  sec: "SEC",
  orf: "ORF",
  taf: "TAF",
  nfa: "NFA",
  cat: "CAT",
  nscc: "NSCC",
  acc: "Access",
  clr: "Клиринг", // i18n-ignore (RU fallback; fee.clr)
  misc: "Прочее", // i18n-ignore (RU fallback; fee.misc)
};

export interface Fill {
  /** Naive Eastern Time "YYYY-MM-DD HH:MM:SS[.mmm]" exactly as PropReports exports it. */
  dateTime: string;
  /** Account display name (Fills CSV "Account") or trading id ("Account Name"). */
  account: string;
  side: FillSide;
  qty: number;
  symbol: string;
  price: number;
  route: string | null;
  fees: FeeBreakdown;
  /** Session date assigned by PropReports (may differ from dateTime for overnight sessions). */
  tradeDate: string;
  orderId: string | null;
  fillId: string | null;
  propReportsId: string | null;
  status: string | null;
  /** 0-based source line for diagnostics. */
  line: number;
}

export type ExecutionKind = "entry" | "add" | "trim" | "exit";

export interface RoundTripExecution {
  kind: ExecutionKind;
  side: FillSide;
  qty: number;
  price: number;
  /** ISO-like naive ET "YYYY-MM-DDTHH:MM:SS" */
  at: string;
  fees: number;
  /** Per-column share of this execution's fees (same keys as RoundTrip.fees). */
  feesByType?: FeeBreakdown;
  fillId: string | null;
  /** Broker order id — fills of one order filled in pieces share it (lib/tradeStructure folds them into one leg). */
  orderId?: string | null;
}

export type Horizon = "intraday" | "overnight" | "swing";
export type Session = "premarket" | "regular" | "postmarket";
export type TripResult = "win" | "loss" | "breakeven" | "open";

export interface RoundTrip {
  /** Deterministic key: `${account}|${symbol}|${openedAt}|${side}` (+ `#n` on same-second collisions). */
  externalId: string;
  account: string;
  symbol: string;
  side: "Long" | "Short";
  /** "YYYY-MM-DDTHH:MM:SS" ET */
  openedAt: string;
  closedAt: string | null;
  /** Trade (session) date of the opening fill. */
  date: string;
  /** Trade date of the closing fill; null while open or when same-day. */
  exitDate: string | null;
  horizon: Horizon;
  session: Session;
  /** Max absolute position reached (shares). */
  qty: number;
  /** Shares closed so far (== qty when closed; may be < qty while open). */
  closedQty: number;
  /** Shares still open at end of data. */
  openQty: number;
  avgEntry: number;
  avgExit: number | null;
  /** Realized gross P&L (average-cost method). Equals total gross when closed. */
  grossPnl: number;
  fees: FeeBreakdown;
  totalFees: number;
  netPnl: number;
  result: TripResult;
  holdTime: string | null;
  holdSeconds: number | null;
  executions: RoundTripExecution[];
  fillCount: number;
  /** True when the position was still open at the end of the data. */
  open: boolean;
  /** Set when the trip was built from a PropReports "Trades" report (no fills) rather than fills. */
  fromReport?: boolean;
}

export interface ParseIssue {
  line: number;
  message: string;
}

export interface FillsParseResult {
  fills: Fill[];
  issues: ParseIssue[];
  /** Header columns as seen in the file (for the UI preview). */
  columns: string[];
  /** Rows skipped because Status = CXLD / corrections etc. */
  skipped: number;
  /** Fee columns found in the header (known names + heuristic), in file order. */
  feeColumns: Array<{ key: string; header: string; known: boolean; heuristic: boolean }>;
}
