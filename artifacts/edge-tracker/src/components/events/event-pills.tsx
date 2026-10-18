import type { MarketEvent } from "@workspace/api-client-react";
import { Pill, toneOf, toneText } from "@/components/ds";
import { cn } from "@/lib/utils";
import { SESSIONS, displayTags, getSession, reactionMeta, typeMeta, type Session } from "./event-meta";
import { fmtPct } from "@/lib/format";

export function TypePill({ type, className }: { type: string; className?: string }) {
  const m = typeMeta(type);
  return <Pill tone={m.tone} className={className}>{m.label}</Pill>;
}

export function SessionPill({ session, className }: { session: Session | null; className?: string }) {
  if (!session) return null;
  const s = SESSIONS.find((x) => x.value === session)!;
  return (
    <span title={s.hint} className="inline-flex">
      <Pill tone={s.tone} className={cn("px-1.5 text-2xs font-semibold", className)}>{s.label}</Pill>
    </span>
  );
}

export function EventSessionPill({ event, className }: { event: MarketEvent; className?: string }) {
  return <SessionPill session={getSession(event)} className={className} />;
}

export function ReactionPill({ reaction, className }: { reaction: string | null | undefined; className?: string }) {
  const m = reactionMeta(reaction);
  if (!m) return null;
  return <Pill tone={m.tone} className={className}>{m.label}</Pill>;
}

/** Signed % move, coloured + signed (not colour alone). */
export function MoveValue({ value, className }: { value: number | null | undefined; className?: string }) {
  if (value == null) return <span className={cn("text-muted-foreground tabular-nums", className)}>—</span>;
  return <span className={cn("font-semibold tabular-nums", toneText(toneOf(value)), className)}>{fmtPct(value, 1)}</span>;
}

/** Thin magnitude bar for |move| (capped at 20%). */
export function MoveBar({ value, className }: { value: number | null | undefined; className?: string }) {
  if (value == null) return null;
  const w = Math.min(Math.abs(value) / 20, 1) * 100;
  return (
    <span className={cn("block h-1 w-16 overflow-hidden rounded-full bg-[var(--glass-hover-bg)]", className)} aria-hidden="true">
      <span className={cn("block h-full rounded-full", value >= 0 ? "bg-up/70" : "bg-down/70")} style={{ width: `${w}%` }} />
    </span>
  );
}

export function TagChips({ tags, max, className }: { tags?: string | null; max?: number; className?: string }) {
  const list = displayTags(tags);
  if (!list.length) return null;
  const shown = max ? list.slice(0, max) : list;
  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {shown.map((t) => (
        <span key={t} className="rounded-full bg-primary/10 px-2 py-0.5 text-2xs font-medium text-primary">{t}</span>
      ))}
      {max && list.length > max && <span className="px-1 text-2xs text-muted-foreground">+{list.length - max}</span>}
    </div>
  );
}
