/**
 * Shared trade fixture for the R / net P&L contract. The SAME rows are pushed through
 *   - the server JS (lib/tradeMath.ts signedR / netPnl),
 *   - the server SQL builders (signedRSql / netPnlSql over a VALUES CTE, when Postgres is up),
 *   - the client JS (edge-tracker lib/trade-math.ts, parity test).
 * `expectR` / `expectNet` are computed by hand from the contract:
 *   stored R with sign from result → price R (side-aware) → pnl / riskUsd; BE ⇒ 0; open ⇒ null; clamp ±20.
 */
export interface FixtureRow {
  id: number;
  name: string;
  result: string | null;
  side?: string | null;
  entry?: number | string | null;
  exit?: number | string | null;
  stop?: number | string | null;
  rMultiple?: number | string | null;
  pnl?: number | string | null;
  fees?: number | string | null;
  riskUsd?: number | string | null;
  expectR: number | null;
  expectNet: number | null;
}

export const TRADE_ROWS: FixtureRow[] = [
  { id: 1, name: "win + stored R", result: "win", side: "long", rMultiple: 2.5, pnl: 250, fees: 2, riskUsd: 100, expectR: 2.5, expectNet: 248 },
  { id: 2, name: "loss + positive stored R → sign from result", result: "loss", side: "long", rMultiple: 1.5, pnl: -150, fees: 2, expectR: -1.5, expectNet: -152 },
  { id: 3, name: "win + negative stored R → abs", result: "win", side: "long", rMultiple: -3, pnl: 300, fees: 0, expectR: 3, expectNet: 300 },
  { id: 4, name: "BE ⇒ 0 even with stored R", result: "be", side: "long", rMultiple: 1, pnl: 10, fees: 2, expectR: 0, expectNet: 8 },
  { id: 5, name: "open ⇒ null even with stored R", result: "open", side: "long", rMultiple: 1, pnl: null, fees: 1, expectR: null, expectNet: null },
  { id: 6, name: "price R long", result: "win", side: "long", entry: 100, exit: 110, stop: 95, pnl: 1000, fees: 5, expectR: 2, expectNet: 995 },
  { id: 7, name: "price R short loss", result: "loss", side: "short", entry: 100, exit: 104, stop: 102, pnl: -400, fees: 5, expectR: -2, expectNet: -405 },
  { id: 8, name: "price R short win", result: "win", side: "short", entry: 50, exit: 45, stop: 52, pnl: 500, fees: 0, expectR: 2.5, expectNet: 500 },
  { id: 9, name: "result loss but price says +2R (price wins, conflict flagged)", result: "loss", side: "long", entry: 10, exit: 12, stop: 9, pnl: 200, fees: 1, expectR: 2, expectNet: 199 },
  { id: 10, name: "stop == entry → pnl / riskUsd", result: "win", side: "long", entry: 100, exit: 110, stop: 100, pnl: 500, fees: 0, riskUsd: 100, expectR: 5, expectNet: 500 },
  { id: 11, name: "riskUsd 0 → null", result: "win", side: "long", pnl: 300, fees: 0, riskUsd: 0, expectR: null, expectNet: 300 },
  { id: 12, name: "pnl / riskUsd loss", result: "loss", side: "long", pnl: -250, fees: 3, riskUsd: 100, expectR: -2.5, expectNet: -253 },
  { id: 13, name: "clamp +20", result: "win", side: "long", entry: 1, exit: 100, stop: 0.5, pnl: 9900, fees: 0, expectR: 20, expectNet: 9900 },
  { id: 14, name: "clamp −20", result: "loss", side: "long", entry: 100, exit: 1, stop: 99.5, pnl: -9900, fees: 0, expectR: -20, expectNet: -9900 },
  { id: 15, name: "unknown result keeps stored sign", result: null, side: "long", rMultiple: -1.2, pnl: -120, fees: 0, expectR: -1.2, expectNet: -120 },
  { id: 16, name: "russian result + numeric strings", result: "Прибыль", side: "long", rMultiple: "1.25", pnl: "120.5", fees: "-3.5", expectR: 1.25, expectNet: 117 },
  { id: 17, name: "padded result", result: "  WIN ", side: "long", pnl: 100, fees: 0, riskUsd: 50, expectR: 2, expectNet: 100 },
  { id: 18, name: "pnl null ⇒ net null", result: "win", side: "long", rMultiple: 1, pnl: null, fees: 5, expectR: 1, expectNet: null },
  { id: 19, name: "fees always subtract", result: "loss", side: "long", pnl: -100, fees: 7, riskUsd: 50, expectR: -2, expectNet: -107 },
  { id: 20, name: "capitalised Short", result: "win", side: "Short", entry: 20, exit: 19, stop: 21, pnl: 100, fees: 0, expectR: 1, expectNet: 100 },
  { id: 21, name: "exit missing → pnl / riskUsd", result: "win", side: "long", entry: 10, exit: null, stop: 9, pnl: 200, fees: 0, riskUsd: 50, expectR: 4, expectNet: 200 },
  { id: 22, name: "invalid stored R → price R", result: "win", side: "long", rMultiple: "abc", entry: 10, exit: 11, stop: 9, pnl: 100, fees: 0, expectR: 1, expectNet: 100 },
  { id: 23, name: "breakeven alias", result: "breakeven", side: "long", pnl: 10, fees: 2, riskUsd: 100, expectR: 0, expectNet: 8 },
  { id: 24, name: "exit == entry → price R 0 (no fallback)", result: "loss", side: "long", entry: 100, exit: 100, stop: 90, pnl: -5, fees: 1, riskUsd: 100, expectR: 0, expectNet: -6 },
  { id: 25, name: "stored R 0 on a loss", result: "loss", side: "long", rMultiple: 0, pnl: -1, fees: 0, expectR: 0, expectNet: -1 },
  { id: 26, name: "no data at all", result: "win", side: null, expectR: null, expectNet: null },
  { id: 27, name: "lower-case be alias «бу»", result: "бу", side: "short", entry: 10, exit: 9, stop: 11, pnl: 0, fees: 1, expectR: 0, expectNet: -1 },
  { id: 28, name: "side with surrounding spaces", result: "win", side: " short ", entry: 10, exit: 9, stop: 11, pnl: 100, fees: 0, expectR: 1, expectNet: 100 },
];

/** snake_case view of a row (what `pool.query` hands the server). */
export function toSnake(r: FixtureRow) {
  return {
    result: r.result,
    side: r.side,
    entry: r.entry,
    exit: r.exit,
    stop: r.stop,
    r_multiple: r.rMultiple,
    pnl: r.pnl,
    fees: r.fees,
    risk_usd: r.riskUsd,
  };
}
