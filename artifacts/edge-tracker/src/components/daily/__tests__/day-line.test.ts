// Component tests of the day line: server-render every state from fixtures (node env, no DOM) and check what the
// trader sees — texts in RU / UZ, links (trade sheet, desk-day, plan), actions, the closed state after the review.
import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "@/i18n";
import type { DailyMe } from "@/lib/daily/types";
import { DayLineView } from "../day-line";
import type { PlanContract } from "../daily-model";
import { eveningBroken, focusNone, me } from "./fixtures";

/** wouter's Router typed with optional children, so createElement can pass the child the canonical way. */
const SsrRouter = Router as ComponentType<{ ssrPath: string; children?: ReactNode }>;

function render(data: DailyMe, plan: PlanContract | null = null, journalOpenDate: string | null = null): string {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    createElement(QueryClientProvider, { client: qc }, createElement(SsrRouter, { ssrPath: "/" }, createElement(DayLineView, { me: data, plan, journalOpenDate }))),
  );
  return html.replace(/&amp;/g, "&").replace(/&#x27;/g, "'");
}

afterEach(async () => {
  await setLang("ru", { source: "init" });
});

describe("premarket", () => {
  it("leads with the focus: what, cost, count, examples; contract prefilled; yesterday pending; tier chip", () => {
    const html = render(me());
    expect(html).toContain("Фокус дня");
    expect(html).toContain("Усреднение против позиции");
    expect(html).toContain("−$412 за 2 недели · 6 раз");
    expect(html).toContain("/trades?from=2026-10-05&to=2026-10-16");
    // Contract: no plan yet → the focus as the suggested rule + a link into the plan.
    expect(html).toContain("правило: Не усреднять против позиции");
    expect(html).toContain("по фокусу");
    expect(html).toContain("/game-plan?view=my&date=2026-10-19");
    expect(html).toContain("16 окт: день не разобран");
    expect(html).toContain("До Джуна: 3 из 5");
    // The evening card itself stays folded in the morning.
    expect(html).not.toContain("Разобрал");
  });

  it("shows the plan's contract and yesterday's verdict once reviewed", () => {
    const html = render(me({ evening: { ...eveningBroken, reviewed: true } }), { maxLossUsd: 300, maxTrades: 10, ownRule: "behavior:revenge" });
    expect(html).toContain("стоп $300 · до 10 сделок · правило: После убытка — пауза, без реванша");
    expect(html).not.toContain("по фокусу");
    expect(html).toContain("16 окт: контракт нарушен");
    expect(html).toContain("дисциплина −2");
    expect(html).not.toContain("день не разобран");
  });

  it("source none is a short good-news line", () => {
    const html = render(me({ focus: focusNone, evening: null }));
    expect(html).toContain("Повторяющихся ошибок за 2 недели нет");
    expect(html).toContain("Контракт на день не задан");
  });
});

describe("after the close", () => {
  it("the evening card: focus broken with hits, trade to review, same ticker same day, contract, two actions", () => {
    const html = render(me({ phase: "afterclose" }));
    expect(html).toContain("Итог дня · 16 окт");
    expect(html).toContain("Фокус «Усреднение против позиции» нарушен");
    expect(html).toContain("/trades?highlight=101");
    expect(html).toContain("самый большой убыток");
    expect(html).toContain("AMD в тот день торговали ещё 6 трейдеров");
    expect(html).toContain("/desk-day?ticker=AMD&date=2026-10-16");
    expect(html).toContain("Сделки");
    expect(html).toContain("12 из 10");
    expect(html).toContain("Разобрал");
    expect(html).toContain("Это не ошибка");
    expect(html).toContain("/journal?date=2026-10-16");
  });

  it("no dispute button when the focus was kept", () => {
    const kept = { ...eveningBroken, focus: { ...eveningBroken.focus!, status: "kept" as const, hits: [], costNet: 0 } };
    const html = render(me({ phase: "afterclose", evening: kept }));
    expect(html).toContain("соблюдён");
    expect(html).not.toContain("Это не ошибка");
  });

  it("closes to one line after the review (closure) and offers the journal while the day is open", () => {
    const html = render(me({ phase: "afterclose", evening: { ...eveningBroken, reviewed: true, reviewNote: "AMD — no adds" } }), null, "2026-10-16");
    expect(html).toContain("День 16 окт разобран");
    expect(html).toContain("AMD — no adds");
    expect(html).toContain("Фокус на 19 окт");
    expect(html).toContain("Закрыть день в дневнике");
    expect(html).not.toContain("Разобрал<");
    expect(html).not.toContain("торговали ещё");
  });
});

describe("Uzbek (Latin)", () => {
  it("renders the morning and evening states in Uzbek", async () => {
    await setLang("uz", { source: "init" });
    const morning = render(me());
    expect(morning).toContain("Kun fokusi");
    expect(morning).toContain("Pozitsiyaga qarshi oʻrtachalash");
    expect(morning).toContain("Junior darajasigacha: 5 tadan 3");
    const evening = render(me({ phase: "afterclose" }));
    expect(evening).toContain("Tahlil qildim");
    expect(evening).toContain("Bu xato emas");
    expect(evening).toContain("Oʻsha kuni AMD bilan yana 6 ta treyder savdo qildi");
    expect(evening).not.toMatch(/[Ѐ-ӿ]/);
  });
});
