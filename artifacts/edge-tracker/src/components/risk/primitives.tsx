/**
 * Local risk-desk primitives: LimitBar, ProgressRing, Sparkline, StatusPill, TierPill + formatters.
 * (ds.tsx has no LimitBar/ProgressRing yet — the shell agent may promote these later.)
 */
import * as React from "react";
import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { Pill, type Tone } from "@/components/ds";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, ChevronsUpDown, CircleDashed, OctagonX, type LucideIcon } from "lucide-react";
import { TableHead } from "@/components/ui/table";
import type { Horizon, RiskStatus, StopState } from "./use-risk";
import type { RankLevel } from "./risk-math";
import { fmtPct, fmtRelative, fmtUsd } from "@/lib/format";
import { riskI18n } from "@/i18n/ns/risk";
import { commonI18n } from "@/i18n/ns/common";
import { horizonLabel, levelLabel, statusLabel, stopStateLabel } from "./labels";

// ─── desk level: ok / near / stop (colour + icon + text) ────────────────────

export const LEVEL_META: Record<RankLevel, { tone: Tone; icon: LucideIcon; text: string }> = {
  stop: { tone: "down", icon: OctagonX, text: "text-down" },
  near: { tone: "warn", icon: AlertTriangle, text: "text-warn" },
  ok: { tone: "up", icon: CheckCircle2, text: "text-up" },
  none: { tone: "neutral", icon: CircleDashed, text: "text-muted-foreground" },
};

/** Status chip that never relies on colour alone: icon + word (+ optional detail line). */
export function LevelBadge({ level, label, className }: { level: RankLevel; label?: string; className?: string }) {
  riskI18n.useT();
  const m = LEVEL_META[level];
  const Icon = m.icon;
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium", m.text, className)}>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {label ?? levelLabel(level)}
    </span>
  );
}

/** Compact usage meter for table cells: «64%» + thin bar; tooltip with $ used / limit. «—» when no limit. */
export function UsageCell({ pct, used, limit, label }: { pct: number | null; used: number; limit: number | null | undefined; label: string }) {
  const { t } = riskI18n.useT();
  if (limit == null || pct == null) {
    return <span className="text-xs text-muted-foreground" title={t("usage.notSet", { label })}>—</span>;
  }
  const w = Math.min(100, Math.max(used > 0 ? 3 : 0, pct));
  const title = t("usage.title", {
    label,
    used: fmtUsd(used, { decimals: 0 }),
    limit: fmtUsd(limit, { decimals: 0 }),
    pct: fmtPct(pct, { decimals: 0, signed: false }),
    left: fmtUsd(Math.max(0, limit - used), { decimals: 0 }),
  });
  return (
    <div className="flex min-w-[84px] flex-col gap-1" title={title}>
      <div className="flex items-baseline justify-between gap-2 text-xs tabular-nums">
        <span className={cn("font-semibold", usageText(pct))}>{fmtPct(pct, { decimals: 0, signed: false })}</span>
        <span className="whitespace-nowrap text-xs text-muted-foreground">
          {t("usage.left", { amount: fmtUsd(Math.max(0, limit - used), { decimals: 0, compact: 10_000 }) })}
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(Math.min(pct, 999))}
        aria-valuetext={title}
        className="relative h-1.5 overflow-hidden rounded-full bg-[var(--glass-bg)] ring-1 ring-inset ring-[var(--field-border)]"
      >
        <div className="h-full rounded-full" style={{ width: `${w}%`, background: usageColor(pct) }} />
        <span aria-hidden="true" className="absolute inset-y-0 w-px bg-foreground/25" style={{ left: "70%" }} />
      </div>
    </div>
  );
}

/** Horizon display name (common trading.*): getters, so indexing at render time reads the current language. */
export const HORIZON_LABEL: Record<Horizon, string> = {
  get intraday() { return horizonLabel("intraday"); },
  get overnight() { return horizonLabel("overnight"); },
  get swing() { return horizonLabel("swing"); },
};
export const HORIZON_TONE: Record<Horizon, Tone> = { intraday: "neutral", overnight: "accent", swing: "purple" };

// ─── tiers / scaling plan ───────────────────────────────────────────────────

/** `value` is the stored code; `key` points at common tiers.* and risk tierHint.* (read at render time). */
const TIER_DEFS = [
  { value: "trainee", key: "intern" },
  { value: "junior", key: "junior" },
  { value: "trader", key: "trader" },
  { value: "senior", key: "senior" },
] as const;

export const TIERS = TIER_DEFS.map((d) => ({
  value: d.value,
  get label() { return commonI18n.t(`tiers.${d.key}`); },
  get hint() { return riskI18n.t(`tierHint.${d.key}`); },
}));

export function tierLabel(tier: string | null | undefined): string | null {
  if (!tier) return null;
  return TIERS.find((t) => t.value === tier)?.label ?? (tier === "lead" ? riskI18n.t("tierLead") : tier);
}

export function TierPill({ tier, className }: { tier: string | null | undefined; className?: string }) {
  riskI18n.useT();
  const label = tierLabel(tier);
  if (!label) return <Pill tone="neutral" className={className}>{commonI18n.t("tiers.noTier")}</Pill>;
  const idx = TIERS.findIndex((t) => t.value === tier);
  return (
    <Pill tone="purple" className={className}>
      {label}
      {idx >= 0 && <span className="opacity-80">· {idx + 1}/{TIERS.length}</span>}
    </Pill>
  );
}

// ─── status ─────────────────────────────────────────────────────────────────

export const STATUS_META: Record<RiskStatus, { tone: Tone }> = {
  ok: { tone: "up" },
  warn: { tone: "warn" },
  breach: { tone: "down" },
  no_limits: { tone: "neutral" },
};

export function StatusPill({ status, className }: { status: RiskStatus; className?: string }) {
  riskI18n.useT();
  return <Pill tone={STATUS_META[status].tone} dot className={className}>{statusLabel(status)}</Pill>;
}

// ─── red-day stop state ─────────────────────────────────────────────────────

export const STOP_META: Record<StopState, { tone: Tone }> = {
  ok: { tone: "up" },
  warn: { tone: "warn" },
  stop: { tone: "down" },
  weekly: { tone: "down" },
  drawdown: { tone: "down" },
  no_limits: { tone: "neutral" },
};

export function StopPill({ state, className }: { state: StopState; className?: string }) {
  riskI18n.useT();
  return <Pill tone={STOP_META[state].tone} dot className={className}>{stopStateLabel(state)}</Pill>;
}

// ─── usage colour ───────────────────────────────────────────────────────────

/** ≥100 breach (down), ≥70 warn, else ok. */
export function usageTone(pct: number | null | undefined): "up" | "warn" | "down" | "neutral" {
  if (pct == null) return "neutral";
  if (pct >= 100) return "down";
  if (pct >= 70) return "warn";
  return "up";
}

const TONE_COLOR: Record<"up" | "warn" | "down" | "neutral", string> = {
  up: "hsl(var(--up))",
  warn: "hsl(var(--warn))",
  down: "hsl(var(--down))",
  neutral: "hsl(var(--muted-foreground))",
};
const TONE_TEXT: Record<"up" | "warn" | "down" | "neutral", string> = {
  up: "text-up",
  warn: "text-warn",
  down: "text-down",
  neutral: "text-muted-foreground",
};
export const usageText = (pct: number | null | undefined) => TONE_TEXT[usageTone(pct)];
export const usageColor = (pct: number | null | undefined) => TONE_COLOR[usageTone(pct)];

// ─── LimitBar ───────────────────────────────────────────────────────────────

/**
 * Horizontal usage bar: "label ........ used / limit" with a 70% warn tick.
 * Renders a muted "no limit set" line when limit is null.
 */
export function LimitBar({
  label,
  used,
  limit,
  format = (v: number) => fmtUsd(v, { decimals: 0, compact: 10_000 }),
  size = "md",
  className,
  hint,
}: {
  label: React.ReactNode;
  used: number;
  limit: number | null | undefined;
  format?: (v: number) => string;
  size?: "sm" | "md";
  className?: string;
  hint?: React.ReactNode;
}) {
  const { t } = riskI18n.useT();
  const has = limit != null && limit >= 0;
  const pct = !has ? null : (limit as number) > 0 ? (used / (limit as number)) * 100 : used > 0 ? 100 : 0;
  const width = pct == null ? 0 : Math.min(100, Math.max(used > 0 ? 2 : 0, pct));
  const labelId = React.useId();
  const notSet = commonI18n.t("trading.limitNotSet");
  return (
    <div className={cn("min-w-0", className)}>
      <div className={cn("flex items-baseline justify-between gap-2", size === "sm" ? "text-xs" : "text-sm")}>
        <span id={labelId} className="min-w-0 text-muted-foreground">{label}</span>
        {has ? (
          <span className="shrink-0 tabular-nums">
            <span className={cn("font-medium", usageText(pct))}>{format(used)}</span>
            <span className="text-muted-foreground"> / {format(limit as number)}</span>
          </span>
        ) : (
          <span className="shrink-0 text-xs text-muted-foreground">{notSet}</span>
        )}
      </div>
      <div
        role="meter"
        aria-labelledby={labelId}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct == null ? undefined : Math.round(Math.min(pct, 999))}
        aria-valuetext={has ? t("usage.valueText", { used: format(used), limit: format(limit as number), pct: fmtPct(pct, { decimals: 0, signed: false }) }) : notSet}
        className={cn("relative mt-1.5 overflow-hidden rounded-full bg-[var(--glass-bg)] ring-1 ring-inset ring-[var(--field-border)]", size === "sm" ? "h-1.5" : "h-2")}
      >
        <div
          className="h-full rounded-full transition-[width] duration-300 ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none"
          style={{ width: `${width}%`, background: usageColor(pct) }}
        />
        {has && <span aria-hidden="true" className="absolute inset-y-0 w-px bg-foreground/25" style={{ left: "70%" }} />}
      </div>
      {(hint || (pct != null && pct >= 70)) && (
        <div className="mt-1 flex items-center justify-between gap-2 text-2xs text-muted-foreground">
          <span className="min-w-0">{hint}</span>
          {pct != null && <span className={cn("tabular-nums font-medium", usageText(pct))}>{fmtPct(pct, { decimals: 0, signed: false })}</span>}
        </div>
      )}
    </div>
  );
}

// ─── ProgressRing ───────────────────────────────────────────────────────────

export function ProgressRing({
  pct,
  size = 120,
  stroke = 10,
  children,
  label,
  className,
}: {
  /** 0..100+ ; null = no limit (empty track). */
  pct: number | null;
  size?: number;
  stroke?: number;
  children?: React.ReactNode;
  label: string;
  className?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = pct == null ? 0 : Math.min(100, Math.max(0, pct));
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct == null ? undefined : Math.round(pct)}
      aria-valuetext={pct == null ? commonI18n.t("trading.limitNotSet") : fmtPct(pct, { decimals: 0, signed: false })}
      className={cn("relative grid shrink-0 place-items-center", className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--border))" strokeWidth={stroke} />
        {[70].map((t) => {
          const a = (t / 100) * 2 * Math.PI;
          const x1 = size / 2 + (r - stroke / 2) * Math.cos(a);
          const y1 = size / 2 + (r - stroke / 2) * Math.sin(a);
          const x2 = size / 2 + (r + stroke / 2) * Math.cos(a);
          const y2 = size / 2 + (r + stroke / 2) * Math.sin(a);
          return <line key={t} x1={x1} y1={y1} x2={x2} y2={y2} stroke="hsl(var(--foreground) / 0.3)" strokeWidth={1.5} />;
        })}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={usageColor(pct)}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v / 100)}
          className="transition-[stroke-dashoffset] duration-500 ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none"
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">{children}</div>
    </div>
  );
}

// ─── Sparkline ──────────────────────────────────────────────────────────────

export function Sparkline({
  values,
  width = 120,
  height = 32,
  className,
  label,
}: {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
  label?: string;
}) {
  const id = React.useId().replace(/:/g, "");
  if (values.length < 2) {
    return (
      <svg width={width} height={height} className={className} role="img" aria-label={label ?? commonI18n.t("states.noData")}>
        <line x1={0} x2={width} y1={height / 2} y2={height / 2} stroke="hsl(var(--border))" strokeDasharray="3 3" />
      </svg>
    );
  }
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;
  const pad = 2;
  const x = (i: number) => (i / (values.length - 1)) * width;
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = values[values.length - 1];
  const color = last >= 0 ? "hsl(var(--up))" : "hsl(var(--down))";
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} role="img" aria-label={label ?? riskI18n.t("sparkAria")} preserveAspectRatio="none">
      <defs>
        <linearGradient id={`sg${id}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.25} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <line x1={0} x2={width} y1={y(0)} y2={y(0)} stroke="hsl(var(--border))" strokeDasharray="2 3" />
      <path d={`${d} L${width},${y(0)} L0,${y(0)} Z`} fill={`url(#sg${id})`} />
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// ─── misc ───────────────────────────────────────────────────────────────────

export const CHART_TOOLTIP_STYLE: CSSProperties = {
  backgroundColor: "hsl(var(--popover) / 0.92)",
  border: "1px solid hsl(var(--border))",
  color: "hsl(var(--popover-foreground))",
  borderRadius: 12,
  fontSize: 12,
  boxShadow: "0 8px 32px rgb(0 0 0 / 0.3)",
  backdropFilter: "blur(24px)",
  fontVariantNumeric: "tabular-nums",
};
export const AXIS = { stroke: "hsl(var(--muted-foreground))", fontSize: 11, tickLine: false, axisLine: false } as const;

/** localStorage-backed string state (never throws). */
export function useStoredState<T extends string>(key: string, initial: T, allowed: readonly T[]): [T, (v: T) => void] {
  const [v, setV] = React.useState<T>(() => {
    try {
      const s = localStorage.getItem(key) as T | null;
      if (s != null && allowed.includes(s)) return s;
    } catch { /* storage unavailable */ }
    return initial;
  });
  const set = React.useCallback((next: T) => {
    setV(next);
    try { localStorage.setItem(key, next); } catch { /* ignore */ }
  }, [key]);
  return [v, set];
}

/** «обновлено …» with relative time in the UI language — ticks every 10s. */
export function useAgo(ts: number | undefined): string {
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  commonI18n.useT();
  React.useEffect(() => {
    const id = window.setInterval(force, 10_000);
    return () => window.clearInterval(id);
  }, []);
  if (!ts) return "";
  return commonI18n.t("ds.updatedAgo", { ago: fmtRelative(ts) });
}

// ─── sortable header for components/ui Table (pair with useTableSort from ds) ──

export function SortableTableHead({
  children, active, dir, onSort, align = "left", className,
}: { children: React.ReactNode; active: boolean; dir: "asc" | "desc"; onSort: () => void; align?: "left" | "right"; className?: string }) {
  const Icon = !active ? ChevronsUpDown : dir === "asc" ? ChevronUp : ChevronDown;
  return (
    <TableHead className={cn(align === "right" && "text-right", className)} aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        onClick={onSort}
        className={cn(
          "inline-flex items-center gap-1 rounded-full hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          active && "text-foreground",
          align === "right" && "flex-row-reverse",
        )}
      >
        {children}
        <Icon className={cn("h-3 w-3", !active && "opacity-50")} aria-hidden="true" />
      </button>
    </TableHead>
  );
}
