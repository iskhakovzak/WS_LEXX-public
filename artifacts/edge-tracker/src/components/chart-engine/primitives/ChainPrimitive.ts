/**
 * Series primitive: the session's re-entry chain on one ticker. Legs of the OTHER trades are drawn as faded
 * markers (same shapes as the trade's own fills), and a dashed connector runs from each trade's last leg to the
 * next trade's first leg, titled «Перезаход №2» / «Переворот». Hover a ghost marker for its role and trade id.
 */
import type { PrimitiveHoveredItem } from "lightweight-charts";
import { chartI18n } from "@/i18n/ns/chart";
import type { ChainLink, ChainMark } from "../lib/geometry";
import type { Side } from "../types";
import { drawRoleGlyph, roleColor } from "./FillsPrimitive";
import { SeriesPrimitiveBase, type RenderCtx, label, line } from "./canvas";

type Placed = { mark: ChainMark; x: number; y: number };

export class ChainPrimitive extends SeriesPrimitiveBase {
  private marks: readonly ChainMark[] = [];
  private links: readonly ChainLink[] = [];
  private sides = new Map<number, Side>();
  private visible = true;
  private limit: number | null = null;
  private placed: Placed[] = [];
  private hovered: Placed | null = null;

  set(chain: { marks: readonly ChainMark[]; links: readonly ChainLink[] }, sides: ReadonlyMap<number, Side>): void {
    this.marks = chain.marks; this.links = chain.links; this.sides = new Map(sides); this.requestUpdate();
  }
  setVisible(on: boolean): void { this.visible = on; this.requestUpdate(); }
  /** Replay: hide what comes after the cursor. */
  setLimit(idx: number | null): void { if (this.limit !== idx) { this.limit = idx; this.requestUpdate(); } }

  render(rc: RenderCtx): void {
    this.placed = [];
    if (!this.visible || (!this.marks.length && !this.links.length)) return;
    const { ctx, theme, width, height } = rc;
    const spacing = this.chart?.timeScale().options().barSpacing ?? 6;
    const size = Math.max(7, Math.min(11, spacing * 1.3));
    const lim = this.limit;
    ctx.save();
    ctx.globalAlpha = 0.45;
    for (const m of this.marks) {
      if (lim != null && m.idx > lim) continue;
      const x = rc.x(m.idx), y = rc.y(m.price);
      if (x == null || y == null) continue;
      const side = this.sides.get(m.tradeId) ?? "long";
      drawRoleGlyph(ctx, theme, m.role, x, y, size, (side === "long") === m.opening);
      this.placed.push({ mark: m, x, y });
    }
    ctx.restore();
    for (const l of this.links) {
      if (lim != null && l.toIdx > lim) continue;
      const x1 = rc.x(l.fromIdx), y1 = rc.y(l.fromPrice), x2 = rc.x(l.toIdx), y2 = rc.y(l.toPrice);
      if (x1 == null || y1 == null || x2 == null || y2 == null) continue;
      const col = roleColor(theme, l.flip ? "flip" : "reentry", l.toCurrent || l.fromCurrent ? 0.85 : 0.45);
      line(ctx, x1, y1, x2, y2, col, 1.2, [4, 3]);
      if (l.toCurrent || l.fromCurrent) {
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        label(ctx, theme, l.toCurrent ? l.title : chartI18n.t("structure.next", { title: l.title.toLowerCase() }), mx, my - 4, { anchor: "bl", size: 9, pad: 3, bg: theme.bg(0.85), color: col, weight: 600, clamp: { width, height } });
      }
    }
    if (this.hovered) {
      const h = this.hovered;
      label(ctx, theme, h.mark.label, h.x + 10, h.y - 12, { anchor: "bl", clamp: { width, height }, weight: 500 });
    }
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    let best: Placed | null = null, bestD = 9;
    for (const p of this.placed) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (best !== this.hovered) { this.hovered = best; this.requestUpdate(); }
    return best ? { externalId: `chain:${best.mark.tradeId}:${best.mark.idx}`, zOrder: "top", cursorStyle: "default", distance: bestD, itemType: "marker" } : null;
  }
}
