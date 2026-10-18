import React, { useState, useMemo } from "react";
import { useTickerNews, type NewsItem } from "@/lib/market-intel";
import { safeHttpUrl } from "@/lib/url";
import { ExternalLink, Newspaper, FileText, TrendingUp, TrendingDown, Zap, AlertTriangle, Building2, Activity, ScrollText, Info, RefreshCw, History } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Pill, type Tone } from "@/components/ds";
import { cn } from "@/lib/utils";
import { fmtDate, fmtDateCustom, fmtRelative } from "@/lib/format";
import { marketWidgetsI18n } from "@/i18n/ns/marketWidgets";
import { commonI18n } from "@/i18n/ns/common";

type CategoryMeta = { readonly label: string; icon: React.ElementType; tone: Tone };
/** Category chips; codes like FDA / M&A / SEC stay as is, the rest are getters in the UI language. */
const cat = (key: "earnings" | "upgrade" | "downgrade" | "insider" | "offering" | "guidance" | "news", icon: React.ElementType, tone: Tone): CategoryMeta => ({
  icon, tone, get label() { return marketWidgetsI18n.t(`news.category.${key}`); },
});
const CATEGORY_META: Record<string, CategoryMeta> = {
  earnings: cat("earnings", TrendingUp, "warn"),
  fda: { label: "FDA", icon: Zap, tone: "purple" },
  upgrade: cat("upgrade", TrendingUp, "up"),
  downgrade: cat("downgrade", TrendingDown, "down"),
  insider: cat("insider", Building2, "warn"),
  "m&a": { label: "M&A", icon: Activity, tone: "accent" },
  offering: cat("offering", AlertTriangle, "down"),
  guidance: cat("guidance", ScrollText, "accent"),
  sec: { label: "SEC", icon: FileText, tone: "neutral" },
  news: cat("news", Newspaper, "neutral"),
};

/** «5 min ago» for the last week, a date after that. */
function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  if (!isFinite(diff) || diff < 0) return "";
  if (diff < 7 * 86_400_000) return fmtRelative(iso, { style: "short" });
  return fmtDate(iso, "dayMonth");
}

function isFresh(iso: string | null): boolean {
  if (!iso) return false;
  const diff = Date.now() - new Date(iso).getTime();
  return Number.isFinite(diff) && diff >= 0 && diff < 24 * 3600_000;
}

function NewsCategoryBadge({ category }: { category: string }) {
  const meta = CATEGORY_META[category] || CATEGORY_META.news;
  const Icon = meta.icon;
  return (
    <Pill tone={meta.tone} className="shrink-0 px-1.5 text-2xs">
      <Icon className="h-3 w-3" aria-hidden="true" />{meta.label}
    </Pill>
  );
}

function NewsRow({ item, compact }: { item: NewsItem; compact: boolean }) {
  const safeUrl = safeHttpUrl(item.url);
  const ago = timeAgo(item.publishedAt);
  const fresh = isFresh(item.publishedAt);
  const className = cn(
    "group block rounded-xl border border-transparent bg-[var(--glass-bg)] px-3 py-2.5 transition-colors",
    safeUrl && "cursor-pointer hover:border-[var(--glass-border)] hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
  );
  const inner = (
    <div className="flex items-start gap-2.5">
      <NewsCategoryBadge category={item.category} />
      <div className="min-w-0 flex-1">
        <div className={cn("leading-snug text-foreground", compact ? "text-sm" : "text-sm font-medium")}>{item.title}</div>
        {!compact && item.summary && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.summary}</p>}
        <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          {fresh && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-label={marketWidgetsI18n.t("news.fresh")} />}
          {item.source && <span className="truncate">{item.source}</span>}
          {ago && (
            <time dateTime={item.publishedAt ?? undefined} title={item.publishedAt ? fmtDate(item.publishedAt, "shortDateTime") : undefined} className="shrink-0 tabular-nums">
              {item.source ? "· " : ""}{ago}
            </time>
          )}
          {safeUrl && <ExternalLink className="ml-auto h-3 w-3 shrink-0 opacity-60 transition-opacity group-hover:opacity-100" aria-hidden="true" />}
        </div>
      </div>
    </div>
  );
  if (safeUrl) {
    return (
      <a href={safeUrl} target="_blank" rel="noopener noreferrer" className={className} aria-label={marketWidgetsI18n.t("news.newTab", { title: item.title })}>
        {inner}
      </a>
    );
  }
  return <div className={className}>{inner}</div>;
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex items-start gap-2 rounded-xl bg-[var(--glass-bg)] px-3 py-2.5">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--chart-3))]" aria-hidden="true" />
      <div className="space-y-0.5">
        <p className="text-sm text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

export function NewsFeed({
  ticker,
  limit = 12,
  compact = false,
  cutoffDate = null,
}: {
  ticker: string;
  limit?: number;
  compact?: boolean;
  /** When provided, only news published at or before this moment are shown (point-in-time). */
  cutoffDate?: string | Date | null;
}) {
  const { t } = marketWidgetsI18n.useT();
  const { data, isLoading, error, refetch, isFetching } = useTickerNews(ticker, { limit, before: cutoffDate });
  const items = useMemo(() => data?.items ?? [], [data]);
  const [rawFilter, setFilter] = useState<string>("all");
  const cutoffLabel = cutoffDate
    ? fmtDateCustom(cutoffDate, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    : null;

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    items.forEach((i) => counts.set(i.category, (counts.get(i.category) ?? 0) + 1));
    return Array.from(counts.entries());
  }, [items]);
  const freshCount = useMemo(() => items.filter((i) => isFresh(i.publishedAt)).length, [items]);

  // Fall back to "all" when the selected category disappears (ticker/data changed),
  // otherwise the list would stay empty with the filter buttons hidden.
  const filter = rawFilter === "all" || categories.some(([c]) => c === rawFilter) ? rawFilter : "all";
  const filtered = filter === "all" ? items : items.filter((i) => i.category === filter);

  if (!ticker) return null;

  return (
    <div className={cn("space-y-2.5", !compact && "p-1")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
            <Newspaper className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            {t("news.title", { ticker })}
          </span>
          {items.length > 0 && <span className="text-xs tabular-nums text-muted-foreground">{items.length}{freshCount ? ` · ${t("news.freshCount", { count: freshCount })}` : ""}</span>}
          {cutoffLabel && (
            <Pill tone="warn" className="text-2xs"><History className="h-3 w-3" aria-hidden="true" />{t("news.until", { date: cutoffLabel })}</Pill>
          )}
        </div>
        {categories.length > 1 && (
          <div className="flex max-w-full gap-1 overflow-x-auto" role="group" aria-label={t("news.filterAria")}>
            <button
              type="button"
              onClick={() => setFilter("all")}
              aria-pressed={filter === "all"}
              className="chip min-h-7 shrink-0 px-2.5 text-xs"
            >
              {t("news.all")}
            </button>
            {categories.map(([c, n]) => (
              <button
                key={c}
                type="button"
                onClick={() => setFilter(c)}
                aria-pressed={filter === c}
                className="chip min-h-7 shrink-0 px-2.5 text-xs"
              >
                {(CATEGORY_META[c] || CATEGORY_META.news).label} <span className="tabular-nums opacity-80">{n}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {isLoading && (
        <div className="space-y-2" aria-busy="true" aria-label={t("news.loading")}>
          {Array.from({ length: Math.min(3, limit) }).map((_, i) => <Skeleton key={i} className="h-14 w-full rounded-xl" />)}
        </div>
      )}
      {error && !isLoading && (
        <div className="flex items-center justify-between gap-2 rounded-xl bg-down/10 px-3 py-2.5 text-sm">
          <span className="flex items-center gap-1.5 text-down"><AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" /> {t("news.loadFailed")}</span>
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="chip inline-flex min-h-7 items-center gap-1 px-2.5 text-xs disabled:opacity-50"
          >
            <RefreshCw className={cn("h-3 w-3", isFetching && "animate-spin motion-reduce:animate-none")} aria-hidden="true" /> {commonI18n.t("actions.retry")}
          </button>
        </div>
      )}
      {!isLoading && !error && items.length === 0 && (
        <Notice
          title={cutoffLabel ? t("news.noneAtTrade", { ticker }) : t("news.noneRelevant", { ticker })}
          body={cutoffLabel ? t("news.noneAtTradeText") : t("news.noneRelevantText")}
        />
      )}
      {!isLoading && !error && items.length > 0 && items.length < 3 && (
        <Notice
          title={t("news.fewFound", { count: items.length, ticker })}
          body={t("news.fewFoundText")}
        />
      )}
      {!isLoading && !error && items.length > 0 && filtered.length === 0 && (
        <p className="py-2 text-sm text-muted-foreground">{t("news.noneInCategory")}</p>
      )}
      <div className="space-y-1.5">
        {filtered.map((item) => <NewsRow key={item.guid} item={item} compact={compact} />)}
      </div>
    </div>
  );
}
