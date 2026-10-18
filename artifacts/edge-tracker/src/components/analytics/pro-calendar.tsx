import { useMemo } from "react";
import { Link } from "wouter";
import type { Trade } from "@workspace/api-client-react";
import { ArrowRight, ArrowUpRight, CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel, Pill, Segmented, EmptyState, toneOf, toneText } from "@/components/ds";
import { cn } from "@/lib/utils";
import { PERIOD_HINT, dayHref, weekHref } from "@/lib/period-links";
import {
  type DaySummary, type Metric, type ValueFn,
  dateOnly, monthMatrix, monthName, ymd,
} from "@/lib/analytics-pro";
import { fmtVal, heatClass } from "./pro-format";
import { fmtDate, fmtWeekday } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { analyticsProI18n } from "@/i18n/ns/analyticsPro";
import { personName } from "@/i18n";

const tp = analyticsProI18n.t;

export type CalendarFocus = {
  view: "year" | "month";
  year: number;
  /** 0-based */
  month: number;
  /** YYYY-MM-DD or null */
  day: string | null;
};

/** Calendar header Mon…Sun ("Пн"), in the UI language. */
const weekdayHeaders = () => [1, 2, 3, 4, 5, 6, 0].map((d) => { const s = fmtWeekday(d, "short"); return s.charAt(0).toUpperCase() + s.slice(1); });

function hasValue(d: DaySummary | undefined) {
  return !!d && (d.valued ?? d.trades) > 0;
}

export function ProCalendar({
  days, trades, metric, val, focus, onFocus,
}: {
  days: DaySummary[];
  trades: Trade[];
  metric: Metric;
  val: ValueFn;
  focus: CalendarFocus;
  onFocus: (f: CalendarFocus) => void;
}) {
  const byDate = useMemo(() => new Map(days.map((d) => [d.date, d])), [days]);
  const today = ymd(new Date());
  // One trader in the filtered trades → day / week links open that trader's reports.
  const trader = useMemo(() => {
    const names = new Set(trades.map((t) => t.trader).filter(Boolean));
    return names.size === 1 ? ([...names][0] as string) : null;
  }, [trades]);

  const shift = (dir: -1 | 1) => {
    if (focus.view === "year") onFocus({ ...focus, year: focus.year + dir, day: null });
    else {
      const m = focus.month + dir;
      const y = focus.year + Math.floor(m / 12);
      onFocus({ ...focus, year: y, month: ((m % 12) + 12) % 12, day: null });
    }
  };

  const title = focus.view === "year" ? String(focus.year) : `${monthName(focus.month)} ${focus.year}`;

  return (
    <Panel
      icon={CalendarDays}
      title={tp("calendar.title")}
      description={tp("calendar.hint")}
      actions={
        <Segmented
          size="sm"
          ariaLabel={tp("calendar.scaleAria")}
          value={focus.view}
          onChange={(v) => onFocus({ ...focus, view: v, day: null })}
          options={[{ value: "year", label: tp("calendar.year") }, { value: "month", label: tp("calendar.month") }]}
        />
      }
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => shift(-1)} aria-label={focus.view === "year" ? tp("calendar.prevYear") : tp("calendar.prevMonth")}>
            <ChevronLeft aria-hidden="true" />
          </Button>
          <h3 className="min-w-[9.5rem] text-center text-base font-semibold tabular-nums" aria-live="polite">{title}</h3>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => shift(1)} aria-label={focus.view === "year" ? tp("calendar.nextYear") : tp("calendar.nextMonth")}>
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
        {focus.view === "month" && (
          <Button variant="ghost" size="sm" onClick={() => onFocus({ ...focus, view: "year", day: null })}>
            {tp("calendar.wholeYear", { year: focus.year })}
          </Button>
        )}
      </div>

      {focus.view === "year" ? (
        <YearView year={focus.year} byDate={byDate} metric={metric} today={today}
          onMonth={(m) => onFocus({ view: "month", year: focus.year, month: m, day: null })}
          onDay={(d) => onFocus({ view: "month", year: focus.year, month: Number(d.slice(5, 7)) - 1, day: d })}
        />
      ) : (
        <MonthView year={focus.year} month={focus.month} byDate={byDate} metric={metric} today={today} trader={trader}
          selected={focus.day}
          onDay={(d) => onFocus({ ...focus, day: focus.day === d ? null : d })}
        />
      )}

      {focus.view === "month" && focus.day && (
        <DayDetail
          date={focus.day}
          summary={byDate.get(focus.day)}
          trades={trades.filter((t) => dateOnly(t.date) === focus.day)}
          metric={metric}
          val={val}
          trader={trader}
          onClose={() => onFocus({ ...focus, day: null })}
        />
      )}
    </Panel>
  );
}

/* ── Year: 12 mini months ─────────────────────────────────────────────── */

function YearView({
  year, byDate, metric, today, onMonth, onDay,
}: {
  year: number;
  byDate: Map<string, DaySummary>;
  metric: Metric;
  today: string;
  onMonth: (m: number) => void;
  onDay: (d: string) => void;
}) {
  const yearDays = useMemo(() => [...byDate.values()].filter((d) => d.date.startsWith(`${year}-`)), [byDate, year]);
  const max = Math.max(0, ...yearDays.map((d) => Math.abs(d.net)));
  const months = useMemo(() => Array.from({ length: 12 }, (_, m) => {
    const key = `${year}-${String(m + 1).padStart(2, "0")}`;
    const ds = yearDays.filter((d) => d.date.startsWith(key));
    return {
      m,
      net: ds.reduce((s, d) => s + d.net, 0),
      trades: ds.reduce((s, d) => s + d.trades, 0),
      valued: ds.some(hasValue),
      green: ds.filter((d) => hasValue(d) && d.net > 0).length,
      red: ds.filter((d) => hasValue(d) && d.net < 0).length,
    };
  }), [yearDays, year]);
  const total = months.reduce((s, m) => s + m.net, 0);
  const tradesTotal = months.reduce((s, m) => s + m.trades, 0);
  const greenMonths = months.filter((m) => m.valued && m.net > 0).length;
  const redMonths = months.filter((m) => m.valued && m.net < 0).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">{tp("calendar.yearTotal")}</span>
        <span className={cn("font-semibold tabular-nums", toneText(toneOf(total)))}>{tradesTotal ? fmtVal(metric, total, { sign: true }) : "—"}</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground tabular-nums">{commonI18n.t("units.trades", { count: tradesTotal })}</span>
        {(greenMonths > 0 || redMonths > 0) && (
          <>
            <Pill tone="up">{tp("calendar.up", { count: greenMonths })}</Pill>
            <Pill tone="down">{tp("calendar.down", { count: redMonths })}</Pill>
          </>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        {months.map(({ m, net, trades, valued }) => {
          const weeks = monthMatrix(year, m);
          return (
            <div key={m} className="rounded-xl border border-border/70 bg-[var(--glass-bg)] p-3">
              <button
                type="button"
                onClick={() => onMonth(m)}
                className="mb-2 flex w-full items-baseline justify-between gap-2 rounded-lg text-left hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={tp("calendar.monthAria", { month: `${monthName(m)} ${year}`, value: trades ? fmtVal(metric, net, { sign: true }) : tp("calendar.noTrades") })}
              >
                <span className="text-sm font-semibold">{monthName(m)}</span>
                <span className={cn("text-sm font-semibold tabular-nums", trades ? toneText(toneOf(net)) : "text-muted-foreground")}>
                  {trades ? (valued ? fmtVal(metric, net, { compact: true, sign: true }) : commonI18n.t("units.trades", { count: trades })) : "—"}
                </span>
              </button>
              <div className="grid grid-cols-7 gap-[3px]" role="presentation">
                {weeks.flat().map((d, i) => {
                  if (!d) return <span key={i} className="aspect-square" aria-hidden="true" />;
                  const s = byDate.get(d);
                  const weekend = i % 7 >= 5;
                  return s ? (
                    <button
                      key={d}
                      type="button"
                      onClick={() => onDay(d)}
                      title={`${fmtDate(d, "long")}: ${hasValue(s) ? fmtVal(metric, s.net, { sign: true }) : "—"} · ${commonI18n.t("units.trades", { count: s.trades })}`}
                      aria-label={`${fmtDate(d, "long")}: ${hasValue(s) ? fmtVal(metric, s.net, { sign: true }) : tp("calendar.noResult")}, ${commonI18n.t("units.trades", { count: s.trades })}`}
                      className={cn(
                        "aspect-square rounded-[4px] border border-transparent transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none motion-reduce:hover:scale-100",
                        hasValue(s) && s.net !== 0 ? heatClass(s.net, max) : "bg-primary/25",
                        d === today && "border-primary",
                      )}
                    />
                  ) : (
                    <span
                      key={d}
                      aria-hidden="true"
                      className={cn("aspect-square rounded-[4px] bg-[var(--glass-bg)]", weekend && "opacity-40", d === today && "border border-primary")}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <Legend metric={metric} />
    </div>
  );
}

function Legend({ metric }: { metric: Metric }) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-2xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5"><span className="h-3 w-3 rounded-[3px] bg-down/45" aria-hidden="true" />{tp("calendar.legendLoss")}</span>
      <span className="inline-flex items-center gap-1.5"><span className="h-3 w-3 rounded-[3px] bg-up/45" aria-hidden="true" />{tp("calendar.legendProfit")}</span>
      <span className="inline-flex items-center gap-1.5"><span className="h-3 w-3 rounded-[3px] bg-primary/25" aria-hidden="true" />{tp("calendar.legendNoValue", { unit: metric === "r" ? "R" : "P&L" })}</span>
      <span>{tp("calendar.legendIntensity")}</span>
    </div>
  );
}

/* ── Month: broker-statement grid ─────────────────────────────────────── */

function MonthView({
  year, month, byDate, metric, today, selected, onDay, trader,
}: {
  year: number;
  month: number;
  byDate: Map<string, DaySummary>;
  metric: Metric;
  today: string;
  trader: string | null;
  selected: string | null;
  onDay: (d: string) => void;
}) {
  const weeks = useMemo(() => monthMatrix(year, month), [year, month]);
  const monthDays = weeks.flat().filter(Boolean).map((d) => byDate.get(d as string)).filter(Boolean) as DaySummary[];
  const max = Math.max(0, ...monthDays.map((d) => Math.abs(d.net)));
  const valued = monthDays.filter(hasValue);
  const total = monthDays.reduce((s, d) => s + d.net, 0);
  const tradesTotal = monthDays.reduce((s, d) => s + d.trades, 0);
  const green = valued.filter((d) => d.net > 0).length;
  const red = valued.filter((d) => d.net < 0).length;

  if (!monthDays.length) {
    return (
      <>
        <MonthGrid weeks={weeks} byDate={byDate} metric={metric} today={today} selected={selected} onDay={onDay} max={max} trader={trader} />
        <p className="mt-3 text-center text-sm text-muted-foreground">{tp("calendar.monthEmpty")}</p>
      </>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <MonthGrid weeks={weeks} byDate={byDate} metric={metric} today={today} selected={selected} onDay={onDay} max={max} trader={trader} />
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MiniStat label={tp("calendar.monthTotal")} value={valued.length ? fmtVal(metric, total, { sign: true }) : "—"} className={toneText(toneOf(total))} />
        <MiniStat label={tp("calendar.tradingDays")} value={`${monthDays.length}`} hint={commonI18n.t("units.trades", { count: tradesTotal })} />
        <MiniStat label={tp("calendar.upDown")} value={<><span className="text-up">{green}</span> / <span className="text-down">{red}</span></>} />
        <MiniStat label={tp("calendar.avgDay")} value={valued.length ? fmtVal(metric, total / valued.length, { sign: true }) : "—"} className={toneText(toneOf(total))} />
      </dl>
    </div>
  );
}

function MiniStat({ label, value, hint, className }: { label: string; value: React.ReactNode; hint?: string; className?: string }) {
  return (
    <div className="rounded-xl border border-border/70 bg-[var(--glass-bg)] px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("text-base font-semibold tabular-nums", className)}>
        {value}
        {hint && <span className="ml-1.5 text-xs font-normal text-muted-foreground">{hint}</span>}
      </dd>
    </div>
  );
}

function MonthGrid({
  weeks, byDate, metric, today, selected, onDay, max, trader,
}: {
  trader: string | null;
  weeks: (string | null)[][];
  byDate: Map<string, DaySummary>;
  metric: Metric;
  today: string;
  selected: string | null;
  onDay: (d: string) => void;
  max: number;
}) {
  return (
    <div className="grid grid-cols-7 gap-1 sm:grid-cols-[repeat(7,minmax(0,1fr))_minmax(0,0.9fr)] sm:gap-1.5">
      {weekdayHeaders().map((w, i) => (
        <div key={w} className={cn("px-1 pb-1 text-center text-xs text-muted-foreground", i >= 5 && "opacity-80")}>{w}</div>
      ))}
      <div className="hidden px-1 pb-1 text-center text-xs text-muted-foreground sm:block">{tp("calendar.week")}</div>
      {weeks.map((week, wi) => {
        const ws = week.map((d) => (d ? byDate.get(d) : undefined)).filter(Boolean) as DaySummary[];
        const wNet = ws.reduce((s, d) => s + d.net, 0);
        const wTrades = ws.reduce((s, d) => s + d.trades, 0);
        const wValued = ws.some(hasValue);
        return (
          <div key={wi} className="contents">
            {week.map((d, di) => {
              if (!d) return <div key={di} className="min-h-[56px] sm:min-h-[84px]" aria-hidden="true" />;
              const s = byDate.get(d);
              const dayNum = Number(d.slice(8, 10));
              const weekend = di >= 5;
              const isSel = selected === d;
              const content = (
                <>
                  <div className="flex items-start justify-between gap-1">
                    <span className={cn(
                      "grid h-5 min-w-5 place-items-center rounded-full px-1 text-xs tabular-nums",
                      d === today ? "bg-primary font-semibold text-primary-foreground" : "text-muted-foreground",
                    )}>{dayNum}</span>
                    {s && <span className="hidden text-2xs tabular-nums text-muted-foreground sm:inline">{s.trades}×</span>}
                  </div>
                  {s && (
                    <div className="mt-auto min-w-0">
                      <div className={cn("truncate text-xs font-semibold tabular-nums sm:text-sm", hasValue(s) ? toneText(toneOf(s.net)) : "text-muted-foreground")}>
                        <span className="sm:hidden">{hasValue(s) ? fmtVal(metric, s.net, { compact: true, sign: true }) : `${s.trades}×`}</span>
                        <span className="hidden sm:inline">{hasValue(s) ? fmtVal(metric, s.net, { sign: true, compact: Math.abs(s.net) >= 10000 }) : "—"}</span>
                      </div>
                      {(s.wins > 0 || s.losses > 0) && (
                        <div className="hidden text-2xs tabular-nums text-muted-foreground sm:block">
                          <span className="text-up">{s.wins}W</span> · <span className="text-down">{s.losses}L</span>
                        </div>
                      )}
                    </div>
                  )}
                </>
              );
              const base = cn(
                "flex min-h-[56px] min-w-0 flex-col rounded-lg border p-1 text-left sm:min-h-[84px] sm:rounded-xl sm:p-2",
                isSel ? "border-primary ring-2 ring-primary/40" : "border-border/60",
                weekend && !s && "opacity-50",
              );
              return s ? (
                <button
                  key={d}
                  type="button"
                  onClick={() => onDay(d)}
                  aria-pressed={isSel}
                  aria-label={`${fmtDate(d, "long")}: ${hasValue(s) ? fmtVal(metric, s.net, { sign: true }) : tp("calendar.noResult")}, ${commonI18n.t("units.trades", { count: s.trades })}`}
                  className={cn(
                    base,
                    hasValue(s) && s.net !== 0 ? heatClass(s.net, max) : "bg-primary/10",
                    "transition-colors hover:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  )}
                >
                  {content}
                </button>
              ) : (
                <div key={d} className={cn(base, "bg-transparent")}>{content}</div>
              );
            })}
            {wTrades > 0 ? (
              <Link
                href={weekHref(week.find(Boolean) as string, trader)}
                title={PERIOD_HINT.week}
                aria-label={tp("calendar.weekAria", { value: wValued ? fmtVal(metric, wNet, { sign: true }) : tp("calendar.noResult"), trades: commonI18n.t("units.trades", { count: wTrades }), hint: PERIOD_HINT.week.toLowerCase() })}
                className="hidden min-h-[84px] flex-col justify-center rounded-xl border border-dashed border-border/70 px-2 text-right transition-colors hover:border-primary/60 hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex"
              >
                <span className={cn("text-sm font-semibold tabular-nums", wValued ? toneText(toneOf(wNet)) : "text-muted-foreground")}>
                  {wValued ? fmtVal(metric, wNet, { sign: true, compact: Math.abs(wNet) >= 10000 }) : "—"}
                </span>
                <span className="text-2xs tabular-nums text-muted-foreground">{commonI18n.t("units.trades", { count: wTrades })}</span>
              </Link>
            ) : (
              <div className="hidden min-h-[84px] flex-col justify-center rounded-xl border border-dashed border-border/70 px-2 text-right sm:flex">
                <span className="text-xs text-muted-foreground">—</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ── Day drill-down ───────────────────────────────────────────────────── */

function DayDetail({
  date, summary, trades, metric, val, trader, onClose,
}: {
  trader: string | null;
  date: string;
  summary: DaySummary | undefined;
  trades: Trade[];
  metric: Metric;
  val: ValueFn;
  onClose: () => void;
}) {
  const sorted = [...trades].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.id - b.id);
  return (
    <section aria-label={tp("calendar.dayTrades", { date: fmtDate(date, "long") })} className="mt-4 rounded-xl border border-border/70 bg-[var(--glass-bg)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-2.5 sm:px-4">
        <div className="flex flex-wrap items-baseline gap-2">
          <h4 className="text-sm font-semibold">{fmtDate(date, "long")}</h4>
          {summary && hasValue(summary) && (
            <span className={cn("text-sm font-semibold tabular-nums", toneText(toneOf(summary.net)))}>{fmtVal(metric, summary.net, { sign: true })}</span>
          )}
          <span className="text-xs text-muted-foreground">{commonI18n.t("units.trades", { count: trades.length })}</span>
        </div>
        <span className="flex items-center gap-1">
          <Button asChild variant="ghost" size="sm" className="h-8 rounded-full px-3 text-xs text-primary">
            <Link href={dayHref(date, trader)}>{PERIOD_HINT.day} <ArrowRight aria-hidden="true" /></Link>
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose} aria-label={tp("calendar.closeDay")}>
            <X aria-hidden="true" />
          </Button>
        </span>
      </div>
      {sorted.length === 0 ? (
        <EmptyState title={tp("calendar.noDayTrades")} description={tp("calendar.noDayTradesHint")} className="py-6" />
      ) : (
        <ul className="divide-y divide-border/50">
          {sorted.map((t) => {
            const v = val(t);
            const time = (t.date ?? "").length > 10 ? (t.date ?? "").slice(11, 16) : null;
            const isShort = (t.side ?? "").toLowerCase().startsWith("s");
            return (
              <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 sm:px-4">
                <span className="w-16 truncate text-sm font-semibold">{t.ticker}</span>
                {t.side && <Pill tone={isShort ? "purple" : "accent"}>{isShort ? commonI18n.t("trading.short") : commonI18n.t("trading.long")}</Pill>}
                {t.result && (
                  <Pill tone={t.result === "win" ? "up" : t.result === "loss" ? "down" : "neutral"}>
                    {t.result === "win" || t.result === "loss" || t.result === "breakeven" ? tp(`calendar.result.${t.result}`) : t.result}
                  </Pill>
                )}
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {[time, t.setup, personName(t.trader)].filter(Boolean).join(" · ")}
                </span>
                <span className={cn("text-sm font-semibold tabular-nums", toneText(toneOf(v)))}>{fmtVal(metric, v, { sign: true })}</span>
                <Link
                  href={`/trades?highlight=${t.id}`}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={tp("calendar.openTrade", { ticker: t.ticker })}

                >
                  <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
