import { CalendarDays, LockOpen, Rocket } from "lucide-react";
import { EmptyState, Panel, Pill, SortableTh, UpdatedAgo, useTableSort } from "@/components/ds";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { SignedPct } from "./bits";
import { isMissingEndpoint, useIpoCalendar } from "./use-offerings-data";
import {
  fmtDay, fmtM, todayNY,
  type IpoCalendarItem, type IpoCalendarResponse, type IpoQuoted, type IpoRow, type Offering,
} from "./types";
import { fmtCompact, fmtPrice } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { offeringsI18n } from "@/i18n/ns/offerings";

type Lockup = IpoCalendarResponse["lockups"][number];
type LockupKey = "date" | "ticker" | "pct" | "unlock" | "mcap";
const LOCKUP_ACCESSORS: Record<LockupKey, (c: Lockup) => number | string | null> = {
  date: (c) => c.daysLeft,
  ticker: (c) => c.ticker,
  pct: (c) => c.pctFromIpo,
  unlock: (c) => c.unlockMultiple,
  mcap: (c) => c.marketCapM,
};

/** Turn a calendar row into an Offering so the same detail sheet can open it. */
export function calendarToOffering(c: IpoCalendarItem | IpoRow | IpoQuoted): Offering {
  const q = c as Partial<IpoQuoted>;
  return {
    ticker: c.ticker, company: c.company, type: "IPO", date: c.date,
    offerPrice: c.offerPrice, currentPrice: q.currentPrice ?? null,
    priceChangePct: q.pctFromIpo ?? null,
    dealSizeM: c.dealSizeM, sharesOffered: c.sharesOffered,
    sharesOutstandingBefore: null, sharesOutstandingAfter: null, dilutionPct: null,
    sellerType: "company", insiderShares: null, companyShares: c.sharesOffered,
    underwriter: (c as IpoRow).underwriter ?? null, lockupDays: c.status === "withdrawn" ? null : 180,
    volume: null, avgVolume: q.avgVolume ?? null, relVol: null, marketCapM: q.marketCapM ?? null, sector: null,
    rating: 50, ratingFactors: [],
    status: c.status === "filed" ? "filed" : c.status,
    source: "nasdaq", kind: "IPO", form: "IPO", exchange: c.exchange, priceRange: c.priceRange,
    dealFlags: [], riskFactors: [],
  };
}

function TickerBtn({ t, onClick, muted }: { t: string; onClick: () => void; muted?: boolean }) {
  return (
    <button type="button" onClick={onClick}
      className={cn("rounded font-semibold hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", muted ? "text-muted-foreground line-through" : "text-foreground")}>
      {t}
    </button>
  );
}

function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => <Skeleton key={i} className="h-9 w-full rounded-lg" />)}
    </div>
  );
}

const NO_LOCKUPS: Lockup[] = [];

/**
 * IPO calendar and lock-up expirations side by side (one row at xl, stacked below).
 * Falls back to the IPO list from the day payload while the dedicated endpoint is not deployed.
 */
export function IpoLockupView({ fallback, onPick }: { fallback: IpoCalendarItem[]; onPick: (o: Offering) => void }) {
  const { t } = offeringsI18n.useT();
  const q = useIpoCalendar(true);
  const missing = isMissingEndpoint(q.error);
  const today = todayNY();
  const upcoming: IpoRow[] = q.data?.upcoming
    ?? fallback.filter((c) => c.status === "upcoming" && c.date >= today).map((c) => ({ ...c, underwriter: null }));
  const recent = q.data?.recent ?? [];
  const { rows: lockups, thProps } = useTableSort(q.data?.lockups ?? NO_LOCKUPS, LOCKUP_ACCESSORS, "date", "asc");
  const loading = q.isLoading;

  return (
    <div className="grid min-w-0 items-start gap-[var(--grid-gap)] xl:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-[var(--grid-gap)]">
        <Panel title={t("ipo.upcoming")} icon={CalendarDays}
          description={q.data ? t("ipo.upcomingNasdaq") : t("ipo.upcomingCalendar")}
          actions={q.data ? <UpdatedAgo at={q.data.fetchedAt} /> : undefined}>
          {loading ? <ListSkeleton rows={4} /> : upcoming.length === 0 ? (
            <EmptyState compact icon={CalendarDays} title={t("ipo.noUpcoming")} description={q.data && !q.data.sources.nasdaq ? t("ipo.nasdaqDown") : t("ipo.nasdaqEmpty")} />
          ) : (
            <ul className="divide-y divide-border/50 text-sm">
              {upcoming.slice(0, 20).map((c) => (
                <li key={`${c.ticker}-${c.date}`} className="flex items-center gap-3 py-1.5">
                  <span className="w-20 shrink-0 tabular-nums text-muted-foreground">{fmtDay(c.date, "weekdayDayMonth")}</span>
                  <TickerBtn t={c.ticker} onClick={() => onPick(calendarToOffering(c))} />
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={c.company}>{c.company}</span>
                  <span className="shrink-0 text-right text-xs tabular-nums text-foreground">{c.priceRange ? `$${c.priceRange}` : "—"}</span>
                  <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{fmtM(c.dealSizeM)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title={t("ipo.recent")} icon={Rocket} description={t("ipo.recentDescription")}>
          {loading ? <ListSkeleton rows={5} /> : missing ? (
            <EmptyState compact icon={Rocket} title={t("ipo.needsServer")} description={t("ipo.needsServerRecent")} />
          ) : recent.length === 0 ? (
            <EmptyState compact icon={Rocket} title={t("ipo.noRecent")} />
          ) : (
            <ul className="divide-y divide-border/50 text-sm">
              {recent.slice(0, 20).map((c) => (
                <li key={`${c.ticker}-${c.date}`} className="flex items-center gap-3 py-1.5">
                  <span className="w-16 shrink-0 tabular-nums text-muted-foreground">{fmtDay(c.date)}</span>
                  <TickerBtn t={c.ticker} onClick={() => onPick(calendarToOffering(c))} />
                  {c.spac && <Pill tone="neutral" className="px-1.5 text-2xs">SPAC</Pill>}
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={c.company}>{c.company}</span>
                  <span className="shrink-0 text-right text-xs tabular-nums text-muted-foreground">{fmtPrice(c.offerPrice, { dollar: true })} → {fmtPrice(c.currentPrice, { dollar: true })}</span>
                  <span className="w-16 shrink-0 text-right text-xs"><SignedPct value={c.pctFromIpo} /></span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title={t("ipo.lockups")} icon={LockOpen}
        description={t("ipo.lockupsDescription")}
        actions={q.data ? <UpdatedAgo at={q.data.fetchedAt} /> : undefined}>
        {loading ? <ListSkeleton rows={8} /> : missing ? (
          <EmptyState compact icon={LockOpen} title={t("ipo.needsServer")} description={t("ipo.needsServerLockups")} />
        ) : lockups.length === 0 ? (
          <EmptyState compact icon={LockOpen} title={t("ipo.noLockups")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm tabular-nums">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <SortableTh {...thProps("date")} className="py-1.5 pr-2 font-medium">{t("ipo.colDate")}</SortableTh>
                  <SortableTh {...thProps("ticker")} className="px-2 py-1.5 font-medium">{commonI18n.t("trading.ticker")}</SortableTh>
                  <SortableTh {...thProps("pct")} align="right" className="px-2 py-1.5 font-medium">{t("ipo.colIpoNow")}</SortableTh>
                  <SortableTh {...thProps("unlock")} align="right" className="px-2 py-1.5 font-medium">
                    <span title={t("ipo.unlockTitle")}>{t("ipo.colUnlock")}</span>
                  </SortableTh>
                  <SortableTh {...thProps("mcap")} align="right" className="py-1.5 pl-2 font-medium">{t("ipo.colMcap")}</SortableTh>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {lockups.map((c) => {
                  const past = c.daysLeft < 0;
                  const soon = c.daysLeft >= 0 && c.daysLeft <= 5;
                  return (
                    <tr key={`${c.ticker}-${c.lockupDate}`} className={cn(past && "text-muted-foreground")}>
                      <td className="whitespace-nowrap py-1.5 pr-2">
                        {fmtDay(c.lockupDate)}
                        <span className={cn("ml-1.5 text-2xs", soon ? "font-medium text-[hsl(var(--chart-3))]" : "text-muted-foreground")}>
                          {past ? t("ipo.daysAgo", { count: -c.daysLeft }) : c.daysLeft === 0 ? t("ipo.today") : t("ipo.inDays", { count: c.daysLeft })}
                        </span>
                      </td>
                      <td className="px-2 py-1.5">
                        <span className="inline-flex items-center gap-2">
                          <TickerBtn t={c.ticker} onClick={() => onPick(calendarToOffering(c))} />
                          <span className="hidden max-w-[10rem] truncate text-2xs text-muted-foreground sm:inline" title={c.company}>{c.company}</span>
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-right text-xs">
                        <span className="text-muted-foreground">{fmtPrice(c.offerPrice, { dollar: true })} → {fmtPrice(c.currentPrice, { dollar: true })} </span>
                        <SignedPct value={c.pctFromIpo} />
                      </td>
                      <td className="px-2 py-1.5 text-right text-xs" title={c.sharesOffered ? t("ipo.ipoShares", { shares: fmtCompact(c.sharesOffered) }) : undefined}>
                        {c.unlockMultiple != null ? <span className={c.unlockMultiple >= 3 ? "text-down" : "text-foreground"}>{c.unlockMultiple}×</span> : "—"}
                      </td>
                      <td className="py-1.5 pl-2 text-right text-xs text-muted-foreground">{fmtM(c.marketCapM)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-2 text-2xs text-muted-foreground">{t("ipo.footnote")}</p>
          </div>
        )}
      </Panel>
    </div>
  );
}
