import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Eye, Lightbulb, LineChart, ArrowUpRight, Filter } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Pill } from "@/components/ds";
import { Skeleton } from "@/components/ui/skeleton";
import { http } from "@/lib/api/http";
import { STALE } from "@/lib/api/keys";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import { fmtCount, fmtPrice } from "@/lib/format";
import { discussionsI18n } from "@/i18n/ns/discussions";
import { commonI18n } from "@/i18n/ns/common";
import { personName } from "@/i18n";

type TickerContextData = {
  ticker: string;
  watchlist: { id: number; status: string; catalyst: string | null; targetPrice: string | null; stopPrice: string | null; score: number | null }[];
  ideas: { id: number; side: string | null; setup: string | null; status: string; trader: string | null; score: number | null; ideaDate: string | null }[];
  trades: { count: number; lastDate: string | null; traders: number; wins: number; losses: number };
  discussions: number;
};

// Side arrives as a code or, from older rows, as Russian text.
const isShort = (side: string) => /short|шорт/i.test(side); // i18n-ignore (matches stored values)

function TickerContextBody({ ticker, onFilter }: { ticker: string; onFilter?: (t: string) => void }) {
  const { data, isLoading, isError } = useQuery<TickerContextData>({
    queryKey: ["discussions-ticker-context", ticker],
    queryFn: ({ signal }) => http.get<TickerContextData>(`/api/discussions/ticker-context/${encodeURIComponent(ticker)}`, { signal }),
    staleTime: STALE.short,
  });
  const { t } = discussionsI18n.useT();
  const tc = commonI18n.useT().t;

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="text-base font-semibold tabular-nums">${ticker}</span>
        {data && <span className="text-xs text-muted-foreground">{t("ticker.threads", { count: data.discussions })}</span>}
      </div>
      {isLoading && <div className="space-y-2"><Skeleton className="h-10 rounded-xl" /><Skeleton className="h-10 rounded-xl" /></div>}
      {isError && <p className="text-xs text-down">{t("ticker.loadFailed")}</p>}
      {data && (
        <>
          <section className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="micro-label inline-flex items-center gap-1"><Eye className="h-3 w-3" aria-hidden="true" />{t("ticker.watchlist")}</span>
              <Link href={links.watchlist(data.ticker)} className="inline-flex items-center gap-0.5 text-xs text-primary hover:underline">{tc("actions.open")}<ArrowUpRight className="h-3 w-3" aria-hidden="true" /></Link>
            </div>
            {data.watchlist.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("ticker.notInWatchlist")}</p>
            ) : data.watchlist.slice(0, 2).map((w) => (
              <div key={w.id} className="rounded-xl bg-[var(--glass-bg)] px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <Pill tone="accent">{discussionsI18n.tryT(`ticker.watchStatus.${w.status}`) ?? w.status}</Pill>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {t("ticker.targetLabel")} <span className="text-up">{fmtPrice(w.targetPrice)}</span> · {t("ticker.stopLabel")} <span className="text-down">{fmtPrice(w.stopPrice)}</span>
                  </span>
                </div>
                {w.catalyst && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{w.catalyst}</p>}
              </div>
            ))}
          </section>
          <section className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="micro-label inline-flex items-center gap-1"><Lightbulb className="h-3 w-3" aria-hidden="true" />{t("ticker.ideas")}</span>
              <Link href="/trade-ideas" className="inline-flex items-center gap-0.5 text-xs text-primary hover:underline">{tc("actions.open")}<ArrowUpRight className="h-3 w-3" aria-hidden="true" /></Link>
            </div>
            {data.ideas.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("ticker.noIdeas")}</p>
            ) : data.ideas.slice(0, 3).map((i) => (
              <div key={i.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="flex min-w-0 items-center gap-1.5">
                  {i.side && <Pill tone={isShort(i.side) ? "down" : "up"}>{isShort(i.side) ? tc("trading.short") : tc("trading.long")}</Pill>}
                  <span className="truncate">{i.setup || tc("trading.noSetup")}</span>
                </span>
                <span className="shrink-0 text-muted-foreground">{personName(i.trader)} · {discussionsI18n.tryT(`ticker.ideaStatus.${i.status}`) ?? i.status}</span>
              </div>
            ))}
          </section>
          <section className="flex items-center justify-between gap-2 rounded-xl bg-[var(--glass-bg)] px-3 py-2">
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><LineChart className="h-3.5 w-3.5" aria-hidden="true" />{t("ticker.teamTrades")}</span>
            {data.trades.count > 0 ? (
              <Link href={links.trades({ ticker: data.ticker })} className="text-xs tabular-nums hover:underline" title={t("ticker.teamTradesTitle")}>
                {fmtCount(data.trades.count)} · <span className="text-up">+{data.trades.wins}</span> / <span className="text-down">−{data.trades.losses}</span>
                {data.trades.lastDate && <span className="text-muted-foreground"> · {data.trades.lastDate}</span>}
              </Link>
            ) : <span className="text-xs text-muted-foreground">{t("ticker.none")}</span>}
          </section>
        </>
      )}
      {onFilter && (
        <button type="button" onClick={() => onFilter(ticker)} className="chip inline-flex min-h-8 w-full items-center justify-center gap-1.5 px-3 text-xs font-medium">
          <Filter className="h-3.5 w-3.5" aria-hidden="true" />{t("ticker.threadsBy", { ticker })}
        </button>
      )}
    </div>
  );
}

/** Ticker chip / cashtag that opens a cross-section context popover. */
export function TickerLink({ ticker, onFilter, variant = "inline", className }: {
  ticker: string;
  onFilter?: (t: string) => void;
  variant?: "inline" | "chip";
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          aria-label={discussionsI18n.t("ticker.contextAria", { ticker })}
          className={cn(
            variant === "chip"
              ? "inline-flex min-h-6 items-center gap-1 rounded-full bg-primary/15 px-2 text-xs font-semibold tabular-nums text-primary hover:bg-primary/25"
              : "rounded px-0.5 font-semibold text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary",
            className,
          )}
        >
          ${ticker}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 max-w-[calc(100vw-2rem)] rounded-2xl p-4" align="start" onClick={(e) => e.stopPropagation()}>
        {open && <TickerContextBody ticker={ticker} onFilter={onFilter ? (t) => { setOpen(false); onFilter(t); } : undefined} />}
      </PopoverContent>
    </Popover>
  );
}
