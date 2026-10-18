import type { Request } from "express";
import { pool } from "@workspace/db";
import { can, readScope, resolveActor } from "./permissions";
import { logger } from "./logger";
import type { MoneyViewer } from "./playbookPrivacy";

/**
 * Playbook spaces & access (Wave J3).
 *
 *   «Офис»  (space = 'office')   — the desk's official playbook. Everyone signed in reads it; curators
 *                                  (playbook.edit.any) edit it.
 *   «Мой»   (space = 'personal') — a trader's own book (owner = playbook.trader). Private by default:
 *                                  the owner, and staff whose team.read scope covers the owner, read it.
 *   «Общие» (personal + visibility ≠ 'private') — a senior (academy stage 'senior') or staff member opened a
 *                                  personal setup to everyone ('all') or to people / cohorts ('custom',
 *                                  shared_with = { users: string[], cohorts: number[] }). Others read it and may
 *                                  copy it into their «Мой» (copied_from_* keeps the attribution).
 *
 * Migration (additive; see ensurePlaybookSpaces): space was not stored before. A row without space is
 * 'office' when it has no author (trader IS NULL — the historic "team setup") or its author is a curator/admin;
 * otherwise it is the author's personal, private setup. Locally all 120 legacy setups had no author → «Офис».
 *
 * Every read/write decision is made here, on the server; the client only mirrors it for UI hints.
 */

export type Space = "office" | "personal";
export type Visibility = "private" | "all" | "custom";
export interface SharedWith { users: string[]; cohorts: number[] }

/** Stages allowed to share their personal setups (besides staff). */
export const SHARE_STAGES: ReadonlySet<string> = new Set(["senior"]);

export interface SetupAccessRow {
  trader: string | null;
  space?: string | null;
  visibility?: string | null;
  sharedWith?: unknown;
  shared_with?: unknown;
}

export interface PlaybookViewer {
  name: string | null;
  guest: boolean;
  /** team.read scope: null = whole desk, string[] = only these traders. */
  teamScope: string[] | null;
  /** playbook.edit for own setups. */
  editOwn: boolean;
  /** playbook.edit.any at desk level (curators): edit «Офис», others' setups. */
  editAny: boolean;
  /** playbook.review (curators): verdicts, promote to «Офис». */
  review: boolean;
  /** Academy ladder stage (trainee | junior | trader | senior) or null. */
  stage: string | null;
  /** Active cohort ids the viewer is enrolled in. */
  cohorts: number[];
}

declare global {
  namespace Express {
    interface Request {
      pbViewer?: PlaybookViewer;
    }
  }
}

// ─── pure helpers (unit-tested) ─────────────────────────────────────────────

export function spaceOf(row: Pick<SetupAccessRow, "trader" | "space">): Space {
  if (row.space === "office" || row.space === "personal") return row.space;
  return row.trader ? "personal" : "office";
}

export function visibilityOf(row: Pick<SetupAccessRow, "visibility">): Visibility {
  return row.visibility === "all" || row.visibility === "custom" ? row.visibility : "private";
}

export function normSharedWith(input: unknown): SharedWith {
  const src = (input && typeof input === "object" ? input : {}) as { users?: unknown; cohorts?: unknown };
  const users = Array.isArray(src.users)
    ? [...new Set(src.users.map((u) => String(u ?? "").trim()).filter((u) => u && u.length <= 120))].slice(0, 200)
    : [];
  const cohorts = Array.isArray(src.cohorts)
    ? [...new Set(src.cohorts.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 50)
    : [];
  return { users, cohorts };
}

/** Is a personal setup visible to someone other than its owner (shown under «Общие»)? */
export function isShared(row: SetupAccessRow): boolean {
  if (spaceOf(row) !== "personal") return false;
  const vis = visibilityOf(row);
  if (vis === "all") return true;
  if (vis === "custom") {
    const sw = normSharedWith(row.sharedWith ?? row.shared_with);
    return sw.users.length > 0 || sw.cohorts.length > 0;
  }
  return false;
}

export function canReadPure(v: PlaybookViewer, row: SetupAccessRow): boolean {
  if (spaceOf(row) === "office") return true;
  const owner = row.trader;
  if (v.name && owner && owner === v.name) return true;
  if (v.teamScope === null && !v.guest) return true;
  if (owner && v.teamScope?.includes(owner)) return true;
  const vis = visibilityOf(row);
  if (vis === "all") return true;
  if (vis === "custom" && !v.guest) {
    const sw = normSharedWith(row.sharedWith ?? row.shared_with);
    if (v.name && sw.users.includes(v.name)) return true;
    if (sw.cohorts.some((c) => v.cohorts.includes(c))) return true;
  }
  return false;
}

/** Desk-level part of the edit rule (personal setups of others additionally go through can(…, {trader})). */
export function canEditPure(v: PlaybookViewer, row: SetupAccessRow): boolean {
  if (v.guest || !v.name) return false;
  if (spaceOf(row) === "office") return v.editAny;
  if (row.trader === v.name) return v.editOwn;
  return v.editAny;
}

export function canSharePure(v: PlaybookViewer, row: SetupAccessRow): boolean {
  if (v.guest || !v.name) return false;
  if (spaceOf(row) !== "personal" || row.trader !== v.name) return false;
  return v.editAny || v.review || (v.stage != null && SHARE_STAGES.has(v.stage));
}

/** Viewer may share at all (UI hint for «Поделиться»). */
export function mayShareAny(v: PlaybookViewer): boolean {
  if (v.guest || !v.name) return false;
  return v.editAny || v.review || (v.stage != null && SHARE_STAGES.has(v.stage));
}

// ─── SQL helpers ────────────────────────────────────────────────────────────

/** Effective space of a playbook row (handles rows inserted without space, e.g. seeds). */
export function spaceSql(a = "p"): string {
  return `COALESCE(${a}.space, CASE WHEN ${a}.trader IS NULL THEN 'office' ELSE 'personal' END)`;
}

/**
 * WHERE fragment restricting playbook rows (alias `a`) to what the viewer may read. Appends to `params`.
 * Mirrors canReadPure.
 */
export function visibleSql(v: PlaybookViewer, params: unknown[], a = "p"): string {
  if (v.teamScope === null && !v.guest) return "TRUE";
  const parts = [`${spaceSql(a)} = 'office'`, `${a}.visibility = 'all'`];
  const own = [...new Set([...(v.teamScope ?? []), ...(v.name && !v.guest ? [v.name] : [])])];
  if (own.length) {
    params.push(own);
    parts.push(`${a}.trader = ANY($${params.length}::text[])`);
  }
  if (!v.guest && v.name) {
    params.push(v.name);
    const nameIdx = params.length;
    let cohortPart = "";
    if (v.cohorts.length) {
      params.push(v.cohorts.map(String));
      cohortPart = ` OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(${a}.shared_with->'cohorts', '[]'::jsonb)) sc WHERE sc = ANY($${params.length}::text[]))`;
    }
    parts.push(`(${a}.visibility = 'custom' AND (COALESCE(${a}.shared_with->'users', '[]'::jsonb) ? $${nameIdx}${cohortPart}))`);
  }
  return `(${parts.join(" OR ")})`;
}

// ─── viewer ─────────────────────────────────────────────────────────────────

export async function loadViewer(req: Request): Promise<PlaybookViewer> {
  if (req.pbViewer) return req.pbViewer;
  const actor = await resolveActor(req);
  if (!actor) {
    return (req.pbViewer = { name: null, guest: false, teamScope: [], editOwn: false, editAny: false, review: false, stage: null, cohorts: [] });
  }
  if (actor.guest) {
    return (req.pbViewer = { name: actor.name, guest: true, teamScope: [], editOwn: false, editAny: false, review: false, stage: null, cohorts: [] });
  }
  const [teamScope, editOwn, editAny, review] = await Promise.all([
    readScope(req, "team.read"),
    can(req, "playbook.edit", { trader: actor.name }),
    can(req, "playbook.edit.any"),
    can(req, "playbook.review"),
  ]);
  let stage: string | null = null;
  let cohorts: number[] = [];
  try {
    const { rows } = await pool.query<{ stage: string }>(`SELECT stage FROM academy_trader_stage WHERE user_name = $1`, [actor.name]);
    stage = rows[0]?.stage ?? null;
  } catch { /* academy tables not created yet */ }
  try {
    const { rows } = await pool.query<{ cohort_id: number }>(
      `SELECT e.cohort_id FROM academy_enrollments e
         JOIN academy_cohorts c ON c.id = e.cohort_id AND c.archived_at IS NULL
        WHERE e.user_name = $1 AND e.archived_at IS NULL`,
      [actor.name],
    );
    cohorts = rows.map((r) => Number(r.cohort_id));
  } catch { /* academy tables not created yet */ }
  return (req.pbViewer = { name: actor.name, guest: false, teamScope, editOwn, editAny, review, stage, cohorts });
}

/**
 * Viewer for the $-privacy rule (lib/playbookPrivacy.ts): own trades or staff (current DB role curator / admin).
 * Guests and anonymous callers never see $ of a playbook trade.
 */
export async function loadMoneyViewer(req: Request): Promise<MoneyViewer> {
  const actor = await resolveActor(req);
  if (!actor || actor.guest) return { name: null, staff: false };
  // Same rule as isStaffRole (lib/auth) — not imported: auth.ts needs JWT_SECRET at import time.
  return { name: actor.name, staff: actor.role === "curator" || actor.role === "admin" };
}

/**
 * Is trade `tradeId` an example (playbook_examples) of a live setup the viewer may read? Such a trade is already
 * on screen in the playbook, so «Открыть сделку» may load it — with its $ redacted (lib/playbookPrivacy).
 * Guests / anonymous: never.
 */
export async function isReadableExampleTrade(req: Request, tradeId: number): Promise<boolean> {
  if (!Number.isInteger(tradeId) || tradeId <= 0) return false;
  const v = await loadViewer(req);
  if (!v.name || v.guest) return false;
  await ensurePlaybookSpaces();
  const params: unknown[] = [tradeId];
  const vis = visibleSql(v, params, "p");
  const { rows } = await pool.query(
    `SELECT 1 FROM playbook_examples e
       JOIN playbook p ON p.id = e.playbook_id AND p.deleted_at IS NULL
      WHERE e.trade_id = $1 AND e.deleted_at IS NULL AND ${vis}
      LIMIT 1`,
    params,
  );
  return rows.length > 0;
}

export async function canReadSetup(req: Request, row: SetupAccessRow): Promise<boolean> {
  return canReadPure(await loadViewer(req), row);
}

export async function canEditSetupRow(req: Request, row: SetupAccessRow): Promise<boolean> {
  const v = await loadViewer(req);
  if (!canEditPure(v, row)) return false;
  // Someone else's personal setup: the matrix may scope playbook.edit.any to assigned traders.
  if (spaceOf(row) === "personal" && row.trader && row.trader !== v.name) {
    return can(req, "playbook.edit.any", { trader: row.trader });
  }
  return true;
}

/** Per-row UI hints computed on the server. */
export function accessHints(v: PlaybookViewer, row: SetupAccessRow) {
  const space = spaceOf(row);
  return {
    space,
    shared: isShared(row),
    mine: !!v.name && row.trader === v.name && space === "personal",
    canEdit: canEditPure(v, row),
    canShare: canSharePure(v, row),
    canPromote: v.review && space === "personal",
    /** Add own trades as examples: anything the viewer may edit, plus «Офис» setups (contributions are attributed). */
    canAddExamples: !v.guest && !!v.name && (canEditPure(v, row) || (space === "office" && v.editOwn)),
  };
}

// ─── schema (additive, idempotent, lazy) ────────────────────────────────────

let ensured: Promise<void> | null = null;

/**
 * Columns: space / visibility / shared_with / shared_at / shared_by / created_by / copied_from_* / promoted_from_id /
 * office_proposed_* / structured card fields / horizon / updated_at. Tables: playbook_examples, playbook_media.
 * Backfill runs only for rows whose space is still NULL (cheap and idempotent).
 */
export function ensurePlaybookSpaces(): Promise<void> {
  if (!ensured) {
    ensured = pool
      .query(
        `ALTER TABLE playbook ADD COLUMN IF NOT EXISTS space TEXT;
         ALTER TABLE playbook ADD COLUMN IF NOT EXISTS visibility TEXT;
         ALTER TABLE playbook ADD COLUMN IF NOT EXISTS shared_with JSONB;
         ALTER TABLE playbook ADD COLUMN IF NOT EXISTS shared_at TIMESTAMPTZ;
         ALTER TABLE playbook ADD COLUMN IF NOT EXISTS shared_by TEXT;
         ALTER TABLE playbook ADD COLUMN IF NOT EXISTS created_by TEXT;
         ALTER TABLE playbook ADD COLUMN IF NOT EXISTS copied_from_id INTEGER;
         ALTER TABLE playbook ADD COLUMN IF NOT EXISTS copied_from_author TEXT;
         ALTER TABLE playbook ADD COLUMN IF NOT EXISTS promoted_from_id INTEGER;
         ALTER TABLE playbook ADD COLUMN IF NOT EXISTS office_proposed_at TIMESTAMPTZ;
         ALTER TABLE playbook ADD COLUMN IF NOT EXISTS office_proposed_by TEXT;
         ALTER TABLE playbook ADD COLUMN IF NOT EXISTS office_proposed_note TEXT;
         ALTER TABLE playbook ADD COLUMN IF NOT EXISTS context_text TEXT;
         ALTER TABLE playbook ADD COLUMN IF NOT EXISTS trigger_text TEXT;
         ALTER TABLE playbook ADD COLUMN IF NOT EXISTS entry_text TEXT;
         ALTER TABLE playbook ADD COLUMN IF NOT EXISTS stop_text TEXT;
         ALTER TABLE playbook ADD COLUMN IF NOT EXISTS targets_text TEXT;
         ALTER TABLE playbook ADD COLUMN IF NOT EXISTS management_text TEXT;
         ALTER TABLE playbook ADD COLUMN IF NOT EXISTS invalidation_text TEXT;
         ALTER TABLE playbook ADD COLUMN IF NOT EXISTS ideal_conditions TEXT;
         ALTER TABLE playbook ADD COLUMN IF NOT EXISTS time_of_day TEXT;
         ALTER TABLE playbook ADD COLUMN IF NOT EXISTS horizon TEXT;
         ALTER TABLE playbook ADD COLUMN IF NOT EXISTS media JSONB;
         ALTER TABLE playbook ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
         CREATE INDEX IF NOT EXISTS playbook_space_trader_idx ON playbook (space, trader) WHERE deleted_at IS NULL;

         UPDATE playbook p
            SET space = CASE
                  WHEN p.trader IS NULL THEN 'office'
                  WHEN EXISTS (SELECT 1 FROM users u WHERE u.name = p.trader AND u.role IN ('curator', 'admin')) THEN 'office'
                  ELSE 'personal' END
          WHERE p.space IS NULL;
         UPDATE playbook SET visibility = 'private' WHERE visibility IS NULL;

         CREATE TABLE IF NOT EXISTS playbook_examples (
           id SERIAL PRIMARY KEY,
           playbook_id INTEGER NOT NULL,
           trade_id INTEGER NOT NULL,
           tier SMALLINT NOT NULL DEFAULT 2 CHECK (tier BETWEEN 1 AND 3),
           note TEXT,
           checklist_marks JSONB,
           media_id INTEGER,
           sort_order INTEGER NOT NULL DEFAULT 0,
           added_by TEXT,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           deleted_at TIMESTAMPTZ
         );
         CREATE UNIQUE INDEX IF NOT EXISTS playbook_examples_live_uq ON playbook_examples (playbook_id, trade_id) WHERE deleted_at IS NULL;
         CREATE INDEX IF NOT EXISTS playbook_examples_setup_idx ON playbook_examples (playbook_id, tier, sort_order) WHERE deleted_at IS NULL;
         CREATE INDEX IF NOT EXISTS playbook_examples_trade_idx ON playbook_examples (trade_id) WHERE deleted_at IS NULL;
         CREATE INDEX IF NOT EXISTS playbook_examples_tier_idx ON playbook_examples (tier, created_at DESC) WHERE deleted_at IS NULL;

         CREATE TABLE IF NOT EXISTS playbook_media (
           id SERIAL PRIMARY KEY,
           playbook_id INTEGER NOT NULL,
           owner TEXT NOT NULL,
           mime TEXT NOT NULL,
           bytes BYTEA NOT NULL,
           size_bytes INTEGER NOT NULL,
           width INTEGER,
           height INTEGER,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           deleted_at TIMESTAMPTZ
         );
         CREATE INDEX IF NOT EXISTS playbook_media_owner_created_idx ON playbook_media (owner, created_at);
         CREATE INDEX IF NOT EXISTS playbook_media_setup_idx ON playbook_media (playbook_id);`,
      )
      .then(() => undefined)
      .catch((err) => {
        ensured = null;
        logger.warn({ err }, "playbook: ensure spaces failed");
        throw err;
      });
  }
  return ensured;
}

/** Load the access-relevant columns of one setup (null when missing / soft-deleted unless includeDeleted). */
export async function loadSetupAccess(id: number, includeDeleted = false): Promise<(SetupAccessRow & { id: number; name: string; folder: string | null; deletedAt: string | null }) | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  await ensurePlaybookSpaces();
  const { rows } = await pool.query<any>(
    `SELECT id, name, folder, trader, space, visibility, shared_with AS "sharedWith", deleted_at AS "deletedAt"
       FROM playbook WHERE id = $1 ${includeDeleted ? "" : "AND deleted_at IS NULL"}`,
    [id],
  );
  return rows[0] ?? null;
}
