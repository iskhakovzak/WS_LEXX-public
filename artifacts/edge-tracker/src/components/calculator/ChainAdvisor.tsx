/** Options chain loader (NASDAQ, delayed) + rule-based strategy advisor + AI advisor. */
import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, BarChart3, Calculator, ChevronDown, Layers, Plus, RefreshCw, Search, Send, Shield, Sparkles, Star, Table2, TrendingDown, TrendingUp, Zap,
} from "lucide-react";
import { EmptyState, Panel, Pill, Segmented } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { http } from "@/lib/api/http";
import { STALE } from "@/lib/api/keys";
import { riskMeQuery } from "@/lib/api/queries";
import { fetchErrorMessage, fmtStrike, impliedVolPct, num, toDeskLimits, usePersistedState, type RiskMeRaw } from "./lib";
import { fmtNum, fmtPct, fmtUsd } from "@/lib/format";
import { Hint, MetricTile, NumField } from "./fields";
import {
  buildStrategies, fsFind, type AdvisorGoal, type ChainData, type ChainOption, type Expiration, type IvOutlook, type Strategy,
} from "./strategies";
import type { OpenInBuilderParams, UseInBsParams } from "./OptionsSection";
import { riskPerTradeUsd, useTradingDefaults } from "@/components/settings/trading-defaults";
import { calculatorI18n } from "@/i18n/ns/calculator";

interface AiAnalysisResult {
  strategy: string;
  reasoning: string;
  legs: Array<{ action: "buy" | "sell"; type: "call" | "put"; strike: number; premium: number; contracts: number }>;
  maxRisk: number | null;
  maxProfit: number | null;
  breakevens: number[];
  whyBest: string;
  keyRisk: string;
  altStrategies?: string[];
}

/** Goal codes + icons; labels come from `advisor.goals.<id>` at render. */
const GOALS: { id: AdvisorGoal; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "bullish", icon: TrendingUp },
  { id: "bearish", icon: TrendingDown },
  { id: "hedge_long", icon: Shield },
  { id: "hedge_short", icon: Shield },
  { id: "big_move", icon: Zap },
  { id: "neutral_sell", icon: Star },
];

const IV_OUTLOOKS: IvOutlook[] = ["expand", "neutral", "contract"];

/** Recommendation cards shown before «Ещё N стратегий» (choice overload: the best few first). */
const TOP_STRATEGIES = 3;

type ChainView = "calls" | "puts" | "both";

export default function ChainAdvisor({
  onUseInBs,
  onOpenInBuilder,
  builderLegCount,
  onShowBuilder,
  initialTicker,
}: {
  /** Prefill from /calculator?ticker= (nothing is loaded until the user asks). */
  initialTicker?: string;
  onUseInBs: (p: UseInBsParams) => void;
  onOpenInBuilder: (p: OpenInBuilderParams) => void;
  builderLegCount: number;
  onShowBuilder: () => void;
}) {
  const { t } = calculatorI18n.useT();
  const { toast } = useToast();
  const [ticker, setTicker] = usePersistedState<string>("chain_ticker", "");
  const [showAllStrategies, setShowAllStrategies] = useState(false);
  const prefilled = useRef(false);
  useEffect(() => {
    if (!initialTicker || prefilled.current) return;
    prefilled.current = true;
    setTicker(initialTicker);
  }, [initialTicker, setTicker]);
  const [expirations, setExpirations] = useState<Expiration[]>([]);
  const [selectedExp, setSelectedExp] = usePersistedState<string>("chain_exp", "");
  const [loadedSymbol, setLoadedSymbol] = useState<string>("");
  const [rawChain, setChain] = useState<ChainData | null>(null);
  const chainReq = useRef(0);
  const [spot, setSpotInfo] = useState<{ price: number; changePct: number | null; name: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [chainLoading, setChainLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chainView, setChainView] = usePersistedState<ChainView>("chain_view", "both");
  const [showChainTable, setShowChainTable] = usePersistedState<boolean>("chain_show_table", false);

  const [goal, setGoal] = usePersistedState<AdvisorGoal>("advisor_goal", "bullish");
  const [maxRisk, setMaxRisk] = usePersistedState<string>("advisor_maxrisk", "500");
  // The trader's own 1R (Settings → Торговля) seeds the per-contract cap once, never above the desk's
  // max risk per trade (/risk/me = hard cap). The trader can still type their own number.
  const deskQ = useQuery({ ...riskMeQuery<RiskMeRaw>(), select: toDeskLimits, retry: false, staleTime: STALE.short });
  const tradingDefaults = useTradingDefaults();
  const personalRisk = tradingDefaults.updatedAt ? riskPerTradeUsd(tradingDefaults) : null;
  const deskMaxRisk = deskQ.data?.maxRisk ?? null;
  const deskSeeded = useRef(false);
  useEffect(() => {
    if (deskSeeded.current || deskQ.isLoading) return;
    const seed = personalRisk != null && personalRisk > 0
      ? (deskMaxRisk != null ? Math.min(personalRisk, deskMaxRisk) : personalRisk)
      : deskMaxRisk;
    if (seed == null) return;
    deskSeeded.current = true;
    if (maxRisk === "500") setMaxRisk(String(Math.round(seed)));
  }, [deskQ.isLoading, deskMaxRisk, personalRisk, maxRisk, setMaxRisk]);
  const [ivOutlook, setIvOutlook] = usePersistedState<IvOutlook>("advisor_iv", "neutral");
  const [nContracts, setNContracts] = usePersistedState<string>("advisor_contracts", "1");
  const [rateStr, setRateStr] = usePersistedState<string>("advisor_rate", "4.5");

  const [aiPrompt, setAiPrompt] = usePersistedState<string>("advisor_ai_prompt", "");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState<AiAnalysisResult | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  const loadChain = useCallback(async (sym: string, exp: string) => {
    if (!sym || !exp) return;
    const reqId = ++chainReq.current;
    setChainLoading(true); setError(null);
    try {
      const j = await http
        .get<ChainData>("/api/options/chain", { query: { symbol: sym.toUpperCase(), expiration: exp } })
        .catch((err: unknown) => { throw new Error(fetchErrorMessage(err, calculatorI18n.t("advisor.chainLoadError"))); });
      if (reqId !== chainReq.current) return; // a newer request superseded this one
      if (!(j.spot > 0)) throw new Error(calculatorI18n.t("advisor.noSpot"));
      setChain(j);
      setSpotInfo({ price: j.spot, changePct: j.changePct, name: j.name });
    } catch (e: unknown) {
      if (reqId !== chainReq.current) return;
      setChain(null);
      setError(e instanceof Error && e.message !== "Failed to fetch" ? e.message : calculatorI18n.t("advisor.chainLoadError"));
    } finally {
      if (reqId === chainReq.current) setChainLoading(false);
    }
  }, []);

  const loadExpirations = useCallback(async (rawSym: string, preferredExp?: string) => {
    const sym = rawSym.trim().toUpperCase();
    if (!sym) return;
    chainReq.current++; // invalidate in-flight chain requests for the previous symbol
    setLoading(true); setChainLoading(false); setError(null); setChain(null); setExpirations([]); setLoadedSymbol("");
    try {
      const j = await http
        .get<{ spot: number; changePct: number | null; name: string; expirations: Expiration[] }>("/api/options/chain", { query: { symbol: sym } })
        .catch((err: unknown) => { throw new Error(fetchErrorMessage(err, calculatorI18n.t("advisor.loadError"))); });
      const exps = Array.isArray(j.expirations) ? j.expirations : [];
      setExpirations(exps);
      setSpotInfo({ price: j.spot, changePct: j.changePct, name: j.name });
      if (exps.length === 0) { setError(calculatorI18n.t("advisor.noExpirations")); return; }
      setLoadedSymbol(sym);
      const exp = preferredExp && exps.some((e) => e.label === preferredExp) ? preferredExp : exps[0].label;
      setSelectedExp(exp);
      void loadChain(sym, exp);
    } catch (e: unknown) {
      setError(e instanceof Error && e.message !== "Failed to fetch" ? e.message : calculatorI18n.t("advisor.loadError"));
    } finally { setLoading(false); }
  }, [setSelectedExp, loadChain]);

  // Restore the last ticker/expiration on mount (one request, not on every keystroke).
  useEffect(() => {
    if (ticker.trim()) void loadExpirations(ticker, selectedExp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onSelectExp(v: string) {
    setSelectedExp(v);
    if (loadedSymbol) void loadChain(loadedSymbol, v);
  }

  const riskFree = Number.isFinite(num(rateStr)) ? num(rateStr) : 4.5;
  const contractsN = Math.max(1, Math.floor(num(nContracts) || 1));

  // NASDAQ feed has no IV: derive implied volatility from each contract's mid price.
  const chain = useMemo<ChainData | null>(() => {
    if (!rawChain) return null;
    const T = rawChain.daysToExpiry / 365;
    const r = riskFree / 100;
    const withIv = (opts: ChainOption[], type: "call" | "put") => opts.map((o) => (
      o.iv != null ? o : { ...o, iv: impliedVolPct(o.mid, rawChain.spot, o.strike, T, r, type) }
    ));
    return { ...rawChain, calls: withIv(rawChain.calls, "call"), puts: withIv(rawChain.puts, "put") };
  }, [rawChain, riskFree]);

  const strategies = useMemo(() => {
    if (!chain) return [];
    const mr = num(maxRisk);
    let perContract = mr > 0 ? mr : 500;
    // Desk limit is a hard cap on the whole trade (N contracts).
    if (deskMaxRisk != null) perContract = Math.min(perContract, deskMaxRisk / contractsN);
    return buildStrategies(chain, goal, perContract, ivOutlook, contractsN, riskFree);
  }, [chain, goal, maxRisk, ivOutlook, contractsN, riskFree, deskMaxRisk]);
  const tradeRisk = (num(maxRisk) > 0 ? num(maxRisk) : 500) * contractsN;
  const overDesk = deskMaxRisk != null && tradeRisk > deskMaxRisk + 0.005;
  const maxRiskHint = [
    personalRisk != null ? t("advisor.personalRisk", { amount: fmtUsd(personalRisk, { decimals: 0 }) }) : null,
    deskMaxRisk != null
      ? t(personalRisk != null ? "advisor.deskLimitAfter" : "advisor.deskLimit", { amount: fmtUsd(deskMaxRisk, { decimals: 0 }) })
      : null,
  ].filter(Boolean).join(" · ");

  const atmIv = useMemo(() => {
    if (!chain) return null;
    return fsFind(chain.calls, chain.spot)?.iv ?? fsFind(chain.puts, chain.spot)?.iv ?? null;
  }, [chain]);

  function legIv(type: "call" | "put", strike: number): number | null {
    if (!chain) return null;
    return (type === "call" ? chain.calls : chain.puts).find((o) => o.strike === strike)?.iv ?? null;
  }

  function handleUseBs(s: Strategy) {
    const first = s.legs[0];
    if (!first || !chain) return;
    onUseInBs({
      symbol: chain.symbol, spot: chain.spot, strike: first.strike, side: first.optType, days: chain.daysToExpiry,
      iv: legIv(first.optType, first.strike), premium: first.premium, contracts: contractsN,
    });
  }

  function strategyToBuilder(s: Strategy) {
    if (!chain) return;
    // Covered call / protective put / collar assume 100 shares held per contract.
    const withStock = ["covered_call", "protective_put", "collar"].includes(s.id);
    onOpenInBuilder({
      symbol: chain.symbol, spot: chain.spot, days: chain.daysToExpiry, iv: atmIv,
      legs: [
        ...(withStock ? [{ side: "buy" as const, kind: "stock" as const, strike: chain.spot, premium: 0, qty: 100 * contractsN }] : []),
        ...s.legs.map((l) => ({ side: l.action, kind: l.optType, strike: l.strike, premium: l.premium, qty: contractsN })),
      ],
    });
  }

  function addContractToBuilder(o: ChainOption, type: "call" | "put") {
    if (!chain) return;
    onOpenInBuilder({
      symbol: chain.symbol, spot: chain.spot, days: chain.daysToExpiry, iv: atmIv, append: true,
      legs: [{ side: "buy", kind: type, strike: o.strike, premium: o.mid, qty: 1 }],
    });
    const contract = `Buy ${type === "call" ? "Call" : "Put"} ${fmtStrike(o.strike)}`;
    toast({ title: calculatorI18n.t("advisor.addedToBuilder", { contract }), description: calculatorI18n.t("advisor.builderLegs", { count: builderLegCount + 1 }) });
  }

  const analyzeWithAI = useCallback(async () => {
    if (!chain || !aiPrompt.trim()) return;
    setAiLoading(true); setAiError(null); setAiResult(null);
    try {
      setAiResult(await http.post<AiAnalysisResult>("/api/options/ai-analyze", {
        symbol: chain.symbol, spot: chain.spot, daysToExpiry: chain.daysToExpiry,
        calls: chain.calls, puts: chain.puts, strikes: chain.strikes, userPrompt: aiPrompt,
      }));
    } catch (e: unknown) {
      setAiError(e instanceof Error ? e.message : calculatorI18n.t("advisor.aiError"));
    } finally {
      setAiLoading(false);
    }
  }, [chain, aiPrompt]);

  const expInfo = expirations.find((e) => e.label === selectedExp);
  const visibleStrikes = chain ? chain.strikes.filter((k) => k >= chain.spot * 0.75 && k <= chain.spot * 1.25) : [];

  return (
    <div className="flex flex-col gap-4">
      <Panel title={t("advisor.chainTitle")} icon={Search} description={t("advisor.chainSource")}>
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:grid-cols-[minmax(0,20rem)_minmax(0,16rem)_1fr] lg:items-end">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="chain-ticker" className="text-xs font-normal text-muted-foreground">{t("shared.ticker")}</Label>
              <div className="flex gap-2">
                <Input id="chain-ticker" autoComplete="off" value={ticker} placeholder="AAPL, SPY, QQQ…" className="h-9 uppercase"
                  onChange={(e) => setTicker(e.target.value.toUpperCase())}
                  onKeyDown={(e) => { if (e.key === "Enter") void loadExpirations(ticker, selectedExp); }} />
                <Button type="button" className="shrink-0" onClick={() => void loadExpirations(ticker, selectedExp)} disabled={loading || !ticker.trim()}>
                  {loading ? <RefreshCw className="animate-spin" aria-hidden="true" /> : <Search aria-hidden="true" />} {t("advisor.load")}
                </Button>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="chain-exp" className="text-xs font-normal text-muted-foreground">{t("advisor.expiration")}</Label>
              <Select value={selectedExp} onValueChange={onSelectExp} disabled={expirations.length === 0}>
                <SelectTrigger id="chain-exp" className="h-9"><SelectValue placeholder={expirations.length ? t("advisor.pickDate") : t("advisor.loadTickerFirst")} /></SelectTrigger>
                <SelectContent>
                  {expirations.map((e) => (
                    <SelectItem key={e.label} value={e.label}>
                      <span className="tabular-nums">{e.label}</span> <span className="text-muted-foreground">· {t("shared.days", { count: e.dte })}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex min-h-9 flex-wrap items-center gap-2 text-sm" aria-live="polite">
              {spot && (
                <>
                  <span className="font-semibold tabular-nums">{fmtUsd(spot.price)}</span>
                  {spot.changePct != null && <Pill tone={spot.changePct >= 0 ? "up" : "down"}>{fmtPct(spot.changePct, 2)}</Pill>}
                </>
              )}
              {chainLoading && <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />{t("advisor.loadingChain")}</span>}
              {chain && !chainLoading && (
                <>
                  <Pill tone="neutral">{t("advisor.contracts", { count: chain.calls.length + chain.puts.length })}</Pill>
                  {expInfo && <Pill tone="neutral">{t("shared.days", { count: chain.daysToExpiry })}</Pill>}
                  {atmIv != null && <Pill tone="purple">ATM IV {fmtNum(atmIv, 0)}%</Pill>}
                </>
              )}
            </div>
          </div>
          {error && <p role="alert" className="flex items-center gap-1.5 text-sm text-down"><AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />{error}</p>}
        </div>
      </Panel>

      {!chain && !loading && !chainLoading && !error && expirations.length === 0 && (
        <Panel>
          <EmptyState icon={BarChart3} title={t("advisor.emptyTitle")}
            description={t("advisor.emptyDescription")} />
        </Panel>
      )}

      {chain && (
        <>
          <Panel title={t("advisor.title")} icon={Zap} description={t("advisor.description")}>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <span className="text-xs text-muted-foreground">{t("advisor.view")}</span>
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-6" role="group" aria-label={t("advisor.view")}>
                  {GOALS.map((g) => (
                    <button key={g.id} type="button" aria-pressed={goal === g.id} onClick={() => setGoal(g.id)}
                      className="chip inline-flex min-h-9 items-center justify-center gap-1.5 px-3 py-1 text-center text-sm font-medium leading-tight">
                      <g.icon className="h-4 w-4 shrink-0" aria-hidden="true" />{t(`advisor.goals.${g.id}`)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-[auto_repeat(3,minmax(0,10rem))] md:items-end">
                <div className="col-span-2 flex flex-col gap-1.5 md:col-span-1">
                  <span className="flex min-h-5 items-center gap-1 text-xs text-muted-foreground">
                    {t("advisor.ivAhead")}
                    <Hint text={t("advisor.ivHint")} />
                  </span>
                  <Segmented<IvOutlook> ariaLabel={t("advisor.ivAria")} value={ivOutlook} onChange={setIvOutlook}
                    options={IV_OUTLOOKS.map((v) => ({ value: v, label: t(`advisor.ivOutlook.${v}`) }))} />
                </div>
                <NumField label={t("advisor.maxRiskPerContract")} prefix="$" value={maxRisk} onChange={setMaxRisk} placeholder="500"
                  error={overDesk ? t("advisor.overDesk", { risk: fmtUsd(tradeRisk, { decimals: 0 }), limit: fmtUsd(deskMaxRisk ?? 0, { decimals: 0 }) }) : undefined}
                  hint={maxRiskHint || undefined} />
                <NumField label={t("shared.contracts")} value={nContracts} onChange={setNContracts} integer placeholder="1" />
                <NumField label={t("shared.rate")} suffix="%" value={rateStr} onChange={setRateStr} placeholder="4.5" />
              </div>
            </div>
          </Panel>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Star className="h-4 w-4 text-primary" aria-hidden="true" />
              {t("advisor.recommendations")}
              <span className="font-normal text-muted-foreground">· {chain.symbol} {fmtUsd(chain.spot)} · {t("shared.days", { count: chain.daysToExpiry })}</span>
            </h2>
            {builderLegCount > 0 && (
              <Button type="button" variant="ghost" size="sm" onClick={onShowBuilder}><Layers aria-hidden="true" /> {t("modes.builderCount", { count: builderLegCount })}</Button>
            )}
          </div>
          {strategies.length === 0 ? (
            <Panel><EmptyState icon={Star} title={t("advisor.noStrategiesTitle")} description={t("advisor.noStrategiesDescription")} /></Panel>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {(showAllStrategies ? strategies : strategies.slice(0, TOP_STRATEGIES)).map((s, i) => (
                  <StrategyCard key={s.id} s={s} spot={chain.spot} top={i === 0} onUseInBs={handleUseBs} onToBuilder={strategyToBuilder} />
                ))}
              </div>
              {strategies.length > TOP_STRATEGIES && (
                <Button type="button" variant="ghost" size="sm" className="self-start" aria-expanded={showAllStrategies}
                  onClick={() => setShowAllStrategies((v) => !v)}>
                  <ChevronDown className={cn("transition-transform", showAllStrategies && "rotate-180")} aria-hidden="true" />
                  {showAllStrategies ? t("advisor.fewerStrategies") : t("advisor.moreStrategies", { count: strategies.length - TOP_STRATEGIES })}
                </Button>
              )}
            </div>
          )}

          <Panel
            title={t("advisor.chain")}
            icon={Table2}
            description={expInfo ? t("advisor.chainDescription", { expiration: expInfo.label, days: t("shared.days", { count: expInfo.dte }) }) : undefined}
            actions={
              <>
                {showChainTable && (
                  <Segmented<ChainView> ariaLabel={t("advisor.chainViewAria")} size="sm" value={chainView} onChange={setChainView}
                    options={[{ value: "calls", label: "Calls" }, { value: "puts", label: "Puts" }, { value: "both", label: t("advisor.both") }]} />
                )}
                <Button type="button" variant="ghost" size="sm" aria-expanded={showChainTable} onClick={() => setShowChainTable(!showChainTable)}>
                  <ChevronDown className={cn("transition-transform", showChainTable && "rotate-180")} aria-hidden="true" />
                  {showChainTable ? t("advisor.hide") : t("advisor.show")}
                </Button>
              </>
            }
          >
            {showChainTable && (
              <div className="-mx-1 max-h-[70dvh] overflow-auto px-1">
                <table className="w-full text-xs tabular-nums">
                  <caption className="sr-only">{t("advisor.chainCaption", { symbol: chain.symbol })}</caption>
                  <thead className="sticky top-0 z-sticky bg-[hsl(var(--popover))] text-muted-foreground">
                    <tr className="border-b border-border/60">
                      {chainView !== "puts" && <>
                        <th scope="col" className="px-2 py-2 text-right font-normal">Call bid</th>
                        <th scope="col" className="px-2 py-2 text-right font-normal">Mid</th>
                        <th scope="col" className="px-2 py-2 text-right font-normal">IV</th>
                        <th scope="col" className="px-2 py-2 text-right font-normal">OI</th>
                      </>}
                      <th scope="col" className="px-2 py-2 text-center font-medium text-foreground">{t("shared.strike")}</th>
                      {chainView !== "calls" && <>
                        <th scope="col" className="px-2 py-2 text-left font-normal">Put bid</th>
                        <th scope="col" className="px-2 py-2 text-left font-normal">Mid</th>
                        <th scope="col" className="px-2 py-2 text-left font-normal">IV</th>
                        <th scope="col" className="px-2 py-2 text-left font-normal">OI</th>
                      </>}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleStrikes.map((strike) => {
                      const c = chain.calls.find((o) => o.strike === strike);
                      const p = chain.puts.find((o) => o.strike === strike);
                      const isAtm = Math.abs(strike - chain.spot) / chain.spot < 0.02;
                      const oi = (n: number) => (n > 999 ? `${fmtNum(n / 1000, 0)}k` : String(n));
                      return (
                        <tr key={strike} className={cn("border-b border-border/30", isAtm && "bg-primary/10")}>
                          {chainView !== "puts" && <>
                            <td className={cn("px-2 py-1 text-right", c?.inTheMoney ? "text-up" : "text-muted-foreground")}>{c ? fmtNum(c.bid, 2) : "—"}</td>
                            <td className="px-1 py-0.5 text-right">
                              {c && c.mid > 0 ? (
                                <button type="button" onClick={() => addContractToBuilder(c, "call")} aria-label={t("advisor.addToBuilderAria", { contract: `Buy Call ${fmtStrike(strike)}` })}
                                  className="inline-flex min-h-6 items-center gap-0.5 rounded-full px-1.5 hover:bg-primary/15 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                                  {fmtNum(c.mid, 2)}<Plus className="h-3 w-3 opacity-60" aria-hidden="true" />
                                </button>
                              ) : "—"}
                            </td>
                            <td className="px-2 py-1 text-right text-[hsl(var(--chart-5))]">{c?.iv != null ? fmtNum(c.iv, 0) : "—"}</td>
                            <td className="px-2 py-1 text-right text-muted-foreground">{c ? oi(c.openInterest) : "—"}</td>
                          </>}
                          <td className={cn("px-2 py-1 text-center font-semibold", isAtm ? "text-primary" : "text-foreground")}>{fmtStrike(strike)}</td>
                          {chainView !== "calls" && <>
                            <td className={cn("px-2 py-1 text-left", p?.inTheMoney ? "text-down" : "text-muted-foreground")}>{p ? fmtNum(p.bid, 2) : "—"}</td>
                            <td className="px-1 py-0.5 text-left">
                              {p && p.mid > 0 ? (
                                <button type="button" onClick={() => addContractToBuilder(p, "put")} aria-label={t("advisor.addToBuilderAria", { contract: `Buy Put ${fmtStrike(strike)}` })}
                                  className="inline-flex min-h-6 items-center gap-0.5 rounded-full px-1.5 hover:bg-primary/15 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                                  {fmtNum(p.mid, 2)}<Plus className="h-3 w-3 opacity-60" aria-hidden="true" />
                                </button>
                              ) : "—"}
                            </td>
                            <td className="px-2 py-1 text-left text-[hsl(var(--chart-5))]">{p?.iv != null ? fmtNum(p.iv, 0) : "—"}</td>
                            <td className="px-2 py-1 text-left text-muted-foreground">{p ? oi(p.openInterest) : "—"}</td>
                          </>}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel title={t("advisor.atmTitle")} description={t("advisor.atmDescription")}>
            <ScenarioTable chain={chain} goal={goal} />
          </Panel>
        </>
      )}

      <Panel title={t("advisor.aiTitle")} icon={Sparkles} description={chain
        ? t("advisor.aiDescription", { symbol: chain.symbol, price: fmtUsd(chain.spot), days: t("shared.days", { count: chain.daysToExpiry }) })
        : t("advisor.aiDescriptionEmpty")}>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ai-prompt" className="text-xs font-normal text-muted-foreground">{t("advisor.aiLabel")}</Label>
            <Textarea
              id="ai-prompt"
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void analyzeWithAI(); }}
              placeholder={t("advisor.aiPlaceholder")}
              disabled={!chain || aiLoading}
              rows={3}
              className="resize-none rounded-2xl"
            />
          </div>
          <Button type="button" variant="outline" className="self-end" onClick={() => void analyzeWithAI()} disabled={!chain || !aiPrompt.trim() || aiLoading}>
            {aiLoading ? <RefreshCw className="animate-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
            {aiLoading ? t("advisor.aiThinking") : t("advisor.aiAsk")}
          </Button>

          {aiError && (
            <p role="alert" className="flex items-start gap-2 rounded-xl bg-down/15 px-3 py-2 text-sm text-down">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{aiError}
            </p>
          )}

          {aiResult && (
            <div className="flex flex-col gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-base font-semibold text-primary">
                  <Sparkles className="h-4 w-4" aria-hidden="true" />{aiResult.strategy}
                </span>
                {chain && aiResult.legs.length > 0 && (
                  <Button type="button" variant="outline" size="sm" onClick={() => onOpenInBuilder({
                    symbol: chain.symbol, spot: chain.spot, days: chain.daysToExpiry, iv: atmIv,
                    legs: aiResult.legs.map((l) => ({ side: l.action, kind: l.type, strike: l.strike, premium: l.premium, qty: Math.max(1, l.contracts || 1) })),
                  })}>
                    <Layers aria-hidden="true" /> {t("shared.toBuilder")}
                  </Button>
                )}
              </div>
              {aiResult.legs.length > 0 && (
                <ul className="flex flex-col gap-1">
                  {aiResult.legs.map((leg, i) => (
                    <li key={i} className="flex items-center gap-2 text-sm tabular-nums">
                      <Pill tone={leg.action === "buy" ? "up" : "down"}>{leg.action === "buy" ? "Buy" : "Sell"}</Pill>
                      <Pill tone={leg.type === "call" ? "accent" : "warn"}>{leg.type === "call" ? "Call" : "Put"}</Pill>
                      <span className="font-medium">{fmtUsd(leg.strike)}</span>
                      <span className="text-muted-foreground">×{leg.contracts}</span>
                      <span className="ml-auto text-xs text-muted-foreground">~{t("shared.perShareSuffix", { price: fmtUsd(leg.premium) })}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <MetricTile label={t("shared.maxRisk")} value={aiResult.maxRisk != null ? fmtUsd(aiResult.maxRisk, { decimals: 0 }) : t("advisor.notLimited")} tone="text-down" />
                <MetricTile label={t("shared.maxProfit")} value={aiResult.maxProfit != null ? fmtUsd(aiResult.maxProfit, { decimals: 0 }) : t("shared.unlimited")} tone="text-up" />
                <MetricTile label={t("shared.breakeven")} value={aiResult.breakevens.length ? aiResult.breakevens.map((b) => fmtUsd(b)).join(" / ") : "—"} />
              </div>
              <p className="border-l-2 border-primary/40 pl-3 text-sm text-muted-foreground">{aiResult.reasoning}</p>
              <p className="text-sm"><span className="text-muted-foreground">{t("advisor.why")} </span>{aiResult.whyBest}</p>
              <p className="flex items-start gap-2 text-sm text-[hsl(var(--chart-3))]">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{aiResult.keyRisk}
              </p>
              {aiResult.altStrategies && aiResult.altStrategies.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">{t("advisor.alternatives")}</span>
                  {aiResult.altStrategies.map((alt, i) => <Pill key={i} tone="neutral">{alt}</Pill>)}
                </div>
              )}
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}

function StrategyCard({ s, spot, top, onUseInBs, onToBuilder }: {
  s: Strategy; spot: number; top: boolean; onUseInBs: (s: Strategy) => void; onToBuilder: (s: Strategy) => void;
}) {
  const { t, tryT } = calculatorI18n.useT();
  const [open, setOpen] = useState(top);
  const isDebit = s.netDebit >= 0;
  const scoreTone = s.score >= 70 ? "up" : s.score >= 45 ? "warn" : "neutral";
  const detailsId = `strat-${s.id}`;
  return (
    <article className={cn("glass-panel flex flex-col rounded-2xl", top && "ring-1 ring-primary/60")}>
      <button type="button" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(!open)}
        className="flex flex-col gap-3 rounded-2xl p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">{s.name}</span>
              {top && <Pill tone="accent">{t("advisor.best")}</Pill>}
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <Pill tone={isDebit ? "neutral" : "up"}>{isDebit ? t("advisor.debitPerContract", { amount: fmtUsd(s.netDebit * 100, { decimals: 0 }) }) : t("advisor.creditPerContract", { amount: fmtUsd(Math.abs(s.netDebit) * 100, { decimals: 0 }) })}</Pill>
              <Pill tone={s.ivSensitivity === "positive" ? "purple" : s.ivSensitivity === "negative" ? "warn" : "neutral"}>
                Vega {s.ivSensitivity === "positive" ? "+" : s.ivSensitivity === "negative" ? "−" : "≈0"}
              </Pill>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Pill tone={scoreTone}><span className="sr-only">{t("advisor.score")} </span>{s.score}</Pill>
            <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden="true" />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div><div className="text-2xs text-muted-foreground">{t("shared.maxProfit")}</div><div className="text-sm font-semibold tabular-nums text-up">{s.maxProfit === null ? "∞" : fmtUsd(s.maxProfit, { decimals: 0 })}</div></div>
          <div><div className="text-2xs text-muted-foreground">{t("shared.maxLoss")}</div><div className="text-sm font-semibold tabular-nums text-down">{s.maxLoss === null ? "∞" : fmtUsd(-s.maxLoss, { signed: true, decimals: 0 })}</div></div>
          <div><div className="text-2xs text-muted-foreground">{t("advisor.probProfitShort")}</div><div className="text-sm font-semibold tabular-nums text-primary">{s.probProfit !== null ? `${fmtNum(s.probProfit, 0)}%` : "—"}</div></div>
        </div>
      </button>
      {open && (
        <div id={detailsId} className="flex flex-col gap-3 border-t border-border/60 px-4 pb-4 pt-3">
          <ul className="flex flex-col gap-1">
            {s.legs.map((l, i) => (
              <li key={i} className="flex items-center gap-2 text-sm tabular-nums">
                <Pill tone={l.action === "buy" ? "up" : "down"}>{l.action === "buy" ? "Buy" : "Sell"}</Pill>
                <span className={l.optType === "call" ? "text-up" : "text-down"}>{l.optType === "call" ? "Call" : "Put"}</span>
                <span className="font-semibold">{fmtStrike(l.strike)}</span>
                <span className="ml-auto text-xs text-muted-foreground">{t("shared.perShareSuffix", { price: fmtUsd(l.premium) })}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
            <span className="text-xs text-muted-foreground">{t("advisor.breakevensLabel", { count: s.breakevens.length })}</span>
            {s.breakevens.map((be, i) => (
              <span key={i} className="tabular-nums">
                <span className="font-medium text-primary">{fmtUsd(be)}</span>
                <span className="text-xs text-muted-foreground"> ({fmtPct(((be - spot) / spot) * 100, 1)})</span>
              </span>
            ))}
            {s.riskReward !== null && <span className="ml-auto text-xs text-muted-foreground">R:R <span className="font-medium text-foreground">{fmtNum(s.riskReward, 2)}</span></span>}
          </div>
          <p className="rounded-xl bg-[var(--glass-bg)] px-3 py-2 text-sm text-muted-foreground">{tryT(`strategies.${s.id}.summary`, s.summaryParams)}</p>
          <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">{t("advisor.bestWhen")} </span>{t(`strategies.${s.id}.bestWhen`)}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => onToBuilder(s)}><Layers aria-hidden="true" /> {t("shared.toBuilder")}</Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => onUseInBs(s)}><Calculator aria-hidden="true" /> {t("advisor.firstLegToBs")}</Button>
          </div>
        </div>
      )}
    </article>
  );
}

function ScenarioTable({ chain, goal }: { chain: ChainData; goal: AdvisorGoal }) {
  const { t } = calculatorI18n.useT();
  const steps = [-20, -10, -5, 0, 5, 10, 20];
  const atmC = fsFind(chain.calls, chain.spot);
  const atmP = fsFind(chain.puts, chain.spot);
  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <table className="w-full text-sm tabular-nums">
        <caption className="sr-only">{t("advisor.atmCaption")}</caption>
        <thead>
          <tr className="border-b border-border/60 text-xs text-muted-foreground">
            <th scope="col" className="py-2 pr-2 text-left font-normal">{t("shared.move")}</th>
            <th scope="col" className="px-2 py-2 text-right font-normal">{t("shared.price")}</th>
            <th scope="col" className="px-2 py-2 text-right font-normal">Call {atmC ? fmtStrike(atmC.strike) : ""}</th>
            <th scope="col" className="py-2 pl-2 text-right font-normal">Put {atmP ? fmtStrike(atmP.strike) : ""}</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((pct) => {
            const x = chain.spot * (1 + pct / 100);
            const callPnl = atmC ? (Math.max(0, x - atmC.strike) - atmC.mid) * 100 : 0;
            const putPnl = atmP ? (Math.max(0, atmP.strike - x) - atmP.mid) * 100 : 0;
            const highlight = (goal === "bullish" && pct > 0) || (goal === "bearish" && pct < 0) || (goal === "big_move" && Math.abs(pct) >= 10);
            return (
              <tr key={pct} className={cn("border-b border-border/40 last:border-0", highlight && "bg-primary/5")}>
                <td className={cn("py-1.5 pr-2", pct > 0 ? "text-up" : pct < 0 ? "text-down" : "text-muted-foreground")}>{fmtPct(pct, 0)}</td>
                <td className="px-2 py-1.5 text-right">{fmtUsd(x)}</td>
                <td className={cn("px-2 py-1.5 text-right font-medium", callPnl >= 0 ? "text-up" : "text-down")}>{fmtUsd(callPnl, { signed: true, decimals: 0 })}</td>
                <td className={cn("py-1.5 pl-2 text-right font-medium", putPnl >= 0 ? "text-up" : "text-down")}>{fmtUsd(putPnl, { signed: true, decimals: 0 })}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
