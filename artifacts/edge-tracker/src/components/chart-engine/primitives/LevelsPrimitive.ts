/**
 * Series primitive: horizontal key levels (PDH/PDL/PDC, PMH/PML, ORB 5/15, POC…) as full-width
 * lines with a compact label on the left. Pass an empty list to hide.
 */
import { fmtPrice } from "@/lib/format";
import { SeriesPrimitiveBase, type RenderCtx, hline, label, layoutLabels, leader, measureLabel } from "./canvas";

export type LevelLine = {
  key: string;
  price: number;
  text: string;
  color: string;
  dash?: number[];
  width?: number;
  /** Only draw from this bar index onward (e.g. ORB from the open). */
  fromIdx?: number;
};

export class LevelsPrimitive extends SeriesPrimitiveBase {
  private levels: readonly LevelLine[] = [];

  set(levels: readonly LevelLine[]): void {
    this.levels = levels.filter((l) => Number.isFinite(l.price) && l.price > 0);
    // No price-axis labels: the in-pane labels already name each level, and axis tags for 5–9 levels piled up
    // over the price scale and hid the last price.
    this.requestUpdate();
  }

  render(rc: RenderCtx): void {
    if (!this.levels.length) return;
    const { ctx, theme, width, height } = rc;
    const opts = { size: 9, pad: 3 } as const;
    const items: { text: string; x: number; y: number; h: number; w: number; lineY: number; color: string }[] = [];
    for (const l of this.levels) {
      const y = rc.y(l.price);
      if (y == null || y < -20 || y > height + 20) continue;
      const x0 = Math.max(0, l.fromIdx != null ? (rc.x(l.fromIdx - 0.5) ?? 0) : 0);
      hline(ctx, x0, width, y, l.color, l.width ?? 1, l.dash ?? [2, 3]);
      const text = `${l.text} ${fmtPrice(l.price)}`;
      const box = measureLabel(ctx, theme, text, opts);
      items.push({ text, x: x0 + 4, y: y - box.h / 2, h: box.h, w: box.w, lineY: y, color: l.color });
    }
    if (!items.length) return;
    // Labels that would overlap (close prices such as PMH/PDH) are stacked apart with leader lines to their level.
    const tops = layoutLabels(items, height);
    items.forEach((it, i) => {
      const bx = Math.max(2, Math.min(width - it.w - 2, it.x));
      const box = label(ctx, theme, it.text, bx, tops[i], { anchor: "tl", bg: it.color, size: opts.size, pad: opts.pad });
      leader(ctx, box.x + Math.min(10, box.w / 2), it.lineY, box, it.color);
    });
  }
}
