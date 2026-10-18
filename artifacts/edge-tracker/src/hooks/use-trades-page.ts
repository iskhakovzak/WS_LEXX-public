// Paginated trade book: GET /api/trades/page (server-side filters / sort / keyset pagination + summary of the
// whole filtered set). While the running API predates the endpoint (404) the hook degrades to the legacy
// full-list GET /api/trades and computes the same page shape client-side with the shared helpers.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { getListTradesQueryKey, listTrades, type Trade } from "@workspace/api-client-react";
import { ApiError, http } from "@/lib/api/http";
import { applyPreset, isUnreviewed, presetCounts, type Preset } from "@/components/trades/review-presets";
import {
  applyBaseFilters,
  applyOutcome,
  applyQualityFilters,
  computeStats,
  dayOf,
  effectiveR,
  holdSeconds,
  netPnl,
  tradeWall,
  wallHm,
  hasQualityFilters,
  horizonOf,
  isBrokerTrade,
  periodRange,
  resultKey,
  setupOf,
  sortTrades,
  type Outcome,
  type QualityMap,
  type SortConfig,
  type TradeFilters,
  type TradeStats,
} from "@/components/trades/trade-utils";

export const TRADES_PAGE_KEY = "/api/trades/page";

export type TradesPageSummary = {
  total: number;
  wins: number;
  losses: number;
  be: number;
  open: number;
  decided: number;
  winRate: number | null;
  gross: number | null;
  fees: number | null;
  net: number | null;
  pnlCount: number;
  totalR: number;
  rCount: number;
  avgR: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  expectancyR: number | null;
  posR: number;
  negR: number;
  profitFactor: number | null;
  firstDate: string | null;
  lastDate: string | null;
  /** Trades that carry broker fees (or come from PropReports) — drives the «Брутто/Комиссии» columns. */
  feeRows: number;
  streak: { kind: "win" | "loss" | null; len: number };
  curve: { i: number; r: number; label: string }[];
  // ── $-based review metrics (API ≥ wave I; absent on older builds — computed client-side then) ──
  avgWinNet?: number | null;
  avgLossNet?: number | null;
  posNet?: number;
  negNet?: number;
  /** PF in $ (Σnet⁺ / |Σnet⁻|), null without losses. */
  profitFactorNet?: number | null;
  maxNet?: number | null;
  minNet?: number | null;
  /** Closed trades without setup / tags / notes. */
  untagged?: number;
  avgHoldSec?: number | null;
  /** Distinct trading days in the set. */
  days?: number;
};

export type TradesPageFacets = {
  outcomes: Record<Outcome, number>;
  horizons: Record<string, number>;
  setups: { name: string; count: number }[];
  traders: string[];
  sectors: string[];
  /** Counts per review preset (API ≥ wave I). */
  presets?: Record<Preset, number> | null;
};

export type TradesPageResponse = {
  items: Trade[];
  page: { limit: number; offset: number | null; returned: number; hasMore: boolean; nextCursor: string | null; sort: string; dir: string };
  summary: TradesPageSummary;
  facets: TradesPageFacets;
  quality: { available: boolean; applied: boolean };
  /** Echo of the applied preset (API ≥ wave I); `undefined` on older builds that ignore `?preset=`. */
  preset?: Preset | null;
};

export type TradesPageMode = "server" | "local";


/** Query string for /api/trades/page from the UI filter model (shared with CSV export and the ticker history). */
export function buildTradesPageParams(filters: TradeFilters, sort: SortConfig, opts: { limit: number; offset?: number; cursor?: string | null; preset?: Preset | null }): URLSearchParams {
  const p = new URLSearchParams();
  const set = (k: string, v: string | number | null | undefined) => { if (v !== "" && v != null) p.set(k, String(v)); };
  const { from, to } = periodRange(filters);
  set("q", filters.q.trim());
  set("ticker", filters.ticker.trim().toUpperCase());
  set("from", from);
  set("to", to);
  if (filters.outcome !== "all") set("outcome", filters.outcome);
  set("side", filters.side);
  set("setup", filters.setup);
  set("playbookId", filters.playbookId);
  set("trader", filters.trader);
  set("sector", filters.sector);
  set("session", filters.session);
  set("eventType", filters.eventType);
  set("horizon", filters.horizon);
  set("source", filters.source);
  set("tag", filters.tag.trim());
  set("ids", filters.ids);
  set("exitEffMax", filters.exitEffMax);
  set("mfeRMin", filters.mfeRMin);
  set("leftMin", filters.leftMin);
  set("preset", opts.preset ?? "");
  set("sort", sort.col);
  set("dir", sort.dir);
  set("limit", opts.limit);
  if (opts.cursor) set("cursor", opts.cursor);
  else if (opts.offset) set("offset", opts.offset);
  return p;
}

export async function fetchTradesPage(params: URLSearchParams, signal?: AbortSignal): Promise<TradesPageResponse> {
  return http.get<TradesPageResponse>(`${TRADES_PAGE_KEY}?${params.toString()}`, { signal });
}

// ── Local fallback (legacy full-list API) ─────────────────────────────────────

function statsToSummary(stats: TradeStats, list: Trade[]): TradesPageSummary {
  let gross = 0, fees = 0, feeRows = 0, posR = 0, negR = 0;
  const dates: string[] = [];
  for (const t of list) {
    if (t.pnl != null) { gross += t.pnl; fees += Math.abs(t.fees ?? 0); }
    if (isBrokerTrade(t) || (t.fees != null && Number(t.fees) !== 0)) feeRows++;
    const r = effectiveR(t).value;
    if (r != null && resultKey(t.result) !== "open") { if (r > 0) posR += r; else if (r < 0) negR += -r; }
    dates.push(dayOf(t));
  }
  dates.sort();
  return {
    total: stats.count, wins: stats.wins, losses: stats.losses, be: stats.be, open: stats.open,
    decided: stats.wins + stats.losses, winRate: stats.winRate,
    gross: stats.pnlCount ? gross : null, fees: stats.pnlCount ? fees : null, net: stats.totalPnl, pnlCount: stats.pnlCount,
    totalR: stats.totalR, rCount: stats.rCount, avgR: stats.avgR, avgWinR: stats.avgWinR, avgLossR: stats.avgLossR, expectancyR: stats.expectancyR,
    posR, negR, profitFactor: stats.profitFactor,
    firstDate: dates[0] ?? null, lastDate: dates[dates.length - 1] ?? null, feeRows,
    streak: stats.streak, curve: stats.curve,
    ...moneyStats(list),
  };
}

/** $-based review metrics over a list (same definitions as the server summary). */
export function moneyStats(list: Trade[]): Pick<TradesPageSummary, "avgWinNet" | "avgLossNet" | "posNet" | "negNet" | "profitFactorNet" | "maxNet" | "minNet" | "untagged" | "avgHoldSec" | "days"> {
  let winSum = 0, winN = 0, lossSum = 0, lossN = 0, posNet = 0, negNet = 0, holdSum = 0, holdN = 0, untagged = 0;
  let maxNet: number | null = null, minNet: number | null = null;
  const days = new Set<string>();
  for (const t of list) {
    days.add(dayOf(t));
    const n = t.pnl != null ? netPnl(t) : null;
    const res = resultKey(t.result);
    if (n != null) {
      if (res === "win") { winSum += n; winN++; }
      if (res === "loss") { lossSum += n; lossN++; }
      if (n > 0) posNet += n; else if (n < 0) negNet += -n;
      maxNet = maxNet == null ? n : Math.max(maxNet, n);
      minNet = minNet == null ? n : Math.min(minNet, n);
    }
    const h = holdSeconds(t);
    if (h != null) { holdSum += h; holdN++; }
    if (isUnreviewed(t)) untagged++;
  }
  return {
    avgWinNet: winN ? winSum / winN : null,
    avgLossNet: lossN ? lossSum / lossN : null,
    posNet, negNet,
    profitFactorNet: negNet > 0 ? posNet / negNet : null,
    maxNet, minNet, untagged,
    avgHoldSec: holdN ? holdSum / holdN : null,
    days: days.size,
  };
}

/** Same page shape computed client-side from the full list (used until the API is rebuilt with /trades/page). */
export function localTradesPage(all: Trade[], filters: TradeFilters, sort: SortConfig, page: number, pageSize: number, quality: QualityMap, preset?: Preset | null): TradesPageResponse {
  const base = applyBaseFilters(all, filters);
  const outcomed = applyOutcome(base, filters.outcome);
  const qualityFiltered = applyQualityFilters(outcomed, filters, quality);
  const filtered = sortTrades(preset ? applyPreset(qualityFiltered, preset) : qualityFiltered, sort, quality);
  const stats = computeStats(filtered);
  const start = (page - 1) * pageSize;
  const items = filtered.slice(start, start + pageSize);
  const outcomes: Record<Outcome, number> = { all: base.length, win: 0, loss: 0, breakeven: 0, open: 0 };
  for (const t of base) outcomes[resultKey(t.result)]++;
  const horizons: Record<string, number> = {};
  for (const t of applyBaseFilters(all, { ...filters, horizon: "" })) { const h = horizonOf(t); horizons[h] = (horizons[h] ?? 0) + 1; }
  const setupMap = new Map<string, number>();
  for (const t of all) { const s = setupOf(t); if (s) setupMap.set(s, (setupMap.get(s) ?? 0) + 1); }
  const setups = [...setupMap.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const traders = Array.from(new Set(all.map((t) => t.trader).filter(Boolean))).sort() as string[];
  const sectors = Array.from(new Set(all.map((t) => t.sector).filter(Boolean))).sort() as string[];
  return {
    items,
    page: { limit: pageSize, offset: start, returned: items.length, hasMore: start + pageSize < filtered.length, nextCursor: null, sort: sort.col, dir: sort.dir },
    summary: statsToSummary(stats, filtered),
    facets: { outcomes, horizons, setups, traders, sectors, presets: presetCounts(qualityFiltered) },
    quality: { available: Object.keys(quality).length > 0, applied: hasQualityFilters(filters) },
    preset: preset ?? null,
  };
}

async function fetchAllTradesLegacy(qc: QueryClient): Promise<Trade[]> {
  return qc.fetchQuery({ queryKey: getListTradesQueryKey(), queryFn: () => listTrades(), staleTime: 30_000 });
}

// ── API capabilities (wave I: /trades/days, ?preset=, sort=impact|hold, $ summary) ──

export type TradesApiCaps = { page: boolean; review: boolean };
let capsCache: TradesApiCaps | null = null;
let capsInflight: Promise<TradesApiCaps> | null = null;

/** One cheap probe per session: does the running API know the review endpoints? (404 ⇒ older build). */
export function getTradesCaps(): Promise<TradesApiCaps> {
  if (capsCache) return Promise.resolve(capsCache);
  if (!capsInflight) {
    capsInflight = (async () => {
      try {
        const r = await http.raw("/api/trades/days?limit=1", { throwOnError: false });
        if (r.ok) return (capsCache = { page: true, review: true });
        if (r.status === 404 || r.status === 400) {
          // Older build: /trades/days is missing; /trades/page may still exist.
          const pr = await http.raw(`${TRADES_PAGE_KEY}?limit=1`, { throwOnError: false });
          return (capsCache = { page: pr.status !== 404, review: false });
        }
        return { page: true, review: false }; // transient error: not cached, re-probed next time
      } catch {
        return { page: true, review: false };
      } finally {
        capsInflight = null;
      }
    })();
  }
  return capsInflight;
}

function withoutQualityFilters(f: TradeFilters): TradeFilters {
  return hasQualityFilters(f) ? { ...f, exitEffMax: "", mfeRMin: "", leftMin: "" } : f;
}

/** Sort columns only the wave-I API understands (an older build answers 400 on them). */
export const REVIEW_SORT_COLS: ReadonlySet<SortConfig["col"]> = new Set<SortConfig["col"]>(["impact", "hold"]);

/**
 * Every trade of the filter (no preset), cached for 30 s. Walks /trades/page by cursor (date desc, 500 per page,
 * cap 20 000) or, without that endpoint, filters the legacy full list. Used by the fallbacks (presets, day groups).
 */
export async function fetchAllFiltered(qc: QueryClient, filters: TradeFilters): Promise<Trade[]> {
  const caps = await getTradesCaps();
  const baseSort: SortConfig = { col: "date", dir: "desc" };
  const key = buildTradesPageParams(filters, baseSort, { limit: 500 }).toString();
  return qc.fetchQuery({
    queryKey: [TRADES_PAGE_KEY, "all", key],
    staleTime: 30_000,
    queryFn: async () => {
      if (!caps.page) {
        const all = await fetchAllTradesLegacy(qc);
        return localTradesPage(all, filters, baseSort, 1, 20_000, {}).items;
      }
      const out: Trade[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 40; i++) {
        const res: TradesPageResponse = await fetchTradesPage(buildTradesPageParams(filters, baseSort, { limit: 500, cursor }));
        out.push(...res.items);
        if (!res.page.hasMore || !res.page.nextCursor) break;
        cursor = res.page.nextCursor;
      }
      return out;
    },
  });
}

/** Summary block → the TradeStats shape the summary strip renders. */
export function summaryToStats(s: TradesPageSummary): TradeStats {
  return {
    count: s.total, open: s.open, wins: s.wins, losses: s.losses, be: s.be, winRate: s.winRate,
    avgR: s.avgR, avgWinR: s.avgWinR, avgLossR: s.avgLossR, expectancyR: s.expectancyR, profitFactor: s.profitFactor,
    rCount: s.rCount, totalR: s.totalR, totalPnl: s.net, pnlCount: s.pnlCount, streak: s.streak, curve: s.curve,
  };
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export type UseTradesPageInput = {
  filters: TradeFilters;
  sort: SortConfig;
  page: number;
  pageSize: number;
  /** Execution-quality map (only needed for the local fallback's quality filters / sort). */
  quality?: QualityMap;
  enabled?: boolean;
  /** Review preset (server `?preset=`; computed client-side on an older API). */
  preset?: Preset | null;
};

let serverMode: TradesPageMode | null = null;

export function useTradesPage(input: UseTradesPageInput) {
  const qc = useQueryClient();
  const { filters, sort, page, pageSize } = input;
  const preset = input.preset ?? null;
  const [mode, setMode] = useState<TradesPageMode>(serverMode ?? "server");
  const qualityRef = useRef<QualityMap>(input.quality ?? {});
  qualityRef.current = input.quality ?? {};

  // Keyset cursors learned while paging forward: scope → page number → cursor. Deep links / jumps use offset.
  const scopeKey = useMemo(() => buildTradesPageParams(filters, sort, { limit: pageSize, preset }).toString(), [filters, sort, pageSize, preset]);
  const cursorsRef = useRef<{ key: string; map: Map<number, string> }>({ key: scopeKey, map: new Map() });
  if (cursorsRef.current.key !== scopeKey) cursorsRef.current = { key: scopeKey, map: new Map() };

  // In local mode quality filters / sort depend on the quality map, so its size takes part in the key.
  const needsQuality = hasQualityFilters(filters) || sort.col === "exitEff" || sort.col === "mfeR" || sort.col === "left";
  const qualityStamp = mode === "local" && needsQuality ? Object.keys(input.quality ?? {}).length : 0;

  const query = useQuery<TradesPageResponse, ApiError>({
    queryKey: [TRADES_PAGE_KEY, scopeKey, page, qualityStamp],
    enabled: input.enabled !== false,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      // API older than wave I (no presets, review sorts or $ summary): page the full filtered list here,
      // so the KPIs, preset badges and sorts behave the same until the server is rebuilt.
      if (!(await getTradesCaps()).review) {
        const all = await fetchAllFiltered(qc, filters);
        // The server already applied every filter (quality ones included): don't re-filter by the partial local map.
        return localTradesPage(all, withoutQualityFilters(filters), sort, page, pageSize, qualityRef.current, preset);
      }
      if (serverMode !== "local") {
        const cursor = cursorsRef.current.map.get(page) ?? null;
        const params = buildTradesPageParams(filters, sort, { limit: pageSize, cursor, offset: cursor ? 0 : (page - 1) * pageSize, preset });
        try {
          const res = await fetchTradesPage(params, signal);
          if (res.page.nextCursor) cursorsRef.current.map.set(page + 1, res.page.nextCursor);
          serverMode = "server";
          return res;
        } catch (e) {
          // 404 ⇒ the running API has no /trades/page yet: fall back to the full list for this session.
          if (!(e instanceof ApiError) || e.status !== 404) throw e;
          serverMode = "local";
          setMode("local");
        }
      }
      const all = await fetchAllTradesLegacy(qc);
      return localTradesPage(all, filters, sort, page, pageSize, qualityRef.current, preset);
    },
  });

  useEffect(() => { if (serverMode && serverMode !== mode) setMode(serverMode); }, [query.data, mode]);

  const data = query.data;
  const total = data?.summary.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  /** Every trade of the current filter (CSV export): walks the server pages by cursor (cap 20 000 rows). */
  const fetchAll = useCallback(async (): Promise<Trade[]> => {
    if (serverMode === "local" || !(await getTradesCaps()).review) {
      if (serverMode === "local") return localTradesPage(await fetchAllTradesLegacy(qc), filters, sort, 1, 20_000, qualityRef.current, preset).items;
      return localTradesPage(await fetchAllFiltered(qc, filters), withoutQualityFilters(filters), sort, 1, 20_000, qualityRef.current, preset).items;
    }
    const out: Trade[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 40; i++) {
      const res: TradesPageResponse = await fetchTradesPage(buildTradesPageParams(filters, sort, { limit: 500, cursor, preset }));
      out.push(...res.items);
      if (!res.page.hasMore || !res.page.nextCursor) break;
      cursor = res.page.nextCursor;
    }
    return out;
  }, [qc, filters, sort, preset]);

  return {
    data,
    items: data?.items ?? [],
    summary: data?.summary ?? null,
    facets: data?.facets ?? null,
    hasMore: data?.page.hasMore ?? false,
    totalPages,
    mode,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isPlaceholder: query.isPlaceholderData,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
    fetchAll,
  };
}

/** Optimistic patch of a trade inside every cached page (and the legacy list), before the server answers. */
export function patchTradeInPages(qc: QueryClient, id: number, patch: Partial<Trade>): () => void {
  const pages = qc.getQueriesData<TradesPageResponse | Trade[]>({ queryKey: [TRADES_PAGE_KEY] });
  const legacyKey = getListTradesQueryKey();
  const legacy = qc.getQueryData<Trade[]>(legacyKey);
  // The key prefix also covers plain Trade[] caches (full filtered list, one day's trades).
  qc.setQueriesData<TradesPageResponse | Trade[]>({ queryKey: [TRADES_PAGE_KEY] }, (old) => {
    if (!old) return old;
    if (Array.isArray(old)) return old.map((x) => (x.id === id ? { ...x, ...patch } : x));
    return Array.isArray(old.items) ? { ...old, items: old.items.map((x) => (x.id === id ? { ...x, ...patch } : x)) } : old;
  });
  if (legacy) qc.setQueryData<Trade[]>(legacyKey, legacy.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  // Local day grouping keeps the trades per day in a Map.
  type DaysData = { listByDay: Map<string, Trade[]> | null };
  const dayCaches = qc.getQueriesData<DaysData>({ queryKey: [TRADES_DAYS_KEY] });
  qc.setQueriesData<DaysData>({ queryKey: [TRADES_DAYS_KEY] }, (old) => {
    if (!old?.listByDay) return old;
    const next = new Map<string, Trade[]>();
    for (const [d, arr] of old.listByDay) next.set(d, arr.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    return { ...old, listByDay: next };
  });
  return () => {
    for (const [key, val] of dayCaches) qc.setQueryData(key, val);
    for (const [key, val] of pages) qc.setQueryData(key, val);
    if (legacy) qc.setQueryData(legacyKey, legacy);
  };
}

// ── Day-grouped review list: GET /api/trades/days (local grouping on an older API) ──────────────────────────

export const TRADES_DAYS_KEY = "/api/trades/days";

export type TradeDay = {
  date: string;
  count: number;
  wins: number;
  losses: number;
  be: number;
  open: number;
  winRate: number | null;
  gross: number | null;
  fees: number | null;
  net: number | null;
  maxNet: number | null;
  minNet: number | null;
  rCount: number;
  totalR: number;
  /** Closed trades nobody has tagged yet. */
  untagged: number;
  /** «HH:MM» of the first entry / last exit (broker wall clock, ET). */
  firstAt: string | null;
  lastAt: string | null;
  /** Net of each trade in intraday order: folded into the day's curve. */
  seq: number[];
};

export type TradeDaysResponse = { days: TradeDay[]; hasMore: boolean; nextBefore: string | null; totalDays: number; preset?: Preset | null };

/** Intraday order: broker open time, then creation, then id. */
export function sortIntraday(list: Trade[]): Trade[] {
  const key = (t: Trade) => tradeWall(t).open ?? "￿";
  return [...list].sort((a, b) => {
    const ka = key(a), kb = key(b);
    if (ka !== kb) return ka < kb ? -1 : 1;
    const ca = String(a.createdAt ?? ""), cb = String(b.createdAt ?? "");
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a.id - b.id;
  });
}

/** Group a list into trading days (newest first) with the same aggregates as the server. */
export function groupTradeDays(list: Trade[]): { days: TradeDay[]; byDay: Map<string, Trade[]> } {
  const byDay = new Map<string, Trade[]>();
  for (const t of list) {
    const d = dayOf(t);
    const arr = byDay.get(d);
    if (arr) arr.push(t); else byDay.set(d, [t]);
  }
  const days: TradeDay[] = [];
  for (const [date, raw] of byDay) {
    const arr = sortIntraday(raw);
    byDay.set(date, arr);
    let wins = 0, losses = 0, be = 0, open = 0, pnlCount = 0, gross = 0, fees = 0, net = 0, rCount = 0, totalR = 0, untagged = 0;
    let maxNet: number | null = null, minNet: number | null = null;
    let first: string | null = null, last: string | null = null;
    const seq: number[] = [];
    for (const t of arr) {
      const res = resultKey(t.result);
      if (res === "win") wins++; else if (res === "loss") losses++; else if (res === "breakeven") be++; else open++;
      if (t.pnl != null) {
        pnlCount++;
        gross += t.pnl;
        fees += Math.abs(t.fees ?? 0);
        const n = netPnl(t) ?? 0;
        net += n;
        seq.push(Math.round(n * 100) / 100);
        maxNet = maxNet == null ? n : Math.max(maxNet, n);
        minNet = minNet == null ? n : Math.min(minNet, n);
      }
      const r = effectiveR(t).value;
      if (r != null && res !== "open") { rCount++; totalR += r; }
      if (isUnreviewed(t)) untagged++;
      const w = tradeWall(t);
      if (w.open && (!first || w.open < first)) first = w.open;
      if (w.close && (!last || w.close > last)) last = w.close;
    }
    days.push({
      date, count: arr.length, wins, losses, be, open,
      winRate: wins + losses ? wins / (wins + losses) : null,
      gross: pnlCount ? gross : null, fees: pnlCount ? fees : null, net: pnlCount ? net : null,
      maxNet, minNet, rCount, totalR, untagged,
      firstAt: wallHm(first), lastAt: wallHm(last), seq,
    });
  }
  days.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { days, byDay };
}

export async function fetchTradeDays(filters: TradeFilters, opts: { limit: number; before?: string | null; preset?: Preset | null }, signal?: AbortSignal): Promise<TradeDaysResponse> {
  const p = buildTradesPageParams(filters, { col: "date", dir: "desc" }, { limit: opts.limit, preset: opts.preset });
  p.delete("sort");
  p.delete("dir");
  if (opts.before) p.set("before", opts.before);
  return http.get<TradeDaysResponse>(`${TRADES_DAYS_KEY}?${p.toString()}`, { signal });
}

/**
 * Trading days of the filter, newest first, `limit` days per "page" (grows with loadMore).
 * New API: one request of pages×limit days. Older API: groups the full filtered list locally and also returns
 * the trades per day (`listByDay`) so expanding a day costs nothing.
 */
export function useTradeDays(filters: TradeFilters, opts: { limit?: number; enabled?: boolean } = {}) {
  const qc = useQueryClient();
  const limit = opts.limit ?? 30;
  const baseKey = useMemo(() => buildTradesPageParams(filters, { col: "date", dir: "desc" }, { limit: 1 }).toString(), [filters]);
  const [pages, setPages] = useState(1);
  const [pagesKey, setPagesKey] = useState(baseKey);
  if (pagesKey !== baseKey) { setPagesKey(baseKey); setPages(1); }

  const query = useQuery<{ days: TradeDay[]; hasMore: boolean; totalDays: number; listByDay: Map<string, Trade[]> | null }, ApiError>({
    queryKey: [TRADES_DAYS_KEY, baseKey, pages, limit],
    enabled: opts.enabled !== false,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const caps = await getTradesCaps();
      if (caps.review) {
        const res = await fetchTradeDays(filters, { limit: Math.min(1000, pages * limit) }, signal);
        return { days: res.days, hasMore: res.hasMore, totalDays: res.totalDays, listByDay: null };
      }
      const all = await fetchAllFiltered(qc, filters);
      const { days, byDay } = groupTradeDays(all);
      return { days: days.slice(0, pages * limit), hasMore: days.length > pages * limit, totalDays: days.length, listByDay: byDay };
    },
  });

  const loadMore = useCallback(() => setPages((n) => n + 1), []);
  return {
    days: query.data?.days ?? [],
    hasMore: query.data?.hasMore ?? false,
    totalDays: query.data?.totalDays ?? 0,
    listByDay: query.data?.listByDay ?? null,
    loadMore,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}

/** react-query options for all trades of one trading day under the filter, intraday order (cap 500). */
export function dayTradesQuery(filters: TradeFilters, date: string, enabled = true) {
  const dayFilters: TradeFilters = { ...filters, period: "custom", from: date, to: date };
  const params = buildTradesPageParams(dayFilters, { col: "date", dir: "desc" }, { limit: 500 });
  return {
    queryKey: [TRADES_PAGE_KEY, "day", params.toString()] as const,
    enabled,
    staleTime: 30_000,
    queryFn: async ({ signal }: { signal?: AbortSignal }) => sortIntraday((await fetchTradesPage(params, signal)).items),
  };
}
