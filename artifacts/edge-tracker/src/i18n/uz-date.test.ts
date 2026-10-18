import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "./index";
import { fmtDate, fmtDateCustom, fmtDateRange, fmtMonth, fmtRelative, fmtTimeNY, fmtWeekday, type DateStyle } from "./format";
import { formatUzDate, formatUzRelative, UZ_MONTHS_LONG, UZ_WEEKDAYS_LONG } from "./uz-date";

afterEach(async () => {
  await setLang("ru", { source: "init" });
});

const d = new Date(2026, 9, 7, 14, 5, 9); // Wednesday

describe("Uzbek dates (hand-written, independent of browser uz CLDR data)", () => {
  it("every fmtDate style has a natural Uzbek pattern", async () => {
    await setLang("uz", { source: "init" });
    const expected: Record<DateStyle, string> = {
      short: "07.10.2026",
      shortYY: "07.10.26",
      medium: "7-okt, 2026",
      long: "2026-yil 7-oktabr",
      full: "chorshanba, 2026-yil 7-oktabr",
      dayMonth: "7-okt",
      dayMonthLong: "7-oktabr",
      dayMonthNumeric: "07.10",
      monthYear: "2026-yil oktabr",
      time: "14:05",
      timeSeconds: "14:05:09",
      dateTime: "7-okt, 14:05",
      weekdayDayMonth: "Chor, 7-okt",
      weekdayDayMonthLong: "chorshanba, 7-oktabr",
      numericDateTime: "07.10, 14:05",
      shortDateTime: "07.10.2026, 14:05",
      shortDateTimeSeconds: "07.10.2026, 14:05:09",
      fullShortWeekday: "Chor, 2026-yil 7-oktabr",
    };
    for (const [style, text] of Object.entries(expected)) expect([style, fmtDate(d, style as DateStyle)]).toEqual([style, text]);
  });

  it("month and weekday names", async () => {
    await setLang("uz", { source: "init" });
    expect(Array.from({ length: 12 }, (_, i) => fmtMonth(i))).toEqual([...UZ_MONTHS_LONG]);
    expect(UZ_MONTHS_LONG.slice(0, 3)).toEqual(["yanvar", "fevral", "mart"]);
    expect(fmtMonth(8, "short")).toBe("sen");
    expect(fmtMonth(d)).toBe("oktabr");
    expect(Array.from({ length: 7 }, (_, i) => fmtWeekday(i, "long"))).toEqual([...UZ_WEEKDAYS_LONG]);
    expect(fmtWeekday(1, "long")).toBe("dushanba");
    expect(fmtWeekday(2, "long")).toBe("seshanba");
    expect(fmtWeekday(1)).toBe("Dush");
    expect(fmtWeekday(4, "narrow")).toBe("P");
    expect(fmtWeekday("2026-10-07", "long")).toBe("chorshanba");
  });

  it("custom shapes and time zones", async () => {
    await setLang("uz", { source: "init" });
    expect(fmtDateCustom(d, { month: "short", year: "2-digit" })).toBe("okt 26");
    expect(fmtDateCustom(d, { month: "long" })).toBe("oktabr");
    expect(fmtDateCustom(d, { weekday: "short" })).toBe("Chor");
    expect(fmtDateCustom(d, { month: "2-digit", year: "numeric" })).toBe("10.2026");
    expect(fmtDateCustom(d, { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })).toBe("7-oktabr, 14:05");
    const late = new Date(Date.UTC(2026, 9, 17, 2, 0)); // 22:00 Friday Oct 16 in New York
    expect(fmtDate(late, "weekdayDayMonthLong", { timeZone: "America/New_York" })).toBe("juma, 16-oktabr");
    expect(fmtTimeNY(new Date(Date.UTC(2026, 9, 16, 13, 30)))).toBe("09:30");
    expect(formatUzDate(new Date(2026, 0, 3, 9, 4), { day: "numeric", month: "short", year: "numeric" })).toBe("3-yan, 2026");
  });

  it("relative time", async () => {
    await setLang("uz", { source: "init" });
    const now = new Date(2026, 9, 7, 12, 0).getTime();
    expect(fmtRelative(now - 10_000, { now })).toBe("hozir");
    expect(fmtRelative(now - 5 * 60_000, { now })).toBe("5 daqiqa oldin");
    expect(fmtRelative(now + 5 * 60_000, { now })).toBe("5 daqiqadan keyin");
    expect(fmtRelative(now - 5 * 60_000, { now, style: "short" })).toBe("5 daq. oldin");
    expect(fmtRelative(now + 2 * 3600_000, { now })).toBe("2 soatdan keyin");
    expect(fmtRelative(now - 86400_000, { now })).toBe("kecha");
    expect(fmtRelative(now + 86400_000, { now })).toBe("ertaga");
    expect(fmtRelative(now - 3 * 86400_000, { now })).toBe("3 kun oldin");
    expect(fmtRelative(now - 31 * 86400_000, { now })).toBe("oʻtgan oy");
    expect(fmtRelative(now - 400 * 86400_000, { now })).toBe("oʻtgan yil");
    expect(formatUzRelative(-1234, "day", "long", (n) => String(n))).toBe("1234 kun oldin");
  });

  it("date ranges", async () => {
    expect(fmtDateRange("2026-10-12", "2026-10-16")).toBe("12–16 октября 2026 г.");
    await setLang("uz", { source: "init" });
    expect(fmtDateRange("2026-10-12", "2026-10-16")).toBe("2026-yil 12–16-oktabr");
    expect(fmtDateRange("2026-09-28", "2026-10-02")).toBe("2026-yil 28-sentabr – 2-oktabr");
    expect(fmtDateRange("2026-12-29", "2027-01-02")).toBe("2026-yil 29-dekabr – 2027-yil 2-yanvar");
    expect(fmtDateRange("2026-10-16", "2026-10-12", "short")).toBe("12–16-okt, 2026");
    await setLang("en", { source: "init" });
    expect(fmtDateRange("2026-10-12", "2026-10-16")).toBe("October 12 – 16, 2026");
  });

  it("other languages still use Intl", async () => {
    expect(fmtDate(d, "long")).toBe("7 октября 2026 г.");
    await setLang("en", { source: "init" });
    expect(fmtDate(d, "weekdayDayMonth")).toBe("Wed, Oct 7");
  });
});
