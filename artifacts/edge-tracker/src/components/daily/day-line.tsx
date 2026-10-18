import { useState } from "react";
import { ChevronDown, ClipboardCheck } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import type { DailyMe } from "@/lib/daily/types";
import { dailyI18n } from "@/i18n/ns/daily";
import { contractLine, dayView, type PlanContract } from "./daily-model";
import { ContractLine } from "./contract-line";
import { EveningCard } from "./evening-card";
import { FocusLine, dayShort } from "./focus-line";
import { TierProgressChip } from "./tier-progress";
import { useDailyMe, useTodayContract } from "./use-daily";

/** Morning row for a finished day that is still not reviewed: one line, the card opens in place. */
function PendingRow({ date, onOpen }: { date: string; onOpen: () => void }) {
  const { t } = dailyI18n.useT();
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span className="inline-flex items-center gap-2 text-muted-foreground">
        <ClipboardCheck className="h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
        {t("evening.pending", { date: dayShort(date) })}
      </span>
      <button
        type="button"
        onClick={onOpen}
        aria-expanded={false}
        className="inline-flex min-h-7 items-center gap-1 rounded-lg px-2 text-xs font-medium text-primary hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t("evening.open")}
        <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * The day line under the dashboard header: ONE thing per touch. Before / during the session — the focus, today's own
 * contract and tier progress; after the close — the evening card of the finished day, which closes to one line once
 * reviewed. Presentational: data comes in (DayLine fetches it), so tests render every state from fixtures.
 */
export function DayLineView({
  me,
  plan,
  journalOpenDate,
}: {
  me: DailyMe;
  plan: PlanContract | null | undefined;
  /** The journal day the viewer still has to close (dashboard EOD status), if any. */
  journalOpenDate?: string | null;
}) {
  const { t } = dailyI18n.useT();
  const [openPending, setOpenPending] = useState(false);
  const view = dayView(me);
  const tier = <TierProgressChip progress={me.progress} />;
  if (!view) {
    return me.progress ? <div className="mt-4 border-t border-[var(--glass-border)] pt-3">{tier}</div> : null;
  }
  const card = view.evening;
  const journalOpen = !!card && journalOpenDate === card.date;
  if (view.primary === "evening" && card) {
    return (
      <section aria-label={t("aria")} className="mt-4 flex flex-col gap-3 border-t border-[var(--glass-border)] pt-4">
        <EveningCard card={card} nextFocus={me.focus} journalOpen={journalOpen} />
        {tier}
      </section>
    );
  }
  const line = contractLine(plan, view.focus);
  return (
    <section aria-label={t("aria")} className="mt-4 flex flex-col gap-3 border-t border-[var(--glass-border)] pt-4">
      {view.pendingEvening && card && (openPending ? (
        <div className="border-b border-[var(--glass-border)] pb-3">
          <EveningCard card={card} nextFocus={me.focus} journalOpen={journalOpen} onHide={() => setOpenPending(false)} />
        </div>
      ) : (
        <PendingRow date={card.date} onOpen={() => setOpenPending(true)} />
      ))}
      <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start lg:gap-6">
        <div className="flex min-w-0 flex-col gap-2.5">
          {view.focus && <FocusLine focus={view.focus} />}
          <ContractLine line={line} date={me.today} intraday={me.intraday} yesterday={view.pendingEvening ? null : card?.contract} />
        </div>
        {tier}
      </div>
    </section>
  );
}

/** Dashboard slot: loads the trader's daily loop and today's plan; renders nothing for a role without one. */
export function DayLine({ enabled, journalOpenDate }: { enabled: boolean; journalOpenDate?: string | null }) {
  const meQ = useDailyMe(enabled);
  const me = meQ.data ?? null;
  const planQ = useTodayContract(me?.today ?? null, enabled && !!me);
  if (!enabled) return null;
  if (meQ.isLoading) {
    return (
      <div className="mt-4 flex items-center gap-3 border-t border-[var(--glass-border)] pt-4" aria-hidden="true">
        <Skeleton className="h-9 w-9 rounded-xl" />
        <div className="flex flex-1 flex-col gap-1.5">
          <Skeleton className="h-3 w-24 rounded" />
          <Skeleton className="h-4 w-2/3 max-w-md rounded" />
        </div>
      </div>
    );
  }
  if (!me) return null;
  return <DayLineView me={me} plan={planQ.data} journalOpenDate={journalOpenDate} />;
}
