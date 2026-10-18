/**
 * Series primitive: a VWAP polyline with optional ±1σ / ±2σ bands (filled), drawn for the visible
 * range only. Also used for the anchored VWAP (no bands). Honours the replay cursor.
 */
import { SeriesPrimitiveBase, type RenderCtx, clipRange, label } from "./canvas";

export type VwapDrawPoint = { idx: number; vwap: number; sd: number };

export type VwapBandsOptions = {
  color: (a?: number) => string;
  bands: readonly number[];
  title: string;
  lineWidth?: number;
  dash?: number[];
};

export class VwapBandsPrimitive extends SeriesPrimitiveBase {
  private points: readonly VwapDrawPoint[] = [];
  private byIdx = new Map<number, VwapDrawPoint>();
  private limit: number | null = null;
  private visible = true;
  private options: VwapBandsOptions;

  constructor(theme: ConstructorParameters<typeof SeriesPrimitiveBase>[0], options: VwapBandsOptions) {
    super(theme, { zOrder: "normal" });
    this.options = options;
  }

  setOptions(o: Partial<VwapBandsOptions>): void { this.options = { ...this.options, ...o }; this.requestUpdate(); }
  set(points: readonly VwapDrawPoint[]): void {
    this.points = points;
    this.byIdx = new Map(points.map((p) => [p.idx, p]));
    this.requestUpdate();
  }
  setLimit(idx: number | null): void { if (this.limit !== idx) { this.limit = idx; this.requestUpdate(); } }
  setVisible(on: boolean): void { this.visible = on; this.requestUpdate(); }

  /** Value at a bar (for the legend). */
  at(idx: number): VwapDrawPoint | null { return this.byIdx.get(idx) ?? null; }

  render(rc: RenderCtx): void {
    if (!this.visible || !this.points.length) return;
    const { ctx, theme, width, height } = rc;
    const pts = this.points;
    const last = this.limit == null ? pts.length - 1 : upperBound(pts, this.limit);
    if (last < 0) return;
    const clip = clipRange(rc.range, pts[0].idx, pts[last].idx);
    if (!clip) return;
    const from = lowerBound(pts, clip.from), to = Math.min(last, upperBound(pts, clip.to));
    if (from > to) return;
    const o = this.options;
    const xy: { x: number; y: number; p: VwapDrawPoint }[] = [];
    for (let i = from; i <= to; i++) {
      const p = pts[i];
      const x = rc.x(p.idx), y = rc.y(p.vwap);
      if (x == null || y == null) continue;
      xy.push({ x, y, p });
    }
    if (xy.length < 2) return;
    // Bands (outer first so the inner band sits on top).
    for (const k of [...o.bands].sort((a, b) => b - a)) {
      const upper: { x: number; y: number }[] = [], lower: { x: number; y: number }[] = [];
      for (const q of xy) {
        const yu = rc.y(q.p.vwap + k * q.p.sd), yl = rc.y(q.p.vwap - k * q.p.sd);
        if (yu == null || yl == null) continue;
        upper.push({ x: q.x, y: yu }); lower.push({ x: q.x, y: yl });
      }
      if (upper.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(upper[0].x, upper[0].y);
      for (const u of upper) ctx.lineTo(u.x, u.y);
      for (let i = lower.length - 1; i >= 0; i--) ctx.lineTo(lower[i].x, lower[i].y);
      ctx.closePath();
      ctx.fillStyle = o.color(k === 1 ? 0.09 : 0.05);
      ctx.fill();
      ctx.strokeStyle = o.color(0.35);
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath(); for (let i = 0; i < upper.length; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, upper[i].x, upper[i].y); ctx.stroke();
      ctx.beginPath(); for (let i = 0; i < lower.length; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, lower[i].x, lower[i].y); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = o.color(0.95);
    ctx.lineWidth = o.lineWidth ?? 1.5;
    ctx.setLineDash(o.dash ?? []);
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(xy[0].x, xy[0].y);
    for (let i = 1; i < xy.length; i++) ctx.lineTo(xy[i].x, xy[i].y);
    ctx.stroke();
    ctx.setLineDash([]);
    const end = xy[xy.length - 1];
    label(ctx, theme, o.title, Math.min(end.x + 4, width - 4), end.y, { anchor: end.x > width - 60 ? "r" : "l", bg: o.color(0.85), size: 9, pad: 3, clamp: { width, height } });
  }
}

/** First index with idx >= v. */
function lowerBound(pts: readonly VwapDrawPoint[], v: number): number {
  let lo = 0, hi = pts.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (pts[m].idx < v) lo = m + 1; else hi = m; }
  return lo;
}
/** Last index with idx <= v (−1 when none). */
function upperBound(pts: readonly VwapDrawPoint[], v: number): number {
  let lo = 0, hi = pts.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (pts[m].idx <= v) lo = m + 1; else hi = m; }
  return lo - 1;
}
