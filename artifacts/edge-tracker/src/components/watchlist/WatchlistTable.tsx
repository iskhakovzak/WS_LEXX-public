import * as React from "react";
import { GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/auth-context";
import { canModifyOwned } from "@/lib/ownership";
import { DataTable, SortableTh, toneOf, toneText, type SortDir } from "@/components/ds";
import { Checkbox } from "@/components/ui/checkbox";
import { LIST_LABELS, type EarningsHit, type KeyLevel, type ListName, type NewsDigest, type Plan, type Quote, type WatchlistItem } from "./lib";
import type { DayLevelSet, UpcomingEarnings } from "./use-market";
import type { TickerHistory } from "./use-history";
import { EventMarks, HistoryCell, InlineNote, LevelCell } from "./bits";
import { RowMenu, type RowActions } from "./WatchlistRow";
import { Sparkline } from "./visuals";
import { fmtPct, fmtPrice } from "@/lib/format";
import { watchlistI18n } from "@/i18n/ns/watchlist";

/** One prepared row: the watchlist item plus everything the table shows next to it. */
export type WlRow = {
  item: WatchlistItem;
  /** Working list; null = archived. */
  list: ListName | null;
  quote?: Quote;
  plan: Plan;
  levels: DayLevelSet | null | undefined;
  keys: KeyLevel[];
  history?: TickerHistory;
  earnings?: EarningsHit;
  upcoming?: UpcomingEarnings;
  news?: NewsDigest;
  /** Temporary optimistic row (being created). */
  pending?: boolean;
};

export type SortKey = "ticker" | "change" | "gap" | "rvol" | "atr" | "level" | "hist" | "added" | "score";
export const SORT_DEFAULT_DIR: Record<SortKey, SortDir> = {
  ticker: "asc", change: "desc", gap: "desc", rvol: "desc", atr: "desc", level: "asc", hist: "asc", added: "desc", score: "desc",
};
export type Density = "compact" | "comfortable";

/** Value used for sorting (nulls always sink). Gap sorts by size, level by the nearest distance, history by net. */
export function sortValue(r: WlRow, key: SortKey): number | string | null {
  const q = r.quote;
  switch (key) {
    case "ticker": return r.item.ticker;
    case "change": return q?.change ?? null;
    case "gap": return q?.gapPct != null ? Math.abs(q.gapPct) : null;
    case "rvol": return q?.relativeVolume ?? null;
    case "atr": return q?.atr != null && q.price ? (q.atr / q.price) * 100 : null;
    case "level": return r.keys[0] ? Math.abs(r.keys[0].distPct) : null;
    case "hist": return r.history && r.history.n ? r.history.net : null;
    case "added": return new Date(r.item.createdAt).getTime();
    case "score": return r.item.score;
  }
}

export const DRAG_MIME = "application/x-ws-watchlist";

type TableProps = {
  rows: WlRow[];
  showList: boolean;
  density: Density;
  sort: { key: SortKey; dir: SortDir };
  onSort: (k: SortKey) => void;
  selected: Set<number>;
  onSelect: (id: number, v: boolean) => void;
  onSelectAll: (v: boolean) => void;
  focusedId: number | null;
  onFocusRow: (id: number) => void;
  noteEditId: number | null;
  onNoteEdit: (id: number | null) => void;
  canEdit: boolean;
  me: string | null;
  actions: RowActions;
  scoringIds: Set<number>;
  quotesLoading: boolean;
  levelsLoading: boolean;
  today: string;
  onDragState?: (dragging: boolean) => void;
};

export function WatchlistTable({
  rows, showList, density, sort, onSort, selected, onSelect, onSelectAll, focusedId, onFocusRow, noteEditId, onNoteEdit,
  canEdit, me, actions, scoringIds, quotesLoading, levelsLoading, today, onDragState,
}: TableProps) {
  const comfy = density === "comfortable";
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.item.id));
  const someSelected = !allSelected && rows.some((r) => selected.has(r.item.id));
  const th = (k: SortKey) => ({ active: sort.key === k, dir: sort.dir, onSort: () => onSort(k) });

  return (
    <DataTable density={density} className="[&_tbody_td]:py-0 [&_thead_th]:py-1.5">
      <table className="table-fixed">
        <colgroup>
          <col style={{ width: canEdit ? 52 : 12 }} />
          <col style={{ width: comfy ? 170 : 150 }} />
          <col style={{ width: 80 }} />
          <col style={{ width: 72 }} />
          <col style={{ width: 66 }} />
          <col style={{ width: 58 }} />
          <col style={{ width: 86 }} />
          {comfy && <col style={{ width: 84 }} />}
          <col style={{ width: comfy ? 172 : 190 }} />
          <col style={{ width: comfy ? 124 : 132 }} />
          <col />
          <col style={{ width: 40 }} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="!pl-2 !pr-0">
              {canEdit && (
                <span className="flex items-center pl-[18px]">
                  <Checkbox
                    checked={allSelected ? true : someSelected ? "indeterminate" : false}
                    onCheckedChange={(v) => onSelectAll(v === true)}
                    aria-label={watchlistI18n.t("table.selectAll")}
                  />
                </span>
              )}
            </th>
            <SortableTh {...th("ticker")}>{watchlistI18n.t("table.ticker")}</SortableTh>
            <th scope="col" className="text-right">{watchlistI18n.t("table.price")}</th>
            <SortableTh {...th("change")} align="right">{watchlistI18n.t("table.day")}</SortableTh>
            <SortableTh {...th("gap")} align="right">{watchlistI18n.t("table.gap")}</SortableTh>
            <SortableTh {...th("rvol")} align="right">rVol</SortableTh>
            <SortableTh {...th("atr")} align="right">ATR</SortableTh>
            {comfy && <th scope="col">{watchlistI18n.t("table.days22")}</th>}
            <SortableTh {...th("level")}>{watchlistI18n.t("table.nearest")}</SortableTh>
            <SortableTh {...th("hist")}>{me ? watchlistI18n.t("table.myTrades") : watchlistI18n.t("table.history")}</SortableTh>
            <th scope="col">{watchlistI18n.t("table.note")}</th>
            <th scope="col"><span className="sr-only">{watchlistI18n.t("table.actions")}</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Row
              key={r.item.id}
              r={r}
              showList={showList}
              comfy={comfy}
              selected={selected.has(r.item.id)}
              selectedIds={selected}
              onSelect={onSelect}
              focused={focusedId === r.item.id}
              onFocusRow={onFocusRow}
              noteEditing={noteEditId === r.item.id}
              onNoteEdit={onNoteEdit}
              canEdit={canEdit}
              me={me}
              actions={actions}
              scoring={scoringIds.has(r.item.id)}
              quotesLoading={quotesLoading}
              levelsLoading={levelsLoading}
              today={today}
              onDragState={onDragState}
            />
          ))}
        </tbody>
      </table>
    </DataTable>
  );
}

type RowProps = {
  r: WlRow;
  showList: boolean;
  comfy: boolean;
  selected: boolean;
  selectedIds: Set<number>;
  onSelect: (id: number, v: boolean) => void;
  focused: boolean;
  onFocusRow: (id: number) => void;
  noteEditing: boolean;
  onNoteEdit: (id: number | null) => void;
  canEdit: boolean;
  me: string | null;
  actions: RowActions;
  scoring: boolean;
  quotesLoading: boolean;
  levelsLoading: boolean;
  today: string;
  onDragState?: (dragging: boolean) => void;
};

const Row = React.memo(function Row({
  r, showList, comfy, selected, selectedIds, onSelect, focused, onFocusRow, noteEditing, onNoteEdit, canEdit, me, actions, scoring,
  quotesLoading, levelsLoading, today, onDragState,
}: RowProps) {
  const { item, quote: q, plan } = r;
  const { isCurator } = useAuth();
  const mayModify = canEdit && canModifyOwned(item.createdBy, me, isCurator);
  const ref = React.useRef<HTMLTableRowElement>(null);
  React.useEffect(() => {
    if (focused && ref.current && document.activeElement !== ref.current && !ref.current.contains(document.activeElement)) {
      ref.current.focus({ preventScroll: true });
      ref.current.scrollIntoView({ block: "nearest" });
    }
  }, [focused]);

  const name = q?.name && q.name !== item.ticker ? q.name : item.longName ?? null;
  const sub = item.catalyst || name || item.sector || "";
  const atrPct = q?.atr != null && q.price ? (q.atr / q.price) * 100 : null;
  const rv = q?.relativeVolume ?? null;
  const gap = q?.gapPct ?? null;
  const accent =
    plan.alert === "stop-hit" ? "bg-down"
    : plan.alert === "target-hit" ? "bg-up"
    : plan.alert ? "bg-warn"
    : "bg-transparent";
  const cellY = comfy ? "py-2" : "py-1.5";
  const loadingQuote = quotesLoading && !q;

  const onDragStart = (e: React.DragEvent) => {
    const ids = selected && selectedIds.size > 1 ? Array.from(selectedIds) : [item.id];
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(ids));
    e.dataTransfer.setData("text/plain", item.ticker);
    e.dataTransfer.effectAllowed = "move";
    onDragState?.(true);
  };

  return (
    <tr
      ref={ref}
      tabIndex={0}
      data-row-id={item.id}
      aria-selected={selected}
      aria-label={`${item.ticker}${q?.price != null ? `, ${fmtPrice(q.price)}` : ""}${q?.change != null ? `, ${fmtPct(q.change, 2)}` : ""}`}
      draggable={canEdit && !noteEditing && !r.pending}
      onDragStart={onDragStart}
      onDragEnd={() => onDragState?.(false)}
      onClick={() => { onFocusRow(item.id); if (!r.pending) actions.open(item); }}
      onFocus={(e) => { if (e.target === e.currentTarget) onFocusRow(item.id); }}
      className={cn(
        "group cursor-pointer outline-none focus-visible:bg-[var(--tile-hover-bg)]",
        focused && "bg-[var(--tile-hover-bg)] shadow-[inset_2px_0_0_hsl(var(--primary))]",
        selected && "bg-primary/10",
        !r.list && "opacity-75",
        r.pending && "opacity-60",
      )}
    >
      {/* select + drag handle + alert bar */}
      <td className={cn("relative !pl-2 !pr-0", cellY)}>
        <span className={cn("absolute inset-y-1.5 left-0 w-[3px] rounded-full", accent)} aria-hidden="true" title={plan.alert ? alertLabel(plan.alert) : undefined} />
        {canEdit && (
          <span className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-muted-foreground/0 transition-colors group-hover:text-muted-foreground" aria-hidden="true" />
            <Checkbox checked={selected} onCheckedChange={(v) => onSelect(item.id, v === true)} aria-label={watchlistI18n.t("table.select", { ticker: item.ticker })} />
          </span>
        )}
      </td>

      {/* ticker + marks */}
      <td className={cellY}>
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="text-sm font-semibold tracking-tight text-foreground">{item.ticker}</span>
          <EventMarks item={item} earnings={r.earnings} upcoming={r.upcoming} news={r.news} today={today} />
          {showList && (
            <span className="ml-auto shrink-0 rounded-full bg-[var(--glass-bg)] px-1.5 text-xs text-muted-foreground">
              {r.list ? LIST_LABELS[r.list] : watchlistI18n.t("list.archiveLower")}
            </span>
          )}
        </div>
        {comfy && sub && <div className="mt-0.5 truncate text-xs text-muted-foreground" title={sub}>{sub}</div>}
      </td>

      <td className={cn("text-right font-medium text-foreground", cellY)}>
        {loadingQuote ? <span className="ml-auto block h-3.5 w-12 animate-pulse rounded bg-muted motion-reduce:animate-none" /> : fmtPrice(q?.price)}
      </td>
      <td className={cn("text-right", cellY, toneText(toneOf(q?.change)))}>{loadingQuote ? "" : fmtPct(q?.change, 2)}</td>
      <td className={cn("text-right text-xs", cellY, gap != null && Math.abs(gap) >= 3 ? cn("font-semibold", toneText(toneOf(gap))) : "text-muted-foreground")}>
        {fmtPct(gap, 1)}
      </td>
      <td className={cn("text-right text-xs", cellY, rv != null && rv >= 1.5 ? "font-semibold text-primary" : "text-muted-foreground")}>
        {rv != null ? `${rv.toFixed(1)}×` : "—"}
      </td>
      <td className={cn("text-right text-xs", cellY)}>
        {q?.atr != null ? (
          <span className="whitespace-nowrap"><span className="text-foreground">{fmtPrice(q.atr)}</span>{atrPct != null && <span className="text-muted-foreground"> · {fmtPct(atrPct, { decimals: 1, signed: false })}</span>}</span>
        ) : <span className="text-muted-foreground">—</span>}
      </td>
      {comfy && (
        <td className={cellY}>
          <Sparkline data={q?.spark} width={68} height={24} />
        </td>
      )}
      <td className={cellY}>
        <LevelCell price={q?.price} levels={r.levels} keys={r.keys} loading={levelsLoading} />
      </td>
      <td className={cellY}>
        <HistoryCell history={r.history} me={me} />
      </td>
      <td className={cn("!px-1", cellY)}>
        <InlineNote
          value={item.notes}
          canEdit={mayModify && !r.pending}
          editing={noteEditing}
          onEditingChange={(v) => onNoteEdit(v ? item.id : null)}
          onSave={(v) => actions.saveNote(item, v)}
        />
      </td>
      <td className={cn("!pl-0 !pr-2 text-right", cellY)}>
        {!r.pending && <RowMenu item={item} list={r.list} canEdit={canEdit} canModify={mayModify} actions={actions} scoring={scoring} />}
      </td>
    </tr>
  );
});

function alertLabel(a: NonNullable<Plan["alert"]>): string {
  return watchlistI18n.t(a === "stop-hit" ? "alert.stopHit" : a === "target-hit" ? "alert.targetHit" : a === "near-stop" ? "alert.nearStop" : "alert.nearTarget");
}
