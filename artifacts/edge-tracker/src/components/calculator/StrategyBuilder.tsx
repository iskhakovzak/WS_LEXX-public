/** Multi-leg options strategy builder: presets, editable legs, payoff, max P/L, breakevens, net greeks. */
import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { Calculator, ChevronDown, Layers, Plus, RefreshCw, RotateCcw, Search, Trash2, X } from "lucide-react";
import { EmptyState, Panel, Pill, Segmented, StatCard } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  analyzePayoff, blackScholes, fetchQuote, netPremium, newLegId, num, positionGreeks,
  roundStrike, strikeStep, type Leg, type LegKind,
} from "./lib";
import { fmtNum, fmtPct, fmtUsd } from "@/lib/format";
import { MetricTile, NumField } from "./fields";
import { PayoffChart } from "./PayoffChart";
import { GreeksInWords } from "./BlackScholes";
import { OptTerm } from "./glossary";
import { calculatorI18n } from "@/i18n/ns/calculator";

export type LegDraft = { id: string; kind: LegKind; side: "buy" | "sell"; strike: string; premium: string; qty: string };
type Setter = (v: string) => void;
export type BuilderState = {
  symbol: string; setSymbol: Setter;
  spot: string; setSpot: Setter;
  days: string; setDays: Setter;
  iv: string; setIv: Setter;
  rate: string; setRate: Setter;
  legs: LegDraft[]; setLegs: Dispatch<SetStateAction<LegDraft[]>>;
};

type PresetId = "long_call" | "long_put" | "bull_call" | "bear_put" | "straddle" | "strangle" | "iron_condor" | "butterfly" | "covered_call" | "protective_put";
/** Standard English strategy names (the same in RU / EN / UZ). The first MAIN_PRESETS are always visible, the rest sit under «Ещё». */
const PRESETS: { id: PresetId; label: string }[] = [
  { id: "long_call", label: "Long Call" },
  { id: "long_put", label: "Long Put" },
  { id: "bull_call", label: "Bull Call Spread" },
  { id: "bear_put", label: "Bear Put Spread" },
  { id: "straddle", label: "Straddle" },
  { id: "strangle", label: "Strangle" },
  { id: "iron_condor", label: "Iron Condor" },
  { id: "butterfly", label: "Butterfly" },
  { id: "covered_call", label: "Covered Call" },
  { id: "protective_put", label: "Protective Put" },
];
const MAIN_PRESETS = 5;

type Spec = { kind: LegKind; side: "buy" | "sell"; k: number; qty?: number };
function presetSpecs(id: PresetId, atm: number, w: number, spot: number): Spec[] {
  switch (id) {
    case "long_call": return [{ kind: "call", side: "buy", k: atm }];
    case "long_put": return [{ kind: "put", side: "buy", k: atm }];
    case "bull_call": return [{ kind: "call", side: "buy", k: atm }, { kind: "call", side: "sell", k: atm + w }];
    case "bear_put": return [{ kind: "put", side: "buy", k: atm }, { kind: "put", side: "sell", k: atm - w }];
    case "straddle": return [{ kind: "call", side: "buy", k: atm }, { kind: "put", side: "buy", k: atm }];
    case "strangle": return [{ kind: "call", side: "buy", k: atm + w }, { kind: "put", side: "buy", k: atm - w }];
    case "iron_condor": return [
      { kind: "put", side: "buy", k: atm - 2 * w }, { kind: "put", side: "sell", k: atm - w },
      { kind: "call", side: "sell", k: atm + w }, { kind: "call", side: "buy", k: atm + 2 * w },
    ];
    case "butterfly": return [{ kind: "call", side: "buy", k: atm - w }, { kind: "call", side: "sell", k: atm, qty: 2 }, { kind: "call", side: "buy", k: atm + w }];
    case "covered_call": return [{ kind: "stock", side: "buy", k: spot, qty: 100 }, { kind: "call", side: "sell", k: atm + w }];
    case "protective_put": return [{ kind: "stock", side: "buy", k: spot, qty: 100 }, { kind: "put", side: "buy", k: atm - w }];
  }
}

function toLeg(d: LegDraft): Leg | null {
  const strike = num(d.strike);
  const qty = Math.floor(num(d.qty));
  const premium = d.kind === "stock" ? 0 : num(d.premium);
  if (!(strike > 0) || !(qty >= 1) || !(premium >= 0)) return null;
  return { id: d.id, kind: d.kind, side: d.side, strike, premium, qty };
}

export default function StrategyBuilder({ b }: { b: BuilderState }) {
  const { t } = calculatorI18n.useT();
  const [loading, setLoading] = useState(false);
  const [allPresets, setAllPresets] = useState(false);
  const [info, setInfo] = useState<{ ok: boolean; text: string } | null>(null);

  const S = num(b.spot);
  const days = Math.max(0, num(b.days) || 0);
  const T = days / 365;
  const ivPct = Math.max(0, num(b.iv) || 0);
  const sigma = ivPct / 100;
  const ratePct = num(b.rate) || 0;
  const rr = ratePct / 100;

  const theo = useCallback((d: LegDraft) => {
    const k = num(d.strike);
    if (d.kind === "stock" || !(S > 0) || !(k > 0)) return NaN;
    return blackScholes(S, k, T, rr, sigma, d.kind).price;
  }, [S, T, rr, sigma]);

  const loadSpot = useCallback(async () => {
    const sym = b.symbol.trim().toUpperCase();
    if (!sym) return;
    setLoading(true); setInfo(null);
    try {
      const q = await fetchQuote(sym);
      if (q) { b.setSpot(q.price.toFixed(2)); setInfo({ ok: true, text: `${sym} ${fmtUsd(q.price)}` }); }
      else setInfo({ ok: false, text: calculatorI18n.t("shared.tickerNotFound") });
    } catch {
      setInfo({ ok: false, text: calculatorI18n.t("shared.priceLoadFailed") });
    } finally { setLoading(false); }
  }, [b]);

  function applyPreset(id: PresetId) {
    if (!(S > 0)) return;
    const step = strikeStep(S);
    const atm = roundStrike(S, step);
    const w = Math.max(step, roundStrike(S * 0.05, step));
    const drafts = presetSpecs(id, atm, w, S).filter((sp) => sp.k > 0).map<LegDraft>((sp) => {
      const prem = sp.kind === "stock" ? NaN : blackScholes(S, sp.k, T, rr, sigma, sp.kind).price;
      return {
        id: newLegId(), kind: sp.kind, side: sp.side,
        strike: String(+sp.k.toFixed(2)),
        premium: Number.isFinite(prem) ? String(+prem.toFixed(2)) : "",
        qty: String(sp.qty ?? 1),
      };
    });
    b.setLegs(drafts);
  }

  function update(id: string, patch: Partial<LegDraft>) {
    b.setLegs((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }
  function addLeg() {
    const step = S > 0 ? strikeStep(S) : 1;
    b.setLegs((ls) => [...ls, { id: newLegId(), kind: "call", side: "buy", strike: S > 0 ? String(roundStrike(S, step)) : "", premium: "", qty: "1" }]);
  }
  function repriceAll() {
    b.setLegs((ls) => ls.map((l) => {
      const p = theo(l);
      return Number.isFinite(p) ? { ...l, premium: String(+p.toFixed(2)) } : l;
    }));
  }

  const legs = useMemo(() => b.legs.map(toLeg).filter((l): l is Leg => l !== null), [b.legs]);
  const invalidCount = b.legs.length - legs.length;
  const stats = useMemo(() => {
    if (!legs.length || !(S > 0)) return null;
    const summary = analyzePayoff(legs, S, T, rr, sigma);
    const net = netPremium(legs);
    const g = positionGreeks(legs, S, T, rr, sigma);
    const rrRatio = summary.maxProfit != null && summary.maxLoss != null && summary.maxLoss > 0 ? summary.maxProfit / summary.maxLoss : null;
    return { summary, net, g, rrRatio };
  }, [legs, S, T, rr, sigma]);

  return (
    <div className="flex flex-col gap-4">
      <Panel title={t("builder.underlying")} icon={Layers} description={t("builder.underlyingDescription")}
        actions={
          <Button type="button" variant="ghost" size="sm" title={t("shared.resetTitle")}
            onClick={() => { b.setSpot("100"); b.setDays("30"); b.setIv("30"); b.setRate("4.5"); setInfo(null); }}>
            <RotateCcw aria-hidden="true" /> {t("shared.reset")}
          </Button>
        }>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-[minmax(0,1.4fr)_repeat(4,minmax(0,1fr))] md:items-end">
          <div className="col-span-2 flex flex-col gap-1.5 md:col-span-1">
            <Label htmlFor="sb-ticker" className="text-xs font-normal text-muted-foreground">{t("shared.ticker")}</Label>
            <div className="flex gap-2">
              <Input id="sb-ticker" value={b.symbol} autoComplete="off" placeholder="AAPL" className="h-9 uppercase"
                onChange={(e) => b.setSymbol(e.target.value.toUpperCase())}
                onKeyDown={(e) => { if (e.key === "Enter") void loadSpot(); }} />
              <Button type="button" variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => void loadSpot()}
                disabled={loading || !b.symbol.trim()} aria-label={t("builder.loadPriceAria")}>
                {loading ? <RefreshCw className="animate-spin" aria-hidden="true" /> : <Search aria-hidden="true" />}
              </Button>
            </div>
          </div>
          <NumField label={t("shared.spot")} term="spot" prefix="$" value={b.spot} onChange={b.setSpot} error={!(S > 0) ? t("builder.spotError") : undefined} />
          <NumField label={t("builder.days")} term="dte" value={b.days} onChange={b.setDays} integer />
          <NumField label="IV" term="iv" suffix="%" value={b.iv} onChange={b.setIv} />
          <NumField label={t("shared.rate")} term="rate" suffix="%" value={b.rate} onChange={b.setRate} />
        </div>
        {info && <p role="status" className={cn("mt-2 text-xs", info.ok ? "text-up" : "text-down")}>{info.text}</p>}
      </Panel>

      <Panel
        title={t("builder.legs")}
        description={t("builder.legsDescription")}
        actions={b.legs.length > 0 ? (
          <>
            <Button type="button" variant="ghost" size="sm" onClick={repriceAll} disabled={!(S > 0)}>
              <Calculator aria-hidden="true" /> {t("builder.repriceAll")}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => b.setLegs([])}>
              <Trash2 aria-hidden="true" /> {t("builder.clear")}
            </Button>
          </>
        ) : undefined}
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("builder.presetsAria")}
            title={S > 0 ? undefined : t("builder.presetsNeedSpot")}>
            {(allPresets ? PRESETS : PRESETS.slice(0, MAIN_PRESETS)).map((p) => (
              <button key={p.id} type="button" onClick={() => applyPreset(p.id)} disabled={!(S > 0)}
                className="chip inline-flex min-h-8 items-center px-3 text-xs font-medium disabled:opacity-50">
                {p.label}
              </button>
            ))}
            <button type="button" aria-expanded={allPresets} onClick={() => setAllPresets((v) => !v)}
              className="inline-flex min-h-8 items-center gap-1 rounded-full px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
              {allPresets ? t("shared.less") : t("builder.morePresets")}
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", allPresets && "rotate-180")} aria-hidden="true" />
            </button>
          </div>

          {b.legs.length === 0 ? (
            <EmptyState icon={Layers} title={t("builder.emptyTitle")} description={t("builder.emptyDescription")}
              action={<Button type="button" variant="outline" onClick={addLeg}><Plus aria-hidden="true" /> {t("builder.addLeg")}</Button>} />
          ) : (
            <>
              <ul className="flex flex-col gap-2">
                {b.legs.map((d, i) => {
                  const theoPrice = theo(d);
                  const bad = !toLeg(d);
                  return (
                    <li key={d.id} className={cn("grid grid-cols-2 gap-2 rounded-xl border bg-[var(--glass-bg)] p-3 sm:grid-cols-[auto_8rem_minmax(0,1fr)_minmax(0,1fr)_5.5rem_auto] sm:items-end",
                      bad ? "border-down/50" : "border-border/60")}>
                      <div className="col-span-2 flex items-center justify-between gap-2 sm:col-span-1 sm:flex-col sm:items-start sm:gap-1.5">
                        <span className="text-xs text-muted-foreground">{t("builder.leg", { n: i + 1 })}</span>
                        <Segmented<"buy" | "sell">
                          ariaLabel={t("builder.legSideAria", { n: i + 1 })}
                          size="sm"
                          value={d.side}
                          onChange={(v) => update(d.id, { side: v })}
                          options={[{ value: "buy", label: "Buy" }, { value: "sell", label: "Sell" }]}
                        />
                      </div>
                      <div className="flex min-w-0 flex-col gap-1.5">
                        <Label htmlFor={`leg-kind-${d.id}`} className="text-xs font-normal text-muted-foreground">{t("builder.instrument")}</Label>
                        <Select value={d.kind} onValueChange={(v) => update(d.id, { kind: v as LegKind, qty: v === "stock" && d.qty === "1" ? "100" : d.qty })}>
                          <SelectTrigger id={`leg-kind-${d.id}`} className="h-9"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="call">Call</SelectItem>
                            <SelectItem value="put">Put</SelectItem>
                            <SelectItem value="stock">{t("builder.stock")}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <NumField label={d.kind === "stock" ? t("builder.entryPrice") : t("shared.strike")} prefix="$" value={d.strike} onChange={(v) => update(d.id, { strike: v })} />
                      <NumField label={t("builder.premium")} term="premium" prefix="$" value={d.kind === "stock" ? "" : d.premium} disabled={d.kind === "stock"}
                        onChange={(v) => update(d.id, { premium: v })}
                        placeholder={d.kind === "stock" ? "—" : Number.isFinite(theoPrice) ? fmtNum(theoPrice, 2) : "0.00"}
                        hint={d.kind !== "stock" && Number.isFinite(theoPrice) ? t("builder.theoreticalPrice", { price: fmtUsd(theoPrice) }) : undefined} />
                      <NumField label={d.kind === "stock" ? t("builder.shares") : t("builder.contractsShort")} value={d.qty} integer onChange={(v) => update(d.id, { qty: v })} />
                      <Button type="button" variant="ghost" size="icon" className="h-9 w-9 self-end justify-self-end"
                        onClick={() => b.setLegs((ls) => ls.filter((l) => l.id !== d.id))} aria-label={t("builder.removeLegAria", { n: i + 1 })}>
                        <X aria-hidden="true" />
                      </Button>
                    </li>
                  );
                })}
              </ul>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={addLeg}><Plus aria-hidden="true" /> {t("builder.addLeg")}</Button>
                {invalidCount > 0 && <Pill tone="down">{t("builder.invalidLegs", { count: invalidCount })}</Pill>}
              </div>
            </>
          )}
        </div>
      </Panel>

      {stats && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label={<OptTerm term="debit">{stats.net >= 0 ? t("builder.debitPay") : t("builder.creditReceive")}</OptTerm>} value={fmtUsd(Math.abs(stats.net), { decimals: 0 })} tone={stats.net >= 0 ? "neutral" : "up"}
              hint={legs.some((l) => l.kind === "stock") ? t("builder.noStockCost") : undefined} />
            <StatCard label={t("shared.maxProfit")} value={stats.summary.maxProfit === null ? t("shared.unlimited") : fmtUsd(stats.summary.maxProfit, { decimals: 0 })} tone="up"
              hint={stats.rrRatio != null ? `R:R ${fmtNum(stats.rrRatio, 2)}` : undefined} />
            <StatCard label={<OptTerm term="maxLoss">{t("shared.maxLoss")}</OptTerm>} value={stats.summary.maxLoss === null ? t("shared.unlimited") : fmtUsd(-stats.summary.maxLoss, { decimals: 0 })} tone="down" />
            <StatCard label={<OptTerm term="probProfit">{t("shared.probProfit")}</OptTerm>} value={stats.summary.probProfit != null ? fmtPct(stats.summary.probProfit * 100, { decimals: 0, signed: false }) : "—"}
              hint={stats.summary.probProfit != null ? t("builder.lognormal") : t("shared.needDaysIv")} />
          </div>
          <Panel
            title={<OptTerm term="payoff">{t("shared.payoff")}</OptTerm>}
            description={stats.summary.breakevens.length ? t("builder.breakevens", { list: stats.summary.breakevens.map((x) => fmtUsd(x)).join(" / ") }) : t("builder.noBreakeven")}
          >
            <div className="flex flex-col gap-4">
              <PayoffChart legs={legs} spot={S} days={days} ivPct={ivPct} ratePct={ratePct} breakevens={stats.summary.breakevens} />
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <MetricTile label={t("builder.deltaPosition")} term="delta" value={fmtNum(stats.g.delta, 1)} sub={t("builder.deltaSub", { amount: fmtUsd(stats.g.delta, { signed: true, decimals: 0 }) })} />
                <MetricTile label={t("builder.gammaPosition")} term="gamma" value={fmtNum(stats.g.gamma, 2)} sub={t("shared.deltaChange")} />
                <MetricTile label={t("builder.thetaDay")} term="theta" value={fmtUsd(stats.g.theta, { signed: true, decimals: 0 })} tone={stats.g.theta >= 0 ? "text-up" : "text-down"} sub={t("builder.timeDecay")} />
                <MetricTile label="Vega / +1% IV" term="vega" value={fmtUsd(stats.g.vega, { signed: true, decimals: 0 })} tone={stats.g.vega >= 0 ? "text-up" : "text-down"} sub={t("builder.vegaSub")} />
              </div>
              <GreeksInWords delta={stats.g.delta} theta={stats.g.theta} vega={stats.g.vega} />
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}
