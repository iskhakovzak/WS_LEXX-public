/**
 * Notifications as data (ARCHITECTURE.md §0.5, data.md Phase 7): producers store `type` + `params` (jsonb); the text is
 * rendered in the READER's language from the server `notifications` namespace:
 *   • in-app list → request language (routes/notifications.ts presentNotification);
 *   • Telegram / digests → the recipient's users.locale (notifyUser → localeOfUser).
 * Rows without params (written before, or by producers not converted yet) keep their stored Russian title/message.
 *
 * Params are data (names, tickers, setup and stage names, numbers, user-typed previews) and are never translated.
 *
 * ── Adding a type (usually dictionary only, no code here) ──────────────────────────────────────────────────
 * Generic rendering: `src/i18n/{ru,en,uz}/notifications.ts` gets an entry `<type>: { title, body?, tg? }`
 * (strings or plural entries). Optional variants: `<type>.<variant>.{title,body,tg}`, picked by `params.variant`
 * (a missing field falls back to the top-level one). Param conventions:
 *   • `<name>Code` (string)  → `{<name>}` = text of `<type>.<name>.<code>` (enum codes: status, state, action…);
 *   • `<name>Date` ("YYYY-MM-DD" or ISO) → `{<name>}` = that date in the reader's language ("17 окт." / "Oct 17");
 *   • `count` (number) selects the plural form; other numbers are inserted as is; money / R / prices are passed
 *     preformatted (the trading format is the same in every language).
 * If a template needs a param that is missing, the renderer returns null and the stored RU text is shown.
 * `tg` is Telegram HTML (params are HTML-escaped); without it Telegram gets "<title>\n<body>".
 *
 * Custom logic (lists, joined parts): add a renderer map in `lib/notificationRenderers/<area>.ts`
 * (`export const <area>Renderers: Record<string, NotificationRenderer>`, `import type` from this file only) and
 * spread it into CUSTOM below.
 */
import { notificationsT } from "../i18n/ns";
import { personNameFor } from "./people/latinNames";
import { fmtDateFor } from "../i18n/format";
import type { Lang, Params } from "../i18n";
import { rulesRenderers } from "./notificationRenderers/rules";
import { riskRenderers } from "./notificationRenderers/risk";
import { scalingRenderers } from "./notificationRenderers/scaling";
import { discussionsRenderers } from "./notificationRenderers/discussions";
import { reviewRenderers } from "./notificationRenderers/review";
import { academyRenderers } from "./notificationRenderers/academy";
import { academyCohortsRenderers } from "./notificationRenderers/academyCohorts";
import { academyContentRenderers } from "./notificationRenderers/academyContent";

export type NotificationParams = Record<string, string | number | boolean | null | undefined>;
export type RenderedNotification = { title: string; body: string; telegram: string };

/** Context handed to a custom renderer. `p` = plain params, `h` = HTML-escaped params (for Telegram templates). */
export type RenderCtx = {
  type: string;
  params: NotificationParams;
  lang: Lang;
  /** Params after the Code/Date conventions (plain). */
  p: Params;
  /** Same, HTML-escaped (Telegram templates). */
  h: Params;
  variant: string;
  /** Translate a notifications key; undefined when the key is missing (then return null). */
  tr: (key: string, p?: Params) => string | undefined;
  /** Date in the reader's language (see i18n/format.ts). */
  date: (d: string | Date | null | undefined, style?: Parameters<typeof fmtDateFor>[2]) => string;
};
export type NotificationRenderer = (ctx: RenderCtx) => { title?: string; body?: string; telegram?: string } | null;

export const escapeHtml = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const esc = escapeHtml;

function clean(p: NotificationParams, html = false): Params {
  const out: Params = {};
  for (const [k, v] of Object.entries(p)) {
    if (v === null || v === undefined || typeof v === "boolean") continue;
    out[k] = typeof v === "number" ? v : html ? esc(v) : String(v);
  }
  return out;
}

const PLACEHOLDER = /\{(\w+)\}/g;

function hasAllParams(lang: Lang, key: string, p: Params): boolean {
  const tpls = notificationsT.templatesFor(lang, key);
  if (!tpls) return false;
  for (const t of tpls) for (const m of t.matchAll(PLACEHOLDER)) if (p[m[1]] === undefined) return false;
  return true;
}

/** Expand the `<name>Code` / `<name>Date` conventions. Null when a code has no text. */
/** Params that carry a person's stored name: shown as the Latin name for EN/UZ readers (lib/people/latinNames). */
const PERSON_PARAMS = new Set(["actor", "user", "author", "trader", "who", "curator", "mentor", "student", "reviewer", "owner", "sender", "acker"]);

function withPersonNames(params: NotificationParams, lang: Lang): NotificationParams {
  if (lang === "ru") return params;
  let out: NotificationParams | null = null;
  for (const k of PERSON_PARAMS) {
    const v = params[k];
    if (typeof v !== "string" || !v) continue;
    const shown = personNameFor(v, lang);
    if (shown !== v) (out ??= { ...params })[k] = shown;
  }
  return out ?? params;
}

function expand(type: string, params: NotificationParams, lang: Lang, html: boolean, strict = true): Params | null {
  const out = clean(withPersonNames(params, lang), html);
  for (const [k, v] of Object.entries(params)) {
    if (typeof v !== "string" || !v) continue;
    const code = /^(\w+)Code$/.exec(k);
    if (code) {
      const text = notificationsT.tryFor(lang, `${type}.${code[1]}.${v}`, out);
      if (text === undefined) {
        if (strict) return null;
        continue;
      }
      out[code[1]] = text;
      continue;
    }
    const date = /^(\w+)Date$/.exec(k);
    if (date && out[date[1]] === undefined) out[date[1]] = fmtDateFor(lang, v, "dayMonth");
  }
  return out;
}

/** Generic path: `<type>[.<variant>].{title,body,tg}` from the dictionary. */
function renderGeneric(type: string, params: NotificationParams, lang: Lang): RenderedNotification | null {
  const variant = typeof params.variant === "string" && /^\w+$/.test(params.variant) ? params.variant : "";
  const p = expand(type, params, lang, false);
  const h = expand(type, params, lang, true);
  if (!p || !h) return null;
  const pick = (field: string): string | null => {
    if (variant && notificationsT.templatesFor(lang, `${type}.${variant}.${field}`)) return `${type}.${variant}.${field}`;
    return notificationsT.templatesFor(lang, `${type}.${field}`) ? `${type}.${field}` : null;
  };
  const titleKey = pick("title");
  if (!titleKey || !hasAllParams(lang, titleKey, p)) return null;
  const bodyKey = pick("body");
  if (bodyKey && !hasAllParams(lang, bodyKey, p)) return null;
  const tgKey = pick("tg");
  const title = notificationsT.tryFor(lang, titleKey, p);
  if (!title) return null;
  const body = bodyKey ? (notificationsT.tryFor(lang, bodyKey, p) ?? "") : "";
  const telegram = tgKey && hasAllParams(lang, tgKey, h) ? notificationsT.tryFor(lang, tgKey, h) : undefined;
  return { title, body, telegram: telegram ?? (body ? `${esc(title)}\n${esc(body)}` : esc(title)) };
}

// ─── custom renderers (types whose text needs code) ─────────────────────────────────────────────────────

const challenge: NotificationRenderer = ({ type, params, p, tr, variant }) => {
  const outcome = String(params.outcome ?? (type === "academy_challenge_passed" ? "passed" : "failed"));
  const own = tr(outcome === "passed" ? "academy_challenge.passedTitle" : outcome === "expired" ? "academy_challenge.expiredTitle" : "academy_challenge.failedTitle", p);
  if (!own) return null;
  return {
    title: variant === "staff" ? tr("academy_challenge.staffTitle", { ...p, title: own }) : own,
    body: outcome === "passed" ? tr("academy_challenge.passedBody", { ...p, count: Number(params.days ?? 0) }) : String(params.reason ?? ""),
  };
};

const BUILTIN: Record<string, NotificationRenderer> = {
  mention: ({ p, tr }) => ({ title: tr(p.subject ? "mention.titleWith" : "mention.title", p), body: tr("mention.body", p) }),
  idea_submitted: ({ p, tr }) => ({ title: tr("idea_submitted.title", p), body: tr(p.setup ? "idea_submitted.bodyWithSetup" : "idea_submitted.body", p) }),
  idea_comment: ({ p, h, tr, variant }) => {
    // variant "private" = private reply to the idea's author; "traderReply" = the author's reply to their staff.
    const v = variant === "private" || variant === "traderReply" ? `idea_comment.${variant}` : "idea_comment";
    return { title: tr(`${v}.title`, p), body: tr(`${v}.body`, p), telegram: tr(`${v === "idea_comment" ? v : "idea_comment.private"}.tg`, h) };
  },
  idea_review: ({ params, p, h, tr }) => {
    const status = tr(`idea_review.status.${String(params.status ?? "")}`, {});
    if (!status) return null;
    return {
      title: tr("idea_review.title", { ...p, status }),
      body: tr(p.reason ? "idea_review.bodyWithReason" : "idea_review.body", { ...p, status }),
      telegram: tr(p.reason ? "idea_review.tgWithReason" : "idea_review.tg", { ...h, status }),
    };
  },
  academy_promotion_ready: ({ p, tr, variant }) => {
    const staff = variant === "staff";
    return {
      title: tr(staff ? "academy_promotion_ready.staffTitle" : "academy_promotion_ready.title", p),
      body: tr(staff ? "academy_promotion_ready.staffBody" : "academy_promotion_ready.body", p),
    };
  },
  academy_challenge_passed: challenge,
  academy_challenge_failed: challenge,
};

/** Area renderer maps are spread in here (see the header). */
const CUSTOM: Record<string, NotificationRenderer> = {
  ...BUILTIN,
  ...rulesRenderers,
  ...riskRenderers,
  ...scalingRenderers,
  ...discussionsRenderers,
  ...reviewRenderers,
  ...academyRenderers,
  ...academyCohortsRenderers,
  ...academyContentRenderers,
};

/**
 * Renders a stored notification. Returns null for a type/params combination this renderer does not know (the caller
 * then falls back to the stored title/message).
 */
export function renderNotification(type: string, params: NotificationParams | null | undefined, lang: Lang): RenderedNotification | null {
  if (!params || typeof params !== "object") return null;
  const custom = CUSTOM[type];
  if (!custom) return renderGeneric(type, params, lang);
  // Custom renderers resolve their own codes: a `<name>Code` without a dictionary entry is not an error here.
  const p = expand(type, params, lang, false, false)!;
  const h = expand(type, params, lang, true, false)!;
  // Custom renderers read `params` directly: hand them the person names as this reader sees them (stored row unchanged).
  const r = custom({
    type,
    params: withPersonNames(params, lang),
    lang,
    p,
    h,
    variant: typeof params.variant === "string" ? params.variant : "",
    tr: (key, kp) => notificationsT.tryFor(lang, key, kp ?? {}),
    date: (d, style) => fmtDateFor(lang, d ?? null, style),
  });
  if (!r || !r.title || r.body === undefined) return null;
  return { title: r.title, body: r.body, telegram: r.telegram ?? (r.body ? `${esc(r.title)}\n${esc(r.body)}` : esc(r.title)) };
}

/** Types with a custom renderer (others render generically when the dictionary has `<type>.title`). */
export const RENDERED_TYPES = Object.keys(CUSTOM);
