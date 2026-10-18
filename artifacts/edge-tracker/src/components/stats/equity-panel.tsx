import { useMemo, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { LineChart as LineIcon } from "lucide-react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { EmptyState, Panel, Segmented } from "@/components/ds";
import { EquityChart, buildDayCandles, soleTrader, type EquityTradeInput } from "@/components/equity-chart";
import { fmtMetricCompact, fmtValue, type EquityPoint, type Metric } from "./metrics";
import { fmtMonth } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { statsI18n } from "@/i18n/ns/stats";

export const CHART_TOOLTIP = {
  backgroundColor: "hsl(var(--popover) / 0.92)",
  border: "1px solid hsl(var(--border))",
  color: "hsl(var(--popover-foreground))",
  borderRadius: 12,
  fontSize: 12,
  boxShadow: "0 8px 32px rgb(0 0 0 / 0.3)",
  backdropFilter: "blur(24px)",
} as const;
export const CHART_CURSOR = { fill: "hsl(var(--muted-foreground) / 0.08)" };
const AXIS = { stroke: "hsl(var(--muted-foreground))", fontSize: 11, tickLine: false, axisLine: false } as const;

/** "2026-10" → «окт 26» / «Oct 26». */
const monthLabel = (m: string) => {
  const i = Number(m.substring(5, 7)) - 1;
  return i >= 0 && i < 12 ? `${fmtMonth(i, "short").replace(".", "")} ${m.substring(2, 4)}` : m;
};

type View = "equity" | "monthly";

export function EquityPanel({
  equity, monthly, metric, trades, trader,
}: {
  equity: EquityPoint[];
  monthly: { month: string; value: number; count: number }[];
  metric: Metric;
  /** Trades of the period: when given, the curve is drawn on the equity engine (hover — day details, click — «Разбор дня»). */
  trades?: EquityTradeInput[];
  /** Trader for the day-report link (null / "all" — derived from the trades). */
  trader?: string | null;
}) {
  const { t } = statsI18n.useT();
  const [view, setView] = useState<View>("equity");
  const reduce = useReducedMotion();
  const unit = metric === "r" ? "R" : "$";
  const last = equity.at(-1)?.equity ?? null;
  const eqUnit = metric === "r" ? "r" : metric === "usd" ? "gross" : "net";
  const days = useMemo(() => (trades ? buildDayCandles(trades, eqUnit) : []), [trades, eqUnit]);

  return (
    <Panel
      title={view === "equity" ? t("equity.curve") : t("equity.monthly")}
      description={
        view === "equity"
          ? trades
            ? t("equity.hintDays", { unit })
            : t("equity.hintCurve", { unit })
          : t("equity.hintMonthly", { unit })
      }
      actions={
        <Segmented<View>
          size="sm"
          ariaLabel={t("equity.viewAria")}
          value={view}
          onChange={setView}
          options={[{ value: "equity", label: t("equity.viewCurve") }, { value: "monthly", label: t("equity.viewMonthly") }]}
        />
      }
    >
      {view === "equity" && trades ? (
        <EquityChart
          days={days}
          unit={eqUnit}
          trader={trader && trader !== "all" ? trader : soleTrader(trades)}
          storageKey="stats.equity"
          height={400}
        />
      ) : view === "equity" ? (
        equity.length >= 2 ? (
          <>
            <div className="mb-2 flex items-baseline gap-2">
              <span className={`text-lg font-semibold tabular-nums ${last != null && last < 0 ? "text-down" : "text-up"}`}>
                {fmtValue(last, metric)}
              </span>
              <span className="text-xs text-muted-foreground">{t("equity.overTrades", { count: equity.length, unit })}</span>
            </div>
            <div className="h-[240px]" role="img" aria-label={t("equity.aria", { value: fmtValue(last, metric) })}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={equity} margin={{ top: 6, right: 8, left: -12, bottom: 0 }}>
                  <defs>
                    <linearGradient id="statsEq" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--chart-1))" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="hsl(var(--chart-1))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="idx" {...AXIS} minTickGap={48} />
                  <YAxis {...AXIS} width={60} tickFormatter={(v: number) => fmtMetricCompact(v, metric) || "0"} />
                  <ReferenceLine y={0} stroke="hsl(var(--muted-foreground) / 0.5)" />
                  <Tooltip
                    contentStyle={CHART_TOOLTIP}
                    cursor={{ stroke: "hsl(var(--border))" }}
                    labelFormatter={(_l, payload) => (payload?.[0]?.payload as EquityPoint | undefined)?.label ?? ""}
                    formatter={(v: number, name: string) => [fmtValue(v, metric), name === "equity" ? t("equity.accumulated") : t("equity.drawdown")]}
                  />
                  <Area
                    type="monotone" dataKey="drawdown" stroke="hsl(var(--down))" strokeWidth={1}
                    fill="hsl(var(--down) / 0.18)" dot={false} isAnimationActive={!reduce}
                  />
                  <Area
                    type="monotone" dataKey="equity" stroke="hsl(var(--chart-1))" strokeWidth={2}
                    fill="url(#statsEq)" dot={false} isAnimationActive={!reduce}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5"><span className="h-2 w-3 rounded-full bg-chart-1" aria-hidden="true" />{t("equity.accumulated")}</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-2 w-3 rounded-full bg-down/40" aria-hidden="true" />{t("equity.drawdown")}</span>
            </div>
          </>
        ) : (
          <EmptyState
            icon={LineIcon}
            title={t("equity.few")}
            description={t("equity.fewHint", { unit: metric === "r" ? "R-multiple" : "P&L" })}
          />
        )
      ) : monthly.length > 0 ? (
        <div className="h-[268px]" role="img" aria-label={t("equity.monthlyAria")}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={monthly} margin={{ top: 6, right: 8, left: -12, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="month" {...AXIS} tickFormatter={monthLabel} />
              <YAxis {...AXIS} width={60} tickFormatter={(v: number) => fmtMetricCompact(v, metric) || "0"} />
              <ReferenceLine y={0} stroke="hsl(var(--muted-foreground) / 0.5)" />
              <Tooltip
                contentStyle={CHART_TOOLTIP}
                cursor={CHART_CURSOR}
                labelFormatter={(l: string) => monthLabel(l)}
                formatter={(v: number, _n, item) => [`${fmtValue(v, metric)} · ${commonI18n.t("units.tradesShort", { count: (item?.payload as { count: number }).count })}`, t("equity.result")]}
              />
              <Bar dataKey="value" radius={[6, 6, 0, 0]} maxBarSize={36} isAnimationActive={!reduce}>
                {monthly.map((m) => <Cell key={m.month} fill={m.value >= 0 ? "hsl(var(--up))" : "hsl(var(--down))"} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <EmptyState icon={LineIcon} title={t("equity.noMonthly")} description={metric === "r" ? t("equity.noMonthlyR") : t("equity.noMonthlyUsd")} />

      )}
    </Panel>
  );
}
