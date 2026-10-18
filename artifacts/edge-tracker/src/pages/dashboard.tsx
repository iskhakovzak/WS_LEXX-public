// Dashboard = the trader's command screen. Top to bottom: header (NY session, today / week net, risk limit + the day
// line: focus / own contract / evening card / tier progress — the one focal point) →
// «Что важно сейчас» + week/month equity → recent trades + desk (staff) or streaks → opt-in extras
// (check-in, brief, sectors, macro, DNA, quote, psychology — off by default, switched on in «Настроить»).
// Each block answers one question; trades arrive automatically, so there are no entry CTAs here.
import { useCallback, type ReactNode } from "react";
import { Page } from "@/components/ds";
import { useAuth } from "@/contexts/auth-context";
import { nyDate } from "@/lib/trading-date";
import { useTodayHolidays } from "@/lib/market-intel";
import { normalizeResult } from "@/lib/trade-result";
import { useUnreadCount } from "@/components/notifications/use-notifications";
import { SectorRadar } from "@/components/sector-radar";
import { MarketDnaWidget } from "@/components/market-dna-widget";
import { UpcomingEventsList } from "@/components/holiday-badge";
import { MarketOpenBrief } from "@/components/market-open-brief";
import { MorningCheckin } from "@/components/morning-checkin";
import { WeeklyPsychologyReport } from "@/components/weekly-psychology-report";
import { DailyQuoteCard } from "@/components/daily-quote-card";
import { DashboardHeader } from "@/components/dashboard/today-hero";
import { AttentionPanel } from "@/components/dashboard/attention-panel";
import { PositionsPanel } from "@/components/dashboard/positions-panel";
import { EquityPanel } from "@/components/dashboard/equity-panel";
import { StreaksPanel } from "@/components/dashboard/streaks-panel";
import { RecentTradesPanel } from "@/components/dashboard/recent-trades-panel";
import { DeskTodayPanel } from "@/components/dashboard/team-heat-strip";
import { CustomizePopover } from "@/components/dashboard/customize-popover";
import { DayLine } from "@/components/daily/day-line";
import { dayView } from "@/components/daily/daily-model";
import { useDailyMe } from "@/components/daily/use-daily";
import { dashboardI18n } from "@/i18n/ns/dashboard";
import {
  SECTION_WIDTH,
  useDashboardEquity,
  useDashboardPrefs,
  useDashboardToday,
  useEodDay,
  useEodStatus,
  useEventsToday,
  useRecentTrades,
  useRiskDesk,
  useRiskMe,
  type SectionId,
} from "@/components/dashboard/use-dashboard";

const RITUAL_ANCHOR = "dash-ritual";
const CLOSE_MIN = 16 * 60;

const SPAN: Record<number, string> = {
  5: "lg:col-span-5",
  6: "lg:col-span-6",
  7: "lg:col-span-7",
  12: "lg:col-span-12",
};

type Block = { id: SectionId; node: ReactNode };

/** Group visible blocks into bento rows: two neighbouring half-blocks share a row (7/5, 5/7 or 6/6), full blocks take one. */
function toRows(blocks: Block[]): { key: string; cells: { block: Block; span: number }[] }[] {
  const rows: { key: string; cells: { block: Block; span: number }[] }[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const a = blocks[i];
    const b = blocks[i + 1];
    const wa = SECTION_WIDTH[a.id];
    const wb = b ? SECTION_WIDTH[b.id] : "full";
    if (wa !== "full" && b && wb !== "full") {
      const spanA = wa === wb ? 6 : wa === "wide" ? 7 : 5;
      rows.push({ key: `${a.id}+${b.id}`, cells: [{ block: a, span: spanA }, { block: b, span: 12 - spanA }] });
      i++;
    } else {
      rows.push({ key: a.id, cells: [{ block: a, span: 12 }] });
    }
  }
  return rows;
}

export default function Dashboard() {
  const { user, isCurator } = useAuth();
  const isGuest = !user || user.role === "guest";
  const userName = user?.traderName ?? null;
  const staff = isCurator;
  const authed = !isGuest;

  const { prefs, update, reset } = useDashboardPrefs(staff ? "team" : "me", user ? `${user.role}:${userName ?? ""}` : null);
  // Team scope is for staff only; a trader always sees their own desk.
  const scope = staff ? prefs.scope : "me";
  const on = (id: SectionId) => authed && !prefs.hidden.includes(id);

  const todayQ = useDashboardToday(scope, authed);
  const equityQ = useDashboardEquity(scope, prefs.period, on("equity"));
  const recentQ = useRecentTrades(scope, authed);
  const riskQ = useRiskMe(authed && !!userName);
  const deskQ = useRiskDesk(authed && staff);
  const eodQ = useEodStatus(authed && scope === "team");
  const eventsQ = useEventsToday(on("attention"));
  const holidaysQ = useTodayHolidays();
  const unreadQ = useUnreadCount();

  const today = todayQ.data;
  const tradingDate = today?.date ?? nyDate();
  const afterClose = today ? today.market.nyMinutes >= CLOSE_MIN || today.market.weekend : false;

  // The most recent own trading day that can be closed: before today, or today once the session is over.
  const lastDay =
    scope === "me"
      ? ((recentQ.data ?? [])
          .filter((t) => normalizeResult(t.result) != null)
          .map((t) => t.closeDate.slice(0, 10))
          .find((d) => d < tradingDate || (d === tradingDate && afterClose)) ?? null)
      : null;
  const lastDayEodQ = useEodDay(lastDay, userName, authed && scope === "me" && on("attention"));
  // The day line (header) owns the last finished day's review; the journal stays its next step while still open.
  const dailyOn = authed && scope === "me";
  const dailyQ = useDailyMe(dailyOn);
  const dayCardDate = dayView(dailyQ.data)?.evening?.date ?? null;
  const lastDayRow = lastDayEodQ.data?.traders.find((x) => x.trader === userName);
  const journalOpenDate = lastDay && lastDayRow?.status === "open" && lastDayRow.trades > 0 ? lastDay : null;
  // «Что важно сейчас» counts tasks from all of these: render it once they have answered (no 2 → 3 jump).
  const attentionLoading = todayQ.isLoading || recentQ.isLoading || riskQ.isLoading || deskQ.isLoading || eodQ.isLoading
    || eventsQ.isLoading || holidaysQ.isLoading || unreadQ.isLoading || lastDayEodQ.isLoading;

  const goToCheckin = useCallback(() => {
    if (prefs.hidden.includes("checkin")) update({ hidden: prefs.hidden.filter((h) => h !== "checkin") });
    window.setTimeout(() => {
      const el = document.getElementById(RITUAL_ANCHOR);
      if (!el) return;
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
      el.focus({ preventScroll: true });
    }, 50);
  }, [prefs.hidden, update]);

  const render = (id: SectionId): ReactNode => {
    switch (id) {
      case "attention":
        return (
          <AttentionPanel
            fill
            data={today}
            risk={riskQ.data}
            desk={deskQ.data}
            eod={eodQ.data}
            lastDay={lastDay}
            lastDayEod={lastDayEodQ.data}
            recent={scope === "me" ? recentQ.data : undefined}
            events={eventsQ.data}
            marketEvents={holidaysQ.data?.today ?? []}
            unread={unreadQ.data}
            isLoading={attentionLoading}
            updatedAt={todayQ.dataUpdatedAt || undefined}
            onCheckin={goToCheckin}
            dayCardDate={dayCardDate}
          />
        );
      case "equity":
        return (
          <EquityPanel
            fill
            data={equityQ.data}
            isLoading={equityQ.isLoading}
            isError={equityQ.isError}
            onRetry={() => equityQ.refetch()}
            period={prefs.period}
            onPeriodChange={(period) => update({ period })}
            metric={prefs.metric}
            onMetricChange={(metric) => update({ metric })}
          />
        );
      case "recent":
        return (
          <RecentTradesPanel
            fill
            trades={recentQ.data}
            isLoading={recentQ.isLoading}
            isError={recentQ.isError}
            onRetry={() => recentQ.refetch()}
            showTrader={scope === "team"}
          />
        );
      case "desk":
        // Staff only; hidden when the risk desk is not deployed (null).
        return staff && deskQ.data !== null ? <DeskTodayPanel fill data={deskQ.data} isLoading={deskQ.isLoading} /> : null;
      case "streaks":
        return <StreaksPanel fill data={today} isLoading={todayQ.isLoading} />;
      case "positions":
        return today?.positions && today.positions.length > 0 ? <PositionsPanel data={today} /> : null;
      case "checkin":
        return (
          <section id={RITUAL_ANCHOR} tabIndex={-1} aria-label={dashboardI18n.t("sections.checkin.label")} className="scroll-mt-24 outline-none">
            <MorningCheckin />
          </section>
        );
      case "brief":
        return <MarketOpenBrief />;
      case "quote":
        return <DailyQuoteCard />;
      case "sectors":
        return <SectorRadar />;
      case "macro":
        return <UpcomingEventsList />;
      case "dna":
        return <MarketDnaWidget />;
      case "psychology":
        return <WeeklyPsychologyReport />;
    }
  };

  const blocks: Block[] = prefs.order
    .filter((id) => on(id) && (id !== "desk" || staff))
    .map((id) => ({ id, node: render(id) }))
    .filter((b) => b.node != null);
  const rows = toRows(blocks);

  return (
    <Page>
      <DashboardHeader
        data={today}
        risk={riskQ.data}
        desk={deskQ.data}
        isLoading={todayQ.isLoading}
        isError={todayQ.isError}
        onRetry={() => todayQ.refetch()}
        guest={isGuest}
        scope={scope}
        onScopeChange={(s) => update({ scope: s })}
        canChooseScope={staff}
        userName={userName}
        dayLine={<DayLine enabled={dailyOn} journalOpenDate={journalOpenDate} />}
        customize={
          authed ? <CustomizePopover staff={staff} order={prefs.order} hidden={prefs.hidden} onChange={(patch) => update(patch)} onReset={reset} /> : null
        }
      />
      {rows.map((row) =>
        row.cells.length === 1 ? (
          <div key={row.key} className="min-w-0">
            {row.cells[0].block.node}
          </div>
        ) : (
          <div key={row.key} className="grid grid-cols-1 items-stretch gap-[var(--grid-gap)] lg:grid-cols-12">
            {row.cells.map((c) => (
              <div key={c.block.id} className={`min-w-0 ${SPAN[c.span]}`}>
                {c.block.node}
              </div>
            ))}
          </div>
        ),
      )}
    </Page>
  );
}
