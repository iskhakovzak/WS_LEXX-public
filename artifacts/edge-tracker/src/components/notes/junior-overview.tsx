import * as React from "react";
import { BellRing, Flame, MessageSquareQuote, Star, X } from "lucide-react";
import { StatCard } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  isUnread, lastTradingDays, localToday, moodMeta, nextTradingDay, prevTradingDay, streakOf,
  type JuniorNote, type Reminder,
} from "./junior-lib";
import { fmtDate, fmtNum } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { notesI18n } from "@/i18n/ns/notes";
import { personName } from "@/i18n";

/** Longest run of consecutive trading days with a note. */
function bestStreak(dates: Set<string>): number {
  let best = 0;
  for (const d of dates) {
    if (dates.has(prevTradingDay(d))) continue; // not the start of a run
    let n = 0;
    let cur = d;
    while (dates.has(cur) && n < 400) {
      n++;
      cur = nextTradingDay(cur);
    }
    best = Math.max(best, n);
  }
  return best;
}

/** Personal KPI bento: streak, consistency, curator score, unread answers + 30-day heat strip. */
export function JuniorKpis({
  history,
  isLoading,
  selectedDate,
  onPickDate,
  onShowUnread,
}: {
  history: JuniorNote[];
  isLoading: boolean;
  selectedDate: string;
  onPickDate: (d: string) => void;
  onShowUnread: () => void;
}) {
  const { t } = notesI18n.useT();
  const today = localToday();
  const byDate = React.useMemo(() => new Map(history.filter((n) => n.raw_text?.trim()).map((n) => [n.note_date, n])), [history]);
  const dates = React.useMemo(() => new Set(byDate.keys()), [byDate]);
  const days = React.useMemo(() => lastTradingDays(today, 30), [today]);
  const streak = streakOf(dates, today);
  const best = bestStreak(dates);
  const written30 = days.filter((d) => dates.has(d)).length;
  const scores = history.slice(0, 30).filter((n) => n.curator_score != null).map((n) => n.curator_score!);
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  const unread = history.filter(isUnread).length;
  const todayWritten = dates.has(today);

  if (isLoading && history.length === 0) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[92px] rounded-2xl" />)}
        <Skeleton className="col-span-2 h-16 rounded-2xl lg:col-span-4" />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard
        label={t("junior.kpi.streak")}
        icon={Flame}
        value={commonI18n.t("units.days", { count: streak })}
        tone={streak >= 5 ? "up" : streak > 0 ? "accent" : "neutral"}
        hint={todayWritten || streak === 0 ? t("junior.kpi.record", { count: best }) : t("junior.kpi.keepStreak")}
      />
      <StatCard
        label={t("junior.kpi.last30")}
        value={`${written30} / 30`}
        tone={written30 >= 25 ? "up" : written30 >= 15 ? "neutral" : "warn"}
        hint={t("junior.kpi.discipline", { pct: Math.round((written30 / 30) * 100) })}
      />
      <StatCard
        label={t("junior.kpi.curatorScore")}
        icon={Star}
        value={avg == null ? "—" : fmtNum(avg, 1)}
        tone={avg == null ? "neutral" : avg >= 4 ? "up" : avg >= 3 ? "neutral" : "down"}
        hint={scores.length ? t("junior.kpi.avgOf", { count: scores.length }) : t("junior.kpi.noScores")}
      />
      <StatCard
        label={t("junior.kpi.answers")}
        icon={MessageSquareQuote}
        value={unread ? t("junior.kpi.newCount", { count: unread }) : t("junior.kpi.allRead")}
        tone={unread ? "accent" : "neutral"}
        hint={t("junior.kpi.totalCount", { count: history.filter((n) => n.reviewed_at).length })}
        onClick={unread ? onShowUnread : undefined}
      />

      <div className="glass-panel col-span-2 rounded-2xl p-4 lg:col-span-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{t("junior.kpi.stripHint")}</span>
          <span className="flex items-center gap-3 text-xs text-muted-foreground">
            <Legend className="bg-up/70" label={t("junior.kpi.legendAnswered")} />
            <Legend className="bg-primary/60" label={t("junior.kpi.legendWritten")} />
            <Legend className="bg-[var(--glass-bg)] border border-[var(--field-border)]" label={t("junior.kpi.legendMissed")} />
          </span>
        </div>
        <div className="grid grid-cols-[repeat(15,minmax(0,1fr))] gap-1 sm:grid-cols-[repeat(30,minmax(0,1fr))]" role="list" aria-label={t("junior.kpi.stripAria")}>
          {days.map((d) => {
            const n = byDate.get(d);
            const day = fmtDate(d, "dayMonth");
            const base = !n
              ? t("junior.kpi.dayMissed", { date: day })
              : !n.reviewed_at
                ? t("junior.kpi.dayWritten", { date: day })
                : n.curator_score
                  ? t("junior.kpi.dayAnsweredScore", { date: day, score: n.curator_score })
                  : t("junior.kpi.dayAnswered", { date: day });
            const label = `${base}${n?.mood ? `, ${moodMeta(n.mood)?.label.toLowerCase()}` : ""}`;
            return (
              <button
                key={d}
                type="button"
                role="listitem"
                title={label}
                aria-label={label}
                aria-current={d === selectedDate ? "date" : undefined}
                onClick={() => onPickDate(d)}
                className={cn(
                  "relative h-8 rounded-md transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:hover:scale-100",
                  n ? (n.reviewed_at ? "bg-up/70" : "bg-primary/60") : "border border-[var(--field-border)] bg-[var(--glass-bg)]",
                  d === selectedDate && "ring-2 ring-foreground/70",
                )}
              >
                {n && isUnread(n) && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-primary ring-2 ring-background" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn("h-2.5 w-2.5 rounded-sm", className)} aria-hidden="true" />
      {label}
    </span>
  );
}

/** In-app nudges: curator reminders + unread curator answers. */
export function JuniorBanners({
  reminders,
  unread,
  onWrite,
  onDismiss,
  onOpenUnread,
}: {
  reminders: Reminder[];
  unread: JuniorNote[];
  onWrite: (date: string) => void;
  onDismiss: (id: number) => void;
  onOpenUnread: (date: string) => void;
}) {
  const { t } = notesI18n.useT();
  if (!reminders.length && !unread.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {reminders.map((r) => (
        <div key={r.id} role="status" className="flex flex-wrap items-center gap-3 rounded-2xl bg-[hsl(var(--chart-3)/0.12)] px-4 py-3">
          <BellRing className="h-4 w-4 shrink-0 text-[hsl(var(--chart-3))]" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-sm">
            <span className="font-medium">{personName(r.curator)}</span> {t("junior.banners.reminder", { date: fmtDate(r.note_date, "dayMonth") })}
            {r.message ? ` — «${r.message}»` : ""}
          </p>
          <Button size="sm" onClick={() => onWrite(r.note_date)}>{t("junior.banners.write")}</Button>
          <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={t("junior.banners.hideReminder")} onClick={() => onDismiss(r.id)}>
            <X />
          </Button>
        </div>
      ))}
      {unread.slice(0, 1).map((n) => (
        <button
          key={n.id}
          type="button"
          onClick={() => onOpenUnread(n.note_date)}
          className="lift flex w-full flex-wrap items-center gap-3 rounded-2xl bg-primary/12 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <MessageSquareQuote className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-sm">
            <span className="font-medium">{t("junior.banners.feedback")}</span> {t("junior.banners.feedbackFor", { date: fmtDate(n.note_date, "dayMonth") })}
            {unread.length > 1 ? ` ${t("junior.banners.andMore", { count: unread.length - 1 })}` : ""} — {personName(n.reviewed_by)}
          </span>
          <span className="text-sm font-medium text-primary">{t("junior.banners.read")}</span>
        </button>
      ))}
    </div>
  );
}
