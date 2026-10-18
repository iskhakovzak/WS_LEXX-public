import { fmtDate } from "@/lib/format";

/** "17 окт" / "Oct 17": day + short month without the trailing abbreviation dot (dense dashboard captions). */
export function shortDate(ymd: string): string {
  if (!/^\d{4}-\d{2}-\d{2}/.test(ymd)) return ymd;
  return fmtDate(ymd.slice(0, 10), "dayMonth").replace(".", "");
}
