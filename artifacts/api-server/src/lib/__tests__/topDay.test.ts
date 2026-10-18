import { describe, expect, it } from "vitest";

process.env.JWT_SECRET ??= "vitest-only-secret";
const { aggregateTraders, buildCalendar, buildTopDay, buildTraderDay, rankTraders, topMode } = await import("../topDay");
const { deskAliases } = await import("../deskAliases");
type Rows = Parameters<typeof buildTopDay>[1];
type SideRows = Parameters<typeof buildTraderDay>[2];

const DATE = "2026-10-16";
const KIRILL = { name: "Kirill", staff: false };
const STAFF = { name: "Olga", staff: true };

// 13 winners (W01..W13 earn 13·100 … 1·100), Kirill +55 over two tickers, 12 losers (L01..L12 lose 100 … 1200), Flat 0.
const rows: Rows = [
  ...Array.from({ length: 13 }, (_, i) => ({ trader: `W${String(i + 1).padStart(2, "0")}`, ticker: "AMD", net: String((13 - i) * 100), trades: 2, wins: 2, losses: 0 })),
  ...Array.from({ length: 12 }, (_, i) => ({ trader: `L${String(i + 1).padStart(2, "0")}`, ticker: "META", net: -(i + 1) * 100, trades: 3, wins: 1, losses: 2 })),
  { trader: "Kirill", ticker: "NVDA", net: 80, trades: 2, wins: 2, losses: 0 },
  { trader: "Kirill", ticker: "TSLA", net: -25, trades: 1, wins: 0, losses: 1 },
  { trader: "Flat", ticker: "AAPL", net: 0, trades: 1, wins: 0, losses: 0 },
];
const everyone = [...new Set(rows.map((r) => r.trader))];

describe("topMode", () => {
  it("staff always named; traders anonymous unless the setting is off", () => {
    expect(topMode(STAFF, true)).toBe("staff");
    expect(topMode(KIRILL, true)).toBe("anonymous");
    expect(topMode(KIRILL, false)).toBe("named");
  });
});

describe("aggregateTraders / rankTraders", () => {
  it("sums tickers into trader-days and orders tickers by net", () => {
    const k = aggregateTraders(rows).find((a) => a.trader === "Kirill")!;
    expect(k).toMatchObject({ net: 55, trades: 3, wins: 2, losses: 1 });
    expect(k.tickers.map((t) => t.ticker)).toEqual(["NVDA", "TSLA"]);
  });
  it("profit = net > 0 best first, loss = net < 0 worst first, flat in neither, cut to 10", () => {
    const { profit, loss } = rankTraders(aggregateTraders(rows));
    expect(profit).toHaveLength(10);
    expect(profit[0].trader).toBe("W01");
    expect(loss).toHaveLength(10);
    expect(loss[0].trader).toBe("L12");
    expect([...profit, ...loss].some((a) => a.trader === "Flat")).toBe(false);
  });
});

describe("buildTopDay", () => {
  it("anonymous: aliases over every trader of the day, $ visible, no names anywhere", () => {
    const day = buildTopDay(DATE, rows, KIRILL, "anonymous");
    const aliases = deskAliases(everyone, DATE);
    expect(day.profit[0]).toMatchObject({ alias: aliases.get("W01"), name: null, net: 1300, place: 1, bestTicker: "AMD", me: false });
    expect(day.loss[0]).toMatchObject({ alias: aliases.get("L12"), net: -1200 });
    expect(day.desk).toEqual({ net: rows.reduce((s, r) => s + Number(r.net), 0), trades: 13 * 2 + 12 * 3 + 3 + 1, traders: everyone.length });
    // Kirill (+55) is outside the top 10 profit list: his own row comes separately with his full place.
    expect(day.profit.some((r) => r.me)).toBe(false);
    expect(day.me).toMatchObject({ me: true, name: null, net: 55, place: 14, alias: aliases.get("Kirill") });
    const json = JSON.stringify(day);
    for (const n of everyone) expect(json).not.toContain(`"${n}"`);
  });
  it("aliases are 1..N and unique", () => {
    const day = buildTopDay(DATE, rows, KIRILL, "anonymous");
    const all = [...day.profit, ...day.loss].map((r) => r.alias);
    expect(new Set(all).size).toBe(all.length);
    expect(Math.min(...all)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...all)).toBeLessThanOrEqual(everyone.length);
  });
  it("named (setting off): names shown, other traders' $ hidden, own $ kept", () => {
    const day = buildTopDay(DATE, rows, KIRILL, "named");
    expect(day.profit[0]).toMatchObject({ name: "W01", net: null, bestTicker: null });
    expect(day.profit[0].tickers.every((t) => t.net === null)).toBe(true);
    expect(day.desk.net).toBeNull();
    expect(day.me).toMatchObject({ name: "Kirill", net: 55 });
    expect(day.me!.tickers.map((t) => t.net)).toEqual([80, -25]);
  });
  it("staff: names and $", () => {
    const day = buildTopDay(DATE, rows, STAFF, "staff");
    expect(day.profit[0]).toMatchObject({ name: "W01", net: 1300 });
    expect(day.me).toBeNull();
  });
  it("empty day", () => {
    const day = buildTopDay(DATE, [], KIRILL, "anonymous");
    expect(day).toMatchObject({ profit: [], loss: [], me: null, desk: { net: 0, trades: 0, traders: 0 } });
  });
});

describe("buildTraderDay", () => {
  const at = (hm: string) => `${DATE}T${String(Number(hm.slice(0, 2)) + 4).padStart(2, "0")}:${hm.slice(3)}:00.000Z`;
  const side: SideRows = [
    ...rows.filter((r) => r.trader !== "Kirill").map((r) => ({ ...r, side: "Long", first_at: at("10:00"), last_at: at("10:30") })),
    { trader: "Kirill", ticker: "NVDA", side: "Long", net: 50, trades: 1, wins: 1, losses: 0, first_at: at("09:45"), last_at: at("10:05") },
    { trader: "Kirill", ticker: "NVDA", side: "Short", net: 30, trades: 1, wins: 1, losses: 0, first_at: new Date(at("11:00")), last_at: at("11:20") },
    { trader: "Kirill", ticker: "TSLA", side: "Short", net: -25, trades: 1, wins: 0, losses: 1, first_at: at("09:35"), last_at: null },
  ];
  const kAlias = deskAliases(everyone, DATE).get("Kirill")!;
  const wAlias = deskAliases(everyone, DATE).get("W01")!;

  it("resolves the alias, merges sides per ticker, orders tickers by first fill", () => {
    const d = buildTraderDay(DATE, kAlias, side, KIRILL, "anonymous")!;
    expect(d).toMatchObject({ alias: kAlias, me: true, name: null, net: 55, trades: 3, place: 14 });
    expect(d.tickers.map((t) => t.ticker)).toEqual(["TSLA", "NVDA"]);
    expect(d.tickers[1]).toMatchObject({ side: "both", trades: 2, net: 80, firstAt: at("09:45"), lastAt: at("11:20") });
    expect(d.tickers[0]).toMatchObject({ side: "short", net: -25, lastAt: null });
  });
  it("anonymous: another trader's day has $ and no name", () => {
    const d = buildTraderDay(DATE, wAlias, side, KIRILL, "anonymous")!;
    expect(d).toMatchObject({ me: false, name: null, net: 1300, place: 1 });
    expect(JSON.stringify(d)).not.toContain("W01");
  });
  it("named: name shown, $ hidden for another trader", () => {
    const d = buildTraderDay(DATE, wAlias, side, KIRILL, "named")!;
    expect(d).toMatchObject({ name: "W01", net: null });
    expect(d.tickers.every((t) => t.net === null)).toBe(true);
  });
  it("unknown alias → null", () => {
    expect(buildTraderDay(DATE, 999, side, KIRILL, "anonymous")).toBeNull();
  });
});

describe("buildCalendar", () => {
  const cal = [
    { date: "2026-10-02", net: "-120.456", trades: 125, traders: 20, best: 400, worst: -600, mine: null, traded: false },
    { date: "2026-10-01", net: 300, trades: 113, traders: 16, best: 900, worst: -200, mine: "45.5", traded: true },
  ];
  it("sorts days, rounds $, keeps the viewer's own net", () => {
    const c = buildCalendar("2026-10", cal, ["2026-10-12", "2026-10-12"], "anonymous");
    expect(c.days.map((d) => d.date)).toEqual(["2026-10-01", "2026-10-02"]);
    expect(c.days[1]).toMatchObject({ net: -120.46, best: 400, worst: -600, mine: null });
    expect(c.days[0].mine).toBe(45.5);
    expect(c.holidays).toEqual(["2026-10-12"]);
  });
  it("named mode hides desk aggregates from traders but keeps counts and own net", () => {
    const c = buildCalendar("2026-10", cal, [], "named");
    expect(c.days[0]).toMatchObject({ net: null, best: null, worst: null, trades: 113, traders: 16, mine: 45.5 });
  });
});
