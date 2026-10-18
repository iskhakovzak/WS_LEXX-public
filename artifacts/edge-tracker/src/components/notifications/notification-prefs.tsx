/**
 * Preferences panel: per-type in-app on/off (grouped), per-type mute presets and a global
 * «не беспокоить» mute. Saves the whole set with PUT /notifications/prefs.
 */
import { useEffect, useMemo, useState } from "react";
import { BellOff, BellRing, Check, Loader2, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtDate } from "@/lib/format";
import { Panel, Pill } from "@/components/ds";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { GROUP_LABELS, GROUP_ORDER, SEVERITY_LABEL, SEVERITY_TONE, TYPES, iconFor, type Pref, type Prefs } from "./model";
import { useNotificationPrefs } from "./use-notifications";
import { notificationsI18n } from "@/i18n/ns/notifications";
import { commonI18n } from "@/i18n/ns/common";

type MutePreset = "none" | "1h" | "4h" | "eod" | "1d" | "7d" | "forever";
const MUTE_PRESETS: MutePreset[] = ["none", "1h", "4h", "eod", "1d", "7d", "forever"];
const presetLabel = (p: MutePreset) => notificationsI18n.t(`prefs.presets.${p}`);

function presetToIso(p: MutePreset, now = new Date()): string | null {
  const d = new Date(now);
  switch (p) {
    case "1h": d.setHours(d.getHours() + 1); return d.toISOString();
    case "4h": d.setHours(d.getHours() + 4); return d.toISOString();
    case "eod": d.setHours(23, 59, 59, 0); return d.toISOString();
    case "1d": d.setDate(d.getDate() + 1); return d.toISOString();
    case "7d": d.setDate(d.getDate() + 7); return d.toISOString();
    default: return null;
  }
}

function muteLabel(iso: string | null): string | null {
  if (!iso) return null;
  if (iso === "forever") return notificationsI18n.t("prefs.mutedForever");
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t <= Date.now()) return null;
  return notificationsI18n.t("prefs.mutedUntil", { date: fmtDate(t, "dateTime") });
}

type Draft = { byType: Record<string, Pref>; muteAll: string | null };

function toDraft(p: Prefs): Draft {
  const byType: Record<string, Pref> = {};
  for (const t of TYPES) byType[t.type] = { type: t.type, inApp: true, muteUntil: null };
  for (const pref of p.prefs) if (byType[pref.type]) byType[pref.type] = { ...byType[pref.type], ...pref, muteUntil: pref.muteUntil && Date.parse(pref.muteUntil) > Date.now() ? pref.muteUntil : null };
  return { byType, muteAll: p.muteAllUntil && (p.muteAllUntil === "forever" || Date.parse(p.muteAllUntil) > Date.now()) ? p.muteAllUntil : null };
}

function toPayload(d: Draft): Prefs {
  return {
    prefs: Object.values(d.byType).filter((p) => !p.inApp || p.muteUntil).map((p) => ({ type: p.type, inApp: p.inApp, muteUntil: p.muteUntil })),
    muteAllUntil: d.muteAll,
  };
}

export function NotificationPrefsPanel({ className }: { className?: string }) {
  const { t: tn } = notificationsI18n.useT();
  const prefs = useNotificationPrefs();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (prefs.data && !draft) setDraft(toDraft(prefs.data));
  }, [prefs.data, draft]);

  const dirty = useMemo(() => {
    if (!draft || !prefs.data) return false;
    return JSON.stringify(toPayload(draft)) !== JSON.stringify(toPayload(toDraft(prefs.data)));
  }, [draft, prefs.data]);

  const setType = (type: string, patch: Partial<Pref>) =>
    setDraft((d) => (d ? { ...d, byType: { ...d.byType, [type]: { ...d.byType[type], ...patch } } } : d));

  const setGroup = (group: string, inApp: boolean) =>
    setDraft((d) => {
      if (!d) return d;
      const byType = { ...d.byType };
      for (const t of TYPES) if (t.group === group) byType[t.type] = { ...byType[t.type], inApp };
      return { ...d, byType };
    });

  const save = async () => {
    if (!draft) return;
    const saved = await prefs.save.mutateAsync(toPayload(draft));
    setDraft(toDraft(saved));
    setSavedAt(Date.now());
  };

  if (prefs.isLoading || !draft) {
    return (
      <Panel title={tn("prefs.title")} className={className}>
        <div className="space-y-2" aria-busy="true"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-2/3" /></div>
      </Panel>
    );
  }
  if (prefs.isError) {
    return (
      <Panel title={tn("prefs.title")} className={className}>
        <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
          <span>{tn("prefs.loadFailed")}</span>
          <button type="button" onClick={() => prefs.refetch()} className="chip h-8 px-3 text-xs font-medium">{commonI18n.t("actions.retry")}</button>
        </div>
      </Panel>
    );
  }

  const muteAllPreset: MutePreset = draft.muteAll === "forever" ? "forever" : draft.muteAll ? "1h" : "none";
  const muteAllText = muteLabel(draft.muteAll);
  const offCount = Object.values(draft.byType).filter((p) => !p.inApp).length;

  return (
    <Panel
      title={tn("prefs.title")}
      description={tn("prefs.description")}
      className={className}
      actions={
        <div className="flex items-center gap-2">
          {dirty && (
            <button type="button" onClick={() => prefs.data && setDraft(toDraft(prefs.data))} className="chip inline-flex h-8 items-center gap-1 px-3 text-xs font-medium">
              <RotateCcw className="h-3 w-3" aria-hidden="true" /> {commonI18n.t("actions.reset")}
            </button>
          )}
          <button
            type="button"
            onClick={save}
            disabled={!dirty || prefs.save.isPending}
            className="inline-flex h-8 items-center gap-1.5 rounded-full bg-primary-solid px-3.5 text-xs font-medium text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.25)] disabled:opacity-50"
          >
            {prefs.save.isPending ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <Check className="h-3 w-3" aria-hidden="true" />}
            {prefs.save.isPending ? tn("prefs.saving") : savedAt && !dirty ? commonI18n.t("states.saved") : commonI18n.t("actions.save")}
          </button>
        </div>
      }
    >
      {prefs.save.isError && (
        <div role="alert" className="mb-3 rounded-xl border border-down/30 bg-down/10 px-3 py-2 text-xs text-down">
          {tn("prefs.saveFailed", { reason: (prefs.save.error as Error)?.message ?? commonI18n.t("states.error") })}
        </div>
      )}

      <div className={cn("mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-3 py-2.5", draft.muteAll ? "border-[hsl(var(--chart-3)/0.4)] bg-[hsl(var(--chart-3)/0.08)]" : "border-[var(--glass-border)] bg-[var(--glass-bg)]")}>
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-lg", draft.muteAll ? "bg-[hsl(var(--chart-3)/0.18)] text-[hsl(var(--chart-3))]" : "bg-primary/15 text-primary")}>
            {draft.muteAll ? <BellOff className="h-4 w-4" aria-hidden="true" /> : <BellRing className="h-4 w-4" aria-hidden="true" />}
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground">{tn("prefs.dnd")}</div>
            <div className="text-xs text-muted-foreground">{muteAllText ? tn("prefs.allMuted", { state: muteAllText }) : tn("prefs.allOn")}{offCount > 0 && !draft.muteAll ? ` · ${tn("prefs.typesOff", { count: offCount })}` : ""}</div>
          </div>
        </div>
        <Select value={muteAllPreset} onValueChange={(v) => setDraft((d) => (d ? { ...d, muteAll: v === "forever" ? "forever" : presetToIso(v as MutePreset) } : d))}>
          <SelectTrigger aria-label={tn("prefs.dndAria")} className="h-9 w-[210px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {MUTE_PRESETS.map((p) => <SelectItem key={p} value={p}>{p === "none" ? tn("prefs.off") : presetLabel(p)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-4">
        {GROUP_ORDER.map((group) => {
          const types = TYPES.filter((t) => t.group === group);
          if (!types.length) return null;
          const allOn = types.every((t) => draft.byType[t.type]?.inApp);
          const noneOn = types.every((t) => !draft.byType[t.type]?.inApp);
          return (
            <section key={group} aria-label={GROUP_LABELS[group]}>
              <div className="mb-1.5 flex items-center justify-between gap-2 px-1">
                <h3 className="micro-label">{GROUP_LABELS[group]}</h3>
                <button type="button" onClick={() => setGroup(group, !allOn)} className="text-2xs font-medium text-primary hover:underline">
                  {allOn ? tn("prefs.disableGroup") : noneOn ? tn("prefs.enableGroup") : tn("prefs.enableAll")}
                </button>
              </div>
              <ul className="divide-y divide-[var(--glass-border)] rounded-xl border border-[var(--glass-border)]">
                {types.map((t) => {
                  const p = draft.byType[t.type];
                  const Icon = iconFor(t.type);
                  const muted = muteLabel(p.muteUntil);
                  const preset: MutePreset = p.muteUntil ? "1h" : "none";
                  return (
                    <li key={t.type} className={cn("flex flex-wrap items-center gap-3 px-3 py-2.5", !p.inApp && "opacity-60")}>
                      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[var(--glass-bg)] text-muted-foreground">
                        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-sm font-medium text-foreground">{t.label}</span>
                          {t.severity !== "info" && <Pill tone={SEVERITY_TONE[t.severity]} className="text-2xs">{SEVERITY_LABEL[t.severity]}</Pill>}
                          {muted && p.inApp && <Pill tone="warn" className="text-2xs">{muted}</Pill>}
                        </div>
                        <div className="text-xs text-muted-foreground">{t.description}</div>
                      </div>
                      {p.inApp && (
                        <Select value={preset} onValueChange={(v) => setType(t.type, { muteUntil: presetToIso(v as MutePreset) })}>
                          <SelectTrigger aria-label={tn("prefs.muteAria", { type: t.label })} className="h-8 w-[170px] text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {MUTE_PRESETS.filter((m) => m !== "forever").map((m) => <SelectItem key={m} value={m}>{m === "1h" && p.muteUntil ? muted ?? presetLabel(m) : presetLabel(m)}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      )}
                      <Switch checked={p.inApp} onCheckedChange={(v) => setType(t.type, { inApp: v, muteUntil: v ? p.muteUntil : null })} aria-label={tn("prefs.showAria", { type: t.label })} />
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </Panel>
  );
}
