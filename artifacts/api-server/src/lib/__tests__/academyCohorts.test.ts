import { describe, expect, it } from "vitest";
import {
  CHECKIN_AFTER_MIN, CHECKIN_BEFORE_MIN, LATE_GRACE_MIN, NY_TZ, STAGES,
  dateInTz, describeGoal, describeRule, evaluateCheckin, evaluateGoal, goalTransition, isHhmm, isOccurrence, isValidTimeZone, isYmd,
  lagReasons, lagScore, lastTradingDays, maxLossStreak, mergeSummaries, nextOccurrence, occurrenceDates, occurrences, outcomeOf,
  summarizeAttendance, timeInTz, tzOffsetMinutes, weekdayOf, weekdaysBetween, zonedWallToUtcMs,
  type IdpContext, type IdpGoalInput, type IdpTrade, type LagInput, type SessionRule,
} from "../academyCohorts";

const MIN = 60_000;

describe("stages", () => {
  it("ladder is exactly trainee → junior → trader → senior", () => {
    expect([...STAGES]).toEqual(["trainee", "junior", "trader", "senior"]);
  });
});

describe("time zones", () => {
  it("NY offset follows DST", () => {
    expect(tzOffsetMinutes(Date.UTC(2026, 6, 1, 12), NY_TZ)).toBe(-240);
    expect(tzOffsetMinutes(Date.UTC(2026, 11, 1, 12), NY_TZ)).toBe(-300);
  });
  it("09:00 ET → UTC in summer and winter", () => {
    expect(new Date(zonedWallToUtcMs("2026-10-16", "09:00", NY_TZ)).toISOString()).toBe("2026-10-16T13:00:00.000Z");
    expect(new Date(zonedWallToUtcMs("2026-11-02", "09:00", NY_TZ)).toISOString()).toBe("2026-11-02T14:00:00.000Z");
  });
  it("DST transition days", () => {
    // 2026-03-08: 02:30 does not exist in NY → shifted forward to 03:30 EDT (07:30Z)
    expect(new Date(zonedWallToUtcMs("2026-03-08", "02:30", NY_TZ)).toISOString()).toBe("2026-03-08T07:30:00.000Z");
    // the day after the switch 09:00 is EDT
    expect(new Date(zonedWallToUtcMs("2026-03-09", "09:00", NY_TZ)).toISOString()).toBe("2026-03-09T13:00:00.000Z");
    // 2026-11-01: 09:00 already EST
    expect(new Date(zonedWallToUtcMs("2026-11-01", "09:00", NY_TZ)).toISOString()).toBe("2026-11-01T14:00:00.000Z");
  });
  it("other zones and round trip", () => {
    const t = zonedWallToUtcMs("2026-10-16", "18:30", "Asia/Tashkent");
    expect(new Date(t).toISOString()).toBe("2026-10-16T13:30:00.000Z");
    expect(dateInTz(t, NY_TZ)).toBe("2026-10-16");
    expect(timeInTz(t, NY_TZ)).toBe("09:30");
    expect(dateInTz(Date.UTC(2026, 9, 17, 2), NY_TZ)).toBe("2026-10-16"); // 22:00 ET previous day
  });
  it("validators", () => {
    expect(isValidTimeZone("Europe/Moscow")).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
    expect(isYmd("2026-02-30")).toBe(false);
    expect(isYmd("2026-02-28")).toBe(true);
    expect(isHhmm("09:00")).toBe(true);
    expect(isHhmm("24:00")).toBe(false);
    expect(weekdayOf("2026-10-16")).toBe(5);
  });
});

const rule = (over: Partial<SessionRule> = {}): SessionRule => ({
  recurrence: "weekdays", weekdays: [], startDate: "2026-10-01", endDate: null, startTime: "09:00", durationMin: 30, timezone: NY_TZ, ...over,
});

describe("recurrence", () => {
  it("weekdays premarket briefing skips weekends", () => {
    expect(occurrenceDates(rule(), "2026-10-15", "2026-10-21")).toEqual(["2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20", "2026-10-21"]);
  });
  it("daily includes weekends", () => {
    expect(occurrenceDates(rule({ recurrence: "daily" }), "2026-10-16", "2026-10-18")).toHaveLength(3);
  });
  it("weekly Friday review", () => {
    expect(occurrenceDates(rule({ recurrence: "weekly", weekdays: [5], startTime: "16:30" }), "2026-10-01", "2026-10-31"))
      .toEqual(["2026-10-02", "2026-10-09", "2026-10-16", "2026-10-23", "2026-10-30"]);
  });
  it("weekly with empty weekdays uses the start date weekday", () => {
    expect(occurrenceDates(rule({ recurrence: "weekly", startDate: "2026-10-06" }), "2026-10-01", "2026-10-20")).toEqual(["2026-10-06", "2026-10-13", "2026-10-20"]);
  });
  it("one-off session", () => {
    const r = rule({ recurrence: "none", startDate: "2026-10-20" });
    expect(occurrenceDates(r, "2026-10-01", "2026-10-31")).toEqual(["2026-10-20"]);
    expect(occurrenceDates(r, "2026-10-21", "2026-10-31")).toEqual([]);
    expect(isOccurrence(r, "2026-10-20")).toBe(true);
    expect(isOccurrence(r, "2026-10-21")).toBe(false);
  });
  it("respects start and end dates", () => {
    const r = rule({ startDate: "2026-10-14", endDate: "2026-10-16" });
    expect(occurrenceDates(r, "2026-10-01", "2026-10-31")).toEqual(["2026-10-14", "2026-10-15", "2026-10-16"]);
    expect(isOccurrence(r, "2026-10-19")).toBe(false);
    expect(isOccurrence(r, "2026-10-13")).toBe(false);
  });
  it("occurrence instants are DST-aware across the November switch", () => {
    const occ = occurrences(rule(), "2026-10-30", "2026-11-02");
    expect(occ.map((o) => new Date(o.startMs).toISOString())).toEqual(["2026-10-30T13:00:00.000Z", "2026-11-02T14:00:00.000Z"]);
    expect(occ[0].endMs - occ[0].startMs).toBe(30 * MIN);
  });
  it("nextOccurrence returns the running or the next one", () => {
    const r = rule();
    const during = zonedWallToUtcMs("2026-10-16", "09:10", NY_TZ);
    expect(nextOccurrence(r, during)?.date).toBe("2026-10-16");
    const after = zonedWallToUtcMs("2026-10-16", "09:31", NY_TZ);
    expect(nextOccurrence(r, after)?.date).toBe("2026-10-19");
    expect(nextOccurrence(rule({ recurrence: "none", startDate: "2026-10-01" }), after)).toBeNull();
  });
  it("describeRule", () => {
    expect(describeRule(rule())).toBe("по будням в 09:00 (America/New_York)");
    expect(describeRule(rule({ recurrence: "weekly", weekdays: [0, 5, 1] }))).toBe("еженедельно: пн, пт, вс в 09:00 (America/New_York)");
  });
});

describe("check-in window", () => {
  const start = zonedWallToUtcMs("2026-10-16", "09:00", NY_TZ);
  it("too early before −10 min", () => {
    const v = evaluateCheckin(start, start - (CHECKIN_BEFORE_MIN * MIN + 1000));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("too_early");
  });
  it("opens exactly at −10 min (inclusive) as present", () => {
    expect(evaluateCheckin(start, start - CHECKIN_BEFORE_MIN * MIN)).toMatchObject({ ok: true, status: "present" });
  });
  it("present up to the grace, late after it", () => {
    expect(evaluateCheckin(start, start + LATE_GRACE_MIN * MIN)).toMatchObject({ ok: true, status: "present" });
    expect(evaluateCheckin(start, start + LATE_GRACE_MIN * MIN + 1000)).toMatchObject({ ok: true, status: "late" });
  });
  it("closes at +15 min (inclusive)", () => {
    expect(evaluateCheckin(start, start + CHECKIN_AFTER_MIN * MIN)).toMatchObject({ ok: true, status: "late" });
    const v = evaluateCheckin(start, start + CHECKIN_AFTER_MIN * MIN + 1);
    expect(v).toMatchObject({ ok: false, reason: "too_late" });
  });
});

describe("attendance", () => {
  it("summary excludes excused and unmarked from the rate", () => {
    const s = summarizeAttendance(["present", "late", "absent", "excused", null, "present"]);
    expect(s).toMatchObject({ total: 6, present: 2, late: 1, absent: 1, excused: 1, unmarked: 1 });
    expect(s.rate).toBeCloseTo(3 / 4);
    expect(s.punctuality).toBeCloseTo(2 / 3);
    expect(s.absentStreak).toBe(0);
  });
  it("absent streak from the end, unmarked does not break it", () => {
    expect(summarizeAttendance(["present", "absent", null, "absent"]).absentStreak).toBe(2);
    expect(summarizeAttendance([]).rate).toBeNull();
  });
  it("cohort merge", () => {
    const m = mergeSummaries([summarizeAttendance(["present", "absent"]), summarizeAttendance(["late", "present"])]);
    expect(m.total).toBe(4);
    expect(m.rate).toBeCloseTo(3 / 4);
  });
});

/* ─── IDP ─── */

let seq = 0;
const tr = (date: string, gross: number | null, fees = 1, result: IdpTrade["result"] = null): IdpTrade => ({ date, seq: seq++, gross, fees, result });
const goal = (over: Partial<IdpGoalInput>): IdpGoalInput => ({
  metric: "fee_share", target: 50, comparator: "lt", window: null, startDate: "2026-10-01", dueOn: null, manualProgress: null, ...over,
});
const ctx = (trades: IdpTrade[], journalDates: string[] = [], today = "2026-10-16"): IdpContext => ({ trades, journalDates, today });

function days(n: number, from = "2026-09-01"): string[] {
  const out: string[] = [];
  let d = from;
  while (out.length < n) {
    const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d);
    d = new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  }
  return out;
}

describe("IDP: outcomes and helpers", () => {
  it("outcome by net money, fallback to result, open excluded", () => {
    expect(outcomeOf(tr("2026-10-01", 0.5, 1))).toBe("loss"); // broker gross win eaten by fees
    expect(outcomeOf(tr("2026-10-01", null, 0, "win"))).toBe("win");
    expect(outcomeOf(tr("2026-10-01", 10, 1, "open"))).toBeNull();
    expect(outcomeOf(tr("2026-10-01", 1, 1))).toBe("be");
  });
  it("max loss streak: BE does not break, win resets", () => {
    const ts = [tr("d", -5), tr("d", -5), tr("d", 1, 1), tr("d", -5), tr("d", 10), tr("d", -1), tr("d", -1)];
    expect(maxLossStreak(ts)).toBe(3);
  });
  it("lastTradingDays ignores future dates and picks the last N days", () => {
    const ts = [tr("2026-10-14", 5), tr("2026-10-15", 5), tr("2026-10-16", 5), tr("2026-10-19", 5)];
    const r = lastTradingDays(ts, 2, "2026-10-16");
    expect(r.days).toEqual(["2026-10-15", "2026-10-16"]);
    expect(r.trades).toHaveLength(2);
  });
});

describe("IDP: fee share < 50% gross over 10 days", () => {
  it("achieved with 10 full days and 30% fee share", () => {
    const ts = days(12).map((d) => tr(d, 100, 30));
    const e = evaluateGoal(goal({}), ctx(ts));
    expect(e.value).toBe(30);
    expect(e.met).toBe(true);
    expect(e.achieved).toBe(true);
    expect(e.progress).toBe(1);
    expect(e.sample).toBe(10);
  });
  it("met but not achieved with only 5 days (coverage)", () => {
    const ts = days(5).map((d) => tr(d, 100, 30));
    const e = evaluateGoal(goal({}), ctx(ts));
    expect(e.met).toBe(true);
    expect(e.achieved).toBe(false);
    expect(e.progress).toBeCloseTo(0.5);
  });
  it("not met at 80% — progress = target/value", () => {
    const ts = days(10).map((d) => tr(d, 100, 80));
    const e = evaluateGoal(goal({}), ctx(ts));
    expect(e.value).toBe(80);
    expect(e.met).toBe(false);
    expect(e.progress).toBeCloseTo(50 / 80);
  });
  it("gross ≤ 0 ⇒ value null, not met", () => {
    const ts = days(10).map((d) => tr(d, -10, 5));
    const e = evaluateGoal(goal({}), ctx(ts));
    expect(e.value).toBeNull();
    expect(e.met).toBe(false);
    expect(e.progress).toBe(0);
  });
  it("no trades", () => {
    const e = evaluateGoal(goal({}), ctx([]));
    expect(e).toMatchObject({ value: null, met: false, achieved: false, progress: 0, sample: 0 });
  });
});

describe("IDP: no more than 3 losses in a row", () => {
  it("achieved when the worst streak is 3", () => {
    const ds = days(10);
    const ts = ds.flatMap((d, i) => (i === 4 ? [tr(d, -10), tr(d, -10), tr(d, -10), tr(d, 20)] : [tr(d, 20)]));
    const e = evaluateGoal(goal({ metric: "loss_streak", target: 3, comparator: "lte" }), ctx(ts));
    expect(e.value).toBe(3);
    expect(e.achieved).toBe(true);
  });
  it("streak of 5 ⇒ progress 3/5", () => {
    const ds = days(10);
    const ts = ds.flatMap((d, i) => (i === 2 ? [tr(d, -1), tr(d, -1), tr(d, -1), tr(d, -1), tr(d, -1)] : [tr(d, 20)]));
    const e = evaluateGoal(goal({ metric: "loss_streak", target: 3, comparator: "lte" }), ctx(ts));
    expect(e.value).toBe(5);
    expect(e.met).toBe(false);
    expect(e.progress).toBeCloseTo(0.6);
  });
});

describe("IDP: win rate ≥ 50% on 100 trades", () => {
  it("needs the full sample", () => {
    const ds = days(60);
    const ts = ds.map((d, i) => tr(d, i % 3 === 0 ? -10 : 20)); // 2/3 winners
    const e = evaluateGoal(goal({ metric: "win_rate", target: 50, comparator: "gte" }), ctx(ts, [], "2026-12-31"));
    expect(e.sample).toBe(60);
    expect(e.met).toBe(true);
    expect(e.achieved).toBe(false);
    expect(e.progress).toBeCloseTo(0.6);
  });
  it("achieved on the last 100 decided trades, BE excluded", () => {
    const ds = days(120);
    const ts = ds.flatMap((d, i) => [tr(d, i % 2 === 0 ? 20 : -10), tr(d, 1, 1)]); // + one BE per day
    const e = evaluateGoal(goal({ metric: "win_rate", target: 50, comparator: "gte" }), ctx(ts, [], "2027-06-30"));
    expect(e.sample).toBe(100);
    expect(e.value).toBe(50);
    expect(e.achieved).toBe(true);
  });
});

describe("IDP: 10 journal days with review", () => {
  it("counts distinct days since start, up to today", () => {
    const j = [...days(8, "2026-10-01"), "2026-09-30", "2026-10-01", "2026-12-01"];
    const e = evaluateGoal(goal({ metric: "journal_days", target: 10, comparator: "gte" }), ctx([], j, "2026-10-16"));
    expect(e.value).toBe(8);
    expect(e.progress).toBeCloseTo(0.8);
    expect(e.achieved).toBe(false);
    const e2 = evaluateGoal(goal({ metric: "journal_days", target: 8, comparator: "gte" }), ctx([], j, "2026-10-16"));
    expect(e2.achieved).toBe(true);
  });
});

describe("IDP: net, trading days, manual", () => {
  it("net over 20 days", () => {
    const ts = days(20).map((d) => tr(d, 12, 2));
    const e = evaluateGoal(goal({ metric: "net_pnl", target: 150, comparator: "gte", window: 20 }), ctx(ts));
    expect(e.value).toBe(200);
    expect(e.achieved).toBe(true);
  });
  it("trading days since start", () => {
    const ts = days(30).map((d) => tr(d, 5));
    const e = evaluateGoal(goal({ metric: "trading_days", target: 20, comparator: "gte", startDate: "2026-09-15" }), ctx(ts));
    expect(e.value).toBe(30 - 10); // 10 weekdays in Sep 1..14
    expect(e.achieved).toBe(true);
  });
  it("manual progress", () => {
    expect(evaluateGoal(goal({ metric: "manual", manualProgress: 40 }), ctx([]))).toMatchObject({ progress: 0.4, achieved: false });
    expect(evaluateGoal(goal({ metric: "manual", manualProgress: 100 }), ctx([]))).toMatchObject({ achieved: true });
  });
  it("transitions", () => {
    expect(goalTransition("active", { achieved: true }, "2026-10-01", "2026-10-16")).toBe("achieved");
    expect(goalTransition("active", { achieved: false }, "2026-10-15", "2026-10-16")).toBe("missed");
    expect(goalTransition("active", { achieved: false }, "2026-10-16", "2026-10-16")).toBeNull();
    expect(goalTransition("achieved", { achieved: false }, "2026-10-01", "2026-10-16")).toBeNull();
  });
  it("describeGoal", () => {
    expect(describeGoal({ metric: "fee_share", target: 50, comparator: "lt", window: 10 })).toBe("Доля комиссий от брутто < 50 % за 10 дн.");
    expect(describeGoal({ metric: "win_rate", target: 50, comparator: "gte", window: 100 })).toBe("Винрейт ≥ 50 % на 100 сделках");
  });
});

describe("lagging students", () => {
  const base = (over: Partial<LagInput> = {}): LagInput => ({
    today: "2026-10-16", stage: "trainee", status: "active", joinedOn: "2026-09-01",
    attendance: summarizeAttendance(["present", "present", "present", "present"]),
    overdueActions: 0, missedGoals: 0, atRiskGoals: 0, lastTradeDate: "2026-10-15", lastJournalDate: "2026-10-15", ...over,
  });
  it("healthy student has no reasons", () => {
    expect(lagReasons(base())).toEqual([]);
  });
  it("collects reasons with severities", () => {
    const r = lagReasons(base({
      attendance: summarizeAttendance(["present", "absent", "absent", "absent"]),
      overdueActions: 1, missedGoals: 1, lastTradeDate: "2026-10-01", lastJournalDate: null,
    }));
    const codes = r.map((x) => x.code);
    expect(codes).toEqual(expect.arrayContaining(["attendance_low", "absent_streak", "overdue_actions", "missed_goals", "no_trades", "no_journal"]));
    expect(r.find((x) => x.code === "no_trades")?.severity).toBe("critical"); // 10 weekdays
    expect(lagScore(r)).toBeGreaterThan(5);
  });
  it("new student is not flagged for missing trades", () => {
    expect(lagReasons(base({ joinedOn: "2026-10-15", lastTradeDate: null, lastJournalDate: null }))).toEqual([]);
  });
  it("non-active statuses", () => {
    expect(lagReasons(base({ status: "paused", overdueActions: 5 })).map((x) => x.code)).toEqual(["paused"]);
    expect(lagReasons(base({ status: "graduated", overdueActions: 5 }))).toEqual([]);
  });
  it("weekdaysBetween is exclusive", () => {
    expect(weekdaysBetween("2026-10-16", "2026-10-19")).toBe(0); // Fri → Mon
    expect(weekdaysBetween("2026-10-12", "2026-10-16")).toBe(3);
  });
});
