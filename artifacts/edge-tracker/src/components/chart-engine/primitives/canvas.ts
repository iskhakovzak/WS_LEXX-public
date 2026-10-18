/**
 * Shared plumbing for WS Chart primitives (lightweight-charts v5 plugin API).
 *
 * `SeriesPrimitiveBase` / `PanePrimitiveBase` wire `attached/detached`, keep the chart + series
 * references and expose `requestUpdate()`. Subclasses implement `render(ctx)` and draw in media
 * (CSS pixel) coordinates: the context is scaled by the device pixel ratio for crisp output.
 */
import type {
  IChartApiBase, ISeriesApi, ISeriesPrimitive, IPanePrimitive, IPrimitivePaneView, IPanePrimitivePaneView, IPrimitivePaneRenderer,
  ISeriesPrimitiveAxisView, PaneAttachedParameter, PrimitiveHoveredItem, PrimitivePaneViewZOrder, SeriesAttachedParameter, SeriesType, Time,
  Logical, UTCTimestamp,
} from "lightweight-charts";
import type { ChartTheme } from "../theme";

export type RenderTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];
type BitmapScope = Parameters<Parameters<RenderTarget["useBitmapCoordinateSpace"]>[0]>[0];

/** What a renderer gets: a DPR-scaled 2D context plus coordinate helpers in CSS pixels. */
export type RenderCtx = {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  /** Price → y (CSS px) on the attached series' scale; null for pane primitives without a series. */
  y: (price: number) => number | null;
  /** Logical bar index → x (CSS px). */
  x: (logical: number) => number | null;
  /** Visible logical range (fractional) or null. */
  range: { from: number; to: number } | null;
  theme: ChartTheme;
};

export function runRender(target: RenderTarget, build: (scope: BitmapScope) => RenderCtx | null, render: (rc: RenderCtx) => void): void {
  target.useBitmapCoordinateSpace((scope) => {
    const rc = build(scope);
    if (!rc) return;
    const { context } = scope;
    context.save();
    context.scale(scope.horizontalPixelRatio, scope.verticalPixelRatio);
    try { render(rc); } finally { context.restore(); }
  });
}

type View = IPrimitivePaneView & IPanePrimitivePaneView;

function makeView(owner: { render: (rc: RenderCtx) => void; buildCtx: (scope: BitmapScope) => RenderCtx | null; zOrder: PrimitivePaneViewZOrder; background: boolean }): View {
  const renderer: IPrimitivePaneRenderer = owner.background
    ? { draw: () => { /* background primitives draw in drawBackground */ }, drawBackground: (t) => runRender(t, owner.buildCtx, owner.render) }
    : { draw: (t) => runRender(t, owner.buildCtx, owner.render) };
  return { zOrder: () => owner.zOrder, renderer: () => renderer };
}

export abstract class SeriesPrimitiveBase implements ISeriesPrimitive<Time> {
  protected chart: IChartApiBase<Time> | null = null;
  protected series: ISeriesApi<SeriesType, Time> | null = null;
  protected theme: ChartTheme;
  private _requestUpdate: (() => void) | null = null;
  private readonly _views: readonly View[];
  private readonly _axisViews: ISeriesPrimitiveAxisView[] = [];

  constructor(theme: ChartTheme, opts: { zOrder?: PrimitivePaneViewZOrder; background?: boolean } = {}) {
    this.theme = theme;
    this._views = [makeView({ render: (rc) => this.render(rc), buildCtx: (s) => this.buildCtx(s), zOrder: opts.zOrder ?? "normal", background: !!opts.background })];
  }

  attached(p: SeriesAttachedParameter<Time, SeriesType>): void {
    this.chart = p.chart; this.series = p.series; this._requestUpdate = p.requestUpdate;
  }
  detached(): void { this.chart = null; this.series = null; this._requestUpdate = null; }
  paneViews(): readonly IPrimitivePaneView[] { return this._views; }
  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] { return this._axisViews; }
  requestUpdate(): void { this._requestUpdate?.(); }
  setTheme(theme: ChartTheme): void { this.theme = theme; this.requestUpdate(); }

  /** Replace the price-axis labels (price, text, colour). */
  protected setAxisLabels(labels: { price: number; text: string; color: string; textColor?: string }[]): void {
    this._axisViews.length = 0;
    for (const l of labels) {
      this._axisViews.push({
        coordinate: () => { const y = this.series?.priceToCoordinate(l.price); return y == null ? -10000 : y; },
        text: () => l.text,
        textColor: () => l.textColor ?? "#fff",
        backColor: () => l.color,
        visible: () => this.series?.priceToCoordinate(l.price) != null,
        tickVisible: () => true,
      });
    }
  }

  protected buildCtx(scope: BitmapScope): RenderCtx | null {
    const chart = this.chart, series = this.series;
    if (!chart || !series) return null;
    const ts = chart.timeScale();
    return {
      ctx: scope.context,
      width: scope.mediaSize.width,
      height: scope.mediaSize.height,
      y: (price) => { const v = series.priceToCoordinate(price); return v == null ? null : Number(v); },
      x: (logical) => { const v = ts.logicalToCoordinate(logical as Logical); return v == null ? null : Number(v); },
      range: ts.getVisibleLogicalRange(),
      theme: this.theme,
    };
  }

  /** Helper for subclasses: price → y with the current series. */
  protected priceY(price: number): number | null {
    const v = this.series?.priceToCoordinate(price);
    return v == null ? null : Number(v);
  }
  protected logicalX(logical: number): number | null {
    const v = this.chart?.timeScale().logicalToCoordinate(logical as Logical);
    return v == null ? null : Number(v);
  }

  abstract render(rc: RenderCtx): void;
  hitTest?(x: number, y: number): PrimitiveHoveredItem | null;
}

export abstract class PanePrimitiveBase implements IPanePrimitive<Time> {
  protected chart: IChartApiBase<Time> | null = null;
  protected theme: ChartTheme;
  private _requestUpdate: (() => void) | null = null;
  private readonly _views: readonly View[];

  constructor(theme: ChartTheme, opts: { zOrder?: PrimitivePaneViewZOrder; background?: boolean } = {}) {
    this.theme = theme;
    this._views = [makeView({ render: (rc) => this.render(rc), buildCtx: (s) => this.buildCtx(s), zOrder: opts.zOrder ?? "bottom", background: opts.background !== false })];
  }
  attached(p: PaneAttachedParameter<Time>): void { this.chart = p.chart; this._requestUpdate = p.requestUpdate; }
  detached(): void { this.chart = null; this._requestUpdate = null; }
  paneViews(): readonly IPanePrimitivePaneView[] { return this._views; }
  requestUpdate(): void { this._requestUpdate?.(); }
  setTheme(theme: ChartTheme): void { this.theme = theme; this.requestUpdate(); }

  protected buildCtx(scope: BitmapScope): RenderCtx | null {
    const chart = this.chart;
    if (!chart) return null;
    const ts = chart.timeScale();
    return {
      ctx: scope.context,
      width: scope.mediaSize.width,
      height: scope.mediaSize.height,
      y: () => null,
      x: (logical) => { const v = ts.logicalToCoordinate(logical as Logical); return v == null ? null : Number(v); },
      range: ts.getVisibleLogicalRange(),
      theme: this.theme,
    };
  }
  abstract render(rc: RenderCtx): void;
}

// ── Drawing helpers (CSS px space) ─────────────────────────────────────────
export const FONT_SIZE = 11;

export function font(theme: ChartTheme, size = FONT_SIZE, weight: 400 | 500 | 600 = 500): string {
  return `${weight} ${size}px ${theme.font}`;
}

export function crisp(v: number): number {
  return Math.round(v) + 0.5;
}

export function hline(ctx: CanvasRenderingContext2D, x1: number, x2: number, y: number, color: string, width = 1, dash: number[] = []): void {
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash);
  ctx.beginPath(); ctx.moveTo(x1, crisp(y)); ctx.lineTo(x2, crisp(y)); ctx.stroke();
  ctx.restore();
}

export function vline(ctx: CanvasRenderingContext2D, x: number, y1: number, y2: number, color: string, width = 1, dash: number[] = []): void {
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash);
  ctx.beginPath(); ctx.moveTo(crisp(x), y1); ctx.lineTo(crisp(x), y2); ctx.stroke();
  ctx.restore();
}

export function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string, width = 1, dash: number[] = []): void {
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash);
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  ctx.restore();
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export type LabelOpts = {
  /** Anchor: which corner of the box sits at (x, y). */
  anchor?: "tl" | "tr" | "bl" | "br" | "l" | "r" | "c";
  bg?: string;
  color?: string;
  size?: number;
  weight?: 400 | 500 | 600;
  pad?: number;
  /** Keep the box inside [0, width] × [0, height]. */
  clamp?: { width: number; height: number };
};

/** Pill label with a background. Returns the box drawn. */
export function label(ctx: CanvasRenderingContext2D, theme: ChartTheme, text: string, x: number, y: number, opts: LabelOpts = {}): { x: number; y: number; w: number; h: number } {
  const size = opts.size ?? FONT_SIZE;
  const pad = opts.pad ?? 4;
  ctx.save();
  ctx.font = font(theme, size, opts.weight ?? 500);
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  const h = size + pad * 2 - 1;
  let bx = x, by = y;
  const a = opts.anchor ?? "tl";
  if (a === "tr" || a === "br" || a === "r") bx = x - w;
  if (a === "bl" || a === "br") by = y - h;
  if (a === "l" || a === "r") by = y - h / 2;
  if (a === "c") { bx = x - w / 2; by = y - h / 2; }
  if (opts.clamp) {
    bx = Math.max(2, Math.min(opts.clamp.width - w - 2, bx));
    by = Math.max(2, Math.min(opts.clamp.height - h - 2, by));
  }
  ctx.fillStyle = opts.bg ?? theme.labelBg;
  roundRect(ctx, bx, by, w, h, 4);
  ctx.fill();
  ctx.fillStyle = opts.color ?? "#fff";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(text, bx + pad, by + h / 2 + 0.5);
  ctx.restore();
  return { x: bx, y: by, w, h };
}

/** Size of the box `label()` would draw, without drawing it. */
export function measureLabel(ctx: CanvasRenderingContext2D, theme: ChartTheme, text: string, opts: LabelOpts = {}): { w: number; h: number } {
  const size = opts.size ?? FONT_SIZE;
  const pad = opts.pad ?? 4;
  ctx.save();
  ctx.font = font(theme, size, opts.weight ?? 500);
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  ctx.restore();
  return { w, h: size + pad * 2 - 1 };
}

/**
 * Collision avoidance for vertically stacked labels: given desired box tops and heights, returns new
 * tops (same order as input) so that boxes keep their vertical order, are at least `gap` apart and
 * stay inside [2, bound − 2]. O(n log n); n is tiny here.
 */
export function layoutLabels(items: readonly { y: number; h: number }[], bound: number, gap = 2): number[] {
  const order = items.map((_, i) => i).sort((a, b) => items[a].y - items[b].y);
  const ys = items.map((it) => it.y);
  for (let k = 1; k < order.length; k++) { const i = order[k], p = order[k - 1]; ys[i] = Math.max(ys[i], ys[p] + items[p].h + gap); }
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k];
    const maxY = k === order.length - 1 ? bound - items[i].h - 2 : ys[order[k + 1]] - items[i].h - gap;
    ys[i] = Math.min(ys[i], maxY);
  }
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    const minY = k === 0 ? 2 : ys[order[k - 1]] + items[order[k - 1]].h + gap;
    ys[i] = Math.max(ys[i], minY);
  }
  return ys;
}

/** Thin vertical leader from an anchor y (the price line) to a displaced label box; no-op when not displaced. */
export function leader(ctx: CanvasRenderingContext2D, x: number, yFrom: number, box: { y: number; h: number }, color: string): void {
  const yTo = yFrom < box.y ? box.y : yFrom > box.y + box.h ? box.y + box.h : null;
  if (yTo == null || Math.abs(yTo - yFrom) < 1.5) return;
  line(ctx, x, yFrom, x, yTo, color, 1);
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(crisp(x), yFrom, 1.6, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

/** Triangle pointing up (tip at y) or down. */
export function triangle(ctx: CanvasRenderingContext2D, x: number, tipY: number, size: number, dir: "up" | "down", fill: string, stroke?: string): void {
  const h = size * 1.1;
  const sgn = dir === "up" ? 1 : -1;
  ctx.beginPath();
  ctx.moveTo(x, tipY);
  ctx.lineTo(x - size / 2, tipY + sgn * h);
  ctx.lineTo(x + size / 2, tipY + sgn * h);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.2; ctx.stroke(); }
}

export function asTime(t: number): UTCTimestamp {
  return t as UTCTimestamp;
}

/** Clip a logical interval to the visible range (with 1 bar of slack); null when fully outside. */
export function clipRange(range: { from: number; to: number } | null, from: number, to: number): { from: number; to: number } | null {
  if (!range) return { from, to };
  const a = Math.max(from, Math.floor(range.from) - 1);
  const b = Math.min(to, Math.ceil(range.to) + 1);
  return a <= b ? { from: a, to: b } : null;
}
