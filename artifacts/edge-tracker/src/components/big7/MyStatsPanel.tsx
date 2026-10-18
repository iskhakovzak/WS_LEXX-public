/**
 * The trader's own results on the board tickers: net, win rate and best hour per ticker plus an
 * hour-of-day strip. Rendered only when there are trades (the page hides it otherwise).
 */
import * as React from "react";
import { Link } from "wouter";
import { ArrowUpRight } from "lucide-react";
import { DataTable, Panel, Segmented, SortableTh, TermTooltip, toneOf, toneText, useTableSort } from "@/components/ds";
import { fmtUsd } from "@/lib/format";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import type { MyHour, MyStats, MyTicker } from "./use-big7";
import { big7I18n } from "@/i18n/ns/big7";
import { commonI18n } from "@/i18n/ns/common";

export type StatsPeriod = "90" | "0";

type SortKey = "ticker" | "n" | "net" | "wr" | "long" | "best";
const SORT_ACCESSORS: Record<SortKey, (r: MyTicker) => number | string | null> = {
  ticker: (r) => r.ticker,
  n: (r) => r.n,
  net: (r) => r.net,
  wr: (r) => r.wr,
  long: (r) => r.longNet,
  best: (r) => r.bestHour?.net ?? null,
};

/** `wr` comes from the API in percent (52.3). */
const wrText = (wr: number | null) => (wr == null ? "—" : `${Math.round(wr)}%`);
/** WR coloured only when clearly away from a coin flip (desk rule: no green for 51%). */
const wrTone = (wr: number | null) => (wr == null ? "text-muted-foreground" : wr >= 60 ? "text-up" : wr <= 40 ? "text-down" : "text-foreground");

function HoursStrip({ hours }: { hours: MyHour[] }) {
  const { t } = big7I18n.useT();
  const max = Math.max(1, ...hours.map((h) => Math.abs(h.net)));
  return (
    <div className="flex h-full min-h-[148px] flex-col gap-2">
      <span className="text-xs text-muted-foreground">{t("my.hours")}</span>
      <div className="grid flex-1 grid-cols-8 items-stretch gap-1.5" role="list">
        {hours.map((h) => {
          const pct = (Math.abs(h.net) / max) * 50;
          return (
            <div
              key={h.key}
              role="listitem"
              className="flex min-w-0 flex-col items-center gap-1"
              title={t("my.hourTitle", { label: h.label, trades: commonI18n.t("units.tradesShort", { count: h.n }), net: fmtUsd(h.net, { signed: true, decimals: "auto" }), wr: wrText(h.wr) })}
            >
              <div className="relative w-full flex-1 rounded-md bg-[var(--glass-bg)]">
                <span className="absolute inset-x-0 top-1/2 h-px bg-border" aria-hidden="true" />
                {h.n > 0 && (
                  <span
                    className={cn("absolute inset-x-1 rounded-sm", h.net >= 0 ? "bg-up/80" : "bg-down/80")}
                    style={h.net >= 0 ? { bottom: "50%", height: `${pct}%` } : { top: "50%", height: `${pct}%` }}
                    aria-hidden="true"
                  />
                )}
              </div>
              <span className="w-full truncate text-center text-xs text-muted-foreground">{h.label}</span>
              <span className={cn("text-xs tabular-nums", h.n ? toneText(toneOf(h.net)) : "text-muted-foreground")}>{h.n ? h.n : "·"}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function MyStatsPanel({ stats, period, onPeriod, onOpen }: {
  stats: MyStats;
  period: StatsPeriod;
  onPeriod: (p: StatsPeriod) => void;
  onOpen: (symbol: string) => void;
}) {
  const traded = React.useMemo(() => stats.tickers.filter((t) => t.n > 0), [stats.tickers]);
  const { rows: tickers, thProps } = useTableSort(traded, SORT_ACCESSORS, "net");
  const { t } = big7I18n.useT();
  const tot = stats.total;
  return (
    <Panel
      title={t("my.title")}
      description={
        tot.n > 0
          ? <>{commonI18n.t("units.tradesShort", { count: tot.n })} · <span className={toneText(toneOf(tot.net))}>{fmtUsd(tot.net, { signed: true, decimals: "auto" })}</span> <TermTooltip term="net">{t("my.net")}</TermTooltip> · WR {wrText(tot.wr)}</>
          : t("my.noTrades")
      }
      actions={
        <Segmented
          ariaLabel={t("my.periodAria")}
          size="sm"
          value={period}
          onChange={onPeriod}
          options={[{ value: "90", label: t("my.days90") }, { value: "0", label: t("my.allTime") }]}
        />
      }
    >
      {tot.n > 0 && (
        <div className="grid grid-cols-1 gap-[var(--grid-gap)] lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <DataTable ariaLabel={t("my.tableAria")}>
            <table>
              <thead>
                <tr>
                  <SortableTh {...thProps("ticker")}>{t("my.ticker")}</SortableTh>
                  <SortableTh {...thProps("n")} align="right">{t("my.trades")}</SortableTh>
                  <SortableTh {...thProps("net")} align="right" term="net">{t("my.netCol")}</SortableTh>
                  <SortableTh {...thProps("wr")} align="right" term="winrate">WR</SortableTh>
                  <SortableTh {...thProps("long")} align="right">{t("my.longShort")}</SortableTh>
                  <SortableTh {...thProps("best")}>{t("my.bestTime")}</SortableTh>
                  <th scope="col"><span className="sr-only">{t("my.tradesCol")}</span></th>
                </tr>
              </thead>
              <tbody>
                {tickers.map((r: MyTicker) => (
                  <tr key={r.ticker} className="cursor-pointer" onClick={() => onOpen(r.ticker)}>
                    <td className="font-semibold">{r.ticker}</td>
                    <td className="text-right">{r.n}</td>
                    <td className={cn("text-right font-medium", toneText(toneOf(r.net)))}>{fmtUsd(r.net, { signed: true, decimals: "auto" })}</td>
                    <td className={cn("text-right", wrTone(r.wr))}>{wrText(r.wr)}</td>
                    <td className="text-right text-xs">
                      <span className={toneText(toneOf(r.longNet))}>{fmtUsd(r.longNet, { signed: true, decimals: 0 })}</span>
                      <span className="text-muted-foreground"> / </span>
                      <span className={toneText(toneOf(r.shortNet))}>{fmtUsd(r.shortNet, { signed: true, decimals: 0 })}</span>
                    </td>
                    <td className="text-xs">
                      {r.bestHour ? (
                        <span className="whitespace-nowrap"><span className="text-foreground">{r.bestHour.label}</span> <span className="text-up">{fmtUsd(r.bestHour.net, { signed: true, decimals: 0 })}</span></span>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="text-right">
                      <Link
                        href={links.trades({ ticker: r.ticker })}
                        onClick={(e: React.MouseEvent) => e.stopPropagation()}
                        className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-primary"
                        aria-label={t("my.tradesBy", { ticker: r.ticker })}
                      >
                        <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DataTable>
          <HoursStrip hours={stats.hours} />
        </div>
      )}
    </Panel>
  );
}

/** Compact block for the detail sheet: one ticker's numbers. */
export function MyTickerStats({ row }: { row: MyTicker | undefined }) {
  const { t } = big7I18n.useT();
  if (!row || row.n === 0) return null;
  const cells: Array<[string, React.ReactNode]> = [
    [t("my.trades"), row.n],
    [t("my.netCol"), <span className={toneText(toneOf(row.net))}>{fmtUsd(row.net, { signed: true, decimals: "auto" })}</span>],
    ["WR", <span className={wrTone(row.wr)}>{wrText(row.wr)}</span>],
    [t("my.avg"), <span className={toneText(toneOf(row.avg))}>{fmtUsd(row.avg, { signed: true, decimals: "auto" })}</span>],
    [t("my.bestTime"), row.bestHour ? `${row.bestHour.label} · ${fmtUsd(row.bestHour.net, { signed: true, decimals: 0 })}` : "—"],
    [t("my.worstTime"), row.worstHour ? `${row.worstHour.label} · ${fmtUsd(row.worstHour.net, { signed: true, decimals: 0 })}` : "—"],
  ];
  return (
    <Panel
      title={t("my.titleTicker", { ticker: row.ticker })}
      actions={
        <Link href={links.trades({ ticker: row.ticker })} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary">
          {t("my.allTrades")} <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      }
    >
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
        {cells.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-xs text-muted-foreground">{k}</dt>
            <dd className="truncate font-medium tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}
