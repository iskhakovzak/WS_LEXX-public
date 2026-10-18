/**
 * «Топ дня» — the day view of /top-results for every member: month calendar → the day's top 10 profit / loss → one
 * trader-day (sheet) → the desk-day chart. URL: ?date=YYYY-MM-DD&alias=N (links.topDay). Without a date it opens on the
 * last finished trading day that has trades (prefill).
 */
import * as React from "react";
import { useLocation, useSearch } from "wouter";
import { Trophy } from "lucide-react";
import { Page, PageHeader } from "@/components/ds";
import { nyDate } from "@/lib/trading-date";
import { links } from "@/lib/links";
import { topDayI18n } from "@/i18n/ns/topDay";
import { useTopCalendar, useTopDay } from "./api";
import { lastFinishedDay, latestDay, monthOf, shiftMonth } from "./model";
import { TopCalendar } from "./TopCalendar";
import { TopLists } from "./TopLists";
import { TraderDaySheet } from "./TraderDaySheet";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function readParams(search: string): { date: string | null; alias: number | null } {
  const p = new URLSearchParams(search);
  const date = p.get("date");
  const alias = Number(p.get("alias"));
  return { date: date && YMD.test(date) ? date : null, alias: Number.isInteger(alias) && alias > 0 ? alias : null };
}

export function TopDayView({ tabs, staff }: { tabs?: React.ReactNode; staff: boolean }) {
  const { t } = topDayI18n.useT();
  const search = useSearch();
  const [, setLocation] = useLocation();
  const { date: urlDate, alias } = React.useMemo(() => readParams(search), [search]);
  const today = nyDate();
  const fallback = React.useMemo(() => lastFinishedDay(), []);
  const [month, setMonth] = React.useState(() => monthOf(urlDate ?? fallback));
  const [steppedBack, setSteppedBack] = React.useState(false);

  const cal = useTopCalendar(month);
  // Prefill: no date in the URL → the latest traded day of the shown month not after the last finished day.
  const autoDate = React.useMemo(() => (cal.data && cal.data.month === month ? latestDay(cal.data.days, fallback) : null), [cal.data, month, fallback]);
  const date = urlDate ?? autoDate;
  React.useEffect(() => {
    // First visit early in a month with no trades yet: show the previous month once.
    if (!urlDate && !steppedBack && cal.data && cal.data.month === month && !autoDate && month === monthOf(fallback)) {
      setSteppedBack(true);
      setMonth(shiftMonth(month, -1));
    }
  }, [urlDate, steppedBack, cal.data, month, autoDate, fallback]);
  React.useEffect(() => { if (urlDate) setMonth(monthOf(urlDate)); }, [urlDate]);

  const day = useTopDay(date);
  const go = React.useCallback((d: string | undefined, a?: number) => setLocation(links.topDay(d, a), { replace: true }), [setLocation]);
  const mode = day.data?.mode ?? cal.data?.mode;

  return (
    <Page>
      <PageHeader
        title={t("title")}
        icon={Trophy}
        description={t("desc")}
        meta={mode === "anonymous" ? t("privacy.anonymous") : mode === "named" ? t("privacy.named") : undefined}
      >
        {tabs}
      </PageHeader>
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] lg:gap-5">
        <div className="lg:sticky lg:top-4">
          <TopCalendar
            month={month}
            data={cal.data && cal.data.month === month ? cal.data : undefined}
            loading={cal.isLoading || (!!cal.data && cal.data.month !== month)}
            selected={date}
            today={today}
            canNext={month < monthOf(today)}
            onSelect={(d) => go(d)}
            onMonth={(delta) => setMonth((m) => shiftMonth(m, delta))}
          />
        </div>
        <TopLists date={date} q={day} onOpen={(a) => date && go(date, a)} />
      </div>
      <TraderDaySheet date={date} alias={date ? alias : null} staff={staff} onClose={() => go(date ?? undefined)} />
    </Page>
  );
}
