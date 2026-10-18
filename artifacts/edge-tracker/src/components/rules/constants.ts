import type { SeverityMeta } from "./types";
import { pluralRu } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { rulesI18n } from "@/i18n/ns/rules";

// Labels are getters: read in render with the current language (never translate at module scope).
export const SEVERITY: Record<string, SeverityMeta> = {
  low: { get label() { return rulesI18n.t("severity.low"); }, tone: "neutral", bar: "bg-muted-foreground/50" },
  medium: { get label() { return rulesI18n.t("severity.medium"); }, tone: "warn", bar: "bg-[hsl(var(--chart-3))]" },
  high: { get label() { return rulesI18n.t("severity.high"); }, tone: "down", bar: "bg-down/70" },
  critical: { get label() { return rulesI18n.t("severity.critical"); }, tone: "down", bar: "bg-down" },
};
export const SEVERITY_ORDER = ["low", "medium", "high", "critical"] as const;

export function severityMeta(s: string | null | undefined): SeverityMeta {
  return SEVERITY[s ?? "medium"] ?? SEVERITY.medium;
}

type MistakeCode = "fomo" | "offPlan" | "earlyEntry" | "movedStop" | "noStop" | "averagingDown" | "oversize" | "overtrading" | "revenge" | "earlyExit" | "heldLoser" | "ignoredNews";
type Sev = "low" | "medium" | "high" | "critical";

/**
 * Common day-trading mistakes — one tap in the quick-log dialog. `value` is what gets stored (the original Russian
 * label: readable in CSV, matched by the server's junior review) — it is data, never shown; `label` / `hint` are the
 * display in the current language.
 */
function cat(code: MistakeCode, value: string, severity: Sev) {
  return {
    code,
    value,
    severity,
    get label() { return rulesI18n.t(`mistakeCat.${code}.label`); },
    get hint() { return rulesI18n.t(`mistakeCat.${code}.hint`); },
  };
}
// Stored values below are data (see the doc comment above), hence the i18n-ignore marks.
export const MISTAKE_CATEGORIES = [
  cat("fomo", "FOMO / погоня", "medium"), // i18n-ignore
  cat("offPlan", "Вход не по плану", "high"), // i18n-ignore
  cat("earlyEntry", "Ранний вход", "medium"), // i18n-ignore
  cat("movedStop", "Сдвинул стоп", "high"), // i18n-ignore
  cat("noStop", "Без стопа", "critical"), // i18n-ignore
  cat("averagingDown", "Усреднение убытка", "critical"), // i18n-ignore
  cat("oversize", "Завышенный размер", "high"), // i18n-ignore
  cat("overtrading", "Переторговка", "medium"), // i18n-ignore
  cat("revenge", "Отыгрыш после убытка", "high"), // i18n-ignore
  cat("earlyExit", "Ранний выход из прибыли", "low"), // i18n-ignore
  cat("heldLoser", "Пересидел убыток", "high"), // i18n-ignore
  cat("ignoredNews", "Проигнорировал новости", "medium"), // i18n-ignore
];

/** Stored prefix of a mistake logged from a rule violation («Правило: <rule name>») — data, see mistakeLabel(). */
export const RULE_PREFIX = "Правило: "; // i18n-ignore

const CAT_BY_VALUE = new Map(MISTAKE_CATEGORIES.map((c) => [c.value, c]));

/** Display text of a stored mistake category: built-in ones are translated, a rule-based one keeps the rule name, custom text stays as typed. */
export function mistakeLabel(stored: string): string {
  const c = CAT_BY_VALUE.get(stored);
  if (c) return c.label;
  if (stored.startsWith(RULE_PREFIX)) return rulesI18n.t("rulePrefixed", { name: stored.slice(RULE_PREFIX.length) });
  return stored;
}

/** Status of a violation in the acknowledge → resolve workflow. */
export const VIOLATION_STATUS: Record<string, { label: string; tone: "neutral" | "warn" | "up" | "down" | "accent" }> = {
  open: { get label() { return rulesI18n.t("status.open"); }, tone: "warn" },
  acknowledged: { get label() { return rulesI18n.t("status.acknowledged"); }, tone: "accent" },
  resolved: { get label() { return rulesI18n.t("status.resolved"); }, tone: "neutral" },
};
export const VIOLATION_RESOLUTION: Record<string, { label: string; tone: "up" | "down" }> = {
  upheld: { get label() { return rulesI18n.t("resolution.upheld"); }, tone: "down" },
  dismissed: { get label() { return rulesI18n.t("resolution.dismissed"); }, tone: "up" },
};

/** Muted badge for archived violations (kept with comments, out of counts). */
type ArchiveReason = "rule_disabled" | "rule_deleted" | "stale";
const archived = (r: ArchiveReason) => ({
  get label() { return rulesI18n.t(`archive.${r}.label`); },
  get hint() { return rulesI18n.t(`archive.${r}.hint`); },
});
export const VIOLATION_ARCHIVE: Record<string, { label: string; hint: string }> = {
  rule_disabled: archived("rule_disabled"),
  rule_deleted: archived("rule_deleted"),
  stale: archived("stale"),
};

const period = <V extends string>(value: V) => ({ value, get label() { return commonI18n.t("time.daysShort", { count: Number(value) }); } });
export const PERIODS = [period("30"), period("90"), period("180")] as const;
export type PeriodValue = (typeof PERIODS)[number]["value"];

export const LS_KEYS = {
  tab: "rules.tab.v2",
  period: "rules.period",
  trader: "rules.trader",
  showArchive: "rules.violations.archive",
} as const;

type Origin = "desk" | "office" | "personal";
const origin = <T extends string>(o: Origin, tone: T) => ({
  tone,
  get label() { return rulesI18n.t(`origin.${o}.label`); },
  get hint() { return rulesI18n.t(`origin.${o}.hint`); },
});
export const ORIGIN_LABEL = {
  desk: origin("desk", "purple" as const),
  office: origin("office", "accent" as const),
  personal: origin("personal", "neutral" as const),
};

export function originOf(r: { desk?: boolean; origin?: string | null }): keyof typeof ORIGIN_LABEL {
  return r.desk ? "desk" : r.origin === "office" ? "office" : "personal";
}

export function lsGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function lsSet(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

/** @deprecated Compatibility export (RU only) — rules screens use the `preview.violations` plural entry. */
export const violationsWord = (n: number) => pluralRu(n, "нарушение", "нарушения", "нарушений"); // i18n-ignore
