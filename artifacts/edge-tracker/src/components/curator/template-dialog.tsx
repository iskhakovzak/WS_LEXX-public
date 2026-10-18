import * as React from "react";
import { Layers } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pill, QueryState, Segmented } from "@/components/ds";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { curatorApi, useCuratorMutation, useRiskTemplates, type TierTemplate } from "./api";
import { fmtUsd } from "@/lib/format";
import { curatorI18n } from "@/i18n/ns/curator";
import { personName } from "@/i18n";
import { commonI18n } from "@/i18n/ns/common";

const LADDER = ["trainee", "junior", "trader", "senior"];

const fmt = (v: number | boolean | null | undefined, field: string) => {
  if (v == null) return "—";
  if (typeof v === "boolean") return v ? curatorI18n.t("template.yes") : curatorI18n.t("template.no");
  return field === "maxOpenPositions" ? String(v) : fmtUsd(v, { decimals: 0 });
};

const TEMPLATE_FIELDS = ["dailyLossLimit", "weeklyLossLimit", "maxDrawdown", "maxRiskPerTrade", "maxPositionUsd", "maxOpenPositions",
  "maxOvernightExposure", "allowOvernight", "allowSwing"] as const satisfies readonly (keyof TierTemplate)[];
/** Rows with labels in the current language (call in render). */
const templateRows = () => TEMPLATE_FIELDS.map((field) => ({ field, label: curatorI18n.t(`template.rows.${field}`) }));

/**
 * «Применить шаблон тира»: one action sets every limit of the selected traders to the tier template
 * (Стажёр / Джун / Трейдер / Сеньор). Server: POST /api/risk/templates/apply — change log + audit + notification.
 */
export function TemplateDialog({
  open, onOpenChange, traders, defaultTier,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  traders: string[];
  defaultTier?: string | null;
}) {
  const { toast } = useToast();
  const { t } = curatorI18n.useT();
  const tc = commonI18n.useT().t;
  const TEMPLATE_ROWS = templateRows();
  const q = useRiskTemplates(open);
  const tiers = React.useMemo(() => (q.data?.tiers ?? []).filter((t) => LADDER.includes(t.key) || t.key === defaultTier), [q.data, defaultTier]);
  const [tierKey, setTierKey] = React.useState<string>(defaultTier ?? "trainee");
  const [reason, setReason] = React.useState("");
  React.useEffect(() => { if (open) { setTierKey(defaultTier && LADDER.includes(defaultTier) ? defaultTier : "trainee"); setReason(""); } }, [open, defaultTier]);
  const tier = tiers.find((t) => t.key === tierKey) ?? null;
  const rows = (q.data?.traders ?? []).filter((t) => traders.includes(t.trader));
  const apply = useCuratorMutation((v: { tierKey: string; reason: string }) =>
    curatorApi.applyTemplate(traders.map((trader) => ({ trader, tierKey: v.tierKey })), v.reason.trim() || null));

  const submit = () => {
    if (!tier || !traders.length || apply.isPending) return;
    apply.mutate({ tierKey: tier.key, reason }, {
      onSuccess: (r) => {
        const failed = r.results.filter((x) => !x.ok);
        toast({
          title: r.applied ? t("template.applied", { name: tier.name, count: r.applied }) : t("template.notApplied"),
          description: failed.length ? failed.map((f) => `${personName(f.trader)}: ${f.error}`).join("; ") : t("template.notified"),
          variant: r.applied ? undefined : "destructive",
        });
        if (r.applied) onOpenChange(false);
      },
      onError: (e) => toast({ title: t("template.applyFailed"), description: (e as Error).message, variant: "destructive" }),
    });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!apply.isPending) onOpenChange(v); }}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Layers className="h-4 w-4 text-primary" aria-hidden="true" />{t("template.title")}</DialogTitle>
          <DialogDescription>
            {traders.length === 1 ? t("template.descOne", { name: personName(traders[0]) }) : t("template.descMany", { count: traders.length })} {t("template.descTail")}
          </DialogDescription>
        </DialogHeader>
        <QueryState query={q} skeleton={<div className="h-48" />}>
          {() => !q.data?.canEdit ? (
            <p className="text-sm text-muted-foreground">{t("template.noRight")}</p>
          ) : (
            <div className="flex flex-col gap-4">
              <Segmented ariaLabel={t("template.tierAria")} value={tierKey} onChange={setTierKey} options={tiers.map((t) => ({ value: t.key, label: t.stageLabel ?? t.name }))} />
              {tier && (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_1.2fr]">
                  <dl className="tile grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 p-3 text-sm">
                    {TEMPLATE_ROWS.map((r) => (
                      <React.Fragment key={r.field}>
                        <dt className="text-muted-foreground">{r.label}</dt>
                        <dd className="text-right tabular-nums text-foreground">{fmt(tier[r.field] as number | boolean | null, r.field)}</dd>
                      </React.Fragment>
                    ))}
                    {tier.description && <dd className="col-span-2 mt-1 text-xs text-muted-foreground">{tier.description}</dd>}
                  </dl>
                  <div className="flex min-w-0 flex-col gap-2">
                    <span className="text-xs font-medium text-muted-foreground">{t("template.whatChanges")}</span>
                    <ul className="flex max-h-[50dvh] flex-col gap-1.5 overflow-auto pr-1">
                      {traders.map((name) => {
                        const row = rows.find((r) => r.trader === name);
                        const cur = row?.limits ?? null;
                        const changed = TEMPLATE_ROWS.filter((r) => {
                          const a = cur ? (cur as unknown as Record<string, unknown>)[r.field] : null;
                          const b = tier[r.field];
                          return typeof b === "boolean" ? (cur ? a !== b : true) : Math.abs(Number(a ?? NaN) - Number(b ?? NaN)) > 0.004 || (a == null) !== (b == null);
                        });
                        return (
                          <li key={name} className="tile flex flex-col gap-1 p-2.5">
                            <div className="flex items-center gap-2 text-sm">
                              <span className="font-medium text-foreground">{personName(name)}</span>
                              <span className="text-xs text-muted-foreground">{row?.tierName ?? t("template.noTier")}{row?.tier && row.tier !== tier.key ? ` → ${tier.stageLabel ?? tier.name}` : ""}</span>
                              <span className="ml-auto">{!cur ? <Pill tone="warn">{t("template.noLimits")}</Pill> : changed.length ? <Pill tone="accent">{t("template.changes", { count: changed.length })}</Pill> : <Pill tone="up">{t("template.matches")}</Pill>}</span>
                            </div>
                            {cur && changed.length > 0 && (
                              <p className="text-xs tabular-nums text-muted-foreground">
                                {changed.map((r) => `${r.label}: ${fmt((cur as unknown as Record<string, number | boolean | null>)[r.field], r.field)} → ${fmt(tier[r.field] as number | boolean | null, r.field)}`).join(" · ")}
                              </p>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </div>
              )}
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("template.reasonPlaceholder")} maxLength={500} aria-label={t("template.reasonAria")} />
            </div>
          )}
        </QueryState>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={apply.isPending}>{tc("actions.cancel")}</Button>
          <Button type="button" onClick={submit} disabled={!tier || !q.data?.canEdit || apply.isPending} className={cn(!traders.length && "opacity-50")}>
            {apply.isPending ? t("template.applying") : traders.length > 1 ? t("template.applyTo", { count: traders.length }) : t("template.apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
