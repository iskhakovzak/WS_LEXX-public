/**
 * SQL builders vs JS: the same fixture rows through signedRSql / netPnlSql / resultSql / decidedSql / closedSql
 * / closeDateSql / horizonSql over a VALUES(...) CTE aliased `t`. Read-only SELECTs, no tables touched.
 * Skips cleanly when the local Postgres (TEST_DATABASE_URL, default postgresql://postgres:postgres@localhost:5432/edge_tracker_test)
 * is not reachable.
 */
import { afterAll, describe, expect, it } from "vitest";
import { closeDateSql, closedSql, decidedSql, horizonSql, netPnl, netPnlSql, normResult, num, resultSql, signedR, signedRSql } from "../tradeMath";
import { TRADE_ROWS, type FixtureRow } from "./fixtures/trade-rows";

type Pool = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

async function probe(): Promise<Pool | null> {
  try {
    const mod = await import("@workspace/db");
    const pool = mod.pool as unknown as Pool;
    await Promise.race([
      pool.query("SELECT 1"),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000)),
    ]);
    return pool;
  } catch (e) {
    console.warn(`[tradeMathSql] Postgres unavailable, SQL parity skipped: ${(e as Error).message}`);
    return null;
  }
}

const pool = await probe();

afterAll(async () => {
  await pool?.end();
});

const lit = {
  text: (v: unknown) => (v == null ? "NULL::text" : `'${String(v).replace(/'/g, "''")}'::text`),
  num: (v: unknown) => {
    const n = num(v);
    return n == null ? "NULL::numeric" : `${n}::numeric`;
  },
};

function valuesCte(rows: FixtureRow[]): string {
  const body = rows
    .map((r) => `(${r.id}, ${lit.text(r.result)}, ${lit.text(r.side)}, ${lit.num(r.entry)}, ${lit.num(r.exit)}, ${lit.num(r.stop)}, ${lit.num(r.rMultiple)}, ${lit.num(r.pnl)}, ${lit.num(r.fees)}, ${lit.num(r.riskUsd)})`)
    .join(",\n");
  return `WITH t(id, result, side, entry, exit, stop, r_multiple, pnl, fees, risk_usd) AS (VALUES\n${body}\n)`;
}

describe.skipIf(!pool)("tradeMath SQL builders ≡ JS", () => {
  it("signedRSql / netPnlSql / resultSql / decidedSql / closedSql match the JS functions row by row", async () => {
    const sql = `${valuesCte(TRADE_ROWS)}
      SELECT id, ${signedRSql()} AS r, ${netPnlSql()} AS net, ${resultSql()} AS res, ${decidedSql()} AS decided, ${closedSql()} AS closed
        FROM t ORDER BY id`;
    const { rows } = await pool!.query(sql);
    expect(rows.length).toBe(TRADE_ROWS.length);
    for (const row of TRADE_ROWS) {
      const got = rows.find((x) => Number(x.id) === row.id)!;
      const jsR = signedR(row);
      const sqlR = num(got.r);
      if (jsR == null) expect(sqlR, `#${row.id} ${row.name} R`).toBeNull();
      else expect(sqlR, `#${row.id} ${row.name} R`).toBeCloseTo(jsR, 9);
      if (row.expectR == null) expect(sqlR, `#${row.id} expected R`).toBeNull();
      else expect(sqlR, `#${row.id} expected R`).toBeCloseTo(row.expectR, 9);

      const jsNet = netPnl(row);
      const sqlNet = num(got.net);
      if (jsNet == null) expect(sqlNet, `#${row.id} net`).toBeNull();
      else expect(sqlNet, `#${row.id} net`).toBeCloseTo(jsNet, 9);

      const res = normResult(row.result);
      expect(got.res ?? null, `#${row.id} result`).toBe(res);
      expect(got.decided, `#${row.id} decided`).toBe(res === "win" || res === "loss");
      expect(got.closed, `#${row.id} closed`).toBe(res === "win" || res === "loss" || res === "be");
    }
  });

  it("Cyrillic aliases fold regardless of DB collation (LOWER() is ASCII-only under collation C)", async () => {
    const { rows } = await pool!.query(
      `WITH t(id, result) AS (VALUES (1, 'ПРИБЫЛЬ'::text), (2, 'Убыток'), (3, 'БЕЗУБЫТОК'), (4, ' Бу '), (5, 'ПРОФИТ'), (6, 'Лосс'), (7, 'OPEN'), (8, 'WIN'), (9, 'Прибыльно'))
       SELECT id, ${resultSql()} AS res, ${decidedSql()} AS decided FROM t ORDER BY id`,
    );
    expect(rows.map((r) => r.res)).toEqual(["win", "loss", "be", "be", "win", "loss", "open", "win", null]);
    expect(rows.map((r) => r.decided)).toEqual([true, true, false, false, true, true, false, true, false]);
  });

  it("GREATEST/LEAST NULL guard: open and unknown rows stay NULL (never 20)", async () => {
    const { rows } = await pool!.query(
      `WITH t(id, result, side, entry, exit, stop, r_multiple, pnl, fees, risk_usd) AS (VALUES
         (1, 'open'::text, 'long'::text, 10::numeric, 11::numeric, 9::numeric, 1::numeric, 100::numeric, 0::numeric, 50::numeric),
         (2, 'win'::text, NULL::text, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric))
       SELECT id, ${signedRSql()} AS r FROM t ORDER BY id`,
    );
    expect(rows.map((r) => r.r)).toEqual([null, null]);
  });

  it("closeDateSql / horizonSql: exit date wins, blanks fall back", async () => {
    const { rows } = await pool!.query(
      `WITH t(id, date, exit_date, horizon) AS (VALUES
         (1, '2026-03-02'::text, NULL::text, NULL::text),
         (2, '2026-03-02'::text, ''::text, ''::text),
         (3, '2026-03-02'::text, '2026-03-05'::text, 'swing'::text),
         (4, '2026-03-02'::text, '2026-03-03'::text, 'overnight'::text))
       SELECT id, ${closeDateSql()} AS close_date, ${horizonSql()} AS horizon FROM t ORDER BY id`,
    );
    expect(rows.map((r) => [r.close_date, r.horizon])).toEqual([
      ["2026-03-02", "intraday"],
      ["2026-03-02", "intraday"],
      ["2026-03-05", "swing"],
      ["2026-03-03", "overnight"],
    ]);
  });

  it("custom alias is honoured", async () => {
    const { rows } = await pool!.query(
      `WITH x(result, side, entry, exit, stop, r_multiple, pnl, fees, risk_usd) AS (VALUES ('win'::text, 'short'::text, 10::numeric, 8::numeric, 11::numeric, NULL::numeric, 200::numeric, -4::numeric, NULL::numeric))
       SELECT ${signedRSql("x")} AS r, ${netPnlSql("x")} AS net FROM x`,
    );
    expect(num(rows[0].r)).toBeCloseTo(2, 9);
    expect(num(rows[0].net)).toBe(196);
  });
});
