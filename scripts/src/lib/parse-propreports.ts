import * as fs from "node:fs";
import * as XLSX from "xlsx";
import * as cptable from "xlsx/dist/cpexcel.full.mjs";

// SheetJS CE ESM build: readFile needs fs, and codepage tables are opt-in (the old npm CJS build loaded both itself).
XLSX.set_fs(fs);
XLSX.set_cptable(cptable);

export interface PropReportsTrade {
  openedAt: string;
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
  session: "premarket" | "regular" | "postmarket";
  result: "win" | "loss" | "be";
  holdTime: string;
}

const HEADER = ["Opened", "Closed", "Held", "Symbol", "Type", "Entry", "Exit", "Qty"];

function parseNum(v: unknown): number {
  if (v == null) return 0;
  let s = String(v).trim();
  if (!s) return 0;
  const neg = s.startsWith("(") && s.endsWith(")");
  if (neg) s = s.slice(1, -1);
  s = s.replace(/[, ]/g, "");
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return neg ? -n : n;
}

function parseOpenedCell(cell: string): { date: string; time: string } | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}:\d{2}:\d{2})$/.exec(cell.trim());
  if (!m) return null;
  const [, mm, dd, yy, time] = m;
  return { date: `20${yy}-${mm}-${dd}`, time };
}

function holdToHuman(raw: string): string {
  const m = /^(\d{2}):(\d{2}):(\d{2})$/.exec(raw.trim());
  if (!m) return raw;
  const h = +m[1], mi = +m[2], s = +m[3];
  if (h > 0) return `${h}h ${mi}m`;
  if (mi > 0) return `${mi}m`;
  return `${s}s`;
}

function sessionFor(time: string): "premarket" | "regular" | "postmarket" {
  const [hh, mm] = time.split(":").map(Number);
  const minutes = hh * 60 + mm;
  if (minutes < 9 * 60 + 30) return "premarket";
  if (minutes >= 16 * 60) return "postmarket";
  return "regular";
}

export function parsePropReportsFile(filePath: string): PropReportsTrade[] {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false });
  const out: PropReportsTrade[] = [];
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 8) continue;
    const c0 = String(r[0] ?? "").trim();
    if (!c0) continue;
    if (c0 === HEADER[0] && String(r[1] ?? "") === HEADER[1]) continue;
    if (c0 === "Equities") continue;
    const opened = parseOpenedCell(c0);
    if (!opened) continue;
    const sideRaw = String(r[4] ?? "").trim();
    if (sideRaw !== "Long" && sideRaw !== "Short") continue;
    const ticker = String(r[3] ?? "").trim().toUpperCase();
    if (!ticker) continue;
    const entry = parseNum(r[5]);
    const exit = parseNum(r[6]);
    const qty = parseNum(r[7]);
    const gross = parseNum(r[8]);
    const net = parseNum(r[20]);
    const totalFees = +(gross - net).toFixed(2);
    out.push({
      openedAt: `${opened.date}T${opened.time}`,
      closedTime: String(r[1] ?? "").trim(),
      heldRaw: String(r[2] ?? "").trim(),
      ticker,
      side: sideRaw,
      entry,
      exit,
      qty,
      gross,
      totalFees,
      net,
      date: opened.date,
      session: sessionFor(opened.time),
      result: net === 0 ? "be" : net > 0 ? "win" : "loss",
      holdTime: holdToHuman(String(r[2] ?? "").trim()),
    });
  }
  return out;
}
