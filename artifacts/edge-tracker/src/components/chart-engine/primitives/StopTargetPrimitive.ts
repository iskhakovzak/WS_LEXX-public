/**
 * Series primitive: stop / target lines with R labels (+1R / +2R guides when a stop exists).
 */
import { fmtPrice, fmtR } from "@/lib/format";
import { chartI18n } from "@/i18n/ns/chart";
import { SeriesPrimitiveBase, type RenderCtx, hline, label } from "./canvas";

export type StopTargetData = {
  stop: number | null;
  target: number | null;
  avgEntry: number | null;
  side: "long" | "short";
};

export class StopTargetPrimitive extends SeriesPrimitiveBase {
  private data: StopTargetData | null = null;
  private visible = true;

  set(data: StopTargetData | null): void {
    this.data = data;
    this.syncAxis();
    this.requestUpdate();
  }
  setVisible(on: boolean): void { this.visible = on; this.syncAxis(); this.requestUpdate(); }

  private syncAxis(): void {
    const data = this.visible ? this.data : null;
    const labels: { price: number; text: string; color: string }[] = [];
    if (data?.stop != null) labels.push({ price: data.stop, text: fmtPrice(data.stop), color: this.theme.down(1) });
    if (data?.target != null) labels.push({ price: data.target, text: fmtPrice(data.target), color: this.theme.up(1) });
    this.setAxisLabels(labels);
  }

  render(rc: RenderCtx): void {
    const d = this.data;
    if (!d || !this.visible) return;
    const { ctx, theme, width, height } = rc;
    const dir = d.side === "short" ? -1 : 1;
    const risk = d.stop != null && d.avgEntry != null ? Math.abs(d.avgEntry - d.stop) : null;
    const rOf = (price: number) => (risk && d.avgEntry != null ? (dir * (price - d.avgEntry)) / risk : null);
    if (d.stop != null) {
      const y = rc.y(d.stop);
      if (y != null) {
        hline(ctx, 0, width, y, theme.down(0.9), 1, [6, 4]);
        label(ctx, theme, `${chartI18n.t("canvas.stop", { price: fmtPrice(d.stop) })}${risk ? " · −1R" : ""}`, 6, y + 3, { anchor: "tl", bg: theme.down(0.85), clamp: { width, height }, size: 10 });
      }
    }
    if (d.target != null) {
      const y = rc.y(d.target);
      if (y != null) {
        const r = rOf(d.target);
        hline(ctx, 0, width, y, theme.up(0.9), 1, [6, 4]);
        label(ctx, theme, `${chartI18n.t("canvas.target", { price: fmtPrice(d.target) })}${r != null ? ` · ${fmtR(r)}` : ""}`, 6, y - 3, { anchor: "bl", bg: theme.up(0.85), clamp: { width, height }, size: 10 });
      }
    }
    if (risk && d.avgEntry != null) {
      for (const k of [1, 2, 3]) {
        const p = d.avgEntry + dir * k * risk;
        if (d.target != null && Math.abs(p - d.target) < risk * 0.05) continue;
        const y = rc.y(p);
        if (y == null || y < 0 || y > height) continue;
        hline(ctx, 0, width, y, theme.up(0.35), 1, [1, 4]);
        label(ctx, theme, `+${k}R ${fmtPrice(p)}`, width - 6, y, { anchor: "r", bg: theme.up(0.5), size: 9, pad: 3 });
      }
    }
  }
}
