import { describe, expect, it } from "vitest";
import {
  aggregateDays,
  buildDayBook,
  categoriesByDate,
  categoryOf,
  closedDates,
  earningsEdge,
  edgeByCategory,
  focusDay,
  frequentTickers,
  nextTradingDay,
  prevTradingDay,
  welchT,
  type BookTrade,
  type MacroRow,
} from "./catalyst-math";

const row = (date: string, type: string, name: string, description: string | null = null): MacroRow => ({ date, type, name, description, importance: "high" });

const CAL: MacroRow[] = [
  row("2026-01-01", "holiday", "New Year's Day", "Market closed"),
  row("2026-01-13", "cpi", "CPI", "8:30am ET — Consumer Price Index"),
  row("2026-01-27", "fomc", "FOMC Meeting", "FOMC begins"),
  row("2026-01-28", "fomc", "FOMC Meeting (Decision Day)", "Statement 2pm ET, Powell presser 2:30pm ET"),
  row("2026-03-20", "quad_witching", "Quadruple Witching", "all expire"),
  row("2026-07-03", "holiday", "Independence Day (observed)", "Early close 1pm ET"),
];

const tr = (date: string, ticker: string, pnl: number, fees = 1, result?: string): BookTrade => ({
  date, ticker, pnl, fees, result: result ?? (pnl - fees > 0 ? "win" : pnl - fees < 0 ? "loss" : "be"),
});

describe("calendar categories", () => {
  it("maps calendar rows to categories, skipping the first FOMC day and full holidays", () => {
    expect(categoryOf(CAL[0])).toBeNull();
    expect(categoryOf(CAL[1])).toBe("cpi");
    expect(categoryOf(CAL[2])).toBeNull();
    expect(categoryOf(CAL[3])).toBe("fomc");
    expect(categoryOf(CAL[4])).toBe("opex");
    expect(categoryOf(CAL[5])).toBe("short_day");
    const m = categoriesByDate(CAL);
    expect([...m.keys()].sort()).toEqual(["2026-01-13", "2026-01-28", "2026-03-20", "2026-07-03"]);
    expect([...closedDates(CAL)]).toEqual(["2026-01-01"]);
  });

  it("walks trading days around weekends and closures", () => {
    const closed = closedDates(CAL);
    expect(nextTradingDay("2025-12-31", closed)).toBe("2026-01-02");
    expect(prevTradingDay("2026-01-05", closed)).toBe("2026-01-02");
    // Saturday → Monday; Friday after the close → Monday; Friday morning → Friday.
    expect(focusDay("2026-10-17", 9 * 60, closed)).toBe("2026-10-19");
    expect(focusDay("2026-10-16", 16 * 60 + 5, closed)).toBe("2026-10-19");
    expect(focusDay("2026-10-16", 8 * 60, closed)).toBe("2026-10-16");
  });
});

describe("day book and aggregates", () => {
  const trades: BookTrade[] = [
    tr("2026-01-12", "NVDA", 11), // net +10
    tr("2026-01-12", "MU", -4), // net -5
    tr("2026-01-13", "NVDA", -19), // cpi, net -20
    tr("2026-01-14", "AMD", 21), // net +20
    { date: "2026-01-14", ticker: "AMD", pnl: 50, fees: 0, result: "open" }, // ignored
  ];
  const book = buildDayBook(trades);

  it("uses net money and skips open trades", () => {
    expect(book.get("2026-01-12")?.net).toBe(5);
    expect(book.get("2026-01-12")?.n).toBe(2);
    expect(book.get("2026-01-14")?.n).toBe(1);
    const a = aggregateDays(book, ["2026-01-12", "2026-01-14", "2026-02-02"]);
    expect(a.days).toBe(2);
    expect(a.net).toBe(25);
    expect(a.avgNetDay).toBe(12.5);
    expect(a.greenPct).toBe(100);
    expect(a.winRate).toBe(66.7);
    expect(a.sample).toBe("low");
  });

  it("compares category days with ordinary days", () => {
    const e = edgeByCategory(book, categoriesByDate(CAL), closedDates(CAL));
    expect(e.from).toBe("2026-01-12");
    expect(e.to).toBe("2026-01-14");
    expect(e.baseline.days).toBe(2);
    const cpi = e.rows.find((r) => r.key === "cpi")!;
    expect(cpi.agg.days).toBe(1);
    expect(cpi.agg.net).toBe(-20);
    expect(cpi.delta).toBe(-32.5);
    expect(cpi.verdict).toBe("low");
    // FOMC decision on 01-28 is outside the traded span → not counted.
    expect(e.rows.find((r) => r.key === "fomc")!.calendarDays).toBe(0);
  });

  it("welch t is null for tiny or flat samples", () => {
    expect(welchT([1], [1, 2])).toBeNull();
    expect(welchT([1, 1], [1, 1])).toBeNull();
    expect(welchT([10, 12, 11], [1, 2, 0])!).toBeGreaterThan(5);
  });
});

describe("tickers and earnings reactions", () => {
  const trades: BookTrade[] = [
    tr("2026-02-26", "NVDA", 41), // reaction day, net +40
    tr("2026-02-26", "NVDA", -9), // reaction day, net -10
    tr("2026-03-02", "NVDA", 6), // other, net +5
    tr("2026-03-03", "MU", 3),
    tr("2026-03-04", "MU", 3),
    tr("2026-03-05", "MU", 3),
  ];

  it("ranks frequent tickers with a minimum", () => {
    expect(frequentTickers(trades, 5, 3).map((t) => t.ticker)).toEqual(["MU", "NVDA"]);
    expect(frequentTickers(trades, 5, 4)).toEqual([]);
  });

  it("splits my ticker trades into reaction days vs other days", () => {
    const e = earningsEdge(trades, {
      ticker: "nvda",
      quarters: [
        { date: "2026-02-25", reactionDate: "2026-02-26", gapPct: -3, rangePct: 6, closePct: 2, beat: true },
        { date: "2025-11-19", reactionDate: "2025-11-20", gapPct: 5, rangePct: 8, closePct: -1, beat: true },
        { date: "2025-08-27", reactionDate: null, gapPct: null, rangePct: null, closePct: null },
      ],
    });
    expect(e.reactions.map((r) => r.date)).toEqual(["2026-02-26", "2025-11-20"]);
    expect(e.avgAbsGap).toBe(4);
    expect(e.avgRange).toBe(7);
    expect(e.upShare).toBe(50);
    expect(e.event).toMatchObject({ days: 1, trades: 2, net: 30, wins: 1, losses: 1, winRate: 50, avgNetTrade: 15 });
    expect(e.other).toMatchObject({ trades: 1, net: 5 });
  });
});
