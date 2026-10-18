import { logger } from "./logger";
import { config } from "../config";
import { telegramT } from "../i18n/ns";
import type { Lang } from "../i18n";
import { personNameFor } from "./people/latinNames";

/** Outbound request budget (a hung Telegram API call must not hold the caller forever). */
const FETCH_TIMEOUT_MS = 15_000;

function getBotToken(): string {
  return config.telegram.botToken;
}

/** A callback button (handled in routes/telegram.ts) or a URL button (opens the site). */
export type InlineButton = { text: string; callback_data: string; url?: never } | { text: string; url: string; callback_data?: never };
export type InlineKeyboard = InlineButton[][];

export interface SendOptions {
  parse_mode?: "HTML" | "MarkdownV2";
  reply_markup?: { inline_keyboard: InlineKeyboard };
  disable_web_page_preview?: boolean;
}

async function tgPost(method: string, body: object): Promise<{ ok: boolean; description?: string; result?: unknown } | null> {
  const token = getBotToken();
  if (!token) {
    logger.warn({ method }, "Telegram: BOT_TOKEN not configured");
    return null;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const data = await res.json() as { ok: boolean; description?: string; result?: unknown };
    if (!data.ok) {
      logger.warn({ method, description: data.description }, "Telegram API error");
    }
    return data;
  } catch (e: any) {
    logger.warn({ method, error: e.message }, "Telegram request failed");
    return null;
  }
}

/** Resolves true when Telegram accepted the message (callers that don't care may ignore it). */
export async function sendMessage(chatId: string | number, text: string, opts: SendOptions = {}): Promise<boolean> {
  const res = await tgPost("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: opts.parse_mode ?? "HTML",
    disable_web_page_preview: opts.disable_web_page_preview ?? true,
    ...(opts.reply_markup ? { reply_markup: opts.reply_markup } : {}),
  });
  return !!res?.ok;
}

export async function sendMediaGroup(chatId: string | number, photoUrls: string[]): Promise<void> {
  if (!photoUrls.length) return;
  const media = photoUrls.slice(0, 10).map((url) => ({
    type: "photo",
    media: url,
  }));
  await tgPost("sendMediaGroup", {
    chat_id: chatId,
    media,
  });
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  await tgPost("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text ?? "",
  });
}

export async function editMessage(chatId: string | number, messageId: number, text: string, opts: SendOptions = {}): Promise<void> {
  await tgPost("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: opts.parse_mode ?? "HTML",
    disable_web_page_preview: opts.disable_web_page_preview ?? true,
    ...(opts.reply_markup ? { reply_markup: opts.reply_markup } : {}),
  });
}

export async function registerWebhook(webhookUrl: string, secretToken?: string): Promise<boolean> {
  const token = getBotToken();
  if (!token) {
    logger.warn("Telegram: cannot register webhook — BOT_TOKEN not configured");
    return false;
  }
  const body: Record<string, unknown> = {
    url: webhookUrl,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  };
  if (secretToken) body["secret_token"] = secretToken;
  const data = await tgPost("setWebhook", body);
  if (data?.ok) {
    logger.info({ webhookUrl }, "Telegram webhook registered");
    return true;
  }
  return false;
}

export function escHtml(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const QUALITY_EMOJI: Record<string, string> = {
  "A+": "🏆", "A": "⭐", "B+": "🔵", "B": "🔷", "C": "🔶", "D": "🔴",
};

/** Parse newline-separated screenshot URLs into a clean array. */
export function parseScreenshotUrls(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw.split("\n").map((u) => u.trim()).filter(Boolean);
}

export function buildIdeaHtml(idea: {
  id: number; ticker: string; side?: string | null; setup?: string | null;
  thesis?: string | null; entryZone?: string | null; target?: string | null;
  stop?: string | null; score?: number | null; trader?: string | null;
  screenshotUrl?: string | null; riskAmount?: string | number | null;
  setupQuality?: string | null;
}, siteUrl: string, opts?: { includeScreenshotLink?: boolean; lang?: Lang }): string {
  const t = telegramT.tFor(opts?.lang ?? "ru");
  const lines: string[] = [];
  const includeLink = opts?.includeScreenshotLink ?? true;

  // ── Trader name FIRST — most visible line ──
  lines.push(`👤 <b>${escHtml(idea.trader ? personNameFor(idea.trader, opts?.lang ?? "ru") : t("idea.unknownTrader"))}</b>`);
  lines.push("");

  // Screenshot link — Telegram previews the FIRST link in the message
  // Only include when not already sending as a media group
  const urls = parseScreenshotUrls(idea.screenshotUrl);
  if (includeLink && urls.length === 1) {
    lines.push(`📸 <a href="${escHtml(urls[0]!)}">${t("idea.screenshot")}</a>`);
    lines.push("");
  }

  lines.push(`📋 <b>Trade Idea #${idea.id} — ${escHtml(idea.ticker)}</b>`);

  const parts: string[] = [];
  if (idea.side) parts.push(`<b>${escHtml(idea.side)}</b>`);
  if (idea.setup) parts.push(escHtml(idea.setup));
  if (parts.length) lines.push(parts.join(" | "));

  if (idea.entryZone) lines.push(`📍 <b>${t("idea.entry")}:</b> ${escHtml(idea.entryZone)}`);
  if (idea.target) lines.push(`🎯 <b>${t("idea.target")}:</b> ${escHtml(idea.target)}`);
  if (idea.stop) lines.push(`🛑 <b>${t("idea.stop")}:</b> ${escHtml(idea.stop)}`);

  const extras: string[] = [];
  if (idea.setupQuality) {
    const emoji = QUALITY_EMOJI[idea.setupQuality] ?? "";
    extras.push(`Quality: <b>${emoji} ${escHtml(idea.setupQuality)}</b>`);
  }
  if (idea.riskAmount != null && idea.riskAmount !== "") {
    extras.push(`Risk: <b>$${Number(idea.riskAmount).toFixed(0)}</b>`);
  }
  if (idea.score != null) extras.push(`Score: <b>${idea.score}/100</b>`);
  if (extras.length) lines.push(extras.join(" · "));

  if (idea.thesis) {
    const t = idea.thesis.slice(0, 500);
    lines.push(`\n<i>${escHtml(t)}${idea.thesis.length > 500 ? "…" : ""}</i>`);
  }

  lines.push(`\n🔗 <a href="${siteUrl}/trade-ideas">${t("idea.open")}</a>`);
  return lines.join("\n");
}

/** Inline keyboard for curators/risk reviewing an idea */
export function buildIdeaKeyboard(ideaId: number, lang: Lang = "ru"): InlineKeyboard {
  const t = telegramT.tFor(lang);
  return [
    [
      { text: t("button.approve"), callback_data: `approve:${ideaId}` },
      { text: t("button.reject"), callback_data: `reject:${ideaId}` },
      { text: t("button.needsWork"), callback_data: `needs_work:${ideaId}` },
    ],
    [
      { text: t("button.commentPublic"), callback_data: `comment_pub:${ideaId}` },
      { text: t("button.replyPrivate"), callback_data: `reply_priv:${ideaId}` },
    ],
    [
      { text: t("button.openIdea"), callback_data: `open_idea:${ideaId}` },
    ],
  ];
}

/** Inline keyboard for traders — lets them reply back to curator/risk */
export function buildTraderReplyKeyboard(ideaId: number, lang: Lang = "ru"): InlineKeyboard {
  return [
    [
      { text: telegramT.tFor(lang)("button.replyStaff"), callback_data: `trader_reply:${ideaId}` },
    ],
  ];
}

/** Main menu keyboard for curators/admins */
export function buildMainMenuKeyboard(lang: Lang = "ru"): InlineKeyboard {
  const t = telegramT.tFor(lang);
  return [
    [
      { text: t("button.today"), callback_data: "menu:today" },
      { text: t("button.recent"), callback_data: "menu:recent" },
    ],
    [
      { text: t("button.byTrader"), callback_data: "menu:traders" },
    ],
  ];
}

export async function sendIdeaNotification(
  chatId: string,
  idea: Parameters<typeof buildIdeaHtml>[0],
  siteUrl: string,
  lang: Lang = "ru",
): Promise<void> {
  const urls = parseScreenshotUrls(idea.screenshotUrl);

  if (urls.length >= 2) {
    // Send all screenshots as a media group first, then text+keyboard separately
    await sendMediaGroup(chatId, urls);
    const text = buildIdeaHtml(idea, siteUrl, { includeScreenshotLink: false, lang });
    await sendMessage(chatId, text, {
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: buildIdeaKeyboard(idea.id, lang) },
    });
  } else {
    // Single screenshot or no screenshot — original behaviour (inline link preview)
    const text = buildIdeaHtml(idea, siteUrl, { includeScreenshotLink: true, lang });
    await sendMessage(chatId, text, {
      disable_web_page_preview: urls.length === 0,
      reply_markup: { inline_keyboard: buildIdeaKeyboard(idea.id, lang) },
    });
  }
}
