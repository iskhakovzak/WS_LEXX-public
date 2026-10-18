/**
 * «Свежие» нарушения правил — окно по торговому дню нарушения, а не по времени вставки.
 *
 * rule_violations.occurred_at — момент записи строки (DEFAULT NOW()). Пересканирование / бэкфилл истории вставляет
 * тысячи старых нарушений «сейчас», и фильтр `occurred_at >= NOW() - 24h` показывал «2545 нарушений за сутки».
 * Торговый день нарушения хранится в `day` (YYYY-MM-DD, NY); для старых строк без него — NY-дата occurred_at.
 *
 * «За сутки» = последний закрытый торговый день + сегодня: [предыдущий будний день, сегодня].
 */
import { addDays, isWeekend } from "./tradingDate";

/** SQL-выражение торгового дня нарушения (TEXT YYYY-MM-DD). `alias` — алиас таблицы rule_violations ("" — без алиаса). */
export function violationDaySql(alias = "v"): string {
  const p = alias ? `${alias}.` : "";
  return `COALESCE(NULLIF(${p}day, ''), TO_CHAR(${p}occurred_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD'))`;
}

function prevWeekday(date: string): string {
  let d = addDays(date, -1);
  for (let i = 0; i < 7 && isWeekend(d); i++) d = addDays(d, -1);
  return d;
}

/** Окно «за сутки» для торговых дней: [предыдущий будний день, today] включительно. */
export function recentViolationWindow(today: string): { from: string; to: string } {
  return { from: prevWeekday(today), to: today };
}

/** Торговый день нарушения (зеркало violationDaySql для тестов и JS-кода). */
export function violationTradingDay(v: { day?: string | null; occurredAt: string | Date }, nyDateOf: (d: Date) => string): string {
  if (v.day && /^\d{4}-\d{2}-\d{2}$/.test(v.day)) return v.day;
  return nyDateOf(v.occurredAt instanceof Date ? v.occurredAt : new Date(v.occurredAt));
}

/** Сколько нарушений попадает в окно «за сутки» (по торговому дню). */
export function countRecentViolations(
  rows: ReadonlyArray<{ day?: string | null; occurredAt: string | Date }>,
  today: string,
  nyDateOf: (d: Date) => string,
): number {
  const w = recentViolationWindow(today);
  return rows.filter((r) => {
    const d = violationTradingDay(r, nyDateOf);
    return d >= w.from && d <= w.to;
  }).length;
}
