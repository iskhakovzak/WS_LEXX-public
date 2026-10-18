import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "@/i18n";
import { canonicalText } from "@/lib/ask/aggregate";
import { parseAsk, type ParseContext } from "@/lib/ask/parse";
import { clearLatinNames, setLatinNames } from "@/lib/people/latin-names";

// Trader names in Ask follow the display rule (personName): labels show the Latin name in EN / UZ, the filter keeps
// the stored name, and a follow-up question written with the Latin name parses back to the same trader.
const ctx: ParseContext = { today: "2026-10-16", traders: ["Дмитрий К.", "Тимур"], tickers: ["INTC"], setups: [] };

afterEach(async () => {
  clearLatinNames();
  await setLang("ru", { source: "init" });
});

describe("Ask with Latin display names", () => {
  it("labels in Latin, keeps the stored name, round-trips the follow-up text", async () => {
    setLatinNames([["Дмитрий К.", "Dmitriy K."]]);
    await setLang("en", { source: "init" });
    const q = parseAsk("Dmitriy K. INTC shorts", ctx);
    expect(q.trader).toBe("Дмитрий К.");
    expect(q.tokens.find((t) => t.kind === "trader")?.label).toContain("Dmitriy K.");
    const text = canonicalText({ ...q, trader: "Дмитрий К." });
    expect(text).toContain("Dmitriy K.");
    expect(parseAsk(text, ctx).trader).toBe("Дмитрий К.");
  });
});
