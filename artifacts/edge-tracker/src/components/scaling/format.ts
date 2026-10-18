import type { Tone } from "@/components/ds";
import type { Action, MetricUnit, Op, RuleStatus, Tier, Unit } from "./use-scaling";
import { MINUS, fmtCount, fmtNum, fmtPct, fmtR, fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { scalingI18n } from "@/i18n/ns/scaling";

// Labels are resolved at call time (scalingI18n.t), never at module scope — tones and codes are static.

export function fmtMetric(unit: MetricUnit, v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  switch (unit) {
    case "usd": return fmtUsd(v, { decimals: 0 });
    case "r": return fmtR(v);
    case "pct": return fmtPct(v, { decimals: 0, signed: false });
    case "x": return fmtNum(v, { suffix: "×" });
    case "score": return fmtNum(v, { decimals: 1, suffix: "/10" });
    default: return fmtCount(Math.round(v));
  }
}

export const OP_LABEL: Record<Op, string> = { ">=": "≥", ">": ">", "<=": "≤", "<": "<", "=": "=" };

export function fmtThreshold(unit: MetricUnit, raw: number, ruleUnit: Unit, resolved: number | null): string {
  const t = scalingI18n.t;
  const value = String(raw).replace("-", MINUS);
  const amount = resolved != null ? fmtUsd(resolved, { decimals: 0 }) : null;
  if (ruleUnit === "x_daily_limit") return amount ? t("threshold.xDailyLimitResolved", { value, amount }) : t("threshold.xDailyLimit", { value });
  if (ruleUnit === "pct_account") return amount ? t("threshold.pctAccountResolved", { value, amount }) : t("threshold.pctAccount", { value });
  return fmtMetric(unit, raw);
}

export const ACTION_TONE: Record<Action, Tone> = { promote: "up", demote: "down", assign: "accent", hold: "neutral" };

/** «Повышение» / «Понижение» / «Назначить тир» / «Удержание». */
export function actionLabel(a: Action): string {
  return scalingI18n.t(`action.${a}`);
}

/** «Повысить» / «Понизить» / «Назначить» / «Оставить». */
export function actionVerb(a: Action): string {
  return scalingI18n.t(`verb.${a}`);
}

export const STATUS_TONE: Record<RuleStatus, Tone> = { pass: "up", fail: "down", na: "neutral" };

export function ruleStatusLabel(s: RuleStatus): string {
  return scalingI18n.t(`ruleStatus.${s}`);
}

type ProposalStatus = "pending" | "approved" | "rejected";
const PROPOSAL_TONE: Record<ProposalStatus, Tone> = { pending: "warn", approved: "up", rejected: "down" };

export function proposalStatusMeta(status: string): { label: string; tone: Tone } {
  const s: ProposalStatus = status === "approved" || status === "rejected" ? status : "pending";
  return { label: scalingI18n.t(`proposalStatus.${s}`), tone: PROPOSAL_TONE[s] };
}

/**
 * The ladder's default tiers (seeded with Russian names) are shown in the UI language; a tier the admin renamed or
 * added keeps its own name (user content).
 */
const DEFAULT_TIERS: Record<string, { ru: string; word: "intern" | "junior" | "trader" | "senior" }> = {
  trainee: { ru: "Стажёр", word: "intern" }, // i18n-ignore — seeded name (data) to compare with
  junior: { ru: "Джун", word: "junior" }, // i18n-ignore
  trader: { ru: "Трейдер", word: "trader" }, // i18n-ignore
  senior: { ru: "Сеньор", word: "senior" }, // i18n-ignore
};

/** Display name of a tier: the default ladder in the UI language, custom names as written. */
export function tierLabel(t: { key: string; name: string } | null | undefined): string {
  if (!t) return commonI18n.t("tiers.noTier");
  const d = DEFAULT_TIERS[t.key];
  return d && t.name === d.ru ? commonI18n.t(`tiers.${d.word}`) : t.name;
}

export function tierName(tiers: Tier[], key: string | null | undefined): string {
  if (!key) return commonI18n.t("tiers.noTier");
  const t = tiers.find((x) => x.key === key);
  return t ? tierLabel(t) : key;
}

type TierFieldKey =
  | "accountSize" | "dailyLossLimit" | "weeklyLossLimit" | "maxDrawdown" | "maxRiskPerTrade" | "maxPositionUsd"
  | "maxOvernightExposure" | "maxOpenPositions" | "allowOvernight" | "allowSwing";

/** Rows for the limits comparison (current tier → next tier); label: `tierFieldLabel(key)`. */
export const TIER_FIELDS: { key: TierFieldKey; kind: "usd" | "int" | "bool" }[] = [
  { key: "accountSize", kind: "usd" },
  { key: "dailyLossLimit", kind: "usd" },
  { key: "weeklyLossLimit", kind: "usd" },
  { key: "maxDrawdown", kind: "usd" },
  { key: "maxRiskPerTrade", kind: "usd" },
  { key: "maxPositionUsd", kind: "usd" },
  { key: "maxOvernightExposure", kind: "usd" },
  { key: "maxOpenPositions", kind: "int" },
  { key: "allowOvernight", kind: "bool" },
  { key: "allowSwing", kind: "bool" },
];

export function tierFieldLabel(key: TierFieldKey): string {
  return scalingI18n.t(`limit.${key}`);
}

export function fmtTierField(kind: "usd" | "int" | "bool", v: unknown): string {
  if (kind === "bool") return scalingI18n.t(v ? "limit.allowed" : "limit.forbidden");
  if (v == null || v === "") return "—";
  return kind === "usd" ? fmtUsd(Number(v), { decimals: 0 }) : fmtCount(Number(v));
}
