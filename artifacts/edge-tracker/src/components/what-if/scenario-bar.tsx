import { useState } from "react";
import { Bookmark, Check, ChevronDown, Link2, RotateCcw, Save, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { whatIfI18n } from "@/i18n/ns/whatIf";
import type { SavedScenario } from "./api";
import { type Rule, type RuleType, chipLabel } from "./rules";

/**
 * Active scenario as removable chips + scenario actions: reset, saved scenarios, save, copy link.
 * The scenario lives in the URL, so the copied link opens exactly this view.
 */
export function ScenarioBar({
  rules,
  skipped,
  onRemove,
  onClear,
  onLoad,
  saved,
  canSave,
  saving,
  onSave,
  onDelete,
}: {
  rules: Rule[];
  skipped: { rule: string; reason: string }[];
  onRemove: (type: RuleType) => void;
  onClear: () => void;
  onLoad: (rules: Rule[], name: string) => void;
  saved: SavedScenario[];
  canSave: boolean;
  saving: boolean;
  onSave: (name: string) => void;
  onDelete: (id: number) => void;
}) {
  const { t } = whatIfI18n.useT();
  const [copied, setCopied] = useState(false);
  const [name, setName] = useState("");
  const [saveOpen, setSaveOpen] = useState(false);
  const skippedBy = new Map(skipped.map((s) => [s.rule, s.reason]));

  const copyLink = () => {
    const url = window.location.href;
    void navigator.clipboard?.writeText(url).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      },
      () => undefined,
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground">{t("scenario.label")}</span>
      {rules.length === 0 ? (
        <span className="text-sm text-muted-foreground">{t("scenario.empty")}</span>
      ) : (
        <ul className="flex flex-wrap items-center gap-1.5" aria-label={t("scenario.rulesAria")}>
          {rules.map((r) => {
            const skip = skippedBy.get(r.type);
            return (
              <li key={r.type}>
                <span
                  className={
                    "inline-flex min-h-8 items-center gap-1 rounded-full py-0.5 pl-3 pr-1 text-sm font-medium " +
                    (skip ? "bg-[hsl(var(--warn)/0.14)] text-warn" : "bg-[hsl(var(--primary)/0.14)] text-primary")
                  }
                  title={skip ? t("scenario.notApplied", { reason: skip }) : undefined}
                >
                  {chipLabel(r)}
                  {skip && <span className="text-xs opacity-80">{t("scenario.notAppliedShort")}</span>}
                  <button
                    type="button"
                    onClick={() => onRemove(r.type)}
                    className="grid h-6 w-6 place-items-center rounded-full hover:bg-[hsl(var(--foreground)/0.08)]"
                    aria-label={t("scenario.removeRule", { rule: chipLabel(r) })}
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        {rules.length > 0 && (
          <Button size="sm" variant="ghost" className="rounded-full" onClick={onClear}>
            <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> {t("scenario.reset")}
          </Button>
        )}
        {(saved.length > 0 || canSave) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="rounded-full" disabled={!saved.length}>
                <Bookmark className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> {t("scenario.mine")}{saved.length ? ` · ${saved.length}` : ""}
                <ChevronDown className="ml-0.5 h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-80">
              <DropdownMenuLabel>{t("scenario.saved")}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {saved.map((s) => (
                <DropdownMenuItem key={s.id} className="flex items-start gap-2" onSelect={() => onLoad(s.rules, s.name)}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{s.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{(s.rules.length ? s.rules.map(chipLabel) : s.labels).join(" · ") || t("scenario.noRules")}</span>
                  </span>
                  {canSave && (
                    <button
                      type="button"
                      className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-[hsl(var(--down)/0.12)] hover:text-down"
                      aria-label={t("scenario.removeScenario", { name: s.name })}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onDelete(s.id);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {canSave && (
          <Popover open={saveOpen} onOpenChange={setSaveOpen}>
            <PopoverTrigger asChild>
              <Button size="sm" variant="ghost" className="rounded-full" disabled={!rules.length}>
                <Save className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> {t("scenario.save")}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72">
              <form
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const n = name.trim();
                  if (!n) return;
                  onSave(n);
                  setName("");
                  setSaveOpen(false);
                }}
              >
                <label htmlFor="sim-save-name" className="text-xs font-medium text-muted-foreground">{t("scenario.nameLabel")}</label>
                <Input id="sim-save-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={t("scenario.namePlaceholder")} autoFocus />
                <Button type="submit" size="sm" className="rounded-full bg-primary-solid" disabled={!name.trim() || saving}>
                  {saving ? t("scenario.saving") : t("scenario.save")}
                </Button>
              </form>
            </PopoverContent>
          </Popover>
        )}
        <Button size="sm" variant="ghost" className="rounded-full" onClick={copyLink} disabled={!rules.length}>
          {copied ? <Check className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> : <Link2 className="mr-1 h-3.5 w-3.5" aria-hidden="true" />}
          {copied ? t("scenario.copied") : t("scenario.link")}

        </Button>
      </div>
    </div>
  );
}
