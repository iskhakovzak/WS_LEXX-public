/**
 * Risk / limits / PropReports sync notifications, rendered per reader (texts: `risk` and `propreports` namespaces).
 *   risk_warn / risk_breach   RiskNoticeParams (snapshot numbers) + variant "trader" | "staff"
 *   limit_change              variant "manual" { actor, reason?, b_* / a_* limits } | "template" { actor, tier, resync, reason?, b_* / a_* }
 *                             | "assign" (scaling page) { actor, from?, to, daily?, weekly?, dd?, comment? }
 *   risk_repeat_breach        { trader, days, prior (dates, comma-separated), state, used, limit }
 *   risk_breach_review        { actor, date (YYYY-MM-DD), reasonCode, consequenceCode, actions? (user text) }
 *   sync                      SyncNoticeParams;   sync_unmatched  { count, accounts, more? }
 * Names, tier names typed by staff, reasons and agreed actions are user content (never translated).
 */
import type { NotificationRenderer } from "../notificationText";
import {
  haltedStopText, limitsDiff, limitsFromParams, preview, riskNotice, riskSnapshotFromParams, syncText, unmatchedText,
  type SyncNoticeParams,
} from "../notifyEventsCore";
import { riskT, scalingT } from "../../i18n/ns";
import { tierLimitsText, tierOrNone } from "./scaling";

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

const riskStop: NotificationRenderer = ({ params, lang, variant }) => {
  const snap = riskSnapshotFromParams(params);
  const n = snap ? riskNotice(snap, lang) : null;
  if (!n) return null;
  return variant === "staff" ? { title: n.staffTitle, body: n.staffBody } : { title: n.traderTitle, body: n.traderBody };
};

const limitChange: NotificationRenderer = ({ params, lang, variant }) => {
  const t = riskT.tFor(lang);
  const actor = str(params.actor);
  if (!actor) return null;
  const diff = limitsDiff(limitsFromParams(params, "b_"), limitsFromParams(params, "a_"), lang);
  const reason = str(params.reason);
  let title: string;
  let text: string;
  if (variant === "assign") {
    // Direct tier assignment from the scaling page.
    const to = str(params.to);
    if (!to) return null;
    const ts = scalingT.tFor(lang);
    const limits = tierLimitsText(params, lang);
    const comment = str(params.comment);
    return {
      title: ts("notify.assignTitle", { from: tierOrNone(str(params.from), lang), to }),
      body: ts("notify.assignBody", { actor, tier: to }) + (limits ? ts("notify.limits", { limits }) : "") + (comment ? ts("notify.quoteAfterApproved", { comment: preview(comment, 120) }) : ""),
    };
  }
  if (variant === "template") {
    const tier = str(params.tier);
    if (!tier) return null;
    title = params.resync === 1 ? t("notify.limits.templateResync", { actor, tier }) : t("notify.limits.templateApplied", { tier });
    text = diff.length ? diff.join("; ") : t("notify.limits.templateNone");
  } else {
    title = t("notify.limits.title", { actor });
    text = diff.length ? diff.join("; ") : t("notify.limits.none");
  }
  return { title, body: reason ? t("notify.limits.withReason", { text, reason }) : text };
};

const repeatBreach: NotificationRenderer = ({ params, lang }) => {
  const trader = str(params.trader);
  const state = str(params.state);
  const used = num(params.used);
  const limit = num(params.limit);
  if (!trader || !state || used === undefined || limit === undefined) return null;
  const stop = haltedStopText(state, used, limit, lang);
  if (!stop) return null;
  const t = riskT.tFor(lang);
  return {
    title: t("notify.repeat.title", { trader, days: num(params.days) ?? 0 }),
    body: t("notify.repeat.body", { label: stop.label, message: stop.message, prior: str(params.prior) ?? "" }),
  };
};

const breachReview: NotificationRenderer = ({ params, lang, date }) => {
  const actor = str(params.actor);
  const reasonKey = str(params.reasonCode);
  const consKey = str(params.consequenceCode);
  if (!actor || !reasonKey || !consKey) return null;
  const t = riskT.tFor(lang);
  const reason = riskT.tryFor(lang, `breach.reason.${reasonKey}`) ?? reasonKey;
  const consequence = riskT.tryFor(lang, `breach.consequence.${consKey}`) ?? consKey;
  const actions = str(params.actions);
  return {
    title: t("notify.review.title", { date: str(params.date) ? date(str(params.date), "dayMonth") : "" }).trim(),
    body: t("notify.review.body", { actor, reason, consequence, agreed: actions ? t("notify.review.agreed", { actions }) : "" }),
  };
};

const sync: NotificationRenderer = ({ params, lang }) => {
  if (params.kind !== "import" && params.kind !== "sync") return null;
  const n = (k: string) => num(params[k]) ?? 0;
  const p: SyncNoticeParams = {
    kind: params.kind, context: str(params.context), errorText: str(params.errorText),
    inserted: n("inserted"), updated: n("updated"), unchanged: n("unchanged"), skipped: n("skipped"), conflicts: n("conflicts"), errors: n("errors"),
  };
  const r = syncText(p, lang);
  return { title: r.title, body: r.message };
};

const syncUnmatched: NotificationRenderer = ({ params, lang }) => {
  const count = num(params.count);
  const accounts = str(params.accounts);
  if (!count || !accounts) return null;
  const r = unmatchedText({ count, accounts, more: num(params.more) }, lang);
  return { title: r.title, body: r.message };
};

export const riskRenderers: Record<string, NotificationRenderer> = {
  risk_warn: riskStop,
  risk_breach: riskStop,
  limit_change: limitChange,
  risk_repeat_breach: repeatBreach,
  risk_breach_review: breachReview,
  sync,
  sync_unmatched: syncUnmatched,
};
