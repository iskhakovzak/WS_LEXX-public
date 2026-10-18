import { afterEach, describe, expect, it, vi } from "vitest";
import { interpolate, pluralCategory, selectPlural, translate, lookup, isLang, type Dict } from "./core";
import { createNamespace, getLang, i18nReady, setLang } from "./index";
import { fmtCount, fmtDate, fmtMonth, fmtRelative, fmtTimeNY, fmtWeekday, localeTag } from "./format";
import { commonI18n } from "./ns/common";
import { pluralRu } from "@/lib/format";

const TRADES = { one: "{count} сделка", few: "{count} сделки", many: "{count} сделок", other: "{count} сделки" };

describe("plurals", () => {
  it("ru: one / few / many / other", () => {
    expect([1, 21, 101].map((n) => pluralCategory("ru", n))).toEqual(["one", "one", "one"]);
    expect([2, 3, 4, 22, 104].map((n) => pluralCategory("ru", n))).toEqual(["few", "few", "few", "few", "few"]);
    expect([0, 5, 11, 12, 14, 111, 25].map((n) => pluralCategory("ru", n))).toEqual(Array(7).fill("many"));
    expect(pluralCategory("ru", 1.5)).toBe("other");
    expect(selectPlural("ru", TRADES, 1)).toBe("{count} сделка");
    expect(selectPlural("ru", TRADES, 3)).toBe("{count} сделки");
    expect(selectPlural("ru", TRADES, 11)).toBe("{count} сделок");
  });

  it("en: one / other", () => {
    expect(pluralCategory("en", 1)).toBe("one");
    expect(pluralCategory("en", 0)).toBe("other");
    expect(pluralCategory("en", 2)).toBe("other");
    expect(pluralCategory("en", 21)).toBe("other");
  });

  it("uz: one / other", () => {
    expect(pluralCategory("uz", 1)).toBe("one");
    expect(pluralCategory("uz", 5)).toBe("other");
  });

  it("falls back to other when a category is missing (EN forms used for ru counts)", () => {
    expect(selectPlural("ru", { one: "a", other: "b" }, 5)).toBe("b");
  });

  it("pluralRu keeps its signature on top of Intl", () => {
    const w = (n: number) => pluralRu(n, "сделка", "сделки", "сделок");
    expect([1, 2, 5, 11, 21, 22, 25, 0].map(w)).toEqual(["сделка", "сделки", "сделок", "сделок", "сделка", "сделки", "сделок", "сделок"]);
  });
});

describe("interpolate", () => {
  it("replaces params, formats count, leaves unknown placeholders", () => {
    expect(interpolate("Привет, {name}", { name: "Закир" })).toBe("Привет, Закир");
    expect(interpolate("{count} шт.", { count: 1234 }, "en")).toBe("1,234 шт.");
    expect(interpolate("{count}", { count: 1234 }, "ru")).toBe(new Intl.NumberFormat("ru-RU").format(1234));
    expect(interpolate("{year} год", { year: 2026 }, "ru")).toBe("2026 год");
    expect(interpolate("{a} и {b}", { a: "x" })).toBe("x и {b}");
    expect(interpolate("без параметров", undefined)).toBe("без параметров");
  });
});

describe("translate / lookup", () => {
  const ru: Dict = { a: { b: "РУ {x}" }, n: TRADES, only: "только ру" };
  const en: Dict = { a: { b: "EN {x}" }, n: { one: "{count} trade", other: "{count} trades" } };

  it("uses the language dictionary, then RU, then the key", () => {
    expect(translate({ ru, current: en }, "en", "a.b", { x: 1 })).toBe("EN 1");
    expect(translate({ ru, current: en }, "en", "n", { count: 2 })).toBe("2 trades");
    expect(translate({ ru, current: en }, "en", "only")).toBe("только ру");
    expect(translate({ ru, current: en }, "en", "missing.key")).toBe("missing.key");
    expect(translate({ ru }, "ru", "n", { count: 5 })).toBe("5 сделок");
  });

  it("does not treat groups as entries", () => {
    expect(lookup(ru, "a")).toBeUndefined();
    expect(isLang("uz")).toBe(true);
    expect(isLang("de")).toBe(false);
  });
});

describe("namespaces and switching", () => {
  afterEach(async () => {
    await setLang("ru", { source: "init" });
  });

  it("loads EN lazily and falls back to RU when a loader fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const good = createNamespace("test-good", { hi: "Привет" } as const, {
      en: async () => ({ default: { hi: "Hello" } }),
      uz: async () => ({ default: { hi: "Salom" } }),
    });
    const bad = createNamespace("test-bad", { hi: "Привет" } as const, {
      en: () => Promise.reject(new Error("chunk failed")),
      uz: () => Promise.reject(new Error("chunk failed")),
    });
    expect(good.t("hi")).toBe("Привет");
    await setLang("en", { source: "init" });
    expect(getLang()).toBe("en");
    expect(good.t("hi")).toBe("Hello");
    expect(bad.t("hi")).toBe("Привет");
    expect(warn).toHaveBeenCalled();
    await setLang("uz", { source: "init" });
    expect(good.t("hi")).toBe("Salom");
    expect(good.tryT("nope")).toBeUndefined();
    warn.mockRestore();
  });

  it("common: plural units in all three languages", async () => {
    expect(commonI18n.t("units.trades", { count: 5 })).toBe("5 сделок");
    await setLang("en", { source: "init" });
    await i18nReady();
    expect(commonI18n.t("units.trades", { count: 1 })).toBe("1 trade");
    expect(commonI18n.t("units.trades", { count: 5 })).toBe("5 trades");
    await setLang("uz", { source: "init" });
    expect(commonI18n.t("units.trades", { count: 5 })).toBe("5 ta savdo");
    expect(commonI18n.t("actions.save")).toBe("Saqlash");
  });
});

describe("format", () => {
  afterEach(async () => {
    await setLang("ru", { source: "init" });
  });

  it("follows the UI language", async () => {
    const d = new Date(2026, 9, 17, 14, 5);
    expect(localeTag()).toBe("ru-RU");
    expect(fmtDate("2026-10-17", "long")).toBe("17 октября 2026 г.");
    expect(fmtMonth(0)).toBe("январь");
    expect(fmtWeekday(1, "long")).toBe("понедельник");
    expect(fmtDate(d, "time")).toBe("14:05");
    expect(fmtDate("not a date")).toBe("—");
    await setLang("en", { source: "init" });
    expect(fmtDate("2026-10-17", "long")).toBe("October 17, 2026");
    expect(fmtCount(12345)).toBe("12,345");
    expect(fmtWeekday(1, "long")).toBe("Monday");
    expect(fmtRelative(new Date(Date.now() - 5 * 60_000))).toBe("5 minutes ago");
    await setLang("uz", { source: "init" });
    expect(localeTag()).toBe("uz-Latn-UZ");
    expect(fmtRelative(new Date(Date.now() - 5 * 60_000))).toBe("5 daqiqa oldin");
    expect(fmtWeekday(6, "long")).toBe("shanba");
  });

  it("fmtTimeNY is 24h New York time", () => {
    expect(fmtTimeNY(new Date(Date.UTC(2026, 9, 16, 13, 30)))).toBe("09:30");
  });
});
