/**
 * Server-side i18n. Same dictionary pattern as the frontend (src/i18n/<lang>/<ns>.ts, RU is the source,
 * EN/UZ `satisfies Messages<typeof ru>`), but every language is imported statically.
 *
 *   // src/i18n/ns.ts or next to the route
 *   export const commonT = defineNamespace(ru, { en, uz });
 *
 *   // texts generated on read → the request language
 *   const t = commonT.tFor(langOf(req));
 *   res.json({ title: t("summary.title") });                 // (errors: throw AppError, see lib/http)
 *
 *   // texts stored or sent later (notifications, Telegram, digests) → the RECIPIENT's language
 *   const t = commonT.tFor(await localeOfUser(recipientName));
 *
 * Request language: `requestLang` middleware (after authMiddleware) sets `req.lang` from the `X-Lang` header,
 * else the user's `users.locale`, else "ru". `langOf(req)` works even where the middleware is not mounted.
 */
import type { Request, Response, NextFunction } from "express";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import { translate, lookup, renderEntry, isLang, DEFAULT_LANG, type Dict, type Lang, type Params, type TFunction } from "./core";

export * from "./core";

declare global {
  namespace Express {
    interface Request {
      /** UI language of this request (requestLang middleware). Prefer `langOf(req)`. */
      lang?: Lang;
    }
  }
}

export type ServerNamespace<D extends Dict> = {
  /** Typed translator for one language. */
  tFor: (lang: Lang | null | undefined) => TFunction<D>;
  /** For keys built at runtime (enum codes): text or undefined. */
  tryFor: (lang: Lang | null | undefined, key: string, params?: Params) => string | undefined;
  /** Raw template(s) of a key in `lang` (RU fallback); plural entries → every form. Undefined when missing. */
  templatesFor: (lang: Lang | null | undefined, key: string) => string[] | undefined;
};

export function defineNamespace<D extends Dict>(ru: D, others: { en: Dict; uz: Dict }): ServerNamespace<D> {
  const dicts: Record<Lang, Dict> = { ru, en: others.en, uz: others.uz };
  const tFor = (lang: Lang | null | undefined): TFunction<D> => {
    const l = isLang(lang) ? lang : DEFAULT_LANG;
    return ((key: string, params?: Params) => translate({ ru, current: dicts[l] }, l, key, params)) as unknown as TFunction<D>;
  };
  const tryFor = (lang: Lang | null | undefined, key: string, params?: Params) => {
    const l = isLang(lang) ? lang : DEFAULT_LANG;
    const own = l === "ru" ? undefined : lookup(dicts[l], key);
    if (own !== undefined) return renderEntry(own, l, params);
    const base = lookup(ru, key);
    return base === undefined ? undefined : renderEntry(base, "ru", params);
  };
  const templatesFor = (lang: Lang | null | undefined, key: string) => {
    const l = isLang(lang) ? lang : DEFAULT_LANG;
    const e = (l === "ru" ? undefined : lookup(dicts[l], key)) ?? lookup(ru, key);
    if (e === undefined) return undefined;
    return typeof e === "string" ? [e] : Object.values(e).filter((x): x is string => typeof x === "string");
  };
  return { tFor, tryFor, templatesFor };
}

/** "en", "EN", "en-US", "uz-Latn" → Lang; anything else → null. */
export function parseLang(v: unknown): Lang | null {
  if (typeof v !== "string") return null;
  const base = v.trim().toLowerCase().split(/[-_]/)[0];
  return isLang(base) ? base : null;
}

// ─── users.locale ────────────────────────────────────────────────────────────────────────────────────────

let localeColumnEnsured: Promise<void> | null = null;
/** Idempotent safety net next to the migrate.ts step (a route may run before migrations on a fresh DB). */
export function ensureLocaleColumn(): Promise<void> {
  if (!localeColumnEnsured) {
    localeColumnEnsured = pool
      .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT 'ru'`)
      .then(() => undefined)
      .catch((err) => {
        localeColumnEnsured = null;
        throw err;
      });
  }
  return localeColumnEnsured;
}

const CACHE_TTL_MS = 5 * 60_000;
const byId = new Map<number, { lang: Lang; at: number }>();
const byName = new Map<string, { lang: Lang; at: number }>();

/** Remember a user's language after it changed (PATCH /users/me/locale). */
export function rememberLocale(user: { id?: number; name?: string }, lang: Lang): void {
  const at = Date.now();
  if (user.id != null) byId.set(user.id, { lang, at });
  if (user.name) byName.set(user.name, { lang, at });
}

/** A user's saved language (by id or name), cached for a few minutes. Unknown user / error → "ru". */
export async function localeOfUser(who: number | string | null | undefined): Promise<Lang> {
  if (who == null || who === "") return DEFAULT_LANG;
  const cache = typeof who === "number" ? byId : byName;
  const hit = cache.get(who as never);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.lang;
  try {
    await ensureLocaleColumn();
    const { rows } = await pool.query<{ id: number; name: string; locale: string | null }>(
      typeof who === "number" ? `SELECT id, name, locale FROM users WHERE id = $1 LIMIT 1` : `SELECT id, name, locale FROM users WHERE name = $1 LIMIT 1`,
      [who],
    );
    const row = rows[0];
    const lang = parseLang(row?.locale) ?? DEFAULT_LANG;
    if (row) rememberLocale({ id: row.id, name: row.name }, lang);
    return lang;
  } catch (err) {
    logger.warn({ err }, "i18n: users.locale lookup failed");
    return DEFAULT_LANG;
  }
}

// ─── Request language ────────────────────────────────────────────────────────────────────────────────────

/** The request's UI language: req.lang (middleware) → X-Lang header → "ru". Synchronous. */
export function langOf(req: Request): Lang {
  return req.lang ?? parseLang(req.get?.("x-lang")) ?? DEFAULT_LANG;
}

/**
 * Express middleware (mount after authMiddleware): `X-Lang` → users.locale of the signed-in member → "ru".
 * Adds `Vary: X-Lang` so caches never mix languages. Never fails the request.
 */
export async function requestLang(req: Request, res: Response, next: NextFunction): Promise<void> {
  let lang = parseLang(req.get("x-lang"));
  const user = req.authUser;
  if (!lang && user && user.role !== "guest" && user.id > 0) lang = await localeOfUser(user.id);
  req.lang = lang ?? DEFAULT_LANG;
  res.vary("X-Lang");
  next();
}
