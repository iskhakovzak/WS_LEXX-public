import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { History, RotateCcw, AlertTriangle } from "lucide-react";
import { http } from "@/lib/api/http";
import { useAuth } from "@/contexts/auth-context";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { EmptyState, Pill, Segmented } from "@/components/ds";
import { IconAction } from "@/components/playbook-sub/bits";
import { fmtDateCustom, fmtRelative } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { playbookToolsI18n, type RevisionFieldKey } from "@/i18n/ns/playbookTools";
import { HORIZON_LABEL, STRUCTURED, timeOfDayLabel, type StructuredKey } from "@/components/playbook/model";

import { personName } from "@/i18n";
type Revision = {
  id: number;
  playbookId: number;
  trader: string | null;
  snapshot: Record<string, any>;
  createdAt: string;
};

type Field = { key: string; readonly label: string; multiline?: boolean; display?: (v: string) => string };
/** Tracked fields; labels are getters (current UI language). The structured card fields come from the playbook model. */
const plain = (key: RevisionFieldKey, multiline?: boolean, display?: (v: string) => string): Field => ({
  key, multiline, display, get label() { return playbookToolsI18n.t(`revisions.field.${key}`); },
});
const card = (f: { key: StructuredKey; readonly label: string }): Field => ({ key: f.key, multiline: true, get label() { return f.label; } });
const FIELDS: Field[] = [
  plain("name"),
  plain("folder"),
  plain("setupType"),
  plain("confidenceLevel"),
  plain("tags"),
  plain("horizon", false, (v) => HORIZON_LABEL[v] ?? v),
  plain("timeOfDay", false, (v) => timeOfDayLabel(v)),
  ...STRUCTURED.map(card),
  plain("conditions", true),
  plain("checklist", true),
  plain("notes", true),
];

function norm(v: any): string {
  if (v == null) return "";
  return String(v).replace(/\r\n/g, "\n").trim();
}
/** Field value as shown in the diff (codes such as the horizon are translated; user text as is). */
const shown = (f: Field, v: string) => (v && f.display ? f.display(v) : v);

function changedFields(a: Record<string, any> | undefined, b: Record<string, any> | undefined) {
  return FIELDS.filter((f) => norm(a?.[f.key]) !== norm(b?.[f.key]));
}

type DiffLine = { kind: "same" | "add" | "del"; text: string };

/** Line-level LCS diff (inputs are short playbook texts). */
function diffLines(a: string, b: string): DiffLine[] {
  const A = a ? a.split("\n") : [];
  const B = b ? b.split("\n") : [];
  if (A.length * B.length > 160000) {
    return [...A.map((t) => ({ kind: "del" as const, text: t })), ...B.map((t) => ({ kind: "add" as const, text: t }))];
  }
  const dp: number[][] = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--)
    for (let j = B.length - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { out.push({ kind: "same", text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ kind: "del", text: A[i] }); i++; }
    else { out.push({ kind: "add", text: B[j] }); j++; }
  }
  while (i < A.length) out.push({ kind: "del", text: A[i++] });
  while (j < B.length) out.push({ kind: "add", text: B[j++] });
  return out;
}

function FieldDiff({ label, before, after, multiline }: { label: string; before: string; after: string; multiline?: boolean }) {
  const { t } = playbookToolsI18n.useT();
  const changed = before !== after;
  return (
    <div className="rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg)] p-3">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-xs font-medium text-foreground">{label}</span>
        {changed ? <Pill tone="warn">{t("revisions.changed")}</Pill> : <span className="text-xs text-muted-foreground">{t("revisions.unchanged")}</span>}
      </div>
      {!changed ? (
        <div className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{before || "—"}</div>
      ) : multiline ? (
        <div className="overflow-hidden rounded-lg text-sm">
          {diffLines(before, after).map((l, i) => (
            <div
              key={i}
              className={cn(
                "flex gap-2 whitespace-pre-wrap break-words px-2 py-0.5",
                l.kind === "add" && "bg-up/10 text-up",
                l.kind === "del" && "bg-down/10 text-down line-through decoration-down/40",
                l.kind === "same" && "text-muted-foreground",
              )}
            >
              <span className="w-3 shrink-0 select-none text-center" aria-hidden="true">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</span>
              <span className="sr-only">{l.kind === "add" ? t("revisions.added") : l.kind === "del" ? t("revisions.removed") : ""}</span>
              <span className="min-w-0 flex-1">{l.text || " "}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="rounded-md bg-down/10 px-1.5 py-0.5 text-down line-through decoration-down/40">{before || "—"}</span>
          <span className="text-muted-foreground" aria-hidden="true">→</span>
          <span className="rounded-md bg-up/10 px-1.5 py-0.5 text-up">{after || "—"}</span>
        </div>
      )}
    </div>
  );
}


/** «17.10.26, 14:05» — revision stamp (no fmtDate style for 2-digit year + time). */
const REV_STAMP: Intl.DateTimeFormatOptions = { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };

/** Build the PATCH body that brings a setup back to `snap`. Keeps the current owner (`trader`) intact. */
function restoreBody(snap: Record<string, any>, current?: Record<string, any>) {
  const body: Record<string, unknown> = {
    name: snap.name ?? current?.name,
    folder: snap.folder ?? null,
    setupType: snap.setupType ?? null,
    conditions: snap.conditions ?? null,
    notes: snap.notes ?? null,
    confidenceLevel: snap.confidenceLevel ?? null,
    tags: snap.tags ?? null,
  };
  // Structured card / horizon / time of day: only when the snapshot has them (older snapshots predate the columns).
  for (const k of [...STRUCTURED.map((f) => f.key), "horizon", "timeOfDay"]) if (k in snap) body[k] = snap[k] ?? null;
  if (Array.isArray(snap.checklistItems) && snap.checklistItems.length > 0) body.checklistItems = snap.checklistItems;
  else body.checklist = snap.checklist ?? null;
  const owner = current?.trader ?? snap.trader;
  if (owner) body.trader = owner;
  return body;
}

export function PlaybookRevisionsButton({
  playbookId,
  currentSnapshot,
  onRestored,
}: {
  playbookId: number;
  currentSnapshot?: Record<string, any>;
  /** Called after a successful restore (the component already invalidates playbook queries). */
  onRestored?: () => void;
}) {
  const { t } = playbookToolsI18n.useT();
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [mode, setMode] = useState<"edit" | "current">("edit");
  const [showAll, setShowAll] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const { canEdit } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: revisions = [], isLoading, isError, refetch } = useQuery<Revision[]>({
    queryKey: ["playbook-revisions", playbookId],
    queryFn: ({ signal }) =>
      http.get<Revision[]>(`/api/playbook/${playbookId}/revisions`, { signal }).then((j) => (Array.isArray(j) ? j : [])),
    enabled: open,
  });

  // Each revision snapshot = state BEFORE the edit at createdAt. State after = next newer snapshot or current.
  const timeline = useMemo(() => revisions.map((r, idx) => {
    const after = idx === 0 ? currentSnapshot : revisions[idx - 1]?.snapshot;
    return { rev: r, after, changes: changedFields(r.snapshot, after) };
  }), [revisions, currentSnapshot]);

  useEffect(() => {
    if (open && selectedId == null && timeline.length > 0) setSelectedId(timeline[0].rev.id);
  }, [open, timeline, selectedId]);

  const selIdx = timeline.findIndex((x) => x.rev.id === selectedId);
  const sel = selIdx >= 0 ? timeline[selIdx] : null;
  const compareTo = mode === "edit" ? sel?.after : currentSnapshot;
  const fieldsToShow = sel ? (showAll ? FIELDS : changedFields(sel.rev.snapshot, compareTo)) : [];
  const sameAsCurrent = sel ? changedFields(sel.rev.snapshot, currentSnapshot).length === 0 : true;

  const restore = useMutation({
    mutationFn: (snap: Record<string, any>) => http.patch(`/api/playbook/${playbookId}`, restoreBody(snap, currentSnapshot)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["playbook"] });
      qc.invalidateQueries({ queryKey: ["playbook-children"] });
      qc.invalidateQueries({ queryKey: ["playbook-revisions", playbookId] });
      qc.invalidateQueries({ queryKey: ["playbook-health"] });
      toast({ title: t("revisions.restored"), description: t("revisions.restoredDesc") });
      setConfirm(false);
      setSelectedId(null);
      onRestored?.();
    },
    onError: (e: any) => toast({ title: t("revisions.restoreFailed"), description: String(e?.message ?? "").slice(0, 200) || undefined, variant: "destructive" }),
  });

  function onListKey(e: React.KeyboardEvent) {
    if (!timeline.length) return;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const next = Math.max(0, Math.min(timeline.length - 1, (selIdx < 0 ? 0 : selIdx) + (e.key === "ArrowDown" ? 1 : -1)));
    setSelectedId(timeline[next].rev.id);
    listRef.current?.querySelector<HTMLButtonElement>(`[data-rev="${timeline[next].rev.id}"]`)?.focus();
  }

  return (
    <>
      <IconAction
        aria-label={t("revisions.title")}
        title={t("revisions.title")}
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
      >
        <History aria-hidden="true" />
      </IconAction>

      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setSelectedId(null); setMode("edit"); setShowAll(false); } }}>
        <DialogContent className="flex max-h-[85vh] max-w-4xl flex-col gap-4 p-4 sm:p-6">
          <DialogHeader className="pr-10">
            <DialogTitle className="flex items-center gap-2 text-base font-semibold">
              <History className="h-4 w-4 text-primary" aria-hidden="true" /> {t("revisions.title")}
              {revisions.length > 0 && (
                <span className="text-xs font-normal tabular-nums text-muted-foreground">
                  {t("revisions.count", { count: revisions.length })}
                </span>
              )}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {t("revisions.description")}
            </DialogDescription>
          </DialogHeader>

          {isLoading ? (
            <div className="grid min-h-0 flex-1 gap-3 sm:grid-cols-[240px_1fr]">
              <div className="space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14 rounded-xl" />)}</div>
              <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>
            </div>
          ) : isError ? (
            <EmptyState
              icon={AlertTriangle}
              title={t("revisions.loadFailed")}
              action={<Button variant="outline" size="sm" onClick={() => refetch()}>{commonI18n.t("actions.retry")}</Button>}
            />
          ) : timeline.length === 0 ? (
            <EmptyState icon={History} title={t("revisions.emptyTitle")} description={t("revisions.emptyDesc")} />
          ) : (
            <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,160px)_minmax(0,1fr)] gap-3 sm:grid-cols-[240px_minmax(0,1fr)] sm:grid-rows-1">
              {/* Timeline */}
              <div
                ref={listRef}
                role="listbox"
                aria-label={t("revisions.listAria")}
                aria-activedescendant={sel ? `rev-${sel.rev.id}` : undefined}
                onKeyDown={onListKey}
                className="relative min-h-0 overflow-y-auto pr-1"
              >
                <span className="absolute bottom-3 left-[13px] top-3 w-px bg-[var(--glass-border)]" aria-hidden="true" />
                <ol className="relative space-y-1">
                  {timeline.map(({ rev, changes }, idx) => {
                    const active = rev.id === selectedId;
                    return (
                      <li key={rev.id}>
                        <button
                          id={`rev-${rev.id}`}
                          data-rev={rev.id}
                          type="button"
                          role="option"
                          aria-selected={active}
                          tabIndex={active || (selIdx < 0 && idx === 0) ? 0 : -1}
                          onClick={() => setSelectedId(rev.id)}
                          className={cn(
                            "flex w-full items-start gap-2.5 rounded-xl px-1.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            active ? "bg-primary/10" : "hover:bg-[var(--glass-hover-bg)]",
                          )}
                        >
                          <span
                            className={cn(
                              "mt-1 h-3 w-3 shrink-0 rounded-full border-2",
                              active ? "border-primary bg-primary" : "border-[var(--field-border)] bg-background",
                            )}
                            aria-hidden="true"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium text-foreground">{fmtRelative(rev.createdAt) || fmtDateCustom(rev.createdAt, REV_STAMP)}</span>
                            <span className="block truncate text-xs text-muted-foreground">{fmtDateCustom(rev.createdAt, REV_STAMP)} · {rev.trader ? personName(rev.trader) : t("revisions.system")}</span>
                            <span className="mt-1 flex flex-wrap gap-1">
                              {changes.length === 0
                                ? <span className="text-xs text-muted-foreground">{t("revisions.noVisible")}</span>
                                : changes.slice(0, 3).map((c) => <Pill key={c.key} tone="neutral" className="text-xs">{c.label}</Pill>)}
                              {changes.length > 3 && <span className="text-xs text-muted-foreground">+{changes.length - 3}</span>}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </div>

              {/* Diff */}
              <div className="flex min-h-0 flex-col gap-3">
                {sel && (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Segmented
                        ariaLabel={t("revisions.modeAria")}
                        size="sm"
                        value={mode}
                        onChange={(v) => setMode(v as "edit" | "current")}
                        options={[
                          { value: "edit", label: t("revisions.modeEdit") },
                          { value: "current", label: t("revisions.modeCurrent") },
                        ]}
                      />
                      <label className="inline-flex min-h-8 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                        <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="h-4 w-4 accent-[hsl(var(--primary))]" />
                        {t("revisions.allFields")}
                      </label>
                    </div>
                    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                      {fieldsToShow.length === 0 ? (
                        <p className="py-6 text-center text-sm text-muted-foreground">
                          {mode === "current" ? t("revisions.sameAsCurrent") : t("revisions.noTracked")}
                        </p>
                      ) : fieldsToShow.map((f) => (
                        <FieldDiff
                          key={f.key}
                          label={f.label}
                          multiline={f.multiline}
                          before={shown(f, norm(sel.rev.snapshot?.[f.key]))}
                          after={shown(f, norm(compareTo?.[f.key]))}
                        />
                      ))}
                    </div>
                    {canEdit && (
                      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--glass-border)] pt-3">
                        <span className="mr-auto text-xs text-muted-foreground">
                          {t("revisions.restoreTo", { date: fmtDateCustom(sel.rev.createdAt, REV_STAMP) })}
                        </span>
                        <Button size="sm" onClick={() => setConfirm(true)} disabled={sameAsCurrent || restore.isPending}>
                          <RotateCcw aria-hidden="true" /> {t("revisions.restore")}
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirm} onOpenChange={(o) => !restore.isPending && setConfirm(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("revisions.confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("revisions.confirmDesc", { date: sel ? fmtDateCustom(sel.rev.createdAt, REV_STAMP) : "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restore.isPending}>{commonI18n.t("actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={restore.isPending || !sel}
              onClick={(e) => { e.preventDefault(); if (sel) restore.mutate(sel.rev.snapshot); }}
            >
              {restore.isPending ? t("revisions.restoring") : t("revisions.restore")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
