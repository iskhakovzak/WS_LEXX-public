import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtDate, fmtWeekday } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { feedI18n } from "@/i18n/ns/feed";

/** Monday-first weekday indexes (Date#getDay numbering). */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** Month mini-calendar: dots for days with feed events, ring for today, accent for the selected day. */
export function FeedCalendar({ counts, unreadDays, tradeDays, selected, onSelect, today, anchor }: {
  counts: Map<string, number>;
  unreadDays: Set<string>;
  tradeDays: Set<string>;
  selected: string | null;
  onSelect: (day: string | null) => void;
  today: string;
  /** Day whose month is shown first when nothing is selected (e.g. the latest entry). */
  anchor?: string;
}) {
  const { t } = feedI18n.useT();
  const initial = selected ?? anchor ?? today;
  const [cursor, setCursor] = useState(() => ({ y: Number(initial.slice(0, 4)), m: Number(initial.slice(5, 7)) - 1 }));
  useEffect(() => {
    if (selected) setCursor({ y: Number(selected.slice(0, 4)), m: Number(selected.slice(5, 7)) - 1 });
  }, [selected]);

  const cells = useMemo(() => {
    const first = new Date(cursor.y, cursor.m, 1, 12);
    const lead = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(cursor.y, cursor.m + 1, 0).getDate();
    const out: (string | null)[] = Array(lead).fill(null);
    // Pure calendar cells (YYYY-MM-DD) — no Date→string round-trip through the browser timezone.
    for (let d = 1; d <= daysInMonth; d++) out.push(`${cursor.y}-${String(cursor.m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    while (out.length % 7) out.push(null);
    return out;
  }, [cursor]);

  const monthLabel = fmtDate(new Date(cursor.y, cursor.m, 1), "monthYear");
  const weekdays = WEEK_ORDER.map((i) => { const s = fmtWeekday(i, "short"); return s.charAt(0).toUpperCase() + s.slice(1); });
  const monthPrefix = `${cursor.y}-${String(cursor.m + 1).padStart(2, "0")}`;
  const monthEntries = Array.from(counts.entries()).filter(([d]) => d.startsWith(monthPrefix)).reduce((s, [, n]) => s + n, 0);
  const move = (delta: number) => setCursor((c) => {
    const d = new Date(c.y, c.m + delta, 1);
    return { y: d.getFullYear(), m: d.getMonth() };
  });

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <button type="button" aria-label={t("calendar.prevMonth")} onClick={() => move(-1)} className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="text-center">
          <div className="text-sm font-semibold capitalize text-foreground">{monthLabel}</div>
          <div className="text-xs tabular-nums text-muted-foreground">
            {commonI18n.t("units.events", { count: monthEntries })}
          </div>
        </div>
        <button type="button" aria-label={t("calendar.nextMonth")} onClick={() => move(1)} className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground">
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center" role="grid" aria-label={t("calendar.aria", { month: monthLabel })}>
        {weekdays.map((w) => (
          <div key={w} className="pb-1 text-xs font-medium text-muted-foreground" role="columnheader">{w}</div>
        ))}
        {cells.map((d, i) => {
          if (!d) return <div key={`e${i}`} />;
          const n = counts.get(d) ?? 0;
          const isSel = d === selected;
          const isToday = d === today;
          const label = `${fmtDate(d, "medium")}: ${n ? commonI18n.t("units.events", { count: n }) : t("calendar.empty")}${tradeDays.has(d) ? t("calendar.hadTrades") : ""}`;
          return (
            <button
              key={d}
              type="button"
              role="gridcell"
              aria-label={label}
              aria-selected={isSel}
              onClick={() => onSelect(isSel ? null : d)}
              className={cn(
                "relative flex h-9 flex-col items-center justify-center rounded-lg text-xs tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isSel
                  ? "bg-primary font-semibold text-primary-foreground"
                  : n > 0
                    ? "bg-primary/10 font-semibold text-foreground hover:bg-primary/20"
                    : "text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground",
                isToday && !isSel && "ring-1 ring-primary",
              )}
            >
              {Number(d.slice(8))}
              <span className="absolute bottom-1 flex gap-0.5" aria-hidden="true">
                {n > 0 && <span className={cn("h-1 w-1 rounded-full", isSel ? "bg-primary-foreground" : unreadDays.has(d) ? "bg-primary" : "bg-foreground/50")} />}
                {tradeDays.has(d) && <span className={cn("h-1 w-1 rounded-full", isSel ? "bg-primary-foreground/70" : "bg-up")} />}
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />{t("calendar.legendNew")}</span>
        <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-foreground/50" aria-hidden="true" />{t("calendar.legendEvents")}</span>
        <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-up" aria-hidden="true" />{t("calendar.legendTrading")}</span>
      </div>
    </div>
  );
}
