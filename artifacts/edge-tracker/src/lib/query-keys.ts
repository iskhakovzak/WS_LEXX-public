// Query-key conventions + one place that knows which screens depend on the trade book.
// After any trade mutation (create / update / delete / bulk / executions / import) call
// `invalidateTradeDependents(qc)` so the dashboard, journal, playbook, analytics, risk desk
// and leaderboard refetch — instead of each page remembering its own list of keys.
import type { QueryClient, QueryKey } from "@tanstack/react-query";

/** First segments (or "/api/…" prefixes) of every query that is derived from trades. */
const TRADE_DEPENDENT_PREFIXES: readonly string[] = [
  "/api/trades",
  "/api/dashboard",
  "/api/risk",
  "/api/journal",
  "/api/analytics",
  "/api/leaderboard",
  "/api/playbook",
  "/api/propreports",
  "/api/trade-quality",
  "dashboard",
  "risk",
  "big7-risk-me",
  "analyst-my-days",
  "journal",
  "journal-checkin",
  "journal-violations",
  "weekly-review",
  "playbook",
  "playbook-trades",
  "playbook-summary",
  "playbook-health",
  "playbook-edge",
  "playbook-marks",
  "playbook-all-light",
  "all-playbook-trades-stats",
  "analytics",
  "analytics-psychology",
  "leaderboard",
  "event-trades",
  "all-trades-for-link",
  "activity-feed",
  "activity-summary",
  "admin-overview",
  "admin-desk-pulse",
  "admin-risk-desk-lite",
  "trades-related",
  "trade-checklist-response",
  "trade-executions",
  "trade-quality",
  "trades-quality",
  "scaling",
  "eod",
  "weekly-report",
  // Stop-gap until phase E (`meta.deps`): trade-derived screens that were missing from this list.
  "behavior",
  "setups-auto",
  "benchmark",
  "day-report",
  "/api/eod",
  "/api/events",
  // Daily loop (focus / evening card are decided from the trades).
  "daily",
];

function firstSegment(key: QueryKey): string | null {
  const k = key[0];
  return typeof k === "string" ? k : null;
}

/** True when a query key belongs to a screen that shows trade-derived numbers. */
export function isTradeDependentKey(key: QueryKey): boolean {
  const s = firstSegment(key);
  if (!s) return false;
  // Orval-generated keys look like ["/api/trades", params] — match by prefix.
  return TRADE_DEPENDENT_PREFIXES.some((p) => s === p || s.startsWith(`${p}/`) || s.startsWith(`${p}-`) || (p.startsWith("/api/") && s.startsWith(p)));
}

/**
 * Invalidate every query that depends on the trade book. Cheap: react-query only refetches
 * what is currently mounted; the rest is marked stale.
 */
export function invalidateTradeDependents(qc: QueryClient, opts: { tradeId?: number | null } = {}): Promise<void> {
  const tasks: Promise<unknown>[] = [qc.invalidateQueries({ predicate: (q) => isTradeDependentKey(q.queryKey) })];
  if (opts.tradeId != null) {
    tasks.push(qc.invalidateQueries({ queryKey: ["trade-executions", opts.tradeId] }));
    tasks.push(qc.invalidateQueries({ queryKey: ["trade-quality", opts.tradeId] }));
    tasks.push(qc.invalidateQueries({ queryKey: ["trade-checklist-response", opts.tradeId] }));
  }
  return Promise.all(tasks).then(() => undefined);
}

/** Keys owned by the trade replay / execution-quality feature. */
export const qualityKeys = {
  one: (tradeId: number, afterExit: number) => ["trade-quality", tradeId, afterExit] as const,
  many: (ids: number[], afterExit: number) => ["trades-quality", afterExit, ids.join(",")] as const,
  replay: (tradeId: number, ticker: string, from: string, to: string, interval: string) => ["trade-replay", tradeId, ticker, from, to, interval] as const,
};
