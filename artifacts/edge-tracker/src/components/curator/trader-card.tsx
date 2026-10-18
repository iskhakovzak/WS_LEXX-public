import * as React from "react";
import { Link } from "wouter";
import { ArrowRight, NotebookPen } from "lucide-react";
import { LimitBar, Pill, Sparkline, StatusDot, toneText } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PatternBrief, TraderSignal } from "./api";
import { actionTone, disciplineTone, riskTone, worstUsage } from "./curator-math";
import { fmtDate, fmtUsd } from "@/lib/format";
import { curatorI18n } from "@/i18n/ns/curator";
import { personName } from "@/i18n";

/** One trader in «Мои трейдеры»: trend, discipline, risk usage, patterns, last review, stage and the next action. */
export function TraderCard({ s, onOpen, showPatterns, patterns, patternsLoading = false, title }: {
  s: TraderSignal;
  onOpen: (tab?: string) => void;
  showPatterns: boolean;
  /** Top patterns from the batch request (useTopPatterns) — one request for the whole grid, not one per card. */
  patterns?: PatternBrief[] | null;
  patternsLoading?: boolean;
  /** Optional rendered name (e.g. with search highlight). */
  title?: React.ReactNode;
}) {
  const usage = worstUsage(s);
  const weeks = s.trend.map((w) => w.net);
  const fourWeekNet = s.trend.reduce((a, w) => a + (w.net ?? 0), 0);
  const hasTrend = s.trend.some((w) => w.trades > 0);
  const lastReview = [s.eod.lastReviewedAt, s.weekly.lastReviewedAt].filter((v): v is string => !!v).sort().pop() ?? null;
  const tone = actionTone(s.nextAction.kind);
  const { t } = curatorI18n.useT();
  const stageLine = [s.stage.label ?? t("card.stageNotSet"), s.tierName ? t("card.tierIs", { name: s.tierName }) : null, s.lastTradeDate ? t("card.lastTrade", { date: fmtDate(s.lastTradeDate, "dayMonth") }) : null].filter(Boolean).join(" · ");

  return (
    <article
      className={cn(
        "glass-panel flex min-w-0 flex-col gap-3 rounded-2xl p-[var(--panel-p)]",
        tone === "down" && "ring-1 ring-down/30",
      )}
    >
      <header className="flex min-w-0 items-start gap-2">
        <button type="button" onClick={() => onOpen()} className="min-w-0 flex-1 text-left">
          <span className="block truncate text-base font-semibold text-foreground hover:text-primary" title={s.nameLatin && s.nameLatin !== personName(s.trader) ? `${personName(s.trader)} · ${s.nameLatin}` : personName(s.trader)}>{title ?? personName(s.trader)}</span>
          <span className="block truncate text-xs text-muted-foreground" title={stageLine}>
            {stageLine}
          </span>
        </button>
        <Pill tone={riskTone(s.risk.state)} dot>{s.risk.hasLimits ? s.risk.label : t("noLimits")}</Pill>
      </header>

      <div className="grid grid-cols-3 gap-2">
        <Metric label={t("card.fourWeeks")} title={t("card.fourWeeksTitle")}>
          <div className="flex flex-wrap items-end justify-between gap-x-1">
            <span className={cn("whitespace-nowrap text-sm font-semibold tabular-nums", !hasTrend ? "text-muted-foreground" : fourWeekNet > 0 ? "text-up" : fourWeekNet < 0 ? "text-down" : "text-foreground")}>
              {hasTrend ? fmtUsd(fourWeekNet, { signed: true, decimals: 0 }) : "—"}
            </span>
            <Sparkline data={weeks} width={56} height={20} baseline={0} ariaLabel={t("card.trendAria", { trend: curatorI18n.tryT(`card.trend.${s.trendDir}`) ?? s.trendDir })} />
          </div>
        </Metric>
        <Metric label={t("card.discipline")} title={t("card.disciplineTitle")}>
          <span className={cn("text-sm font-semibold tabular-nums", s.discipline.value == null ? "text-muted-foreground" : toneText(disciplineTone(s.discipline.value)))}>
            {s.discipline.value != null ? s.discipline.value.toFixed(1) : "—"}
          </span>
          <span className="text-2xs text-muted-foreground">{s.discipline.n ? t("card.grades", { count: s.discipline.n }) : t("card.noGrades")}</span>
        </Metric>
        <Metric label={t("card.today")} title={t("card.todayTitle")}>
          <span className={cn("text-sm font-semibold tabular-nums", (s.risk.todayPnl ?? 0) > 0 ? "text-up" : (s.risk.todayPnl ?? 0) < 0 ? "text-down" : "text-foreground")}>
            {s.risk.todayTrades ? fmtUsd(s.risk.todayPnl, { signed: true, decimals: 0 }) : "—"}
          </span>
          <span className="text-2xs tabular-nums text-muted-foreground">{t("tradesShort", { count: s.risk.todayTrades })}{s.risk.openPositions ? ` · ${t("openShort", { count: s.risk.openPositions })}` : ""}</span>
        </Metric>
      </div>

      {s.risk.hasLimits ? (
        <LimitBar
          size="sm"
          used={usage ?? 0}
          limit={100}
          warnAt={0.7}
          showValues={false}
          label={t("card.limitsLabel")}
          hint={usage != null ? t("card.limitsHint", { max: `${Math.round(usage)}%`, daily: pctOr(s.risk.dailyPct), weekly: pctOr(s.risk.weeklyPct), dd: pctOr(s.risk.drawdownPct) }) : t("card.noData")}
        />
      ) : (
        <p className="rounded-lg bg-warn/10 px-2.5 py-1.5 text-xs text-warn">{t("card.noLimitsWarn")}</p>
      )}

      {showPatterns && <PatternsLine patterns={patterns} loading={patternsLoading} />}

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{t("card.lastReview")}</dt>
        <dd className="truncate text-right tabular-nums text-foreground">{lastReview ? fmtDate(lastReview.slice(0, 10), "dayMonth") : t("never")}</dd>
        <dt className="text-muted-foreground">{t("card.queueBreaches")}</dt>
        <dd className="text-right tabular-nums text-foreground">
          {s.eod.pending + (s.weekly.submittedPending ? 1 : 0) + s.academy.pendingSubmissions} / {s.breaches.unreviewed ? <span className="text-down">{t("card.unreviewed", { count: s.breaches.unreviewed })}</span> : s.breaches.last30}
        </dd>
        <dt className="text-muted-foreground">1:1</dt>
        <dd className={cn("text-right tabular-nums", (s.academy.daysSinceOneOnOne ?? 99) > 14 ? "text-warn" : "text-foreground")}>
          {s.academy.lastOneOnOne ? t("card.daysAgo", { count: s.academy.daysSinceOneOnOne ?? 0 }) : t("never")}
          {s.academy.overdueActions ? <span className="text-down">{t("card.overdue", { count: s.academy.overdueActions })}</span> : null}
        </dd>
      </dl>

      {s.lastNote && (
        <button type="button" onClick={() => onOpen("notes")} className="tile flex min-w-0 items-start gap-2 p-2 text-left text-xs">
          <NotebookPen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="line-clamp-2 min-w-0 text-muted-foreground"><span className="font-medium text-foreground">{personName(s.lastNote.author)}:</span> {s.lastNote.body}</span>
        </button>
      )}

      {/* Next step on its own line (it was truncated next to the buttons); buttons stay bottom-right on every card. */}
      <footer className="mt-auto flex min-w-0 flex-wrap items-center gap-2 border-t border-[var(--glass-border)] pt-3">
        <StatusDot tone={tone} className="min-w-0 basis-full"><span className="line-clamp-2 text-sm text-foreground" title={s.nextAction.label}>{s.nextAction.label}</span></StatusDot>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {s.nextAction.kind !== "none" && (
            <Button asChild size="sm" variant="ghost">
              <Link href={s.nextAction.href}>{t("goTo")} <ArrowRight className="h-3.5 w-3.5" /></Link>
            </Button>
          )}
          <Button type="button" size="sm" variant="outline" onClick={() => onOpen()}>{t("profileLink")}</Button>
        </span>
      </footer>
    </article>
  );
}

function pctOr(v: number | null) {
  return v == null ? "—" : `${Math.round(v)}%`;
}

function Metric({ label, title, children }: { label: React.ReactNode; title?: string; children: React.ReactNode }) {
  return (
    <div className="tile flex min-w-0 flex-col gap-0.5 p-2" title={title}>
      <span className="truncate text-2xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

const SEVERITY_TONE: Record<string, "down" | "warn" | "neutral"> = { high: "down", medium: "warn", low: "neutral" };

/** Top behaviour patterns (costliest first, last 4 weeks) — data comes from one batch request for all cards. */
function PatternsLine({ patterns, loading }: { patterns?: PatternBrief[] | null; loading: boolean }) {
  const top = (patterns ?? []).slice(0, 2);
  if (loading) return <div className="skeleton h-5 w-2/3" aria-hidden="true" />;
  if (!top.length) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="text-2xs text-muted-foreground">{curatorI18n.t("card.patterns")}</span>
      {top.map((p) => (
        <Pill key={p.key} tone={SEVERITY_TONE[p.severity ?? ""] ?? "neutral"} title={p.cost != null ? curatorI18n.t("card.patternCost", { amount: fmtUsd(p.cost, { signed: true, decimals: 0 }) }) : undefined}>
          {p.title} · {p.n}
        </Pill>
      ))}
    </div>
  );
}
