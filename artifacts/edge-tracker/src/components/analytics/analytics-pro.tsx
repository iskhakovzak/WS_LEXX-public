import { useCallback, useMemo, useState } from "react";
import { useLocation } from "wouter";
import type { Trade } from "@workspace/api-client-react";
import { Filter, Info, RotateCcw } from "lucide-react";
import { TRADE_TAGS } from "@/lib/tags";
import { Button } from "@/components/ui/button";
import { EmptyState, Segmented } from "@/components/ds";
import {
  type Filters, type FilterKey, type TimeBucket, type Metric, EMPTY_FILTERS,
  TIME_BUCKETS, dayOfWeekOptions, monthOptions,
  applyFilters, groupByDay, buildWeeklySummaries, computeOhlc,
  computeClosureStats, buildOhlcCandles, computeEdgeStats, computePeriodExtremes,
  valueFnFor, autoMetric, rOf, yearOf, tagsOf, ymd,
} from "@/lib/analytics-pro";
import { FilterBar, FILTER_GROUPS, activeFilterCount, type FilterOption } from "./pro-filters";
import { ProCalendar, type CalendarFocus } from "./pro-calendar";
import { EquityPanel } from "./pro-equity";
import { BreakdownPanel } from "./pro-breakdown";
import { ExtremesPanel, KpiGrid, TradingDaysInfo, WeeksPanel, type JumpKind } from "./pro-stats";
import { loadPref, savePref } from "./pro-format";
import { analyticsProI18n } from "@/i18n/ns/analyticsPro";
import { comparePersonNames, personName } from "@/i18n";

type Props = { trades: Trade[] };

const tp = analyticsProI18n.t;

const SCHEMA_TAGS = new Set<string>(
  Object.values(TRADE_TAGS).flatMap((c) => c.groups.flatMap((g) => g.tags))
);

/* ── Filters ⇄ URL query (shareable links; keys unchanged for old links) ── */

const QKEY: Record<FilterKey, string> = {
  accounts: "acc", symbols: "sym", years: "y", months: "m",
  daysOfWeek: "d", timeBuckets: "t", strategies: "s", types: "ty",
  globalTags: "gt", personalTags: "pt",
};

function parseFiltersFromQuery(qs: string): Filters {
  const out: Filters = {
    accounts: [], symbols: [], years: [], months: [], daysOfWeek: [],
    timeBuckets: [], strategies: [], types: [], globalTags: [], personalTags: [],
  };
  if (!qs) return out;
  const sp = new URLSearchParams(qs);
  (Object.keys(QKEY) as FilterKey[]).forEach((k) => {
    const v = sp.get(QKEY[k])?.split(",").filter(Boolean) ?? [];
    if (k === "timeBuckets") out.timeBuckets = v as TimeBucket[];
    else (out[k] as string[]) = v;
  });
  return out;
}

function filtersToQuery(f: Filters): string {
  const sp = new URLSearchParams();
  (Object.keys(QKEY) as FilterKey[]).forEach((k) => {
    const v = f[k] as string[];
    if (v.length) sp.set(QKEY[k], v.join(","));
  });
  const s = sp.toString();
  return s ? `?${s}` : "";
}

function useUrlFilters(): [Filters, (next: Filters) => void] {
  const [location, navigate] = useLocation();
  const [filters, setFilters] = useState<Filters>(() => {
    if (typeof window === "undefined") return EMPTY_FILTERS;
    return parseFiltersFromQuery(window.location.search.replace(/^\?/, ""));
  });
  const update = (next: Filters) => {
    setFilters(next);
    const qs = filtersToQuery(next);
    const newUrl = location.split("?")[0] + qs;
    if (newUrl !== location) navigate(newUrl, { replace: true });
    if (typeof window !== "undefined") {
      window.history.replaceState({}, "", window.location.pathname + qs);
    }
  };
  return [filters, update];
}

function uniqSorted(values: Iterable<string>): FilterOption[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, "ru")).map((v) => ({ id: v, label: v }));
}

function buildOptions(trades: Trade[], key: FilterKey): FilterOption[] {
  switch (key) {
    case "accounts": return [...new Set(trades.map((t) => t.trader ?? "—"))].sort(comparePersonNames).map((v) => ({ id: v, label: personName(v) }));
    case "symbols": return uniqSorted(trades.map((t) => t.ticker ?? "—"));
    case "years": return uniqSorted(trades.map(yearOf).filter((v) => v !== "—"));
    case "months": return monthOptions();
    case "daysOfWeek": return dayOfWeekOptions();
    case "timeBuckets": return TIME_BUCKETS.map((b) => ({ id: b.id, label: b.label }));
    case "strategies": return uniqSorted(trades.map((t) => t.setup ?? "—"));
    case "types": return uniqSorted(trades.map((t) => t.side ?? "—"));
    case "globalTags": return uniqSorted(trades.flatMap(tagsOf).filter((tag) => SCHEMA_TAGS.has(tag)));
    case "personalTags": return uniqSorted(trades.flatMap(tagsOf).filter((tag) => !SCHEMA_TAGS.has(tag)));
  }
}

const METRIC_KEY = "analyticsPro.metric";
const METRICS = ["pnl", "r"] as const;

function focusFor(date: string | null): CalendarFocus {
  const d = date ?? ymd(new Date());
  return { view: "month", year: Number(d.slice(0, 4)), month: Number(d.slice(5, 7)) - 1, day: null };
}

export default function AnalyticsPro({ trades }: Props) {
  const [filters, setFilters] = useUrlFilters();
  const [userMetric, setUserMetric] = useState<Metric | null>(() => loadPref(METRIC_KEY, METRICS));
  const metric: Metric = userMetric ?? autoMetric(trades);
  const setMetric = (m: Metric) => { setUserMetric(m); savePref(METRIC_KEY, m); };
  const val = useMemo(() => valueFnFor(metric), [metric]);

  const filtered = useMemo(() => applyFilters(trades, filters), [trades, filters]);
  const days = useMemo(() => groupByDay(filtered, val), [filtered, val]);
  const weekly = useMemo(() => buildWeeklySummaries(days), [days]);
  const ohlc = useMemo(() => computeOhlc(filtered, days, val), [filtered, days, val]);
  const closure = useMemo(() => computeClosureStats(filtered, val), [filtered, val]);
  const candles = useMemo(() => buildOhlcCandles(filtered, val), [filtered, val]);
  const edge = useMemo(() => computeEdgeStats(filtered, days, val), [filtered, days, val]);
  const extremes = useMemo(() => computePeriodExtremes(days), [days]);

  const totalNetGained = useMemo(() => days.filter((d) => d.net > 0).reduce((s, d) => s + d.net, 0), [days]);
  const totalNetLost = useMemo(() => days.filter((d) => d.net < 0).reduce((s, d) => s + d.net, 0), [days]);

  const options = useMemo(
    () => Object.fromEntries(FILTER_GROUPS.map((g) => [g.key, buildOptions(trades, g.key)])) as Record<FilterKey, FilterOption[]>,
    [trades],
  );

  // Calendar opens on the month of the latest trade in the selection (not an empty "today").
  const [focus, setFocus] = useState<CalendarFocus>(() => {
    const dates = trades.map((t) => (t.date ?? "").slice(0, 10)).filter(Boolean).sort();
    return focusFor(dates.length ? dates[dates.length - 1] : null);
  });

  const jump = useCallback((kind: JumpKind, key: string) => {
    if (kind === "month") setFocus({ view: "month", year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)) - 1, day: null });
    else setFocus({ ...focusFor(key), day: kind === "day" ? key : null });
    if (typeof document !== "undefined") {
      document.getElementById("pro-calendar")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  const filterCount = activeFilterCount(filters);
  const hasROnly = metric === "pnl" && edge.count === 0 && filtered.some((t) => rOf(t) != null);

  if (trades.length === 0) {
    return (
      <div className="glass-panel rounded-2xl">
        <EmptyState
          icon={Filter}
          title={tp("page.emptyTitle")}
          description={tp("page.emptyHint")}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      {/* Controls: metric + filters */}
      <section aria-label={tp("page.paramsAria")} className="glass-panel flex flex-col gap-3 rounded-2xl p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm tabular-nums text-muted-foreground">
            {tp("page.summary", { shown: filtered.length, total: tp("page.trades", { count: trades.length }), days: tp("page.tradingDays", { count: days.length }) })}
            {filterCount > 0 && <> · {tp("page.filters", { count: filterCount })}</>}
          </p>
          <Segmented
            size="sm"
            ariaLabel={tp("page.unitAria")}
            value={metric}
            onChange={setMetric}
            options={[{ value: "pnl", label: "P&L, $" }, { value: "r", label: tp("page.rMultiple") }]}
          />
        </div>
        <FilterBar filters={filters} onChange={setFilters} options={options} allTrades={trades} metric={metric} val={val} />
      </section>

      {filtered.length === 0 ? (
        <div className="glass-panel rounded-2xl">
          <EmptyState
            icon={Filter}
            title={tp("page.noMatch")}
            description={tp("page.noMatchHint")}
            action={
              <Button variant="outline" onClick={() => setFilters(EMPTY_FILTERS)}>
                <RotateCcw aria-hidden="true" />
                {tp("page.resetFilters")}
              </Button>
            }
          />
        </div>
      ) : (
        <>
          {hasROnly && (
            <div role="status" className="flex flex-wrap items-center gap-3 rounded-2xl border border-primary/30 bg-primary/10 px-4 py-3 text-sm">
              <Info className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              <span className="min-w-0 flex-1">{tp("page.noPnl")}</span>
              <Button size="sm" variant="outline" onClick={() => setMetric("r")}>{tp("page.useR")}</Button>

            </div>
          )}

          <KpiGrid edge={edge} ohlc={ohlc} metric={metric} totalTrades={filtered.length} />

          <div id="pro-calendar" className="scroll-mt-4">
            <ProCalendar days={days} trades={filtered} metric={metric} val={val} focus={focus} onFocus={setFocus} />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-3">
            <div className="min-w-0 lg:col-span-2">
              <EquityPanel candles={candles} metric={metric} />
            </div>
            <WeeksPanel weeks={weekly} metric={metric} />
          </div>

          <ExtremesPanel ext={extremes} metric={metric} onJump={jump} />

          <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-2">
            <BreakdownPanel trades={filtered} metric={metric} val={val} />
            <TradingDaysInfo
              ohlc={ohlc}
              closure={closure}
              edge={edge}
              metric={metric}
              totalNetGained={totalNetGained}
              totalNetLost={totalNetLost}
            />
          </div>
        </>
      )}
    </div>
  );
}
