/**
 * Left pane of the library: collapsible folders with setup rows (or a flat sorted list).
 * Drag & drop (editors of the space): a setup row onto a folder header moves the setup there; a folder header onto
 * another one reorders folders. Example cards dragged from the «Эталоны» board drop onto setup rows (page-level).
 */
import { memo, useState, type DragEvent } from "react";
import { ArrowDown, ArrowUp, ChevronRight, Link as LinkIcon, MoreHorizontal, Palette, Pencil, Plus, Trash2 } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent,
  DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconAction, winrateTone } from "@/components/playbook-sub/bits";
import { toneText } from "@/components/ds";
import { cn } from "@/lib/utils";
import { EdgeMini, Highlight } from "./setup-bits";
import { FOLDER_SWATCHES, PICKER_SWATCH_INDICES, folderSwatch, isSameLocalDay, spaceOf, type PlaybookEntry, type SetupSummary } from "./model";
import { fmtRate } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { setupTypeLabel } from "@/i18n/ns/dataCodes";
import { playbookI18n } from "@/i18n/ns/playbook";
import { personName } from "@/i18n";
const pt = playbookI18n.t; // called at render time only

/** Optional row decorations: the author for personal/shared setups, and a drop-target highlight while dragging an example. */
type RowExtras = { showOwner?: boolean; dropTargetId?: number | null; canDragSetup?: (e: PlaybookEntry) => boolean };

const SETUP_DND = "application/x-pb-setup";
const FOLDER_DND = "application/x-pb-folder";
const hasType = (e: DragEvent, t: string) => Array.from(e.dataTransfer?.types ?? []).includes(t);

export type FolderGroup = { folder: string | null; entries: PlaybookEntry[]; total: number };

export type FolderActions = {
  onNewIn: (folder: string | null) => void;
  onRename: (folder: string) => void;
  /** Colour / order are desk-wide folder settings (staff only) — absent → the menu items are hidden. */
  onColor?: (folder: string, idx: number) => void;
  onMove?: (folder: string, delta: -1 | 1) => void;
  /** Drag & drop: `folder` takes the place of `target` (null → last). */
  onReorder?: (folder: string, target: string | null) => void;
  /** Drag & drop: move a setup into a folder (null → «Без папки»). */
  onMoveSetup?: (setupId: number, folder: string | null) => void;
  /** «Скопировать ссылку» on a folder (/playbook?folder=…). */
  onCopyLink?: (folder: string) => void;
  /** Absent → no «Удалить папку» (folder delete exists for «Офис» only). */
  onDelete?: (folder: string) => void;
};

const SetupRow = memo(function SetupRow({
  e, selected, s, onSelect, query, depth = 0, showFolder, folderColors, showOwner, dropTargetId, canDragSetup,
}: {
  e: PlaybookEntry; selected: boolean; s: SetupSummary | undefined; onSelect: (id: number) => void; query: string; depth?: number;
  showFolder?: boolean; folderColors: Record<string, number>;
} & RowExtras) {
  const today = isSameLocalDay(s?.lastUsedAt);
  return (
    <li>
      <button
        type="button"
        data-setup-row={e.id}
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(e.id)}
        draggable={!depth && !!canDragSetup?.(e)}
        onDragStart={(ev) => {
          ev.dataTransfer.setData(SETUP_DND, String(e.id));
          ev.dataTransfer.effectAllowed = "move";
        }}
        className={cn(
          "group flex w-full min-w-0 items-center gap-2 rounded-xl py-1.5 pr-2 text-left transition-colors duration-[var(--dur-1)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          depth ? "pl-9" : "pl-3",
          selected ? "bg-primary/15 text-foreground" : "hover:bg-[var(--glass-hover-bg)]",
          dropTargetId === e.id && "ring-2 ring-primary/70",
        )}
        title={e.name.length > 34 ? e.name : undefined}
      >
        {showFolder && <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", folderSwatch(e.folder, folderColors).bg)} aria-hidden="true" />}
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-sm", selected ? "font-semibold" : "font-medium")} title={e.name}>
            <Highlight text={e.name} query={query} />
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            <EdgeMini s={s} />
            {showOwner && spaceOf(e) === "personal" && e.trader ? (
              <span className="truncate text-xs text-muted-foreground" title={personName(e.trader)}>· {personName(e.trader)}</span>
            ) : e.setupType ? (
              <span className="truncate text-xs text-muted-foreground">· {setupTypeLabel(e.setupType)}</span>
            ) : null}
          </span>
        </span>
        {today && <span className="shrink-0 rounded-full bg-primary/15 px-1.5 text-xs text-primary">{pt("tree.today")}</span>}
        {!e.reviewed && spaceOf(e) === "office" && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[hsl(var(--chart-3))]" title={pt("tree.unreviewedTitle")} aria-label={pt("tree.unreviewed")} />}
      </button>
    </li>
  );
});

function folderEdge(entries: PlaybookEntry[], summary: Map<number, SetupSummary>) {
  let n = 0, w = 0, l = 0;
  for (const e of entries) {
    const s = summary.get(e.id);
    if (!s) continue;
    n += s.tradeCount; w += s.wins; l += s.losses;
  }
  return { n, wr: w + l > 0 ? w / (w + l) : null };
}

export function FolderTree({
  groups, flat, selectedId, onSelect, openFolders, onToggleFolder, summary, folderColors, childrenOf, query, canEdit, actions, folderOrder,
  showOwner, dropTargetId, canDragSetup,
}: RowExtras & {
  groups: FolderGroup[];
  /** When set, render a flat list instead of folders (sorted views, search). */
  flat: PlaybookEntry[] | null;
  selectedId: number | null;
  onSelect: (id: number) => void;
  openFolders: Set<string>;
  onToggleFolder: (key: string) => void;
  summary: Map<number, SetupSummary>;
  folderColors: Record<string, number>;
  childrenOf: Map<number, PlaybookEntry[]>;
  query: string;
  canEdit: boolean;
  actions: FolderActions;
  folderOrder: string[];
}) {
  /** Folder header under the pointer while a setup / folder is dragged (key, or null). */
  const [dropKey, setDropKey] = useState<string | null>(null);
  if (flat) {
    if (flat.length === 0) return <p className="px-3 py-6 text-center text-sm text-muted-foreground">{commonI18n.t("states.nothingFound")}</p>;
    return (
      <ul className="space-y-0.5" aria-label={commonI18n.t("trading.setups")}>
        {flat.map((e) => (
          <SetupRow key={e.id} e={e} selected={selectedId === e.id} s={summary.get(e.id)} onSelect={onSelect} query={query} showFolder folderColors={folderColors} showOwner={showOwner} dropTargetId={dropTargetId} canDragSetup={canDragSetup} />
        ))}
      </ul>
    );
  }

  if (groups.length === 0) return <p className="px-3 py-6 text-center text-sm text-muted-foreground">{commonI18n.t("states.nothingFound")}</p>;

  return (
    <ul className="space-y-1" aria-label={pt("tree.foldersAria")}>
      {groups.map((g) => {
        const key = g.folder ?? "__unfiled";
        const open = openFolders.has(key) || (selectedId != null && g.entries.some((e) => e.id === selectedId || childrenOf.get(e.id)?.some((c) => c.id === selectedId)));
        const sw = folderSwatch(g.folder, folderColors);
        const edge = folderEdge(g.entries, summary);
        const idx = g.folder ? folderOrder.indexOf(g.folder) : -1;
        const panelId = `pb-folder-${key.replace(/[^\p{L}\p{N}_-]/gu, "_")}`;
        const accepts = (e: DragEvent) =>
          canEdit && ((!!actions.onMoveSetup && hasType(e, SETUP_DND)) || (!!actions.onReorder && !!g.folder && hasType(e, FOLDER_DND)));
        return (
          <li key={key}>
            <div
              className={cn(
                "group/folder flex items-center gap-1 rounded-xl pr-1 hover:bg-[var(--glass-hover-bg)]",
                dropKey === key && "bg-primary/10 ring-2 ring-primary/60",
              )}
              data-folder-key={key}
              draggable={canEdit && !!g.folder && !!actions.onReorder}
              onDragStart={(e) => {
                if (!g.folder) return;
                e.dataTransfer.setData(FOLDER_DND, g.folder);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                if (!accepts(e)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dropKey !== key) setDropKey(key);
              }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropKey((k) => (k === key ? null : k)); }}
              onDrop={(e) => {
                setDropKey(null);
                if (!accepts(e)) return;
                e.preventDefault();
                const setupId = Number(e.dataTransfer.getData(SETUP_DND));
                if (setupId) { actions.onMoveSetup?.(setupId, g.folder); return; }
                const from = e.dataTransfer.getData(FOLDER_DND);
                if (from && g.folder && from !== g.folder) actions.onReorder?.(from, g.folder);
              }}
              onDragEnd={() => setDropKey(null)}
            >
              <button
                type="button"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => onToggleFolder(key)}
                className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-xl px-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronRight className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-[var(--dur-1)] motion-reduce:transition-none", open && "rotate-90")} aria-hidden="true" />
                <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", sw.bg)} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground" title={g.folder ?? commonI18n.t("fields.noFolder")}>{g.folder ?? commonI18n.t("fields.noFolder")}</span>
                {edge.n > 0 && (
                  <span className="hidden shrink-0 text-xs tabular-nums sm:inline" title={`${commonI18n.t("units.trades", { count: edge.n })}`}>
                    <span className={toneText(winrateTone(edge.wr ?? 0, edge.n))}>{fmtRate(edge.wr)}</span>
                  </span>
                )}
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {g.entries.length !== g.total ? `${g.entries.length}/${g.total}` : g.total}
                </span>
              </button>
              {canEdit && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <IconAction aria-label={pt("tree.folderActions", { folder: g.folder ?? commonI18n.t("fields.noFolder") })} className="md:opacity-0 md:group-hover/folder:opacity-100 md:focus-visible:opacity-100 md:data-[state=open]:opacity-100">
                      <MoreHorizontal />
                    </IconAction>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    <DropdownMenuItem onSelect={() => actions.onNewIn(g.folder)}><Plus className="h-4 w-4" aria-hidden="true" /> {pt("tree.newHere")}</DropdownMenuItem>
                    {g.folder && (
                      <>
                        <DropdownMenuItem onSelect={() => actions.onRename(g.folder!)}><Pencil className="h-4 w-4" aria-hidden="true" /> {pt("tree.rename")}</DropdownMenuItem>
                        {actions.onCopyLink && <DropdownMenuItem onSelect={() => actions.onCopyLink!(g.folder!)}><LinkIcon className="h-4 w-4" aria-hidden="true" /> {pt("tree.copyLink")}</DropdownMenuItem>}
                        {actions.onColor && <DropdownMenuSub>
                          <DropdownMenuSubTrigger><Palette className="h-4 w-4" aria-hidden="true" /> {pt("tree.color")}</DropdownMenuSubTrigger>
                          <DropdownMenuSubContent>
                            {PICKER_SWATCH_INDICES.map((i) => (
                              <DropdownMenuItem key={i} onSelect={() => actions.onColor?.(g.folder!, i)}>
                                <span className={cn("h-3 w-3 rounded-full", FOLDER_SWATCHES[i].bg)} aria-hidden="true" />
                                {FOLDER_SWATCHES[i].label}
                                {folderColors[g.folder!] === i && <span className="ml-auto text-xs text-muted-foreground">✓</span>}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>}
                        {actions.onMove && (
                          <>
                            <DropdownMenuItem disabled={idx <= 0} onSelect={() => actions.onMove?.(g.folder!, -1)}><ArrowUp className="h-4 w-4" aria-hidden="true" /> {pt("tree.up")}</DropdownMenuItem>
                            <DropdownMenuItem disabled={idx < 0 || idx >= folderOrder.length - 1} onSelect={() => actions.onMove?.(g.folder!, 1)}><ArrowDown className="h-4 w-4" aria-hidden="true" /> {pt("tree.down")}</DropdownMenuItem>
                          </>
                        )}
                        {actions.onDelete && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={() => actions.onDelete!(g.folder!)} className="text-down focus:text-down"><Trash2 className="h-4 w-4" aria-hidden="true" /> {pt("tree.deleteFolder")}</DropdownMenuItem>
                          </>
                        )}
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
            {open && (
              <ul id={panelId} className="mt-0.5 space-y-0.5 pl-3">
                {g.entries.map((e) => (
                  <SetupRowWithChildren
                    key={e.id}
                    e={e}
                    selectedId={selectedId}
                    summary={summary}
                    onSelect={onSelect}
                    query={query}
                    childrenOf={childrenOf}
                    folderColors={folderColors}
                    showOwner={showOwner}
                    dropTargetId={dropTargetId}
                    canDragSetup={canDragSetup}
                  />
                ))}
                {g.entries.length === 0 && <li className="px-3 py-1.5 text-xs text-muted-foreground">{pt("tree.noneUnderFilter")}</li>}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function SetupRowWithChildren({
  e, selectedId, summary, onSelect, query, childrenOf, folderColors, showOwner, dropTargetId, canDragSetup,
}: RowExtras & {
  e: PlaybookEntry; selectedId: number | null; summary: Map<number, SetupSummary>; onSelect: (id: number) => void; query: string;
  childrenOf: Map<number, PlaybookEntry[]>; folderColors: Record<string, number>;
}) {
  const kids = childrenOf.get(e.id) ?? [];
  return (
    <>
      <SetupRow e={e} selected={selectedId === e.id} s={summary.get(e.id)} onSelect={onSelect} query={query} folderColors={folderColors} showOwner={showOwner} dropTargetId={dropTargetId} canDragSetup={canDragSetup} />
      {kids.map((c) => (
        <SetupRow key={c.id} e={c} depth={1} selected={selectedId === c.id} s={summary.get(c.id)} onSelect={onSelect} query={query} folderColors={folderColors} showOwner={showOwner} dropTargetId={dropTargetId} />
      ))}
    </>
  );
}
