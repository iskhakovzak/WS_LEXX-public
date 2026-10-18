import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normHeader, parseCsvRows, parseCsvTable, parseNum, round2, round4 } from "../../propreports/csv";
import { applyFeeSettings, detectFeeColumns, feeKeyFor, orderedFeeKeys, slug, sumFeesWith, type FeeSettings } from "../../propreports/fees";
import { isFillsCsv, normalizeDate, normalizeDateTime, parseFillsCsv } from "../../propreports/parse-fills";
import XLSX from "../../propreports/xlsx";
import { isTradesReport, legacyDedupKey, mergeRawNumbers, parseTradesReportBuffer, parseTradesReportRows, reportTradesToRoundTrips, type TradesReportDiagnostics } from "../../propreports/parse-trades-report";
import { buildRoundTrips } from "../../propreports/round-trips";

const FIXTURES = join(__dirname, "..", "..", "propreports", "__fixtures__");

describe("csv", () => {
  it("parses quotes, escaped quotes, CRLF, BOM and drops empty rows", () => {
    const rows = parseCsvRows('﻿a,b,c\r\n1,"x, y","say ""hi"""\r\n\r\n,,\n2,,3\n');
    expect(rows).toEqual([["a", "b", "c"], ["1", "x, y", 'say "hi"'], ["2", "", "3"]]);
  });
  it("detects and strips the API page trailer", () => {
    const t = parseCsvTable("A,B\n1,2\nPage 2/5\n");
    expect(t.page).toEqual({ current: 2, total: 5 });
    expect(t.rows).toEqual([["1", "2"]]);
    expect(parseCsvTable("A,B\n1,2\n").page).toBeNull();
  });
  it.each<[unknown, number]>([
    ["1,234.5", 1234.5], ["(12.30)", -12.3], ["$ 1,000", 1000], ["", 0], ["-", 0], ["—", 0], [null, 0], [" 7 ", 7], ["-3", -3], [5, 5],
  ])("parseNum(%j) → %d", (v, e) => expect(parseNum(v)).toBe(e));
  it("parseNum returns NaN for garbage (callers must check)", () => {
    expect(Number.isNaN(parseNum("abc"))).toBe(true);
  });
  it("normHeader / round", () => {
    expect(normHeader("  Ecn_Fee  ")).toBe("ecn fee");
    expect(round2(1.005)).toBe(1); // float: 1.005 × 100 = 100.49999
    expect(round2(2.675)).toBe(2.68);
    expect(round4(1.23456)).toBe(1.2346);
  });
});

describe("parse-fills.normalizeDateTime / normalizeDate", () => {
  it.each<[string, string | null]>([
    ["2026-03-02 09:35:12.120", "2026-03-02 09:35:12.120"],
    ["2026-03-02T09:35:12", "2026-03-02 09:35:12"],
    ["2026-03-02 9:35", "2026-03-02 09:35:00"],
    ["2026-03-02 09:35:12.5", "2026-03-02 09:35:12.500"],
    ["2026-03-02 09:35:12.123456", "2026-03-02 09:35:12.123"],
    ["03/02/2026 9:35:12 AM", "2026-03-02 09:35:12"],
    ["03/02/26 1:05 PM", "2026-03-02 13:05:00"],
    ["3/2/26 12:00 AM", "2026-03-02 00:00:00"],
    ["3/2/26 12:30 PM", "2026-03-02 12:30:00"],
    ["03/02/2026 15:45:01", "2026-03-02 15:45:01"],
    ["2026-03-02", "2026-03-02 00:00:00"],
    ["yesterday", null],
    ["", null],
  ])("normalizeDateTime(%j) → %j", (v, e) => expect(normalizeDateTime(v)).toBe(e));

  it.each<[string, string | null]>([
    ["2026-03-02", "2026-03-02"], ["2026-03-02 10:00:00", "2026-03-02"], ["3/2/26", "2026-03-02"], ["03/02/2026", "2026-03-02"], ["", null], ["n/a", null],
  ])("normalizeDate(%j) → %j", (v, e) => expect(normalizeDate(v)).toBe(e));
});

describe("parse-fills.parseFillsCsv", () => {
  const HEAD = "Date/Time,Account,B/S,Qty,Symbol,Price,Route,Comm,Ecn Fee,Trade Date,Order Id,Status";
  const row = (s: string) => `${HEAD}\n${s}\n`;

  it("isFillsCsv needs the five core columns", () => {
    expect(isFillsCsv(HEAD)).toBe(true);
    expect(isFillsCsv("Opened,Closed,Held,Symbol")).toBe(false);
    expect(isFillsCsv("")).toBe(false);
  });

  it("missing core columns ⇒ one issue, nothing parsed", () => {
    const r = parseFillsCsv("Date/Time,Account,Qty,Symbol\n2026-03-02 10:00:00,A,1,X\n");
    expect(r.fills).toEqual([]);
    expect(r.issues.length).toBe(1);
    expect(r.issues[0].message).toMatch(/side, price/);
  });

  it.each<[string, string, string]>([
    ["buy", "BUY", "B"], ["bot", "Bot", "B"], ["sell", "SLD", "S"], ["short", "SS", "T"], ["sell short", "Sell Short", "T"], ["cover", "BC", "C"], ["buy to cover", "buy to cover", "C"],
  ])("side alias %s", (_n, raw, e) => {
    const r = parseFillsCsv(row(`2026-03-02 10:00:00,A,${raw},10,x,5,ARCA,0,0,2026-03-02,1,`));
    expect(r.fills[0]?.side).toBe(e);
  });

  it("rejects bad side, zero qty, negative price, empty symbol — each with a line number", () => {
    const r = parseFillsCsv([
      HEAD,
      "2026-03-02 10:00:00,A,X,10,AAPL,5,ARCA,0,0,2026-03-02,1,",
      "2026-03-02 10:00:00,A,B,0,AAPL,5,ARCA,0,0,2026-03-02,1,",
      "2026-03-02 10:00:00,A,B,10,AAPL,-5,ARCA,0,0,2026-03-02,1,",
      "2026-03-02 10:00:00,A,B,10,,5,ARCA,0,0,2026-03-02,1,",
      "not a date,A,B,10,AAPL,5,ARCA,0,0,2026-03-02,1,",
    ].join("\n"));
    expect(r.fills).toEqual([]);
    expect(r.issues.map((i) => i.line)).toEqual([2, 3, 4, 5, 6]);
  });

  it("symbol upper-cased; trade date falls back to the timestamp; negative qty is rejected (side column carries direction)", () => {
    const r = parseFillsCsv(row("2026-03-02 10:00:00,A,S,25,aapl,5,ARCA,0.1,0.2,,1,"));
    expect(r.fills[0]).toMatchObject({ qty: 25, symbol: "AAPL", tradeDate: "2026-03-02", fees: { comm: 0.1, ecn: 0.2 } });
    const neg = parseFillsCsv(row("2026-03-02 10:00:00,A,S,-25,aapl,5,ARCA,0.1,0.2,,1,"));
    expect(neg.fills).toEqual([]);
    expect(neg.issues).toEqual([{ line: 2, message: expect.stringMatching(/количество/) }]);
  });

  it("4-digit-year trade date is not truncated to 20xx", () => {
    const r = parseFillsCsv(row("03/02/2026 10:00:00,A,B,25,AAPL,5,ARCA,0,0,03/02/2026,1,"));
    expect(r.fills[0]).toMatchObject({ dateTime: "2026-03-02 10:00:00", tradeDate: "2026-03-02" });
  });

  it("skips cancelled / corrected / corporate-action rows", () => {
    const r = parseFillsCsv([HEAD,
      "2026-03-02 10:00:00,A,B,10,AAPL,5,ARCA,0,0,2026-03-02,1,CXLD",
      "2026-03-02 10:00:00,A,B,10,AAPL,5,ARCA,0,0,2026-03-02,1,CORR",
      "2026-03-02 10:00:00,A,B,10,AAPL,5,ARCA,0,0,2026-03-02,1,SPLIT 2:1",
      "2026-03-02 10:00:00,A,B,10,AAPL,5,ARCA,0,0,2026-03-02,1,FILLED",
    ].join("\n"));
    expect(r.skipped).toBe(3);
    expect(r.fills.length).toBe(1);
  });

  it("detects known, unknown-but-fee-looking and heuristic numeric fee columns; identity columns are never fees", () => {
    const r = parseFillsCsv(readFileSync(join(FIXTURES, "fills-fees-sample.csv"), "utf8"));
    expect(r.issues).toEqual([]);
    expect(r.feeColumns.map((c) => [c.key, c.known, c.heuristic])).toEqual([
      ["comm", true, false], ["ecn", true, false], ["sec", true, false], ["taf", true, false], ["nscc", true, false], ["clr", true, false], ["misc", true, false],
      ["locate_fee", false, false], ["pass_thru", false, false],
    ]);
    expect(r.fills[0].fees).toMatchObject({ comm: 1, ecn: 0.5, locate_fee: 0.25, pass_thru: 0.1 });
    const { trips } = buildRoundTrips(r.fills);
    const aapl = trips.find((t) => t.symbol === "AAPL")!;
    expect(aapl.totalFees).toBeCloseTo(1 + 0.5 + 0 + 0 + 0.01 + 0.02 + 0 + 0.25 + 0.1 + 1 + 0.5 + 0.03 + 0.02 + 0.01 + 0.02 + 0 + 0 + 0.1, 2);
  });

  it("heuristic: an unknown all-numeric column counts as a fee, a text column does not", () => {
    const r = parseFillsCsv("Date/Time,B/S,Qty,Symbol,Price,Mystery,Liquidity\n2026-03-02 10:00:00,B,1,A,1,0.5,A\n2026-03-02 10:01:00,S,1,A,1,,R\n");
    expect(r.feeColumns).toEqual([{ key: "mystery", header: "Mystery", known: false, heuristic: true }]);
    expect(r.fills.map((f) => f.fees)).toEqual([{ mystery: 0.5 }, { mystery: 0 }]);
  });
});

describe("fees", () => {
  it.each<[string, { key: string; known: boolean } | null]>([
    ["Comm", { key: "comm", known: true }], ["Commissions", { key: "comm", known: true }], ["Ecn Fee", { key: "ecn", known: true }], ["ECN", { key: "ecn", known: true }],
    ["SEC", { key: "sec", known: true }], ["FINRA TAF", { key: "taf", known: true }], ["Access", { key: "acc", known: true }], ["Clearing", { key: "clr", known: true }],
    ["Nasdaq Fee", { key: "nasdaq_fee", known: false }], ["Locate", { key: "locate", known: false }], ["Short Interest", { key: "short_interest", known: false }],
    ["Price", null], ["Qty", null], ["Account Name", null], ["Status", null], ["Notes", null], [" ", null],
  ])("feeKeyFor(%j) → %j", (h, e) => expect(feeKeyFor(h)).toEqual(e));

  it("slug / orderedFeeKeys", () => {
    expect(slug("Pass-Thru  Fee!")).toBe("pass_thru_fee");
    expect(slug("###")).toBe("col");
    expect(orderedFeeKeys(["zeta", "sec", "comm", "alpha"])).toEqual(["comm", "sec", "alpha", "zeta"]);
  });

  it("duplicate keys get a suffix; mapped columns are skipped", () => {
    const cols = detectFeeColumns(["Date/Time", "Comm", "Commission", "Foo"], [["x", "1", "2", "3"]], new Set([0]));
    expect(cols.map((c) => c.key)).toEqual(["comm", "comm_", "foo"]);
  });

  it("applyFeeSettings re-sums totals, net and result; untouched trips are returned as-is", () => {
    const { trips } = buildRoundTrips(parseFillsCsv(readFileSync(join(FIXTURES, "fills-sample.csv"), "utf8")).fills);
    const settings: FeeSettings = { columns: { comm: { include: false }, ecn: { include: false } }, detected: [], confirmedAt: null };
    const out = applyFeeSettings(trips, settings);
    const tsla = out.find((t) => t.symbol === "TSLA")!; // only comm fees → 0 after exclusion
    expect(tsla.totalFees).toBe(0);
    expect(tsla.netPnl).toBe(100);
    expect(tsla.executions.map((e) => e.fees)).toEqual([0, 0]);
    const aapl = out.find((t) => t.symbol === "AAPL")!;
    expect(aapl.totalFees).toBeCloseTo(3.38 - 4 * 0.8, 2);
    expect(applyFeeSettings(trips, null)).toBe(trips);
    expect(applyFeeSettings(trips, { columns: {}, detected: [], confirmedAt: null })).toBe(trips);
    expect(sumFeesWith({ comm: 1, ecn: 2, sec: 3 }, settings)).toBe(3);
  });

  it("excluding fees can flip a loss into breakeven / win", () => {
    const { trips } = buildRoundTrips([
      { dateTime: "2026-03-02 10:00:00", account: "A", side: "B", qty: 10, symbol: "X", price: 5, route: null, fees: { comm: 1 }, tradeDate: "2026-03-02", orderId: null, fillId: null, propReportsId: null, status: null, line: 1 },
      { dateTime: "2026-03-02 10:01:00", account: "A", side: "S", qty: 10, symbol: "X", price: 5, route: null, fees: { comm: 1 }, tradeDate: "2026-03-02", orderId: null, fillId: null, propReportsId: null, status: null, line: 2 },
    ]);
    expect(trips[0].result).toBe("loss");
    const out = applyFeeSettings(trips, { columns: { comm: { include: false } }, detected: [], confirmedAt: null });
    expect(out[0].result).toBe("breakeven");
    expect(out[0].netPnl).toBe(0);
  });
});

describe("parse-trades-report", () => {
  const HEADER = ["Opened", "Closed", "Held", "Symbol", "Type", "Entry", "Exit", "Qty", "Gross", "Comm", "Ecn Fee", "SEC", "TAF", "NSCC", "Clr", "Misc", "", "", "", "", "Net"];
  const ROWS: unknown[][] = [
    ["Equities"],
    HEADER,
    ["03/02/26 09:35:12", "10:00:00", "00:24:48", "AAPL", "Long", "150.25", "151.25", "200", "200.00", "2.00", "1.20", "0.04", "0.02", "0.04", "0.08", "0.00", "", "", "", "", "196.62"],
    ["03/02/26 15:50:00", "03/03/26 09:35:00", "17:45:00", "NVDA", "Long", "500", "505", "200", "1000", "2", "1.2", "0.05", "0.02", "0.04", "0.08", "0", "", "", "", "", "996.61"],
    ["03/02/26 10:15:00", "10:45:30", "00:30:30", "tsla", "Short", "250", "248", "50", "100", "1", "0", "0", "0", "0", "0", "0", "", "", "", "", "99"],
    ["03/02/26 23:30:00", "01:30:00", "02:00:00", "AMD", "Long", "10", "10", "100", "0", "0", "0", "0", "0", "0", "0", "0", "", "", "", "", "0"],
    ["Totals", "", "", "", "", "", "", "", "1300"],
    ["03/02/26 11:00:00", "11:01:00", "00:01:00", "BAD", "Neither", "1", "1", "1", "0", "0", "0", "0", "0", "0", "0", "0", "", "", "", "", "0"],
  ];

  it("isTradesReport", () => {
    expect(isTradesReport(ROWS)).toBe(true);
    expect(isTradesReport([["Per Trade Averages"]])).toBe(false);
  });

  it("parses rows, fees by type, result, session, hold; skips headers/totals/unknown side", () => {
    const diag: TradesReportDiagnostics = {};
    const out = parseTradesReportRows(ROWS, diag);
    expect(out.map((t) => t.ticker)).toEqual(["AAPL", "NVDA", "TSLA", "AMD"]);
    expect(diag.feeColumns?.length).toBe(7);
    const aapl = out[0];
    expect(aapl).toMatchObject({ openedAt: "2026-03-02T09:35:12", side: "Long", entry: 150.25, exit: 151.25, qty: 200, gross: 200, net: 196.62, totalFees: 3.38, date: "2026-03-02", session: "regular", result: "win", holdTime: "24m" });
    expect(aapl.fees).toEqual({ comm: 2, ecn: 1.2, sec: 0.04, taf: 0.02, nscc: 0.04, clr: 0.08, misc: 0 });
    expect(out[2]).toMatchObject({ side: "Short", result: "win", holdTime: "30m" });
    expect(out[3]).toMatchObject({ result: "be", session: "postmarket", holdTime: "2h 0m" });
    expect(legacyDedupKey(aapl)).toBe("2026-03-02|AAPL|Long|2026-03-02T09:35:12|150.25|151.25|200");
  });

  it("round trips from the report share ids with fill-built trips; horizon from Closed date or Held", () => {
    const rt = reportTradesToRoundTrips(parseTradesReportRows(ROWS), "DEMO1");
    expect(rt[0].externalId).toBe("DEMO1|AAPL|2026-03-02T09:35:12|Long");
    expect(rt[0]).toMatchObject({ horizon: "intraday", exitDate: null, holdSeconds: 24 * 60 + 48, fromReport: true, fillCount: 2, result: "win" });
    expect(rt[1]).toMatchObject({ horizon: "overnight", exitDate: "2026-03-03", holdTime: "17h 45m" });
    // AMD: no date in "Closed", but opened 23:30 + held 2h crosses midnight ⇒ next day
    expect(rt[3]).toMatchObject({ horizon: "overnight", exitDate: "2026-03-03", result: "breakeven" });
    expect(rt[0].executions.map((e) => [e.kind, e.side, e.qty])).toEqual([["entry", "B", 200], ["exit", "S", 200]]);
    expect(rt[2].executions.map((e) => e.side)).toEqual(["T", "C"]);
    expect(rt[0].fees).toEqual({ comm: 2, ecn: 1.2, sec: 0.04, taf: 0.02, nscc: 0.04, clr: 0.08, misc: 0 });
  });

  it("without a header row the fee total still comes from gross − net (parked under misc)", () => {
    const out = parseTradesReportRows([ROWS[2]]);
    expect(out[0].fees).toBeNull();
    expect(out[0].totalFees).toBe(3.38);
    expect(reportTradesToRoundTrips(out, "X")[0].fees).toEqual({ misc: 3.38 });
  });

  it("duplicate rows get #n suffixes", () => {
    const rt = reportTradesToRoundTrips(parseTradesReportRows([HEADER, ROWS[2], ROWS[2]]), "X");
    expect(rt.map((t) => t.externalId)).toEqual(["X|AAPL|2026-03-02T09:35:12|Long", "X|AAPL|2026-03-02T09:35:12|Long#2"]);
  });

  // KNOWN BUG (parse-trades-report.ts, owned by the timing-fix agent): `net` is read from r[20] regardless of
  // where the header puts "Net" — a narrower export yields net 0 / fees = gross. Flip `it.fails` → `it` once fixed.
  it("Net is read from the header position, not a hard-coded column 20", () => {
    const header = ["Opened", "Closed", "Held", "Symbol", "Type", "Entry", "Exit", "Qty", "Gross", "Comm", "Ecn Fee", "Net"];
    const out = parseTradesReportRows([header, ["03/02/26 09:35:12", "10:00:00", "00:24:48", "AAPL", "Long", "10", "11", "100", "100", "1", "0.5", "98.5"]]);
    expect(out[0].net).toBe(98.5);
    expect(out[0].totalFees).toBe(1.5);
    expect(out[0].fees).toEqual({ comm: 1, ecn: 0.5 });
  });

  // KNOWN BUG (parse-trades-report.ts, owned by the timing-fix agent): XLSX.read(csv, { raw: false }) recognises
  // "03/02/26 09:35:12" as a date and re-formats it as "3/2/26" — the time is lost, parseOpened() rejects the row
  // and a CSV trades report imports ZERO trades. Read CSV with raw: true (or parseCsvRows). Flip `it.fails` → `it` once fixed.
  it("CSV buffer goes through the same parser", () => {
    const csv = ROWS.slice(0, 4).map((r) => r.map((c) => `"${c}"`).join(",")).join("\n");
    const out = parseTradesReportBuffer(Buffer.from(csv, "utf8"));
    expect(out.map((t) => t.ticker)).toEqual(["AAPL", "NVDA"]);
    expect(out[1].net).toBe(996.61);
  });

  // Audit P0-1: Ориф's book showed net 64.74 vs the broker's 64.99 — every trade's fees were rounded to cents.
  describe("4-decimal money (audit P0-1)", () => {
    const SUBCENT = ["03/02/26 09:35:12", "10:00:00", "00:24:48", "INTC", "Long", "44.895", "44.73", "20", "-3.3", "0.16", "0.07", "0.0012", "0.0166", "0.0388", "0", "0", "", "", "", "", "-3.5866"];

    it("sub-cent fees survive the parser and the round trip (no cent rounding)", () => {
      const out = parseTradesReportRows([HEADER, SUBCENT]);
      expect(out[0]).toMatchObject({ entry: 44.895, gross: -3.3, net: -3.5866, totalFees: 0.2866, result: "loss" });
      expect(out[0].fees).toEqual({ comm: 0.16, ecn: 0.07, sec: 0.0012, taf: 0.0166, nscc: 0.0388, clr: 0, misc: 0 });
      const rt = reportTradesToRoundTrips(out, "X")[0];
      expect([rt.grossPnl, rt.totalFees, rt.netPnl]).toEqual([-3.3, 0.2866, -3.5866]);
      expect(rt.executions[1].fees).toBe(0.2866);
    });

    it("1000 trades × $0.0025 sub-cent fee: the book total matches the report exactly", () => {
      const row = ["03/02/26 09:35:12", "10:00:00", "00:24:48", "AAPL", "Long", "10", "10.01", "100", "1", "0.0025", "0", "0", "0", "0", "0", "0", "", "", "", "", "0.9975"];
      const out = parseTradesReportRows([HEADER, ...Array.from({ length: 1000 }, () => row)]);
      const rt = reportTradesToRoundTrips(out, "X");
      const net = rt.reduce((a, t) => a + t.netPnl, 0);
      const fees = rt.reduce((a, t) => a + t.totalFees, 0);
      expect(round4(net)).toBe(997.5); // cent rounding gave 1000 × 1.00 = 1000.00
      expect(round4(fees)).toBe(2.5);
    });

    it("prices with 8 decimals (scaled avg) are kept to 4 (trades.entry is NUMERIC(12,4))", () => {
      const row = [...SUBCENT];
      row[5] = "345.05636363";
      expect(parseTradesReportRows([HEADER, row])[0].entry).toBe(345.0564);
    });

    it("mergeRawNumbers: raw numbers replace number-formatted text, dates/times keep formatted text", () => {
      const formatted = [["1/12/2026 9:46:09.000", "09:48:21", "44.90", "0.00", "(3.30)", "WDC"]];
      const raw = [[46034.407, "09:48:21", 44.895, 0.0012, -3.3, "WDC"]];
      expect(mergeRawNumbers(formatted, raw)).toEqual([["1/12/2026 9:46:09.000", "09:48:21", 44.895, 0.0012, -3.3, "WDC"]]);
    });

    it("XLSX buffer with \"0.00\" number formats: fees are read from the cell value, not the 2-dp display", () => {
      const ws = XLSX.utils.aoa_to_sheet([HEADER, SUBCENT.map((c, i) => (i >= 5 && c !== "" ? Number(c) : c))]);
      for (const addr of Object.keys(ws)) {
        const cell = (ws as Record<string, XLSX.CellObject>)[addr];
        if (!addr.startsWith("!") && cell.t === "n") cell.z = "0.00";
      }
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
      const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
      const out = parseTradesReportBuffer(buf);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ entry: 44.895, net: -3.5866, totalFees: 0.2866 });
      expect(out[0].fees?.sec).toBe(0.0012);
    });

    it("applyFeeSettings re-sums at 4 decimals", () => {
      const rt = reportTradesToRoundTrips(parseTradesReportRows([HEADER, SUBCENT]), "X");
      const [t] = applyFeeSettings(rt, { columns: { sec: { include: false } }, detected: [], confirmedAt: null });
      expect(t.totalFees).toBe(0.2854);
      expect(t.netPnl).toBe(-3.5854);
    });
  });
});
