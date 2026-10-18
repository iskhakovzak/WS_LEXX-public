import { Link } from "wouter";
import { ChevronRight, ClipboardPen, History, RefreshCw } from "lucide-react";
import { EmptyState, Panel, toneOf, toneText } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { normalizeResult } from "@/lib/trade-result";
import { KPI_FORMULAS } from "@/lib/trade-math";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import { shortDate } from "./fmt";
import { fmtR, fmtUsd } from "@/lib/format";
import type { RecentTrade } from "./use-dashboard";
import { dashboardI18n } from "@/i18n/ns/dashboard";
import { commonI18n } from "@/i18n/ns/common";
import { personName } from "@/i18n";

/** Lower-case horizon tag for multi-day trades (empty for intraday). */
const horizonShort = (h: string) => (h === "overnight" || h === "swing" ? dashboardI18n.t(`recent.horizon.${h}`) : "");

function barTone(t: RecentTrade): string {
  const r = normalizeResult(t.result);
  if (r === "win") return "bg-up";
  if (r === "loss") return "bg-down";
  if ((t.result ?? "").toLowerCase() === "open") return "bg-primary";
  return "bg-border";
}

/** Compact feed of the last trades → trade card. Net $ first; R only when the trade has a stop. */
export function RecentTradesPanel({
  trades,
  isLoading,
  isError,
  onRetry,
  showTrader,
  rows = 7,
  fill,
}: {
  trades: RecentTrade[] | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  showTrader: boolean;
  rows?: number;
  fill?: boolean;
}) {
  const { t: td } = dashboardI18n.useT();
  const { t: tc } = commonI18n.useT();
  const list = (trades ?? []).slice(0, rows);
  return (
    <Panel
      title={td("recent.title")}
      icon={History}
      fill={fill}
      bodyClassName="px-2 sm:px-3"
      footer={
        <>
          <span>{td("recent.footer")}</span>
          <Link href={links.trades()} className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline">
            {td("recent.all")}
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </>
      }
    >
      {isLoading && !trades ? (
        <ul className="flex flex-col" role="status" aria-label={tc("states.loading")}>
          {Array.from({ length: rows }).map((_, i) => (
            <li key={i} className="flex items-center gap-3 px-2 py-2">
              <Skeleton className="h-7 w-1 rounded-full" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-3.5 w-24 rounded" />
                <Skeleton className="h-3 w-36 rounded" />
              </div>
              <Skeleton className="h-4 w-16 rounded" />
            </li>
          ))}
        </ul>
      ) : isError && !trades ? (
        <EmptyState
          compact
          title={td("recent.loadFailed")}
          action={
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RefreshCw aria-hidden="true" />
              {tc("actions.retry")}
            </Button>
          }
        />
      ) : list.length === 0 ? (
        <EmptyState compact icon={History} title={td("recent.empty")} description={td("recent.emptyHint")} />
      ) : (
        <ul className="flex flex-col">
          {list.map((t) => {
            const isShort = (t.side ?? "").toLowerCase().startsWith("s");
            const hz = horizonShort(t.horizon);
            const multiDay = t.exitDate && t.exitDate.slice(0, 10) !== t.date.slice(0, 10);
            return (
              <li key={t.id}>
                <Link
                  href={links.trade(t.id)}
                  aria-label={td("recent.openAria", { ticker: t.ticker, date: shortDate(t.closeDate) })}
                  className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className={cn("h-7 w-1 rounded-full", barTone(t))} aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="text-sm font-semibold">{t.ticker}</span>
                      {t.side && <span className={cn("text-xs", isShort ? "text-down" : "text-up")}>{(isShort ? tc("trading.short") : tc("trading.long")).toLowerCase()}</span>}
                      {hz && <span className="text-xs text-purple">{hz}</span>}
                      {t.unreviewed && normalizeResult(t.result) && (
                        <span className="inline-flex items-center text-warn" title={td("recent.unreviewed")}>
                          <ClipboardPen className="h-3 w-3" aria-hidden="true" />
                          <span className="sr-only">{td("recent.unreviewed")}</span>
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {shortDate(t.closeDate)}
                      {multiDay ? ` ${td("recent.entered", { date: shortDate(t.date) })}` : ""}
                      {t.setup ? ` · ${t.setup}` : ""}
                      {showTrader && t.trader ? ` · ${personName(t.trader)}` : ""}
                    </span>
                  </span>
                  <span className="flex flex-col items-end">
                    <span
                      className={cn("text-sm font-medium tabular-nums", toneText(toneOf(t.pnlNet ?? t.rMultiple)))}
                      title={t.pnlNet != null ? td("recent.pnlTitle", { formula: KPI_FORMULAS.netPnl, gross: fmtUsd(t.pnlGross, { signed: true }), fees: fmtUsd(Math.abs(t.fees), { signed: true }) }) : undefined}
                    >
                      {t.pnlNet != null ? fmtUsd(t.pnlNet, { signed: true }) : t.rMultiple != null ? fmtR(t.rMultiple) : (t.result ?? "").toLowerCase() === "open" ? td("recent.open") : "—"}
                    </span>
                    {t.pnlNet != null && t.rMultiple != null && (
                      <span className={cn("text-2xs tabular-nums", toneText(toneOf(t.rMultiple)))}>{fmtR(t.rMultiple)}</span>
                    )}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
