/**
 * Series primitive: user drawings (horizontal level, trendline, rectangle, Fibonacci) stored in
 * (time, price) so they survive timeframe switches. Also renders the in-progress preview and the
 * selection; hit-testing reports `drawing:<id>` so the host can select / delete.
 */
import type { PrimitiveHoveredItem } from "lightweight-charts";
import type { Candle, Drawing } from "../types";
import { timeToLogical } from "../lib/time";
import { FIB_LEVELS, distToSegment } from "../lib/drawings";
import { fmtPrice } from "@/lib/format";
import { SeriesPrimitiveBase, type RenderCtx, hline, label, line } from "./canvas";

type Shape = { id: string; segments: [number, number, number, number][]; rect?: [number, number, number, number] };

export class DrawingsPrimitive extends SeriesPrimitiveBase {
  private drawings: readonly Drawing[] = [];
  private preview: Drawing | null = null;
  private selected: string | null = null;
  private bars: readonly Candle[] = [];
  private barSec = 60;
  private shapes: Shape[] = [];

  setScale(bars: readonly Candle[], barSec: number): void { this.bars = bars; this.barSec = barSec; this.requestUpdate(); }
  setDrawings(d: readonly Drawing[]): void { this.drawings = d; this.requestUpdate(); }
  setPreview(d: Drawing | null): void { this.preview = d; this.requestUpdate(); }
  setSelected(id: string | null): void { this.selected = id; this.requestUpdate(); }

  private xOf(rc: RenderCtx, time: number): number | null {
    return rc.x(timeToLogical(this.bars, time, this.barSec));
  }

  render(rc: RenderCtx): void {
    this.shapes = [];
    const all = this.preview ? [...this.drawings, this.preview] : this.drawings;
    for (const d of all) this.renderOne(rc, d, d === this.preview);
  }

  private renderOne(rc: RenderCtx, d: Drawing, isPreview: boolean): void {
    const { ctx, theme, width, height } = rc;
    const color = d.color ?? theme.c1(1);
    const sel = d.id === this.selected;
    const w = sel ? 2 : 1.25;
    const dash = isPreview ? [4, 3] : [];
    const shape: Shape = { id: d.id, segments: [] };
    const p0 = d.points[0], p1 = d.points[1] ?? d.points[0];
    const y0 = rc.y(p0.price), y1 = rc.y(p1.price);
    const x0 = this.xOf(rc, p0.time), x1 = this.xOf(rc, p1.time);
    if (y0 == null) return;
    switch (d.type) {
      case "hline": {
        hline(ctx, 0, width, y0, color, w, dash);
        label(ctx, theme, fmtPrice(p0.price), width - 4, y0, { anchor: "r", bg: color, size: 9, pad: 3, clamp: { width, height } });
        shape.segments.push([0, y0, width, y0]);
        break;
      }
      case "trend": {
        if (x0 == null || x1 == null || y1 == null) return;
        line(ctx, x0, y0, x1, y1, color, w, dash);
        for (const [x, y] of [[x0, y0], [x1, y1]]) { ctx.beginPath(); ctx.arc(x, y, sel ? 4 : 2.5, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); }
        shape.segments.push([x0, y0, x1, y1]);
        break;
      }
      case "rect": {
        if (x0 == null || x1 == null || y1 == null) return;
        const rx = Math.min(x0, x1), ry = Math.min(y0, y1), rw = Math.abs(x1 - x0), rh = Math.abs(y1 - y0);
        ctx.fillStyle = color.replace(/[\d.]+\)$/, "0.12)");
        ctx.fillRect(rx, ry, rw, rh);
        ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = w; ctx.setLineDash(dash); ctx.strokeRect(rx + 0.5, ry + 0.5, rw, rh); ctx.restore();
        label(ctx, theme, `${fmtPrice(Math.max(p0.price, p1.price))} – ${fmtPrice(Math.min(p0.price, p1.price))}`, rx + 3, ry + 3, { anchor: "tl", bg: color, size: 9, pad: 3, clamp: { width, height } });
        shape.rect = [rx, ry, rw, rh];
        break;
      }
      case "fib": {
        if (x0 == null || x1 == null || y1 == null) return;
        const left = Math.min(x0, x1);
        const diff = p1.price - p0.price;
        line(ctx, x0, y0, x1, y1, color.replace(/[\d.]+\)$/, "0.5)"), 1, [3, 3]);
        for (const lv of FIB_LEVELS) {
          const price = p0.price + diff * lv;
          const y = rc.y(price);
          if (y == null) continue;
          const c = lv === 0 || lv === 1 ? color : lv === 0.5 ? theme.c3(0.9) : lv === 0.618 ? theme.c5(0.95) : theme.muted(0.8);
          hline(ctx, left, width, y, c, lv === 0.618 ? 1.5 : 1, dash);
          label(ctx, theme, `${lv.toFixed(3)}  ${fmtPrice(price)}`, width - 4, y, { anchor: "r", bg: c, size: 9, pad: 3, clamp: { width, height } });
          shape.segments.push([left, y, width, y]);
        }
        break;
      }
      default:
        return;
    }
    if (!isPreview) this.shapes.push(shape);
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    let best: Shape | null = null, bestD = 7;
    for (const s of this.shapes) {
      for (const [x1, y1, x2, y2] of s.segments) {
        const d = distToSegment(x, y, x1, y1, x2, y2);
        if (d < bestD) { bestD = d; best = s; }
      }
      if (s.rect) {
        const [rx, ry, rw, rh] = s.rect;
        const edges: [number, number, number, number][] = [[rx, ry, rx + rw, ry], [rx + rw, ry, rx + rw, ry + rh], [rx, ry + rh, rx + rw, ry + rh], [rx, ry, rx, ry + rh]];
        for (const [x1, y1, x2, y2] of edges) { const d = distToSegment(x, y, x1, y1, x2, y2); if (d < bestD) { bestD = d; best = s; } }
      }
    }
    return best ? { externalId: `drawing:${best.id}`, zOrder: "top", cursorStyle: "pointer", distance: bestD, itemType: "primitive" } : null;
  }
}
