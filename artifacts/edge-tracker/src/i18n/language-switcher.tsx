
import { Check, Languages } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LANGS, LANG_META, setLang, useLang, type Lang } from ".";
import { commonI18n } from "./ns/common";

/** `focus`: what gets keyboard focus back after the app re-mounts in the new language. */
function choose(lang: Lang, focus?: string) {
  void setLang(lang, { source: "user", focus });
}

/** Top-bar button: current code (RU / EN / UZ) → menu with native names. */
export function LanguageMenu({ className }: { className?: string }) {
  const lang = useLang();
  const { t } = commonI18n.useT();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn("chip relative grid h-10 min-w-10 shrink-0 place-items-center px-2 text-xs font-semibold tabular-nums focus-visible:ring-2 focus-visible:ring-ring", className)}
          data-i18n-focus="lang-menu"
          aria-label={t("language.current", { name: LANG_META[lang].native })}
          title={t("language.interface")}
        >
          {LANG_META[lang].code}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-48">
        <DropdownMenuLabel className="flex items-center gap-2 text-xs font-normal text-muted-foreground">
          <Languages className="h-3.5 w-3.5" aria-hidden="true" />
          {t("language.interface")}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <LanguageMenuItems focus='[data-i18n-focus="lang-menu"]' />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The three language rows, for embedding in another dropdown (e.g. the user menu). */
export function LanguageMenuItems({ focus }: { focus?: string } = {}) {
  const lang = useLang();
  return (
    <>
      {LANGS.map((l) => (
        <DropdownMenuItem key={l} onSelect={() => choose(l, focus)} className="gap-2" lang={l} aria-current={l === lang ? "true" : undefined}>
          <span className="w-6 text-2xs font-semibold text-muted-foreground">{LANG_META[l].code}</span>
          <span className="flex-1">{LANG_META[l].native}</span>
          {l === lang && <Check className="h-4 w-4 text-primary" aria-hidden="true" />}
        </DropdownMenuItem>
      ))}
    </>
  );
}

/** Settings → Профиль: a labelled select. */
export function LanguageSelect({ id, className }: { id?: string; className?: string }) {
  const lang = useLang();
  return (
    <Select value={lang} onValueChange={(v) => choose(v as Lang, id ? `#${id}` : undefined)}>
      <SelectTrigger id={id} className={cn("w-full sm:w-56", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {LANGS.map((l) => (
          <SelectItem key={l} value={l} lang={l}>
            {LANG_META[l].native}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Login screen (before sign-in): RU · EN · UZ pills. */
export function LanguageSegmented({ className }: { className?: string }) {
  const lang = useLang();
  const { t } = commonI18n.useT();
  return (
    <div role="radiogroup" aria-label={t("language.interface")} className={cn("glass-field inline-flex h-9 items-center gap-0.5 p-1", className)}>
      {LANGS.map((l) => (
        <button
          key={l}
          type="button"
          role="radio"
          aria-checked={l === lang}
          lang={l}
          title={LANG_META[l].native}
          onClick={() => choose(l, `[data-i18n-focus="lang-seg-${l}"]`)}
          data-i18n-focus={`lang-seg-${l}`}
          className={cn(
            "h-7 min-w-9 rounded-full px-2.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            l === lang ? "bg-primary-solid text-primary-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <span aria-hidden="true">{LANG_META[l].code}</span>
          <span className="sr-only">{LANG_META[l].native}</span>
        </button>
      ))}
    </div>
  );
}
