
import { ArrowDownRight, ArrowUpRight, Flag, History } from "lucide-react";
import { EmptyState, Pill } from "@/components/ds";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { HistoryEntry, Tier } from "./use-scaling";
import { tierName } from "./format";
import { fmtDate } from "@/lib/format";
import { scalingI18n } from "@/i18n/ns/scaling";
import { personName } from "@/i18n";

const META = {
  promote: { icon: ArrowUpRight, cls: "bg-up/15 text-up" },
  demote: { icon: ArrowDownRight, cls: "bg-down/15 text-down" },
  assign: { icon: Flag, cls: "bg-primary/15 text-primary" },
} as const;

export function HistoryTimeline({
  entries,
  tiers,
  loading,
  showTrader = false,
  limit,
  className,
}: {
  entries: HistoryEntry[];
  tiers: Tier[];
  loading?: boolean;
  showTrader?: boolean;
  limit?: number;
  className?: string;
}) {
  const { t } = scalingI18n.useT();
  if (loading) {
    return (
      <div className={cn("flex flex-col gap-2", className)}>
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 rounded-xl" />)}
      </div>
    );
  }
  const list = limit ? entries.slice(0, limit) : entries;
  if (!list.length) {
    return <EmptyState icon={History} title={t("history.emptyTitle")} description={t("history.emptyHint")} className="py-8" />;
  }
  return (
    <ol className={cn("relative flex flex-col gap-3 border-l border-[var(--glass-border)] pl-5", className)}>
      {list.map((h) => {
        const kind: keyof typeof META = h.action === "promote" || h.action === "demote" ? h.action : "assign";
        const m = META[kind];
        const Icon = m.icon;
        return (
          <li key={h.id} className="relative">
            <span className={cn("absolute -left-[31px] top-0.5 grid h-6 w-6 place-items-center rounded-full", m.cls)} aria-hidden="true">
              <Icon className="h-3.5 w-3.5" />
            </span>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
              {showTrader && <span className="font-semibold text-foreground">{personName(h.trader)}</span>}
              <span className="text-foreground">{t(`history.${kind}`)}:</span>
              <span className="text-muted-foreground">{tierName(tiers, h.fromTier)}</span>
              <span className="text-muted-foreground" aria-hidden="true">→</span>
              <Pill tone="purple">{tierName(tiers, h.toTier)}</Pill>
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 text-2xs text-muted-foreground">
              <span>{fmtDate(h.createdAt, "dateTime")}</span>
              <span>{personName(h.actor)}</span>
              {h.proposalId != null && <span>{t("history.proposalRef", { id: h.proposalId })}</span>}
            </div>
            {h.comment && <p className="mt-1 text-xs text-muted-foreground/90">{h.comment}</p>}
          </li>
        );
      })}
    </ol>
  );
}
