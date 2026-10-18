import { describe, expect, it } from "vitest";
import {
  followHeader, extractTickers, findPrevPlan, followThrough, followThroughBlock, matchesSearch, moneyMentions,
  planLines, sectionForDigit, splitTickers,
} from "./author-plan";
import { serializeNote, emptySections, type AuthorNote } from "./author-model";
import { tradeLine } from "./author-day-context";

const note = (date: string, raw: string): AuthorNote => ({
  id: Number(date.replace(/-/g, "")), trader: "Ориф", note_date: date, raw_text: raw, refined_text: null, mood: null,
  created_at: "", updated_at: "",
});
const withPlan = (hold: string, open: string) => serializeNote({ ...emptySections(), market: "SPY вверх", hold, open }, "");

describe("findPrevPlan", () => {
  const notes = [
    note("2026-10-16", withPlan("", "Смотрю $TSLA выше 250")),
    note("2026-10-15", withPlan("NVDA свинг, стоп 118", "")),
    note("2026-10-17", withPlan("сегодня", "сегодня")),
  ];

  it("takes the most recent earlier note with a plan, never the same day", () => {
    expect(findPrevPlan(notes, "2026-10-17")).toEqual({ date: "2026-10-16", hold: "", open: "Смотрю $TSLA выше 250" });
  });

  it("skips notes without plan blocks and free-form notes", () => {
    const n = [note("2026-10-16", "просто текст без блоков"), note("2026-10-14", withPlan("", "")), notes[1]!];
    expect(findPrevPlan(n, "2026-10-17")?.date).toBe("2026-10-15");
  });

  it("does not reach further back than maxBackDays", () => {
    expect(findPrevPlan([note("2026-09-01", withPlan("AMD", ""))], "2026-10-17")).toBeNull();
  });
});

describe("planLines", () => {
  it("strips bullets / numbering and drops empty template prompts", () => {
    expect(planLines("• TSLA выше 250\n- NVDA 118 стоп\n1. AMD\nКлючевые уровни: \n\nПремаркет-список: AAPL")).toEqual([
      "TSLA выше 250", "NVDA 118 стоп", "AMD", "Премаркет-список: AAPL",
    ]);
  });
});

describe("extractTickers", () => {
  it("finds $mentions and bare caps words, skips jargon and Cyrillic", () => {
    expect(extractTickers("Смотрю $TSLA и NVDA у VWAP, ФРС в 14:00, BRK.B на ATR")).toEqual(["TSLA", "NVDA", "BRK.B"]);
  });
  it("ignores single letters and mixed case", () => {
    expect(extractTickers("A+ сетап, R 2, Tesla")).toEqual([]);
  });
});

describe("splitTickers", () => {
  it("marks only explicit $TICKER runs", () => {
    expect(splitTickers("лонг $TSLA от 250, NVDA тоже")).toEqual([
      { text: "лонг " }, { text: "$TSLA", ticker: "TSLA" }, { text: " от 250, NVDA тоже" },
    ]);
  });
  it("$ with digits is not a ticker", () => {
    expect(splitTickers("+$300")).toEqual([{ text: "+$300" }]);
  });
});

describe("followThrough", () => {
  const trades = [
    { ticker: "TSLA", rSigned: 1.5, rMultiple: 1.5 },
    { ticker: "tsla", rSigned: -0.5, rMultiple: 0.5 },
    { ticker: "AMD", rSigned: null, rMultiple: null },
  ];
  it("traded / missed / none per plan line with Σ R per ticker", () => {
    const items = followThrough(["$TSLA выше 250", "NVDA на откате", "Первый час — половинный размер", "AMD гэп"], trades);
    expect(items.map((i) => i.status)).toEqual(["traded", "missed", "none", "traded"]);
    expect(items[0]!.traded).toEqual([{ ticker: "TSLA", r: 1 }]);
    expect(items[3]!.traded).toEqual([{ ticker: "AMD", r: null }]);
  });

  it("block for lessons is R-only and names the plan date", () => {
    const block = followThroughBlock("2026-10-16", followThrough(["$TSLA выше 250", "NVDA", "размер 50%"], trades));
    expect(block.startsWith(`${followHeader()} (план от`)).toBe(true);
    expect(block).toContain("• $TSLA выше 250 → торговал TSLA +1.0R — ");
    expect(block).toContain("• NVDA → не торговал — ");
    expect(block).toContain("• размер 50% → ");
    expect(block).not.toMatch(/\$\d/);
  });
});

describe("moneyMentions", () => {
  it("catches $ amounts in several spellings, not tickers", () => {
    expect(moneyMentions("закрыл +$1,200 и ещё 300$, итого 500 долларов; $TSLA")).toEqual(["+$1,200", "300$", "500 долл"]);
    expect(moneyMentions("$TSLA +1.5R")).toEqual([]);
  });
});

describe("matchesSearch", () => {
  const n = { trader: "Ориф", raw_text: "Лонг $NVDA от уровня", refined_text: null, day: { tickers: ["AMD"] } };
  it("matches text, author, and the day's tickers; ignores leading $", () => {
    expect(matchesSearch(n, "nvda")).toBe(true);
    expect(matchesSearch(n, "$AMD")).toBe(true);
    expect(matchesSearch(n, "ориф")).toBe(true);
    expect(matchesSearch(n, "TSLA")).toBe(false);
    expect(matchesSearch(n, "  ")).toBe(true);
  });
});

describe("tradeLine (inserted into the note)", () => {
  const base = { id: 1, ticker: "TSLA", date: "2026-10-17", side: "Long", setup: "ORB", pnl: 300, pnlNet: 296, fees: 4, horizon: "intraday" as const, exitDate: null };
  it("never writes $ — signed R or the result label", () => {
    expect(tradeLine({ ...base, result: "loss", rMultiple: 1, rSigned: -1 })).toBe("• TSLA Long (ORB) — −1.0R: ");
    expect(tradeLine({ ...base, result: "win", rMultiple: null, rSigned: null })).toBe("• TSLA Long (ORB) — профит: ");
    expect(tradeLine({ ...base, result: "open", rMultiple: 2, rSigned: null })).toBe("• TSLA Long (ORB) — открыта: ");
  });
});

describe("sectionForDigit", () => {
  it("maps Alt+1…7 to sections in editor order", () => {
    expect(sectionForDigit(1)).toBe("market");
    expect(sectionForDigit(5)).toBe("lessons");
    expect(sectionForDigit(7)).toBe("open");
    expect(sectionForDigit(8)).toBeNull();
  });
});
