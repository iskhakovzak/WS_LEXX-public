import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, ChevronLeft, ChevronRight, Compass, FileText, Pencil, Plus, ShieldAlert, Users } from "lucide-react";
import { EmptyState, Page, PageHeader, Panel, Pill, Segmented } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { QueryError } from "@/components/query-error";
import { useAuth } from "@/contexts/auth-context";
import { http } from "@/lib/api/http";
import { POLL, STALE } from "@/lib/api/keys";
import { InPlayCard, MacroStrip, PlanHero, longDate, shortDay, type DayEvent } from "@/components/game-plan/plan-briefing";
import { MyPlan } from "@/components/game-plan/my-plan";
import { TraderPlans } from "@/components/game-plan/trader-plans";
import { MarkReadButton, ReadStatusPanel } from "@/components/game-plan/read-status";
import { HistoryPanel } from "@/components/game-plan/history-panel";
import { PlanEditorSheet } from "@/components/game-plan/plan-editor-sheet";
import { HORIZON, dateObj, gpApi, gpKeys, isIsoDate, nyToday, shiftTradingDay, type Horizon } from "@/components/game-plan/types";
import { fmtDate, fmtRelative, fmtUsd } from "@/lib/format";
import { gpI18n } from "@/i18n/ns/gamePlan";
import { shellI18n } from "@/i18n/ns/shell";
import { commonI18n } from "@/i18n/ns/common";

type HorizonFilter = "all" | Horizon;
type View = "desk" | "my" | "traders";

function readUrlView(): View | null {
  try {
    const v = new URLSearchParams(window.location.search).get("view");
    return v === "my" || v === "traders" || v === "desk" ? v : null;
  } catch {
    return null;
  }
}

function readUrlDate(): string | null {
  try {
    const d = new URLSearchParams(window.location.search).get("date");
    return isIsoDate(d) ? d : null;
  } catch {
    return null;
  }
}

function isTypingTarget(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || !!el.closest("[role=dialog]");
}

/** "updated N min ago" in the UI language — re-renders every 15s. */
function useAgo(ts: number) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 15_000);
    return () => window.clearInterval(id);
  }, []);
  if (!ts) return "";
  return gpI18n.t("page.updatedAgo", { ago: fmtRelative(ts) });
}

export default function GamePlanPage() {
  const { t } = gpI18n.useT();
  const { isCurator, user, can } = useAuth();
  const isTrader = !!user && user.role !== "guest" && !isCurator;
  const me = user && user.role !== "guest" ? user.traderName : null;
  const canMine = !!me && can("journal.write.own", { trader: me });
  const canTeam = can("journal.read.team");
  const [viewRaw, setView] = useState<View>(() => readUrlView() ?? "desk");
  const view: View = viewRaw === "my" && !canMine ? "desk" : viewRaw === "traders" && !canTeam ? "desk" : viewRaw;
  // On Saturday / Sunday the plan that matters is Monday's: open the next session instead of an empty weekend day.
  const calToday = nyToday();
  const today = [0, 6].includes(new Date(`${calToday}T12:00:00Z`).getUTCDay()) ? shiftTradingDay(calToday, 1) : calToday;
  const sessionAhead = today !== calToday;
  const [date, setDate] = useState<string>(() => readUrlDate() ?? today);
  const [editorOpen, setEditorOpen] = useState(false);
  const [calOpen, setCalOpen] = useState(false);
  const [hz, setHz] = useState<HorizonFilter>("all");
  const searchRef = useRef<HTMLInputElement>(null);

  // Keep ?date= in the URL for sharing (today ⇒ clean URL).
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (date === today) url.searchParams.delete("date");
      else url.searchParams.set("date", date);
      if (view === "desk") url.searchParams.delete("view");
      else url.searchParams.set("view", view);
      window.history.replaceState(window.history.state, "", url.toString());
    } catch {
      /* ignore */
    }
  }, [date, today, view]);

  const dayQ = useQuery({
    queryKey: gpKeys.day(date),
    queryFn: () => gpApi.day(date),
    // Traders keep the page open before the bell — pick up the plan as soon as it's published.
    refetchInterval: date === today ? POLL.minute : false,
  });
  const eventsQ = useQuery({
    queryKey: ["game-plan", "events", date],
    queryFn: ({ signal }): Promise<DayEvent[]> =>
      http
        .get<DayEvent[]>("/api/events", { query: { from: date, to: date }, signal })
        .then((rows) => (Array.isArray(rows) ? rows.slice(0, 12) : []))
        .catch(() => []),
    staleTime: STALE.long,
  });

  const data = dayQ.data;
  const plan = data?.plan ?? null;
  const ago = useAgo(dayQ.dataUpdatedAt);

  const go = useCallback((d: string) => {
    setDate(d);
    setHz("all");
  }, []);

  // Keyboard: ←/→ trading days, T today, E edit (curator), / search history.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (editorOpen || isTypingTarget(e.target)) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(shiftTradingDay(date, -1));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        go(shiftTradingDay(date, 1));
      } else if (e.key === "t" || e.key === "T" || e.key === "е" || e.key === "Е") { // i18n-ignore (RU keyboard layout)
        go(today);
      } else if ((e.key === "e" || e.key === "E" || e.key === "у" || e.key === "У") && isCurator && view === "desk") { // i18n-ignore (RU keyboard layout)
        e.preventDefault();
        setEditorOpen(true);
      } else if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [date, today, editorOpen, isCurator, go, view]);

  const counts = useMemo(() => {
    const c: Record<HorizonFilter, number> = { all: 0, intraday: 0, overnight: 0, swing: 0 };
    for (const i of plan?.inPlay ?? []) {
      c.all++;
      c[i.horizon ?? "intraday"]++;
    }
    return c;
  }, [plan]);
  const visible = useMemo(
    () => (plan?.inPlay ?? []).filter((i) => hz === "all" || (i.horizon ?? "intraday") === hz),
    [plan, hz],
  );

  const isToday = date === today;
  const shortDate = shortDay(date);

  return (
    <Page>
      <PageHeader
        title={shellI18n.t("nav.gamePlan")}
        icon={Compass}
        description={t("page.description", { ago: ago || t("page.timeEt") })}
        actions={
          <>
            <nav aria-label={t("page.dayNav")} className="glass-field inline-flex items-center gap-0.5 p-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                title={t("page.prevDayKey")}
                aria-label={t("page.prevDay")}
                onClick={() => go(shiftTradingDay(date, -1))}
              >
                <ChevronLeft aria-hidden="true" />
              </Button>
              <Popover open={calOpen} onOpenChange={setCalOpen}>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="sm" className="min-w-[132px] tabular-nums" aria-label={t("page.pickDate", { date: longDate(date) })}>
                    <CalendarDays aria-hidden="true" />
                    {shortDate}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-2" align="center">
                  <Calendar
                    mode="single"
                    selected={dateObj(date)}
                    defaultMonth={dateObj(date)}
                    weekStartsOn={1}
                    onSelect={(d: Date | undefined) => {
                      if (!d) return;
                      go(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
                      setCalOpen(false);
                    }}
                  />
                </PopoverContent>
              </Popover>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                title={t("page.nextDayKey")}
                aria-label={t("page.nextDay")}
                onClick={() => go(shiftTradingDay(date, 1))}
              >
                <ChevronRight aria-hidden="true" />
              </Button>
            </nav>
            {!isToday && (
              <Button variant="outline" size="sm" onClick={() => go(today)} title={sessionAhead ? t("page.nextSessionKey") : t("page.todayKey")}>
                {sessionAhead ? t("page.nextSession") : commonI18n.t("time.today")}
              </Button>
            )}
            {isCurator && view === "desk" && plan && (
              <Button className="bg-primary-solid" onClick={() => setEditorOpen(true)} title={t("page.editDeskKey")}>
                <Pencil aria-hidden="true" />
                {t("page.edit")}
              </Button>
            )}
          </>
        }
      >
        {(canMine || canTeam) && (
          <Segmented<View>
            ariaLabel={t("page.viewAria")}
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: "desk", label: t("page.views.desk") },
              ...(canMine ? [{ value: "my" as View, label: t("page.views.my") }] : []),
              ...(canTeam ? [{ value: "traders" as View, label: t("page.views.traders") }] : []),
            ]}
          />
        )}
      </PageHeader>

      {view === "my" ? (
        <MyPlan date={date} deskPlan={plan} />
      ) : view === "traders" ? (
        <TraderPlans date={date} />
      ) : (
      <div className="grid gap-[var(--grid-gap)] lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-[var(--grid-gap)]">
          {dayQ.isLoading ? (
            <BriefingSkeleton />
          ) : dayQ.isError ? (
            <QueryError error={dayQ.error} onRetry={() => dayQ.refetch()} message={dayQ.error instanceof Error ? dayQ.error.message : undefined} />
          ) : !plan ? (
            <Panel>
              <EmptyState
                icon={FileText}
                title={isToday ? (sessionAhead ? t("page.notPublishedOn", { date: fmtDate(dateObj(date), "weekdayDayMonthLong") }) : t("page.notPublishedToday")) : date > today ? t("page.notPublishedOn", { date: fmtDate(dateObj(date), "dayMonthLong") }) : t("page.neverPublished", { date: fmtDate(dateObj(date), "dayMonthLong") })}
                description={
                  isCurator
                    ? t("page.emptyCurator")
                    : isToday
                      ? t("page.emptyToday")
                      : t("page.emptyOther")
                }
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    {isCurator && (
                      <Button className="bg-primary-solid" onClick={() => setEditorOpen(true)}>
                        <Plus aria-hidden="true" />
                        {t("page.createPlan")}
                      </Button>
                    )}
                    {!isCurator && canMine && (
                      <Button className="bg-primary-solid" onClick={() => setView("my")}>
                        <Plus aria-hidden="true" />
                        {t("page.writeMine")}
                      </Button>
                    )}
                    {data?.prevDate && (
                      <Button variant="outline" onClick={() => go(data.prevDate!)}>
                        {t("page.lastPlan", { date: shortDay(data.prevDate) })}
                      </Button>
                    )}
                  </div>
                }
              />
            </Panel>
          ) : (
            <>
              <PlanHero
                plan={plan}
                readSlot={
                  isTrader ? (
                    <MarkReadButton plan={plan} myReadAt={data?.myReadAt ?? null} date={date} primary />
                  ) : isCurator ? (
                    <Pill tone="neutral" className="px-3 py-1 text-sm">
                      <Users className="h-3.5 w-3.5" aria-hidden="true" />
                      {t("page.readCount", { count: plan.readCount })}
                    </Pill>
                  ) : null
                }
              />

              <MacroStrip macro={plan.macro ?? []} events={eventsQ.data ?? []} />

              <section aria-labelledby="gp-inplay" className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 id="gp-inplay" className="text-base font-semibold">
                    {t("page.inPlay")} <span className="tabular-nums text-muted-foreground">{counts.all}</span>
                  </h2>
                  {counts.all > 0 && (
                    <Segmented<HorizonFilter>
                      ariaLabel={t("page.hzFilter")}
                      size="sm"
                      value={hz}
                      onChange={setHz}
                      options={[
                        { value: "all", label: t("page.all"), count: counts.all },
                        ...(Object.keys(HORIZON) as Horizon[]).map((k) => ({
                          value: k,
                          label: HORIZON[k].label,
                          count: counts[k],
                          disabled: counts[k] === 0,
                        })),
                      ]}
                    />
                  )}
                </div>
                {counts.all === 0 ? (
                  <Panel>
                    <p className="text-sm text-muted-foreground">{t("page.noTickers")}</p>
                  </Panel>
                ) : (
                  <div className="grid gap-[var(--grid-gap)] md:grid-cols-2 2xl:grid-cols-3">
                    {visible.map((i, idx) => (
                      <InPlayCard key={`${i.ticker}-${idx}`} item={i} index={idx} />
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </div>

        <aside className="flex min-w-0 flex-col gap-[var(--grid-gap)]" aria-label={t("page.asideAria")}>
          {plan && (plan.riskNotes || plan.maxLossUsd != null || plan.maxTrades != null) && (
            <Panel title={t("doc.risk")} icon={ShieldAlert} className="ring-1 ring-[hsl(var(--chart-3)/0.35)]">
              {(plan.maxLossUsd != null || plan.maxTrades != null) && (
                <dl className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  {plan.maxLossUsd != null && (
                    <div className="flex gap-1.5">
                      <dt className="text-muted-foreground">{t("doc.maxLoss")}</dt>
                      <dd className="font-semibold tabular-nums">{fmtUsd(plan.maxLossUsd, { decimals: 0 })}</dd>
                    </div>
                  )}
                  {plan.maxTrades != null && (
                    <div className="flex gap-1.5">
                      <dt className="text-muted-foreground">{t("doc.maxTrades")}</dt>
                      <dd className="font-semibold tabular-nums">{plan.maxTrades}</dd>
                    </div>
                  )}
                </dl>
              )}
              {plan.riskNotes && <p className="whitespace-pre-wrap text-sm leading-relaxed">{plan.riskNotes}</p>}
            </Panel>
          )}
          {plan && isCurator && <ReadStatusPanel planId={plan.id} />}
          <HistoryPanel current={date} onPick={go} searchRef={searchRef} />
        </aside>
      </div>
      )}

      {isCurator && (
        <PlanEditorSheet
          open={editorOpen}
          onOpenChange={setEditorOpen}
          date={date}
          plan={plan}
          prevDate={data?.prevDate ?? null}
        />
      )}
    </Page>
  );
}

function BriefingSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label={gpI18n.t("page.loadingPlan")}>
      <div className="glass-panel flex flex-col gap-4 rounded-2xl p-5">
        <Skeleton className="h-4 w-28 rounded-full" />
        <Skeleton className="h-6 w-64 rounded-full" />
        <div className="flex gap-2">
          <Skeleton className="h-7 w-28 rounded-full" />
          <Skeleton className="h-7 w-36 rounded-full" />
        </div>
        <Skeleton className="h-16 w-full rounded-xl" />
        <div className="grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-56 rounded-2xl" />
        ))}
      </div>
    </div>
  );
}
