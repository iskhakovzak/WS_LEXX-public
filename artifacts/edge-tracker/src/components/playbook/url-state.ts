/**
 * Playbook filters in the URL (shareable links, back/forward keeps them): a tiny wrapper over wouter's search string.
 * `patchSearch` is pure (unit-tested); `useUrlParams` reads / replaces params on the current path.
 */
import { useCallback, useMemo } from "react";
import { useLocation, useSearch } from "wouter";

/** Apply updates to a search string: null / "" / the param's default removes it. Keeps every other param and order. */
export function patchSearch(search: string, updates: Record<string, string | null | undefined>, defaults: Record<string, string> = {}): string {
  const p = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  for (const [k, v] of Object.entries(updates)) {
    if (v == null || v === "" || defaults[k] === v) p.delete(k);
    else p.set(k, v);
  }
  return p.toString();
}

export function useUrlParams() {
  const search = useSearch();
  const [location, navigate] = useLocation();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const set = useCallback(
    (updates: Record<string, string | null | undefined>, defaults?: Record<string, string>) => {
      const next = patchSearch(window.location.search, updates, defaults);
      const cur = window.location.search.replace(/^\?/, "");
      if (next === cur) return;
      navigate(`${location}${next ? `?${next}` : ""}`, { replace: true });
    },
    [location, navigate],
  );
  return { params, set };
}
