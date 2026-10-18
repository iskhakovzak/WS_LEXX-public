/**
 * Матрицы «сетап × час входа» и «сетап × время удержания»: где сетап работает, а где сливает.
 * Цвет — нетто (зелёный / красный, насыщенность по модулю); ячейки с n < 5 приглушены — выводы ненадёжны.
 */
import * as React from "react";
import { Grid3x3 } from "lucide-react";
import { EmptyState, Segmented } from "@/components/ds";
import { cn } from "@/lib/utils";
import { type MatrixCell, type SetupAggregatesResponse } from "./api";
import { fmtRate, fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { behaviorI18n } from "@/i18n/ns/behavior";

const tb = behaviorI18n.t;
import { hourLabel } from "./trader-profile";

type Axis = "hour" | "hold";
type Metric = "avg" | "net" | "wr";
const MIN_N = 5;

function cellValue(c: MatrixCell, m: Metric): number | null {
  return m === "avg" ? c.avg : m === "net" ? c.net : c.winRate == null ? null : c.winRate - 0.5;
}

function fmtCell(c: MatrixCell, m: Metric): string {
  if (m === "wr") return fmtRate(c.winRate);
  return fmtUsd(m === "avg" ? c.avg : c.net, { signed: true, compact: true });
}

export const SetupsMatrix = React.memo(function SetupsMatrix({ data }: { data: SetupAggregatesResponse }) {
  const [axis, setAxis] = React.useState<Axis>("hour");
  const [metric, setMetric] = React.useState<Metric>("avg");
  const matrix = data.matrix?.[axis];

  const model = React.useMemo(() => {
    if (!matrix) return null;
    const byKey = new Map(matrix.cells.map((c) => [`${c.setup}\u0000${c.bucket}`, c]));
    const used = new Set(matrix.cells.map((c) => c.bucket));
    const buckets = matrix.buckets.filter((b) => used.has(b));
    const setups = [...data.groups].sort((a, b) => b.n - a.n).map((g) => g.setup).filter((s) => matrix.cells.some((c) => c.setup === s));
    const vals = matrix.cells.filter((c) => c.n >= MIN_N).map((c) => Math.abs(cellValue(c, metric) ?? 0));
    const max = Math.max(1e-9, ...vals);
    const colTotals = buckets.map((b) => {
      const cs = matrix.cells.filter((c) => c.bucket === b);
      const n = cs.reduce((s, c) => s + c.n, 0);
      const net = cs.reduce((s, c) => s + c.net, 0);
      return { b, n, net };
    });
    return { byKey, buckets, setups, max, colTotals };
  }, [matrix, data.groups, metric]);

  if (!matrix || !model || !model.setups.length) {
    return <EmptyState icon={Grid3x3} title={tb("matrix.empty")} description={tb("matrix.emptyHint")} />;
  }
  const label = (b: string) => (axis === "hour" ? hourLabel(b) : b);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented ariaLabel={tb("matrix.axisAria")} value={axis} onChange={setAxis} options={[{ value: "hour", label: tb("matrix.axisHour") }, { value: "hold", label: tb("matrix.axisHold") }]} />
        <Segmented size="sm" ariaLabel={tb("matrix.metricAria")} value={metric} onChange={setMetric} options={[{ value: "avg", label: tb("matrix.avg") }, { value: "net", label: tb("matrix.net") }, { value: "wr", label: "win rate" }]} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-1 text-xs" aria-label={axis === "hour" ? tb("matrix.axisHour") : tb("matrix.axisHoldLong")}>
          <thead>
            <tr>
              <th scope="col" className="sticky left-0 z-raised bg-[var(--sticky-bg)] px-2 text-left font-medium text-muted-foreground">{tb("matrix.setup")}</th>
              {model.buckets.map((b) => <th key={b} scope="col" className="whitespace-nowrap px-1 text-center font-medium text-muted-foreground">{label(b)}</th>)}
            </tr>
          </thead>
          <tbody>
            {model.setups.map((s) => (
              <tr key={s}>
                <th scope="row" className="sticky left-0 z-raised max-w-[12rem] truncate bg-[var(--sticky-bg)] px-2 text-left font-medium text-foreground" title={s}>{s}</th>
                {model.buckets.map((b) => {
                  const c = model.byKey.get(`${s}\u0000${b}`);
                  if (!c) return <td key={b} className="h-10 min-w-[4.5rem] rounded-md bg-muted/15" aria-label={tb("matrix.noTrades", { setup: s, bucket: label(b) })} />;
                  const v = cellValue(c, metric) ?? 0;
                  const small = c.n < MIN_N;
                  const a = small ? 0.08 : 0.12 + 0.5 * Math.min(1, Math.abs(v) / model.max);
                  const title = `${tb("matrix.cellTitle", { setup: s, bucket: label(b), trades: commonI18n.t("units.trades", { count: c.n }), net: fmtUsd(c.net, { signed: true, decimals: "auto" }), avg: fmtUsd(c.avg, { signed: true, decimals: "auto" }), wr: fmtRate(c.winRate) })}${small ? tb("matrix.few") : ""}`;
                  return (
                    <td
                      key={b}
                      title={title}
                      aria-label={title}
                      className={cn("h-10 min-w-[4.5rem] rounded-md px-1 text-center tabular-nums", small ? "text-muted-foreground" : "text-foreground")}
                      style={{ background: v === 0 ? "hsl(var(--muted) / 0.2)" : `hsl(var(${v > 0 ? "--up" : "--down"}) / ${a.toFixed(2)})` }}
                    >
                      <div className="font-medium leading-tight">{fmtCell(c, metric)}</div>
                      <div className="text-xs leading-tight text-muted-foreground">n={c.n}</div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" className="sticky left-0 z-raised bg-[var(--sticky-bg)] px-2 text-left font-medium text-muted-foreground">{tb("matrix.total")}</th>
              {model.colTotals.map((t) => (
                <td key={t.b} className="px-1 text-center tabular-nums text-muted-foreground">
                  {fmtUsd(t.net, { signed: true, compact: true })} <span className="block">n={t.n}</span>
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        {tb("matrix.footnote", { min: MIN_N })}
        {axis === "hold" && tb("matrix.carry")}

      </p>
    </div>
  );
});
