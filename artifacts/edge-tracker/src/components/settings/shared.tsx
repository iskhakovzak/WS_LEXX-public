import * as React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Tone } from "@/components/ds";
import { commonI18n } from "@/i18n/ns/common";
import { settingsI18n } from "@/i18n/ns/settings";
import { personInitials } from "@/i18n";

/** Role names in the UI language (getters: read at render). Unknown roles: index returns undefined → show the code. */
export const ROLE_LABEL: Readonly<Record<string, string>> = {
  get trader() { return commonI18n.t("roles.trader"); },
  get curator() { return commonI18n.t("roles.curator"); },
  get admin() { return commonI18n.t("roles.admin"); },
};
export const ROLE_TONE: Record<string, Tone> = { trader: "accent", curator: "purple", admin: "warn" };

export const HORIZON_LABEL: Readonly<Record<string, string>> = {
  get intraday() { return commonI18n.t("trading.intraday"); },
  get overnight() { return commonI18n.t("trading.overnight"); },
  get swing() { return commonI18n.t("trading.swing"); },
};

/** "сегодня", "вчера", "5 дн. назад" for YYYY-MM-DD dates (UI language). */
export function fmtDaysAgo(ymd: string | null | undefined): string {
  const t = settingsI18n.t;
  if (!ymd) return t("shared.noTrades");
  const d = new Date(`${ymd.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return "—";
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const days = Math.round((today.getTime() - d.getTime()) / 86400_000);
  if (days <= 0) return t("shared.today");
  if (days === 1) return t("shared.yesterday");
  if (days < 30) return t("shared.daysAgo", { count: days });
  // Longer gaps: a short relative form — the exact date sits in the card hint, and a full date truncates.
  if (days < 365) return t("shared.monthsAgo", { count: Math.floor(days / 30) });
  return t("shared.overYear");
}

/** Round avatar with the person's initials (display name: Latin in EN / UZ when set), tinted by role. */
export function Avatar({ name, role, size = "md" }: { name: string; role?: string; size?: "sm" | "md" | "lg" }) {
  const tone = ROLE_TONE[role ?? "trader"] ?? "accent";
  const toneCls =
    tone === "purple"
      ? "bg-[hsl(var(--chart-5)/0.18)] text-[hsl(var(--chart-5))]"
      : tone === "warn"
        ? "bg-[hsl(var(--chart-3)/0.18)] text-[hsl(var(--chart-3))]"
        : "bg-primary/15 text-primary";
  const sizeCls = size === "lg" ? "h-14 w-14 text-lg" : size === "sm" ? "h-7 w-7 text-2xs" : "h-9 w-9 text-xs";
  return (
    <span aria-hidden="true" className={cn("grid shrink-0 place-items-center rounded-full font-semibold", toneCls, sizeCls)}>
      {personInitials(name)}
    </span>
  );
}

/** A settings row: label + hint on the left, control on the right (stacks on mobile). */
export function SettingRow({
  label,
  hint,
  htmlFor,
  children,
  className,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6", className)}>
      <div className="min-w-0">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-sm font-medium text-foreground">{label}</label>
        ) : (
          <div className="text-sm font-medium text-foreground">{label}</div>
        )}
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">{children}</div>
    </div>
  );
}

/** Inline error with retry, sized for panels. */
export function InlineError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-down/10 px-3 py-2 text-sm text-down">
      <span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" /> {message}</span>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry} className="gap-1.5">
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> {commonI18n.t("actions.retry")}
        </Button>
      )}
    </div>
  );
}

/** Note/callout block (info or warning). */
export function Callout({ tone = "neutral", icon: Icon, children, className }: {
  tone?: "neutral" | "warn" | "down" | "up";
  icon?: React.ElementType;
  children: React.ReactNode;
  className?: string;
}) {
  const cls =
    tone === "warn"
      ? "bg-[hsl(var(--chart-3)/0.12)] text-foreground"
      : tone === "down"
        ? "bg-down/10 text-foreground"
        : tone === "up"
          ? "bg-up/10 text-foreground"
          : "bg-[var(--glass-bg)] text-muted-foreground";
  const iconCls =
    tone === "warn" ? "text-[hsl(var(--chart-3))]" : tone === "down" ? "text-down" : tone === "up" ? "text-up" : "text-muted-foreground";
  return (
    <div className={cn("flex gap-2.5 rounded-xl px-3 py-2.5 text-xs leading-relaxed", cls, className)}>
      {Icon && <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", iconCls)} aria-hidden="true" />}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** True when the keyboard event target is a text field (so global shortcuts should not fire). */
export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}
