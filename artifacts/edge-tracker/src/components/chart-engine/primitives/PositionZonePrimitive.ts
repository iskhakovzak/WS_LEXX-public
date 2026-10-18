/**
 * Series primitive: the position zone — a rectangle from the first entry to the last exit between
 * the average entry and the average exit, green/red by net result, with the average-entry line.
 * During replay the right edge follows the cursor and the far price edge is the current close.
 */
import { fmtPrice } from "@/lib/format";
import { chartI18n } from "@/i18n/ns/chart";
import { SeriesPrimitiveBase, type RenderCtx, hline, label, layoutLabels, leader, measureLabel } from "./canvas";

export type PositionZoneData = {
  fromIdx: number;
  toIdx: number | null;
  avgEntry: number;
  avgExit: number | null;
  /** Net result sign for the colour (null ⇒ derive from prices + side). */
  positive: boolean | null;
  side: "long" | "short";
  multipleEntries: boolean;
};

export class PositionZonePrimitive extends SeriesPrimitiveBase {
  private data: PositionZoneData | null = null;
  private limit: number | null = null;
  private mark: number | null = null;
  private visible = true;

  set(data: PositionZoneData | null): void {
    this.data = data;
    this.syncAxis();
    this.requestUpdate();
  }
  private syncAxis(): void {
    const d = this.visible ? this.data : null;
    this.setAxisLabels(d ? [{ price: d.avgEntry, text: fmtPrice(d.avgEntry), color: this.theme.primary(1) }] : []);
  }
  /** Replay cursor (bar index) and the close at that bar. */
  setCursor(idx: number | null, mark: number | null): void { this.limit = idx; this.mark = mark; this.requestUpdate(); }
  setVisible(on: boolean): void { this.visible = on; this.syncAxis(); this.requestUpdate(); }

  render(rc: RenderCtx): void {
    const d = this.data;
    if (!d || !this.visible) return;
    const { ctx, theme, width, height } = rc;
    if (this.limit != null && this.limit < d.fromIdx) return;
    const exitKnown = d.toIdx != null && (this.limit == null || this.limit >= d.toIdx);
    const toIdx = exitKnown ? (d.toIdx as number) : (this.limit ?? d.toIdx ?? d.fromIdx);
    const far = exitKnown ? d.avgExit : this.mark;
    if (far == null) return;
    const positive = exitKnown && d.positive != null ? d.positive : d.side === "long" ? far >= d.avgEntry : far <= d.avgEntry;
    const color = positive ? theme.up : theme.down;
    const x1 = rc.x(d.fromIdx - 0.5), x2 = rc.x(toIdx + 0.5);
    const yA = rc.y(d.avgEntry), yB = rc.y(far);
    if (x1 == null || x2 == null || yA == null || yB == null) return;
    const top = Math.min(yA, yB), h = Math.max(2, Math.abs(yB - yA));
    ctx.fillStyle = color(theme.dark ? 0.14 : 0.12);
    ctx.fillRect(x1, top, x2 - x1, h);
    ctx.strokeStyle = color(0.5);
    ctx.lineWidth = 1;
    ctx.setLineDash(exitKnown ? [] : [3, 3]);
    ctx.strokeRect(Math.round(x1) + 0.5, Math.round(top) + 0.5, Math.round(x2 - x1), Math.round(h));
    ctx.setLineDash([]);
    // Average entry line: across the zone, then faint to the right edge of the pane.
    hline(ctx, x1, x2, yA, theme.primary(0.95), 1.5);
    hline(ctx, x2, width, yA, theme.primary(0.35), 1, [4, 4]);
    // Labels with collision avoidance: entry above its line on the left, exit on the right beyond its
    // line; when the prices are close the boxes are pushed apart and a leader line points at the price.
    const opts = { size: 10 } as const;
    const entryText = chartI18n.t(d.multipleEntries ? "canvas.avgEntry" : "canvas.entry", { price: fmtPrice(d.avgEntry) });
    const entryBox = measureLabel(ctx, theme, entryText, opts);
    const items: { text: string; x: number; y: number; h: number; w: number; lineY: number; bg: string; leaderX: (bx: number, w: number) => number }[] = [
      { text: entryText, x: x1 + 4, y: yA - 4 - entryBox.h, h: entryBox.h, w: entryBox.w, lineY: yA, bg: theme.primary(0.9), leaderX: (bx) => bx + 6 },
    ];
    if (exitKnown && d.avgExit != null) {
      const exitText = chartI18n.t("canvas.exit", { price: fmtPrice(d.avgExit) });
      const box = measureLabel(ctx, theme, exitText, opts);
      items.push({ text: exitText, x: x2 - 4 - box.w, y: yB >= yA ? yB + 4 : yB - 4 - box.h, h: box.h, w: box.w, lineY: yB, bg: color(0.9), leaderX: (bx, w) => bx + w - 6 });
    }
    const tops = layoutLabels(items, height);
    items.forEach((it, i) => {
      const bx = Math.max(2, Math.min(width - it.w - 2, it.x));
      const box = label(ctx, theme, it.text, bx, tops[i], { anchor: "tl", bg: it.bg, size: opts.size });
      leader(ctx, it.leaderX(box.x, box.w), it.lineY, box, it.bg);
    });
  }
}
