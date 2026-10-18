/**
 * «Топ» — one place in the nav (Команда → Рейтинги → Топ). Every member gets the day view («Топ дня»: calendar, top 10
 * profit / loss, a trader-day, the desk-day chart; names hidden from traders — components/top-day). Staff also get the
 * period leaderboard (components/team/period-top) as a second tab: ?view=period.
 */
import { useLocation, useSearch } from "wouter";
import { CalendarDays, Trophy } from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { SectionTabs } from "@/components/ds";
import { PeriodTop } from "@/components/team/period-top";
import { TopDayView } from "@/components/top-day/TopDayView";
import { topDayI18n } from "@/i18n/ns/topDay";

type TopView = "day" | "period";

export default function TopResultsPage() {
  const { isCurator } = useAuth();
  const { t } = topDayI18n.useT();
  const search = useSearch();
  const [, setLocation] = useLocation();
  const view: TopView = isCurator && new URLSearchParams(search).get("view") === "period" ? "period" : "day";
  const setView = (v: TopView) => setLocation(v === "period" ? "/top-results?view=period" : "/top-results", { replace: true });
  const tabs = isCurator ? (
    <SectionTabs<TopView>
      ariaLabel={t("tabs.aria")}
      value={view}
      onChange={setView}
      tabs={[
        { value: "day", label: t("tabs.day"), icon: CalendarDays },
        { value: "period", label: t("tabs.period"), icon: Trophy },
      ]}
    />
  ) : undefined;
  return view === "period" ? <PeriodTop tabs={tabs} /> : <TopDayView tabs={tabs} staff={isCurator} />;
}
