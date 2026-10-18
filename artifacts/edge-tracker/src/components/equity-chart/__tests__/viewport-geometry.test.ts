import { describe, expect, it } from "vitest";
import {
  clampView, ensureVisible, fullView, indexFrom, minSpanFor, pan, presetStart, presetUseful, presetView, rangeView, visibleRange, zoomAt,
  lerpView, easeOutCubic,
} from "../viewport";
import { computeLayout, indexAt, navDrag, navHit, navWindow, regionAt, slotAt, xOf, navCenter } from "../geometry";

const tos = Array.from({ length: 300 }, (_, i) => {
  const d = new Date(Date.UTC(2025, 11, 1) + i * 86400000);
  return d.toISOString().slice(0, 10);
}); // 2025-12-01 … 2026-09-26

describe("viewport", () => {
  it("full view pads both sides; a 1-day series is not one giant candle", () => {
    const f = fullView(300);
    expect(f.from).toBeLessThan(0);
    expect(f.to).toBeGreaterThan(300);
    const one = fullView(1);
    expect(one.to - one.from).toBeGreaterThanOrEqual(7);
    expect(clampView({ from: 0, to: 0.5 }, 1)).toEqual(one);
  });

  it("clamp keeps the span and the window inside the data", () => {
    const n = 300;
    expect(clampView({ from: 100, to: 101 }, n).to - clampView({ from: 100, to: 101 }, n).from).toBeCloseTo(minSpanFor(n));
    const left = clampView({ from: -100, to: -50 }, n);
    expect(left.from).toBe(fullView(n).from);
    expect(left.to - left.from).toBe(50);
    expect(clampView({ from: NaN, to: NaN }, n)).toEqual(fullView(n));
  });

  it("zoom keeps the anchor under the cursor", () => {
    const v = { from: 100, to: 200 };
    const z = zoomAt(v, 150, 0.5, 300);
    expect(z).toEqual({ from: 125, to: 175 });
    const anchorFrac = (130 - v.from) / (v.to - v.from);
    const z2 = zoomAt(v, 130, 0.5, 300);
    expect((130 - z2.from) / (z2.to - z2.from)).toBeCloseTo(anchorFrac);
    // Zooming out past everything = the full view.
    expect(zoomAt(v, 150, 100, 300)).toEqual(fullView(300));
  });

  it("pan shifts and stops at the edges", () => {
    expect(pan({ from: 100, to: 200 }, 10, 300)).toEqual({ from: 110, to: 210 });
    expect(pan({ from: 100, to: 200 }, 1000, 300).to).toBe(fullView(300).to);
  });

  it("presets look from their start to now; useless ones are detected", () => {
    const today = "2026-09-26";
    expect(presetStart("1m", today)).toBe("2026-08-26");
    expect(presetStart("1w", today)).toBe("2026-09-20");
    expect(presetStart("ytd", today)).toBe("2026-01-01");
    expect(presetStart("all", today)).toBeNull();
    const v = presetView(tos, "1m", today);
    expect(Math.round(v.from)).toBe(indexFrom(tos, "2026-08-26"));
    expect(v.to).toBe(fullView(300).to);
    expect(presetView(tos, "all", today)).toEqual(fullView(300));
    expect(presetUseful(tos, "1m", today)).toBe(true);
    expect(presetUseful(tos.slice(-5), "1m", today)).toBe(false);
    expect(presetUseful(tos.slice(-5), "all", today)).toBe(true);
  });

  it("indexFrom is a lower bound on the candle end dates", () => {
    expect(indexFrom(tos, "2025-01-01")).toBe(0);
    expect(indexFrom(tos, "2025-12-03")).toBe(2);
    expect(indexFrom(tos, "2030-01-01")).toBe(300);
  });

  it("range view frames a week clicked in the weekly view", () => {
    const v = rangeView(tos, "2026-03-02", "2026-03-06");
    const [i0, i1] = visibleRange(v, 300);
    expect(i0).toBeLessThanOrEqual(indexFrom(tos, "2026-03-02"));
    expect(i1).toBeGreaterThanOrEqual(indexFrom(tos, "2026-03-06"));
    expect(v.to - v.from).toBeLessThan(20);
  });

  it("ensureVisible moves only when needed", () => {
    const v = { from: 100, to: 150 };
    expect(ensureVisible(v, 120, 300)).toBe(v);
    expect(ensureVisible(v, 160, 300)).toEqual({ from: 112, to: 162 });
    expect(ensureVisible(v, 90, 300)).toEqual({ from: 89, to: 139 });
  });

  it("tweening", () => {
    expect(lerpView({ from: 0, to: 10 }, { from: 10, to: 30 }, 0.5)).toEqual({ from: 5, to: 20 });
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(2)).toBe(1);
  });
});

describe("geometry", () => {
  const l = computeLayout(800, 400, { pnl: true, dd: true, nav: true, axisW: 60 });

  it("stacks the panes without overlap and fits the box", () => {
    expect(l.plotW + l.axisW).toBe(800);
    expect(l.main.y + l.main.h).toBeLessThanOrEqual(l.pnl!.y);
    expect(l.pnl!.y + l.pnl!.h).toBeLessThanOrEqual(l.dd!.y);
    expect(l.dd!.y + l.dd!.h).toBeLessThanOrEqual(l.time.y);
    expect(l.nav!.y + l.nav!.h).toBeLessThanOrEqual(400);
    expect(l.main.h).toBeGreaterThan(l.pnl!.h + l.dd!.h);
    const bare = computeLayout(800, 400, { pnl: false, dd: false, nav: false, axisW: 10 });
    expect(bare.axisW).toBe(40);
    expect(bare.pnl).toBeNull();
    expect(bare.nav).toBeNull();
  });

  it("pixel ↔ slot round-trip and candle hit-testing", () => {
    const v = { from: 10, to: 20 };
    expect(slotAt(xOf(13.25, 0, 500, v), 0, 500, v)).toBeCloseTo(13.25);
    expect(indexAt(xOf(13.9, 0, 500, v), 0, 500, v, 100)).toBe(13);
    expect(indexAt(-1000, 0, 500, v, 100)).toBe(0);
    expect(indexAt(100000, 0, 500, v, 100)).toBe(99);
    expect(indexAt(10, 0, 500, v, 0)).toBe(-1);
  });

  it("regions", () => {
    expect(regionAt(100, l.main.y + 5, l)).toBe("plot");
    expect(regionAt(790, l.main.y + 5, l)).toBe("axis");
    expect(regionAt(100, l.time.y + 5, l)).toBe("time");
    expect(regionAt(100, l.nav!.y + 5, l)).toBe("nav");
  });

  it("navigator: hit parts and drags", () => {
    const n = 300;
    const nav = l.nav!;
    const v = { from: 100, to: 200 };
    const { x0, x1 } = navWindow(nav, v, n);
    expect(navHit(x0, nav, v, n)).toBe("left");
    expect(navHit(x1, nav, v, n)).toBe("right");
    expect(navHit((x0 + x1) / 2, nav, v, n)).toBe("window");
    expect(navHit(nav.x + 2, nav, v, n)).toBe("track");
    expect(navDrag("window", v, 20, n)).toEqual({ from: 120, to: 220 });
    expect(navDrag("left", v, -30, n)).toEqual({ from: 70, to: 200 });
    expect(navDrag("right", v, 30, n)).toEqual({ from: 100, to: 230 });
    // A handle can't cross the other edge (min span) nor move it.
    const squeezed = navDrag("left", v, 500, n);
    expect(squeezed.to).toBe(200);
    expect(squeezed.to - squeezed.from).toBeCloseTo(minSpanFor(n));
    expect(navDrag("left", v, -1000, n)).toEqual({ from: fullView(n).from, to: 200 });
    expect(navCenter(v, 50, n)).toEqual({ from: 0, to: 100 });
  });
});
