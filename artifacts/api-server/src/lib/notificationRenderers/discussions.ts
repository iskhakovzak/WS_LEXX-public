/**
 * Discussion notifications, rendered per reader (texts: `discussions` namespace).
 *   review_request  { author, ticker?, preview }
 *   thread_new      { author, ticker?, audience? (comma tokens; empty = public), cohorts? (JSON {id: name}), preview }
 *   reply           variant "accepted" { actor, preview } | "toYou" | "inYours" { actor, topic, preview }
 * Names, tickers, topics, cohort names and previews are user content.
 */
import type { NotificationRenderer } from "../notificationText";
import { audienceLabel } from "../discussionAudience";
import { discussionsT } from "../../i18n/ns";

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function cohortMap(json: string | undefined): Map<number, string> {
  if (!json) return new Map();
  try {
    const o = JSON.parse(json) as Record<string, string>;
    return new Map(Object.entries(o).map(([k, v]) => [Number(k), String(v)]));
  } catch {
    return new Map();
  }
}

const reviewRequest: NotificationRenderer = ({ params, lang }) => {
  const t = discussionsT.tFor(lang);
  const author = str(params.author);
  const preview = str(params.preview);
  if (!author || preview === undefined) return null;
  const ticker = str(params.ticker);
  return {
    title: ticker ? t("notify.reviewRequestTicker", { author, ticker }) : t("notify.reviewRequest", { author }),
    body: t("notify.quote", { text: preview }),
  };
};

const threadNew: NotificationRenderer = ({ params, lang }) => {
  const t = discussionsT.tFor(lang);
  const author = str(params.author);
  const preview = str(params.preview);
  if (!author || preview === undefined) return null;
  const ticker = str(params.ticker);
  const tokens = (str(params.audience) ?? "").split(",").filter(Boolean);
  const label = tokens.length ? audienceLabel(tokens, cohortMap(str(params.cohorts)), lang) : null;
  return {
    title: (ticker ? t("notify.threadNewTicker", { author, ticker }) : t("notify.threadNew", { author })) + (label ? t("notify.audienceSuffix", { label }) : ""),
    body: t("notify.quote", { text: preview }),
  };
};

const reply: NotificationRenderer = ({ params, lang, variant }) => {
  const t = discussionsT.tFor(lang);
  const actor = str(params.actor);
  const preview = str(params.preview);
  if (!actor || preview === undefined) return null;
  const body = t("notify.quote", { text: preview });
  if (variant === "accepted") return { title: t("notify.accepted", { actor }), body };
  const topic = str(params.topic) ?? "";
  if (variant === "toYou") return { title: t("notify.replyToYou", { actor, topic }), body };
  if (variant === "inYours") return { title: t("notify.replyInYours", { actor, topic }), body };
  return null;
};

export const discussionsRenderers: Record<string, NotificationRenderer> = {
  review_request: reviewRequest,
  thread_new: threadNew,
  reply,
};
