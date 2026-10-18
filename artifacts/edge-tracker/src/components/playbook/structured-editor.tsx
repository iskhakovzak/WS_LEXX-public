/**
 * «Описание» tab: the setup as a structured card — context / trigger / entry / stop / targets / management /
 * invalidation / ideal conditions, horizon + time of day, notes, screenshots (Ctrl+V pastes an image).
 * Editors autosave (debounced PATCH /api/playbook/:id, optimistic cache update). Read-only for viewers.
 * Legacy free-text «conditions» can be split into the fields in one click («Разложить по полям»).
 */
import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ImagePlus, LayoutTemplate, Loader2, Split, StickyNote, Target, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToastAction } from "@/components/ui/toast";
import { toneText } from "@/components/ds";
import { InlineMd } from "@/components/playbook-sub/bits";
import { ScreenshotDisplay } from "@/components/screenshot-fields";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { invalidatePlaybook, notLiveMessage } from "./api";
import { http } from "@/lib/api/http";
import { imageFilesFrom, uploadPlaybookImage, usePlaybookMediaUrl } from "./media";
import { DocSection } from "./setup-bits";
import { InlineTextSection, ThesisView, structureConditions } from "./setup-document";
import {
  HORIZON_LABEL, STRUCTURED, timeOfDayOptions, type PlaybookEntry, type SetupMedia, type StructuredKey,
} from "./model";
import { commonI18n } from "@/i18n/ns/common";
import { playbookSetupI18n, type SetupTemplateId } from "@/i18n/ns/playbookSetup";

const st = playbookSetupI18n.t; // called at render / call time only

type Patch = Partial<Record<StructuredKey | "notes" | "timeOfDay" | "horizon" | "conditions", string | null>> & { media?: SetupMedia[] | null };
type SaveState = "idle" | "saving" | "saved" | "error";

/** Debounced autosave of partial patches; flushes on unmount. */
function useAutosave(entryId: number) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const pending = React.useRef<Patch>({});
  const timer = React.useRef<number | null>(null);
  const [state, setState] = React.useState<SaveState>("idle");

  const flush = React.useCallback(async () => {
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    const body = pending.current;
    if (!Object.keys(body).length) return;
    pending.current = {};
    setState("saving");
    try {
      // keepalive: the request survives a tab close / navigation that triggered the flush (browser cap ≈ 64 KB).
      await http.patch(`/api/playbook/${entryId}`, body, { keepalive: JSON.stringify(body).length < 60_000 });
      setState("saved");
      qc.invalidateQueries({ queryKey: ["playbook-revisions", entryId] });
      qc.invalidateQueries({ queryKey: ["playbook-activity", "setup", entryId] });
      qc.invalidateQueries({ queryKey: ["playbook-children"] });
    } catch (e) {
      setState("error");
      toast({ title: commonI18n.t("states.saveFailed"), description: notLiveMessage(e) ?? (e as Error)?.message, variant: "destructive" });
      invalidatePlaybook(qc, entryId);
    }
  }, [entryId, qc, toast]);

  const queue = React.useCallback((patch: Patch, immediate = false) => {
    pending.current = { ...pending.current, ...patch };
    qc.setQueryData<PlaybookEntry[]>(["playbook"], (old) => old?.map((e) => (e.id === entryId ? { ...e, ...patch } as PlaybookEntry : e)));
    setState("saving");
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, immediate ? 0 : 900);
  }, [entryId, flush, qc]);

  React.useEffect(() => () => { void flush(); }, [flush]);
  // Draft safety: send pending edits when the tab is hidden; warn before closing the tab with a save in flight.
  React.useEffect(() => {
    const onHide = () => { if (document.visibilityState === "hidden") void flush(); };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!Object.keys(pending.current).length) return;
      void flush();
      e.preventDefault();
      e.returnValue = "";
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [flush]);
  return { queue, flush, state };
}

/**
 * Starter texts for an empty card (the «Описание» tab and the new-setup form). UI templates: the text is written in
 * the current UI language and becomes the user's own text once applied.
 */
const TEMPLATE_IDS: SetupTemplateId[] = ["breakout", "pullback", "fade", "gap"];
const TEMPLATE_FIELDS = ["contextText", "triggerText", "entryText", "stopText", "targetsText", "invalidationText"] as const;
export function setupTemplates(): { id: SetupTemplateId; label: string; fields: Partial<Record<StructuredKey, string>> }[] {
  const t = playbookSetupI18n.t;
  return TEMPLATE_IDS.map((id) => ({
    id,
    label: t(`editor.templates.${id}.label`),
    fields: Object.fromEntries(TEMPLATE_FIELDS.map((f) => [f, t(`editor.templates.${id}.${f}`)])),
  }));
}

/** Legacy «Вход: … / Инвалидация: …» text → structured fields. */
function splitLegacy(text: string): Partial<Record<StructuredKey, string>> | null {
  const blocks = structureConditions(text);
  if (!blocks) return null;
  const out: Partial<Record<StructuredKey, string>> = {};
  const add = (k: StructuredKey, v: string) => { out[k] = out[k] ? `${out[k]}\n${v}` : v; };
  for (const b of blocks) {
    const v = b.lines.join("\n").trim();
    if (!v) continue;
    const k = b.key.split("-")[0];
    if (k === "thesis" || k === "intro") add("contextText", v);
    else if (k === "entry") add("entryText", v);
    else if (k === "invalid") add("invalidationText", v);
    else if (k === "targets") add("targetsText", v);
    else if (k === "mgmt") add("managementText", v);
  }
  return out;
}

export function StructuredDescription({
  entry, canEdit, live, aside,
}: {
  entry: PlaybookEntry;
  canEdit: boolean;
  /** New API (structured columns exist). Older API → legacy conditions/notes editors only. */
  live: boolean;
  aside?: React.ReactNode;
}) {
  const { t } = playbookSetupI18n.useT();
  const { toast } = useToast();
  const { queue, state } = useAutosave(entry.id);
  const [uploading, setUploading] = React.useState(0);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const filled = STRUCTURED.filter((f) => (entry[f.key] ?? "").trim());
  const anyStructured = filled.length > 0;
  const legacySplit = React.useMemo(() => (entry.conditions ? splitLegacy(entry.conditions) : null), [entry.conditions]);
  const media = entry.media ?? [];

  async function addImages(files: File[]) {
    if (!files.length || !canEdit) return;
    setUploading((n) => n + files.length);
    const added: SetupMedia[] = [];
    for (const f of files.slice(0, 6)) {
      try {
        const up = await uploadPlaybookImage(f, entry.id);
        added.push({ id: up.id, note: "" });
      } catch (e) {
        toast({ title: t("editor.shotFailed"), description: (e as Error)?.message, variant: "destructive" });
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (added.length) queue({ media: [...media, ...added] }, true);
  }

  const onPaste = (e: React.ClipboardEvent) => {
    const files = imageFilesFrom(e.clipboardData);
    if (!files.length || !canEdit || !live) return;
    e.preventDefault();
    addImages(files);
  };

  const meta = (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={entry.horizon ?? "__none"} onValueChange={(v) => queue({ horizon: v === "__none" ? null : v }, true)} disabled={!canEdit || !live}>
        <SelectTrigger className="h-8 w-auto min-w-44 gap-2 text-sm" aria-label={t("editor.horizon")}><SelectValue placeholder={t("editor.horizon")} /></SelectTrigger>
        <SelectContent>
          <SelectItem value="__none">{t("editor.horizonAny")}</SelectItem>
          {Object.entries(HORIZON_LABEL).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
        </SelectContent>
      </Select>
      <Select value={entry.timeOfDay ?? "__none"} onValueChange={(v) => queue({ timeOfDay: v === "__none" ? null : v }, true)} disabled={!canEdit || !live}>
        <SelectTrigger className="h-8 w-auto min-w-52 gap-2 text-sm" aria-label={t("editor.timeOfDay")}><SelectValue placeholder={t("editor.timeOfDay")} /></SelectTrigger>
        <SelectContent>
          <SelectItem value="__none">{t("editor.timeAny")}</SelectItem>
          {[...timeOfDayOptions(), ...(entry.timeOfDay && !timeOfDayOptions().some((o) => o.value === entry.timeOfDay) ? [{ value: entry.timeOfDay, label: entry.timeOfDay }] : [])].map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
      {canEdit && live && <SaveBadge state={state} />}
    </div>
  );

  return (
    // Sized by its own width, not the viewport: the checklist sits beside the card only when the card keeps ≥ ~700px
    // (1920 screens). Narrower (1280–1440): one column — card, then checklist / profile side by side, then notes and
    // screenshots (the left column dissolves via `contents` so `order` can slot the aside under the card).
    <div className="@container min-w-0" onPaste={onPaste}>
    <div className="grid min-w-0 gap-[var(--grid-gap)] @[68rem]:grid-cols-[minmax(0,1fr)_340px] @[68rem]:items-start">
      <div className="contents @[68rem]:flex @[68rem]:min-w-0 @[68rem]:flex-col @[68rem]:gap-[var(--grid-gap)]">
        <div className="order-1 min-w-0 @[68rem]:order-none">
        {live ? (
          <DocSection title={t("editor.card")} icon={Target} actions={meta}>
            {canEdit && !anyStructured && (
              <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-border px-3 py-2.5">
                {legacySplit ? (
                  <>
                    <span className="text-sm text-muted-foreground">{t("editor.legacyHint")}</span>
                    <Button size="sm" variant="outline" onClick={() => queue(legacySplit, true)}><Split className="h-4 w-4" aria-hidden="true" /> {t("editor.split")}</Button>
                  </>
                ) : (
                  <>
                    <LayoutTemplate className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    <span className="text-sm text-muted-foreground">{t("editor.template")}</span>
                    {setupTemplates().map((tpl) => (
                      <button key={tpl.id} type="button" onClick={() => queue(tpl.fields, true)} className="chip min-h-7 px-2.5 text-xs">{tpl.label}</button>
                    ))}
                  </>
                )}
              </div>
            )}
            {canEdit ? (
              // Two columns only when the card itself is wide enough (it shares the row with the checklist aside).
              <div className="@container">
                <div className="grid gap-3 @xl:grid-cols-2">
                  {STRUCTURED.map((f) => (
                    <FieldEditor key={`${entry.id}-${f.key}`} label={f.label} tone={f.tone} placeholder={f.placeholder} value={entry[f.key] ?? ""} onChange={(v) => queue({ [f.key]: v || null })} />
                  ))}
                </div>
              </div>
            ) : anyStructured ? (
              <div className="@container"><div className="grid gap-2 @xl:grid-cols-2">
                {filled.map((f) => (
                  <div key={f.key} className="rounded-xl bg-[var(--glass-bg)] px-3 py-2.5">
                    <div className={cn("mb-0.5 text-xs font-medium", toneText(f.tone))}>{f.label}</div>
                    <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground"><InlineMd text={entry[f.key] ?? ""} /></div>
                  </div>
                ))}
              </div></div>
            ) : entry.conditions ? (
              <ThesisView text={entry.conditions} />
            ) : (
              <p className="text-sm text-muted-foreground">{t("editor.notFilled")}</p>
            )}
            {anyStructured && entry.conditions && (
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer text-xs text-muted-foreground">{t("editor.sourceText")}</summary>
                <div className="mt-2"><ThesisView text={entry.conditions} /></div>
              </details>
            )}
          </DocSection>
        ) : (
          <InlineTextSection
            entry={entry}
            field="conditions"
            title={t("editor.thesisTitle")}
            icon={Target}
            placeholder={t("editor.thesisPlaceholder")}
            empty={t("editor.thesisEmpty")}
            render={(text) => <ThesisView text={text} />}
          />
        )}
        </div>

        <div className="order-3 min-w-0 @[68rem]:order-none">
        {live && canEdit ? (
          <DocSection title={t("editor.notesTitle")} icon={StickyNote}>
            <FieldEditor label="" tone="neutral" placeholder={t("editor.notesPlaceholderLive")} value={entry.notes ?? ""} onChange={(v) => queue({ notes: v || null })} rows={4} />
          </DocSection>
        ) : (
          <InlineTextSection entry={entry} field="notes" title={t("editor.notesTitle")} icon={StickyNote} placeholder={t("editor.notesPlaceholder")} empty={t("editor.notesEmpty")} />
        )}
        </div>

        {(entry.screenshotUrl || media.length > 0 || (canEdit && live)) && (
          <DocSection
            className="order-4 min-w-0 @[68rem]:order-none"
            title={commonI18n.t("fields.screenshots")}
            icon={ImagePlus}
            actions={canEdit && live ? (
              <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()} disabled={uploading > 0}>
                {uploading > 0 ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ImagePlus className="h-4 w-4" aria-hidden="true" />}
                {commonI18n.t("actions.add")}
              </Button>
            ) : undefined}
          >
            {entry.screenshotUrl && <ScreenshotDisplay urls={entry.screenshotUrl} notes={entry.screenshotNotes} />}
            {media.length > 0 && (
              <div className={cn("grid grid-cols-2 gap-2 lg:grid-cols-3", entry.screenshotUrl && "mt-3")}>
                {media.map((m) => (
                  <MediaTile
                    key={m.id}
                    m={m}
                    canEdit={canEdit && live}
                    onRemove={() => {
                      const before = media;
                      queue({ media: media.filter((x) => x.id !== m.id) }, true);
                      toast({
                        title: t("editor.shotRemoved"),
                        action: <ToastAction altText={t("editor.shotRestoreAlt")} onClick={() => queue({ media: before }, true)}>{t("editor.restore")}</ToastAction>,
                      });
                    }}
                  />
                ))}
              </div>
            )}
            {canEdit && live && !entry.screenshotUrl && media.length === 0 && (
              <button type="button" onClick={() => fileRef.current?.click()} className="w-full rounded-xl border border-dashed border-border px-3 py-6 text-sm text-muted-foreground hover:text-foreground">
                {t("editor.pasteHint")}
              </button>
            )}
            <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { const f = Array.from(e.target.files ?? []); e.target.value = ""; addImages(f); }} />
          </DocSection>
        )}
      </div>
      {aside && <aside className="order-2 grid min-w-0 content-start items-start gap-[var(--grid-gap)] @[44rem]:grid-cols-2 @[68rem]:order-none @[68rem]:grid-cols-1" aria-label={t("editor.asideAria")}>{aside}</aside>}
    </div>
    </div>
  );
}

function FieldEditor({
  label, tone, placeholder, value, onChange, rows = 3,
}: {
  label: string; tone: Parameters<typeof toneText>[0]; placeholder: string; value: string; onChange: (v: string) => void; rows?: number;
}) {
  const [draft, setDraft] = React.useState(value);
  const focused = React.useRef(false);
  React.useEffect(() => { if (!focused.current) setDraft(value); }, [value]);
  const id = React.useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {label && <label htmlFor={id} className={cn("text-xs font-medium", toneText(tone))}>{label}</label>}
      <Textarea
        id={id}
        value={draft}
        placeholder={placeholder}
        rows={Math.min(10, Math.max(rows, draft.split("\n").length + 1))}
        onFocus={() => { focused.current = true; }}
        onBlur={() => { focused.current = false; }}
        onChange={(e) => { setDraft(e.target.value); onChange(e.target.value); }}
        onKeyDown={(e) => e.stopPropagation()}
        className="resize-y text-sm"
        aria-label={label || placeholder}
      />
    </div>
  );
}

function SaveBadge({ state }: { state: SaveState }) {
  if (state === "idle") return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" aria-live="polite">
      {state === "saving" ? <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : state === "saved" ? <Check className="h-3 w-3" aria-hidden="true" /> : null}
      {state === "saving" ? st("editor.saving") : state === "saved" ? commonI18n.t("states.saved") : st("editor.saveError")}
    </span>
  );
}

function MediaTile({ m, canEdit, onRemove }: { m: SetupMedia; canEdit: boolean; onRemove: () => void }) {
  const url = usePlaybookMediaUrl(m.id);
  return (
    <figure className="group relative overflow-hidden rounded-xl border border-border/60">
      {url && url !== "error" ? (
        <a href={url} target="_blank" rel="noreferrer"><img src={url} alt={m.note || st("editor.shotAlt")} className="h-36 w-full object-cover" /></a>
      ) : (
        <div className={cn("grid h-36 place-items-center text-xs text-muted-foreground", url !== "error" && "animate-pulse bg-[var(--glass-bg)] motion-reduce:animate-none")}>
          {url === "error" ? st("editor.unavailable") : null}
        </div>
      )}
      {canEdit && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={st("editor.removeShot")}
          title={st("editor.removeShot")}
          className="absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-full bg-background/85 text-muted-foreground opacity-0 transition-opacity duration-[var(--dur-1)] hover:text-down focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
      {m.note && <figcaption className="px-2 py-1 text-xs text-muted-foreground">{m.note}</figcaption>}
    </figure>
  );
}
