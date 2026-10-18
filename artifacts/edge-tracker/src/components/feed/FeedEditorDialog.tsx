import React from "react";
import type { DailyFeed, CreateDailyFeedBody } from "@workspace/api-client-react";
import { Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { TagSelector } from "@/components/tag-selector";
import {
  ScreenshotFields, screenshotUrlsToString, stringToScreenshotUrls, screenshotNotesToString, stringToScreenshotNotes,
} from "@/components/screenshot-fields";
import { nyDate } from "@/lib/trading-date";
import { commonI18n } from "@/i18n/ns/common";
import { feedI18n } from "@/i18n/ns/feed";

const LazyVoiceRecorder = React.lazy(() => import("@/components/voice-recorder").then((m) => ({ default: m.VoiceRecorder })));

export type FeedForm = {
  date: string; whatWorksNow: string; whatDoesntWork: string; bestTickers: string; marketTheme: string;
  notes: string; tags: string; screenshotUrls: string[]; screenshotNotes: string[];
};

export const blankForm = (date = nyDate()): FeedForm => ({
  date, whatWorksNow: "", whatDoesntWork: "", bestTickers: "", marketTheme: "", notes: "", tags: "", screenshotUrls: [""], screenshotNotes: [""],
});

export function feedToForm(f: DailyFeed): FeedForm {
  const urls = stringToScreenshotUrls(f.screenshotUrl);
  return {
    date: f.date.substring(0, 10), whatWorksNow: f.whatWorksNow ?? "", whatDoesntWork: f.whatDoesntWork ?? "",
    bestTickers: f.bestTickers ?? "", marketTheme: f.marketTheme ?? "", notes: f.notes ?? "", tags: f.tags ?? "",
    screenshotUrls: urls, screenshotNotes: stringToScreenshotNotes(f.screenshotNotes, urls.length),
  };
}

export function formToBody(f: FeedForm): CreateDailyFeedBody & { tags?: string | null; screenshotUrl?: string | null; screenshotNotes?: string | null } {
  const urls = screenshotUrlsToString(f.screenshotUrls);
  return {
    date: f.date,
    whatWorksNow: f.whatWorksNow.trim() || null,
    whatDoesntWork: f.whatDoesntWork.trim() || null,
    bestTickers: f.bestTickers.trim() ? f.bestTickers.trim().toUpperCase() : null,
    marketTheme: f.marketTheme.trim() || null,
    notes: f.notes.trim() || null,
    tags: f.tags || null,
    screenshotUrl: urls || null,
    screenshotNotes: urls ? screenshotNotesToString(f.screenshotNotes) || null : null,
  };
}

export function formIsEmpty(f: FeedForm) {
  return !f.whatWorksNow.trim() && !f.whatDoesntWork.trim() && !f.bestTickers.trim() && !f.marketTheme.trim() && !f.notes.trim()
    && !f.tags && !f.screenshotUrls.some((u) => u.trim());
}

function VoiceFor({ editingId, userId, onText }: { editingId?: number; userId?: string; onText: (t: string) => void }) {
  if (!editingId) return null;
  return (
    <React.Suspense fallback={null}>
      <LazyVoiceRecorder onTranscript={onText} userId={userId} dailyFeedId={editingId} />
    </React.Suspense>
  );
}

export function FeedEditorDialog({ open, onOpenChange, form, setForm, editing, saving, onSave, userId }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  form: FeedForm;
  setForm: React.Dispatch<React.SetStateAction<FeedForm>>;
  editing: DailyFeed | null;
  saving: boolean;
  onSave: () => void;
  userId?: string;
}) {
  const { t } = feedI18n.useT();
  const set = (k: keyof FeedForm, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const append = (k: "whatWorksNow" | "whatDoesntWork" | "notes") => (text: string) =>
    setForm((f) => ({ ...f, [k]: f[k] ? `${f[k]}\n${text}` : text }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto"
        onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && form.date && !saving) { e.preventDefault(); onSave(); } }}
      >
        <DialogHeader>
          <DialogTitle>{editing ? t("editor.titleEdit") : t("editor.titleNew")}</DialogTitle>
          <DialogDescription>{t("editor.description")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
          <div className="space-y-1.5">
            <Label htmlFor="feed-date">{t("editor.date")}</Label>
            <Input id="feed-date" type="date" required aria-invalid={!form.date} value={form.date} onChange={(e) => set("date", e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="feed-theme">{t("editor.theme")}</Label>
            <Input id="feed-theme" value={form.marketTheme} onChange={(e) => set("marketTheme", e.target.value)} placeholder={t("editor.themePlaceholder")} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="feed-tickers">{t("editor.tickers")}</Label>
          <Input id="feed-tickers" value={form.bestTickers} onChange={(e) => set("bestTickers", e.target.value)} placeholder="NVDA, META, MSFT" className="uppercase" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <div className="flex min-h-8 items-center justify-between gap-2">
              <Label htmlFor="feed-works" className="text-up">{t("editor.works")}</Label>
              <VoiceFor editingId={editing?.id} userId={userId} onText={append("whatWorksNow")} />
            </div>
            <Textarea id="feed-works" value={form.whatWorksNow} onChange={(e) => set("whatWorksNow", e.target.value)} rows={3} placeholder={t("editor.worksPlaceholder")} className="resize-y" />
          </div>
          <div className="space-y-1.5">
            <div className="flex min-h-8 items-center justify-between gap-2">
              <Label htmlFor="feed-doesnt" className="text-down">{t("editor.doesntWork")}</Label>
              <VoiceFor editingId={editing?.id} userId={userId} onText={append("whatDoesntWork")} />
            </div>
            <Textarea id="feed-doesnt" value={form.whatDoesntWork} onChange={(e) => set("whatDoesntWork", e.target.value)} rows={3} placeholder={t("editor.doesntWorkPlaceholder")} className="resize-y" />
          </div>
        </div>
        <div className="space-y-1.5">
          <div className="flex min-h-8 items-center justify-between gap-2">
            <Label htmlFor="feed-notes">{t("editor.notes")}</Label>
            <VoiceFor editingId={editing?.id} userId={userId} onText={append("notes")} />
          </div>
          <Textarea id="feed-notes" value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={4} className="resize-y" />
        </div>
        <div className="space-y-1.5">
          <Label className="flex items-center gap-1.5"><Tag className="h-3.5 w-3.5" aria-hidden="true" />{t("editor.tags")}</Label>
          <TagSelector
            selectedTags={form.tags ? form.tags.split(",").map((t) => t.trim()).filter(Boolean) : []}
            onChange={(tags) => set("tags", tags.join(", "))}
          />
        </div>
        <ScreenshotFields
          urls={form.screenshotUrls}
          onChange={(urls) => setForm((f) => ({ ...f, screenshotUrls: urls }))}
          notes={form.screenshotNotes}
          onNotesChange={(notes) => setForm((f) => ({ ...f, screenshotNotes: notes }))}
        />
        {!editing && <p className="text-xs text-muted-foreground">{t("editor.voiceHint")}</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{commonI18n.t("actions.cancel")}</Button>
          <Button onClick={onSave} disabled={!form.date || saving}>{saving ? t("editor.saving") : editing ? commonI18n.t("actions.save") : t("editor.publish")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
