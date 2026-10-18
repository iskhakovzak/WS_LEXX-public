/**
 * Data layer of «Академия → Обучение»: raw fetch helpers for /api/academy/content/* (no orval codegen for new
 * endpoints) and response types mirrored from api-server/src/routes/academy-content.ts + lib/academyContent.ts.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { http } from "@/lib/api/http";
import { academyI18n } from "@/i18n/ns/academy";
import { commonI18n } from "@/i18n/ns/common";

export type ItemKind = "lesson" | "quiz" | "assignment";
export type ItemStatus = "not_started" | "in_progress" | "completed";
export type Stage = "trainee" | "junior" | "trader" | "senior";
export const STAGES: readonly Stage[] = ["trainee", "junior", "trader", "senior"];
const STAGE_TIER = { trainee: "intern", junior: "junior", trader: "trader", senior: "senior" } as const;
/** Ladder stage name in the UI language (stage key `trainee` = tier «Стажёр» / Intern). Call at render time. */
export const stageLabel = (s: Stage): string => commonI18n.t(`tiers.${STAGE_TIER[s]}`);
/** Same for a stage code that may come from the server as a plain string. */
export const stageLabelOf = (s: string | null | undefined): string => (s && (STAGES as readonly string[]).includes(s) ? stageLabel(s as Stage) : s ?? "");

export type Attachment = { title: string; url: string };
export type VideoEmbed = { provider: "youtube" | "vimeo" | "loom"; id: string; embedUrl: string; watchUrl: string };

export type Program = {
  id: number; slug: string | null; title: string; description: string | null; level: string | null; stage: Stage | null;
  published: boolean; position: number; createdBy: string | null; createdAt: string | null; updatedAt: string | null; archivedAt: string | null;
};

export type Progress = {
  total: number; done: number; pct: number;
  byKind: Record<ItemKind, { total: number; done: number }>;
  modules: { moduleId: number; total: number; done: number; pct: number }[];
  next: { kind: ItemKind; id: number; title: string } | null;
};

export type CatalogProgram = Program & {
  modules: number;
  counts: { lessons: number; quizzes: number; assignments: number };
  durationMin: number;
  progress: Progress;
};

export type TreeItem = {
  kind: ItemKind; id: number; title: string; summary: string | null; position: number; draft: boolean;
  durationMin: number | null; questionCount: number | null; passPct: number | null; minTrades: number | null; hasVideo: boolean;
  status: ItemStatus; bestPct: number | null; submission: { status: SubmissionStatus; passed: boolean | null } | null;
};
export type ProgramTree = {
  user: string;
  program: Program;
  progress: Progress;
  modules: { id: number; title: string; description: string | null; position: number; progress: Progress["modules"][number] | null; items: TreeItem[] }[];
};

export type Nav = {
  program: { id: number; title: string };
  prev: { kind: ItemKind; id: number; title: string } | null;
  next: { kind: ItemKind; id: number; title: string } | null;
  outline: { id: number; title: string; items: { kind: ItemKind; id: number; title: string; draft: boolean }[] }[];
};

export type Lesson = {
  id: number; moduleId: number; title: string; summary: string | null; bodyMd: string; videoUrl: string | null; video: VideoEmbed | null;
  attachments: Attachment[]; durationMin: number | null; playbookIds: number[]; setupNames: string[]; position: number; draft: boolean;
  createdBy: string | null; createdAt: string | null; updatedAt: string | null; archivedAt: string | null;
};
export type SetupRef = { id: number; name: string; folder: string | null; setupType: string | null; trader?: string | null };
export type LessonResponse = {
  user: string; lesson: Lesson; setups: SetupRef[]; nav: Nav;
  progress: { startedAt: string | null; completedAt: string | null; completed: boolean };
};

export type QuizOption = { id: string; text: string };
export type PublicQuestion =
  | { id: string; kind: "single" | "multiple"; prompt: string; options: QuizOption[]; points: number; multiple: boolean }
  | { id: string; kind: "numeric"; prompt: string; unit?: string; points: number };
export type QuizQuestion =
  | { id: string; kind: "single"; prompt: string; options: QuizOption[]; correct: string[]; points: number; explanation?: string }
  | { id: string; kind: "multiple"; prompt: string; options: QuizOption[]; correct: string[]; points: number; partial: boolean; explanation?: string }
  | { id: string; kind: "numeric"; prompt: string; answer: number; tolerance: number; tolerancePct: boolean; unit?: string; points: number; explanation?: string };

export type AttemptState = { attempts: number; attemptsLeft: number | null; canAttempt: boolean; bestPct: number | null; passed: boolean; revealAnswers: boolean };
export type Feedback = {
  id: string; correct: boolean; earned: number; points: number; given: string[] | number | null;
  explanation?: string | null;
  expected?: { options: string[] } | { answer: number; tolerance: number; tolerancePct: boolean; unit: string | null };
};
export type GradeSummary = { score: number; maxScore: number; pct: number; passed: boolean };
export type QuizResponse = {
  user: string;
  quiz: { id: number; moduleId: number; title: string; description: string | null; passPct: number; maxAttempts: number | null; draft: boolean; questions: PublicQuestion[] };
  state: AttemptState;
  attempts: { id: number; score: number | null; maxScore: number | null; pct: number | null; passed: boolean; submittedAt: string | null }[];
  last: { id: number; answers: Record<string, unknown>; grade: GradeSummary; feedback: Feedback[] } | null;
  nav: Nav;
};
export type AttemptResponse = { attempt: { id: number; submittedAt: string }; grade: GradeSummary; feedback: Feedback[]; state: AttemptState };

export type RubricCriterion = { key: string; label: string; maxPoints: number; description?: string };
export type SubmissionStatus = "submitted" | "graded" | "returned";
export type TradeRef = {
  id: number; date?: string; ticker?: string; side?: string | null; setup?: string | null; playbookId?: number | null; trader?: string | null;
  net?: number | null; r?: number | null; result?: string | null; missing?: boolean;
};
export type Submission = {
  id: number; assignmentId: number; userName: string; text: string; url: string | null; tradeIds: number[]; trades: TradeRef[];
  status: SubmissionStatus; scores: Record<string, number> | null; total: number | null; maxTotal: number | null; pct: number | null;
  passed: boolean | null; mentorComment: string | null; gradedBy: string | null; gradedAt: string | null; createdAt: string | null; updatedAt: string | null;
};
export type Assignment = {
  id: number; moduleId: number; title: string; bodyMd: string; rubric: RubricCriterion[]; passPct: number; minTrades: number;
  position: number; draft: boolean; createdAt: string | null; updatedAt: string | null; archivedAt: string | null;
};
export type AssignmentResponse = { user: string; all: boolean; assignment: Assignment; submissions: Submission[]; nav: Nav };

export type ReviewItem = Submission & { assignmentTitle: string; moduleTitle: string; programId: number; programTitle: string; rubric: RubricCriterion[]; passPct: number };

export type Meta = {
  staff: boolean; me: string | null; enrollmentsAvailable: boolean; cohortsAvailable: boolean;
  cohorts: { id: number; name: string; format: string | null; mentor: string | null }[]; pendingReviews: number;
};

export type ProgressStudent = {
  userName: string; stage: string | null; pct: number; done: number; total: number; byKind: Progress["byKind"];
  modules: Progress["modules"]; next: Progress["next"]; lastActivity: string | null; quizBest: Record<string, number | null>; pendingReviews: number;
};
export type ProgressResponse = {
  program: Program | null;
  programs: { id: number; title: string; published: boolean; stage: Stage | null }[];
  cohortId?: number | null;
  enrollmentsAvailable: boolean;
  modules: { id: number; title: string; items: number }[];
  quizzes?: { id: number; title: string; passPct: number | null }[];
  students: ProgressStudent[];
  summary: { students: number; avgPct: number | null; medianPct: number | null; completed: number; notStarted: number; stale: string[] };
};

export type AdminQuiz = { kind: "quiz"; id: number; moduleId: number; title: string; description: string | null; questions: QuizQuestion[]; passPct: number; maxAttempts: number | null; position: number; draft: boolean; updatedAt: string | null; archivedAt: string | null };
export type AdminItem = ({ kind: "lesson" } & Lesson) | AdminQuiz | ({ kind: "assignment" } & Assignment);
export type AdminModule = { id: number; title: string; description: string | null; position: number; archivedAt: string | null; items: AdminItem[] };
export type AdminTree = { programs: Program[]; program: Program | null; modules: AdminModule[] };

export type SetupLesson = { id: number; title: string; summary: string | null; durationMin: number | null; programId: number; programTitle: string; match: "playbook" | "name"; href: string };

/* ─── fetch helpers ─────────────────────────────────────────────────────── */

const BASE = "/api/academy/content";

const qs = (p: Record<string, string | number | null | undefined | boolean>) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== null && v !== undefined && v !== "" && v !== false) sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
};

/* ─── query keys ────────────────────────────────────────────────────────── */

export const academyKeys = {
  all: ["academy-content"] as const,
  meta: () => ["academy-content", "meta"] as const,
  programs: (user?: string) => ["academy-content", "programs", user ?? ""] as const,
  program: (id: number, user?: string) => ["academy-content", "program", id, user ?? ""] as const,
  lesson: (id: number, user?: string) => ["academy-content", "lesson", id, user ?? ""] as const,
  quiz: (id: number, user?: string) => ["academy-content", "quiz", id, user ?? ""] as const,
  assignment: (id: number, user?: string, all?: boolean) => ["academy-content", "assignment", id, user ?? "", !!all] as const,
  review: (status: string, cohortId?: number | null) => ["academy-content", "review", status, cohortId ?? 0] as const,
  progress: (programId?: number | null, cohortId?: number | null) => ["academy-content", "progress", programId ?? 0, cohortId ?? 0] as const,
  admin: (programId?: number | null, archived?: boolean) => ["academy-content", "admin", programId ?? 0, !!archived] as const,
  setups: () => ["academy-content", "setups"] as const,
  bySetup: (playbookId?: number | null, setup?: string | null) => ["academy-content", "by-setup", playbookId ?? 0, setup ?? ""] as const,
  myTrades: (q: string, user?: string) => ["academy-content", "my-trades", q, user ?? ""] as const,
};

export const invalidateAcademy = (qc: QueryClient) => qc.invalidateQueries({ queryKey: academyKeys.all });

/* ─── hooks ─────────────────────────────────────────────────────────────── */

export const useAcademyMeta = () => useQuery({ queryKey: academyKeys.meta(), queryFn: () => http.get<Meta>(`${BASE}/meta`), staleTime: 60_000 });

export const usePrograms = (user?: string) =>
  useQuery({ queryKey: academyKeys.programs(user), queryFn: () => http.get<{ user: string; programs: CatalogProgram[] }>(`${BASE}/programs${qs({ user })}`) });

export const useProgramTree = (id: number | null, user?: string) =>
  useQuery({ queryKey: academyKeys.program(id ?? 0, user), queryFn: () => http.get<ProgramTree>(`${BASE}/programs/${id}${qs({ user })}`), enabled: !!id });

export const useLesson = (id: number | null, user?: string) =>
  useQuery({ queryKey: academyKeys.lesson(id ?? 0, user), queryFn: () => http.get<LessonResponse>(`${BASE}/lessons/${id}${qs({ user })}`), enabled: !!id });

export const useQuiz = (id: number | null, user?: string) =>
  useQuery({ queryKey: academyKeys.quiz(id ?? 0, user), queryFn: () => http.get<QuizResponse>(`${BASE}/quizzes/${id}${qs({ user })}`), enabled: !!id });

export const useAssignment = (id: number | null, user?: string, all?: boolean) =>
  useQuery({ queryKey: academyKeys.assignment(id ?? 0, user, all), queryFn: () => http.get<AssignmentResponse>(`${BASE}/assignments/${id}${qs({ user, all: all ? 1 : null })}`), enabled: !!id });

export const useReviewQueue = (status: string, cohortId?: number | null, enabled = true) =>
  useQuery({ queryKey: academyKeys.review(status, cohortId), queryFn: () => http.get<{ status: string; items: ReviewItem[] }>(`${BASE}/review-queue${qs({ status, cohortId })}`), enabled });

export const useProgressMatrix = (programId: number | null, cohortId: number | null, enabled = true) =>
  useQuery({ queryKey: academyKeys.progress(programId, cohortId), queryFn: () => http.get<ProgressResponse>(`${BASE}/progress${qs({ programId, cohortId })}`), enabled });

export const useAdminTree = (programId: number | null, archived = false) =>
  useQuery({ queryKey: academyKeys.admin(programId, archived), queryFn: () => http.get<AdminTree>(`${BASE}/admin/tree${qs({ programId, archived: archived ? 1 : null })}`) });

export const useSetups = (enabled = true) =>
  useQuery({ queryKey: academyKeys.setups(), queryFn: () => http.get<{ setups: SetupRef[] }>(`${BASE}/setups`), enabled, staleTime: 5 * 60_000 });

export const useSetupLessons = (playbookId?: number | null, setup?: string | null) =>
  useQuery({
    queryKey: academyKeys.bySetup(playbookId, setup),
    queryFn: () => http.get<{ lessons: SetupLesson[] }>(`${BASE}/lessons/by-setup${qs({ playbookId, setup })}`),
    enabled: !!playbookId || !!setup?.trim(),
    staleTime: 5 * 60_000,
  });

export const useMyTrades = (q: string, user?: string, enabled = true) =>
  useQuery({ queryKey: academyKeys.myTrades(q, user), queryFn: () => http.get<{ user: string; trades: TradeRef[] }>(`${BASE}/my-trades${qs({ q, user, limit: 80 })}`), enabled });

/** Generic mutation that refreshes every academy query afterwards. */
export function useAcademyMutation<TVars, TRes>(fn: (v: TVars) => Promise<TRes>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => invalidateAcademy(qc) });
}

export const api = {
  lessonProgress: (id: number, completed?: boolean) => http.post<{ completed: boolean }>(`${BASE}/lessons/${id}/progress`, completed === undefined ? {} : { completed }),
  attempt: (id: number, answers: Record<string, unknown>) => http.post<AttemptResponse>(`${BASE}/quizzes/${id}/attempts`, { answers }),
  submit: (id: number, body: { text: string; url: string | null; tradeIds: number[] }) => http.post<{ submission: Submission; notified: number }>(`${BASE}/assignments/${id}/submissions`, body),
  editSubmission: (id: number, body: { text: string; url: string | null; tradeIds: number[] }) => http.patch<{ submission: Submission }>(`${BASE}/submissions/${id}`, body),
  withdrawSubmission: (id: number) => http.post<{ ok: true }>(`${BASE}/submissions/${id}/archive`, {}),
  grade: (id: number, body: { decision: "graded" | "returned"; scores?: Record<string, number>; comment: string }) => http.post<{ submission: Submission }>(`${BASE}/submissions/${id}/grade`, body),
  createProgram: (body: Partial<Program> & { title: string }) => http.post<{ program: Program }>(`${BASE}/programs`, body),
  updateProgram: (id: number, body: Partial<Program>) => http.patch<{ program: Program }>(`${BASE}/programs/${id}`, body),
  createModule: (body: { programId: number; title: string; description?: string | null }) => http.post<{ module: { id: number } }>(`${BASE}/modules`, body),
  updateModule: (id: number, body: { title?: string; description?: string | null }) => http.patch<{ module: { id: number } }>(`${BASE}/modules/${id}`, body),
  createLesson: (body: Record<string, unknown>) => http.post<{ lesson: Lesson }>(`${BASE}/lessons`, body),
  updateLesson: (id: number, body: Record<string, unknown>) => http.patch<{ lesson: Lesson }>(`${BASE}/lessons/${id}`, body),
  createQuiz: (body: Record<string, unknown>) => http.post<{ quiz: AdminQuiz }>(`${BASE}/quizzes`, body),
  updateQuiz: (id: number, body: Record<string, unknown>) => http.patch<{ quiz: AdminQuiz }>(`${BASE}/quizzes/${id}`, body),
  createAssignment: (body: Record<string, unknown>) => http.post<{ assignment: Assignment }>(`${BASE}/assignments`, body),
  updateAssignment: (id: number, body: Record<string, unknown>) => http.patch<{ assignment: Assignment }>(`${BASE}/assignments/${id}`, body),
  archive: (kind: "programs" | "modules" | "lessons" | "quizzes" | "assignments", id: number, restore = false) =>
    http.post<{ ok: true }>(`${BASE}/${kind}/${id}/${restore ? "restore" : "archive"}`, {}),
  reorderModules: (programId: number, moduleIds: number[]) => http.post<{ ok: true }>(`${BASE}/programs/${programId}/reorder`, { moduleIds }),
  reorderItems: (moduleId: number, items: { kind: ItemKind; id: number }[]) => http.post<{ ok: true }>(`${BASE}/modules/${moduleId}/reorder`, { items }),
  moveItem: (kind: ItemKind, id: number, moduleId: number) => http.post<{ ok: true }>(`${BASE}/items/move`, { kind, id, moduleId }),
  seedDemo: () => http.post<{ programId: number; created: Record<string, number>; alreadySeeded: boolean }>(`${BASE}/seed-demo`, {}),
};

export const KIND_ARCHIVE: Record<ItemKind, "lessons" | "quizzes" | "assignments"> = { lesson: "lessons", quiz: "quizzes", assignment: "assignments" };
/** «Урок» / «Тест» / «Задание» in the UI language. Call at render time. */
export const kindLabel = (k: ItemKind): string => academyI18n.t(`kind.${k}`);
