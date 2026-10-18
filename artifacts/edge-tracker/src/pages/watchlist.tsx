import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import { Radar, Search, AlertTriangle, RefreshCw, Archive, Flame, Clock, History } from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { Button } from "@/components/ui/button";
import { ToastAction } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { ApiError, http } from "@/lib/api/http";
import { KEYS } from "@/lib/api/keys";
import { links } from "@/lib/links";
import { nyDate, prevWeekday } from "@/lib/trading-date";
import { cn } from "@/lib/utils";
import { EmptyState, Kbd, Page, PageHeader, Panel, TableSkeleton, usePersistentState, type SortDir } from "@/components/ds";
import {
  LISTS, LIST_LABELS, computePlan, copyText, isListName, isStaleToday, keyLevels, normStatus, readLS, writeLS, num,
  type ListName, type WatchlistItem,
} from "@/components/watchlist/lib";
import { useWatchlistLevels, useWatchlistMarket, sessionDays } from "@/components/watchlist/use-market";
import { useTickerHistory } from "@/components/watchlist/use-history";
import { AddTickerBar, type ActiveInfo } from "@/components/watchlist/AddTickerBar";
import { QuoteStatus } from "@/components/watchlist/bits";
import { WatchlistTable, SORT_DEFAULT_DIR, DRAG_MIME, sortValue, type Density, type SortKey, type WlRow } from "@/components/watchlist/WatchlistTable";
import type { RowActions } from "@/components/watchlist/WatchlistRow";
import { WatchlistDetailSheet } from "@/components/watchlist/WatchlistDetailSheet";
import { WatchlistFormDialog, blankForm, itemToForm, type WatchlistFormData } from "@/components/watchlist/WatchlistFormDialog";
import { IdeaFromWatchlistDialog } from "@/components/watchlist/IdeaFromWatchlistDialog";
import {
  DeleteTickersDialog, FILTERS, SelectionBar, WatchlistHeaderMenus, WatchlistSearch, WatchlistTabs, type Filter, type View,
} from "@/components/watchlist/WatchlistToolbar";
import { canModifyOwned } from "@/lib/ownership";
import { gpApi, gpKeys, type InPlayItem } from "@/components/game-plan/types";
import { docToDraft, draftToDoc } from "@/components/game-plan/plan-draft";
import { commonI18n } from "@/i18n/ns/common";
import { watchlistI18n } from "@/i18n/ns/watchlist";
import { fmtDate } from "@/lib/format";

const wt = watchlistI18n.t;

const LS_LISTS = "wl:lists";
const LS_PINS = "wl:pins";
const PLAN_MAX = 30;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
class DuplicateTickerError extends Error {
  constructor(message: string, public readonly id: number | null) { super(message); this.name = "DuplicateTickerError"; }
}
class NotDeployedError extends Error {}

/** POST /api/watchlist; 409 → DuplicateTickerError (the server sends the existing row id). */
async function createWatchRow(body: Record<string, unknown>, dupFallback: string): Promise<WatchlistItem> {
  try {
    return await http.post<WatchlistItem>("/api/watchlist", body);
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      const id = e.field<number>("id");
      throw new DuplicateTickerError(e.field<string>("error") ?? dupFallback, typeof id === "number" ? id : null);
    }
    throw e;
  }
}

function isTypingTarget(t: EventTarget | null) {
  const el = t instanceof HTMLElement ? t : null;
  if (!el) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || !!el.closest("[role=dialog],[role=menu],[role=listbox]");
}
function csvCell(v: unknown) {
  const s = v == null ? "" : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const round2 = (v: number) => Math.round(v * 100) / 100;
/** «AVGO, COIN, MSTR и ещё 3» */
const tickerList = (ts: string[], max = 6) => (ts.length <= max ? ts.join(", ") : wt("tickerList", { list: ts.slice(0, max).join(", "), count: ts.length - max }));

/** Run async jobs with limited concurrency (fallback adds: each old POST scores the ticker synchronously). */
async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = { status: "fulfilled", value: await fn(items[idx]) }; } catch (e) { out[idx] = { status: "rejected", reason: e }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export default function Watchlist() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t } = watchlistI18n.useT();
  const { canEdit, user, isCurator } = useAuth();
  const me = user && user.role !== "guest" ? user.traderName ?? null : null;
  /** Content edit / delete of a row: its author or staff (server: 403 NOT_OWNER otherwise). */
  const mayModify = (i: WatchlistItem) => canEdit && canModifyOwned(i.createdBy, me, isCurator);
  const [, navigate] = useLocation();
  const today = nyDate();
  // The session being prepared: today on weekdays, Monday on the weekend (same rule as «План дня»).
  const planDay = sessionDays(today).levelsDay;

  // ── persisted view state ─────────────────────────────────────────────
  const [view, setViewRaw] = usePersistentState<View>("watchlist.view", "today");
  const [sort, setSort] = usePersistentState<{ key: SortKey; dir: SortDir }>("watchlist.sort", { key: "change", dir: "desc" });
  const [density, setDensity] = usePersistentState<Density>("watchlist.density", "compact");
  const [intervalMs, setIntervalMs] = usePersistentState<number>("watchlist.quoteInterval", 60_000);
  const [addTarget, setAddTarget] = usePersistentState<ListName>("watchlist.addTarget", "today");
  const [localLists, setLocalLists] = useState<Record<string, ListName>>(() => readLS<Record<string, ListName>>(LS_LISTS, {}));
  useEffect(() => writeLS(LS_LISTS, localLists), [localLists]);
  const setView = useCallback((v: View) => {
    setViewRaw(v);
    if (isListName(v)) setAddTarget(v);
  }, [setViewRaw, setAddTarget]);
  const onSort = (k: SortKey) => setSort((s) => (s.key === k ? { key: k, dir: s.dir === "asc" ? "desc" : "asc" } : { key: k, dir: SORT_DEFAULT_DIR[k] }));

  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Set<Filter>>(() => new Set());
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [noteEditId, setNoteEditId] = useState<number | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<WatchlistItem | null>(null);
  const [formInitial, setFormInitial] = useState<WatchlistFormData>(() => blankForm());
  const [deleting, setDeleting] = useState<WatchlistItem[] | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [ideaFor, setIdeaFor] = useState<{ item: WatchlistItem; thenTrade: boolean } | null>(null);
  const [scoringIds, setScoringIds] = useState<Set<number>>(() => new Set());
  const [helpOpen, setHelpOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dropOver, setDropOver] = useState<View | null>(null);
  const [adding, setAdding] = useState(false);
  const [planBusy, setPlanBusy] = useState(false);
  const [prefill, setPrefill] = useState<{ value: string; nonce: number } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLInputElement>(null);

  // ── data ────────────────────────────────────────────────────────────
  const { data: rawItems, isLoading, isError, error, refetch, isFetching } = useQuery<WatchlistItem[]>({
    queryKey: KEYS.watchlist(),
    queryFn: ({ signal }) => http.get<WatchlistItem[]>("/api/watchlist", { signal }),
  });
  const items = useMemo<WatchlistItem[]>(
    () => (Array.isArray(rawItems) ? rawItems.map((i) => ({ ...i, status: normStatus(i.status) })) : []),
    [rawItems],
  );
  const realItems = useMemo(() => items.filter((i) => i.id > 0), [items]);
  // Server exposes working lists (list_name column) → use them; older builds → «Сегодня» = inPlay, the rest from localStorage.
  const serverLists = realItems.length > 0 && realItems.every((i) => isListName(i.list));
  const serverInPlay = realItems.length > 0 && realItems.every((i) => typeof i.inPlay === "boolean");
  const listOf = useCallback((i: WatchlistItem): ListName | null => {
    if (i.status === "passed") return null;
    if (isListName(i.list) && (serverLists || i.id < 0)) return i.list;
    if (i.inPlay) return "today";
    const o = localLists[i.ticker];
    return o && o !== "today" ? o : "watch";
  }, [serverLists, localLists]);

  const activeTickers = useMemo(() => items.filter((i) => listOf(i) != null).map((i) => i.ticker), [items, listOf]);
  const quoteTickers = useMemo(() => (view === "archive" || view === "all" ? items.map((i) => i.ticker) : activeTickers), [view, items, activeTickers]);
  const market = useWatchlistMarket(quoteTickers, intervalMs);
  const history = useTickerHistory(me);

  // Levels: tickers of the open list first (≤ 40 candle requests, 2 at a time, cached 5 min).
  const levelTickers = useMemo(() => {
    const inView = items.filter((i) => { const l = listOf(i); return view === "all" ? l != null : view === "archive" ? l == null : l === view; }).map((i) => i.ticker);
    return Array.from(new Set([...inView, ...activeTickers]));
  }, [items, listOf, view, activeTickers]);
  const levels = useWatchlistLevels(levelTickers, intervalMs > 0);
  const levelsLoading = levelTickers.some((t) => levels[t] === undefined);

  const allRows = useMemo<WlRow[]>(() => items.map((item) => {
    const q = market.quotes[item.ticker];
    const lv = levels[item.ticker];
    return {
      item,
      list: listOf(item),
      quote: q,
      plan: computePlan(item, q),
      levels: lv,
      keys: keyLevels(q?.price, lv ?? null, item, q?.atr ?? num(item.atr), true),
      history: history.map.get(item.ticker.toUpperCase()),
      earnings: market.earnings[item.ticker],
      upcoming: market.upcoming[item.ticker],
      news: market.news[item.ticker],
      pending: item.id < 0,
    };
  }), [items, market.quotes, market.earnings, market.upcoming, market.news, levels, listOf, history.map]);

  const counts = useMemo(() => {
    const c: Record<View, number> = { today: 0, swing: 0, watch: 0, all: 0, archive: 0 };
    for (const r of allRows) { if (r.list) { c[r.list]++; c.all++; } else c.archive++; }
    return c;
  }, [allRows]);

  // First load: if the remembered list is empty but others are not, open the first non-empty one (no empty screen on arrival).
  const initialViewChecked = useRef(false);
  useEffect(() => {
    if (initialViewChecked.current || isLoading || !rawItems) return;
    initialViewChecked.current = true;
    if (isListName(view) && counts[view] === 0 && counts.all > 0) {
      const first = LISTS.find((l) => counts[l] > 0);
      if (first) setView(first);
    }
  }, [isLoading, rawItems, view, counts, setView]);

  const inView = useMemo(() => allRows.filter((r) =>
    view === "all" ? r.list != null : view === "archive" ? r.list == null : r.list === view), [allRows, view]);

  const matchFilter = useCallback((r: WlRow, f: Filter): boolean => {
    const q = r.quote;
    switch (f) {
      case "events": {
        const soon = r.upcoming && r.upcoming.date >= today && r.upcoming.date <= addDaysIso(today, 2);
        return !!r.earnings || !!soon || (r.news?.count24h ?? 0) > 0;
      }
      case "gap": return q?.gapPct != null && Math.abs(q.gapPct) >= 3;
      case "rvol": return q?.relativeVolume != null && q.relativeVolume >= 1.5;
      case "level": {
        const k = r.keys[0];
        return !!k && (k.distAtr != null ? k.distAtr <= 0.25 : Math.abs(k.distPct) <= 0.5);
      }
    }
  }, [today]);
  const filterCounts = useMemo(() => {
    const c: Record<Filter, number> = { events: 0, gap: 0, rvol: 0, level: 0 };
    for (const r of inView) for (const f of FILTERS) if (matchFilter(r, f.key)) c[f.key]++;
    return c;
  }, [inView, matchFilter]);

  const visible = useMemo(() => {
    const s = query.trim().toLowerCase();
    let list = inView;
    if (filters.size) list = list.filter((r) => Array.from(filters).every((f) => matchFilter(r, f)));
    if (s) {
      list = list.filter((r) => [r.item.ticker, r.item.catalyst, r.item.notes, r.item.tags, r.item.sector, r.item.longName, r.quote?.name]
        .some((v) => v && v.toLowerCase().includes(s)));
    }
    const mul = sort.dir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      if (a.pending !== b.pending) return a.pending ? -1 : 1;
      const va = sortValue(a, sort.key); const vb = sortValue(b, sort.key);
      if (va == null && vb == null) return a.item.ticker.localeCompare(b.item.ticker);
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "string" || typeof vb === "string") return String(va).localeCompare(String(vb)) * mul;
      return (va - vb) * mul;
    });
  }, [inView, filters, query, sort, matchFilter]);

  // Drop selection / focus that left the view.
  useEffect(() => {
    const ids = new Set(visible.map((r) => r.item.id));
    setSelected((cur) => { const n = new Set(Array.from(cur).filter((id) => ids.has(id))); return n.size === cur.size ? cur : n; });
  }, [visible]);

  // ── mutations ───────────────────────────────────────────────────────
  const invalidate = useCallback(() => qc.invalidateQueries({ queryKey: KEYS.watchlist() }), [qc]);
  const patchCache = useCallback((fn: (i: WatchlistItem) => WatchlistItem) => {
    qc.setQueryData<WatchlistItem[]>(KEYS.watchlist(), (old) => old?.map(fn));
  }, [qc]);

  const bulk = useCallback(async (body: { ids: number[]; action: "status" | "delete" | "restore" | "inplay" | "list"; status?: string; inPlay?: boolean; list?: ListName }) => {
    try {
      return await http.post<{ count: number }>("/api/watchlist/bulk", body);
    } catch {
      // Older API builds (no /bulk or no «list» action): apply per item.
      const res = await Promise.allSettled(body.ids.map((id) =>
        body.action === "status" ? http.patch(`/api/watchlist/${id}`, { status: body.status })
          : body.action === "inplay" ? http.patch(`/api/watchlist/${id}`, { inPlay: body.inPlay })
          : body.action === "list" ? http.patch(`/api/watchlist/${id}`, { list: body.list })
          : body.action === "delete" ? http.del(`/api/watchlist/${id}`)
          : http.post(`/api/watchlist/${id}/restore`)));
      const count = res.filter((r) => r.status === "fulfilled").length;
      if (!count) throw new Error(wt("toast.actionFailed"));
      return { count };
    }
  }, []);

  /** Move rows between lists (server lists when available, else inPlay flag + local override). Returns the previous lists for undo. */
  const applyLists = useCallback(async (moves: { item: WatchlistItem; list: ListName }[]) => {
    if (!moves.length) return;
    const byList = new Map<ListName, WatchlistItem[]>();
    for (const m of moves) byList.set(m.list, [...(byList.get(m.list) ?? []), m.item]);
    patchCache((i) => {
      const m = moves.find((x) => x.item.id === i.id);
      return m ? { ...i, list: m.list, inPlay: m.list === "today", status: i.status === "passed" ? "watching" : i.status } : i;
    });
    if (!serverLists) {
      setLocalLists((cur) => {
        const n = { ...cur };
        for (const m of moves) { if (m.list === "watch") delete n[m.item.ticker]; else n[m.item.ticker] = m.list; }
        return n;
      });
    }
    try {
      const restore = moves.filter((m) => m.item.status === "passed").map((m) => m.item.id);
      if (restore.length) await bulk({ ids: restore, action: "status", status: "watching" });
      for (const [list, list_items] of byList) {
        const ids = list_items.map((i) => i.id);
        if (serverLists) await bulk({ ids, action: "list", list });
        else {
          const flip = list_items.filter((i) => !!i.inPlay !== (list === "today")).map((i) => i.id);
          if (flip.length && serverInPlay) await bulk({ ids: flip, action: "inplay", inPlay: list === "today" });
        }
      }
    } finally {
      invalidate();
    }
  }, [bulk, invalidate, patchCache, serverLists, serverInPlay]);

  const moveTo = useCallback(async (list_items: WatchlistItem[], list: ListName, opts: { silent?: boolean } = {}) => {
    const moving = list_items.filter((i) => i.id > 0 && listOf(i) !== list);
    if (!moving.length) return;
    const prev = moving.map((i) => ({ item: { ...i, list: listOf(i) ?? undefined, status: "watching" } as WatchlistItem, list: listOf(i) ?? "watch" }));
    try {
      await applyLists(moving.map((item) => ({ item, list })));
      if (!opts.silent) {
        const what = moving.length === 1 ? moving[0].ticker : commonI18n.t("units.tickers", { count: moving.length });
        toast({
          title: wt("toast.moved", { what, list: LIST_LABELS[list] }),
          action: <ToastAction altText={wt("toast.undoMove")} onClick={() => { void applyLists(prev.map((p) => ({ item: { ...p.item, list }, list: p.list }))); }}>{commonI18n.t("actions.undo")}</ToastAction>,
        });
      }
    } catch (e) {
      toast({ title: wt("toast.moveFailed"), description: errMsg(e), variant: "destructive" });
    }
  }, [applyLists, listOf, toast]);

  const archive = useCallback(async (list_items: WatchlistItem[]) => {
    const rows = list_items.filter((i) => i.id > 0 && i.status !== "passed");
    if (!rows.length) return;
    const prev = rows.map((i) => ({ item: i, list: listOf(i) ?? "watch" as ListName }));
    patchCache((i) => (rows.some((r) => r.id === i.id) ? { ...i, status: "passed", inPlay: false } : i));
    setSelected(new Set());
    if (openId != null && rows.some((r) => r.id === openId)) setOpenId(null);
    try {
      const ids = rows.map((i) => i.id);
      await bulk({ ids, action: "status", status: "passed" });
      const flagged = rows.filter((i) => i.inPlay).map((i) => i.id);
      if (flagged.length && serverInPlay) await bulk({ ids: flagged, action: "inplay", inPlay: false });
      toast({
        title: rows.length === 1 ? wt("toast.archivedOne", { ticker: rows[0].ticker }) : wt("toast.archivedMany", { count: rows.length }),
        action: <ToastAction altText={wt("toast.undoArchive")} onClick={() => { void applyLists(prev.map((p) => ({ item: { ...p.item, status: "passed" }, list: p.list }))); }}>{commonI18n.t("actions.undo")}</ToastAction>,
      });
    } catch (e) {
      toast({ title: wt("toast.archiveFailed"), description: errMsg(e), variant: "destructive" });
    } finally {
      invalidate();
    }
  }, [applyLists, bulk, invalidate, listOf, openId, patchCache, serverInPlay, toast]);

  const restore = useCallback((item: WatchlistItem, list: ListName = "watch") => {
    void applyLists([{ item, list }]).then(
      () => toast({ title: wt("toast.moved", { what: item.ticker, list: LIST_LABELS[list] }) }),
      (e) => toast({ title: wt("toast.restoreFailed"), description: errMsg(e), variant: "destructive" }),
    );
  }, [applyLists, toast]);

  const notePatch = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Record<string, unknown> }) => http.patch<WatchlistItem>(`/api/watchlist/${id}`, data),
    onMutate: async ({ id, data }) => {
      await qc.cancelQueries({ queryKey: KEYS.watchlist() });
      const prev = qc.getQueryData<WatchlistItem[]>(KEYS.watchlist());
      patchCache((i) => (i.id === id ? { ...i, ...data } as WatchlistItem : i));
      return { prev };
    },
    onError: (e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(KEYS.watchlist(), ctx.prev); toast({ title: wt("toast.noteFailed"), description: errMsg(e), variant: "destructive" }); },
    onSettled: invalidate,
  });

  /** Add one or many tickers to a list. Existing → moved, archived → restored, new → created (no score wait). */
  const addTickers = useCallback(async (tickers: string[], list: ListName): Promise<boolean> => {
    if (!tickers.length || adding) return false;
    const byTicker = new Map(realItems.map((i) => [i.ticker.toUpperCase(), i]));
    const existing = tickers.map((t) => byTicker.get(t)).filter((i): i is WatchlistItem => !!i);
    const fresh = tickers.filter((t) => !byTicker.has(t));
    if (tickers.length > 30) { toast({ title: wt("toast.max30"), variant: "destructive" }); return false; }
    setAdding(true);
    // Optimistic rows for the new tickers.
    const prev = qc.getQueryData<WatchlistItem[]>(KEYS.watchlist());
    const stamp = Date.now();
    if (fresh.length) {
      const temps: WatchlistItem[] = fresh.map((ticker, k) => ({
        id: -(stamp + k), ticker, catalyst: null, targetPrice: null, stopPrice: null, status: "watching", notes: null, sector: null, tags: null,
        createdAt: new Date().toISOString(), score: null, scoreBreakdown: null, scoredAt: null, inPlay: list === "today", list,
      }));
      qc.setQueryData<WatchlistItem[]>(KEYS.watchlist(), (old) => [...(old ?? []), ...temps]);
    }
    try {
      let createdCount = 0;
      try {
        const j = await http.post<{ created?: WatchlistItem[] }>("/api/watchlist/quick", { tickers, list }).catch((err: unknown) => {
          if (err instanceof ApiError && (err.status === 404 || err.status === 405)) throw new NotDeployedError();
          throw err;
        });
        createdCount = j.created?.length ?? 0;
        // A server without list support still accepted the rows: keep the local override.
        if (!serverLists && list !== "watch") setLocalLists((cur) => { const n = { ...cur }; for (const t of tickers) n[t] = list; return n; });
        if (!serverLists && existing.length) await moveTo(existing, list, { silent: true });
      } catch (e) {
        if (!(e instanceof NotDeployedError)) throw e;
        // Fallback for API builds without /quick: one POST per ticker (2 at a time) + move the existing ones.
        if (list !== "watch") setLocalLists((cur) => { const n = { ...cur }; for (const t of tickers) n[t] = list; return n; });
        const res = await pool(fresh, 2, async (ticker) => {
          return createWatchRow({ ticker, status: "watching", inPlay: list === "today", list }, wt("toast.duplicate", { ticker }));
        });
        createdCount = res.filter((x) => x.status === "fulfilled").length;
        const failed = res.map((x, k) => (x.status === "rejected" ? `${fresh[k]}: ${errMsg(x.reason)}` : null)).filter(Boolean);
        if (failed.length) toast({ title: wt("toast.notAdded", { count: failed.length }), description: failed.slice(0, 4).join("\n"), variant: "destructive" });
        if (existing.length) await moveTo(existing, list, { silent: true });
      }
      if (serverLists && existing.length) {
        // /quick already moved them on the server; mirror in the cache until the refetch lands.
        patchCache((i) => (existing.some((x) => x.id === i.id) ? { ...i, list, inPlay: list === "today", status: "watching" } : i));
      }
      const moved = existing.filter((i) => listOf(i) !== list);
      const parts = [
        createdCount ? wt("toast.addedN", { count: createdCount }) : null,
        moved.length ? wt("toast.movedN", { count: moved.length }) : null,
      ].filter(Boolean);
      toast({ title: wt("toast.addResult", { list: LIST_LABELS[list], parts: parts.join(", ") || wt("toast.alreadyInList") }), description: tickerList(tickers) });
      if (isListName(view) && view !== list) setView(list);
      return true;
    } catch (e) {
      if (prev) qc.setQueryData(KEYS.watchlist(), prev);
      toast({ title: wt("toast.addFailed"), description: errMsg(e), variant: "destructive" });
      return false;
    } finally {
      setAdding(false);
      void invalidate();
    }
  }, [adding, realItems, qc, toast, serverLists, moveTo, patchCache, listOf, view, setView, invalidate]);

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Record<string, unknown> }) => http.patch<WatchlistItem>(`/api/watchlist/${id}`, data),
    onSuccess: (row) => { void invalidate(); setFormOpen(false); toast({ title: wt("toast.saved", { ticker: row?.ticker ?? wt("toast.tickerWord") }) }); },
    onError: (e) => toast({ title: wt("toast.saveFailed"), description: errMsg(e), variant: "destructive" }),
  });
  const createMut = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      createWatchRow({ ...data, list: addTarget, inPlay: addTarget === "today" }, wt("toast.duplicateGeneric")),
    onSuccess: (row) => {
      if (!serverLists && addTarget !== "watch") setLocalLists((cur) => ({ ...cur, [row.ticker]: addTarget }));
      void invalidate(); setFormOpen(false);
      toast({ title: wt("toast.addedTo", { ticker: row?.ticker ?? wt("toast.tickerWord"), list: LIST_LABELS[addTarget] }) });
    },
    onError: (e) => {
      const dup = e instanceof DuplicateTickerError ? e : null;
      if (dup?.id) { setFormOpen(false); setOpenId(dup.id); toast({ title: dup.message, description: wt("toast.openedExisting") }); return; }
      toast({ title: wt("toast.addFailed"), description: errMsg(e), variant: "destructive" });
    },
  });

  const deleteItems = async (all_items: WatchlistItem[]) => {
    const list_items = all_items.filter(mayModify);
    const ids = list_items.filter((i) => i.id > 0).map((i) => i.id);
    if (!ids.length) return;
    const label = ids.length === 1 ? wt("toast.deletedOne", { ticker: list_items[0].ticker }) : wt("toast.deletedMany", { count: ids.length });
    const undo = async () => {
      try {
        if (ids.length === 1) await http.post(`/api/watchlist/${ids[0]}/restore`);
        else await bulk({ ids, action: "restore" });
        void invalidate();
        toast({ title: wt("toast.restored") });
      } catch (e) { toast({ title: wt("toast.restoreDeletedFailed"), description: errMsg(e), variant: "destructive" }); }
    };
    try {
      // Soft delete on the server (restorable).
      if (ids.length === 1) await http.del(`/api/watchlist/${ids[0]}`);
      else await bulk({ ids, action: "delete" });
      void invalidate();
      setDeleting(null);
      setSelected(new Set());
      if (openId != null && ids.includes(openId)) setOpenId(null);
      toast({ title: label, action: <ToastAction altText={wt("toast.undoDelete")} onClick={undo}>{commonI18n.t("actions.undo")}</ToastAction> });
    } catch (e) {
      toast({ title: wt("toast.deleteFailed"), description: errMsg(e), variant: "destructive" });
    }
  };

  const scoreMut = useMutation({
    mutationFn: (id: number) => http.post<{ row: WatchlistItem }>(`/api/watchlist/${id}/score`),
    onMutate: (id) => setScoringIds((cur) => new Set(cur).add(id)),
    onSettled: (_d, _e, id) => setScoringIds((cur) => { const n = new Set(cur); n.delete(id); return n; }),
    onSuccess: (data) => { void invalidate(); toast({ title: wt("toast.scoreResult", { ticker: data.row.ticker, score: data.row.score ?? "—" }) }); },
    onError: (e) => toast({ title: wt("toast.scoreFailed"), description: errMsg(e), variant: "destructive" }),
  });
  const scoreAllMut = useMutation({
    mutationFn: () => http.post<{ count: number; failed?: number; failures?: { ticker: string }[] }>("/api/watchlist/score-all"),
    onSuccess: (data) => {
      void invalidate();
      const failed = data.failed ?? 0;
      toast({
        title: wt("toast.rescored", { tickers: commonI18n.t("units.tickers", { count: data.count }) }),
        description: failed > 0 ? wt("toast.rescoreErrors", { count: failed, list: (data.failures ?? []).map((f) => f.ticker).join(", ") }) : undefined,
        variant: failed > 0 && data.count === 0 ? "destructive" : undefined,
      });
    },
    onError: (e) => toast({ title: wt("toast.rescoreFailed"), description: errMsg(e), variant: "destructive" }),
  });

  /** «В план дня»: append the ticker to «В игре» of my plan for today (levels from PDH/PDL/stop/target, note → plan). */
  const addToPlan = useCallback(async (item: WatchlistItem) => {
    if (!me) { toast({ title: wt("toast.planOwnerOnly"), variant: "destructive" }); return; }
    setPlanBusy(true);
    try {
      const date = planDay;
      const r = await gpApi.my(date);
      const doc = draftToDoc(docToDraft(r.plan?.doc));
      if (doc.inPlay.some((t) => t.ticker.toUpperCase() === item.ticker.toUpperCase())) {
        toast({ title: wt("toast.alreadyInPlan", { ticker: item.ticker }) });
        return;
      }
      if (doc.inPlay.length >= PLAN_MAX) { toast({ title: wt("toast.planFull", { count: PLAN_MAX }), variant: "destructive" }); return; }
      const q = market.quotes[item.ticker];
      const price = q?.price ?? null;
      const lv = levels[item.ticker];
      const plan = computePlan(item, q);
      const pts = [lv?.pdh, lv?.pdl, lv?.pmh, lv?.pml, plan.stop, plan.target].filter((v): v is number => v != null && v > 0);
      const support = price ? Array.from(new Set(pts.filter((p) => p < price).map(round2))).sort((a, b) => b - a).slice(0, 4) : [];
      const resistance = price ? Array.from(new Set(pts.filter((p) => p >= price).map(round2))).sort((a, b) => a - b).slice(0, 4) : [];
      const earn = market.earnings[item.ticker];
      const entry: InPlayItem = {
        ticker: item.ticker,
        catalyst: item.catalyst ?? (earn ? wt(earn.when === "recent" ? "toast.planCatalystEarnRecent" : "toast.planCatalystEarn", { call: earn.callType }) : ""),
        bias: plan.side === "long" ? "bull" : plan.side === "short" ? "bear" : "neutral",
        grade: null,
        levels: { support, resistance },
        plan: item.notes ?? "",
        horizon: listOf(item) === "swing" ? "swing" : "intraday",
        risk_note: plan.stop != null ? wt("toast.planStop", { price: plan.stop }) : "",
        trigger: "",
      };
      await gpApi.saveMy(date, { ...doc, inPlay: [...doc.inPlay, entry], status: r.plan?.status ?? "draft" });
      void qc.invalidateQueries({ queryKey: gpKeys.my(date) });
      toast({
        title: date === today ? wt("toast.addedToPlanToday", { ticker: item.ticker }) : wt("toast.addedToPlanOn", { ticker: item.ticker, date: fmtDate(date, "dayMonthNumeric") }),
        description: support.length || resistance.length ? wt("toast.planLevels", { levels: [...support, ...resistance].sort((a, b) => a - b).join(" · ") }) : undefined,
        action: <ToastAction altText={wt("toast.openPlan")} onClick={() => navigate(links.gamePlan(date))}>{commonI18n.t("actions.open")}</ToastAction>,
      });
    } catch (e) {
      toast({ title: wt("toast.planFailed"), description: errMsg(e), variant: "destructive" });
    } finally {
      setPlanBusy(false);
    }
  }, [me, planDay, today, market.quotes, market.earnings, levels, listOf, qc, toast, navigate]);

  // ── row actions (stable identity for memoised rows) ─────────────────
  const impl = useRef({ moveTo, archive, restore, addToPlan, scoreMutate: scoreMut.mutate, notePatch: notePatch.mutate, scoringIds });
  impl.current = { moveTo, archive, restore, addToPlan, scoreMutate: scoreMut.mutate, notePatch: notePatch.mutate, scoringIds };
  const actions = useMemo<RowActions>(() => ({
    open: (i) => { if (i.id > 0) { setOpenId(i.id); setFocusedId(i.id); } },
    moveTo: (list_items, l) => { void impl.current.moveTo(list_items, l); },
    archive: (list_items) => { void impl.current.archive(list_items); },
    restore: (i, l) => impl.current.restore(i, l),
    createIdea: (i, thenTrade = false) => setIdeaFor({ item: i, thenTrade }),
    addToPlan: (i) => { void impl.current.addToPlan(i); },
    saveNote: (i, notes) => impl.current.notePatch({ id: i.id, data: { notes: notes || null } }),
    rescore: (i) => { if (!impl.current.scoringIds.has(i.id)) impl.current.scoreMutate(i.id); },
    edit: (i) => { setFormInitial(itemToForm(i)); setEditing(i); setFormOpen(true); },
    remove: (list_items) => setDeleting(list_items),
  }), []);

  const copyTickers = useCallback(async (ts: string[]) => {
    if (!ts.length) return;
    const ok = await copyText(ts.join(", "));
    toast(ok
      ? { title: wt("toast.copiedTickers", { tickers: commonI18n.t("units.tickers", { count: ts.length }) }), description: tickerList(ts) }
      : { title: commonI18n.t("states.copyFailed"), description: wt("toast.clipboardDenied"), variant: "destructive" });
  }, [toast]);

  const exportCsv = () => {
    const head = [t("csv.ticker"), t("csv.list"), t("csv.price"), t("csv.change"), t("csv.gap"), "rVol", "ATR", t("csv.nearest"), t("csv.levelPrice"), t("csv.toLevel"), t("csv.myTrades"), "Net $", "WR %", t("csv.stop"), t("csv.target"), t("csv.catalyst"), t("csv.note"), t("csv.tags")];
    const rowsCsv = visible.map((r) => {
      const q = r.quote; const k = r.keys[0]; const h = r.history;
      return [r.item.ticker, r.list ? LIST_LABELS[r.list] : t("list.archive"), q?.price ?? "", q?.change ?? "", q?.gapPct ?? "", q?.relativeVolume ?? "", q?.atr ?? "",
        k?.label ?? "", k?.price ?? "", k ? k.distPct.toFixed(2) : "", h?.n ?? "", h ? h.net.toFixed(2) : "", h?.wr != null ? Math.round(h.wr * 100) : "",
        r.item.stopPrice ?? "", r.item.targetPrice ?? "", r.item.catalyst ?? "", r.item.notes ?? "", r.item.tags ?? ""];
    });
    const csv = "﻿" + [head, ...rowsCsv].map((r) => r.map(csvCell).join(";")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `watchlist-${today}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // ── keyboard ────────────────────────────────────────────────────────
  const kb = useRef({ visible, focusedId, selected, canEdit, actions, copyTickers });
  kb.current = { visible, focusedId, selected, canEdit, actions, copyTickers };
  const blocked = formOpen || openId != null || !!ideaFor || !!deleting;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) {
        if (e.key === "Escape" && e.target === searchRef.current) { setQuery(""); searchRef.current?.blur(); }
        if (e.key === "ArrowDown" && e.target === searchRef.current) { e.preventDefault(); searchRef.current?.blur(); const f = kb.current.visible[0]; if (f) setFocusedId(f.item.id); }
        return;
      }
      if (blocked) return;
      const { visible: list, focusedId: fid, selected: sel, canEdit: edit, actions: act, copyTickers: copy } = kb.current;
      const idx = list.findIndex((r) => r.item.id === fid);
      const cur = idx >= 0 ? list[idx] : null;
      const targets = () => (sel.size ? list.filter((r) => sel.has(r.item.id)) : cur ? [cur] : []).map((r) => r.item);
      const code = e.code;
      // By physical key too, so «/» and «?» work in the Russian layout.
      if (e.key === "?" || (code === "Slash" && e.shiftKey)) { e.preventDefault(); setHelpOpen((v) => !v); return; }
      if (e.key === "/" || code === "Slash") { e.preventDefault(); searchRef.current?.focus(); return; }
      if ((code === "KeyA" || code === "KeyN") && edit) { e.preventDefault(); addRef.current?.focus(); return; }
      if (code === "KeyJ" || code === "KeyK" || e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!list.length) return;
        e.preventDefault();
        const down = code === "KeyJ" || e.key === "ArrowDown";
        const next = idx < 0 ? 0 : Math.max(0, Math.min(list.length - 1, idx + (down ? 1 : -1)));
        setFocusedId(list[next].item.id);
        return;
      }
      if (code === "KeyR") { e.preventDefault(); market.refetchQuotes(); return; }
      if (code === "KeyD") { e.preventDefault(); setDensity((d) => (d === "compact" ? "comfortable" : "compact")); return; }
      if (code === "KeyC") {
        e.preventDefault();
        const rows = sel.size ? list.filter((r) => sel.has(r.item.id)) : list;
        void copy(rows.filter((r) => !r.pending).map((r) => r.item.ticker));
        return;
      }
      if (e.key === "Escape") { if (sel.size) setSelected(new Set()); else setFocusedId(null); return; }
      if (!cur) return;
      if (e.key === "Enter") { e.preventDefault(); act.open(cur.item); return; }
      if (!edit || cur.pending) return;
      if (code === "KeyE") { e.preventDefault(); setNoteEditId(cur.item.id); return; }
      if (code === "KeyX" || e.key === " ") {
        e.preventDefault();
        setSelected((s) => { const n = new Set(s); if (n.has(cur.item.id)) n.delete(cur.item.id); else n.add(cur.item.id); return n; });
        return;
      }
      if (e.key === "1" || e.key === "2" || e.key === "3") {
        e.preventDefault();
        act.moveTo(targets(), LISTS[Number(e.key) - 1]);
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        const t = targets().filter((i) => i.status !== "passed");
        if (!t.length) return;
        // Keep the cursor on the neighbour row.
        const nextRow = list[idx + 1] ?? list[idx - 1];
        act.archive(t);
        setFocusedId(nextRow && !t.some((i) => i.id === nextRow.item.id) ? nextRow.item.id : null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [blocked, market, setDensity]);

  // ── migrations (old local state → shared server fields) ─────────────
  const migrating = useRef(false);
  useEffect(() => {
    if (migrating.current || !realItems.length) return;
    const pins = readLS<string[]>(LS_PINS, []);
    // 1) Pre-inPlay builds kept «В игре» pins locally.
    if (serverInPlay && pins.length) {
      const ids = realItems.filter((i) => pins.includes(i.ticker) && !i.inPlay && i.status !== "passed").map((i) => i.id);
      migrating.current = true;
      (ids.length ? bulk({ ids, action: "inplay", inPlay: true }) : Promise.resolve({ count: 0 }))
        .then(() => { writeLS(LS_PINS, []); void invalidate(); })
        .catch(() => { /* retry next load */ })
        .finally(() => { migrating.current = false; });
      return;
    }
    // 2) Local «Свинги» overrides → server lists once the API exposes them.
    const swing = Object.entries(localLists).filter(([, l]) => l === "swing").map(([t]) => t);
    if (serverLists && Object.keys(localLists).length) {
      const ids = realItems.filter((i) => swing.includes(i.ticker) && i.list === "watch" && i.status !== "passed").map((i) => i.id);
      migrating.current = true;
      (ids.length ? bulk({ ids, action: "list", list: "swing" }) : Promise.resolve({ count: 0 }))
        .then((r) => {
          setLocalLists({});
          void invalidate();
          if (r.count) toast({ title: wt("toast.migrated", { count: r.count }) });
        })
        .catch(() => { /* keep local overrides; retry next load */ })
        .finally(() => { migrating.current = false; });
    }
  }, [realItems, serverInPlay, serverLists, localLists, bulk, invalidate, toast]);

  // Deep link: /watchlist?ticker=XYZ → open the card (switching to its list), or prefill the add input.
  const search = useSearch();
  const deepLinkHandled = useRef<string | null>(null);
  useEffect(() => {
    if (isLoading || isError) return;
    let ticker = "";
    try { ticker = (new URLSearchParams(search).get("ticker") ?? "").trim().toUpperCase(); } catch { /* ignore */ }
    if (!ticker || deepLinkHandled.current === search) return;
    deepLinkHandled.current = search;
    const hit = allRows.find((r) => r.item.ticker.toUpperCase() === ticker);
    if (hit) {
      const v: View = hit.list ?? "archive";
      if (view !== "all" || !hit.list) setViewRaw(v);
      setFilters(new Set());
      setQuery("");
      setFocusedId(hit.item.id);
      setOpenId(hit.item.id);
    } else if (canEdit) {
      setPrefill({ value: ticker, nonce: Date.now() });
    } else {
      toast({ title: wt("toast.notInWatchlist", { ticker }) });
    }
    try {
      const params = new URLSearchParams(window.location.search);
      params.delete("ticker");
      const qs = params.toString();
      window.history.replaceState(window.history.state, "", window.location.pathname + (qs ? `?${qs}` : ""));
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, isLoading, isError, allRows]);

  // ── derived UI bits ─────────────────────────────────────────────────
  const openRow = openId != null ? allRows.find((r) => r.item.id === openId) ?? null : null;
  const selectedItems = useMemo(() => visible.filter((r) => selected.has(r.item.id)).map((r) => r.item), [visible, selected]);
  const activeInfo = useMemo(() => {
    const m = new Map<string, ActiveInfo>();
    for (const r of allRows) if (r.item.id > 0) m.set(r.item.ticker.toUpperCase(), { id: r.item.id, list: r.list, archived: r.list == null });
    return m;
  }, [allRows]);
  const archivedTickers = useMemo(() => allRows.filter((r) => r.list == null).map((r) => r.item.ticker.toUpperCase()), [allRows]);
  const existingTickers = useMemo(() => new Set(realItems.map((i) => i.ticker)), [realItems]);
  // «Сегодня» left over from earlier sessions (moved in before the previous session's close).
  const prevSession = prevWeekday(planDay);
  const [staleDismissed, setStaleDismissed] = usePersistentState<string>("watchlist.staleDismissed", "");
  const staleToday = useMemo(
    () => (view === "today" ? inView.filter((r) => !r.pending && isStaleToday(r.item.inPlayAt, prevSession)).map((r) => r.item) : []),
    [view, inView, prevSession],
  );
  const losingInView = useMemo(() => inView.filter((r) => r.history && r.history.net < 0 && r.history.n >= 2), [inView]);
  const filtersActive = !!query.trim() || filters.size > 0;
  const days = sessionDays(today);

  const onDropTo = (target: View) => (e: React.DragEvent) => {
    e.preventDefault();
    setDropOver(null);
    setDragging(false);
    let ids: number[] = [];
    try { ids = JSON.parse(e.dataTransfer.getData(DRAG_MIME) || "[]") as number[]; } catch { /* ignore */ }
    const list_items = realItems.filter((i) => ids.includes(i.id));
    if (!list_items.length) return;
    if (target === "archive") void archive(list_items);
    else if (isListName(target)) void moveTo(list_items, target);
    setSelected(new Set());
  };

  return (
    <Page>
      <PageHeader
        title={t("page.title")}
        icon={Radar}
        description={days.weekend ? t("page.descWeekend", { date: fmtDate(days.levelsDay, "dayMonthNumeric") }) : t("page.desc")}
        actions={
          <>
            <QuoteStatus
              updatedAt={market.quotesUpdatedAt}
              fetching={market.quotesFetching}
              error={market.quotesError}
              interval={intervalMs}
              onInterval={setIntervalMs}
              onRefresh={market.refetchQuotes}
            />
            <WatchlistHeaderMenus
              helpOpen={helpOpen}
              onHelpOpen={setHelpOpen}
              canEdit={canEdit}
              canExport={visible.length > 0}
              onExport={exportCsv}
              copyCount={visible.filter((r) => !r.pending).length}
              onCopy={() => void copyTickers(visible.filter((r) => !r.pending).map((r) => r.item.ticker))}
              onAddDetailed={() => { setFormInitial(blankForm()); setEditing(null); setFormOpen(true); }}
              canScoreAll={realItems.length > 0}
              scoringAll={scoreAllMut.isPending}
              onScoreAll={() => scoreAllMut.mutate()}
            />
          </>
        }
      />

      <WatchlistTabs
        view={view}
        onView={setView}
        counts={counts}
        canEdit={canEdit}
        dragging={dragging}
        dropOver={dropOver}
        onDropOver={setDropOver}
        onDropTo={onDropTo}
        losing={me && view !== "archive" ? losingInView.map((r) => [r.item.ticker, r.history?.net ?? 0] as [string, number]) : []}
        density={density}
        onToggleDensity={() => setDensity((d) => (d === "compact" ? "comfortable" : "compact"))}
      />

      {/* Add · search · filters */}
      <div className="flex flex-wrap items-center gap-2">
        {canEdit && (
          <AddTickerBar
            inputRef={addRef}
            active={activeInfo}
            history={history.map}
            archived={archivedTickers}
            target={addTarget}
            onTargetChange={setAddTarget}
            onAdd={addTickers}
            busy={adding}
            prefill={prefill}
          />
        )}
        {/* Search + chips wrap as one group (no lone chip on a second line). */}
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
          <WatchlistSearch
            inputRef={searchRef}
            query={query}
            onQuery={setQuery}
            filters={filters}
            onToggleFilter={(f) => setFilters((cur) => { const n = new Set(cur); if (n.has(f)) n.delete(f); else n.add(f); return n; })}
            filterCounts={filterCounts}
          />
        </div>
      </div>

      {canEdit && selectedItems.length > 0 && (
        <SelectionBar
          items={selectedItems}
          view={view}
          mayModify={mayModify}
          onRestore={(l) => { void applyLists(selectedItems.map((item) => ({ item, list: l }))); setSelected(new Set()); }}
          onMove={(l) => { void moveTo(selectedItems, l); setSelected(new Set()); }}
          onArchive={() => void archive(selectedItems)}
          onDelete={setDeleting}
          onCopy={() => void copyTickers(selectedItems.map((i) => i.ticker))}
          onClear={() => setSelected(new Set())}
        />
      )}

      {canEdit && staleToday.length > 0 && staleDismissed !== prevSession && (
        <div role="note" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl bg-[var(--glass-bg)] px-3 py-2 text-sm">
          <History className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-muted-foreground">
            {t("stale.text", { tickers: commonI18n.t("units.tickers", { count: staleToday.length }), list: tickerList(staleToday.map((i) => i.ticker), 8) })}
          </span>
          <Button size="sm" variant="outline" onClick={() => void moveTo(staleToday, "watch")}>{t("stale.toWatch")}</Button>
          <Button size="sm" variant="outline" onClick={() => void archive(staleToday)}><Archive className="h-4 w-4" />{t("stale.toArchive")}</Button>
          <Button size="sm" variant="ghost" onClick={() => setStaleDismissed(prevSession)} title={t("stale.keepTitle")}>{t("stale.keep")}</Button>
        </div>
      )}

      <Panel padded={false}>
        {isLoading && <div className="p-[var(--panel-p)]"><TableSkeleton rows={6} /></div>}

        {isError && (
          <EmptyState
            icon={AlertTriangle}
            title={t("empty.loadFailed")}
            description={errMsg(error)}
            action={<Button variant="outline" onClick={() => refetch()} disabled={isFetching}><RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin motion-reduce:animate-none")} />{commonI18n.t("actions.retry")}</Button>}
          />
        )}

        {!isLoading && !isError && visible.length > 0 && (
          <WatchlistTable
            rows={visible}
            showList={view === "all"}
            density={density}
            sort={sort}
            onSort={onSort}
            selected={selected}
            onSelect={(id, v) => setSelected((cur) => { const n = new Set(cur); if (v) n.add(id); else n.delete(id); return n; })}
            onSelectAll={(v) => setSelected(v ? new Set(visible.filter((r) => !r.pending).map((r) => r.item.id)) : new Set())}
            focusedId={focusedId}
            onFocusRow={setFocusedId}
            noteEditId={noteEditId}
            onNoteEdit={setNoteEditId}
            canEdit={canEdit}
            me={me}
            actions={actions}
            scoringIds={scoringIds}
            quotesLoading={market.quotesLoading}
            levelsLoading={levelsLoading}
            today={today}
            onDragState={(d) => { setDragging(d); if (!d) setDropOver(null); }}
          />
        )}

        {!isLoading && !isError && visible.length === 0 && (
          filtersActive && inView.length > 0 ? (
            <EmptyState
              icon={Search}
              title={commonI18n.t("states.nothingFound")}
              description={t("empty.noMatch")}
              action={<Button variant="outline" onClick={() => { setQuery(""); setFilters(new Set()); }}>{commonI18n.t("actions.resetFilters")}</Button>}
            />
          ) : view === "archive" ? (
            <EmptyState icon={Archive} title={t("empty.archiveTitle")} description={t("empty.archiveText")} compact />
          ) : (
            <EmptyState
              icon={view === "today" ? Flame : view === "swing" ? Clock : Radar}
              title={view === "all" ? t("empty.allTitle") : t("empty.listTitle", { list: LIST_LABELS[view as ListName] })}
              description={canEdit
                ? t(view === "today" ? "empty.addHintToday" : view === "swing" ? "empty.addHintSwing" : "empty.addHint")
                : t("empty.readOnly")}
              action={canEdit ? <Button className="bg-primary-solid" onClick={() => addRef.current?.focus()}>{t("empty.addTickers")} <Kbd className="ml-1">A</Kbd></Button> : undefined}
            />
          )
        )}
      </Panel>

      <WatchlistDetailSheet
        row={openRow}
        me={me}
        canEdit={canEdit}
        scoring={openRow ? scoringIds.has(openRow.item.id) : false}
        actions={actions}
        onClose={() => setOpenId(null)}
        planBusy={planBusy}
        planDay={planDay}
      />

      <WatchlistFormDialog
        open={formOpen}
        editing={editing}
        initial={formInitial}
        existingTickers={existingTickers}
        saving={createMut.isPending || updateMut.isPending}
        // `editing` stays until the next open, so the closing dialog doesn't flip to «Добавить» / «Уже есть в вотчлисте».
        onClose={() => setFormOpen(false)}
        onSubmit={(payload) => (editing ? updateMut.mutate({ id: editing.id, data: payload }) : createMut.mutate(payload))}
      />

      <IdeaFromWatchlistDialog
        item={ideaFor?.item ?? null}
        quote={ideaFor ? market.quotes[ideaFor.item.ticker] : undefined}
        thenTrade={ideaFor?.thenTrade ?? false}
        onClose={() => setIdeaFor(null)}
      />

      <DeleteTickersDialog
        items={deleting}
        busy={deletingBusy}
        onCancel={() => setDeleting(null)}
        onConfirm={async (list) => { setDeletingBusy(true); await deleteItems(list); setDeletingBusy(false); }}
      />
    </Page>
  );
}

function addDaysIso(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
