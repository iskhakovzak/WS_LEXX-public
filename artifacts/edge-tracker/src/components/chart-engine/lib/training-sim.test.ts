import { describe, expect, it } from "vitest";
import {
  EMPTY_SIM, canBreakeven, historyStats, idealMove, parseHistory, plannedRR, scoreTraining, sessionSlice, simApplyBar, simBreakeven, simFillLabel, simLiveR, simMark,
  simOrder, simSetStop, simSetTarget, stopInvalid, suggestStop, targetAtRR, targetInvalid, trainingVerdict, winStreak,
  type TrainingRecord,
} from "./training-sim";
import { buildTradeSummary, fmtPerShare } from "./trade-summary";

describe("training simulator — orders", () => {
  it("opens, adds and closes a long with realised P&L", () => {
    let s = simOrder(EMPTY_SIM, { action: "buy", idx: 1, t: 1, price: 10, qty: 100, stop: 9.8 });
    expect(s.pos).toBe(100);
    expect(s.avg).toBe(10);
    expect(s.stop).toBe(9.8);
    expect(s.firstRiskUsd).toBeCloseTo(20);
    s = simOrder(s, { action: "buy", idx: 2, t: 2, price: 10.2, qty: 100 });
    expect(s.pos).toBe(200);
    expect(s.avg).toBeCloseTo(10.1);
    expect(s.stop).toBe(9.8); // adding without a stop keeps the stop
    s = simOrder(s, { action: "flat", idx: 3, t: 3, price: 10.5 });
    expect(s.pos).toBe(0);
    expect(s.avg).toBeNull();
    expect(s.stop).toBeNull();
    expect(s.realized).toBeCloseTo(80); // 200 × 0.40
    expect(s.roundTrips).toBe(1);
    expect(s.maxAbs).toBe(200);
  });

  it("shorts and covers; a bigger opposite order reverses", () => {
    let s = simOrder(EMPTY_SIM, { action: "sell", idx: 1, t: 1, price: 20, qty: 50 });
    expect(s.pos).toBe(-50);
    s = simOrder(s, { action: "buy", idx: 2, t: 2, price: 19.5, qty: 80 });
    expect(s.realized).toBeCloseTo(25);
    expect(s.pos).toBe(30);
    expect(s.avg).toBe(19.5);
    expect(simMark(s, 20).total).toBeCloseTo(25 + 15);
  });

  it("ignores empty orders and a stop on the wrong side", () => {
    expect(simOrder(EMPTY_SIM, { action: "buy", idx: 1, t: 1, price: 10, qty: 0 })).toBe(EMPTY_SIM);
    expect(simOrder(EMPTY_SIM, { action: "flat", idx: 1, t: 1, price: 10 })).toBe(EMPTY_SIM);
    const s = simOrder(EMPTY_SIM, { action: "buy", idx: 1, t: 1, price: 10, qty: 10, stop: 10.5 });
    expect(s.stop).toBeNull();
    expect(stopInvalid(1, 10, 10.5)).toBe(true);
    expect(stopInvalid(-1, 10, 10.5)).toBe(false);
    expect(simSetStop(s, 10.2, 10)).toBe(s);
    expect(simSetStop(s, 9.5, 10).stop).toBe(9.5);
  });

  it("triggers the stop on a later bar, at the stop or the gap open", () => {
    const s = simOrder(EMPTY_SIM, { action: "buy", idx: 1, t: 1, price: 10, qty: 100, stop: 9.8 });
    expect(simApplyBar(s, { t: 2, o: 9.95, h: 10, l: 9.85 }, 2)).toBe(s);
    const hit = simApplyBar(s, { t: 3, o: 9.9, h: 9.95, l: 9.7 }, 3);
    expect(hit.pos).toBe(0);
    expect(hit.realized).toBeCloseTo(-20);
    expect(hit.fills.at(-1)?.reason).toBe("stop");
    const gap = simApplyBar(s, { t: 3, o: 9.6, h: 9.7, l: 9.5 }, 3);
    expect(gap.realized).toBeCloseTo(-40);
    const short = simOrder(EMPTY_SIM, { action: "sell", idx: 1, t: 1, price: 10, qty: 10, stop: 10.3 });
    expect(simApplyBar(short, { t: 2, o: 10.1, h: 10.4, l: 10 }, 2).realized).toBeCloseTo(-3);
  });
});

describe("training simulator — scale out, target, breakeven", () => {
  it("«½» closes half (rounded down), a 1-share position fully", () => {
    let s = simOrder(EMPTY_SIM, { action: "buy", idx: 1, t: 1, price: 10, qty: 301, stop: 9.5 });
    s = simOrder(s, { action: "half", idx: 2, t: 2, price: 11 });
    expect(s.pos).toBe(151);
    expect(s.realized).toBeCloseTo(150);
    expect(s.stop).toBe(9.5); // a partial keeps the stop
    expect(s.fills.at(-1)?.reason).toBe("half");
    expect(simFillLabel(s.fills.at(-1)!)).toBe("Половина");
    const one = simOrder(simOrder(EMPTY_SIM, { action: "sell", idx: 1, t: 1, price: 10, qty: 1 }), { action: "half", idx: 2, t: 2, price: 9 });
    expect(one.pos).toBe(0);
    expect(simOrder(EMPTY_SIM, { action: "half", idx: 1, t: 1, price: 10 })).toBe(EMPTY_SIM);
  });

  it("a target on the right side fills on a later bar at the target or a gap open; the stop wins on a bar that hits both", () => {
    const s = simOrder(EMPTY_SIM, { action: "buy", idx: 1, t: 1, price: 10, qty: 100, stop: 9.8, target: 10.5 });
    expect(s.target).toBe(10.5);
    const tp = simApplyBar(s, { t: 2, o: 10.2, h: 10.6, l: 10.1 }, 2);
    expect(tp.pos).toBe(0);
    expect(tp.realized).toBeCloseTo(50);
    expect(tp.fills.at(-1)?.reason).toBe("target");
    expect(tp.target).toBeNull();
    expect(simApplyBar(s, { t: 2, o: 10.7, h: 10.9, l: 10.6 }, 2).realized).toBeCloseTo(70); // gap above the target
    expect(simApplyBar(s, { t: 2, o: 10, h: 10.6, l: 9.7 }, 2).fills.at(-1)?.reason).toBe("stop");
    const short = simOrder(EMPTY_SIM, { action: "sell", idx: 1, t: 1, price: 10, qty: 10, target: 9.5 });
    expect(simApplyBar(short, { t: 2, o: 9.8, h: 9.9, l: 9.4 }, 2).realized).toBeCloseTo(5);
  });

  it("rejects a target on the wrong side; moves it on the open position", () => {
    expect(targetInvalid(1, 10, 9.9)).toBe(true);
    expect(targetInvalid(-1, 10, 9.9)).toBe(false);
    const s = simOrder(EMPTY_SIM, { action: "buy", idx: 1, t: 1, price: 10, qty: 10, target: 9.9 });
    expect(s.target).toBeNull();
    expect(simSetTarget(s, 9.9, 10)).toBe(s);
    expect(simSetTarget(s, 11, 10).target).toBe(11);
    expect(simSetTarget(EMPTY_SIM, 11, 10)).toBe(EMPTY_SIM);
  });

  it("breakeven only once the price is beyond the average in profit", () => {
    const s = simOrder(EMPTY_SIM, { action: "buy", idx: 1, t: 1, price: 10, qty: 10, stop: 9.5 });
    expect(canBreakeven(s, 9.9)).toBe(false);
    expect(simBreakeven(s, 9.9)).toBe(s);
    expect(canBreakeven(s, 10.3)).toBe(true);
    const be = simBreakeven(s, 10.3);
    expect(be.stop).toBe(10);
    expect(canBreakeven(be, 10.3)).toBe(false);
    const short = simOrder(EMPTY_SIM, { action: "sell", idx: 1, t: 1, price: 20, qty: 10 });
    expect(simBreakeven(short, 19.5).stop).toBe(20);
  });

  it("planned R:R, target at R and live R", () => {
    expect(plannedRR(10, 9.8, 10.6)).toBeCloseTo(3);
    expect(plannedRR(10, 10.2, 9.5)).toBeCloseTo(2.5);
    expect(plannedRR(10, 9.8, 9.7)).toBeNull(); // both below
    expect(plannedRR(10, null, 11)).toBeNull();
    expect(targetAtRR(10, 9.8, 2)).toBeCloseTo(10.4);
    expect(targetAtRR(10, 10.25, 2)).toBeCloseTo(9.5);
    expect(targetAtRR(10, null, 2)).toBeNull();
    const s = simOrder(EMPTY_SIM, { action: "buy", idx: 1, t: 1, price: 10, qty: 100, stop: 9.8 });
    expect(simLiveR(s, 10.4)).toBeCloseTo(2);
    expect(simLiveR(s, 9.9)).toBeCloseTo(-0.5);
    expect(simLiveR(simOrder(EMPTY_SIM, { action: "buy", idx: 1, t: 1, price: 10, qty: 1 }), 11)).toBeNull();
  });
});

describe("training simulator — ideal and score", () => {
  const closes = [10, 9.5, 10.5, 11, 10.2, 9, 9.4];

  it("finds the best single round trip either way", () => {
    expect(idealMove(closes, 0, 6)).toEqual({ perShare: 2, side: "short", fromIdx: 3, toIdx: 5 });
    expect(idealMove(closes, 0, 3)).toEqual({ perShare: 1.5, side: "long", fromIdx: 1, toIdx: 3 });
    expect(idealMove([5, 5, 5], 0, 2)).toBeNull();
    expect(idealMove(closes, 3, 3)).toBeNull();
  });

  it("scores the captured share of the ideal and compares with the real trade", () => {
    let s = simOrder(EMPTY_SIM, { action: "buy", idx: 1, t: 1, price: 9.5, qty: 100, stop: 9.0 });
    s = simOrder(s, { action: "flat", idx: 3, t: 3, price: 10.7 });
    const o = scoreTraining(s, { lastClose: 10.7, ideal: idealMove(closes, 0, 3), real: { side: "long", avgEntry: 9.6, avgExit: 10.1, risk: 0.3 } });
    expect(o.pnlUsd).toBeCloseTo(120);
    expect(o.perShare).toBeCloseTo(1.2);
    expect(o.r).toBeCloseTo(120 / 50);
    expect(o.score).toBe(80);
    expect(o.realPerShare).toBeCloseTo(0.5);
    expect(o.realR).toBeCloseTo(0.5 / 0.3);
    expect(o.vsRealPerShare).toBeCloseTo(0.7);
    expect(o.trades).toBe(1);
    expect(trainingVerdict(o).tone).toBe("up");
  });

  it("marks an open paper position, scores losses as 0 and handles no trades", () => {
    const open = simOrder(EMPTY_SIM, { action: "sell", idx: 1, t: 1, price: 10, qty: 10 });
    const o = scoreTraining(open, { lastClose: 10.5, ideal: { perShare: 1, side: "long", fromIdx: 0, toIdx: 2 }, real: { side: "short", avgEntry: null, avgExit: null, risk: null } });
    expect(o.pnlUsd).toBeCloseTo(-5);
    expect(o.score).toBe(0);
    expect(o.r).toBeNull();
    expect(o.realPerShare).toBeNull();
    expect(trainingVerdict(o).tone).toBe("down");
    const none = scoreTraining(EMPTY_SIM, { lastClose: 10, ideal: null, real: { side: "long", avgEntry: 10, avgExit: 11, risk: null } });
    expect(none.trades).toBe(0);
    expect(none.score).toBeNull();
    expect(none.perShare).toBeNull();
    expect(trainingVerdict(none).tone).toBe("neutral");
  });

  it("a ticker-day task (no real trade) has nothing to compare with", () => {
    const s = simOrder(simOrder(EMPTY_SIM, { action: "buy", idx: 1, t: 1, price: 10, qty: 10 }), { action: "flat", idx: 2, t: 2, price: 10.5 });
    const o = scoreTraining(s, { lastClose: 10.5, ideal: null, real: null });
    expect([o.realPerShare, o.realR, o.vsRealPerShare]).toEqual([null, null, null]);
    expect(o.pnlUsd).toBeCloseTo(5);
  });

  it("suggests a stop beyond the recent extreme", () => {
    const bars = [{ h: 10.2, l: 9.9 }, { h: 10.3, l: 9.95 }, { h: 10.4, l: 10.1 }];
    expect(suggestStop(bars, 2, 1, 3)).toBeCloseTo(9.89);
    expect(suggestStop(bars, 2, -1, 2)).toBeCloseTo(10.41);
    expect(suggestStop(bars, 5, 1)).toBeNull();
  });
});

describe("training history", () => {
  const rec = (pnlUsd: number, score: number | null, trades = 1, vs: number | null = null): TrainingRecord => ({ at: 1, tradeId: 1, ticker: "X", day: "2026-10-15", score, pnlUsd, r: null, perShare: null, vsRealPerShare: vs, trades });

  it("parses defensively", () => {
    expect(parseHistory(null)).toEqual([]);
    expect(parseHistory("{bad")).toEqual([]);
    expect(parseHistory(JSON.stringify([rec(1, 50), { junk: true }]))).toHaveLength(1);
  });

  it("counts the streak from the newest attempt and averages", () => {
    const list = [rec(10, 80, 1, 0.1), rec(5, 40), rec(-3, 0), rec(20, 90)];
    expect(winStreak(list)).toBe(2);
    const st = historyStats(list);
    expect(st.count).toBe(4);
    expect(st.avgScore).toBe(53);
    expect(st.plusShare).toBe(0.75);
    expect(st.beatReal).toBe(1);
    expect(winStreak([rec(0, null, 0), rec(5, 50)])).toBe(0);
  });

  it("R averages, «vs trader» and the session slice", () => {
    const list: TrainingRecord[] = [
      { ...rec(10, 80, 1, 0.2), at: 300, r: 2, realR: 1 },
      { ...rec(-5, 0, 1, -0.1), at: 200, r: -1, realR: 0.5 },
      { ...rec(0, null, 0), at: 100 },
    ];
    const st = historyStats(list);
    expect(st.avgR).toBeCloseTo(0.5);
    expect(st.sumR).toBeCloseTo(1);
    expect(st.avgRealR).toBeCloseTo(0.75);
    expect([st.beatReal, st.comparable]).toEqual([1, 2]);
    expect(sessionSlice(list, 200)).toHaveLength(2);
    expect(historyStats([]).avgR).toBeNull();
  });
});

describe("trade summary", () => {
  it("derives per-share, R, capture and left on the table from prices", () => {
    const s = buildTradeSummary({
      side: "short", avgEntry: 20, avgExit: 19.6, risk: 0.2,
      excursion: { mfe: 0.8, mae: 0.1, mfeUsd: null, maeUsd: null, mfePct: null, maePct: null, mfeR: null, maeR: null, mfeAt: 500, maeAt: 400, mfePrice: 19.2, maePrice: 20.1, approximate: false, barsUsed: 10 },
      entryTime: 100, exitTime: 700, pnlUsd: null,
    });
    expect(s.perShare).toBeCloseTo(0.4);
    expect(s.pct).toBeCloseTo(2);
    expect(s.r).toBeCloseTo(2);
    expect(s.mfeR).toBeCloseTo(4);
    expect(s.maeR).toBeCloseTo(0.5);
    expect(s.capture).toBeCloseTo(0.5);
    expect(s.leftPerShare).toBeCloseTo(0.4);
    expect(s.bestExitPrice).toBe(19.2);
    expect(s.holdSec).toBe(600);
    expect(s.pnlUsd).toBeNull();
  });

  it("formats per-share moves in cents below a dollar", () => {
    expect(fmtPerShare(0.123)).toBe("+12¢");
    expect(fmtPerShare(-0.05)).toBe("−5.0¢");
    expect(fmtPerShare(1.5)).toBe("+$1.50");
    expect(fmtPerShare(null)).toBe("—");
  });
});
