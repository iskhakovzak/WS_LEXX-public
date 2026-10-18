import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { logger } from "../lib/logger";
import {
  sendMessage,
  editMessage,
  answerCallbackQuery,
  buildIdeaHtml,
  buildIdeaKeyboard,
  buildMainMenuKeyboard,
  escHtml,
  type InlineButton,
  type InlineKeyboard,
} from "../lib/telegramBot";
import {
  notifyTraderTelegram,
  notifyPublicComment,
  applyIdeaReview,
  getSiteUrl,
} from "../lib/notifyUtils";
import crypto from "crypto";
import { config } from "../config";
import { AppError, notFound, unauthorized } from "../lib/http";
import { localeOfUser, parseLang, type Lang } from "../i18n";
import { telegramT } from "../i18n/ns";
import { personNameFor } from "../lib/people/latinNames";
import { notifyUser } from "../lib/notifyUtils";
import { notifLinks } from "../lib/notificationCore";
import { handleDailyCallback } from "../lib/daily/telegramCallback";

const router: IRouter = Router();

/** Webhook secret (config.ts: required on its own in production; derived from JWT_SECRET only in development). */
export function telegramWebhookSecret(): string {
  return config.telegramWebhookSecret || "ws-lexx-tg-secret";
}

// ─── LINKING API ─────────────────────────────────────────────────────────────

router.post("/telegram/link-token", asyncHandler(async (req, res): Promise<void> => {
  const trader = req.authUser!.name;
  const token = crypto.randomBytes(3).toString("hex").toUpperCase();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await pool.query(`DELETE FROM telegram_link_tokens WHERE user_name = $1`, [trader]);
  await pool.query(
    `INSERT INTO telegram_link_tokens (token, user_name, expires_at) VALUES ($1, $2, $3)`,
    [token, trader, expiresAt],
  );

  const botUsername = config.telegram.botUsername;
  const deepLink = `https://t.me/${botUsername}?start=${token}`;
  res.json({ token, deep_link: deepLink, expires_in: 600, bot_username: botUsername });
}));

router.get("/telegram/status", asyncHandler(async (req, res): Promise<void> => {
  const requested = typeof req.query["trader"] === "string" ? req.query["trader"] : undefined;
  const viewer = req.authUser;
  if (!viewer) throw unauthorized();
  // Only staff may look up another user's Telegram link status.
  const trader = requested && requested !== viewer.name && ["curator", "admin"].includes(viewer.role ?? "")
    ? requested
    : viewer.name;
  const { rows } = await pool.query(
    `SELECT telegram_chat_id, telegram_linked_at FROM users WHERE name = $1`,
    [trader],
  );
  const row = rows[0] as { telegram_chat_id: string | null; telegram_linked_at: string | null } | undefined;
  res.json({ connected: !!(row?.telegram_chat_id), linked_at: row?.telegram_linked_at ?? null });
}));

router.delete("/telegram/disconnect", asyncHandler(async (req, res): Promise<void> => {
  const trader = req.authUser!.name;
  await pool.query(
    `UPDATE users SET telegram_chat_id = NULL, telegram_linked_at = NULL WHERE name = $1`,
    [trader],
  );
  res.json({ ok: true });
}));

// ─── WEBHOOK ─────────────────────────────────────────────────────────────────

router.post("/telegram/webhook", asyncHandler(async (req, res): Promise<void> => {
  const secretHeader = req.headers["x-telegram-bot-api-secret-token"];
  if (secretHeader !== telegramWebhookSecret()) {
    throw new AppError("FORBIDDEN");
  }
  res.json({ ok: true });
  const update = req.body as TelegramUpdate;
  handleUpdate(update).catch((e: Error) => {
    logger.warn({ error: e.message }, "Telegram webhook handler error");
  });
}));

// ─── TYPES ───────────────────────────────────────────────────────────────────

interface TgFrom { id: number; username?: string; first_name?: string; language_code?: string }

/** Language of a chat: the linked member's users.locale, else the Telegram client language, else RU. */
async function chatLang(chatId: string, from?: TgFrom): Promise<Lang> {
  const { rows } = await pool.query<{ name: string }>(`SELECT name FROM users WHERE telegram_chat_id = $1`, [chatId]).catch(() => ({ rows: [] as { name: string }[] }));
  if (rows[0]?.name) return localeOfUser(rows[0].name);
  return parseLang(from?.language_code) ?? "ru";
}
const tg = (lang: Lang) => telegramT.tFor(lang);
const idParams = (id: number, ticker: string) => ({ id, ticker: escHtml(ticker) });
interface TelegramUpdate {
  update_id: number;
  message?: { message_id: number; from: TgFrom; chat: { id: number }; text?: string };
  callback_query?: { id: string; from: TgFrom; message?: { chat: { id: number }; message_id: number }; data?: string };
}

// ─── UPDATE HANDLER ──────────────────────────────────────────────────────────

async function handleUpdate(update: TelegramUpdate): Promise<void> {
  if (update.message) await handleMessage(update.message);
  else if (update.callback_query) await handleCallbackQuery(update.callback_query);
}

async function handleMessage(msg: NonNullable<TelegramUpdate["message"]>): Promise<void> {
  const chatId = String(msg.chat.id);
  const text = (msg.text ?? "").trim();
  const chatL = await chatLang(chatId, msg.from);
  const L = tg(chatL);

  // /start TOKEN — link flow
  if (text.startsWith("/start")) {
    const token = text.slice(6).trim().toUpperCase();
    if (!token) {
      await sendMessage(chatId, L("start.hello"));
      return;
    }
    const { rows } = await pool.query(
      `SELECT user_name FROM telegram_link_tokens WHERE token = $1 AND used = FALSE AND expires_at > NOW()`,
      [token],
    );
    if (!rows[0]) {
      await sendMessage(chatId, L("start.badToken"));
      return;
    }
    const userName = (rows[0] as { user_name: string }).user_name;
    const { rows: existing } = await pool.query(
      `SELECT name FROM users WHERE telegram_chat_id = $1`,
      [chatId],
    );
    if ((existing[0] as { name: string } | undefined)?.name && (existing[0] as { name: string }).name !== userName) {
      await sendMessage(chatId, L("start.linkedElsewhere", { name: escHtml(personNameFor((existing[0] as { name: string }).name, chatL)) }));
      return;
    }
    await pool.query(
      `UPDATE users SET telegram_chat_id = $1, telegram_linked_at = NOW() WHERE name = $2`,
      [chatId, userName],
    );
    await pool.query(`UPDATE telegram_link_tokens SET used = TRUE WHERE token = $1`, [token]);
    const linkedLang = await localeOfUser(userName);
    await sendMessage(chatId, tg(linkedLang)("start.linked", { name: escHtml(personNameFor(userName, linkedLang)) }));
    logger.info({ userName, chatId }, "Telegram account linked");
    return;
  }

  // /menu or /ideas — curator/admin idea browser
  if (text === "/menu" || text === "/ideas") {
    const { rows: uRows } = await pool.query(`SELECT name, role FROM users WHERE telegram_chat_id = $1`, [chatId]);
    const u = uRows[0] as { name: string; role: string } | undefined;
    if (!u) {
      await sendMessage(chatId, L("notLinked"));
      return;
    }
    if (!["curator", "admin"].includes(u.role)) {
      await sendMessage(chatId, L("menuStaffOnly"));
      return;
    }
    await sendMessage(chatId, L("menuTitle"), {
      reply_markup: { inline_keyboard: buildMainMenuKeyboard(await localeOfUser(u.name)) },
    });
    return;
  }

  // Check for pending action (waiting for text input after button press)
  const { rows: pendingRows } = await pool.query(
    `SELECT action, idea_id FROM telegram_pending_actions WHERE telegram_chat_id = $1 AND expires_at > NOW()`,
    [chatId],
  );
  if (!pendingRows[0]) return;
  const { action, idea_id: ideaId } = pendingRows[0] as { action: string; idea_id: number };
  if (!text) return;

  await pool.query(`DELETE FROM telegram_pending_actions WHERE telegram_chat_id = $1`, [chatId]);

  const { rows: senderRows } = await pool.query(`SELECT name, role FROM users WHERE telegram_chat_id = $1`, [chatId]);
  const sender = senderRows[0] as { name: string; role: string } | undefined;
  if (!sender) return;

  const { rows: ideaRows } = await pool.query(
    `SELECT id, ticker, trader, status FROM trade_ideas WHERE id = $1`,
    [ideaId],
  );
  const idea = ideaRows[0] as { id: number; ticker: string; trader: string | null; status: string } | undefined;
  if (!idea) { await sendMessage(chatId, L("ideaNotFound")); return; }

  try {
    if (action === "comment_pub") {
      await pool.query(
        `INSERT INTO trade_idea_comments (idea_id, author_name, text, is_private, source) VALUES ($1, $2, $3, FALSE, 'telegram')`,
        [ideaId, sender.name, text],
      );
      await sendMessage(chatId, L("done.commentPublic", idParams(ideaId, idea.ticker)));
      // Fan-out to creator + curator + risk manager + prior commenters
      notifyPublicComment({
        ideaId, ticker: idea.ticker, traderName: idea.trader,
        authorName: sender.name, commentText: text, source: "telegram",
      }).catch(() => {});
    } else if (action === "reply_priv") {
      await pool.query(
        `INSERT INTO trade_idea_comments (idea_id, author_name, text, is_private, source) VALUES ($1, $2, $3, TRUE, 'telegram')`,
        [ideaId, sender.name, text],
      );
      if (idea.trader && idea.trader !== sender.name) {
        await notifyUser({
          userName: idea.trader, type: "idea_comment", ideaId, actor: sender.name, source: "telegram",
          params: { variant: "private", ticker: idea.ticker, actor: sender.name, ideaId, preview: text.slice(0, 100) },
          link: notifLinks.idea(ideaId), entityType: "idea", entityId: ideaId,
        });
      }
      await sendMessage(chatId, L("done.replyPrivate", idParams(ideaId, idea.ticker)));
      if (idea.trader) {
        const traderLang = await localeOfUser(idea.trader);
        await notifyTraderTelegram(idea.trader,
          tg(traderLang)("privateReply", { ...idParams(ideaId, idea.ticker), author: escHtml(personNameFor(sender.name, traderLang)), text: escHtml(text.slice(0, 300)) }),
          { ideaId });
      }
    } else if (action === "reject_reason") {
      const updated = await applyIdeaReview(ideaId, "rejected", text, sender.name);
      if (!updated) { await sendMessage(chatId, L("ideaNotFound")); return; }
      await sendMessage(chatId, L("done.rejected", idParams(ideaId, idea.ticker)));
    } else if (action === "needs_work_reason") {
      const updated = await applyIdeaReview(ideaId, "needs_work", text, sender.name);
      if (!updated) { await sendMessage(chatId, L("ideaNotFound")); return; }
      await sendMessage(chatId, L("done.needsWork", idParams(ideaId, idea.ticker)));
    } else if (action === "trader_reply") {
      // Trader sends a private reply to curator/risk on their own idea
      await pool.query(
        `INSERT INTO trade_idea_comments (idea_id, author_name, text, is_private, source) VALUES ($1, $2, $3, TRUE, 'telegram')`,
        [ideaId, sender.name, text],
      );
      // Notify all reviewers (curator + risk manager)
      const { rows: reviewerRows } = await pool.query(
        `SELECT assigned_curator, assigned_risk_manager, assigned_mentor FROM users WHERE name = $1`,
        [idea.trader],
      );
      const rev = reviewerRows[0] as { assigned_curator: string | null; assigned_risk_manager: string | null; assigned_mentor: string | null } | undefined;
      const reviewerNames = [...new Set([rev?.assigned_curator, rev?.assigned_risk_manager, rev?.assigned_mentor].filter(Boolean))] as string[];
      if (reviewerNames.length === 0) {
        const { rows: fallback } = await pool.query(
          `SELECT name FROM users WHERE role IN ('curator', 'admin') AND active = true AND telegram_chat_id IS NOT NULL`,
        );
        reviewerNames.push(...(fallback as { name: string }[]).map((r) => r.name));
      }
      for (const reviewerName of reviewerNames) {
        const { rows: rRows } = await pool.query(`SELECT telegram_chat_id FROM users WHERE name = $1`, [reviewerName]);
        const rChatId = rRows[0]?.telegram_chat_id as string | undefined;
        if (rChatId) {
          const rLang = await localeOfUser(reviewerName);
          await sendMessage(rChatId,
            tg(rLang)("traderReplyToStaff", { ...idParams(ideaId, idea.ticker), trader: escHtml(personNameFor(sender.name, rLang)), text: escHtml(text.slice(0, 300)) }),
            { reply_markup: { inline_keyboard: buildIdeaKeyboard(ideaId, rLang) } });
        }
        await notifyUser({
          userName: reviewerName, type: "idea_comment", ideaId, actor: sender.name, source: "telegram",
          params: { variant: "traderReply", ticker: idea.ticker, actor: sender.name, ideaId, preview: text.slice(0, 100) },
          link: notifLinks.idea(ideaId), entityType: "idea", entityId: ideaId,
        });
      }
      await sendMessage(chatId, L("done.traderReply", idParams(ideaId, idea.ticker)));
    }
  } catch (e: any) {
    logger.warn({ error: e.message, action, ideaId, sender: sender.name }, "handleMessage: action processing failed");
    await sendMessage(chatId, L("actionFailed", { error: escHtml(String(e.message ?? "").slice(0, 200)) })).catch(() => {});
  }
}

async function handleCallbackQuery(cq: NonNullable<TelegramUpdate["callback_query"]>): Promise<void> {
  const chatId = String(cq.from.id);
  const data = cq.data ?? "";
  const callbackId = cq.id;
  const lang = await chatLang(chatId, cq.from);
  const L = tg(lang);

  logger.info({ chatId, data }, "Telegram callback received");
  if (data.startsWith("daily:")) { await handleDailyCallback(cq); return; } // evening card buttons (lib/daily)

  // ── Menu navigation (non-idea callbacks) ──────────────────────────────────
  if (data.startsWith("menu:")) {
    await answerCallbackQuery(callbackId);
    await handleMenuCallback(chatId, data, cq.message, lang).catch((e: Error) => {
      logger.warn({ chatId, data, error: e.message }, "handleMenuCallback error");
    });
    return;
  }

  // ── Idea action callbacks (approve:123, reject:123, etc.) ─────────────────
  const colonIdx = data.indexOf(":");
  if (colonIdx === -1) { await answerCallbackQuery(callbackId); return; }
  const action = data.slice(0, colonIdx);
  const ideaId = Number(data.slice(colonIdx + 1));
  if (isNaN(ideaId)) { await answerCallbackQuery(callbackId, L("badFormat")); return; }

  // Answer the callback IMMEDIATELY so the button never freezes,
  // regardless of how long the DB work takes.
  await answerCallbackQuery(callbackId, telegramT.tryFor(lang, `ack.${action}`) ?? "");

  // Now do all DB work
  const { rows: senderRows } = await pool.query(`SELECT name, role FROM users WHERE telegram_chat_id = $1`, [chatId]);
  const sender = senderRows[0] as { name: string; role: string } | undefined;
  if (!sender) {
    await sendMessage(chatId, L("notLinked"));
    return;
  }

  const { rows: ideaRows } = await pool.query(
    `SELECT id, ticker, trader, status FROM trade_ideas WHERE id = $1`,
    [ideaId],
  );
  const idea = ideaRows[0] as { id: number; ticker: string; trader: string | null; status: string } | undefined;
  if (!idea) { await sendMessage(chatId, L("ideaNotFound")); return; }

  const isCuratorOrAdmin = ["curator", "admin"].includes(sender.role);

  if (action === "open_idea") {
    await sendMessage(chatId,
      buildIdeaHtml(idea as Parameters<typeof buildIdeaHtml>[0], getSiteUrl(), { lang }),
      { reply_markup: { inline_keyboard: buildIdeaKeyboard(ideaId, lang) } });
    return;
  }

  if (action === "approve") {
    if (!isCuratorOrAdmin) { await sendMessage(chatId, L("staffOnlyApprove")); return; }
    await applyIdeaReview(ideaId, "approved", null, sender.name);
    await sendMessage(chatId, L("done.approved", idParams(ideaId, idea.ticker)));
    logger.info({ ideaId, reviewer: sender.name }, "Idea approved via Telegram");
    return;
  }

  if (action === "reject") {
    if (!isCuratorOrAdmin) { await sendMessage(chatId, L("staffOnlyReject")); return; }
    await setPendingAction(chatId, "reject_reason", ideaId);
    await sendMessage(chatId, L("prompt.reject", idParams(ideaId, idea.ticker)));
    return;
  }

  if (action === "needs_work") {
    if (!isCuratorOrAdmin) { await sendMessage(chatId, L("staffOnly")); return; }
    await setPendingAction(chatId, "needs_work_reason", ideaId);
    await sendMessage(chatId, L("prompt.needsWork", idParams(ideaId, idea.ticker)));
    return;
  }

  if (action === "comment_pub") {
    await setPendingAction(chatId, "comment_pub", ideaId);
    await sendMessage(chatId, L("prompt.commentPublic", idParams(ideaId, idea.ticker)));
    return;
  }

  if (action === "reply_priv") {
    await setPendingAction(chatId, "reply_priv", ideaId);
    await sendMessage(chatId, L("prompt.replyPrivate", idParams(ideaId, idea.ticker)));
    return;
  }

  if (action === "trader_reply") {
    await setPendingAction(chatId, "trader_reply", ideaId);
    await sendMessage(chatId, L("prompt.traderReply", idParams(ideaId, idea.ticker)));
    return;
  }
}

async function setPendingAction(chatId: string, action: string, ideaId: number): Promise<void> {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await pool.query(
    `INSERT INTO telegram_pending_actions (telegram_chat_id, action, idea_id, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (telegram_chat_id)
     DO UPDATE SET action = $2, idea_id = $3, expires_at = $4, created_at = NOW()`,
    [chatId, action, ideaId, expiresAt],
  );
}

// ─── MENU HANDLER ─────────────────────────────────────────────────────────────

interface IdeaRow {
  id: number;
  ticker: string;
  side: string | null;
  status: string;
  trader?: string | null;
  published_at?: string | null;
}

function statusEmoji(status: string): string {
  const map: Record<string, string> = {
    pending: "⏳", approved: "✅", rejected: "❌", needs_work: "🔄", published: "📢",
  };
  return map[status] ?? "◻️";
}

function chunkButtons(buttons: InlineButton[], size: number): InlineKeyboard {
  const rows: InlineKeyboard = [];
  for (let i = 0; i < buttons.length; i += size) {
    rows.push(buttons.slice(i, i + size));
  }
  return rows;
}

async function handleMenuCallback(
  chatId: string,
  data: string,
  message: NonNullable<TelegramUpdate["callback_query"]>["message"],
  lang: Lang = "ru",
): Promise<void> {
  const L = tg(lang);
  const { rows: senderRows } = await pool.query(`SELECT name, role FROM users WHERE telegram_chat_id = $1`, [chatId]);
  const sender = senderRows[0] as { name: string; role: string } | undefined;
  if (!sender) { await sendMessage(chatId, L("notLinked")); return; }
  if (!["curator", "admin"].includes(sender.role)) {
    await sendMessage(chatId, L("menuStaffOnly")); return;
  }

  // Render into the existing message (edit) or send new if unavailable
  const render = async (text: string, keyboard: InlineKeyboard): Promise<void> => {
    if (message) {
      try {
        await editMessage(message.chat.id, message.message_id, text, { reply_markup: { inline_keyboard: keyboard } });
        return;
      } catch { /* fall through */ }
    }
    await sendMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  };

  const parts = data.split(":");
  const sub = parts[1] ?? "";

  // ── Main menu ──────────────────────────────────────────────────────────────
  if (sub === "main") {
    await render(L("menuTitle"), buildMainMenuKeyboard(lang));
    return;
  }

  // ── Today / Recent ────────────────────────────────────────────────────────
  if (sub === "today" || sub === "recent") {
    const isToday = sub === "today";
    const { rows } = await pool.query<IdeaRow>(
      isToday
        ? `SELECT id, ticker, side, status, trader, published_at FROM trade_ideas
           WHERE (published_at AT TIME ZONE 'America/New_York')::date = (now() AT TIME ZONE 'America/New_York')::date AND status != 'draft' AND deleted_at IS NULL
           ORDER BY published_at DESC LIMIT 15`
        : `SELECT id, ticker, side, status, trader, published_at FROM trade_ideas
           WHERE status != 'draft' AND deleted_at IS NULL
           ORDER BY published_at DESC NULLS LAST LIMIT 10`,
    );

    const header = isToday ? L("menu.today") : L("menu.recent");

    let body: string;
    if (rows.length === 0) {
      body = `\n\n${isToday ? L("menu.noneToday") : L("menu.none")}`;
    } else {
      body = "\n\n" + rows.map((r) => {
        const side = r.side ? ` ${escHtml(r.side)}` : "";
        const trader = r.trader ? ` · <b>${escHtml(personNameFor(r.trader, lang))}</b>` : "";
        return `${statusEmoji(r.status)} <code>#${r.id}</code> ${escHtml(r.ticker)}${side}${trader}`;
      }).join("\n");
    }

    const ideaBtns = chunkButtons(
      rows.map((r) => ({ text: `#${r.id} ${r.ticker}`, callback_data: `menu:idea:${r.id}` })),
      3,
    );

    await render(header + body, [...ideaBtns, [{ text: L("button.menu"), callback_data: "menu:main" }]]);
    return;
  }

  // ── Trader picker ─────────────────────────────────────────────────────────
  if (sub === "traders") {
    const { rows } = await pool.query<{ name: string }>(
      `SELECT DISTINCT trader AS name FROM trade_ideas
       WHERE trader IS NOT NULL AND status != 'draft' AND deleted_at IS NULL
       ORDER BY trader`,
    );
    const btns = chunkButtons(
      rows.map((r) => ({ text: personNameFor(r.name, lang), callback_data: `menu:trader:${r.name}` })),
      2,
    );
    await render(
      L("menu.byTrader"),
      [...btns, [{ text: L("button.menu"), callback_data: "menu:main" }]],
    );
    return;
  }

  // ── Per-trader view ───────────────────────────────────────────────────────
  if (sub === "trader") {
    const traderName = parts.slice(2).join(":");
    if (!traderName) return;

    const [{ rows: todayRows }, { rows: recentRows }] = await Promise.all([
      pool.query<IdeaRow>(
        `SELECT id, ticker, side, status, published_at FROM trade_ideas
         WHERE trader = $1 AND (published_at AT TIME ZONE 'America/New_York')::date = (now() AT TIME ZONE 'America/New_York')::date AND status != 'draft' AND deleted_at IS NULL
         ORDER BY published_at DESC LIMIT 5`,
        [traderName],
      ),
      pool.query<IdeaRow>(
        `SELECT id, ticker, side, status, published_at FROM trade_ideas
         WHERE trader = $1 AND status != 'draft' AND deleted_at IS NULL
         ORDER BY published_at DESC NULLS LAST LIMIT 7`,
        [traderName],
      ),
    ]);

    const fmtRow = (r: IdeaRow) => {
      const side = r.side ? ` ${escHtml(r.side)}` : "";
      return `  ${statusEmoji(r.status)} <code>#${r.id}</code> ${escHtml(r.ticker)}${side}`;
    };

    let body = `👤 <b>${escHtml(personNameFor(traderName, lang))}</b>\n`;
    if (todayRows.length > 0) {
      body += `\n${L("menu.todayCount", { count: todayRows.length })}\n${todayRows.map(fmtRow).join("\n")}`;
    } else {
      body += `\n${L("menu.todayNone")}`;
    }
    const todayIds = new Set(todayRows.map((r) => r.id));
    const older = recentRows.filter((r) => !todayIds.has(r.id));
    if (older.length > 0) {
      body += `\n\n${L("menu.earlier")}\n${older.map(fmtRow).join("\n")}`;
    }

    const allShown = [...todayRows, ...older].slice(0, 9);
    const ideaBtns = chunkButtons(
      allShown.map((r) => ({ text: `#${r.id} ${r.ticker}`, callback_data: `menu:idea:${r.id}` })),
      3,
    );

    await render(body, [
      ...ideaBtns,
      [
        { text: L("button.traders"), callback_data: "menu:traders" },
        { text: L("button.menu"), callback_data: "menu:main" },
      ],
    ]);
    return;
  }

  // ── Individual idea card ──────────────────────────────────────────────────
  if (sub === "idea") {
    const ideaId = Number(parts[2]);
    if (isNaN(ideaId)) return;

    const { rows } = await pool.query(
      `SELECT id, ticker, side, setup, thesis,
       entry_zone AS "entryZone", target, stop, score, trader,
       screenshot_url AS "screenshotUrl", risk_amount AS "riskAmount",
       setup_quality AS "setupQuality"
       FROM trade_ideas WHERE id = $1 AND deleted_at IS NULL`,
      [ideaId],
    );
    const idea = rows[0] as Parameters<typeof buildIdeaHtml>[0] | undefined;
    if (!idea) { await sendMessage(chatId, L("ideaNotFound")); return; }
    // Send as a new message so the menu message stays intact
    await sendMessage(chatId, buildIdeaHtml(idea, getSiteUrl(), { lang }), {
      disable_web_page_preview: !idea.screenshotUrl,
      reply_markup: { inline_keyboard: buildIdeaKeyboard(ideaId, lang) },
    });
    return;
  }
}

// ─── ADMIN: FORCE DISCONNECT + BROADCAST ─────────────────────────────────────

router.delete("/telegram/admin/disconnect/:name", asyncHandler(async (req, res): Promise<void> => {
  const viewer = req.authUser;
  if (!viewer || !["curator", "admin"].includes(viewer.role ?? "")) {
    throw new AppError("STAFF_ONLY");
  }
  const { name } = req.params;
  const { rowCount } = await pool.query(
    `UPDATE users SET telegram_chat_id = NULL, telegram_linked_at = NULL WHERE name = $1`,
    [name],
  );
  if (!rowCount) throw notFound("USER_NOT_FOUND");
  logger.info({ admin: viewer.name, target: name }, "Admin force-disconnected Telegram");
  res.json({ ok: true, updated: rowCount ?? 0 });
}));

router.post("/telegram/broadcast", asyncHandler(async (req, res): Promise<void> => {
  const viewer = req.authUser;
  if (!viewer || !["curator", "admin"].includes(viewer.role ?? "")) {
    throw new AppError("STAFF_ONLY");
  }
  const { message } = req.body as { message?: string };
  if (!message || typeof message !== "string" || !message.trim()) {
    throw new AppError("VALIDATION");
  }
  const text = message.trim().slice(0, 4000);
  const { rows } = await pool.query<{ name: string; telegram_chat_id: string }>(
    `SELECT name, telegram_chat_id FROM users WHERE telegram_chat_id IS NOT NULL AND telegram_chat_id != ''`
  );
  let sent = 0;
  let failed = 0;
  for (const user of rows) {
    try {
      await sendMessage(user.telegram_chat_id, text);
      sent++;
    } catch (e: any) {
      logger.warn({ trader: user.name, error: e.message }, "broadcast send failed");
      failed++;
    }
  }
  logger.info({ admin: viewer.name, sent, failed, total: rows.length }, "Telegram broadcast sent");
  res.json({ ok: true, sent, failed, total: rows.length });
}));

// ─── ADMIN: USER ASSIGNMENTS ─────────────────────────────────────────────────

router.get("/telegram/assignments", asyncHandler(async (req, res): Promise<void> => {
  const viewer = req.authUser;
  if (!viewer || !["curator", "admin"].includes(viewer.role ?? "")) {
    throw new AppError("STAFF_ONLY");
  }
  const { rows } = await pool.query(
    `SELECT name, role, active, telegram_chat_id, telegram_linked_at, assigned_curator, assigned_risk_manager, assigned_mentor
     FROM users WHERE active = true ORDER BY role, name`,
  );
  res.json(rows);
}));

router.patch("/telegram/assignments/:name", asyncHandler(async (req, res): Promise<void> => {
  const viewer = req.authUser;
  if (!viewer || !["curator", "admin"].includes(viewer.role ?? "")) {
    throw new AppError("STAFF_ONLY");
  }
  const { name } = req.params;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const clean = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const assigned = [clean(body.assigned_curator), clean(body.assigned_risk_manager), clean(body.assigned_mentor)];
  const named = [...new Set(assigned.filter((v): v is string => !!v))];
  if (named.length) {
    const { rows: staff } = await pool.query<{ name: string }>(
      `SELECT name FROM users WHERE name = ANY($1::text[]) AND role IN ('curator', 'admin') AND active = true`,
      [named],
    );
    if (staff.length !== named.length) throw new AppError("ASSIGNEE_NOT_STAFF");
  }
  const { rowCount } = await pool.query(
    `UPDATE users SET assigned_curator = $1, assigned_risk_manager = $2, assigned_mentor = $3 WHERE name = $4`,
    [...assigned, name],
  );
  if (!rowCount) throw notFound("USER_NOT_FOUND");
  res.json({ ok: true });
}));

export default router;
