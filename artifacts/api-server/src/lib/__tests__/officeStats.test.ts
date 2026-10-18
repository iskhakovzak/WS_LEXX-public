import { describe, expect, it } from "vitest";
import {
  buildOfficeView, classifyStrategy, dayOfYear, drawdownOf, isOptionSymbol, nyParts, parsePeriod, parseYears, shiftYear,
  streaksOf, timeBucketKey, toMemberView, toValued, type OfficeTrade, type YearSetting,
} from "../officeStats";

// New York is UTC−4 in summer (EDT): 13:30Z = 09:30 NY.
const at = (day: string, hhmmss: string) => new Date(`${day}T${hhmmss}-04:00`).toISOString();
const D = "2026-06-10";

describe("nyParts", () => {
  it("converts an instant to the New York date and seconds", () => {
    expect(nyParts(at(D, "09:30:05"))).toEqual({ date: D, sec: 9 * 3600 + 30 * 60 + 5 });
    expect(nyParts("2026-01-15T14:30:00Z")).toEqual({ date: "2026-01-15", sec: 9 * 3600 + 30 * 60 }); // EST
    expect(nyParts(null)).toBeNull();
    expect(nyParts("garbage")).toBeNull();
  });
});

describe("classifyStrategy", () => {
  const c = (entry: string | null, exit: string | null, extra: Record<string, unknown> = {}) =>
    classifyStrategy({ ticker: "AAPL", date: D, entryAt: entry ? at(D, entry) : null, exitAt: exit ? at(D, exit) : null, ...extra });

  it("options by OCC symbol, before anything else", () => {
    expect(isOptionSymbol("AAPL261016C00230000")).toBe(true);
    expect(isOptionSymbol("SPY 261016P450")).toBe(true);
    expect(isOptionSymbol("O:TSLA261016C00250000")).toBe(true);
    expect(isOptionSymbol("AAPL")).toBe(false);
    expect(isOptionSymbol("BRK.B")).toBe(false);
    expect(classifyStrategy({ ticker: "AAPL261016C00230000", horizon: "overnight" })).toBe("OPT");
  });

  it("overnight by horizon, by fill dates or by exit_date", () => {
    expect(c("10:00:00", "11:00:00", { horizon: "swing" })).toBe("Overnight");
    expect(classifyStrategy({ ticker: "X", entryAt: at(D, "15:55:00"), exitAt: at("2026-06-11", "09:31:00") })).toBe("Overnight");
    expect(classifyStrategy({ ticker: "X", date: D, exitDate: "2026-06-12" })).toBe("Overnight");
  });

  it("OPG: pre-market or opening-auction entry, flat by 10:00", () => {
    expect(c("09:30:00", "09:45:00")).toBe("OPG");
    expect(c("09:30:59", "10:00:00")).toBe("OPG");
    expect(c("08:15:00", "09:20:00")).toBe("OPG");
    expect(c("09:30:02", null)).toBe("OPG");
  });

  it("OPGtoDAY: opened at the open, held past 10:00", () => {
    expect(c("09:30:01", "10:00:01")).toBe("OPGtoDAY");
    expect(c("07:00:00", "13:00:00")).toBe("OPGtoDAY");
    expect(c("09:30:00", "16:00:03")).toBe("OPGtoDAY");
  });

  it("MOC: imbalance-window entry or closing-cross exit", () => {
    expect(c("15:50:00", "15:56:00")).toBe("MOC");
    expect(c("15:52:00", "16:30:00")).toBe("MOC");
    expect(c("14:00:00", "16:00:04")).toBe("MOC");
    expect(c("14:00:00", "15:59:30")).toBe("MOC");
    expect(c("14:00:00", "15:59:29")).toBe("Day");
  });

  it("AfterMarket: post-market entry, or an intraday position closed after the cross", () => {
    expect(c("16:00:00", "17:00:00")).toBe("AfterMarket");
    expect(c("18:30:00", "19:00:00")).toBe("AfterMarket");
    expect(c("14:00:00", "16:01:00")).toBe("AfterMarket");
  });

  it("Day: everything else intraday", () => {
    expect(c("09:31:00", "09:45:00")).toBe("Day");
    expect(c("11:00:00", "15:49:00")).toBe("Day");
    expect(c("15:49:59", "15:55:00")).toBe("Day");
  });

  it("falls back to the session without fill times", () => {
    expect(classifyStrategy({ ticker: "X", session: "premarket" })).toBe("OPG");
    expect(classifyStrategy({ ticker: "X", session: "postmarket" })).toBe("AfterMarket");
    expect(classifyStrategy({ ticker: "X", session: "regular" })).toBe("Day");
    expect(classifyStrategy({ ticker: "X" })).toBe("Day");
  });
});

describe("helpers", () => {
  it("dayOfYear / shiftYear", () => {
    expect(dayOfYear("2026-01-01")).toBe(1);
    expect(dayOfYear("2026-12-31")).toBe(365);
    expect(dayOfYear("2024-12-31")).toBe(366);
    expect(shiftYear("2024-02-29", 1)).toBe("2025-02-28");
    expect(shiftYear("2026-10-17", -1)).toBe("2025-10-17");
  });

  it("drawdown: depth, recovery and the current state", () => {
    const pts = [10, 25, 15, 5, 20, 30, 28].map((cum, i) => ({ date: `2026-01-0${i + 1}`, cum }));
    const dd = drawdownOf(pts);
    expect(dd.max).toBe(-20);
    expect(dd.peakDate).toBe("2026-01-02");
    expect(dd.troughDate).toBe("2026-01-04");
    expect(dd.recoveredDate).toBe("2026-01-06");
    expect(dd.recoveryDays).toBe(2);
    expect(dd.lengthDays).toBe(4);
    expect(dd.current).toBe(-2);
    expect(dd.currentDays).toBe(1);
    expect(drawdownOf([]).max).toBe(0);
    // Losing from the first day: the high-water mark is the 0 start.
    const neg = drawdownOf([{ date: "a", cum: -5 }, { date: "b", cum: -8 }]);
    expect(neg.max).toBe(-8);
    expect(neg.recoveredDate).toBeNull();
  });

  it("streaks", () => {
    expect(streaksOf([1, 2, -1, -1, -1, 0, 3, 4])).toEqual({ maxGreen: 2, maxRed: 3, current: 2 });
    expect(streaksOf([-1, -2])).toEqual({ maxGreen: 0, maxRed: 2, current: -2 });
  });

  it("time buckets", () => {
    expect(timeBucketKey(9 * 3600, null)).toBe("pre");
    expect(timeBucketKey(9 * 3600 + 30 * 60, null)).toBe(`t${9 * 3600 + 30 * 60}`);
    expect(timeBucketKey(10 * 3600 + 5, null)).toBe(`t${10 * 3600}`);
    expect(timeBucketKey(16 * 3600, null)).toBe("post");
    expect(timeBucketKey(null, "premarket")).toBe("pre");
    expect(timeBucketKey(null, "regular")).toBeNull();
  });

  it("parseYears / parsePeriod", () => {
    expect(parseYears("2026,2025,2025,abc", "2026-10-17")).toEqual([2025, 2026]);
    expect(parseYears(undefined, "2026-10-17")).toEqual([2025, 2026]);
    expect(parseYears("1999,3000", "2026-10-17")).toEqual([2025, 2026]);
    expect(parsePeriod(undefined, undefined, [2025, 2026], "2026-10-17")).toEqual({ from: "2026-01-01", to: "2026-10-17" });
    expect(parsePeriod(undefined, undefined, [2025], "2026-10-17")).toEqual({ from: "2025-01-01", to: "2025-12-31" });
    expect(parsePeriod("2026-09-30", "2026-07-01", [2026], "2026-10-17")).toEqual({ from: "2026-07-01", to: "2026-09-30" });
  });
});

// ─── Views ─────────────────────────────────────────────────────────────────────────────────────────────────

let seq = 0;
const tr = (p: Partial<OfficeTrade> & { day: string; net: number }): OfficeTrade => ({
  id: ++seq, trader: "A", ticker: "AAPL", result: p.net > 0 ? "win" : p.net < 0 ? "loss" : "be", r: null,
  volume: 100, strategy: "Day", entrySec: 11 * 3600, session: "regular", ...p,
});

const TRADES: OfficeTrade[] = [
  tr({ day: "2025-03-03", net: 1000, strategy: "MOC" }),
  tr({ day: "2025-03-04", net: -500 }),
  tr({ day: "2026-01-05", net: 2000, strategy: "MOC", trader: "B", volume: 50, entrySec: 15 * 3600 + 55 * 60 }),
  tr({ day: "2026-01-05", net: -1000, strategy: "Day", volume: 300 }),
  tr({ day: "2026-02-10", net: 3000, strategy: "OPG", ticker: "TSLA", volume: 150, entrySec: 9 * 3600 + 30 * 60 }),
  tr({ day: "2026-03-11", net: -500, strategy: "Day", volume: 100 }),
  tr({ day: "2026-04-12", net: -250, strategy: "Day", volume: 100 }),
];
const settings = (cap2026: number | null, cap2025: number | null = null) =>
  new Map<number, YearSetting>([[2026, { year: 2026, capital: cap2026, goalPct: 40 }], [2025, { year: 2025, capital: cap2025, goalPct: 40 }]]);
const opts = (unit: "usd" | "pct", s: Map<number, YearSetting>, traders = false) =>
  ({ years: [2025, 2026], settings: s, unit, from: "2026-01-01", to: "2026-10-17", today: "2026-10-17", traders });

describe("toValued", () => {
  it("converts to % of the trade year's capital and drops years without one", () => {
    const v = toValued(TRADES, "pct", settings(100_000));
    expect(v.every((t) => t.day.startsWith("2026"))).toBe(true);
    expect(v.find((t) => t.net === 2000)!.v).toBeCloseTo(2, 9);
    expect(toValued(TRADES, "usd", settings(null)).length).toBe(TRADES.length);
  });
});

describe("buildOfficeView", () => {
  it("usd view: totals, daily cumulative curve, strategies and pace", () => {
    const v = buildOfficeView(TRADES, opts("usd", settings(100_000), true));
    const y26 = v.years.find((y) => y.year === 2026)!;
    expect(y26.totals.net).toBe(3250);
    expect(y26.days.map((d) => d.cum)).toEqual([1000, 4000, 3500, 3250]);
    expect(y26.days[0].s).toEqual({ MOC: 2000, Day: -1000 });
    expect(y26.goal).toBe(40_000);
    const moc = y26.strategies.find((s) => s.key === "MOC")!;
    expect(moc.net).toBe(2000);
    expect(moc.cum).toEqual([2000, 2000, 2000, 2000]);
    expect(moc.volumeShare).toBeCloseTo(50 / 700, 4);
    expect(y26.strategies.find((s) => s.key === "Day")!.monthly.slice(0, 4)).toEqual([-1000, null, -500, -250]);
    expect(y26.drawdown.max).toBe(-750);
    expect(y26.pace!.status).toBe("behind");
    expect(v.period.traders!.map((t) => t.trader)).toEqual(["B", "A"]);
    expect(v.period.traders![0].share).toBeCloseTo(2000 / 3250, 4);
    expect(v.prev!.totals.net).toBe(500);
    expect(v.period.tickers.top[0].ticker).toBe("TSLA");
  });

  it("pct view: % of capital, capitalMissing for a year without capital", () => {
    const v = buildOfficeView(TRADES, opts("pct", settings(100_000)));
    const y25 = v.years.find((y) => y.year === 2025)!;
    const y26 = v.years.find((y) => y.year === 2026)!;
    expect(y25.capitalMissing).toBe(true);
    expect(y25.hasData).toBe(false);
    expect(y26.totals.net).toBeCloseTo(3.25, 9);
    expect(y26.goal).toBe(40);
    expect(v.prev).toBeNull();
  });

  it("insights are deterministic plain Russian and carry no $ in the pct view", () => {
    const v = buildOfficeView(TRADES, opts("pct", settings(100_000)));
    const texts = v.insights.map((i) => i.text);
    expect(texts.some((t) => /MOC даёт \d+% результата при \d+% объёма/.test(t))).toBe(true);
    expect(texts.some((t) => /^Day в минусе 2 месяца подряд$/.test(t))).toBe(true);
    expect(texts.join(" ")).not.toContain("$");
    expect(buildOfficeView(TRADES, opts("pct", settings(100_000))).insights).toEqual(v.insights);
  });

  it("member view strips absolute volume and traders, refuses usd", () => {
    const admin = buildOfficeView(TRADES, opts("pct", settings(100_000), true));
    const member = toMemberView(admin);
    const json = JSON.stringify(member);
    expect(json).not.toContain('"volume"');
    expect(json).not.toContain('"traders"');
    expect(json).toContain('"volumeShare"');
    expect(member.period.traders).toBeUndefined();
    expect(() => toMemberView(buildOfficeView(TRADES, opts("usd", settings(100_000))))).toThrow();
  });

  it("an empty year is handled", () => {
    const v = buildOfficeView([], opts("usd", settings(null)));
    expect(v.years.every((y) => !y.hasData && y.days.length === 0)).toBe(true);
    expect(v.period.totals.trades).toBe(0);
    expect(v.insights).toEqual([]);
  });
});
