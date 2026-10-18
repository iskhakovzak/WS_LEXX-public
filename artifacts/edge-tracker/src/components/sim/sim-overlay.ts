/**
 * Series primitive for the simulator chart: the player's fills (B / S circles, × stop, ✓ target), the open position
 * (average line, stop and target), and after the reveal the round trips with a mistake (tinted span + «#n») and the
 * desk's real fills (small triangles, one colour for the viewer's own trades, another for everyone else). Own mode adds
 * a dashed vertical marker where the player really entered (the decision moment).
 * Labels arrive already translated; the primitive only draws.
 */
import { fmtPrice } from "@/lib/format";
import { SeriesPrimitiveBase, type RenderCtx, hline, label } from "@/components/chart-engine/primitives/canvas";
import type { ChartTheme } from "@/components/chart-engine";

export type OverlayFill = { idx: number; price: number; qty: number; reason: "buy" | "sell" | "flat" | "stop" | "target" | "end" };
export type OverlaySpan = { from: number; to: number; text: string };
export type OverlayDeskFill = { idx: number; price: number; side: "in" | "out"; long: boolean; own: boolean; tag: string };

export type OverlayData = {
  fills: readonly OverlayFill[];
  pos: number;
  avg: number | null;
  stop: number | null;
  target: number | null;
  openIdx: number | null;
  cursor: number;
  spans: readonly OverlaySpan[];
  desk: readonly OverlayDeskFill[];
  text: { position: string | null; stop: string | null; target: string | null };
  /** Own mode: the real entry moment (drawn after the close of bar `idx`). */
  marker?: { idx: number; text: string } | null;
};

export const EMPTY_OVERLAY: OverlayData = {
  fills: [], pos: 0, avg: null, stop: null, target: null, openIdx: null, cursor: 0, spans: [], desk: [], text: { position: null, stop: null, target: null },
};

export class SimOverlayPrimitive extends SeriesPrimitiveBase {
  private d: OverlayData = EMPTY_OVERLAY;

  constructor(theme: ChartTheme) {
    super(theme, { zOrder: "top" });
  }

  set(d: OverlayData): void {
    this.d = d;
    const th = this.theme;
    const labels: { price: number; text: string; color: string }[] = [];
    if (d.pos !== 0 && d.avg != null) labels.push({ price: d.avg, text: fmtPrice(d.avg), color: th.c1(1) });
    if (d.pos !== 0 && d.stop != null) labels.push({ price: d.stop, text: fmtPrice(d.stop), color: th.down(1) });
    if (d.pos !== 0 && d.target != null) labels.push({ price: d.target, text: fmtPrice(d.target), color: th.up(1) });
    this.setAxisLabels(labels);
    this.requestUpdate();
  }

  render(rc: RenderCtx): void {
    const d = this.d;
    const { ctx, theme, width, height } = rc;

    if (d.marker) {
      // Integer logical indices only (the decision bar may be the last one loaded): its centre + half a bar.
      const xc = rc.x(d.marker.idx), xp = rc.x(d.marker.idx - 1);
      const x = xc != null ? xc + (xp != null ? (xc - xp) / 2 : 0) : null;
      if (x != null && x >= 0 && x <= width) {
        ctx.save();
        ctx.strokeStyle = theme.c1(0.85);
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, height);
        ctx.stroke();
        ctx.restore();
        label(ctx, theme, d.marker.text, x + 3, 24, { anchor: "tl", bg: theme.c1(0.9), size: 10, clamp: { width, height } });
      }
    }

    for (const s of d.spans) {
      const x1 = rc.x(s.from - 0.5), x2 = rc.x(s.to + 0.5);
      if (x1 == null || x2 == null || x2 < 0 || x1 > width) continue;
      ctx.fillStyle = theme.down(theme.dark ? 0.1 : 0.08);
      ctx.fillRect(x1, 0, Math.max(2, x2 - x1), height);
      label(ctx, theme, s.text, Math.max(4, x1 + 2), 6, { anchor: "tl", bg: theme.down(0.85), size: 10, clamp: { width, height } });
    }

    if (d.pos !== 0 && d.avg != null && d.openIdx != null) {
      const x0 = rc.x(d.openIdx) ?? 0;
      const xc = rc.x(d.cursor + 0.5) ?? width;
      const y = rc.y(d.avg);
      if (y != null) {
        hline(ctx, x0, xc, y, theme.c1(0.95), 1.5);
        hline(ctx, xc, width, y, theme.c1(0.35), 1, [4, 4]);
        if (d.text.position) label(ctx, theme, d.text.position, Math.max(4, x0), y - 4, { anchor: "bl", bg: theme.c1(0.9), size: 10, clamp: { width, height } });
      }
      if (d.stop != null) {
        const ys = rc.y(d.stop);
        if (ys != null) {
          hline(ctx, x0, width, ys, theme.down(0.9), 1, [6, 4]);
          if (d.text.stop) label(ctx, theme, d.text.stop, Math.max(4, x0), ys + 3, { anchor: "tl", bg: theme.down(0.85), size: 10, clamp: { width, height } });
        }
      }
      if (d.target != null) {
        const yt = rc.y(d.target);
        if (yt != null) {
          hline(ctx, x0, width, yt, theme.up(0.9), 1, [6, 4]);
          if (d.text.target) label(ctx, theme, d.text.target, Math.max(4, x0), d.pos > 0 ? yt - 3 : yt + 3, { anchor: d.pos > 0 ? "bl" : "tl", bg: theme.up(0.85), size: 10, clamp: { width, height } });
        }
      }
    }

    for (const f of d.desk) {
      const x = rc.x(f.idx), y = rc.y(f.price);
      if (x == null || y == null || x < -10 || x > width + 10) continue;
      // Buying (long in / short out) points up, selling points down.
      const up = f.side === "in" ? f.long : !f.long;
      const col = f.own ? theme.c1(1) : theme.c5(1);
      const s = 5;
      ctx.beginPath();
      if (up) { ctx.moveTo(x, y + 2); ctx.lineTo(x - s, y + 2 + s * 1.6); ctx.lineTo(x + s, y + 2 + s * 1.6); }
      else { ctx.moveTo(x, y - 2); ctx.lineTo(x - s, y - 2 - s * 1.6); ctx.lineTo(x + s, y - 2 - s * 1.6); }
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.fill();
      if (f.tag) {
        ctx.fillStyle = col;
        ctx.font = `600 9px ${theme.font}`;
        ctx.textAlign = "center";
        ctx.textBaseline = up ? "top" : "bottom";
        ctx.fillText(f.tag, x, up ? y + 4 + s * 1.6 : y - 4 - s * 1.6);
      }
    }

    for (const f of d.fills) {
      const x = rc.x(f.idx), y = rc.y(f.price);
      if (x == null || y == null || x < -10 || x > width + 10) continue;
      const buy = f.qty > 0;
      const col = f.reason === "stop" ? theme.down(1) : f.reason === "target" ? theme.up(1) : buy ? theme.up(1) : theme.down(1);
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = theme.bg(1);
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.font = `700 9px ${theme.font}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(f.reason === "stop" ? "×" : f.reason === "target" ? "✓" : buy ? "B" : "S", x, y + 0.5);
    }
  }
}
