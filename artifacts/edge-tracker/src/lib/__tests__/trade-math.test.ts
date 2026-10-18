import { describe, expect, it } from "vitest";
import {
  byCloseDate, closeDate, computeKpis, feesOf, grossPnl, horizonOf, isClosed, isDecided, isOpen,
  maxDrawdown, netPnl, num, priceR, resultConflictsWithPrice, signedR, type TradeLike,
} from "@/lib/trade-math";
import { TRADE_ROWS } from "../../../../api-server/src/lib/__tests__/fixtures/trade-rows";

describe("trade-math.num", () => {
  it.each([
    [null, null], [undefined, null], ["", null], ["  ", null], ["1e3", 1000], ["x", null], [5, 5],
  ])("num(%j) → %j", (v, e) => expect(num(v)).toBe(e));
});

describe("trade-math.signedR / netPnl (client JS, shared fixture)", () => {
  it.each(TRADE_ROWS.map((r) => [r.id, r.name, r] as const))("#%i %s", (_id, _name, row) => {
    const r = signedR(row);
    if (row.expectR == null) expect(r).toBeNull();
    else expect(r).toBeCloseTo(row.expectR, 9);
    const net = netPnl(row);
    if (row.expectNet == null) expect(net).toBeNull();
    else expect(net).toBeCloseTo(row.expectNet, 9);
  });
});

describe("trade-math.priceR", () => {
  it.each<[string, TradeLike, number | null]>([
    ["long +2R", { side: "long", entry: 100, exit: 110, stop: 95 }, 2],
    ["long −1R", { side: "long", entry: 100, exit: 95, stop: 95 }, -1],
    ["short +2R", { side: "short", entry: 100, exit: 96, stop: 102 }, 2],
    ["short −1R", { side: "SHORT", entry: 100, exit: 102, stop: 102 }, -1],
    ["side null ⇒ long", { entry: 10, exit: 11, stop: 9 }, 1],
    ["stop == entry ⇒ null", { side: "long", entry: 100, exit: 110, stop: 100 }, null],
    ["missing exit ⇒ null", { side: "long", entry: 100, stop: 90 }, null],
    ["missing stop ⇒ null", { side: "long", entry: 100, exit: 110 }, null],
    ["string prices", { side: "long", entry: "100", exit: "105", stop: "99" }, 5],
    ["clamped", { side: "long", entry: 1, exit: 1000, stop: 0.99 }, 20],
    ["stop on the wrong side still measures |entry−stop|", { side: "long", entry: 100, exit: 104, stop: 102 }, 2],
  ])("%s", (_n, t, e) => {
    if (e == null) expect(priceR(t)).toBeNull();
    else expect(priceR(t)).toBeCloseTo(e, 9);
  });
});

describe("trade-math predicates", () => {
  it("isOpen / isClosed / isDecided", () => {
    expect(isOpen({ result: "open" })).toBe(true);
    expect(isOpen({ result: " Open " })).toBe(true);
    expect(isOpen({ result: null })).toBe(false);
    expect(isOpen({ result: "" })).toBe(false);
    expect(isClosed({ result: "win" })).toBe(true);
    expect(isClosed({ result: "be" })).toBe(true);
    expect(isClosed({ result: "open" })).toBe(false);
    expect(isClosed({ result: null })).toBe(false);
    expect(isDecided({ result: "win" })).toBe(true);
    expect(isDecided({ result: "loss" })).toBe(true);
    expect(isDecided({ result: "be" })).toBe(false);
    expect(isDecided({ result: "open" })).toBe(false);
  });

  it("horizonOf / closeDate / feesOf / grossPnl", () => {
    expect(horizonOf({ horizon: "swing" })).toBe("swing");
    expect(horizonOf({ horizon: "overnight" })).toBe("overnight");
    expect(horizonOf({ horizon: "" })).toBe("intraday");
    expect(horizonOf({ horizon: "weird" })).toBe("intraday");
    expect(horizonOf({})).toBe("intraday");
    expect(closeDate({ date: "2026-03-02", exitDate: "2026-03-05" })).toBe("2026-03-05");
    expect(closeDate({ date: "2026-03-02", exitDate: "" })).toBe("2026-03-02");
    expect(closeDate({})).toBeNull();
    expect(feesOf({ fees: -4 })).toBe(4);
    expect(feesOf({})).toBe(0);
    expect(grossPnl({ pnl: "12" })).toBe(12);
    expect(grossPnl({})).toBeNull();
  });
});

describe("trade-math.resultConflictsWithPrice", () => {
  it.each<[string, TradeLike, boolean]>([
    ["win but price went down (long)", { result: "win", side: "long", entry: 100, exit: 95, stop: 90 }, true],
    ["loss but price went up (long)", { result: "loss", side: "long", entry: 100, exit: 105, stop: 90 }, true],
    ["win on a short that went up", { result: "win", side: "short", entry: 100, exit: 105, stop: 110 }, true],
    ["loss on a short that went down", { result: "loss", side: "short", entry: 100, exit: 95, stop: 110 }, true],
    ["consistent win", { result: "win", side: "long", entry: 100, exit: 105, stop: 90 }, false],
    ["consistent loss", { result: "loss", side: "short", entry: 100, exit: 105, stop: 110 }, false],
    ["be never conflicts", { result: "be", side: "long", entry: 100, exit: 90, stop: 95 }, false],
    ["open never conflicts", { result: "open", side: "long", entry: 100, exit: 90, stop: 95 }, false],
    ["exit == entry never conflicts", { result: "loss", side: "long", entry: 100, exit: 100, stop: 95 }, false],
    ["no prices ⇒ false", { result: "loss", pnl: 500 }, false],
    ["stop == entry ⇒ no price R ⇒ false", { result: "loss", side: "long", entry: 100, exit: 110, stop: 100 }, false],
  ])("%s", (_n, t, e) => expect(resultConflictsWithPrice(t)).toBe(e));
});

describe("trade-math.maxDrawdown", () => {
  it.each<[number[], number]>([
    [[], 0],
    [[1, 2, 3], 0],
    [[-1], -1],
    [[1, -2, 3, -5], -5],
    [[2, -1, -1, 4, -3], -3],
    [[-1, -1, -1], -3],
    [[5, -5, 5, -5], -5],
  ])("maxDrawdown(%j) → %d", (values, e) => expect(maxDrawdown(values)).toBe(e));
});

describe("trade-math.computeKpis", () => {
  const book: TradeLike[] = [
    { result: "win", rMultiple: 2, pnl: 200, fees: 2, date: "2026-03-02" },
    { result: "loss", rMultiple: 1, pnl: -100, fees: 2, date: "2026-03-03" },
    { result: "be", rMultiple: 0.1, pnl: 0, fees: 1, date: "2026-03-04" },
    { result: "open", rMultiple: 5, pnl: 999, fees: 0, date: "2026-03-05" },
    { result: "win", entry: 10, exit: 11, stop: 9, pnl: 100, fees: 1, date: "2026-03-06" },
    { result: "loss", pnl: -50, fees: 1, date: "2026-03-09" }, // no R, counted in WR and $ only
    { result: null, pnl: 1000, fees: 0, date: "2026-03-10" }, // unknown: ignored entirely
  ];

  it("counts, win rate excludes BE, open and unknown excluded", () => {
    const k = computeKpis(book);
    expect(k.trades).toBe(7);
    expect(k.open).toBe(1);
    expect(k.closed).toBe(5);
    expect(k.wins).toBe(2);
    expect(k.losses).toBe(2);
    expect(k.be).toBe(1);
    expect(k.winRate).toBeCloseTo(0.5, 9);
  });

  it("R: total, count, expectancy, PF", () => {
    const k = computeKpis(book);
    // 2, −1, 0, (open skipped), +1, (no R)
    expect(k.rCount).toBe(4);
    expect(k.totalR).toBeCloseTo(2, 9);
    expect(k.expectancyR).toBeCloseTo(0.5, 9);
    expect(k.profitFactorR).toBeCloseTo(3 / 1, 9);
  });

  it("money: gross, net, fees, counts", () => {
    const k = computeKpis(book);
    expect(k.pnlCount).toBe(5);
    expect(k.grossPnl).toBe(200 - 100 + 0 + 100 - 50);
    expect(k.fees).toBe(2 + 2 + 1 + 1 + 1);
    expect(k.netPnl).toBe(198 - 102 - 1 + 99 - 51);
  });

  it("drawdowns follow close-date order, not input order", () => {
    const shuffled = [book[4], book[1], book[0], book[5], book[2], book[3], book[6]];
    const k = computeKpis(shuffled);
    // chronological R: +2, −1, 0, +1 → cum 2,1,1,2 → dd −1 ; net: 198, −102, −1, 99, −51 → cum 198, 96, 95, 194, 143 → dd −103
    expect(k.maxDrawdownR).toBe(-1);
    expect(k.maxDrawdownNet).toBe(-103);
  });

  it("empty / no-loss / no-money edge cases", () => {
    const e = computeKpis([]);
    expect(e.winRate).toBeNull();
    expect(e.expectancyR).toBeNull();
    expect(e.profitFactorR).toBeNull();
    expect(e.grossPnl).toBeNull();
    expect(e.netPnl).toBeNull();
    expect(e.maxDrawdownNet).toBeNull();
    expect(e.maxDrawdownR).toBe(0);

    const onlyWins = computeKpis([{ result: "win", rMultiple: 1 }, { result: "win", rMultiple: 2 }]);
    expect(onlyWins.profitFactorR).toBeNull(); // never ∞
    expect(onlyWins.winRate).toBe(1);
    expect(onlyWins.netPnl).toBeNull();

    const onlyBe = computeKpis([{ result: "be", pnl: 5, fees: 1 }]);
    expect(onlyBe.winRate).toBeNull();
    expect(onlyBe.closed).toBe(1);
    expect(onlyBe.expectancyR).toBe(0);
    expect(onlyBe.netPnl).toBe(4);
  });

  it("multi-day holds are ordered by exitDate", () => {
    const sorted = byCloseDate([
      { date: "2026-03-02", exitDate: "2026-03-10", result: "win" },
      { date: "2026-03-05", result: "loss" },
    ]);
    expect(sorted.map((t) => t.date)).toEqual(["2026-03-05", "2026-03-02"]);
  });
});
