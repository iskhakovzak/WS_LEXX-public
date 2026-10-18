/**
 * Latin display names (users.name_latin) by stored name. Framework-free store: AuthProvider fills it from the user
 * list it already loads; `personName()` (i18n/person-name.ts) reads it. Cached in localStorage so the first paint
 * after a reload already shows Latin names; `version` changes only when the content changes, and I18nProvider
 * re-mounts the tree on it (outside Russian), the same way it does on a language switch.
 *
 * The stored name stays the identity everywhere (API params, URLs, filters, keys); only the display changes.
 */

const STORAGE_KEY = "ws_lexx_latin_names";

let map = new Map<string, string>();
let version = 0;
const listeners = new Set<() => void>();

function readCache(): Map<string, string> {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return new Map();
    const obj = JSON.parse(raw) as unknown;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return new Map();
    const out = new Map<string, string>();
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) if (typeof v === "string" && v.trim()) out.set(k, v);
    return out;
  } catch {
    return new Map();
  }
}

function writeCache(m: Map<string, string>) {
  try {
    if (m.size) localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(m)));
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* storage blocked */ }
}

map = readCache();

function sameMap(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/** Replace the whole table (name → Latin name; empty / missing Latin names are skipped). No-op when nothing changed. */
export function setLatinNames(entries: Iterable<readonly [string, string | null | undefined]>): void {
  const next = new Map<string, string>();
  for (const [name, latin] of entries) {
    const v = latin?.trim();
    if (name && v) next.set(name, v);
  }
  if (sameMap(map, next)) return;
  map = next;
  writeCache(next);
  version++;
  listeners.forEach((l) => l());
}

/** Forget every Latin name (sign-out: the next account may see a different roster). */
export function clearLatinNames(): void {
  setLatinNames([]);
}

/** The Latin name set for a stored name, or undefined. */
export function latinNameOf(name: string | null | undefined): string | undefined {
  return name ? map.get(name) : undefined;
}

export function latinNamesVersion(): number {
  return version;
}

export function subscribeLatinNames(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
