// «Спроси журнал» — example questions, chip alternatives and «не понял» suggestions in the UI language (no React).
// The texts live in the `ask` dictionary as «|»-separated lists; every item parses in its own language
// (lib/ask/__tests__/i18n-examples.test.ts). Call these at render time, never at module scope.

import { askI18n } from "@/i18n/ns/ask";
import type { AskQuery, AskTokenKind } from "./parse";

const t = askI18n.t;
const split = (s: string) => s.split("|").map((x) => x.trim()).filter(Boolean);

const GROUP_IDS = ["results", "time", "tickers", "compare", "weak", "periods"] as const;
export type AskExampleGroupId = (typeof GROUP_IDS)[number];
export interface AskExampleGroup { id: AskExampleGroupId; title: string; items: string[] }

export function askExampleGroups(): AskExampleGroup[] {
  return GROUP_IDS.map((id) => ({ id, title: t(`ex.groups.${id}`), items: split(t(`ex.${id}`)) }));
}

export function askExamples(): string[] {
  return askExampleGroups().flatMap((g) => g.items);
}

/** Ready answers on the start screen. */
export const askStarters = () => split(t("ex.starters"));
/** «Что я понимаю» hints. */
export const askHints = () => split(t("ex.hints"));

const CHIP_KINDS = ["date", "time", "side", "outcome", "weekday", "hold", "qty", "price", "after", "group", "intent", "last"] as const;
type ChipKind = (typeof CHIP_KINDS)[number];
const isChipKind = (k: AskTokenKind): k is ChipKind => (CHIP_KINDS as readonly string[]).includes(k);

/** What a chip of this kind can be swapped to (the replacement text is re-parsed in place). Ticker / setup: from the data. */
export function chipAlternatives(kind: AskTokenKind, data: { tickers?: string[]; setups?: string[] } = {}): string[] {
  if (kind === "ticker") return (data.tickers ?? []).slice(0, 10);
  if (kind === "setup") return (data.setups ?? []).slice(0, 10).map((s) => t("q.setup", { name: s }));
  return isChipKind(kind) ? split(t(`ex.chips.${kind}`)) : [];
}

type SuggestKey = "fees" | "winrate" | "time" | "weekday" | "lose" | "win" | "streak" | "hold" | "size" | "side";
/** Keywords of any language → suggestion list (texts in the UI language). */
const KEYWORD_SUGGESTIONS: Array<{ re: RegExp; key: SuggestKey }> = [
  { re: /(комис|fee|commission|komissiya)/i, key: "fees" },
  { re: /(вин|win|процент|percent|foiz|vinreyt)/i, key: "winrate" },
  { re: /(утр|обед|час|врем|откр|morning|lunch|hour|time|open|ertalab|tush|soat|vaqt|ochil)/i, key: "time" },
  { re: /(пятниц|понедел|вторн|сред|четвер|недел|monday|tuesday|wednesday|thursday|friday|week|dushanba|seshanba|chorshanba|payshanba|juma|hafta)/i, key: "weekday" },
  { re: /(теря|слив|минус|убыт|плох|худш|lose|loss|losing|worst|bad|zarar|yo.?qot|yomon)/i, key: "lose" },
  { re: /(лучш|топ|зараб|плюс|прибыл|best|top|earn|make|profit|yaxshi|foyda|ishla)/i, key: "win" },
  { re: /(серия|подряд|стрик|streak|in a row|seriya|ketma)/i, key: "streak" },
  { re: /(держ|удерж|долго|быстр|hold|how long|duration|quick|ushlab|davom)/i, key: "hold" },
  { re: /(размер|объ[её]м|акци|лот|size|shares|o.?lcham|hajm|aksiya)/i, key: "size" },
  { re: /(лонг|шорт|long|short)/i, key: "side" },
];

/** Suggestions for an unparsed question: keyword-based first, then generic examples. */
export function suggestFor(raw: string, q?: AskQuery | null, tickers: string[] = []): string[] {
  const out: string[] = [];
  for (const k of KEYWORD_SUGGESTIONS) if (k.re.test(raw)) out.push(...split(t(`ex.suggest.${k.key}`)));
  const upper = raw.match(/\b[A-Za-z]{1,5}\b/g)?.map((w) => w.toUpperCase()).find((w) => tickers.includes(w));
  if (upper) out.unshift(t("q.allTime", { ticker: upper }), t("q.byDay", { ticker: upper }));
  if (q?.unknown.length && tickers.length && !upper) out.push(t("q.thisMonth", { ticker: tickers[0] }));
  out.push(...split(t("ex.suggest.generic")));
  return [...new Set(out)].slice(0, 6);
}
