/**
 * Indicator favourites ("Мой набор") + notes — audit P1-6.
 * Source of truth: the server (GET/PUT /api/indicator-notes, per user). localStorage is a cache for instant first
 * paint and the fallback when the API is unreachable (or not yet rebuilt). All storage access is try/catch-wrapped;
 * keys are kept compatible with the old page. On the first successful server load the browser's data is migrated
 * once (per user) with onlyIfEmpty semantics — it never overwrites what the server already has.
 */
import { http } from "@/lib/api/http";

const FAV_KEY = "indicator-favorites";
const NOTES_KEY = "indicator-notes";
const PREFS_KEY = "indicators-prefs-v2";
const MIGRATED_KEY = "indicator-notes-migrated-v1:";
const API = "/api/indicator-notes";
/** Rows of the same table that hold market-indicator alert thresholds (market/alerts.ts) — not library notes. */
const ALERT_PREFIX = "mkt-alert.";

export function loadFavorites(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(FAV_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
export function saveFavorites(ids: string[]): boolean {
  try { localStorage.setItem(FAV_KEY, JSON.stringify(ids)); return true; } catch { return false; }
}

export function loadNotes(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(NOTES_KEY) || "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}
export function saveNotes(notes: Record<string, string>): boolean {
  try { localStorage.setItem(NOTES_KEY, JSON.stringify(notes)); return true; } catch { return false; }
}

export type IndicatorState = { favorites: string[]; notes: Record<string, string> };
type ServerItem = { key: string; note: string; favorite: boolean; updatedAt: string };
type ServerList = { user: string | null; items: ServerItem[] };

function fromServer(list: ServerList): IndicatorState {
  const favorites: string[] = [];
  const notes: Record<string, string> = {};
  for (const it of Array.isArray(list.items) ? list.items : []) {
    if (!it || typeof it.key !== "string" || it.key.startsWith(ALERT_PREFIX)) continue;
    if (it.favorite) favorites.push(it.key);
    if (typeof it.note === "string" && it.note.trim()) notes[it.key] = it.note;
  }
  return { favorites, notes };
}

/** Keep the user's local order for favourites both sides know; append server-only ones. */
function orderLike(local: string[], server: string[]): string[] {
  const set = new Set(server);
  return [...local.filter((k) => set.has(k)), ...server.filter((k) => !local.includes(k))];
}

async function getServer(): Promise<ServerList | null> {
  try {
    const d = await http.get<ServerList>(API);
    return d && Array.isArray(d.items) ? d : null;
  } catch {
    return null;
  }
}

async function putBulk(items: { key: string; note?: string; favorite?: boolean }[], onlyIfEmpty: boolean): Promise<ServerList | null> {
  if (!items.length) return null;
  try {
    return await http.put<ServerList>(API, { items, onlyIfEmpty });
  } catch {
    return null;
  }
}

function readFlag(k: string): boolean {
  try { return localStorage.getItem(k) === "1"; } catch { return false; }
}
function writeFlag(k: string) {
  try { localStorage.setItem(k, "1"); } catch { /* storage unavailable */ }
}

/**
 * Load from the server (migrating the browser's data once), refresh the local cache, return the state.
 * null ⇒ server unavailable: keep using the local cache.
 */
export async function syncIndicatorState(): Promise<IndicatorState | null> {
  let list = await getServer();
  if (!list) return null;
  const local: IndicatorState = { favorites: loadFavorites(), notes: loadNotes() };
  if (list.user) {
    const flag = MIGRATED_KEY + list.user;
    if (!readFlag(flag)) {
      const items: { key: string; note?: string; favorite?: boolean }[] = [];
      const keys = new Set([...local.favorites, ...Object.keys(local.notes)]);
      for (const key of keys) {
        if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(key) || key.startsWith(ALERT_PREFIX)) continue;
        items.push({ key, ...(local.favorites.includes(key) ? { favorite: true } : {}), ...(local.notes[key] ? { note: local.notes[key].slice(0, 4000) } : {}) });
      }
      if (!items.length) writeFlag(flag);
      else {
        const migrated = await putBulk(items.slice(0, 500), true);
        if (migrated) { list = migrated; writeFlag(flag); }
      }
    }
  }
  const server = fromServer(list);
  const state: IndicatorState = { favorites: orderLike(local.favorites, server.favorites), notes: server.notes };
  saveFavorites(state.favorites);
  saveNotes(state.notes);
  return state;
}

/** Persist one indicator's favourite flag and/or note on the server. false ⇒ only the local cache has it. */
export async function pushIndicator(key: string, patch: { note?: string; favorite?: boolean }): Promise<boolean> {
  try {
    await http.put(`${API}/${encodeURIComponent(key)}`, patch);
    return true;
  } catch {
    return false;
  }
}

/** Persist a favourites change (diff of two lists) on the server. */
export async function pushFavoritesDiff(prev: string[], next: string[]): Promise<boolean> {
  const added = next.filter((k) => !prev.includes(k));
  const removed = prev.filter((k) => !next.includes(k));
  if (!added.length && !removed.length) return true;
  const res = await putBulk([...added.map((key) => ({ key, favorite: true })), ...removed.map((key) => ({ key, favorite: false }))], false);
  return res != null;
}

/** Persist several notes at once (import: only where the server note is empty). */
export async function pushNotes(notes: Record<string, string>, onlyIfEmpty = true): Promise<boolean> {
  const items = Object.entries(notes).map(([key, note]) => ({ key, note }));
  if (!items.length) return true;
  return (await putBulk(items, onlyIfEmpty)) != null;
}

export type Prefs = { category: string; horizon: string; sort: string; view: string };
const DEFAULT_PREFS: Prefs = { category: "all", horizon: "all", sort: "recommended", view: "cards" };

export function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    return { ...DEFAULT_PREFS, ...(raw && typeof raw === "object" ? raw : {}) };
  } catch {
    return DEFAULT_PREFS;
  }
}
export function savePrefs(p: Prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* storage unavailable */ }
}

export function downloadText(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
