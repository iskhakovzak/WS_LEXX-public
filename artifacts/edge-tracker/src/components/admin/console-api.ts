/**
 * Admin console data layer. New endpoints live under /api/admin/console/* (router routes/admin-console.ts);
 * until the API is rebuilt they answer 404, so every read falls back to existing endpoints and every
 * mutation falls back only to an existing *audited* endpoint — otherwise it reports «нужен перезапуск API».
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, http } from "@/lib/api/http";
import { nullIfMissing } from "@/lib/api/errors";
import { POLL, } from "@/lib/api/keys";
import { addDays, nyDate, prevWeekday } from "@/lib/trading-date";
import type { AuditEntry } from "./api";
import { adminI18n } from "@/i18n/ns/admin";

/* ── Types ───────────────────────────────────────────────────────────────── */

export type PersonStatus = "active" | "frozen" | "archived";

export interface Person {
  id: number;
  name: string;
  /** Optional Latin alias (users.name_latin) for cross-script search; absent on older API builds. */
  nameLatin?: string | null;
  role: string;
  status: PersonStatus;
  active: boolean;
  banned: boolean;
  bannedReason: string | null;
  createdAt: string | null;
  tier: string | null;
  curator: string | null;
  accounts: string[];
  lastSeen: string | null;
  trades30: number;
  lastTrade: string | null;
  telegramLinked: boolean;
}

export interface PeopleData {
  people: Person[];
  accounts: { unmapped: { id: number; account: string; lastSyncedAt: string | null }[]; unmatched: string[] };
  /** "console" = new endpoint, "fallback" = assembled from /users/team + /propreports/*. */
  source: "console" | "fallback";
}

export interface RunLite {
  id: number; startedAt: string | null; finishedAt?: string | null; source: string; status: string; fileName: string | null;
  inserted: number; updated: number; unchanged: number; skipped: number; conflicts: number; errors: number; errorText: string | null; actor: string | null;
}

export interface HealthData {
  today: string;
  sync: {
    configured: boolean;
    missingEnv: string[];
    scheduler: { enabled: boolean; minutes: number | null; nextRunAt: string | null; running: boolean; lastError: string | null };
    lastRun: RunLite | null;
    accounts: { total: number; mapped: number; unmapped: string[] };
    unmatched: string[];
    pending: number;
    imported: number;
    lastSyncedAt: string | null;
  };
  errors24h: { count: number; items: { at: string | null; source: string; text: string }[] };
  source: "console" | "fallback";
}

export interface DataCheck {
  key: string;
  label: string;
  severity: "high" | "medium" | "low";
  count: number;
  groups?: number;
  sample: Record<string, unknown>[];
  hint: string;
}

export interface Tier { key: string; name: string; order: number }

export interface AuditQuery {
  actor?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  q?: string;
  from?: string;
  to?: string;
}

export interface AuditResult {
  items: AuditEntry[];
  total: number;
  facets: { actors: { value: string; count: number }[]; actions: { value: string; count: number }[]; targetTypes: { value: string; count: number }[] };
  source: "console" | "fallback";
}

export class NotDeployedError extends Error {
  readonly notDeployed = true;
  constructor(what: string) {
    super(adminI18n.t("notDeployed", { what }));
  }
}

/* ── Fetch helpers ───────────────────────────────────────────────────────── */

/** POST/PUT `/api${path}`; resolves `{ notFound: true }` on a route-level 404 so callers can fall back. */
async function send<T>(method: "POST" | "PUT", path: string, body: unknown): Promise<T | { notFound: true }> {
  try {
    return await http.send<T>(method, `/api${path}`, body);
  } catch (e) {
    // Route missing (Express 404, no `code`) → fall back; a handler 404 carries a code (NOT_FOUND, *_NOT_FOUND) and is
    // a real error (e.g. «Пользователь не найден»).
    if (!(e instanceof ApiError) || e.status !== 404 || e.code) throw e;
    return { notFound: true };
  }
}
const isNotFound = (v: unknown): v is { notFound: true } => !!v && typeof v === "object" && (v as any).notFound === true;

export const consoleKeys = {
  people: ["admin-console", "people"] as const,
  health: ["admin-console", "health"] as const,
  audit: ["admin-console", "audit"] as const,
  quality: ["admin-console", "quality"] as const,
  tiers: ["admin-console", "tiers"] as const,
  eod: ["admin-console", "eod"] as const,
  eodQueue: ["admin-console", "eod-queue"] as const,
};

/* ── Queries ─────────────────────────────────────────────────────────────── */

type TeamRow = {
  id: number; name: string; role: string; active: boolean; banned: boolean; createdAt: string | null;
  assignedCurator: string | null; trades30: number; lastTrade: string | null; riskTier: string | null; telegramLinked: boolean;
};
type AccountRow = { id: number; account: string; trader: string | null; active: boolean; lastSyncedAt: string | null };

export function usePeople() {
  return useQuery<PeopleData>({
    queryKey: consoleKeys.people,
    queryFn: async () => {
      const direct = await http.get<Omit<PeopleData, "source">>("/api/admin/console/people").catch(nullIfMissing);
      if (direct) return { ...direct, source: "console" };
      const [team, accounts, status] = await Promise.all([
        http.get<TeamRow[]>("/api/users/team"),
        http.get<AccountRow[]>("/api/propreports/accounts").catch(() => [] as AccountRow[]),
        http.get<{ settings?: { unmatched?: string[] } }>("/api/propreports/status").catch(() => null),
      ]);
      const accBy = new Map<string, string[]>();
      for (const a of accounts) if (a.trader) accBy.set(a.trader, [...(accBy.get(a.trader) ?? []), a.account]);
      return {
        source: "fallback",
        people: team.map((u) => ({
          id: u.id, name: u.name, role: u.role,
          status: !u.active ? "archived" : u.banned ? "frozen" : "active",
          active: u.active, banned: u.banned, bannedReason: null, createdAt: u.createdAt,
          tier: u.riskTier, curator: u.assignedCurator, accounts: accBy.get(u.name) ?? [],
          lastSeen: null, trades30: u.trades30 ?? 0, lastTrade: u.lastTrade, telegramLinked: !!u.telegramLinked,
        })),
        accounts: {
          unmapped: accounts.filter((a) => !a.trader).map((a) => ({ id: a.id, account: a.account, lastSyncedAt: a.lastSyncedAt })),
          unmatched: status?.settings?.unmatched ?? [],
        },
      };
    },
    refetchInterval: 60_000,
    staleTime: 15_000,
  });
}

type PrStatus = {
  config: { configured: boolean; missing: string[] };
  scheduler: HealthData["sync"]["scheduler"];
  accounts: { total: number; mapped: number; unmapped: string[] };
  settings: { unmatched: string[] };
  trades: { imported: number; lastSyncedAt: string | null };
  pendingCount: number;
  lastRun: RunLite | null;
};

export function useHealth() {
  return useQuery<HealthData>({
    queryKey: consoleKeys.health,
    queryFn: async () => {
      const direct = await http.get<Omit<HealthData, "source">>("/api/admin/console/health").catch(nullIfMissing);
      if (direct) return { ...direct, source: "console" };
      const [st, runs] = await Promise.all([
        http.get<PrStatus>("/api/propreports/status"),
        http.get<RunLite[]>("/api/propreports/runs", { query: { limit: 20 } }).catch(() => [] as RunLite[]),
      ]);
      const since = Date.now() - 86_400_000;
      const items = runs
        .filter((r) => r.startedAt && Date.parse(r.startedAt) >= since && (r.status === "error" || r.status === "partial" || r.errors > 0))
        .map((r) => {
          const head = r.errors ? adminI18n.t("fallback.syncRunErrors", { id: r.id, status: r.status, errors: r.errors }) : adminI18n.t("fallback.syncRun", { id: r.id, status: r.status });
          return { at: r.startedAt, source: "propreports", text: r.errorText ? `${head} — ${r.errorText}` : head };
        });
      if (st.scheduler?.lastError) items.push({ at: null, source: "scheduler", text: adminI18n.t("fallback.scheduler", { error: st.scheduler.lastError }) });
      return {
        source: "fallback",
        today: nyDate(),
        sync: {
          configured: st.config.configured,
          missingEnv: st.config.missing ?? [],
          scheduler: st.scheduler,
          lastRun: st.lastRun,
          accounts: st.accounts,
          unmatched: st.settings?.unmatched ?? [],
          pending: st.pendingCount ?? 0,
          imported: st.trades?.imported ?? 0,
          lastSyncedAt: st.trades?.lastSyncedAt ?? null,
        },
        errors24h: { count: items.length, items },
      };
    },
    refetchInterval: 60_000,
    staleTime: 20_000,
  });
}

export interface EodStatus {
  date: string;
  traders: { trader: string; status: string; trades: number; reviewedTrades: number; closedAt: string | null; reviewedAt: string | null }[];
}

/**
 * Day-close status per trader for the last finished trading day (previous NY weekday) — the same day the curator
 * cabinet uses for «Не закрыт день». Today's day is still open by definition, so «today» always showed 0.
 */
export function useEodStatus() {
  const date = prevWeekday(nyDate());
  return useQuery<EodStatus | null>({
    queryKey: [...consoleKeys.eod, date],
    queryFn: ({ signal }) => http.get<EodStatus>("/api/eod/status", { query: { date }, signal }).catch(() => null),
    refetchInterval: POLL.minute,
    retry: false,
  });
}

/** Curator review queue size and SLA breaches. null when unavailable. */
export function useEodQueueCount() {
  return useQuery<{ count: number; overdue: number; slaHours: number } | null>({
    queryKey: consoleKeys.eodQueue,
    queryFn: ({ signal }) => http.get<{ count: number; overdue: number; slaHours: number }>("/api/eod/queue/count", { signal }).catch(() => null),
    refetchInterval: POLL.minute,
    retry: false,
  });
}

export function useTiers() {
  return useQuery<Tier[]>({
    queryKey: consoleKeys.tiers,
    queryFn: async () => {
      const r = await http.get<{ tiers?: Tier[] }>("/api/scaling/config").catch(() => null);
      return (r?.tiers ?? []).map((t) => ({ key: t.key, name: t.name, order: t.order })).sort((a, b) => a.order - b.order);
    },
    staleTime: 10 * 60_000,
  });
}

export function useDataQuality(enabled = true) {
  return useQuery<{ checks: DataCheck[]; today: string; generatedAt: string } | null>({
    queryKey: consoleKeys.quality,
    queryFn: ({ signal }) => http.get<{ checks: DataCheck[]; today: string; generatedAt: string }>("/api/admin/console/data-quality", { signal }).catch(nullIfMissing),
    enabled,
    staleTime: 60_000,
  });
}

function sinceDaysFor(from?: string): number | undefined {
  if (!from) return undefined;
  const days = Math.ceil((Date.now() - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  return days > 0 ? days : 1;
}

/** NY trading date of an ISO timestamp. */
export function nyDayOf(iso: string): string {
  return nyDate(new Date(iso));
}

export function useAuditSearch(actor: string, query: AuditQuery) {
  return useQuery<AuditResult>({
    queryKey: [...consoleKeys.audit, actor, query],
    queryFn: async () => {
      const direct = await http.get<Omit<AuditResult, "source">>("/api/admin/console/audit", { query: { ...query, limit: 1000 } }).catch(nullIfMissing);
      if (direct) return { ...direct, source: "console" };
      // Legacy endpoint: actor/action/q/sinceDays on the server, object and exact dates on the client.
      const exactAction = query.action && !query.action.endsWith(".*") ? query.action : undefined;
      const rows = await http.get<AuditEntry[]>("/api/admin/audit", { query: {
        actor, filterActor: query.actor, filterAction: exactAction, q: query.q, sinceDays: sinceDaysFor(query.from), limit: 500,
      } });
      const prefix = query.action?.endsWith(".*") ? query.action.slice(0, -1) : null;
      const items = rows.filter((e) =>
        (!prefix || e.action.startsWith(prefix)) &&
        (!query.targetType || e.targetType === query.targetType) &&
        (!query.targetId || e.targetId === query.targetId) &&
        (!query.from || nyDayOf(e.createdAt) >= query.from) &&
        (!query.to || nyDayOf(e.createdAt) <= query.to));
      const count = (vals: (string | null)[]) => {
        const m = new Map<string, number>();
        for (const v of vals) if (v) m.set(v, (m.get(v) ?? 0) + 1);
        return [...m].map(([value, c]) => ({ value, count: c })).sort((a, b) => b.count - a.count);
      };
      return {
        source: "fallback",
        items,
        total: items.length,
        facets: { actors: count(rows.map((r) => r.actor)), actions: count(rows.map((r) => r.action)), targetTypes: count(rows.map((r) => r.targetType)) },
      };
    },
    placeholderData: (prev) => prev,
  });
}

/* ── Mutations ───────────────────────────────────────────────────────────── */

export type PeopleActionKind = "freeze" | "unfreeze" | "archive" | "restore" | "sessions" | "curator" | "role" | "tier";

export interface PeopleActionInput {
  kind: PeopleActionKind;
  people: Pick<Person, "id" | "name">[];
  reason: string;
  curator?: string | null;
  role?: string;
  tierKey?: string;
}

export interface PeopleActionResult { done: string[]; skipped: { name?: string; error: string }[] }


async function runOne(actor: string, kind: PeopleActionKind, p: Pick<Person, "id" | "name">, input: PeopleActionInput): Promise<void> {
  if (kind === "tier") {
    // Existing audited endpoint (scaling.assign); the reason goes into the history comment.
    const r = await send("POST", "/scaling/assign", { trader: p.name, tierKey: input.tierKey, comment: input.reason });
    if (isNotFound(r)) throw new Error(adminI18n.t("fallback.tierFailed"));
    return;
  }
  const path = kind === "sessions" ? `/admin/console/people/${p.id}/sessions/reset` : `/admin/console/people/${p.id}/${kind}`;
  const body = kind === "curator" ? { curator: input.curator ?? null, reason: input.reason } : kind === "role" ? { role: input.role, reason: input.reason } : { reason: input.reason };
  const r = await send("POST", path, body);
  if (!isNotFound(r)) return;
  // Fallbacks — existing audited admin routes only.
  if (kind === "freeze") {
    const b = await send("POST", `/admin/users/${p.id}/ban?actor=${encodeURIComponent(actor)}`, { actor, reason: input.reason });
    if (isNotFound(b)) throw new Error(adminI18n.t("fallback.userNotFound"));
    return;
  }
  if (kind === "unfreeze") {
    const b = await send("POST", `/admin/users/${p.id}/unban?actor=${encodeURIComponent(actor)}`, { actor });
    if (isNotFound(b)) throw new Error(adminI18n.t("fallback.userNotFound"));
    return;
  }
  if (kind === "role") {
    // Legacy route requires users.manage.admins (admins only).
    const b = await send("POST", `/admin/users/${p.id}/role?actor=${encodeURIComponent(actor)}`, { actor, role: input.role });
    if (isNotFound(b)) throw new Error(adminI18n.t("fallback.userNotFound"));
    return;
  }
  throw new NotDeployedError(adminI18n.t(`fallback.action.${kind}`));
}

export function usePeopleAction(actor: string) {
  const qc = useQueryClient();
  return useMutation<PeopleActionResult, Error, PeopleActionInput>({
    mutationFn: async (input) => {
      const { kind, people } = input;
      if (people.length > 1 && kind !== "role" && kind !== "tier") {
        const r = await send<{ done: string[]; skipped: { name?: string; error: string }[] }>(
          "POST", "/admin/console/people/bulk",
          { ids: people.map((p) => p.id), action: kind, curator: input.curator ?? null, reason: input.reason },
        );
        if (!isNotFound(r)) return { done: r.done, skipped: r.skipped };
      }
      const done: string[] = [];
      const skipped: PeopleActionResult["skipped"] = [];
      for (const p of people) {
        try {
          await runOne(actor, kind, p, input);
          done.push(p.name);
        } catch (e) {
          if (e instanceof NotDeployedError) throw e;
          skipped.push({ name: p.name, error: (e as Error).message });
        }
      }
      if (!done.length && skipped.length === 1) throw new Error(`${skipped[0]!.name}: ${skipped[0]!.error}`);
      return { done, skipped };
    },
    onSettled: () => {
      for (const k of [consoleKeys.people, consoleKeys.audit, ["admin-desk-pulse"], ["admin-overview"], ["admin-audit"]]) qc.invalidateQueries({ queryKey: k });
    },
  });
}

/** Latin alias for search (users.name_latin). Not a rename: the Cyrillic name stays the identifier everywhere. */
export function useSetNameLatin() {
  const qc = useQueryClient();
  return useMutation<{ ok: true; name: string; nameLatin: string | null }, Error, { id: number; nameLatin: string | null }>({
    mutationFn: async ({ id, nameLatin }) => {
      const r = await send<{ ok: true; name: string; nameLatin: string | null }>("POST", `/admin/console/people/${id}/name-latin`, { nameLatin });
      if (isNotFound(r)) throw new NotDeployedError(adminI18n.t("fallback.action.latin"));
      return r;
    },
    onSettled: () => {
      for (const k of [consoleKeys.people, consoleKeys.audit, ["people-directory"]]) qc.invalidateQueries({ queryKey: k });
    },
  });
}

export type LatinNameChange = { id: number; name: string; nameLatin: string | null };

/** Many Latin names in one call (one transaction, one audit entry per changed person): «Fill Latin names». */
export function useSetNamesLatinBulk() {
  const qc = useQueryClient();
  return useMutation<{ ok: true; changed: LatinNameChange[]; unchanged: number }, Error, { id: number; nameLatin: string | null }[]>({
    mutationFn: async (items) => {
      const r = await send<{ ok: true; changed: LatinNameChange[]; unchanged: number }>("POST", "/admin/console/people/name-latin/bulk", { items });
      if (isNotFound(r)) throw new NotDeployedError(adminI18n.t("fallback.action.latin"));
      return r;
    },
    onSettled: () => {
      for (const k of [consoleKeys.people, consoleKeys.audit, ["people-directory"]]) void qc.invalidateQueries({ queryKey: k });
    },
  });
}

export function useCreatePerson() {
  const qc = useQueryClient();
  return useMutation<{ id: number; name: string }, Error, { name: string; password: string; role: string; curator: string | null; reason: string }>({
    mutationFn: async (body) => {
      const r = await send<{ id: number; name: string }>("POST", "/admin/console/people", body);
      if (isNotFound(r)) throw new NotDeployedError(adminI18n.t("fallback.action.create"));
      return r;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: consoleKeys.people });
      qc.invalidateQueries({ queryKey: ["admin-desk-pulse"] });
    },
  });
}

export function useMapAccount() {
  const qc = useQueryClient();
  return useMutation<{ legacy: boolean }, Error, { account: string; trader: string; reason: string }>({
    mutationFn: async (body) => {
      const r = await send("POST", "/admin/console/accounts/map", body);
      if (!isNotFound(r)) return { legacy: false };
      // Existing audited route (propreports.accounts.update) — it has no reason field.
      const p = await send("PUT", "/propreports/accounts", { accounts: [{ account: body.account, trader: body.trader }] });
      if (isNotFound(p)) throw new Error(adminI18n.t("fallback.mapFailed"));
      return { legacy: true };
    },
    onSuccess: () => {
      for (const k of [consoleKeys.people, consoleKeys.health, consoleKeys.quality, ["propreports"]]) qc.invalidateQueries({ queryKey: k });
    },
  });
}

/** Default «from» for the audit filter: 30 NY days back. */
export function defaultAuditFrom(): string {
  return addDays(nyDate(), -30);
}
