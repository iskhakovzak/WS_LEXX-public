/**
 * Latin display names (users.name_latin) for server-rendered text. Names are stored in Cyrillic and stay the identity
 * (trades.trader, params, audit, URLs); text rendered for an English or Uzbek reader shows the Latin name an admin set,
 * the stored name otherwise. Mirror of the web helper (edge-tracker i18n/person-name.ts).
 *
 *   personNameFor("Закир", "uz") → «Zakir» (when set) / «Закир»
 *
 * Synchronous on purpose (renderers are sync): the table lives in memory, loaded at start-up and refreshed in the
 * background at most once a minute (`touchLatinNames()` on requests, the admin edit calls `reloadLatinNames()`).
 */
import { pool } from "@workspace/db";
import type { Lang } from "../../i18n";
import { logger } from "../logger";

const TTL_MS = 60_000;
let map = new Map<string, string>();
let loadedAt = 0;
let inflight: Promise<void> | null = null;

/** Reload the table now (after an admin changed a Latin name, at start-up). Never throws. */
export function reloadLatinNames(): Promise<void> {
  if (inflight) return inflight;
  inflight = pool
    .query<{ name: string; name_latin: string | null }>(`SELECT name, name_latin FROM users WHERE name_latin IS NOT NULL AND btrim(name_latin) <> ''`)
    .then(({ rows }) => {
      const next = new Map<string, string>();
      for (const r of rows) if (r.name && r.name_latin?.trim()) next.set(String(r.name), r.name_latin.trim());
      map = next;
      loadedAt = Date.now();
    })
    .catch((err: unknown) => {
      // Column missing on an old DB, or the DB is down: keep the last table, retry on the next touch.
      loadedAt = Date.now();
      logger.debug({ err }, "latinNames: reload failed");
    })
    .finally(() => { inflight = null; });
  return inflight;
}

/** Refresh in the background when the table is older than a minute (cheap; call it per request). */
export function touchLatinNames(): void {
  if (Date.now() - loadedAt > TTL_MS) void reloadLatinNames();
}

/** Display name for a reader's language. Empty input → "". */
export function personNameFor(name: string | null | undefined, lang: Lang | null | undefined): string {
  if (!name) return "";
  if (!lang || lang === "ru") return name;
  touchLatinNames();
  return map.get(name) ?? name;
}

/** Same for a list of names («Закир, Умид» in a sentence). */
export function personNamesFor(names: readonly string[], lang: Lang | null | undefined): string[] {
  return names.map((n) => personNameFor(n, lang));
}

/** Test hook: set the table directly. */
export function __setLatinNamesForTest(entries: Record<string, string>): void {
  map = new Map(Object.entries(entries));
  loadedAt = Date.now();
}
