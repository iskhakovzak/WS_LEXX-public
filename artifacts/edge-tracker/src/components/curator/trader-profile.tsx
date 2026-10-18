import * as React from "react";
import { Link } from "wouter";
import {
  ArrowLeft, ArrowRight, BookOpen, CalendarCheck, GraduationCap, Layers, LayoutDashboard, NotebookPen, ShieldAlert, Target, TrendingUp, UserRound,
} from "lucide-react";
import {
  BentoGrid, DataTable, EmptyState, LimitBar, Panel, Pill, QueryState, SectionTabs, SortableTh, Sparkline, StatCard, StatGrid, StatusDot, toneText, useTableSort,
} from "@/components/ds";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useCuratorProfile, type ProfilePayload } from "./api";
import { BreachReviewPanel } from "./breach-review";
import { actionTone, curatorLinks, disciplineTone, riskTone, waitLabel } from "./curator-math";
import { useCuratorEodReview, type EodTarget } from "./eod-review";
import { GoalDialog } from "./goal-dialog";
import { NotesPanel } from "./notes-panel";
import { FocusPanel } from "./focus-panel";
import { TemplateDialog } from "./template-dialog";
import { fmtDate, fmtUsd } from "@/lib/format";
import { curatorI18n } from "@/i18n/ns/curator";
import { personName } from "@/i18n";
import { commonI18n } from "@/i18n/ns/common";

export type ProfileTab = "overview" | "risk" | "journal" | "weekly" | "academy" | "notes";
export const PROFILE_TABS: ProfileTab[] = ["overview", "risk", "journal", "weekly", "academy", "notes"];

const WEEK_TONE: Record<string, "neutral" | "accent" | "up" | "warn"> = { draft: "neutral", submitted: "accent", reviewed: "up" };
const GOAL_TONE: Record<string, "accent" | "up" | "down" | "neutral"> = { active: "accent", achieved: "up", missed: "down", cancelled: "neutral" };
/** Status code → label in the current language (unknown codes show as is). */
const weekStatus = (s: string) => ({ label: curatorI18n.tryT(`profile.weekStatus.${s}`) ?? s, tone: WEEK_TONE[s] ?? ("neutral" as const) });
const goalStatus = (s: string) => ({ label: curatorI18n.tryT(`profile.goalStatus.${s}`) ?? s, tone: GOAL_TONE[s] ?? ("neutral" as const) });
const actionStatus = (s: string) => curatorI18n.tryT(`profile.actionStatus.${s}`) ?? s;
const meetingFormat = (s: string) => curatorI18n.tryT(`profile.meetingFormat.${s}`) ?? s;

type EodDay = ProfilePayload["eodDays"][number];
type WeekRow = ProfilePayload["weeks"][number];
/** 0 — ждёт разбора (наверх), 1 — не закрыт, 2 — разобран. */
const EOD_ACCESSORS = {
  date: (d: EodDay) => d.date,
  status: (d: EodDay) => (d.reviewedAt ? 2 : d.closedAt ? 0 : 1),
  discipline: (d: EodDay) => d.discipline,
  score: (d: EodDay) => d.curatorScore,
};
const WEEK_ORDER: Record<string, number> = { submitted: 0, draft: 1, reviewed: 2 };
const WEEK_ACCESSORS = {
  week: (w: WeekRow) => w.weekStart,
  status: (w: WeekRow) => WEEK_ORDER[w.status] ?? 3,
  submitted: (w: WeekRow) => (w.submittedAt ? Date.parse(w.submittedAt) : null),
  reviewed: (w: WeekRow) => (w.reviewedAt ? Date.parse(w.reviewedAt) : null),
  score: (w: WeekRow) => w.score,
};

/** Trader profile inside the cabinet: header with actions + tabs overview / risk / journal / weekly / academy / notes. */
export function TraderProfile({ trader, tab, onTab, onBack }: { trader: string; tab: ProfileTab; onTab: (t: ProfileTab) => void; onBack: () => void }) {
  const q = useCuratorProfile(trader);
  const { t } = curatorI18n.useT();
  const [goalOpen, setGoalOpen] = React.useState(false);
  const [tplOpen, setTplOpen] = React.useState(false);

  return (
    <div className="flex flex-col gap-[var(--grid-gap)]">
      <QueryState query={q} skeleton={<div className="glass-panel h-40 rounded-2xl" aria-hidden="true" />} errorTitle={t("profile.loadFailed", { name: personName(trader) })}>
        {(p) => (
          <>
            <ProfileHeader p={p} onBack={onBack} onGoal={() => setGoalOpen(true)} onTemplate={() => setTplOpen(true)} />
            <SectionTabs
              ariaLabel={t("profile.tabsAria")}
              value={tab}
              onChange={onTab}
              tabs={[
                { value: "overview", label: t("profile.tab.overview"), icon: LayoutDashboard },
                { value: "risk", label: t("profile.tab.risk"), icon: ShieldAlert, count: p.breaches.filter((b) => !b.review).length || undefined },
                { value: "journal", label: t("profile.tab.journal"), icon: BookOpen, count: p.signal.eod.pending || undefined },
                { value: "weekly", label: t("profile.tab.weekly"), icon: CalendarCheck },
                { value: "academy", label: t("profile.tab.academy"), icon: GraduationCap, count: p.signal.academy.overdueActions || undefined },
                { value: "notes", label: t("profile.tab.notes"), icon: NotebookPen, count: p.notes.length || undefined },
              ]}
            />
            {tab === "overview" && <OverviewTab p={p} onTab={onTab} onGoal={() => setGoalOpen(true)} />}
            {tab === "risk" && <RiskTab p={p} onTemplate={() => setTplOpen(true)} />}
            {tab === "journal" && <JournalTab p={p} />}
            {tab === "weekly" && <WeeklyTab p={p} />}
            {tab === "academy" && <AcademyTab p={p} onGoal={() => setGoalOpen(true)} />}
            {tab === "notes" && <NotesPanel trader={p.trader} notes={p.notes} />}
            <GoalDialog open={goalOpen} onOpenChange={setGoalOpen} trader={p.trader} />
            <TemplateDialog open={tplOpen} onOpenChange={setTplOpen} traders={[p.trader]} defaultTier={p.signal.tier ?? p.signal.stage.key} />
          </>
        )}
      </QueryState>
    </div>
  );
}

function ProfileHeader({ p, onBack, onGoal, onTemplate }: { p: ProfilePayload; onBack: () => void; onGoal: () => void; onTemplate: () => void }) {
  const s = p.signal;
  const { t } = curatorI18n.useT();
  const people = [
    p.assigned.curator && t("profile.curatorIs", { name: personName(p.assigned.curator) }),
    p.assigned.mentor && t("profile.mentorIs", { name: personName(p.assigned.mentor) }),
    p.assigned.riskManager && t("profile.riskIs", { name: personName(p.assigned.riskManager) }),
  ].filter(Boolean).join(" · ");
  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <Button type="button" variant="ghost" size="sm" onClick={onBack} aria-label={t("profile.back")}>
          <ArrowLeft className="h-4 w-4" /> {t("profile.allTraders")}
        </Button>
        <span className="tile grid h-10 w-10 shrink-0 place-items-center rounded-xl text-primary"><UserRound className="h-5 w-5" aria-hidden="true" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-lg font-semibold text-foreground" title={personName(p.trader)}>{personName(p.trader)}</h2>
            {s.stage.label && <Pill tone="purple">{s.stage.label}</Pill>}
            {s.tierName && <Pill tone="neutral">{t("profile.tierIs", { name: s.tierName })}</Pill>}
            <Pill tone={riskTone(s.risk.state)} dot>{s.risk.hasLimits ? s.risk.label : t("noLimits")}</Pill>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={people || undefined}>{people || t("profile.noCurator")}{s.lastTradeDate ? ` · ${t("profile.lastTrade", { date: fmtDate(s.lastTradeDate, "dayMonth") })}` : ""}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {p.canEditLimits && <Button type="button" size="sm" variant="outline" onClick={onTemplate}><Layers className="h-3.5 w-3.5" /> {t("profile.limitTemplate")}</Button>}
          <Button type="button" size="sm" onClick={onGoal}><Target className="h-3.5 w-3.5" /> {t("profile.assignGoal")}</Button>
        </div>
      </div>
      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2 border-t border-[var(--glass-border)] pt-3">
        <span className="micro-label shrink-0">{t("profile.nextStep")}</span>
        <StatusDot tone={actionTone(s.nextAction.kind)} className="min-w-0 flex-1 basis-48"><span className="text-sm text-foreground">{s.nextAction.label}</span></StatusDot>
        {s.nextAction.kind !== "none" && !s.nextAction.href.startsWith(`/curator?`) && (
          <Button asChild size="sm" variant="ghost"><Link href={s.nextAction.href}>{t("goTo")} <ArrowRight className="h-3.5 w-3.5" /></Link></Button>
        )}
        <span className="mx-1 h-5 w-px shrink-0 bg-[var(--glass-border)]" aria-hidden="true" />
        <nav aria-label={t("profile.linksAria")} className="flex shrink-0 flex-wrap items-center gap-1">
          <Button asChild size="sm" variant="ghost"><Link href={curatorLinks.risk(p.trader)}>{t("profile.riskDesk")}</Link></Button>
          <Button asChild size="sm" variant="ghost"><Link href={curatorLinks.journalQueue()}>{t("profile.dayQueue")}</Link></Button>
          <Button asChild size="sm" variant="ghost"><Link href={curatorLinks.weeklyCurator(p.trader)}>{t("profile.week")}</Link></Button>
        </nav>
      </div>
    </Panel>
  );
}

function OverviewTab({ p, onTab, onGoal }: { p: ProfilePayload; onTab: (t: ProfileTab) => void; onGoal: () => void }) {
  const s = p.signal;
  const fourWeekNet = s.trend.reduce((a, w) => a + (w.net ?? 0), 0);
  const unreviewed = p.breaches.filter((b) => !b.review);
  const activeGoals = p.goals.filter((g) => g.status === "active");
  const { t } = curatorI18n.useT();
  const tc = commonI18n.useT().t;
  return (
    <div className="flex flex-col gap-[var(--grid-gap)]">
      <StatGrid cols={4}>
        <StatCard label={t("profile.todayNet")} value={s.risk.todayTrades ? fmtUsd(s.risk.todayPnl, { signed: true, decimals: 0 }) : "—"} tone={(s.risk.todayPnl ?? 0) > 0 ? "up" : (s.risk.todayPnl ?? 0) < 0 ? "down" : "neutral"} hint={tc("units.trades", { count: s.risk.todayTrades })} term="net" />
        <StatCard label={t("profile.weekNet")} value={fmtUsd(s.risk.weekPnl, { signed: true, decimals: 0 })} tone={(s.risk.weekPnl ?? 0) > 0 ? "up" : (s.risk.weekPnl ?? 0) < 0 ? "down" : "neutral"} hint={p.metrics?.week.limitUsedPct != null ? t("profile.weekLimitUsed", { pct: Math.round(p.metrics.week.limitUsedPct) }) : undefined} />
        <StatCard label={t("profile.fourWeeks")} value={fmtUsd(fourWeekNet, { signed: true, decimals: 0 })} tone={fourWeekNet > 0 ? "up" : fourWeekNet < 0 ? "down" : "neutral"} spark={s.trend.map((w) => w.net)} hint={tc("units.trades", { count: s.trend.map((w) => w.trades).reduce((a, b) => a + b, 0) })} />
        <StatCard
          label={t("profile.discipline")}
          value={s.discipline.value != null ? s.discipline.value.toFixed(1) : "—"}
          tone={disciplineTone(s.discipline.value)}
          hint={[s.discipline.eodAvg != null && t("profile.disciplineDays", { value: s.discipline.eodAvg.toFixed(1) }), s.discipline.ratingAvg != null && t("profile.disciplineRating", { value: s.discipline.ratingAvg.toFixed(1) })].filter(Boolean).join(" · ") || t("profile.noGrades")}
        />
      </StatGrid>
      <BentoGrid>
        <div className="flex flex-col gap-[var(--grid-gap)] lg:col-span-7">
          {unreviewed.length > 0 ? (
            <BreachReviewPanel breaches={unreviewed} canReview title={t("profile.unreviewedBreaches")} />
          ) : (
            <Panel title={t("profile.risk")} icon={ShieldAlert} actions={<Button type="button" size="sm" variant="ghost" onClick={() => onTab("risk")}>{t("profile.details")} <ArrowRight className="h-3.5 w-3.5" /></Button>}>
              <RiskBars p={p} />
              <p className="mt-3 text-xs text-muted-foreground">
                {p.breaches.length ? t("profile.breaches90", { count: p.breaches.length }) : t("profile.noBreaches90")}
              </p>
            </Panel>
          )}
          <Panel
            title={t("profile.goals")}
            icon={Target}
            actions={<Button type="button" size="sm" variant="ghost" onClick={onGoal}>{t("profile.assign")}</Button>}
          >
            <GoalsList goals={activeGoals.length ? activeGoals : p.goals.slice(0, 3)} />
          </Panel>
        </div>
        <div className="flex flex-col gap-[var(--grid-gap)] lg:col-span-5">
          {p.focus && <FocusPanel trader={p.trader} focus={p.focus} />}
          <Panel title={t("profile.lastReports")} icon={BookOpen}>
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{t("profile.lastClosed")}</dt>
              <dd className="text-right tabular-nums text-foreground">{fmtDate(s.eod.lastClosed, "dayMonth")}</dd>
              <dt className="text-muted-foreground">{t("profile.pendingDays")}</dt>
              <dd className={cn("text-right tabular-nums", s.eod.pending ? "text-primary" : "text-foreground")}>{s.eod.pending}</dd>
              <dt className="text-muted-foreground">{t("profile.lastDayReview")}</dt>
              <dd className="text-right tabular-nums text-foreground">{s.eod.lastReviewedAt ? fmtDate(s.eod.lastReviewedAt.slice(0, 10), "dayMonth") : t("never")}{s.eod.lastScore != null ? ` · ${s.eod.lastScore}/5` : ""}</dd>
              <dt className="text-muted-foreground">{t("profile.weeklyReport")}</dt>
              <dd className="text-right text-foreground">{s.weekly.currentStatus ? weekStatus(s.weekly.currentStatus).label : t("profile.notStarted")}</dd>
              <dt className="text-muted-foreground">1:1</dt>
              <dd className={cn("text-right tabular-nums", (s.academy.daysSinceOneOnOne ?? 99) > 14 ? "text-warn" : "text-foreground")}>
                {s.academy.lastOneOnOne ? t("profile.oneOnOneAgo", { date: fmtDate(s.academy.lastOneOnOne.slice(0, 10), "dayMonth"), count: s.academy.daysSinceOneOnOne ?? 0 }) : t("never")}
              </dd>
            </dl>
          </Panel>
          <NotesPanel trader={p.trader} notes={p.notes} compact onShowAll={() => onTab("notes")} />
        </div>
      </BentoGrid>
    </div>
  );
}

function RiskBars({ p }: { p: ProfilePayload }) {
  const m = p.metrics;
  const l = p.limits;
  const t = curatorI18n.t;
  if (!l) return <p className="text-sm text-warn">{t("profile.noLimitsWarn")}</p>;
  return (
    <div className="flex flex-col gap-3">
      <LimitBar label={t("profile.dailyLoss")} used={m ? Math.min(0, m.today.pnlNet ?? 0) : 0} limit={l.dailyLossLimit} warnAt={0.7} format={(n) => fmtUsd(Math.abs(n), { decimals: 0 })} />
      <LimitBar label={t("profile.weeklyLoss")} used={m ? Math.min(0, m.week.pnlNet ?? 0) : 0} limit={l.weeklyLossLimit} warnAt={0.7} format={(n) => fmtUsd(Math.abs(n), { decimals: 0 })} />
      <LimitBar label={t("profile.drawdown")} used={m?.drawdown.currentUsd ?? 0} limit={l.maxDrawdown} warnAt={0.7} format={(n) => fmtUsd(Math.abs(n), { decimals: 0 })} hint={m?.drawdown.redDayStreak ? t("profile.redStreak", { count: m.drawdown.redDayStreak }) : undefined} />
    </div>
  );
}

function RiskTab({ p, onTemplate }: { p: ProfilePayload; onTemplate: () => void }) {
  const l = p.limits;
  const drift = p.signal.risk.templateDrift;
  const { t } = curatorI18n.useT();
  const rows: [string, React.ReactNode][] = l ? [
    [t("profile.limits.daily"), fmtUsd(l.dailyLossLimit, { decimals: 0 })],
    [t("profile.limits.weekly"), fmtUsd(l.weeklyLossLimit, { decimals: 0 })],
    [t("profile.limits.maxDd"), fmtUsd(l.maxDrawdown, { decimals: 0 })],
    [t("profile.limits.riskPerTrade"), fmtUsd(l.maxRiskPerTrade, { decimals: 0 })],
    [t("profile.limits.maxPosition"), fmtUsd(l.maxPositionUsd, { decimals: 0 })],
    [t("profile.limits.openPositions"), l.maxOpenPositions ?? "—"],
    [t("profile.limits.overnight"), l.allowOvernight ? t("profile.limits.overnightYes", { amount: fmtUsd(l.maxOvernightExposure, { decimals: 0 }) }) : t("profile.limits.no")],
    [t("profile.limits.swing"), l.allowSwing ? t("profile.limits.yes") : t("profile.limits.no")],
  ] : [];
  return (
    <div className="flex flex-col gap-[var(--grid-gap)]">
      <BentoGrid>
        <Panel className="lg:col-span-7" fill title={t("profile.usageTitle")} icon={ShieldAlert} description={t("profile.usageHint")}>
          <RiskBars p={p} />
          {p.metrics && p.metrics.alerts.length > 0 && (
            <ul className="mt-4 flex flex-col gap-1.5">
              {p.metrics.alerts.map((a) => (
                <li key={a.kind} className="flex items-center gap-2 text-sm">
                  <Pill tone={a.level === "breach" ? "down" : "warn"} dot>{a.label}</Pill>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{a.detail ?? ""}</span>
                  <span className="text-xs tabular-nums text-foreground">{a.pct != null ? `${Math.round(a.pct)}%` : ""}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel
          className="lg:col-span-5"
          fill
          title={t("profile.limitsTitle")}
          icon={Layers}
          description={p.signal.tierName ? t("profile.tierNamed", { name: p.signal.tierName }) : t("profile.noTier")}
          actions={p.canEditLimits ? <Button type="button" size="sm" variant="outline" onClick={onTemplate}>{t("profile.tierTemplate")}</Button> : undefined}
        >
          {l ? (
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-sm">
              {rows.map(([k, v]) => (
                <React.Fragment key={k}><dt className="text-muted-foreground">{k}</dt><dd className="text-right tabular-nums text-foreground">{v}</dd></React.Fragment>
              ))}
            </dl>
          ) : (
            <EmptyState compact icon={Layers} title={t("profile.noLimitsTitle")} description={t("profile.noLimitsHint")} />
          )}
          {drift.length > 0 && (
            <p className="mt-3 rounded-lg bg-warn/10 px-2.5 py-1.5 text-xs text-warn">{t("profile.drift", { fields: drift.join(", ") })}</p>
          )}
          {p.limitEvents.length > 0 && (
            <div className="mt-4 flex flex-col gap-1">
              <span className="micro-label">{t("profile.lastChanges")}</span>
              {p.limitEvents.map((e) => (
                <p key={e.id} className="break-words text-xs text-muted-foreground">
                  <span className="tabular-nums">{fmtDate(e.changedAt, "dateTime")}</span> · {e.changedBy ? personName(e.changedBy) : "—"}{e.reason ? ` · ${e.reason}` : ""}
                </p>
              ))}
            </div>
          )}
          <Button asChild size="sm" variant="ghost" className="mt-3 self-start"><Link href={curatorLinks.riskLimits(p.trader)}>{t("profile.editInRiskDesk")} <ArrowRight className="h-3.5 w-3.5" /></Link></Button>
        </Panel>
      </BentoGrid>
      <BreachReviewPanel breaches={p.breaches} canReview />
    </div>
  );
}

function JournalTab({ p }: { p: ProfilePayload }) {
  const { rows, thProps } = useTableSort(p.eodDays, EOD_ACCESSORS, "date");
  const pending = React.useMemo<EodTarget[]>(
    () => (p.eodPending ?? []).map((d) => ({ eodId: d.id, trader: p.trader, date: d.date, closedAt: d.closedAt, hoursWaiting: d.hoursWaiting })),
    [p.eodPending, p.trader],
  );
  const review = useCuratorEodReview(pending);
  const { t } = curatorI18n.useT();
  const [allPending, setAllPending] = React.useState(false);
  const thisYear = String(new Date().getFullYear());
  const target = (d: { id: number; date: string; closedAt: string | null }): EodTarget =>
    pending.find((x) => x.eodId === d.id) ?? { eodId: d.id, trader: p.trader, date: d.date, closedAt: d.closedAt, hoursWaiting: null };
  return (
    <div className="flex flex-col gap-[var(--grid-gap)]">
      {pending.length > 0 && (
        <Panel
          title={t("profile.pendingTitle")}
          icon={BookOpen}
          description={t("profile.pendingHint")}
          actions={<Button type="button" size="sm" onClick={() => review.open(pending[0])}>{t("profile.reviewInOrder", { count: pending.length })}</Button>}
        >
          <ul className="flex flex-wrap gap-1.5">
            {(allPending ? pending : pending.slice(0, 24)).map((d) => (
              <li key={d.eodId}>
                <button
                  type="button"
                  onClick={() => review.open(d)}
                  className={cn("chip inline-flex min-h-8 items-center gap-1.5 px-3 text-xs font-medium tabular-nums", (d.hoursWaiting ?? 0) > 24 && "text-warn")}
                  title={t("profile.closedWaiting", { date: fmtDate(d.closedAt, "dateTime"), wait: waitLabel(d.hoursWaiting) })}
                >
                  {fmtDate(d.date, "dayMonth")}{d.date.slice(0, 4) !== thisYear ? ` ${d.date.slice(0, 4)}` : ""}
                </button>
              </li>
            ))}
            {pending.length > 24 && (
              <li>
                <button type="button" onClick={() => setAllPending((v) => !v)} className="inline-flex min-h-8 items-center px-2 text-xs text-primary hover:underline">
                  {allPending ? commonI18n.t("actions.collapse") : t("profile.more", { count: pending.length - 24 })}
                </button>
              </li>
            )}
          </ul>
        </Panel>
      )}
      <Panel
        title={t("profile.closedDays")}
        icon={BookOpen}
        description={t("profile.closedDaysHint")}
        actions={<Button asChild size="sm" variant="ghost"><Link href={curatorLinks.journalQueue()}>{t("profile.deskQueue")} <ArrowRight className="h-3.5 w-3.5" /></Link></Button>}
      >
        {p.eodDays.length === 0 ? (
          <EmptyState compact icon={BookOpen} title={t("profile.noDays")} description={t("profile.noDaysHint")} />
        ) : (
          <DataTable ariaLabel={t("profile.daysAria")}>
            <table>
              <thead>
                <tr>
                  <SortableTh {...thProps("date")}>{t("profile.col.date")}</SortableTh>
                  <SortableTh {...thProps("status")}>{t("profile.col.status")}</SortableTh>
                  <SortableTh {...thProps("discipline")} align="right">{t("profile.col.discipline")}</SortableTh>
                  <SortableTh {...thProps("score")} align="right">{t("profile.col.score")}</SortableTh>
                  <th>{t("profile.col.comment")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id}>
                    <td className="whitespace-nowrap">{fmtDate(d.date, "dayMonth")}</td>
                    <td>
                      {d.reviewedAt ? <Pill tone="up">{t("profile.reviewedBy", { name: d.reviewedBy ? personName(d.reviewedBy) : "—" })}</Pill> : d.closedAt ? <Pill tone="accent" dot>{t("profile.waitingReview")}</Pill> : <Pill tone="neutral">{t("profile.notClosed")}</Pill>}
                    </td>
                    <td className={cn("text-right", d.discipline != null && toneText(d.discipline >= 4 ? "up" : d.discipline >= 3 ? "warn" : "down"))}>{d.discipline != null ? `${d.discipline}/5` : "—"}</td>
                    <td className="text-right">{d.curatorScore != null ? `${d.curatorScore}/5` : "—"}</td>
                    <td className="min-w-[14rem] max-w-[36rem] whitespace-pre-line break-words text-muted-foreground">{d.curatorComment ?? ""}</td>
                    <td className="whitespace-nowrap text-right">
                      {d.closedAt ? (
                        <button type="button" onClick={() => review.open(target(d))} className="text-xs text-primary hover:underline">
                          {d.reviewedAt ? t("profile.editReview") : t("review")}
                        </button>
                      ) : (
                        <Link href={curatorLinks.journalDay(p.trader, d.date)} className="text-xs text-primary hover:underline">{t("open")}</Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DataTable>
        )}
      </Panel>
      {review.sheet}
    </div>
  );
}

function WeeklyTab({ p }: { p: ProfilePayload }) {
  const scores = [...p.weeks].reverse().map((w) => w.score);
  const { rows, thProps } = useTableSort(p.weeks, WEEK_ACCESSORS, "week");
  const { t } = curatorI18n.useT();
  return (
    <Panel
      title={t("profile.weeklyTitle")}
      icon={CalendarCheck}
      description={t("profile.weeklyHint")}
      actions={
        <div className="flex items-center gap-2">
          {scores.filter((v) => v != null).length > 1 && <Sparkline data={scores} width={96} height={24} ariaLabel={t("profile.weekScores")} />}
          <Button asChild size="sm" variant="ghost"><Link href={curatorLinks.weeklyCurator(p.trader)}>{t("profile.weekReview")} <ArrowRight className="h-3.5 w-3.5" /></Link></Button>
        </div>
      }
    >
      {p.weeks.length === 0 ? (
        <EmptyState compact icon={CalendarCheck} title={t("profile.noReports")} description={t("profile.noReportsHint")} />
      ) : (
        <DataTable ariaLabel={t("profile.weeklyTitle")}>
          <table>
            <thead>
              <tr>
                <SortableTh {...thProps("week")}>{t("profile.col.week")}</SortableTh>
                <SortableTh {...thProps("status")}>{t("profile.col.status")}</SortableTh>
                <SortableTh {...thProps("submitted")}>{t("profile.col.submitted")}</SortableTh>
                <SortableTh {...thProps("reviewed")}>{t("profile.col.reviewed")}</SortableTh>
                <SortableTh {...thProps("score")} align="right">{t("profile.col.grade")}</SortableTh>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => {
                const st = weekStatus(w.status);
                return (
                  <tr key={w.id}>
                    <td className="whitespace-nowrap">{t("profile.weekFrom", { date: fmtDate(w.weekStart, "dayMonth") })}</td>
                    <td><Pill tone={st.tone} dot={w.status === "submitted"}>{st.label}</Pill></td>
                    <td className="text-muted-foreground">{fmtDate(w.submittedAt, "dateTime")}</td>
                    <td className="text-muted-foreground">{fmtDate(w.reviewedAt, "dateTime")}</td>
                    <td className={cn("text-right", w.score != null && toneText(disciplineTone(w.score)))}>{w.score != null ? `${w.score}/10` : "—"}</td>
                    <td className="text-right"><Link href={curatorLinks.weeklyCurator(p.trader, w.week)} className="text-xs text-primary hover:underline">{t("open")}</Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </DataTable>
      )}
    </Panel>
  );
}

function GoalsList({ goals }: { goals: ProfilePayload["goals"] }) {
  const t = curatorI18n.t;
  if (!goals.length) return <EmptyState compact icon={Target} title={t("profile.noGoals")} description={t("profile.noGoalsHint")} />;
  return (
    <ul className="flex flex-col gap-2">
      {goals.map((g) => {
        const st = goalStatus(g.status);
        const pctDone = g.lastProgress != null ? Math.round(g.lastProgress * 100) : null;
        return (
          <li key={g.id} className="tile flex flex-col gap-1.5 p-2.5">
            <div className="flex items-center gap-2 text-sm">
              <span className="line-clamp-2 min-w-0 flex-1 break-words font-medium text-foreground" title={g.title}>{g.title}</span>
              <Pill tone={st.tone}>{st.label}</Pill>
            </div>
            <LimitBar size="sm" used={pctDone ?? 0} limit={100} warnAt={0} tone="ok" showValues={false} hint={`${pctDone != null ? `${pctDone}%` : t("profile.notCounted")}${g.dueOn ? ` · ${t("profile.due", { date: fmtDate(g.dueOn, "dayMonth") })}` : ""}`} />
          </li>
        );
      })}
    </ul>
  );
}

function AcademyTab({ p, onGoal }: { p: ProfilePayload; onGoal: () => void }) {
  const s = p.signal;
  const open = p.actions.filter((a) => a.status === "open");
  const closed = p.actions.filter((a) => a.status !== "open").slice(0, 5);
  const { t } = curatorI18n.useT();
  return (
    <BentoGrid>
      <div className="flex flex-col gap-[var(--grid-gap)] lg:col-span-7">
        <Panel title={t("profile.agreementsTitle")} icon={CalendarCheck} description={t("profile.agreementsHint")} actions={<Button asChild size="sm" variant="ghost"><Link href={curatorLinks.academyMentor()}>{t("profile.mentorDesk")} <ArrowRight className="h-3.5 w-3.5" /></Link></Button>}>
          {p.actions.length === 0 ? (
            <EmptyState compact icon={CalendarCheck} title={t("profile.noAgreements")} description={t("profile.noAgreementsHint")} />
          ) : (
            <ul className="flex flex-col gap-1.5">
              {[...open, ...closed].map((a) => (
                <li key={a.id} className="flex min-w-0 items-center gap-2 text-sm">
                  <StatusDot tone={a.status !== "open" ? "up" : a.overdue ? "down" : "accent"}><span className="sr-only">{actionStatus(a.status)}</span></StatusDot>
                  <span className={cn("line-clamp-2 min-w-0 flex-1 break-words", a.status !== "open" ? "text-muted-foreground line-through" : "text-foreground")} title={a.title}>{a.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{a.owner === "student" || a.owner === p.trader ? t("profile.ownerTrader") : a.owner === "mentor" ? t("profile.ownerMentor") : personName(a.owner)}</span>
                  <span className={cn("w-16 shrink-0 text-right text-xs tabular-nums", a.overdue ? "text-down" : "text-muted-foreground")}>{a.dueOn ? fmtDate(a.dueOn, "dayMonth") : "—"}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title={t("profile.goals")} icon={Target} actions={<Button type="button" size="sm" onClick={onGoal}><Target className="h-3.5 w-3.5" /> {t("profile.assignGoal")}</Button>}>
          <GoalsList goals={p.goals} />
        </Panel>
      </div>
      <div className="flex flex-col gap-[var(--grid-gap)] lg:col-span-5">
        <Panel title={t("profile.stageTitle")} icon={TrendingUp}>
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">{t("profile.stage")}</dt>
            <dd className="text-right text-foreground">{s.stage.label ?? t("profile.notSetF")}</dd>
            <dt className="text-muted-foreground">{t("profile.since")}</dt>
            <dd className="text-right tabular-nums text-foreground">{s.stage.since ? fmtDate(s.stage.since.slice(0, 10), "dayMonth") : "—"}</dd>
            <dt className="text-muted-foreground">{t("profile.limitTier")}</dt>
            <dd className="text-right text-foreground">{s.tierName ?? t("profile.notAssigned")}</dd>
            <dt className="text-muted-foreground">{t("profile.pendingAssignments")}</dt>
            <dd className={cn("text-right tabular-nums", s.academy.pendingSubmissions ? "text-primary" : "text-foreground")}>{s.academy.pendingSubmissions}</dd>
          </dl>
          <Button asChild size="sm" variant="ghost" className="mt-3"><Link href={curatorLinks.scaling(p.trader)}>{t("profile.scalingTiers")} <ArrowRight className="h-3.5 w-3.5" /></Link></Button>
        </Panel>
        <Panel title={t("profile.meetingsTitle")} icon={UserRound} description={t("profile.meetingsHint")}>
          {p.meetings.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("profile.noMeetings")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {p.meetings.map((m) => (
                <li key={m.id} className="flex flex-col gap-0.5 text-sm">
                  <span className="flex items-center gap-2"><span className="tabular-nums text-foreground">{fmtDate(m.metAt, "dateTime")}</span><span className="text-xs text-muted-foreground">{meetingFormat(m.format)} · {personName(m.mentor)}</span></span>
                  {m.agenda && <span className="line-clamp-2 text-xs text-muted-foreground">{m.agenda}</span>}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </BentoGrid>
  );
}
