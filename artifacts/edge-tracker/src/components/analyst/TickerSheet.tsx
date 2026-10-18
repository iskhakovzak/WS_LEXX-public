/**
 * Ticker detail: my context, actions (watchlist / plan / idea), how the stock reacts to ratings, price vs targets,
 * consensus, firms covering it and the full rating timeline with the reaction of each event.
 */
import * as React from "react";
import { Link } from "wouter";
import {
  BookmarkCheck, BookmarkPlus, Briefcase, CalendarCheck, CalendarPlus, ExternalLink, History, Lightbulb, Loader2, Repeat,
} from "lucide-react";
import {
  CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis, Cell,
} from "recharts";
import { Delta, EmptyState, Pill, SortableTh, Sparkline, StatRow, TermTooltip, useTableSort } from "@/components/ds";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import { useReactionDetail, useTickerHistory, type ReactionAgg, type ReactionDetail, type ReactionEvent, type ReactionKind } from "./api";
import { GradeChange, HORIZON_LABEL, KindPill, TargetChange } from "./ActionRow";
import { REACTION_KIND_LABEL } from "./rows";
import {
  num, nyKey, relAgo, stanceOf, WEIGHT_MIN_N,
  type FeedAction, type OpenPosition, type Quote, type Stance,
} from "./lib";
import { fmtDate, fmtPct, fmtRate, fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { analystI18n } from "@/i18n/ns/analyst";
import { rich } from "@/i18n/rich";

import { personName } from "@/i18n";
/** Translator reference (called at render time, never at module scope). */
const tf = analystI18n.t;

/** Latest action per firm in the last 12 months → street consensus. */
function consensus(items: FeedAction[]) {
  const cutoff = Date.now() - 365 * 86400_000;
  const latest = new Map<string, FeedAction>();
  for (const a of items) {
    if (!a.gradedAt || new Date(a.gradedAt).getTime() < cutoff) continue;
    const prev = latest.get(a.firm);
    if (!prev || (prev.gradedAt ?? "") < a.gradedAt) latest.set(a.firm, a);
  }
  const counts: Record<Stance, number> = { buy: 0, hold: 0, sell: 0 };
  const pts: number[] = [];
  for (const a of latest.values()) {
    const s = stanceOf(a.toGrade);
    if (s) counts[s]++;
    const pt = num(a.priceTarget);
    if (pt != null) pts.push(pt);
  }
  pts.sort((x, y) => x - y);
  const avg = pts.length ? pts.reduce((s, x) => s + x, 0) / pts.length : null;
  const median = pts.length ? pts[Math.floor(pts.length / 2)] : null;
  return { firms: latest.size, counts, avg, median, low: pts[0] ?? null, high: pts[pts.length - 1] ?? null };
}

type FirmOnTicker = ReactionDetail["byFirm"][number];
type FirmKey = "firm" | "events" | "power" | "hit" | "last";
/** Strength / hit rate are only meaningful from 2 measured reactions (same rule as the cells). */
const FIRM_ACCESSORS: Record<FirmKey, (f: FirmOnTicker) => number | string | null> = {
  firm: (f) => f.firm,
  events: (f) => f.events,
  power: (f) => (f.all.n >= 2 ? f.all.avgRatio : null),
  hit: (f) => (f.all.n >= 2 ? f.all.hitRate : null),
  last: (f) => (f.lastAt ? Date.parse(f.lastAt) : null),
};
const FIRMS_COLLAPSED = 8;

function FirmsOnTicker({ rows }: { rows: FirmOnTicker[] }) {
  const { rows: sorted, thProps } = useTableSort(rows, FIRM_ACCESSORS, "events");
  const [all, setAll] = React.useState(false);
  const shown = all ? sorted : sorted.slice(0, FIRMS_COLLAPSED);
  return (
    <>
      <table className="w-full table-fixed text-xs tabular-nums">
        <colgroup>
          <col />
          <col style={{ width: 72 }} />
          <col style={{ width: 64 }} />
          <col style={{ width: 88 }} />
          <col style={{ width: 96 }} />
        </colgroup>
        <thead>
          <tr className="text-2xs text-muted-foreground">
            <SortableTh {...thProps("firm")} className="pb-1 text-left font-medium">{tf("firms.colFirm")}</SortableTh>
            <SortableTh {...thProps("events")} align="right" className="pb-1 font-medium">{tf("sheet.colEvents")}</SortableTh>
            <SortableTh {...thProps("power")} align="right" className="pb-1 font-medium">{tf("sheet.colPower")}</SortableTh>
            <SortableTh {...thProps("hit")} align="right" className="pb-1 font-medium">{tf("firms.colHit")}</SortableTh>
            <SortableTh {...thProps("last")} align="right" className="pb-1 font-medium">{tf("sheet.colLast")}</SortableTh>
          </tr>
        </thead>
        <tbody>
          {shown.map((f) => {
            const agg = f.all;
            return (
              <tr key={f.firm} className="border-t border-border/50">
                <td className="truncate py-1.5 pr-2 text-foreground" title={f.firm}>{f.firm}</td>
                <td className="py-1.5 text-right">{f.events}</td>
                <td className="py-1.5 text-right">{agg.n >= 2 && agg.avgRatio != null ? `×${agg.avgRatio.toFixed(1)}` : "—"}</td>
                <td className="py-1.5 text-right">{agg.n >= 2 && agg.hitRate != null ? fmtRate(agg.hitRate) : "—"}</td>
                <td className="py-1.5 text-right text-muted-foreground">{f.lastAt ? relAgo(f.lastAt) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length > FIRMS_COLLAPSED && (
        <button type="button" className="mt-1 text-xs text-primary hover:underline" onClick={() => setAll((v) => !v)}>
          {all ? commonI18n.t("actions.collapse") : commonI18n.t("actions.showAllCount", { count: rows.length })}
        </button>
      )}
    </>
  );
}

const AXIS = { stroke: "hsl(var(--muted-foreground))", fontSize: 11, tickLine: false, axisLine: false } as const;
const TOOLTIP_STYLE: React.CSSProperties = {
  backgroundColor: "hsl(var(--popover) / 0.95)",
  border: "1px solid hsl(var(--border))",
  color: "hsl(var(--popover-foreground))",
  borderRadius: 12,
  fontSize: 12,
  fontVariantNumeric: "tabular-nums",
};
const KIND_FILL: Record<string, string> = {
  upgrade: "hsl(var(--up))",
  downgrade: "hsl(var(--down))",
  initiated: "hsl(var(--primary))",
};

type ChartRow = { d: string; c: number; pt?: number; ptKind?: string; ptFirm?: string };

function chartData(detail: ReactionDetail | null | undefined, items: FeedAction[]): ChartRow[] {
  const prices = detail?.prices ?? [];
  if (prices.length < 2) return [];
  const rows: ChartRow[] = prices.map((p) => ({ d: p.d, c: p.c }));
  const first = rows[0].d;
  for (const a of items) {
    const pt = num(a.priceTarget);
    const day = nyKey(a.gradedAt).slice(0, 10);
    if (pt == null || !day || day < first) continue;
    // First bar on/after the publication date.
    let lo = 0, hi = rows.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (rows[m].d < day) lo = m + 1; else hi = m; }
    const r = rows[Math.min(lo, rows.length - 1)];
    if (r.pt == null || a.action === "upgrade" || a.action === "downgrade") { r.pt = pt; r.ptKind = a.action; r.ptFirm = a.firm; }
  }
  return rows;
}

function ReactionTile({ kind, agg }: { kind: ReactionKind; agg: ReactionAgg | undefined }) {
  const ok = !!agg && agg.n > 0 && agg.avgDay != null;
  return (
    <div className="tile flex min-w-0 flex-col gap-0.5 rounded-xl p-2.5">
      <span className="text-2xs font-medium text-muted-foreground">{REACTION_KIND_LABEL[kind]}</span>
      {ok ? (
        <>
          <Delta value={agg!.avgDay} suffix="%" bare showIcon={false} className="text-sm font-semibold" />
          <span className="text-2xs tabular-nums text-muted-foreground">
            {tf("sheet.gap", { value: fmtPct(agg!.avgGap, 1) })}
            {agg!.hitRate != null && <> · {fmtRate(agg!.hitRate)}</>}
          </span>
          <span className="text-2xs tabular-nums text-muted-foreground">n={agg!.n}{agg!.avgRatio != null ? ` · ×${agg!.avgRatio.toFixed(1)}` : ""}</span>
        </>
      ) : (
        <span className="text-xs text-muted-foreground">{tf("sheet.noEvents")}</span>
      )}
    </div>
  );
}

function ReactionOfEvent({ e }: { e: ReactionEvent | undefined }) {
  if (!e || e.day == null) return null;
  return (
    <span
      className="inline-flex items-center gap-1.5 text-2xs tabular-nums text-muted-foreground"
      title={`${tf("sheet.eventTitle", { day: fmtDate(e.reactionDay, "medium"), gap: fmtPct(e.gap, 1), close: fmtPct(e.day, 1), o2c: fmtPct(e.o2c, 1) })}${e.volRatio != null ? tf("sheet.eventVolume", { value: e.volRatio.toFixed(1) }) : ""}`}
    >
      {tf("sheet.reaction")} <Delta value={e.day} suffix="%" bare showIcon={false} className="text-2xs" />
      {e.gap != null && <span>{tf("sheet.gap", { value: fmtPct(e.gap, 1) })}</span>}
      {e.ratio != null && <span className={cn(e.ratio >= 2 && "font-medium text-purple")}>×{e.ratio.toFixed(1)}</span>}
    </span>
  );
}

function monthTitle(day: string): string {
  const [y, m] = day.split("-").map(Number);
  if (!y || !m) return day;
  const s = fmtDate(new Date(y, m - 1, 15), "monthYear");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const TIMELINE_STEP = 60;

export function TickerSheet({
  ticker,
  onOpenChange,
  quote,
  held,
  watched,
  inPlan,
  traded,
  addingWatch,
  addingPlan,
  canEdit,
  onAddWatch,
  onAddPlan,
}: {
  ticker: string | null;
  onOpenChange: (open: boolean) => void;
  quote?: Quote | null;
  held: OpenPosition[];
  watched: boolean;
  inPlan: boolean;
  /** My trades on the ticker over the last year (null — unknown). */
  traded: { trades: number; net: number; wins: number; losses: number } | null;
  addingWatch: boolean;
  addingPlan: boolean;
  canEdit: boolean;
  onAddWatch: (a: FeedAction) => void;
  onAddPlan: (a: FeedAction) => void;
}) {
  const q = useTickerHistory(ticker);
  const rx = useReactionDetail(ticker);
  const items = React.useMemo(() => q.data?.items ?? [], [q.data]);
  const c = React.useMemo(() => consensus(items), [items]);
  const head = items[0];
  const totalStance = c.counts.buy + c.counts.hold + c.counts.sell;
  const price = quote?.price ?? null;
  const upside = c.avg != null && price ? ((c.avg - price) / price) * 100 : null;
  const evById = React.useMemo(() => new Map((rx.data?.events ?? []).map((e) => [e.id, e])), [rx.data]);
  const chart = React.useMemo(() => chartData(rx.data, items), [rx.data, items]);
  const [limit, setLimit] = React.useState(TIMELINE_STEP);
  React.useEffect(() => setLimit(TIMELINE_STEP), [ticker]);

  const months = React.useMemo(() => {
    const out: { month: string; list: FeedAction[] }[] = [];
    for (const a of items.slice(0, limit)) {
      const m = nyKey(a.gradedAt).slice(0, 7) || "—";
      const last = out[out.length - 1];
      if (last && last.month === m) last.list.push(a);
      else out.push({ month: m, list: [a] });
    }
    return out;
  }, [items, limit]);

  const leadForAction = head ?? null;

  return (
    <Sheet open={!!ticker} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-2xl [&>*]:shrink-0">
        <SheetHeader>
          <SheetTitle className="flex flex-wrap items-center gap-2">
            {ticker}
            {price != null && <span className="text-base font-medium tabular-nums text-muted-foreground">{fmtUsd(price, { decimals: "trim" })}</span>}
            {quote?.change != null && <Delta value={quote.change} suffix="%" />}
          </SheetTitle>
          <SheetDescription>
            {head?.longName ?? quote?.name ?? tf("sheet.description")}
            {head?.marketCapNum != null ? ` · ${fmtUsd(head.marketCapNum, { compact: true })}` : ""}
            {head?.sector ? ` · ${head.sector}` : ""}
          </SheetDescription>
        </SheetHeader>

        {(held.length > 0 || watched || (traded && traded.trades > 0)) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {held.length > 0 && (
              <Pill tone="warn" title={held.map((h) => `${h.trader ? personName(h.trader) : "—"} · ${HORIZON_LABEL[h.horizon]}${h.side ? ` · ${h.side}` : ""}`).join("; ")}>
                <Briefcase className="h-3 w-3" aria-hidden="true" />
                {tf("sheet.held", { names: held.map((h) => (h.trader ? personName(h.trader) : "—")).join(", ") })}
              </Pill>
            )}
            {watched && <Pill tone="accent"><BookmarkCheck className="h-3 w-3" aria-hidden="true" /> {tf("sheet.inWatchlist")}</Pill>}
            {traded && traded.trades > 0 && (
              <Pill tone="neutral" title={tf("sheet.tradedTitle")}>
                <Repeat className="h-3 w-3" aria-hidden="true" />
                {rich(tf("sheet.traded", { count: traded.trades, net: "{net}" }), { net: <span className={traded.net >= 0 ? "text-up" : "text-down"}>{fmtUsd(traded.net, { signed: true, decimals: "auto" })}</span> })}
              </Pill>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={!canEdit || watched || addingWatch || !leadForAction} onClick={() => leadForAction && onAddWatch(leadForAction)}>
            {addingWatch ? <Loader2 className="animate-spin" aria-hidden="true" /> : watched ? <BookmarkCheck aria-hidden="true" /> : <BookmarkPlus aria-hidden="true" />}
            {watched ? tf("sheet.inWatchlist") : tf("sheet.toWatchlist")}
          </Button>
          <Button variant="outline" size="sm" disabled={!canEdit || inPlan || addingPlan || !leadForAction} onClick={() => leadForAction && onAddPlan(leadForAction)}>
            {addingPlan ? <Loader2 className="animate-spin" aria-hidden="true" /> : inPlan ? <CalendarCheck aria-hidden="true" /> : <CalendarPlus aria-hidden="true" />}
            {inPlan ? tf("sheet.inPlan") : tf("sheet.toPlan")}
          </Button>
          {ticker && (
            <Button variant="outline" size="sm" asChild>
              <Link href={links.newIdea(ticker)}>
                <Lightbulb aria-hidden="true" /> {tf("sheet.newIdea")}
              </Link>
            </Button>
          )}
          {ticker && (
            <Button variant="ghost" size="sm" asChild>
              <a href={`https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/analysis`} target="_blank" rel="noopener noreferrer">
                <ExternalLink aria-hidden="true" /> Yahoo
              </a>
            </Button>
          )}
        </div>

        {/* ── reaction ── */}
        {rx.data !== null && (
          <section className="glass-panel rounded-2xl p-4" aria-label={tf("sheet.reactionAria")}>
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <span className="micro-label inline-flex items-center gap-1">
                {tf("sheet.reactionTitle")} <TermTooltip term="reaction" icon />
              </span>
              {rx.data?.typicalMove != null && (
                <span className="text-2xs tabular-nums text-muted-foreground">{tf("sheet.typical", { value: rx.data.typicalMove.toFixed(1) })}</span>
              )}
            </div>
            {rx.isLoading ? (
              <div className="grid grid-cols-5 gap-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-[76px] rounded-xl" />)}</div>
            ) : rx.isError ? (
              <p className="text-xs text-muted-foreground">{tf("sheet.candlesFailed")}</p>
            ) : rx.data && rx.data.bars.count === 0 ? (
              <p className="text-xs text-muted-foreground">{tf("sheet.noCandles")}</p>
            ) : rx.data ? (
              <>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                  {(["up", "down", "init", "ptUp", "ptDown"] as const).map((k) => <ReactionTile key={k} kind={k} agg={rx.data!.byKind[k]} />)}
                </div>
                <p className="mt-2 text-2xs text-muted-foreground">
                  {rich(tf("sheet.legend", { day: "{day}", hit: "{hit}" }), {
                    day: <TermTooltip term="reactionDay">{tf("sheet.legendDay")}</TermTooltip>,
                    hit: <TermTooltip term="ratingHit">{tf("sheet.legendHit")}</TermTooltip>,
                  })}
                </p>
              </>
            ) : null}
          </section>
        )}

        {q.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-48 w-full rounded-2xl" />
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full rounded-xl" />)}
          </div>
        ) : q.isError ? (
          <QueryError error={q.error} onRetry={() => q.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState icon={History} title={tf("sheet.noHistory")} />
        ) : (
          <>
            {/* ── price vs targets + consensus ── */}
            <section className="glass-panel rounded-2xl p-4" aria-label={tf("sheet.consensusAria")}>
              <div className="mb-3 flex items-baseline justify-between gap-2">
                <span className="micro-label">{tf("sheet.consensusTitle")}</span>
                <span className="text-2xs text-muted-foreground">{tf("sheet.firmsCount", { count: c.firms })}</span>
              </div>
              {chart.length > 1 ? (
                <div className="h-48 w-full" role="img" aria-label={tf("sheet.chartAria", { ticker: ticker ?? "" })}>
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={chart} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                      <XAxis dataKey="d" {...AXIS} minTickGap={48} tickFormatter={(d: string) => fmtDate(d, "dayMonthNumeric")} />
                      <YAxis {...AXIS} width={48} domain={["auto", "auto"]} tickFormatter={(v: number) => fmtUsd(v, { decimals: 0 })} />
                      <Tooltip
                        contentStyle={TOOLTIP_STYLE}
                        labelFormatter={(d) => fmtDate(String(d), "short")}
                        formatter={(v: number, name: string, p: { payload?: ChartRow }) =>
                          name === "pt" ? [fmtUsd(v, { decimals: "trim" }), `PT · ${p.payload?.ptFirm ?? ""}`] : [fmtUsd(v, { decimals: "trim" }), tf("sheet.price")]}
                      />
                      {c.avg != null && (
                        <ReferenceLine
                          y={c.avg}
                          stroke="hsl(var(--primary))"
                          strokeDasharray="4 4"
                          label={{ value: tf("sheet.consensus", { value: fmtUsd(c.avg, { decimals: "trim" }) }), position: "insideTopRight", fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                        />
                      )}
                      <Line type="monotone" dataKey="c" name="c" stroke="hsl(var(--foreground))" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                      <Scatter dataKey="pt" name="pt" isAnimationActive={false}>
                        {chart.map((r, i) => (
                          <Cell key={i} fill={r.pt == null ? "transparent" : KIND_FILL[r.ptKind ?? ""] ?? "hsl(var(--muted-foreground))"} />
                        ))}
                      </Scatter>
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              ) : quote?.spark && quote.spark.length > 1 ? (
                <Sparkline data={quote.spark} width={400} height={36} className="w-full" ariaLabel={tf("sheet.sparkAria")} />
              ) : null}
              {totalStance > 0 && (
                <div className="mt-3">
                  <div className="flex h-2 w-full overflow-hidden rounded-full bg-[var(--glass-bg)]" role="img"
                    aria-label={tf("sheet.stanceAria", { buy: c.counts.buy, hold: c.counts.hold, sell: c.counts.sell })}>
                    <span className="h-full bg-up" style={{ width: `${(c.counts.buy / totalStance) * 100}%` }} />
                    <span className="h-full bg-muted-foreground/40" style={{ width: `${(c.counts.hold / totalStance) * 100}%` }} />
                    <span className="h-full bg-down" style={{ width: `${(c.counts.sell / totalStance) * 100}%` }} />
                  </div>
                  <div className="mt-1.5 flex justify-between text-2xs tabular-nums">
                    <span className="text-up">{tf("sheet.buy", { count: c.counts.buy })}</span>
                    <span className="text-muted-foreground">{tf("sheet.hold", { count: c.counts.hold })}</span>
                    <span className="text-down">{tf("sheet.sell", { count: c.counts.sell })}</span>
                  </div>
                </div>
              )}
              <div className="mt-3 grid grid-cols-2 gap-x-6">
                <StatRow label={tf("sheet.avgPt")} value={fmtUsd(c.avg, { decimals: "trim" })} />
                <StatRow label={tf("sheet.median")} value={fmtUsd(c.median, { decimals: "trim" })} />
                <StatRow label={tf("sheet.minMax")} value={`${fmtUsd(c.low, { decimals: "trim" })} / ${fmtUsd(c.high, { decimals: "trim" })}`} />
                <StatRow label={tf("sheet.upside")} value={upside == null ? "—" : fmtPct(upside, 1)} tone={upside == null ? "neutral" : upside >= 0 ? "up" : "down"} />
              </div>
            </section>

            {/* ── firms on this ticker ── */}
            {rx.data && rx.data.byFirm.length > 0 && (
              <section aria-label={tf("sheet.firmsAria")}>
                <div className="micro-label mb-2">{tf("sheet.firmsAria")}</div>
                <FirmsOnTicker rows={rx.data.byFirm} />
                {rx.data.byFirm.some((f) => f.all.n < WEIGHT_MIN_N) && (
                  <p className="mt-1 text-2xs text-muted-foreground">{tf("sheet.firmsNote", { min: WEIGHT_MIN_N })}</p>
                )}
              </section>
            )}

            {/* ── timeline ── */}
            <section aria-label={tf("sheet.historyAria")}>
              <div className="micro-label mb-2">{tf("sheet.history", { count: items.length })}</div>
              {months.map(({ month, list }) => (
                <div key={month} className="mb-2">
                  <div className="border-b border-[var(--glass-border)] py-1 text-xs font-medium text-muted-foreground">{monthTitle(month)}</div>
                  <ol className="flex flex-col">
                    {list.map((a) => (
                      <li key={a.id} className="flex items-start gap-3 border-b border-border/50 py-2 last:border-b-0">
                        <div className="w-14 shrink-0 text-2xs tabular-nums text-muted-foreground" title={a.gradedAt ? fmtDate(a.gradedAt, "shortDateTime") : ""}>
                          <div className="text-foreground">{fmtDate(nyKey(a.gradedAt).slice(0, 10), "dayMonthNumeric")}</div>
                          <div>{nyKey(a.gradedAt).slice(11)}</div>
                        </div>
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <KindPill kind={a.action} />
                            <span className="truncate text-sm font-medium text-foreground">{a.firm}</span>
                          </div>
                          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5">
                            <GradeChange from={a.fromGrade} to={a.toGrade} />
                            <TargetChange action={a} showUpside={false} />
                          </div>
                          <ReactionOfEvent e={evById.get(a.id)} />
                        </div>
                        {a.sourceUrl && (
                          <a
                            href={a.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={tf("sheet.sourceAria", { source: a.source })}
                            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground"
                          >
                            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                          </a>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
              {items.length > limit && (
                <Button variant="ghost" size="sm" onClick={() => setLimit((n) => n + TIMELINE_STEP)}>
                  {tf("sheet.showMore", { count: Math.min(TIMELINE_STEP, items.length - limit), total: items.length - limit })}
                </Button>
              )}
            </section>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
