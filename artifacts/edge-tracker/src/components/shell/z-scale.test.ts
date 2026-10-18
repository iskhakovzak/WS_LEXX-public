/**
 * Layer scale guard: z-index comes only from the tokens in index.css (z-sticky < z-header < z-nav < z-sheet <
 * z-modal < z-popover < z-toast < z-tooltip). Raw `z-10` / `z-[9999]` are only tolerated in files recorded in
 * scripts/check-z.baseline.json, and never more of them than recorded (ratchet).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-ignore — plain ESM script without type declarations (test files are outside tsc)
import { ROOT, scanZ, newViolations, readBaseline } from "../../../scripts/check-z.mjs";

type Hit = { file: string; line: number; match: string };

describe("z-index scale", () => {
  it("has no raw z-index values beyond the baseline", () => {
    const bad = newViolations() as Hit[];
    expect(bad.map((h) => `${h.file}:${h.line} ${h.match}`)).toEqual([]);
  });

  it("keeps the shell, ui kit, ds and global overlays fully on tokens", () => {
    const owned = /^src\/(components\/(ui|ds|shell|notifications)\/|components\/(ds|layout|global-search|undo-toast|screenshot-fields|tag-selector|voice-[\w-]+)\.tsx$|index\.css$)/;
    const hits = (scanZ() as Hit[]).filter((h) => owned.test(h.file));
    expect(hits.map((h) => `${h.file}:${h.line} ${h.match}`)).toEqual([]);
    expect(Object.keys(readBaseline()).filter((f) => owned.test(f))).toEqual([]);
  });

  it("orders the layer tokens: sticky < header < nav < sheet < modal < popover < toast < tooltip", () => {
    const css = fs.readFileSync(path.join(ROOT, "src/index.css"), "utf8");
    const z = (name: string) => Number(css.match(new RegExp(`--z-${name}:\\s*(\\d+)`))?.[1]);
    const order = ["raised", "sticky", "header", "nav", "sheet", "modal", "popover", "toast", "tooltip", "skip"].map(z);
    expect(order.every((v) => Number.isFinite(v))).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(z("sticky-corner")).toBeGreaterThan(z("sticky"));
    expect(z("sticky-corner")).toBeLessThan(z("header"));
  });
});
