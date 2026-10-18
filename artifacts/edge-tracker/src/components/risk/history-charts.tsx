import * as React from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { LineChart as LineIcon } from "lucide-react";
import { EmptyState, Pill, Segmented } from "@/components/ds";
import { Skeleton } from "@/components/ui/skeleton";
import { PeriodHint, usePeriodNav } from "@/lib/period-links";
import { useRiskHistory } from "./use-risk";
import { AXIS, CHART_TOOLTIP_STYLE, useStoredState } from "./primitives";
import { fmtDate, fmtR, fmtUsd } from "@/lib/format";
import { riskI18n } from "@/i18n/ns/risk";
import { commonI18n } from "@/i18n/ns/common";

const PERIODS = ["20", "60", "120", "250"] as const;
type Period = (typeof PERIODS)[number];

const shortDate = (d: string) => fmtDate(d.slice(0, 10), "dayMonthNumeric");

/** Equity, daily P&L and drawdown-from-peak for one trader. Falls back to R when trades have no $ P&L. */
export function HistoryCharts({ trader, compact = false }: { trader: string; compact?: boolean }) {
  const gid = "eq" + React.useId().replace(/[^a-zA-Z0-9]/g, "");
  const [period, setPeriod] = useStoredState<Period>("risk.history.period", "60", PERIODS);
  const q = useRiskHistory(trader, Number(period));
  const h = q.data;
  const { t } = riskI18n.useT();
  const c = commonI18n.t;
  const usd = h?.unit === "usd";
  const fmt = (v: number) => (usd ? fmtUsd(v, { signed: true, decimals: 0, compact: 10_000 }) : fmtR(v));

  const data = React.useMemo(
    () =>
      (h?.points ?? []).map((p) => ({
        date: p.date,
        equity: usd ? p.cum : p.cumR,
        day: usd ? p.pnl : p.r,
        dd: usd ? p.drawdown : p.drawdownR,
      })),
    [h, usd],
  );
  const ddLimit = usd && h?.limits?.maxDrawdown ? -h.limits.maxDrawdown : null;
  // Every point / bar is a trading day: click (or focus + ←/→ + Enter) opens its «Разбор дня».
  const nav = usePeriodNav({
    kind: "day",
    dates: data.map((d) => d.date),
    trader,
    label: t("history.navLabel"),
    describe: (i) => t("history.describe", { date: shortDate(data[i].date), day: data[i].day == null ? "—" : fmt(data[i].day), equity: fmt(data[i].equity) }),
  });
  const dayLabel = (l: unknown) => <>{typeof l === "string" ? fmtDate(l.slice(0, 10), "short") : String(l)}<PeriodHint kind="day" /></>;
  const chartH = compact ? 150 : 200;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Segmented
            ariaLabel={t("history.periodAria")}
            size="sm"
            value={period}
            onChange={setPeriod}
            options={PERIODS.map((p) => ({ value: p, label: c("time.daysShort", { count: Number(p) }) }))}
          />
          {h && !usd && <Pill tone="warn">{t("history.inR")}</Pill>}
        </div>
        {h && (
          <div className="flex flex-wrap gap-1.5">
            <Pill tone="up">{t("history.green", { count: h.stats.greenDays })}</Pill>
            <Pill tone="down">{t("history.red", { count: h.stats.redDays })}</Pill>
            {h.stats.redDayStreak >= 2 && <Pill tone="down" dot>{t("history.redStreak", { count: h.stats.redDayStreak })}</Pill>}
          </div>
        )}
      </div>

      {q.isLoading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="rounded-xl" style={{ height: chartH }} />
          <Skeleton className="h-24 rounded-xl" />
        </div>
      ) : q.isError ? (
        <p role="alert" className="text-sm text-down">{t("history.loadFailed", { error: (q.error as Error).message })}</p>
      ) : data.length === 0 ? (
        <EmptyState icon={LineIcon} title={t("history.emptyTitle")} description={t("history.emptyDesc")} className="py-8" />
      ) : (
        <div {...nav.wrapperProps} className={`flex flex-col gap-4 ${nav.wrapperProps.className}`}>
          <div>
            <div className="mb-1 flex items-baseline justify-between">
              <span className="micro-label">{t("history.equity")}</span>
              <span className="text-sm font-semibold tabular-nums">{fmt(data[data.length - 1].equity)}</span>
            </div>
            <div style={{ height: chartH }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} {...nav.chartProps}>
                  <defs>
                    <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--chart-1))" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="hsl(var(--chart-1))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={shortDate} {...AXIS} minTickGap={24} />
                  <YAxis {...AXIS} width={56} tickFormatter={(v: number) => (usd ? fmtUsd(v, { decimals: 0, compact: 10_000 }) : `${v}R`)} />
                  <Tooltip contentStyle={CHART_TOOLTIP_STYLE} labelFormatter={dayLabel} formatter={(v: number) => [fmt(v), t("history.equityTip")]} />
                  <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeOpacity={0.4} />
                  <Area type="monotone" dataKey="equity" stroke="hsl(var(--chart-1))" strokeWidth={2} fill={`url(#${gid})`} isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <span className="micro-label">{t("history.dayResult")}</span>
              <div className="mt-1" style={{ height: compact ? 100 : 120 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} {...nav.chartProps}>
                    <XAxis dataKey="date" hide />
                    <YAxis {...AXIS} width={56} tickFormatter={(v: number) => (usd ? fmtUsd(v, { decimals: 0, compact: 10_000 }) : `${v}R`)} />
                    <Tooltip contentStyle={CHART_TOOLTIP_STYLE} cursor={{ fill: "hsl(var(--muted-foreground) / 0.08)" }} labelFormatter={dayLabel} formatter={(v: number) => [v == null ? t("history.noUsd") : fmt(v), t("history.dayTip")]} />
                    <ReferenceLine y={0} stroke="hsl(var(--border))" />
                    <Bar dataKey="day" radius={[3, 3, 0, 0]} isAnimationActive={false}>
                      {data.map((d, i) => (
                        <Cell
                          key={d.date}
                          fill={(d.day ?? 0) >= 0 ? "hsl(var(--up))" : "hsl(var(--down))"}
                          fillOpacity={nav.active < 0 || nav.active === i ? 1 : 0.35}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div>
              <div className="flex items-baseline justify-between">
                <span className="micro-label">{t("history.ddTitle")}</span>
                {ddLimit != null && <span className="text-2xs text-muted-foreground">{t("history.ddLimit", { amount: fmtUsd(-ddLimit, { decimals: 0 }) })}</span>}
              </div>
              <div className="mt-1" style={{ height: compact ? 100 : 120 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} {...nav.chartProps}>
                    <XAxis dataKey="date" hide />
                    <YAxis {...AXIS} width={56} domain={[ddLimit != null ? Math.min(ddLimit * 1.1, 0) : "auto", 0]} tickFormatter={(v: number) => (usd ? fmtUsd(v, { decimals: 0, compact: 10_000 }) : `${v}R`)} />
                    <Tooltip contentStyle={CHART_TOOLTIP_STYLE} labelFormatter={dayLabel} formatter={(v: number) => [fmt(v), c("trading.drawdown")]} />
                    {ddLimit != null && <ReferenceLine y={ddLimit} stroke="hsl(var(--down))" strokeDasharray="4 3" />}
                    <Area type="stepAfter" dataKey="dd" stroke="hsl(var(--down))" fill="hsl(var(--down) / 0.18)" strokeWidth={1.5} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {nav.caption}

          {h && (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
              <div><dt className="text-xs text-muted-foreground">{t("history.best")}</dt><dd className="font-medium tabular-nums text-up">{h.stats.bestDay != null ? fmt(h.stats.bestDay) : "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{t("history.worst")}</dt><dd className="font-medium tabular-nums text-down">{h.stats.worstDay != null ? fmt(h.stats.worstDay) : "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{c("trading.maxDrawdown")}</dt><dd className="font-medium tabular-nums">{fmt(h.stats.maxDrawdown)}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{t("history.worstStreak")}</dt><dd className="font-medium tabular-nums">{c("time.daysShort", { count: h.stats.worstRedStreak })}</dd></div>
            </dl>
          )}
        </div>
      )}
    </div>
  );
}
