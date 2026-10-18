/**
 * Academy path notifications (routes/academy-path.ts), texts in `academyPath.notify.*`:
 *   academy_promotion_request   { variant: "staff" | "user", user, fromKey, toKey, from, to, passed, total }
 *   academy_promotion_decision  { variant: "approved" | "rejected" | "assigned", actor, toKey, to, comment? }
 *   academy_challenge_assigned  { actor, name, templateKey?, date }
 *   academy_challenge_passed / _failed — same as the builtin renderer, but a failed / expired exam renders its reason
 *     from `reasonData` (JSON of challengeEngine ReasonData) in the reader's language; `reason` stays the RU fallback.
 * Stage names: the seeded name of `fromKey` / `toKey` is translated, a name staff typed is kept (academyI18n).
 */
import type { NotificationRenderer } from "../notificationText";
import { academyPathT, stageNameFor } from "../academyI18n";
import { challengeNameFor, renderChallengeReason, type ReasonData } from "../challengeEngine";

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

const promotionRequest: NotificationRenderer = ({ params, lang, variant }) => {
  const t = academyPathT.tFor(lang);
  if (typeof params.toKey !== "string") return null;
  const from = stageNameFor(str(params.fromKey), str(params.from), lang);
  const to = stageNameFor(str(params.toKey), str(params.to), lang);
  const body = t("notify.requestBody", { user: str(params.user), from, to, passed: Number(params.passed ?? 0), total: Number(params.total ?? 0) });
  return { title: t(variant === "user" ? "notify.requestTitleUser" : "notify.requestTitle"), body };
};

const promotionDecision: NotificationRenderer = ({ params, lang, variant }) => {
  const t = academyPathT.tFor(lang);
  if (typeof params.toKey !== "string") return null;
  const to = stageNameFor(params.toKey, str(params.to), lang);
  const actor = str(params.actor);
  const comment = str(params.comment);
  switch (variant) {
    case "approved":
      return { title: t("notify.approvedTitle", { to }), body: comment ? t("notify.approvedBodyComment", { actor, to, comment }) : t("notify.approvedBody", { actor, to }) };
    case "rejected":
      return { title: t("notify.rejectedTitle"), body: t("notify.rejectedBody", { actor, comment }) };
    case "assigned":
      return { title: t("notify.assignedTitle", { to }), body: t("notify.assignedBody", { actor, to, comment }) };
    default:
      return null;
  }
};

const challengeAssigned: NotificationRenderer = ({ params, lang }) => {
  if (typeof params.name !== "string" || typeof params.date !== "string") return null;
  const t = academyPathT.tFor(lang);
  const name = challengeNameFor(typeof params.templateKey === "string" ? params.templateKey : null, params.name, lang);
  return { title: t("notify.examTitle"), body: t("notify.examBody", { actor: str(params.actor), name, date: params.date }) };
};

function parseReason(v: unknown): ReasonData | null {
  if (typeof v !== "string" || !v) return null;
  try {
    const d = JSON.parse(v) as ReasonData;
    return d && typeof d.key === "string" && d.params && typeof d.params === "object" ? d : null;
  } catch {
    return null;
  }
}

/** Exam outcome: titles from the `notifications` namespace (academy_challenge.*), reason per reader. */
const challenge: NotificationRenderer = ({ type, params, p, tr, variant, lang }) => {
  const outcome = String(params.outcome ?? (type === "academy_challenge_passed" ? "passed" : "failed"));
  const name = challengeNameFor(typeof params.templateKey === "string" ? params.templateKey : null, str(params.name), lang);
  const pp = { ...p, name };
  const own = tr(outcome === "passed" ? "academy_challenge.passedTitle" : outcome === "expired" ? "academy_challenge.expiredTitle" : "academy_challenge.failedTitle", pp);
  if (!own) return null;
  const data = parseReason(params.reasonData);
  return {
    title: variant === "staff" ? tr("academy_challenge.staffTitle", { ...pp, title: own }) : own,
    body: outcome === "passed" ? tr("academy_challenge.passedBody", { ...pp, count: Number(params.days ?? 0) }) : data ? renderChallengeReason(data, lang) : str(params.reason),
  };
};

export const academyRenderers: Record<string, NotificationRenderer> = {
  academy_promotion_request: promotionRequest,
  academy_promotion_decision: promotionDecision,
  academy_challenge_assigned: challengeAssigned,
  academy_challenge_passed: challenge,
  academy_challenge_failed: challenge,
};
