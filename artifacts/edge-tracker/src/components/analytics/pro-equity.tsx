import { useMemo } from "react";
import { LineChart } from "lucide-react";
import { Panel, EmptyState } from "@/components/ds";
import { analyticsProI18n } from "@/i18n/ns/analyticsPro";
import { type Metric, type OhlcCandle } from "@/lib/analytics-pro";
import { EquityChart, fromOhlc } from "@/components/equity-chart";

/** Cumulative equity by day on the equity engine: candles (open/close of the day, wick = intraday extreme) or area. */
export function EquityPanel({ candles, metric }: { candles: OhlcCandle[]; metric: Metric }) {
  const days = useMemo(() => fromOhlc(candles), [candles]);
  return (
    <Panel
      icon={LineChart}
      title={analyticsProI18n.t("equity.title")}
      description={metric === "r" ? analyticsProI18n.t("equity.hintR") : analyticsProI18n.t("equity.hintPnl")}
    >
      {candles.length === 0 ? (
        <EmptyState icon={LineChart} title={analyticsProI18n.t("equity.empty")} description={analyticsProI18n.t("equity.emptyHint")} />

      ) : (
        <EquityChart days={days} unit={metric === "r" ? "r" : "net"} storageKey="analyticsPro.equity" height={400} />
      )}
    </Panel>
  );
}
