import * as React from "react";
import { AlertTriangle, ArrowUpRight, CheckCircle2, History, ListChecks, Target, TrendingUp } from "lucide-react";
import { EmptyState, Panel, Pill, ProgressRing } from "@/components/ds";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { cn } from "@/lib/utils";
import { fmtRate, fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { scalingI18n } from "@/i18n/ns/scaling";
import { useEvaluation, useHistory, useProposals } from "./use-scaling";
import { TierLadder } from "./ladder";
import { RuleList } from "./rule-list";
import { MetricsGrid } from "./metrics-grid";
import { TierCompare } from "./tier-compare";
import { HistoryTimeline } from "./history-timeline";
import { ProposalCard } from "./proposal-card";
import { ACTION_TONE, actionLabel, tierLabel } from "./format";

/** Trader's personal plan: where I am, what is missing until the next tier, what I get there, my history. */
export function MyView({ trader, onUpdatedAt }: { trader: string; onUpdatedAt?: (ts: number) => void }) {
  const { t } = scalingI18n.useT();
  const { t: tc } = commonI18n.useT();
  const ev = useEvaluation(trader);
  const history = useHistory(trader);
  const proposals = useProposals("all", trader);
  React.useEffect(() => { if (ev.dataUpdatedAt) onUpdatedAt?.(ev.dataUpdatedAt); }, [ev.dataUpdatedAt, onUpdatedAt]);

  if (ev.isError) return <Panel><QueryError error={ev.error} onRetry={() => ev.refetch()} title={t("me.loadFailed")} /></Panel>;
  if (ev.isLoading || !ev.data) {
    return (
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-56 rounded-2xl lg:col-span-2" />
        <Skeleton className="h-56 rounded-2xl" />
        <Skeleton className="h-72 rounded-2xl lg:col-span-2" />
        <Skeleton className="h-72 rounded-2xl" />
      </div>
    );
  }
  const data = ev.data;
  const me = data.traders.find((x) => x.trader === trader) ?? data.traders[0];
  if (!me) {
    return <Panel><EmptyState icon={Target} title={t("me.notInPlan")} description={t("me.notInPlanHint")} /></Panel>;
  }
  const action = me.recommendation.action;
  const promote = me.rules.filter((r) => r.kind === "promote");
  const demote = me.rules.filter((r) => r.kind === "demote");
  const w20 = me.windows.find((w) => w.windowDays === 20) ?? me.windows[0];
  const pct = me.progress == null ? 0 : Math.round(me.progress * 100);
  const pendingList = (proposals.data?.proposals ?? []).filter((p) => p.status === "pending");
  const decided = (proposals.data?.proposals ?? []).filter((p) => p.status !== "pending").slice(0, 3);
  const yesNo = (v: boolean | null | undefined) => (v ? tc("yes") : tc("no"));
  // Inline signal next to the tier (not a banner): a triggered demotion rule, or «all promotion conditions met».
  const triggered = me.triggered.map((r) => r.label).filter(Boolean).join(", ");
  const showDemote = (action === "demote" || me.recommendation.warning) && !!triggered;
  const showPromote = !showDemote && action === "promote" && pendingList.length === 0;

  return (
    <div className="grid gap-4 lg:grid-cols-3 sm:gap-5">
      {/* Hero: current tier + progress ring */}
      <Panel className="lg:col-span-2" bodyClassName="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-xs text-muted-foreground">{t("me.yourTier")}</div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-2xl font-semibold tracking-tight text-foreground">{tierLabel(me.tier)}</span>
              <Pill tone={ACTION_TONE[action]} dot>{actionLabel(action)}</Pill>
              {me.recommendation.warning && <Pill tone="warn">{t("me.needsReview")}</Pill>}
            </div>
            {me.tier?.description && <p className="text-xs text-muted-foreground">{me.tier.description}</p>}
          </div>
          <div className="flex items-center gap-3">
            <ProgressRing value={pct} size={72} stroke={6} tone={pct >= 100 ? "up" : "accent"} ariaLabel={t("progress.aria")} label={<span className="text-sm">{fmtRate(me.progress ?? 0)}</span>} />
            <div className="min-w-0 max-w-[16rem] text-sm">
              <div className="font-medium text-foreground">{me.nextTier ? t("progress.toTier", { name: tierLabel(me.nextTier) }) : t("progress.topMine")}</div>
              <div className="text-xs text-muted-foreground">{t("progress.passedOf", { count: me.promoteTotal, passed: me.promotePassed })}</div>
              {me.nextTier?.accountSize != null && (
                <div className="text-xs text-muted-foreground">{t("me.bpWillBe", { amount: fmtUsd(me.nextTier.accountSize, { compact: true }) })}</div>
              )}
            </div>
          </div>
        </div>
        {showDemote && (
          <p role="status" className="flex items-start gap-2 text-sm text-down">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{t(me.recommendation.warning ? "me.demoteAlertBottom" : "me.demoteAlert", { rules: triggered })}</span>
          </p>
        )}
        {showPromote && (
          <p role="status" className="flex items-start gap-2 text-sm text-up">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{t("me.promoteReady")}</span>
          </p>
        )}
        <TierLadder tiers={data.tiers} current={me.tierKey} target={me.recommendation.toTier?.key} />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Kpi label={t("limit.accountSize")} value={fmtUsd(me.limits?.accountSize ?? me.tier?.accountSize ?? null, { compact: true })} />
          <Kpi label={tc("trading.dailyLimit")} value={fmtUsd(me.limits?.dailyLossLimit ?? me.tier?.dailyLossLimit ?? null, { decimals: 0 })} />
          <Kpi label={t("limit.maxPositionUsd")} value={fmtUsd(me.limits?.maxPositionUsd ?? me.tier?.maxPositionUsd ?? null, { compact: true })} />
          <Kpi label={t("me.overnightSwing")} value={`${yesNo(me.limits?.allowOvernight ?? me.tier?.allowOvernight)} / ${yesNo(me.limits?.allowSwing ?? me.tier?.allowSwing)}`} />
        </div>
        {pendingList.map((p) => <ProposalCard key={p.id} proposal={p} tiers={data.tiers} canDecide={false} />)}
      </Panel>

      {/* What the next tier gives */}
      <Panel title={me.nextTier ? t("me.whatNextGives", { name: tierLabel(me.nextTier) }) : t("me.yourLimits")} icon={ArrowUpRight}>
        <TierCompare current={me.tier} limits={me.limits} next={me.nextTier} />
      </Panel>

      {/* Checklist */}
      <Panel
        className="lg:col-span-2"
        title={t("me.toNext")}
        description={me.missing.length ? t("me.missing", { missing: me.missing.length, total: me.promoteTotal }) : me.nextTier ? t("me.allPassed") : t("me.topRules")}
        icon={ListChecks}
      >
        <div className="flex flex-col gap-4">
          <RuleList rules={[...promote].sort((x, y) => (x.status === "pass" ? 1 : 0) - (y.status === "pass" ? 1 : 0))} metrics={data.meta.metrics} emptyText={t("me.emptyPromote")} />
          {demote.length > 0 && (
            <section className="flex flex-col gap-2">
              <h3 className="micro-label">{t("me.toDemotion")}</h3>
              <RuleList rules={demote} metrics={data.meta.metrics} />
            </section>
          )}
        </div>
      </Panel>

      {/* History */}
      <Panel title={tc("fields.history")} icon={History}>
        <div className="flex flex-col gap-4">
          {decided.length > 0 && (
            <div className="flex flex-col gap-2">
              {decided.map((p) => <ProposalCard key={p.id} proposal={p} tiers={data.tiers} canDecide={false} />)}
            </div>
          )}
          <HistoryTimeline entries={history.data?.history ?? []} tiers={data.tiers} loading={history.isLoading} limit={8} />
        </div>
      </Panel>

      <Panel className="lg:col-span-3" title={t("me.windowMetrics")} description={t("me.windowMetricsHint")} icon={TrendingUp}>
        <MetricsGrid window={w20} metrics={data.meta.metrics} />
      </Panel>
    </div>
  );
}

function Kpi({ label, value, className }: { label: string; value: React.ReactNode; className?: string }) {
  return (
    <div className={cn("glass-panel flex flex-col gap-0.5 rounded-xl px-3 py-2", className)}>
      <span className="truncate text-2xs text-muted-foreground" title={label}>{label}</span>
      <span className="truncate text-base font-semibold tabular-nums text-foreground">{value}</span>
    </div>
  );
}
