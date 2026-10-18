import { describe, expect, it } from "vitest";
import { applyTemplate, blockDone, docToDraft, draftToDoc, emptyTicker, isDraftEmpty, validateDraft } from "./plan-draft";

describe("plan draft", () => {
  it("round-trips a document", () => {
    const doc = draftToDoc(
      docToDraft({
        marketView: "Гэп вверх",
        focus: "Только A+",
        maxLossUsd: 300,
        maxTrades: 8,
        inPlay: [
          {
            ticker: "nvda",
            catalyst: "отчёт",
            bias: "bull",
            grade: "A",
            horizon: "intraday",
            levels: { support: [121.5], resistance: [125, 127.8] },
            plan: "",
            risk_note: "",
            scenarioA: "пробой 125",
            trigger: "5м над 125",
            invalidation: "под 123.8",
            tvLink: "https://www.tradingview.com/x/AbCd1234/",
            media: [{ id: 7, caption: "дневка" }],
          },
        ],
        media: [{ id: 3, caption: "" }],
        tvLinks: [],
      }),
    );
    expect(doc.inPlay[0]).toMatchObject({ ticker: "NVDA", scenarioA: "пробой 125", trigger: "5м над 125", media: [{ id: 7, caption: "дневка" }] });
    expect(doc.inPlay[0]!.levels.resistance).toEqual([125, 127.8]);
    expect(doc).toMatchObject({ focus: "Только A+", maxLossUsd: 300, maxTrades: 8, media: [{ id: 3, caption: "" }] });
  });

  it("validates tickers, duplicates, levels and limits", () => {
    const d = docToDraft(null);
    d.inPlay = [emptyTicker({ ticker: "AAPL" }), emptyTicker({ ticker: "aapl" }), emptyTicker({ ticker: "" })];
    d.spyS = "abc";
    d.maxTrades = "2.5";
    const e = validateDraft(d);
    expect(e.spyS).toBeTruthy();
    expect(e.maxTrades).toBeTruthy();
    expect(e[`inPlay.${d.inPlay[1]!.key}.ticker`]).toMatch(/уже/);
    expect(e[`inPlay.${d.inPlay[2]!.key}.ticker`]).toBeTruthy();
  });

  it("applies a template without overwriting written blocks", () => {
    const d = docToDraft({ focus: "Моё правило" });
    const next = applyTemplate(d, { focus: "Шаблон", riskNotes: "Red day stop", inPlay: [] });
    expect(next.focus).toBe("Моё правило");
    expect(next.riskNotes).toBe("Red day stop");
    expect(blockDone(next)).toMatchObject({ focus: true, risk: true, tickers: false });
    expect(isDraftEmpty(docToDraft(null))).toBe(true);
  });
});

describe("rule of the day (ownRule)", () => {
  it("keeps never-chosen / none / a mistake apart through the round trip", () => {
    expect("ownRule" in draftToDoc(docToDraft({}))).toBe(false);
    expect(draftToDoc(docToDraft({ ownRule: null })).ownRule).toBeNull();
    expect(draftToDoc(docToDraft({ ownRule: "structure:averaging" })).ownRule).toBe("structure:averaging");
  });

  it("a prefilled rule alone does not make a plan worth a row", () => {
    expect(isDraftEmpty({ ...docToDraft({}), ownRule: "behavior:revenge" })).toBe(true);
    expect(blockDone({ ...docToDraft({}), ownRule: "behavior:revenge" }).risk).toBe(true);
  });
});
