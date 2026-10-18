/**
 * Общие куски UI «Академии» (когорты / наставничество): время (локальное + Нью-Йорк), пилюли ступени / статуса /
 * посещаемости, карточка цели ИПР, сводка посещаемости, выбор пользователя, перевод с узлами (withNodes).
 */
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { ExternalLink, MapPin, Video } from "lucide-react";
import { Pill, ProgressRing, StatRow, type Tone } from "@/components/ds";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/auth-context";
import { cn } from "@/lib/utils";
import { fmtDate, fmtPct, fmtRate, fmtUsd } from "@/lib/format";
import { academyCohortsI18n } from "@/i18n/ns/academyCohorts";
import { commonI18n } from "@/i18n/ns/common";
import { comparePersonNames, personName } from "@/i18n";
import {
  type AttendanceStatus, type AttendanceSummary, type EnrollmentStatus, type Goal, type GoalStatus, type SessionMode, type Stage,
  attendanceLabel, goalStatusLabel, modeLabel, stageLabel, statusLabel,
} from "./api";
import { PersonSelect } from "@/components/people/person-select";

export const NY_TZ = "America/New_York";
export const LOCAL_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || NY_TZ; } catch { return NY_TZ; } })();
export const SAME_TZ = LOCAL_TZ === NY_TZ;

export const timeIn = (iso: string | Date, tz: string) => fmtDate(iso, "time", { timeZone: tz });
export const dayIn = (iso: string | Date, tz: string) => fmtDate(iso, "weekdayDayMonth", { timeZone: tz });
export const dateTimeLocal = (iso: string | Date | null | undefined) => (iso ? fmtDate(iso, "dateTime", { timeZone: LOCAL_TZ }) : "—");
export function fmtYmd(ymd: string | null | undefined, withYear = false): string {
  if (!ymd) return "—";
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return fmtDate(ymd, withYear ? "medium" : "dayMonth");
}

/** Время занятия: локальное время зрителя + Нью-Йорк (если зоны различаются). */
export function DualTime({ start, end, showDay = false, className }: { start: string; end?: string; showDay?: boolean; className?: string }) {
  const { t } = academyCohortsI18n.useT();
  const local = `${timeIn(start, LOCAL_TZ)}${end ? `–${timeIn(end, LOCAL_TZ)}` : ""}`;
  const ny = `${timeIn(start, NY_TZ)}${end ? `–${timeIn(end, NY_TZ)}` : ""}`;
  return (
    <span className={cn("inline-flex flex-wrap items-baseline gap-x-2 tabular-nums", className)}>
      {showDay && <span className="text-muted-foreground">{dayIn(start, LOCAL_TZ)}</span>}
      <span className="font-medium text-foreground" title={t("shared.yourTime", { tz: LOCAL_TZ })}>{local}</span>
      {!SAME_TZ && <span className="text-xs text-muted-foreground" title={t("shared.nyTime")}>NY {ny}</span>}
    </span>
  );
}

/** Обратный отсчёт до момента (с поправкой на часы сервера). */
export function useNow(serverNow?: string, tickMs = 15_000): number {
  const [skew, setSkew] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (serverNow) setSkew(new Date(serverNow).getTime() - Date.now()); }, [serverNow]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), tickMs); return () => clearInterval(t); }, [tickMs]);
  return now + skew;
}

/** Short duration for countdowns: «5 мин», «2 ч 30 мин», «3 дн.» (minute precision, unlike fmtRelative). */
export function durationShort(minutes: number): string {
  const abs = Math.abs(Math.round(minutes));
  const ct = commonI18n.t;
  if (abs < 60) return ct("time.minutesShort", { count: abs });
  if (abs < 1440) return abs % 60 ? ct("time.hoursMinutesShort", { h: Math.floor(abs / 60), m: abs % 60 }) : ct("time.hoursShort", { count: abs / 60 });
  return ct("time.daysShort", { count: Math.round(abs / 1440) });
}
/** «через 5 мин» / «5 мин назад». */
export function relMinutes(targetMs: number, nowMs: number): string {
  const m = Math.round((targetMs - nowMs) / 60000);
  const time = durationShort(m);
  return m >= 0 ? academyCohortsI18n.t("rel.in", { time }) : academyCohortsI18n.t("rel.ago", { time });
}

/**
 * A translated sentence with React nodes inside: pass the node params as `{name}` markers, then fill them here.
 *   withNodes(t("goals.source", { trades: "{trades}", journal: "{journal}" }), { trades: <Link…/>, journal: <Link…/> })
 */
export function withNodes(text: string, nodes: Record<string, ReactNode>): ReactNode {
  return text.split(/(\{\w+\})/).map((part, i) => {
    const m = /^\{(\w+)\}$/.exec(part);
    return <Fragment key={i}>{m && m[1] in nodes ? nodes[m[1]] : part}</Fragment>;
  });
}

const STAGE_TONE: Record<Stage, Tone> = { trainee: "neutral", junior: "accent", trader: "purple", senior: "up" };
export function StagePill({ stage }: { stage: Stage }) {
  return <Pill tone={STAGE_TONE[stage] ?? "neutral"}>{stageLabel(stage)}</Pill>;
}
const STATUS_TONE: Record<EnrollmentStatus, Tone> = { active: "up", paused: "warn", graduated: "accent", dropped: "down" };
export function StatusPill({ status }: { status: EnrollmentStatus }) {
  return <Pill tone={STATUS_TONE[status] ?? "neutral"} dot>{statusLabel(status)}</Pill>;
}
export const ATT_TONE: Record<AttendanceStatus, Tone> = { present: "up", late: "warn", absent: "down", excused: "neutral" };
export function AttendancePill({ status, self }: { status: AttendanceStatus | null | undefined; self?: boolean }) {
  const { t } = academyCohortsI18n.useT();
  if (!status) return <Pill tone="neutral">{t("shared.notMarked")}</Pill>;
  const label = attendanceLabel(status);
  return <Pill tone={ATT_TONE[status]} title={self ? t("shared.selfMark") : t("shared.mentorMark")}>{self ? t("shared.selfSuffix", { label }) : label}</Pill>;
}
const GOAL_TONE: Record<GoalStatus, Tone> = { active: "accent", achieved: "up", missed: "down", cancelled: "neutral" };
export function GoalStatusPill({ status }: { status: GoalStatus }) {
  return <Pill tone={GOAL_TONE[status] ?? "neutral"}>{goalStatusLabel(status)}</Pill>;
}

/** Место / ссылка занятия. Ссылка открывается в новой вкладке (rel=noopener). */
export function WhereLine({ mode, room, meetingUrl }: { mode: SessionMode | string; room: string | null; meetingUrl: string | null }) {
  const { t } = academyCohortsI18n.useT();
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span>{modeLabel(mode)}</span>
      {room && <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" aria-hidden="true" />{room}</span>}
      {meetingUrl && (
        <a href={meetingUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
          <Video className="h-3 w-3" aria-hidden="true" />{t("shared.link")}<ExternalLink className="h-3 w-3" aria-hidden="true" />
          <span className="sr-only">{t("shared.newTab")}</span>
        </a>
      )}
    </span>
  );
}

export function fmtGoalValue(v: number | null, unit: string): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (unit === "%") return fmtPct(v, { decimals: 1, signed: false });
  if (unit === "$") return fmtUsd(v, { decimals: 0 });
  return `${Math.round(v * 10) / 10}${unit ? ` ${unit}` : ""}`;
}

/** Карточка цели ИПР: кольцо прогресса, формула, текущее значение, окно, срок. */
export function GoalCard({ goal, actions, compact }: { goal: Goal; actions?: React.ReactNode; compact?: boolean }) {
  const { t } = academyCohortsI18n.useT();
  const p = Math.round(goal.eval.progress * 100);
  const tone: Tone = goal.status === "achieved" ? "up" : goal.status === "missed" ? "down" : goal.eval.met ? "up" : p >= 70 ? "accent" : "warn";
  return (
    <article className="glass-field flex gap-3 rounded-xl p-3" aria-label={t("shared.goalAria", { title: goal.title })}>
      <ProgressRing value={p} max={100} size={compact ? 40 : 48} tone={tone} ariaLabel={t("shared.progressAria", { value: p })} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate text-sm font-semibold text-foreground" title={goal.title}>{goal.title}</h3>
          <GoalStatusPill status={goal.status} />
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{goal.formula}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums">
          {goal.metric !== "manual" && (
            <span>{t("shared.goalNow")} <b className={cn("font-semibold", goal.eval.met ? "text-up" : "text-foreground")}>{fmtGoalValue(goal.eval.value, goal.unit)}</b></span>
          )}
          {goal.eval.required != null && goal.metric !== "manual" && (
            <span className="text-muted-foreground">{t("shared.goalSample", { sample: goal.eval.sample, required: goal.eval.required })}</span>
          )}
          {goal.dueOn && <span className="text-muted-foreground">{t("shared.due", { date: fmtYmd(goal.dueOn) })}</span>}
        </div>
        {!compact && goal.eval.detail && <p className="mt-1 text-xs text-muted-foreground">{goal.eval.detail}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-col items-end gap-1">{actions}</div>}
    </article>
  );
}

/** Сводка посещаемости. */
export function AttendanceSummaryView({ s, title }: { s: AttendanceSummary | null | undefined; title?: string }) {
  const { t } = academyCohortsI18n.useT();
  if (!s || s.total === 0) return <p className="text-sm text-muted-foreground">{title ? t("shared.noPastSessionsFor", { title }) : t("shared.noPastSessions")}</p>;
  const tone: Tone = s.rate == null ? "neutral" : s.rate >= 0.9 ? "up" : s.rate >= 0.75 ? "warn" : "down";
  return (
    <div>
      {title && <p className="mb-1 text-xs font-medium text-muted-foreground">{title}</p>}
      <StatRow label={t("shared.attendance")} value={fmtRate(s.rate)} tone={tone} />
      <StatRow label={t("shared.punctuality")} value={fmtRate(s.punctuality)} />
      <StatRow label={t("shared.presentLateAbsent")} value={`${s.present} / ${s.late} / ${s.absent}`} />
      <StatRow label={t("shared.excusedUnmarked")} value={`${s.excused} / ${s.unmarked}`} />
      {s.absentStreak > 1 && <StatRow label={t("shared.absentStreak")} value={s.absentStreak} tone="down" />}
    </div>
  );
}

/** Выбор существующего пользователя (таблица users только читается). */
export function UserSelect({
  id, label, value, onChange, exclude = [], allowNone, noneLabel, disabled,
}: {
  id: string; label: string; value: string | null; onChange: (v: string | null) => void; exclude?: string[]; allowNone?: boolean; noneLabel?: string; disabled?: boolean;
}) {
  const { dbUsers } = useAuth();
  const { t } = academyCohortsI18n.useT();
  const NONE = "__none__";
  const users = dbUsers.filter((u) => u.active !== false && !u.banned && !exclude.includes(u.name));
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <PersonSelect
        id={id}
        value={value ?? (allowNone ? NONE : "")}
        onValueChange={(v) => onChange(v === NONE || !v ? null : v)}
        disabled={disabled}
        allValue={NONE}
        allLabel={allowNone ? noneLabel ?? t("shared.noUser") : undefined}
        options={users.map((u) => u.name).sort(comparePersonNames).map((n) => ({ value: n, label: personName(n) }))}
        placeholder={t("shared.pickUser")}
        ariaLabel={label}
      />
    </div>
  );
}

/** Подпись + поле. */
export function Field({ id, label, hint, children, className }: { id?: string; label: string; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return <p role="alert" className="rounded-lg border border-down/30 bg-down/10 px-3 py-2 text-sm text-down">{msg}</p>;
}
