/**
 * Offline check of the parsers + round-trip builder (no DB, no network).
 *   cd artifacts/api-server
 *   npx esbuild src/lib/propreports/__fixtures__/run-fixtures.ts --bundle --platform=node --format=cjs --outfile=<scratch>/run-fixtures.cjs
 *   node <scratch>/run-fixtures.cjs
 * Expected numbers are computed by hand in the EXPECT table below; the script exits 1 on any mismatch.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFillsCsv } from "../parse-fills";
import { buildRoundTrips, summarizeTrips } from "../round-trips";
import { parseTradesReportRows, legacyDedupKey, reportTradesToRoundTrips } from "../parse-trades-report";

// when bundled elsewhere, pass the fixture path as argv[2]
const csv = readFileSync(process.argv[2] ?? join(__dirname, "fills-sample.csv"), "utf8");
const parsed = parseFillsCsv(csv);
console.log(`fills parsed: ${parsed.fills.length}, skipped (CXLD etc): ${parsed.skipped}, issues: ${parsed.issues.length}`);
for (const i of parsed.issues) console.log("  issue", i);

const { trips, orphanFills } = buildRoundTrips(parsed.fills);
console.log(`\nround trips: ${trips.length}, orphan fills: ${orphanFills.length}`);
for (const t of trips) {
  console.log(
    `${t.account.padEnd(6)} ${t.symbol.padEnd(5)} ${t.side.padEnd(5)} ${t.date}${t.exitDate ? "→" + t.exitDate : "          "} ` +
      `${t.horizon.padEnd(9)} ${t.session.padEnd(10)} qty=${String(t.qty).padStart(3)} open=${t.openQty} ` +
      `avgIn=${t.avgEntry} avgOut=${t.avgExit} gross=${t.grossPnl} fees=${t.totalFees} net=${t.netPnl} ${t.result} hold=${t.holdTime} fills=${t.fillCount}`,
  );
  console.log(`       id=${t.externalId}`);
  console.log(`       exec: ${t.executions.map((e) => `${e.kind}:${e.side}${e.qty}@${e.price}(f${e.fees})`).join("  ")}`);
  console.log(`       fees: ${Object.entries(t.fees).filter(([, v]) => v).map(([k, v]) => `${k}=${Math.round(v * 100) / 100}`).join(" ")}`);
}
for (const f of orphanFills) console.log(`orphan: ${f.account} ${f.side}${f.qty} ${f.symbol} @${f.price} ${f.dateTime}`);
console.log("\nsummary:", JSON.stringify(summarizeTrips(trips)));

// ─── hand-computed expectations ───
type Exp = Partial<Record<"side" | "horizon" | "session" | "result" | "exitDate" | "holdTime", string | null>> & Partial<Record<"qty" | "openQty" | "avgEntry" | "avgExit" | "grossPnl" | "totalFees" | "netPnl" | "fillCount", number | null>>;
const EXPECT: Record<string, Exp> = {
  // AAPL scale-in: avgCost 150.25; (151-150.25)*100 + (151.5-150.25)*100 = 75 + 125 = 200; fees 4×(0.5+0.3+0.01+0.02) + 2×(0.02+0.01) = 3.32 + 0.06 = 3.38
  "DEMO1|AAPL|2026-03-02T09:35:12|Long": { side: "Long", horizon: "intraday", session: "regular", qty: 200, openQty: 0, avgEntry: 150.25, avgExit: 151.25, grossPnl: 200, totalFees: 3.38, netPnl: 196.62, result: "win", fillCount: 4, holdTime: "24m" },
  // TSLA short 50 @250 → cover @248: +100; fees 1.00
  "DEMO1|TSLA|2026-03-02T10:15:00|Short": { side: "Short", horizon: "intraday", qty: 50, grossPnl: 100, totalFees: 1, netPnl: 99, result: "win", holdTime: "30m" },
  // NVDA overnight: 200 × 5 = 1000; fees (1+0.6+0.02+0.04) + (1+0.6+0.05+0.02+0.02+0.04) = 1.66 + 1.73 = 3.39
  "DEMO1|NVDA|2026-03-02T15:50:00|Long": { horizon: "overnight", exitDate: "2026-03-03", qty: 200, grossPnl: 1000, totalFees: 3.39, netPnl: 996.61, result: "win", holdTime: "17h 45m" },
  // AMD 3-day swing, premarket entry: 100 × (97-100) = -300; fees 0.83 + 0.85 = 1.68
  "DEMO1|AMD|2026-03-02T08:30:00|Long": { horizon: "swing", session: "premarket", exitDate: "2026-03-05", grossPnl: -300, totalFees: 1.68, netPnl: -301.68, result: "loss", holdTime: "3d 5h" },
  // MSFT still open
  "DEMO1|MSFT|2026-03-05T10:00:00|Long": { result: "open", openQty: 50, qty: 50, avgExit: null, grossPnl: 0, totalFees: 0.42, holdTime: null, exitDate: null },
  // SPY crossing zero: long 100 @500 closed by 100 of the 300 sell @501 → +100, fees 0.83 + (2.58/3=0.86) = 1.69
  "DEMO1|SPY|2026-03-03T10:00:00|Long": { side: "Long", qty: 100, grossPnl: 100, totalFees: 1.69, netPnl: 98.31, result: "win", fillCount: 2 },
  //   then short 200 @501 (fees 2/3 × 2.58 = 1.72) covered @500 (fees 1.66): +200, fees 3.38
  "DEMO1|SPY|2026-03-03T10:30:00|Short": { side: "Short", qty: 200, avgEntry: 501, avgExit: 500, grossPnl: 200, totalFees: 3.38, netPnl: 196.62, result: "win", fillCount: 2 },
  // META partial exits 300 → 3 × 100: (602-600)*100 + (599-600)*100 + (600-600)*100 = 100; fees 2.49 + 3×0.86 = 5.07
  "DEMO2|META|2026-03-04T09:31:00|Long": { qty: 300, avgExit: 600.3333, grossPnl: 100, totalFees: 5.07, netPnl: 94.93, result: "win", fillCount: 4 },
};

let failures = 0;
const byId = new Map(trips.map((t) => [t.externalId, t]));
for (const [id, exp] of Object.entries(EXPECT)) {
  const t = byId.get(id);
  if (!t) { console.error(`MISSING trip ${id}`); failures++; continue; }
  for (const [k, v] of Object.entries(exp)) {
    const got = (t as any)[k];
    const ok = typeof v === "number" ? Math.abs(Number(got) - v) < 0.005 : got === v;
    if (!ok) { console.error(`MISMATCH ${id}.${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(got)}`); failures++; }
  }
}
if (trips.length !== Object.keys(EXPECT).length) { console.error(`expected ${Object.keys(EXPECT).length} trips, got ${trips.length}`); failures++; }
if (orphanFills.length !== 1 || orphanFills[0].symbol !== "XYZ") { console.error("expected exactly one orphan fill (XYZ)"); failures++; }
if (parsed.skipped !== 1) { console.error("expected 1 skipped CXLD row"); failures++; }
const execKinds = byId.get("DEMO2|META|2026-03-04T09:31:00|Long")?.executions.map((e) => e.kind).join(",");
if (execKinds !== "entry,trim,trim,exit") { console.error(`META execution kinds: ${execKinds}`); failures++; }
const aaplKinds = byId.get("DEMO1|AAPL|2026-03-02T09:35:12|Long")?.executions.map((e) => e.kind).join(",");
if (aaplKinds !== "entry,add,trim,exit") { console.error(`AAPL execution kinds: ${aaplKinds}`); failures++; }

// idempotency: same input → same ids and numbers
const again = buildRoundTrips(parseFillsCsv(csv).fills);
if (JSON.stringify(again.trips) !== JSON.stringify(trips)) { console.error("builder is not deterministic"); failures++; }

// ─── Trades report (legacy XLS shape) ───
const reportRows: unknown[][] = [
  ["Equities"],
  ["Opened", "Closed", "Held", "Symbol", "Type", "Entry", "Exit", "Qty", "Gross", "Comm", "Ecn Fee", "SEC", "TAF", "NSCC", "Clr", "Misc", "", "", "", "", "Net"],
  ["03/02/26 09:35:12", "10:00:00", "00:24:48", "AAPL", "Long", "150.25", "151.25", "200", "200.00", "2.00", "1.20", "0.04", "0.02", "0.04", "0.08", "0.00", "", "", "", "", "196.62"],
  ["03/02/26 15:50:00", "03/03/26 09:35:00", "17:45:00", "NVDA", "Long", "500", "505", "200", "1000", "2", "1.2", "0.05", "0.02", "0.04", "0.08", "0", "", "", "", "", "996.61"],
];
const report = parseTradesReportRows(reportRows);
console.log("\nreport trades:", report.length);
for (const r of report) console.log(`  ${r.ticker} ${r.side} ${r.openedAt} net=${r.net} fees=${r.totalFees} dedup=${legacyDedupKey(r)} feesByType=${JSON.stringify(r.fees)}`);
const rt = reportTradesToRoundTrips(report, "DEMO1");
for (const t of rt) console.log(`  → ${t.externalId} ${t.horizon} exitDate=${t.exitDate} gross=${t.grossPnl} fees=${t.totalFees} net=${t.netPnl} hold=${t.holdTime}`);
if (report.length !== 2) { console.error("report rows"); failures++; }
if (legacyDedupKey(report[0]) !== "2026-03-02|AAPL|Long|2026-03-02T09:35:12|150.25|151.25|200") { console.error("legacy dedup key drifted: " + legacyDedupKey(report[0])); failures++; }
if (rt[0].externalId !== "DEMO1|AAPL|2026-03-02T09:35:12|Long") { console.error("report externalId != fills externalId (adoption would break)"); failures++; }
if (rt[1].horizon !== "overnight" || rt[1].exitDate !== "2026-03-03") { console.error("report NVDA horizon"); failures++; }
if (Math.abs(report[0].totalFees - 3.38) > 0.005 || Math.abs((report[0].fees?.comm ?? 0) - 2) > 0.005) { console.error("report fee parsing"); failures++; }

console.log(failures ? `\nFAILED: ${failures} mismatch(es)` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
