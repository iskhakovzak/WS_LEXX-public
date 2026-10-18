/**
 * Sections of «Разбор дня»: KPI header, intraday equity, trade timeline, breakdowns, leaks, strengths,
 * tomorrow's plan and cross-links. All numbers come pre-computed from GET /api/day-report (net $, ET time).
 */
import * as React from "react";
import type { CSSProperties } from "react";
import { Link } from "wouter";
import { Area, AreaChart, CartesianGrid, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  AlertTriangle, BarChart3, CalendarDays, CheckCircle2, Clock, ExternalLink, LineChart, ListChecks, ListOrdered, NotebookPen, Sparkles, Target,
} from "lucide-react";
import { DataTable, EmptyState, Panel, Pill, SortableTh, StatCard, StatGrid, StatRow, toneOf, toneText, useTableSort, type Tone } from "@/components/ds";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import { weekKeyOf } from "@/components/weekly-review/api";
import {
  SIDE_LABEL, fmtDayShort, fmtHold, type Bucket, type DayReport, type Leak, type LeakKind, type TimelineRow, type TradeRef,
} from "./api";
import { fmtNum, fmtRate, fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { dayReportI18n } from "@/i18n/ns/dayReport";

const TOOLTIP_STYLE: CSSProperties = {
  backgroundColor: "hsl(var(--popover) / 0.92)",
  border: "1px solid hsl(var(--border))",
  color: "hsl(var(--popover-foreground))",
  borderRadius: 12,
  fontSize: 12,
  boxShadow: "0 8px 32px rgb(0 0 0 / 0.3)",
  backdropFilter: "blur(24px)",
  fontVariantNumeric: "tabular-nums",
};

/** Leak kind → short label in the current language (read on access). */
export const LEAK_SHORT: Record<LeakKind, string> = Object.defineProperties({} as Record<LeakKind, string>, Object.fromEntries(
  (["fee_over_gross", "after_peak", "revenge", "size_up", "after_limit"] as const).map((k) => [k, { get: () => dayReportI18n.t(`leakShort.${k}`), enumerable: true }]),
));

function Money({ v, signed = true, className }: { v: number | null | undefined; signed?: boolean; className?: string }) {
  return <span className={cn("tabular-nums", toneText(toneOf(v)), className)}>{fmtUsd(v, { signed })}</span>;
}

function TradeLink({ t }: { t: Pick<TradeRef, "id" | "ticker"> }) {
  return (
    <Link href={links.trade(t.id)} className="font-medium text-foreground hover:text-primary hover:underline">
      {t.ticker}
    </Link>
  );
}

// ── 1. Header KPIs ───────────────────────────────────────────────────────────
export function SummaryBento({ doc }: { doc: DayReport }) {
  const { t } = dayReportI18n.useT();
  const s = doc.summary;
  const c = doc.comparison;
  const feeShare = s.feeShareOfGross;
  const cmpTone: Tone = c.betterThanPct == null ? "neutral" : c.betterThanPct >= 0.6 ? "up" : c.betterThanPct <= 0.4 ? "down" : "neutral";
  return (
    <StatGrid className="xl:grid-cols-5">
      <StatCard
        label={t("summary.net")}
        value={fmtUsd(s.net, { signed: true })}
        tone={toneOf(s.net)}
        hint={feeShare != null
          ? t("summary.netHintShare", { gross: fmtUsd(s.gross, { signed: true }), fees: fmtUsd(s.fees), share: fmtRate(feeShare, 1) })
          : t("summary.netHint", { gross: fmtUsd(s.gross, { signed: true }), fees: fmtUsd(s.fees) })}
      />
      <StatCard
        label={t("summary.tradesWr")}
        value={s.open ? t("summary.tradesValueOpen", { closed: s.closed, open: s.open, wr: fmtRate(s.winRate) }) : t("summary.tradesValue", { closed: s.closed, wr: fmtRate(s.winRate) })}
        hint={s.be
          ? t("summary.wlBe", { wins: s.wins, losses: s.losses, be: s.be, avg: fmtUsd(s.expectancy, { signed: true }) })
          : t("summary.wl", { wins: s.wins, losses: s.losses, avg: fmtUsd(s.expectancy, { signed: true }) })}
      />
      <StatCard
        label={t("summary.pf")}
        value={s.profitFactor != null ? fmtNum(s.profitFactor) : s.wins > 0 ? t("summary.noLosses") : "—"}
        tone={s.profitFactor == null ? (s.wins > 0 ? "up" : "neutral") : s.profitFactor >= 1 ? "up" : "down"}
        hint={t("summary.avgWinLoss", { win: fmtUsd(s.avgWin, { signed: true }), loss: fmtUsd(s.avgLoss, { signed: true }) })}
      />
      <StatCard
        label={t("summary.bestWorst")}
        value={
          <span className="flex items-baseline gap-2 text-xl">
            <Money v={s.best?.net} />
            <span className="text-muted-foreground">/</span>
            <Money v={s.worst?.net} />
          </span>
        }
        hint={s.best && s.worst ? `${s.best.ticker} · ${s.worst.ticker}` : "—"}
      />
      <StatCard
        label={t("summary.vsDays", { days: c.days || 20 })}
        value={c.betterThanPct != null && s.closed > 0 ? t("summary.better", { pct: fmtRate(c.betterThanPct) }) : "—"}
        tone={cmpTone}
        hint={c.avg != null
          ? c.z != null ? t("summary.avgZ", { avg: fmtUsd(c.avg, { signed: true }), z: fmtNum(c.z, { signed: true }) }) : t("summary.avg", { avg: fmtUsd(c.avg, { signed: true }) })
          : c.label}
      />
    </StatGrid>
  );
}

// ── 2. Intraday equity ───────────────────────────────────────────────────────
export function EquityPanel({ doc }: { doc: DayReport }) {
  const { t } = dayReportI18n.useT();
  const e = doc.equity;
  const timed = e.points.every((p) => p.t != null);
  const data = e.points.map((p, i) => ({ ...p, x: timed ? p.t! : i }));
  const peakPt = data.find((p) => p.tradeId === e.peak.tradeId && e.peak.tradeId != null);
  const ddEnd = data.find((p) => p.tradeId === e.maxDrawdown.toTradeId && e.maxDrawdown.toTradeId != null);
  const fmtX = (x: number) => {
    if (!timed) return `#${x}`;
    const p = data.find((d) => d.x === x);
    return p?.time?.slice(0, 5) ?? "";
  };
  const color = e.final >= 0 ? "hsl(var(--up))" : "hsl(var(--down))";
  const srcLabel = e.timeSource === "executions" ? t("equity.srcExecutions") : e.timeSource === "snapshot" ? t("equity.srcSnapshot") : t("equity.srcOrder");
  return (
    <Panel
      title={t("equity.title")}
      description={t("equity.desc", { src: srcLabel })}
      icon={LineChart}
      className="min-w-0"
      actions={
        <div className="flex flex-wrap gap-1.5">
          <Pill tone="up" title={t("equity.peakTitle")}>{t("equity.peak", { amount: fmtUsd(e.peak.value, { signed: true }) })}{e.peak.time ? ` · ${e.peak.time.slice(0, 5)}` : ""}</Pill>
          <Pill tone={e.maxDrawdown.value > 0 ? "down" : "neutral"} title={t("equity.ddTitle")}>
            max DD {fmtUsd(-e.maxDrawdown.value)}{e.maxDrawdown.fromTime && e.maxDrawdown.toTime ? ` · ${e.maxDrawdown.fromTime.slice(0, 5)}→${e.maxDrawdown.toTime.slice(0, 5)}` : ""}
          </Pill>
          {e.giveback > 0 && <Pill tone="warn" title={t("equity.givebackTitle")}>{t("equity.giveback", { amount: fmtUsd(e.giveback) })}</Pill>}
        </div>
      }
    >
      {data.length < 2 ? (
        <EmptyState icon={LineChart} title={t("equity.emptyTitle")} description={t("equity.emptyDesc")} className="py-8" />
      ) : (
        <div className="h-56 w-full" role="img" aria-label={t("equity.aria", { peak: fmtUsd(e.peak.value, { signed: true }), close: fmtUsd(e.final, { signed: true }), dd: fmtUsd(e.maxDrawdown.value) })}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 10, right: 12, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="dr-eq" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={color} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="hsl(var(--border) / 0.4)" vertical={false} />
              <XAxis
                dataKey="x"
                type="number"
                domain={["dataMin", "dataMax"]}
                ticks={data.map((d) => d.x)}
                tickFormatter={fmtX}
                tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                axisLine={false}
                tickLine={false}
                interval="preserveStartEnd"
                minTickGap={24}
              />
              <YAxis width={64} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} tickFormatter={(v: number) => fmtUsd(v)} />
              <ReferenceLine y={0} stroke="hsl(var(--border))" />
              {doc.dailyLossLimit != null && <ReferenceLine y={-doc.dailyLossLimit} stroke="hsl(var(--down))" strokeDasharray="4 4" label={{ value: t("equity.dailyLimit"), fill: "hsl(var(--down))", fontSize: 10, position: "insideBottomLeft" }} />}
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                labelFormatter={(x: number) => {
                  const p = data.find((d) => d.x === x);
                  return p ? `${p.time ?? ""} · ${p.ticker || t("equity.start")}` : "";
                }}
                formatter={(v: number, _n, item) => [`${fmtUsd(v, { signed: true })}${item?.payload?.tradeId ? ` ${t("equity.tradeNet", { amount: fmtUsd(item.payload.net, { signed: true }) })}` : ""}`, t("equity.cumulative")]}
              />
              <Area type="stepAfter" dataKey="cum" stroke={color} strokeWidth={2} fill="url(#dr-eq)" isAnimationActive={false} dot={{ r: 2.5, fill: color }} />
              {peakPt && <ReferenceDot x={peakPt.x} y={peakPt.cum} r={5} fill="hsl(var(--up))" stroke="hsl(var(--background))" />}
              {ddEnd && e.maxDrawdown.value > 0 && <ReferenceDot x={ddEnd.x} y={ddEnd.cum} r={5} fill="hsl(var(--down))" stroke="hsl(var(--background))" />}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </Panel>
  );
}

// ── 3. Timeline ──────────────────────────────────────────────────────────────
const TIMELINE_ACCESSORS = {
  index: (t: TimelineRow) => t.index,
  entry: (t: TimelineRow) => t.entryTime,
  exit: (t: TimelineRow) => t.exitTime,
  ticker: (t: TimelineRow) => t.ticker,
  side: (t: TimelineRow) => t.side,
  qty: (t: TimelineRow) => t.qty,
  hold: (t: TimelineRow) => t.holdMin,
  gross: (t: TimelineRow) => t.gross,
  fees: (t: TimelineRow) => t.fees,
  net: (t: TimelineRow) => t.net,
  cum: (t: TimelineRow) => t.cumAfter,
  gap: (t: TimelineRow) => t.gapMin,
} as const;

export function TimelinePanel({ doc }: { doc: DayReport }) {
  const flags = React.useMemo(() => {
    const m = new Map<number, LeakKind[]>();
    for (const l of doc.leaks) for (const id of l.tradeIds) m.set(id, [...(m.get(id) ?? []), l.kind]);
    return m;
  }, [doc.leaks]);
  const { t } = dayReportI18n.useT();
  const { t: tc } = commonI18n.useT();
  const rows = doc.timeline;
  // Default: chronological (# = order of entry). Any header re-sorts, e.g. by net to find the day's worst trades.
  const { rows: sorted, thProps } = useTableSort(rows, TIMELINE_ACCESSORS, "index", "asc");
  return (
    <Panel
      title={t("timeline.title")}
      description={[
        t("timeline.desc", { trades: tc("units.trades", { count: rows.length }) }),
        doc.firstEntry && doc.lastExit ? t("timeline.span", { from: doc.firstEntry.slice(0, 5), to: doc.lastExit.slice(0, 5) }) : null,
        doc.activeMinutes != null ? t("timeline.inMarket", { time: fmtHold(doc.activeMinutes) }) : null,
      ].filter(Boolean).join(" · ")}
      icon={ListOrdered}
      className="min-w-0"
      padded={false}
      bodyClassName="px-2 pb-2 sm:px-3"
    >
      <DataTable ariaLabel={t("timeline.aria")}>
        <table>
          <thead>
            <tr>
              <SortableTh {...thProps("index")}>#</SortableTh>
              <SortableTh {...thProps("entry")}>{t("timeline.entry")}</SortableTh>
              <SortableTh {...thProps("exit")}>{t("timeline.exit")}</SortableTh>
              <SortableTh {...thProps("ticker")}>{tc("trading.ticker")}</SortableTh>
              <SortableTh {...thProps("side")}>{t("timeline.side")}</SortableTh>
              <SortableTh {...thProps("qty")} align="right" className="!text-right">{t("timeline.qty")}</SortableTh>
              <SortableTh {...thProps("hold")} align="right" className="!text-right">{t("timeline.hold")}</SortableTh>
              <SortableTh {...thProps("gross")} align="right" className="!text-right">{tc("trading.gross")}</SortableTh>
              <SortableTh {...thProps("fees")} align="right" className="!text-right">{t("timeline.fee")}</SortableTh>
              <SortableTh {...thProps("net")} align="right" className="!text-right">{tc("trading.net")}</SortableTh>
              <SortableTh {...thProps("cum")} align="right" className="!text-right">{t("timeline.dayTotal")}</SortableTh>
              <SortableTh {...thProps("gap")}>{t("timeline.gap")}</SortableTh>
              <th scope="col">{t("timeline.flags")}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((t) => <TimelineTr key={t.id} t={t} flags={flags.get(t.id) ?? []} />)}
          </tbody>
        </table>
      </DataTable>
    </Panel>
  );
}

function TimelineTr({ t, flags }: { t: TimelineRow; flags: LeakKind[] }) {
  const { t: td } = dayReportI18n.useT();
  return (
    <tr className={cn(flags.length > 0 && "bg-[hsl(var(--chart-3)/0.06)]")}>
      <td className="text-muted-foreground">{t.index}</td>
      <td className="whitespace-nowrap">{t.entryTime ?? "—"}</td>
      <td className="whitespace-nowrap">{t.exitTime ?? "—"}</td>
      <td><TradeLink t={t} />{t.setup && <span className="ml-1.5 text-xs text-muted-foreground">{t.setup}</span>}</td>
      <td>{t.side ? <Pill tone={t.side === "long" ? "up" : "down"}>{SIDE_LABEL[t.side]}</Pill> : "—"}</td>
      <td className="text-right">{t.qty ?? "—"}</td>
      <td className="whitespace-nowrap text-right">{fmtHold(t.holdMin)}</td>
      <td className="text-right"><Money v={t.gross} /></td>
      <td className="text-right text-muted-foreground">{fmtUsd(t.fees)}</td>
      <td className="text-right font-medium"><Money v={t.net} /></td>
      <td className="text-right"><Money v={t.cumAfter} /></td>
      <td className="whitespace-nowrap text-xs text-muted-foreground">
        {t.overlap ? <Pill tone="purple" title={td("timeline.overlapTitle")}>{td("timeline.overlap")}</Pill> : t.gapMin != null ? fmtHold(t.gapMin) : "—"}
        {t.afterLoss && !t.overlap && <span className="ml-1 text-down" title={td("timeline.afterLossTitle")}>{td("timeline.afterLoss")}</span>}
      </td>
      <td>
        <div className="flex flex-wrap gap-1">
          {flags.map((f) => <Pill key={f} tone={f === "after_limit" || f === "revenge" ? "down" : "warn"}>{LEAK_SHORT[f]}</Pill>)}
        </div>
      </td>
    </tr>
  );
}

// ── 4. Breakdowns ────────────────────────────────────────────────────────────
const BUCKET_ACCESSORS = {
  // Hidden key: the server order (hour/side buckets are naturally ordered).
  order: (r: Bucket & { order: number }) => r.order,
  label: (r: Bucket & { order: number }) => r.label,
  trades: (r: Bucket & { order: number }) => r.trades,
  wins: (r: Bucket & { order: number }) => r.winRate,
  net: (r: Bucket & { order: number }) => r.net,
} as const;

function BucketTable({ title, rows: input, ariaLabel, defaultSort = "order" }: { title: string; rows: Bucket[]; ariaLabel: string; defaultSort?: "order" | "net" }) {
  const { t } = dayReportI18n.useT();
  const { t: tc } = commonI18n.useT();
  const indexed = React.useMemo(() => input.map((r, order) => ({ ...r, order })), [input]);
  const { rows, thProps } = useTableSort(indexed, BUCKET_ACCESSORS, defaultSort, defaultSort === "order" ? "asc" : "desc");
  const max = Math.max(0, ...rows.map((r) => Math.abs(r.net)));
  return (
    <div className="min-w-0">
      <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      {rows.length === 0 ? (
        <p className="py-3 text-sm text-muted-foreground">{t("breakdown.noData")}</p>
      ) : (
        <DataTable ariaLabel={ariaLabel}>
          <table>
            <thead>
              <tr>
                <SortableTh {...thProps("label")}>{title}</SortableTh>
                <SortableTh {...thProps("trades")} align="right" className="!text-right">{t("breakdown.tradesShort")}</SortableTh>
                <SortableTh {...thProps("wins")} align="right" className="!text-right">W/L</SortableTh>
                <SortableTh {...thProps("net")} align="right" className="!text-right">{tc("trading.net")}</SortableTh>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="whitespace-nowrap">
                    <div className="flex flex-col gap-1">
                      <span className="font-medium">{r.label}</span>
                      <span className="h-1 rounded-full bg-[var(--glass-bg)]" aria-hidden="true">
                        <span className={cn("block h-1 rounded-full", r.net >= 0 ? "bg-up/70" : "bg-down/70")} style={{ width: `${max > 0 ? (Math.abs(r.net) / max) * 100 : 0}%` }} />
                      </span>
                    </div>
                  </td>
                  <td className="text-right">{r.trades}</td>
                  <td className="whitespace-nowrap text-right text-muted-foreground">{r.wins}/{r.losses}</td>
                  <td className="text-right font-medium"><Money v={r.net} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataTable>
      )}
    </div>
  );
}

export function BreakdownPanel({ doc }: { doc: DayReport }) {
  const { t } = dayReportI18n.useT();
  return (
    <Panel title={t("breakdown.title")} description={t("breakdown.desc")} icon={BarChart3} className="min-w-0">
      <div className="grid gap-4 lg:grid-cols-3">
        <BucketTable title={t("breakdown.ticker")} rows={doc.breakdown.byTicker} ariaLabel={t("breakdown.tickerAria")} defaultSort="net" />
        <BucketTable title={t("breakdown.hour")} rows={doc.breakdown.byHour} ariaLabel={t("breakdown.hourAria")} />
        <BucketTable title={t("breakdown.side")} rows={doc.breakdown.bySide} ariaLabel={t("breakdown.sideAria")} />
      </div>
    </Panel>
  );
}

// ── 5. Leaks ─────────────────────────────────────────────────────────────────
const SEVERITY_TONE: Record<Leak["severity"], Tone> = { high: "down", medium: "warn", low: "neutral" };

export function LeaksPanel({ doc }: { doc: DayReport }) {
  const { t } = dayReportI18n.useT();
  const tickerOf = React.useMemo(() => new Map(doc.timeline.map((row) => [row.id, row.ticker])), [doc.timeline]);
  return (
    <Panel
      title={t("leaks.title")}
      description={doc.dailyLossLimit != null
        ? t(doc.dailyLossLimitSource === "tier" ? "leaks.rulesLimitTier" : "leaks.rulesLimit", { limit: fmtUsd(doc.dailyLossLimit) })
        : t("leaks.rulesNoLimit")}
      icon={AlertTriangle}
      className="min-w-0"
      actions={doc.leaks.length > 0 ? <Pill tone="down" title={t("leaks.totalTitle")}>≈ {fmtUsd(-doc.leaksTotalUsd)}</Pill> : undefined}
    >
      {doc.leaks.length === 0 ? (
        <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
          <CheckCircle2 className="h-4 w-4 text-up" aria-hidden="true" /> {t("leaks.none")}
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-border/50">
          {doc.leaks.map((l) => (
            <li key={l.kind} className="flex flex-wrap items-start justify-between gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{l.title}</span>
                  <Pill tone={SEVERITY_TONE[l.severity]}>{t(`leaks.severity.${l.severity}`)}</Pill>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">{l.detail}</p>
                <div className="mt-1 flex flex-wrap gap-1.5 text-xs">
                  {l.tradeIds.map((id) => (
                    <Link key={id} href={links.trade(id)} className="rounded-full border border-[var(--field-border)] px-2 py-0.5 hover:text-primary">
                      {tickerOf.get(id) ?? `#${id}`}
                    </Link>
                  ))}
                </div>
              </div>
              <div className="text-right">
                <div className={cn("text-sm font-semibold tabular-nums", l.costUsd > 0 ? "text-down" : "text-muted-foreground")}>{l.costUsd > 0 ? fmtUsd(-l.costUsd) : "$0.00"}</div>
                <div className="text-2xs text-muted-foreground">{t("leaks.tradesNet", { amount: fmtUsd(l.netUsd, { signed: true }) })}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ── 6. Strengths ─────────────────────────────────────────────────────────────
export function StrengthsPanel({ doc }: { doc: DayReport }) {
  const { t: td } = dayReportI18n.useT();
  const s = doc.strengths;
  const nothing = s.topTrades.length === 0;
  return (
    <Panel title={td("strengths.title")} description={td("strengths.desc")} icon={Sparkles} className="min-w-0">
      {nothing ? (
        <p className="py-2 text-sm text-muted-foreground">{td("strengths.none")}</p>
      ) : (
        <div className="flex flex-col gap-3">
          <ol className="flex flex-col gap-1.5">
            {s.topTrades.map((t, i) => (
              <li key={t.id} className="flex items-center gap-3 text-sm">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-up/15 text-xs font-semibold text-up">{i + 1}</span>
                <TradeLink t={t} />
                {t.side && <span className="text-xs text-muted-foreground">{SIDE_LABEL[t.side]}</span>}
                <span className="text-xs text-muted-foreground tabular-nums">{t.entryTime?.slice(0, 5) ?? "—"} · {fmtHold(t.holdMin)}</span>
                <Money v={t.net} className="ml-auto font-semibold" />
              </li>
            ))}
          </ol>
          <div className="flex flex-col gap-1">
            {s.tickers.length > 0 && <EdgeRow label={td("strengths.tickers")} items={s.tickers.map((x) => `${x.label} ${fmtUsd(x.net, { signed: true })}`)} />}
            {s.setups.length > 0 && <EdgeRow label={td("strengths.setups")} items={s.setups.map((x) => `${x.label} ${fmtUsd(x.net, { signed: true })} (${x.wins}/${x.trades})`)} />}
            {s.sides.length > 0 && <EdgeRow label={td("strengths.side")} items={s.sides.map((x) => `${x.label} ${fmtUsd(x.net, { signed: true })}`)} />}
            {s.bestHour && <EdgeRow label={td("strengths.bestHour")} items={[`${s.bestHour.label} ${fmtUsd(s.bestHour.net, { signed: true })}`]} />}
            {s.setups.length === 0 && <p className="text-xs text-muted-foreground">{td("strengths.noSetups")}</p>}
          </div>
        </div>
      )}
    </Panel>
  );
}

function EdgeRow({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
      <span className="text-xs text-muted-foreground">{label}:</span>
      {items.map((x) => <Pill key={x} tone="up">{x}</Pill>)}
    </div>
  );
}

// ── 7. Plan ──────────────────────────────────────────────────────────────────
export function PlanPanel({ doc }: { doc: DayReport }) {
  const { t } = dayReportI18n.useT();
  return (
    <Panel title={t("plan.title")} description={t("plan.desc")} icon={Target} className="min-w-0">
      {doc.plan.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">{t("plan.none")}</p>
      ) : (
        <ol className="flex flex-col gap-2.5">
          {doc.plan.map((p, i) => (
            <li key={p.id} className="flex gap-3">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary/15 text-xs font-semibold text-primary">{i + 1}</span>
              <div className="min-w-0">
                <p className="text-sm text-foreground">{p.text}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{p.source === "stat" ? t("plan.sourceStat") : t("plan.sourceFlag", { flag: LEAK_SHORT[p.source] })} · {p.reason}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

// ── Comparison detail ────────────────────────────────────────────────────────
export function ComparisonPanel({ doc }: { doc: DayReport }) {
  const { t } = dayReportI18n.useT();
  const c = doc.comparison;
  return (
    <Panel title={t("comparison.title")} description={c.label} icon={CalendarDays} className="min-w-0">
      <StatRow label={t("comparison.today")} value={fmtUsd(doc.summary.net, { signed: true })} tone={toneOf(doc.summary.net)} />
      <StatRow label={t("comparison.avg", { days: c.days })} value={fmtUsd(c.avg, { signed: true })} tone={toneOf(c.avg)} />
      <StatRow label={t("comparison.std")} value={c.std != null ? fmtUsd(c.std) : "—"} />
      <StatRow label="z-score" value={fmtNum(c.z, { signed: true })} tone={toneOf(c.z)} />
      <StatRow label={t("comparison.rank")} value={c.rank != null && c.days ? t("comparison.rankValue", { rank: c.rank, total: c.days + 1 }) : "—"} />
      <StatRow label={t("comparison.best")} value={c.bestDay ? `${fmtUsd(c.bestDay.net, { signed: true })} · ${fmtDayShort(c.bestDay.date)}` : "—"} />
      <StatRow label={t("comparison.worst")} value={c.worstDay ? `${fmtUsd(c.worstDay.net, { signed: true })} · ${fmtDayShort(c.worstDay.date)}` : "—"} />
    </Panel>
  );
}

// ── 8. Links ─────────────────────────────────────────────────────────────────
export function LinksPanel({ doc }: { doc: DayReport }) {
  const { t } = dayReportI18n.useT();
  const items: { href: string; label: string; icon: typeof NotebookPen }[] = [
    { href: links.journalDay(doc.date, doc.trader || undefined), label: t("links.journal"), icon: NotebookPen },
    { href: links.trades({ date: doc.date }), label: t("links.trades", { count: doc.summary.trades }), icon: ListChecks },
    { href: links.weeklyReview({ trader: doc.trader || undefined, week: weekKeyOf(doc.date) }), label: t("links.weekly"), icon: Clock },
  ];
  return (
    <div className="flex flex-wrap gap-2" data-print-hide>
      {items.map((it) => (
        <Link key={it.href} href={it.href} className="glass-field inline-flex min-h-9 items-center gap-2 px-3.5 text-sm font-medium hover:text-primary">
          <it.icon className="h-4 w-4" aria-hidden="true" /> {it.label} <ExternalLink className="h-3 w-3 opacity-60" aria-hidden="true" />
        </Link>
      ))}
    </div>
  );
}
