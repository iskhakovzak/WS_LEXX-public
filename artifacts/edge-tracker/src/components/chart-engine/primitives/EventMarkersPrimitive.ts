/**
 * Pane primitive: market events of the trade day as vertical dashed lines with a label at the top.
 */
import { PanePrimitiveBase, type RenderCtx, label, vline } from "./canvas";

export type EventMarker = { id: number; idx: number; text: string; color?: string };

export class EventMarkersPrimitive extends PanePrimitiveBase {
  private markers: readonly EventMarker[] = [];
  private visible = true;

  constructor(theme: ConstructorParameters<typeof PanePrimitiveBase>[0]) {
    super(theme, { zOrder: "top", background: false });
  }

  set(markers: readonly EventMarker[]): void { this.markers = markers; this.requestUpdate(); }
  setVisible(on: boolean): void { this.visible = on; this.requestUpdate(); }

  render(rc: RenderCtx): void {
    if (!this.visible || !this.markers.length) return;
    const { ctx, theme, width, height } = rc;
    let row = 0;
    for (const m of this.markers) {
      const x = rc.x(m.idx);
      if (x == null || x < -5 || x > width + 5) continue;
      const color = m.color ?? theme.c5(0.9);
      vline(ctx, x, 0, height, color, 1, [4, 4]);
      const text = m.text.length > 42 ? `${m.text.slice(0, 40)}…` : m.text;
      label(ctx, theme, text, x + 4, 4 + (row % 3) * 18, { anchor: "tl", bg: color, size: 10, clamp: { width, height } });
      row++;
    }
  }
}
