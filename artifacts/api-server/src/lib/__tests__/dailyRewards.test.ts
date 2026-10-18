/**
 * Discipline rewards: the progressive contract scale (growth, cap, penalty, reset / halve, days without a contract),
 * level thresholds, the points window, every badge rule, idempotent awarding (in-memory trader_badges; a second run
 * awards and notifies nothing; history older than NOTIFY_DAYS is awarded quietly) and the Telegram evening line.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EveningCard } from "../daily/types";

const badgesTable = new Map<string, { badge: string; awarded_on: string; target: number }>();
vi.mock("@workspace/db", () => ({
  db: {},
  pool: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/INSERT INTO trader_badges/.test(sql)) {
        const [trader, badge, on, target] = params as [string, string, string, number];
        const k = `${trader}|${badge}`;
        if (badgesTable.has(k)) return { rows: [], rowCount: 0 };
        badgesTable.set(k, { badge, awarded_on: on, target });
        return { rows: [{ badge }], rowCount: 1 };
      }
      if (/FROM trader_badges/.test(sql)) {
        const rows = [...badgesTable].filter(([k]) => k.startsWith(`${params[0]}|`)).map(([, v]) => v);
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    }),
  },
}));
const notify = vi.hoisted(() => ({ notifyUser: vi.fn(async () => 1) }));
vi.mock("../notifyUtils", () => notify);
vi.mock("../../routes/behavior", () => ({ loadBehaviorRows: vi.fn(async () => []), rowToBehaviorTrade: vi.fn() }));
vi.mock("../rulesEngine", () => ({ fetchRiskLimits: vi.fn(async () => ({ dailyLossLimit: null })) }));

const d = await import("../daily/discipline");
const b = await import("../daily/badges");
const rewards = await import("../daily/rewards");
const { rewardsLine } = await import("../daily/telegramText");

const cfg = { kept: 5, broken: -15, step: 1, cap: 10, onBreak: "reset" as const };
const kept1 = ["kept", "unset", "unset"] as const;
const broken1 = ["broken", "kept", "unset"] as const;
const none = ["no_trades", "no_trades", "unset"] as const;
/** Weekdays from 2026-09-01 (Tue). */
function weekdays(n: number, from = "2026-09-01"): string[] {
  const out: string[] = [];
  let x = new Date(`${from}T12:00:00Z`);
  while (out.length < n) {
    const wd = x.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(x.toISOString().slice(0, 10));
    x = new Date(x.getTime() + 86_400_000);
  }
  return out;
}

describe("progressive contract scale", () => {
  it("defaults: +5 / −15 per item, step 1, cap 10, reset", () => {
    expect(d.scaleConfig()).toEqual(cfg);
  });

  it("kept days grow the bonus by the step, up to the cap", () => {
    const days = weekdays(14).map((date) => ({ date, items: kept1 }));
    const l = d.scaleLedger(days, cfg);
    expect(l.slice(0, 4).map((x) => x.points)).toEqual([5, 6, 7, 8]);
    expect(l[10]!.points).toBe(15); // day 11: 5 + cap 10
    expect(l[13]!.points).toBe(15);
    expect(l[13]!.streak).toBe(14);
  });

  it("each item counts; the streak bonus is per day", () => {
    const l = d.scaleLedger(weekdays(2).map((date) => ({ date, items: ["kept", "kept", "kept"] as const })), cfg);
    expect(l.map((x) => x.points)).toEqual([15, 16]);
  });

  it("a broken item applies the penalty (kept items still count) and resets the streak", () => {
    const [a, b2, c, e] = weekdays(4);
    const l = d.scaleLedger([{ date: a!, items: kept1 }, { date: b2!, items: kept1 }, { date: c!, items: broken1 }, { date: e!, items: kept1 }], cfg);
    expect(l.map((x) => x.points)).toEqual([5, 6, -10, 5]);
    expect(l.map((x) => x.streak)).toEqual([1, 2, 0, 1]);
  });

  it("«halve» keeps half the streak after a broken day", () => {
    const days = weekdays(7).map((date, i) => ({ date, items: i === 5 ? broken1 : kept1 }));
    const l = d.scaleLedger(days, { ...cfg, onBreak: "halve" });
    expect(l[5]!.streak).toBe(2); // 5 → 2
    expect(l[6]!.points).toBe(5 + 2); // bonus from the kept half
  });

  it("days without a verdict (no trades / unknown / unset) neither break nor grow the streak", () => {
    const [a, b2, c] = weekdays(3);
    const l = d.scaleLedger([{ date: a!, items: kept1 }, { date: b2!, items: none }, { date: c!, items: kept1 }], cfg);
    expect(l.map((x) => [x.points, x.streak])).toEqual([[5, 1], [0, 1], [6, 2]]);
  });

  it("an all-unknown day is «none»; order of input does not matter", () => {
    expect(d.outcomeOf(["unknown", "unset", "unset"])).toBe("none");
    const [a, b2] = weekdays(2);
    expect(d.scaleLedger([{ date: b2!, items: kept1 }, { date: a!, items: kept1 }], cfg).map((x) => x.date)).toEqual([a, b2]);
  });
});

describe("levels and the summary", () => {
  const th = [0, 50, 150, 400, 800];
  it("default thresholds", () => expect(d.levelThresholds()).toEqual(th));
  it("level by all-time points", () => {
    expect(d.levelOf(0, th)).toEqual({ level: 0, levelFrom: 0, nextLevelAt: 50 });
    expect(d.levelOf(49, th).level).toBe(0);
    expect(d.levelOf(50, th)).toEqual({ level: 1, levelFrom: 50, nextLevelAt: 150 });
    expect(d.levelOf(420, th)).toEqual({ level: 3, levelFrom: 400, nextLevelAt: 800 });
    expect(d.levelOf(5000, th)).toEqual({ level: 4, levelFrom: 800, nextLevelAt: null });
  });
  it("30 trading days window, all-time total, streak and next bonus", () => {
    expect(d.windowStart("2026-10-16", 5)).toBe("2026-10-12");
    expect(d.windowStart("2026-10-18", 1)).toBe("2026-10-16"); // Sunday → back to Friday
    const days = [...weekdays(3, "2026-08-03").map((date) => ({ date, items: broken1 })), ...weekdays(4, "2026-10-13").map((date) => ({ date, items: kept1 }))];
    const s = d.summaryOf(d.scaleLedger(days, cfg), "2026-10-16", { cfg, thresholds: th, windowDays: 30 });
    expect(s.points30).toBe(5 + 6 + 7 + 8);
    expect(s.pointsTotal).toBe(26 - 30);
    expect(s).toMatchObject({ streak: 4, bestStreak: 4, nextBonus: 4, level: 0, levelFrom: 0, nextLevelAt: 50 });
  });
  it("lastFinishedDay: before the close → previous weekday; after → today; weekend → Friday", () => {
    expect(d.lastFinishedDay(new Date("2026-10-19T14:00:00Z"))).toBe("2026-10-16"); // Mon 10:00 NY
    expect(d.lastFinishedDay(new Date("2026-10-19T21:00:00Z"))).toBe("2026-10-19"); // Mon 17:00 NY
    expect(d.lastFinishedDay(new Date("2026-10-18T21:00:00Z"))).toBe("2026-10-16"); // Sunday
  });
});

describe("badge rules", () => {
  it("contract streak badges: the day the streak reached the target", () => {
    const l = d.scaleLedger(weekdays(6).map((date) => ({ date, items: kept1 })), cfg);
    expect(b.streakRule(l, 5)).toEqual({ earnedOn: weekdays(6)[4], progress: 5, target: 5 });
    expect(b.streakRule(l, 10)).toEqual({ earnedOn: null, progress: 6, target: 10 });
  });

  it("reviews: on time = that day or the next trading day; a late / missing review breaks the run; the last day may wait", () => {
    expect(b.reviewedOnTime({ date: "2026-10-16", reviewedOn: "2026-10-19" })).toBe(true); // Fri → Mon
    expect(b.reviewedOnTime({ date: "2026-10-16", reviewedOn: "2026-10-20" })).toBe(false);
    const days = weekdays(4).map((date) => ({ date, reviewedOn: date }));
    expect(b.reviewsRule(days, 3, days[3]!.date).earnedOn).toBe(days[2]!.date);
    const gap = days.map((x, i) => (i === 1 ? { ...x, reviewedOn: null } : x));
    expect(b.reviewsRule(gap, 3, days[3]!.date)).toEqual({ earnedOn: null, progress: 2, target: 3 });
    const lastOpen = days.map((x, i) => (i === 3 ? { ...x, reviewedOn: null } : x));
    expect(b.reviewsRule(lastOpen, 4, days[3]!.date).progress).toBe(3);
  });

  it("focus: kept days in a row; broken resets; disputed / no trades / unknown skipped", () => {
    const [a, b2, c, e, f] = weekdays(5);
    const days = [
      { date: a!, status: "kept", disputed: false }, { date: b2!, status: "broken", disputed: false },
      { date: c!, status: "kept", disputed: false }, { date: e!, status: "no_trades", disputed: false }, { date: f!, status: "broken", disputed: true },
    ];
    expect(b.focusRule(days, 2)).toEqual({ earnedOn: null, progress: 1, target: 2 });
    expect(b.focusRule([...days, { date: "2026-09-08", status: "kept", disputed: false }], 2).earnedOn).toBe("2026-09-08");
  });

  it("clean month: a finished month with enough days, the stop known on each and never reached", () => {
    const sept = weekdays(12, "2026-09-01").map((date) => ({ date, trough: -100, limit: 300 }));
    expect(b.cleanMonthRule(sept, 10, "2026-10-16")).toEqual({ earnedOn: sept[11]!.date, progress: 10, target: 10 });
    expect(b.cleanMonthRule(sept, 10, "2026-09-30").earnedOn).toBeNull(); // the month is not over
    const hit = sept.map((x, i) => (i === 3 ? { ...x, trough: -300 } : x));
    expect(b.cleanMonthRule(hit, 10, "2026-10-16").earnedOn).toBeNull();
    const unknown = sept.map((x, i) => (i === 3 ? { ...x, limit: null } : x));
    expect(b.cleanMonthRule(unknown, 10, "2026-10-16").earnedOn).toBeNull();
    expect(b.cleanMonthRule(sept.slice(0, 9), 10, "2026-10-16").earnedOn).toBeNull();
    const oct = weekdays(4, "2026-10-01").map((date) => ({ date, trough: -50, limit: 300 }));
    expect(b.cleanMonthRule(oct, 10, "2026-10-16").progress).toBe(4);
  });

  it("simulator: first finished own game; the 3rd «better» verdict", () => {
    const games = [
      { finishedOn: "2026-10-02", verdict: "worse" }, { finishedOn: "2026-10-05", verdict: "better" },
      { finishedOn: "2026-10-07", verdict: "better" }, { finishedOn: "2026-10-09", verdict: "skipped" }, { finishedOn: "2026-10-12", verdict: "better" },
    ];
    expect(b.simFirstRule(games)).toEqual({ earnedOn: "2026-10-02", progress: 1, target: 1 });
    expect(b.simFirstRule([])).toEqual({ earnedOn: null, progress: 0, target: 1 });
    expect(b.simBeatRule(games, 3)).toEqual({ earnedOn: "2026-10-12", progress: 3, target: 3 });
    expect(b.simBeatRule(games.slice(0, 3), 3)).toEqual({ earnedOn: null, progress: 2, target: 3 });
  });

  it("badge states: an awarded badge keeps its stored day; others show progress", () => {
    const res = b.evaluateBadges({ ledger: [], reviews: [], focus: [], stops: [], games: [], asOf: "2026-10-16" }, rewards.badgeTargets());
    const states = b.badgeStates(res, new Map([["sim_first", { date: "2026-10-01", target: 1 }]]));
    expect(states.map((s) => s.id)).toEqual([...b.BADGE_IDS]);
    expect(states.find((s) => s.id === "sim_first")).toEqual({ id: "sim_first", earnedOn: "2026-10-01", target: 1, progress: 1 });
    expect(states.find((s) => s.id === "streak_2")).toEqual({ id: "streak_2", earnedOn: null, target: 10, progress: 0 });
  });
});

describe("awarding", () => {
  beforeEach(() => { badgesTable.clear(); notify.notifyUser.mockClear(); });
  const results = () => {
    const r = b.evaluateBadges({ ledger: [], reviews: [], focus: [], stops: [], games: [], asOf: "2026-10-16" }, rewards.badgeTargets());
    r.sim_first = { earnedOn: "2026-10-15", progress: 1, target: 1 };
    r.clean_month = { earnedOn: "2026-03-31", progress: 10, target: 10 };
    return r;
  };

  it("awards once, notifies only recent badges, a second run awards nothing", async () => {
    const first = await rewards.awardBadges("Кирилл Б.", results(), new Map(), "2026-10-16");
    expect(first.map((x) => x.id).sort()).toEqual(["clean_month", "sim_first"]);
    expect(notify.notifyUser).toHaveBeenCalledTimes(1);
    expect(notify.notifyUser).toHaveBeenCalledWith(expect.objectContaining({ userName: "Кирилл Б.", type: "discipline_badge", params: expect.objectContaining({ variant: "sim_first", count: 1 }) }));
    const again = await rewards.awardBadges("Кирилл Б.", results(), new Map(), "2026-10-16"); // a racing process: the PK says no
    expect(again).toEqual([]);
    const awarded = await rewards.awardedBadges("Кирилл Б.");
    expect(await rewards.awardBadges("Кирилл Б.", results(), awarded, "2026-10-16")).toEqual([]);
    expect(notify.notifyUser).toHaveBeenCalledTimes(1);
    expect(await rewards.badgesOn("Кирилл Б.", "2026-10-15")).toEqual([{ id: "sim_first", target: 1 }]);
  });
});

describe("Telegram evening line", () => {
  const card = (over: Partial<EveningCard>): EveningCard => ({
    trader: "Кирилл Б.", date: "2026-10-16", trades: 3, netPnl: 50, focus: null, tradeToReview: null, deskSameTicker: null, reviewed: false, reviewNote: null,
    contract: { date: "2026-10-16", maxLoss: { limit: 300, actual: -40, status: "kept" }, maxTrades: { limit: null, actual: 3, status: "unset" }, rule: { mistake: null, status: "unset" }, disciplineDelta: 8 },
    ...over,
  });
  it("a new badge wins; else the streak on a kept day; nothing on a broken day", () => {
    expect(rewardsLine("ru", card({ rewards: { streak: 4, badges: [{ id: "streak_1", target: 5 }] } }))).toBe("🏅 Новая награда: контракт 5 дней подряд");
    expect(rewardsLine("ru", card({ rewards: { streak: 4, badges: [] } }))).toBe("🔥 Контракт соблюдён 4 дня подряд · +8 к дисциплине");
    expect(rewardsLine("en", card({ rewards: { streak: 1, badges: [] } }))).toBe("🔥 Contract kept 1 day in a row · +8 to discipline");
    expect(rewardsLine("uz", card({ rewards: { streak: 0, badges: [] } }))).toBeNull();
    expect(rewardsLine("ru", card({ rewards: null }))).toBeNull();
  });
});
