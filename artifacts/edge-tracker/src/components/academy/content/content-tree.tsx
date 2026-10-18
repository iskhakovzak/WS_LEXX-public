/**
 * Module / item tree of the content editor with reordering:
 *  • mouse — native HTML5 drag-and-drop (modules among modules; items within a module or into another module);
 *  • keyboard — ↑/↓ buttons on every row and Alt+↑ / Alt+↓ on a focused row; moving to another module is in the
 *    item editor («Перенести в модуль»). Every move is announced through an aria-live region.
 * Order is applied optimistically and persisted through /modules/:id/reorder, /programs/:id/reorder, /items/move.
 */
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, GripVertical, Plus } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ds";
import { cn } from "@/lib/utils";
import { kindLabel, api, invalidateAcademy, type AdminItem, type AdminModule, type ItemKind } from "./api";
import { KindIcon } from "./bits";
import { academyI18n } from "@/i18n/ns/academy";

export type Selection =
  | { type: "program" }
  | { type: "module"; id: number }
  | { type: "new-module" }
  | { type: "item"; kind: ItemKind; id: number }
  | { type: "new-item"; kind: ItemKind; moduleId: number };

type Drag = { type: "module"; id: number } | { type: "item"; kind: ItemKind; id: number; moduleId: number };
type DropTarget = { moduleId: number; index: number } | { moduleIndex: number } | null;

const MIME = "application/x-ws-academy";

/** One translated sentence with an inline icon: the key carries `{icon}`, filled with a slot marker and split here. */
const ICON_SLOT = "\u0000";
function withIcon(text: string, icon: React.ReactNode): React.ReactNode {
  const [before, after = ""] = text.split(ICON_SLOT);
  return <>{before}{icon}{after}</>;
}
const sameItem = (a: { kind: ItemKind; id: number }, b: { kind: ItemKind; id: number }) => a.kind === b.kind && a.id === b.id;

function move<T>(arr: T[], from: number, to: number): T[] {
  const out = [...arr];
  const [x] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, x);
  return out;
}

export function ContentTree({ programId, modules: serverModules, selection, onSelect, readOnly }: {
  programId: number; modules: AdminModule[]; selection: Selection; onSelect: (s: Selection) => void; readOnly?: boolean;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t } = academyI18n.useT();
  const [modules, setModules] = useState(serverModules);
  useEffect(() => setModules(serverModules), [serverModules]);
  const drag = useRef<Drag | null>(null);
  const [dropAt, setDropAt] = useState<DropTarget>(null);
  const [announce, setAnnounce] = useState("");
  const [busy, setBusy] = useState(false);

  const persist = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setAnnounce(message);
    try {
      await fn();
    } catch (e) {
      toast({ title: t("tree.orderFailed"), description: (e as Error).message, variant: "destructive" });
      setModules(serverModules);
    } finally {
      setBusy(false);
      await invalidateAcademy(qc);
    }
  };

  const moveModule = (from: number, to: number) => {
    if (from === to || to < 0 || to >= modules.length) return;
    const next = move(modules, from, to);
    setModules(next);
    void persist(() => api.reorderModules(programId, next.map((m) => m.id)), t("tree.announceModule", { title: modules[from].title, pos: to + 1, total: next.length }));
  };

  const moveItem = (it: { kind: ItemKind; id: number }, fromModuleId: number, toModuleId: number, toIndex: number) => {
    const src = modules.find((m) => m.id === fromModuleId);
    const dst = modules.find((m) => m.id === toModuleId);
    if (!src || !dst) return;
    const from = src.items.findIndex((x) => sameItem(x, it));
    if (from < 0) return;
    const item = src.items[from];
    if (fromModuleId === toModuleId) {
      const target = toIndex > from ? toIndex - 1 : toIndex; // index is "insert before" in the original list
      if (target === from || target < 0 || target >= src.items.length) return;
      const items = move(src.items, from, target);
      setModules(modules.map((m) => (m.id === src.id ? { ...m, items } : m)));
      void persist(() => api.reorderItems(src.id, items.map((x) => ({ kind: x.kind, id: x.id }))), t("tree.announceItem", { title: item.title, pos: target + 1, total: items.length }));
      return;
    }
    const srcItems = src.items.filter((_, k) => k !== from);
    const dstItems = [...dst.items];
    dstItems.splice(Math.max(0, Math.min(dstItems.length, toIndex)), 0, { ...item, moduleId: dst.id } as AdminItem);
    setModules(modules.map((m) => (m.id === src.id ? { ...m, items: srcItems } : m.id === dst.id ? { ...m, items: dstItems } : m)));
    void persist(async () => {
      await api.moveItem(item.kind, item.id, dst.id);
      await api.reorderItems(dst.id, dstItems.map((x) => ({ kind: x.kind, id: x.id })));
    }, t("tree.announceMoved", { title: item.title, module: dst.title, pos: Math.min(dstItems.length, toIndex + 1) }));
  };

  /* drag handlers */
  const onDragStart = (d: Drag) => (e: React.DragEvent) => {
    drag.current = d;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(MIME, JSON.stringify(d));
    e.dataTransfer.setData("text/plain", d.type === "module" ? `module:${d.id}` : `${d.kind}:${d.id}`);
  };
  const onDragEnd = () => { drag.current = null; setDropAt(null); };
  const overModule = (moduleIndex: number) => (e: React.DragEvent) => {
    if (drag.current?.type !== "module") return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const idx = e.clientY > rect.top + rect.height / 2 ? moduleIndex + 1 : moduleIndex;
    setDropAt((p) => (p && "moduleIndex" in p && p.moduleIndex === idx ? p : { moduleIndex: idx }));
  };
  const overItem = (moduleId: number, index: number) => (e: React.DragEvent) => {
    if (drag.current?.type !== "item") return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const idx = e.clientY > rect.top + rect.height / 2 ? index + 1 : index;
    setDropAt((p) => (p && "moduleId" in p && p.moduleId === moduleId && p.index === idx ? p : { moduleId, index: idx }));
  };
  const overModuleBody = (moduleId: number, count: number) => (e: React.DragEvent) => {
    if (drag.current?.type !== "item") return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropAt((p) => (p && "moduleId" in p && p.moduleId === moduleId ? p : { moduleId, index: count }));
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const d = drag.current;
    const t = dropAt;
    onDragEnd();
    if (!d || !t) return;
    if (d.type === "module" && "moduleIndex" in t) {
      const from = modules.findIndex((m) => m.id === d.id);
      const to = t.moduleIndex > from ? t.moduleIndex - 1 : t.moduleIndex;
      moveModule(from, to);
    } else if (d.type === "item" && "moduleId" in t) {
      moveItem(d, d.moduleId, t.moduleId, t.index);
    }
  };

  const modKey = (i: number) => (e: React.KeyboardEvent) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    moveModule(i, e.key === "ArrowUp" ? i - 1 : i + 1);
  };
  const itemKey = (m: AdminModule, k: number) => (e: React.KeyboardEvent) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const it = m.items[k];
    moveItem(it, m.id, m.id, e.key === "ArrowUp" ? k - 1 : k + 2);
  };

  const isSel = (s: Selection) => JSON.stringify(s) === JSON.stringify(selection);
  const dndOn = !readOnly && !busy;

  return (
    <div className="flex flex-col gap-2" onDragEnd={onDragEnd}>
      <p className="sr-only" aria-live="polite">{announce}</p>
      {!readOnly && <p className="px-1 text-xs text-muted-foreground">{withIcon(t("tree.dragHint", { icon: ICON_SLOT }), <GripVertical className="inline h-3 w-3" aria-hidden="true" />)}</p>}
      <ol className="flex flex-col gap-2" aria-label={t("tree.modulesAria")}>
        {modules.map((m, i) => {
          const modDrop = dropAt && "moduleIndex" in dropAt ? dropAt.moduleIndex : null;
          const archived = !!m.archivedAt;
          return (
            <li
              key={m.id}
              onDragOver={overModule(i)}
              onDrop={onDrop}
              className={cn(
                "glass-panel relative rounded-xl p-2",
                modDrop === i && "before:absolute before:-top-1.5 before:left-2 before:right-2 before:h-0.5 before:rounded before:bg-primary",
                modDrop === i + 1 && i === modules.length - 1 && "after:absolute after:-bottom-1.5 after:left-2 after:right-2 after:h-0.5 after:rounded after:bg-primary",
                archived && "opacity-60",
              )}
            >
              <div className="flex items-center gap-1">
                {!readOnly && (
                  <span draggable={dndOn} onDragStart={onDragStart({ type: "module", id: m.id })} className="cursor-grab p-1 text-muted-foreground active:cursor-grabbing" aria-hidden="true" title={t("tree.dragModule")}>
                    <GripVertical className="h-4 w-4" />
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => onSelect({ type: "module", id: m.id })}
                  onKeyDown={readOnly ? undefined : modKey(i)}
                  aria-current={isSel({ type: "module", id: m.id }) ? "true" : undefined}
                  aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                  className={cn("min-w-0 flex-1 truncate rounded-md px-1.5 py-1 text-left text-sm font-semibold hover:text-primary", isSel({ type: "module", id: m.id }) && "text-primary")}
                >
                  {i + 1}. {m.title}
                </button>
                {archived && <Pill tone="neutral">{t("tree.archived")}</Pill>}
                {!readOnly && (
                  <>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => moveModule(i, i - 1)} disabled={!dndOn || i === 0} aria-label={t("tree.moveModuleUp", { title: m.title })}><ChevronUp aria-hidden="true" /></Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => moveModule(i, i + 1)} disabled={!dndOn || i === modules.length - 1} aria-label={t("tree.moveModuleDown", { title: m.title })}><ChevronDown aria-hidden="true" /></Button>
                  </>
                )}
              </div>
              <ol className="mt-1 flex min-h-[2rem] flex-col" onDragOver={overModuleBody(m.id, m.items.length)} onDrop={onDrop} aria-label={t("tree.moduleItems", { title: m.title })}>
                {m.items.map((it, k) => {
                  const d = dropAt && "moduleId" in dropAt && dropAt.moduleId === m.id ? dropAt.index : null;
                  const sel = isSel({ type: "item", kind: it.kind, id: it.id });
                  return (
                    <li
                      key={`${it.kind}-${it.id}`}
                      onDragOver={overItem(m.id, k)}
                      onDrop={onDrop}
                      className={cn(
                        "relative flex items-center gap-1 rounded-lg pr-1",
                        sel && "bg-primary/10",
                        d === k && "before:absolute before:-top-px before:left-6 before:right-1 before:h-0.5 before:rounded before:bg-primary",
                        d === k + 1 && k === m.items.length - 1 && "after:absolute after:-bottom-px after:left-6 after:right-1 after:h-0.5 after:rounded after:bg-primary",
                        it.archivedAt && "opacity-60",
                      )}
                    >
                      {!readOnly && (
                        <span draggable={dndOn} onDragStart={onDragStart({ type: "item", kind: it.kind, id: it.id, moduleId: m.id })} className="cursor-grab p-1 text-muted-foreground active:cursor-grabbing" aria-hidden="true" title={t("tree.drag")}>
                          <GripVertical className="h-3.5 w-3.5" />
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => onSelect({ type: "item", kind: it.kind, id: it.id })}
                        onKeyDown={readOnly ? undefined : itemKey(m, k)}
                        aria-current={sel ? "true" : undefined}
                        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                        aria-label={`${t("tree.itemAria", { kind: kindLabel(it.kind), title: it.title })}${it.draft ? t("tree.draftFlag") : ""}${it.archivedAt ? t("tree.archivedFlag") : ""}`}
                        className={cn("flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1.5 text-left text-sm hover:text-primary", sel && "font-medium text-primary")}
                      >
                        <KindIcon kind={it.kind} className="shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate" title={it.title}>{it.title}</span>
                        {it.draft && <Pill tone="warn">{t("tree.draftShort")}</Pill>}
                        {it.archivedAt && <Pill tone="neutral">{t("tree.archived")}</Pill>}
                      </button>
                      {!readOnly && (
                        <>
                          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => moveItem(it, m.id, m.id, k - 1)} disabled={!dndOn || k === 0} aria-label={t("tree.moveUp", { title: it.title })}><ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /></Button>
                          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => moveItem(it, m.id, m.id, k + 2)} disabled={!dndOn || k === m.items.length - 1} aria-label={t("tree.moveDown", { title: it.title })}><ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /></Button>
                        </>
                      )}
                    </li>
                  );
                })}
                {!m.items.length && <li className="px-2 py-1.5 text-xs text-muted-foreground">{t("tree.emptyModule")}</li>}
              </ol>
              {!readOnly && !archived && (
                <div className="mt-1 flex flex-wrap gap-1 border-t border-border/40 pt-1.5">
                  {(["lesson", "quiz", "assignment"] as const).map((kind) => (
                    <Button key={kind} variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onSelect({ type: "new-item", kind, moduleId: m.id })} aria-label={t(`tree.addToModule.${kind}`, { module: m.title })}>
                      <Plus className="h-3 w-3" aria-hidden="true" />{kindLabel(kind)}
                    </Button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {!readOnly && (
        <Button variant="outline" size="sm" className="self-start" onClick={() => onSelect({ type: "new-module" })}><Plus aria-hidden="true" />{t("tree.addModule")}</Button>
      )}
    </div>
  );
}
