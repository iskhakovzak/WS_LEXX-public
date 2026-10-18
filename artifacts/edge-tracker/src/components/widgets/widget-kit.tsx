/**
 * Shared chrome for dashboard widgets: one glass card language, dense header,
 * icon actions, error/skeleton states, sparkline and number formatting.
 */
import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtDate, fmtRelative } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { Skeleton } from "@/components/ui/skeleton";
import type { Tone } from "@/components/ds";

/* ───────────────────────────── Shell ───────────────────────────── */

export function WidgetShell({
  icon: Icon,
  title,
  meta,
  actions,
  children,
  className,
  bodyClassName,
  accent,
  id,
  as: As = "section",
  ...rest
}: {
  icon?: LucideIcon;
  title: React.ReactNode;
  /** Small muted text right after the title (date range, timestamp…). */
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  /** Optional 2px accent bar on the left edge (e.g. "needs attention"). */
  accent?: Tone;
  id?: string;
  as?: "section" | "div" | "article";
} & Omit<React.HTMLAttributes<HTMLElement>, "title">) {
  const headingId = React.useId();
  return (
    <As
      id={id}
      aria-labelledby={headingId}
      className={cn("glass-panel relative overflow-hidden rounded-2xl", className)}
      {...rest}
    >
      {accent && (
        <span
          aria-hidden="true"
          className="absolute inset-y-3 left-0 w-[3px] rounded-r-full"
          style={{ background: TONE_VAR[accent] }}
        />
      )}
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 pt-3.5">
        <div className="flex min-w-0 items-center gap-2">
          {Icon && (
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-primary/12 text-primary">
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          )}
          <h2 id={headingId} className="truncate text-sm font-semibold text-foreground">
            {title}
          </h2>
          {meta && <span className="truncate text-xs text-muted-foreground tabular-nums">{meta}</span>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </header>
      <div className={cn("px-4 pb-4 pt-3", bodyClassName)}>{children}</div>
    </As>
  );
}

/** 32px round ghost icon button with required aria-label. */
export const IconAction = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string; spinning?: boolean; active?: boolean }
>(function IconAction({ icon: Icon, label, spinning, active, className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors",
        "hover:bg-[var(--glass-hover-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:pointer-events-none disabled:opacity-50",
        active && "bg-primary/15 text-primary",
        className,
      )}
      {...props}
    >
      <Icon className={cn("h-4 w-4", spinning && "motion-safe:animate-spin")} aria-hidden="true" />
    </button>
  );
});

/* ───────────────────────────── States ───────────────────────────── */

export function WidgetError({
  message,
  onRetry,
  className,
}: {
  message?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn("flex flex-wrap items-center gap-2 rounded-xl bg-down/10 px-3 py-2.5 text-sm text-down", className)}
    >
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{message ?? commonI18n.t("queryError.genericTitle")}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="chip inline-flex min-h-8 items-center gap-1.5 px-3 text-xs font-medium"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> {commonI18n.t("actions.retry")}
        </button>
      )}
    </div>
  );
}

export function SkeletonTiles({ count = 4, className, tileClassName }: { count?: number; className?: string; tileClassName?: string }) {
  return (
    <div className={cn("grid grid-cols-2 gap-2 sm:grid-cols-4", className)} aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className={cn("h-14 rounded-xl", tileClassName)} />
      ))}
    </div>
  );
}

/** Small labelled metric tile used inside widgets. */
export function MiniStat({
  label,
  value,
  tone = "neutral",
  hint,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  tone?: Tone;
  hint?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 rounded-xl bg-foreground/[0.04] px-3 py-2", className)}>
      <div className="truncate text-2xs text-muted-foreground">{label}</div>
      <div className={cn("truncate text-lg font-semibold tabular-nums leading-tight", TONE_TEXT[tone])}>{value}</div>
      {hint && <div className="truncate text-2xs text-muted-foreground tabular-nums">{hint}</div>}
    </div>
  );
}

/* ───────────────────────────── Tone helpers ───────────────────────────── */

export const TONE_VAR: Record<Tone, string> = {
  up: "hsl(var(--up))",
  down: "hsl(var(--down))",
  accent: "hsl(var(--primary))",
  warn: "hsl(var(--chart-3))",
  purple: "hsl(var(--chart-5))",
  neutral: "hsl(var(--muted-foreground))",
};

const TONE_TEXT: Record<Tone, string> = {
  up: "text-up",
  down: "text-down",
  accent: "text-primary",
  warn: "text-[hsl(var(--chart-3))]",
  purple: "text-[hsl(var(--chart-5))]",
  neutral: "text-foreground",
};

/** Diverging heat background for a % move; intensity saturates at `cap`. */
export function heatBg(pct: number | null | undefined, cap = 3): string {
  if (pct == null || !Number.isFinite(pct) || Math.abs(pct) < 0.05) return "hsl(var(--foreground) / 0.05)";
  const a = 0.1 + Math.min(Math.abs(pct) / cap, 1) * 0.42;
  return pct > 0 ? `hsl(var(--up) / ${a.toFixed(3)})` : `hsl(var(--down) / ${a.toFixed(3)})`;
}

/* ───────────────────────────── Sparkline ───────────────────────────── */

/**
 * Minimal SVG sparkline. Nulls break the line; the last point gets a dot.
 * `domain` fixes the y-range (e.g. [0,100] for scores).
 */
export function Sparkline({
  values,
  width = 120,
  height = 28,
  domain,
  tone = "accent",
  className,
  label,
  area = true,
  connectGaps = false,
}: {
  values: Array<number | null>;
  width?: number;
  height?: number;
  domain?: [number, number];
  tone?: Tone;
  className?: string;
  label?: string;
  area?: boolean;
  /** Skip nulls instead of breaking the line (x positions stay time-aligned). */
  connectGaps?: boolean;
}) {
  const gradId = React.useId().replace(/:/g, "");
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (values.length < 2 || nums.length === 0) {
    return (
      <svg width={width} height={height} className={className} role="img" aria-label={label ?? commonI18n.t("widgets.notEnoughData")}>
        <line x1="0" x2={width} y1={height / 2} y2={height / 2} stroke="hsl(var(--border))" strokeDasharray="3 3" />
      </svg>
    );
  }
  const [lo, hi] = domain ?? [Math.min(...nums), Math.max(...nums)];
  const span = hi - lo || 1;
  const pad = 3;
  const x = (i: number) => (values.length === 1 ? width / 2 : (i / (values.length - 1)) * (width - pad * 2) + pad);
  const y = (v: number) => height - pad - ((v - lo) / span) * (height - pad * 2);

  const segments: string[] = [];
  let cur = "";
  values.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) {
      if (connectGaps) return;
      if (cur) segments.push(cur);
      cur = "";
      return;
    }
    cur += `${cur ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
  });
  if (cur) segments.push(cur);

  let lastIdx = -1;
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v != null && Number.isFinite(v)) {
      lastIdx = i;
      break;
    }
  }
  const color = TONE_VAR[tone];

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("overflow-visible", className)}
      role="img"
      aria-label={label}
    >
      {area && (
        <defs>
          <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
      )}
      {area &&
        segments.map((d, i) => {
          const pts = d.slice(1).split("L").map((p) => p.split(",").map(Number));
          if (pts.length < 2) return null;
          const first = pts[0];
          const last = pts[pts.length - 1];
          return <path key={`a${i}`} d={`${d}L${last[0]},${height}L${first[0]},${height}Z`} fill={`url(#${gradId})`} />;
        })}
      {segments.map((d, i) => (
        <path key={i} d={d} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
      ))}
      {lastIdx >= 0 && <circle cx={x(lastIdx)} cy={y(values[lastIdx] as number)} r={2.5} fill={color} />}
    </svg>
  );
}

/* ───────────────────────────── Formatting ───────────────────────────── */

export function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : v != null && v !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** "только что" / "5 минут назад" / "2 часа назад" / date (UI language). */
export function relTime(iso: string | number | Date | null | undefined, now = Date.now()): string {
  if (iso == null) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return commonI18n.t("time.justNow");
  if (s < 22 * 3600) return fmtRelative(t, { now });
  return fmtDate(t, "dayMonth");
}

/** Re-render every `ms` (for relative timestamps / clocks). */
export function useNow(ms = 30_000): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** localStorage-backed state; tolerant of blocked storage. */
export function useStoredState<T extends string>(key: string, initial: T, allowed?: readonly T[]): [T, (v: T) => void] {
  const [v, setV] = React.useState<T>(() => {
    try {
      const s = window.localStorage.getItem(key) as T | null;
      if (s != null && (!allowed || allowed.includes(s))) return s;
    } catch {
      /* storage blocked */
    }
    return initial;
  });
  const set = React.useCallback(
    (nv: T) => {
      setV(nv);
      try {
        window.localStorage.setItem(key, nv);
      } catch {
        /* storage blocked */
      }
    },
    [key],
  );
  return [v, set];
}

/* ───────────────────────────── NY session ───────────────────────────── */

export type NySession = { key: "closed" | "premarket" | "open" | "regular" | "after" | "weekend"; label: string; tone: Tone };

export function nySession(now = new Date()): NySession & { hhmm: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const wd = parts.find((p) => p.type === "weekday")?.value || "";
  const hh = Number(parts.find((p) => p.type === "hour")?.value || "0") % 24;
  const mm = Number(parts.find((p) => p.type === "minute")?.value || "0");
  const hhmm = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  const s = (key: NySession["key"], tone: Tone) => ({ key, label: commonI18n.t(`widgets.session.${key}`), tone, hhmm });
  if (wd === "Sat" || wd === "Sun") return s("weekend", "neutral");
  const t = hh * 60 + mm;
  if (t >= 4 * 60 && t < 9 * 60 + 30) return s("premarket", "warn");
  if (t >= 9 * 60 + 30 && t < 10 * 60 + 30) return s("open", "up");
  if (t >= 10 * 60 + 30 && t < 16 * 60) return s("regular", "up");
  if (t >= 16 * 60 && t < 20 * 60) return s("after", "purple");
  return s("closed", "neutral");
}
