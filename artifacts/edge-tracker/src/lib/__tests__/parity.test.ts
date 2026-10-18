/**
 * PARITY: the client (edge-tracker/src/lib/trade-math.ts) and the server (api-server/src/lib/tradeMath.ts)
 * must give identical R and net P&L for the same rows — the audit found four R formulas on one book.
 * The SQL side of the same contract is checked in api-server/src/lib/__tests__/tradeMathSql.test.ts.
 */
import { describe, expect, it } from "vitest";
import * as client from "@/lib/trade-math";
import * as server from "../../../../api-server/src/lib/tradeMath";
import { TRADE_ROWS, toSnake } from "../../../../api-server/src/lib/__tests__/fixtures/trade-rows";

const same = (a: number | null, b: number | null, label: string) => {
  if (a == null || b == null) expect(a, label).toBe(b);
  else expect(a, label).toBeCloseTo(b, 12);
};

describe("client ≡ server trade math", () => {
  it.each(TRADE_ROWS.map((r) => [r.id, r.name, r] as const))("#%i %s", (_id, name, row) => {
    same(client.signedR(row), server.signedR(row), `${name}: R camel`);
    same(client.signedR(row), server.signedR(toSnake(row)), `${name}: R snake`);
    same(client.netPnl(row), server.netPnl(row), `${name}: net camel`);
    same(client.netPnl(row), server.netPnl(toSnake(row)), `${name}: net snake`);
  });

  it("result normalisation agrees on every alias", () => {
    for (const raw of ["win", "WIN", "Прибыль", "профит", "loss", "Убыток", "лосс", "be", "breakeven", "безубыток", "бу", "open", "OPEN", "", "x", null, undefined]) {
      const c = client.resultOf({ result: raw ?? null });
      const s = server.normResult(raw);
      // client has no "open" bucket (isOpen is separate): everything else must match
      if (s === "open") expect(client.isOpen({ result: raw ?? null })).toBe(true);
      else expect(c, String(raw)).toBe(s);
    }
  });

  it("random rows: fuzz parity over 2000 generated trades", () => {
    let seed = 42;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
    const maybe = <T,>(v: T): T | null => (rnd() < 0.25 ? null : v);
    for (let i = 0; i < 2000; i++) {
      const entry = maybe(Math.round(rnd() * 20000) / 100);
      const row = {
        result: pick(["win", "loss", "be", "open", null, "Прибыль", "лосс"]),
        side: pick(["long", "short", "Long", "Short", null, "s", "l"]),
        entry,
        exit: maybe(Math.round(rnd() * 20000) / 100),
        stop: rnd() < 0.15 ? entry : maybe(Math.round(rnd() * 20000) / 100),
        rMultiple: maybe(Math.round((rnd() - 0.5) * 6000) / 100),
        pnl: maybe(Math.round((rnd() - 0.5) * 200000) / 100),
        fees: maybe(Math.round((rnd() - 0.5) * 2000) / 100),
        riskUsd: maybe(Math.round(rnd() * 50000) / 100),
      };
      same(client.signedR(row), server.signedR(row), `fuzz #${i} R ${JSON.stringify(row)}`);
      same(client.netPnl(row), server.netPnl(row), `fuzz #${i} net ${JSON.stringify(row)}`);
    }
  });
});
