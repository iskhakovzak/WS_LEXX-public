// The desk trades US equities: "today" is always the America/New_York calendar date,
// never the server's local or UTC date (they disagree for several hours every night).

const NY_TZ = "America/New_York";

const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: NY_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: NY_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** YYYY-MM-DD in New York for the given instant (default: now). */
export function nyDate(d: Date = new Date()): string {
  return dateFmt.format(d);
}

/** Minutes since New York midnight (e.g. 9:30 → 570). */
export function nyMinutes(d: Date = new Date()): number {
  const [h, m] = timeFmt.format(d).split(":").map(Number);
  return h * 60 + m;
}

/** "premarket" (04:00–09:30), "regular" (09:30–16:00), "postmarket" (16:00–20:00) or "closed", by New York time. */
export function nySession(d: Date = new Date()): "premarket" | "regular" | "postmarket" | "closed" {
  const m = nyMinutes(d);
  if (m >= 240 && m < 570) return "premarket";
  if (m >= 570 && m < 960) return "regular";
  if (m >= 960 && m < 1200) return "postmarket";
  return "closed";
}

/** Shift a YYYY-MM-DD date by whole days (calendar arithmetic, timezone-free). */
export function addDays(date: string, days: number): string {
  const [y, mo, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** Weekend check for a YYYY-MM-DD date (holidays live in the market_holidays table, see routes/holidays.ts). */
export function isWeekend(date: string): boolean {
  const [y, mo, d] = date.split("-").map(Number);
  const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return wd === 0 || wd === 6;
}
