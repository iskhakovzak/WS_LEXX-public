/**
 * Scaling notifications, rendered per reader (texts: `scaling` namespace).
 *   scaling_proposal  { trader, actionCode, from?, to, source ("auto" | "manual"), actor, reasonsJson? (ReasonItem[] as JSON) }
 *   scaling_decision  variant "trader" | "staff" { trader, approved (1/0), actionCode, to, actor, daily?, weekly?, dd?, comment? }
 * Tier names (typed by curators), names and comments are user content (never translated).
 */
import type { NotificationRenderer } from "../notificationText";
import { limitsSummary, preview, scalingActionCode } from "../notifyEventsCore";
import { renderReason, type ReasonItem } from "../scalingEngine";
import { scalingT } from "../../i18n/ns";
import type { Lang } from "../../i18n";

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Tier name or «без тира». */
export function tierOrNone(name: string | null | undefined, lang: Lang): string {
  return name || scalingT.tFor(lang)("noTier");
}

/** «Повышение до «Трейдер»» in `lang`. */
export function scalingChange(action: string, tier: string, lang: Lang): string {
  const label = scalingT.tFor(lang)(`action.${scalingActionCode(action)}`);
  return scalingT.tryFor(lang, "notify.change", { action: label, actionLower: label.toLowerCase(), tier }) ?? `${label} ${tier}`;
}

/** Limits summary of tier limits passed as daily / weekly / dd params. */
export function tierLimitsText(p: Record<string, unknown>, lang: Lang): string {
  return limitsSummary({ dailyLossLimit: num(p.daily) ?? null, weeklyLossLimit: num(p.weekly) ?? null, maxDrawdown: num(p.dd) ?? null }, lang);
}

function reasonsText(json: string | undefined, lang: Lang): string {
  if (!json) return "";
  try {
    const items = JSON.parse(json) as unknown;
    if (!Array.isArray(items)) return "";
    return items.map((x) => (typeof x === "string" ? x : renderReason(x as ReasonItem, lang))).join("; ");
  } catch {
    return "";
  }
}

const proposal: NotificationRenderer = ({ params, lang }) => {
  const t = scalingT.tFor(lang);
  const trader = str(params.trader);
  const to = str(params.to);
  const actor = str(params.actor);
  if (!trader || !to || !actor) return null;
  const action = t(`action.${scalingActionCode(String(params.actionCode ?? ""))}`).toLowerCase();
  const head = params.source === "auto" ? t("notify.proposalAuto") : t("notify.proposalBy", { actor });
  const reasons = reasonsText(str(params.reasonsJson), lang);
  return {
    title: t("notify.proposalTitle", { trader, action, from: tierOrNone(str(params.from), lang), to }),
    body: reasons ? t("notify.withReasons", { text: head, reasons: preview(reasons, 160) }) : head,
  };
};

const decision: NotificationRenderer = ({ params, lang, variant }) => {
  const t = scalingT.tFor(lang);
  const trader = str(params.trader);
  const to = str(params.to);
  const actor = str(params.actor);
  if (!trader || !to || !actor) return null;
  const approved = params.approved === 1;
  const change = scalingChange(String(params.actionCode ?? ""), to, lang);
  const comment = str(params.comment);
  let body: string;
  if (approved) {
    const limits = tierLimitsText(params, lang);
    body = t("notify.approvedBody", { change, actor })
      + (limits ? t("notify.newLimits", { limits }) : "")
      + (comment ? t("notify.quoteAfterApproved", { comment: preview(comment, 120) }) : "");
  } else {
    body = t("notify.rejectedBody", { change, actor }) + (comment ? t("notify.quoteAfterRejected", { comment: preview(comment, 160) }) : "");
  }
  const title = variant === "staff"
    ? t(approved ? "notify.staffApproved" : "notify.staffRejected", { trader })
    : t(approved ? "notify.approvedTitle" : "notify.rejectedTitle");
  return { title, body };
};

export const scalingRenderers: Record<string, NotificationRenderer> = {
  scaling_proposal: proposal,
  scaling_decision: decision,
};
