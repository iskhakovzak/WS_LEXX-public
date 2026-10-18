/**
 * Desk settings store — table app_settings (migration 0203) behind the typed registry (./registry.ts).
 *
 *   warmSettings()                  index.ts after migrations, and after every save: stored values → setting() cache
 *   settingsState()                 GET /api/admin/settings: every key with its definition, stored value, effective
 *                                   value, default and who / when changed it (re-reads the table, so it also refreshes
 *                                   this process's cache)
 *   saveSettings(changes, actor)    PUT /api/admin/settings: validates the whole batch (SETTINGS_INVALID with
 *                                   details.problems, nothing written), writes the changed keys in one transaction,
 *                                   audits each change (audit_log settings.update {from, to, unit?, reset?}), re-warms
 *   settingsChangedAt(prefix)       last save of any key under a prefix ("daily.") — lib/daily/service re-computes
 *                                   today's stored focus when the focus thresholds changed after it was computed
 *
 * `null` = «по умолчанию»: the row keeps value NULL (and who / when reset it); setting() then reads the default.
 * A stored value that no longer fits its definition (bounds narrowed in code) reads as the default too.
 * One process caches what it loaded; another process (deploy overlap) sees a save on its next warm-up / GET.
 */
import { pool } from "@workspace/db";
import { AppError } from "../http/errors";
import { logAudit } from "../audit";
import { logger } from "../logger";
import { SETTINGS, __loadSettingsCache, type SettingDef, type SettingKey } from "./registry";
import { storedOrNull, validateBatch, type StoredValue } from "./validate";

type Row = { key: string; value: unknown; updated_by: string | null; updated_at: Date | string | null };
type Meta = { value: StoredValue | null; updatedBy: string | null; updatedAt: string | null };

export type SettingState = {
  key: SettingKey;
  def: SettingDef;
  /** Stored value; null = the default is in force. */
  value: StoredValue | null;
  /** What the code reads now (stored value or default). */
  effective: StoredValue;
  default: StoredValue;
  updatedBy: string | null;
  updatedAt: string | null;
};

let meta = new Map<string, Meta>();

const iso = (v: Date | string | null): string | null => (v == null ? null : new Date(v).toISOString());

function apply(rows: readonly Row[]): void {
  const next = new Map<string, Meta>();
  const values: Record<string, unknown> = {};
  for (const r of rows) {
    if (!Object.prototype.hasOwnProperty.call(SETTINGS, r.key)) continue; // a key removed from the registry
    const v = storedOrNull(r.key, r.value);
    next.set(r.key, { value: v, updatedBy: r.updated_by, updatedAt: iso(r.updated_at) });
    if (v !== null) values[r.key] = v;
  }
  meta = next;
  __loadSettingsCache(values);
}

async function loadRows(): Promise<Row[]> {
  const { rows } = await pool.query<Row>(`SELECT key, value, updated_by, updated_at FROM app_settings`);
  return rows;
}

/** Loads stored values into the setting() cache. Never throws (a missing table = defaults, logged). */
export async function warmSettings(): Promise<void> {
  try {
    apply(await loadRows());
  } catch (err) {
    logger.warn({ err }, "settings: could not load app_settings — defaults in force");
  }
}

function stateOf(key: SettingKey): SettingState {
  const def = SETTINGS[key] as SettingDef;
  const m = meta.get(key);
  const value = m?.value ?? null;
  return { key, def, value, effective: value ?? def.default, default: def.default, updatedBy: m?.updatedBy ?? null, updatedAt: m?.updatedAt ?? null };
}

/** Every registry key (registry order) with its current state. */
export async function settingsState(): Promise<SettingState[]> {
  apply(await loadRows());
  return (Object.keys(SETTINGS) as SettingKey[]).map(stateOf);
}

/** Latest save (ISO) of any key starting with `prefix`, from the warm cache; null = never changed. */
export function settingsChangedAt(prefix: string): string | null {
  let best: string | null = null;
  for (const [k, m] of meta) if (k.startsWith(prefix) && m.updatedAt && (!best || m.updatedAt > best)) best = m.updatedAt;
  return best;
}

export type SettingChange = { key: string; value?: unknown };

/** Validates and writes a batch; returns the keys that actually changed. Throws SETTINGS_INVALID on any problem. */
export async function saveSettings(changes: readonly SettingChange[], actor: string): Promise<{ changed: SettingKey[]; settings: SettingState[] }> {
  const v = validateBatch(changes);
  if (!v.ok) throw new AppError("SETTINGS_INVALID", 400, undefined, { problems: v.problems });
  const client = await pool.connect();
  const audits: { key: SettingKey; from: StoredValue; to: StoredValue; reset: boolean }[] = [];
  try {
    await client.query("BEGIN");
    const keys = v.values.map((c) => c.key);
    const { rows } = await client.query<Row>(`SELECT key, value, updated_by, updated_at FROM app_settings WHERE key = ANY($1::text[]) FOR UPDATE`, [keys]);
    const before = new Map(rows.map((r) => [r.key, storedOrNull(r.key, r.value)]));
    for (const c of v.values) {
      const old = before.get(c.key) ?? null;
      if (old === c.value) continue;
      await client.query(
        `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [c.key, c.value === null ? null : JSON.stringify(c.value), actor],
      );
      const def = SETTINGS[c.key].default as StoredValue;
      audits.push({ key: c.key, from: old ?? def, to: c.value ?? def, reset: c.value === null });
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  for (const a of audits) {
    const unit = (SETTINGS[a.key] as SettingDef).unit;
    await logAudit({ actor, action: "settings.update", targetType: "setting", targetId: a.key, details: { from: a.from, to: a.to, ...(unit ? { unit } : {}), ...(a.reset ? { reset: true } : {}) } });
  }
  if (audits.length) logger.info({ actor, keys: audits.map((a) => a.key) }, "settings: saved");
  return { changed: audits.map((a) => a.key), settings: await settingsState() };
}

/** Tests only. */
export function __resetSettingsStore(): void {
  meta = new Map();
  __loadSettingsCache({});
}
