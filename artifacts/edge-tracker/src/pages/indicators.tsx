import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTradesBookFacets } from "@/hooks/use-trades-window";
import { useTaggedTrades } from "@/components/indicators/use-tagged-trades";
import { Activity, BookOpen, Compass, LayoutGrid, Layers, Rows3, Search, SlidersHorizontal, X } from "lucide-react";
import { EmptyState, Page, PageHeader, SectionTabs, Segmented, Toolbar, usePersistentState } from "@/components/ds";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MarketView } from "@/components/indicators/market/MarketView";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { indicatorsI18n } from "@/i18n/ns/indicators";
import { commonI18n } from "@/i18n/ns/common";
import { fmtR } from "@/lib/format";
import {
  CATEGORY_META, CATEGORY_ORDER, DESK_PRESETS, HORIZON_META, LIBRARY, LIB_BY_ID, type Horizon, type LibCategory, type LibIndicator,
} from "@/components/indicators/library";
import { EMPTY_STATS, useIndicatorStats } from "@/components/indicators/stats";
import { IndicatorCard } from "@/components/indicators/IndicatorCard";
import { IndicatorSheet } from "@/components/indicators/IndicatorSheet";
import { EdgeTable } from "@/components/indicators/EdgeTable";
import { MySetPanel, buildMarkdown, parseImport, type SetExport } from "@/components/indicators/MySetPanel";
import {
  downloadText, loadFavorites, loadNotes, loadPrefs, pushFavoritesDiff, pushIndicator, pushNotes, saveFavorites, saveNotes, savePrefs,
  syncIndicatorState,
} from "@/components/indicators/storage";

type CategoryFilter = LibCategory | "all" | "favorites";
type HorizonFilter = Horizon | "all";
type SortKey = "recommended" | "mine" | "avgR" | "alpha";

const SORT_KEYS: readonly SortKey[] = ["recommended", "mine", "avgR", "alpha"];

const isCategory = (v: string): v is CategoryFilter => v === "all" || v === "favorites" || v in CATEGORY_META;
const isHorizon = (v: string): v is HorizonFilter => v === "all" || v in HORIZON_META;
const isSort = (v: string): v is SortKey => (SORT_KEYS as readonly string[]).includes(v);

function matches(ind: LibIndicator, q: string, note: string) {
  const hay = [ind.shortName, ind.name, ind.enName, ind.summary, ind.deskUse, ind.tags.join(" "), CATEGORY_META[ind.category].label, note]
    .join(" ")
    .toLowerCase();
  return q.split(/\s+/).every((part) => hay.includes(part));
}

/** Desk reference: 25 technical indicators, the trader's set, notes and per-tag stats. */
function IndicatorLibrary() {
  const { toast } = useToast();
  const { t } = indicatorsI18n.useT();
  const initialPrefs = useMemo(loadPrefs, []);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<CategoryFilter>(isCategory(initialPrefs.category) ? initialPrefs.category : "all");
  const [horizon, setHorizon] = useState<HorizonFilter>(isHorizon(initialPrefs.horizon) ? initialPrefs.horizon : "all");
  const [sort, setSort] = useState<SortKey>(isSort(initialPrefs.sort) ? initialPrefs.sort : "recommended");
  const [view, setView] = useState<"cards" | "table">(initialPrefs.view === "table" ? "table" : "cards");
  const [favorites, setFavorites] = useState<string[]>(loadFavorites);
  const [notes, setNotes] = useState<Record<string, string>>(loadNotes);
  const [openId, setOpenId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // P1-5: only trades with a setup or tags can match an indicator — the rest of the book is not loaded.
  // The coverage denominator (all trades in scope per horizon) comes from the cheap /trades/page facets.
  // Slim columnar endpoint (~2 MB for the whole desk instead of ~60 MB of full trade rows).
  const tradesQuery = useTaggedTrades();
  const trades = tradesQuery.data ?? [];
  const facets = useTradesBookFacets();
  const scopeTotal = facets.data
    ? horizon === "all" ? facets.data.total : Number(facets.data.horizons[horizon] ?? 0)
    : null;
  const statsLoading = tradesQuery.isLoading;
  const { map: statsMap, coverage, total } = useIndicatorStats(trades, horizon, scopeTotal);

  useEffect(() => { savePrefs({ category, horizon, sort, view }); }, [category, horizon, sort, view]);

  // Global "/" focuses search (ignored while typing elsewhere or when the sheet is open).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || openId) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId]);

  const favSet = useMemo(() => new Set(favorites), [favorites]);

  // Refs mirror state so callbacks stay stable and side effects (storage, toasts) run outside state updaters.
  const favRef = useRef(favorites);
  favRef.current = favorites;
  const notesRef = useRef(notes);
  notesRef.current = notes;

  // Server = source of truth (P1-6); the localStorage values above are only the instant-paint cache.
  // "pending" until the first sync answers, "local" when the API is unreachable (then everything stays in the browser).
  const [syncMode, setSyncMode] = useState<"pending" | "server" | "local">("pending");
  useEffect(() => {
    let alive = true;
    void syncIndicatorState().then((state) => {
      if (!alive) return;
      if (!state) { setSyncMode("local"); return; }
      favRef.current = state.favorites;
      notesRef.current = state.notes;
      setFavorites(state.favorites);
      setNotes(state.notes);
      setSyncMode("server");
    });
    return () => { alive = false; };
  }, []);
  const serverFailedToast = useRef(false);
  const onServerResult = useCallback((ok: boolean) => {
    if (ok) { setSyncMode("server"); return; }
    setSyncMode("local");
    if (!serverFailedToast.current) {
      serverFailedToast.current = true;
      toast({ title: indicatorsI18n.t("toast.serverDown"), description: indicatorsI18n.t("toast.savedLocally"), variant: "destructive" });
    }
  }, [toast]);

  const commitFavorites = useCallback((next: string[]) => {
    const prev = favRef.current;
    favRef.current = next;
    setFavorites(next);
    const cached = saveFavorites(next);
    void pushFavoritesDiff(prev, next).then((ok) => {
      onServerResult(ok);
      if (!ok && !cached) toast({ title: indicatorsI18n.t("toast.setSaveFailed"), description: indicatorsI18n.t("toast.noStorage"), variant: "destructive" });
    });
  }, [toast, onServerResult]);

  const toggleFavorite = useCallback((id: string) => {
    const prev = favRef.current;
    commitFavorites(prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }, [commitFavorites]);

  const saveNote = useCallback((id: string, text: string) => {
    const prev = notesRef.current;
    const clean = text.trim();
    if ((prev[id] ?? "") === clean) return;
    const next = { ...prev };
    if (clean) next[id] = clean; else delete next[id];
    notesRef.current = next;
    setNotes(next);
    const cached = saveNotes(next);
    void pushIndicator(id, { note: clean }).then((ok) => {
      if (ok) { onServerResult(true); toast({ title: indicatorsI18n.t(clean ? "toast.noteSaved" : "toast.noteDeleted") }); return; }
      onServerResult(false);
      if (!cached) toast({ title: indicatorsI18n.t("toast.noteSaveFailed"), description: indicatorsI18n.t("toast.noStorage"), variant: "destructive" });
    });
  }, [toast, onServerResult]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: LIBRARY.length, favorites: favorites.length };
    LIBRARY.forEach((i) => { c[i.category] = (c[i.category] ?? 0) + 1; });
    return c;
  }, [favorites]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = LIBRARY.filter((ind) => {
      if (category === "favorites" ? !favSet.has(ind.id) : category !== "all" && ind.category !== category) return false;
      if (horizon !== "all" && ind.horizons[horizon] < 2) return false;
      return !q || matches(ind, q, notes[ind.id] ?? "");
    });
    const st = (id: string) => statsMap[id] ?? EMPTY_STATS;
    const fit = (i: LibIndicator) => (horizon === "all" ? Math.max(i.horizons.intraday, i.horizons.overnight, i.horizons.swing) : i.horizons[horizon]);
    const cmp: Record<SortKey, (a: LibIndicator, b: LibIndicator) => number> = {
      // Library order is desk-curated (most used on the desk first); a horizon filter ranks by fit first.
      recommended: (a, b) => (horizon === "all" ? 0 : fit(b) - fit(a)) || LIBRARY.indexOf(a) - LIBRARY.indexOf(b),
      mine: (a, b) => st(b.id).count - st(a.id).count,
      avgR: (a, b) => (st(b.id).avgR ?? -Infinity) - (st(a.id).avgR ?? -Infinity) || st(b.id).count - st(a.id).count,
      alpha: (a, b) => a.shortName.localeCompare(b.shortName),
    };
    // Favorites first (in the order they were added), then by the chosen sort.
    return [...list].sort((a, b) => {
      const fa = favSet.has(a.id), fb = favSet.has(b.id);
      if (fa !== fb) return fa ? -1 : 1;
      if (fa && fb && sort === "recommended") return favorites.indexOf(a.id) - favorites.indexOf(b.id);
      return cmp[sort](a, b) || a.shortName.localeCompare(b.shortName);
    });
  }, [search, category, horizon, sort, favSet, favorites, notes, statsMap]);

  const kpis = useMemo(() => {
    const ranked = LIBRARY
      .map((i) => ({ i, s: statsMap[i.id] ?? EMPTY_STATS }))
      .filter((x) => x.s.count >= 3 && x.s.avgR != null)
      .sort((a, b) => (b.s.avgR ?? 0) - (a.s.avgR ?? 0));
    const used = LIBRARY.filter((i) => (statsMap[i.id]?.count ?? 0) > 0).length;
    return { best: ranked[0] ?? null, used };
  }, [statsMap]);

  const openIdx = openId ? filtered.findIndex((i) => i.id === openId) : -1;
  const openInd = openId ? LIB_BY_ID.get(openId) ?? null : null;
  const step = useCallback((dir: 1 | -1) => {
    if (!filtered.length) return;
    const cur = openId ? filtered.findIndex((i) => i.id === openId) : -1;
    const next = cur < 0 ? 0 : (cur + dir + filtered.length) % filtered.length;
    setOpenId(filtered[next].id);
  }, [filtered, openId]);
  const onPrev = useCallback(() => step(-1), [step]);
  const onNext = useCallback(() => step(1), [step]);
  const onClose = useCallback(() => {
    const id = openId;
    setOpenId(null);
    // Return focus to the card that opened the sheet.
    if (id) setTimeout(() => gridRef.current?.querySelector<HTMLButtonElement>(`[data-card-id="${id}"]`)?.focus(), 0);
  }, [openId]);

  // Arrow-key navigation across the card grid; F toggles favorite on the focused card.
  const onGridKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    const idxAttr = el.getAttribute("data-card-index");
    if (idxAttr == null) return;
    const idx = Number(idxAttr);
    const cards = Array.from(gridRef.current?.querySelectorAll<HTMLButtonElement>("[data-card-index]") ?? []);
    if (e.key === "f" || e.key === "F") {
      e.preventDefault();
      const id = el.getAttribute("data-card-id");
      if (id) toggleFavorite(id);
      return;
    }
    const top0 = cards[0]?.getBoundingClientRect().top ?? 0;
    const cols = Math.max(1, cards.filter((c) => Math.abs(c.getBoundingClientRect().top - top0) < 4).length);
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" ? cols : e.key === "ArrowUp" ? -cols : 0;
    if (!delta) return;
    const target = cards[Math.min(cards.length - 1, Math.max(0, idx + delta))];
    if (target) { e.preventDefault(); target.focus(); }
  };

  const applyPreset = useCallback((presetId: string) => {
    const p = DESK_PRESETS.find((x) => x.id === presetId);
    if (!p) return;
    const prev = favRef.current;
    const add = p.ids.filter((id) => !prev.includes(id));
    if (!add.length) return;
    commitFavorites([...prev, ...add]);
    toast({ title: indicatorsI18n.t("toast.addedToSet", { count: add.length }), description: p.label });
  }, [commitFavorites, toast]);

  const exportMd = useCallback(() => {
    downloadText(`indicators-set-${new Date().toISOString().slice(0, 10)}.md`, buildMarkdown(favorites, notes, statsMap), "text/markdown");
  }, [favorites, notes, statsMap]);
  const exportJson = useCallback(() => {
    const payload: SetExport = {
      version: 1,
      exportedAt: new Date().toISOString(),
      favorites,
      notes: Object.fromEntries(Object.entries(notes).filter(([k]) => favorites.includes(k))),
    };
    downloadText(`indicators-set-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2), "application/json");
  }, [favorites, notes]);
  const copySet = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(buildMarkdown(favorites, notes, statsMap));
      toast({ title: indicatorsI18n.t("toast.setCopied"), description: indicatorsI18n.t("toast.setCopiedHint") });
    } catch {
      toast({ title: commonI18n.t("states.copyFailed"), description: indicatorsI18n.t("toast.copyFailedHint"), variant: "destructive" });
    }
  }, [favorites, notes, statsMap, toast]);
  const importSet = useCallback(async (file: File) => {
    const data = file.size < 512_000 ? parseImport(await file.text()) : null;
    if (!data) {
      toast({ title: indicatorsI18n.t("toast.fileUnknown"), description: indicatorsI18n.t("toast.fileUnknownHint"), variant: "destructive" });
      return;
    }
    const prevFav = favRef.current;
    commitFavorites([...prevFav, ...data.favorites.filter((id) => !prevFav.includes(id))]);
    // Imported notes never overwrite existing ones.
    const nextNotes = { ...notesRef.current };
    let added = 0;
    for (const [k, v] of Object.entries(data.notes)) if (!nextNotes[k]) { nextNotes[k] = v; added++; }
    if (added) {
      notesRef.current = nextNotes; setNotes(nextNotes); saveNotes(nextNotes);
      const fresh: Record<string, string> = {};
      for (const [k, v] of Object.entries(data.notes)) if (nextNotes[k] === v) fresh[k] = v;
      void pushNotes(fresh, true).then(onServerResult);
    }
    const count = indicatorsI18n.t("toast.importedCount", { count: data.favorites.length });
    toast({
      title: indicatorsI18n.t("toast.imported"),
      description: added ? indicatorsI18n.t("toast.importedNotes", { indicators: count, notes: added }) : count,
    });
  }, [commitFavorites, toast, onServerResult]);

  const filtersActive = search.trim() !== "" || category !== "all" || horizon !== "all";
  const resetFilters = () => { setSearch(""); setCategory("all"); setHorizon("all"); };

  const categoryOptions = [
    { value: "all", label: t("library.all"), count: counts.all },
    { value: "favorites", label: t("library.mySet"), count: counts.favorites },
    ...CATEGORY_ORDER.map((c) => ({ value: c, label: CATEGORY_META[c].label, count: counts[c] ?? 0 })),
  ];
  const horizonOptions = [
    { value: "all", label: t("library.anyHorizon") },
    { value: "intraday", label: HORIZON_META.intraday.label },
    { value: "overnight", label: HORIZON_META.overnight.label },
    { value: "swing", label: HORIZON_META.swing.label },
  ];

  const best = kpis.best;
  const extraFilters = (horizon !== "all" ? 1 : 0) + (sort !== "recommended" ? 1 : 0);

  return (
    <>


      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
        <div className="flex min-w-0 flex-col gap-3">
          <Toolbar className="flex-col items-stretch gap-2 sm:p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-0 flex-1 basis-48">
                <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input
                  ref={searchRef}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") { e.preventDefault(); if (search) setSearch(""); else e.currentTarget.blur(); }
                    if (e.key === "ArrowDown" || e.key === "Enter") {
                      const first = gridRef.current?.querySelector<HTMLButtonElement>("[data-card-index]");
                      if (first) { e.preventDefault(); if (e.key === "Enter" && filtered.length === 1) setOpenId(filtered[0].id); else first.focus(); }
                    }
                  }}
                  placeholder={t("library.searchPlaceholder")}
                  aria-label={t("library.searchAria")}
                  className="pl-10 pr-16"
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
                  {search ? null : <Kbd>/</Kbd>}
                </span>
                {search && (
                  <button
                    type="button"
                    onClick={() => { setSearch(""); searchRef.current?.focus(); }}
                    aria-label={commonI18n.t("actions.clearSearch")}
                    className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
              {/* Row 1: search + filters + view; row 2: categories (the main column is too narrow for all in one line). */}
              <div className="order-last min-w-0 basis-full">
                <Segmented ariaLabel={t("library.categoriesAria")} value={category} onChange={setCategory} options={categoryOptions} size="sm" />
              </div>
              <div className="ml-auto flex items-center gap-2">
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" aria-label={extraFilters ? t("library.filtersActive", { count: extraFilters }) : t("library.filters")}>
                      <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                      {t("library.filters")}
                      {extraFilters > 0 && <span className="rounded-full bg-primary/15 px-1.5 text-xs tabular-nums text-accent-soft">{extraFilters}</span>}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="flex w-[22rem] flex-col gap-3">
                    <div className="flex flex-col gap-1.5">
                      <span className="text-xs font-medium text-muted-foreground">{t("library.holdHorizon")}</span>
                      <Segmented size="sm" ariaLabel={t("library.holdHorizon")} value={horizon} onChange={setHorizon} options={horizonOptions} />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <span className="text-xs font-medium text-muted-foreground">{t("sort.label")}</span>
                      <Select value={sort} onValueChange={(v) => { if (isSort(v)) setSort(v); }}>
                        <SelectTrigger className="h-9 w-full" aria-label={t("sort.label")}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SORT_KEYS.map((k) => <SelectItem key={k} value={k}>{t(`sort.${k}`)}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    {extraFilters > 0 && (
                      <Button variant="ghost" size="sm" className="self-start" onClick={() => { setHorizon("all"); setSort("recommended"); }}>{commonI18n.t("actions.reset")}</Button>
                    )}
                  </PopoverContent>
                </Popover>
                <Segmented
                  ariaLabel={t("library.viewAria")}
                  size="sm"
                  value={view}
                  onChange={setView}
                  options={[
                    { value: "cards", label: <><LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" /> {t("library.viewCards")}</> },
                    { value: "table", label: <><Rows3 className="h-3.5 w-3.5" aria-hidden="true" /> {t("library.viewTable")}</> },
                  ]}
                />
              </div>
            </div>
          </Toolbar>

          <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
            <span aria-live="polite">
              {filtered.length === LIBRARY.length ? t("library.countAll", { count: filtered.length }) : t("library.countFound", { count: filtered.length, total: LIBRARY.length })}
              {favorites.length > 0 && ` · ${t("library.setOnTop")}`}
              {horizon !== "all" && ` · ${t("library.fitsFor", { horizon: HORIZON_META[horizon].label.toLowerCase() })}`}
            </span>
            {(best || (!statsLoading && total > 0 && !!coverage)) && (
              <span className="tabular-nums">
                {best && (
                  <button type="button" onClick={() => setOpenId(best.i.id)} className="rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {t("library.bestByR")} <span className="font-medium text-foreground">{best.i.shortName}</span>{" "}
                    <span className={best.s.avgR! > 0 ? "text-up" : "text-down"}>{fmtR(best.s.avgR)}</span> · {commonI18n.t("units.tradesShort", { count: best.s.count })}
                  </button>
                )}
                {best && !!coverage && " · "}
                {!!coverage && total > 0 && t("library.coverage", { pct: coverage })}
              </span>
            )}
          </div>

          {filtered.length === 0 ? (
            <div className="glass-panel rounded-2xl">
              <EmptyState
                icon={category === "favorites" ? Layers : Search}
                title={category === "favorites" && favorites.length === 0 ? t("library.emptySetTitle") : t("library.emptyTitle")}
                description={
                  category === "favorites" && favorites.length === 0
                    ? t("library.emptySetText")
                    : t("library.emptyText")
                }
                action={filtersActive ? <Button variant="outline" size="sm" onClick={resetFilters}>{commonI18n.t("actions.resetFilters")}</Button> : undefined}
              />
            </div>
          ) : view === "table" ? (
            <EdgeTable
              items={filtered}
              stats={statsMap}
              statsLoading={statsLoading}
              favorites={favSet}
              notes={notes}
              query={search}
              onOpen={setOpenId}
            />
          ) : (
            <div
              ref={gridRef}
              onKeyDown={onGridKeyDown}
              className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-3"
              role="list"
              aria-label={t("library.listAria")}
            >
              {filtered.map((ind, i) => (
                <div key={ind.id} role="listitem">
                  <IndicatorCard
                    ind={ind}
                    index={i}
                    stats={statsMap[ind.id] ?? EMPTY_STATS}
                    statsLoading={statsLoading}
                    favorite={favSet.has(ind.id)}
                    hasNote={!!notes[ind.id]}
                    query={search}
                    horizon={horizon}
                    onOpen={setOpenId}
                    onToggleFavorite={toggleFavorite}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        <aside className="lg:sticky lg:top-[var(--sticky-top)]" aria-label={t("library.mySet")}>
          <MySetPanel
            ids={favorites}
            stats={statsMap}
            statsLoading={statsLoading}
            onOpen={setOpenId}
            onRemove={toggleFavorite}
            onApplyPreset={applyPreset}
            onExportMd={exportMd}
            onExportJson={exportJson}
            onCopy={copySet}
            onImport={importSet}
          />
        </aside>
      </div>

      <IndicatorSheet
        ind={openInd}
        stats={openId ? statsMap[openId] ?? EMPTY_STATS : EMPTY_STATS}
        statsLoading={statsLoading}
        favorite={openId ? favSet.has(openId) : false}
        note={openId ? notes[openId] ?? "" : ""}
        horizon={horizon}
        position={openIdx >= 0 ? { index: openIdx, total: filtered.length } : null}
        onClose={onClose}
        onPrev={onPrev}
        onNext={onNext}
        onOpen={setOpenId}
        onToggleFavorite={toggleFavorite}
        onSaveNote={saveNote}
        synced={syncMode === "server"}
      />
    </>
  );
}

type IndicatorsTab = "market" | "library";

export default function Indicators() {
  const { t } = indicatorsI18n.useT();
  const [tab, setTab] = usePersistentState<IndicatorsTab>("indicators.tab", "market");
  return (
    <Page>
      <PageHeader
        title={t("page.title")}
        icon={Compass}
        description={tab === "market" ? t("page.descMarket") : t("page.descLibrary")}
      />
      <SectionTabs
        ariaLabel={t("page.tabsAria")}
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "market", label: t("page.tabMarket"), icon: Activity },
          { value: "library", label: t("page.tabLibrary"), icon: BookOpen },
        ]}
      />
      {tab === "market" ? <MarketView /> : <IndicatorLibrary />}
    </Page>
  );
}
