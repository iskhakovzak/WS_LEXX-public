/**
 * Лента сессии: сделки выбранного дня на оси времени (Нью-Йорк) — полосы вход→выход, накопленный нетто,
 * маркеры поведенческих флагов (реванш, тильт, мартингейл, эйфория, отыгрыш, овертрейдинг, пересиживание)
 * и момент срыва — первая сделка с поведенческим флагом. День выбирается кликом по тепловой карте
 * или стрелками; данные — GET /api/behavior/day.
 */
import * as React from "react";
import { Link, useLocation } from "wouter";
import { ArrowLeft, ArrowRight, CalendarDays, Rows3 } from "lucide-react";
import { DataTable, EmptyState, ErrorState, Pill, SkeletonBlock, SortableTh, toneOf, toneText, useTableSort, type Tone } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import {
  PATTERN_SHORT, PATTERN_TONE, dayReportHref, fmtClock, fmtMinutes, useBehaviorDay, type DayTimeline, type DisciplineDay, type PatternKey, type Range, type TimelineTrade,
} from "./api";
import { fmtDate, fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { behaviorI18n } from "@/i18n/ns/behavior";

const tb = behaviorI18n.t;
const sideWord = (side: string | null | undefined) => (side === "short" ? commonI18n.t("trading.short").toLowerCase() : side === "long" ? commonI18n.t("trading.long").toLowerCase() : "");

const TONE_VAR: Record<Tone, string> = {
  up: "hsl(var(--up))",
  down: "hsl(var(--down))",
  warn: "hsl(var(--warn))",
  purple: "hsl(var(--purple))",
  accent: "hsl(var(--primary))",
  neutral: "hsl(var(--muted-foreground))",
};

/** One-letter ribbon markers (letters follow the UI language: Р / R …); patterns without a marker are absent. */
const MARKER_KEYS = ["revenge", "tilt", "martingale", "euphoria", "chase", "overtrading", "disposition"] as const;
const MARKER_LETTER: Partial<Record<PatternKey, string>> = {};
for (const k of MARKER_KEYS) Object.defineProperty(MARKER_LETTER, k, { get: () => tb(`marker.${k}`), enumerable: true });

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = React.useRef<T>(null);
  const [w, setW] = React.useState(0);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const cw = Math.round(entries[0]?.contentRect.width ?? 0);
      setW((prev) => (Math.abs(prev - cw) > 1 ? cw : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function scoreTone(v: number | null | undefined): Tone {
  if (v == null) return "neutral";
  return v >= 85 ? "up" : v >= 65 ? "warn" : "down";
}

/* ─── Лента (SVG) ─────────────────────────────────────────────────────────── */

const PAD_L = 52;
const PAD_R = 16;
const CUM_H = 96;
const LANE_H = 16;
const LANE_GAP = 6;
const MARK_H = 22;
const AXIS_H = 20;

type Placed = TimelineTrade & { s: number; e: number; lane: number };

function layout(trades: TimelineTrade[]): { placed: Placed[]; lanes: number; t0: number; t1: number } {
  const timed = trades.filter((t) => t.entryMin != null);
  let lo = Math.min(...timed.map((t) => t.entryMin!));
  let hi = Math.max(...timed.map((t) => t.exitMin ?? t.entryMin! + (t.holdMin ?? 1)));
  // Основная сессия всегда видна целиком; премаркет/афтер — только если там есть сделки.
  lo = Math.min(lo - 10, 570);
  hi = Math.max(hi + 10, 960);
  const t0 = Math.floor(lo / 30) * 30;
  const t1 = Math.ceil(hi / 30) * 30;
  const laneEnds: number[] = [];
  const placed: Placed[] = timed
    .map((t) => ({ ...t, s: t.entryMin!, e: Math.max(t.exitMin ?? t.entryMin! + (t.holdMin ?? 0), t.entryMin! + 0.5), lane: 0 }))
    .sort((a, b) => a.s - b.s);
  for (const p of placed) {
    let lane = laneEnds.findIndex((end) => end <= p.s - 0.5);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(p.e); } else laneEnds[lane] = p.e;
    p.lane = lane;
  }
  return { placed, lanes: Math.max(1, laneEnds.length), t0, t1 };
}

const Ribbon = React.memo(function Ribbon({ tl, onOpen }: { tl: DayTimeline; onOpen: (id: number) => void }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { placed, lanes, t0, t1 } = React.useMemo(() => layout(tl.trades), [tl.trades]);
  const laneH = lanes > 8 ? Math.max(8, Math.floor((8 * (LANE_H + LANE_GAP)) / lanes) - 2) : LANE_H;
  const laneGap = lanes > 8 ? 2 : LANE_GAP;
  const lanesTop = CUM_H + MARK_H + 8;
  const height = lanesTop + lanes * (laneH + laneGap) + AXIS_H;
  const innerW = Math.max(10, width - PAD_L - PAD_R);
  const x = (m: number) => PAD_L + ((m - t0) / (t1 - t0)) * innerW;

  // Накопленный нетто: ступеньки по времени выхода (или входа, если выхода нет).
  const cumPts = React.useMemo(() => {
    const pts = tl.trades
      .filter((t) => t.entryMin != null)
      .map((t) => ({ m: t.exitMin ?? t.entryMin!, cum: t.cum }))
      .sort((a, b) => a.m - b.m);
    return pts;
  }, [tl.trades]);
  const lo = Math.min(0, tl.summary.trough, ...cumPts.map((p) => p.cum));
  const hi = Math.max(0, tl.summary.peak, ...cumPts.map((p) => p.cum));
  const span = hi - lo || 1;
  const y = (v: number) => 8 + (1 - (v - lo) / span) * (CUM_H - 16);
  let path = `M ${x(t0)} ${y(0)}`;
  let last = 0;
  for (const p of cumPts) {
    path += ` L ${x(p.m)} ${y(last)} L ${x(p.m)} ${y(p.cum)}`;
    last = p.cum;
  }
  path += ` L ${x(t1)} ${y(last)}`;
  const finalTone = toneOf(last);

  const ticks: number[] = [];
  for (let m = Math.ceil(t0 / 60) * 60; m <= t1; m += 60) ticks.push(m);
  const bd = tl.summary.breakdown;

  return (
    <div ref={ref} className="relative w-full">
      {width > 0 ? (
        <svg width={width} height={height} role="img" aria-label={tb("timeline.aria", { date: fmtDate(tl.date, "medium"), trades: commonI18n.t("units.trades", { count: tl.summary.n }), net: fmtUsd(tl.summary.net, { signed: true, decimals: "auto" }) })} className="block">
          {/* сетка часов */}
          {ticks.map((m) => (
            <g key={m}>
              <line x1={x(m)} x2={x(m)} y1={0} y2={height - AXIS_H} stroke="hsl(var(--border))" strokeDasharray="2 4" />
              <text x={x(m)} y={height - 6} textAnchor="middle" fontSize={12} fill="hsl(var(--muted-foreground))" className="tabular-nums">{fmtClock(m)}</text>
            </g>
          ))}
          {/* основная сессия */}
          <rect x={x(570)} y={0} width={Math.max(0, x(960) - x(570))} height={height - AXIS_H} fill="hsl(var(--muted) / 0.12)" />

          {/* накопленный нетто */}
          <text x={PAD_L - 8} y={y(0) + 4} textAnchor="end" fontSize={12} fill="hsl(var(--muted-foreground))">$0</text>
          <line x1={PAD_L} x2={PAD_L + innerW} y1={y(0)} y2={y(0)} stroke="hsl(var(--muted-foreground) / 0.4)" />
          <path d={path} fill="none" stroke={TONE_VAR[finalTone]} strokeWidth={2} strokeLinejoin="round" />
          {tl.summary.peak > 0 && <text x={PAD_L - 8} y={y(tl.summary.peak) + 4} textAnchor="end" fontSize={12} fill="hsl(var(--up))" className="tabular-nums">{fmtUsd(tl.summary.peak, { signed: true, compact: true })}</text>}
          {tl.summary.trough < 0 && <text x={PAD_L - 8} y={y(tl.summary.trough) + 4} textAnchor="end" fontSize={12} fill="hsl(var(--down))" className="tabular-nums">{fmtUsd(tl.summary.trough, { signed: true, compact: true })}</text>}

          {/* момент срыва */}
          {bd && bd.entryMin != null && (
            <g>
              <line x1={x(bd.entryMin)} x2={x(bd.entryMin)} y1={0} y2={height - AXIS_H} stroke="hsl(var(--down))" strokeWidth={1.5} strokeDasharray="4 3" />
              <text x={Math.min(x(bd.entryMin) + 4, PAD_L + innerW - 4)} y={12} textAnchor={x(bd.entryMin) + 120 > PAD_L + innerW ? "end" : "start"} fontSize={12} fontWeight={600} fill="hsl(var(--down))">
                {tb("timeline.breakdown", { pattern: PATTERN_SHORT[bd.key] })}
              </text>
            </g>
          )}

          {/* сделки */}
          {placed.map((t) => {
            const yy = lanesTop + t.lane * (laneH + laneGap);
            const x0 = x(t.s);
            const w = Math.max(3, x(t.e) - x0);
            const tone = toneOf(t.net);
            const flagged = t.flags.filter((f) => MARKER_LETTER[f.key]);
            const label = `${fmtClock(t.entryMin)}–${fmtClock(t.exitMin)} ${t.ticker} ${sideWord(t.side)} · ${fmtUsd(t.net, { signed: true, decimals: "auto" })} · ${tb("timeline.accumulated", { value: fmtUsd(t.cum, { signed: true, decimals: "auto" }) })}` +
              (t.flags.length ? `\n${t.flags.map((f) => `${PATTERN_SHORT[f.key]}: ${f.note}`).join("\n")}` : "");
            return (
              <g
                key={t.id}
                role="link"
                tabIndex={0}
                aria-label={label.replace(/\n/g, "; ")}
                className="cursor-pointer outline-none [&:focus-visible>rect]:stroke-[hsl(var(--ring))]"
                onClick={() => onOpen(t.id)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(t.id); } }}
              >
                <title>{label}</title>
                <rect x={x0} y={yy} width={w} height={laneH} rx={3} fill={TONE_VAR[tone === "neutral" ? "neutral" : tone]} fillOpacity={flagged.length ? 0.95 : 0.6} stroke="transparent" strokeWidth={2} />
                {flagged.length > 0 && flagged.slice(0, 3).map((f, i) => {
                  const cx = x0 + 7 + i * 15;
                  const cy = CUM_H + MARK_H / 2 + 4;
                  return (
                    <g key={f.key}>
                      <line x1={x0 + 0.5} x2={x0 + 0.5} y1={cy + 7} y2={yy} stroke={TONE_VAR[PATTERN_TONE[f.key]]} strokeOpacity={0.5} />
                      <circle cx={cx} cy={cy} r={7} fill={TONE_VAR[PATTERN_TONE[f.key]]} />
                      <text x={cx} y={cy + 4} textAnchor="middle" fontSize={10} fontWeight={700} fill="hsl(var(--background))">{MARKER_LETTER[f.key]}</text>
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      ) : (
        <div style={{ height }} />
      )}
    </div>
  );
});

/* ─── Таблица сделок дня ──────────────────────────────────────────────────── */

const TRADE_ACCESSORS = {
  entry: (t: TimelineTrade) => t.entryMin,
  ticker: (t: TimelineTrade) => t.ticker,
  hold: (t: TimelineTrade) => t.holdMin,
  net: (t: TimelineTrade) => t.net,
  cum: (t: TimelineTrade) => t.cum,
  flags: (t: TimelineTrade) => t.flags.length,
} as const;

function TradesList({ tl }: { tl: DayTimeline }) {
  // Default: by entry time (the day's story); headers re-sort, e.g. by net or by number of flags.
  const { rows, thProps } = useTableSort(tl.trades, TRADE_ACCESSORS, "entry", "asc");
  return (
    <DataTable maxHeight="60vh" ariaLabel={tb("timeline.tableAria", { date: fmtDate(tl.date, "medium") })}>
      <table>
        <thead>
          <tr>
            <SortableTh {...thProps("entry")}>{tb("timeline.col.entry")}</SortableTh>
            <SortableTh {...thProps("ticker")}>{tb("timeline.col.ticker")}</SortableTh>
            <SortableTh {...thProps("hold")}>{tb("timeline.col.hold")}</SortableTh>
            <SortableTh {...thProps("net")} align="right">{tb("timeline.col.net")}</SortableTh>
            <SortableTh {...thProps("cum")} align="right">{tb("timeline.col.cum")}</SortableTh>
            <SortableTh {...thProps("flags")}>{tb("timeline.col.flags")}</SortableTh>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}>
              <td className="tabular-nums">
                <Link href={links.trade(t.id)} className="underline-offset-2 hover:underline">{fmtClock(t.entryMin)}</Link>
              </td>
              <td className="whitespace-nowrap font-medium">
                {t.ticker} <span className="text-xs font-normal text-muted-foreground">{sideWord(t.side)}</span>
              </td>
              <td className="tabular-nums">{fmtMinutes(t.holdMin)}</td>
              <td className={cn("text-right tabular-nums", toneText(toneOf(t.net)))}>{fmtUsd(t.net, { signed: true, decimals: "auto" })}</td>
              <td className={cn("text-right tabular-nums", toneText(toneOf(t.cum)))}>{fmtUsd(t.cum, { signed: true, decimals: "auto" })}</td>
              <td>
                <div className="flex flex-wrap gap-1">
                  {t.flags.map((f) => <Pill key={f.key} tone={PATTERN_TONE[f.key]} title={f.note}>{PATTERN_SHORT[f.key]}</Pill>)}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </DataTable>
  );
}

/* ─── Панель ──────────────────────────────────────────────────────────────── */

export function SessionTimeline({
  trader, range, days, date, onDateChange,
}: {
  trader: string | null;
  range: Range;
  days: DisciplineDay[];
  date: string | null;
  onDateChange: (d: string) => void;
}) {
  const q = useBehaviorDay(trader, date, range);
  const [, navigate] = useLocation();
  const [showList, setShowList] = React.useState(false);
  const idx = date ? days.findIndex((d) => d.date === date) : -1;
  const prev = idx > 0 ? days[idx - 1].date : null;
  const next = idx >= 0 && idx < days.length - 1 ? days[idx + 1].date : null;
  const onOpen = React.useCallback((id: number) => navigate(links.trade(id)), [navigate]);

  const tl = q.data;
  const penalties = tl ? Object.entries(tl.summary.penalties).filter(([, v]) => (v ?? 0) > 0) : [];
  const usedFlags = React.useMemo(() => {
    const s = new Set<PatternKey>();
    tl?.trades.forEach((t) => t.flags.forEach((f) => { if (MARKER_LETTER[f.key]) s.add(f.key); }));
    return [...s];
  }, [tl]);

  if (!date) return <EmptyState icon={CalendarDays} title={tb("timeline.pickDay")} description={tb("timeline.pickDayHint")} />;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" className="h-8 w-8" disabled={!prev} onClick={() => prev && onDateChange(prev)} aria-label={tb("timeline.prevDay")}>
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
          <span className="min-w-[8.5rem] text-center text-base font-semibold text-foreground" aria-live="polite">{fmtDate(date, "weekdayDayMonth")}</span>
          <Button size="icon" variant="ghost" className="h-8 w-8" disabled={!next} onClick={() => next && onDateChange(next)} aria-label={tb("timeline.nextDay")}>
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
        {tl && (
          <>
            <Pill tone="neutral">{commonI18n.t("units.trades", { count: tl.summary.n })}</Pill>
            <Pill tone={toneOf(tl.summary.net)}>{tb("timeline.net", { value: fmtUsd(tl.summary.net, { signed: true, decimals: "auto" }) })}</Pill>
            {tl.summary.score != null && <Pill tone={scoreTone(tl.summary.score)} title={tb("timeline.scoreTitle")}>{tb("timeline.score", { value: tl.summary.score })}</Pill>}
            {penalties.map(([k, v]) => <Pill key={k} tone="neutral" title={tb("timeline.penaltyTitle")}>{PATTERN_SHORT[k as PatternKey]} −{v}</Pill>)}
          </>
        )}
        <Link href={dayReportHref(date, trader)} className="ml-auto inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline">
          {tb("timeline.dayReview")} <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </Link>
      </div>

      {q.isError && !tl ? (
        <ErrorState error={q.error} onRetry={q.refetch} compact />
      ) : !tl ? (
        <SkeletonBlock className="h-[220px] w-full rounded-xl" />
      ) : tl.trades.length === 0 ? (
        <EmptyState icon={CalendarDays} title={tb("timeline.noTrades")} description={tb("timeline.noTradesHint")} />
      ) : (
        <div className={cn("flex flex-col gap-2 transition-opacity duration-[var(--dur-2)]", q.isFetching && q.isPlaceholderData && "opacity-60")}>
          {tl.trades.some((t) => t.entryMin != null) ? (
            <Ribbon tl={tl} onOpen={onOpen} />
          ) : (
            <p className="text-xs text-muted-foreground">{tb("timeline.noTime")}</p>
          )}

          {tl.summary.breakdown && (
            <p className="text-sm text-foreground">
              <span className="font-semibold text-down">{tb("timeline.breakAt", { time: fmtClock(tl.summary.breakdown.entryMin) })}</span>
              {" — "}{tl.summary.breakdown.note}. {tb("timeline.before", { value: fmtUsd(tl.summary.breakdown.cumBefore, { signed: true, decimals: "auto" }) })}
              {tl.summary.breakdown.netAfter != null && tb("timeline.after", { value: fmtUsd(tl.summary.breakdown.netAfter, { signed: true, decimals: "auto" }) })}.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {usedFlags.map((k) => (
              <span key={k} className="inline-flex items-center gap-1">
                <span className="inline-grid h-4 w-4 place-items-center rounded-full text-[10px] font-bold text-background" style={{ background: TONE_VAR[PATTERN_TONE[k]] }} aria-hidden="true">{MARKER_LETTER[k]}</span>
                {PATTERN_SHORT[k]}
              </span>
            ))}
            <span>{tb("timeline.norm", { norm: tl.norms.tradesPerDayNorm, min: tl.norms.revengeMin })}</span>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setShowList((v) => !v)} aria-expanded={showList}>
              <Rows3 className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> {showList ? tb("timeline.hideList") : tb("timeline.showList")}

            </Button>
          </div>

          {(showList || !tl.trades.some((t) => t.entryMin != null)) && <TradesList tl={tl} />}
        </div>
      )}
    </div>
  );
}
