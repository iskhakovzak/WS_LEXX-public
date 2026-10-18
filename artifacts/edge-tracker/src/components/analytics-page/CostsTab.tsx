import { useMemo, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { Receipt, RefreshCw } from "lucide-react";
import { EmptyState, Panel, StatCard, StatGrid, Segmented, SortableTh, TableScroll, toneOf, useTableSort } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { type AnalyticsFilters, CHART_TOOLTIP_STYLE, CHART_CURSOR, AXIS, GRID } from "./metrics";
import { fmtCount, fmtNum, fmtRate, fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { analyticsI18n } from "@/i18n/ns/analytics";
import { whatIfI18n } from "@/i18n/ns/whatIf";
import { type EdgeCostGroup, type EdgeCostRow, useEdgeCosts, edgeKeyLabel } from "./edge-api";

/*
 * Fee / cost views over /api/edge/costs. The fee what-if job lives on /what-if: `CostsSummary` is the compact
 * gross → net strip of the analytics «Что если» tab, `CostsByGroup` (trader / account / month / setup / horizon,
 * slippage) is shown in the fee details of /what-if.
 */

const GROUPS: EdgeCostGroup[] = ["trader", "account", "month", "setup", "horizon"];
const groupLabel = (g: EdgeCostGroup) => analyticsI18n.t(`edgeDim.${g}`);
const cents = (v: number | null) => (v == null ? "—" : fmtNum(v * 100, { decimals: 2 }));

/** Gross → fees → net KPIs for the trades under the analytics filters. */
export function CostsSummary({ filters }: { filters: AnalyticsFilters }) {
  const { t } = analyticsI18n.useT();
  const { data, isLoading, isError, refetch } = useEdgeCosts(filters, "horizon");
  const tot = data?.total;
  if (isError) {
    return <EmptyState icon={Receipt} title={t("costs.loadError")} description={t("costs.loadErrorHint")} action={<Button variant="outline" onClick={() => void refetch()}><RefreshCw aria-hidden="true" /> {commonI18n.t("actions.retry")}</Button>} className="py-6" />;
  }
  if (isLoading || !data || !tot) return <StatGrid>{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-[96px] rounded-2xl" />)}</StatGrid>;
  if (tot.tradesWithPnl === 0) return <EmptyState icon={Receipt} title={t("costs.noPnl")} description={t("costs.noPnlHint")} className="py-6" />;
  return (
    <StatGrid>
      <StatCard label={t("costs.gross")} value={fmtUsd(tot.gross, { signed: true, decimals: "auto" })} tone={toneOf(tot.gross)} hint={t("costs.withPnl", { trades: commonI18n.t("units.trades", { count: tot.tradesWithPnl }) })} />
      <StatCard label={t("costs.fees")} value={tot.fees ? fmtUsd(-Math.abs(tot.fees), { decimals: 0 }) : "$0"} tone={tot.fees ? "down" : "neutral"} hint={tot.tradesWithFees ? t("costs.withFees", { trades: commonI18n.t("units.trades", { count: tot.tradesWithFees }) }) : t("costs.noFees")} />
      <StatCard label={t("costs.net")} value={fmtUsd(tot.net, { signed: true, decimals: "auto" })} tone={toneOf(tot.net)} hint={t("costs.netHint")} />
      <StatCard label={t("costs.eaten")} value={fmtRate(tot.feePctOfGrossWins, 1)} tone={tot.feePctOfGrossWins == null ? "neutral" : tot.feePctOfGrossWins > 0.3 ? "down" : tot.feePctOfGrossWins > 0.15 ? "warn" : "up"} hint={tot.feePctOfGrossWins == null ? t("costs.noWinners") : t("costs.eatenHint", { value: fmtRate(tot.feePctOfGross, 1) })} />
      <StatCard label={t("costs.perTradeShare")} value={`${fmtUsd(tot.feePerTrade != null ? Math.abs(tot.feePerTrade) : null)} · ${tot.feePerShare != null ? `${cents(tot.feePerShare)}¢` : "—"}`} hint={tot.shares ? t("costs.shares", { count: fmtCount(Math.round(tot.shares)) }) : t("costs.noQty")} />
      <StatCard label={t("costs.slippage")} value={tot.slippageAvg != null ? fmtNum(tot.slippageAvg, { decimals: 2 }) : "—"} hint={tot.slippageN ? t("costs.slippageHint", { count: tot.slippageN, sum: fmtNum(tot.slippageSum, { decimals: 2 }) }) : t("costs.noSlippage")} />
    </StatGrid>
  );
}

/** Gross vs net by trader / account / month / setup / horizon, with slippage (staff see the trader split). */
export function CostsByGroup({ filters, isCurator }: { filters: AnalyticsFilters; isCurator: boolean }) {
  const { t } = whatIfI18n.useT();
  const [group, setGroup] = useState<EdgeCostGroup>(isCurator ? "trader" : "month");
  const { data, isLoading, isError, refetch } = useEdgeCosts(filters, group);
  const groups = GROUPS.filter((g) => isCurator || g !== "trader");
  return (
    <Panel title={t("fees.byGroupTitle")} description={t("fees.byGroupHint")} icon={Receipt} padded={false} bodyClassName="p-2 sm:p-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented<EdgeCostGroup> ariaLabel={t("fees.groupAria")} size="sm" options={groups.map((g) => ({ value: g, label: groupLabel(g) }))} value={group} onChange={setGroup} />
      </div>
      {isError ? (
        <EmptyState icon={Receipt} title={t("fees.byGroupError")} action={<Button variant="outline" onClick={() => void refetch()}><RefreshCw aria-hidden="true" /> {commonI18n.t("actions.retry")}</Button>} className="py-6" />
      ) : isLoading || !data ? (
        <Skeleton className="h-[240px] rounded-xl" />
      ) : data.items.length === 0 ? (
        <p className="px-3 py-6 text-center text-sm text-muted-foreground">{commonI18n.t("states.noData")}</p>
      ) : (
        <>
          <div className="h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.items.map((r) => ({ key: edgeKeyLabel(group, r.key, 30), gross: r.gross, net: r.net, fees: -r.fees }))} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="key" {...AXIS} interval={0} angle={data.items.length > 8 ? -20 : 0} height={data.items.length > 8 ? 48 : 24} />
                <YAxis {...AXIS} tickFormatter={(v: number) => fmtUsd(v, { signed: true, decimals: "auto" })} width={64} />
                <Tooltip contentStyle={CHART_TOOLTIP_STYLE} cursor={CHART_CURSOR} formatter={(v: number) => fmtUsd(v, { signed: true, decimals: "auto" })} />
                <ReferenceLine y={0} stroke={GRID} />
                <Bar isAnimationActive={false} dataKey="gross" name={t("fees.gross")} fill="hsl(var(--muted-foreground) / 0.45)" radius={[4, 4, 0, 0]} />
                <Bar isAnimationActive={false} dataKey="net" name={t("fees.net")} fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                <Bar isAnimationActive={false} dataKey="fees" name={t("fees.fees")} fill="hsl(var(--down))" radius={[0, 0, 4, 4]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <CostsTable key={group} group={group} items={data.items} />
          <p className="mt-2 px-1 text-2xs text-muted-foreground">{t("fees.byGroupNote")}</p>
        </>
      )}
    </Panel>
  );
}

type CostRow = EdgeCostRow & { order: number; label: string };
const COST_ACCESSORS = {
  // Hidden key: server order (chronological for months, natural for horizons).
  order: (r: CostRow) => r.order,
  key: (r: CostRow) => r.label,
  trades: (r: CostRow) => r.tradesWithPnl,
  gross: (r: CostRow) => r.gross,
  fees: (r: CostRow) => r.fees,
  net: (r: CostRow) => r.net,
  feePct: (r: CostRow) => r.feePctOfGrossWins,
  perTrade: (r: CostRow) => r.feePerTrade,
  perShare: (r: CostRow) => r.feePerShare,
  slippage: (r: CostRow) => r.slippageAvg,
} as const;

const TH = "px-2 py-1.5 font-medium";

/** Gross vs net per group; sortable headers (months / horizons keep their natural order until a header is clicked). */
function CostsTable({ group, items }: { group: EdgeCostGroup; items: EdgeCostRow[] }) {
  const { t } = whatIfI18n.useT();
  const indexed = useMemo(() => items.map((r, order) => ({ ...r, order, label: edgeKeyLabel(group, r.key, 30) })), [items, group]);
  const natural = group === "month" || group === "horizon";
  const { rows, thProps } = useTableSort(indexed, COST_ACCESSORS, natural ? "order" : "net", natural ? "asc" : "desc");
  return (
    <TableScroll className="mt-3">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted-foreground">
            <SortableTh {...thProps("key")} className={cn(TH, "text-left")}>{groupLabel(group)}</SortableTh>
            <SortableTh {...thProps("trades")} align="right" className={TH}>{t("fees.colTrades")}</SortableTh>
            <SortableTh {...thProps("gross")} align="right" className={TH}>{t("fees.gross")}</SortableTh>
            <SortableTh {...thProps("fees")} align="right" className={TH}>{t("fees.fees")}</SortableTh>
            <SortableTh {...thProps("net")} align="right" className={TH}>{t("fees.net")}</SortableTh>
            <SortableTh {...thProps("feePct")} align="right" className={TH}><span title={t("fees.pctOfProfitTitle")}>{t("fees.pctOfProfit")}</span></SortableTh>
            <SortableTh {...thProps("perTrade")} align="right" className={TH}>{t("fees.perTradeCol")}</SortableTh>
            <SortableTh {...thProps("perShare")} align="right" className={TH}>{t("fees.perShare")}</SortableTh>
            <SortableTh {...thProps("slippage")} align="right" className={TH}><span title={t("fees.slippageTitle")}>{t("fees.slippage")}</span></SortableTh>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-border/50 tabular-nums">
              <td className="max-w-[200px] truncate px-2 py-1.5 font-medium" title={r.label}>{r.label}</td>
              <td className="px-2 py-1.5 text-right text-muted-foreground">{r.tradesWithPnl}<span className="text-muted-foreground/60"> / {r.trades}</span></td>
              <td className={cn("px-2 py-1.5 text-right", toneOf(r.gross) === "up" ? "text-up" : toneOf(r.gross) === "down" ? "text-down" : "text-muted-foreground")}>{fmtUsd(r.gross, { signed: true, decimals: "auto" })}</td>
              <td className="px-2 py-1.5 text-right text-muted-foreground">{r.fees ? fmtUsd(-Math.abs(r.fees), { decimals: Math.abs(r.fees) >= 100 ? 0 : 2 }) : "—"}</td>
              <td className={cn("px-2 py-1.5 text-right font-medium", toneOf(r.net) === "up" ? "text-up" : toneOf(r.net) === "down" ? "text-down" : "text-muted-foreground")}>{fmtUsd(r.net, { signed: true, decimals: "auto" })}</td>
              <td className={cn("px-2 py-1.5 text-right", r.feePctOfGrossWins != null && r.feePctOfGrossWins > 0.3 ? "text-down" : "text-muted-foreground")}>{fmtRate(r.feePctOfGrossWins, 1)}</td>
              <td className="px-2 py-1.5 text-right text-muted-foreground">{fmtUsd(r.feePerTrade != null ? Math.abs(r.feePerTrade) : null)}</td>
              <td className="px-2 py-1.5 text-right text-muted-foreground">{cents(r.feePerShare)}</td>
              <td className="px-2 py-1.5 text-right text-muted-foreground">{r.slippageAvg != null ? fmtNum(r.slippageAvg, { decimals: 2 }) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}
