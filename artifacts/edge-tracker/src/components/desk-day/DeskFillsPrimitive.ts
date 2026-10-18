/**
 * Series primitive for «Деск на тикере»: every desk trader's legs on one chart. Colour = trader, shape = role:
 *   Вход ▲ solid · Перезаход ▲ with a ring · Переворот ◆ · Добор ● · Частичный фикс △ hollow · Выход ✕ · Стоп ■ (dashed when inferred).
 * Buys hang under the price (pointing up), sells sit above it (pointing down); a short tick marks the exact price.
 * Focused traders are drawn on top at full strength with a dashed path through each trade's legs; the rest are dimmed.
 * Hover shows the leg's lines (built by the React layer, already translated).
 */
import type { PrimitiveHoveredItem } from "lightweight-charts";
import type { TradeRole } from "@/components/chart-engine/types";
import type { ChartTheme } from "@/components/chart-engine/theme";
import { SeriesPrimitiveBase, type RenderCtx, hline, label, line, triangle } from "@/components/chart-engine/primitives/canvas";

export type DeskMarker = {
  key: string;
  trader: string;
  tradeId: number;
  role: TradeRole;
  inferred: boolean;
  buy: boolean;
  price: number;
  /** Logical bar index (fractional allowed). */
  idx: number;
  color: string;
};

type Placed = { m: DeskMarker; x: number; y: number };

/** rgba() with a new alpha from a «#rrggbb» colour. */
export function withAlpha(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const n = Number.parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** One role glyph in colour `col` at bar `x`, price `y`. Exported for the legend key. */
export function drawDeskGlyph(ctx: CanvasRenderingContext2D, theme: ChartTheme, role: TradeRole, x: number, y: number, size: number, buy: boolean, col: string, inferred = false): void {
  const away = (d: number) => (buy ? y + d : y - d);
  ctx.save();
  switch (role) {
    case "stop": {
      const top = buy ? y + 3 : y - 3 - size;
      if (inferred) {
        ctx.setLineDash([2, 2]); ctx.strokeStyle = col; ctx.lineWidth = 1.4;
        ctx.strokeRect(x - size / 2 + 0.5, top + 0.5, size - 1, size - 1);
      } else {
        ctx.fillStyle = col; ctx.fillRect(x - size / 2, top, size, size);
        ctx.strokeStyle = theme.bg(1); ctx.lineWidth = 1; ctx.strokeRect(x - size / 2, top, size, size);
      }
      break;
    }
    case "flip": {
      const cy = away(3 + size / 2), r = size / 2 + 1;
      ctx.beginPath(); ctx.moveTo(x, cy - r); ctx.lineTo(x + r, cy); ctx.lineTo(x, cy + r); ctx.lineTo(x - r, cy); ctx.closePath();
      ctx.fillStyle = col; ctx.fill(); ctx.strokeStyle = theme.bg(1); ctx.lineWidth = 1; ctx.stroke();
      break;
    }
    case "add": {
      const r = Math.max(3, size * 0.38);
      ctx.beginPath(); ctx.arc(x, away(3 + r), r, 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.fill(); ctx.strokeStyle = theme.bg(1); ctx.lineWidth = 1; ctx.stroke();
      break;
    }
    case "exit": {
      const s = size * 0.42, cy = away(3 + s);
      ctx.strokeStyle = theme.bg(1); ctx.lineWidth = 4; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(x - s, cy - s); ctx.lineTo(x + s, cy + s); ctx.moveTo(x + s, cy - s); ctx.lineTo(x - s, cy + s); ctx.stroke();
      ctx.strokeStyle = col; ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.moveTo(x - s, cy - s); ctx.lineTo(x + s, cy + s); ctx.moveTo(x + s, cy - s); ctx.lineTo(x - s, cy + s); ctx.stroke();
      break;
    }
    case "partial_exit": {
      triangle(ctx, x, away(2), size * 0.85, buy ? "up" : "down", withAlphaAny(col, 0.15), col);
      break;
    }
    default: {
      const tipY = away(2);
      triangle(ctx, x, tipY, size, buy ? "up" : "down", col, theme.bg(1));
      if (role === "reentry") {
        ctx.beginPath(); ctx.arc(x, away(2 + size * 0.55), size * 0.85, 0, Math.PI * 2);
        ctx.strokeStyle = col; ctx.lineWidth = 1.2; ctx.stroke();
      }
    }
  }
  ctx.restore();
}

/** Same colour with another alpha for «#hex» or «rgba(…)» inputs. */
function withAlphaAny(col: string, a: number): string {
  if (col.startsWith("#")) return withAlpha(col, a);
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(col);
  return m ? `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${a})` : col;
}

export class DeskFillsPrimitive extends SeriesPrimitiveBase {
  private markers: readonly DeskMarker[] = [];
  private focus = new Set<string>();
  private hovered: string | null = null;
  private placed: Placed[] = [];
  private describe: (m: DeskMarker) => string[] = () => [];

  setMarkers(markers: readonly DeskMarker[], describe: (m: DeskMarker) => string[]): void {
    this.markers = markers; this.describe = describe; this.requestUpdate();
  }
  setFocus(names: Iterable<string>): void { this.focus = new Set(names); this.requestUpdate(); }

  private isFocused(m: DeskMarker): boolean { return this.focus.size === 0 || this.focus.has(m.trader); }

  render(rc: RenderCtx): void {
    const { ctx, theme, width, height } = rc;
    this.placed = [];
    if (!this.markers.length) return;
    const spacing = this.chart?.timeScale().options().barSpacing ?? 6;
    const size = Math.max(8, Math.min(12, spacing * 1.4));
    const dimmed: Placed[] = [], strong: Placed[] = [];
    for (const m of this.markers) {
      const x = rc.x(m.idx), y = rc.y(m.price);
      if (x == null || y == null || x < -20 || x > width + 20) continue;
      const p = { m, x, y };
      this.placed.push(p);
      (this.isFocused(m) ? strong : dimmed).push(p);
    }
    const draw = (p: Placed, alpha: number) => {
      const col = alpha < 1 ? withAlphaAny(p.m.color, alpha) : p.m.color;
      hline(ctx, p.x - spacing * 0.6, p.x + spacing * 0.6, p.y, col, 1.5);
      drawDeskGlyph(ctx, theme, p.m.role, p.x, p.y, size, p.m.buy, col, p.m.inferred);
    };
    for (const p of dimmed) draw(p, 0.35);
    // Path through each focused trade's legs (only when something is focused — the full desk would be noise).
    if (this.focus.size) {
      const byTrade = new Map<number, Placed[]>();
      for (const p of strong) { const l = byTrade.get(p.m.tradeId); if (l) l.push(p); else byTrade.set(p.m.tradeId, [p]); }
      for (const list of byTrade.values()) {
        for (let i = 1; i < list.length; i++) line(ctx, list[i - 1].x, list[i - 1].y, list[i].x, list[i].y, withAlphaAny(list[i].m.color, 0.7), 1.2, [4, 3]);
      }
    }
    for (const p of strong) draw(p, 1);

    const hov = this.hovered ? this.placed.find((p) => p.m.key === this.hovered) : null;
    if (hov) {
      const lines = this.describe(hov.m);
      let y = hov.m.buy ? hov.y + 16 : hov.y - 16;
      const ordered = hov.m.buy ? lines : [...lines].reverse();
      for (let i = 0; i < ordered.length; i++) {
        const first = hov.m.buy ? i === 0 : i === ordered.length - 1;
        const b = label(ctx, theme, ordered[i], hov.x + 10, y, { anchor: hov.m.buy ? "tl" : "bl", clamp: { width, height }, weight: first ? 600 : 500, size: first ? 11 : 10 });
        y = hov.m.buy ? b.y + b.h + 2 : b.y - 2;
      }
    }
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    let best: Placed | null = null, bestD = 11;
    for (const p of this.placed) {
      // Prefer focused markers when they overlap dimmed ones.
      const d = Math.hypot(p.x - x, p.y - y) + (this.isFocused(p.m) ? 0 : 3);
      if (d < bestD) { bestD = d; best = p; }
    }
    const key = best ? best.m.key : null;
    if (key !== this.hovered) { this.hovered = key; this.requestUpdate(); }
    return best ? { externalId: `leg:${best.m.key}`, zOrder: "top", cursorStyle: "pointer", distance: bestD, itemType: "marker" } : null;
  }
}
