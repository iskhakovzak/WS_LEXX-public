/**
 * Pane primitive: premarket / after-hours background bands + 9:30 / 16:00 boundary lines.
 * Attached to the price pane (and optionally the volume pane) — it only needs the time scale.
 */
import type { Candle, Session } from "../types";
import { sessionOf } from "../lib/time";
import { PanePrimitiveBase, type RenderCtx, vline } from "./canvas";

type Segment = { from: number; to: number; session: Session };

export class SessionShadingPrimitive extends PanePrimitiveBase {
  private segments: Segment[] = [];
  private enabled = true;

  setBars(bars: readonly Candle[], intraday: boolean): void {
    const segs: Segment[] = [];
    if (intraday) {
      let cur: Segment | null = null;
      for (let i = 0; i < bars.length; i++) {
        const s = sessionOf(bars[i].t);
        if (cur && cur.session === s) cur.to = i;
        else { cur = { from: i, to: i, session: s }; segs.push(cur); }
      }
    }
    this.segments = segs;
    this.requestUpdate();
  }

  setEnabled(on: boolean): void { this.enabled = on; this.requestUpdate(); }

  render(rc: RenderCtx): void {
    if (!this.enabled || !this.segments.length) return;
    const { ctx, height, theme, range } = rc;
    const lo = range ? Math.floor(range.from) - 1 : -Infinity;
    const hi = range ? Math.ceil(range.to) + 1 : Infinity;
    for (const s of this.segments) {
      if (s.to < lo || s.from > hi) continue;
      const x1 = rc.x(s.from - 0.5), x2 = rc.x(s.to + 0.5);
      if (x1 == null || x2 == null) continue;
      if (s.session === "rth") {
        // Boundary hairlines at the open / close of regular hours.
        vline(ctx, x1, 0, height, theme.muted(0.35), 1, [2, 3]);
        vline(ctx, x2, 0, height, theme.muted(0.35), 1, [2, 3]);
        continue;
      }
      const color = s.session === "pre" ? theme.c1(theme.dark ? 0.06 : 0.08) : s.session === "post" ? theme.c3(theme.dark ? 0.06 : 0.08) : theme.muted(0.05);
      ctx.fillStyle = color;
      ctx.fillRect(x1, 0, x2 - x1, height);
    }
  }
}
