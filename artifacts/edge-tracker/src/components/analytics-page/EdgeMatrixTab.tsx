import { useMemo, useState } from "react";
import { Grid3x3, RefreshCw } from "lucide-react";
import { Panel, Segmented, EmptyState, Pill, TableScroll, toneOf } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { type AnalyticsFilters, type Unit, wilson } from "./metrics";
import { fmtNum, fmtR, fmtRate, fmtRatio, fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { analyticsI18n } from "@/i18n/ns/analytics";
import {
  type EdgeCell, type EdgeDimension, EDGE_DIMENSIONS, edgeDimLabel, useEdgeMatrix, edgeKeyLabel, sortEdgeKeys,
} from "./edge-api";
import { bootstrapMeanCI, hashSeed, type BootstrapCI } from "./edge-stats";

type Metric = "expectancy" | "total" | "winRate" | "pf";
const METRICS: Metric[] = ["expectancy", "total", "winRate", "pf"];
const MIN_N_OPTIONS = [1, 3, 5, 10, 20] as const;

/** Literal class names so Tailwind emits them. Index = intensity 1–4. */
const UP_BG = ["", "bg-up/10", "bg-up/20", "bg-up/35", "bg-up/50"];
const DOWN_BG = ["", "bg-down/10", "bg-down/20", "bg-down/35", "bg-down/50"];

type CellStats = {
  cell: EdgeCell;
  n: number;
  winRate: number | null; wrLo: number; wrHi: number;
  expectancy: number | null; total: number; pf: number | null;
  ci: BootstrapCI | null;
};

function statsOf(cell: EdgeCell, unit: Unit, seed: number): CellStats {
  const decided = cell.wins + cell.losses;
  const [wrLo, wrHi] = decided ? wilson(cell.wins, decided) : [0, 0];
  const values = unit === "r" ? cell.rValues : cell.netValues;
  const n = unit === "r" ? cell.rN : cell.pnlN;
  const total = unit === "r" ? cell.sumR : cell.net;
  const pos = unit === "r" ? cell.posR : cell.posNet;
  const neg = unit === "r" ? cell.negR : cell.negNet;
  return {
    cell, n,
    winRate: decided ? cell.wins / decided : null, wrLo, wrHi,
    expectancy: n ? total / n : null, total,
    pf: neg < 0 ? pos / Math.abs(neg) : null,
    ci: values.length >= 5 ? bootstrapMeanCI(values, { iters: 600, seed }) : null,
  };
}

function metricValue(s: CellStats, m: Metric): number | null {
  if (m === "expectancy") return s.expectancy;
  if (m === "total") return s.n ? s.total : null;
  if (m === "winRate") return s.winRate;
  return s.pf;
}

function fmtMetric(v: number | null, m: Metric, unit: Unit): string {
  if (v == null) return "—";
  if (m === "winRate") return fmtRate(v);
  if (m === "pf") return fmtRatio(v);
  return unit === "r" ? fmtR(v, m === "total" ? 1 : 2) : fmtUsd(v, { signed: true, decimals: "auto" });
}

function intensity(v: number | null, m: Metric, scale: number): { cls: string; tone: "up" | "down" | "neutral" } {
  if (v == null) return { cls: "", tone: "neutral" };
  const centered = m === "winRate" ? v - 0.5 : m === "pf" ? Math.log(Math.max(v, 1e-6)) : v;
  if (Math.abs(centered) < 1e-9) return { cls: "", tone: "neutral" };
  const level = Math.min(4, Math.max(1, Math.ceil((Math.abs(centered) / Math.max(scale, 1e-9)) * 4)));
  return centered > 0 ? { cls: UP_BG[level], tone: "up" } : { cls: DOWN_BG[level], tone: "down" };
}

export function EdgeMatrixTab({
  filters, unit, hasR, hasPnl, isCurator,
}: {
  filters: AnalyticsFilters;
  unit: Unit | null;
  hasR: boolean;
  hasPnl: boolean;
  isCurator: boolean;
}) {
  const { t } = analyticsI18n.useT();
  const [rows, setRows] = useState<EdgeDimension>("setup");
  const [cols, setCols] = useState<EdgeDimension>("horizon");
  const [tod, setTod] = useState<15 | 30>(30);
  const [metric, setMetric] = useState<Metric>("expectancy");
  const [minN, setMinN] = useState<(typeof MIN_N_OPTIONS)[number]>(5);
  const [selected, setSelected] = useState<{ row: string; col: string } | null>(null);
  const u: Unit = unit ?? "r";

  const { data, isLoading, isError, refetch, isFetching } = useEdgeMatrix(filters, rows, cols, tod);
  const seed = useMemo(() => hashSeed(`${rows}|${cols}|${filters.trader}|${filters.period}`), [rows, cols, filters.trader, filters.period]);

  const grid = useMemo(() => {
    if (!data) return null;
    const stats = new Map<string, CellStats>();
    for (const c of data.cells) stats.set(`${c.row}\u0000${c.col}`, statsOf(c, u, seed));
    const rowKeys = sortEdgeKeys(data.rows, data.rowKeys);
    const colKeys = sortEdgeKeys(data.cols, data.colKeys);
    const values = [...stats.values()].filter((s) => s.n >= minN).map((s) => metricValue(s, metric)).filter((v): v is number => v != null);
    const centered = values.map((v) => (metric === "winRate" ? Math.abs(v - 0.5) : metric === "pf" ? Math.abs(Math.log(Math.max(v, 1e-6))) : Math.abs(v)));
    const scale = centered.length ? centered.sort((a, b) => a - b)[Math.floor(centered.length * 0.9)] || Math.max(...centered) : 1;
    const rowTotals = rowKeys.map((rk) => {
      const cells = data.cells.filter((c) => c.row === rk);
      const merged: EdgeCell = cells.reduce<EdgeCell>((a, c) => ({
        ...a, n: a.n + c.n, closed: a.closed + c.closed, wins: a.wins + c.wins, losses: a.losses + c.losses, be: a.be + c.be,
        sumR: a.sumR + c.sumR, rN: a.rN + c.rN, posR: a.posR + c.posR, negR: a.negR + c.negR, gross: a.gross + c.gross, net: a.net + c.net,
        fees: a.fees + c.fees, pnlN: a.pnlN + c.pnlN, posNet: a.posNet + c.posNet, negNet: a.negNet + c.negNet,
        rValues: a.rValues.concat(c.rValues).slice(0, 400), netValues: a.netValues.concat(c.netValues).slice(0, 400),
      }), { row: rk, col: "Σ", n: 0, closed: 0, wins: 0, losses: 0, be: 0, sumR: 0, rN: 0, posR: 0, negR: 0, gross: 0, net: 0, fees: 0, pnlN: 0, posNet: 0, negNet: 0, rValues: [], netValues: [] });
      return statsOf(merged, u, seed);
    });
    return { stats, rowKeys, colKeys, scale, rowTotals };
  }, [data, u, seed, minN, metric]);

  const sel = selected && grid ? grid.stats.get(`${selected.row}\u0000${selected.col}`) ?? null : null;
  const dims = EDGE_DIMENSIONS.filter((d) => isCurator || d !== "trader");
  // Plain render helper (not a nested component) so the Select keeps its identity between renders.
  const dimSelect = (value: EdgeDimension, onChange: (d: EdgeDimension) => void, label: string) => (
    <Select value={value} onValueChange={(v) => onChange(v as EdgeDimension)}>
      <SelectTrigger aria-label={label} className="h-8 w-auto min-w-[150px] text-xs"><SelectValue /></SelectTrigger>
      <SelectContent>{dims.map((d) => <SelectItem key={d} value={d}>{edgeDimLabel(d)}</SelectItem>)}</SelectContent>
    </Select>
  );

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title={t("matrix.title")}
        description={`${t("matrix.description", { unit: u === "r" ? "R" : t("unit.usdShort") })}${isFetching && !isLoading ? ` · ${t("matrix.updating")}` : ""}`}
        icon={Grid3x3}
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">{t("matrix.rows")}</span>
          {dimSelect(rows, setRows, t("matrix.rowsAria"))}
          <span className="text-xs text-muted-foreground">{t("matrix.cols")}</span>
          {dimSelect(cols, setCols, t("matrix.colsAria"))}
          {(rows === "tod" || cols === "tod") && (
            <Segmented<"15" | "30"> ariaLabel={t("matrix.step")} size="sm" options={[{ value: "15", label: t("matrix.min15") }, { value: "30", label: t("matrix.min30") }]} value={String(tod) as "15" | "30"} onChange={(v) => setTod(v === "15" ? 15 : 30)} />
          )}
          <Segmented<Metric> ariaLabel={t("matrix.metricAria")} size="sm" options={METRICS.map((m) => ({ value: m, label: t(`matrix.metric.${m}`) }))} value={metric} onChange={setMetric} />
          <div className="ml-auto flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">{t("matrix.minTrades")}</span>
            <Segmented<string> ariaLabel={t("matrix.minTradesAria")} size="sm" options={MIN_N_OPTIONS.map((n) => ({ value: String(n), label: String(n) }))} value={String(minN)} onChange={(v) => setMinN(Number(v) as (typeof MIN_N_OPTIONS)[number])} />
          </div>
        </div>

        {!hasR && !hasPnl && (
          <p className="mb-3 text-xs text-muted-foreground">{t("matrix.countOnly")}</p>
        )}

        {isError ? (
          <EmptyState icon={Grid3x3} title={t("matrix.loadError")} description={t("matrix.loadErrorHint")} action={<Button variant="outline" onClick={() => void refetch()}><RefreshCw aria-hidden="true" /> {commonI18n.t("actions.retry")}</Button>} />
        ) : isLoading || !grid ? (
          <Skeleton className="h-[260px] rounded-xl" />
        ) : grid.rowKeys.length === 0 ? (
          <EmptyState icon={Grid3x3} title={t("matrix.empty")} description={t("matrix.emptyHint")} />
        ) : (
          <TableScroll>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="sticky left-0 z-raised bg-[var(--sticky-bg)] px-2 py-1.5 text-left font-medium">{edgeDimLabel(rows)} ↓ / {edgeDimLabel(cols)} →</th>
                  {grid.colKeys.map((ck) => <th key={ck} className="px-2 py-1.5 text-center font-medium">{edgeKeyLabel(cols, ck, tod)}</th>)}
                  <th className="px-2 py-1.5 text-center font-semibold">Σ</th>
                </tr>
              </thead>
              <tbody>
                {grid.rowKeys.map((rk, ri) => (
                  <tr key={rk} className="border-t border-border/50">
                    <th scope="row" className="sticky left-0 z-raised max-w-[180px] truncate bg-[var(--sticky-bg)] px-2 py-1 text-left font-medium" title={edgeKeyLabel(rows, rk, tod)}>{edgeKeyLabel(rows, rk, tod)}</th>
                    {grid.colKeys.map((ck) => {
                      const s = grid.stats.get(`${rk}\u0000${ck}`);
                      if (!s) return <td key={ck} className="px-2 py-1 text-center text-muted-foreground/40">·</td>;
                      const guarded = s.n < minN;
                      const v = guarded ? null : metricValue(s, metric);
                      const { cls } = intensity(v, metric, grid.scale);
                      const active = selected?.row === rk && selected?.col === ck;
                      const ciText = s.ci ? ` · ${t("matrix.ci", { lo: fmtNum(s.ci.lo, { decimals: 2, signed: true }), hi: fmtNum(s.ci.hi, { decimals: 2, signed: true }) })}` : "";
                      return (
                        <td key={ck} className="p-0.5">
                          <button
                            type="button"
                            onClick={() => setSelected(active ? null : { row: rk, col: ck })}
                            title={`${t("matrix.cellTitle", { trades: commonI18n.t("units.trades", { count: s.cell.n }), wr: fmtRate(s.winRate), exp: fmtMetric(s.expectancy, "expectancy", u) })}${ciText}`}
                            className={cn(
                              "flex w-full min-w-[64px] flex-col items-center rounded-md px-2 py-1 tabular-nums transition-colors",
                              cls, guarded && "opacity-50", active && "ring-2 ring-primary",
                              "hover:ring-1 hover:ring-primary/50",
                            )}
                          >
                            <span className={cn("font-semibold", guarded && "text-muted-foreground")}>{guarded ? "—" : fmtMetric(v, metric, u)}</span>
                            <span className="text-2xs text-muted-foreground">{commonI18n.t("units.tradesShort", { count: s.cell.n })}{s.ci && !guarded && metric === "expectancy" ? (s.ci.significant ? " ✓" : "") : ""}</span>
                          </button>
                        </td>
                      );
                    })}
                    {(() => {
                      const s = grid.rowTotals[ri];
                      const v = s.n < minN ? null : metricValue(s, metric);
                      return (
                        <td className="px-2 py-1 text-center font-semibold tabular-nums">
                          <span className={cn(toneOf(metric === "winRate" ? (v == null ? null : v - 0.5) : metric === "pf" ? (v == null ? null : v - 1) : v) === "up" ? "text-up" : toneOf(v) === "down" ? "text-down" : "text-muted-foreground")}>{fmtMetric(v, metric, u)}</span>
                          <div className="text-2xs font-normal text-muted-foreground">{commonI18n.t("units.tradesShort", { count: s.cell.n })}</div>
                        </td>
                      );
                    })()}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
        <p className="mt-2 text-2xs text-muted-foreground">
          {t("matrix.footnote")}
        </p>
      </Panel>

      {sel && (
        <Panel title={`${edgeKeyLabel(rows, sel.cell.row, tod)} × ${edgeKeyLabel(cols, sel.cell.col, tod)}`} description={t("matrix.selDescription", { trades: commonI18n.t("units.trades", { count: sel.cell.n }), closed: sel.cell.closed, wins: sel.cell.wins, losses: sel.cell.losses, be: sel.cell.be })}>
          <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <Stat label="Win rate" value={fmtRate(sel.winRate)} hint={sel.winRate != null ? t("matrix.wrCi", { lo: fmtRate(sel.wrLo), hi: fmtRate(sel.wrHi) }) : t("matrix.noDecided")} tone={sel.winRate == null ? "neutral" : sel.winRate >= 0.5 ? "up" : "down"} />
            <Stat label={t("matrix.expectancy", { unit: u === "r" ? "R" : t("unit.usdShort") })} value={fmtMetric(sel.expectancy, "expectancy", u)} hint={sel.ci ? `${t("matrix.bootCi", { lo: fmtNum(sel.ci.lo, { signed: true }), hi: fmtNum(sel.ci.hi, { signed: true }) })}${sel.ci.significant ? ` · ${t("matrix.significant")}` : ""}` : t("matrix.ciFrom5")} tone={toneOf(sel.expectancy)} />
            <Stat label={t("matrix.total")} value={fmtMetric(sel.n ? sel.total : null, "total", u)} hint={u === "usd" ? t("matrix.grossFees", { gross: fmtUsd(sel.cell.gross, { signed: true, decimals: "auto" }), fees: fmtUsd(-Math.abs(sel.cell.fees), { decimals: 0 }) }) : t("matrix.withR", { count: sel.n })} tone={toneOf(sel.total)} />
            <Stat label="Profit factor" value={fmtRatio(sel.pf)} hint={sel.pf == null ? t("matrix.pfUndefined") : "Σ⁺ / |Σ⁻|"} tone={sel.pf == null ? "neutral" : sel.pf >= 1 ? "up" : "down"} />
          </div>
          {sel.cell.n < minN && <Pill tone="warn" className="mt-3">{t("matrix.fewTrades", { count: minN })}</Pill>}

        </Panel>
      )}
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone: "up" | "down" | "neutral" | "accent" | "warn" | "purple" }) {
  return (
    <div className="rounded-xl bg-[var(--glass-bg)] p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("text-lg font-semibold tabular-nums", tone === "up" ? "text-up" : tone === "down" ? "text-down" : "")}>{value}</div>
      {hint && <div className="text-2xs text-muted-foreground">{hint}</div>}
    </div>
  );
}
