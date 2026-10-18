import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CandlestickChart, Check, CheckCheck, ChevronDown, ListChecks, RefreshCw, Search, Sparkles, Users, X } from "lucide-react";
import { EmptyState, FilterChip, Panel, Pill, Segmented, Toolbar, toneOf, toneText } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { AuthorMarkdown, NoteReader } from "./author-reader";
import { AN_KEYS, addDays, fetchFeed, moodOf, type DaySnapshot, type FeedNote } from "./author-model";
import { fmtDate, fmtR, fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { notesI18n } from "@/i18n/ns/notes";
import { http } from "@/lib/api/http";
import { matchesSearch } from "./author-plan";
import { personName, personInitials, comparePersonNames } from "@/i18n";

export type FeedRange = "day" | "week" | "month";
const RANGE_DAYS: Record<FeedRange, number> = { day: 0, week: 6, month: 29 };

export function feedRange(anchor: string, range: FeedRange) {
  return { from: addDays(anchor, -RANGE_DAYS[range]), to: anchor };
}

export function useAuthorFeed(from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: AN_KEYS.feed(from, to),
    queryFn: () => fetchFeed(from, to),
    enabled,
    staleTime: 30_000,
    refetchInterval: 120_000,
  });
}

function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary/15 text-sm font-semibold text-primary", className)}
      aria-hidden="true"
    >
      {personInitials(name).slice(0, 1)}
    </span>
  );
}

function ReadReceipts({ note }: { note: FeedNote }) {
  const { t } = notesI18n.useT();
  if (note.legacy) return null;
  if (!note.reads.length) return <span className="text-xs text-muted-foreground">{t("author.feed.nobodyRead")}</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-2 text-xs text-muted-foreground" tabIndex={0}>
          <span className="flex -space-x-1.5">
            {note.reads.slice(0, 5).map((r) => (
              <Avatar key={r.reader} name={r.reader} className="h-6 w-6 text-2xs ring-2 ring-background" />
            ))}
          </span>
          {t("author.feed.readCount", { count: note.reads.length })}
        </span>
      </TooltipTrigger>
      <TooltipContent className="whitespace-pre-line">
        {note.reads.map((r) => `${personName(r.reader)} · ${fmtDate(r.read_at, "dateTime")}`).join("\n")}
      </TooltipContent>
    </Tooltip>
  );
}

/** The author's trading day under the card header. $ only arrives for the owner / staff (server redacts it). */
function DayStrip({ day, onTicker }: { day: DaySnapshot; onTicker: (t: string) => void }) {
  const { t: tn } = notesI18n.useT();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl bg-[var(--glass-bg)] px-3 py-2 text-xs">
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <CandlestickChart className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="tabular-nums text-foreground">{day.count}</span> {commonI18n.t("units.tradesWord", { count: day.count })}
        {day.wins + day.losses > 0 && <span className="tabular-nums">· {day.wins}W / {day.losses}L</span>}
      </span>
      {day.rSum != null && <span className={cn("font-medium tabular-nums", toneText(toneOf(day.rSum)))}>{fmtR(day.rSum, 1)}</span>}
      {day.pnlNet != null && <span className={cn("font-medium tabular-nums", toneText(toneOf(day.pnlNet)))}>{fmtUsd(day.pnlNet, { signed: true, decimals: 0 })}</span>}
      {day.tickers.length > 0 && (
        <span className="flex flex-wrap gap-1" role="group" aria-label={tn("author.feed.tickersAria")}>
          {day.tickers.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => onTicker(t)}
              title={tn("author.feed.findTicker", { ticker: t })}
              className="rounded-md bg-primary/12 px-1.5 py-0.5 font-mono text-2xs font-semibold text-accent-soft hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}

function FeedCard({
  note,
  me,
  showDate,
  selecting,
  selected,
  onToggleSelect,
  onToggleRead,
  busy,
  query,
  onTicker,
}: {
  note: FeedNote;
  me: string;
  showDate: boolean;
  selecting: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onToggleRead: () => void;
  busy: boolean;
  /** Active feed search (leading $ stripped): highlighted, and long notes open so the match is visible. */
  query: string;
  onTicker: (t: string) => void;
}) {
  const { t } = notesI18n.useT();
  const [open, setExpanded] = React.useState(false);
  const expanded = open || !!query;
  const [ai, setAi] = React.useState(false);
  const mine = note.trader === me;
  const mood = moodOf(note.mood);
  const long = (note.raw_text?.length ?? 0) > 700;
  const unread = !mine && !note.read_by_me && !note.legacy;

  return (
    <article
      className={cn(
        "glass-panel relative flex flex-col gap-3 rounded-2xl p-4 sm:p-5 transition-shadow",
        selected && "ring-2 ring-primary/50",
      )}
      aria-label={t("author.feed.cardAria", { name: personName(note.trader), date: fmtDate(note.note_date, "dayMonth") })}
    >
      {unread && <span className="absolute left-0 top-6 h-6 w-1 rounded-r-full bg-primary" aria-hidden="true" />}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {selecting && (
          <button
            type="button"
            onClick={onToggleSelect}
            aria-pressed={selected}
            aria-label={t("author.feed.selectAria", { name: personName(note.trader) })}
            className={cn(
              "grid h-6 w-6 place-items-center rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected ? "border-primary bg-primary text-primary-foreground" : "border-[var(--field-border)]",
            )}
          >
            {selected && <Check className="h-3.5 w-3.5" />}
          </button>
        )}
        <Avatar name={note.trader} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            {personName(note.trader)}
            {mine && <Pill>{t("author.feed.mine")}</Pill>}
            {unread && <Pill tone="accent" dot>{t("author.feed.new")}</Pill>}
          </span>
          <span className="inline-block text-xs text-muted-foreground first-letter:uppercase">
            {showDate ? fmtDate(note.note_date, "weekdayDayMonthLong") : t("author.feed.updated", { time: fmtDate(note.updated_at, "time") })}
          </span>
        </div>
        {mood && (
          <span className="text-sm" title={mood.label}>
            <span aria-hidden="true">{mood.emoji}</span> <span className="text-xs text-muted-foreground">{mood.label}</span>
          </span>
        )}
      </header>

      {note.day && <DayStrip day={note.day} onTicker={onTicker} />}

      {note.refined_text && (
        <div className="glass-field inline-flex self-start p-0.5" role="group" aria-label={t("author.feed.versionAria")}>
          <button type="button" aria-pressed={!ai} onClick={() => setAi(false)} className={cn("min-h-7 rounded-full px-2.5 text-xs font-medium", !ai ? "bg-primary-solid text-primary-foreground" : "text-muted-foreground")}>{t("original")}</button>
          <button type="button" aria-pressed={ai} onClick={() => setAi(true)} className={cn("inline-flex min-h-7 items-center gap-1 rounded-full px-2.5 text-xs font-medium", ai ? "bg-primary-solid text-primary-foreground" : "text-muted-foreground")}>
            <Sparkles className="h-3 w-3" aria-hidden="true" />AI
          </button>
        </div>
      )}

      <div className={cn("relative", long && !expanded && "max-h-72 overflow-hidden")}>
        {ai && note.refined_text ? <AuthorMarkdown text={note.refined_text} query={query} /> : <NoteReader raw={note.raw_text} query={query} compact />}
        {long && !expanded && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[hsl(var(--card))] to-transparent" aria-hidden="true" />
        )}
      </div>
      {long && !query && (
        <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} className="inline-flex items-center gap-1 self-start text-xs font-medium text-primary hover:underline">
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} aria-hidden="true" />
          {expanded ? commonI18n.t("actions.collapse") : t("author.feed.readMore")}
        </button>
      )}

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        {mine ? <ReadReceipts note={note} /> : note.legacy ? <span /> : (
          <span className="text-xs text-muted-foreground">
            {note.read_by_me ? t("author.feed.markedRead") : t("author.feed.readHint")}
          </span>
        )}
        {!mine && !note.legacy && (
          <Button
            size="sm"
            variant={note.read_by_me ? "ghost" : "outline"}
            onClick={onToggleRead}
            disabled={busy}
            aria-pressed={note.read_by_me}
            className="gap-1.5"
          >
            {note.read_by_me ? <CheckCheck className="h-3.5 w-3.5 text-up" aria-hidden="true" /> : <Check className="h-3.5 w-3.5" aria-hidden="true" />}
            {note.read_by_me ? t("author.feed.read") : t("author.feed.markRead")}
          </Button>
        )}
      </footer>
    </article>
  );
}

export function AuthorFeed({
  anchor,
  me,
  range,
  onRangeChange,
}: {
  anchor: string;
  me: string;
  range: FeedRange;
  onRangeChange: (r: FeedRange) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t } = notesI18n.useT();
  const { t: tc } = commonI18n.useT();
  const { from, to } = feedRange(anchor, range);
  const key = AN_KEYS.feed(from, to);
  const q = useAuthorFeed(from, to);
  const [author, setAuthor] = React.useState<string | null>(null);
  const [unreadOnly, setUnreadOnly] = React.useState(false);
  const [selecting, setSelecting] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<number>>(new Set());
  const [summary, setSummary] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<number | null>(null);
  const [search, setSearch] = React.useState("");
  const query = search.trim().replace(/^\$/, "");

  React.useEffect(() => { setSelected(new Set()); setSummary(null); }, [from, to]);

  const notes = q.data ?? [];
  const authors = React.useMemo(() => Array.from(new Set(notes.map((n) => n.trader))).sort(comparePersonNames), [notes]);
  const visible = notes.filter((n) =>
    (!author || n.trader === author) && (!unreadOnly || (!n.read_by_me && n.trader !== me)) && matchesSearch(n, search),
  );
  const unread = notes.filter((n) => !n.read_by_me && n.trader !== me && !n.legacy);
  const legacy = notes.some((n) => n.legacy);

  const patchRead = (id: number, read: boolean) => {
    qc.setQueryData<FeedNote[]>(key, (prev) =>
      prev?.map((n) =>
        n.id !== id
          ? n
          : {
              ...n,
              read_by_me: read,
              reads: read
                ? n.reads.some((r) => r.reader === me) ? n.reads : [...n.reads, { reader: me, read_at: new Date().toISOString() }]
                : n.reads.filter((r) => r.reader !== me),
            },
      ),
    );
  };

  const toggleRead = useMutation({
    mutationFn: async ({ id, read }: { id: number; read: boolean }) =>
      http.send(read ? "POST" : "DELETE", `/api/author-notes/${id}/read`),
    onMutate: ({ id, read }) => { setBusyId(id); patchRead(id, read); },
    onError: (e: Error, { id, read }) => {
      patchRead(id, !read);
      toast({ title: t("author.feed.markFailed"), description: e.message, variant: "destructive" });
    },
    onSettled: () => { setBusyId(null); void qc.invalidateQueries({ queryKey: ["author-notes", "feed"] }); },
  });

  const markAll = useMutation({
    mutationFn: async (ids: number[]) => {
      for (const id of ids) await http.post(`/api/author-notes/${id}/read`);
    },
    onMutate: (ids) => ids.forEach((id) => patchRead(id, true)),
    onError: (e: Error) => toast({ title: t("author.feed.markAllFailed"), description: e.message, variant: "destructive" }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["author-notes", "feed"] }),
  });

  const teamSummary = useMutation({
    mutationFn: (ids: number[]) => http.post<{ summary: string }>(`/api/author-notes/team-summary`, { note_ids: ids }),
    onSuccess: (d) => { setSummary(d.summary); setSelecting(false); },
    onError: (e: Error) => toast({ title: t("author.feed.aiFailed"), description: e.message, variant: "destructive" }),
  });

  return (
    <div className="flex flex-col gap-4">
      <Toolbar className="justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            ariaLabel={t("author.feed.rangeAria")}
            size="sm"
            value={range}
            onChange={onRangeChange}
            options={[
              { value: "day", label: tc("time.day") },
              { value: "week", label: tc("time.last7") },
              { value: "month", label: tc("time.last30") },
            ]}
          />
          <div className="relative w-full sm:w-56">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape" && search) { e.stopPropagation(); setSearch(""); } }}
              placeholder={t("author.feed.searchPlaceholder")}
              aria-label={t("author.feed.searchAria")}
              className="h-9 pl-8"
            />
          </div>
          <FilterChip active={unreadOnly} onClick={() => setUnreadOnly((v) => !v)} count={unread.length}>{t("author.feed.unread")}</FilterChip>
          {authors.length > 1 && authors.map((a) => (
            <FilterChip key={a} active={author === a} onClick={() => setAuthor(author === a ? null : a)}>{personName(a)}</FilterChip>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {unread.length > 0 && (
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => markAll.mutate(unread.map((n) => n.id))} disabled={markAll.isPending}>
              <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />{t("author.feed.readAll")}
            </Button>
          )}
          {notes.length > 0 && (selecting ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => { setSelecting(false); setSelected(new Set()); }}>{tc("actions.cancel")}</Button>
              <Button
                size="sm"
                className="gap-1.5"
                disabled={selected.size === 0 || teamSummary.isPending}
                onClick={() => teamSummary.mutate(Array.from(selected))}
              >
                {teamSummary.isPending ? <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />}
                {teamSummary.isPending ? t("analyzing") : t("author.feed.teamSummaryCount", { count: selected.size })}
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => { setSelecting(true); setSelected(new Set(visible.map((n) => n.id))); }}>
              <ListChecks className="h-3.5 w-3.5" aria-hidden="true" />{t("author.feed.teamSummary")}
            </Button>
          ))}
        </div>
      </Toolbar>

      {legacy && (
        <p className="px-1 text-xs text-muted-foreground">{t("author.feed.legacy")}</p>
      )}

      {summary && (
        <Panel
          title={t("author.feed.teamSummary")}
          icon={Sparkles}
          actions={<Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t("closeSummary")} onClick={() => setSummary(null)}><X className="h-4 w-4" /></Button>}
        >
          <AuthorMarkdown text={summary} />
        </Panel>
      )}

      {q.isLoading ? (
        <div className="flex flex-col gap-3" aria-busy="true" aria-label={t("author.feed.loading")}>
          {[0, 1].map((i) => <Skeleton key={i} className="h-48 rounded-2xl" />)}
        </div>
      ) : q.isError ? (
        <Panel>
          <EmptyState icon={Users} title={t("author.feed.loadFailed")} description={(q.error as Error)?.message} action={<Button variant="outline" onClick={() => q.refetch()}>{tc("actions.retry")}</Button>} />
        </Panel>
      ) : visible.length === 0 ? (
        <Panel>
          {query ? (
            <EmptyState
              icon={Search}
              title={t("author.feed.notFound", { query: search.trim() })}
              description={t("author.feed.period", { from: fmtDate(from, "dayMonth"), to: fmtDate(to, "dayMonth") })}
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <Button variant="outline" onClick={() => setSearch("")}>{t("author.feed.resetSearch")}</Button>
                  {range !== "month" && <Button variant="ghost" onClick={() => onRangeChange("month")}>{t("author.feed.search30")}</Button>}
                </div>
              }
            />
          ) : (
          <EmptyState
            icon={Users}
            title={unreadOnly ? t("author.feed.allRead") : t("author.feed.empty")}
            description={unreadOnly ? t("author.feed.noNew") : t("author.feed.widen", { from: fmtDate(from, "dayMonth"), to: fmtDate(to, "dayMonth") })}
            action={!unreadOnly && range !== "month" ? <Button variant="outline" onClick={() => onRangeChange(range === "day" ? "week" : "month")}>{range === "day" ? t("author.feed.showWeek") : t("author.feed.showMonth")}</Button> : undefined}
          />
          )}
        </Panel>
      ) : (
        <div className="flex flex-col gap-3">
          {visible.map((n) => (
            <FeedCard
              key={n.id}
              note={n}
              me={me}
              showDate={range !== "day"}
              selecting={selecting}
              selected={selected.has(n.id)}
              onToggleSelect={() => setSelected((prev) => { const next = new Set(prev); if (next.has(n.id)) next.delete(n.id); else next.add(n.id); return next; })}
              onToggleRead={() => toggleRead.mutate({ id: n.id, read: !n.read_by_me })}
              busy={busyId === n.id}
              query={query}
              onTicker={(t) => setSearch(t)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
