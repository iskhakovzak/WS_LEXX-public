import { memo, type ReactNode } from "react";
import { Star, StickyNote } from "lucide-react";
import { Pill, toneOf } from "@/components/ds";
import { cn } from "@/lib/utils";
import { CATEGORY_META, HORIZONS, HORIZON_META, fitWord, type Horizon, type HorizonFit, type LibIndicator } from "./library";
import { IndicatorSpark } from "./IndicatorSpark";
import type { IndicatorStats } from "./stats";
import { indicatorsI18n } from "@/i18n/ns/indicators";
import { commonI18n } from "@/i18n/ns/common";
import { fmtR } from "@/lib/format";

export function Highlight({ text, q }: { text: string; q: string }) {
  const query = q.trim();
  if (!query) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded-sm bg-primary/25 px-0.5 text-foreground">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

export function FitMeter({ value, active }: { value: number; active?: boolean }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden="true">
      {[1, 2, 3].map((i) => (
        <span
          key={i}
          className={cn(
            "h-1.5 w-2.5 rounded-full",
            i <= value ? (active ? "bg-primary" : "bg-foreground/50") : "bg-[var(--glass-hover-bg)]",
          )}
        />
      ))}
    </span>
  );
}

export function HorizonFitRow({ fit, focus, size = "sm" }: { fit: HorizonFit; focus?: Horizon | "all"; size?: "sm" | "md" }) {
  return (
    <div className={cn("flex flex-wrap items-center", size === "sm" ? "gap-x-3 gap-y-1 text-xs" : "gap-x-5 gap-y-2 text-xs")}>
      {HORIZONS.map((h) => (
        <span
          key={h}
          className={cn("inline-flex items-center gap-1.5", focus === h ? "text-foreground" : "text-muted-foreground")}
          title={`${HORIZON_META[h].label}: ${fitWord(fit[h])}`}
        >
          {HORIZON_META[h].label}
          <FitMeter value={fit[h]} active={focus === h || (focus === "all" && fit[h] === 3)} />
          <span className="sr-only">{fitWord(fit[h])}</span>
        </span>
      ))}
    </div>
  );
}

export function StatsLine({ stats, loading }: { stats: IndicatorStats; loading?: boolean }): ReactNode {
  if (loading) return <span className="h-5 w-32 animate-pulse rounded-full bg-[var(--glass-hover-bg)]" aria-label={indicatorsI18n.t("card.statsLoading")} />;
  // Audit P2: an empty "no trades with this tag" line on every card is noise — show nothing until there is data.
  if (stats.count === 0) return <span aria-hidden="true" />;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Pill>{commonI18n.t("units.tradesShort", { count: stats.count })}</Pill>
      <Pill tone={stats.winRate >= 50 ? "up" : "down"}>WR {stats.winRate}%</Pill>
      {stats.avgR != null && (
        <Pill tone={toneOf(stats.avgR)}>{fmtR(stats.avgR)}</Pill>
      )}
    </span>
  );
}

export const IndicatorCard = memo(function IndicatorCard({
  ind, stats, statsLoading, favorite, hasNote, query, horizon, index, onOpen, onToggleFavorite,
}: {
  ind: LibIndicator;
  stats: IndicatorStats;
  statsLoading: boolean;
  favorite: boolean;
  hasNote: boolean;
  query: string;
  horizon: Horizon | "all";
  index: number;
  onOpen: (id: string) => void;
  onToggleFavorite: (id: string) => void;
}) {
  const { t } = indicatorsI18n.useT();
  const cat = CATEGORY_META[ind.category];
  return (
    <article className={cn("group glass-panel lift relative h-full rounded-2xl", favorite && "ring-1 ring-primary/40")}>
      <button
        type="button"
        data-card-index={index}
        data-card-id={ind.id}
        onClick={() => onOpen(ind.id)}
        className="flex h-full w-full flex-col gap-3 rounded-2xl p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t("card.open", { short: ind.shortName, name: ind.name })}
      >
        <div className="flex min-w-0 items-start gap-2 pr-9">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-base font-semibold tracking-tight text-foreground">
                <Highlight text={ind.shortName} q={query} />
              </span>
              <Pill tone={cat.tone}>{cat.label}</Pill>
              {hasNote && <StickyNote className="h-3.5 w-3.5 text-muted-foreground" aria-label={t("card.hasNote")} />}
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              <Highlight text={ind.name} q={query} />
            </p>
          </div>
        </div>

        <div className="rounded-xl bg-[var(--glass-bg)] px-2 py-1.5">
          <IndicatorSpark id={ind.id} kind={ind.spark} />
        </div>

        <p className="line-clamp-2 text-sm text-foreground/90">{ind.summary}</p>

        <HorizonFitRow fit={ind.horizons} focus={horizon} />

        <div className="mt-auto flex min-h-6 items-center justify-between gap-2 border-t border-border/60 pt-3">
          <StatsLine stats={stats} loading={statsLoading} />
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums" title={t("card.strengthTitle")}>
            {t("card.strength", { value: ind.strength })}
          </span>
        </div>
      </button>

      <button
        type="button"
        onClick={() => onToggleFavorite(ind.id)}
        aria-pressed={favorite}
        aria-label={favorite ? t("card.removeFromSet", { short: ind.shortName }) : t("card.addToSet", { short: ind.shortName })}
        title={favorite ? t("card.removeTitle") : t("card.addTitle")}
        className={cn(
          "absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-full transition-[opacity,color,background-color] duration-200",
          "hover:bg-[var(--glass-hover-bg)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          favorite
            ? "text-[hsl(var(--chart-3))]"
            : "text-muted-foreground [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100",
        )}
      >
        <Star className={cn("h-4 w-4", favorite && "fill-current")} />
      </button>
    </article>
  );
});
