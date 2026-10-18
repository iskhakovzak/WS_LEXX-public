import { beforeEach, describe, expect, it, vi } from "vitest";

type Q = { sql: string; params: unknown[] };
const calls: Q[] = [];
const byFingerprint = new Map<string, { id: number; count: number; resolved: boolean }>();
let nextId = 1;

vi.mock("@workspace/db", () => ({
  db: {},
  pool: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/INSERT INTO app_errors/.test(sql)) {
        const fp = String(params[0]);
        const prev = byFingerprint.get(fp);
        if (!prev) {
          const row = { id: nextId++, count: 1, resolved: false };
          byFingerprint.set(fp, row);
          return { rows: [{ id: String(row.id), count: 1, inserted: true, reopened: false }], rowCount: 1 };
        }
        const reopened = prev.resolved;
        prev.count += 1;
        prev.resolved = false;
        return { rows: [{ id: String(prev.id), count: prev.count, inserted: false, reopened }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  },
}));

const {
  scrub, fingerprintOf, sanitizeEvent, recordError, takeAlertBudget, alertsEnabled, normalizeRoute, messageShape, topFrame, alertText,
} = await import("../errorTracking");

beforeEach(() => { calls.length = 0; byFingerprint.clear(); nextId = 1; });

describe("scrub", () => {
  it("removes tokens, secrets, e-mails, PIN-like digit runs and query strings", () => {
    const out = scrub(
      'Bearer abc.def.ghi failed for eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjF9.c2lnbmF0dXJl password=hunter2 {"pin":"123456"} ' +
      "mail me@x.io /api/voice-notes/3/audio?media_token=1.abc https://site/x?access_token=zzz",
    );
    expect(out).not.toMatch(/hunter2|123456|me@x\.io|abc\.def|eyJ|media_token=1|access_token=zzz/);
    expect(out).toContain("[redacted]");
    expect(out).toContain("/api/voice-notes/3/audio");
  });
});

describe("fingerprint", () => {
  const base = { source: "server" as const, kind: "TypeError", stack: "TypeError: x\n    at handler (/app/dist/index.mjs:10:5)" };
  it("groups messages that differ only in ids/numbers/quoted values", () => {
    const a = fingerprintOf({ ...base, message: "trade 41 not found", route: "GET /api/trades/41" });
    const b = fingerprintOf({ ...base, message: "trade 42 not found", route: "GET /api/trades/42" });
    expect(a).toBe(b);
  });
  it("separates different routes, kinds and sources", () => {
    const a = fingerprintOf({ ...base, message: "boom", route: "GET /api/trades" });
    expect(fingerprintOf({ ...base, message: "boom", route: "GET /api/events" })).not.toBe(a);
    expect(fingerprintOf({ ...base, kind: "RangeError", message: "boom", route: "GET /api/trades" })).not.toBe(a);
    expect(fingerprintOf({ ...base, source: "client", message: "boom", route: "GET /api/trades" })).not.toBe(a);
  });
  it("ignores line/column numbers (they move with every build)", () => {
    const s1 = "Error: x\n    at f (/app/dist/index.mjs:10:5)";
    const s2 = "Error: x\n    at f (/app/dist/index.mjs:99:1)";
    expect(topFrame(s1)).toBe(topFrame(s2));
  });
  it("helpers", () => {
    expect(normalizeRoute("/api/trades/123/reviews?x=1")).toBe("/api/trades/:n/reviews");
    expect(normalizeRoute("/api/game-plan/2026-10-17")).toBe("/api/game-plan/:date");
    expect(messageShape('user "Закир" id 5')).toBe("user <str> id <n>");
  });
});

describe("sanitizeEvent", () => {
  it("caps lengths and drops a non-positive user id", () => {
    const e = sanitizeEvent({ source: "client", kind: "x", message: "m".repeat(5000), stack: "s".repeat(20_000), userId: 0 });
    expect(e.message.length).toBeLessThanOrEqual(1001);
    expect(e.stack!.length).toBeLessThanOrEqual(8001);
    expect(e.userId).toBeNull();
  });
});

describe("recordError — dedupe by fingerprint", () => {
  it("the same error twice → one group with count 2, an occurrence row each time", async () => {
    const ev = { source: "server" as const, kind: "Error", message: "db down 7", route: "GET /api/trades/7" };
    const r1 = await recordError(ev);
    const r2 = await recordError({ ...ev, message: "db down 8", route: "GET /api/trades/8" });
    expect(r1?.isNew).toBe(true);
    expect(r2?.isNew).toBe(false);
    expect(r2?.id).toBe(r1?.id);
    expect(r2?.count).toBe(2);
    expect(calls.filter((c) => /INSERT INTO app_error_occurrences/.test(c.sql))).toHaveLength(2);
  });

  it("a resolved error that comes back is reported as reopened", async () => {
    const ev = { source: "client" as const, kind: "render:TypeError", message: "x is undefined", route: "/journal" };
    const r1 = await recordError(ev);
    byFingerprint.get(r1!.fingerprint)!.resolved = true;
    const r2 = await recordError(ev);
    expect(r2?.reopened).toBe(true);
  });

  it("never stores secrets", async () => {
    await recordError({ source: "server", kind: "Error", message: "login failed password=hunter2" });
    const insert = calls.find((c) => /INSERT INTO app_errors/.test(c.sql))!;
    expect(JSON.stringify(insert.params)).not.toContain("hunter2");
  });
});

describe("alerts", () => {
  it("only in production with a bot token", () => {
    expect(alertsEnabled({ isProduction: false, telegram: { botToken: "t" } })).toBe(false);
    expect(alertsEnabled({ isProduction: true, telegram: { botToken: "" } })).toBe(false);
    expect(alertsEnabled({ isProduction: true, telegram: { botToken: "t" } })).toBe(true);
  });
  it("hourly budget", () => {
    const times: number[] = [];
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) expect(takeAlertBudget(now, times, 3)).toBe(true);
    expect(takeAlertBudget(now + 1, times, 3)).toBe(false);
    expect(takeAlertBudget(now + 3600_001, times, 3)).toBe(true);
  });
  it("message is in the recipient's language and HTML-escaped", () => {
    const ev = { source: "server" as const, kind: "Error", message: "<b>boom</b>", route: "GET /api/x" };
    const ru = alertText(ev, { id: 3, count: 1 }, "ru", "https://ws.example");
    const en = alertText(ev, { id: 3, count: 1 }, "en", "https://ws.example");
    expect(ru).toContain("новая ошибка");
    expect(en).toContain("new server error");
    expect(en).toContain("&lt;b&gt;boom&lt;/b&gt;");
    expect(en).toContain("https://ws.example/admin?tab=errors&amp;error=3");
  });
});
