/**
 * Minimal 5-field cron (minute hour day-of-month month day-of-week), evaluated on New York wall-clock time.
 * Supports `*`, `n`, `a-b`, `* /s` (no space), `a-b/s` and comma lists. Day-of-week 0–7 (0 and 7 = Sunday).
 * Standard semantics: when both day-of-month and day-of-week are restricted, either may match. Pure, no I/O.
 */
export const NY_TZ = "America/New_York";

type Field = { set: Set<number>; any: boolean };
export type CronExpr = { source: string; minute: Field; hour: Field; dom: Field; month: Field; dow: Field };

const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function parseField(src: string, [min, max]: [number, number], label: string): Field {
  const set = new Set<number>();
  const any = src === "*";
  for (const part of src.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`cron: bad ${label} "${part}"`);
    const step = m[4] ? Number(m[4]) : 1;
    let lo = min, hi = max;
    if (m[2] !== undefined) {
      lo = Number(m[2]);
      hi = m[3] !== undefined ? Number(m[3]) : m[4] ? max : lo;
    }
    if (lo < min || hi > max || lo > hi || step < 1) throw new Error(`cron: ${label} out of range "${part}"`);
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return { set, any };
}

export function parseCron(source: string): CronExpr {
  const parts = source.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron: expected 5 fields, got "${source}"`);
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, RANGES[i], ["minute", "hour", "day", "month", "weekday"][i]));
  if (dow.set.has(7)) dow.set.add(0);
  return { source, minute, hour, dom, month, dow };
}

export type NyParts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: NY_TZ, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short", hourCycle: "h23",
});
const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function nyParts(d: Date): NyParts {
  const p: Record<string, string> = {};
  for (const x of partsFmt.formatToParts(d)) p[x.type] = x.value;
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour) % 24, minute: Number(p.minute), weekday: WD[p.weekday] ?? 0 };
}

export function cronMatches(expr: CronExpr, d: Date): boolean {
  const p = nyParts(d);
  if (!expr.minute.set.has(p.minute) || !expr.hour.set.has(p.hour) || !expr.month.set.has(p.month)) return false;
  const domOk = expr.dom.set.has(p.day);
  const dowOk = expr.dow.set.has(p.weekday);
  if (expr.dom.any && expr.dow.any) return true;
  if (expr.dom.any) return dowOk;
  if (expr.dow.any) return domOk;
  return domOk || dowOk;
}

/** Next minute (strictly after `from`) the expression matches, searching up to `maxDays`; null if none. */
export function nextCronRun(expr: CronExpr, from: Date, maxDays = 35): Date | null {
  const t = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);
  const end = from.getTime() + maxDays * 86_400_000;
  while (t.getTime() <= end) {
    if (cronMatches(expr, t)) return new Date(t);
    t.setTime(t.getTime() + 60_000);
  }
  return null;
}
