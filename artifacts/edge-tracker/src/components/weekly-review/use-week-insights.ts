/**
 * Composes the weekly document with the analytics engines into ready-to-render insights
 * (tips, «что получилось», curator checklist inputs, desk comparison). Pure builders live in
 * @/lib/weeklyInsights; the fetches in ./insights-api.
 */
import * as React from "react";
import {
  buildChecklist, buildPositives, buildTips, disciplineOf, feeShareOf, type CheckItem, type Positive, type Tip,
} from "@/lib/weeklyInsights";
import type { WeeklyReview } from "./api";
import {
  SIM_WEEKS, useSimSuggestions, useWeekBehavior, useWeekBenchmark, useWeekDayReports, useWeekFees,
  type BenchRow, type BenchTrend, type Benchmark,
} from "./insights-api";

export type WeekInsights = {
  tips: Tip[];
  tipsLoading: boolean;
  positives: Positive[];
  checklist: CheckItem[];
  discipline: { current: number | null; prevAvg: number | null; prevWeeks: number };
  feeShare: number | null;
  avgFeeShare: number | null;
  /** Trading days (Mon–Fri) without a journal entry that has a review. */
  daysWithoutReview: string[];
  /** Leak $ per day from the day reports (positive number = cost). */
  dayLeaks: Map<string, number>;
  bench: Benchmark | null;
  benchLoading: boolean;
  benchRow: BenchRow | null;
  trend: BenchTrend | null;
};

export function useWeekInsights(doc: WeeklyReview): WeekInsights {
  const trader = doc.trader;
  const week = doc.week;
  const beh = useWeekBehavior(trader, week);
  const fees = useWeekFees(trader, week);
  const sim = useSimSuggestions(trader, week);
  const tradingDates = React.useMemo(() => doc.days.filter((d) => d.trades > 0).map((d) => d.date), [doc.days]);
  const days = useWeekDayReports(trader, tradingDates);
  const bench = useWeekBenchmark(week);

  const k = doc.kpis.current;
  const avg4 = doc.kpis.avg4;

  return React.useMemo<WeekInsights>(() => {
    const behavior = beh.data ?? null;
    const tips = buildTips({
      trader, weekStart: week.start, weekEnd: week.end, kpi: k, behavior, fees: fees.data ?? null,
      suggestions: sim.data ?? null, suggestionsWeeks: SIM_WEEKS, dayReports: days.data,
    });
    const journalByDate = new Map(doc.discipline.days.map((d) => [d.date, d]));
    const daysWithoutReview = tradingDates.filter((d) => !journalByDate.get(d)?.hasReview);
    const journalDays = tradingDates.filter((d) => journalByDate.has(d)).length;
    const positives = buildPositives({
      weekStart: week.start, kpi: k, avg4, avg4Weeks: doc.kpis.avg4Weeks, behavior,
      bestTrade: doc.bestTrades[0] ? { ticker: doc.bestTrades[0].ticker, net: doc.bestTrades[0].net } : null,
      violations: doc.violations.items.length, mistakes: doc.mistakes.items.length,
      journalDays, tradingDays: tradingDates.length,
    });
    const feeShare = feeShareOf(k);
    const riskLabels = [...new Set(doc.risk.events.map((e) => e.label))];
    const checklist = buildChecklist({
      trader, weekStart: week.start,
      violations: doc.violations.items.map((v) => ({ ruleName: v.ruleName, ruleKind: v.ruleKind, tradeNet: v.tradeNet })),
      violationCostUsd: doc.violations.cost.usd,
      mistakes: doc.mistakes.items.length, mistakeCostUsd: doc.mistakes.cost.usd,
      risk: {
        hasLimits: !!doc.risk.limits,
        breaches: doc.risk.events.filter((e) => e.level === "breach").length,
        warns: doc.risk.events.filter((e) => e.level === "warn").length,
        labels: riskLabels,
      },
      daysWithoutReview, tradingDays: tradingDates.length, behavior, feeShare,
      reviewStatus: doc.review?.status ?? "none", prevGoals: doc.prevGoals,
    });
    const dayLeaks = new Map<string, number>();
    for (const d of days.data) if (d.leaksTotalUsd != null && d.leaksTotalUsd > 0) dayLeaks.set(d.date, d.leaksTotalUsd);
    const b = bench.data ?? null;
    return {
      tips,
      tipsLoading: beh.isLoading || fees.isLoading || days.loading,
      positives,
      checklist,
      discipline: disciplineOf(behavior, week.start),
      feeShare,
      avgFeeShare: feeShareOf(avg4),
      daysWithoutReview,
      dayLeaks,
      bench: b,
      benchLoading: bench.isLoading,
      benchRow: b?.rows.find((r) => r.trader === trader) ?? null,
      trend: b?.trend.find((t) => t.trader === trader) ?? null,
    };
  }, [beh.data, beh.isLoading, fees.data, fees.isLoading, sim.data, days.data, days.loading, bench.data, bench.isLoading, doc, trader, week, k, avg4, tradingDates]);
}
