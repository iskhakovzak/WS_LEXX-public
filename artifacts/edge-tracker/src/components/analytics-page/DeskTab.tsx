import { useMemo, useState } from "react";
import { Users, RefreshCw } from "lucide-react";
import { Panel, EmptyState, Pill, SortableTh, TableScroll, toneOf, useTableSort } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { type AnalyticsFilters, type Unit } from "./metrics";
import { fmtR, fmtRate, fmtRatio, fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { analyticsI18n } from "@/i18n/ns/analytics";
import { personName } from "@/i18n";
import { useEdgeMatrix, type EdgeCell } from "./edge-api";
import { percentileRank, maxDrawdownOf, quantile } from "./edge-stats";

type TraderRow = {
  trader: string; n: number; closed: number;
  winRate: number | null; expectancy: number | null; total: number; pf: number | null; maxDd: number | null; avgWin: number | null; avgLoss: number | null;
};

function rowOf(c: EdgeCell, u: Unit): TraderRow {
  const decided = c.wins + c.losses;
  const n = u === "r" ? c.rN : c.pnlN;
  const total = u === "r" ? c.sumR : c.net;
  const pos = u === "r" ? c.posR : c.posNet, neg = u === "r" ? c.negR : c.negNet;
  const values = u === "r" ? c.rValues : c.netValues;
  return {
    trader: c.row, n: c.n, closed: c.closed,
    winRate: decided ? c.wins / decided : null,
    expectancy: n ? total / n : null, total,
    pf: neg < 0 ? pos / Math.abs(neg) : null,
    maxDd: values.length ? maxDrawdownOf(values) : null,
    avgWin: c.wins ? pos / c.wins : null,
    avgLoss: c.losses ? neg / c.losses : null,
  };
}

/** Below this many closed trades a row is a small sample: listed after the rest by default and greyed out. */
const MIN_N = 5;

const DESK_ACCESSORS = {
  // Hidden default: reliable samples first; ties keep the expectancy-desc pre-sort.
  rank: (r: TraderRow) => (r.closed >= MIN_N ? 0 : 1),
  trader: (r: TraderRow) => personName(r.trader),
  closed: (r: TraderRow) => r.closed,
  winRate: (r: TraderRow) => r.winRate,
  expectancy: (r: TraderRow) => r.expectancy,
  pf: (r: TraderRow) => r.pf,
  total: (r: TraderRow) => r.total,
  maxDd: (r: TraderRow) => r.maxDd,
} as const;
const TH = "px-2 py-1.5 font-medium";

type MetricKey = "expectancy" | "winRate" | "pf" | "total" | "avgWin" | "avgLoss" | "maxDd" | "closed";
type MetricDef = { key: MetricKey; fmt: (v: number | null, u: Unit) => string; higherIsBetter: boolean };
const METRICS: MetricDef[] = [
  { key: "expectancy", fmt: (v, u) => (u === "r" ? fmtR(v) : fmtUsd(v, { signed: true, decimals: "auto" })), higherIsBetter: true },
  { key: "winRate", fmt: (v) => fmtRate(v), higherIsBetter: true },
  { key: "pf", fmt: (v) => fmtRatio(v), higherIsBetter: true },
  { key: "total", fmt: (v, u) => (u === "r" ? fmtR(v, 1) : fmtUsd(v, { signed: true, decimals: "auto" })), higherIsBetter: true },
  { key: "avgWin", fmt: (v, u) => (u === "r" ? fmtR(v) : fmtUsd(v, { signed: true, decimals: "auto" })), higherIsBetter: true },
  { key: "avgLoss", fmt: (v, u) => (u === "r" ? fmtR(v) : fmtUsd(v, { signed: true, decimals: "auto" })), higherIsBetter: true },
  { key: "maxDd", fmt: (v, u) => (u === "r" ? fmtR(v, 1) : fmtUsd(v, { signed: true, decimals: "auto" })), higherIsBetter: true },
  { key: "closed", fmt: (v) => (v == null ? "—" : String(v)), higherIsBetter: true },
];

export function DeskTab({ filters, unit }: { filters: AnalyticsFilters; unit: Unit | null }) {
  const { t } = analyticsI18n.useT();
  const u: Unit = unit ?? "r";
  const deskFilters = useMemo(() => ({ ...filters, trader: "" }), [filters]);
  const { data, isLoading, isError, refetch } = useEdgeMatrix(deskFilters, "trader", "trader", 30);
  const rows = useMemo(() => (data ? data.cells.map((c) => rowOf(c, u)).sort((a, b) => (b.expectancy ?? -1e9) - (a.expectancy ?? -1e9)) : []), [data, u]);
  const [picked, setPicked] = useState<string>("");
  const { rows: sorted, thProps } = useTableSort(rows, DESK_ACCESSORS, "rank", "asc");
  const focus = rows.find((r) => r.trader === (picked || filters.trader)) ?? rows[0];

  if (isError) return <Panel><EmptyState icon={Users} title={t("desk.loadError")} action={<Button variant="outline" onClick={() => void refetch()}><RefreshCw aria-hidden="true" /> {commonI18n.t("actions.retry")}</Button>} /></Panel>;
  if (isLoading || !data) return <Skeleton className="h-[360px] rounded-2xl" />;
  if (rows.length < 2 || !focus) return <Panel><EmptyState icon={Users} title={t("desk.alone")} description={t("desk.aloneHint")} /></Panel>;

  const minN = MIN_N;
  const population = (key: MetricDef["key"]) => rows.filter((r) => r.closed >= minN).map((r) => r[key]).filter((v): v is number => v != null);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Panel title={t("desk.vsTitle")} description={t("desk.vsHint", { traders: commonI18n.t("units.traders", { count: rows.length }), min: minN })} icon={Users}>
        <Select value={focus.trader} onValueChange={setPicked}>
          <SelectTrigger aria-label={t("filters.trader")} className="mb-3 h-9 w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{rows.map((r) => <SelectItem key={r.trader} value={r.trader}>{personName(r.trader)} · {commonI18n.t("units.trades", { count: r.closed })}</SelectItem>)}</SelectContent>
        </Select>
        <ul className="flex flex-col gap-2">
          {METRICS.map((m) => {
            const v = focus[m.key];
            const pop = population(m.key);
            const pr = v == null ? null : percentileRank(v, pop);
            const med = pop.length ? quantile(pop, 0.5) : null;
            const good = pr == null ? null : pr >= 67 ? "up" : pr >= 34 ? "neutral" : "down";
            return (
              <li key={m.key} className="rounded-xl bg-[var(--glass-bg)] px-3 py-2">
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>{t(`desk.metric.${m.key}`)}</span>
                  {pr != null && <Pill tone={good === "up" ? "up" : good === "down" ? "down" : "neutral"}>{t("desk.percentile", { value: pr })}</Pill>}
                </div>
                <div className="mt-0.5 flex items-baseline justify-between gap-2 tabular-nums">
                  <span className={cn("text-base font-semibold", good === "up" ? "text-up" : good === "down" ? "text-down" : "")}>{m.fmt(v, u)}</span>
                  <span className="text-xs text-muted-foreground">{t("desk.deskMedian", { value: m.fmt(med, u) })}</span>
                </div>
                {pr != null && (
                  <div className="mt-1.5 h-1.5 w-full rounded-full bg-border/60" aria-hidden="true">
                    <div className={cn("h-full rounded-full", good === "up" ? "bg-up" : good === "down" ? "bg-down" : "bg-muted-foreground/50")} style={{ width: `${pr}%` }} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {focus.closed < minN && <p className="mt-2 text-2xs text-muted-foreground">{t("desk.fewFocus", { min: minN })}</p>}
      </Panel>

      <Panel title={t("desk.allTitle")} description={t("desk.allHint", { unit: u === "r" ? "R" : t("unit.usdShort") })} className="lg:col-span-2">
        <TableScroll>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground">
                <SortableTh {...thProps("trader")} className={cn(TH, "text-left")}>{t("filters.trader")}</SortableTh>
                <SortableTh {...thProps("closed")} align="right" className={TH}>{t("desk.colTrades")}</SortableTh>
                <SortableTh {...thProps("winRate")} align="right" className={TH}>Win rate</SortableTh>
                <SortableTh {...thProps("expectancy")} align="right" className={TH}>{t("desk.colExpectancy")}</SortableTh>
                <SortableTh {...thProps("pf")} align="right" className={TH}>PF</SortableTh>
                <SortableTh {...thProps("total")} align="right" className={TH}>{t("desk.colTotal")}</SortableTh>
                <SortableTh {...thProps("maxDd")} align="right" className={TH}>{t("desk.colDd")}</SortableTh>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const isFocus = r.trader === focus.trader;
                const tc = (v: number | null) => (toneOf(v) === "up" ? "text-up" : toneOf(v) === "down" ? "text-down" : "text-muted-foreground");
                return (
                  <tr key={r.trader} className={cn("border-t border-border/50 tabular-nums", isFocus && "bg-primary/5", r.closed < minN && "text-muted-foreground")}>
                    <td className="px-2 py-1.5 font-medium">
                      <button type="button" className="hover:underline" onClick={() => setPicked(r.trader)}>{personName(r.trader)}</button>
                      {r.closed < minN && <span className="ml-1 text-2xs text-muted-foreground">{t("desk.few")}</span>}
                    </td>
                    <td className="px-2 py-1.5 text-right">{r.closed}<span className="text-muted-foreground/60"> / {r.n}</span></td>
                    <td className={cn("px-2 py-1.5 text-right", r.winRate == null ? "text-muted-foreground" : r.winRate >= 0.5 ? "text-up" : "text-down")}>{fmtRate(r.winRate)}</td>
                    <td className={cn("px-2 py-1.5 text-right font-medium", tc(r.expectancy))}>{u === "r" ? fmtR(r.expectancy) : fmtUsd(r.expectancy, { signed: true, decimals: "auto" })}</td>
                    <td className={cn("px-2 py-1.5 text-right", r.pf == null ? "text-muted-foreground" : r.pf >= 1 ? "text-up" : "text-down")}>{fmtRatio(r.pf)}</td>
                    <td className={cn("px-2 py-1.5 text-right", tc(r.total))}>{u === "r" ? fmtR(r.total, 1) : fmtUsd(r.total, { signed: true, decimals: "auto" })}</td>
                    <td className="px-2 py-1.5 text-right text-muted-foreground">{u === "r" ? fmtR(r.maxDd, 1) : fmtUsd(r.maxDd, { signed: true, decimals: "auto" })}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
        <p className="mt-2 text-2xs text-muted-foreground">{t("desk.footnote")}</p>

      </Panel>
    </div>
  );
}
