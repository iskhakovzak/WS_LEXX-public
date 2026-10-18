import { useMemo, useState } from "react";
import type { Trade } from "@workspace/api-client-react";
import { Check, ChevronDown, RotateCcw, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toneOf, toneText } from "@/components/ds";
import { analyticsProI18n } from "@/i18n/ns/analyticsPro";
import {
  type Filters, type FilterKey, type Metric, type ValueFn, EMPTY_FILTERS,
  applyFilters, optionContribution,
} from "@/lib/analytics-pro";
import { fmtVal } from "./pro-format";

export type FilterOption = { id: string; label: string };

const tp = analyticsProI18n.t;
const GROUP_KEYS: FilterKey[] = ["accounts", "symbols", "years", "months", "daysOfWeek", "timeBuckets", "strategies", "types", "globalTags", "personalTags"];
/** Filter groups; titles are getters (read when rendered, so they follow the UI language). */
export const FILTER_GROUPS: { key: FilterKey; readonly title: string }[] = GROUP_KEYS.map((key) => ({
  key, get title() { return tp(`filters.group.${key}`); },
}));

function FilterPopover({
  title, group, options, filters, allTrades, onChange, metric, val,
}: {
  title: string;
  group: FilterKey;
  options: FilterOption[];
  filters: Filters;
  allTrades: Trade[];
  onChange: (next: Filters) => void;
  metric: Metric;
  val: ValueFn;
}) {
  const [open, setOpen] = useState(false);
  const selected = filters[group] as string[];

  // Contribution of each option given every *other* active filter — only computed while open.
  const enriched = useMemo(() => {
    if (!open) return [];
    return options.map((o) => ({ ...o, ...optionContribution(allTrades, filters, group, o.id, val) }));
  }, [open, options, filters, group, allTrades, val]);

  const allNet = useMemo(() => {
    if (!open) return 0;
    return applyFilters(allTrades, { ...filters, [group]: [] }).reduce((s, t) => s + (val(t) ?? 0), 0);
  }, [open, allTrades, filters, group, val]);

  const toggle = (id: string) => {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    onChange({ ...filters, [group]: next });
  };

  const active = selected.length > 0;
  const firstLabel = active ? options.find((o) => o.id === selected[0])?.label ?? selected[0] : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-active={active}
          aria-label={active ? tp("filters.selected", { title, count: selected.length }) : tp("filters.filter", { title })}
          className="chip inline-flex min-h-8 max-w-[220px] items-center gap-1.5 px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="truncate">
            {active ? (selected.length === 1 ? firstLabel : `${title} · ${selected.length}`) : title}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-80" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(18rem,calc(100vw-2rem))] p-0">
        <Command>
          {options.length > 7 && <CommandInput placeholder={tp("filters.find", { title: title.toLowerCase() })} />}
          <CommandList className="max-h-72">
            <CommandEmpty>{tp("filters.nothing")}</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__all__"
                onSelect={() => onChange({ ...filters, [group]: [] })}
                className="flex items-center gap-2"
              >
                <CheckBox checked={!active} />
                <span className="flex-1">{tp("filters.all")}</span>
                <span className={cn("text-xs tabular-nums", toneText(toneOf(allNet)))}>{fmtVal(metric, allNet, { compact: true, sign: true })}</span>
              </CommandItem>
              {enriched.map((o) => {
                const checked = selected.includes(o.id);
                const disabled = o.count === 0 && !checked;
                return (
                  <CommandItem
                    key={o.id}
                    value={`${o.label} ${o.id}`}
                    disabled={disabled}
                    onSelect={() => toggle(o.id)}
                    className="flex items-center gap-2"
                  >
                    <CheckBox checked={checked} />
                    <span className="min-w-0 flex-1 truncate" title={o.label}>{o.label}</span>
                    <span className="text-2xs tabular-nums text-muted-foreground">{o.count}</span>
                    <span className={cn("w-16 text-right text-xs tabular-nums", toneText(toneOf(o.net)))}>
                      {o.count ? fmtVal(metric, o.net, { compact: true, sign: true }) : "—"}
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
        {active && (
          <div className="flex justify-end border-t border-border p-2">
            <Button variant="ghost" size="sm" onClick={() => onChange({ ...filters, [group]: [] })}>
              {tp("filters.clear")}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function CheckBox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid h-4 w-4 shrink-0 place-items-center rounded-[5px] border transition-colors",
        checked ? "border-transparent bg-primary text-primary-foreground" : "border-border",
      )}
    >
      {checked && <Check className="h-3 w-3" strokeWidth={3} />}
    </span>
  );
}

export function activeFilterCount(f: Filters): number {
  return FILTER_GROUPS.reduce((n, g) => n + (f[g.key] as string[]).length, 0);
}

export function FilterBar({
  filters, onChange, options, allTrades, metric, val,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  options: Record<FilterKey, FilterOption[]>;
  allTrades: Trade[];
  metric: Metric;
  val: ValueFn;
}) {
  const activeCount = activeFilterCount(filters);
  const activeChips = FILTER_GROUPS.flatMap((g) =>
    (filters[g.key] as string[]).map((id) => ({
      group: g.key,
      title: g.title,
      id,
      label: options[g.key].find((o) => o.id === id)?.label ?? id,
    })),
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={tp("filters.aria")}>
        {FILTER_GROUPS.filter((g) => options[g.key].length > 0 || (filters[g.key] as string[]).length > 0).map((g) => (
          <FilterPopover
            key={g.key}
            title={g.title}
            group={g.key}
            options={options[g.key]}
            filters={filters}
            allTrades={allTrades}
            onChange={onChange}
            metric={metric}
            val={val}
          />
        ))}
        {activeCount > 0 && (
          <Button variant="ghost" size="sm" onClick={() => onChange(EMPTY_FILTERS)} className="text-muted-foreground">
            <RotateCcw aria-hidden="true" />
            {tp("filters.reset")}
          </Button>
        )}
      </div>
      {activeChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label={tp("filters.activeAria")}>
          {activeChips.map((c) => (
            <span
              key={`${c.group}:${c.id}`}
              className="inline-flex items-center gap-1 rounded-full bg-primary/15 py-0.5 pl-2.5 pr-1 text-xs font-medium text-primary"
            >
              <span className="text-primary/80">{c.title}:</span> {c.label}
              <button
                type="button"
                onClick={() => onChange({ ...filters, [c.group]: (filters[c.group] as string[]).filter((x) => x !== c.id) })}
                className="grid h-6 w-6 place-items-center rounded-full hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={tp("filters.remove", { title: c.title, label: c.label })}

              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
