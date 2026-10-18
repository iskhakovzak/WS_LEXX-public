/**
 * Offline checks for self-configuration: dynamic fee columns (known + unknown), include/exclude via
 * applyFeeSettings, and account matching (exact / alias / case-insensitive / fuzzy). No DB, no network.
 * Run: NODE_ENV=production DATABASE_URL=postgresql://localhost/dummy node <bundle> <fills-fees-sample.csv>
 */
import { readFileSync } from "node:fs";
import { parseFillsCsv } from "../parse-fills";
import { buildRoundTrips } from "../round-trips";
import { applyFeeSettings, type FeeSettings } from "../fees";
import { resolveAccount, normalizeAccountKey, type AccountMapping } from "../sync";

let fails = 0;
const check = (name: string, ok: boolean, got?: unknown) => { if (!ok) { fails++; console.log("FAIL", name, got); } else console.log("ok  ", name); };
const near = (a: number, b: number) => Math.abs(a - b) < 0.005;

const csv = readFileSync(process.argv[2], "utf8");
const parsed = parseFillsCsv(csv);
console.log("fee columns:", parsed.feeColumns);
const keys = parsed.feeColumns.map((c) => c.key);
check("known fee columns detected", ["comm", "ecn", "sec", "taf", "nscc", "clr", "misc"].every((k) => keys.includes(k)), keys);
check("Locate Fee detected (fee-like header)", parsed.feeColumns.some((c) => /locate/i.test(c.header)), keys);
check("Pass Thru detected (unknown numeric column, heuristic)", parsed.feeColumns.some((c) => /pass/i.test(c.header)), keys);
check("Order Id / Status / Trade Date are not fees", !keys.some((k) => /order|status|trade/.test(k)), keys);

const { trips } = buildRoundTrips(parsed.fills);
const aapl = trips.find((t) => t.symbol === "AAPL")!;
const locateKey = parsed.feeColumns.find((c) => /locate/i.test(c.header))!.key;
const passKey = parsed.feeColumns.find((c) => /pass/i.test(c.header))!.key;
// AAPL fees: comm 2 + ecn 1 + sec .03 + taf .02 + nscc .02 + clr .04 + locate .25 + pass .20 = 3.56 ; gross 100
check("AAPL total fees include unknown columns", near(aapl.totalFees, 3.56), aapl.totalFees);
check("AAPL net = gross − all fees", near(aapl.netPnl, 96.44), aapl.netPnl);
check("AAPL fee breakdown has locate + pass keys", near(aapl.fees[locateKey], 0.25) && near(aapl.fees[passKey], 0.2), aapl.fees);

const settings: FeeSettings = { columns: { [locateKey]: { include: false }, [passKey]: { include: false } }, detected: parsed.feeColumns, confirmedAt: null };
const [aapl2] = applyFeeSettings([aapl], settings);
check("exclusion re-sums fees (3.56 → 3.11)", near(aapl2.totalFees, 3.11), aapl2.totalFees);
check("exclusion re-sums net (96.89)", near(aapl2.netPnl, 96.89), aapl2.netPnl);
check("gross untouched", near(aapl2.grossPnl, 100), aapl2.grossPnl);
check("execution fees re-summed", near(aapl2.executions.reduce((s, e) => s + e.fees, 0), 3.11), aapl2.executions.map((e) => e.fees));
check("original trip not mutated", near(aapl.totalFees, 3.56), aapl.totalFees);
const tsla = trips.find((t) => t.symbol === "TSLA")!;
const [tsla2] = applyFeeSettings([tsla], settings);
// TSLA short 200 → cover 199: gross +50; excluding locate (1.00) + pass-thru (0.10) raises net by 1.10
check("TSLA: net rises by excluded fees, result unchanged", tsla.result === "win" && tsla2.result === "win" && near(tsla2.netPnl - tsla.netPnl, 1.1), [tsla.netPnl, tsla2.netPnl]);

// ── account matching ──
const m = (account: string, extra: Partial<AccountMapping> = {}): AccountMapping => ({ id: 1, account, accountId: null, accountName: null, trader: "Закир", active: true, notes: null, aliases: [], lastSyncedAt: null, lastFillAt: null, ...extra });
const mappings = [m("WSL007", { accountId: "31206881", aliases: ["wsl-seven"] }), m("DEMO2", { id: 2, trader: "Ориф" })];
check("exact", resolveAccount("WSL007", mappings)?.how === "exact");
check("exact by accountId", resolveAccount("31206881", mappings)?.how === "exact");
check("alias", resolveAccount("wsl-seven", mappings)?.how === "alias");
check("case-insensitive", resolveAccount("demo2", mappings)?.how === "ci" && resolveAccount("demo2", mappings)?.mapping.trader === "Ориф");
check("fuzzy: wsl-007 → WSL007", resolveAccount("wsl-007", mappings)?.how === "fuzzy", normalizeAccountKey("wsl-007"));
check("fuzzy: acct 0WSL7 → WSL007", resolveAccount("acct 0WSL7", mappings)?.how === "fuzzy", normalizeAccountKey("acct 0WSL7"));
check("fuzzy: WSL007_main → WSL007", resolveAccount("WSL007_main", mappings)?.how === "fuzzy");
check("unknown stays null", resolveAccount("UNKNOWN9", mappings) === null);
check("no false positive on short keys", resolveAccount("W", mappings) === null);
const fillsAccounts = [...new Set(parsed.fills.map((f) => f.account))];
const resolved = fillsAccounts.map((a) => [a, resolveAccount(a, mappings)?.how ?? null]);
check("fixture accounts: wsl-007 fuzzy, demo2 ci, UNKNOWN9 null", JSON.stringify(resolved) === JSON.stringify([["wsl-007", "fuzzy"], ["demo2", "ci"], ["UNKNOWN9", null]]), resolved);

if (fails) { console.log(`${fails} CHECK(S) FAILED`); process.exit(1); }
console.log("ALL SELF-CONFIG CHECKS PASSED");
