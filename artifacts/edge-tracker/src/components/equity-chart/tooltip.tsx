import * as React from "react";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { dateRu, fmtValue, rangeRu, weekdayRu, type EquityCandle, type EquityUnit } from "@/components/equity-candles/lib";
import type { EquityAgg } from "./model";
import { fmtMonth, fmtRate, fmtUsd } from "@/lib/format";
import { equityChartI18n } from "@/i18n/ns/equityChart";

const TIP_W = 272;

const tone = (v: number | null | undefined) => (v == null ? "text-foreground" : v > 0 ? "text-up" : v < 0 ? "text-down" : "text-foreground");

/** «Пятница, 15 октября» / «Неделя 13–17 окт.» / «Октябрь 2026». */
export function candleTitle(c: EquityCandle, agg: EquityAgg): string {
  if (agg === "week") return equityChartI18n.t("tip.week", { range: rangeRu(c.from, c.to) });
  if (agg === "month") {
    const mi = Number(c.key.slice(5, 7)) - 1;
    const m = mi >= 0 && mi < 12 ? fmtMonth(mi, "long") : "";
    return `${m.charAt(0).toUpperCase()}${m.slice(1)} ${c.key.slice(0, 4)}`;
  }
  const wd = weekdayRu(c.key);
  return `${wd.charAt(0).toUpperCase()}${wd.slice(1)}, ${dateRu(c.key)}`;
}

function Row({ k, children, cls }: { k: React.ReactNode; children: React.ReactNode; cls?: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{k}</dt>
      <dd className={cn("whitespace-nowrap text-right", cls ?? "text-foreground")}>{children}</dd>
    </>
  );
}

/** Rich hover card of a candle; positioned next to the crosshair, flipped near the right edge. */
export function EquityTooltip({
  c, unit, agg, underwater, x, width, top, touch,
}: {
  c: EquityCandle;
  unit: EquityUnit;
  agg: EquityAgg;
  /** Close below the running peak (≤ 0). */
  underwater: number;
  x: number;
  width: number;
  top: number;
  touch: boolean;
}) {
  const { t } = equityChartI18n.useT();
  const w = Math.min(TIP_W, width - 16);
  const right = x + 16 + w <= width - 8;
  const left = width < 420 ? Math.max(8, Math.min(width - w - 8, x - w / 2)) : right ? x + 16 : Math.max(8, x - 16 - w);
  const usd = unit !== "r";
  const hasWicks = c.high > Math.max(c.open, c.close) + 1e-9 || c.low < Math.min(c.open, c.close) - 1e-9;
  const action = t(`tip.action.${agg}`);
  return (
    <div
      className="pointer-events-none absolute z-raised flex flex-col gap-2 rounded-xl border border-border/70 bg-popover/95 p-3 text-xs text-popover-foreground shadow-xl tabular-nums animate-in fade-in-0 duration-100"
      style={{ left, top, width: w }}
      aria-hidden="true"
    >
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate font-semibold text-foreground">{candleTitle(c, agg)}</span>
          {agg !== "day" && (
            <span className="shrink-0 text-2xs text-muted-foreground">{t("tip.tradingDays", { count: c.days })}</span>
          )}
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-muted-foreground">{t(`tip.value.${usd ? (unit === "gross" ? "gross" : "net") : "r"}.${agg}`)}</span>
          <span className={cn("text-lg font-semibold leading-none tracking-tight", tone(c.value))}>{fmtValue(c.value, unit)}</span>
        </div>
      </div>

      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 border-t border-border/60 pt-2">
        {usd && c.gross != null && unit !== "gross" && c.fees > 0 && <Row k={t("tip.gross")} cls={tone(c.gross)}>{fmtValue(c.gross, "net")}</Row>}
        {usd && c.fees > 0 && <Row k={t("tip.fees")} cls="text-down">{fmtUsd(-c.fees)}</Row>}
        {c.trades > 0 && (
          <Row k={t("tip.trades")}>
            {c.trades}
            {c.wins + c.losses > 0 && (
              <> · <span className="text-up">{c.wins}W</span>/<span className="text-down">{c.losses}L</span></>
            )}
            {c.winRate != null && <span className="text-muted-foreground"> · {fmtRate(c.winRate)}</span>}
          </Row>
        )}
        {hasWicks && <Row k={t(`tip.hiLo.${agg}`)}><span className={tone(c.peakIn)}>{fmtValue(c.peakIn, unit)}</span> <span className="text-muted-foreground">/</span> <span className={tone(c.troughIn)}>{fmtValue(c.troughIn, unit)}</span></Row>}
        <Row k={t("tip.cumulative")} cls={cn("font-medium", tone(c.close))}>{fmtValue(c.close, unit)}</Row>
        <Row k={t("tip.fromPeak")} cls={underwater < 0 ? "text-down" : "text-muted-foreground"}>{underwater < 0 ? fmtValue(underwater, unit) : t("tip.atPeak")}</Row>
      </dl>

      {(c.best || c.worst) && c.trades > 0 && (
        <div className="grid grid-cols-2 gap-2 border-t border-border/60 pt-2">
          {c.best && (
            <div className="min-w-0">
              <div className="text-2xs text-muted-foreground">{t("tip.best")}</div>
              <div className="truncate"><span className="font-medium text-foreground">{c.best.ticker}</span> <span className={tone(c.best.value)}>{fmtValue(c.best.value, unit)}</span></div>
            </div>
          )}
          {c.worst && c.trades > 1 && (
            <div className="min-w-0">
              <div className="text-2xs text-muted-foreground">{t("tip.worst")}</div>
              <div className="truncate"><span className="font-medium text-foreground">{c.worst.ticker}</span> <span className={tone(c.worst.value)}>{fmtValue(c.worst.value, unit)}</span></div>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-end gap-1 text-2xs font-medium text-primary">
        {touch ? t("tip.tapAgain", { action }) : t("tip.click", { action })}
        <ArrowRight className="h-3 w-3" aria-hidden="true" />
      </div>
    </div>
  );
}
