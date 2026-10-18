/**
 * Rule-based options strategy advisor: builds candidate strategies from a loaded chain and scores them by goal.
 * Texts are not built here: each strategy carries its `id` (→ `calculator` namespace `strategies.<id>.summary` /
 * `.bestWhen`, resolved at render) and preformatted `summaryParams`. Names (Long Call…) are standard English terms.
 */
import { fmtStrike, probAbove } from "./lib";
import { fmtPrice, fmtUsd } from "@/lib/format";

export type ChainOption = {
  contractSymbol: string; strike: number;
  bid: number; ask: number; last: number; mid: number;
  iv: number | null; volume: number; openInterest: number;
  inTheMoney: boolean; change: number; changePct: number;
};
export type Expiration = { timestamp: number; label: string; dte: number };
export type ChainData = {
  symbol: string; spot: number; change: number | null; changePct: number | null; name: string;
  expirationDate: number; daysToExpiry: number; calls: ChainOption[]; puts: ChainOption[]; strikes: number[];
};
export type AdvisorGoal = "bullish" | "bearish" | "hedge_long" | "hedge_short" | "big_move" | "neutral_sell";
export type IvOutlook = "expand" | "contract" | "neutral";
export type StrategyLeg = { action: "buy" | "sell"; optType: "call" | "put"; strike: number; premium: number };
export type StrategyId =
  | "long_call" | "long_put" | "bull_call_spread" | "bear_put_spread" | "protective_put"
  | "collar" | "long_straddle" | "long_strangle" | "cash_secured_put" | "covered_call";
export type Strategy = {
  id: StrategyId; name: string; legs: StrategyLeg[];
  netDebit: number;
  maxProfit: number | null; maxLoss: number | null;
  breakevens: number[]; probProfit: number | null;
  ivSensitivity: "positive" | "negative" | "neutral";
  score: number;
  /** Params for `strategies.<id>.summary` (strikes, prices and money already formatted). */
  summaryParams: Record<string, string>;
  totalCostPerContract: number;
  riskReward: number | null;
};

export function fsFind(opts: ChainOption[], target: number): ChainOption | null {
  if (!opts.length) return null;
  const pool = opts.filter(o => (o.bid > 0 || o.volume > 20 || o.openInterest > 50) && o.mid > 0);
  const src = pool.length > 2 ? pool : opts;
  return src.reduce((b, o) => Math.abs(o.strike - target) < Math.abs(b.strike - target) ? o : b);
}

export function buildStrategies(chain: ChainData, goal: AdvisorGoal, maxRisk: number, ivOutlook: IvOutlook, nContracts: number, riskFreeRate: number): Strategy[] {
  const { spot, daysToExpiry: dte, calls, puts } = chain;
  const T = dte / 365;
  const r = riskFreeRate / 100;
  const N = nContracts;

  /** P(S_T > x) in %, using the contract's IV (risk-neutral, lognormal). */
  function pAbove(x: number, iv: number | null): number | null {
    if (!iv || dte <= 0) return null;
    return probAbove(spot, x, T, r, iv / 100);
  }
  const pct = (p: number | null): number | null => (p === null ? null : +(Math.min(1, Math.max(0, p)) * 100).toFixed(1));
  const below = (p: number | null): number | null => (p === null ? null : 1 - p);

  function scoreIt(ivSens: "positive" | "negative" | "neutral", goalMatch: number, cost: number): number {
    let s = goalMatch;
    if (ivSens === "positive" && ivOutlook === "expand") s += 18;
    if (ivSens === "positive" && ivOutlook === "contract") s -= 12;
    if (ivSens === "negative" && ivOutlook === "contract") s += 18;
    if (ivSens === "negative" && ivOutlook === "expand") s -= 12;
    // maxRisk is $ per contract; cost is total $ for N contracts
    const budget = maxRisk * N;
    if (cost <= budget * 0.5) s += 15;
    else if (cost <= budget) s += 8;
    else if (cost > budget * 1.3) s -= 20;
    return Math.min(99, Math.max(1, s));
  }

  const results: Strategy[] = [];
  const usd0 = (v: number) => fmtUsd(v, { decimals: 0 });
  const k = (v: number) => fmtStrike(v);

  const atm = fsFind(calls, spot);
  const atmP = fsFind(puts, spot);
  const otmC5 = fsFind(calls, spot * 1.05);
  const otmC10 = fsFind(calls, spot * 1.10);
  const otmP5 = fsFind(puts, spot * 0.95);
  const otmP10 = fsFind(puts, spot * 0.90);

  // ─── Long Call ───
  const lcStrike = (goal === "bullish" ? otmC5 : atm) ?? atm;
  if (lcStrike) {
    const prem = lcStrike.mid;
    const be = lcStrike.strike + prem;
    const cost = prem * 100 * N;
    const gm = goal === "bullish" ? 38 : goal === "hedge_short" ? 25 : goal === "big_move" ? 15 : -5;
    results.push({
      id: "long_call", name: "Long Call", legs: [{ action: "buy", optType: "call", strike: lcStrike.strike, premium: prem }],
      netDebit: prem, maxProfit: null, maxLoss: cost,
      breakevens: [be], probProfit: pct(pAbove(be, lcStrike.iv)),
      ivSensitivity: "positive", score: scoreIt("positive", gm, cost),
      summaryParams: { strike: k(lcStrike.strike), be: fmtPrice(be) },
      totalCostPerContract: prem * 100,
      riskReward: null,
    });
  }

  // ─── Long Put ───
  const lpStrike = (goal === "bearish" ? otmP5 : atmP) ?? atmP;
  if (lpStrike) {
    const prem = lpStrike.mid;
    const be = lpStrike.strike - prem;
    const cost = prem * 100 * N;
    const maxP = (lpStrike.strike - prem) * 100 * N;
    const gm = goal === "bearish" ? 38 : goal === "hedge_long" ? 28 : goal === "big_move" ? 15 : -5;
    results.push({
      id: "long_put", name: "Long Put", legs: [{ action: "buy", optType: "put", strike: lpStrike.strike, premium: prem }],
      netDebit: prem, maxProfit: maxP, maxLoss: cost,
      breakevens: [be], probProfit: pct(below(pAbove(be, lpStrike.iv))),
      ivSensitivity: "positive", score: scoreIt("positive", gm, cost),
      summaryParams: { strike: k(lpStrike.strike), be: fmtPrice(be), maxProfit: usd0(maxP) },
      totalCostPerContract: prem * 100,
      riskReward: maxP > 0 && cost > 0 ? +(maxP / cost).toFixed(2) : null,
    });
  }

  // ─── Bull Call Spread ───
  const bcsLow = atm ?? otmC5;
  const bcsHigh = otmC10;
  if (bcsLow && bcsHigh && bcsHigh.strike > bcsLow.strike) {
    const debit = +(bcsLow.mid - bcsHigh.mid).toFixed(3);
    if (debit > 0) {
      const spread = bcsHigh.strike - bcsLow.strike;
      const maxP = (spread - debit) * 100 * N;
      const cost = debit * 100 * N;
      const be = bcsLow.strike + debit;
      const gm = goal === "bullish" ? 42 : -8;
      results.push({
        id: "bull_call_spread", name: "Bull Call Spread",
        legs: [{ action: "buy", optType: "call", strike: bcsLow.strike, premium: bcsLow.mid }, { action: "sell", optType: "call", strike: bcsHigh.strike, premium: bcsHigh.mid }],
        netDebit: debit, maxProfit: maxP, maxLoss: cost,
        breakevens: [be], probProfit: pct(pAbove(be, bcsLow.iv)),
        ivSensitivity: "neutral", score: scoreIt("neutral", gm, cost),
        summaryParams: { low: k(bcsLow.strike), high: k(bcsHigh.strike), maxProfit: usd0(maxP), risk: usd0(cost) },
        totalCostPerContract: debit * 100,
        riskReward: cost > 0 ? +(maxP / cost).toFixed(2) : null,
      });
    }
  }

  // ─── Bear Put Spread ───
  const bpsHigh = atmP ?? otmP5;
  const bpsLow = otmP10;
  if (bpsHigh && bpsLow && bpsHigh.strike > bpsLow.strike) {
    const debit = +(bpsHigh.mid - bpsLow.mid).toFixed(3);
    if (debit > 0) {
      const spread = bpsHigh.strike - bpsLow.strike;
      const maxP = (spread - debit) * 100 * N;
      const cost = debit * 100 * N;
      const be = bpsHigh.strike - debit;
      const gm = goal === "bearish" ? 42 : -8;
      results.push({
        id: "bear_put_spread", name: "Bear Put Spread",
        legs: [{ action: "buy", optType: "put", strike: bpsHigh.strike, premium: bpsHigh.mid }, { action: "sell", optType: "put", strike: bpsLow.strike, premium: bpsLow.mid }],
        netDebit: debit, maxProfit: maxP, maxLoss: cost,
        breakevens: [be], probProfit: pct(below(pAbove(be, bpsHigh.iv))),
        ivSensitivity: "neutral", score: scoreIt("neutral", gm, cost),
        summaryParams: { high: k(bpsHigh.strike), low: k(bpsLow.strike), maxProfit: usd0(maxP), risk: usd0(cost) },
        totalCostPerContract: debit * 100,
        riskReward: cost > 0 ? +(maxP / cost).toFixed(2) : null,
      });
    }
  }

  // ─── Protective Put (hedge long) ───
  const pp = otmP5 ?? otmP10;
  if (pp) {
    const prem = pp.mid;
    const cost = prem * 100 * N;
    const gm = goal === "hedge_long" ? 48 : 5;
    results.push({
      id: "protective_put", name: "Protective Put",
      legs: [{ action: "buy", optType: "put", strike: pp.strike, premium: prem }],
      netDebit: prem, maxProfit: null, maxLoss: (Math.max(0, spot - pp.strike) + prem) * 100 * N,
      breakevens: [spot + prem],
      probProfit: pct(pAbove(spot + prem, pp.iv)), ivSensitivity: "positive", score: scoreIt("positive", gm, cost),
      summaryParams: { strike: k(pp.strike), cost: usd0(cost) },
      totalCostPerContract: prem * 100,
      riskReward: null,
    });
  }

  // ─── Collar ───
  const collarPut = otmP5 ?? otmP10;
  const collarCall = otmC5 ?? otmC10;
  if (collarPut && collarCall) {
    const debit = +(collarPut.mid - collarCall.mid).toFixed(3);
    const cost = Math.max(0, debit) * 100 * N;
    const gm = goal === "hedge_long" ? 40 : 0;
    results.push({
      id: "collar", name: "Collar",
      legs: [{ action: "buy", optType: "put", strike: collarPut.strike, premium: collarPut.mid }, { action: "sell", optType: "call", strike: collarCall.strike, premium: collarCall.mid }],
      netDebit: debit, maxProfit: (collarCall.strike - spot - debit) * 100 * N, maxLoss: Math.max(0, spot - collarPut.strike + debit) * 100 * N,
      breakevens: [spot + debit],
      probProfit: pct(pAbove(spot + debit, collarPut.iv)), ivSensitivity: "neutral", score: scoreIt("neutral", gm, cost),
      summaryParams: { put: k(collarPut.strike), call: k(collarCall.strike) },
      totalCostPerContract: Math.max(0, debit) * 100,
      riskReward: null,
    });
  }

  // ─── Long Straddle ───
  const strdC = atm; const strdP = atmP;
  if (strdC && strdP) {
    const debit = strdC.mid + strdP.mid;
    const cost = debit * 100 * N;
    const beUp = strdC.strike + debit;
    const beDn = strdP.strike - debit;
    const gm = goal === "big_move" ? 48 : 5;
    results.push({
      id: "long_straddle", name: "Long Straddle",
      legs: [{ action: "buy", optType: "call", strike: strdC.strike, premium: strdC.mid }, { action: "buy", optType: "put", strike: strdP.strike, premium: strdP.mid }],
      netDebit: debit, maxProfit: null, maxLoss: cost,
      breakevens: [beDn, beUp], probProfit: (() => { const up = pAbove(beUp, strdC.iv), dn = pAbove(beDn, strdP.iv ?? strdC.iv); return up === null || dn === null ? null : pct(up + (1 - dn)); })(), ivSensitivity: "positive",
      score: scoreIt("positive", gm, cost),
      summaryParams: { call: k(strdC.strike), put: k(strdP.strike), low: fmtPrice(beDn), high: fmtPrice(beUp) },
      totalCostPerContract: debit * 100,
      riskReward: null,
    });
  }

  // ─── Long Strangle ───
  if (otmC5 && otmP5) {
    const debit = otmC5.mid + otmP5.mid;
    const cost = debit * 100 * N;
    const beUp = otmC5.strike + debit;
    const beDn = otmP5.strike - debit;
    const gm = goal === "big_move" ? 42 : 2;
    results.push({
      id: "long_strangle", name: "Long Strangle",
      legs: [{ action: "buy", optType: "call", strike: otmC5.strike, premium: otmC5.mid }, { action: "buy", optType: "put", strike: otmP5.strike, premium: otmP5.mid }],
      netDebit: debit, maxProfit: null, maxLoss: cost,
      breakevens: [beDn, beUp], probProfit: (() => { const up = pAbove(beUp, otmC5.iv), dn = pAbove(beDn, otmP5.iv ?? otmC5.iv); return up === null || dn === null ? null : pct(up + (1 - dn)); })(), ivSensitivity: "positive",
      score: scoreIt("positive", gm, cost),
      summaryParams: { call: k(otmC5.strike), put: k(otmP5.strike) },
      totalCostPerContract: debit * 100,
      riskReward: null,
    });
  }

  // ─── Cash-Secured Put ───
  if (otmP5) {
    const credit = otmP5.mid;
    const maxP = credit * 100 * N;
    const maxL = (otmP5.strike - credit) * 100 * N;
    const be = otmP5.strike - credit;
    const gm = goal === "neutral_sell" ? 45 : goal === "bullish" ? 22 : -5;
    results.push({
      id: "cash_secured_put", name: "Cash-Secured Put",
      legs: [{ action: "sell", optType: "put", strike: otmP5.strike, premium: credit }],
      netDebit: -credit, maxProfit: maxP, maxLoss: maxL,
      breakevens: [be], probProfit: pct(pAbove(be, otmP5.iv)), ivSensitivity: "negative",
      score: scoreIt("negative", gm, 0),
      summaryParams: { strike: k(otmP5.strike), credit: usd0(maxP), be: fmtPrice(be) },
      totalCostPerContract: 0,
      riskReward: maxL > 0 ? +(maxP / maxL).toFixed(3) : null,
    });
  }

  // ─── Covered Call ───
  if (otmC5) {
    const credit = otmC5.mid;
    const maxP = (otmC5.strike - spot + credit) * 100 * N;
    const be = spot - credit;
    const gm = goal === "neutral_sell" ? 42 : goal === "bullish" ? 15 : -5;
    results.push({
      id: "covered_call", name: "Covered Call",
      legs: [{ action: "sell", optType: "call", strike: otmC5.strike, premium: credit }],
      netDebit: -credit, maxProfit: maxP, maxLoss: Math.max(0, be) * 100 * N, // stock → 0 minus premium received
      breakevens: [be], probProfit: pct(pAbove(be, otmC5.iv)), ivSensitivity: "negative",
      score: scoreIt("negative", gm, 0),
      summaryParams: { strike: k(otmC5.strike), credit: usd0(credit * 100 * N) },
      totalCostPerContract: 0,
      riskReward: null,
    });
  }

  return results.sort((a, b) => b.score - a.score);
}
