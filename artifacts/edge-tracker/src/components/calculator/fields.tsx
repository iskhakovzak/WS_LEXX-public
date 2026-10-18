/** Labelled numeric inputs and small shared bits for the Calculator section. */
import * as React from "react";
import { useId } from "react";
import { HelpCircle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { num } from "./lib";
import { OptTerm, type OptTermKey } from "./glossary";

/** Rich text from a translated template — the shared helper (i18n/rich.tsx), re-exported for old imports. */
export { rich } from "@/i18n/rich";

/** "?" icon with a tooltip; focusable for keyboard users. */
export function Hint({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={text}
          className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:text-primary focus-visible:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-xs">{text}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Text input for numbers: accepts decimal comma and spaces, shows a unit prefix/suffix,
 * a hint tooltip and an inline error. Value stays a string so "1," can be typed.
 */
export function NumField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  error,
  prefix,
  suffix,
  integer,
  className,
  inputClassName,
  id: idProp,
  disabled,
  onEnter,
  size = "md",
  term,
}: {
  /** Options glossary term: (i) tooltip next to the label. */
  term?: OptTermKey;
  label: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  error?: string;
  prefix?: string;
  suffix?: string;
  integer?: boolean;
  className?: string;
  inputClassName?: string;
  id?: string;
  disabled?: boolean;
  onEnter?: () => void;
  size?: "md" | "lg";
}) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const errId = `${id}-err`;
  const invalid = !!error || (value.trim() !== "" && Number.isNaN(num(value)));
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <div className="flex min-h-5 items-center gap-1">
        <Label htmlFor={id} className="truncate text-xs font-normal text-muted-foreground" title={typeof label === "string" ? label : undefined}>{label}</Label>
        {term && <OptTerm term={term} />}
        {hint && <Hint text={hint} />}
      </div>
      <div className="relative">
        {prefix && (
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground" aria-hidden="true">{prefix}</span>
        )}
        <Input
          id={id}
          type="text"
          inputMode={integer ? "numeric" : "decimal"}
          autoComplete="off"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onEnter ? (e) => { if (e.key === "Enter") onEnter(); } : undefined}
          placeholder={placeholder}
          aria-invalid={invalid || undefined}
          aria-describedby={error ? errId : undefined}
          className={cn(
            "tabular-nums",
            size === "lg" ? "h-11 text-base font-semibold md:text-base" : "h-9",
            prefix && "pl-7",
            suffix && "pr-12",
            invalid && "border-down/60 focus-visible:ring-down/40",
            inputClassName,
          )}
        />
        {suffix && (
          <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground" aria-hidden="true">{suffix}</span>
        )}
      </div>
      {error && <p id={errId} className="text-2xs text-down">{error}</p>}
    </div>
  );
}

/** Row of small pill presets ("7д 14д 30д" etc). */
export function PresetChips<T extends string | number>({
  label,
  items,
  isActive,
  onPick,
  format,
  className,
}: {
  label?: string;
  items: T[];
  isActive?: (v: NoInfer<T>) => boolean;
  onPick: (v: NoInfer<T>) => void;
  format?: (v: NoInfer<T>) => React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)} role="group" aria-label={label}>
      {label && <span className="mr-0.5 text-xs text-muted-foreground">{label}</span>}
      {items.map((v) => (
        <button
          key={String(v)}
          type="button"
          aria-pressed={isActive ? isActive(v) : undefined}
          onClick={() => onPick(v)}
          className="chip inline-flex min-h-7 items-center px-2.5 text-xs font-medium tabular-nums"
        >
          {format ? format(v) : String(v)}
        </button>
      ))}
    </div>
  );
}

/** Compact metric tile used inside panels (smaller than StatCard). */
export function MetricTile({
  label,
  value,
  sub,
  tone = "text-foreground",
  hint,
  term,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: string;
  hint?: string;
  /** Options glossary term: (i) tooltip next to the label. */
  term?: OptTermKey;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5 rounded-xl border border-border/60 bg-[var(--glass-bg)] px-3 py-2.5", className)}>
      <div className="flex items-start gap-1 text-xs leading-tight text-muted-foreground">
        <span className="line-clamp-2 min-w-0 break-words">{label}</span>
        {term && <OptTerm term={term} />}
        {hint && <Hint text={hint} />}
      </div>
      <div className={cn("truncate text-lg font-semibold tabular-nums tracking-tight", tone)}>{value}</div>
      {sub && <div className="line-clamp-2 break-words text-2xs text-muted-foreground" title={typeof sub === "string" ? sub : undefined}>{sub}</div>}
    </div>
  );
}
