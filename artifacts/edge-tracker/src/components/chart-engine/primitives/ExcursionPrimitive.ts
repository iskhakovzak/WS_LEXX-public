/**
 * Series primitive: MFE / MAE brackets — a vertical bracket from the average entry to the extreme
 * at the bar where it printed, with «$ · % · R» (R only with a stop). «≈» marks the approximate
 * case (entry/exit bar range partially excluded).
 */
import type { ExcursionResult } from "../types";
import { fmtPct, fmtPrice, fmtR, fmtUsd } from "@/lib/format";
import { SeriesPrimitiveBase, type RenderCtx, hline, label, vline } from "./canvas";

export type ExcursionData = {
  result: ExcursionResult;
  avgEntry: number;
  /** Bar indices (current timeframe) where the extremes printed. */
  mfeIdx: number | null;
  maeIdx: number | null;
};

export class ExcursionPrimitive extends SeriesPrimitiveBase {
  private data: ExcursionData | null = null;
  private visible = true;

  set(data: ExcursionData | null): void { this.data = data; this.requestUpdate(); }
  setVisible(on: boolean): void { this.visible = on; this.requestUpdate(); }

  render(rc: RenderCtx): void {
    const d = this.data;
    if (!d || !this.visible) return;
    const { ctx, theme, width, height } = rc;
    const yEntry = rc.y(d.avgEntry);
    if (yEntry == null) return;
    const r = d.result;
    const approx = r.approximate ? "≈" : "";
    const draw = (idx: number | null, price: number | null, usd: number | null, pct: number | null, rr: number | null, title: string, color: (a?: number) => string, above: boolean) => {
      if (idx == null || price == null) return;
      const x = rc.x(idx), y = rc.y(price);
      if (x == null || y == null) return;
      vline(ctx, x, Math.min(y, yEntry), Math.max(y, yEntry), color(0.9), 1.5);
      hline(ctx, x - 5, x + 5, y, color(1), 2);
      hline(ctx, x - 3, x + 3, yEntry, color(0.6), 1);
      const parts = [`${title} ${approx}${fmtPrice(price)}`];
      if (usd != null) parts.push(fmtUsd(usd, { signed: true, decimals: "auto" }));
      if (pct != null) parts.push(fmtPct(pct));
      if (rr != null) parts.push(fmtR(rr));
      label(ctx, theme, parts.join(" · "), x + 6, above ? y - 4 : y + 4, { anchor: above ? "bl" : "tl", bg: color(0.9), clamp: { width, height }, size: 10 });
    };
    const longish = r.mfePrice != null && r.mfePrice >= d.avgEntry;
    draw(d.mfeIdx, r.mfePrice, r.mfeUsd, r.mfePct, r.mfeR, "MFE", theme.up, longish);
    draw(d.maeIdx, r.maePrice, r.maeUsd, r.maePct, r.maeR, "MAE", theme.down, !longish);
  }
}
