import { describe, expect, it } from "vitest";
import { parseAsk, type ParseContext } from "@/lib/ask/parse";
import { askBookScope, decodeTuples, makeBook, runAsk, tradesFromTuples, tradesHref } from "@/lib/ask/run";
import { canonicalText, type AskTrade } from "@/lib/ask/aggregate";

// Book: Ориф trades Mon 2026-10-12 … Fri 2026-10-16, plus one Тимур trade.
let id = 0;
function t(date: string, clock: string, ticker: string, side: "Long" | "Short", pnl: number, fees = 1, extra: Partial<AskTrade> = {}): AskTrade {
  id++;
  return {
    id, date, ticker, side, pnl, fees, qty: 100, trader: "Ориф",
    result: pnl - fees > 0 ? "win" : pnl - fees < 0 ? "loss" : "be",
    contextSnapshot: { openedAt: `${date}T${clock}:00`, closedAt: `${date}T${clock}:00`.replace(/:(\d{2}):00$/, (_, m) => `:${String(Math.min(59, Number(m) + 3)).padStart(2, "0")}:00`) },
    ...extra,
  };
}
const trades: AskTrade[] = [
  t("2026-10-12", "09:45", "AAPL", "Long", 50),
  t("2026-10-12", "10:15", "AAPL", "Long", -30),
  t("2026-10-12", "14:30", "NVDA", "Short", -40),
  t("2026-10-13", "09:40", "NVDA", "Long", 20),
  t("2026-10-13", "14:10", "NVDA", "Short", -25),
  t("2026-10-14", "09:50", "AAPL", "Long", 35),
  t("2026-10-15", "15:20", "INTC", "Short", -60),
  t("2026-10-16", "09:35", "AAPL", "Long", 80),
  t("2026-10-16", "09:55", "AAPL", "Long", -10),
  t("2026-10-16", "10:20", "AAPL", "Long", -15),
  t("2026-10-16", "10:40", "NVDA", "Long", 12),
  t("2026-10-16", "11:00", "MRK", "Long", 100, 1, { trader: "Тимур" }),
];
const book = makeBook(trades);
const ctx: ParseContext = { today: "2026-10-16", traders: ["Ориф", "Тимур"], tickers: book.tickers.map((x) => x.value) };
const ask = (s: string) => runAsk(parseAsk(s, ctx), book, { me: "Ориф" });

describe("runAsk", () => {
  it("defaults to my trades; «весь деск» widens the scope", () => {
    expect(ask("сколько сделок").answer.matched).toBe(11);
    expect(ask("сколько сделок весь деск").answer.matched).toBe(12);
  });

  it("net = pnl − |fees|", () => {
    const a = ask("нетто AAPL").answer;
    // 50-30+35+80-10-15 = 110 gross, 6 fees
    expect(a.big.value).toBe("+$104.00");
  });

  it("weekday filter «по пятницам»", () => {
    expect(ask("по пятницам").answer.matched).toBe(4);
  });

  it("after-loss context uses the same trader's same-day previous trade", () => {
    // Mon: AAPL -30 → NVDA (after loss); Tue: NVDA +20 → NVDA short (after win); Fri: AAPL -10 → AAPL -15, AAPL -15 → NVDA.
    const a = ask("после убытка").answer;
    expect(a.trades.map((x) => x.ticker).sort()).toEqual(["AAPL", "NVDA", "NVDA"]);
  });

  it("lastN keeps the latest trades", () => {
    const a = ask("последние 3 сделки").answer;
    expect(a.matched).toBe(3);
    expect(a.trades.every((x) => x.date === "2026-10-16")).toBe(true);
  });

  it("time compare «утро vs после обеда»", () => {
    const r = ask("утро vs после обеда");
    expect(r.answer.kind).toBe("compare");
    expect(r.answer.groups?.rows).toHaveLength(2);
    expect(r.answer.headline).toMatch(/^Лучше — утро/);
  });

  it("ticker compare carries both groups' ids into the trades link", () => {
    const r = ask("AAPL vs NVDA");
    expect(r.answer.link.ids?.length).toBe(10);
    expect(r.href).toContain("/trades?");
  });

  it("top-N tickers ranks by net", () => {
    const r = ask("топ 2 тикера");
    expect(r.answer.kind).toBe("top");
    expect(r.answer.groups?.highlight).toEqual(["AAPL", "NVDA"]);
  });

  it("fees headline says how much of gross the fees ate", () => {
    expect(ask("сколько съели комиссии").answer.headline).toMatch(/^Комиссии съели \$11\.00/);
  });

  it("streak of losses", () => {
    const a = ask("самая длинная серия убытков").answer;
    expect(a.kind).toBe("streak");
    expect(a.big.value).toBe("2 сделки");
  });

  it("insight: the best slice with enough trades; small losing groups are not reported", () => {
    const best = ask("когда я зарабатываю больше всего").answer;
    expect(best.kind).toBe("insight");
    expect(best.big.tone).toBeGreaterThan(0);
    // Every losing group here has < 5 trades ⇒ no finding rather than noise.
    expect(ask("когда я теряю больше всего").answer.headline).toMatch(/^Явных зон потерь не нашлось/);
  });

  it("empty answer when nothing matches", () => {
    expect(ask("TSLA").answer.empty).toBe(true);
  });

  it("canonical follow-up text round-trips through the parser", () => {
    const q = parseAsk("шорты NVDA по пятницам после 14:00", ctx);
    const again = parseAsk(canonicalText(q), ctx);
    expect(again.side).toBe("Short");
    expect(again.tickers).toEqual(["NVDA"]);
    expect(again.weekdays).toEqual([4]);
    expect(again.time?.fromMin).toBe(840);
  });

  it("tradesHref maps side/outcome/trader", () => {
    expect(tradesHref({ side: "Short", outcome: "loss", trader: "Ориф", from: "2026-10-01", to: "2026-10-16" }))
      .toBe("/trades?from=2026-10-01&to=2026-10-16&side=Short&outcome=loss&trader=%D0%9E%D1%80%D0%B8%D1%84");
  });
});

describe("askBookScope", () => {
  const q = (s: string) => parseAsk(s, ctx);
  it("traders always read their own book", () => {
    expect(askBookScope(q("сколько сделок весь деск"), { me: "Ориф", isStaff: false })).toBe("mine");
  });
  it("staff: own book unless the question needs the desk", () => {
    const o = { me: "Ориф", isStaff: true };
    expect(askBookScope(null, o)).toBe("mine");
    expect(askBookScope(q("сколько сделок"), o)).toBe("mine");
    expect(askBookScope(q("сколько сделок Ориф"), o)).toBe("mine");
    expect(askBookScope(q("сколько сделок Тимур"), o)).toBe("desk");
    expect(askBookScope(q("сколько сделок весь деск"), o)).toBe("desk");
    expect(askBookScope(q("нетто по трейдерам"), o)).toBe("desk");
  });
  it("staff with no trader name or no own trades get the desk", () => {
    expect(askBookScope(q("сколько сделок"), { me: null, isStaff: true })).toBe("desk");
    expect(askBookScope(q("сколько сделок"), { me: "Ориф", isStaff: true, ownEmpty: true })).toBe("desk");
  });
});

describe("tradesFromTuples", () => {
  it("maps columns by name and restores the snapshot clock fields", () => {
    const cols = ["id", "ticker", "date", "trader", "pnl", "fees", "qty", "openedAt", "closedAt", "result"];
    const [t] = tradesFromTuples(cols, [[7, "AAPL", "2026-10-16", "Ориф", 50, -1, 100, "2026-10-16T09:45:00", "2026-10-16T09:48:00", "win"]]);
    expect(t).toMatchObject({ id: 7, ticker: "AAPL", date: "2026-10-16", trader: "Ориф", pnl: 50, fees: -1, qty: 100, result: "win", exit: null });
    expect(t.contextSnapshot).toEqual({ openedAt: "2026-10-16T09:45:00", closedAt: "2026-10-16T09:48:00" });
    const b = makeBook(tradesFromTuples(cols, [[1, "AAPL", "2026-10-16", "Ориф", 50, 1, 100, "2026-10-16T09:45:00", "2026-10-16T09:48:00", "win"]]));
    expect(runAsk(parseAsk("сколько сделок", ctx), b, { me: "Ориф" }).answer.matched).toBe(1);
  });
});

describe("decodeTuples (enc=2)", () => {
  it("restores dictionary strings and clock stamps (closedAt relative to exitDate, else date)", () => {
    const cols = ["id", "ticker", "date", "exitDate", "setup", "openedAt", "closedAt"];
    const enc = {
      dicts: { ticker: ["AAPL"], date: ["2026-10-16"], exitDate: ["2026-10-19"], setup: ["Пробой"] },
      clock: { openedAt: "date", closedAt: "exitDate" },
    };
    const rows = decodeTuples(cols, [
      [1, 0, 0, null, 0, 9 * 3600 + 45 * 60, 9 * 3600 + 48 * 60 + 7],
      [2, 0, 0, 0, null, "2026-10-15T23:59:59", 34200],
      [3, null, 0, null, null, null, null],
    ], enc);
    expect(rows[0]).toEqual([1, "AAPL", "2026-10-16", null, "Пробой", "2026-10-16T09:45:00", "2026-10-16T09:48:07"]);
    expect(rows[1]).toEqual([2, "AAPL", "2026-10-16", "2026-10-19", null, "2026-10-15T23:59:59", "2026-10-19T09:30:00"]);
    expect(rows[2]).toEqual([3, null, "2026-10-16", null, null, null, null]);
    const [t] = tradesFromTuples(cols, [[1, 0, 0, null, 0, 35100, 35287]], enc);
    expect(t).toMatchObject({ id: 1, ticker: "AAPL", date: "2026-10-16", setup: "Пробой" });
    expect(t.contextSnapshot).toEqual({ openedAt: "2026-10-16T09:45:00", closedAt: "2026-10-16T09:48:07" });
  });
  it("plain tuples pass through unchanged", () => {
    const rows = [[1, "AAPL"]];
    expect(decodeTuples(["id", "ticker"], rows)).toBe(rows);
  });
});
