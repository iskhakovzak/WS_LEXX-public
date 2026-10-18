/**
 * Диалоги «Академии» → когорты и наставничество: когорта, зачисление, ступень/статус, занятие, отметка посещаемости,
 * встреча 1:1 с договорённостями, цель ИПР, договорённость. Все формы — только существующие пользователи.
 */
import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Segmented, Pill } from "@/components/ds";
import { useToast } from "@/hooks/use-toast";
import { academyCohortsI18n } from "@/i18n/ns/academyCohorts";
import { commonI18n } from "@/i18n/ns/common";
import { comparePersonNames, personName } from "@/i18n";
import { fmtWeekday } from "@/lib/format";
import { addDays, nyDate } from "@/lib/trading-date";
import { cn } from "@/lib/utils";
import {
  ATTENDANCE_STATUSES, type AttendanceStatus, COHORT_FORMATS, type Cohort, type CohortFormat, COMPARATOR_SIGNS, type Comparator, type Enrollment,
  ENROLLMENT_STATUSES, type EnrollmentStatus, type MetricDef, type MetricKey, RECURRENCES, type Recurrence, SESSION_KINDS, SESSION_MODES, type Session,
  type SessionKind, type SessionMode, STAGES, type Stage,
  attendanceLabel, attendanceTitle, formatLabel, kindLabel, meetingFormatLabel, modeLabel, recurrenceLabel, stageLabel, statusLabel,
  useCreateAction, useCreateCohort, useCreateGoal, useCreateMeeting, useCreateSession, useEnroll, useMarkAttendance, useMetrics, useRoster,
  useUpdateCohort, useUpdateEnrollment, useUpdateSession,
} from "./api";
import { AttendancePill, DualTime, ErrorNote, Field, LOCAL_TZ, NY_TZ, UserSelect, fmtYmd } from "./shared";
import { PersonSelect } from "@/components/people/person-select";

const TZ_OPTIONS = Array.from(new Set([NY_TZ, "Asia/Tashkent", "Asia/Almaty", "Asia/Bishkek", "Europe/Moscow", "UTC", LOCAL_TZ]));

/** Weekday (0 = Sunday) of a YYYY-MM-DD date. */
const weekdayOf = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay();

function TzSelect({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id}><SelectValue /></SelectTrigger>
      <SelectContent>{TZ_OPTIONS.map((t) => <SelectItem key={t} value={t}>{t === NY_TZ ? `${t} (NY)` : t}</SelectItem>)}</SelectContent>
    </Select>
  );
}

function useSuccess() {
  const { toast } = useToast();
  return (title: string, description?: string) => toast({ title, description });
}

/** Segmented option with the label repeated as a tooltip (EN/UZ labels can be clipped in narrow dialogs). */
const opt = <T extends string>(value: T, label: string) => ({ value, label, title: label });

/* ─── Когорта ─────────────────────────────────────────────────────────────── */

export function CohortDialog({ open, onOpenChange, cohort }: { open: boolean; onOpenChange: (v: boolean) => void; cohort?: Cohort | null }) {
  const { t } = academyCohortsI18n.useT();
  const { t: ct } = commonI18n.useT();
  const create = useCreateCohort();
  const update = useUpdateCohort();
  const ok = useSuccess();
  const [f, setF] = useState({ name: "", format: "office" as CohortFormat, mentor: null as string | null, startsOn: "", endsOn: "", timezone: NY_TZ, description: "", room: "", meetingUrl: "" });
  useEffect(() => {
    if (!open) return;
    create.reset(); update.reset();
    setF(cohort
      ? { name: cohort.name, format: cohort.format, mentor: cohort.mentor, startsOn: cohort.startsOn ?? "", endsOn: cohort.endsOn ?? "", timezone: cohort.timezone, description: cohort.description, room: cohort.room ?? "", meetingUrl: cohort.meetingUrl ?? "" }
      : { name: "", format: "office", mentor: null, startsOn: nyDate(), endsOn: "", timezone: NY_TZ, description: "", room: "", meetingUrl: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cohort?.id]);
  const busy = create.isPending || update.isPending;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const body = {
      name: f.name.trim(), format: f.format, mentor: f.mentor, startsOn: f.startsOn || null, endsOn: f.endsOn || null, timezone: f.timezone,
      description: f.description, room: f.room.trim() || null, meetingUrl: f.meetingUrl.trim() || null,
    };
    const done = () => { ok(cohort ? t("cohortDialog.saved") : t("cohortDialog.created"), body.name); onOpenChange(false); };
    if (cohort) update.mutate({ id: cohort.id, ...body }, { onSuccess: done });
    else create.mutate(body, { onSuccess: done });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{cohort ? t("cohortDialog.editTitle") : t("cohortDialog.newTitle")}</DialogTitle>
            <DialogDescription>{t("cohortDialog.description")}</DialogDescription>
          </DialogHeader>
          <Field id="c-name" label={t("cohortDialog.name")}>
            <Input id="c-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} maxLength={120} placeholder={t("cohortDialog.namePlaceholder")} />
          </Field>
          <Field label={t("cohortDialog.format")}>
            <Segmented ariaLabel={t("cohortDialog.formatAria")} value={f.format} onChange={(v) => setF({ ...f, format: v })}
              options={COHORT_FORMATS.map((k) => opt(k, formatLabel(k)))} />
          </Field>
          <UserSelect id="c-mentor" label={t("cohortDialog.mentor")} value={f.mentor} onChange={(v) => setF({ ...f, mentor: v })} allowNone />
          <div className="grid grid-cols-2 gap-3">
            <Field id="c-start" label={t("cohortDialog.start")}><Input id="c-start" type="date" value={f.startsOn} onChange={(e) => setF({ ...f, startsOn: e.target.value })} /></Field>
            <Field id="c-end" label={t("cohortDialog.end")}><Input id="c-end" type="date" value={f.endsOn} min={f.startsOn || undefined} onChange={(e) => setF({ ...f, endsOn: e.target.value })} /></Field>
          </div>
          <Field id="c-tz" label={t("cohortDialog.timezone")}><TzSelect id="c-tz" value={f.timezone} onChange={(v) => setF({ ...f, timezone: v })} /></Field>
          {f.format !== "remote" && (
            <Field id="c-room" label={t("cohortDialog.room")}><Input id="c-room" value={f.room} onChange={(e) => setF({ ...f, room: e.target.value })} maxLength={200} placeholder={t("cohortDialog.roomPlaceholder")} /></Field>
          )}
          {f.format !== "office" && (
            <Field id="c-url" label={t("cohortDialog.url")} hint={t("cohortDialog.urlHint")}>
              <Input id="c-url" type="url" value={f.meetingUrl} onChange={(e) => setF({ ...f, meetingUrl: e.target.value })} placeholder="https://…" />
            </Field>
          )}
          <Field id="c-desc" label={t("cohortDialog.descriptionLabel")}><Textarea id="c-desc" rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={4000} /></Field>
          <ErrorNote error={create.error ?? update.error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{ct("actions.cancel")}</Button>
            <Button type="submit" disabled={busy || f.name.trim().length < 2}>{busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden="true" />}{ct("actions.save")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Зачисление ──────────────────────────────────────────────────────────── */

export function EnrollDialog({ open, onOpenChange, cohort, existing }: { open: boolean; onOpenChange: (v: boolean) => void; cohort: Cohort; existing: string[] }) {
  const { t } = academyCohortsI18n.useT();
  const { t: ct } = commonI18n.useT();
  const enroll = useEnroll();
  const ok = useSuccess();
  const [user, setUser] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>("trainee");
  const [joinedOn, setJoinedOn] = useState(nyDate());
  const [note, setNote] = useState("");
  useEffect(() => { if (open) { enroll.reset(); setUser(null); setStage("trainee"); setJoinedOn(nyDate()); setNote(""); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open]);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    enroll.mutate({ cohortId: cohort.id, userName: user, stage, joinedOn, note }, { onSuccess: () => { ok(t("enroll.done"), t("enroll.doneDesc", { user: personName(user), cohort: cohort.name })); onOpenChange(false); } });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("enroll.title", { name: cohort.name })}</DialogTitle>
            <DialogDescription>{t("enroll.description")}</DialogDescription>
          </DialogHeader>
          <UserSelect id="en-user" label={t("enroll.user")} value={user} onChange={setUser} exclude={existing} />
          <Field label={t("cols.stage")}>
            <Segmented ariaLabel={t("cols.stage")} value={stage} onChange={setStage} options={STAGES.map((s) => opt(s, stageLabel(s)))} />
          </Field>
          <Field id="en-date" label={t("enroll.date")} hint={t("enroll.dateHint")}>
            <Input id="en-date" type="date" value={joinedOn} onChange={(e) => setJoinedOn(e.target.value)} required />
          </Field>
          <Field id="en-note" label={t("enroll.note")}><Input id="en-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} /></Field>
          <ErrorNote error={enroll.error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{ct("actions.cancel")}</Button>
            <Button type="submit" disabled={!user || enroll.isPending}>{enroll.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden="true" />}{t("enroll.submit")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Смена ступени / статуса (пишется в историю, студент получает уведомление). */
export function EnrollmentEditDialog({ open, onOpenChange, enrollment }: { open: boolean; onOpenChange: (v: boolean) => void; enrollment: Enrollment | null }) {
  const { t } = academyCohortsI18n.useT();
  const { t: ct } = commonI18n.useT();
  const upd = useUpdateEnrollment();
  const ok = useSuccess();
  const [stage, setStage] = useState<Stage>("trainee");
  const [status, setStatus] = useState<EnrollmentStatus>("active");
  const [reason, setReason] = useState("");
  useEffect(() => { if (open && enrollment) { upd.reset(); setStage(enrollment.stage); setStatus(enrollment.status); setReason(""); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open, enrollment?.id]);
  if (!enrollment) return null;
  const changed = stage !== enrollment.stage || status !== enrollment.status;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    upd.mutate({ id: enrollment.id, stage, status, reason: reason.trim() || undefined }, { onSuccess: () => { ok(t("enrollmentEdit.saved"), personName(enrollment.userName)); onOpenChange(false); } });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("enrollmentEdit.title", { name: personName(enrollment.userName) })}</DialogTitle>
            <DialogDescription>{t("enrollmentEdit.description")}</DialogDescription>
          </DialogHeader>
          <Field label={t("cols.stage")}>
            <Segmented ariaLabel={t("cols.stage")} value={stage} onChange={setStage} options={STAGES.map((s) => opt(s, stageLabel(s)))} />
          </Field>
          <Field label={t("cols.status")}>
            <Segmented ariaLabel={t("cols.status")} value={status} onChange={setStatus} size="sm"
              options={ENROLLMENT_STATUSES.map((s) => opt(s, statusLabel(s)))} />
          </Field>
          <Field id="ee-reason" label={t("enrollmentEdit.reason")}>
            <Textarea id="ee-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} placeholder={t("enrollmentEdit.reasonPlaceholder")} />
          </Field>
          <ErrorNote error={upd.error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{ct("actions.cancel")}</Button>
            <Button type="submit" disabled={!changed || upd.isPending}>{ct("actions.save")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Занятие ─────────────────────────────────────────────────────────────── */

export function SessionDialog({ open, onOpenChange, cohort, session }: { open: boolean; onOpenChange: (v: boolean) => void; cohort: Cohort; session?: Session | null }) {
  const { t } = academyCohortsI18n.useT();
  const { t: ct } = commonI18n.useT();
  const create = useCreateSession();
  const update = useUpdateSession();
  const ok = useSuccess();
  // Prefill from the cohort (time zone, place, link, host); weekly days start with the first session's weekday.
  const blank = () => ({
    title: "", kind: "briefing" as SessionKind, recurrence: "weekdays" as Recurrence, weekdays: [weekdayOf(nyDate())] as number[], startDate: nyDate(), endDate: cohort.endsOn ?? "",
    startTime: "09:00", durationMin: 30, timezone: cohort.timezone || NY_TZ,
    mode: (cohort.format === "office" ? "office" : cohort.format === "remote" ? "online" : "hybrid") as SessionMode,
    room: cohort.room ?? "", meetingUrl: cohort.meetingUrl ?? "", host: cohort.mentor, description: "",
  });
  const [f, setF] = useState(blank);
  useEffect(() => {
    if (!open) return;
    create.reset(); update.reset();
    setF(session
      ? { title: session.title, kind: session.kind, recurrence: session.recurrence, weekdays: session.weekdays.length ? session.weekdays : [weekdayOf(session.startDate)], startDate: session.startDate,
          endDate: session.endDate ?? "", startTime: session.startTime, durationMin: session.durationMin, timezone: session.timezone, mode: session.mode,
          room: session.room ?? "", meetingUrl: session.meetingUrl ?? "", host: session.host, description: session.description }
      : blank());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, session?.id]);
  const busy = create.isPending || update.isPending;
  const toggleDay = (d: number) => setF((x) => ({ ...x, weekdays: x.weekdays.includes(d) ? x.weekdays.filter((y) => y !== d) : [...x.weekdays, d].sort() }));
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const body = {
      cohortId: cohort.id, title: f.title.trim(), kind: f.kind, recurrence: f.recurrence, weekdays: f.recurrence === "weekly" ? f.weekdays : [],
      startDate: f.startDate, endDate: f.recurrence === "none" ? null : f.endDate || null, startTime: f.startTime, durationMin: Number(f.durationMin) || 60,
      timezone: f.timezone, mode: f.mode, room: f.mode === "online" ? null : f.room.trim() || null, meetingUrl: f.mode === "office" ? null : f.meetingUrl.trim() || null,
      host: f.host, description: f.description,
    };
    const done = () => { ok(session ? t("sessionDialog.saved") : t("sessionDialog.added"), body.title); onOpenChange(false); };
    if (session) update.mutate({ id: session.id, ...body }, { onSuccess: done });
    else create.mutate(body, { onSuccess: done });
  };
  const weeklyEmpty = f.recurrence === "weekly" && f.weekdays.length === 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{session ? t("sessionDialog.editTitle", { cohort: cohort.name }) : t("sessionDialog.newTitle", { cohort: cohort.name })}</DialogTitle>
            <DialogDescription>{t("sessionDialog.description")}</DialogDescription>
          </DialogHeader>
          <Field id="s-title" label={t("sessionDialog.name")}>
            <Input id="s-title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required minLength={2} maxLength={160} placeholder={t("sessionDialog.namePlaceholder")} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field id="s-kind" label={t("sessionDialog.kind")}>
              <Select value={f.kind} onValueChange={(v) => setF({ ...f, kind: v as SessionKind })}>
                <SelectTrigger id="s-kind"><SelectValue /></SelectTrigger>
                <SelectContent>{SESSION_KINDS.map((k) => <SelectItem key={k} value={k}>{kindLabel(k)}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <UserSelect id="s-host" label={t("sessionDialog.host")} value={f.host} onChange={(v) => setF({ ...f, host: v })} allowNone />
          </div>
          <Field label={t("sessionDialog.recurrence")}>
            <Segmented ariaLabel={t("sessionDialog.recurrence")} value={f.recurrence} onChange={(v) => setF({ ...f, recurrence: v })} size="sm"
              options={RECURRENCES.map((k) => opt(k, recurrenceLabel(k)))} />
          </Field>
          {f.recurrence === "weekly" && (
            <div role="group" aria-label={t("sessionDialog.weekdaysAria")} className="flex flex-wrap gap-1.5">
              {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                <button key={d} type="button" aria-pressed={f.weekdays.includes(d)} onClick={() => toggleDay(d)} title={fmtWeekday(d, "long")} className="chip min-h-8 px-3 text-sm font-medium">
                  {fmtWeekday(d, "short")}
                </button>
              ))}
              {weeklyEmpty && <p className="w-full text-xs text-down">{t("sessionDialog.pickDay")}</p>}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field id="s-start" label={f.recurrence === "none" ? t("sessionDialog.date") : t("sessionDialog.firstSession")}>
              <Input id="s-start" type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} required />
            </Field>
            {f.recurrence !== "none" && (
              <Field id="s-end" label={t("sessionDialog.repeatUntil")}>
                <Input id="s-end" type="date" value={f.endDate} min={f.startDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} />
              </Field>
            )}
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field id="s-time" label={t("sessionDialog.startTime")}><Input id="s-time" type="time" value={f.startTime} onChange={(e) => setF({ ...f, startTime: e.target.value })} required /></Field>
            <Field id="s-dur" label={t("sessionDialog.duration")}>
              <Input id="s-dur" type="number" min={5} max={600} step={5} value={f.durationMin} onChange={(e) => setF({ ...f, durationMin: Number(e.target.value) })} />
            </Field>
            <Field id="s-tz" label={t("sessionDialog.tz")}><TzSelect id="s-tz" value={f.timezone} onChange={(v) => setF({ ...f, timezone: v })} /></Field>
          </div>
          <Field label={t("sessionDialog.where")}>
            <Segmented ariaLabel={t("sessionDialog.modeAria")} value={f.mode} onChange={(v) => setF({ ...f, mode: v })}
              options={SESSION_MODES.map((k) => opt(k, modeLabel(k)))} />
          </Field>
          {f.mode !== "online" && (
            <Field id="s-room" label={t("sessionDialog.room")}><Input id="s-room" value={f.room} onChange={(e) => setF({ ...f, room: e.target.value })} required maxLength={200} /></Field>
          )}
          {f.mode !== "office" && (
            <Field id="s-url" label={t("sessionDialog.url")} hint={t("sessionDialog.urlHint")}>
              <Input id="s-url" type="url" value={f.meetingUrl} onChange={(e) => setF({ ...f, meetingUrl: e.target.value })} required placeholder="https://…" />
            </Field>
          )}
          <Field id="s-desc" label={t("sessionDialog.descriptionLabel")}><Textarea id="s-desc" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={4000} /></Field>
          <ErrorNote error={create.error ?? update.error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{ct("actions.cancel")}</Button>
            <Button type="submit" disabled={busy || weeklyEmpty || f.title.trim().length < 2}>{ct("actions.save")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Отметка посещаемости ────────────────────────────────────────────────── */

export function RosterDialog({ open, onOpenChange, sessionId, date, title }: { open: boolean; onOpenChange: (v: boolean) => void; sessionId: number | null; date: string; title?: string }) {
  const { t } = academyCohortsI18n.useT();
  const { t: ct } = commonI18n.useT();
  const roster = useRoster(open ? sessionId : null, date);
  const mark = useMarkAttendance();
  const ok = useSuccess();
  const [draft, setDraft] = useState<Record<string, AttendanceStatus>>({});
  useEffect(() => { if (open) { setDraft({}); mark.reset(); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open, sessionId, date]);
  const rows = roster.data?.roster ?? [];
  const changes = Object.entries(draft).filter(([u, s]) => rows.find((r) => r.enrollment.userName === u)?.status !== s);
  const started = roster.data ? Date.now() >= new Date(roster.data.occurrence.startUtc).getTime() - 10 * 60000 : true;
  const setAll = (s: AttendanceStatus) => setDraft(Object.fromEntries(rows.filter((r) => !r.status).map((r) => [r.enrollment.userName, s])));
  const save = () => {
    if (!sessionId || !changes.length) return;
    mark.mutate({ sessionId, date, marks: changes.map(([userName, status]) => ({ userName, status })) }, {
      onSuccess: (r) => {
        ok(t("roster.saved"), r.skipped.length ? t("roster.savedDescSkipped", { saved: r.saved, names: r.skipped.map((n) => personName(n)).join(", ") }) : t("roster.savedDesc", { saved: r.saved }));
        onOpenChange(false);
      },
    });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("roster.title", { title: title ?? roster.data?.session.title ?? t("roster.sessionFallback") })}</DialogTitle>
          <DialogDescription>
            {fmtYmd(date, true)}{roster.data && <> · <DualTime start={roster.data.occurrence.startUtc} end={roster.data.occurrence.endUtc} /></>}
            {!started && ` · ${t("roster.notStarted")}`}
          </DialogDescription>
        </DialogHeader>
        {roster.isLoading && <p className="text-sm text-muted-foreground">{t("roster.loading")}</p>}
        <ErrorNote error={roster.error} />
        {rows.length > 0 && (
          <>
            {started && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {t("roster.allUnmarked")}
                <Button type="button" size="sm" variant="outline" onClick={() => setAll("present")}>{attendanceLabel("present")}</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setAll("absent")}>{attendanceLabel("absent")}</Button>
              </div>
            )}
            <ul className="flex flex-col divide-y divide-border/50" aria-label={t("roster.listAria")}>
              {rows.map((r) => {
                const u = r.enrollment.userName;
                const cur = draft[u] ?? r.status;
                return (
                  <li key={u} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <span className="text-sm font-medium text-foreground">{personName(u)}</span>{" "}
                      <span className="text-xs text-muted-foreground">{stageLabel(r.enrollment.stage)}{r.enrollment.status === "paused" ? ` · ${t("roster.paused")}` : ""}</span>
                      {r.source === "self" && <span className="ml-2"><AttendancePill status={r.status} self /></span>}
                    </div>
                    <div role="radiogroup" aria-label={t("roster.markAria", { name: personName(u) })} className="flex flex-wrap gap-1">
                      {ATTENDANCE_STATUSES.map((s) => (
                        <button key={s} type="button" role="radio" aria-checked={cur === s} disabled={!started && s !== "excused"}
                          onClick={() => setDraft((d) => ({ ...d, [u]: s }))} title={attendanceTitle(s)}
                          className={cn("chip min-h-7 px-2.5 text-xs font-medium disabled:opacity-40")} aria-pressed={cur === s}>
                          {attendanceLabel(s)}
                        </button>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {roster.data && rows.length === 0 && <p className="text-sm text-muted-foreground">{t("roster.empty")}</p>}
        <ErrorNote error={mark.error} />
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{ct("actions.close")}</Button>
          <Button type="button" onClick={save} disabled={!changes.length || mark.isPending}>{changes.length ? t("roster.saveCount", { n: changes.length }) : ct("actions.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ─── 1:1 ─────────────────────────────────────────────────────────────────── */

type ActionDraft = { title: string; dueOn: string; owner: "student" | "mentor" };
type MeetingFormat = "office" | "online";

function localDateTimeInput(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Default 1:1 format from the student's cohort: remote → online, office / hybrid → office. */
const formatForCohort = (f: CohortFormat | undefined): MeetingFormat => (f === "remote" ? "online" : "office");

export function MeetingDialog({ open, onOpenChange, students, defaultStudent, mentor }: {
  open: boolean; onOpenChange: (v: boolean) => void; students: { name: string; cohortId: number; cohortFormat?: CohortFormat }[]; defaultStudent?: string | null; mentor: string | null;
}) {
  const { t } = academyCohortsI18n.useT();
  const { t: ct } = commonI18n.useT();
  const create = useCreateMeeting();
  const ok = useSuccess();
  const [student, setStudent] = useState<string | null>(null);
  const [metAt, setMetAt] = useState(localDateTimeInput());
  const [duration, setDuration] = useState(30);
  const [format, setFormat] = useState<MeetingFormat>("office");
  const [agenda, setAgenda] = useState("");
  const [notes, setNotes] = useState("");
  const [privateNotes, setPrivateNotes] = useState("");
  const [items, setItems] = useState<ActionDraft[]>([]);
  const cohortFormatOf = (name: string | null) => students.find((s) => s.name === name)?.cohortFormat;
  const pickStudent = (name: string | null) => { setStudent(name); if (name) setFormat(formatForCohort(cohortFormatOf(name))); };
  useEffect(() => {
    if (!open) return;
    create.reset();
    setStudent(defaultStudent ?? null); setMetAt(localDateTimeInput()); setDuration(30); setFormat(formatForCohort(cohortFormatOf(defaultStudent ?? null)));
    setAgenda(""); setNotes(""); setPrivateNotes(""); setItems([{ title: "", dueOn: addDays(nyDate(), 7), owner: "student" }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultStudent]);
  const names = useMemo(() => [...new Set(students.map((s) => s.name))].sort(comparePersonNames).map((n) => ({ value: n, label: personName(n) })), [students]);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!student) return;
    const cohortId = students.find((s) => s.name === student)?.cohortId ?? null;
    create.mutate({
      student, mentor: mentor ?? undefined, cohortId, metAt: new Date(metAt).toISOString(), durationMin: duration || null, format, agenda, notes, privateNotes,
      actionItems: items.filter((i) => i.title.trim()).map((i) => ({ title: i.title.trim(), dueOn: i.dueOn || null, owner: i.owner })),
    }, { onSuccess: () => { ok(t("meeting.saved"), personName(student)); onOpenChange(false); } });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("meeting.title")}</DialogTitle>
            <DialogDescription>{t("meeting.description")}</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <Field id="m-student" label={t("cols.student")}>
              <PersonSelect id="m-student" value={student ?? ""} onValueChange={pickStudent} options={names} placeholder={t("meeting.pickStudent")} ariaLabel={t("cols.student")} />
            </Field>
            <Field id="m-at" label={t("meeting.when")}><Input id="m-at" type="datetime-local" value={metAt} onChange={(e) => setMetAt(e.target.value)} required /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field id="m-dur" label={t("meeting.duration")}><Input id="m-dur" type="number" min={5} max={480} step={5} value={duration} onChange={(e) => setDuration(Number(e.target.value))} /></Field>
            <Field label={t("meeting.format")}>
              <Segmented ariaLabel={t("meeting.formatAria")} value={format} onChange={setFormat}
                options={[opt<MeetingFormat>("office", meetingFormatLabel("office")), opt<MeetingFormat>("online", meetingFormatLabel("online"))]} />
            </Field>
          </div>
          <Field id="m-agenda" label={t("meeting.agenda")}><Textarea id="m-agenda" rows={2} value={agenda} onChange={(e) => setAgenda(e.target.value)} maxLength={4000} placeholder={t("meeting.agendaPlaceholder")} /></Field>
          <Field id="m-notes" label={t("meeting.notes")}><Textarea id="m-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={8000} /></Field>
          <Field id="m-private" label={t("meeting.privateNotes")}><Textarea id="m-private" rows={2} value={privateNotes} onChange={(e) => setPrivateNotes(e.target.value)} maxLength={8000} /></Field>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">{t("meeting.actions")}</legend>
            {items.map((it, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2 sm:grid-cols-[1fr_9.5rem_8.5rem_auto]">
                <Input className="col-span-3 sm:col-span-1" aria-label={t("meeting.actionAria", { n: i + 1 })} value={it.title} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} placeholder={t("meeting.actionPlaceholder")} maxLength={300} />
                <Input aria-label={t("meeting.due")} type="date" value={it.dueOn} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, dueOn: e.target.value } : x)))} />
                <Select value={it.owner} onValueChange={(v) => setItems(items.map((x, j) => (j === i ? { ...x, owner: v as "student" | "mentor" } : x)))}>
                  <SelectTrigger aria-label={t("meeting.owner")}><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="student">{ct("roles.student")}</SelectItem><SelectItem value="mentor">{ct("roles.mentor")}</SelectItem></SelectContent>
                </Select>
                <Button type="button" size="icon" variant="ghost" aria-label={t("meeting.removeAction")} title={t("meeting.removeAction")} onClick={() => setItems(items.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setItems([...items, { title: "", dueOn: addDays(nyDate(), 7), owner: "student" }])}>
              <Plus className="mr-1 h-4 w-4" aria-hidden="true" />{ct("actions.add")}
            </Button>
          </fieldset>
          <ErrorNote error={create.error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{ct("actions.cancel")}</Button>
            <Button type="submit" disabled={!student || create.isPending}>{t("meeting.submit")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Договорённость ──────────────────────────────────────────────────────── */

export function ActionDialog({ open, onOpenChange, student }: { open: boolean; onOpenChange: (v: boolean) => void; student: string }) {
  const { t } = academyCohortsI18n.useT();
  const { t: ct } = commonI18n.useT();
  const create = useCreateAction();
  const ok = useSuccess();
  const [title, setTitle] = useState("");
  const [dueOn, setDueOn] = useState(addDays(nyDate(), 7));
  const [owner, setOwner] = useState<"student" | "mentor">("student");
  useEffect(() => { if (open) { create.reset(); setTitle(""); setDueOn(addDays(nyDate(), 7)); setOwner("student"); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open]);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    create.mutate({ student, title: title.trim(), dueOn: dueOn || null, owner }, { onSuccess: () => { ok(t("action.added"), personName(student)); onOpenChange(false); } });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader><DialogTitle>{t("action.title", { student: personName(student) })}</DialogTitle><DialogDescription>{t("action.description")}</DialogDescription></DialogHeader>
          <Field id="a-title" label={t("action.what")}><Input id="a-title" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={300} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field id="a-due" label={t("action.due")}><Input id="a-due" type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} /></Field>
            <Field label={t("action.owner")}>
              <Segmented ariaLabel={t("action.owner")} value={owner} onChange={setOwner} size="sm"
                options={[opt<"student" | "mentor">("student", ct("roles.student")), opt<"student" | "mentor">("mentor", ct("roles.mentor"))]} />
            </Field>
          </div>
          <ErrorNote error={create.error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{ct("actions.cancel")}</Button>
            <Button type="submit" disabled={!title.trim() || create.isPending}>{ct("actions.add")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Цель ИПР ────────────────────────────────────────────────────────────── */

function windowLabel(m: MetricDef): string | null {
  if (m.windowKind === "days") return academyCohortsI18n.t("goal.windowDays");
  if (m.windowKind === "trades") return academyCohortsI18n.t("goal.windowTrades");
  return null;
}

export function GoalDialog({ open, onOpenChange, student }: { open: boolean; onOpenChange: (v: boolean) => void; student: string }) {
  const { t } = academyCohortsI18n.useT();
  const { t: ct } = commonI18n.useT();
  const metrics = useMetrics();
  const create = useCreateGoal();
  const ok = useSuccess();
  const list = metrics.data?.metrics ?? [];
  const [metric, setMetric] = useState<MetricKey>("fee_share");
  const def = list.find((m) => m.key === metric);
  const [title, setTitle] = useState("");
  const [comparator, setComparator] = useState<Comparator>("lt");
  const [target, setTarget] = useState(50);
  const [win, setWin] = useState<number | "">(10);
  const [startDate, setStartDate] = useState(nyDate());
  const [dueOn, setDueOn] = useState(addDays(nyDate(), 30));
  const [note, setNote] = useState("");
  const applyDefaults = (m: MetricDef | undefined) => {
    if (!m) return;
    setComparator(m.comparator); setTarget(m.defaultTarget); setWin(m.defaultWindow ?? ""); setTitle(m.key === "manual" ? "" : m.label);
  };
  useEffect(() => { if (open) { create.reset(); setMetric("fee_share"); setStartDate(nyDate()); setDueOn(addDays(nyDate(), 30)); setNote(""); applyDefaults(list.find((m) => m.key === "fee_share")); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open, list.length]);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    create.mutate({
      student, title: title.trim() || def?.label || t("goal.fallbackTitle"), metric, comparator: metric === "manual" ? undefined : comparator, target,
      window: def && windowLabel(def) ? (win === "" ? null : Number(win)) : null, startDate, dueOn: dueOn || null, note,
      manualProgress: metric === "manual" ? 0 : undefined,
    }, { onSuccess: () => { ok(t("goal.added"), personName(student)); onOpenChange(false); } });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("goal.title", { student: personName(student) })}</DialogTitle>
            <DialogDescription>{t("goal.description")}</DialogDescription>
          </DialogHeader>
          <Field label={t("goal.metric")}>
            <div role="radiogroup" aria-label={t("goal.metric")} className="grid grid-cols-2 gap-1.5">
              {list.map((m) => (
                <button key={m.key} type="button" role="radio" aria-checked={metric === m.key} onClick={() => { setMetric(m.key); applyDefaults(m); }}
                  className={cn("glass-field rounded-lg px-3 py-2 text-left text-sm transition-colors", metric === m.key ? "ring-2 ring-primary" : "hover:bg-[var(--glass-hover-bg)]")}>
                  <span className="block font-medium text-foreground">{m.label}</span>
                  <span className="block text-xs text-muted-foreground">{m.example}</span>
                </button>
              ))}
            </div>
          </Field>
          {def && <p className="text-xs text-muted-foreground">{def.description}</p>}
          <Field id="g-title" label={t("goal.name")}><Input id="g-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required /></Field>
          {metric !== "manual" && def && (
            <div className="grid grid-cols-3 gap-3">
              <Field id="g-cmp" label={t("goal.condition")}>
                <Select value={comparator} onValueChange={(v) => setComparator(v as Comparator)}>
                  <SelectTrigger id="g-cmp"><SelectValue /></SelectTrigger>
                  <SelectContent>{(Object.keys(COMPARATOR_SIGNS) as Comparator[]).map((c) => <SelectItem key={c} value={c}>{COMPARATOR_SIGNS[c]}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Field id="g-target" label={def.unit ? t("goal.targetUnit", { unit: def.unit }) : t("goal.target")}><Input id="g-target" type="number" step="any" value={target} onChange={(e) => setTarget(Number(e.target.value))} /></Field>
              {windowLabel(def) && (
                <Field id="g-win" label={windowLabel(def)!}><Input id="g-win" type="number" min={1} max={1000} value={win} onChange={(e) => setWin(e.target.value === "" ? "" : Number(e.target.value))} /></Field>
              )}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field id="g-start" label={t("goal.countFrom")}><Input id="g-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></Field>
            <Field id="g-due" label={t("goal.due")}><Input id="g-due" type="date" value={dueOn} min={startDate} onChange={(e) => setDueOn(e.target.value)} /></Field>
          </div>
          <Field id="g-note" label={t("goal.comment")}><Input id="g-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} /></Field>
          {def && metric !== "manual" && (
            <p className="text-xs text-muted-foreground">{t("goal.summary")} <Pill tone="accent">{def.label} {COMPARATOR_SIGNS[comparator]} {target}{def.unit ? ` ${def.unit}` : ""}{windowLabel(def) && win !== "" ? ` · ${t("goal.windowSuffix", { n: win })}` : ""}</Pill></p>
          )}
          <ErrorNote error={metrics.error ?? create.error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{ct("actions.cancel")}</Button>
            <Button type="submit" disabled={create.isPending || !list.length}>{t("goal.submit")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
