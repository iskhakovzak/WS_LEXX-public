/**
 * Candle archive — permanent, compact intraday bars per (symbol, New York day), shared by the whole desk.
 *
 *   readArchivedDays(symbol, days)    archive only (no provider call) — decoded, finest timeframe per day
 *   ensureArchivedDay(symbol, day)    archive first; a finished day that is not archived yet is fetched ONCE (single
 *                                     flight: concurrent callers for the same symbol-day share one fetch) and stored
 *   runArchiveFill(opts)              the candles.archive job: every symbol-day with trades / playbook examples /
 *                                     ideas / simulator games that is finished and not archived — newest first,
 *                                     paced, with a per-run call budget and backoff; idempotent and resumable
 *
 * Source ladder for one day, finest bars first: candles_cache (extended) → provider at that size (if it still serves
 * it for a day that old) → next size … → regular-hours-only cache rows. A provider ERROR stops the ladder (the day is
 * retried later rather than archived coarser than it could be); «no bars» (holiday) is recorded as a miss.
 *
 * Every dependency (store, cache, provider, clock) is injectable so tests can count provider calls.
 */
import { CODEC_VERSION, encodeBars, type Bar } from "./codec";
import {
  ARCHIVE_TFS, TF_SEC, distinctTargets, dayStats, isDayComplete, providerServes, symbolDayKey,
  type ArchiveTf, type SymbolDay,
} from "./days";
import * as realStore from "./store";
import { etWallToUtcSeconds, parseDateStrict } from "../candleDay";
import { fetchPrevCloses, fetchProviderDay, type ProviderDay } from "./provider";
import type { ArchivedDay, NewArchiveRow } from "./store";

export type ArchiveDeps = {
  now: () => Date;
  getArchivedDays: (symbol: string, days: readonly string[]) => Promise<Map<string, ArchivedDay>>;
  archivedKeys: (targets: readonly SymbolDay[]) => Promise<Set<string>>;
  blockedMissKeys: (targets: readonly SymbolDay[], now: Date) => Promise<Set<string>>;
  save: (row: NewArchiveRow) => Promise<boolean>;
  recordMiss: (symbol: string, day: string, reason: "empty" | "too_old", retryAfter: Date | null) => Promise<void>;
  readCacheDay: (symbol: string, day: string, tf: ArchiveTf, extended: boolean) => Promise<{ bars: Bar[]; fetchedAt: Date } | null>;
  fetchDay: (symbol: string, day: string, tf: ArchiveTf) => Promise<ProviderDay>;
  fetchPrevCloses: (symbol: string, days: readonly string[]) => Promise<Map<string, number>>;
  collectTargetRows: () => Promise<{ symbol: string; day: string }[]>;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
};

const abortableSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted || ms <= 0) { resolve(); return; }
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal?.removeEventListener("abort", done); resolve(); }
  signal?.addEventListener("abort", done, { once: true });
});

export const defaultDeps: ArchiveDeps = {
  now: () => new Date(),
  getArchivedDays: realStore.getArchivedDays,
  archivedKeys: realStore.archivedKeys,
  blockedMissKeys: realStore.blockedMissKeys,
  save: realStore.saveArchivedDay,
  recordMiss: realStore.recordMiss,
  readCacheDay: realStore.readCacheDay,
  fetchDay: fetchProviderDay,
  fetchPrevCloses,
  collectTargetRows: realStore.collectTargetRows,
  sleep: abortableSleep,
};

// ── decoded-day memory (hot charts / batch trade-quality reads) ──────────────
const MEMO_MAX = 300;
const memo = new Map<string, ArchivedDay>();
function memoGet(k: string): ArchivedDay | undefined {
  const v = memo.get(k);
  if (v) { memo.delete(k); memo.set(k, v); }
  return v;
}
function memoSet(k: string, v: ArchivedDay): void {
  memo.set(k, v);
  if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value as string);
}
/** Tests. */
export function resetArchiveMemory(): void { memo.clear(); inflight.clear(); }

/** Archived days of one symbol (no provider call). */
export async function readArchivedDays(symbol: string, days: readonly string[], deps: ArchiveDeps = defaultDeps): Promise<Map<string, ArchivedDay>> {
  const out = new Map<string, ArchivedDay>();
  const missing: string[] = [];
  for (const d of days) {
    const hit = memoGet(`${symbol}|${d}`);
    if (hit) out.set(d, hit); else missing.push(d);
  }
  if (missing.length) {
    const got = await deps.getArchivedDays(symbol, missing);
    for (const [d, v] of got) { out.set(d, v); memoSet(`${symbol}|${d}`, v); }
  }
  return out;
}

export type ArchiveOutcome = {
  status: "archived" | "exists" | "empty" | "too_old" | "incomplete" | "error";
  tf?: ArchiveTf;
  source?: "cache" | "yahoo";
  bytes?: number;
  /** Provider calls this attempt made (bars + previous close). */
  calls: number;
  error?: string;
};

async function buildAndSave(sd: SymbolDay, tf: ArchiveTf, extended: boolean, bars: Bar[], source: "cache" | "yahoo", fetchedAt: Date, prevClose: number | null, deps: ArchiveDeps): Promise<number> {
  const payload = encodeBars(bars, TF_SEC[tf]);
  await deps.save({
    symbol: sd.symbol, day: sd.day, tf, enc: CODEC_VERSION, extended, barCount: bars.length, payload, source, fetchedAt,
    stats: dayStats(bars, sd.day), prevClose,
  });
  memo.delete(symbolDayKey(sd));
  return payload.length;
}

/**
 * Archive one finished day (no check whether it already is — callers do that). `prevClose` lookup: pass a resolver
 * (the job batches one daily call per symbol); otherwise one call is made after the bars are in.
 */
export async function archiveDay(sd: SymbolDay, deps: ArchiveDeps = defaultDeps, prevCloseOf?: (day: string) => Promise<number | null>): Promise<ArchiveOutcome> {
  const now = deps.now();
  if (!isDayComplete(sd.day, now)) return { status: "incomplete", calls: 0 };
  let calls = 0;
  const pdc = async (): Promise<number | null> => {
    if (prevCloseOf) return prevCloseOf(sd.day);
    calls++;
    return (await deps.fetchPrevCloses(sd.symbol, [sd.day]).catch(() => new Map<string, number>())).get(sd.day) ?? null;
  };
  let sawEmpty = false;
  // A cache row fetched before 20:00 ET of its day misses the tail of the session: take it only when the provider
  // can no longer serve that bar size (then it is the best there will ever be).
  const ymd = parseDateStrict(sd.day);
  const dayEndMs = ymd ? etWallToUtcSeconds(ymd, 20, 0) * 1000 : 0;
  for (const tf of ARCHIVE_TFS) {
    const serves = providerServes(tf, sd.day, now.getTime());
    let cached = await deps.readCacheDay(sd.symbol, sd.day, tf, true);
    if (cached && serves && cached.fetchedAt.getTime() < dayEndMs) cached = null;
    if (cached) {
      const bytes = await buildAndSave(sd, tf, true, cached.bars, "cache", cached.fetchedAt, await pdc(), deps);
      return { status: "archived", tf, source: "cache", bytes, calls };
    }
    if (!serves) continue;
    calls++;
    const r = await deps.fetchDay(sd.symbol, sd.day, tf);
    if (r.kind === "ok") {
      const bytes = await buildAndSave(sd, tf, true, r.bars, "yahoo", deps.now(), await pdc(), deps);
      return { status: "archived", tf, source: "yahoo", bytes, calls };
    }
    if (r.kind === "error") return { status: "error", calls, error: r.message };
    if (r.kind === "empty") { sawEmpty = true; break; } // a holiday is empty at every size
  }
  // Nothing extended: a regular-hours-only cache row is still better than nothing.
  if (!sawEmpty) {
    for (const tf of ARCHIVE_TFS) {
      const cached = await deps.readCacheDay(sd.symbol, sd.day, tf, false);
      if (cached) {
        const bytes = await buildAndSave(sd, tf, false, cached.bars, "cache", cached.fetchedAt, await pdc(), deps);
        return { status: "archived", tf, source: "cache", bytes, calls };
      }
    }
  }
  if (sawEmpty) {
    await deps.recordMiss(sd.symbol, sd.day, "empty", new Date(now.getTime() + 86_400_000));
    return { status: "empty", calls };
  }
  await deps.recordMiss(sd.symbol, sd.day, "too_old", null);
  return { status: "too_old", calls };
}

// ── on demand (charts) ───────────────────────────────────────────────────────
const inflight = new Map<string, Promise<ArchiveOutcome>>();

/** One archive attempt per symbol-day at a time in this process; everyone asking meanwhile awaits the same promise. */
export function archiveDayOnce(sd: SymbolDay, deps: ArchiveDeps = defaultDeps, prevCloseOf?: (day: string) => Promise<number | null>): Promise<ArchiveOutcome> {
  const k = symbolDayKey(sd);
  const running = inflight.get(k);
  if (running) return running;
  const p = archiveDay(sd, deps, prevCloseOf)
    .catch((err): ArchiveOutcome => ({ status: "error", calls: 0, error: err instanceof Error ? err.message : String(err) }))
    .finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}

/**
 * Archive first: the archived day, or — for a finished day not archived yet — fetch it once, store it and return it.
 * Null when the day is not finished, the provider has nothing, or it failed (callers fall back to the live path).
 */
export async function ensureArchivedDay(
  symbol: string, day: string, deps: ArchiveDeps = defaultDeps, prevCloseOf?: (day: string) => Promise<number | null>,
): Promise<ArchivedDay | null> {
  const have = await readArchivedDays(symbol, [day], deps);
  const hit = have.get(day);
  if (hit) return hit;
  if (!isDayComplete(day, deps.now())) return null;
  const blocked = await deps.blockedMissKeys([{ symbol, day }], deps.now());
  if (blocked.size) return null;
  const r = await archiveDayOnce({ symbol, day }, deps, prevCloseOf);
  if (r.status !== "archived") return null;
  return (await readArchivedDays(symbol, [day], deps)).get(day) ?? null;
}

// ── the job ──────────────────────────────────────────────────────────────────
export type FillOptions = {
  signal?: AbortSignal;
  /** Max provider calls this run (bars + previous closes). */
  budget?: number;
  /** Pause between provider calls, ms. */
  gapMs?: number;
  /** Limit to these symbol-days (e.g. a sync's new trades); default: everything the desk needs. */
  only?: SymbolDay[];
  logger?: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };
};

export type FillReport = {
  targets: number;
  finished: number;
  alreadyArchived: number;
  skippedMisses: number;
  archived: number;
  fromCache: number;
  fromProvider: number;
  byTf: Partial<Record<ArchiveTf, number>>;
  empty: number;
  tooOld: number;
  errors: number;
  providerCalls: number;
  bytes: number;
  remaining: number;
  stoppedBy: "done" | "budget" | "errors" | "aborted";
};

export async function runArchiveFill(opts: FillOptions = {}, deps: ArchiveDeps = defaultDeps): Promise<FillReport> {
  const budget = opts.budget ?? 400;
  const gapMs = opts.gapMs ?? 400;
  const now = deps.now();
  // 1. The distinct set first: ten traders on the same ticker that day are ONE symbol-day.
  const targets = distinctTargets(opts.only ?? (await deps.collectTargetRows()));
  const finished = targets.filter((t) => isDayComplete(t.day, now));
  const archived = await deps.archivedKeys(finished);
  const blocked = await deps.blockedMissKeys(finished.filter((t) => !archived.has(symbolDayKey(t))), now);
  const todo = finished.filter((t) => !archived.has(symbolDayKey(t)) && !blocked.has(symbolDayKey(t)));

  const rep: FillReport = {
    targets: targets.length, finished: finished.length, alreadyArchived: archived.size, skippedMisses: blocked.size,
    archived: 0, fromCache: 0, fromProvider: 0, byTf: {}, empty: 0, tooOld: 0, errors: 0, providerCalls: 0, bytes: 0,
    remaining: todo.length, stoppedBy: "done",
  };
  if (!todo.length) return rep;

  // Previous closes: one daily-bars call per symbol for all of its pending days (lazily, only if a day gets bars).
  const daysBySymbol = new Map<string, string[]>();
  for (const t of todo) daysBySymbol.set(t.symbol, [...(daysBySymbol.get(t.symbol) ?? []), t.day]);
  const pdcBySymbol = new Map<string, Promise<Map<string, number>>>();
  const prevCloseFor = (symbol: string) => async (day: string): Promise<number | null> => {
    let p = pdcBySymbol.get(symbol);
    if (!p) {
      rep.providerCalls++;
      p = deps.fetchPrevCloses(symbol, daysBySymbol.get(symbol) ?? [day]).catch(() => new Map<string, number>());
      pdcBySymbol.set(symbol, p);
    }
    return (await p).get(day) ?? null;
  };

  let consecutiveErrors = 0;
  for (const t of todo) {
    if (opts.signal?.aborted) { rep.stoppedBy = "aborted"; break; }
    if (rep.providerCalls >= budget) { rep.stoppedBy = "budget"; break; }
    const before = rep.providerCalls;
    const r = await archiveDayOnce(t, deps, prevCloseFor(t.symbol));
    rep.providerCalls += r.calls;
    rep.remaining--;
    if (r.status === "archived") {
      consecutiveErrors = 0;
      rep.archived++;
      rep.bytes += r.bytes ?? 0;
      if (r.source === "cache") rep.fromCache++; else rep.fromProvider++;
      if (r.tf) rep.byTf[r.tf] = (rep.byTf[r.tf] ?? 0) + 1;
    } else if (r.status === "empty") { consecutiveErrors = 0; rep.empty++; }
    else if (r.status === "too_old") rep.tooOld++;
    else if (r.status === "error") {
      rep.errors++;
      consecutiveErrors++;
      opts.logger?.warn({ symbol: t.symbol, day: t.day, err: r.error }, "candles.archive: provider error");
      if (consecutiveErrors >= 5) { rep.stoppedBy = "errors"; break; }
      await deps.sleep(Math.min(60_000, 2_000 * 2 ** (consecutiveErrors - 1)), opts.signal); // backoff 2 s, 4 s, 8 s, 16 s
      continue;
    }
    if (rep.providerCalls > before) await deps.sleep(gapMs, opts.signal);
  }
  if (rep.stoppedBy !== "done") opts.logger?.info({ ...rep }, "candles.archive: run stopped early — the next run resumes");
  return rep;
}
