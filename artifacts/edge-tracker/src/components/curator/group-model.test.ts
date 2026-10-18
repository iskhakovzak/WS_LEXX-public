import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "@/i18n";
import { clearLatinNames, setLatinNames } from "@/lib/people/latin-names";
import type { TraderSignal } from "./api";
import {
  ALL_GROUPS, DEFAULT_FILTERS, NO_CURATOR, activeFilterCount, applyFilters, buildGroups, csvRow, daysSinceTrade, groupTotals,
  GROUP_SORT, pendingReviews, searchTraders, tradersOf,
} from "./group-model";

const TODAY = "2026-10-16";

function sig(trader: string, o: Partial<TraderSignal> & { r?: Partial<TraderSignal["risk"]> } = {}): TraderSignal {
  const { r, ...rest } = o;
  return {
    trader,
    stage: { key: "junior", label: "Джун", since: null },
    tier: "junior", tierName: "Джун",
    risk: {
      status: "ok", state: "ok", label: "Норма", message: "", halted: false, nearStop: false, dailyPct: 10, weeklyPct: 5, drawdownPct: 2,
      todayPnl: 0, todayTrades: 0, weekPnl: 0, openPositions: 0, hasLimits: true, templateDrift: [], ...r,
    },
    trend: [], trendDir: "none",
    discipline: { value: null, eodAvg: null, ratingAvg: null, n: 0 },
    plan: { today: null, available: false },
    eod: { prevDay: "2026-10-15", prevTraded: false, prevClosed: false, todayTraded: false, todayClosed: false, pending: 0, lastClosed: null, lastReviewedAt: null, lastScore: null },
    weekly: { currentStatus: null, submittedPending: false, lastReviewedWeek: null, lastReviewedAt: null },
    academy: { openActions: 0, overdueActions: 0, lastOneOnOne: null, daysSinceOneOnOne: null, pendingSubmissions: 0, activeGoals: 0 },
    breaches: { unreviewed: 0, last30: 0, week: 0, lastDate: null },
    lastNote: null, lastTradeDate: TODAY,
    nextAction: { kind: "none", label: "Всё в порядке", priority: 0, href: "/curator" },
    curator: null, nameLatin: null, month: { pnl: null, trades: 0 }, lastActivityAt: null,
    ...rest,
  };
}

// Real desk shape: Ольга Н. curates most «… Н.»-style names; some traders have no curator.
const DESK: TraderSignal[] = [
  sig("Никита С.", { curator: "Ольга Н.", r: { todayPnl: 120, todayTrades: 4, weekPnl: 900 }, month: { pnl: 2500, trades: 80 } }),
  sig("Кирилл Б.", { curator: "Ольга Н.", r: { halted: true, state: "stop", todayPnl: -400, todayTrades: 9, weekPnl: -700 }, breaches: { unreviewed: 1, last30: 2, week: 2, lastDate: TODAY } }),
  sig("Евгений Л.", { curator: "Ольга Н.", eod: { ...sig("x").eod, pending: 2 }, lastTradeDate: "2026-10-01", nameLatin: "Yevgeniy L." }),
  sig("Закир", { nameLatin: "Zakir Ishakov", lastTradeDate: null }),
  sig("Максим Р.", { curator: "Антон", r: { nearStop: true, state: "warn", weekPnl: 300 }, tier: "trader", tierName: "Трейдер" }),
];

describe("group model", () => {
  it("splits traders by assigned curator, «Без куратора» last, my group first", () => {
    const g = buildGroups(DESK, ["Антон", "Ольга Н.", "Тимур"], "Ольга Н.");
    expect(g.map((x) => [x.key, x.traders.length])).toEqual([["Ольга Н.", 3], ["Антон", 1], ["Тимур", 0], [NO_CURATOR, 1]]);
    expect(tradersOf(DESK, "Ольга Н.").map((s) => s.trader)).toEqual(["Никита С.", "Кирилл Б.", "Евгений Л."]);
    expect(tradersOf(DESK, NO_CURATOR).map((s) => s.trader)).toEqual(["Закир"]);
    expect(tradersOf(DESK, ALL_GROUPS)).toHaveLength(5);
  });

  it("filters: risk now, violations this week, pending reviews, idle N days, tier", () => {
    const names = (f: Partial<typeof DEFAULT_FILTERS>) => applyFilters(DESK, { ...DEFAULT_FILTERS, ...f }, TODAY).map((s) => s.trader);
    expect(names({ risk: true })).toEqual(["Кирилл Б.", "Максим Р."]);
    expect(names({ violations: true })).toEqual(["Кирилл Б."]);
    expect(names({ pending: true })).toEqual(["Евгений Л."]);
    expect(names({ activity: "idle", idleDays: 5 })).toEqual(["Евгений Л.", "Закир"]);
    expect(names({ activity: "active", idleDays: 5 })).toEqual(["Никита С.", "Кирилл Б.", "Максим Р."]);
    expect(names({ tier: "trader" })).toEqual(["Максим Р."]);
    expect(activeFilterCount({ ...DEFAULT_FILTERS, risk: true, tier: "x" })).toBe(2);
  });

  it("days since the last trade", () => {
    expect(daysSinceTrade(DESK[2]!, TODAY)).toBe(15);
    expect(daysSinceTrade(DESK[3]!, TODAY)).toBeNull();
    expect(pendingReviews(DESK[2]!)).toBe(2);
  });

  it("totals sum today only for traders who traded today", () => {
    const t = groupTotals(tradersOf(DESK, "Ольга Н."), TODAY, 5);
    expect(t).toMatchObject({ traders: 3, today: -280, week: 200, month: 2500, violations: 2, pending: 2, atRisk: 1, idle: 1 });
  });

  it("cross-script search with highlight info: Latin, layout slip, alias, curator", () => {
    expect(searchTraders(DESK, "kirill").list.map((s) => s.trader)).toEqual(["Кирилл Б."]);
    expect(searchTraders(DESK, "Rbhbkk").list.map((s) => s.trader)).toEqual(["Кирилл Б."]);
    expect(searchTraders(DESK, "ishakov").marks.get("Закир")?.field).toBe(1);
    expect(searchTraders(DESK, "Evgeniy").list.map((s) => s.trader)).toEqual(["Евгений Л."]);
    const byCurator = searchTraders(DESK, "olga");
    expect(byCurator.list.map((s) => s.trader)).toEqual(["Никита С.", "Кирилл Б.", "Евгений Л."]);
    expect(byCurator.marks.get("Никита С.")?.field).toBe(2);
    expect(searchTraders(DESK, "").list).toHaveLength(5);
  });

  it("CSV row carries group, money and review numbers", () => {
    const row = csvRow(DESK[1]!);
    expect(row.slice(0, 3)).toEqual(["Кирилл Б.", "", "Ольга Н."]);
    expect(row[10]).toBe(2);
  });
});

describe("group model with Latin display names (EN / UZ)", () => {
  afterEach(async () => {
    clearLatinNames();
    await setLang("ru", { source: "init" });
  });

  it("orders groups by the shown name, me first; Russian keeps the stored order", async () => {
    setLatinNames([["Шерзод", "Sherzod"], ["Эльдор", "Eldor"], ["Юлдуз", "Yulduz"]]);
    const curators = ["Шерзод", "Эльдор", "Юлдуз"];
    expect(buildGroups([], curators, null).map((g) => g.key)).toEqual(["Шерзод", "Эльдор", "Юлдуз", NO_CURATOR]);
    await setLang("en", { source: "init" });
    expect(buildGroups([], curators, null).map((g) => g.key)).toEqual(["Эльдор", "Шерзод", "Юлдуз", NO_CURATOR]);
    expect(buildGroups([], curators, "Юлдуз").map((g) => g.key)).toEqual(["Юлдуз", "Эльдор", "Шерзод", NO_CURATOR]);
    expect(GROUP_SORT.trader(sig("Шерзод"))).toBe("Sherzod");
  });

  it("curator search highlights the shown (Latin) name; the stored name still matches", async () => {
    setLatinNames([["Ольга Н.", "Olga N."]]);
    await setLang("uz", { source: "init" });
    const latin = searchTraders(DESK, "olga");
    expect(latin.list.map((s) => s.trader)).toEqual(["Никита С.", "Кирилл Б.", "Евгений Л."]);
    expect(latin.marks.get("Никита С.")).toMatchObject({ field: 2, ranges: [[0, 4]] });
    expect(searchTraders(DESK, "Ольга").list).toHaveLength(3);
    expect(csvRow(DESK[1]!)[2]).toBe("Olga N.");
  });

  it("trader search highlights the shown name first (field 0), whichever script was typed", async () => {
    setLatinNames([["Кирилл Б.", "Kirill B."]]);
    expect(searchTraders(DESK, "kiril").marks.get("Кирилл Б.")?.field).toBe(0);
    await setLang("en", { source: "init" });
    expect(searchTraders(DESK, "kiril").marks.get("Кирилл Б.")).toMatchObject({ field: 0, ranges: [[0, 6]] }); // «Kirill» in «Kirill B.»
    expect(searchTraders(DESK, "Кирил").list.map((s) => s.trader)).toEqual(["Кирилл Б."]);
  });
});
