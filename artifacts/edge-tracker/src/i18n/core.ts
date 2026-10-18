/**
 * i18n core: languages, dictionary types, interpolation and plurals. Pure (no React, no DOM, no state), so it
 * runs in tests, workers and plain TS. The server keeps a copy of this file in api-server/src/i18n/core.ts.
 *
 * Dictionary shape (RU is the source of truth, `as const` so tsc sees literal texts and their {params}):
 *   export default {
 *     save: "Сохранить",
 *     greeting: "Привет, {name}",
 *     trades: { one: "{count} сделка", few: "{count} сделки", many: "{count} сделок", other: "{count} сделки" },
 *     filters: { side: { long: "Лонг", short: "Шорт" } },        // nesting → key "filters.side.long"
 *   } as const;
 * EN/UZ files: `export default { … } satisfies Messages<typeof ru>;` → tsc rejects missing or extra keys.
 * A plural entry is an object with `one` + `other` (RU adds `few` + `many`); never use `one`/`other` as names of
 * ordinary nested keys.
 */

export type Lang = "ru" | "en" | "uz";
export const LANGS: readonly Lang[] = ["ru", "en", "uz"];
export const DEFAULT_LANG: Lang = "ru";

/** Native names for the switcher (never translated) and short codes for the top-bar button. */
export const LANG_META: Record<Lang, { native: string; code: string; tag: string }> = {
  ru: { native: "Русский", code: "RU", tag: "ru-RU" }, // i18n-ignore (native name)
  en: { native: "English", code: "EN", tag: "en-US" },
  uz: { native: "Oʻzbekcha", code: "UZ", tag: "uz-Latn-UZ" },
};

export function isLang(v: unknown): v is Lang {
  return v === "ru" || v === "en" || v === "uz";
}

/**
 * Locale for Intl.NumberFormat. Uzbek digits follow CLDR uz (non-breaking-space grouping, decimal comma), which is
 * the same shape as ru; browsers often ship no `uz` number data and would print "1,234.5".
 */
export function numberLocaleFor(lang: Lang): string {
  return lang === "uz" ? LANG_META.ru.tag : LANG_META[lang].tag;
}

/** BCP 47 tag for Intl: ru-RU / en-US / uz-Latn-UZ. */
export function localeTagFor(lang: Lang): string {
  return LANG_META[lang].tag;
}

// ─── Types ───────────────────────────────────────────────────────────────────────────────────────────────

export type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";
/** RU: one/few/many/other. EN, UZ: one/other. */
export type PluralForms = { one: string; other: string; few?: string; many?: string };
type PluralLike = { readonly one: string; readonly other: string };

export type Dict = { readonly [key: string]: string | PluralLike | Dict };

/** Shape EN/UZ must satisfy for a RU dictionary T: same keys, any text, plural entries may drop few/many. */
export type Messages<T> = {
  [K in keyof T]: T[K] extends string ? string : T[K] extends PluralLike ? PluralForms : Messages<T[K]>;
};

type Join<P extends string, K extends string> = P extends "" ? K : `${P}.${K}`;

/** Every translatable key of T as a dotted path ("filters.side.long"). */
export type Keys<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string
    ? Join<P, K>
    : T[K] extends PluralLike
      ? Join<P, K>
      : Keys<T[K], Join<P, K>>;
}[keyof T & string];

/** Keys whose entry is a plural object (they require `{ count }`). */
export type PluralKeys<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string
    ? never
    : T[K] extends PluralLike
      ? Join<P, K>
      : PluralKeys<T[K], Join<P, K>>;
}[keyof T & string];

/** Entry at a dotted path. */
export type ValueAt<T, K extends string> = K extends `${infer H}.${infer R}`
  ? H extends keyof T
    ? ValueAt<T[H], R>
    : never
  : K extends keyof T
    ? T[K]
    : never;

/** "{name} и {count}" → "name" | "count" (works on `as const` literals; plain `string` yields never). */
export type ExtractParams<S> = S extends `${string}{${infer P}}${infer Rest}` ? P | ExtractParams<Rest> : never;

type ParamNames<V> = V extends string ? ExtractParams<V> : V extends PluralLike ? ExtractParams<V[keyof V] & string> : never;

export type ParamValue = string | number;
export type Params = Record<string, ParamValue>;

/** Arguments after the key: plural → `{ count, …params }` required; text with {params} → those params required; else optional. */
export type TArgs<V> = V extends PluralLike
  ? [params: { count: number } & { [P in Exclude<ParamNames<V>, "count">]: ParamValue }]
  : [ParamNames<V>] extends [never]
    ? [params?: Params]
    : [params: { [P in ParamNames<V>]: ParamValue }];

/** Typed translator for dictionary D. */
export type TFunction<D> = <K extends Keys<D>>(key: K, ...args: TArgs<ValueAt<D, K>>) => string;

// ─── Runtime ─────────────────────────────────────────────────────────────────────────────────────────────

const pluralRulesCache = new Map<Lang, Intl.PluralRules>();
const numberFmtCache = new Map<Lang, Intl.NumberFormat>();

/** CLDR plural category for `n` in `lang` (ru: one/few/many/other; en, uz: one/other). */
export function pluralCategory(lang: Lang, n: number): PluralCategory {
  let pr = pluralRulesCache.get(lang);
  if (!pr) {
    pr = new Intl.PluralRules(lang);
    pluralRulesCache.set(lang, pr);
  }
  return pr.select(n) as PluralCategory;
}

/** Locale number grouping for counts (1 234 / 1,234 / 1 234). */
export function formatCountFor(lang: Lang, n: number): string {
  let nf = numberFmtCache.get(lang);
  if (!nf) {
    nf = new Intl.NumberFormat(numberLocaleFor(lang), { maximumFractionDigits: 2 });
    numberFmtCache.set(lang, nf);
  }
  return nf.format(n);
}

/** Pick the form for `count`; a missing category falls back to other → many → one. */
export function selectPlural(lang: Lang, forms: PluralForms, count: number): string {
  const cat = pluralCategory(lang, count);
  return (forms as Record<string, string | undefined>)[cat] ?? forms.other ?? forms.many ?? forms.one;
}

/**
 * "{name} открыл {count}" + params → text. Unknown placeholders stay as written (visible in QA).
 * `count` is formatted with locale grouping; other numbers are inserted as is (pass preformatted strings
 * for money/prices, which keep the trading format in every language).
 */
export function interpolate(template: string, params: Params | undefined, lang: Lang = DEFAULT_LANG): string {
  if (!params || template.indexOf("{") < 0) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = params[name];
    if (v === undefined || v === null) return whole;
    if (name === "count" && typeof v === "number") return formatCountFor(lang, v);
    return String(v);
  });
}

function isPluralEntry(v: unknown): v is PluralForms {
  return !!v && typeof v === "object" && typeof (v as PluralForms).one === "string" && typeof (v as PluralForms).other === "string";
}

/** Raw entry at a dotted path, or undefined. */
export function lookup(dict: Dict | undefined, key: string): string | PluralForms | undefined {
  if (!dict) return undefined;
  let cur: unknown = dict;
  for (const part of key.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  if (typeof cur === "string" || isPluralEntry(cur)) return cur;
  return undefined;
}

/** Render one entry (string or plural) for `lang`. */
export function renderEntry(entry: string | PluralForms, lang: Lang, params?: Params): string {
  if (typeof entry === "string") return interpolate(entry, params, lang);
  const count = typeof params?.count === "number" ? params.count : Number(params?.count ?? 0);
  return interpolate(selectPlural(lang, entry, Number.isFinite(count) ? count : 0), params, lang);
}

/**
 * Translate `key`: the `lang` dictionary first, then RU (also used when a lazy dictionary failed to load).
 * A key missing everywhere returns the key itself (visible, never a crash).
 */
export function translate(dicts: { ru: Dict; current?: Dict }, lang: Lang, key: string, params?: Params): string {
  const own = lang === "ru" ? undefined : lookup(dicts.current, key);
  if (own !== undefined) return renderEntry(own, lang, params);
  const ru = lookup(dicts.ru, key);
  if (ru !== undefined) return renderEntry(ru, "ru", params);
  return key;
}
