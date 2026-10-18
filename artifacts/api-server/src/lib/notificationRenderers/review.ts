/**
 * Review-loop notifications, rendered per reader (texts: `review` namespace).
 *   eod_review_request  { trader, date (YYYY-MM-DD), trades, net? ($ preformatted), discipline? }
 *   eod_overdue         { trader, date, hours, sla }
 *   eod_reviewed        { date, score?, reviewer, comment? }
 *   rating              variant "new" | "updated" { week (YYYY-MM-DD), overall?, actor, focus?, comment? }
 *   rating_ack          { trader, week, overall?, acker? (when someone else acknowledged) }
 *   weekly_review       variant "submitted" { trader, week, mood?, focus? } | "ready" | "updated" { week, actor, score?, goals?, comment? }
 * Names, comments, focus texts and ISO week labels are data.
 */
import type { NotificationRenderer } from "../notificationText";
import { reviewT } from "../../i18n/ns";

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const scoreOf = (v: unknown) => (num(v) ?? "—");

const eodReviewRequest: NotificationRenderer = ({ params, lang, date }) => {
  const t = reviewT.tFor(lang);
  const trader = str(params.trader);
  const day = str(params.date);
  if (!trader || !day) return null;
  const parts = [t("eod.trades", { count: num(params.trades) ?? 0 })];
  if (str(params.net)) parts.push(t("eod.net", { net: str(params.net)! }));
  if (num(params.discipline) !== undefined) parts.push(t("eod.discipline", { value: num(params.discipline)! }));
  return { title: t("eod.closedTitle", { trader, date: date(day) }), body: t("eod.closedBody", { parts: parts.join(", ") }) };
};

const eodOverdue: NotificationRenderer = ({ params, lang, date }) => {
  const t = reviewT.tFor(lang);
  const trader = str(params.trader);
  const day = str(params.date);
  if (!trader || !day) return null;
  return { title: t("eod.overdueTitle", { trader, date: date(day) }), body: t("eod.overdueBody", { hours: num(params.hours) ?? 0, sla: num(params.sla) ?? 24 }) };
};

const eodReviewed: NotificationRenderer = ({ params, lang, date }) => {
  const t = reviewT.tFor(lang);
  const day = str(params.date);
  const reviewer = str(params.reviewer);
  if (!day || !reviewer) return null;
  const comment = str(params.comment);
  return {
    title: t("eod.reviewedTitle", { date: date(day), score: scoreOf(params.score) }),
    body: comment ? t("eod.reviewedComment", { reviewer, comment }) : t("eod.reviewedBy", { reviewer }),
  };
};

const rating: NotificationRenderer = ({ params, lang, variant, date }) => {
  const t = reviewT.tFor(lang);
  const week = str(params.week);
  const actor = str(params.actor);
  if (!week || !actor) return null;
  const focus = str(params.focus);
  const comment = str(params.comment);
  return {
    title: t(variant === "updated" ? "rating.updatedTitle" : "rating.newTitle", { week: date(week), overall: scoreOf(params.overall) }),
    body: actor + (focus ? t("rating.focus", { focus }) : "") + (comment ? t("rating.comment", { comment }) : ""),
  };
};

const ratingAck: NotificationRenderer = ({ params, lang, date }) => {
  const t = reviewT.tFor(lang);
  const trader = str(params.trader);
  const week = str(params.week);
  if (!trader || !week) return null;
  const acker = str(params.acker);
  return {
    title: t("rating.ackTitle", { trader }),
    body: t("rating.ackBody", { week: date(week), overall: scoreOf(params.overall) }) + (acker ? t("rating.ackBy", { acker }) : ""),
  };
};

const weekly: NotificationRenderer = ({ params, lang, variant }) => {
  const t = reviewT.tFor(lang);
  const week = str(params.week);
  if (!week) return null;
  if (variant === "submitted") {
    const trader = str(params.trader);
    if (!trader) return null;
    const focus = str(params.focus);
    const mood = num(params.mood);
    return {
      title: t("weekly.submittedTitle", { week, trader }),
      body: (mood !== undefined ? t("weekly.mood", { mood }) : "") + (focus ? t("weekly.focus", { focus }) : t("weekly.awaiting")),
    };
  }
  if (variant !== "ready" && variant !== "updated") return null;
  const actor = str(params.actor);
  if (!actor) return null;
  const score = num(params.score);
  const goals = num(params.goals) ?? 0;
  const comment = str(params.comment);
  return {
    title: t(variant === "updated" ? "weekly.updatedTitle" : "weekly.readyTitle", { week }) + (score !== undefined ? t("weekly.score", { score }) : ""),
    body: actor + (goals ? t("weekly.goals", { count: goals }) : "") + (comment ? t("weekly.comment", { comment }) : ""),
  };
};

export const reviewRenderers: Record<string, NotificationRenderer> = {
  eod_review_request: eodReviewRequest,
  eod_overdue: eodOverdue,
  eod_reviewed: eodReviewed,
  rating,
  rating_ack: ratingAck,
  weekly_review: weekly,
};
