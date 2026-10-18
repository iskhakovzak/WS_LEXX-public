/**
 * Desk glossary + <TermTooltip>: one short, consistent explanation for every trading term the app shows
 * (R, PF, MFE, expectancy…). Pages use it next to KPI labels and table headers instead of writing their own
 * `title=` hints, so the same term always means the same thing.
 *
 *   <TermTooltip term="pf" />                      → "PF" with a dotted underline + tooltip
 *   <TermTooltip term="pf">{label}</TermTooltip>   → custom (already translated) label
 *   <TermTooltip term="mfe" icon />                → small (i) icon after the label
 *   <StatCard label="PF" term="pf" … />             → StatCard renders the icon for you
 */
import * as React from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { termsI18n, type TermKey } from "@/i18n/ns/terms";
import termsRu from "@/i18n/locales/ru/terms";
import { commonI18n } from "@/i18n/ns/common";

export type GlossaryEntry = {
  /** Short label as shown in the UI. */
  label: string;
  /** Full name. */
  title: string;
  /** One or two plain sentences. */
  text: string;
  /** Optional formula line. */
  formula?: string;
};

export type { TermKey } from "@/i18n/ns/terms";

/**
 * Entry in the UI language: label/title/text/formula come from the `terms` namespace (term abbreviations stay as they
 * are; explanations translate). Getters, so GLOSSARY[term] is read at render, never frozen at import.
 */
function entry(term: TermKey): GlossaryEntry {
  return {
    get label() { return termsI18n.t(`${term}.label`); },
    get title() { return termsI18n.t(`${term}.title`); },
    get text() { return termsI18n.t(`${term}.text`); },
    get formula() { return termsI18n.tryT(`${term}.formula`); },
  };
}

export const GLOSSARY = Object.fromEntries((Object.keys(termsRu) as TermKey[]).map((k) => [k, entry(k)])) as Record<TermKey, GlossaryEntry>;

export function glossary(term: TermKey): GlossaryEntry {
  return GLOSSARY[term];
}

/** Plain-text labels (fundamentals rows, data-driven lists) that map onto a glossary term. */
const LABEL_TERMS: Record<string, TermKey> = {
  atr: "atr", rvol: "rvol", relvol: "rvol", "rel. volume": "rvol", float: "float", "short interest": "si",
  "short interest, %": "si", beta: "beta", vwap: "vwap", vix: "vix", "vix / vix3m": "vixTerm",
};

/** Glossary label / full name in the current language → term key (rebuilt per language). */
let byText: { lang: string; map: Map<string, TermKey> } | null = null;
function textIndex(): Map<string, TermKey> {
  const lang = termsI18n.t("r.label") + "|" + termsI18n.t("r.title"); // changes with the language
  if (byText?.lang !== lang) {
    const map = new Map<string, TermKey>();
    for (const k of Object.keys(termsRu) as TermKey[]) {
      for (const v of [GLOSSARY[k].label, GLOSSARY[k].title]) if (v && !map.has(v.toLowerCase())) map.set(v.toLowerCase(), k);
    }
    byText = { lang, map };
  }
  return byText.map;
}

/**
 * Term key for a plain UI label, if the glossary explains it: fixed English data labels («ATR», «Rel. volume») and
 * the glossary's own label / full name in the current language. Prefer passing `term` to TermLabel when you know it.
 */
export function termForLabel(label: string): TermKey | undefined {
  const k = label.trim().toLowerCase();
  return LABEL_TERMS[k] ?? textIndex().get(k);
}

/** Renders `text` as a <TermTooltip> when it names a glossary term (or `term` is given), otherwise as plain text. */
export function TermLabel({ text, term: termProp }: { text: string; term?: TermKey }) {
  termsI18n.useT();
  const term = termProp ?? termForLabel(text);
  return term ? <TermTooltip term={term}>{text}</TermTooltip> : <>{text}</>;
}

/** Tooltip body (also usable inside custom popovers / chart legends). */
export function TermContent({ term }: { term: TermKey }) {
  termsI18n.useT(); // re-render when the language / the namespace chunk changes
  const g: GlossaryEntry = GLOSSARY[term];
  return (
    <div className="flex max-w-[18rem] flex-col gap-1 py-0.5 text-left">
      <span className="text-xs font-semibold text-foreground">{g.title}</span>
      <span className="text-xs text-muted-foreground">{g.text}</span>
      {g.formula && <span className="font-mono text-2xs text-foreground/80">{g.formula}</span>}
    </div>
  );
}

/**
 * Term with an explanation on hover/focus. Keyboard-accessible (the trigger is focusable),
 * never relies on hover alone. Children default to the term's short label.
 */
export function TermTooltip({
  term,
  children,
  icon = false,
  side = "top",
  className,
}: {
  term: TermKey;
  children?: React.ReactNode;
  /** Show a small (i) icon instead of underlining the label. */
  icon?: boolean;
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
}) {
  termsI18n.useT();
  const g: GlossaryEntry = GLOSSARY[term];
  const label = children ?? g.label;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {icon ? (
          <span className={cn("inline-flex min-w-0 items-center gap-1", className)}>
            {children != null && <span className="truncate">{label}</span>}
            <button
              type="button"
              aria-label={commonI18n.t("ds.whatIs", { term: g.label })}
              className="inline-grid h-4 w-4 shrink-0 place-items-center rounded-full text-muted-foreground/80 transition-colors duration-[var(--dur-1)] hover:text-foreground"
              onClick={(e) => e.preventDefault()}
            >
              <Info className="h-3 w-3" aria-hidden="true" />
            </button>
          </span>
        ) : (
          <button
            type="button"
            className={cn(
              "inline cursor-help rounded-sm text-left text-inherit underline decoration-current/40 decoration-dotted underline-offset-[3px] hover:decoration-current/80",
              className,
            )}
            onClick={(e) => e.preventDefault()}
          >
            {label}
          </button>
        )}
      </TooltipTrigger>
      <TooltipContent side={side}>
        <TermContent term={term} />
      </TooltipContent>
    </Tooltip>
  );
}
