/**
 * Daily loop in the Telegram bot — PURE message builders (no DB, no network), unit-tested.
 * Texts: server `daily` namespace, `tg.*` keys, in the reader's language. Every user-provided or engine string is
 * HTML-escaped (escHtml); URLs are built from encoded parts only.
 *
 *   morningMessage   premarket focus line + the day's own contract (or a nudge to set it) + «Открыть план» / «Мой день»
 *   eveningMessage   the day's card: own net P&L (private chat only), focus ✓/✗ with the cost, the trade to review,
 *                    «same ticker: N traders», contract verdict; buttons daily:rev:<date> / daily:dis:<date> + the day URL
 *                    + one rewards line: today's new badge, else the kept-contract streak with the day's points
 *   contractAlert    intraday «daily stop reached» / «trade limit reached» (scheduled PropReports sync only)
 */
import type { Lang } from "../../i18n";
import { fmtDateFor } from "../../i18n/format";
import { dailyT } from "../../i18n/ns";
import { escHtml, type InlineKeyboard } from "../telegramBot";
import { fmtLossLimit, fmtSignedUsd } from "../notifyEventsCore";
import type { ContractVerdict, DailyFocus, EveningCard, TextItem, VerdictStatus } from "./types";

export type TgMessage = { text: string; keyboard: InlineKeyboard };

/** The day's own contract from the personal plan (trader_plans.doc). */
export type DayContract = { maxLossUsd: number | null; maxTrades: number | null; rule?: string | null };

export type IntradayBreach = { trader: string; kind: "max_loss" | "max_trades"; limit: number; actual: number };

/** Callback data of the evening card buttons (Telegram limit: 64 bytes — the date only; the trader is the chat's). */
export const DAILY_CB = { review: "daily:rev:", dispute: "daily:dis:" } as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `daily:rev:2026-10-16` → { action: "review", date }; anything else → null. */
export function parseDailyCallback(data: string): { action: "review" | "dispute"; date: string } | null {
  const m = /^daily:(rev|dis):(\d{4}-\d{2}-\d{2})$/.exec(data);
  if (!m || !DATE_RE.test(m[2]!)) return null;
  return { action: m[1] === "rev" ? "review" : "dispute", date: m[2]! };
}

/** Private Telegram chats have positive ids; groups / channels negative. Money is shown in private chats only. */
export function isPrivateChat(chatId: string | number): boolean {
  return !String(chatId).trim().startsWith("-");
}

const site = (siteUrl: string) => siteUrl.replace(/\/+$/, "");
const q = (v: string | number) => encodeURIComponent(String(v));

export const dailyLinks = {
  plan: (s: string, date: string) => `${site(s)}/game-plan?view=my&date=${q(date)}`,
  myDay: (s: string) => `${site(s)}/`,
  day: (s: string, date: string) => `${site(s)}/day-report?date=${q(date)}`,
  trade: (s: string, id: number) => `${site(s)}/trades?highlight=${q(id)}`,
  deskDay: (s: string, ticker: string, date: string) => `${site(s)}/desk-day?ticker=${q(ticker)}&date=${q(date)}`,
};

/** An engine TextItem (e.g. the focus line) in `lang`, escaped; null params are dropped. */
export function renderTextItem(lang: Lang, item: TextItem | null | undefined): string | null {
  if (!item?.key) return null;
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(item.params ?? {})) if (v !== null && v !== undefined) params[k] = v;
  const s = dailyT.tryFor(lang, item.key, params);
  return s ? escHtml(s) : null;
}

/** Short name of a mistake id (`daily` namespace `mistake.<id>`), escaped; generic «the day's focus» when unknown. */
export function mistakeName(lang: Lang, id: string | null | undefined): string {
  const s = id ? dailyT.tryFor(lang, `mistake.${id}`) : undefined;
  return escHtml(s ?? dailyT.tFor(lang)("tg.focusGeneric"));
}

function contractItems(lang: Lang, c: DayContract | null): string[] {
  const t = dailyT.tFor(lang);
  const out: string[] = [];
  if (c?.maxLossUsd != null && c.maxLossUsd > 0) out.push(t("tg.contract.stop", { limit: fmtLossLimit(c.maxLossUsd) }));
  if (c?.maxTrades != null && c.maxTrades > 0) out.push(t("tg.contract.maxTrades", { limit: c.maxTrades }));
  if (c?.rule) out.push(t("tg.contract.rule", { rule: mistakeName(lang, c.rule) }));
  return out;
}

export function morningMessage(o: { lang: Lang; date: string; focus: DailyFocus | null; contract: DayContract | null; siteUrl: string }): TgMessage {
  const t = dailyT.tFor(o.lang);
  const lines = [t("tg.morning.title", { date: escHtml(fmtDateFor(o.lang, o.date, "weekdayDayMonth")) })];
  const focus = renderTextItem(o.lang, o.focus?.text);
  if (focus) lines.push("", `🎯 ${focus}`);
  const items = contractItems(o.lang, o.contract);
  lines.push("", items.length ? t("tg.contract.line", { items: items.join(" · ") }) : t("tg.morning.noContract"));
  return {
    text: lines.join("\n"),
    keyboard: [[
      { text: t("tg.button.plan"), url: dailyLinks.plan(o.siteUrl, o.date) },
      { text: t("tg.button.myDay"), url: dailyLinks.myDay(o.siteUrl) },
    ]],
  };
}

const MARK: Record<string, string> = { kept: "✓", broken: "✗", no_trades: "·", unknown: "?" };
const mark = (s: VerdictStatus | "unset") => MARK[s] ?? "";

function contractVerdictLine(lang: Lang, c: ContractVerdict | null, showMoney: boolean): string | null {
  if (!c) return null;
  const t = dailyT.tFor(lang);
  const items: string[] = [];
  if (c.maxLoss.status !== "unset" && c.maxLoss.limit != null) {
    items.push(showMoney
      ? t("tg.contract.stopVerdict", { limit: fmtLossLimit(Math.abs(c.maxLoss.limit)), mark: mark(c.maxLoss.status) })
      : t("tg.contract.stopVerdictNoMoney", { mark: mark(c.maxLoss.status) }));
  }
  if (c.maxTrades.status !== "unset" && c.maxTrades.limit != null) {
    items.push(t("tg.contract.tradesVerdict", { actual: c.maxTrades.actual, limit: c.maxTrades.limit, mark: mark(c.maxTrades.status) }));
  }
  if (c.rule.status !== "unset" && c.rule.mistake) {
    items.push(t("tg.contract.ruleVerdict", { rule: mistakeName(lang, c.rule.mistake), mark: mark(c.rule.status) }));
  }
  return items.length ? t("tg.contract.line", { items: items.join(" · ") }) : t("tg.evening.contractUnset");
}

/** One line: the badges earned today, else the kept-contract streak with the day's points (only on a kept day). */
export function rewardsLine(lang: Lang, card: EveningCard): string | null {
  const r = card.rewards;
  if (!r) return null;
  const t = dailyT.tFor(lang);
  if (r.badges.length) {
    const names = r.badges.map((b) => escHtml(dailyT.tryFor(lang, `badge.${b.id}`, { count: b.target }) ?? b.id));
    return t("tg.evening.badge", { badges: names.join(", ") });
  }
  const points = card.contract?.disciplineDelta ?? 0;
  return r.streak > 0 && points > 0 ? t("tg.evening.streak", { days: t("tg.evening.streakDays", { count: r.streak }), points: `+${points}` }) : null;
}

export type CardState = "open" | "reviewed" | "disputed";

/**
 * The evening card. `privateChat` = false hides every $ amount (net P&L, focus cost, trade net, stop limit).
 * `state` ≠ "open" renders the closed card (no action buttons, a closing line).
 */
export function eveningMessage(o: { lang: Lang; card: EveningCard; siteUrl: string; privateChat: boolean; state?: CardState }): TgMessage {
  const { lang, card, siteUrl } = o;
  const money = o.privateChat;
  const state: CardState = o.state ?? (card.reviewed ? "reviewed" : "open");
  const t = dailyT.tFor(lang);
  const lines = [t("tg.evening.title", { date: escHtml(fmtDateFor(lang, card.date, "weekdayDayMonth")) })];

  const trades = t("tg.evening.trades", { count: card.trades });
  lines.push(money && card.netPnl != null ? t("tg.evening.pnl", { net: fmtSignedUsd(card.netPnl), trades }) : trades);

  const f = card.focus;
  if (f) {
    const name = mistakeName(lang, f.mistake);
    if (f.status === "broken") {
      const hits = t("tg.evening.hits", { count: f.hits.length || 1 });
      lines.push(money && f.costNet != null
        ? t("tg.evening.focusBroken", { mistake: name, hits, cost: fmtSignedUsd(f.costNet) })
        : t("tg.evening.focusBrokenNoCost", { mistake: name, hits }));
    } else if (f.status === "kept") {
      lines.push(t("tg.evening.focusKept", { mistake: name }));
    }
  }

  const r = card.tradeToReview;
  if (r) {
    const reason = dailyT.tryFor(lang, `tg.evening.reason.${r.reason}`) ?? "";
    const label = money && r.net != null ? `${escHtml(r.ticker)} ${fmtSignedUsd(r.net)}` : escHtml(r.ticker);
    lines.push(t("tg.evening.review", { url: escHtml(dailyLinks.trade(siteUrl, r.tradeId)), label, reason: escHtml(reason) }));
  }

  const d = card.deskSameTicker;
  if (d && d.traders > 0) {
    lines.push(t("tg.evening.desk", {
      ticker: escHtml(d.ticker), traders: t("tg.evening.traders", { count: d.traders }), url: escHtml(dailyLinks.deskDay(siteUrl, d.ticker, card.date)),
    }));
  }

  const c = contractVerdictLine(lang, card.contract, money);
  if (c) lines.push(c);
  const rw = rewardsLine(lang, card);
  if (rw) lines.push(rw);

  const dayBtn = [{ text: t("tg.button.day"), url: dailyLinks.day(siteUrl, card.date) }];
  if (state !== "open") {
    lines.push("", state === "disputed" ? t("tg.evening.closedDisputed") : t("tg.evening.closedReviewed"));
    return { text: lines.join("\n"), keyboard: [dayBtn] };
  }
  const actions = [{ text: t("tg.button.reviewed"), callback_data: `${DAILY_CB.review}${card.date}` }];
  // «Это не ошибка» only when there is something to dispute: the focus was broken today.
  if (f?.status === "broken" && !f.disputed) actions.push({ text: t("tg.button.dispute"), callback_data: `${DAILY_CB.dispute}${card.date}` });
  return { text: lines.join("\n"), keyboard: [actions, dayBtn] };
}

/** «Дневной стоп достигнут: −$310 из −$300. Стоп на сегодня.» — amounts only in a private chat. */
export function contractAlert(o: { lang: Lang; breach: IntradayBreach; privateChat: boolean }): string {
  const t = dailyT.tFor(o.lang);
  const b = o.breach;
  if (b.kind === "max_trades") return t("tg.alert.maxTrades", { actual: b.actual, limit: b.limit });
  if (!o.privateChat) return t("tg.alert.maxLossNoMoney");
  return t("tg.alert.maxLoss", { actual: fmtSignedUsd(-Math.abs(b.actual)), limit: fmtLossLimit(Math.abs(b.limit)) });
}
