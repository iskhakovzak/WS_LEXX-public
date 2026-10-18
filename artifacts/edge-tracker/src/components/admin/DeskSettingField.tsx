/**
 * One row of «Настройки деска»: label + help (i18n `deskSettings.settings.<key>`, the key itself when a label is
 * missing), the control for its type (number with unit and bounds, NY time with the Tashkent time next to it, switch,
 * select), «Изменено» when the value is not the default, a one-click «По умолчанию: X» reset, who / when changed it,
 * and the inline error. Generic: renders any registry key the server sends.
 */
import { RotateCcw } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Pill } from "@/components/ds";
import { cn } from "@/lib/utils";
import { fmtRelative } from "@/i18n/format";
import { personName } from "@/i18n";
import { deskSettingsI18n } from "@/i18n/ns/deskSettings";
import { inputOf, nyToTashkent, shownBounds, type Problem, type SettingRow, type SettingValue } from "./desk-settings-model";
import { optionLabel, problemText, settingLabel, unitLabel, valueText } from "./desk-settings-text";

const t = deskSettingsI18n.t;

function tashkentLine(hhmm: string): string | null {
  const r = nyToTashkent(hhmm);
  if (!r) return null;
  if (r.dayShift > 0) return t("field.tashkentNextDay", { time: r.time });
  if (r.dayShift < 0) return t("field.tashkentPrevDay", { time: r.time });
  return t("field.tashkent", { time: r.time });
}

export interface FieldProps {
  row: SettingRow;
  /** Value shown now (draft or effective). */
  value: SettingValue;
  /** Raw text of a number input while typing. */
  text?: string;
  dirty: boolean;
  problem: Problem | null;
  onValue: (v: SettingValue | null, text?: string) => void;
}

export function DeskSettingField({ row, value, text, dirty, problem, onValue }: FieldProps) {
  const { key, def } = row;
  const id = `desk-setting-${key.replace(/[^a-z0-9]/gi, "-")}`;
  const label = settingLabel(key);
  const help = deskSettingsI18n.tryT(`settings.${key}.help`);
  const changed = value !== row.default;
  const errId = problem ? `${id}-err` : undefined;
  const meta: string[] = [];
  if (def.type === "number") {
    const b = shownBounds(def);
    meta.push(t("field.range", { min: String(b.min), max: String(b.max) }));
  }
  if (row.updatedBy && row.updatedAt) meta.push(t("field.lastChanged", { name: personName(row.updatedBy), when: fmtRelative(row.updatedAt) }));

  return (
    <div className="grid gap-x-6 gap-y-2 py-3 md:grid-cols-[minmax(0,1fr)_minmax(13rem,auto)] md:items-start">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <label htmlFor={id} className="text-sm font-medium text-foreground">{label}</label>
          {changed && <Pill tone="accent" dot title={t("field.changedTitle")}>{t("field.changed")}</Pill>}
          {dirty && <Pill tone="warn">{t("field.unsaved")}</Pill>}
        </div>
        {help && <p className="mt-0.5 text-xs text-muted-foreground">{help}</p>}
        {meta.length > 0 && <p className="mt-0.5 text-2xs text-muted-foreground">{meta.join(" · ")}</p>}
      </div>
      <div className="flex min-w-0 flex-col items-start gap-1 md:items-end">
        <Control id={id} row={row} value={value} text={text} label={label} invalid={!!problem} errId={errId} onValue={onValue} />
        {problem && <p id={errId} role="alert" className="text-xs text-down">{problemText(problem)}</p>}
        {changed && (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t("field.resetAria", { label })}
            onClick={() => onValue(null)}
          >
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
            {t("field.defaultValue", { value: valueText(key, def, row.default) })}
          </button>
        )}
      </div>
    </div>
  );
}

function Control({ id, row, value, text, label, invalid, errId, onValue }: {
  id: string; row: SettingRow; value: SettingValue; text?: string; label: string; invalid: boolean; errId?: string;
  onValue: FieldProps["onValue"];
}) {
  const { key, def } = row;
  const aria = { "aria-invalid": invalid || undefined, "aria-describedby": errId };
  switch (def.type) {
    case "number": {
      const b = shownBounds(def);
      const unit = def.unit === "usd" ? "$" : unitLabel(def);
      return (
        <div className="flex items-center gap-2">
          {def.unit === "usd" && <span className="text-sm text-muted-foreground" aria-hidden="true">{unit}</span>}
          <Input
            id={id}
            inputMode={b.min < 0 ? "text" : "decimal"}
            autoComplete="off"
            className={cn("h-9 w-28 text-right tabular-nums", invalid && "border-down focus-visible:ring-down")}
            value={text ?? inputOf(def, value)}
            onChange={(e) => onValue(value, e.target.value)}
            {...aria}
          />
          {def.unit !== "usd" && unit && <span className="min-w-8 text-sm text-muted-foreground">{unit}</span>}
        </div>
      );
    }
    case "time": {
      const tk = tashkentLine(String(value));
      return (
        <div className="flex flex-wrap items-center gap-2 md:justify-end">
          <Input
            id={id}
            type="time"
            step={60}
            className={cn("h-9 w-32 tabular-nums", invalid && "border-down")}
            value={String(value)}
            onChange={(e) => e.target.value && onValue(e.target.value)}
            {...aria}
          />
          <span className="text-sm text-muted-foreground">{t("field.ny")}</span>
          {tk && <span className="basis-full text-xs text-muted-foreground md:text-right">{tk}</span>}
        </div>
      );
    }
    case "boolean":
      return (
        <div className="flex h-9 items-center gap-2">
          <Switch id={id} checked={value === true} onCheckedChange={(v) => onValue(v)} aria-label={label} {...aria} />
          <span className="text-sm text-muted-foreground">{value ? t("field.on") : t("field.off")}</span>
        </div>
      );
    case "select":
      return (
        <Select value={String(value)} onValueChange={(v) => onValue(v)}>
          <SelectTrigger id={id} className="h-9 w-56 max-w-full" {...aria}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {def.options.map((o) => <SelectItem key={o} value={o}>{optionLabel(key, o)}</SelectItem>)}
          </SelectContent>
        </Select>
      );
  }
}
