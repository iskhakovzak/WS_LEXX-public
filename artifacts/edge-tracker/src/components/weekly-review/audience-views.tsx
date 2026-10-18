/**
 * The two per-trader audiences of «Отчёт недели» (same document, different emphasis):
 *  · TraderView  — results vs 4 weeks, three $-tips, what went well, the goal for next week, days.
 *  · CuratorView — the same numbers plus the rules checklist, desk median, days without review,
 *                  risk events and the curator's feedback + grade (existing collab flow, E1 notifications).
 */
import * as React from "react";
import { CalendarX2 } from "lucide-react";
import { BentoGrid, EmptyState, Panel, Pill } from "@/components/ds";
import type { Tip } from "@/lib/weeklyInsights";
import type { WeeklyReview } from "./api";
import { CuratorReviewPanel, PrevGoalsPanel, SelfReviewPanel } from "./collab";
import {
  ChecklistPanel, DayStrip, DeskComparePanel, GoalPanel, JournalRiskPanel, PositivesPanel, TipsPanel, WeekKpiStrip, weekHeadline,
} from "./insight-panels";
import { BestWorstPanel, HorizonPanel, MistakesPanel, OpenBookPanel, SetupPanel } from "./sections";
import { useWeekInsights } from "./use-week-insights";
import { weeklyI18n } from "@/i18n/ns/weeklyReview";

/** Setup / horizon / weekend-book panels only when they carry information. */
function OptionalBreakdowns({ doc }: { doc: WeeklyReview }) {
  const setups = doc.bySetup.some((g) => g.key !== "—");
  const horizons = doc.byHorizon.length > 1;
  const book = doc.openPositions.length > 0;
  const panels = [
    setups && <SetupPanel key="setup" doc={doc} />,
    horizons && <HorizonPanel key="horizon" doc={doc} />,
    book && <OpenBookPanel key="book" doc={doc} />,
  ].filter(Boolean);
  if (!panels.length) return null;
  return <div className="grid gap-[var(--grid-gap)] xl:grid-cols-2">{panels}</div>;
}

function NoTradesWeek({ doc }: { doc: WeeklyReview }) {
  const { t } = weeklyI18n.useT();
  return (
    <Panel>
      <EmptyState
        icon={CalendarX2}
        title={t("audience.noTradesTitle")}
        description={doc.week.isCurrent ? t("audience.noTradesCurrent") : t("audience.noTradesPast")}
      />
    </Panel>
  );
}

// ── Трейдеру ─────────────────────────────────────────────────────────────────
export function TraderView({ doc }: { doc: WeeklyReview }) {
  const { t: tr } = weeklyI18n.useT();
  const ins = useWeekInsights(doc);
  const [inject, setInject] = React.useState<{ text: string; n: number } | null>(null);
  const makeGoal = doc.viewer.isOwner ? (t: Tip) => setInject((p) => ({ text: t.action, n: (p?.n ?? 0) + 1 })) : undefined;
  const k = doc.kpis.current;

  if (k.trades === 0) {
    return (
      <div className="flex flex-col gap-[var(--grid-gap)]">
        <NoTradesWeek doc={doc} />
        <div className="grid gap-[var(--grid-gap)] xl:grid-cols-2">
          <GoalPanel doc={doc} />
          <PrevGoalsPanel doc={doc} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[var(--grid-gap)]">
      <p className="text-sm text-muted-foreground">{weekHeadline(doc)}</p>
      <WeekKpiStrip doc={doc} ins={ins} />
      <BentoGrid>
        <TipsPanel tips={ins.tips} loading={ins.tipsLoading} onMakeGoal={makeGoal} className="lg:col-span-7" />
        <div className="flex min-w-0 flex-col gap-[var(--grid-gap)] lg:col-span-5">
          <PositivesPanel items={ins.positives} />
          <GoalPanel doc={doc} inject={inject} className="flex-1" />
        </div>
      </BentoGrid>
      <DayStrip doc={doc} ins={ins} />
      <BestWorstPanel doc={doc} />
      <OptionalBreakdowns doc={doc} />
      <section aria-label={tr("audience.withCurator")} className="flex flex-col gap-[var(--grid-gap)]">
        <div className="grid gap-[var(--grid-gap)] xl:grid-cols-2">
          <CuratorReviewPanel doc={doc} readOnly />
          <PrevGoalsPanel doc={doc} />
        </div>
        <SelfReviewPanel doc={doc} hideFocus />
      </section>
    </div>
  );
}

// ── Куратору ─────────────────────────────────────────────────────────────────
export function CuratorView({ doc }: { doc: WeeklyReview }) {
  const { t } = weeklyI18n.useT();
  const ins = useWeekInsights(doc);
  const k = doc.kpis.current;
  const fails = ins.checklist.filter((c) => c.status === "fail").length;
  const warns = ins.checklist.filter((c) => c.status === "warn").length;
  const hasMistakes = doc.mistakes.items.length > 0 || doc.violations.items.length > 0;

  return (
    <div className="flex flex-col gap-[var(--grid-gap)]">
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>{weekHeadline(doc)}</span>
        {fails > 0 && <Pill tone="down" dot>{t("audience.violations", { count: fails })}</Pill>}
        {warns > 0 && <Pill tone="warn" dot>{t("audience.warns", { count: warns })}</Pill>}
        {fails === 0 && warns === 0 && <Pill tone="up" dot>{t("audience.clean")}</Pill>}
      </div>
      {k.trades > 0 ? <WeekKpiStrip doc={doc} ins={ins} /> : <NoTradesWeek doc={doc} />}
      <BentoGrid>
        <ChecklistPanel items={ins.checklist} className="lg:col-span-7" />
        <DeskComparePanel bench={ins.bench} row={ins.benchRow} trend={ins.trend} loading={ins.benchLoading} className="lg:col-span-5" />
      </BentoGrid>
      <BentoGrid>
        <TipsPanel
          tips={ins.tips}
          loading={ins.tipsLoading}
          title={t("audience.leaksTitle")}
          description={t("audience.leaksDesc")}
          className="lg:col-span-7"
        />
        <JournalRiskPanel doc={doc} ins={ins} className="lg:col-span-5" />
      </BentoGrid>
      {k.trades > 0 && <DayStrip doc={doc} ins={ins} />}
      {hasMistakes && <MistakesPanel doc={doc} />}
      <section aria-label={t("audience.oneOnOne")} className="flex flex-col gap-[var(--grid-gap)]">
        <div className="grid gap-[var(--grid-gap)] xl:grid-cols-2">
          <SelfReviewPanel doc={doc} />
          <CuratorReviewPanel doc={doc} />
        </div>
        <PrevGoalsPanel doc={doc} />
      </section>
    </div>
  );
}
