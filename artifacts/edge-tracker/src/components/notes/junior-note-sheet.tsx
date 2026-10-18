import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { BookmarkPlus, CalendarRange, ChevronLeft, ChevronRight, Loader2, PencilLine, Send, Sparkles, Trash2, Undo2, X } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Kbd, Pill } from "@/components/ds";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  builtinSnippets, addSnippet, appendSnippet, clearDraft, draftDiffers, loadDraft, loadMySnippets, qk,
  relTime, reviewKeyAction, saveDraft, saveMySnippets, sectionsOf, wordCount, type JuniorNote, type ReviewContext,
} from "./junior-lib";
import { fmtDate } from "@/lib/format";
import { http } from "@/lib/api/http";
import { FeedbackCard, MarkdownText, MoodPill, ScorePicker, SectionsView } from "./junior-ui";
import { PrevFocusCard, ReviewContextRail } from "./junior-review-context";
import { notesI18n } from "@/i18n/ns/notes";
import { commonI18n } from "@/i18n/ns/common";
import { personName } from "@/i18n";

export type SheetNav = {
  /** 0-based position in the list being reviewed. */
  index: number;
  total: number;
  /** e.g. "Очередь" or "День". */
  label?: string;
  onPrev?: () => void;
  onNext?: () => void;
};

/**
 * Side sheet with a full note.
 * - owner: read + "open in editor" + delete
 * - reader: read only
 * - curator (curator / admin, or the junior's mentor): read + day context + feedback/score form with
 *   keyboard flow (J/K, 1–5, Ctrl+Enter), quick replies and a per-note draft that survives closing the sheet.
 */
export function JuniorNoteSheet({
  note,
  open,
  onOpenChange,
  mode,
  q,
  onOpenInEditor,
  onReviewed,
  submitLabel,
  nav,
}: {
  note: JuniorNote | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  mode: "owner" | "reader" | "curator";
  q?: string;
  onOpenInEditor?: (date: string) => void;
  /** Called after a successful review (e.g. to advance to the next unanswered note). */
  onReviewed?: (note: JuniorNote) => void;
  /** Label for the submit button, e.g. "Отправить и дальше". */
  submitLabel?: string;
  /** Prev/next through the list the sheet was opened from. */
  nav?: SheetNav;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t } = notesI18n.useT();
  const { t: tc } = commonI18n.useT();
  const [feedback, setFeedback] = React.useState("");
  const [score, setScore] = React.useState<number | null>(null);
  const [restored, setRestored] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [current, setCurrent] = React.useState<JuniorNote | null>(note);
  const [mySnippets, setMySnippets] = React.useState<string[]>(loadMySnippets);
  const feedbackRef = React.useRef<HTMLTextAreaElement>(null);
  const isCurator = mode === "curator";

  React.useEffect(() => {
    setCurrent(note);
    setConfirmDelete(false);
  }, [note]);

  // The form is (re)initialised per note — a background refetch of the same note must not wipe what is being typed.
  const noteId = note?.id ?? null;
  React.useEffect(() => {
    if (!note) return;
    const d = loadDraft(note.id);
    if (d && draftDiffers(d, note)) {
      setFeedback(d.feedback);
      setScore(d.score);
      setRestored(true);
    } else {
      if (d) clearDraft(note.id);
      setFeedback(note.curator_feedback ?? "");
      setScore(note.curator_score ?? null);
      setRestored(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  const n = current;
  const sections = sectionsOf(n);

  const ctxQ = useQuery({
    queryKey: qk.context(n?.id ?? 0),
    queryFn: () => http.get<ReviewContext>(`/api/junior-notes/${n!.id}/context`),
    enabled: open && isCurator && !!n,
    staleTime: 60_000,
    retry: 1,
  });

  // The owner reading an unread curator answer marks it as read.
  React.useEffect(() => {
    if (!open || mode !== "owner" || !note || !note.reviewed_at || note.feedback_seen_at) return;
    http.post<JuniorNote>(`/api/junior-notes/${note.id}/seen`, {})
      .then((u) => {
        qc.setQueryData<JuniorNote[]>(qk.history(u.trader), (prev) => prev?.map((x) => (x.id === u.id ? u : x)));
        qc.setQueryData(qk.day(u.trader, u.note_date), u);
      })
      .catch(() => { /* stays unread */ });
  }, [open, mode, note, qc]);

  const persistDraft = (fb: string, sc: number | null) => {
    if (!n) return;
    const d = { feedback: fb, score: sc };
    if (draftDiffers(d, n)) saveDraft(n.id, d);
    else clearDraft(n.id);
  };
  const changeFeedback = (v: string) => { setFeedback(v); persistDraft(v, score); };
  const changeScore = (v: number | null) => { setScore(v); persistDraft(feedback, v); };

  const resetDraft = () => {
    if (!n) return;
    clearDraft(n.id);
    setFeedback(n.curator_feedback ?? "");
    setScore(n.curator_score ?? null);
    setRestored(false);
  };

  const insertSnippet = (s: string) => {
    changeFeedback(appendSnippet(feedback, s));
    requestAnimationFrame(() => {
      const el = feedbackRef.current;
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    });
  };
  const rememberSnippet = () => {
    const text = feedback.trim();
    if (!text) return;
    const next = addSnippet(mySnippets, text);
    setMySnippets(next);
    toast({ title: saveMySnippets(next) ? t("junior.sheet.savedToQuick") : t("junior.sheet.quickSaveFailed") });
  };
  const forgetSnippet = (s: string) => {
    const next = mySnippets.filter((x) => x !== s);
    setMySnippets(next);
    saveMySnippets(next);
  };

  const syncCaches = (updated: JuniorNote) => {
    qc.setQueryData<JuniorNote[]>(qk.team(updated.note_date), (prev) => prev?.map((x) => (x.id === updated.id ? updated : x)));
    qc.setQueryData<JuniorNote[]>(qk.history(updated.trader), (prev) => prev?.map((x) => (x.id === updated.id ? updated : x)));
    qc.setQueryData(qk.day(updated.trader, updated.note_date), updated);
    qc.setQueriesData<JuniorNote[]>({ queryKey: qk.queue }, (prev) =>
      prev && (updated.reviewed_at ? prev.filter((x) => x.id !== updated.id) : prev));
    void qc.invalidateQueries({ queryKey: ["junior-notes", "overview", updated.note_date] });
  };

  const saveReview = async () => {
    if (!n || saving) return;
    setSaving(true);
    try {
      const updated = await http.post<JuniorNote>(`/api/junior-notes/${n.id}/review`, { feedback, score });
      clearDraft(n.id);
      setRestored(false);
      setCurrent(updated);
      syncCaches(updated);
      toast({ title: updated.reviewed_at ? t("junior.sheet.sentTo", { name: personName(n.trader) }) : t("junior.sheet.scoreRemoved") });
      if (updated.reviewed_at) onReviewed?.(updated);
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : tc("states.saveFailed"), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async () => {
    if (!n) return;
    setDeleting(true);
    try {
      await http.del(`/api/junior-notes/${n.id}`);
      qc.setQueryData<JuniorNote[]>(qk.history(n.trader), (prev) => prev?.filter((x) => x.id !== n.id));
      qc.setQueryData(qk.day(n.trader, n.note_date), null);
      toast({ title: t("noteDeleted") });
      onOpenChange(false);
    } catch {
      toast({ title: t("deleteFailed"), variant: "destructive" });
    } finally {
      setDeleting(false);
    }
  };

  /** Review keyboard flow — see reviewKeyAction() for the map. */
  const onSheetKey = (e: React.KeyboardEvent) => {
    if (!isCurator || !n) return;
    const t = e.target as HTMLElement;
    const inField = t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.tagName === "SELECT" || t.isContentEditable;
    const a = reviewKeyAction(e, inField);
    if (!a) return;
    if (a.type === "next") { if (!nav?.onNext) return; e.preventDefault(); nav.onNext(); }
    else if (a.type === "prev") { if (!nav?.onPrev) return; e.preventDefault(); nav.onPrev(); }
    else if (a.type === "score") { e.preventDefault(); changeScore(a.value); }
    else if (a.type === "focus") { e.preventDefault(); feedbackRef.current?.focus(); }
    else if (a.type === "send") { e.preventDefault(); void saveReview(); }
  };

  const ctx = ctxQ.data && ctxQ.data.note_id === n?.id ? ctxQ.data : undefined;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        onKeyDown={onSheetKey}
        className={cn("flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-xl", isCurator && "lg:max-w-4xl")}
      >
        {n && (
          <>
            <SheetHeader className="space-y-2 border-b border-border p-5 pr-12 text-left">
              <SheetTitle className="text-lg first-letter:uppercase">
                {mode === "owner" ? fmtDate(n.note_date, "weekdayDayMonthLong") : `${personName(n.trader)} · ${fmtDate(n.note_date, "weekdayDayMonthLong")}`}
              </SheetTitle>
              <SheetDescription asChild>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <MoodPill mood={n.mood} />
                  <Pill tone="neutral">{t("words", { count: wordCount(sections) })}</Pill>
                  <span>{t("junior.sheet.updated", { ago: relTime(n.updated_at) })}</span>
                  {isCurator && (n.reviewed_at ? <Pill tone="up">{t("answered")}</Pill> : <Pill tone="accent" dot>{t("waiting")}</Pill>)}
                </div>
              </SheetDescription>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {mode === "owner" && onOpenInEditor && (
                  <Button size="sm" variant="outline" onClick={() => { onOpenChange(false); onOpenInEditor(n.note_date); }}>
                    <PencilLine aria-hidden="true" />{t("openInEditor")}
                  </Button>
                )}
                <Button asChild size="sm" variant="ghost">
                  <Link href={`/game-plan?date=${n.note_date}`}><CalendarRange aria-hidden="true" />{t("junior.day.gamePlan")}</Link>
                </Button>
                {nav && nav.total > 1 && (
                  <div className="ml-auto flex items-center gap-1" role="group" aria-label={t("junior.sheet.navAria")}>
                    <Button size="icon" variant="ghost" className="h-8 w-8" disabled={!nav.onPrev} onClick={nav.onPrev} aria-label={t("junior.sheet.prevAria")} title={t("junior.sheet.prevTitle")}>
                      <ChevronLeft />
                    </Button>
                    <span className="min-w-[4.5rem] text-center text-xs tabular-nums text-muted-foreground" aria-live="polite">
                      {nav.label ? `${nav.label} · ` : ""}{t("junior.sheet.position", { index: nav.index + 1, total: nav.total })}
                    </span>
                    <Button size="icon" variant="ghost" className="h-8 w-8" disabled={!nav.onNext} onClick={nav.onNext} aria-label={t("junior.sheet.nextAria")} title={t("junior.sheet.nextTitle")}>
                      <ChevronRight />
                    </Button>
                  </div>
                )}
              </div>
            </SheetHeader>

            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className={cn("p-5", isCurator ? "grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]" : "space-y-5")}>
                <div className="min-w-0 space-y-5">
                  {!isCurator && <FeedbackCard note={n} />}
                  {isCurator && <PrevFocusCard ctx={ctx} isLoading={ctxQ.isLoading} />}

                  <SectionsView sections={sections} q={q} />

                  {n.refined_text && (
                    <details className="rounded-xl bg-primary/10 px-4 py-3">
                      <summary className="flex cursor-pointer items-center gap-1.5 text-sm text-primary">
                        <Sparkles className="h-4 w-4" aria-hidden="true" />{t("aiVersion")}
                      </summary>
                      <div className="mt-3"><MarkdownText text={n.refined_text} /></div>
                    </details>
                  )}
                </div>
                {isCurator && (
                  <aside aria-label={t("contextAria")} className="min-w-0 lg:border-l lg:border-border lg:pl-5">
                    <ReviewContextRail ctx={ctx} isLoading={ctxQ.isLoading} isError={ctxQ.isError} />
                  </aside>
                )}
              </div>
            </div>

            {isCurator && (
              <section className="space-y-2 border-t border-border bg-background/60 p-4" aria-label={t("junior.sheet.answerAria")}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <ScorePicker value={score} onChange={changeScore} />
                  <span className="text-xs text-muted-foreground">
                    {restored ? (
                      <span className="inline-flex items-center gap-1.5">
                        {t("junior.sheet.draftRestored")}
                        <button type="button" onClick={resetDraft} className="inline-flex items-center gap-1 rounded-full px-1.5 text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                          <Undo2 className="h-3 w-3" aria-hidden="true" />{t("junior.sheet.resetDraft")}
                        </button>
                      </span>
                    ) : n.reviewed_at ? (
                      `${personName(n.reviewed_by)} · ${relTime(n.reviewed_at)} · ${n.feedback_seen_at ? t("junior.sheet.seen") : t("junior.sheet.notSeen")}`
                    ) : null}
                  </span>
                </div>

                <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5" role="group" aria-label={t("junior.sheet.quickRepliesAria")}>
                  {mySnippets.map((s) => (
                    <span key={`my-${s}`} className="inline-flex shrink-0 items-center rounded-full border border-primary/40 bg-primary/10">
                      <button
                        type="button"
                        onClick={() => insertSnippet(s)}
                        title={s}
                        className="max-w-[16rem] truncate rounded-l-full py-1 pl-2.5 pr-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {s}
                      </button>
                      <button
                        type="button"
                        onClick={() => forgetSnippet(s)}
                        aria-label={t("junior.sheet.deleteQuickReply", { text: s.slice(0, 40) })}
                        className="grid h-6 w-6 place-items-center rounded-r-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <X className="h-3 w-3" aria-hidden="true" />
                      </button>
                    </span>
                  ))}
                  {builtinSnippets().map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => insertSnippet(s)}
                      title={s}
                      className="max-w-[16rem] shrink-0 truncate rounded-full border border-[var(--field-border)] px-2.5 py-1 text-xs text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {s}
                    </button>
                  ))}
                </div>

                <label htmlFor="jn-feedback" className="sr-only">{t("junior.sheet.feedbackLabel")}</label>
                <Textarea
                  id="jn-feedback"
                  ref={feedbackRef}
                  rows={3}
                  value={feedback}
                  onChange={(e) => changeFeedback(e.target.value)}
                  placeholder={t("junior.sheet.feedbackPlaceholder")}
                  className="[field-sizing:content] max-h-[50vh] min-h-[76px]"
                />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="ghost" disabled={!feedback.trim()} onClick={rememberSnippet} title={t("junior.sheet.rememberTitle")}>
                      <BookmarkPlus aria-hidden="true" />{t("junior.sheet.remember")}
                    </Button>
                    <span className="hidden items-center gap-1 text-xs text-muted-foreground lg:inline-flex">
                      <Kbd>1</Kbd>–<Kbd>5</Kbd> {t("junior.sheet.kbdScore")} <Kbd>R</Kbd> {t("junior.sheet.kbdAnswer")} {nav && nav.total > 1 && <><Kbd>J</Kbd>/<Kbd>K</Kbd> {t("junior.sheet.kbdFlip")}</>} <Kbd keys={["Ctrl", "Enter"]} /> {t("junior.sheet.kbdSend")}
                    </span>
                  </div>
                  <Button onClick={() => void saveReview()} disabled={saving}>
                    {saving ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
                    {submitLabel ?? (n.reviewed_at ? t("junior.sheet.update") : t("junior.sheet.send"))}
                  </Button>
                </div>
              </section>
            )}

            {mode === "owner" && (
              <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border p-4">
                {confirmDelete ? (
                  <>
                    <span role="alert" className="mr-auto text-sm text-down">{t("junior.sheet.deleteForever")}</span>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>{tc("actions.cancel")}</Button>
                    <Button size="sm" variant="destructive" disabled={deleting} onClick={() => void doDelete()}>
                      {deleting ? t("deleting") : t("junior.sheet.yesDelete")}
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-down" onClick={() => setConfirmDelete(true)}>
                    <Trash2 aria-hidden="true" />{tc("actions.delete")}
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
