import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { BarChart3, FileDown, Microscope, Printer, RefreshCw, SearchX } from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { EmptyState, Page, PageHeader, Panel, Segmented, Toolbar } from "@/components/ds";
import { KpiGrid, KpiGridSkeleton } from "@/components/stats/kpi-grid";
import { EquityPanel } from "@/components/stats/equity-panel";
import { CalendarPanel } from "@/components/stats/calendar-panel";
import { TimeHeatmap } from "@/components/stats/time-heatmap";
import { BreakdownPanel, type Dimension } from "@/components/stats/breakdown-panel";
import { ExtremesPanel, InsightsPanel, buildInsights } from "@/components/stats/insights";
import { FeesPanel, HorizonPanel } from "@/components/stats/horizon-fees";
import { downloadReportCsv, openPrintReport } from "@/components/stats/export";
import { PerformanceReportPanel } from "@/components/propreports/PerformanceReportPanel";
import { ReconcilePanel } from "@/components/propreports/ReconcilePanel";
import { usePerformance } from "@/components/propreports/api";
import { useTradesBookFacets, useTradesWindow } from "@/hooks/use-trades-window";
import {
  horizonLabel, HORIZON_OPTIONS, PERIOD_OPTIONS, computeKpis, dailySeries, equitySeries, feeStats, horizonOf, inRange,
  monthlySeries, parseKey, periodRanges, preferredMetric,
  type HorizonFilter, type Metric, type PeriodKey, type Range,
} from "@/components/stats/metrics";
import { PersonSelect } from "@/components/people/person-select";
import { fmtDateCustom } from "@/lib/format";
import { comparePersonNames, personName } from "@/i18n";
import { commonI18n } from "@/i18n/ns/common";
import { statsI18n } from "@/i18n/ns/stats";

/**
 * /stats — the period "report card": headline KPIs vs the previous period, equity curve, P&L calendar,
 * weekday×session heatmap, where-I-make/lose table, best/worst trades and auto-insights.
 * Deep-dive breakdowns (conviction, emotions, patterns) live in /analytics.
 */

const PREFS_KEY = "ws.stats.prefs.v2";
type Prefs = { period: PeriodKey; metric: Metric | null; trader: string; dim: Dimension; horizon: HorizonFilter };
const DEFAULT_PREFS: Prefs = { period: "all", metric: null, trader: "all", dim: "trader", horizon: "all" };

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const p = JSON.parse(raw) as Partial<Prefs>;
    return {
      period: PERIOD_OPTIONS.some((o) => o.value === p.period) ? (p.period as PeriodKey) : DEFAULT_PREFS.period,
      metric: p.metric === "r" || p.metric === "usd" || p.metric === "net" ? p.metric : null,
      horizon: HORIZON_OPTIONS.some((o) => o.value === p.horizon) ? (p.horizon as HorizonFilter) : "all",
      trader: typeof p.trader === "string" && p.trader ? p.trader : "all",
      dim: (["trader", "setup", "sector", "ticker", "session", "conviction"] as Dimension[]).includes(p.dim as Dimension) ? (p.dim as Dimension) : "trader",
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function fmtRange(r: Range): string {
  const f = (k: string) => {
    const d = parseKey(k);
    const otherYear = d.getFullYear() !== new Date().getFullYear();
    return fmtDateCustom(d, { day: "numeric", month: "short", ...(otherYear ? { year: "numeric" } : {}) }).replace(".", "");
  };
  if (!r.from) return statsI18n.t("range.all");
  return statsI18n.t("range.span", { from: f(r.from), to: r.to ? f(r.to) : statsI18n.t("range.today") });
}

export default function Stats() {
  const { t } = statsI18n.useT();
  const { user, isCurator } = useAuth();
  const { toast } = useToast();
  const [prefs, setPrefs] = useState<Prefs>(() => {
    const p = loadPrefs();
    const urlTrader = new URLSearchParams(window.location.search).get("trader");
    return urlTrader ? { ...p, trader: urlTrader } : p;
  });
  // Server-side window (P1-5): only the selected period + the equally long previous one, only the picked trader.
  // "Всё время" still needs the whole (scoped) book.
  const ranges = useMemo(() => periodRanges(prefs.period), [prefs.period]);
  const windowTrader = prefs.trader !== "all" ? prefs.trader : null;
  const { data: allTrades = [], isLoading, isError, refetch, isFetching } = useTradesWindow({
    from: ranges.prev?.from ?? ranges.cur.from,
    trader: windowTrader,
  });
  // Scope-wide facts (trader list, totals) without loading the whole book.
  const teamFacets = useTradesBookFacets();
  const traderFacets = useTradesBookFacets({ trader: windowTrader, enabled: !!windowTrader });

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* storage unavailable — prefs just won't persist */
    }
  }, [prefs]);

  const set = <K extends keyof Prefs>(k: K, v: Prefs[K]) => setPrefs((p) => ({ ...p, [k]: v }));

  const traders = useMemo(
    () => [...new Set([...(teamFacets.data?.traders ?? []), ...allTrades.map((tr) => tr.trader ?? "")].map((x) => x.trim()).filter(Boolean))]
      .sort(comparePersonNames),
    [allTrades, teamFacets.data],
  );
  // Trades in the scope regardless of the period (for the empty states).
  const bookTotal = (windowTrader ? traderFacets.data?.total : teamFacets.data?.total) ?? null;
  const me = user?.traderName ?? null;
  const perf = usePerformance(null);
  const reportTraders = useMemo(
    () => [...new Set((perf.data?.reports ?? []).map((r) => r.traderName).filter((x): x is string => !!x))].filter((t) => !traders.includes(t)),
    [perf.data, traders],
  );
  const hasBroker = prefs.trader !== "all" && (perf.data?.reports ?? []).some((r) => r.traderName === prefs.trader);
  // A trader whose results live only in PropReports opens straight onto their broker report.
  useEffect(() => {
    if (!me || prefs.trader !== "all" || isLoading || !perf.data) return;
    const hasJournal = teamFacets.data ? teamFacets.data.traders.includes(me) : allTrades.some((tr) => (tr.trader ?? "").trim() === me);
    if (!hasJournal && perf.data.reports.some((r) => r.traderName === me)) setPrefs((p) => ({ ...p, trader: me }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, perf.data, isLoading]);

  // Trader scope (before horizon) — the horizon table compares all three horizons within it.
  const traderScoped = useMemo(
    () => (prefs.trader === "all" ? allTrades : allTrades.filter((tr) => (tr.trader ?? "").trim() === prefs.trader)),
    [allTrades, prefs.trader],
  );
  const scoped = useMemo(
    () => (prefs.horizon === "all" ? traderScoped : traderScoped.filter((tr) => horizonOf(tr) === prefs.horizon)),
    [traderScoped, prefs.horizon],
  );
  const metric: Metric = prefs.metric ?? preferredMetric(scoped);
  const trades = useMemo(() => inRange(scoped, ranges.cur), [scoped, ranges]);
  const prevTrades = useMemo(() => (ranges.prev ? inRange(scoped, ranges.prev) : null), [scoped, ranges]);

  const kpis = useMemo(() => computeKpis(trades, metric), [trades, metric]);
  const prevKpis = useMemo(() => (prevTrades ? computeKpis(prevTrades, metric) : null), [prevTrades, metric]);
  const equity = useMemo(() => equitySeries(trades, metric), [trades, metric]);
  const monthly = useMemo(() => monthlySeries(trades, metric), [trades, metric]);
  const days = useMemo(() => dailySeries(trades, metric), [trades, metric]);
  const insights = useMemo(() => buildInsights(trades, kpis, metric), [trades, kpis, metric]);
  const fees = useMemo(() => feeStats(trades), [trades]);
  const prevFees = useMemo(() => (prevTrades && prevTrades.length ? feeStats(prevTrades) : null), [prevTrades]);
  const horizonBase = useMemo(() => inRange(traderScoped, ranges.cur), [traderScoped, ranges]);

  const periodOpt = PERIOD_OPTIONS.find((o) => o.value === prefs.period)!;
  // A trader's book holds only own trades: no team picker, and the scope reads «Мои сделки».
  const solo = !isCurator && traders.length <= 1 && reportTraders.length === 0;
  const scopeLabel =
    (prefs.trader === "all" ? (solo ? t("myTrades") : t("wholeTeam")) : personName(prefs.trader)) + (prefs.horizon !== "all" ? ` · ${horizonLabel(prefs.horizon)}` : "");

  const reportMeta = () => ({
    title: t("reportTitle", { scope: scopeLabel }),
    periodLabel: t("reportPeriod", { label: periodOpt.label, range: fmtRange(ranges.cur) }),
    scopeLabel,
    metric,
    generatedAt: new Date(),
    fees,
  });

  const header = (
    <PageHeader
      title={t("title")}
      icon={BarChart3}
      description={
        <>
          {t("description")}{" "}
          <Link href="/analytics" className="text-primary underline-offset-4 hover:underline">
            {t("deepLink")}
          </Link>
        </>
      }
      actions={
        <>
          <Button variant="outline" size="sm" className="rounded-full" asChild>
            <Link href="/analytics">
              <Microscope className="mr-1.5 h-4 w-4" aria-hidden="true" /> {t("deepButton")}
            </Link>
          </Button>
          <Button
            variant="outline" size="sm" className="rounded-full" disabled={!trades.length}
            onClick={() => downloadReportCsv(trades, kpis, prevKpis, reportMeta())}
          >
            <FileDown className="mr-1.5 h-4 w-4" aria-hidden="true" /> CSV
          </Button>
          <Button
            variant="outline" size="sm" className="rounded-full" disabled={!trades.length}
            onClick={() => {
              if (!openPrintReport(trades, kpis, prevKpis, reportMeta())) {
                toast({ title: t("printBlocked"), description: t("printBlockedHint"), variant: "destructive" });
              }
            }}
          >
            <Printer className="mr-1.5 h-4 w-4" aria-hidden="true" /> {t("print")}
          </Button>
        </>
      }
    />
  );

  if (isError) {
    return (
      <Page>
        {header}
        <Panel>
          <EmptyState
            icon={SearchX}
            title={t("loadError")}
            description={t("loadErrorHint")}
            action={
              <Button variant="outline" className="rounded-full" onClick={() => void refetch()} disabled={isFetching}>
                <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden="true" /> {commonI18n.t("actions.retry")}
              </Button>
            }
          />
        </Panel>
      </Page>
    );
  }

  if (isLoading) {
    return (
      <Page>
        {header}
        <div className="glass-panel h-[52px] rounded-2xl" aria-hidden="true" />
        <KpiGridSkeleton />
        <div className="grid gap-4 xl:grid-cols-5">
          <div className="glass-panel h-[360px] animate-pulse rounded-2xl xl:col-span-3" />
          <div className="glass-panel h-[360px] animate-pulse rounded-2xl xl:col-span-2" />
        </div>
        <span className="sr-only" role="status">{t("loading")}</span>
      </Page>
    );
  }

  const prevNote = ranges.prev
    ? prevKpis && prevKpis.total > 0
      ? t("prevCompare", { range: fmtRange(ranges.prev), trades: commonI18n.t("units.trades", { count: prevKpis.total }) })
      : t("prevEmpty", { range: fmtRange(ranges.prev) })
    : t("prevNone");

  return (
    <Page>
      {header}

      <Toolbar className="justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Segmented<PeriodKey>
            ariaLabel={t("periodAria")}
            value={prefs.period}
            onChange={(v) => set("period", v)}
            options={PERIOD_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />
          <Segmented<Metric>
            ariaLabel={t("metricAria")}
            value={metric}
            onChange={(v) => set("metric", v)}
            options={[{ value: "r", label: t("metric.r") }, { value: "net", label: t("metric.net") }, { value: "usd", label: t("metric.usd") }]}
          />
          <Segmented<HorizonFilter>
            ariaLabel={t("horizonAria")}
            value={prefs.horizon}
            onChange={(v) => set("horizon", v)}
            options={HORIZON_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />
        </div>
        {!solo && <PersonSelect
          value={prefs.trader}
          onValueChange={(v) => set("trader", v)}
          allValue="all"
          allLabel={t("wholeTeam")}
          options={[
            ...(me && traders.includes(me) ? [{ value: me, label: t("myTradesOf", { name: personName(me) }) }] : []),
            ...traders.filter((t) => t !== me),
            ...reportTraders,
            ...(prefs.trader !== "all" && !traders.includes(prefs.trader) && !reportTraders.includes(prefs.trader) ? [prefs.trader] : []),
          ]}
          className="h-9 w-full sm:w-[200px]"
          ariaLabel={t("traderAria")}
        />}
      </Toolbar>

      {hasBroker && (
        <div className="space-y-4">
          <PerformanceReportPanel trader={prefs.trader} />
          <ReconcilePanel trader={prefs.trader} compact />
        </div>
      )}

      {prefs.trader === "all" && (bookTotal === 0 || (bookTotal == null && allTrades.length === 0 && prefs.period === "all")) ? (
        <Panel>
          <EmptyState
            icon={BarChart3}
            title={t("bookEmpty")}
            description={t("bookEmptyHint")}
          />
        </Panel>
      ) : trades.length === 0 && hasBroker ? null : trades.length === 0 ? (
        <Panel>
          <EmptyState
            icon={SearchX}
            title={`${prefs.trader !== "all" ? t("noTradesTitleOf", { period: periodOpt.long, trader: personName(prefs.trader) }) : t("noTradesTitle", { period: periodOpt.long })}${prefs.horizon !== "all" ? ` · ${horizonLabel(prefs.horizon)}` : ""}`}
            description={[
              bookTotal != null
                ? prefs.trader !== "all"
                  ? t("inJournalOf", { trader: personName(prefs.trader), trades: commonI18n.t("units.trades", { count: bookTotal }) })
                  : t("inJournal", { trades: commonI18n.t("units.trades", { count: bookTotal }) })
                : "",
              prefs.trader !== "all" || prefs.horizon !== "all" ? t("pickLongerOrClear") : t("pickLonger"),
            ].filter(Boolean).join(" ")}
            action={
              <div className="flex flex-wrap justify-center gap-2">
                {prefs.period !== "all" && (
                  <Button className="rounded-full" onClick={() => set("period", "all")}>{t("showAll")}</Button>
                )}
                {prefs.trader !== "all" && (
                  <Button variant="outline" className="rounded-full" onClick={() => set("trader", "all")}>{t("wholeTeam")}</Button>
                )}
                {prefs.horizon !== "all" && (
                  <Button variant="outline" className="rounded-full" onClick={() => set("horizon", "all")}>{t("allHorizons")}</Button>

                )}
              </div>
            }
          />
        </Panel>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-2 px-1">
            <h2 className="text-sm font-semibold text-foreground">
              {scopeLabel} · {fmtRange(ranges.cur)}
              <span className="ml-2 font-normal text-muted-foreground">{commonI18n.t("units.trades", { count: trades.length })}</span>
            </h2>
            <p className="text-xs text-muted-foreground">{prevNote}</p>
          </div>

          <KpiGrid k={kpis} prev={prevKpis} metric={metric} />

          <div className="grid gap-4 xl:grid-cols-5">
            <div className="min-w-0 xl:col-span-3"><EquityPanel equity={equity} monthly={monthly} metric={metric} trades={trades} trader={prefs.trader} /></div>
            <div className="min-w-0 xl:col-span-2"><InsightsPanel insights={insights} /></div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <HorizonPanel trades={horizonBase} metric={metric} active={prefs.horizon} onPick={(h) => set("horizon", h)} />
            <FeesPanel fees={fees} prev={prevFees} trades={trades} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <CalendarPanel days={days} metric={metric} trader={prefs.trader} />
            <TimeHeatmap trades={trades} metric={metric} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <BreakdownPanel
              trades={trades}
              metric={metric}
              dimension={prefs.dim}
              onDimension={(d) => set("dim", d)}
              onPickTrader={prefs.trader === "all" ? (name) => set("trader", name) : undefined}
              hideTrader={solo}
            />
            <ExtremesPanel trades={trades} metric={metric} />
          </div>
        </>
      )}
    </Page>
  );
}
