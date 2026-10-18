/**
 * Course notifications (routes/academy-content.ts), texts in `academyContent.notify.*`:
 *   academy_submitted  { title, user, n }                         — to mentors
 *   academy_graded     { variant: returned | passed | failed, title, mentor, comment?, total?, max?, pct? }
 * Assignment titles and comments are user content.
 */
import type { NotificationRenderer } from "../notificationText";
import { academyContentT } from "../academyI18n";

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

const submitted: NotificationRenderer = ({ params, lang }) => {
  if (typeof params.title !== "string") return null;
  const t = academyContentT.tFor(lang);
  const n = Number(params.n ?? 0);
  const p = { title: params.title, user: str(params.user), n };
  return { title: t("notify.submittedTitle", p), body: n ? t("notify.submittedBodyTrades", p) : t("notify.submittedBody", p) };
};

const graded: NotificationRenderer = ({ params, lang, variant }) => {
  if (typeof params.title !== "string") return null;
  const t = academyContentT.tFor(lang);
  const title = params.title;
  const mentor = str(params.mentor);
  const comment = str(params.comment);
  switch (variant) {
    case "returned":
      return { title: t("notify.returnedTitle", { title }), body: t("notify.returnedBody", { mentor, comment }) };
    case "passed":
    case "failed": {
      const g = { total: str(params.total), max: str(params.max), pct: str(params.pct) };
      return {
        title: t(variant === "passed" ? "notify.passedTitle" : "notify.failedTitle", { title }),
        body: comment ? t("notify.gradedBodyComment", { ...g, mentor, comment }) : t("notify.gradedBody", g),
      };
    }
    default:
      return null;
  }
};

export const academyContentRenderers: Record<string, NotificationRenderer> = {
  academy_submitted: submitted,
  academy_graded: graded,
};
