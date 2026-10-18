import { useMemo, useState } from "react";
import type { Trade, PatternStat } from "@workspace/api-client-react";
import { BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { ArrowDown, ArrowUp, ChevronsUpDown, Download, Filter, Layers, Sparkles } from "lucide-react";
import { Panel, Segmented, FilterChip, EmptyState, Pill, TableScroll, toneOf } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { cn } from "@/lib/utils";
import {
  type AnalyticsFilters, type DimensionKey, type GroupRow, DIMENSIONS, breakdown, dimensionOf, drillValue, isEmptyKey, reliability,
  scopedTrades, downloadCsv, CHART_TOOLTIP_STYLE, CHART_CURSOR, AXIS, GRID,
} from "./metrics";
import { fmtPct, fmtR, fmtRate, fmtRatio, fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { analyticsI18n } from "@/i18n/ns/analytics";

/** Breakdowns shown as tabs; the rest sit in the «Ещё разрезы» select. */
const MAIN_DIMS: DimensionKey[] = ["horizon", "setup", "time", "weekday", "side", "ticker"];

type MetricKey = "avgR" | "totalR" | "winRate" | "totalPnl";
type SortKey = "natural" | "key" | "n" | "winRate" | "avgR" | "totalR" | "totalPnl" | "pf";

export function EdgeTab({
  trades,
  dimension,
  onDimensionChange,
  filters,
  onFiltersChange,
  hasR,
  hasPnl,
  topPatterns,
  isStaff = false,
}: {
  trades: Trade[];
  dimension: DimensionKey;
  onDimensionChange: (d: DimensionKey) => void;
  filters: AnalyticsFilters;
  onFiltersChange: (f: AnalyticsFilters) => void;
  hasR: boolean;
  hasPnl: boolean;
  topPatterns: PatternStat[] | undefined;
  /** The «Источник» (manual / broker) split is a staff concern — traders' trades all come from the broker. */
  isStaff?: boolean;
}) {
  const { t } = analyticsI18n.useT();
  const hasFees = useMemo(() => trades.some((tr) => tr.fees != null && Number(tr.fees) !== 0), [trades]);
  const [metric, setMetric] = useState<MetricKey>(hasR ? "avgR" : "winRate");
  const effMetric: MetricKey = (metric === "totalPnl" && !hasPnl) || ((metric === "avgR" || metric === "totalR") && !hasR) ? "winRate" : metric;
  const [hideSmall, setHideSmall] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "natural", dir: "desc" });

  const dim = dimensionOf(dimension);
  const allRows = useMemo(() => breakdown(trades, dimension), [trades, dimension]);
  const rows = useMemo(() => {
    const base = hideSmall ? allRows.filter((r) => r.n >= 3) : allRows;
    if (sort.key === "natural") return base;
    const val = (r: GroupRow): number | string => {
      switch (sort.key) {
        case "key": return r.label;
        case "n": return r.n;
        case "winRate": return r.winRate;
        case "avgR": return r.avgR ?? -Infinity;
        case "totalR": return r.rN ? r.totalR : -Infinity;
        case "totalPnl": return r.pnlN ? r.totalPnl : -Infinity;
        case "pf": return (hasR ? r.pfR : r.pfPnl) ?? -Infinity;
        default: return 0;
      }
    };
    return [...base].sort((a, b) => {
      const va = val(a), vb = val(b);
      const c = typeof va === "string" ? va.localeCompare(String(vb)) : (va as number) - (vb as number);
      return sort.dir === "asc" ? c : -c;
    });
  }, [allRows, hideSmall, sort, hasR]);

  const onlyEmptyGroup = allRows.length === 1 && isEmptyKey(allRows[0].key);
  const metricVal = (r: GroupRow): number | null =>
    effMetric === "winRate" ? r.winRate * 100 : effMetric === "avgR" ? r.avgR : effMetric === "totalR" ? (r.rN ? r.totalR : null) : (r.pnlN ? r.totalPnl : null);
  const chartData = rows.slice(0, 14).map((r) => ({ key: r.key, label: r.label, value: metricVal(r) ?? 0, n: r.n, wr: r.winRate, has: metricVal(r) != null }));
  const fmtMetric = (v: number) => (effMetric === "winRate" ? fmtPct(v, { decimals: 0, signed: false }) : effMetric === "totalPnl" ? fmtUsd(v, { signed: true, decimals: "auto" }) : fmtR(v));
  const positive = (v: number) => (effMetric === "winRate" ? v >= 50 : v >= 0);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: key === "key" ? "asc" : "desc" }));

  const drill = (rowKey: string) => {
    const v = drillValue(dimension, rowKey);
    if (!v || !dim.drill) return;
    onFiltersChange({ ...filters, [dim.drill]: v } as AnalyticsFilters);
  };

  const exportCsv = () => {
    downloadCsv(
      `analytics-${dimension}.csv`,
      [dim.label, t("edge.csv.trades"), t("edge.csv.winRate"), t("edge.csv.wrLow"), t("edge.csv.wrHigh"), t("edge.csv.avgR"), t("edge.csv.totalR"), t("edge.csv.gross"), t("edge.csv.fees"), t("edge.csv.net"), t("edge.csv.pf"), t("edge.csv.reliability")],
      rows.map((r) => [
        r.label, r.n, Math.round(r.winRate * 100), Math.round(r.wrLow * 100), Math.round(r.wrHigh * 100),
        r.avgR != null ? r.avgR.toFixed(2) : "", r.rN ? r.totalR.toFixed(2) : "", r.pnlN ? r.grossPnl.toFixed(2) : "", r.totalFees.toFixed(2), r.pnlN ? r.totalPnl.toFixed(2) : "",
        fmtRatio(hasR ? r.pfR : r.pfPnl), reliability(r.n).label,
      ]),
    );
  };

  const metricOptions = ([
    { value: "avgR", label: t("edge.metric.avgR"), disabled: !hasR },
    { value: "totalR", label: t("edge.metric.totalR"), disabled: !hasR },
    { value: "winRate", label: t("edge.metric.winRate") },
    ...(hasPnl ? [{ value: "totalPnl", label: t("edge.metric.totalPnl") }] : []),
  ] as { value: MetricKey; label: string; disabled?: boolean }[]);

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      {/* Choice overload (ARCHITECTURE §4a.6): the most used breakdowns as tabs, the other ~14 under «Ещё разрезы». */}
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<DimensionKey>
          ariaLabel={t("edge.dimensionAria")}
          size="sm"
          options={DIMENSIONS.filter((d) => MAIN_DIMS.includes(d.key)).map((d) => ({ value: d.key, label: d.label }))}
          value={MAIN_DIMS.includes(dimension) ? dimension : ("" as DimensionKey)}
          onChange={onDimensionChange}
        />
        <Select value={MAIN_DIMS.includes(dimension) ? "" : dimension} onValueChange={(v) => onDimensionChange(v as DimensionKey)}>
          <SelectTrigger aria-label={t("edge.moreDims")} className={cn("h-8 w-auto min-w-[150px] text-xs", !MAIN_DIMS.includes(dimension) && "border-primary/60 text-foreground")}>
            <SelectValue placeholder={t("edge.moreDims")} />
          </SelectTrigger>
          <SelectContent>
            {DIMENSIONS.filter((d) => !MAIN_DIMS.includes(d.key) && (isStaff || d.key !== "source")).map((d) => (
              <SelectItem key={d.key} value={d.key}>{d.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Panel
        icon={Layers}
        title={t("edge.title", { dim: dim.label })}
        description={[
          dim.scopeLabel ?? "",
          t("edge.groups", { count: allRows.length }),
          commonI18n.t("units.trades", { count: scopedTrades(trades, dimension).length }),
          dimension === "tag" ? t("edge.tagNote") : "",
        ].filter(Boolean).join(" · ")}
        actions={
          <>
            <Segmented<MetricKey> ariaLabel={t("edge.metricAria")} size="sm" options={metricOptions} value={effMetric} onChange={setMetric} />
            <FilterChip active={hideSmall} onClick={() => setHideSmall((v) => !v)} className="min-h-8 text-xs">
              {t("edge.minTrades")}
            </FilterChip>
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!rows.length}>
              <Download aria-hidden="true" /> CSV
            </Button>
          </>
        }
      >
        {rows.length === 0 ? (
          <EmptyState
            icon={Layers}
            title={t("edge.noGroups")}
            description={allRows.length === 0 && dim.emptyHint ? dim.emptyHint : t("edge.noGroupsHint")}
            className="py-8"
          />
        ) : (
          <div className="flex flex-col gap-5">
            {onlyEmptyGroup && dim.emptyHint && (
              <p className="rounded-xl bg-[hsl(var(--chart-3)/0.12)] px-3 py-2 text-sm text-foreground">{dim.emptyHint}</p>
            )}

            <div style={{ height: Math.max(120, chartData.length * 30 + 30) }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={GRID} horizontal={false} />
                  <XAxis
                    type="number"
                    {...AXIS}
                    domain={effMetric === "winRate" ? [0, 100] : ["auto", "auto"]}
                    tickFormatter={(v: number) => fmtMetric(v)}
                  />
                  <YAxis
                    type="category"
                    dataKey="label"
                    {...AXIS}
                    width={118}
                    tickFormatter={(v: string) => (v.length > 17 ? `${v.slice(0, 16)}…` : v)}
                  />
                  <ReferenceLine x={effMetric === "winRate" ? 50 : 0} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
                  <Tooltip
                    contentStyle={CHART_TOOLTIP_STYLE}
                    cursor={CHART_CURSOR}
                    formatter={(v: number, _n, item) => {
                      const d = item.payload as { n: number; wr: number; has: boolean };
                      return [d.has ? `${fmtMetric(v)} · ${commonI18n.t("units.trades", { count: d.n })} · WR ${fmtRate(d.wr)}` : `${t("edge.noData")} · ${commonI18n.t("units.trades", { count: d.n })}`, t(`edge.metric.${effMetric}`)];
                    }}
                  />
                  <Bar dataKey="value" radius={[0, 6, 6, 0]} barSize={16} isAnimationActive={false}>
                    {chartData.map((d) => (
                      <Cell
                        key={d.key}
                        fill={positive(d.value) ? "hsl(var(--up))" : "hsl(var(--down))"}
                        fillOpacity={d.n < 3 ? 0.4 : d.n < 20 ? 0.7 : 0.95}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <p className="-mt-3 text-xs text-muted-foreground">
              {t("edge.opacityNote")}
              {rows.length > 14 && ` ${t("edge.firstGroups", { count: rows.length })}`}
            </p>

            {/* Desktop table */}
            <TableScroll className="hidden lg:block">
              <table className="w-full text-sm tabular-nums">
                <thead className="sticky top-0 z-sticky bg-[var(--sticky-bg)]">
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <Th label={dim.label} k="key" sort={sort} onSort={toggleSort} />
                    <Th label={t("edge.colTrades")} k="n" sort={sort} onSort={toggleSort} right />
                    <Th label={t("edge.colWinRate")} k="winRate" sort={sort} onSort={toggleSort} />
                    <Th label={t("edge.metric.avgR")} k="avgR" sort={sort} onSort={toggleSort} right />
                    <Th label={t("edge.metric.totalR")} k="totalR" sort={sort} onSort={toggleSort} right />
                    {hasPnl && <Th label={t("edge.metric.totalPnl")} k="totalPnl" sort={sort} onSort={toggleSort} right />}
                    {hasFees && <th className="px-2 py-2 text-right font-normal">{t("edge.colFees")}</th>}
                    <Th label="PF" k="pf" sort={sort} onSort={toggleSort} right />
                    <th className="px-2 py-2 font-normal">{t("edge.colReliability")}</th>
                    {dim.drill && <th className="px-2 py-2"><span className="sr-only">{t("edge.colActions")}</span></th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const rel = reliability(r.n);
                    const pf = hasR ? r.pfR : r.pfPnl;
                    return (
                      <tr key={r.key} className="border-b border-border/60 last:border-0 hover:bg-[var(--glass-bg)]">
                        <td className="max-w-[220px] truncate px-2 py-2 font-medium text-foreground" title={r.label}>{r.label}</td>
                        <td className="px-2 py-2 text-right">
                          {r.n}
                          <span className="ml-1 text-2xs text-muted-foreground">{fmtRate(r.share)}</span>
                        </td>
                        <td className="px-2 py-2"><WinRateCell r={r} /></td>
                        <td className={cn("px-2 py-2 text-right font-medium", toneClass(r.avgR))}>{fmtR(r.avgR)}</td>
                        <td className={cn("px-2 py-2 text-right", toneClass(r.rN ? r.totalR : null))}>{r.rN ? fmtR(r.totalR, 1) : "—"}</td>
                        {hasPnl && (
                          <td className={cn("px-2 py-2 text-right", toneClass(r.pnlN ? r.totalPnl : null))} title={r.pnlN ? t("edge.beforeFees", { value: fmtUsd(r.grossPnl, { signed: true, decimals: "auto" }) }) : undefined}>
                            {r.pnlN ? fmtUsd(r.totalPnl, { signed: true, decimals: "auto" }) : "—"}
                          </td>
                        )}
                        {hasFees && <td className="px-2 py-2 text-right text-muted-foreground">{r.totalFees ? fmtUsd(-Math.abs(r.totalFees), { decimals: Math.abs(r.totalFees) >= 100 ? 0 : 2 }) : "—"}</td>}
                        <td className={cn("px-2 py-2 text-right", pf == null ? "text-muted-foreground" : pf >= 1 ? "text-up" : "text-down")}>{fmtRatio(pf)}</td>
                        <td className="px-2 py-2" title={rel.hint}>
                          <Pill tone={rel.level === "high" ? "up" : rel.level === "medium" ? "warn" : "neutral"}>{rel.label}</Pill>
                        </td>
                        {dim.drill && (
                          <td className="px-2 py-2 text-right">
                            {drillValue(dimension, r.key) && (
                              <Button variant="ghost" size="sm" onClick={() => drill(r.key)} aria-label={t("edge.showOnly", { key: r.label })} title={t("edge.applyFilter")}>
                                <Filter aria-hidden="true" />
                              </Button>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableScroll>

            {/* Mobile cards */}
            <ul className="flex flex-col gap-2 lg:hidden">
              {rows.map((r) => {
                const rel = reliability(r.n);
                return (
                  <li key={r.key} className="rounded-xl bg-[var(--glass-bg)] p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-sm font-medium text-foreground" title={r.label}>{r.label}</span>
                      <Pill tone={rel.level === "high" ? "up" : rel.level === "medium" ? "warn" : "neutral"}>{rel.label}</Pill>
                    </div>
                    <div className="mt-2 grid grid-cols-3 gap-2 text-xs tabular-nums">
                      <div><div className="text-muted-foreground">{t("edge.colTrades")}</div><div className="text-sm text-foreground">{r.n}</div></div>
                      <div><div className="text-muted-foreground">{t("edge.metric.winRate")}</div><div className={cn("text-sm", r.winRate >= 0.5 ? "text-up" : "text-down")}>{fmtRate(r.winRate)}</div></div>
                      <div><div className="text-muted-foreground">{t("edge.metric.avgR")}</div><div className={cn("text-sm", toneClass(r.avgR))}>{fmtR(r.avgR)}</div></div>
                    </div>
                    {dim.drill && drillValue(dimension, r.key) && (
                      <Button variant="outline" size="sm" className="mt-2 w-full" onClick={() => drill(r.key)}>
                        <Filter aria-hidden="true" /> {t("edge.showOnlyGroup")}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </Panel>

      {topPatterns && topPatterns.length > 0 && (
        <Panel icon={Sparkles} title={t("edge.patterns")} description={t("edge.patternsHint")}>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {topPatterns.slice(0, 9).map((p) => {
              const max = p.confidenceLevel <= 10 ? 10 : 100;
              return (
                <li key={p.patternName} className="rounded-xl bg-[var(--glass-bg)] px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-foreground" title={p.patternName}>{p.patternName}</span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">×{p.repeatCount}</span>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--glass-bg)]">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, (p.confidenceLevel / max) * 100)}%` }} />
                    </div>
                    <span className="text-xs tabular-nums text-muted-foreground">{p.confidenceLevel}/{max}</span>
                  </div>
                  {Number(p.avgPnl) !== 0 && (
                    <div className={cn("mt-1 text-xs tabular-nums", toneClass(Number(p.avgPnl)))}>{t("edge.avg", { value: fmtUsd(Number(p.avgPnl), { signed: true, decimals: "auto" }) })}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </Panel>
      )}
    </div>
  );
}

function toneClass(v: number | null | undefined) {
  const t = toneOf(v ?? null);
  return t === "up" ? "text-up" : t === "down" ? "text-down" : "text-muted-foreground";
}

function Th({
  label, k, sort, onSort, right,
}: {
  label: string;
  k: SortKey;
  sort: { key: SortKey; dir: "asc" | "desc" };
  onSort: (k: SortKey) => void;
  right?: boolean;
}) {
  const active = sort.key === k;
  const Icon = !active ? ChevronsUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th className={cn("px-2 py-2 font-normal", right && "text-right")} aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        onClick={() => onSort(k)}
        className={cn("inline-flex items-center gap-1 rounded-full px-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", active && "text-foreground")}
      >
        {label}
        <Icon className="h-3 w-3" aria-hidden="true" />
      </button>
    </th>
  );
}

/** Win rate with a 95% Wilson interval bar — wide bar = uncertain. */
function WinRateCell({ r }: { r: GroupRow }) {
  const { t } = analyticsI18n.useT();
  return (
    <div className="flex min-w-[150px] items-center gap-2" title={t("edge.ciTitle", { lo: fmtRate(r.wrLow), hi: fmtRate(r.wrHigh) })}>

      <span className={cn("w-10 text-right font-medium", r.winRate >= 0.5 ? "text-up" : "text-down")}>{fmtRate(r.winRate)}</span>
      <div className="relative h-1.5 flex-1 rounded-full bg-[var(--glass-bg)]" aria-hidden="true">
        <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
        <div
          className={cn("absolute inset-y-0 rounded-full", r.winRate >= 0.5 ? "bg-up/30" : "bg-down/30")}
          style={{ left: `${r.wrLow * 100}%`, width: `${Math.max(2, (r.wrHigh - r.wrLow) * 100)}%` }}
        />
        <div
          className={cn("absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full", r.winRate >= 0.5 ? "bg-up" : "bg-down")}
          style={{ left: `${r.winRate * 100}%` }}
        />
      </div>
    </div>
  );
}
