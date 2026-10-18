import * as React from "react";
import { Pill, toneOf } from "@/components/ds";
import { cn } from "@/lib/utils";
import type { MetricMeta, WindowMetrics } from "./use-scaling";
import { fmtMetric } from "./format";
import { fmtDate } from "@/lib/format";
import { scalingI18n } from "@/i18n/ns/scaling";

const ORDER = ["net_pnl", "net_r", "profit_factor", "win_rate", "expectancy_r", "trades", "green_weeks", "green_days_pct", "max_dd_usd", "max_dd_pct", "limit_breaches", "red_streak", "discipline", "rating_overall", "violations"];

/** Window metrics as compact tiles (value, note, colour by sign where it makes sense). */
export function MetricsGrid({ window: w, metrics, className }: { window: WindowMetrics | undefined; metrics: MetricMeta[]; className?: string }) {
  const { t } = scalingI18n.useT();
  const meta = React.useMemo(() => new Map(metrics.map((m) => [m.key, m])), [metrics]);
  if (!w) return null;
  const keys = ORDER.filter((k) => w.values[k]);
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{t("metrics.window", { count: w.windowDays, from: fmtDate(w.from, "dayMonth"), to: fmtDate(w.to, "dayMonth") })}</span>
        <Pill tone={w.hasMoney ? (w.moneySource === "propreports" ? "accent" : "neutral") : "warn"}>
          {w.hasMoney ? (w.moneySource === "propreports" ? t("metrics.moneyBroker") : t("metrics.moneyJournal")) : t("metrics.moneyNone")}
        </Pill>
      </div>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {keys.map((k) => {
          const m = meta.get(k);
          const v = w.values[k];
          const signed = m?.unit === "usd" || m?.unit === "r";
          const tone = v.value == null ? "neutral" : signed ? toneOf(v.value) : m && !m.higherIsBetter && v.value > 0 ? "warn" : "neutral";
          return (
            <div key={k} className="glass-panel flex flex-col gap-0.5 rounded-xl px-3 py-2" title={m?.hint}>
              <dt className="truncate text-2xs text-muted-foreground" title={m?.label ?? k}>{m?.label ?? k}</dt>
              <dd className={cn("text-lg font-semibold tabular-nums tracking-tight", tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "warn" ? "text-[hsl(var(--chart-3))]" : "text-foreground")}>
                {fmtMetric(m?.unit ?? "count", v.value)}
              </dd>
              {v.note && <span className="truncate text-2xs text-muted-foreground/80" title={v.note}>{v.note}</span>}
            </div>
          );
        })}
      </dl>
    </div>
  );
}
