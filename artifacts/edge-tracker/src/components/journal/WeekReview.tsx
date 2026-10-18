import { useMemo } from "react";
import { Link } from "wouter";
import { ArrowUpRight, CalendarRange, CheckCheck } from "lucide-react";
import { Panel, toneOf, toneText } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { type JournalEntry } from "./use-journal-days";
import type { ReviewMark } from "./MonthCalendar";
import { type DayStats, addDays, dayValue, fmtUnit, parseDate, pickUnit, weekdaysShortMonFirst } from "./utils";
import { fmtDate, fmtRate } from "@/lib/format";
import { journalI18n } from "@/i18n/ns/journal";
import { commonI18n } from "@/i18n/ns/common";

/**
 * Compact week strip inside the journal: Mon–Fri bars with review marks, the week's net / win rate / green-red days,
 * how many days are reviewed, and up to three lessons. The full weekly analysis lives on /weekly-review (link).
 */
export function WeekReview({
  weekStartDate,
  activeDate,
  today,
  statsByDate,
  entriesByDate,
  marks,
  onSelect,
  showJournal,
  weeklyHref,
}: {
  weekStartDate: string;
  activeDate: string;
  today: string;
  statsByDate: Map<string, DayStats>;
  entriesByDate: Map<string, JournalEntry[]>;
  marks: Map<string, ReviewMark>;
  onSelect: (d: string) => void;
  showJournal: boolean;
  /** Link to the full weekly review for this week. */
  weeklyHref?: string;
}) {
  const days = useMemo(() => Array.from({ length: 5 }, (_, i) => addDays(weekStartDate, i)), [weekStartDate]);

  const unit = useMemo(
    () => pickUnit(days.map((d) => statsByDate.get(d)).filter((s): s is DayStats => !!s)),
    [days, statsByDate],
  );

  const agg = useMemo(() => {
    let trades = 0, wins = 0, losses = 0, green = 0, red = 0, traded = 0, reviewed = 0;
    let total: number | null = null;
    for (const d of days) {
      const s = statsByDate.get(d);
      if (!s || s.trades === 0) continue;
      traded++;
      trades += s.trades; wins += s.wins; losses += s.losses;
      const v = dayValue(s, unit);
      if (v != null) { total = (total ?? 0) + v; if (v > 0) green++; else if (v < 0) red++; }
      const m = marks.get(d);
      if (m && m !== "missing") reviewed++;
    }
    const lessons: Array<{ d: string; text: string; who: string }> = [];
    for (const d of days) {
      for (const e of entriesByDate.get(d) ?? []) if (e.lessons.trim()) lessons.push({ d, text: e.lessons.trim(), who: e.trader });
    }
    return { trades, wins, losses, green, red, traded, reviewed, total, lessons };
  }, [days, statsByDate, entriesByDate, marks, unit]);

  const barMax = useMemo(() => {
    let m = 0;
    for (const d of days) {
      const v = dayValue(statsByDate.get(d), unit);
      if (v != null) m = Math.max(m, Math.abs(v));
    }
    return m;
  }, [days, statsByDate, unit]);

  const decided = agg.wins + agg.losses;
  const { t } = journalI18n.useT();
  const { t: tc } = commonI18n.useT();

  return (
    <Panel
      title={t("week.title")}
      icon={CalendarRange}
      description={`${fmtDate(days[0], "dayMonth")} — ${fmtDate(days[4], "dayMonth")}`}
      actions={
        weeklyHref ? (
          <Button asChild variant="ghost" size="sm">
            <Link href={weeklyHref}>{t("week.weeklyReview")}<ArrowUpRight aria-hidden="true" /></Link>
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
          <Cell label={t("week.total")} value={agg.total != null ? fmtUnit(agg.total, unit) : "—"} tone={toneText(toneOf(agg.total))} />
          <Cell label={tc("trading.winRate")} value={decided ? fmtRate(agg.wins / decided) : "—"} hint={agg.trades ? t("calendar.tradesShort", { count: agg.trades }) : undefined} />
          <Cell
            label={t("week.days")}
            value={agg.traded ? <><span className="text-up">{agg.green}</span> / <span className="text-down">{agg.red}</span></> : "—"}
          />
          {showJournal && <Cell label={t("week.reviews")} value={agg.traded ? `${agg.reviewed}/${agg.traded}` : "—"} tone={agg.traded && agg.reviewed >= agg.traded ? "text-up" : undefined} />}
        </dl>

        <div className="grid grid-cols-5 gap-1.5" role="group" aria-label={t("week.byDayAria")}>
          {days.map((d, i) => {
            const s = statsByDate.get(d);
            const v = dayValue(s, unit);
            const h = v != null && barMax > 0 ? Math.max(6, (Math.abs(v) / barMax) * 100) : 0;
            const isActive = d === activeDate;
            const mark = s && s.trades > 0 ? marks.get(d) ?? "missing" : null;
            return (
              <button
                key={d}
                type="button"
                onClick={() => onSelect(d)}
                aria-pressed={isActive}
                aria-label={s ? t("week.dayAria", { date: fmtDate(d, "dayMonth"), trades: t("calendar.dayTrades", { count: s.trades }), value: fmtUnit(v, unit, 2) }) : t("week.dayAriaEmpty", { date: fmtDate(d, "dayMonth") })}
                className={cn(
                  "flex flex-col items-center gap-1 rounded-xl p-1.5 transition-colors hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isActive && "bg-[var(--glass-hover-bg)] ring-1 ring-primary",
                )}
              >
                <span className={cn("text-2xs font-semibold tabular-nums", v == null ? "text-muted-foreground" : v > 0 ? "text-up" : v < 0 ? "text-down" : "")}>
                  {v == null ? "—" : fmtUnit(v, unit)}
                </span>
                <span className="relative flex h-12 w-full items-end justify-center" aria-hidden="true">
                  <span
                    className={cn("w-3/5 max-w-6 rounded-md", v == null ? "bg-muted/50" : v >= 0 ? "bg-up/70" : "bg-down/70")}
                    style={{ height: v == null ? 3 : `${h}%` }}
                  />
                </span>
                <span className={cn("flex items-center gap-1 text-2xs", d === today ? "font-semibold text-primary" : "text-muted-foreground")}>
                  {weekdaysShortMonFirst()[i]} {parseDate(d).getDate()}
                  {showJournal && mark === "reviewed" && <CheckCheck className="h-3 w-3 text-up" aria-label={t("week.reviewed")} />}
                </span>
                {showJournal && mark && mark !== "reviewed" && (
                  <span
                    className={cn("h-1 w-4 rounded-full", mark === "missing" ? "bg-warn/50" : "bg-primary")}
                    aria-hidden="true"
                    title={mark === "missing" ? t("week.noReview") : t("week.reviewFilled")}
                  />
                )}
              </button>
            );
          })}
        </div>

        {showJournal && agg.lessons.length > 0 && (
          <div className="space-y-1.5 border-t border-[var(--glass-border)] pt-3">
            <div className="micro-label">{t("week.lessons")}</div>
            <ul className="space-y-1">
              {agg.lessons.slice(0, 3).map((l) => (
                <li key={`${l.who}-${l.d}`}>
                  <button
                    type="button"
                    onClick={() => onSelect(l.d)}
                    className="w-full rounded-lg px-2 py-1 text-left text-xs transition-colors hover:bg-[var(--glass-hover-bg)]"
                  >
                    <span className="mr-2 tabular-nums text-muted-foreground">{fmtDate(l.d, "dayMonth")}</span>
                    <span className="line-clamp-2 inline text-foreground/90">{l.text}</span>
                  </button>
                </li>
              ))}
            </ul>
            {agg.lessons.length > 3 && <p className="px-2 text-2xs text-muted-foreground">{t("week.moreLessons", { count: agg.lessons.length - 3 })}</p>}
          </div>
        )}
      </div>
    </Panel>
  );
}

function Cell({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs text-muted-foreground">{label}</dt>
      <dd className={cn("truncate text-base font-semibold tabular-nums", tone)}>{value}</dd>
      {hint && <dd className="text-2xs text-muted-foreground">{hint}</dd>}
    </div>
  );
}
