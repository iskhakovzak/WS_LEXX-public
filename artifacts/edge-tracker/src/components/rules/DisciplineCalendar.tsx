import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { addDays, nyDate } from "@/lib/trading-date";
import { mondayOf } from "./discipline";
import { fmtDate, fmtMonth, fmtUsd, fmtWeekday } from "@/lib/format";
import type { CalendarDay } from "./types";
import { commonI18n } from "@/i18n/ns/common";
import { rulesI18n } from "@/i18n/ns/rules";


/**
 * Discipline heatmap: one cell per trading day (Mon–Fri columns by week).
 * Accent = clean day (deeper with more trades), amber = rules broken (deeper with severity).
 * Up/down colours are reserved for money, so the cell colour is about discipline only.
 */
function cellClass(s: CalendarDay | undefined, future: boolean): string {
  if (future) return "bg-[var(--glass-bg)] opacity-40";
  if (!s || s.trades === 0) return "bg-[var(--glass-bg)] border border-[var(--glass-border)]";
  if (s.clean) return s.trades >= 8 ? "bg-primary/80" : s.trades >= 3 ? "bg-primary/55" : "bg-primary/35";
  if (s.worst === "critical" || s.violations >= 4) return "bg-warn";
  if (s.worst === "high" || s.violations >= 2) return "bg-warn/70";
  return "bg-warn/45";
}

export function describeDay(s: CalendarDay | undefined, date: string): string {
  const d = fmtDate(date, "dayMonth");
  if (!s || s.trades === 0) return rulesI18n.t("calendar.noTrades", { date: d });
  const parts = [commonI18n.t("units.tradesShort", { count: s.trades }), fmtUsd(s.net, { signed: true, decimals: "trim" })];
  parts.push(s.clean ? rulesI18n.t("calendar.clean") : rulesI18n.t("calendar.violations", { count: s.violations }));
  return rulesI18n.t("calendar.dayLine", { date: d, details: parts.join(" · ") });
}

export function DisciplineCalendar({
  calendar,
  from,
  to,
  selected,
  onSelect,
}: {
  calendar: CalendarDay[];
  from: string;
  to: string;
  selected: string | null;
  onSelect: (date: string | null) => void;
}) {
  const { t } = rulesI18n.useT();
  const byDay = useMemo(() => new Map(calendar.map((c) => [c.day, c])), [calendar]);
  const today = nyDate();
  const cols = useMemo(() => {
    const out: string[][] = [];
    const end = to > today ? today : to;
    for (let m = mondayOf(from); m <= end; m = addDays(m, 7)) {
      out.push([0, 1, 2, 3, 4].map((i) => addDays(m, i)));
      if (out.length > 60) break;
    }
    return out;
  }, [from, to, today]);
  const weeks = cols.length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <div className="grid shrink-0 grid-rows-5 gap-[3px] pt-5 text-xs text-muted-foreground" aria-hidden="true">
          {[1, 2, 3, 4, 5].map((i) => {
            const w = fmtWeekday(i, "short");
            return <span key={i} className="flex items-center leading-none">{w.charAt(0).toUpperCase() + w.slice(1)}</span>;
          })}
        </div>
        <div className="min-w-0 flex-1" style={{ maxWidth: weeks * 28 }}>
          <div className="grid gap-[3px] pb-1 text-xs text-muted-foreground" style={{ gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))` }} aria-hidden="true">
            {cols.map((col, i) => {
              const d = new Date(`${col[0]}T12:00:00`);
              const showMonth = i === 0 || d.getDate() <= 7;
              return (
                <span key={col[0]} className="h-4 overflow-visible whitespace-nowrap leading-4">
                  {showMonth && i < weeks - 1 ? fmtMonth(d, "short").replace(".", "") : ""}
                </span>
              );
            })}
          </div>
          <div
            role="grid"
            aria-label={t("calendar.aria")}
            className="grid grid-flow-col grid-rows-5 gap-[3px]"
            style={{ gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))` }}
          >
            {cols.flatMap((col) =>
              col.map((date) => {
                const s = byDay.get(date);
                const outside = date < from || date > today;
                const has = !!s && s.trades > 0;
                const isSel = selected === date;
                const label = describeDay(s, date);
                return (
                  <button
                    key={date}
                    type="button"
                    disabled={outside || !has}
                    title={outside ? undefined : label}
                    aria-label={label}
                    aria-pressed={isSel}
                    onClick={() => onSelect(isSel ? null : date)}
                    className={cn(
                      "aspect-square w-full rounded-[4px] transition-[transform,box-shadow] duration-[var(--dur-1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
                      cellClass(s, outside),
                      has && !outside && "cursor-pointer motion-safe:hover:scale-110",
                      isSel && "ring-2 ring-primary ring-offset-1 ring-offset-background",
                      date === today && !isSel && "ring-1 ring-primary",
                    )}
                  />
                );
              }),
            )}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><span className="h-3 w-3 rounded-[3px] border border-[var(--glass-border)] bg-[var(--glass-bg)]" aria-hidden="true" />{t("calendar.legendNone")}</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-3 w-3 rounded-[3px] bg-primary/55" aria-hidden="true" />{t("calendar.legendClean")}</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-3 w-3 rounded-[3px] bg-warn/70" aria-hidden="true" />{t("calendar.legendBroken")}</span>
      </div>
    </div>
  );
}
