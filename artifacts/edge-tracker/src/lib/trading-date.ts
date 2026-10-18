// The desk trades US equities: the trading day is the America/New_York calendar date,
// not the browser's local date. Use this for "today", day navigation and API date params.

const NY_TZ = "America/New_York";

const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: NY_TZ, year: "numeric", month: "2-digit", day: "2-digit" });

/** YYYY-MM-DD in New York for the given instant (default: now). */
export function nyDate(d: Date = new Date()): string {
  return dateFmt.format(d);
}

/** Shift a YYYY-MM-DD date by whole days. */
export function addDays(date: string, days: number): string {
  const [y, mo, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d + days)).toISOString().slice(0, 10);
}

/** Previous weekday before `date` (holidays not considered). */
export function prevWeekday(date: string): string {
  let d = addDays(date, -1);
  for (;;) {
    const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) return d;
    d = addDays(d, -1);
  }
}
