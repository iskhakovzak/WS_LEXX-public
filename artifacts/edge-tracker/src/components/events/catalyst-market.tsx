// «Катализаторы» → «Крупные отчёты рынка»: the biggest reporters that move the open of a day (previous
// session after close + the day before the open), outside the trader's own tickers — with the pre/after-hours
// reaction when the watch feed has it and a one-click «в «Сегодня»» into the shared watchlist.
import * as React from "react";
import { Check, ChevronDown, Flame, Loader2, TrendingUp } from "lucide-react";
import { Pill, toneOf, toneText } from "@/components/ds";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/contexts/auth-context";
import { cn } from "@/lib/utils";
import { CallTypePill } from "@/components/research/earnings-history";
import { type EarningsItem, type UpcomingItem } from "@/components/shared/market/earnings-api";
import { fmtCompact } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { useQuickAddToWatchlist } from "@/components/watchlist/use-quick-add";
import { fmtDay } from "./event-meta";
import type { CatalystData, MyEarnings } from "./use-catalysts";
import { eventsI18n } from "@/i18n/ns/events";

type Reporter = UpcomingItem & Partial<Pick<EarningsItem, "pricePreMarket" | "pricePostMarket">> & { date: string };

const SHOW = 6;

/** Extended-hours reaction in %: premarket first (the open), else after-hours. */
export function reactionOf(r: Pick<Reporter, "pricePreMarket" | "pricePostMarket">): { kind: "pre" | "post"; label: string; pct: number } | null {
  if (r.pricePreMarket != null && Number.isFinite(r.pricePreMarket)) return { kind: "pre", label: eventsI18n.t("market.pre"), pct: r.pricePreMarket };
  if (r.pricePostMarket != null && Number.isFinite(r.pricePostMarket)) return { kind: "post", label: eventsI18n.t("market.post"), pct: r.pricePostMarket };
  return null;
}

/** Market reporters for `day`: AMC of the previous session + BMO/TNS of the day (prices from /earnings/watch when it covers them). */
export function marketReporters(data: CatalystData, day: string, prev: string) {
  const mine = new Set(data.myTickers);
  const w = data.watch.data;
  const fromUpcoming = (d: string) => data.upcoming.data?.days.find((x) => x.date === d)?.items ?? [];
  const priced = new Map<string, EarningsItem>();
  if (w) for (const e of [...w.amc, ...w.bmo]) priced.set(e.ticker.toUpperCase(), e);
  const enrich = (e: UpcomingItem, date: string): Reporter => {
    const p = priced.get(e.ticker.toUpperCase());
    return { ...e, date, pricePreMarket: p?.pricePreMarket ?? null, pricePostMarket: p?.pricePostMarket ?? null };
  };
  // Only real after-close reports of the previous session move this open (its BMO / unknown-time ones already reacted).
  const before = (w?.amcDate === prev ? w.amc : fromUpcoming(prev)).filter((e) => e.callType === "AMC").map((e) => enrich(e, prev));
  const same = (w?.date === day && w.bmo.length ? w.bmo : fromUpcoming(day).filter((e) => e.callType !== "AMC")).map((e) => enrich(e, day));
  const after = fromUpcoming(day).filter((e) => e.callType === "AMC").map((e) => enrich(e, day));
  const pick = (xs: Reporter[]) => {
    const seen = new Set<string>();
    return xs
      .filter((e) => { const t = e.ticker.toUpperCase(); if (mine.has(t) || seen.has(t)) return false; seen.add(t); return true; })
      .sort((a, b) => (b.marketCapNum ?? 0) - (a.marketCapNum ?? 0));
  };
  return { open: pick([...before, ...same]), after: pick(after) };
}

function ReporterLine({ e, inWatch, canAdd, busy, onAdd, onOpen }: {
  e: Reporter;
  inWatch: boolean;
  canAdd: boolean;
  busy: boolean;
  onAdd: () => void;
  onOpen: () => void;
}) {
  const { t } = eventsI18n.useT();
  const rx = reactionOf(e);
  return (
    <li className="group grid grid-cols-[4.5rem_minmax(0,1fr)_auto_3.5rem_6.5rem_7.5rem] items-center gap-x-3 rounded-xl px-3 py-1.5 hover:bg-[var(--glass-hover-bg)]">
      <button
        type="button"
        onClick={onOpen}
        className="truncate text-left text-sm font-semibold text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        title={t("market.historyTitle", { ticker: e.ticker })}
      >
        {e.ticker}
      </button>
      <span className="min-w-0 truncate text-xs text-muted-foreground" title={e.company}>{e.company}</span>
      <CallTypePill type={e.callType} />
      <span className="text-right text-xs tabular-nums text-muted-foreground" title={t("market.marketCap")}>{fmtCompact(e.marketCapNum)}</span>
      <span
        className={cn("text-right text-xs tabular-nums", rx ? (Math.abs(rx.pct) >= 5 ? cn("font-semibold", toneText(toneOf(rx.pct))) : toneText(toneOf(rx.pct))) : "text-muted-foreground")}
        title={rx ? (rx.kind === "pre" ? t("market.preTitle") : t("market.postTitle")) : t("market.noReaction")}
      >
        {rx ? `${rx.label} ${rx.pct > 0 ? "+" : rx.pct < 0 ? "−" : ""}${Math.abs(rx.pct).toFixed(1)}%` : "—"}
      </span>
      <span className="flex justify-end">
        {inWatch ? (
          <span className="inline-flex h-7 items-center gap-1 px-2 text-xs text-muted-foreground"><Check className="h-3.5 w-3.5" aria-hidden="true" />{t("market.inWatchlist")}</span>
        ) : canAdd ? (
          <button
            type="button"
            onClick={onAdd}
            disabled={busy}
            className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-medium text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            title={t("market.addTitle", { ticker: e.ticker })}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Flame className="h-3.5 w-3.5" aria-hidden="true" />}
            {t("market.addToToday")}
          </button>
        ) : null}
      </span>
    </li>
  );
}

function Group({ title, rows, data, onOpen, add }: {
  title: string;
  rows: Reporter[];
  data: CatalystData;
  onOpen: (e: MyEarnings) => void;
  add: ReturnType<typeof useQuickAddToWatchlist>;
}) {
  const { canEdit } = useAuth();
  const { t } = eventsI18n.useT();
  const [all, setAll] = React.useState(false);
  if (!rows.length) return null;
  const shown = all ? rows : rows.slice(0, SHOW);
  return (
    <div>
      <p className="px-3 text-xs text-muted-foreground">{title}</p>
      <ul className="-mx-3 mt-0.5">
        {shown.map((e) => (
          <ReporterLine
            key={`${e.date}-${e.ticker}`}
            e={e}
            inWatch={data.watchSet.has(e.ticker.toUpperCase())}
            canAdd={canEdit}
            busy={add.busy === e.ticker.toUpperCase()}
            onAdd={() => void add.add(e.ticker, "today")}
            onOpen={() => onOpen({ ...e, mine: "watch" })}
          />
        ))}
      </ul>
      {rows.length > SHOW && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="mt-0.5 inline-flex items-center gap-1 rounded px-0 text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={all}
        >
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-[var(--dur-1)]", all && "rotate-180")} aria-hidden="true" />
          {all ? commonI18n.t("actions.collapse") : t("market.more", { count: rows.length - SHOW })}
        </button>
      )}
    </div>
  );
}

/** Section of the day brief: top market reporters around `day`'s open (not the trader's own tickers). */
export function MarketReporters({ day, prev, data, onOpenTicker }: {
  day: string;
  prev: string;
  data: CatalystData;
  onOpenTicker: (e: MyEarnings) => void;
}) {
  const add = useQuickAddToWatchlist();
  const { t } = eventsI18n.useT();
  const { open, after } = React.useMemo(() => marketReporters(data, day, prev), [data, day, prev]);
  const loading = data.upcoming.isLoading || data.watch.isLoading;
  return (
    <section aria-label={t("market.title")}>
      <h3 className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" /> {t("market.title")}
        {open.length + after.length > 0 && <Pill tone="neutral" className="ml-1 normal-case tracking-normal">{open.length + after.length}</Pill>}
      </h3>
      {loading ? (
        <Skeleton className="h-14 w-full rounded-xl" />
      ) : open.length || after.length ? (
        <div className="flex flex-col gap-2">
          <Group title={open.some((e) => e.date === prev) ? t("market.toOpenPrev", { date: fmtDay(prev) }) : t("market.toOpen")} rows={open} data={data} onOpen={onOpenTicker} add={add} />
          <Group title={t("today.afterClose")} rows={after} data={data} onOpen={onOpenTicker} add={add} />
        </div>
      ) : (
        <p className="py-2 text-sm text-muted-foreground">{t("market.empty")}</p>
      )}
    </section>
  );
}
