/**
 * Compile-time tests for the dictionary types. Not imported anywhere and not a *.test.ts file on purpose:
 * `tsc --noEmit` (tsconfig excludes *.test.ts) checks it, so every `@ts-expect-error` below must stay an error.
 */
import type { Messages, TFunction, Keys, PluralKeys } from "./core";

const ru = {
  save: "Сохранить",
  greet: "Привет, {name}",
  trades: { one: "{count} сделка", few: "{count} сделки", many: "{count} сделок", other: "{count} сделки" },
  byTrader: { one: "{count} сделка у {name}", few: "{count} сделки у {name}", many: "{count} сделок у {name}", other: "{count} сделки у {name}" },
  filters: { side: { long: "Лонг", short: "Шорт" } },
} as const;

// EN with every key: OK (plural may drop few/many).
export const enOk = {
  save: "Save",
  greet: "Hi, {name}",
  trades: { one: "{count} trade", other: "{count} trades" },
  byTrader: { one: "{count} trade by {name}", other: "{count} trades by {name}" },
  filters: { side: { long: "Long", short: "Short" } },
} satisfies Messages<typeof ru>;

// Missing key → error.
export const enMissing = {
  save: "Save",
  trades: { one: "{count} trade", other: "{count} trades" },
  byTrader: { one: "x", other: "y" },
  filters: { side: { long: "Long", short: "Short" } },
  // @ts-expect-error `greet` is missing (reported on the satisfies clause)
} satisfies Messages<typeof ru>;

// Missing nested key → error.
export const enMissingNested = {
  save: "Save",
  greet: "Hi",
  trades: { one: "{count} trade", other: "{count} trades" },
  byTrader: { one: "x", other: "y" },
  // @ts-expect-error `filters.side.short` is missing
  filters: { side: { long: "Long" } },
} satisfies Messages<typeof ru>;

export const enExtra = {
  save: "Save",
  greet: "Hi",
  trades: { one: "{count} trade", other: "{count} trades" },
  byTrader: { one: "x", other: "y" },
  filters: { side: { long: "Long", short: "Short" } },
  // @ts-expect-error extra key not in RU
  extra: "Extra",
} satisfies Messages<typeof ru>;

// Plural without `other` → error.
export const enBadPlural = {
  save: "Save",
  greet: "Hi",
  // @ts-expect-error plural needs `other`
  trades: { one: "{count} trade" },
  byTrader: { one: "x", other: "y" },
  filters: { side: { long: "Long", short: "Short" } },
} satisfies Messages<typeof ru>;

declare const t: TFunction<typeof ru>;

t("save");
t("filters.side.long");
t("greet", { name: "Закир" });
t("trades", { count: 3 });
t("byTrader", { count: 3, name: "Артур" });

// @ts-expect-error unknown key
t("nope");
// @ts-expect-error unknown nested key
t("filters.side.flat");
// @ts-expect-error a group is not a key
t("filters.side");
// @ts-expect-error plural key requires { count }
t("trades");
// @ts-expect-error plural key requires count, not other params only
t("trades", { name: "x" });
// @ts-expect-error {name} is required
t("greet");
// @ts-expect-error {name} is required in a plural too
t("byTrader", { count: 1 });
// @ts-expect-error typo in a param name
t("greet", { nam: "x" });

type K = Keys<typeof ru>;
type P = PluralKeys<typeof ru>;
export const keysOk: K[] = ["save", "greet", "trades", "byTrader", "filters.side.long", "filters.side.short"];
export const pluralOk: P[] = ["trades", "byTrader"];
// @ts-expect-error `save` is not a plural key
export const pluralBad: P = "save";
