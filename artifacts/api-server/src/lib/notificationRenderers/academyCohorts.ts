/**
 * Cohort / IDP notifications (routes/academy-cohorts.ts), texts in `academyCohorts.notify.*`:
 *   academy_goal_achieved / academy_goal_missed  { student, title, due, detailMsg (JSON GoalMsg) }
 *   academy_action_overdue                        { student, title, due }
 *   academy_stage_change                          { fromStage?, toStage?, fromStatus?, toStatus?, note? } (codes)
 *   academy_enrolled                              { cohort, stage (code) }
 *   academy_action_assigned                       { title, due? }
 *   academy_goal_assigned                         { title, metric, target, comparator, window?, due? }
 * Titles, notes, cohort names are user content.
 */
import type { NotificationRenderer } from "../notificationText";
import { academyCohortsT } from "../academyI18n";
import {
  COMPARATORS, ENROLLMENT_STATUSES, METRIC_KEYS, STAGES, describeGoal, enrollmentStatusLabelFor, renderGoalMsg, stageLabelFor,
  type Comparator, type EnrollmentStatus, type GoalMsg, type MetricKey, type Stage,
} from "../academyCohorts";

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const isStage = (v: unknown): v is Stage => typeof v === "string" && (STAGES as readonly string[]).includes(v);
const isStatus = (v: unknown): v is EnrollmentStatus => typeof v === "string" && (ENROLLMENT_STATUSES as readonly string[]).includes(v);

function goalDetail(v: unknown, lang: Parameters<typeof renderGoalMsg>[1]): string {
  if (typeof v !== "string") return "";
  try {
    const m = JSON.parse(v) as GoalMsg;
    return m && typeof m.key === "string" ? renderGoalMsg(m, lang) : "";
  } catch {
    return "";
  }
}

const goalDone: NotificationRenderer = ({ type, params, lang }) => {
  if (typeof params.title !== "string") return null;
  const t = academyCohortsT.tFor(lang);
  const achieved = type === "academy_goal_achieved";
  const p = { student: str(params.student), title: params.title, due: str(params.due), detail: goalDetail(params.detailMsg, lang) };
  return { title: t(achieved ? "notify.goalAchievedTitle" : "notify.goalMissedTitle"), body: t(achieved ? "notify.goalAchieved" : "notify.goalMissed", p) };
};

const actionOverdue: NotificationRenderer = ({ params, lang }) => {
  if (typeof params.title !== "string") return null;
  const t = academyCohortsT.tFor(lang);
  return { title: t("notify.actionOverdueTitle"), body: t("notify.actionOverdue", { student: str(params.student), title: params.title, due: str(params.due) }) };
};

const stageChange: NotificationRenderer = ({ params, lang }) => {
  const t = academyCohortsT.tFor(lang);
  const parts: string[] = [];
  if (isStage(params.fromStage) && isStage(params.toStage)) parts.push(t("notify.changeStage", { from: stageLabelFor(params.fromStage, lang), to: stageLabelFor(params.toStage, lang) }));
  if (isStatus(params.fromStatus) && isStatus(params.toStatus)) {
    parts.push(t("notify.changeStatus", { from: enrollmentStatusLabelFor(params.fromStatus, lang), to: enrollmentStatusLabelFor(params.toStatus, lang) }));
  }
  if (!parts.length) return null;
  const note = str(params.note);
  return { title: t("notify.changeTitle"), body: parts.join("; ") + (note ? ` — ${note}` : "") };
};

const enrolled: NotificationRenderer = ({ params, lang }) => {
  if (!isStage(params.stage)) return null;
  const t = academyCohortsT.tFor(lang);
  return { title: t("notify.enrolledTitle"), body: t("notify.enrolledBody", { cohort: str(params.cohort), stage: stageLabelFor(params.stage, lang) }) };
};

const actionAssigned: NotificationRenderer = ({ params, lang }) => {
  if (typeof params.title !== "string") return null;
  const t = academyCohortsT.tFor(lang);
  const due = str(params.due);
  return { title: t("notify.actionTitle"), body: due ? t("notify.actionBodyDue", { title: params.title, due }) : t("notify.actionBody", { title: params.title }) };
};

const goalAssigned: NotificationRenderer = ({ params, lang }) => {
  if (typeof params.title !== "string" || !(METRIC_KEYS as readonly string[]).includes(str(params.metric))) return null;
  const comparator = (COMPARATORS as readonly string[]).includes(str(params.comparator)) ? (params.comparator as Comparator) : "gte";
  const formula = describeGoal({
    metric: params.metric as MetricKey, target: Number(params.target ?? 0), comparator, window: params.window == null || params.window === "" ? null : Number(params.window),
  }, lang);
  const t = academyCohortsT.tFor(lang);
  const due = str(params.due);
  return { title: t("notify.goalTitle"), body: due ? t("notify.goalBodyDue", { title: params.title, formula, due }) : t("notify.goalBody", { title: params.title, formula }) };
};

export const academyCohortsRenderers: Record<string, NotificationRenderer> = {
  academy_goal_achieved: goalDone,
  academy_goal_missed: goalDone,
  academy_action_overdue: actionOverdue,
  academy_stage_change: stageChange,
  academy_enrolled: enrolled,
  academy_action_assigned: actionAssigned,
  academy_goal_assigned: goalAssigned,
};
