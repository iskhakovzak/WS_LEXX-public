/**
 * Curator "run now" dialog: date range → dry-run preview over the API → apply.
 */
import * as React from "react";
import { Loader2, PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Pill } from "@/components/ds";
import { useToast } from "@/hooks/use-toast";
import { localDateString } from "@/lib/local-date";
import { useApiSync, type ApplyResult, type IntegrationsTab, type Preview } from "./api";
import { NextSteps, PreviewSummary, PreviewTable } from "./preview-table";
import { propreportsI18n } from "@/i18n/ns/propreports";
import { commonI18n } from "@/i18n/ns/common";

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDateString(d);
}

export function RunSyncDialog({ open, onOpenChange, configured, onGoTab }: { open: boolean; onOpenChange: (v: boolean) => void; configured: boolean; onGoTab?: (tab: IntegrationsTab) => void }) {
  const { toast } = useToast();
  const { t } = propreportsI18n.useT();
  const [from, setFrom] = React.useState(() => daysAgo(3));
  const [to, setTo] = React.useState(() => localDateString());
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [applied, setApplied] = React.useState<ApplyResult | null>(null);
  const sync = useApiSync();
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;

  const runPreview = async () => {
    try { setPreview((await sync.mutateAsync({ from, to, dryRun: true })) as Preview); setApplied(null); }
    catch (e) { toast({ title: t("runDialog.fetchFailed"), description: e instanceof Error ? e.message : String(e), variant: "destructive" }); }
  };
  const runApply = async () => {
    try {
      const r = (await sync.mutateAsync({ from, to, dryRun: false })) as ApplyResult;
      setApplied(r);
      toast({
        title: t("runToast.sync", { inserted: r.inserted, updated: r.updated }),
        description: r.errors ? t("runToast.detailErrors", { conflicts: r.conflicts, skipped: r.skipped, errors: r.errors }) : t("runToast.detail", { conflicts: r.conflicts, skipped: r.skipped }),
        variant: r.errors ? "destructive" : undefined,
      });
    } catch (e) { toast({ title: t("runDialog.failed"), description: e instanceof Error ? e.message : String(e), variant: "destructive" }); }
  };

  const writable = preview && preview.counts.insert + preview.counts.update + preview.counts.adopt + preview.counts.conflict > 0;

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) { setPreview(null); setApplied(null); } }}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-[min(96vw,80rem)]">
        <DialogHeader>
          <DialogTitle>{t("runDialog.title")}</DialogTitle>
          <DialogDescription>{t("runDialog.description")}</DialogDescription>
        </DialogHeader>
        {!configured ? (
          <p className="text-sm text-[hsl(var(--chart-3))]">{t("runDialog.notConfigured")}</p>
        ) : (
          <div className="grid gap-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="grid gap-1"><Label htmlFor="pr-from" className="text-xs text-muted-foreground">{t("runDialog.from")}</Label><Input id="pr-from" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPreview(null); }} className="h-9 w-40" /></div>
              <div className="grid gap-1"><Label htmlFor="pr-to" className="text-xs text-muted-foreground">{t("runDialog.to")}</Label><Input id="pr-to" type="date" value={to} onChange={(e) => { setTo(e.target.value); setPreview(null); }} className="h-9 w-40" /></div>
              <div className="flex gap-1">
                {[1, 3, 7, 30].map((n) => <Button key={n} variant="ghost" size="sm" onClick={() => { setFrom(daysAgo(n)); setTo(localDateString()); setPreview(null); }}>{commonI18n.t("time.daysShort", { count: n })}</Button>)}
              </div>
              <Button variant="outline" onClick={runPreview} disabled={!valid || sync.isPending}>
                {sync.isPending && sync.variables?.dryRun ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}{t("runDialog.preview")}
              </Button>
              <Pill tone="neutral">{t("runDialog.maxDays")}</Pill>
            </div>
            {applied && (
              <div className="flex flex-wrap gap-2 text-sm">
                <Pill tone="up">{t("counts.inserted", { count: applied.inserted })}</Pill><Pill tone="accent">{t("counts.updated", { count: applied.updated })}</Pill><Pill tone="neutral">{t("counts.unchanged", { count: applied.unchanged })}</Pill>
                {applied.conflicts > 0 && <Pill tone="warn">{t("counts.conflicts", { count: applied.conflicts })}</Pill>}
                {applied.errors > 0 && <Pill tone="down">{t("counts.errors", { count: applied.errors })}</Pill>}
                {applied.errorText && <pre className="w-full whitespace-pre-wrap text-xs text-down">{applied.errorText}</pre>}
                <NextSteps result={applied} onGoTab={onGoTab} />
              </div>
            )}
            {preview && !applied && (
              <>
                <PreviewSummary preview={preview} />
                <PreviewTable preview={preview} />
              </>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{commonI18n.t("actions.close")}</Button>
          <Button onClick={runApply} disabled={!configured || !preview || !writable || sync.isPending || !!applied}>
            {sync.isPending && sync.variables?.dryRun === false ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PlayCircle className="mr-2 h-4 w-4" />}{t("runDialog.write")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
