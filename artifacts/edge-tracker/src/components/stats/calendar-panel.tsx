import { useEffect, useMemo, useState } from "react";
import { ArrowRight, CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Panel, Pill, toneOf } from "@/components/ds";
import { cn } from "@/lib/utils";
import { PERIOD_HINT, dayHref, weekHref } from "@/lib/period-links";
import { fmtMetricCompact, fmtValue, heatBg, parseKey, toKey, weekdayLabel, type DayStat, type Metric } from "./metrics";
import { TradeLinkRow } from "./trade-link-row";
import { fmtDate, fmtMonth } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { statsI18n } from "@/i18n/ns/stats";

/** «Октябрь» / «October»: stand-alone month name with a capital letter (calendar header). */
const monthTitle = (m: number) => {
  const s = fmtMonth(m, "long");
  return s.charAt(0).toUpperCase() + s.slice(1);
};
/** Mon–Fri column heads in the UI language (weekdayLabel takes a Monday-first index). */
const head = () => [0, 1, 2, 3, 4].map(weekdayLabel);

type Month = { y: number; m: number };
const monthOf = (k: string): Month => ({ y: Number(k.substring(0, 4)), m: Number(k.substring(5, 7)) - 1 });
const addMonth = (a: Month, n: number): Month => {
  const d = new Date(a.y, a.m + n, 1);
  return { y: d.getFullYear(), m: d.getMonth() };
};
const cmp = (a: Month, b: Month) => a.y * 12 + a.m - (b.y * 12 + b.m);

/**
 * Month P&L calendar (TradeZella-style): Mon–Fri cells tinted by the day's result + weekly totals column.
 * Weekend trades are folded into the week total. Click a day to list its trades (and open its «Разбор дня»);
 * the week total opens the weekly review.
 */
export function CalendarPanel({ days, metric, trader }: { days: DayStat[]; metric: Metric; trader?: string | null }) {
  const { t } = statsI18n.useT();
  const byKey = useMemo(() => new Map(days.map((d) => [d.key, d])), [days]);
  const latest = days.at(-1)?.key;
  const first = days[0]?.key;
  const [month, setMonth] = useState<Month>(() => (latest ? monthOf(latest) : monthOf(toKey(new Date()))));
  const [selected, setSelected] = useState<string | null>(null);

  // Jump to the latest month with trades whenever the dataset changes (period/trader switch).
  useEffect(() => {
    setMonth(latest ? monthOf(latest) : monthOf(toKey(new Date())));
    setSelected(null);
  }, [latest, first]);

  const weeks = useMemo(() => {
    const start = new Date(month.y, month.m, 1);
    const offset = (start.getDay() + 6) % 7; // Monday-based
    const gridStart = new Date(month.y, month.m, 1 - offset);
    const rows: { days: Date[] }[] = [];
    for (let w = 0; w < 6; w++) {
      const row: Date[] = [];
      for (let i = 0; i < 7; i++) row.push(new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + w * 7 + i));
      if (w > 0 && row[0].getMonth() !== month.m) break;
      rows.push({ days: row });
    }
    return rows;
  }, [month]);

  const monthDays = days.filter((d) => d.key.startsWith(`${month.y}-${String(month.m + 1).padStart(2, "0")}`));
  const monthValue = monthDays.reduce<number | null>((s, d) => (d.value == null ? s : (s ?? 0) + d.value), null);
  const monthCount = monthDays.reduce((s, d) => s + d.count, 0);
  const max = Math.max(0, ...monthDays.map((d) => Math.abs(d.value ?? 0)));
  const sel = selected ? byKey.get(selected) : undefined;

  const minMonth = first ? monthOf(first) : month;
  const maxMonth = latest && cmp(monthOf(latest), monthOf(toKey(new Date()))) > 0 ? monthOf(latest) : monthOf(toKey(new Date()));

  return (
    <Panel
      title={t("calendar.title")}
      icon={CalendarDays}
      description={monthCount ? t("calendar.monthHint", { trades: commonI18n.t("units.trades", { count: monthCount }), days: monthDays.length }) : t("calendar.noMonth")}
      actions={
        <div className="flex items-center gap-1">
          <Button
            variant="ghost" size="icon" className="h-8 w-8 rounded-full" aria-label={t("calendar.prev")}
            disabled={cmp(month, minMonth) <= 0} onClick={() => { setMonth((m) => addMonth(m, -1)); setSelected(null); }}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[7.5rem] text-center text-sm font-medium tabular-nums">{monthTitle(month.m)} {month.y}</span>
          <Button
            variant="ghost" size="icon" className="h-8 w-8 rounded-full" aria-label={t("calendar.next")}
            disabled={cmp(month, maxMonth) >= 0} onClick={() => { setMonth((m) => addMonth(m, 1)); setSelected(null); }}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-[repeat(5,minmax(0,1fr))_minmax(0,0.9fr)] gap-1 sm:gap-1.5" role="grid" aria-label={t("calendar.aria", { month: `${monthTitle(month.m)} ${month.y}` })}>
        {head().map((h) => <div key={h} className="pb-1 text-center text-2xs font-medium text-muted-foreground" role="columnheader">{h}</div>)}
        <div className="pb-1 text-center text-2xs font-medium text-muted-foreground" role="columnheader">{t("calendar.week")}</div>
        {weeks.map((w, wi) => {
          const all = w.days.map((d) => byKey.get(toKey(d))).filter((x): x is DayStat => !!x);
          const wVal = all.reduce<number | null>((s, d) => (d.value == null ? s : (s ?? 0) + d.value), null);
          const wCnt = all.reduce((s, d) => s + d.count, 0);
          return (
            <div key={wi} className="contents" role="row">
              {w.days.slice(0, 5).map((d) => {
                const k = toKey(d);
                const inMonth = d.getMonth() === month.m;
                const stat = inMonth ? byKey.get(k) : undefined;
                const active = selected === k;
                const bg = !stat ? undefined : stat.value != null ? heatBg(stat.value, max) : heatBg(stat.wins - stat.losses, Math.max(4, Math.abs(stat.wins - stat.losses)));
                if (!inMonth) return <div key={k} className="aspect-square rounded-lg sm:aspect-[4/3]" role="gridcell" aria-hidden="true" />;
                const label = `${fmtDate(d, "dayMonthLong")}: ${stat ? `${commonI18n.t("units.trades", { count: stat.count })}${stat.value != null ? `, ${fmtValue(stat.value, metric)}` : ""}` : t("calendar.noTrades")}`;
                return (
                  <button
                    key={k}
                    type="button"
                    role="gridcell"
                    disabled={!stat}
                    aria-pressed={active}
                    aria-label={label}
                    title={label}
                    onClick={() => setSelected(active ? null : k)}
                    style={bg ? { backgroundColor: bg } : undefined}
                    className={cn(
                      "relative flex aspect-square flex-col justify-between rounded-lg border p-1 text-left transition-colors sm:aspect-[4/3] sm:p-1.5",
                      stat ? "border-transparent hover:ring-1 hover:ring-[hsl(var(--border))]" : "border-[hsl(var(--border)/0.5)]",
                      stat && !bg && "bg-[var(--glass-hover-bg)]",
                      active && "ring-2 ring-primary",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
                    )}
                  >
                    <span className={cn("text-2xs tabular-nums", stat ? "text-foreground" : "text-muted-foreground/80")}>{d.getDate()}</span>
                    {stat && (
                      <span className="flex flex-col leading-tight">
                        <span className="truncate text-2xs font-semibold tabular-nums text-foreground sm:text-xs">
                          {stat.value != null ? fmtMetricCompact(stat.value, metric) : `${stat.wins}/${stat.losses}`}
                        </span>
                        <span className="hidden truncate text-2xs text-muted-foreground sm:block">{commonI18n.t("units.tradesShort", { count: stat.count })}</span>
                      </span>
                    )}
                  </button>
                );
              })}
              {(() => {
                const weekLabel = `${t("calendar.weekLabel", { trades: commonI18n.t("units.trades", { count: wCnt }) })}${wVal != null ? `, ${fmtValue(wVal, metric)}` : ""}`;
                const body = (
                  <>
                    <span className={cn("truncate text-2xs font-semibold tabular-nums sm:text-xs", wVal == null ? "text-muted-foreground" : wVal > 0 ? "text-up" : wVal < 0 ? "text-down" : "text-foreground")}>
                      {wCnt ? (wVal != null ? fmtMetricCompact(wVal, metric) : "—") : ""}
                    </span>
                    {wCnt > 0 && <span className="text-2xs text-muted-foreground">{commonI18n.t("units.tradesShort", { count: wCnt })}</span>}
                  </>
                );
                const cls = "flex aspect-square flex-col justify-center rounded-lg bg-[var(--glass-bg)] p-1 text-center sm:aspect-[4/3]";
                return wCnt > 0 ? (
                  <Link
                    role="gridcell"
                    href={weekHref(toKey(w.days[0]), trader)}
                    aria-label={`${weekLabel} — ${PERIOD_HINT.week.toLowerCase()}`}
                    title={PERIOD_HINT.week}
                    className={cn(cls, "transition-colors hover:ring-1 hover:ring-[hsl(var(--border))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}
                  >
                    {body}
                  </Link>
                ) : (
                  <div role="gridcell" className={cls} aria-label={weekLabel}>{body}</div>
                );
              })()}
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {t("calendar.monthTotal")}{" "}
          <span className={cn("font-semibold tabular-nums", toneOf(monthValue) === "up" ? "text-up" : toneOf(monthValue) === "down" ? "text-down" : "text-foreground")}>
            {fmtValue(monthValue, metric)}
          </span>
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-up/50" aria-hidden="true" />{t("calendar.plus")}</span>
          <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-down/50" aria-hidden="true" />{t("calendar.minus")}</span>
          <span>{t("calendar.clickHint")}</span>
        </span>
      </div>

      {sel && (
        <div className="mt-3 rounded-xl border border-[hsl(var(--border))] p-2">
          <div className="flex items-center justify-between gap-2 px-2 pb-1">
            <div className="text-sm font-medium">
              {fmtDate(parseKey(sel.key), "dayMonthLong")}
              <Pill tone={toneOf(sel.value)} className="ml-2">{sel.value != null ? fmtValue(sel.value, metric) : commonI18n.t("units.tradesShort", { count: sel.count })}</Pill>
            </div>
            <span className="flex items-center gap-1">
              <Button asChild variant="ghost" size="sm" className="h-8 rounded-full px-3 text-xs text-primary">
                <Link href={dayHref(sel.key, trader)}>{PERIOD_HINT.day} <ArrowRight aria-hidden="true" /></Link>
              </Button>
              <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full" aria-label={t("calendar.closeDay")}
 onClick={() => setSelected(null)}>
                <X className="h-4 w-4" />
              </Button>
            </span>
          </div>
          <ul className="flex flex-col">
            {sel.trades.map((t) => <TradeLinkRow key={t.id} trade={t} metric={metric} showDate={false} />)}
          </ul>
        </div>
      )}
    </Panel>
  );
}
