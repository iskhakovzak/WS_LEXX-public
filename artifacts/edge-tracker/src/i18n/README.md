# i18n — RU / EN / UZ

Custom, no dependency. RU is the source; EN/UZ are lazy chunks. Terms: [GLOSSARY.md](./GLOSSARY.md). Reference implementation: `components/shell/*`, `components/layout.tsx`, `components/global-search.tsx`.

## Add a namespace (one per area)

```ts
// i18n/locales/ru/trades.ts — source of truth, `as const` (tsc then checks {params} and keys)
export default {
  title: "Сделки",
  filters: { side: { long: "Лонг", short: "Шорт" } },              // key "filters.side.long"
  rows: { one: "{count} строка", few: "{count} строки", many: "{count} строк", other: "{count} строки" },
  byTrader: "Сделки {name}",
} as const;

// i18n/locales/en/trades.ts  (uz/trades.ts the same) — tsc fails on a missing or extra key
import type { Messages } from "../../core";
import type ru from "../ru/trades";
export default { title: "Trades", filters: { side: { long: "Long", short: "Short" } },
  rows: { one: "{count} row", other: "{count} rows" }, byTrader: "{name}’s trades" } satisfies Messages<typeof ru>;

// i18n/ns/trades.ts
import { createNamespace } from "..";
import ru from "../locales/ru/trades";
export const tradesI18n = createNamespace("trades", ru, {
  en: () => import("../locales/en/trades"),
  uz: () => import("../locales/uz/trades"),
});
```

## Use it

```tsx
const { t } = tradesI18n.useT();            // components (re-render on switch / when EN arrives)
t("filters.side.long");
t("rows", { count: n });                    // plural keys REQUIRE { count }; count gets locale grouping
t("byTrader", { name });                    // {params} in RU are required, typos are tsc errors
tradesI18n.t("title");                      // plain TS (lib, formatters): reads the current language
tradesI18n.tryT(`status.${code}`);          // runtime-built key → string | undefined (server enums)
commonI18n.t("actions.save");               // shared words: i18n/ns/common.ts (read-only for areas)
shellI18n.t("nav.playbook");                // section names
```

- **Never call `t()` at module scope** (`const LABELS = { a: t("…") }` freezes one language). Use a function, a getter (see `components/shell/nav.ts`) or compute in render.
- Template keys need a key **union**, not a bare generic: `t(\`status.${s}\`)` works when `s: "open" | "closed"`; widen a generic `K` first (`const k: Status = key`). For `string`, use `tryT`.
- Never glue translated fragments into sentences; one key with `{params}`. Separators (` · `, `, `) between independent items are fine.
- Need a shared word that is not in `common`? Put it in your own namespace (don't edit `common`).
- Weekday / month names, dates, relative time: `i18n/format.ts`, not dictionary entries.
- Code → label maps used at module scope: ``liveLabels(keys, (k) => ns.t(`x.${k}`))`` from `@/i18n` (getters, read in the current language on access). Rich text with a node inside a sentence: `rich(t("k", slots("term")), { term: <b/> })` from `@/i18n/rich`.
- A namespace used only in a lazily loaded dialog may flash RU for a few ms on first open in EN/UZ; if it matters, `await ns.ready()` in the lazy loader. Route pages are already covered (`route-loaders.ts` awaits `i18nReady()`).
- Server queries: language switches re-fetch active queries (server texts follow `X-Lang`). A heavy language-independent query can opt out: `meta: { i18n: false }`.
- Component-local state below `<I18nProvider>` resets on a language switch (the tree re-mounts); URL state, query cache, auth and theme survive.

## Formatting and plurals (`@/lib/format`)

One module for every number, date and plural: `import { … } from "@/lib/format"` (it re-exports `i18n/format.ts`). No local `fmtUsd`/`fmtPct`/`plural` copies, no `"ru-RU"`, no module-level `new Intl.*` with the UI locale (ratchet: `lib/format/ratchet.json`).

- **Trading format, identical in RU/EN/UZ** (en-US digits, U+2212 minus, never "−0"): `fmtUsd(v, { signed?, decimals?: 2 | n | "auto" | "trim", compact?: true | 10_000 })` → `$1,234.56`, `+$1,234.56`, `$12.3K` · `fmtPct(v)` (value in %, signed) → `+1.23%` · `fmtRate(x)` (share 0…1) → `57%` · `fmtR(v)` → `+0.21R` · `fmtPrice(v)` → `920.74` / `0.4521` · `fmtNum(v)` / `fmtRatio(pf)` → `1.86` / `∞` · `fmtCompact(v)` → `3.4M`. All take `fallback` (default "—").
- **Follow the language** (read at call time; call in render, never at module scope): `fmtCount(n)` · `fmtDate(d, style, { timeZone? })` with styles `short` `shortYY` `medium` `long` `full` `dayMonth` `dayMonthLong` `dayMonthNumeric` `weekdayDayMonth` `weekdayDayMonthLong` `monthYear` `time` `timeSeconds` `dateTime` `numericDateTime` `shortDateTime` · `fmtDateCustom(d, Intl options)` for a rare shape (add a style when it repeats) · `fmtDateRange(from, to, "long"|"short")` → «12–16 октября 2026 г.» / «October 12 – 16, 2026» / «2026-yil 12–16-oktabr» · `fmtMonth(0..11 | Date, "long"|"short")` · `fmtWeekday(0..6 | Date, "long"|"short"|"narrow")` · `fmtRelative(d)` · `fmtTimeNY(d)` · `localeTag()`. Uzbek dates/relative time are hand-written (`i18n/uz-date.ts`: browsers lack uz CLDR data) — never pass `localeTag()` to a third-party `Intl` user (charts) for display without a formatter.
- **Plurals.** Common units: `commonI18n.t("units.trades", { count })` (also days, tradingDays, weeks, months, minutes, hours, tickers, setups, ideas, events, violations, traders, points, lessons, items, entries, wins, losses; `units.tradesWord` = the word alone). Every other noun still goes through `pluralRu(n, one, few, many)` from `@/lib/format` — the single RU rule left for the wave: **when you translate an area, replace each `pluralRu(` call in it with a plural entry in the area namespace** (`t("articles", { count })`), in the same edit that translates the noun. `grep -rn "pluralRu(" <area>` lists them. Don't add new local plural helpers or new `pluralRu` calls.

## Do not translate

Tickers, codes (OPG, MOC, Day…), metrics (P&L, R, MAE, VWAP, ATR, RVOL, float, gap, halt…), Long/Short (RU «Лонг/Шорт»), product names (WS_LEXX, PropReports, Telegram, Big 7), user content (names, setup names, notes, comments, folders, tags). Full list: GLOSSARY.md.

## Language state

`useLang()`, `getLang()`, `setLang(lang, { source: "user" })`. Saved in localStorage `ws_lexx_lang` and `users.locale` (`PATCH /api/users/me/locale`, `i18n/locale-sync.tsx`). Every `/api` request sends `X-Lang` (`lib/install-fetch-auth.ts`). Switchers: top bar, user menu (phones), Settings → Профиль, login page, palette «Язык: …».

Server: `artifacts/api-server/src/i18n` — same dictionaries (`<lang>/<ns>.ts`), `commonT.tFor(langOf(req))("errors.forbidden")`; texts stored/sent later (notifications, Telegram) use `tFor(await localeOfUser(recipient))`. Server-side caches of generated text must include the language in the key.

## Progress report

```
pnpm --filter @workspace/edge-tracker run i18n:report                       # totals per area, top files
pnpm --filter @workspace/edge-tracker run i18n:report -- --path src/components/trades --list
pnpm --filter @workspace/edge-tracker run i18n:report -- --check src/components/trades   # exit 1 if not 0
pnpm --filter @workspace/edge-tracker run i18n:report -- --freq 100        # most repeated literals
pnpm --filter @workspace/api-server run i18n:report -- --check src/routes/trades.ts
```

Skipped: comments, tests, dictionaries, `keywords:` search synonyms, lines with an `i18n-ignore` comment (same or previous line), `src/i18n/allowlist.json` (Russian-input parsers, seed data, fixtures only).

## Area done — checklist

- [ ] `i18n:report -- --check <your paths>` → 0 (frontend and, if touched, API).
- [ ] RU text unchanged on screen; EN and UZ written by hand from the glossary (no machine-literal UZ; `ʻ` = U+02BB).
- [ ] Plurals via plural entries (every `pluralRu(` in the area converted), numbers/dates via `@/lib/format`, no `"ru-RU"` left.
- [ ] Switched RU → EN → UZ → RU on every page of the area at 1280–1920 and 390: no overflow/clipping (long labels get `title`), no flashes of RU, toasts and empty/error states translated.
- [ ] Server texts your area returns use `langOf(req)`; stored/sent texts use the recipient's locale.
- [ ] `npx tsc -p tsconfig.json --noEmit` clean; tests updated (RU expectations still pass with the default language).
