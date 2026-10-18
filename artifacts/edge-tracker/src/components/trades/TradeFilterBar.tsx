import * as React from "react";
import { Bookmark, BookmarkPlus, RotateCcw, Search, SlidersHorizontal, X } from "lucide-react";
import { FilterChip, Segmented, Toolbar } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  EVENT_LABEL,
  EVENT_TYPES,
  HORIZONS,
  HORIZON_LABEL,
  SESSIONS,
  SESSION_LABEL,
  advancedFilterCount,
  isDefaultFilters,
  type Outcome,
  type Period,
  type TradeFilters,
} from "./trade-utils";
import type { SavedView } from "./use-trade-filters";
import { PersonSelect } from "@/components/people/person-select";
import { tradesI18n } from "@/i18n/ns/trades";
import { commonI18n } from "@/i18n/ns/common";

const ALL = "__all";

type Props = {
  filters: TradeFilters;
  patch: (p: Partial<TradeFilters>) => void;
  reset: () => void;
  outcomeCounts: Record<Outcome, number>;
  horizonCounts: Record<string, number>;
  setups: { name: string; count: number }[];
  traders: string[];
  sectors: string[];
  views: SavedView[];
  onSaveView: (name: string) => void;
  onApplyView: (v: SavedView) => void;
  onRemoveView: (id: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
};

/** Built in render: labels follow the UI language. */
function periodOptions(): { value: Period; label: string }[] {
  const tc = commonI18n.t;
  return [
    { value: "all", label: tc("time.allTime") },
    { value: "today", label: tc("time.today") },
    { value: "week", label: tc("time.week") },
    { value: "month", label: tc("time.month") },
  ];
}

export function TradeFilterBar(p: Props) {
  const { t } = tradesI18n.useT();
  const { t: tc } = commonI18n.useT();
  const { filters: f, patch } = p;
  const PERIODS = periodOptions();
  // The trader has its own select in the toolbar; it is not counted as a hidden filter.
  const adv = advancedFilterCount(f) - (f.trader && p.traders.length > 1 ? 1 : 0);
  const quick = (f.outcome !== "all" ? 1 : 0) + (f.side ? 1 : 0) + (f.horizon ? 1 : 0) + (f.setup ? 1 : 0);
  const dirty = !isDefaultFilters(f);

  const outcomeOptions = [
    { value: "all" as Outcome, label: t("filters.outcome.all"), count: p.outcomeCounts.all },
    { value: "win" as Outcome, label: t("filters.outcome.win"), count: p.outcomeCounts.win },
    { value: "loss" as Outcome, label: t("filters.outcome.loss"), count: p.outcomeCounts.loss },
    { value: "breakeven" as Outcome, label: t("filters.outcome.breakeven"), count: p.outcomeCounts.breakeven },
    { value: "open" as Outcome, label: t("filters.outcome.open"), count: p.outcomeCounts.open },
  ];

  return (
    <div className="flex flex-col gap-2">
      <Toolbar className="gap-2">
        <div className="relative min-w-0 flex-1 basis-56">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            ref={p.searchRef as React.Ref<HTMLInputElement>}
            value={f.q}
            onChange={(e) => patch({ q: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Escape") { patch({ q: "" }); (e.target as HTMLInputElement).blur(); } }}
            aria-label={t("filters.searchAria")}
            placeholder={t("filters.searchPlaceholder")}
            className="pl-10 pr-16"
          />
          {f.q ? (
            <button
              type="button"
              aria-label={tc("actions.clearSearch")}
              onClick={() => patch({ q: "" })}
              className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : (
            <Kbd className="absolute right-3 top-1/2 hidden -translate-y-1/2 sm:inline-flex">/</Kbd>
          )}
        </div>

        <Segmented
          ariaLabel={t("filters.period")}
          size="sm"
          options={f.period === "custom" ? [...PERIODS, { value: "custom" as Period, label: t("filters.range") }] : PERIODS}
          value={f.period}
          onChange={(v) => patch({ period: v })}
        />

        {p.traders.length > 1 && (
          <PersonSelect value={f.trader || ""} onValueChange={(v) => patch({ trader: v })} options={p.traders} allLabel={tc("fields.allTraders")} ariaLabel={tc("fields.trader")} className="h-9 w-auto min-w-[140px]" />
        )}

        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className={cn("gap-1.5", (adv + quick) > 0 && "text-primary")} aria-label={adv ? t("filters.advancedAriaActive", { count: adv }) : t("filters.advancedAria")}>
              <SlidersHorizontal className="h-3.5 w-3.5" />
              {tc("actions.filters")}
              {adv + quick > 0 && <span className="rounded-full bg-primary-solid px-1.5 text-xs font-semibold leading-4 text-primary-foreground">{adv + quick}</span>}
            </Button>
          </PopoverTrigger>
          {/* Always below the trigger, inside the viewport, scrolling when taller than the window (audit P0). */}
          <PopoverContent
            side="bottom"
            align="end"
            collisionPadding={12}
            className="max-h-[min(var(--radix-popover-content-available-height),calc(100vh-120px))] w-[min(92vw,380px)] overflow-y-auto overscroll-contain p-4"
          >
            <QuickFilters {...p} outcomeOptions={outcomeOptions} />
            <AdvancedFilters {...p} />
          </PopoverContent>
        </Popover>

        <SavedViews views={p.views} onSave={p.onSaveView} onApply={p.onApplyView} onRemove={p.onRemoveView} canSave={dirty} />

        {dirty && (
          <Button variant="ghost" size="sm" onClick={p.reset} className="gap-1.5 text-muted-foreground">
            <RotateCcw className="h-3.5 w-3.5" /> {tc("actions.reset")}
          </Button>
        )}
      </Toolbar>

      {(f.ticker || f.playbookId || f.setup || f.side || f.horizon || f.outcome !== "all") && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label={t("filters.activeAria")}>
          {f.outcome !== "all" && <ActiveChip onClear={() => patch({ outcome: "all" })}>{outcomeOptions.find((o) => o.value === f.outcome)?.label}</ActiveChip>}
          {f.side && <ActiveChip onClear={() => patch({ side: "" })}>{f.side === "Long" ? tc("trading.long") : f.side === "Short" ? tc("trading.short") : f.side}</ActiveChip>}
          {f.horizon && <ActiveChip onClear={() => patch({ horizon: "" })}>{HORIZON_LABEL[f.horizon]}</ActiveChip>}
          {f.setup && <ActiveChip onClear={() => patch({ setup: "" })}>{t("filters.setupChip", { setup: EVENT_LABEL[f.setup] ?? f.setup })}</ActiveChip>}
          {f.ticker && <ActiveChip onClear={() => patch({ ticker: "" })}>{f.ticker}</ActiveChip>}
          {f.playbookId && <ActiveChip onClear={() => patch({ playbookId: "" })}>{t("filters.playbookChip", { id: f.playbookId })}</ActiveChip>}
        </div>
      )}
    </div>
  );
}

function ActiveChip({ children, onClear }: { children: React.ReactNode; onClear: () => void }) {
  return (
    <FilterChip active onClick={onClear} className="min-h-7 px-2.5 text-xs">
      {children} <X className="ml-1 h-3 w-3" aria-hidden="true" />
    </FilterChip>
  );
}

function QuickFilters(p: Props & { outcomeOptions: { value: Outcome; label: string; count: number }[] }) {
  const { t } = tradesI18n.useT();
  const { t: tc } = commonI18n.useT();
  const { filters: f, patch } = p;
  return (
    <div className="mb-4 space-y-3 border-b border-border/70 pb-4">
        <Segmented ariaLabel={tc("trading.result")} size="sm" options={p.outcomeOptions} value={f.outcome} onChange={(v) => patch({ outcome: v })} />
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("filters.direction")}>
          {(["Long", "Short"] as const).map((s) => (
            <FilterChip key={s} active={f.side === s} onClick={() => patch({ side: f.side === s ? "" : s })} className="min-h-7 px-2.5 text-xs">
              {s === "Long" ? tc("trading.long") : tc("trading.short")}
            </FilterChip>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={tc("trading.horizon")}>
          {HORIZONS.map((h) => (
            <FilterChip
              key={h}
              active={f.horizon === h}
              onClick={() => patch({ horizon: f.horizon === h ? "" : h })}
              count={p.horizonCounts[h] || undefined}
              className="min-h-7 px-2.5 text-xs"
            >
              {HORIZON_LABEL[h]}
            </FilterChip>
          ))}
        </div>
        {p.setups.length > 0 && (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label={tc("trading.setup")}>
            <span className="micro-label hidden sm:inline">{tc("trading.setup")}</span>
            {p.setups.slice(0, 6).map((s) => (
              <FilterChip
                key={s.name}
                active={f.setup === s.name}
                onClick={() => patch({ setup: f.setup === s.name ? "" : s.name })}
                count={s.count}
                className="min-h-7 px-2.5 text-xs"
              >
                {EVENT_LABEL[s.name] ?? s.name}
              </FilterChip>
            ))}
            {f.setup && !p.setups.slice(0, 6).some((s) => s.name === f.setup) && (
              <FilterChip active onClick={() => patch({ setup: "" })} className="min-h-7 px-2.5 text-xs">{f.setup}</FilterChip>
            )}
          </div>
        )}
      </div>
  );
}

function FieldSelect({ id, label, value, onChange, options }: {
  id: string; label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[];
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value || ALL} onValueChange={(v) => onChange(v === ALL ? "" : v)}>
        <SelectTrigger id={id} className="h-9"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{commonI18n.t("states.all")}</SelectItem>
          {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

function AdvancedFilters(p: Props) {
  const { t } = tradesI18n.useT();
  const { t: tc } = commonI18n.useT();
  const { filters: f, patch, sectors } = p;
  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold">{t("filters.more")}</p>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="tf-flt-ticker" className="text-xs text-muted-foreground">{t("filters.tickerExact")}</Label>
          <Input id="tf-flt-ticker" value={f.ticker} onChange={(e) => patch({ ticker: e.target.value.toUpperCase().replace(/[^A-Z0-9.\-]/g, "") })} placeholder="NVDA" className="uppercase" />
        </div>
        <FieldSelect id="tf-flt-session" label={tc("trading.session")} value={f.session} onChange={(v) => patch({ session: v })} options={SESSIONS.map((s) => ({ value: s, label: SESSION_LABEL[s] ?? s }))} />
        <FieldSelect id="tf-flt-event" label={t("filters.eventType")} value={f.eventType} onChange={(v) => patch({ eventType: v })} options={EVENT_TYPES.map((s) => ({ value: s, label: EVENT_LABEL[s] ?? s }))} />
        {sectors.length > 0 && (
          <FieldSelect id="tf-flt-sector" label={tc("trading.sector")} value={f.sector} onChange={(v) => patch({ sector: v })} options={sectors.map((s) => ({ value: s, label: s }))} />
        )}
        <div className="col-span-2 space-y-1.5">
          <Label htmlFor="tf-flt-tag" className="text-xs text-muted-foreground">{t("filters.tagContains")}</Label>
          <Input id="tf-flt-tag" value={f.tag} onChange={(e) => patch({ tag: e.target.value })} placeholder="Gap, Offering…" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tf-flt-from" className="text-xs text-muted-foreground">{t("filters.dateFrom")}</Label>
          <Input id="tf-flt-from" type="date" value={f.period === "custom" ? f.from : ""} onChange={(e) => patch({ period: "custom", from: e.target.value })} className="px-3" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tf-flt-to" className="text-xs text-muted-foreground">{t("filters.dateTo")}</Label>
          <Input id="tf-flt-to" type="date" value={f.period === "custom" ? f.to : ""} onChange={(e) => patch({ period: "custom", to: e.target.value })} className="px-3" />
        </div>
        {f.ids && (
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t("filters.selectedIds")}</Label>
            <Button variant="outline" size="sm" className="h-9 w-full justify-between" onClick={() => patch({ ids: "" })}>
              <span className="truncate tabular-nums">{tc("units.trades", { count: f.ids.split(",").filter(Boolean).length })}</span><X className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>
      <div className="space-y-2 border-t border-border/70 pt-3">
        <p className="text-xs font-semibold">{t("filters.quality")}</p>
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="tf-flt-eff" className="text-xs text-muted-foreground" title={t("filters.exitEffTitle")}>{t("filters.exitEffLabel")}</Label>
            <Input id="tf-flt-eff" type="number" inputMode="numeric" min={-100} max={100} step={5} value={f.exitEffMax} onChange={(e) => patch({ exitEffMax: e.target.value })} placeholder="50" className="px-3" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tf-flt-mfe" className="text-xs text-muted-foreground" title={t("filters.mfeTitle")}>MFE ≥ R</Label>
            <Input id="tf-flt-mfe" type="number" inputMode="decimal" min={0} step={0.5} value={f.mfeRMin} onChange={(e) => patch({ mfeRMin: e.target.value })} placeholder="2" className="px-3" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tf-flt-left" className="text-xs text-muted-foreground" title={t("filters.leftTitle")}>{t("filters.leftLabel")}</Label>
            <Input id="tf-flt-left" type="number" inputMode="decimal" min={0} step={0.5} value={f.leftMin} onChange={(e) => patch({ leftMin: e.target.value })} placeholder="1" className="px-3" />
          </div>
        </div>
        <p className="text-2xs text-muted-foreground">{t("filters.qualityHint")}</p>
      </div>
      {(f.ticker || f.playbookId || f.trader || f.session || f.eventType || f.sector || f.tag || f.source || f.ids || f.exitEffMax || f.mfeRMin || f.leftMin || f.period === "custom") && (
        <Button
          variant="ghost"
          size="sm"
          className="w-full"
          onClick={() => patch({ ticker: "", playbookId: "", trader: "", session: "", eventType: "", sector: "", tag: "", source: "", ids: "", exitEffMax: "", mfeRMin: "", leftMin: "", ...(f.period === "custom" ? { period: "all", from: "", to: "" } : {}) })}
        >
          {t("filters.clearAdvanced")}
        </Button>
      )}
    </div>
  );
}

function SavedViews({ views, onSave, onApply, onRemove, canSave }: {
  views: SavedView[]; onSave: (name: string) => void; onApply: (v: SavedView) => void; onRemove: (id: string) => void; canSave: boolean;
}) {
  const { t } = tradesI18n.useT();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  function save() {
    const n = name.trim();
    if (!n) return;
    onSave(n.slice(0, 40));
    setName("");
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5" aria-label={t("filters.views.aria")}>
          <Bookmark className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">{t("filters.views.button")}</span>
          {views.length > 0 && <span className="tabular-nums text-muted-foreground">{views.length}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(92vw,300px)] p-3">
        <p className="px-1 pb-2 text-sm font-semibold">{t("filters.views.title")}</p>
        {views.length === 0 ? (
          <p className="px-1 pb-2 text-xs text-muted-foreground">{t("filters.views.empty")}</p>
        ) : (
          <ul className="mb-2 space-y-0.5">
            {views.map((v) => (
              <li key={v.id} className="group flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => { onApply(v); setOpen(false); }}
                  className="min-h-8 flex-1 truncate rounded-full px-3 text-left text-sm hover:bg-[var(--glass-hover-bg)]"
                >
                  {v.name}
                </button>
                <button
                  type="button"
                  aria-label={t("filters.views.remove", { name: v.name })}
                  onClick={() => onRemove(v.id)}
                  className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-down"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <form className="flex items-center gap-1.5 border-t border-border pt-2" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <Input
            aria-label={t("filters.views.name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={canSave ? t("filters.views.name") : t("filters.views.setFiltersFirst")}
            disabled={!canSave}
            className="h-8"
          />
          <Button type="submit" size="sm" variant="outline" disabled={!canSave || !name.trim()} aria-label={t("filters.views.save")} className="w-8 shrink-0 px-0">
            <BookmarkPlus className="h-3.5 w-3.5" />
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
