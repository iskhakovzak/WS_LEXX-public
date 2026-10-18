/** Shared visual pieces of «Путь трейдера» and «Экзамены». */
import * as React from "react";
import { ArrowDownRight, ArrowRight, ArrowUpRight, Check, CircleDashed, Lock, X } from "lucide-react";
import { Pill, type Tone } from "@/components/ds";
import { cn } from "@/lib/utils";
import {
  type ChallengeStatus, type CriterionResult, type DrawdownMode, type EventKind, type RuleProgress, type RuleState, type StageKey, type StageMeta, type TimelineDay, type Trend,
} from "./api";
import { fmtDate, fmtUsd } from "@/lib/format";
import { academyPathI18n } from "@/i18n/ns/academyPath";
import {
  challengeStatusLabel, criterionLabel, fmtPromo, fmtPromoTarget, metricHint, noteText, ruleLabel, ruleStateLabel, stageDescription, stageTitle, windowLabel,
} from "./labels";

// ─── ladder ─────────────────────────────────────────────────────────────────

/** Horizontal 4-step ladder: done / current / next / locked. Reads as an ordered list for screen readers. */
export function StageLadder({ stages, current, readyFor, counts }: {
  stages: StageMeta[];
  current: StageKey | null;
  /** Next stage key when every criterion passes (highlights the arrow). */
  readyFor?: StageKey | null;
  /** Optional people count per stage (staff funnel). */
  counts?: Partial<Record<StageKey, number>>;
}) {
  const { t } = academyPathI18n.useT();
  const idx = current ? stages.findIndex((s) => s.key === current) : -1;
  return (
    <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label={t("stage.ladderAria")}>
      {stages.map((s, i) => {
        const state = idx < 0 ? "locked" : i < idx ? "done" : i === idx ? "current" : i === idx + 1 ? "next" : "locked";
        const Icon = state === "done" ? Check : state === "current" ? CircleDashed : state === "next" ? ArrowRight : Lock;
        const name = stageTitle(s);
        const description = stageDescription(s);
        return (
          <li
            key={s.key}
            aria-current={state === "current" ? "step" : undefined}
            className={cn(
              "relative flex min-w-0 flex-col gap-1 rounded-2xl border p-3",
              state === "current" && "border-primary/60 bg-primary/10",
              state === "done" && "border-up/30 bg-up/5",
              state === "next" && (readyFor === s.key ? "border-up/60 bg-up/10" : "border-[var(--field-border)] bg-[var(--glass-bg)]"),
              state === "locked" && "border-[var(--field-border)] opacity-70",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("stage.step", { n: i + 1 })}</span>
              <Icon className={cn("h-4 w-4", state === "done" && "text-up", state === "current" && "text-primary", state === "next" && "text-muted-foreground", state === "locked" && "text-muted-foreground")} aria-hidden="true" />
            </div>
            <span className="truncate text-base font-semibold text-foreground" title={name}>{name}</span>
            <span className="line-clamp-2 text-xs text-muted-foreground" title={description}>{description}</span>
            <span className="sr-only">
              {t(state === "done" ? "stage.state.done" : state === "current" ? "stage.state.current" : state === "next" ? (readyFor === s.key ? "stage.state.nextReady" : "stage.state.next") : "stage.state.locked")}
            </span>
            {counts && <span className="mt-1 text-xs tabular-nums text-muted-foreground">{t("stage.people", { count: counts[s.key] ?? 0 })}</span>}
          </li>
        );
      })}
    </ol>
  );
}

// ─── criteria ───────────────────────────────────────────────────────────────

/** `prev` = the already formatted value of the previous equal window. */
export function TrendMark({ trend, prev }: { trend: Trend | null; prev: string | null }) {
  const { t } = academyPathI18n.useT();
  if (!trend) return <span className="text-xs text-muted-foreground">—</span>;
  const Icon = trend === "better" ? ArrowUpRight : trend === "worse" ? ArrowDownRight : ArrowRight;
  return (
    <span
      className={cn("inline-flex items-center gap-0.5 whitespace-nowrap text-xs", trend === "better" ? "text-up" : trend === "worse" ? "text-down" : "text-muted-foreground")}
      title={prev != null ? t("trend.prevTitle", { value: prev }) : undefined}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {t(`trend.${trend}`)}
    </span>
  );
}

function Bar({ pct, tone, label }: { pct: number; tone: "up" | "down" | "warn" | "accent" | "muted"; label: string }) {
  const w = Math.max(0, Math.min(1, pct)) * 100;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--glass-bg)]" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(w)}>
      <div
        className={cn("h-full rounded-full transition-[width] motion-reduce:transition-none",
          tone === "up" && "bg-up", tone === "down" && "bg-down", tone === "warn" && "bg-[hsl(var(--chart-3))]", tone === "accent" && "bg-primary", tone === "muted" && "bg-muted-foreground/40")}
        style={{ width: `${w}%` }}
      />
    </div>
  );
}

/**
 * One promotion criterion. `stage` = the stage these criteria belong to (translates seeded labels); `configuredWindow` =
 * the criterion's window from the config (undefined → the server's text); `action` = a link to where it can be improved.
 */
export function CriterionRow({ c, stage, configuredWindow, stageSince, action }: {
  c: CriterionResult; stage: StageKey | null; configuredWindow?: number | null; stageSince: string | null; action?: React.ReactNode;
}) {
  const { t } = academyPathI18n.useT();
  const pass = c.status === "pass", na = c.status === "na";
  const label = criterionLabel(c.label, c.metric, stage);
  const sub = [windowLabel(c, configuredWindow, stageSince), noteText(c.note)].filter(Boolean).join(" · ");
  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          <span className={cn("mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full", pass ? "bg-up/15 text-up" : na ? "bg-[var(--glass-bg)] text-muted-foreground" : "bg-down/15 text-down")}>
            {pass ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : na ? <CircleDashed className="h-3.5 w-3.5" aria-hidden="true" /> : <X className="h-3.5 w-3.5" aria-hidden="true" />}
            <span className="sr-only">{t(`criterion.status.${c.status}`)}</span>
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground" title={metricHint(c.metric, c.hint)}>{label}</p>
            <p className="text-xs text-muted-foreground">{sub}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 text-sm tabular-nums">
          <span className={cn("font-semibold", pass ? "text-up" : na ? "text-muted-foreground" : "text-foreground")}>{fmtPromo(c.unit, c.value)}</span>
          <span className="whitespace-nowrap text-xs text-muted-foreground">{t("criterion.target", { value: fmtPromoTarget(c.unit, c.op, c.target) })}</span>
          <TrendMark trend={c.trend} prev={c.prevValue == null ? null : fmtPromo(c.unit, c.prevValue)} />
        </div>
      </div>
      {!na && <Bar pct={c.progress} tone={pass ? "up" : c.progress >= 0.8 ? "warn" : "down"} label={t("criterion.progressAria", { label, pct: Math.round(c.progress * 100) })} />}
      {(c.advice || action) && (
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 rounded-xl bg-[var(--glass-bg)] px-3 py-2 text-xs text-foreground/90">
          {c.advice && <p className="min-w-0 flex-1"><span className="font-medium">{t("criterion.advice")} </span>{c.advice}</p>}
          {action}
        </div>
      )}
    </li>
  );
}

// ─── challenges ─────────────────────────────────────────────────────────────

export const CH_TONE: Record<ChallengeStatus, Tone> = { scheduled: "neutral", active: "accent", passed: "up", failed: "down", expired: "warn" };
export function ChallengeStatusPill({ status }: { status: ChallengeStatus }) {
  academyPathI18n.useT();
  return <Pill tone={CH_TONE[status]} dot className="shrink-0">{challengeStatusLabel(status)}</Pill>;
}

const RULE_TONE: Record<RuleState, "up" | "down" | "warn" | "accent" | "muted"> = { ok: "up", met: "up", warn: "warn", breached: "down", pending: "accent", na: "muted" };
const RULE_PILL: Record<RuleState, Tone> = { ok: "up", met: "up", warn: "warn", breached: "down", pending: "accent", na: "neutral" };

/** One challenge rule; `mode` = the exam's drawdown mode (shown next to «Макс. просадка»). */
export function RuleBar({ p, mode }: { p: RuleProgress; mode?: DrawdownMode }) {
  academyPathI18n.useT();
  const label = ruleLabel(p.key, mode);
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="font-medium text-foreground">{label}</span>
        <span className="flex items-center gap-2 tabular-nums">
          <span className="text-foreground">{p.display}</span>
          <Pill tone={RULE_PILL[p.state]} className="shrink-0">{ruleStateLabel(p.state)}</Pill>
        </span>
      </div>
      {p.pct != null && <Bar pct={p.pct} tone={RULE_TONE[p.state]} label={`${label}: ${Math.round(p.pct * 100)}%`} />}
      <p className="text-xs text-muted-foreground">{p.detail}</p>
    </li>
  );
}

const EVENT_TONE: Record<EventKind, Tone> = {
  daily_loss: "down", max_dd: "down", size: "down", window: "down", target: "up", passed: "up", warn_daily: "warn", warn_dd: "warn", warn_window: "warn",
};

/** Day-by-day timeline: a mini bar per day (net), cumulative P&L, floor room and events. */
export function ChallengeTimeline({ days, accountSize }: { days: TimelineDay[]; accountSize: number }) {
  const { t } = academyPathI18n.useT();
  const maxAbs = Math.max(1, ...days.map((d) => Math.abs(d.net)));
  if (!days.length) return <p className="text-sm text-muted-foreground">{t("timeline.notStarted")}</p>;
  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <table className="w-full min-w-[640px] text-sm">
        <caption className="sr-only">{t("timeline.caption")}</caption>
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th scope="col" className="py-1.5 pr-3 font-medium">{t("timeline.cols.day")}</th>
            <th scope="col" className="py-1.5 pr-3 text-right font-medium">{t("timeline.cols.trades")}</th>
            <th scope="col" className="py-1.5 pr-3 font-medium">{t("timeline.cols.pnl")}</th>
            <th scope="col" className="py-1.5 pr-3 text-right font-medium">{t("timeline.cols.total")}</th>
            <th scope="col" className="py-1.5 pr-3 text-right font-medium" title={t("timeline.cols.dayLowTitle")}>{t("timeline.cols.dayLow")}</th>
            <th scope="col" className="py-1.5 pr-3 text-right font-medium" title={t("timeline.cols.ddRoomTitle")}>{t("timeline.cols.ddRoom")}</th>
            <th scope="col" className="py-1.5 font-medium">{t("timeline.cols.events")}</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => {
            const bad = d.events.some((e) => EVENT_TONE[e.kind] === "down");
            return (
              <tr key={d.date} className={cn("border-t border-[var(--field-border)] align-top", bad && "bg-down/5")}>
                <th scope="row" className="whitespace-nowrap py-2 pr-3 text-left font-medium text-foreground">{fmtDate(d.date)}</th>
                <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">{d.trades}</td>
                <td className="py-2 pr-3">
                  <div className="flex items-center gap-2">
                    <span className="relative h-2 w-20 overflow-hidden rounded-full bg-[var(--glass-bg)]" aria-hidden="true">
                      <span className="absolute inset-y-0 left-1/2 w-px bg-[var(--field-border)]" />
                      <span
                        className={cn("absolute inset-y-0", d.net >= 0 ? "left-1/2 bg-up" : "right-1/2 bg-down")}
                        style={{ width: `${(Math.abs(d.net) / maxAbs) * 50}%` }}
                      />
                    </span>
                    <span className={cn("tabular-nums", d.net > 0 ? "text-up" : d.net < 0 ? "text-down" : "text-muted-foreground")}>{fmtUsd(d.net, { decimals: 0 })}</span>
                  </div>
                </td>
                <td className={cn("py-2 pr-3 text-right tabular-nums", d.cum > 0 ? "text-up" : d.cum < 0 ? "text-down" : "text-foreground")}>{fmtUsd(d.cum, { decimals: 0 })}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">{fmtUsd(d.dayLow, { decimals: 0 })}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground" title={d.floor != null ? t("timeline.floorTitle", { floor: fmtUsd(d.floor, { decimals: 0 }), account: fmtUsd(accountSize, { decimals: 0 }) }) : undefined}>{d.ddRoom != null ? fmtUsd(d.ddRoom, { decimals: 0 }) : "—"}</td>
                <td className="py-2">
                  <div className="flex flex-wrap gap-1">
                    {d.events.map((e, i) => (
                      <Pill key={i} tone={EVENT_TONE[e.kind]} title={e.label} className="max-w-[320px] truncate">
                        {e.time ? `${e.time} NY · ` : ""}{e.label}
                      </Pill>
                    ))}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export const selectCls = "glass-field h-9 min-w-0 rounded-full px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function Field({ label, htmlFor, children, hint }: { label: string; htmlFor: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
