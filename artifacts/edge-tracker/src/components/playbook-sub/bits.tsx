/**
 * Small shared bits for playbook sub-components (edge block, checklist marks, health, revisions, AI).
 * Token-only colours; no new deps.
 */
import * as React from "react";
import { cn } from "@/lib/utils";
import { toneText, type Tone } from "@/components/ds";

/** Tone for a checklist readiness percentage. 0 → neutral (nothing marked yet is not "bad"). */
export function readinessTone(pct: number): Tone {
  if (pct <= 0) return "neutral";
  if (pct >= 80) return "up";
  if (pct >= 50) return "warn";
  return "down";
}

/** Tone for a win rate in [0..1]. */
export function winrateTone(wr: number, n: number): Tone {
  if (n === 0) return "neutral";
  if (wr >= 0.55) return "up";
  if (wr >= 0.4) return "warn";
  return "down";
}

/** Circular progress ring. `value` in [0..1]. Colour follows `tone` via currentColor. */
export function Ring({
  value,
  size = 48,
  stroke = 5,
  tone = "accent",
  children,
  className,
  label,
}: {
  value: number;
  size?: number;
  stroke?: number;
  tone?: Tone;
  children?: React.ReactNode;
  className?: string;
  label?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <div
      className={cn("relative inline-grid shrink-0 place-items-center", className)}
      style={{ width: size, height: size }}
      role={label ? "img" : undefined}
      aria-label={label}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--border))" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v)}
          className={cn("motion-safe:transition-[stroke-dashoffset] motion-safe:duration-300", toneText(tone === "neutral" ? "accent" : tone))}
          style={{ opacity: tone === "neutral" && v === 0 ? 0 : 1 }}
        />
      </svg>
      {children != null && <div className="absolute inset-0 grid place-items-center">{children}</div>}
    </div>
  );
}

/** Thin horizontal progress bar. `value` in [0..1]. */
export function Bar({ value, tone = "accent", className }: { value: number; tone?: Tone; className?: string }) {
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-[hsl(var(--border))]", className)} aria-hidden="true">
      <div
        className={cn("h-full rounded-full bg-current motion-safe:transition-[width] motion-safe:duration-300", toneText(tone === "neutral" ? "accent" : tone))}
        style={{ width: `${v * 100}%` }}
      />
    </div>
  );
}

/** 32px round ghost icon button used in setup card headers. */
export const IconAction = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { "aria-label": string; active?: boolean }
>(function IconAction({ className, active, children, type, ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(
        "inline-grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors",
        "hover:bg-[var(--glass-hover-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:pointer-events-none disabled:opacity-50 [&_svg]:h-4 [&_svg]:w-4",
        active && "text-primary",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
});

/** Inline "**bold**" + `code` renderer for AI text. */
export function InlineMd({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith("**") && p.endsWith("**")) return <strong key={i} className="font-semibold text-foreground">{p.slice(2, -2)}</strong>;
        if (p.startsWith("`") && p.endsWith("`")) return <code key={i} className="rounded bg-[var(--glass-bg)] px-1 text-[0.95em]">{p.slice(1, -1)}</code>;
        return <React.Fragment key={i}>{p}</React.Fragment>;
      })}
    </>
  );
}

/** localStorage helpers (wrapped: private mode / blocked storage must not crash). */
export function lsGet<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
export function lsSet(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}
