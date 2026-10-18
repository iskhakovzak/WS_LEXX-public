/**
 * Календарная тепловая карта индекса дисциплины (0–100 по дням) с прозрачной формулой.
 * Месяцы — колонки по неделям (Пн–Пт), цвет — по штрафам: без штрафов зелёный, чем ниже индекс — краснее.
 * Клик по дню выбирает его для ленты сессии (session-timeline.tsx).
 */
import * as React from "react";
import { Pill } from "@/components/ds";
import { cn } from "@/lib/utils";
import { PATTERN_SHORT, type DisciplineDay, type PatternKey } from "./api";
import { fmtDate, fmtMonth, fmtUsd, fmtWeekday } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { behaviorI18n } from "@/i18n/ns/behavior";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** «Янв» / «Jan» — short month in the UI language. */
const monthShort = (m: number) => cap(fmtMonth(m, "short")).replace(".", "");
/** Mon–Fri heads in the UI language (1 = Monday). */
const weekdayHeads = () => [1, 2, 3, 4, 5].map((d) => cap(fmtWeekday(d, "short")));
const tb = behaviorI18n.t;


function cellBg(score: number): string {
  if (score >= 100) return "hsl(var(--up) / 0.35)";
  if (score >= 90) return "hsl(var(--up) / 0.18)";
  const a = 0.15 + 0.55 * Math.min(1, (100 - score) / 60);
  return `hsl(var(--down) / ${a.toFixed(2)})`;
}

type MonthGrid = { key: string; label: string; weeks: (DisciplineDay | null | undefined)[][] };

/** Разбивка дней на месяцы × недели (столбцы) × будни (строки). undefined = вне месяца, null = нет сделок. */
function buildMonths(days: DisciplineDay[]): MonthGrid[] {
  if (!days.length) return [];
  const byDate = new Map(days.map((d) => [d.date, d]));
  const first = days[0].date, last = days[days.length - 1].date;
  const out: MonthGrid[] = [];
  let y = Number(first.slice(0, 4)), m = Number(first.slice(5, 7)) - 1;
  const endY = Number(last.slice(0, 4)), endM = Number(last.slice(5, 7)) - 1;
  while (y < endY || (y === endY && m <= endM)) {
    const daysIn = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const weeks: (DisciplineDay | null | undefined)[][] = [];
    let week: (DisciplineDay | null | undefined)[] = [undefined, undefined, undefined, undefined, undefined];
    let touched = false;
    for (let d = 1; d <= daysIn; d++) {
      const dow = (new Date(Date.UTC(y, m, d)).getUTCDay() + 6) % 7; // Пн = 0
      if (dow === 0 && touched) { weeks.push(week); week = [undefined, undefined, undefined, undefined, undefined]; touched = false; }
      if (dow > 4) continue;
      const key = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      week[dow] = byDate.get(key) ?? null;
      touched = true;
    }
    if (touched) weeks.push(week);
    out.push({ key: `${y}-${m}`, label: `${monthShort(m)} ${String(y).slice(2)}`, weeks });
    m++;
    if (m > 11) { m = 0; y++; }
  }
  return out;
}

export const DisciplineHeatmap = React.memo(function DisciplineHeatmap({
  days, formula, avg, selected, onSelect,
}: {
  days: DisciplineDay[];
  formula: string;
  avg: number | null;
  selected: string | null;
  onSelect: (date: string) => void;
}) {
  const months = React.useMemo(() => buildMonths(days), [days]);
  const worst = React.useMemo(() => [...days].filter((d) => d.score < 100).sort((a, b) => a.score - b.score || b.date.localeCompare(a.date)).slice(0, 5), [days]);
  const totalTrades = React.useMemo(() => days.reduce((s, d) => s + d.trades, 0), [days]);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Pill tone={avg == null ? "neutral" : avg >= 85 ? "up" : avg >= 65 ? "warn" : "down"} title={tb("heatmap.avgTitle")}>
          {tb("heatmap.avg", { value: avg == null ? "—" : Math.round(avg) })}
        </Pill>
        <span>{tb("heatmap.tradesDays", { trades: commonI18n.t("units.trades", { count: totalTrades }), days: days.length })}</span>
        {worst.length > 0 && (
          <span className="flex flex-wrap items-center gap-1">
            <span>{tb("heatmap.worst")}</span>
            {worst.map((d) => (
              <button
                key={d.date}
                type="button"
                onClick={() => onSelect(d.date)}
                aria-pressed={selected === d.date}
                className={cn("rounded-full px-2 py-0.5 tabular-nums transition-colors duration-[var(--dur-1)] hover:text-foreground", selected === d.date ? "bg-primary/12 text-foreground" : "bg-[var(--glass-bg)]")}
                title={tb("heatmap.worstTitle", { date: fmtDate(d.date, "medium"), score: d.score, net: fmtUsd(d.net, { signed: true, compact: true }) })}
              >
                {fmtDate(d.date, "dayMonthNumeric")} · {d.score}
              </button>
            ))}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1" aria-hidden="true">
          <span className="inline-block h-3 w-3 rounded-sm" style={{ background: cellBg(100) }} /> 100
          <span className="ml-2 inline-block h-3 w-3 rounded-sm" style={{ background: cellBg(80) }} /> 80
          <span className="ml-2 inline-block h-3 w-3 rounded-sm" style={{ background: cellBg(50) }} /> ≤50
        </span>
      </div>

      <div className="flex gap-4 overflow-x-auto pb-1" role="group" aria-label={tb("heatmap.aria")}>
        <div className="sticky left-0 z-raised flex shrink-0 flex-col gap-1 bg-[var(--sticky-bg)] pr-1 pt-5 text-xs text-muted-foreground">
          {weekdayHeads().map((w) => <span key={w} className="h-5 leading-5">{w}</span>)}
        </div>
        {months.map((mo) => (
          <div key={mo.key} className="shrink-0">
            <div className="mb-1 h-4 text-xs text-muted-foreground">{mo.label}</div>
            <div className="flex gap-1">
              {mo.weeks.map((week, wi) => (
                <div key={wi} className="flex flex-col gap-1">
                  {week.map((day, di) => {
                    if (day === undefined) return <span key={di} className="h-5 w-5" aria-hidden="true" />;
                    if (day === null) return <span key={di} className="h-5 w-5 rounded-md bg-muted/30" aria-hidden="true" />;
                    const pen = Object.entries(day.penalties).filter(([, v]) => (v ?? 0) > 0);
                    const title = `${tb("heatmap.dayTitle", { date: fmtDate(day.date, "medium"), score: day.score, trades: commonI18n.t("units.trades", { count: day.trades }), net: fmtUsd(day.net, { signed: true, compact: true }) })}${pen.length ? tb("heatmap.penalties", { list: pen.map(([k, v]) => `${PATTERN_SHORT[k as PatternKey]} −${v}`).join(", ") }) : ""}`;
                    const isSel = selected === day.date;
                    return (
                      <button
                        key={di}
                        type="button"
                        title={title}
                        aria-label={title}
                        aria-pressed={isSel}
                        onClick={() => onSelect(day.date)}
                        className={cn(
                          "h-5 w-5 rounded-md transition-transform duration-[var(--dur-1)] hover:scale-110 motion-reduce:hover:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          isSel && "ring-2 ring-foreground",
                        )}
                        style={{ background: cellBg(day.score) }}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none hover:text-foreground">{tb("heatmap.how")}</summary>

        <p className="mt-1 leading-relaxed">{formula}</p>
      </details>
    </div>
  );
});
