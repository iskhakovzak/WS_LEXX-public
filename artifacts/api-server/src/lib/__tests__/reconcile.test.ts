import { describe, expect, it } from "vitest";
import {
  FEE_ROUNDING_LABEL, classify, compareMoney, feeRoundingCause, groupTolerance, issuesCsv, plural, reconcile, reportFrom, roundingTolerance, snapshotFrom, weekdayOf,
  type RecExecution, type RecReport, type RecTrade,
} from "../reconcile";

let nextId = 1;
function trade(p: Partial<RecTrade> & { pnl: number; fees: number }): RecTrade {
  const id = p.id ?? nextId++;
  const net = p.pnl - Math.abs(p.fees);
  return {
    id, trader: "T", ticker: "AAPL", date: "2026-03-02", exitDate: null, side: "Long", qty: 100, entry: 10, exit: 10 + p.pnl / 100,
    result: net > 0 ? "win" : net < 0 ? "loss" : "be", source: "propreports", externalId: `X${id}`, account: "A1",
    broker: { gross: p.pnl, net, totalFees: p.fees, feesByType: { comm: p.fees }, qty: p.qty ?? 100, avgEntry: 10, avgExit: 10 + p.pnl / 100, openedAt: `2026-03-02T10:00:${String(id % 60).padStart(2, "0")}`, closedAt: null, openQty: 0, fromReport: false },
    ...p,
  };
}
function fills(t: RecTrade, over: Partial<{ entryAt: string; exitAt: string; exitQty: number }> = {}): RecExecution[] {
  return [
    { id: t.id * 10, tradeId: t.id, kind: "entry", price: t.entry, qty: t.qty, executedAt: over.entryAt ?? "2026-03-02T15:00:00.000Z" },
    { id: t.id * 10 + 1, tradeId: t.id, kind: "exit", price: t.exit, qty: over.exitQty ?? t.qty, executedAt: over.exitAt ?? "2026-03-02T15:10:00.000Z" },
  ];
}
function report(totals: Partial<RecReport["totals"]>, extra: Partial<RecReport> = {}): RecReport {
  return {
    id: 1, account: "A1", trader: "T", periodFrom: "2026-03-01", periodTo: "2026-03-31",
    totals: { trades: 0, wins: 0, losses: 0, gross: 0, fees: 0, net: 0, ...totals },
    feeAverages: null, bySide: {}, byWeekday: {}, bySymbol: {}, ...extra,
  };
}

describe("tolerances and statuses", () => {
  it("classifies ✓ ≤ $0.01, ⚠ < $1, ✗ otherwise", () => {
    expect(classify(0.01, 0.01)).toBe("ok");
    expect(classify(-0.009, 0.01)).toBe("ok");
    expect(classify(0.02, 0.01)).toBe("warn");
    expect(classify(-0.99, 0.01)).toBe("warn");
    expect(classify(1, 0.01)).toBe("error");
    expect(classify(null, 0.01)).toBe("na");
  });
  it("rounding band grows with √N and never drops below the base", () => {
    expect(roundingTolerance(1)).toBe(0.01);
    expect(roundingTolerance(910)).toBe(0.15);
    expect(groupTolerance(23)).toBe(0.04);
    expect(groupTolerance(910)).toBeGreaterThan(roundingTolerance(910));
  });
  it("marks rounding-level differences with a note", () => {
    const c = compareMoney("net", "Нетто", 64.97, 64.9874, 0.15);
    expect(c.status).toBe("ok");
    expect(c.note).toBe("в пределах округления брокера"); // raw diff −0.0174: above $0.01, inside the √N band
  });
  it("Russian plural", () => {
    expect(plural(1, "расхождение", "расхождения", "расхождений")).toBe("расхождение");
    expect(plural(3, "расхождение", "расхождения", "расхождений")).toBe("расхождения");
    expect(plural(11, "расхождение", "расхождения", "расхождений")).toBe("расхождений");
    expect(plural(25, "расхождение", "расхождения", "расхождений")).toBe("расхождений");
  });
  it("weekday of a YMD", () => {
    expect(weekdayOf("2026-01-12")).toBe("monday");
    expect(weekdayOf("2026-10-15")).toBe("thursday");
  });
});

describe("reconcile — clean book", () => {
  it("everything matches → «Данные сходятся с брокером»", () => {
    const a = trade({ pnl: 25.6, fees: 0.08 });
    const b = trade({ pnl: -3.3, fees: 0.29, ticker: "INTC", side: "Long" });
    const rep = report({ trades: 2, wins: 1, losses: 1, gross: 22.3, fees: 0.37, net: 21.93 });
    const res = reconcile([a, b], [...fills(a), ...fills(b)], [rep]);
    expect(res.summary.discrepancies).toBe(0);
    expect(res.summary.label).toBe("Данные сходятся с брокером");
    expect(res.summary.status).toBe("ok");
    expect(res.days).toHaveLength(1);
    expect(res.days[0].status).toBe("ok");
    expect(res.days[0].journal.net).toBe(21.93);
    expect(res.reports[0].compares.every((c) => c.status === "ok")).toBe(true);
  });
});

describe("reconcile — the 64.74 vs 64.97 case (fees summed from rounded columns)", () => {
  it("flags fees/net vs the broker report as ⚠ with a rounding hint", () => {
    // 30 trades: broker true fee 0.105 each (report total 3.15), journal stored the cent-rounded column sum 0.11
    const ts = Array.from({ length: 30 }, (_, i) => trade({ pnl: 1, fees: 0.11, ticker: `S${i % 3}` }));
    const rep = report({ trades: 30, wins: 30, losses: 0, gross: 30, fees: 3.15, net: 26.85 });
    const res = reconcile(ts, ts.flatMap((t) => fills(t)), [rep]);
    const fees = res.reports[0].compares.find((c) => c.key === "fees")!;
    const net = res.reports[0].compares.find((c) => c.key === "net")!;
    expect(fees.diff).toBe(0.15);
    expect(fees.status).toBe("warn"); // band for 30 rows = 0.03
    expect(net.status).toBe("warn");
    const issue = res.issues.find((i) => i.kind === "total_mismatch" && /комиссии/.test(i.message))!;
    expect(issue.hint).toMatch(/округл/);
    expect(issue.cause).toBe("fee_rounding"); // 0.15 ≤ $0.01 × 30 trades
    expect(issue.message).toContain(FEE_ROUNDING_LABEL);
    expect(fees.cause).toBe("fee_rounding");
    expect(res.summary.roundingIssues).toBe(2);
    expect(res.summary.label).toMatch(/расхожден/);
  });
  it("is ✓ once fees = gross − broker Net (difference within the rounding band)", () => {
    const ts = Array.from({ length: 30 }, () => trade({ pnl: 1, fees: 0.10 }));
    // report keeps sub-cent precision: 0.1002 avg fee → 3.006 total
    const rep = report({ trades: 30, wins: 30, losses: 0, gross: 30, fees: 3.006, net: 26.994 });
    const res = reconcile(ts, ts.flatMap((t) => fills(t)), [rep]);
    expect(res.reports[0].compares.every((c) => c.status === "ok")).toBe(true);
  });
  it("a serious gap (≥ $1) is ✗ and not blamed on rounding", () => {
    const ts = [trade({ pnl: 100, fees: 1 })];
    const res = reconcile(ts, fills(ts[0]), [report({ trades: 1, wins: 1, gross: 100, fees: 1, net: 97.5 })]);
    const net = res.reports[0].compares.find((c) => c.key === "net")!;
    expect(net.status).toBe("error");
    expect(net.cause).toBeUndefined();
  });
  it("per-day gap ≤ $0.01 × trades → «расхождение из-за округления комиссий»", () => {
    const ts = Array.from({ length: 5 }, () => trade({ pnl: 2, fees: 0.11, date: "2026-03-03" }));
    const other = trade({ pnl: 2, fees: 0.5, date: "2026-03-04" });
    const res = reconcile([...ts, other], [...ts, other].flatMap((t) => fills(t)), [], {}, [
      { date: "2026-03-03", trades: 5, gross: 10, fees: 0.5, net: 9.5 }, // journal fees 0.55: gap 0.05 ≤ 0.01 × 5 → rounding
      { date: "2026-03-04", trades: 1, gross: 2, fees: 0.3, net: 1.7 }, // gap 0.20 > 0.01 × 1 → real
    ]);
    const d3 = res.issues.find((i) => i.kind === "day_mismatch" && i.date === "2026-03-03")!;
    const d4 = res.issues.find((i) => i.kind === "day_mismatch" && i.date === "2026-03-04")!;
    expect(d3.cause).toBe("fee_rounding");
    expect(d3.message).toContain(FEE_ROUNDING_LABEL);
    expect(d4.cause).toBeUndefined();
    expect(feeRoundingCause("gross", 0.01, 10)).toBeUndefined();
    expect(feeRoundingCause("net", 0, 10)).toBeUndefined();
  });
});

describe("reconcile — per-trade checks", () => {
  it("journal edited away from the broker snapshot", () => {
    const t = trade({ pnl: 10, fees: 0.5 });
    t.pnl = 12; // trader overwrote gross
    const res = reconcile([t], fills(t));
    const g = res.issues.find((i) => i.kind === "gross_edited")!;
    expect(g.severity).toBe("error");
    expect(g.tradeIds).toEqual([t.id]);
    expect(res.days[0].status).toBe("error");
    expect(res.days[0].compares.find((c) => c.key === "gross")!.diff).toBe(2);
  });
  it("negative fees (ABS would flip a rebate)", () => {
    const t = trade({ pnl: 5, fees: 0.1 });
    t.fees = -0.1;
    const res = reconcile([t], fills(t));
    expect(res.issues.some((i) => i.kind === "negative_fees")).toBe(true);
  });
  it("fee breakdown within per-column rounding is not an issue, beyond it is", () => {
    const ok = trade({ pnl: 5, fees: 0.1 });
    ok.broker!.feesByType = { comm: 0.08, ecn: -0.04, taf: 0.02, nscc: 0.04 }; // Σ 0.10
    ok.broker!.totalFees = 0.11; // broker total from unrounded columns: 0.01 off, 4 columns → tolerated
    ok.fees = 0.11; ok.broker!.net = 4.89;
    const bad = trade({ pnl: 5, fees: 0.5 });
    bad.broker!.feesByType = { comm: 0.1 };
    const res = reconcile([ok, bad], [...fills(ok), ...fills(bad)]);
    const fb = res.issues.filter((i) => i.kind === "fee_breakdown_mismatch");
    expect(fb.map((i) => i.tradeIds[0])).toEqual([bad.id]);
  });
  it("result vs net sign", () => {
    const t = trade({ pnl: 0.05, fees: 0.2 });
    t.result = "win";
    const res = reconcile([t], fills(t));
    expect(res.issues.some((i) => i.kind === "result_sign")).toBe(true);
  });
});

describe("reconcile — executions", () => {
  it("broker trade without fills is ✗; manual without fills is only counted", () => {
    const b = trade({ pnl: 1, fees: 0.1 });
    const m = trade({ pnl: 2, fees: 0.1, source: "manual", broker: null, externalId: null, ticker: "MSFT" });
    const res = reconcile([b, m], []);
    expect(res.issues.filter((i) => i.kind === "no_fills").map((i) => i.tradeIds[0])).toEqual([b.id]);
    expect(res.summary.fills).toEqual({ withFills: 0, withoutFills: 2, brokerWithoutFills: 1 });
    expect(res.summary.manual.net).toBe(1.9);
    expect(res.summary.journal.trades).toBe(1);
  });
  it("missing exit, exit before entry, qty mismatch", () => {
    const a = trade({ pnl: 1, fees: 0.1 });
    const b = trade({ pnl: 1, fees: 0.1 });
    const c = trade({ pnl: 1, fees: 0.1 });
    const ex = [
      fills(a)[0],
      ...fills(b, { entryAt: "2026-03-02T15:00:00Z", exitAt: "2026-03-02T14:59:00Z" }),
      ...fills(c, { exitQty: 60 }),
    ];
    const res = reconcile([a, b, c], ex);
    const kinds = (id: number) => res.issues.filter((i) => i.tradeIds.includes(id)).map((i) => i.kind);
    expect(kinds(a.id)).toContain("no_exit");
    expect(kinds(b.id)).toContain("exit_before_entry");
    expect(kinds(c.id)).toContain("fill_qty_mismatch");
  });
  it("gross from fills vs trade gross (side-aware)", () => {
    const t = trade({ pnl: 50, fees: 1, side: "Short", entry: 10, exit: 9.5 }); // short 10 → 9.5 × 100 = +50 ✓
    const wrongSide = trade({ pnl: 50, fees: 1, side: "Long", entry: 10, exit: 9.5 }); // long → −50 ✗
    const res = reconcile([t, wrongSide], [...fills(t), ...fills(wrongSide)]);
    const g = res.issues.filter((i) => i.kind === "fill_gross_mismatch");
    expect(g.map((i) => i.tradeIds[0])).toEqual([wrongSide.id]);
    expect(g[0].severity).toBe("error");
  });
});

describe("reconcile — duplicates", () => {
  it("same external id, same ticker+time+qty, manual twin", () => {
    const a = trade({ pnl: 3, fees: 0.1, externalId: "DUP" });
    const b = trade({ pnl: 3, fees: 0.1, externalId: "DUP" });
    const c = trade({ pnl: 4, fees: 0.1, ticker: "NVDA" });
    const d = trade({ pnl: 4, fees: 0.1, ticker: "NVDA" });
    d.broker!.openedAt = c.broker!.openedAt;
    const m = trade({ pnl: 4, fees: 0.1, ticker: "NVDA", source: "manual", broker: null, externalId: null });
    const res = reconcile([a, b, c, d, m], [a, b, c, d].flatMap((t) => fills(t)));
    expect(res.issues.find((i) => i.kind === "duplicate_external_id")!.tradeIds).toEqual([a.id, b.id]);
    expect(res.issues.find((i) => i.kind === "duplicate_fill_key")!.tradeIds).toEqual([c.id, d.id]);
    const twin = res.issues.find((i) => i.kind === "manual_twin")!;
    expect(twin.tradeIds[0]).toBe(m.id);
    expect(twin.severity).toBe("warn");
  });
});

describe("reconcile — days and broker days", () => {
  it("days missing on either side", () => {
    const t1 = trade({ pnl: 5, fees: 0.1, date: "2026-03-02" });
    const t2 = trade({ pnl: 5, fees: 0.1, date: "2026-03-04" });
    const res = reconcile([t1, t2], [...fills(t1), ...fills(t2)], [], {}, [
      { date: "2026-03-02", trades: 1, gross: 5, fees: 0.1, net: 4.9 },
      { date: "2026-03-03", trades: 2, gross: 10, fees: 0.2, net: 9.8 },
    ]);
    expect(res.summary.hasBrokerDays).toBe(true);
    expect(res.days.map((d) => [d.date, d.status])).toEqual([["2026-03-02", "ok"], ["2026-03-03", "error"], ["2026-03-04", "error"]]);
    expect(res.issues.find((i) => i.kind === "day_missing_in_journal")!.date).toBe("2026-03-03");
    expect(res.issues.find((i) => i.kind === "day_missing_at_broker")!.date).toBe("2026-03-04");
  });
  it("manual-only day inside a broker report period is ⚠", () => {
    const m = trade({ pnl: 5, fees: 0.1, date: "2026-03-05", source: "manual", broker: null, externalId: null });
    const res = reconcile([m], [], [report({})]);
    expect(res.issues.some((i) => i.kind === "day_missing_at_broker" && i.severity === "warn")).toBe(true);
    expect(res.issues.some((i) => i.kind === "manual_in_broker_period")).toBe(true);
  });
  it("from/to filter by NY close date", () => {
    const a = trade({ pnl: 1, fees: 0.1, date: "2026-03-02" });
    const b = trade({ pnl: 1, fees: 0.1, date: "2026-03-02", exitDate: "2026-03-09" });
    const res = reconcile([a, b], [], [], { from: "2026-03-05", to: "2026-03-10" });
    expect(res.summary.tradesChecked).toBe(1);
    expect(res.days.map((d) => d.date)).toEqual(["2026-03-09"]);
  });
});

describe("reconcile — report groups", () => {
  it("symbols missing on either side and side/weekday mismatches", () => {
    const a = trade({ pnl: 10, fees: 0.1, ticker: "AAPL", date: "2026-03-02" }); // Monday
    const rep = report(
      { trades: 2, wins: 2, gross: 20, fees: 0.2, net: 19.8 },
      {
        bySide: { long: { trades: 2, wins: 2, losses: 0, gross: 20, fees: 0.2, net: 19.8 } },
        byWeekday: { monday: { trades: 2, wins: 2, losses: 0, gross: 20, fees: 0.2, net: 19.8 } },
        bySymbol: { AAPL: { trades: 1, wins: 1, losses: 0, gross: 10, fees: 0.1, net: 9.9 }, TSLA: { trades: 1, wins: 1, losses: 0, gross: 10, fees: 0.1, net: 9.9 } },
      },
    );
    const res = reconcile([a], fills(a), [rep]);
    const rc = res.reports[0];
    expect(rc.symbolsMissingInJournal).toEqual(["TSLA"]);
    expect(rc.compares.find((c) => c.key === "trades")!.status).toBe("error");
    expect(rc.groups.find((g) => g.scope === "side")!.status).toBe("error");
    expect(res.issues.some((i) => i.kind === "symbol_missing_in_journal" && i.ticker === "TSLA")).toBe(true);
    expect(rc.status).toBe("error");
  });
  it("fee types: journal breakdown vs report average × trades", () => {
    const ts = Array.from({ length: 10 }, () => trade({ pnl: 2, fees: 0.6 }));
    for (const t of ts) t.broker!.feesByType = { comm: 0.5, ecn: 0.1 };
    const rep = report({ trades: 10, wins: 10, gross: 20, fees: 6, net: 14 }, { feeAverages: { comm: 0.4, ecn: 0.15 } });
    const res = reconcile(ts, ts.flatMap((t) => fills(t)), [rep]);
    const ft = res.reports[0].feeTypes;
    expect(ft.find((c) => c.key === "fee:comm")!.diff).toBe(1);
    expect(ft.find((c) => c.key === "fee:comm")!.status).toBe("error");
    expect(ft.find((c) => c.key === "fee:ecn")!.status).toBe("warn");
  });
});

describe("adapters", () => {
  it("snapshotFrom reads a PropReports context_snapshot", () => {
    const s = snapshotFrom({ source: "propreports", gross: 1.51, net: 1.4, totalFees: 0.11, feesByType: { comm: "0.09", ecn: -0.04 }, qty: 11, openedAt: "2026-01-12T10:54:39", fromReport: true });
    expect(s).toMatchObject({ gross: 1.51, net: 1.4, totalFees: 0.11, qty: 11, fromReport: true, feesByType: { comm: 0.09, ecn: -0.04 } });
    expect(snapshotFrom({ source: "manual" })).toBeNull();
    expect(snapshotFrom(null)).toBeNull();
  });
  it("reportFrom maps the stored Trade Performance JSON", () => {
    const row = {
      id: 1, account: "31206881", trader_name: "Ориф", period_from: "2026-01-02", period_to: "2026-10-15",
      data: {
        totals: { trades: 910, wins: { count: 463 }, losses: { count: 447 }, totals: { gross: 932.687, fees: 867.6996, net: 64.9874 } },
        perTradeAverages: [{ fees: { comm: 0.5155, ecn: 0.146 } }],
        bySide: { long: { label: "Long Trades", trades: 437, wins: { count: 244 }, losses: { count: 193 }, totals: { gross: 1333.13, fees: 412.4, net: 920.72 } }, short: null },
        byWeekday: [{ label: "Monday", trades: 176, wins: { count: 99 }, losses: { count: 77 }, totals: { gross: 587.5, fees: 149, net: 438.5 } }],
        bySymbol: [{ label: "aaoi", trades: 2, wins: { count: 1 }, losses: { count: 1 }, totals: { gross: -40.1, fees: 0.8, net: -40.9 } }],
      },
    };
    const r = reportFrom(row)!;
    expect(r.trader).toBe("Ориф");
    expect(r.totals).toEqual({ trades: 910, wins: 463, losses: 447, gross: 932.687, fees: 867.6996, net: 64.9874 });
    expect(r.feeAverages).toEqual({ comm: 0.5155, ecn: 0.146 });
    expect(r.bySide.long?.trades).toBe(437);
    expect(r.bySide.short).toBeUndefined();
    expect(Object.keys(r.byWeekday)).toEqual(["monday"]);
    expect(Object.keys(r.bySymbol)).toEqual(["AAOI"]);
    expect(reportFrom({ ...row, data: {} })).toBeNull();
  });
  it("issuesCsv escapes and joins trade ids", () => {
    const csv = issuesCsv([{ id: "i1", severity: "warn", kind: "total_mismatch", date: null, ticker: null, trader: "Ориф", tradeIds: [1, 2], message: 'a, "b"', diff: -0.25 }]);
    const [head, line] = csv.split("\n");
    expect(head.startsWith("severity,kind,cause,date")).toBe(true);
    expect(line).toBe('warn,total_mismatch,,,Ориф,,1 2,,,-0.25,"a, ""b""",');
  });
});
