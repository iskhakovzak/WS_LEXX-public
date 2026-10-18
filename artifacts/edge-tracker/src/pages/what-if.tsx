import { type ReactNode, useEffect, useMemo, useState } from "react";
import { BarChart3, ChevronDown, FlaskConical, Lightbulb, ListX, Loader2, Receipt, RefreshCw, SearchX, SlidersHorizontal, TrendingUp } from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, Page, PageHeader, Panel, Pill, Segmented } from "@/components/ds";
import { addDays, nyDate } from "@/lib/trading-date";
import { cn } from "@/lib/utils";
import { commonI18n } from "@/i18n/ns/common";
import { whatIfI18n } from "@/i18n/ns/whatIf";
import { comparePersonNames, personName } from "@/i18n";
import { DEFAULT_FILTERS, type AnalyticsFilters } from "@/components/analytics-page/metrics";
import {
  type Scope, type Suggestion, useDebounced, useDeleteScenario, useSaveScenario, useSavedScenarios, useWhatIfBase, useWhatIfFees, useWhatIfRun, useWhatIfSuggestions,
} from "@/components/what-if/api";
import { LEGACY_RULE_TYPES, type Rule, type RuleType, decodeRules, encodeRules, mergeRule, removeRule, subtractRule } from "@/components/what-if/rules";
import { SuggestionCards } from "@/components/what-if/suggestions-panel";
import { ScenarioBar } from "@/components/what-if/scenario-bar";
import { BootstrapDetails, DeltaHeadline, KeyMetrics, MetricsTable } from "@/components/what-if/compare-panel";
import { ChartSkeleton, DailyHistogram, EquityChart } from "@/components/what-if/equity-chart";
import { RuleBuilder } from "@/components/what-if/rule-builder";
import { FeesBlock } from "@/components/what-if/fees-tab";
import { CostsByGroup } from "@/components/analytics-page/CostsTab";
import { ExcludedTable } from "@/components/what-if/excluded-table";
import { ChangedDays, QuestionsBar } from "@/components/what-if/questions-bar";
import { type Question, buildQuestions, changedDays } from "@/components/what-if/presets";
import { useLocation } from "wouter";
import { PersonSelect } from "@/components/people/person-select";

/**
 * /what-if — «Что если» (was /simulator; old links with ?r= / ?p= / ?trader= redirect here): the trader's own closed trades re-run under other rules (server engine
 * api-server/src/lib/whatIf.ts). One page, top to bottom: questions («а что если бы я…», one click each) → the
 * result first (before → after in $ and R, the difference big, equity curves, the days that change most — each
 * opens /day-report) → suggestions found in the data → own rule builder → fees. The scenario, period and trader
 * live in the URL (?r=…&p=…&trader=…), so a link opens exactly the same view. Nothing is stored unless
 * a scenario is saved explicitly. This is the one place for rule and fee what-ifs: the analytics «Что если» tab
 * is a compact summary that links here (with #fees for the fee block).
 */

type PeriodKey = "30d" | "90d" | "ytd" | "all";
const PERIOD_KEYS: PeriodKey[] = ["30d", "90d", "ytd", "all"];
const ALL = "__all__";
const PREFS_KEY = "ws.simulator.prefs.v1";

function periodFrom(p: PeriodKey, today: string): string {
  switch (p) {
    case "30d": return addDays(today, -30);
    case "90d": return addDays(today, -90);
    case "ytd": return `${today.slice(0, 4)}-01-01`;
    default: return "";
  }
}

const isPeriod = (v: unknown): v is PeriodKey => PERIOD_KEYS.includes(v as PeriodKey);

function loadPrefs(): { period: PeriodKey; trader: string } {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<{ period: PeriodKey; trader: string }>;
    return { period: isPeriod(p.period) ? p.period : "all", trader: typeof p.trader === "string" ? p.trader : "" };
  } catch {
    return { period: "all", trader: "" };
  }
}

/** Initial state: URL first (shared link), then the viewer's last choice. */
function initialState(me: string) {
  const sp = new URLSearchParams(window.location.search);
  const prefs = loadPrefs();
  const p = sp.get("p");
  return {
    period: isPeriod(p) ? p : prefs.period,
    trader: sp.get("trader") ?? (prefs.trader || me),
    rules: decodeRules(sp.get("r")),
  };
}

export default function WhatIf() {
  const { t } = whatIfI18n.useT();
  const { user, isCurator, canEdit, dbUsers } = useAuth();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const me = user?.role !== "guest" ? user?.traderName ?? "" : "";

  const [init] = useState(() => initialState(me));
  const [period, setPeriod] = useState<PeriodKey>(init.period);
  const [trader, setTrader] = useState<string>(init.trader);
  const [rules, setRules] = useState<Rule[]>(init.rules);

  // Persist the viewer's period/trader; mirror everything into the URL (replaceState: no history spam).
  useEffect(() => {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ period, trader })); } catch { /* storage unavailable */ }
  }, [period, trader]);
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const r = encodeRules(rules);
    if (r) sp.set("r", r); else sp.delete("r");
    if (period !== "all") sp.set("p", period); else sp.delete("p");
    if (isCurator && trader) sp.set("trader", trader); else sp.delete("trader");
    const q = sp.toString();
    const next = `${window.location.pathname}${q ? `?${q}` : ""}${window.location.hash}`;
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) window.history.replaceState(window.history.state, "", next);
  }, [rules, period, trader, isCurator]);

  const today = nyDate();
  // Traders see only themselves (the server enforces it anyway); staff pick a trader or the whole team.
  const scopeTrader = isCurator ? (trader === ALL ? "" : trader) : "";
  const scope = useMemo<Scope>(() => ({ trader: scopeTrader, from: periodFrom(period, today), to: "" }), [scopeTrader, period, today]);
  const scenarioOwner = isCurator ? (trader === ALL ? "" : trader) : me;
  const periodPhrase = t(`period.${period}.phrase`);
  const periodOptions = PERIOD_KEYS.map((value) => ({ value, label: t(`period.${value}.label`) }));
  // Fee table by trader / account / month / setup / horizon (/api/edge/costs) — same trader and period as the page.
  const costFilters = useMemo<AnalyticsFilters>(() => ({ ...DEFAULT_FILTERS, period, trader: scopeTrader }), [period, scopeTrader]);

  const traders = useMemo(
    () => dbUsers.filter((u) => u.active && !u.banned && u.role !== "guest").map((u) => u.name).sort(comparePersonNames),
    [dbUsers],
  );

  const base = useWhatIfBase(scope);
  const hasTrades = (base.data?.trades.length ?? 0) > 0;
  // Older API builds do not list ruleTypes: then only the legacy rules are offered and sent.
  const supported = useMemo(() => new Set<RuleType>(base.data?.ruleTypes ?? LEGACY_RULE_TYPES), [base.data?.ruleTypes]);
  const sendable = useMemo(() => rules.filter((r) => supported.has(r.type)), [rules, supported]);
  const unsupported = useMemo(
    () => rules.filter((r) => !supported.has(r.type)).map((r) => ({ rule: r.type, reason: t("unsupportedRule") })),
    [rules, supported, t],
  );

  const rulesKey = JSON.stringify(sendable);
  const debouncedKey = useDebounced(rulesKey, 250);
  const runRules = useMemo(() => JSON.parse(debouncedKey) as Rule[], [debouncedKey]);
  const hasRules = runRules.length > 0;
  const pendingRecalc = rulesKey !== debouncedKey;

  const run = useWhatIfRun(scope, runRules, hasRules && hasTrades);
  const suggestions = useWhatIfSuggestions(scope, hasTrades);
  const fees = useWhatIfFees(scope, hasTrades);
  const saved = useSavedScenarios(scenarioOwner, canEdit);
  const save = useSaveScenario(scenarioOwner);
  const del = useDeleteScenario();

  const addRule = (r: Rule) => setRules((rs) => mergeRule(rs, r));
  const toggleSuggestion = (s: Suggestion, applied: boolean) => setRules((rs) => (applied ? subtractRule(rs, s.rule) : mergeRule(rs, s.rule)));
  const toggleQuestion = (q: Question, applied: boolean) => { if (q.rule) { const rule = q.rule; setRules((rs) => (applied ? subtractRule(rs, rule) : mergeRule(rs, rule))); } };
  const questions = useMemo(
    () => buildQuestions(base.data?.trades ?? [], base.data?.presets ?? []).map((q) => (q.rule && !supported.has(q.rule.type) ? { ...q, rule: null, disabled: t("unsupportedQuestion") } : q)),
    [base.data?.trades, base.data?.presets, supported, t],
  );
  const dayTrader = isCurator ? (trader === ALL ? "" : trader) : "";
  const openDay = (day: string) => navigate(`/day-report?date=${day}${dayTrader ? `&trader=${encodeURIComponent(dayTrader)}` : ""}`);

  const recalculating = hasRules && (run.isFetching || pendingRecalc);
  // A link with #fees (e.g. from the analytics «Что если» tab) scrolls to the fee block once it is rendered.
  const feesReady = !!base.data && (base.data.trades.length ?? 0) > 0;
  useEffect(() => {
    if (!feesReady || window.location.hash !== "#fees") return;
    const id = window.setTimeout(() => document.getElementById("fees")?.scrollIntoView({ block: "start" }), 50);
    return () => window.clearTimeout(id);
  }, [feesReady]);
  const controls = (
    <>
      <Segmented<PeriodKey> ariaLabel={t("periodAria")} value={period} onChange={setPeriod} options={periodOptions} />
      {isCurator && (
        <PersonSelect
          value={trader || ALL}
          onValueChange={setTrader}
          allValue={ALL}
          allLabel={t("wholeTeam")}
          options={[
            ...(me && traders.includes(me) ? [{ value: me, label: t("myTrades", { name: personName(me) }) }] : []),
            ...traders.filter((t) => t !== me),
            ...(trader && trader !== ALL && !traders.includes(trader) ? [trader] : []),
          ]}
          className="h-10 w-[200px]"
          ariaLabel={t("traderAria")}
        />
      )}
    </>
  );
  const header = (
    <PageHeader
      title={t("title")}
      icon={FlaskConical}
      description={t("description")}
      meta={
        recalculating ? (
          <Pill tone="accent"><Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" /> {t("recalculating")}</Pill>
        ) : base.data ? (
          <span className="tabular-nums">{t("meta", { trades: commonI18n.t("units.trades", { count: base.data.trades.length }), days: t("tradingDays", { count: base.data.baseline.days }), period: periodPhrase })}</span>
        ) : null
      }
      actions={controls}
    />
  );

  if (base.isError) {
    return (
      <Page>
        {header}
        <Panel>
          <EmptyState
            icon={SearchX}
            title={t("loadError")}
            description={(base.error as Error | null)?.message ?? t("loadErrorHint")}
            action={<Button variant="outline" className="rounded-full" onClick={() => void base.refetch()} disabled={base.isFetching}><RefreshCw className="mr-1.5 h-4 w-4" aria-hidden="true" /> {commonI18n.t("actions.retry")}</Button>}
          />
        </Panel>
      </Page>
    );
  }

  if (base.isLoading || !base.data) {
    return (
      <Page>
        {header}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-[var(--grid-gap)]">
          {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[168px] rounded-2xl" />)}
        </div>
        <Skeleton className="h-[560px] rounded-2xl" />
        <span className="sr-only" role="status">{t("loadingTrades")}</span>
      </Page>
    );
  }

  const b = base.data;
  if (b.trades.length === 0) {
    return (
      <Page>
        {header}
        <Panel>
          <EmptyState
            icon={SearchX}
            title={scopeTrader ? t("empty.titleOf", { trader: personName(scopeTrader), period: periodPhrase }) : t("empty.title", { period: periodPhrase })}
            description={period !== "all" ? (isCurator ? t("empty.longerCurator") : t("empty.longer")) : (isCurator ? t("empty.syncCurator") : t("empty.sync"))}
            action={period !== "all" ? <Button className="rounded-full bg-primary-solid" onClick={() => setPeriod("all")}>{t("empty.showAll")}</Button> : undefined}
          />
        </Panel>
      </Page>
    );
  }

  // With rules, the run response is the source of truth (placeholder keeps the previous run while the next computes).
  const r = hasRules ? run.data : undefined;
  const showScenario = hasRules && !!r;
  const baselineM = r?.baseline ?? b.baseline;
  const scenarioM = r?.scenario ?? b.baseline;
  const skipped = [...(r?.skipped ?? []), ...unsupported];

  return (
    <Page>
      {header}

      <QuestionsBar questions={questions} rules={rules} onToggle={toggleQuestion} />


      <Panel title={t("result")} icon={TrendingUp} aria-busy={recalculating || undefined}>
        <div className="flex flex-col gap-4">
          <ScenarioBar
            rules={rules}
            skipped={skipped}
            onRemove={(t) => setRules((rs) => removeRule(rs, t))}
            onClear={() => setRules([])}
            onLoad={(rs, name) => {
              setRules(decodeRules(encodeRules(rs)));
              toast({ title: t("toast.opened"), description: name });
            }}
            saved={saved.data ?? []}
            canSave={canEdit && !!scenarioOwner}
            saving={save.isPending}
            onSave={(name) =>
              save.mutate({ name, rules: sendable }, {
                onSuccess: () => toast({ title: t("toast.saved"), description: name }),
                onError: (e) => toast({ title: t("toast.saveFailed"), description: (e as Error).message, variant: "destructive" }),
              })
            }
            onDelete={(id) => del.mutate(id, {
              onSuccess: () => toast({ title: t("toast.removed") }),
              onError: (e) => toast({ title: t("toast.removeFailed"), description: (e as Error).message, variant: "destructive" }),
            })}
          />
          {run.isError && hasRules && (
            <p className="rounded-xl bg-[hsl(var(--down)/0.1)] px-3 py-2 text-sm text-down">
              {t("runError", { message: (run.error as Error | null)?.message ?? t("serverError") })}
            </p>
          )}
          <div className={cn("flex flex-col gap-4 transition-opacity duration-[var(--dur-2)] motion-reduce:transition-none", recalculating && "opacity-60")}>
            <DeltaHeadline baseline={baselineM} scenario={scenarioM} hasScenario={showScenario} bootstrap={r?.bootstrap ?? null} />
            {hasRules && !r ? (
              <ChartSkeleton />
            ) : (
              <EquityChart base={r?.baselineEquity ?? b.equity} scenario={r?.scenarioEquity ?? []} hasScenario={showScenario} onDay={openDay} />
            )}
            <KeyMetrics baseline={baselineM} scenario={scenarioM} hasScenario={showScenario} />
            {showScenario && <ChangedDays days={changedDays(r!.baselineDaily, r!.scenarioDaily)} trader={dayTrader} />}
          </div>
        </div>
      </Panel>

      <section aria-labelledby="sim-suggestions" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="sim-suggestions" className="flex items-center gap-2 text-sm font-semibold">
            <Lightbulb className="h-4 w-4 text-muted-foreground" aria-hidden="true" /> {t("suggestionsTitle")}
          </h2>
          <p className="text-xs text-muted-foreground">{t("suggestionsHint", { period: periodPhrase })}</p>
        </div>
        <SuggestionCards data={suggestions.data} isLoading={suggestions.isLoading} rules={rules} periodLabel={periodPhrase} onToggle={toggleSuggestion} />
        {suggestions.isError && <p className="text-xs text-down">{t("suggestionsError")}</p>}
      </section>

      <Panel title={t("ownTitle")} icon={SlidersHorizontal} description={t("ownHint")}>
        <RuleBuilder trades={b.trades} supported={supported} rules={rules} presets={b.presets} onAdd={addRule} onApplyPreset={(p) => setRules((rs) => p.rules.filter((x) => supported.has(x.type)).reduce(mergeRule, rs))} />
      </Panel>

      <Panel title={t("feesTitle")} icon={Receipt} id="fees" className="scroll-mt-[calc(var(--sticky-top,0px)+1rem)]">
        <FeesBlock trades={b.trades} data={fees.data} isLoading={fees.isLoading} presets={b.presets} rules={rules} canApplyPlan={supported.has("commissionPlan")} onApplyPlan={addRule} costsByGroup={<CostsByGroup filters={costFilters} isCurator={isCurator} />} />
      </Panel>

      {showScenario && (
        <Fold title={t("removedTitle")} icon={ListX} hint={`${commonI18n.t("units.trades", { count: r!.excluded.length })}${r!.changed.length ? ` · ${t("changedCount", { count: r!.changed.length })}` : ""}`}>
          <ExcludedTable excluded={r!.excluded} changed={r!.changed} />
        </Fold>
      )}
      <Fold title={t("allTitle")} icon={BarChart3} hint={t("allHint")}>
        <div className="flex flex-col gap-5">
          <MetricsTable baseline={baselineM} scenario={scenarioM} hasScenario={showScenario} />
          <div>
            <p className="mb-1 text-sm font-semibold">{t("daysByResult")}</p>
            <DailyHistogram base={r?.baselineDaily ?? b.daily} scenario={r?.scenarioDaily ?? []} hasScenario={showScenario} />
          </div>
          {showScenario && (
            <div>
              <p className="mb-2 text-sm font-semibold">{t("howReliable")}</p>

              <BootstrapDetails b={r!.bootstrap} />
            </div>
          )}
        </div>
      </Fold>
    </Page>
  );
}

/** Collapsed-by-default section in a glass panel. */
function Fold({ title, hint, icon: Icon, children }: { title: string; hint?: string; icon: typeof ListX; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="glass-panel rounded-2xl">
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-2xl p-[var(--panel-p)] text-left hover:bg-[var(--glass-hover-bg)]">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="text-sm font-semibold">{title}</span>
        {hint && <span className="truncate text-xs text-muted-foreground">{hint}</span>}
        <ChevronDown className={cn("ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-[var(--dur-1)] motion-reduce:transition-none", open && "rotate-180")} aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent className="px-[var(--panel-p)] pb-[var(--panel-p)]">{children}</CollapsibleContent>
    </Collapsible>
  );
}
