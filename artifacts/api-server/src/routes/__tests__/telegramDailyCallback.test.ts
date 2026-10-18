/** The bot webhook hands every `daily:*` callback to lib/daily/telegramCallback (and nothing else does). */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("@workspace/db", () => ({ db: {}, pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } }));
const daily = vi.hoisted(() => ({ handleDailyCallback: vi.fn(async () => "done") }));
vi.mock("../../lib/daily/telegramCallback", () => daily);
const tg = vi.hoisted(() => ({ sendMessage: vi.fn(async () => true), editMessage: vi.fn(async () => undefined), answerCallbackQuery: vi.fn(async () => undefined) }));
vi.mock("../../lib/telegramBot", async (orig) => ({ ...(await orig<typeof import("../../lib/telegramBot")>()), ...tg }));
vi.mock("../../lib/notifyUtils", () => ({ notifyTraderTelegram: vi.fn(), notifyPublicComment: vi.fn(), applyIdeaReview: vi.fn(), getSiteUrl: () => "https://x", notifyUser: vi.fn() }));

const { default: router, telegramWebhookSecret } = await import("../telegram");

let server: http.Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const hook = (data: string) => fetch(`${base}/telegram/webhook`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": telegramWebhookSecret() },
  body: JSON.stringify({ update_id: 1, callback_query: { id: "cb1", from: { id: 111 }, message: { chat: { id: 111 }, message_id: 5 }, data } }),
});
const settle = () => new Promise((r) => setTimeout(r, 50));

describe("webhook → daily callbacks", () => {
  it("routes daily:rev to the daily handler", async () => {
    expect((await hook("daily:rev:2026-10-16")).status).toBe(200);
    await settle();
    expect(daily.handleDailyCallback).toHaveBeenCalledTimes(1);
    expect((daily.handleDailyCallback.mock.calls[0] as unknown[])[0]).toMatchObject({ data: "daily:rev:2026-10-16", from: { id: 111 } });
  });

  it("other callbacks never reach it", async () => {
    daily.handleDailyCallback.mockClear();
    await hook("menu:main");
    await settle();
    expect(daily.handleDailyCallback).not.toHaveBeenCalled();
  });
});
