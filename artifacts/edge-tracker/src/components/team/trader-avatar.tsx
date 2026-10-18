import { cn } from "@/lib/utils";
import { personInitials } from "@/i18n";
import { avatarTone } from "./utils";

const SIZES = {
  xs: "h-6 w-6 text-2xs",
  sm: "h-8 w-8 text-xs",
  md: "h-10 w-10 text-sm",
  lg: "h-14 w-14 text-lg",
} as const;

/** Initials avatar with a stable per-name tint. Decorative: the name should be rendered next to it. */
export function TraderAvatar({
  name,
  size = "sm",
  className,
  ring,
}: {
  name: string | null | undefined;
  size?: keyof typeof SIZES;
  className?: string;
  ring?: boolean;
}) {
  const isSystem = !name || name === "system";
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-grid shrink-0 select-none place-items-center rounded-full font-semibold tabular-nums",
        SIZES[size],
        isSystem ? "bg-[var(--glass-bg)] text-muted-foreground border border-[var(--field-border)]" : avatarTone(name),
        ring && "ring-2 ring-primary ring-offset-2 ring-offset-background",
        className,
      )}
    >
      {isSystem ? "WS" : personInitials(name)}
    </span>
  );
}
