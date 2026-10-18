/**
 * GET /rule-violations: `tradeIds` filter, `offset` pagination and the `paged=1` envelope; without them the
 * response stays the plain array (old behaviour). DB / permissions mocked — the test reads the SQL params.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

const calls: { sql: string; params: unknown[] }[] = [];
let rowCount = 0;
const vrow = (id: number) => ({ id, trader: "Максим Р.", rule_id: 1, trade_id: 100 + id, kind: "max_loss", message: "m", occurred_at: new Date("2026-10-14T15:00:00Z"), day: "2026-10-14" });

vi.mock("@workspace/db", () => ({
  db: {},
  pool: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/FROM rule_violations v/.test(sql)) {
        const rows = Array.from({ length: rowCount }, (_, i) => vrow(i + 1));
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    }),
  },
}));
vi.mock("@workspace/integrations-anthropic-ai", () => ({ anthropic: {}, getAnthropic: () => ({}), isAnthropicConfigured: () => false, AnthropicNotConfiguredError: class extends Error {} }));
vi.mock("../../lib/rulesEngine", async (orig) => ({ ...(await orig<typeof import("../../lib/rulesEngine")>()), ensureRulesSchema: vi.fn(async () => undefined) }));
vi.mock("../../lib/permissions", async (orig) => ({ ...(await orig<typeof import("../../lib/permissions")>()), can: vi.fn(async () => false) }));

process.env.JWT_SECRET ??= "vitest-only-secret";
const { default: router } = await import("../rules");

let server: http.Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as unknown as { authUser: unknown }).authUser = { id: 135, name: "Максим Р.", role: "trader" }; next(); });
  app.use(router);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { calls.length = 0; rowCount = 0; });

const lastViolationQuery = () => calls.filter((c) => /FROM rule_violations v/.test(c.sql)).at(-1)!;

describe("GET /rule-violations params", () => {
  it("default: plain array, LIMIT 200, no OFFSET", async () => {
    rowCount = 2;
    const body = await (await fetch(`${base}/rule-violations`)).json();
    expect(Array.isArray(body)).toBe(true);
    const q = lastViolationQuery();
    expect(q.sql).not.toMatch(/OFFSET/);
    expect(q.params.at(-1)).toBe(200);
  });

  it("tradeIds → trade_id = ANY(int[]) with deduped valid ids", async () => {
    await fetch(`${base}/rule-violations?tradeIds=5,7,x,5,-1`);
    const q = lastViolationQuery();
    expect(q.sql).toMatch(/v\.trade_id = ANY\(\$\d+::int\[\]\)/);
    expect(q.params).toContainEqual([5, 7]);
  });

  it("paged=1: fetches limit+1, returns { items, nextOffset }", async () => {
    rowCount = 3; // limit 2 + 1 extra → more pages
    const body = await (await fetch(`${base}/rule-violations?paged=1&limit=2&offset=4`)).json() as { items: unknown[]; nextOffset: number | null };
    expect(body.items).toHaveLength(2);
    expect(body.nextOffset).toBe(6);
    const q = lastViolationQuery();
    expect(q.sql).toMatch(/LIMIT \$\d+ OFFSET \$\d+$/);
    expect(q.params.slice(-2)).toEqual([3, 4]);

    rowCount = 1;
    const last = await (await fetch(`${base}/rule-violations?paged=1&limit=2&offset=6`)).json() as { nextOffset: number | null };
    expect(last.nextOffset).toBeNull();
  });
});
