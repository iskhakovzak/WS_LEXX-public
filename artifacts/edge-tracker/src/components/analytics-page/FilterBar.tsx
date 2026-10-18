import { useEffect, useId, useState } from "react";
import { RotateCcw, Search } from "lucide-react";
import { Segmented, Toolbar } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { analyticsI18n } from "@/i18n/ns/analytics";
import {
  type AnalyticsFilters, type Period, type SideFilter, type Unit, type Horizon, type HorizonFilter,
  DEFAULT_FILTERS, HORIZONS, activeFilterCount, horizonLabel, periodOptions,
} from "./metrics";
import { PersonSelect } from "@/components/people/person-select";

const ALL = "__all__";

export type FilterOptions = {
  traders: string[];
  setups: string[];
  hasNoSetup: boolean;
  tickers: string[];
  /** Broker accounts seen in the data (PropReports); empty when everything is manual. */
  accounts: string[];
  /** True when both manual and PropReports trades exist, so the source switch is meaningful. */
  hasMixedSources: boolean;
};

export function FilterBar({
  filters,
  onChange,
  options,
  unit,
  onUnitChange,
  hasPnl,
  hasR,
  showTrader,
  showSource = false,
  className,
}: {
  filters: AnalyticsFilters;
  onChange: (f: AnalyticsFilters) => void;
  options: FilterOptions;
  unit: Unit;
  onUnitChange: (u: Unit) => void;
  hasPnl: boolean;
  hasR: boolean;
  showTrader: boolean;
  /** Staff only: trades come from PropReports automatically, the manual/broker split is a staff concern. */
  showSource?: boolean;
  className?: string;
}) {
  const { t } = analyticsI18n.useT();
  const set = <K extends keyof AnalyticsFilters>(k: K, v: AnalyticsFilters[K]) => onChange({ ...filters, [k]: v });
  const active = activeFilterCount(filters);
  const tickerListId = useId();
  const [tickerDraft, setTickerDraft] = useState(filters.ticker);
  useEffect(() => setTickerDraft(filters.ticker), [filters.ticker]);

  const commitTicker = (raw: string) => {
    const v = raw.trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 12);
    if (v !== filters.ticker) set("ticker", v);
  };

  return (
    <Toolbar className={cn("gap-2 p-2 sm:p-2.5", className)}>
      <Segmented<Period>
        ariaLabel={t("filters.period")}
        size="sm"
        options={periodOptions()}
        value={filters.period}
        onChange={(v) => set("period", v)}
      />

      <Segmented<"all" | "long" | "short">
        ariaLabel={t("filters.side")}
        size="sm"
        options={[
          { value: "all", label: t("filters.sideAll") },
          { value: "long", label: t("bucket.side.long") },
          { value: "short", label: t("bucket.side.short") },
        ]}
        value={filters.side || "all"}
        onChange={(v) => set("side", (v === "all" ? "" : v) as SideFilter)}
      />

      <Segmented<"all" | Horizon>
        ariaLabel={t("filters.horizon")}
        size="sm"
        options={[
          { value: "all", label: t("filters.horizonAll") },
          ...HORIZONS.map((h) => ({ value: h, label: horizonLabel(h) })),
        ]}
        value={filters.horizon || "all"}
        onChange={(v) => set("horizon", (v === "all" ? "" : v) as HorizonFilter)}
      />

      {showTrader && options.traders.length > 1 && (
        <PersonSelect value={filters.trader || ""} onValueChange={(v) => set("trader", v)} options={options.traders} allLabel={t("filters.allTraders")} ariaLabel={t("filters.trader")} className="h-9 w-auto min-w-[140px] max-w-[200px]" />
      )}

      {(options.setups.length > 0 || filters.setup) && (
        <Select value={filters.setup || ALL} onValueChange={(v) => set("setup", v === ALL ? "" : v)}>
          <SelectTrigger aria-label={t("filters.setup")} className="h-9 w-auto min-w-[140px] max-w-[220px]">
            <SelectValue placeholder={t("filters.allSetups")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("filters.allSetups")}</SelectItem>
            {options.hasNoSetup && <SelectItem value="__none__">{t("filters.noSetup")}</SelectItem>}
            {options.setups.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            {filters.setup && filters.setup !== "__none__" && !options.setups.includes(filters.setup) && (
              <SelectItem value={filters.setup}>{filters.setup}</SelectItem>
            )}
          </SelectContent>
        </Select>
      )}

      {(options.accounts.length > 0 || filters.account) && (
        <Select value={filters.account || ALL} onValueChange={(v) => set("account", v === ALL ? "" : v)}>
          <SelectTrigger aria-label={t("filters.account")} className="h-9 w-auto min-w-[120px] max-w-[200px]">
            <SelectValue placeholder={t("filters.allAccounts")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("filters.allAccounts")}</SelectItem>
            {options.accounts.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
            {filters.account && !options.accounts.includes(filters.account) && <SelectItem value={filters.account}>{filters.account}</SelectItem>}
          </SelectContent>
        </Select>
      )}

      {showSource && (options.hasMixedSources || filters.source) && (
        <Segmented<"all" | "manual" | "propreports">
          ariaLabel={t("filters.source")}
          size="sm"
          options={[
            { value: "all", label: t("filters.allSources") },
            { value: "manual", label: t("filters.manual") },
            { value: "propreports", label: "PropReports" },
          ]}
          value={filters.source || "all"}
          onChange={(v) => set("source", v === "all" ? "" : v)}
        />
      )}

      <form
        role="search"
        className="glass-field flex h-9 items-center gap-1.5 pl-3 pr-1"
        onSubmit={(e) => { e.preventDefault(); commitTicker(tickerDraft); }}
      >
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          aria-label={t("filters.ticker")}
          placeholder={t("filters.ticker")}
          list={tickerListId}
          value={tickerDraft}
          onChange={(e) => {
            const v = e.target.value.toUpperCase();
            setTickerDraft(v);
            if (v === "" || options.tickers.includes(v)) commitTicker(v);
          }}
          onBlur={() => commitTicker(tickerDraft)}
          className="w-20 bg-transparent text-sm uppercase tabular-nums text-foreground placeholder:normal-case placeholder:text-muted-foreground focus:outline-none"
        />
        <datalist id={tickerListId}>
          {options.tickers.map((t) => <option key={t} value={t} />)}
        </datalist>
      </form>

      <div className="ml-auto flex items-center gap-2">
        {active > 0 && (
          <Button variant="ghost" size="sm" onClick={() => onChange(DEFAULT_FILTERS)} aria-label={t("filters.resetAria")}>
            <RotateCcw aria-hidden="true" /> {t("filters.reset")}
            <span className="rounded-full bg-primary/15 px-1.5 text-2xs font-semibold tabular-nums text-primary">{active}</span>
          </Button>
        )}
        <Segmented<Unit>
          ariaLabel={t("filters.unit")}

          size="sm"
          options={[
            { value: "r", label: "R", disabled: !hasR },
            { value: "usd", label: "$", disabled: !hasPnl },
          ]}
          value={unit}
          onChange={onUnitChange}
        />
      </div>
    </Toolbar>
  );
}
