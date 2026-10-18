import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { commonT } from "./ns";
import { langOf, parseLang, pluralCategory } from ".";

describe("server i18n", () => {
  it("translates per language with RU fallback", () => {
    expect(commonT.tFor("ru")("errors.forbidden")).toBe("Недостаточно прав для этого действия");
    expect(commonT.tFor("en")("errors.forbidden")).toBe("You don’t have permission to do this");
    expect(commonT.tFor("uz")("errors.notFound")).toBe("Topilmadi");
    expect(commonT.tFor(null)("errors.notFound")).toBe("Не найдено");
    expect(commonT.tFor("en")("errors.invalidLocale", { value: "de" })).toBe("Unknown language: de");
    expect(commonT.tryFor("en", "errors.nope")).toBeUndefined();
  });

  it("plurals", () => {
    expect(commonT.tFor("ru")("units.trades", { count: 5 })).toBe("5 сделок");
    expect(commonT.tFor("ru")("units.trades", { count: 22 })).toBe("22 сделки");
    expect(commonT.tFor("en")("units.trades", { count: 1 })).toBe("1 trade");
    expect(commonT.tFor("uz")("units.trades", { count: 3 })).toBe("3 ta savdo");
    expect(pluralCategory("uz", 1)).toBe("one");
  });

  it("request language", () => {
    expect(parseLang("en-US")).toBe("en");
    expect(parseLang("UZ")).toBe("uz");
    expect(parseLang("de")).toBeNull();
    const req = (h: Record<string, string>, lang?: "ru" | "en" | "uz") =>
      ({ lang, get: (n: string) => h[n.toLowerCase()] }) as unknown as Request;
    expect(langOf(req({ "x-lang": "uz" }))).toBe("uz");
    expect(langOf(req({}, "en"))).toBe("en");
    expect(langOf(req({}))).toBe("ru");
  });
});
