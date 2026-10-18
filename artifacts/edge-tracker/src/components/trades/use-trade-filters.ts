import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import {
  DEFAULT_FILTERS,
  DEFAULT_PAGE_SIZE,
  HORIZONS,
  PAGE_SIZES,
  readLS,
  readLSArray,
  writeLS,
  type Horizon,
  type Outcome,
  type Period,
  type SortCol,
  type SortConfig,
  type TradeFilters,
} from "./trade-utils";
import { isPreset, PRESET_META, type Preset } from "./review-presets";

const FILTERS_KEY = "ws.trades.filters.v2";
const VIEWS_KEY = "ws.trades.views.v1";
const SORT_KEY = "ws.trades.sort.v1";
const SIZE_KEY = "ws.trades.pageSize.v1";

export type SavedView = { id: string; name: string; filters: TradeFilters };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SORT_COLS: readonly SortCol[] = ["date", "ticker", "side", "setup", "trader", "entry", "exit", "r", "result", "pnl", "gross", "fees", "exitEff", "mfeR", "left", "impact", "hold"];
const OUTCOMES: readonly Outcome[] = ["all", "win", "loss", "breakeven", "open"];
const PERIODS: readonly Period[] = ["all", "today", "week", "month", "custom"];

/** Query-string keys owned by the trades page (everything else — ?highlight, ?new, ?fromIdea — is left untouched). */
export const TRADES_URL_KEYS = [
  "q", "ticker", "date", "from", "to", "period", "outcome", "side", "setup", "playbookId", "trader", "sector", "tag", "session",
  "eventType", "horizon", "source", "exitEffMax", "mfeRMin", "leftMin", "ids", "sort", "dir", "page", "size", "preset", "view",
] as const;

/** Review layout: trading days (default) or a flat list. A preset always shows the flat list. */
export type TradesView = "days" | "list";

export type TradesUrlState = { filters: TradeFilters; sort: SortConfig; page: number; pageSize: number; preset?: Preset | null; view?: TradesView };

/**
 * Parse the trades deep-link / state params. `hasAny` is false when the URL carries none of them
 * (then the last filters from localStorage are used). Same vocabulary as `links.trades(...)`.
 */
export type ParsedTradesUrl = { filters: Partial<TradeFilters>; sort?: SortConfig; page?: number; pageSize?: number; preset?: Preset; view?: TradesView };
export function parseTradesUrl(search: string): { state: ParsedTradesUrl; hasAny: boolean } {
  const p = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const f: Partial<TradeFilters> = {};
  let hasAny = false;
  const get = (k: string) => { const v = p.get(k); if (v != null) hasAny = true; return v?.trim() ?? ""; };

  const q = get("q"); if (q) f.q = q;
  const ticker = get("ticker"); if (ticker) f.ticker = ticker.toUpperCase();
  const date = get("date");
  const from = get("from"), to = get("to");
  const period = get("period");
  if (date && DATE_RE.test(date)) { f.period = "custom"; f.from = date; f.to = date; }
  else if ((from && DATE_RE.test(from)) || (to && DATE_RE.test(to))) { f.period = "custom"; f.from = DATE_RE.test(from) ? from : ""; f.to = DATE_RE.test(to) ? to : ""; }
  else if (period && (PERIODS as readonly string[]).includes(period) && period !== "custom") f.period = period as Period;
  const outcome = get("outcome"); if ((OUTCOMES as readonly string[]).includes(outcome)) f.outcome = outcome as Outcome;
  const side = get("side"); if (side === "Long" || side === "Short") f.side = side;
  const setup = get("setup"); if (setup) f.setup = setup;
  const playbookId = get("playbookId"); if (/^\d+$/.test(playbookId)) f.playbookId = playbookId;
  const trader = get("trader"); if (trader) f.trader = trader;
  const sector = get("sector"); if (sector) f.sector = sector;
  const tag = get("tag"); if (tag) f.tag = tag;
  const session = get("session"); if (session) f.session = session;
  const eventType = get("eventType"); if (eventType) f.eventType = eventType;
  const horizon = get("horizon"); if ((HORIZONS as readonly string[]).includes(horizon)) f.horizon = horizon as Horizon;
  const source = get("source"); if (source === "manual" || source === "propreports") f.source = source;
  for (const k of ["exitEffMax", "mfeRMin", "leftMin"] as const) { const v = get(k); if (v && Number.isFinite(Number(v))) f[k] = v; }
  const ids = get("ids"); if (/^\d+(,\d+)*$/.test(ids)) f.ids = ids;

  const state: ParsedTradesUrl = { filters: f };
  const sort = get("sort"), dir = get("dir");
  if ((SORT_COLS as readonly string[]).includes(sort)) state.sort = { col: sort as SortCol, dir: dir === "asc" ? "asc" : "desc" };
  const page = Number(get("page")); if (Number.isInteger(page) && page > 1) state.page = page;
  const size = Number(get("size")); if ((PAGE_SIZES as readonly number[]).includes(size)) state.pageSize = size;
  const preset = get("preset"); if (isPreset(preset)) state.preset = preset;
  const view = get("view"); if (view === "list") state.view = "list";
  return { state, hasAny };
}

/** Serialise state → query string (only non-default values; `keep` carries the foreign params). */
export function serializeTradesUrl(s: TradesUrlState, keep?: URLSearchParams): string {
  const p = new URLSearchParams();
  if (keep) for (const [k, v] of keep.entries()) if (!(TRADES_URL_KEYS as readonly string[]).includes(k)) p.set(k, v);
  const f = s.filters;
  const set = (k: string, v: string | number | null | undefined) => { if (v !== "" && v != null) p.set(k, String(v)); };
  set("q", f.q.trim());
  set("ticker", f.ticker.trim().toUpperCase());
  if (f.period === "custom") {
    if (f.from && f.from === f.to) set("date", f.from);
    else { set("from", f.from); set("to", f.to); }
  } else if (f.period !== "all") set("period", f.period);
  if (f.outcome !== "all") set("outcome", f.outcome);
  set("side", f.side);
  set("setup", f.setup);
  set("playbookId", f.playbookId);
  set("trader", f.trader);
  set("sector", f.sector);
  set("tag", f.tag.trim());
  set("session", f.session);
  set("eventType", f.eventType);
  set("horizon", f.horizon);
  set("source", f.source);
  set("exitEffMax", f.exitEffMax);
  set("mfeRMin", f.mfeRMin);
  set("leftMin", f.leftMin);
  set("ids", f.ids);
  if (s.sort.col !== "date" || s.sort.dir !== "desc") { set("sort", s.sort.col); set("dir", s.sort.dir); }
  if (s.page > 1) set("page", s.page);
  if (s.pageSize !== DEFAULT_PAGE_SIZE) set("size", s.pageSize);
  set("preset", s.preset ?? "");
  if (s.view === "list" && !s.preset) set("view", "list");
  return p.toString();
}

function canonical(s: TradesUrlState): string {
  return serializeTradesUrl(s);
}

/**
 * Filter / sort / page state of the trades page. Source of truth is the URL (deep links from other sections,
 * shareable, survives reload); the last filters are mirrored to localStorage for the next visit without params.
 * Named saved views stay in localStorage.
 */
export function useTradeFilters() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const initialRef = useRef<ReturnType<typeof parseTradesUrl> | null>(null);
  if (!initialRef.current) initialRef.current = parseTradesUrl(search);
  const initial = initialRef.current;

  const [filters, setFilters] = useState<TradeFilters>(() => {
    if (initial.hasAny) return { ...DEFAULT_FILTERS, ...initial.state.filters };
    // The free-text search is not restored from storage: a stale query hiding trades is confusing.
    return { ...readLS<TradeFilters>(FILTERS_KEY, DEFAULT_FILTERS), q: "" };
  });
  const [sort, setSortState] = useState<SortConfig>(() => initial.state.sort ?? readLS<SortConfig>(SORT_KEY, { col: "date", dir: "desc" }));
  const [page, setPageState] = useState<number>(() => initial.state.page ?? 1);
  const [pageSize, setPageSizeState] = useState<number>(() => initial.state.pageSize ?? readLS<{ size: number }>(SIZE_KEY, { size: DEFAULT_PAGE_SIZE }).size);
  const [views, setViews] = useState<SavedView[]>(() => readLSArray<SavedView>(VIEWS_KEY));
  // Preset / layout live only in the URL: a fresh visit always opens the day view.
  const [preset, setPresetState] = useState<Preset | null>(() => initial.state.preset ?? null);
  const [view, setViewState] = useState<TradesView>(() => initial.state.view ?? "days");

  useEffect(() => { writeLS(FILTERS_KEY, filters); }, [filters]);
  useEffect(() => { writeLS(SORT_KEY, sort); }, [sort]);
  useEffect(() => { writeLS(SIZE_KEY, { size: pageSize }); }, [pageSize]);

  // State → URL (replace, so the history does not fill up with every keystroke).
  const lastWrittenRef = useRef<string | null>(null);
  useEffect(() => {
    const state = { filters, sort, page, pageSize, preset, view };
    const next = canonical(state);
    if (lastWrittenRef.current === next) return;
    lastWrittenRef.current = next;
    const qs = serializeTradesUrl(state, new URLSearchParams(window.location.search));
    const target = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
    if (target !== `${window.location.pathname}${window.location.search}`) navigate(target, { replace: true });
  }, [filters, sort, page, pageSize, preset, view, navigate]);

  // URL → state when another section links here while the page is mounted (global search, dashboard, playbook…).
  useEffect(() => {
    const parsed = parseTradesUrl(search);
    if (!parsed.hasAny) return;
    const incoming: TradesUrlState = {
      filters: { ...DEFAULT_FILTERS, ...parsed.state.filters },
      sort: parsed.state.sort ?? sort,
      page: parsed.state.page ?? 1,
      pageSize: parsed.state.pageSize ?? pageSize,
      preset: parsed.state.preset ?? null,
      view: parsed.state.view ?? "days",
    };
    const next = canonical(incoming);
    if (next === lastWrittenRef.current) return;
    lastWrittenRef.current = next;
    setFilters(incoming.filters);
    setSortState(incoming.sort);
    setPageState(incoming.page);
    setPageSizeState(incoming.pageSize);
    setPresetState(incoming.preset ?? null);
    setViewState(incoming.view ?? "days");
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  const patch = useCallback((p: Partial<TradeFilters>) => { setFilters((f) => ({ ...f, ...p })); setPageState(1); }, []);
  const reset = useCallback(() => { setFilters(DEFAULT_FILTERS); setPageState(1); }, []);
  /** Pick a review preset (null = back to the plain layout); applies the preset's own ordering. */
  const setPreset = useCallback((p: Preset | null) => {
    setPresetState(p);
    setSortState(p ? PRESET_META[p].sort : { col: "date", dir: "desc" });
    setPageState(1);
  }, []);
  const setView = useCallback((v: TradesView) => { setViewState(v); setPresetState(null); setPageState(1); }, []);
  const setSort = useCallback((s: SortConfig) => { setSortState(s); setPageState(1); }, []);
  const setPage = useCallback((n: number | ((cur: number) => number)) => {
    setPageState((cur) => Math.max(1, typeof n === "function" ? n(cur) : n));
  }, []);
  const setPageSize = useCallback((n: number) => {
    if (!(PAGE_SIZES as readonly number[]).includes(n)) return;
    setPageSizeState(n);
    setPageState(1);
  }, []);

  const saveView = useCallback((name: string) => {
    setViews((prev) => {
      const next = [...prev.filter((v) => v.name !== name), { id: `${Date.now()}`, name, filters: { ...filters, q: filters.q.trim() } }];
      writeLS(VIEWS_KEY, next);
      return next;
    });
  }, [filters]);

  const removeView = useCallback((id: string) => {
    setViews((prev) => {
      const next = prev.filter((v) => v.id !== id);
      writeLS(VIEWS_KEY, next);
      return next;
    });
  }, []);

  const applyView = useCallback((v: SavedView) => { setFilters({ ...DEFAULT_FILTERS, ...v.filters }); setPageState(1); }, []);

  const toggleSort = useCallback((col: SortConfig["col"]) => {
    setSortState((prev) => (prev.col === col ? { col, dir: prev.dir === "asc" ? "desc" : "asc" } : { col, dir: col === "ticker" || col === "trader" || col === "setup" ? "asc" : "desc" }));
    setPageState(1);
  }, []);

  return {
    filters, setFilters, patch, reset, views, saveView, removeView, applyView, sort, toggleSort, setSort, page, setPage, pageSize, setPageSize,
    preset, setPreset, view, setView,
  };
}
