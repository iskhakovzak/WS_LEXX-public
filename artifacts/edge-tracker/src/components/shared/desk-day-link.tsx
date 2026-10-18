/**
 * Tiny entry points to «Деск на тикере» (/desk-day): an inline link «Деск на этом тикере: N трейдеров» and a row of
 * ticker chips for a day. Rendered only when at least one OTHER trader traded the ticker that day, so they never show
 * an empty promise. Counts: GET /api/desk-day/:ticker/:date/summary and GET /api/desk-day/counts (cheap, indexed).
 * Shared on purpose: the trade sheet, the day report and the evening card all link here.
 */
import * as React from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Users } from "lucide-react";
import { http } from "@/lib/api/http";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import { commonI18n } from "@/i18n/ns/common";
import { deskDayI18n } from "@/i18n/ns/deskDay";

type Count = { ticker: string; traders: number; traded: boolean; others: number };

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const deskHref = (ticker: string, date: string) => links.deskDay(ticker.toUpperCase(), date);

/** Count of other traders on `ticker` that `date` (perspective: `trader`, default the viewer). */
export function useDeskDayCount(ticker: string | null | undefined, date: string | null | undefined, trader?: string | null) {
  const tk = (ticker ?? "").trim().toUpperCase();
  const d = (date ?? "").slice(0, 10);
  return useQuery<Count>({
    queryKey: ["desk-day", "summary", tk, d, trader ?? ""],
    queryFn: ({ signal }) => http.get<Count>(`/api/desk-day/${encodeURIComponent(tk)}/${d}/summary${trader ? `?trader=${encodeURIComponent(trader)}` : ""}`, { signal }),
    enabled: !!tk && YMD.test(d),
    staleTime: 5 * 60_000,
    retry: false,
    meta: { i18n: false },
  });
}

/** «· Деск на этом тикере: 8 трейдеров» — inline, for headers / meta lines. Nothing when no one else traded it. */
/** `lead` prefixes a « · » separator (inside the link, so nothing is left behind when it renders nothing). */
export function DeskDayLink({ ticker, date, trader, className, lead }: { ticker: string; date: string; trader?: string | null; className?: string; lead?: boolean }) {
  const { t } = deskDayI18n.useT();
  const q = useDeskDayCount(ticker, date, trader);
  const others = q.data?.others ?? 0;
  if (others < 1) return null;
  const d = date.slice(0, 10);
  return (
    <Link href={deskHref(ticker, d)} aria-label={t("link.aria", { ticker: ticker.toUpperCase(), date: d })} className={cn("inline-flex items-center gap-1 text-primary hover:underline", className)}>
      {lead && "· "}<Users className="h-3.5 w-3.5" aria-hidden="true" /> {t("link.label", { traders: commonI18n.t("units.traders", { count: others }) })}
    </Link>
  );
}

/** Chips «META · 8 трейдеров» for the tickers of one day that other traders also traded (day report). */
export function DeskDayChips({ tickers, date, trader, className }: { tickers: readonly string[]; date: string; trader?: string | null; className?: string }) {
  const { t } = deskDayI18n.useT();
  const list = React.useMemo(() => [...new Set(tickers.map((x) => x.trim().toUpperCase()).filter(Boolean))].slice(0, 50).sort(), [tickers]);
  const q = useQuery<{ date: string; items: Count[] }>({
    queryKey: ["desk-day", "counts", date, list.join(","), trader ?? ""],
    queryFn: ({ signal }) => http.get(`/api/desk-day/counts?date=${date}&tickers=${encodeURIComponent(list.join(","))}${trader ? `&trader=${encodeURIComponent(trader)}` : ""}`, { signal }),
    enabled: list.length > 0 && YMD.test(date),
    staleTime: 5 * 60_000,
    retry: false,
    meta: { i18n: false },
  });
  const items = (q.data?.items ?? []).filter((c) => c.others >= 1).sort((a, b) => b.others - a.others);
  if (!items.length) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)} data-print-hide>
      <span className="micro-label">{t("link.chips")}</span>
      {items.map((c) => (
        <Link
          key={c.ticker}
          href={deskHref(c.ticker, date)}
          aria-label={t("link.aria", { ticker: c.ticker, date })}
          className="glass-field inline-flex min-h-8 items-center gap-1.5 px-3 text-sm font-medium hover:text-primary"
        >
          <Users className="h-3.5 w-3.5" aria-hidden="true" />
          {t("link.chip", { ticker: c.ticker, traders: commonI18n.t("units.traders", { count: c.others }) })}
        </Link>
      ))}
    </div>
  );
}
