import * as React from "react";
import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Pill, Segmented } from "@/components/ds";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { commonI18n } from "@/i18n/ns/common";
import { scalingI18n } from "@/i18n/ns/scaling";
import type { Config, Op, Rule, RuleInput, Tier, TierInput, Unit } from "./use-scaling";
import { useSaveRules, useSaveTiers } from "./use-scaling";
import { OP_LABEL, actionLabel, tierLabel } from "./format";

type Tab = "tiers" | "rules";

const MONEY_FIELDS = ["accountSize", "dailyLossLimit", "weeklyLossLimit", "maxDrawdown", "maxRiskPerTrade", "maxPositionUsd", "maxOvernightExposure"] as const;
type MoneyField = (typeof MONEY_FIELDS)[number];

/** Short labels for the editor grid (resolved at render time). */
function moneyFieldLabel(key: MoneyField): string {
  switch (key) {
    case "dailyLossLimit": return commonI18n.t("trading.dailyLimit");
    case "weeklyLossLimit": return commonI18n.t("trading.weeklyLimit");
    default: return scalingI18n.t(`limit.${key}`);
  }
}

/** Renders `**bold**` segments of a dictionary string (dictionaries hold no markup). */
function withBold(text: string): React.ReactNode {
  return text.split("**").map((part, i) => (i % 2 ? <b key={i}>{part}</b> : <React.Fragment key={i}>{part}</React.Fragment>));
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const numOrNull = (s: string): number | null => (s.trim() === "" ? null : Number.isFinite(Number(s)) ? Number(s) : null);

function TiersEditor({ initial, onSaved }: { initial: Tier[]; onSaved: () => void }) {
  const [tiers, setTiers] = React.useState<Tier[]>(initial);
  const [dirty, setDirty] = React.useState(false);
  const { toast } = useToast();
  const { t } = scalingI18n.useT();
  const { t: tc } = commonI18n.useT();
  const save = useSaveTiers();
  const update = (i: number, patch: Partial<Tier>) => {
    setTiers((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
    setDirty(true);
  };
  const move = (i: number, dir: -1 | 1) => {
    setTiers((xs) => {
      const j = i + dir;
      if (j < 0 || j >= xs.length) return xs;
      const copy = [...xs];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
    setDirty(true);
  };
  const remove = (i: number) => { setTiers((xs) => xs.filter((_, j) => j !== i)); setDirty(true); };
  const add = () => {
    const last = tiers[tiers.length - 1];
    setTiers((xs) => [...xs, {
      // The default name is a prefill: once saved it is the curator's text (not re-translated).
      key: `tier-${xs.length + 1}`, name: t("config.newTierName", { n: xs.length + 1 }), order: xs.length + 1,
      accountSize: last?.accountSize ?? null, dailyLossLimit: last?.dailyLossLimit ?? null, weeklyLossLimit: last?.weeklyLossLimit ?? null,
      maxDrawdown: last?.maxDrawdown ?? null, maxRiskPerTrade: last?.maxRiskPerTrade ?? null, maxPositionUsd: last?.maxPositionUsd ?? null,
      maxOvernightExposure: last?.maxOvernightExposure ?? null, maxOpenPositions: last?.maxOpenPositions ?? null,
      allowOvernight: last?.allowOvernight ?? false, allowSwing: last?.allowSwing ?? false, description: "",
    }]);
    setDirty(true);
  };
  const submit = async () => {
    const body: TierInput[] = tiers.map((x, i) => ({ ...x, key: slug(x.key) || `tier-${i + 1}`, order: i + 1, description: x.description || null }));
    const keys = new Set(body.map((x) => x.key));
    if (keys.size !== body.length) { toast({ title: t("config.keysUnique"), variant: "destructive" }); return; }
    try {
      await save.mutateAsync(body);
      toast({ title: t("config.tiersSaved") });
      setDirty(false);
      onSaved();
    } catch (e) {
      toast({ title: t("config.tiersSaveFailed"), description: (e as Error).message, variant: "destructive" });
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">{t("config.tiersHint")}</p>
      <ol className="flex flex-col gap-3">
        {tiers.map((tier, i) => (
          <li key={i} className="glass-panel flex flex-col gap-3 rounded-xl p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone="purple">{i + 1}</Pill>
              <Input value={tier.name} onChange={(e) => update(i, { name: e.target.value })} aria-label={t("config.tierNameAria")} className="w-40" maxLength={60} />
              <Input value={tier.key} onChange={(e) => update(i, { key: e.target.value })} aria-label={t("config.tierKeyAria")} title={t("config.tierKeyAria")} className="w-32 font-mono text-xs" maxLength={40} placeholder="key" />
              <Input value={tier.description ?? ""} onChange={(e) => update(i, { description: e.target.value })} aria-label={t("config.tierDescAria")} className="min-w-[160px] flex-1" maxLength={300} placeholder={tc("fields.description")} />
              <div className="ml-auto flex items-center gap-1">
                <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t("config.moveUp")} title={t("config.moveUp")} onClick={() => move(i, -1)} disabled={i === 0}><ArrowUp className="h-4 w-4" aria-hidden="true" /></Button>
                <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t("config.moveDown")} title={t("config.moveDown")} onClick={() => move(i, 1)} disabled={i === tiers.length - 1}><ArrowDown className="h-4 w-4" aria-hidden="true" /></Button>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-down" aria-label={t("config.removeTier")} title={t("config.removeTier")} onClick={() => remove(i)} disabled={tiers.length <= 1}><Trash2 className="h-4 w-4" aria-hidden="true" /></Button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {MONEY_FIELDS.map((f) => (
                <label key={f} className="flex flex-col justify-end gap-1 text-2xs text-muted-foreground">
                  {moneyFieldLabel(f)}, $
                  <Input type="number" inputMode="decimal" min={0} value={tier[f] == null ? "" : String(tier[f])} onChange={(e) => update(i, { [f]: numOrNull(e.target.value) } as Partial<Tier>)} className="h-8 text-sm" />
                </label>
              ))}
              <label className="flex flex-col justify-end gap-1 text-2xs text-muted-foreground">
                {t("limit.maxOpenPositions")}
                <Input type="number" inputMode="numeric" min={0} value={tier.maxOpenPositions == null ? "" : String(tier.maxOpenPositions)} onChange={(e) => update(i, { maxOpenPositions: numOrNull(e.target.value) == null ? null : Math.round(Number(e.target.value)) })} className="h-8 text-sm" />
              </label>
            </div>
            <div className="flex flex-wrap gap-4 text-xs">
              <label className="flex items-center gap-2"><Switch checked={tier.allowOvernight} onCheckedChange={(v) => update(i, { allowOvernight: v })} aria-label={t("config.overnightAllowed")} /> {tc("trading.overnight")}</label>
              <label className="flex items-center gap-2"><Switch checked={tier.allowSwing} onCheckedChange={(v) => update(i, { allowSwing: v })} aria-label={t("config.swingAllowed")} /> {tc("trading.swing")}</label>
            </div>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="outline" size="sm" onClick={add} disabled={tiers.length >= 20}><Plus className="h-4 w-4" aria-hidden="true" /> {t("config.addTier")}</Button>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => { setTiers(initial); setDirty(false); }} disabled={!dirty}><RotateCcw className="h-4 w-4" aria-hidden="true" /> {tc("actions.reset")}</Button>
          <Button size="sm" onClick={submit} disabled={!dirty || save.isPending}>{save.isPending ? tc("states.saving") : t("config.saveTiers")}</Button>
        </div>
      </div>
    </div>
  );
}

function RulesEditor({ initial, config, onSaved }: { initial: Rule[]; config: Config; onSaved: () => void }) {
  const [rules, setRules] = React.useState<RuleInput[]>(initial);
  const [dirty, setDirty] = React.useState(false);
  const { toast } = useToast();
  const { t } = scalingI18n.useT();
  const { t: tc } = commonI18n.useT();
  const save = useSaveRules();
  const metrics = config.meta.metrics;
  const update = (i: number, patch: Partial<RuleInput>) => { setRules((xs) => xs.map((r, j) => (j === i ? { ...r, ...patch } : r))); setDirty(true); };
  const remove = (i: number) => { setRules((xs) => xs.filter((_, j) => j !== i)); setDirty(true); };
  const add = (kind: "promote" | "demote") => {
    setRules((xs) => [...xs, { kind, metric: kind === "promote" ? "net_pnl" : "limit_breaches", op: kind === "promote" ? ">=" : ">=", value: kind === "promote" ? 5 : 3, unit: kind === "promote" ? "x_daily_limit" : "abs", windowDays: 20, tierKey: null, label: null, enabled: true }]);
    setDirty(true);
  };
  const submit = async () => {
    try {
      await save.mutateAsync(rules.map((r) => ({ ...r, value: Number(r.value), windowDays: Math.max(1, Math.round(Number(r.windowDays) || 20)) })));
      toast({ title: t("config.rulesSaved") });
      setDirty(false);
      onSaved();
    } catch (e) {
      toast({ title: t("config.rulesSaveFailed"), description: (e as Error).message, variant: "destructive" });
    }
  };
  const group = (kind: "promote" | "demote") => rules.map((r, i) => ({ r, i })).filter((x) => x.r.kind === kind);
  const Row = ({ r, i }: { r: RuleInput; i: number }) => {
    const m = metrics.find((x) => x.key === r.metric);
    return (
      <li className={cn("glass-panel flex flex-col gap-2 rounded-xl p-3", !r.enabled && "opacity-60")}>
        <div className="flex flex-wrap items-center gap-2">
          <Switch checked={r.enabled} onCheckedChange={(v) => update(i, { enabled: v })} aria-label={t("config.ruleEnabled")} />
          <Select value={r.metric} onValueChange={(v) => update(i, { metric: v })}>
            <SelectTrigger className="w-56" aria-label={tc("fields.metric")} title={m?.label}><SelectValue /></SelectTrigger>
            <SelectContent>{metrics.map((x) => <SelectItem key={x.key} value={x.key}>{x.label}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={r.op} onValueChange={(v) => update(i, { op: v as Op })}>
            <SelectTrigger className="w-20" aria-label={t("config.operator")}><SelectValue /></SelectTrigger>
            <SelectContent>{config.meta.ops.map((o) => <SelectItem key={o} value={o}>{OP_LABEL[o]}</SelectItem>)}</SelectContent>
          </Select>
          <Input type="number" inputMode="decimal" step="any" value={String(r.value)} onChange={(e) => update(i, { value: Number(e.target.value) })} aria-label={t("config.threshold")} className="w-24" />
          {(m?.unit === "usd") ? (
            <Select value={r.unit} onValueChange={(v) => update(i, { unit: v as Unit })}>
              <SelectTrigger className="w-52" aria-label={t("config.thresholdUnit")}><SelectValue /></SelectTrigger>
              <SelectContent>{config.meta.units.map((u) => <SelectItem key={u.key} value={u.key}>{u.label}</SelectItem>)}</SelectContent>
            </Select>
          ) : (
            <span className="text-xs text-muted-foreground">{m?.unit === "pct" ? "%" : m?.unit === "r" ? "R" : m?.unit === "x" ? "×" : m?.unit === "score" ? "/10" : ""}</span>
          )}
          <Button variant="ghost" size="icon" className="ml-auto h-8 w-8 text-down" aria-label={t("config.removeRule")} title={t("config.removeRule")} onClick={() => remove(i)}><Trash2 className="h-4 w-4" aria-hidden="true" /></Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <label className="flex items-center gap-1.5">{t("config.window")}
            <Input type="number" inputMode="numeric" min={1} max={260} value={String(r.windowDays)} onChange={(e) => update(i, { windowDays: Number(e.target.value) })} aria-label={t("config.windowAria")} className="h-7 w-16 text-xs" />
            {t("config.windowUnit")}
          </label>
          <label className="flex items-center gap-1.5">{t("config.tierLabel")}
            <Select value={r.tierKey ?? "__all"} onValueChange={(v) => update(i, { tierKey: v === "__all" ? null : v })}>
              <SelectTrigger className="h-7 w-36 text-xs" aria-label={t("config.tierAria")}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">{t("config.allTiers")}</SelectItem>
                {config.tiers.map((x) => <SelectItem key={x.key} value={x.key}>{tierLabel(x)}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
          <Input value={r.label ?? ""} onChange={(e) => update(i, { label: e.target.value || null })} aria-label={t("config.ruleNameAria")} placeholder={m?.label ?? tc("fields.name")} className="h-7 min-w-[180px] flex-1 text-xs" maxLength={120} />
        </div>
        {m?.hint && <p className="text-2xs text-muted-foreground/80">{m.hint}</p>}
      </li>
    );
  };
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">{withBold(t("config.rulesHint"))}</p>
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between"><h3 className="micro-label">{actionLabel("promote")}</h3><Button variant="ghost" size="sm" onClick={() => add("promote")}><Plus className="h-4 w-4" aria-hidden="true" /> {t("config.addRule")}</Button></div>
        <ul className="flex flex-col gap-2">{group("promote").map(({ r, i }) => <Row key={i} r={r} i={i} />)}</ul>
      </section>
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between"><h3 className="micro-label">{actionLabel("demote")}</h3><Button variant="ghost" size="sm" onClick={() => add("demote")}><Plus className="h-4 w-4" aria-hidden="true" /> {t("config.addRule")}</Button></div>
        <ul className="flex flex-col gap-2">{group("demote").map(({ r, i }) => <Row key={i} r={r} i={i} />)}</ul>
      </section>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => { setRules(initial); setDirty(false); }} disabled={!dirty}><RotateCcw className="h-4 w-4" aria-hidden="true" /> {tc("actions.reset")}</Button>
        <Button size="sm" onClick={submit} disabled={!dirty || save.isPending}>{save.isPending ? tc("states.saving") : t("config.saveRules")}</Button>
      </div>
    </div>
  );
}

/** Curator editor for the tier ladder and the rule set, in a side sheet. */
export function ConfigSheet({ config, open, onOpenChange }: { config: Config | undefined; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [tab, setTab] = React.useState<Tab>("tiers");
  // Remount editors after a save so their local state picks up server-normalised values.
  const [epoch, setEpoch] = React.useState(0);
  const { t } = scalingI18n.useT();
  const { t: tc } = commonI18n.useT();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-3xl">
        <div className="flex flex-col gap-4">
          <SheetHeader className="pr-10 text-left">
            <SheetTitle>{t("config.title")}</SheetTitle>
            <SheetDescription>{t("config.description")}</SheetDescription>
          </SheetHeader>
          <Segmented ariaLabel={t("config.tabsAria")} value={tab} onChange={setTab} size="sm" options={[{ value: "tiers", label: t("config.tabTiers"), count: config?.tiers.length }, { value: "rules", label: t("config.tabRules"), count: config?.rules.length }]} />
          {!config ? (
            <p className="text-sm text-muted-foreground">{tc("states.loading")}</p>
          ) : tab === "tiers" ? (
            <TiersEditor key={`t${epoch}`} initial={config.tiers} onSaved={() => setEpoch((e) => e + 1)} />
          ) : (
            <RulesEditor key={`r${epoch}`} initial={config.rules} config={config} onSaved={() => setEpoch((e) => e + 1)} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
