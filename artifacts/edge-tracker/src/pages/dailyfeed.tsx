import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListDailyFeed, useCreateDailyFeed, useUpdateDailyFeed, useDeleteDailyFeed, getListDailyFeedQueryKey,
} from "@workspace/api-client-react";
import type { DailyFeed, UpdateDailyFeedBody } from "@workspace/api-client-react";
import {
  Newspaper, Bell, Bot, RefreshCw, Search, X, ChevronLeft, ChevronRight, CalendarDays, PenLine, Megaphone,
  MoreHorizontal, ClipboardCheck, AlertTriangle, CalendarRange, Sparkles, TrendingUp, Zap, NotebookPen,
} from "lucide-react";
import { Link } from "wouter";
import { useAuth } from "@/contexts/auth-context";
import {
  Page, PageHeader, Panel, Segmented, Toolbar, EmptyState, SkeletonBlock, UpdatedAgo, Pill, toneOf, toneText, usePersistentState,
} from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { UndoToast } from "@/components/undo-toast";
import type { PlaybookPayload } from "@/components/add-to-playbook";
import { useToast } from "@/hooks/use-toast";
import { useUndoDelete } from "@/hooks/use-undo-delete";
import { addDays, nyDate } from "@/lib/trading-date";
import { links } from "@/lib/links";
import { http, ApiError } from "@/lib/api/http";
import { cn } from "@/lib/utils";
import { FeedEntryCard } from "@/components/feed/FeedEntryCard";
import { FeedCalendar } from "@/components/feed/FeedCalendar";
import { DigestSheet } from "@/components/feed/DigestSheet";
import { FeedEditorDialog, blankForm, feedToForm, formToBody, type FeedForm } from "@/components/feed/FeedEditorDialog";
import { StreamDayHeader, StreamGroup, StreamRow } from "@/components/feed/StreamCard";
import {
  STREAM_KEY, fmtValue, groupDay, isNewItem, useFeedStream, useFeedStreamDay, useSeenBaseline,
  type FeedCategory, type StreamItem,
} from "@/components/feed/stream-api";
import { dayOf, entryIsUnread, entryToText, formatDayLong, hasServerAcks, splitList, useFeedAck, useFeedViewerState, type AckKind, type FeedEntry } from "@/components/feed/feed-utils";
import { fmtDate } from "@/lib/format";
import { humanizeApiError } from "@/lib/api/errors";
import { commonI18n } from "@/i18n/ns/common";
import { feedI18n } from "@/i18n/ns/feed";
import { personName } from "@/i18n";

/** Date + time with seconds ("17.10.2026, 14:05:09" in RU), the shape of the old bare toLocaleString(). */

/**
 * «Лента» — assembles itself from what happens in the system (day results, streaks and records, academy,
 * curator reviews, ideas, playbook, threads, game plans, market events, weekly summaries; see
 * api-server lib/feedStream.ts). Manual posts (daily_feed) stay as announcements / short notes.
 */

type Cat = "all" | FeedCategory;
const CAT_VALUES: Cat[] = ["all", "mine", "desk", "achievement", "market", "announcement"];
const catLabel = (c: Cat) => (c === "all" ? commonI18n.t("states.all") : feedI18n.t(`cat.${c}`));

function isTypingTarget(el: EventTarget | null) {
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}

function stepWeekday(d: string, dir: -1 | 1) {
  let x = addDays(d, dir);
  for (let i = 0; i < 3; i++) {
    const wd = new Date(`${x}T12:00:00`).getDay();
    if (wd !== 0 && wd !== 6) break;
    x = addDays(x, dir);
  }
  return x;
}

function buildPlaybookPayload(feed: DailyFeed): PlaybookPayload {
  const conditions: string[] = [];
  if (feed.whatWorksNow) conditions.push(feed.whatWorksNow);
  const t = feedI18n.t;
  if (feed.marketTheme) conditions.push(t("playbook.theme", { text: feed.marketTheme }));
  const notes: string[] = [];
  if (feed.whatDoesntWork) notes.push(t("playbook.doesntWork", { text: feed.whatDoesntWork }));
  if (feed.notes) notes.push(feed.notes);
  if (feed.bestTickers) notes.push(t("playbook.tickers", { text: feed.bestTickers }));
  return {
    name: `${feed.marketTheme || t("playbook.strategy")} (${dayOf(feed)})`,
    conditions: conditions.join("\n") || undefined,
    notes: notes.join("\n") || undefined,
    screenshotUrl: feed.screenshotUrl || undefined,
    screenshotNotes: feed.screenshotNotes || undefined,
    tags: feed.tags || undefined,
    sourceType: "dailyfeed",
    sourceId: feed.id,
  };
}

const itemHay = (it: StreamItem) => [it.title, it.subtitle, it.ticker, it.trader, it.actor, personName(it.trader), personName(it.actor)].map((x) => (x ?? "").toLowerCase()).join("\n");
const postHay = (f: DailyFeed) =>
  [f.marketTheme, f.bestTickers, f.whatWorksNow, f.whatDoesntWork, f.notes, f.tags, f.screenshotNotes].map((x) => (x ?? "").toLowerCase()).join("\n");

function FeedSkeleton() {
  return (
    <div className="flex flex-col gap-6" role="status" aria-label={feedI18n.t("page.loading")}>
      {[5, 3].map((rows, d) => (
        <section key={d} className="flex flex-col gap-2">
          <SkeletonBlock className="mx-1 h-6 w-64 rounded-full" />
          <div className="glass-panel rounded-2xl p-2">
            {Array.from({ length: rows }, (_, i) => (
              <div key={i} className="flex min-h-14 items-center gap-3 px-2 py-2">
                <SkeletonBlock className="h-9 w-9 shrink-0 rounded-xl" />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <SkeletonBlock className="h-4" style={{ width: `${62 - ((i * 11) % 24)}%` }} />
                  <SkeletonBlock className="h-3 w-1/3" />
                </div>
                <SkeletonBlock className="h-4 w-16" />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export default function DailyFeedPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t } = feedI18n.useT();
  const { user, canEdit, isCurator, isAdmin } = useAuth();
  const isStaff = isCurator || isAdmin;
  const userId = user?.traderName ?? undefined;
  const me = user?.traderName ?? "";

  /* ── data: auto stream (paged) + manual announcements ── */
  const stream = useFeedStream();
  const today = stream.first?.today ?? nyDate();
  const { data: postsRaw, isLoading: postsLoading } = useListDailyFeed();
  const posts = useMemo(
    () => ((postsRaw ?? []) as FeedEntry[]).slice().sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)),
    [postsRaw],
  );
  const baseline = useSeenBaseline(stream.first, canEdit);
  const viewer = useFeedViewerState(user?.traderName ?? user?.role ?? "anon");
  const ack = useFeedAck(me);

  /* ── filters ── */
  const [catRaw, setCat] = usePersistentState<Cat>("feed.cat", "all");
  const cat: Cat = CAT_VALUES.includes(catRaw) ? catRaw : "all";
  const [query, setQuery] = useState("");
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<number | null>(null);
  const dayQ = useFeedStreamDay(selectedDay);
  const searchRef = useRef<HTMLInputElement | null>(null);

  /* ── editing / actions ── */
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<DailyFeed | null>(null);
  const [form, setForm] = useState<FeedForm>(blankForm());
  const [digestOpen, setDigestOpen] = useState(false);
  const [regenLoading, setRegenLoading] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [eodLoading, setEodLoading] = useState(false);
  const [eodPending, setEodPending] = useState<{ date: string; lastSyncedAt: string | null } | null>(null);

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: getListDailyFeedQueryKey() });
    qc.invalidateQueries({ queryKey: STREAM_KEY });
  }, [qc]);
  const undo = useUndoDelete(invalidate);
  const onMutErr = (e: unknown) => toast({ title: commonI18n.t("states.error"), description: humanizeApiError(e), variant: "destructive" });
  const createMut = useCreateDailyFeed({ mutation: { onError: onMutErr } });
  const updateMut = useUpdateDailyFeed({ mutation: { onError: onMutErr } });
  const deleteMut = useDeleteDailyFeed({ mutation: { onError: onMutErr } });

  /* ── deep links: ?highlight=<announcement id> / ?date=YYYY-MM-DD ── */
  useEffect(() => {
    const apply = (id: number | null, date: string | null) => {
      if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) setSelectedDay(date);
      if (id) setFocusId(id);
    };
    try {
      const p = new URLSearchParams(window.location.search);
      const hid = Number(p.get("highlight"));
      apply(Number.isFinite(hid) && hid > 0 ? hid : null, p.get("date"));
    } catch { /* ignore */ }
    const onNav = (e: Event) => {
      const d = (e as CustomEvent<{ path?: string; highlightId?: number }>).detail;
      if (d?.path === "/dailyfeed" && d.highlightId) apply(d.highlightId, null);
    };
    window.addEventListener("ws-search-navigate", onNav);
    return () => window.removeEventListener("ws-search-navigate", onNav);
  }, []);
  useEffect(() => {
    if (!focusId || !posts.length) return;
    const f = posts.find((x) => x.id === focusId);
    if (!f) return;
    setCat("all");
    setSelectedDay(dayOf(f));
    const t = setTimeout(() => setFocusId(null), 4000);
    return () => clearTimeout(t);
  }, [focusId, posts, setCat]);

  /* ── scope: one picked day, or the loaded pages ── */
  const scopeItems: StreamItem[] = selectedDay ? (dayQ.data?.items ?? []) : stream.items;
  const scopePosts = useMemo(() => {
    if (selectedDay) return posts.filter((p) => dayOf(p) === selectedDay);
    if (stream.unavailable || !stream.hasNextPage || !stream.loadedFrom) return posts;
    return posts.filter((p) => dayOf(p) >= stream.loadedFrom!);
  }, [posts, selectedDay, stream.unavailable, stream.hasNextPage, stream.loadedFrom]);

  const unreadPostIds = useMemo(
    () => new Set(posts.filter((f) => entryIsUnread(f, me, viewer)).map((f) => f.id)),
    [posts, me, viewer],
  );
  const serverAcks = posts.some(hasServerAcks);

  const catCounts = useMemo(() => {
    const c: Record<Cat, number> = { all: 0, mine: 0, desk: 0, achievement: 0, market: 0, announcement: 0 };
    for (const it of scopeItems) {
      c.all++;
      for (const k of it.cats) c[k]++;
    }
    c.all += scopePosts.length;
    c.announcement += scopePosts.length;
    return c;
  }, [scopeItems, scopePosts]);

  const q = query.trim().toLowerCase();
  const days = useMemo(() => {
    const m = new Map<string, { items: StreamItem[]; posts: FeedEntry[] }>();
    const slot = (d: string) => {
      let s = m.get(d);
      if (!s) { s = { items: [], posts: [] }; m.set(d, s); }
      return s;
    };
    for (const it of scopeItems) {
      if (cat !== "all" && !it.cats.includes(cat)) continue;
      if (q && !itemHay(it).includes(q)) continue;
      slot(it.date).items.push(it);
    }
    if (cat === "all" || cat === "announcement") {
      for (const p of scopePosts) {
        if (q && !postHay(p).includes(q)) continue;
        slot(dayOf(p)).posts.push(p);
      }
    }
    return Array.from(m.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [scopeItems, scopePosts, cat, q]);

  /** My own day result per date (header number) — from the unfiltered stream. */
  const myNetByDay = useMemo(() => {
    const out = new Map<string, number>();
    for (const it of [...stream.items, ...(dayQ.data?.items ?? [])]) {
      if (it.kind === "day_result" && it.trader === me && it.value != null) out.set(it.date, it.value);
    }
    return out;
  }, [stream.items, dayQ.data, me]);

  const newItems = useMemo(() => stream.items.filter((it) => isNewItem(it, baseline)), [stream.items, baseline]);
  const newTotal = newItems.length + posts.filter((p) => unreadPostIds.has(p.id)).length;

  /* ── calendar ── */
  const calCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of stream.items) m.set(it.date, (m.get(it.date) ?? 0) + 1);
    for (const p of posts) m.set(dayOf(p), (m.get(dayOf(p)) ?? 0) + 1);
    return m;
  }, [stream.items, posts]);
  const calNewDays = useMemo(() => {
    const s = new Set(newItems.map((i) => i.date));
    for (const p of posts) if (unreadPostIds.has(p.id)) s.add(dayOf(p));
    return s;
  }, [newItems, posts, unreadPostIds]);
  const calTradeDays = useMemo(
    () => new Set(stream.items.filter((i) => i.kind === "day_result" && (i.trader === me || isStaff)).map((i) => i.date)),
    [stream.items, me, isStaff],
  );

  /* ── summary («Сводка») ── */
  const summary = useMemo(() => {
    const mine = stream.items.filter((i) => i.trader === me);
    const lastDay = mine.find((i) => i.kind === "day_result") ?? null;
    const lastWeek = mine.find((i) => i.kind === "weekly_summary") ?? null;
    const achievements = stream.items.filter((i) => i.cats.includes("achievement") && i.date >= addDays(today, -13)).length;
    const myMarket = stream.items.filter((i) => i.kind === "event" && i.cats.includes("mine") && i.date === today).length;
    return { lastDay, lastWeek, achievements, myMarket };
  }, [stream.items, me, today]);

  const hasFilters = !!(q || selectedDay || cat !== "all");
  const clearFilters = useCallback(() => { setQuery(""); setSelectedDay(null); setCat("all"); }, [setCat]);

  const stepDay = useCallback((dir: -1 | 1) => {
    if (!selectedDay) {
      if (dir === -1) setSelectedDay(days[0]?.[0] ?? today);
      return;
    }
    const next = stepWeekday(selectedDay, dir);
    if (next <= today) setSelectedDay(next);
  }, [selectedDay, days, today]);

  const openNew = useCallback(() => {
    if (!canEdit) return;
    setForm(blankForm(selectedDay ?? today));
    setEditing(null);
    setEditorOpen(true);
  }, [canEdit, selectedDay, today]);

  /* ── keyboard: N announcement · / search · J/K day back/forward · Esc reset ── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target) || document.querySelector("[role=dialog]")) return;
      const k = e.key.toLowerCase();
      // Same physical keys on the Russian layout (Т = N, О = J, Л = K).
      if (k === "n" || k === "т") { if (canEdit) { e.preventDefault(); openNew(); } } // i18n-ignore
      else if (e.key === "/") { e.preventDefault(); searchRef.current?.focus(); }
      else if (k === "j" || k === "о") { e.preventDefault(); stepDay(-1); } // i18n-ignore
      else if (k === "k" || k === "л") { e.preventDefault(); stepDay(1); } // i18n-ignore
      else if (e.key === "Escape" && hasFilters) { clearFilters(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canEdit, openNew, stepDay, hasFilters, clearFilters]);

  /* ── actions ── */
  async function handleRegen(force: boolean) {
    setRegenLoading(true);
    try {
      const data = (await http.post<{ skipped?: boolean } | null>(`/api/market-brief/generate-feed${force ? "?force=1" : ""}`)) ?? {};
      toast({
        title: data.skipped ? t("toast.briefExists") : t("toast.briefReady"),
        description: data.skipped ? t("toast.briefExistsText") : t("toast.briefReadyText"),
      });
      invalidate();
    } catch (e) {
      toast({ title: commonI18n.t("states.error"), description: humanizeApiError(e), variant: "destructive" });
    } finally {
      setRegenLoading(false);
    }
  }

  function openEdit(f: DailyFeed) { setForm(feedToForm(f)); setEditing(f); setEditorOpen(true); }

  async function handleSave() {
    if (!form.date) return;
    try {
      if (editing) {
        await updateMut.mutateAsync({ id: editing.id, data: formToBody(form) as UpdateDailyFeedBody });
        toast({ title: t("toast.updated") });
      } else {
        const created = await createMut.mutateAsync({ data: formToBody(form) });
        if (created && typeof (created as DailyFeed).id === "number") viewer.markRead((created as DailyFeed).id);
        toast({ title: t("toast.published") });
      }
      invalidate();
      setEditorOpen(false);
      setEditing(null);
    } catch { /* toast in onError */ }
  }

  function handleDelete(f: DailyFeed) {
    deleteMut.mutate({ id: f.id }, {
      onSuccess: () => {
        invalidate();
        undo.scheduleUndo(f.id, "dailyfeed", t("toast.undoLabel", { date: fmtDate(dayOf(f), "dayMonth") }));
      },
    });
  }

  async function saveShotNotes(f: DailyFeed, notes: string[]) {
    try {
      await http.patch(`/api/dailyfeed/${f.id}`, { screenshotNotes: JSON.stringify(notes) });
      invalidate();
    } catch {
      toast({ title: t("toast.captionFailed"), variant: "destructive" });
    }
  }

  async function copyEntry(f: DailyFeed) {
    try {
      await navigator.clipboard.writeText(entryToText(f));
      toast({ title: commonI18n.t("states.copied"), description: t("toast.copiedText") });
    } catch {
      toast({ title: commonI18n.t("states.copyFailed"), variant: "destructive" });
    }
  }

  const ackErr = (e: unknown) => toast({ title: t("toast.ackFailed"), description: humanizeApiError(e), variant: "destructive" });
  function markRead(f: FeedEntry) {
    viewer.markRead(f.id);
    if (canEdit && hasServerAcks(f) && !f.acks.mine.includes("read")) ack(f.id, "read", true).catch(ackErr);
  }
  function markUnread(f: FeedEntry) {
    viewer.markUnread(f.id, f.createdAt);
    if (canEdit && hasServerAcks(f) && f.acks.mine.includes("read")) ack(f.id, "read", false).catch(ackErr);
  }
  function toggleAck(f: FeedEntry, kind: Exclude<AckKind, "read">) {
    if (!canEdit || !hasServerAcks(f)) return;
    ack(f.id, kind, !f.acks.mine.includes(kind)).catch(ackErr);
  }

  /* EOD recap (staff): the API waits for the trade sync of that day unless forced. */
  async function closeDay(force = false) {
    const date = selectedDay ?? today;
    setEodLoading(true);
    try {
      let j: { updated?: boolean } | null;
      try {
        j = await http.post<{ updated?: boolean } | null>(`/api/dailyfeed/eod?date=${date}${force ? "&force=1" : ""}`);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && e.code === "SYNC_PENDING") { setEodPending({ date, lastSyncedAt: e.field<string | null>("lastSyncedAt") ?? null }); return; }
        if (e instanceof ApiError && e.status === 409 && e.code === "SYNC_RUNNING") { toast({ title: t("toast.syncRunning"), description: t("toast.syncRunningText") }); return; }
        throw e;
      }
      invalidate();
      setSelectedDay(date);
      toast({ title: j?.updated ? t("toast.dayUpdated") : t("toast.dayWritten"), description: formatDayLong(date) });
    } catch (e) {
      toast({ title: t("toast.closeFailed"), description: humanizeApiError(e), variant: "destructive" });
    } finally {
      setEodLoading(false);
    }
  }

  const todayPost = posts.find((f) => dayOf(f) === today) ?? null;
  const streamLoading = selectedDay ? dayQ.isLoading : stream.isLoading;
  const streamError = selectedDay ? dayQ.error : stream.error;
  const unavailable = stream.unavailable;
  const softError = !unavailable && !!streamError && !streamLoading;
  const loading = (streamLoading && !unavailable) || postsLoading;
  const nothingAtAll = !loading && !stream.items.length && !posts.length && !softError;

  /* ── render pieces ── */
  const header = (
    <PageHeader
      title={t("page.title")}
      icon={Newspaper}
      description={t("page.description")}
      meta={
        <>
          {newTotal > 0 ? (
            <Pill tone="accent" dot>{t("page.newSinceVisit", { count: newTotal })}</Pill>
          ) : baseline ? (
            <span>{t("page.nothingNew")}</span>
          ) : null}
          {stream.dataUpdatedAt > 0 && <UpdatedAgo at={stream.dataUpdatedAt} />}
        </>
      }
      actions={
        <>
          {canEdit && (
            isStaff ? (
              <Button onClick={openNew} title={t("page.announceTitle")}>
                <Megaphone aria-hidden="true" /> {t("page.announce")}
              </Button>
            ) : (
              <Button variant="outline" onClick={openNew} title={t("page.noteTitle")}>
                <PenLine aria-hidden="true" /> {t("page.note")}
              </Button>
            )
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label={commonI18n.t("actions.moreActions")} title={commonI18n.t("actions.more")}>
                {eodLoading || regenLoading ? <RefreshCw className="animate-spin" aria-hidden="true" /> : <MoreHorizontal aria-hidden="true" />}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuItem onSelect={() => setDigestOpen(true)}>
                <Bell aria-hidden="true" /> {t("page.digest")}
              </DropdownMenuItem>
              {isStaff && (
                <DropdownMenuItem disabled={eodLoading} onSelect={() => closeDay(false)}>
                  <ClipboardCheck aria-hidden="true" /> {t("page.closeDay", { date: fmtDate(selectedDay ?? today, "dayMonth") })}
                </DropdownMenuItem>
              )}
              {isStaff && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem disabled={regenLoading} onSelect={() => (todayPost ? setConfirmRegen(true) : handleRegen(false))}>
                    <Bot aria-hidden="true" /> {todayPost ? t("page.regen") : t("page.brief")}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    />
  );

  const toolbar = (
    <Toolbar className="sticky-top">
      <Segmented<Cat>
        ariaLabel={t("page.whatToShow")}
        size="sm"
        value={cat}
        onChange={setCat}
        options={CAT_VALUES.map((v) => ({ value: v, label: catLabel(v), count: loading ? undefined : catCounts[v] || undefined }))}
      />
      <div className="relative min-w-[200px] flex-1">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          ref={searchRef}
          aria-label={t("page.searchAria")}
          title={t("page.searchTitle")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") { setQuery(""); (e.target as HTMLInputElement).blur(); } }}
          placeholder={t("page.searchPlaceholder")}
          className="pl-10 pr-9"
        />
        {query && (
          <button type="button" aria-label={commonI18n.t("actions.clearSearch")} onClick={() => setQuery("")} className="absolute right-1.5 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground">
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </Toolbar>
  );

  const dayNav = selectedDay && (
    <div className="flex flex-wrap items-center gap-2" aria-label={t("page.selectedDay")}>
      <div className="glass-field inline-flex items-center gap-1 p-1">
        <button type="button" aria-label={t("page.prevDay")} title={t("page.prevDayTitle")} onClick={() => stepDay(-1)} className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="px-1 text-sm font-medium text-foreground">{formatDayLong(selectedDay)}</span>
        <button type="button" aria-label={t("page.nextDay")} title={t("page.nextDayTitle")} disabled={stepWeekday(selectedDay, 1) > today} onClick={() => stepDay(1)} className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground disabled:opacity-40">
          <ChevronRight className="h-4 w-4" />
        </button>
        <button type="button" aria-label={t("page.allDaysAria")} title={t("page.allDaysTitle")} onClick={() => setSelectedDay(null)} className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <Link href={links.dayReport(selectedDay)} className="chip inline-flex min-h-8 items-center gap-1.5 px-3 text-xs font-medium">
        <NotebookPen className="h-3.5 w-3.5" aria-hidden="true" /> {t("page.dayReport")}
      </Link>
    </div>
  );

  const banner = unavailable ? (
    <div className="glass-panel flex items-start gap-3 rounded-2xl p-[var(--panel-p)] text-sm" role="status">
      <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      <p className="text-muted-foreground">
        {t("page.unavailable")}
      </p>
    </div>
  ) : softError ? (
    <div className="glass-panel flex flex-wrap items-center gap-3 rounded-2xl p-[var(--panel-p)] text-sm" role="alert">
      <AlertTriangle className="h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-muted-foreground">{t("page.softError")}</p>
      <Button variant="outline" size="sm" onClick={() => (selectedDay ? dayQ.refetch() : stream.refetch())}>
        <RefreshCw aria-hidden="true" /> {commonI18n.t("actions.retry")}
      </Button>
    </div>
  ) : null;

  let body: ReactNode;
  if (loading) {
    body = <FeedSkeleton />;
  } else if (nothingAtAll) {
    body = (
      <Panel>
        <EmptyState
          icon={Newspaper}
          title={t("page.emptyTitle")}
          description={t("page.emptyText")}
          action={canEdit ? <Button variant="outline" onClick={openNew}><PenLine aria-hidden="true" />{isStaff ? t("page.announce") : t("page.note")}</Button> : undefined}
        />
      </Panel>
    );
  } else if (!days.length) {
    body = (
      <Panel>
        {selectedDay && !q && cat === "all" ? (
          <EmptyState
            compact
            icon={CalendarDays}
            title={t("page.noDayEvents", { date: fmtDate(selectedDay, "dayMonth") })}
            description={t("page.noDayEventsText")}
            action={<Button variant="outline" size="sm" onClick={() => setSelectedDay(null)}>{t("page.allDays")}</Button>}
          />
        ) : (
          <EmptyState
            compact
            icon={Search}
            title={commonI18n.t("states.nothingFound")}
            description={t("page.tryOther")}
            action={<Button variant="outline" size="sm" onClick={clearFilters}><X aria-hidden="true" />{commonI18n.t("actions.reset")}</Button>}
          />
        )}
      </Panel>
    );
  } else {
    body = (
      <div className="flex flex-col gap-6">
        {days.map(([day, { items, posts: dayPosts }]) => {
          const entries = groupDay(items);
          const newCount = items.filter((i) => isNewItem(i, baseline)).length + dayPosts.filter((p) => unreadPostIds.has(p.id)).length;
          return (
            <section key={day} className="flex flex-col gap-2" aria-label={formatDayLong(day)}>
              <StreamDayHeader
                day={day}
                today={today}
                myNet={items.some((i) => i.kind === "day_result" && i.trader === me) ? null : myNetByDay.get(day) ?? null}
                newCount={newCount}
                count={items.length + dayPosts.length}
              />
              {dayPosts.map((f) => (
                <FeedEntryCard
                  key={f.id}
                  feed={f}
                  unread={unreadPostIds.has(f.id)}
                  autoRead
                  me={me}
                  onAck={canEdit && serverAcks ? (k) => toggleAck(f, k) : undefined}
                  bookmarked={viewer.bookmarkSet.has(f.id)}
                  query={query.trim()}
                  activeTickers={[]}
                  activeTags={[]}
                  tradedTickers={new Map()}
                  canEdit={canEdit}
                  focused={focusId === f.id}
                  playbookPayload={buildPlaybookPayload(f)}
                  onToggleTicker={(t) => setQuery(t)}
                  onToggleTag={(t) => setQuery(splitList(t)[0] ?? t)}
                  onBookmark={() => viewer.toggleBookmark(f.id)}
                  onMarkRead={() => markRead(f)}
                  onMarkUnread={() => markUnread(f)}
                  onCopy={() => copyEntry(f)}
                  onEdit={() => openEdit(f)}
                  onDelete={() => handleDelete(f)}
                  onNotesChange={(n) => saveShotNotes(f, n)}
                />
              ))}
              {entries.length > 0 && (
                <div className="glass-panel flex flex-col rounded-2xl p-1.5">
                  {entries.map((e) =>
                    e.type === "group"
                      ? <StreamGroup key={e.key} group={e.group} items={e.items} baseline={baseline} />
                      : <StreamRow key={e.key} item={e.item} baseline={baseline} />,
                  )}
                </div>
              )}
            </section>
          );
        })}
        {!selectedDay && stream.hasNextPage && (
          <Button variant="outline" className="self-center" disabled={stream.isFetchingNextPage} onClick={() => stream.fetchNextPage()}>
            {stream.isFetchingNextPage ? <RefreshCw className="animate-spin" aria-hidden="true" /> : <CalendarRange aria-hidden="true" />}
            {t("page.showEarlier")}
          </Button>
        )}
      </div>
    );
  }

  const aside = (
    <div className="flex flex-col gap-[var(--grid-gap)]">
      <Panel title={t("page.summary")} icon={TrendingUp}>
        <dl className="flex flex-col gap-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted-foreground">{t("page.lastTradingDay")}</dt>
            <dd className="text-right">
              {summary.lastDay ? (
                <Link href={summary.lastDay.href ?? links.dayReport(summary.lastDay.date)} className="inline-flex flex-col items-end hover:underline">
                  <span className={cn("font-semibold tabular-nums", toneText(toneOf(summary.lastDay.value)))}>{fmtValue(summary.lastDay.value, "usd") ?? "—"}</span>
                  <span className="text-xs text-muted-foreground">{fmtDate(summary.lastDay.date, "dayMonth")}</span>
                </Link>
              ) : <span className="text-muted-foreground">—</span>}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted-foreground">{t("page.lastWeek")}</dt>
            <dd className="text-right">
              {summary.lastWeek ? (
                <Link href={summary.lastWeek.href ?? links.weeklyReview()} className="inline-flex flex-col items-end hover:underline">
                  <span className={cn("font-semibold tabular-nums", toneText(toneOf(summary.lastWeek.value)))}>{fmtValue(summary.lastWeek.value, "usd") ?? "—"}</span>
                  <span className="text-xs text-muted-foreground">{String(summary.lastWeek.meta?.week ?? "")}</span>
                </Link>
              ) : <span className="text-muted-foreground">—</span>}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted-foreground">{t("page.achievements")}</dt>
            <dd>
              <button type="button" className="font-semibold tabular-nums text-foreground hover:underline" onClick={() => { setSelectedDay(null); setCat("achievement"); }}>
                {summary.achievements}
              </button>
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="inline-flex items-center gap-1.5 text-muted-foreground"><Zap className="h-3.5 w-3.5" aria-hidden="true" />{t("page.myTickersToday")}</dt>
            <dd>
              <button type="button" className="font-semibold tabular-nums text-foreground hover:underline" onClick={() => { setSelectedDay(null); setCat("market"); }}>
                {summary.myMarket ? commonI18n.t("units.events", { count: summary.myMarket }) : t("page.quiet")}
              </button>
            </dd>
          </div>
        </dl>
      </Panel>
      <Panel>
        <FeedCalendar
          key={today.slice(0, 7)}
          anchor={today}
          counts={calCounts}
          unreadDays={calNewDays}
          tradeDays={calTradeDays}
          selected={selectedDay}
          onSelect={setSelectedDay}
          today={today}
        />
      </Panel>
    </div>
  );

  return (
    <Page>
      {header}
      <div className="grid items-start gap-[var(--grid-gap)] lg:grid-cols-[minmax(0,1fr)_300px]">
        <main className="flex min-w-0 flex-col gap-4" aria-label={t("page.title")}>
          {toolbar}
          {dayNav}
          {banner}
          {body}
        </main>
        <aside className="hidden lg:sticky lg:top-[var(--sticky-top)] lg:z-sticky lg:block" aria-label={t("page.asideAria")}>
          {aside}
        </aside>
      </div>

      <FeedEditorDialog
        open={editorOpen}
        onOpenChange={(v) => { if (!v) { setEditorOpen(false); setEditing(null); } }}
        form={form}
        setForm={setForm}
        editing={editing}
        saving={createMut.isPending || updateMut.isPending}
        onSave={handleSave}
        userId={userId}
      />

      <DigestSheet open={digestOpen} onOpenChange={setDigestOpen} />

      <AlertDialog open={!!eodPending} onOpenChange={(v) => { if (!v) setEodPending(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("page.eodTitle", { date: eodPending ? fmtDate(eodPending.date, "dayMonth") : "" })}</AlertDialogTitle>
            <AlertDialogDescription>
              {eodPending?.lastSyncedAt
                ? t("page.eodLast", { time: fmtDate(eodPending.lastSyncedAt, "shortDateTimeSeconds") })
                : t("page.eodNever")}{" "}
              {t("page.eodText")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("page.eodWait")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setEodPending(null); closeDay(true); }}>{t("page.eodForce")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmRegen} onOpenChange={setConfirmRegen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("page.regenTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("page.regenText")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{commonI18n.t("actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setConfirmRegen(false); handleRegen(true); }}>{t("page.regenConfirm")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {undo.pending && (
        <UndoToast
          key={undo.pending.id}
          label={undo.pending.label}
          onUndo={undo.restore}
          onDismiss={undo.dismiss}
          restoring={undo.restoring}
        />
      )}
    </Page>
  );
}
