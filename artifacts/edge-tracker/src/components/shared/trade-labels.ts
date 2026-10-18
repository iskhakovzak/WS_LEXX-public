/**
 * Display labels of trade codes shared by several features (trades, journal, EOD, dashboard): horizon, result,
 * session, event type and stored review tags, each read in the current language on access. Stored values stay codes.
 */
import { liveLabels } from "@/i18n/live-labels";
import { tradesI18n } from "@/i18n/ns/trades";

export const RESULTS = ["win", "loss", "breakeven", "open"] as const;
export const HORIZONS = ["intraday", "overnight", "swing"] as const;
export type Horizon = (typeof HORIZONS)[number];
export const HORIZON_LABEL: Readonly<Record<Horizon, string>> = liveLabels(HORIZONS, (k) => tradesI18n.t(`horizon.${k}`));

type EventCode = "earnings" | "momentum" | "news" | "ipo" | "fed" | "macro" | "other";
const EVENT_CODES: readonly EventCode[] = ["earnings", "momentum", "news", "ipo", "fed", "macro", "other"];
/** Event type code → label in the current language (`EVENT_LABEL[code]`; unknown codes are undefined). */
export const EVENT_LABEL: Readonly<Record<string, string>> = liveLabels(EVENT_CODES, (k) => tradesI18n.t(`event.${k}`));
type SessionCode = "premarket" | "regular" | "afterhours";
export const SESSION_LABEL: Readonly<Record<string, string>> = liveLabels<SessionCode>(["premarket", "regular", "afterhours"], (k) => tradesI18n.t(`session.${k}`));
export const RESULT_LABEL: Readonly<Record<string, string>> = liveLabels(RESULTS, (k) => tradesI18n.t(`result.${k}`));

/** Event type as shown: a known code is translated, anything else (free text) as is. */
export function eventLabel(code: string | null | undefined): string {
  return code ? EVENT_LABEL[code] ?? code : "";
}

/** Session as shown. PropReports writes «postmarket», the form «afterhours»; `full` names the regular session in full. */
export function sessionLabel(code: string | null | undefined, opts?: { full?: boolean }): string {
  if (!code) return "";
  if (code === "postmarket" || code === "afterhours") return tradesI18n.t("session.afterhours");
  if (code === "regular") return tradesI18n.t(opts?.full ? "session.regularFull" : "session.regular");
  if (code === "premarket") return tradesI18n.t("session.premarket");
  return code;
}

// ── Stored review tags ───────────────────────────────────────────────────────

type TagKey = keyof typeof import("@/i18n/locales/ru/trades").default.tag;
/** Stored tag word (lower case) → label key. Covers the trade review, EOD and day-journal vocabularies. */
const TAG_KEY: Record<string, TagKey> = {
  fomo: "fomo",
  "ранний вход": "earlyEntry", // i18n-ignore (stored tag code)
  "поздний выход": "lateExit", // i18n-ignore
  "двигал стоп": "movedStop", // i18n-ignore
  "овертрейдинг": "overtrading", // i18n-ignore
  "реванш": "revenge", // i18n-ignore
  "без плана": "noPlan", // i18n-ignore
  "большой размер": "oversize", // i18n-ignore
  "не по сетапу": "offSetup", // i18n-ignore
  "ранний выход": "earlyExit", // i18n-ignore
  "по плану": "onPlan", // i18n-ignore
  "терпение": "patience", // i18n-ignore
  "чистый выход": "cleanExit", // i18n-ignore
  "резал убыток": "cutLoss", // i18n-ignore
  "спокойствие": "calm", // i18n-ignore
  "уверенность": "confidence", // i18n-ignore
  "азарт": "excitement", // i18n-ignore
  "нетерпение": "impatience", // i18n-ignore
  "страх": "fear", // i18n-ignore
  "жадность": "greed", // i18n-ignore
  "скука": "boredom", // i18n-ignore
  "раздражение": "irritation", // i18n-ignore
  "тильт": "tilt", // i18n-ignore
  "эйфория": "euphoria", // i18n-ignore
};

/** A stored tag as shown: vocabulary words (mistakes, emotions, legacy good tags) in the UI language, anything else as typed. */
export function tagLabel(tag: string): string {
  const k = TAG_KEY[tag.trim().toLowerCase()];
  return k ? tradesI18n.t(`tag.${k}`) : tag;
}

/** Matches a picker query against the stored value and its label (an EN user types «fear» for «Страх»). */
export function tagMatches(tag: string, query: string): boolean {
  return tag.toLowerCase().includes(query) || tagLabel(tag).toLowerCase().includes(query);
}
