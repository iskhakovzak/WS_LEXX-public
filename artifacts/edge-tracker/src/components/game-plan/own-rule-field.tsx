import { Sparkles } from "lucide-react";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PICKABLE_MISTAKES, mistakeLabel, type MistakeGroup } from "@/components/shared/mistake-labels";
import { dailyI18n } from "@/i18n/ns/daily";

const NONE = "__none__";
const GROUPS: { group: Exclude<MistakeGroup, "rule" | "other">; label: () => string }[] = [
  { group: "behavior", label: () => dailyI18n.t("ownRule.groupBehavior") },
  { group: "structure", label: () => dailyI18n.t("ownRule.groupExecution") },
  { group: "day", label: () => dailyI18n.t("ownRule.groupDay") },
];

/**
 * «Не повторяю сегодня» (rule of the day) in the personal plan's risk block: one mistake not to repeat today, checked from the trades like the
 * focus. Prefilled with today's focus (the plan does that when the rule was never chosen); the focus is listed first.
 */
export function OwnRuleField({
  id,
  value,
  onChange,
  focusMistake,
}: {
  id: string;
  value: string | null | undefined;
  onChange: (v: string | null) => void;
  /** Today's focus (MistakeId), when the plan is for the focus day. */
  focusMistake?: string | null;
}) {
  const { t } = dailyI18n.useT();
  const known = new Set(PICKABLE_MISTAKES.map((m) => m.id));
  const extra = value && !known.has(value) && value !== focusMistake ? value : null;
  const prefilled = !!value && value === focusMistake;
  return (
    <div className="flex flex-col gap-1.5 sm:max-w-md">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {t("ownRule.label")}
      </label>
      <Select value={value ?? NONE} onValueChange={(v) => onChange(v === NONE ? null : v)}>
        <SelectTrigger id={id} className="h-9">
          <SelectValue placeholder={t("ownRule.none")} />
        </SelectTrigger>
        <SelectContent>
          {focusMistake && (
            <SelectGroup>
              <SelectLabel>{t("ownRule.groupFocus")}</SelectLabel>
              <SelectItem value={focusMistake}>{mistakeLabel(focusMistake)}</SelectItem>
            </SelectGroup>
          )}
          {GROUPS.map((g) => (
            <SelectGroup key={g.group}>
              <SelectLabel>{g.label()}</SelectLabel>
              {PICKABLE_MISTAKES.filter((m) => m.group === g.group && m.id !== focusMistake).map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {mistakeLabel(m.id)}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
          {extra && (
            <SelectGroup>
              <SelectLabel>{t("ownRule.groupOther")}</SelectLabel>
              <SelectItem value={extra}>{mistakeLabel(extra)}</SelectItem>
            </SelectGroup>
          )}
          <SelectItem value={NONE}>{t("ownRule.none")}</SelectItem>
        </SelectContent>
      </Select>
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        {prefilled && <Sparkles className="h-3 w-3 text-primary" aria-hidden="true" />}
        {prefilled ? t("ownRule.fromFocus") : t("ownRule.hint")}
      </span>
    </div>
  );
}
