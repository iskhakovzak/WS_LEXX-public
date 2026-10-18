import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle, AlertTriangle, BookmarkPlus, Check, ChevronLeft, ChevronRight, Copy, Eye, LayoutTemplate, Loader2,
  Mic, MicOff, MoreHorizontal, NotebookPen, RefreshCw, Sparkles, Trash2, X,
} from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { useToast } from "@/hooks/use-toast";
import { EmptyState, Page, PageHeader, Panel, Segmented } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AuthorEditor, type EditorMode, type EditorTarget } from "@/components/notes/author-editor";
import { AuthorDayContext, heldLine, tradeLine } from "@/components/notes/author-day-context";
import { AuthorWeeklyCard } from "@/components/notes/author-weekly";
import { AuthorHistory } from "@/components/notes/author-history";
import { AuthorFeed, feedRange, useAuthorFeed, type FeedRange } from "@/components/notes/author-feed";
import { AuthorMarkdown } from "@/components/notes/author-reader";
import { useDictation } from "@/components/notes/author-dictation";
import { AuthorAudience } from "@/components/notes/author-audience";
import { AuthorPrevPlan } from "@/components/notes/author-prev-plan";
import {
  findPrevPlan, followThroughBlock, hasFollowBlock, moneyMentions, sectionForDigit, type FollowItem,
} from "@/components/notes/author-plan";
import {
  AN_KEYS, BUILTIN_TEMPLATES, MOODS, SECTIONS, addDays, appendText, applyTemplate,
  isIsoDate, loadCustomTemplates, localToday, parseNote, relTime, saveCustomTemplates, serializeNote,
  type Audience, type AuthorNote, type DayContext, type DayTrade, type NoteTemplate, type SectionKey,
} from "@/components/notes/author-model";
import { fmtDate } from "@/lib/format";
import { http } from "@/lib/api/http";
import { isNotFound } from "@/lib/api/errors";
import { STALE } from "@/lib/api/keys";
import { notesI18n } from "@/i18n/ns/notes";
import { commonI18n } from "@/i18n/ns/common";

type View = "write" | "feed" | "history";
type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

const VIEW_KEY = "ws_author_notes_view";
const MODE_KEY = "ws_author_notes_mode";
const RANGE_KEY = "ws_author_notes_range";
const AUTOSAVE_MS = 1500;

function readLS<T extends string>(key: string, allowed: readonly T[], def: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : def;
  } catch { return def; }
}
function writeLS(key: string, v: string) {
  try { localStorage.setItem(key, v); } catch { /* storage unavailable */ }
}

function isTyping(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

function upsertHistory(list: AuthorNote[] | undefined, note: AuthorNote): AuthorNote[] | undefined {
  if (!list) return list;
  const rest = list.filter((n) => n.id !== note.id && n.note_date.slice(0, 10) !== note.note_date.slice(0, 10));
  return [note, ...rest].sort((a, b) => (a.note_date < b.note_date ? 1 : -1));
}

function SaveIndicator({ status, savedAt, now, onRetry }: { status: SaveStatus; savedAt: number | null; now: number; onRetry: () => void }) {
  const { t } = notesI18n.useT();
  if (status === "saving") {
    return <span role="status" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />{t("savingNow")}</span>;
  }
  if (status === "error") {
    return (
      <span role="alert" className="inline-flex items-center gap-1.5 text-xs text-down">
        <AlertCircle className="h-3 w-3" aria-hidden="true" />{t("author.save.notSaved")}
        <button type="button" onClick={onRetry} className="font-medium underline-offset-2 hover:underline">{commonI18n.t("actions.retry")}</button>
      </span>
    );
  }
  if (status === "dirty") {
    return <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><span className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--chart-3))]" aria-hidden="true" />{t("dirty")}</span>;
  }
  if (status === "saved" && savedAt) {
    return <span role="status" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Check className="h-3 w-3 text-up" aria-hidden="true" />{t("author.save.saved", { ago: relTime(savedAt, now) })}</span>;
  }
  return <span className="text-xs text-muted-foreground">{t("author.save.draft")}</span>;
}

export default function AuthorNotesPage() {
  const { user, canEdit } = useAuth();
  const { toast } = useToast();
  const { t } = notesI18n.useT();
  const { t: tc } = commonI18n.useT();
  const qc = useQueryClient();
  const trader = user?.traderName ?? "";
  const today = localToday();

  /* ── View, date, URL ── */
  const initial = useMemo(() => {
    const p = new URLSearchParams(window.location.search);
    const d = p.get("date");
    const v = p.get("view") as View | null;
    return {
      date: isIsoDate(d) && d <= today ? d : today,
      view: v && ["write", "feed", "history"].includes(v) ? v : null,
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [view, setViewState] = useState<View>(() => {
    const v = initial.view ?? readLS<View>(VIEW_KEY, ["write", "feed", "history"], "write");
    return !canEdit && v !== "feed" ? "feed" : v;
  });
  useEffect(() => { if (!canEdit && view !== "feed") setViewState("feed"); }, [canEdit, view]);
  const [date, setDate] = useState(initial.date);
  const [range, setRangeState] = useState<FeedRange>(() => readLS<FeedRange>(RANGE_KEY, ["day", "week", "month"], "week"));
  const setRange = (r: FeedRange) => { setRangeState(r); writeLS(RANGE_KEY, r); };

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (date === today) p.delete("date"); else p.set("date", date);
    if (view === "write") p.delete("view"); else p.set("view", view);
    const qs = p.toString();
    window.history.replaceState(window.history.state, "", window.location.pathname + (qs ? `?${qs}` : ""));
  }, [date, view, today]);

  /* ── Editor state ── */
  const [note, setNote] = useState<AuthorNote | null>(null);
  const [raw, setRaw] = useState("");
  const [mood, setMood] = useState("");
  const [mode, setModeState] = useState<EditorMode>(() => readLS<EditorMode>(MODE_KEY, ["sections", "free"], "sections"));
  const [loadState, setLoadState] = useState<"loading" | "ok" | "error">("loading");
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [improving, setImproving] = useState(false);
  const [showAi, setShowAi] = useState(false);
  const [activeKey, setActiveKey] = useState<EditorTarget | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AuthorNote | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [templates, setTemplates] = useState<NoteTemplate[]>(() => loadCustomTemplates());
  const [tplDialog, setTplDialog] = useState(false);
  const [tplName, setTplName] = useState("");
  const firstFieldRef = useRef<HTMLTextAreaElement | null>(null);

  const rawRef = useRef(raw); rawRef.current = raw;
  const moodRef = useRef(mood); moodRef.current = mood;
  const dateRef = useRef(date); dateRef.current = date;
  const noteRef = useRef(note); noteRef.current = note;
  const loadSeq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setMode = (m: EditorMode) => { setModeState(m); writeLS(MODE_KEY, m); };

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, []);

  /* ── Queries ── */
  const historyQ = useQuery({
    queryKey: AN_KEYS.history(trader),
    queryFn: () => http.get<AuthorNote[]>(`/api/author-notes/history?trader=${encodeURIComponent(trader)}&limit=366`),
    enabled: !!trader && canEdit,
    staleTime: 60_000,
  });
  const historyNotes = historyQ.data ?? [];

  const dayQ = useQuery({
    queryKey: AN_KEYS.day(date),
    queryFn: () => http.get<DayContext>(`/api/author-notes/day-context?date=${date}`),
    enabled: !!trader && canEdit && view === "write",
    staleTime: STALE.short,
  });

  // Reach of the open note (who read / who not yet); refreshed while the author keeps the page open.
  const audienceQ = useQuery({
    queryKey: AN_KEYS.audience(note?.id ?? 0),
    queryFn: () => http.get<Audience>(`/api/author-notes/${note!.id}/audience`),
    enabled: !!note?.id && view === "write",
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  });

  // The last earlier note's «План на завтра» — shown beside the editor to grade follow-through.
  const prevPlan = useMemo(() => findPrevPlan(historyNotes, date), [historyNotes, date]);

  const unreadRange = feedRange(today, "week");
  const unreadQ = useAuthorFeed(unreadRange.from, unreadRange.to, !!trader);
  const unreadCount = (unreadQ.data ?? []).filter((n) => !n.read_by_me && n.trader !== trader && !n.legacy).length;

  /* ── Load note for date ── */
  const loadNote = useCallback(async (d: string) => {
    if (!trader) return;
    const seq = ++loadSeq.current;
    setNote(null); setRaw(""); setMood(""); setShowAi(false);
    setStatus("idle"); setSavedAt(null); setLoadState("loading");
    try {
      const data = await http.get<AuthorNote | null>(`/api/author-notes?trader=${encodeURIComponent(trader)}&date=${d}`);
      if (seq !== loadSeq.current) return;
      if (data && data.id) {
        setNote(data);
        setRaw(data.raw_text || "");
        setMood(data.mood || "");
        setStatus("saved");
        setSavedAt(Date.parse(data.updated_at) || Date.now());
        const p = parseNote(data.raw_text || "");
        if (data.raw_text?.trim()) setModeState(p.structured ? "sections" : "free");
      }
      setLoadState("ok");
    } catch {
      if (seq === loadSeq.current) setLoadState("error");
    }
  }, [trader]);

  useEffect(() => { if (canEdit) void loadNote(date); }, [loadNote, date, canEdit]);

  /* ── Save / autosave ── */
  const save = useCallback(async (opts?: { force?: boolean }): Promise<AuthorNote | null> => {
    if (!trader) return null;
    const d = dateRef.current;
    const text = rawRef.current;
    const m = moodRef.current;
    if (!noteRef.current && !text.trim() && !m && !opts?.force) { setStatus("idle"); return null; }
    setStatus("saving");
    try {
      const data = await http.put<AuthorNote>(`/api/author-notes`, { raw_text: text, note_date: d, mood: m || null });
      if (d === dateRef.current) {
        setNote(data);
        if (rawRef.current === text && moodRef.current === m) { setStatus("saved"); setSavedAt(Date.now()); }
        else setStatus("dirty");
      }
      qc.setQueryData<AuthorNote[]>(AN_KEYS.history(trader), (prev) => upsertHistory(prev, data));
      void qc.invalidateQueries({ queryKey: ["author-notes", "feed"] });
      return data;
    } catch (e) {
      if (d === dateRef.current) setStatus("error");
      toast({ title: notesI18n.t("author.toast.saveFailed"), description: e instanceof Error ? e.message : notesI18n.t("author.toast.checkConnection"), variant: "destructive" });
      return null;
    }
  }, [trader, qc, toast]);

  const saveRef = useRef(save); saveRef.current = save;

  const cancelAutosave = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  const flush = useCallback(() => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    void saveRef.current();
  }, []);
  const scheduleSave = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setStatus("dirty");
    timer.current = setTimeout(() => { timer.current = null; void saveRef.current(); }, AUTOSAVE_MS);
  }, []);

  useEffect(() => {
    const onHide = () => { if (document.visibilityState === "hidden") flush(); };
    document.addEventListener("visibilitychange", onHide);
    return () => { document.removeEventListener("visibilitychange", onHide); flush(); };
  }, [flush]);

  const edit = useCallback((updater: (prev: string) => string) => {
    setRaw((prev) => updater(prev));
    scheduleSave();
  }, [scheduleSave]);

  const changeMood = (m: string) => {
    setMood(m);
    moodRef.current = m;
    cancelAutosave();
    void save({ force: true });
  };

  const manualSave = async () => {
    cancelAutosave();
    const saved = await save({ force: true });
    if (saved) toast({ title: t("noteSaved") });
  };

  /* ── Dictation ── */
  const dictTarget = useRef<EditorTarget>("market");
  const appendTo = useCallback((target: EditorTarget, text: string) => {
    edit((prev) => {
      if (target === "free") {
        const p = parseNote(prev);
        if (!p.structured) return prev ? `${prev}${/\s$/.test(prev) ? "" : " "}${text}` : text;
        return serializeNote(p.sections, p.free ? `${p.free} ${text}` : text);
      }
      const p = parseNote(prev);
      const cur = p.sections[target];
      return serializeNote({ ...p.sections, [target]: cur ? `${cur}${/\s$/.test(cur) ? "" : " "}${text}` : text }, p.free);
    });
  }, [edit]);

  const dictation = useDictation({
    onFinal: (t) => appendTo(dictTarget.current, t),
    onError: (msg) => toast({ title: msg, variant: "destructive" }),
  });

  const startDictation = () => {
    const t: EditorTarget = mode === "free" ? "free" : activeKey && activeKey !== "free" ? activeKey : activeKey === "free" ? "free" : "market";
    dictTarget.current = t;
    setActiveKey(t);
    dictation.start();
  };

  const onFocusTarget = (k: EditorTarget) => {
    setActiveKey(k);
    if (dictation.recording) dictTarget.current = k;
  };

  /* ── Date navigation ── */
  const changeDate = useCallback((d: string) => {
    if (!isIsoDate(d) || d > today || d === dateRef.current) return;
    if (dictation.recording) dictation.stop();
    flush();
    setDate(d);
  }, [today, flush, dictation]);

  const setView = useCallback((v: View) => {
    if (v !== "write") flush();
    setViewState(v);
    writeLS(VIEW_KEY, v);
  }, [flush]);

  const openInEditor = (d: string) => { changeDate(d); setView("write"); };

  /* ── Templates ── */
  const applyTpl = (tpl: NoteTemplate) => {
    setMode("sections");
    edit((prev) => applyTemplate(prev, tpl));
    toast({ title: t("author.toast.tplApplied", { name: tpl.name }), description: t("author.toast.tplAppliedDesc") });
  };

  const saveTemplate = () => {
    const name = tplName.trim();
    if (!name) return;
    const p = parseNote(raw);
    const sections: NoteTemplate["sections"] = {};
    for (const s of SECTIONS) if (p.sections[s.key].trim()) sections[s.key] = p.sections[s.key];
    if (!Object.keys(sections).length) { toast({ title: t("author.toast.fillOneBlock"), variant: "destructive" }); return; }
    const next = [{ id: `c${Date.now()}`, name, description: t("myTemplate"), sections, custom: true }, ...templates.filter((x) => x.name !== name)];
    setTemplates(next);
    saveCustomTemplates(next);
    setTplDialog(false);
    setTplName("");
    toast({ title: t("author.toast.tplSaved") });
  };

  const removeTemplate = (id: string) => {
    const next = templates.filter((t) => t.id !== id);
    setTemplates(next);
    saveCustomTemplates(next);
  };

  /* ── Insert from the day's trades ── */
  const insertTrades = (trades: DayTrade[]) => {
    setMode("sections");
    edit((prev) => {
      const p = parseNote(prev);
      const next = { ...p.sections };
      for (const t of trades) {
        const k: SectionKey = t.horizon;
        if (!next[k].includes(`• ${t.ticker} `) && !next[k].includes(`• ${t.ticker}`)) next[k] = appendText(next[k], tradeLine(t));
      }
      return serializeNote(next, p.free);
    });
  };
  const insertHeld = (held: DayTrade[]) => {
    setMode("sections");
    edit((prev) => {
      const p = parseNote(prev);
      let hold = p.sections.hold;
      for (const t of held) if (!hold.includes(`• ${t.ticker}`)) hold = appendText(hold, heldLine(t));
      return serializeNote({ ...p.sections, hold }, p.free);
    });
  };

  /* ── Jump to a block (Alt+1…7, nudges) ── */
  const focusSection = (k: SectionKey) => {
    if (mode !== "sections") setMode("sections");
    setActiveKey(k); // makes folded overnight / swing blocks visible
    setTimeout(() => {
      const el = document.getElementById(`author-s-${k}`) as HTMLTextAreaElement | null;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 40);
  };

  /* ── «План vs факт» from the previous note into «Уроки» ── */
  const insertFollowThrough = (items: FollowItem[]) => {
    if (!prevPlan) return;
    if (hasFollowBlock(parseNote(rawRef.current).sections.lessons)) {
      toast({ title: t("author.toast.followExists") });
      focusSection("lessons");
      return;
    }
    const block = followThroughBlock(prevPlan.date, items);
    setMode("sections");
    edit((prev) => {
      const p = parseNote(prev);
      const cur = p.sections.lessons.replace(/\s+$/, "");
      return serializeNote({ ...p.sections, lessons: cur ? `${cur}\n\n${block}` : block }, p.free);
    });
    focusSection("lessons");
  };

  /* ── AI improve (user-triggered) ── */
  const improve = async () => {
    if (!raw.trim()) { toast({ title: t("author.toast.writeFirst"), variant: "destructive" }); return; }
    setImproving(true);
    try {
      cancelAutosave();
      const saved = await save({ force: true });
      if (!saved) return;
      const d = await http.post<{ refined_text?: string }>(`/api/author-notes/improve`, { text: raw, note_id: saved.id, note_date: date });
      if (d.refined_text) {
        const updated = { ...saved, refined_text: d.refined_text };
        setNote((prev) => (prev && prev.id === saved.id ? updated : prev));
        qc.setQueryData<AuthorNote[]>(AN_KEYS.history(trader), (prev) => upsertHistory(prev, updated));
        setShowAi(true);
        toast({ title: t("aiReady") });
      }
    } catch (e) {
      toast({ title: t("author.toast.aiFailed"), description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setImproving(false);
    }
  };

  /* ── Delete ── */
  const doDelete = async () => {
    const target = confirmDelete;
    if (!target) return;
    setDeleting(true);
    try {
      await http.del(`/api/author-notes/${target.id}`);
      qc.setQueryData<AuthorNote[]>(AN_KEYS.history(trader), (prev) => prev?.filter((n) => n.id !== target.id));
      void qc.invalidateQueries({ queryKey: ["author-notes", "feed"] });
      if (noteRef.current?.id === target.id) {
        cancelAutosave();
        if (dictation.recording) dictation.stop();
        setNote(null); setRaw(""); setMood(""); setShowAi(false); setStatus("idle"); setSavedAt(null);
      }
      toast({ title: t("noteDeleted") });
      setConfirmDelete(null);
    } catch (e) {
      toast({ title: tc("states.deleteFailed"), description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setDeleting(false);
    }
  };

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(raw);
      toast({ title: t("author.toast.copied") });
    } catch {
      toast({ title: tc("states.copyFailed"), variant: "destructive" });
    }
  };

  /* ── Keyboard ── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.code === "KeyS") {
        if (view === "write" && canEdit) { e.preventDefault(); void manualSave(); }
        return;
      }
      if (e.key === "Escape" && dictation.recording) { dictation.stop(); return; }
      // Alt+1…7 jumps to a block, also while typing in another one (e.code: layout-independent).
      if (e.altKey && !e.ctrlKey && !e.metaKey && /^Digit[1-7]$/.test(e.code)) {
        const k = sectionForDigit(Number(e.code.slice(5)));
        if (k && view === "write" && canEdit && loadState === "ok") { e.preventDefault(); focusSection(k); }
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (e.code === "BracketLeft" && view !== "history") { e.preventDefault(); changeDate(addDays(dateRef.current, -1)); }
      else if (e.code === "BracketRight" && view !== "history") { e.preventDefault(); changeDate(addDays(dateRef.current, 1)); }
      else if (e.code === "KeyN" && canEdit) { e.preventDefault(); setView("write"); setTimeout(() => firstFieldRef.current?.focus(), 50); }
      else if (e.code === "Digit1" && canEdit) setView("write");
      else if (e.code === "Digit2") setView("feed");
      else if (e.code === "Digit3" && canEdit) setView("history");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /* ── Render ── */
  const dayUnavailable = dayQ.isError && isNotFound(dayQ.error);
  const editorDisabled = loadState !== "ok";
  const words = raw.trim() ? raw.trim().split(/\s+/).length : 0;
  const filled = parseNote(raw);
  const filledCount = SECTIONS.filter((s) => filled.sections[s.key].trim()).length;
  const money = moneyMentions(raw);
  const planEmpty = mode === "sections" && filledCount >= 2 && !filled.sections.hold.trim() && !filled.sections.open.trim();

  const viewOptions = [
    ...(canEdit ? [{ value: "write", label: <span className="inline-flex items-center gap-1.5">{t("author.views.write")}</span> }] : []),
    {
      value: "feed",
      label: (
        <span className="inline-flex items-center gap-1.5">
          {t("author.views.feed")}
          {unreadCount > 0 && <span className="rounded-full bg-down px-1.5 text-2xs font-semibold tabular-nums text-primary-foreground" aria-label={t("author.unreadAria", { count: unreadCount })}>{unreadCount}</span>}
        </span>
      ),
    },
    ...(canEdit ? [{ value: "history", label: t("author.views.history") }] : []),
  ];

  if (!user || user.role === "guest" || !trader) {
    return (
      <Page>
        <PageHeader title={t("author.title")} icon={NotebookPen} description={t("author.description")} />
        <Panel>
          <EmptyState icon={NotebookPen} title={t("author.guestTitle")} description={t("author.guestDescription")} />
        </Panel>
      </Page>
    );
  }

  const dateNav = view !== "history" && (
    <div className="flex items-center gap-1.5">
      <Button variant="outline" size="icon" className="h-9 w-9" aria-label={t("author.prevDay")} title={t("author.prevDayTitle")} onClick={() => changeDate(addDays(date, -1))} disabled={dictation.recording}>
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <Input
        type="date"
        aria-label={t("noteDate")}
        value={date}
        max={today}
        disabled={dictation.recording}
        onChange={(e) => changeDate(e.target.value)}
        className="h-9 w-[150px] tabular-nums"
      />
      <Button variant="outline" size="icon" className="h-9 w-9" aria-label={t("author.nextDay")} title={t("author.nextDayTitle")} onClick={() => changeDate(addDays(date, 1))} disabled={date >= today || dictation.recording}>
        <ChevronRight className="h-4 w-4" />
      </Button>
      {date !== today && (
        <Button variant="ghost" size="sm" onClick={() => changeDate(today)} disabled={dictation.recording}>{tc("time.today")}</Button>
      )}
    </div>
  );

  return (
    <Page>
      <PageHeader
        title={t("author.title")}
        icon={NotebookPen}
        description={t("author.description")}
        actions={dateNav}
      >
        <Segmented ariaLabel={t("author.viewsAria")} value={view} onChange={(v) => setView(v as View)} options={viewOptions} />
      </PageHeader>

      {view === "write" && canEdit && (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="flex min-w-0 flex-col gap-4">
            <section className="glass-panel flex flex-col gap-4 rounded-2xl p-4 sm:p-5" aria-labelledby="author-editor-title">
              {/* Header: date + status */}
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 id="author-editor-title" className="text-lg font-semibold tracking-tight first-letter:uppercase">{fmtDate(date, "weekdayDayMonthLong")}</h2>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <SaveIndicator status={status} savedAt={savedAt} now={now} onRetry={() => void save({ force: true })} />
                    {audienceQ.data && audienceQ.data.total > 0 && (
                      <span className="inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
                        <Eye className="h-3 w-3" aria-hidden="true" />{t("author.readOf", { read: audienceQ.data.read, total: audienceQ.data.total })}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <Segmented
                    ariaLabel={t("author.modeAria")}
                    size="sm"
                    value={mode}
                    onChange={(m) => setMode(m as EditorMode)}
                    options={[{ value: "sections", label: t("author.modeSections") }, { value: "free", label: t("author.modeFree") }]}
                  />
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={tc("actions.moreActions")} disabled={editorDisabled}>
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => { setTplName(""); setTplDialog(true); }}>
                        <BookmarkPlus className="mr-2 h-4 w-4" />{t("author.saveAsTemplate")}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => void copyText()} disabled={!raw.trim()}>
                        <Copy className="mr-2 h-4 w-4" />{t("author.copyText")}
                      </DropdownMenuItem>
                      {note && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-down focus:text-down" onSelect={() => setConfirmDelete(note)}>
                            <Trash2 className="mr-2 h-4 w-4" />{t("deleteNote")}
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              {/* Mood */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground" id="author-mood-label">{t("stateLabel")}</span>
                <div role="group" aria-labelledby="author-mood-label" className="flex flex-wrap gap-1.5">
                  {MOODS.map((m) => (
                    <button
                      key={m.value}
                      type="button"
                      aria-pressed={mood === m.value}
                      disabled={editorDisabled}
                      onClick={() => changeMood(mood === m.value ? "" : m.value)}
                      className="chip inline-flex min-h-8 items-center gap-1.5 px-3 text-sm disabled:opacity-50"
                    >
                      <span aria-hidden="true">{m.emoji}</span>
                      <span className="text-xs">{m.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Toolbar */}
              <div className="flex flex-wrap items-center gap-2 border-y border-border py-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="gap-1.5" disabled={editorDisabled}>
                      <LayoutTemplate className="h-3.5 w-3.5" aria-hidden="true" />{t("template")}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-72">
                    <DropdownMenuLabel className="text-xs text-muted-foreground">{t("author.fillsEmptyBlocks")}</DropdownMenuLabel>
                    {BUILTIN_TEMPLATES.map((tpl) => (
                      <DropdownMenuItem key={tpl.id} onSelect={() => applyTpl(tpl)} className="flex flex-col items-start gap-0.5">
                        <span className="text-sm font-medium">{tpl.name}</span>
                        <span className="text-xs text-muted-foreground">{tpl.description}</span>
                      </DropdownMenuItem>
                    ))}
                    {templates.length > 0 && <DropdownMenuSeparator />}
                    {templates.map((tpl) => (
                      <div key={tpl.id} className="flex items-center">
                        <DropdownMenuItem onSelect={() => applyTpl(tpl)} className="min-w-0 flex-1">
                          <span className="truncate text-sm" title={tpl.name}>{tpl.name}</span>
                        </DropdownMenuItem>
                        <button
                          type="button"
                          aria-label={t("author.deleteTemplateAria", { name: tpl.name })}
                          onClick={() => removeTemplate(tpl.id)}
                          className="mr-1 grid h-8 w-8 place-items-center rounded-full text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>

                {dictation.supported ? (
                  <Button
                    variant={dictation.recording ? "destructive" : "outline"}
                    size="sm"
                    className="gap-1.5"
                    aria-pressed={dictation.recording}
                    disabled={!dictation.recording && editorDisabled}
                    onClick={dictation.recording ? dictation.stop : startDictation}
                  >
                    {dictation.recording ? <MicOff className="h-3.5 w-3.5" aria-hidden="true" /> : <Mic className="h-3.5 w-3.5" aria-hidden="true" />}
                    {dictation.recording ? t("author.dictateStop") : t("author.dictate")}
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">{t("author.dictationUnsupported")}</span>
                )}
                {dictation.recording && (
                  <span className="inline-flex items-center gap-1.5 text-xs text-down" role="status">
                    <span className="h-2 w-2 rounded-full bg-down motion-safe:animate-pulse" aria-hidden="true" />
                    {t("author.writingTo", { target: activeKey === "free" || !activeKey ? (mode === "free" ? t("author.modeFree") : t("author.general")) : SECTIONS.find((s) => s.key === activeKey)?.label ?? "" })} · <Kbd>Esc</Kbd>
                  </span>
                )}

                <div className="ml-auto flex items-center gap-2">
                  <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline">
                    {mode === "sections" ? `${t("author.blocksCount", { filled: filledCount, total: SECTIONS.length })} · ` : ""}{t("wordsShort", { count: words })}
                  </span>
                  <Button size="sm" className="gap-1.5" onClick={() => void improve()} disabled={improving || editorDisabled || !raw.trim()}>
                    {improving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />}
                    {improving ? t("improving") : t("improve")}
                  </Button>
                </div>
              </div>

              {/* Nudges: $ in a team-read note, empty plan */}
              {loadState === "ok" && (money.length > 0 || planEmpty) && (
                <div className="flex flex-col gap-1.5" role="note">
                  {money.length > 0 && (
                    <p className="flex items-start gap-1.5 text-xs text-warn">
                      <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span>{t("author.moneyNudge", { amounts: `${money.slice(0, 3).join(", ")}${money.length > 3 ? "…" : ""}` })}</span>
                    </p>
                  )}
                  {planEmpty && (
                    <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                      {t("author.planEmpty")}
                      <button type="button" onClick={() => focusSection("open")} className="font-medium text-primary underline-offset-2 hover:underline">
                        {t("author.fill")}
                      </button>
                      <span className="hidden md:inline"><Kbd>Alt</Kbd> <Kbd>7</Kbd></span>
                    </p>
                  )}
                </div>
              )}

              {/* Body */}
              {loadState === "loading" ? (
                <div className="flex flex-col gap-4" aria-busy="true" aria-label={t("author.loadingNote")}>
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="flex flex-col gap-2">
                      <Skeleton className="h-4 w-32 rounded-full" />
                      <Skeleton className="h-20 w-full rounded-xl" />
                    </div>
                  ))}
                </div>
              ) : loadState === "error" ? (
                <EmptyState
                  icon={AlertCircle}
                  title={t("noteLoadFailed")}
                  action={<Button variant="outline" onClick={() => void loadNote(date)}>{tc("actions.retry")}</Button>}
                />
              ) : (
                <AuthorEditor
                  raw={raw}
                  mode={mode}
                  onEdit={edit}
                  activeKey={activeKey}
                  onFocusTarget={onFocusTarget}
                  recording={dictation.recording}
                  interim={dictation.interim}
                  horizonCounts={dayQ.data?.summary.byHorizon}
                  firstFieldRef={firstFieldRef}
                />
              )}

              <p className="hidden flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground md:flex">
                <span><Kbd>Ctrl</Kbd> <Kbd>S</Kbd> {t("author.shortcuts.save")}</span>
                <span><Kbd>Alt</Kbd> <Kbd>1</Kbd>–<Kbd>7</Kbd> {t("author.shortcuts.toBlock")}</span>
                <span><Kbd>[</Kbd> <Kbd>]</Kbd> {t("author.shortcuts.dayNav")}</span>
                <span><Kbd>N</Kbd> {t("author.shortcuts.toWrite")}</span>
                <span><Kbd>1</Kbd>–<Kbd>3</Kbd> {t("author.shortcuts.views")}</span>
              </p>
            </section>

            {note?.refined_text && (
              <Panel
                title={t("aiVersion")}
                icon={Sparkles}
                description={t("author.aiPanelDescription")}
                actions={
                  <Button variant="ghost" size="sm" onClick={() => setShowAi((v) => !v)} aria-expanded={showAi}>
                    {showAi ? tc("actions.collapse") : tc("actions.show")}
                  </Button>
                }
              >
                {showAi ? <AuthorMarkdown text={note.refined_text} /> : (
                  <p className="line-clamp-2 text-sm text-muted-foreground">{note.refined_text.replace(/\*\*/g, "")}</p>
                )}
              </Panel>
            )}
          </div>

          <aside className="flex min-w-0 flex-col gap-4" aria-label={t("contextAria")}>
            {prevPlan && (
              <AuthorPrevPlan
                plan={prevPlan}
                trades={dayQ.data?.trades}
                canInsert={!editorDisabled}
                onInsert={insertFollowThrough}
                onOpenDay={changeDate}
              />
            )}
            <AuthorDayContext
              date={date}
              data={dayQ.data}
              loading={dayQ.isLoading}
              unavailable={dayUnavailable || dayQ.isError}
              canInsert={!editorDisabled}
              onInsertTrades={insertTrades}
              onInsertHeld={insertHeld}
            />
            <AuthorAudience
              hasNote={!!note?.id}
              data={audienceQ.data}
              loading={audienceQ.isLoading}
              error={audienceQ.isError}
            />
            <AuthorWeeklyCard
              trader={trader}
              date={date}
              notes={historyNotes}
              selectedDate={date}
              onPickDate={changeDate}
              canGenerate={canEdit}
              beforeGenerate={flush}
            />
          </aside>
        </div>
      )}

      {view === "feed" && (
        <AuthorFeed anchor={date} me={trader} range={range} onRangeChange={setRange} />
      )}

      {view === "history" && canEdit && (
        <AuthorHistory
          notes={historyNotes}
          loading={historyQ.isLoading}
          error={historyQ.isError}
          onRetry={() => void historyQ.refetch()}
          onOpenInEditor={openInEditor}
          onDelete={(n) => setConfirmDelete(n)}
          canEdit={canEdit}
        />
      )}

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => { if (!o && !deleting) setConfirmDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteNoteQ")}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDelete ? t("author.deleteDescription", { date: fmtDate(confirmDelete.note_date, "weekdayDayMonthLong") }) : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{tc("actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void doDelete(); }}
              disabled={deleting}
              className="bg-down text-primary-foreground hover:brightness-110"
            >
              {deleting ? t("deleting") : tc("actions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={tplDialog} onOpenChange={setTplDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("author.saveAsTemplate")}</DialogTitle>
            <DialogDescription>{t("author.tplDialogDescription")}</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => { e.preventDefault(); saveTemplate(); }}
            className="flex flex-col gap-3"
          >
            <label htmlFor="author-tpl-name" className="text-sm font-medium">{t("author.tplName")}</label>
            <Input id="author-tpl-name" value={tplName} onChange={(e) => setTplName(e.target.value)} placeholder={t("author.tplPlaceholder")} autoFocus maxLength={40} />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setTplDialog(false)}>{tc("actions.cancel")}</Button>
              <Button type="submit" disabled={!tplName.trim()}>{tc("actions.save")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
