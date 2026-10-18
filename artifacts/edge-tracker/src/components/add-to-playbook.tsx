import React, { useState, useEffect, useMemo, useRef, useId } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Kbd } from "@/components/ui/kbd";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToastAction } from "@/components/ui/toast";
import { Pill } from "@/components/ds";
import { BookOpen, FolderPlus, Folder, Inbox, AlertTriangle, Loader2, X, GitBranch, } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TradeQuickAdd } from "@/components/playbook/quick-add";
import { useToast } from "@/hooks/use-toast";
import { safeHttpUrl } from "@/lib/url";
import { useAuth } from "@/contexts/auth-context";
import { http } from "@/lib/api/http";
import { humanizeApiError } from "@/lib/api/errors";
import { cn } from "@/lib/utils";
import { commonI18n } from "@/i18n/ns/common";
import { playbookDialogsI18n } from "@/i18n/ns/playbookDialogs";
import { SOURCE_LABELS } from "@/components/playbook/model";

const LAST_FOLDER_KEY = "ws_lexx_playbook_last_folder";
function readLastFolder(): string {
  try { return localStorage.getItem(LAST_FOLDER_KEY) ?? ""; } catch { return ""; }
}
function writeLastFolder(f: string) {
  try { if (f) localStorage.setItem(LAST_FOLDER_KEY, f); else localStorage.removeItem(LAST_FOLDER_KEY); } catch { /* storage blocked */ }
}

export type PlaybookPayload = {
  name: string;
  setupType?: string;
  conditions?: string;
  checklist?: string;
  notes?: string;
  confidenceLevel?: number | null;
  screenshotUrl?: string;
  screenshotNotes?: string;
  tags?: string;
  ticker?: string;
  marketCap?: string | null;
  float?: string | null;
  adv?: string | null;
  atr?: number | null;
  relativeVolume?: number | null;
  beta?: number | null;
  shortInterest?: number | null;
  sector?: string | null;
  longName?: string | null;
  sourceType: "trade" | "research" | "dailyfeed" | "event" | "watchlist" | "trade_idea";
  sourceId: number;
};

type PlaybookEntry = {
  id: number;
  name: string;
  folder: string | null;
  parentId: number | null;
  sourceType: string | null;
  sourceId: number | null;
};

/**
 * «В плейбук».
 * For a trade (sourceType "trade") it opens a 1–2-click popover: pick a setup (suggested by auto-classification,
 * recent, or search), a tier (Tier 1 эталон / Tier 2 / Tier 3 ошибка) and an optional note → the trade becomes an
 * example of that setup. «Новый сетап из сделки» still opens the full dialog. Older API (no examples endpoints) →
 * the dialog opens directly. Other sources (research, events, ideas…) keep the dialog.
 */
export function AddToPlaybookButton({
  payload,
  size = "sm",
  className,
  label,
}: {
  payload: PlaybookPayload;
  size?: "sm" | "icon";
  /** Optional: extra classes for the trigger. */
  className?: string;
  /** Optional: trigger text for size="sm". */
  label?: string;
}) {
  const { t } = playbookDialogsI18n.useT();
  const [open, setOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const quick = payload.sourceType === "trade" && Number.isSafeInteger(payload.sourceId) && payload.sourceId > 0;
  const onTrigger = (e: React.MouseEvent) => { e.stopPropagation(); if (!quick) setOpen(true); };

  const trigger = size === "icon" ? (
    <button
      type="button"
      aria-label={t("add.aria")}
      onClick={onTrigger}
      className={cn(
        "grid h-8 w-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--glass-hover-bg)] hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      title={t("add.aria")}
    >
      <BookOpen className="h-4 w-4" aria-hidden="true" />
    </button>
  ) : (
    <Button type="button" variant="outline" size="sm" onClick={onTrigger} className={className}>
      <BookOpen aria-hidden="true" /> {label ?? t("add.button")}
    </Button>
  );

  return (
    <>
      {quick ? (
        <Popover open={quickOpen} onOpenChange={setQuickOpen}>
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          <PopoverContent
            align="start"
            collisionPadding={12}
            className="flex max-h-[min(85dvh,var(--radix-popover-content-available-height,85dvh))] w-[min(520px,calc(100vw-1.5rem))] flex-col overflow-hidden p-0"
            onClick={(e) => e.stopPropagation()}
            onOpenAutoFocus={(e) => e.preventDefault()}
          >
            {quickOpen && (
              <TradeQuickAdd
                tradeIds={[payload.sourceId]}
                className="min-h-0 flex-1"
                onClose={() => setQuickOpen(false)}
                onNewSetup={() => { setQuickOpen(false); setOpen(true); }}
              />
            )}
          </PopoverContent>
        </Popover>
      ) : (
        trigger
      )}
      <AddToPlaybookDialog open={open} onOpenChange={setOpen} payload={payload} />
    </>
  );
}

/** Full «Новый сетап» dialog for any source (also opened by «Новый сетап из сделки» from the trades list). */
export function AddToPlaybookDialog({ open, onOpenChange, payload }: { open: boolean; onOpenChange: (v: boolean) => void; payload: PlaybookPayload }) {
  const { t } = playbookDialogsI18n.useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const trader = user?.role === "trader" && user.traderName ? user.traderName : null;
  const [folder, setFolder] = useState("");
  const [newFolder, setNewFolder] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [name, setName] = useState(payload.name);
  const [notes, setNotes] = useState(payload.notes || "");
  const [parentSetupId, setParentSetupId] = useState("");
  const fid = useId();

  // Reset the form only when the dialog opens. `payload` is usually an inline object literal, so
  // depending on it would wipe what the user typed on every parent re-render (polling, refetch...).
  const payloadRef = useRef(payload);
  payloadRef.current = payload;
  useEffect(() => {
    if (open) {
      const p = payloadRef.current;
      setName(p.name);
      setNotes(p.notes || "");
      setFolder(readLastFolder());
      setNewFolder("");
      setCreatingFolder(false);
      setParentSetupId("");
    }
  }, [open]);

  const { data: foldersRaw, isLoading: foldersLoading } = useQuery<string[]>({
    queryKey: ["playbook-folders"],
    queryFn: ({ signal }) => http.get<string[]>("/api/playbook/folders", { signal }),
    enabled: open,
  });
  const folders = Array.isArray(foldersRaw) ? foldersRaw.filter((f) => typeof f === "string" && f) : [];

  // Remembered folder may have been deleted/renamed since — drop it once folders are known.
  useEffect(() => {
    if (open && folder && !creatingFolder && Array.isArray(foldersRaw) && !folders.includes(folder)) setFolder("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, foldersRaw]);

  const { data: allEntriesRaw } = useQuery<PlaybookEntry[]>({
    queryKey: ["playbook-all-light"],
    queryFn: ({ signal }) =>
      http
        .get<unknown>("/api/playbook", { query: { lite: 1 }, signal })
        .then((rows: unknown) => (Array.isArray(rows) ? rows : []).map((r: any) => ({
          id: r.id,
          name: r.name,
          folder: r.folder ?? null,
          parentId: r.parentId ?? null,
          sourceType: r.sourceType ?? null,
          sourceId: r.sourceId ?? null,
        }))),
    enabled: open,
  });
  const allEntries = allEntriesRaw ?? [];

  const targetFolder = creatingFolder ? newFolder.trim() : folder;

  const topLevelInFolder = useMemo(() => {
    if (!targetFolder) return [];
    return allEntries.filter((e) => e.folder === targetFolder && e.parentId === null);
  }, [allEntries, targetFolder]);

  // Already added from this exact source? Or a same-name setup in the target folder?
  const duplicateSource = useMemo(
    () => allEntries.find((e) => e.sourceType === payload.sourceType && e.sourceId === payload.sourceId) ?? null,
    [allEntries, payload.sourceType, payload.sourceId],
  );
  const sameName = useMemo(() => {
    const n = name.trim().toLowerCase();
    if (!n) return null;
    return allEntries.find((e) => e.name.trim().toLowerCase() === n && (e.folder ?? "") === (targetFolder ?? "")) ?? null;
  }, [allEntries, name, targetFolder]);

  useEffect(() => {
    setParentSetupId("");
  }, [targetFolder]);

  const openEntry = (id: number) => {
    onOpenChange(false);
    navigate(`/playbook?id=${id}`);
  };

  const saveMut = useMutation({
    mutationFn: async () => {
      const body = {
        name: name.trim(),
        folder: targetFolder || null,
        setupType: payload.setupType || null,
        conditions: payload.conditions || null,
        checklist: payload.checklist || null,
        notes: notes || null,
        confidenceLevel: payload.confidenceLevel ?? null,
        screenshotUrl: payload.screenshotUrl || null,
        screenshotNotes: payload.screenshotNotes || null,
        tags: payload.tags || null,
        sourceType: payload.sourceType,
        sourceId: payload.sourceId,
        trader,
        ticker: payload.ticker || null,
        marketCap: payload.marketCap ?? null,
        float: payload.float ?? null,
        adv: payload.adv ?? null,
        atr: payload.atr ?? null,
        relativeVolume: payload.relativeVolume ?? null,
        beta: payload.beta ?? null,
        shortInterest: payload.shortInterest ?? null,
        sector: payload.sector ?? null,
        longName: payload.longName ?? null,
        parentId: parentSetupId ? Number(parentSetupId) : null,
      };
      const created = await http.post<{ id?: number } | null>("/api/playbook", body);
      // «Новый сетап из сделки»: the trade becomes the new setup's first example (Tier 2 — the trader can re-tier it).
      if (payload.sourceType === "trade" && typeof created?.id === "number") {
        await http.post(`/api/playbook/${created.id}/examples`, { tradeIds: [payload.sourceId], tier: 2 }).catch(() => null);
      }
      return created;
    },
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ["playbook"] });
      qc.invalidateQueries({ queryKey: ["playbook-folders"] });
      qc.invalidateQueries({ queryKey: ["playbook-all-light"] });
      if (payload.sourceType === "trade") {
        for (const k of ["playbook-examples", "playbook-for-trade", "playbook-inbox", "playbook-summary", "playbook-gallery"]) qc.invalidateQueries({ queryKey: [k] });
      }
      writeLastFolder(targetFolder);
      onOpenChange(false);
      const id = created && typeof created.id === "number" ? created.id : null;
      toast({
        title: t("add.added"),
        description: targetFolder ? t("add.folder", { folder: targetFolder }) : commonI18n.t("fields.noFolder"),
        action: id ? (
          <ToastAction altText={t("add.openAlt")} onClick={() => navigate(`/playbook?id=${id}`)}>{t("add.open")}</ToastAction>
        ) : undefined,
      });
    },
    onError: (e) => {
      toast({ title: t("add.failed"), description: humanizeApiError(e), variant: "destructive" });
    },
  });

  const canSave = name.trim().length > 0 && !(creatingFolder && !newFolder.trim()) && !saveMut.isPending;
  const save = () => { if (canSave) saveMut.mutate(); };

  const previewUrl = safeHttpUrl(payload.screenshotUrl?.split("\n")[0]);
  const shotCount = (payload.screenshotUrl ?? "").split("\n").filter((u) => safeHttpUrl(u)).length;
  const tagList = (payload.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); } }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-semibold">
            <span className="grid h-8 w-8 place-items-center rounded-xl bg-primary/15 text-primary">
              <BookOpen className="h-4 w-4" aria-hidden="true" />
            </span>
            {t("add.title")}
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            {t("add.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* Source preview */}
          <div className="flex gap-3 rounded-2xl bg-[var(--glass-bg)] p-3">
            {previewUrl ? (
              <div className="relative h-16 w-24 shrink-0 overflow-hidden rounded-xl border border-[var(--field-border)]">
                <img
                  src={previewUrl}
                  alt={t("add.shotAlt")}
                  className="h-full w-full object-cover"
                  onError={(e) => { (e.target as HTMLImageElement).style.visibility = "hidden"; }}
                />
                {shotCount > 1 && (
                  <span className="absolute bottom-1 right-1 rounded-full bg-background/85 px-1.5 text-xs font-medium tabular-nums">+{shotCount - 1}</span>
                )}
              </div>
            ) : null}
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <Pill tone="neutral">{SOURCE_LABELS[payload.sourceType] ?? t("add.source")} #{payload.sourceId}</Pill>
                {payload.ticker && <Pill tone="accent">{payload.ticker.toUpperCase()}</Pill>}
                {payload.setupType && <Pill tone="purple">{payload.setupType}</Pill>}
                {payload.confidenceLevel != null && <Pill tone="neutral">{t("add.confidence", { level: payload.confidenceLevel })}</Pill>}
              </div>
              {tagList.length > 0 && (
                <p className="truncate text-xs text-muted-foreground" title={tagList.join(", ")}>
                  {tagList.slice(0, 5).join(" · ")}{tagList.length > 5 ? ` · +${tagList.length - 5}` : ""}
                </p>
              )}
              {previewUrl && <p className="text-xs text-muted-foreground">{t("add.shotsMoved")}</p>}
            </div>
          </div>

          {duplicateSource && (
            <div role="status" className="flex items-start gap-2 rounded-xl bg-[hsl(var(--chart-3)/0.12)] px-3 py-2 text-sm text-[hsl(var(--chart-3))]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                {duplicateSource.folder ? t("add.duplicateIn", { name: duplicateSource.name, folder: duplicateSource.folder }) : t("add.duplicate", { name: duplicateSource.name })}
              </span>
              <button type="button" onClick={() => openEntry(duplicateSource.id)} className="shrink-0 text-xs font-medium underline-offset-2 hover:underline">
                {t("add.open")}
              </button>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${fid}-name`} className="text-xs font-normal text-muted-foreground">{t("add.name")}</Label>
            <Input
              id={`${fid}-name`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } }}
              aria-invalid={!name.trim() || undefined}
              aria-describedby={sameName ? `${fid}-same` : undefined}
              placeholder={t("add.namePlaceholder")}
              className="h-10"
            />
            {sameName && !duplicateSource && (
              <p id={`${fid}-same`} className="text-xs text-muted-foreground">
                {t("add.sameNameBefore")}{" "}
                <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => openEntry(sameName.id)}>{t("add.sameNameOpen")}</button>
                {" "}{t("add.sameNameAfter")}
              </p>
            )}
          </div>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-xs text-muted-foreground">{t("add.folderLegend")}</legend>
            {creatingFolder ? (
              <div className="flex gap-2">
                <div className="relative min-w-0 flex-1">
                  <FolderPlus className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                  <Input
                    value={newFolder}
                    onChange={(e) => setNewFolder(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); setCreatingFolder(false); } }}
                    placeholder={t("add.newFolderPlaceholder")}
                    aria-label={t("add.newFolderPlaceholder")}
                    className="h-9 pl-10"
                    maxLength={80}
                    autoFocus
                  />
                </div>
                <Button type="button" variant="ghost" size="icon" onClick={() => setCreatingFolder(false)} aria-label={t("add.cancelNewFolder")} title={t("add.cancelNewFolder")} className="h-9 w-9">
                  <X aria-hidden="true" />
                </Button>
              </div>
            ) : (
              <div className="flex max-h-[min(30dvh,200px)] flex-wrap gap-1.5 overflow-y-auto p-0.5" role="radiogroup" aria-label={t("add.folderLegend")}>
                <FolderChip active={!folder} onClick={() => setFolder("")} icon={Inbox}>{commonI18n.t("fields.noFolder")}</FolderChip>
                {foldersLoading && <span className="inline-flex items-center px-2 text-xs text-muted-foreground"><Loader2 className="mr-1 h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />{t("add.foldersLoading")}</span>}
                {folders.map((f) => (
                  <FolderChip key={f} active={folder === f} onClick={() => setFolder(f)} icon={Folder}>{f}</FolderChip>
                ))}
                <button
                  type="button"
                  onClick={() => setCreatingFolder(true)}
                  className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-dashed border-[var(--field-border)] px-3 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" /> {t("add.newFolder")}
                </button>
              </div>
            )}
          </fieldset>

          {topLevelInFolder.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${fid}-parent`} className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
                <GitBranch className="h-3.5 w-3.5" aria-hidden="true" /> {t("add.parent")}
              </Label>
              <Select value={parentSetupId || "__none"} onValueChange={(v) => setParentSetupId(v === "__none" ? "" : v)}>
                <SelectTrigger id={`${fid}-parent`} className="h-9">
                  <SelectValue placeholder={t("add.topLevel")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none" className="text-muted-foreground">{t("add.topLevelNone")}</SelectItem>
                  {topLevelInFolder.map((e) => (
                    <SelectItem key={e.id} value={String(e.id)}>{e.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${fid}-notes`} className="text-xs font-normal text-muted-foreground">{t("add.notes")}</Label>
            <Textarea
              id={`${fid}-notes`}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder={t("add.notesPlaceholder")}
              className="resize-none text-sm"
            />
          </div>
        </div>

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:inline-flex">
            <Kbd>Ctrl</Kbd><Kbd>Enter</Kbd> {t("add.saveHint")}
          </span>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{commonI18n.t("actions.cancel")}</Button>
            <Button type="button" onClick={save} disabled={!canSave} aria-busy={saveMut.isPending}>
              {saveMut.isPending && <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
              {saveMut.isPending ? t("add.saving") : duplicateSource ? t("add.addAgain") : commonI18n.t("actions.save")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FolderChip({ active, onClick, icon: Icon, children }: { active: boolean; onClick: () => void; icon: typeof Folder; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      data-active={active}
      onClick={onClick}
      className="chip inline-flex min-h-8 max-w-[220px] items-center gap-1.5 px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      title={typeof children === "string" ? children : undefined}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{children}</span>
    </button>
  );
}
