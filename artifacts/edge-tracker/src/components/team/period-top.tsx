/**
 * «Топ» → «Период» (staff only): the desk leaderboard for a week / month / quarter / all time — KPIs vs the previous
 * period, podium, desk rating, most improved, best setups, trades to review, best trades, CSV. Rendered by
 * pages/top-results.tsx next to the day view (components/top-day). Moved here from the page unchanged.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { type Trade } from "@workspace/api-client-react";
import { useTradesWindow } from "@/hooks/use-trades-window";
import { ChevronLeft, ChevronRight, Download, Sparkles, Target, TrendingUp, Trophy, TriangleAlert } from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { QueryError } from "@/components/query-error";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, Page, PageHeader, Panel, Pill, Segmented, StatCard, StatGrid, Toolbar, toneOf, toneText, type SegmentOption } from "@/components/ds";
import { http } from "@/lib/api/http";
import { links } from "@/lib/links";
import { KPI_FORMULAS, closeDate } from "@/lib/trade-math";
import { cn } from "@/lib/utils";
import {
  METRIC_LABEL,
  periodRange,
  rollupSetups,
  shiftAnchor,
  teamKpis,
  todayNy,
  tradeValue,
  tradesInRange,
  type DeskLeaderboard,
  type Metric,
  type Period,
  type TraderRow,
} from "./leaderboard";
import { LeaderboardList, Podium, ScoreRing, fmtMetric } from "./leaderboard-view";
import { BestTradeCard, TradeDetailSheet } from "./trade-cards";
import { TraderAvatar } from "./trader-avatar";
import { downloadCsv, isTypingTarget, lsGet, lsSet } from "./utils";
import { fmtNum, fmtR, fmtRate, fmtUsd } from "@/lib/format";
import { ratingsI18n } from "@/i18n/ns/ratings";
import { commonI18n } from "@/i18n/ns/common";
import { personName } from "@/i18n";

const VIEW_KEY = "ws_top_results_view_v2";
type SavedView = { period: Period; metric: Metric; minTrades: number };
type Side = "all" | "plus" | "minus";

const PERIODS: Period[] = ["week", "month", "quarter", "all"];
const METRICS: Metric[] = ["score", "net", "r", "expectancy", "pf", "consistency", "drawdown", "winrate"];
/** Period options and «vs previous» labels are built at render time (current UI language). */
const periodOptions = (): SegmentOption<Period>[] => PERIODS.map((value) => ({ value, label: ratingsI18n.t(`top.periods.${value}`) }));
const prevLabel = (p: Period): string => (p === "all" ? "" : ratingsI18n.t(`top.prev.${p}`));

async function fetchDesk(params: URLSearchParams): Promise<DeskLeaderboard> {
  return http.get<DeskLeaderboard>(`/api/leaderboard?${params.toString()}`);
}

function deltaNode(cur: number | null, prev: number | null, fmt: (n: number) => string) {
  if (cur == null || prev == null) return undefined;
  const d = cur - prev;
  if (Math.abs(d) < 1e-9) return undefined;
  return fmt(d);
}

/** CSV of the desk rating (the shown period, every row). */
function exportDeskCsv(desk: DeskLeaderboard, rows: TraderRow[]): void {
  const t = ratingsI18n.t;
  const tc = commonI18n.t;
  downloadCsv(`top-results_${desk.period.from}_${desk.period.to}.csv`, [
    [t("top.csv.place"), t("top.csv.trader"), t("top.csv.qualified"), "Desk score", t("top.csv.closed"), t("top.csv.wins"), t("top.csv.losses"), "Win rate", t("top.csv.net"), t("top.csv.gross"), t("top.csv.fees"), t("top.csv.totalR"), t("top.csv.expR"), "Profit factor", t("top.csv.greenDays"), t("top.csv.tradingDays"), t("top.csv.maxDdNet"), t("top.csv.maxDdR"), t("top.csv.violations"), t("top.csv.mentorRating"), "Δ score"],
    ...rows.map((r) => [
      r.rank ?? "",
      personName(r.trader),
      r.qualified ? tc("yes") : tc("no"),
      r.score != null ? r.score.toFixed(1) : "",
      r.closed,
      r.wins,
      r.losses,
      r.winRate != null ? Math.round(r.winRate * 100) + "%" : "",
      r.net != null ? r.net.toFixed(2) : "",
      r.gross != null ? r.gross.toFixed(2) : "",
      r.fees != null ? r.fees.toFixed(2) : "",
      r.totalR != null ? r.totalR.toFixed(2) : "",
      r.expectancyR != null ? r.expectancyR.toFixed(2) : "",
      r.profitFactorR != null ? r.profitFactorR.toFixed(2) : "",
      r.greenDays,
      r.tradingDays,
      r.maxDrawdownNet != null ? r.maxDrawdownNet.toFixed(2) : "",
      r.maxDrawdownR.toFixed(2),
      r.violations,
      r.rating ? r.rating.avg.toFixed(1) : "",
      r.deltaScore != null ? r.deltaScore.toFixed(1) : "",
    ]),
  ]);
}

/** The staff period leaderboard (desk score, podium, best trades, setups, trades to review). `tabs` sit under the title. */
export function PeriodTop({ tabs }: { tabs: ReactNode }) {
  const { isCurator } = useAuth();
  const { t } = ratingsI18n.useT();
  const saved = useMemo(() => lsGet<Partial<SavedView>>(VIEW_KEY, {}), []);
  const [period, setPeriod] = useState<Period>(PERIODS.includes(saved.period as Period) ? (saved.period as Period) : "week");
  const [metric, setMetric] = useState<Metric>(METRICS.includes(saved.metric as Metric) ? (saved.metric as Metric) : "score");
  const [minTrades, setMinTrades] = useState<number>(Number.isFinite(saved.minTrades) && (saved.minTrades as number) >= 1 ? (saved.minTrades as number) : 5);
  const [anchor, setAnchor] = useState<string>(todayNy());
  const [side, setSide] = useState<Side>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [openTrade, setOpenTrade] = useState<Trade | null>(null);

  useEffect(() => lsSet(VIEW_KEY, { period, metric, minTrades }), [period, metric, minTrades]);

  const range = useMemo(() => periodRange(anchor, period), [anchor, period]);
  const params = useMemo(() => {
    const p = new URLSearchParams({ format: "desk", metric, minTrades: String(minTrades) });
    if (range.from && range.to) {
      p.set("from", range.from);
      p.set("to", range.to);
    } else p.set("period", "all");
    return p;
  }, [range, metric, minTrades]);

  const deskQ = useQuery({
    queryKey: ["/api/leaderboard", Object.fromEntries(params)],
    queryFn: () => fetchDesk(params),
    enabled: isCurator,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
  const desk = deskQ.data;
  const rows: TraderRow[] = useMemo(() => desk?.rows ?? [], [desk]);

  // Trade-level cards (best / to review / setups) come from the trade list with the shared FE math.
  // P1-5: only the trades of the shown period (server-side window), not the whole book.
  const tradesQ = useTradesWindow({ from: range.from, to: range.to }, { enabled: isCurator, staleTime: 60_000 });
  const trades = useMemo(() => tradesInRange(tradesQ.data ?? [], range), [tradesQ.data, range]);
  const setups = useMemo(() => rollupSetups(trades).slice(0, 6), [trades]);
  const prefer: "net" | "r" = metric === "r" || metric === "expectancy" ? "r" : "net";
  const bestTrades = useMemo(
    () => trades.filter((t) => (tradeValue(t, prefer) ?? 0) > 0).sort((a, b) => (tradeValue(b, prefer) ?? 0) - (tradeValue(a, prefer) ?? 0)).slice(0, 8),
    [trades, prefer],
  );
  const reviewTrades = useMemo(
    () =>
      trades
        .filter((t) => (tradeValue(t, prefer) ?? 0) < 0 || (t.result ?? "").toLowerCase() === "loss")
        .sort((a, b) => (tradeValue(a, prefer) ?? 0) - (tradeValue(b, prefer) ?? 0))
        .slice(0, 6),
    [trades, prefer],
  );

  const kpi = useMemo(() => teamKpis(rows), [rows]);
  const prevKpi = useMemo(() => {
    const prev = rows.map((r) => r.prev).filter((p): p is NonNullable<TraderRow["prev"]> => !!p);
    if (!prev.length) return null;
    const hasNet = prev.some((p) => p.net != null);
    return {
      net: hasNet ? prev.reduce((s, p) => s + (p.net ?? 0), 0) : null,
      totalR: prev.some((p) => p.totalR != null) ? prev.reduce((s, p) => s + (p.totalR ?? 0), 0) : null,
      closed: prev.reduce((s, p) => s + p.closed, 0),
    };
  }, [rows]);

  const listRows = useMemo(
    () => (side === "plus" ? rows.filter((r) => (r.net ?? r.totalR ?? 0) > 0) : side === "minus" ? rows.filter((r) => (r.net ?? r.totalR ?? 0) < 0) : rows),
    [rows, side],
  );
  const mostImproved = desk?.mostImproved ? rows.find((r) => r.trader === desk.mostImproved?.trader) ?? null : null;

  const shift = useCallback((dir: -1 | 1) => setAnchor((a) => shiftAnchor(a, period, dir)), [period]);
  const canGoNext = period !== "all" && !!range.to && range.to < todayNy();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isTypingTarget(e) || e.metaKey || e.ctrlKey || e.altKey || openTrade) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); shift(-1); }
      else if (e.key === "ArrowRight" && canGoNext) { e.preventDefault(); shift(1); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shift, canGoNext, openTrade]);

  const toggle = useCallback((trader: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(trader)) next.delete(trader);
      else next.add(trader);
      return next;
    });
  }, []);

  const selectTrader = useCallback((trader: string) => {
    setSide("all");
    setExpanded((prev) => new Set(prev).add(trader));
    requestAnimationFrame(() => {
      document.getElementById(`lb-${encodeURIComponent(trader)}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, []);

  const exportCsv = () => { if (desk) exportDeskCsv(desk, rows); };

  const isLoading = deskQ.isLoading && !desk;
  const noData = !!desk && rows.length === 0;

  return (
    <Page>
      <PageHeader
        title={t("top.title")}
        icon={Trophy}
        description={t("top.description")}
        actions={
          <>
            <label className="sr-only" htmlFor="tr-metric">{t("top.metricAria")}</label>
            <Select value={metric} onValueChange={(v) => setMetric(v as Metric)}>
              <SelectTrigger id="tr-metric" className="h-9 w-[170px] text-sm" aria-label={t("top.metricAria")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {METRICS.map((m) => (
                  <SelectItem key={m} value={m}>{METRIC_LABEL[m]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!rows.length}>
              <Download /> CSV
            </Button>
          </>
        }
      >
        {tabs}
      </PageHeader>

      <Toolbar className="gap-y-3">
        <Segmented<Period> ariaLabel={t("top.periodAria")} options={periodOptions()} value={period} onChange={setPeriod} size="sm" />
        {period !== "all" && (
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-9 w-9" aria-label={t("top.prevPeriod")} onClick={() => shift(-1)}>
              <ChevronLeft />
            </Button>
            <span className="min-w-0 px-1 text-sm font-medium tabular-nums" aria-live="polite">
              {range.label}
            </span>
            <Button variant="ghost" size="icon" className="h-9 w-9" aria-label={t("top.nextPeriod")} onClick={() => shift(1)} disabled={!canGoNext}>
              <ChevronRight />
            </Button>
          </div>
        )}
        {period !== "all" && (
          <>
            <label className="sr-only" htmlFor="tr-date">{t("top.date")}</label>
            <Input id="tr-date" type="date" value={anchor} max={todayNy()} onChange={(e) => e.target.value && setAnchor(e.target.value)} className="h-9 w-[150px] text-sm" />
          </>
        )}
        <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <span>{t("top.minTrades")}</span>
          <Input
            type="number"
            min={1}
            max={100}
            value={minTrades}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 1) setMinTrades(Math.min(100, Math.round(n)));
            }}
            className="h-9 w-[72px] text-sm tabular-nums"
            aria-label={t("top.minTradesAria")}
          />
        </label>
      </Toolbar>

      {deskQ.isError && <QueryError error={deskQ.error} onRetry={() => deskQ.refetch()} />}

      {isLoading ? (
        <LoadingSkeleton />
      ) : noData ? (
        <Panel>
          <EmptyState
            icon={Trophy}
            title={t("top.emptyTitle")}
            description={t("top.emptyDescription")}
            action={period !== "all" ? <Button onClick={() => setPeriod("all")}>{t("top.showAll")}</Button> : undefined}
          />
        </Panel>
      ) : (
        <>
          <PeriodKpis kpi={kpi} prevKpi={prevKpi} period={period} minTrades={minTrades} />

          {rows.some((r) => r.qualified) ? (
            <Podium rows={rows} metric={metric} onSelect={selectTrader} />
          ) : (
            <div className="glass-panel flex flex-wrap items-center gap-3 rounded-2xl px-4 py-3 text-sm">
              <TriangleAlert className="h-4 w-4 text-[hsl(var(--chart-3))]" aria-hidden="true" />
              <span className="flex-1 text-muted-foreground">{t("top.noneQualified", { count: minTrades })}</span>
              <Button variant="outline" size="sm" onClick={() => setMinTrades(1)}>{t("top.lowerThreshold")}</Button>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] lg:gap-5">
            <Panel
              title={t("top.deskRating")}
              description={t("top.deskRatingDescription", { metric: METRIC_LABEL[metric] })}
              actions={
                <Segmented<Side>
                  ariaLabel={t("top.filterAria")}
                  size="sm"
                  value={side}
                  onChange={setSide}
                  options={[
                    { value: "all", label: commonI18n.t("states.all"), count: rows.length },
                    { value: "plus", label: t("top.plus"), count: kpi.plus },
                    { value: "minus", label: t("top.minus"), count: kpi.minus },
                  ]}
                />
              }
              bodyClassName="px-2 sm:px-3"
            >
              {listRows.length && desk ? (
                <LeaderboardList rows={listRows} metric={metric} weights={desk.weights} expanded={expanded} onToggle={toggle} from={desk.period.from} to={desk.period.to} />
              ) : (
                <EmptyState title={side === "plus" ? t("top.nobodyPlus") : t("top.nobodyMinus")} description={t("top.netNote")} className="py-8" />
              )}
            </Panel>

            <div className="flex min-w-0 flex-col gap-4 lg:gap-5">
              {mostImproved && mostImproved.deltaScore != null && mostImproved.deltaScore > 0 && (
                <MostImprovedPanel row={mostImproved} period={period} onSelect={selectTrader} />
              )}
              <Panel title={t("top.bestSetups")} icon={Target} description={t("top.bestSetupsDescription")}>
                <SetupBars setups={setups} />
              </Panel>
              <ReviewPanel trades={reviewTrades} prefer={prefer} onOpen={setOpenTrade} />
            </div>
          </div>

          <BestTradesPanel trades={bestTrades} prefer={prefer} loading={tradesQ.isLoading && !tradesQ.data} onOpen={setOpenTrade} />

          <p className="hidden text-center text-xs text-muted-foreground sm:block">
            <kbd className="chip px-1.5 py-0.5 text-2xs">←</kbd> <kbd className="chip px-1.5 py-0.5 text-2xs">→</kbd> {t("top.switchPeriod")}
          </p>
        </>
      )}

      <TradeDetailSheet trade={openTrade} onClose={() => setOpenTrade(null)} />
    </Page>
  );
}

type Kpi = ReturnType<typeof teamKpis>;
type PrevKpi = { net: number | null; totalR: number | null; closed: number } | null;

function PeriodKpis({ kpi, prevKpi, period, minTrades }: { kpi: Kpi; prevKpi: PrevKpi; period: Period; minTrades: number }) {
  const { t } = ratingsI18n.useT();
  const unqualified = kpi.traders - kpi.qualified;
  return (
    <StatGrid className="xl:grid-cols-5">
      <StatCard
        label={<span title={KPI_FORMULAS.netPnl}>{t("top.deskPnl")}</span>}
        value={kpi.net != null ? fmtUsd(kpi.net, { signed: true }) : fmtR(kpi.totalR)}
        tone={toneOf(kpi.net ?? kpi.totalR)}
        delta={prevKpi ? deltaNode(kpi.net, prevKpi.net, (n) => fmtUsd(n, { signed: true })) : undefined}
        deltaTone={prevKpi ? toneOf((kpi.net ?? 0) - (prevKpi.net ?? 0)) : undefined}
        hint={kpi.net != null
          ? `${kpi.totalR != null ? t("top.totalRSum", { r: fmtR(kpi.totalR) }) : t("top.rUnknown")}${prevKpi && prevLabel(period) ? ` · ${prevLabel(period)}` : ""}`
          : t("top.pnlMissing")}
      />
      <StatCard
        label={<span title={KPI_FORMULAS.expectancyR}>{t("top.expectancy")}</span>}
        value={fmtR(kpi.expectancyR)}
        tone={toneOf(kpi.expectancyR)}
        hint={t("top.overClosed", { count: kpi.closed })}
      />
      <StatCard
        label={<span title={KPI_FORMULAS.winRate}>{t("top.deskWinRate")}</span>}
        value={fmtRate(kpi.winRate)}
        hint={`${kpi.wins} W / ${kpi.losses} L`}
      />
      <StatCard
        label={t("top.closed")}
        value={kpi.closed}
        delta={prevKpi ? deltaNode(kpi.closed, prevKpi.closed, (d) => `${d > 0 ? "+" : "−"}${Math.abs(d)}`) : undefined}
        deltaTone="neutral"
        hint={prevKpi && prevLabel(period) ? prevLabel(period) : undefined}
      />
      <StatCard
        label={t("top.qualified")}
        value={t("top.qualifiedValue", { qualified: kpi.qualified, total: kpi.traders })}
        hint={`${t("top.qualifiedHint", { plus: kpi.plus, minus: kpi.minus })}${unqualified ? ` · ${t("top.unqualifiedHint", { count: unqualified, min: minTrades })}` : ""}`}
        className="col-span-2 md:col-span-1"
      />
    </StatGrid>
  );
}

function MostImprovedPanel({ row: mostImproved, period, onSelect: selectTrader }: { row: TraderRow; period: Period; onSelect: (trader: string) => void }) {
  const { t } = ratingsI18n.useT();
  return (
    <Panel title={t("top.mostImproved")} icon={TrendingUp} description={prevLabel(period) || t("top.toPrev")}>
      <button
        type="button"
        onClick={() => selectTrader(mostImproved.trader)}
        className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <TraderAvatar name={mostImproved.trader} size="md" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold" title={personName(mostImproved.trader)}>{personName(mostImproved.trader)}</span>
          <span className="block text-xs text-muted-foreground tabular-nums">
            score {mostImproved.prevScore != null ? Math.round(mostImproved.prevScore) : "—"} → {mostImproved.score != null ? Math.round(mostImproved.score) : "—"} · {fmtMetric(mostImproved.net ?? mostImproved.totalR, mostImproved.net != null ? "net" : "r")}
          </span>
        </span>
        <Pill tone="up">{fmtNum(mostImproved.deltaScore, { decimals: 1, signed: true })}</Pill>
        <ScoreRing score={mostImproved.score} size={40} />
      </button>
    </Panel>
  );
}

function ReviewPanel({ trades: reviewTrades, prefer, onOpen: setOpenTrade }: { trades: Trade[]; prefer: "net" | "r"; onOpen: (t: Trade) => void }) {
  const { t } = ratingsI18n.useT();
  return (
    <Panel
      title={t("top.toReview")}
      icon={TriangleAlert}
      description={t("top.toReviewDescription")}
      actions={reviewTrades.length ? <Pill tone="down">{reviewTrades.length}</Pill> : undefined}
    >
      {reviewTrades.length ? (
        <ul className="flex flex-col gap-1">
          {reviewTrades.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => setOpenTrade(t)}
                className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="h-8 w-1 shrink-0 rounded-full bg-down/70" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{t.ticker}</span>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <TraderAvatar name={t.trader} size="xs" />
                    <span className="truncate" title={`${t.trader ? personName(t.trader) : "—"} · ${closeDate(t) ?? t.date}`}>{t.trader ? personName(t.trader) : "—"} · {closeDate(t) ?? t.date}</span>
                  </span>
                </span>
                <span className={cn("text-sm font-semibold tabular-nums", toneText(toneOf(tradeValue(t, prefer))))}>
                  {fmtMetric(tradeValue(t, prefer), prefer)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon={Sparkles} title={t("top.noLosers")} description={t("top.noLosersDescription")} className="py-6" />
      )}
    </Panel>
  );
}

function BestTradesPanel({ trades: bestTrades, prefer, loading, onOpen: setOpenTrade }: { trades: Trade[]; prefer: "net" | "r"; loading: boolean; onOpen: (t: Trade) => void }) {
  const { t } = ratingsI18n.useT();
  return (
    <Panel
      title={t("top.bestTrades")}
      icon={Sparkles}
      description={prefer === "net" ? t("top.bestTradesNet") : t("top.bestTradesR")}
      actions={bestTrades.length ? <Pill tone="up">{bestTrades.length}</Pill> : undefined}
    >
      {loading ? (
        <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-56 rounded-2xl" />)}
        </div>
      ) : bestTrades.length ? (
        <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {bestTrades.map((t, i) => (
            <BestTradeCard key={t.id} trade={t} rank={i + 1} onOpen={setOpenTrade} />
          ))}
        </div>
      ) : (
        <EmptyState title={t("top.noWinners")} description={t("top.noWinnersDescription")} className="py-8" />
      )}
    </Panel>
  );
}

function SetupBars({ setups }: { setups: ReturnType<typeof rollupSetups> }) {
  const { t } = ratingsI18n.useT();
  if (!setups.length) return <p className="text-sm text-muted-foreground">{t("top.noSetups")}</p>;
  const maxAbs = Math.max(1e-9, ...setups.map((s) => Math.abs(s.r)));
  return (
    <ul className="flex flex-col gap-3">
      {setups.map((s) => (
        <li key={s.setup} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <Link href={links.playbookSearch(s.setup)} className="min-w-0 truncate hover:underline" title={t("top.findInPlaybook", { setup: s.setup })}>
              {s.setup}
            </Link>
            <span className={cn("shrink-0 font-semibold tabular-nums", toneText(toneOf(s.r)))}>
              {fmtR(s.r)}
              {s.net != null && <span className="ml-1.5 text-xs font-normal text-muted-foreground">{t("top.netSuffix", { value: fmtUsd(s.net, { signed: true }) })}</span>}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-[var(--glass-bg)]" aria-hidden="true">
            <div className={cn("h-full rounded-full", s.r >= 0 ? "bg-up/70" : "bg-down/70")} style={{ width: `${Math.max(4, (Math.abs(s.r) / maxAbs) * 100)}%` }} />
          </div>
          <span className="text-xs text-muted-foreground tabular-nums" title={KPI_FORMULAS.winRate}>
            {t("top.setupMeta", { count: s.count, wr: fmtRate(s.winRate) })}
          </span>
        </li>
      ))}
    </ul>
  );
}

function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label={ratingsI18n.t("top.loading")}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-[92px] rounded-2xl" />)}
      </div>
      <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-3">
        <Skeleton className="h-52 rounded-2xl sm:mt-4" />
        <Skeleton className="h-60 rounded-2xl" />
        <Skeleton className="h-48 rounded-2xl sm:mt-6" />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Skeleton className="h-72 rounded-2xl" />
        <Skeleton className="h-72 rounded-2xl" />
      </div>
    </div>
  );
}
