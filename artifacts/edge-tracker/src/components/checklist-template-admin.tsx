import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Pill, EmptyState } from "@/components/ds";
import { QueryError } from "@/components/query-error";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/auth-context";
import { Pencil, Trash2, Plus, ArrowUp, ArrowDown, ClipboardCheck, RotateCcw } from "lucide-react";
import { http } from "@/lib/api/http";
import { cn } from "@/lib/utils";
import { commonI18n } from "@/i18n/ns/common";
import { checklistI18n } from "@/i18n/ns/checklist";

// Access is enforced server-side by the caller's role (curator/admin) from the auth token.

type Item = { id: number; label: string; description: string | null; required: boolean; sortOrder: number; active: boolean };
type FormData = { label: string; description: string; required: boolean; sortOrder: number; active: boolean };

function ItemForm({
  initial, onSubmit, onCancel, pending, submitLabel, showActive,
}: {
  initial: FormData; onSubmit: (d: FormData) => void; onCancel: () => void; pending: boolean; submitLabel: string; showActive?: boolean;
}) {
  const [form, setForm] = useState<FormData>(initial);
  const idp = React.useId();
  const { t } = checklistI18n.useT();
  const { t: tc } = commonI18n.useT();
  return (
    <form
      className="flex flex-col gap-3 rounded-xl bg-primary/8 p-3 ring-1 ring-primary/30"
      onSubmit={(e) => { e.preventDefault(); if (form.label.trim()) onSubmit({ ...form, label: form.label.trim() }); }}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }}
    >
      <Input aria-label={t("admin.itemNameAria")} placeholder={t("admin.itemNamePlaceholder")} value={form.label} autoFocus
        onChange={(e) => setForm({ ...form, label: e.target.value })} maxLength={200} />
      <Textarea aria-label={t("admin.itemDescAria")} className="min-h-[60px] rounded-xl" placeholder={t("admin.itemDescPlaceholder")}
        value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <label htmlFor={`${idp}-req`} className="flex items-center gap-2 text-foreground">
          <Switch id={`${idp}-req`} checked={form.required} onCheckedChange={(v) => setForm({ ...form, required: v })} /> {t("admin.required")}
        </label>
        {showActive && (
          <label htmlFor={`${idp}-act`} className="flex items-center gap-2 text-foreground">
            <Switch id={`${idp}-act`} checked={form.active} onCheckedChange={(v) => setForm({ ...form, active: v })} /> {t("admin.active")}
          </label>
        )}
        <label htmlFor={`${idp}-ord`} className="flex items-center gap-2 text-muted-foreground">
          {t("admin.order")}
          <Input id={`${idp}-ord`} className="h-8 w-20 tabular-nums" type="number" value={form.sortOrder}
            onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) || 0 })} />
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>{tc("actions.cancel")}</Button>
        <Button type="submit" size="sm" variant="secondary" disabled={!form.label.trim() || pending}>{pending ? tc("states.saving") : submitLabel}</Button>
      </div>
    </form>
  );
}

export function ChecklistTemplateAdmin() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { isCurator } = useAuth();
  const { t } = checklistI18n.useT();
  const { t: tc } = commonI18n.useT();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Item | null>(null);

  const { data: items = [], isLoading, isError, error, refetch } = useQuery<Item[]>({
    queryKey: ["checklist-template", "admin"],
    queryFn: ({ signal }) => http.get<Item[]>("/api/checklist-template", { query: { includeInactive: true }, signal }),
    enabled: isCurator,
  });

  const createMut = useMutation({
    mutationFn: async (data: FormData) => {
      const { active: _a, ...rest } = data;
      return http.post("/api/checklist-template", rest);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["checklist-template"] });
      setCreating(false);
      toast({ title: t("admin.added") });
    },
    onError: (e: Error) => toast({ title: tc("states.error"), description: e.message, variant: "destructive" }),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<FormData> }) => http.patch(`/api/checklist-template/${id}`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["checklist-template"] });
      setEditingId(null);
    },
    onError: (e: Error) => toast({ title: tc("states.error"), description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => http.del(`/api/checklist-template/${id}`, undefined, { responseType: "auto" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["checklist-template"] });
      toast({ title: t("admin.deactivated") });
    },
    onError: (e: Error) => toast({ title: tc("states.error"), description: e.message, variant: "destructive" }),
    onSettled: () => setDeleting(null),
  });

  // Only curators/admins manage the template; others see nothing.
  if (!isCurator) return null;

  const sorted = [...items].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  const activeCount = items.filter((i) => i.active).length;
  const requiredCount = items.filter((i) => i.active && i.required).length;

  /** Swap sort order with the neighbour (two PATCHes). */
  async function move(item: Item, dir: -1 | 1) {
    const idx = sorted.findIndex((i) => i.id === item.id);
    const other = sorted[idx + dir];
    if (!other) return;
    const a = other.sortOrder === item.sortOrder ? item.sortOrder + dir : other.sortOrder;
    try {
      await Promise.all([
        updateMut.mutateAsync({ id: item.id, data: { sortOrder: a } }),
        updateMut.mutateAsync({ id: other.id, data: { sortOrder: item.sortOrder } }),
      ]);
    } catch { /* toast via onError */ }
  }

  const nextOrder = (sorted.at(-1)?.sortOrder ?? 0) + 1;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill tone="accent">{t("admin.activeCount", { count: activeCount })}</Pill>
          <Pill tone="down">{t("admin.requiredCount", { count: requiredCount })}</Pill>
          {items.length > activeCount && <Pill>{t("admin.hiddenCount", { count: items.length - activeCount })}</Pill>}
        </div>
        {!creating && (
          <Button size="sm" variant="secondary" onClick={() => { setCreating(true); setEditingId(null); }} className="gap-1.5">
            <Plus className="h-3.5 w-3.5" aria-hidden="true" /> {t("admin.newItem")}
          </Button>
        )}
      </div>

      {creating && (
        <ItemForm
          initial={{ label: "", description: "", required: true, sortOrder: nextOrder, active: true }}
          onSubmit={(d) => createMut.mutate(d)}
          onCancel={() => setCreating(false)}
          pending={createMut.isPending}
          submitLabel={tc("actions.add")}
        />
      )}

      {isError && <QueryError error={error} onRetry={() => refetch()} />}

      {isLoading && (
        <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 rounded-xl" />)}</div>
      )}

      <ol className="flex flex-col gap-1.5">
        {sorted.map((item, idx) => {
          if (editingId === item.id) {
            return (
              <li key={item.id}>
                <ItemForm
                  initial={{ label: item.label, description: item.description ?? "", required: item.required, sortOrder: item.sortOrder, active: item.active }}
                  onSubmit={(d) => updateMut.mutate({ id: item.id, data: d }, { onSuccess: () => toast({ title: tc("states.saved") }) })}
                  onCancel={() => setEditingId(null)}
                  pending={updateMut.isPending}
                  submitLabel={tc("actions.save")}
                  showActive
                />
              </li>
            );
          }
          return (
            <li key={item.id}
              className={cn("group flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-[var(--glass-hover-bg)]",
                item.active ? "bg-[var(--glass-bg)]" : "opacity-60")}>
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--glass-thick-bg)] text-xs font-semibold tabular-nums text-muted-foreground">{idx + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="truncate text-sm font-medium text-foreground" title={item.label}>{item.label}</span>
                  {item.required && <Pill tone="down" className="text-2xs">{t("admin.requiredPill")}</Pill>}
                  {!item.active && <Pill className="text-2xs">{t("admin.hiddenPill")}</Pill>}
                </div>
                {item.description && <p className="mt-0.5 truncate text-xs text-muted-foreground" title={item.description}>{item.description}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-within:opacity-100">
                <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={t("admin.moveUp", { label: item.label })} disabled={idx === 0 || updateMut.isPending} onClick={() => move(item, -1)}>
                  <ArrowUp aria-hidden="true" />
                </Button>
                <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={t("admin.moveDown", { label: item.label })} disabled={idx === sorted.length - 1 || updateMut.isPending} onClick={() => move(item, 1)}>
                  <ArrowDown aria-hidden="true" />
                </Button>
                <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={t("admin.edit", { label: item.label })} onClick={() => { setEditingId(item.id); setCreating(false); }}>
                  <Pencil aria-hidden="true" />
                </Button>
                {item.active ? (
                  <Button size="icon" variant="ghost" className="h-8 w-8 hover:text-down" aria-label={t("admin.deactivate", { label: item.label })} onClick={() => setDeleting(item)}>
                    <Trash2 aria-hidden="true" />
                  </Button>
                ) : (
                  <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={t("admin.restore", { label: item.label })}
                    onClick={() => updateMut.mutate({ id: item.id, data: { active: true } }, { onSuccess: () => toast({ title: t("admin.reactivated") }) })}>
                    <RotateCcw aria-hidden="true" />
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {items.length === 0 && !isLoading && !isError && !creating && (
        <EmptyState icon={ClipboardCheck} title={t("admin.emptyTitle")}
          description={t("admin.emptyHint")}
          action={<Button size="sm" variant="secondary" onClick={() => setCreating(true)}>{t("admin.addFirst")}</Button>} />
      )}

      <AlertDialog open={!!deleting} onOpenChange={(v) => { if (!v && !deleteMut.isPending) setDeleting(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("admin.confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("admin.confirmText", { label: deleting?.label ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tc("actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteMut.isPending}
              onClick={(e) => { e.preventDefault(); if (deleting) deleteMut.mutate(deleting.id); }}
              className="bg-destructive text-destructive-foreground hover:brightness-110"
            >
              {deleteMut.isPending ? "…" : t("admin.deactivateAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
