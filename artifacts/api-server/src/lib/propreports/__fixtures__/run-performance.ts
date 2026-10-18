/**
 * Offline check for parse-performance-report.ts.
 * Usage: node <bundle> <path-to-trade-performance.xls>
 */
import { readFileSync } from "node:fs";
import { parsePerformanceBuffer, performanceFileMeta } from "../parse-performance-report";

const path = process.argv[2];
if (!path) { console.error("usage: run-performance <xls>"); process.exit(2); }
const rep = parsePerformanceBuffer(readFileSync(path));
const meta = performanceFileMeta(path);
let fails = 0;
const check = (name: string, ok: boolean, got?: unknown) => { if (!ok) { fails++; console.log("FAIL", name, got); } else console.log("ok  ", name); };
const near = (a: number | null | undefined, b: number, eps = 0.01) => a != null && Math.abs(a - b) <= eps;

check("meta.account", meta.account === "31206881", meta);
check("meta.period", meta.periodFrom === "2026-01-02" && meta.periodTo === "2026-10-15", meta);
check("totals present", !!rep.totals);
check("wins 463", rep.summary.wins === 463, rep.summary.wins);
check("losses 447", rep.summary.losses === 447, rep.summary.losses);
check("gross 932.687", near(rep.summary.gross, 932.687, 0.01), rep.summary.gross);
check("fees 867.6996", near(rep.summary.fees, 867.6996, 0.01), rep.summary.fees);
check("net 64.9874", near(rep.summary.net, 64.9874, 0.01), rep.summary.net);
check("winRate 50.88", near(rep.summary.winRate, 50.88, 0.01), rep.summary.winRate);
check("long+short", !!rep.bySide.long && !!rep.bySide.short && rep.bySide.long!.trades + rep.bySide.short!.trades === 910, rep.bySide);
check("time buckets 9", rep.byTime.length === 9, rep.byTime.map((r) => r.label));
check("weekdays 5", rep.byWeekday.length === 5, rep.byWeekday.map((r) => r.label));
check("symbols >= 200", rep.bySymbol.length >= 200, rep.bySymbol.length);
check("symbol sum trades == 910", rep.bySymbol.reduce((s, r) => s + r.trades, 0) === 910, rep.bySymbol.reduce((s, r) => s + r.trades, 0));
check("symbol sum net ≈ total", near(rep.bySymbol.reduce((s, r) => s + r.totals.net, 0), rep.summary.net, 0.5), rep.bySymbol.reduce((s, r) => s + r.totals.net, 0));
check("other empty", rep.other.length === 0, rep.other.map((r) => r.label));
check("per-trade avg fees", rep.perTradeAverages.length === 1 && rep.perTradeAverages[0].fees.comm != null, rep.perTradeAverages);
check("avg hold 00:20:12", rep.summary.avgHoldSeconds === 20 * 60 + 12, rep.summary.avgHoldSeconds);
console.log("issues:", rep.issues);
console.log(JSON.stringify({ summary: rep.summary, perTrade: rep.perTradeAverages, long: rep.bySide.long?.totals, short: rep.bySide.short?.totals, time: rep.byTime.map((r) => [r.label, r.totals.net]) }, null, 1).slice(0, 3000));
if (fails) { console.log(`${fails} CHECK(S) FAILED`); process.exit(1); }
console.log("ALL PERFORMANCE CHECKS PASSED");
