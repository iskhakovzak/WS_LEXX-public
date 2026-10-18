/** Searchable setup-type picker (Popover + cmdk). Typing a custom type is allowed. */
import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { SETUP_GROUPS } from "./model";
import { SetupTypePill } from "./setup-bits";
import { setupTypeLabel } from "@/i18n/ns/dataCodes";
import { playbookI18n } from "@/i18n/ns/playbook";
const pt = playbookI18n.t; // called at render time only
import { commonI18n } from "@/i18n/ns/common";

export function SetupTypeSelect({ value, onChange, id }: { value: string; onChange: (v: string) => void; id?: string }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const pick = (v: string) => { onChange(v); setOpen(false); setSearch(""); };
  const custom = search.trim();
  const known = SETUP_GROUPS.some((g) => g.items.some((i) => i.toLowerCase() === custom.toLowerCase() || setupTypeLabel(i).toLowerCase() === custom.toLowerCase()));

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSearch(""); }}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          className="glass-field flex h-9 w-full items-center justify-between gap-2 px-3 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {value ? <SetupTypePill type={value} /> : <span className="text-muted-foreground">{pt("setupType.placeholder")}</span>}
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(320px,calc(100vw-2rem))] p-0" align="start">
        <Command className="bg-transparent">
          <CommandInput value={search} onValueChange={setSearch} placeholder={pt("setupType.search")} aria-label={pt("setupType.search")} />
          <CommandList className="max-h-[min(55dvh,440px)]">
            <CommandEmpty className="py-4 text-center text-xs text-muted-foreground">{commonI18n.t("states.nothingFound")}</CommandEmpty>
            {custom && !known && (
              <CommandGroup heading={pt("setupType.custom")}>
                <CommandItem value={`__custom ${custom}`} onSelect={() => pick(custom)}>{pt("setupType.useCustom", { value: custom })}</CommandItem>
              </CommandGroup>
            )}
            {value && !custom && (
              <CommandGroup>
                <CommandItem value="__reset" onSelect={() => pick("")} className="text-muted-foreground">{pt("setupType.reset")}</CommandItem>
              </CommandGroup>
            )}
            {SETUP_GROUPS.map((g) => (
              <CommandGroup key={g.label} heading={g.label}>
                {g.items.map((s) => (
                  <CommandItem key={s} value={s === setupTypeLabel(s) ? s : `${s} ${setupTypeLabel(s)}`} onSelect={() => pick(s)}>
                    <Check className={cn("h-4 w-4", value === s ? "opacity-100 text-primary" : "opacity-0")} aria-hidden="true" />
                    {setupTypeLabel(s)}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
