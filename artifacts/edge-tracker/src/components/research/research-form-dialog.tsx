import { useEffect, useState } from "react";
import type { CreateResearchBody, Research } from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { TagSelector } from "@/components/tag-selector";
import { TickerFundamentalsBar } from "@/components/ticker-fundamentals-bar";
import { VoiceRecorder } from "@/components/voice-recorder";
import {
  ScreenshotFields,
  screenshotNotesToString,
  screenshotUrlsToString,
  stringToScreenshotNotes,
  stringToScreenshotUrls,
} from "@/components/screenshot-fields";
import { suggestTagsFromFundamentals } from "@/lib/tags";
import type { TickerFundamentals } from "@/lib/market-intel";
import { FilterChip, Pill } from "@/components/ds";
import { nyDate } from "@/lib/trading-date";
import { RESEARCH_TEMPLATES, confidencePct, confidenceTone, noteDay } from "./research-utils";
import { commonI18n } from "@/i18n/ns/common";
import { researchI18n } from "@/i18n/ns/research";

export type ResearchFormData = {
  date: string;
  patternName: string; ticker: string; context: string; marketCondition: string;
  whatWorked: string; whatFailed: string; repeatCount: string; confidenceLevel: string;
  screenshotUrls: string[]; screenshotNotes: string[]; tags: string;
  marketCap: string; float: string; adv: string; atr: string; relativeVolume: string;
  beta: string; shortInterest: string; sector: string; longName: string;
};

export const blankResearch = (): ResearchFormData => ({
  date: nyDate(),
  patternName: "", ticker: "", context: "", marketCondition: "",
  whatWorked: "", whatFailed: "", repeatCount: "1", confidenceLevel: "50",
  screenshotUrls: [""], screenshotNotes: [""], tags: "",
  marketCap: "", float: "", adv: "", atr: "", relativeVolume: "",
  beta: "", shortInterest: "", sector: "", longName: "",
});

export function researchToForm(r: Research): ResearchFormData {
  const urls = stringToScreenshotUrls(r.screenshotUrl);
  return {
    date: noteDay(r),
    patternName: r.patternName, ticker: r.ticker ?? "", context: r.context ?? "",
    marketCondition: r.marketCondition ?? "", whatWorked: r.whatWorked ?? "",
    whatFailed: r.whatFailed ?? "", repeatCount: String(r.repeatCount ?? 1),
    confidenceLevel: String(confidencePct(r.confidenceLevel) ?? 50),
    screenshotUrls: urls, screenshotNotes: stringToScreenshotNotes(r.screenshotNotes, urls.length),
    tags: r.tags ?? "",
    marketCap: r.marketCap ?? "", float: r.float ?? "", adv: r.adv ?? "",
    atr: r.atr != null ? String(r.atr) : "", relativeVolume: r.relativeVolume != null ? String(r.relativeVolume) : "",
    beta: r.beta != null ? String(r.beta) : "", shortInterest: r.shortInterest != null ? String(r.shortInterest) : "",
    sector: r.sector ?? "", longName: r.longName ?? "",
  };
}

const numOrNull = (s: string) => {
  if (!s.trim()) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

export function formToResearchBody(f: ResearchFormData): CreateResearchBody & { tags?: string | null; screenshotNotes?: string | null; date?: string | null } {
  return {
    date: /^\d{4}-\d{2}-\d{2}$/.test(f.date) ? f.date : null,
    patternName: f.patternName.trim(), ticker: f.ticker.trim() || null, context: f.context || null,
    marketCondition: f.marketCondition || null, whatWorked: f.whatWorked || null,
    whatFailed: f.whatFailed || null,
    repeatCount: numOrNull(f.repeatCount),
    confidenceLevel: numOrNull(f.confidenceLevel),
    screenshotUrl: screenshotUrlsToString(f.screenshotUrls) || null,
    screenshotNotes: screenshotNotesToString(f.screenshotNotes) || null,
    tags: f.tags || null,
    marketCap: f.marketCap || null, float: f.float || null, adv: f.adv || null,
    atr: numOrNull(f.atr), relativeVolume: numOrNull(f.relativeVolume),
    beta: numOrNull(f.beta), shortInterest: numOrNull(f.shortInterest),
    sector: f.sector || null, longName: f.longName || null,
  };
}

const confLabel = (tone: "up" | "warn" | "down" | "neutral") => (tone === "neutral" ? "—" : researchI18n.t(`form.conf.${tone}`));

export function ResearchFormDialog({
  open,
  editing,
  initial,
  saving,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  editing: Research | null;
  /** Prefill for a new note (e.g. from the earnings sheet). */
  initial?: Partial<ResearchFormData> | null;
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (form: ResearchFormData) => void;
}) {
  const { t: tr } = researchI18n.useT();
  const [form, setForm] = useState<ResearchFormData>(blankResearch());
  const [template, setTemplate] = useState<string | null>(null);

  // Reset only when the dialog opens.
  useEffect(() => {
    if (!open) return;
    setForm(editing ? researchToForm(editing) : { ...blankResearch(), ...(initial ?? {}) });
    setTemplate(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing]);

  function set<K extends keyof ResearchFormData>(k: K, v: ResearchFormData[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function applyTemplate(id: string) {
    const t = RESEARCH_TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    setTemplate(id);
    setForm((f) => {
      const tags = Array.from(new Set([...f.tags.split(",").map((s) => s.trim()).filter(Boolean), ...(t.tags ? [t.tags] : [])]));
      const name = t.patternName && f.ticker && !t.patternName.endsWith(": ") ? `${t.patternName} — ${f.ticker}` : t.patternName;
      return {
        ...f,
        patternName: f.patternName.trim() ? f.patternName : name,
        context: f.context.trim() ? f.context : t.context,
        marketCondition: f.marketCondition || t.marketCondition || "",
        tags: tags.join(", "),
      };
    });
  }

  function handleFundamentalsLoaded(fd: TickerFundamentals) {
    setForm((prev) => {
      const suggested = suggestTagsFromFundamentals(fd);
      const existing = prev.tags ? prev.tags.split(",").map((t) => t.trim()).filter(Boolean) : [];
      const merged = Array.from(new Set([...existing, ...suggested]));
      return {
        ...prev,
        marketCap: fd.marketCap ?? prev.marketCap,
        float: fd.float ?? prev.float,
        adv: fd.averageDailyVolume ?? prev.adv,
        atr: fd.atr != null ? String(fd.atr) : prev.atr,
        relativeVolume: fd.relativeVolume != null ? String(fd.relativeVolume) : prev.relativeVolume,
        beta: fd.beta != null ? String(fd.beta) : prev.beta,
        shortInterest: fd.shortInterest != null ? String(fd.shortInterest) : prev.shortInterest,
        sector: fd.sector ?? prev.sector,
        longName: fd.longName ?? prev.longName,
        tags: merged.join(", "),
      };
    });
  }

  const conf = Number(form.confidenceLevel) || 0;
  const tone = confidenceTone(conf);
  const canSave = !!form.patternName.trim() && !saving;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-full max-w-3xl overflow-y-auto">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave) onSubmit(form);
          }}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && canSave) {
              e.preventDefault();
              onSubmit(form);
            }
          }}
          className="space-y-5"
        >
          <DialogHeader>
            <DialogTitle>{editing ? tr("form.titleEdit") : tr("form.titleNew")}</DialogTitle>
            <DialogDescription>
              {tr("form.description")}
            </DialogDescription>
          </DialogHeader>

          {!editing && (
            <div className="space-y-2">
              <div className="micro-label">{tr("form.template")}</div>
              <div className="flex flex-wrap gap-2">
                {RESEARCH_TEMPLATES.map((t) => (
                  <FilterChip key={t.id} active={template === t.id} onClick={() => applyTemplate(t.id)} className="min-h-8 text-xs">
                    {t.label}
                  </FilterChip>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-5">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="rs-pattern">{tr("form.name")}</Label>
              <Input
                id="rs-pattern"
                autoFocus
                value={form.patternName}
                onChange={(e) => set("patternName", e.target.value)}
                placeholder="Earnings gap and go"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rs-ticker">{tr("form.ticker")}</Label>
              <Input
                id="rs-ticker"
                value={form.ticker}
                onChange={(e) => set("ticker", e.target.value.toUpperCase())}
                placeholder="NVDA, META"
                autoCapitalize="characters"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rs-date">{tr("form.tradingDay")}</Label>
              <Input id="rs-date" type="date" value={form.date} onChange={(e) => set("date", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rs-repeat">{tr("form.repeats")}</Label>
              <Input id="rs-repeat" type="number" inputMode="numeric" min="1" value={form.repeatCount} onChange={(e) => set("repeatCount", e.target.value)} />
            </div>
          </div>

          {form.ticker.trim().length >= 1 && <TickerFundamentalsBar ticker={form.ticker} onLoaded={handleFundamentalsLoaded} />}

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="rs-confidence">{tr("form.confidence")}</Label>
              <Pill tone={tone}>
                {conf}% · {confLabel(tone)}
              </Pill>
            </div>
            <Slider
              id="rs-confidence"
              aria-label={tr("form.confidence")}
              min={0}
              max={100}
              step={5}
              value={[conf]}
              onValueChange={([v]) => set("confidenceLevel", String(v))}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="rs-context">{tr("form.context")}</Label>
              <VoiceRecorder onTranscript={(text) => set("context", form.context ? `${form.context}\n${text}` : text)} />
            </div>
            <Textarea id="rs-context" value={form.context} onChange={(e) => set("context", e.target.value)} rows={4} className="resize-y" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="rs-market">{tr("form.market")}</Label>
            <Input id="rs-market" value={form.marketCondition} onChange={(e) => set("marketCondition", e.target.value)} placeholder={tr("form.marketPlaceholder")} />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="rs-worked" className="text-up">{tr("form.worked")}</Label>
                <VoiceRecorder onTranscript={(text) => set("whatWorked", form.whatWorked ? `${form.whatWorked}\n${text}` : text)} />
              </div>
              <Textarea id="rs-worked" value={form.whatWorked} onChange={(e) => set("whatWorked", e.target.value)} rows={4} className="resize-y" />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="rs-failed" className="text-down">{tr("form.failed")}</Label>
                <VoiceRecorder onTranscript={(text) => set("whatFailed", form.whatFailed ? `${form.whatFailed}\n${text}` : text)} />
              </div>
              <Textarea id="rs-failed" value={form.whatFailed} onChange={(e) => set("whatFailed", e.target.value)} rows={4} className="resize-y" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>{tr("form.tags")}</Label>
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

          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {commonI18n.t("actions.cancel")}
            </Button>
            <Button type="submit" disabled={!canSave}>
              {saving ? tr("form.saving") : commonI18n.t("actions.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
