// «Катализаторы» (route /events): the trader's calendar of what moves the market and their tickers —
// macro (CPI / NFP / FOMC / PPI / expirations), short days and closures, earnings of the trader's watchlist
// and most traded tickers — all pulled automatically, plus «как я торгую в такие дни» from the trader's own
// trades. The only manual input is a short day note (market_events), which keeps its sheet and «В плейбук».
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateEvent, useUpdateEvent, useDeleteEvent, getListEventsQueryKey,
  type MarketEvent, type UpdateEventBody,
} from "@workspace/api-client-react";
import { CalendarClock, CalendarDays, Plus, Scale, Sun, AlertTriangle, RefreshCw } from "lucide-react";
import { Page, PageHeader, Panel, Segmented, EmptyState, usePersistentState } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { UndoToast } from "@/components/undo-toast";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { http } from "@/lib/api/http";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/auth-context";
import { dayOf, fmtDay, weekStartOf } from "@/components/events/event-meta";
import { EventDetailSheet } from "@/components/events/event-detail-sheet";
import { EventFormDialog, blankEvent, eventToForm, formToBody, type EventFormData } from "@/components/events/event-form-dialog";
import { QuickAdd } from "@/components/events/quick-add";
import { EarningsHistorySheet, type HistoryTarget } from "@/components/research/earnings-history";
import { useCatalysts, type MyEarnings } from "@/components/events/use-catalysts";
import { DayBrief, MyTickerEarnings } from "@/components/events/catalyst-today";
import { WeekGrid } from "@/components/events/catalyst-week";
import { EdgeView } from "@/components/events/catalyst-edge";
import { nextTradingDay, prevTradingDay } from "@/components/events/catalyst-math";
import { PersonSelect } from "@/components/people/person-select";
import { humanizeApiError } from "@/lib/api/errors";
import { eventsI18n } from "@/i18n/ns/events";
import { commonI18n } from "@/i18n/ns/common";

import { personName, comparePersonNames } from "@/i18n";
type View = "today" | "week" | "edge";
const VIEWS: View[] = ["today", "week", "edge"];
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const TICKER = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const DESK = "__desk__";

function isTypingTarget(t: EventTarget | null) {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || !!t.closest("[role='dialog'],[role='listbox'],[role='menu']");
}

export default function Events() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t } = eventsI18n.useT();
  const { user, isCurator, isAdmin, dbUsers } = useAuth();
  const isStaff = isCurator || isAdmin;

  // Deep links: ?date=YYYY-MM-DD (day), ?ticker=NVDA (ticker sheet), ?id=12 (note), ?new=1 (note form).
  const urlParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const urlDate = urlParams.get("date");
  const urlTicker = urlParams.get("ticker")?.trim().toUpperCase() ?? "";

  const [storedView, setView] = usePersistentState<View>("catalysts.view", "today");
  const view: View = VIEWS.includes(storedView) ? storedView : "today";

  // Trader scope: a trader always sees themself (server-scoped); staff can switch.
  const [traderPick, setTraderPick] = useState<string>(() => user?.traderName ?? DESK);
  const trader = isStaff ? (traderPick === DESK ? null : traderPick) : (user?.traderName ?? null);
  const traderOptions = useMemo(
    () => dbUsers.filter((u) => u.active && !u.banned && u.role !== "guest").map((u) => u.name).sort(comparePersonNames),
    [dbUsers],
  );

  const data = useCatalysts(trader);
  const { focus, closed } = data;

  const [picked, setPicked] = useState<string | null>(() => (urlDate && YMD.test(urlDate) ? urlDate : null));
  const selected = picked ?? focus;
  const [weekAnchor, setWeekAnchor] = useState<string | null>(() => (urlDate && YMD.test(urlDate) ? urlDate : null));
  const weekStart = weekStartOf(weekAnchor ?? selected);
  useEffect(() => { if (urlDate && YMD.test(urlDate)) setView("week"); }, [urlDate, setView]);

  const pickDay = useCallback((d: string) => { setPicked(d); setWeekAnchor(d); setView("week"); }, [setView]);

  // ── Ticker history sheet ──
  const [sheet, setSheet] = useState<HistoryTarget | null>(() => (TICKER.test(urlTicker) ? { ticker: urlTicker } : null));
  const openTicker = useCallback((e: Pick<MyEarnings, "ticker"> & Partial<MyEarnings>) => {
    setSheet({ ticker: e.ticker, company: e.company, callType: e.callType ?? null, epsEstimate: e.epsEstimate ?? null, date: e.date ?? null });
  }, []);

  // ── Notes (market_events) ──
  const events = data.notesQ.data ?? [];
  const [detailId, setDetailId] = useState<number | null>(() => Number(urlParams.get("id")) || null);
  const [formOpen, setFormOpen] = useState(() => urlParams.get("new") === "1");
  const [editing, setEditing] = useState<MarketEvent | null>(null);
  const [formInitial, setFormInitial] = useState<EventFormData>(() => blankEvent(urlDate && YMD.test(urlDate) ? { date: urlDate } : {}));
  const [undo, setUndo] = useState<{ id: number; label: string } | null>(null);
  const [patching, setPatching] = useState(false);

  const onMutErr = (e: unknown) => {
    const err = e as { status?: number; data?: { error?: string; code?: string; existingId?: number } } | undefined;
    if (err?.status === 409 && err.data?.code === "DUPLICATE" && err.data.existingId) {
      const existingId = err.data.existingId;
      toast({
        title: eventsI18n.t("toast.duplicateTitle"),
        description: eventsI18n.t("toast.duplicateText"),
        action: <ToastAction altText={eventsI18n.t("toast.openExisting")} onClick={() => { setFormOpen(false); setDetailId(existingId); }}>{commonI18n.t("actions.open")}</ToastAction>,
      });
      return;
    }
    toast({ title: commonI18n.t("states.error"), description: humanizeApiError(e), variant: "destructive" });
  };
  const invalidate = () => Promise.all([
    qc.invalidateQueries({ queryKey: getListEventsQueryKey() }),
    qc.invalidateQueries({ queryKey: ["events-today"] }),
    qc.invalidateQueries({ queryKey: ["events-holding"] }),
    qc.invalidateQueries({ queryKey: ["event-edge"] }),
  ]);
  const createMut = useCreateEvent({ mutation: { onSuccess: () => invalidate(), onError: onMutErr } });
  const updateMut = useUpdateEvent({ mutation: { onSuccess: () => invalidate(), onError: onMutErr } });
  const deleteMut = useDeleteEvent({ mutation: { onError: onMutErr } });

  const detail = useMemo(() => events.find((e) => e.id === detailId) ?? null, [events, detailId]);

  const openCreate = useCallback((over: Partial<EventFormData> = {}) => {
    setEditing(null);
    setFormInitial(blankEvent(over));
    setFormOpen(true);
  }, []);
  const openEdit = useCallback((e: MarketEvent) => {
    setEditing(e);
    setFormInitial(eventToForm(e));
    setFormOpen(true);
  }, []);
  const openNote = useCallback((e: MarketEvent) => setDetailId(e.id), []);

  function handleSubmit(body: ReturnType<typeof formToBody>) {
    if (editing) {
      updateMut.mutate({ id: editing.id, data: body as UpdateEventBody }, {
        onSuccess: () => { setFormOpen(false); toast({ title: eventsI18n.t("toast.updated") }); },
      });
    } else {
      createMut.mutate({ data: body }, {
        onSuccess: (created) => {
          setFormOpen(false);
          toast({ title: eventsI18n.t("toast.added"), description: `${body.ticker} · ${fmtDay(body.date)}` });
          if (created && typeof (created as MarketEvent).id === "number") setDetailId((created as MarketEvent).id);
        },
      });
    }
  }
  const quickCreate = useCallback(async (body: ReturnType<typeof formToBody>) => {
    await createMut.mutateAsync({ data: body });
    toast({ title: eventsI18n.t("toast.added"), description: `${body.ticker} · ${fmtDay(body.date)}` });
  }, [createMut, toast]);
  const handlePatch = useCallback(async (id: number, body: Record<string, unknown>) => {
    setPatching(true);
    try { await updateMut.mutateAsync({ id, data: body as UpdateEventBody }); } catch { /* toast via onError */ } finally { setPatching(false); }
  }, [updateMut]);
  function handleDelete(e: MarketEvent) {
    deleteMut.mutate({ id: e.id }, {
      onSuccess: () => {
        if (detailId === e.id) setDetailId(null);
        setUndo({ id: e.id, label: `${e.ticker} — ${e.headline.slice(0, 40)}` });
        invalidate();
      },
    });
  }
  async function handleUndo() {
    const u = undo;
    setUndo(null);
    if (!u) return;
    try {
      await http.post(`/api/events/${u.id}/restore`, undefined, { responseType: "auto" });
      await invalidate();
      toast({ title: eventsI18n.t("toast.restored") });
    } catch (err) {
      toast({ title: eventsI18n.t("toast.restoreFailed"), description: humanizeApiError(err), variant: "destructive" });
    }
  }
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 8000);
    return () => clearTimeout(t);
  }, [undo]);

  // Deep link ?id → show that note's day.
  useEffect(() => {
    if (detail && urlParams.get("id") && !picked) { setPicked(dayOf(detail)); setWeekAnchor(dayOf(detail)); }
  }, [detail, urlParams, picked]);

  const addNote = useCallback((date: string) => (
    <QuickAdd date={date} onCreate={quickCreate} onMore={(f) => openCreate(f)} />
  ), [quickCreate, openCreate]);

  // ── Keyboard: 1/2/3 views, ←/→ trading days, T back to the focus day, N note ──
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (ev.metaKey || ev.ctrlKey || ev.altKey || isTypingTarget(ev.target)) return;
      if (document.querySelector("[role='dialog']")) return;
      const k = ev.key.toLowerCase();
      if (ev.key === "1") setView("today");
      else if (ev.key === "2") setView("week");
      else if (ev.key === "3") setView("edge");
      // Same physical keys on the Russian layout (Т = N, Е = T).
      else if (k === "t" || k === "е") { setPicked(null); setWeekAnchor(null); } // i18n-ignore
      else if (k === "n" || k === "т") { ev.preventDefault(); openCreate({ date: selected }); } // i18n-ignore
      else if (view !== "edge" && ev.key === "ArrowLeft") { ev.preventDefault(); const d = prevTradingDay(selected, closed); setPicked(d); setWeekAnchor(d); }
      else if (view !== "edge" && ev.key === "ArrowRight") { ev.preventDefault(); const d = nextTradingDay(selected, closed); setPicked(d); setWeekAnchor(d); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, selected, closed, openCreate, setView]);

  const viewOptions = [
    { value: "today" as const, label: <span className="inline-flex items-center gap-1.5"><Sun className="h-3.5 w-3.5" aria-hidden="true" />{focus === data.today ? t("page.today") : t("page.toOpen")}</span> },
    { value: "week" as const, label: <span className="inline-flex items-center gap-1.5"><CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />{t("page.week")}</span> },
    { value: "edge" as const, label: <span className="inline-flex items-center gap-1.5"><Scale className="h-3.5 w-3.5" aria-hidden="true" />{t("page.edge")}</span> },
  ];

  const tradesError = data.trades.isError;
  const scopeLabel = trader ? personName(trader) : t("page.wholeDesk");

  return (
    <Page>
      <PageHeader
        title={t("page.title")}
        icon={CalendarClock}
        description={t("page.description")}
        meta={
          <span>
            {focus === data.today ? t("page.today") : t("page.nextSession", { date: fmtDay(focus, "weekdayDayMonthLong") })}
            {data.myTickers.length > 0 && ` · ${t("page.watching", { count: data.myTickers.length })}`}
            {isStaff && ` · ${scopeLabel}`}
          </span>
        }
        actions={
          <>
            {isStaff && (
              <PersonSelect value={traderPick} onValueChange={setTraderPick} allValue={DESK} allLabel={t("page.wholeDeskOption")} options={traderOptions} className="h-9 w-[180px]" ariaLabel={t("page.whoseTrades")} />
            )}
            <Segmented<View> ariaLabel={t("page.view")} value={view} onChange={setView} options={viewOptions} />
            <Button variant="outline" onClick={() => openCreate({ date: selected })}>
              <Plus /> {t("page.note")}
            </Button>
          </>
        }
      />

      {tradesError && (
        <Panel>
          <EmptyState
            compact
            icon={AlertTriangle}
            title={t("page.tradesErrorTitle")}
            description={t("page.tradesErrorText")}
            action={<Button variant="outline" size="sm" onClick={() => data.trades.refetch()}><RefreshCw className={cn(data.trades.isFetching && "animate-spin")} /> {commonI18n.t("actions.retry")}</Button>}
          />
        </Panel>
      )}

      {view === "today" && (
        <DayBrief
          day={picked && picked >= data.today ? picked : focus}
          data={data}
          onOpenTicker={openTicker}
          onOpenNote={openNote}
          addNote={addNote}
          onPickDay={pickDay}
        />
      )}

      {view === "week" && (
        <>
          <WeekGrid
            weekStart={weekStart}
            onWeekChange={(d) => setWeekAnchor(d)}
            selected={selected}
            onSelect={(d) => setPicked(d)}
            data={data}
          />
          <DayBrief day={selected} data={data} onOpenTicker={openTicker} onOpenNote={openNote} addNote={addNote} showTeaser={false} />
        </>
      )}

      {view === "edge" && <EdgeView data={data} onOpenTicker={openTicker} />}

      <EarningsHistorySheet
        target={sheet}
        onOpenChange={(v) => { if (!v) setSheet(null); }}
        onCreateNote={(t) => { setSheet(null); openCreate({ ticker: t.ticker, date: t.date ?? selected, eventType: "earnings" }); }}
        extra={sheet ? <MyTickerEarnings ticker={sheet.ticker} data={data} /> : null}
      />

      <EventDetailSheet
        event={detail}
        all={events}
        open={!!detail}
        onOpenChange={(v) => { if (!v) setDetailId(null); }}
        onEdit={(e) => openEdit(e)}
        onDelete={handleDelete}
        onOpenEvent={openNote}
        onPatch={handlePatch}
        patching={patching}
      />

      <EventFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        editing={editing}
        initial={formInitial}
        onSubmit={handleSubmit}
        saving={createMut.isPending || updateMut.isPending}
      />

      {undo && <UndoToast label={undo.label} onUndo={handleUndo} onDismiss={() => setUndo(null)} />}
    </Page>
  );
}
