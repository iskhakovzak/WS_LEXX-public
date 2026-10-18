import * as React from "react";
import { motion, useReducedMotion } from "framer-motion";
import { BookOpen, CircleDot, Download, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { RESULTS } from "./trade-utils";
import { ResultPill } from "./trade-bits";
import type { TagKind } from "./review-presets";
import { KIND_META, TagPicker, pickerOptions, type PickState } from "./review-tagging";
import { commonI18n } from "@/i18n/ns/common";
import { tradesI18n } from "@/i18n/ns/trades";

/**
 * Floating bar for the selected trades: bulk setup / mistake / emotion tagging (same pickers as the rows),
 * CSV, and — for staff or manual trades only — result and delete.
 */
export function BulkActionBar({
  count,
  canTag,
  pending,
  setupOptions,
  stateOf,
  onSetSetup,
  onToggleTag,
  onExport,
  onSetResult,
  onDelete,
  onClear,
  onAddToPlaybook,
}: {
  count: number;
  canTag: boolean;
  pending: boolean;
  setupOptions: readonly string[];
  /** How many of the selected trades already carry a value (setup or tag). */
  stateOf: (kind: TagKind, value: string) => PickState;
  onSetSetup: (setup: string | null) => void;
  onToggleTag: (tag: string, mode: "add" | "remove") => void;
  onExport: () => void;
  /** Staff only (broker results are read-only for traders). */
  onSetResult?: (r: string) => void;
  /** Staff, or a selection of manual trades only. */
  onDelete?: () => void;
  onClear: () => void;
  /** «В плейбук» — add the selected trades as examples of one setup (components/playbook/quick-add.tsx). */
  onAddToPlaybook?: () => void;
}) {
  const reduce = useReducedMotion();
  const [open, setOpen] = React.useState<TagKind | null>(null);

  const picker = (kind: TagKind) => (
    <TagPicker
      key={kind}
      kind={kind}
      open={open === kind}
      onOpenChange={(o) => setOpen(o ? kind : null)}
      options={pickerOptions(kind, setupOptions)}
      stateOf={(v) => stateOf(kind, v)}
      onPick={(v) => {
        if (kind === "setup") onSetSetup(stateOf("setup", v) === "all" ? null : v);
        else onToggleTag(v, stateOf(kind, v) === "all" ? "remove" : "add");
      }}
      onClear={kind === "setup" ? () => onSetSetup(null) : undefined}
      align="start"
    >
      <Button variant="outline" size="sm" disabled={pending} onClick={() => setOpen(open === kind ? null : kind)} aria-expanded={open === kind}>
        {KIND_META[kind].label}
      </Button>
    </TagPicker>
  );

  return (
    <motion.div
      role="toolbar"
      aria-label={tradesI18n.t("bulk.toolbar", { count })}
      initial={reduce ? false : { y: 24, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
      className="glass-thick fixed inset-x-3 bottom-4 z-nav mx-auto flex max-w-3xl flex-wrap items-center gap-1.5 rounded-2xl p-2 shadow-2xl sm:inset-x-6"
    >
      <span className="px-2 text-sm font-semibold tabular-nums">
        {commonI18n.t("units.trades", { count: count })}
      </span>
      {onAddToPlaybook && (
        <Button size="sm" className="gap-1.5 bg-primary-solid" onClick={onAddToPlaybook} disabled={pending}>
          <BookOpen className="h-3.5 w-3.5" aria-hidden="true" /> {tradesI18n.t("bulk.toPlaybook")}
        </Button>
      )}
      {canTag && (["setup", "mistake", "emotion"] as const).map(picker)}
      {onSetResult && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1.5" disabled={pending}><CircleDot className="h-3.5 w-3.5" /> {tradesI18n.t("bulk.result")}</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top">
            {RESULTS.map((r) => (
              <DropdownMenuItem key={r} onSelect={() => onSetResult(r)}><ResultPill result={r} /></DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Button variant="outline" size="sm" className="gap-1.5" onClick={onExport}><Download className="h-3.5 w-3.5" /> CSV</Button>
      {onDelete && (
        <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground hover:text-down" onClick={onDelete} disabled={pending}><Trash2 className="h-3.5 w-3.5" /> {commonI18n.t("actions.delete")}</Button>
      )}
      <Button variant="ghost" size="icon" className="ml-auto h-8 w-8" aria-label={tradesI18n.t("bulk.clearSelection")} onClick={onClear}><X /></Button>
    </motion.div>
  );
}
