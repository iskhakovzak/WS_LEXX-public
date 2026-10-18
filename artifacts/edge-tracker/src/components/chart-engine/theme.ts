/**
 * Chart colours resolved from the project's CSS tokens (--up, --down, --primary, --chart-N, …).
 * Reads the DOM once per call; the component re-reads on theme changes (html class mutation).
 */

export type ColorFn = (alpha?: number) => string;

export type ChartTheme = {
  up: ColorFn;
  down: ColorFn;
  primary: ColorFn;
  c1: ColorFn;
  c2: ColorFn;
  c3: ColorFn;
  c4: ColorFn;
  c5: ColorFn;
  fg: ColorFn;
  muted: ColorFn;
  border: ColorFn;
  bg: ColorFn;
  font: string;
  dark: boolean;
  /** Solid label background for axis labels / tooltips. */
  labelBg: string;
};

function hslTripletToRgb(triplet: string): [number, number, number] | null {
  const m = triplet.trim().match(/^(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/);
  if (!m) return null;
  const h = ((Number(m[1]) % 360) + 360) % 360;
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

const DARK_FALLBACK: Record<string, [number, number, number]> = {
  "--up": [84, 203, 142], "--down": [242, 107, 107], "--primary": [10, 132, 255],
  "--chart-1": [51, 153, 255], "--chart-2": [84, 203, 142], "--chart-3": [228, 196, 74], "--chart-4": [242, 107, 107], "--chart-5": [169, 139, 216],
  "--foreground": [233, 235, 238], "--muted-foreground": [163, 167, 173], "--border": [58, 61, 66], "--background": [17, 18, 20],
};

export function readChartTheme(): ChartTheme {
  const root = typeof document !== "undefined" ? document.documentElement : null;
  const cs = root ? getComputedStyle(root) : null;
  const make = (name: string): ColorFn => {
    const rgb = (cs && hslTripletToRgb(cs.getPropertyValue(name))) || DARK_FALLBACK[name] || [128, 128, 128];
    return (a = 1) => `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
  };
  const dark = !!root?.classList.contains("dark");
  const font = (typeof document !== "undefined" && getComputedStyle(document.body).fontFamily) || "Inter, system-ui, sans-serif";
  return {
    up: make("--up"), down: make("--down"), primary: make("--primary"),
    c1: make("--chart-1"), c2: make("--chart-2"), c3: make("--chart-3"), c4: make("--chart-4"), c5: make("--chart-5"),
    fg: make("--foreground"), muted: make("--muted-foreground"), border: make("--border"), bg: make("--background"),
    font, dark,
    labelBg: dark ? "rgba(38, 40, 44, 0.96)" : "rgba(52, 54, 58, 0.96)",
  };
}
