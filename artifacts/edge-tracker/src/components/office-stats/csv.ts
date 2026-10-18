/**
 * CSV download for «Статистика офиса» tables. «;» separator + BOM so Excel (ru locale) opens it with columns and
 * Cyrillic intact; numbers keep a dot and up to 4 decimals (raw values, not the formatted strings on screen).
 */
function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = typeof v === "number" ? (Number.isFinite(v) ? String(Math.round(v * 10000) / 10000) : "") : String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvText(rows: unknown[][]): string {
  return "﻿" + rows.map((r) => r.map(csvCell).join(";")).join("\r\n");
}

export function downloadCsv(filename: string, rows: unknown[][]): void {
  const blob = new Blob([csvText(rows)], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
