import type { Trade } from "@workspace/api-client-react";
import { Hourglass, Receipt } from "lucide-react";
import { Panel, Pill, StatRow, toneOf } from "@/components/ds";
import { cn } from "@/lib/utils";
import {
  horizonLabel, feesOf, fmtValue, groupBy, horizonOf, valueOf, isClosed,
  type FeeStats, type Horizon, type HorizonFilter, type Metric,
} from "./metrics";
import { fmtRate } from "@/lib/format";
import { statsI18n } from "@/i18n/ns/stats";

const ORDER: Horizon[] = ["intraday", "overnight", "swing"];
const toneCls = (v: number | null) => (v == null ? "text-muted-foreground" : v > 0 ? "text-up" : v < 0 ? "text-down" : "text-foreground");

/**
 * Intraday / overnight / swing comparison. Receives trades BEFORE the horizon filter so the three rows are always comparable;
 * the active filter row is highlighted and rows act as a quick filter.
 */
export function HorizonPanel({
  trades, metric, active, onPick,
}: {
  trades: Trade[];
  metric: Metric;
  active: HorizonFilter;
  onPick: (h: HorizonFilter) => void;
}) {
  const { t } = statsI18n.useT();
  const groups = groupBy(trades, (tr) => horizonOf(tr), metric);
  const net = groupBy(trades, (tr) => horizonOf(tr), "net");
  const total = trades.length || 1;
  const rows = ORDER.map((h) => ({
    h,
    g: groups.find((x) => x.key === h),
    net: net.find((x) => x.key === h)?.value ?? null,
  }));
  const showNet = metric === "r";

  return (
    <Panel title={t("horizonPanel.title")} icon={Hourglass} description={t("horizonPanel.hint")}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[320px] text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr className="border-b border-[hsl(var(--border))]">
              <th scope="col" className="px-2 py-2 text-left font-medium">{t("horizonPanel.colHorizon")}</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">{t("horizonPanel.colTrades")}</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">WR</th>
              <th scope="col" className="hidden px-2 py-2 text-right font-medium sm:table-cell">{t("horizonPanel.colAvg")}</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">{t("horizonPanel.colTotal")}</th>
              {showNet && <th scope="col" className="hidden px-2 py-2 text-right font-medium md:table-cell">{t("horizonPanel.colNet")}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ h, g, net: n }) => {
              const isActive = active === h;
              const count = g?.count ?? 0;
              return (
                <tr key={h} className={cn("border-b border-[hsl(var(--border)/0.5)] last:border-0", isActive && "bg-primary/10")}>
                  <td className="px-2 py-2">
                    <button
                      type="button"
                      aria-pressed={isActive}
                      onClick={() => onPick(isActive ? "all" : h)}
                      title={isActive ? t("horizonPanel.reset") : t("horizonPanel.only", { horizon: horizonLabel(h) })}
                      className="flex w-full min-w-0 flex-col items-start gap-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className={cn("font-medium", isActive ? "text-primary" : "text-foreground")}>{horizonLabel(h)}</span>
                      <span className="h-1 w-full max-w-[96px] overflow-hidden rounded-full bg-[var(--glass-hover-bg)]" aria-hidden="true">
                        <span className="block h-full rounded-full bg-chart-1" style={{ width: `${(count / total) * 100}%` }} />
                      </span>
                    </button>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                    {count}
                    <span className="ml-1 text-2xs">({fmtRate(count / total)})</span>
                  </td>
                  <td className={cn("px-2 py-2 text-right tabular-nums", g?.winRate == null ? "text-muted-foreground" : g.winRate >= 0.5 ? "text-up" : "text-down")}>
                    {fmtRate(g?.winRate)}
                  </td>
                  <td className="hidden px-2 py-2 text-right tabular-nums text-muted-foreground sm:table-cell">{fmtValue(g?.avg, metric)}</td>
                  <td className={cn("px-2 py-2 text-right font-semibold tabular-nums", toneCls(g?.value ?? null))}>{fmtValue(g?.value, metric)}</td>
                  {showNet && <td className={cn("hidden px-2 py-2 text-right tabular-nums md:table-cell", toneCls(n))}>{fmtValue(n, "usd")}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{t("horizonPanel.footnote")}</p>
    </Panel>
  );
}

/** Gross vs net P&L: how much of the result the commissions eat. */
export function FeesPanel({ fees, prev, trades }: { fees: FeeStats; prev: FeeStats | null; trades: Trade[] }) {
  const { t } = statsI18n.useT();
  const closed = trades.filter(isClosed).length;
  const share = fees.gross != null && fees.gross > 0 ? fees.fees / fees.gross : null;
  const avgFee = fees.withFees ? fees.fees / fees.withFees : null;
  const netDelta = prev && prev.net != null && fees.net != null ? fees.net - prev.net : null;
  const missingPnl = closed - fees.withPnl;
  const bar = fees.gross != null && fees.gross > 0 ? Math.min(100, (fees.fees / fees.gross) * 100) : 0;
  // Trades with P&L but no fees recorded — the net figure would be optimistic.
  const noFee = trades.filter((tr) => isClosed(tr) && valueOf(tr, "usd") != null && !(feesOf(tr) > 0)).length;

  return (
    <Panel
      title={t("fees.title")}
      icon={Receipt}
      description={t("fees.hint")}
      actions={netDelta != null ? <Pill tone={toneOf(netDelta)}>{t("fees.netVsPrev", { value: fmtValue(netDelta, "usd") })}</Pill> : undefined}
    >
      {fees.gross == null && fees.fees === 0 ? (
        <p className="text-sm text-muted-foreground">{t("fees.empty")}</p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            {[
              { l: t("fees.gross"), v: fmtValue(fees.gross, "usd"), c: toneCls(fees.gross) },
              { l: t("fees.fees"), v: fees.fees ? fmtValue(-fees.fees, "usd") : "$0", c: fees.fees ? "text-down" : "text-muted-foreground" },
              { l: t("fees.net"), v: fmtValue(fees.net, "usd"), c: toneCls(fees.net) },
            ].map((x) => (
              <div key={x.l} className="rounded-xl bg-[var(--glass-bg)] p-3">
                <div className="text-xs text-muted-foreground">{x.l}</div>
                <div className={cn("truncate text-lg font-semibold tabular-nums", x.c)}>{x.v}</div>
              </div>
            ))}
          </div>
          {fees.gross != null && fees.gross > 0 && (
            <div className="mt-3" aria-label={t("fees.eatsAria", { share: fmtRate(share) })}>
              <div className="h-2 overflow-hidden rounded-full bg-up/30">
                <div className="h-full rounded-full bg-down" style={{ width: `${bar}%` }} />
              </div>
            </div>
          )}
          <div className="mt-3 divide-y divide-[hsl(var(--border)/0.5)]">
            <StatRow label={t("fees.ofGross")} value={fmtRate(share)} tone={share != null && share > 0.2 ? "down" : "neutral"} />
            <StatRow label={t("fees.avgFee")} value={avgFee != null ? fmtValue(avgFee, "usd", { sign: false }) : "—"} />
            <StatRow label={t("fees.withFees")} value={t("fees.ofTotal", { value: fees.withFees, total: closed })} />
          </div>
          {(missingPnl > 0 || noFee > 0) && (
            <p className="mt-2 text-xs text-muted-foreground">
              {missingPnl > 0 && `${t("fees.noPnl", { count: missingPnl })} `}
              {noFee > 0 && t("fees.noFee", { count: noFee })}

            </p>
          )}
        </>
      )}
    </Panel>
  );
}
