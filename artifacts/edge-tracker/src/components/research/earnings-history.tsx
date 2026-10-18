import type * as React from "react";
import { AlertTriangle, Moon, NotebookPen, RefreshCw, Sun, Clock3 } from "lucide-react";
import { Pill, StatRow, toneOf, toneText, type Tone } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import {
  useEarningsHistory,
  type CallType,
  type EarningsHistory,
} from "@/components/shared/market/earnings-api";
import { fmtDate, fmtPct, fmtUsd } from "@/lib/format";
import { humanizeApiError } from "@/lib/api/errors";
import { commonI18n } from "@/i18n/ns/common";
import { researchI18n } from "@/i18n/ns/research";

export function CallTypePill({ type, long = false, className }: { type: CallType; long?: boolean; className?: string }) {
  const { t } = researchI18n.useT();
  if (type === "BMO")
    return (
      <Pill tone="warn" className={className}>
        <Sun className="h-3 w-3" aria-hidden="true" />
        {long ? t("earnings.bmo") : "BMO"}
      </Pill>
    );
  if (type === "AMC")
    return (
      <Pill tone="purple" className={className}>
        <Moon className="h-3 w-3" aria-hidden="true" />
        {long ? t("earnings.amc") : "AMC"}
      </Pill>
    );
  return (
    <Pill tone="neutral" className={className}>
      <Clock3 className="h-3 w-3" aria-hidden="true" />
      {long ? t("earnings.unknown") : "—"}
    </Pill>
  );
}

export function StreakPill({ streak }: { streak: EarningsHistory["streak"] }) {
  if (!streak.kind || streak.count === 0) return null;
  const tone: Tone = streak.kind === "beat" ? "up" : "down";
  return (
    <Pill tone={tone} dot>
      {researchI18n.t("earnings.streak", { count: streak.count, kind: streak.kind === "beat" ? "beat" : "miss" })}
    </Pill>
  );
}

/** Vertical bars of the post-earnings reaction (close vs prev close), oldest → newest. */
function ReactionBars({ data }: { data: EarningsHistory }) {
  const qs = [...data.quarters].reverse().filter((q) => q.closePct != null);
  if (!qs.length) return null;
  const max = Math.max(4, ...qs.map((q) => Math.abs(q.closePct ?? 0)));
  return (
    <div aria-hidden="true" className="flex h-24 items-stretch gap-2">
      {qs.map((q) => {
        const v = q.closePct ?? 0;
        const h = Math.max(4, (Math.abs(v) / max) * 50);
        return (
          <div key={q.date} className="flex min-w-0 flex-1 flex-col items-center">
            <div className="relative w-full flex-1">
              <div className="absolute inset-x-0 top-1/2 h-px bg-border" />
              <div
                className={cn(
                  "absolute left-1/2 w-full max-w-7 -translate-x-1/2 rounded-md",
                  v >= 0 ? "bg-up/70" : "bg-down/70",
                )}
                style={v >= 0 ? { bottom: "50%", height: `${h}%` } : { top: "50%", height: `${h}%` }}
              />
            </div>
            <span className="mt-1 text-2xs tabular-nums text-muted-foreground">{fmtDate(q.date, "dayMonth")}</span>
          </div>
        );
      })}
    </div>
  );
}

export function EarningsHistoryView({
  ticker,
  timing,
  compact = false,
}: {
  ticker: string;
  timing?: CallType | null;
  compact?: boolean;
}) {
  const { data, isLoading, isError, error, refetch, isFetching } = useEarningsHistory(ticker, timing);
  const { t } = researchI18n.useT();

  if (isLoading) {
    return (
      <div className="space-y-2" aria-busy="true" aria-label={t("earnings.loading")}>
        <Skeleton className="h-6 w-2/3 rounded-full" />
        <Skeleton className="h-20 w-full rounded-xl" />
        {!compact && <Skeleton className="h-32 w-full rounded-xl" />}
      </div>
    );
  }
  if (isError) {
    return (
      <div className="flex flex-col items-start gap-2 text-sm text-muted-foreground">
        <span className="inline-flex items-center gap-1.5 text-down">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" /> {t("earnings.loadFailed", { message: humanizeApiError(error) })}
        </span>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} /> {commonI18n.t("actions.retry")}
        </Button>
      </div>
    );
  }
  if (!data || data.quarters.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("earnings.none", { ticker })}</p>;
  }

  const total = data.beats + data.misses;
  const quarters = compact ? data.quarters.slice(0, 4) : data.quarters;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <StreakPill streak={data.streak} />
        {total > 0 && (
          <Pill tone={data.beats >= data.misses ? "up" : "down"}>
            Beat {data.beats}/{total}
          </Pill>
        )}
        {(data.upReactions > 0 || data.downReactions > 0) && (
          <Pill tone="neutral">
            {t("earnings.upDown", { up: data.upReactions, down: data.downReactions })}
          </Pill>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-[var(--glass-bg)] p-3">
          <div className="text-xs text-muted-foreground">{t("earnings.avgGap")}</div>
          <div className="text-lg font-semibold tabular-nums">{data.avgAbsGap != null ? `±${data.avgAbsGap.toFixed(1)}%` : "—"}</div>
        </div>
        <div className="rounded-xl bg-[var(--glass-bg)] p-3">
          <div className="text-xs text-muted-foreground">{t("earnings.avgReaction")}</div>
          <div className="text-lg font-semibold tabular-nums">{data.avgAbsClose != null ? `±${data.avgAbsClose.toFixed(1)}%` : "—"}</div>
        </div>
      </div>

      <div>
        <div className="micro-label mb-1">{t("earnings.byDay")}</div>
        <ReactionBars data={data} />
      </div>

      <ul className="divide-y divide-border/70" aria-label={t("earnings.listAria", { ticker })}>
        {quarters.map((q) => (
          <li key={q.date} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium">
                {fmtDate(q.date, "medium")}
                {q.beat != null && <Pill tone={q.beat ? "up" : "down"}>{q.beat ? "Beat" : "Miss"}</Pill>}
              </div>
              <div className="text-xs text-muted-foreground tabular-nums">
                {q.fiscalQuarter ? `${q.fiscalQuarter} · ` : ""}EPS {fmtUsd(q.epsActual)} / {fmtUsd(q.epsEstimate)}
                {q.surprisePct != null && <span className={cn("ml-1", toneText(toneOf(q.surprisePct)))}>({fmtPct(q.surprisePct, 1)})</span>}
              </div>
            </div>
            <div className="flex items-center gap-4 text-right text-sm tabular-nums">
              <div>
                <div className="text-2xs text-muted-foreground">{t("earnings.gap")}</div>
                <div className={toneText(toneOf(q.gapPct))}>{fmtPct(q.gapPct, 1)}</div>
              </div>
              <div>
                <div className="text-2xs text-muted-foreground">{t("earnings.fromOpen")}</div>
                <div className={toneText(toneOf(q.dayPct))}>{fmtPct(q.dayPct, 1)}</div>
              </div>
              <div>
                <div className="text-2xs text-muted-foreground">{t("earnings.dayClose")}</div>
                <div className={cn("font-semibold", toneText(toneOf(q.closePct)))}>{fmtPct(q.closePct, 1)}</div>
              </div>
            </div>
          </li>
        ))}
      </ul>
      {!compact && (
        <p className="text-2xs text-muted-foreground">
          {data.timing ? (data.timing === "BMO" ? t("earnings.footBmo") : t("earnings.footAmc")) : t("earnings.footAny")}{" "}
          {t("earnings.source")}
        </p>
      )}
    </div>
  );
}

export type HistoryTarget = { ticker: string; company?: string | null; callType?: CallType | null; epsEstimate?: number | null; date?: string | null };

export function EarningsHistorySheet({
  target,
  onOpenChange,
  onCreateNote,
  extra,
}: {
  target: HistoryTarget | null;
  onOpenChange: (open: boolean) => void;
  onCreateNote?: (t: HistoryTarget) => void;
  /** Optional block under the history (e.g. «Катализаторы»: the trader's own trades on reaction days). */
  extra?: React.ReactNode;
}) {
  const { t } = researchI18n.useT();
  return (
    <Sheet open={!!target} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        {target && (
          <>
            <SheetHeader className="pr-10 text-left">
              <SheetTitle className="flex flex-wrap items-center gap-2 text-xl">
                {target.ticker}
                {target.callType && <CallTypePill type={target.callType} long />}
              </SheetTitle>
              <SheetDescription>{target.company ?? t("earnings.history")}</SheetDescription>
            </SheetHeader>
            {(target.date || target.epsEstimate != null) && (
              <div className="mt-4 rounded-xl bg-[var(--glass-bg)] px-3 py-1">
                {target.date && <StatRow label={t("earnings.nextReport")} value={fmtDate(target.date, "weekdayDayMonth")} />}
                {target.epsEstimate != null && <StatRow label={t("earnings.epsEstimate")} value={fmtUsd(target.epsEstimate)} />}
              </div>
            )}
            <div className="mt-5">
              <EarningsHistoryView ticker={target.ticker} timing={target.callType} />
            </div>
            {extra && <div className="mt-5">{extra}</div>}
            {onCreateNote && (
              <div className="mt-5 flex justify-end">
                <Button variant="outline" onClick={() => onCreateNote(target)}>
                  <NotebookPen className="h-4 w-4" /> {t("earnings.noteFor", { ticker: target.ticker })}
                </Button>
              </div>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}


