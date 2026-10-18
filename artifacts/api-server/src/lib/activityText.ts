/**
 * Activity rows in the reader's language.
 *
 * logActivity() stores `entity_title` / `details` as the Russian fallback plus `params` (text as data):
 * `{ titleKey?, detailsKey?, …values }`. Keys live in the `activity` namespace (`title.*` / `details.*`); a key
 * prefixed `setups.` / `rules.` / `behavior.` belongs to that area's namespace. Rows written before params existed are
 * matched by their Russian pattern so the feed reads in one language. User content (setup / folder names, tickers)
 * is never translated; people (`trader`, `user`… values, the accessCustom list) show their Latin name to EN / UZ
 * readers (lib/people/latinNames), the stored params keep the stored name.
 */
import { activityT } from "../i18n/ns";
import type { Lang } from "../i18n";
import { setupsT } from "./setupsI18n";
import { rulesT } from "./rulesI18n";
import { behaviorT } from "./behaviorI18n";
import { personNameFor } from "./people/latinNames";

export type ActivityParams = Record<string, string | number | boolean | null>;
type Vals = Record<string, string | number>;

function vals(p: ActivityParams): Vals {
  const out: Vals = {};
  for (const [k, v] of Object.entries(p)) if (typeof v === "string" || typeof v === "number") out[k] = v;
  return out;
}

/** Values that carry a person's stored name: shown as the Latin name to EN / UZ readers (params keep the stored name). */
const PERSON_VALUES = ["trader", "user", "actor", "author", "curator", "owner", "who"] as const;

function withPeople(p: Vals, lang: Lang): Vals {
  if (lang === "ru") return p;
  let out: Vals | null = null;
  for (const k of PERSON_VALUES) {
    const v = p[k];
    if (typeof v === "string" && v) (out ??= { ...p })[k] = personNameFor(v, lang);
  }
  return out ?? p;
}

function renderKey(group: "title" | "details", key: string, p: Vals, lang: Lang): string | undefined {
  const shown = withPeople(p, lang);
  if (key.startsWith("setups.")) return setupsT.tryFor(lang, key.slice("setups.".length), shown);
  // Keys of other areas' namespaces (routes/rules.ts, routes/behavior.ts write `rules.activity.*` / `behavior.activity.*`).
  if (key.startsWith("rules.")) return rulesT.tryFor(lang, key.slice("rules.".length), shown);
  if (key.startsWith("behavior.")) return behaviorT.tryFor(lang, key.slice("behavior.".length), shown);
  return activityT.tryFor(lang, `${group}.${key}`, shown);
}

type Legacy = { re: RegExp; key: string; map?: (m: RegExpMatchArray) => Vals };
/* Russian texts written before `params` (input parsing of stored data, not display). */
const LEGACY_TITLE: Legacy[] = [
  { re: /^разбор #(\d+)$/, key: "trade_review", map: (m) => ({ reviewId: m[1]! }) }, // i18n-ignore (legacy row pattern)
  { re: /^Итоги дня (\d{4}-\d{2}-\d{2})$/, key: "eod_day", map: (m) => ({ date: m[1]! }) }, // i18n-ignore (legacy row pattern)
  { re: /^(.+) \(восстановлен\)$/, key: "trade_restored", map: (m) => ({ ticker: m[1]! }) }, // i18n-ignore (legacy row pattern)
  { re: /^(\d+) трейд\(ов\) · массово$/, key: "trades_bulk", map: (m) => ({ count: Number(m[1]) }) }, // i18n-ignore (legacy row pattern)
  { re: /^Отчёты: (\d+) событий на (\d+) дн\.$/, key: "earnings_import", map: (m) => ({ count: Number(m[1]), days: m[2]! }) }, // i18n-ignore (legacy row pattern)
  { re: /^Автопривязка сделок$/, key: "autolink" }, // i18n-ignore (legacy row pattern)
  { re: /^Пример: (.+)$/, key: "example", map: (m) => ({ ticker: m[1]! }) }, // i18n-ignore (legacy row pattern)
  // «Закир, 2026-10-12» (eod reviewed, before params): any other title of this shape renders unchanged.
  { re: /^(.+), (\d{4}-\d{2}-\d{2})$/, key: "eod_reviewed", map: (m) => ({ trader: m[1]!, date: m[2]! }) },
];
const LEGACY_DETAILS: Legacy[] = [
  { re: /^Привязано сделок: (\d+)$/, key: "autolinked", map: (m) => ({ count: m[1]! }) }, // i18n-ignore (legacy row pattern)
  { re: /^Папка объединена: "(.*)" → "(.*)"$/, key: "folderMerged", map: (m) => ({ from: m[1]!, to: m[2]! }) }, // i18n-ignore (legacy row pattern)
  { re: /^Папка переименована: "(.*)" → "(.*)"$/, key: "folderRenamed", map: (m) => ({ from: m[1]!, to: m[2]! }) }, // i18n-ignore (legacy row pattern)
  { re: /^Папка удалена \((\d+) стратегий\)$/, key: "folderDeleted", map: (m) => ({ count: Number(m[1]) }) }, // i18n-ignore (legacy row pattern)
  { re: /^Офис$/, key: "createdOffice" }, // i18n-ignore (legacy row pattern)
  { re: /^Мой$/, key: "createdMine" }, // i18n-ignore (legacy row pattern)
  { re: /^Офис · папка: (.+)$/, key: "createdOfficeFolder", map: (m) => ({ folder: m[1]! }) }, // i18n-ignore (legacy row pattern)
  { re: /^Мой · папка: (.+)$/, key: "createdMineFolder", map: (m) => ({ folder: m[1]! }) }, // i18n-ignore (legacy row pattern)
  { re: /^Обновлён сетап$/, key: "setupUpdated" }, // i18n-ignore (legacy row pattern)
  { re: /^Папка: (.+)$/, key: "folder", map: (m) => ({ folder: m[1]! }) }, // i18n-ignore (legacy row pattern)
  { re: /^Восстановлен из корзины$/, key: "restored" }, // i18n-ignore (legacy row pattern)
  { re: /^Эталоны \(Tier (\d)\): \+(\d+)$/, key: "examplesAdded", map: (m) => ({ tier: m[1]!, count: m[2]! }) }, // i18n-ignore (legacy row pattern)
  { re: /^Эталон убран \(сделка #(\d+)\)$/, key: "exampleRemoved", map: (m) => ({ trade: m[1]! }) }, // i18n-ignore (legacy row pattern)
  { re: /^Скопирован в «Мой» из #(\d+)$/, key: "copiedToMine", map: (m) => ({ id: m[1]! }) }, // i18n-ignore (legacy row pattern)
  { re: /^Предложен в офисный плейбук$/, key: "proposedOffice" }, // i18n-ignore (legacy row pattern)
  { re: /^Перенесён в Офис из «Мой» \((.*)\), эталонов: (\d+)$/, key: "movedToOffice", map: (m) => ({ trader: m[1]!, count: m[2]! }) }, // i18n-ignore (legacy row pattern)
  { re: /^Доступ закрыт$/, key: "accessClosed" }, // i18n-ignore (legacy row pattern)
  { re: /^Открыт всему офису$/, key: "accessAll" }, // i18n-ignore (legacy row pattern)
  { re: /^Сетап одобрен$/, key: "verdictApproved" }, // i18n-ignore (legacy row pattern)
  { re: /^Сетап отправлен на доработку$/, key: "verdictNeedsWork" }, // i18n-ignore (legacy row pattern)
  { re: /^Сетап выведен из работы$/, key: "verdictRetired" }, // i18n-ignore (legacy row pattern)
  { re: /^Сетап отмечен проверенным$/, key: "reviewed" }, // i18n-ignore (legacy row pattern)
  { re: /^Снята отметка «проверено»$/, key: "unreviewed" }, // i18n-ignore (legacy row pattern)
  { re: /^(-?\d+(?:\.\d+)?) нетто$/, key: "eodNet", map: (m) => ({ net: m[1]! }) }, // i18n-ignore (legacy row pattern)
];
const LEGACY_ACCESS_CUSTOM = /^Открыт: (.*)$/; // i18n-ignore (legacy row pattern)
const LEGACY_COHORT = /^когорта #(\d+)$/; // i18n-ignore (legacy row pattern)

function legacy(group: "title" | "details", text: string, lang: Lang): string | undefined {
  if (group === "details") {
    const m = text.match(LEGACY_ACCESS_CUSTOM);
    if (m) return accessCustomText(m[1]!.split(", ").map((x) => x.match(LEGACY_COHORT)?.[1] ?? x), m[1]!.split(", ").map((x) => LEGACY_COHORT.test(x)), lang);
  }
  for (const l of group === "title" ? LEGACY_TITLE : LEGACY_DETAILS) {
    const m = text.match(l.re);
    if (m) return renderKey(group, l.key, l.map ? l.map(m) : {}, lang);
  }
  return undefined;
}

function accessCustomText(items: string[], cohortFlags: boolean[], lang: Lang): string {
  const t = activityT.tFor(lang);
  return t("details.accessCustom", { list: items.map((x, i) => (cohortFlags[i] ? t("details.cohort", { id: x }) : personNameFor(x, lang))).join(", ") });
}

/** «Открыт: Умид, когорта #3» as data: params for logActivity + the RU fallback text. */
export function accessCustomParams(users: string[], cohorts: Array<number | string>): { details: string; params: ActivityParams } {
  const list = [...users, ...cohorts.map(String)];
  const flags = [...users.map(() => false), ...cohorts.map(() => true)];
  return { details: accessCustomText(list, flags, "ru"), params: { detailsKey: "accessCustom", users: users.join("\u001f"), cohorts: cohorts.join(",") } };
}

/** Title / details of an activity row in `lang` (stored text when nothing better is known). */
export function localizeActivity(
  row: { entityTitle: string | null; details: string | null; params?: ActivityParams | null },
  lang: Lang,
): { entityTitle: string | null; details: string | null } {
  if (lang === "ru") return { entityTitle: row.entityTitle, details: row.details };
  const p = row.params ?? null;
  let entityTitle = row.entityTitle;
  let details = row.details;
  if (p && typeof p.titleKey === "string") entityTitle = renderKey("title", p.titleKey, vals(p), lang) ?? entityTitle;
  else if (entityTitle) entityTitle = legacy("title", entityTitle, lang) ?? entityTitle;
  if (p && p.detailsKey === "accessCustom") {
    const users = typeof p.users === "string" && p.users ? p.users.split("\u001f") : [];
    const cohorts = typeof p.cohorts === "string" && p.cohorts ? p.cohorts.split(",") : [];
    details = accessCustomText([...users, ...cohorts], [...users.map(() => false), ...cohorts.map(() => true)], lang);
  } else if (p && typeof p.detailsKey === "string") details = renderKey("details", p.detailsKey, vals(p), lang) ?? details;
  else if (details) details = legacy("details", details, lang) ?? details;
  return { entityTitle, details };
}

/** RU fallback text + params for a generated activity title / details (`activity` namespace keys). */
export function activityTitle(key: string, p: Vals = {}): string {
  return renderKey("title", key, p, "ru") ?? key;
}
export function activityDetails(key: string, p: Vals = {}): string {
  return renderKey("details", key, p, "ru") ?? key;
}
