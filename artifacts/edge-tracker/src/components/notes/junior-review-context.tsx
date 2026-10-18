
import { Link } from "wouter";
import { ArrowDownRight, ArrowUpRight, Crosshair, History, LineChart, Lock, Minus, Repeat, TrendingUp } from "lucide-react";
import { Pill, toneOf, toneText } from "@/components/ds";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { fmtDate, fmtNum, fmtR, fmtUsd } from "@/lib/format";
import { type ContextTrade, type ReviewContext, type ScoreTrend } from "./junior-lib";
import { ScoreStars } from "./junior-ui";
import { notesI18n } from "@/i18n/ns/notes";
import { commonI18n } from "@/i18n/ns/common";
import { personName } from "@/i18n";

const hLabel = (h: string) =>
  h === "intraday" || h === "overnight" || h === "swing" ? commonI18n.t(`trading.${h}`).toLowerCase() : h;

/** Last N curator scores as small bars (oldest → newest). Read-only, announced as a list of numbers. */
export function ScoreTrail({ scores, className }: { scores: ScoreTrend["scores"]; className?: string }) {
  if (!scores.length) return null;
  return (
    <span
      role="img"
      aria-label={notesI18n.t("junior.review.lastScores", { list: scores.map((s) => s.score).join(", ") })}
      className={cn("inline-flex h-5 items-end gap-0.5", className)}
    >
      {scores.map((s) => (
        <span
          key={s.date}
          title={`${fmtDate(s.date, "dayMonth")}: ${s.score}`}
          className={cn(
            "w-1.5 rounded-sm",
            s.score >= 4 ? "bg-up/80" : s.score === 3 ? "bg-[hsl(var(--chart-3))]/80" : "bg-down/80",
          )}
          style={{ height: `${20 + s.score * 16}%` }}
        />
      ))}
    </span>
  );
}

export function TrendArrow({ trend }: { trend: Pick<ScoreTrend, "direction" | "delta"> }) {
  if (!trend.direction) return null;
  const Icon = trend.direction === "up" ? ArrowUpRight : trend.direction === "down" ? ArrowDownRight : Minus;
  const label = notesI18n.t(trend.direction === "up" ? "junior.review.trendUp" : trend.direction === "down" ? "junior.review.trendDown" : "junior.review.trendFlat");
  return (
    <span
      className={cn("inline-flex items-center text-xs", trend.direction === "up" ? "text-up" : trend.direction === "down" ? "text-down" : "text-muted-foreground")}
      title={`${label}${trend.delta != null ? ` (${fmtNum(trend.delta, { decimals: 1, signed: true })})` : ""}`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * «Фокус на вчера» — what the junior promised in the previous summary, shown above today's note so the senior
 * checks follow-through first.
 */
export function PrevFocusCard({ ctx, isLoading }: { ctx: ReviewContext | undefined; isLoading: boolean }) {
  const { t } = notesI18n.useT();
  if (isLoading) return <Skeleton className="h-20 w-full rounded-xl" />;
  if (!ctx) return null;
  const p = ctx.prev;
  if (!p) {
    return (
      <p className="rounded-xl border border-dashed border-[var(--field-border)] px-4 py-3 text-sm text-muted-foreground">
        {t("junior.review.firstNote")}
      </p>
    );
  }
  return (
    <section aria-label={t("junior.review.prevFocusAria")} className="rounded-xl border border-primary/30 bg-primary/5 px-4 py-3">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <Crosshair className="h-4 w-4 text-primary" aria-hidden="true" />
        <h3 className="text-sm font-semibold">{t("junior.review.prevFocusTitle")}</h3>
        <span className="text-xs text-muted-foreground">{t("junior.review.fromNote", { date: fmtDate(p.note_date, "dayMonth") })}</span>
      </div>
      {p.focus ? (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{p.focus}</p>
      ) : (
        <p className="text-sm text-muted-foreground">{t("junior.review.noFocus")}</p>
      )}
      {p.mistakes && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">{t("junior.review.prevMistakes")}</summary>
          <p className="mt-1 whitespace-pre-wrap text-sm text-foreground/80">{p.mistakes}</p>
        </details>
      )}
    </section>
  );
}

/** Right rail of the review sheet: day trades (R; $ only when allowed), score trend, repeated mistakes, recent answers. */
export function ReviewContextRail({
  ctx,
  isLoading,
  isError,
  className,
}: {
  ctx: ReviewContext | undefined;
  isLoading: boolean;
  isError: boolean;
  className?: string;
}) {
  const { t } = notesI18n.useT();
  if (isLoading) {
    return (
      <div className={cn("space-y-3", className)} aria-busy="true">
        <Skeleton className="h-28 w-full rounded-xl" />
        <Skeleton className="h-20 w-full rounded-xl" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    );
  }
  if (isError || !ctx) {
    return <p className={cn("text-sm text-muted-foreground", className)}>{t("junior.review.contextFailed")}</p>;
  }
  const { trades, trend, repeated, recent_feedback } = ctx;
  const money = trades.money_visible;
  return (
    <div className={cn("space-y-4", className)}>
      <section aria-label={t("dayTrades")} className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <LineChart className="h-4 w-4 text-primary" aria-hidden="true" />{t("dayTrades")}
          </h3>
          {!money && (
            <Pill tone="neutral" title={t("junior.review.onlyRTitle")}>
              <Lock className="h-3 w-3" aria-hidden="true" />{t("junior.review.onlyR")}
            </Pill>
          )}
        </div>
        <div className={cn("grid gap-2", money ? "grid-cols-3" : "grid-cols-2")}>
          <Tile label={t("tradesCount")} value={trades.totals.count ? `${trades.totals.count} · ${trades.totals.wins}/${trades.totals.losses}` : "0"} hint={t("junior.review.winLossHint")} />
          <Tile label={t("totalR")} value={trades.totals.r == null ? "—" : fmtR(trades.totals.r, 1)} tone={toneText(toneOf(trades.totals.r))} />
          {money && (
            <Tile label={t("junior.day.pnlNet")} value={trades.totals.pnl_net == null ? "—" : fmtUsd(trades.totals.pnl_net, { signed: true, decimals: 0 })} tone={toneText(toneOf(trades.totals.pnl_net))} />
          )}
        </div>
        {trades.opened.length === 0 && trades.carried.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("junior.review.noTrades")}</p>
        ) : (
          <ul className="space-y-0.5">
            {trades.opened.map((t) => <TradeLine key={t.id} t={t} money={money} />)}
            {trades.carried.map((t) => <TradeLine key={t.id} t={t} money={money} carried />)}
          </ul>
        )}
      </section>

      <section aria-label={t("junior.review.scoresAria")} className="space-y-1.5">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <TrendingUp className="h-4 w-4 text-primary" aria-hidden="true" />{t("junior.review.scores")}
        </h3>
        {trend.scores.length ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <ScoreTrail scores={trend.scores} />
            <span>{t("junior.review.avg")} <span className="font-medium tabular-nums text-foreground">{fmtNum(trend.avg, 1)}</span></span>
            {trend.recent != null && <span>{t("junior.review.last3")} <span className="tabular-nums text-foreground">{fmtNum(trend.recent, 1)}</span></span>}
            <TrendArrow trend={trend} />
            {ctx.streak > 1 && <span>{t("junior.review.streakDays", { count: ctx.streak })}</span>}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{t("junior.review.noScores")}</p>
        )}
      </section>

      {repeated.length > 0 && (
        <section aria-label={t("junior.review.repeatedAria")} className="space-y-1.5">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <Repeat className="h-4 w-4 text-[hsl(var(--chart-3))]" aria-hidden="true" />{t("junior.review.repeated")}
          </h3>
          <ul className="flex flex-wrap gap-1.5">
            {repeated.map((m) => (
              <li key={m.key}>
                <Pill tone={m.count >= 3 ? "warn" : "neutral"} title={t("junior.review.lastTime", { date: fmtDate(m.last, "dayMonth") })}>
                  {m.label} ×{m.count}
                </Pill>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-muted-foreground">{t("junior.review.repeatedHint")}</p>
        </section>
      )}

      {recent_feedback.length > 0 && (
        <section aria-label={t("junior.review.pastAria")} className="space-y-1.5">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <History className="h-4 w-4 text-primary" aria-hidden="true" />{t("junior.review.past")}
          </h3>
          <ul className="space-y-2">
            {recent_feedback.map((f) => (
              <li key={f.note_date} className="rounded-lg bg-[var(--glass-bg)] px-3 py-2">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="tabular-nums">{fmtDate(f.note_date, "dayMonth")}</span>
                  {f.reviewed_by && <span>· {personName(f.reviewed_by)}</span>}
                  <ScoreStars score={f.score} className="ml-auto" />
                </div>
                {f.feedback && <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-sm text-foreground/85">{f.feedback}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Tile({ label, value, tone, hint }: { label: string; value: string; tone?: string; hint?: string }) {
  return (
    <div className="rounded-xl bg-[var(--glass-bg)] px-3 py-2" title={hint}>
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className={cn("truncate text-base font-semibold tabular-nums", tone)}>{value}</div>
    </div>
  );
}

function TradeLine({ t, money, carried }: { t: ContextTrade; money: boolean; carried?: boolean }) {
  const body = (
    <>
        <span className="font-semibold">{t.ticker}</span>
        {t.side && <span className="text-xs text-muted-foreground">{t.side}</span>}
        {t.setup && <span className="hidden truncate text-xs text-muted-foreground sm:inline">{t.setup}</span>}
        {(carried || t.horizon !== "intraday") && (
          <Pill tone="purple">{carried ? notesI18n.t("junior.review.horizonSince", { horizon: hLabel(t.horizon), date: fmtDate(t.date, "dayMonth") }) : hLabel(t.horizon)}</Pill>
        )}
        <span className="ml-auto flex items-center gap-2 tabular-nums">
          {t.r != null ? (
            <span className={toneText(toneOf(t.r))}>{fmtR(t.r, 1)}</span>
          ) : (
            <span className="text-xs text-muted-foreground">{t.result === "open" ? notesI18n.t("resultLower.open") : "—"}</span>
          )}
          {money && t.pnl_net != null && <span className={cn("text-xs", toneText(toneOf(t.pnl_net)))}>{fmtUsd(t.pnl_net, { signed: true, decimals: 0 })}</span>}
        </span>
    </>
  );
  const cls = "flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm";
  // The trades book opens another trader's trade only for staff — a mentor-trader gets a plain row.
  return (
    <li>
      {money ? (
        <Link
          href={`/trades?highlight=${t.id}`}
          className={cn(cls, "hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}
        >
          {body}
        </Link>
      ) : (
        <div className={cls}>{body}</div>
      )}
    </li>
  );
}
