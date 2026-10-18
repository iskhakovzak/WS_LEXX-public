import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Building2, ClipboardCheck, Clock, Gauge, Layers, ListChecks, ShieldAlert, type LucideIcon } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Segmented } from "@/components/ds";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { useRulePreview } from "./api";
import { http } from "@/lib/api/http";
import { humanizeApiError } from "@/lib/api/errors";
import { fmtRate, fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { rulesI18n } from "@/i18n/ns/rules";
import { personName } from "@/i18n";
import { rich } from "./rich";
import { autoName, type RuleDraft } from "./templates";
import type { Rule, RuleField, RuleGroup, RuleKindDef, RuleReport } from "./types";

const GROUP_ICON: Record<RuleGroup, LucideIcon> = {
  loss: ShieldAlert,
  volume: ListChecks,
  time: Clock,
  size: Gauge,
  process: Layers,
  self: ClipboardCheck,
};
const GROUP_ORDER: RuleGroup[] = ["loss", "volume", "time", "size", "process", "self"];

/** Form values are kept as strings (inputs); converted on save/preview. */
type FormValues = Record<string, string>;

function hhmmToClock(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  return `${String(Math.floor(n / 100)).padStart(2, "0")}:${String(n % 100).padStart(2, "0")}`;
}

function toForm(fields: RuleField[], th: Record<string, unknown>, useDefaults: boolean): FormValues {
  const out: FormValues = {};
  for (const f of fields) {
    const raw = th[f.key];
    const has = raw !== undefined && raw !== null && raw !== "";
    if (f.type === "tickers") out[f.key] = Array.isArray(raw) ? raw.join(", ") : has ? String(raw) : "";
    else if (f.type === "time") out[f.key] = hhmmToClock(has ? raw : useDefaults ? f.default : "");
    else out[f.key] = has ? String(raw) : useDefaults && !f.optional ? String(f.default) : "";
  }
  return out;
}

function toThreshold(fields: RuleField[], v: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = (v[f.key] ?? "").trim();
    if (!raw) continue;
    if (f.type === "tickers") out[f.key] = raw.split(/[\s,;]+/).filter(Boolean).map((x) => x.toUpperCase());
    else if (f.type === "time") out[f.key] = raw.replace(":", "");
    else out[f.key] = Number(raw.replace(",", "."));
  }
  return out;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function RuleDialog({
  open,
  onOpenChange,
  trader,
  kinds,
  editing,
  draft,
  days,
  canManageTeam,
  canManageDesk,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  trader: string;
  kinds: RuleKindDef[];
  editing: (Rule | RuleReport) | null;
  draft: RuleDraft | null;
  days: number;
  /** Staff reviewing another trader: the rule becomes an office rule. */
  canManageTeam: boolean;
  canManageDesk: boolean;
  onSaved: () => void;
}) {
  const { t } = rulesI18n.useT();
  const { toast } = useToast();
  const [kind, setKind] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [values, setValues] = useState<FormValues>({});
  const [note, setNote] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [scope, setScope] = useState<"trader" | "desk">("trader");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const kindDef = kinds.find((k) => k.kind === kind);
  const isEdit = !!editing;

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSaving(false);
    setScope("trader");
    if (editing) {
      const def = kinds.find((k) => k.kind === editing.kind);
      setKind(editing.kind);
      setName(editing.name);
      setNameTouched(true);
      setValues(toForm(def?.fields ?? [], editing.threshold ?? {}, false));
      setNote(editing.note ?? "");
      setEnabled(editing.enabled);
    } else if (draft) {
      const def = kinds.find((k) => k.kind === draft.kind);
      setKind(draft.kind);
      setName(draft.name);
      setNameTouched(true);
      setValues(toForm(def?.fields ?? [], draft.threshold ?? {}, true));
      setNote(draft.note ?? "");
      setEnabled(draft.enabled !== false);
    } else {
      setKind("");
      setName("");
      setNameTouched(false);
      setValues({});
      setNote("");
      setEnabled(true);
    }
  }, [open, editing, draft, kinds]);

  function pickKind(k: RuleKindDef) {
    setKind(k.kind);
    const v = toForm(k.fields, {}, true);
    setValues(v);
    setNameTouched(false);
    setName(autoName(k.label, k.kind, toThreshold(k.fields, v)));
    setError(null);
  }

  function setField(key: string, val: string) {
    const next = { ...values, [key]: val };
    setValues(next);
    if (!nameTouched && kindDef) setName(autoName(kindDef.label, kindDef.kind, toThreshold(kindDef.fields, next)));
  }

  const threshold = useMemo(() => (kindDef ? toThreshold(kindDef.fields, values) : null), [kindDef, values]);
  const debouncedTh = useDebounced(threshold, 400);
  const previewOn = open && !!kindDef && kindDef.auto !== false;
  const preview = useRulePreview(trader, days, kind, debouncedTh, previewOn);

  const grouped = useMemo(() => {
    const m = new Map<RuleGroup, RuleKindDef[]>();
    for (const k of kinds) {
      if (k.legacy && (k.kind === "trade_without_checklist" || k.kind === "position_size_pct" || k.kind === "max_loss_per_day_pct" || k.kind === "max_risk_per_trade_usd" || k.kind === "no_swing")) continue;
      const g = (k.group ?? "process") as RuleGroup;
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(k);
    }
    return GROUP_ORDER.filter((g) => m.has(g)).map((g) => [g, m.get(g)!] as const);
  }, [kinds]);

  async function save() {
    if (!kindDef || !threshold) return;
    const n = name.trim();
    if (!n) { setError(t("dialog.nameRequired")); return; }
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        await http.patch(`/api/rules/${editing.id}`, { name: n, threshold, enabled, note: note.trim() || null });
        toast({ title: t("dialog.updated") });
      } else {
        const body: Record<string, unknown> = { name: n, kind, threshold, enabled, note: note.trim() || null };
        if (scope === "desk") body.desk = true;
        else body.trader = trader;
        await http.post(`/api/rules`, body);
        toast({ title: t("dialog.added"), description: kindDef.auto === false ? t("dialog.addedSelf") : t("dialog.addedAuto") });
      }
      onSaved();
      onOpenChange(false);
    } catch (e) {
      setError(humanizeApiError(e, editing ? t("dialog.saveFailed") : t("dialog.createFailed")));
    } finally {
      setSaving(false);
    }
  }

  const showGallery = !isEdit && !kindDef;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn("max-h-[92dvh] overflow-y-auto", showGallery ? "max-w-3xl" : "max-w-xl")}
        onKeyDown={(e) => { if (!showGallery && (e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); if (!saving) save(); } }}
      >
        <DialogHeader>
          <DialogTitle>{showGallery ? t("dialog.newTitle") : kindDef?.label ?? t("ruleFallback")}</DialogTitle>
          <DialogDescription>
            {showGallery ? t("dialog.galleryDesc") : kindDef?.hint ?? ""}
          </DialogDescription>
        </DialogHeader>

        {showGallery ? (
          <div className="flex flex-col gap-4">
            {grouped.map(([g, list]) => {
              const Icon = GROUP_ICON[g];
              return (
                <section key={g} className="flex flex-col gap-2">
                  <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" />{t(`dialog.groups.${g}`)}
                  </h3>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {list.map((k) => (
                      <button
                        key={k.kind}
                        type="button"
                        onClick={() => pickKind(k)}
                        className="tile tile-interactive press flex min-h-[64px] flex-col items-start gap-0.5 p-3 text-left"
                      >
                        <span className="text-sm font-medium text-foreground">{k.label}</span>
                        {k.hint && <span className="line-clamp-2 text-xs text-muted-foreground">{k.hint}</span>}
                      </button>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        ) : kindDef ? (
          <div className="flex flex-col gap-4">
            {!isEdit && !draft && (
              <button type="button" onClick={() => setKind("")} className="-mt-1 inline-flex items-center gap-1 self-start text-xs font-medium text-primary hover:underline">
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> {t("dialog.otherKind")}
              </button>
            )}

            {kindDef.fields.length > 0 && (
              <div className="grid gap-3 sm:grid-cols-2">
                {kindDef.fields.map((f) => (
                  <FieldInput key={f.key} field={f} value={values[f.key] ?? ""} onChange={(v) => setField(f.key, v)} />
                ))}
              </div>
            )}

            {kindDef.auto === false && (
              <p className="rounded-xl bg-primary/10 px-3 py-2 text-sm text-foreground">
                {t("dialog.selfNote")}
              </p>
            )}

            <div className="flex flex-col gap-1">
              <Label htmlFor="rule-name" className="text-sm font-medium">{t("dialog.name")}</Label>
              <Input
                id="rule-name"
                value={name}
                maxLength={120}
                aria-invalid={!!error && !name.trim() || undefined}
                onChange={(e) => { setName(e.target.value); setNameTouched(true); setError(null); }}
              />
            </div>

            <div className="flex flex-col gap-1">
              <Label htmlFor="rule-note" className="text-sm font-medium">{t("dialog.why")} <span className="font-normal text-muted-foreground">{t("dialog.optional")}</span></Label>
              <Textarea id="rule-note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("dialog.whyPlaceholder")} />
            </div>

            {!isEdit && (canManageDesk || canManageTeam) && (
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">{t("dialog.forWhom")}</span>
                <Segmented<"trader" | "desk">
                  ariaLabel={t("dialog.forWhomAria")}
                  size="sm"
                  value={scope}
                  onChange={setScope}
                  options={[
                    { value: "trader", label: canManageTeam ? t("dialog.officeRuleFor", { name: personName(trader) }) : personName(trader) },
                    ...(canManageDesk ? [{ value: "desk" as const, label: <span className="inline-flex items-center gap-1"><Building2 className="h-3.5 w-3.5" aria-hidden="true" />{t("dialog.wholeDesk")}</span> }] : []),
                  ]}
                />
                {(scope === "desk" || canManageTeam) && (
                  <span className="text-xs text-muted-foreground">{t("dialog.officeHint")}</span>
                )}
              </div>
            )}

            {isEdit && (
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <Switch id="rule-enabled" checked={enabled} onCheckedChange={setEnabled} />
                  <Label htmlFor="rule-enabled" className="cursor-pointer text-sm">{t("dialog.active")}</Label>
                </div>
                {editing?.enabled && !enabled && (
                  <span className="text-xs text-muted-foreground">
                    {t("dialog.disableHint")}
                  </span>
                )}
              </div>
            )}

            {previewOn && <PreviewBox q={preview} days={days} />}
            {error && <p className="text-sm text-down" role="alert">{error}</p>}
          </div>
        ) : null}

        {!showGallery && (
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>{commonI18n.t("actions.cancel")}</Button>
            <Button onClick={save} disabled={saving || !kindDef}>{saving ? commonI18n.t("states.saving") : isEdit ? commonI18n.t("actions.save") : t("dialog.addRule")}</Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function FieldInput({ field, value, onChange }: { field: RuleField; value: string; onChange: (v: string) => void }) {
  const { t } = rulesI18n.useT();
  const id = `rule-f-${field.key}`;
  const placeholder = field.optional && field.riskLimit ? t("dialog.fromRiskDesk", { limit: t(`dialog.riskLimit.${field.riskLimit}`) }) : undefined;
  return (
    <div className={cn("flex flex-col gap-1", field.type === "tickers" && "sm:col-span-2")}>
      <Label htmlFor={id} className="text-sm font-medium">
        {field.label}
        {field.type === "time" && <span className="font-normal text-muted-foreground"> · ET</span>}
      </Label>
      {field.type === "tickers" ? (
        <Input id={id} value={value} placeholder="TSLA, GME, AMC" className="uppercase" onChange={(e) => onChange(e.target.value)} />
      ) : field.type === "time" ? (
        <Input id={id} type="time" step={60} value={value} className="tabular-nums" onChange={(e) => onChange(e.target.value)} />
      ) : (
        <div className="relative">
          <Input id={id} type="number" inputMode="decimal" min={0} step="any" value={value} placeholder={placeholder} className={cn("tabular-nums", field.unit && "pr-12")} onChange={(e) => onChange(e.target.value)} />
          {field.unit && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{field.unit}</span>}
        </div>
      )}
    </div>
  );
}

function PreviewBox({ q, days }: { q: ReturnType<typeof useRulePreview>; days: number }) {
  const { t } = rulesI18n.useT();
  const r = q.data;
  return (
    <div className="tile flex min-h-[84px] flex-col gap-1.5 p-3" aria-live="polite">
      <span className="text-xs font-medium text-muted-foreground">{t("dialog.previewTitle", { days })}</span>
      {q.isLoading || q.isFetching && !r ? (
        <span className="skeleton block h-5 w-3/4" aria-hidden="true" />
      ) : q.error ? (
        <span className="text-sm text-muted-foreground">{humanizeApiError(q.error, t("preview.unavailable"))}</span>
      ) : !r ? null : r.status === "no_data" ? (
        <span className="text-sm text-muted-foreground">{t("dialog.previewNoData")}</span>
      ) : r.violations === 0 ? (
        <span className="text-sm text-foreground">{t("dialog.previewClean", { days: commonI18n.t("units.tradingDays", { count: r.days }) })}</span>
      ) : (
        <>
          <span className="text-sm font-medium text-foreground">
            {t("preview.violations", { count: r.violations, violated: r.violatedDays, days: r.days })} · {t("dialog.previewCompliance", { rate: fmtRate(r.compliance) })}
          </span>
          {r.impact != null && (
            <span className="text-sm">
              {rich(t(r.impact < 0 ? "dialog.impactCost" : r.impact > 0 ? "dialog.impactGain" : "dialog.impactZero", { amount: "{amount}" }), {
                amount: <b className={cn("tabular-nums", r.impact < 0 ? "text-down" : r.impact > 0 ? "text-up" : "")}>{fmtUsd(r.impact, { decimals: "trim" })}</b>,
              })}
              {r.broken.avg != null && r.clean.avg != null && (
                <span className="text-muted-foreground"> · {t("dialog.avgCompare", { broken: fmtUsd(r.broken.avg, { signed: true, decimals: "trim" }), clean: fmtUsd(r.clean.avg, { signed: true, decimals: "trim" }) })}</span>
              )}
            </span>
          )}
        </>
      )}
    </div>
  );
}
