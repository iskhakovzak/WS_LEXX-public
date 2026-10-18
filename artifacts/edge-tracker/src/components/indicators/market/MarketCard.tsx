import { memo, useEffect, useState } from "react";
import { Bell, BellRing, Info } from "lucide-react";
import { Pill, Sparkline, type Tone } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { alertFires, type AlertRule, type IndicatorDef, type Reading } from "./engine";
import { indicatorsI18n } from "@/i18n/ns/indicators";
import { commonI18n } from "@/i18n/ns/common";

const opWord = (op: AlertRule["op"]) => indicatorsI18n.t(op === "above" ? "mcard.above" : "mcard.below");

const deltaTone = (def: IndicatorDef, d: number | null): Tone => {
  if (d == null || Math.abs(d) < 1e-9 || def.polarity === 0) return "neutral";
  return d * def.polarity > 0 ? "up" : "down";
};

/** Plain-language explanation of an indicator (the glossary tooltip only knows trade terms). */
export function IndicatorExplain({ def }: { def: IndicatorDef }) {
  const { t } = indicatorsI18n.useT();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={t("mcard.whatIs", { label: def.label })}
          onClick={(e) => e.stopPropagation()}
          className="inline-grid h-5 w-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors duration-[var(--dur-1)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Info className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <div className="flex max-w-[19rem] flex-col gap-1 py-0.5 text-left">
          <span className="text-xs font-semibold text-foreground">{def.label} — {def.sub.toLowerCase()}</span>
          <span className="text-xs text-muted-foreground">{def.explain}</span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function AlertEditor({ def, rule, current, onSave }: {
  def: IndicatorDef;
  rule: AlertRule | undefined;
  current: number | null;
  onSave: (rule: AlertRule | null) => void;
}) {
  const { t } = indicatorsI18n.useT();
  const [open, setOpen] = useState(false);
  const [op, setOp] = useState<AlertRule["op"]>(rule?.op ?? def.alertHint.op);
  const [raw, setRaw] = useState(String(rule?.value ?? def.alertHint.value));
  useEffect(() => {
    if (!open) return;
    setOp(rule?.op ?? def.alertHint.op);
    setRaw(String(rule?.value ?? def.alertHint.value));
  }, [open, rule, def]);
  const value = Number(raw.replace(",", "."));
  const valid = raw.trim() !== "" && Number.isFinite(value);
  const fired = rule ? alertFires(rule, current) : false;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          aria-label={rule ? t("mcard.alertSet", { label: def.label, op: opWord(rule.op), value: rule.value }) : t("mcard.alertNew", { label: def.label })}
          className={cn(
            "grid h-8 w-8 shrink-0 place-items-center rounded-full transition-colors duration-[var(--dur-1)] hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            fired ? "text-warn" : rule ? "text-primary" : "text-muted-foreground",
          )}
        >
          {fired ? <BellRing className="h-4 w-4" aria-hidden="true" /> : <Bell className="h-4 w-4" aria-hidden="true" />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72" onClick={(e) => e.stopPropagation()}>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => { e.preventDefault(); if (valid) { onSave({ op, value }); setOpen(false); } }}
        >
          <div>
            <p className="text-sm font-semibold">{t("mcard.alertTitle", { label: def.label })}</p>
            <p className="text-xs text-muted-foreground">{t("mcard.alertHint", { value: current != null ? def.format(current) : "—" })}</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="glass-field inline-flex items-center gap-0.5 p-1" role="group" aria-label={t("mcard.conditionAria")}>
              {(["above", "below"] as const).map((o) => (
                <button
                  key={o}
                  type="button"
                  aria-pressed={op === o}
                  onClick={() => setOp(o)}
                  className={cn("min-h-7 rounded-full px-2.5 text-xs font-medium", op === o ? "bg-primary-solid text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
                >
                  {opWord(o)}
                </button>
              ))}
            </div>
            <Input
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              inputMode="decimal"
              aria-label={t("mcard.thresholdAria")}
              className="h-9 min-w-0 flex-1 tabular-nums"
              autoFocus
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            {rule ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => { onSave(null); setOpen(false); }}>{t("mcard.removeAlert")}</Button>
            ) : <span />}
            <Button type="submit" size="sm" disabled={!valid}>{commonI18n.t("actions.save")}</Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

export const MarketCard = memo(function MarketCard({
  def, reading, rule, focused, onFocus, onSaveAlert,
}: {
  def: IndicatorDef;
  reading: Reading | undefined;
  rule: AlertRule | undefined;
  focused: boolean;
  onFocus: (id: IndicatorDef["id"]) => void;
  onSaveAlert: (id: IndicatorDef["id"], rule: AlertRule | null) => void;
}) {
  const { t } = indicatorsI18n.useT();
  const v = reading?.value ?? null;
  const fired = rule ? alertFires(rule, v) : false;
  const word = v != null ? def.read(v) : "";
  const p = reading?.percentile ?? null;
  const sparkTone: Tone = def.polarity === 0 ? "accent" : deltaTone(def, reading?.dWeek ?? null) === "neutral" ? "accent" : deltaTone(def, reading?.dWeek ?? null);
  return (
    <article
      className={cn(
        "group glass-panel relative flex h-full min-w-0 flex-col rounded-2xl transition-shadow duration-[var(--dur-2)]",
        focused && "ring-1 ring-primary/50",
        fired && "ring-1 ring-warn/60",
      )}
    >
      <button
        type="button"
        onClick={() => onFocus(def.id)}
        aria-pressed={focused}
        aria-label={t("mcard.focusAria", { label: def.label, value: v != null ? def.format(v) : t("mcard.noData") })}
        className="absolute inset-0 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="pointer-events-none relative flex min-w-0 flex-1 flex-col gap-2 p-4">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="pointer-events-auto flex items-center gap-1">
              <span className="truncate text-sm font-semibold text-foreground">{def.label}</span>
              <IndicatorExplain def={def} />
            </div>
            <p className="truncate text-xs text-muted-foreground">{def.sub}</p>
          </div>
          <div className="pointer-events-auto -mr-1.5 -mt-1.5">
            <AlertEditor def={def} rule={rule} current={v} onSave={(r) => onSaveAlert(def.id, r)} />
          </div>
        </div>

        <div className="flex min-w-0 items-baseline gap-2">
          {reading ? (
            <span className="text-2xl font-semibold leading-none tracking-tight tabular-nums">{v != null ? def.format(v) : "—"}</span>
          ) : (
            <span className="skeleton block h-6 w-20" aria-hidden="true" />
          )}
          {word && <span className="truncate text-xs text-muted-foreground">{word}</span>}
        </div>

        <Sparkline
          data={reading?.spark ?? []}
          tone={sparkTone}
          width={220}
          height={32}
          baseline={rule?.value}
          className="h-8 w-full"
          ariaLabel={t("mcard.sparkAria", { label: def.label })}
        />

        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums">
          <span className="text-muted-foreground">{t("mcard.day")} <Delta def={def} v={reading?.dDay ?? null} /></span>
          <span className="text-muted-foreground">{t("mcard.week")} <Delta def={def} v={reading?.dWeek ?? null} /></span>
          {p != null && (
            <span className="ml-auto inline-flex items-center gap-1.5 text-muted-foreground" title={t("mcard.percentileTitle", { pct: Math.round(p * 100) })}>
              <span className="relative h-1.5 w-12 overflow-hidden rounded-full bg-[var(--glass-hover-bg)]" aria-hidden="true">
                <span className="absolute inset-y-0 left-0 rounded-full bg-foreground/50" style={{ width: `${Math.max(4, p * 100)}%` }} />
              </span>
              {t("mcard.year", { pct: Math.round(p * 100) })}
            </span>
          )}
        </div>
        {fired && rule && (
          <Pill tone="warn" dot className="self-start">{t("mcard.fired", { op: opWord(rule.op), value: def.format(rule.value) })}</Pill>
        )}
      </div>
    </article>
  );
});

function Delta({ def, v }: { def: IndicatorDef; v: number | null }) {
  if (v == null) return <span>—</span>;
  const t = deltaTone(def, v);
  return <span className={cn("font-medium", t === "up" ? "text-up" : t === "down" ? "text-down" : "text-foreground")}>{def.delta(v)}</span>;
}
