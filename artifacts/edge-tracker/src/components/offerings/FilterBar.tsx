import { useEffect, useRef, useState } from "react";
import { Bookmark, Download, Search, SlidersHorizontal, X } from "lucide-react";
import { FilterChip, Kbd, Toolbar } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  BUILTIN_PRESETS, EMPTY_FILTERS, activeFilterCount, describeFilters, normalizeFilters, sameFilters,
  type FilterPreset, type OfferingFilters,
} from "./filters";
import { DEAL_TYPE_HINT, DEAL_TYPE_LABEL, type DealType } from "./score";
import { commonI18n } from "@/i18n/ns/common";
import { offeringsI18n } from "@/i18n/ns/offerings";

const TYPES: DealType[] = ["spo", "direct", "pipe", "atm", "ipo", "shelf", "s1"];

function NumField({ label, value, onChange, suffix, placeholder, step = 1 }: {
  label: string; value: number | null; onChange: (v: number | null) => void; suffix?: string; placeholder?: string; step?: number;
}) {
  const [text, setText] = useState(value == null ? "" : String(value));
  useEffect(() => { setText(value == null ? "" : String(value)); }, [value]);
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <span className="relative">
        <Input
          inputMode="decimal"
          type="number"
          step={step}
          min={0}
          value={text}
          placeholder={placeholder ?? "—"}
          onChange={(e) => {
            setText(e.target.value);
            const v = e.target.value.trim() === "" ? null : Number(e.target.value.replace(",", "."));
            onChange(v == null || !Number.isFinite(v) ? null : v);
          }}
          className={cn("h-8 tabular-nums", suffix && "pr-8")}
        />
        {suffix && <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-2xs text-muted-foreground">{suffix}</span>}
      </span>
    </label>
  );
}

export function FilterBar({
  filters,
  onChange,
  presets,
  onSavePreset,
  onDeletePreset,
  query,
  onQuery,
  searchRef,
  mineCount,
  onExport,
  canExport,
  shown,
  total,
}: {
  filters: OfferingFilters;
  onChange: (f: OfferingFilters) => void;
  presets: FilterPreset[];
  onSavePreset: (name: string) => void;
  onDeletePreset: (id: string) => void;
  query: string;
  onQuery: (q: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  mineCount: number;
  onExport: () => void;
  canExport: boolean;
  shown: number;
  total: number;
}) {
  const { t } = offeringsI18n.useT();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const count = activeFilterCount(filters);
  const all = [...BUILTIN_PRESETS, ...presets];
  const activePreset = all.find((p) => sameFilters(p.filters, filters) && count > 0);
  const set = (patch: Partial<OfferingFilters>) => onChange(normalizeFilters({ ...filters, ...patch }));

  return (
    <Toolbar className="gap-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          ref={searchRef}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={t("filters.searchPlaceholder")}
          aria-label={t("filters.searchAria")}
          className="h-8 w-48 pl-9 pr-9"
        />
        {query ? (
          <button type="button" onClick={() => onQuery("")} className="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:text-foreground" aria-label={commonI18n.t("actions.clearSearch")}>
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : <Kbd className="absolute right-2 top-1/2 -translate-y-1/2">/</Kbd>}
      </div>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant={count ? "secondary" : "outline"} size="sm" className="h-8" aria-label={count ? t("filters.filtersAria", { count }) : commonI18n.t("actions.filters")}>
            <SlidersHorizontal aria-hidden="true" /> {commonI18n.t("actions.filters")}
            {count > 0 && <span className="rounded-full bg-primary/15 px-1.5 text-2xs tabular-nums text-primary">{count}</span>}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[22rem] space-y-3">
          <div>
            <div className="mb-1.5 text-xs text-muted-foreground">{t("filters.dealType")}</div>
            <div className="flex flex-wrap gap-1">
              {TYPES.map((dt) => {
                const on = filters.types.includes(dt);
                return (
                  <button key={dt} type="button" aria-pressed={on} title={DEAL_TYPE_HINT[dt]}
                    onClick={() => set({ types: on ? filters.types.filter((x) => x !== dt) : [...filters.types, dt] })}
                    className="chip inline-flex min-h-7 items-center px-2.5 text-xs font-medium">
                    {DEAL_TYPE_LABEL[dt]}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <NumField label={t("filters.minPctMcap")} value={filters.minPctMcap} onChange={(v) => set({ minPctMcap: v })} suffix="%" />
            <NumField label={t("filters.minDiscount")} value={filters.minDiscount} onChange={(v) => set({ minDiscount: v })} suffix="%" />
            <NumField label={t("filters.priceMin")} value={filters.priceMin} onChange={(v) => set({ priceMin: v })} suffix="$" step={0.5} />
            <NumField label={t("filters.priceMax")} value={filters.priceMax} onChange={(v) => set({ priceMax: v })} suffix="$" step={0.5} />
            <NumField label={t("filters.floatMax")} value={filters.floatMaxM} onChange={(v) => set({ floatMaxM: v })} suffix="M" />
            <NumField label={t("filters.mcapMax")} value={filters.mcapMaxM} onChange={(v) => set({ mcapMaxM: v })} suffix="M" step={50} />
            <NumField label={t("filters.minScore")} value={filters.minScore} onChange={(v) => set({ minScore: v == null ? null : Math.min(100, v) })} />
            <label className="flex items-end gap-2 pb-1.5 text-xs text-foreground">
              <input type="checkbox" checked={filters.mine} onChange={(e) => set({ mine: e.target.checked })} className="h-4 w-4 accent-[hsl(var(--primary))]" />
              {t("filters.mineOnly")}
            </label>
          </div>
          <p className="text-2xs text-muted-foreground">{t("filters.numericHint")}</p>
          <form
            className="flex items-center gap-2 border-t border-[var(--glass-border)] pt-3"
            onSubmit={(e) => {
              e.preventDefault();
              const n = name.trim();
              if (!n || count === 0) { nameRef.current?.focus(); return; }
              onSavePreset(n);
              setName("");
            }}
          >
            <Input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("filters.presetName")} aria-label={t("filters.presetNameAria")} className="h-8 flex-1" maxLength={40} />
            <Button type="submit" size="sm" variant="outline" className="h-8" disabled={count === 0 || !name.trim()}>
              <Bookmark aria-hidden="true" /> {commonI18n.t("actions.save")}
            </Button>
          </form>
          <div className="flex justify-between">
            <Button type="button" variant="ghost" size="sm" className="h-8" disabled={count === 0} onClick={() => onChange(EMPTY_FILTERS)}>{commonI18n.t("actions.reset")}</Button>
            <Button type="button" size="sm" className="h-8" onClick={() => setOpen(false)}>{commonI18n.t("actions.done")}</Button>
          </div>
        </PopoverContent>
      </Popover>

      <div className="flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label={t("filters.presetsAria")}>
        <FilterChip active={filters.mine} onClick={() => set({ mine: !filters.mine })} count={mineCount} className="min-h-8 text-xs">
          {t("filters.myTickers")}
        </FilterChip>
        {all.map((p) => {
          const on = activePreset?.id === p.id;
          return (
            <span key={p.id} className="group/preset relative inline-flex" title={describeFilters(p.filters)}>
              <FilterChip active={on} onClick={() => onChange(on ? EMPTY_FILTERS : p.filters)} className={cn("min-h-8 text-xs", !p.builtin && "pr-7")}>
                {p.name}
              </FilterChip>
              {!p.builtin && (
                <button type="button" onClick={() => onDeletePreset(p.id)} aria-label={t("filters.deletePreset", { name: p.name })}
                  className="absolute right-1.5 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:text-foreground">
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              )}
            </span>
          );
        })}
      </div>

      <div className="ml-auto flex items-center gap-2">
        <span className="text-xs tabular-nums text-muted-foreground" aria-live="polite">{shown === total ? `${total}` : commonI18n.t("states.ofTotal", { value: shown, total })}</span>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onExport} disabled={!canExport} aria-label={t("filters.downloadCsv")} title={t("filters.downloadCsv")}>
          <Download aria-hidden="true" />
        </Button>
      </div>
    </Toolbar>
  );
}
