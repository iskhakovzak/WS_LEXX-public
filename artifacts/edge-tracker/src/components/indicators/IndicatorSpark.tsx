/**
 * Illustrative (not live) mini chart per indicator kind. Pure SVG, deterministic per id, token colours only.
 */
import { memo, useMemo, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { SparkKind } from "./library";
import { indicatorsI18n } from "@/i18n/ns/indicators";

const W = 120;
const H = 48;
const PRICE = "hsl(var(--foreground) / 0.55)";
const C1 = "hsl(var(--chart-1))";
const C3 = "hsl(var(--chart-3))";
const C5 = "hsl(var(--chart-5))";
const UP = "hsl(var(--up))";
const DOWN = "hsl(var(--down))";
const FAINT = "hsl(var(--muted-foreground) / 0.5)";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function walk(n: number, seed: number, drift = 0.25, vol = 1.6) {
  const r = rng(seed);
  const out = [50];
  for (let i = 1; i < n; i++) out.push(out[i - 1] + drift + (r() - 0.5) * vol * 2 + Math.sin(i / 4) * 0.6);
  return out;
}
const sma = (v: number[], p: number) => v.map((_, i) => { const s = v.slice(Math.max(0, i - p + 1), i + 1); return s.reduce((a, b) => a + b, 0) / s.length; });
const ema = (v: number[], p: number) => { const k = 2 / (p + 1); const out: number[] = []; v.forEach((x, i) => out.push(i ? x * k + out[i - 1] * (1 - k) : x)); return out; };
const std = (v: number[], p: number) => v.map((_, i) => { const s = v.slice(Math.max(0, i - p + 1), i + 1); const m = s.reduce((a, b) => a + b, 0) / s.length; return Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / s.length); });

type Box = { y0: number; y1: number };
const TOP: Box = { y0: 3, y1: 31 };
const FULL: Box = { y0: 3, y1: 45 };
const BOTTOM: Box = { y0: 35, y1: 46 };

function scaler(all: number[], box: Box, pad = 0) {
  const min = Math.min(...all) - pad;
  const max = Math.max(...all) + pad;
  const span = max - min || 1;
  return (v: number) => box.y1 - ((v - min) / span) * (box.y1 - box.y0);
}
const xs = (n: number, i: number) => 2 + (i / Math.max(1, n - 1)) * (W - 4);
const line = (v: number[], y: (n: number) => number, x0 = 0, n = v.length) =>
  v.map((p, i) => `${i ? "L" : "M"}${xs(n, i + x0).toFixed(1)},${y(p).toFixed(1)}`).join("");
/** Points in unit space (x 0..1, y 0..1 bottom→top). */
const unit = (pts: [number, number][], box: Box = FULL) =>
  pts.map(([x, y], i) => `${i ? "L" : "M"}${(2 + x * (W - 4)).toFixed(1)},${(box.y1 - y * (box.y1 - box.y0)).toFixed(1)}`).join("");
const hLine = (y: number, color: string, key: string, dash = "3 3") => (
  <line key={key} x1={2} x2={W - 2} y1={y} y2={y} stroke={color} strokeWidth={1} strokeDasharray={dash} vectorEffect="non-scaling-stroke" />
);
const P = (d: string, stroke: string, key: string, w = 1.5, extra: Record<string, unknown> = {}) => (
  <path key={key} d={d} fill="none" stroke={stroke} strokeWidth={w} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" {...extra} />
);

type Candle = [o: number, h: number, l: number, c: number];
function candles(list: Candle[]) {
  const all = list.flatMap((c) => [c[1], c[2]]);
  const y = scaler(all, FULL, 1);
  const step = (W - 8) / list.length;
  return list.map(([o, h, l, c], i) => {
    const cx = 4 + step * i + step / 2;
    const col = c >= o ? UP : DOWN;
    const top = y(Math.max(o, c));
    const bh = Math.max(1, Math.abs(y(o) - y(c)));
    return (
      <g key={i}>
        <line x1={cx} x2={cx} y1={y(h)} y2={y(l)} stroke={col} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <rect x={cx - step * 0.28} y={top} width={step * 0.56} height={bh} fill={col} rx={0.6} />
      </g>
    );
  });
}

function build(kind: SparkKind, seed: number): ReactNode[] {
  const n = 40;
  switch (kind) {
    case "ma":
    case "ema": {
      const v = walk(n, seed, 0.35);
      const y = scaler(v, FULL, 1);
      const out = [P(line(v, y), PRICE, "p", 1.2)];
      if (kind === "ma") out.push(P(line(sma(v, 10), y), C1, "m", 1.8));
      else { out.push(P(line(ema(v, 4), y), C1, "f", 1.6)); out.push(P(line(ema(v, 12), y), C3, "s", 1.6)); }
      return out;
    }
    case "vwap": {
      const r = rng(seed);
      const v = Array.from({ length: n }, (_, i) => 50 + i * 0.25 + Math.sin(i / 3) * 3 + (r() - 0.5) * 2);
      const cum = v.map((_, i) => v.slice(0, i + 1).reduce((a, b) => a + b, 0) / (i + 1));
      const y = scaler([...v, ...cum], FULL, 1);
      return [P(line(v, y), PRICE, "p", 1.2), P(line(cum, y), C1, "w", 2)];
    }
    case "avwap": {
      const v = walk(n, seed, 0.1).map((p, i) => (i >= 14 ? p + 8 : p));
      const anchored = v.slice(14).map((_, i, arr) => arr.slice(0, i + 1).reduce((a, b) => a + b, 0) / (i + 1));
      const y = scaler(v, FULL, 1);
      return [
        P(line(v, y), PRICE, "p", 1.2),
        P(line(anchored, y, 14, n), C1, "a", 2),
        <circle key="d" cx={xs(n, 14)} cy={y(v[14])} r={2} fill={C3} />,
      ];
    }
    case "bands": {
      const v = walk(n, seed, 0.2, 1.2).map((p, i) => (i > 26 ? p + (i - 26) * 1.2 : p));
      const m = sma(v, 10);
      const s = std(v, 10).map((x) => Math.max(0.8, x));
      const up = m.map((x, i) => x + 2 * s[i]);
      const lo = m.map((x, i) => x - 2 * s[i]);
      const y = scaler([...up, ...lo, ...v], FULL);
      const area = line(up, y) + lo.map((p, i) => `L${xs(n, n - 1 - i).toFixed(1)},${y(lo[n - 1 - i]).toFixed(1)}`).join("") + "Z";
      return [
        <path key="a" d={area} fill="hsl(var(--chart-1) / 0.12)" stroke="none" />,
        P(line(up, y), C1, "u", 1), P(line(lo, y), C1, "l", 1), P(line(v, y), PRICE, "p", 1.3),
      ];
    }
    case "atr":
    case "osc":
    case "macd":
    case "volume":
    case "obv":
    case "rvol": {
      const v = walk(n, seed, kind === "osc" ? 0 : 0.3, 1.8);
      const y = scaler(v, TOP, 1);
      const out: ReactNode[] = [P(line(v, y), PRICE, "p", 1.2)];
      const r = rng(seed + 7);
      if (kind === "atr") {
        const tr = v.map((p, i) => (i ? Math.abs(p - v[i - 1]) : 1));
        const a = sma(tr, 6);
        const ya = scaler(a, BOTTOM);
        out.push(<path key="a" d={line(a, ya) + `L${xs(n, n - 1)},${BOTTOM.y1}L${xs(n, 0)},${BOTTOM.y1}Z`} fill="hsl(var(--chart-3) / 0.18)" stroke="none" />);
        out.push(P(line(a, ya), C3, "al", 1.4));
      } else if (kind === "osc") {
        const rsi = v.map((_, i) => {
          let g = 0, l = 0;
          for (let j = Math.max(1, i - 6); j <= i; j++) { const d = v[j] - v[j - 1]; if (d > 0) g += d; else l -= d; }
          return l + g === 0 ? 50 : (g / (g + l)) * 100;
        });
        const yr = (x: number) => BOTTOM.y1 - (x / 100) * (BOTTOM.y1 - BOTTOM.y0);
        out.push(hLine(yr(70), FAINT, "h70", "2 2"), hLine(yr(30), FAINT, "h30", "2 2"), P(line(rsi, yr), C5, "r", 1.4));
      } else if (kind === "macd") {
        const slow = ema(v, 12);
        const h = ema(v, 4).map((x, i) => x - slow[i]);
        const max = Math.max(...h.map(Math.abs)) || 1;
        const mid = (BOTTOM.y0 + BOTTOM.y1) / 2;
        const half = (BOTTOM.y1 - BOTTOM.y0) / 2;
        h.forEach((x, i) => out.push(
          <rect key={`b${i}`} x={xs(n, i) - 1} width={2} y={x >= 0 ? mid - (x / max) * half : mid} height={Math.max(0.4, (Math.abs(x) / max) * half)} fill={x >= 0 ? UP : DOWN} opacity={0.8} />,
        ));
      } else if (kind === "obv") {
        let acc = 0;
        const obv = v.map((p, i) => (acc += i ? Math.sign(p - v[i - 1]) * (0.5 + r()) : 0));
        out.push(P(line(obv, scaler(obv, BOTTOM)), "hsl(var(--chart-2))", "o", 1.4));
      } else {
        const vols = v.map((p, i) => {
          const base = 0.3 + r() * 0.4;
          if (kind === "rvol") return i < 8 ? 1 - i * 0.06 + r() * 0.1 : base * 0.7;
          return i === 18 || i === 31 ? 1 : base;
        });
        vols.forEach((x, i) => out.push(
          <rect key={`v${i}`} x={xs(n, i) - 1} width={2} y={BOTTOM.y1 - x * (BOTTOM.y1 - BOTTOM.y0)} height={x * (BOTTOM.y1 - BOTTOM.y0)}
            fill={kind === "rvol" ? (i < 8 ? "hsl(var(--chart-2))" : FAINT) : i && v[i] < v[i - 1] ? DOWN : UP} opacity={0.75} />,
        ));
        if (kind === "rvol") out.push(hLine(BOTTOM.y1 - 0.35 * (BOTTOM.y1 - BOTTOM.y0), C3, "avg", "2 2"));
      }
      return out;
    }
    case "rs": {
      const a = walk(n, seed, 0.45, 1.2);
      const b = walk(n, seed + 3, -0.05, 1.2);
      const y = scaler([...a, ...b], FULL, 1);
      return [P(line(b, y), FAINT, "b", 1.3), P(line(a, y), C1, "a", 1.8)];
    }
    case "vprofile": {
      const v = walk(n, seed, 0.1, 2);
      const y = scaler(v, FULL, 1);
      const bins = new Array(8).fill(0);
      const min = Math.min(...v), max = Math.max(...v);
      v.forEach((p) => { bins[Math.min(7, Math.floor(((p - min) / (max - min || 1)) * 8))]++; });
      const top = Math.max(...bins);
      const bh = (FULL.y1 - FULL.y0) / 8;
      return [
        ...bins.map((c, i) => (
          <rect key={`vp${i}`} x={W - 2 - (c / top) * 34} y={FULL.y1 - (i + 1) * bh + 0.5} width={(c / top) * 34} height={bh - 1}
            fill={c === top ? "hsl(var(--chart-1) / 0.45)" : "hsl(var(--muted-foreground) / 0.2)"} rx={0.8} />
        )),
        P(line(v, y), PRICE, "p", 1.2),
      ];
    }
    case "fib":
      return [
        hLine(FULL.y1 - 0.382 * (FULL.y1 - FULL.y0), C3, "f1"), hLine(FULL.y1 - 0.5 * (FULL.y1 - FULL.y0), C3, "f2"), hLine(FULL.y1 - 0.618 * (FULL.y1 - FULL.y0), C3, "f3"),
        P(unit([[0, 0.02], [0.12, 0.2], [0.2, 0.15], [0.38, 0.75], [0.45, 0.98], [0.55, 0.8], [0.66, 0.5], [0.72, 0.42], [0.8, 0.6], [0.9, 0.85], [1, 0.95]]), C1, "p", 1.8),
      ];
    case "levels":
      return [
        hLine(FULL.y1 - 0.85 * (FULL.y1 - FULL.y0), DOWN, "r"), hLine(FULL.y1 - 0.15 * (FULL.y1 - FULL.y0), UP, "s"),
        P(unit([[0, 0.5], [0.1, 0.83], [0.2, 0.4], [0.3, 0.17], [0.42, 0.7], [0.52, 0.86], [0.6, 0.45], [0.7, 0.16], [0.82, 0.6], [0.92, 0.84], [1, 0.95]]), PRICE, "p", 1.5),
      ];
    case "hs":
      return [
        hLine(FULL.y1 - 0.35 * (FULL.y1 - FULL.y0), C3, "n"),
        P(unit([[0, 0.1], [0.12, 0.6], [0.2, 0.35], [0.35, 0.95], [0.48, 0.35], [0.62, 0.62], [0.74, 0.34], [0.86, 0.15], [1, 0.05]]), C1, "p", 1.8),
      ];
    case "dtdb":
      return [
        hLine(FULL.y1 - 0.9 * (FULL.y1 - FULL.y0), DOWN, "t"),
        P(unit([[0, 0.15], [0.2, 0.9], [0.38, 0.5], [0.58, 0.88], [0.75, 0.48], [0.88, 0.3], [1, 0.12]]), C1, "p", 1.8),
      ];
    case "flag":
      return [
        P(unit([[0.42, 0.88], [0.7, 0.72]]), FAINT, "u", 1, { strokeDasharray: "2 2" }),
        P(unit([[0.42, 0.66], [0.7, 0.5]]), FAINT, "l", 1, { strokeDasharray: "2 2" }),
        P(unit([[0, 0.05], [0.12, 0.15], [0.3, 0.75], [0.4, 0.86], [0.48, 0.7], [0.55, 0.8], [0.62, 0.58], [0.68, 0.7], [0.76, 0.85], [0.88, 0.95], [1, 1]]), C1, "p", 1.8),
      ];
    case "gap":
      return [
        <rect key="z" x={2 + 0.42 * (W - 4)} y={FULL.y1 - 0.62 * (FULL.y1 - FULL.y0)} width={0.16 * (W - 4)} height={0.3 * (FULL.y1 - FULL.y0)} fill="hsl(var(--chart-3) / 0.15)" />,
        P(unit([[0, 0.1], [0.12, 0.2], [0.25, 0.15], [0.42, 0.32]]), PRICE, "a", 1.5),
        P(unit([[0.58, 0.62], [0.68, 0.8], [0.76, 0.7], [0.88, 0.9], [1, 0.97]]), C1, "b", 1.8),
      ];
    case "orb":
    case "pm": {
      const hi = kind === "orb" ? 0.62 : 0.66;
      const lo = kind === "orb" ? 0.38 : 0.3;
      return [
        <rect key="z" x={2} y={FULL.y1 - hi * (FULL.y1 - FULL.y0)} width={(kind === "orb" ? 0.2 : 0.38) * (W - 4)} height={(hi - lo) * (FULL.y1 - FULL.y0)} fill="hsl(var(--chart-1) / 0.12)" />,
        hLine(FULL.y1 - hi * (FULL.y1 - FULL.y0), UP, "h"), hLine(FULL.y1 - lo * (FULL.y1 - FULL.y0), DOWN, "l"),
        P(unit(kind === "orb"
          ? [[0, 0.5], [0.05, 0.6], [0.1, 0.4], [0.15, 0.55], [0.2, 0.45], [0.3, 0.6], [0.36, 0.7], [0.44, 0.63], [0.6, 0.82], [0.75, 0.78], [1, 0.95]]
          : [[0, 0.4], [0.08, 0.6], [0.16, 0.35], [0.26, 0.64], [0.38, 0.5], [0.46, 0.72], [0.52, 0.65], [0.6, 0.68], [0.75, 0.85], [1, 0.97]]), C1, "p", 1.8),
      ];
    }
    case "hammer":
      return candles([[60, 62, 52, 54], [54, 56, 47, 48], [48, 50, 42, 44], [44, 45, 33, 44.5], [45, 51, 44, 50], [50, 55, 49, 54]]);
    case "engulfing":
      return candles([[60, 61, 54, 55], [55, 56, 49, 50], [50, 51, 45, 46], [46, 47, 43, 44], [43, 53, 42, 52], [52, 57, 51, 56]]);
    case "doji":
      return candles([[40, 45, 39, 44], [44, 50, 43, 49], [49, 55, 48, 54], [54, 59, 53, 58], [58, 62, 54, 58.2], [58, 59, 52, 53]]);
    default:
      return [];
  }
}

export const IndicatorSpark = memo(function IndicatorSpark({ id, kind, className }: { id: string; kind: SparkKind; className?: string }) {
  const nodes = useMemo(() => build(kind, hash(id)), [id, kind]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={cn("block h-12 w-full", className)} role="img" aria-label={indicatorsI18n.t("card.sparkAria")}>
      {nodes}
    </svg>
  );
});
