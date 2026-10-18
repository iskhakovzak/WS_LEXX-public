import { Lock } from "lucide-react";
import { EmptyState, Panel, Pill, StatCard, StatGrid, toneOf } from "@/components/ds";
import { cn } from "@/lib/utils";
import type { BenchmarkResponse } from "./api";
import { EquityLines } from "./charts";
import { SERIES_COLORS, fmtMetric, metricHint, metricLabel } from "./format";
import { fmtRate, fmtUsd } from "@/lib/format";
import { benchmarkI18n } from "@/i18n/ns/benchmark";
import { TrendView } from "./trend";

/** Trader mode: own metrics against the anonymised desk median (no other trader is named or shown). */
export function SelfView({ data }: { data: BenchmarkResponse }) {
  const { t } = benchmarkI18n.useT();
  const me = data.rows[0];
  if (!me) {
    return (
      <Panel>
        <EmptyState icon={Lock} title={t("self.empty")} description={t("self.emptyHint")} />
      </Panel>
    );
  }
  const strengths = me.badges.filter((b) => b.kind === "strength");
  const weaknesses = me.badges.filter((b) => b.kind === "weakness");
  return (
    <div className="flex flex-col gap-4">
      <StatGrid>
        <StatCard label={t("self.net")} value={me.net != null ? fmtUsd(me.net, { signed: true, decimals: "auto" }) : "—"} tone={toneOf(me.net)} hint={me.gross != null ? t("self.gross", { value: fmtUsd(me.gross, { signed: true, decimals: "auto" }) }) : undefined} />
        <StatCard label="Win rate" value={fmtRate(me.winRate)} hint={`${me.wins} W / ${me.losses} L`} />
        <StatCard label={t("self.green")} value={fmtRate(me.greenShare)} hint={t("self.ofDays", { value: me.greenDays, total: me.days })} />
        <StatCard label={t("self.bestDay")} value={me.bestDayShare != null ? fmtRate(me.bestDayShare) : "—"}
          tone={me.consistencyFlag === "breach" ? "down" : me.consistencyFlag === "warn" ? "warn" : "neutral"}
          hint={t("self.threshold", { warn: Math.round(data.rules.consistencyWarn * 100), breach: Math.round(data.rules.consistencyBreach * 100) })} />
      </StatGrid>
      <div className="grid gap-4 xl:grid-cols-[1fr_420px]">
        <Panel title={t("self.vsMedian")} description={t("self.vsMedianHint", { min: data.minTrades, traders: data.rules.medianMinTraders })} padded={false} bodyClassName="p-2">
          <div className="overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th className="px-3 py-2 text-left font-medium">{t("self.colMetric")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("self.colMe")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("self.colMedian")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("self.colPercentile")}</th>
              </tr>
            </thead>
            <tbody>
              {data.metrics.map((m) => {
                const v = me[m.key] as number | null;
                const med = data.median[m.key];
                const p = me.percentiles?.[m.key] ?? null;
                const better = v == null || med == null || m.neutral || v === med ? null : m.better === "higher" ? v > med : v < med;
                return (
                  <tr key={m.key} className="border-t border-border/50">
                    <td className="px-3 py-1.5 text-muted-foreground" title={metricHint(m)}>{metricLabel(m)}</td>
                    <td className={cn("px-3 py-1.5 text-right font-medium", better === true && "text-up", better === false && "text-down")}>{fmtMetric(m, v)}</td>
                    <td className="px-3 py-1.5 text-right text-muted-foreground">{fmtMetric(m, med)}</td>
                    <td className="px-3 py-1.5 text-right text-muted-foreground">{p == null || data.deskSize < data.rules.medianMinTraders ? "—" : Math.round(p * 100)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </Panel>
        <div className="flex flex-col gap-4">
          <Panel title={t("self.strengths")}>
            {me.badges.length === 0 ? <p className="text-sm text-muted-foreground">{t("self.noSignals")}</p> : (
              <div className="flex flex-col gap-2">
                {[...strengths, ...weaknesses].map((b) => (
                  <div key={b.kind + b.key} className="flex items-start gap-2">
                    <Pill tone={b.kind === "strength" ? "up" : "down"}>{b.kind === "strength" ? "▲" : "▼"} {b.label}</Pill>
                    <span className="text-xs text-muted-foreground">{b.detail}</span>
                  </div>
                ))}
              </div>
            )}
          </Panel>
          <Panel title={t("self.equity")}>
            <EquityLines height={200} series={[{ name: me.trader, color: SERIES_COLORS[0], unit: me.equityUnit, points: me.equity }]} />
          </Panel>
        </div>
      </div>
      <Panel title={t("self.myTrend")}>

        <TrendView trend={data.trend} />
      </Panel>
    </div>
  );
}
