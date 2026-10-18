import { pool } from "@workspace/db";
import { logger } from "./logger";
import { config } from "../config";
import { getLatestReview } from "./aiReview";
import { nyDate } from "./tradingDate";
import { digestT } from "../i18n/ns";
import { personNameFor } from "./people/latinNames";
import { localeOfUser, localeTagFor, type Lang } from "../i18n";

/** Outbound request budget for Telegram / Resend sends (a hung API must not stall the digest job). */
const FETCH_TIMEOUT_MS = 15_000;

export type DigestSubscription = {
  id: number;
  trader: string;
  enabled: boolean;
  channel: string;
  telegramChatId: string | null;
  email: string | null;
  sendMorning: boolean;
  sendEvening: boolean;
  tradesWindowHours: number;
  createdAt: string;
  updatedAt: string;
};

export async function getSubscription(trader: string): Promise<DigestSubscription | null> {
  const { rows } = await pool.query(
    `SELECT id, trader, enabled, channel, telegram_chat_id, email, send_morning, send_evening,
            trades_window_hours, created_at, updated_at
     FROM digest_subscriptions WHERE trader = $1`,
    [trader]
  );
  if (!rows[0]) return null;
  return rowToSub(rows[0]);
}

export async function upsertSubscription(trader: string, patch: Partial<{
  enabled: boolean;
  channel: string;
  telegramChatId: string | null;
  email: string | null;
  sendMorning: boolean;
  sendEvening: boolean;
  tradesWindowHours: number;
}>): Promise<DigestSubscription> {
  const existing = await getSubscription(trader);
  if (!existing) {
    const { rows } = await pool.query(
      `INSERT INTO digest_subscriptions (trader, enabled, channel, telegram_chat_id, email, send_morning, send_evening, trades_window_hours)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, trader, enabled, channel, telegram_chat_id, email, send_morning, send_evening, trades_window_hours, created_at, updated_at`,
      [
        trader,
        patch.enabled ?? true,
        patch.channel ?? "none",
        patch.telegramChatId ?? null,
        patch.email ?? null,
        patch.sendMorning ?? true,
        patch.sendEvening ?? true,
        patch.tradesWindowHours ?? 24,
      ]
    );
    return rowToSub(rows[0]);
  }

  const fields: string[] = [];
  const vals: unknown[] = [];
  let i = 1;

  if (patch.enabled !== undefined) { fields.push(`enabled = $${i++}`); vals.push(patch.enabled); }
  if (patch.channel !== undefined) { fields.push(`channel = $${i++}`); vals.push(patch.channel); }
  if ("telegramChatId" in patch) { fields.push(`telegram_chat_id = $${i++}`); vals.push(patch.telegramChatId ?? null); }
  if ("email" in patch) { fields.push(`email = $${i++}`); vals.push(patch.email ?? null); }
  if (patch.sendMorning !== undefined) { fields.push(`send_morning = $${i++}`); vals.push(patch.sendMorning); }
  if (patch.sendEvening !== undefined) { fields.push(`send_evening = $${i++}`); vals.push(patch.sendEvening); }
  if (patch.tradesWindowHours !== undefined) { fields.push(`trades_window_hours = $${i++}`); vals.push(patch.tradesWindowHours); }

  fields.push(`updated_at = NOW()`);
  vals.push(existing.id);

  if (fields.length === 1) return existing;

  const { rows } = await pool.query(
    `UPDATE digest_subscriptions SET ${fields.join(", ")} WHERE id = $${i}
     RETURNING id, trader, enabled, channel, telegram_chat_id, email, send_morning, send_evening, trades_window_hours, created_at, updated_at`,
    vals
  );
  return rowToSub(rows[0]);
}

function rowToSub(r: any): DigestSubscription {
  return {
    id: r.id,
    trader: r.trader,
    enabled: r.enabled,
    channel: r.channel,
    telegramChatId: r.telegram_chat_id ?? null,
    email: r.email ?? null,
    sendMorning: r.send_morning,
    sendEvening: r.send_evening,
    tradesWindowHours: r.trades_window_hours ?? 24,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

type TradeSummary = {
  id: number;
  ticker: string;
  date: string;
  side: string | null;
  result: string;
  pnl: number | null;
  rMultiple: number | null;
  setup: string | null;
  review: {
    summary: string | null;
    grade: string | null;
    riskErrors: string | null;
    alternativeExecution: string | null;
  } | null;
};

async function loadRecentTrades(trader: string, windowHours: number): Promise<TradeSummary[]> {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const { rows } = await pool.query(
    `SELECT id, ticker, date, side, result, pnl::float8 AS pnl, r_multiple::float8 AS r_multiple, setup
     FROM trades
     WHERE deleted_at IS NULL AND trader = $1
       AND (created_at >= $2 OR date >= $3)
     ORDER BY date DESC, created_at DESC
     LIMIT 20`,
    [trader, since, since.toISOString().slice(0, 10)]
  );

  const summaries: TradeSummary[] = [];
  for (const row of rows) {
    let reviewSummary: TradeSummary["review"] = null;
    try {
      const rev = await getLatestReview(row.id);
      if (rev?.sections) {
        const s = rev.sections as Record<string, unknown>;
        reviewSummary = {
          summary: typeof s.summary === "string" ? s.summary : null,
          grade: typeof s.grade === "string" ? s.grade : null,
          riskErrors: typeof s.riskErrors === "string" ? s.riskErrors : null,
          alternativeExecution: typeof s.alternativeExecution === "string" ? s.alternativeExecution : null,
        };
      }
    } catch {}
    summaries.push({
      id: row.id,
      ticker: row.ticker,
      date: row.date,
      side: row.side,
      result: row.result,
      pnl: row.pnl,
      rMultiple: row.r_multiple,
      setup: row.setup,
      review: reviewSummary,
    });
  }
  return summaries;
}

type BriefData = {
  aiSummary?: string;
  /** AI summary per reader language (routes/marketbrief caches one per language). */
  aiSummaries?: Record<string, string | null>;
  macro?: Array<{ name: string; price: number; changePct: number; kind: string }>;
  futures?: Array<{ name: string; price: number; changePct: number }>;
  sectorRotation?: Array<{ name: string; symbol: string; changePct: number; trend5d?: number }>;
  date?: string;
};

/** Returns today's brief (NY calendar date), falling back to most recent if today's not yet cached */
async function loadLatestBrief(): Promise<BriefData | null> {
  try {
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());

    // Prefer today's brief
    const { rows } = await pool.query(
      `SELECT data FROM market_open_brief_cache WHERE date = $1 ORDER BY fetched_at DESC LIMIT 1`,
      [today]
    );
    if (rows[0]) return typeof rows[0].data === "string" ? JSON.parse(rows[0].data) : rows[0].data;

    // Fallback: any cached brief (yesterday etc.)
    const { rows: fallback } = await pool.query(
      `SELECT data FROM market_open_brief_cache ORDER BY date DESC, fetched_at DESC LIMIT 1`
    );
    if (!fallback[0]) return null;
    return typeof fallback[0].data === "string" ? JSON.parse(fallback[0].data) : fallback[0].data;
  } catch {
    return null;
  }
}

/**
 * If today's market brief is missing or older than 3 hours, trigger a fresh fetch
 * by calling the API's own /api/market-brief?force=1 endpoint (no auth needed).
 */
async function refreshBriefIfStale(): Promise<void> {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());

  const { rows } = await pool.query(
    `SELECT 1 FROM market_open_brief_cache
     WHERE date = $1 AND fetched_at > NOW() - INTERVAL '3 hours' LIMIT 1`,
    [today]
  ).catch(() => ({ rows: [] as any[] }));

  if (rows.length > 0) {
    logger.info({ date: today }, "Market brief is fresh — skipping pre-digest refresh");
    return;
  }

  const port = String(config.port ?? 8080);
  try {
    logger.info({ date: today, port }, "Pre-digest: triggering market brief refresh");
    const res = await fetch(`http://localhost:${port}/api/market-brief?force=1`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) {
      logger.info({ date: today }, "Market brief refreshed successfully before digest");
    } else {
      logger.warn({ status: res.status, date: today }, "Market brief refresh returned non-OK");
    }
  } catch (e: any) {
    logger.warn({ error: e.message, date: today }, "Market brief auto-refresh failed — digest may use stale data");
  }
}

type DailyFeedRow = {
  date: string;
  market_theme: string | null;
  best_tickers: string | null;
  what_works_now: string | null;
  notes: string | null;
};

async function loadLatestDailyFeed(): Promise<DailyFeedRow | null> {
  try {
    const { rows } = await pool.query<DailyFeedRow>(
      `SELECT date, market_theme, best_tickers, what_works_now, notes
       FROM daily_feed
       WHERE deleted_at IS NULL
       ORDER BY date DESC LIMIT 1`
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

function resultEmoji(result: string): string {
  const r = result.toLowerCase();
  if (r === "win" || r === "прибыль") return "✅"; // i18n-ignore (legacy stored result value)
  if (r === "loss" || r === "убыток") return "❌"; // i18n-ignore (legacy stored result value)
  return "⚖️";
}

function fmtChange(pct: number): string {
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen).trimEnd() + "…";
}

/** The brief's AI summary in `lang` (never another language's text; older rows hold only the RU `aiSummary`). */
function briefSummary(brief: BriefData | null | undefined, lang: Lang): string | null {
  if (!brief) return null;
  if (brief.aiSummaries) return brief.aiSummaries[lang] ?? null;
  return lang === "ru" ? brief.aiSummary ?? null : null;
}

function buildBriefSection(brief: BriefData, lang: Lang): string[] {
  const t = digestT.tFor(lang);
  const lines: string[] = [];

  const summary = briefSummary(brief, lang);
  if (summary) {
    lines.push(`\n📋 *${t("brief")}*`);
    lines.push(safeMd(truncate(summary, 800)));
  }

  const keyMacro = (brief.macro ?? []).filter(m =>
    ["VIX", "DXY", "US10Y"].includes(m.name)
  );
  const keyFutures = (brief.futures ?? []).slice(0, 3);

  if (keyMacro.length > 0 || keyFutures.length > 0) {
    lines.push(`\n📊 *${t("macro")}*`);
    for (const m of keyMacro) {
      lines.push(`• ${safeMd(m.name)}: ${m.price} (${fmtChange(m.changePct)})`);
    }
    for (const f of keyFutures) {
      lines.push(`• ${safeMd(f.name)}: ${f.price} (${fmtChange(f.changePct)})`);
    }
  }

  const topSectors = (brief.sectorRotation ?? [])
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, 4);
  if (topSectors.length > 0) {
    lines.push(`\n📈 *${t("sectors")}*`);
    for (const s of topSectors) {
      lines.push(`• ${safeMd(s.symbol)} ${safeMd(s.name)}: ${fmtChange(s.changePct)}`);
    }
  }

  return lines;
}

function buildDailyFeedSection(feed: DailyFeedRow, lang: Lang): string[] {
  const t = digestT.tFor(lang);
  const lines: string[] = [];
  lines.push(`\n🎯 *${t("feed")}* (${feed.date})`);
  if (feed.market_theme) lines.push(`${t("theme")}: *${safeMd(feed.market_theme)}*`);
  if (feed.best_tickers) lines.push(`${t("tickers")}: \`${safeMd(feed.best_tickers)}\``);
  if (feed.what_works_now) lines.push(`${t("works")}: ${safeMd(feed.what_works_now)}`);
  if (feed.notes) lines.push(`${t("notes")}: ${safeMd(truncate(feed.notes, 300))}`);
  return lines;
}

/** `lang` defaults to the trader's users.locale (the digest goes to them). */
export async function buildDigest(trader: string, windowHours: number, langIn?: Lang): Promise<{
  trades: TradeSummary[];
  text: string;
  html: string;
}> {
  const [trades, brief, feed] = await Promise.all([
    loadRecentTrades(trader, windowHours),
    loadLatestBrief(),
    loadLatestDailyFeed(),
  ]);

  const lang = langIn ?? (await localeOfUser(trader));
  const t = digestT.tFor(lang);
  const now = new Date();
  const dateStr = now.toLocaleDateString(localeTagFor(lang), { day: "numeric", month: "long", year: "numeric" });
  const isEvening = now.getUTCHours() >= 12;
  const period = isEvening ? t("evening") : t("morning");

  const lines: string[] = [];
  lines.push(`📊 *${t("title", { period })}* | ${dateStr}`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);

  if (brief) {
    lines.push(...buildBriefSection(brief, lang));
    lines.push(`\n━━━━━━━━━━━━━━━━━━━━`);
  }

  if (feed) {
    lines.push(...buildDailyFeedSection(feed, lang));
    lines.push(`\n━━━━━━━━━━━━━━━━━━━━`);
  }

  if (trades.length === 0) {
    lines.push(`\n🔹 *${t("trades", { hours: windowHours })}*`);
    lines.push(`_${t("noTrades")}_`);
  } else {
    lines.push(`\n🔹 *${t("trades", { hours: windowHours })} (${trades.length})*`);
    for (let i = 0; i < trades.length; i++) {
      const tr = trades[i];
      const pnlStr = tr.pnl != null ? ` | ${tr.pnl > 0 ? "+" : ""}$${tr.pnl.toFixed(0)}` : "";
      const rStr = tr.rMultiple != null ? ` | ${tr.rMultiple > 0 ? "+" : ""}${tr.rMultiple.toFixed(2)}R` : "";
      const emoji = resultEmoji(tr.result);
      lines.push(`\n${emoji} *${safeMd(tr.ticker)}* ${tr.side ? `${safeMd(tr.side)} ` : ""}${pnlStr}${rStr}`);
      if (tr.setup) lines.push(`   Setup: ${safeMd(tr.setup)}`);
      if (tr.review?.summary) lines.push(`   💡 ${safeMd(truncate(tr.review.summary, 200))}`);
      if (tr.review?.grade) lines.push(`   ${t("grade")}: *${safeMd(tr.review.grade)}*`);
      if (tr.review?.riskErrors) lines.push(`   ⚠️ ${safeMd(tr.review.riskErrors)}`);
    }
  }

  lines.push(`\n━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`_Edge Tracker · ${now.toLocaleTimeString(localeTagFor(lang), { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}_`);

  const text = lines.join("\n");

  const html = buildHtml(period, dateStr, brief, feed, trades, windowHours, now, lang);

  return { trades, text, html };
}

function buildHtml(
  period: string,
  dateStr: string,
  brief: BriefData | null,
  feed: DailyFeedRow | null,
  trades: TradeSummary[],
  windowHours: number,
  now: Date,
  lang: Lang,
): string {
  const t = digestT.tFor(lang);
  const lines: string[] = [];
  lines.push(`<h2>📊 ${escapeHtml(t("title", { period }))} | ${escapeHtml(dateStr)}</h2>`);

  const summary = briefSummary(brief, lang);
  if (brief && (summary || brief.aiSummary)) {
    lines.push(`<h3>📋 ${escapeHtml(t("briefHtml"))}</h3>`);
    if (summary) lines.push(`<p>${escapeHtml(truncate(summary, 800))}</p>`);
    const keyMacro = (brief.macro ?? []).filter(m => ["VIX", "DXY", "US10Y"].includes(m.name));
    if (keyMacro.length > 0) {
      lines.push(`<p><b>${escapeHtml(t("macroHtml"))}:</b> ${keyMacro.map(m => `${escapeHtml(m.name)} ${m.price} (${fmtChange(m.changePct)})`).join(" &nbsp;|&nbsp; ")}</p>`);
    }
    const topSectors = (brief.sectorRotation ?? []).sort((a, b) => b.changePct - a.changePct).slice(0, 4);
    if (topSectors.length > 0) {
      lines.push(`<p><b>${escapeHtml(t("sectorsHtml"))}:</b> ${topSectors.map(s => `${escapeHtml(s.symbol)} ${fmtChange(s.changePct)}`).join(", ")}</p>`);
    }
    lines.push(`<hr>`);
  }

  if (feed) {
    lines.push(`<h3>🎯 ${escapeHtml(t("feedHtml"))} (${escapeHtml(feed.date)})</h3>`);
    if (feed.market_theme) lines.push(`<p><b>${escapeHtml(t("theme"))}:</b> ${escapeHtml(feed.market_theme)}</p>`);
    if (feed.best_tickers) lines.push(`<p><b>${escapeHtml(t("tickers"))}:</b> <code>${escapeHtml(feed.best_tickers)}</code></p>`);
    if (feed.what_works_now) lines.push(`<p><b>${escapeHtml(t("works"))}:</b> ${escapeHtml(feed.what_works_now)}</p>`);
    if (feed.notes) lines.push(`<p><b>${escapeHtml(t("notes"))}:</b> ${escapeHtml(truncate(feed.notes, 400))}</p>`);
    lines.push(`<hr>`);
  }

  lines.push(`<h3>🔹 ${escapeHtml(t("tradesHtml", { hours: windowHours }))}${trades.length > 0 ? ` (${trades.length})` : ""}</h3>`);
  if (trades.length === 0) {
    lines.push(`<p><em>${escapeHtml(t("noTrades"))}</em></p>`);
  } else {
    for (const tr of trades) {
      const pnlStr = tr.pnl != null ? ` | ${tr.pnl > 0 ? "+" : ""}$${tr.pnl.toFixed(0)}` : "";
      const rStr = tr.rMultiple != null ? ` | ${tr.rMultiple > 0 ? "+" : ""}${tr.rMultiple.toFixed(2)}R` : "";
      const emoji = resultEmoji(tr.result);
      lines.push(`<p><strong>${emoji} ${escapeHtml(tr.ticker)}</strong> ${escapeHtml(tr.side ?? "")}${pnlStr}${rStr}</p>`);
      if (tr.setup) lines.push(`<p style="margin-left:1em">Setup: ${escapeHtml(tr.setup)}</p>`);
      if (tr.review?.summary) lines.push(`<p style="margin-left:1em">💡 ${escapeHtml(truncate(tr.review.summary, 200))}</p>`);
      if (tr.review?.grade) lines.push(`<p style="margin-left:1em">${escapeHtml(t("grade"))}: <strong>${escapeHtml(tr.review.grade)}</strong></p>`);
      if (tr.review?.riskErrors) lines.push(`<p style="margin-left:1em">⚠️ ${escapeHtml(tr.review.riskErrors)}</p>`);
    }
  }

  lines.push(`<p><small>Edge Tracker · ${now.toLocaleTimeString(localeTagFor(lang), { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}</small></p>`);
  return lines.join("\n");
}

function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeMd(s: string): string {
  return s.replace(/[_*`[]/g, (c) => `\\${c}`);
}

export async function sendTelegram(chatId: string, text: string): Promise<void> {
  const token = config.telegram.botToken;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN not configured");
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  // Strip Markdown so plain text is always safe; Telegram Markdown v1 is strict
  const plainText = text
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  const body = JSON.stringify({ chat_id: chatId, text: plainText, disable_web_page_preview: true });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    logger.warn({ chatId, status: res.status, err }, "Telegram sendMessage failed");
    throw new Error(`Telegram API error ${res.status}: ${err}`);
  }
  logger.info({ chatId }, "Telegram digest sent");
}

export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  const apiKey = config.resendApiKey;
  if (!apiKey) {
    throw new Error("RESEND_API_KEY not configured");
  }
  const body = JSON.stringify({
    from: "Edge Tracker <digest@updates.edgetracker.app>",
    to: [to],
    subject,
    html,
  });
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    logger.warn({ to, status: res.status, err }, "Resend email send failed");
    throw new Error(`Resend API error ${res.status}: ${err}`);
  }
  logger.info({ to }, "Email digest sent");
}

export async function sendDigestToTrader(trader: string): Promise<{ sent: boolean; channels: string[]; errors: string[] }> {
  const sub = await getSubscription(trader);
  if (!sub || !sub.enabled || sub.channel === "none") {
    return { sent: false, channels: [], errors: [] };
  }

  const { text, html } = await buildDigest(trader, sub.tradesWindowHours);
  const now = new Date();
  const lang = await localeOfUser(trader);
  const subject = digestT.tFor(lang)("subject", { date: now.toLocaleDateString(localeTagFor(lang)), trader: personNameFor(trader, lang) });

  const channelsSent: string[] = [];
  const errors: string[] = [];

  if ((sub.channel === "telegram" || sub.channel === "both") && sub.telegramChatId) {
    try {
      await sendTelegram(sub.telegramChatId, text);
      channelsSent.push("telegram");
    } catch (e: any) {
      errors.push(`telegram: ${e.message}`);
    }
  }

  if ((sub.channel === "email" || sub.channel === "both") && sub.email) {
    try {
      await sendEmail(sub.email, subject, html);
      channelsSent.push("email");
    } catch (e: any) {
      errors.push(`email: ${e.message}`);
    }
  }

  if (errors.length > 0) {
    logger.warn({ trader, errors }, "Digest delivery partial failure");
  }

  return { sent: channelsSent.length > 0, channels: channelsSent, errors };
}

async function getAllEnabledSubscriptions(): Promise<DigestSubscription[]> {
  const { rows } = await pool.query(
    `SELECT id, trader, enabled, channel, telegram_chat_id, email, send_morning, send_evening,
            trades_window_hours, created_at, updated_at
     FROM digest_subscriptions WHERE enabled = true AND channel != 'none'`
  );
  return rows.map(rowToSub);
}

/** All users who have linked their Telegram account */
async function getLinkedTelegramUsers(): Promise<Array<{ name: string; telegram_chat_id: string }>> {
  const { rows } = await pool.query<{ name: string; telegram_chat_id: string }>(
    `SELECT name, telegram_chat_id FROM users WHERE telegram_chat_id IS NOT NULL AND telegram_chat_id != ''`
  );
  return rows;
}

let lastMorningSent: string | null = null;
let lastEveningSent: string | null = null;
// Schedule: src/jobs/definitions.ts ("digest.morning" 05:00 NY ≈ 14:00 Tashkent, "digest.evening" 14:00 NY ≈ 23:00 Tashkent).

/** Morning / evening digest, once per NY trading date (guard: activity_log digest_<period>_sent). Job registry: "digest.morning" / "digest.evening". */
export async function runDigestIfNeeded(period: "morning" | "evening"): Promise<void> {
  const today = nyDate(); // trading date (audit P1-12); matches the NY-day lookup in startDigestCron
  if (period === "morning" && lastMorningSent === today) return;
  if (period === "evening" && lastEveningSent === today) return;

  // Check DB in case in-memory state was lost on restart
  const { rows: dbCheck } = await pool.query(
    `SELECT 1 FROM activity_log WHERE action = $1
     AND (created_at AT TIME ZONE 'America/New_York')::date = $2::date LIMIT 1`,
    [`digest_${period}_sent`, today]
  ).catch(() => ({ rows: [] as any[] }));
  if (dbCheck.length > 0) {
    // Restore in-memory guard so we don't re-check DB next time
    if (period === "morning") lastMorningSent = today;
    else lastEveningSent = today;
    logger.info({ period, today }, "Digest already sent today (from DB check) — skipping");
    return;
  }

  // Mark sent in both memory and DB before async work (prevents double-send on slow build)
  if (period === "morning") lastMorningSent = today;
  else lastEveningSent = today;
  pool.query(
    `INSERT INTO activity_log (action, section, trader, details)
     VALUES ($1, 'digest', 'system', $2)`,
    [`digest_${period}_sent`, today]
  ).catch(() => {});

  // For morning digest: auto-refresh market brief so data is maximally current
  if (period === "morning") {
    await refreshBriefIfStale().catch((e: any) =>
      logger.warn({ error: e?.message }, "refreshBriefIfStale failed — continuing with cached data")
    );
  }

  // Auto Telegram digest broadcast is disabled — use the admin Broadcast panel in Settings instead.
  // To re-enable: restore the `getLinkedTelegramUsers` loop that was here.
  logger.info({ period }, "Digest cron fired — auto Telegram broadcast is disabled; only email subs will run");

  // Also handle email subscriptions (legacy path)
  let subs: DigestSubscription[];
  try {
    subs = await getAllEnabledSubscriptions();
  } catch {
    return;
  }
  const emailSubs = subs.filter((s) =>
    (s.channel === "email" || s.channel === "both") && s.email &&
    (period === "morning" ? s.sendMorning : s.sendEvening)
  );
  for (const sub of emailSubs) {
    try {
      const { html } = await buildDigest(sub.trader, sub.tradesWindowHours);
      const now = new Date();
      const subLang = await localeOfUser(sub.trader);
      const subject = digestT.tFor(subLang)("subject", { date: now.toLocaleDateString(localeTagFor(subLang)), trader: personNameFor(sub.trader, subLang) });
      await sendEmail(sub.email!, subject, html);
      logger.info({ trader: sub.trader, period }, "Email digest sent");
    } catch (e: any) {
      logger.warn({ trader: sub.trader, error: e.message }, "Email digest send failed");
    }
  }
}

