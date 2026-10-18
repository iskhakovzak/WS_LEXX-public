/**
 * Layout and hit-testing (pure): where each pane sits, which candle is under a pixel, navigator handles.
 *
 *   ┌──────────────────────────────────────┬──────┐
 *   │ main pane (equity: candles / area)   │ axis │
 *   ├──────────────────────────────────────┤      │
 *   │ P&L per candle (optional)            │      │
 *   ├──────────────────────────────────────┤      │
 *   │ underwater drawdown (optional)       │      │
 *   ├──────────────────────────────────────┴──────┤
 *   │ time axis                                   │
 *   ├─────────────────────────────────────────────┤
 *   │ navigator: whole curve + draggable window   │
 *   └─────────────────────────────────────────────┘
 */
import { clampView, fullView, minSpanFor, type View } from "./viewport";

export interface Rect { x: number; y: number; w: number; h: number }

export interface Layout {
  width: number;
  height: number;
  /** Plot area shared by all panes horizontally. */
  plotX: number;
  plotW: number;
  axisX: number;
  axisW: number;
  main: Rect;
  pnl: Rect | null;
  dd: Rect | null;
  /** Time axis labels band (under the last pane). */
  time: Rect;
  nav: Rect | null;
}

export interface LayoutOpts { pnl: boolean; dd: boolean; nav: boolean; axisW: number }

export const TIME_H = 22;
export const NAV_H = 40;
const TOP = 10;
const GAP = 8;
const NAV_GAP = 6;

export function computeLayout(width: number, height: number, o: LayoutOpts): Layout {
  const axisW = Math.max(40, Math.min(96, Math.round(o.axisW)));
  const plotX = 0;
  const plotW = Math.max(10, width - axisW - plotX);
  const navH = o.nav ? NAV_H : 0;
  const avail = Math.max(60, height - TOP - TIME_H - (o.nav ? navH + NAV_GAP : 0));
  const extras = (o.pnl ? 1 : 0) + (o.dd ? 1 : 0);
  const gaps = extras * GAP;
  const pane = (share: number, min: number) => Math.max(min, Math.round((avail - gaps) * share));
  const pnlH = o.pnl ? pane(extras === 2 ? 0.16 : 0.2, 36) : 0;
  const ddH = o.dd ? pane(extras === 2 ? 0.18 : 0.22, 40) : 0;
  const mainH = Math.max(60, avail - gaps - pnlH - ddH);
  let y = TOP;
  const main = { x: plotX, y, w: plotW, h: mainH };
  y += mainH;
  let pnl: Rect | null = null, dd: Rect | null = null;
  if (o.pnl) { y += GAP; pnl = { x: plotX, y, w: plotW, h: pnlH }; y += pnlH; }
  if (o.dd) { y += GAP; dd = { x: plotX, y, w: plotW, h: ddH }; y += ddH; }
  const time = { x: plotX, y, w: plotW, h: TIME_H };
  y += TIME_H;
  const nav = o.nav ? { x: plotX, y: y + NAV_GAP, w: width - plotX, h: navH } : null;
  return { width, height, plotX, plotW, axisX: plotX + plotW, axisW, main, pnl, dd, time, nav };
}

/** Slot coordinate under pixel x for a view. */
export function slotAt(x: number, plotX: number, plotW: number, v: View): number {
  return v.from + ((x - plotX) / plotW) * (v.to - v.from);
}

/** Pixel x of a slot coordinate. */
export function xOf(slot: number, plotX: number, plotW: number, v: View): number {
  return plotX + ((slot - v.from) / (v.to - v.from)) * plotW;
}

/** Candle under pixel x (snapped to the nearest existing one); −1 when there is no data. */
export function indexAt(x: number, plotX: number, plotW: number, v: View, n: number): number {
  if (n <= 0) return -1;
  return Math.max(0, Math.min(n - 1, Math.floor(slotAt(x, plotX, plotW, v))));
}

export type Region = "plot" | "nav" | "axis" | "time" | null;

export function regionAt(x: number, y: number, l: Layout): Region {
  if (l.nav && y >= l.nav.y && y <= l.nav.y + l.nav.h) return "nav";
  const bottom = (l.dd ?? l.pnl ?? l.main);
  if (y >= l.main.y && y <= bottom.y + bottom.h) return x <= l.axisX ? "plot" : "axis";
  if (y >= l.time.y && y <= l.time.y + l.time.h) return "time";
  return null;
}

// ─── Navigator ───

export type NavPart = "left" | "right" | "window" | "track";

/** Navigator spans the full (padded) data range; returns the window's pixel edges. */
export function navWindow(nav: Rect, v: View, n: number): { x0: number; x1: number } {
  const full = fullView(n);
  const span = full.to - full.from;
  const x0 = nav.x + ((v.from - full.from) / span) * nav.w;
  const x1 = nav.x + ((v.to - full.from) / span) * nav.w;
  return { x0, x1 };
}

/** Navigator slot coordinate under x (full range). */
export function navSlotAt(x: number, nav: Rect, n: number): number {
  const full = fullView(n);
  return full.from + ((x - nav.x) / nav.w) * (full.to - full.from);
}

const HANDLE = 8;

export function navHit(x: number, nav: Rect, v: View, n: number): NavPart {
  const { x0, x1 } = navWindow(nav, v, n);
  // Handles win over the body; a tiny window keeps a grabbable body in the middle.
  const grab = Math.min(HANDLE, Math.max(3, (x1 - x0) / 3));
  if (Math.abs(x - x0) <= grab) return "left";
  if (Math.abs(x - x1) <= grab) return "right";
  if (x > x0 && x < x1) return "window";
  return "track";
}

/** Applies a navigator drag of `dSlots` (full-range slots) to the view captured at drag start. */
export function navDrag(part: NavPart, start: View, dSlots: number, n: number): View {
  const minSpan = minSpanFor(n);
  const full = fullView(n);
  // A handle moves one edge only: clamp it to the data range first so the other edge never shifts.
  if (part === "left") return clampView({ from: Math.max(full.from, Math.min(start.from + dSlots, start.to - minSpan)), to: start.to }, n);
  if (part === "right") return clampView({ from: start.from, to: Math.min(full.to, Math.max(start.to + dSlots, start.from + minSpan)) }, n);
  return clampView({ from: start.from + dSlots, to: start.to + dSlots }, n);
}

/** Click on the navigator track: centre the current window on that point. */
export function navCenter(v: View, slot: number, n: number): View {
  const span = v.to - v.from;
  return clampView({ from: slot - span / 2, to: slot + span / 2 }, n);
}
