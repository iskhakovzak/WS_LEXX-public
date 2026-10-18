/**
 * rule_violation notifications (lib/rulesEngine scanner, routes/rules.ts curator decision), texts in the `rules`
 * namespace (`notify.*`). Variants (params.variant):
 *   one / oneStaff    { rule, trader?, vkey + v_* (violation reason as data, lib/rulesI18n), message (RU fallback) }
 *   many / manyStaff  { count, ruleList (up to 3 rule names, one per line), more, trader? }
 *   decision          { decision: "dismissed" | "upheld", rule?, consequence?, comment?, vkey + v_* | message }
 * Rule names, comments and consequences are user content (never translated); previews are cut at creation.
 */
import type { NotificationRenderer } from "../notificationText";
import { preview } from "../notifyEventsCore";
import { RULE_LIST_SEP, renderViolation, rulesT, violationMsgFromParams } from "../rulesI18n";

const reasonText = (params: Record<string, unknown>, lang: Parameters<typeof renderViolation>[1]): string => {
  const msg = violationMsgFromParams(params);
  const text = msg ? renderViolation(msg, lang) : undefined;
  return text ?? (typeof params.message === "string" ? params.message : "");
};

const ruleViolation: NotificationRenderer = ({ params, lang, variant }) => {
  const t = rulesT.tFor(lang);
  const rule = typeof params.rule === "string" && params.rule ? params.rule : null;
  const trader = typeof params.trader === "string" ? params.trader : "";
  switch (variant) {
    case "one":
    case "oneStaff": {
      if (!rule) return null;
      const title = variant === "oneStaff" ? t("notify.oneStaff", { rule, trader }) : t("notify.one", { rule });
      return { title, body: preview(reasonText(params, lang), 160) };
    }
    case "many":
    case "manyStaff": {
      const count = Number(params.count);
      if (!Number.isFinite(count) || count < 2) return null;
      const names = typeof params.ruleList === "string" ? params.ruleList.split(RULE_LIST_SEP).filter(Boolean) : [];
      const rules = names.map((n) => (lang === "en" ? `“${n}”` : `«${n}»`)).join(", ");
      const more = Number(params.more ?? 0);
      const title = variant === "manyStaff" ? t("notify.manyStaff", { count, trader }) : t("notify.many", { count });
      return { title, body: more > 0 ? t("notify.rulesMore", { rules, more }) : rules };
    }
    case "decision": {
      const decision = params.decision === "dismissed" ? "dismissed" : params.decision === "upheld" ? "upheld" : null;
      if (!decision) return null;
      const title = t(decision === "dismissed" ? "notify.dismissed" : "notify.upheld", { rule: rule ?? t("notify.ruleFallback") });
      const consequence = typeof params.consequence === "string" && params.consequence ? t("notify.consequence", { consequence: params.consequence }) : null;
      const comment = typeof params.comment === "string" && params.comment ? params.comment : null;
      const body = [consequence, comment].filter(Boolean).join(" · ") || reasonText(params, lang);
      return { title, body: preview(body, 160) };
    }
    default:
      return null;
  }
};

export const rulesRenderers: Record<string, NotificationRenderer> = {
  rule_violation: ruleViolation,
};
