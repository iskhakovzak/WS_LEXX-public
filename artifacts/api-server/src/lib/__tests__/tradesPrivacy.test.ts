import { describe, expect, it } from "vitest";
import {
  BOOK_DAY_MONEY_FIELDS, BOOK_SUMMARY_MONEY_FIELDS, TRADE_MONEY_FIELDS, canSeeBookMoney, redactBookDay,
  redactBookSummary, redactExecutions, redactTradeRow, redactTradeRows, type MoneyViewer,
} from "../playbookPrivacy";
import { MONEY_PRESETS, MONEY_SORT_COLS, PAGE_SORT_COLS, buildPageQuery } from "../tradesPageQuery";

// $ privacy on the trades API (routes/trades.ts, routes/executions.ts) — same rule as the playbook.
const alex: MoneyViewer = { name: "Алекс", staff: false };
const curator: MoneyViewer = { name: "Ориф", staff: true };
const guest: MoneyViewer = { name: null, staff: false };

/** A row in the shape of routes/trades.ts toTradeResponseShape (GET /trades, /trades/:id, /trades/page items). */
const trade = {
  id: 42, ticker: "NVDA", date: "2026-03-02", exitDate: "2026-03-02", side: "Long", result: "win", setup: "ORB",
  entry: 101.5, exit: 104.25, stop: 100.5, rMultiple: 2.75, holdTime: "29m", horizon: "intraday", trader: "Сеня",
  notes: "пробой по плану", tags: "A+", source: "propreports", createdAt: "2026-03-02T15:10:00.000Z",
  pnl: 275, slippage: 0, qty: 100, fees: -6.6, riskUsd: 100,
};

describe("trade rows (GET /trades, /trades/:id, /trades/page)", () => {
  it("covers every $ field of the trade response shape", () => {
    for (const k of ["pnl", "slippage", "qty", "fees", "riskUsd"]) expect(TRADE_MONEY_FIELDS).toContain(k);
  });

  it("another trader's trade: $ null, prices / R / text kept, redacted: true", () => {
    const r = redactTradeRow(trade, alex);
    expect(r.redacted).toBe(true);
    expect([r.pnl, r.slippage, r.qty, r.fees, r.riskUsd]).toEqual([null, null, null, null, null]);
    expect(r).toMatchObject({ ticker: "NVDA", entry: 101.5, exit: 104.25, stop: 100.5, rMultiple: 2.75, trader: "Сеня", notes: "пробой по плану" });
  });

  it("owner and staff get it untouched (redacted: false)", () => {
    expect(redactTradeRow(trade, { name: "Сеня", staff: false })).toEqual({ ...trade, redacted: false });
    expect(redactTradeRow(trade, curator)).toEqual({ ...trade, redacted: false });
  });

  it("guest never sees $, list redacts per row", () => {
    const own = { ...trade, id: 43, trader: "Алекс" };
    expect(redactTradeRow(trade, guest).pnl).toBeNull();
    expect(redactTradeRows([trade, own], alex).map((t) => [t.id, t.redacted, t.pnl])).toEqual([[42, true, null], [43, false, 275]]);
  });

  it("slippage 0 is a value, not 'absent' — still nulled", () => {
    expect(redactTradeRow(trade, alex).slippage).toBeNull();
  });
});

describe("canSeeBookMoney (GET /trades/page, /trades/days scope)", () => {
  it("own book: yes; someone else's or the whole desk: staff only", () => {
    expect(canSeeBookMoney(alex, "Алекс")).toBe(true);
    expect(canSeeBookMoney(alex, "Сеня")).toBe(false);
    expect(canSeeBookMoney(alex, null)).toBe(false);
    expect(canSeeBookMoney(curator, "Сеня")).toBe(true);
    expect(canSeeBookMoney(curator, null)).toBe(true);
    expect(canSeeBookMoney(guest, "∅guest")).toBe(false);
  });
});

describe("redactBookSummary", () => {
  const summary = {
    total: 10, wins: 6, losses: 3, be: 1, open: 0, decided: 9, winRate: 0.667, pnlCount: 10,
    totalR: 7.5, rCount: 8, avgR: 0.94, avgWinR: 1.8, avgLossR: -1, expectancyR: 0.8, posR: 10.5, negR: 3, profitFactor: 3.5,
    curve: [{ i: 1, r: 1.2, label: "02.03" }], streak: { kind: "win", n: 2 }, days: 4, untagged: 1,
    gross: 1200, fees: -60, net: 1140, avgWinNet: 250, avgLossNet: -120, posNet: 1500, negNet: 360,
    profitFactorNet: 4.17, maxNet: 410, minNet: -150,
  };

  it("nulls every $ metric, keeps counts / R / curve", () => {
    const r = redactBookSummary(summary);
    expect(r.redacted).toBe(true);
    for (const k of BOOK_SUMMARY_MONEY_FIELDS) expect(r[k]).toBeNull();
    expect(r).toMatchObject({ total: 10, wins: 6, winRate: 0.667, totalR: 7.5, profitFactor: 3.5, curve: summary.curve, days: 4 });
  });
});

describe("redactBookDay", () => {
  it("nulls $ and empties the per-trade $ sequence", () => {
    const day = { date: "2026-03-02", count: 3, wins: 2, losses: 1, winRate: 0.67, rCount: 2, totalR: 1.4,
      gross: 300, fees: -9, net: 291, maxNet: 220, minNet: -80, seq: [220, -80, 151] };
    const r = redactBookDay(day);
    expect(r.redacted).toBe(true);
    for (const k of BOOK_DAY_MONEY_FIELDS) expect(r[k]).toBeNull();
    expect(r.seq).toEqual([]);
    expect(r).toMatchObject({ date: "2026-03-02", count: 3, winRate: 0.67, totalR: 1.4 });
    expect(day.seq).toEqual([220, -80, 151]); // input untouched
  });
});

describe("redactExecutions (GET /trades/:id/executions)", () => {
  const fills = [
    { id: 1, tradeId: 42, kind: "entry", price: "101.5", qty: "100", executedAt: "2026-03-02T14:41:00.000Z", note: null, sortOrder: 0 },
    { id: 2, tradeId: 42, kind: "exit", price: "104.25", qty: "100", executedAt: "2026-03-02T15:10:00.000Z", note: null, sortOrder: 1 },
  ];

  it("someone else's fills: qty null, price / time kept", () => {
    const r = redactExecutions(fills, alex, "Сеня");
    expect(r.map((f) => f.qty)).toEqual([null, null]);
    expect(r.map((f) => [f.price, f.executedAt])).toEqual(fills.map((f) => [f.price, f.executedAt]));
  });

  it("cuts fee amounts out of notes (PropReports writes «· fees 0.42»), keeps the rest", () => {
    const withNotes = [
      { ...fills[0], note: "PropReports B #9912 · fees 0.42" },
      { ...fills[1], note: "fee: $1.10" },
      { ...fills[1], id: 3, note: "добор на ретесте" },
    ];
    expect(redactExecutions(withNotes, alex, "Сеня").map((f) => f.note)).toEqual(["PropReports B #9912", null, "добор на ретесте"]);
    expect(redactExecutions(withNotes, { name: "Сеня", staff: false }, "Сеня")[0].note).toBe("PropReports B #9912 · fees 0.42");
  });

  it("owner / staff: unchanged; guest: redacted", () => {
    expect(redactExecutions(fills, { name: "Сеня", staff: false }, "Сеня")).toBe(fills);
    expect(redactExecutions(fills, curator, "Сеня")).toBe(fills);
    expect(redactExecutions(fills, guest, "Сеня")[0].qty).toBeNull();
  });
});

describe("/trades/page on a book whose $ the viewer may not see", () => {
  const sort = { col: "date" as const, dir: "desc" as const };

  it("free text does not match pnl when moneyBlind (an amount search would be an oracle)", () => {
    const seen = buildPageQuery({ filters: { scope: "Сеня", q: "275" }, sort, limit: 10, quality: false });
    const blind = buildPageQuery({ filters: { scope: "Сеня", q: "275", moneyBlind: true }, sort, limit: 10, quality: false });
    expect(seen.sql).toContain("t.pnl::text");
    expect(blind.sql).not.toContain("pnl::text");
    expect(blind.sql).toContain("r_multiple::text");
  });

  it("$ sorts and $ presets are known to the route", () => {
    for (const c of ["pnl", "gross", "fees", "impact", "left"] as const) expect(MONEY_SORT_COLS.has(c)).toBe(true);
    for (const c of ["date", "r", "result", "ticker", "hold", "mfeR", "exitEff"] as const) expect(MONEY_SORT_COLS.has(c)).toBe(false);
    for (const c of MONEY_SORT_COLS) expect(PAGE_SORT_COLS).toContain(c);
    expect(MONEY_PRESETS.has("fees")).toBe(true);
    expect(MONEY_PRESETS.has("review")).toBe(false);
  });
});
