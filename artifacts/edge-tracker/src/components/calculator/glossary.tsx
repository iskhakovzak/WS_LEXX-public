/**
 * Options glossary for the calculator: the same (i)-tooltip look as <TermTooltip> from the design system,
 * with option-specific terms (greeks, IV, ITM/OTM…). TODO(ds): these entries can move into GLOSSARY
 * (components/ds/term-tooltip.tsx) — then swap <OptTerm> for <TermTooltip>.
 */
import * as React from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { calculatorI18n } from "@/i18n/ns/calculator";

/** Options terms explained in the (i) tooltips; texts live in the `calculator` namespace (`terms.<key>.*`). */
export const OPTION_TERM_KEYS = [
  "call", "put", "spot", "strike", "dte", "iv", "rate", "premium", "contract",
  "delta", "gamma", "theta", "vega", "rho", "itm", "breakeven", "intrinsic", "timeValue",
  "probProfit", "maxLoss", "debit", "payoff",
] as const;

export type OptTermKey = (typeof OPTION_TERM_KEYS)[number];

/** Label with an (i) icon (or an underlined label) explaining an options term. Keyboard-focusable. */
export function OptTerm({ term, children, icon = true, className }: { term: OptTermKey; children?: React.ReactNode; icon?: boolean; className?: string }) {
  const { t, tryT } = calculatorI18n.useT();
  const termLabel = t(`terms.${term}.label`);
  const formula = tryT(`terms.${term}.formula`);
  const label = children ?? termLabel;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {icon ? (
          <span className={cn("inline-flex min-w-0 items-center gap-1", className)}>
            {children != null && <span className="min-w-0 break-words">{label}</span>}
            <button
              type="button"
              aria-label={t("term.whatIs", { term: termLabel })}
              className="inline-grid h-4 w-4 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors duration-[var(--dur-1)] hover:text-foreground focus-visible:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              onClick={(e) => e.preventDefault()}
            >
              <Info className="h-3 w-3" aria-hidden="true" />
            </button>
          </span>
        ) : (
          <button
            type="button"
            className={cn("inline cursor-help rounded-sm text-inherit underline decoration-current/40 decoration-dotted underline-offset-[3px] hover:decoration-current/80", className)}
            onClick={(e) => e.preventDefault()}
          >
            {label}
          </button>
        )}
      </TooltipTrigger>
      <TooltipContent className="max-w-[18rem]">
        <div className="flex flex-col gap-1 py-0.5 text-left">
          <span className="text-xs font-semibold text-foreground">{t(`terms.${term}.title`)}</span>
          <span className="text-xs text-muted-foreground">{t(`terms.${term}.text`)}</span>
          {formula && <span className="font-mono text-2xs text-foreground/80">{formula}</span>}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
