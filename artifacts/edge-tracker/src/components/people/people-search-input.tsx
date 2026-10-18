import * as React from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { commonI18n } from "@/i18n/ns/common";

/** Search box for people lists (cross-script matcher behind it). Esc clears, the × button too. */
export const PeopleSearchInput = React.forwardRef<HTMLInputElement, {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  inputClassName?: string;
  /** Rendered at the right edge when empty (e.g. a <Kbd>/</Kbd> hint). */
  trailing?: React.ReactNode;
}>(function PeopleSearchInput({ value, onChange, placeholder, ariaLabel, className, inputClassName, trailing }, ref) {
  const { t } = commonI18n.useT();
  return (
    <div className={cn("relative w-full sm:w-64", className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape" && value) { e.preventDefault(); e.stopPropagation(); onChange(""); } }}
        placeholder={placeholder ?? t("people.placeholder")}
        title={t("people.hint")}
        aria-label={ariaLabel ?? t("people.label")}
        autoComplete="off"
        spellCheck={false}
        className={cn("h-9 pl-9 pr-9", inputClassName)}
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label={t("people.clear")}
          className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full text-muted-foreground hover:bg-[var(--glass-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : trailing ? (
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">{trailing}</span>
      ) : null}
    </div>
  );
});
