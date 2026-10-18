/**
 * Daily loop in the Telegram bot (same bot as ideas / alerts) — the three sends. Scheduled in src/jobs/definitions.ts;
 * times and on/off switches are desk settings (admin → «Настройки деска», lib/daily/telegramSchedule.ts):
 *
 *   telegram.daily-morning    telegram.morningTime   focus of the day + own contract (default 08:45 NY, premarket: the
 *                             weekdays NY            previous day is synced, 45 min left to set the contract)
 *   telegram.daily-evening    telegram.eveningTime   the day's card, once the session's PropReports trades are in
 *                             weekdays NY            (default 16:30, never before 16:15) + every PropReports sync after
 *                                                    that time (a manual / late sync sends the cards it unlocks)
 *   telegram.contract-alerts  after every PropReports sync, 04:00–16:15 NY, ONLY when the scheduled sync is on
 *                             (syncCron() ≠ null): «daily stop reached» / «trade limit reached», once per trader+kind+day
 *
 * Recipients: active members with a linked Telegram chat, the Telegram switch on (users.tg_notifications_enabled) and
 * the daily-loop switch on (users.settings.dailyTelegram ≠ false; Settings → Notifications → Telegram).
 * Every send is claimed first in notification_dedup (lib/notifyEvents claimOnce) — a restart, a second process or the
 * next sync never sends it again; a send Telegram rejected releases its claim so the next run retries.
 * Nothing is sent unless the bot is configured AND this is production (dailyTelegramEnabled).
 */
import { pool } from "@workspace/db";
import { config } from "../../config";
import { logger } from "../logger";
import { parseLang, type Lang } from "../../i18n";
import { addDays, isWeekend, nyDate, nyMinutes } from "../tradingDate";
import { sendMessage } from "../telegramBot";
import { claimOnce } from "../notifyEvents";
import { dailyTelegramEnabled, intradayAlertsEnabled } from "./telegramGuard";
import { EVENING_FROM_MIN, contractAlertsEnabled, eveningEnabled, eveningSendMinutes, morningEnabled } from "./telegramSchedule";
import * as service from "./service";
import { contractAlert, eveningMessage, isPrivateChat, morningMessage, type DayContract, type IntradayBreach, type TgMessage } from "./telegramText";

export { EVENING_FROM_MIN };
/** Intraday alerts: premarket 04:00 → 16:15 NY (after that the evening card carries the verdict). */
export const ALERT_WINDOW_MIN = [4 * 60, 16 * 60 + 15] as const;
/** Morning recipients: traded at least once in the last 14 calendar days. */
const ACTIVE_DAYS = 14;
const SEND_GAP_MS = 40; // Telegram: ≤ 30 messages / s per bot

// ─── once-only markers (notification_dedup) ─────────────────────────────────

export const dailyKey = {
  morning: (date: string, trader: string) => `daily-tg:morning:${date}:${trader}`,
  evening: (date: string, trader: string) => `daily-tg:evening:${date}:${trader}`,
  /** The card of `date` went to `trader` in `chatId` — the callback checks it (a re-linked chat can't close it). */
  card: (date: string, trader: string, chatId: string | number) => `daily-tg:card:${date}:${trader}:${chatId}`,
  closed: (date: string, trader: string) => `daily-tg:closed:${date}:${trader}`,
  alert: (kind: string, date: string, trader: string) => `daily-tg:alert:${kind}:${date}:${trader}`,
};

export async function existingKeys(keys: readonly string[]): Promise<Set<string>> {
  if (!keys.length) return new Set();
  try {
    const { rows } = await pool.query<{ key: string }>(`SELECT key FROM notification_dedup WHERE key = ANY($1::text[])`, [keys]);
    return new Set(rows.map((r) => r.key));
  } catch {
    return new Set(); // table not created yet → nothing claimed
  }
}

export async function releaseKey(key: string): Promise<void> {
  await pool.query(`DELETE FROM notification_dedup WHERE key = $1`, [key]).catch(() => undefined);
}

/** Claim → send → release on failure. "dup" = someone already sent it. */
async function deliver(key: string, chatId: string, msg: TgMessage): Promise<"sent" | "dup" | "failed"> {
  if (!(await claimOnce(key))) return "dup";
  const ok = await sendMessage(chatId, msg.text, msg.keyboard.length ? { reply_markup: { inline_keyboard: msg.keyboard } } : {}).catch(() => false);
  if (!ok) await releaseKey(key);
  return ok ? "sent" : "failed";
}

// ─── recipients / calendar / plan ───────────────────────────────────────────

export type Recipient = { name: string; chatId: string; lang: Lang };

/** Opted-in linked members; `names` narrows to these, `tradedFrom..tradedTo` to members with trades in that range. */
export async function dailyRecipients(o: { names?: readonly string[] | null; tradedFrom?: string; tradedTo?: string } = {}): Promise<Recipient[]> {
  const { rows } = await pool.query<{ name: string; chat_id: string; locale: string | null }>(
    `SELECT u.name, u.telegram_chat_id AS chat_id, u.locale
       FROM users u
      WHERE u.active = true AND COALESCE(u.banned, false) = false AND u.role <> 'guest'
        AND u.telegram_chat_id IS NOT NULL AND u.telegram_chat_id <> ''
        AND COALESCE(u.tg_notifications_enabled, true) = true
        AND COALESCE(u.settings->>'dailyTelegram', 'true') <> 'false'
        AND ($1::text[] IS NULL OR u.name = ANY($1::text[]))
        AND ($2::text IS NULL OR EXISTS (
              SELECT 1 FROM trades t WHERE t.trader = u.name AND t.deleted_at IS NULL AND t.date >= $2 AND t.date <= $3))
      ORDER BY u.name`,
    [o.names ? [...o.names] : null, o.tradedFrom ?? null, o.tradedTo ?? o.tradedFrom ?? null],
  );
  return rows.map((r) => ({ name: r.name, chatId: String(r.chat_id), lang: parseLang(r.locale) ?? "ru" }));
}

/** Weekend or a full-day NYSE holiday (holiday_calendar, migrations 0016/0017; early closes still trade). */
export async function marketClosed(date: string): Promise<boolean> {
  if (isWeekend(date)) return true;
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM holiday_calendar WHERE date::text = $1 AND type = 'holiday' AND description ILIKE 'market closed%' LIMIT 1`,
      [date],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** The day's own contract from the personal plan (trader_plans.doc maxLossUsd / maxTrades / ownRule). */
export async function dayContract(trader: string, date: string): Promise<DayContract | null> {
  try {
    const { rows } = await pool.query<{ doc: { maxLossUsd?: unknown; maxTrades?: unknown; ownRule?: unknown } | null }>(
      `SELECT doc FROM trader_plans WHERE trader = $1 AND date = $2 AND deleted_at IS NULL LIMIT 1`,
      [trader, date],
    );
    const doc = rows[0]?.doc;
    if (!doc) return null;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
    const c = { maxLossUsd: num(doc.maxLossUsd), maxTrades: num(doc.maxTrades), rule: typeof doc.ownRule === "string" && doc.ownRule ? doc.ownRule : null };
    return c.maxLossUsd == null && c.maxTrades == null && !c.rule ? null : c;
  } catch {
    return null; // trader_plans not created yet (routes/gameplan ensures it on first use)
  }
}

type RunOpts = { now?: Date; signal?: AbortSignal };
type Tally = { sent: number; dup: number; failed: number; skipped: number };
const tally = (): Tally => ({ sent: 0, dup: 0, failed: 0, skipped: 0 });
const pause = () => new Promise((r) => setTimeout(r, SEND_GAP_MS));

// ─── morning ────────────────────────────────────────────────────────────────

export async function runMorningFocus(o: RunOpts = {}): Promise<Record<string, unknown>> {
  if (!dailyTelegramEnabled()) return { skipped: "bot not configured" };
  if (!morningEnabled()) return { skipped: "off in desk settings" };
  const date = nyDate(o.now ?? new Date());
  if (await marketClosed(date)) return { skipped: "market closed", date };
  const list = await dailyRecipients({ tradedFrom: addDays(date, -ACTIVE_DAYS), tradedTo: addDays(date, -1) });
  const done = await existingKeys(list.map((r) => dailyKey.morning(date, r.name)));
  const n = tally();
  for (const r of list) {
    if (o.signal?.aborted) break;
    if (done.has(dailyKey.morning(date, r.name))) { n.dup++; continue; }
    const focus = await service.focusFor(r.name, date).catch((err) => { logger.warn({ err, trader: r.name }, "daily-tg: focus failed"); return null; });
    if (!focus) { n.skipped++; continue; }
    const msg = morningMessage({ lang: r.lang, date, focus, contract: await dayContract(r.name, date), siteUrl: config.siteUrl });
    n[await deliver(dailyKey.morning(date, r.name), r.chatId, msg)]++;
    await pause();
  }
  return { date, recipients: list.length, ...n };
}

// ─── evening ────────────────────────────────────────────────────────────────

export async function runEveningCards(o: RunOpts = {}): Promise<Record<string, unknown>> {
  if (!dailyTelegramEnabled()) return { skipped: "bot not configured" };
  if (!eveningEnabled()) return { skipped: "off in desk settings" };
  const now = o.now ?? new Date();
  const date = nyDate(now);
  if (await marketClosed(date)) return { skipped: "market closed", date };
  if (nyMinutes(now) < EVENING_FROM_MIN) return { skipped: "before the close", date };
  if (nyMinutes(now) < eveningSendMinutes()) return { skipped: "before the evening time", date };
  const list = await dailyRecipients({ tradedFrom: date, tradedTo: date });
  const done = await existingKeys(list.map((r) => dailyKey.evening(date, r.name)));
  const n = tally();
  for (const r of list) {
    if (o.signal?.aborted) break;
    if (done.has(dailyKey.evening(date, r.name))) { n.dup++; continue; }
    const card = await service.eveningFor(r.name, date).catch((err) => { logger.warn({ err, trader: r.name }, "daily-tg: evening card failed"); return null; });
    if (!card || card.trades === 0) { n.skipped++; continue; }
    const msg = eveningMessage({ lang: r.lang, card, siteUrl: config.siteUrl, privateChat: isPrivateChat(r.chatId) });
    const res = await deliver(dailyKey.evening(date, r.name), r.chatId, msg);
    if (res === "sent") await claimOnce(dailyKey.card(date, r.name, r.chatId));
    n[res]++;
    await pause();
  }
  return { date, recipients: list.length, ...n };
}

// ─── intraday contract alerts ───────────────────────────────────────────────

type IntradayCheck = (date: string) => Promise<IntradayBreach[]>;

/** lib/daily/service `checkIntradayContracts(date)` (engine agent); null while it is not there. */
export function intradayCheck(): IntradayCheck | null {
  const fn = (service as unknown as Record<string, unknown>).checkIntradayContracts;
  return typeof fn === "function" ? (fn as IntradayCheck) : null;
}

export async function runContractAlerts(o: RunOpts & { check?: IntradayCheck | null } = {}): Promise<Record<string, unknown>> {
  if (!intradayAlertsEnabled()) return { skipped: "scheduled sync or bot not configured" };
  if (!contractAlertsEnabled()) return { skipped: "off in desk settings" };
  const now = o.now ?? new Date();
  const date = nyDate(now);
  if (await marketClosed(date)) return { skipped: "market closed", date };
  const m = nyMinutes(now);
  if (m < ALERT_WINDOW_MIN[0] || m >= ALERT_WINDOW_MIN[1]) return { skipped: "outside the session", date };
  const check = o.check === undefined ? intradayCheck() : o.check;
  if (!check) return { skipped: "intraday check not available", date };
  const breaches = await check(date);
  if (!breaches.length) return { date, breaches: 0 };
  const byName = new Map((await dailyRecipients({ names: [...new Set(breaches.map((b) => b.trader))] })).map((r) => [r.name, r]));
  const n = tally();
  for (const b of breaches) {
    const r = byName.get(b.trader);
    if (!r) { n.skipped++; continue; }
    const text = contractAlert({ lang: r.lang, breach: b, privateChat: isPrivateChat(r.chatId) });
    n[await deliver(dailyKey.alert(b.kind, date, b.trader), r.chatId, { text, keyboard: [] })]++;
  }
  return { date, breaches: breaches.length, ...n };
}
