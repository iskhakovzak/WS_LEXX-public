import { useCallback, useMemo } from "react";
import { CalendarX, RefreshCw } from "lucide-react";
import { BentoGrid, EmptyState, ErrorState, PanelSkeleton, StatGridSkeleton, UpdatedAgo, usePersistentState } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/auth-context";
import { useTradesBookFacets, useTradesWindow } from "@/hooks/use-trades-window";
import { useToast } from "@/hooks/use-toast";
import { useSectors } from "@/lib/market-intel";
import { nyDate } from "@/lib/trading-date";
import { cn } from "@/lib/utils";
import {
  DIMENSIONS, INDICATORS, INDICATOR_BY_ID, alertFires, analogues as findAnalogues, baseline, bucketize, buildFrame, joinDays, readings,
  regimeAt, tercileDimension, traderDays, type AlertRule, type IndicatorId,
} from "./engine";
import { useMarketData } from "./useMarketData";
import { useMarketAlerts } from "./alerts";
import { MarketCard } from "./MarketCard";
import { RegimePanel } from "./RegimePanel";
import { EdgeByRegime, type DimResult } from "./EdgeByRegime";
import { AnaloguesPanel, TodayForYou } from "./TodayForYou";
import { dayLabel, nextWeekday, nyMinutes, sessionInProgress } from "./format";
import { PersonSelect } from "@/components/people/person-select";
import { commonI18n } from "@/i18n/ns/common";
import { indicatorsI18n } from "@/i18n/ns/indicators";

import { personName } from "@/i18n";
const SYMBOL_NAME: Record<string, string> = { qqq: "QQQ", iwm: "IWM", rsp: "RSP", vix: "VIX", vix3m: "VIX3M" };
const symbolName = (k: string) => SYMBOL_NAME[k] ?? indicatorsI18n.tryT(`market.symbols.${k}`) ?? k;

/**
 * «Рынок и мой эдж»: today's market regime from index data (SPY, VIX, IWM, RSP, yields, dollar), and how this
 * trader actually did on sessions with the same conditions (PropReports days joined with the daily frame).
 */
export function MarketView() {
  const { t } = indicatorsI18n.useT();
  const { user } = useAuth();
  const isStaff = user?.role === "curator" || user?.role === "admin";
  const me = user?.traderName ?? "";
  const facets = useTradesBookFacets({ enabled: isStaff });
  const traders = useMemo(() => {
    const list = facets.data?.traders ?? [];
    return me && !list.includes(me) ? [me, ...list] : list;
  }, [facets.data, me]);
  const [picked, setPicked] = usePersistentState<string>("indicators.market.trader", "");
  const trader = isStaff ? (picked && traders.includes(picked) ? picked : me || traders[0] || "") : me;

  const market = useMarketData();
  // Same window as «Вотчлист» / «Катализаторы» ({ trader }) → one cached download of the book across the premarket
  // pages; only days inside the 2-year market frame are joined anyway (joinDays).
  const tradesQ = useTradesWindow({ trader: trader || undefined }, { enabled: !!trader, staleTime: 5 * 60_000 });
  const { alerts, setAlert } = useMarketAlerts();
  const sectorsQ = useSectors();
  const { toast } = useToast();
  const [focus, setFocus] = usePersistentState<IndicatorId>("indicators.market.focus", "vix");
  const focusDef = INDICATOR_BY_ID.get(focus) ?? INDICATORS[0];

  const rows = useMemo(() => buildFrame(market.data), [market.data]);
  const reads = useMemo(() => readings(rows), [rows]);
  const readById = useMemo(() => new Map(reads.map((r) => [r.id, r])), [reads]);
  const last = rows.length - 1;
  const lastDate = last >= 0 ? rows[last].d : null;
  // After 16:00 NY the day's bar is final: treat it as the last known close, not as a running session.
  const live = sessionInProgress(lastDate, nyDate(), nyMinutes());
  /** Index of the last close known before the next (or current) session opens. */
  const stateIdx = live ? last - 1 : last;
  /** Frame index the pre-open classifiers should look at for "today" (rows.length = the session that has not started). */
  const todayIdx = live ? last : rows.length;
  const regime = useMemo(() => (stateIdx >= 0 ? regimeAt(rows, stateIdx) : null), [rows, stateIdx]);

  const days = useMemo(() => traderDays(tradesQ.data ?? []), [tradesQ.data]);
  const joined = useMemo(() => joinDays(rows, days), [rows, days]);
  const base = useMemo(() => baseline(joined, rows), [joined, rows]);
  const totalTrades = useMemo(() => joined.reduce((a, j) => a + j.day.trades, 0), [joined]);

  const { pre, day } = useMemo(() => {
    const pre: DimResult[] = [];
    const day: DimResult[] = [];
    for (const dim of DIMENSIONS) {
      const buckets = bucketize(dim, rows, joined);
      if (dim.when === "pre") {
        pre.push({ dim, buckets, today: rows.length ? dim.classify(rows, todayIdx) : null, todayNote: t("market.todayNotePre") });
      } else {
        day.push({ dim, buckets, today: live ? dim.classify(rows, last) : null, todayNote: t("market.todayNoteDay") });
      }
    }
    return { pre, day };
  }, [rows, joined, todayIdx, live, last, t]);

  const focusResult = useMemo<DimResult | null>(() => {
    const terc = tercileDimension(focusDef, rows, joined);
    if (!terc) return null;
    return {
      dim: { id: `ind-${focusDef.id}`, label: t("market.focusLabel", { label: focusDef.label }), when: "pre", explain: t("market.focusExplain", { explain: focusDef.explain }) },
      buckets: bucketize(terc.dim, rows, joined),
      today: rows.length ? terc.dim.classify(rows, todayIdx) : null,
    };
  }, [focusDef, rows, joined, todayIdx, t]);

  const analogues = useMemo(() => findAnalogues(rows, joined, stateIdx, 8, live ? lastDate ?? undefined : undefined), [rows, joined, stateIdx, live, lastDate]);

  const fired = useMemo(
    () => INDICATORS.flatMap((def) => {
      const rule = alerts[def.id];
      const reading = readById.get(def.id);
      return rule && reading && alertFires(rule, reading.value) ? [{ id: def.id, rule, reading }] : [];
    }),
    [alerts, readById],
  );

  const sectors = useMemo(() => {
    const list = (sectorsQ.data?.sectors ?? []).filter((s) => s.changePct != null);
    if (!list.length) return null;
    return { up: list.filter((s) => (s.changePct ?? 0) > 0).length, total: list.length, label: live ? t("market.sectorsToday") : t("market.sectorsClose") };
  }, [sectorsQ.data, live, t]);

  const onSaveAlert = useCallback(async (id: IndicatorId, rule: AlertRule | null) => {
    const ok = await setAlert(id, rule);
    if (!ok) toast({ title: t("market.alertLocalTitle"), description: t("market.alertLocalText") });
  }, [setAlert, toast, t]);

  const sessionLabel = lastDate
    ? live ? t("market.sessionLive") : t("market.sessionNext", { next: dayLabel(nextWeekday(lastDate), true), last: dayLabel(lastDate, true) })
    : "";
  const failedNames = market.failed.filter((k) => k !== "spy").map(symbolName);

  const toolbar = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {isStaff && traders.length > 0 && (
        <PersonSelect value={trader} onValueChange={setPicked} options={traders} self={me} ariaLabel={t("market.traderAria")} className="h-9 w-[12rem]" />
      )}
      <span className="text-xs text-muted-foreground">{t("market.sources")}</span>
      <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
        {market.updatedAt > 0 && <UpdatedAgo at={market.updatedAt} prefix={t("market.updated")} />}
        <Button variant="ghost" size="sm" onClick={market.refetch} disabled={market.isFetching} aria-label={t("market.refreshAria")}>
          <RefreshCw className={cn("h-3.5 w-3.5", market.isFetching && "motion-safe:animate-spin")} aria-hidden="true" />
          {commonI18n.t("actions.refresh")}
        </Button>
      </span>
    </div>
  );

  if (market.isError) {
    return (
      <div className="flex flex-col gap-[var(--grid-gap)]">
        {toolbar}
        <ErrorState title={t("market.errorTitle")} message={t("market.errorText")} onRetry={market.refetch} />
      </div>
    );
  }

  if (market.isLoading || !regime) {
    return (
      <div className="flex flex-col gap-[var(--grid-gap)]" aria-busy="true">
        {toolbar}
        <BentoGrid>
          <PanelSkeleton height={260} className="lg:col-span-7" />
          <PanelSkeleton height={260} className="lg:col-span-5" />
        </BentoGrid>
        <StatGridSkeleton count={8} min="15rem" />
        <PanelSkeleton height={360} />
      </div>
    );
  }

  const noDays = !tradesQ.isLoading && joined.length === 0;

  return (
    <div className="flex flex-col gap-[var(--grid-gap)]">
      {toolbar}
      {failedNames.length > 0 && (
        <p className="text-xs text-warn">{t("market.missing", { names: failedNames.join(", ") })}</p>
      )}

      <BentoGrid>
        <div className="min-w-0 lg:col-span-7"><RegimePanel regime={regime} asOf={sessionLabel} /></div>
        <div className="min-w-0 lg:col-span-5">
          {tradesQ.isLoading ? (
            <PanelSkeleton height={260} className="h-full" />
          ) : (
            <TodayForYou sessionLabel={trader ? t("market.traderDays", { trader: personName(trader), days: commonI18n.t("units.days", { count: joined.length }) }) : ""} analogues={analogues} pre={pre} base={base} fired={fired} alertsCount={Object.keys(alerts).length} sectors={sectors} />
          )}
        </div>
      </BentoGrid>

      <div className="grid gap-[var(--grid-gap)] sm:grid-cols-2 xl:grid-cols-4" role="list" aria-label={t("market.cardsAria")}>
        {INDICATORS.map((def) => (
          <div key={def.id} role="listitem" className="min-w-0">
            <MarketCard def={def} reading={readById.get(def.id)} rule={alerts[def.id]} focused={focus === def.id} onFocus={setFocus} onSaveAlert={onSaveAlert} />
          </div>
        ))}
      </div>

      {tradesQ.isLoading ? (
        <BentoGrid>
          <PanelSkeleton height={420} className="lg:col-span-8" />
          <PanelSkeleton height={420} className="lg:col-span-4" />
        </BentoGrid>
      ) : noDays ? (
        <EmptyState
          icon={CalendarX}
          title={t("market.noDaysTitle")}
          description={trader ? t("market.noDaysTrader", { trader: personName(trader) }) : t("market.noDaysPick")}
        />
      ) : (
        <BentoGrid>
          <div className="min-w-0 lg:col-span-8">
            <EdgeByRegime focusDef={focusDef} focusResult={focusResult} pre={pre} day={day} base={base} totalDays={joined.length} totalTrades={totalTrades} />
          </div>
          <div className="min-w-0 lg:col-span-4"><AnaloguesPanel analogues={analogues} trader={trader} /></div>
        </BentoGrid>
      )}
    </div>
  );
}

