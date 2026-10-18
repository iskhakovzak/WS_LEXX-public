import { useState } from "react";
import { UserCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState, Panel, Pill, Segmented, toneOf } from "@/components/ds";
import { Skeleton } from "@/components/ui/skeleton";
import { useInsiders } from "./use-offerings-data";
import { fmtDay, type InsiderSummary } from "./types";
import { fmtUsd } from "@/lib/format";
import { humanizeApiError } from "@/lib/api/errors";
import { offeringsI18n } from "@/i18n/ns/offerings";

type Scope = "day" | "mine";

/** Buys vs sells split bar (open-market P vs S, $). */
export function BuySellBar({ s }: { s: InsiderSummary }) {
  const total = s.buys.usd + s.sells.usd;
  const buyPct = total > 0 ? (s.buys.usd / total) * 100 : 0;
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-[var(--glass-bg)]" role="img" aria-label={offeringsI18n.t("insiders.barAria", { buys: fmtUsd(s.buys.usd, { compact: true }), sells: fmtUsd(s.sells.usd, { compact: true }) })}>
      {total > 0 && <div className="h-full bg-up" style={{ width: `${buyPct}%` }} />}
      {total > 0 && <div className="h-full bg-down" style={{ width: `${100 - buyPct}%` }} />}
    </div>
  );
}

function InsiderRow({ s, onOpen }: { s: InsiderSummary; onOpen: (t: string) => void }) {
  const { t } = offeringsI18n.useT();
  const quiet = s.buys.count === 0 && s.sells.count === 0;
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(s.ticker)}
        className="flex w-full flex-col gap-1.5 rounded-xl px-2 py-2 text-left hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{s.ticker}</span>
          {s.buys.count > 0 && s.buyers >= 2 && <Pill tone="up" className="text-2xs">{t("insiders.cluster")}</Pill>}
          <span className={cn("ml-auto text-sm font-medium tabular-nums", quiet ? "text-muted-foreground" : s.netUsd >= 0 ? "text-up" : "text-down")}>
            {quiet ? t("insiders.quiet") : fmtUsd(s.netUsd, { signed: true, compact: true })}
          </span>
        </div>
        {!quiet && <BuySellBar s={s} />}
        <div className="flex flex-wrap gap-x-3 text-xs tabular-nums text-muted-foreground">
          <span className="text-up">↑ {s.buys.count} · {fmtUsd(s.buys.usd, { compact: true })}</span>
          <span className="text-down">↓ {s.sells.count} · {fmtUsd(s.sells.usd, { compact: true })}</span>
          {s.planSellPct != null && s.sells.count > 0 && <span>10b5-1: {s.planSellPct}%</span>}
          {s.lastBuyDate && <span>{t("insiders.lastBuy", { date: fmtDay(s.lastBuyDate) })}</span>}
        </div>
      </button>
    </li>
  );
}

/**
 * Open-market insider buys/sells (Form 4, codes P/S) for 90 days.
 * "По заявкам дня" = top dilution-risk names today; "Мои тикеры" = positions + watchlist.
 */
export function InsiderPanel({
  dayTickers,
  myTickers,
  onOpenTicker,
}: {
  dayTickers: string[];
  myTickers: string[];
  onOpenTicker: (t: string) => void;
}) {
  const { t } = offeringsI18n.useT();
  const [scope, setScope] = useState<Scope>(() => (myTickers.length ? "mine" : "day"));
  const tickers = scope === "day" ? dayTickers : myTickers;
  const q = useInsiders(tickers);
  const items = [...(q.data?.items ?? [])].sort((a, b) => Math.abs(b.netUsd) - Math.abs(a.netUsd));
  const netAll = items.reduce((s, i) => s + i.netUsd, 0);

  return (
    <Panel
      title={t("insiders.title")}
      icon={UserCheck}
      description={t("insiders.description")}
      actions={
        <Segmented<Scope>
          ariaLabel={t("insiders.scopeAria")}
          size="sm"
          value={scope}
          onChange={setScope}
          options={[
            { value: "day", label: t("insiders.scopeDay"), count: dayTickers.length },
            { value: "mine", label: t("insiders.scopeMine"), count: myTickers.length },
          ]}
        />
      }
    >
      {tickers.length === 0 ? (
        <EmptyState
          icon={UserCheck}
          title={scope === "mine" ? t("insiders.emptyMine") : t("insiders.emptyDay")}
          description={scope === "mine" ? t("insiders.emptyMineText") : t("insiders.emptyDayText")}
          className="py-8"
        />
      ) : q.isLoading ? (
        <div className="space-y-3" aria-busy="true" aria-label={t("insiders.loadingAria")}>
          {Array.from({ length: Math.min(6, tickers.length) }).map((_, i) => (
            <div key={i} className="space-y-1.5 px-2">
              <div className="flex justify-between"><Skeleton className="h-4 w-14 rounded-full" /><Skeleton className="h-4 w-16 rounded-full" /></div>
              <Skeleton className="h-1.5 w-full rounded-full" />
            </div>
          ))}
          <p className="px-2 text-xs text-muted-foreground">{t("insiders.loadingText")}</p>
        </div>
      ) : q.error ? (
        <p role="alert" className="px-2 text-sm text-down">{t("insiders.loadFailed", { message: humanizeApiError(q.error) })}</p>
      ) : (
        <>
          <div className="mb-2 flex items-baseline justify-between px-2">
            <span className="text-xs text-muted-foreground">{t("insiders.netBy", { count: items.length })}</span>
            <span className={cn("text-lg font-semibold tabular-nums", toneOf(netAll) === "up" ? "text-up" : toneOf(netAll) === "down" ? "text-down" : "text-foreground")}>
              {fmtUsd(netAll, { signed: true, compact: true })}
            </span>
          </div>
          <ul className="grid gap-0.5 md:grid-cols-2 xl:grid-cols-3">
            {items.map((s) => <InsiderRow key={s.ticker} s={s} onOpen={onOpenTicker} />)}
          </ul>
          {!!q.data?.missing.length && (
            <p className="mt-2 px-2 text-xs text-muted-foreground">{t("insiders.notInSec", { list: q.data.missing.join(", ") })}</p>
          )}
        </>
      )}
    </Panel>
  );
}
