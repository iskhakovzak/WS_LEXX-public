import { describe, expect, it } from "vitest";
import {
  barsFromCandles, filingEvents, offeringDays, parseAcceptance, reactionDayFor, reactionOn,
  splitByOfferingDays, summarize, type Bar, type TradeLite,
} from "../offeringReaction";

describe("reactionDayFor", () => {
  it("premarket acceptance trades the same day", () => {
    expect(reactionDayFor("2026-10-15", "2026-10-15T07:02:11.000Z")).toEqual({ day: "2026-10-15", session: "pre", acceptedAt: "2026-10-15 07:02" });
  });
  it("after-close acceptance trades next session; Friday rolls to Monday", () => {
    expect(reactionDayFor("2026-10-15", "2026-10-15T16:31:00.000Z").day).toBe("2026-10-16");
    expect(reactionDayFor("2026-10-16", "2026-10-16T17:05:00.000Z").day).toBe("2026-10-19");
  });
  it("intraday acceptance is rth", () => {
    expect(reactionDayFor("2026-10-15", "2026-10-15T11:00:00.000Z").session).toBe("rth");
  });
  it("no stamp → filing date (weekend rolled)", () => {
    expect(reactionDayFor("2026-10-17", null)).toEqual({ day: "2026-10-19", session: null, acceptedAt: null });
  });
  it("parseAcceptance rejects junk", () => {
    expect(parseAcceptance("")).toBeNull();
    expect(parseAcceptance("2026-01-02T09:30:00.000Z")?.minutes).toBe(570);
  });
});

const bars: Bar[] = [
  { d: "2026-10-12", o: 10, h: 10.5, l: 9.8, c: 10, v: 1000 },
  { d: "2026-10-13", o: 10, h: 10.2, l: 9.9, c: 10, v: 1000 },
  { d: "2026-10-14", o: 10, h: 10.1, l: 9.9, c: 10, v: 1000 },
  { d: "2026-10-15", o: 10, h: 10.1, l: 9.9, c: 10, v: 1000 },
  { d: "2026-10-16", o: 10, h: 10.1, l: 9.9, c: 10, v: 1000 },
  { d: "2026-10-19", o: 8, h: 8.4, l: 7, c: 7.2, v: 5000 },
  { d: "2026-10-20", o: 7.2, h: 7.5, l: 6.8, c: 6.84, v: 3000 },
];

describe("reactionOn", () => {
  it("computes gap, open→close, excursions and follow-through", () => {
    const r = reactionOn(bars, "2026-10-17")!; // weekend → Monday bar
    expect(r.day).toBe("2026-10-19");
    expect(r.gapPct).toBe(-20);
    expect(r.o2cPct).toBe(-10);
    expect(r.dayPct).toBe(-28);
    expect(r.lowFromOpenPct).toBe(-12.5);
    expect(r.highFromOpenPct).toBe(5);
    expect(r.nextDayPct).toBe(-5);
    expect(r.relVol).toBe(5);
  });
  it("null without a previous bar or too far", () => {
    expect(reactionOn(bars, "2026-10-12")).toBeNull();
    expect(reactionOn(bars, "2026-11-30")).toBeNull();
  });
  it("summarize", () => {
    const r = reactionOn(bars, "2026-10-19")!;
    const s = summarize([r, { ...r, gapPct: -10, o2cPct: 4 }]);
    expect(s.n).toBe(2);
    expect(s.avgGap).toBe(-15);
    expect(s.medianGap).toBe(-15);
    expect(s.redShare).toBe(0.5);
  });
});

describe("barsFromCandles", () => {
  it("keys by NY date and drops broken candles", () => {
    const t = Date.UTC(2026, 9, 15, 13, 30) / 1000; // 09:30 ET
    const out = barsFromCandles([{ t, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }, { t: t + 86400, o: NaN, h: 1, l: 1, c: 1, v: 0 }]);
    expect(out).toEqual([{ d: "2026-10-15", o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }]);
  });
});

describe("filingEvents", () => {
  const recent = {
    form: ["4", "424B5", "424B5", "424B2", "S-3", "424B4", "S-1"],
    filingDate: ["2026-10-16", "2026-10-15", "2026-10-15", "2026-10-14", "2026-09-01", "2026-03-02", "2025-01-01"],
    acceptanceDateTime: ["", "2026-10-15T16:40:00.000Z", "2026-10-15T17:10:00.000Z", "", "2026-09-01T08:00:00.000Z", "2026-03-02T06:10:00.000Z", ""],
    accessionNumber: ["a", "b", "c", "d", "e", "f", "g"],
    primaryDocument: ["a.xml", "b.htm", "c.htm", "d.htm", "e.htm", "f.htm", "g.htm"],
    primaryDocDescription: [null, "424B5", "424B5", null, "S-3", null, null] as Array<string | null>,
  };
  it("keeps dilutive forms, collapses same-day takedowns, stops at the cutoff", () => {
    const ev = filingEvents(recent as never, "2025-06-01");
    expect(ev.map((e) => e.form)).toEqual(["424B5", "S-3", "424B4"]);
    expect(ev[0].reactionDay).toBe("2026-10-16");
    expect(ev[1].reactionDay).toBeNull();
    expect(offeringDays(ev)).toEqual(["2026-03-02", "2026-10-16"]);
  });
});

describe("splitByOfferingDays", () => {
  const trades: TradeLite[] = [
    { id: 1, ticker: "ABC", date: "2026-10-16", pnl: 100, fees: 2, result: "win" },
    { id: 2, ticker: "ABC", date: "2026-10-19", pnl: -50, fees: 2, result: "loss" },
    { id: 3, ticker: "XYZ", date: "2026-10-16", pnl: 10, fees: -1, result: "win" },
  ];
  const days = new Map([["ABC", ["2026-10-16"]]]);
  it("same-day window", () => {
    const s = splitByOfferingDays(trades, days);
    expect(s.offering.trades).toBe(1);
    expect(s.offering.net).toBe(98);
    expect(s.offering.winRate).toBe(100);
    expect(s.normal.trades).toBe(2);
    expect(s.normal.net).toBe(-43);
    expect(s.normal.winRate).toBe(50);
  });
  it("window=1 also counts the next session (Fri → Mon)", () => {
    const s = splitByOfferingDays(trades, days, 1);
    expect(s.offering.trades).toBe(2);
    expect(s.matched.get("2")).toBe("2026-10-16");
  });
});
