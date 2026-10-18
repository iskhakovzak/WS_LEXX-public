/**
 * Minimal RFC-4180 CSV reader for PropReports exports / API responses.
 * - fields containing commas are double-quoted; "" inside quotes = literal quote
 * - CRLF / LF line endings; a trailing `Page 1/3` pagination trailer is detected and stripped
 */

export interface CsvTable {
  header: string[];
  rows: string[][];
  /** "Page X/Y" trailer when present (API responses). */
  page: { current: number; total: number } | null;
}

export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip BOM
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  // drop fully empty rows
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const PAGE_RE = /^Page\s+(\d+)\s*\/\s*(\d+)\s*$/i;

export function parseCsvTable(text: string): CsvTable {
  const rows = parseCsvRows(text);
  let page: CsvTable["page"] = null;
  if (rows.length) {
    const last = rows[rows.length - 1];
    const m = last.length === 1 ? PAGE_RE.exec(last[0].trim()) : null;
    if (m) { page = { current: Number(m[1]), total: Number(m[2]) }; rows.pop(); }
  }
  const header = rows.length ? rows[0].map((h) => h.trim()) : [];
  return { header, rows: rows.slice(1), page };
}

/** Case/space-insensitive header lookup: "Ecn Fee" ≡ "ecn fee" ≡ "ECN". */
export function normHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[\s_]+/g, " ");
}

/** PropReports numbers: "1,234.5", "(12.30)" → -12.3, "" → 0. */
export function parseNum(v: unknown): number {
  if (v == null) return 0;
  let s = String(v).trim();
  if (!s || s === "-" || s === "—") return 0;
  const neg = s.startsWith("(") && s.endsWith(")");
  if (neg) s = s.slice(1, -1);
  s = s.replace(/[,$\s]/g, "");
  const n = Number(s);
  if (!Number.isFinite(n)) return NaN;
  return neg ? -n : n;
}

export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
export function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
