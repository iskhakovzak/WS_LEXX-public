import * as React from "react";
import { Target } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { QueryState } from "@/components/ds";
import { useToast } from "@/hooks/use-toast";
import { addDays, nyDate } from "@/lib/trading-date";
import { curatorApi, useCuratorMutation, useIdpMetrics } from "./api";
import { curatorI18n } from "@/i18n/ns/curator";
import { personName } from "@/i18n";
import { commonI18n } from "@/i18n/ns/common";

/** «Назначить цель»: an IDP goal through the Academy API (POST /api/academy/idp) — progress is tracked there. */
export function GoalDialog({ open, onOpenChange, trader, presetTitle }: { open: boolean; onOpenChange: (v: boolean) => void; trader: string; presetTitle?: string }) {
  const { toast } = useToast();
  const { t } = curatorI18n.useT();
  const tc = commonI18n.useT().t;
  const q = useIdpMetrics(open);
  const [metric, setMetric] = React.useState("journal_days");
  const [title, setTitle] = React.useState("");
  const [target, setTarget] = React.useState("");
  const [windowN, setWindowN] = React.useState("");
  const [dueOn, setDueOn] = React.useState(addDays(nyDate(), 14));
  const def = q.data?.metrics.find((m) => m.key === metric) ?? null;

  React.useEffect(() => {
    if (!open) return;
    setTitle(presetTitle ?? "");
    setDueOn(addDays(nyDate(), 14));
  }, [open, presetTitle]);
  React.useEffect(() => {
    if (!def) return;
    setTarget(String(def.defaultTarget));
    setWindowN(def.defaultWindow != null ? String(def.defaultWindow) : "");
    setTitle((t) => (t.trim() ? t : def.example.charAt(0).toUpperCase() + def.example.slice(1)));
  }, [def?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCuratorMutation(() => curatorApi.addGoal({
    student: trader,
    title: title.trim(),
    metric,
    target: target === "" ? undefined : Number(target),
    window: def && (def.windowKind === "days" || def.windowKind === "trades") && windowN ? Number(windowN) : undefined,
    dueOn: dueOn || null,
  }));
  const valid = title.trim().length >= 2 && (target === "" || Number.isFinite(Number(target)));
  const submit = () => {
    if (!valid || save.isPending) return;
    save.mutate(undefined, {
      onSuccess: () => { toast({ title: t("goal.assigned"), description: t("goal.assignedHint", { name: personName(trader) }) }); onOpenChange(false); },
      onError: (e) => toast({ title: t("goal.failed"), description: (e as Error).message, variant: "destructive" }),
    });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!save.isPending) onOpenChange(v); }}>
      <DialogContent className="sm:max-w-lg">
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Target className="h-4 w-4 text-primary" aria-hidden="true" />{t("goal.title", { name: personName(trader) })}</DialogTitle>
            <DialogDescription>{t("goal.hint")}</DialogDescription>
          </DialogHeader>
          <QueryState query={q} skeleton={<div className="h-40" />}>
            {(data) => (
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2 flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">{t("goal.metric")}</Label>
                  <Select value={metric} onValueChange={setMetric}>
                    <SelectTrigger aria-label={t("goal.metric")}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {data.metrics.map((m) => <SelectItem key={m.key} value={m.key}>{m.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {def && <p className="text-xs text-muted-foreground">{def.description}</p>}
                </div>
                <div className="col-span-2 flex flex-col gap-1.5">
                  <Label htmlFor="goal-title" className="text-xs text-muted-foreground">{t("goal.wording")}</Label>
                  <Input id="goal-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} placeholder={t("goal.wordingPlaceholder")} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="goal-target" className="text-xs text-muted-foreground">{def ? t("goal.targetUnit", { unit: def.unit }) : t("goal.target")}</Label>
                  <Input id="goal-target" type="number" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} className="tabular-nums" />
                </div>
                {def && (def.windowKind === "days" || def.windowKind === "trades") ? (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="goal-window" className="text-xs text-muted-foreground">{def.windowKind === "days" ? t("goal.windowDays") : t("goal.windowTrades")}</Label>
                    <Input id="goal-window" type="number" min={1} value={windowN} onChange={(e) => setWindowN(e.target.value)} className="tabular-nums" />
                  </div>
                ) : <div />}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="goal-due" className="text-xs text-muted-foreground">{t("goal.due")}</Label>
                  <Input id="goal-due" type="date" value={dueOn} min={nyDate()} onChange={(e) => setDueOn(e.target.value)} className="tabular-nums" />
                </div>
              </div>
            )}
          </QueryState>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={save.isPending}>{tc("actions.cancel")}</Button>
            <Button type="submit" disabled={!valid || save.isPending || !q.data}>{save.isPending ? t("saving") : t("goal.assign")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
