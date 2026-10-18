import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import type { LimitsInput, RiskLimits } from "./use-risk";
import { ApiError } from "@/lib/api/http";
import { useSaveLimits } from "./use-risk";
import { TIERS, tierLabel } from "./primitives";
import { fmtDate, fmtUsd } from "@/lib/format";
import { riskI18n } from "@/i18n/ns/risk";
import { personName } from "@/i18n";
import { commonI18n } from "@/i18n/ns/common";

/** Scaling plan: default limits per tier (curator can override any field). */
export const TIER_PRESETS: Record<string, Omit<LimitsInput, "tier" | "notes">> = {
  trainee: { accountSize: 10_000, dailyLossLimit: 150, weeklyLossLimit: 400, maxDrawdown: 800, maxRiskPerTrade: 50, maxPositionUsd: 10_000, maxOvernightExposure: 0, maxOpenPositions: 2, allowOvernight: false, allowSwing: false },
  junior: { accountSize: 25_000, dailyLossLimit: 300, weeklyLossLimit: 900, maxDrawdown: 2_000, maxRiskPerTrade: 100, maxPositionUsd: 25_000, maxOvernightExposure: 5_000, maxOpenPositions: 3, allowOvernight: false, allowSwing: false },
  trader: { accountSize: 50_000, dailyLossLimit: 600, weeklyLossLimit: 1_800, maxDrawdown: 4_000, maxRiskPerTrade: 200, maxPositionUsd: 50_000, maxOvernightExposure: 20_000, maxOpenPositions: 5, allowOvernight: true, allowSwing: false },
  senior: { accountSize: 100_000, dailyLossLimit: 1_200, weeklyLossLimit: 3_500, maxDrawdown: 8_000, maxRiskPerTrade: 400, maxPositionUsd: 100_000, maxOvernightExposure: 50_000, maxOpenPositions: 8, allowOvernight: true, allowSwing: true },
  lead: { accountSize: 250_000, dailyLossLimit: 2_500, weeklyLossLimit: 7_000, maxDrawdown: 15_000, maxRiskPerTrade: 800, maxPositionUsd: 250_000, maxOvernightExposure: 120_000, maxOpenPositions: 12, allowOvernight: true, allowSwing: true },
};

const clean = (s: string) => s.replace(/[\s,]/g, "");

/** Built per mount (messages follow the UI language; a language switch re-mounts the tree). */
function buildSchema() {
  const t = riskI18n.t;
  const moneyStr = z
    .string()
    .trim()
    .refine((s) => s === "" || (/^\d+(\.\d{1,2})?$/.test(clean(s)) && Number(clean(s)) <= 1e12), t("form.errMoney"));
  const intStr = z.string().trim().refine((s) => s === "" || (/^\d+$/.test(s) && Number(s) <= 1000), t("form.errInt"));
  return z
    .object({
      tier: z.string(),
      accountSize: moneyStr,
      dailyLossLimit: moneyStr,
      weeklyLossLimit: moneyStr,
      maxDrawdown: moneyStr,
      maxRiskPerTrade: moneyStr,
      maxPositionUsd: moneyStr,
      maxOvernightExposure: moneyStr,
      maxOpenPositions: intStr,
      allowOvernight: z.boolean(),
      allowSwing: z.boolean(),
      notes: z.string().max(2000, t("form.errMax", { max: 2000 })),
      reason: z.string().max(500, t("form.errMax", { max: 500 })),
    })
    .superRefine((v, ctx) => {
      const n = (s: string) => (s === "" ? null : Number(clean(s)));
      const d = n(v.dailyLossLimit), w = n(v.weeklyLossLimit), dd = n(v.maxDrawdown), r = n(v.maxRiskPerTrade);
      if (d != null && w != null && w < d) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["weeklyLossLimit"], message: t("form.errWeekly") });
      if (d != null && r != null && r > d) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["maxRiskPerTrade"], message: t("form.errRisk") });
      if (d != null && dd != null && dd < d) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["maxDrawdown"], message: t("form.errDrawdown") });
    });
}

type FormValues = z.infer<ReturnType<typeof buildSchema>>;

const s = (v: number | null | undefined) => (v == null ? "" : String(v));
const toNum = (v: string) => (v.trim() === "" ? null : Number(clean(v)));

function toForm(l: RiskLimits | null): FormValues {
  return {
    tier: l?.tier ?? "",
    accountSize: s(l?.accountSize),
    dailyLossLimit: s(l?.dailyLossLimit),
    weeklyLossLimit: s(l?.weeklyLossLimit),
    maxDrawdown: s(l?.maxDrawdown),
    maxRiskPerTrade: s(l?.maxRiskPerTrade),
    maxPositionUsd: s(l?.maxPositionUsd),
    maxOvernightExposure: s(l?.maxOvernightExposure),
    maxOpenPositions: s(l?.maxOpenPositions),
    allowOvernight: l?.allowOvernight ?? true,
    allowSwing: l?.allowSwing ?? true,
    notes: l?.notes ?? "",
    reason: "",
  };
}

type MoneyField = "accountSize" | "maxPositionUsd" | "dailyLossLimit" | "weeklyLossLimit" | "maxDrawdown" | "maxRiskPerTrade" | "maxOvernightExposure";
const MONEY_FIELDS: { name: MoneyField; hint?: "accountSize" | "dailyLossLimit" | "maxRiskPerTrade" | "maxOvernightExposure" }[] = [
  { name: "accountSize", hint: "accountSize" },
  { name: "maxPositionUsd" },
  { name: "dailyLossLimit", hint: "dailyLossLimit" },
  { name: "weeklyLossLimit" },
  { name: "maxDrawdown" },
  { name: "maxRiskPerTrade", hint: "maxRiskPerTrade" },
  { name: "maxOvernightExposure", hint: "maxOvernightExposure" },
];
const NUMBER_FIELDS: (MoneyField | "maxOpenPositions")[] = [...MONEY_FIELDS.map((f) => f.name), "maxOpenPositions"];

export function LimitsForm({ trader, limits, onSaved }: { trader: string; limits: RiskLimits | null; onSaved?: () => void }) {
  const { toast } = useToast();
  const { t } = riskI18n.useT();
  const save = useSaveLimits(trader);
  const schema = React.useMemo(() => buildSchema(), []);
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: toForm(limits) });

  // Reset when switching trader or after server data changes (not while user edits).
  const key = `${trader}|${limits?.updatedAt ?? ""}`;
  React.useEffect(() => {
    form.reset(toForm(limits));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const tier = form.watch("tier");
  const preset = TIER_PRESETS[tier];
  const applyPreset = (code: string = tier) => {
    const p = TIER_PRESETS[code];
    if (!p) return;
    (Object.keys(p) as (keyof typeof p)[]).forEach((k) => {
      const v = p[k];
      form.setValue(k as keyof FormValues, (typeof v === "boolean" ? v : s(v as number | null)) as never, { shouldDirty: true, shouldValidate: true });
    });
  };

  // Prefill: picking a tier on an empty form fills the tier's limits; a tier change suggests the reason.
  const onTierChange = (code: string, set: (v: string) => void) => {
    set(code);
    const empty = NUMBER_FIELDS.every((f) => !String(form.getValues(f) ?? "").trim());
    if (empty && TIER_PRESETS[code]) applyPreset(code);
    const before = limits?.tier ?? "";
    if (!form.getValues("reason").trim() && limits && code !== before) {
      const name = (c: string) => tierLabel(c) ?? commonI18n.t("tiers.noTier");
      form.setValue("reason", t("form.reasonTier", { from: name(before), to: name(code) }), { shouldDirty: true });
    }
  };

  const placeholderFor = (name: MoneyField | "maxOpenPositions") => {
    const v = preset?.[name];
    if (v == null) return t("form.notSet");
    return t("form.byTier", { value: name === "maxOpenPositions" ? String(v) : fmtUsd(v as number, { decimals: 0 }) });
  };

  const onSubmit = (v: FormValues) => {
    const body: LimitsInput = {
      tier: v.tier || null,
      accountSize: toNum(v.accountSize),
      dailyLossLimit: toNum(v.dailyLossLimit),
      weeklyLossLimit: toNum(v.weeklyLossLimit),
      maxDrawdown: toNum(v.maxDrawdown),
      maxRiskPerTrade: toNum(v.maxRiskPerTrade),
      maxPositionUsd: toNum(v.maxPositionUsd),
      maxOvernightExposure: toNum(v.maxOvernightExposure),
      maxOpenPositions: toNum(v.maxOpenPositions),
      allowOvernight: v.allowOvernight,
      allowSwing: v.allowSwing,
      notes: v.notes.trim() || null,
      reason: v.reason.trim() || null,
    };
    save.mutate(body, {
      onSuccess: () => {
        toast({ title: t("form.saved"), description: personName(trader) });
        onSaved?.();
      },
      onError: (e) => {
        // Server-side validation: map each issue to its field; the rest goes to the toast.
        const issues = e instanceof ApiError ? e.field<{ path: string; message: string }[]>("issues") ?? [] : [];
        let mapped = 0;
        for (const it of issues) {
          const path = String(it.path ?? "");
          if (path && path in toForm(null)) {
            form.setError(path as keyof FormValues, { type: "server", message: it.message });
            mapped++;
          }
        }
        toast({
          title: commonI18n.t("states.saveFailed"),
          description: mapped ? t("form.checkFields", { list: issues.map((i) => i.message).join("; ") }) : (e as Error).message,
          variant: "destructive",
        });
      },
    });
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
        <div className="flex flex-wrap items-end gap-2">
          <FormField
            control={form.control}
            name="tier"
            render={({ field }) => (
              <FormItem className="min-w-[180px] flex-1">
                <FormLabel>{t("form.tier")}</FormLabel>
                <Select value={field.value || "none"} onValueChange={(v) => onTierChange(v === "none" ? "" : v, field.onChange)}>
                  <FormControl>
                    <SelectTrigger><SelectValue placeholder={commonI18n.t("tiers.noTier")} /></SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="none">{commonI18n.t("tiers.noTier")}</SelectItem>
                    {TIERS.map((x, i) => (
                      <SelectItem key={x.value} value={x.value}>
                        {t("form.tierOption", { n: i + 1, label: x.label, bp: fmtUsd(TIER_PRESETS[x.value]?.maxPositionUsd ?? null, { decimals: 0, compact: 10_000 }) })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button type="button" variant="outline" size="sm" onClick={() => applyPreset()} disabled={!preset}>
            <Wand2 className="mr-1.5 h-4 w-4" aria-hidden="true" />
            {t("form.applyPreset")}
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {MONEY_FIELDS.map((f) => (
            <FormField
              key={f.name}
              control={form.control}
              name={f.name}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t(`form.field.${f.name}`)}</FormLabel>
                  <FormControl>
                    <Input inputMode="decimal" placeholder={placeholderFor(f.name)} autoComplete="off" {...field} value={field.value as string} />
                  </FormControl>
                  {f.hint && <FormDescription className="text-2xs">{t(`form.hint.${f.hint}`)}</FormDescription>}
                  <FormMessage />
                </FormItem>
              )}
            />
          ))}
          <FormField
            control={form.control}
            name="maxOpenPositions"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("form.maxOpen")}</FormLabel>
                <FormControl>
                  <Input inputMode="numeric" placeholder={placeholderFor("maxOpenPositions")} autoComplete="off" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {([
            { name: "allowOvernight", label: t("form.allowOvernight"), hint: t("form.allowOvernightHint") },
            { name: "allowSwing", label: t("form.allowSwing"), hint: t("form.allowSwingHint") },
          ] as const).map((f) => (
            <FormField
              key={f.name}
              control={form.control}
              name={f.name}
              render={({ field }) => (
                <FormItem className="flex items-center justify-between gap-3 rounded-xl bg-[var(--glass-bg)] px-3 py-2.5 ring-1 ring-inset ring-[var(--field-border)]">
                  <div className="min-w-0">
                    <FormLabel className="text-sm">{f.label}</FormLabel>
                    <FormDescription className="text-2xs">{f.hint}</FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />
          ))}
        </div>

        <FormField
          control={form.control}
          name="notes"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("form.notes")}</FormLabel>
              <FormControl>
                <Textarea rows={2} placeholder={t("form.notesPh")} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="reason"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("form.reason")}</FormLabel>
              <FormControl>
                <Input placeholder={t("form.reasonPh")} autoComplete="off" {...field} />
              </FormControl>
              <FormDescription className="text-2xs">{t("form.reasonHint")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {limits?.updatedBy
              ? limits.updatedAt
                ? t("form.changedAt", { name: personName(limits.updatedBy), date: fmtDate(limits.updatedAt, "shortDateTime") })
                : t("form.changed", { name: personName(limits.updatedBy) })
              : t("form.notSetYet")}
          </span>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => form.reset(toForm(limits))} disabled={!form.formState.isDirty || save.isPending}>
              {commonI18n.t("actions.reset")}
            </Button>
            <Button type="submit" size="sm" disabled={save.isPending || !form.formState.isDirty}>
              {save.isPending ? commonI18n.t("states.saving") : t("form.save")}
            </Button>
          </div>
        </div>
      </form>
    </Form>
  );
}
