import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check, ChevronDown, ChevronLeft, ChevronRight, CloudOff, LayoutTemplate, Loader2, Mic, MicOff,
  MoreHorizontal, Plus, Save, Sparkles, Trash2,
} from "lucide-react";
import { Panel, Pill } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Kbd } from "@/components/ui/kbd";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  BUILTIN_TEMPLATES, MOODS, SECTION_META, applyTemplate, composeSections, isUnread,
  loadMyTemplate, localToday, nextTradingDay, prevTradingDay, qk, relTime, saveMyTemplate, sectionsOf,
  wordCount, type JuniorNote, type SectionKey, type Sections, type Template,
} from "./junior-lib";
import { fmtDate } from "@/lib/format";
import { http } from "@/lib/api/http";
import { FeedbackCard, LoadError, MarkdownText } from "./junior-ui";
import { JuniorDayContext } from "./junior-day-context";
import { SPEECH_FALLBACK, getSR, speechLang, type SpeechRecognitionLike } from "./author-dictation";
import { notesI18n } from "@/i18n/ns/notes";
import { commonI18n } from "@/i18n/ns/common";

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";
type Payload = { date: string; sections: Sections; mood: string };

const CORE: SectionKey[] = ["plan", "intraday", "mistakes", "lessons", "focus"];
const OPTIONAL: SectionKey[] = ["overnight", "swing", "free"];

/** Writing-first structured editor for one day's summary + right-rail context. */
export function JuniorEditor({
  trader,
  date,
  onDateChange,
}: {
  trader: string;
  date: string;
  onDateChange: (d: string) => void;
}) {
  const { toast } = useToast();
  const { t } = notesI18n.useT();
  const { t: tc } = commonI18n.useT();
  const qc = useQueryClient();
  const today = localToday();

  const dayQ = useQuery({
    queryKey: qk.day(trader, date),
    queryFn: () => http.get<JuniorNote | null>(`/api/junior-notes?trader=${encodeURIComponent(trader)}&date=${date}`),
    enabled: !!trader,
    staleTime: 30_000,
  });
  const note = dayQ.data ?? null;

  const [sections, setSections] = React.useState<Sections>({});
  const [mood, setMood] = React.useState("");
  const [shown, setShown] = React.useState<Set<SectionKey>>(new Set());
  const [ready, setReady] = React.useState(false);
  const [saveState, setSaveState] = React.useState<SaveState>("idle");
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [, setTick] = React.useState(0);
  const [showRefined, setShowRefined] = React.useState(false);
  const [improving, setImproving] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [freshFeedbackId, setFreshFeedbackId] = React.useState<number | null>(null);
  const [myTemplate, setMyTemplate] = React.useState<Template | null>(() => loadMyTemplate());

  const initFor = React.useRef<string | null>(null);
  const dateRef = React.useRef(date);
  dateRef.current = date;
  const noteRef = React.useRef<JuniorNote | null>(note);
  noteRef.current = note;
  const pending = React.useRef<Payload | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const chain = React.useRef<Promise<unknown>>(Promise.resolve());
  const focusedKey = React.useRef<SectionKey>("intraday");
  const fieldRefs = React.useRef<Partial<Record<SectionKey, HTMLTextAreaElement | null>>>({});

  /* ── Load server note into the draft once per date ── */
  React.useEffect(() => {
    if (!dayQ.isSuccess || initFor.current === date) return;
    initFor.current = date;
    const s = sectionsOf(dayQ.data);
    setSections(s);
    setMood(dayQ.data?.mood ?? "");
    setShown(new Set(OPTIONAL.filter((k) => s[k]?.trim())));
    setShowRefined(false);
    setSaveState(dayQ.data ? "saved" : "idle");
    setSavedAt(dayQ.data ? Date.parse(dayQ.data.updated_at) : null);
    setReady(true);
  }, [dayQ.isSuccess, dayQ.data, date]);

  /* ── Persist (serialised so out-of-order responses can't clobber newer text) ── */
  const persist = React.useCallback(
    (p: Payload): Promise<JuniorNote | null> => {
      const run = async (): Promise<JuniorNote | null> => {
        const existing = qc.getQueryData<JuniorNote | null>(qk.day(trader, p.date));
        const empty = !composeSections(p.sections).trim() && !p.mood;
        if (!existing && empty) {
          if (p.date === dateRef.current) setSaveState("idle");
          return null;
        }
        if (p.date === dateRef.current) setSaveState("saving");
        try {
          const saved = await http.put<JuniorNote>("/api/junior-notes", { note_date: p.date, sections: p.sections, mood: p.mood || null });
          qc.setQueryData(qk.day(trader, p.date), saved);
          qc.setQueryData<JuniorNote[]>(qk.history(trader), (prev) => {
            if (!prev) return prev;
            const rest = prev.filter((n) => n.id !== saved.id);
            return [saved, ...rest].sort((a, b) => b.note_date.localeCompare(a.note_date));
          });
          if (p.date === dateRef.current && !pending.current) {
            setSaveState("saved");
            setSavedAt(Date.now());
          }
          return saved;
        } catch {
          if (p.date === dateRef.current) setSaveState("error");
          return null;
        }
      };
      const next = chain.current.then(run, run);
      chain.current = next;
      return next;
    },
    [qc, trader],
  );

  const flush = React.useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const p = pending.current;
    pending.current = null;
    return p ? persist(p) : Promise.resolve(noteRef.current);
  }, [persist]);

  const schedule = React.useCallback(
    (p: Payload) => {
      pending.current = p;
      setSaveState("dirty");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => { void flush(); }, 1500);
    },
    [flush],
  );

  // Flush when switching day or leaving the page.
  React.useEffect(() => () => { void flush(); }, [date, flush]);
  React.useEffect(() => {
    const onHide = () => { void flush(); };
    window.addEventListener("beforeunload", onHide);
    return () => window.removeEventListener("beforeunload", onHide);
  }, [flush]);

  // Keep "сохранено N сек назад" fresh.
  React.useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  /* ── Mark curator feedback as read when the junior opens the day ── */
  React.useEffect(() => {
    if (!note || note.trader !== trader || !isUnread(note)) return;
    setFreshFeedbackId(note.id);
    http.post<JuniorNote>(`/api/junior-notes/${note.id}/seen`, {})
      .then((n) => {
        qc.setQueryData(qk.day(trader, n.note_date), n);
        qc.setQueryData<JuniorNote[]>(qk.history(trader), (prev) => prev?.map((x) => (x.id === n.id ? n : x)));
      })
      .catch(() => { /* marker stays; harmless */ });
  }, [note, trader, qc]);

  /* ── Edits ── */
  const update = (key: SectionKey, value: string) => {
    setSections((prev) => {
      const next = { ...prev, [key]: value };
      schedule({ date, sections: next, mood });
      return next;
    });
  };

  const changeMood = (m: string) => {
    const v = mood === m ? "" : m;
    setMood(v);
    schedule({ date, sections, mood: v });
  };

  const insert = (key: SectionKey, text: string) => {
    if (!ready) return;
    setShown((s) => new Set(s).add(key));
    setSections((prev) => {
      const cur = prev[key]?.trimEnd() ?? "";
      const next = { ...prev, [key]: cur ? `${cur}\n${text}` : text };
      schedule({ date, sections: next, mood });
      return next;
    });
    requestAnimationFrame(() => fieldRefs.current[key]?.focus());
  };

  const applyTpl = (tpl: Template) => {
    setSections((prev) => {
      const next = applyTemplate(prev, tpl);
      setShown((s) => {
        const n = new Set(s);
        for (const k of OPTIONAL) if (next[k]?.trim()) n.add(k);
        return n;
      });
      schedule({ date, sections: next, mood });
      return next;
    });
    toast({ title: t("junior.editor.tplApplied", { name: tpl.label }), description: t("junior.editor.tplAppliedDesc") });
  };

  const saveNow = async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    pending.current = null;
    const saved = await persist({ date, sections, mood });
    if (saved) toast({ title: t("noteSaved") });
  };

  /* ── Keyboard: Ctrl/⌘+S save, Alt+←/→ switch trading day ── */
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveNow();
      } else if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        const d = e.key === "ArrowLeft" ? prevTradingDay(date) : nextTradingDay(date);
        if (d <= today) onDateChange(d);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /* ── Voice dictation into the last focused section (language = UI language, see author-dictation.ts) ── */
  const [recording, setRecording] = React.useState(false);
  const recRef = React.useRef<SpeechRecognitionLike | null>(null);
  const SR = getSR();

  const startRecording = (lang = speechLang(), quiet = false) => {
    if (!SR) return;
    const key = focusedKey.current;
    const rec = new SR();
    let retryLang: string | null = null;
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    recRef.current = rec;
    let finalText = sections[key] ?? "";
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]!;
        if (r.isFinal) finalText += (finalText ? " " : "") + r[0].transcript;
        else interim += r[0].transcript;
      }
      setSections((prev) => ({ ...prev, [key]: finalText + (interim ? " " + interim : "") }));
    };
    rec.onend = () => {
      if (retryLang) {
        // Uzbek recognition is missing in this browser: continue in Russian.
        startRecording(retryLang, true);
        return;
      }
      setRecording(false);
      setSections((prev) => {
        const next = { ...prev, [key]: finalText };
        schedule({ date: dateRef.current, sections: next, mood });
        return next;
      });
    };
    rec.onerror = (e) => {
      if (e.error === "language-not-supported" && lang !== SPEECH_FALLBACK) { retryLang = SPEECH_FALLBACK; return; }
      setRecording(false);
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        toast({ title: t("micDenied"), description: t("micDeniedHint"), variant: "destructive" });
      } else if (e.error !== "no-speech" && e.error !== "aborted") {
        toast({ title: t("micError", { error: e.error }), variant: "destructive" });
      }
    };
    try {
      rec.start();
      setRecording(true);
      if (key !== "plan" && OPTIONAL.includes(key)) setShown((s) => new Set(s).add(key));
      if (!quiet) toast({ title: t("junior.editor.dictationTo", { section: SECTION_META[key].title }) });
    } catch {
      setRecording(false);
      toast({ title: t("junior.editor.recordFailed"), variant: "destructive" });
    }
  };
  const stopRecording = () => {
    try { recRef.current?.stop(); } catch { /* ignore */ }
    setRecording(false);
  };
  React.useEffect(() => () => { try { recRef.current?.stop(); } catch { /* ignore */ } }, []);

  /* ── AI improve (existing feature, explicit click only) ── */
  const improve = async () => {
    const text = composeSections(sections);
    if (!text.trim()) { toast({ title: t("junior.editor.writeFirst"), variant: "destructive" }); return; }
    setImproving(true);
    try {
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      pending.current = null;
      const saved = await persist({ date, sections, mood });
      if (!saved) return;
      const data = await http.post<{ refined_text?: string }>("/api/junior-notes/improve", { text, note_id: saved.id, note_date: date });
      if (data.refined_text) {
        qc.setQueryData<JuniorNote | null>(qk.day(trader, date), (prev) => (prev ? { ...prev, refined_text: data.refined_text! } : prev));
        setShowRefined(true);
        toast({ title: t("aiReady") });
      }
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : t("junior.editor.aiError"), variant: "destructive" });
    } finally {
      setImproving(false);
    }
  };

  /* ── Delete ── */
  const doDelete = async () => {
    if (!note) return;
    setDeleting(true);
    try {
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      pending.current = null;
      await http.del(`/api/junior-notes/${note.id}`);
      qc.setQueryData(qk.day(trader, date), null);
      qc.setQueryData<JuniorNote[]>(qk.history(trader), (prev) => prev?.filter((n) => n.id !== note.id));
      setSections({});
      setMood("");
      setShown(new Set());
      setSaveState("idle");
      setConfirmDelete(false);
      toast({ title: t("noteDeleted") });
    } catch {
      toast({ title: t("deleteFailed"), variant: "destructive" });
    } finally {
      setDeleting(false);
    }
  };

  const words = wordCount(sections);
  const coreFilled = CORE.filter((k) => (k === "intraday" ? ["intraday", "overnight", "swing"].some((h) => sections[h as SectionKey]?.trim()) : sections[k]?.trim())).length;
  const loading = !ready || initFor.current !== date || dayQ.isLoading;

  const dateNav = (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button size="icon" variant="ghost" className="h-9 w-9" aria-label={t("prevTradingDay")} onClick={() => onDateChange(prevTradingDay(date))}>
        <ChevronLeft />
      </Button>
      <label className="glass-field relative inline-flex h-9 cursor-pointer items-center gap-2 px-3.5 text-sm font-medium focus-within:ring-2 focus-within:ring-ring">
        <span className="first-letter:uppercase">{fmtDate(date, "weekdayDayMonthLong")}</span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        <input
          type="date"
          aria-label={t("noteDate")}
          value={date}
          max={today}
          onChange={(e) => e.target.value && onDateChange(e.target.value)}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
      </label>
      <Button
        size="icon"
        variant="ghost"
        className="h-9 w-9"
        aria-label={t("nextTradingDay")}
        disabled={nextTradingDay(date) > today}
        onClick={() => onDateChange(nextTradingDay(date))}
      >
        <ChevronRight />
      </Button>
      {date !== today && (
        <Button variant="outline" onClick={() => onDateChange(today)}>{tc("time.today")}</Button>
      )}
    </div>
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-5">
      <Panel padded={false} className="min-w-0">
        {/* Header: date nav + status + tools */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3 sm:px-5">
          {dateNav}
          <div className="flex items-center gap-1.5">
            <SaveStatus state={saveState} savedAt={savedAt} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" disabled={loading}>
                  <LayoutTemplate aria-hidden="true" />
                  <span className="hidden sm:inline">{t("template")}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>{t("junior.editor.fillsEmpty")}</DropdownMenuLabel>
                {BUILTIN_TEMPLATES.map((tpl) => (
                  <DropdownMenuItem key={tpl.id} onSelect={() => applyTpl(tpl)}>{tpl.label}</DropdownMenuItem>
                ))}
                {myTemplate && <DropdownMenuItem onSelect={() => applyTpl(myTemplate)}>{myTemplate.label}</DropdownMenuItem>}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={!words}
                  onSelect={() => {
                    if (saveMyTemplate(sections)) {
                      setMyTemplate(loadMyTemplate());
                      toast({ title: t("junior.editor.savedAsMine") });
                    }
                  }}
                >
                  {t("junior.editor.saveAsMine")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {SR && (
              <Button
                size="icon"
                variant="ghost"
                className={cn("h-9 w-9", recording && "bg-down/15 text-down")}
                aria-pressed={recording}
                aria-label={recording ? t("junior.editor.stopDictation") : t("junior.editor.dictate")}
                title={recording ? t("junior.editor.stopDictation") : t("junior.editor.dictate")}
                disabled={loading}
                onClick={recording ? stopRecording : () => startRecording()}
              >
                {recording ? <MicOff /> : <Mic />}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon" variant="ghost" className="h-9 w-9" aria-label={tc("actions.moreActions")} disabled={loading}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem onSelect={() => void saveNow()}>
                  <Save aria-hidden="true" />{t("junior.editor.saveNow")}
                  <span className="ml-auto text-2xs text-muted-foreground">Ctrl+S</span>
                </DropdownMenuItem>
                <DropdownMenuItem disabled={improving || !words} onSelect={() => void improve()}>
                  {improving ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
                  {improving ? t("improving") : t("improve")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={!note} className="text-down focus:text-down" onSelect={() => setConfirmDelete(true)}>
                  <Trash2 aria-hidden="true" />{t("deleteNote")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {recording && (
          <div role="status" className="flex items-center gap-2 bg-down/10 px-5 py-2 text-sm text-down">
            <span className="h-2 w-2 animate-pulse rounded-full bg-current motion-reduce:animate-none" aria-hidden="true" />
            {t("junior.editor.dictationBanner", { section: SECTION_META[focusedKey.current].title })}
          </div>
        )}

        {dayQ.isError && !ready ? (
          <div className="p-5">
            <LoadError text={t("noteLoadFailed")} onRetry={() => dayQ.refetch()} />
          </div>
        ) : loading ? (
          <div className="space-y-5 p-5" aria-busy="true" aria-label={t("junior.editor.loading")}>
            <Skeleton className="h-8 w-2/3 rounded-full" />
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-4 w-24 rounded-full" />
                <Skeleton className="h-20 w-full rounded-xl" />
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-6 px-4 py-5 sm:px-5">
            {/* Mood */}
            <div className="space-y-2">
              <span id="jn-mood" className="micro-label">{t("stateLabel")}</span>
              <div role="group" aria-labelledby="jn-mood" className="flex flex-wrap gap-1.5">
                {MOODS.map((m) => (
                  <button key={m.value} type="button" aria-pressed={mood === m.value} onClick={() => changeMood(m.value)} className="chip min-h-8 px-3 text-sm">
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            <SectionField k="plan" value={sections.plan} onChange={update} fieldRefs={fieldRefs} focusedKey={focusedKey} />

            {/* Trades by horizon */}
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">{t("junior.editor.trades")}</h3>
                <div className="flex flex-wrap gap-1.5">
                  {(["overnight", "swing"] as SectionKey[]).filter((k) => !shown.has(k)).map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => { setShown((s) => new Set(s).add(k)); requestAnimationFrame(() => fieldRefs.current[k]?.focus()); }}
                      className="chip inline-flex min-h-7 items-center gap-1 px-2.5 text-xs"
                    >
                      <Plus className="h-3 w-3" aria-hidden="true" />
                      {SECTION_META[k].title}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-3 border-l-2 border-primary/30 pl-3 sm:pl-4">
                <SectionField k="intraday" value={sections.intraday} onChange={update} fieldRefs={fieldRefs} focusedKey={focusedKey} small />
                {shown.has("overnight") && <SectionField k="overnight" value={sections.overnight} onChange={update} fieldRefs={fieldRefs} focusedKey={focusedKey} small />}
                {shown.has("swing") && <SectionField k="swing" value={sections.swing} onChange={update} fieldRefs={fieldRefs} focusedKey={focusedKey} small />}
              </div>
            </div>

            <SectionField k="mistakes" value={sections.mistakes} onChange={update} fieldRefs={fieldRefs} focusedKey={focusedKey} />
            <SectionField k="lessons" value={sections.lessons} onChange={update} fieldRefs={fieldRefs} focusedKey={focusedKey} />
            <SectionField k="focus" value={sections.focus} onChange={update} fieldRefs={fieldRefs} focusedKey={focusedKey} rows={2} />

            {shown.has("free") ? (
              <SectionField k="free" value={sections.free} onChange={update} fieldRefs={fieldRefs} focusedKey={focusedKey} />
            ) : (
              <button type="button" onClick={() => { setShown((s) => new Set(s).add("free")); requestAnimationFrame(() => fieldRefs.current.free?.focus()); }} className="chip inline-flex min-h-8 items-center gap-1 px-3 text-sm">
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                {t("junior.editor.freeNotes")}
              </button>
            )}

            {note?.refined_text && (
              <div className="rounded-xl bg-primary/10">
                <button
                  type="button"
                  onClick={() => setShowRefined((v) => !v)}
                  aria-expanded={showRefined}
                  className="flex w-full items-center justify-between rounded-xl px-4 py-2.5 text-sm text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="flex items-center gap-1.5"><Sparkles className="h-4 w-4" aria-hidden="true" />{t("junior.editor.aiVersion")}</span>
                  <ChevronDown className={cn("h-4 w-4 transition-transform", showRefined && "rotate-180")} aria-hidden="true" />
                </button>
                {showRefined && <div className="px-4 pb-4"><MarkdownText text={note.refined_text} /></div>}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4 text-xs text-muted-foreground">
              <span className="tabular-nums">{t("words", { count: words })} · {t("junior.editor.sectionsCount", { filled: coreFilled, total: CORE.length })}</span>
              <span className="hidden items-center gap-1.5 sm:flex">
                <Kbd>Ctrl</Kbd><Kbd>S</Kbd> {t("junior.editor.shortcutSave")} · <Kbd>Alt</Kbd><Kbd>←</Kbd><Kbd>→</Kbd> {t("junior.editor.shortcutDay")}
              </span>
            </div>
          </div>
        )}
      </Panel>

      <aside className="flex min-w-0 flex-col gap-4">
        <CompletenessCard filled={coreFilled} total={CORE.length} words={words} />
        {note && <FeedbackCard note={note} fresh={freshFeedbackId === note.id} className="glass-panel rounded-2xl" />}
        {note && !note.reviewed_at && words > 0 && (
          <p className="px-1 text-xs text-muted-foreground">{t("junior.editor.noAnswerYet")}</p>
        )}
        <JuniorDayContext trader={trader} date={date} onInsert={ready ? insert : undefined} />
      </aside>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteNoteQ")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("junior.editor.deleteDescription", { date: fmtDate(date, "weekdayDayMonthLong") })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tc("actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); void doDelete(); }} disabled={deleting} className="bg-down text-white hover:brightness-110">
              {deleting ? t("deleting") : tc("actions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SectionField({
  k, value, onChange, fieldRefs, focusedKey, small, rows = 3,
}: {
  k: SectionKey;
  value: string | undefined;
  onChange: (k: SectionKey, v: string) => void;
  fieldRefs: React.MutableRefObject<Partial<Record<SectionKey, HTMLTextAreaElement | null>>>;
  focusedKey: React.MutableRefObject<SectionKey>;
  small?: boolean;
  rows?: number;
}) {
  const meta = SECTION_META[k];
  const id = `jn-sec-${k}`;
  const filled = !!value?.trim();
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className={cn("flex items-center gap-2 font-semibold", small ? "text-sm" : "text-sm")}>
          <span className={cn("h-1.5 w-1.5 rounded-full", filled ? "bg-up" : "bg-muted-foreground/40")} aria-hidden="true" />
          {meta.title}
        </label>
        <span className="text-xs text-muted-foreground">{meta.hint}</span>
      </div>
      <Textarea
        id={id}
        ref={(el) => { fieldRefs.current[k] = el; }}
        rows={rows}
        value={value ?? ""}
        placeholder={meta.placeholder}
        onFocus={() => { focusedKey.current = k; }}
        onChange={(e) => onChange(k, e.target.value)}
        className="min-h-[72px] resize-y leading-relaxed [field-sizing:content]"
      />
    </div>
  );
}

function SaveStatus({ state, savedAt }: { state: SaveState; savedAt: number | null }) {
  const { t } = notesI18n.useT();
  if (state === "saving") {
    return <span role="status" className="flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />{t("savingNow")}</span>;
  }
  if (state === "dirty") return <span role="status" className="text-xs text-muted-foreground">{t("dirty")}</span>;
  if (state === "error") {
    return <span role="alert" className="flex items-center gap-1 text-xs text-down"><CloudOff className="h-3.5 w-3.5" aria-hidden="true" />{t("junior.editor.notSaved")}</span>;
  }
  if (state === "saved" && savedAt) {
    return <span role="status" className="flex items-center gap-1 text-xs text-muted-foreground"><Check className="h-3.5 w-3.5 text-up" aria-hidden="true" />{t("junior.editor.savedAgo", { ago: relTime(savedAt) })}</span>;
  }
  return null;
}

function CompletenessCard({ filled, total, words }: { filled: number; total: number; words: number }) {
  const { t } = notesI18n.useT();
  const pct = Math.round((filled / total) * 100);
  const r = 22;
  const c = 2 * Math.PI * r;
  return (
    <div className="glass-panel flex items-center gap-4 rounded-2xl p-4">
      <svg viewBox="0 0 56 56" className="h-14 w-14 shrink-0 -rotate-90" role="img" aria-label={t("junior.editor.filledAria", { filled, total })}>
        <circle cx="28" cy="28" r={r} fill="none" stroke="hsl(var(--border))" strokeWidth="5" />
        <circle
          cx="28" cy="28" r={r} fill="none"
          stroke={pct === 100 ? "hsl(var(--up))" : "hsl(var(--primary))"}
          strokeWidth="5" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - filled / total)}
          className="transition-[stroke-dashoffset] duration-300 motion-reduce:transition-none"
        />
      </svg>
      <div className="min-w-0">
        <div className="text-sm font-semibold">
          {pct === 100 ? t("junior.editor.complete") : filled === 0 ? t("junior.editor.startWithPlan") : t("junior.editor.filledOf", { filled, total })}
        </div>
        <p className="text-xs text-muted-foreground">
          {pct === 100 ? t("junior.editor.completeHint") : t("junior.editor.incompleteHint")}
        </p>
        {words > 0 && <Pill tone="neutral" className="mt-1.5">{t("words", { count: words })}</Pill>}
      </div>
    </div>
  );
}
