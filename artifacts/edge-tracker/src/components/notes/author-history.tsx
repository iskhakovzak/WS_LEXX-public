import * as React from "react";
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { BookOpen, Flame, MoreHorizontal, PenLine, Search, Sparkles, Trash2, X } from "lucide-react";
import { EmptyState, FilterChip, Panel, Pill, StatCard, StatGrid } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { AuthorMarkdown, Highlight, NoteReader } from "./author-reader";
import {
  CHART_TOOLTIP, MOODS, SECTIONS, filledSections, localToday,
  moodOf, notePreview, writingStreak, type AuthorNote,
} from "./author-model";
import { fmtDate, fmtWeekday } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { notesI18n } from "@/i18n/ns/notes";

function monthKey(d: string) {
  return fmtDate(d.slice(0, 10), "monthYear");
}

export function AuthorHistory({
  notes,
  loading,
  error,
  onRetry,
  onOpenInEditor,
  onDelete,
  canEdit,
}: {
  notes: AuthorNote[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onOpenInEditor: (date: string) => void;
  onDelete: (note: AuthorNote) => void;
  canEdit: boolean;
}) {
  const { t } = notesI18n.useT();
  const { t: tc } = commonI18n.useT();
  const [query, setQuery] = React.useState("");
  const [moodFilter, setMoodFilter] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<AuthorNote | null>(null);
  const [showAi, setShowAi] = React.useState(false);
  const searchRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const real = React.useMemo(() => notes.filter((n) => n.raw_text?.trim() || n.refined_text), [notes]);
  const today = localToday();

  const stats = React.useMemo(() => {
    const dates = new Set(real.map((n) => n.note_date.slice(0, 10)));
    const recent = real.slice(0, 20).map((n) => moodOf(n.mood)?.score).filter((x): x is 2 | 1 | 0 | -1 | -2 => x != null);
    const avg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : null;
    return {
      total: real.length,
      streak: writingStreak(dates, today),
      avg,
      ai: real.filter((n) => n.refined_text).length,
    };
  }, [real, today]);

  const avgMood = stats.avg == null ? null : MOODS.reduce((best, m) => (Math.abs(m.score - stats.avg!) < Math.abs(best.score - stats.avg!) ? m : best), MOODS[2]);

  const chart = React.useMemo(
    () =>
      real
        .slice(0, 45)
        .filter((n) => moodOf(n.mood))
        .map((n) => ({ date: n.note_date.slice(0, 10), score: moodOf(n.mood)!.score, emoji: moodOf(n.mood)!.emoji }))
        .reverse(),
    [real],
  );

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return real.filter((n) => {
      if (moodFilter && n.mood !== moodFilter) return false;
      if (!q) return true;
      return n.raw_text.toLowerCase().includes(q) || (n.refined_text ?? "").toLowerCase().includes(q) || n.note_date.includes(q);
    });
  }, [real, query, moodFilter]);

  const groups = React.useMemo(() => {
    const out: { month: string; items: AuthorNote[] }[] = [];
    for (const n of filtered) {
      const m = monthKey(n.note_date);
      const last = out[out.length - 1];
      if (last && last.month === m) last.items.push(n);
      else out.push({ month: m, items: [n] });
    }
    return out;
  }, [filtered]);

  if (loading && notes.length === 0) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label={t("author.history.loading")}>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}</div>
        <Skeleton className="h-44 rounded-2xl" />
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 rounded-2xl" />)}
      </div>
    );
  }
  if (error) {
    return (
      <Panel>
        <EmptyState icon={BookOpen} title={t("historyLoadFailed")} action={<Button variant="outline" onClick={onRetry}>{tc("actions.retry")}</Button>} />
      </Panel>
    );
  }
  if (real.length === 0) {
    return (
      <Panel>
        <EmptyState
          icon={BookOpen}
          title={t("author.history.emptyTitle")}
          description={t("author.history.emptyDescription")}
          action={canEdit ? <Button onClick={() => onOpenInEditor(today)}>{t("author.history.writeToday")}</Button> : undefined}
        />
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <StatGrid>
        <StatCard label={t("author.history.entries")} value={stats.total} icon={BookOpen} hint={t("author.history.allTime")} />
        <StatCard
          label={t("author.history.streak")}
          value={tc("units.days", { count: stats.streak })}
          icon={Flame}
          tone={stats.streak >= 5 ? "up" : "neutral"}
          hint={t("author.history.streakHint")}
        />
        <StatCard
          label={t("author.history.mood")}
          value={avgMood ? <span className="inline-flex items-center gap-2">{avgMood.emoji}<span className="text-base font-medium">{avgMood.label}</span></span> : "—"}
          hint={t("author.history.moodHint")}
        />
        <StatCard label={t("author.history.withAi")} value={stats.ai} icon={Sparkles} hint={stats.total ? t("author.history.aiShare", { pct: Math.round((stats.ai / stats.total) * 100) }) : undefined} />
      </StatGrid>

      {chart.length >= 2 && (
        <Panel title={t("author.history.moodTrend")} description={t("author.history.moodTrendDescription")}>
          <div className="h-40 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: -24 }}>
                <defs>
                  <linearGradient id="authorMoodFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--chart-1))" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="hsl(var(--chart-1))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tickFormatter={(d: string) => fmtDate(d, "dayMonth")} stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} minTickGap={24} />
                <YAxis domain={[-2, 2]} ticks={[-2, 0, 2]} tickFormatter={(v: number) => (v === 2 ? "💪" : v === 0 ? "😐" : "😤")} stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                <ReferenceLine y={0} stroke="hsl(var(--border))" />
                <Tooltip
                  contentStyle={CHART_TOOLTIP}
                  formatter={(_v: number, _n: string, item: { payload?: { score: number } }) => {
                    const m = MOODS.find((x) => x.score === item.payload?.score);
                    return [m ? `${m.emoji} ${m.label}` : "—", t("author.history.mood")];
                  }}
                  labelFormatter={(d: string) => fmtDate(d, "weekdayDayMonthLong")}
                />
                <Area type="monotone" dataKey="score" stroke="hsl(var(--chart-1))" strokeWidth={2} fill="url(#authorMoodFill)" dot={{ r: 2.5, fill: "hsl(var(--chart-1))" }} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { setQuery(""); e.currentTarget.blur(); } }}
            placeholder={t("author.history.searchPlaceholder")}
            aria-label={t("searchNotes")}
            className="pl-10 pr-16"
          />
          {query ? (
            <button type="button" onClick={() => setQuery("")} aria-label={tc("actions.clearSearch")} className="absolute right-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          ) : (
            <Kbd className="absolute right-3 top-1/2 -translate-y-1/2">/</Kbd>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("author.history.moodFilterAria")}>
          {MOODS.map((m) => (
            <FilterChip key={m.value} active={moodFilter === m.value} onClick={() => setMoodFilter(moodFilter === m.value ? null : m.value)}>
              <span aria-hidden="true">{m.emoji}</span>
              <span className="sr-only">{m.label}</span>
            </FilterChip>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <Panel>
          <EmptyState icon={Search} title={tc("states.nothingFound")} description={t("author.history.notFoundDescription")} />
        </Panel>
      ) : (
        <div className="flex flex-col gap-5">
          {query && <p className="text-xs text-muted-foreground" aria-live="polite">{t("author.history.found", { count: filtered.length })}</p>}
          {groups.map((g) => (
            <section key={g.month} className="flex flex-col gap-2">
              <h3 className="px-1 text-sm font-semibold capitalize text-foreground">{g.month}</h3>
              <ol className="relative flex flex-col gap-2 border-l border-border pl-4 sm:ml-2">
                {g.items.map((n) => {
                  const d = n.note_date.slice(0, 10);
                  const mood = moodOf(n.mood);
                  const filled = filledSections(n.raw_text);
                  return (
                    <li key={n.id} className="relative">
                      <span className="absolute -left-[21px] top-5 h-2.5 w-2.5 rounded-full border-2 border-background bg-primary" aria-hidden="true" />
                      <div className="glass-panel lift group flex items-start gap-3 rounded-2xl p-3 sm:p-4">
                        <button
                          type="button"
                          onClick={() => { setShowAi(false); setPreview(n); }}
                          className="flex min-w-0 flex-1 items-start gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl"
                        >
                          <div className="flex w-11 shrink-0 flex-col items-center rounded-xl bg-[var(--glass-bg)] py-1.5">
                            <span className="text-lg font-semibold leading-none tabular-nums">{Number(d.slice(8, 10))}</span>
                            <span className="text-2xs capitalize text-muted-foreground">{fmtWeekday(d)}</span>
                          </div>
                          <div className="flex min-w-0 flex-1 flex-col gap-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              {mood && <span className="text-sm" title={mood.label}>{mood.emoji} <span className="text-xs text-muted-foreground">{mood.label}</span></span>}
                              {n.refined_text && <Pill tone="accent">AI</Pill>}
                              {filled.length > 0 && (
                                <span className="text-xs text-muted-foreground">
                                  {t("author.blocksCount", { filled: filled.length, total: SECTIONS.length })}
                                </span>
                              )}
                            </div>
                            <p className="line-clamp-2 text-sm text-foreground/90">
                              <Highlight text={notePreview(n.raw_text || n.refined_text || "", 260)} query={query} />
                            </p>
                          </div>
                        </button>
                        {canEdit && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100 data-[state=open]:opacity-100" aria-label={t("author.history.rowActions", { date: fmtDate(d, "dayMonth") })}>
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onSelect={() => onOpenInEditor(d)}>
                                <PenLine className="mr-2 h-4 w-4" />{t("openInEditor")}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem className="text-down focus:text-down" onSelect={() => onDelete(n)}>
                                <Trash2 className="mr-2 h-4 w-4" />{tc("actions.delete")}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>
      )}

      <Sheet open={!!preview} onOpenChange={(o) => { if (!o) setPreview(null); }}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
          {preview && (
            <>
              <SheetHeader>
                <SheetTitle className="first-letter:uppercase">{fmtDate(preview.note_date, "weekdayDayMonthLong")}</SheetTitle>
                <SheetDescription>
                  {moodOf(preview.mood) ? `${moodOf(preview.mood)!.emoji} ${moodOf(preview.mood)!.label}` : t("author.history.noMood")}
                </SheetDescription>
              </SheetHeader>
              <div className="mt-4 flex flex-col gap-4">
                {preview.refined_text && (
                  <div className="glass-field inline-flex self-start p-1" role="group" aria-label={t("author.history.versionAria")}>
                    <button type="button" aria-pressed={!showAi} onClick={() => setShowAi(false)} className={cn("min-h-8 rounded-full px-3 text-sm", !showAi ? "bg-primary-solid text-primary-foreground" : "text-muted-foreground")}>{t("original")}</button>
                    <button type="button" aria-pressed={showAi} onClick={() => setShowAi(true)} className={cn("min-h-8 rounded-full px-3 text-sm", showAi ? "bg-primary-solid text-primary-foreground" : "text-muted-foreground")}>{t("aiVersion")}</button>
                  </div>
                )}
                {showAi && preview.refined_text ? (
                  <AuthorMarkdown text={preview.refined_text} query={query} />
                ) : (
                  <NoteReader raw={preview.raw_text} query={query} />
                )}
                {canEdit && (
                  <Button className="gap-1.5 self-start" onClick={() => { const d = preview.note_date.slice(0, 10); setPreview(null); onOpenInEditor(d); }}>
                    <PenLine className="h-4 w-4" />{t("openInEditor")}
                  </Button>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
