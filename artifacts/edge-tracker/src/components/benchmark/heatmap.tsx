import { useState } from "react";
import { DataTable, Segmented } from "@/components/ds";
import { cn } from "@/lib/utils";
import type { BenchRow, MetricDef } from "./api";
import { fmtMetric, heatStyle, metricHint, metricLabel } from "./format";
import { commonI18n } from "@/i18n/ns/common";
import { benchmarkI18n } from "@/i18n/ns/benchmark";
import { personName } from "@/i18n";

type Mode = "value" | "pct";

/** Traders × metrics; colour = percentile inside the desk (green = best), text = value or percentile. */
export function BenchmarkHeatmap({ rows, metrics, median }: { rows: BenchRow[]; metrics: MetricDef[]; median: Record<string, number | null> }) {
  const { t } = benchmarkI18n.useT();
  const [mode, setMode] = useState<Mode>("value");
  const ranked = rows.filter((r) => r.qualified);
  if (!ranked.length) return <p className="py-8 text-center text-sm text-muted-foreground">{t("heatmap.noRanked")}</p>;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1"><span className="h-3 w-5 rounded" style={heatStyle(0)} aria-hidden="true" /> {t("heatmap.worst")}</span>
          <span className="inline-flex items-center gap-1"><span className="h-3 w-5 rounded" style={heatStyle(0.5)} aria-hidden="true" /> {t("heatmap.median")}</span>
          <span className="inline-flex items-center gap-1"><span className="h-3 w-5 rounded" style={heatStyle(1)} aria-hidden="true" /> {t("heatmap.best")}</span>
          <span className="inline-flex items-center gap-1"><span className="h-3 w-5 rounded" style={heatStyle(0.8, true)} aria-hidden="true" /> {t("heatmap.style")}</span>
        </div>
        <Segmented<Mode> size="sm" ariaLabel={t("heatmap.modeAria")} value={mode} onChange={setMode}
          options={[{ value: "value", label: t("heatmap.values") }, { value: "pct", label: t("heatmap.percentiles") }]} />
      </div>
      <DataTable stickyFirstCol maxHeight="70vh" ariaLabel={t("heatmap.aria")}>
        <table>
          <thead>
            <tr>
              <th scope="col">{t("heatmap.trader")}</th>
              {metrics.map((m) => (
                <th key={m.key} scope="col" className="text-center" title={`${metricHint(m)}${m.neutral ? t("heatmap.styleNote") : m.better === "lower" ? t("heatmap.lowerBetter") : ""}`}>
                  <span className={cn(m.neutral && "italic")}>{metricLabel(m)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ranked.map((r) => (
              <tr key={r.trader}>
                <td className="font-medium text-foreground">{personName(r.trader)}<div className="text-2xs font-normal text-muted-foreground">{commonI18n.t("units.tradesShort", { count: r.trades })}</div></td>
                {metrics.map((m) => {
                  const p = r.percentiles?.[m.key] ?? null;
                  const v = r[m.key] as number | null;
                  return (
                    <td key={m.key} className="!px-1.5 text-center text-xs" style={heatStyle(p, m.neutral)}
                      title={`${personName(r.trader)} · ${metricLabel(m)}: ${fmtMetric(m, v)}${p != null ? t("heatmap.percentile", { value: Math.round(p * 100) }) : ""}`}>
                      {p == null ? <span className="text-muted-foreground">—</span> : mode === "pct" ? Math.round(p * 100) : fmtMetric(m, v)}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr>
              <td className="text-xs text-muted-foreground">{t("heatmap.deskMedian")}</td>
              {metrics.map((m) => <td key={m.key} className="text-center text-xs text-muted-foreground">{fmtMetric(m, median[m.key])}</td>)}
            </tr>
          </tbody>
        </table>
      </DataTable>
      <p className="text-2xs text-muted-foreground">{t("heatmap.footnote")}</p>

    </div>
  );
}
