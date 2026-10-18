import { useEffect, useMemo, useRef, useState } from "react";
import {
  useListDiscussions, useDeleteDiscussion, getListDiscussionsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient, useQuery, useMutation } from "@tanstack/react-query";
import {
  MessagesSquare, Plus, Search, X, Bell, AtSign, Activity, Briefcase, ArrowDownUp, SearchX, Keyboard, Lock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Page, PageHeader, StatCard, StatGrid, Segmented, FilterChip, EmptyState, Pill } from "@/components/ds";
import { QueryError } from "@/components/query-error";
import { UndoToast } from "@/components/undo-toast";
import { useAuth } from "@/contexts/auth-context";
import { useToast } from "@/hooks/use-toast";
import { http } from "@/lib/api/http";
import { humanizeApiError, nullIfMissing } from "@/lib/api/errors";
import { STALE } from "@/lib/api/keys";
import { cn } from "@/lib/utils";
import { ThreadListItem } from "@/components/discussions/ThreadList";
import { ThreadView } from "@/components/discussions/ThreadView";
import { ThreadFormDialog } from "@/components/discussions/ThreadFormDialog";
import { ReportDialog, type ReportTarget } from "@/components/discussions/ReportDialog";
import { addressedToMe, audienceText, isRestricted, sortTokens, tokenLabel, useAudienceOptions } from "@/components/discussions/audience";
import {
  type Thread, type VoteMap, type VoteAgg, type TickerStat, type SortKey, type ViewKey,
  type ThreadContext,
  SORT_LABELS, TYPES, TYPE_LABELS, sortThreads, threadMatches, threadMentions, isResolved, isUnread,
  loadSeen, saveSeen, seenAt, lastActivity, loadPrefs, savePrefs, participants, teamPositions, isTypingTarget,
  isFreshThread, isActiveToday,
} from "@/components/discussions/lib";
import { discussionsI18n } from "@/i18n/ns/discussions";
import { commonI18n } from "@/i18n/ns/common";
import { personName } from "@/i18n";

function readIntParam(name: string): number | null {
  const n = Number(readParam(name));
  return Number.isInteger(n) && n > 0 ? n : null;
}

function readParam(name: string): string | null {
  try { return new URLSearchParams(window.location.search).get(name); } catch { return null; }
}

function writeParams(patch: Record<string, string | null>) {
  try {
    const url = new URL(window.location.href);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "") url.searchParams.delete(k);
      else url.searchParams.set(k, v);
    }
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  } catch { /* ignore */ }
}

/** Audience tab: "all" | "me" (addressed to my stage / curators / my cohort) | "public" | a single token. */
type AudienceFilter = string;
const UNREAD_BADGE_KEY = ["shell", "discussions-unread"] as const;

export default function Discussions() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user, dbUsers, canEdit, isCurator } = useAuth();
  const { t } = discussionsI18n.useT();
  const tc = commonI18n.useT().t;
  const me = user?.traderName ?? tc("roles.guest");
  const traderNames = useMemo(() => dbUsers.filter((u) => u.active).map((u) => u.name), [dbUsers]);

  // ── State ──────────────────────────────────────────────────────────────
  const [prefs, setPrefs] = useState(loadPrefs);
  useEffect(() => savePrefs(prefs), [prefs]);
  // ?q= deep link (e.g. «Обсуждения» from the curator group view: threads by / with a person).
  const [q, setQ] = useState(() => readParam("q") ?? "");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [audienceFilter, setAudienceFilter] = useState<AudienceFilter>(() => readParam("for") || "all");
  const [tickerFilter, setTickerFilter] = useState<string | null>(() => readParam("ticker")?.toUpperCase() || null);
  const [selectedId, setSelectedId] = useState<number | null>(() => {
    const t = Number(readParam("thread"));
    return Number.isInteger(t) && t > 0 ? t : null;
  });
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Thread | null>(null);
  // Cross-links: /discussions?new=1&tradeId=…&ticker=…&eventId=…&ideaId=…&playbookId=…&journalDate=…&type=…
  const [formContext, setFormContext] = useState<ThreadContext | undefined>(() => {
    const c: ThreadContext = {
      tradeId: readIntParam("tradeId"), eventId: readIntParam("eventId"), ideaId: readIntParam("ideaId"), playbookId: readIntParam("playbookId"),
      journalDate: /^\d{4}-\d{2}-\d{2}$/.test(readParam("journalDate") ?? "") ? readParam("journalDate") : null,
    };
    return Object.values(c).some((v) => v != null) ? c : undefined;
  });
  const [formType] = useState<string | undefined>(() => readParam("type") ?? undefined);
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null);
  const [seen, setSeen] = useState(loadSeen);
  const [openedSeenAt, setOpenedSeenAt] = useState<string>(seen.init);
  const [undo, setUndo] = useState<{ id: number; label: string } | null>(null);
  const [restoring, setRestoring] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // ── Data ───────────────────────────────────────────────────────────────
  const { data: rawThreads, isLoading, isError, error, refetch } = useListDiscussions();
  const threads = (rawThreads ?? []) as Thread[];
  // Who-can-see options (groups, cohort names, the viewer's own tokens). The list itself is already audience-filtered server-side.
  const { data: audienceOpts } = useAudienceOptions(!!user);

  const { data: tickerStats = [] } = useQuery<TickerStat[]>({
    queryKey: ["discussions-tickers"],
    queryFn: ({ signal }) => http.get<TickerStat[]>("/api/discussions/tickers", { signal }).then((d) => (Array.isArray(d) ? d : [])),
    staleTime: STALE.default,
  });

  // Viewer identity comes from the auth token — no `?trader=` / body identity.
  const votesKey = ["discussions-votes", me] as const;
  const { data: votes = {} } = useQuery<VoteMap>({
    queryKey: votesKey,
    queryFn: ({ signal }) => http.get<VoteMap>("/api/discussions/votes/all", { signal }),
    staleTime: 5_000,
  });

  // Server-side read tracking (discussion_reads).
  const serverUnread = threads.length > 0 && threads[0].unread !== undefined;
  const readMut = useMutation({
    mutationFn: async (id: number) => {
      await http.post(`/api/discussions/${id}/read`).catch(nullIfMissing);
    },
    onMutate: (id) => {
      const now = new Date().toISOString();
      qc.setQueryData<Thread[]>(getListDiscussionsQueryKey(), (old) => old?.map((d) => d.id === id && d.unread !== undefined ? { ...d, unread: false, mentionsMe: false, readAt: now } : d));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: UNREAD_BADGE_KEY }),
  });

  // Optimistic votes: update the map instantly, roll back on error.
  const voteMut = useMutation({
    mutationFn: (v: { id: number; value: number }) =>
      http.post<VoteAgg & { discussionId: number }>(`/api/discussions/${v.id}/vote`, { value: v.value }),
    onMutate: async ({ id, value }) => {
      await qc.cancelQueries({ queryKey: votesKey });
      const prev = qc.getQueryData<VoteMap>(votesKey);
      qc.setQueryData<VoteMap>(votesKey, (old = {}) => {
        const cur = old[id] ?? { upvotes: 0, downvotes: 0, score: 0, myVote: null };
        let { upvotes, downvotes } = cur;
        if (cur.myVote === 1) upvotes--;
        if (cur.myVote === -1) downvotes--;
        if (value === 1) upvotes++;
        if (value === -1) downvotes++;
        return { ...old, [id]: { upvotes, downvotes, score: upvotes - downvotes, myVote: value === 0 ? null : value } };
      });
      return { prev };
    },
    onError: (e: Error, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(votesKey, ctx.prev);
      toast({ title: tc("states.error"), description: humanizeApiError(e, t("page.voteFailed")), variant: "destructive" });
    },
    onSuccess: (res) => {
      qc.setQueryData<VoteMap>(votesKey, (old = {}) => ({ ...old, [res.discussionId]: { upvotes: res.upvotes, downvotes: res.downvotes, score: res.score, myVote: res.myVote } }));
    },
  });

  function handleVote(id: number, value: 1 | -1) {
    if (!canEdit) return;
    const cur = votes[id]?.myVote;
    voteMut.mutate({ id, value: cur === value ? 0 : value });
  }

  const deleteMut = useDeleteDiscussion({
    mutation: {
      onSuccess: (_d, vars) => {
        const th = threads.find((x) => x.id === vars.id);
        qc.invalidateQueries({ queryKey: getListDiscussionsQueryKey() });
        qc.invalidateQueries({ queryKey: ["discussions-tickers"] });
        setUndo({ id: vars.id, label: t("page.undoLabel", { topic: (th?.topic ?? "").slice(0, 40) }) });
        if (selectedId === vars.id) selectThread(null);
      },
      onError: (e: unknown) => toast({ title: tc("states.error"), description: humanizeApiError(e), variant: "destructive" }),
    },
  });

  async function restoreDeleted() {
    if (!undo) return;
    setRestoring(true);
    try {
      await http.post(`/api/discussions/${undo.id}/restore`);
      qc.invalidateQueries({ queryKey: getListDiscussionsQueryKey() });
      qc.invalidateQueries({ queryKey: ["discussions-tickers"] });
      selectThread(undo.id);
      toast({ title: t("page.restored") });
    } catch (e) {
      toast({ title: tc("states.error"), description: humanizeApiError(e, t("page.restoreFailed")), variant: "destructive" });
    } finally {
      setRestoring(false);
      setUndo(null);
    }
  }

  // ── Derived ────────────────────────────────────────────────────────────
  const knownTickers = useMemo(() => {
    const s = new Set<string>();
    for (const t of tickerStats) if (t.ticker) s.add(t.ticker.toUpperCase());
    for (const t of threads) if (t.ticker) s.add(t.ticker.toUpperCase());
    return s;
  }, [tickerStats, threads]);

  const unreadIds = useMemo(() => new Set(threads.filter((t) => isUnread(t, seen, me)).map((t) => t.id)), [threads, seen, me]);
  const mentionIds = useMemo(() => new Set(threads.filter((t) => threadMentions(t, me)).map((t) => t.id)), [threads, me]);
  const myPositionIds = useMemo(
    () => new Set(threads.filter((t) => teamPositions(t.comments ?? []).in_position.includes(me)).map((t) => t.id)),
    [threads, me],
  );
  const active24 = useMemo(
    () => threads.filter((t) => Date.now() - new Date(lastActivity(t)).getTime() < 86_400_000).length,
    [threads],
  );
  const unreadMentions = useMemo(() => Array.from(mentionIds).filter((id) => unreadIds.has(id)).length, [mentionIds, unreadIds]);
  const freshIds = useMemo(() => new Set(threads.filter((t) => unreadIds.has(t.id) && isFreshThread(t, me)).map((t) => t.id)), [threads, unreadIds, me]);

  // Audience tabs: only groups that actually occur in the threads this viewer can read.
  const audienceTabs = useMemo(() => {
    const counts = new Map<string, number>();
    let restricted = 0, forMe = 0;
    for (const t of threads) {
      if (!isRestricted(t.audience)) continue;
      restricted++;
      if (addressedToMe(t.audience, audienceOpts)) forMe++;
      for (const tok of t.audience ?? []) counts.set(tok, (counts.get(tok) ?? 0) + 1);
    }
    const tokens = sortTokens(counts.keys()).map((token) => ({ token, count: counts.get(token) ?? 0 }));
    return { restricted, forMe, publicCount: threads.length - restricted, tokens };
  }, [threads, audienceOpts]);
  const showAudienceTabs = audienceTabs.restricted > 0 || audienceFilter !== "all";

  function setAudience(v: AudienceFilter) {
    setAudienceFilter(v);
    writeParams({ for: v === "all" ? null : v });
  }

  const filtered = useMemo(() => {
    const view = prefs.view;
    const list = threads.filter((t) => {
      if (tickerFilter && (t.ticker ?? "").toUpperCase() !== tickerFilter) return false;
      if (typeFilter !== "all" && (t.type || "general") !== typeFilter) return false;
      if (audienceFilter === "me" && !addressedToMe(t.audience, audienceOpts)) return false;
      if (audienceFilter === "public" && isRestricted(t.audience)) return false;
      if (audienceFilter !== "all" && audienceFilter !== "me" && audienceFilter !== "public" && !(t.audience ?? []).includes(audienceFilter)) return false;
      if (view === "unread" && !unreadIds.has(t.id)) return false;
      if (view === "live" && !isActiveToday(t)) return false;
      if (view === "mine" && t.trader !== me && !participants(t).includes(me)) return false;
      if (view === "open" && isResolved(t)) return false;
      if (view === "mentions" && !mentionIds.has(t.id)) return false;
      if (view === "positions" && !myPositionIds.has(t.id)) return false;
      return threadMatches(t, q.trim());
    });
    return sortThreads(list, prefs.sort, votes);
  }, [threads, tickerFilter, typeFilter, audienceFilter, audienceOpts, prefs, unreadIds, mentionIds, myPositionIds, q, votes, me]);

  const selected = useMemo(() => threads.find((t) => t.id === selectedId) ?? null, [threads, selectedId]);

  // ── Selection / unread bookkeeping ─────────────────────────────────────
  function selectThread(id: number | null) {
    setSelectedId(id);
    writeParams({ thread: id ? String(id) : null });
    if (id) {
      const t = threads.find((x) => x.id === id) ?? null;
      setOpenedSeenAt(seenAt(seen, id, t));
      if (serverUnread && canEdit) readMut.mutate(id);
    }
  }

  // Mark the open thread as read (also when new replies arrive while it is open).
  const selectedLast = selected ? lastActivity(selected) : null;
  useEffect(() => {
    if (!selected || !selectedLast) return;
    if (serverUnread) {
      if (selected.unread && canEdit) readMut.mutate(selected.id);
      return;
    }
    setSeen((prev) => {
      const cur = prev.seen[String(selected.id)];
      const nowIso = new Date().toISOString();
      const target = new Date(selectedLast).getTime() > Date.now() ? selectedLast : nowIso;
      if (cur && new Date(cur).getTime() >= new Date(selectedLast).getTime()) return prev;
      const next = { ...prev, seen: { ...prev.seen, [String(selected.id)]: target } };
      saveSeen(next);
      return next;
    });
  }, [selected?.id, selectedLast, selected?.unread]); // eslint-disable-line react-hooks/exhaustive-deps

  // Deep-link: thread id from URL that doesn't exist any more.
  useEffect(() => {
    if (!isLoading && selectedId && rawThreads && !threads.some((t) => t.id === selectedId)) {
      selectThread(null);
    }
  }, [isLoading, rawThreads]); // eslint-disable-line react-hooks/exhaustive-deps

  // Capture "seen before opening" for a deep-linked thread on first load.
  const didInitSeen = useRef(false);
  useEffect(() => {
    if (didInitSeen.current || !selectedId || !selected) return;
    didInitSeen.current = true;
    setOpenedSeenAt(seenAt(seen, selectedId, selected));
  }, [selectedId, selected]); // eslint-disable-line react-hooks/exhaustive-deps

  // ?new=1 (optionally with ?ticker=&tradeId=…) opens the composer — for cross-links from other sections.
  useEffect(() => {
    if (readParam("new") === "1" && canEdit) {
      openCreate(true);
      writeParams({ new: null, tradeId: null, eventId: null, ideaId: null, playbookId: null, journalDate: null, type: null });
    }
  }, [canEdit]); // eslint-disable-line react-hooks/exhaustive-deps

  function setTicker(t: string | null) {
    setTickerFilter(t);
    writeParams({ ticker: t });
  }

  function openCreate(keepContext = false) {
    setEditing(null);
    if (!keepContext) setFormContext(undefined);
    setFormOpen(true);
  }

  async function markAllRead() {
    if (serverUnread) {
      try {
        await http.post("/api/discussions/read-all");
        qc.setQueryData<Thread[]>(getListDiscussionsQueryKey(), (old) => old?.map((d) => ({ ...d, unread: false, mentionsMe: false, readAt: new Date().toISOString() })));
        qc.invalidateQueries({ queryKey: getListDiscussionsQueryKey() });
        qc.invalidateQueries({ queryKey: UNREAD_BADGE_KEY });
      } catch (e) {
        toast({ title: tc("states.error"), description: humanizeApiError(e), variant: "destructive" });
        return;
      }
    } else {
      const now = new Date().toISOString();
      const next = { init: now, seen: {} };
      saveSeen(next);
      setSeen(next);
    }
    toast({ title: t("page.allRead") });
  }

  function resetFilters() {
    setQ("");
    setTypeFilter("all");
    setAudience("all");
    setTicker(null);
    setPrefs((p) => ({ ...p, view: "all" }));
  }

  // ── Keyboard ───────────────────────────────────────────────────────────
  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (document.querySelector("[role=dialog],[role=alertdialog],[role=menu]")) return;
      const list = filteredRef.current;
      if (e.key === "/") { e.preventDefault(); searchRef.current?.focus(); return; }
      // Russian keyboard layout aliases (т = n, о/л = j/k, к = r): input, not text. i18n-ignore
      if ((e.key === "n" || e.key === "т") && canEdit) { e.preventDefault(); openCreate(false); return; }
      if (e.key === "j" || e.key === "k" || e.key === "о" || e.key === "л") { // i18n-ignore
        if (!list.length) return;
        e.preventDefault();
        const idx = list.findIndex((t) => t.id === selectedId);
        const down = e.key === "j" || e.key === "о"; // i18n-ignore
        const next = idx === -1 ? 0 : Math.max(0, Math.min(list.length - 1, idx + (down ? 1 : -1)));
        selectThread(list[next].id);
        requestAnimationFrame(() => listRef.current?.querySelector(`[data-thread-id="${list[next].id}"]`)?.scrollIntoView({ block: "nearest" }));
        return;
      }
      // i18n-ignore (layout alias)
      if ((e.key === "r" || e.key === "к") && selectedId && canEdit) { e.preventDefault(); composerRef.current?.focus(); return; }
      if (e.key === "Escape") {
        if (selectedId) selectThread(null);
        else if (q) setQ("");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }); // re-bind every render: cheap, always sees fresh state

  const extraView = prefs.view === "mentions" || prefs.view === "positions" || prefs.view === "live";
  const hasFilters = !!q.trim() || typeFilter !== "all" || !!tickerFilter || prefs.view !== "all" || audienceFilter !== "all";

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <Page>
      <PageHeader
        title={t("title")}
        icon={MessagesSquare}
        description={t("description")}
        actions={
          canEdit ? (
            <Button onClick={() => openCreate(false)} className="gap-1.5">
              <Plus className="h-4 w-4" />{t("newThread")}
              <kbd className="ml-1 hidden rounded-md bg-white/20 px-1.5 text-2xs font-medium sm:inline">N</kbd>
            </Button>
          ) : undefined
        }
      />

      <StatGrid className={cn(selected && "hidden lg:grid")}>
        <StatCard label={t("page.unreadCard")} value={unreadIds.size} tone={unreadIds.size ? "accent" : "neutral"} icon={Bell}
          hint={freshIds.size ? t("page.freshHint", { count: freshIds.size }) : unreadIds.size ? t("page.clickToShow") : t("page.allReadHint")} onClick={() => setPrefs((p) => ({ ...p, view: "unread" }))} />
        <StatCard label={t("page.mentionsCard")} value={mentionIds.size} tone={unreadMentions ? "accent" : "neutral"} icon={AtSign}
          hint={unreadMentions ? t("page.unreadMentions", { count: unreadMentions }) : `@${personName(me)}`} onClick={() => setPrefs((p) => ({ ...p, view: "mentions" }))} />
        <StatCard label={t("page.liveCard")} value={active24} tone={active24 ? "warn" : "neutral"} icon={Activity}
          hint={t("page.liveHint", { count: threads.length })} onClick={() => setPrefs((p) => ({ ...p, view: "live", sort: "hot" }))} />
        <StatCard label={t("page.positionsCard")} value={myPositionIds.size} tone={myPositionIds.size ? "up" : "neutral"} icon={Briefcase}
          hint={t("page.positionsHint")} onClick={() => setPrefs((p) => ({ ...p, view: "positions" }))} />
      </StatGrid>

      {isError && <QueryError error={error} onRetry={() => refetch()} />}

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(320px,400px)_minmax(0,1fr)] xl:grid-cols-[minmax(360px,440px)_minmax(0,1fr)]">
        {/* ── Thread list ── */}
        <section
          aria-label={t("page.listAria")}
          className={cn(
            "glass-panel flex min-w-0 flex-col rounded-2xl lg:sticky lg:top-[var(--sticky-top)] lg:max-h-[calc(100dvh-var(--header-h)-0.75rem-2*var(--sticky-top))]",
            selected && "hidden lg:flex",
          )}
        >
          <div className="space-y-2 border-b border-[var(--field-border)] p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                ref={searchRef}
                type="search"
                aria-label={t("page.searchAria")}
                placeholder={t("page.searchPlaceholder")}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setQ(""); (e.target as HTMLInputElement).blur(); } }}
                className="pl-10 pr-10"
              />
              {q ? (
                <button type="button" aria-label={tc("actions.clearSearch")} onClick={() => setQ("")} className="absolute right-1.5 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full text-muted-foreground hover:bg-[var(--glass-hover-bg)]">
                  <X className="h-4 w-4" />
                </button>
              ) : (
                <kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded-md border border-[var(--field-border)] px-1.5 text-2xs text-muted-foreground sm:block">/</kbd>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Segmented<ViewKey>
                ariaLabel={t("page.viewAria")}
                size="sm"
                className="min-w-0 flex-1"
                value={extraView ? "all" : prefs.view}
                onChange={(v) => setPrefs((p) => ({ ...p, view: v }))}
                options={[
                  { value: "all", label: t("view.all") },
                  { value: "unread", label: t("view.unread"), count: unreadIds.size || undefined },
                  { value: "mine", label: t("view.mine") },
                  { value: "open", label: t("view.open") },
                ]}
              />
              <Select value={prefs.sort} onValueChange={(v) => setPrefs((p) => ({ ...p, sort: v as SortKey }))}>
                <SelectTrigger aria-label={tc("actions.sort")} className="h-8 w-[124px] shrink-0 gap-1 px-3 text-xs">
                  <ArrowDownUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => <SelectItem key={k} value={k}>{SORT_LABELS[k]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {showAudienceTabs && (
              <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5" role="group" aria-label={t("page.audienceAria")}>
                <FilterChip active={audienceFilter === "all"} onClick={() => setAudience("all")} count={threads.length} className="min-h-8 shrink-0 px-2.5 text-xs">{t("page.allThreads")}</FilterChip>
                {(audienceOpts?.viewer.tokens.length ?? 0) > 0 && (
                  <FilterChip active={audienceFilter === "me"} onClick={() => setAudience(audienceFilter === "me" ? "all" : "me")} count={audienceTabs.forMe} className="min-h-8 shrink-0 px-2.5 text-xs">{t("page.forMe")}</FilterChip>
                )}
                <FilterChip active={audienceFilter === "public"} onClick={() => setAudience(audienceFilter === "public" ? "all" : "public")} count={audienceTabs.publicCount} className="min-h-8 shrink-0 px-2.5 text-xs">{t("audience.everyone")}</FilterChip>
                {audienceTabs.tokens.map(({ token, count }) => (
                  <FilterChip key={token} active={audienceFilter === token} onClick={() => setAudience(audienceFilter === token ? "all" : token)} count={count} className="min-h-8 shrink-0 px-2.5 text-xs">
                    <Lock className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />{tokenLabel(token, audienceOpts)}
                  </FilterChip>
                ))}
                {!["all", "me", "public"].includes(audienceFilter) && !audienceTabs.tokens.some((x) => x.token === audienceFilter) && (
                  <FilterChip active onClick={() => setAudience("all")} className="min-h-8 shrink-0 px-2.5 text-xs">{tokenLabel(audienceFilter, audienceOpts)}</FilterChip>
                )}
              </div>
            )}
            <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5" role="group" aria-label={t("page.typeTickerAria")}>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger aria-label={t("page.typeAria")} className={cn("h-8 w-auto shrink-0 gap-1 px-3 text-xs", typeFilter !== "all" && "text-primary")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("page.allTypes")}</SelectItem>
                  {TYPES.map((ty) => <SelectItem key={ty} value={ty}>{TYPE_LABELS[ty]}</SelectItem>)}
                </SelectContent>
              </Select>
              {tickerStats.slice(0, 12).map((s) => (
                <FilterChip key={s.ticker} active={tickerFilter === s.ticker} onClick={() => setTicker(tickerFilter === s.ticker ? null : s.ticker)} count={s.count} className="min-h-8 shrink-0 px-2.5 text-xs tabular-nums">
                  ${s.ticker}
                </FilterChip>
              ))}
              {tickerFilter && !tickerStats.some((s) => s.ticker === tickerFilter) && (
                <FilterChip active onClick={() => setTicker(null)} className="min-h-8 shrink-0 px-2.5 text-xs">${tickerFilter}</FilterChip>
              )}
            </div>
            {hasFilters && (
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span className="tabular-nums">{t("page.found", { count: filtered.length })}</span>
                {extraView && <Pill tone="accent">{t(`view.${prefs.view}`)}</Pill>}
                <button type="button" onClick={resetFilters} className="ml-auto rounded-full px-2 py-1 text-primary hover:bg-primary/10">{tc("actions.resetFilters")}</button>
              </div>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {isLoading ? (
              <ul className="space-y-1" aria-busy="true" aria-label={t("page.loadingAria")}>
                {Array.from({ length: 6 }).map((_, i) => (
                  <li key={i} className="space-y-2 rounded-xl px-3 py-3">
                    <div className="flex gap-1.5"><Skeleton className="h-4 w-14 rounded-full" /><Skeleton className="h-4 w-12 rounded-full" /><Skeleton className="ml-auto h-3 w-16 rounded-full" /></div>
                    <Skeleton className="h-4 w-4/5 rounded-full" />
                    <Skeleton className="h-3 w-3/5 rounded-full" />
                  </li>
                ))}
              </ul>
            ) : threads.length === 0 && !isError ? (
              <EmptyState
                icon={MessagesSquare}
                title={t("page.emptyTitle")}
                description={t("page.emptyHint")}
                action={canEdit ? <Button onClick={() => openCreate(false)} className="gap-1.5"><Plus className="h-4 w-4" />{t("page.start")}</Button> : undefined}
              />
            ) : filtered.length === 0 ? (
              <EmptyState
                icon={SearchX}
                title={tc("states.nothingFound")}
                description={q.trim() ? t("page.noMatchQuery", { query: q.trim() }) : t("page.noMatchFilters")}
                action={<Button variant="outline" size="sm" onClick={resetFilters}>{tc("actions.resetFilters")}</Button>}
              />
            ) : (
              <ul ref={listRef} className="space-y-0.5">
                {filtered.map((th, i) => (
                  <ThreadListItem
                    key={th.id}
                    t={th}
                    index={i}
                    selected={th.id === selectedId}
                    unread={unreadIds.has(th.id)}
                    mentionsMe={mentionIds.has(th.id) && unreadIds.has(th.id)}
                    fresh={freshIds.has(th.id)}
                    audienceLabel={isRestricted(th.audience) ? audienceText(th.audience, audienceOpts) : null}
                    votes={votes}
                    q={q.trim()}
                    onSelect={selectThread}
                  />
                ))}
              </ul>
            )}
          </div>
          {unreadIds.size > 0 && (
            <div className="border-t border-[var(--field-border)] px-3 py-2 text-right">
              <button type="button" onClick={markAllRead} className="rounded-full px-2 py-1 text-xs text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground">
                {t("page.markAllRead")}
              </button>
            </div>
          )}
        </section>

        {/* ── Thread view ── */}
        <section
          aria-label={selected ? t("page.threadAria", { topic: selected.topic }) : t("page.noThreadAria")}
          className={cn("glass-panel min-w-0 rounded-2xl", !selected && "hidden lg:block")}
        >
          {selected ? (
            <ThreadView
              thread={selected}
              me={me}
              canEdit={canEdit}
              isMod={isCurator}
              votes={votes}
              onVote={handleVote}
              knownTickers={knownTickers}
              traderNames={traderNames}
              q={q.trim()}
              seenAt={openedSeenAt}
              onBack={() => selectThread(null)}
              onEdit={(th) => { setEditing(th); setFormOpen(true); }}
              onDelete={(th) => deleteMut.mutate({ id: th.id })}
              onReport={setReportTarget}
              onTickerFilter={(tk) => { setTicker(tk); selectThread(null); }}
              composerRef={composerRef}
            />
          ) : (
            <EmptyState
              icon={MessagesSquare}
              title={t("page.pickTitle")}
              description={t("page.pickHint")}
              className="min-h-[420px]"
              action={
                <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <Keyboard className="h-3.5 w-3.5" aria-hidden="true" />
                  <span><kbd className="rounded border border-[var(--field-border)] px-1">J</kbd>/<kbd className="rounded border border-[var(--field-border)] px-1">K</kbd> — {t("page.kbdNav")}</span>
                  <span><kbd className="rounded border border-[var(--field-border)] px-1">/</kbd> — {t("page.kbdSearch")}</span>
                  {canEdit && <span><kbd className="rounded border border-[var(--field-border)] px-1">N</kbd> — {t("page.kbdNew")}</span>}
                  {canEdit && <span><kbd className="rounded border border-[var(--field-border)] px-1">R</kbd> — {t("page.kbdReply")}</span>}
                </div>
              }
            />
          )}
        </section>
      </div>

      <ThreadFormDialog
        open={formOpen}
        editing={editing}
        author={me}
        defaultTicker={tickerFilter ?? ""}
        defaultType={formType}
        context={formContext}
        knownTickers={knownTickers}
        onClose={() => { setFormOpen(false); setEditing(null); setFormContext(undefined); }}
        onSaved={(id) => selectThread(id)}
      />

      <ReportDialog target={reportTarget} onClose={() => setReportTarget(null)} />

      {undo && (
        <UndoToast
          key={undo.id}
          label={undo.label}
          actionText={t("page.undoAction")}
          onUndo={restoreDeleted}
          onDismiss={() => setUndo(null)}
          restoring={restoring}
        />
      )}
    </Page>
  );
}
