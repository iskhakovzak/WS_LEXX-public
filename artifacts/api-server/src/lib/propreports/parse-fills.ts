/**
 * Parser for the PropReports Fills CSV — identical layout for the `fills` API action and the
 * web "Fills" export (Generic Executions Format):
 *
 *   Date/Time,Account,B/S,Qty,Symbol,Price,Route,Comm,Ecn Fee,SEC,TAF,NSCC,Clr,Misc,Trade Date,Order Id,Status
 *
 * Fee columns vary by firm configuration (ORF, NFA, CAT, Acc/Access may appear; "Ecn" vs "Ecn Fee");
 * the account column is "Account" (display name) in API output and "Account Name" in upload templates.
 * Optional columns (any order): Fill Id, PropReports Id, Liquidity, Currency, Multiplier…
 * Rows with Status CXLD / CORR / REPL (cancels) or corporate actions are skipped for P&L purposes.
 */
import { parseCsvTable, normHeader, parseNum } from "./csv";
import { detectFeeColumns } from "./fees";
import type { FeeBreakdown, Fill, FillSide, FillsParseResult } from "./types";
import { propreportsT } from "../../i18n/ns";
import type { Lang } from "../../i18n";

const COLUMN_ALIASES: Record<string, string[]> = {
  dateTime: ["date/time", "datetime", "date time", "time", "exec time", "execution time"],
  account: ["account", "account name", "acct", "account id"],
  side: ["b/s", "side", "bs", "type"],
  qty: ["qty", "quantity", "shares", "size"],
  symbol: ["symbol", "sym", "ticker"],
  price: ["price", "exec price", "fill price"],
  route: ["route", "exchange", "venue"],
  tradeDate: ["trade date", "tradedate", "session date"],
  orderId: ["order id", "orderid", "ticket"],
  fillId: ["fill id", "fillid", "exec id", "execution id"],
  propReportsId: ["propreports id", "propreportsid", "pr id"],
  status: ["status"],
};
// Fee columns are not aliased here: fees.ts detects them dynamically (known names + heuristic for unknown numeric columns).

function mapColumns(header: string[]): Map<string, number> {
  const idx = new Map<string, number>();
  const normed = header.map(normHeader);
  for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const a of aliases) {
      const i = normed.indexOf(a);
      if (i >= 0 && !idx.has(key)) { idx.set(key, i); break; }
    }
  }
  return idx;
}

/** Normalize the many PropReports timestamp spellings to "YYYY-MM-DD HH:MM:SS[.mmm]" (ET, naive). */
export function normalizeDateTime(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(\.\d{1,6})?/.exec(s);
  if (m) {
    const ms = m[7] ? m[7].slice(0, 4).padEnd(4, "0") : "";
    return `${m[1]}-${m[2]}-${m[3]} ${m[4].padStart(2, "0")}:${m[5]}:${m[6] ?? "00"}${ms}`;
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(\.\d{1,6})?\s*(AM|PM)?$/i.exec(s);
  if (m) {
    let hh = Number(m[4]);
    const ap = m[8]?.toUpperCase();
    if (ap === "PM" && hh < 12) hh += 12;
    if (ap === "AM" && hh === 12) hh = 0;
    const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
    const ms = m[7] ? m[7].slice(0, 4).padEnd(4, "0") : "";
    return `${yyyy}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")} ${String(hh).padStart(2, "0")}:${m[5]}:${m[6] ?? "00"}${ms}`;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${s} 00:00:00`;
  return null;
}

export function normalizeDate(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // 4-digit year must be tried first: "03/02/2026" with (\d{2}|\d{4}) matched "20" and yielded 2020-03-02
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?!\d)/.exec(s);
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}

function parseSide(raw: string): FillSide | null {
  const s = raw.trim().toUpperCase();
  if (s === "B" || s === "BUY" || s === "BOT" || s === "LONG") return "B";
  if (s === "S" || s === "SELL" || s === "SLD") return "S";
  if (s === "T" || s === "SHORT" || s === "SS" || s === "SHRT" || s === "SELL SHORT") return "T";
  if (s === "C" || s === "COVER" || s === "BC" || s === "BUY COVER" || s === "BUY TO COVER") return "C";
  return null;
}

const SKIP_STATUS = new Set(["CXLD", "CORR", "REPL", "ASSIGN", "DELIST", "DIVIDEND", "EXERCISE", "EXPIRE", "JOURNAL", "M/A", "RENAME", "SPINOFF", "SPLIT"]);

export function isFillsCsv(text: string): boolean {
  const { header } = parseCsvTable(text.slice(0, 4000));
  const idx = mapColumns(header);
  return idx.has("dateTime") && idx.has("side") && idx.has("qty") && idx.has("symbol") && idx.has("price");
}

export function parseFillsCsv(text: string, lang: Lang = "ru"): FillsParseResult {
  const tr = propreportsT.tFor(lang);
  const table = parseCsvTable(text);
  const idx = mapColumns(table.header);
  const issues: FillsParseResult["issues"] = [];
  const fills: Fill[] = [];
  let skipped = 0;

  const required = ["dateTime", "side", "qty", "symbol", "price"];
  const missing = required.filter((k) => !idx.has(k));
  if (missing.length) {
    issues.push({ line: 0, message: tr("parse.fillsColumns", { cols: missing.join(", ") }) });
    return { fills, issues, columns: table.header, skipped, feeColumns: [] };
  }
  const feeColumns = detectFeeColumns(table.header, table.rows, new Set(idx.values()));
  const feeIdx = feeColumns.map((c) => [c.key, table.header.indexOf(c.header)] as const);
  const get = (row: string[], key: string): string => {
    const i = idx.get(key);
    return i == null ? "" : (row[i] ?? "").trim();
  };

  table.rows.forEach((row, n) => {
    const line = n + 2; // 1-based incl. header
    const dt = normalizeDateTime(get(row, "dateTime"));
    if (!dt) { issues.push({ line, message: tr("parse.badDate", { value: get(row, "dateTime") }) }); return; }
    const status = get(row, "status").toUpperCase() || null;
    if (status && SKIP_STATUS.has(status.split(" ")[0])) { skipped++; return; }
    const side = parseSide(get(row, "side"));
    if (!side) { issues.push({ line, message: tr("parse.badSide", { value: get(row, "side") }) }); return; }
    const qty = parseNum(get(row, "qty"));
    const price = parseNum(get(row, "price"));
    if (!Number.isFinite(qty) || qty <= 0) { issues.push({ line, message: tr("parse.badQty", { value: get(row, "qty") }) }); return; }
    if (!Number.isFinite(price) || price < 0) { issues.push({ line, message: tr("parse.badPrice", { value: get(row, "price") }) }); return; }
    const symbol = get(row, "symbol").toUpperCase();
    if (!symbol) { issues.push({ line, message: tr("parse.emptySymbol") }); return; }
    const fees: FeeBreakdown = {};
    for (const [k, i] of feeIdx) {
      const v = parseNum((row[i] ?? "").trim());
      fees[k] = Number.isFinite(v) ? v : 0;
    }
    const tradeDate = normalizeDate(get(row, "tradeDate")) ?? dt.slice(0, 10);
    fills.push({
      dateTime: dt,
      account: get(row, "account") || "—",
      side,
      qty: Math.abs(qty),
      symbol,
      price,
      route: get(row, "route") || null,
      fees,
      tradeDate,
      orderId: get(row, "orderId") || null,
      fillId: get(row, "fillId") || null,
      propReportsId: get(row, "propReportsId") || null,
      status,
      line,
    });
  });

  return { fills, issues, columns: table.header, skipped, feeColumns };
}
