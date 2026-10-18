/**
 * PersonSelect — a searchable drop-in for the trader <Select>: type a name in Russian, English or Uzbek Latin
 * («zokir», «Rakhmatullo», «Pfrbh» on the EN layout) and the list ranks people with the shared matcher.
 * Options show the display name (personName: Latin in EN/UZ when set); the value stays the stored name. The other
 * spelling (Latin alias in RU) is searched and shown as a hint only when it differs from the label. Same look and
 * height as SelectTrigger.
 *
 *   <PersonSelect value={trader} onValueChange={setTrader} options={traders} allLabel="Все трейдеры" self={me} />
 */
import * as React from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { Command as CommandPrimitive } from "cmdk";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { Highlight } from "./highlight";
import { prepareQuery, rankPeople, usePeopleAliases } from "./search";
import { commonI18n } from "@/i18n/ns/common";
import { personName } from "@/i18n";

/** A stored name, or {value, label?, hint?}; a missing label (or one equal to the value) shows personName(value). */
export type PersonOption = string | { value: string; label?: string; hint?: string };

type Props = {
  value: string | null | undefined;
  onValueChange: (value: string) => void;
  options: readonly PersonOption[];
  /** Adds a first option (e.g. «Все трейдеры») whose value is `allValue` ("" by default). */
  allLabel?: string;
  allValue?: string;
  /** Leading icon inside the trigger. */
  icon?: React.ElementType;
  placeholder?: string;
  /** Marks the signed-in person in the list («(я)» by default). */
  self?: string | null;
  selfSuffix?: string;
  ariaLabel?: string;
  /** Trigger classes (width etc.) — same API as SelectTrigger's className. */
  className?: string;
  contentClassName?: string;
  disabled?: boolean;
  align?: "start" | "center" | "end";
  id?: string;
};

type Opt = { value: string; label: string; hint?: string };

const norm = (o: PersonOption): Opt => {
  if (typeof o === "string") return { value: o, label: personName(o) };
  const label = !o.label || o.label === o.value ? personName(o.value) : o.label;
  return { value: o.value, label, hint: o.hint };
};

export function PersonSelect({
  value, onValueChange, options, allLabel, allValue = "", icon: Icon, placeholder: placeholderProp, self, selfSuffix: selfSuffixProp, ariaLabel, className, contentClassName,
  disabled, align = "start", id,
}: Props) {
  const { t } = commonI18n.useT();
  const placeholder = placeholderProp ?? t("roles.trader");
  const selfSuffix = selfSuffixProp ?? t("people.selfSuffix");
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const aliases = usePeopleAliases();
  const opts = React.useMemo(() => options.map(norm), [options]);
  const isAll = !value || value === allValue;
  const current = !isAll && value ? opts.find((o) => o.value === value) ?? { value, label: personName(value) } : null;
  // label → the other spelling (the Latin alias in RU), only when it is not what the label already shows.
  const altOf = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const o of opts) {
      const alias = aliases.get(o.value);
      if (alias && alias !== o.label) m.set(o.label, alias);
    }
    return m;
  }, [opts, aliases]);

  const pq = React.useMemo(() => prepareQuery(query), [query]);
  const hits = React.useMemo(() => rankPeople(opts, pq, (o) => o.label, altOf, (o) => [o.value !== o.label ? o.value : null, o.hint]), [opts, pq, altOf]);

  React.useEffect(() => { if (!open) setQuery(""); }, [open]);

  const pick = (v: string) => { onValueChange(v); setOpen(false); };
  const labelOf = (o: Opt) => (self && o.value === self ? `${o.label} ${selfSuffix}` : o.label);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel ?? placeholder}
          disabled={disabled}
          onKeyDown={(e) => {
            // Type-ahead: a letter on the closed trigger opens the list already filtered.
            if (!open && e.key.length === 1 && /\p{L}|\p{N}/u.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
              e.preventDefault();
              setQuery(e.key);
              setOpen(true);
            }
          }}
          className={cn(
            "glass-field flex h-9 w-full items-center justify-between gap-2 whitespace-nowrap rounded-full px-4 py-2 text-sm ring-offset-background focus:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
        >
          {Icon && <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
          <span className={cn("min-w-0 flex-1 truncate text-left", !current && !allLabel && "text-muted-foreground")} title={current ? labelOf(current) : undefined}>
            {current ? labelOf(current) : allLabel ?? placeholder}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align={align} className={cn("w-[max(var(--radix-popover-trigger-width),15rem)] overflow-hidden p-0", contentClassName)}>
        <CommandPrimitive shouldFilter={false} loop label={ariaLabel ?? placeholder} className="flex flex-col">
          <div className="flex items-center gap-2 border-b border-[var(--glass-border)] px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <CommandPrimitive.Input
              value={query}
              onValueChange={setQuery}
              placeholder={t("people.search")}
              title={t("people.hintLayout")}
              autoComplete="off"
              spellCheck={false}
              className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <CommandPrimitive.List className="max-h-[min(20rem,50dvh)] overflow-y-auto overscroll-contain p-1">
            {hits.length === 0 && <div role="status" className="px-3 py-6 text-center text-sm text-muted-foreground">{t("people.nothing")}</div>}
            {allLabel && pq.empty && (
              <Row value="__all" selected={isAll} onSelect={() => pick(allValue)}>{allLabel}</Row>
            )}
            {hits.map((h) => {
              const alias = altOf.get(h.item.label);
              return (
                <Row key={h.item.value} value={`p:${h.item.value}`} selected={h.item.value === value} onSelect={() => pick(h.item.value)}>
                  <span className="min-w-0 truncate" title={labelOf(h.item)}>
                    {h.field === 0 ? <Highlight text={labelOf(h.item)} ranges={h.ranges} /> : labelOf(h.item)}
                  </span>
                  {(alias || h.item.hint) && (
                    <span className="ml-auto min-w-0 shrink truncate pl-2 text-2xs text-muted-foreground">
                      {alias ? (h.field === 1 ? <Highlight text={alias} ranges={h.ranges} /> : alias) : h.item.hint}
                    </span>
                  )}
                </Row>
              );
            })}
          </CommandPrimitive.List>
        </CommandPrimitive>
      </PopoverContent>
    </Popover>
  );
}

function Row({ value, selected, onSelect, children }: { value: string; selected: boolean; onSelect: () => void; children: React.ReactNode }) {
  return (
    <CommandPrimitive.Item
      value={value}
      onSelect={onSelect}
      className="flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-item px-2.5 py-1.5 text-sm outline-none data-[selected=true]:bg-primary/12"
    >
      <Check className={cn("h-3.5 w-3.5 shrink-0 text-primary", !selected && "invisible")} aria-hidden="true" />
      {children}
    </CommandPrimitive.Item>
  );
}
