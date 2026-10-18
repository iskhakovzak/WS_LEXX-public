// /trades — a REVIEW tool, not a data-entry form. Trades arrive automatically from the broker; the trader's job
// here is to look back: by trading day (default) or through smart presets, tag setup / mistake / emotion with the
// keyboard, and jump to the day report, behaviour patterns or the trade card.
// Trades come only from PropReports (ARCHITECTURE §0.1): nothing is created here. The form edits the trader's markup
// (stop, setup, tags, review); old ?new / ?fromIdea links just open the list (filtered by ?ticker when given).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useUpdateTrade, getTrade } from "@workspace/api-client-react";
import type { Trade, UpdateTradeBody } from "@workspace/api-client-react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { BookText, CheckCircle2, Download, Filter, Keyboard, Loader2 } from "lucide-react";
import { EmptyState, Kbd, Page, PageHeader, Panel } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { QueryError } from "@/components/query-error";
import { UndoToast } from "@/components/undo-toast";
import { useAuth } from "@/contexts/auth-context";
import { useToast } from "@/hooks/use-toast";
import { useHolidaysRange, type HolidayEvent } from "@/lib/market-intel";
import { invalidateTradeDependents } from "@/lib/query-keys";
import { ENTRY_DECISION_FIELDS, HORIZONS, HORIZON_LABEL, RESULT_LABEL, advancedFilterCount, apiErrorMessage, blankForm, dayOf, downloadCsv, formToBody, isBrokerTrade, isDefaultFilters, isTypingTarget, resultKey, tradeToForm, type FormData, type Outcome } from "@/components/trades/trade-utils";
import { useTradeFilters } from "@/components/trades/use-trade-filters";
import { useTradesPage, useTradeDays, dayTradesQuery, patchTradeInPages } from "@/hooks/use-trades-page";
import { TradeFilterBar } from "@/components/trades/TradeFilterBar";
import { TradePagination } from "@/components/trades/TradePagination";
import { TradeDetailSheet, type TradePatch } from "@/components/trades/TradeDetailSheet";
import { TradeFormDialog, formSaveError } from "@/components/trades/TradeFormDialog";
import { useTradesQuality } from "@/components/replay/hooks";
import { useAfterExitMinutes } from "@/components/replay/QualityBlock";
import { BulkActionBar } from "@/components/trades/BulkActionBar";
import { AddTradesToPlaybookDialog } from "@/components/playbook/quick-add";
import { AddToPlaybookDialog } from "@/components/add-to-playbook";
import { tradePlaybookPayload } from "@/components/trades/trade-utils";
import { bulkTrades, type BulkBody } from "@/components/trades/bulk-api";
import { PRESET_META, hasTag, tagLabel, toggleTag, type Preset, type TagKind } from "@/components/trades/review-presets";
import type { PickerTarget, PickState } from "@/components/trades/review-tagging";
import { DayCard, PresetBar, ReviewKpis, ReviewTradeRow, RowsHeader, RowsSkeleton } from "@/components/trades/review-list";
import { commonI18n } from "@/i18n/ns/common";
import { tradesI18n } from "@/i18n/ns/trades";
import { shellI18n } from "@/i18n/ns/shell";

/** Built in render: labels follow the UI language. */
function shortcuts(): [string, string][] {
  const t = tradesI18n.t, tc = commonI18n.t;
  return [
    ["J / K", t("page.shortcuts.next")],
    ["Enter", t("page.shortcuts.open")],
    ["S", t("tagging.kind.setup.label")],
    ["M", t("tagging.kind.mistake.label")],
    ["E", t("tagging.kind.emotion.label")],
    ["1–9", t("page.shortcuts.pick")],
    ["X", t("page.shortcuts.select")],
    ["/", tc("actions.search")],
    ["← / →", t("page.shortcuts.page")],
    ["Esc", t("page.shortcuts.clear")],
    ["?", t("page.shortcuts.help")],
  ];
}

const EMPTY_OUTCOMES: Record<Outcome, number> = { all: 0, win: 0, loss: 0, breakeven: 0, open: 0 };
const DAYS_PAGE = 30;
/** Min width of the ROW_GRID rows (sum of its fixed tracks + gaps + padding). */
const ROWS_MIN_W = "min-w-[900px]";
// Keys, not text: the same physical keys on a Russian layout. i18n-ignore
const KEY_KIND: Record<string, TagKind> = { s: "setup", "ы": "setup", m: "mistake", "ь": "mistake", e: "emotion", "у": "emotion" };

/** Strip a one-shot param (?highlight, ?new, ?fromIdea) without touching the filter state in the URL. */
function stripParam(name: string) {
  const params = new URLSearchParams(window.location.search);
  if (!params.has(name)) return;
  params.delete(name);
  const qs = params.toString();
  window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : ""));
}

export default function Trades() {
  const { t: tt } = tradesI18n.useT();
  const { t: tc } = commonI18n.useT();
  const qc = useQueryClient();
  const { user, dbUsers, canEdit } = useAuth();
  const { toast } = useToast();
  const [location] = useLocation();
  const traderNames = dbUsers.filter((u) => u.active).map((u) => u.name);
  const me = user && user.role !== "guest" ? user.traderName : null;
  const isStaff = useMemo(
    () => user?.role === "curator" || user?.role === "admin" || dbUsers.some((u) => u.name === user?.traderName && u.role === "curator"),
    [dbUsers, user?.traderName, user?.role],
  );
  // Mirrors the API: traders may only change their own trades; curators/admins any.
  const canEditTrade = useCallback(
    (t: Trade) => canEdit && (user?.role !== "trader" || !t.trader || t.trader === me),
    [canEdit, user?.role, me],
  );
  /** Broker numbers are read-only for traders: the full form / result / delete stay for manual trades or staff. */
  const canEditForm = useCallback((t: Trade) => canEditTrade(t) && (isStaff || !isBrokerTrade(t)), [canEditTrade, isStaff]);

  const F = useTradeFilters();
  const { filters, sort, page, pageSize, preset, view } = F;
  const listMode = !!preset || view === "list";
  const searchRef = useRef<HTMLInputElement | null>(null);

  // ── Data ────────────────────────────────────────────────────────────────
  const [afterExit] = useAfterExitMinutes();
  const [qualityIds, setQualityIds] = useState<number[]>([]);
  const { quality, pending: qualityPending } = useTradesQuality(qualityIds, { afterExit });
  const pendingSet = useMemo(() => new Set(qualityPending), [qualityPending]);

  // Summary + facets always; rows only in list mode (the day view loads trades per expanded day).
  const P = useTradesPage({
    filters,
    sort: listMode ? sort : { col: "date", dir: "desc" },
    page: listMode ? page : 1,
    pageSize: listMode ? pageSize : 1,
    quality,
    preset,
  });
  const D = useTradeDays(filters, { limit: DAYS_PAGE });
  const summary = P.summary;
  const facets = P.facets;
  const total = summary?.total ?? 0;
  const setupOptions = useMemo(() => (facets?.setups ?? []).map((s) => s.name), [facets?.setups]);
  const distinctTraders = facets?.traders ?? [];
  const showTrader = distinctTraders.length > 1 && !filters.trader;
  const traderForLinks = filters.trader || (distinctTraders.length === 1 ? distinctTraders[0] : null) || me;

  // ── Day view: expanded days and their trades ───────────────────────────
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const expandKeyRef = useRef<string | null>(null);
  const filtersKey = JSON.stringify(filters);
  useEffect(() => {
    // Newest day open by default (again after the filters change).
    if (!D.days.length || expandKeyRef.current === filtersKey) return;
    expandKeyRef.current = filtersKey;
    setExpanded(new Set([D.days[0].date]));
  }, [D.days, filtersKey]);
  const toggleDay = useCallback((date: string) => {
    setExpanded((prev) => { const n = new Set(prev); if (n.has(date)) n.delete(date); else n.add(date); return n; });
  }, []);

  const expandedDates = useMemo(() => D.days.filter((d) => expanded.has(d.date)).map((d) => d.date), [D.days, expanded]);
  const dayQs = useQueries({
    queries: expandedDates.map((date) => dayTradesQuery(filters, date, !listMode && !D.listByDay)),
  });
  const dayRows = useCallback((date: string): Trade[] | undefined => {
    if (D.listByDay) return D.listByDay.get(date) ?? [];
    const i = expandedDates.indexOf(date);
    return i >= 0 ? dayQs[i]?.data : undefined;
  }, [D.listByDay, expandedDates, dayQs]);

  const visibleRows: Trade[] = useMemo(() => {
    if (listMode) return P.items;
    const out: Trade[] = [];
    for (const d of expandedDates) out.push(...(dayRows(d) ?? []));
    return out;
  }, [listMode, P.items, expandedDates, dayRows]);
  const rowsRef = useRef(visibleRows);
  rowsRef.current = visibleRows;

  useEffect(() => {
    const ids = visibleRows.slice(0, 400).map((t) => t.id);
    setQualityIds((prev) => (prev.length === ids.length && prev.every((v, i) => v === ids[i]) ? prev : ids));
  }, [visibleRows]);

  // A page beyond the end (filters narrowed, rows deleted) snaps back to the last one.
  useEffect(() => {
    if (!listMode || !summary || P.isPlaceholder) return;
    if (page > 1 && P.items.length === 0 && summary.total > 0) F.setPage(Math.max(1, Math.ceil(summary.total / pageSize)));
  }, [summary, P.items.length, page, pageSize, P.isPlaceholder, listMode]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Cumulative net by day, oldest → newest (spark on the net KPI). */
  const dayCurve = useMemo(() => {
    let c = 0;
    return [...D.days].reverse().map((d) => (c += d.net ?? 0));
  }, [D.days]);

  const scopeLabel = useMemo(() => {
    const parts: string[] = [tradesI18n.t(`page.scope.${filters.period}`)];
    if (filters.outcome !== "all") parts.push(filters.outcome === "open" ? tradesI18n.t("page.openPositions") : RESULT_LABEL[filters.outcome].toLowerCase());
    if (filters.horizon) parts.push(HORIZON_LABEL[filters.horizon].toLowerCase());
    if (filters.side) parts.push(filters.side === "Long" ? commonI18n.t("trading.long") : filters.side === "Short" ? commonI18n.t("trading.short") : filters.side);
    if (filters.setup) parts.push(filters.setup);
    if (filters.ticker) parts.push(filters.ticker);
    const adv = advancedFilterCount(filters) - (filters.period === "custom" ? 1 : 0) - (filters.ticker ? 1 : 0);
    if (adv > 0) parts.push(tradesI18n.t("page.moreFilters", { count: adv }));
    if (filters.q.trim()) parts.push(`«${filters.q.trim()}»`);
    return parts.join(" · ");
  }, [filters]);

  // Holidays: only for the badge in the trade card header.
  const { data: holidaysData } = useHolidaysRange(summary?.firstDate ?? "", summary?.lastDate ?? "");
  const holidayByDate = useMemo(() => {
    const m = new Map<string, HolidayEvent[]>();
    for (const e of holidaysData?.events ?? []) {
      const k = e.date.substring(0, 10);
      const arr = m.get(k) ?? [];
      arr.push(e);
      m.set(k, arr);
    }
    return m;
  }, [holidaysData]);

  // ── Selection / focus / sheet ────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // «В плейбук» from a row icon or the bulk bar (one dialog for the page).
  const [pbTradeIds, setPbTradeIds] = useState<number[] | null>(null);
  /** «Новый сетап из сделки» from that dialog (single trade) → the full setup dialog, like the trade sheet. */
  const [newSetupFrom, setNewSetupFrom] = useState<Trade | null>(null);
  const lastToggledRef = useRef<number | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [picker, setPicker] = useState<PickerTarget>(null);
  /** A trade opened from a deep link / global search that is not among the visible rows. */
  const [detached, setDetached] = useState<Trade | null>(null);
  const [highlightId, setHighlightId] = useState<number | null>(null);
  const [scrollReq, setScrollReq] = useState<{ id: number; n: number } | null>(null);
  const openTrade = useMemo(() => {
    if (openId == null) return null;
    return visibleRows.find((t) => t.id === openId) ?? (detached?.id === openId ? detached : null);
  }, [openId, visibleRows, detached]);
  const openIndex = openTrade ? visibleRows.findIndex((t) => t.id === openTrade.id) : -1;

  const scrollTo = useCallback((id: number) => setScrollReq((r) => ({ id, n: (r?.n ?? 0) + 1 })), []);
  useEffect(() => {
    if (!scrollReq) return;
    const el = document.querySelector(`[data-trade-id="${scrollReq.id}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [scrollReq]);

  // Keep the selection inside the visible rows.
  useEffect(() => {
    setSelected((prev) => {
      if (!prev.size) return prev;
      const vis = new Set(visibleRows.map((t) => t.id));
      const next = new Set([...prev].filter((id) => vis.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [visibleRows]);

  const toggle = useCallback((id: number, range: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const list = rowsRef.current;
      const last = lastToggledRef.current;
      if (range && last != null) {
        const a = list.findIndex((t) => t.id === last);
        const b = list.findIndex((t) => t.id === id);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          for (let i = lo; i <= hi; i++) next.add(list[i].id);
          lastToggledRef.current = id;
          return next;
        }
      }
      if (next.has(id)) next.delete(id); else next.add(id);
      lastToggledRef.current = id;
      return next;
    });
  }, []);

  const openTradeSheet = useCallback((t: Trade) => { setOpenId(t.id); setActiveId(t.id); setPicker(null); }, []);

  // J/K step through the visible rows; in list mode they continue on the neighbouring page.
  const pendingStepRef = useRef<"first" | "last" | null>(null);
  const stepOpen = useCallback((dir: 1 | -1) => {
    const list = rowsRef.current;
    if (!list.length) return;
    const cur = openId ?? activeId;
    const idx = cur != null ? list.findIndex((t) => t.id === cur) : -1;
    const nextIdx = idx + dir;
    if (nextIdx >= list.length) {
      if (listMode && P.hasMore) { pendingStepRef.current = "first"; F.setPage((p) => p + 1); }
      return;
    }
    if (nextIdx < 0) {
      if (listMode && idx === 0 && page > 1) { pendingStepRef.current = "last"; F.setPage((p) => p - 1); return; }
      if (idx !== -1) return;
    }
    const t = list[Math.max(0, nextIdx)];
    if (openId != null) setOpenId(t.id);
    setActiveId(t.id);
    setPicker(null);
    scrollTo(t.id);
  }, [openId, activeId, scrollTo, P.hasMore, page, F, listMode]);

  useEffect(() => {
    const want = pendingStepRef.current;
    if (!want || P.isPlaceholder || !P.items.length) return;
    pendingStepRef.current = null;
    const t = want === "first" ? P.items[0] : P.items[P.items.length - 1];
    if (openId != null) setOpenId(t.id);
    setActiveId(t.id);
    scrollTo(t.id);
  }, [P.items, P.isPlaceholder]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Deep links: ?highlight=id and global search ──────────────────────────
  const focusTrade = useCallback(async (id: number) => {
    const visible = rowsRef.current.find((x) => x.id === id);
    if (visible) {
      setOpenId(id); setActiveId(id); setHighlightId(id); scrollTo(id);
      window.setTimeout(() => setHighlightId((h) => (h === id ? null : h)), 2800);
      return true;
    }
    try {
      const t = await getTrade(id);
      setDetached(t);
      setOpenId(id);
      setActiveId(id);
      return true;
    } catch {
      toast({ title: tradesI18n.t("page.toast.notFound"), description: tradesI18n.t("page.toast.notFoundHint", { id }), variant: "destructive" });
      return false;
    }
  }, [scrollTo, toast]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const hid = Number(params.get("highlight"));
    if (!hid || P.isLoading) return;
    stripParam("highlight");
    void focusTrade(hid);
  }, [P.isLoading, location]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    function onSearchNav(e: Event) {
      const { path, highlightId: hid } = (e as CustomEvent<{ path: string; highlightId: number }>).detail ?? {};
      if (path !== "/trades" || !hid) return;
      void focusTrade(Number(hid));
    }
    window.addEventListener("ws-search-navigate", onSearchNav);
    return () => window.removeEventListener("ws-search-navigate", onSearchNav);
  }, [focusTrade]);

  // ── Mutations ────────────────────────────────────────────────────────────
  // Every screen that derives numbers from the trade book is invalidated in one place (lib/query-keys.ts).
  const invalidateTrades = useCallback((tradeId?: number | null) => { void invalidateTradeDependents(qc, { tradeId }); }, [qc]);
  // Rapid tagging (J, S, 2, J, M, 1 …) would refetch the book after every key: batch it.
  const invalidateTimer = useRef<number | null>(null);
  const invalidateSoon = useCallback(() => {
    if (invalidateTimer.current != null) window.clearTimeout(invalidateTimer.current);
    invalidateTimer.current = window.setTimeout(() => { invalidateTimer.current = null; invalidateTrades(); }, 1200);
  }, [invalidateTrades]);
  useEffect(() => () => { if (invalidateTimer.current != null) window.clearTimeout(invalidateTimer.current); }, []);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Trade | null>(null);
  const [form, setForm] = useState<FormData>(blankForm());
  const [voiceNoteKey, setVoiceNoteKey] = useState(0);

  const updateMut = useUpdateTrade({
    mutation: {
      onSuccess: (_d, vars) => { invalidateTrades(vars?.id); setVoiceNoteKey((k) => k + 1); setFormOpen(false); setEditing(null); toast({ title: tradesI18n.t("page.toast.updated") }); },
      onError: (e: unknown) => toast({ title: tradesI18n.t("page.toast.updateFailed"), description: apiErrorMessage(e), variant: "destructive" }),
    },
  });
  const patchMut = useUpdateTrade();

  /** Inline edits (tags / setup / review / result) with an optimistic cache update. */
  const patchTrade = useCallback(async (t: Trade, patch: TradePatch, opts?: { silent?: boolean }) => {
    const rollback = patchTradeInPages(qc, t.id, patch);
    setDetached((d) => (d && d.id === t.id ? { ...d, ...patch } : d));
    try {
      await patchMut.mutateAsync({ id: t.id, data: patch as UpdateTradeBody });
      if (opts?.silent) invalidateSoon();
      else {
        invalidateTrades(t.id);
        toast({ title: patch.result ? tradesI18n.t("page.toast.resultSet", { ticker: t.ticker, result: RESULT_LABEL[resultKey(patch.result)] }) : tradesI18n.t("page.toast.savedShort", { ticker: t.ticker }) });
      }
      return true;
    } catch (e) {
      rollback();
      setDetached((d) => (d && d.id === t.id ? t : d));
      const msg = apiErrorMessage(e);
      toast({
        title: commonI18n.t("states.saveFailed"),
        // An API build older than this page still gates `setup` on imported trades behind the pre-trade checklist.
        description: /checklist/i.test(msg) ? tradesI18n.t("page.toast.serverOutdated") : msg,
        variant: "destructive",
      });
      return false;
    }
  }, [qc, patchMut, invalidateTrades, invalidateSoon, toast]);

  /** Quick tagging: setup is one value (PATCH setup), mistakes / emotions toggle inside `tags`. */
  const tagTrade = useCallback((t: Trade, kind: TagKind, value: string | null) => {
    if (!canEditTrade(t)) return;
    if (kind === "setup") {
      const next = value && (t.setup ?? "").trim().toLowerCase() === value.toLowerCase() ? null : value;
      void patchTrade(t, { setup: next }, { silent: true });
      return;
    }
    if (!value) return;
    void patchTrade(t, { tags: toggleTag(t.tags, value) }, { silent: true });
  }, [canEditTrade, patchTrade]);

  // Old deep links (?new=1, ?fromIdea=id from the palette / ideas) created a trade by hand; trades now come only from
  // PropReports, so the params are dropped (a ?ticker that came with them still filters the list).
  useEffect(() => {
    stripParam("new");
    stripParam("fromIdea");
  }, [location]);

  const openEdit = useCallback((t: Trade) => {
    setForm(tradeToForm(t)); setEditing(t); setFormOpen(true);
  }, []);

  function handleSave() {
    const body = formToBody(form);
    if (!body.ticker || !body.result) return;
    if (!form.conviction || form.conviction < 1 || form.conviction > 5) {
      toast({ title: tradesI18n.t("page.toast.conviction"), variant: "destructive" });
      return;
    }
    if (!["A+", "A", "B", "C"].includes(form.confidenceGrade)) {
      toast({ title: tradesI18n.t("page.toast.grade"), variant: "destructive" });
      return;
    }
    if (form.horizon !== "intraday" && form.exitDate && form.exitDate < form.date) {
      toast({ title: tradesI18n.t("page.toast.exitBeforeEntry"), variant: "destructive" });
      return;
    }
    const saveErr = formSaveError(form);
    if (saveErr) {
      toast({ title: tradesI18n.t("page.toast.checkStop"), description: saveErr, variant: "destructive" });
      return;
    }
    if (!editing) return;
    // Untouched entry-decision fields are omitted so that editing notes etc. doesn't hit the checklist gate.
    const original: Record<string, unknown> = { ...formToBody(tradeToForm(editing)) };
    const patch: Record<string, unknown> = { ...body };
    for (const f of ENTRY_DECISION_FIELDS) if (patch[f] === original[f]) delete patch[f];
    updateMut.mutate({ id: editing.id, data: patch as UpdateTradeBody });
  }

  // ── Delete with undo + bulk actions ──────────────────────────────────────
  const [undo, setUndo] = useState<{ ids: number[]; label: string; key: number; restoring?: boolean } | null>(null);
  const [bulkPending, setBulkPending] = useState(false);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);

  const runBulk = useCallback(async (body: BulkBody) => {
    setBulkPending(true);
    try {
      const done = await bulkTrades(body, rowsRef.current);
      invalidateTrades();
      return done;
    } catch (e) {
      toast({ title: tradesI18n.t("page.toast.bulkFailed"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
      return null;
    } finally {
      setBulkPending(false);
    }
  }, [invalidateTrades, toast]);

  const deleteTrades = useCallback(async (ids: number[]) => {
    if (!ids.length) return;
    const label = ids.length === 1
      ? (rowsRef.current.find((t) => t.id === ids[0]) ?? (detached?.id === ids[0] ? detached : null))?.ticker ?? `#${ids[0]}`
      : `${commonI18n.t("units.trades", { count: ids.length })}`;
    const done = await runBulk({ action: "delete", ids });
    if (!done?.length) return;
    setOpenId((cur) => (cur != null && done.includes(cur) ? null : cur));
    setSelected(new Set());
    setUndo({ ids: done, label, key: Date.now() });
    if (done.length < ids.length) toast({ title: tradesI18n.t("page.toast.deletedPartial", { done: done.length, total: ids.length }), description: tradesI18n.t("page.toast.deletedPartialHint") });
  }, [runBulk, toast, detached]);

  const restoreUndo = useCallback(async () => {
    if (!undo) return;
    const u = undo;
    if (u.restoring) return;
    setUndo({ ...u, restoring: true });
    const done = await runBulk({ action: "restore", ids: u.ids });
    setUndo((cur) => (cur?.key === u.key ? null : cur));
    if (done) toast({ title: tradesI18n.t("page.toast.restored", { label: u.label }) });
  }, [undo, runBulk, toast]);

  const selectedTrades = useMemo(() => visibleRows.filter((t) => selected.has(t.id)), [visibleRows, selected]);
  const selectedIds = useMemo(() => selectedTrades.map((t) => t.id), [selectedTrades]);
  const bulkStateOf = useCallback((kind: TagKind, value: string): PickState => {
    if (!selectedTrades.length) return "none";
    const n = selectedTrades.filter((t) => (kind === "setup" ? (t.setup ?? "").trim().toLowerCase() === value.toLowerCase() : hasTag(t.tags, value))).length;
    return n === 0 ? "none" : n === selectedTrades.length ? "all" : "some";
  }, [selectedTrades]);
  const canDeleteSelection = selectedTrades.length > 0 && selectedTrades.every((t) => canEditForm(t));
  const nTrades = (n: number) => commonI18n.t("units.trades", { count: n });

  // ── CSV export of the whole filtered set ────────────────────────────────
  const [exporting, setExporting] = useState(false);
  const exportAll = useCallback(async () => {
    setExporting(true);
    try {
      const all = await P.fetchAll();
      if (!all.length) { toast({ title: tradesI18n.t("page.toast.nothingToExport") }); return; }
      downloadCsv(all);
      toast({ title: tradesI18n.t("page.toast.csv", { trades: nTrades(all.length) }) });
    } catch (e) {
      toast({ title: tradesI18n.t("page.toast.exportFailed"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setExporting(false);
    }
  }, [P, toast]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Keyboard ─────────────────────────────────────────────────────────────
  const [helpOpen, setHelpOpen] = useState(false);
  const modalOpen = formOpen || confirmBulkDelete || !!pbTradeIds;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || modalOpen) return;
      if (isTypingTarget(e.target)) return;
      if (document.querySelector("[data-radix-popper-content-wrapper]")) return;
      const k = e.key;
      if (k === "?") { e.preventDefault(); setHelpOpen((v) => !v); return; }
      const lower = k.toLowerCase();
      if (lower === "j" || lower === "k" || lower === "о" || lower === "л") { e.preventDefault(); stepOpen(lower === "j" || lower === "о" ? 1 : -1); return; } // i18n-ignore (Russian keyboard layout keys)
      if (openId != null) return; // the sheet owns the rest of the keyboard
      if (k === "ArrowRight" && listMode && P.hasMore) { e.preventDefault(); F.setPage((p) => p + 1); return; }
      if (k === "ArrowLeft" && listMode && page > 1) { e.preventDefault(); F.setPage((p) => p - 1); return; }
      if (k === "/") { e.preventDefault(); searchRef.current?.focus(); return; }
      const active = activeId != null ? rowsRef.current.find((t) => t.id === activeId) : undefined;
      if (k === "Enter" && active) { e.preventDefault(); openTradeSheet(active); return; }
      if ((lower === "x" || lower === "ч") && active) { e.preventDefault(); toggle(active.id, e.shiftKey); return; } // i18n-ignore (Russian keyboard layout key)
      const kind = KEY_KIND[lower];
      if (kind && !e.shiftKey && active && canEditTrade(active)) { e.preventDefault(); setPicker({ id: active.id, kind }); return; }
      if (k === "Escape" && selected.size) { e.preventDefault(); setSelected(new Set()); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modalOpen, openId, activeId, selected.size, canEditTrade, stepOpen, openTradeSheet, toggle, P.hasMore, page, F, listMode]);

  // ── Render helpers ───────────────────────────────────────────────────────
  const rowProps = (t: Trade) => ({
    trade: t,
    showTrader,
    quality,
    qualityPending: pendingSet.has(t.id),
    active: activeId === t.id,
    selected: selected.has(t.id),
    highlight: highlightId === t.id,
    canTag: canEditTrade(t),
    picker,
    setPicker,
    onPick: tagTrade,
    setupOptions,
    onOpen: openTradeSheet,
    onToggle: toggle,
    onFocusRow: setActiveId,
    onAddToPlaybook: user?.role !== "guest" ? (t: Trade) => setPbTradeIds([t.id]) : undefined,
  });

  const isPending = updateMut.isPending;
  const noFilters = isDefaultFilters(filters);
  const isLoading = P.isLoading;
  const isError = P.isError || (!listMode && D.isError);
  const noTrades = !isLoading && !P.isError && total === 0 && noFilters && !preset;
  const days = summary?.days ?? D.totalDays;
  const headerText = isLoading
    ? tc("states.loading")
    : days
      ? tt("page.headerDays", { trades: nTrades(total), days: tc("units.tradingDays", { count: days }), scope: scopeLabel })
      : tt("page.header", { trades: nTrades(total), scope: scopeLabel });
  const presetMeta = preset ? PRESET_META[preset] : null;

  const presetEmpty = (p: Preset) => (
    <EmptyState
      icon={p === "review" ? CheckCircle2 : Filter}
      title={p === "review" ? tt("page.empty.allTaggedTitle") : tt("page.empty.presetTitle", { preset: PRESET_META[p].label })}
      description={p === "review" ? tt("page.empty.allTaggedDesc") : tt("page.empty.presetDesc", { scope: scopeLabel })}
      action={<Button variant="outline" onClick={() => F.setPreset(null)}>{tt("page.empty.backToDays")}</Button>}
    />
  );

  return (
    <Page className="pb-24">
      <PageHeader
        title={shellI18n.t("nav.trades")}
        icon={BookText}
        description={headerText}
        actions={
          <>
            <Popover open={helpOpen} onOpenChange={setHelpOpen}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={tt("page.shortcuts.aria")} title={tt("page.shortcuts.aria")}><Keyboard /></Button>
              </PopoverTrigger>
              <PopoverContent align="end" side="bottom" collisionPadding={12} className="w-72 p-3">
                <p className="pb-2 text-sm font-semibold">{tt("page.shortcuts.title")}</p>
                <ul className="space-y-1.5">
                  {shortcuts().map(([key, label]) => (
                    <li key={key} className="flex items-center justify-between gap-3 text-sm">
                      <span className="text-muted-foreground">{label}</span>
                      <Kbd>{key}</Kbd>
                    </li>
                  ))}
                </ul>
                <p className="pt-2 text-xs text-muted-foreground">{tt("page.shortcuts.hint")}</p>
              </PopoverContent>
            </Popover>
            <Button variant="outline" size="sm" className="gap-1.5" disabled={!total || exporting} onClick={() => void exportAll()} aria-label={tt("page.exportAria", { count: total })}>
              {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} CSV
            </Button>
          </>
        }
      />

      {!noTrades && (
        <TradeFilterBar
          filters={filters}
          patch={F.patch}
          reset={F.reset}
          outcomeCounts={facets?.outcomes ?? EMPTY_OUTCOMES}
          horizonCounts={facets?.horizons ?? {}}
          setups={facets?.setups ?? []}
          traders={distinctTraders}
          sectors={facets?.sectors ?? []}
          views={F.views}
          onSaveView={(n) => { F.saveView(n); toast({ title: tt("page.toast.viewSaved", { name: n }) }); }}
          onApplyView={F.applyView}
          onRemoveView={F.removeView}
          searchRef={searchRef}
        />
      )}

      {!noTrades && !P.isError && (
        <ReviewKpis summary={summary} loading={isLoading} dayCurve={preset ? [] : dayCurve} onPreset={(p) => F.setPreset(p)} />
      )}

      {!noTrades && (
        <PresetBar
          view={view}
          onView={(v) => { if (v === "days") F.setPreset(null); F.setView(v); }}
          preset={preset}
          onPreset={F.setPreset}
          counts={facets?.presets ?? null}
          sort={sort}
          onSort={F.setSort}
          trader={traderForLinks}
        />
      )}

      {isError ? (
        <Panel><QueryError error={P.error ?? D.error} onRetry={() => { void P.refetch(); void D.refetch(); }} /></Panel>
      ) : noTrades ? (
        <Panel>
          <EmptyState
            icon={BookText}
            title={tt("page.empty.noTradesTitle")}
            description={tt("page.empty.noTradesDesc")}
          />
        </Panel>
      ) : listMode ? (
        <Panel padded={false} className="overflow-hidden" aria-label={presetMeta ? presetMeta.label : tt("page.allTrades")}>
          {isLoading ? (
            <RowsSkeleton rows={8} />
          ) : total === 0 ? (
            preset ? presetEmpty(preset) : (
              <EmptyState icon={Filter} title={tt("page.empty.filteredTitle")} description={tt("page.empty.filteredDesc", { scope: scopeLabel })} action={<Button variant="outline" onClick={F.reset}>{tc("actions.resetFilters")}</Button>} />
            )
          ) : (
            <div role="table" aria-label={shellI18n.t("nav.trades")} className={P.isPlaceholder ? "opacity-70 transition-opacity" : "transition-opacity"} aria-busy={P.isPlaceholder || undefined}>
              {/* Fixed-width grid columns (~900px): scroll sideways on narrow screens instead of clipping Нетто/Захват. */}
              <div className="overflow-x-auto">
                <div className={ROWS_MIN_W}>
                  <RowsHeader showDate sort={sort} onSort={F.toggleSort} />
                  {P.items.map((t) => <ReviewTradeRow key={t.id} {...rowProps(t)} showDate />)}
                </div>
              </div>
              <TradePagination
                page={page}
                pageSize={pageSize}
                total={total}
                returned={P.items.length}
                hasMore={P.hasMore}
                fetching={P.isFetching}
                onPage={F.setPage}
                onPageSize={F.setPageSize}
              />
            </div>
          )}
        </Panel>
      ) : D.isLoading ? (
        <Panel padded={false}><RowsSkeleton rows={6} /></Panel>
      ) : !D.days.length ? (
        <Panel>
          <EmptyState icon={Filter} title={tt("page.empty.filteredTitle")} description={tt("page.empty.filteredDesc", { scope: scopeLabel })} action={<Button variant="outline" onClick={F.reset}>{tc("actions.resetFilters")}</Button>} />
        </Panel>
      ) : (
        <div className="space-y-[var(--grid-gap)]" aria-busy={D.isFetching || undefined}>
          {D.days.map((d) => {
            const isOpen = expanded.has(d.date);
            const rows = isOpen ? dayRows(d.date) : undefined;
            return (
              <DayCard key={d.date} day={d} expanded={isOpen} onToggle={() => toggleDay(d.date)} trader={traderForLinks}>
                {rows == null ? <RowsSkeleton rows={Math.min(6, d.count)} /> : (
                  <div role="table" aria-label={tt("page.dayTableAria", { date: d.date })}>
                    <div className="overflow-x-auto">
                      <div className={ROWS_MIN_W}>
                        <RowsHeader showDate={false} />
                        {rows.map((t) => <ReviewTradeRow key={t.id} {...rowProps(t)} showDate={false} />)}
                      </div>
                    </div>
                    {rows.length >= 500 && d.count > rows.length && (
                      <p className="px-3 py-2 text-xs text-muted-foreground">{tt("page.first500", { count: d.count })}</p>
                    )}
                  </div>
                )}
              </DayCard>
            );
          })}
          {D.hasMore && (
            <div className="flex justify-center pt-1">
              <Button variant="outline" onClick={D.loadMore} disabled={D.isFetching} className="gap-1.5">
                {D.isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin" />} {tt("page.moreDays")}
                <span className="text-muted-foreground">{tt("page.daysShown", { shown: D.days.length, total: D.totalDays })}</span>
              </Button>
            </div>
          )}
        </div>
      )}

      {selected.size > 0 && (
        <BulkActionBar
          count={selectedIds.length}
          canTag={selectedTrades.every((t) => canEditTrade(t))}
          pending={bulkPending}
          setupOptions={setupOptions}
          stateOf={bulkStateOf}
          onSetSetup={async (setup) => {
            const done = await runBulk({ action: "setSetup", ids: selectedIds, setup });
            if (done) toast({ title: setup ? tt("page.toast.setupSet", { setup, trades: nTrades(done.length) }) : tt("page.toast.setupCleared", { trades: nTrades(done.length) }) });
          }}
          onToggleTag={async (tag, mode) => {
            const done = await runBulk({ action: mode === "add" ? "addTags" : "removeTags", ids: selectedIds, tags: [tag] });
            if (done) toast({ title: tt(mode === "add" ? "page.toast.tagAdded" : "page.toast.tagRemoved", { tag: tagLabel(tag) }), description: nTrades(done.length) });
          }}
          onExport={() => downloadCsv(selectedTrades, `trades-selected-${selectedIds.length}.csv`)}
          onSetResult={isStaff ? async (r) => {
            const done = await runBulk({ action: "setResult", ids: selectedIds, result: r });
            if (done) toast({ title: tt("page.toast.resultBulk", { result: RESULT_LABEL[r], trades: nTrades(done.length) }) });
          } : undefined}
          onDelete={canDeleteSelection ? () => (selectedIds.length === 1 ? deleteTrades(selectedIds) : setConfirmBulkDelete(true)) : undefined}
          onClear={() => setSelected(new Set())}
          onAddToPlaybook={user?.role !== "guest" ? () => setPbTradeIds(selectedIds) : undefined}
        />
      )}
      <AddTradesToPlaybookDialog
        open={!!pbTradeIds}
        onOpenChange={(v) => { if (!v) setPbTradeIds(null); }}
        tradeIds={pbTradeIds ?? []}
        onNewSetup={() => {
          const id = pbTradeIds?.[0];
          const t = visibleRows.find((x) => x.id === id) ?? (detached?.id === id ? detached : null);
          if (t) setNewSetupFrom(t);
        }}
      />
      {newSetupFrom && (
        <AddToPlaybookDialog
          open
          onOpenChange={(v) => { if (!v) setNewSetupFrom(null); }}
          payload={tradePlaybookPayload(newSetupFrom)}
        />
      )}

      <TradeDetailSheet
        trade={openTrade}
        onClose={() => setOpenId(null)}
        allTrades={visibleRows}
        onOpenTrade={(t) => { setDetached(t); setOpenId(t.id); setActiveId(t.id); }}
        onPrev={openIndex > 0 || (listMode && openIndex === 0 && page > 1) ? () => stepOpen(-1) : undefined}
        onNext={openIndex >= 0 && (openIndex < visibleRows.length - 1 || (listMode && P.hasMore)) ? () => stepOpen(1) : undefined}
        position={openIndex >= 0 ? (listMode ? { index: (page - 1) * pageSize + openIndex, total } : { index: openIndex, total: visibleRows.length }) : undefined}
        canEdit={openTrade ? canEditTrade(openTrade) : false}
        canEditForm={openTrade ? canEditForm(openTrade) : false}
        canEditResult={openTrade ? canEditForm(openTrade) : false}
        canDelete={openTrade ? canEditForm(openTrade) : false}
        onEdit={openEdit}
        onDelete={(t) => deleteTrades([t.id])}
        onPatch={patchTrade}
        onTag={tagTrade}
        setupOptions={setupOptions}
        traderName={me}
        isCurator={isStaff}
        voiceNoteKey={voiceNoteKey}
        holidayEvents={openTrade ? holidayByDate.get(dayOf(openTrade)) ?? [] : []}
      />

      <TradeFormDialog
        open={formOpen}
        onClose={() => { setFormOpen(false); setEditing(null); }}
        form={form}
        setForm={setForm}
        editing={editing}
        traderNames={traderNames}
        onSave={handleSave}
        isPending={isPending}
        onVoiceUploaded={() => setVoiceNoteKey((k) => k + 1)}
      />


      <AlertDialog open={confirmBulkDelete} onOpenChange={setConfirmBulkDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tt("page.confirmDelete", { count: selectedIds.length })}</AlertDialogTitle>
            <AlertDialogDescription>{tt("page.confirmDeleteDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tc("actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { setConfirmBulkDelete(false); void deleteTrades(selectedIds); }}
              className="border border-destructive/30 bg-destructive/15 text-destructive hover:bg-destructive/25"
            >
              {tc("actions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {undo && (
        <UndoToast key={undo.key} label={undo.label} onUndo={restoreUndo} restoring={undo.restoring} onDismiss={() => setUndo((cur) => (cur?.restoring ? cur : null))} />
      )}

      {/* Used by tests / other pages to know which horizons exist. */}
      <span hidden data-horizons={HORIZONS.join(",")} />
    </Page>
  );
}
