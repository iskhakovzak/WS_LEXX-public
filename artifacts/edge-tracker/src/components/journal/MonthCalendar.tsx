import { useMemo, type ReactNode } from "react";
import { CheckCheck, ChevronLeft, ChevronRight } from "lucide-react";
import { Panel, Segmented } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { type DayStats, addDays, fmtMonthTitle, localDateStr, monthBounds, parseDate, weekStart, weekdaysShortMonFirst } from "./utils";
import { fmtDate, fmtR, fmtUsd } from "@/lib/format";
import { journalI18n } from "@/i18n/ns/journal";
import { rich as withNodes } from "@/i18n/rich";
import { commonI18n } from "@/i18n/ns/common";

export type CalMetric = "r" | "pnl" | "count";

/**
 * Review state of a day: `missing` = traded but no reflection; `filled` = reflection written (not closed);
 * `closed` = day closed, waiting for the curator; `reviewed` = checked by the curator.
 */
export type ReviewMark = "missing" | "filled" | "closed" | "reviewed";

/** Review mark → label in the current language (read on access). */
const MARK_LABEL = Object.defineProperties({} as Record<ReviewMark, string>, Object.fromEntries(
  (["missing", "filled", "closed", "reviewed"] as const).map((m) => [m, { get: () => journalI18n.t(`calendar.mark.${m}`), enumerable: true }]),
));

function MarkDot({ mark }: { mark: ReviewMark }) {
  if (mark === "reviewed") return <CheckCheck className="h-3.5 w-3.5 text-up" aria-hidden="true" />;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "h-2 w-2 rounded-full",
        mark === "missing" && "border border-warn bg-transparent",
        mark === "filled" && "bg-primary/60",
        mark === "closed" && "bg-primary",
      )}
    />
  );
}

function metricValue(s: DayStats | undefined, metric: CalMetric): number | null {
  if (!s) return null;
  if (metric === "r") return s.r;
  if (metric === "pnl") return s.pnl;
  return s.trades;
}

function fmtMetric(v: number | null, metric: CalMetric, compact = false): string {
  if (v == null) return "";
  if (metric === "r") return fmtR(v, compact ? 1 : 2);
  if (metric === "pnl") return compact ? fmtUsd(v, { signed: true, compact: true }) : fmtUsd(v, { signed: true, decimals: "auto" });
  return String(v);
}

/** Heat tint bucket for |v| relative to the month's max. */
function heatClass(v: number | null, max: number, metric: CalMetric): string {
  if (v == null || max <= 0) return "";
  if (metric === "count") {
    const k = v / max;
    return k > 0.66 ? "bg-primary/25" : k > 0.33 ? "bg-primary/15" : "bg-primary/10";
  }
  if (v === 0) return "bg-muted/40";
  const k = Math.min(1, Math.abs(v) / max);
  const up = v > 0;
  if (k > 0.66) return up ? "bg-up/30" : "bg-down/30";
  if (k > 0.33) return up ? "bg-up/20" : "bg-down/20";
  return up ? "bg-up/10" : "bg-down/10";
}

function toneClass(v: number | null, metric: CalMetric): string {
  if (v == null || metric === "count") return "text-foreground";
  return v > 0 ? "text-up" : v < 0 ? "text-down" : "text-muted-foreground";
}

export function MonthCalendar({
  month,
  activeDate,
  today,
  statsByDate,
  marks,
  metric,
  onMetricChange,
  onSelect,
  onMonthChange,
  hasPnl,
  hasR,
  footer,
}: {
  month: string;
  activeDate: string;
  today: string;
  statsByDate: Map<string, DayStats>;
  marks: Map<string, ReviewMark>;
  metric: CalMetric;
  onMetricChange: (m: CalMetric) => void;
  onSelect: (date: string) => void;
  onMonthChange: (delta: number) => void;
  hasPnl: boolean;
  /** Show the R metric only when the month has trades with a stop (R). */
  hasR: boolean;
  footer?: ReactNode;
}) {
  const { from, to } = monthBounds(month);

  const weeks = useMemo(() => {
    const rows: string[][] = [];
    let cur = weekStart(from);
    while (cur <= to) {
      const row: string[] = [];
      for (let i = 0; i < 7; i++) row.push(addDays(cur, i));
      rows.push(row);
      cur = addDays(cur, 7);
    }
    return rows;
  }, [from, to]);

  const maxAbs = useMemo(() => {
    let m = 0;
    for (const [d, s] of statsByDate) {
      if (d < from || d > to) continue;
      const v = metricValue(s, metric);
      if (v != null) m = Math.max(m, Math.abs(v));
    }
    return m;
  }, [statsByDate, metric, from, to]);

  const month$ = useMemo(() => {
    let net = 0, trades = 0, green = 0, red = 0, reviewed = 0, traded = 0;
    for (const [d, s] of statsByDate) {
      if (d < from || d > to || s.trades === 0) continue;
      traded++;
      trades += s.trades;
      if (s.pnl != null) { net += s.pnl; if (s.pnl > 0) green++; else if (s.pnl < 0) red++; }
      const m = marks.get(d);
      if (m && m !== "missing") reviewed++;
    }
    return { net, trades, green, red, reviewed, traded };
  }, [statsByDate, marks, from, to]);

  const { t } = journalI18n.useT();
  const metricOptions = [
    { value: "pnl" as const, label: <span title={hasPnl ? t("calendar.pnlNetTitle") : t("calendar.pnlUnavailable")}>P&L</span>, disabled: !hasPnl },
    ...(hasR || metric === "r" ? [{ value: "r" as const, label: "R" }] : []),
    { value: "count" as const, label: commonI18n.t("trading.trades") },
  ];

  return (
    <Panel
      title={fmtMonthTitle(month)}
      description={
        month$.traded > 0 ? (
          <span className="tabular-nums">
            {hasPnl && <span className={toneClass(month$.net, "pnl")}>{fmtUsd(month$.net, { signed: true, decimals: "auto" })}</span>}
            {hasPnl && " · "}
            {withNodes(t("calendar.monthStats", { trades: month$.trades, green: "{green}", red: "{red}", reviewed: month$.reviewed, traded: month$.traded }), {
              green: <span className="text-up">{month$.green}</span>,
              red: <span className="text-down">{month$.red}</span>,
            })}
          </span>
        ) : t("calendar.noTrades")
      }
      actions={
        <div className="flex items-center gap-1.5">
          <Segmented<CalMetric>
            size="sm"
            ariaLabel={t("calendar.metricAria")}
            value={metric}
            onChange={onMetricChange}
            options={metricOptions}
          />
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t("calendar.prevMonth")} title={t("calendar.prevMonth")} onClick={() => onMonthChange(-1)}>
            <ChevronLeft />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t("calendar.nextMonth")} title={t("calendar.nextMonth")} onClick={() => onMonthChange(1)}>
            <ChevronRight />
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-7 gap-1 sm:grid-cols-[repeat(7,minmax(0,1fr))_64px] sm:gap-1.5">
        {weekdaysShortMonFirst().map((w, i) => (
          <div key={w} className={cn("pb-1 text-center text-xs text-muted-foreground", i >= 5 && "opacity-80")}>{w}</div>
        ))}
        <div className="hidden pb-1 text-center text-2xs text-muted-foreground sm:block">{t("calendar.week")}</div>

        {weeks.map((row) => {
          let wSum: number | null = null;
          let wTrades = 0, wGreen = 0, wRed = 0;
          for (const d of row) {
            const s = statsByDate.get(d);
            if (!s) continue;
            wTrades += s.trades;
            const v = metricValue(s, metric);
            if (v != null) wSum = (wSum ?? 0) + v;
            if (s.pnl != null && s.trades > 0) { if (s.pnl > 0) wGreen++; else if (s.pnl < 0) wRed++; }
          }
          return (
            <WeekRow key={row[0]}>
              {row.map((d) => {
                const inMonth = d >= from && d <= to;
                const s = statsByDate.get(d);
                const v = metricValue(s, metric);
                const mark = s && s.trades > 0 ? marks.get(d) ?? "missing" : marks.get(d);
                const isActive = d === activeDate;
                const isToday = d === today;
                const wd = parseDate(d).getDay();
                const weekend = wd === 0 || wd === 6;
                const label = [
                  fmtDate(d, "long"),
                  s ? t("calendar.dayTrades", { count: s.trades }) : t("calendar.dayNoTrades"),
                  s && v != null && metric !== "count" ? fmtMetric(v, metric) : null,
                  mark ? MARK_LABEL[mark] : null,
                ].filter(Boolean).join(", ");
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => onSelect(d)}
                    aria-pressed={isActive}
                    aria-label={label}
                    title={label}
                    className={cn(
                      "relative flex min-h-[52px] min-w-0 flex-col items-start justify-between rounded-xl border border-transparent p-1.5 text-left transition-[background-color,border-color,box-shadow] duration-[var(--dur-1)] sm:min-h-[68px] sm:p-2",
                      "hover:border-[var(--glass-border)] hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      !inMonth && "opacity-40",
                      weekend && !s && "opacity-60",
                      heatClass(v, maxAbs, metric),
                      isActive && "border-primary ring-1 ring-primary",
                    )}
                  >
                    <span className="flex w-full items-center justify-between gap-1">
                      <span
                        className={cn(
                          "grid h-5 min-w-5 place-items-center rounded-full px-1 text-2xs tabular-nums",
                          isToday ? "bg-primary font-semibold text-primary-foreground" : "text-muted-foreground",
                        )}
                      >
                        {parseDate(d).getDate()}
                      </span>
                      {mark && inMonth && d <= today && <span title={MARK_LABEL[mark]} className="grid place-items-center"><MarkDot mark={mark} /></span>}
                    </span>
                    {s && (
                      <span className="w-full min-w-0">
                        <span className={cn("block truncate text-2xs font-semibold tabular-nums sm:text-xs", toneClass(v, metric))}>
                          {v != null ? fmtMetric(v, metric, true) : "·"}
                        </span>
                        {metric !== "count" && (
                          <span className="hidden truncate text-2xs text-muted-foreground tabular-nums sm:block">
                            {t("calendar.tradesShort", { count: s.trades })}
                          </span>
                        )}
                      </span>
                    )}
                  </button>
                );
              })}
              <div
                className="hidden min-w-0 flex-col justify-center rounded-xl bg-[var(--glass-bg)] p-1.5 text-right sm:flex"
                title={wTrades > 0 ? t("calendar.weekTitle", { sum: fmtMetric(wSum, metric), trades: wTrades, green: wGreen, red: wRed }) : undefined}
              >
                <span className={cn("truncate text-xs font-semibold tabular-nums", toneClass(wSum, metric))}>
                  {wTrades > 0 && wSum != null ? fmtMetric(wSum, metric, true) : "—"}
                </span>
                <span className="truncate text-2xs text-muted-foreground tabular-nums">
                  {wTrades > 0 ? (metric === "count" ? t("calendar.greenRedDays", { green: wGreen, red: wRed }) : t("calendar.tradesShort", { count: wTrades })) : ""}
                </span>
              </div>
            </WeekRow>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-muted-foreground">
        {(["missing", "filled", "closed", "reviewed"] as const).map((m) => (
          <span key={m} className="inline-flex items-center gap-1.5"><MarkDot mark={m} />{MARK_LABEL[m]}</span>
        ))}
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded bg-up/30" aria-hidden="true" />{t("calendar.plus")}</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded bg-down/30" aria-hidden="true" />{t("calendar.minus")}</span>
        {!hasPnl && metric !== "count" && <span title={t("calendar.pnlOffTitle")}>{t("calendar.pnlNoData")}</span>}
        {footer && <span className="ml-auto">{footer}</span>}
      </div>
    </Panel>
  );
}

/** A week is laid out with `display: contents` so cells sit directly in the parent grid. */
function WeekRow({ children }: { children: ReactNode }) {
  return <div className="contents">{children}</div>;
}

export function currentMonth(): string {
  return localDateStr(new Date()).slice(0, 7);
}
