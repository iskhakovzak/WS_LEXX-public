import { useState } from "react";
import { Link } from "wouter";
import { ArrowUpRight, Pencil, Power, Trash2 } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ToastAction } from "@/components/ui/toast";
import { Pill, StatGrid } from "@/components/ds";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { links } from "@/lib/links";
import { nyDate } from "@/lib/trading-date";
import { useSelfChecks } from "./api";
import { http } from "@/lib/api/http";
import { humanizeApiError } from "@/lib/api/errors";
import { ORIGIN_LABEL, originOf, severityMeta } from "./constants";
import { fmtDate, fmtRate, fmtUsd } from "@/lib/format";
import { SelfMarkButtons } from "./RulesOverview";
import { commonI18n } from "@/i18n/ns/common";
import { rulesI18n } from "@/i18n/ns/rules";
import { personName } from "@/i18n";
import { rich } from "./rich";
import type { RuleReport, SideStats } from "./types";

export function RuleDetailSheet({
  rule,
  open,
  onOpenChange,
  trader,
  canMark,
  onEdit,
  onChanged,
}: {
  rule: RuleReport | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  trader: string;
  canMark: boolean;
  onEdit: (r: RuleReport) => void;
  onChanged: () => void;
}) {
  const { t } = rulesI18n.useT();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"disable" | "delete" | null>(null);
  const today = nyDate();
  const selfQ = useSelfChecks(trader, today, open && !!rule && !rule.auto && rule.enabled);
  if (!rule) return null;
  const r = rule;
  const origin = originOf(r);
  const o = ORIGIN_LABEL[origin];
  const editable = r.canEdit !== false;
  const mark = selfQ.data?.marks.find((m) => m.ruleId === r.id);
  const perTrade = !!r.auto;
  const errorTitle = commonI18n.t("states.error");

  async function toggle() {
    setBusy(true);
    try {
      await http.patch(`/api/rules/${r.id}`, { enabled: !r.enabled });
      toast({
        title: r.enabled ? t("detail.toastDisabled") : t("detail.toastEnabled"),
        description: r.enabled ? t("detail.toastDisabledHint") : undefined,
      });
      onChanged();
    } catch (e) {
      toast({ title: errorTitle, description: humanizeApiError(e, t("detail.changeFailed")), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await http.del(`/api/rules/${r.id}`);
      onOpenChange(false);
      onChanged();
      toast({
        title: t("detail.deleted"),
        description: t("detail.deletedHint", { name: r.name }),
        action: (
          <ToastAction
            altText={t("detail.restoreAlt")}
            onClick={async () => {
              try {
                await http.post(`/api/rules/${r.id}/restore`);
                onChanged();
              } catch (e) {
                toast({ title: errorTitle, description: humanizeApiError(e, t("detail.restoreFailed")), variant: "destructive" });
              }
            }}
          >
            {commonI18n.t("actions.restore")}
          </ToastAction>
        ),
      });
    } catch (e) {
      toast({ title: errorTitle, description: humanizeApiError(e, t("detail.deleteFailed")), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const weekly = r.weekly.filter((w) => w.days > 0);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-5 sm:max-w-xl">
        <SheetHeader className="pr-10 text-left">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={o.tone} title={o.hint}>{o.label}</Pill>
            <span className="text-xs text-muted-foreground">{r.kindLabel}</span>
            {!r.enabled && <Pill>{t("row.disabled")}</Pill>}
          </div>
          <SheetTitle className="text-lg leading-snug">{r.name}</SheetTitle>
          <SheetDescription>{[r.summary, r.createdBy && origin !== "personal" ? t("detail.setBy", { name: personName(r.createdBy) }) : null].filter(Boolean).join(" · ")}</SheetDescription>
          {r.note && <p className="text-sm italic text-muted-foreground">«{r.note}»</p>}
        </SheetHeader>

        {!r.auto && r.enabled && canMark && (
          <section className="tile flex flex-wrap items-center justify-between gap-3 p-3">
            <div>
              <p className="text-sm font-medium text-foreground">{t("detail.today", { date: fmtDate(today, "dayMonth") })}</p>
              <p className="text-xs text-muted-foreground">{t("detail.todayHint")}</p>
            </div>
            <SelfMarkButtons ruleId={r.id} trader={trader} day={today} mark={mark} size="md" />
          </section>
        )}

        {r.status === "disabled" ? (
          <p className="text-sm text-muted-foreground">
            {t("detail.disabledText")}
            {r.archivedViolations ? (
              <> {rich(t("detail.archivedKept", { count: "{count}" }), { count: <b className="tabular-nums text-foreground">{r.archivedViolations}</b> })}</>
            ) : null}
          </p>
        ) : r.status === "no_data" ? (
          <p className="tile p-3 text-sm text-muted-foreground">
            {t("detail.noData")}
          </p>
        ) : (
          <>
            <StatGrid min="9rem">
              <Metric label={t("detail.compliance")} value={fmtRate(r.compliance)} hint={t("detail.daysOf", { kept: r.days - r.violatedDays, days: r.days })} />
              <Metric label={t("detail.violations")} value={String(r.violations)} hint={r.lastViolation ? t("preview.last", { date: fmtDate(r.lastViolation, "dayMonth") }) : t("detail.none")} />
              {r.auto ? (
                <Metric
                  label={r.impact != null && r.impact > 0 ? t("detail.paidOff") : t("detail.costsYou")}
                  value={r.impact == null ? "—" : fmtUsd(r.impact, { signed: true, decimals: "trim" })}
                  valueClass={r.impact == null || r.impact === 0 ? "" : r.impact < 0 ? "text-down" : "text-up"}
                  hint={t("detail.impactHint")}
                />
              ) : (
                <Metric label={t("detail.cleanStreak")} value={String(r.cleanStreak)} hint={r.unmarkedDays ? t("detail.unmarked", { count: r.unmarkedDays }) : t("detail.allMarked")} />
              )}
            </StatGrid>

            {r.broken.n > 0 && r.clean.n > 0 && (
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-foreground">{perTrade ? t("detail.compareTrade") : t("detail.compareDay")}</h3>
                <CompareBars broken={r.broken} clean={r.clean} perTrade={perTrade} />
              </section>
            )}

            {weekly.length > 1 && (
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-foreground">{t("detail.weekly")}</h3>
                <div className="flex h-24 items-end gap-1" role="img" aria-label={t("detail.weekly")}>
                  {weekly.map((w) => {
                    const c = w.compliance ?? 0;
                    return (
                      <div key={w.week} className="flex min-w-0 flex-1 flex-col items-center gap-1" title={t("detail.weekTitle", { date: fmtDate(w.week, "dayMonth"), rate: fmtRate(w.compliance), count: w.violations })}>
                        <div className="flex h-20 w-full items-end rounded-md bg-[var(--glass-bg)]">
                          <div className={cn("w-full rounded-md", c >= 0.9 ? "bg-primary" : c >= 0.7 ? "bg-primary/60" : "bg-warn")} style={{ height: `${Math.max(4, c * 100)}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{fmtDate(weekly[0].week, "dayMonth")}</span>
                  <span>{fmtDate(weekly[weekly.length - 1].week, "dayMonth")}</span>
                </div>
              </section>
            )}

            {r.examples.length > 0 && (
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-foreground">{r.auto ? t("detail.examplesAuto") : t("detail.examplesSelf")}</h3>
                <ul className="flex flex-col divide-y divide-[var(--glass-border)]">
                  {r.examples.map((ex) => (
                    <li key={ex.key} className="flex items-center gap-3 py-2">
                      <span className={cn("h-2 w-2 shrink-0 rounded-full", severityMeta(ex.severity).bar)} aria-hidden="true" title={severityMeta(ex.severity).label} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-foreground">
                          {ex.ticker && <span className="font-medium">{ex.ticker} · </span>}
                          {ex.message}
                        </p>
                        <p className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                          <span>{fmtDate(ex.day, "dayMonth")}</span>
                          {ex.tradeId != null && (
                            <Link href={links.trade(ex.tradeId)} className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline">
                              {t("detail.trade")} <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                            </Link>
                          )}
                          <Link href={links.dayReport(ex.day, trader)} className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline">
                            {t("day.dayReport")} <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                          </Link>
                        </p>
                      </div>
                      {ex.net != null && (
                        <span className={cn("shrink-0 text-sm font-medium tabular-nums", ex.net < 0 ? "text-down" : ex.net > 0 ? "text-up" : "text-foreground")}>{fmtUsd(ex.net, { signed: true, decimals: "trim" })}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}

        <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-[var(--glass-border)] pt-4">
          {editable ? (
            <>
              <Button variant="outline" size="sm" onClick={() => onEdit(r)} disabled={busy}><Pencil /> {commonI18n.t("actions.edit")}</Button>
              <Button variant="outline" size="sm" onClick={() => (r.enabled ? setConfirm("disable") : toggle())} disabled={busy}><Power /> {r.enabled ? t("detail.disable") : t("detail.enable")}</Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirm("delete")} disabled={busy} className="ml-auto text-muted-foreground hover:text-down"><Trash2 /> {commonI18n.t("actions.delete")}</Button>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">{t("detail.officeLocked")}</p>
          )}
        </div>

        <AlertDialog open={confirm != null} onOpenChange={(v) => { if (!v) setConfirm(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{confirm === "delete" ? t("detail.confirmDeleteTitle") : t("detail.confirmDisableTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {confirm === "delete" ? t("detail.confirmDelete", { name: r.name }) : t("detail.confirmDisable", { name: r.name })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{commonI18n.t("actions.cancel")}</AlertDialogCancel>
              <AlertDialogAction
                className={confirm === "delete" ? buttonVariants({ variant: "destructive" }) : undefined}
                onClick={() => {
                  const what = confirm;
                  setConfirm(null);
                  if (what === "delete") void remove();
                  else if (what === "disable") void toggle();
                }}
              >
                {confirm === "delete" ? commonI18n.t("actions.delete") : t("detail.disable")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SheetContent>
    </Sheet>
  );
}

function Metric({ label, value, hint, valueClass }: { label: string; value: string; hint?: string; valueClass?: string }) {
  return (
    <div className="tile flex min-w-0 flex-col gap-0.5 p-3">
      <span className="truncate text-xs text-muted-foreground" title={label}>{label}</span>
      <span className={cn("truncate text-xl font-semibold tabular-nums text-foreground", valueClass)}>{value}</span>
      {hint && <span className="line-clamp-2 text-xs text-muted-foreground" title={hint}>{hint}</span>}
    </div>
  );
}

function CompareBars({ broken, clean, perTrade }: { broken: SideStats; clean: SideStats; perTrade: boolean }) {
  const { t } = rulesI18n.useT();
  const max = Math.max(Math.abs(broken.avg ?? 0), Math.abs(clean.avg ?? 0)) || 1;
  const row = (label: string, s: SideStats) => {
    const v = s.avg ?? 0;
    return (
      <div className="grid grid-cols-[148px_1fr_84px] items-center gap-2 text-xs">
        <span className="text-muted-foreground">{label} <span className="tabular-nums">({s.n})</span></span>
        <div className="relative h-3 rounded-full bg-[var(--glass-bg)]">
          <div className="absolute inset-y-0 left-1/2 w-px bg-[var(--glass-border)]" aria-hidden="true" />
          <div
            className={cn("absolute inset-y-0 rounded-full", v < 0 ? "bg-down" : "bg-up")}
            style={v < 0 ? { right: "50%", width: `${(Math.abs(v) / max) * 50}%` } : { left: "50%", width: `${(v / max) * 50}%` }}
          />
        </div>
        <span className={cn("text-right font-medium tabular-nums", v < 0 ? "text-down" : v > 0 ? "text-up" : "text-foreground")}>{fmtUsd(s.avg, { signed: true, decimals: "trim" })}</span>
      </div>
    );
  };
  return (
    <div className="flex flex-col gap-1.5">
      {row(t("detail.withViolation"), broken)}
      {row(t("detail.withoutViolation"), clean)}
      <span className="text-xs text-muted-foreground">{perTrade ? t("detail.compareFootTrade") : t("detail.compareFootDay")}</span>
    </div>
  );
}
