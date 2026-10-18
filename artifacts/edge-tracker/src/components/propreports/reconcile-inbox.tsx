/**
 * Reconciliation inbox: broker round trips that collide with a manual journal entry
 * (same trader + ticker + date + side, no external id). Curator merges or keeps separate; nothing merges silently.
 */
import * as React from "react";
import { GitMerge, Inbox, Loader2, Split, Trash2 } from "lucide-react";
import { EmptyState, Panel, Pill, StatRow } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { fmtPrice, horizonLabel, resultLabel, useDismissPending, useKeepSeparate, useMerge, type ManualCandidate, type PendingTrade } from "./api";
import { fmtDate, fmtUsd } from "@/lib/format";
import { propreportsI18n } from "@/i18n/ns/propreports";
import { commonI18n } from "@/i18n/ns/common";
import { personName } from "@/i18n";
import { ExecutionsList, FeesBreakdown, resultTone } from "./preview-table";

function Side({ title, tone, children }: { title: React.ReactNode; tone: "accent" | "neutral"; children: React.ReactNode }) {
  return (
    <div className={cn("rounded-xl border p-3", tone === "accent" ? "border-primary/40 bg-primary/5" : "border-[var(--glass-border)]")}>
      <div className="mb-2 text-xs font-medium text-muted-foreground">{title}</div>
      <div className="grid gap-1">{children}</div>
    </div>
  );
}

function Candidate({ c, selected, onSelect }: { c: ManualCandidate; selected: boolean; onSelect: () => void }) {
  const { t } = propreportsI18n.useT();
  const net = c.pnl != null ? c.pnl - (c.fees ?? 0) : null;
  return (
    <button type="button" onClick={onSelect} className={cn("w-full rounded-lg border p-2 text-left text-xs transition-colors", selected ? "border-primary bg-primary/10" : "border-[var(--glass-border)] hover:bg-[var(--glass-bg)]")} aria-pressed={selected}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">#{c.id}</span>
        <span>{c.ticker} {c.side ?? ""}</span>
        <Pill tone={c.result === "win" ? "up" : c.result === "loss" ? "down" : "neutral"}>{resultLabel(c.result)}</Pill>
        {c.setup && <span className="text-muted-foreground">{c.setup}</span>}
        {c.playbookId != null && <Pill tone="purple">{t("inbox.playbook", { id: c.playbookId })}</Pill>}
      </div>
      <div className="mt-1 grid grid-cols-4 gap-x-2 text-muted-foreground">
        <span>{t("inbox.cEntry", { value: fmtPrice(c.entry) })}</span><span>{t("inbox.cExit", { value: fmtPrice(c.exit) })}</span><span>{t("inbox.cQty", { value: c.qty ?? "—" })}</span><span>net {fmtUsd(net, { signed: true })}</span>
      </div>
      {c.notes && <div className="mt-1 line-clamp-2 text-muted-foreground" title={c.notes}>{c.notes}</div>}
    </button>
  );
}

function PendingCard({ p, staff }: { p: PendingTrade; staff: boolean }) {
  const { toast } = useToast();
  const { t: tt } = propreportsI18n.useT();
  const merge = useMerge();
  const keep = useKeepSeparate();
  const dismiss = useDismissPending();
  const [selected, setSelected] = React.useState<number | null>(p.candidates[0]?.id ?? null);
  const [showExec, setShowExec] = React.useState(false);
  const t = p.trip;
  const busy = merge.isPending || keep.isPending || dismiss.isPending;

  const run = async (fn: () => Promise<unknown>, okTitle: string) => {
    try { await fn(); toast({ title: okTitle }); }
    catch (e) { toast({ title: tt("inbox.failed"), description: e instanceof Error ? e.message : String(e), variant: "destructive" }); }
  };

  return (
    <article className="rounded-2xl border border-[var(--glass-border)] p-3 sm:p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-semibold">{p.ticker}</span>
          <span className={t.side === "Long" ? "text-up" : "text-down"}>{commonI18n.t(t.side === "Long" ? "trading.long" : "trading.short")}</span>
          <span className="text-muted-foreground">{p.date}{t.exitDate && t.exitDate !== p.date ? ` → ${t.exitDate}` : ""}</span>
          <Pill tone="neutral">{personName(p.trader)}</Pill>
          {p.account && <Pill tone="neutral">{p.account}</Pill>}
          <Pill tone={resultTone(t.result)}>{fmtUsd(t.netPnl, { signed: true })} net</Pill>
        </div>
        <span className="text-2xs text-muted-foreground">{tt("inbox.queuedSince", { date: fmtDate(p.createdAt, "short") })}</span>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Side title={tt("inbox.broker")} tone="accent">
          <StatRow label={tt("inbox.entryExit")} value={`${fmtPrice(t.avgEntry)} → ${fmtPrice(t.avgExit)}`} />
          <StatRow label={tt("inbox.qtyMax")} value={tt("inbox.qtyValue", { qty: t.qty, fills: t.fillCount })} />
          <StatRow label={tt("inbox.grossFees")} value={<span>{fmtUsd(t.grossPnl, { signed: true })} / <FeesBreakdown fees={t.fees} total={t.totalFees} /></span>} />
          <StatRow label="Net" value={fmtUsd(t.netPnl, { signed: true })} tone={t.netPnl > 0 ? "up" : t.netPnl < 0 ? "down" : "neutral"} />
          <StatRow label={tt("inbox.horizonHold")} value={`${horizonLabel(t.horizon)} · ${t.holdTime ?? "—"}`} />
          <button type="button" className="mt-1 text-left text-xs text-primary hover:underline" onClick={() => setShowExec((v) => !v)}>{showExec ? tt("inbox.hideExec") : tt("inbox.showExec")}</button>
          {showExec && <ExecutionsList trip={t} />}
        </Side>
        <Side title={tt("inbox.manual", { count: p.candidates.length })} tone="neutral">
          {p.candidates.length ? p.candidates.map((c) => <Candidate key={c.id} c={c} selected={selected === c.id} onSelect={() => setSelected(c.id)} />) : <div className="text-xs text-muted-foreground">{tt("inbox.manualGone")}</div>}
          <p className="mt-1 text-2xs text-muted-foreground">{tt("inbox.mergeNote")}</p>
        </Side>
      </div>

      {staff && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy || selected == null} onClick={() => run(() => merge.mutateAsync({ pendingId: p.id, tradeId: selected! }), tt("inbox.merged", { id: selected ?? "" }))}>
            {merge.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <GitMerge className="mr-1.5 h-4 w-4" />}{tt("inbox.merge", { id: selected ?? "—" })}
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => keep.mutateAsync(p.id), tt("inbox.kept"))}>
            <Split className="mr-1.5 h-4 w-4" />{tt("inbox.keep")}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => dismiss.mutateAsync(p.id), tt("inbox.removed"))} aria-label={tt("inbox.removeAria")}>
            <Trash2 className="mr-1.5 h-4 w-4" />{tt("inbox.skip")}
          </Button>
          <span className="text-2xs text-muted-foreground">{tt("inbox.feesInNet", { fees: fmtUsd(t.totalFees) })}</span>
        </div>
      )}
    </article>
  );
}

export function ReconcileInbox({ pending, staff, loading }: { pending: PendingTrade[]; staff: boolean; loading: boolean }) {
  const { t } = propreportsI18n.useT();
  return (
    <Panel title={t("inbox.title")} description={t("inbox.description")} icon={Inbox} actions={pending.length ? <Pill tone="warn" dot>{pending.length}</Pill> : undefined}>
      {loading ? (
        <div className="py-6 text-center text-sm text-muted-foreground">{commonI18n.t("states.loading")}</div>
      ) : !pending.length ? (
        <EmptyState icon={Inbox} title={t("inbox.empty")} description={t("inbox.emptyHint")} />
      ) : (
        <div className="grid gap-3">{pending.map((p) => <PendingCard key={p.id} p={p} staff={staff} />)}</div>
      )}
    </Panel>
  );
}
