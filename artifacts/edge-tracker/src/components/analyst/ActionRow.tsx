/**
 * Small building blocks shared by «Сегодня до открытия», the actions table and the ticker sheet.
 */
import * as React from "react";
import { Link } from "wouter";
import {
  ArrowRight, BookmarkCheck, BookmarkPlus, Briefcase, Building2, CalendarPlus, CalendarCheck, ExternalLink, Hash, History,
  Lightbulb, Loader2, MoreHorizontal, Repeat,
} from "lucide-react";
import { Delta, Pill } from "@/components/ds";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import type { ReactionAgg } from "./api";
import { REACTION_MIN_N } from "./rows";
import { KIND_META, num, ptChangePct, upsidePct, type FeedAction, type OpenPosition } from "./lib";
import { fmtPct, fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { analystI18n } from "@/i18n/ns/analyst";
import { rich } from "@/i18n/rich";

export function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-sm bg-primary/25 px-0.5 text-foreground">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

/** Horizon code → lower-case label in the UI language (common trading words, read at access time). */
export const HORIZON_LABEL = {} as Record<OpenPosition["horizon"], string>;
for (const k of ["intraday", "overnight", "swing"] as const) {
  Object.defineProperty(HORIZON_LABEL, k, { get: () => commonI18n.t(`trading.${k}`).toLowerCase(), enumerable: true });
}

export function KindPill({ kind, className }: { kind: FeedAction["action"]; className?: string }) {
  const m = KIND_META[kind] ?? KIND_META.other;
  return (
    <Pill tone={m.tone} dot={m.tone !== "neutral"} className={cn("text-2xs", className)}>
      {m.short}
    </Pill>
  );
}

export function GradeChange({ from, to, className }: { from: string | null; to: string | null; className?: string }) {
  if (!from && !to) return null;
  const changed = from && to && from !== to;
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1 text-xs", className)} title={changed ? `${from} → ${to}` : (to ?? from ?? "")}>
      {changed ? (
        <>
          <span className="truncate text-muted-foreground">{from}</span>
          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate font-medium text-foreground">{to}</span>
        </>
      ) : (
        <span className="truncate text-foreground">{to ?? from}</span>
      )}
    </span>
  );
}

/** Target change. Renders nothing when the action has no target (no «PT —» noise). */
export function TargetChange({ action, price, showUpside = true }: { action: FeedAction; price?: number | null; showUpside?: boolean }) {
  const to = num(action.priceTarget);
  const from = num(action.priceTargetFrom);
  const chg = ptChangePct(action);
  const up = showUpside ? upsidePct(action, price) : null;
  if (to == null && from == null) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs tabular-nums">
      {from != null && to != null && from !== to ? (
        <>
          <span className="text-muted-foreground">{fmtUsd(from, { decimals: "trim" })}</span>
          <ArrowRight className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
          <span className="font-medium text-foreground">{fmtUsd(to, { decimals: "trim" })}</span>
        </>
      ) : (
        <span className="font-medium text-foreground">{fmtUsd(to ?? from, { decimals: "trim" })}</span>
      )}
      {chg != null && chg !== 0 && <Delta value={chg} suffix="%" precision={0} showIcon={false} bare />}
      {up != null && (
        <span className="text-muted-foreground" title={analystI18n.t("row.upsideTitle")}>
          {rich(analystI18n.t("row.upside", { value: "{value}" }), { value: <span className={cn("font-medium", up >= 0 ? "text-up" : "text-down")}>{fmtPct(up, 0)}</span> })}
        </span>
      )}
    </span>
  );
}

/** Icons for «позиция команды», «в вотчлисте», «я торговал». Each has a text label for screen readers. */
export function Marks({ held, watched, traded, className }: { held: OpenPosition[]; watched: boolean; traded: number; className?: string }) {
  const { t } = analystI18n.useT();
  if (!held.length && !watched && !traded) return null;
  const carry = held.find((h) => h.horizon !== "intraday");
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1", className)}>
      {held.length > 0 && (
        <span title={carry ? t("row.heldTitleHz", { horizon: HORIZON_LABEL[carry.horizon] }) : t("row.heldTitle")} className="inline-flex text-warn">
          <Briefcase className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="sr-only">{t("row.heldSr")}</span>
        </span>
      )}
      {watched && (
        <span title={t("row.watchTitle")} className="inline-flex text-primary">
          <BookmarkCheck className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="sr-only">{t("row.watchSr")}</span>
        </span>
      )}
      {traded > 0 && (
        <span title={t("row.tradedTitle", { count: traded })} className="inline-flex items-center gap-0.5 text-2xs font-medium text-muted-foreground">
          <Repeat className="h-3 w-3" aria-hidden="true" />
          {traded}
          <span className="sr-only">{t("row.tradedSr")}</span>
        </span>
      )}
    </span>
  );
}

/** Historical average reaction: «+2.4% · 6» (day move, number of events). */
export function ReactionChip({ agg, compact = false }: { agg: ReactionAgg | null; compact?: boolean }) {
  if (!agg || agg.n < REACTION_MIN_N || agg.avgDay == null) return <span className="text-xs text-muted-foreground">—</span>;
  const hit = agg.hitRate != null ? Math.round(agg.hitRate * 100) : null;
  const title = analystI18n.t("row.reactionTitle", { day: fmtPct(agg.avgDay, 1), gap: fmtPct(agg.avgGap, 1), hit: hit ?? "—", count: agg.n });
  return (
    <span className="inline-flex flex-col items-end leading-tight" title={title}>
      <Delta value={agg.avgDay} suffix="%" bare showIcon={false} />
      {!compact && (
        <span className="text-2xs tabular-nums text-muted-foreground">
          {hit != null ? `${hit}% · ` : ""}n={agg.n}
        </span>
      )}
    </span>
  );
}

const ICON_BTN =
  "grid h-8 w-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--glass-hover-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

export type RowActionsProps = {
  action: FeedAction;
  watched: boolean;
  inPlan: boolean;
  addingWatch: boolean;
  addingPlan: boolean;
  canEdit: boolean;
  onAddWatch: () => void;
  onAddPlan: () => void;
  onOpen?: () => void;
  onFilterFirm?: () => void;
  onFilterTicker?: () => void;
  className?: string;
};

/** Watchlist · plan · idea · more. Used in table rows (hover-reveal) and premarket cards. */
export function RowActions({
  action: a, watched, inPlan, addingWatch, addingPlan, canEdit, onAddWatch, onAddPlan, onOpen, onFilterFirm, onFilterTicker, className,
}: RowActionsProps) {
  const { t } = analystI18n.useT();
  return (
    <div className={cn("flex shrink-0 items-center gap-0.5", className)}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onAddWatch(); }}
        disabled={!canEdit || watched || addingWatch}
        aria-label={watched ? t("row.inWatchAria", { ticker: a.ticker }) : t("row.addWatchAria", { ticker: a.ticker })}
        title={watched ? t("row.inWatchTitle") : !canEdit ? t("row.noRights") : t("row.addWatchTitle")}
        className={ICON_BTN}
      >
        {addingWatch ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          : watched ? <BookmarkCheck className="h-4 w-4 text-primary" aria-hidden="true" />
          : <BookmarkPlus className="h-4 w-4" aria-hidden="true" />}
      </button>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onAddPlan(); }}
        disabled={!canEdit || inPlan || addingPlan}
        aria-label={inPlan ? t("row.inPlanAria", { ticker: a.ticker }) : t("row.addPlanAria", { ticker: a.ticker })}
        title={inPlan ? t("row.inPlanTitle") : !canEdit ? t("row.noRights") : t("row.addPlanTitle")}
        className={ICON_BTN}
      >
        {addingPlan ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          : inPlan ? <CalendarCheck className="h-4 w-4 text-primary" aria-hidden="true" />
          : <CalendarPlus className="h-4 w-4" aria-hidden="true" />}
      </button>
      <Link
        href={links.newIdea(a.ticker)}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
        aria-label={t("row.ideaAria", { ticker: a.ticker })}
        title={t("row.idea")}
        className={ICON_BTN}
      >
        <Lightbulb className="h-4 w-4" aria-hidden="true" />
      </Link>
      {(onOpen || onFilterFirm || onFilterTicker || a.sourceUrl) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              onClick={(e) => e.stopPropagation()}
              aria-label={t("row.moreAria", { ticker: a.ticker, firm: a.firm })}
              className={cn(ICON_BTN, "data-[state=open]:bg-[var(--glass-hover-bg)]")}
            >
              <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60" onClick={(e) => e.stopPropagation()}>
            {onOpen && (
              <DropdownMenuItem onSelect={onOpen}>
                <History className="h-4 w-4" aria-hidden="true" /> {t("row.history", { ticker: a.ticker })}
              </DropdownMenuItem>
            )}
            {onFilterTicker && (
              <DropdownMenuItem onSelect={onFilterTicker}>
                <Hash className="h-4 w-4" aria-hidden="true" /> {t("row.only", { value: a.ticker })}
              </DropdownMenuItem>
            )}
            {onFilterFirm && (
              <DropdownMenuItem onSelect={onFilterFirm}>
                <Building2 className="h-4 w-4" aria-hidden="true" /> {t("row.only", { value: a.firm })}
              </DropdownMenuItem>
            )}
            {a.sourceUrl && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <a href={a.sourceUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-4 w-4" aria-hidden="true" /> {t("row.source", { source: a.source })}
                  </a>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
