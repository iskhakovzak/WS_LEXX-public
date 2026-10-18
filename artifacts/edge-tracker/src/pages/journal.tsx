import { useCallback, useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useTradesBookFacets, useTradesWindow } from "@/hooks/use-trades-window";
import { BookOpenCheck, CalendarDays, ChevronLeft, ChevronRight, CloudUpload, History, Users } from "lucide-react";
import { Page, PageHeader, Segmented, Toolbar } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { QueryError } from "@/components/query-error";
import { useAuth } from "@/contexts/auth-context";
import { http } from "@/lib/api/http";
import { links } from "@/lib/links";
import { prevWeekday } from "@/lib/trading-date";
import { MonthCalendar, type CalMetric, type ReviewMark } from "@/components/journal/MonthCalendar";
import { DayTrades, type RuleViolation } from "@/components/journal/DayTrades";
import { DayJournalEditor } from "@/components/journal/DayJournalEditor";
import { DaySummary } from "@/components/journal/DaySummary";
import { TeamDay } from "@/components/journal/TeamDay";
import { WeekReview } from "@/components/journal/WeekReview";
import {
  type JournalEntry, hasReview, readLegacyNote, useJournalRange, useSyncLocalJournal,
} from "@/components/journal/use-journal-days";
import {
  addDays, carriedInto, computeStats, groupByDate, isIsoDate, isTypingTarget,
  isoWeekKey, localDateStr, monthBounds, monthKey, openedCountByDate, openedOn, parseDate, pickUnit, shiftMonth,
  stepWeekday, todayStr, weekStart, type DayStats,
} from "@/components/journal/utils";
import { fmtDate, fmtWeekday } from "@/lib/format";
import { journalI18n } from "@/i18n/ns/journal";
import { commonI18n } from "@/i18n/ns/common";
import { shellI18n } from "@/i18n/ns/shell";
import { comparePersonNames } from "@/i18n";
import { EodFlow } from "@/components/eod/EodFlow";
import { EodStatusBadge } from "@/components/eod/EodStatusCard";
import { EodQueuePanel } from "@/components/eod/EodQueuePanel";
import { useEodQueue, useEodRange, type EodDayMark } from "@/components/eod/eod-api";
import { PersonSelect } from "@/components/people/person-select";

const ACCOUNT_KEY = "journal:account";
const METRIC_KEY = "journal:metric";
/** Days loaded around the visible month / week: the calendar grid's spill-over days and prev / next trading day. */
const WINDOW_MARGIN_DAYS = 14;

type View = "day" | "queue";

function readLS(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeLS(key: string, v: string) {
  try { localStorage.setItem(key, v); } catch { /* ignore */ }
}

function initialFromUrl(): { date: string | null; trader: string | null; eod: boolean; view: View } {
  try {
    const p = new URLSearchParams(window.location.search);
    const d = p.get("date");
    return { date: isIsoDate(d) ? d : null, trader: p.get("trader"), eod: p.get("eod") === "1", view: p.get("view") === "queue" ? "queue" : "day" };
  } catch {
    return { date: null, trader: null, eod: false, view: "day" };
  }
}

/**
 * Дневник: the trader's daily ritual (result of the day → guided reflection → close the day) and,
 * for the curator, the review queue. Trades come in automatically; nothing here asks to enter trades.
 */
export default function JournalPage() {
  const { user, isCurator, dbUsers } = useAuth();
  const traderName = user?.traderName ?? null;
  const today = todayStr();

  const [url] = useState(initialFromUrl);
  // «Разбор по сделкам» (optional per-trade review) replaces the reflection column for the trader's own day.
  const [eodMode, setEodMode] = useState<boolean>(url.eod);
  const [view, setView] = useState<View>(isCurator ? url.view : "day");
  // Curator: "" = whole team, or a single trader. Trader: always themselves.
  const [account, setAccount] = useState<string>(() => {
    if (!isCurator) return traderName ?? "";
    if (url.trader != null) return url.trader;
    // A curator's own journal is usually empty — the team day is the useful default until they pick someone.
    return readLS(ACCOUNT_KEY) ?? (user?.role === "trader" ? traderName ?? "" : "");
  });
  const effectiveAccount = isCurator ? account : traderName ?? "";

  // Saturday / Sunday: open Friday's day (the one to review), not an empty weekend day.
  const startDate = url.date ?? ([0, 6].includes(new Date(`${today}T12:00:00Z`).getUTCDay()) ? prevWeekday(today) : today);
  const [activeDate, setActiveDate] = useState<string>(startDate);
  const [viewMonth, setViewMonth] = useState<string>(monthKey(startDate));
  const [metric, setMetricState] = useState<CalMetric>(() => {
    const m = readLS(METRIC_KEY);
    return m === "r" || m === "count" ? m : "pnl";
  });
  const setMetric = (m: CalMetric) => { setMetricState(m); writeLS(METRIC_KEY, m); };
  const [calOpen, setCalOpen] = useState(false);

  const selectDate = useCallback((d: string) => {
    setActiveDate(d);
    setViewMonth(monthKey(d));
    setView("day");
  }, []);

  const changeAccount = (v: string) => {
    setAccount(v);
    writeLS(ACCOUNT_KEY, v);
    setView("day");
  };

  // Keep the URL shareable: /journal?date=…&trader=…[&view=queue][&eod=1]
  useEffect(() => {
    try {
      const p = new URLSearchParams(window.location.search);
      p.set("date", activeDate);
      if (isCurator) p.set("trader", effectiveAccount);
      else p.delete("trader");
      if (eodMode) p.set("eod", "1"); else p.delete("eod");
      if (view === "queue") p.set("view", "queue"); else p.delete("view");
      window.history.replaceState(window.history.state, "", `${window.location.pathname}?${p.toString()}`);
    } catch { /* ignore */ }
  }, [activeDate, effectiveAccount, isCurator, eodMode, view]);

  // ── Trades ────────────────────────────────────────────────────────────────
  // Server-side window (P1-5): the visible month + active week + the adjacent days the calendar grid shows (and
  // prev / next trading day across the month edge). `from` filters by the realised day, so positions entered
  // earlier and closed (or still open) inside the window are included without a wider margin.
  const winWk = weekStart(activeDate);
  const winMb = monthBounds(viewMonth);
  const tradesFrom = addDays(winWk < winMb.from ? winWk : winMb.from, -WINDOW_MARGIN_DAYS);
  const tradesTo = addDays(addDays(winWk, 6) > winMb.to ? addDays(winWk, 6) : winMb.to, WINDOW_MARGIN_DAYS);
  const { data: trades = [], isLoading, isError, error, refetch } = useTradesWindow({
    from: tradesFrom,
    to: tradesTo,
    trader: isCurator && effectiveAccount ? effectiveAccount : null,
  });
  const bookFacets = useTradesBookFacets({ trader: isCurator && effectiveAccount ? effectiveAccount : null });

  const allTraders = useMemo(() => {
    const names = new Set<string>(dbUsers.filter((u) => u.role === "trader" || u.name === traderName).map((u) => u.name));
    for (const t of trades) if (t.trader) names.add(t.trader);
    return Array.from(names).sort(comparePersonNames);
  }, [dbUsers, traderName, trades]);

  // Days are keyed by the day the result is realised (exit day for overnight/swing), never by the entry day.
  const byDate = useMemo(() => groupByDate(trades), [trades]);
  const openedCounts = useMemo(() => openedCountByDate(trades), [trades]);
  const statsByDate = useMemo(() => {
    const m = new Map<string, DayStats>();
    for (const [d, ts] of byDate) m.set(d, computeStats(d, ts, openedCounts.get(d) ?? 0));
    return m;
  }, [byDate, openedCounts]);
  const tradeDays = useMemo(() => Array.from(byDate.keys()).sort(), [byDate]);
  const windowLatest = tradeDays.length ? tradeDays[tradeDays.length - 1] : null;
  const bookLatest = bookFacets.data?.lastDate ?? null;
  const latestTradeDay = bookLatest && (!windowLatest || bookLatest > windowLatest) ? bookLatest : windowLatest;

  const dayTrades = byDate.get(activeDate) ?? [];
  const dayStats = statsByDate.get(activeDate) ?? computeStats(activeDate, [], openedCounts.get(activeDate) ?? 0);
  const carried = useMemo(() => carriedInto(trades, activeDate, today), [trades, activeDate, today]);
  const opened = useMemo(() => openedOn(trades, activeDate), [trades, activeDate]);
  // Setup is optional for imported trades — only a soft reminder with a link to quick tagging on /trades.
  const untaggedIds = useMemo(() => dayTrades.filter((t) => !t.setup?.trim()).map((t) => t.id), [dayTrades]);

  // ── Journal entries + EOD marks (month + active week) ───────────────────────
  const wk = weekStart(activeDate);
  const mb = monthBounds(viewMonth);
  const rangeFrom = wk < mb.from ? wk : mb.from;
  const rangeTo = addDays(wk, 6) > mb.to ? addDays(wk, 6) : mb.to;
  const journal = useJournalRange(effectiveAccount, rangeFrom, rangeTo, !!user);
  const eodRange = useEodRange(effectiveAccount, rangeFrom, rangeTo, !!effectiveAccount);
  const queue = useEodQueue(isCurator);

  const monthStats = useMemo(() => {
    const inMonth: DayStats[] = [];
    for (const [d, s] of statsByDate) if (d >= mb.from && d <= mb.to) inMonth.push(s);
    return inMonth;
  }, [statsByDate, mb.from, mb.to]);
  const hasPnl = pickUnit(monthStats) === "pnl";
  const hasR = monthStats.some((s) => s.r != null);
  const effMetric: CalMetric =
    metric === "pnl" && !hasPnl ? (hasR ? "r" : "count")
    : metric === "r" && !hasR ? (hasPnl ? "pnl" : "count")
    : metric;

  const entriesByDate = useMemo(() => {
    const m = new Map<string, JournalEntry[]>();
    for (const e of journal.entries) {
      if (effectiveAccount && e.trader !== effectiveAccount) continue;
      const arr = m.get(e.date) ?? [];
      arr.push(e);
      m.set(e.date, arr);
    }
    return m;
  }, [journal.entries, effectiveAccount]);

  // One review mark per day: checked by the curator › closed › reflection written › traded without reflection.
  const marks = useMemo(() => {
    const m = new Map<string, ReviewMark>();
    const eod: Map<string, EodDayMark> = effectiveAccount ? eodRange.data ?? new Map() : new Map();
    const days = new Set<string>([...statsByDate.keys(), ...entriesByDate.keys(), ...eod.keys()]);
    for (const d of days) {
      if (d > today) continue;
      const e = eod.get(d);
      if (e?.status === "reviewed") m.set(d, "reviewed");
      else if (e?.status === "closed") m.set(d, "closed");
      else if ((entriesByDate.get(d) ?? []).some(hasReview)) m.set(d, "filled");
      else if ((statsByDate.get(d)?.trades ?? 0) > 0) m.set(d, "missing");
    }
    return m;
  }, [eodRange.data, effectiveAccount, statsByDate, entriesByDate, today]);

  const dayEntries = entriesByDate.get(activeDate) ?? [];
  const ownEntry = effectiveAccount ? dayEntries.find((e) => e.trader === effectiveAccount) ?? null : null;
  const editable = !!traderName && effectiveAccount === traderName;
  const legacyNote = editable ? readLegacyNote(effectiveAccount, activeDate) || readLegacyNote("", activeDate) : "";
  const sync = useSyncLocalJournal(editable ? effectiveAccount : "");

  // ── Rule violations for the day's trades ───────────────────────────────────
  // Only the span of the day's trades (entry … exit of the carried / multi-day ones), not the 500 newest of the book.
  const violSpan = useMemo(() => {
    const list = [...dayTrades, ...carried];
    if (!list.length) return null;
    let from = activeDate;
    let to = activeDate;
    for (const t of list) {
      const entry = String(t.date ?? "").slice(0, 10);
      const exit = String(t.exitDate ?? "").slice(0, 10);
      if (entry && entry < from) from = entry;
      if (exit && exit > to) to = exit;
      else if (!exit && entry < activeDate && today > to) to = today; // still-open carried position
    }
    return { from, to };
  }, [dayTrades, carried, activeDate, today]);
  const violationsQ = useQuery({
    queryKey: ["journal-violations", effectiveAccount, violSpan?.from ?? "", violSpan?.to ?? ""],
    enabled: !!user && !!violSpan,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }): Promise<RuleViolation[]> =>
      http
        .get<RuleViolation[]>("/api/rule-violations", {
          query: { limit: 500, trader: effectiveAccount, from: violSpan?.from, to: violSpan?.to },
          signal,
        })
        .then((rows) => (Array.isArray(rows) ? rows : []))
        .catch(() => []),
  });
  const dayViolations = useMemo(() => {
    const ids = new Set([...dayTrades, ...carried].map((t) => t.id));
    return (violationsQ.data ?? []).filter((v) => v.tradeId != null && ids.has(v.tradeId));
  }, [violationsQ.data, dayTrades, carried]);

  // ── Navigation ─────────────────────────────────────────────────────────────
  const prevTradeDay = useMemo(() => [...tradeDays].reverse().find((d) => d < activeDate) ?? null, [tradeDays, activeDate]);
  const nextTradeDay = useMemo(() => tradeDays.find((d) => d > activeDate) ?? null, [tradeDays, activeDate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (e.shiftKey) { if (prevTradeDay) selectDate(prevTradeDay); }
        else selectDate(stepWeekday(activeDate, -1));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (e.shiftKey) { if (nextTradeDay) selectDate(nextTradeDay); }
        else selectDate(stepWeekday(activeDate, 1));
      } else if ((e.key === "t" || e.key === "е" || e.key === "T" || e.key === "Е") && !e.shiftKey) { // i18n-ignore (Russian layout key)
        selectDate(today);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeDate, prevTradeDay, nextTradeDay, selectDate, today]);

  const { t } = journalI18n.useT();
  const { t: tc } = commonI18n.useT();
  const isToday = activeDate === today;
  const isFuture = activeDate > today;
  const showTeam = isCurator && !effectiveAccount;
  const showTradeReview = eodMode && editable && !isFuture;
  const pendingCount = queue.data?.items.length ?? 0;
  const overdueCount = queue.data?.items.filter((i) => i.overdue).length ?? 0;

  const jumpLatest =
    latestTradeDay && latestTradeDay !== activeDate ? (
      <Button variant="outline" size="sm" onClick={() => selectDate(latestTradeDay)}>
        <History aria-hidden="true" />{t("page.latestDay", { date: fmtDate(latestTradeDay, "dayMonth") })}
      </Button>
    ) : undefined;

  const emptyDay = (
    <p className="py-1 text-sm text-muted-foreground">
      {isFuture ? t("page.futureDay")
        : dayStats.opened ? t("page.openedPositions", { count: dayStats.opened })
        : isToday ? t("page.noTradesToday")
        : t("page.noTradesDay")}
    </p>
  );

  return (
    <Page>
      <PageHeader
        title={shellI18n.t("nav.journal")}
        icon={BookOpenCheck}
        description={view === "queue" ? t("page.descQueue") : t("page.descDay")}
        actions={
          isCurator ? (
            <div className="flex flex-wrap items-center gap-2">
              <Segmented<View>
                size="sm"
                ariaLabel={t("page.sectionAria")}
                value={view}
                onChange={setView}
                options={[
                  { value: "day", label: tc("time.day") },
                  { value: "queue", label: overdueCount ? t("page.queueOverdue", { count: overdueCount }) : t("page.queue"), count: pendingCount || undefined },
                ]}
              />
              {view === "day" && (
                <PersonSelect
                  value={effectiveAccount || ""}
                  onValueChange={(v) => changeAccount(v)}
                  options={allTraders}
                  allLabel={t("page.wholeTeam")}
                  self={traderName}
                  icon={Users}
                  ariaLabel={tc("fields.trader")}
                  className="w-full sm:w-[200px]"
                />
              )}
            </div>
          ) : null
        }
      >
        {view === "day" && (
          <Toolbar className="justify-between">
            <div className="flex min-w-0 items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("page.prevDay")}
                title={t("page.prevDayTitle")}
                onClick={() => selectDate(stepWeekday(activeDate, -1))}
              >
                <ChevronLeft />
              </Button>
              <Popover open={calOpen} onOpenChange={setCalOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="min-w-0 rounded-xl px-2 py-1 text-center transition-colors hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-w-[210px]"
                    aria-label={t("page.pickDate", { date: fmtDate(activeDate, "long") })}
                  >
                    <span className="flex items-center justify-center gap-1.5 truncate text-base font-semibold tabular-nums sm:text-lg">
                      <CalendarDays className="h-4 w-4 text-muted-foreground" aria-hidden="true" />{fmtDate(activeDate, "long")}
                    </span>
                    <span className="block text-xs capitalize text-muted-foreground">
                      {fmtWeekday(activeDate, "long")}
                      {isToday && <span className="ml-1.5 normal-case text-primary">{t("page.todaySuffix")}</span>}
                    </span>
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-2" align="start">
                  <Calendar
                    mode="single"
                    weekStartsOn={1}
                    selected={parseDate(activeDate)}
                    defaultMonth={parseDate(activeDate)}
                    onSelect={(d: Date | undefined) => {
                      if (!d) return;
                      selectDate(localDateStr(d));
                      setCalOpen(false);
                    }}
                  />
                </PopoverContent>
              </Popover>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("page.nextDay")}
                title={t("page.nextDayTitle")}
                onClick={() => selectDate(stepWeekday(activeDate, 1))}
              >
                <ChevronRight />
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {!isToday && (
                <Button variant="outline" size="sm" title={t("page.todayKey")} onClick={() => selectDate(today)}>
                  {tc("time.today")}
                </Button>
              )}
              {dayTrades.length === 0 && !isFuture && jumpLatest}
            </div>
          </Toolbar>
        )}
      </PageHeader>

      {isError && <QueryError error={error} onRetry={() => refetch()} />}

      {sync.pending.length > 0 && (
        <div className="glass-panel flex flex-wrap items-center gap-2 rounded-2xl px-4 py-2.5 text-xs" role="status">
          <CloudUpload className="h-4 w-4 text-warn" aria-hidden="true" />
          <span>
            {t("page.localPending", { count: sync.pending.length, dates: `${sync.pending.map((e) => fmtDate(e.date, "dayMonth")).slice(0, 4).join(", ")}${sync.pending.length > 4 ? "…" : ""}` })}
          </span>
          <Button size="sm" variant="outline" className="ml-auto" disabled={journal.mode === "local" || sync.flush.isPending} onClick={() => sync.flush.mutate()}>
            {sync.flush.isPending ? t("page.sending") : journal.mode === "local" ? t("page.serverDown") : t("page.sendToServer")}
          </Button>
        </div>
      )}

      {view === "queue" && isCurator ? (
        <EodQueuePanel enabled={isCurator} />
      ) : (
        <div className="grid gap-[var(--grid-gap)] xl:grid-cols-[minmax(0,1.15fr)_minmax(400px,1fr)]">
          <div className="flex min-w-0 flex-col gap-[var(--grid-gap)]">
            <DaySummary
              trader={effectiveAccount}
              date={activeDate}
              stats={dayStats}
              isLoading={isLoading}
              violations={dayViolations.length}
              untaggedIds={untaggedIds}
              status={
                effectiveAccount ? (
                  <EodStatusBadge trader={effectiveAccount} date={activeDate} today={today} canReview={isCurator && !editable} />
                ) : undefined
              }
              empty={emptyDay}
            />

            {showTradeReview ? (
              <EodFlow trader={effectiveAccount} date={activeDate} today={today} onExit={() => setEodMode(false)} />
            ) : showTeam ? (
              <TeamDay
                date={activeDate}
                today={today}
                trades={dayTrades}
                entries={dayEntries}
                isLoading={isLoading || journal.isLoading}
                onPick={changeAccount}
              />
            ) : effectiveAccount ? (
              <DayJournalEditor
                trader={effectiveAccount}
                date={activeDate}
                today={today}
                entry={ownEntry}
                editable={editable}
                mode={journal.mode}
                isLoading={journal.isLoading}
                legacyNote={legacyNote}
                hasTrades={dayTrades.length > 0}
                violations={dayViolations}
                untaggedIds={untaggedIds}
                onOpenTradeReview={editable ? () => setEodMode(true) : undefined}
              />
            ) : null}
            {journal.isError && (
              <QueryError error={journal.error} onRetry={() => journal.refetch()} message={t("page.loadFailed")} />
            )}

            {!showTradeReview && (dayTrades.length > 0 || carried.length > 0 || opened.length > 0 || isLoading) && (
              <DayTrades
                key={`${effectiveAccount}|${activeDate}`}
                trades={dayTrades}
                carried={carried}
                opened={opened}
                day={activeDate}
                isLoading={isLoading}
                violations={dayViolations}
                showTrader={!effectiveAccount}
                emptyAction={jumpLatest}
              />
            )}
          </div>

          <div className="flex min-w-0 flex-col gap-[var(--grid-gap)]">
            <MonthCalendar
              month={viewMonth}
              activeDate={activeDate}
              today={today}
              statsByDate={statsByDate}
              marks={marks}
              metric={effMetric}
              onMetricChange={setMetric}
              onSelect={selectDate}
              onMonthChange={(n) => setViewMonth((m) => shiftMonth(m, n))}
              hasPnl={hasPnl}
              hasR={hasR}
              footer={
                monthStats.length === 0 && latestTradeDay && monthKey(latestTradeDay) !== viewMonth ? (
                  <button type="button" className="text-primary hover:underline" onClick={() => selectDate(latestTradeDay)}>
                    {t("page.latestTrades", { date: fmtDate(latestTradeDay, "dayMonth") })}
                  </button>
                ) : null
              }
            />
            <WeekReview
              weekStartDate={wk}
              activeDate={activeDate}
              today={today}
              statsByDate={statsByDate}
              entriesByDate={entriesByDate}
              marks={marks}
              onSelect={selectDate}
              showJournal={!!user}
              weeklyHref={links.weeklyReview({ trader: effectiveAccount || undefined, week: isoWeekKey(wk) })}
            />
          </div>
        </div>
      )}
    </Page>
  );
}
