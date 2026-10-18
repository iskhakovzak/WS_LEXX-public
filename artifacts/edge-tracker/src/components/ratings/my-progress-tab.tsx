import { useMemo } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Check, Crosshair, Flame, Lightbulb, MessageSquareQuote, Star, Trophy, UserRound } from "lucide-react";
import { http } from "@/lib/api/http";
import { humanizeApiError } from "@/lib/api/errors";
import { links } from "@/lib/links";
import { PeriodHint, usePeriodNav } from "@/lib/period-links";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { EmptyState, Panel, Pill, StatCard, StatGrid, StatRow, toneOf, toneText } from "@/components/ds";
import { CHART_TOOLTIP, OutcomeBar, RankDelta } from "./shared";
import { useLeaderboard, winPctOf } from "./leaderboard-tab";
import { ScorecardCard } from "./scorecards-tab";
import { CRITERIA, buildScorecards, criterionLabel, tierLabel, weekLabel, type Rating } from "./scorecard-model";
import { bucketOf, calibVerdict, calibrationOf, enrichIdea, type TradeIdea } from "./idea-metrics";
import { useTracking } from "@/components/ideas/hooks";
import { tradeIdeasQuery } from "@/lib/api/queries";
import { fmtNum, fmtPct, fmtR, fmtUsd } from "@/lib/format";
import { ratingsI18n } from "@/i18n/ns/ratings";
import { personName } from "@/i18n";
import { commonI18n } from "@/i18n/ns/common";
import { rich, slots } from "@/i18n/rich";

export function MyProgressTab({ me, ratings, ratingsLoading }: { me: string | null; ratings: Rating[]; ratingsLoading: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t } = ratingsI18n.useT();
  const { t: tc } = commonI18n.useT();
  const month = useLeaderboard("30", "auto");
  // Shared with /trade-ideas, the stats page and global search (one request).
  const ideasQ = useQuery({ ...tradeIdeasQuery<TradeIdea>(), enabled: !!me });

  const mine = month.ranked.find((l) => l.trader === me) ?? null;
  // Traders read only their own leaderboard row; rank and «команда …%» need the whole desk.
  const deskVisible = month.ranked.some((l) => l.trader !== me);
  const card = useMemo(() => (me ? buildScorecards(ratings.filter((r) => r.trader === me))[0] ?? null : null), [ratings, me]);
  const myRatings = useMemo(
    () => ratings.filter((r) => r.trader === me && r.comment?.trim()).sort((a, b) => b.week.localeCompare(a.week) || b.createdAt.localeCompare(a.createdAt)).slice(0, 4),
    [ratings, me],
  );
  const ideas = useMemo(() => (ideasQ.data ?? []).filter((i) => i.trader === me).map((i) => enrichIdea(i)), [ideasQ.data, me]);
  const ideaB = useMemo(() => bucketOf(ideas), [ideas]);
  // Price outcome of the same ideas (target vs stop first) — most ideas are never linked to a trade.
  const tracking = useTracking(ideas.some((i) => i.published));
  const priceB = useMemo(() => {
    const items = tracking.data?.items;
    if (!items) return null;
    return bucketOf((ideasQ.data ?? []).filter((i) => i.trader === me).map((i) => enrichIdea(i, { basis: "price", track: items[String(i.id)] ?? null })));
  }, [tracking.data, ideasQ.data, me]);
  const ideaCalib = useMemo(() => calibrationOf(ideas), [ideas]);
  const team = useMemo(() => {
    // Team win rate = W / (W + L): break-even trades are excluded, same as the leaderboard rows.
    const decided = month.ranked.reduce((s, l) => s + l.wins + l.losses, 0);
    const wins = month.ranked.reduce((s, l) => s + l.wins, 0);
    return { winrate: decided ? (wins / decided) * 100 : null };
  }, [month.ranked]);

  // Feedback loop: the trader confirms they have read the curator's focus → curator sees it on the scorecard.
  const ack = useMutation({
    mutationFn: (id: number) => http.post<Rating>(`/api/ratings/${id}/ack`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["ratings"] }); toast({ title: ratingsI18n.t("progress.focusAccepted"), description: ratingsI18n.t("progress.focusAcceptedDesc") }); },
    onError: (e: Error) => toast({ title: commonI18n.t("states.error"), description: humanizeApiError(e, ratingsI18n.t("progress.markFailed")), variant: "destructive" }),
  });

  const chartData = card?.series.map((s) => ({ date: s.week, week: weekLabel(s.week).split(" – ")[0], composite: s.composite, overall: s.overall })) ?? [];
  // Each point is a week: click / Enter opens that week's review.
  const weekNav = usePeriodNav({
    kind: "week",
    dates: chartData.map((d) => d.date),
    trader: me,
    label: t("progress.chartLabel"),
    describe: (i) => t("progress.weekDescribe", { week: weekLabel(chartData[i].date), value: fmtNum(chartData[i].composite, 1) }),
  });

  if (!me) {
    return (
      <Panel>
        <EmptyState icon={UserRound} title={t("progress.signInTitle")} description={t("progress.signInDescription")} />
      </Panel>
    );
  }

  const weakest = card?.weakest && card.latest ? { key: card.weakest, now: card.latest[card.weakest] } : null;
  const curatorFocus = card?.lastFocus ?? null;

  return (
    <div className="flex flex-col gap-4">
      {month.isLoading ? (
        <StatGrid>{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}</StatGrid>
      ) : (
        <StatGrid>
          {deskVisible ? (
            <StatCard
              label={t("progress.monthPlace")}
              icon={Trophy}
              value={mine ? `#${mine.rank}` : "—"}
              hint={mine ? <span className="inline-flex items-center gap-1.5">{t("progress.ofTotal", { total: month.ranked.length })} <RankDelta delta={mine.rankDelta} isNew={mine.isNew} /></span> : t("progress.noTrades30")}
              tone={mine && mine.rank <= 3 ? "accent" : "neutral"}
            />
          ) : (
            // A trader's leaderboard holds only their own row: «#1 из 1» meant nothing, the month's net does.
            <StatCard
              label={t("progress.monthPnl")}
              icon={Trophy}
              value={mine ? fmtUsd(mine.totalPnl, { signed: true, decimals: 0 }) : "—"}
              tone={toneOf(mine?.totalPnl)}
              hint={mine
                ? `${tc("units.trades", { count: mine.totalTrades })}${mine.tradingDays ? ` · ${tc("units.tradingDays", { count: mine.tradingDays })}` : ""}`
                : t("progress.noTrades30")}
            />
          )}
          <StatCard
            label={t("progress.currentStreak")}
            icon={Flame}
            value={mine?.currentStreak ? (mine.currentStreak > 0 ? `W${mine.currentStreak}` : `L${-mine.currentStreak}`) : "—"}
            tone={toneOf(mine?.currentStreak)}
            hint={mine ? t("progress.streakHint", { best: mine.bestStreak, worst: -mine.worstStreak }) : undefined}
          />
          {mine && mine.totalR == null && (mine.pnlCount ?? 0) > 0 ? (
            // R unknown (no stop on the trades, e.g. broker imports) → show net $ instead of a fake 0R.
            <StatCard
              label={t("progress.monthPnl")}
              value={fmtUsd(mine.totalPnl, { signed: true, decimals: 0 })}
              tone={toneOf(mine.totalPnl)}
              hint={mine.prev ? t("progress.prevMonthRUnknown", { value: fmtUsd(mine.prev.totalPnl, { signed: true, decimals: 0 }) }) : t("progress.rUnknown")}
            />
          ) : (
            <StatCard
              label={t("progress.monthR")}
              value={mine ? fmtR(mine.totalR, 1) : "—"}
              tone={toneOf(mine?.totalR)}
              hint={mine?.prev ? t("progress.prevMonth", { value: fmtR(mine.prev.totalR, 1) }) : undefined}
            />
          )}
          <StatCard
            label={t("progress.monthWinrate")}
            value={mine ? fmtPct(winPctOf(mine), { decimals: 0, signed: false }) : "—"}
            tone={(() => {
              const base = deskVisible ? team.winrate : mine?.prev ? winPctOf(mine.prev) : null;
              const cur = mine ? winPctOf(mine) : null;
              return base != null && cur != null ? toneOf(cur - base) : "neutral";
            })()}
            hint={deskVisible
              ? (team.winrate != null ? t("progress.teamValue", { value: fmtPct(team.winrate, { decimals: 0, signed: false }) }) : undefined)
              : mine?.prev ? t("progress.prevMonth", { value: fmtPct(winPctOf(mine.prev), { decimals: 0, signed: false }) }) : undefined}
          />
        </StatGrid>
      )}

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="flex flex-col gap-4 lg:col-span-2">
          {ratingsLoading ? <Skeleton className="h-80 rounded-2xl" /> : card ? (
            <ScorecardCard card={card} />
          ) : (
            <Panel>
              <EmptyState icon={Star} title={t("progress.noRatingsTitle")} description={t("progress.noRatingsDescription")} />
            </Panel>
          )}
          {(curatorFocus || weakest) && (
            <Panel
              icon={Crosshair}
              title={t("progress.weekFocus")}
              actions={card?.tier ? <Link href={links.scaling(me)} className="focus-visible:outline-none"><Pill tone="purple">{tierLabel(card.tier)}</Pill></Link> : undefined}
            >
              {curatorFocus ? (
                <>
                  <p className="text-sm text-foreground">{curatorFocus.text}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{t("progress.curatorWeek", { curator: personName(curatorFocus.curator), week: weekLabel(curatorFocus.week) })}</span>
                    {curatorFocus.acknowledged ? (
                      <Pill tone="up" className="ml-auto"><Check className="h-3 w-3" aria-hidden="true" />{t("progress.accepted")}</Pill>
                    ) : (
                      <Button size="sm" variant="secondary" className="ml-auto h-7 gap-1 px-2 text-xs" onClick={() => ack.mutate(curatorFocus.ratingId)} disabled={ack.isPending}>
                        <Check className="h-3 w-3" aria-hidden="true" /> {ack.isPending ? t("progress.marking") : t("progress.ack")}
                      </Button>
                    )}
                  </div>
                  {weakest && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t("progress.weakestNote", { criterion: criterionLabel(weakest.key).toLowerCase(), value: fmtNum(weakest.now, 1) })}
                    </p>
                  )}
                </>
              ) : weakest ? (
                <>
                  <p className="text-sm text-foreground">
                    {rich(t("progress.pullUp", slots("criterion", "now", "target")), {
                      criterion: <span className="font-semibold">{criterionLabel(weakest.key)}</span>,
                      now: <span className="font-semibold tabular-nums">{fmtNum(weakest.now, 1)}</span>,
                      target: <span className="font-semibold tabular-nums text-up">{Math.min(10, Math.floor(weakest.now) + 1)}</span>,
                    })}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">{CRITERIA.find((c) => c.key === weakest.key)?.hint}</p>
                </>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-x-2 gap-y-1 text-xs">
                <Link href={links.risk(me)} className="text-primary hover:underline">{t("progress.myRiskLimits")}</Link>
                <span className="text-muted-foreground" aria-hidden="true">·</span>
                <Link href={links.scaling(me)} className="text-primary hover:underline">{t("progress.scaling")}</Link>
                <span className="text-muted-foreground" aria-hidden="true">·</span>
                <Link href={links.weeklyReview({ trader: me })} className="text-primary hover:underline">{t("progress.weeklyReview")}</Link>
              </div>
            </Panel>
          )}
        </div>

        <div className="flex flex-col gap-4 lg:col-span-3">
          <Panel title={t("progress.dynamics")} description={t("progress.dynamicsDescription")}>
            {chartData.length >= 2 ? (
              <>
              <div {...weekNav.wrapperProps} className={cn("h-56 w-full", weekNav.wrapperProps.className)}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -20 }} {...weekNav.chartProps}>
                    <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="week" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                    <YAxis domain={[0, 10]} ticks={[0, 2, 4, 6, 8, 10]} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={CHART_TOOLTIP} labelFormatter={(l) => <>{String(l)}<PeriodHint kind="week" /></>} formatter={(v: number, n: string) => [fmtNum(v, 1), n === "overall" ? t("progress.overallShort") : t("progress.criteriaShort")]} />
                    <Legend formatter={(v: string) => <span className="text-xs text-muted-foreground">{v === "overall" ? t("overall") : t("progress.criteriaAvg")}</span>} />
                    <Line isAnimationActive={false} dataKey="composite" stroke="hsl(var(--chart-1))" strokeWidth={2} dot={{ r: 3 }} />
                    <Line isAnimationActive={false} dataKey="overall" stroke="hsl(var(--chart-3))" strokeWidth={2} strokeDasharray="4 3" dot={{ r: 3 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              {weekNav.caption}
              </>
            ) : (
              <p className="rounded-xl bg-[var(--glass-bg)] p-4 text-sm text-muted-foreground">{t("progress.chartAfterTwo")}</p>
            )}
          </Panel>

          <Panel icon={MessageSquareQuote} title={t("progress.comments")}>
            {myRatings.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("progress.noComments")}</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {myRatings.map((r) => (
                  <li key={r.id} className="rounded-xl bg-[var(--glass-bg)] p-3">
                    <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{personName(r.curator)}</span>
                      <span>{t("shared.week", { label: weekLabel(r.week) })}</span>
                      {r.tier && <Pill tone="purple">{tierLabel(r.tier)}</Pill>}
                      <Pill tone={r.overall >= 8 ? "up" : r.overall >= 5 ? "warn" : "down"} className="ml-auto">{r.overall}/10</Pill>
                    </div>
                    <p className="whitespace-pre-wrap text-sm text-foreground/90 [overflow-wrap:anywhere]">{r.comment}</p>
                    {r.focus?.trim() && (
                      <p className="mt-1.5 flex items-start gap-1.5 text-xs text-muted-foreground">
                        <Crosshair className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                        <span>{t("progress.focusPrefix")} <span className="text-foreground">{r.focus}</span></span>
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel
            icon={Lightbulb}
            title={t("progress.myIdeas")}
            actions={<Link href="/trade-idea-stats" className="text-xs text-primary hover:underline">{t("progress.detailedStats")}</Link>}
          >
            {ideasQ.isLoading ? <Skeleton className="h-20 rounded-xl" /> : ideas.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {rich(t("progress.noIdeas", slots("link")), {
                  link: <Link href={links.newIdea()} className="text-primary hover:underline">{t("progress.publishFirst")}</Link>,
                })}
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                <OutcomeBar wins={ideaB.wins} losses={ideaB.losses} be={ideaB.be} open={ideaB.open} />
                <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
                  <StatRow label={t("progress.ideasInTrades")} value={`${ideaB.ideas} / ${ideaB.converted}`} />
                  <StatRow label={t("progress.hitByTrades")} value={ideaB.hitRate == null ? "—" : `${Math.round(ideaB.hitRate * 100)}%`} tone={ideaB.hitRate == null ? "neutral" : ideaB.hitRate >= 0.5 ? "up" : "down"} />
                  <StatRow
                    label={t("progress.targetFirst")}
                    value={priceB?.hitRate == null ? "—" : `${Math.round(priceB.hitRate * 100)}% · ${priceB.wins}/${priceB.wins + priceB.losses}`}
                    tone={priceB?.hitRate == null ? "neutral" : priceB.hitRate >= 0.5 ? "up" : "down"}
                  />
                  <StatRow label={t("progress.avgR")} value={fmtR(ideaB.avgR)} tone={toneOf(ideaB.avgR)} />
                  <StatRow
                    label={t("progress.calibScore")}
                    value={<span className={cn(toneText(calibVerdict(ideaCalib).tone))}>{calibVerdict(ideaCalib).text}</span>}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("progress.convertedOf", { converted: ideaB.converted, count: ideaB.ideas })}
                </p>
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
