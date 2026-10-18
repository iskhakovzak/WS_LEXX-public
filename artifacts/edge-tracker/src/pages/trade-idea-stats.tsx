import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle, ArrowLeft, Award, BarChart3, Download, Lightbulb, MinusCircle, ThumbsDown, ThumbsUp, Users, X,
} from "lucide-react";
import { links } from "@/lib/links";
import { addDays, nyDate } from "@/lib/trading-date";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/auth-context";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { EmptyState, Page, PageHeader, Panel, Pill, Segmented, SortableTh, StatCard, StatGrid, toneOf, toneText, useTableSort, type Tone } from "@/components/ds";
import { OutcomeBar, Sparkline, downloadCsv, useStoredState } from "@/components/ratings/shared";
import { useTracking } from "@/components/ideas/hooks";
import { tradeIdeasQuery } from "@/lib/api/queries";
import { IdeaCalibration } from "@/components/ratings/idea-calibration";
import {
  authorStats, bucketOf, calibVerdict, calibrationOf, enrichIdea,
  type AuthorStats, type EnrichedIdea, type OutcomeBasis, type TradeIdea,
} from "@/components/ratings/idea-metrics";
import { PersonSelect } from "@/components/people/person-select";
import { sideLabel } from "@/components/ideas/model";
import { fmtDate, fmtNum, fmtR, fmtRate } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { ideasI18n } from "@/i18n/ns/ideas";
import { rich, slots } from "@/i18n/rich";
import { personName, comparePersonNames } from "@/i18n";

const PERIODS = [
  { value: "30", key: "d30" },
  { value: "90", key: "d90" },
  { value: "365", key: "year" },
  { value: "all", key: "all" },
] as const;
type Period = (typeof PERIODS)[number]["value"];
const periodKey = (p: Period) => PERIODS.find((x) => x.value === p)!.key;

type SortKey = "ideas" | "conversion" | "hitRate" | "avgR" | "sumR" | "avgScore" | "calib";
/** Column headers are built at render time (current UI language). */
function sortColumns(): { key: SortKey; label: string; title?: string; titlePrice?: string }[] {
  const t = ideasI18n.t;
  return [
    { key: "ideas", label: t("stats.cols.ideas") },
    { key: "conversion", label: t("stats.cols.conversion"), title: t("stats.cols.conversionTitle") },
    { key: "hitRate", label: "Hit rate", title: t("stats.cols.hitRateTitle"), titlePrice: t("stats.cols.hitRateTitlePrice") },
    { key: "avgR", label: t("stats.cols.avgR") },
    { key: "sumR", label: "Σ R" },
    { key: "avgScore", label: t("stats.cols.avgScore") },
    { key: "calib", label: t("stats.cols.calib"), title: t("stats.cols.calibTitle") },
  ];
}

const BASES: OutcomeBasis[] = ["price", "trades"];

/** Column accessors for the authors table; empty values sink to the bottom (useTableSort). */
const AUTHOR_ACCESSORS: Record<SortKey | "trader" | "best", (a: AuthorStats) => number | string | null> = {
  trader: (a) => personName(a.trader),
  ideas: (a) => a.ideas,
  conversion: (a) => a.conversion,
  hitRate: (a) => a.hitRate,
  avgR: (a) => a.avgR,
  sumR: (a) => (a.rCount ? a.sumR : null),
  avgScore: (a) => a.avgScore,
  calib: (a) => a.calib.r,
  best: (a) => a.best?.r ?? null,
};

/** Period start on the NY trading calendar (idea dates are NY dates, so a local-midnight cutoff would drift by a day). */
function cutoff(period: Period): string | null {
  if (period === "all") return null;
  return addDays(nyDate(), -Number(period));
}

type Majority = "thumbs_up" | "warning" | "thumbs_down" | "none";
function majorityOf(i: TradeIdea): Majority {
  const rx = i.reactions ?? [];
  if (rx.length === 0) return "none";
  for (const k of ["thumbs_up", "warning", "thumbs_down"] as const) {
    if (rx.filter((r) => r.reaction === k).length > rx.length / 2) return k;
  }
  return "none";
}
const MAJORITY_META: Record<Majority, { icon: typeof ThumbsUp; tone: Tone }> = {
  thumbs_up: { icon: ThumbsUp, tone: "up" },
  warning: { icon: AlertTriangle, tone: "warn" },
  thumbs_down: { icon: ThumbsDown, tone: "down" },
  none: { icon: MinusCircle, tone: "neutral" },
};

export default function TradeIdeaStats() {
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const { t } = ideasI18n.useT();
  const { t: tc } = commonI18n.useT();
  const SORTS = sortColumns();
  const noAuthor = t("stats.noAuthor");
  const me = user?.role !== "guest" ? user?.traderName ?? null : null;
  const [period, setPeriod] = useStoredState<Period>("ideaStats.period", "90", PERIODS.map((p) => p.value));
  const [author, setAuthor] = useState<string>("all");
  const [bestMode, setBestMode] = useState<"best" | "worst">("best");
  // Outcome basis: price vs. the idea's own target / stop (every published idea with numeric levels), or the linked
  // trade (only ideas a trade was matched to). Trades arrive from PropReports, so links are the rarer signal.
  const [basis, setBasis] = useStoredState<OutcomeBasis>("ideaStats.basis", "price", ["price", "trades"]);
  const byPrice = basis === "price";

  // Same cache entry as the ideas board (no second 90 KB download when coming from /trade-ideas).
  const { data, isLoading, error, refetch } = useQuery(tradeIdeasQuery<TradeIdea>());
  const tracking = useTracking(byPrice && !!data?.length);
  const trackItems = tracking.data?.items;

  const all = useMemo(
    () => (data ?? []).map((i) => (byPrice ? enrichIdea(i, { basis: "price", track: trackItems?.[String(i.id)] ?? null }) : enrichIdea(i))),
    [data, byPrice, trackItems],
  );
  const trackingPending = byPrice && tracking.isLoading;
  const inPeriod = useMemo(() => {
    const c = cutoff(period);
    return c ? all.filter((i) => i.date >= c) : all;
  }, [all, period]);
  const scoped = useMemo(() => (author === "all" ? inPeriod : inPeriod.filter((i) => (i.trader ?? noAuthor) === author)), [inPeriod, author, noAuthor]);

  const overall = useMemo(() => bucketOf(scoped), [scoped]);
  const calib = useMemo(() => calibrationOf(scoped), [scoped]);
  const verdict = calibVerdict(calib);
  const authorList = useMemo(() => authorStats(inPeriod).sort((a, b) => b.ideas - a.ideas), [inPeriod]);
  const { rows: authors, thProps } = useTableSort(authorList, AUTHOR_ACCESSORS, "ideas");
  const authorNames = useMemo(() => [...new Set(all.map((i) => i.trader ?? noAuthor))].sort(comparePersonNames), [all, noAuthor]);

  const ranked = useMemo(() => {
    const withR = scoped.filter((i) => i.r != null);
    return withR.sort((a, b) => (bestMode === "best" ? b.r! - a.r! : a.r! - b.r!)).slice(0, 6);
  }, [scoped, bestMode]);

  const cohorts = useMemo(() => {
    const by: Record<Majority, EnrichedIdea[]> = { thumbs_up: [], warning: [], thumbs_down: [], none: [] };
    for (const i of scoped) by[majorityOf(i)].push(i);
    return (Object.keys(by) as Majority[]).map((k) => ({ key: k, ...bucketOf(by[k]) }));
  }, [scoped]);

  function exportCsv() {
    downloadCsv(
      `idea-stats-${period}-${basis}.csv`,
      byPrice
        ? [t("stats.csv.author"), t("stats.csv.ideas"), t("stats.csv.published"), t("stats.csv.converted"), t("stats.csv.conversionPct"), t("stats.csv.target"), t("stats.csv.stop"), "—", t("stats.csv.targetFirstPct"), t("stats.csv.avgR"), "Σ R", t("stats.csv.avgScore"), t("stats.csv.calibR")]
        : [t("stats.csv.author"), t("stats.csv.ideas"), t("stats.csv.published"), t("stats.csv.converted"), t("stats.csv.conversionPct"), t("stats.csv.profit"), t("stats.csv.loss"), t("stats.csv.breakeven"), t("stats.csv.hitRatePct"), t("stats.csv.avgR"), "Σ R", t("stats.csv.avgScore"), t("stats.csv.calibR")],
      authors.map((a) => [
        personName(a.trader), a.ideas, a.published, a.converted,
        a.conversion == null ? "" : Math.round(a.conversion * 100), a.wins, a.losses, a.be,
        a.hitRate == null ? "" : Math.round(a.hitRate * 100),
        a.avgR == null ? "" : a.avgR.toFixed(2), a.sumR.toFixed(2),
        a.avgScore == null ? "" : a.avgScore.toFixed(0), a.calib.r == null ? "" : a.calib.r.toFixed(2),
      ]),
    );
  }

  const periodText = t(`stats.periodText.${periodKey(period)}`);

  return (
    <Page>
      <PageHeader
        icon={BarChart3}
        title={t("stats.title")}
        description={byPrice ? t("stats.descriptionPrice") : t("stats.descriptionTrades")}
        actions={
          <>
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={exportCsv} disabled={authors.length === 0}>
              <Download className="h-4 w-4" aria-hidden="true" /> CSV
            </Button>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setLocation("/trade-ideas")}>
              <ArrowLeft className="h-4 w-4" aria-hidden="true" /> {t("stats.backToIdeas")}
            </Button>
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <Segmented ariaLabel={t("stats.periodAria")} options={PERIODS.map((p) => ({ value: p.value, label: t(`stats.periods.${p.key}`) }))} value={period} onChange={setPeriod} />
          <Segmented<OutcomeBasis> ariaLabel={t("stats.basisAria")} options={BASES.map((b) => ({ value: b, label: t(`stats.basis.${b}`) }))} value={basis} onChange={setBasis} />
          <PersonSelect value={author} onValueChange={setAuthor} allValue="all" allLabel={t("page.allAuthors")} options={authorNames} self={me} selfSuffix={t("stats.you")} ariaLabel={t("stats.authorAria")} className="h-9 w-48" />
          {me && authorNames.includes(me) && author !== me && (
            <button type="button" className="chip min-h-9 px-3 text-sm" onClick={() => setAuthor(me)}>{t("stats.myIdeas")}</button>
          )}
          {author !== "all" && (
            <button type="button" className="chip inline-flex min-h-9 items-center gap-1 px-3 text-sm" aria-pressed="true" onClick={() => setAuthor("all")}>
              {personName(author)} <X className="h-3.5 w-3.5" aria-label={t("stats.resetAuthor")} />
            </button>
          )}
          {trackingPending && <span className="text-xs text-muted-foreground" role="status">{t("stats.loadingPrices")}</span>}
          {byPrice && tracking.isError && (
            <span className="text-xs text-down" role="alert">
              {t("stats.pricesFailed")} <button type="button" className="underline" onClick={() => tracking.refetch()}>{tc("actions.retry")}</button>
            </span>
          )}
        </div>
      </PageHeader>

      {isLoading && (
        <div className="flex flex-col gap-4" aria-busy="true" aria-label={t("stats.loading")}>
          <StatGrid className="xl:grid-cols-5">{[0, 1, 2, 3, 4].map((k) => <Skeleton key={k} className="h-24 rounded-2xl" />)}</StatGrid>
          <div className="grid gap-4 lg:grid-cols-5">
            <Skeleton className="h-80 rounded-2xl lg:col-span-3" />
            <Skeleton className="h-80 rounded-2xl lg:col-span-2" />
          </div>
          <Skeleton className="h-64 rounded-2xl" />
        </div>
      )}
      {error && !data && <QueryError error={error} onRetry={() => refetch()} />}

      {data && all.length === 0 && (
        <Panel>
          <EmptyState
            icon={Lightbulb}
            title={t("stats.emptyTitle")}
            description={t("stats.emptyDescription")}
            action={<Button onClick={() => setLocation("/trade-ideas")}>{t("stats.goToIdeas")}</Button>}
          />
        </Panel>
      )}

      {data && all.length > 0 && (
        <>
          <StatGrid className="xl:grid-cols-5">
            <StatCard label={t("stats.cols.ideas")} value={overall.ideas} hint={t("stats.ideasHint", { published: overall.published, period: periodText })} icon={Lightbulb} />
            <StatCard label={t("stats.conversion")} value={fmtRate(overall.conversion)} hint={tc("units.trades", { count: overall.converted })} />
            {byPrice ? (
              <StatCard
                label={t("stats.targetFirst")}
                value={trackingPending ? "…" : fmtRate(overall.hitRate)}
                tone={overall.hitRate == null ? "neutral" : overall.hitRate >= 0.5 ? "up" : "down"}
                hint={[t("stats.targets", { count: overall.wins }), t("stats.stops", { count: overall.losses }), overall.open ? t("stats.inWork", { count: overall.open }) : null].filter(Boolean).join(" · ")}
              />
            ) : (
              <StatCard
                label="Hit rate"
                value={fmtRate(overall.hitRate)}
                tone={overall.hitRate == null ? "neutral" : overall.hitRate >= 0.5 ? "up" : "down"}
                hint={`${overall.wins} / ${overall.losses} / ${overall.be}${overall.open ? ` · ${t("stats.openShort", { count: overall.open })}` : ""}`}
              />
            )}
            <StatCard
              label={byPrice ? t("stats.avgRPlan") : t("stats.avgR")}
              value={trackingPending ? "…" : fmtR(overall.avgR)}
              tone={toneOf(overall.avgR)}
              hint={`${t("stats.sumRHint", { sum: fmtR(overall.sumR, 1), count: overall.rCount })}${byPrice ? ` · ${t("stats.priceRule")}` : ""}`}
            />
            <StatCard
              label={t("stats.calibScore")}
              value={fmtNum(calib.r, { signed: true })}
              tone={verdict.tone === "warn" ? "warn" : verdict.tone}
              hint={verdict.text}
            />
          </StatGrid>

          {scoped.length === 0 ? (
            <Panel>
              <EmptyState
                icon={Lightbulb}
                title={author !== "all" ? t("stats.noIdeasPeriodAuthor", { period: periodText, author: personName(author) }) : t("stats.noIdeasPeriod", { period: periodText })}
                action={<Button variant="outline" size="sm" onClick={() => { setPeriod("all"); setAuthor("all"); }}>{tc("actions.resetFilters")}</Button>}
              />
            </Panel>
          ) : (
            <div className="grid gap-4 lg:grid-cols-5">
              <div className="lg:col-span-3"><IdeaCalibration ideas={scoped} basis={basis} pending={trackingPending} /></div>
              <Panel
                className="lg:col-span-2"
                icon={Award}
                title={bestMode === "best" ? t("stats.best") : t("stats.worst")}
                description={byPrice ? t("stats.byRPrice") : t("stats.byRTrade")}
                actions={
                  <Segmented<"best" | "worst"> ariaLabel={t("stats.bestWorstAria")} size="sm" value={bestMode} onChange={setBestMode}
                    options={[{ value: "best", label: t("stats.bestShort") }, { value: "worst", label: t("stats.worstShort") }]} />
                }
              >
                {trackingPending ? (
                  <Skeleton className="h-48 rounded-xl" />
                ) : ranked.length === 0 ? (
                  byPrice ? (
                    <EmptyState className="py-8" title={t("stats.noOutcomes")} description={t("stats.noOutcomesDescription")} />
                  ) : (
                    <EmptyState className="py-8" title={t("stats.noRTrades")} description={t("stats.noRTradesDescription")} />
                  )
                ) : (
                  <ol className="flex flex-col gap-1">
                    {ranked.map((i, idx) => (
                      <li key={i.id}>
                        <button
                          type="button"
                          onClick={() => (byPrice ? setLocation(`/trade-ideas?idea=${i.id}`) : i.linkedTrade && setLocation(links.trade(i.linkedTrade.id)))}
                          className={cn(
                            "flex w-full items-center gap-3 rounded-xl border-l-2 px-3 py-2 text-left transition-colors hover:bg-[var(--glass-hover-bg)]",
                            (i.r ?? 0) >= 0 ? "border-l-up/60" : "border-l-down/60",
                          )}
                          aria-label={t(byPrice ? "stats.openIdeaAria" : "stats.openTradeAria", { ticker: i.ticker, r: fmtR(i.r) })}
                        >
                          <span className="w-4 text-xs text-muted-foreground tabular-nums">{idx + 1}</span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="font-semibold text-foreground">{i.ticker}</span>
                              {i.side && <span className="text-xs text-muted-foreground">{sideLabel(i.side)}</span>}
                              {i.setupQuality && <Pill tone="purple" className="px-1.5 py-0 text-2xs">{i.setupQuality}</Pill>}
                            </div>
                            {(() => {
                              const meta = `${i.trader ? personName(i.trader) : "—"} · ${fmtDate(i.date, "dayMonth")}${i.score != null ? ` · ${t("stats.scoreMeta", { score: i.score })}` : ""}${i.setup ? ` · ${i.setup}` : ""}`;
                              return <div className="truncate text-xs text-muted-foreground" title={meta}>{meta}</div>;
                            })()}
                          </div>
                          <span className={cn("font-semibold tabular-nums", toneText(toneOf(i.r)))}>{fmtR(i.r, 1)}</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
              </Panel>
            </div>
          )}

          <Panel icon={Users} title={t("stats.authors")} description={t("stats.authorsDescription", { period: periodText })} padded={false}>
            {authors.length === 0 ? (
              <EmptyState className="py-8" title={t("stats.noIdeasPeriod", { period: periodText })} />
            ) : (
              <>
                <div className="hidden overflow-x-auto md:block">
                  <table className="w-full text-sm">
                    <thead className="text-xs text-muted-foreground">
                      <tr className="border-b border-border">
                        <SortableTh {...thProps("trader")} className="px-5 py-2.5 font-medium">{t("stats.cols.author")}</SortableTh>
                        {SORTS.map((s) => (
                          <SortableTh key={s.key} {...thProps(s.key)} align="right" className="px-2 py-2.5 font-medium">
                            <span title={byPrice && s.titlePrice ? s.titlePrice : s.title}>{s.label}</span>
                          </SortableTh>
                        ))}
                        <SortableTh {...thProps("best")} className="px-2 py-2.5 font-medium">{t("stats.cols.best")}</SortableTh>
                        <th scope="col" className="px-5 py-2.5 text-right font-medium">{t("stats.cols.trendR")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {authors.map((a) => {
                        const active = author === a.trader;
                        const v = calibVerdict(a.calib);
                        return (
                          <tr
                            key={a.trader}
                            onClick={() => setAuthor(active ? "all" : a.trader)}
                            className={cn("cursor-pointer border-b border-border/60 last:border-0 transition-colors hover:bg-[var(--glass-hover-bg)]", active && "bg-primary/5")}
                          >
                            <td className="px-5 py-2.5">
                              <button type="button" aria-pressed={active} className="flex flex-col text-left" onClick={(e) => { e.stopPropagation(); setAuthor(active ? "all" : a.trader); }}>
                                <span className="font-medium text-foreground">{personName(a.trader)}{a.trader === me && <span className="ml-1.5 text-xs text-primary">{t("stats.youShort")}</span>}</span>
                                <span className="text-xs text-muted-foreground tabular-nums">{t("stats.authorSub", { published: a.published, converted: a.converted })}</span>
                              </button>
                            </td>
                            <td className="px-2 py-2.5 text-right tabular-nums">{a.ideas}</td>
                            <td className="px-2 py-2.5 text-right tabular-nums">{fmtRate(a.conversion)}</td>
                            <td className="px-2 py-2.5">
                              <div className="ml-auto flex w-28 flex-col items-end gap-1">
                                <span className={cn("tabular-nums", a.hitRate == null ? "text-muted-foreground" : a.hitRate >= 0.5 ? "text-up" : "text-down")}>{fmtRate(a.hitRate)}</span>
                                <OutcomeBar wins={a.wins} losses={a.losses} be={a.be} open={a.open} className="w-full" />
                              </div>
                            </td>
                            <td className={cn("px-2 py-2.5 text-right tabular-nums", toneText(toneOf(a.avgR)))}>{fmtR(a.avgR)}</td>
                            <td className={cn("px-2 py-2.5 text-right tabular-nums", toneText(toneOf(a.sumR)))}>{a.rCount ? fmtR(a.sumR, 1) : "—"}</td>
                            <td className="px-2 py-2.5 text-right tabular-nums">{fmtNum(a.avgScore, 0)}</td>
                            <td className="px-2 py-2.5 text-right" title={v.text}>
                              {a.calib.r == null
                                ? <span className="text-xs text-muted-foreground">{a.calib.n}/5</span>
                                : <Pill tone={v.tone}>{fmtNum(a.calib.r, { signed: true })}</Pill>}
                            </td>
                            <td className="px-2 py-2.5">
                              {a.best ? (
                                <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                                  <span className="font-medium text-foreground">{a.best.ticker}</span>
                                  <span className={cn("text-xs tabular-nums", toneText(toneOf(a.best.r)))}>{fmtR(a.best.r, 1)}</span>
                                </span>
                              ) : <span className="text-muted-foreground">—</span>}
                            </td>
                            <td className="px-5 py-2.5"><div className="flex justify-end"><Sparkline values={a.sparkR} width={72} height={24} label={t("stats.sparkAria", { name: personName(a.trader) })} /></div></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <ul className="flex flex-col gap-2 p-3 md:hidden">
                  {authors.map((a) => {
                    const active = author === a.trader;
                    return (
                      <li key={a.trader}>
                        <button
                          type="button"
                          aria-pressed={active}
                          onClick={() => setAuthor(active ? "all" : a.trader)}
                          className={cn("flex w-full flex-col gap-2 rounded-xl bg-[var(--glass-bg)] p-3 text-left", active && "ring-1 ring-primary/60")}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium text-foreground">{personName(a.trader)}</span>
                            <span className={cn("font-semibold tabular-nums", toneText(toneOf(a.avgR)))}>{fmtR(a.avgR)}</span>
                          </div>
                          <OutcomeBar wins={a.wins} losses={a.losses} be={a.be} open={a.open} />
                          <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular-nums">
                            <span>{t("stats.mobileIdeas", { count: a.ideas })}</span>
                            <span>{t("stats.mobileConv", { value: fmtRate(a.conversion) })}</span>
                            <span>{t("stats.mobileHit", { value: fmtRate(a.hitRate) })}</span>
                            {a.best && <span>{t("stats.mobileBest", { ticker: a.best.ticker, r: fmtR(a.best.r, 1) })}</span>}
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </Panel>

          <Panel
            title={t("stats.reactionsTitle")}
            description={t("stats.reactionsDescription")}
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {cohorts.map((c) => {
                const meta = MAJORITY_META[c.key];
                const Icon = meta.icon;
                return (
                  <div key={c.key} className="flex flex-col gap-3 rounded-xl bg-[var(--glass-bg)] p-3">
                    <div className="flex items-center gap-2">
                      <Icon className={cn("h-4 w-4", toneText(meta.tone === "neutral" ? "neutral" : meta.tone))} aria-hidden="true" />
                      <span className="text-sm font-medium text-foreground">{t(`stats.majority.${c.key}`)}</span>
                      <span className="ml-auto text-xs text-muted-foreground tabular-nums">{c.ideas}</span>
                    </div>
                    <OutcomeBar wins={c.wins} losses={c.losses} be={c.be} open={c.open} />
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div>
                        <div className="text-2xs text-muted-foreground">{t("stats.inTrades")}</div>
                        <div className="font-semibold tabular-nums text-foreground">{c.converted}</div>
                      </div>
                      <div>
                        <div className="text-2xs text-muted-foreground">Hit rate</div>
                        <div className={cn("font-semibold tabular-nums", c.hitRate == null ? "text-muted-foreground" : c.hitRate >= 0.5 ? "text-up" : "text-down")}>{fmtRate(c.hitRate)}</div>
                      </div>
                      <div>
                        <div className="text-2xs text-muted-foreground">{t("stats.cols.avgR")}</div>
                        <div className={cn("font-semibold tabular-nums", toneText(toneOf(c.avgR)))}>{fmtR(c.avgR, 1)}</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>

          <p className="text-xs text-muted-foreground">
            {byPrice ? t("stats.footPrice") : t("stats.footTrades")}{" "}
            {t("stats.footCalib")}{" "}
            {rich(t("stats.footRating", slots("link")), {
              link: <Link href="/ratings" className="text-primary hover:underline">{t("stats.ratingLink")}</Link>,
            })}
          </p>
        </>
      )}
    </Page>
  );
}
