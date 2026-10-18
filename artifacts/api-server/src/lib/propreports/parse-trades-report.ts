/**
 * Parser for the PropReports "Trades" report (web export XLS/XLSX/CSV, or API `report&type=trades`).
 * Each row is already a closed round trip:
 *
 *   col 0 Opened "MM/DD/YY HH:MM:SS" · 1 Closed · 2 Held "HH:MM:SS" · 3 Symbol · 4 Type Long/Short
 *   5 Entry · 6 Exit · 7 Qty · 8 Gross · 9… fee columns (Comm, Ecn, SEC, TAF, NSCC, Clr, Misc …) · 20 Net
 *
 * Extracted from routes/admin.ts (`POST /admin/import-propreports`) — admin.ts should delegate here.
 * The legacy dedup key (`contextSnapshot.dedupKey`) is kept byte-identical so trades imported by the
 * old admin endpoint are recognised and adopted instead of duplicated.
 */
import XLSX from "./xlsx";
import { parseCsvRows, parseNum, round4 } from "./csv";
import { detectFeeColumns, type DetectedFeeColumn } from "./fees";
import type { FeeBreakdown, RoundTrip, Session } from "./types";
import { holdHuman, horizonFor, sessionFor } from "./round-trips";

export interface ReportTrade {
  openedAt: string; // "YYYY-MM-DDTHH:MM:SS"
  closedTime: string;
  heldRaw: string;
  ticker: string;
  side: "Long" | "Short";
  entry: number;
  exit: number;
  qty: number;
  gross: number;
  totalFees: number;
  net: number;
  date: string;
  session: Session;
  result: "win" | "loss" | "be";
  holdTime: string;
  /** Per-type fees when the header row exposes them (Comm/Ecn/SEC/…); else only the total is known. */
  fees: FeeBreakdown | null;
}

const pad2 = (x: string | number) => String(x).padStart(2, "0");

/**
 * "MM/DD/YY HH:MM:SS", web export "M/D/YYYY H:MM:SS.000", ISO "YYYY-MM-DD HH:MM:SS".
 * Single-digit month/day/hour and fractional seconds are normal in the XLS export.
 */
function parseOpened(cell: string): { date: string; time: string } | null {
  const c = cell.trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(AM|PM)?$/i.exec(c);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    let h = +m[4];
    const ap = m[7]?.toUpperCase();
    if (ap === "PM" && h < 12) h += 12;
    if (ap === "AM" && h === 12) h = 0;
    return { date: `${year}-${pad2(m[1])}-${pad2(m[2])}`, time: `${pad2(h)}:${m[5]}:${m[6] ?? "00"}` };
  }
  m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(c);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${pad2(m[4])}:${m[5]}:${m[6] ?? "00"}` };
  return null;
}

function legacyHoldHuman(raw: string): string {
  const m = /^(\d{2}):(\d{2}):(\d{2})$/.exec(raw.trim());
  if (!m) return raw;
  const h = +m[1], mi = +m[2], s = +m[3];
  if (h > 0) return `${h}h ${mi}m`;
  if (mi > 0) return `${mi}m`;
  return `${s}s`;
}

export function isTradesReport(rows: unknown[][]): boolean {
  return rows.some((r) => Array.isArray(r) && String(r[0] ?? "").trim() === "Opened" && String(r[1] ?? "").trim() === "Closed");
}

export interface TradesReportDiagnostics { feeColumns?: DetectedFeeColumn[] }

const DEFAULT_NET_COL = 20;

export function parseTradesReportRows(rows: unknown[][], diag?: TradesReportDiagnostics): ReportTrade[] {
  const out: ReportTrade[] = [];
  let feeCols: Array<[number, string]> = [];
  let netIdx = DEFAULT_NET_COL;
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 8) continue;
    const c0 = String(r[0] ?? "").trim();
    if (!c0 || c0 === "Equities") continue;
    if (c0 === "Opened" && String(r[1] ?? "") === "Closed") {
      // columns 0–8 are fixed (Opened … Gross), "Net" is wherever the header puts it (the full export has it at
      // column 20, narrower exports earlier); everything fee-like in between is a fee column
      const header = r.map((h) => String(h ?? "").trim());
      const foundNet = header.findIndex((h) => /^net$/i.test(h));
      netIdx = foundNet >= 0 ? foundNet : DEFAULT_NET_COL;
      const fixed = new Set(header.map((_, i) => i).filter((i) => i < 9));
      const sample = rows.filter((x) => Array.isArray(x) && parseOpened(String(x[0] ?? ""))).slice(0, 200).map((x) => x.map((v) => String(v ?? "")));
      const detected = detectFeeColumns(header, sample, fixed);
      if (diag) diag.feeColumns = detected;
      feeCols = detected.map((c): [number, string] => [header.indexOf(c.header), c.key]).filter(([i]) => i !== netIdx);
      continue;
    }
    const opened = parseOpened(c0);
    if (!opened) continue;
    const sideRaw = String(r[4] ?? "").trim();
    if (sideRaw !== "Long" && sideRaw !== "Short") continue;
    const ticker = String(r[3] ?? "").trim().toUpperCase();
    if (!ticker) continue;
    // avg prices of scaled trades carry 8 decimals (345.05636363); trades.entry/exit are NUMERIC(12,4)
    const entry = round4(parseNum(r[5]) || 0);
    const exit = round4(parseNum(r[6]) || 0);
    const qty = parseNum(r[7]) || 0;
    const gross = parseNum(r[8]) || 0;
    const net = parseNum(r[netIdx]) || 0;
    let fees: FeeBreakdown | null = null;
    if (feeCols.length) {
      fees = {};
      for (const [i, k] of feeCols) fees[k] = round4((fees[k] || 0) + (parseNum(r[i]) || 0));
    }
    out.push({
      openedAt: `${opened.date}T${opened.time}`,
      closedTime: String(r[1] ?? "").trim(),
      heldRaw: String(r[2] ?? "").trim(),
      ticker, side: sideRaw, entry, exit, qty,
      // money is kept at 4 decimals (PropReports fees go down to $0.0001); rounding each trade to cents
      // drifted the book by −$0.25 over 910 trades (audit P0-1)
      totalFees: round4(gross - net),
      gross: round4(gross),
      net: round4(net),
      date: opened.date,
      session: sessionFor(opened.time),
      result: round4(net) === 0 ? "be" : net > 0 ? "win" : "loss",
      holdTime: legacyHoldHuman(String(r[2] ?? "").trim()),
      fees,
    });
  }
  return out;
}

/** True for the binary spreadsheet containers: XLS (OLE2 `D0 CF 11 E0`) or XLSX/ZIP (`PK`). Anything else is text (CSV/TSV). */
function isBinarySpreadsheet(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return true;
  return buf[0] === 0x50 && buf[1] === 0x4b;
}

/**
 * XLS/XLSX/CSV buffer → rows. Binary workbooks go through SheetJS with formatted cells (the XLS export stores
 * "Opened" as a date cell, raw:false renders it with its format). CSV text is parsed by our own CSV reader:
 * SheetJS with raw:false recognises "03/02/26 09:35:12" as a date and re-renders it as "3/2/26" — the time is
 * lost and parseOpened() rejects every row (a CSV report imported zero trades).
 */
export function parseTradesReportBuffer(buf: Buffer, diag?: TradesReportDiagnostics): ReportTrade[] {
  if (!isBinarySpreadsheet(buf)) {
    const text = buf.toString("utf8");
    const sep = text.split(/\r?\n/, 5).some((l) => l.includes("\t")) && !text.split(/\r?\n/, 5).some((l) => l.includes(",")) ? "\t" : ",";
    const rows = sep === "\t" ? text.split(/\r?\n/).map((l) => l.split("\t")) : parseCsvRows(text);
    return parseTradesReportRows(rows, diag);
  }
  const wb = XLSX.read(buf, { type: "buffer", raw: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return parseTradesReportRows(mergeRawNumbers(
    XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false }),
    XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true }),
  ), diag);
}

/**
 * Formatted cells (raw:false) are needed for date/time columns, but they render numbers with the sheet's
 * "0.00" format: a $0.0012 fee becomes "0.00" and a 44.895 avg entry "44.90" (audit P0-1: Ориф's book drifted
 * −$0.25 vs the broker). Take the underlying number for every numeric cell whose formatted text is not a
 * date/time (no "/" or ":"), keep the formatted text otherwise.
 */
export function mergeRawNumbers(formatted: unknown[][], raw: unknown[][]): unknown[][] {
  return formatted.map((row, ri) => {
    const rawRow = raw[ri];
    if (!Array.isArray(row) || !Array.isArray(rawRow)) return row;
    return row.map((cell, ci) => {
      const rv = rawRow[ci];
      if (typeof rv !== "number" || !Number.isFinite(rv)) return cell;
      const txt = String(cell ?? "");
      return /[/:]/.test(txt) ? cell : rv;
    });
  });
}

/** Byte-identical to admin.ts `prDedupKey` — used to adopt trades imported by the legacy endpoint. */
export function legacyDedupKey(t: ReportTrade): string {
  return `${t.date}|${t.ticker}|${t.side}|${t.openedAt}|${t.entry}|${t.exit}|${t.qty}`;
}

function heldSeconds(raw: string): number | null {
  const m = /^(\d+):(\d{2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  return +m[1] * 3600 + +m[2] * 60 + +m[3];
}

function closedDate(t: ReportTrade): string | null {
  // "Closed" is usually just a time ("10:15:03") for intraday; multi-day rows carry a date.
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(t.closedTime);
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${pad2(m[1])}-${pad2(m[2])}`;
  const secs = heldSeconds(t.heldRaw);
  if (secs == null) return null;
  const [hh, mm, ss] = t.openedAt.slice(11).split(":").map(Number);
  const endSec = hh * 3600 + mm * 60 + ss + secs;
  if (endSec < 86400) return null;
  const d = new Date(`${t.date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.floor(endSec / 86400));
  return d.toISOString().slice(0, 10);
}

/**
 * Close timestamp (ET wall clock, "YYYY-MM-DDTHH:MM:SS"). Opened + Held is exact to the second and
 * handles multi-day holds; the "Closed" time-of-day cell is the fallback.
 */
export function closedAtOf(t: ReportTrade): string | null {
  const secs = heldSeconds(t.heldRaw);
  if (secs != null) {
    const d = new Date(`${t.openedAt}Z`); // treat the ET wall clock as a plain clock; no zone math needed
    if (!Number.isNaN(d.getTime())) return new Date(d.getTime() + secs * 1000).toISOString().slice(0, 19);
  }
  const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(t.closedTime);
  if (!m) return null;
  return `${closedDate(t) ?? t.date}T${pad2(m[1])}:${m[2]}:${m[3] ?? "00"}`;
}

/** Report rows → RoundTrip shape so the sync engine has a single code path. */
export function reportTradesToRoundTrips(trades: ReportTrade[], account: string): RoundTrip[] {
  const seen = new Map<string, number>();
  return trades.map((t) => {
    const base = `${account}|${t.ticker}|${t.openedAt}|${t.side}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const externalId = n === 1 ? base : `${base}#${n}`;
    const closedAt = closedAtOf(t);
    const exitDate = closedAt ? closedAt.slice(0, 10) : closedDate(t);
    const secs = heldSeconds(t.heldRaw);
    const fees: FeeBreakdown = t.fees ? { ...t.fees } : { misc: t.totalFees }; // only the total known → park it under "misc"
    const executions = [
      { kind: "entry" as const, side: (t.side === "Long" ? "B" : "T") as "B" | "T", qty: t.qty, price: t.entry, at: t.openedAt, fees: 0, feesByType: {}, fillId: null },
      { kind: "exit" as const, side: (t.side === "Long" ? "S" : "C") as "S" | "C", qty: t.qty, price: t.exit, at: closedAt ?? t.openedAt, fees: t.totalFees, feesByType: fees, fillId: null },
    ];
    return {
      externalId,
      account,
      symbol: t.ticker,
      side: t.side,
      openedAt: t.openedAt,
      closedAt,
      date: t.date,
      exitDate: exitDate && exitDate !== t.date ? exitDate : null,
      horizon: horizonFor(t.date, exitDate ?? t.date),
      session: t.session,
      qty: t.qty,
      closedQty: t.qty,
      openQty: 0,
      avgEntry: t.entry,
      avgExit: t.exit,
      grossPnl: round4(t.gross),
      fees,
      totalFees: round4(t.totalFees),
      netPnl: round4(t.net),
      result: round4(t.net) === 0 ? "breakeven" : t.net > 0 ? "win" : "loss",
      holdTime: secs != null ? holdHuman(secs) : t.holdTime || null,
      holdSeconds: secs,
      executions,
      fillCount: 2,
      open: false,
      fromReport: true,
    };
  });
}
