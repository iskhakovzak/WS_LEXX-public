import type { Request } from "express";
import { pool } from "@workspace/db";
import { can, evaluate, getEffectiveMatrix, resolveActor } from "./permissions";
import { normalizeRole } from "./permissionsMatrix";
import { logger } from "./logger";
import { discussionsT } from "../i18n/ns";
import type { Lang, Params } from "../i18n";
import { errorMessage, type ErrorCode } from "./http/errors";

/**
 * Discussions audience («Кому видна тема»).
 *
 *   discussions.audience TEXT[]   NULL / {} = everyone (every pre-existing thread).
 *                                 Otherwise a union of tokens:
 *                                   trainee | junior | trader | senior   academy ladder stage (Стажёр → Сеньор)
 *                                   staff                                role curator / admin («Кураторам»)
 *                                   cohort:<id>                          members of an active academy cohort
 *
 * Who reads a restricted thread: its author, everyone whose tokens intersect the audience, and moderators
 * (capability discussions.moderate — curators/admins) who see every thread. Guests / anonymous see only public ones.
 *
 * Stage source — same order as routes/academy-path.ts loadStageInfo: academy_trader_stage (approved transfers) →
 * latest active/paused academy_enrollments.stage → trader_risk_limits.tier. Every academy table is optional.
 *
 * Every read path builds its WHERE through audienceSql (mirrors canSeeThread, unit-tested for parity), and every
 * notification fan-out goes through audienceRecipients / filterVisibleNames, so a thread never leaks outside it.
 */

export const AUDIENCE_STAGES = ["trainee", "junior", "trader", "senior"] as const;
export type AudienceStage = (typeof AUDIENCE_STAGES)[number];
export const STAFF_TOKEN = "staff";
const COHORT_RE = /^cohort:([1-9]\d{0,8})$/;
const MAX_TOKENS = 12;

/** Audience token label in `lang` («тема — Джунам»), shown in the UI and notifications (discussions namespace). */
export function audienceTokenLabel(token: string, lang: Lang = "ru"): string {
  return discussionsT.tryFor(lang, `audience.${token}`) ?? token;
}
/** RU labels (kept for older imports). */
export const AUDIENCE_LABELS: Record<string, string> = Object.fromEntries(
  ["trainee", "junior", "trader", "senior", "staff"].map((k) => [k, audienceTokenLabel(k)]),
);

export interface AudienceViewer {
  name: string | null;
  guest: boolean;
  /** discussions.moderate: sees every thread. */
  moderator: boolean;
  /** Role curator/admin: matches the «Кураторам» token. */
  staff: boolean;
  stage: AudienceStage | null;
  /** Active cohort ids. */
  cohorts: number[];
}

export const ANONYMOUS_VIEWER: AudienceViewer = { name: null, guest: false, moderator: false, staff: false, stage: null, cohorts: [] };

// ─── pure helpers (unit-tested) ─────────────────────────────────────────────

export function isStage(v: unknown): v is AudienceStage {
  return typeof v === "string" && (AUDIENCE_STAGES as readonly string[]).includes(v);
}

export function cohortToken(id: number): string {
  return `cohort:${id}`;
}

export function cohortOf(token: string): number | null {
  const m = COHORT_RE.exec(token);
  return m ? Number(m[1]) : null;
}

function tokenRank(t: string): number {
  const i = (AUDIENCE_STAGES as readonly string[]).indexOf(t);
  if (i >= 0) return i;
  if (t === STAFF_TOKEN) return 10;
  return 100 + (cohortOf(t) ?? 0);
}

/** Failure carries an API error code (+ params); `error` is the RU text (logs / older callers). */
export type AudienceParse = { ok: true; audience: string[] } | { ok: false; code: ErrorCode; params?: Params; error: string };
const audienceFail = (code: ErrorCode, params?: Params): AudienceParse => ({ ok: false, code, params, error: errorMessage(code, "ru", params) });

/**
 * Body value → canonical token list ([] = everyone). Accepts an array or a comma string; "all" / "" / null mean
 * everyone and win over anything else. Unknown tokens are rejected (no silent widening to everyone).
 */
export function parseAudience(input: unknown): AudienceParse {
  if (input === undefined || input === null || input === "") return { ok: true, audience: [] };
  const raw = Array.isArray(input) ? input : typeof input === "string" ? input.split(",") : null;
  if (!raw) return audienceFail("AUDIENCE_INVALID");
  const out = new Set<string>();
  for (const item of raw) {
    const t = String(item ?? "").trim().toLowerCase();
    if (!t) continue;
    if (t === "all") return { ok: true, audience: [] };
    if (!isStage(t) && t !== STAFF_TOKEN && cohortOf(t) == null) return audienceFail("AUDIENCE_UNKNOWN", { token: t.slice(0, 40) });
    out.add(t);
  }
  if (out.size > MAX_TOKENS) return audienceFail("AUDIENCE_TOO_MANY");
  return { ok: true, audience: [...out].sort((a, b) => tokenRank(a) - tokenRank(b)) };
}

/** Normalises the DB value (TEXT[] | null) to a token list. */
export function audienceOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string" && t.length > 0) : [];
}

export function isPublicAudience(audience: readonly string[] | null | undefined): boolean {
  return !audience || audience.length === 0;
}

/** Tokens a person matches (independent of the moderator override). */
export function viewerTokens(v: Pick<AudienceViewer, "guest" | "staff" | "stage" | "cohorts">): string[] {
  if (v.guest) return [];
  const out: string[] = [];
  if (v.stage) out.push(v.stage);
  if (v.staff) out.push(STAFF_TOKEN);
  for (const c of v.cohorts) out.push(cohortToken(c));
  return out;
}

/** Is the person part of the audience (public → yes)? Ignores authorship and moderation. */
export function inAudience(v: Pick<AudienceViewer, "guest" | "staff" | "stage" | "cohorts">, audience: readonly string[] | null | undefined): boolean {
  if (isPublicAudience(audience)) return true;
  const mine = viewerTokens(v);
  return mine.some((t) => audience!.includes(t));
}

/** Full read rule for one thread row. Mirrors audienceSql. */
export function canSeeThread(v: AudienceViewer, row: { trader: string | null; audience: readonly string[] | null | undefined }): boolean {
  if (isPublicAudience(row.audience)) return true;
  if (v.moderator) return true;
  if (v.guest || !v.name) return false;
  if (row.trader && row.trader === v.name) return true;
  return inAudience(v, row.audience);
}

/**
 * WHERE fragment restricting discussions (alias `a`) to the viewer. `p` appends a parameter and returns its
 * placeholder ("$3"), the idiom of the routes. Mirrors canSeeThread.
 */
export function audienceSql(v: AudienceViewer, p: (x: unknown) => string, a = "d"): string {
  if (v.moderator) return "TRUE";
  const parts = [`(${a}.audience IS NULL OR cardinality(${a}.audience) = 0)`];
  if (!v.guest && v.name) {
    parts.push(`${a}.trader = ${p(v.name)}`);
    const tokens = viewerTokens(v);
    if (tokens.length) parts.push(`${a}.audience && ${p(tokens)}::text[]`);
  }
  return `(${parts.join(" OR ")})`;
}

/** Stage precedence: approved transfer → active enrollment → scaling tier. */
export function pickStage(own: unknown, enrollment: unknown, tier: unknown): AudienceStage | null {
  if (isStage(own)) return own;
  if (isStage(enrollment)) return enrollment;
  if (isStage(tier)) return tier;
  return null;
}

/** Human label for an audience («Джунам, Трейдерам», cohorts by name when known). */
export function audienceLabel(audience: readonly string[] | null | undefined, cohortNames?: ReadonlyMap<number, string>, lang: Lang = "ru"): string {
  const t = discussionsT.tFor(lang);
  if (isPublicAudience(audience)) return t("audience.all");
  return audience!.map((tok) => {
    const c = cohortOf(tok);
    if (c != null) return cohortNames?.get(c) ?? t("audience.cohort", { id: c });
    return audienceTokenLabel(tok, lang);
  }).join(", ");
}

// ─── DB: people, stages, cohorts ────────────────────────────────────────────

export type AudienceProfile = { name: string; role: string; staff: boolean; moderator: boolean; stage: AudienceStage | null; cohorts: number[] };

async function optionalRows<T>(label: string, sql: string, params: unknown[]): Promise<T[]> {
  try {
    return (await pool.query(sql, params)).rows as T[];
  } catch (err: any) {
    if (err?.code !== "42P01" && err?.code !== "42703") logger.warn({ err, label }, "discussionAudience: optional source failed");
    return [];
  }
}

/** Active, non-banned members (all, or only `names`) with role, moderator flag, stage and active cohorts. */
export async function loadProfiles(names: string[] | null): Promise<AudienceProfile[]> {
  if (names && names.length === 0) return [];
  const filter = (col: string) => (names ? ` AND ${col} = ANY($1::text[])` : "");
  const params = names ? [names] : [];
  const { rows: users } = await pool.query<{ name: string; role: string }>(
    `SELECT name, role FROM users WHERE active = true AND COALESCE(banned, false) = false${filter("name")}`, params);
  if (!users.length) return [];
  const [own, enr, tiers, cohorts, matrix] = await Promise.all([
    optionalRows<{ user_name: string; stage: string }>("stage", `SELECT user_name, stage FROM academy_trader_stage WHERE TRUE${filter("user_name")}`, params),
    optionalRows<{ user_name: string; stage: string }>(
      "enrollment",
      `SELECT DISTINCT ON (user_name) user_name, stage FROM academy_enrollments
        WHERE archived_at IS NULL AND COALESCE(status, 'active') IN ('active', 'paused')${filter("user_name")}
        ORDER BY user_name, joined_on DESC NULLS LAST, id DESC`, params),
    optionalRows<{ trader: string; tier: string }>("tier", `SELECT trader, tier FROM trader_risk_limits WHERE TRUE${filter("trader")}`, params),
    optionalRows<{ user_name: string; cohort_id: number }>(
      "cohorts",
      `SELECT DISTINCT e.user_name, e.cohort_id FROM academy_enrollments e
         JOIN academy_cohorts c ON c.id = e.cohort_id AND c.archived_at IS NULL
        WHERE e.archived_at IS NULL AND COALESCE(e.status, 'active') IN ('active', 'paused')${filter("e.user_name")}`, params),
    getEffectiveMatrix(),
  ]);
  const ownBy = new Map(own.map((r) => [r.user_name, r.stage]));
  const enrBy = new Map(enr.map((r) => [r.user_name, r.stage]));
  const tierBy = new Map(tiers.map((r) => [r.trader, r.tier]));
  const cohortsBy = new Map<string, number[]>();
  for (const r of cohorts) (cohortsBy.get(r.user_name) ?? cohortsBy.set(r.user_name, []).get(r.user_name)!).push(Number(r.cohort_id));
  return users.map((u) => {
    const role = normalizeRole(u.role);
    return {
      name: u.name,
      role,
      staff: role === "curator" || role === "admin",
      moderator: evaluate(matrix, { id: 0, name: u.name, role, guest: false, wards: [] }, "discussions.moderate"),
      stage: pickStage(ownBy.get(u.name), enrBy.get(u.name), tierBy.get(u.name)),
      cohorts: (cohortsBy.get(u.name) ?? []).sort((a, b) => a - b),
    };
  });
}

function profileViewer(p: AudienceProfile): AudienceViewer {
  return { name: p.name, guest: false, moderator: p.moderator, staff: p.staff, stage: p.stage, cohorts: p.cohorts };
}

const viewerCache = new WeakMap<Request, Promise<AudienceViewer>>();

/** The signed-in viewer (memoised per request). Guests / inactive / banned → public threads only. */
export function loadAudienceViewer(req: Request): Promise<AudienceViewer> {
  const hit = viewerCache.get(req);
  if (hit) return hit;
  const promise = (async (): Promise<AudienceViewer> => {
    const actor = await resolveActor(req);
    if (!actor) return ANONYMOUS_VIEWER;
    if (actor.guest) return { ...ANONYMOUS_VIEWER, name: actor.name, guest: true };
    const [profile] = await loadProfiles([actor.name]);
    const moderator = await can(req, "discussions.moderate");
    if (!profile) return { ...ANONYMOUS_VIEWER, name: actor.name, moderator };
    return { ...profileViewer(profile), moderator };
  })();
  viewerCache.set(req, promise);
  promise.catch(() => viewerCache.delete(req));
  return promise;
}

/** Viewer by name (lib code without a request, e.g. the feed). Unknown / inactive → public only. */
export async function audienceViewerByName(name: string | null): Promise<AudienceViewer> {
  if (!name) return ANONYMOUS_VIEWER;
  const [profile] = await loadProfiles([name]);
  return profile ? profileViewer(profile) : ANONYMOUS_VIEWER;
}

/** People in the audience (moderation override not included) — for «увидят N человек» and the new-thread fan-out. */
export async function audienceRecipients(audience: readonly string[]): Promise<string[]> {
  const people = await loadProfiles(null);
  return people.filter((p) => inAudience(profileViewer(p), audience)).map((p) => p.name);
}

/** Subset of `names` who may read the thread (for mention / reply notifications). */
export async function filterVisibleNames(names: readonly string[], row: { trader: string | null; audience: readonly string[] | null | undefined }): Promise<string[]> {
  const unique = [...new Set(names.filter(Boolean))];
  if (!unique.length || isPublicAudience(row.audience)) return unique;
  const people = new Map((await loadProfiles(unique)).map((p) => [p.name, p]));
  return unique.filter((n) => {
    const p = people.get(n);
    return !!p && canSeeThread(profileViewer(p), row);
  });
}
