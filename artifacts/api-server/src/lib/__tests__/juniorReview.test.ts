import { describe, expect, it } from "vitest";
import {
  attentionOf, buildDayTrades, buildReviewScope, canReviewTrader, mistakeKeys, missedRun, repeatedMistakes,
  reviewTraderFilter, scoreTrend, type ContextTradeRow, type ReviewScopeInput,
} from "../juniorReview";
import { canSeeTradeMoney } from "../playbookPrivacy";

const base: ReviewScopeInput = {
  me: "Антон", guest: false, capAllowed: false, capScope: null, wards: [], mentees: [], curated: [],
};

describe("buildReviewScope / canReviewTrader", () => {
  it("curator with desk-scoped journal.review reviews everyone but himself", () => {
    const s = buildReviewScope({ ...base, capAllowed: true, capScope: "desk", curated: ["Умид"], mentees: ["Закир", "Антон"] });
    expect(s).toEqual({ kind: "desk", mine: ["Закир", "Умид"] });
    expect(canReviewTrader(s, "Максат", "Антон")).toBe(true);
    expect(canReviewTrader(s, "Антон", "Антон")).toBe(false);
    expect(reviewTraderFilter(s, false)).toBeNull();
    expect(reviewTraderFilter(s, true)).toEqual(["Закир", "Умид"]);
  });

  it("trader who mentors juniors reviews only the mentees", () => {
    const s = buildReviewScope({ ...base, me: "Артур", mentees: ["Умид", "Максат", "Умид", " "] });
    expect(s).toEqual({ kind: "scoped", via: "mentor", traders: ["Максат", "Умид"], mine: ["Максат", "Умид"] });
    expect(canReviewTrader(s, "Умид", "Артур")).toBe(true);
    expect(canReviewTrader(s, "Закир", "Артур")).toBe(false);
    expect(reviewTraderFilter(s, false)).toEqual(["Максат", "Умид"]);
  });

  it("trader without mentees cannot review anyone", () => {
    const s = buildReviewScope({ ...base, me: "Закир" });
    expect(s.kind).toBe("none");
    expect(canReviewTrader(s, "Умид", "Закир")).toBe(false);
    expect(reviewTraderFilter(s, false)).toEqual([]);
  });

  it("assigned-scope grant merges wards and mentees", () => {
    const s = buildReviewScope({ ...base, capAllowed: true, capScope: "assigned", wards: ["Умид"], mentees: ["Закир"] });
    expect(s).toMatchObject({ kind: "scoped", via: "assigned", traders: ["Закир", "Умид"] });
    expect(canReviewTrader(s, "Максат", "Антон")).toBe(false);
  });

  it("guest never reviews, even with mentees listed", () => {
    expect(buildReviewScope({ ...base, guest: true, capAllowed: true, capScope: "desk" }).kind).toBe("none");
    expect(buildReviewScope({ ...base, me: "" , mentees: ["Умид"] }).kind).toBe("none");
  });

  it("empty trader name is never reviewable", () => {
    const s = buildReviewScope({ ...base, capAllowed: true, capScope: "desk" });
    expect(canReviewTrader(s, "", "Антон")).toBe(false);
    expect(canReviewTrader(s, null, "Антон")).toBe(false);
  });
});

describe("missedRun", () => {
  it("counts consecutive trading days without a note, skipping weekends", () => {
    // 2026-10-16 is a Friday.
    const dates = new Set(["2026-10-12", "2026-10-13"]);
    expect(missedRun(dates, "2026-10-16")).toBe(3); // Wed, Thu, Fri
    expect(missedRun(dates, "2026-10-18")).toBe(3); // Sunday → starts from Friday
    expect(missedRun(new Set(["2026-10-16"]), "2026-10-16")).toBe(0);
    expect(missedRun(new Set(["2026-10-09"]), "2026-10-12")).toBe(1); // Monday after a written Friday
  });

  it("is capped", () => {
    expect(missedRun(new Set(), "2026-10-16", 10)).toBe(10);
  });
});

describe("scoreTrend", () => {
  it("returns last N scores in date order with average, recent mean and direction", () => {
    const notes = [
      { note_date: "2026-10-01", curator_score: 5 },
      { note_date: "2026-10-02", curator_score: 4 },
      { note_date: "2026-10-05", curator_score: null },
      { note_date: "2026-10-06", curator_score: 5 },
      { note_date: "2026-10-07", curator_score: 2 },
      { note_date: "2026-10-08", curator_score: 2 },
      { note_date: "2026-10-09", curator_score: 3 },
    ];
    const t = scoreTrend([...notes].reverse());
    expect(t.scores.map((s) => s.score)).toEqual([5, 4, 5, 2, 2, 3]);
    expect(t.avg).toBe(3.5);
    expect(t.recent).toBe(2.3);
    expect(t.delta).toBe(-2.3);
    expect(t.direction).toBe("down");
  });

  it("has no direction with fewer than four scores", () => {
    const t = scoreTrend([{ note_date: "2026-10-01", curator_score: 4 }, { note_date: "2026-10-02", curator_score: 5 }]);
    expect(t.recent).toBe(4.5);
    expect(t.delta).toBeNull();
    expect(t.direction).toBeNull();
  });

  it("flat when the change is small and empty input is all nulls", () => {
    const t = scoreTrend(["01", "02", "05", "06", "07", "08"].map((d, i) => ({ note_date: `2026-10-${d}`, curator_score: i % 2 ? 4 : 3 })));
    expect(t.direction).toBe("flat");
    expect(scoreTrend([])).toEqual({ scores: [], avg: null, recent: null, delta: null, direction: null });
  });

  it("keeps only the last N", () => {
    const notes = Array.from({ length: 15 }, (_, i) => ({ note_date: `2026-09-${String(i + 1).padStart(2, "0")}`, curator_score: 3 }));
    expect(scoreTrend(notes, 10).scores).toHaveLength(10);
    expect(scoreTrend(notes, 10).scores[0]!.date).toBe("2026-09-06");
  });
});

describe("mistakeKeys / repeatedMistakes", () => {
  it("recognises common Russian phrasings (case and ё insensitive)", () => {
    expect(mistakeKeys("Опять FOMO, догонял NVDA")).toContain("fomo");
    expect(mistakeKeys("Ранний вход до подтверждения")).toContain("early_entry");
    expect(mistakeKeys("Вошёл рано, не дождался ретеста")).toContain("early_entry");
    expect(mistakeKeys("Сдвинул стоп ниже, потом ещё раз")).toContain("moved_stop");
    expect(mistakeKeys("Переторговка после обеда")).toContain("overtrading");
    expect(mistakeKeys("Завысил размер на второй сделке")).toContain("size");
    expect(mistakeKeys("Пытался отыграться")).toContain("revenge");
    expect(mistakeKeys("Взял сделку не по плану")).toContain("off_plan");
    expect(mistakeKeys("Рано вышел из TSLA")).toContain("early_exit");
    expect(mistakeKeys("Передержал лосс в AMD")).toContain("held_loser");
    expect(mistakeKeys("Усреднялся в минус")).toContain("averaging");
    expect(mistakeKeys("Пробил дневной лимит")).toContain("daily_limit");
    expect(mistakeKeys("Тильт после второго стопа")).toContain("emotions");
  });

  it("returns nothing for empty or unrelated text", () => {
    expect(mistakeKeys("")).toEqual([]);
    expect(mistakeKeys(null)).toEqual([]);
    expect(mistakeKeys("Всё по плану, держал дисциплину")).toEqual([]);
  });

  it("counts each category once per note and keeps those seen in ≥ minNotes notes", () => {
    const r = repeatedMistakes([
      { note_date: "2026-10-01", text: "FOMO, FOMO и ещё раз фомо" },
      { note_date: "2026-10-02", text: "Ранний вход" },
      { note_date: "2026-10-05", text: "догонял бумагу, ранний вход" },
      { note_date: "2026-10-06", text: "Переторговка" },
      { note_date: "2026-10-07", text: "погоня за движением" },
    ]);
    expect(r).toEqual([
      { key: "fomo", label: "FOMO / погоня", count: 3, last: "2026-10-07" },
      { key: "early_entry", label: "Ранний вход", count: 2, last: "2026-10-05" },
    ]);
  });

  it("respects top and breaks ties by most recent", () => {
    const r = repeatedMistakes([
      { note_date: "2026-10-01", text: "переторговка" },
      { note_date: "2026-10-02", text: "переторговка, усреднение" },
      { note_date: "2026-10-03", text: "усреднился" },
    ], { top: 1 });
    expect(r).toEqual([{ key: "averaging", label: "Усреднение", count: 2, last: "2026-10-03" }]);
  });
});

describe("attentionOf", () => {
  const quiet = { wrote: true, reviewed: true, unreviewed14: 0, missed: 0, everWrote: true, trend: { recent: 4, direction: null, delta: null }, repeated: [] } as const;

  it("nothing to do → no flags, zero priority", () => {
    expect(attentionOf(quiet)).toEqual({ flags: [], priority: 0 });
  });

  it("unanswered summaries come first and grow with the backlog", () => {
    const one = attentionOf({ ...quiet, reviewed: false, unreviewed14: 1 });
    const five = attentionOf({ ...quiet, reviewed: false, unreviewed14: 5 });
    expect(one.flags[0]).toMatchObject({ kind: "unanswered", label: "Ждёт ответа" });
    expect(five.flags[0]!.label).toBe("Без ответа: 5");
    expect(five.priority).toBeGreaterThan(one.priority);
  });

  it("a single missed day is not flagged, two or more are; never-wrote is its own flag", () => {
    expect(attentionOf({ ...quiet, wrote: false, missed: 1 }).flags).toEqual([]);
    expect(attentionOf({ ...quiet, wrote: false, missed: 2 }).flags[0]).toMatchObject({ kind: "missed", tone: "warn" });
    expect(attentionOf({ ...quiet, wrote: false, missed: 4 }).flags[0]).toMatchObject({ kind: "missed", tone: "down", label: "Пропуск 4 дн. подряд" });
    expect(attentionOf({ ...quiet, wrote: false, missed: 10 }).flags[0]!.label).toBe("Пропуск 10+ дн. подряд");
    expect(attentionOf({ ...quiet, wrote: false, missed: 1, everWrote: false }).flags[0]!.label).toBe("Ещё ни одной сводки");
  });

  it("low recent scores beat a falling trend; repeated mistakes need ≥ 3 notes", () => {
    const low = attentionOf({ ...quiet, trend: { recent: 2, direction: "down", delta: -2 } });
    expect(low.flags.map((f) => f.kind)).toEqual(["low_score"]);
    const falling = attentionOf({ ...quiet, trend: { recent: 3.3, direction: "down", delta: -1 } });
    expect(falling.flags.map((f) => f.kind)).toEqual(["falling"]);
    expect(attentionOf({ ...quiet, repeated: [{ label: "Ранний вход", count: 2 }] }).flags).toEqual([]);
    expect(attentionOf({ ...quiet, repeated: [{ label: "Ранний вход", count: 3 }] }).flags[0]!.label).toBe("Повторяет: ранний вход ×3");
    expect(attentionOf({ ...quiet, repeated: [{ label: "FOMO / погоня", count: 3 }] }).flags[0]!.label).toBe("Повторяет: FOMO / погоня ×3");
  });
});

describe("buildDayTrades (money privacy)", () => {
  const rows: ContextTradeRow[] = [
    { id: 1, trader: "Умид", ticker: "NVDA", side: "Long", setup: "ORB", horizon: "intraday", result: "win", date: "2026-10-16", exit_date: null, r: 2, pnl_net: 180.5 },
    { id: 2, trader: "Умид", ticker: "AMD", side: "Short", setup: null, horizon: "intraday", result: "loss", date: "2026-10-16", exit_date: null, r: -1, pnl_net: -95 },
    { id: 3, trader: "Умид", ticker: "TSLA", side: "Long", setup: null, horizon: "swing", result: "open", date: "2026-10-14", exit_date: null, r: null, pnl_net: null },
    { id: 4, trader: "Умид", ticker: "AAPL", side: "Long", setup: null, horizon: "overnight", result: "win", date: "2026-10-13", exit_date: "2026-10-14", r: 1, pnl_net: 50 },
  ];

  it("staff see $ and R; carried positions exclude ones closed before the day", () => {
    const d = buildDayTrades(rows, "2026-10-16", "Умид", { name: "Антон", staff: true }, canSeeTradeMoney);
    expect(d.money_visible).toBe(true);
    expect(d.opened.map((t) => t.id)).toEqual([1, 2]);
    expect(d.carried.map((t) => t.id)).toEqual([3]);
    expect(d.totals).toEqual({ count: 2, wins: 1, losses: 1, r: 1, pnl_net: 85.5 });
  });

  it("a mentor who is a trader sees R only — every $ is null", () => {
    const d = buildDayTrades(rows, "2026-10-16", "Умид", { name: "Артур", staff: false }, canSeeTradeMoney);
    expect(d.money_visible).toBe(false);
    expect(d.opened.every((t) => t.pnl_net === null)).toBe(true);
    expect(d.carried.every((t) => t.pnl_net === null)).toBe(true);
    expect(d.totals.pnl_net).toBeNull();
    expect(d.totals.r).toBe(1);
  });

  it("the owner sees their own $", () => {
    const d = buildDayTrades(rows, "2026-10-16", "Умид", { name: "Умид", staff: false }, canSeeTradeMoney);
    expect(d.money_visible).toBe(true);
    expect(d.totals.pnl_net).toBe(85.5);
  });

  it("no trades → null totals", () => {
    const d = buildDayTrades([], "2026-10-16", "Умид", { name: "Антон", staff: true }, canSeeTradeMoney);
    expect(d.totals).toEqual({ count: 0, wins: 0, losses: 0, r: null, pnl_net: null });
  });
});
