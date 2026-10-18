/**
 * Series primitive: the trainee's paper position in training — their own fills (circles with B/S), the average price
 * of the open position, its stop and target, and after the reveal the «ideal» round trip (dashed) for comparison.
 * Deliberately different from the real fills' arrows so the two never get confused.
 */
import { fmtPrice } from "@/lib/format";
import { chartI18n } from "@/i18n/ns/chart";
import { SeriesPrimitiveBase, type RenderCtx, hline, label, line } from "./canvas";

export type SimDrawFill = { idx: number; price: number; qty: number; reason: "buy" | "sell" | "flat" | "half" | "stop" | "target" };
export type SimDrawData = {
  fills: readonly SimDrawFill[];
  /** Open position: signed shares, average price, stop and the bar it was opened on. */
  pos: number;
  avg: number | null;
  stop: number | null;
  target?: number | null;
  openIdx: number | null;
  cursor: number | null;
  ideal: { fromIdx: number; toIdx: number; fromPrice: number; toPrice: number; side: "long" | "short" } | null;
};

export class SimPositionPrimitive extends SeriesPrimitiveBase {
  private data: SimDrawData | null = null;

  constructor(theme: ConstructorParameters<typeof SeriesPrimitiveBase>[0]) {
    super(theme, { zOrder: "top" });
  }

  set(data: SimDrawData | null): void {
    this.data = data;
    const labels: { price: number; text: string; color: string }[] = [];
    if (data && data.pos !== 0 && data.avg != null) labels.push({ price: data.avg, text: fmtPrice(data.avg), color: this.theme.c1(1) });
    if (data && data.pos !== 0 && data.stop != null) labels.push({ price: data.stop, text: fmtPrice(data.stop), color: this.theme.down(1) });
    if (data && data.pos !== 0 && data.target != null) labels.push({ price: data.target, text: fmtPrice(data.target), color: this.theme.up(1) });
    this.setAxisLabels(labels);
    this.requestUpdate();
  }

  render(rc: RenderCtx): void {
    const d = this.data;
    if (!d) return;
    const { ctx, theme, width, height } = rc;
    if (d.ideal) {
      const x1 = rc.x(d.ideal.fromIdx), x2 = rc.x(d.ideal.toIdx), y1 = rc.y(d.ideal.fromPrice), y2 = rc.y(d.ideal.toPrice);
      if (x1 != null && x2 != null && y1 != null && y2 != null) {
        line(ctx, x1, y1, x2, y2, theme.c3(0.95), 1.5, [5, 4]);
        for (const [x, y] of [[x1, y1], [x2, y2]] as const) { ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fillStyle = theme.c3(1); ctx.fill(); }
        label(ctx, theme, chartI18n.t("canvas.ideal", { side: chartI18n.t(d.ideal.side === "long" ? "structure.long" : "structure.short"), from: fmtPrice(d.ideal.fromPrice), to: fmtPrice(d.ideal.toPrice) }), (x1 + x2) / 2, Math.min(y1, y2) - 6, { anchor: "c", bg: theme.c3(0.9), color: "#111", size: 10, clamp: { width, height } });
      }
    }
    if (d.pos !== 0 && d.avg != null && d.openIdx != null) {
      const x0 = rc.x(d.openIdx) ?? 0;
      const xEnd = d.cursor != null ? (rc.x(d.cursor + 0.5) ?? width) : width;
      const y = rc.y(d.avg);
      if (y != null) {
        hline(ctx, x0, xEnd, y, theme.c1(0.95), 1.5);
        hline(ctx, xEnd, width, y, theme.c1(0.35), 1, [4, 4]);
        label(ctx, theme, chartI18n.t("canvas.you", { side: chartI18n.t(d.pos > 0 ? "structure.long" : "structure.short"), qty: Math.abs(d.pos), price: fmtPrice(d.avg) }), Math.max(4, x0), y - 4, { anchor: "bl", bg: theme.c1(0.9), size: 10, clamp: { width, height } });
      }
      if (d.stop != null) {
        const ys = rc.y(d.stop);
        if (ys != null) {
          hline(ctx, x0, width, ys, theme.down(0.9), 1, [6, 4]);
          label(ctx, theme, chartI18n.t("canvas.stop", { price: fmtPrice(d.stop) }), Math.max(4, x0), ys + 3, { anchor: "tl", bg: theme.down(0.85), size: 10, clamp: { width, height } });
        }
      }
      if (d.target != null) {
        const yt = rc.y(d.target);
        if (yt != null && yt >= 0 && yt <= height) {
          hline(ctx, x0, width, yt, theme.up(0.9), 1, [6, 4]);
          const above = d.pos > 0;
          label(ctx, theme, chartI18n.t("canvas.target", { price: fmtPrice(d.target) }), Math.max(4, x0), above ? yt - 3 : yt + 3, { anchor: above ? "bl" : "tl", bg: theme.up(0.85), size: 10, clamp: { width, height } });
        }
      }
    }
    for (const f of d.fills) {
      const x = rc.x(f.idx), y = rc.y(f.price);
      if (x == null || y == null) continue;
      const buy = f.qty > 0;
      const col = f.reason === "stop" ? theme.down(1) : f.reason === "target" ? theme.c3(1) : buy ? theme.up(1) : theme.c4(1);
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = theme.bg(1);
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.font = `600 9px ${theme.font}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(f.reason === "stop" ? "×" : f.reason === "target" ? "✓" : buy ? "B" : "S", x, y + 0.5);
    }
  }
}
