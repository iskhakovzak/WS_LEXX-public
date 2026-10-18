/**
 * Series primitive: the running average price of the open position as a step line — it moves at every add
 * (Добор) and stays through partial exits — with a small «200 шт. · ср. 10.25» pill at each change, and the open
 * size as a thin step band along the bottom of the price pane. Replay: nothing past the cursor is drawn.
 */
import type { PositionStep } from "../lib/structure";
import { chartI18n } from "@/i18n/ns/chart";
import { fmtCount, fmtPrice } from "@/lib/format";
import { SeriesPrimitiveBase, type RenderCtx, hline, label, measureLabel, vline } from "./canvas";

/** Height of the size band at the bottom of the pane (CSS px). */
const BAND = 18;

export class PositionStepsPrimitive extends SeriesPrimitiveBase {
  private steps: readonly PositionStep[] = [];
  private limit: number | null = null;
  private visible = true;

  set(steps: readonly PositionStep[]): void { this.steps = steps; this.requestUpdate(); }
  setLimit(idx: number | null): void { if (this.limit !== idx) { this.limit = idx; this.requestUpdate(); } }
  setVisible(on: boolean): void { this.visible = on; this.requestUpdate(); }

  render(rc: RenderCtx): void {
    if (!this.visible) return;
    const steps = this.steps.filter((s) => this.limit == null || s.fromIdx <= this.limit);
    // A plain entry → exit trade (two states) has nothing to step through; the position zone already shows it.
    if (this.steps.length < 3) return;
    const { ctx, theme, width, height } = rc;
    const col = theme.primary(0.9);
    const maxQty = Math.max(0, ...steps.map((s) => s.qty ?? 0));
    let prevY: number | null = null;
    const pills: { x: number; y: number; w: number }[] = [];
    for (const s of steps) {
      const toIdx = this.limit != null ? Math.min(s.toIdx, this.limit) : s.toIdx;
      const x1 = rc.x(s.fromIdx), x2 = rc.x(Math.max(toIdx, s.fromIdx));
      if (x1 == null || x2 == null) { prevY = null; continue; }
      // size band
      if (s.qty != null && maxQty > 0 && s.qty > 0) {
        const h = Math.max(2, (s.qty / maxQty) * BAND);
        ctx.fillStyle = theme.primary(theme.dark ? 0.28 : 0.18);
        ctx.fillRect(x1, height - h - 1, Math.max(1, x2 - x1), h);
      }
      if (s.avg == null) { prevY = null; continue; }
      const y = rc.y(s.avg);
      if (y == null) { prevY = null; continue; }
      if (prevY != null && Math.abs(prevY - y) > 0.5) vline(ctx, x1, prevY, y, col, 1.2, [2, 2]);
      hline(ctx, x1, Math.max(x2, x1 + 2), y, col, 1.2, [5, 3]);
      prevY = y;
      // «200 шт. · ср. 10.25» at the change, when it fits without covering the previous pill
      const text = s.qty != null ? chartI18n.t("canvas.stepQty", { qty: fmtCount(Math.round(s.qty)), price: fmtPrice(s.avg) }) : chartI18n.t("canvas.stepAvg", { price: fmtPrice(s.avg) });
      const m = measureLabel(ctx, theme, text, { size: 9, pad: 3 });
      const bx = Math.min(width - m.w - 2, x1 + 3);
      if (pills.some((p) => Math.abs(p.y - y) < m.h + 2 && bx < p.x + p.w + 4 && bx + m.w > p.x - 4)) continue;
      pills.push({ x: bx, y, w: m.w });
      label(ctx, theme, text, bx, y + 3, { anchor: "tl", size: 9, pad: 3, bg: theme.bg(0.85), color: theme.primary(1), weight: 500 });
    }
  }
}
