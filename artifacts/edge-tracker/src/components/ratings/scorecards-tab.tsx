import { useMemo, useRef, useState } from "react";
import { Check, ClipboardCheck, Crosshair, History, MessageSquareQuote, Pencil, Plus, Star, Trash2, TriangleAlert, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { EmptyState, Panel, Pill, toneOf, toneText } from "@/components/ds";
import { Avatar, ScoreBar, Sparkline } from "./shared";
import { CRITERIA, buildScorecards, criterionLabel, shiftWeek, tierLabel, weekLabel, weekOf, type Rating, type Scorecard } from "./scorecard-model";
import { PersonSelect } from "@/components/people/person-select";
import { fmtDate, fmtNum } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { ratingsI18n } from "@/i18n/ns/ratings";
import { comparePersonNames, personName } from "@/i18n";

function Delta({ cur, prev, className }: { cur: number; prev: number | null | undefined; className?: string }) {
  if (prev == null) return null;
  const d = Math.round((cur - prev) * 10) / 10;
  if (d === 0) return <span className={cn("text-2xs text-muted-foreground tabular-nums", className)}>±0</span>;
  return <span className={cn("text-2xs font-semibold tabular-nums", toneText(toneOf(d)), className)}>{fmtNum(d, { decimals: 1, signed: true })}</span>;
}

export function ScorecardCard({ card, onHistory, onRate, highlight }: {
  card: Scorecard;
  onHistory?: () => void;
  onRate?: () => void;
  highlight?: boolean;
}) {
  const { t } = ratingsI18n.useT();
  const latest = card.latest!;
  const stale = latest.week < shiftWeek(weekOf(), -1);
  const overallTone = latest.overall >= 8 ? "up" : latest.overall >= 5 ? "warn" : "down";
  return (
    <article className={cn("glass-panel flex flex-col gap-4 rounded-2xl p-4", highlight && "ring-1 ring-primary/50")} aria-label={t("scorecards.cardAria", { name: personName(card.trader) })}>
      <header className="flex items-start gap-3">
        <Avatar name={card.trader} highlight={highlight} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="truncate text-sm font-semibold text-foreground" title={personName(card.trader)}>{personName(card.trader)}</h3>
            {highlight && <Pill tone="accent">{t("shared.you")}</Pill>}
          </div>
          <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <span>{t("shared.week", { label: weekLabel(latest.week) })}</span>
            {stale && (
              <span className="inline-flex items-center gap-0.5 text-[hsl(var(--chart-3))]" title={t("scorecards.staleTitle")}>
                <TriangleAlert className="h-3 w-3" aria-hidden="true" /> {t("scorecards.stale")}
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-col items-end">
          <div className="flex items-baseline gap-1">
            <span className={cn("text-2xl font-semibold tabular-nums tracking-tight", toneText(overallTone))}>{fmtNum(latest.overall, 1)}</span>
            <span className="text-xs text-muted-foreground">/10</span>
          </div>
          <Delta cur={latest.overall} prev={card.prev?.overall} />
        </div>
      </header>

      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="micro-label">{t("scorecards.trend", { weeks: commonI18n.t("units.weeks", { count: card.series.length }) })}</div>
          <div className="text-xs text-muted-foreground tabular-nums">
            {t("scorecards.allTimeAvg", { avg: fmtNum(card.avg.overall, 1) })} · {t("scorecards.ratingsCount", { count: card.totalRatings })}
          </div>
        </div>
        <Sparkline
          values={card.series.map((s) => s.composite)}
          domain={[1, 10]}
          width={112}
          height={32}
          label={t("scorecards.sparkAria", { values: card.series.map((s) => fmtNum(s.composite, 1)).join(", ") })}
        />
      </div>

      <dl className="flex flex-col gap-2">
        {CRITERIA.map((c) => (
          <div key={c.key} className="grid grid-cols-[minmax(0,7.5rem)_1fr_2.25rem] items-center gap-2">
            <dt className="flex items-center gap-1.5 truncate text-xs text-muted-foreground" title={c.hint}>
              <c.icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{c.label}</span>
            </dt>
            <dd><ScoreBar value={latest[c.key]} /></dd>
            <dd className="text-right"><Delta cur={latest[c.key]} prev={card.prev?.[c.key]} /></dd>
          </div>
        ))}
      </dl>

      {(card.strongest || card.weakest) && (
        <div className="flex flex-wrap gap-1.5">
          {card.strongest && <Pill tone="up">{t("scorecards.strength", { criterion: criterionLabel(card.strongest) })}</Pill>}
          {card.weakest && <Pill tone="warn">{t("scorecards.growth", { criterion: criterionLabel(card.weakest) })}</Pill>}
          {card.tier && <Pill tone="purple">{tierLabel(card.tier)}</Pill>}
        </div>
      )}

      {card.lastFocus && (
        <div className="flex gap-2 rounded-xl border border-primary/25 bg-primary/5 p-3 text-sm text-foreground/90">
          <Crosshair className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 [overflow-wrap:anywhere]">{card.lastFocus.text}</p>
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              {t("scorecards.focusMeta", { curator: personName(card.lastFocus.curator), week: weekLabel(card.lastFocus.week) })}
              {card.lastFocus.acknowledged
                ? <Pill tone="up" className="ml-auto"><Check className="h-3 w-3" aria-hidden="true" />{t("scorecards.traderAccepted")}</Pill>
                : <Pill tone="neutral" className="ml-auto">{t("scorecards.notRead")}</Pill>}
            </p>
          </div>
        </div>
      )}

      {card.lastComment && (
        <blockquote className="flex gap-2 rounded-xl bg-[var(--glass-bg)] p-3 text-sm text-foreground/90">
          <MessageSquareQuote className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <p className="line-clamp-3 whitespace-pre-wrap [overflow-wrap:anywhere]">{card.lastComment.text}</p>
            <footer className="mt-1 text-xs text-muted-foreground">{personName(card.lastComment.curator)} · {t("shared.week", { label: weekLabel(card.lastComment.week) })}</footer>
          </div>
        </blockquote>
      )}

      {(onHistory || onRate) && (
        <div className="mt-auto flex gap-2">
          {onHistory && (
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={onHistory}>
              <History className="h-4 w-4" aria-hidden="true" /> {t("scorecards.history")}
            </Button>
          )}
          {onRate && (
            <Button variant="outline" size="sm" className="ml-auto gap-1.5" onClick={onRate}>
              <Star className="h-4 w-4" aria-hidden="true" /> {t("scorecards.rate")}
            </Button>
          )}
        </div>
      )}
    </article>
  );
}

export function ScorecardsTab({
  ratings, isLoading, isError, error, onRetry, isCurator, isAdmin, me, traders, onRate, onEdit, onDelete,
}: {
  ratings: Rating[];
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  isCurator: boolean;
  isAdmin: boolean;
  me: string | null;
  traders: string[];
  onRate: (trader?: string) => void;
  onEdit: (r: Rating) => void;
  onDelete: (r: Rating) => void;
}) {
  const { t } = ratingsI18n.useT();
  const { t: tc } = commonI18n.useT();
  const thisWeek = weekOf();
  const cards = useMemo(() => buildScorecards(ratings, thisWeek), [ratings, thisWeek]);
  const [filter, setFilter] = useState<string>("all");
  const [weeksShown, setWeeksShown] = useState(6);
  const journalRef = useRef<HTMLDivElement>(null);

  const ratedThisWeek = new Set(ratings.filter((r) => r.week === thisWeek).map((r) => r.trader));
  const mineThisWeek = new Set(ratings.filter((r) => r.week === thisWeek && r.curator === me).map((r) => r.trader));
  const pending = traders.filter((x) => !ratedThisWeek.has(x));
  const doneCount = traders.length - pending.length;

  const byWeek = useMemo(() => {
    const list = filter === "all" ? ratings : ratings.filter((r) => r.trader === filter);
    const map = new Map<string, Rating[]>();
    for (const r of list) {
      const l = map.get(r.week) ?? [];
      l.push(r);
      map.set(r.week, l);
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [ratings, filter]);

  const traderOptions = useMemo(() => [...new Set([...traders, ...ratings.map((r) => r.trader)])].sort(comparePersonNames).map((n) => ({ value: n, label: personName(n) })), [traders, ratings]);

  function showHistory(trader: string) {
    setFilter(trader);
    requestAnimationFrame(() => journalRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" aria-busy="true" aria-label={t("scorecards.loading")}>
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-80 rounded-2xl" />)}
      </div>
    );
  }
  if (isError) return <QueryError error={error} onRetry={onRetry} />;

  return (
    <div className="flex flex-col gap-4">
      {isCurator && traders.length > 0 && (
        <Panel
          icon={ClipboardCheck}
          title={t("scorecards.weekTitle", { week: weekLabel(thisWeek) })}
          description={pending.length === 0 ? t("scorecards.allRated") : t("scorecards.whoPending")}
          actions={<span className="text-sm font-semibold tabular-nums text-foreground">{doneCount}/{traders.length}</span>}
        >
          <div className="flex flex-col gap-3">
            <div className="h-1.5 overflow-hidden rounded-full bg-[var(--glass-hover-bg)]" role="progressbar" aria-valuemin={0} aria-valuemax={traders.length} aria-valuenow={doneCount} aria-label={t("scorecards.progressAria")}>
              <div className="h-full rounded-full bg-primary transition-[width] duration-200" style={{ width: `${traders.length ? (doneCount / traders.length) * 100 : 0}%` }} />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {pending.map((name) => (
                <button key={name} type="button" onClick={() => onRate(name)} className="chip inline-flex min-h-8 items-center gap-1.5 px-3 text-sm">
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" /> {personName(name)}
                </button>
              ))}
              {traders.filter((name) => ratedThisWeek.has(name)).map((name) => (
                <span key={name} className="inline-flex min-h-8 items-center gap-1.5 rounded-full bg-up/15 px-3 text-sm text-up">
                  ✓ {personName(name)}{mineThisWeek.has(name) ? "" : t("scorecards.byOtherCurator")}
                </span>
              ))}
            </div>
          </div>
        </Panel>
      )}

      {cards.length === 0 ? (
        <Panel>
          <EmptyState
            icon={Star}
            title={t("scorecards.emptyTitle")}
            description={isCurator ? t("scorecards.emptyCurator") : t("scorecards.emptyTrader")}
            action={isCurator ? <Button onClick={() => onRate()} className="gap-1.5"><Plus className="h-4 w-4" aria-hidden="true" /> {t("dialog.titleNew")}</Button> : undefined}
          />
        </Panel>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {cards.map((c) => (
            <ScorecardCard
              key={c.trader}
              card={c}
              highlight={c.trader === me}
              onHistory={() => showHistory(c.trader)}
              onRate={isCurator && traders.includes(c.trader) ? () => onRate(c.trader) : undefined}
            />
          ))}
        </div>
      )}

      {ratings.length > 0 && (
        <div ref={journalRef} className="scroll-mt-4">
          <Panel
            icon={History}
            title={t("scorecards.journal")}
            description={t("scorecards.journalDescription")}
            actions={
              <PersonSelect value={filter} onValueChange={setFilter} allValue="all" allLabel={tc("fields.allTraders")} options={traderOptions} ariaLabel={t("scorecards.filterAria")} className="h-8 w-auto min-w-44 max-w-60" />
            }
          >
            {byWeek.length === 0 ? (
              <EmptyState icon={Users} title={t("scorecards.noForTrader")} className="py-6" />
            ) : (
              <div className="flex flex-col gap-4">
                {byWeek.slice(0, weeksShown).map(([week, items]) => (
                  <section key={week} aria-label={t("scorecards.weekAria", { week: weekLabel(week) })} className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <span className="micro-label">{t("scorecards.weekShort", { week: weekLabel(week) })}</span>
                      {week === thisWeek && <Pill tone="accent">{t("scorecards.current")}</Pill>}
                      <span className="text-xs text-muted-foreground">{t("scorecards.ratingsCount", { count: items.length })}</span>
                    </div>
                    <ul className="flex flex-col divide-y divide-border/60 rounded-xl border border-border/60">
                      {items.map((r) => {
                        const canManage = isCurator && (r.curator === me || isAdmin);
                        return (
                          <li key={r.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start">
                            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                <span className="font-medium text-foreground">{personName(r.trader)}</span>
                                <span className="text-xs text-muted-foreground">{t("scorecards.by", { curator: personName(r.curator) })}</span>
                                <Pill tone={r.overall >= 8 ? "up" : r.overall >= 5 ? "warn" : "down"}>{r.overall}/10</Pill>
                              </div>
                              <div className="flex flex-wrap gap-1">
                                {CRITERIA.map((c) => (
                                  <span key={c.key} className="inline-flex items-center gap-1 rounded-full bg-[var(--glass-bg)] px-2 py-0.5 text-xs text-muted-foreground" title={c.label}>
                                    {c.short} <span className={cn("font-semibold tabular-nums", toneText(r[c.key] >= 8 ? "up" : r[c.key] >= 5 ? "warn" : "down"))}>{r[c.key]}</span>
                                  </span>
                                ))}
                              </div>
                              {r.comment && <p className="whitespace-pre-wrap text-sm text-foreground/90 [overflow-wrap:anywhere]">{r.comment}</p>}
                              <time className="text-2xs text-muted-foreground" dateTime={r.createdAt}>{fmtDate(r.createdAt, "shortDateTime")}</time>
                            </div>
                            {canManage && (
                              <div className="flex shrink-0 gap-1 self-end sm:self-start">
                                <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t("scorecards.editAria", { name: personName(r.trader) })} onClick={() => onEdit(r)}>
                                  <Pencil className="h-4 w-4" aria-hidden="true" />
                                </Button>
                                <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-down" aria-label={t("scorecards.deleteAria", { name: personName(r.trader) })} onClick={() => onDelete(r)}>
                                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                                </Button>
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
                {byWeek.length > weeksShown && (
                  <Button variant="outline" size="sm" className="self-center" onClick={() => setWeeksShown((n) => n + 6)}>
                    {t("scorecards.showMore", { count: byWeek.length - weeksShown })}
                  </Button>
                )}
              </div>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
