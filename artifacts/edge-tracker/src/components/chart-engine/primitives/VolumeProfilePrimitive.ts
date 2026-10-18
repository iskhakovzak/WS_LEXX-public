/**
 * Series primitive: session volume profile (VPVR) on the right edge of the price pane with
 * POC / VAH / VAL. Drawn below the candles.
 */
import type { VolumeProfile } from "../types";
import { fmtPrice } from "@/lib/format";
import { SeriesPrimitiveBase, type RenderCtx, hline, label } from "./canvas";

export class VolumeProfilePrimitive extends SeriesPrimitiveBase {
  private profile: VolumeProfile | null = null;
  private visible = true;
  private widthShare = 0.22;

  constructor(theme: ConstructorParameters<typeof SeriesPrimitiveBase>[0]) {
    super(theme, { zOrder: "bottom" });
  }

  set(profile: VolumeProfile | null): void {
    this.profile = profile;
    this.syncAxis();
    this.requestUpdate();
  }
  setVisible(on: boolean): void { this.visible = on; this.syncAxis(); this.requestUpdate(); }

  /** The POC price-axis label exists only while the profile is shown (otherwise it is a stray label on the axis). */
  private syncAxis(): void {
    const p = this.profile;
    this.setAxisLabels(this.visible && p?.poc != null ? [{ price: p.poc, text: `POC ${fmtPrice(p.poc)}`, color: this.theme.c3(1) }] : []);
  }

  render(rc: RenderCtx): void {
    const p = this.profile;
    if (!p || !this.visible || !p.rows.length || p.maxVol <= 0) return;
    const { ctx, theme, width, height } = rc;
    const maxW = width * this.widthShare;
    const inVa = (price: number) => p.val != null && p.vah != null && price >= p.val && price <= p.vah;
    for (const row of p.rows) {
      if (row.vol <= 0) continue;
      const yTop = rc.y(row.price + p.binSize / 2), yBot = rc.y(row.price - p.binSize / 2);
      if (yTop == null || yBot == null) continue;
      const h = Math.max(1, Math.abs(yBot - yTop) - 1);
      const w = (row.vol / p.maxVol) * maxW;
      const isPoc = p.poc != null && Math.abs(row.price - p.poc) < p.binSize / 2;
      ctx.fillStyle = isPoc ? theme.c3(0.55) : inVa(row.price) ? theme.c1(0.28) : theme.muted(0.18);
      ctx.fillRect(width - w, Math.min(yTop, yBot), w, h);
    }
    const x0 = width - maxW;
    if (p.poc != null) {
      const y = rc.y(p.poc);
      if (y != null) { hline(ctx, x0, width, y, theme.c3(0.9), 1); label(ctx, theme, "POC", x0 - 2, y, { anchor: "r", bg: theme.c3(0.85), size: 9, pad: 3, clamp: { width, height } }); }
    }
    for (const [v, t] of [[p.vah, "VAH"], [p.val, "VAL"]] as const) {
      if (v == null) continue;
      const y = rc.y(v);
      if (y == null) continue;
      hline(ctx, x0, width, y, theme.c1(0.7), 1, [3, 3]);
      label(ctx, theme, `${t} ${fmtPrice(v)}`, x0 - 2, y, { anchor: "r", bg: theme.c1(0.7), size: 9, pad: 3, clamp: { width, height } });
    }
  }
}
