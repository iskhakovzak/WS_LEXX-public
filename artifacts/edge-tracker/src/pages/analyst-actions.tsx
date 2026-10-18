import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Award, Download, HelpCircle, ListFilter, Loader2, MoreHorizontal, RefreshCw, SearchX, Sunrise, UserRound, Zap } from "lucide-react";
import {
  EmptyState, Kbd, Page, PageHeader, Panel, StatCard, StatGrid, TableSkeleton, UpdatedAgo, usePersistentState, type SortDir,
} from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { QueryError } from "@/components/query-error";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/auth-context";
import { cn } from "@/lib/utils";
import { fmtRate } from "@/lib/format";
import {
  runSourceScan, useAddToPlan, useAddToWatchlist, useAnalystFeed, useFirmStats, useFirmWeight, useMyDays, useMyPlanTickers,
  useOpenPositions, useQuotes, useReactionSummaries, useWatchlistTickers,
} from "@/components/analyst/api";
import { ActionsTable, scrollRowIntoView } from "@/components/analyst/ActionsTable";
import { FiltersBar, type TypeCounts } from "@/components/analyst/FiltersBar";
import { FirmStatsPanel, FirmStatsSheet, FirmWeightPanel } from "@/components/analyst/FirmStats";
import { MyDaysPanel } from "@/components/analyst/MyDaysPanel";
import { PremarketPanel } from "@/components/analyst/PremarketPanel";
import { TickerSheet } from "@/components/analyst/TickerSheet";
import { enrich, weightMap, type Row } from "@/components/analyst/rows";
import {
  DEFAULT_FILTERS, PERIODS, gapOf, isTopFirm, matchesFilters, matchesType, normalizeFilters, nyKey, nyParts, previousSessionDay,
  ptChangePct, sessionWindow, shortDay, watchlistCatalyst,
  type FeedAction, type Filters, type OpenPosition, type SavedView, type SortKey,
} from "@/components/analyst/lib";
import { humanizeApiError } from "@/lib/api/errors";
import { commonI18n } from "@/i18n/ns/common";
import { analystI18n } from "@/i18n/ns/analyst";

import { personName } from "@/i18n";
type SortState = { key: SortKey; dir: SortDir };
const DEFAULT_SORT: SortState = { key: "time", dir: "desc" };
const SORT_KEYS: SortKey[] = ["score", "time", "pt", "gap", "weight", "ticker"];

/** Sort accessors: empty values always sink. */
const SORT_GET: Record<SortKey, (r: Row) => number | string | null> = {
  score: (r) => r.score,
  time: (r) => r.a.gradedAt ?? null,
  pt: (r) => { const p = ptChangePct(r.a); return p == null ? null : Math.abs(p); },
  gap: (r) => { const g = gapOf(r.quote); return g == null ? null : Math.abs(g); },
  weight: (r) => (r.weight && r.weight.n >= 5 ? r.weight.ratio : null),
  ticker: (r) => r.a.ticker,
};

function sortRows(rows: Row[], s: SortState): Row[] {
  const get = SORT_GET[s.key];
  const out = [...rows];
  out.sort((x, y) => {
    const a = get(x);
    const b = get(y);
    if (a == null && b == null) return (y.a.gradedAt ?? "").localeCompare(x.a.gradedAt ?? "");
    if (a == null) return 1;
    if (b == null) return -1;
    const c = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
    return (s.dir === "asc" ? c : -c) || (y.a.gradedAt ?? "").localeCompare(x.a.gradedAt ?? "");
  });
  return out;
}

/** Key → hotkey label key (labels resolved at render). */
const HOTKEYS = [
  ["/", "search"],
  ["T", "session"],
  ["M", "mine"],
  ["J / K", "rows"],
  ["Enter", "open"],
  ["W", "watch"],
  ["P", "plan"],
  ["Esc", "reset"],
] as const;
const tf = analystI18n.t;

export default function AnalystActionsPage() {
  const { canEdit, isCurator, isAdmin, user } = useAuth();
  const traderName = user && user.role !== "guest" ? user.traderName : null;
  const { toast } = useToast();
  const qc = useQueryClient();

  /* ── persisted view ─────────────────────────────────────────────────── */
  const [rawFilters, setRawFilters] = usePersistentState<Filters>("analyst.filters.v6", DEFAULT_FILTERS);
  const filters = useMemo(() => normalizeFilters(rawFilters), [rawFilters]);
  const setFilters = useCallback((patch: Partial<Filters>) => setRawFilters((prev) => ({ ...normalizeFilters(prev), ...patch })), [setRawFilters]);
  const [views, setViews] = usePersistentState<SavedView[]>("analyst.views", []);
  const [rawSort, setSort] = usePersistentState<SortState>("analyst.sort", DEFAULT_SORT);
  const sort: SortState = SORT_KEYS.includes(rawSort?.key) && (rawSort.dir === "asc" || rawSort.dir === "desc") ? rawSort : DEFAULT_SORT;

  const [search, setSearch] = useState("");
  const [firmFilter, setFirmFilter] = useState<string | null>(null);
  const [tickerFilter, setTickerFilter] = useState<string | null>(null);
  const [sheetTicker, setSheetTicker] = useState<string | null>(null);
  const [firmsOpen, setFirmsOpen] = useState(false);
  const [added, setAdded] = useState<Set<string>>(() => new Set());
  const [planned, setPlanned] = useState<Set<string>>(() => new Set());
  const [addingWatch, setAddingWatch] = useState<string | null>(null);
  const [addingPlan, setAddingPlan] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const searchRef = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  /* ── data ───────────────────────────────────────────────────────────── */
  const period = Number(filters.period);
  // Always load ≥ 5 days so «Сегодня до открытия» has the previous close over a weekend; the period is applied below.
  const feed = useAnalystFeed({ days: Math.max(period, 5), minCapB: filters.minCapB, includeUnknownCap: filters.includeUnknownCap });
  const positions = useOpenPositions();
  const watch = useWatchlistTickers();
  const firmStats = useFirmStats(180);
  const firmWeight = useFirmWeight();
  const myDays = useMyDays(traderName);
  const addWatchMut = useAddToWatchlist();
  const addPlanMut = useAddToPlan();

  const items = useMemo(() => feed.data?.items ?? [], [feed.data]);
  const win = useMemo(() => sessionWindow(), [feed.dataUpdatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const todayNy = useMemo(() => nyParts(new Date()).day, [feed.dataUpdatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const planTickers = useMyPlanTickers(win.sessionDay, canEdit);

  const heldMap = useMemo(() => {
    const m = new Map<string, OpenPosition[]>();
    for (const p of positions.data ?? []) {
      const arr = m.get(p.ticker) ?? [];
      arr.push(p);
      m.set(p.ticker, arr);
    }
    return m;
  }, [positions.data]);

  const tradedInfo = useMemo(() => new Map((myDays.data?.tickers ?? []).map((t) => [t.ticker.toUpperCase(), t])), [myDays.data]);
  const tradedCount = useMemo(() => new Map(Array.from(tradedInfo.entries()).map(([k, v]) => [k, v.trades])), [tradedInfo]);
  const isWatched = useCallback((t: string) => watch.set.has(t.toUpperCase()) || added.has(t.toUpperCase()), [watch.set, added]);
  const inPlan = useCallback((t: string) => planTickers.has(t.toUpperCase()) || planned.has(t.toUpperCase()), [planTickers, planned]);
  const myTickers = useMemo(() => {
    const s = new Set<string>([...watch.set, ...added, ...tradedInfo.keys(), ...heldMap.keys()]);
    return s;
  }, [watch.set, added, tradedInfo, heldMap]);
  const weights = useMemo(() => weightMap(firmWeight.data?.firms), [firmWeight.data]);

  /* ── base selection (period + client filters except type) ──────────── */
  const periodStart = useMemo(() => {
    const d = new Date(Date.now() - period * 86400_000);
    d.setMinutes(0, 0, 0);
    return d.toISOString();
  }, [period, feed.dataUpdatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const windowItems = useMemo(() => items.filter((a) => nyKey(a.gradedAt) >= win.startKey), [items, win.startKey]);
  const fallbackDay = useMemo(() => (windowItems.length ? null : previousSessionDay(items, win.startKey)), [items, windowItems.length, win.startKey]);
  const premarketItems = useMemo(
    () => (fallbackDay ? items.filter((a) => nyKey(a.gradedAt).slice(0, 10) === fallbackDay) : windowItems),
    [items, windowItems, fallbackDay],
  );
  const periodItems = useMemo(() => items.filter((a) => (a.gradedAt ?? "") >= periodStart), [items, periodStart]);

  /* quotes / reactions: premarket names first, then the freshest names in the period */
  const focusTickers = useMemo(() => {
    const s = new Set<string>();
    for (const a of premarketItems) s.add(a.ticker);
    for (const t of heldMap.keys()) s.add(t);
    if (sheetTicker) s.add(sheetTicker);
    for (const a of periodItems) { if (s.size >= 100) break; s.add(a.ticker); }
    return Array.from(s);
  }, [premarketItems, periodItems, heldMap, sheetTicker]);
  const quotes = useQuotes(focusTickers);
  const reactions = useReactionSummaries(useMemo(() => focusTickers.slice(0, 80), [focusTickers]));

  const enrichCtx = useMemo(() => ({
    quotes: quotes.data, held: heldMap, isWatched, traded: tradedCount, weights, reactions: reactions.data?.tickers,
  }), [quotes.data, heldMap, isWatched, tradedCount, weights, reactions.data]);

  const premarketRows = useMemo(() => premarketItems.map((a) => enrich(a, enrichCtx)), [premarketItems, enrichCtx]);

  const filterCtx = useMemo(() => ({
    isMine: (t: string) => myTickers.has(t.toUpperCase()),
    isTop: (firm: string) => isTopFirm(firm, weights.get(firm)),
    windowStart: win.startKey,
  }), [myTickers, weights, win.startKey]);

  const preType = useMemo(() => {
    const noType = { ...filters, type: "all" as const };
    return periodItems.filter((a) => {
      if (firmFilter && a.firm !== firmFilter) return false;
      if (tickerFilter && a.ticker !== tickerFilter) return false;
      return matchesFilters(a, noType, filterCtx, search);
    });
  }, [periodItems, filters, filterCtx, search, firmFilter, tickerFilter]);

  const typeCounts = useMemo<TypeCounts>(() => {
    const c: TypeCounts = { all: preType.length, moves: 0, upgrade: 0, downgrade: 0, initiated: 0, targets: 0 };
    for (const a of preType) {
      for (const t of ["moves", "upgrade", "downgrade", "initiated", "targets"] as const) if (matchesType(a, t)) c[t]++;
    }
    return c;
  }, [preType]);

  const tableRows = useMemo(() => {
    const list = preType.filter((a) => matchesType(a, filters.type)).map((a) => enrich(a, enrichCtx));
    return sortRows(list, sort);
  }, [preType, filters.type, enrichCtx, sort]);

  const sectors = useMemo(() => {
    const s = new Set<string>();
    for (const a of periodItems) if (a.sector) s.add(a.sector);
    return Array.from(s).sort((a, b) => a.localeCompare(b, "ru"));
  }, [periodItems]);

  const firmWindowCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of periodItems) m.set(a.firm, (m.get(a.firm) ?? 0) + 1);
    return m;
  }, [periodItems]);

  /* ── KPIs ───────────────────────────────────────────────────────────── */
  const kpi = useMemo(() => {
    let up = 0, down = 0, pre = 0;
    for (const a of windowItems) {
      if (a.action === "upgrade") up++;
      if (a.action === "downgrade") down++;
      if (a.gradedAt && nyParts(new Date(a.gradedAt)).minutes < 570) pre++;
    }
    const mineRows = windowItems.filter((a) => myTickers.has(a.ticker.toUpperCase()));
    const mineTickers = new Set(mineRows.map((a) => a.ticker));
    const heldHit = new Set(mineRows.filter((a) => heldMap.has(a.ticker)).map((a) => a.ticker)).size;
    const perDay = new Map<string, number>();
    let pUp = 0, pDown = 0, raised = 0, cut = 0;
    for (const a of periodItems) {
      const d = nyKey(a.gradedAt).slice(0, 10);
      if (a.action === "upgrade") { pUp++; perDay.set(d, (perDay.get(d) ?? 0) + 1); }
      else if (a.action === "downgrade") { pDown++; perDay.set(d, (perDay.get(d) ?? 0) - 1); }
      else if (!perDay.has(d)) perDay.set(d, 0);
      const p = ptChangePct(a);
      if (p != null && p !== 0) { if (p > 0) raised++; else cut++; }
    }
    const spark = Array.from(perDay.keys()).sort().map((d) => perDay.get(d) ?? 0);
    return {
      since: windowItems.length, up, down, pre,
      mine: mineRows.length, mineTickers: mineTickers.size, heldHit,
      pUp, pDown, spark, raisedShare: raised + cut ? raised / (raised + cut) : null,
    };
  }, [windowItems, periodItems, myTickers, heldMap]);

  /* ── actions ────────────────────────────────────────────────────────── */
  const addToWatch = useCallback((a: FeedAction) => {
    if (!canEdit) return;
    const t = a.ticker.toUpperCase();
    setAddingWatch(t);
    addWatchMut.mutate(
      { ticker: t, catalyst: watchlistCatalyst(a), sector: a.sector, longName: a.longName },
      {
        onSuccess: () => {
          setAdded((s) => new Set(s).add(t));
          toast({ title: tf("page.inWatchlist", { ticker: t }), description: watchlistCatalyst(a) });
        },
        onError: (e) => toast({ title: tf("page.watchFailed"), description: humanizeApiError(e), variant: "destructive" }),
        onSettled: () => setAddingWatch(null),
      },
    );
  }, [addWatchMut, canEdit, toast]);

  const addToPlan = useCallback((a: FeedAction) => {
    if (!canEdit) return;
    const t = a.ticker.toUpperCase();
    const p = ptChangePct(a);
    const bias = a.action === "upgrade" ? "bull" : a.action === "downgrade" ? "bear" : p != null && Math.abs(p) >= 10 ? (p > 0 ? "bull" : "bear") : "neutral";
    setAddingPlan(t);
    addPlanMut.mutate(
      { date: win.sessionDay, ticker: t, catalyst: watchlistCatalyst(a), bias },
      {
        onSuccess: (r) => {
          setPlanned((s) => new Set(s).add(t));
          toast({
            title: r.already ? tf("page.alreadyInPlan", { ticker: t }) : tf("page.inMyPlan", { ticker: t, date: shortDay(win.sessionDay) }),
            description: r.already ? undefined : tf("page.planHint"),
          });
        },
        onError: (e) => toast({ title: tf("page.planFailed"), description: humanizeApiError(e), variant: "destructive" }),
        onSettled: () => setAddingPlan(null),
      },
    );
  }, [addPlanMut, canEdit, toast, win.sessionDay]);

  const openRow = useCallback((r: Row) => setSheetTicker(r.a.ticker), []);
  const watchRow = useCallback((r: Row) => addToWatch(r.a), [addToWatch]);
  const planRow = useCallback((r: Row) => addToPlan(r.a), [addToPlan]);
  const filterFirm = useCallback((f: string) => setFirmFilter(f), []);
  const filterTicker = useCallback((t: string) => setTickerFilter(t), []);

  const onSort = useCallback((k: SortKey) => {
    setSort((s) => {
      const cur = SORT_KEYS.includes(s?.key) ? s : DEFAULT_SORT;
      if (cur.key === k) return { key: k, dir: cur.dir === "asc" ? "desc" : "asc" };
      return { key: k, dir: k === "ticker" ? "asc" : "desc" };
    });
  }, [setSort]);

  async function handleScan() {
    setScanning(true);
    try {
      const r = await runSourceScan();
      qc.invalidateQueries({ queryKey: ["analyst-actions"] });
      toast({ title: tf("page.scanDone"), description: tf("page.scanResult", { count: r.rowsInserted, seconds: (r.durationMs / 1000).toFixed(0) }) });
    } catch (e) {
      toast({ title: tf("page.scanFailed"), description: humanizeApiError(e, commonI18n.t("states.tryAgain")), variant: "destructive" });
    } finally {
      setScanning(false);
    }
  }

  function exportCsv() {
    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = ["date_et", "time_et", "ticker", "action", "firm", "from_grade", "to_grade", "pt_from", "pt_to", "pt_change_pct", "gap_pct", "firm_weight", "score", "team_position", "watchlist", "source_url"];
    const lines = [head.join(",")];
    for (const r of tableRows) {
      const a = r.a;
      const k = nyKey(a.gradedAt);
      const p = ptChangePct(a);
      lines.push([
        k.slice(0, 10), k.slice(11), a.ticker, a.action, a.firm, a.fromGrade, a.toGrade, a.priceTargetFrom, a.priceTarget,
        p == null ? "" : p.toFixed(2), gapOf(r.quote) ?? "", r.weight && r.weight.n >= 5 ? r.weight.ratio ?? "" : "", r.score,
        r.held.length ? "yes" : "", r.watched ? "yes" : "", a.sourceUrl,
      ].map(esc).join(","));
    }
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `analyst-actions-${todayNy}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const resetFilters = useCallback(() => {
    setSearch(""); setFirmFilter(null); setTickerFilter(null);
    setFilters({ type: "all", tier: "all", ptMin: 0, sector: null, mineOnly: false, todayOnly: false });
  }, [setFilters]);
  const hasFilters = !!(search || firmFilter || tickerFilter) || filters.type !== "all" || filters.tier !== "all" || !!filters.ptMin
    || !!filters.sector || filters.mineOnly || filters.todayOnly;

  const saveView = useCallback((name: string) => {
    setViews((v) => [...(Array.isArray(v) ? v : []).filter((x) => x.name !== name), { id: `v${Date.now().toString(36)}`, name, filters }].slice(-12));
  }, [filters, setViews]);
  const deleteView = useCallback((id: string) => setViews((v) => (Array.isArray(v) ? v : []).filter((x) => x.id !== id)), [setViews]);

  // the focused row index is meaningless after the selection changes
  useEffect(() => { setFocusedIndex(-1); }, [filters, search, firmFilter, tickerFilter, sort]);

  /* ── keyboard ───────────────────────────────────────────────────────── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/" && !typing) { e.preventDefault(); searchRef.current?.focus(); return; }
      if (typing || sheetTicker || firmsOpen) return;
      if (document.querySelector("[role=dialog],[data-radix-popper-content-wrapper]")) return;
      const k = e.key.toLowerCase();
      const row = focusedIndex >= 0 ? tableRows[focusedIndex] : undefined;
      // Russian-layout twins of the hotkeys (Е=T, Ь=M, О=J, Л=K, Ц=W, З=P) — key codes, not UI copy.
      if (k === "t" || k === "е") { e.preventDefault(); setFilters({ todayOnly: !filters.todayOnly }); } // i18n-ignore
      else if (k === "m" || k === "ь") { e.preventDefault(); setFilters({ mineOnly: !filters.mineOnly }); } // i18n-ignore
      else if (k === "j" || k === "k" || k === "о" || k === "л" || k === "arrowdown" || k === "arrowup") { // i18n-ignore
        if (!tableRows.length) return;
        // Arrow keys only drive the table when a row is already focused (they still scroll the page otherwise).
        if ((k === "arrowdown" || k === "arrowup") && focusedIndex < 0) return;
        e.preventDefault();
        const down = k === "j" || k === "о" || k === "arrowdown"; // i18n-ignore
        const next = focusedIndex < 0 ? 0 : Math.max(0, Math.min(tableRows.length - 1, focusedIndex + (down ? 1 : -1)));
        setFocusedIndex(next);
        if (focusedIndex < 0) tableRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
        scrollRowIntoView(tableRef.current, next);
      } else if (e.key === "Enter" && row) { e.preventDefault(); setSheetTicker(row.a.ticker); }
      else if ((k === "w" || k === "ц") && row) { if (!row.watched) { e.preventDefault(); addToWatch(row.a); } } // i18n-ignore
      else if ((k === "p" || k === "з") && row) { if (!inPlan(row.a.ticker)) { e.preventDefault(); addToPlan(row.a); } } // i18n-ignore
      else if (e.key === "Escape") {
        if (focusedIndex >= 0) setFocusedIndex(-1);
        else if (hasFilters) resetFilters();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheetTicker, firmsOpen, filters.todayOnly, filters.mineOnly, setFilters, hasFilters, resetFilters, tableRows, focusedIndex, addToWatch, addToPlan, inPlan]);

  const periodLabel = PERIODS.find((p) => p.value === filters.period)?.label ?? tf("period.d", { count: period });
  const scopeLabel = traderName ? personName(traderName) : tf("page.wholeTeam");
  const sheetRow = sheetTicker ? sheetTicker.toUpperCase() : null;

  /* ── render ─────────────────────────────────────────────────────────── */
  return (
    <Page>
      <PageHeader
        title={tf("page.title")}
        description={tf("page.description")}
        icon={Award}
        meta={
          <>
            <UpdatedAgo at={feed.dataUpdatedAt} />
            <span>{tf("page.timeNy")}</span>
          </>
        }
        actions={
          <>
            <Button variant="ghost" size="icon" onClick={() => feed.refetch()} disabled={feed.isFetching} aria-label={tf("page.refreshAria")} title={commonI18n.t("actions.refresh")}>
              <RefreshCw className={cn(feed.isFetching && "motion-safe:animate-spin")} aria-hidden="true" />
            </Button>
            <Button variant="ghost" size="icon" onClick={exportCsv} disabled={!tableRows.length} aria-label={tf("page.exportAria")} title={tf("page.exportTitle")}>
              <Download aria-hidden="true" />
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={tf("page.hotkeysAria")}>
                  <HelpCircle aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="w-64">
                <div className="flex flex-col gap-1.5 py-0.5">
                  <span className="text-xs font-semibold text-foreground">{tf("page.hotkeysAria")}</span>
                  {HOTKEYS.map(([k, label]) => (
                    <span key={k} className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                      {tf(`page.hotkeys.${label}`)} <Kbd>{k}</Kbd>
                    </span>
                  ))}
                </div>
              </TooltipContent>
            </Tooltip>
            <Button variant="outline" onClick={() => setFirmsOpen(true)}>{tf("page.firms")}</Button>
            {(isCurator || isAdmin || canEdit) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label={commonI18n.t("actions.moreActions")}>
                    {scanning ? <Loader2 className="motion-safe:animate-spin" aria-hidden="true" /> : <MoreHorizontal aria-hidden="true" />}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{tf("page.sources")}</DropdownMenuLabel>
                  <DropdownMenuItem disabled={scanning} onSelect={() => { void handleScan(); }}>
                    <Zap className="h-4 w-4" aria-hidden="true" /> {scanning ? tf("page.scanning") : tf("page.scan")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        }
      />

      {/* ── KPIs ── */}
      <StatGrid cols={3}>
        <StatCard
          label={tf("page.kpiSession")}
          icon={Sunrise}
          tone="accent"
          loading={feed.isLoading}
          value={kpi.since}
          hint={tf("page.kpiSessionHint", { up: kpi.up, down: kpi.down, pre: kpi.pre, window: win.label })}
          onClick={() => setFilters({ todayOnly: !filters.todayOnly })}
        />
        <StatCard
          label={tf("page.kpiMine")}
          icon={UserRound}
          tone={kpi.mine ? "warn" : "neutral"}
          loading={feed.isLoading}
          value={kpi.mine}
          hint={
            myTickers.size === 0
              ? tf("page.kpiMineEmpty")
              : kpi.mine
                ? `${tf("page.kpiMineHit", { tickers: kpi.mineTickers })}${kpi.heldHit ? tf("page.kpiMineHeld", { count: kpi.heldHit }) : ""}${tf("page.kpiMineTotal", { count: myTickers.size })}`
                : tf("page.kpiMineNone", { count: myTickers.size })
          }
          onClick={() => setFilters({ mineOnly: !filters.mineOnly, todayOnly: !filters.mineOnly ? true : filters.todayOnly })}
        />
        <StatCard
          label={tf("page.kpiBalance", { period: periodLabel })}
          tone={kpi.pUp - kpi.pDown > 0 ? "up" : kpi.pUp - kpi.pDown < 0 ? "down" : "neutral"}
          loading={feed.isLoading}
          value={`${kpi.pUp - kpi.pDown > 0 ? "+" : kpi.pUp - kpi.pDown < 0 ? "−" : ""}${Math.abs(kpi.pUp - kpi.pDown)}`}
          hint={`▲${kpi.pUp} ▼${kpi.pDown}${kpi.raisedShare != null ? tf("page.kpiRaised", { value: fmtRate(kpi.raisedShare) }) : ""}`}
          spark={kpi.spark.length > 1 ? kpi.spark : undefined}
          onClick={() => setFilters({ type: "moves" })}
        />
      </StatGrid>

      {/* ── premarket + my stats ── */}
      {/* Same 3-column track as the KPI row above, so the panel edges line up with the stat cards. */}
      <div className="grid gap-[var(--grid-gap)] xl:grid-cols-3">
        <PremarketPanel
          className="xl:col-span-2"
          rows={premarketRows}
          isLoading={feed.isLoading}
          fallbackDay={fallbackDay}
          windowLabel={win.label}
          canEdit={canEdit}
          inPlan={inPlan}
          addingWatch={addingWatch}
          addingPlan={addingPlan}
          onOpen={setSheetTicker}
          onAddWatch={watchRow}
          onAddPlan={planRow}
        />
        <aside className="flex min-w-0 flex-col gap-[var(--grid-gap)]" aria-label={tf("page.asideAria")}>
          <MyDaysPanel data={myDays.data} isLoading={myDays.isLoading} scopeLabel={scopeLabel} />
          {firmWeight.data ? (
            <FirmWeightPanel
              data={firmWeight.data}
              isLoading={false}
              activeFirm={firmFilter}
              windowCounts={firmWindowCounts}
              onPickFirm={(f) => setFirmFilter((cur) => (cur === f ? null : f))}
              onOpenAll={() => setFirmsOpen(true)}
            />
          ) : (
            <FirmStatsPanel
              data={firmStats.data}
              isLoading={firmStats.isLoading || firmWeight.isLoading}
              activeFirm={firmFilter}
              windowCounts={firmWindowCounts}
              onPickFirm={(f) => setFirmFilter((cur) => (cur === f ? null : f))}
              onOpenAll={() => setFirmsOpen(true)}
            />
          )}
        </aside>
      </div>

      {/* ── feed ── */}
      <Panel icon={ListFilter} title={tf("page.feed")} description={tf("page.feedDescription", { period: periodLabel, actions: tf("firms.actionsCount", { count: typeCounts.all }) })}>
        <div className="flex flex-col gap-3">
          <FiltersBar
            filters={filters}
            onChange={setFilters}
            search={search}
            onSearch={setSearch}
            searchRef={searchRef}
            typeCounts={typeCounts}
            sectors={sectors}
            capStats={feed.data?.capStats}
            mineCount={myTickers.size}
            views={Array.isArray(views) ? views : []}
            onSaveView={saveView}
            onDeleteView={deleteView}
            firmFilter={firmFilter}
            tickerFilter={tickerFilter}
            onClearFirm={() => setFirmFilter(null)}
            onClearTicker={() => setTickerFilter(null)}
            onReset={resetFilters}
            sortKey={sort.key}
            onSortMode={(k) => setSort({ key: k, dir: "desc" })}
            shown={tableRows.length}
          />
          <div className="min-h-[420px]">
            {feed.isLoading ? (
              <TableSkeleton rows={9} cols={7} />
            ) : feed.isError ? (
              <QueryError error={feed.error} onRetry={() => feed.refetch()} />
            ) : tableRows.length === 0 ? (
              items.length === 0 ? (
                <EmptyState
                  icon={Award}
                  title={tf("page.emptyTitle")}
                  description={filters.minCapB > 0 && !filters.includeUnknownCap
                    ? tf("page.emptyCap", { value: filters.minCapB })
                    : tf("page.emptyText")}
                  action={filters.minCapB > 0 && !filters.includeUnknownCap
                    ? <Button variant="outline" onClick={() => setFilters({ includeUnknownCap: true })}>{tf("page.includeUnknown")}</Button>
                    : <Button variant="outline" onClick={() => setFilters({ period: "30" })}>{tf("page.show30")}</Button>}
                />
              ) : filters.todayOnly && !windowItems.length ? (
                <EmptyState
                  icon={Sunrise}
                  title={tf("page.sessionEmptyTitle")}
                  description={tf("page.sessionEmptyText", { window: win.label })}
                  action={<Button variant="outline" onClick={() => setFilters({ todayOnly: false })}>{tf("page.showAllPeriod")}</Button>}
                />
              ) : (
                <EmptyState
                  icon={SearchX}
                  title={commonI18n.t("states.nothingFound")}
                  description={filters.mineOnly && myTickers.size === 0
                    ? tf("page.mineEmpty")
                    : tf("page.filtersEmpty")}
                  action={<Button variant="outline" onClick={resetFilters}>{commonI18n.t("actions.resetFilters")}</Button>}
                />
              )
            ) : (
              <ActionsTable
                ref={tableRef}
                rows={tableRows}
                query={search}
                today={todayNy}
                sortKey={sort.key}
                sortDir={sort.dir}
                onSort={onSort}
                focusedIndex={focusedIndex}
                canEdit={canEdit}
                inPlan={inPlan}
                addingWatch={addingWatch}
                addingPlan={addingPlan}
                onOpen={openRow}
                onAddWatch={watchRow}
                onAddPlan={planRow}
                onFilterFirm={filterFirm}
                onFilterTicker={filterTicker}
              />
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {tf("page.footnote")}
          </p>
        </div>
      </Panel>

      <TickerSheet
        ticker={sheetTicker}
        onOpenChange={(o) => { if (!o) setSheetTicker(null); }}
        quote={sheetRow ? quotes.data?.[sheetRow] : null}
        held={sheetRow ? heldMap.get(sheetRow) ?? [] : []}
        watched={sheetRow ? isWatched(sheetRow) : false}
        inPlan={sheetRow ? inPlan(sheetRow) : false}
        traded={sheetRow ? tradedInfo.get(sheetRow) ?? null : null}
        addingWatch={!!sheetRow && addingWatch === sheetRow}
        addingPlan={!!sheetRow && addingPlan === sheetRow}
        canEdit={canEdit}
        onAddWatch={addToWatch}
        onAddPlan={addToPlan}
      />
      <FirmStatsSheet
        open={firmsOpen}
        onOpenChange={setFirmsOpen}
        data={firmStats.data}
        weights={firmWeight.data}
        activeFirm={firmFilter}
        onPickFirm={(f) => setFirmFilter(f)}
      />
    </Page>
  );
}
