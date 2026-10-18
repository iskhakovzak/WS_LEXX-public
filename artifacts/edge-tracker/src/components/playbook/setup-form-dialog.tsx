/**
 * One form for create / edit / new variant (child) / duplicate.
 * Layout: fixed header and footer, scrolling body — «Сохранить» is always on screen.
 * The setup is described in the structured card (Контекст · Триггер · Вход · Стоп · Цели …) — the same fields the
 * «Описание» tab autosaves; the legacy free-text «Условия входа» shows only for setups that still have it.
 * Draft safety: the form autosaves a local draft (except duplicates) and flushes it when the dialog closes, so Esc /
 * «Отмена» / a click outside never lose typed text; unchanged form → no draft. Ctrl+Enter / Ctrl+S save.
 */
import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, FolderPlus, History, LayoutTemplate, Target } from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToastAction } from "@/components/ui/toast";
import { Kbd, Pill, toneText } from "@/components/ds";
import { IconAction } from "@/components/playbook-sub/bits";
import { ScreenshotFields } from "@/components/screenshot-fields";
import { TickerFundamentalsBar } from "@/components/ticker-fundamentals-bar";
import { PlaybookGenerateChecklistButton } from "@/components/playbook-generate-checklist";
import type { TickerFundamentals } from "@/lib/market-intel";
import { suggestTagsFromFundamentals } from "@/lib/tags";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { invalidateExamples, invalidatePlaybook } from "./api";
import { http } from "@/lib/api/http";
import {
  HORIZON_LABEL, STRUCTURED, timeOfDayOptions, blankForm, draftKey, entryToForm, formToBody, spaceOf, splitTags, tierMeta,
  type FormData, type PlaybookEntry, type Space, type StructuredKey, type Tier,
} from "./model";
import { fmtDate } from "@/lib/format";
import { SetupTypeSelect } from "./setup-type-select";
import { TagChipEditor } from "./tag-chip-editor";
import { confidenceTone } from "./setup-bits";
import { setupTemplates } from "./structured-editor";
import { commonI18n } from "@/i18n/ns/common";
import { playbookSetupI18n } from "@/i18n/ns/playbookSetup";

const LazyVoiceRecorder = React.lazy(() => import("@/components/voice-recorder").then((m) => ({ default: m.VoiceRecorder })));

export type FormMode =
  | { kind: "create"; folder?: string | null; space?: Space; fromTrade?: FromTrade }
  | { kind: "edit"; entry: PlaybookEntry }
  | { kind: "child"; parent: PlaybookEntry }
  | { kind: "duplicate"; source: PlaybookEntry; space?: Space };

/** «Новый сетап из сделки»: the trade becomes the setup's first example on save. */
export type FromTrade = { id: number; ticker: string; date?: string | null; tier: Tier };

/** Space for a new setup: explicit for create/duplicate, the parent's for a variant (API defaults otherwise). */
function spaceFor(mode: FormMode): Space | null {
  if (mode.kind === "create" || mode.kind === "duplicate") return mode.space ?? null;
  if (mode.kind === "child") return spaceOf(mode.parent);
  return spaceOf(mode.entry);
}

function storageKey(mode: FormMode): string | null {
  switch (mode.kind) {
    case "edit": return draftKey(mode.entry.id);
    case "child": return draftKey(null, mode.parent.id);
    case "create": return mode.fromTrade ? `playbook-draft-new-trade-${mode.fromTrade.id}` : draftKey(null);
    default: return null;
  }
}

function baseline(mode: FormMode): FormData {
  switch (mode.kind) {
    case "edit": return entryToForm(mode.entry);
    case "child": return { ...blankForm(), folder: mode.parent.folder ?? "", horizon: mode.parent.horizon ?? "" };
    case "duplicate": { const f = entryToForm(mode.source); return { ...f, name: playbookSetupI18n.t("form.copySuffix", { name: f.name }) }; }
    default: return { ...blankForm(), folder: mode.folder ?? "", ticker: mode.fromTrade?.ticker.slice(0, 12) ?? "" };
  }
}

function readDraft(key: string | null): FormData | null {
  if (!key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? { ...blankForm(), ...parsed } : null;
  } catch { return null; }
}
function writeDraft(key: string | null, value: FormData | null) {
  if (!key) return;
  try { if (value) window.localStorage.setItem(key, JSON.stringify(value)); else window.localStorage.removeItem(key); } catch { /* ignore */ }
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export function SetupFormDialog({
  mode, onClose, folders, onSaved, entries = [], live = true, onOpenExisting,
}: {
  mode: FormMode | null;
  onClose: () => void;
  folders: string[];
  onSaved?: (id: number | null) => void;
  /** All setups the viewer sees — for the «такой сетап уже есть» hint. */
  entries?: PlaybookEntry[];
  /** New API (structured card columns exist). Older API → legacy «Условия входа» only. */
  live?: boolean;
  onOpenExisting?: (id: number) => void;
}) {
  const { t } = playbookSetupI18n.useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const trader = user?.traderName ?? "system";
  const [form, setForm] = useState<FormData>(blankForm);
  const [isDraft, setIsDraft] = useState(false);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [tried, setTried] = useState(false);
  const [showLegacy, setShowLegacy] = useState(false);
  const baseRef = useRef("");
  const formRef = useRef(form);
  formRef.current = form;
  const nameRef = useRef<HTMLInputElement>(null);
  const key = mode ? storageKey(mode) : null;

  // (Re)initialise on open.
  useEffect(() => {
    if (!mode) return;
    const base = baseline(mode);
    baseRef.current = JSON.stringify(base);
    const draft = readDraft(storageKey(mode));
    const start = draft ?? base;
    setForm(start);
    setIsDraft(!!draft);
    setNewFolder(null);
    setTried(false);
    // Legacy free text stays editable where it exists (or when the API has no structured columns yet).
    setShowLegacy(!live || !!start.conditions.trim());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Debounced draft autosave.
  useEffect(() => {
    if (!mode || !key) return;
    const t = window.setTimeout(() => {
      const json = JSON.stringify(form);
      if (json === baseRef.current) { writeDraft(key, null); setIsDraft(false); return; }
      writeDraft(key, form);
      setIsDraft(true);
    }, 600);
    return () => window.clearTimeout(t);
  }, [form, key, mode]);

  const set = <K extends keyof FormData>(k: K, v: FormData[K]) => setForm((f) => ({ ...f, [k]: v }));
  const append = (k: "conditions" | "checklist" | "notes") => (text: string) => setForm((f) => ({ ...f, [k]: f[k] ? `${f[k]}\n${text}` : text }));

  function onFundamentals(d: TickerFundamentals) {
    setForm((prev) => {
      const next = fillFundamentals(prev, d);
      // Auto-filled facts on an untouched form are not the user's edits: no «Черновик» / draft toast for them.
      if (JSON.stringify(prev) === baseRef.current) baseRef.current = JSON.stringify(next);
      return next;
    });
  }
  function fillFundamentals(prev: FormData, d: TickerFundamentals): FormData {
    return ({
      ...prev,
      marketCap: prev.marketCap || (d.marketCap ?? ""), float: prev.float || (d.float ?? ""), adv: prev.adv || (d.averageDailyVolume ?? ""),
      atr: prev.atr || (d.atr != null ? String(d.atr) : ""), relativeVolume: prev.relativeVolume || (d.relativeVolume != null ? String(d.relativeVolume) : ""),
      beta: prev.beta || (d.beta != null ? String(d.beta) : ""), shortInterest: prev.shortInterest || (d.shortInterest != null ? String(d.shortInterest) : ""),
      sector: prev.sector || (d.sector ?? ""), longName: prev.longName || (d.longName ?? ""),
      tags: Array.from(new Set([...splitTags(prev.tags), ...suggestTagsFromFundamentals(d)])).join(", "),
    });
  }

  function discardDraft() {
    if (!mode) return;
    writeDraft(key, null);
    const base = baseline(mode);
    baseRef.current = JSON.stringify(base);
    setForm(base);
    setIsDraft(false);
  }

  /** Close without saving: keep what was typed as a draft right away (the debounce may not have fired yet). */
  function closeKeepingDraft() {
    if (mode && key && !saving) {
      const cur = formRef.current;
      if (JSON.stringify(cur) !== baseRef.current) {
        writeDraft(key, cur);
        const k = key;
        toast({
          title: t("form.draftSaved"),
          description: mode.kind === "edit" ? t("form.draftSavedEdit") : t("form.draftSavedNew"),
          action: <ToastAction altText={t("form.deleteDraftAlt")} onClick={() => writeDraft(k, null)}>{commonI18n.t("actions.delete")}</ToastAction>,
        });
      }
    }
    onClose();
  }

  const targetSpace = mode ? spaceFor(mode) : null;
  /** Owner of the personal setup being written (a curator may edit someone else's). */
  const ownerName = !mode ? null : mode.kind === "edit" ? mode.entry.trader ?? null : mode.kind === "child" ? mode.parent.trader ?? null : user?.traderName ?? null;
  const sameName = useMemo(() => {
    const n = norm(form.name);
    if (!mode || n.length < 2) return null;
    const selfId = mode.kind === "edit" ? mode.entry.id : null;
    return entries.find((e) => {
      if (e.id === selfId || norm(e.name) !== n) return false;
      const sp = spaceOf(e);
      if (targetSpace === "office") return sp === "office";
      // «Мой»: only the viewer's own personal setups clash.
      return sp === "personal" && (!ownerName || e.trader === ownerName);
    }) ?? null;
  }, [entries, form.name, mode, targetSpace, ownerName]);

  async function save() {
    if (!mode || saving) return;
    if (!form.name.trim()) { setTried(true); nameRef.current?.focus(); return; }
    if (newFolder !== null && !newFolder.trim()) { toast({ title: t("form.newFolderEmpty"), variant: "destructive" }); return; }
    const folder = newFolder !== null ? newFolder.trim() : form.folder;
    // A variant belongs to the parent's owner (a curator adding one to a trader's setup files it for that trader).
    const owner = mode.kind === "child" && spaceOf(mode.parent) === "personal" ? mode.parent.trader ?? trader : trader;
    const body = formToBody(form, folder, owner);
    if (!live) for (const f of STRUCTURED) delete (body as Record<string, unknown>)[f.key];
    setSaving(true);
    try {
      let id: number | null = null;
      if (mode.kind === "edit") {
        // Never send `trader` on edit: for staff the API reads it as «re-assign the owner» (a curator editing a
        // trader's personal setup would take it over).
        const { trader: _owner, ...patch } = body;
        await http.patch(`/api/playbook/${mode.entry.id}`, patch);
        id = mode.entry.id;
      } else {
        const parentId = mode.kind === "child" ? mode.parent.id : mode.kind === "duplicate" ? mode.source.parentId : null;
        const space = spaceFor(mode);
        const row = await http.post<{ id?: number }>("/api/playbook", { ...body, parentId, ...(space ? { space } : {}) });
        id = typeof row?.id === "number" ? row.id : null;
        const ft = mode.kind === "create" ? mode.fromTrade : undefined;
        if (ft && id != null) {
          try {
            await http.post(`/api/playbook/${id}/examples`, { tradeIds: [ft.id], tier: ft.tier });
            invalidateExamples(qc, id);
          } catch (e) {
            toast({ title: t("form.exampleFailed"), description: (e as Error)?.message, variant: "destructive" });
          }
        }
      }
      writeDraft(key, null);
      baseRef.current = JSON.stringify(form);
      setIsDraft(false);
      invalidatePlaybook(qc, id ?? undefined);
      toast({
        title: mode.kind === "edit" ? t("form.savedEdit") : mode.kind === "child" ? t("form.savedChild") : mode.kind === "duplicate" ? t("form.savedDuplicate") : t("form.savedCreate"),
        description: mode.kind === "create" && mode.fromTrade ? t("form.savedFromTrade", { ticker: mode.fromTrade.ticker, tier: tierMeta(mode.fromTrade.tier).short }) : undefined,
      });
      onSaved?.(id);
      onClose();
    } catch (e: any) {
      toast({ title: commonI18n.t("states.saveFailed"), description: e?.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  const title = !mode ? "" : mode.kind === "edit" ? t("form.titleEdit") : mode.kind === "child" ? t("form.titleChild") : mode.kind === "duplicate" ? t("form.titleDuplicate") : mode.space === "office" ? t("form.titleOffice") : mode.space === "personal" ? t("form.titleMine") : t("form.titleNew");
  const subtitle = !mode ? ""
    : mode.kind === "child" ? t("form.subtitleChild", { name: mode.parent.name })
    : mode.kind === "edit" ? mode.entry.name
    : mode.kind === "create" && mode.fromTrade ? t("form.subtitleFromTrade", { trade: `${mode.fromTrade.ticker}${mode.fromTrade.date ? ` ${fmtDate(mode.fromTrade.date, "dayMonthNumeric")}` : ""}`, tier: tierMeta(mode.fromTrade.tier).label })
    : t("form.subtitleNew");
  /** Folders of the space the setup lives in first; the rest («ещё папки») stay pickable below. */
  const folderGroups = useMemo(() => {
    const own = new Set<string>();
    for (const e of entries) {
      if (!e.folder) continue;
      const sp = spaceOf(e);
      if (targetSpace === "office" ? sp === "office" : sp === "personal" && (!ownerName || e.trader === ownerName)) own.add(e.folder);
    }
    if (form.folder) own.add(form.folder);
    const cmp = (a: string, b: string) => a.localeCompare(b, "ru");
    const primary = [...own].sort(cmp);
    const rest = [...new Set(folders)].filter((f) => !own.has(f)).sort(cmp);
    return { primary, rest };
  }, [entries, folders, form.folder, targetSpace, ownerName]);
  const conf = Number(form.confidenceLevel);
  const confValid = form.confidenceLevel !== "" && Number.isFinite(conf);
  const editId = mode?.kind === "edit" ? mode.entry.id : null;
  const structuredEmpty = STRUCTURED.every((f) => !form[f.key].trim());
  const thesisText = [...STRUCTURED.map((f) => (form[f.key].trim() ? `${f.label}: ${form[f.key].trim()}` : "")), form.conditions].filter(Boolean).join("\n");
  const nameError = tried && !form.name.trim();

  const applyTemplate = (fields: Partial<Record<StructuredKey, string>>) =>
    setForm((f) => {
      const next = { ...f };
      for (const [k, v] of Object.entries(fields) as [StructuredKey, string][]) if (!next[k].trim()) next[k] = v;
      return next;
    });

  return (
    <Dialog open={!!mode} onOpenChange={(v) => { if (!v) closeKeepingDraft(); }}>
      <DialogContent
        className="flex max-h-[min(92dvh,960px)] w-full max-w-4xl flex-col gap-0 overflow-hidden p-0"
        onKeyDown={(e) => {
          if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
          const k = e.key.toLowerCase();
          // i18n-ignore (RU keyboard layout key)
          if (k === "enter" || k === "s" || k === "ы") { e.preventDefault(); e.stopPropagation(); save(); }
        }}
      >
        <DialogHeader className="shrink-0 border-b border-border/60 px-6 pb-4 pr-14 pt-5">
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {title}
            {isDraft && (
              <>
                <Pill tone="warn"><History className="h-3 w-3" aria-hidden="true" /> {t("form.draft")}</Pill>
                <button type="button" onClick={discardDraft} className="text-xs font-normal text-muted-foreground underline underline-offset-2 hover:text-foreground">
                  {t("form.discardDraft")}
                </button>
              </>
            )}
          </DialogTitle>
          <DialogDescription className="truncate" title={subtitle}>{subtitle}</DialogDescription>
        </DialogHeader>

        <form
          id="pb-form"
          className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-6 py-5"
          onSubmit={(e) => { e.preventDefault(); save(); }}
          noValidate
        >
          {/* Basics */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="space-y-1.5">
              <Label htmlFor="pb-name" className="text-xs text-muted-foreground">{t("form.name")}</Label>
              <Input
                id="pb-name"
                ref={nameRef}
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="Earnings Gap Up"
                autoFocus
                maxLength={200}
                aria-invalid={nameError || undefined}
                aria-describedby={nameError ? "pb-name-err" : sameName ? "pb-name-same" : undefined}
                className={cn(nameError && "border-down focus-visible:ring-down")}
              />
              {nameError && <p id="pb-name-err" className="text-xs text-down">{t("form.nameError")}</p>}
              {!nameError && sameName && (
                <p id="pb-name-same" className="flex items-center gap-1.5 text-xs text-[hsl(var(--chart-3))]">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className="min-w-0">
                    {sameName.folder ? t("form.sameNameIn", { folder: sameName.folder }) : t("form.sameName")}
                    {onOpenExisting && (
                      <>
                        {" — "}
                        <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => { closeKeepingDraft(); onOpenExisting(sameName.id); }}>{t("form.open")}</button>
                      </>
                    )}
                  </span>
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pb-ticker" className="text-xs text-muted-foreground">{t("form.ticker")}</Label>
              <Input id="pb-ticker" value={form.ticker} onChange={(e) => set("ticker", e.target.value.toUpperCase().replace(/\s+/g, ""))} placeholder="NVDA" maxLength={12} />
            </div>
          </div>
          {form.ticker.length >= 1 && <TickerFundamentalsBar ticker={form.ticker} onLoaded={onFundamentals} />}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="pb-folder" className="text-xs text-muted-foreground">{t("form.folder")}</Label>
              {newFolder === null ? (
                <div className="flex gap-2">
                  <Select value={form.folder || "__none"} onValueChange={(v) => set("folder", v === "__none" ? "" : v)}>
                    <SelectTrigger id="pb-folder" className="min-w-0 flex-1"><SelectValue placeholder={commonI18n.t("fields.noFolder")} /></SelectTrigger>
                    <SelectContent className="max-h-[min(60dvh,420px)]">
                      <SelectItem value="__none">{commonI18n.t("fields.noFolder")}</SelectItem>
                      {folderGroups.primary.length > 0 && (
                        <SelectGroup>
                          <SelectLabel className="text-xs font-normal text-muted-foreground">{targetSpace === "office" ? t("form.officeFolders") : t("form.myFolders")}</SelectLabel>
                          {folderGroups.primary.map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}
                        </SelectGroup>
                      )}
                      {folderGroups.rest.length > 0 && (
                        <>
                          <SelectSeparator />
                          <SelectGroup>
                            <SelectLabel className="text-xs font-normal text-muted-foreground">{targetSpace === "office" ? t("form.personalFolders") : t("form.officeSharedFolders")}</SelectLabel>
                            {folderGroups.rest.map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}
                          </SelectGroup>
                        </>
                      )}
                    </SelectContent>
                  </Select>
                  <IconAction aria-label={t("form.newFolder")} title={t("form.newFolder")} onClick={() => setNewFolder("")} className="h-10 w-10 shrink-0"><FolderPlus /></IconAction>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Input
                    id="pb-folder"
                    value={newFolder}
                    onChange={(e) => setNewFolder(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setNewFolder(null); } }}
                    placeholder={t("form.newFolder")}
                    autoFocus
                    maxLength={80}
                    className="min-w-0 flex-1"
                  />
                  <Button type="button" variant="ghost" className="h-10 shrink-0" onClick={() => setNewFolder(null)}>{commonI18n.t("actions.cancel")}</Button>
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pb-setup-type" className="text-xs text-muted-foreground">{t("form.setupType")}</Label>
              <SetupTypeSelect id="pb-setup-type" value={form.setupType} onChange={(v) => set("setupType", v)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pb-confidence" className="flex items-center justify-between text-xs text-muted-foreground">
                {t("form.confidence")}
                <span className={confValid ? cn("font-semibold tabular-nums", toneText(confidenceTone(conf))) : "text-muted-foreground"}>
                  {confValid ? `${conf}%` : "—"}
                </span>
              </Label>
              <input
                id="pb-confidence"
                type="range"
                min={0}
                max={100}
                step={5}
                value={confValid ? conf : 70}
                onChange={(e) => set("confidenceLevel", e.target.value)}
                className="h-10 w-full accent-[hsl(var(--primary))]"
              />
            </div>
          </div>

          {/* Structured card */}
          {live && (
            <section aria-labelledby="pb-card-h" className="space-y-3 rounded-2xl border border-border/60 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h3 id="pb-card-h" className="mr-auto flex items-center gap-2 text-sm font-semibold text-foreground">
                  <Target className="h-4 w-4 text-muted-foreground" aria-hidden="true" /> {t("editor.card")}
                </h3>
                <Select value={form.horizon || "__none"} onValueChange={(v) => set("horizon", v === "__none" ? "" : v)}>
                  <SelectTrigger className="h-9 w-auto min-w-44 gap-2 text-sm" aria-label={t("editor.horizon")}><SelectValue placeholder={t("editor.horizon")} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">{t("editor.horizonAny")}</SelectItem>
                    {Object.entries(HORIZON_LABEL).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={form.timeOfDay || "__none"} onValueChange={(v) => set("timeOfDay", v === "__none" ? "" : v)}>
                  <SelectTrigger className="h-9 w-auto min-w-52 gap-2 text-sm" aria-label={t("editor.timeOfDay")}><SelectValue placeholder={t("editor.timeOfDay")} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">{t("editor.timeAny")}</SelectItem>
                    {[...timeOfDayOptions(), ...(form.timeOfDay && !timeOfDayOptions().some((o) => o.value === form.timeOfDay) ? [{ value: form.timeOfDay, label: form.timeOfDay }] : [])].map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {structuredEmpty && (
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <LayoutTemplate className="h-4 w-4" aria-hidden="true" />
                  <span>{t("form.startTemplate")}</span>
                  {setupTemplates().map((tpl) => (
                    <button key={tpl.id} type="button" onClick={() => applyTemplate(tpl.fields)} className="chip min-h-7 px-2.5 text-xs">{tpl.label}</button>
                  ))}
                </div>
              )}
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {STRUCTURED.map((f) => (
                  <div key={f.key} className="flex min-w-0 flex-col gap-1">
                    <label htmlFor={`pb-${f.key}`} className={cn("text-xs font-medium", toneText(f.tone))}>{f.label}</label>
                    <Textarea
                      id={`pb-${f.key}`}
                      value={form[f.key]}
                      onChange={(e) => set(f.key, e.target.value)}
                      placeholder={f.placeholder}
                      rows={Math.min(8, Math.max(2, form[f.key].split("\n").length + 1))}
                      className="resize-y text-sm"
                    />
                  </div>
                ))}
              </div>
              {!showLegacy && (
                <button type="button" onClick={() => setShowLegacy(true)} className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
                  {t("form.oneText")}
                </button>
              )}
            </section>
          )}

          <div className={cn("grid grid-cols-1 gap-3", showLegacy && "md:grid-cols-2")}>
            {showLegacy && (
              <div className="space-y-1.5">
                <div className="flex min-h-8 items-center justify-between gap-2">
                  <Label htmlFor="pb-conditions" className="text-xs text-muted-foreground">{live ? t("form.oneTextLabel") : t("form.conditions")}</Label>
                  <React.Suspense fallback={null}><LazyVoiceRecorder onTranscript={append("conditions")} /></React.Suspense>
                </div>
                <Textarea id="pb-conditions" value={form.conditions} onChange={(e) => set("conditions", e.target.value)} rows={5} placeholder={t("form.conditionsPlaceholder")} className="resize-y text-sm" />
              </div>
            )}
            <div className={cn("grid grid-cols-1 gap-3", !showLegacy && "md:grid-cols-2")}>
              <div className="space-y-1.5">
                <div className="flex min-h-8 items-center justify-between gap-2">
                  <Label htmlFor="pb-checklist" className="text-xs text-muted-foreground">{t("form.checklist")}</Label>
                  <div className="flex items-center gap-1">
                    <PlaybookGenerateChecklistButton
                      playbookId={editId}
                      onGenerated={(c) => set("checklist", c)}
                      conditions={thesisText}
                      notes={form.notes}
                      currentChecklist={form.checklist}
                    />
                    <React.Suspense fallback={null}><LazyVoiceRecorder onTranscript={append("checklist")} /></React.Suspense>
                  </div>
                </div>
                <Textarea id="pb-checklist" value={form.checklist} onChange={(e) => set("checklist", e.target.value)} rows={5} placeholder={t("form.checklistPlaceholder")} className="resize-y text-sm" />
              </div>
              <div className="space-y-1.5">
                <div className="flex min-h-8 items-center justify-between gap-2">
                  <Label htmlFor="pb-notes" className="text-xs text-muted-foreground">{t("form.notes")}</Label>
                  <React.Suspense fallback={null}><LazyVoiceRecorder onTranscript={append("notes")} /></React.Suspense>
                </div>
                <Textarea id="pb-notes" value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={5} className="resize-y text-sm" placeholder={t("form.notesPlaceholder")} />
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pb-tags" className="text-xs text-muted-foreground">{t("form.tags")} <span className="text-muted-foreground">{t("form.tagsHint")}</span></Label>
            <TagChipEditor id="pb-tags" value={form.tags} onChange={(v) => set("tags", v)} />
          </div>

          <div className="space-y-1.5">
            <div className="text-xs text-muted-foreground">{live ? t("form.screenshotsPaste") : t("form.screenshots")}</div>
            <ScreenshotFields
              urls={form.screenshotUrls}
              onChange={(urls) => setForm((f) => ({ ...f, screenshotUrls: urls }))}
              notes={form.screenshotNotes}
              onNotesChange={(notes) => setForm((f) => ({ ...f, screenshotNotes: notes }))}
            />
          </div>
        </form>

        <DialogFooter className="shrink-0 gap-2 border-t border-border/60 px-6 py-3 sm:items-center">
          <span className="mr-auto hidden items-center gap-1.5 text-xs text-muted-foreground sm:inline-flex">
            <Kbd keys={["Ctrl", "Enter"]} /> {t("form.or")} <Kbd keys={["Ctrl", "S"]} /> {t("form.saveHint")} <Kbd keys={["Esc"]} /> {t("form.closeHint")}
          </span>
          <Button type="button" variant="ghost" onClick={closeKeepingDraft}>{commonI18n.t("actions.cancel")}</Button>
          <Button type="submit" form="pb-form" disabled={saving} aria-busy={saving}>{saving ? t("form.saving") : commonI18n.t("actions.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
