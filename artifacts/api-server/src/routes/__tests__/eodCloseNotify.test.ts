/**
 * Closing a day pings the curator once: close → reopen → close again must not send a second «День закрыт».
 * The DB is mocked as a tiny in-memory eod_days + notification_dedup; notifications are spied.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

const day = { id: 41, trader: "Максим Р.", date: "2026-10-15", closedAt: null as Date | null, discipline: 4, summary: {}, reviewedBy: null, reviewedAt: null, curatorComment: null, curatorScore: null, createdAt: new Date(), updatedAt: new Date() };
const claimed = new Set<string>();

vi.mock("@workspace/db", () => ({
  db: {},
  pool: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/INSERT INTO notification_dedup/.test(sql)) {
        const k = String(params[0]);
        if (claimed.has(k)) return { rows: [], rowCount: 0 };
        claimed.add(k);
        return { rows: [{ key: k }], rowCount: 1 };
      }
      if (/FROM eod_days d WHERE d.trader = \$1 AND d.date = \$2/.test(sql)) return { rows: [{ ...day }], rowCount: 1 };
      if (/INSERT INTO eod_days AS d/.test(sql)) return { rows: [{ ...day }], rowCount: 1 };
      if (/UPDATE eod_days d SET closed_at = NOW\(\)/.test(sql)) { day.closedAt = new Date(); return { rows: [{ ...day }], rowCount: 1 }; }
      if (/UPDATE eod_days d SET closed_at = NULL/.test(sql)) { day.closedAt = null; return { rows: [{ ...day }], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    }),
  },
}));
vi.mock("@workspace/integrations-anthropic-ai", () => ({ anthropic: {}, getAnthropic: () => ({}), isAnthropicConfigured: () => false, AnthropicNotConfiguredError: class extends Error {} }));
const notifyUsers = vi.fn(async () => undefined);
vi.mock("../../lib/notifyUtils", () => ({ notifyUser: vi.fn(async () => 1), notifyUsers, assignedStaffOf: vi.fn(async () => ["Антон"]) }));
vi.mock("../../lib/activity", () => ({ logActivity: vi.fn(async () => undefined) }));

process.env.JWT_SECRET ??= "vitest-only-secret";
const { default: router } = await import("../eod");

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

const settle = () => new Promise((r) => setTimeout(r, 30)); // inBackground runs on setImmediate
const post = (path: string) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

describe("EOD close → curator notice", () => {
  it("is sent once per day across close / reopen / close", async () => {
    expect((await post(`/eod/day/${day.date}/close`)).status).toBe(200);
    await settle();
    expect(notifyUsers).toHaveBeenCalledTimes(1);
    expect((await post(`/eod/day/${day.date}/reopen`)).status).toBe(200);
    expect((await post(`/eod/day/${day.date}/close`)).status).toBe(200);
    await settle();
    expect(notifyUsers).toHaveBeenCalledTimes(1);
  });
});
