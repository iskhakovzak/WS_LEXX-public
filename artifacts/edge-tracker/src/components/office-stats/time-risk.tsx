/**
 * «Время» and «Риск» blocks: 30-minute profile, weekday profile, top/bottom tickers, underwater curve,
 * daily-results histogram, streaks and best / worst days.
 */
import * as React from "react";
import { Activity, CalendarRange, Clock, Download, Flame, Medal, TrendingDown, Tag } from "lucide-react";
import { EmptyState, Panel } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { fmtAxis, fmtDay, fmtShare, fmtV, type DayPoint, type PeriodView, type TickerRow, type Unit } from "./api";
import { LineCanvas, monthTicks, downloadCanvasPng } from "./line-canvas";
import { strategyColor, tokenColor, useDark } from "./palette";
import type { Ctx } from "./overview";
import { commonI18n } from "@/i18n/ns/common";
import { officeI18n } from "@/i18n/ns/officeStats";
import { fmtWeekday } from "@/lib/format";

const trades = (count: number) => commonI18n.t("units.trades", { count });
const daysShort = (count: number) => commonI18n.t("time.daysShort", { count });
/** Weekday label of the server's Mon-based index (0 = Mon) in the UI language: «Пн» / «Mon» / «Du». */
const weekdayLabel = (i: number) => { const s = fmtWeekday(i + 1, "short"); return s.charAt(0).toUpperCase() + s.slice(1); };
/** Entry-time bucket label: pre/post come from the server in RU, so they are rendered from the key. */
const bucketLabel = (b: { key: string; label: string }) => (b.key === "pre" ? officeI18n.t("time.premarket") : b.key === "post" ? officeI18n.t("time.postmarket") : b.label);

/** Vertical diverging bars around a zero line (DOM, so every bar has a native hover + aria). */
function DivergingBars({ items, unit, height = 150, labelEvery = 1 }: {
  items: { key: string; label: string; v: number; title: string; muted?: boolean }[];
  unit: Unit;
  height?: number;
  labelEvery?: number;
}) {
  const { t } = officeI18n.useT();
  const max = Math.max(1e-9, ...items.map((i) => Math.abs(i.v)));
  const [hover, setHover] = React.useState<string | null>(null);
  const hov = items.find((i) => i.key === hover);
  return (
    <div className="flex flex-col gap-1">
      <div className="h-5 text-xs text-muted-foreground" aria-live="polite">{hov ? hov.title : t("time.hoverHint")}</div>
      <div className="relative flex items-stretch gap-[2px]" style={{ height }}>
        <span className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-border" aria-hidden="true" />
        {items.map((i) => {
          const h = (Math.abs(i.v) / max) * 50;
          return (
            <button
              key={i.key}
              type="button"
              className="group relative min-w-[10px] flex-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onMouseEnter={() => setHover(i.key)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(i.key)}
              onBlur={() => setHover(null)}
              aria-label={i.title}
              title={i.title}
            >
              <span className="absolute inset-0 rounded-sm group-hover:bg-[var(--tile-hover-bg)]" aria-hidden="true" />
              <span
                className={cn("absolute inset-x-[1px] rounded-[3px]", i.v >= 0 ? "bg-up" : "bg-down", i.muted && "opacity-60", hover && hover !== i.key && "opacity-45")}
                style={i.v >= 0 ? { bottom: "50%", height: `${Math.max(0.6, h)}%` } : { top: "50%", height: `${Math.max(0.6, h)}%` }}
              />
            </button>
          );
        })}
      </div>
      <div className="flex gap-[2px] text-2xs text-muted-foreground">
        {items.map((i, idx) => (
          <span key={i.key} className="min-w-[10px] flex-1 overflow-visible whitespace-nowrap text-center">{idx % labelEvery === 0 ? i.label : ""}</span>
        ))}
      </div>
      <div className="flex flex-wrap justify-between gap-x-3 text-2xs text-muted-foreground"><span>{t("time.max", { value: fmtV(max, unit, { signed: false }) })}</span><span>{t("time.mutedHint")}</span></div>
    </div>
  );
}

export function TimeOfDay({ period, unit }: { period: PeriodView; unit: Unit }) {
  const { t } = officeI18n.useT();
  const items = period.timeOfDay.map((b) => ({
    key: b.key,
    label: b.key === "pre" ? t("time.pre") : b.key === "post" ? t("time.post") : b.label.split("–")[0],
    v: b.v,
    muted: b.key === "pre" || b.key === "post",
    title: t("time.bucketTip", { label: bucketLabel(b), value: fmtV(b.v, unit), trades: trades(b.trades), wr: fmtShare(b.winRate) }),
  }));
  const best = [...period.timeOfDay].sort((a, b) => b.v - a.v)[0];
  const worst = [...period.timeOfDay].sort((a, b) => a.v - b.v)[0];
  const [labelEvery, setLabelEvery] = React.useState(2);
  React.useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const f = () => setLabelEvery(mq.matches ? 3 : 2);
    f(); mq.addEventListener("change", f);
    return () => mq.removeEventListener("change", f);
  }, []);
  const any = period.timeOfDay.some((b) => b.trades > 0);
  return (
    <Panel title={t("time.entryTitle")} description={t("time.entryDesc")} icon={Clock} fill className="lg:col-span-7">
      {!any ? <EmptyState compact icon={Clock} title={t("states.noTradesPeriod")} /> : (
        <div className="flex flex-col gap-3">
          <DivergingBars items={items} unit={unit} labelEvery={labelEvery} />
          <div className="flex flex-wrap gap-2 text-xs">
            {best && best.v > 0 && <span className="rounded-full bg-up/12 px-2 py-0.5 text-up">{t("time.bestWindow", { label: bucketLabel(best), value: fmtV(best.v, unit) })}</span>}
            {worst && worst.v < 0 && <span className="rounded-full bg-down/12 px-2 py-0.5 text-down">{t("time.worstWindow", { label: bucketLabel(worst), value: fmtV(worst.v, unit) })}</span>}
          </div>
        </div>
      )}
    </Panel>
  );
}

export function WeekdayProfile({ period, unit }: { period: PeriodView; unit: Unit }) {
  const { t } = officeI18n.useT();
  const rows = period.weekday;
  const lo = Math.min(0, ...rows.map((r) => r.avg ?? 0));
  const hi = Math.max(0, ...rows.map((r) => r.avg ?? 0));
  const span = Math.max(1e-9, hi - lo);
  const zero = (-lo / span) * 100;
  return (
    <Panel title={t("time.weekdayTitle")} description={t("time.weekdayDesc")} icon={CalendarRange} fill className="lg:col-span-5">
      {!rows.some((r) => r.days) ? <EmptyState compact icon={CalendarRange} title={t("states.noTradingDays")} /> : (
        <ul className="flex flex-col gap-2.5">
          {rows.map((r) => {
            const a = r.avg ?? 0;
            return (
              <li key={r.weekday} className="grid grid-cols-[2rem_1fr_4.5rem] items-center gap-2 text-xs" title={t("time.weekdayTip", { day: weekdayLabel(r.weekday), value: fmtV(r.v, unit), days: daysShort(r.days), green: r.green })}>
                <span className="font-medium text-foreground">{weekdayLabel(r.weekday)}</span>
                <span className="flex flex-col gap-1">
                  <span className="relative h-3">
                    {zero > 0.5 && <span className="absolute inset-y-0 w-px bg-border" style={{ left: `${zero}%` }} aria-hidden="true" />}
                    <span className={cn("absolute inset-y-0 rounded-[3px]", a >= 0 ? "bg-up/85" : "bg-down/85")} style={a >= 0 ? { left: `${zero}%`, width: `${(Math.abs(a) / span) * 100}%` } : { right: `${100 - zero}%`, width: `${(Math.abs(a) / span) * 100}%` }} />
                  </span>
                  <span className="text-2xs text-muted-foreground">{r.days ? t("time.weekdayGreen", { share: fmtShare(r.green / r.days), days: daysShort(r.days) }) : t("time.noDays")}</span>
                </span>
                <span className={cn("text-right font-semibold tabular-nums", a >= 0 ? "text-up" : "text-down")}>{r.avg == null ? "—" : fmtV(r.avg, unit)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function TickerList({ rows, unit, tone }: { rows: TickerRow[]; unit: Unit; tone: "up" | "down" }) {
  const { t } = officeI18n.useT();
  const dark = useDark();
  const max = Math.max(1e-9, ...rows.map((r) => Math.abs(r.v)));
  if (!rows.length) return <p className="py-3 text-xs text-muted-foreground">{tone === "up" ? t("time.noWinners") : t("time.noLosers")}</p>;
  return (
    <ol className="flex flex-col gap-1.5">
      {rows.map((r, i) => (
        <li key={r.ticker} className="grid grid-cols-[1.25rem_minmax(0,8rem)_1fr_auto] items-center gap-2 text-xs" title={t("time.tickerTip", { ticker: r.ticker, value: fmtV(r.v, unit), trades: trades(r.trades), wr: fmtShare(r.winRate), strategy: r.strategy })}>
          <span className="text-muted-foreground tabular-nums">{i + 1}</span>
          <span className="flex min-w-0 items-center gap-1.5 truncate font-medium text-foreground">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: strategyColor(r.strategy, dark) }} aria-hidden="true" />{r.ticker}
          </span>
          <span className="relative h-1.5 rounded-full bg-[var(--glass-bg)]">
            <span className={cn("absolute inset-y-0 left-0 rounded-full", tone === "up" ? "bg-up" : "bg-down")} style={{ width: `${(Math.abs(r.v) / max) * 100}%` }} />
          </span>
          <span className="flex items-baseline gap-1.5 tabular-nums">
            <b className={cn(tone === "up" ? "text-up" : "text-down")}>{fmtV(r.v, unit)}</b>
            {r.share != null && <span className="w-9 text-right text-2xs text-muted-foreground">{fmtShare(r.share)}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function Tickers({ period, unit }: { period: PeriodView; unit: Unit }) {
  const { t } = officeI18n.useT();
  return (
    <Panel title={t("time.tickersTitle")} description={t("time.tickersDesc")} icon={Tag}>
      <div className="grid gap-5 md:grid-cols-2">
        <div><p className="mb-2 text-xs font-medium text-up">{t("time.best")}</p><TickerList rows={period.tickers.top.filter((t) => t.v > 0)} unit={unit} tone="up" /></div>
        <div><p className="mb-2 text-xs font-medium text-down">{t("time.worst")}</p><TickerList rows={period.tickers.bottom.filter((t) => t.v < 0)} unit={unit} tone="down" /></div>
      </div>
    </Panel>
  );
}

/** Underwater curve: distance from the running peak of the cumulative curve. */
export function Underwater({ ctx, onPickDay }: { ctx: Ctx; onPickDay: (d: string) => void }) {
  const { focus, unit } = ctx;
  const { t } = officeI18n.useT();
  const dark = useDark();
  const series = React.useMemo(() => {
    let peak = 0;
    const pts = focus.days.map((d) => { peak = Math.max(peak, d.cum); return { x: d.doy, y: d.cum - peak, date: d.date }; });
    return pts.length ? [{ key: "dd", label: t("risk.ddSeries"), color: tokenColor("--down", dark ? "#f07a7a" : "#d03b3b"), points: pts, area: true, width: 1.75 }] : [];
  }, [focus, dark, t]);
  const fmtY = React.useCallback((v: number) => fmtAxis(v, unit), [unit]);
  const dd = focus.drawdown;
  const ref = React.useRef<HTMLDivElement | null>(null);
  return (
    <Panel
      title={t("risk.ddTitle")}
      description={t("risk.ddDesc")}
      icon={TrendingDown}
      fill
      className="lg:col-span-8"
      actions={series.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("risk.ddPngAria")}
          onClick={() => downloadCanvasPng(ref.current, `office-drawdown-${focus.year}-${unit}.png`, {
            title: t("risk.ddPngTitle", { year: focus.year }),
            subtitle: t("risk.ddPngSubtitle", { value: fmtV(dd.max, unit), unit: unit === "usd" ? "$" : t("chart.unitPct") }),
          })}
        >
          <Download className="h-4 w-4" /> PNG
        </Button>
      )}
    >
      {!series.length ? <EmptyState compact icon={TrendingDown} title={t("states.noTrades")} /> : (
        <div ref={ref} className="flex flex-col gap-3">
          <LineCanvas
            series={series}
            xMin={0}
            xMax={366}
            xTicks={monthTicks()}
            fmtY={fmtY}
            height={190}
            ariaLabel={t("risk.ddAria")}
            onPick={(r) => r.point && onPickDay(r.point.date)}
            renderTooltip={(_x, rows) => rows[0]?.point ? (
              <div><p className="text-muted-foreground">{fmtDay(rows[0].point.date)}</p><b className="tabular-nums text-foreground">{t("risk.fromPeak", { value: fmtV(rows[0].point.y, unit) })}</b></div>
            ) : null}
          />
          <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <div className="tile p-2.5"><dt className="text-muted-foreground">{t("risk.maxDd")}</dt><dd className="text-sm font-semibold tabular-nums text-down">{fmtV(dd.max, unit)}</dd></div>
            <div className="tile p-2.5"><dt className="text-muted-foreground">{t("risk.peakTrough")}</dt><dd className="text-sm font-medium">{dd.peakDate && dd.troughDate ? `${fmtDay(dd.peakDate)} → ${fmtDay(dd.troughDate)}` : "—"}</dd></div>
            <div className="tile p-2.5"><dt className="text-muted-foreground">{t("risk.recovery")}</dt><dd className="text-sm font-medium">{dd.recoveryDays != null ? commonI18n.t("units.tradingDays", { count: dd.recoveryDays }) : dd.max < 0 ? t("risk.recoveryNotYet") : "—"}</dd></div>
            <div className="tile p-2.5"><dt className="text-muted-foreground">{t("risk.now")}</dt><dd className={cn("text-sm font-semibold tabular-nums", dd.current < 0 ? "text-down" : "text-up")}>{dd.current < 0 ? `${fmtV(dd.current, unit)} · ${daysShort(dd.currentDays)}` : t("risk.atPeak")}</dd></div>
          </dl>
        </div>
      )}
    </Panel>
  );
}

export function StreaksPanel({ ctx }: { ctx: Ctx }) {
  const { focus } = ctx;
  const { t } = officeI18n.useT();
  const s = focus.streaks;
  const tot = focus.totals;
  return (
    <Panel title={t("risk.streaksTitle")} icon={Flame} fill className="lg:col-span-4">
      <div className="flex flex-col gap-3">
        <div className="flex items-baseline gap-2">
          <span className={cn("text-3xl font-semibold tabular-nums", s.current > 0 ? "text-up" : s.current < 0 ? "text-down" : "text-muted-foreground")}>{Math.abs(s.current) || "—"}</span>
          <span className="text-sm text-muted-foreground">{s.current > 0 ? t("risk.streakGreenNow") : s.current < 0 ? t("risk.streakRedNow") : t("risk.streakNone")}</span>
        </div>
        <dl className="grid grid-cols-2 gap-2 text-xs">
          <div className="tile p-2.5"><dt className="text-muted-foreground">{t("risk.bestStreak")}</dt><dd className="text-sm font-semibold text-up">{daysShort(s.maxGreen)}</dd></div>
          <div className="tile p-2.5"><dt className="text-muted-foreground">{t("risk.worstStreak")}</dt><dd className="text-sm font-semibold text-down">{daysShort(s.maxRed)}</dd></div>
          <div className="tile p-2.5"><dt className="text-muted-foreground">{t("risk.greenDays")}</dt><dd className="text-sm font-semibold tabular-nums">{t("kpi.ofTotal", { value: tot.greenDays, total: tot.tradingDays })}</dd></div>
          <div className="tile p-2.5"><dt className="text-muted-foreground">{t("risk.avgDay")}</dt><dd className={cn("text-sm font-semibold tabular-nums", (tot.avgDay ?? 0) >= 0 ? "text-up" : "text-down")}>{fmtV(tot.avgDay, ctx.unit)}</dd></div>
        </dl>
      </div>
    </Panel>
  );
}

/** Histogram of daily office results of the focus year. */
export function DailyHistogram({ ctx }: { ctx: Ctx }) {
  const { focus, unit } = ctx;
  const { t } = officeI18n.useT();
  const bins = React.useMemo(() => {
    const vals = focus.days.map((d) => d.v);
    if (vals.length < 2) return [];
    const lim = Math.max(...vals.map(Math.abs)) || 1;
    const n = 8; // bins per side
    const step = lim / n;
    const out = Array.from({ length: n * 2 }, (_, i) => ({ from: -lim + i * step, to: -lim + (i + 1) * step, count: 0 }));
    for (const v of vals) { const i = Math.min(n * 2 - 1, Math.max(0, Math.floor((v + lim) / step))); out[i].count++; }
    return out;
  }, [focus]);
  const max = Math.max(1, ...bins.map((b) => b.count));
  const [hover, setHover] = React.useState<number | null>(null);
  const hb = hover != null ? bins[hover] : null;
  return (
    <Panel title={t("risk.histTitle")} description={t("risk.histDesc")} icon={Activity} fill className="lg:col-span-6">
      {!bins.length ? <EmptyState compact icon={Activity} title={t("risk.histFew")} /> : (
        <div className="flex flex-col gap-1">
          <div className="h-5 text-xs text-muted-foreground" aria-live="polite">{hb ? t("risk.histBin", { from: fmtV(hb.from, unit), to: fmtV(hb.to, unit), days: daysShort(hb.count) }) : commonI18n.t("units.tradingDays", { count: focus.days.length })}</div>
          <div className="flex h-36 items-end gap-[2px]" role="img" aria-label={t("risk.histAria")}>
            {bins.map((b, i) => (
              <span
                key={i}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                title={t("risk.histBin", { from: fmtV(b.from, unit), to: fmtV(b.to, unit), days: daysShort(b.count) })}
                className={cn("flex-1 rounded-t-[4px] transition-opacity", b.to <= 0 ? "bg-down/85" : "bg-up/85", hover != null && hover !== i && "opacity-50")}
                style={{ height: `${b.count ? Math.max(4, (b.count / max) * 100) : 0}%` }}
              />
            ))}
          </div>
          <div className="flex justify-between border-t border-border pt-1 text-2xs tabular-nums text-muted-foreground">
            <span>{fmtAxis(bins[0].from, unit)}</span><span>0</span><span>{fmtAxis(bins[bins.length - 1].to, unit)}</span>
          </div>
        </div>
      )}
    </Panel>
  );
}

export function BestWorstDays({ ctx, onPickDay }: { ctx: Ctx; onPickDay: (d: string) => void }) {
  const { focus, unit } = ctx;
  const { t } = officeI18n.useT();
  const sorted = [...focus.days].sort((a, b) => b.v - a.v);
  const best = sorted.filter((d) => d.v > 0).slice(0, 5);
  const worst = sorted.filter((d) => d.v < 0).reverse().slice(0, 5);
  const row = (d: DayPoint) => (
    <li key={d.date}>
      <button type="button" onClick={() => onPickDay(d.date)} className="tile tile-interactive press flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs">
        <span className="text-muted-foreground">{fmtDay(d.date)} · {trades(d.trades)}</span>
        <b className={cn("tabular-nums", d.v >= 0 ? "text-up" : "text-down")}>{fmtV(d.v, unit)}</b>
      </button>
    </li>
  );
  return (
    <Panel title={t("risk.bestWorstTitle")} description={t("risk.bestWorstDesc")} icon={Medal} fill className="lg:col-span-6">
      {!focus.days.length ? <EmptyState compact icon={Medal} title={t("states.noTradingDays")} /> : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div><p className="mb-1.5 text-xs font-medium text-up">{t("time.best")}</p><ul className="flex flex-col gap-1">{best.map(row)}</ul></div>
          <div><p className="mb-1.5 text-xs font-medium text-down">{t("time.worst")}</p><ul className="flex flex-col gap-1">{worst.length ? worst.map(row) : <li className="text-xs text-muted-foreground">{t("risk.noRedDays")}</li>}</ul></div>
        </div>
      )}
    </Panel>
  );
}
