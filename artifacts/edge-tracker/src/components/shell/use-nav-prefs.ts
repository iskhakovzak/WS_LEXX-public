/**
 * Per-browser navigation preferences (localStorage, fail-safe):
 * - pinned pages: second-level pages (Статистика, Поведение, Симулятор…) kept visible under their sidebar row;
 * - the desktop sidebar width: full or an icon rail.
 */
import { useCallback, useEffect, useState } from "react";
import { ALL_NAV_ITEMS, parentOf } from "./nav";

const PINS_KEY = "ws_lexx_nav_pins_v2";
/** v1 kept up to 7 «favourites» in a block above the groups (mostly top-level rows, which are always visible now). */
const PINS_KEY_V1 = "ws_lexx_nav_pins";
const RAIL_KEY = "ws_lexx_sidebar_rail";
const SYNC_EVENT = "ws-nav-prefs";

/** At most this many pinned pages (each adds a row to the sidebar). */
export const MAX_PINS = 5;

/** Only second-level pages can be pinned: sidebar rows are always visible anyway. */
export function isPinnable(href: string): boolean {
  const item = ALL_NAV_ITEMS.find((i) => i.href === href);
  return !!item && !!parentOf(item);
}

/** First-visit pins by role: partners (admin) start with the office results one click away. */
export const DEFAULT_PINS: Record<string, string[]> = { admin: ["/office"] };

function parse(raw: string | null): string[] | null {
  if (raw == null) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function readPins(role: string | undefined): string[] {
  try {
    const v2 = parse(localStorage.getItem(PINS_KEY));
    if (v2) return v2.filter(isPinnable);
    // Carry over v1 favourites that are second-level pages now (e.g. /stats); top-level ones are always shown.
    const v1 = parse(localStorage.getItem(PINS_KEY_V1));
    if (v1) return v1.filter(isPinnable).slice(0, MAX_PINS);
  } catch {}
  return DEFAULT_PINS[role ?? ""] ?? [];
}

function writePins(v: string[]) {
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify(v));
  } catch {}
  window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: PINS_KEY }));
}

/** Pinned second-level pages, in sync across the sidebar, the mobile sheet and other tabs. */
export function usePinnedNav(role?: string) {
  const [pins, setPins] = useState<string[]>(() => readPins(role));
  useEffect(() => {
    setPins(readPins(role));
    const onSync = (e: Event) => { if ((e as CustomEvent<string>).detail === PINS_KEY) setPins(readPins(role)); };
    const onStorage = (e: StorageEvent) => { if (e.key === PINS_KEY) setPins(readPins(role)); };
    window.addEventListener(SYNC_EVENT, onSync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(SYNC_EVENT, onSync);
      window.removeEventListener("storage", onStorage);
    };
  }, [role]);
  const togglePin = useCallback(
    (href: string) => {
      const cur = readPins(role);
      if (cur.includes(href)) writePins(cur.filter((x) => x !== href));
      else if (cur.length < MAX_PINS && isPinnable(href)) writePins([...cur, href]);
    },
    [role],
  );
  return { pins, togglePin, isPinned: (href: string) => pins.includes(href), canPin: pins.length < MAX_PINS, maxPins: MAX_PINS };
}

/** Desktop sidebar: true = full width with labels, false = icon rail. Remembered per browser (default: full). */
export function readSidebarOpen(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) !== "1";
  } catch {
    return true;
  }
}

export function writeSidebarOpen(open: boolean) {
  try {
    localStorage.setItem(RAIL_KEY, open ? "0" : "1");
  } catch {}
}
