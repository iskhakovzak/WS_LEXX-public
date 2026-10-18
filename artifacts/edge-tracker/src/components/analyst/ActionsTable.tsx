/**
 * Compact, virtualized table of analyst actions (thousands of rows → only the visible ~25 are in the DOM).
 * Fixed row height so J/K keyboard navigation can scroll to any index without measuring.
 */
import * as React from "react";
import { DataTable, Delta, SortableTh, TermTooltip, VirtualRows, type SortDir } from "@/components/ds";
import { cn } from "@/lib/utils";
import { GradeChange, Highlight, KindPill, Marks, ReactionChip, RowActions, TargetChange } from "./ActionRow";
import type { Row } from "./rows";
import { dayTitle, gapOf, nyKey, nyTime, SESSION_LABEL, sessionOf, WEIGHT_MIN_N, type SortKey } from "./lib";
import { commonI18n } from "@/i18n/ns/common";
import { analystI18n } from "@/i18n/ns/analyst";

export const ROW_H = 52;
const HEAD_H = 33;
const COLS = 8;

export type ActionsTableProps = {
  rows: Row[];
  query: string;
  today: string;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
  focusedIndex: number;
  canEdit: boolean;
  inPlan: (t: string) => boolean;
  addingWatch: string | null;
  addingPlan: string | null;
  onOpen: (r: Row) => void;
  onAddWatch: (r: Row) => void;
  onAddPlan: (r: Row) => void;
  onFilterFirm: (firm: string) => void;
  onFilterTicker: (ticker: string) => void;
  maxHeight?: string;
};

export const ActionsTable = React.forwardRef<HTMLDivElement, ActionsTableProps>(function ActionsTable(
  {
    rows, query, today, sortKey, sortDir, onSort, focusedIndex, canEdit, inPlan, addingWatch, addingPlan,
    onOpen, onAddWatch, onAddPlan, onFilterFirm, onFilterTicker, maxHeight = "calc(100vh - 220px)",
  },
  ref,
) {
  const th = (k: SortKey) => ({ active: sortKey === k, dir: sortDir, onSort: () => onSort(k) });
  return (
    <DataTable ref={ref} maxHeight={maxHeight} ariaLabel={analystI18n.t("table.aria")} className="[&_tbody_td]:py-1.5">
      {/* Fixed tracks sized to their content (sortable headers need label + sort icon); the firm column takes the rest.
          min-w keeps the firm column readable at ~1280 px — the table scrolls sideways instead of wrapping rows 5 lines tall. */}
      <table className="min-w-[1000px] table-fixed">
        <colgroup>
          <col style={{ width: 96 }} />
          <col style={{ width: 128 }} />
          <col style={{ width: 168 }} />
          <col />
          <col style={{ width: 152 }} />
          <col style={{ width: 104 }} />
          <col style={{ width: 88 }} />
          <col style={{ width: 132 }} />
        </colgroup>
        <thead>
          <tr>
            <SortableTh {...th("time")}>{analystI18n.t("table.time")}</SortableTh>
            <SortableTh {...th("ticker")}>{commonI18n.t("trading.ticker")}</SortableTh>
            <th scope="col">{analystI18n.t("table.action")}</th>
            <SortableTh {...th("weight")}>{analystI18n.t("table.firmWeight")}</SortableTh>
            <SortableTh {...th("pt")}>{analystI18n.t("table.target")}</SortableTh>
            <SortableTh {...th("gap")} align="right">{analystI18n.t("table.gapRvol")}</SortableTh>
            <th scope="col" className="text-right">
              <TermTooltip term="reaction" />
            </th>
            <th scope="col"><span className="sr-only">{analystI18n.t("table.actions")}</span></th>
          </tr>
        </thead>
        <VirtualRows
          rows={rows}
          colSpan={COLS}
          estimateSize={ROW_H}
          overscan={10}
          getKey={(r) => r.a.id}
          renderRow={(r, i) => (
            <ActionTr
              key={r.a.id}
              row={r}
              index={i}
              focused={i === focusedIndex}
              query={query}
              today={today}
              canEdit={canEdit}
              inPlan={inPlan(r.a.ticker)}
              addingWatch={addingWatch === r.a.ticker}
              addingPlan={addingPlan === r.a.ticker}
              onOpen={onOpen}
              onAddWatch={onAddWatch}
              onAddPlan={onAddPlan}
              onFilterFirm={onFilterFirm}
              onFilterTicker={onFilterTicker}
            />
          )}
        />
      </table>
    </DataTable>
  );
});

/** Scroll the table so row `index` is visible (works for virtualized rows: fixed height). */
export function scrollRowIntoView(scroller: HTMLElement | null, index: number) {
  if (!scroller || index < 0) return;
  const top = HEAD_H + index * ROW_H;
  const bottom = top + ROW_H;
  const viewTop = scroller.scrollTop + HEAD_H;
  const viewBottom = scroller.scrollTop + scroller.clientHeight;
  if (top < viewTop) scroller.scrollTop = top - HEAD_H;
  else if (bottom > viewBottom) scroller.scrollTop = bottom - scroller.clientHeight;
}

const ActionTr = React.memo(function ActionTr({
  row: r, index, focused, query, today, canEdit, inPlan, addingWatch, addingPlan, onOpen, onAddWatch, onAddPlan, onFilterFirm, onFilterTicker,
}: {
  row: Row;
  index: number;
  focused: boolean;
  query: string;
  today: string;
  canEdit: boolean;
  inPlan: boolean;
  addingWatch: boolean;
  addingPlan: boolean;
  onOpen: (r: Row) => void;
  onAddWatch: (r: Row) => void;
  onAddPlan: (r: Row) => void;
  onFilterFirm: (firm: string) => void;
  onFilterTicker: (ticker: string) => void;
}) {
  const a = r.a;
  const key = nyKey(a.gradedAt);
  const day = key.slice(0, 10);
  const session = sessionOf(a.gradedAt);
  const gap = gapOf(r.quote);
  const rvol = r.quote?.relativeVolume ?? null;
  const w = r.weight && r.weight.n >= WEIGHT_MIN_N ? r.weight : null;
  return (
    <tr
      data-index={index}
      data-focused={focused || undefined}
      aria-selected={focused || undefined}
      onClick={() => onOpen(r)}
      style={{ height: ROW_H }}
      className={cn(
        "group cursor-pointer",
        "data-[focused]:bg-[var(--glass-hover-bg)] data-[focused]:shadow-[inset_2px_0_0_hsl(var(--primary))]",
        r.held.length > 0 && "bg-warn/[0.05]",
      )}
    >
      <td className="whitespace-nowrap">
        <div className="text-xs font-medium tabular-nums text-foreground" title={session ? analystI18n.t("table.sessionEt", { session: SESSION_LABEL[session] }) : undefined}>
          {nyTime(a.gradedAt)}
        </div>
        <div className={cn("text-2xs", session === "pre" && day === today ? "text-primary" : "text-muted-foreground")}>
          {day === today ? (session === "pre" ? analystI18n.t("table.premarket") : analystI18n.t("table.today")) : dayTitle(day, today).toLowerCase()}
        </div>
      </td>
      <td>
        <div className="flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onOpen(r); }}
            className="truncate rounded text-sm font-semibold tracking-tight text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={analystI18n.t("table.historyAria", { ticker: a.ticker })}
          >
            <Highlight text={a.ticker} query={query} />
          </button>
          <Marks held={r.held} watched={r.watched} traded={r.traded} />
        </div>
        {a.longName && <div className="truncate text-2xs text-muted-foreground" title={a.longName}>{a.longName}</div>}
      </td>
      <td>
        <div className="flex min-w-0 flex-col items-start gap-0.5">
          <KindPill kind={a.action} />
          <GradeChange from={a.fromGrade} to={a.toGrade} className="max-w-full" />
        </div>
      </td>
      <td>
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm text-foreground" title={a.firm}><Highlight text={a.firm} query={query} /></span>
          {r.top && <span className="shrink-0 rounded-full bg-primary/12 px-1.5 text-2xs font-medium text-accent-soft">{analystI18n.t("table.top")}</span>}
        </div>
        {w && (
          <div className="text-2xs tabular-nums text-muted-foreground" title={analystI18n.t("table.weightTitle", { ratio: w.ratio?.toFixed(1) ?? "—", count: w.n })}>
            {analystI18n.t("table.weight")} <span className={cn("font-medium", (w.ratio ?? 0) >= 1.5 ? "text-purple" : "text-foreground")}>×{w.ratio?.toFixed(1) ?? "—"}</span>
            {w.hit != null && analystI18n.t("table.hit", { pct: Math.round(w.hit * 100) })}
          </div>
        )}
      </td>
      <td><TargetChange action={a} price={r.quote?.price} showUpside={false} /></td>
      <td className="text-right">
        {gap != null ? <Delta value={gap} suffix="%" bare showIcon={false} /> : <span className="text-xs text-muted-foreground">—</span>}
        {rvol != null && Number.isFinite(rvol) && (
          <div className={cn("text-2xs tabular-nums", rvol >= 2 ? "font-medium text-foreground" : "text-muted-foreground")}>×{rvol.toFixed(1)}</div>
        )}
      </td>
      <td className="text-right"><ReactionChip agg={r.reaction} /></td>
      <td>
        <RowActions
          action={a}
          watched={r.watched}
          inPlan={inPlan}
          addingWatch={addingWatch}
          addingPlan={addingPlan}
          canEdit={canEdit}
          onAddWatch={() => onAddWatch(r)}
          onAddPlan={() => onAddPlan(r)}
          onOpen={() => onOpen(r)}
          onFilterFirm={() => onFilterFirm(a.firm)}
          onFilterTicker={() => onFilterTicker(a.ticker)}
          className={cn(
            "justify-end opacity-0 transition-opacity duration-[var(--dur-1)] group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100",
            focused && "opacity-100",
          )}
        />
      </td>
    </tr>
  );
});
