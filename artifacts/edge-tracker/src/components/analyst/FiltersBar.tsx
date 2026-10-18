/**
 * Filters for the actions table: search · type · period on the first row; my tickers / session / extra filters /
 * saved views on the second. Everything except the search is persisted by the page (usePersistentState).
 */
import * as React from "react";
import { Bookmark, ChevronDown, Coins, Search, SlidersHorizontal, Sunrise, Trash2, UserRound, X } from "lucide-react";
import { FilterChip, Kbd, Pill, Segmented, TermTooltip } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { commonI18n } from "@/i18n/ns/common";
import { analystI18n } from "@/i18n/ns/analyst";
import {
  CAP_PRESETS, DEFAULT_FILTERS, PERIODS, PT_SIZES, activeFilterCount,
  type Filters, type Period, type PtSize, type SavedView, type SortKey, type TierFilter, type TypeFilter,
} from "./lib";

export type TypeCounts = Record<TypeFilter, number>;

const chipBtn = "chip inline-flex min-h-8 items-center gap-1.5 px-3 text-sm font-medium";

export function FiltersBar({
  filters: f,
  onChange,
  search,
  onSearch,
  searchRef,
  typeCounts,
  sectors,
  capStats,
  mineCount,
  views,
  onSaveView,
  onDeleteView,
  firmFilter,
  tickerFilter,
  onClearFirm,
  onClearTicker,
  onReset,
  sortKey,
  onSortMode,
  shown,
}: {
  filters: Filters;
  onChange: (patch: Partial<Filters>) => void;
  search: string;
  onSearch: (v: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  typeCounts: TypeCounts;
  sectors: string[];
  capStats?: { known: number; unknown: number };
  mineCount: number;
  views: SavedView[];
  onSaveView: (name: string) => void;
  onDeleteView: (id: string) => void;
  firmFilter: string | null;
  tickerFilter: string | null;
  onClearFirm: () => void;
  onClearTicker: () => void;
  onReset: () => void;
  sortKey: SortKey;
  onSortMode: (k: "time" | "score") => void;
  shown: number;
}) {
  const { t } = analystI18n.useT();
  const extra = (f.tier !== "all" ? 1 : 0) + (f.ptMin ? 1 : 0) + (f.sector ? 1 : 0) + (f.minCapB > 0 ? 1 : 0);
  const anyActive = activeFilterCount(f) > 0 || !!search || !!firmFilter || !!tickerFilter;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-52">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            ref={searchRef}
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { onSearch(""); (e.target as HTMLInputElement).blur(); } }}
            placeholder={t("filters.searchPlaceholder")}
            aria-label={t("filters.searchAria")}
            className="h-8 pl-9 pr-10"
            autoComplete="off"
          />
          <Kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 sm:inline-flex">/</Kbd>
        </div>
        <Segmented<TypeFilter>
          ariaLabel={t("filters.typeAria")}
          size="sm"
          value={f.type}
          onChange={(v) => onChange({ type: v })}
          options={[
            { value: "all", label: commonI18n.t("states.all"), count: typeCounts.all },
            { value: "moves", label: t("filters.type.moves"), count: typeCounts.moves },
            { value: "upgrade", label: t("filters.type.upgrade"), count: typeCounts.upgrade },
            { value: "downgrade", label: t("filters.type.downgrade"), count: typeCounts.downgrade },
            { value: "initiated", label: t("filters.type.initiated"), count: typeCounts.initiated },
            { value: "targets", label: t("filters.type.targets"), count: typeCounts.targets },
          ]}
        />
        <Segmented<Period>
          ariaLabel={t("filters.periodAria")}
          size="sm"
          value={f.period}
          onChange={(v) => onChange({ period: v })}
          options={PERIODS.map((p) => ({ value: p.value, label: p.label }))}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <FilterChip size="sm" active={f.mineOnly} onClick={() => onChange({ mineOnly: !f.mineOnly })} count={mineCount || undefined}>
          <UserRound className="h-3.5 w-3.5" aria-hidden="true" /> {t("filters.myTickers")}
          <Kbd className="ml-0.5 hidden sm:inline-flex">M</Kbd>
        </FilterChip>
        <FilterChip size="sm" active={f.todayOnly} onClick={() => onChange({ todayOnly: !f.todayOnly })}>
          <Sunrise className="h-3.5 w-3.5" aria-hidden="true" /> {t("filters.toSession")}
          <Kbd className="ml-0.5 hidden sm:inline-flex">T</Kbd>
        </FilterChip>

        <Popover>
          <PopoverTrigger asChild>
            <button type="button" aria-pressed={extra > 0} className={chipBtn}>
              <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" /> {commonI18n.t("actions.filters")}
              {extra > 0 && <span className="tabular-nums">· {extra}</span>}
              <ChevronDown className="h-3.5 w-3.5 opacity-70" aria-hidden="true" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80">
            <div className="flex flex-col gap-4">
              <div>
                <div className="micro-label mb-2 flex items-center gap-1">{t("filters.firms")} <TermTooltip term="topFirm" icon /></div>
                <Segmented<TierFilter>
                  ariaLabel={t("filters.tierAria")}
                  size="sm"
                  value={f.tier}
                  onChange={(v) => onChange({ tier: v })}
                  options={[{ value: "all", label: commonI18n.t("states.all") }, { value: "top", label: t("filters.tierTop") }, { value: "other", label: t("filters.tierOther") }]}
                />
              </div>
              <div>
                <div className="micro-label mb-2 flex items-center gap-1">{t("filters.ptChange")} <TermTooltip term="pt" icon /></div>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("filters.ptAria")}>
                  {PT_SIZES.map((v) => (
                    <FilterChip key={v} active={f.ptMin === v} onClick={() => onChange({ ptMin: v as PtSize })} className="min-h-7 px-2.5 text-xs">
                      {v === 0 ? t("filters.any") : `≥ ${v}%`}
                    </FilterChip>
                  ))}
                </div>
              </div>
              {sectors.length > 1 && (
                <div>
                  <Label htmlFor="aa-sector" className="micro-label mb-2 block">{t("filters.sector")}</Label>
                  <select
                    id="aa-sector"
                    value={f.sector ?? ""}
                    onChange={(e) => onChange({ sector: e.target.value || null })}
                    className="glass-field h-9 w-full rounded-lg px-3 text-sm text-foreground"
                  >
                    <option value="">{t("filters.allSectors")}</option>
                    {sectors.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              )}
              <div>
                <div className="micro-label mb-2 flex items-center gap-1"><Coins className="h-3.5 w-3.5" aria-hidden="true" /> {t("filters.capFrom")}</div>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("filters.capAria")}>
                  {CAP_PRESETS.map((b) => (
                    <FilterChip key={b} active={f.minCapB === b} onClick={() => onChange({ minCapB: b })} className="min-h-7 px-2.5 text-xs">
                      {b === 0 ? t("filters.anyCap") : `$${b}B`}
                    </FilterChip>
                  ))}
                </div>
                {f.minCapB > 0 && (
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <Label htmlFor="aa-unknown-cap" className="text-xs font-normal text-muted-foreground">
                      {t("filters.includeUnknown")}{capStats && capStats.unknown > 0 ? ` (${capStats.unknown})` : ""}
                    </Label>
                    <Switch id="aa-unknown-cap" checked={f.includeUnknownCap} onCheckedChange={(v) => onChange({ includeUnknownCap: v })} />
                  </div>
                )}
              </div>
            </div>
          </PopoverContent>
        </Popover>

        <SavedViews views={views} onSave={onSaveView} onDelete={onDeleteView} onApply={(v) => onChange(v.filters)} current={f} />

        {firmFilter && (
          <Pill tone="accent" className="pr-1">
            {t("filters.firm", { name: firmFilter })}
            <button type="button" onClick={onClearFirm} aria-label={t("filters.clearFirm")} className="grid h-6 w-6 place-items-center rounded-full hover:bg-primary/20">
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </Pill>
        )}
        {tickerFilter && (
          <Pill tone="accent" className="pr-1">
            {t("filters.ticker", { name: tickerFilter })}
            <button type="button" onClick={onClearTicker} aria-label={t("filters.clearTicker")} className="grid h-6 w-6 place-items-center rounded-full hover:bg-primary/20">
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </Pill>
        )}
        {anyActive && (
          <Button variant="ghost" size="sm" onClick={onReset}>
            {commonI18n.t("actions.reset")} <Kbd className="hidden sm:inline-flex">Esc</Kbd>
          </Button>
        )}

        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs tabular-nums text-muted-foreground">{t("filters.rows", { count: shown })}</span>
          <Segmented<SortKey>
            ariaLabel={t("filters.orderAria")}
            size="sm"
            value={sortKey}
            onChange={(v) => onSortMode(v === "score" ? "score" : "time")}
            options={[{ value: "time", label: t("filters.newest") }, { value: "score", label: t("filters.important") }]}
          />
        </div>
      </div>
    </div>
  );
}

function SavedViews({
  views, onSave, onDelete, onApply, current,
}: {
  views: SavedView[];
  onSave: (name: string) => void;
  onDelete: (id: string) => void;
  onApply: (v: SavedView) => void;
  current: Filters;
}) {
  const { t } = analystI18n.useT();
  const [name, setName] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const same = (v: SavedView) => JSON.stringify(v.filters) === JSON.stringify(current);
  const active = views.find(same);
  const canSave = name.trim().length > 0 && JSON.stringify(current) !== JSON.stringify(DEFAULT_FILTERS);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-pressed={!!active} className={chipBtn}>
          <Bookmark className="h-3.5 w-3.5" aria-hidden="true" /> {active ? active.name : t("filters.views")}
          <ChevronDown className="h-3.5 w-3.5 opacity-70" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <div className="flex flex-col gap-3">
          {views.length > 0 ? (
            <ul className="flex flex-col gap-0.5" aria-label={t("filters.viewsAria")}>
              {views.map((v) => (
                <li key={v.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => { onApply(v); setOpen(false); }}
                    className={cn(
                      "min-w-0 flex-1 truncate rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-[var(--glass-hover-bg)]",
                      same(v) ? "font-medium text-primary" : "text-foreground",
                    )}
                  >
                    {v.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(v.id)}
                    aria-label={t("filters.removeView", { name: v.name })}
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">{t("filters.viewsHint")}</p>
          )}
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => { e.preventDefault(); if (canSave) { onSave(name.trim()); setName(""); } }}
          >
            <Input value={name} onChange={(e) => setName(e.target.value.slice(0, 40))} placeholder={t("filters.viewName")} aria-label={t("filters.viewName")} className="h-8" />
            <Button type="submit" size="sm" disabled={!canSave}>{commonI18n.t("actions.save")}</Button>
          </form>
        </div>
      </PopoverContent>
    </Popover>
  );
}
