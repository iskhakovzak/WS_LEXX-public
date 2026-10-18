import * as React from "react";
import type { MarketEvent, CreateEventBody } from "@workspace/api-client-react";
import { Tag } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Segmented } from "@/components/ds";
import { TagSelector } from "@/components/tag-selector";
import { ScreenshotFields, screenshotUrlsToString, stringToScreenshotUrls, screenshotNotesToString, stringToScreenshotNotes } from "@/components/screenshot-fields";
import { TickerFundamentalsBar } from "@/components/ticker-fundamentals-bar";
import { VoiceRecorder } from "@/components/voice-recorder";
import type { TickerFundamentals } from "@/lib/market-intel";
import { suggestTagsFromFundamentals } from "@/lib/tags";
import { nyDate } from "@/lib/trading-date";
import {
  EVENT_TYPES, REACTIONS, SESSIONS, displayTags, getSession, normType, reactionMeta, typeMeta, withSession, type Session,
} from "./event-meta";
import { eventsI18n } from "@/i18n/ns/events";
import { commonI18n } from "@/i18n/ns/common";

export type EventFormData = {
  ticker: string; date: string; eventType: string; session: Session | ""; headline: string; reaction: string;
  percentMove: string; volume: string; summary: string; screenshotUrls: string[];
  screenshotNotes: string[]; tags: string;
  marketCap: string; float: string; adv: string; atr: string; relativeVolume: string;
  beta: string; shortInterest: string; sector: string; longName: string;
};

export const blankEvent = (over: Partial<EventFormData> = {}): EventFormData => ({
  ticker: "", date: nyDate(), eventType: "earnings", session: "",
  headline: "", reaction: "", percentMove: "", volume: "", summary: "",
  screenshotUrls: [""], screenshotNotes: [""], tags: "",
  marketCap: "", float: "", adv: "", atr: "", relativeVolume: "",
  beta: "", shortInterest: "", sector: "", longName: "",
  ...over,
});

export function eventToForm(e: MarketEvent): EventFormData {
  const urls = stringToScreenshotUrls(e.screenshotUrl);
  const t = normType(e.eventType);
  return {
    ticker: e.ticker, date: e.date.substring(0, 10),
    eventType: (EVENT_TYPES as readonly string[]).includes(t) ? t : e.eventType,
    session: getSession(e) ?? "",
    headline: e.headline, reaction: e.reaction ?? "",
    percentMove: e.percentMove != null ? String(e.percentMove) : "",
    volume: e.volume ?? "", summary: e.summary ?? "",
    screenshotUrls: urls, screenshotNotes: stringToScreenshotNotes(e.screenshotNotes, urls.length),
    tags: displayTags(e.tags).join(", "),
    marketCap: e.marketCap ?? "", float: e.float ?? "", adv: e.adv ?? "",
    atr: e.atr != null ? String(e.atr) : "", relativeVolume: e.relativeVolume != null ? String(e.relativeVolume) : "",
    beta: e.beta != null ? String(e.beta) : "", shortInterest: e.shortInterest != null ? String(e.shortInterest) : "",
    sector: e.sector ?? "", longName: e.longName ?? "",
  };
}

const numOrNull = (s: string) => (s.trim() === "" || !Number.isFinite(Number(s)) ? null : Number(s));

export type EventBody = CreateEventBody & { tags?: string | null; screenshotNotes?: string | null; session?: string | null; force?: boolean };

export function formToBody(f: EventFormData): EventBody {
  // Session lives in its own column now; tags no longer carry the BMO/AMC marker.
  const tags = withSession(f.tags.split(",").map((t) => t.trim()).filter(Boolean), null);
  return {
    ticker: f.ticker.trim().toUpperCase(), date: f.date, eventType: f.eventType, headline: f.headline.trim(),
    session: f.session ? f.session.toUpperCase() : null,
    reaction: f.reaction || null, percentMove: numOrNull(f.percentMove),
    volume: f.volume || null, summary: f.summary || null,
    screenshotUrl: screenshotUrlsToString(f.screenshotUrls) || null,
    screenshotNotes: screenshotNotesToString(f.screenshotNotes) || null,
    tags: tags || null,
    marketCap: f.marketCap || null, float: f.float || null, adv: f.adv || null,
    atr: numOrNull(f.atr), relativeVolume: numOrNull(f.relativeVolume),
    beta: numOrNull(f.beta), shortInterest: numOrNull(f.shortInterest),
    sector: f.sector || null, longName: f.longName || null,
  };
}

export function SessionPicker({ value, onChange, size = "md" }: { value: Session | ""; onChange: (v: Session | "") => void; size?: "sm" | "md" }) {
  return (
    <Segmented<"none" | Session>
      ariaLabel={eventsI18n.t("form.releaseTime")}
      size={size}
      value={value || "none"}
      onChange={(v) => onChange(v === "none" ? "" : v)}
      options={[{ value: "none", label: "—" }, ...SESSIONS.map((s) => ({ value: s.value, label: <span title={s.hint}>{s.label}</span> }))]}
    />
  );
}

export function TypeSelect({ id, value, onChange }: { id?: string; value: string; onChange: (v: string) => void }) {
  const opts = (EVENT_TYPES as readonly string[]).includes(value) ? [...EVENT_TYPES] : [...EVENT_TYPES, value];
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id}><SelectValue /></SelectTrigger>
      <SelectContent>{opts.map((s) => <SelectItem key={s} value={s}>{typeMeta(s).label}</SelectItem>)}</SelectContent>
    </Select>
  );
}

const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

export function EventFormDialog({
  open, onOpenChange, editing, initial, onSubmit, saving,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: MarketEvent | null;
  initial: EventFormData;
  onSubmit: (body: ReturnType<typeof formToBody>) => void;
  saving: boolean;
}) {
  const { t } = eventsI18n.useT();
  const [form, setForm] = React.useState<EventFormData>(initial);
  React.useEffect(() => { if (open) setForm(initial); }, [open, initial]);
  const set = <K extends keyof EventFormData>(k: K, v: EventFormData[K]) => setForm((f) => ({ ...f, [k]: v }));

  function handleFundamentalsLoaded(f: TickerFundamentals) {
    setForm((prev) => {
      const suggested = suggestTagsFromFundamentals(f);
      const existing = prev.tags ? prev.tags.split(",").map((t) => t.trim()).filter(Boolean) : [];
      return {
        ...prev,
        marketCap: f.marketCap ?? prev.marketCap,
        float: f.float ?? prev.float,
        adv: f.averageDailyVolume ?? prev.adv,
        atr: f.atr != null ? String(f.atr) : prev.atr,
        relativeVolume: f.relativeVolume != null ? String(f.relativeVolume) : prev.relativeVolume,
        beta: f.beta != null ? String(f.beta) : prev.beta,
        shortInterest: f.shortInterest != null ? String(f.shortInterest) : prev.shortInterest,
        sector: f.sector ?? prev.sector,
        longName: f.longName ?? prev.longName,
        tags: Array.from(new Set([...existing, ...suggested])).join(", "),
      };
    });
  }

  // Legacy notes may carry a list («XOM, CVX, …») — editing keeps it valid while the ticker is untouched.
  const tickerOk = TICKER_RE.test(form.ticker.trim()) || (!!editing && form.ticker === editing.ticker);
  const valid = tickerOk && form.headline.trim() !== "" && /^\d{4}-\d{2}-\d{2}$/.test(form.date);
  const submit = () => { if (valid && !saving) onSubmit(formToBody(form)); };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-full max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? t("form.titleEdit", { ticker: editing.ticker }) : t("form.titleNew")}</DialogTitle>
          <DialogDescription>{t("form.description")}</DialogDescription>
        </DialogHeader>

        <div
          className="flex flex-col gap-4"
          onKeyDown={(ev) => { if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); submit(); } }}
        >
          {TICKER_RE.test(form.ticker.trim()) && <TickerFundamentalsBar ticker={form.ticker.trim()} onLoaded={handleFundamentalsLoaded} />}

          <div className="grid grid-cols-2 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
            <div className="space-y-1.5">
              <Label htmlFor="ev-ticker">{t("form.ticker")}</Label>
              <Input
                id="ev-ticker" autoFocus value={form.ticker} onChange={(e) => set("ticker", e.target.value.toUpperCase().replace(/\s+/g, ""))} placeholder="NVDA" className="uppercase"
                aria-invalid={form.ticker.trim() !== "" && !tickerOk} aria-describedby={form.ticker.trim() !== "" && !tickerOk ? "ev-ticker-err" : undefined}
              />
              {form.ticker.trim() !== "" && !tickerOk && <p id="ev-ticker-err" className="text-xs text-down">{t("form.tickerError")}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ev-date">{t("form.date")}</Label>
              <Input id="ev-date" type="date" value={form.date} onChange={(e) => set("date", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ev-type">{t("form.type")}</Label>
              <TypeSelect id="ev-type" value={form.eventType} onChange={(v) => set("eventType", v)} />
            </div>
            <div className="space-y-1.5">
              <span className="block text-sm font-medium leading-none">{t("form.releaseTime")}</span>
              <SessionPicker value={form.session} onChange={(v) => set("session", v)} size="sm" />
            </div>

            <div className="col-span-2 space-y-1.5 md:col-span-4">
              <Label htmlFor="ev-headline">{t("form.headline")}</Label>
              <Input id="ev-headline" value={form.headline} onChange={(e) => set("headline", e.target.value)} placeholder={t("form.headlinePlaceholder")} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ev-reaction">{t("form.reaction")}</Label>
              <Select value={form.reaction || "__none"} onValueChange={(v) => set("reaction", v === "__none" ? "" : v)}>
                <SelectTrigger id="ev-reaction"><SelectValue placeholder="—" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">—</SelectItem>
                  {REACTIONS.map((s) => <SelectItem key={s} value={s}>{reactionMeta(s)!.label}</SelectItem>)}
                  {form.reaction && !(REACTIONS as readonly string[]).includes(form.reaction) && (
                    <SelectItem value={form.reaction}>{reactionMeta(form.reaction)!.label}</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ev-pct">{t("form.move")}</Label>
              <Input id="ev-pct" type="number" step="0.1" inputMode="decimal" value={form.percentMove} onChange={(e) => set("percentMove", e.target.value)} placeholder="+16.4" />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="ev-volume">{t("form.volume")}</Label>
              <Input id="ev-volume" value={form.volume} onChange={(e) => set("volume", e.target.value)} placeholder={t("form.volumePlaceholder")} />
            </div>

            <div className="col-span-2 space-y-1.5 md:col-span-4">
              <div className="flex items-center justify-between">
                <Label htmlFor="ev-summary">{t("form.notes")}</Label>
                <VoiceRecorder onTranscript={(text) => setForm((f) => ({ ...f, summary: f.summary ? `${f.summary}\n${text}` : text }))} />
              </div>
              <Textarea id="ev-summary" value={form.summary} onChange={(e) => set("summary", e.target.value)} rows={3} placeholder={t("form.notesPlaceholder")} className="resize-y rounded-2xl" />
            </div>

            <div className="col-span-2 space-y-1.5 md:col-span-4">
              <span className="flex items-center gap-1.5 text-sm font-medium leading-none"><Tag className="h-3.5 w-3.5" aria-hidden="true" />{t("form.tags")}</span>
              <TagSelector
                selectedTags={form.tags ? form.tags.split(",").map((t) => t.trim()).filter(Boolean) : []}
                onChange={(tags) => set("tags", tags.join(", "))}
              />
            </div>

            <div className="col-span-2 md:col-span-4">
              <ScreenshotFields
                urls={form.screenshotUrls}
                onChange={(urls) => setForm((f) => ({ ...f, screenshotUrls: urls }))}
                notes={form.screenshotNotes}
                onNotesChange={(notes) => setForm((f) => ({ ...f, screenshotNotes: notes }))}
              />
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{commonI18n.t("actions.cancel")}</Button>
            <Button type="button" onClick={submit} disabled={saving || !valid}>{saving ? t("form.saving") : commonI18n.t("actions.save")}</Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
