/**
 * Watchlist page chrome (pages/watchlist.tsx): header actions, list tabs (drop targets for dragged rows),
 * search + quick filters, the bulk-action bar and the delete confirmation. Presentational only — state and
 * mutations stay in the page.
 */
import type * as React from "react";
import { useEffect, useState } from "react";
import {
  Activity, AlertTriangle, Archive, ArchiveRestore, CalendarClock, Clock, Copy, Crosshair, Download, Eye, Flame, Keyboard,
  MoreHorizontal, MoveVertical, Radar, Rows3, Rows4, Search, Trash2, Volume2, X,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { FilterChip, Kbd } from "@/components/ds";
import { cn } from "@/lib/utils";
import { fmtUsd } from "@/lib/format";
import { LISTS, LIST_HINT, LIST_LABELS, type ListName, type WatchlistItem } from "./lib";
import type { Density } from "./WatchlistTable";
import { watchlistI18n } from "@/i18n/ns/watchlist";
import { commonI18n } from "@/i18n/ns/common";

export type View = ListName | "all" | "archive";
export type Filter = "events" | "gap" | "rvol" | "level";

const wt = watchlistI18n.t;
type FilterDef = { key: Filter; readonly label: string; icon: React.ElementType; readonly hint: string };
/** Quick filters; labels/hints are getters (UI language at render time). */
export const FILTERS: FilterDef[] = [
  { key: "events", get label() { return wt("filters.events"); }, icon: CalendarClock, get hint() { return wt("filters.eventsHint"); } },
  { key: "gap", get label() { return wt("filters.gap"); }, icon: MoveVertical, get hint() { return wt("filters.gapHint"); } },
  { key: "rvol", label: "rVol ≥ 1.5×", icon: Volume2, get hint() { return wt("filters.rvolHint"); } },
  { key: "level", get label() { return wt("filters.level"); }, icon: Crosshair, get hint() { return wt("filters.levelHint"); } },
];

type HotkeyId = "add" | "search" | "nav" | "open" | "note" | "move" | "select" | "copy" | "archive" | "refresh" | "density" | "help";
const HOTKEYS: [string[], HotkeyId][] = [
  [["A"], "add"],
  [["/"], "search"],
  [["J", "K"], "nav"],
  [["Enter"], "open"],
  [["E"], "note"],
  [["1", "2", "3"], "move"],
  [["X"], "select"],
  [["C"], "copy"],
  [["Del"], "archive"],
  [["R"], "refresh"],
  [["D"], "density"],
  [["?"], "help"],
];

/** Hotkeys popover + «Ещё действия» menu (next to the quote status in the page header). */
export function WatchlistHeaderMenus({ helpOpen, onHelpOpen, canEdit, canExport, onExport, copyCount, onCopy, onAddDetailed, canScoreAll, scoringAll, onScoreAll }: {
  helpOpen: boolean;
  onHelpOpen: (v: boolean) => void;
  canEdit: boolean;
  canExport: boolean;
  onExport: () => void;
  /** Visible tickers that «Скопировать тикеры» would copy. */
  copyCount: number;
  onCopy: () => void;
  onAddDetailed: () => void;
  canScoreAll: boolean;
  scoringAll: boolean;
  onScoreAll: () => void;
}) {
  const { t } = watchlistI18n.useT();
  return (
    <>
      <Popover open={helpOpen} onOpenChange={onHelpOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" className="hidden h-9 w-9 sm:inline-flex" aria-label={t("hotkeys.aria")} title={t("hotkeys.aria")}>
            <Keyboard className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-96 max-w-[calc(100vw-2rem)] bg-popover">
          <p className="mb-2 text-sm font-semibold text-foreground">{t("hotkeys.title")}</p>
          <ul className="space-y-1.5 text-sm">
            {HOTKEYS.map(([keys, id]) => (
              <li key={id} className="flex items-center gap-3">
                <span className="flex w-20 shrink-0 gap-1">{keys.map((k) => <Kbd key={k}>{k}</Kbd>)}</span>
                <span className="text-muted-foreground">{t(`hotkeys.${id}`)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">{t("hotkeys.footer")}</p>
        </PopoverContent>
      </Popover>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-9 w-9" aria-label={t("menu.more")}><MoreHorizontal className="h-4 w-4" /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuItem onSelect={onCopy} disabled={copyCount === 0}>
            <Copy className="mr-2 h-4 w-4" />{copyCount ? t("menu.copyTickersN", { count: copyCount }) : t("menu.copyTickers")}<Kbd className="ml-auto">C</Kbd>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onExport} disabled={!canExport}><Download className="mr-2 h-4 w-4" />{t("menu.exportCsv")}</DropdownMenuItem>
          {canEdit && (
            <>
              <DropdownMenuItem onSelect={onAddDetailed}>
                <Radar className="mr-2 h-4 w-4" />{t("menu.addDetailed")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onScoreAll} disabled={scoringAll || !canScoreAll}>
                <Activity className="mr-2 h-4 w-4" />{scoringAll ? t("menu.scoring") : t("menu.scoreAll")}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

const TABS: { v: View; readonly label: string; icon: React.ElementType; readonly title: string }[] = [
  { v: "today", get label() { return LIST_LABELS.today; }, icon: Flame, get title() { return LIST_HINT.today; } },
  { v: "swing", get label() { return LIST_LABELS.swing; }, icon: Clock, get title() { return LIST_HINT.swing; } },
  { v: "watch", get label() { return LIST_LABELS.watch; }, icon: Eye, get title() { return LIST_HINT.watch; } },
  { v: "all", get label() { return wt("list.all"); }, icon: Radar, get title() { return wt("list.allHint"); } },
];

/** Lists + archive tabs (drop targets while a row is dragged), the «в минусе по истории» hint and the density toggle. */
export function WatchlistTabs({ view, onView, counts, canEdit, dragging, dropOver, onDropOver, onDropTo, losing, density, onToggleDensity }: {
  view: View;
  onView: (v: View) => void;
  counts: Record<View, number>;
  canEdit: boolean;
  dragging: boolean;
  dropOver: View | null;
  onDropOver: (fn: (d: View | null) => View | null) => void;
  onDropTo: (target: View) => (e: React.DragEvent) => void;
  /** Tickers in view with a losing history: [ticker, net $]. */
  losing: Array<[string, number]>;
  density: Density;
  onToggleDensity: () => void;
}) {
  const { t } = watchlistI18n.useT();
  const dragProps = (v: View, droppable: boolean) => ({
    onDragOver: (e: React.DragEvent) => { if (!droppable) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; onDropOver(() => v); },
    onDragLeave: () => onDropOver((d) => (d === v ? null : d)),
    onDrop: droppable ? onDropTo(v) : undefined,
  });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div role="tablist" aria-label={t("tabs.aria")} className="glass-field inline-flex h-9 max-w-full items-center gap-0.5 overflow-x-auto p-[3px]">
        {TABS.map((tab) => {
          const active = view === tab.v;
          const droppable = dragging && tab.v !== "all";
          const Icon = tab.icon;
          return (
            <button
              key={tab.v}
              type="button"
              role="tab"
              aria-selected={active}
              title={tab.v === "all" || !canEdit ? tab.title : t("tabs.keyHint", { title: tab.title, key: LISTS.indexOf(tab.v as ListName) + 1 })}
              onClick={() => onView(tab.v)}
              {...dragProps(tab.v, droppable)}
              className={cn(
                "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-sm font-medium transition-[background-color,color,box-shadow] duration-[var(--dur-1)]",
                active ? "bg-primary-solid text-primary-foreground" : "text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground",
                droppable && !active && "ring-1 ring-dashed ring-primary/50",
                dropOver === tab.v && "ring-2 ring-primary",
              )}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />{tab.label}
              <span className={cn("tabular-nums", active ? "opacity-90" : "opacity-80")}>{counts[tab.v]}</span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        role="tab"
        aria-selected={view === "archive"}
        onClick={() => onView("archive")}
        {...dragProps("archive", dragging)}
        title={t("tabs.archiveTitle")}
        className={cn(
          "inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-sm transition-colors",
          view === "archive" ? "bg-[var(--glass-hover-bg)] font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
          dragging && "ring-1 ring-dashed ring-border",
          dropOver === "archive" && "ring-2 ring-primary",
        )}
      >
        <Archive className="h-3.5 w-3.5" aria-hidden="true" />{t("list.archive")}<span className="tabular-nums opacity-80">{counts.archive}</span>
      </button>
      <div className="ml-auto flex min-w-0 items-center gap-3">
        {losing.length > 0 && (
          <span
            className="hidden min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground md:inline-flex"
            title={losing.map(([tk, net]) => `${tk}: ${fmtUsd(net, { signed: true, decimals: 0 })}`).join("\n")}
          >
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-down" aria-hidden="true" />
            {t("tabs.losing", { list: `${losing.slice(0, 4).map(([tk]) => tk).join(", ")}${losing.length > 4 ? ` +${losing.length - 4}` : ""}` })}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 shrink-0"
          onClick={onToggleDensity}
          aria-label={density === "compact" ? t("tabs.densityComfy") : t("tabs.densityCompact")}
          title={density === "compact" ? t("tabs.densityComfyTitle") : t("tabs.densityCompact")}
          aria-pressed={density === "comfortable"}
        >
          {density === "compact" ? <Rows3 className="h-4 w-4" /> : <Rows4 className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}

/** Search box + quick filter chips. */
export function WatchlistSearch({ inputRef, query, onQuery, filters, onToggleFilter, filterCounts }: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  query: string;
  onQuery: (v: string) => void;
  filters: Set<Filter>;
  onToggleFilter: (f: Filter) => void;
  filterCounts: Record<Filter, number>;
}) {
  const { t } = watchlistI18n.useT();
  return (
    <>
      <div className="relative w-full sm:w-44 2xl:w-52">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={t("search.placeholder")}
          aria-label={t("search.aria")}
          className="glass-field h-10 w-full pl-9 pr-8 text-sm outline-none placeholder:text-muted-foreground"
        />
        {query ? (
          <button type="button" onClick={() => onQuery("")} aria-label={commonI18n.t("actions.clearSearch")} className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full text-muted-foreground hover:text-foreground">
            <X className="h-3.5 w-3.5" />
          </button>
        ) : <Kbd className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 sm:inline-flex">/</Kbd>}
      </div>
      {/* Phones: one scrollable row of chips instead of two wrapped rows; from sm up they flow inline. */}
      <div className="-mx-1 flex w-[calc(100%+0.5rem)] gap-2 overflow-x-auto px-1 sm:contents">
        {FILTERS.map((f) => (
          <FilterChip key={f.key} active={filters.has(f.key)} onClick={() => onToggleFilter(f.key)} count={filterCounts[f.key] || undefined} className="min-h-10 shrink-0">
            <f.icon className="h-3.5 w-3.5" aria-hidden="true" /><span title={f.hint}>{f.label}</span>
          </FilterChip>
        ))}
      </div>
    </>
  );
}

/** Sticky bar with bulk actions for the selected rows. */
export function SelectionBar({ items, view, mayModify, onRestore, onMove, onArchive, onDelete, onCopy, onClear }: {
  items: WatchlistItem[];
  view: View;
  mayModify: (i: WatchlistItem) => boolean;
  /** From the archive back into a list. */
  onRestore: (list: ListName) => void;
  onMove: (list: ListName) => void;
  onArchive: () => void;
  onDelete: (items: WatchlistItem[]) => void;
  onCopy: () => void;
  onClear: () => void;
}) {
  const { t } = watchlistI18n.useT();
  const deletable = items.filter(mayModify);
  return (
    <div className="glass-thick glass-solid sticky-top flex flex-wrap items-center gap-2 rounded-2xl px-3 py-2" role="region" aria-label={t("selection.aria")}>
      <span className="text-sm font-medium text-foreground">{t("selection.count", { count: items.length })}</span>
      <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
      {view === "archive" ? (
        LISTS.map((l) => (
          <Button key={l} size="sm" variant="outline" onClick={() => onRestore(l)}>
            <ArchiveRestore className="h-4 w-4" />{t("selection.toList", { list: LIST_LABELS[l] })}
          </Button>
        ))
      ) : (
        <>
          {LISTS.map((l, k) => (
            <Button key={l} size="sm" variant="outline" disabled={view === l} onClick={() => onMove(l)}>
              {t("selection.toList", { list: LIST_LABELS[l] })} <Kbd className="ml-1 hidden sm:inline-flex">{k + 1}</Kbd>
            </Button>
          ))}
          <Button size="sm" variant="outline" onClick={onArchive}><Archive className="h-4 w-4" />{t("selection.toArchive")}</Button>
        </>
      )}
      <Button size="sm" variant="outline" onClick={onCopy} title={t("selection.copyTitle")}><Copy className="h-4 w-4" />{t("selection.copy")}</Button>
      {deletable.length > 0 && (
        <Button
          size="sm" variant="ghost" className="text-down"
          title={deletable.length === items.length ? undefined : t("selection.deleteOwnOnly")}
          onClick={() => onDelete(deletable)}
        >
          <Trash2 className="h-4 w-4" />{deletable.length === items.length ? t("selection.delete") : t("selection.deleteN", { count: deletable.length })}
        </Button>
      )}
      <Button size="sm" variant="ghost" className="ml-auto" onClick={onClear}><X className="h-4 w-4" />{t("selection.clear")}</Button>
    </div>
  );
}

/** «Удалить N тикеров?» — the delete itself is undoable from the toast. */
export function DeleteTickersDialog({ items, busy, onCancel, onConfirm }: {
  items: WatchlistItem[] | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (items: WatchlistItem[]) => void;
}) {
  // Keep the last list while the dialog animates out (otherwise it flashes «Удалить 0 тикеров?»).
  const { t } = watchlistI18n.useT();
  const [last, setLast] = useState<WatchlistItem[]>([]);
  useEffect(() => { if (items) setLast(items); }, [items]);
  const shown = items ?? last;
  return (
    <AlertDialog open={!!items} onOpenChange={(v) => { if (!v) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {shown.length === 1 ? t("del.titleOne", { ticker: shown[0].ticker }) : t("del.titleMany", { count: shown.length })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {shown.length > 1 ? t("del.textMany", { list: shown.map((d) => d.ticker).join(", ") }) : t("del.text")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{commonI18n.t("actions.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => { e.preventDefault(); if (items) onConfirm(items); }}
            disabled={busy}
            className={buttonVariants({ variant: "destructive" })}
          >
            {busy ? t("del.deleting") : commonI18n.t("actions.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
