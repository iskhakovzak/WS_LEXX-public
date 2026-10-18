/**
 * GET /propreports/runs: staff (propreports.read.team) see the desk history; a trader only the runs they started.
 * DB and permissions are mocked — the test reads the SQL params the handler sends.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

const calls: { sql: string; params: unknown[] }[] = [];
let staff = false;

vi.mock("@workspace/db", () => ({
  db: {},
  pool: { query: vi.fn(async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return { rows: [], rowCount: 0 }; }) },
}));
vi.mock("@workspace/integrations-anthropic-ai", () => ({ anthropic: {}, getAnthropic: () => ({}), isAnthropicConfigured: () => false, AnthropicNotConfiguredError: class extends Error {} }));
vi.mock("../../lib/permissions", async (orig) => ({
  ...(await orig<typeof import("../../lib/permissions")>()),
  can: vi.fn(async () => staff),
}));

process.env.JWT_SECRET ??= "vitest-only-secret";
const { default: router } = await import("../propreports");

let server: http.Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { authUser: unknown }).authUser = staff ? { id: 2, name: "Антон", role: "curator" } : { id: 135, name: "Максим Р.", role: "trader" };
    next();
  });
  app.use(router);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { calls.length = 0; });

const get = () => fetch(`${base}/propreports/runs`);

describe("GET /propreports/runs", () => {
  it("trader → only own runs", async () => {
    staff = false;
    expect((await get()).status).toBe(200);
    const q = calls.find((c) => /FROM propreports_sync_runs/.test(c.sql))!;
    expect(q.params[1]).toBe("Максим Р.");
  });
  it("staff → whole desk", async () => {
    staff = true;
    expect((await get()).status).toBe(200);
    const q = calls.find((c) => /FROM propreports_sync_runs/.test(c.sql))!;
    expect(q.params[1]).toBeNull();
  });
});
