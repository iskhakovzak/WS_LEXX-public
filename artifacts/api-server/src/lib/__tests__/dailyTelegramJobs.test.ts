/**
 * Daily loop Telegram jobs: they skip when the bot is not configured (and in development), the registry knows them,
 * and contract alerts / evening cards are sent once per trader+kind+day — also after a «restart» (markers live in
 * the DB, here an in-memory notification_dedup). lib/telegramBot is mocked: nothing goes to Telegram.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EveningCard } from "../daily/types";

const dedup = new Set<string>();
const recipients = [{ name: "Кирилл Б.", chat_id: "111", locale: "ru" }, { name: "Ольга Н.", chat_id: "222", locale: "en" }];

vi.mock("@workspace/db", () => ({
  db: {},
  pool: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/FROM users u/.test(sql)) {
        const names = params[0] as string[] | null;
        const rows = recipients.filter((r) => !names || names.includes(r.name));
        return { rows, rowCount: rows.length };
      }
      if (/SELECT key FROM notification_dedup/.test(sql)) {
        const keys = (params[0] as string[]).filter((k) => dedup.has(k));
        return { rows: keys.map((key) => ({ key })), rowCount: keys.length };
      }
      if (/DELETE FROM notification_dedup/.test(sql)) { dedup.delete(String(params[0])); return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 }; // holiday_calendar, trader_plans
    }),
  },
}));
vi.mock("../notifyEvents", () => ({
  claimOnce: vi.fn(async (key: string) => { if (dedup.has(key)) return false; dedup.add(key); return true; }),
}));
const tg = vi.hoisted(() => ({ sendMessage: vi.fn(async (): Promise<boolean> => true) }));
vi.mock("../telegramBot", async (orig) => ({ ...(await orig<typeof import("../telegramBot")>()), ...tg }));
const guard = vi.hoisted(() => ({ on: true, sync: true }));
vi.mock("../daily/telegramGuard", () => ({
  dailyTelegramEnabled: () => guard.on,
  intradayAlertsEnabled: () => guard.on && guard.sync,
}));
const card = (trader: string): EveningCard => ({
  trader, date: "2026-10-16", trades: 3, netPnl: 120, focus: null, tradeToReview: null, deskSameTicker: null, contract: null, reviewed: false, reviewNote: null,
});
const svc = vi.hoisted(() => ({
  focusFor: vi.fn(async (trader: string, date: string) => ({ trader, date, mistake: null, window: { from: date, to: date }, costNet: null, count: 0, source: "none" as const, text: { key: "focus.none", params: { days: 10 } } })),
  eveningFor: vi.fn(async (_t: string, _d: string): Promise<EveningCard | null> => null),
  markReviewed: vi.fn(async () => undefined),
}));
vi.mock("../daily/service", () => svc);

const jobs = await import("../daily/telegramJobs");

// Friday 2026-10-16 in New York: 10:00 (session), 08:45 (premarket), 16:30 (after the close).
const AT = { session: new Date("2026-10-16T14:00:00Z"), morning: new Date("2026-10-16T12:45:00Z"), evening: new Date("2026-10-16T20:30:00Z"), saturday: new Date("2026-10-17T14:00:00Z") };
const breach = { trader: "Кирилл Б.", kind: "max_loss" as const, limit: 300, actual: -310 };

beforeEach(() => {
  dedup.clear();
  vi.clearAllMocks();
  guard.on = true;
  guard.sync = true;
  tg.sendMessage.mockImplementation(async () => true);
  svc.eveningFor.mockImplementation(async () => null);
});

describe("guards", () => {
  it("every job skips without sending when the bot is not configured", async () => {
    guard.on = false;
    const check = vi.fn(async () => [breach]);
    expect(await jobs.runMorningFocus({ now: AT.morning })).toMatchObject({ skipped: expect.any(String) });
    expect(await jobs.runEveningCards({ now: AT.evening })).toMatchObject({ skipped: expect.any(String) });
    expect(await jobs.runContractAlerts({ now: AT.session, check })).toMatchObject({ skipped: expect.any(String) });
    expect(check).not.toHaveBeenCalled();
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it("intraday alerts need the scheduled PropReports sync", async () => {
    guard.sync = false;
    const check = vi.fn(async () => [breach]);
    expect(await jobs.runContractAlerts({ now: AT.session, check })).toMatchObject({ skipped: expect.any(String) });
    expect(check).not.toHaveBeenCalled();
  });

  it("weekend, before the close, outside the session → skipped", async () => {
    expect(await jobs.runMorningFocus({ now: AT.saturday })).toMatchObject({ skipped: "market closed" });
    expect(await jobs.runEveningCards({ now: AT.session })).toMatchObject({ skipped: "before the close" });
    expect(await jobs.runContractAlerts({ now: AT.evening, check: async () => [breach] })).toMatchObject({ skipped: "outside the session" });
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it("the real guard: production AND a bot token", async () => {
    const { dailyTelegramEnabled } = await vi.importActual<typeof import("../daily/telegramGuard")>("../daily/telegramGuard");
    expect(dailyTelegramEnabled({ isProduction: true, telegram: { botToken: "123:abc" } })).toBe(true);
    expect(dailyTelegramEnabled({ isProduction: true, telegram: { botToken: " " } })).toBe(false);
    expect(dailyTelegramEnabled({ isProduction: false, telegram: { botToken: "123:abc" } })).toBe(false);
  });
});

describe("desk settings (admin → «Настройки деска»)", () => {
  it("a switch turned off skips the send; the evening waits for the configured time", async () => {
    const { __loadSettingsCache } = await import("../settings/registry");
    try {
      svc.eveningFor.mockImplementation(async (t: string) => card(t));
      __loadSettingsCache({ "telegram.morningEnabled": false, "telegram.contractAlertsEnabled": false, "telegram.eveningTime": "18:00" });
      expect(await jobs.runMorningFocus({ now: AT.morning })).toMatchObject({ skipped: "off in desk settings" });
      expect(await jobs.runContractAlerts({ now: AT.session, check: async () => [breach] })).toMatchObject({ skipped: "off in desk settings" });
      expect(await jobs.runEveningCards({ now: AT.evening })).toMatchObject({ skipped: "before the evening time" });
      expect(tg.sendMessage).not.toHaveBeenCalled();
      // 18:05 NY: the evening time passed → the cards go (a sync after the time sends them too)
      expect(await jobs.runEveningCards({ now: new Date("2026-10-16T22:05:00Z") })).toMatchObject({ sent: 2 });
      __loadSettingsCache({ "telegram.eveningEnabled": false });
      expect(await jobs.runEveningCards({ now: new Date("2026-10-16T22:10:00Z") })).toMatchObject({ skipped: "off in desk settings" });
    } finally {
      __loadSettingsCache({});
    }
  });
});

describe("once per trader + kind + day", () => {
  it("a contract alert is sent once, also across later syncs and a restart", async () => {
    const check = vi.fn(async () => [breach, { ...breach, kind: "max_trades" as const, limit: 10, actual: 11 }]);
    expect(await jobs.runContractAlerts({ now: AT.session, check })).toMatchObject({ sent: 2 });
    expect(await jobs.runContractAlerts({ now: AT.session, check })).toMatchObject({ sent: 0, dup: 2 });
    vi.resetModules(); // «restart»: fresh module state, the DB markers stay
    const again = await import("../daily/telegramJobs");
    expect(await again.runContractAlerts({ now: AT.session, check })).toMatchObject({ sent: 0, dup: 2 });
    expect(tg.sendMessage).toHaveBeenCalledTimes(2);
    expect((tg.sendMessage.mock.calls[0] as unknown[])[0]).toBe("111");
  });

  it("a send Telegram rejected is retried by the next run", async () => {
    tg.sendMessage.mockImplementationOnce(async () => false);
    const check = async () => [breach];
    expect(await jobs.runContractAlerts({ now: AT.session, check })).toMatchObject({ failed: 1 });
    expect(await jobs.runContractAlerts({ now: AT.session, check })).toMatchObject({ sent: 1 });
  });

  it("a breach of a trader without a linked / opted-in chat is skipped", async () => {
    const r = await jobs.runContractAlerts({ now: AT.session, check: async () => [{ ...breach, trader: "Нет Чата" }] });
    expect(r).toMatchObject({ skipped: 1, sent: 0 });
  });

  it("evening cards: only traders with a card, once per day; the card marker enables the buttons", async () => {
    svc.eveningFor.mockImplementation(async (t: string) => (t === "Кирилл Б." ? card(t) : null));
    expect(await jobs.runEveningCards({ now: AT.evening })).toMatchObject({ sent: 1, skipped: 1 });
    expect(await jobs.runEveningCards({ now: AT.evening })).toMatchObject({ sent: 0, dup: 1 });
    expect(dedup.has(jobs.dailyKey.card("2026-10-16", "Кирилл Б.", "111"))).toBe(true);
    const kb = (tg.sendMessage.mock.calls[0] as unknown as [string, string, { reply_markup: { inline_keyboard: { callback_data?: string }[][] } }])[2].reply_markup.inline_keyboard;
    expect(kb.flat().some((b) => b.callback_data === "daily:rev:2026-10-16")).toBe(true);
  });

  it("morning focus once per day, in each user's language", async () => {
    expect(await jobs.runMorningFocus({ now: AT.morning })).toMatchObject({ sent: 2 });
    expect(await jobs.runMorningFocus({ now: AT.morning })).toMatchObject({ sent: 0, dup: 2 });
    const [ru, en] = tg.sendMessage.mock.calls.map((c) => String((c as unknown[])[1]));
    expect(ru).not.toBe(en);
  });
});

describe("registry", () => {
  it("registers the three jobs; disabled when the bot is not configured", async () => {
    vi.resetModules();
    guard.on = false;
    const { listJobs, clearJobs, cronOf } = await import("../../jobs/registry");
    const { registerAllJobs } = await import("../../jobs/definitions");
    clearJobs();
    registerAllJobs();
    const byName = new Map(listJobs().map((j) => [j.name, j]));
    for (const n of ["telegram.daily-morning", "telegram.daily-evening", "telegram.contract-alerts"]) {
      expect(byName.has(n)).toBe(true);
      expect(byName.get(n)!.enabled?.()).toBe(false);
    }
    expect(cronOf(byName.get("telegram.daily-morning")!)).toBe("45 8 * * 1-5"); // desk-settings defaults
    expect(cronOf(byName.get("telegram.daily-evening")!)).toBe("30 16 * * 1-5");
    expect(byName.get("telegram.daily-evening")!.on).toContain("propreports.synced");
    expect(byName.get("telegram.contract-alerts")!.on).toContain("propreports.synced");
    expect(await byName.get("telegram.daily-morning")!.run({ signal: new AbortController().signal, trigger: "manual", logger: console, runId: null })).toMatchObject({ skipped: expect.any(String) });
    clearJobs();
  });
});
