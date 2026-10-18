/**
 * Столбчатые кривые поведения: нетто по номеру сделки в дне, по минутам после убытка, по часу входа.
 */
import { useReducedMotion } from "framer-motion";
import { Bar, BarChart, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Segmented } from "@/components/ds";
import * as React from "react";
import { CHART_CURSOR, CHART_TOOLTIP } from "@/components/stats/equity-panel";
import { type Bucket } from "./api";
import { fmtRate, fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { behaviorI18n } from "@/i18n/ns/behavior";

const AXIS = { stroke: "hsl(var(--muted-foreground))", fontSize: 12, tickLine: false, axisLine: false } as const;

type Mode = "avg" | "sum";

export const BucketBars = React.memo(function BucketBars({ data, ariaLabel, height = 200 }: { data: Bucket[]; ariaLabel: string; height?: number }) {
  const reduce = useReducedMotion();
  const [mode, setMode] = React.useState<Mode>("avg");
  const rows = React.useMemo(() => data.map((b) => ({ ...b, value: mode === "avg" ? b.avgNet ?? 0 : b.net ?? 0 })), [data, mode]);
  const hasData = rows.some((r) => r.n > 0);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-end">
        <Segmented
          size="sm"
          ariaLabel={behaviorI18n.t("chart.modeAria", { label: ariaLabel })}
          value={mode}
          onChange={setMode}
          options={[{ value: "avg", label: behaviorI18n.t("chart.avg") }, { value: "sum", label: behaviorI18n.t("chart.sum") }]}
        />
      </div>
      {hasData ? (
        <div style={{ height }} role="img" aria-label={ariaLabel}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <XAxis dataKey="label" {...AXIS} interval={0} />
              <YAxis {...AXIS} width={52} tickFormatter={(v: number) => fmtUsd(v, { signed: true, compact: true }) === "—" ? "0" : fmtUsd(v, { signed: true, compact: true })} />
              <ReferenceLine y={0} stroke="hsl(var(--muted-foreground) / 0.5)" />
              <Tooltip
                contentStyle={CHART_TOOLTIP}
                cursor={CHART_CURSOR}
                formatter={(v: number, _n, item) => {
                  const b = item.payload as Bucket;
                  return [`${fmtUsd(v, { signed: true, decimals: "auto" })} · ${commonI18n.t("units.trades", { count: b.n })} · WR ${fmtRate(b.winRate)}`, mode === "avg" ? behaviorI18n.t("chart.avgNet") : behaviorI18n.t("chart.sumNet")];
                }}
              />
              <Bar dataKey="value" radius={[6, 6, 0, 0]} maxBarSize={40} isAnimationActive={!reduce}>
                {rows.map((r) => <Cell key={r.label} fill={r.value >= 0 ? "hsl(var(--up))" : "hsl(var(--down))"} fillOpacity={r.n ? 1 : 0.3} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="py-8 text-center text-sm text-muted-foreground">{behaviorI18n.t("chart.noData")}</p>

      )}
      <div className="grid gap-1 text-xs text-muted-foreground tabular-nums" style={{ gridTemplateColumns: `repeat(${rows.length}, minmax(0, 1fr))` }} aria-hidden="true">
        {rows.map((r) => <span key={r.label} className="truncate text-center">{r.n ? `n=${r.n}` : ""}</span>)}
      </div>
    </div>
  );
});
