import { describe, expect, it } from "vitest";
import { alertLabel, sideLabel, stopMessage } from "./labels";
import type { RiskStop } from "./use-risk";

const stop = (over: Partial<RiskStop>): RiskStop => ({
  state: "ok", label: "", message: "server text", halted: false,
  dailyRemainingUsd: null, weeklyRemainingUsd: null, drawdownRemainingUsd: null,
  dailyPct: null, weeklyPct: null, drawdownPct: null, ...over,
});
const metrics = (s: RiskStop, today: number | null, week: number | null = today, dd = 0) => ({
  stop: s,
  today: { pnlNet: today } as never,
  week: { pnlNet: week } as never,
  drawdown: { currentUsd: dd } as never,
});
const limits = { dailyLossLimit: 500, weeklyLossLimit: 1500, maxDrawdown: 3000 } as never;

describe("stopMessage (RU default)", () => {
  it("daily stop names the limit and both amounts", () => {
    const m = metrics(stop({ state: "stop", halted: true, dailyRemainingUsd: 0, dailyPct: 104 }), -520);
    expect(stopMessage(m, limits)).toBe("Дневной лимит убытка исчерпан: −$520 из $500.");
  });
  it("weekly stop", () => {
    const m = metrics(stop({ state: "weekly", halted: true, weeklyRemainingUsd: 0, weeklyPct: 100 }), -100, -1500);
    expect(stopMessage(m, limits)).toBe("Недельный лимит убытка исчерпан: −$1,500 из $1,500.");
  });
  it("warn lists only the limits at ≥ 70%", () => {
    const m = metrics(stop({ state: "warn", dailyRemainingUsd: 120, dailyPct: 76, weeklyRemainingUsd: 1120, weeklyPct: 25 }), -380, -380);
    expect(stopMessage(m, limits)).toBe("Дневной лимит убытка: осталось $120 (использовано 76%)");
  });
  it("derives the limit when limits are missing", () => {
    const m = metrics(stop({ state: "stop", halted: true, dailyRemainingUsd: 0, dailyPct: 120 }), -600);
    expect(stopMessage(m, null)).toBe("Дневной лимит убытка исчерпан: −$600 из $500.");
  });
});

describe("labels", () => {
  it("maps alert kinds and falls back to the server label", () => {
    expect(alertLabel({ kind: "overnight_not_allowed", label: "x" })).toBe("Овернайт запрещён");
    expect(alertLabel({ kind: "future_kind", label: "Сервер" })).toBe("Сервер");
  });
  it("normalises the side", () => {
    expect(sideLabel("SHORT")).toBe("Шорт");
    expect(sideLabel("лонг")).toBe("Лонг");
    expect(sideLabel(null)).toBe("—");
  });
});
