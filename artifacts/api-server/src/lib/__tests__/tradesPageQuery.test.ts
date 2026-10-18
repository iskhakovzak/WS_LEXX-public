import { describe, it, expect } from "vitest";
import {
  buildCountQuery, buildCurveQuery, buildDaysQuery, buildPresetFacetQuery, buildSummaryQuery, PAGE_PRESETS,
  type TradesPageFilters,
} from "../tradesPageQuery";

const base: TradesPageFilters = { scope: null, source: "", outcome: "", exitEffMax: null, mfeRMin: null, leftMin: null, preset: "" };

/** Every $n used in the SQL has a param and every param is used (a shifted placeholder is a silent wrong answer). */
function placeholdersMatch(q: { sql: string; params: unknown[] }) {
  const used = new Set([...q.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  expect(Math.max(0, ...used)).toBe(q.params.length);
  for (let i = 1; i <= q.params.length; i++) expect(used.has(i)).toBe(true);
}

const cases: TradesPageFilters[] = [
  base,
  { ...base, scope: "Максим Р." },
  { ...base, scope: "Максим Р.", from: "2026-10-01", to: "2026-10-16", preset: "revenge" },
  { ...base, preset: "scalp", outcome: "loss", setup: "ORB", q: "aapl" },
  { ...base, exitEffMax: 50, mfeRMin: 1 },
];

describe("tradesPageQuery builders", () => {
  it("keep $n placeholders and params in step", () => {
    for (const f of cases) {
      for (const q of [
        buildSummaryQuery(f, true), buildCurveQuery(f, true), buildPresetFacetQuery(f, true), buildCountQuery(f, true),
        buildDaysQuery(f, true, { limit: 30 }), buildDaysQuery(f, true, { limit: 30, before: "2026-09-01" }),
      ]) placeholdersMatch(q);
    }
  });

  it("compute per-row expressions once (OFFSET 0 fence) in the aggregate queries", () => {
    expect(buildSummaryQuery(base, true).sql).toMatch(/OFFSET 0\) x/);
    expect(buildCurveQuery(base, true).sql).toMatch(/OFFSET 0\) x/);
    expect(buildDaysQuery(base, true, { limit: 30 }).sql).toMatch(/OFFSET 0\) x/);
    expect(buildPresetFacetQuery(base, true).sql).toMatch(/OFFSET 0\) x/);
  });

  it("returns one counter per preset", () => {
    const sql = buildPresetFacetQuery(base, true).sql;
    for (const k of PAGE_PRESETS) expect(sql).toContain(`AS "${k}"`);
  });

  it("cuts the revenge window to the filtered date range", () => {
    const q = buildPresetFacetQuery({ ...base, from: "2026-10-01", to: "2026-10-16" }, true);
    expect(q.sql).toMatch(/rv0\.date >= \$\d+ AND rv0\.date <= \$\d+/);
    expect(q.params.filter((p) => p === "2026-10-01")).toHaveLength(2);
  });

  it("evaluates the days filter once (materialized ids)", () => {
    const q = buildDaysQuery({ ...base, preset: "revenge" }, true, { limit: 30 });
    expect(q.sql).toMatch(/WITH filtered AS MATERIALIZED/);
    expect(q.sql.match(/rv0\.deleted_at IS NULL/g)).toHaveLength(1);
  });
});
