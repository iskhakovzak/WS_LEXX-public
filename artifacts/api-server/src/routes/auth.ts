import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { langOf, localeOfUser } from "../i18n";
import { signToken, signGuestToken, verifyPassword, bumpTokenVersion, hashPassword, isGuest, isGuestModeEnabled, shouldRefreshToken, GUEST_NAME, GUEST_ROLE, GUEST_USER_ID } from "../lib/auth";
import { logAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import { ensureNameLatin } from "../lib/peopleDirectory";
import { lockoutKey, lockoutStore, resolveLoginName } from "../lib/security/loginGuard";
import { mustChangeSecret, secretPolicyFor, TRADER_MIN_SECRET } from "../lib/security/passwordPolicy";
import { securityT } from "../lib/security/i18n";
import { sendSecurityError } from "../lib/security/respond";
import { AppError, unauthorized } from "../lib/http";
import { config } from "../config";

/**
 * Admin secret for /auth/init-passwords. No hard-coded fallback: if ADMIN_PASSWORD
 * is not configured, the endpoint is disabled (503). Existing users keep their
 * bcrypt hashes and log in exactly as before.
 */
function adminPasswordMatches(input: unknown): boolean {
  const expected = config.adminPassword;
  if (!expected || typeof input !== "string" || input.length === 0) return false;
  const a = Buffer.from(input, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const router: IRouter = Router();

const loginSchema = z.object({
  name: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(200),
});

type LoginRow = { id: number; name: string; name_latin: string | null; password_hash: string | null; role: string; banned: boolean; must_change_secret: boolean };

/** Active accounts the typed name may resolve to (name_latin is optional on older databases). */
async function loginCandidates(): Promise<LoginRow[]> {
  const latin = await ensureNameLatin().then(() => true, () => false);
  const { rows } = await pool.query<LoginRow>(
    `SELECT id, name, ${latin ? "name_latin" : "NULL::text AS name_latin"}, password_hash, role, COALESCE(banned, false) AS banned, must_change_secret
       FROM users WHERE active = true`,
  );
  return rows;
}

// Compared against when the name resolves to nobody, so «unknown name» costs the same bcrypt time as «wrong PIN».
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hashPassword(randomBytes(18).toString("hex")));

function lockedResponse(req: Request, res: Response, retryAfterSec: number): void {
  res.setHeader("Retry-After", String(retryAfterSec));
  sendSecurityError(res, 429, "LOGIN_LOCKED", securityT.tFor(langOf(req))("login.locked"), { retryAfterSec });
}

/**
 * POST /auth/login { name, password } — name typed by the user (lib/security/loginGuard resolveLoginName).
 * Unknown, ambiguous and wrong-secret answers are identical: 401 INVALID_CREDENTIALS. 5 failures on one account
 * (or one typed unknown name) → 429 LOGIN_LOCKED with Retry-After, escalating 15 → 30 → 60 min …; each lock is audited.
 * `mustChangePassword: true` and a `pwc` token (only the secret change works until a new one is saved) when the account
 * still has an issued secret (users.must_change_secret: first sign-in, admin reset — `mustChangeReason: "first"`) or
 * is staff with a secret shorter than 10 characters (`"policy"`). Secrets are never logged.
 */
router.post("/auth/login", asyncHandler(async (req, res): Promise<void> => {
  const t = securityT.tFor(langOf(req));
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) throw parsed.error;
  const { name, password } = parsed.data;
  const store = lockoutStore();
  const user = resolveLoginName((await loginCandidates()).map((u) => ({ ...u, nameLatin: u.name_latin })), name);
  const key = lockoutKey(user, name);

  const lock = await store.check(key);
  if (lock.locked) { lockedResponse(req, res, lock.retryAfterSec); return; }

  const ok = user?.password_hash
    ? await verifyPassword(password, { passwordHash: user.password_hash })
    : (await verifyPassword(password, { passwordHash: await getDummyHash() }), false);

  if (!user || !ok) {
    const r = await store.fail(key, user?.id ?? null);
    if (r.locked) {
      await logAudit({
        actor: "system",
        action: "auth.lockout",
        targetType: user ? "user" : "login_name",
        targetId: user ? String(user.id) : key.slice(2, 14),
        details: { minutes: r.minutes, level: r.level, until: r.until.toISOString(), ip: req.ip ?? null },
      });
      logger.warn({ userId: user?.id ?? null, minutes: r.minutes, level: r.level }, "login locked after repeated failures");
      lockedResponse(req, res, r.retryAfterSec);
      return;
    }
    sendSecurityError(res, 401, "INVALID_CREDENTIALS", t("login.invalid"));
    return;
  }
  // Only after the secret matched: a banned account is not revealed to someone who doesn't know its PIN.
  if (user.banned) { sendSecurityError(res, 403, "BANNED", t("login.banned")); return; }
  await store.clear(key);
  const pwc = user.must_change_secret || mustChangeSecret(user.role, password);
  const token = await signToken({ id: user.id, name: user.name, role: user.role }, { pwc });
  res.json({
    token,
    user: { id: user.id, name: user.name, role: user.role },
    mustChangePassword: pwc,
    ...(pwc ? { mustChangeReason: user.must_change_secret ? "first" : "policy" } : {}),
    secretPolicy: secretPolicyFor(user.role),
  });
}));

/**
 * Guest mode: a short-lived (12h) read-only token for a synthetic user without a users row.
 * The global gate rejects every mutation from it with 403; scopeTrader() gives it an empty
 * personal scope. Public (no token needed) — this is how an anonymous visitor gets in.
 */
router.post("/auth/guest", asyncHandler(async (_req, res): Promise<void> => {
  // GUEST_MODE switch (DEPLOY.md): off → no new guest tokens (and authMiddleware ignores old ones).
  if (!isGuestModeEnabled()) {
    throw new AppError("GUEST_DISABLED");
  }
  const token = signGuestToken();
  res.json({ token, user: { id: GUEST_USER_ID, name: GUEST_NAME, role: GUEST_ROLE }, expiresInSec: 12 * 3600 });
}));

/** Why a pwc session must change its secret: an issued secret («first») or the staff minimum («policy»). */
async function mustChangeReasonOf(id: number): Promise<"first" | "policy"> {
  const { rows } = await pool.query<{ m: boolean }>(`SELECT must_change_secret AS m FROM users WHERE id = $1`, [id]);
  return rows[0]?.m ? "first" : "policy";
}

/**
 * GET /auth/me → { user, guest, locale, mustChangePassword, secretPolicy?, token? }.
 * Sliding session: a member token older than 24 h comes back re-issued in `token` (7 more days); the client stores it.
 */
router.get("/auth/me", asyncHandler(async (req, res): Promise<void> => {
  if (!req.authUser) throw unauthorized();
  const guest = isGuest(req);
  // `locale`: the saved interface language (the client adopts it on a new device; see edge-tracker i18n/locale-sync).
  const locale = guest ? null : await localeOfUser(req.authUser.id);
  const pwc = !!req.authMeta?.pwc;
  const reason = pwc ? await mustChangeReasonOf(req.authUser.id) : null;
  const token = !guest && shouldRefreshToken(req.authMeta?.iat) ? await signToken(req.authUser, { pwc }) : undefined;
  if (token) res.setHeader("Cache-Control", "no-store");
  res.json({
    user: req.authUser,
    guest,
    locale,
    mustChangePassword: pwc,
    ...(reason ? { mustChangeReason: reason } : {}),
    ...(guest ? {} : { secretPolicy: secretPolicyFor(req.authUser.role) }),
    ...(token ? { token } : {}),
  });
}));

router.post("/auth/logout", asyncHandler(async (req, res): Promise<void> => {
  if (!req.authUser) throw unauthorized();
  // Guest tokens have no users row / token_version — the client simply drops the token.
  if (!isGuest(req)) await bumpTokenVersion(req.authUser.id);
  res.json({ ok: true });
}));

/**
 * Initial passwords are never stored in source. They come either from the request body
 * (`passwords: { [name]: password }`) or from the INIT_PASSWORDS env var (JSON object).
 * Only users whose password_hash IS NULL are touched; existing hashes are never changed.
 */
const initPasswordsSchema = z.object({
  adminPassword: z.string().min(1).max(200),
  passwords: z.record(z.string().trim().min(1).max(100), z.string().min(TRADER_MIN_SECRET).max(200)).optional(),
});

function readEnvInitPasswords(): Record<string, string> {
  const raw = config.initPasswords;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && v.length >= TRADER_MIN_SECRET && k.trim()) out[k.trim()] = v;
    }
    return out;
  } catch {
    return {};
  }
}

router.post("/auth/init-passwords", asyncHandler(async (req, res): Promise<void> => {
  if (!config.adminPassword) {
    throw new AppError("INIT_PASSWORDS_DISABLED");
  }
  const parsed = initPasswordsSchema.safeParse(req.body ?? {});
  if (!parsed.success || !adminPasswordMatches(parsed.data.adminPassword)) {
    throw new AppError("ADMIN_PASSWORD_REQUIRED");
  }
  const source = parsed.data.passwords ?? readEnvInitPasswords();
  const entries = Object.entries(source);
  if (entries.length === 0) {
    throw new AppError("INIT_PASSWORDS_MISSING");
  }
  const results: { name: string; updated: boolean }[] = [];
  for (const [name, password] of entries) {
    const hash = await hashPassword(password);
    const { rowCount } = await pool.query(
      `UPDATE users SET password_hash = $1, must_change_secret = true WHERE name = $2 AND password_hash IS NULL`,
      [hash, name]
    );
    results.push({ name, updated: (rowCount ?? 0) > 0 });
  }
  res.json({ ok: true, results });
}));

export default router;
