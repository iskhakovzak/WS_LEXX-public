import { Router, type IRouter, type Request } from "express";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { z } from "zod";
import { hashPassword, verifyPassword, bumpTokenVersion, requireMember, isGuestUser, signToken } from "../lib/auth";
import { sendSecurityError } from "../lib/security/respond";
import { checkSecret, secretPolicyFor, type SecretProblem } from "../lib/security/passwordPolicy";
import { lockoutStore } from "../lib/security/loginGuard";
import { securityT } from "../lib/security/i18n";
import { can, requireCap } from "../lib/permissions";
import { logger } from "../lib/logger";
import { ensureLocaleColumn, langOf, parseLang, rememberLocale } from "../i18n";
import { cleanNameLatin, ensureNameLatin, loadDirectory, saveLatinNames, searchPeople } from "../lib/peopleDirectory";
import { reloadLatinNames } from "../lib/people/latinNames";
import { AppError, badRequest, forbidden, notFound, unauthorized } from "../lib/http";

const router: IRouter = Router();

const USER_COLUMNS = `id, name, role, active,
  COALESCE(theme, 'dark') AS theme,
  COALESCE(banned, false) AS banned,
  banned_at AS "bannedAt",
  banned_reason AS "bannedReason",
  created_at AS "createdAt"`;

/** USER_COLUMNS + the optional Latin alias (users.name_latin) once the column is known to exist. */
async function userColumns(): Promise<string> {
  try {
    await ensureNameLatin();
    return `${USER_COLUMNS}, name_latin AS "nameLatin"`;
  } catch {
    return USER_COLUMNS; // never break the login screen over an optional column
  }
}

function normalizeRole(r: unknown): string {
  if (r === "admin") return "admin";
  if (r === "curator") return "curator";
  return "trader";
}

function parseId(raw: unknown): number | null {
  const s = String(raw ?? "");
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * User management used to be gated by a shared "admin password" that was
 * hard-coded in the frontend bundle — i.e. any logged-in trader could create
 * users or reset anyone's password. Access is now derived from the caller's
 * JWT and their current role in the DB.
 */
// Permissions matrix (lib/permissions.ts; role from the DB): users.read.team = team list + moderation fields,
// users.manage = create/edit/deactivate traders & curators, users.manage.admins = anything touching admins.

/** Self, or users.manage acting on someone else. */
async function canActOnName(req: Request, name: string): Promise<boolean> {
  if (!req.authUser) return false;
  if (req.authUser.name === name) return true;
  return can(req, "users.manage", { trader: name });
}

/** Ban details (when/why) are moderation data: only staff may see them. `banned` stays: the login screen hides banned users. */
function stripModeration(rows: any[]): any[] {
  return rows.map(({ bannedAt: _ba, bannedReason: _br, ...rest }) => rest);
}

// Signed-in only (owner decision 2026-10-17: no roster before sign-in — the login screen asks for a typed name).
// Moderation fields stay staff-only.
router.get("/users", asyncHandler(async (req, res): Promise<void> => {
  if (!req.authUser) throw unauthorized();
  const { rows } = await pool.query<any>(`
    SELECT ${await userColumns()}
    FROM users
    WHERE active = true
    ORDER BY created_at ASC
  `);
  res.json((await can(req, "users.read.team")) ? rows : stripModeration(rows));
}));

router.get("/users/all", asyncHandler(async (req, res): Promise<void> => {
  if (!req.authUser) throw unauthorized();
  const { rows } = await pool.query<any>(`
    SELECT ${await userColumns()}
    FROM users
    ORDER BY created_at ASC
  `);
  res.json((await can(req, "users.read.team")) ? rows : stripModeration(rows));
}));

router.patch("/users/theme", asyncHandler(async (req, res): Promise<void> => {
  const { name, theme } = req.body as { name?: string; theme?: string };
  if (!name || !theme) throw new AppError("VALIDATION");
  const allowed = ["dark", "dim", "sepia", "light"];
  if (!allowed.includes(theme)) throw new AppError("INVALID_FIELD", undefined, { field: "theme" });
  if (!(await canActOnName(req, name))) throw forbidden();
  await pool.query(`UPDATE users SET theme = $1 WHERE name = $2`, [theme, name]);
  res.json({ success: true });
}));

// NOTE: these must be declared before `/users/:id`, otherwise PATCH
// /users/tg-notifications is captured by the `:id` route and always fails.
router.patch("/users/tg-notifications", asyncHandler(async (req, res): Promise<void> => {
  const { name, enabled } = req.body as { name?: string; enabled?: boolean };
  if (!name || typeof enabled !== "boolean") throw new AppError("VALIDATION");
  if (!(await canActOnName(req, name))) throw forbidden();
  const { rowCount } = await pool.query(`UPDATE users SET tg_notifications_enabled = $1 WHERE name = $2`, [enabled, name]);
  if (!rowCount) throw notFound();
  res.json({ success: true, enabled });
}));

router.get("/users/tg-notifications", asyncHandler(async (req, res): Promise<void> => {
  const name = typeof req.query.name === "string" ? req.query.name : null;
  if (!name) throw new AppError("VALIDATION");
  const { rows } = await pool.query<any>(
    `SELECT COALESCE(tg_notifications_enabled, true) AS tg_notifications_enabled FROM users WHERE name = $1`, [name]
  );
  if (!rows[0]) throw notFound();
  res.json({ enabled: rows[0].tg_notifications_enabled as boolean });
}));

// ─── Self-service profile (Settings → Профиль) ───────────────────────────────

/** Caller's own profile: role, assignments, Telegram link state and activity. Never exposes secrets. */
router.get("/users/me/profile", asyncHandler(async (req, res): Promise<void> => {
  const me = req.authUser;
  if (!me) throw unauthorized();
  await ensureLocaleColumn().catch(() => {});
  const latinCol = await ensureNameLatin().then(() => `name_latin AS "nameLatin",`, () => "");
  const { rows } = await pool.query<any>(
    `SELECT id, name, role, active, ${latinCol}
            COALESCE(theme, 'dark') AS theme,
            COALESCE(locale, 'ru') AS locale,
            created_at AS "createdAt",
            (telegram_chat_id IS NOT NULL AND telegram_chat_id <> '') AS "telegramLinked",
            telegram_linked_at AS "telegramLinkedAt",
            COALESCE(tg_notifications_enabled, true) AS "tgNotificationsEnabled",
            assigned_curator AS "assignedCurator",
            assigned_risk_manager AS "assignedRiskManager",
            assigned_mentor AS "assignedMentor"
     FROM users WHERE id = $1 LIMIT 1`,
    [me.id],
  );
  const profile = rows[0];
  if (!profile) throw notFound();
  const since = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const { rows: statRows } = await pool
    .query<any>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE LEFT(date, 10) >= $2)::int AS last30,
              MIN(LEFT(date, 10)) AS "firstTrade",
              MAX(LEFT(date, 10)) AS "lastTrade"
       FROM trades WHERE trader = $1 AND deleted_at IS NULL`,
      [profile.name, since],
    )
    .catch(() => ({ rows: [] as any[] }));
  // Staff who have this user assigned to them (who do I look after?).
  const { rows: wards } = await pool.query<{ name: string }>(
    `SELECT name FROM users
     WHERE active = true AND (assigned_curator = $1 OR assigned_risk_manager = $1 OR assigned_mentor = $1)
     ORDER BY name`,
    [profile.name],
  );
  res.json({
    ...profile,
    stats: statRows[0] ?? { total: 0, last30: 0, firstTrade: null, lastTrade: null },
    wards: wards.map((w) => w.name),
  });
}));

// ─── Interface language (users.locale) ────────────────────────────────────────
// PATCH /users/me/locale { locale: "ru" | "en" | "uz" } → { locale }. Members only (guests keep it in the browser).
// Read back via GET /auth/me (`locale`) and GET /users/me/profile. Server texts follow X-Lang → users.locale (i18n/).
router.patch("/users/me/locale", asyncHandler(async (req, res): Promise<void> => {
  if (!requireMember(req, res)) return;
  const raw = (req.body as { locale?: unknown } | undefined)?.locale;
  const locale = typeof raw === "string" && raw.length <= 10 ? parseLang(raw) : null;
  if (!locale) throw badRequest("INVALID_LOCALE", undefined, { value: String(raw ?? "").slice(0, 20) });
  await ensureLocaleColumn();
  const me = req.authUser!;
  await pool.query(`UPDATE users SET locale = $1 WHERE id = $2`, [locale, me.id]);
  rememberLocale({ id: me.id, name: me.name }, locale);
  res.json({ locale });
}));

// ─── Own Latin name (users.name_latin) ──────────────────────────────────────
// PATCH /users/me/name-latin { nameLatin: string | null } → { ok, name, nameLatin }. Members only: people know their
// own spelling. Same validation as the admin edit (cleanNameLatin); audit «user.name_latin» with the user as actor.
router.patch("/users/me/name-latin", asyncHandler(async (req, res): Promise<void> => {
  if (!requireMember(req, res)) return;
  const cleaned = cleanNameLatin((req.body as { nameLatin?: unknown } | undefined)?.nameLatin);
  if (!cleaned.ok) throw new AppError(cleaned.code, 400, cleaned.params);
  await ensureNameLatin();
  const me = req.authUser!;
  const changed = await saveLatinNames([{ id: me.id, name: me.name, nameLatin: cleaned.value }], me.name, { bulk: false });
  if (changed.length) await reloadLatinNames();
  res.json({ ok: true, name: me.name, nameLatin: cleaned.value });
}));

// ─── Personal settings (users.settings JSONB) — audit P1-7 ─────────────────────
// GET /users/me/settings → { settings: { tradingDefaults?: {...}, ... } }   (guest/anonymous-safe: {} for a guest)
// PUT /users/me/settings   { tradingDefaults?: {...} | null }  — top-level merge; null removes the key → { settings }
// The column is added idempotently on first use (additive, no migrate.ts change).

let settingsColumnEnsured: Promise<void> | null = null;
function ensureSettingsColumn(): Promise<void> {
  if (!settingsColumnEnsured) {
    settingsColumnEnsured = pool
      .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb`)
      .then(() => undefined)
      .catch((err) => {
        settingsColumnEnsured = null;
        throw err;
      });
  }
  return settingsColumnEnsured;
}
ensureSettingsColumn().catch((err) => logger.warn({ err }, "users: ensure settings column failed at init"));

const boundedNum = (min: number, max: number) => z.coerce.number().finite().min(min).max(max);
/** Mirrors edge-tracker components/settings/trading-defaults.ts (TRADING_DEFAULT_LIMITS). Unknown keys are dropped. */
const TradingDefaultsSchema = z.object({
  accountSize: boundedNum(0, 100_000_000),
  riskMode: z.enum(["pct", "usd"]),
  riskPct: boundedNum(0, 10),
  riskUsd: boundedNum(0, 1_000_000),
  commissionPerShare: boundedNum(0, 1),
  commissionMin: boundedNum(0, 100),
  leverageIntraday: boundedNum(1, 20),
  leverageOvernight: boundedNum(1, 20),
  defaultHorizon: z.enum(["intraday", "overnight", "swing"]),
  updatedAt: z.string().max(40).nullable(),
}).partial();
const SettingsPatch = z.object({
  tradingDefaults: TradingDefaultsSchema.nullable().optional(),
  /** Daily loop in Telegram (morning focus, evening card, contract alerts — lib/daily/telegramJobs). Absent = on. */
  dailyTelegram: z.boolean().optional(),
});

router.get("/users/me/settings", asyncHandler(async (req, res): Promise<void> => {
  const me = req.authUser;
  if (!me) throw unauthorized();
  if (isGuestUser(me)) { res.json({ settings: {} }); return; }
  await ensureSettingsColumn();
  const { rows } = await pool.query<{ settings: Record<string, unknown> | null }>(
    `SELECT settings FROM users WHERE id = $1 LIMIT 1`,
    [me.id],
  );
  if (!rows[0]) throw notFound();
  res.json({ settings: rows[0].settings ?? {} });
}));

router.put("/users/me/settings", asyncHandler(async (req, res): Promise<void> => {
  if (!requireMember(req, res)) return;
  const body = SettingsPatch.safeParse(req.body ?? {});
  if (!body.success) throw body.error;
  await ensureSettingsColumn();
  const set: Record<string, unknown> = {};
  const drop: string[] = [];
  if (body.data.tradingDefaults === null) drop.push("tradingDefaults");
  else if (body.data.tradingDefaults !== undefined) {
    set.tradingDefaults = { ...body.data.tradingDefaults, updatedAt: body.data.tradingDefaults.updatedAt ?? new Date().toISOString() };
  }
  if (body.data.dailyTelegram !== undefined) set.dailyTelegram = body.data.dailyTelegram;
  const { rows } = await pool.query<{ settings: Record<string, unknown> | null }>(
    `UPDATE users SET settings = (COALESCE(settings, '{}'::jsonb) - $2::text[]) || $1::jsonb
      WHERE id = $3 RETURNING settings`,
    [JSON.stringify(set), drop, req.authUser!.id],
  );
  if (!rows[0]) throw notFound();
  res.json({ settings: rows[0].settings ?? {} });
}));

/** Localized text for a secret-policy violation. */
function secretProblemText(req: Request, p: SecretProblem): string {
  const t = securityT.tFor(langOf(req));
  if (p.code === "TOO_SHORT") return t("password.tooShort", { min: p.min });
  if (p.code === "TOO_LONG") return t("password.tooLong", { max: p.max });
  return t("password.sameAsName");
}

// Small in-memory limiter so an open session can't be used to brute-force the current password.
const pwAttempts = new Map<number, { count: number; resetAt: number }>();
const PW_MAX_ATTEMPTS = 5;
const PW_WINDOW_MS = 15 * 60_000;

/**
 * Change own secret (Settings → Профиль, and the forced change right after a staff sign-in with a short password).
 * Requires the current secret; policy by role (lib/security/passwordPolicy: PIN ≥ 6 for traders, password ≥ 10 for
 * staff). Revokes every other session (token_version bump) and returns a fresh token for this one, so the forced
 * change continues straight into the app. Secrets are never logged.
 */
router.post("/users/me/password", asyncHandler(async (req, res): Promise<void> => {
  const me = req.authUser;
  if (!me) throw unauthorized();
  if (isGuestUser(me)) throw new AppError("GUEST_READ_ONLY");
  const t = securityT.tFor(langOf(req));
  const { currentPassword, newPassword } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof currentPassword !== "string" || typeof newPassword !== "string" || !currentPassword) {
    sendSecurityError(res, 400, "VALIDATION", t("password.required")); return;
  }
  const { rows } = await pool.query<{ password_hash: string | null; role: string; name: string }>(
    `SELECT password_hash, role, name FROM users WHERE id = $1 AND active = true LIMIT 1`,
    [me.id],
  );
  if (!rows[0]) throw notFound("USER_NOT_FOUND");
  const problem = checkSecret(rows[0].role, newPassword, rows[0].name);
  if (problem) { sendSecurityError(res, 400, "WEAK_PASSWORD", secretProblemText(req, problem), { policy: secretPolicyFor(rows[0].role) }); return; }
  if (newPassword === currentPassword) {
    sendSecurityError(res, 400, "SAME_PASSWORD", t("password.sameAsOld")); return;
  }
  const now = Date.now();
  const att = pwAttempts.get(me.id);
  if (att && att.resetAt > now && att.count >= PW_MAX_ATTEMPTS) {
    sendSecurityError(res, 429, "RATE_LIMITED", t("password.tooManyAttempts")); return;
  }
  const ok = await verifyPassword(currentPassword, { passwordHash: rows[0].password_hash });
  if (!ok) {
    const cur = att && att.resetAt > now ? att : { count: 0, resetAt: now + PW_WINDOW_MS };
    cur.count++;
    pwAttempts.set(me.id, cur);
    sendSecurityError(res, 400, "WRONG_PASSWORD", t("password.currentWrong")); return;
  }
  pwAttempts.delete(me.id);
  await pool.query(`UPDATE users SET password_hash = $1, must_change_secret = false WHERE id = $2`, [await hashPassword(newPassword), me.id]);
  await bumpTokenVersion(me.id);
  const token = await signToken({ id: me.id, name: rows[0].name, role: rows[0].role });
  res.json({ success: true, token, reloginRequired: false });
}));

// ─── Team overview (Settings → Команда, curator/admin) ───────────────────────

/**
 * One row per user with role, status, assignments, Telegram link state (boolean only — chat ids
 * are not exposed) and 30-day activity. Optional risk tier when the risk desk table exists.
 */
router.get("/users/team", asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireCap(req, res, "users.read.team", null, "Curator or admin role required"))) return;
  const since = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const { rows } = await pool.query<any>(
    `SELECT u.id, u.name, u.role, u.active,
            COALESCE(u.banned, false) AS banned,
            u.created_at AS "createdAt",
            (u.telegram_chat_id IS NOT NULL AND u.telegram_chat_id <> '') AS "telegramLinked",
            COALESCE(u.tg_notifications_enabled, true) AS "tgNotificationsEnabled",
            u.assigned_curator AS "assignedCurator",
            u.assigned_risk_manager AS "assignedRiskManager",
            u.assigned_mentor AS "assignedMentor",
            COALESCE(t.trades30, 0)::int AS "trades30",
            t.last_trade AS "lastTrade"
     FROM users u
     LEFT JOIN LATERAL (
       SELECT COUNT(*) FILTER (WHERE LEFT(tr.date, 10) >= $1) AS trades30,
              MAX(LEFT(tr.date, 10)) AS last_trade
       FROM trades tr
       WHERE tr.trader = u.name AND tr.deleted_at IS NULL
     ) t ON true
     ORDER BY u.active DESC, CASE u.role WHEN 'admin' THEN 0 WHEN 'curator' THEN 1 ELSE 2 END, u.name`,
    [since],
  );
  const { rows: tiers } = await pool
    .query<{ trader: string; tier: string | null }>(`SELECT trader, tier FROM trader_risk_limits`)
    .catch(() => ({ rows: [] as { trader: string; tier: string | null }[] }));
  const tierBy = new Map(tiers.map((t) => [t.trader, t.tier]));
  res.json(rows.map((r) => ({ ...r, riskTier: tierBy.get(r.name) ?? null })));
}));

/**
 * GET /users/directory?q=&limit=&all=1 — people the caller may see (lib/peopleDirectory: staff → everyone;
 * a trader → themselves, wards and staff), with Latin alias and curator. With `q` — ranked cross-script search
 * (RU / EN / UZ, keyboard-layout slips, typos): `{ people: [...hit, score, tier, matched] }`.
 */
router.get("/users/directory", asyncHandler(async (req, res): Promise<void> => {
  if (!req.authUser) throw unauthorized();
  const all = req.query.all === "1" && (await can(req, "users.read.team"));
  const people = await loadDirectory(req, { includeInactive: all });
  const q = typeof req.query.q === "string" ? req.query.q.slice(0, 120) : "";
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 200);
  if (!q.trim()) { res.json({ people: people.slice(0, req.query.limit ? limit : undefined) }); return; }
  res.json({ q, people: searchPeople(people, q, limit) });
}));

router.post("/users", asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireCap(req, res, "users.manage", null, "STAFF_ONLY"))) return;
  const adminMgr = await can(req, "users.manage.admins");
  const { name, password, role } = req.body as Record<string, unknown>;
  const cleanName = typeof name === "string" ? name.trim() : "";
  const cleanPassword = typeof password === "string" ? password : "";
  if (!cleanName || !cleanPassword.trim()) throw new AppError("VALIDATION");
  if (cleanName.length > 100) throw new AppError("INVALID_FIELD", undefined, { field: "name" });
  const userRole = normalizeRole(role);
  const weak = checkSecret(userRole, cleanPassword, cleanName);
  if (weak) { sendSecurityError(res, 400, "WEAK_PASSWORD", secretProblemText(req, weak), { policy: secretPolicyFor(userRole) }); return; }
  if (userRole === "admin" && !adminMgr) throw new AppError("ADMIN_ONLY");
  try {
    const passwordHash = await hashPassword(cleanPassword);
    const { rows } = await pool.query<any>(
      `INSERT INTO users (name, password_hash, role) VALUES ($1, $2, $3)
       RETURNING ${USER_COLUMNS}`,
      [cleanName, passwordHash, userRole]
    );
    res.status(201).json(rows[0]);
  } catch (e: any) {
    if (e.code === "23505") throw new AppError("USER_NAME_TAKEN");
    throw e;
  }
}));

router.patch("/users/:id", asyncHandler(async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) throw badRequest("INVALID_ID");
  if (!(await requireCap(req, res, "users.manage", null, "STAFF_ONLY"))) return;
  const adminMgr = await can(req, "users.manage.admins");
  const { rows: targetRows } = await pool.query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [id]);
  const target = targetRows[0];
  if (!target) throw notFound();
  if (target.role === "admin" && !adminMgr) throw new AppError("ADMIN_ONLY");

  const { name, password, role, active } = req.body as Record<string, unknown>;
  const fields: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  // `active` lets staff re-activate a user deactivated via DELETE (or deactivate, same rules as DELETE).
  let activeChanged = false;
  if (active !== undefined) {
    if (typeof active !== "boolean") throw new AppError("INVALID_FIELD", undefined, { field: "active" });
    if (!active && id === req.authUser?.id) throw new AppError("CANNOT_DEACTIVATE_SELF");
    fields.push(`active = $${i++}`); vals.push(active);
    activeChanged = !active;
  }
  if (name !== undefined) {
    const cleanName = String(name).trim();
    if (!cleanName || cleanName.length > 100) throw new AppError("INVALID_FIELD", undefined, { field: "name" });
    fields.push(`name = $${i++}`); vals.push(cleanName);
  }
  let passwordChanged = false;
  if (password !== undefined) {
    const p = String(password);
    const effectiveRole = role !== undefined ? normalizeRole(role) : target.role;
    const weak = checkSecret(effectiveRole, p, typeof name === "string" ? name : null);
    if (weak) { sendSecurityError(res, 400, "WEAK_PASSWORD", secretProblemText(req, weak), { policy: secretPolicyFor(effectiveRole) }); return; }
    fields.push(`password_hash = $${i++}`); vals.push(await hashPassword(p));
    // A secret issued by someone else is temporary: its owner sets their own on the next sign-in.
    fields.push(`must_change_secret = $${i++}`); vals.push(id !== req.authUser?.id);
    passwordChanged = true;
  }
  let roleChanged = false;
  if (role !== undefined) {
    const newRole = normalizeRole(role);
    if (newRole === "admin" && !adminMgr) throw new AppError("ADMIN_ONLY");
    if (id === req.authUser?.id && newRole !== target.role) throw new AppError("CANNOT_CHANGE_OWN_ROLE");
    fields.push(`role = $${i++}`); vals.push(newRole);
    roleChanged = newRole !== target.role;
  }
  if (!fields.length) throw badRequest("NO_FIELDS");
  vals.push(id);
  try {
    const { rows } = await pool.query<any>(
      `UPDATE users SET ${fields.join(", ")} WHERE id = $${i}
       RETURNING ${USER_COLUMNS}`,
      vals
    );
    if (!rows[0]) throw notFound();
    // Invalidate existing sessions so a reset password / new role takes effect immediately.
    if (passwordChanged || roleChanged || activeChanged) await bumpTokenVersion(id);
    // An admin reset of the secret also lifts a sign-in lock on that account.
    if (passwordChanged) await lockoutStore().clearUser(id).catch((err) => logger.warn({ err }, "users: clear login lock failed"));
    res.json(rows[0]);
  } catch (e: any) {
    if (e.code === "23505") throw new AppError("USER_NAME_TAKEN");
    throw e;
  }
}));

router.delete("/users/:id", asyncHandler(async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) throw badRequest("INVALID_ID");
  if (!(await requireCap(req, res, "users.manage", null, "STAFF_ONLY"))) return;
  const adminMgr = await can(req, "users.manage.admins");
  if (id === req.authUser?.id) throw new AppError("CANNOT_DEACTIVATE_SELF");
  const { rows: targetRows } = await pool.query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [id]);
  if (!targetRows[0]) throw notFound();
  if (targetRows[0].role === "admin" && !adminMgr) throw new AppError("ADMIN_ONLY");
  await pool.query(`UPDATE users SET active = false WHERE id = $1`, [id]);
  await bumpTokenVersion(id);
  res.json({ success: true });
}));

export default router;
