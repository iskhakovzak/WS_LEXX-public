/**
 * Lazy page chunks, one per route. App.tsx wraps them in React.lazy; the sidebar / tab bar call
 * `preloadRoute(href)` on hover/focus so the chunk is usually in cache before the click, and the shell
 * warms the most used sections once the browser is idle. Calling a loader twice is free (module cache).
 *
 * i18n: a page module registers its dictionary namespaces when it is evaluated; with EN/UZ active those load
 * lazily. Each loader resolves only after `i18nReady()`, so React.lazy keeps the skeleton up for those few ms
 * instead of flashing Russian text.
 */
import type { ComponentType } from "react";
import { i18nReady } from "@/i18n";

type Loader = () => Promise<{ default: ComponentType<any> }>;

const PAGE_IMPORTS = {
  "/trades": () => import("@/pages/trades"),
  "/events": () => import("@/pages/events"),
  "/research": () => import("@/pages/research"),
  "/dailyfeed": () => import("@/pages/dailyfeed"),
  "/discussions": () => import("@/pages/discussions"),
  "/analytics": () => import("@/pages/analytics"),
  "/settings": () => import("@/pages/settings"),
  "/watchlist": () => import("@/pages/watchlist"),
  "/playbook": () => import("@/pages/playbook"),
  "/trade-ideas": () => import("@/pages/trade-ideas"),
  "/trade-idea-stats": () => import("@/pages/trade-idea-stats"),
  "/calculator": () => import("@/pages/calculator"),
  "/activity": () => import("@/pages/activity"),
  "/rules": () => import("@/pages/error-tracker"),
  "/indicators": () => import("@/pages/indicators"),
  "/big7": () => import("@/pages/big7"),
  "/ratings": () => import("@/pages/ratings"),
  "/analyst-actions": () => import("@/pages/analyst-actions"),
  "/stats": () => import("@/pages/stats"),
  "/journal": () => import("@/pages/journal"),
  "/top-results": () => import("@/pages/top-results"),
  "/admin": () => import("@/pages/admin"),
  "/curator": () => import("@/pages/curator"),
  "/author-notes": () => import("@/pages/author-notes"),
  "/junior-notes": () => import("@/pages/junior-notes"),
  "/offerings": () => import("@/pages/offerings"),
  "/risk": () => import("@/pages/risk"),
  "/game-plan": () => import("@/pages/game-plan"),
  "/integrations": () => import("@/pages/integrations"),
  "/scaling": () => import("@/pages/scaling"),
  "/weekly-review": () => import("@/pages/weekly-review"),
  "/notifications": () => import("@/pages/notifications"),
  "/simulator": () => import("@/pages/simulator"),
  "/what-if": () => import("@/pages/what-if"),
  "/behavior": () => import("@/pages/behavior"),
  "/day-report": () => import("@/pages/day-report"),
  "/benchmark": () => import("@/pages/benchmark"),
  "/office": () => import("@/pages/office-stats"),
  "/ask": () => import("@/pages/ask"),
  "/chart-lab": () => import("@/pages/chart-lab"),
  "/desk-day": () => import("@/pages/desk-day"),
  "/academy/path": () => import("@/pages/academy/path"),
  "/academy/challenges": () => import("@/pages/academy/challenges"),
  "/academy/my": () => import("@/pages/academy/my"),
  "/academy/mentor": () => import("@/pages/academy/mentor"),
  "/academy/cohorts": () => import("@/pages/academy/cohorts"),
  "/academy/learn": () => import("@/pages/academy/learn"),
  "/academy/lesson": () => import("@/pages/academy/lesson"),
  "/academy/content-admin": () => import("@/pages/academy/content-admin"),
} satisfies Record<string, Loader>;

export type LazyRoute = keyof typeof PAGE_IMPORTS;

export const ROUTE_LOADERS = Object.fromEntries(
  Object.entries(PAGE_IMPORTS).map(([path, load]) => [path, () => load().then(async (m) => { await i18nReady(); return m; })]),
) as { [K in LazyRoute]: (typeof PAGE_IMPORTS)[K] };

const started = new Set<string>();

/** Start downloading a section's chunk (no-op for unknown paths, the eager dashboard, or repeats). Never throws. */
export function preloadRoute(href: string) {
  const path = href.split(/[?#]/)[0];
  const load = (ROUTE_LOADERS as Record<string, Loader | undefined>)[path];
  if (!load || started.has(path)) return;
  started.add(path);
  // A failed prefetch must not poison the real navigation: forget it so the click retries.
  load().catch(() => started.delete(path));
}

/** Warm the sections people open right after the dashboard, once the browser is idle (skipped on Save-Data). */
export function preloadCommonRoutes(paths: string[] = ["/trades", "/journal", "/game-plan"]) {
  if (typeof window === "undefined") return () => {};
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (conn?.saveData) return () => {};
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
  const run = () => paths.forEach(preloadRoute);
  if (w.requestIdleCallback) {
    const id = w.requestIdleCallback(run, { timeout: 4000 });
    return () => w.cancelIdleCallback?.(id);
  }
  const t = setTimeout(run, 2500);
  return () => clearTimeout(t);
}
