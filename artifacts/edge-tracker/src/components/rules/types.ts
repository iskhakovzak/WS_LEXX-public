import type { Tone } from "@/components/ds";

export type RuleFieldType = "number" | "time" | "tickers";

export type RuleField = {
  key: string;
  label: string;
  type: RuleFieldType;
  /** number; HHMM for time (930 = 9:30); string[] for tickers. */
  default: number | string[];
  /** Optional fields may be left empty: the trader's risk-desk limit is used instead. */
  optional?: boolean;
  riskLimit?: "daily_loss_limit" | "max_position_usd" | "max_risk_per_trade";
  unit?: string;
};

export type RuleGroup = "volume" | "loss" | "time" | "size" | "process" | "self";

export type RuleKindDef = {
  kind: string;
  label: string;
  hint?: string;
  group?: RuleGroup;
  groupLabel?: string;
  /** false — self-assessed (marked daily in the journal). */
  auto?: boolean;
  needs?: string[];
  legacy?: boolean;
  fields: RuleField[];
};

export type RuleOrigin = "personal" | "office";

export type Rule = {
  id: number;
  trader: string;
  name: string;
  kind: string;
  threshold: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  origin?: RuleOrigin;
  desk?: boolean;
  createdBy?: string | null;
  note?: string | null;
  auto?: boolean;
  kindLabel?: string;
  summary?: string;
};

export type Severity = "low" | "medium" | "high" | "critical";

export type ViolationStatus = "open" | "acknowledged" | "resolved";
export type ViolationResolution = "upheld" | "dismissed";

export type Violation = {
  id: number;
  trader: string;
  ruleId: number;
  tradeId: number | null;
  occurredAt: string;
  severity: string;
  message: string;
  details: Record<string, unknown> | null;
  /** Trading day (NY) the violation belongs to. */
  day: string | null;
  /** What the violation cost, net $ (negative = loss); null when unknown. */
  costNet: number | null;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  comment: string | null;
  resolution: ViolationResolution | null;
  consequence: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  status: ViolationStatus;
  ruleName: string | null;
  ruleKind: string | null;
  ruleOrigin?: RuleOrigin;
  ruleDesk?: boolean;
  ticker: string | null;
  tradeDate: string | null;
  tradeCloseDate?: string | null;
  tradeResult?: string | null;
  /** Signed R of the linked trade (shared trade math). */
  tradeR?: number | null;
  /** Gross P&L of the linked trade. */
  tradePnl?: number | null;
  /** Net P&L (gross − |fees|) of the linked trade. */
  tradeNetPnl?: number | null;
  tradeSetup?: string | null;
  playbookId?: number | null;
  playbookName?: string | null;
  tradeSource?: string | null;
  /** Archived: kept with its comments but out of counts and default lists (rule disabled / deleted, or no longer produced). */
  archived?: boolean;
  archivedReason?: ViolationArchiveReason | null;
  archivedAt?: string | null;
  ruleEnabled?: boolean;
  ruleDeleted?: boolean;
};

export type ViolationArchiveReason = "rule_disabled" | "rule_deleted" | "stale";

export type Mistake = {
  id: number;
  trader: string;
  errorType: string;
  description: string;
  ticker: string | null;
  tradeId: number | null;
  severity: string;
  lesson: string | null;
  resolved: "yes" | "no" | string;
  createdAt: string;
  tradeDate?: string | null;
  tradeResult?: string | null;
  tradeR?: number | null;
  tradePnl?: number | null;
  tradeNetPnl?: number | null;
  tradeCloseDate?: string | null;
  tradeSide?: string | null;
};

export type DisciplineTrade = {
  id: number;
  ticker: string;
  date: string;
  /** Exit date for multi-day holds, else entry date — the day the result counts on. */
  closeDate: string;
  side: string | null;
  setup: string | null;
  playbookId: number | null;
  result: string;
  /** Signed R (shared trade math). */
  rMultiple: number | null;
  /** Gross P&L. */
  pnl: number | null;
  fees: number | null;
  /** Net P&L (gross − |fees|). */
  netPnl: number | null;
  horizon: "intraday" | "overnight" | "swing" | string | null;
  source: string | null;
  violations: number;
  /** Σ cost_net of this trade's violations (net $, negative = loss). */
  violationCost: number;
  mistakes: number;
};

export type DisciplineResponse = {
  trader: string;
  from: string;
  to: string;
  days: number;
  trades: DisciplineTrade[];
};

export type SeverityMeta = { label: string; tone: Tone; bar: string };

/** Prefill passed to the mistake dialog from other places (calendar day, violation row, trade). */
export type MistakePrefill = {
  errorType?: string;
  description?: string;
  tradeId?: number | null;
  ticker?: string | null;
  severity?: Severity;
};

// ─── Report (GET /rules/report) ─────────────────────────────────────────────

export type SideStats = { n: number; net: number; avg: number | null };

export type ViolationExample = {
  key: string;
  tradeId: number | null;
  ticker: string | null;
  day: string;
  net: number | null;
  impact: number | null;
  message: string;
  severity: Severity;
  violationId: number | null;
  status: string | null;
};

export type WeekPoint = { week: string; days: number; violatedDays: number; compliance: number | null; violations: number };

export type RuleReport = {
  id: number;
  name: string;
  kind: string;
  kindLabel: string;
  group: string;
  auto: boolean;
  origin: RuleOrigin;
  desk: boolean;
  trader: string;
  note: string | null;
  createdBy: string | null;
  enabled: boolean;
  threshold: Record<string, unknown>;
  summary: string;
  status: "checked" | "no_data" | "no_marks" | "disabled";
  unit: "trade" | "day";
  days: number;
  violatedDays: number;
  compliance: number | null;
  tradeCompliance: number | null;
  coveredTrades: number;
  violations: number;
  broken: SideStats;
  clean: SideStats;
  impact: number | null;
  edgeGap: number | null;
  recentCompliance: number | null;
  prevCompliance: number | null;
  weekly: WeekPoint[];
  lastViolation: string | null;
  cleanStreak: number;
  unmarkedDays: number;
  examples: ViolationExample[];
  canEdit?: boolean;
  /** Violations kept (with comments) while the rule is disabled; they come back when it is re-enabled. */
  archivedViolations?: number;
};

export type CalendarDay = {
  day: string;
  trades: number;
  net: number;
  violations: number;
  ruleIds: number[];
  clean: boolean;
  worst: Severity | null;
  selfMarked: number;
};

export type RulesReportResponse = {
  trader: string;
  from: string;
  to: string;
  days: number;
  canManageTeam: boolean;
  canManageDesk: boolean;
  totals: {
    tradingDays: number;
    cleanDays: number;
    compliance: number | null;
    trades: number;
    broken: SideStats;
    clean: SideStats;
    impact: number | null;
    currentStreak: number;
    bestStreak: number;
    activeRules: number;
    autoRules: number;
    selfRules: number;
    recentCompliance: number | null;
    prevCompliance: number | null;
    weekly: WeekPoint[];
  };
  rules: RuleReport[];
  calendar: CalendarDay[];
  stats: {
    medianTradesPerDay: number | null;
    p90TradesPerDay: number | null;
    p95Qty: number | null;
    p95Notional: number | null;
    p90Loss: number | null;
    medianHoldSec: number | null;
    withTime: number;
    withSize: number;
    withExecutions: number;
  };
};

// ─── Mistakes summary (GET /errors/summary) ─────────────────────────────────

export type MistakeTypeStat = { type: string; count: number; trades: number; net: number; avgNet: number | null; lastDay: string | null; open: number; severe: number };
export type UntaggedTrade = { id: number; ticker: string; side: string | null; day: string; net: number | null; qty: number | null; time: string | null };
export type MistakesSummary = {
  trader: string;
  from: string;
  to: string;
  totals: { mistakes: number; trades: number; net: number; losingTrades: number; losingNet: number };
  byType: MistakeTypeStat[];
  untagged: UntaggedTrade[];
};

// ─── Behavior patterns (GET /api/behavior, read-only) ────────────────────────

export type BehaviorPattern = {
  key: string;
  title: string;
  description?: string | null;
  n: number;
  share?: number | null;
  net?: number | null;
  avgNet?: number | null;
  cost?: number | null;
  severity?: string | null;
  tradeIds?: number[];
};
export type BehaviorResponse = {
  summary?: { tradesPerDayNorm?: number | null; medianTradesPerDay?: number | null } | null;
  options?: { revengeMin?: number | null; martingaleRatio?: number | null } | null;
  patterns?: BehaviorPattern[];
};

// ─── Self-assessed rules (GET /rules/self-checks) ───────────────────────────

export type SelfMark = { ruleId: number; day: string; ok: boolean | null; note: string | null };
export type SelfChecksResponse = {
  trader: string;
  rules: { id: number; name: string; note: string | null; origin: RuleOrigin; desk: boolean }[];
  marks: SelfMark[];
};
