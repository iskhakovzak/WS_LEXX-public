import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setLang, type Lang } from "@/i18n";
import { parseAsk, type AskQuery, type ParseContext } from "@/lib/ask/parse";
import { askExamples, askStarters, chipAlternatives, suggestFor } from "@/lib/ask/examples";
import { canonicalText, groupTrades, type AskTrade } from "@/lib/ask/aggregate";
import { makeBook, runAsk } from "@/lib/ask/run";

// Every question text the app writes for the user (examples, starters, chip swaps, suggestions, follow-ups) must
// parse in the UI language with nothing left over, and answers must come out in that language.
let id = 0;
function t(date: string, clock: string, ticker: string, side: "Long" | "Short", pnl: number, extra: Partial<AskTrade> = {}): AskTrade {
  id++;
  const [h, m] = clock.split(":").map(Number);
  const close = `${date}T${String(h + (m + 7 >= 60 ? 1 : 0)).padStart(2, "0")}:${String((m + 7) % 60).padStart(2, "0")}:00`;
  return {
    id, date, ticker, side, pnl, fees: 1, qty: 100 + id * 10, entry: 5 + id, trader: "Ориф", setup: id % 2 ? "news" : "gap and go",
    result: pnl - 1 > 0 ? "win" : pnl - 1 < 0 ? "loss" : "be",
    contextSnapshot: { openedAt: `${date}T${clock}:00`, closedAt: close }, ...extra,
  };
}
const trades: AskTrade[] = [
  t("2026-09-14", "09:45", "AAPL", "Long", 50), t("2026-09-15", "10:15", "AAPL", "Long", -30), t("2026-09-18", "14:30", "NVDA", "Short", -40),
  t("2026-10-12", "09:45", "AAPL", "Long", 50), t("2026-10-12", "10:15", "AAPL", "Long", -30), t("2026-10-12", "14:30", "NVDA", "Short", -40),
  t("2026-10-13", "09:40", "NVDA", "Long", 20), t("2026-10-13", "14:10", "NVDA", "Short", -25), t("2026-10-14", "09:50", "AAPL", "Long", 35),
  t("2026-10-15", "15:20", "INTC", "Short", -60), t("2026-10-16", "09:35", "AAPL", "Long", 80), t("2026-10-16", "09:55", "AAPL", "Long", -10),
  t("2026-10-16", "10:20", "AAPL", "Long", -15), t("2026-10-16", "10:40", "NVDA", "Long", 12),
];
const book = makeBook(trades);
const ctx: ParseContext = { today: "2026-10-16", traders: ["Ориф", "Тимур"], tickers: book.tickers.map((x) => x.value), setups: ["news", "gap and go"] };
const p = (s: string) => parseAsk(s, ctx);

function parsesClean(text: string): AskQuery {
  const q = p(text);
  expect(q.ok, text).toBe(true);
  expect(q.unknown, text).toEqual([]);
  return q;
}

const CHIP_KINDS = ["date", "time", "side", "outcome", "weekday", "hold", "qty", "price", "after", "group", "intent", "last"] as const;
const CYR = /[Ѐ-ӿ]/;

describe.each<Lang>(["ru", "en", "uz"])("%s", (lang) => {
  beforeAll(async () => { await setLang(lang, { source: "init" }); });
  afterAll(async () => { await setLang("ru", { source: "init" }); });

  it("examples and starters parse", () => {
    for (const s of [...askExamples(), ...askStarters()]) parsesClean(s);
  });

  it("chip alternatives parse and stay in their facet", () => {
    for (const kind of CHIP_KINDS) {
      for (const s of chipAlternatives(kind)) {
        const q = parsesClean(s);
        expect(q.tokens.some((tk) => tk.kind === kind || (kind === "intent" && tk.kind === "intent")), `${kind}: ${s}`).toBe(true);
      }
    }
    for (const s of chipAlternatives("setup", { setups: ["news"] })) expect(parsesClean(s).setups).toEqual(["news"]);
  });

  it("«не понял» suggestions parse", () => {
    for (const raw of ["комиссии", "fees", "komissiya", "утро", "morning", "пятница", "friday", "серия", "streak", "размер", "size", "лонг", "short", "AAPL что-то"]) {
      for (const s of suggestFor(raw, null, ["AAPL"])) parsesClean(s);
    }
  });

  it("canonical follow-ups round-trip", () => {
    const filters = [
      "шорты NVDA по пятницам после 14:00", "лонги прибыльные дешевле 10$ дольше 5 минут", "сетап news с 1 по 10 октября",
      "размер от 100 до 500 акций до 10:30", "убыточные после 2 убытков подряд последние 20 сделок", "с 10:00 до 11:00 дороже 5$ короче 30 секунд",
      "по понедельникам и пятницам цена от 5 до 20$", "до 15 октября размер меньше 200 акций",
    ];
    for (const ru of filters) {
      const q = parseAsk(ru, ctx);
      const text = canonicalText(q, { allTraders: q.allTraders });
      if (lang !== "ru") expect(CYR.test(text), text).toBe(false);
      const again = parsesClean(text);
      for (const k of ["side", "outcome", "tickers", "setups", "weekdays", "price", "holdSec", "qty", "after", "lastN"] as const) {
        expect(again[k], `${text} · ${k}`).toEqual(q[k]);
      }
      expect(again.date && [again.date.from, again.date.to], text).toEqual(q.date && [q.date.from, q.date.to]);
      expect(again.time && [again.time.fromMin, again.time.toMin], text).toEqual(q.time && [q.time.fromMin, q.time.toMin]);
    }
  });

  it("group rows ask follow-ups in this language", () => {
    for (const dim of ["hour", "weekday", "month", "week", "side", "setup", "slot", "holdBucket", "sizeBucket"] as const) {
      for (const row of groupTrades(trades, dim, book.index)) {
        if (!row.ask) continue;
        if (lang !== "ru") expect(CYR.test(row.ask), row.ask).toBe(false);
        parsesClean(row.ask);
      }
    }
  });

  it("answers are written in this language", () => {
    const questions = [...askExamples(), ...askStarters()];
    for (const s of questions) {
      const r = runAsk(p(s), book, { me: "Ориф" });
      const a = r.answer;
      const texts = [a.subject, a.headline, a.big.label, a.big.value, a.big.sub ?? "", a.tradesTitle, a.linkLabel, a.chart?.title ?? "", a.groups?.title ?? "", ...a.notes, ...a.stats.map((x) => `${x.label} ${x.hint ?? ""}`)];
      if (lang !== "ru") for (const x of texts) expect(CYR.test(x.replace(/Ориф/g, "")), `${s}: ${x}`).toBe(false);
      for (const tk of p(s).tokens) if (lang !== "ru") expect(CYR.test(tk.label), tk.label).toBe(false);
    }
  });
});

describe("rendered answers", () => {
  afterAll(async () => { await setLang("ru", { source: "init" }); });
  it("EN", async () => {
    await setLang("en", { source: "init" });
    expect(runAsk(p("morning vs afternoon"), book, { me: "Ориф" }).answer.headline).toMatch(/^Better: in the morning/);
    expect(runAsk(p("how much I paid in fees"), book, { me: "Ориф" }).answer.headline).toBe("Trades · Ориф: fees $14.00 over 14 trades (gross −$3.00, net −$17.00).");
    expect(runAsk(p("longest losing streak"), book, { me: "Ориф" }).answer.big.value).toBe("2 trades");
    expect(p("INTC shorts in October after 11:00").tokens.find((tk) => tk.kind === "date")?.label).toBe("Period: 10/01–10/31/2026");
  });
  it("UZ", async () => {
    await setLang("uz", { source: "init" });
    expect(runAsk(p("ertalab vs tushdan keyin"), book, { me: "Ориф" }).answer.headline).toMatch(/^Yaxshiroq — ertalab/);
    expect(runAsk(p("eng uzun zarar seriyasi"), book, { me: "Ориф" }).answer.big.value).toBe("2 ta savdo");
    expect(runAsk(p("INTC shortlar oktabrda"), book, { me: "Ориф" }).answer.subject).toBe("Shortlar: INTC, oktabrda · Ориф");
  });
});
