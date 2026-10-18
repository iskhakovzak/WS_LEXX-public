import { cn } from "@/lib/utils";
import type { LevelPlan } from "./model";
import { fmtPrice } from "@/lib/format";
import { ideasI18n } from "@/i18n/ns/ideas";

/**
 * Risk → reward ladder: stop on the left, targets on the right (direction-agnostic), entry zone in between,
 * live price as a dot. Communicates the plan geometry and where price is now at a glance.
 */
export function LevelsBar({
  plan,
  price,
  size = "sm",
  className,
}: {
  plan: LevelPlan;
  price?: number | null;
  size?: "sm" | "lg";
  className?: string;
}) {
  const { stop, entry, targets, isShort } = plan;
  if (stop == null || entry == null || !targets.length || plan.riskPerShare == null || plan.rewardPerShare == null) return null;
  const far = targets[targets.length - 1];
  // Favorable distance from stop, normalised so stop = 0 and farthest target = 1.
  const span = Math.abs(far - stop) || 1;
  const pos = (v: number) => (isShort ? stop - v : v - stop) / span;
  const pct = (v: number) => `${Math.min(100, Math.max(0, pos(v) * 100))}%`;
  const entryLo = plan.entryLow ?? entry;
  const entryHi = plan.entryHigh ?? entry;
  const zoneA = Math.min(pos(entryLo), pos(entryHi));
  const zoneB = Math.max(pos(entryLo), pos(entryHi));
  const pricePos = price != null ? pos(price) : null;
  const lg = size === "lg";

  return (
    <div className={cn("w-full", className)}>
      <div className={cn("relative w-full", lg ? "h-3" : "h-1.5")} role="img"
        aria-label={price != null
          ? ideasI18n.t("levelsAriaPrice", { stop: fmtPrice(stop), entry: fmtPrice(entry), target: fmtPrice(targets[0]), price: fmtPrice(price) })
          : ideasI18n.t("levelsAria", { stop: fmtPrice(stop), entry: fmtPrice(entry), target: fmtPrice(targets[0]) })}>
        <div className="absolute inset-y-0 left-0 rounded-l-full bg-down/30" style={{ width: pct(entry) }} />
        <div className="absolute inset-y-0 right-0 rounded-r-full bg-up/30" style={{ left: pct(entry) }} />
        <div className="absolute inset-y-0 bg-foreground/25" style={{ left: `${zoneA * 100}%`, width: `${Math.max(0.8, (zoneB - zoneA) * 100)}%` }} />
        {targets.map((t, i) => (
          <span key={i} className="absolute inset-y-[-2px] w-0.5 rounded-full bg-up" style={{ left: `min(${pct(t)}, calc(100% - 2px))` }} aria-hidden="true" />
        ))}
        {pricePos != null && (
          <span
            className={cn(
              "absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-primary shadow",
              lg ? "h-4 w-4" : "h-2.5 w-2.5",
              (pricePos < 0 || pricePos > 1) && "ring-2 ring-primary/40",
            )}
            // Kept inside the bar at the ends (a price past the target / stop sat half outside the card edge).
            style={{ left: `clamp(${lg ? 8 : 5}px, ${Math.min(100, Math.max(0, pricePos * 100))}%, calc(100% - ${lg ? 8 : 5}px))` }}
            aria-hidden="true"
          />
        )}
      </div>
      {lg && (
        <div className="relative mt-2 h-4 text-2xs tabular-nums text-muted-foreground">
          <span className="absolute left-0 text-down">{fmtPrice(stop)}</span>
          {pos(entry) > 0.16 && pos(entry) < 0.84 && (
            <span className="absolute -translate-x-1/2 text-foreground" style={{ left: pct(entry) }}>{fmtPrice(entry)}</span>
          )}
          <span className="absolute right-0 text-up">{fmtPrice(far)}</span>
        </div>
      )}
    </div>
  );
}
