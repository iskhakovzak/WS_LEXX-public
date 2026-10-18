import * as React from "react";
import { Crosshair, RefreshCw } from "lucide-react";
import { Panel, Pill, type Tone } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { fmtDate, fmtUsd } from "@/lib/format";
import { PICKABLE_MISTAKES, mistakeLabel } from "@/components/shared/mistake-labels";
import type { MistakeId, VerdictStatus } from "@/lib/daily/types";
import { curatorI18n } from "@/i18n/ns/curator";
import { commonI18n } from "@/i18n/ns/common";
import { personName } from "@/i18n";
import { NotAvailableError, curatorApi, useCuratorMutation, type CuratorFocus } from "./api";

const STATUS_TONE: Record<VerdictStatus, Tone> = { kept: "up", broken: "down", no_trades: "neutral", unknown: "neutral" };
const HISTORY_VISIBLE = 10;

/** The trader's daily focus in the curator profile: the focus in force, day-by-day verdicts, replace it (curator override). */
export function FocusPanel({ trader, focus }: { trader: string; focus: CuratorFocus }) {
  const { t } = curatorI18n.useT();
  const [open, setOpen] = React.useState(false);
  const cur = focus.current;
  return (
    <Panel
      title={t("focus.title")}
      icon={Crosshair}
      description={t("focus.hint")}
      actions={<Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}><RefreshCw className="h-3.5 w-3.5" /> {t("focus.replace")}</Button>}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <span className="micro-label">{t("focus.current", { date: fmtDate(cur?.date ?? focus.date, "dayMonth") })}</span>
          {cur?.mistake ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-base font-semibold text-foreground">{mistakeLabel(cur.mistake)}</span>
              <Pill tone={cur.source === "curator" ? "purple" : "neutral"}>{cur.source === "curator" ? t("focus.fromCurator") : t("focus.auto")}</Pill>
              {cur.costNet != null && cur.costNet < 0 && <span className="text-sm tabular-nums text-down">{t("focus.cost", { cost: fmtUsd(cur.costNet, { decimals: 0 }) })}</span>}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{cur?.source === "none" ? t("focus.none") : t("focus.notReady")}</p>
          )}
        </div>
        <FocusHistory focus={focus} />
      </div>
      <ReplaceFocusDialog open={open} onOpenChange={setOpen} trader={trader} focus={focus} />
    </Panel>
  );
}

function FocusHistory({ focus }: { focus: CuratorFocus }) {
  const { t } = curatorI18n.useT();
  const days = focus.history.filter((d) => d.focus).slice(0, HISTORY_VISIBLE);
  return (
    <div className="flex flex-col gap-1.5">
      <span className="micro-label">{t("focus.history")}</span>
      {days.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("focus.historyEmpty")}</p>
      ) : (
        <ul className="flex flex-col" aria-label={t("focus.historyAria")}>
          {days.map((d) => {
            const v = d.focus!;
            return (
              <li key={d.date} className="flex min-w-0 items-center gap-2 border-b border-border/50 py-1.5 text-sm last:border-b-0">
                <span className="w-14 shrink-0 tabular-nums text-muted-foreground">{fmtDate(d.date, "dayMonth")}</span>
                <span className="min-w-0 flex-1 truncate text-foreground" title={mistakeLabel(v.mistake)}>{mistakeLabel(v.mistake)}</span>
                {v.disputed && <Pill tone="purple">{t("focus.disputed")}</Pill>}
                <Pill tone={STATUS_TONE[v.status]} dot={v.status === "broken"}>{t(`focus.status.${v.status}`)}</Pill>
                <span className={cn("w-16 shrink-0 text-right tabular-nums", (v.costNet ?? 0) < 0 ? "text-down" : "text-muted-foreground")}>
                  {v.costNet != null && v.costNet < 0 ? fmtUsd(v.costNet, { decimals: 0 }) : "—"}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Pick from the trader's costliest mistakes of the window (prefilled with the top one); other kinds in a list below. */
function ReplaceFocusDialog({ open, onOpenChange, trader, focus }: { open: boolean; onOpenChange: (v: boolean) => void; trader: string; focus: CuratorFocus }) {
  const { t } = curatorI18n.useT();
  const tc = commonI18n.useT().t;
  const { toast } = useToast();
  const costly = focus.options.filter((o) => o.id !== focus.current?.mistake);
  const others = PICKABLE_MISTAKES.filter((m) => !costly.some((o) => o.id === m.id) && m.id !== focus.current?.mistake);
  const [pick, setPick] = React.useState<MistakeId | null>(null);
  React.useEffect(() => { if (open) setPick(costly[0]?.id ?? null); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useCuratorMutation((mistake: MistakeId) => curatorApi.setFocus(trader, focus.date, mistake));
  const submit = () => {
    if (!pick || save.isPending) return;
    save.mutate(pick, {
      onSuccess: () => { onOpenChange(false); toast({ title: t("focus.saved") }); },
      onError: (e) => toast({
        title: t("focus.saveFailed"),
        description: e instanceof NotAvailableError ? t("focus.notConnected") : (e as Error).message,
        variant: "destructive",
      }),
    });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("focus.replaceTitle", { name: personName(trader), date: fmtDate(focus.date, "dayMonth") })}</DialogTitle>
          <DialogDescription>{t("focus.replaceHint")}</DialogDescription>
        </DialogHeader>
        {costly.length > 0 && (
          <div className="flex flex-col gap-1.5" role="radiogroup" aria-label={t("focus.costliest", { from: fmtDate(focus.window.from, "dayMonth"), to: fmtDate(focus.window.to, "dayMonth") })}>
            <span className="micro-label">{t("focus.costliest", { from: fmtDate(focus.window.from, "dayMonth"), to: fmtDate(focus.window.to, "dayMonth") })}</span>
            {costly.map((o) => (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={pick === o.id}
                onClick={() => setPick(o.id)}
                className={cn("tile flex items-center gap-2 px-3 py-2 text-left text-sm", pick === o.id && "ring-2 ring-primary")}
              >
                <span className="min-w-0 flex-1 truncate text-foreground">{mistakeLabel(o.id)}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{`×${o.count}`}</span>
                <span className="w-16 shrink-0 text-right tabular-nums text-down">{o.costNet != null ? fmtUsd(o.costNet, { decimals: 0 }) : "—"}</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <span className="micro-label">{t("focus.other")}</span>
          <Select value={pick && others.some((m) => m.id === pick) ? pick : ""} onValueChange={(v) => setPick(v)}>
            <SelectTrigger aria-label={t("focus.other")}><SelectValue placeholder={t("focus.other")} /></SelectTrigger>
            <SelectContent>
              {others.map((m) => <SelectItem key={m.id} value={m.id}>{mistakeLabel(m.id)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{tc("actions.cancel")}</Button>
          <Button type="button" onClick={submit} disabled={!pick || save.isPending}>{save.isPending ? t("saving") : t("focus.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
