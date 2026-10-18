import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import type { Trade } from "@workspace/api-client-react";
import { BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Legend } from "recharts";
import {
  Brain, Lightbulb, TrendingUp, TrendingDown, Minus, Moon, Activity, Gauge, CalendarDays, RefreshCw, Sparkles,
} from "lucide-react";
import { Panel, StatCard, StatGrid, EmptyState, Pill, toneOf, type Tone } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { http } from "@/lib/api/http";
import { cn } from "@/lib/utils";
import { type AnalyticsFilters, periodRange, CHART_TOOLTIP_STYLE, CHART_CURSOR, AXIS, GRID } from "./metrics";
import { commonI18n } from "@/i18n/ns/common";
import { analyticsI18n } from "@/i18n/ns/analytics";
import { personName } from "@/i18n";
import { fmtDate, fmtNum, fmtR, fmtRate, fmtUsd } from "@/lib/format";

/* ───────────── API types ───────────── */

type Confidence = "low" | "medium" | "high";
// winRate = W/(W+L), null when nothing is decided; avg* null when unknown (server: lib/tradeMath, audit P0-5)
type GroupAgg = { count: number; wins: number; losses?: number; winRate: number | null; avgR: number | null; rCount: number; avgPnl: number | null; pnlCount: number };
type Comparison = {
  key: string; label: string; withLabel: string; withoutLabel: string;
  with: GroupAgg; without: GroupAgg; deltaWinRatePp: number | null; deltaR: number | null;
  impact: number; confidence: Confidence; text: string;
};
type RankedInsight = { id: string; title: string; text: string; tone: "up" | "down" | "neutral"; impact: number; sample: number; confidence: Confidence };
type Checkin = {
  date: string; sleepWell: boolean; stressed: boolean; tilted: boolean; focused: boolean; anxious: boolean; revenge: boolean;
  trades?: number; wins?: number; sumR?: number | null;
};
type PsychologyAnalytics = {
  byConviction: { conviction: number; count: number; winRate: number | null; avgPnl: number | null; expectancy: number | null; avgR?: number | null }[];
  byConfidenceGrade: { grade: string; count: number; winRate: number | null; avgPnl: number | null; avgR?: number | null }[];
  heatmap: { grade: string; outcome: string; count: number }[];
  emotionalByMonth: { month: string; sleepWell: number; stressed: number; tilted: number; focused: number; anxious: number; revenge: number; total: number }[];
  insights: string[];
  rankedInsights?: RankedInsight[];
  factors?: Comparison[];
  behavior?: Comparison[];
  coverage?: { trades: number; tradesWithCheckin: number; checkins: number; tradesWithConviction: number; tradesWithGrade: number; tradesWithR: number; tradesWithPnl: number };
  recentCheckins: Checkin[];
  confidencePnlCorrelation?: number | null;
  convictionPnlCorrelation?: number | null;
  confidenceRCorrelation?: number | null;
  convictionRCorrelation?: number | null;
};

const CONF_TONE: Record<Confidence, Tone> = { low: "neutral", medium: "warn", high: "up" };
const confLabel = (c: Confidence) => analyticsI18n.t(`psych.conf.${c}`);

function corrSentence(r: number, what: string): { text: string; tone: Tone } {
  const t = analyticsI18n.t;
  const a = Math.abs(r);
  const strength = a < 0.3 ? t("psych.corr.weak") : a < 0.5 ? t("psych.corr.moderate") : t("psych.corr.strong");
  const dir = r > 0 ? t("psych.corr.direct") : t("psych.corr.inverse");
  const rStr = `r = ${fmtNum(r, { signed: true })}`;
  if (a < 0.1) return { text: t("psych.corr.noLink", { what, r: rStr }), tone: "neutral" };
  if (a < 0.3) return { text: t("psych.corr.weakLink", { what, strength, dir, r: rStr }), tone: "neutral" };
  return r > 0
    ? { text: t("psych.corr.positive", { what, strength, r: rStr }), tone: "up" }
    : { text: t("psych.corr.negative", { what, strength, r: rStr }), tone: "down" };
}

/* ───────────── Component ───────────── */

export function PsychologyTab({
  userId,
  isOwn,
  filters,
  trades,
}: {
  userId: string;
  isOwn: boolean;
  filters: AnalyticsFilters;
  trades: Trade[];
}) {
  const { t } = analyticsI18n.useT();
  const params = useMemo(() => {
    const sp = new URLSearchParams({ userId });
    const r = periodRange(filters.period);
    if (r) { sp.set("from", r.from); sp.set("to", r.to); }
    if (filters.side) sp.set("side", filters.side);
    if (filters.ticker) sp.set("ticker", filters.ticker);
    if (filters.setup) sp.set("setup", filters.setup);
    if (filters.horizon) sp.set("horizon", filters.horizon);
    return sp.toString();
  }, [userId, filters]);

  const { data: psych, isLoading, isError, refetch, isFetching } = useQuery<PsychologyAnalytics>({
    queryKey: ["analytics-psychology", params],
    enabled: !!userId,
    staleTime: 60_000,
    queryFn: ({ signal }) => http.get<PsychologyAnalytics>(`/api/analytics/psychology?${params}`, { signal }),
  });

  const myTrades = useMemo(() => trades.filter((t) => (t.trader ?? "") === userId), [trades, userId]);
  const avgConviction = useMemo(() => {
    const c = myTrades.filter((t) => t.conviction != null);
    return c.length ? c.reduce((s, t) => s + Number(t.conviction), 0) / c.length : null;
  }, [myTrades]);

  if (!userId) {
    return <EmptyState icon={Brain} title={t("psych.pickTrader")} description={t("psych.pickTraderHint")} />;
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label={t("psych.loadingAria")}>
        <StatGrid>{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[96px] rounded-2xl" />)}</StatGrid>
        <Skeleton className="h-[220px] rounded-2xl" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Skeleton className="h-[280px] rounded-2xl" />
          <Skeleton className="h-[280px] rounded-2xl" />
        </div>
      </div>
    );
  }

  if (isError || !psych) {
    return (
      <Panel>
        <EmptyState
          icon={Brain}
          title={t("psych.loadError")}
          description={t("psych.loadErrorHint")}
          action={<Button variant="outline" onClick={() => void refetch()}><RefreshCw aria-hidden="true" /> {commonI18n.t("actions.retry")}</Button>}
        />
      </Panel>
    );
  }

  const cov = psych.coverage;
  const covPct = cov && cov.trades ? cov.tradesWithCheckin / cov.trades : null;
  const ranked = psych.rankedInsights ?? [];
  const maxImpact = Math.max(0.01, ...ranked.map((i) => i.impact));
  const factors = psych.factors ?? [];
  const behavior = psych.behavior ?? [];
  const useR = (cov?.tradesWithR ?? 0) >= (cov?.tradesWithPnl ?? 0);
  const convCorr = useR ? psych.convictionRCorrelation : psych.convictionPnlCorrelation ?? psych.convictionRCorrelation;
  const gradeCorr = useR ? psych.confidenceRCorrelation : psych.confidencePnlCorrelation ?? psych.confidenceRCorrelation;
  const hasConviction = psych.byConviction.some((d) => d.count > 0);
  const hasGrades = psych.byConfidenceGrade.length > 0;
  const nothing = (cov?.trades ?? 0) === 0 && psych.recentCheckins.length === 0;

  return (
    <div className={cn("flex flex-col gap-4 sm:gap-5 transition-opacity", isFetching && "opacity-70")}>
      {!isOwn && (
        <p className="text-sm text-muted-foreground">{t("psych.ofTrader", { name: personName(userId) })}</p>
      )}

      <StatGrid>
        <StatCard label={t("psych.checkins")} value={cov?.checkins ?? psych.recentCheckins.length} icon={CalendarDays}
          hint={cov?.checkins ? undefined : t("psych.checkinsHint")} />
        <StatCard
          label={t("psych.withCheckin")}
          value={covPct != null ? fmtRate(covPct) : "—"}
          tone={covPct == null ? "neutral" : covPct >= 0.7 ? "up" : covPct >= 0.3 ? "warn" : "down"}
          hint={cov ? t("psych.ofTotal", { value: cov.tradesWithCheckin, total: cov.trades }) : undefined}
          icon={Activity}
        />
        <StatCard
          label={t("psych.avgConviction")}
          value={avgConviction != null ? `${fmtNum(avgConviction, { decimals: 1 })}★` : "—"}
          hint={cov ? t("psych.rated", { value: cov.tradesWithConviction, total: cov.trades }) : undefined}
          icon={Gauge}
        />
        <StatCard
          label={t("psych.withGrade")}
          value={cov?.tradesWithGrade ?? 0}
          hint={cov && cov.trades ? t("psych.gradeShare", { share: fmtRate(cov.tradesWithGrade / cov.trades) }) : undefined}
          icon={Sparkles}
        />
      </StatGrid>

      {nothing ? (
        <Panel>
          <EmptyState
            icon={Brain}
            title={t("psych.emptyTitle")}
            description={t("psych.emptyHint")}
            action={<Button asChild variant="outline"><Link href="/">{t("psych.doCheckin")}</Link></Button>}
          />
        </Panel>
      ) : (
        <>
          <Panel
            icon={Lightbulb}
            title={t("psych.rankedTitle")}
            description={t("psych.rankedHint")}
          >
            {ranked.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">{t("psych.rankedEmpty")}</p>
            ) : (
              <ol className="flex flex-col gap-2">
                {ranked.map((ins, i) => {
                  const Icon = ins.tone === "up" ? TrendingUp : ins.tone === "down" ? TrendingDown : Minus;
                  return (
                    <li key={ins.id} className="flex gap-3 rounded-xl bg-[var(--glass-bg)] p-3">
                      <span
                        className={cn(
                          "grid h-8 w-8 shrink-0 place-items-center rounded-full",
                          ins.tone === "up" ? "bg-up/15 text-up" : ins.tone === "down" ? "bg-down/15 text-down" : "bg-primary/15 text-primary",
                        )}
                        aria-hidden="true"
                      >
                        <Icon className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs tabular-nums text-muted-foreground">#{i + 1}</span>
                          <span className="text-sm font-semibold text-foreground">{ins.title}</span>
                          <Pill tone={CONF_TONE[ins.confidence]}>{confLabel(ins.confidence)}</Pill>
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">{ins.text}</p>
                        {ins.impact > 0 && (
                          <div className="mt-2 flex items-center gap-2" title={t("psych.impactTitle")}>
                            <div className="h-1 w-full max-w-[220px] overflow-hidden rounded-full bg-[var(--glass-bg)]">
                              <div
                                className={cn("h-full rounded-full", ins.tone === "down" ? "bg-down" : ins.tone === "up" ? "bg-up" : "bg-primary")}
                                style={{ width: `${Math.max(6, (ins.impact / maxImpact) * 100)}%` }}
                              />
                            </div>
                            <span className="text-2xs text-muted-foreground">{t("psych.impact")}</span>
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </Panel>

          <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-2">
            <ComparisonPanel
              icon={Moon}
              title={t("psych.wellbeing")}
              description={t("psych.wellbeingHint")}
              rows={factors}
              empty={t("psych.wellbeingEmpty")}
            />
            <ComparisonPanel
              icon={Activity}
              title={t("psych.behavior")}
              description={t("psych.behaviorHint")}
              rows={behavior}
              empty={t("psych.behaviorEmpty")}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-2">
            <Panel icon={Gauge} title={t("psych.conviction")} description={t("psych.convictionHint")}>
              {hasConviction ? (
                <div className="h-[230px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={psych.byConviction.map((d) => ({ ...d, level: `${d.conviction}★`, wr: d.winRate == null ? null : Math.round(d.winRate * 100) }))} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
                      <XAxis dataKey="level" {...AXIS} />
                      <YAxis {...AXIS} domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} />
                      <ReferenceLine y={50} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
                      <Tooltip
                        contentStyle={CHART_TOOLTIP_STYLE}
                        cursor={CHART_CURSOR}
                        formatter={(v: number, _n, item) => {
                          const d = item.payload as { count: number; wr: number | null; avgR?: number | null };
                          return [d.count ? `${d.wr == null ? "—" : `${v}%`} · ${commonI18n.t("units.trades", { count: d.count })}${d.avgR != null ? ` · ${fmtR(d.avgR)}` : ""}` : t("psych.noTrades"), "Win rate"];
                        }}
                      />
                      <Bar dataKey="wr" radius={[6, 6, 0, 0]} isAnimationActive={false}>
                        {psych.byConviction.map((d) => (
                          <Cell key={d.conviction} fill={d.winRate == null ? "hsl(var(--muted-foreground))" : d.winRate >= 0.5 ? "hsl(var(--up))" : "hsl(var(--down))"} fillOpacity={d.count < 3 ? 0.4 : 0.9} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <p className="py-6 text-sm text-muted-foreground">{t("psych.convictionEmpty")}</p>
              )}
              {convCorr != null && <CorrLine {...corrSentence(convCorr, t("psych.convictionWhat"))} />}
            </Panel>

            <Panel icon={Sparkles} title={t("psych.grades")} description={t("psych.gradesHint")}>
              {hasGrades ? <GradeMatrix psych={psych} /> : (
                <p className="py-6 text-sm text-muted-foreground">{t("psych.gradesEmpty")}</p>
              )}
              {gradeCorr != null && <CorrLine {...corrSentence(gradeCorr, t("psych.gradeWhat"))} />}
            </Panel>
          </div>

          {psych.emotionalByMonth.length > 0 && (
            <Panel icon={CalendarDays} title={t("psych.byMonth")} description={t("psych.byMonthHint")}>
              <div className="h-[240px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={psych.emotionalByMonth} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
                    <XAxis dataKey="month" {...AXIS} />
                    <YAxis {...AXIS} allowDecimals={false} />
                    <Tooltip contentStyle={CHART_TOOLTIP_STYLE} cursor={CHART_CURSOR} />
                    <Legend wrapperStyle={{ fontSize: 12 }} iconSize={10} iconType="circle" />
                    <Bar dataKey="sleepWell" name={t("psych.state.sleepWell")} stackId="a" fill="hsl(var(--chart-1))" isAnimationActive={false} />
                    <Bar dataKey="focused" name={t("psych.state.focused")} stackId="a" fill="hsl(var(--up))" isAnimationActive={false} />
                    <Bar dataKey="stressed" name={t("psych.state.stressed")} stackId="a" fill="hsl(var(--chart-3))" isAnimationActive={false} />
                    <Bar dataKey="anxious" name={t("psych.state.anxious")} stackId="a" fill="hsl(var(--chart-5))" isAnimationActive={false} />
                    <Bar dataKey="tilted" name={t("psych.state.tilted")} stackId="a" fill="hsl(var(--chart-4))" isAnimationActive={false} />
                    <Bar dataKey="revenge" name={t("psych.state.revenge")} stackId="a" fill="hsl(var(--down))" radius={[4, 4, 0, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Panel>
          )}

          <Panel icon={CalendarDays} title={t("psych.history")} description={t("psych.historyHint")}>
            {psych.recentCheckins.length === 0 ? (
              <EmptyState
                icon={CalendarDays}
                title={t("psych.noCheckins")}
                description={t("psych.noCheckinsHint")}
                action={<Button asChild variant="outline" size="sm"><Link href="/">{t("psych.openHome")}</Link></Button>}
                className="py-6"
              />
            ) : (
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {psych.recentCheckins.map((c) => <CheckinTile key={c.date} c={c} />)}
              </ul>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

/* ───────────── Pieces ───────────── */

function CorrLine({ text, tone }: { text: string; tone: Tone }) {
  return (
    <p className={cn(
      "mt-3 rounded-xl px-3 py-2 text-sm",
      tone === "up" ? "bg-up/10 text-foreground" : tone === "down" ? "bg-down/10 text-foreground" : "bg-[var(--glass-bg)] text-muted-foreground",
    )}>
      {text}
    </p>
  );
}

function ComparisonPanel({
  icon, title, description, rows, empty,
}: {
  icon: typeof Moon;
  title: string;
  description: string;
  rows: Comparison[];
  empty: string;
}) {
  return (
    <Panel icon={icon} title={title} description={description}>
      {rows.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((c) => {
            const tone = toneOf(c.deltaR ?? c.deltaWinRatePp ?? 0);
            return (
              <li key={c.key} className="rounded-xl bg-[var(--glass-bg)] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-foreground">{c.label}</span>
                  <div className="flex items-center gap-1.5">
                    <Pill tone={tone}>
                      {c.deltaWinRatePp != null && commonI18n.t("units.percentPoints", { value: `${c.deltaWinRatePp > 0 ? "+" : c.deltaWinRatePp < 0 ? "−" : ""}${Math.abs(c.deltaWinRatePp)}` })}
                      {c.deltaR != null && `${c.deltaWinRatePp != null ? " · " : ""}${fmtR(c.deltaR)}`}
                    </Pill>
                    <Pill tone={CONF_TONE[c.confidence]}>{confLabel(c.confidence)}</Pill>
                  </div>
                </div>
                <div className="mt-2 flex flex-col gap-1.5">
                  <CompareBar label={c.withLabel} g={c.with} strong />
                  <CompareBar label={c.withoutLabel} g={c.without} />
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{c.text}</p>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function CompareBar({ label, g, strong }: { label: string; g: GroupAgg; strong?: boolean }) {
  return (
    <div className="grid grid-cols-[minmax(0,7.5rem)_1fr_auto] items-center gap-2 text-xs tabular-nums">
      <span className={cn("truncate", strong ? "text-foreground" : "text-muted-foreground")} title={label}>{label}</span>
      <div className="relative h-2 rounded-full bg-[var(--glass-bg)]" aria-hidden="true">
        <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
        {g.winRate != null && (
          <div
            className={cn("h-full rounded-full", g.winRate >= 0.5 ? "bg-up" : "bg-down", !strong && "opacity-50")}
            style={{ width: `${Math.max(2, g.winRate * 100)}%` }}
          />
        )}
      </div>
      <span className="w-[8.5rem] text-right text-muted-foreground">
        <span className="text-foreground">{fmtRate(g.winRate)}</span>
        {g.avgR != null && <> · {fmtR(g.avgR, 1)}</>}
        {g.avgR == null && g.avgPnl != null && <> · {fmtUsd(g.avgPnl, { signed: true, decimals: "auto" })}</>}
        {" · "}{g.count}
      </span>
    </div>
  );
}

function GradeMatrix({ psych }: { psych: PsychologyAnalytics }) {
  const { t } = analyticsI18n.useT();
  const grades = ["A+", "A", "B", "C"];
  const outcomes = [
    { k: "win", label: t("psych.win"), cls: "bg-up/15 text-up" },
    { k: "breakeven", label: t("psych.be"), cls: "bg-[var(--glass-bg)] text-muted-foreground" },
    { k: "loss", label: t("psych.loss"), cls: "bg-down/15 text-down" },
  ];
  const map: Record<string, Record<string, number>> = {};
  psych.heatmap.forEach(({ grade, outcome, count }) => {
    (map[grade] ??= {})[outcome] = count;
  });
  const stats = new Map(psych.byConfidenceGrade.map((g) => [g.grade, g]));
  return (
    <table className="w-full text-sm tabular-nums">
      <thead>
        <tr className="text-left text-xs text-muted-foreground">
          <th className="py-1.5 pr-2 font-normal">{t("psych.colGrade")}</th>
          {outcomes.map((o) => <th key={o.k} className="px-1 py-1.5 text-center font-normal">{o.label}</th>)}
          <th className="py-1.5 pl-2 text-right font-normal">{t("psych.colWrR")}</th>
        </tr>
      </thead>
      <tbody>
        {grades.filter((g) => map[g]).map((g) => {
          const row = map[g];
          const total = outcomes.reduce((s, o) => s + (row[o.k] ?? 0), 0);
          const st = stats.get(g);
          return (
            <tr key={g}>
              <td className="py-1 pr-2 font-semibold text-foreground">{g}</td>
              {outcomes.map((o) => {
                const n = row[o.k] ?? 0;
                return (
                  <td key={o.k} className="p-1">
                    <div className={cn("rounded-lg px-2 py-1.5 text-center", n ? o.cls : "text-muted-foreground")}>
                      {n ? <>{n}<span className="ml-1 text-2xs opacity-80">{fmtRate(n / total)}</span></> : "—"}
                    </div>
                  </td>
                );
              })}
              <td className="py-1 pl-2 text-right text-xs text-muted-foreground">
                {st ? <>{fmtRate(st.winRate)}{st.avgR != null && <> · {fmtR(st.avgR, 1)}</>}</> : "—"}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

type StateKey = "sleepWell" | "focused" | "stressed" | "anxious" | "tilted" | "revenge";
const STATE_PILLS: { k: StateKey; tone: Tone }[] = [
  { k: "sleepWell", tone: "accent" },
  { k: "focused", tone: "up" },
  { k: "stressed", tone: "warn" },
  { k: "anxious", tone: "purple" },
  { k: "tilted", tone: "down" },
  { k: "revenge", tone: "down" },
];

function CheckinTile({ c }: { c: Checkin }) {
  const { t } = analyticsI18n.useT();
  const states = STATE_PILLS.filter((s) => c[s.k]);
  const d = new Date(`${c.date}T00:00:00`);
  const label = isNaN(d.getTime()) ? c.date : fmtDate(d, "weekdayDayMonth");
  return (
    <li className="flex flex-col gap-2 rounded-xl bg-[var(--glass-bg)] p-3">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium text-foreground">{label}</span>
        {c.trades ? (
          <span className="tabular-nums text-muted-foreground">
            {commonI18n.t("units.trades", { count: c.trades })} · {t("psych.winsCount", { count: c.wins ?? 0 })}
            {c.sumR != null && <span className={cn("ml-1 font-medium", c.sumR >= 0 ? "text-up" : "text-down")}>{fmtR(c.sumR, 1)}</span>}
          </span>
        ) : (
          <span className="text-muted-foreground">{t("psych.noTradesDay")}</span>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {states.length ? states.map((s) => <Pill key={s.k} tone={s.tone}>{t(`psych.state.${s.k}`)}</Pill>) : <span className="text-xs text-muted-foreground">{t("psych.noMarks")}</span>}

      </div>
    </li>
  );
}
