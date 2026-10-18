
import { cn } from "@/lib/utils";
import type { Bar, PositionState, Side } from "../types";
import { fmtEtDateTime, formatDuration } from "../lib/time";
import { fmtCompact, fmtPct, fmtPrice, fmtR, fmtUsd } from "@/lib/format";
import { fmtPerShare } from "../lib/trade-summary";
import { chartI18n } from "@/i18n/ns/chart";
import { commonI18n } from "@/i18n/ns/common";

export type LegendInfo = {
  bar: Bar;
  idx: number;
  /** Whether the legend follows the mouse (vs. the replay cursor / last bar). */
  hovered: boolean;
  position: PositionState | null;
  /** Seconds since the entry fill at this bar (null before entry). */
  sinceEntry: number | null;
  vwap: { vwap: number; sd: number } | null;
  avwap: number | null;
  rvol: number | null;
  risk: number | null;
  side: Side;
  prevClose: number | null;
  /** Another trader's trade: no $ — per share and R only. */
  redacted: boolean;
};

const tone = (n: number | null | undefined) => (n == null || !Number.isFinite(n) || Math.abs(n) < 1e-12 ? "text-foreground" : n > 0 ? "text-up" : "text-down");

/**
 * TradingView-style legend: plain text in the top-left corner (no box over the candles), OHLC + change + volume on the
 * first line, VWAP and the open position (per share · R · $ for own trades) on the second.
 */
export function ChartLegend({ info, ticker, tfLabel, className }: { info: LegendInfo | null; ticker: string; tfLabel: string; className?: string }) {
  if (!info) return null;
  const { bar, position: pos } = info;
  const chg = bar.c - bar.o;
  const chgPct = bar.o ? (chg / bar.o) * 100 : null;
  const vsPrev = info.prevClose ? ((bar.c - info.prevClose) / info.prevClose) * 100 : null;
  const dir = info.side === "short" ? -1 : 1;
  const open = !!pos && pos.avg != null;
  const perShare = open ? dir * (bar.c - (pos!.avg as number)) : null;
  const r = perShare != null && info.risk ? perShare / info.risk : null;
  const usd = !info.redacted && open ? pos!.total : null;
  return (
    <div
      className={cn(
        "pointer-events-none absolute left-2.5 top-2 z-raised flex max-w-[calc(100%-5rem)] flex-col gap-0.5 text-xs tabular-nums text-muted-foreground",
        "[text-shadow:0_0_2px_hsl(var(--background)),0_0_6px_hsl(var(--background)),0_0_10px_hsl(var(--background))]",
        className,
      )}
      aria-live="off"
    >
      <div className="flex flex-wrap items-center gap-x-2.5 whitespace-nowrap sm:flex-nowrap sm:overflow-hidden [&>*]:shrink-0">
        <span className="font-semibold text-foreground">{ticker} <span className="font-normal text-muted-foreground">· {tfLabel}</span></span>
        <span className={cn(info.hovered ? "text-foreground" : "")}>{fmtEtDateTime(bar.t)}</span>
        <span>O <b className="font-medium text-foreground">{fmtPrice(bar.o)}</b></span>
        <span>H <b className="font-medium text-foreground">{fmtPrice(bar.h)}</b></span>
        <span>L <b className="font-medium text-foreground">{fmtPrice(bar.l)}</b></span>
        <span>C <b className={cn("font-medium", tone(chg))}>{fmtPrice(bar.c)}</b> <span className={tone(chg)}>{fmtPct(chgPct)}</span></span>
        <span className="hidden sm:inline">V <b className="font-medium text-foreground">{fmtCompact(bar.v)}</b>{info.rvol != null && info.rvol >= 1.5 && <span className="ml-1 text-[hsl(var(--chart-3))]" title={chartI18n.t("legend.rvolTitle")}>×{info.rvol.toFixed(1)}</span>}</span>
      </div>
      <div className="flex items-center gap-x-2.5 overflow-hidden whitespace-nowrap [&>*]:shrink-0">
        {vsPrev != null && <span className="hidden sm:inline" title={chartI18n.t("legend.vsPrevTitle")}>{chartI18n.t("legend.vsPrev")} <b className={cn("font-medium", tone(vsPrev))}>{fmtPct(vsPrev)}</b></span>}
        {info.vwap && <span>VWAP <b className="font-medium text-[hsl(var(--chart-5))]">{fmtPrice(info.vwap.vwap)}</b></span>}
        {info.avwap != null && <span className="hidden sm:inline">AVWAP <b className="font-medium text-primary">{fmtPrice(info.avwap)}</b></span>}
        {pos && pos.fillsSoFar > 0 && (open ? (
          <span className="text-foreground">
            {chartI18n.t("legend.position", { side: info.side === "short" ? commonI18n.t("trading.short") : commonI18n.t("trading.long"), price: fmtPrice(pos.avg) })}{" "}
            <b className={tone(perShare)}>{fmtPerShare(perShare)}</b>
            {r != null && <b className={cn("ml-1", tone(r))}>{fmtR(r)}</b>}
            {usd != null && <b className={cn("ml-1", tone(usd))}>{fmtUsd(usd, { signed: true, decimals: "auto" })}</b>}
            {info.sinceEntry != null && info.sinceEntry >= 0 && <span className="ml-1 text-muted-foreground">· {formatDuration(info.sinceEntry)}</span>}
          </span>
        ) : (
          <span>{chartI18n.t("legend.closed")}</span>
        ))}
      </div>
    </div>
  );
}
