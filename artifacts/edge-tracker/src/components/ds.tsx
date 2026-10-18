/**
 * Page-level design-system primitives (liquid-glass, reference: earnings-analyzer).
 * Build pages from these so every section looks the same. Low-level controls live in components/ui.
 */
import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { ArrowDownRight, ArrowUpRight, ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";
import { fmtCount, fmtDate, fmtRate } from "@/lib/format";
import { ScrollContainerContext } from "@/components/ds/virtual";
import { TermTooltip, type TermKey } from "@/components/ds/term-tooltip";
import { commonI18n } from "@/i18n/ns/common";
import { fmtRelative } from "@/i18n/format";

/* Foundation modules (usage notes in each file's header). */
export { GLOSSARY, glossary, TermTooltip, TermContent, TermLabel, termForLabel, type TermKey, type GlossaryEntry } from "@/components/ds/term-tooltip";
export { ErrorState, QueryState, SkeletonBlock, StatGridSkeleton, ListSkeleton, TableSkeleton, PanelSkeleton } from "@/components/ds/states";
export { AnimatedNumber, Reveal, MOTION, DURATION, EASE, EASE_IN_OUT, fadeRise } from "@/components/ds/motion";
export { VirtualRows, VirtualList, ScrollContainerContext } from "@/components/ds/virtual";

export type Tone = "up" | "down" | "accent" | "warn" | "purple" | "neutral";

// Semantic text colours: all ≥4.5:1 on panels in dark, dim and light (see index.css token notes).
const TONE_TEXT: Record<Tone, string> = {
  up: "text-up",
  down: "text-down",
  accent: "text-primary",
  warn: "text-warn",
  purple: "text-purple",
  neutral: "text-foreground",
};

// Tinted pills: a 12% fill keeps the tone readable (≥4.5:1) without looking neon on graphite.
const TONE_PILL: Record<Tone, string> = {
  up: "bg-up/12 text-up",
  down: "bg-down/12 text-down",
  accent: "bg-primary/12 text-accent-soft",
  warn: "bg-warn/12 text-warn",
  purple: "bg-purple/12 text-purple",
  neutral: "bg-[var(--glass-bg)] text-muted-foreground border border-[var(--field-border)]",
};

/** Solid dot / bar colour for a tone (legends, status dots, progress fills). */
const TONE_BG: Record<Tone, string> = {
  up: "bg-up",
  down: "bg-down",
  accent: "bg-primary",
  warn: "bg-warn",
  purple: "bg-purple",
  neutral: "bg-muted-foreground",
};

/** Tone for a signed number: >0 up, <0 down, else neutral. */
export function toneOf(n: number | null | undefined): Tone {
  if (n == null || !Number.isFinite(n) || n === 0) return "neutral";
  return n > 0 ? "up" : "down";
}

export function toneText(tone: Tone) {
  return TONE_TEXT[tone];
}

/** Tinted pill classes for a tone (bg + text). */
export function tonePill(tone: Tone) {
  return TONE_PILL[tone];
}

/** Solid background class for a tone (dots, bars). */
export function toneBg(tone: Tone) {
  return TONE_BG[tone];
}

/** `title` for truncated text: only when the content is plain text. */
/** Plain text of a node for a native tooltip (strings, numbers and simple element trees); undefined when empty. */
function textTitle(node: React.ReactNode): string | undefined {
  if (typeof node === "string" || typeof node === "number") return String(node);
  const t = nodeText(node).trim();
  return t || undefined;
}

/**
 * Text that ellipsizes (or line-clamps) and shows the full value on hover (native title).
 * Sets `min-w-0`, so it shrinks inside flex rows.
 */
export function Truncate({
  children,
  title,
  lines = 1,
  className,
  as: As = "span",
}: {
  children: React.ReactNode;
  /** Full text for the tooltip; defaults to children when they are a string. */
  title?: string;
  /** 1 = single-line ellipsis, 2–3 = line clamp. */
  lines?: 1 | 2 | 3;
  className?: string;
  as?: "span" | "div" | "p";
}) {
  return (
    <As
      title={title ?? textTitle(children)}
      className={cn("min-w-0", lines === 1 ? "block truncate" : lines === 2 ? "line-clamp-2" : "line-clamp-3", className)}
    >
      {children}
    </As>
  );
}

/**
 * Page title row: icon, title, description, optional meta line (UpdatedAgo, counters) and right-aligned
 * actions. `children` render below as a full-width row (filters, SectionTabs). Same gaps on every page.
 */
export function PageHeader({
  title,
  description,
  icon: Icon,
  actions,
  children,
  className,
  meta,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: LucideIcon;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  /** Small line under the description: «обновлено …», counters, status pills. */
  meta?: React.ReactNode;
}) {
  return (
    <header className={cn("flex flex-col gap-4", className)}>
      {/* items-start + a 40px title row (icon, h1 line-height, actions min-h): actions stay on the title line
          even when the description wraps to 2–3 lines, instead of floating in the middle of the block. */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        {/* min width: on narrow screens the actions wrap below instead of squeezing the title to a sliver */}
        <div className="flex min-w-[min(100%,15rem)] flex-1 items-start gap-3">
          {Icon && (
            <span className="glass-panel grid h-10 w-10 shrink-0 place-items-center rounded-xl text-primary">
              <Icon className="h-5 w-5" aria-hidden="true" />
            </span>
          )}
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold leading-10 tracking-tight text-foreground sm:text-2xl" title={textTitle(title)}>
              {title}
            </h1>
            {description && <p className="line-clamp-3 max-w-3xl text-sm text-muted-foreground sm:line-clamp-2" title={textTitle(description)}>{description}</p>}
            {meta && <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">{meta}</div>}
          </div>
        </div>
        {actions && <div className="flex min-h-10 max-w-full shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

/**
 * Glass panel section with optional header (title, description, actions) and footer.
 * `fill` stretches it to the grid row height (equal-height bento rows) and lets the body grow.
 */
export function Panel({
  title,
  description,
  icon: Icon,
  actions,
  children,
  className,
  bodyClassName,
  padded = true,
  as: As = "section",
  fill = false,
  footer,
  ...rest
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  icon?: LucideIcon;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  padded?: boolean;
  as?: "section" | "div" | "article";
  /** h-full + flex column: equal heights in a grid row, body takes the remaining space. */
  fill?: boolean;
  /** Bottom bar («Все сделки →», totals) with a hairline above it. */
  footer?: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLElement>, "title">) {
  const hasHeader = title || actions;
  return (
    <As className={cn("glass-panel min-w-0 rounded-2xl", fill && "flex h-full flex-col", className)} {...rest}>
      {hasHeader && (
        <div className="flex min-h-[calc(var(--panel-p)+2rem)] flex-wrap items-center justify-between gap-x-3 gap-y-2 px-[var(--panel-p)] pt-[var(--panel-p)]">
          <div className="flex min-w-[min(100%,12rem)] flex-1 items-center gap-2">
            {Icon && <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
            <div className="min-w-0">
              {title && <h2 className="truncate text-sm font-semibold text-foreground" title={textTitle(title)}>{title}</h2>}
              {description && <p className="line-clamp-3 text-xs text-muted-foreground sm:line-clamp-2" title={textTitle(description)}>{description}</p>}
            </div>
          </div>
          {actions && <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div
        className={cn(
          "min-w-0",
          padded && "p-[var(--panel-p)]",
          hasHeader && padded && "pt-3",
          fill && "flex min-h-0 flex-1 flex-col",
          bodyClassName,
        )}
      >
        {children}
      </div>
      {footer && (
        <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-[var(--glass-border)] px-[var(--panel-p)] py-2.5 text-xs text-muted-foreground">
          {footer}
        </div>
      )}
    </As>
  );
}

/** KPI tile: small label, big tabular value, optional delta/hint. */
export function StatCard({
  label,
  value,
  tone = "neutral",
  hint,
  delta,
  deltaTone,
  icon: Icon,
  className,
  onClick,
  spark,
  sparkTone,
  term,
  loading = false,
  valueTitle,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  tone?: Tone;
  hint?: React.ReactNode;
  delta?: React.ReactNode;
  deltaTone?: Tone;
  icon?: LucideIcon;
  className?: string;
  onClick?: () => void;
  /** Optional inline trend (e.g. last 20 sessions of net P&L) drawn under the value. */
  spark?: ReadonlyArray<number | null | undefined>;
  sparkTone?: Tone | "auto";
  /** Glossary term: adds an (i) with the explanation next to the label (see TermTooltip). */
  term?: TermKey;
  /** Value-sized skeleton instead of the value (same card height — no jump when data arrives). */
  loading?: boolean;
  /** Native tooltip for the value (e.g. the exact number when the shown one is rounded). */
  valueTitle?: string;
}) {
  // A clickable card with a glossary (i) can't be a <button> (nested buttons) — use a keyboard-operable div.
  const asButton = !!onClick && !term;
  const Comp = asButton ? "button" : "div";
  return (
    <Comp
      type={asButton ? "button" : undefined}
      onClick={onClick}
      {...(onClick && !asButton
        ? {
            role: "button",
            tabIndex: 0,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
              e.preventDefault();
              onClick();
            },
          }
        : {})}
      aria-busy={loading || undefined}
      className={cn(
        "glass-panel flex h-full min-h-[104px] min-w-0 flex-col gap-1 rounded-2xl p-4 text-left",
        onClick && "lift cursor-pointer",
        className,
      )}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <span className="truncate" title={textTitle(label)}>{label}</span>
          {term && <TermTooltip term={term} icon />}
        </span>
        {Icon && <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
      </div>
      {loading ? (
        <span aria-hidden="true" className="skeleton my-1 block h-7 w-24" />
      ) : (
        <div
          className={cn("truncate text-2xl font-semibold leading-tight tabular-nums tracking-tight", TONE_TEXT[tone])}
          title={valueTitle ?? textTitle(value)}
        >
          {value}
        </div>
      )}
      {(delta || hint) && (
        <div className="mt-auto flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pt-0.5 text-xs">
          {delta && <Pill tone={deltaTone ?? "neutral"}>{delta}</Pill>}
          {/* Two lines before clipping: UZ / EN hints are longer; the full text stays in the tooltip. */}
          {hint && <span className="line-clamp-2 min-w-0 break-words text-muted-foreground" title={textTitle(hint)}>{hint}</span>}
        </div>
      )}
      {spark && spark.length > 1 && (
        <Sparkline
          data={spark}
          tone={sparkTone ?? "auto"}
          width={160}
          height={28}
          className={cn("w-full pt-1", !(delta || hint) && "mt-auto")}
        />
      )}
    </Comp>
  );
}

/**
 * Auto-fit grid for StatCards: as many equal columns as fit at `min` width (default 11rem ≈ 176 px),
 * equal heights per row — no 4+2 orphans, no breakage between 1280 and 1920 px.
 * Pages may still force columns via className (e.g. "xl:grid-cols-4") or `cols`.
 */
export function StatGrid({
  children,
  className,
  min = "11rem",
  cols,
}: {
  children: React.ReactNode;
  className?: string;
  /** Minimum card width (CSS length). */
  min?: string;
  /** Fixed column count from `md` up (overrides auto-fit). */
  cols?: 2 | 3 | 4 | 5 | 6;
}) {
  const fixed = cols
    ? {
        2: "md:grid-cols-2",
        3: "md:grid-cols-3",
        4: "md:grid-cols-2 xl:grid-cols-4",
        5: "md:grid-cols-3 xl:grid-cols-5",
        6: "md:grid-cols-3 xl:grid-cols-6",
      }[cols]
    : undefined;
  return (
    <div
      className={cn("grid grid-cols-[repeat(auto-fit,minmax(min(var(--stat-min),100%),1fr))] gap-[var(--grid-gap)]", fixed, className)}
      style={{ "--stat-min": min } as React.CSSProperties}
    >
      {children}
    </div>
  );
}

/** Label-left / value-right row for detail lists. */
export function StatRow({
  label,
  value,
  tone = "neutral",
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3 py-1 text-sm", className)}>
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("text-right font-medium tabular-nums", TONE_TEXT[tone])}>{value}</span>
    </div>
  );
}

/** Small tinted pill badge. */
export function Pill({
  tone = "neutral",
  children,
  className,
  dot,
  title,
}: {
  tone?: Tone;
  children: React.ReactNode;
  className?: string;
  dot?: boolean;
  /** Native tooltip (formula / source hint). */
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex min-h-5.5 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-xs font-medium leading-none tabular-nums [&_svg]:size-3 [&_svg]:shrink-0",
        TONE_PILL[tone],
        className,
      )}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />}
      {children}
    </span>
  );
}

export type SegmentOption<T extends string> = { value: T; label: React.ReactNode; count?: number; disabled?: boolean; /** Native tooltip (e.g. why the option is disabled). */ title?: string };

/**
 * Segmented control: pill track, active segment solid accent. Single-select.
 *
 * `T` is inferred from `value` only (options/onChange are `NoInfer`), so
 * `<Segmented value={tab} onChange={setTab} options={...} />` works with a
 * `useState<"a" | "b">` setter even when the options array is typed loosely.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = "md",
  className,
}: {
  options: ReadonlyArray<SegmentOption<NoInfer<T>>> | ReadonlyArray<SegmentOption<string>>;
  value: T;
  onChange: (v: NoInfer<T>) => void;
  ariaLabel: string;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn("glass-field inline-flex max-w-full shrink-0 items-center gap-0.5 overflow-x-auto", size === "sm" ? "h-8 p-0.5" : "h-9 p-[3px]", className)}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            disabled={o.disabled}
            title={o.title}
            onClick={() => onChange(o.value as T)}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full font-medium transition-[background-color,color,box-shadow] duration-[var(--dur-1)] ease-smooth disabled:opacity-50",
              size === "sm" ? "h-6.5 px-2.5 text-xs [&_svg]:size-3.5" : "h-7 px-3 text-sm [&_svg]:size-4",
              active
                ? "bg-primary-solid text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.25)]"
                : "text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground",
            )}
          >
            {o.label}
            {o.count != null && <span className={cn("tabular-nums", active ? "opacity-90" : "opacity-80")}>{fmtCount(o.count)}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Toggle chip for multi-select filters. */
export function FilterChip({
  active,
  onClick,
  children,
  className,
  count,
  size = "md",
  title,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
  count?: number;
  /** md 36px (default, lines up with inputs / selects / segmented), sm 32px for dense chip rows. */
  size?: "sm" | "md";
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={cn(
        "chip inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap font-medium disabled:pointer-events-none disabled:opacity-50",
        // min-h (single line, so it acts as the height) keeps page overrides like `min-h-7` working via tailwind-merge.
        size === "sm" ? "min-h-8 px-3 text-xs [&_svg]:size-3.5" : "min-h-9 px-3 text-sm [&_svg]:size-4",
        className,
      )}
    >
      {children}
      {count != null && <span className="tabular-nums opacity-80">{fmtCount(count)}</span>}
    </button>
  );
}

/** Filter/action bar above lists. */
export function Toolbar({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("glass-panel flex flex-wrap items-center gap-2 rounded-2xl p-2", className)}>{children}</div>;
}

/**
 * Empty state: icon, what's missing, how to fix it, and the action that fixes it.
 * `compact` for small panels/tiles (one row, less padding). `secondaryAction` = a quieter link/button.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  secondaryAction,
  compact = false,
}: {
  icon?: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  secondaryAction?: React.ReactNode;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <div className={cn("flex items-center gap-3 px-1 py-4 text-left", className)}>
        {Icon && (
          <span className="tile grid h-9 w-9 shrink-0 place-items-center rounded-xl text-muted-foreground">
            <Icon className="h-4 w-4" aria-hidden="true" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{title}</p>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {(action || secondaryAction) && (
          <div className="flex shrink-0 items-center gap-2">
            {secondaryAction}
            {action}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 px-6 py-12 text-center", className)}>
      {Icon && (
        <span className="tile grid h-12 w-12 place-items-center rounded-2xl text-muted-foreground">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
      )}
      <div className="max-w-sm">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {(action || secondaryAction) && (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}

/** Horizontal scroll wrapper for wide tables on mobile. */
export function TableScroll({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("-mx-1 overflow-x-auto px-1", className)}>{children}</div>;
}

/**
 * Page container: centred, max 1600 px (`--page-max`), 20 px between sections (`--page-gap`).
 * Side gutters come from the app shell. `width="narrow"` (960 px) for forms/settings/reading pages,
 * `"full"` for wide editors.
 */
export function Page({
  children,
  className,
  width = "default",
}: {
  children: React.ReactNode;
  className?: string;
  width?: "default" | "narrow" | "full";
}) {
  // The enter transition is applied once per route by the app shell (framer-motion, reduced-motion aware).
  return (
    <div
      className={cn(
        "mx-auto flex w-full min-w-0 flex-col gap-4 sm:gap-[var(--page-gap)]",
        width === "default" && "max-w-[var(--page-max)]",
        width === "narrow" && "max-w-[960px]",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Bento grid for panels: 1 column, 12 columns from lg, equal-height rows. Children set `lg:col-span-*`. */
export function BentoGrid({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("grid grid-cols-1 items-stretch gap-[var(--grid-gap)] lg:grid-cols-12", className)}>{children}</div>;
}

/** Inner tile inside a Panel (second elevation step). Clickable when `onClick` is given. */
export function Tile({
  children,
  className,
  onClick,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  title?: string;
}) {
  if (onClick) {
    return (
      <button type="button" onClick={onClick} title={title} className={cn("tile tile-interactive press min-w-0 p-3 text-left", className)}>
        {children}
      </button>
    );
  }
  return (
    <div title={title} className={cn("tile min-w-0 p-3", className)}>
      {children}
    </div>
  );
}

/** Coloured status dot + label (never colour alone). `pulse` for live states. */
export function StatusDot({
  tone = "neutral",
  children,
  pulse = false,
  className,
}: {
  tone?: Tone;
  children?: React.ReactNode;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 text-xs", className)}>
      <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
        {/* A few pings on mount, then a calm dot: an endless ping keeps the compositor busy all session. */}
        {pulse && <span className={cn("absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping [animation-iteration-count:4]", TONE_BG[tone])} />}
        <span className={cn("relative h-2 w-2 rounded-full", TONE_BG[tone])} />
      </span>
      {children != null && <span className="truncate">{children}</span>}
    </span>
  );
}

/**
 * useState persisted in localStorage (every access in try/catch; memory fallback in private mode).
 * For remembered filters / tabs / collapsed sections: `const [tab, setTab] = usePersistentState("trades.tab", "all")`.
 */
export function usePersistentState<T>(key: string, initial: T) {
  const storageKey = `ws_lexx.${key}`;
  const [value, setValue] = React.useState<T>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw == null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  React.useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
    } catch {
      /* storage blocked — keep the value in memory */
    }
  }, [storageKey, value]);
  return [value, setValue] as const;
}


/* ────────────────────────────────────────────────────────────────────────────
 * Inline data primitives (2026 pass). All additive; no external deps.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Tiny SVG trend line. `tone="auto"` colours by last vs first point. Scales to its box (preserveAspectRatio none). */
export function Sparkline({
  data,
  width = 80,
  height = 24,
  tone = "auto",
  fill = true,
  strokeWidth = 1.5,
  baseline,
  className,
  ariaLabel,
}: {
  data: ReadonlyArray<number | null | undefined>;
  width?: number;
  height?: number;
  tone?: Tone | "auto";
  /** Soft area under the line. */
  fill?: boolean;
  strokeWidth?: number;
  /** Draw a faint reference line at this value (e.g. 0 for P&L). */
  baseline?: number;
  className?: string;
  ariaLabel?: string;
}) {
  const pts = data.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const resolved: Tone = tone === "auto" ? (pts.length > 1 ? toneOf(pts[pts.length - 1] - pts[0]) : "neutral") : tone;
  const colour = resolved === "neutral" ? "text-muted-foreground" : TONE_TEXT[resolved];
  const pad = strokeWidth;
  if (pts.length < 2) {
    return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={cn("text-muted-foreground/60", className)} role="img" aria-label={ariaLabel ?? commonI18n.t("states.noData")}>
        <line x1={0} x2={width} y1={height / 2} y2={height / 2} stroke="currentColor" strokeWidth={1} strokeDasharray="2 3" />
      </svg>
    );
  }
  let min = Math.min(...pts);
  let max = Math.max(...pts);
  if (baseline != null) { min = Math.min(min, baseline); max = Math.max(max, baseline); }
  const span = max - min || 1;
  const x = (i: number) => (i / (pts.length - 1)) * width;
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);
  const line = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn(colour, "overflow-visible", className)}
      role="img"
      aria-label={ariaLabel ?? commonI18n.t("ds.trend", { from: pts[0], to: pts[pts.length - 1] })}
    >
      {baseline != null && (
        <line x1={0} x2={width} y1={y(baseline)} y2={y(baseline)} stroke="hsl(var(--border))" strokeWidth={1} strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
      )}
      {fill && <path d={area} fill="currentColor" opacity={0.12} />}
      <path d={line} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Circular progress (goals, win-rate, checklist completion). `label` renders in the centre. */
export function ProgressRing({
  value,
  max = 100,
  size = 44,
  stroke = 4,
  tone = "accent",
  label,
  ariaLabel,
  className,
}: {
  value: number | null | undefined;
  max?: number;
  size?: number;
  stroke?: number;
  tone?: Tone;
  /** Centre content; defaults to the rounded percentage. Pass null to hide. */
  label?: React.ReactNode;
  ariaLabel?: string;
  className?: string;
}) {
  const v = typeof value === "number" && Number.isFinite(value) ? value : 0;
  const pct = max > 0 ? Math.max(0, Math.min(1, v / max)) : 0;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const reduce = useReducedMotion();
  return (
    <span
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.round(v * 100) / 100}
      className={cn("relative inline-grid shrink-0 place-items-center", className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={cn("-rotate-90", tone === "neutral" ? "text-muted-foreground" : TONE_TEXT[tone])} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--border))" strokeWidth={stroke} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          initial={reduce ? false : { strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - pct) }}
          transition={{ duration: reduce ? 0 : 0.5, ease: [0.2, 0.8, 0.2, 1] }}
        />
      </svg>
      {label !== null && (
        <span className="absolute inset-0 grid place-items-center text-2xs font-semibold tabular-nums text-foreground">
          {label ?? fmtRate(pct)}
        </span>
      )}
    </span>
  );
}

/** Signed change pill: "+12.4%" / "−3.1R" with an arrow — coloured AND signed (never colour alone). */
export function Delta({
  value,
  suffix = "",
  prefix = "",
  precision = 1,
  format,
  invert = false,
  showIcon = true,
  bare = false,
  className,
}: {
  value: number | null | undefined;
  suffix?: string;
  prefix?: string;
  precision?: number;
  /** Custom formatter for the absolute value (the sign is added for you). */
  format?: (abs: number) => string;
  /** Lower is better (drawdown, fees): flips the colour, not the sign. */
  invert?: boolean;
  showIcon?: boolean;
  /** Text only, no pill background. */
  bare?: boolean;
  className?: string;
}) {
  if (value == null || !Number.isFinite(value)) {
    return <span className={cn("text-xs text-muted-foreground tabular-nums", className)}>—</span>;
  }
  const t = toneOf(invert ? -value : value);
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  const abs = Math.abs(value);
  const text = `${sign}${prefix}${format ? format(abs) : abs.toFixed(precision)}${suffix}`;
  const Icon = value > 0 ? ArrowUpRight : value < 0 ? ArrowDownRight : null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 whitespace-nowrap text-xs font-medium tabular-nums",
        bare ? TONE_TEXT[t] : cn("min-h-5.5 rounded-full px-1.5 leading-none", TONE_PILL[t]),
        className,
      )}
    >
      {showIcon && Icon && <Icon className="h-3 w-3" aria-hidden="true" />}
      {text}
    </span>
  );
}

/** Keyboard hint pill: `<Kbd>N</Kbd>` or `<Kbd keys={["Ctrl", "K"]} />`. */
export function Kbd({ children, keys, className }: { children?: React.ReactNode; keys?: string[]; className?: string }) {
  const cls =
    "inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-[var(--field-border)] bg-[var(--glass-bg)] px-1.5 font-sans text-2xs font-medium leading-none text-muted-foreground shadow-[inset_0_1px_0_var(--glass-hi)]";
  if (keys && keys.length) {
    return (
      <span className={cn("inline-flex items-center gap-0.5", className)}>
        {keys.map((k, i) => <kbd key={`${k}-${i}`} className={cls}>{k}</kbd>)}
      </span>
    );
  }
  return <kbd className={cn(cls, className)}>{children}</kbd>;
}

export type SectionTab<T extends string> = {
  value: T;
  label: React.ReactNode;
  icon?: LucideIcon;
  count?: number;
  disabled?: boolean;
};

/**
 * Underlined section tabs for switching views inside a page (lighter than Segmented; 3–7 views).
 * Arrow keys / Home / End move between tabs. `T` is inferred from `value`.
 */
export function SectionTabs<T extends string>({
  tabs,
  value,
  onChange,
  ariaLabel,
  className,
}: {
  tabs: ReadonlyArray<SectionTab<NoInfer<T>>> | ReadonlyArray<SectionTab<string>>;
  value: T;
  onChange: (v: NoInfer<T>) => void;
  ariaLabel: string;
  className?: string;
}) {
  const id = React.useId();
  const reduce = useReducedMotion();
  const list = tabs as ReadonlyArray<SectionTab<string>>;
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") return;
    const enabled = list.filter((t) => !t.disabled);
    if (!enabled.length) return;
    const i = Math.max(0, enabled.findIndex((t) => t.value === value));
    const next =
      e.key === "ArrowRight" ? (i + 1) % enabled.length
      : e.key === "ArrowLeft" ? (i - 1 + enabled.length) % enabled.length
      : e.key === "Home" ? 0
      : enabled.length - 1;
    const t = enabled[next];
    e.preventDefault();
    onChange(t.value as T);
    const root = e.currentTarget;
    requestAnimationFrame(() => {
      const btn = Array.from(root.querySelectorAll<HTMLElement>("[data-tab]")).find((el) => el.dataset.tab === t.value);
      btn?.focus();
    });
  };
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn("scrollbar-none flex max-w-full items-center gap-1 overflow-x-auto border-b border-[var(--glass-border)]", className)}
    >
      {list.map((t) => {
        const active = t.value === value;
        const Icon = t.icon;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            data-tab={t.value}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            disabled={t.disabled}
            onClick={() => onChange(t.value as T)}
            className={cn(
              "relative inline-flex min-h-10 shrink-0 items-center gap-1.5 whitespace-nowrap px-3 text-sm font-medium transition-colors disabled:opacity-50",
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {Icon && <Icon className="h-4 w-4" aria-hidden="true" />}
            {t.label}
            {t.count != null && (
              <span className={cn("rounded-full px-1.5 text-2xs tabular-nums", active ? "bg-primary/12 text-accent-soft" : "bg-[var(--glass-bg)] text-muted-foreground")}>
                {fmtCount(t.count)}
              </span>
            )}
            {active && (
              <motion.span
                layoutId={reduce ? undefined : `section-tab-${id}`}
                transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
                className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary"
                aria-hidden="true"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ── Sticky data tables ─────────────────────────────────────────────────────── */

/**
 * Scroll container for dense tables: sticky opaque header, hairline rows, tabular numbers,
 * optional sticky first column. Put a plain <table> (or components/ui Table parts) inside.
 * Default density is compact (8 px cell padding, ≈41 px rows) — the desk standard.
 * For long lists add `maxHeight` and render the body with <VirtualRows> (it reads this scroller from context).
 */
export const DataTable = React.forwardRef<
  HTMLDivElement,
  {
    children: React.ReactNode;
    /** e.g. "60vh" or 480. Header sticks inside this box. */
    maxHeight?: number | string;
    stickyFirstCol?: boolean;
    className?: string;
    /** When set, the scroller becomes a focusable labelled region (keyboard scrolling). */
    ariaLabel?: string;
    /** compact (default) ≈ 41 px rows, comfortable ≈ 45 px. */
    density?: "compact" | "comfortable";
  }
>(function DataTable({ children, maxHeight, stickyFirstCol = false, className, ariaLabel, density = "compact" }, forwarded) {
  const innerRef = React.useRef<HTMLDivElement | null>(null);
  const setRef = React.useCallback(
    (el: HTMLDivElement | null) => {
      innerRef.current = el;
      if (typeof forwarded === "function") forwarded(el);
      else if (forwarded) forwarded.current = el;
    },
    [forwarded],
  );
  return (
    <ScrollContainerContext.Provider value={innerRef}>
      <div
        ref={setRef}
        role={ariaLabel ? "region" : undefined}
        aria-label={ariaLabel}
        tabIndex={ariaLabel ? 0 : undefined}
        style={maxHeight != null ? { maxHeight } : undefined}
        className={cn(
          "relative w-full min-w-0 overflow-auto overscroll-x-contain rounded-xl",
          "[&_table]:w-full [&_table]:border-separate [&_table]:border-spacing-0 [&_table]:text-sm [&_table]:tabular-nums",
          // Opaque header (no backdrop blur): rows scrolling under it stay unreadable-free and cheap to paint.
          "[&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-sticky [&_thead_th]:border-b [&_thead_th]:border-[var(--glass-border)] [&_thead_th]:bg-surface-solid",
          // Header row 36px. Default alignment is left, but only for cells that don't ask for right/center: a plain
          // `[&_thead_th]:text-left` out-specified `text-right` on the cell, so numeric headers sat left of their numbers.
          "[&_thead_th]:h-9 [&_thead_th]:px-3 [&_thead_th]:py-1 [&_thead_th]:align-middle [&_thead_th]:text-xs [&_thead_th]:font-medium [&_thead_th]:text-muted-foreground [&_thead_th]:whitespace-nowrap",
          "[&_thead_th:not(.text-right):not(.text-center)]:text-left",
          "[&_tbody_td]:border-b [&_tbody_td]:border-border/50 [&_tbody_td]:px-3",
          density === "compact" ? "[&_tbody_td]:py-2" : "[&_tbody_td]:py-2.5",
          "[&_tbody_tr:last-child_td]:border-b-0 [&_tbody_tr]:transition-colors [&_tbody_tr]:duration-[var(--dur-1)] [&_tbody_tr:hover]:bg-[var(--tile-hover-bg)]",
          stickyFirstCol &&
            "[&_tbody_td:first-child]:sticky [&_tbody_td:first-child]:left-0 [&_tbody_td:first-child]:z-raised [&_tbody_td:first-child]:bg-surface-solid [&_thead_th:first-child]:left-0 [&_thead_th:first-child]:z-sticky-corner",
          className,
        )}
      >
        {children}
      </div>
    </ScrollContainerContext.Provider>
  );
});

export type SortDir = "asc" | "desc";

/** Sortable header cell (a <th> holding a button). Pair with `useTableSort().thProps(key)`. */
export function SortableTh({
  children,
  active,
  dir,
  onSort,
  align = "left",
  className,
  term,
}: {
  children: React.ReactNode;
  active: boolean;
  dir: SortDir;
  onSort: () => void;
  align?: "left" | "right" | "center";
  className?: string;
  /** Glossary (i) next to the header — rendered outside the sort button (no nested buttons). */
  term?: TermKey;
}) {
  const Icon = !active ? ChevronsUpDown : dir === "asc" ? ChevronUp : ChevronDown;
  const name = nodeText(children).trim();
  const state = active ? commonI18n.t(dir === "asc" ? "ds.sortAsc" : "ds.sortDesc") : null;
  return (
    <th
      scope="col"
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      className={cn(align === "right" && "text-right", align === "center" && "text-center", className)}
    >
      {term && align === "right" && <span className="mr-0.5 inline-flex align-middle"><TermTooltip term={term} icon /></span>}
      <button
        type="button"
        onClick={onSort}
        title={state ? (name ? commonI18n.t("ds.sortedBy", { name, state }) : commonI18n.t("ds.sortedNoName", { state })) : name ? commonI18n.t("ds.sortBy", { name }) : commonI18n.t("ds.sort")}
        className={cn(
          "-mx-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 align-middle transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
          active && "text-foreground",
          align === "right" && "flex-row-reverse",
        )}
      >
        {children}
        <Icon className={cn("h-3 w-3", !active && "opacity-50")} aria-hidden="true" />
      </button>
      {term && align !== "right" && <span className="ml-0.5 inline-flex align-middle"><TermTooltip term={term} icon /></span>}
    </th>
  );
}

/** Plain text of a header label (strings inside fragments/spans), for titles like «Сортировать по: Тикер». */
function nodeText(node: React.ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (React.isValidElement(node)) return nodeText((node.props as { children?: React.ReactNode }).children);
  return "";
}

/**
 * Client-side sort state for tables. Empty values always sink to the bottom.
 *   const { rows, thProps } = useTableSort(trades, { pnl: (t) => t.pnl, ticker: (t) => t.ticker }, "pnl");
 *   <SortableTh {...thProps("pnl")} align="right">P&L</SortableTh>
 * Keep `accessors` stable (module constant or useMemo) to avoid re-sorting every render.
 * `firstDir` (optional) — direction applied when a column is first clicked; default "desc".
 * Handy for text columns: `{ name: "asc" }` sorts А→Я on the first click.
 */
export function useTableSort<Row, K extends string>(
  data: readonly Row[],
  accessors: Record<K, (row: Row) => number | string | null | undefined>,
  initialKey: NoInfer<K>,
  initialDir: SortDir = "desc",
  firstDir?: Partial<Record<NoInfer<K>, SortDir>>,
) {
  const [sortKey, setSortKey] = React.useState<K>(initialKey);
  const [sortDir, setSortDir] = React.useState<SortDir>(initialDir);
  const toggle = React.useCallback(
    (k: K) => {
      if (k === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      else { setSortKey(k); setSortDir(firstDir?.[k] ?? "desc"); }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sortKey],
  );
  const get = accessors[sortKey];
  const rows = React.useMemo(() => {
    const arr = [...data];
    arr.sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      const na = va == null || va === "";
      const nb = vb == null || vb === "";
      if (na && nb) return 0;
      if (na) return 1;
      if (nb) return -1;
      const cmp = typeof va === "number" && typeof vb === "number"
        ? va - vb
        : String(va).localeCompare(String(vb), "ru", { numeric: true });
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [data, get, sortDir]);
  const thProps = (k: K) => ({ active: sortKey === k, dir: sortDir, onSort: () => toggle(k) });
  return { rows, sortKey, sortDir, toggle, thProps, setSortKey, setSortDir };
}

/* ── Risk limits ────────────────────────────────────────────────────────────── */

export type LimitTone = "ok" | "warn" | "breach";

/** ok below `warnAt` of the limit, warn from `warnAt`, breach at/over 100%. Uses |used|. */
export function limitTone(used: number | null | undefined, limit: number | null | undefined, warnAt = 0.8): LimitTone {
  if (used == null || limit == null || !Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return "ok";
  const r = Math.abs(used) / limit;
  return r >= 1 ? "breach" : r >= warnAt ? "warn" : "ok";
}

const LIMIT_BAR: Record<LimitTone, string> = { ok: "bg-up", warn: "bg-warn", breach: "bg-down" };
const LIMIT_TEXT: Record<LimitTone, string> = { ok: "text-up", warn: "text-warn", breach: "text-down" };
const LIMIT_WORD_KEY = { ok: "ds.limitOk", warn: "ds.limitWarn", breach: "ds.limitBreach" } as const;
const limitWord = (t: LimitTone) => commonI18n.t(LIMIT_WORD_KEY[t]);

/** Tone of a LimitBar mapped onto the general Tone scale (for Pills etc.). */
export function limitToneToTone(t: LimitTone): Tone {
  return t === "ok" ? "up" : t === "warn" ? "warn" : "down";
}

/**
 * Progress bar for a risk limit (daily loss, open risk, exposure…): used / limit with
 * ok/warn/breach tones, a warn marker and the numbers. The state is also spelled out
 * in words, so it never relies on colour alone.
 */
export function LimitBar({
  label,
  used,
  limit,
  warnAt = 0.8,
  tone,
  format = (n) => fmtCount(n, { maximumFractionDigits: 0 }),
  hint,
  size = "md",
  showValues = true,
  className,
}: {
  label?: React.ReactNode;
  /** Amount consumed (sign ignored: a −$800 day against a $1,000 limit is 80%). */
  used: number | null | undefined;
  limit: number | null | undefined;
  warnAt?: number;
  /** Override the computed tone. */
  tone?: LimitTone;
  format?: (n: number) => string;
  hint?: React.ReactNode;
  size?: "sm" | "md";
  showValues?: boolean;
  className?: string;
}) {
  const hasLimit = limit != null && Number.isFinite(limit) && limit > 0;
  const u = used != null && Number.isFinite(used) ? Math.abs(used) : 0;
  const ratio = hasLimit ? u / (limit as number) : 0;
  const t = tone ?? limitTone(u, limit, warnAt);
  const reduce = useReducedMotion();
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      {(label || showValues) && (
        <div className="flex items-baseline justify-between gap-2 text-xs">
          {label ? <span className="truncate text-muted-foreground">{label}</span> : <span />}
          {showValues && (
            <span className="shrink-0 tabular-nums">
              <span className={cn("font-semibold", hasLimit ? LIMIT_TEXT[t] : "text-foreground")}>{format(u)}</span>
              <span className="text-muted-foreground"> / {hasLimit ? format(limit as number) : "—"}</span>
            </span>
          )}
        </div>
      )}
      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={hasLimit ? (limit as number) : 0}
        aria-valuenow={u}
        aria-valuetext={hasLimit ? commonI18n.t("ds.limitValue", { pct: fmtRate(ratio), state: limitWord(t) }) : commonI18n.t("trading.limitNotSet")}
        aria-label={typeof label === "string" ? label : undefined}
        className={cn(
          "relative w-full overflow-hidden rounded-full bg-[var(--glass-bg)] ring-1 ring-inset ring-[var(--glass-border)]",
          size === "sm" ? "h-1.5" : "h-2",
        )}
      >
        {hasLimit && (
          // Full-width bar slid in from the left (transform, no relayout per frame); the track clips it.
          <motion.div
            className={cn("h-full w-full rounded-full", LIMIT_BAR[t])}
            initial={reduce ? false : { x: "-100%" }}
            animate={{ x: `${Math.min(100, ratio * 100) - 100}%` }}
            transition={{ duration: reduce ? 0 : 0.45, ease: [0.2, 0.8, 0.2, 1] }}
          />
        )}
        {hasLimit && warnAt > 0 && warnAt < 1 && (
          <span aria-hidden="true" className="absolute inset-y-0 w-px bg-foreground/30" style={{ left: `${warnAt * 100}%` }} />
        )}
      </div>
      {(hint || (hasLimit && t !== "ok")) && (
        <div className="flex items-center justify-between gap-2 text-2xs">
          {hint ? <span className="text-muted-foreground">{hint}</span> : <span />}
          {hasLimit && t !== "ok" && <span className={cn("font-medium", LIMIT_TEXT[t])}>{limitWord(t)}</span>}
        </div>
      )}
    </div>
  );
}

/* ── Live feel ──────────────────────────────────────────────────────────────── */

/** "только что" under 45 s, then the UI language's short relative time ("5 мин. назад" / "5 min. ago"). */
function agoText(ts: number): string {
  return Date.now() - ts < 45_000 ? commonI18n.t("time.justNow") : fmtRelative(ts, { style: "short" });
}

/* One shared 5 s clock for every UpdatedAgo on screen (was one setInterval per instance; a dashboard has a dozen).
   Paused while the tab is hidden; catches up on return. */
let agoNow = Date.now();
const agoSubs = new Set<() => void>();
let agoTimer: ReturnType<typeof setInterval> | null = null;
function agoEmit() { agoNow = Date.now(); agoSubs.forEach((f) => f()); }
function agoVisibility() { if (document.visibilityState === "visible") agoEmit(); }
function agoSubscribe(cb: () => void) {
  agoSubs.add(cb);
  if (!agoTimer) {
    agoTimer = setInterval(() => { if (document.visibilityState !== "hidden") agoEmit(); }, 5000);
    document.addEventListener("visibilitychange", agoVisibility);
  }
  return () => {
    agoSubs.delete(cb);
    if (!agoSubs.size && agoTimer) {
      clearInterval(agoTimer);
      agoTimer = null;
      document.removeEventListener("visibilitychange", agoVisibility);
    }
  };
}
function useAgoTick() {
  return React.useSyncExternalStore(agoSubscribe, () => agoNow, () => agoNow);
}

/** "обновлено 5 мин. назад" — pass react-query's `dataUpdatedAt`. Re-renders every 5 s (shared clock). A custom
 *  `prefix` must already be translated. */
export function UpdatedAgo({
  at,
  prefix,
  className,
}: {
  at: number | string | Date | null | undefined;
  prefix?: string;
  className?: string;
}) {
  useAgoTick();
  const ts = at == null ? NaN : at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-2xs text-muted-foreground tabular-nums", className)} title={fmtDate(ts, "shortDateTimeSeconds")}>
      <span className="h-1.5 w-1.5 rounded-full bg-up" aria-hidden="true" />
      {prefix ? `${prefix} ${agoText(ts)}` : commonI18n.t("ds.updatedAgo", { ago: agoText(ts) })}
    </span>
  );
}
