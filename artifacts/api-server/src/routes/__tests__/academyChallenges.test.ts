/**
 * GET /academy/challenges(/:id) are read-only: they evaluate on the fly and never persist a status or send a notice
 * (also not for a client-supplied `date`). The write path is refreshChallenges() — PropReports sync hook + cron —
 * which caches the transition and notifies once. The DB, auth and notifications are mocked: the tests read the SQL.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { TEMPLATES } from "../../lib/challengeEngine";

type Q = { sql: string; params: unknown[] };
const calls: Q[] = [];
const tpl = TEMPLATES[0]!;
// Ended long ago with no trades → evaluates to a terminal status; DB still says "active", nothing notified yet.
const row = () => ({
  id: 5, user_name: "Максим Р.", template_key: tpl.key, name: "Экзамен", rules: tpl.rules, starts_on: "2026-01-05", ends_on: "2026-01-30",
  status: "active", comment: null, created_by: "Антон", created_at: new Date("2026-01-01"), archived_at: null, notified_status: null as string | null,
});
let current = row();

vi.mock("@workspace/db", () => ({
  db: {},
  pool: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/to_regclass/.test(sql)) return { rows: [{ ok: "trade_executions" }], rowCount: 1 };
      if (/FROM academy_challenges/.test(sql) && /^\s*SELECT/.test(sql)) return { rows: [current], rowCount: 1 };
      if (/^\s*UPDATE academy_challenges SET notified_status/.test(sql)) {
        if (current.notified_status === params[1]) return { rows: [], rowCount: 0 };
        current = { ...current, notified_status: params[1] as string };
        return { rows: [{ id: 5 }], rowCount: 1 };
      }
      if (/^\s*UPDATE academy_challenges SET status/.test(sql)) { current = { ...current, status: params[1] as string }; return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    }),
  },
}));
vi.mock("@workspace/integrations-anthropic-ai", () => ({ anthropic: {}, getAnthropic: () => ({}), isAnthropicConfigured: () => false, AnthropicNotConfiguredError: class extends Error {} }));
const notifyUser = vi.fn(async () => 1);
const notifyUsers = vi.fn(async () => undefined);
vi.mock("../../lib/notifyUtils", () => ({ notifyUser, notifyUsers, assignedStaffOf: vi.fn(async () => ["Антон"]) }));
vi.mock("../../lib/audit", () => ({ logAudit: vi.fn(async () => undefined) }));
vi.mock("../../lib/auth", async (orig) => ({
  ...(await orig<typeof import("../../lib/auth")>()),
  isGuest: () => false,
  requireMember: () => true,
  viewerRole: vi.fn(async () => "trader"),
  scopeTrader: vi.fn(async () => "Максим Р."),
}));

process.env.JWT_SECRET ??= "vitest-only-secret";
const { default: router, refreshChallenges } = await import("../academy-path");

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
beforeEach(() => { calls.length = 0; current = row(); notifyUser.mockClear(); notifyUsers.mockClear(); });

// ensureTables() seeds its catalog once (schema setup) — only writes to challenges count.
const writes = () => calls.filter((c) => /^\s*(UPDATE|INSERT|DELETE)\b[^;]*academy_challenges/i.test(c.sql));

describe("academy challenges: GET is read-only", () => {
  it("list evaluates the terminal status but writes nothing and notifies nobody", async () => {
    const r = await fetch(`${base}/academy/challenges`);
    expect(r.status).toBe(200);
    const body = await r.json() as { challenges: { result: { status: string } }[] };
    expect(["failed", "expired"]).toContain(body.challenges[0]!.result.status);
    expect(writes()).toEqual([]);
    expect(notifyUser).not.toHaveBeenCalled();
    expect(notifyUsers).not.toHaveBeenCalled();
  });

  it("detail with a client-supplied future date writes nothing either", async () => {
    const r = await fetch(`${base}/academy/challenges/5?date=2099-01-01`);
    expect(r.status).toBe(200);
    expect(writes()).toEqual([]);
    expect(notifyUser).not.toHaveBeenCalled();
  });
});

describe("refreshChallenges (sync hook / cron)", () => {
  it("persists the transition and notifies trader + mentors once", async () => {
    const out = await refreshChallenges(["Максим Р."]);
    expect(out).toEqual({ checked: 1, changed: 1 });
    expect(writes().some((c) => /SET status = \$2/.test(c.sql))).toBe(true);
    expect(notifyUser).toHaveBeenCalledTimes(1);
    expect(notifyUsers).toHaveBeenCalledTimes(1);
    // second run: already terminal + notified → no new notice
    notifyUser.mockClear();
    await refreshChallenges();
    expect(notifyUser).not.toHaveBeenCalled();
  });
});
