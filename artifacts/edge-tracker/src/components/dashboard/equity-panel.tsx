import { useMemo } from "react";
import { Link } from "wouter";
import { ChevronRight, LineChart as LineChartIcon, RefreshCw } from "lucide-react";
import { EmptyState, Panel, Segmented, toneOf, toneText } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EquityChart, fromDashboardDays } from "@/components/equity-chart";
import { KPI_FORMULAS } from "@/lib/trade-math";
import { cn } from "@/lib/utils";
import { shortDate } from "./fmt";
import { fmtR, fmtRate, fmtUsd } from "@/lib/format";
import type { DashboardEquity, EquityMetric, EquityPeriod } from "./use-dashboard";
import { commonI18n } from "@/i18n/ns/common";
import { dashboardI18n } from "@/i18n/ns/dashboard";
import { equityChartI18n } from "@/i18n/ns/equityChart";

/** Server windows of the curve; the engine's own zoom / navigator work inside the loaded one. Built in render (UI language). */
function periodOptions(): { value: EquityPeriod; label: string; title: string }[] {
  const t = dashboardI18n.t, p = equityChartI18n.t;
  // Short labels are the chart's presets (one vocabulary with EquityChart); titles name the server window exactly.
  return [
    { value: "week", label: p("presets.1w"), title: t("equity.period.week") },
    { value: "30d", label: p("presets.1m"), title: t("equity.period.30d") },
    { value: "90d", label: p("presets.3m"), title: t("equity.period.90d") },
    { value: "ytd", label: p("presets.ytd"), title: t("equity.period.ytd") },
    { value: "all", label: p("presets.all"), title: t("equity.period.all") },
  ];
}
const LONGER: Partial<Record<EquityPeriod, EquityPeriod>> = { week: "30d", "30d": "90d", "90d": "ytd", ytd: "all" };

function Stat({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="truncate text-sm font-medium tabular-nums">{children}</div>
    </div>
  );
}

/** Dashboard equity: total, the interactive curve (click a day → «Разбор дня»), four numbers. */
export function EquityPanel({
  data,
  isLoading,
  isError,
  onRetry,
  period,
  onPeriodChange,
  metric,
  onMetricChange,
  fill,
}: {
  data: DashboardEquity | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  period: EquityPeriod;
  onPeriodChange: (p: EquityPeriod) => void;
  metric: EquityMetric;
  onMetricChange: (m: EquityMetric) => void;
  fill?: boolean;
}) {
  const { t: td } = dashboardI18n.useT();
  const PERIOD_OPTIONS = periodOptions();
  const hasPnl = !!data?.hasPnl;
  // R only exists when trades have stops; without it the toggle is hidden entirely.
  const hasR = (data?.days ?? []).some((d) => d.r !== 0);
  const effMetric: EquityMetric = metric === "r" && hasR ? "r" : hasPnl ? "pnl" : hasR ? "r" : "pnl";
  const fmt = effMetric === "pnl" ? (v: number | null) => fmtUsd(v, { signed: true }) : (v: number | null) => fmtR(v);

  const days = useMemo(() => fromDashboardDays(data?.days ?? [], effMetric === "pnl" ? "net" : "r"), [data, effMetric]);

  const t = data?.totals;
  const total = effMetric === "pnl" ? (t?.pnl ?? 0) : (t?.r ?? 0);
  const best = effMetric === "pnl" ? (t?.bestNet?.pnl ?? null) : (t?.bestR?.r ?? null);
  const worst = effMetric === "pnl" ? (t?.worstNet?.pnl ?? null) : (t?.worstR?.r ?? null);
  const dd = effMetric === "pnl" && t?.maxDrawdownNet != null ? t.maxDrawdownNet : (t?.maxDrawdownR ?? 0);
  const longer = LONGER[period];

  return (
    <Panel
      title={effMetric === "pnl" ? td("equity.titleNet") : td("equity.titleR")}
      icon={LineChartIcon}
      fill={fill}
      actions={
        hasR && hasPnl ? (
          <Segmented<EquityMetric>
            ariaLabel={td("equity.unit")}
            size="sm"
            value={effMetric}
            onChange={onMetricChange}
            options={[
              { value: "pnl", label: "$" },
              { value: "r", label: "R" },
            ]}
          />
        ) : undefined
      }
      footer={
        <>
          <span>{data ? td("equity.range", { from: shortDate(data.from), to: shortDate(data.to) }) : " "}</span>
          <Link href="/analytics" className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline">
            {td("equity.allAnalytics")}
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </>
      }
    >
      {isLoading && !data ? (
        <div className="flex flex-1 flex-col gap-3" role="status" aria-label={commonI18n.t("states.loading")}>
          <Skeleton className="h-8 w-40 rounded-lg" />
          <Skeleton className="min-h-[240px] w-full flex-1 rounded-xl" />
          <div className="grid grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-9 rounded-lg" />
            ))}
          </div>
        </div>
      ) : isError && !data ? (
        <EmptyState
          compact
          title={td("equity.loadFailed")}
          action={
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RefreshCw aria-hidden="true" />
              {commonI18n.t("actions.retry")}
            </Button>
          }
        />
      ) : (
        <div className="flex flex-1 flex-col gap-3">
          {t && days.length > 0 && (
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span
                className={cn("text-2xl font-semibold tabular-nums tracking-tight", toneText(toneOf(total)))}
                title={effMetric === "pnl" ? KPI_FORMULAS.netPnl : undefined}
              >
                {fmt(total)}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {commonI18n.t("units.trades", { count: t.trades })} · {commonI18n.t("units.tradingDays", { count: t.tradingDays })}
                {effMetric === "pnl" && t.fees ? ` · ${td("equity.fees", { amount: fmtUsd(-Math.abs(t.fees), { signed: true }) })}` : ""}
              </span>
            </div>
          )}
          <EquityChart<EquityPeriod>
            days={days}
            unit={effMetric === "pnl" ? "net" : "r"}
            height="fill"
            storageKey="dashboard.equity"
            period={{ value: period, options: PERIOD_OPTIONS, onChange: onPeriodChange }}
            defaults={{ mode: "line", panes: { pnl: true, dd: false, nav: true, marks: true } }}
            showSummary={false}
            empty={
              <div className="flex flex-1 flex-col gap-3">
                <PeriodSwitch period={period} onChange={onPeriodChange} options={PERIOD_OPTIONS} />
                <div className="flex flex-1 items-center justify-center">
                  <EmptyState
                    compact
                    icon={LineChartIcon}
                    title={td(`equity.empty.${period}`)}
                    description={td("equity.emptyHint")}
                    action={
                      longer ? (
                        <Button variant="outline" size="sm" onClick={() => onPeriodChange(longer)}>
                          {td("equity.show", { period: (PERIOD_OPTIONS.find((o) => o.value === longer)?.title ?? "").toLowerCase() })}
                        </Button>
                      ) : undefined
                    }
                  />
                </div>
              </div>
            }
          />
          {t && days.length > 0 && (
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
              <Stat label="Win rate" title={KPI_FORMULAS.winRate}>
                {fmtRate(t.winRate)} <span className="text-xs font-normal text-muted-foreground">{t.wins}W / {t.losses}L</span>
              </Stat>
              <Stat label={td("equity.bestDay")} title={(effMetric === "pnl" ? t.bestNet?.date : t.bestR?.date) ?? undefined}>
                <span className={toneText(toneOf(best))}>{fmt(best)}</span>
              </Stat>
              <Stat label={td("equity.worstDay")} title={(effMetric === "pnl" ? t.worstNet?.date : t.worstR?.date) ?? undefined}>
                <span className={toneText(toneOf(worst))}>{fmt(worst)}</span>
              </Stat>
              <Stat label={td("equity.maxDd")} title={KPI_FORMULAS.maxDrawdown}>
                {/* A drawdown is a loss from the peak: «−$340», never «+$0.00». */}
                <span className={toneText(dd ? "down" : "neutral")}>{dd ? fmt(-Math.abs(dd)) : effMetric === "pnl" ? "$0" : "0R"}</span>
              </Stat>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

function PeriodSwitch({ period, onChange, options }: { period: EquityPeriod; onChange: (p: EquityPeriod) => void; options: { value: EquityPeriod; label: string; title: string }[] }) {
  return <Segmented<EquityPeriod> ariaLabel={dashboardI18n.t("equity.periodAria")} size="sm" value={period} onChange={onChange} options={options} className="self-start" />;
}
