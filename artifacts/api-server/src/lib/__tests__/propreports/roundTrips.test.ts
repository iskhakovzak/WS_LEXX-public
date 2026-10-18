import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFillsCsv } from "../../propreports/parse-fills";
import { buildRoundTrips, holdHuman, horizonFor, nextTradingDay, sessionFor, summarizeTrips } from "../../propreports/round-trips";
import type { FeeBreakdown, Fill, FillSide, RoundTrip } from "../../propreports/types";

const FIXTURES = join(__dirname, "..", "..", "propreports", "__fixtures__");

let seq = 0;
/** Compact fill builder: fill("B", 100, "AAPL", 150, "2026-03-02 09:35:00", { comm: 0.5 }) */
function fill(side: FillSide, qty: number, symbol: string, price: number, dateTime: string, fees: FeeBreakdown = {}, extra: Partial<Fill> = {}): Fill {
  seq++;
  return {
    dateTime, account: "ACC", side, qty, symbol, price, route: null, fees,
    tradeDate: dateTime.slice(0, 10), orderId: null, fillId: `F${seq}`, propReportsId: null, status: null, line: seq,
    ...extra,
  };
}
const sumFees = (f: FeeBreakdown) => Object.values(f).reduce((s, v) => s + v, 0);

describe("round-trips helpers", () => {
  it.each<[string, string]>([
    ["04:00:00", "premarket"], ["09:29:59", "premarket"], ["09:30:00", "regular"], ["15:59:59", "regular"], ["16:00:00", "postmarket"], ["19:59:00", "postmarket"],
  ])("sessionFor(%s) → %s", (t, e) => expect(sessionFor(t)).toBe(e));

  it.each<[number, string]>([
    [0, "0s"], [59, "59s"], [60, "1m"], [3599, "59m"], [3600, "1h 0m"], [3661, "1h 1m"], [86399, "23h 59m"], [86400, "1d"], [90000, "1d 1h"], [-5, "0s"], [59.6, "1m"],
  ])("holdHuman(%d) → %s", (s, e) => expect(holdHuman(s)).toBe(e));

  it.each<[string, string]>([
    ["2026-03-05", "2026-03-06"], // Thu → Fri
    ["2026-03-06", "2026-03-09"], // Fri → Mon
    ["2026-03-07", "2026-03-09"], // Sat → Mon
    ["2026-12-31", "2027-01-01"],
  ])("nextTradingDay(%s) → %s", (d, e) => expect(nextTradingDay(d)).toBe(e));

  it.each<[string, string, string]>([
    ["2026-03-02", "2026-03-02", "intraday"],
    ["2026-03-02", "2026-03-01", "intraday"], // close before open (bad data) ⇒ intraday, never negative
    ["2026-03-02", "2026-03-03", "overnight"],
    ["2026-03-06", "2026-03-09", "overnight"], // Friday → Monday
    ["2026-03-06", "2026-03-10", "swing"],
    ["2026-03-02", "2026-03-04", "swing"],
  ])("horizonFor(%s, %s) → %s", (a, b, e) => expect(horizonFor(a, b)).toBe(e));
});

describe("buildRoundTrips — hand-computed fixture (fills-sample.csv)", () => {
  const csv = readFileSync(join(FIXTURES, "fills-sample.csv"), "utf8");
  const parsed = parseFillsCsv(csv);
  const { trips, orphanFills } = buildRoundTrips(parsed.fills);
  const byId = new Map(trips.map((t) => [t.externalId, t]));

  it("parses 19 fills, skips the CXLD row, finds 8 trips and 1 orphan", () => {
    expect(parsed.fills.length).toBe(19);
    expect(parsed.skipped).toBe(1);
    expect(parsed.issues).toEqual([]);
    expect(trips.length).toBe(8);
    expect(orphanFills.map((f) => f.symbol)).toEqual(["XYZ"]);
  });

  type Exp = Partial<Pick<RoundTrip, "side" | "horizon" | "session" | "result" | "exitDate" | "holdTime" | "qty" | "openQty" | "avgEntry" | "avgExit" | "grossPnl" | "totalFees" | "netPnl" | "fillCount">>;
  it.each<[string, Exp]>([
    // AAPL scale-in: avgCost 150.25; (151−150.25)×100 + (151.5−150.25)×100 = 200; fees 4×0.83 + 2×0.03 = 3.38
    ["DEMO1|AAPL|2026-03-02T09:35:12|Long", { side: "Long", horizon: "intraday", session: "regular", qty: 200, openQty: 0, avgEntry: 150.25, avgExit: 151.25, grossPnl: 200, totalFees: 3.38, netPnl: 196.62, result: "win", fillCount: 4, holdTime: "24m" }],
    // TSLA short 50 @250 → cover @248: +100; fees 1.00
    ["DEMO1|TSLA|2026-03-02T10:15:00|Short", { side: "Short", horizon: "intraday", qty: 50, grossPnl: 100, totalFees: 1, netPnl: 99, result: "win", holdTime: "30m" }],
    // NVDA overnight: 200 × 5 = 1000; fees 1.66 + 1.73 = 3.39
    ["DEMO1|NVDA|2026-03-02T15:50:00|Long", { horizon: "overnight", exitDate: "2026-03-03", qty: 200, grossPnl: 1000, totalFees: 3.39, netPnl: 996.61, result: "win", holdTime: "17h 45m" }],
    // AMD 3-day swing, premarket entry: 100 × (97−100) = −300; fees 0.83 + 0.85 = 1.68
    ["DEMO1|AMD|2026-03-02T08:30:00|Long", { horizon: "swing", session: "premarket", exitDate: "2026-03-05", grossPnl: -300, totalFees: 1.68, netPnl: -301.68, result: "loss", holdTime: "3d 5h" }],
    // MSFT still open at the end of the data
    ["DEMO1|MSFT|2026-03-05T10:00:00|Long", { result: "open", openQty: 50, qty: 50, avgExit: null, grossPnl: 0, totalFees: 0.42, holdTime: null, exitDate: null }],
    // SPY crossing zero: long 100 @500 closed by 100 of the 300 sell @501 → +100, fees 0.83 + 2.58/3
    ["DEMO1|SPY|2026-03-03T10:00:00|Long", { side: "Long", qty: 100, grossPnl: 100, totalFees: 1.69, netPnl: 98.31, result: "win", fillCount: 2 }],
    //   then short 200 @501 (2/3 × 2.58 = 1.72) covered @500 (1.66): +200, fees 3.38
    ["DEMO1|SPY|2026-03-03T10:30:00|Short", { side: "Short", qty: 200, avgEntry: 501, avgExit: 500, grossPnl: 200, totalFees: 3.38, netPnl: 196.62, result: "win", fillCount: 2 }],
    // META partial exits 300 → 3 × 100: (602−600)×100 + (599−600)×100 + 0 = 100; fees 2.49 + 3×0.86 = 5.07
    ["DEMO2|META|2026-03-04T09:31:00|Long", { qty: 300, avgExit: 600.3333, grossPnl: 100, totalFees: 5.07, netPnl: 94.93, result: "win", fillCount: 4 }],
  ])("%s", (id, exp) => {
    const t = byId.get(id);
    expect(t, id).toBeDefined();
    for (const [k, v] of Object.entries(exp)) {
      const got = (t as unknown as Record<string, unknown>)[k];
      if (typeof v === "number") expect(got, `${id}.${k}`).toBeCloseTo(v, 2);
      else expect(got, `${id}.${k}`).toBe(v);
    }
  });

  it("execution kinds: entry/add/trim/exit", () => {
    expect(byId.get("DEMO2|META|2026-03-04T09:31:00|Long")!.executions.map((e) => e.kind)).toEqual(["entry", "trim", "trim", "exit"]);
    expect(byId.get("DEMO1|AAPL|2026-03-02T09:35:12|Long")!.executions.map((e) => e.kind)).toEqual(["entry", "add", "trim", "exit"]);
    expect(byId.get("DEMO1|SPY|2026-03-03T10:30:00|Short")!.executions.map((e) => `${e.kind}:${e.side}${e.qty}`)).toEqual(["entry:S200", "exit:C200"]);
  });

  it("fees are conserved: Σ trip fees + orphan fees == Σ fill fees (per column too)", () => {
    const inFees: FeeBreakdown = {};
    for (const f of parsed.fills) for (const [k, v] of Object.entries(f.fees)) inFees[k] = (inFees[k] ?? 0) + v;
    const outFees: FeeBreakdown = {};
    for (const t of trips) for (const [k, v] of Object.entries(t.fees)) outFees[k] = (outFees[k] ?? 0) + v;
    for (const f of orphanFills) for (const [k, v] of Object.entries(f.fees)) outFees[k] = (outFees[k] ?? 0) + v;
    for (const k of Object.keys(inFees)) expect(outFees[k], k).toBeCloseTo(inFees[k], 6);
    const execFees = trips.reduce((s, t) => s + t.executions.reduce((x, e) => x + e.fees, 0), 0);
    expect(execFees).toBeCloseTo(trips.reduce((s, t) => s + t.totalFees, 0), 1);
  });

  it("gross is conserved per fully-closed symbol: Σ realised == Σ sell notional − Σ buy notional", () => {
    for (const sym of ["AAPL", "TSLA", "NVDA", "AMD", "SPY", "META"]) {
      const fs = parsed.fills.filter((f) => f.symbol === sym);
      const cash = fs.reduce((s, f) => s + (f.side === "S" || f.side === "T" ? 1 : -1) * f.qty * f.price, 0);
      const gross = trips.filter((t) => t.symbol === sym).reduce((s, t) => s + t.grossPnl, 0);
      expect(gross, sym).toBeCloseTo(cash, 2);
    }
  });

  it("summary totals", () => {
    const s = summarizeTrips(trips);
    expect(s).toMatchObject({ trips: 8, closed: 7, open: 1, wins: 6, losses: 1, breakeven: 0, accounts: ["DEMO1", "DEMO2"], symbols: 7 /* SPY twice */, minDate: "2026-03-02", maxDate: "2026-03-05", tradingDays: 4 });
    expect(s.byHorizon).toEqual({ intraday: 6, overnight: 1, swing: 1 }); // NVDA overnight, AMD swing; MSFT open on the last day ⇒ intraday
    expect(s.gross).toBeCloseTo(200 + 100 + 1000 - 300 + 0 + 100 + 200 + 100, 2);
    expect(s.net).toBeCloseTo(s.gross - s.fees, 2);
  });

  it("is deterministic and order-independent", () => {
    const again = buildRoundTrips([...parsed.fills].reverse());
    expect(JSON.stringify(again.trips)).toBe(JSON.stringify(trips));
    expect(JSON.stringify(buildRoundTrips(parseFillsCsv(csv).fills).trips)).toBe(JSON.stringify(trips));
  });
});

describe("buildRoundTrips — synthetic edge cases", () => {
  it("partial fills of one order are one entry each, qty-weighted average", () => {
    const { trips } = buildRoundTrips([
      fill("B", 100, "X", 10, "2026-03-02 10:00:00", { comm: 1 }),
      fill("B", 50, "X", 10.3, "2026-03-02 10:00:00", { comm: 0.5 }),
      fill("S", 150, "X", 10.5, "2026-03-02 11:00:00", { comm: 1.5 }),
    ]);
    expect(trips.length).toBe(1);
    const t = trips[0];
    expect(t.qty).toBe(150);
    expect(t.avgEntry).toBeCloseTo(10.1, 4);
    expect(t.grossPnl).toBeCloseTo(150 * 0.4, 2);
    expect(t.totalFees).toBe(3);
    expect(t.netPnl).toBeCloseTo(57, 2);
    expect(t.result).toBe("win");
    expect(t.holdTime).toBe("1h 0m");
    expect(t.executions.map((e) => e.kind)).toEqual(["entry", "add", "exit"]);
  });

  it("scale-out: realised uses the average cost at each exit", () => {
    const { trips } = buildRoundTrips([
      fill("B", 300, "X", 100, "2026-03-02 10:00:00"),
      fill("S", 100, "X", 101, "2026-03-02 10:10:00"),
      fill("B", 100, "X", 102, "2026-03-02 10:20:00"), // add after a trim: avg of remaining 200@100 + 100@102 = 100.6667
      fill("S", 300, "X", 100, "2026-03-02 10:30:00"),
    ]);
    expect(trips.length).toBe(1);
    const t = trips[0];
    expect(t.qty).toBe(300);
    expect(t.executions.map((e) => e.kind)).toEqual(["entry", "trim", "add", "exit"]);
    // realised: 100×(101−100) + 300×(100−100.6667) = 100 − 200 = −100 ; cash check: 100×101 + 300×100 − 300×100 − 100×102 = −100
    expect(t.grossPnl).toBeCloseTo(-100, 2);
    expect(t.avgEntry).toBeCloseTo(100.5, 4); // (300×100 + 100×102)/400
    expect(t.avgExit).toBeCloseTo(100.25, 4); // (100×101 + 300×100)/400
    expect(t.result).toBe("loss");
  });

  it("short → long flip in one fill: short closes, the remainder opens a long at the same price", () => {
    const { trips } = buildRoundTrips([
      fill("T", 100, "X", 50, "2026-03-02 10:00:00", { comm: 1 }),
      fill("B", 300, "X", 49, "2026-03-02 10:30:00", { comm: 3 }),
    ]);
    expect(trips.map((t) => [t.side, t.qty, t.result])).toEqual([["Short", 100, "win"], ["Long", 200, "open"]]);
    expect(trips[0].grossPnl).toBe(100);
    expect(trips[0].totalFees).toBe(2); // 1 + 3 × 100/300
    expect(trips[1].totalFees).toBe(2);
    expect(trips[1].avgEntry).toBe(49);
    expect(trips[1].openQty).toBe(200);
    expect(trips[1].externalId).toBe("ACC|X|2026-03-02T10:30:00|Long");
  });

  it("overnight carry: Friday open, Monday close ⇒ overnight; Tuesday ⇒ swing; exitDate set", () => {
    const { trips } = buildRoundTrips([
      fill("B", 10, "A", 1, "2026-03-06 15:00:00"),
      fill("S", 10, "A", 2, "2026-03-09 09:31:00"),
      fill("B", 10, "B", 1, "2026-03-06 15:00:00"),
      fill("S", 10, "B", 2, "2026-03-10 09:31:00"),
    ]);
    const a = trips.find((t) => t.symbol === "A")!;
    const b = trips.find((t) => t.symbol === "B")!;
    expect([a.horizon, a.exitDate, a.date]).toEqual(["overnight", "2026-03-09", "2026-03-06"]);
    expect([b.horizon, b.exitDate]).toEqual(["swing", "2026-03-10"]);
    expect(a.holdTime).toBe("2d 18h");
  });

  it("open position horizon is measured against asOfDate", () => {
    const fills = [fill("B", 10, "A", 1, "2026-03-05 10:00:00")];
    expect(buildRoundTrips(fills).trips[0].horizon).toBe("intraday");
    expect(buildRoundTrips(fills, { asOfDate: "2026-03-06" }).trips[0].horizon).toBe("overnight");
    expect(buildRoundTrips(fills, { asOfDate: "2026-03-12" }).trips[0].horizon).toBe("swing");
    expect(buildRoundTrips(fills).trips[0].exitDate).toBeNull();
  });

  it("session date (Trade Date) differs from the wall-clock date: date uses the session", () => {
    const { trips } = buildRoundTrips([
      fill("B", 10, "A", 1, "2026-03-03 00:30:00", {}, { tradeDate: "2026-03-02" }),
      fill("S", 10, "A", 1, "2026-03-03 01:00:00", {}, { tradeDate: "2026-03-02" }),
    ]);
    expect(trips[0].date).toBe("2026-03-02");
    expect(trips[0].horizon).toBe("intraday");
    expect(trips[0].exitDate).toBeNull();
  });

  it("breakeven only when net is exactly zero", () => {
    const flat = buildRoundTrips([fill("B", 10, "A", 5, "2026-03-02 10:00:00"), fill("S", 10, "A", 5, "2026-03-02 10:05:00")]).trips[0];
    expect([flat.grossPnl, flat.netPnl, flat.result]).toEqual([0, 0, "breakeven"]);
    const fee = buildRoundTrips([fill("B", 10, "A", 5, "2026-03-02 10:00:00", { comm: 0.01 }), fill("S", 10, "A", 5, "2026-03-02 10:05:00")]).trips[0];
    expect([fee.netPnl, fee.result]).toEqual([-0.01, "loss"]);
  });

  it("sell/cover with nothing open is an orphan, not a trade; the next buy opens normally", () => {
    const r = buildRoundTrips([
      fill("S", 10, "A", 5, "2026-03-02 10:00:00"),
      fill("C", 10, "B", 5, "2026-03-02 10:00:00"),
      fill("B", 10, "A", 5, "2026-03-02 10:05:00"),
    ]);
    expect(r.orphanFills.map((f) => f.symbol)).toEqual(["A", "B"]);
    expect(r.trips.map((t) => [t.symbol, t.result])).toEqual([["A", "open"]]);
  });

  it("two trips opened in the same second get #2 suffixes", () => {
    const { trips } = buildRoundTrips([
      fill("B", 1, "A", 1, "2026-03-02 10:00:00"), fill("S", 1, "A", 1, "2026-03-02 10:00:00"),
      fill("B", 1, "A", 1, "2026-03-02 10:00:00"), fill("S", 1, "A", 1, "2026-03-02 10:00:00"),
    ]);
    expect(trips.map((t) => t.externalId)).toEqual(["ACC|A|2026-03-02T10:00:00|Long", "ACC|A|2026-03-02T10:00:00|Long#2"]);
  });

  it("accounts and symbols never mix", () => {
    const { trips } = buildRoundTrips([
      fill("B", 10, "A", 1, "2026-03-02 10:00:00", {}, { account: "ONE" }),
      fill("S", 10, "A", 2, "2026-03-02 10:01:00", {}, { account: "TWO" }), // orphan for TWO
      fill("B", 10, "B", 1, "2026-03-02 10:00:00", {}, { account: "ONE" }),
    ]);
    expect(trips.map((t) => `${t.account}:${t.symbol}:${t.result}`).sort()).toEqual(["ONE:A:open", "ONE:B:open"]);
  });

  it("fee split across a zero-crossing fill is pro-rata per column", () => {
    const { trips } = buildRoundTrips([
      fill("B", 100, "X", 10, "2026-03-02 10:00:00"),
      fill("S", 400, "X", 10, "2026-03-02 10:01:00", { comm: 4, sec: 0.4 }),
      fill("C", 300, "X", 10, "2026-03-02 10:02:00"),
    ]);
    expect(trips[0].fees).toEqual({ comm: 1, sec: expect.closeTo(0.1, 9) });
    expect(trips[1].fees).toEqual({ comm: 3, sec: expect.closeTo(0.3, 9) });
    expect(sumFees(trips[0].fees) + sumFees(trips[1].fees)).toBeCloseTo(4.4, 9);
  });
});
