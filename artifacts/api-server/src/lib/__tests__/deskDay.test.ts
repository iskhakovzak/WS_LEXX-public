import { describe, expect, it } from "vitest";
import { addedAgainst, buildDeskDay, dayResult, takeaways, type DeskTrader, type DeskTrade, type DeskTradeRow } from "../deskDay";
import { computeStructures, type ExecRowLite, type TradeRowLite } from "../tradeStructureStore";
import type { MoneyViewer } from "../playbookPrivacy";

const DATE = "2026-09-16";
type Row = TradeRowLite & DeskTradeRow;

let execSeq = 0;
function trade(id: number, trader: string, side: "Long" | "Short", p: Partial<Row> = {}): Row {
  return {
    id, trader, broker_account: null, ticker: "META", date: DATE, side, stop: null, risk_usd: null, qty: null, result: null,
    source: "propreports", context_snapshot: null, entry: null, exit: null, r_multiple: null, pnl: null, fees: null, ...p,
  };
}
/** ET wall time on DATE (EDT, UTC−4) → ISO. */
const at = (hm: string) => `${DATE}T${String(Number(hm.slice(0, 2)) + 4).padStart(2, "0")}:${hm.slice(3, 5)}:00.000Z`;
function ex(tradeId: number, kind: ExecRowLite["kind"], price: number, qty: number, hm: string): ExecRowLite {
  execSeq++;
  return { id: execSeq, trade_id: tradeId, kind, price, qty, executed_at: at(hm), sort_order: execSeq, order_id: null };
}

// A small desk: Kirill (viewer) wins a long; Roman wins a short with a stop; Gleb loses a long after averaging down;
// Pavel loses a short entered late.
const rows: Row[] = [
  trade(1, "Kirill", "Long", { result: "win", pnl: 50, fees: 2, qty: 100, stop: 99, entry: 100, exit: 100.5 }),
  trade(2, "Roman", "Short", { result: "win", pnl: 300, fees: 5, qty: 100, stop: 103, entry: 102, exit: 99, risk_usd: 100 }),
  trade(3, "Gleb", "Long", { result: "loss", pnl: -150, fees: 3, qty: 200, stop: 98, entry: 100.25, exit: 99.5 }),
  trade(4, "Pavel", "Short", { result: "loss", pnl: -40, fees: 1, qty: 50 }),
];
const execs: ExecRowLite[] = [
  ex(1, "entry", 100, 100, "09:40"), ex(1, "exit", 100.5, 100, "09:55"),
  ex(2, "entry", 102, 100, "09:45"), ex(2, "trim", 100, 50, "10:00"), ex(2, "exit", 98, 50, "10:10"),
  ex(3, "entry", 101, 100, "10:20"), ex(3, "add", 99.5, 100, "10:30"), ex(3, "exit", 99.5, 200, "10:50"),
  ex(4, "entry", 99, 50, "11:00"), ex(4, "exit", 99.8, 50, "11:20"),
];
const structures = computeStructures(rows, execs);
const asTrader: MoneyViewer = { name: "Kirill", staff: false };
const asStaff: MoneyViewer = { name: "Admin", staff: true };

describe("deskDay — privacy", () => {
  const day = buildDeskDay("META", DATE, rows, structures, asTrader);

  it("own trade keeps $ and sizes", () => {
    const own = day.trades.find((t) => t.trader === "Kirill")!;
    expect(own.redacted).toBe(false);
    expect(own.net).toBe(48);
    expect(own.qty).toBe(100);
    expect(own.legs.every((l) => l.qty === 100)).toBe(true);
    const me = day.traders.find((t) => t.name === "Kirill")!;
    expect(me.me).toBe(true);
    expect(me.net).toBe(48);
  });

  it("another trader's trade has no $, no sizes — only prices, times, roles, side, result, R", () => {
    for (const t of day.trades.filter((x) => x.trader !== "Kirill")) {
      expect(t.redacted).toBe(true);
      expect(t.net).toBeNull();
      expect(t.qty).toBeNull();
      for (const l of t.legs) { expect(l.qty).toBeNull(); expect(l.realized).toBeNull(); }
      expect(t.legs.length).toBeGreaterThan(0);
      expect(t.legs.every((l) => l.price > 0 && !!l.at && !!l.role)).toBe(true);
    }
    for (const tr of day.traders.filter((x) => x.name !== "Kirill")) { expect(tr.net).toBeNull(); expect(tr.redacted).toBe(true); }
    const roman = day.trades.find((t) => t.trader === "Roman")!;
    expect(roman.r).toBe(3);
    expect(roman.side).toBe("short");
    expect(roman.result).toBe("win");
  });

  it("no $ or share count anywhere in the JSON for another trader (no price × qty oracle)", () => {
    const json = JSON.stringify(day.trades.filter((t) => t.trader !== "Kirill"));
    expect(json).not.toMatch(/"(qty|realized|net)":\s*[-\d]/);
    expect(json).not.toMatch(/positionBefore|positionAfter|maxPosition|riskUsd|risk_usd|pnl|fees/);
  });

  it("staff see everyone's money", () => {
    const s = buildDeskDay("META", DATE, rows, structures, asStaff);
    expect(s.trades.every((t) => !t.redacted && t.net != null)).toBe(true);
    expect(s.traders.find((t) => t.name === "Roman")!.net).toBe(295);
    expect(s.me).toBe("Admin");
    expect(s.traders.some((t) => t.me)).toBe(false);
  });

  it("guest / anonymous viewer sees no money at all", () => {
    const g = buildDeskDay("META", DATE, rows, structures, { name: null, staff: false });
    expect(g.trades.every((t) => t.redacted && t.net == null)).toBe(true);
  });
});

describe("deskDay — shape", () => {
  const day = buildDeskDay("META", DATE, rows, structures, asTrader);

  it("legs carry roles, direction and times", () => {
    const roman = day.trades.find((t) => t.trader === "Roman")!;
    expect(roman.legs.map((l) => l.role)).toEqual(["entry", "partial_exit", "exit"]);
    expect(roman.legs.map((l) => l.buy)).toEqual([false, true, true]);
    expect(roman.holdSec).toBe(25 * 60);
    const gleb = day.trades.find((t) => t.trader === "Gleb")!;
    expect(gleb.legs.map((l) => l.role)).toContain("add");
    expect(gleb.addedAgainst).toBe(true);
  });

  it("traders sorted best first, trades by entry time", () => {
    expect(day.traders.map((t) => t.name)[0]).toBe("Roman");
    expect(day.trades.map((t) => t.trader)).toEqual(["Kirill", "Roman", "Gleb", "Pavel"]);
  });

  it("empty day", () => {
    const e = buildDeskDay("META", DATE, [], new Map(), asTrader);
    expect(e.traders).toEqual([]);
    expect(e.takeaways).toEqual([]);
  });
});

describe("deskDay — takeaways", () => {
  const day = buildDeskDay("META", DATE, rows, structures, asTrader);

  it("best trade with its entry time from the open", () => {
    const best = day.takeaways.find((t) => t.kind === "best");
    expect(best).toMatchObject({ kind: "best", trader: "Roman", r: 3, side: "short", minutesFromOpen: 15 });
  });

  it("losers who averaged against the move", () => {
    expect(day.takeaways.find((t) => t.kind === "averaging")).toEqual({ kind: "averaging", losers: 2, averaged: 1 });
  });

  it("winners entered earlier than losers", () => {
    const tm = day.takeaways.find((t) => t.kind === "timing");
    expect(tm).toMatchObject({ kind: "timing", winners: 2, losers: 2 });
    if (tm?.kind === "timing") expect(tm.winnersAt < tm.losersAt).toBe(true);
  });

  it("sides split", () => {
    expect(day.takeaways.find((t) => t.kind === "sides")).toEqual({ kind: "sides", long: { traders: 2, winners: 1 }, short: { traders: 2, winners: 1 } });
  });

  it("deterministic and empty for a single trader", () => {
    expect(buildDeskDay("META", DATE, rows, structures, asTrader).takeaways).toEqual(day.takeaways);
    const one = day.traders.slice(0, 1) as DeskTrader[];
    expect(takeaways(one, day.trades as DeskTrade[])).toEqual([]);
  });
});

describe("deskDay — helpers", () => {
  it("dayResult: open wins over everything, then net sign, then R sign", () => {
    expect(dayResult([{ result: "win", netFull: 10, r: 1 }, { result: "open", netFull: null, r: null }])).toBe("open");
    expect(dayResult([{ result: "win", netFull: 10, r: 1 }, { result: "loss", netFull: -30, r: -1 }])).toBe("loss");
    expect(dayResult([{ result: "win", netFull: null, r: 2 }, { result: "loss", netFull: null, r: -1 }])).toBe("win");
    expect(dayResult([{ result: "be", netFull: 0, r: 0 }])).toBe("be");
    expect(dayResult([])).toBeNull();
  });

  it("addedAgainst is false for an add in the trade's favour", () => {
    const r = [trade(10, "X", "Long", { result: "win" })];
    const e = [ex(10, "entry", 100, 10, "09:31"), ex(10, "add", 101, 10, "09:35"), ex(10, "exit", 102, 20, "09:50")];
    expect(addedAgainst(computeStructures(r, e).get(10)!)).toBe(false);
  });
});
