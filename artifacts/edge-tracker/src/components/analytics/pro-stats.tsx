import { useMemo, useState } from "react";
import { ArrowDownRight, ArrowUpRight, CalendarRange, ListChecks, Search, Trophy } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Panel, StatCard, StatRow, Pill, EmptyState, toneOf, toneText, type Tone } from "@/components/ds";
import { cn } from "@/lib/utils";
import {
  type Metric, type EdgeStats, type OhlcTotals, type ClosureStats, type PeriodExtremes, type PeriodPoint,
  type WeekSummary, fmtMonthKey, fmtIsoWeekKey,
} from "@/lib/analytics-pro";
import { fmtVal } from "./pro-format";
import { fmtDate, fmtRate, fmtRatio } from "@/lib/format";
import { analyticsProI18n } from "@/i18n/ns/analyticsPro";
import { commonI18n } from "@/i18n/ns/common";

const tp = analyticsProI18n.t;

/* ── KPI strip ────────────────────────────────────────────────────────── */

export function KpiGrid({
  edge, ohlc, metric, totalTrades,
}: { edge: EdgeStats; ohlc: OhlcTotals; metric: Metric; totalTrades: number }) {
  const pf = edge.profitFactor;
  const greenRate = ohlc.totalDays ? ohlc.profitDays / ohlc.totalDays : null;
  const streak = edge.dayStreak;
  const streakText = streak.length && streak.kind !== "flat"
    ? tp(streak.kind === "up" ? "kpi.streak" : "kpi.streakLoss", { count: streak.length })
    : tp("kpi.ofDays", { value: ohlc.profitDays, total: ohlc.totalDays });
  const noVal = edge.count === 0;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <StatCard
        label={tp("kpi.total")}
        value={noVal ? "—" : fmtVal(metric, edge.total, { sign: true })}
        tone={toneOf(edge.total)}
        hint={tp("kpi.totalHint", { count: edge.count, trades: tp("page.trades", { count: totalTrades }), unit: metric === "r" ? "R" : "P&L" })}
      />
      <StatCard
        label={tp("kpi.expectancy")}
        value={fmtVal(metric, edge.expectancy, { sign: true })}
        tone={toneOf(edge.expectancy)}
        hint={tp("kpi.expectancyHint")}
      />
      <StatCard
        label={tp("kpi.winRate")}
        value={fmtRate(edge.winRate)}
        tone={edge.winRate == null ? "neutral" : edge.winRate >= 0.5 ? "up" : "down"}
        hint={noVal ? undefined : `${edge.wins} / ${edge.losses}`}
      />
      <StatCard
        label="Profit factor"
        value={fmtRatio(pf)}
        tone={pf == null ? "neutral" : pf >= 1 ? "up" : "down"}
        hint={edge.avgWin != null || edge.avgLoss != null
          ? `${fmtVal(metric, edge.avgWin, { compact: true, sign: true })} / ${fmtVal(metric, edge.avgLoss, { compact: true, sign: true })}`
          : undefined}
      />
      <StatCard
        label={tp("kpi.greenDays")}
        value={fmtRate(greenRate)}
        tone={greenRate == null ? "neutral" : greenRate >= 0.5 ? "up" : "down"}
        hint={streakText}
      />
      <StatCard
        label={tp("kpi.maxDd")}
        value={noVal ? "—" : fmtVal(metric, edge.maxDrawdown, { sign: true })}
        tone={edge.maxDrawdown < 0 ? "down" : "neutral"}
        hint={tp("kpi.fromPeak")}
      />
    </div>
  );
}

/* ── Best / worst periods ─────────────────────────────────────────────── */

export type JumpKind = "day" | "week" | "month";

export function ExtremesPanel({
  ext, metric, onJump,
}: { ext: PeriodExtremes; metric: Metric; onJump: (kind: JumpKind, key: string) => void }) {
  const cols: { kind: JumpKind; title: string; best: PeriodPoint | null; worst: PeriodPoint | null }[] = [
    { kind: "day", title: tp("extremes.kind.day"), best: ext.bestDay, worst: ext.worstDay },
    { kind: "week", title: tp("extremes.kind.week"), best: ext.bestWeek, worst: ext.worstWeek },
    { kind: "month", title: tp("extremes.kind.month"), best: ext.bestMonth, worst: ext.worstMonth },
  ];
  const empty = cols.every((c) => !c.best && !c.worst);
  return (
    <Panel icon={Trophy} title={tp("extremes.title")} description={tp("extremes.hint")}>
      {empty ? (
        <EmptyState title={tp("extremes.empty")} description={tp("extremes.emptyHint")} className="py-8" />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {cols.map((c) => (
            <div key={c.kind} className="flex flex-col gap-2">
              <span className="micro-label">{c.title}</span>
              <ExtremeTile kind={c.kind} p={c.best} tone="up" metric={metric} onJump={onJump} />
              <ExtremeTile kind={c.kind} p={c.worst} tone="down" metric={metric} onJump={onJump} />
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function ExtremeTile({
  kind, p, tone, metric, onJump,
}: { kind: JumpKind; p: PeriodPoint | null; tone: Tone; metric: Metric; onJump: (kind: JumpKind, key: string) => void }) {
  const Icon = tone === "up" ? ArrowUpRight : ArrowDownRight;

  if (!p) {
    return (
      <div className="flex min-h-[64px] items-center gap-2 rounded-xl border border-dashed border-border/70 px-3 text-xs text-muted-foreground">
        <Icon className="h-4 w-4" aria-hidden="true" />
        {tone === "up" ? tp("extremes.noUp") : tp("extremes.noDown")}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onJump(kind, p.key)}
      className={cn(
        "lift flex min-h-[64px] items-center gap-3 rounded-xl border border-border/60 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        tone === "up" ? "bg-up/10" : "bg-down/10",
      )}
      aria-label={tp(tone === "up" ? "extremes.bestAria" : "extremes.worstAria", { kind: tp(`extremes.kind.${kind}`).toLowerCase(), label: p.label, value: fmtVal(metric, p.net, { sign: true }) })}
    >
      <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-full", tone === "up" ? "bg-up/15 text-up" : "bg-down/15 text-down")}>
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block text-lg font-semibold tabular-nums leading-tight", toneText(tone))}>{fmtVal(metric, p.net, { sign: true })}</span>
        <span className="block truncate text-xs text-muted-foreground" title={p.label}>{p.label} · {commonI18n.t("units.tradesShort", { count: p.trades })}</span>
      </span>
    </button>
  );
}

/* ── Recent weeks ─────────────────────────────────────────────────────── */

export function WeeksPanel({ weeks, metric }: { weeks: WeekSummary[]; metric: Metric }) {
  return (
    <Panel icon={CalendarRange} title={tp("weeks.title")} description={tp("weeks.hint")}>
      <ul className="flex flex-col gap-2">
        {weeks.map((w) => (
          <li key={w.label} className="rounded-xl border border-border/60 bg-[var(--glass-bg)] px-3 py-2.5">
            <div className="flex items-baseline justify-between gap-2">
              <div className="min-w-0">
                <span className="text-sm font-medium">{w.label}</span>
                <span className="ml-2 whitespace-nowrap text-xs tabular-nums text-muted-foreground">{w.range}</span>
              </div>
              <span className={cn("shrink-0 whitespace-nowrap text-base font-semibold tabular-nums", w.tradingDays ? toneText(toneOf(w.totalNet)) : "text-muted-foreground")}>
                {w.tradingDays ? fmtVal(metric, w.totalNet, { sign: true }) : "—"}
              </span>
            </div>
            {w.tradingDays > 0 ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                <Pill tone="neutral">{tp("weeks.days", { count: w.tradingDays })}</Pill>
                <Pill tone="up">{tp("weeks.up", { count: w.profitDays })}</Pill>
                <Pill tone="down">{tp("weeks.down", { count: w.lossDays })}</Pill>
                <span className="ml-auto tabular-nums text-muted-foreground">
                  {tp("weeks.avg", { value: fmtVal(metric, w.avgDayNet, { compact: true, sign: true }) })}
                </span>
              </div>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">{tp("weeks.none")}</p>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/* ── Trading days info: grouped stat list ─────────────────────────────── */


type InfoRow = { name: string; value: string; tone?: Tone };

export function TradingDaysInfo({
  ohlc, closure, edge, metric, totalNetGained, totalNetLost,
}: {
  ohlc: OhlcTotals; closure: ClosureStats; edge: EdgeStats; metric: Metric;
  totalNetGained: number; totalNetLost: number;
}) {
  const [q, setQ] = useState("");
  const closedTotal = closure.closedPositive + closure.closedFlat + closure.closedNegative;
  const ofClosed = (n: number) => (closedTotal ? ` · ${fmtRate(n / closedTotal)}` : "");
  const v = (x: number | null | undefined, sign = true) => fmtVal(metric, x, { sign });
  const groups: { title: string; rows: InfoRow[] }[] = useMemo(() => [
    {
      title: tp("info.group.totals"),
      rows: [
        { name: tp("info.row.total"), value: v(ohlc.totalNet), tone: toneOf(ohlc.totalNet) },
        { name: tp("info.row.gained"), value: v(totalNetGained), tone: toneOf(totalNetGained) },
        { name: tp("info.row.lost"), value: v(totalNetLost), tone: toneOf(totalNetLost) },
        { name: tp("info.row.tradingDays"), value: String(ohlc.totalDays) },
        { name: tp("info.row.avgDay"), value: v(ohlc.netPerDay), tone: toneOf(ohlc.netPerDay) },
        { name: tp("info.row.expectancy"), value: v(edge.expectancy), tone: toneOf(edge.expectancy) },
        { name: tp("info.row.maxDd"), value: v(edge.maxDrawdown), tone: toneOf(edge.maxDrawdown) },
      ],
    },
    {
      title: tp("info.group.days"),
      rows: [
        { name: tp("info.row.upDays"), value: `${ohlc.profitDays}${ohlc.totalDays ? ` · ${fmtRate(ohlc.profitDays / ohlc.totalDays)}` : ""}`, tone: "up" },
        { name: tp("info.row.downDays"), value: `${ohlc.lossDays}${ohlc.totalDays ? ` · ${fmtRate(ohlc.lossDays / ohlc.totalDays)}` : ""}`, tone: "down" },
        { name: tp("info.row.bestDayResult"), value: ohlc.maxDayProfit > 0 ? v(ohlc.maxDayProfit) : "—", tone: "up" },
        { name: tp("info.row.worstDayResult"), value: ohlc.maxDayLoss < 0 ? v(ohlc.maxDayLoss) : "—", tone: "down" },
        { name: tp("info.row.avgUpDay"), value: v(ohlc.avgDayProfit), tone: toneOf(ohlc.avgDayProfit) },
        { name: tp("info.row.avgDownDay"), value: v(ohlc.avgDayLoss), tone: toneOf(ohlc.avgDayLoss) },
        { name: tp("info.row.strongDays"), value: ohlc.avgHighFixRate == null ? "—" : fmtRate(ohlc.avgHighFixRate, 1) },
      ],
    },
    {
      title: tp("info.group.streaks"),
      rows: [
        { name: tp("info.row.upDaysRow"), value: String(ohlc.maxProfitDaysRow) },
        { name: tp("info.row.downDaysRow"), value: String(ohlc.maxLossDaysRow) },
        { name: tp("info.row.upWeeksRow"), value: String(ohlc.maxProfitWeekRow) },
        { name: tp("info.row.downWeeksRow"), value: String(ohlc.maxLossWeekRow) },
        { name: tp("info.row.upMonthsRow"), value: String(ohlc.maxProfitMonthRow) },
        { name: tp("info.row.downMonthsRow"), value: String(ohlc.maxLossMonthRow) },
        {
          name: tp("info.row.currentStreak"),
          value: edge.dayStreak.length && edge.dayStreak.kind !== "flat" ? tp(edge.dayStreak.kind === "up" ? "info.streakUp" : "info.streakDown", { count: edge.dayStreak.length }) : "—",
          tone: edge.dayStreak.kind === "up" ? "up" : edge.dayStreak.kind === "down" ? "down" : "neutral",
        },
      ],
    },
    {
      title: tp("info.group.records"),
      rows: [
        { name: tp("info.row.bestMonth"), value: ohlc.bestMonth ? `${fmtMonthKey(ohlc.bestMonth.key)} · ${v(ohlc.bestMonth.value)}` : "—" },
        { name: tp("info.row.bestWeek"), value: ohlc.bestWeek ? `${fmtIsoWeekKey(ohlc.bestWeek.range)} · ${v(ohlc.bestWeek.value)}` : "—" },
        { name: tp("info.row.bestDay"), value: ohlc.bestDay ? `${fmtDate(ohlc.bestDay.date, "long")} · ${v(ohlc.bestDay.value)}` : "—" },
        { name: tp("info.row.bestTrade"), value: ohlc.bestTrade ? `${ohlc.bestTrade.ticker} · ${fmtDate(ohlc.bestTrade.date, "long")} · ${v(ohlc.bestTrade.value)}` : "—" },
      ],
    },
    {
      title: tp("info.group.closures"),
      rows: [
        { name: tp("info.row.withStop"), value: String(closure.stopLossOpenings) },
        { name: tp("info.row.closedUp"), value: `${closure.closedPositive}${ofClosed(closure.closedPositive)}`, tone: "up" },
        { name: tp("info.row.closedFlat"), value: `${closure.closedFlat}${ofClosed(closure.closedFlat)}` },
        { name: tp("info.row.closedDown"), value: `${closure.closedNegative}${ofClosed(closure.closedNegative)}`, tone: "down" },
        { name: tp("info.row.loss3"), value: String(closure.lostThreePlusInRow), tone: closure.lostThreePlusInRow > 0 ? "down" : "neutral" },
      ],
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [ohlc, closure, edge, metric, totalNetGained, totalNetLost]);

  const needle = q.trim().toLowerCase();
  const visible = groups
    .map((g) => ({ ...g, rows: needle ? g.rows.filter((r) => r.name.toLowerCase().includes(needle) || g.title.toLowerCase().includes(needle)) : g.rows }))
    .filter((g) => g.rows.length > 0);

  return (
    <Panel
      icon={ListChecks}
      title={tp("info.title")}
      actions={
        <div className="relative w-40 sm:w-52">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={tp("info.find")}
            aria-label={tp("info.findAria")}
            className="h-8 pl-8 text-xs"
          />
        </div>
      }
    >
      {visible.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{tp("info.nothing", { q })}</p>

      ) : (
        <div className="grid grid-cols-1 gap-x-8 gap-y-4 md:grid-cols-2 lg:grid-cols-1 2xl:grid-cols-2">
          {visible.map((g) => (
            <div key={g.title} className="min-w-0">
              <div className="micro-label mb-1">{g.title}</div>
              <div className="divide-y divide-border/50">
                {g.rows.map((r) => (
                  <StatRow key={r.name} label={r.name} value={r.value} tone={r.value === "—" ? "neutral" : r.tone ?? "neutral"} className="py-1.5" />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
