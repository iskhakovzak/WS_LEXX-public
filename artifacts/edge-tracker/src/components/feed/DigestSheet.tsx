import { useCallback, useEffect, useState } from "react";
import { Bell, Eye, Send, Sun, Moon, Mail, MessageCircle, Loader2, Info } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { FilterChip, Pill, Segmented } from "@/components/ds";
import { useAuth } from "@/contexts/auth-context";
import { useToast } from "@/hooks/use-toast";
import { http } from "@/lib/api/http";
import { humanizeApiError } from "@/lib/api/errors";
import { commonI18n } from "@/i18n/ns/common";
import { feedI18n } from "@/i18n/ns/feed";

type Channel = "none" | "telegram" | "email" | "both";
type DigestSub = {
  enabled: boolean;
  channel: Channel;
  telegramChatId: string;
  email: string;
  sendMorning: boolean;
  sendEvening: boolean;
  tradesWindowHours: number;
};

const DEFAULTS: DigestSub = {
  enabled: false, channel: "none", telegramChatId: "", email: "", sendMorning: true, sendEvening: true, tradesWindowHours: 24,
};

/** Human summary of the subscription: what arrives, where and when. */
function summary(s: DigestSub): { tone: "up" | "neutral" | "warn"; text: string } {
  const t = feedI18n.t;
  if (!s.enabled) return { tone: "neutral", text: t("digest.off") };
  if (s.channel === "none") return { tone: "warn", text: t("digest.noChannel") };
  const when = s.sendMorning && s.sendEvening ? t("digest.both") : s.sendMorning ? t("digest.morning") : s.sendEvening ? t("digest.evening") : "";
  if (!when) return { tone: "warn", text: t("digest.noTime") };
  return { tone: "up", text: t("digest.summary", { channel: t(`digest.channel.${s.channel}`), when }) };
}

/**
 * Digest preferences next to the feed itself — the digest carries the latest feed entry
 * (theme, tickers, what works) plus your trades for the chosen window.
 */
export function DigestSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const { t } = feedI18n.useT();
  const trader = user?.traderName ?? "";
  const [sub, setSub] = useState<DigestSub>(DEFAULTS);
  const [saved, setSaved] = useState<DigestSub>(DEFAULTS);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const load = useCallback(async () => {
    if (!trader) return;
    setLoading(true);
    setLoadError(null);
    try {
      // Subject = the signed-in user (server-side); no identity in the query string.
      const data = await http.get<{ subscription: Partial<DigestSub> & { telegramChatId?: string | null; email?: string | null } | null }>("/api/digest/subscription");
      const s = data.subscription;
      const next: DigestSub = s ? {
        enabled: !!s.enabled,
        channel: (["none", "telegram", "email", "both"].includes(String(s.channel)) ? s.channel : "none") as Channel,
        telegramChatId: s.telegramChatId ?? "",
        email: s.email ?? "",
        sendMorning: s.sendMorning ?? true,
        sendEvening: s.sendEvening ?? true,
        tradesWindowHours: s.tradesWindowHours ?? 24,
      } : DEFAULTS;
      setSub(next);
      setSaved(next);
    } catch (e) {
      setLoadError(humanizeApiError(e));
    } finally {
      setLoading(false);
    }
  }, [trader]);

  useEffect(() => { if (open) { load(); setPreview(null); } }, [open, load]);

  const dirty = JSON.stringify(sub) !== JSON.stringify(saved);
  const needsTg = sub.channel === "telegram" || sub.channel === "both";
  const needsEmail = sub.channel === "email" || sub.channel === "both";
  const emailInvalid = needsEmail && !!sub.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sub.email);
  const canSend = !dirty && sub.enabled && sub.channel !== "none" && (!needsTg || !!sub.telegramChatId) && (!needsEmail || (!!sub.email && !emailInvalid));
  const sum = summary(sub);

  async function save() {
    if (!trader || emailInvalid) return;
    setSaving(true);
    try {
      await http.put("/api/digest/subscription", {
        enabled: sub.enabled, channel: sub.channel,
        telegramChatId: sub.telegramChatId.trim() || null, email: sub.email.trim() || null,
        sendMorning: sub.sendMorning, sendEvening: sub.sendEvening, tradesWindowHours: sub.tradesWindowHours,
      });
      setSaved(sub);
      toast({ title: feedI18n.t("digest.saved") });
    } catch (e) {
      toast({ title: commonI18n.t("states.saveFailed"), description: humanizeApiError(e), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function showPreview() {
    if (!trader) return;
    setPreviewLoading(true);
    try {
      const data = await http.get<{ text?: string; error?: string } | null>("/api/digest/preview", { query: { hours: sub.tradesWindowHours } });
      if (!data?.text) throw new Error(data?.error ?? "HTTP 200");
      setPreview(data.text);
    } catch (e) {
      toast({ title: feedI18n.t("digest.previewUnavailable"), description: humanizeApiError(e), variant: "destructive" });
    } finally {
      setPreviewLoading(false);
    }
  }

  async function sendNow() {
    if (!trader || !canSend) return;
    setSending(true);
    try {
      const data = (await http.post<{ sent?: boolean; channels?: string[]; errors?: string[] } | null>("/api/digest/send", {})) ?? {};
      if (data.sent) toast({ title: feedI18n.t("digest.sent", { channels: (data.channels ?? []).join(", ") }) });
      else if ((data.errors ?? []).length) toast({ title: feedI18n.t("digest.deliveryError"), description: (data.errors ?? []).join("; "), variant: "destructive" });
      else toast({ title: feedI18n.t("digest.notConfigured"), variant: "destructive" });
    } catch (e) {
      toast({ title: feedI18n.t("digest.sendFailed"), description: humanizeApiError(e), variant: "destructive" });
    } finally {
      setSending(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-lg">
        <SheetHeader className="space-y-1 p-5 pb-3 text-left">
          <SheetTitle className="flex items-center gap-2"><Bell className="h-4 w-4 text-primary" aria-hidden="true" />{t("digest.title")}</SheetTitle>
          <SheetDescription>
            {t("digest.description")}
          </SheetDescription>
        </SheetHeader>

        {!trader ? (
          <p className="px-5 pb-5 text-sm text-muted-foreground">{t("digest.tradersOnly")}</p>
        ) : loading ? (
          <div className="space-y-3 px-5 pb-5" aria-busy="true" aria-label={t("digest.loadingAria")}>
            <Skeleton className="h-14 w-full rounded-xl" />
            <Skeleton className="h-9 w-full rounded-full" />
            <Skeleton className="h-9 w-2/3 rounded-full" />
          </div>
        ) : loadError ? (
          <div className="space-y-3 px-5 pb-5">
            <p className="text-sm text-down">{t("digest.loadFailed", { message: loadError })}</p>
            <Button variant="outline" onClick={load}>{commonI18n.t("actions.retry")}</Button>
          </div>
        ) : (
          <div className="flex flex-1 flex-col gap-5 px-5 pb-5">
            {/* status */}
            <div className="glass-panel flex items-center justify-between gap-3 rounded-xl p-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-foreground">{sub.enabled ? t("digest.enabled") : t("digest.disabled")}</div>
                <div className="mt-0.5"><Pill tone={sum.tone} dot>{sum.text}</Pill></div>
              </div>
              <Switch checked={sub.enabled} onCheckedChange={(v) => setSub((s) => ({ ...s, enabled: v, channel: v && s.channel === "none" ? "telegram" : s.channel }))} aria-label={t("digest.enable")} />
            </div>

            <fieldset className="space-y-2" disabled={!sub.enabled}>
              <legend className="micro-label mb-2">{t("digest.where")}</legend>
              <Segmented<Channel>
                ariaLabel={t("digest.channelAria")}
                size="sm"
                value={sub.channel}
                onChange={(v) => setSub((s) => ({ ...s, channel: v }))}
                options={[
                  { value: "telegram", label: <><MessageCircle className="h-3.5 w-3.5" aria-hidden="true" />Telegram</> },
                  { value: "email", label: <><Mail className="h-3.5 w-3.5" aria-hidden="true" />Email</> },
                  { value: "both", label: t("digest.bothOption") },
                  { value: "none", label: t("digest.noneOption") },
                ]}
              />
              {needsTg && (
                <div className="space-y-1 pt-1">
                  <Label htmlFor="digest-tg">Telegram Chat ID</Label>
                  <Input id="digest-tg" value={sub.telegramChatId} onChange={(e) => setSub((s) => ({ ...s, telegramChatId: e.target.value }))} placeholder={t("digest.tgPlaceholder")} />
                  <p className="flex items-start gap-1 text-xs text-muted-foreground">
                    <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                    {t("digest.tgHint")}
                  </p>
                </div>
              )}
              {needsEmail && (
                <div className="space-y-1 pt-1">
                  <Label htmlFor="digest-email">Email</Label>
                  <Input id="digest-email" type="email" autoComplete="email" aria-invalid={emailInvalid} value={sub.email} onChange={(e) => setSub((s) => ({ ...s, email: e.target.value }))} placeholder="trader@example.com" />
                  {emailInvalid && <p className="text-xs text-down">{t("digest.emailInvalid")}</p>}
                </div>
              )}
            </fieldset>

            <fieldset className="space-y-2" disabled={!sub.enabled}>
              <legend className="micro-label mb-2">{t("digest.when")}</legend>
              <div className="flex flex-wrap gap-2">
                <FilterChip active={sub.sendMorning} onClick={() => setSub((s) => ({ ...s, sendMorning: !s.sendMorning }))}>
                  <Sun className="h-3.5 w-3.5" aria-hidden="true" />{t("digest.morningChip")}
                </FilterChip>
                <FilterChip active={sub.sendEvening} onClick={() => setSub((s) => ({ ...s, sendEvening: !s.sendEvening }))}>
                  <Moon className="h-3.5 w-3.5" aria-hidden="true" />{t("digest.eveningChip")}
                </FilterChip>
              </div>
            </fieldset>

            <fieldset className="space-y-2" disabled={!sub.enabled}>
              <legend className="micro-label mb-2">{t("digest.window")}</legend>
              <Segmented<string>
                ariaLabel={t("digest.windowAria")}
                size="sm"
                value={String(sub.tradesWindowHours)}
                onChange={(v) => setSub((s) => ({ ...s, tradesWindowHours: Number(v) }))}
                options={[12, 24, 48, 72].map((h) => ({ value: String(h), label: t("digest.hours", { count: h }) }))}
              />
            </fieldset>

            <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-border pt-4">
              <Button onClick={save} disabled={!dirty || saving || emailInvalid}>
                {saving && <Loader2 className="animate-spin" aria-hidden="true" />}
                {saving ? t("digest.saving") : dirty ? commonI18n.t("actions.save") : commonI18n.t("states.saved")}
              </Button>
              <Button variant="outline" onClick={showPreview} disabled={previewLoading}>
                {previewLoading ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Eye aria-hidden="true" />}
                {t("digest.showPreview")}
              </Button>
              <Button variant="ghost" onClick={sendNow} disabled={!canSend || sending} title={dirty ? t("digest.saveFirst") : undefined}>
                {sending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
                {t("digest.sendNow")}
              </Button>
            </div>
            {dirty && <p className="-mt-3 text-xs text-muted-foreground">{t("digest.unsaved")}</p>}

            {preview && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="micro-label">{t("digest.preview")}</span>
                  <button type="button" onClick={() => setPreview(null)} className="text-xs text-muted-foreground hover:text-foreground">{commonI18n.t("actions.hide")}</button>
                </div>
                <pre className="glass-panel whitespace-pre-wrap break-words rounded-xl p-3 font-sans text-xs leading-relaxed text-foreground">{preview}</pre>
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
