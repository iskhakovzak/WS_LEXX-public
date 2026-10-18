// The rewards chip in the day line: streak + points folded, the «Награды» block open (level, points window, streak,
// earned and locked badges) — RU and UZ, server-rendered from fixtures. sortBadges puts earned (newest) first.
import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "@/i18n";
import type { BadgeState, DisciplineSummary } from "@/lib/daily/types";
import { sortBadges } from "@/components/shared/badges";
import { RewardsChip } from "../rewards-chip";
import { DayLineView } from "../day-line";
import { me } from "./fixtures";

const SsrRouter = Router as ComponentType<{ ssrPath: string; children?: ReactNode }>;

const discipline: DisciplineSummary = { streak: 4, bestStreak: 7, nextBonus: 4, points30: 120, pointsTotal: 185, windowDays: 30, level: 2, levelFrom: 150, nextLevelAt: 400 };
const badges: BadgeState[] = [
  { id: "streak_1", earnedOn: "2026-10-09", target: 5, progress: 5 },
  { id: "streak_2", earnedOn: null, target: 10, progress: 4 },
  { id: "sim_first", earnedOn: "2026-10-14", target: 1, progress: 1 },
  { id: "sim_beat", earnedOn: null, target: 3, progress: 1 },
];

function render(el: ReturnType<typeof createElement>): string {
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(SsrRouter, { ssrPath: "/" }, el)));
  return html.replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/<!-- -->/g, "");
}

afterEach(async () => {
  await setLang("ru", { source: "init" });
});

describe("rewards chip", () => {
  it("folded: streak and points only", () => {
    const html = render(createElement(RewardsChip, { discipline, badges }));
    expect(html).toContain("185 очк.");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Стабильный");
  });

  it("open: level, points, streak, earned and locked badges", () => {
    const html = render(createElement(RewardsChip, { discipline, badges, defaultOpen: true }));
    expect(html).toContain("Стабильный");
    expect(html).toContain("до «Железный» — 215 очк.");
    expect(html).toContain("За 30 торговых дней: +120");
    expect(html).toContain("Контракт соблюдён 4 дня подряд");
    expect(html).toContain("рекорд 7");
    expect(html).toContain("следующий день +4");
    expect(html).toContain("Контракт 5 дней подряд");
    expect(html).toContain("получена 9 окт");
    expect(html).toContain("4 из 10");
    expect(html).toContain("2 из 4");
  });

  it("nothing without a discipline summary (older server)", () => {
    expect(render(createElement(RewardsChip, { discipline: null, badges: [] }))).toBe("");
  });

  it("sits in the day line next to the tier progress", () => {
    const html = render(createElement(DayLineView, { me: me({ discipline, badges }), plan: null }));
    expect(html).toContain("До Джуна: 3 из 5");
    expect(html).toContain("185 очк.");
  });

  it("Uzbek (Latin)", async () => {
    await setLang("uz", { source: "init" });
    const html = render(createElement(RewardsChip, { discipline, badges, defaultOpen: true }));
    expect(html).toContain("Barqaror");
    expect(html).toContain("Kontrakt ketma-ket 5 kun");
    expect(html).not.toMatch(/[Ѐ-ӿ]/);
  });

  it("earned first, newest first; then locked by progress", () => {
    expect(sortBadges(badges).map((b) => b.id)).toEqual(["sim_first", "streak_1", "streak_2", "sim_beat"]);
  });
});
