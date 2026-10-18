// Labels for the daily loop's MistakeId («behavior:<PatternKey>», «structure:averaging», «day:fees», «rule:<RuleKind>»).
// Shared by the dashboard day line, the personal plan (rule of the day), the curator queue and the desk-day page.
// Texts: i18n namespace `daily` (mistake.* = what goes wrong, avoid.* = the rule phrased as what to do).
import type { MistakeId } from "@/lib/daily/types";
import { dailyI18n } from "@/i18n/ns/daily";

export type MistakeGroup = "behavior" | "structure" | "day" | "rule" | "other";

const BEHAVIOR = ["revenge", "martingale", "overtrading", "fatigue", "chase", "tilt", "disposition", "firstTrade", "euphoria"] as const;
const STRUCTURE = ["averaging", "held_past_stop"] as const;
const DAY = ["giveback", "fees", "after_limit"] as const;

/** Mistakes a trader can pick as the own rule of the day (rule:* kinds are desk rules with parameters — not offered). */
export const PICKABLE_MISTAKES: readonly { group: Exclude<MistakeGroup, "rule" | "other">; id: MistakeId }[] = [
  ...BEHAVIOR.map((k) => ({ group: "behavior" as const, id: `behavior:${k}` })),
  ...STRUCTURE.map((k) => ({ group: "structure" as const, id: `structure:${k}` })),
  ...DAY.map((k) => ({ group: "day" as const, id: `day:${k}` })),
];

/** «behavior:revenge» → { group: "behavior", key: "revenge" }. */
export function parseMistake(id: MistakeId): { group: MistakeGroup; key: string } {
  const i = id.indexOf(":");
  const head = i > 0 ? id.slice(0, i) : "";
  const key = i > 0 ? id.slice(i + 1) : id;
  const group: MistakeGroup = head === "behavior" || head === "structure" || head === "day" || head === "rule" ? head : "other";
  return { group, key };
}

/** «Реванш после убытка» — the mistake as a noun phrase, in the current language. Unknown ids stay readable. */
export function mistakeLabel(id: MistakeId | null | undefined): string {
  if (!id) return "";
  const { group, key } = parseMistake(id);
  const safe = key.replace(/\./g, "_");
  const known = group === "other" ? undefined : dailyI18n.tryT(`mistake.${group}.${safe}`);
  if (known) return known;
  return group === "rule" ? dailyI18n.t("mistake.ruleUnknown", { kind: key }) : dailyI18n.t("mistake.unknown", { id });
}

/** «После убытка — пауза, без реванша» — the same mistake phrased as the rule to keep. */
export function mistakeRule(id: MistakeId | null | undefined): string {
  if (!id) return "";
  const { group, key } = parseMistake(id);
  const known = group === "behavior" || group === "structure" || group === "day" ? dailyI18n.tryT(`avoid.${group}.${key.replace(/\./g, "_")}`) : undefined;
  return known ?? dailyI18n.t("avoid.generic", { mistake: mistakeLabel(id) });
}
