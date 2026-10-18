/**
 * «Топ дня» — one trader-day in a side sheet: place, net, trades, then every ticker with side, trades, $ and fill times;
 * each ticker opens the desk-day chart of that ticker-date with this trader highlighted (links.deskDay(…, alias)).
 * The viewer's own day links to their day report; staff get the trader's day report.
 */
import { Link } from "wouter";
import { CandlestickChart, FileText } from "lucide-react";
import { Pill, toneOf, toneText } from "@/components/ds";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import { fmtDate, fmtTimeNY, fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { topDayI18n } from "@/i18n/ns/topDay";
import { useTraderDay, type TraderDay, type TraderDayTicker } from "./api";
import { AliasBadge, whoLabel } from "./TopLists";

function placeText(d: TraderDay): string {
  const t = topDayI18n.t;
  if (d.list === "profit") return t("sheet.placeProfit", { place: d.place });
  if (d.list === "loss") return t("sheet.placeLoss", { place: d.place });
  return t("sheet.flat");
}

function TickerRow({ tk, date, alias }: { tk: TraderDayTicker; date: string; alias: number }) {
  const { t } = topDayI18n.useT();
  const times = tk.firstAt ? t("sheet.times", { from: fmtTimeNY(tk.firstAt), to: tk.lastAt ? fmtTimeNY(tk.lastAt) : "…" }) : null;
  return (
    <li className="glass-panel flex items-center gap-3 rounded-xl px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-semibold">{tk.ticker}</span>
          <span className={cn("text-sm font-semibold tabular-nums", toneText(toneOf(tk.net)))}>
            {tk.net != null ? fmtUsd(tk.net, { signed: true, decimals: "auto" }) : <span className="text-xs font-normal text-muted-foreground">{t("sheet.hidden")}</span>}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <Pill tone={tk.side === "short" ? "down" : tk.side === "long" ? "up" : "neutral"} className="min-h-5 px-1.5 text-2xs">{t(`sheet.side.${tk.side}`)}</Pill>
          <span className="tabular-nums">{commonI18n.t("units.trades", { count: tk.trades })}</span>
          <span className="tabular-nums">{t("day.wl", { wins: tk.wins, losses: tk.losses })}</span>
          {times && <span className="tabular-nums">{times}</span>}
        </div>
      </div>
      <Link
        href={links.deskDay(tk.ticker, date, alias)}
        aria-label={t("sheet.chartAria", { ticker: tk.ticker })}
        title={t("sheet.chartAria", { ticker: tk.ticker })}
        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-primary ring-1 ring-primary/30 transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <CandlestickChart className="h-4 w-4" aria-hidden="true" />
        <span className="hidden min-[400px]:inline">{t("sheet.chart")}</span>
      </Link>
    </li>
  );
}

export function TraderDaySheet({ date, alias, staff, onClose }: { date: string | null; alias: number | null; staff: boolean; onClose: () => void }) {
  const { t } = topDayI18n.useT();
  const q = useTraderDay(date, alias);
  const d = q.data && q.data.date === date && q.data.alias === alias ? q.data : undefined;
  const open = !!date && alias != null;
  const who = d ? whoLabel(d) : alias != null ? t("trader", { n: alias }) : "";

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2.5">
            {d && <AliasBadge row={d} />}
            <span className="min-w-0 truncate">{date ? t("sheet.title", { who, date: fmtDate(date, "weekdayDayMonth") }) : who}</span>
          </SheetTitle>
          <SheetDescription asChild>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              {d ? (
                <>
                  <span className={cn("text-lg font-semibold tabular-nums", toneText(toneOf(d.net)))}>
                    {d.net != null ? fmtUsd(d.net, { signed: true, decimals: "auto" }) : t("sheet.hidden")}
                  </span>
                  <span>{placeText(d)}</span>
                  <span className="tabular-nums">{commonI18n.t("units.trades", { count: d.trades })} · {t("day.wl", { wins: d.wins, losses: d.losses })}</span>
                </>
              ) : <span>{t("loading")}</span>}
            </div>
          </SheetDescription>
        </SheetHeader>

        {q.isError ? (
          <QueryError error={q.error} onRetry={() => q.refetch()} />
        ) : !d ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            {Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}
          </div>
        ) : (
          <>
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("sheet.tickers")}</h3>
              <ul className="flex flex-col gap-2">
                {d.tickers.map((tk) => <TickerRow key={tk.ticker} tk={tk} date={d.date} alias={d.alias} />)}
              </ul>
            </section>
            {(d.me || (staff && d.name)) && (
              <Link
                href={d.me ? links.dayReport(d.date) : links.dayReport(d.date, d.name ?? undefined)}
                className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-primary hover:underline"
              >
                <FileText className="h-4 w-4" aria-hidden="true" />
                {d.me ? t("sheet.myReport") : t("sheet.traderReport")}
              </Link>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
