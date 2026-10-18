/** Single-option Black-Scholes calculator: price, greeks, payoff (expiry + today), scenarios. */
import { useCallback, useMemo, useState } from "react";
import { ArrowDownRight, ArrowUpRight, HelpCircle, Info, Layers, RefreshCw, RotateCcw, Search, X } from "lucide-react";
import { Panel, Pill, Segmented, StatCard } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  analyzePayoff, blackScholes, fetchQuote, normCdf, num, pnlAtExpiry, pnlNow, type Leg,
} from "./lib";
import { fmtNum, fmtPct, fmtUsd } from "@/lib/format";
import { MetricTile, NumField, PresetChips, rich } from "./fields";
import { PayoffChart } from "./PayoffChart";
import type { OpenInBuilderParams } from "./OptionsSection";
import { OptTerm } from "./glossary";
import { calculatorI18n } from "@/i18n/ns/calculator";

type Setter = (v: string) => void;
export type BsInputs = {
  ticker: string; setTicker: Setter;
  spot: string; setSpot: Setter;
  strike: string; setStrike: Setter;
  days: string; setDays: Setter;
  iv: string; setIv: Setter;
  rate: string; setRate: Setter;
  contracts: string; setContracts: Setter;
  premium: string; setPremium: Setter;
  side: "call" | "put"; setSide: (v: "call" | "put") => void;
  action: "buy" | "sell"; setAction: (v: "buy" | "sell") => void;
  showHelp: boolean; setShowHelp: (v: boolean) => void;
};

const SCENARIO_STEPS = [-30, -20, -10, -5, 0, 5, 10, 20, 30];

export default function BlackScholesView({ s, onOpenInBuilder }: { s: BsInputs; onOpenInBuilder: (p: OpenInBuilderParams) => void }) {
  const { t } = calculatorI18n.useT();
  const [tickerLoading, setTickerLoading] = useState(false);
  const [tickerInfo, setTickerInfo] = useState<{ ok: boolean; text: string } | null>(null);

  const loadTicker = useCallback(async () => {
    const sym = s.ticker.trim().toUpperCase();
    if (!sym) return;
    setTickerLoading(true);
    setTickerInfo(null);
    try {
      const q = await fetchQuote(sym);
      if (q) {
        s.setSpot(q.price.toFixed(2));
        s.setStrike(q.price.toFixed(0));
        setTickerInfo({ ok: true, text: calculatorI18n.t("bs.tickerFilled", { symbol: sym, price: fmtUsd(q.price) }) });
      } else {
        setTickerInfo({ ok: false, text: calculatorI18n.t("shared.tickerNotFound") });
      }
    } catch {
      setTickerInfo({ ok: false, text: calculatorI18n.t("shared.priceLoadFailed") });
    } finally {
      setTickerLoading(false);
    }
  }, [s]);

  const errors = useMemo(() => {
    const e: Partial<Record<"spot" | "strike" | "days" | "iv" | "rate" | "contracts" | "premium", string>> = {};
    const S = num(s.spot), K = num(s.strike), D = num(s.days), V = num(s.iv), R = num(s.rate), C = num(s.contracts), P = num(s.premium);
    if (!(S > 0)) e.spot = t("bs.validation.spot");
    if (!(K > 0)) e.strike = t("bs.validation.strike");
    if (s.days.trim() === "" || Number.isNaN(D)) e.days = t("bs.validation.daysRequired");
    else if (D < 0) e.days = t("bs.validation.daysNegative");
    if (!(V > 0)) e.iv = t("bs.validation.ivPositive");
    else if (V > 500) e.iv = t("bs.validation.ivTooHigh");
    if (s.rate.trim() !== "" && Number.isNaN(R)) e.rate = t("bs.validation.badNumber");
    if (s.contracts.trim() !== "" && !(C >= 1)) e.contracts = t("bs.validation.minOne");
    if (s.premium.trim() !== "" && !(P > 0)) e.premium = t("bs.validation.premiumPositive");
    return e;
  }, [s.spot, s.strike, s.days, s.iv, s.rate, s.contracts, s.premium, t]);

  const r = useMemo(() => {
    const S = num(s.spot) || 0;
    const K = num(s.strike) || 0;
    const days = Math.max(0, num(s.days) || 0);
    const T = days / 365;
    const ivPct = Math.max(0, num(s.iv) || 0);
    const sigma = ivPct / 100;
    const ratePct = num(s.rate) || 0;
    const rr = ratePct / 100;
    const N = Math.max(1, Math.floor(num(s.contracts) || 1));
    const isCall = s.side === "call";
    const sell = s.action === "sell";
    const call = blackScholes(S, K, T, rr, sigma, "call");
    const put = blackScholes(S, K, T, rr, sigma, "put");
    const bs = isCall ? call : put;
    const userPrem = num(s.premium);
    const useUser = userPrem > 0;
    const optPrice = useUser ? userPrem : bs.price;
    const intrinsic = isCall ? Math.max(0, S - K) : Math.max(0, K - S);
    const timeValue = Math.max(0, optPrice - intrinsic);
    const breakeven = isCall ? K + optPrice : K - optPrice;
    const validBs = S > 0 && K > 0 && T > 0 && sigma > 0;
    const probItm = validBs ? (isCall ? normCdf(bs.d2) : normCdf(-bs.d2)) : null;
    const moneyness = K > 0 ? ((S - K) / K) * 100 * (isCall ? 1 : -1) : 0;
    const status = moneyness > 0.5 ? "ITM" : moneyness < -0.5 ? "OTM" : "ATM";
    const legs: Leg[] = S > 0 && K > 0 ? [{ id: "bs", kind: s.side, side: s.action, strike: K, premium: optPrice, qty: N }] : [];
    const summary = analyzePayoff(legs, S, T, rr, sigma);
    const sign = sell ? -1 : 1;
    const scenarios = SCENARIO_STEPS.map((pct) => {
      const x = S * (1 + pct / 100);
      return { pct, x, exp: pnlAtExpiry(legs, x), half: pnlNow(legs, x, T / 2, rr, sigma) };
    });
    return {
      S, K, days, T, ivPct, sigma, ratePct, rr, N, isCall, sell, sign, call, put, bs, useUser, optPrice, intrinsic, timeValue, breakeven,
      probItm, moneyness, status, legs, summary, scenarios, cost: optPrice * N * 100, validBs,
    };
  }, [s.spot, s.strike, s.days, s.iv, s.rate, s.contracts, s.premium, s.side, s.action]);

  function resetInputs() {
    s.setSpot("100"); s.setStrike("100"); s.setDays("30"); s.setIv("30"); s.setRate("4.5");
    s.setContracts("1"); s.setPremium(""); s.setSide("call"); s.setAction("buy");
    setTickerInfo(null);
  }

  function applyStrikeOffset(pct: number) {
    const S = num(s.spot);
    if (S > 0) s.setStrike((S * (1 + pct / 100)).toFixed(2));
  }

  const posName = `${r.sell ? "Short" : "Long"} ${r.isCall ? "Call" : "Put"}`;
  const probProfit = r.summary.probProfit;

  return (
    <div className="flex flex-col gap-4">
      {s.showHelp && (
        <div className="glass-panel flex gap-3 rounded-2xl p-4 text-sm">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <div className="flex min-w-0 flex-1 flex-col gap-1 text-muted-foreground">
            <p>{rich(t("bs.help.callPut", { call: "{call}", put: "{put}" }), {
              call: <span className="font-medium text-up">Call</span>,
              put: <span className="font-medium text-down">Put</span>,
            })}</p>
            <p>{t("bs.help.basics")}</p>
          </div>
          <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => s.setShowHelp(false)} aria-label={t("bs.help.hide")}>
            <X aria-hidden="true" />
          </Button>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] xl:items-start">
        <Panel
          title={t("bs.params")}
          actions={
            <>
              <Button type="button" variant="ghost" size="sm" onClick={resetInputs} title={t("shared.resetTitle")}>
                <RotateCcw aria-hidden="true" /> {t("shared.reset")}
              </Button>
              {!s.showHelp && (
                <Button type="button" variant="ghost" size="sm" onClick={() => s.setShowHelp(true)}>
                  <HelpCircle aria-hidden="true" /> {t("bs.help.show")}
                </Button>
              )}
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="bs-ticker" className="text-xs font-normal text-muted-foreground">{t("bs.tickerLabel")}</Label>
              <div className="flex gap-2">
                <Input id="bs-ticker" autoComplete="off" value={s.ticker} placeholder="AAPL"
                  onChange={(e) => s.setTicker(e.target.value.toUpperCase())}
                  onKeyDown={(e) => { if (e.key === "Enter") void loadTicker(); }}
                  className="h-9 uppercase" />
                <Button type="button" variant="outline" className="shrink-0" onClick={() => void loadTicker()} disabled={tickerLoading || !s.ticker.trim()}>
                  {tickerLoading ? <RefreshCw className="animate-spin" aria-hidden="true" /> : <Search aria-hidden="true" />} {t("bs.priceButton")}
                </Button>
              </div>
              {tickerInfo && <p role="status" className={cn("text-xs", tickerInfo.ok ? "text-up" : "text-down")}>{tickerInfo.text}</p>}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Segmented<"call" | "put">
                ariaLabel={t("bs.optionTypeAria")}
                value={s.side}
                onChange={s.setSide}
                options={[
                  { value: "call", label: <><ArrowUpRight className="h-4 w-4" aria-hidden="true" />Call</> },
                  { value: "put", label: <><ArrowDownRight className="h-4 w-4" aria-hidden="true" />Put</> },
                ]}
              />
              <Segmented<"buy" | "sell">
                ariaLabel={t("bs.actionAria")}
                value={s.action}
                onChange={s.setAction}
                options={[{ value: "buy", label: t("bs.buy") }, { value: "sell", label: t("bs.sell") }]}
              />
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <NumField label={t("shared.spot")} term="spot" prefix="$" value={s.spot} onChange={s.setSpot} placeholder="100" error={errors.spot} />
              <NumField label={t("shared.strike")} term="strike" prefix="$" value={s.strike} onChange={s.setStrike} placeholder="100" error={errors.strike} />
              <NumField label={t("bs.daysToExp")} term="dte" value={s.days} onChange={s.setDays} integer placeholder="30" error={errors.days} />
              <NumField label={t("bs.ivAnnual")} term="iv" suffix="%" value={s.iv} onChange={s.setIv} placeholder="30" error={errors.iv} />
              <NumField label={t("shared.rate")} term="rate" suffix="%" value={s.rate} onChange={s.setRate} placeholder="4.5" error={errors.rate} />
              <NumField label={t("shared.contracts")} term="contract" value={s.contracts} onChange={s.setContracts} integer placeholder="1" error={errors.contracts} />
            </div>

            <div className="flex flex-col gap-2">
              <PresetChips label={t("bs.termPresets")} items={[7, 14, 30, 45, 60, 90, 180]} isActive={(d) => num(s.days) === d} onPick={(d) => s.setDays(String(d))} format={(d) => t("shared.dayChip", { count: d })} />
              <PresetChips label={t("bs.strikePresets")} items={[-10, -5, 0, 5, 10]} onPick={applyStrikeOffset} format={(p) => fmtPct(p, 0)} />
            </div>

            <div className="grid grid-cols-1 gap-3 border-t border-border/60 pt-4 sm:grid-cols-2">
              <NumField label={t("bs.ownPremium")} prefix="$" value={s.premium} onChange={s.setPremium}
                placeholder={fmtNum(r.bs.price, 3)} error={errors.premium}
                hint={t("bs.ownPremiumHint")} />
              <div className="flex flex-col gap-1.5">
                <span className="flex min-h-5 items-center gap-1 text-xs text-muted-foreground">{t("bs.status")} <OptTerm term="itm" /></span>
                <div className="flex h-9 items-center gap-2">
                  <Pill tone={r.status === "ITM" ? "up" : r.status === "OTM" ? "down" : "warn"}>{r.status}</Pill>
                  <span className="text-xs tabular-nums text-muted-foreground">{t("bs.fromStrike", { pct: fmtPct(r.moneyness, 2) })}</span>
                </div>
              </div>
            </div>
          </div>
        </Panel>

        <div className="flex min-w-0 flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label={t("bs.pricePerShare", { position: posName })} value={fmtUsd(r.optPrice)} tone={r.isCall ? "up" : "down"}
              hint={r.useUser ? t("bs.theoretical", { price: fmtUsd(r.bs.price) }) : `Call ${fmtUsd(r.call.price)} · Put ${fmtUsd(r.put.price)}`} />
            <StatCard label={r.sell ? t("bs.receive") : t("bs.pay")} value={fmtUsd(r.cost, { decimals: 0 })} tone={r.sell ? "up" : "neutral"} hint={t("bs.sharesTotal", { count: r.N })} />
            <StatCard label={<OptTerm term="breakeven">{t("shared.breakeven")}</OptTerm>} value={fmtUsd(r.breakeven)} tone="accent" hint={r.S > 0 ? t("bs.fromSpot", { pct: fmtPct(((r.breakeven - r.S) / r.S) * 100, 1) }) : undefined} />
            <StatCard label={<OptTerm term="probProfit">{t("shared.probProfit")}</OptTerm>} value={probProfit != null ? fmtPct(probProfit * 100, { decimals: 0, signed: false }) : "—"}
              hint={r.probItm != null ? `ITM ${fmtPct(r.probItm * 100, { decimals: 0, signed: false })}` : t("shared.needDaysIv")} />
          </div>

          <Panel title={t("bs.moneyAndGreeks")} description={t("bs.positionContracts", { position: posName, count: r.N })}>
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <MetricTile label={t("shared.maxProfit")} value={r.summary.maxProfit === null ? t("shared.unlimited") : fmtUsd(r.summary.maxProfit, { decimals: 0 })} tone="text-up" />
                <MetricTile label={t("shared.maxLoss")} term="maxLoss" value={r.summary.maxLoss === null ? t("shared.unlimited") : fmtUsd(-r.summary.maxLoss, { decimals: 0 })} tone="text-down"
                  sub={r.sell ? t("bs.soldRisk") : t("bs.boughtRisk")} />
                <MetricTile label={t("bs.intrinsic")} term="intrinsic" value={fmtUsd(r.intrinsic)} sub={t("bs.perShare")} />
                <MetricTile label={t("bs.timeValue")} term="timeValue" value={fmtUsd(r.timeValue)} sub={t("bs.burnsOut")} tone="text-[hsl(var(--chart-3))]" />
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <MetricTile label="Δ Delta" term="delta" value={fmtNum(r.sign * r.bs.delta, 3)} sub={t("bs.deltaPosition", { amount: fmtUsd(r.sign * r.bs.delta * r.N * 100, { signed: true, decimals: 0 }) })} />
                <MetricTile label="Γ Gamma" term="gamma" value={fmtNum(r.sign * r.bs.gamma, 4)} sub={t("shared.deltaChange")} />
                <MetricTile label={t("bs.thetaDay")} value={fmtUsd(r.sign * r.bs.theta * r.N * 100, { signed: true, decimals: 0 })} sub={t("bs.perShareValue", { value: fmtNum(r.sign * r.bs.theta, 3) })}
                  tone={r.sign * r.bs.theta >= 0 ? "text-up" : "text-down"} term="theta" />
                <MetricTile label="ν Vega / +1% IV" term="vega" value={fmtUsd(r.sign * r.bs.vega * r.N * 100, { signed: true, decimals: 0 })} sub={t("bs.perShareValue", { value: fmtNum(r.sign * r.bs.vega, 3) })} />
                <MetricTile label="ρ Rho / +1%" term="rho" value={fmtUsd(r.sign * r.bs.rho * r.N * 100, { signed: true, decimals: 0 })} sub={t("bs.rateSub")} className="col-span-2 sm:col-span-1" />
              </div>
              {r.validBs && (
                <GreeksInWords
                  delta={r.sign * r.bs.delta * r.N * 100}
                  theta={r.sign * r.bs.theta * r.N * 100}
                  vega={r.sign * r.bs.vega * r.N * 100}
                />
              )}
            </div>
          </Panel>
        </div>
      </div>

      <Panel
        title={<OptTerm term="payoff">{t("shared.payoff")}</OptTerm>}
        description={t("bs.payoffDescription")}
        actions={
          <Button type="button" variant="outline" size="sm" disabled={!r.legs.length}
            onClick={() => onOpenInBuilder({
              symbol: s.ticker, spot: r.S, days: r.days, iv: r.ivPct || null,
              legs: [{ side: s.action, kind: s.side, strike: r.K, premium: r.optPrice, qty: r.N }],
            })}>
            <Layers aria-hidden="true" /> {t("shared.toBuilder")}
          </Button>
        }
      >
        <PayoffChart legs={r.legs} spot={r.S} days={r.days} ivPct={r.ivPct} ratePct={r.ratePct} breakevens={r.summary.breakevens} />
      </Panel>

      <Panel title={t("bs.scenarios")} description={t("bs.scenariosDescription")}>
        <div className="-mx-1 overflow-x-auto px-1">
          <table className="w-full text-sm tabular-nums">
            <caption className="sr-only">{t("bs.scenariosCaption")}</caption>
            <thead>
              <tr className="border-b border-border/60 text-xs text-muted-foreground">
                <th scope="col" className="py-2 pr-2 text-left font-normal">{t("shared.move")}</th>
                <th scope="col" className="px-2 py-2 text-right font-normal">{t("shared.price")}</th>
                <th scope="col" className="px-2 py-2 text-right font-normal">{t("bs.inDays", { days: t("shared.days", { count: Math.round(r.days / 2) }) })}</th>
                <th scope="col" className="py-2 pl-2 text-right font-normal">{t("shared.atExpiry")}</th>
              </tr>
            </thead>
            <tbody>
              {r.scenarios.map((x) => (
                <tr key={x.pct} className={cn("border-b border-border/40 last:border-0", x.pct === 0 && "bg-[var(--glass-bg)]")}>
                  <td className={cn("py-1.5 pr-2", x.pct > 0 ? "text-up" : x.pct < 0 ? "text-down" : "text-muted-foreground")}>{fmtPct(x.pct, 0)}</td>
                  <td className="px-2 py-1.5 text-right">{fmtUsd(x.x)}</td>
                  <td className={cn("px-2 py-1.5 text-right", x.half >= 0 ? "text-up" : "text-down")}>{fmtUsd(x.half, { signed: true, decimals: 0 })}</td>
                  <td className={cn("py-1.5 pl-2 text-right font-medium", x.exp >= 0 ? "text-up" : "text-down")}>{fmtUsd(x.exp, { signed: true, decimals: 0 })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}


/** Greeks as one plain sentence: what happens to the position in $ on a $1 move, one day and +1 pt of IV. */
export function GreeksInWords({ delta, theta, vega, className }: { delta: number; theta: number; vega: number; className?: string }) {
  const { t } = calculatorI18n.useT();
  const part = (v: number, up: "gain" | "plus", down: "lose" | "minus") => (
    <span className={cn("font-medium tabular-nums", v >= 0 ? "text-up" : "text-down")}>
      {t(`greeksInWords.${v >= 0 ? up : down}`, { amount: fmtUsd(Math.abs(v), { decimals: 0 }) })}
    </span>
  );
  return (
    <p className={cn("rounded-xl bg-[var(--glass-bg)] px-3 py-2 text-xs leading-relaxed text-muted-foreground", className)}>
      {rich(t("greeksInWords.sentence", { delta: "{delta}", theta: "{theta}", vega: "{vega}" }), {
        delta: part(delta, "gain", "lose"),
        theta: part(theta, "plus", "minus"),
        vega: part(vega, "plus", "minus"),
      })}
    </p>
  );
}
