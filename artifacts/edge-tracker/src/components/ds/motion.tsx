/**
 * Motion tokens for framer-motion + small animated primitives. CSS twins live in index.css
 * (--dur-1..4, --ease, utilities dur-1..4 / ease-smooth). Everything here respects prefers-reduced-motion.
 *
 *   <motion.div transition={MOTION.base} />            // 180 ms, desk easing
 *   <AnimatedNumber value={pnl} format={fmtUsd} />     // count to the new value, no layout shift
 *   <Reveal open={expanded}>…</Reveal>                 // height expand/collapse (grid-rows trick, no measuring)
 */
import * as React from "react";
import { useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";
import { fmtCount } from "@/lib/format";

export const EASE = [0.2, 0.8, 0.2, 1] as const;
export const EASE_IN_OUT = [0.65, 0, 0.35, 1] as const;

/** Durations in seconds (framer-motion units): fast 120 / base 180 / slow 240 / sheet 320 ms. */
export const DURATION = { fast: 0.12, base: 0.18, slow: 0.24, sheet: 0.32 } as const;

export const MOTION = {
  fast: { duration: DURATION.fast, ease: EASE },
  base: { duration: DURATION.base, ease: EASE },
  slow: { duration: DURATION.slow, ease: EASE },
  sheet: { duration: DURATION.sheet, ease: EASE },
} as const;

/** Enter preset for lists/cards: fade + 4px rise. Spread on a motion element. */
export function fadeRise(reduce: boolean | null, delay = 0) {
  return reduce
    ? { initial: false as const, animate: { opacity: 1 } }
    : { initial: { opacity: 0, y: 4 }, animate: { opacity: 1, y: 0 }, transition: { ...MOTION.base, delay } };
}

/**
 * Number that tweens to its new value (rAF, ~240 ms, ease-out). Tabular digits + `min-width` in `ch`
 * of the final string keep the box stable. Instant under reduced motion or on first render.
 */
export function AnimatedNumber({
  value,
  format = (n) => fmtCount(n),
  duration = 240,
  className,
  title,
}: {
  value: number | null | undefined;
  format?: (n: number) => string;
  duration?: number;
  className?: string;
  title?: string;
}) {
  const reduce = useReducedMotion();
  const target = typeof value === "number" && Number.isFinite(value) ? value : null;
  const [shown, setShown] = React.useState<number | null>(target);
  const fromRef = React.useRef<number | null>(target);
  const formatRef = React.useRef(format);
  formatRef.current = format;

  React.useEffect(() => {
    if (target == null) { setShown(null); fromRef.current = null; return; }
    const from = fromRef.current;
    if (reduce || from == null || from === target || typeof requestAnimationFrame === "undefined") {
      setShown(target); fromRef.current = target; return;
    }
    let raf = 0;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const k = 1 - Math.pow(1 - t, 3);
      const v = from + (target - from) * k;
      setShown(t >= 1 ? target : v);
      fromRef.current = t >= 1 ? target : v;
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, reduce, duration]);

  if (shown == null) return <span className={cn("tabular-nums text-muted-foreground", className)}>—</span>;
  const finalText = target != null ? formatRef.current(target) : "";
  return (
    <span className={cn("inline-block tabular-nums", className)} style={{ minWidth: `${finalText.length}ch` }} title={title}>
      {format(shown)}
    </span>
  );
}

/**
 * Expand/collapse without measuring: animates grid-template-rows 0fr ↔ 1fr (240 ms).
 * Collapsed content is `inert` (not focusable, hidden from AT) but stays mounted, so state is kept.
 */
export function Reveal({
  open,
  children,
  className,
  id,
}: {
  open: boolean;
  children: React.ReactNode;
  className?: string;
  id?: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open) el.removeAttribute("inert");
    else el.setAttribute("inert", "");
  }, [open]);
  return (
    <div
      id={id}
      ref={ref}
      aria-hidden={!open}
      data-state={open ? "open" : "closed"}
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-[var(--dur-3)] ease-smooth",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        className,
      )}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}
