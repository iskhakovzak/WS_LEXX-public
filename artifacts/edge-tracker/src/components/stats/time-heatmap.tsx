import { useMemo } from "react";
import type { Trade } from "@workspace/api-client-react";
import { Clock } from "lucide-react";
import { EmptyState, Panel } from "@/components/ds";
import { cn } from "@/lib/utils";
import {
  dayKey, fmtMetricCompact, fmtValue, heatBg, isClosed, isLoss, isWin, sessionKey, sessionLabel, valueOf, weekdayIdx, weekdayLabel, type Metric,
} from "./metrics";
import { fmtRate } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { statsI18n } from "@/i18n/ns/stats";

const sd = (n: number) => commonI18n.t("units.tradesShort", { count: n });

type Cell = { n: number; closed: number; wins: number; losses: number; v: number | null };
const empty = (): Cell => ({ n: 0, closed: 0, wins: 0, losses: 0, v: null });
const add = (c: Cell, t: Trade, metric: Metric) => {
  c.n++;
  if (isClosed(t)) {
    c.closed++;
    if (isWin(t)) c.wins++;
    if (isLoss(t)) c.losses++;
    const v = valueOf(t, metric);
    if (v != null) c.v = (c.v ?? 0) + v;
  }
};

const SESSION_ORDER = ["premarket", "regular", "afterhours"];

/**
 * Weekday × session heatmap. Trades carry a date and a session (premarket / regular / after-hours) but no
 * exact time, so session is the honest intraday axis. Colour = sum of the metric; text also shows WR and count.
 */
export function TimeHeatmap({ trades, metric }: { trades: Trade[]; metric: Metric }) {
  const { t } = statsI18n.useT();
  const { cols, rows, colTotals, max } = useMemo(() => {
    const keys = new Set<string>(SESSION_ORDER);
    trades.forEach((t) => keys.add(sessionKey(t)));
    const used = [...keys].filter((k) => SESSION_ORDER.includes(k) || trades.some((t) => sessionKey(t) === k));
    used.sort((a, b) => {
      const ia = SESSION_ORDER.indexOf(a);
      const ib = SESSION_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
    const hasWeekend = trades.some((t) => weekdayIdx(dayKey(t)) >= 5);
    const dayIdx = hasWeekend ? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 2, 3, 4];
    const grid = new Map<string, Cell>();
    const rowT = new Map<number, Cell>();
    const colT = new Map<string, Cell>();
    for (const t of trades) {
      const k = dayKey(t);
      if (!k) continue;
      const d = weekdayIdx(k);
      const s = sessionKey(t);
      const id = `${d}|${s}`;
      if (!grid.has(id)) grid.set(id, empty());
      if (!rowT.has(d)) rowT.set(d, empty());
      if (!colT.has(s)) colT.set(s, empty());
      add(grid.get(id)!, t, metric);
      add(rowT.get(d)!, t, metric);
      add(colT.get(s)!, t, metric);
    }
    const m = Math.max(0, ...[...grid.values()].map((c) => Math.abs(c.v ?? 0)));
    return {
      cols: used,
      rows: dayIdx.map((d) => ({ d, cells: used.map((s) => grid.get(`${d}|${s}`) ?? empty()), total: rowT.get(d) ?? empty() })),
      colTotals: used.map((s) => colT.get(s) ?? empty()),
      max: m,
    };
  }, [trades, metric]);

  const valText = (c: Cell) => (c.v != null ? fmtMetricCompact(c.v, metric) : c.wins + c.losses ? fmtRate(c.wins / (c.wins + c.losses)) : "");
  const toneCls = (v: number | null) => (v == null ? "text-foreground" : v > 0 ? "text-up" : v < 0 ? "text-down" : "text-foreground");

  return (
    <Panel
      title={t("heatmap.title")}
      icon={Clock}
      description={t("heatmap.hint")}
    >
      {trades.length === 0 ? (
        <EmptyState title={t("heatmap.empty")} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[300px] border-separate border-spacing-1 text-xs">
            <thead>
              <tr>
                <th className="w-8 text-left font-normal text-muted-foreground"><span className="sr-only">{t("heatmap.day")}</span></th>
                {cols.map((s) => <th key={s} scope="col" className="px-1 pb-1 text-center font-medium text-muted-foreground">{sessionLabel(s)}</th>)}
                <th scope="col" className="px-1 pb-1 text-center font-medium text-muted-foreground">{t("heatmap.total")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.d}>
                  <th scope="row" className="pr-1 text-left font-medium text-muted-foreground">{weekdayLabel(r.d)}</th>
                  {r.cells.map((c, i) => {
                    const label = `${weekdayLabel(r.d)}, ${sessionLabel(cols[i])}: ${sd(c.n)}${c.wins + c.losses ? `, WR ${fmtRate(c.wins / (c.wins + c.losses))}` : ""}${c.v != null ? `, ${fmtValue(c.v, metric)}` : ""}`;
                    return (
                      <td
                        key={cols[i]}
                        title={label}
                        aria-label={label}
                        style={c.n ? { backgroundColor: heatBg(c.v ?? 0, max) } : undefined}
                        className={cn(
                          "h-12 rounded-lg px-1 text-center align-middle tabular-nums",
                          c.n ? (c.v ? "" : "bg-[var(--glass-hover-bg)]") : "border border-dashed border-[hsl(var(--border)/0.6)]",
                        )}
                      >
                        {c.n > 0 && (
                          <div className="leading-tight">
                            <div className="font-semibold text-foreground">{valText(c)}</div>
                            <div className="text-2xs text-muted-foreground">{sd(c.n)}</div>
                          </div>
                        )}
                      </td>
                    );
                  })}
                  <td className="rounded-lg bg-[var(--glass-bg)] px-1 text-center tabular-nums">
                    {r.total.n > 0 ? (
                      <div className="leading-tight">
                        <div className={cn("font-semibold", toneCls(r.total.v))}>{valText(r.total)}</div>
                        <div className="text-2xs text-muted-foreground">{sd(r.total.n)}</div>
                      </div>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                </tr>
              ))}
              <tr>
                <th scope="row" className="pr-1 text-left font-medium text-muted-foreground">Σ</th>
                {colTotals.map((c, i) => (
                  <td key={cols[i]} className="h-10 rounded-lg bg-[var(--glass-bg)] px-1 text-center tabular-nums">
                    {c.n > 0 ? (
                      <div className="leading-tight">
                        <div className={cn("font-semibold", toneCls(c.v))}>{valText(c)}</div>
                        <div className="text-2xs text-muted-foreground">{sd(c.n)}</div>
                      </div>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                ))}
                <td />
              </tr>
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("heatmap.footnote", { unit: metric === "r" ? "R" : "P&L" })}

          </p>
        </div>
      )}
    </Panel>
  );
}
