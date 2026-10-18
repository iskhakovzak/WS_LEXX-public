/**
 * «Топ дня» — month calendar: desk net per day as a green / red tint (strength against the month's largest day),
 * weekends and market holidays muted, today ringed, the chosen day solid; a dot marks the days the viewer traded.
 * In the named mode (names on, traders) desk $ is not sent — cells show the trader count only.
 */
import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Panel, toneOf, toneText } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { fmtCompact, fmtDate, fmtMonth, fmtUsd, fmtWeekday } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { topDayI18n } from "@/i18n/ns/topDay";
import type { CalendarDay, TopCalendar as Calendar } from "./api";
import { heatLevel, isWeekend, maxAbsNet, monthGrid } from "./model";

const HEAT_UP = ["", "bg-up/10", "bg-up/20", "bg-up/30"] as const;
const HEAT_DOWN = ["", "bg-down/10", "bg-down/20", "bg-down/30"] as const;
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];

export function TopCalendar({
  month,
  data,
  loading,
  selected,
  today,
  canNext,
  onSelect,
  onMonth,
}: {
  month: string;
  data: Calendar | undefined;
  loading: boolean;
  selected: string | null;
  today: string;
  canNext: boolean;
  onSelect: (date: string) => void;
  onMonth: (delta: number) => void;
}) {
  const { t } = topDayI18n.useT();
  const byDate = React.useMemo(() => new Map((data?.days ?? []).map((d) => [d.date, d])), [data]);
  const holidays = React.useMemo(() => new Set(data?.holidays ?? []), [data]);
  const maxAbs = React.useMemo(() => maxAbsNet(data?.days ?? []), [data]);
  const weeks = React.useMemo(() => monthGrid(month), [month]);
  const monthNet = data?.days.some((d) => d.net != null) ? data.days.reduce((s, d) => s + (d.net ?? 0), 0) : null;
  const [y, m] = month.split("-").map(Number);
  const title = `${fmtMonth(m - 1)} ${y}`;

  return (
    <Panel
      title={<span className="capitalize">{title}</span>}
      description={monthNet != null ? <span className={toneText(toneOf(monthNet))}>{t("calendar.monthNet", { net: fmtUsd(monthNet, { signed: true, decimals: "auto" }) })}</span> : undefined}
      actions={
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t("calendar.prev")} title={t("calendar.prev")} onClick={() => onMonth(-1)}>
            <ChevronLeft />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t("calendar.next")} title={t("calendar.next")} onClick={() => onMonth(1)} disabled={!canNext}>
            <ChevronRight />
          </Button>
        </div>
      }
      bodyClassName="flex flex-col gap-2"
    >
      <div className="grid grid-cols-7 gap-1" role="grid" aria-label={title}>
        {WEEKDAYS.map((wd) => (
          <div key={wd} className={cn("pb-1 text-center text-2xs font-medium uppercase text-muted-foreground", (wd === 0 || wd === 6) && "opacity-60")}>
            {fmtWeekday(wd, "short")}
          </div>
        ))}
        {loading && !data
          ? Array.from({ length: 35 }, (_, i) => <Skeleton key={i} className="aspect-square rounded-lg sm:aspect-[5/4]" />)
          : weeks.flat().map((d, i) =>
              d ? (
                <DayCell
                  key={d}
                  date={d}
                  stats={byDate.get(d)}
                  maxAbs={maxAbs}
                  muted={isWeekend(d) || holidays.has(d) || d > today}
                  holiday={holidays.has(d)}
                  today={d === today}
                  selected={d === selected}
                  onSelect={onSelect}
                />
              ) : (
                <div key={`pad-${i}`} aria-hidden="true" />
              ),
            )}
      </div>
      {data?.days.some((d) => d.mine != null) && (
        <p className="flex items-center gap-1.5 text-2xs text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
          {t("calendar.legendMine")}
        </p>
      )}
    </Panel>
  );
}

function DayCell({ date, stats, maxAbs, muted, holiday, today, selected, onSelect }: {
  date: string;
  stats: CalendarDay | undefined;
  maxAbs: number;
  muted: boolean;
  holiday: boolean;
  today: boolean;
  selected: boolean;
  onSelect: (date: string) => void;
}) {
  const { t } = topDayI18n.useT();
  const traded = !!stats && stats.trades > 0;
  const net = stats?.net ?? null;
  const level = heatLevel(net, maxAbs);
  const heat = net == null ? "" : net > 0 ? HEAT_UP[level] : HEAT_DOWN[level];
  const dateLabel = fmtDate(date, "weekdayDayMonth");
  const traders = commonI18n.t("units.traders", { count: stats?.traders ?? 0 });
  const aria = !traded
    ? `${dateLabel}: ${holiday ? t("calendar.holiday") : t("calendar.noTrades")}`
    : net != null
      ? t("calendar.dayAria", { date: dateLabel, net: fmtUsd(net, { signed: true, decimals: 0 }), traders })
      : t("calendar.dayAriaNoNet", { date: dateLabel, traders });
  const mine = stats?.mine ?? null;
  const title = [aria, mine != null ? t("calendar.mine", { net: fmtUsd(mine, { signed: true, decimals: "auto" }) }) : null, today ? t("calendar.today") : null]
    .filter(Boolean).join(" · ");

  return (
    <button
      type="button"
      role="gridcell"
      aria-selected={selected}
      aria-label={title}
      title={title}
      disabled={!traded}
      onClick={() => onSelect(date)}
      className={cn(
        "relative flex aspect-square min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg text-center transition-colors sm:aspect-[5/4]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        traded ? cn(heat || "bg-[var(--glass-bg)]", "hover:ring-1 hover:ring-primary/50") : "cursor-default",
        muted && !traded && "opacity-40",
        today && !selected && "ring-1 ring-primary/60",
        selected && "bg-primary-solid text-primary-foreground ring-2 ring-primary",
      )}
    >
      <span className={cn("text-xs font-semibold tabular-nums leading-none", !traded && "font-normal text-muted-foreground", selected && "text-primary-foreground")}>
        {Number(date.slice(8))}
      </span>
      {traded && (
        <span className={cn("max-w-full truncate px-0.5 text-[10px] leading-none tabular-nums", selected ? "text-primary-foreground/90" : net != null ? toneText(toneOf(net)) : "text-muted-foreground")}>
          {net != null ? fmtCompact(net, { signed: true }) : stats.traders}
        </span>
      )}
      {mine != null && (
        <span
          aria-hidden="true"
          className={cn("absolute right-1 top-1 h-1.5 w-1.5 rounded-full", selected ? "bg-primary-foreground" : mine > 0 ? "bg-up" : mine < 0 ? "bg-down" : "bg-primary")}
        />
      )}
    </button>
  );
}
