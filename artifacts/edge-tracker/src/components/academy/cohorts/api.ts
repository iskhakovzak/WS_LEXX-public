/**
 * «Академия» → когорты и наставничество: типы ответов (зеркало api-server/src/routes/academy-cohorts.ts и
 * lib/academyCohorts.ts), коды справочников с функциями-подписями (язык читается при вызове) и raw-fetch хуки для /api/academy/* (orval-кодоген для новых эндпоинтов не запускается).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { http, type ApiError } from "@/lib/api/http";
import { academyCohortsI18n } from "@/i18n/ns/academyCohorts";
import { commonI18n } from "@/i18n/ns/common";

/* ─── Справочники ─────────────────────────────────────────────────────────── */

export type CohortFormat = "office" | "remote" | "hybrid";
export type Stage = "trainee" | "junior" | "trader" | "senior";
export type EnrollmentStatus = "active" | "paused" | "graduated" | "dropped";
export type Recurrence = "none" | "daily" | "weekdays" | "weekly";
export type SessionMode = "office" | "online" | "hybrid";
export type SessionKind = "briefing" | "lecture" | "review" | "workshop" | "other";
export type AttendanceStatus = "present" | "late" | "absent" | "excused";
export type ActionStatus = "open" | "done" | "dropped";
export type GoalStatus = "active" | "achieved" | "missed" | "cancelled";
export type MetricKey = "fee_share" | "loss_streak" | "win_rate" | "journal_days" | "net_pnl" | "trading_days" | "manual";
export type Comparator = "lt" | "lte" | "gte" | "gt";

export const STAGES: Stage[] = ["trainee", "junior", "trader", "senior"];
export const COHORT_FORMATS: CohortFormat[] = ["office", "remote", "hybrid"];
export const ENROLLMENT_STATUSES: EnrollmentStatus[] = ["active", "paused", "graduated", "dropped"];
export const SESSION_MODES: SessionMode[] = ["office", "online", "hybrid"];
export const SESSION_KINDS: SessionKind[] = ["briefing", "lecture", "review", "workshop", "other"];
export const RECURRENCES: Recurrence[] = ["none", "daily", "weekdays", "weekly"];
export const GOAL_STATUSES: GoalStatus[] = ["active", "achieved", "missed", "cancelled"];
export const ATTENDANCE_STATUSES: AttendanceStatus[] = ["present", "late", "absent", "excused"];
export const COMPARATOR_SIGNS: Record<Comparator, string> = { lt: "<", lte: "≤", gte: "≥", gt: ">" };

/* Display labels: read the current language at call time (never at module scope). Unknown codes fall back to the code. */
const STAGE_TIER = { trainee: "intern", junior: "junior", trader: "trader", senior: "senior" } as const;
const has = <T extends string>(list: readonly T[], v: string): v is T => (list as readonly string[]).includes(v);
const t = academyCohortsI18n.t;

/** Стажёр / Джун / Трейдер / Сеньор → common `tiers.*` (trainee = Intern / Stajyor). */
export const stageLabel = (s: Stage | string): string => (has(STAGES, s) ? commonI18n.t(`tiers.${STAGE_TIER[s]}`) : s);
export const statusLabel = (s: EnrollmentStatus | string): string => (has(ENROLLMENT_STATUSES, s) ? t(`enrollmentStatus.${s}`) : s);
export const formatLabel = (f: CohortFormat | string): string => (has(COHORT_FORMATS, f) ? t(`format.${f}`) : f);
export const modeLabel = (m: SessionMode | string): string => (has(SESSION_MODES, m) ? t(`mode.${m}`) : m);
export const kindLabel = (k: SessionKind | string): string => (has(SESSION_KINDS, k) ? t(`kind.${k}`) : k);
export const recurrenceLabel = (r: Recurrence): string => t(`recurrence.${r}`);
/** Short chip label («Уважит.»); `attendanceTitle` is the full form for tooltips. */
export const attendanceLabel = (a: AttendanceStatus): string => t(`attendance.${a}`);
export const attendanceTitle = (a: AttendanceStatus): string => t(`attendanceFull.${a}`);
export const goalStatusLabel = (g: GoalStatus | string): string => (has(GOAL_STATUSES, g) ? t(`goalStatus.${g}`) : g);
export const meetingFormatLabel = (f: "office" | "online", inline = false): string => t(inline ? `meetingFormatInline.${f}` : `meetingFormat.${f}`);

/* ─── Типы ответов ────────────────────────────────────────────────────────── */

export type Cohort = {
  id: number; name: string; format: CohortFormat; mentor: string | null; startsOn: string | null; endsOn: string | null; timezone: string;
  description: string; room: string | null; meetingUrl: string | null; createdBy?: string | null; createdAt?: string; archivedAt?: string | null;
};
export type CohortListItem = Cohort & { counts: Record<EnrollmentStatus, number>; sessions: number };

export type Enrollment = {
  id: number; cohortId: number; userName: string; stage: Stage; stageLabel: string; status: EnrollmentStatus; statusLabel: string;
  joinedOn: string; note: string; createdAt: string; archivedAt: string | null;
};

export type AttendanceSummary = {
  total: number; present: number; late: number; absent: number; excused: number; unmarked: number;
  rate: number | null; punctuality: number | null; absentStreak: number;
};

export type Session = {
  id: number; cohortId: number; title: string; kind: SessionKind; recurrence: Recurrence; weekdays: number[]; startDate: string; endDate: string | null;
  startTime: string; durationMin: number; timezone: string; mode: SessionMode; room: string | null; meetingUrl: string | null; host: string | null;
  description: string; archivedAt: string | null; ruleText: string; next: { date: string; startUtc: string; endUtc: string } | null;
};

export type Occurrence = {
  sessionId: number; cohortId: number; cohortName: string; title: string; kind: SessionKind; mode: SessionMode; room: string | null; meetingUrl: string | null;
  host: string | null; description: string; date: string; startUtc: string; endUtc: string; timezone: string; startTimeLocal: string; ruleText: string;
};

export type AttMark = { status: AttendanceStatus; source: "mentor" | "self"; checkedInAt: string | null } | null;

export type MyOccurrence = Occurrence & {
  attendance: AttMark; checkinOpensAt: string; checkinClosesAt: string; selfCheckin: boolean; canCheckIn: boolean;
};

export type HistoryRow = {
  id: number; enrollmentId?: number; userName?: string; fromStage: Stage | null; toStage: Stage | null; fromStatus: EnrollmentStatus | null; toStatus: EnrollmentStatus | null;
  changedBy: string | null; note: string; changedAt: string;
};

export type GoalEval = {
  value: number | null; progress: number; met: boolean; achieved: boolean; sample: number; required: number | null;
  windowFrom: string | null; windowTo: string | null; detail: string;
};
export type Goal = {
  id: number; student: string; title: string; metric: MetricKey; metricLabel: string; unit: string; comparator: Comparator; target: number;
  window: number | null; startDate: string; dueOn: string | null; status: GoalStatus; manualProgress: number | null; note: string; formula: string;
  achievedAt: string | null; missedAt: string | null; createdBy: string | null; createdAt: string; eval: GoalEval;
};
export type MetricDef = {
  key: MetricKey; label: string; unit: string; comparator: Comparator; windowKind: "days" | "trades" | "since_start" | "none";
  defaultWindow: number | null; defaultTarget: number; lowerIsBetter: boolean; description: string; example: string;
};

export type ActionItem = {
  id: number; meetingId: number | null; student: string; owner: "student" | "mentor"; title: string; dueOn: string | null; status: ActionStatus;
  doneAt: string | null; createdBy: string | null; createdAt: string; overdue: boolean;
};

export type Meeting = {
  id: number; student: string; mentor: string; cohortId: number | null; metAt: string; durationMin: number | null; format: "office" | "online";
  agenda: string; notes: string; privateNotes?: string; createdBy: string | null; createdAt: string; actionItems?: ActionItem[];
};

export type CohortDetail = {
  cohort: Cohort;
  enrollments: (Enrollment & { attendance: AttendanceSummary | null; attendance30: AttendanceSummary | null })[];
  attendance: AttendanceSummary;
  sessions: Session[];
  history: HistoryRow[];
};

export type MyEnrollment = Enrollment & { cohort: Omit<Cohort, "createdBy" | "createdAt" | "archivedAt"> };
export type MyDashboard = {
  serverNow: string;
  checkin: { beforeMin: number; afterMin: number; graceMin: number };
  user: string | null;
  viewingOther?: boolean;
  enrollments: MyEnrollment[];
  upcoming: MyOccurrence[];
  recent: (Occurrence & { attendance: AttMark })[];
  attendance: { byCohort: { cohortId: number; cohortName: string; all: AttendanceSummary; last30: AttendanceSummary }[]; total: AttendanceSummary } | null;
  goals: Goal[];
  actionItems: ActionItem[];
  meetings: Meeting[];
  history?: HistoryRow[];
};

export type LagReason = { code: string; severity: "warn" | "critical"; text: string };
export type MentorStudent = {
  enrollment: Enrollment; cohortName: string; attendance: AttendanceSummary; attendance30: AttendanceSummary;
  goals: {
    active: number; achieved: number; missed: number; atRisk: number; avgProgress: number | null;
    list: { id: number; title: string; status: GoalStatus; formula: string; progress: number; value: number | null; unit: string; dueOn: string | null; detail: string }[];
  };
  openActions: number; overdueActions: number; lastTradeDate: string | null; lastJournalDate: string | null;
  reasons: LagReason[]; score: number; lastMeetingAt: string | null;
};
export type TodaySession = Occurrence & { expected: number; marked: number; byStatus: Partial<Record<AttendanceStatus, number>>; phase: "upcoming" | "live" | "done" };
export type MentorDashboard = {
  serverNow: string; scope: "mine" | "all"; hasOwnCohorts: boolean; cohorts: Cohort[]; students: MentorStudent[]; lagging: number;
  today: TodaySession[]; openActions: ActionItem[]; meetings: Meeting[];
};

export type RosterRow = { enrollment: Enrollment; status: AttendanceStatus | null; source: "mentor" | "self" | null; checkedInAt: string | null; markedBy: string | null; note: string };
export type Roster = { session: Session; occurrence: { date: string; startUtc: string; endUtc: string }; roster: RosterRow[] };

const enc = encodeURIComponent;

export const academyKeys = {
  all: ["academy-cohorts"] as const,
  cohorts: (archived: boolean) => ["academy-cohorts", "cohorts", archived] as const,
  cohort: (id: number) => ["academy-cohorts", "cohort", id] as const,
  my: (user: string) => ["academy-cohorts", "my", user] as const,
  mentor: (all: boolean) => ["academy-cohorts", "mentor", all] as const,
  idp: (student: string) => ["academy-cohorts", "idp", student] as const,
  metrics: ["academy-cohorts", "metrics"] as const,
  meetings: (student: string) => ["academy-cohorts", "meetings", student] as const,
  roster: (sessionId: number, date: string) => ["academy-cohorts", "roster", sessionId, date] as const,
  sessions: (cohortId: number | null, from: string, to: string) => ["academy-cohorts", "sessions", cohortId, from, to] as const,
  history: (enrollmentId: number) => ["academy-cohorts", "history", enrollmentId] as const,
};

export function useCohorts(archived = false) {
  return useQuery({ queryKey: academyKeys.cohorts(archived), queryFn: () => http.get<{ staff: boolean; cohorts: CohortListItem[] }>(`/api/academy/cohorts${archived ? "?archived=1" : ""}`), retry: false });
}
export function useCohort(id: number | null) {
  return useQuery({ queryKey: academyKeys.cohort(id ?? 0), enabled: !!id, queryFn: () => http.get<CohortDetail>(`/api/academy/cohorts/${id}`), retry: false });
}
export function useMyDashboard(user: string) {
  return useQuery({
    queryKey: academyKeys.my(user),
    queryFn: () => http.get<MyDashboard>(`/api/academy/my${user ? `?user=${enc(user)}` : ""}`),
    retry: false,
    refetchInterval: 60_000,
  });
}
export function useMentorDashboard(all: boolean) {
  return useQuery({ queryKey: academyKeys.mentor(all), queryFn: () => http.get<MentorDashboard>(`/api/academy/mentor${all ? "?all=1" : ""}`), retry: false, refetchInterval: 120_000 });
}
export function useIdp(student: string, enabled = true) {
  return useQuery({ queryKey: academyKeys.idp(student), enabled: enabled && !!student, queryFn: () => http.get<{ student: string; goals: Goal[] }>(`/api/academy/idp?student=${enc(student)}`), retry: false });
}
export function useMetrics() {
  return useQuery({ queryKey: academyKeys.metrics, staleTime: Infinity, queryFn: () => http.get<{ metrics: MetricDef[] }>("/api/academy/idp/metrics"), retry: false });
}
export function useMeetings(student: string, enabled = true) {
  return useQuery({ queryKey: academyKeys.meetings(student), enabled, queryFn: () => http.get<{ meetings: Meeting[] }>(`/api/academy/one-on-ones${student ? `?student=${enc(student)}` : ""}`), retry: false });
}
export function useRoster(sessionId: number | null, date: string) {
  return useQuery({ queryKey: academyKeys.roster(sessionId ?? 0, date), enabled: !!sessionId && !!date, queryFn: () => http.get<Roster>(`/api/academy/sessions/${sessionId}/roster?date=${date}`), retry: false });
}
export function useSchedule(cohortId: number | null, from: string, to: string) {
  return useQuery({
    queryKey: academyKeys.sessions(cohortId, from, to),
    queryFn: () => http.get<{ from: string; to: string; serverNow: string; sessions: Session[]; occurrences: Occurrence[] }>(
      `/api/academy/sessions?from=${from}&to=${to}${cohortId ? `&cohortId=${cohortId}` : ""}`),
    retry: false,
  });
}
export function useEnrollmentHistory(id: number | null) {
  return useQuery({ queryKey: academyKeys.history(id ?? 0), enabled: !!id, queryFn: () => http.get<{ history: HistoryRow[] }>(`/api/academy/enrollments/${id}/history`), retry: false });
}

/** Любая мутация «Академии»: после успеха инвалидирует все ключи модуля (данные связаны между собой). */
function useAcademyMutation<V, R = unknown>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation<R, ApiError, V>({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: academyKeys.all }) });
}

export type CohortInput = { name: string; format: CohortFormat; mentor?: string | null; startsOn?: string | null; endsOn?: string | null; timezone?: string; description?: string; room?: string | null; meetingUrl?: string | null };
export const useCreateCohort = () => useAcademyMutation((v: CohortInput) => http.post<Cohort>("/api/academy/cohorts", v));
export const useUpdateCohort = () => useAcademyMutation(({ id, ...v }: Partial<CohortInput> & { id: number }) => http.patch<Cohort>(`/api/academy/cohorts/${id}`, v));
export const useArchiveCohort = () => useAcademyMutation(({ id, restore }: { id: number; restore?: boolean }) => http.post<Cohort>(`/api/academy/cohorts/${id}/${restore ? "restore" : "archive"}`));
export const useSeedDemo = () => useAcademyMutation(() => http.post<{ ok: boolean; created: Record<string, number>; skippedUsers: string[] }>("/api/academy/cohorts/seed-demo"));

export type EnrollInput = { cohortId: number; userName: string; stage: Stage; status?: EnrollmentStatus; joinedOn?: string; note?: string };
export const useEnroll = () => useAcademyMutation((v: EnrollInput) => http.post<Enrollment>("/api/academy/enrollments", v));
export const useUpdateEnrollment = () => useAcademyMutation(({ id, ...v }: { id: number; stage?: Stage; status?: EnrollmentStatus; joinedOn?: string; note?: string; reason?: string }) =>
  http.patch<Enrollment>(`/api/academy/enrollments/${id}`, v));
export const useArchiveEnrollment = () => useAcademyMutation((id: number) => http.post<Enrollment>(`/api/academy/enrollments/${id}/archive`));

export type SessionInput = {
  cohortId: number; title: string; kind: SessionKind; recurrence: Recurrence; weekdays: number[]; startDate: string; endDate?: string | null; startTime: string;
  durationMin: number; timezone: string; mode: SessionMode; room?: string | null; meetingUrl?: string | null; host?: string | null; description?: string;
};
export const useCreateSession = () => useAcademyMutation((v: SessionInput) => http.post<Session>("/api/academy/sessions", v));
export const useUpdateSession = () => useAcademyMutation(({ id, cohortId: _c, ...v }: Partial<SessionInput> & { id: number }) => http.patch<Session>(`/api/academy/sessions/${id}`, v));
export const useArchiveSession = () => useAcademyMutation((id: number) => http.post<Session>(`/api/academy/sessions/${id}/archive`));

export const useMarkAttendance = () => useAcademyMutation((v: { sessionId: number; date: string; marks: { userName: string; status: AttendanceStatus; note?: string }[] }) =>
  http.post<{ saved: number; skipped: string[] }>("/api/academy/attendance", v));
export const useCheckin = () => useAcademyMutation((v: { sessionId: number; date: string }) =>
  http.post<{ already: boolean; status: AttendanceStatus; checkedInAt: string; minutesFromStart?: number }>("/api/academy/checkin", v));

export type MeetingInput = {
  student: string; mentor?: string; cohortId?: number | null; metAt: string; durationMin?: number | null; format: "office" | "online";
  agenda: string; notes: string; privateNotes: string; actionItems: { title: string; dueOn?: string | null; owner: "student" | "mentor" }[];
};
export const useCreateMeeting = () => useAcademyMutation((v: MeetingInput) => http.post<Meeting>("/api/academy/one-on-ones", v));
export const useArchiveMeeting = () => useAcademyMutation((id: number) => http.post<Meeting>(`/api/academy/one-on-ones/${id}/archive`));

export const useCreateAction = () => useAcademyMutation((v: { student: string; title: string; dueOn?: string | null; owner: "student" | "mentor"; meetingId?: number | null }) =>
  http.post<ActionItem>("/api/academy/action-items", v));
export const useUpdateAction = () => useAcademyMutation(({ id, ...v }: { id: number; status?: ActionStatus; title?: string; dueOn?: string | null }) =>
  http.patch<ActionItem>(`/api/academy/action-items/${id}`, v));

export type GoalInput = {
  student: string; title: string; metric: MetricKey; comparator?: Comparator; target?: number; window?: number | null; startDate?: string; dueOn?: string | null;
  manualProgress?: number | null; note?: string;
};
export const useCreateGoal = () => useAcademyMutation((v: GoalInput) => http.post<Goal>("/api/academy/idp", v));
export const useUpdateGoal = () => useAcademyMutation(({ id, ...v }: { id: number; manualProgress?: number; status?: "active" | "cancelled"; dueOn?: string | null; target?: number; title?: string }) =>
  http.patch<Goal>(`/api/academy/idp/${id}`, v));
export const useArchiveGoal = () => useAcademyMutation((id: number) => http.post<{ id: number }>(`/api/academy/idp/${id}/archive`));
