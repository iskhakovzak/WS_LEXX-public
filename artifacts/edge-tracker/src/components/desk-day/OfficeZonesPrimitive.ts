/**
 * Series primitive for the «Позиция офиса» layer: the office's main-position zone (where it built 20 → 80 % of its peak)
 * and its exit zone (80 → 20 % after the peak), each a shaded box over its time window and price range, labelled.
 * Drawn under the candles. Bar indexes come from model.windowBars; prices from the server (lib/deskOffice.ts).
 */
import type { ChartTheme } from "@/components/chart-engine/theme";
import { SeriesPrimitiveBase, type RenderCtx, label, roundRect } from "@/components/chart-engine/primitives/canvas";

export type OfficeZoneBox = {
  kind: "build" | "exit";
  /** Bar indexes (inclusive). */
  from: number;
  to: number;
  low: number;
  high: number;
  text: string;
};

export class OfficeZonesPrimitive extends SeriesPrimitiveBase {
  private zones: readonly OfficeZoneBox[] = [];

  constructor(theme: ChartTheme) {
    super(theme, { zOrder: "bottom" });
  }

  setZones(zones: readonly OfficeZoneBox[]): void { this.zones = zones; this.requestUpdate(); }

  render(rc: RenderCtx): void {
    const { ctx, theme, width, height } = rc;
    if (!this.zones.length) return;
    const spacing = this.chart?.timeScale().options().barSpacing ?? 6;
    for (const z of this.zones) {
      const xa = rc.x(z.from), xb = rc.x(z.to), ya = rc.y(z.high), yb = rc.y(z.low);
      if (xa == null || xb == null || ya == null || yb == null) continue;
      const x = xa - spacing / 2, w = Math.max(spacing, xb - xa + spacing);
      if (x > width || x + w < 0) continue;
      const y = Math.min(ya, yb) - 3, h = Math.max(6, Math.abs(yb - ya) + 6);
      const col = z.kind === "build" ? theme.primary : theme.fg;
      ctx.save();
      roundRect(ctx, x, y, w, h, 4);
      ctx.fillStyle = col(z.kind === "build" ? 0.12 : 0.08);
      ctx.fill();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = col(0.55);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
      label(ctx, theme, z.text, Math.max(2, x + 2), Math.max(2, y - 2), {
        anchor: "bl", clamp: { width, height }, size: 10, weight: 600, bg: z.kind === "build" ? theme.primary(0.85) : theme.muted(0.85),
      });
    }
  }
}
