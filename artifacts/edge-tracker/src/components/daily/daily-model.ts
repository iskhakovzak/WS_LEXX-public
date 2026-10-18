// Pure view model of the dashboard day line: which state the trader sees (morning focus / evening card / closed day),
// today's contract from the personal plan, verdict tones, tier-progress titles and metric formatting. No React here —
// the components render what these functions decide, and daily-model.test.ts pins the decisions with fixtures.
import type { Tone } from "@/components/ds";
import type { ContractVerdict, DailyFocus, DailyMe, EveningCard, MistakeId, TierProgress, VerdictStatus } from "@/lib/daily/types";
import { fmtCount, fmtNum, fmtR, fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { dailyI18n } from "@/i18n/ns/daily";

export type ContractStatus = VerdictStatus | "unset";

/** What the day line leads with. */
export type DayView = {
  /** «evening» = the last finished day's card (or its closed state); «focus» = the morning focus. */
  primary: "evening" | "focus";
  /** The card to show (evening primary), or the not-yet-reviewed day offered as a compact row before the focus. */
  evening: EveningCard | null;
  /** Morning: yesterday is still not reviewed → a compact «Разобрать» row that opens the card in place. */
  pendingEvening: boolean;
  focus: DailyFocus | null;
};

/** An evening card is worth showing only when the day had trades. */
function hasDay(e: EveningCard | null | undefined): e is EveningCard {
  return !!e && e.trades > 0;
}

export function dayView(me: DailyMe | null | undefined): DayView | null {
  if (!me) return null;
  const evening = hasDay(me.evening) ? me.evening : null;
  const late = me.phase === "afterclose" || me.phase === "weekend";
  if (late && evening) return { primary: "evening", evening, pendingEvening: false, focus: me.focus };
  if (!me.focus && !evening) return null;
  return { primary: "focus", evening, pendingEvening: !!evening && !evening.reviewed, focus: me.focus };
}

/** Today's own contract as written in the personal plan (doc.maxLossUsd / maxTrades / ownRule). */
export type PlanContract = {
  maxLossUsd: number | null;
  maxTrades: number | null;
  /** undefined = never chosen (→ prefilled with the focus); null = the trader chose «no rule». */
  ownRule: MistakeId | null | undefined;
};

export type ContractLine = {
  maxLossUsd: number | null;
  maxTrades: number | null;
  rule: MistakeId | null;
  /** The rule is the focus prefill, not saved in the plan yet. */
  ruleFromFocus: boolean;
  empty: boolean;
};

export function contractLine(plan: PlanContract | null | undefined, focus: DailyFocus | null | undefined): ContractLine {
  const maxLossUsd = plan?.maxLossUsd ?? null;
  const maxTrades = plan?.maxTrades ?? null;
  const saved = plan?.ownRule;
  const fromFocus = saved === undefined && !!focus?.mistake && focus.source !== "none";
  const rule = saved ?? (fromFocus ? (focus?.mistake ?? null) : null);
  return { maxLossUsd, maxTrades, rule, ruleFromFocus: fromFocus, empty: maxLossUsd == null && maxTrades == null && !rule };
}

/** Reads the contract fields out of GET /api/game-plan/my (any doc shape; unknown types are ignored). */
export function planContract(res: { plan: { doc: Record<string, unknown> | null } | null } | null | undefined): PlanContract | null {
  const doc = res?.plan?.doc;
  if (!doc) return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const r = doc.ownRule;
  return { maxLossUsd: n(doc.maxLossUsd), maxTrades: n(doc.maxTrades), ownRule: typeof r === "string" && r ? r : r === null ? null : undefined };
}

export function statusTone(s: ContractStatus | null | undefined): Tone {
  if (s === "kept") return "up";
  if (s === "broken") return "down";
  return "neutral";
}

/** One word for the whole contract: broken if anything broke, kept if something was kept, else unset / no data. */
export function contractOverall(c: ContractVerdict | null | undefined): ContractStatus {
  if (!c) return "unset";
  const all = [c.maxLoss.status, c.maxTrades.status, c.rule.status];
  if (all.includes("broken")) return "broken";
  if (all.includes("kept")) return "kept";
  if (all.every((s) => s === "unset")) return "unset";
  if (all.includes("no_trades")) return "no_trades";
  return "unknown";
}

/** «+3» / «−2» / «0» — discipline points with a real minus sign. */
export function fmtDelta(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0";
  return fmtNum(n, { signed: true, decimals: Number.isInteger(n) ? 0 : 1 });
}

const DEFAULT_TIER_KEYS = ["trainee", "junior", "trader", "senior"] as const;
type DefaultTier = (typeof DEFAULT_TIER_KEYS)[number];
/** Seeded RU names of the default ladder (data the server may send instead of the key). */
const SEEDED_RU: Record<string, DefaultTier> = {
  "стажёр": "trainee", // i18n-ignore — seeded tier name (data) to compare with
  "джун": "junior", // i18n-ignore
  "трейдер": "trader", // i18n-ignore
  "сеньор": "senior", // i18n-ignore
};
const COMMON_WORD: Record<DefaultTier, "intern" | "junior" | "trader" | "senior"> = { trainee: "intern", junior: "junior", trader: "trader", senior: "senior" };

function defaultTier(t: string | null | undefined): DefaultTier | null {
  if (!t) return null;
  const k = t.trim().toLowerCase();
  if ((DEFAULT_TIER_KEYS as readonly string[]).includes(k)) return k as DefaultTier;
  return SEEDED_RU[k] ?? null;
}

/** Tier name for people: the default ladder in the UI language, a custom name as written. */
export function tierName(t: string | null | undefined): string {
  const d = defaultTier(t);
  return d ? commonI18n.t(`tiers.${COMMON_WORD[d]}`) : (t ?? commonI18n.t("tiers.noTier"));
}

/** «До Джуна: 3 из 5» / «Уровень «Сеньор» — высший». Null when there is no ladder for the trader. */
export function tierTitle(p: TierProgress | null | undefined): string | null {
  if (!p || (!p.tier && !p.nextTier)) return null;
  if (!p.nextTier) return dailyI18n.t("tier.top", { tier: tierName(p.tier) });
  const d = defaultTier(p.nextTier);
  const args = { met: p.met, total: p.total };
  return d ? dailyI18n.t(`tier.to.${d}`, args) : dailyI18n.t("tier.to.custom", { ...args, tier: p.nextTier });
}

type MetricUnit = "count" | "usd" | "r" | "x" | "pct" | "score";
const METRIC_UNIT: Record<string, MetricUnit> = {
  trades: "count",
  net_pnl: "usd",
  net_r: "r",
  profit_factor: "x",
  win_rate: "pct",
  expectancy_r: "r",
  green_weeks: "count",
  green_days_pct: "pct",
  max_dd_usd: "usd",
  max_dd_pct: "pct",
  limit_breaches: "count",
  red_streak: "count",
  discipline: "score",
  rating_overall: "score",
  violations: "count",
};

/** A criterion value in the metric's unit (money / R / ratios keep the trading format in every language). */
export function fmtMetric(metric: string, v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  switch (METRIC_UNIT[metric] ?? "count") {
    case "usd":
      return fmtUsd(v, { decimals: 0 });
    case "r":
      return fmtR(v);
    case "x":
      return fmtNum(v);
    case "pct":
      return `${Math.round(v)}%`;
    case "score":
      return fmtNum(v, { decimals: 1 });
    default:
      return fmtCount(Math.round(v));
  }
}

const LOWER_IS_BETTER = new Set(["max_dd_usd", "max_dd_pct", "limit_breaches", "red_streak", "violations"]);

/** «≥ 40» / «≤ 0» — the target with its direction (the ladder's lower-is-better metrics cap, the rest are floors). */
export function fmtTarget(metric: string, target: number | null | undefined): string {
  return `${LOWER_IS_BETTER.has(metric) ? "≤" : "≥"} ${fmtMetric(metric, target)}`;
}

/** Criterion label: own dictionary by metric key, then the server's text key, then the raw key. */
export function metricLabel(item: { metric: string; label: { key: string; params?: Record<string, string | number | null> } }): string {
  const own = dailyI18n.tryT(`tier.metric.${item.metric}`);
  if (own) return own;
  const params = Object.fromEntries(Object.entries(item.label.params ?? {}).map(([k, v]) => [k, v ?? ""]));
  return dailyI18n.tryT(item.label.key, params) ?? item.metric;
}
