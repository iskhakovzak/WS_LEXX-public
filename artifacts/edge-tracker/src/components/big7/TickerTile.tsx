import { memo } from "react";
import { Flame } from "lucide-react";
import { Pill, Sparkline, SkeletonBlock, toneOf } from "@/components/ds";
import { cn } from "@/lib/utils";
import type { Big7Row } from "./context";
import { Signed, earningsLabel, fmtRvol } from "./ui";
import { big7I18n } from "@/i18n/ns/big7";
import { fmtPct, fmtPrice } from "@/lib/format";

export type TileProps = {
  row: Big7Row;
  hot?: boolean;
  earnings: { days: number; when: string | null } | null;
  index: number;
  onOpen: (symbol: string) => void;
};

/** Fixed height so the grid never shifts when data arrives (skeleton has the same box). */
export const TILE_H = "h-[138px]";

/**
 * Compact tile: symbol, change, price, intraday sparkline (session closes vs prior close),
 * RS vs QQQ, time-of-day RVOL and an earnings badge when the report is ≤ 5 trading days away.
 * The sparkline is coloured by the same day change as the pill.
 */
export const TickerTile = memo(function TickerTile({ row, hot, earnings, index, onOpen }: TileProps) {
  const { t } = big7I18n.useT();
  const dayTone = toneOf(row.chg);
  return (
    <button
      type="button"
      onClick={() => onOpen(row.symbol)}
      aria-label={t("tile.open", { label: `${row.symbol}${row.price != null ? `, ${fmtPrice(row.price)}` : ""}${row.chg != null ? `, ${fmtPct(row.chg)}` : ""}` })}
      title={index < 9 ? t("tile.key", { n: index + 1 }) : undefined}
      className={cn(
        "glass-panel lift group flex min-w-0 flex-col gap-1.5 rounded-2xl p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
        TILE_H,
      )}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate text-base font-semibold tracking-tight">{row.symbol}</span>
          {hot && <Flame className="h-3.5 w-3.5 shrink-0 text-primary" aria-label="Hot" />}
        </span>
        <Pill tone={dayTone} className="shrink-0">{fmtPct(row.chg)}</Pill>
      </div>

      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="text-lg font-semibold leading-none tabular-nums">{fmtPrice(row.price)}</span>
        {earnings ? (
          <span className="truncate whitespace-nowrap text-xs font-medium text-warn" title={t("tile.nextEarnings")}>{earningsLabel(earnings)}</span>
        ) : (
          <span className="whitespace-nowrap text-xs text-muted-foreground" title={t("tile.gapTitle")}>
            {t("tile.gap")} <Signed value={row.gap} digits={1} threshold={0.05} />
          </span>
        )}
      </div>

      <Sparkline
        data={row.spark}
        width={160}
        height={30}
        tone={dayTone}
        baseline={row.pdc ?? undefined}
        className="h-[30px] w-full"
        ariaLabel={t("tile.sparkAria", { symbol: row.symbol })}
      />

      <div className="mt-auto flex items-center justify-between gap-2 text-xs tabular-nums">
        <span className="whitespace-nowrap" title={t("tile.rsTitle")}>
          <span className="text-muted-foreground">RS </span>
          <Signed value={row.rsQqq} digits={1} suffix="" threshold={0.1} />
        </span>
        <span className="whitespace-nowrap" title={t("tile.rvolTitle")}>
          <span className="text-muted-foreground">RVOL </span>
          <span className={cn(row.rvol != null && row.rvol >= 1.5 ? "font-semibold text-primary" : "text-foreground")}>{fmtRvol(row.rvol)}</span>
        </span>
      </div>
    </button>
  );
});

export function TileSkeleton() {
  return (
    <div className={cn("glass-panel flex flex-col gap-2 rounded-2xl p-3", TILE_H)} aria-hidden="true">
      <div className="flex justify-between"><SkeletonBlock className="h-4 w-12 rounded-full" /><SkeletonBlock className="h-4 w-14 rounded-full" /></div>
      <SkeletonBlock className="h-5 w-20 rounded-full" />
      <SkeletonBlock className="h-[30px] w-full rounded-lg" />
      <SkeletonBlock className="mt-auto h-3 w-full rounded-full" />
    </div>
  );
}
