/**
 * i18n runtime: namespaces, language switching, React bindings. See i18n/README.md.
 *
 *   // i18n/ns/trades.ts
 *   import ru from "../locales/ru/trades";
 *   export const tradesI18n = createNamespace("trades", ru, {
 *     en: () => import("../locales/en/trades"),
 *     uz: () => import("../locales/uz/trades"),
 *   });
 *
 *   // in a component                         // in plain TS (called at render/call time, never at module scope)
 *   const { t } = tradesI18n.useT();          tradesI18n.t("filters.side.long")
 *   t("count", { count: rows.length });
 */
import React, { Fragment, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { translate, lookup, renderEntry, isLang, type Dict, type Lang, type Params, type TFunction } from "./core";
import { applyLang, getLang, getVersion, notify, subscribe, type LangSource } from "./state";
import { latinNamesVersion, subscribeLatinNames } from "@/lib/people/latin-names";

export * from "./core";
export { getLang, onLangChange, LANG_STORAGE_KEY, LANG_PENDING_KEY, type LangSource } from "./state";
export { liveLabels } from "./live-labels";
export { personName, personNameFor, personInitials, comparePersonNames } from "./person-name";

type Loader = () => Promise<{ default: Dict }>;
export type NamespaceLoaders = Record<Exclude<Lang, "ru">, Loader>;

type NsRecord = {
  name: string;
  ru: Dict;
  loaders: NamespaceLoaders;
  dicts: Partial<Record<Lang, Dict>>;
  pending: Partial<Record<Lang, Promise<void>>>;
  failed: Set<Lang>;
};

const registry = new Map<string, NsRecord>();

function load(rec: NsRecord, lang: Lang): Promise<void> {
  if (lang === "ru" || rec.dicts[lang] || rec.failed.has(lang)) return Promise.resolve();
  const existing = rec.pending[lang];
  if (existing) return existing;
  const p = rec.loaders[lang]()
    .then((m) => {
      rec.dicts[lang] = m.default;
      if (getLang() === lang) notify();
    })
    .catch((err) => {
      // Missing chunk / network: keep showing RU for this namespace; the next setLang() retries.
      rec.failed.add(lang);
      console.warn(`[i18n] could not load "${rec.name}" (${lang}), falling back to ru`, err);
    })
    .finally(() => {
      delete rec.pending[lang];
    });
  rec.pending[lang] = p;
  return p;
}

/** Resolves when every namespace registered so far has its dictionary for `lang` (default: current). */
export function i18nReady(lang: Lang = getLang()): Promise<void> {
  return Promise.all([...registry.values()].map((r) => load(r, lang))).then(() => undefined);
}

export type Namespace<D extends Dict> = {
  readonly name: string;
  /** Translate in plain TS with the current language. Call it at render/call time, never at module scope. */
  t: TFunction<D>;
  /** For keys built at runtime (server enum codes etc.): the text, or undefined when the key does not exist. */
  tryT: (key: string, params?: Params) => string | undefined;
  /** In components: re-renders when the language changes or this namespace's dictionary arrives. */
  useT: () => { t: TFunction<D>; tryT: (key: string, params?: Params) => string | undefined; lang: Lang };
  /** Load this namespace for the current language (await it in a lazy loader to avoid a flash of RU). */
  ready: () => Promise<void>;
};

/**
 * Register a dictionary namespace. RU is static (stays in the importing chunk); EN/UZ are lazy chunks. When a
 * non-RU language is active, loading starts as soon as this runs (i.e. when the module is evaluated).
 */
export function createNamespace<D extends Dict>(name: string, ru: D, loaders: NamespaceLoaders): Namespace<D> {
  const rec: NsRecord = { name, ru, loaders, dicts: {}, pending: {}, failed: new Set() };
  registry.set(name, rec); // re-registration (HMR) replaces the record
  if (getLang() !== "ru") void load(rec, getLang());

  const tr = (key: string, params?: Params): string => {
    const lang = getLang();
    if (lang !== "ru" && !rec.dicts[lang]) void load(rec, lang);
    return translate({ ru: rec.ru, current: rec.dicts[lang] }, lang, key, params);
  };
  const t = tr as unknown as TFunction<D>;
  const tryT = (key: string, params?: Params): string | undefined => {
    const lang = getLang();
    const own = lang === "ru" ? undefined : lookup(rec.dicts[lang], key);
    if (own !== undefined) return renderEntry(own, lang, params);
    const base = lookup(rec.ru, key);
    return base === undefined ? undefined : renderEntry(base, "ru", params);
  };

  function useT() {
    const v = useSyncExternalStore(subscribe, getVersion, getVersion);
    const lang = getLang();
    if (lang !== "ru" && !rec.dicts[lang]) void load(rec, lang);
    // New function identities per version, so memoized children that receive `t` re-render too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return useMemo(() => ({ t: ((k: string, p?: Params) => tr(k, p)) as unknown as TFunction<D>, tryT, lang }), [v, lang]);
  }

  return { name, t, tryT, useT, ready: () => load(rec, getLang()) };
}

// ─── Language switching ──────────────────────────────────────────────────────────────────────────────────

let switchSeq = 0;
let pendingScrollTop: number | null = null;
let pendingFocus: string | null = null;

/**
 * Switch the UI language: loads the language for every registered namespace, then makes it current
 * (localStorage, <html lang>, re-render + remount under <I18nProvider>). `source: "user"` also saves it to
 * the profile (see locale-sync.tsx). `focus`: a CSS selector to focus after the re-mount (the control that
 * triggered the switch was unmounted with the old tree). Resolves when the switch is applied.
 */
export async function setLang(lang: Lang, opts: { source?: LangSource; focus?: string } = {}): Promise<void> {
  if (!isLang(lang)) return;
  const seq = ++switchSeq;
  registry.forEach((r) => r.failed.delete(lang));
  await i18nReady(lang);
  if (seq !== switchSeq) return; // a newer switch won
  if (lang === getLang()) return;
  if (typeof document !== "undefined") {
    const main = document.getElementById("main-content");
    pendingScrollTop = main ? main.scrollTop : null;
    pendingFocus = opts.focus ?? null;
  }
  applyLang(lang, opts.source ?? "user");
}

/** Current language; re-renders on switch. */
export function useLang(): Lang {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return getLang();
}

/**
 * Put it under QueryClientProvider, around the app content. On a switch it re-mounts its children (key = lang)
 * so every plain `t()` call and formatter re-runs, keeps the query cache, re-fetches queries (server texts
 * depend on X-Lang; opt a query out with `meta: { i18n: false }`), and restores the main scroll position.
 * Route, URL filters and providers above it survive; component-local state below it is reset.
 */
export function I18nProvider({ children }: { children: React.ReactNode }) {
  const lang = useLang();
  // Latin display names (person-name.ts) only matter outside Russian: re-mount when they change there.
  const namesV = useSyncExternalStore(subscribeLatinNames, latinNamesVersion, latinNamesVersion);
  const qc = useQueryClient();
  const prev = useRef(lang);
  useLayoutEffect(() => {
    if (prev.current === lang) return;
    prev.current = lang;
    const top = pendingScrollTop;
    pendingScrollTop = null;
    if (top != null) {
      const restore = () => {
        const main = document.getElementById("main-content");
        if (main) main.scrollTop = top;
      };
      restore();
      window.setTimeout(restore, 0);
    }
    const focusSel = pendingFocus;
    pendingFocus = null;
    if (focusSel) {
      // After Radix menus/selects finish their own close-and-return-focus (their trigger is gone).
      window.setTimeout(() => document.querySelector<HTMLElement>(focusSel)?.focus(), 60);
    }
    void qc.invalidateQueries({ predicate: (q) => (q.meta as { i18n?: boolean } | undefined)?.i18n !== false });
  }, [lang, qc]);
  return React.createElement(Fragment, { key: lang === "ru" ? lang : `${lang}:${namesV}` }, children);
}
