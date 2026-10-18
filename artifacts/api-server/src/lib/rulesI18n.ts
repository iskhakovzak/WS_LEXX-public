/**
 * `rules` namespace (src/i18n/{ru,en,uz}/rules.ts) and violation texts as data.
 *
 * A violation reason is produced as `{ key, params }` (lib/rulesEval) and stored in rule_violations.details.msg; the
 * Russian rendering stays in rule_violations.message as the fallback for older rows and readers. Readers render it in
 * their language with `violationMessage(row.message, row.details, lang)`.
 *
 * Param conventions (raw values are stored, formatting happens on render):
 *   • `…Usd` (number) → trading money format `$1,234` (absolute value, same in every language);
 *   • `qty`, `limitQty` (number) → count with the reader's grouping;
 *   • `how` ("" | "desk" | "pct" | "capPct") → the limit-source suffix (`violation.how.*`, uses `pct`, `capitalUsd`);
 *   • anything else is inserted as is (tickers, days, clock times, small numbers).
 */
import { defineNamespace, formatCountFor, isLang, DEFAULT_LANG, type Lang, type Params } from "../i18n";
import ru from "../i18n/ru/rules";
import en from "../i18n/en/rules";
import uz from "../i18n/uz/rules";

export const rulesT = defineNamespace(ru, { en, uz });

export type ViolationMsg = { key: string; params: Record<string, string | number> };

/** Separator of rule names packed into one notification param (names are single-line previews). */
export const RULE_LIST_SEP = "\n";

/** `$1,234` — whole dollars, absolute value (the sign is part of the template). */
export const usdAbs = (v: number) => `$${Math.round(Math.abs(v)).toLocaleString("en-US")}`;

function isMsg(v: unknown): v is ViolationMsg {
  return !!v && typeof v === "object" && typeof (v as ViolationMsg).key === "string" && !!(v as ViolationMsg).params && typeof (v as ViolationMsg).params === "object";
}

/** Render a violation reason in `lang`. Unknown key → undefined. */
export function renderViolation(msg: ViolationMsg, lang: Lang | null | undefined): string | undefined {
  const l: Lang = isLang(lang) ? lang : DEFAULT_LANG;
  const raw = msg.params ?? {};
  const p: Params = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined) continue;
    if (/Usd$/.test(k) && typeof v === "number") p[k] = usdAbs(v);
    else if ((k === "qty" || k === "limitQty") && typeof v === "number") p[k] = formatCountFor(l, v);
    else p[k] = v;
  }
  const how = typeof raw.how === "string" && raw.how ? rulesT.tryFor(l, `violation.how.${raw.how}`, p) : "";
  p.how = how ?? "";
  return rulesT.tryFor(l, `violation.${msg.key}`, p);
}

/** Text of a stored violation for a reader: details.msg rendered in `lang`, else the stored (Russian) message. */
export function violationMessage(message: string | null | undefined, details: unknown, lang: Lang | null | undefined): string {
  const msg = details && typeof details === "object" ? (details as { msg?: unknown }).msg : undefined;
  if (isMsg(msg)) {
    const text = renderViolation(msg, lang);
    if (text !== undefined) return text;
  }
  return String(message ?? "");
}

/** Flatten a violation msg into scalar notification params (`vkey`, `v_<param>`), see notificationRenderers/rules.ts. */
export function violationMsgParams(msg: ViolationMsg | undefined): Record<string, string | number> {
  if (!msg) return {};
  const out: Record<string, string | number> = { vkey: msg.key };
  for (const [k, v] of Object.entries(msg.params)) if (v !== null && v !== undefined) out[`v_${k}`] = v;
  return out;
}

/** Inverse of violationMsgParams. */
export function violationMsgFromParams(params: Record<string, unknown>): ViolationMsg | undefined {
  if (typeof params.vkey !== "string" || !params.vkey) return undefined;
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params)) {
    if (!k.startsWith("v_")) continue;
    if (typeof v === "string" || typeof v === "number") out[k.slice(2)] = v;
  }
  return { key: params.vkey, params: out };
}
