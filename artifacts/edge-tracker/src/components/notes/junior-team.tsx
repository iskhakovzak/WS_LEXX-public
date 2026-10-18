import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, BellRing, Check, Inbox, Play, ChevronLeft, ChevronRight, ChevronDown, Flame, GraduationCap, Loader2,
  MessageSquareQuote, PenLine, Sparkles, Users, X,
} from "lucide-react";
import { EmptyState, Panel, Pill, Segmented, StatCard, StatGrid } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  byAttention, canReviewTrader, previewSections, daysSince, hasDraft, lastTradingDays,
  localToday, nextTradingDay, nextUnanswered, prevTradingDay, qk, relTime, sectionsOf,
  type JuniorNote, type OverviewRow, type ReviewerInfo, type ReviewScopeFilter,
} from "./junior-lib";
import { fmtDate, fmtNum } from "@/lib/format";
import { http, ApiError } from "@/lib/api/http";
import { isNotFound } from "@/lib/api/errors";
import { Initial, LoadError, MarkdownText, MoodPill, ScoreStars } from "./junior-ui";
import { JuniorNoteSheet, type SheetNav } from "./junior-note-sheet";
import { ScoreTrail, TrendArrow } from "./junior-review-context";
import { PeopleSearchInput } from "@/components/people/people-search-input";
import { matchPerson, prepareQuery, usePeopleAliases } from "@/components/people/search";
import { notesI18n } from "@/i18n/ns/notes";
import { commonI18n } from "@/i18n/ns/common";
import { personName, comparePersonNames } from "@/i18n";

const SCOPE_KEY = "ws_lexx_junior_scope";
const SORT_KEY = "ws_lexx_junior_roster_sort";

function readPref<T extends string>(key: string, allowed: readonly T[], def: T): T {
  try {
    const v = localStorage.getItem(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : def;
  } catch {
    return def;
  }
}
function writePref(key: string, v: string) {
  try { localStorage.setItem(key, v); } catch { /* ignore */ }
}

export function JuniorTeam({ reviewer, me }: { reviewer: ReviewerInfo | null; me: string }) {
  const { toast } = useToast();
  const { t } = notesI18n.useT();
  const { t: tc } = commonI18n.useT();
  const qc = useQueryClient();
  const today = localToday();
  const isReviewer = !!reviewer && reviewer.kind !== "none";
  const isMentor = reviewer?.kind === "scoped";
  const mineList = reviewer?.mine ?? [];
  const canFilterMine = isReviewer && mineList.length > 0;

  const [date, setDate] = React.useState(() => lastTradingDays(today, 1)[0]!);
  const [opened, setOpened] = React.useState<{ id: number; src: "team" | "queue" } | null>(null);
  const setOpenId = (id: number | null) => setOpened(id == null ? null : { id, src: "team" });
  const [selected, setSelected] = React.useState<Set<number>>(new Set());
  const [summary, setSummary] = React.useState<string | null>(null);
  const [summarizing, setSummarizing] = React.useState(false);
  const [reminding, setReminding] = React.useState<Set<string>>(new Set());
  const [scopePref, setScopePref] = React.useState<ReviewScopeFilter>(() => readPref(SCOPE_KEY, ["all", "mine"] as const, "all"));
  const [sort, setSort] = React.useState<"attention" | "name">(() => readPref(SORT_KEY, ["attention", "name"] as const, "attention"));
  const [flaggedOnly, setFlaggedOnly] = React.useState(false);
  const [who, setWho] = React.useState("");
  const aliases = usePeopleAliases();
  // Mentors review only their mentees anyway — their default view is «Мои джуны».
  const scope: ReviewScopeFilter = canFilterMine ? (isMentor && !localStorageHas(SCOPE_KEY) ? "mine" : scopePref) : "all";
  const setScope = (v: ReviewScopeFilter) => { setScopePref(v); writePref(SCOPE_KEY, v); };
  const scopeQs = scope === "mine" ? "&scope=mine" : "";

  const teamQ = useQuery({
    queryKey: qk.team(date),
    queryFn: () => http.get<JuniorNote[]>(`/api/junior-notes/team?date=${date}`),
    staleTime: 30_000,
  });
  const overviewQ = useQuery({
    queryKey: qk.overview(date, scope),
    queryFn: () => http.get<{ date: string; rows: OverviewRow[] }>(`/api/junior-notes/overview?date=${date}${scopeQs}`),
    enabled: isReviewer,
    staleTime: 30_000,
    retry: (n, e) => !(e instanceof ApiError && (e.status === 404 || e.status === 403)) && n < 2,
  });

  const queueQ = useQuery({
    queryKey: qk.queueOf(scope),
    queryFn: () => http.get<JuniorNote[]>(`/api/junior-notes/queue?days=14${scopeQs}`),
    enabled: isReviewer,
    staleTime: 30_000,
    retry: (n, e) => !(e instanceof ApiError && (e.status === 404 || e.status === 403)) && n < 2,
  });
  const queue = queueQ.data ?? [];

  React.useEffect(() => { setSelected(new Set()); setSummary(null); }, [date, scope]);

  const canReview = React.useCallback((trader: string) => canReviewTrader(reviewer, trader, me), [reviewer, me]);
  const mineSet = React.useMemo(() => new Set(mineList), [mineList]);
  const allNotes = React.useMemo(() => (teamQ.data ?? []).filter((n) => n.raw_text?.trim()), [teamQ.data]);
  const notes = React.useMemo(
    () => (scope === "mine" ? allNotes.filter((n) => mineSet.has(n.trader)) : allNotes),
    [allNotes, scope, mineSet],
  );
  const reviewable = React.useMemo(() => notes.filter((n) => canReview(n.trader)), [notes, canReview]);

  const rows = overviewQ.data?.rows ?? [];
  const wrote = rows.filter((r) => r.note);
  const missed = rows.filter((r) => !r.note);
  const flagged = rows.filter((r) => (r.attention ?? []).some((f) => f.kind !== "unanswered"));
  const shownRows = React.useMemo(() => {
    const pq = prepareQuery(who);
    const base = (flaggedOnly ? rows.filter((r) => (r.attention ?? []).length > 0) : rows).filter((r) => pq.empty || matchPerson(pq, r.trader, aliases));
    return sort === "attention" ? byAttention(base) : [...base].sort((a, b) => comparePersonNames(a.trader, b.trader));
  }, [rows, sort, flaggedOnly, who, aliases]);
  const teamAvg = (() => {
    const s = rows.filter((r) => r.avg_score != null).map((r) => r.avg_score!);
    return s.length ? (s.reduce((a, b) => a + b, 0) / s.length).toFixed(1) : null;
  })();
  const oldestWait = queue.length ? daysSince(queue[0]!.note_date, today) : 0;

  const remind = async (traders: string[]) => {
    if (!traders.length) return;
    setReminding((s) => new Set([...s, ...traders]));
    let ok = 0;
    for (const t of traders) {
      try {
        const r = await http.post<{ id: number; curator: string; created_at: string }>("/api/junior-notes/reminders", { trader: t, date });
        ok++;
        qc.setQueryData<{ date: string; rows: OverviewRow[] }>(qk.overview(date, scope), (prev) =>
          prev && { ...prev, rows: prev.rows.map((x) => (x.trader === t ? { ...x, reminder: { id: r.id, curator: r.curator, created_at: r.created_at } } : x)) },
        );
      } catch { /* counted below */ }
    }
    setReminding((s) => { const n = new Set(s); traders.forEach((t) => n.delete(t)); return n; });
    if (ok === traders.length) toast({ title: ok === 1 ? t("junior.team.remindedOne", { name: personName(traders[0]!) }) : t("junior.team.remindedMany", { count: ok }), description: t("junior.team.remindedDesc") });
    else toast({ title: t("junior.team.remindedPartial", { ok, total: traders.length }), variant: "destructive" });
  };

  const generateSummary = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    setSummarizing(true);
    setSummary(null);
    try {
      const d = await http.post<{ summary?: string }>("/api/junior-notes/team-summary", { note_ids: ids });
      if (d.summary) setSummary(d.summary);
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : t("junior.team.aiUnavailable"), variant: "destructive" });
    } finally {
      setSummarizing(false);
    }
  };

  const openNote =
    opened == null ? null : (opened.src === "queue" ? queue : allNotes).find((n) => n.id === opened.id) ?? null;

  /* Prev / next inside the list the sheet was opened from (queue or the day's notes). */
  const navList = opened?.src === "queue" ? queue : notes;
  const navIdx = opened ? navList.findIndex((n) => n.id === opened.id) : -1;
  const nav: SheetNav | undefined = navIdx < 0 || !opened ? undefined : {
    index: navIdx,
    total: navList.length,
    label: opened.src === "queue" ? t("junior.team.navQueue") : t("junior.team.navDay"),
    onPrev: navIdx > 0 ? () => setOpened({ id: navList[navIdx - 1]!.id, src: opened.src }) : undefined,
    onNext: navIdx < navList.length - 1 ? () => setOpened({ id: navList[navIdx + 1]!.id, src: opened.src }) : undefined,
  };

  /** After an answer jump to the next note that still needs one (review flow without closing the sheet). */
  const advance = (updated: JuniorNote) => {
    if (opened?.src === "queue") {
      const rest = queue.filter((n) => n.id !== updated.id);
      const idx = Math.max(0, queue.findIndex((n) => n.id === updated.id));
      const next = rest[idx] ?? rest[0];
      if (next) setOpened({ id: next.id, src: "queue" });
      else { setOpened(null); toast({ title: t("junior.team.queueDone"), description: t("junior.team.queueDoneDesc") }); }
      return;
    }
    const next = nextUnanswered(reviewable.map((n) => (n.id === updated.id ? updated : n)), updated.id);
    if (next) setOpened({ id: next.id, src: "team" });
  };
  const teamHasMoreUnanswered = !!openNote && opened?.src === "team" && !!nextUnanswered(reviewable, openNote.id);

  const openByTrader = (trader: string) => {
    const n = allNotes.find((x) => x.trader === trader);
    if (n) setOpenId(n.id);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Day switcher + whose juniors */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="icon" variant="ghost" className="h-9 w-9" aria-label={t("prevTradingDay")} onClick={() => setDate(prevTradingDay(date))}>
          <ChevronLeft />
        </Button>
        <label className="glass-field relative inline-flex h-9 cursor-pointer items-center gap-2 px-3.5 text-sm font-medium focus-within:ring-2 focus-within:ring-ring">
          <span className="first-letter:uppercase">{fmtDate(date, "weekdayDayMonthLong")}</span>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          <input type="date" aria-label={t("junior.team.dateAria")} value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
        </label>
        <Button size="icon" variant="ghost" className="h-9 w-9" aria-label={t("nextTradingDay")} disabled={nextTradingDay(date) > today} onClick={() => setDate(nextTradingDay(date))}>
          <ChevronRight />
        </Button>
        {date !== today && <Button variant="outline" onClick={() => setDate(today)}>{tc("time.today")}</Button>}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {rows.length > 6 && <PeopleSearchInput value={who} onChange={setWho} className="sm:w-52" />}
          {isMentor && (
            <Pill tone="purple" title={t("junior.team.mentorTitle", { names: mineList.map(personName).join(", ") })}>
              <GraduationCap className="h-3 w-3" aria-hidden="true" />{t("junior.team.mentor", { count: mineList.length })}
            </Pill>
          )}
          {canFilterMine && (
            <Segmented
              size="sm"
              ariaLabel={t("junior.team.scopeAria")}
              value={scope}
              onChange={setScope}
              options={[
                { value: "mine", label: t("junior.team.myJuniors"), count: mineList.length },
                { value: "all", label: isMentor ? t("junior.team.wholeTeam") : tc("states.all") },
              ]}
            />
          )}
          {!isReviewer && <Pill tone="neutral">{t("junior.team.readOnly")}</Pill>}
        </div>
      </div>

      {/* Senior desk overview */}
      {isReviewer && (overviewQ.isLoading ? (
        <>
          <StatGrid>{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[92px] rounded-2xl" />)}</StatGrid>
          <Skeleton className="h-64 w-full rounded-2xl" />
        </>
      ) : overviewQ.isError ? (
        isNotFound(overviewQ.error) ? null : (
          <LoadError text={t("junior.team.overviewFailed")} onRetry={() => overviewQ.refetch()} />
        )
      ) : (
        <>
          <StatGrid>
            <StatCard label={t("junior.team.wrote")} value={`${wrote.length} / ${rows.length}`} tone={rows.length && wrote.length === rows.length ? "up" : "neutral"} hint={date === today ? t("junior.team.today") : fmtDate(date, "dayMonth")} />
            <StatCard label={t("junior.team.noNote")} value={missed.length} tone={missed.length ? "warn" : "up"} hint={missed.filter((r) => r.reminder).length ? t("junior.team.remindedCount", { count: missed.filter((r) => r.reminder).length }) : t("junior.team.forThisDay")} />
            <StatCard
              label={t("junior.team.waitingCount")}
              icon={Inbox}
              value={queue.length}
              tone={queue.length ? "accent" : "up"}
              hint={queue.length ? t("junior.team.waitingHint", { days: oldestWait }) : t("junior.team.queueEmpty")}
            />
            <StatCard
              label={t("junior.team.needAttention")}
              icon={AlertTriangle}
              value={flagged.length}
              tone={flagged.length ? "warn" : "up"}
              hint={teamAvg ? t("junior.team.teamAvg", { avg: teamAvg }) : t("junior.team.attentionHint")}
              onClick={flagged.length ? () => { setFlaggedOnly(true); setSort("attention"); } : undefined}
            />
          </StatGrid>

          {/* Inbox: unanswered summaries across days */}
          {!isNotFound(queueQ.error) && (
            <Panel
              title={t("junior.team.waitingCount")}
              icon={Inbox}
              description={t("junior.team.queueDescription")}
              actions={
                queue.length > 0 ? (
                  <Button size="sm" onClick={() => setOpened({ id: queue[0]!.id, src: "queue" })}>
                    <Play aria-hidden="true" />{t("junior.team.reviewQueue", { count: queue.length })}
                  </Button>
                ) : undefined
              }
            >
              {queueQ.isLoading ? (
                <div className="space-y-2" aria-busy="true">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 rounded-xl" />)}</div>
              ) : queueQ.isError ? (
                <LoadError text={t("junior.team.queueFailed")} onRetry={() => queueQ.refetch()} />
              ) : queue.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("junior.team.queueAllAnswered")}</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {queue.slice(0, 8).map((n) => {
                    const wait = daysSince(n.note_date, today);
                    return (
                      <li key={n.id}>
                        <button
                          type="button"
                          onClick={() => setOpened({ id: n.id, src: "queue" })}
                          className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-2 py-2 text-left hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-nowrap"
                        >
                          <span className="w-14 shrink-0 text-xs tabular-nums text-muted-foreground">{fmtDate(n.note_date, "dayMonth")}</span>
                          <Initial name={n.trader} className="h-7 w-7" />
                          <span className="shrink-0 text-sm font-medium">{personName(n.trader)}</span>
                          <span className="min-w-0 flex-1 basis-full truncate text-sm text-muted-foreground sm:basis-auto" title={previewSections(sectionsOf(n)) || n.raw_text}>{previewSections(sectionsOf(n)) || n.raw_text}</span>
                          {hasDraft(n.id) && <Pill tone="purple"><PenLine className="h-3 w-3" aria-hidden="true" />{t("draftPill")}</Pill>}
                          {wait >= 2 && <Pill tone={wait >= 4 ? "down" : "warn"}>{t("junior.team.waitsDays", { days: wait })}</Pill>}
                          <MoodPill mood={n.mood} />
                        </button>
                      </li>
                    );
                  })}
                  {queue.length > 8 && <li className="px-2 pt-1 text-xs text-muted-foreground">{t("moreCount", { count: queue.length - 8 })}</li>}
                </ul>
              )}
            </Panel>
          )}

          <Panel
            title={isMentor || scope === "mine" ? t("junior.team.myJuniors") : t("junior.team.team")}
            icon={Users}
            description={t("junior.team.rosterDescription")}
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <Segmented
                  size="sm"
                  ariaLabel={t("junior.team.sortAria")}
                  value={sort}
                  onChange={(v) => { setSort(v); writePref(SORT_KEY, v); }}
                  options={[{ value: "attention", label: t("junior.team.byAttention") }, { value: "name", label: t("junior.team.byName") }]}
                />
                <Button size="sm" variant={flaggedOnly ? "default" : "ghost"} aria-pressed={flaggedOnly} onClick={() => setFlaggedOnly((v) => !v)}>
                  <AlertTriangle aria-hidden="true" />{t("junior.team.needAttention")}
                </Button>
                {missed.filter((r) => !r.reminder).length > 0 && (
                  <Button size="sm" variant="outline" disabled={reminding.size > 0} onClick={() => void remind(missed.filter((r) => !r.reminder).map((r) => r.trader))}>
                    <BellRing aria-hidden="true" />
                    {t("junior.team.remindAll", { count: missed.filter((r) => !r.reminder).length })}
                  </Button>
                )}
              </div>
            }
            padded={false}
          >
            {rows.length === 0 ? (
              <EmptyState icon={Users} title={scope === "mine" || isMentor ? t("junior.team.noJuniors") : t("junior.team.noTraders")} />
            ) : shownRows.length === 0 ? (
              <p className="px-5 pb-5 text-sm text-muted-foreground">{t("junior.team.allFine")}</p>
            ) : (
              <ul className="divide-y divide-border px-2 pb-2 sm:px-3">
                {shownRows.map((r) => (
                  <RosterRow
                    key={r.trader}
                    r={r}
                    busy={reminding.has(r.trader)}
                    showMine={scope === "all" && !isMentor}
                    onOpen={() => openByTrader(r.trader)}
                    onRemind={() => void remind([r.trader])}
                  />
                ))}
              </ul>
            )}
          </Panel>
        </>
      ))}

      {/* Notes of the day */}
      <Panel
        title={t("junior.team.dayNotes")}
        description={isReviewer ? t("junior.team.dayNotesReviewer") : t("junior.team.dayNotesJunior")}
        actions={
          reviewable.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => setSelected(selected.size === reviewable.length ? new Set() : new Set(reviewable.map((n) => n.id)))}>
                {selected.size === reviewable.length ? t("junior.team.unselectAll") : tc("actions.selectAll")}
              </Button>
              <Button size="sm" variant="outline" disabled={summarizing || selected.size === 0} onClick={() => void generateSummary()}>
                {summarizing ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
                {summarizing ? t("analyzing") : selected.size ? t("junior.team.aiSummaryCount", { count: selected.size }) : t("junior.team.aiSummary")}
              </Button>
            </div>
          ) : undefined
        }
      >
        {summary && (
          <div className="mb-4 rounded-xl bg-primary/10 p-4">
            <div className="mb-2 flex items-center gap-1.5 text-sm text-primary">
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              <span className="font-medium">{t("junior.team.groupSummary")}</span>
              <button type="button" aria-label={t("closeSummary")} onClick={() => setSummary(null)} className="ml-auto grid h-8 w-8 place-items-center rounded-full text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>
            <MarkdownText text={summary} />
          </div>
        )}

        {teamQ.isLoading ? (
          <div className="grid gap-3 md:grid-cols-2" aria-busy="true">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-32 rounded-xl" />)}
          </div>
        ) : teamQ.isError ? (
          <LoadError text={t("junior.team.teamFailed")} onRetry={() => teamQ.refetch()} />
        ) : notes.length === 0 ? (
          <EmptyState
            icon={Users}
            title={!isReviewer ? t("junior.team.noOwnNote") : scope === "mine" ? t("junior.team.noJuniorNotes") : t("junior.team.noNotes")}
            description={date === today ? t("junior.team.notesAppear") : undefined}
          />
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {notes.map((n) => {
              const isSel = selected.has(n.id);
              const mayReview = canReview(n.trader);
              const text = previewSections(sectionsOf(n));
              return (
                <li key={n.id} className={cn("relative rounded-xl bg-[var(--glass-bg)] transition-shadow", isSel && "ring-1 ring-primary/60")}>
                  <button
                    type="button"
                    onClick={() => setOpenId(n.id)}
                    className="flex h-full w-full flex-col gap-2 rounded-xl p-4 text-left hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <div className={cn("flex flex-wrap items-center gap-2", mayReview && "pr-9")}>
                      <Initial name={n.trader} />
                      <span className="text-sm font-semibold">{personName(n.trader)}</span>
                      <MoodPill mood={n.mood} />
                    </div>
                    <p className="line-clamp-3 text-sm text-muted-foreground">{text || n.raw_text}</p>
                    <div className="mt-auto flex flex-wrap items-center gap-2 pt-1 text-xs text-muted-foreground">
                      {n.reviewed_at ? (
                        <>
                          <Pill tone="up"><MessageSquareQuote className="h-3 w-3" aria-hidden="true" />{t("junior.team.answerBy", { name: personName(n.reviewed_by) })}</Pill>
                          <ScoreStars score={n.curator_score} />
                        </>
                      ) : (
                        <Pill tone="accent" dot>{t("waiting")}</Pill>
                      )}
                      {mayReview && hasDraft(n.id) && <Pill tone="purple"><PenLine className="h-3 w-3" aria-hidden="true" />{t("draftPill")}</Pill>}
                      <span className="ml-auto">{relTime(n.updated_at)}</span>
                    </div>
                  </button>
                  {mayReview && (
                    <button
                      type="button"
                      aria-pressed={isSel}
                      aria-label={t("junior.team.selectAria", { name: personName(n.trader) })}
                      onClick={() => setSelected((p) => { const s = new Set(p); if (s.has(n.id)) s.delete(n.id); else s.add(n.id); return s; })}
                      className={cn(
                        "absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        isSel ? "border-primary bg-primary text-primary-foreground" : "border-[var(--field-border)] text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <Check className="h-4 w-4" aria-hidden="true" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <JuniorNoteSheet
        note={openNote}
        open={openNote != null}
        onOpenChange={(o) => { if (!o) setOpenId(null); }}
        mode={openNote && canReview(openNote.trader) ? "curator" : openNote?.trader === me ? "owner" : "reader"}
        onReviewed={advance}
        submitLabel={
          opened?.src === "queue"
            ? (queue.length > 1 ? t("junior.team.sendNext") : t("junior.team.sendFinish"))
            : teamHasMoreUnanswered ? t("junior.team.sendNext") : undefined
        }
        nav={nav}
      />
    </div>
  );
}

function localStorageHas(key: string): boolean {
  try { return localStorage.getItem(key) != null; } catch { return false; }
}

function RosterRow({
  r, busy, showMine, onOpen, onRemind,
}: { r: OverviewRow; busy: boolean; showMine: boolean; onOpen: () => void; onRemind: () => void }) {
  const { t } = notesI18n.useT();
  const n = r.note;
  const flags = (r.attention ?? []).filter((f) => !(f.kind === "unanswered" && n && !n.reviewed_at && r.unreviewed_14d <= 1));
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-2 py-3">
      <Initial name={r.trader} />
      <div className="min-w-0 flex-1 basis-48">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{personName(r.trader)}</span>
          {showMine && r.mine && <Pill tone="purple">{t("junior.team.mine")}</Pill>}
          {n ? (
            <Pill tone={n.reviewed_at ? "up" : "accent"} dot>{n.reviewed_at ? t("answered") : t("waiting")}{n.words ? ` · ${t("wordsShort", { count: n.words })}` : ""}</Pill>
          ) : r.reminder ? (
            <Pill tone="warn" dot>{t("junior.team.remindedAgo", { ago: relTime(r.reminder.created_at) })}</Pill>
          ) : (
            <Pill tone="down" dot>{t("junior.team.noNote")}</Pill>
          )}
          {r.streak > 0 && (
            <Pill tone={r.streak >= 5 ? "accent" : "neutral"}>
              <Flame className="h-3 w-3" aria-hidden="true" />{t("junior.team.inARow", { count: r.streak })}
            </Pill>
          )}
          {flags.map((f) => <Pill key={f.kind} tone={f.tone}>{f.label}</Pill>)}
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground" title={n?.preview || undefined}>
          {n
            ? n.preview || t("junior.team.emptyNote")
            : r.last_note_date ? t("junior.team.lastNote", { date: fmtDate(r.last_note_date, "dayMonth") }) : t("junior.team.noNotesYet")}
          {" · "}
          {t("junior.team.notes30", { count: r.notes_30d })}
          {r.repeated && r.repeated.length > 0 && r.repeated[0]!.count < 3 && ` · ${t("junior.team.mostOften", { label: r.repeated[0]!.label.toLowerCase() })}`}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {r.trend && r.trend.scores.length > 0 && (
          <span className="hidden items-center gap-1.5 sm:inline-flex" title={t("junior.team.trendTitle", { avg: fmtNum(r.trend.avg, 1), recent: fmtNum(r.trend.recent, 1) })}>
            <ScoreTrail scores={r.trend.scores} />
            <span className="text-xs tabular-nums text-muted-foreground">{fmtNum(r.trend.recent, { decimals: 1, fallback: "" })}</span>
            <TrendArrow trend={r.trend} />
          </span>
        )}
        {n ? (
          <Button size="sm" variant={n.reviewed_at ? "ghost" : "outline"} onClick={onOpen} aria-label={t(n.reviewed_at ? "junior.team.openAria" : "junior.team.replyAria", { name: personName(r.trader) })}>
            {n.reviewed_at ? t("junior.team.open") : t("junior.team.reply")}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" disabled={busy} onClick={onRemind} aria-label={t("junior.team.remindAria", { name: personName(r.trader) })}>
            {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <BellRing aria-hidden="true" />}
            {r.reminder ? t("junior.team.again") : t("junior.team.remind")}
          </Button>
        )}
      </div>
    </li>
  );
}
