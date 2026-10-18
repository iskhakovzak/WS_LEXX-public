import { useMemo, useState } from "react";
import { Plus, Sparkles } from "lucide-react";
import { Segmented } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { whatIfI18n } from "@/i18n/ns/whatIf";
import { cn } from "@/lib/utils";
import type { Preset } from "./api";
import { type PreviewTrade, type Rule, type RuleType, chipLabel, isApplied, previewRule } from "./rules";

/**
 * «Свой сценарий»: a sentence-like form instead of a wall of switches —
 * «Исключить сделки, где [время входа] [раньше] [09:45]» → live count of the trades it touches → «Добавить».
 * Fields whose rule the running API does not support yet (`supported`) are hidden.
 */

type Mode = "exclude" | "stop" | "cap";
type Op = { id: string; label: string };
type FieldDef = {
  id: string;
  label: string;
  ops: Op[];
  input: "time" | "tickers" | "number" | "none";
  unit?: string;
  placeholder?: string;
  defaultValue: string;
  requires: RuleType;
  build: (op: string, value: string) => Rule | null;
};

const num = (v: string): number | null => {
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) && v.trim() !== "" ? n : null;
};
const HM = /^([01]?\d|2[0-3]):[0-5]\d$/;
/** Labels are getters over the whatIf namespace (read when rendered, so they follow the UI language). */
const wt = whatIfI18n.t;

const EXCLUDE_FIELDS: FieldDef[] = [
  {
    id: "time", get label() { return wt("builder.field.time"); }, ops: [{ id: "before", get label() { return wt("builder.op.before"); } }, { id: "after", get label() { return wt("builder.op.after"); } }], input: "time", defaultValue: "09:45", requires: "timeWindow",
    build: (op, v) => (HM.test(v) ? (op === "before" ? { type: "timeWindow", from: v, to: null } : { type: "timeWindow", from: null, to: v }) : null),
  },
  {
    id: "ticker", get label() { return wt("builder.field.ticker"); }, ops: [{ id: "in", get label() { return wt("builder.op.in"); } }], input: "tickers", placeholder: "AMD, TSLA", defaultValue: "", requires: "excludeTickers",
    build: (_op, v) => {
      const tickers = [...new Set(v.split(/[\s,;]+/).map((t) => t.trim().toUpperCase()).filter((t) => /^[A-Z0-9.\-]{1,16}$/.test(t)))];
      return tickers.length ? { type: "excludeTickers", tickers } : null;
    },
  },
  {
    id: "hold", get label() { return wt("builder.field.hold"); }, ops: [{ id: "lt", get label() { return wt("builder.op.shorter"); } }], input: "number", get unit() { return wt("builder.unit.min"); }, defaultValue: "2", requires: "minHold",
    build: (_op, v) => { const n = num(v); return n && n > 0 ? { type: "minHold", seconds: Math.round(n * 60) } : null; },
  },
  {
    id: "price", get label() { return wt("builder.field.price"); }, ops: [{ id: "lt", get label() { return wt("builder.op.cheaper"); } }, { id: "gt", get label() { return wt("builder.op.pricier"); } }], input: "number", unit: "$", defaultValue: "5", requires: "priceRange",
    build: (op, v) => { const n = num(v); return n && n > 0 ? (op === "lt" ? { type: "priceRange", min: n, max: null } : { type: "priceRange", min: null, max: n }) : null; },
  },
  {
    id: "size", get label() { return wt("builder.field.size"); }, ops: [{ id: "lt", get label() { return wt("builder.op.less"); } }, { id: "gt", get label() { return wt("builder.op.more"); } }], input: "number", get unit() { return wt("builder.unit.shares"); }, defaultValue: "100", requires: "sizeRange",
    build: (op, v) => { const n = num(v); return n && n > 0 ? (op === "lt" ? { type: "sizeRange", min: Math.round(n), max: null } : { type: "sizeRange", min: null, max: Math.round(n) }) : null; },
  },
  {
    id: "side", get label() { return wt("builder.field.side"); }, ops: [{ id: "long", get label() { return wt("builder.op.long"); } }, { id: "short", get label() { return wt("builder.op.short"); } }], input: "none", defaultValue: "", requires: "excludeSide",
    build: (op) => ({ type: "excludeSide", side: op === "short" ? "short" : "long" }),
  },
  {
    id: "afterLoss", get label() { return wt("builder.field.afterLoss"); }, ops: [{ id: "within", get label() { return wt("builder.op.within"); } }], input: "number", get unit() { return wt("builder.unit.min"); }, defaultValue: "5", requires: "afterLoss",
    build: (_op, v) => { const n = num(v); return n && n > 0 ? { type: "afterLoss", minutes: n } : null; },
  },
];

const STOP_FIELDS: FieldDef[] = [
  {
    id: "dayLoss", get label() { return wt("builder.field.dayLoss"); }, ops: [], input: "number", unit: "$", defaultValue: "200", requires: "dailyLossLimit",
    build: (_op, v) => { const n = num(v); return n && n > 0 ? { type: "dailyLossLimit", usd: n } : null; },
  },
  {
    id: "lossRun", get label() { return wt("builder.field.lossRun"); }, ops: [], input: "number", get unit() { return wt("builder.unit.pcs"); }, defaultValue: "3", requires: "stopAfterLosses",
    build: (_op, v) => { const n = num(v); return n && n >= 1 ? { type: "stopAfterLosses", n: Math.round(n) } : null; },
  },
  {
    id: "maxTrades", get label() { return wt("builder.field.maxTrades"); }, ops: [], input: "number", get unit() { return wt("builder.unit.pcs"); }, defaultValue: "10", requires: "maxTradesPerDay",
    build: (_op, v) => { const n = num(v); return n && n >= 1 ? { type: "maxTradesPerDay", n: Math.round(n) } : null; },
  },
];

const CAP_FIELD: FieldDef = {
  id: "cap", get label() { return wt("builder.field.cap"); }, ops: [], input: "number", unit: "$", defaultValue: "50", requires: "capLoss",
  build: (_op, v) => { const n = num(v); return n && n > 0 ? { type: "capLoss", usd: n } : null; },
};

export function RuleBuilder({
  trades,
  supported,
  rules,
  presets,
  onAdd,
  onApplyPreset,
}: {
  trades: PreviewTrade[];
  supported: ReadonlySet<RuleType>;
  rules: Rule[];
  presets: Preset[];
  onAdd: (r: Rule) => void;
  onApplyPreset: (p: Preset) => void;
}) {
  const { t } = whatIfI18n.useT();
  const [mode, setMode] = useState<Mode>("exclude");
  const excludeFields = useMemo(() => EXCLUDE_FIELDS.filter((f) => supported.has(f.requires)), [supported]);
  const stopFields = useMemo(() => STOP_FIELDS.filter((f) => supported.has(f.requires)), [supported]);
  const listed = mode === "exclude" ? excludeFields : mode === "stop" ? stopFields : [CAP_FIELD];
  const fields = listed.length ? listed : [CAP_FIELD];

  const [fieldId, setFieldId] = useState<Record<Mode, string>>({ exclude: "time", stop: "dayLoss", cap: "cap" });
  const field = fields.find((f) => f.id === fieldId[mode]) ?? fields[0];
  const [ops, setOps] = useState<Record<string, string>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const op = ops[field.id] ?? field.ops[0]?.id ?? "";
  const value = values[field.id] ?? field.defaultValue;

  const draft = useMemo(() => field.build(op, value), [field, op, value]);
  const preview = useMemo(() => (draft ? previewRule(trades, draft) : null), [draft, trades]);
  const already = draft ? isApplied(rules, draft) : false;

  const topTickers = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of trades) m.set(t.ticker, (m.get(t.ticker) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t);
  }, [trades]);

  const setValue = (v: string) => setValues((s) => ({ ...s, [field.id]: v }));
  const lead = t(`builder.lead.${mode}`);
  const usablePresets = presets.filter((p) => p.rules.length && p.rules.every((r) => supported.has(r.type)));

  return (
    <div className="flex flex-col gap-3">
      <Segmented<Mode>
        ariaLabel={t("builder.modeAria")}
        size="sm"
        className="self-start"
        value={mode}
        onChange={setMode}
        options={[
          { value: "exclude", label: t("builder.mode.exclude") },
          { value: "stop", label: t("builder.mode.stop") },
          { value: "cap", label: t("builder.mode.cap") },
        ]}
      />

      <form
        className="flex flex-wrap items-center gap-2 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft && !already) onAdd(draft);
        }}
      >
        <span className="font-medium text-foreground">{lead}</span>
        {fields.length > 1 ? (
          <Select value={field.id} onValueChange={(v) => setFieldId((s) => ({ ...s, [mode]: v }))}>
            <SelectTrigger className="h-9 w-auto min-w-[12rem] rounded-full" aria-label={t("builder.fieldAria")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {fields.map((f) => <SelectItem key={f.id} value={f.id}>{f.label}</SelectItem>)}
            </SelectContent>
          </Select>
        ) : (
          <span className="text-foreground">{field.label}</span>
        )}
        {field.ops.length > 1 ? (
          <Segmented
            ariaLabel={t("builder.opAria")}
            size="sm"
            value={op}
            onChange={(v) => setOps((s) => ({ ...s, [field.id]: v }))}
            options={field.ops.map((o) => ({ value: o.id, label: o.label }))}
          />
        ) : field.ops.length === 1 ? (
          <span className="text-muted-foreground">{field.ops[0].label}</span>
        ) : null}
        {field.input === "time" && (
          <Input type="time" step={60} value={value} onChange={(e) => setValue(e.target.value)} className="h-9 w-[7.5rem] rounded-full tabular-nums" aria-label={t("builder.timeAria")} />
        )}
        {field.input === "number" && (
          <span className="inline-flex items-center gap-1.5">
            {field.unit === "$" && <span className="text-muted-foreground">$</span>}
            <Input type="number" inputMode="decimal" min={0} step="any" value={value} onChange={(e) => setValue(e.target.value)} className="h-9 w-24 rounded-full tabular-nums" aria-label={field.label} />
            {field.unit && field.unit !== "$" && <span className="text-muted-foreground">{field.unit}</span>}
          </span>
        )}
        {field.input === "tickers" && (
          <Input value={value} onChange={(e) => setValue(e.target.value.toUpperCase())} placeholder={field.placeholder} className="h-9 w-48 rounded-full uppercase" aria-label={t("builder.tickersAria")} />
        )}
        {field.input === "time" && <span className="text-xs text-muted-foreground">ET</span>}
        <Button type="submit" size="sm" className="ml-auto rounded-full bg-primary-solid" disabled={!draft || already || (preview != null && preview.affected === 0)}>
          <Plus className="mr-1 h-4 w-4" aria-hidden="true" /> {already ? t("builder.already") : t("builder.add")}
        </Button>
      </form>

      {field.input === "tickers" && topTickers.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">{t("builder.frequent")}</span>
          {topTickers.map((t) => {
            const on = value.split(/[\s,;]+/).includes(t);
            return (
              <button
                key={t}
                type="button"
                aria-pressed={on}
                onClick={() => setValue(on ? value.split(/[\s,;]+/).filter((x) => x && x !== t).join(", ") : [value.trim().replace(/,$/, ""), t].filter(Boolean).join(", "))}
                className="chip min-h-7 px-2.5 text-xs font-medium"
              >
                {t}
              </button>
            );
          })}
        </div>
      )}

      <PreviewLine preview={preview} draft={draft} mode={mode} />

      {usablePresets.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-[var(--glass-border)] pt-3">
          <Sparkles className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          <span className="text-xs text-muted-foreground">{t("builder.presets")}</span>
          {usablePresets.map((p) => (
            <button key={p.id} type="button" onClick={() => onApplyPreset(p)} className="chip min-h-7 px-2.5 text-xs font-medium" title={`${p.description}: ${p.rules.map(chipLabel).join(" · ")}`}>
              {p.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PreviewLine({ preview, draft, mode }: { preview: ReturnType<typeof previewRule> | null; draft: Rule | null; mode: Mode }) {
  const { t } = whatIfI18n.useT();
  if (!draft) return <p className="min-h-5 text-xs text-muted-foreground">{t("builder.fill")}</p>;
  if (!preview) return <p className="min-h-5" />;
  if (preview.affected === 0) return <p className="min-h-5 text-xs text-muted-foreground">{t("builder.none")}</p>;
  const share = preview.total ? Math.round((preview.affected / preview.total) * 100) : 0;
  const params = { trades: "\u0000", total: preview.total, share };
  const [before, after] = (mode === "cap" ? t("builder.previewChange", params) : t("builder.previewTouch", params)).split("\u0000");
  return (
    <p className="min-h-5 text-xs text-muted-foreground tabular-nums" aria-live="polite">
      {before}<span className="font-semibold text-foreground">{commonI18n.t("units.trades", { count: preview.affected })}</span>{after}
      {mode === "exclude" || mode === "stop" ? <> {t("builder.previewNet")} <span className={cn("font-medium", preview.net < 0 ? "text-down" : preview.net > 0 ? "text-up" : "")}>{fmtUsd(preview.net, { signed: true, decimals: "auto" })}</span></> : null}
      {" "}{t("builder.previewTotal")}{" "}
      <span className={cn("font-semibold", preview.effect > 0 ? "text-up" : preview.effect < 0 ? "text-down" : "text-foreground")}>{fmtUsd(preview.effect, { signed: true, decimals: "auto" })}</span>
    </p>
  );
}
