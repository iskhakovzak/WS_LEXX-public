import React, { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, RefreshCw, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Lightbulb } from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { http, ApiError } from "@/lib/api/http";
import { isNotFound } from "@/lib/api/errors";
import { STALE } from "@/lib/api/keys";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Pill, EmptyState, type Tone } from "@/components/ds";
import { cn } from "@/lib/utils";
import { addDays, nyDate } from "@/lib/trading-date";
import { links } from "@/lib/links";
import { WidgetShell, IconAction, WidgetError, Sparkline, num, relTime, useStoredState } from "@/components/widgets/widget-kit";
import { fmtDate, fmtR, fmtRate, fmtUsd, fmtWeekday } from "@/lib/format";
import { readinessTone } from "@/components/widgets/checkin-model";
import { weeklyI18n } from "@/i18n/ns/weeklyReview";
import { commonI18n } from "@/i18n/ns/common";

type StateStats = { count: number; winRate: number; avgPnl: number; totalPnl: number; avgR?: number | null };

type DayRow = { date: string; count: number; winRate: number; avgR: number | null; totalPnl: number; readiness: number | null };

type WeeklyReport = {
  id: number;
  userId: string;
  weekStart: string;
  weekEnd: string;
  totalTrades: number;
  totalCheckins: number;
  emotionalBreakdown: Record<string, StateStats> | null;
  bestState: string | null;
  worstState: string | null;
  totalPnl: string;
  avgPnlPerTrade: string;
  winRate: string;
  keyInsights: string[] | null;
  rawStats?: { days?: DayRow[]; avgR?: number | null; avgReadiness?: number | null; checkinCountByState?: Record<string, number> } | null;
  generatedAt: string;
  /** Trades in the week right now (server, P1-10); null on an older API build. */
  liveTrades?: number | null;
  /** The week's trades changed since the report was generated (e.g. saved with 0 trades before an import). */
  stale?: boolean;
  staleReason?: "trades_appeared" | "trades_changed" | null;
};
type HistoryData = { reports: WeeklyReport[]; recalcWeeks: string[] | null };

type StateKey = "focused" | "stressed" | "tilted" | "revenge" | "anxious" | "normal";
const STATE_KEYS = new Set<string>(["focused", "stressed", "tilted", "revenge", "anxious", "normal"]);
/** Check-in state code → label in the UI language (unknown codes shown as is). */
const stateLabel = (s: string) => (STATE_KEYS.has(s) ? weeklyI18n.t(`psych.states.${s as StateKey}`) : s);
const tradesShort = (count: number) => commonI18n.t("units.trades", { count });
const STATE_TONE: Record<string, Tone> = {
  focused: "up",
  normal: "neutral",
  stressed: "warn",
  tilted: "down",
  revenge: "down",
  anxious: "purple",
};


/** Monday..Friday of the current trading week (New York date, same as every desk report). */
function currentWeekBounds(): { weekStart: string; weekEnd: string } {
  const today = nyDate();
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const monday = addDays(today, dow === 0 ? -6 : 1 - dow);
  return { weekStart: monday, weekEnd: addDays(monday, 4) };
}

function Delta({ value, unit, digits = 0, invert = false, neutral = false }: { value: number | null; unit: string; digits?: number; invert?: boolean; neutral?: boolean }) {
  if (value == null || !Number.isFinite(value)) return <span className="text-muted-foreground">—</span>;
  const r = Number(value.toFixed(digits));
  if (r === 0) return <span className="text-muted-foreground">{weeklyI18n.t("psych.noChange")}</span>;
  const good = invert ? r < 0 : r > 0;
  return (
    <span className={neutral ? "text-muted-foreground" : good ? "text-up" : "text-down"}>
      {r > 0 ? "▲ +" : "▼ −"}
      {Math.abs(r).toFixed(digits)}
      {unit}
    </span>
  );
}

function Kpi({ label, value, tone = "neutral", delta }: { label: string; value: React.ReactNode; tone?: Tone; delta?: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl bg-foreground/[0.04] px-3 py-2">
      <div className="truncate text-2xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          "text-lg font-semibold tabular-nums leading-tight",
          tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "warn" ? "text-[hsl(var(--chart-3))]" : "text-foreground",
        )}
      >
        {value}
      </div>
      {delta && <div className="truncate text-2xs tabular-nums">{delta}</div>}
    </div>
  );
}

export function WeeklyPsychologyReport() {
  const { t } = weeklyI18n.useT();
  const { user } = useAuth();
  const userId = user?.traderName ?? null;
  const qc = useQueryClient();
  const { toast } = useToast();

  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);
  const [details, setDetails] = useStoredState<"open" | "closed">("weekly_psych_details", "closed", ["open", "closed"] as const);

  const historyQ = useQuery<HistoryData>({
    queryKey: ["weekly-psychology-history", userId],
    queryFn: async ({ signal }) => {
      const data = await http.get<{ reports?: WeeklyReport[]; recalcWeeks?: unknown }>("/api/psychology/weekly-report/history", {
        query: { userId: userId!, limit: 8 },
        signal,
      });
      return {
        reports: (data.reports ?? []) as WeeklyReport[],
        recalcWeeks: Array.isArray(data.recalcWeeks) ? (data.recalcWeeks as string[]) : null,
      };
    },
    enabled: !!userId,
    staleTime: STALE.long,
    retry: 1,
  });

  const reports = useMemo(() => historyQ.data?.reports ?? [], [historyQ.data]);
  // Weeks the server lets us recalculate (current + last NY week); null on an older API build.
  const recalcWeeks = historyQ.data?.recalcWeeks ?? null;
  const safeIdx = Math.min(idx, Math.max(reports.length - 1, 0));
  const report = reports[safeIdx] ?? null;
  const prev = reports[safeIdx + 1] ?? null;
  const thisWeek = currentWeekBounds();

  // Oldest → newest for the trend sparkline.
  const trend = useMemo(() => {
    const chron = [...reports].reverse();
    return {
      wr: chron.map((r) => (r.totalTrades > 0 ? Math.round(Number(r.winRate) * 100) : null)),
      readiness: chron.map((r) => r.rawStats?.avgReadiness ?? null),
    };
  }, [reports]);

  /**
   * «Пересчитать» (P1-10): POST /recalculate for the current or last NY week (owner/staff); `weekStart` omitted ⇒
   * current week. Falls back to the old /generate (current local week) while the API predates /recalculate.
   */
  const handleGenerate = async (weekStart?: string) => {
    if (!userId || generating) return;
    setGenerating(true);
    setError(null);
    try {
      try {
        await http.post("/api/psychology/weekly-report/recalculate", { userId, ...(weekStart ? { weekStart } : {}) });
      } catch (e) {
        if (!(isNotFound(e) && !weekStart)) throw e;
        // Local Monday–Friday: the server used to derive the week from UTC and land on Sunday.
        await http.post("/api/psychology/weekly-report/generate", { userId, ...thisWeek });
      }
      const keepWeek = weekStart ?? null;
      await qc.invalidateQueries({ queryKey: ["weekly-psychology-history", userId] });
      await qc.invalidateQueries({ queryKey: ["weekly-psychology-report", userId] });
      const fresh = qc.getQueryData<HistoryData>(["weekly-psychology-history", userId])?.reports ?? [];
      const at = keepWeek ? fresh.findIndex((r) => r.weekStart === keepWeek) : -1;
      setIdx(at >= 0 ? at : 0);
      toast({ title: t("psych.recalculated") });
    } catch (e) {
      if (e instanceof ApiError && !e.isNetwork) {
        // e.message is the localized text of the error code (falls back to the server body).
        const msg = e.message || e.field<string>("error");
        setError(msg ? t("psych.buildFailed", { reason: msg }) : t("psych.buildFailedHttp", { status: e.status }));
      } else {
        setError(t("psych.networkError"));
      }
    } finally {
      setGenerating(false);
    }
  };

  if (!userId) return null;

  const hasTrades = (report?.totalTrades ?? 0) > 0;
  const wr = report && hasTrades ? Math.round(Number(report.winRate) * 100) : null;
  const prevWr = prev && prev.totalTrades > 0 ? Math.round(Number(prev.winRate) * 100) : null;
  const pnl = report ? num(report.totalPnl) : null;
  const prevPnl = prev ? num(prev.totalPnl) : null;
  const avgR = report?.rawStats?.avgR ?? null;
  const prevAvgR = prev?.rawStats?.avgR ?? null;
  const ready = report?.rawStats?.avgReadiness ?? null;
  const prevReady = prev?.rawStats?.avgReadiness ?? null;
  const isCurrent = report?.weekStart === thisWeek.weekStart;
  const days = report?.rawStats?.days ?? [];
  const breakdown = report?.emotionalBreakdown
    ? Object.entries(report.emotionalBreakdown)
        .filter(([, s]) => s.count > 0)
        .sort((a, b) => b[1].winRate - a[1].winRate)
    : [];

  return (
    <WidgetShell
      icon={Brain}
      title={t("psych.title")}
      meta={report ? `${fmtDate(report.weekStart, "dayMonth")} – ${fmtDate(report.weekEnd, "dayMonth")}` : undefined}
      actions={
        <>
          {reports.length > 1 && (
            <>
              <IconAction icon={ChevronLeft} label={t("psych.prevWeek")} disabled={safeIdx >= reports.length - 1} onClick={() => setIdx(safeIdx + 1)} />
              <IconAction icon={ChevronRight} label={t("psych.nextWeek")} disabled={safeIdx === 0} onClick={() => setIdx(safeIdx - 1)} />
            </>
          )}
          <Link href={links.weeklyReview()} className="px-1 text-xs font-medium text-primary hover:underline">{t("psych.weeklyLink")}</Link>
          <IconAction icon={RefreshCw} label={t("psych.recalcCurrent")} spinning={generating} disabled={generating} onClick={() => void handleGenerate()} />
        </>
      }
    >
      {historyQ.isLoading ? (
        <div className="space-y-3" aria-busy="true" aria-label={t("psych.loading")}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[60px] rounded-xl" />)}
          </div>
          <Skeleton className="h-10 w-full rounded-xl" />
        </div>
      ) : historyQ.isError ? (
        <WidgetError message={t("psych.loadFailed")} onRetry={() => historyQ.refetch()} />
      ) : !report ? (
        <EmptyState
          icon={Brain}
          title={t("psych.emptyTitle")}
          description={t("psych.emptyDesc")}
          action={
            <Button size="sm" onClick={() => void handleGenerate()} disabled={generating}>
              <RefreshCw className={cn(generating && "motion-safe:animate-spin")} aria-hidden="true" />
              {generating ? t("psych.building") : t("psych.build")}
            </Button>
          }
          className="py-6"
        />
      ) : (
        <div className="space-y-3">
          {report.stale && (
            <div role="status" className="flex flex-wrap items-center gap-2 rounded-xl bg-[hsl(var(--chart-3)/0.12)] px-3 py-2 text-xs">
              <span className="min-w-0 flex-1">
                {t(report.staleReason === "trades_appeared" ? "psych.staleAppeared" : "psych.staleChanged", {
                  live: report.liveTrades != null ? tradesShort(report.liveTrades) : "?",
                  stored: tradesShort(report.totalTrades),
                })}
                {recalcWeeks && !recalcWeeks.includes(report.weekStart) ? t("psych.staleOnlyRecent") : ""}
              </span>
              {(!recalcWeeks || recalcWeeks.includes(report.weekStart)) && (
                <Button size="sm" variant="secondary" onClick={() => void handleGenerate(recalcWeeks ? report.weekStart : undefined)} disabled={generating}>
                  <RefreshCw className={cn(generating && "motion-safe:animate-spin")} aria-hidden="true" />
                  {t("psych.recalc")}
                </Button>
              )}
            </div>
          )}
          {!report.stale && recalcWeeks && recalcWeeks.includes(report.weekStart) && !isCurrent && (
            <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-muted-foreground">
              <span>{t("psych.generatedAgo", { ago: relTime(report.generatedAt) })}</span>
              <Button size="sm" variant="ghost" onClick={() => void handleGenerate(report.weekStart)} disabled={generating}>
                <RefreshCw className={cn(generating && "motion-safe:animate-spin")} aria-hidden="true" />
                {t("psych.recalcThis")}
              </Button>
            </div>
          )}
          {!isCurrent && safeIdx === 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl bg-[hsl(var(--chart-3)/0.1)] px-3 py-2 text-xs">
              <span className="min-w-0 flex-1">{t("psych.lastWeekNote", { range: `${fmtDate(thisWeek.weekStart, "dayMonth")} – ${fmtDate(thisWeek.weekEnd, "dayMonth")}` })}</span>
              <Button size="sm" variant="secondary" onClick={() => void handleGenerate()} disabled={generating}>
                {t("psych.calculate")}
              </Button>
            </div>
          )}

          {/* KPIs with deltas vs previous week */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Kpi
              label={t("psych.trades")}
              value={report.totalTrades}
              delta={prev ? <Delta value={report.totalTrades - prev.totalTrades} unit="" neutral /> : undefined}
            />
            <Kpi
              label={t("psych.winRate")}
              value={wr == null ? "—" : `${wr}%`}
              tone={wr == null ? "neutral" : wr >= 50 ? "up" : "down"}
              delta={prev ? <Delta value={wr != null && prevWr != null ? wr - prevWr : null} unit={t("psych.pp")} /> : undefined}
            />
            {pnl != null && pnl !== 0 ? (
              <Kpi
                label="P&L"
                value={fmtUsd(pnl, { signed: true, decimals: 0 })}
                tone={pnl >= 0 ? "up" : "down"}
                delta={prev ? <Delta value={prevPnl != null ? pnl - prevPnl : null} unit="$" /> : undefined}
              />
            ) : (
              <Kpi
                label={t("psych.avgR")}
                value={fmtR(avgR)}
                tone={avgR == null ? "neutral" : avgR >= 0 ? "up" : "down"}
                delta={prev ? <Delta value={avgR != null && prevAvgR != null ? avgR - prevAvgR : null} unit="R" digits={2} /> : undefined}
              />
            )}
            <Kpi
              label={t("psych.readiness", { count: report.totalCheckins })}
              value={ready == null ? "—" : ready}
              tone={readinessTone(ready)}
              delta={prev ? <Delta value={ready != null && prevReady != null ? ready - prevReady : null} unit="" /> : undefined}
            />
          </div>

          {/* Day strip Mon–Fri */}
          {days.length > 0 && (
            <ol className="grid grid-cols-5 gap-1.5" aria-label={t("psych.daysAria")}>
              {days.map((d) => {
                const tone = readinessTone(d.readiness);
                return (
                  <li
                    key={d.date}
                    className="min-w-0 rounded-xl bg-foreground/[0.04] px-2 py-1.5 text-center"
                    title={t("psych.dayTip", { date: fmtDate(d.date, "dayMonth"), trades: tradesShort(d.count), wr: d.count ? fmtRate(d.winRate) : "—", ready: d.readiness ?? "—" })}
                  >
                    <div className="flex items-center justify-center gap-1 text-2xs text-muted-foreground">
                      <span
                        className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          d.readiness == null ? "bg-foreground/20" : tone === "up" ? "bg-up" : tone === "warn" ? "bg-[hsl(var(--chart-3))]" : "bg-down",
                        )}
                        aria-hidden="true"
                      />
                      {fmtWeekday(d.date, "short")}
                    </div>
                    <div className="text-sm font-semibold tabular-nums">{d.count || "—"}</div>
                    <div className={cn("text-2xs tabular-nums", d.count ? (d.winRate >= 0.5 ? "text-up" : "text-down") : "text-muted-foreground")}>
                      {d.count ? fmtRate(d.winRate) : t("psych.noTrades")}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              {report.bestState && <Pill tone="up">{t("psych.best", { state: stateLabel(report.bestState) })}</Pill>}
              {report.worstState && report.worstState !== report.bestState && (
                <Pill tone="down">{t("psych.worst", { state: stateLabel(report.worstState) })}</Pill>
              )}
            </div>
            {reports.length > 1 && (
              <div className="flex items-center gap-2 text-2xs text-muted-foreground">
                <span>{t("psych.wrWeeks", { weeks: commonI18n.t("units.weeks", { count: reports.length }) })}</span>
                <Sparkline values={trend.wr} width={88} height={22} domain={[0, 100]} tone="accent" connectGaps label={t("psych.wrSparkAria")} />
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => setDetails(details === "open" ? "closed" : "open")}
            aria-expanded={details === "open"}
            aria-controls="weekly-psychology-details"
            className="flex min-h-8 w-full items-center justify-between rounded-lg px-1 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex items-center gap-1.5">
              <Lightbulb className="h-3.5 w-3.5" aria-hidden="true" />
              {t("psych.detailsToggle")}
              {report.keyInsights?.length ? <span className="tabular-nums">· {report.keyInsights.length}</span> : null}
            </span>
            {details === "open" ? <ChevronUp className="h-4 w-4" aria-hidden="true" /> : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
          </button>

          {details === "open" && (
            <div id="weekly-psychology-details" className="grid gap-4 md:grid-cols-2">
              <div>
                <div className="micro-label mb-2">{t("psych.byState")}</div>
                {breakdown.length ? (
                  <ul className="space-y-1.5">
                    {breakdown.map(([state, s]) => {
                      const tone = STATE_TONE[state] ?? "neutral";
                      return (
                        <li key={state} className="grid grid-cols-[6.5rem_minmax(0,1fr)_3rem_3.5rem] items-center gap-2 text-xs">
                          <span className="truncate" title={stateLabel(state)}>{stateLabel(state)}</span>
                          <span className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.07]" aria-hidden="true">
                            <span
                              className={cn("block h-full rounded-full", s.winRate >= 0.5 ? "bg-up" : "bg-down")}
                              style={{ width: `${Math.round(s.winRate * 100)}%` }}
                            />
                          </span>
                          <span className={cn("text-right tabular-nums", tone === "down" && s.winRate < 0.5 ? "text-down" : "text-foreground")}>
                            {fmtRate(s.winRate)}
                          </span>
                          <span className="text-right tabular-nums text-muted-foreground">
                            {commonI18n.t("units.tradesShort", { count: s.count })}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">{t("psych.noStateTrades")}</p>
                )}
              </div>
              <div>
                <div className="micro-label mb-2">{t("psych.keyInsights")}</div>
                {report.keyInsights?.length ? (
                  <ul className="space-y-1.5">
                    {report.keyInsights.map((insight, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm leading-snug text-foreground/90">
                        <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                        {insight}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">{t("psych.noInsights")}</p>
                )}
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-2 text-2xs text-muted-foreground">
            <span title={fmtDate(report.generatedAt, "shortDateTime")}>{t("psych.recalculatedAgo", { ago: relTime(report.generatedAt) })}</span>
            {prev && <span>{t("psych.compareWith", { range: `${fmtDate(prev.weekStart, "dayMonth")} – ${fmtDate(prev.weekEnd, "dayMonth")}` })}</span>}
          </div>
          {error && <WidgetError message={error} />}
        </div>
      )}
      {!report && error && <WidgetError message={error} className="mt-2" />}
    </WidgetShell>
  );
}
