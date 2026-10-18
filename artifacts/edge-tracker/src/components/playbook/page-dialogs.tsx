/** Page-level dialogs: rename folder (with explicit merge on 409), delete folder, delete setup, activity sheet. */
import { useEffect, useState } from "react";
import { Activity } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { EmptyState, Pill, type Tone } from "@/components/ds";
import { usePlaybookActivity } from "./api";
import { http, ApiError } from "@/lib/api/http";
import { timeAgo } from "./model";
import { commonI18n } from "@/i18n/ns/common";
import { playbookDialogsI18n } from "@/i18n/ns/playbookDialogs";

import { personName } from "@/i18n";
const destructive = "bg-down text-white hover:bg-down/90";

/** Rename; when the target exists the server answers 409 and we ask before merging. */
export function RenameFolderDialog({
  folder, onClose, trader, onRenamed, space,
}: {
  folder: string | null;
  onClose: () => void;
  trader: string;
  /** "personal" renames the caller's own folder in «Мой» (office folders: curators). */
  space?: "office" | "personal";
  onRenamed: (from: string, to: string, merged: boolean) => void;
}) {
  const { t } = playbookDialogsI18n.useT();
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ to: string; count: number } | null>(null);
  useEffect(() => { if (folder != null) { setValue(folder); setError(null); setConflict(null); } }, [folder]);

  async function submit(merge = false) {
    if (folder == null) return;
    const to = value.trim();
    if (!to || to === folder) { onClose(); return; }
    setPending(true);
    setError(null);
    try {
      const r = await http.patch<{ merged?: boolean }>("/api/playbook/rename-folder", { from: folder, to, trader, merge, ...(space ? { space } : {}) });
      onRenamed(folder, to, !!r?.merged || merge);
      setConflict(null);
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflict({ to, count: Number(e.field("targetCount")) || 0 });
      else setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Dialog open={folder != null && !conflict} onOpenChange={(v) => { if (!v) onClose(); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("rename.title")}</DialogTitle>
            <DialogDescription>{t("rename.description", { folder: folder ?? "" })}</DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); submit(false); }} className="space-y-2">
            <Label htmlFor="pb-rename-folder" className="text-xs text-muted-foreground">{t("rename.newName")}</Label>
            <Input id="pb-rename-folder" value={value} onChange={(e) => setValue(e.target.value)} maxLength={120} autoFocus />
            {error && <p className="text-xs text-down" role="alert">{error}</p>}
            <DialogFooter className="gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={onClose}>{commonI18n.t("actions.cancel")}</Button>
              <Button type="submit" disabled={pending || !value.trim()}>{pending ? t("rename.saving") : t("rename.submit")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog open={!!conflict} onOpenChange={(v) => { if (!v) setConflict(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("rename.conflictTitle", { folder: conflict?.to ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("rename.conflictDesc", { setups: commonI18n.t("units.setups", { count: conflict?.count ?? 0 }), folder: folder ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("rename.otherName")}</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); submit(true); }} disabled={pending}>
              {pending ? t("rename.merging") : t("rename.merge")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function DeleteFolderDialog({
  folder, count, onClose, onConfirm, pending,
}: {
  folder: string | null; count: number; onClose: () => void; onConfirm: (password: string) => void; pending: boolean;
}) {
  const { t } = playbookDialogsI18n.useT();
  const [pwd, setPwd] = useState("");
  useEffect(() => { if (folder == null) setPwd(""); }, [folder]);
  return (
    <AlertDialog open={folder != null} onOpenChange={(v) => { if (!v) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("deleteFolder.title", { folder: folder ?? "" })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("deleteFolder.description", { setups: commonI18n.t("units.setups", { count }) })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <form id="pb-del-folder" onSubmit={(e) => { e.preventDefault(); if (pwd && !pending) onConfirm(pwd); }}>
          <Label htmlFor="pb-del-folder-pwd" className="sr-only">{t("deleteFolder.password")}</Label>
          <Input id="pb-del-folder-pwd" type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} placeholder={t("deleteFolder.password")} autoFocus autoComplete="off" />
        </form>
        <AlertDialogFooter>
          <AlertDialogCancel>{commonI18n.t("actions.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => { e.preventDefault(); if (pwd && !pending) onConfirm(pwd); }}
            disabled={!pwd || pending}
            className={destructive}
          >
            {pending ? t("deleteFolder.deleting") : t("deleteFolder.submit")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function DeleteSetupDialog({
  name, open, onClose, onConfirm, pending,
}: {
  name: string | null; open: boolean; onClose: () => void; onConfirm: () => void; pending: boolean;
}) {
  const { t } = playbookDialogsI18n.useT();
  return (
    <AlertDialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("deleteSetup.title", { name: name ?? "" })}</AlertDialogTitle>
          <AlertDialogDescription>{t("deleteSetup.description")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{commonI18n.t("actions.cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={(e) => { e.preventDefault(); if (!pending) onConfirm(); }} disabled={pending} className={destructive}>
            {pending ? t("deleteSetup.deleting") : commonI18n.t("actions.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Activity `action` code → tone; the label is translated by code (unknown codes show as is). */
const ACTION_TONES: Record<string, Tone> = { created: "up", updated: "accent", deleted: "down", restored: "up", renamed: "purple" };

export function ActivitySheet({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t, tryT } = playbookDialogsI18n.useT();
  const { data = [], isLoading, isError, refetch } = usePlaybookActivity(open);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t("activity.title")}</SheetTitle>
          <SheetDescription>{t("activity.description")}</SheetDescription>
        </SheetHeader>
        <div className="-mx-2 mt-2 min-h-0 flex-1 overflow-y-auto">
          {isLoading && <div className="space-y-2 px-2">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-12 rounded-xl" />)}</div>}
          {isError && (
            <p className="px-2 py-4 text-sm text-down">
              {t("activity.loadFailed")} <button type="button" className="underline" onClick={() => refetch()}>{commonI18n.t("actions.retry")}</button>
            </p>
          )}
          {!isLoading && !isError && data.length === 0 && <EmptyState icon={Activity} title={commonI18n.t("states.empty")} description={t("activity.emptyDesc")} />}
          <ul className="space-y-1">
            {data.map((a) => {
              const meta = { label: tryT(`activity.action.${a.action}`) ?? a.action, tone: ACTION_TONES[a.action] ?? ("neutral" as Tone) };
              return (
                <li key={a.id} className="rounded-xl px-2 py-2 hover:bg-[var(--glass-hover-bg)]">
                  <div className="flex items-center gap-2">
                    <Pill tone={meta.tone}>{meta.label}</Pill>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{a.entityTitle ?? "—"}</span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                    {a.trader && <span>{personName(a.trader)}</span>}
                    <span>{timeAgo(a.createdAt)}</span>
                    {a.details && <span className="min-w-0 truncate" title={a.details}>· {a.details}</span>}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </SheetContent>
    </Sheet>
  );
}
