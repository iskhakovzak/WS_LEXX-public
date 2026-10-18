/**
 * Current UI language (module-level, no React). `getLang()` is what plain-TS `ns.t()` and the formatters read;
 * React code subscribes through `useLang()` / `ns.useT()` (i18n/index.ts).
 */
import { DEFAULT_LANG, isLang, type Lang } from "./core";

export const LANG_STORAGE_KEY = "ws_lexx_lang";
/** Set when the user picked a language that is not saved to their profile yet (login page, offline, old API). */
export const LANG_PENDING_KEY = "ws_lexx_lang_pending";

/** Where a language change came from: the user's own choice, the user profile, or start-up detection. */
export type LangSource = "user" | "profile" | "init";

function readStored(): Lang | null {
  try {
    const v = typeof localStorage !== "undefined" ? localStorage.getItem(LANG_STORAGE_KEY) : null;
    return isLang(v) ? v : null;
  } catch {
    return null;
  }
}

/** localStorage → browser language (en*, uz*; else ru). The profile language is applied after sign-in. */
export function detectInitialLang(): Lang {
  const stored = readStored();
  if (stored) return stored;
  if (typeof window === "undefined" || typeof navigator === "undefined") return DEFAULT_LANG;
  const prefs = (navigator.languages?.length ? navigator.languages : [navigator.language]).map((l) => String(l ?? "").toLowerCase());
  for (const l of prefs) {
    if (l.startsWith("ru")) return "ru";
    if (l.startsWith("uz")) return "uz";
    if (l.startsWith("en")) return "en";
  }
  return DEFAULT_LANG;
}

let current: Lang = detectInitialLang();
let version = 0;
const listeners = new Set<() => void>();
const changeListeners = new Set<(lang: Lang, source: LangSource) => void>();

export function getLang(): Lang {
  return current;
}

/** Bumped on every language switch and every dictionary arrival (useSyncExternalStore snapshot). */
export function getVersion(): number {
  return version;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify(): void {
  version++;
  listeners.forEach((fn) => fn());
}

/** Listen to actual language switches (not dictionary loads). */
export function onLangChange(fn: (lang: Lang, source: LangSource) => void): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

function setHtmlLang(lang: Lang) {
  if (typeof document !== "undefined") document.documentElement.lang = lang;
}
setHtmlLang(current);

/** Make `lang` current (dictionaries must already be loaded by the caller). */
export function applyLang(lang: Lang, source: LangSource): void {
  if (lang === current) return;
  current = lang;
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch { /* storage blocked */ }
  setHtmlLang(lang);
  notify();
  changeListeners.forEach((fn) => fn(lang, source));
}
