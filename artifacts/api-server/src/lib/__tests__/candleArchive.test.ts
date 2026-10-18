import { beforeEach, describe, expect, it } from "vitest";
import { archiveDayOnce, ensureArchivedDay, resetArchiveMemory, runArchiveFill, type ArchiveDeps } from "../candleArchive/service";
import { decodeBars, type Bar } from "../candleArchive/codec";
import { aggregateBars, bestProviderTf, distinctTargets, isDayComplete, providerServes, regularOnly, symbolDayKey, type ArchiveTf } from "../candleArchive/days";
import type { ArchivedDay, NewArchiveRow } from "../candleArchive/store";
import type { ProviderDay } from "../candleArchive/provider";

// "Now" = Saturday 2026-10-17 12:00 NY (16:00Z): Friday 10-16 is complete, 1-minute bars reach back to ~09-17.
const NOW = new Date("2026-10-17T16:00:00Z");
const DAY = "2026-10-15";

function dayBars(day: string, n = 960, start = 4 * 60): Bar[] {
  // 04:00 ET in EDT = 08:00Z
  const t0 = Date.parse(`${day}T08:00:00Z`) / 1000 + (start - 240) * 60;
  return Array.from({ length: n }, (_, i) => ({ t: t0 + i * 60, o: 100 + i * 0.01, h: 100.05 + i * 0.01, l: 99.95 + i * 0.01, c: 100.02 + i * 0.01, v: 1000 + i }));
}

/** In-memory archive + counting provider. */
function fakeDeps(over: Partial<ArchiveDeps> = {}, provider?: (symbol: string, day: string, tf: ArchiveTf) => ProviderDay) {
  const rows = new Map<string, NewArchiveRow>();
  const misses = new Map<string, { reason: string; retryAfter: Date | null }>();
  const calls: string[] = [];
  const pdcCalls: string[] = [];
  let targetRows: { symbol: string; day: string }[] = [];
  const deps: ArchiveDeps = {
    now: () => NOW,
    getArchivedDays: async (symbol, days) => {
      const m = new Map<string, ArchivedDay>();
      for (const d of days) {
        const r = rows.get(`${symbol}|${d}`);
        if (r) m.set(d, { symbol, day: d, tf: r.tf, extended: r.extended, bars: decodeBars(r.payload).bars, source: r.source, fetchedAt: r.fetchedAt.toISOString(), prevClose: r.prevClose, etag: "x" });
      }
      return m;
    },
    archivedKeys: async (ts) => new Set(ts.map(symbolDayKey).filter((k) => rows.has(k))),
    blockedMissKeys: async (ts, now) => new Set(ts.map(symbolDayKey).filter((k) => { const m = misses.get(k); return !!m && (m.retryAfter == null || m.retryAfter > now); })),
    save: async (r) => { const k = `${r.symbol}|${r.day}`; if (rows.has(k)) return false; rows.set(k, r); return true; },
    recordMiss: async (s, d, reason, retryAfter) => { misses.set(`${s}|${d}`, { reason, retryAfter }); },
    readCacheDay: async () => null,
    fetchDay: async (symbol, day, tf) => {
      calls.push(`${symbol}|${day}|${tf}`);
      await new Promise((r) => setTimeout(r, 5)); // a real fetch takes time: lets concurrent callers pile up
      return provider ? provider(symbol, day, tf) : { kind: "ok", bars: dayBars(day) };
    },
    fetchPrevCloses: async (symbol, days) => { pdcCalls.push(`${symbol}:${days.length}`); return new Map(days.map((d) => [d, 99.5])); },
    collectTargetRows: async () => targetRows,
    sleep: async () => undefined,
    ...over,
  };
  return { deps, rows, misses, calls, pdcCalls, setTargets: (t: typeof targetRows) => { targetRows = t; } };
}

beforeEach(() => resetArchiveMemory());

describe("candle archive — one fetch per symbol-day for the whole desk", () => {
  it("10 traders on the same ticker and day → exactly 1 provider fetch and 1 stored row", async () => {
    const f = fakeDeps();
    // what collectTargetRows returns for 10 traders' trades + a playbook example + an idea on the same symbol-day
    f.setTargets([...Array.from({ length: 10 }, (_, i) => ({ symbol: i % 2 ? "aapl" : "AAPL", day: `${DAY}${i % 3 ? "" : "T13:45:00Z"}` })), { symbol: "AAPL ", day: DAY }]);
    const rep = await runArchiveFill({}, f.deps);
    expect(f.calls).toEqual([`AAPL|${DAY}|1m`]);
    expect(f.rows.size).toBe(1);
    expect(rep).toMatchObject({ targets: 1, archived: 1, fromProvider: 1, byTf: { "1m": 1 } });
    // bars + one previous-close call per symbol
    expect(rep.providerCalls).toBe(2);
  });

  it("a second sync makes 0 provider calls for days already archived", async () => {
    const f = fakeDeps();
    f.setTargets([{ symbol: "AAPL", day: DAY }, { symbol: "TSLA", day: DAY }, { symbol: "AAPL", day: "2026-10-14" }]);
    const first = await runArchiveFill({}, f.deps);
    expect(first.archived).toBe(3);
    const callsAfterFirst = f.calls.length + f.pdcCalls.length;
    const second = await runArchiveFill({}, f.deps);
    expect(f.calls.length + f.pdcCalls.length).toBe(callsAfterFirst);
    expect(second).toMatchObject({ providerCalls: 0, archived: 0, alreadyArchived: 3, remaining: 0 });
  });

  it("concurrent chart opens of the same finished day share one in-flight fetch", async () => {
    const f = fakeDeps();
    const got = await Promise.all(Array.from({ length: 10 }, () => ensureArchivedDay("NVDA", DAY, f.deps)));
    expect(f.calls).toEqual([`NVDA|${DAY}|1m`]);
    expect(got.every((d) => d && d.bars.length === 960 && d.tf === "1m")).toBe(true);
    // ... and once archived, opening it again (even after the process memory is gone) costs nothing
    resetArchiveMemory();
    expect((await ensureArchivedDay("NVDA", DAY, f.deps))?.bars.length).toBe(960);
    expect(f.calls.length).toBe(1);
  });

  it("the job and an on-demand open racing on the same day still fetch once", async () => {
    const f = fakeDeps();
    f.setTargets([{ symbol: "AMD", day: DAY }]);
    await Promise.all([runArchiveFill({}, f.deps), ensureArchivedDay("AMD", DAY, f.deps), archiveDayOnce({ symbol: "AMD", day: DAY }, f.deps)]);
    expect(f.calls).toEqual([`AMD|${DAY}|1m`]);
    expect(f.rows.size).toBe(1);
  });

  it("does not touch the live day before 20:05 NY, nor weekends", async () => {
    const live = new Date("2026-10-16T19:00:00Z"); // Fri 15:00 NY
    const f = fakeDeps({ now: () => live });
    f.setTargets([{ symbol: "AAPL", day: "2026-10-16" }, { symbol: "AAPL", day: "2026-10-17" }]);
    const rep = await runArchiveFill({}, f.deps);
    expect(rep).toMatchObject({ targets: 1, finished: 0, providerCalls: 0 });
    expect(await ensureArchivedDay("AAPL", "2026-10-16", f.deps)).toBeNull();
    expect(f.calls).toEqual([]);
  });
});

describe("candle archive — source ladder", () => {
  it("copies the cache's extended 1-minute day without any provider call for the bars", async () => {
    const f = fakeDeps({ readCacheDay: async (_s, day, tf, ext) => (tf === "1m" && ext ? { bars: dayBars(day), fetchedAt: new Date("2026-10-16T01:00:00Z") } : null) }); // 21:00 NY: after the session
    f.setTargets([{ symbol: "MRVL", day: DAY }]);
    const rep = await runArchiveFill({}, f.deps);
    expect(f.calls).toEqual([]);
    expect(rep).toMatchObject({ archived: 1, fromCache: 1 });
    expect(f.rows.get(`MRVL|${DAY}`)?.source).toBe("cache");
  });

  it("skips a cache row fetched before the day ended while the provider still has the full day", async () => {
    const early = new Date("2026-10-15T19:00:00Z"); // 15:00 NY: the cached day stops mid-session
    const f = fakeDeps({ readCacheDay: async (_s, day, tf, ext) => (tf === "1m" && ext ? { bars: dayBars(day, 600), fetchedAt: early } : null) });
    await archiveDayOnce({ symbol: "SHOP", day: DAY }, f.deps);
    expect(f.calls).toEqual([`SHOP|${DAY}|1m`]);
    expect(f.rows.get(`SHOP|${DAY}`)).toMatchObject({ source: "yahoo", barCount: 960 });
    // …but keeps it when the provider no longer serves 1-minute bars for that day (best there will ever be)
    const old = "2026-09-02";
    const g = fakeDeps({ readCacheDay: async (_s, day, tf, ext) => (tf === "1m" && ext ? { bars: dayBars(day, 600), fetchedAt: new Date("2026-09-02T19:00:00Z") } : null) });
    await archiveDayOnce({ symbol: "SHOP", day: old }, g.deps);
    expect(g.calls).toEqual([]);
    expect(g.rows.get(`SHOP|${old}`)).toMatchObject({ source: "cache", tf: "1m", barCount: 600 });
  });

  it("asks the provider for 1m before falling back to a coarser cached day", async () => {
    const f = fakeDeps({ readCacheDay: async (_s, day, tf, ext) => (tf === "5m" && ext ? { bars: aggregateBars(dayBars(day), 60, 300, day), fetchedAt: NOW } : null) });
    await archiveDayOnce({ symbol: "PLTR", day: DAY }, f.deps);
    expect(f.calls).toEqual([`PLTR|${DAY}|1m`]);
    expect(f.rows.get(`PLTR|${DAY}`)?.tf).toBe("1m");
  });

  it("a 45-day-old day goes straight to 5-minute bars (1m is past the provider's 30-day window)", async () => {
    const day = "2026-09-02";
    expect(providerServes("1m", day, NOW.getTime())).toBe(false);
    expect(bestProviderTf(day, NOW.getTime())).toBe("5m");
    const f = fakeDeps({}, (_s, d, tf) => ({ kind: "ok", bars: aggregateBars(dayBars(d), 60, 300, d) }));
    const r = await archiveDayOnce({ symbol: "AAPL", day }, f.deps);
    expect(r).toMatchObject({ status: "archived", tf: "5m" });
    expect(f.calls).toEqual([`AAPL|${day}|5m`]);
  });

  it("422 for one size moves down the ladder; a provider ERROR stops it (retry later, never archive coarser)", async () => {
    const f = fakeDeps({}, (_s, _d, tf) => (tf === "1m" ? { kind: "unavailable" } : { kind: "ok", bars: aggregateBars(dayBars(DAY), 60, 300, DAY) }));
    expect(await archiveDayOnce({ symbol: "X", day: DAY }, f.deps)).toMatchObject({ status: "archived", tf: "5m" });
    const g = fakeDeps({}, () => ({ kind: "error", status: 429, message: "HTTP 429" }));
    expect(await archiveDayOnce({ symbol: "Y", day: DAY }, g.deps)).toMatchObject({ status: "error" });
    expect(g.calls).toEqual([`Y|${DAY}|1m`]);
    expect(g.rows.size).toBe(0);
    expect(g.misses.size).toBe(0);
  });

  it("an empty day (holiday) is recorded as a miss and not asked again in the next run", async () => {
    const f = fakeDeps({}, () => ({ kind: "empty" }));
    f.setTargets([{ symbol: "AAPL", day: "2026-09-07" }]); // Labor Day
    const a = await runArchiveFill({}, f.deps);
    expect(a).toMatchObject({ empty: 1, archived: 0 });
    const b = await runArchiveFill({}, f.deps);
    expect(b).toMatchObject({ skippedMisses: 1, providerCalls: 0 });
    expect(f.calls.length).toBe(1);
  });

  it("stops at the call budget and resumes newest-first in the next run", async () => {
    const f = fakeDeps();
    const days = ["2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"];
    f.setTargets(days.map((day, i) => ({ symbol: `T${i}`, day })));
    const a = await runArchiveFill({ budget: 4 }, f.deps); // each new symbol: bars + prev close = 2 calls
    expect(a).toMatchObject({ archived: 2, stoppedBy: "budget", remaining: 3 });
    expect(f.calls.map((c) => c.split("|")[1])).toEqual(["2026-10-15", "2026-10-14"]);
    const b = await runArchiveFill({ budget: 100 }, f.deps);
    expect(b).toMatchObject({ archived: 3, alreadyArchived: 2, stoppedBy: "done" });
  });

  it("gives up after 5 consecutive provider errors with backoff", async () => {
    const sleeps: number[] = [];
    const f = fakeDeps({ sleep: async (ms) => { sleeps.push(ms); } }, () => ({ kind: "error", status: 503, message: "HTTP 503" }));
    f.setTargets(Array.from({ length: 8 }, (_, i) => ({ symbol: `E${i}`, day: DAY })));
    const rep = await runArchiveFill({}, f.deps);
    expect(rep).toMatchObject({ errors: 5, stoppedBy: "errors", archived: 0 });
    expect(sleeps).toEqual([2000, 4000, 8000, 16000]);
  });
});

describe("candle archive — pure rules", () => {
  it("distinctTargets normalises, drops weekends / bad shapes and sorts newest first", () => {
    expect(distinctTargets([
      { symbol: "aapl", day: "2026-10-14T10:00:00Z" }, { symbol: "AAPL", day: "2026-10-14" }, { symbol: "MSFT", day: "2026-10-15" },
      { symbol: "MSFT", day: "2026-10-17" }, { symbol: "bad ticker!", day: "2026-10-15" }, { symbol: "BRK.B", day: "2026-10-13" }, { symbol: null, day: "2026-10-13" },
    ])).toEqual([{ symbol: "MSFT", day: "2026-10-15" }, { symbol: "AAPL", day: "2026-10-14" }, { symbol: "BRK.B", day: "2026-10-13" }]);
  });

  it("isDayComplete: past days yes, today only after 20:05 NY", () => {
    expect(isDayComplete("2026-10-15", new Date("2026-10-16T13:00:00Z"))).toBe(true);
    expect(isDayComplete("2026-10-16", new Date("2026-10-16T23:59:00Z"))).toBe(false); // 19:59 NY
    expect(isDayComplete("2026-10-16", new Date("2026-10-17T00:06:00Z"))).toBe(true); // 20:06 NY
  });

  it("aggregates 1m to 5m / hourly on Yahoo's grid and filters the regular session", () => {
    const bars = dayBars(DAY);
    const five = aggregateBars(bars, 60, 300, DAY);
    expect(five.length).toBe(192);
    expect(five[0]).toMatchObject({ o: bars[0].o, c: bars[4].c, v: bars.slice(0, 5).reduce((s, b) => s + b.v, 0) });
    const hourly = aggregateBars(bars, 60, 3600, DAY);
    const openT = Date.parse(`${DAY}T13:30:00Z`) / 1000;
    expect(hourly.some((b) => b.t === openT)).toBe(true); // a 09:30 bar, like Yahoo's
    expect(hourly.find((b) => b.t === openT - 1800)?.t).toBe(openT - 1800); // 09:00–09:30 half bar
    const rth = regularOnly(bars, DAY);
    expect(rth.length).toBe(390);
    expect(rth[0].t).toBe(openT);
  });
});
