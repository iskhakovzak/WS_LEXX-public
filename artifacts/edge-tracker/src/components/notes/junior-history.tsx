import * as React from "react";
import { BookOpen, Search, X } from "lucide-react";
import {
  CartesianGrid, ComposedChart, Bar, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { EmptyState, Panel, Pill, Segmented, Toolbar } from "@/components/ds";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  SECTION_META, TOOLTIP_STYLE, previewSections, filledKeys, isUnread, moodLabelByScore, moodMeta,
  sectionsOf, type JuniorNote,
} from "./junior-lib";
import { fmtDate, fmtWeekday } from "@/lib/format";
import { Highlight, LoadError, MoodPill, ScoreStars } from "./junior-ui";
import { JuniorNoteSheet } from "./junior-note-sheet";
import { notesI18n } from "@/i18n/ns/notes";
import { commonI18n } from "@/i18n/ns/common";

type Filter = "all" | "answered" | "unread" | "waiting";
const FILTER_KEY = "ws_lexx_junior_history_filter";

function readFilter(): Filter {
  try {
    const v = localStorage.getItem(FILTER_KEY);
    return v === "answered" || v === "unread" || v === "waiting" ? v : "all";
  } catch {
    return "all";
  }
}

/** Snippet around the first match so search hits are visible in the row. */
function snippet(text: string, q: string, len = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!q) return flat.slice(0, len) + (flat.length > len ? "…" : "");
  const i = flat.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return flat.slice(0, len) + (flat.length > len ? "…" : "");
  const start = Math.max(0, i - 50);
  const out = flat.slice(start, start + len);
  return (start > 0 ? "…" : "") + out + (start + len < flat.length ? "…" : "");
}

export function JuniorHistory({
  history,
  isLoading,
  isError,
  onRetry,
  onOpenInEditor,
}: {
  history: JuniorNote[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onOpenInEditor: (date: string) => void;
}) {
  const { t } = notesI18n.useT();
  const { t: tc } = commonI18n.useT();
  const [q, setQ] = React.useState("");
  const [filter, setFilterState] = React.useState<Filter>(readFilter);
  const [openId, setOpenId] = React.useState<number | null>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);

  const setFilter = (f: Filter) => {
    setFilterState(f);
    try { localStorage.setItem(FILTER_KEY, f); } catch { /* ignore */ }
  };

  // "/" focuses search.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === "/" && !(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable))) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const counts = React.useMemo(() => ({
    all: history.length,
    answered: history.filter((n) => n.reviewed_at).length,
    unread: history.filter(isUnread).length,
    waiting: history.filter((n) => !n.reviewed_at).length,
  }), [history]);

  const needle = q.trim().toLowerCase();
  const rows = React.useMemo(() => {
    return history.filter((n) => {
      if (filter === "answered" && !n.reviewed_at) return false;
      if (filter === "unread" && !isUnread(n)) return false;
      if (filter === "waiting" && n.reviewed_at) return false;
      if (!needle) return true;
      const hay = `${previewSections(sectionsOf(n))}\n${n.curator_feedback ?? ""}\n${moodMeta(n.mood)?.label ?? ""}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [history, filter, needle]);

  const trend = React.useMemo(
    () =>
      history
        .slice(0, 30)
        .reverse()
        .map((n) => ({
          date: n.note_date,
          label: fmtDate(n.note_date, "dayMonth"),
          mood: moodMeta(n.mood)?.score ?? null,
          score: n.curator_score ?? null,
        })),
    [history],
  );
  const hasTrend = trend.some((t) => t.mood != null || t.score != null);

  const openNote = history.find((n) => n.id === openId) ?? null;

  if (isLoading && history.length === 0) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label={tc("states.loading")}>
        <Skeleton className="h-48 w-full rounded-2xl" />
        <Skeleton className="h-12 w-full rounded-2xl" />
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}
      </div>
    );
  }
  if (isError && history.length === 0) return <LoadError text={t("historyLoadFailed")} onRetry={onRetry} />;
  if (history.length === 0) {
    return (
      <Panel>
        <EmptyState
          icon={BookOpen}
          title={t("junior.history.emptyTitle")}
          description={t("junior.history.emptyDescription")}
        />
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title={t("junior.history.trendTitle")}
        description={t("junior.history.trendDescription")}
      >
        {hasTrend ? (
          <div className="h-44 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={trend} margin={{ top: 8, right: 8, left: -24, bottom: 0 }}>
                <CartesianGrid stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} minTickGap={16} />
                <YAxis domain={[0, 5]} ticks={[1, 3, 5]} stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  cursor={{ fill: "hsl(var(--muted-foreground) / 0.08)" }}
                  formatter={(v: number, name: string) => {
                    if (name === "mood") return [moodLabelByScore(v), t("stateLabel")];
                    return [t("junior.score.ofFive", { score: v }), t("junior.history.curatorScore")];
                  }}
                />
                <Bar isAnimationActive={false} dataKey="score" name="score" fill="hsl(var(--chart-3) / 0.55)" radius={[6, 6, 0, 0]} maxBarSize={18} />
                <Line dataKey="mood" name="mood" type="monotone" stroke="hsl(var(--chart-1))" strokeWidth={2} dot={{ r: 2.5 }} connectNulls isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("junior.history.noTrend")}</p>
        )}
      </Panel>

      <Toolbar>
        <div className="relative min-w-0 flex-1 basis-56">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            ref={searchRef}
            type="search"
            aria-label={t("searchNotes")}
            placeholder={t("junior.history.searchPlaceholder")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { setQ(""); (e.target as HTMLInputElement).blur(); } }}
            className="pl-10 pr-10"
          />
          {q ? (
            <button type="button" aria-label={tc("actions.clearSearch")} onClick={() => setQ("")} className="absolute right-1.5 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          ) : (
            <Kbd className="absolute right-3 top-1/2 hidden -translate-y-1/2 sm:inline-flex">/</Kbd>
          )}
        </div>
        <Segmented
          ariaLabel={t("junior.history.filterAria")}
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: t("junior.history.filters.all"), count: counts.all },
            { value: "answered", label: t("junior.history.filters.answered"), count: counts.answered },
            { value: "unread", label: t("junior.history.filters.unread"), count: counts.unread },
            { value: "waiting", label: t("junior.history.filters.waiting"), count: counts.waiting },
          ]}
        />
      </Toolbar>

      {rows.length === 0 ? (
        <Panel>
          <EmptyState icon={Search} title={tc("states.nothingFound")} description={t("junior.history.notFoundDescription")} />
        </Panel>
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t("junior.history.listAria")}>
          {rows.map((n) => {
            const s = sectionsOf(n);
            const keys = filledKeys(s).filter((k) => k !== "free");
            const unread = isUnread(n);
            return (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(n.id)}
                  className={cn(
                    "glass-panel lift flex w-full items-start gap-3 rounded-xl p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-4",
                    unread && "ring-1 ring-primary/50",
                  )}
                >
                  <div className="w-12 shrink-0 text-center">
                    <div className="text-lg font-semibold tabular-nums leading-tight">{new Date(n.note_date + "T12:00:00").getDate()}</div>
                    <div className="text-xs text-muted-foreground">{fmtWeekday(n.note_date)}</div>
                  </div>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium">{fmtDate(n.note_date, "dayMonth")}</span>
                      <MoodPill mood={n.mood} />
                      {n.reviewed_at && (
                        <Pill tone={unread ? "accent" : "neutral"} dot={unread}>
                          {unread ? t("junior.newFeedback") : t("junior.feedbackTitle")}
                        </Pill>
                      )}
                      <ScoreStars score={n.curator_score} className="ml-auto" />
                    </div>
                    <p className="line-clamp-2 text-sm text-muted-foreground">
                      <Highlight text={snippet(previewSections(s) || n.raw_text, needle)} q={needle} />
                    </p>
                    {needle && n.curator_feedback?.toLowerCase().includes(needle) && (
                      <p className="line-clamp-1 text-xs text-primary">
                        {t("junior.history.curatorPrefix")} <Highlight text={snippet(n.curator_feedback, needle, 100)} q={needle} />
                      </p>
                    )}
                    {keys.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {keys.map((k) => (
                          <span key={k} className="rounded-full bg-[var(--glass-bg)] px-2 py-0.5 text-2xs text-muted-foreground">
                            {SECTION_META[k].title}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <JuniorNoteSheet
        note={openNote}
        open={openNote != null}
        onOpenChange={(o) => { if (!o) setOpenId(null); }}
        mode="owner"
        q={needle}
        onOpenInEditor={onOpenInEditor}
      />
    </div>
  );
}

