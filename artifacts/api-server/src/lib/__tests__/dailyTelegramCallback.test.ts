/**
 * Evening card buttons (daily:rev / daily:dis): linked / not linked / wrong trader (re-linked chat) / repeat press.
 * DB = a tiny in-memory users map + notification_dedup set; lib/telegramBot is mocked — nothing goes to Telegram.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EveningCard } from "../daily/types";

const users = new Map<string, string>(); // telegram_chat_id → name
const dedup = new Set<string>();

vi.mock("@workspace/db", () => ({
  db: {},
  pool: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/FROM users WHERE telegram_chat_id = \$1/.test(sql)) {
        const name = users.get(String(params[0]));
        return { rows: name ? [{ name }] : [], rowCount: name ? 1 : 0 };
      }
      if (/SELECT key FROM notification_dedup/.test(sql)) {
        const keys = (params[0] as string[]).filter((k) => dedup.has(k));
        return { rows: keys.map((key) => ({ key })), rowCount: keys.length };
      }
      if (/DELETE FROM notification_dedup/.test(sql)) { dedup.delete(String(params[0])); return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    }),
  },
}));
vi.mock("../notifyEvents", () => ({
  claimOnce: vi.fn(async (key: string) => { if (dedup.has(key)) return false; dedup.add(key); return true; }),
}));
const tg = vi.hoisted(() => ({ answerCallbackQuery: vi.fn(async () => undefined), editMessage: vi.fn(async () => undefined), sendMessage: vi.fn(async () => true) }));
vi.mock("../telegramBot", async (orig) => ({ ...(await orig<typeof import("../telegramBot")>()), ...tg }));
const svc = vi.hoisted(() => ({ markReviewed: vi.fn(async () => undefined), eveningFor: vi.fn(async (): Promise<EveningCard | null> => null) }));
vi.mock("../daily/service", () => svc);
vi.mock("../../i18n", async (orig) => ({ ...(await orig<typeof import("../../i18n")>()), localeOfUser: vi.fn(async () => "ru") }));

const { handleDailyCallback } = await import("../daily/telegramCallback");
const { dailyKey } = await import("../daily/telegramJobs");

const DATE = "2026-10-16";
const press = (fromId: number, data = `daily:rev:${DATE}`) =>
  handleDailyCallback({ id: `cb${Math.random()}`, from: { id: fromId }, message: { chat: { id: fromId }, message_id: 55 }, data });

beforeEach(() => {
  users.clear();
  dedup.clear();
  vi.clearAllMocks();
});

describe("daily:* callbacks", () => {
  it("linked trader whose card it is: marks reviewed, answers, edits to the closed state", async () => {
    users.set("111", "Кирилл Б.");
    dedup.add(dailyKey.card(DATE, "Кирилл Б.", 111));
    expect(await press(111)).toBe("done");
    expect(svc.markReviewed).toHaveBeenCalledWith("Кирилл Б.", DATE, { dispute: false });
    expect(tg.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(tg.editMessage).toHaveBeenCalledTimes(1);
    expect((tg.editMessage.mock.calls[0] as unknown[])[0]).toBe(111);
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it("dispute passes dispute: true", async () => {
    users.set("111", "Кирилл Б.");
    dedup.add(dailyKey.card(DATE, "Кирилл Б.", 111));
    expect(await press(111, `daily:dis:${DATE}`)).toBe("done");
    expect(svc.markReviewed).toHaveBeenCalledWith("Кирилл Б.", DATE, { dispute: true });
  });

  it("not linked: answers, never marks", async () => {
    expect(await press(999)).toBe("not_linked");
    expect(svc.markReviewed).not.toHaveBeenCalled();
    expect(tg.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(tg.editMessage).not.toHaveBeenCalled();
  });

  it("wrong trader: the chat is now linked to someone the card was not sent to", async () => {
    dedup.add(dailyKey.card(DATE, "Кирилл Б.", 111)); // card went to Кирилл in chat 111
    users.set("111", "Ольга Н."); // chat later re-linked
    expect(await press(111)).toBe("not_yours");
    expect(svc.markReviewed).not.toHaveBeenCalled();
    expect(tg.editMessage).not.toHaveBeenCalled();
  });

  it("repeat press is idempotent: markReviewed once, the second only answers «already»", async () => {
    users.set("111", "Кирилл Б.");
    dedup.add(dailyKey.card(DATE, "Кирилл Б.", 111));
    expect(await press(111)).toBe("done");
    expect(await press(111)).toBe("already");
    expect(await press(111, `daily:dis:${DATE}`)).toBe("already");
    expect(svc.markReviewed).toHaveBeenCalledTimes(1);
    expect(tg.answerCallbackQuery).toHaveBeenCalledTimes(3);
  });

  it("a failed markReviewed releases the claim so the next press retries", async () => {
    users.set("111", "Кирилл Б.");
    dedup.add(dailyKey.card(DATE, "Кирилл Б.", 111));
    svc.markReviewed.mockRejectedValueOnce(new Error("db down"));
    expect(await press(111)).toBe("failed");
    expect(await press(111)).toBe("done");
    expect(svc.markReviewed).toHaveBeenCalledTimes(2);
  });

  it("bad callback data", async () => {
    users.set("111", "Кирилл Б.");
    expect(await press(111, "daily:rev:yesterday")).toBe("bad_format");
    expect(svc.markReviewed).not.toHaveBeenCalled();
  });
});
