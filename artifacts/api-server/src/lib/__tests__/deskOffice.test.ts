import { describe, expect, it } from "vitest";
import { officeEvents, officePosition } from "../deskOffice";
import { computeStructures, type ExecRowLite, type TradeRowLite } from "../tradeStructureStore";

const DATE = "2026-09-16";
let seq = 0;
const trade = (id: number, trader: string, side: "Long" | "Short"): TradeRowLite & { trader: string } => ({
  id, trader, broker_account: null, ticker: "META", date: DATE, side, stop: null, risk_usd: null, qty: null, result: null,
  source: "propreports", context_snapshot: null,
});
/** ET wall time on DATE (EDT, UTC−4) → ISO. */
const at = (hm: string) => `${DATE}T${String(Number(hm.slice(0, 2)) + 4).padStart(2, "0")}:${hm.slice(3, 5)}:00.000Z`;
const ex = (tradeId: number, kind: ExecRowLite["kind"], price: number, qty: number, hm: string): ExecRowLite => {
  seq++;
  return { id: seq, trade_id: tradeId, kind, price, qty, executed_at: at(hm), sort_order: seq, order_id: null };
};

// Office long build-up: A buys 100 @100 (09:35), B buys 200 @101 (09:40), A adds 100 @102 (09:50) → +400 peak.
// C shorts 100 @103 (10:00) → +300; exits: B sells 200 @104 (10:30) → +100, A sells 200 @105 (10:45) → −100,
// C covers 100 @104.5 (11:00) → 0.
const trades = [trade(1, "A", "Long"), trade(2, "B", "Long"), trade(3, "C", "Short")];
const execs = [
  ex(1, "entry", 100, 100, "09:35"), ex(2, "entry", 101, 200, "09:40"), ex(1, "add", 102, 100, "09:50"),
  ex(3, "entry", 103, 100, "10:00"),
  ex(2, "exit", 104, 200, "10:30"), ex(1, "exit", 105, 200, "10:45"), ex(3, "exit", 104.5, 100, "11:00"),
];
const structures = computeStructures(trades, execs);
const nets = [450, 600, -150];

describe("office position — walk", () => {
  it("signed net position over time (long +, short −)", () => {
    const { events, start } = officeEvents(trades, structures);
    expect(start).toBe(0);
    let p = 0;
    expect(events.map((e) => (p += e.delta))).toEqual([100, 300, 400, 300, 100, -100, 0]);
  });

  it("path per minute as % of the peak; shares only when asked", () => {
    const o = officePosition(trades, structures, nets, true)!;
    expect(o.side).toBe("long");
    expect(o.peakShares).toBe(400);
    expect(o.path.map((x) => x.pct)).toEqual([25, 75, 100, 75, 25, -25, 0]);
    expect(o.path.map((x) => x.shares)).toEqual([100, 300, 400, 300, 100, -100, 0]);
    expect(o.path[0].t).toBe(Date.parse(at("09:35")) / 1000);
    expect(o.peakAt).toBe(new Date(at("09:50")).toISOString());
    const t = officePosition(trades, structures, nets, false)!;
    expect(t.peakShares).toBeNull();
    expect(t.path.every((x) => x.shares === null)).toBe(true);
  });

  it("office VWAP of the main side's opening and closing legs", () => {
    const o = officePosition(trades, structures, nets, false)!;
    // Opening (longs): 100@100 + 200@101 + 100@102 = 40400 / 400 = 101. Closing (longs): 200@104 + 200@105 → 104.5.
    expect(o.avgEntry).toBe(101);
    expect(o.avgExit).toBe(104.5);
  });

  it("main-position zone: 20 % → 80 % of the build-up; exit zone: 80 % → 20 % after the peak", () => {
    const o = officePosition(trades, structures, nets, false)!;
    // 20 % (80 sh) is crossed at 09:35 (+100), 80 % (320 sh) at 09:50 (+400). Fills that grew it: 100@100, 200@101, 100@102.
    expect(o.build).toEqual({ from: new Date(at("09:35")).toISOString(), to: new Date(at("09:50")).toISOString(), low: 100, high: 102, vwap: 101 });
    // Under 80 % (320) at 10:00 (C's short → 300); 100 after B's exit is still above 20 % (80), so the core ends at
    // 10:45 (A's exit → −100). Fills that cut it: 100@103, 200@104, 200@105 → 104.2.
    expect(o.exit).toEqual({ from: new Date(at("10:00")).toISOString(), to: new Date(at("10:45")).toISOString(), low: 103, high: 105, vwap: 104.2 });
  });

  it("contributors = share of the peak position; traders against the office counted", () => {
    const o = officePosition(trades, structures, nets, false)!;
    expect(o.contributors).toEqual([{ trader: "A", share: 0.5 }, { trader: "B", share: 0.5 }]);
    expect(o.against).toBe(0);
    expect(o.traders).toBe(3);
    expect(o.net).toBe(900);
    expect(o.coverage).toBe(1);
  });

  it("no exit zone while the office still holds the core; nothing at all without sized, timed legs", () => {
    const t2 = [trade(11, "A", "Long")];
    const s2 = computeStructures(t2, [ex(11, "entry", 50, 100, "09:31"), ex(11, "trim", 51, 30, "10:00")]);
    const o = officePosition(t2, s2, [null], false)!;
    expect(o.exit).toBeNull();
    expect(o.net).toBeNull();
    expect(o.startPct).toBe(0);
    const s3 = computeStructures(t2, []);
    expect(officePosition(t2, s3, [null], false)).toBeNull();
  });

  it("short office: peak negative, % below zero", () => {
    const t4 = [trade(21, "A", "Short"), trade(22, "B", "Short")];
    const s4 = computeStructures(t4, [ex(21, "entry", 10, 300, "09:31"), ex(22, "entry", 10.2, 100, "09:33"), ex(21, "exit", 9.5, 300, "10:00"), ex(22, "exit", 9.6, 100, "10:05")]);
    const o = officePosition(t4, s4, [150, 60], true)!;
    expect(o.side).toBe("short");
    expect(o.peakShares).toBe(-400);
    expect(o.path.map((x) => x.pct)).toEqual([-75, -100, -25, 0]);
    expect(o.contributors).toEqual([{ trader: "A", share: 0.75 }, { trader: "B", share: 0.25 }]);
  });

  it("a scalp opened and closed inside one minute is not the main position (peak read on minute closes)", () => {
    const t5 = [trade(31, "A", "Short"), trade(32, "B", "Long")];
    const e5: ExecRowLite[] = [
      { ...ex(31, "entry", 20, 500, "09:30"), executed_at: `${DATE}T13:30:05.000Z` },
      { ...ex(31, "exit", 19.9, 500, "09:30"), executed_at: `${DATE}T13:30:40.000Z` },
      ex(32, "entry", 20.1, 200, "09:40"), ex(32, "exit", 20.5, 200, "10:10"),
    ];
    const o = officePosition(t5, computeStructures(t5, e5), [50, 80], true)!;
    expect(o.side).toBe("long");
    expect(o.peakShares).toBe(200);
    expect(o.path.map((x) => x.pct)).toEqual([0, 100, 0]);
    expect(o.build?.vwap).toBe(20.1);
  });
});
