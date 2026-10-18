/** Right pane when no setup is open: one status line (clickable filters), $ best edge (only with data), recent, health. Also the grid-view card. */
import { useMemo, type ReactNode } from "react";
import { BookOpen, CalendarCheck, CheckCircle2, ListChecks, Sparkles, Trophy } from "lucide-react";
import { EmptyState, Panel, toneText } from "@/components/ds";
import { PlaybookHealthWidget } from "@/components/playbook-health-widget";
import { cn } from "@/lib/utils";
import { ConfidenceMeter, EdgeMini, SetupTypePill, TagChips } from "./setup-bits";
import { checklistCount, folderSwatch, isSameLocalDay, moneyTone, timeAgo, usdEdge, type PlaybookEntry, type QuickFilter, type SetupSummary } from "./model";
import { fmtRate, fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { playbookI18n } from "@/i18n/ns/playbook";
const pt = playbookI18n.t; // called at render time only

function MiniList({ items, summary, onOpen, right }: {
  items: PlaybookEntry[]; summary: Map<number, SetupSummary>; onOpen: (id: number) => void; right: (e: PlaybookEntry, s: SetupSummary | undefined) => ReactNode;
}) {
  return (
    <ul className="-mx-2">
      {items.map((e) => (
        <li key={e.id}>
          <button
            type="button"
            onClick={() => onOpen(e.id)}
            className="flex w-full min-w-0 items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-foreground" title={e.name}>{e.name}</span>
              <span className="block truncate text-xs text-muted-foreground">{e.folder ?? commonI18n.t("fields.noFolder")}</span>
            </span>
            <span className="shrink-0 text-right">{right(e, summary.get(e.id))}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function Overview({
  entries, summary, summaryLoaded, onOpen, onQuickFilter, showHealth = true, showReview = true, before,
}: {
  /** «Не проверено» is a curator check of office setups — off for personal spaces. */
  showReview?: boolean;
  /** Office-wide health widget — only meaningful in «Офис» (the page passes office && curator). */
  showHealth?: boolean;
  /** Blocks above the setup lists (inbox, Tier 1 strip). */
  before?: ReactNode;
  entries: PlaybookEntry[];
  summary: Map<number, SetupSummary>;
  summaryLoaded: boolean;
  onOpen: (id: number) => void;
  onQuickFilter: (f: QuickFilter) => void;
}) {
  const stats = useMemo(() => {
    const withTrades = entries.filter((e) => (summary.get(e.id)?.tradeCount ?? 0) > 0);
    const ranked = entries
      .filter((e) => usdEdge(summary.get(e.id)) != null)
      .sort((a, b) => (usdEdge(summary.get(b.id)) ?? 0) - (usdEdge(summary.get(a.id)) ?? 0));
    const recent = entries
      .filter((e) => summary.get(e.id)?.lastUsedAt)
      .sort((a, b) => (summary.get(a.id)!.lastUsedAt! < summary.get(b.id)!.lastUsedAt! ? 1 : -1))
      .slice(0, 6);
    const newest = [...entries].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 6);
    return {
      total: entries.length,
      unreviewed: entries.filter((e) => !e.reviewed).length,
      covered: withTrades.length,
      today: entries.filter((e) => isSameLocalDay(summary.get(e.id)?.lastUsedAt)).length,
      noExamples: entries.filter((e) => (summary.get(e.id)?.exampleCount ?? 0) === 0).length,
      tier1: entries.reduce((n, e) => n + (summary.get(e.id)?.tier1Count ?? 0), 0),
      top: ranked.slice(0, 5),
      recent,
      newest,
    };
  }, [entries, summary]);

  const facts: { key: string; label: string; f?: QuickFilter }[] = [
    { key: "total", label: `${commonI18n.t("units.setups", { count: stats.total })}`, f: "all" },
  ];
  if (summaryLoaded) {
    facts.push({ key: "covered", label: pt("overview.withTrades", { count: stats.covered }), f: stats.covered < stats.total ? "untested" : undefined });
    if (stats.tier1 > 0) facts.push({ key: "tier1", label: pt("overview.tier1", { count: stats.tier1 }) });
    if (stats.noExamples > 0) facts.push({ key: "noEx", label: pt("overview.noExamples", { count: stats.noExamples }), f: "noExamples" });
    if (stats.today > 0) facts.push({ key: "today", label: pt("overview.today", { count: stats.today }), f: "today" });
  }
  if (showReview && stats.unreviewed > 0) facts.push({ key: "unrev", label: pt("overview.unreviewed", { count: stats.unreviewed }), f: "unreviewed" });

  const list = stats.recent.length ? stats.recent : stats.newest;

  return (
    <div className="flex min-w-0 flex-col gap-[var(--grid-gap)]">
      <p className="flex min-h-9 flex-wrap items-center gap-x-1 gap-y-1 text-sm text-muted-foreground" aria-label={pt("overview.aria")}>
        {summaryLoaded ? null : <span className="mr-2 inline-block h-4 w-40 animate-pulse rounded bg-[var(--glass-bg)] motion-reduce:animate-none" aria-hidden="true" />}
        {facts.map((x, i) => (
          <span key={x.key} className="inline-flex items-center">
            {i > 0 && <span aria-hidden="true" className="px-1.5 text-muted-foreground/50">·</span>}
            {x.f ? (
              <button
                type="button"
                onClick={() => onQuickFilter(x.f!)}
                className="rounded tabular-nums text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {x.label}
              </button>
            ) : (
              <span className="tabular-nums text-foreground">{x.label}</span>
            )}
          </span>
        ))}
      </p>

      {before}

      <div className={cn("grid min-w-0 gap-[var(--grid-gap)]", stats.top.length > 0 && "lg:grid-cols-2")}>
        {stats.top.length > 0 && (
          <Panel title={pt("overview.bestEdge")} description={pt("overview.bestEdgeDesc")} icon={Sparkles}>
            <MiniList
              items={stats.top}
              summary={summary}
              onOpen={onOpen}
              right={(_e, s) => {
                const v = usdEdge(s);
                return (
                  <>
                    <span className={cn("block text-sm font-semibold tabular-nums", toneText(moneyTone(v)))}>{fmtUsd(v, { signed: true, decimals: 2 })}</span>
                    <span className="block text-xs tabular-nums text-muted-foreground">{pt("overview.tradesWr", { count: s?.tradeCount ?? 0, wr: fmtRate(s?.winrate) })}</span>
                  </>
                );
              }}
            />
          </Panel>
        )}
        <Panel title={stats.recent.length ? pt("overview.recent") : pt("overview.newest")} icon={stats.recent.length ? CalendarCheck : BookOpen}>
          {list.length ? (
            <MiniList
              items={list}
              summary={summary}
              onOpen={onOpen}
              right={(e, s) => (
                <span className="text-xs text-muted-foreground">{timeAgo(stats.recent.length ? s?.lastUsedAt : e.createdAt)}</span>
              )}
            />
          ) : (
            <EmptyState className="py-6" icon={BookOpen} title={pt("overview.emptyTitle")} description={pt("overview.emptyDesc")} />
          )}
        </Panel>
      </div>

      {showHealth && <PlaybookHealthWidget onJump={onOpen} />}
    </div>
  );
}

/** Card for the grid view. */
export function SetupCard({
  e, s, folderColors, selected, onOpen,
}: {
  e: PlaybookEntry; s: SetupSummary | undefined; folderColors: Record<string, number>; selected: boolean; onOpen: (id: number) => void;
}) {
  const sw = folderSwatch(e.folder, folderColors);
  const n = checklistCount(e);
  return (
    <button
      type="button"
      onClick={() => onOpen(e.id)}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "glass-panel lift flex min-w-0 flex-col gap-2 rounded-2xl p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "ring-2 ring-primary/60",
      )}
    >
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", sw.bg)} aria-hidden="true" />
        <span className="truncate">{e.folder ?? commonI18n.t("fields.noFolder")}</span>
        {isSameLocalDay(s?.lastUsedAt) && <span className="ml-auto shrink-0 rounded-full bg-primary/15 px-1.5 text-xs text-primary">{pt("overview.today1")}</span>}
      </div>
      <div className="line-clamp-2 min-h-[2lh] text-base font-semibold leading-snug text-foreground" title={e.name.length > 60 ? e.name : undefined}>{e.name}</div>
      <div className="flex flex-wrap items-center gap-2">
        <SetupTypePill type={e.setupType} />
        {e.ticker && <span className="text-xs text-muted-foreground">{e.ticker}</span>}
      </div>
      {(e.contextText || e.conditions) && <p className="line-clamp-2 text-xs text-muted-foreground">{e.contextText || e.conditions}</p>}
      <TagChips tags={e.tags} max={3} />
      {/* Footer pinned to the bottom: the edge / checklist lines line up across a row of cards. */}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-2">
        <EdgeMini s={s} />
        <ConfidenceMeter level={e.confidenceLevel} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1"><ListChecks className="h-3 w-3" aria-hidden="true" />{n ? pt("overview.checklistItems", { count: n }) : pt("overview.noChecklist")}</span>
        {(s?.tier1Count ?? 0) > 0 && <span className="inline-flex items-center gap-1"><Trophy className="h-3 w-3" aria-hidden="true" />{s!.tier1Count} Tier 1</span>}
        {e.reviewed && <span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3 w-3" aria-hidden="true" />{pt("overview.reviewed")}</span>}
      </div>
    </button>
  );
}
