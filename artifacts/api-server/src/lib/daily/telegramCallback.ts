/**
 * Evening card buttons (routes/telegram.ts routes every `daily:*` callback here):
 *   daily:rev:<date>  «✓ Разобрал»       → markReviewed(trader, date)
 *   daily:dis:<date>  «Это не ошибка»    → markReviewed(trader, date, { dispute: true })
 * The trader is the member linked to the pressing Telegram user; the card of that date must have been sent to that
 * member in that chat (marker daily-tg:card:…), so a chat re-linked to someone else cannot close another trader's day.
 * Idempotent: the first press claims daily-tg:closed:<date>:<trader>; a repeat only answers «already» and re-renders.
 * The message is then edited into the closed state (no action buttons, the day URL stays).
 */
import { pool } from "@workspace/db";
import { config } from "../../config";
import { logger } from "../logger";
import { localeOfUser, parseLang, type Lang } from "../../i18n";
import { dailyT } from "../../i18n/ns";
import { answerCallbackQuery, editMessage } from "../telegramBot";
import { claimOnce } from "../notifyEvents";
import * as service from "./service";
import { dailyKey, existingKeys, releaseKey } from "./telegramJobs";
import { eveningMessage, isPrivateChat, parseDailyCallback, type CardState } from "./telegramText";

export type DailyCallbackQuery = {
  id: string;
  from: { id: number; language_code?: string };
  message?: { chat: { id: number }; message_id: number };
  data?: string;
};

export type DailyCallbackResult = "bad_format" | "not_linked" | "not_yours" | "failed" | "done" | "already";

export async function handleDailyCallback(cq: DailyCallbackQuery): Promise<DailyCallbackResult> {
  const fromId = String(cq.from.id);
  const parsed = parseDailyCallback(cq.data ?? "");
  const { rows } = await pool.query<{ name: string }>(`SELECT name FROM users WHERE telegram_chat_id = $1 LIMIT 1`, [fromId]);
  const trader = rows[0]?.name;
  const lang: Lang = trader ? await localeOfUser(trader) : (parseLang(cq.from.language_code) ?? "ru");
  const t = dailyT.tFor(lang);
  if (!parsed) { await answerCallbackQuery(cq.id, t("tg.ack.badFormat")); return "bad_format"; }
  if (!trader) { await answerCallbackQuery(cq.id, t("tg.ack.notLinked")); return "not_linked"; }
  const { action, date } = parsed;

  const sent = await existingKeys([dailyKey.card(date, trader, fromId)]);
  if (!sent.size) { await answerCallbackQuery(cq.id, t("tg.ack.notYours")); return "not_yours"; }

  const closedKey = dailyKey.closed(date, trader);
  const first = await claimOnce(closedKey);
  if (first) {
    try {
      await service.markReviewed(trader, date, { dispute: action === "dispute" });
    } catch (err) {
      logger.warn({ err, trader, date }, "daily-tg: markReviewed failed");
      await releaseKey(closedKey);
      await answerCallbackQuery(cq.id, t("tg.ack.failed"));
      return "failed";
    }
  }
  await answerCallbackQuery(cq.id, first ? (action === "dispute" ? t("tg.ack.disputed") : t("tg.ack.reviewed")) : t("tg.ack.already"));

  if (cq.message) {
    const card = await service.eveningFor(trader, date).catch(() => null);
    const state: CardState = first ? (action === "dispute" ? "disputed" : "reviewed") : card?.focus?.disputed ? "disputed" : "reviewed";
    const chatId = cq.message.chat.id;
    if (card) {
      const msg = eveningMessage({ lang, card, siteUrl: config.siteUrl, privateChat: isPrivateChat(chatId), state });
      await editMessage(chatId, cq.message.message_id, msg.text, { reply_markup: { inline_keyboard: msg.keyboard } });
    } else {
      await editMessage(chatId, cq.message.message_id, state === "disputed" ? t("tg.evening.closedDisputed") : t("tg.evening.closedReviewed"));
    }
  }
  logger.info({ trader, date, action, first }, "daily-tg: card closed from Telegram");
  return first ? "done" : "already";
}
