/** Daily loop in Telegram — pure message builders (lib/daily/telegramText.ts). No DB, no network. */
import { describe, expect, it } from "vitest";
import type { DailyFocus, EveningCard } from "../daily/types";
import { contractAlert, eveningMessage, isPrivateChat, morningMessage, parseDailyCallback } from "../daily/telegramText";

const SITE = "https://desk.example/";
const focus: DailyFocus = {
  trader: "Кирилл Б.", date: "2026-10-16", mistake: "structure:averaging", window: { from: "2026-10-02", to: "2026-10-15" },
  costNet: -412, count: 5, source: "auto", text: { key: "focus.structure:averaging", params: { cost: 412, count: 5, days: 10 } },
};

const card = (over: Partial<EveningCard> = {}): EveningCard => ({
  trader: "Кирилл Б.", date: "2026-10-16", trades: 14, netPnl: -230.4,
  focus: { date: "2026-10-16", mistake: "structure:averaging", status: "broken", hits: [{ tradeId: 7, date: "2026-10-16", ticker: "AMD", net: -180 }, { tradeId: 8, date: "2026-10-16", ticker: "AMD", net: -130 }], costNet: -310, disputed: false },
  tradeToReview: { tradeId: 7, date: "2026-10-16", ticker: "AMD", net: -180, reason: "biggest_loss" },
  deskSameTicker: { ticker: "AMD", traders: 6 },
  contract: {
    date: "2026-10-16",
    maxLoss: { limit: 300, actual: -230.4, status: "kept" },
    maxTrades: { limit: 10, actual: 14, status: "broken" },
    rule: { mistake: null, status: "unset" },
    disciplineDelta: 0,
  },
  reviewed: false, reviewNote: null, ...over,
});

const buttons = (kb: { text: string; callback_data?: string; url?: string }[][]) => kb.flat();

describe("morning focus message", () => {
  it("has the focus line, the contract and the two URL buttons", () => {
    const m = morningMessage({ lang: "ru", date: "2026-10-16", focus, contract: { maxLossUsd: 300, maxTrades: 10 }, siteUrl: SITE });
    expect(m.text).toContain("412");
    expect(m.text).toContain("−$300");
    expect(m.text).toContain("10");
    const b = buttons(m.keyboard);
    expect(b.map((x) => x.url)).toEqual(["https://desk.example/game-plan?view=my&date=2026-10-16", "https://desk.example/"]);
    expect(b.every((x) => !x.callback_data)).toBe(true);
  });

  it("shows the own rule of the day from the plan", () => {
    const m = morningMessage({ lang: "en", date: "2026-10-16", focus, contract: { maxLossUsd: null, maxTrades: null, rule: "structure:averaging" }, siteUrl: SITE });
    expect(m.text).toMatch(/rule: Averaging/i);
  });

  it("nudges to set the contract when none is set; renders in EN / UZ", () => {
    const ru = morningMessage({ lang: "ru", date: "2026-10-16", focus, contract: null, siteUrl: SITE });
    const en = morningMessage({ lang: "en", date: "2026-10-16", focus, contract: null, siteUrl: SITE });
    const uz = morningMessage({ lang: "uz", date: "2026-10-16", focus, contract: null, siteUrl: SITE });
    expect(ru.text).not.toBe(en.text);
    expect(en.text).not.toMatch(/[А-Яа-яЁё]/);
    expect(uz.text).not.toMatch(/[А-Яа-яЁё]/);
    expect(buttons(en.keyboard)[0]!.text).not.toBe(buttons(ru.keyboard)[0]!.text);
  });
});

describe("evening card message", () => {
  it("private chat: net P&L, focus cost, trade to review, same-ticker link, contract; both action buttons", () => {
    const m = eveningMessage({ lang: "ru", card: card(), siteUrl: SITE, privateChat: true });
    expect(m.text).toContain("−$230");
    expect(m.text).toContain("−$310");
    expect(m.text).toContain("https://desk.example/trades?highlight=7");
    expect(m.text).toContain("https://desk.example/desk-day?ticker=AMD&amp;date=2026-10-16");
    expect(m.text).toContain("14/10");
    const b = buttons(m.keyboard);
    expect(b.map((x) => x.callback_data).filter(Boolean)).toEqual(["daily:rev:2026-10-16", "daily:dis:2026-10-16"]);
    expect(b.find((x) => x.url)?.url).toBe("https://desk.example/day-report?date=2026-10-16");
    for (const x of b) if (x.callback_data) expect(Buffer.byteLength(x.callback_data)).toBeLessThanOrEqual(64);
  });

  it("not a private chat: no $ amounts at all", () => {
    const m = eveningMessage({ lang: "ru", card: card(), siteUrl: SITE, privateChat: false });
    expect(m.text).not.toMatch(/\$/);
  });

  it("no dispute button when the focus was kept; closed state has only the day URL", () => {
    const kept = card({ focus: { ...card().focus!, status: "kept", hits: [], costNet: 0 } });
    const open = eveningMessage({ lang: "en", card: kept, siteUrl: SITE, privateChat: true });
    expect(buttons(open.keyboard).map((x) => x.callback_data).filter(Boolean)).toEqual(["daily:rev:2026-10-16"]);
    const closed = eveningMessage({ lang: "en", card: card(), siteUrl: SITE, privateChat: true, state: "disputed" });
    expect(buttons(closed.keyboard).every((x) => x.url && !x.callback_data)).toBe(true);
    expect(closed.text).not.toBe(open.text);
  });

  it("escapes HTML coming from data", () => {
    const m = eveningMessage({ lang: "ru", card: card({ tradeToReview: { tradeId: 1, date: "2026-10-16", ticker: "<b>X</b>", net: 1, reason: "best" }, deskSameTicker: null }), siteUrl: SITE, privateChat: true });
    expect(m.text).toContain("&lt;b&gt;X&lt;/b&gt;");
  });
});

describe("contract alerts, callbacks, chats", () => {
  it("daily stop text with amounts (private) and without (group)", () => {
    const b = { trader: "Кирилл Б.", kind: "max_loss" as const, limit: 300, actual: -310 };
    const ru = contractAlert({ lang: "ru", breach: b, privateChat: true });
    expect(ru).toContain("−$310");
    expect(ru).toContain("−$300");
    expect(contractAlert({ lang: "ru", breach: b, privateChat: false })).not.toMatch(/\$/);
    expect(contractAlert({ lang: "en", breach: { ...b, kind: "max_trades", limit: 10, actual: 12 }, privateChat: true })).toMatch(/12.*10/);
  });

  it("parses callback data strictly", () => {
    expect(parseDailyCallback("daily:rev:2026-10-16")).toEqual({ action: "review", date: "2026-10-16" });
    expect(parseDailyCallback("daily:dis:2026-10-16")).toEqual({ action: "dispute", date: "2026-10-16" });
    expect(parseDailyCallback("daily:rev:2026-10-16:x")).toBeNull();
    expect(parseDailyCallback("daily:del:2026-10-16")).toBeNull();
    expect(parseDailyCallback("approve:12")).toBeNull();
  });

  it("private chat ids are positive", () => {
    expect(isPrivateChat("123456")).toBe(true);
    expect(isPrivateChat("-100123")).toBe(false);
  });
});
