import * as React from "react";
import { ArrowUpRight, ArrowDownRight, Flag, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import type { Tier, TraderEval } from "./use-scaling";
import { useAssignTier, useCreateProposal } from "./use-scaling";
import { actionLabel, actionVerb, tierLabel } from "./format";
import { commonI18n } from "@/i18n/ns/common";
import { scalingI18n } from "@/i18n/ns/scaling";
import { personName } from "@/i18n";

/** «Предложить» — turns the current recommendation into a proposal (curator). */
export function ProposeButton({ row, size = "sm" }: { row: TraderEval; size?: "sm" | "default" }) {
  const { toast } = useToast();
  const create = useCreateProposal();
  const { t } = scalingI18n.useT();
  const a = row.recommendation.action;
  if (row.pendingProposal || a === "hold" || a === "assign" || !row.recommendation.toTier) return null;
  const Icon = a === "promote" ? ArrowUpRight : ArrowDownRight;
  const submit = async () => {
    try {
      await create.mutateAsync({ trader: row.trader });
      toast({ title: t("curator.created", { trader: personName(row.trader) }), description: `${actionLabel(a)} → ${(row.recommendation.toTier ? tierLabel(row.recommendation.toTier) : "")}` });
    } catch (e) {
      toast({ title: t("curator.createFailed"), description: (e as Error).message, variant: "destructive" });
    }
  };
  return (
    <Button size={size} variant={a === "promote" ? "default" : "outline"} onClick={submit} disabled={create.isPending} aria-label={t("curator.actionAria", { action: actionVerb(a), trader: personName(row.trader) })}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {actionVerb(a)}
    </Button>
  );
}

/**
 * «Назначить тир» — direct assignment or a manual proposal to any tier, with a comment.
 * `mode="assign"` writes limits immediately (initial setup); `mode="propose"` goes through the approval queue.
 */
export function TierPopover({
  row,
  tiers,
  mode,
  size = "sm",
  variant = "outline",
}: {
  row: TraderEval;
  tiers: Tier[];
  mode: "assign" | "propose";
  size?: "sm" | "default";
  variant?: "outline" | "ghost" | "default";
}) {
  const [open, setOpen] = React.useState(false);
  const [tierKey, setTierKey] = React.useState<string>(row.recommendation.toTier?.key ?? row.nextTier?.key ?? tiers[0]?.key ?? "");
  const [comment, setComment] = React.useState("");
  const { toast } = useToast();
  const { t } = scalingI18n.useT();
  const { t: tc } = commonI18n.useT();
  const assign = useAssignTier();
  const create = useCreateProposal();
  const busy = assign.isPending || create.isPending;
  React.useEffect(() => {
    if (open) setTierKey(row.recommendation.toTier?.key ?? row.nextTier?.key ?? tiers[0]?.key ?? "");
  }, [open, row, tiers]);

  const submit = async () => {
    if (!tierKey) return;
    try {
      if (mode === "assign") {
        await assign.mutateAsync({ trader: row.trader, tierKey, comment: comment.trim() || undefined });
        toast({ title: t("curator.assigned", { trader: personName(row.trader) }), description: t("curator.assignedHint") });
      } else {
        await create.mutateAsync({ trader: row.trader, toTier: tierKey, comment: comment.trim() || undefined });
        toast({ title: t("curator.created", { trader: personName(row.trader) }) });
      }
      setOpen(false);
      setComment("");
    } catch (e) {
      toast({ title: tc("states.saveFailed"), description: (e as Error).message, variant: "destructive" });
    }
  };
  const label = mode === "assign" ? t("curator.assignTier") : t("curator.proposeTier");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size={size} variant={variant} aria-label={t("curator.actionAria", { action: label, trader: personName(row.trader) })}>
          {mode === "assign" ? <Flag className="h-3.5 w-3.5" aria-hidden="true" /> : <Send className="h-3.5 w-3.5" aria-hidden="true" />}
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="flex flex-col gap-3">
          <div>
            <p className="text-sm font-semibold text-foreground">{t("curator.actionAria", { action: label, trader: personName(row.trader) })}</p>
            <p className="text-xs text-muted-foreground">
              {mode === "assign" ? t("curator.assignHint") : t("curator.proposeHint")}
            </p>
          </div>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {tc("tiers.tier")}
            <Select value={tierKey} onValueChange={setTierKey}>
              <SelectTrigger aria-label={tc("tiers.tier")}><SelectValue placeholder={t("curator.pickTier")} /></SelectTrigger>
              <SelectContent>
                {tiers.map((x) => (
                  <SelectItem key={x.key} value={x.key} disabled={x.key === row.tierKey}>
                    {x.key === row.tierKey ? t("curator.tierCurrent", { name: tierLabel(x) }) : tierLabel(x)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {tc("fields.comment")}
            <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} maxLength={2000} placeholder={t("curator.why")} />
          </label>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>{tc("actions.cancel")}</Button>
            <Button size="sm" onClick={submit} disabled={busy || !tierKey || tierKey === row.tierKey}>{busy ? tc("states.saving") : mode === "assign" ? actionVerb("assign") : t("curator.propose")}</Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
