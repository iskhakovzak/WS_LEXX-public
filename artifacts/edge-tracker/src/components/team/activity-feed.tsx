import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { ArrowUpRight, ChevronDown, ChevronLeft, ChevronRight, List, Newspaper, NotebookPen, Trophy } from "lucide-react";
import { Pill, toneOf, toneText } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { links } from "@/lib/links";
import { KPI_FORMULAS } from "@/lib/trade-math";
import { TraderAvatar } from "./trader-avatar";
import { fmtCount, fmtDate, fmtR, fmtRate, fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { personName } from "@/i18n";
import {
  actionTone,
  describe,
  describeBurst,
  itemHref,
  itemTitle,
  relTime,
  sectionMeta,
  timeLabel,
  type ActivitySummary,
  type Burst,
  type FeedItem,
  detailsText,
  isExampleChange,
  ratingLabel,
} from "./activity-model";
import { activityI18n } from "@/i18n/ns/activity";

const SOCIAL = new Set(["reviewed", "commented", "reacted", "liked", "rated", "acknowledged"]);

function actorName(t: string | null) {
  return !t || t === "system" ? activityI18n.t("system") : personName(t);
}

function UnreadDot({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span className="absolute left-0 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-primary" aria-label={activityI18n.t("newAria")} role="img" />
  );
}

/** One activity row: avatar, sentence, quoted detail, section pill, time, open action. */
export function FeedRow({ item, unread }: { item: FeedItem; unread: boolean }) {
  const { t } = activityI18n.useT();
  const meta = sectionMeta(item.section);
  const href = itemHref(item);
  const tone = actionTone(item.action);
  const Icon = meta.icon;
  const social = SOCIAL.has(item.action);
  const title = itemTitle(item);
  return (
    <li className={cn("relative flex items-start gap-3 rounded-xl py-2.5 pl-4 pr-2 transition-colors hover:bg-[var(--glass-hover-bg)]", unread && "bg-primary/[0.06]")}>
      <UnreadDot show={unread} />
      <TraderAvatar name={item.trader} size="sm" className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug">
          <span className="font-semibold">{actorName(item.trader)}</span>
          <span className="text-muted-foreground">: {describe(item)}</span>
          {title && (
            <>
              {" "}
              {href ? (
                <Link href={href} className="rounded font-semibold text-foreground underline-offset-2 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {title}
                </Link>
              ) : (
                <span className={cn("font-semibold", item.action === "deleted" && !isExampleChange(item) && "text-muted-foreground line-through decoration-down/60")}>{title}</span>
              )}
            </>
          )}
        </p>
        {item.details && item.section !== "digest" && (
          <p
            className={cn(
              "mt-1 line-clamp-2 break-words text-xs text-muted-foreground",
              social && "border-l-2 border-border pl-2 italic",
            )}
          >
            {detailsText(item)}
          </p>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Pill tone={tone} className="text-2xs">
            <Icon className="h-3 w-3" aria-hidden="true" />
            {meta.label}
          </Pill>
          {item.rating && <Pill tone="purple" className="text-2xs">{t("ratingPill", { rating: ratingLabel(item.rating) })}</Pill>}
          <time
            dateTime={item.createdAt}
            title={fmtDate(item.createdAt, "shortDateTime")}
            className="text-xs tabular-nums text-muted-foreground sm:hidden"
          >
            {timeLabel(item.createdAt)}
          </time>
        </div>
      </div>
      <time
        dateTime={item.createdAt}
        title={`${fmtDate(item.createdAt, "shortDateTime")} · ${relTime(item.createdAt)}`}
        className="hidden shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground sm:block"
      >
        {timeLabel(item.createdAt)}
      </time>
      {href && (
        <Button asChild variant="ghost" size="icon" className="h-8 w-8 shrink-0">
          <Link href={href} aria-label={t("openAria", { title: title ?? meta.label })}>
            <ArrowUpRight />
          </Link>
        </Button>
      )}
    </li>
  );
}

/** A collapsed run of ≥3 identical actions («Закир: удалено 12 сделок»), expandable. */
export function BurstRow({ burst, isUnread }: { burst: Burst; isUnread: (it: FeedItem) => boolean }) {
  const { t } = activityI18n.useT();
  const [open, setOpen] = useState(false);
  const first = burst.items[0];
  const last = burst.items[burst.items.length - 1];
  const meta = sectionMeta(first.section);
  const Icon = meta.icon;
  const unread = burst.items.some(isUnread);
  const titles = burst.items.map(itemTitle).filter(Boolean) as string[];
  const uniq = [...new Set(titles)];
  return (
    <li className="relative">
      <div className={cn("relative flex items-start gap-3 rounded-xl py-2.5 pl-4 pr-2 transition-colors hover:bg-[var(--glass-hover-bg)]", unread && "bg-primary/[0.06]")}>
        <UnreadDot show={unread} />
        <TraderAvatar name={first.trader} size="sm" className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-snug">
            <span className="font-semibold">{actorName(first.trader)}</span>
            <span className="text-muted-foreground">: {describeBurst(first.action, first.section, burst.items.length, isExampleChange(first))}</span>
          </p>
          {uniq.length > 0 && (
            <p className="mt-1 truncate text-xs text-muted-foreground" title={uniq.join(", ")}>
              {uniq.length > 8 ? t("moreTitles", { list: uniq.slice(0, 8).join(", "), count: uniq.length - 8 }) : uniq.join(", ")}
            </p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Pill tone={actionTone(first.action)} className="text-2xs">
              <Icon className="h-3 w-3" aria-hidden="true" />
              {meta.label}
            </Pill>
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              className="chip inline-flex min-h-7 items-center gap-1 px-2.5 text-xs"
            >
              {open ? commonI18n.t("actions.collapse") : t("showAllCount", { count: burst.items.length })}
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} aria-hidden="true" />
            </button>
          </div>
        </div>
        <span className="shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">
          {timeLabel(last.createdAt)}–{timeLabel(first.createdAt)}
        </span>
      </div>
      {open && (
        <ul className="ml-7 border-l border-border pl-2">
          {burst.items.map((it) => (
            <FeedRow key={it.uid} item={it} unread={isUnread(it)} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Daily digest card shown above the feed. */
export function DigestCard({
  summary,
  loading,
  unavailable,
  dayLabel,
  canNext,
  onPrev,
  onNext,
  onPickSection,
  onPickTrader,
  tradesHref,
  journalHref,
}: {
  summary: ActivitySummary | undefined;
  loading: boolean;
  unavailable?: boolean;
  dayLabel: string;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onPickSection: (section: string) => void;
  onPickTrader: (trader: string) => void;
  /** Cross-links for the day (trades of the day, journal day). */
  tradesHref?: string;
  journalHref?: string;
}) {
  const { t: tr } = activityI18n.useT();
  const sections = new Map<string, number>();
  for (const r of summary?.bySection ?? []) {
    if (r.section === "digest") continue;
    sections.set(r.section, (sections.get(r.section) ?? 0) + r.count);
  }
  const sectionList = [...sections.entries()].sort((a, b) => b[1] - a[1]);
  const t = summary?.trades;
  const wr = t && t.wins + t.losses ? t.wins / (t.wins + t.losses) : null;
  const social = (summary?.bySection ?? []).filter((r) => SOCIAL.has(r.action)).reduce((s, r) => s + r.count, 0);
  const total = sectionList.reduce((s, [, n]) => s + n, 0);

  return (
    <section className="glass-panel overflow-hidden rounded-2xl" aria-label={tr("digest.title")}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4 sm:px-5">
        <div className="flex items-center gap-2">
          <Newspaper className="h-4 w-4 text-primary" aria-hidden="true" />
          <h2 className="text-sm font-semibold">{tr("digest.title")}</h2>
          <span className="text-sm text-muted-foreground">· {dayLabel}</span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onPrev} aria-label={tr("digest.prevDay")}>
            <ChevronLeft />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onNext} disabled={!canNext} aria-label={tr("digest.nextDay")}>
            <ChevronRight />
          </Button>
        </div>
      </div>

      {unavailable ? (
        <p className="px-4 pb-4 pt-3 text-sm text-muted-foreground sm:px-5">{tr("digest.unavailable")}</p>
      ) : loading ? (
        <div className="grid grid-cols-2 gap-3 p-4 sm:p-5 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 p-4 sm:p-5 md:grid-cols-[repeat(3,minmax(0,1fr))_minmax(0,1.3fr)]">
          <DigestStat label={tr("digest.teamActions")} value={fmtCount(total)} hint={social ? tr("digest.socialHint", { count: social }) : tr("digest.noSocial")} />
          <DigestStat
            label={tr("digest.tradesOfDay")}
            value={fmtCount(t?.count ?? 0)}
            hint={t?.count ? tr("digest.tradesHint", { wr: fmtRate(wr), count: t.traders }) : tr("digest.nobodyTraded")}
          />
          <DigestStat
            label={t?.net != null ? tr("digest.netAndR") : tr("digest.sumR")}
            value={t?.net != null ? fmtUsd(t.net, { signed: true }) : t?.sumR != null ? fmtR(t.sumR) : "—"}
            valueClass={toneText(toneOf(t?.net ?? t?.sumR))}
            hint={t?.net != null ? `${fmtR(t.sumR)}${t.avgR != null ? ` · ${tr("digest.avg", { value: fmtR(t.avgR) })}` : ""}` : t?.avgR != null ? tr("digest.avg", { value: fmtR(t.avgR) }) : undefined}
            title={t?.net != null ? KPI_FORMULAS.netPnl : KPI_FORMULAS.expectancyR}
          />
          <div className="flex min-w-0 flex-col gap-2">
            <span className="text-xs text-muted-foreground">{tr("digest.mostActive")}</span>
            {summary?.topTraders.length ? (
              <div className="flex flex-wrap gap-1.5">
                {summary.topTraders.map((x) => (
                  <button
                    key={x.trader}
                    type="button"
                    onClick={() => onPickTrader(x.trader)}
                    className="chip inline-flex min-h-8 items-center gap-1.5 py-0.5 pl-0.5 pr-2.5 text-xs"
                    aria-label={tr("digest.traderChipAria", { name: personName(x.trader), count: x.count })}
                  >
                    <TraderAvatar name={x.trader} size="xs" />
                    <span className="font-medium text-foreground">{personName(x.trader)}</span>
                    <span className="tabular-nums">{fmtCount(x.count)}</span>
                  </button>
                ))}
              </div>
            ) : (
              <span className="text-sm text-muted-foreground">{tr("digest.quiet")}</span>
            )}
          </div>
        </div>
      )}

      {!loading && !unavailable && (sectionList.length > 0 || t?.best || tradesHref || journalHref) && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3 sm:px-5">
          {sectionList.map(([s, n]) => {
            const m = sectionMeta(s);
            const Icon = m.icon;
            return (
              <button
                key={s}
                type="button"
                onClick={() => onPickSection(s)}
                className="chip inline-flex min-h-8 items-center gap-1.5 px-3 text-xs"
                aria-label={tr("digest.filterAria", { name: m.label })}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                {m.label}
                <span className="tabular-nums">{fmtCount(n)}</span>
              </button>
            );
          })}
          <span className="ml-auto flex flex-wrap items-center gap-2">
          {tradesHref && !!t?.count && (
            <Link href={tradesHref} className="chip inline-flex min-h-8 items-center gap-1.5 px-3 text-xs">
              <List className="h-3.5 w-3.5" aria-hidden="true" />
              {tr("digest.dayTrades")}
            </Link>
          )}
          {journalHref && (
            <Link href={journalHref} className="chip inline-flex min-h-8 items-center gap-1.5 px-3 text-xs">
              <NotebookPen className="h-3.5 w-3.5" aria-hidden="true" />
              {tr("digest.dayJournal")}
            </Link>
          )}
          {t?.best && (
            <Link
              href={links.trade(t.best.id)}
              className="chip inline-flex min-h-8 items-center gap-1.5 px-3 text-xs"
            >
              <Trophy className="h-3.5 w-3.5 text-[hsl(var(--chart-3))]" aria-hidden="true" />
              {tr("digest.bestTrade")} <span className="font-semibold text-foreground">{t.best.ticker}</span>
              <span className={cn("tabular-nums", toneText(toneOf(t.best.rMultiple)))}>{fmtR(t.best.rMultiple)}</span>
              {t.best.trader && <span>· {personName(t.best.trader)}</span>}
            </Link>
          )}
          </span>
        </div>
      )}
    </section>
  );
}

function DigestStat({ label, value, hint, valueClass, title }: { label: string; value: ReactNode; hint?: string; valueClass?: string; title?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5" title={title}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("text-2xl font-semibold tabular-nums tracking-tight", valueClass)}>{value}</span>
      {hint && <span className="truncate text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}
