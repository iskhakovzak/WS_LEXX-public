import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronsUpDown, Crown, Download, Flame, Medal, Trophy, Users } from "lucide-react";
import { http } from "@/lib/api/http";
import { STALE } from "@/lib/api/keys";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { EmptyState, Panel, Pill, Segmented, StatCard, StatGrid, TableScroll, toneOf, toneText } from "@/components/ds";
import { Avatar, RankDelta, Sparkline, StreakBadge, OutcomeBar, downloadCsv, useStoredState } from "./shared";
import { fmtCount, fmtNum, fmtPct, fmtR, fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { ratingsI18n } from "@/i18n/ns/ratings";
import { comparePersonNames, personName } from "@/i18n";

export type LeaderboardEntry = {
  trader: string;
  totalTrades: number; wins: number; losses: number; breakevens: number; open?: number;
  winrate: number; totalPnl: number; avgPnl: number; pnlCount?: number;
  /** null = no trade with a known R in the window (no stop, e.g. PropReports imports). */
  totalR: number | null; avgR: number | null; rCount?: number; bestR?: number | null; worstR?: number | null;
  /** W/(W+L) as a fraction; null = no decided trades (newer API builds). */
  winRate?: number | null;
  bestTrade: number; worstTrade: number;
  expectancy: number; expectancyR?: number | null;
  tradingDays?: number; sharpeDaily?: number | null; sharpeDailyR?: number | null; sharpeApprox?: number;
  currentStreak: number; bestStreak: number; worstStreak: number;
  lastTradeDate: string | null;
  sparkR?: number[];
  prev?: { totalTrades: number; winrate: number; totalPnl: number; totalR: number | null; avgR: number | null; expectancy: number; expectancyR?: number | null } | null;
};

export const PERIODS = [
  { value: "7", key: "p7" },
  { value: "30", key: "p30" },
  { value: "90", key: "p90" },
  { value: "all", key: "all" },
] as const;
export type Period = (typeof PERIODS)[number]["value"];
const PERIOD_VALUES = PERIODS.map((p) => p.value) as readonly Period[];
const periodKey = (p: Period) => PERIODS.find((x) => x.value === p)!.key;

type Metric = "r" | "pnl" | "winrate" | "expR";
const METRIC_KEYS: Metric[] = ["r", "pnl", "winrate", "expR"];
/** Metric labels are built at render time (current UI language). */
const metricOptions = (): { value: Metric; label: string }[] =>
  METRIC_KEYS.map((value) => ({ value, label: value === "pnl" ? "P&L" : ratingsI18n.t(`leaderboard.metrics.${value}`) }));
const METRIC_VALUES = ["auto", ...METRIC_KEYS] as const;

type MetricSource = {
  totalR: number | null; totalPnl: number; winrate: number; avgR: number | null; expectancyR?: number | null; totalTrades: number;
  wins?: number; losses?: number; winRate?: number | null;
};
/** Row win rate in %, W/(W+L) — null (→ «—») when there are no decided trades. */
export function winPctOf(e: { winrate: number; wins?: number; losses?: number; winRate?: number | null }): number | null {
  if (e.winRate !== undefined) return e.winRate == null ? null : e.winRate * 100;
  if (e.wins != null && e.losses != null) return e.wins + e.losses > 0 ? (e.wins / (e.wins + e.losses)) * 100 : null;
  return e.winrate;
}
function metricOf(m: Metric, e: MetricSource): number | null {
  switch (m) {
    case "r": return e.totalR;
    case "pnl": return e.totalPnl;
    case "winrate": return winPctOf(e);
    case "expR": return e.expectancyR ?? e.avgR;
  }
}
function fmtMetric(m: Metric, v: number | null): string {
  switch (m) {
    case "r": return fmtR(v, 1);
    case "pnl": return fmtUsd(v, { signed: true, decimals: 0 });
    case "winrate": return fmtPct(v, { decimals: 0, signed: false });
    case "expR": return fmtR(v, 2);
  }
}
function rankBy<T extends MetricSource & { trader: string }>(list: T[], m: Metric): T[] {
  const val = (e: T) => metricOf(m, e) ?? Number.NEGATIVE_INFINITY; // unknown (null) sorts last
  return [...list].sort((a, b) => (val(b) === val(a) ? 0 : val(b) - val(a)) || b.totalTrades - a.totalTrades || comparePersonNames(a.trader, b.trader));
}

/** Whether any trade in the row has a P&L value (older API builds lack pnlCount). */
function hasPnlOf(l: LeaderboardEntry): boolean {
  return (l.pnlCount ?? (l.totalPnl !== 0 ? 1 : 0)) > 0;
}

export type RankedEntry = LeaderboardEntry & { rank: number; rankDelta: number | null; isNew: boolean };

/** Shared hook: leaderboard for a period, ranked by metric, with rank change vs previous period. */
export function useLeaderboard(period: Period, metric: Metric | "auto") {
  const q = useQuery<LeaderboardEntry[]>({
    queryKey: ["leaderboard", period],
    queryFn: ({ signal }) => http.get<LeaderboardEntry[]>("/api/leaderboard", { query: { days: period === "all" ? null : period }, signal }),
    staleTime: STALE.default,
  });
  const leaders = q.data ?? [];
  const hasPnl = leaders.some(hasPnlOf);
  const effective: Metric = metric === "auto" ? (hasPnl ? "pnl" : "r") : metric;
  const ranked = useMemo<RankedEntry[]>(() => {
    const cur = rankBy(leaders, effective);
    const withPrev = leaders.filter((l) => l.prev && l.prev.totalTrades > 0);
    const prevRanked = rankBy(withPrev.map((l) => ({ ...l.prev!, trader: l.trader })), effective);
    const prevRank = new Map(prevRanked.map((p, i) => [p.trader, i + 1]));
    return cur.map((l, i) => {
      const pr = prevRank.get(l.trader);
      return { ...l, rank: i + 1, rankDelta: pr != null ? pr - (i + 1) : null, isNew: pr == null };
    });
  }, [leaders, effective]);
  return { ...q, ranked, metric: effective, hasPnl };
}

function sharpeOf(l: LeaderboardEntry): { value: number | null; basis: "$" | "R" | null } {
  if (l.sharpeDaily != null) return { value: l.sharpeDaily, basis: "$" };
  if (l.sharpeDailyR != null) return { value: l.sharpeDailyR, basis: "R" };
  return { value: null, basis: null };
}

const MEDAL = ["text-[hsl(var(--chart-3))]", "text-muted-foreground", "text-[hsl(var(--chart-5))]"];

export function LeaderboardTab({ me }: { me: string | null }) {
  const [period, setPeriod] = useStoredState<Period>("ratings.lb.period", "30", PERIOD_VALUES);
  const [metricPref, setMetricPref] = useStoredState<Metric | "auto">("ratings.lb.metric", "auto", METRIC_VALUES);
  const { ranked, metric, isLoading, isError, error, refetch, hasPnl } = useLeaderboard(period, metricPref);
  const { t } = ratingsI18n.useT();
  const { t: tc } = commonI18n.useT();
  const METRICS = metricOptions();

  const team = useMemo(() => {
    if (ranked.length === 0) return null;
    const trades = ranked.reduce((s, l) => s + l.totalTrades, 0);
    // Win rate = W/(W+L): break-evens are excluded (same rule as the server rows).
    const wins = ranked.reduce((s, l) => s + l.wins, 0);
    const decided = ranked.reduce((s, l) => s + l.wins + l.losses, 0);
    // Σ R only over traders whose R is known; null when nobody has a stop → the card falls back to net $.
    const withR = ranked.filter((l) => l.totalR != null);
    const r = withR.length > 0 ? withR.reduce((s, l) => s + (l.totalR ?? 0), 0) : null;
    const pnlRows = ranked.filter(hasPnlOf);
    const pnl = pnlRows.length > 0 ? pnlRows.reduce((s, l) => s + l.totalPnl, 0) : null;
    const streak = [...ranked].sort((a, b) => b.bestStreak - a.bestStreak)[0];
    const hot = [...ranked].filter((l) => l.currentStreak > 0).sort((a, b) => b.currentStreak - a.currentStreak)[0];
    return { trades, winrate: decided > 0 ? (wins / decided) * 100 : null, r, pnl, streak, hot };
  }, [ranked]);

  const periodFor = t(`leaderboard.periodFor.${periodKey(period)}`);
  const prevLabel = period === "all" ? t("leaderboard.prevAll") : t("leaderboard.prevPeriod");

  function exportCsv() {
    downloadCsv(
      `leaderboard-${period}.csv`,
      ["#", t("leaderboard.csv.trader"), t("leaderboard.csv.trades"), t("leaderboard.csv.winRatePct"), t("leaderboard.csv.totalR"), t("leaderboard.csv.expR"), "P&L $", t("leaderboard.csv.sharpe"), t("leaderboard.csv.streak"), t("leaderboard.csv.bestStreak")],
      ranked.map((l) => [l.rank, personName(l.trader), l.totalTrades, winPctOf(l), l.totalR, l.expectancyR ?? l.avgR, l.totalPnl, sharpeOf(l).value, l.currentStreak, l.bestStreak]),
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented ariaLabel={t("leaderboard.periodAria")} options={PERIODS.map((p) => ({ value: p.value, label: t(`leaderboard.periods.${p.key}`) }))} value={period} onChange={setPeriod} />
        <Segmented
          ariaLabel={t("leaderboard.rankByAria")}
          size="sm"
          options={METRICS.map((m) => ({ ...m, disabled: m.value === "pnl" && !hasPnl && ranked.length > 0 }))}
          value={metric}
          onChange={(v) => setMetricPref(v)}
        />
        <Button variant="ghost" size="sm" className="ml-auto gap-1.5" onClick={exportCsv} disabled={ranked.length === 0}>
          <Download className="h-4 w-4" aria-hidden="true" /> CSV
        </Button>
      </div>

      {isLoading && (
        <div className="flex flex-col gap-3" aria-busy="true" aria-label={t("leaderboard.loading")}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-36 rounded-2xl" />)}
          </div>
          <Skeleton className="h-64 rounded-2xl" />
        </div>
      )}
      {isError && <QueryError error={error} onRetry={() => refetch()} />}
      {!isLoading && !isError && ranked.length === 0 && (
        <Panel>
          <EmptyState
            icon={Trophy}
            title={period === "all" ? t("leaderboard.emptyAll") : t("leaderboard.emptyPeriod", { period: t(`leaderboard.periods.${periodKey(period)}`).toLowerCase() })}
            description={t("leaderboard.emptyDescription")}
            action={period !== "all" ? <Button variant="outline" size="sm" onClick={() => setPeriod("all")}>{t("leaderboard.showAll")}</Button> : undefined}
          />
        </Panel>
      )}

      {ranked.length > 0 && (
        <>
          {/* Podium */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {ranked.slice(0, 3).map((l, i) => {
              const v = metricOf(metric, l);
              return (
                <div
                  key={l.trader}
                  className={cn(
                    "glass-panel lift flex flex-col gap-3 rounded-2xl p-4",
                    i === 0 && "ring-1 ring-primary/60",
                  )}
                >
                  <div className="flex items-center gap-3">
                    <span className={cn("grid h-9 w-9 place-items-center rounded-full bg-[var(--glass-hover-bg)]", MEDAL[i])} aria-label={t("leaderboard.place", { n: i + 1 })}>
                      {i === 0 ? <Crown className="h-4 w-4" aria-hidden="true" /> : <Medal className="h-4 w-4" aria-hidden="true" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-foreground" title={personName(l.trader)}>{personName(l.trader)}</span>
                        {l.trader === me && <Pill tone="accent">{t("shared.you")}</Pill>}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="tabular-nums">#{i + 1}</span>
                        <RankDelta delta={l.rankDelta} isNew={l.isNew} />
                      </div>
                    </div>
                    <StreakBadge value={l.currentStreak} />
                  </div>
                  <div className="flex items-end justify-between gap-2">
                    <div>
                      <div className="text-xs text-muted-foreground">{METRICS.find((m) => m.value === metric)?.label}</div>
                      <div className={cn("text-2xl font-semibold tabular-nums tracking-tight", metric === "winrate" ? "text-foreground" : toneText(toneOf(v)))}>
                        {fmtMetric(metric, v)}
                      </div>
                    </div>
                    <Sparkline values={l.sparkR ?? []} width={96} height={32} label={t("leaderboard.cumR", { r: fmtR(l.totalR, 1) })} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <OutcomeBar wins={l.wins} losses={l.losses} be={l.breakevens} open={l.open ?? 0} />
                    <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
                      <span>{tc("units.trades", { count: l.totalTrades })}</span>
                      <span>WR {fmtPct(winPctOf(l), { decimals: 0, signed: false })}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {team && (
            <StatGrid>
              <StatCard label={t("leaderboard.teamTrades")} value={fmtCount(team.trades)} icon={Users} hint={periodFor} />
              <StatCard label={t("leaderboard.teamWinrate")} value={fmtPct(team.winrate, { decimals: 0, signed: false })} hint={t("leaderboard.teamWinrateHint")} />
              {team.r != null || team.pnl == null ? (
                <StatCard label={t("leaderboard.teamR")} value={fmtR(team.r, 1)} tone={toneOf(team.r)} hint={team.r == null ? t("leaderboard.rUnknown") : undefined} />
              ) : (
                <StatCard label={t("leaderboard.teamPnl")} value={fmtUsd(team.pnl, { signed: true, decimals: 0 })} tone={toneOf(team.pnl)} hint={t("leaderboard.teamPnlHint")} />
              )}
              <StatCard
                label={team.hot ? t("leaderboard.hotStreak") : t("leaderboard.bestStreak")}
                icon={Flame}
                value={team.hot ? `W${team.hot.currentStreak}` : team.streak.bestStreak > 0 ? `W${team.streak.bestStreak}` : "—"}
                tone={team.hot || team.streak.bestStreak > 0 ? "up" : "neutral"}
                hint={team.hot ? personName(team.hot.trader) : team.streak.bestStreak > 0 ? personName(team.streak.trader) : t("leaderboard.noStreaks")}
              />
            </StatGrid>
          )}

          {/* Desktop table */}
          <Panel padded={false} className="hidden md:block" title={t("leaderboard.table")} description={t("leaderboard.tableDescription", { prev: prevLabel })}>
            <TableScroll className="max-h-[70vh] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-sticky bg-[var(--sticky-bg)] text-xs text-muted-foreground">
                  <tr className="border-b border-border">
                    <th scope="col" className="w-16 px-4 py-2.5 text-left font-medium">#</th>
                    <th scope="col" className="px-2 py-2.5 text-left font-medium">{t("leaderboard.trader")}</th>
                    {METRICS.map((m) => (
                      <th key={m.value} scope="col" className="px-2 py-2.5 text-right font-medium" aria-sort={metric === m.value ? "descending" : "none"}>
                        <button
                          type="button"
                          onClick={() => setMetricPref(m.value)}
                          disabled={m.value === "pnl" && !hasPnl}
                          className={cn("inline-flex flex-row-reverse items-center gap-1 rounded-full px-1.5 py-0.5 hover:text-foreground disabled:opacity-50", metric === m.value && "text-primary")}
                          title={t("leaderboard.byMetricTitle")}
                        >
                          {m.label}
                          {metric === m.value
                            ? <ChevronDown className="h-3 w-3" aria-hidden="true" />
                            : <ChevronsUpDown className="h-3 w-3 opacity-50" aria-hidden="true" />}
                        </button>
                      </th>
                    ))}
                    <th scope="col" className="px-2 py-2.5 text-right font-medium" title={t("leaderboard.sharpeTitle")}>{t("leaderboard.sharpe")}</th>
                    <th scope="col" className="px-2 py-2.5 text-right font-medium">{t("leaderboard.streak")}</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-medium">{t("leaderboard.trendR")}</th>
                  </tr>
                </thead>
                <tbody>
                  {ranked.map((l) => {
                    const sh = sharpeOf(l);
                    const mine = l.trader === me;
                    return (
                      <tr key={l.trader} className={cn("border-b border-border/60 last:border-0 transition-colors hover:bg-[var(--glass-hover-bg)]", mine && "bg-primary/5")}>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <span className={cn("w-5 font-semibold tabular-nums", l.rank <= 3 ? MEDAL[l.rank - 1] : "text-muted-foreground")}>{l.rank}</span>
                            <RankDelta delta={l.rankDelta} isNew={l.isNew} />
                          </div>
                        </td>
                        <td className="px-2 py-2.5">
                          <div className="flex items-center gap-2">
                            <Avatar name={l.trader} highlight={mine} className="h-7 w-7" />
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="font-medium text-foreground">{personName(l.trader)}</span>
                                {mine && <Pill tone="accent">{t("shared.you")}</Pill>}
                              </div>
                              <div className="text-xs text-muted-foreground tabular-nums">
                                {tc("units.trades", { count: l.totalTrades })} · {l.wins}/{l.losses}/{l.breakevens}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className={cn("px-2 py-2.5 text-right tabular-nums", toneText(toneOf(l.totalR)), metric === "r" && "font-semibold")}>{fmtR(l.totalR, 1)}</td>
                        <td className={cn("px-2 py-2.5 text-right tabular-nums", hasPnlOf(l) ? toneText(toneOf(l.totalPnl)) : "text-muted-foreground", metric === "pnl" && "font-semibold")}>
                          {hasPnlOf(l) ? fmtUsd(l.totalPnl, { signed: true, decimals: 0 }) : "—"}
                        </td>
                        <td className={cn("px-2 py-2.5 text-right tabular-nums", metric === "winrate" && "font-semibold")}>{fmtPct(winPctOf(l), { decimals: 0, signed: false })}</td>
                        <td className={cn("px-2 py-2.5 text-right tabular-nums", toneText(toneOf(l.expectancyR ?? l.avgR)), metric === "expR" && "font-semibold")}>{fmtR(l.expectancyR ?? l.avgR, 2)}</td>
                        <td className="px-2 py-2.5 text-right tabular-nums" title={sh.value == null ? t("leaderboard.needDays") : t("leaderboard.dailyBasis", { basis: sh.basis === "$" ? "$" : "R" })}>
                          {sh.value == null ? <span className="text-muted-foreground">—</span> : (
                            <span className={toneText(toneOf(sh.value))}>{fmtNum(sh.value, { decimals: 2, signed: true })}{sh.basis === "R" && <span className="ml-0.5 text-2xs text-muted-foreground">R</span>}</span>
                          )}
                        </td>
                        <td className="px-2 py-2.5 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <StreakBadge value={l.currentStreak} />
                            {l.bestStreak > 1 && <span className="text-2xs text-muted-foreground tabular-nums" title={t("leaderboard.bestStreak")}>{t("leaderboard.maxStreak", { count: l.bestStreak })}</span>}
                          </div>
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex justify-end"><Sparkline values={l.sparkR ?? []} /></div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableScroll>
          </Panel>

          {/* Mobile cards */}
          <ul className="flex flex-col gap-2 md:hidden" aria-label={t("leaderboard.table")}>
            {ranked.map((l) => {
              const v = metricOf(metric, l);
              const mine = l.trader === me;
              return (
                <li key={l.trader} className={cn("glass-panel flex items-center gap-3 rounded-2xl p-3", mine && "ring-1 ring-primary/50")}>
                  <div className="flex w-8 flex-col items-center gap-0.5">
                    <span className={cn("font-semibold tabular-nums", l.rank <= 3 ? MEDAL[l.rank - 1] : "text-muted-foreground")}>{l.rank}</span>
                    <RankDelta delta={l.rankDelta} isNew={l.isNew} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-medium text-foreground" title={personName(l.trader)}>{personName(l.trader)}</span>
                      {mine && <Pill tone="accent">{t("shared.you")}</Pill>}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground tabular-nums">
                      <span>{t("leaderboard.tradesShort", { count: l.totalTrades })}</span>
                      <span>WR {fmtPct(winPctOf(l), { decimals: 0, signed: false })}</span>
                      <StreakBadge value={l.currentStreak} className="px-1.5 py-0 text-2xs" />
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className={cn("font-semibold tabular-nums", metric === "winrate" ? "text-foreground" : toneText(toneOf(v)))}>{fmtMetric(metric, v)}</span>
                    <Sparkline values={l.sparkR ?? []} width={64} height={20} />
                  </div>
                </li>
              );
            })}
          </ul>

          <p className="text-xs text-muted-foreground">{t("leaderboard.footnote")}</p>
        </>
      )}
    </div>
  );
}
