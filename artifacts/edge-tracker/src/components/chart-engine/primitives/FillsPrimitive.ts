/**
 * Series primitive: execution markers at the exact fill price, one per structure leg (pieces of one order merged).
 * Buys point up from under the price, sells point down from above it. Shape / colour by role:
 *   Вход — solid triangle · Перезаход — triangle with a ring · Переворот — diamond · Добор — small triangle + dot ·
 *   Частичный фикс — hollow triangle · Выход — solid triangle (exit colour) · Стоп — square (dashed + «?» when inferred).
 * A short tag («Добор», «Фикс», «Стоп?») sits next to each marker while there is room; hover shows the leg's numbers.
 * Fills past the replay cursor (or explicitly hidden ids) are not drawn.
 */
import type { PrimitiveHoveredItem } from "lightweight-charts";
import { chartI18n } from "@/i18n/ns/chart";
import type { Fill, Side, TradeRole } from "../types";
import type { ChartTheme } from "../theme";
import { fmtEtTime } from "../lib/time";
import { isOpening } from "../lib/position";
import { ROLE_TAG, fillDetails } from "../lib/structure";
import { SeriesPrimitiveBase, type RenderCtx, hline, label, measureLabel, triangle } from "./canvas";

type Placed = { fill: Fill; x: number; y: number };

/** Marker colours by role (also used by the chart's marker key). */
export function roleColor(theme: ChartTheme, role: TradeRole, alpha = 1): string {
  switch (role) {
    case "entry": return theme.primary(alpha);
    case "reentry": return theme.c2(alpha);
    case "flip": return theme.c3(alpha);
    case "add": return theme.c1(alpha);
    case "partial_exit":
    case "exit": return theme.c5(alpha);
    default: return theme.down(alpha);
  }
}

/** Draw one role glyph centred on the price `y` at bar `x` (`buy` = the fill bought). */
export function drawRoleGlyph(ctx: CanvasRenderingContext2D, theme: ChartTheme, role: TradeRole, x: number, y: number, size: number, buy: boolean, inferred = false): void {
  const col = roleColor(theme, role);
  if (role === "stop") {
    ctx.save();
    const top = buy ? y + 3 : y - 3 - size;
    if (inferred) {
      ctx.fillStyle = roleColor(theme, role, 0.18);
      ctx.fillRect(x - size / 2, top, size, size);
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = col; ctx.lineWidth = 1.4;
      ctx.strokeRect(x - size / 2 + 0.5, top + 0.5, size - 1, size - 1);
    } else {
      ctx.fillStyle = col;
      ctx.fillRect(x - size / 2, top, size, size);
    }
    ctx.restore();
    return;
  }
  if (role === "flip") {
    const cy = buy ? y + 3 + size / 2 : y - 3 - size / 2, r = size / 2 + 1;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, cy - r); ctx.lineTo(x + r, cy); ctx.lineTo(x, cy + r); ctx.lineTo(x - r, cy); ctx.closePath();
    ctx.fillStyle = col; ctx.fill();
    ctx.strokeStyle = theme.bg(1); ctx.lineWidth = 1; ctx.stroke();
    ctx.restore();
    return;
  }
  const small = role === "add" || role === "partial_exit";
  const s = small ? size * 0.8 : size;
  const tipY = buy ? y + 2 : y - 2;
  const dir = buy ? "down" : "up";
  if (role === "partial_exit") triangle(ctx, x, tipY, s, dir, roleColor(theme, role, 0.18), col);
  else triangle(ctx, x, tipY, s, dir, col, role === "reentry" ? theme.bg(1) : undefined);
  const farY = buy ? tipY + s * 1.1 : tipY - s * 1.1;
  if (role === "add") {
    ctx.beginPath(); ctx.arc(x, buy ? farY + 4 : farY - 4, 2, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
  }
  if (role === "reentry") {
    ctx.save();
    ctx.beginPath(); ctx.arc(x, (tipY + farY) / 2, s * 0.85, 0, Math.PI * 2);
    ctx.strokeStyle = col; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.restore();
  }
}

export class FillsPrimitive extends SeriesPrimitiveBase {
  private fills: readonly Fill[] = [];
  private side: Side = "long";
  private limit: number | null = null;
  private hidden = new Set<number>();
  private hovered: number | null = null;
  private placed: Placed[] = [];
  private tags = true;

  setFills(fills: readonly Fill[], side: Side): void { this.fills = fills; this.side = side; this.requestUpdate(); }
  /** Hide fills on bars after `idx` (replay cursor). Null = show all. */
  setLimit(idx: number | null): void { if (this.limit !== idx) { this.limit = idx; this.requestUpdate(); } }
  setHidden(ids: Iterable<number>): void { this.hidden = new Set(ids); this.requestUpdate(); }
  /** Role tags next to the markers (on by default). */
  setTags(on: boolean): void { if (this.tags !== on) { this.tags = on; this.requestUpdate(); } }

  private visible(): Fill[] {
    return this.fills.filter((f) => (this.limit == null || f.idx <= this.limit) && !this.hidden.has(f.id));
  }

  render(rc: RenderCtx): void {
    const { ctx, theme, width, height } = rc;
    this.placed = [];
    const vis = this.visible();
    if (!vis.length) return;
    const spacing = this.chart?.timeScale().options().barSpacing ?? 6;
    const size = Math.max(8, Math.min(14, spacing * 1.6));
    const boxes: { x: number; y: number; w: number; h: number }[] = [];
    const overlaps = (b: { x: number; y: number; w: number; h: number }) => boxes.some((o) => b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y);
    for (const f of vis) {
      const x = rc.x(f.idx), y = rc.y(f.price);
      if (x == null || y == null) continue;
      this.placed.push({ fill: f, x, y });
      const buy = (this.side === "long") === isOpening(f.kind);
      const col = roleColor(theme, f.role);
      // price tick across the bar
      hline(ctx, x - spacing * 0.6, x + spacing * 0.6, y, col, 1.5);
      drawRoleGlyph(ctx, theme, f.role, x, y, size, buy, f.inferred);
      if (!this.tags || f.id === this.hovered) continue;
      // Tag beyond the glyph (under a buy, over a sell); skipped when it would cover another tag.
      const text = `${ROLE_TAG[f.role]}${f.inferred ? "?" : ""}${f.pieces > 1 ? ` ×${f.pieces}` : ""}`;
      const m = measureLabel(ctx, theme, text, { size: 9, pad: 3 });
      const off = size * 1.1 + (f.role === "add" ? 10 : 5);
      const box = { x: x - m.w / 2, y: buy ? y + off : y - off - m.h, w: m.w, h: m.h };
      if (box.y < 0 || box.y + box.h > height || overlaps(box)) continue;
      boxes.push(box);
      label(ctx, theme, text, box.x, box.y, { anchor: "tl", size: 9, pad: 3, bg: roleColor(theme, f.role, theme.dark ? 0.32 : 0.16), color: theme.fg(0.95), weight: 600 });
    }
    const hov = this.hovered != null ? this.placed.find((p) => p.fill.id === this.hovered) : null;
    if (hov) {
      const f = hov.fill;
      const lines = fillDetails(f);
      if (f.time != null) lines[0] += ` · ${fmtEtTime(f.time, true)} ET`;
      else if (f.byPrice) lines[0] += ` · ${chartI18n.t("canvas.byPrice")}`;
      const buy = (this.side === "long") === isOpening(f.kind);
      // Stack the lines away from the marker; each line is its own pill so long reasons stay readable.
      let y = buy ? hov.y + 14 : hov.y - 14;
      const ordered = buy ? lines : [...lines].reverse();
      for (let i = 0; i < ordered.length; i++) {
        const first = buy ? i === 0 : i === ordered.length - 1;
        const b = label(ctx, theme, ordered[i], hov.x + 10, y, { anchor: buy ? "tl" : "bl", clamp: { width, height }, weight: first ? 600 : 500, size: first ? 11 : 10 });
        y = buy ? b.y + b.h + 2 : b.y - 2;
      }
    }
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    let best: Placed | null = null, bestD = 10;
    for (const p of this.placed) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD) { bestD = d; best = p; }
    }
    const id = best ? best.fill.id : null;
    if (id !== this.hovered) { this.hovered = id; this.requestUpdate(); }
    return best ? { externalId: `fill:${best.fill.id}`, zOrder: "top", cursorStyle: "pointer", distance: bestD, itemType: "marker" } : null;
  }
}
