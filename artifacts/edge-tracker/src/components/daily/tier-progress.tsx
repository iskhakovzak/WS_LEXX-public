import { useId, useState } from "react";
import { Link } from "wouter";
import { ChevronDown, ChevronRight, TrendingUp } from "lucide-react";
import type { TierProgress } from "@/lib/daily/types";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import { dailyI18n } from "@/i18n/ns/daily";
import { fmtMetric, fmtTarget, metricLabel, tierTitle } from "./daily-model";
import { StatusIcon } from "./contract-line";

/**
 * «До Джуна: 3 из 5» — compact, where the trader looks every day; the criteria (actual / target) open in place.
 * The full ladder stays on /scaling.
 */
export function TierProgressChip({ progress }: { progress: TierProgress | null | undefined }) {
  const { t } = dailyI18n.useT();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const title = tierTitle(progress);
  if (!progress || !title) return null;
  const pct = progress.total > 0 ? Math.round((progress.met / progress.total) * 100) : 0;
  const canOpen = progress.items.length > 0;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!canOpen}
        aria-expanded={canOpen ? open : undefined}
        aria-controls={canOpen ? listId : undefined}
        className="group inline-flex min-h-8 min-w-0 items-center gap-2 self-start rounded-lg px-1.5 text-sm font-medium transition-colors hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent"
      >
        <TrendingUp className="h-4 w-4 shrink-0 text-up" aria-hidden="true" />
        <span className="truncate tabular-nums">{title}</span>
        {progress.nextTier && (
          <span className="h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-foreground/10" aria-hidden="true">
            <span className="block h-full rounded-full bg-up" style={{ width: `${pct}%` }} />
          </span>
        )}
        {canOpen && <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden="true" />}
      </button>
      {open && canOpen && (
        <div id={listId} className="flex flex-col gap-1 rounded-xl bg-foreground/[0.04] p-2">
          <ul className="flex flex-col gap-1" aria-label={t("tier.criteriaAria")}>
            {progress.items.map((i) => (
              <li key={i.metric} className="flex min-w-0 items-center gap-2 text-xs">
                <StatusIcon status={i.ok ? "kept" : i.actual == null ? "unknown" : "broken"} />
                <span className="min-w-0 flex-1 truncate">{metricLabel(i)}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {i.target != null ? t("tier.of", { actual: fmtMetric(i.metric, i.actual), target: fmtTarget(i.metric, i.target) }) : fmtMetric(i.metric, i.actual)}
                </span>
              </li>
            ))}
          </ul>
          <Link href={links.scaling()} className="inline-flex items-center gap-0.5 self-start px-0.5 text-xs font-medium text-muted-foreground hover:text-foreground">
            {t("tier.ladder")}
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </div>
      )}
    </div>
  );
}
