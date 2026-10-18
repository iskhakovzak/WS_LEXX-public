import * as React from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Pill, ProgressRing, Segmented } from "@/components/ds";
import type { Evaluation, TraderEval } from "./use-scaling";
import { useHistory, useProposals } from "./use-scaling";
import { TierLadder } from "./ladder";
import { RuleList } from "./rule-list";
import { MetricsGrid } from "./metrics-grid";
import { TierCompare } from "./tier-compare";
import { HistoryTimeline } from "./history-timeline";
import { ProposalCard } from "./proposal-card";
import { ProposeButton, TierPopover } from "./curator-actions";
import { ACTION_TONE, actionLabel, tierLabel } from "./format";
import { commonI18n } from "@/i18n/ns/common";
import { scalingI18n } from "@/i18n/ns/scaling";
import { personName } from "@/i18n";

type Tab = "rules" | "metrics" | "limits" | "history";

/** Curator drill-down for one trader: rules, metrics, limits of the next tier, history + proposals. */
export function TraderSheet({
  row,
  evaluation,
  open,
  onOpenChange,
}: {
  row: TraderEval | null;
  evaluation: Evaluation;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = scalingI18n.useT();
  const { t: tc } = commonI18n.useT();
  const [tab, setTab] = React.useState<Tab>("rules");
  React.useEffect(() => { if (open) setTab("rules"); }, [open, row?.trader]);
  const history = useHistory(row?.trader ?? null, open && !!row);
  const proposals = useProposals("all", row?.trader ?? null, open && !!row);
  const promote = row?.rules.filter((r) => r.kind === "promote") ?? [];
  const demote = row?.rules.filter((r) => r.kind === "demote") ?? [];
  const w20 = row?.windows.find((w) => w.windowDays === 20) ?? row?.windows[0];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
        {row && (
          <div className="flex flex-col gap-5">
            <SheetHeader className="pr-10 text-left">
              <div className="flex flex-wrap items-center gap-2">
                <SheetTitle className="text-xl">{personName(row.trader)}</SheetTitle>
                <Pill tone="purple">{tierLabel(row.tier)}</Pill>
                <Pill tone={ACTION_TONE[row.recommendation.action]} dot>{actionLabel(row.recommendation.action)}</Pill>
                {row.recommendation.warning && <Pill tone="warn">{t("sheet.needsReview")}</Pill>}
              </div>
              <SheetDescription asChild>
                <div className="flex flex-col gap-2">
                  <TierLadder tiers={evaluation.tiers} current={row.tierKey} target={row.recommendation.toTier?.key} compact />
                  <ul className="text-xs text-muted-foreground">
                    {row.recommendation.reasons.map((r, i) => <li key={i}>• {r}</li>)}
                  </ul>
                </div>
              </SheetDescription>
            </SheetHeader>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <ProgressRing value={row.progress == null ? 0 : row.progress * 100} size={48} tone={row.progress === 1 ? "up" : "accent"} ariaLabel={t("progress.aria")} />
                <div className="text-sm">
                  <div className="font-medium text-foreground">
                    {row.nextTier ? t("progress.toTier", { name: tierLabel(row.nextTier) }) : t("progress.top")}
                  </div>
                  <div className="text-xs text-muted-foreground">{t("progress.passedOfDone", { count: row.promoteTotal, passed: row.promotePassed })}</div>
                </div>
              </div>
              {evaluation.canEdit && (
                <div className="flex flex-wrap items-center gap-2">
                  <TierPopover row={row} tiers={evaluation.tiers} mode={row.tierKey ? "propose" : "assign"} />
                  <ProposeButton row={row} />
                </div>
              )}
            </div>

            {row.pendingProposal && <ProposalCard proposal={row.pendingProposal} tiers={evaluation.tiers} canDecide={evaluation.canEdit} />}

            <Segmented
              ariaLabel={t("sheet.tabsAria")}
              value={tab}
              onChange={setTab}
              size="sm"
              options={[
                { value: "rules", label: t("sheet.tabRules"), count: row.rules.length },
                { value: "metrics", label: t("sheet.tabMetrics") },
                { value: "limits", label: t("sheet.tabLimits") },
                { value: "history", label: tc("fields.history") },
              ]}
            />

            {tab === "rules" && (
              <div className="flex flex-col gap-4">
                <section className="flex flex-col gap-2">
                  <h3 className="micro-label">{actionLabel("promote")}</h3>
                  <RuleList rules={promote} metrics={evaluation.meta.metrics} emptyText={t("rules.emptyPromote")} />
                </section>
                <section className="flex flex-col gap-2">
                  <h3 className="micro-label">{actionLabel("demote")}</h3>
                  <RuleList rules={demote} metrics={evaluation.meta.metrics} emptyText={t("rules.emptyDemote")} />
                </section>
              </div>
            )}
            {tab === "metrics" && <MetricsGrid window={w20} metrics={evaluation.meta.metrics} />}
            {tab === "limits" && <TierCompare current={row.tier} limits={row.limits} next={row.nextTier} />}
            {tab === "history" && (
              <div className="flex flex-col gap-4">
                {proposals.data?.proposals.filter((p) => p.status !== "pending").length ? (
                  <section className="flex flex-col gap-2">
                    <h3 className="micro-label">{t("sheet.decisions")}</h3>
                    {proposals.data.proposals.filter((p) => p.status !== "pending").slice(0, 5).map((p) => (
                      <ProposalCard key={p.id} proposal={p} tiers={evaluation.tiers} canDecide={false} />
                    ))}
                  </section>
                ) : null}
                <section className="flex flex-col gap-2">
                  <h3 className="micro-label">{t("sheet.tierChanges")}</h3>
                  <HistoryTimeline entries={history.data?.history ?? []} tiers={evaluation.tiers} loading={history.isLoading} />
                </section>
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
