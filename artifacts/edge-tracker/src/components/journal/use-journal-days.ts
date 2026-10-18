import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { http, ApiError } from "@/lib/api/http";
import { nullIfMissing } from "@/lib/api/errors";
import { journalI18n } from "@/i18n/ns/journal";

/**
 * Day journal storage. Uses the server (/api/journal/days) when the route is available,
 * otherwise falls back to this browser's localStorage so the page keeps working.
 */

export type JournalEntry = {
  trader: string;
  date: string;
  plan: string;
  well: string;
  mistakes: string;
  lessons: string;
  mood: number | null;
  discipline: number | null;
  followedPlan: boolean | null;
  tags: string[];
  updatedAt?: string | null;
  /** Written to this browser while the server was unreachable; waiting to be pushed. */
  pendingSync?: boolean;
};

export type StorageMode = "server" | "local";

export function emptyEntry(trader: string, date: string): JournalEntry {
  return { trader, date, plan: "", well: "", mistakes: "", lessons: "", mood: null, discipline: null, followedPlan: null, tags: [], updatedAt: null };
}

export function isEntryEmpty(e: JournalEntry | null | undefined): boolean {
  if (!e) return true;
  return !e.plan.trim() && !e.well.trim() && !e.mistakes.trim() && !e.lessons.trim()
    && e.mood == null && e.discipline == null && e.followedPlan == null && e.tags.length === 0;
}

/** Has the post-market part (review) been filled. */
export function hasReview(e: JournalEntry | null | undefined): boolean {
  if (!e) return false;
  return !!(e.well.trim() || e.mistakes.trim() || e.lessons.trim() || e.mood != null || e.discipline != null);
}

// ── localStorage ─────────────────────────────────────────────────────────────

const LOCAL_PREFIX = "journal-day:v2:";
const LEGACY_PREFIX = "journal-day-notes:";

function localKey(trader: string, date: string) {
  return `${LOCAL_PREFIX}${trader}:${date}`;
}

function normalize(raw: Partial<JournalEntry> & { trader: string; date: string }): JournalEntry {
  const base = emptyEntry(raw.trader, raw.date);
  return {
    ...base,
    plan: typeof raw.plan === "string" ? raw.plan : "",
    well: typeof raw.well === "string" ? raw.well : "",
    mistakes: typeof raw.mistakes === "string" ? raw.mistakes : "",
    lessons: typeof raw.lessons === "string" ? raw.lessons : "",
    mood: typeof raw.mood === "number" ? raw.mood : null,
    discipline: typeof raw.discipline === "number" ? raw.discipline : null,
    followedPlan: typeof raw.followedPlan === "boolean" ? raw.followedPlan : null,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string") : [],
    updatedAt: raw.updatedAt ?? null,
    pendingSync: raw.pendingSync === true,
  };
}

function readLocalRange(trader: string, from: string, to: string): JournalEntry[] {
  const out: JournalEntry[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(LOCAL_PREFIX)) continue;
      const rest = k.slice(LOCAL_PREFIX.length);
      const idx = rest.lastIndexOf(":");
      const t = rest.slice(0, idx);
      const d = rest.slice(idx + 1);
      if (trader && t !== trader) continue;
      if (d < from || d > to) continue;
      try {
        const parsed = JSON.parse(localStorage.getItem(k) ?? "null");
        if (parsed && typeof parsed === "object") out.push(normalize({ ...parsed, trader: t, date: d }));
      } catch { /* skip corrupt */ }
    }
  } catch { /* storage unavailable */ }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

function writeLocal(e: JournalEntry) {
  const k = localKey(e.trader, e.date);
  if (isEntryEmpty(e)) localStorage.removeItem(k);
  else localStorage.setItem(k, JSON.stringify({ ...e, updatedAt: new Date().toISOString(), pendingSync: true }));
}

/** Entries saved to this browser while the server was unavailable (any date). */
export function readPendingLocal(trader: string): JournalEntry[] {
  return readLocalRange(trader, "0000-01-01", "9999-12-31").filter((e) => e.pendingSync);
}

/** Free-text note written by the previous version of this page (one textarea per day). */
export function readLegacyNote(account: string, date: string): string {
  try {
    return localStorage.getItem(`${LEGACY_PREFIX}${account || "all"}:${date}`) ?? "";
  } catch {
    return "";
  }
}

// ── Server ───────────────────────────────────────────────────────────────────

// A failed probe only pauses server access for a minute — it is re-tried on the next query, so an entry
// typed while the API was being rebuilt is not stuck in local mode for the whole session.
let serverDownUntil = 0;
const RETRY_MS = 60_000;
const serverDown = () => Date.now() < serverDownUntil;
const markServerDown = () => { serverDownUntil = Date.now() + RETRY_MS; };
const markServerUp = () => { serverDownUntil = 0; };

class NotAvailable extends Error {}

/** 409 from PUT: somebody (another tab) saved a newer version; `current` is the server's row. */
export class JournalConflict extends Error {
  current: JournalEntry | null;
  constructor(message: string, current: JournalEntry | null) {
    super(message);
    this.current = current;
  }
}

async function fetchServer(trader: string, from: string, to: string): Promise<JournalEntry[]> {
  // 404 or the SPA's HTML fallback → this API build has no journal route.
  const rows = await http
    .get<Array<Partial<JournalEntry> & { trader: string; date: string }>>("/api/journal/days", { query: { from, to, trader } })
    .catch(nullIfMissing);
  if (rows === null) throw new NotAvailable();
  return rows.map(normalize);
}

export const JOURNAL_DAYS_KEY = "journal-days";

export function useJournalRange(trader: string, from: string, to: string, enabled = true) {
  const q = useQuery({
    queryKey: [JOURNAL_DAYS_KEY, trader, from, to],
    enabled,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    queryFn: async (): Promise<{ entries: JournalEntry[]; mode: StorageMode }> => {
      if (!serverDown()) {
        try {
          const entries = await fetchServer(trader, from, to);
          markServerUp();
          // Entries typed while offline overlay the server copy until they are pushed (see useSyncLocalJournal).
          const pending = trader ? readPendingLocal(trader).filter((e) => e.date >= from && e.date <= to) : [];
          if (pending.length) {
            const keep = entries.filter((e) => !pending.some((p) => p.trader === e.trader && p.date === e.date));
            return { entries: [...keep, ...pending].sort((a, b) => (a.date < b.date ? -1 : 1)), mode: "server" };
          }
          return { entries, mode: "server" };
        } catch (err) {
          if (!(err instanceof NotAvailable)) throw err;
          markServerDown();
        }
      }
      return { entries: readLocalRange(trader, from, to), mode: "local" };
    },
  });
  return {
    entries: q.data?.entries ?? [],
    mode: (q.data?.mode ?? (serverDown() ? "local" : "server")) as StorageMode,
    isLoading: q.isLoading,
    isError: q.isError,
    error: q.error,
    refetch: q.refetch,
  };
}

async function putServer(e: JournalEntry): Promise<{ entry: JournalEntry; mode: StorageMode } | null> {
  let row: (Partial<JournalEntry> & { trader: string; date: string; deleted?: boolean }) | null;
  try {
    row = await http
      .put<Partial<JournalEntry> & { trader: string; date: string; deleted?: boolean }>(`/api/journal/days/${e.date}`, {
        plan: e.plan, well: e.well, mistakes: e.mistakes, lessons: e.lessons,
        mood: e.mood, discipline: e.discipline, followedPlan: e.followedPlan, tags: e.tags,
        // Version we edited: the server refuses (409) if another tab saved a newer one.
        updatedAt: e.pendingSync ? undefined : e.updatedAt ?? undefined,
      })
      // 404 or the SPA's HTML fallback → this API build has no journal route.
      .catch(nullIfMissing);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409 && err.body && typeof err.body === "object") {
      const current = err.field<Partial<JournalEntry> & { trader: string; date: string }>("current");
      throw new JournalConflict(err.field<string>("error") ?? journalI18n.t("editor.conflictTitle"), current ? normalize(current) : null);
    }
    throw err;
  }
  if (row === null) {
    markServerDown();
    return null;
  }
  markServerUp();
  try { localStorage.removeItem(localKey(e.trader, e.date)); } catch { /* ignore */ }
  return { entry: row.deleted ? { ...emptyEntry(e.trader, e.date) } : normalize(row), mode: "server" };
}

/** Entries saved locally while the server was down: how many wait, and a flush that pushes them. */
export function useSyncLocalJournal(trader: string) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: [JOURNAL_DAYS_KEY, "pending", trader],
    enabled: !!trader,
    staleTime: 5_000,
    queryFn: async () => readPendingLocal(trader),
  });
  const flush = useMutation({
    mutationFn: async (): Promise<{ pushed: number; failed: number }> => {
      let pushed = 0, failed = 0;
      for (const e of readPendingLocal(trader)) {
        try {
          const r = await putServer({ ...e, pendingSync: true });
          if (r) pushed++; else failed++;
        } catch {
          failed++;
        }
      }
      return { pushed, failed };
    },
    onSettled: () => qc.invalidateQueries({ queryKey: [JOURNAL_DAYS_KEY] }),
  });
  return { pending: q.data ?? [], flush };
}

export function useSaveJournalDay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (e: JournalEntry): Promise<{ entry: JournalEntry; mode: StorageMode }> => {
      if (!serverDown()) {
        const r = await putServer(e);
        if (r) return r;
      }
      writeLocal(e);
      return { entry: { ...e, updatedAt: new Date().toISOString() }, mode: "local" };
    },
    onSuccess: ({ entry, mode }) => {
      // Patch every cached range that contains this date, without refetching (keeps the editor stable).
      type Cached = { entries: JournalEntry[]; mode: StorageMode };
      for (const [key, old] of qc.getQueriesData<Cached>({ queryKey: [JOURNAL_DAYS_KEY] })) {
        if (!old) continue;
        const [, trader, from, to] = key as [string, string, string, string];
        if ((trader && trader !== entry.trader) || entry.date < from || entry.date > to) continue;
        const others = old.entries.filter((x) => !(x.trader === entry.trader && x.date === entry.date));
        qc.setQueryData<Cached>(key, {
          mode,
          entries: isEntryEmpty(entry) ? others : [...others, entry].sort((a, b) => (a.date < b.date ? -1 : 1)),
        });
      }
    },
  });
}
