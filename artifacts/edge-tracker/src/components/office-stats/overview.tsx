/**
 * «Обзор» blocks of «Статистика офиса»: insights strip, KPI row, the general YoY chart with the goal line,
 * goal pace, the selected day and the daily heatmap calendar.
 */
import * as React from "react";
import { CalendarDays, Download, Flag, Lightbulb, MousePointerClick, TrendingDown, TrendingUp, AlertTriangle, Info } from "lucide-react";
import { EmptyState, Panel, Pill, ProgressRing, StatCard, StatGrid, toneOf, type Tone } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  STRATEGIES, monthLong, monthShort, dateOfDoy, fmtAxis, fmtDay, fmtDayLong, fmtNum, fmtParen, fmtShare, fmtV,
  type DayPoint, type Insight, type OfficeView, type PeriodView, type Unit, type YearView,
} from "./api";
import { LineCanvas, monthTicks, downloadCanvasPng, type LineSeries } from "./line-canvas";
import { divergingCell, strategyColor, tokenColor, useDark, yearColor } from "./palette";
import { fmtRate, fmtRatio, fmtUsd, fmtWeekday } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { officeI18n } from "@/i18n/ns/officeStats";

export type Ctx = { unit: Unit; view: OfficeView; focus: YearView; isAdmin: boolean };

const TONE_ICON: Record<Insight["tone"], typeof Info> = { up: TrendingUp, down: TrendingDown, warn: AlertTriangle, neutral: Info };
const TONE_CLASS: Record<Insight["tone"], string> = {
  up: "text-up bg-up/12", down: "text-down bg-down/12", warn: "text-warn bg-warn/12", neutral: "text-primary bg-primary/12",
};

export function InsightsStrip({ insights }: { insights: Insight[] }) {
  const { t } = officeI18n.useT();
  if (!insights.length) return null;
  return (
    <section aria-label={t("insights.title")} className="glass-panel rounded-2xl p-[var(--panel-p)]">
      <div className="mb-2.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-semibold text-foreground">
        <Lightbulb className="h-4 w-4 text-muted-foreground" aria-hidden="true" /> {t("insights.title")}
        <span className="text-xs font-normal text-muted-foreground">{t("insights.hint")}</span>
      </div>
      <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {insights.map((i) => {
          const Icon = TONE_ICON[i.tone];
          return (
            <li key={i.key} className="tile flex min-w-0 items-start gap-2.5 p-3">
              <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-lg", TONE_CLASS[i.tone])} aria-hidden="true"><Icon className="h-3.5 w-3.5" /></span>
              <span className="min-w-0 text-sm leading-snug text-foreground">{i.text}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Month tile value: $ compacted to +$16.4K so twelve tiles fit one row from 1400px (the full sum is in the title). */
function fmtMonthTile(v: number | null | undefined, unit: Unit): string {
  if (unit !== "usd" || v == null || !Number.isFinite(v) || Math.abs(v) < 1000) return fmtV(v, unit);
  return fmtUsd(v, { signed: true, compact: true });
}

/** Same-day value of an earlier year (cumulative at the last trading day ≤ doy). */
export function sameDayValue(y: YearView | undefined, doy: number): number | null {
  if (!y || !y.hasData) return null;
  let v = 0;
  for (const d of y.days) { if (d.doy > doy) break; v = d.cum; }
  return v;
}

export function KpiRow({ ctx, period, onJump }: { ctx: Ctx; period: PeriodView; onJump: (id: string) => void }) {
  const { focus, unit, view, isAdmin } = ctx;
  const { t } = officeI18n.useT();
  const tot = focus.totals;
  const last = focus.days[focus.days.length - 1];
  const prevY = view.years.find((y) => y.year === focus.year - 1);
  const yoy = last ? sameDayValue(prevY, last.doy) : null;
  const ranked = [...period.strategies].filter((s) => s.trades > 0).sort((a, b) => b.net - a.net);
  const best = ranked[0] && ranked[0].net > 0 ? ranked[0] : null;
  const worst = ranked.length > 1 && ranked[ranked.length - 1].net < 0 ? ranked[ranked.length - 1] : null;
  const pace = focus.pace;
  const goalShare = pace && pace.goal > 0 ? pace.actual / pace.goal : null;
  const greenShare = tot.tradingDays ? tot.greenDays / tot.tradingDays : null;
  const st = focus.streaks.current;
  return (
    <StatGrid cols={4} min="9rem">
      <StatCard
        label={t("kpi.netYear", { year: focus.year })}
        value={fmtV(tot.net, unit)}
        tone={toneOf(tot.net)}
        delta={yoy != null && prevY ? t("kpi.vsYear", { value: fmtV(tot.net - yoy, unit), year: prevY.year }) : undefined}
        deltaTone={yoy != null ? toneOf(tot.net - yoy) : undefined}
        hint={t("kpi.tradesDays", { trades: commonI18n.t("units.trades", { count: tot.trades }), days: commonI18n.t("time.daysShort", { count: tot.tradingDays }) })}
        spark={focus.days.map((d) => d.cum)}
      />
      <div className="glass-panel flex h-full min-h-[104px] min-w-0 items-center gap-3 rounded-2xl p-4">
        <ProgressRing
          value={goalShare != null ? Math.max(0, goalShare * 100) : 0}
          size={56}
          stroke={5}
          tone={pace?.status === "behind" ? "warn" : "up"}
          label={fmtRate(goalShare)}
          ariaLabel={t("kpi.goalAria")}
        />
        <div className="min-w-0">
          <p className="truncate text-xs text-muted-foreground">{t("kpi.goalOf", { year: focus.year, pct: focus.goalPct })}</p>
          {pace ? (
            <>
              <p className={cn("text-sm font-semibold", pace.status === "behind" ? "text-warn" : "text-up")}>
                {pace.status === "done" ? t("kpi.goalDone") : t(pace.status === "ahead" ? "kpi.ahead" : "kpi.behind", { value: fmtV(Math.abs(pace.gap), unit, { signed: false }) })}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {pace.status === "done" ? t("kpi.total", { value: fmtV(pace.actual, unit) }) : t("kpi.needPerMonth", { value: fmtV(pace.needPerMonth, unit) })}
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">{isAdmin ? t("kpi.setCapitalForGoal") : t("kpi.capitalNotSet")}</p>
          )}
        </div>
      </div>
      <StatCard
        label={t("kpi.bestStrategy")}
        value={best ? best.key : "—"}
        tone={best ? "up" : "neutral"}
        hint={best ? t("kpi.bestHint", { net: fmtParen(best.net, unit), share: fmtShare(best.netShare) }) : t("kpi.noProfitable")}
        onClick={() => onJump("strategies")}
      />
      <StatCard
        label={t("kpi.worstStrategy")}
        value={worst ? worst.key : "—"}
        tone={worst ? "down" : "neutral"}
        hint={worst ? `${fmtParen(worst.net, unit)} · WR ${fmtShare(worst.winRate)}` : t("kpi.allPositive")}
        onClick={() => onJump("strategies")}
      />
      <StatCard
        label={t("kpi.tradesPeriod")}
        value={fmtNum(period.totals.trades)}
        valueTitle={commonI18n.t("units.trades", { count: period.totals.trades })}
        hint={`WR ${fmtShare(period.totals.winRate)} · PF ${fmtRatio(period.totals.profitFactor)}`}
      />
      {isAdmin && period.totals.volume != null ? (
        <StatCard label={t("kpi.volume")} value={fmtNum(period.totals.volume)} valueTitle={t("kpi.volumeShares", { count: period.totals.volume })} hint={t("kpi.volumeHint")} />
      ) : (
        <StatCard
          label={t("kpi.avgDay")}
          value={fmtV(period.totals.avgDay, unit)}
          tone={toneOf(period.totals.avgDay)}
          hint={commonI18n.t("units.tradingDays", { count: period.totals.tradingDays })}
        />
      )}
      <StatCard
        label={t("kpi.greenDays")}
        value={fmtShare(greenShare)}
        tone={greenShare != null && greenShare >= 0.5 ? "up" : "neutral"}
        hint={st ? t(st > 0 ? "kpi.greenStreak" : "kpi.redStreak", { count: Math.abs(st) }) : t("kpi.ofTotal", { value: tot.greenDays, total: tot.tradingDays })}
        onClick={() => onJump("risk")}
      />
      <StatCard
        label={t("kpi.maxDrawdown")}
        value={fmtV(focus.drawdown.max, unit)}
        tone={focus.drawdown.max < 0 ? "down" : "neutral"}
        hint={focus.drawdown.recoveryDays != null ? t("kpi.recovered", { count: focus.drawdown.recoveryDays }) : focus.drawdown.max < 0 ? t("kpi.notRecovered") : t("kpi.noDrawdown")}
        onClick={() => onJump("risk")}
      />
    </StatGrid>
  );
}

export function useYearSeries(view: OfficeView, focusYear: number, pick: (y: YearView) => { x: number; y: number; date: string }[]): LineSeries[] {
  const dark = useDark();
  return React.useMemo(() => {
    const ys = [...view.years].filter((y) => y.year <= focusYear && y.hasData).sort((a, b) => b.year - a.year);
    return ys.map((y, rank) => ({
      key: String(y.year), label: String(y.year), color: yearColor(rank, dark), width: rank === 0 ? 2.25 : 1.75, fromZero: true, points: pick(y),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, focusYear, dark]);
}

export function GeneralChart({ ctx, onPickDay }: { ctx: Ctx; onPickDay: (date: string) => void }) {
  const { view, focus, unit } = ctx;
  const { t } = officeI18n.useT();
  const ref = React.useRef<HTMLDivElement | null>(null);
  const series = useYearSeries(view, focus.year, (y) => y.days.map((d) => ({ x: d.doy, y: d.cum, date: d.date })));
  const dayBy = React.useMemo(() => new Map(view.years.flatMap((y) => y.days.map((d) => [d.date, d] as const))), [view]);
  const fmtY = React.useCallback((v: number) => fmtAxis(v, unit), [unit]);
  const [h, setH] = React.useState(340);
  React.useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const f = () => setH(mq.matches ? 260 : 340);
    f(); mq.addEventListener("change", f);
    return () => mq.removeEventListener("change", f);
  }, []);
  return (
    <Panel
      title={t("chart.title")}
      description={t("chart.desc")}
      icon={TrendingUp}
      fill
      className="lg:col-span-8"
      actions={series.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          title={t("chart.pngTitle")}
          onClick={() => downloadCanvasPng(ref.current, `office-net-${focus.year}-${unit}.png`, {
            title: t("chart.title"),
            subtitle: t("chart.pngSubtitle", { unit: unit === "usd" ? "$" : t("chart.unitPct"), date: fmtDay(focus.days[focus.days.length - 1]?.date), year: focus.year }),
            legend: [
              ...series.map((s) => ({ label: s.label, color: s.color })),
              ...(focus.goal != null ? [{ label: t("chart.goalLegend", { value: fmtV(focus.goal, unit, { digits: unit === "pct" ? 0 : undefined }) }), color: tokenColor("--foreground", "#888"), dashed: true }] : []),
            ],
          })}
          aria-label={t("chart.pngAria")}
        >
          <Download className="h-4 w-4" /> PNG
        </Button>
      )}
    >
      {series.length === 0 ? (
        <EmptyState icon={TrendingUp} title={t("states.noTradesYear", { year: focus.year })} description={t("chart.emptyDesc")} />
      ) : (
        <div ref={ref} className="flex flex-col gap-2">
          <LineCanvas
            series={series}
            xMin={0}
            xMax={366}
            xTicks={monthTicks()}
            goal={focus.goal != null ? { y: focus.goal, label: t("chart.goalLine", { value: fmtV(focus.goal, unit, { digits: unit === "pct" ? 0 : undefined }) }), pace: true } : null}
            fmtY={fmtY}
            height={h}
            endLabels
            ariaLabel={t("chart.aria", { years: series.map((s) => s.label).join(t("chart.yearsJoin")) })}
            onPick={(r) => r.point && onPickDay(r.point.date)}
            renderTooltip={(_x, rows) => {
              const head = rows[0]?.point;
              return (
                <div className="flex flex-col gap-1">
                  {head && <p className="font-medium text-foreground">{t("chart.dayOfYear", { date: fmtDay(head.date), n: head.x })}</p>}
                  {rows.map((r) => {
                    const d = r.point ? dayBy.get(r.point.date) : undefined;
                    return (
                      <div key={r.key} className="flex items-center justify-between gap-3">
                        <span className="flex items-center gap-1.5 text-muted-foreground">
                          <span className="h-2 w-2 rounded-full" style={{ background: r.color }} aria-hidden="true" />{r.label}
                        </span>
                        <span className="tabular-nums">
                          <b className="text-foreground">{fmtV(r.point!.y, unit)}</b>
                          {d && <span className={cn("ml-1.5", d.v >= 0 ? "text-up" : "text-down")}>{fmtV(d.v, unit)}</span>}
                        </span>
                      </div>
                    );
                  })}
                  <p className="pt-0.5 text-2xs text-muted-foreground">{t("chart.clickHint")}</p>
                </div>
              );
            }}
          />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {series.map((s) => (
              <span key={s.key} className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 rounded-full" style={{ background: s.color }} aria-hidden="true" />{s.label}</span>
            ))}
            {focus.goal != null && <span className="inline-flex items-center gap-1.5"><span className="w-4 border-t border-dashed border-foreground/60" aria-hidden="true" />{t("chart.goalOfYear", { year: focus.year })}</span>}
            {view.years.filter((y) => !y.hasData && y.year < focus.year).map((y) => (
              <span key={y.year} className="italic">{y.year}: {y.capitalMissing ? t("chart.capitalMissing") : t("states.noTradesShort")}</span>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}

export function DayDetail({ ctx, date, onClear }: { ctx: Ctx; date: string | null; onClear: () => void }) {
  const { unit, view } = ctx;
  const { t } = officeI18n.useT();
  const dark = useDark();
  const day: DayPoint | undefined = React.useMemo(() => (date ? view.years.flatMap((y) => y.days).find((d) => d.date === date) : undefined), [date, view]);
  if (!date || !day) {
    return (
      <Panel title={t("day.title")} icon={CalendarDays} fill>
        <EmptyState compact icon={MousePointerClick} title={t("day.pick")} description={t("day.pickDesc")} />
      </Panel>
    );
  }
  const parts = STRATEGIES.map((k) => ({ k, v: day.s[k] ?? 0 })).filter((p) => Math.abs(p.v) > 1e-12).sort((a, b) => b.v - a.v);
  const max = Math.max(...parts.map((p) => Math.abs(p.v)), 1e-9);
  return (
    <Panel
      title={fmtDayLong(day.date)}
      icon={CalendarDays}
      fill
      actions={<Button variant="ghost" size="sm" onClick={onClear}>{commonI18n.t("actions.reset")}</Button>}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className={cn("whitespace-nowrap text-2xl font-semibold tabular-nums", day.v >= 0 ? "text-up" : "text-down")}>{fmtV(day.v, unit)}</span>
        <span className="text-xs text-muted-foreground">{t("day.ytd", { trades: commonI18n.t("units.trades", { count: day.trades }), value: fmtV(day.cum, unit) })}</span>
      </div>
      <ul className="mt-3 flex flex-col gap-1.5">
        {parts.map((p) => (
          <li key={p.k} className="grid grid-cols-[6.5rem_1fr_auto] items-center gap-2 text-xs">
            <span className="flex items-center gap-1.5 truncate text-muted-foreground"><span className="h-2 w-2 shrink-0 rounded-full" style={{ background: strategyColor(p.k, dark) }} aria-hidden="true" />{p.k}</span>
            <span className="relative h-2 rounded-full bg-[var(--glass-bg)]">
              <span className={cn("absolute inset-y-0 left-0 rounded-full", p.v >= 0 ? "bg-up" : "bg-down")} style={{ width: `${Math.max(3, (Math.abs(p.v) / max) * 100)}%` }} />
            </span>
            <span className={cn("w-16 text-right font-medium tabular-nums", p.v >= 0 ? "text-up" : "text-down")}>{fmtV(p.v, unit)}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function PacePanel({ ctx }: { ctx: Ctx }) {
  const { focus, unit, isAdmin } = ctx;
  const { t } = officeI18n.useT();
  const p = focus.pace;
  return (
    <Panel title={t("pace.title", { pct: focus.goalPct })} icon={Flag} fill>
      {!p ? (
        <p className="text-sm text-muted-foreground">{isAdmin ? t("pace.noCapitalAdmin") : t("pace.noCapitalMember", { year: focus.year })}</p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="relative h-3 rounded-full bg-[var(--glass-bg)]" role="img" aria-label={t("pace.aria", { actual: fmtV(p.actual, unit), expected: fmtV(p.expected, unit), goal: fmtV(p.goal, unit) })}>
            <span className={cn("absolute inset-y-0 left-0 rounded-full", p.actual >= p.expected ? "bg-up" : "bg-warn")} style={{ width: `${Math.max(0, Math.min(100, (p.actual / p.goal) * 100))}%` }} />
            <span className="absolute -top-1 h-5 w-0.5 rounded-full bg-foreground/70" style={{ left: `${Math.min(100, p.elapsed * 100)}%` }} title={t("pace.evenPace")} />
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">{t("pace.now")}</dt><dd className={cn("text-right font-semibold tabular-nums", p.actual >= 0 ? "text-up" : "text-down")}>{fmtV(p.actual, unit)}</dd>
            <dt className="text-muted-foreground">{t("pace.planToday")}</dt><dd className="text-right tabular-nums">{fmtV(p.expected, unit)}</dd>
            <dt className="text-muted-foreground">{p.gap >= 0 ? t("pace.ahead") : t("pace.behind")}</dt><dd className={cn("text-right font-medium tabular-nums", p.gap >= 0 ? "text-up" : "text-warn")}>{fmtV(Math.abs(p.gap), unit, { signed: false })}</dd>
            {p.status !== "done" && (<><dt className="text-muted-foreground">{t("pace.needPerMonth")}</dt><dd className="text-right font-medium tabular-nums">{fmtV(p.needPerMonth, unit)}</dd></>)}
            {p.projected != null && (<><dt className="text-muted-foreground">{t("pace.projected")}</dt><dd className={cn("text-right tabular-nums", p.projected >= p.goal ? "text-up" : "text-muted-foreground")}>{fmtV(p.projected, unit)}</dd></>)}
          </dl>
        </div>
      )}
    </Panel>
  );
}

/** Daily heatmap calendar (Mon–Fri × weeks) of the focus year + month tiles. */
export function CalendarHeatmap({ ctx, selected, onPickDay, onPickMonth }: { ctx: Ctx; selected: string | null; onPickDay: (d: string) => void; onPickMonth: (m: number) => void }) {
  const { focus, unit } = ctx;
  const { t } = officeI18n.useT();
  const byDate = React.useMemo(() => new Map(focus.days.map((d) => [d.date, d])), [focus]);
  const max = React.useMemo(() => {
    const vals = focus.days.map((d) => Math.abs(d.v)).sort((a, b) => a - b);
    return vals.length ? vals[Math.floor(vals.length * 0.92)] || vals[vals.length - 1] : 0;
  }, [focus]);
  const weeks = React.useMemo(() => {
    const y = focus.year;
    const jan1 = new Date(Date.UTC(y, 0, 1));
    const start = new Date(jan1); start.setUTCDate(1 - ((jan1.getUTCDay() + 6) % 7));
    const out: { key: string; days: (string | null)[]; month: number | null }[] = [];
    for (let d = new Date(start); d.getUTCFullYear() <= y; d.setUTCDate(d.getUTCDate() + 7)) {
      const days: (string | null)[] = [];
      let month: number | null = null;
      for (let i = 0; i < 5; i++) {
        const x = new Date(d); x.setUTCDate(d.getUTCDate() + i);
        const ymd = x.toISOString().slice(0, 10);
        if (x.getUTCFullYear() === y) { days.push(ymd); if (month == null && (x.getUTCDate() === 1 || (i === 0 && x.getUTCDate() <= 3))) month = x.getUTCMonth(); }
        else days.push(null);
      }
      out.push({ key: d.toISOString().slice(0, 10), days, month });
    }
    return out;
  }, [focus.year]);
  const monthMax = Math.max(1e-9, ...focus.months.map((m) => Math.abs(m.v ?? 0)));
  const shownMonths = new Set<number>();
  return (
    <Panel title={t("calendar.title", { year: focus.year })} description={t("calendar.desc")} icon={CalendarDays}>
      {!focus.hasData ? (
        <EmptyState compact icon={CalendarDays} title={t("states.noTradingDays")} />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="overflow-x-auto pb-1">
            <div
              className="grid min-w-[620px] gap-[3px]"
              style={{ gridTemplateColumns: `1.5rem repeat(${weeks.length}, minmax(9px, 1fr))` }}
              role="grid"
              aria-label={t("calendar.aria", { year: focus.year })}
            >
              <span />
              {weeks.map((w) => {
                const show = w.month != null && !shownMonths.has(w.month);
                if (show) shownMonths.add(w.month!);
                return <span key={w.key} className="overflow-visible whitespace-nowrap text-2xs leading-4 text-muted-foreground">{show ? monthShort(w.month!) : ""}</span>;
              })}
              {[1, 2, 3, 4, 5].map((d) => { const s = fmtWeekday(d, "short"); return s.charAt(0).toUpperCase() + s.slice(1); }).map((wd, row) => (
                <React.Fragment key={wd}>
                  <span className="self-center text-2xs text-muted-foreground">{row % 2 === 0 ? wd : ""}</span>
                  {weeks.map((w) => {
                    const ymd = w.days[row];
                    if (!ymd) return <span key={w.key} className="aspect-square" />;
                    const d = byDate.get(ymd);
                    return (
                      <button
                        key={w.key}
                        type="button"
                        disabled={!d}
                        onClick={() => d && onPickDay(ymd)}
                        title={d ? t("calendar.dayTitle", { date: fmtDay(ymd), value: fmtV(d.v, unit), trades: commonI18n.t("units.trades", { count: d.trades }) }) : t("calendar.dayNoTrades", { date: fmtDay(ymd) })}
                        aria-label={d ? t("calendar.dayAria", { date: fmtDay(ymd), value: fmtV(d.v, unit) }) : t("calendar.dayAriaEmpty", { date: fmtDay(ymd) })}
                        className={cn(
                          "aspect-square w-full max-w-[22px] rounded-[3px] transition-transform enabled:hover:scale-125 disabled:cursor-default",
                          selected === ymd && "ring-2 ring-foreground ring-offset-1 ring-offset-background",
                        )}
                        style={{ background: d ? divergingCell(d.v, max) : "hsl(var(--muted-foreground) / 0.08)" }}
                      />
                    );
                  })}
                </React.Fragment>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2 text-2xs text-muted-foreground">
            <span>{t("calendar.minus")}</span>
            {[-1, -0.5, -0.15, 0.15, 0.5, 1].map((k) => <span key={k} className="h-2.5 w-2.5 rounded-[3px]" style={{ background: divergingCell(k, 1) }} aria-hidden="true" />)}
            <span>{t("calendar.plus")}</span>
          </div>
          <div className="grid grid-cols-3 gap-2 min-[640px]:grid-cols-4 min-[1024px]:grid-cols-6 min-[1400px]:grid-cols-12">
            {focus.months.map((m) => (
              <button
                key={m.month}
                type="button"
                disabled={!m.days}
                onClick={() => onPickMonth(m.month)}
                className="tile tile-interactive press flex min-w-0 flex-col gap-0.5 p-2 text-left disabled:opacity-50"
                title={m.days ? t("calendar.monthTitle", { month: monthLong(m.month - 1), value: fmtV(m.v, unit), green: m.green, red: m.red }) : t("calendar.monthEmpty", { month: monthLong(m.month - 1) })}
              >
                <span className="text-2xs uppercase tracking-wide text-muted-foreground">{monthShort(m.month - 1)}</span>
                <span className={cn("truncate text-sm font-semibold tabular-nums", (m.v ?? 0) > 0 ? "text-up" : (m.v ?? 0) < 0 ? "text-down" : "text-muted-foreground")}>{m.days ? fmtMonthTile(m.v, unit) : "—"}</span>
                <span className="h-1 rounded-full" style={{ background: divergingCell(m.v, monthMax) }} aria-hidden="true" />
              </button>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}

export function toneFor(v: number | null | undefined): Tone { return toneOf(v); }
export { Pill, dateOfDoy };
