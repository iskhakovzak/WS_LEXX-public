import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isPerformanceReport, parseHold, parsePerfNumber, parsePerformanceBuffer, parsePerformanceRows, performanceFileMeta } from "../../propreports/parse-performance-report";

describe("parse-performance-report primitives", () => {
  it.each<[unknown, number | null]>([
    ["(1,234.56)", -1234.56], ["50.88%", 50.88], ["-", null], ["—", null], ["", null], [null, null], [12, 12], [0.5088, 0.5088], ["$ 12.5", 12.5], ["-7", -7], ["(-7)", 7], ["abc", null], [NaN, null], [".5", 0.5],
  ])("parsePerfNumber(%j) → %j", (v, e) => expect(parsePerfNumber(v)).toBe(e));

  it.each<[unknown, number | null]>([["00:20:12", 1212], ["123:00:00", 442800], ["0:00:01", 1], ["", null], ["20:12", null], [null, null]])("parseHold(%j) → %j", (v, e) => expect(parseHold(v)).toBe(e));

  it.each<[string, { account: string | null; periodFrom: string | null; periodTo: string | null }]>([
    ["31206881-2026-01-02-to-2026-10-15-trade-performance.xls", { account: "31206881", periodFrom: "2026-01-02", periodTo: "2026-10-15" }],
    ["C:\\x\\31206881-2026-01-02-to-2026-10-15-trade-performance.xls", { account: "31206881", periodFrom: "2026-01-02", periodTo: "2026-10-15" }],
    ["report 2026-02-01 2026-02-28.xlsx", { account: null, periodFrom: "2026-02-01", periodTo: "2026-02-28" }],
    ["whatever.xls", { account: null, periodFrom: null, periodTo: null }],
    ["", { account: null, periodFrom: null, periodTo: null }],
  ])("performanceFileMeta(%s)", (n, e) => expect(performanceFileMeta(n)).toEqual(e));
});

/** Synthetic sheet in the broker layout (numbers as formatted strings, like raw:false exports). */
const avg = (sum: number, n: number) => (n ? String(sum / n) : "");
const negAvg = (sum: number, n: number) => (n ? `(${Math.abs(sum) / n})` : "");
const dataRow = (label: string, w: [number, number, number, number], l: [number, number, number, number], tot: [number, number, number, string, string | number, string]) =>
  [label, w[0], String(w[1]), avg(w[1], w[0]), String(w[2]), String(w[3]), avg(w[3], w[0]), "00:10:00",
    l[0], `(${Math.abs(l[1])})`, negAvg(l[1], l[0]), String(l[2]), `(${Math.abs(l[3])})`, negAvg(l[3], l[0]), "00:05:00",
    String(tot[0]), String(tot[1]), String(tot[2]), tot[3], tot[4], tot[5]];

const SHEET: unknown[][] = [
  ["Per Trade Averages"],
  ["", "Qty", "Comm", "Ecn Fee", "SEC", "Held"],
  ["Equities", "64", "0.52", "0.11", "0.01", "00:20:12"],
  [],
  ["", "Wins", "", "", "", "", "", "", "Losses", "", "", "", "", "", "", "Totals"],
  ["", "", "Gross", "", "All", "Net", "", "Avg", "", "Gross", "", "All", "Net", "", "Avg"],
  ["Description", "#", "Realized", "Avg", "Fees", "Realized", "Avg", "Hold", "#", "Realized", "Avg", "Fees", "Realized", "Avg", "Hold", "Gross", "Fees", "Net", "Bat%", "W/L", "Hold"],
  dataRow("Win/Loss Trades", [6, 600, 30, 570], [4, 200, 20, 220], [400, 50, 350, "60.00%", "2.00", "00:08:00"]),
  [],
  dataRow("Long Trades", [4, 400, 20, 380], [2, 100, 10, 110], [300, 30, 270, "66.67%", "2.00", "00:08:00"]),
  dataRow("Short Trades", [2, 200, 10, 190], [2, 100, 10, 110], [100, 20, 80, "50.00%", "2.00", "00:08:00"]),
  [],
  dataRow("Pre-Market", [1, 100, 5, 95], [0, 0, 0, 0], [100, 5, 95, "100.00%", "", "00:08:00"]),
  dataRow("09:30-09:50", [5, 500, 25, 475], [4, 200, 20, 220], [300, 45, 255, "55.56%", "2.00", "00:08:00"]),
  [],
  dataRow("Monday", [6, 600, 30, 570], [4, 200, 20, 220], [400, 50, 350, "60.00%", "2.00", "00:08:00"]),
  [],
  dataRow("AAPL", [4, 400, 20, 380], [1, 50, 5, 55], [350, 25, 325, "80.00%", "", "00:08:00"]),
  dataRow("BRK.B", [2, 200, 10, 190], [3, 150, 15, 165], [50, 25, 25, "40.00%", "", "00:08:00"]),
  ["junk row", "x"],
];

describe("parsePerformanceRows (synthetic)", () => {
  it("isPerformanceReport", () => {
    expect(isPerformanceReport(SHEET)).toBe(true);
    expect(isPerformanceReport([["Opened", "Closed"]])).toBe(false);
  });

  it("classifies blocks, parses negatives / percents / holds, builds the summary", () => {
    const rep = parsePerformanceRows(SHEET);
    expect(rep.perTradeAverages).toEqual([{ group: "Equities", qty: 64, fees: { comm: 0.52, ecn: 0.11, sec: 0.01 }, feeHeaders: { Comm: "comm", "Ecn Fee": "ecn", SEC: "sec" }, heldSeconds: 1212, held: "00:20:12" }]);
    expect(rep.totals?.label).toBe("Win/Loss Trades");
    expect(rep.totals?.losses).toMatchObject({ count: 4, gross: -200, fees: 20, net: -220, avgHoldSeconds: 300 });
    expect(rep.bySide.long?.trades).toBe(6);
    expect(rep.bySide.short?.trades).toBe(4);
    expect(rep.byTime.map((r) => r.label)).toEqual(["Pre-Market", "09:30-09:50"]);
    expect(rep.byWeekday.map((r) => r.label)).toEqual(["Monday"]);
    expect(rep.bySymbol.map((r) => r.label)).toEqual(["AAPL", "BRK.B"]);
    expect(rep.other).toEqual([]);
    expect(rep.issues).toEqual([expect.stringMatching(/junk row/)]);
    expect(rep.summary).toEqual({
      trades: 10, wins: 6, losses: 4, winRate: 60, gross: 400, fees: 50, net: 350, feesPctOfGross: 12.5, wlRatio: 2,
      avgHoldSeconds: 480, avgHold: "00:08:00", symbols: 2, avgWin: 100, avgLoss: -50,
    });
    expect(rep.totals?.wins).toMatchObject({ count: 6, gross: 600, avgGross: 100, fees: 30, net: 570, avgNet: 95, avgHoldSeconds: 600 });
  });

  it("W/L ratio falls back to |avgWin / avgLoss| when the column is empty", () => {
    const rows = SHEET.map((r) => [...r]);
    rows[7] = [...rows[7]];
    rows[7][19] = "";
    expect(parsePerformanceRows(rows).summary.wlRatio).toBe(2);
  });

  it("raw numeric percent cells (0.6) are fractions; string ones are percents", () => {
    const rows = SHEET.map((r) => [...r]);
    rows[7] = [...rows[7]];
    rows[7][18] = 0.6;
    expect(parsePerformanceRows(rows).summary.winRate).toBe(60);
  });

  it("missing grand total: derived from symbols with an issue; missing header: issue, empty report", () => {
    const noTotal = SHEET.filter((r) => r[0] !== "Win/Loss Trades");
    const rep = parsePerformanceRows(noTotal);
    expect(rep.totals?.label).toBe("Win/Loss Trades (derived)");
    expect(rep.summary).toMatchObject({ trades: 10, wins: 6, losses: 4, winRate: 60, gross: 400, fees: 50, net: 350 });
    expect(rep.issues).toContainEqual(expect.stringMatching(/вычислены по тикерам/));

    const noHeader = parsePerformanceRows(SHEET.slice(0, 3));
    expect(noHeader.totals).toBeNull();
    expect(noHeader.issues).toEqual([expect.stringMatching(/Заголовок/), expect.stringMatching(/ни одной строки/)]);
    expect(noHeader.summary.trades).toBe(0);

    expect(parsePerformanceRows([]).issues.length).toBeGreaterThan(0);
  });

  it("symbols are only taken from the second block onwards (a ticker-looking label in block 0 is 'other')", () => {
    const rows = [SHEET[6], dataRow("AAPL", [1, 10, 10, 9], [0, 0, 0, 0], [10, 1, 9, "100%", "", "00:01:00"])];
    const rep = parsePerformanceRows(rows);
    expect(rep.bySymbol).toEqual([]);
    expect(rep.other.map((r) => r.label)).toEqual(["AAPL"]);
  });
});

// Real broker export (client data, never copied into the repo): referenced by path, skipped when absent.
const REAL_XLS = process.env.PROPREPORTS_PERF_XLS
  ?? "C:/Users/WS/AppData/Local/Temp/claude/C--Users-WS-Desktop-lexx-Web-Builder/45949afd-c136-4c28-a8ea-e3e35d0b241c/scratchpad/pr_import/31206881-2026-01-02-to-2026-10-15-trade-performance.xls";

describe.skipIf(!existsSync(REAL_XLS))("parsePerformanceBuffer (real trade-performance.xls)", () => {
  it("matches the broker's own totals", () => {
    const rep = parsePerformanceBuffer(readFileSync(REAL_XLS));
    const meta = performanceFileMeta(REAL_XLS);
    expect(meta).toEqual({ account: "31206881", periodFrom: "2026-01-02", periodTo: "2026-10-15" });
    expect(rep.summary.wins).toBe(463);
    expect(rep.summary.losses).toBe(447);
    expect(rep.summary.gross).toBeCloseTo(932.687, 2);
    expect(rep.summary.fees).toBeCloseTo(867.6996, 2);
    expect(rep.summary.net).toBeCloseTo(64.9874, 2);
    expect(rep.summary.winRate).toBeCloseTo(50.88, 2);
    expect(rep.summary.avgHoldSeconds).toBe(20 * 60 + 12);
    expect(rep.bySide.long!.trades + rep.bySide.short!.trades).toBe(910);
    expect(rep.byTime.length).toBe(9);
    expect(rep.byWeekday.length).toBe(5);
    expect(rep.bySymbol.length).toBeGreaterThanOrEqual(200);
    expect(rep.bySymbol.reduce((s, r) => s + r.trades, 0)).toBe(910);
    expect(rep.bySymbol.reduce((s, r) => s + r.totals.net, 0)).toBeCloseTo(rep.summary.net, 0);
    expect(rep.other).toEqual([]);
    expect(rep.perTradeAverages[0].fees.comm).toBeDefined();
  });
});
