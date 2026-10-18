import { afterEach, describe, expect, it } from "vitest";
import { NAV_GROUPS, ALL_NAV_ITEMS, GO_KEYS, GO_KEYS_RU_LAYOUT, parentOf, rowChildren, rowLabel, routeTitle } from "./nav";
import { setLang } from "@/i18n";

afterEach(async () => {
  await setLang("ru", { source: "init" });
});

describe("routeTitle", () => {
  it("names sections from the nav", () => {
    expect(routeTitle("/watchlist")).toBe("Вотчлист");
    expect(routeTitle("/trade-idea-stats")).toBe("Статистика идей");
    expect(routeTitle("/error-tracker")).toBe("Правила");
    expect(routeTitle("/nope")).toBeNull();
  });

  it("tells /academy/lesson sub-views apart by the query string", () => {
    expect(routeTitle("/academy/lesson", "?quiz=3")).toBe("Тест");
    expect(routeTitle("/academy/lesson", "?assignment=7&user=x")).toBe("Задание");
    expect(routeTitle("/academy/lesson", "?id=2")).toBe("Урок");
    expect(routeTitle("/academy/lesson")).toBe("Урок");
  });

  it("follows the UI language", async () => {
    await setLang("en", { source: "init" });
    expect(routeTitle("/watchlist")).toBe("Watchlist");
    expect(routeTitle("/academy/lesson", "?quiz=3")).toBe("Quiz");
    await setLang("uz", { source: "init" });
    expect(routeTitle("/trades")).toBe("Savdolar");
    expect(ALL_NAV_ITEMS.find((i) => i.href === "/trades")!.ruName).toBe("Сделки");
  });
});

describe("nav groups", () => {
  const rows = (staff: boolean) => NAV_GROUPS.flatMap((g) => g.items).filter((i) => !i.hidden && (staff || !i.staff));

  it("keeps the sidebar short: ~15 rows for a trader, a few more for staff", () => {
    expect(rows(false).length).toBeLessThanOrEqual(16);
    expect(rows(true).length).toBeLessThanOrEqual(18);
    // Every page but the header ones (settings, notifications) is reachable from the sidebar in one or two clicks.
    expect(ALL_NAV_ITEMS.filter((i) => !i.hidden).every((i) => rows(true).includes(i) || !!parentOf(i))).toBe(true);
  });

  it("second-level pages know their row; a hub row lists its own page first", () => {
    expect(rowLabel(parentOf(ALL_NAV_ITEMS.find((i) => i.href === "/stats")!)!)).toBe("Аналитика");
    expect(parentOf(ALL_NAV_ITEMS.find((i) => i.href === "/trade-idea-stats")!)!.href).toBe("/trade-ideas");
    const tools = ALL_NAV_ITEMS.find((i) => i.href === "/chart-lab")!;
    expect(rowLabel(tools)).toBe("Инструменты");
    expect(rowChildren(tools).map((i) => i.href)).toEqual(["/chart-lab", "/simulator", "/calculator"]);
  });

  it("every item has a label and unique href / go key", () => {
    expect(ALL_NAV_ITEMS.every((i) => i.name && i.name !== `nav.${i.key}`)).toBe(true);
    expect(new Set(ALL_NAV_ITEMS.map((i) => i.href)).size).toBe(ALL_NAV_ITEMS.length);
    const keys = ALL_NAV_ITEMS.flatMap((i) => (i.goKey ? [i.goKey] : []));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every quick-jump letter also works on the Russian layout", () => {
    const mapped = new Set(Object.values(GO_KEYS_RU_LAYOUT));
    expect(Object.keys(GO_KEYS).filter((k) => !mapped.has(k))).toEqual([]);
  });
});
