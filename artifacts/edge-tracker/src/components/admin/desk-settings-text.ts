/**
 * Desk settings texts in the current UI language (deskSettings namespace): a key's label (the key itself when the
 * dictionary has none), option and unit labels, a value as text, an inline problem. Read at call time — never at
 * module scope. Used by the form (DeskSettingField) and the audit log (audit-text: settings.update).
 */
import { fmtUsd } from "@/lib/format";
import { deskSettingsI18n } from "@/i18n/ns/deskSettings";
import { shownNumber, type Problem, type SettingDef, type SettingUnit, type SettingValue } from "./desk-settings-model";

const t = deskSettingsI18n.t;

export function settingLabel(key: string): string {
  return deskSettingsI18n.tryT(`settings.${key}.label`) ?? key;
}

export function optionLabel(key: string, option: string): string {
  return deskSettingsI18n.tryT(`settings.${key}.options.${option}`) ?? option;
}

export function unitLabel(def: SettingDef): string {
  return def.unit ? (deskSettingsI18n.tryT(`units.${def.unit}`) ?? "") : "";
}

/** A value as text: "$10", "50%", "10 дн.", "08:45 NY", "Вкл", an option's label. */
export function valueText(key: string, def: SettingDef, v: SettingValue): string {
  switch (def.type) {
    case "number": {
      const n = shownNumber(def, Number(v));
      if (def.unit === "usd") return fmtUsd(n, { decimals: "trim" });
      if (def.unit === "ratio" || def.unit === "pct") return `${n}%`;
      const u = unitLabel(def);
      return u ? `${n} ${u}` : String(n);
    }
    case "time": return `${String(v)} ${t("field.ny")}`;
    case "boolean": return v ? t("field.on") : t("field.off");
    case "select": return optionLabel(key, String(v));
  }
}

export function problemText(p: Problem): string {
  if (p.kind === "range") return t("problems.range", { min: String(p.min ?? ""), max: String(p.max ?? "") });
  return t(`problems.${p.kind}`);
}

/** An audit value (settings.update details: from / to + the unit when the server sent it). */
export function auditValueText(v: unknown, unit?: SettingUnit | null): string {
  if (typeof v === "boolean") return v ? t("field.on") : t("field.off");
  if (typeof v === "number") {
    if (unit === "usd") return fmtUsd(v, { decimals: "trim" });
    if (unit === "ratio") return `${Math.round(v * 10000) / 100}%`;
    return String(v);
  }
  return v == null ? "—" : String(v);
}
