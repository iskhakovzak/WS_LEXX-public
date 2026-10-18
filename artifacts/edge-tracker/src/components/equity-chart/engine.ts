/**
 * EquityEngine — the imperative core: two stacked HiDPI canvases (static base + overlay for the crosshair),
 * a requestAnimationFrame loop that only runs while something changes, tweened viewport / autoscale /
 * view-mode, and pointer input (drag-pan, ctrl/⌘ + wheel or trackpad pinch zoom around the cursor,
 * horizontal trackpad scroll, navigator window drag / resize, click, double-click reset).
 *
 * React owns the controls, tooltip and keyboard; it talks to the engine through a few setters and gets
 * hover / activate / view callbacks back (see EquityChart.tsx).
 */
import type { ChartTheme } from "@/components/chart-engine/theme";
import type { EquityCandle, EquityUnit } from "@/components/equity-candles/lib";
import type { EquityAgg, EquityDerived } from "./model";
import { axisLabel, yDomain, type Domain } from "./scale";
import { computeLayout, indexAt, navCenter, navDrag, navHit, navSlotAt, regionAt, slotAt, xOf, type Layout, type NavPart } from "./geometry";
import { drawBase, drawOverlay, type Frame, type Pointer } from "./render";
import { clampView, easeOutCubic, fullView, lerpView, pan, sameView, visibleRange, zoomAt, type View } from "./viewport";

export type ViewMode = "candles" | "line";

export interface EngineOptions {
  mode: ViewMode;
  pnl: boolean;
  dd: boolean;
  nav: boolean;
  marks: boolean;
}

export interface HoverInfo {
  index: number;
  /** Candle centre / close point in CSS px relative to the container. */
  x: number;
  y: number;
  width: number;
  plotTop: number;
  plotBottom: number;
  selected: boolean;
}

export interface EngineCallbacks {
  onHover: (h: HoverInfo | null) => void;
  /** Click / tap / Enter on a candle. `touch` — the first tap on a touch screen only selects. */
  onActivate: (index: number) => void;
  /** Visible window changed; `user` — by drag / zoom / navigator (not by a preset). */
  onView: (v: View, user: boolean) => void;
  /** Plain wheel over the chart (the page scrolls) — show the «Ctrl + колесо» hint. */
  onWheelHint?: () => void;
}

interface Data {
  bars: EquityCandle[];
  keys: string[];
  derived: EquityDerived;
  unit: EquityUnit;
  agg: EquityAgg;
  navDomain: Domain;
}

type Drag =
  | { kind: "plot"; id: number; x0: number; y0: number; view: View; moved: boolean; touch: boolean }
  | { kind: "nav"; id: number; x0: number; view: View; part: NavPart; moved: boolean };

const VIEW_MS = 280;

export class EquityEngine {
  private host: HTMLElement;
  private base: HTMLCanvasElement;
  private over: HTMLCanvasElement;
  private bctx: CanvasRenderingContext2D;
  private octx: CanvasRenderingContext2D;
  private cb: EngineCallbacks;
  private ro: ResizeObserver | null = null;
  private dpr = 1;
  private w = 0;
  private h = 0;

  private data: Data | null = null;
  private opts: EngineOptions = { mode: "line", pnl: false, dd: false, nav: false, marks: true };
  private th: ChartTheme;
  private reduce = false;

  private view: View = { from: 0, to: 1 };
  private anim: { a: View; b: View; t0: number; user: boolean } | null = null;
  private yMain: Domain | null = null;
  private yPnl: Domain | null = null;
  private yDd: Domain | null = null;
  private mix = 1;
  private reveal = 1;
  private alpha = 1;
  private revealPending = true;

  private hover = -1;
  private pointerY: number | null = null;
  private selected = -1;
  private drag: Drag | null = null;
  private lastTapIndex = -1;
  private clickTimer: ReturnType<typeof setTimeout> | null = null;

  private raf = 0;
  private last = 0;
  private dirtyBase = true;
  private dirtyOver = true;
  private layout: Layout | null = null;
  private frame: Frame | null = null;
  private lastHoverSig = "";
  private viewNotified: View | null = null;
  private viewUser = false;

  constructor(host: HTMLElement, theme: ChartTheme, cb: EngineCallbacks) {
    this.host = host;
    this.th = theme;
    this.cb = cb;
    this.reduce = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    this.base = document.createElement("canvas");
    this.over = document.createElement("canvas");
    for (const c of [this.base, this.over]) {
      c.style.position = "absolute";
      c.style.inset = "0";
      c.style.width = "100%";
      c.style.height = "100%";
      c.style.display = "block";
      host.appendChild(c);
    }
    // Vertical page scroll stays native on touch; horizontal drags pan the chart.
    this.over.style.touchAction = "pan-y";
    this.over.setAttribute("aria-hidden", "true");
    this.base.setAttribute("aria-hidden", "true");
    this.bctx = this.base.getContext("2d")!;
    this.octx = this.over.getContext("2d")!;
    this.bind();
    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(host);
    }
    this.resize();
  }

  destroy() {
    this.ro?.disconnect();
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.clickTimer) clearTimeout(this.clickTimer);
    this.unbind();
    this.base.remove();
    this.over.remove();
  }

  // ─── Public setters ───

  setTheme(th: ChartTheme) {
    this.th = th;
    this.invalidate();
  }

  setOptions(o: Partial<EngineOptions>) {
    const prev = this.opts;
    this.opts = { ...prev, ...o };
    if (this.reduce || this.revealPending) this.mix = this.opts.mode === "line" ? 1 : 0;
    this.invalidate();
  }

  /** New data. `view` — where to look (default: everything); `fade` — cross-fade the swap (aggregation change). */
  setData(bars: EquityCandle[], derived: EquityDerived, unit: EquityUnit, agg: EquityAgg, o: { view?: View; fade?: boolean } = {}) {
    let lo = 0, hi = 0;
    for (const b of bars) { lo = Math.min(lo, b.close, b.open); hi = Math.max(hi, b.close, b.open); }
    this.data = { bars, keys: bars.map((b) => b.key), derived, unit, agg, navDomain: yDomain(lo, hi, { includeZero: true, pad: 0.1 }) };
    const n = bars.length;
    this.anim = null;
    this.view = clampView(o.view ?? fullView(n), n);
    this.yMain = this.yPnl = this.yDd = null;
    this.hover = -1;
    this.selected = Math.min(this.selected, n - 1);
    if (o.fade && !this.reduce && !this.revealPending) this.alpha = 0.15;
    if (this.revealPending && n > 0) {
      this.revealPending = false;
      this.reveal = this.reduce ? 1 : 0;
      this.mix = this.opts.mode === "line" ? 1 : 0;
    }
    this.notifyView(false, true);
    this.invalidate();
  }

  getView(): View { return this.view; }

  /** Animated (unless reduced motion) move to a window. */
  setView(v: View, o: { animate?: boolean; user?: boolean } = {}) {
    if (!this.data) return;
    const n = this.data.bars.length;
    const target = clampView(v, n);
    if (o.animate === false || this.reduce) {
      this.anim = null;
      this.view = target;
      this.notifyView(!!o.user);
    } else {
      this.anim = { a: { ...this.view }, b: target, t0: performance.now(), user: !!o.user };
    }
    this.invalidate();
  }

  /** Zoom by factor (< 1 in) around a slot (default: the selected candle or the window centre). */
  zoom(factor: number, anchor?: number) {
    if (!this.data) return;
    const v = this.anim?.b ?? this.view;
    const a = anchor ?? (this.selected >= 0 ? this.selected + 0.5 : (v.from + v.to) / 2);
    this.setView(zoomAt(v, a, factor, this.data.bars.length), { user: true });
  }

  setSelected(i: number) {
    this.selected = i;
    this.dirtyOver = true;
    this.schedule();
  }

  slotWidth(): number {
    return this.layout ? this.layout.plotW / (this.view.to - this.view.from) : 0;
  }

  // ─── Loop ───

  private invalidate() {
    this.dirtyBase = true;
    this.dirtyOver = true;
    this.schedule();
  }

  private schedule() {
    if (!this.raf) this.raf = requestAnimationFrame((t) => this.tick(t));
  }

  private resize() {
    const r = this.host.getBoundingClientRect();
    const w = Math.max(0, Math.round(r.width));
    const h = Math.max(0, Math.round(r.height));
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w; this.h = h; this.dpr = dpr;
    for (const c of [this.base, this.over]) {
      c.width = Math.max(1, Math.round(w * dpr));
      c.height = Math.max(1, Math.round(h * dpr));
    }
    this.invalidate();
  }

  private tick(now: number) {
    this.raf = 0;
    const dt = this.last ? Math.min(64, now - this.last) : 16;
    this.last = now;
    let busy = false;
    const d = this.data;

    if (this.anim) {
      const t = (now - this.anim.t0) / VIEW_MS;
      this.view = t >= 1 ? this.anim.b : lerpView(this.anim.a, this.anim.b, easeOutCubic(t));
      const user = this.anim.user;
      if (t >= 1) this.anim = null;
      else busy = true;
      this.notifyView(user);
      this.dirtyBase = true;
    }

    const step = (cur: number, target: number, ms: number) => {
      if (this.reduce) return target;
      const k = 1 - Math.exp(-dt / ms);
      const nv = cur + (target - cur) * k;
      if (Math.abs(target - nv) < 0.002) return target;
      busy = true;
      return nv;
    };
    const mixT = this.opts.mode === "line" ? 1 : 0;
    if (this.mix !== mixT) { this.mix = step(this.mix, mixT, 70); this.dirtyBase = true; }
    if (this.alpha !== 1) { this.alpha = step(this.alpha, 1, 70); this.dirtyBase = true; }
    if (this.reveal < 1) {
      this.reveal = this.reduce ? 1 : Math.min(1, this.reveal + dt / 650);
      if (this.reveal < 1) busy = true;
      this.dirtyBase = true;
    }

    if (d && d.bars.length && this.w > 0 && this.h > 0) {
      // Autoscale targets for the visible window, eased (snap on first paint).
      const n = d.bars.length;
      const [i0, i1] = visibleRange(this.view, n);
      let lo = Infinity, hi = -Infinity, plo = 0, phi = 0, dlo = 0;
      for (let i = i0; i <= i1; i++) {
        const b = d.bars[i];
        const low = this.opts.mode === "line" ? Math.min(b.close, i === 0 ? b.open : b.close) : b.low;
        const high = this.opts.mode === "line" ? Math.max(b.close, i === 0 ? b.open : b.close) : b.high;
        lo = Math.min(lo, low);
        hi = Math.max(hi, high);
        plo = Math.min(plo, b.value);
        phi = Math.max(phi, b.value);
        dlo = Math.min(dlo, d.derived.underwater[i]);
      }
      const tMain = yDomain(lo, hi, { pad: 0.1 });
      const tPnl = yDomain(plo, phi, { includeZero: true, pad: 0.14 });
      const tDd: Domain = { min: dlo < 0 ? dlo * 1.12 : -1, max: dlo < 0 ? -dlo * 0.06 : 0.06 };
      const ease = (cur: Domain | null, t: Domain): Domain => {
        if (!cur) { this.dirtyBase = true; return t; }
        const span = Math.max(1e-9, t.max - t.min);
        const k = 1 - Math.exp(-dt / 55);
        if (this.reduce || (Math.abs(cur.min - t.min) < span * 0.002 && Math.abs(cur.max - t.max) < span * 0.002)) {
          if (cur.min !== t.min || cur.max !== t.max) this.dirtyBase = true;
          return t;
        }
        busy = true;
        this.dirtyBase = true;
        return { min: cur.min + (t.min - cur.min) * k, max: cur.max + (t.max - cur.max) * k };
      };
      this.yMain = ease(this.yMain, tMain);
      this.yPnl = ease(this.yPnl, tPnl);
      this.yDd = ease(this.yDd, tDd);

      if (this.dirtyBase || !this.frame) {
        this.frame = this.makeFrame(d, i0, i1);
        this.bctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        drawBase(this.bctx, this.frame);
        this.dirtyBase = false;
        this.dirtyOver = true;
      }
    } else if (this.dirtyBase) {
      this.bctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.bctx.clearRect(0, 0, this.w, this.h);
      this.frame = null;
      this.dirtyBase = false;
    }

    if (this.dirtyOver) {
      this.octx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const p = this.pointer();
      if (this.frame) drawOverlay(this.octx, this.frame, p);
      else this.octx.clearRect(0, 0, this.w, this.h);
      this.dirtyOver = false;
      this.emitHover(p);
    }
    if (busy) this.schedule();
  }

  private makeFrame(d: Data, i0: number, i1: number): Frame {
    // The axis is sized to its widest label (domain edges and the current value pill).
    this.bctx.font = `600 11px ${this.th.font}`;
    const ym = this.yMain!;
    const last = d.bars[d.bars.length - 1].close;
    const widest = Math.max(
      ...[ym.min, ym.max, last].map((v) => this.bctx.measureText(axisLabel(v, d.unit)).width),
    );
    const layout = computeLayout(this.w, this.h, { pnl: this.opts.pnl, dd: this.opts.dd, nav: this.opts.nav, axisW: widest + 22 });
    this.layout = layout;
    return {
      layout, view: this.view, bars: d.bars, keys: d.keys, derived: d.derived, unit: d.unit, agg: d.agg, th: this.th,
      mix: this.mix, yMain: ym, yPnl: this.yPnl!, yDd: this.yDd!, navDomain: d.navDomain, marks: this.opts.marks,
      reveal: easeOutCubic(this.reveal), alpha: this.alpha, i0, i1,
      slotPx: layout.plotW / (this.view.to - this.view.from),
      year: new Date().getFullYear().toString(),
    };
  }

  private pointer(): Pointer | null {
    const i = this.hover >= 0 ? this.hover : this.selected;
    if (i < 0 || this.drag?.moved) return null;
    return { index: i, y: this.hover >= 0 ? this.pointerY : null, selected: this.hover < 0 };
  }

  private emitHover(p: Pointer | null) {
    const f = this.frame;
    if (!p || !f) {
      if (this.lastHoverSig !== "") { this.lastHoverSig = ""; this.cb.onHover(null); }
      return;
    }
    const l = f.layout;
    const x = xOf(p.index + 0.5, l.plotX, l.plotW, f.view);
    const yy = l.main.y + l.main.h - ((f.bars[p.index].close - f.yMain.min) / (f.yMain.max - f.yMain.min || 1)) * l.main.h;
    const sig = `${p.index}:${Math.round(x)}:${Math.round(yy)}:${p.selected}`;
    if (sig === this.lastHoverSig) return;
    this.lastHoverSig = sig;
    if (x < l.plotX - 1 || x > l.plotX + l.plotW + 1) { this.cb.onHover(null); return; }
    const bottom = l.dd ?? l.pnl ?? l.main;
    this.cb.onHover({ index: p.index, x, y: yy, width: this.w, plotTop: l.main.y, plotBottom: bottom.y + bottom.h, selected: p.selected });
  }

  private notifyView(user: boolean, force = false) {
    this.viewUser = this.viewUser || user;
    if (!force && this.viewNotified && sameView(this.viewNotified, this.view, 1e-4)) return;
    this.viewNotified = { ...this.view };
    const u = this.viewUser;
    this.viewUser = false;
    this.cb.onView(this.view, u);
  }

  // ─── Input ───

  private local(e: { clientX: number; clientY: number }) {
    const r = this.over.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** Pointer capture can throw for a pointer that is already gone (fast taps, synthetic events). */
  private capture(id: number) {
    try { this.over.setPointerCapture(id); } catch { /* not capturable — dragging still works inside the canvas */ }
  }

  private onDown = (e: PointerEvent) => {
    const l = this.layout, d = this.data;
    if (!l || !d || !d.bars.length || e.button > 0) return;
    const { x, y } = this.local(e);
    const region = regionAt(x, y, l);
    const n = d.bars.length;
    if (region === "nav" && l.nav) {
      let part = navHit(x, l.nav, this.view, n);
      if (part === "track") {
        this.setView(navCenter(this.view, navSlotAt(x, l.nav, n), n), { user: true, animate: false });
        part = "window";
      }
      this.drag = { kind: "nav", id: e.pointerId, x0: x, view: { ...this.view }, part, moved: false };
      this.capture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (region === "plot") {
      this.anim = null;
      this.drag = { kind: "plot", id: e.pointerId, x0: x, y0: y, view: { ...this.view }, moved: false, touch: e.pointerType === "touch" };
      if (e.pointerType !== "touch") this.capture(e.pointerId);
    }
  };

  private onMove = (e: PointerEvent) => {
    const l = this.layout, d = this.data;
    if (!l || !d) return;
    const { x, y } = this.local(e);
    const n = d.bars.length;
    const drag = this.drag;
    if (drag && drag.id === e.pointerId) {
      const dx = x - drag.x0;
      if (drag.kind === "nav" && l.nav) {
        const full = fullView(n);
        drag.moved = drag.moved || Math.abs(dx) > 1;
        this.view = navDrag(drag.part, drag.view, (dx / l.nav.w) * (full.to - full.from), n);
        this.notifyView(true);
        this.invalidate();
        return;
      }
      if (drag.kind === "plot") {
        if (!drag.moved && Math.abs(dx) > 4) {
          // A mostly vertical touch move is a page scroll — let the browser have it.
          if (drag.touch && Math.abs(y - drag.y0) > Math.abs(dx)) { this.drag = null; return; }
          drag.moved = true;
          if (drag.touch) this.capture(e.pointerId);
          this.over.style.cursor = "grabbing";
        }
        if (drag.moved) {
          const span = drag.view.to - drag.view.from;
          this.view = pan(drag.view, (-dx / l.plotW) * span, n);
          this.hover = -1;
          this.notifyView(true);
          this.invalidate();
          return;
        }
      }
    }
    if (e.pointerType === "touch" && !drag) return;
    const region = regionAt(x, y, l);
    if (region === "nav" && l.nav) {
      const part = navHit(x, l.nav, this.view, n);
      this.over.style.cursor = part === "window" ? "grab" : part === "track" ? "pointer" : "ew-resize";
      this.setHover(-1, null);
      return;
    }
    if (region === "plot") {
      this.over.style.cursor = "pointer";
      this.setHover(indexAt(x, l.plotX, l.plotW, this.view, n), y);
    } else {
      this.over.style.cursor = "default";
      this.setHover(-1, null);
    }
  };

  private onUp = (e: PointerEvent) => {
    const drag = this.drag;
    const l = this.layout, d = this.data;
    this.drag = null;
    if (this.over.hasPointerCapture?.(e.pointerId)) this.over.releasePointerCapture(e.pointerId);
    this.over.style.cursor = "";
    if (!drag || drag.id !== e.pointerId || !l || !d) return;
    if (drag.kind === "plot" && !drag.moved) {
      const { x, y } = this.local(e);
      const i = indexAt(x, l.plotX, l.plotW, this.view, d.bars.length);
      if (i < 0) return;
      if (drag.touch && this.lastTapIndex !== i) {
        // Touch: the first tap shows the details, a second tap on the same candle opens it.
        this.lastTapIndex = i;
        this.setHover(i, y);
        return;
      }
      this.lastTapIndex = -1;
      // Wait out a possible double-click (= reset) before opening the candle.
      if (this.clickTimer) clearTimeout(this.clickTimer);
      this.clickTimer = setTimeout(() => { this.clickTimer = null; this.cb.onActivate(i); }, drag.touch ? 0 : 230);
    }
    this.invalidate();
  };

  private onLeave = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    if (!this.drag) this.setHover(-1, null);
  };

  private onWheel = (e: WheelEvent) => {
    const l = this.layout, d = this.data;
    if (!l || !d || !d.bars.length) return;
    const { x, y } = this.local(e);
    const region = regionAt(x, y, l);
    if (region !== "plot" && region !== "nav" && region !== "time") return;
    const n = d.bars.length;
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 240 : 1;
    const dx = e.deltaX * scale, dy = e.deltaY * scale;
    const base = this.anim?.b ?? this.view;
    if (e.ctrlKey || e.metaKey) {
      // ctrl + wheel and trackpad pinch (reported as ctrl + wheel) zoom around the cursor.
      e.preventDefault();
      const anchor = region === "plot" ? slotAt(x, l.plotX, l.plotW, base) : (base.from + base.to) / 2;
      this.anim = null;
      this.view = zoomAt(base, anchor, Math.exp(dy * 0.0035), n);
      this.notifyView(true);
      this.invalidate();
      return;
    }
    if (Math.abs(dx) > Math.abs(dy) || e.shiftKey) {
      e.preventDefault();
      const delta = Math.abs(dx) > Math.abs(dy) ? dx : dy;
      this.anim = null;
      this.view = pan(base, (delta / l.plotW) * (base.to - base.from), n);
      this.notifyView(true);
      this.invalidate();
      return;
    }
    this.cb.onWheelHint?.();
  };

  private onDbl = (e: MouseEvent) => {
    const l = this.layout, d = this.data;
    if (!l || !d) return;
    const { x, y } = this.local(e);
    if (this.clickTimer) { clearTimeout(this.clickTimer); this.clickTimer = null; }
    if (regionAt(x, y, l) === null) return;
    this.setView(fullView(d.bars.length), { user: true });
  };

  private setHover(i: number, y: number | null) {
    if (i === this.hover && y === this.pointerY) return;
    this.hover = i;
    this.pointerY = y;
    this.dirtyOver = true;
    this.schedule();
  }

  private bind() {
    this.over.addEventListener("pointerdown", this.onDown);
    this.over.addEventListener("pointermove", this.onMove);
    this.over.addEventListener("pointerup", this.onUp);
    this.over.addEventListener("pointercancel", this.onUp);
    this.over.addEventListener("pointerleave", this.onLeave);
    this.over.addEventListener("wheel", this.onWheel, { passive: false });
    this.over.addEventListener("dblclick", this.onDbl);
  }

  private unbind() {
    this.over.removeEventListener("pointerdown", this.onDown);
    this.over.removeEventListener("pointermove", this.onMove);
    this.over.removeEventListener("pointerup", this.onUp);
    this.over.removeEventListener("pointercancel", this.onUp);
    this.over.removeEventListener("pointerleave", this.onLeave);
    this.over.removeEventListener("wheel", this.onWheel);
    this.over.removeEventListener("dblclick", this.onDbl);
  }
}
