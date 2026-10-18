import * as React from "react";
import { Check, X } from "lucide-react";
import { Pill } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { fmtDate } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { scalingI18n } from "@/i18n/ns/scaling";
import { personName } from "@/i18n";
import type { Proposal, Tier } from "./use-scaling";
import { useDecideProposal } from "./use-scaling";
import { ACTION_TONE, actionLabel, proposalStatusMeta, tierName } from "./format";

/** Curator decision with an optional comment, in a popover (no page-level forms). */
function DecisionPopover({
  decision,
  proposal,
  tiers,
  onDone,
}: {
  decision: "approve" | "reject";
  proposal: Proposal;
  tiers: Tier[];
  onDone?: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [comment, setComment] = React.useState("");
  const { toast } = useToast();
  const { t } = scalingI18n.useT();
  const { t: tc } = commonI18n.useT();
  const decide = useDecideProposal();
  const approve = decision === "approve";
  const from = tierName(tiers, proposal.fromTier);
  const to = tierName(tiers, proposal.toTier);
  const submit = async () => {
    try {
      await decide.mutateAsync({ id: proposal.id, decision, comment: comment.trim() || undefined });
      toast({
        title: approve ? t("proposal.approvedToast", { trader: personName(proposal.trader), tier: to }) : t("proposal.rejectedToast", { trader: personName(proposal.trader) }),
        description: approve ? t("proposal.limitsWritten") : undefined,
      });
      setOpen(false);
      setComment("");
      onDone?.();
    } catch (e) {
      toast({ title: t("proposal.decideFailed"), description: (e as Error).message, variant: "destructive" });
    }
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant={approve ? "default" : "outline"} aria-label={approve ? t("proposal.approveAria") : t("proposal.rejectAria")}>
          {approve ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <X className="h-3.5 w-3.5" aria-hidden="true" />}
          {approve ? tc("actions.approve") : tc("actions.reject")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="flex flex-col gap-3">
          <div>
            <p className="text-sm font-semibold text-foreground">{approve ? t(`proposal.approveTitle.${proposal.action}`) : t(`proposal.rejectTitle.${proposal.action}`)}</p>
            <p className="text-xs text-muted-foreground">
              {personName(proposal.trader)}: {from} → {to}
              {approve && <> {t("proposal.approveNote")}</>}
            </p>
          </div>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {approve ? t("proposal.commentOptional") : t("proposal.commentReason")}
            <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} maxLength={2000} placeholder={approve ? t("proposal.approvePlaceholder") : t("proposal.rejectPlaceholder")} />
          </label>
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>{tc("actions.cancel")}</Button>
            <Button size="sm" variant={approve ? "default" : "secondary"} onClick={submit} disabled={decide.isPending}>
              {decide.isPending ? tc("states.saving") : approve ? t("proposal.approveConfirm") : t("proposal.rejectConfirm")}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function ProposalCard({
  proposal,
  tiers,
  canDecide,
  onOpenTrader,
  className,
}: {
  proposal: Proposal;
  tiers: Tier[];
  canDecide: boolean;
  onOpenTrader?: (trader: string) => void;
  className?: string;
}) {
  const { t } = scalingI18n.useT();
  const st = proposalStatusMeta(proposal.status);
  const pending = proposal.status === "pending";
  return (
    <article className={cn("glass-panel flex flex-col gap-2 rounded-xl p-3", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {onOpenTrader ? (
            <button type="button" className="text-sm font-semibold text-foreground hover:underline" onClick={() => onOpenTrader(proposal.trader)}>
              {personName(proposal.trader)}
            </button>
          ) : (
            <span className="text-sm font-semibold text-foreground">{personName(proposal.trader)}</span>
          )}
          <Pill tone={ACTION_TONE[proposal.action]} dot>{actionLabel(proposal.action)}</Pill>
          <span className="text-xs text-muted-foreground">{tierName(tiers, proposal.fromTier)}</span>
          <span className="text-xs text-muted-foreground" aria-hidden="true">→</span>
          <Pill tone="purple">{tierName(tiers, proposal.toTier)}</Pill>
          {!pending && <Pill tone={st.tone}>{st.label}</Pill>}
        </div>
        {pending && canDecide && (
          <div className="flex items-center gap-1.5">
            <DecisionPopover decision="reject" proposal={proposal} tiers={tiers} />
            <DecisionPopover decision="approve" proposal={proposal} tiers={tiers} />
          </div>
        )}
        {pending && !canDecide && <Pill tone="warn">{st.label}</Pill>}
      </div>
      {proposal.reasons.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          {proposal.reasons.map((r, i) => <li key={i} className="break-words">• {r}</li>)}
        </ul>
      )}
      <div className="flex flex-wrap gap-x-3 text-2xs text-muted-foreground">
        <span>{proposal.source === "auto" ? t("proposal.byRules") : t("proposal.manual")} · {personName(proposal.createdBy)} · {fmtDate(proposal.createdAt, "dateTime")}</span>
        {proposal.decidedBy && <span>{t("proposal.decidedBy", { name: personName(proposal.decidedBy) })} · {fmtDate(proposal.decidedAt, "dateTime")}</span>}
        {proposal.decisionComment && <span className="basis-full break-words text-foreground/80">{t("proposal.quoted", { text: proposal.decisionComment })}</span>}
      </div>
    </article>
  );
}
