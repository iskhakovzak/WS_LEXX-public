import { afterEach, describe, expect, it } from "vitest";
import { setLang, i18nReady, type Lang } from "@/i18n";
import { commonI18n } from "@/i18n/ns/common";
import { dateFnsLocale } from "./date-fns-locale";
import {
  fmtCompact,
  fmtCount,
  fmtDate,
  fmtDateCustom,
  fmtMonth,
  fmtNum,
  fmtPct,
  fmtPrice,
  fmtR,
  fmtRate,
  fmtRatio,
  fmtUsd,
  fmtWeekday,
  MINUS,
  pluralRu,
} from ".";

const M = MINUS;
const LANGS: Lang[] = ["ru", "en", "uz"];

async function inLang(lang: Lang) {
  await setLang(lang, { source: "init" });
  await i18nReady();
}

afterEach(async () => {
  await setLang("ru", { source: "init" });
});

/** Trading formats must not depend on the UI language: run the same expectations in all three. */
function eachLang(name: string, fn: () => void) {
  for (const lang of LANGS) {
    it(`${name} [${lang}]`, async () => {
      await inLang(lang);
      fn();
    });
  }
}

describe("fmtUsd", () => {
  eachLang("canonical shapes", () => {
    expect(fmtUsd(1234.56)).toBe("$1,234.56");
    expect(fmtUsd(-1234.56)).toBe(`${M}$1,234.56`);
    expect(fmtUsd(1234.56, { signed: true })).toBe("+$1,234.56");
    expect(fmtUsd(-1234.56, { signed: true })).toBe(`${M}$1,234.56`);
    expect(fmtUsd(0.5)).toBe("$0.50");
    expect(fmtUsd("1234.5")).toBe("$1,234.50");
  });

  eachLang("zero, negative zero, rounds to zero", () => {
    expect(fmtUsd(0)).toBe("$0.00");
    expect(fmtUsd(0, { signed: true })).toBe("$0.00");
    expect(fmtUsd(-0, { signed: true })).toBe("$0.00");
    expect(fmtUsd(-0.004, { signed: true })).toBe("$0.00");
    expect(fmtUsd(-0.4, { decimals: 0, signed: true })).toBe("$0");
    expect(fmtUsd(0.004, { signed: true })).toBe("$0.00");
  });

  eachLang("missing values", () => {
    expect(fmtUsd(null)).toBe("—");
    expect(fmtUsd(undefined)).toBe("—");
    expect(fmtUsd(Number.NaN)).toBe("—");
    expect(fmtUsd(Infinity)).toBe("—");
    expect(fmtUsd("")).toBe("—");
    expect(fmtUsd("abc")).toBe("—");
    expect(fmtUsd(null, { fallback: "" })).toBe("");
  });

  eachLang("decimals variants", () => {
    expect(fmtUsd(1234.56, { decimals: 0 })).toBe("$1,235");
    expect(fmtUsd(1234.56, { decimals: "auto" })).toBe("$1,235");
    expect(fmtUsd(999.5, { decimals: "auto" })).toBe("$999.50");
    expect(fmtUsd(-12345.6, { decimals: "auto", signed: true })).toBe(`${M}$12,346`);
    expect(fmtUsd(500, { decimals: "trim" })).toBe("$500");
    expect(fmtUsd(12.5, { decimals: "trim" })).toBe("$12.50");
    expect(fmtUsd(499.999, { decimals: "trim" })).toBe("$500");
  });

  eachLang("huge and tiny", () => {
    expect(fmtUsd(1234567890.12)).toBe("$1,234,567,890.12");
    expect(fmtUsd(0.001)).toBe("$0.00");
    expect(fmtUsd(1e15, { compact: true })).toBe("$1000T");
  });

  eachLang("compact thresholds", () => {
    expect(fmtUsd(950, { compact: true })).toBe("$950");
    expect(fmtUsd(999.4, { compact: true })).toBe("$999");
    expect(fmtUsd(1000, { compact: true })).toBe("$1K");
    expect(fmtUsd(1234, { compact: true })).toBe("$1.2K");
    expect(fmtUsd(-1234, { compact: true })).toBe(`${M}$1.2K`);
    expect(fmtUsd(1234, { compact: true, signed: true })).toBe("+$1.2K");
    expect(fmtUsd(12345, { compact: true })).toBe("$12.3K");
    expect(fmtUsd(99_960, { compact: true })).toBe("$100K");
    expect(fmtUsd(123_456, { compact: true })).toBe("$123K");
    expect(fmtUsd(999_600, { compact: true })).toBe("$1M");
    expect(fmtUsd(3_400_000, { compact: true })).toBe("$3.4M");
    expect(fmtUsd(1_200_000_000, { compact: true })).toBe("$1.2B");
    // Compact from $10,000 only; below it the normal (whole-dollar in compact mode) format.
    expect(fmtUsd(9_999, { compact: 10_000 })).toBe("$9,999");
    expect(fmtUsd(12_345, { compact: 10_000 })).toBe("$12.3K");
    expect(fmtUsd(950.5, { compact: true, decimals: 2 })).toBe("$950.50");
  });
});

describe("fmtPct / fmtRate", () => {
  eachLang("fmtPct: value in percent, signed by default", () => {
    expect(fmtPct(1.234)).toBe("+1.23%");
    expect(fmtPct(-1.234)).toBe(`${M}1.23%`);
    expect(fmtPct(1.25, 1)).toBe("+1.3%");
    expect(fmtPct(12, { decimals: 0, signed: false })).toBe("12%");
    expect(fmtPct(0)).toBe("0.00%");
    expect(fmtPct(-0)).toBe("0.00%");
    expect(fmtPct(-0.001, 1)).toBe("0.0%");
    expect(fmtPct(12345.678)).toBe("+12,345.68%");
    expect(fmtPct(null)).toBe("—");
    expect(fmtPct(Number.NaN)).toBe("—");
  });

  eachLang("fmtRate: share 0..1, unsigned whole by default", () => {
    expect(fmtRate(0.571)).toBe("57%");
    expect(fmtRate(0.5714, 1)).toBe("57.1%");
    expect(fmtRate(1)).toBe("100%");
    expect(fmtRate(0)).toBe("0%");
    expect(fmtRate(-0.1, { signed: true })).toBe(`${M}10%`);
    expect(fmtRate(0.1, { signed: true })).toBe("+10%");
    expect(fmtRate(undefined)).toBe("—");
    expect(fmtRate(null, { fallback: "" })).toBe("");
  });
});

describe("fmtR", () => {
  eachLang("signed, 2 decimals by default", () => {
    expect(fmtR(0.214)).toBe("+0.21R");
    expect(fmtR(-1.5)).toBe(`${M}1.50R`);
    expect(fmtR(2.46, 1)).toBe("+2.5R");
    expect(fmtR(2.46, { signed: false })).toBe("2.46R");
    expect(fmtR(-2.46, { signed: false })).toBe(`${M}2.46R`);
    expect(fmtR(0)).toBe("0.00R");
    expect(fmtR(-0)).toBe("0.00R");
    expect(fmtR(-0.004)).toBe("0.00R");
    expect(fmtR(1234.5)).toBe("+1,234.50R");
    expect(fmtR(null)).toBe("—");
    expect(fmtR(Infinity)).toBe("—");
  });
});

describe("fmtPrice", () => {
  eachLang("dot, no grouping, more decimals under $1", () => {
    expect(fmtPrice(920.74)).toBe("920.74");
    expect(fmtPrice(12.5)).toBe("12.50");
    expect(fmtPrice(1234.5)).toBe("1234.50");
    expect(fmtPrice(0.45213)).toBe("0.4521");
    expect(fmtPrice(0)).toBe("0.00");
    expect(fmtPrice(-0)).toBe("0.00");
    expect(fmtPrice(12.5, { dollar: true })).toBe("$12.50");
    expect(fmtPrice(12.5, { decimals: 3 })).toBe("12.500");
    expect(fmtPrice(12.5, { decimals: 4, trim: true })).toBe("12.5");
    expect(fmtPrice(150, { decimals: 4, trim: true })).toBe("150");
    expect(fmtPrice(0.12345, { trim: true })).toBe("0.1235");
    expect(fmtPrice("7.1")).toBe("7.10");
    expect(fmtPrice(null)).toBe("—");
    expect(fmtPrice(Number.NaN, { fallback: "" })).toBe("");
  });
});

describe("fmtNum / fmtRatio / fmtCompact", () => {
  eachLang("fmtNum: trading format", () => {
    expect(fmtNum(1.857)).toBe("1.86");
    expect(fmtNum(1234.5, 1)).toBe("1,234.5");
    expect(fmtNum(-0.5)).toBe(`${M}0.50`);
    expect(fmtNum(0.5, { signed: true })).toBe("+0.50");
    expect(fmtNum(2.5, { suffix: "×" })).toBe("2.50×");
    expect(fmtNum(-0)).toBe("0.00");
    expect(fmtNum(null)).toBe("—");
  });

  eachLang("fmtRatio: infinite profit factor", () => {
    expect(fmtRatio(1.857)).toBe("1.86");
    expect(fmtRatio(Infinity)).toBe("∞");
    expect(fmtRatio(null)).toBe("—");
    expect(fmtRatio(Number.NaN)).toBe("—");
  });

  eachLang("fmtCompact thresholds", () => {
    expect(fmtCompact(0)).toBe("0");
    expect(fmtCompact(-0)).toBe("0");
    expect(fmtCompact(950)).toBe("950");
    expect(fmtCompact(999.6)).toBe("1K");
    expect(fmtCompact(12_345)).toBe("12.3K");
    expect(fmtCompact(345_678)).toBe("346K");
    expect(fmtCompact(3_400_000)).toBe("3.4M");
    expect(fmtCompact(1.234e9)).toBe("1.2B");
    expect(fmtCompact(2.5e12)).toBe("2.5T");
    expect(fmtCompact(-12_345)).toBe(`${M}12.3K`);
    expect(fmtCompact(12_345, { signed: true })).toBe("+12.3K");
    expect(fmtCompact(undefined)).toBe("—");
  });
});

describe("language-dependent formats", () => {
  it("fmtCount follows the language", async () => {
    expect(fmtCount(1234567)).toBe(new Intl.NumberFormat("ru-RU").format(1234567));
    expect(fmtCount(null)).toBe("—");
    expect(fmtCount(Number.NaN)).toBe("—");
    await inLang("en");
    expect(fmtCount(1234567)).toBe("1,234,567");
    expect(fmtCount(-0)).toBe("0");
    await inLang("uz");
    expect(fmtCount(1234567)).toBe("1 234 567"); // CLDR uz grouping, without relying on browser uz data
    expect(fmtCount(1.5)).toBe("1,5");
  });

  it("dates, months, weekdays follow the language; no module-level locale", async () => {
    const d = new Date(2026, 9, 17, 14, 5, 9);
    expect(fmtDate(d, "dayMonth")).toBe("17 окт.");
    expect(fmtDate(d, "shortYY")).toBe("17.10.26");
    expect(fmtDate(d, "dayMonthNumeric")).toBe("17.10");
    expect(fmtDate(d, "weekdayDayMonth")).toBe("сб, 17 окт.");
    expect(fmtDate(d, "weekdayDayMonthLong")).toBe("суббота, 17 октября");
    expect(fmtDate(d, "numericDateTime")).toBe("17.10, 14:05");
    expect(fmtDate(d, "shortDateTime")).toBe("17.10.2026, 14:05");
    expect(fmtDate(d, "timeSeconds")).toBe("14:05:09");
    expect(fmtDate("2026-10-17", "short")).toBe("17.10.2026");
    expect(fmtDateCustom(d, { month: "short", year: "2-digit" })).toBe(new Intl.DateTimeFormat("ru-RU", { month: "short", year: "2-digit" }).format(d));
    expect(fmtDateCustom("garbage", { month: "short" })).toBe("—");
    expect(fmtMonth(9)).toBe("октябрь");
    await inLang("en");
    expect(fmtDate(d, "dayMonth")).toBe("Oct 17");
    expect(fmtDate(d, "weekdayDayMonth")).toBe("Sat, Oct 17");
    expect(fmtDate(d, "shortYY")).toBe("10/17/26");
    expect(fmtDate(d, "time")).toBe("14:05");
    expect(fmtMonth(9)).toBe("October");
    expect(fmtWeekday(d, "long")).toBe("Saturday");
    await inLang("uz");
    expect(fmtMonth(9)).toBe("oktabr");
    expect(fmtDate(d, "dayMonth")).toBe("17-okt");
    expect(fmtDate(d, "long")).toBe("2026-yil 17-oktabr");
    expect(fmtDate(d, "time")).toBe("14:05");
    expect(fmtDate(null)).toBe("—");
  });

  it("fmtDate with a pinned time zone", async () => {
    const d = new Date(Date.UTC(2026, 9, 17, 2, 0)); // 22:00 on Oct 16 in New York
    expect(fmtDate(d, "dayMonth", { timeZone: "America/New_York" })).toBe("16 окт.");
    expect(fmtDate(d, "time", { timeZone: "America/New_York" })).toBe("22:00");
    await inLang("en");
    expect(fmtDate(d, "dayMonth", { timeZone: "UTC" })).toBe("Oct 17");
    await inLang("uz");
    expect(fmtDate(d, "weekdayDayMonth", { timeZone: "America/New_York" })).toBe("Jum, 16-okt");
    expect(fmtDate(d, "shortDateTime", { timeZone: "America/New_York" })).toBe("16.10.2026, 22:00");
  });
});

describe("plurals", () => {
  it("pluralRu: one / few / many, 11–14, fractions, negatives, NaN", () => {
    const f = (n: number) => pluralRu(n, "сделка", "сделки", "сделок");
    expect([0, 1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111].map(f)).toEqual([
      "сделок", "сделка", "сделки", "сделки", "сделок", "сделок", "сделок", "сделок", "сделка", "сделки", "сделок", "сделка", "сделок",
    ]);
    expect(f(1.5)).toBe("сделки");
    expect(f(-1)).toBe("сделка");
    expect(f(-5)).toBe("сделок");
    expect(f(Number.NaN)).toBe("сделок");
  });

  it("common units in all three languages", async () => {
    expect(commonI18n.t("units.trades", { count: 1 })).toBe("1 сделка");
    expect(commonI18n.t("units.days", { count: 3 })).toBe("3 дня");
    expect(commonI18n.t("units.tickers", { count: 11 })).toBe("11 тикеров");
    await inLang("en");
    expect(commonI18n.t("units.trades", { count: 1 })).toBe("1 trade");
    expect(commonI18n.t("units.days", { count: 3 })).toBe("3 days");
    await inLang("uz");
    expect(commonI18n.t("units.trades", { count: 5 })).toBe("5 ta savdo");
  });
});

describe("dateFnsLocale", () => {
  it("follows the language", async () => {
    expect(dateFnsLocale().code).toBe("ru");
    await inLang("en");
    expect(dateFnsLocale().code).toBe("en-US");
    await inLang("uz");
    expect(dateFnsLocale().code).toBe("uz");
  });
});
