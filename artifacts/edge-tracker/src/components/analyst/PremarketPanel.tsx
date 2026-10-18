/**
 * «Сегодня до открытия»: what came out since the previous close, grouped by ticker and sorted by importance.
 * Each card answers: what happened, why it matters to me, how the stock usually reacts, what to do (watch / plan / idea).
 */
import * as React from "react";
import { Sunrise } from "lucide-react";
import { Delta, EmptyState, Panel, Pill, TermTooltip } from "@/components/ds";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { GradeChange, KindPill, Marks, RowActions, TargetChange } from "./ActionRow";
import { REACTION_KIND_LABEL, REACTION_MIN_N, type Row } from "./rows";
import { gapOf, nyTime, shortDay, SESSION_LABEL, sessionOf } from "./lib";
import { fmtPct } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { analystI18n } from "@/i18n/ns/analyst";
import { rich } from "@/i18n/rich";

type Group = { ticker: string; lead: Row; others: Row[]; score: number };

function groupByTicker(rows: Row[]): Group[] {
  const m = new Map<string, Row[]>();
  for (const r of rows) {
    const arr = m.get(r.a.ticker) ?? [];
    arr.push(r);
    m.set(r.a.ticker, arr);
  }
  const out: Group[] = [];
  for (const [ticker, arr] of m) {
    arr.sort((x, y) => y.score - x.score || (y.a.gradedAt ?? "").localeCompare(x.a.gradedAt ?? ""));
    const lead = arr[0];
    // Several firms on the same name the same morning is itself a signal.
    const extraRating = arr.slice(1).filter((r) => r.a.action === "upgrade" || r.a.action === "downgrade").length;
    out.push({ ticker, lead, others: arr.slice(1), score: lead.score + extraRating * 15 + (arr.length - 1) * 5 });
  }
  return out.sort((a, b) => b.score - a.score);
}

const LIMIT = 8;

export type PremarketPanelProps = {
  rows: Row[];
  isLoading: boolean;
  /** Set when the window is quiet and the panel shows the previous session instead. */
  fallbackDay: string | null;
  windowLabel: string;
  canEdit: boolean;
  inPlan: (t: string) => boolean;
  addingWatch: string | null;
  addingPlan: string | null;
  onOpen: (ticker: string) => void;
  onAddWatch: (r: Row) => void;
  onAddPlan: (r: Row) => void;
  className?: string;
};

export function PremarketPanel({
  rows, isLoading, fallbackDay, windowLabel, canEdit, inPlan, addingWatch, addingPlan, onOpen, onAddWatch, onAddPlan, className,
}: PremarketPanelProps) {
  const [all, setAll] = React.useState(false);
  const groups = React.useMemo(() => groupByTicker(rows), [rows]);
  const shown = all ? groups.slice(0, 40) : groups.slice(0, LIMIT);
  const ratingCount = rows.filter((r) => r.a.action === "upgrade" || r.a.action === "downgrade").length;

  return (
    <Panel
      fill
      className={className}
      icon={Sunrise}
      title={
        <span className="inline-flex items-center gap-1.5">
          {analystI18n.t("premarket.title")}
          <TermTooltip term="analystScore" icon />
        </span>
      }
      description={
        fallbackDay
          ? analystI18n.t("premarket.fallback", { date: shortDay(fallbackDay) })
          : analystI18n.t("premarket.summary", { window: windowLabel, tickers: commonI18n.t("units.tickers", { count: groups.length }), count: ratingCount })
      }
      bodyClassName="min-h-[320px]"
    >
      {isLoading ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-[76px] w-full rounded-xl" />)}
        </div>
      ) : groups.length === 0 ? (
        <EmptyState
          compact
          icon={Sunrise}
          title={analystI18n.t("premarket.emptyTitle")}
          description={analystI18n.t("premarket.emptyText")}
        />
      ) : (
        <>
          <ol className="flex flex-col gap-1.5" aria-label={analystI18n.t("premarket.listAria")}>
            {shown.map((g, i) => (
              <PremarketCard
                key={g.ticker}
                rank={i + 1}
                group={g}
                canEdit={canEdit}
                inPlan={inPlan(g.ticker)}
                addingWatch={addingWatch === g.ticker}
                addingPlan={addingPlan === g.ticker}
                onOpen={() => onOpen(g.ticker)}
                onAddWatch={() => onAddWatch(g.lead)}
                onAddPlan={() => onAddPlan(g.lead)}
              />
            ))}
          </ol>
          {groups.length > LIMIT && (
            <Button variant="ghost" size="sm" className="mt-2 self-start" onClick={() => setAll((v) => !v)}>
              {all ? commonI18n.t("actions.collapse") : commonI18n.t("actions.showAllCount", { count: groups.length })}
            </Button>
          )}
        </>
      )}
    </Panel>
  );
}

function PremarketCard({
  rank, group: g, canEdit, inPlan, addingWatch, addingPlan, onOpen, onAddWatch, onAddPlan,
}: {
  rank: number;
  group: Group;
  canEdit: boolean;
  inPlan: boolean;
  addingWatch: boolean;
  addingPlan: boolean;
  onOpen: () => void;
  onAddWatch: () => void;
  onAddPlan: () => void;
}) {
  const r = g.lead;
  const a = r.a;
  const q = r.quote;
  const gap = gapOf(q);
  const session = sessionOf(a.gradedAt);
  const reasons = r.reasons.filter((x) => x.key !== "gap");
  const hasReaction = !!r.reaction && r.reaction.n >= REACTION_MIN_N && r.reaction.avgDay != null && r.reactionKind;
  const otherFirms = Array.from(new Set(g.others.map((o) => o.a.firm)));
  return (
    <li
      className={cn(
        "group flex items-start gap-3 rounded-xl px-2.5 py-2 transition-colors hover:bg-[var(--tile-hover-bg)]",
        r.held.length > 0 && "ring-1 ring-inset ring-warn/30",
      )}
    >
      <span className="w-4 shrink-0 pt-0.5 text-right text-xs font-medium tabular-nums text-muted-foreground" aria-hidden="true">{rank}</span>
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 flex-col gap-1 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={analystI18n.t("premarket.openAria", { ticker: a.ticker })}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="text-sm font-semibold tracking-tight text-foreground">{a.ticker}</span>
          <Marks held={r.held} watched={r.watched} traded={r.traded} />
          <KindPill kind={a.action} />
          <span className="min-w-0 truncate text-xs text-foreground" title={a.firm}>{a.firm}</span>
          <span className="ml-auto shrink-0 text-2xs tabular-nums text-muted-foreground" title={session ? analystI18n.t("table.sessionEt", { session: SESSION_LABEL[session] }) : undefined}>
            {nyTime(a.gradedAt)}
          </span>
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5">
          <GradeChange from={a.fromGrade} to={a.toGrade} className="max-w-[16rem]" />
          <TargetChange action={a} price={q?.price} />
        </span>
        {(reasons.length > 0 || otherFirms.length > 0) && (
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            {reasons.map((x) => <Pill key={x.key} tone={x.tone} className="text-2xs">{x.label}</Pill>)}
            {otherFirms.length > 0 && (
              <span className="truncate text-2xs text-muted-foreground" title={otherFirms.join(", ")}>
                {analystI18n.t("premarket.otherFirms", { count: otherFirms.length, list: `${otherFirms.slice(0, 2).join(", ")}${otherFirms.length > 2 ? "…" : ""}` })}
              </span>
            )}
          </span>
        )}
        {hasReaction && (
          <span className="text-xs text-muted-foreground">
            {rich(analystI18n.t("premarket.usually", { kind: REACTION_KIND_LABEL[r.reactionKind!], day: "{day}" }), {
              day: <span className={cn("font-medium tabular-nums", (r.reaction!.avgDay ?? 0) >= 0 ? "text-up" : "text-down")}>{fmtPct(r.reaction!.avgDay, 1)}</span>,
            })}
            {r.reaction!.avgGap != null && rich(analystI18n.t("premarket.usuallyGap", { gap: "{gap}" }), { gap: <span className="tabular-nums text-foreground">{fmtPct(r.reaction!.avgGap, 1)}</span> })}
            {r.reaction!.hitRate != null && analystI18n.t("premarket.usuallyHit", { pct: Math.round(r.reaction!.hitRate * 100) })}
            <span className="tabular-nums"> · n={r.reaction!.n}</span>
          </span>
        )}
      </button>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <div className="flex min-h-5 items-center gap-2 text-xs tabular-nums">
          {gap != null && (
            <span className="inline-flex items-center gap-1" title={analystI18n.t("premarket.gapTitle")}>
              <span className="text-muted-foreground">{analystI18n.t("premarket.gap")}</span>
              <Delta value={gap} suffix="%" bare showIcon={false} />
            </span>
          )}
          {q?.relativeVolume != null && Number.isFinite(q.relativeVolume) && (
            <span className={cn(q.relativeVolume >= 2 ? "font-medium text-foreground" : "text-muted-foreground")} title={analystI18n.t("premarket.rvolTitle")}>
              ×{q.relativeVolume.toFixed(1)}
            </span>
          )}
        </div>
        <RowActions
          action={a}
          watched={r.watched}
          inPlan={inPlan}
          addingWatch={addingWatch}
          addingPlan={addingPlan}
          canEdit={canEdit}
          onAddWatch={onAddWatch}
          onAddPlan={onAddPlan}
        />
      </div>
    </li>
  );
}
