/**
 * People directory + cross-script name search (RU / EN / UZ) — shared matcher @workspace/text-search.
 *
 *   users.name_latin (nullable) — optional Latin alias typed by an admin («Zakir Ishakov»); searched next to the name.
 *   The column is created in lib/migrate.ts; `ensureNameLatin()` re-creates it lazily for an API that started before
 *   the migration step existed (same pattern as users.settings).
 *
 * Visibility: staff (team.read = desk) see everyone; a member under own / assigned scope sees only the names that
 * readScope(team.read) returns today (themselves + wards) plus staff (curators / admins are public on the desk anyway).
 */
import type { Request } from "express";
import { pool } from "@workspace/db";
import { searchItems, type MatchTier } from "@workspace/text-search";
import { readScope } from "./permissions";

let ensured: Promise<void> | null = null;

/** Idempotent: ALTER TABLE users ADD COLUMN IF NOT EXISTS name_latin TEXT (memoised per process). */
export function ensureNameLatin(): Promise<void> {
  if (!ensured) {
    ensured = pool
      .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS name_latin TEXT`)
      .then(() => undefined)
      .catch((e) => { ensured = null; throw e; });
  }
  return ensured;
}

/** Trim, collapse spaces, cap length; empty → null. Letters (any script), digits, spaces, . - ' ʻ only. */
/** Failure carries an API error code (+ params) — the route throws AppError(code, 400, params). */
export function cleanNameLatin(raw: unknown):
  | { ok: true; value: string | null }
  | { ok: false; code: "INVALID_FIELD" | "TEXT_TOO_LONG" | "NAME_LATIN_CHARS"; params?: { field: string; max?: number } } {
  if (raw == null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, code: "INVALID_FIELD", params: { field: "nameLatin" } };
  const v = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!v) return { ok: true, value: null };
  if (v.length > 80) return { ok: false, code: "TEXT_TOO_LONG", params: { field: "nameLatin", max: 80 } };
  if (!/^[\p{L}\p{N} .'ʻʼ’`-]+$/u.test(v)) return { ok: false, code: "NAME_LATIN_CHARS" };
  return { ok: true, value: v };
}

export type LatinNameChange = { id: number; name: string; nameLatin: string | null };

/**
 * Write Latin names (already cleaned) in one transaction, with one audit entry («user.name_latin», details
 * {name, from, to, bulk?}) per user whose value actually changed, in the same transaction. Returns the changes.
 * The caller reloads the display table (lib/people/latinNames → reloadLatinNames) when something changed.
 */
export async function saveLatinNames(items: readonly LatinNameChange[], actor: string, opts: { bulk?: boolean } = { bulk: true }): Promise<LatinNameChange[]> {
  if (!items.length) return [];
  const client = await pool.connect();
  const changed: LatinNameChange[] = [];
  try {
    await client.query("BEGIN");
    for (const it of items) {
      const { rows } = await client.query<{ prev: string | null }>(
        `UPDATE users u SET name_latin = $1 FROM (SELECT name_latin AS prev FROM users WHERE id = $2 FOR UPDATE) p
          WHERE u.id = $2 RETURNING p.prev`,
        [it.nameLatin, it.id],
      );
      if (!rows[0]) continue;
      const prev = rows[0].prev ?? null;
      if (prev === it.nameLatin) continue;
      await client.query(
        `INSERT INTO audit_log (actor, action, target_type, target_id, details) VALUES ($1, 'user.name_latin', 'user', $2, $3)`,
        [actor, String(it.id), JSON.stringify({ name: it.name, from: prev, to: it.nameLatin, ...(opts.bulk ? { bulk: true } : {}) })],
      );
      changed.push(it);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  return changed;
}

export type DirectoryPerson = {
  id: number;
  name: string;
  nameLatin: string | null;
  role: string;
  curator: string | null;
  active: boolean;
  banned: boolean;
};

/** Every user row the caller may see (active first). */
export async function loadDirectory(req: Request, opts: { includeInactive?: boolean } = {}): Promise<DirectoryPerson[]> {
  await ensureNameLatin();
  const [{ rows }, visible] = await Promise.all([
    pool.query<{ id: number; name: string; name_latin: string | null; role: string; assigned_curator: string | null; active: boolean; banned: boolean }>(
      `SELECT id, name, name_latin, role, assigned_curator, active, COALESCE(banned, false) AS banned
         FROM users ${opts.includeInactive ? "" : "WHERE active = true"}
        ORDER BY active DESC, name`,
    ),
    readScope(req, "team.read"),
  ]);
  const allowed = visible === null ? null : new Set(visible);
  return rows
    .filter((u) => allowed === null || allowed.has(u.name) || u.role === "curator" || u.role === "admin")
    .map((u) => ({
      id: Number(u.id), name: String(u.name), nameLatin: u.name_latin ?? null, role: String(u.role),
      curator: u.assigned_curator ?? null, active: !!u.active, banned: !!u.banned,
    }));
}

export type PersonHit = DirectoryPerson & { score: number; tier: MatchTier; matched: "name" | "nameLatin" | "curator" };

/** Ranked people search: name and Latin alias first, curator name as a secondary field. */
export function searchPeople(people: DirectoryPerson[], q: string, limit = 20): PersonHit[] {
  const fields = ["name", "nameLatin", "curator"] as const;
  return searchItems(people, q, (p) => [p.name, p.nameLatin, { text: p.curator, weight: 0.5 }], { limit })
    .map((h) => ({ ...h.item, score: Math.round(h.score * 100) / 100, tier: h.tier, matched: fields[Math.max(0, h.field)] ?? "name" }));
}
