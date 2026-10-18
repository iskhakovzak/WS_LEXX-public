/**
 * Parser for the PropReports "Trade Performance" report (web export XLS/XLSX/CSV).
 *
 * This is an AGGREGATE report — it has no individual trades, so it can never produce journal
 * entries. It is stored as one JSON document per (account, period) and shown as broker statistics.
 *
 * Layout (Sheet1):
 *   row 0  "Per Trade Averages"
 *   row 1  "", Qty, Comm, Ecn Fee, SEC, ORF, CAT, TAF, NFA, NSCC, ExFee, Clr, Misc, Held      ← fee columns vary
 *   row 2  Equities, 64, 0.52, …, 00:20:12                                                   ← one row per asset class
 *   (blank)
 *   3-row header:  [,Wins,…,Losses,…,Totals] / [,,Gross,,All,Net,,Avg,…] / [Description,#,Realized,Avg,Fees,Realized,Avg,Hold,…]
 *   data rows, blocks separated by blank rows:
 *     "Win/Loss Trades"            — grand totals
 *     "Long Trades"/"Short Trades" — by side
 *     "Pre-Market", "09:30-09:50", … "Post-Market" — time-of-day buckets
 *     "Monday" … "Friday"          — weekdays
 *     one row per symbol           — AAOI … ZS
 *   Each data row: label, W#, Wgross, Wavg, Wfees, Wnet, WavgNet, WavgHold, L#, Lgross, Lavg, Lfees, Lnet, LavgNet, LavgHold,
 *                  Tgross, Tfees, Tnet, Bat%, W/L, TavgHold
 *   Negative numbers are "(1,234.56)", percentages "50.88%", holds "HH:MM:SS".
 */
import XLSX from "./xlsx";
import { round2, round4 } from "./csv";
import { feeKeyFor } from "./fees";
import { propreportsT } from "../../i18n/ns";
import type { Lang } from "../../i18n";

export interface PerfSideStats {
  count: number;
  gross: number;
  avgGross: number;
  fees: number;
  net: number;
  avgNet: number;
  avgHoldSeconds: number | null;
  avgHold: string | null;
}

export interface PerfTotals {
  gross: number;
  fees: number;
  net: number;
  /** Batting average (win rate) in percent, e.g. 50.88 */
  winRate: number | null;
  /** Win/Loss ratio (avg win / avg loss) */
  wlRatio: number | null;
  avgHoldSeconds: number | null;
  avgHold: string | null;
}

export interface PerfRow {
  label: string;
  wins: PerfSideStats;
  losses: PerfSideStats;
  totals: PerfTotals;
  trades: number;
}

export interface PerTradeAverage {
  group: string; // "Equities"
  qty: number | null;
  /** keyed by normalised fee key (comm, ecn, sec, orf, cat, taf, nfa, nscc, exfee, clr, misc …) */
  fees: Record<string, number>;
  /** original header → key, so the UI can show the broker's own column names */
  feeHeaders: Record<string, string>;
  heldSeconds: number | null;
  held: string | null;
}

export interface PerformanceReport {
  format: "trade-performance";
  perTradeAverages: PerTradeAverage[];
  totals: PerfRow | null;
  bySide: { long: PerfRow | null; short: PerfRow | null };
  byTime: PerfRow[];
  byWeekday: PerfRow[];
  bySymbol: PerfRow[];
  /** rows that did not fit any known block (kept so nothing is silently dropped) */
  other: PerfRow[];
  summary: {
    trades: number;
    wins: number;
    losses: number;
    winRate: number | null;
    gross: number;
    fees: number;
    net: number;
    feesPctOfGross: number | null;
    wlRatio: number | null;
    avgHoldSeconds: number | null;
    avgHold: string | null;
    symbols: number;
    avgWin: number;
    avgLoss: number;
  };
  issues: string[];
}

export interface PerformanceFileMeta {
  account: string | null;
  periodFrom: string | null;
  periodTo: string | null;
}

/** "31206881-2026-01-02-to-2026-10-15-trade-performance.xls" → account + period. */
export function performanceFileMeta(fileName: string | undefined | null): PerformanceFileMeta {
  const name = (fileName ?? "").split(/[\\/]/).pop() ?? "";
  const m = /^(\d{3,})-(\d{4}-\d{2}-\d{2})-to-(\d{4}-\d{2}-\d{2})/i.exec(name);
  if (m) return { account: m[1], periodFrom: m[2], periodTo: m[3] };
  const acc = /^(\d{3,})\b/.exec(name);
  const dates = name.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  return { account: acc ? acc[1] : null, periodFrom: dates[0] ?? null, periodTo: dates[1] ?? null };
}

const WEEKDAYS = new Set(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);
const TIME_BUCKET = /^(pre-?market|post-?market|after-?hours|\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2})$/i;

function cellStr(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

/** "(1,234.56)" → -1234.56, "50.88%" → 50.88, 12 → 12, "" → null */
export function parsePerfNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = cellStr(v);
  if (!s || s === "-" || s === "—") return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[%$,\s]/g, "");
  if (s.startsWith("-")) { neg = !neg; s = s.slice(1); }
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  return neg ? -n : n;
}

/** "HH:MM:SS" (hours may exceed 24) → seconds; "" → null */
export function parseHold(v: unknown): number | null {
  const s = cellStr(v);
  const m = /^(\d+):(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  return +m[1] * 3600 + +m[2] * 60 + +m[3];
}

function holdStr(v: unknown): string | null {
  const s = cellStr(v);
  return /^\d+:\d{2}:\d{2}$/.test(s) ? s : null;
}

function num0(v: unknown): number {
  return round4(parsePerfNumber(v) ?? 0);
}

/** Percent cell: raw numeric cells hold a fraction (0.5088), formatted strings hold "50.88%". */
function pct(v: unknown): number | null {
  const n = parsePerfNumber(v);
  if (n == null) return null;
  return round2(typeof v === "number" ? n * 100 : n);
}

function isBlank(r: unknown[] | undefined): boolean {
  return !r || !Array.isArray(r) || r.every((c) => cellStr(c) === "");
}

/** Does this sheet look like a Trade Performance report? */
export function isPerformanceReport(rows: unknown[][]): boolean {
  let hasAverages = false;
  let hasWinLoss = false;
  for (const r of rows.slice(0, 40)) {
    if (!Array.isArray(r)) continue;
    const c0 = cellStr(r[0]).toLowerCase();
    if (c0 === "per trade averages") hasAverages = true;
    if (c0 === "win/loss trades") hasWinLoss = true;
    if (c0 === "description" && cellStr(r[1]) === "#") hasWinLoss = true;
  }
  return hasAverages || hasWinLoss;
}

function parseDataRow(r: unknown[]): PerfRow | null {
  const label = cellStr(r[0]);
  if (!label || r.length < 16) return null;
  const wCount = parsePerfNumber(r[1]);
  const lCount = parsePerfNumber(r[8]);
  if (wCount == null || lCount == null) return null;
  const side = (o: number): PerfSideStats => ({
    count: num0(r[o]),
    gross: num0(r[o + 1]),
    avgGross: num0(r[o + 2]),
    fees: num0(r[o + 3]),
    net: num0(r[o + 4]),
    avgNet: num0(r[o + 5]),
    avgHoldSeconds: parseHold(r[o + 6]),
    avgHold: holdStr(r[o + 6]),
  });
  const wins = side(1);
  const losses = side(8);
  const totals: PerfTotals = {
    gross: num0(r[15]),
    fees: num0(r[16]),
    net: num0(r[17]),
    winRate: pct(r[18]),
    wlRatio: parsePerfNumber(r[19]) == null ? null : round4(parsePerfNumber(r[19])!),
    avgHoldSeconds: parseHold(r[20]),
    avgHold: holdStr(r[20]),
  };
  return { label, wins, losses, totals, trades: wins.count + losses.count };
}

export function parsePerformanceRows(rowsIn: unknown[][], lang: Lang = "ru"): PerformanceReport {
  const tr = propreportsT.tFor(lang);
  const rows = rowsIn.map((r) => (Array.isArray(r) ? r : []));
  const issues: string[] = [];
  const perTradeAverages: PerTradeAverage[] = [];
  const report: PerformanceReport = {
    format: "trade-performance",
    perTradeAverages,
    totals: null,
    bySide: { long: null, short: null },
    byTime: [],
    byWeekday: [],
    bySymbol: [],
    other: [],
    summary: { trades: 0, wins: 0, losses: 0, winRate: null, gross: 0, fees: 0, net: 0, feesPctOfGross: null, wlRatio: null, avgHoldSeconds: null, avgHold: null, symbols: 0, avgWin: 0, avgLoss: 0 },
    issues,
  };

  // ── 1. "Per Trade Averages" block ───────────────────────────────────────────
  let i = 0;
  const avgIdx = rows.findIndex((r) => cellStr(r[0]).toLowerCase() === "per trade averages");
  if (avgIdx >= 0) {
    const header = rows[avgIdx + 1] ?? [];
    const cols = header.map((h) => cellStr(h));
    let qtyIdx = -1, heldIdx = -1;
    const feeCols: Array<{ idx: number; key: string; header: string }> = [];
    cols.forEach((h, idx) => {
      const hl = h.toLowerCase();
      if (!h || idx === 0) return;
      if (hl === "qty" || hl === "quantity" || hl === "shares") { qtyIdx = idx; return; }
      if (hl === "held" || hl === "hold" || hl === "avg hold") { heldIdx = idx; return; }
      feeCols.push({ idx, key: feeKeyFor(h)?.key ?? h.toLowerCase().replace(/[^a-z0-9]+/g, "_"), header: h });
    });
    for (i = avgIdx + 2; i < rows.length && !isBlank(rows[i]); i++) {
      const r = rows[i];
      const group = cellStr(r[0]);
      if (!group) continue;
      const fees: Record<string, number> = {};
      const feeHeaders: Record<string, string> = {};
      for (const c of feeCols) {
        fees[c.key] = round4((fees[c.key] ?? 0) + (parsePerfNumber(r[c.idx]) ?? 0));
        feeHeaders[c.header] = c.key;
      }
      perTradeAverages.push({
        group,
        qty: qtyIdx >= 0 && parsePerfNumber(r[qtyIdx]) != null ? round2(parsePerfNumber(r[qtyIdx])!) : null,
        fees,
        feeHeaders,
        heldSeconds: heldIdx >= 0 ? parseHold(r[heldIdx]) : null,
        held: heldIdx >= 0 ? holdStr(r[heldIdx]) : null,
      });
    }
  } else {
    issues.push(tr("perf.noAverages"));
  }

  // ── 2. Data header ("Description", "#") ─────────────────────────────────────
  const descIdx = rows.findIndex((r, k) => k >= i && cellStr(r[0]).toLowerCase() === "description" && cellStr(r[1]) === "#");
  if (descIdx < 0) {
    issues.push(tr("perf.noHeader"));
    return finalize(report, lang);
  }

  // ── 3. Blocks separated by blank rows ───────────────────────────────────────
  const blocks: PerfRow[][] = [];
  let cur: PerfRow[] = [];
  for (let k = descIdx + 1; k < rows.length; k++) {
    const r = rows[k];
    if (isBlank(r)) { if (cur.length) { blocks.push(cur); cur = []; } continue; }
    const row = parseDataRow(r);
    if (!row) { issues.push(tr("perf.rowSkipped", { n: k + 1, text: cellStr(r[0]).slice(0, 40) })); continue; }
    cur.push(row);
  }
  if (cur.length) blocks.push(cur);

  for (let b = 0; b < blocks.length; b++) {
    for (const row of blocks[b]) {
      const l = row.label.toLowerCase();
      if (l === "win/loss trades" || l === "all trades" || l === "total") { report.totals = row; continue; }
      if (l === "long trades" || l === "long") { report.bySide.long = row; continue; }
      if (l === "short trades" || l === "short") { report.bySide.short = row; continue; }
      if (TIME_BUCKET.test(row.label)) { report.byTime.push(row); continue; }
      if (WEEKDAYS.has(l)) { report.byWeekday.push(row); continue; }
      // symbols: upper-case tickers in the trailing block(s)
      if (/^[A-Z0-9.\-/]{1,12}$/.test(row.label) && b >= 1) { report.bySymbol.push(row); continue; }
      report.other.push(row);
    }
  }
  return finalize(report, lang);
}

function finalize(report: PerformanceReport, lang: Lang): PerformanceReport {
  const tr = propreportsT.tFor(lang);
  const t = report.totals;
  if (!t) {
    // derive totals from symbols if the grand-total row is missing
    const src = report.bySymbol.length ? report.bySymbol : report.other;
    if (src.length) {
      const sum = (f: (r: PerfRow) => number) => round2(src.reduce((s, r) => s + f(r), 0));
      const wins = sum((r) => r.wins.count), losses = sum((r) => r.losses.count);
      report.totals = {
        label: "Win/Loss Trades (derived)",
        wins: { count: wins, gross: sum((r) => r.wins.gross), avgGross: 0, fees: sum((r) => r.wins.fees), net: sum((r) => r.wins.net), avgNet: 0, avgHoldSeconds: null, avgHold: null },
        losses: { count: losses, gross: sum((r) => r.losses.gross), avgGross: 0, fees: sum((r) => r.losses.fees), net: sum((r) => r.losses.net), avgNet: 0, avgHoldSeconds: null, avgHold: null },
        totals: { gross: sum((r) => r.totals.gross), fees: sum((r) => r.totals.fees), net: sum((r) => r.totals.net), winRate: wins + losses ? round2((wins / (wins + losses)) * 100) : null, wlRatio: null, avgHoldSeconds: null, avgHold: null },
        trades: wins + losses,
      };
      report.issues.push(tr("perf.noTotal"));
    }
  }
  const tt = report.totals;
  if (tt) {
    report.summary = {
      trades: tt.trades,
      wins: tt.wins.count,
      losses: tt.losses.count,
      winRate: tt.totals.winRate ?? (tt.trades ? round2((tt.wins.count / tt.trades) * 100) : null),
      gross: tt.totals.gross,
      fees: tt.totals.fees,
      net: tt.totals.net,
      feesPctOfGross: tt.totals.gross ? round2((tt.totals.fees / Math.abs(tt.totals.gross)) * 100) : null,
      wlRatio: tt.totals.wlRatio ?? (tt.losses.avgGross ? round2(Math.abs(tt.wins.avgGross / tt.losses.avgGross)) : null),
      avgHoldSeconds: tt.totals.avgHoldSeconds,
      avgHold: tt.totals.avgHold,
      symbols: report.bySymbol.length,
      avgWin: tt.wins.avgGross,
      avgLoss: tt.losses.avgGross,
    };
  } else {
    report.issues.push(tr("perf.empty"));
  }
  return report;
}

/** XLS/XLSX/CSV buffer → sheet rows. Cells are read with `raw: true` so numbers keep full precision. */
export function performanceSheetRows(buf: Buffer): unknown[][] {
  const wb = XLSX.read(buf, { type: "buffer", raw: true, cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null });
}

export function parsePerformanceBuffer(buf: Buffer, lang: Lang = "ru"): PerformanceReport {
  return parsePerformanceRows(performanceSheetRows(buf), lang);
}
