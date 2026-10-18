/**
 * Desk settings — validation of one value against its registry definition (pure; lib/settings/store.ts and the route
 * use it, tests cover it). `null` always means «back to the default».
 *
 *   number   finite, min ≤ v ≤ max; an integer step (days, points, counts, $5) ⇒ whole numbers only
 *   time     "HH:MM", 00:00–23:59 (New York time)
 *   boolean  true / false
 *   select   one of the declared options
 *
 * A rejected value comes back as a problem the admin page can show next to the field (SETTINGS_INVALID details).
 */
import { SETTINGS, type SettingDef, type SettingKey } from "./registry";

export type SettingProblemKind = "unknown" | "duplicate" | "type" | "range" | "integer" | "time" | "option";
export type SettingProblem = {
  key: string;
  kind: SettingProblemKind;
  min?: number;
  max?: number;
  options?: readonly string[];
};
export type StoredValue = number | boolean | string;

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS, key);
}

export function settingDef(key: string): SettingDef | undefined {
  return isSettingKey(key) ? (SETTINGS[key] as SettingDef) : undefined;
}

/** "HH:MM" → minutes after midnight (null when malformed). */
export function timeToMinutes(v: string): number | null {
  if (!TIME_RE.test(v)) return null;
  return Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));
}

/** Checks `value` for `key`. ok → the value to store (null = reset; numbers normalised to 6 decimals). */
export function validateSetting(key: string, value: unknown): { ok: true; value: StoredValue | null } | { ok: false; problem: SettingProblem } {
  const def = settingDef(key);
  if (!def) return { ok: false, problem: { key, kind: "unknown" } };
  if (value === null) return { ok: true, value: null };
  switch (def.type) {
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, problem: { key, kind: "type" } };
      if (value < def.min || value > def.max) return { ok: false, problem: { key, kind: "range", min: def.min, max: def.max } };
      if (def.step != null && Number.isInteger(def.step) && !Number.isInteger(value)) return { ok: false, problem: { key, kind: "integer" } };
      return { ok: true, value: Math.round(value * 1e6) / 1e6 };
    }
    case "time":
      if (typeof value !== "string") return { ok: false, problem: { key, kind: "type" } };
      return TIME_RE.test(value) ? { ok: true, value } : { ok: false, problem: { key, kind: "time" } };
    case "boolean":
      return typeof value === "boolean" ? { ok: true, value } : { ok: false, problem: { key, kind: "type" } };
    case "select":
      if (typeof value !== "string") return { ok: false, problem: { key, kind: "type" } };
      return def.options.includes(value) ? { ok: true, value } : { ok: false, problem: { key, kind: "option", options: def.options } };
  }
}

/** A stored value that no longer fits its definition (bounds narrowed, type changed) reads as the default. */
export function storedOrNull(key: string, value: unknown): StoredValue | null {
  if (value === null || value === undefined) return null;
  const r = validateSetting(key, value);
  return r.ok ? r.value : null;
}

/** Validates a batch: every key once, all valid — else every problem (nothing is written on any problem). */
export function validateBatch(changes: readonly { key: string; value?: unknown }[]): { ok: true; values: { key: SettingKey; value: StoredValue | null }[] } | { ok: false; problems: SettingProblem[] } {
  const problems: SettingProblem[] = [];
  const values: { key: SettingKey; value: StoredValue | null }[] = [];
  const seen = new Set<string>();
  for (const c of changes) {
    if (seen.has(c.key)) { problems.push({ key: c.key, kind: "duplicate" }); continue; }
    seen.add(c.key);
    const r = validateSetting(c.key, c.value);
    if (!r.ok) problems.push(r.problem);
    else values.push({ key: c.key as SettingKey, value: r.value });
  }
  return problems.length ? { ok: false, problems } : { ok: true, values };
}
