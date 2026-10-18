/** Command-palette quick find (press "/"): full-text over setups with highlighted snippets + quick actions. */
import { useMemo, useState } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Clock, CornerDownLeft, FileText, Search } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { EdgeMini, Highlight, snippet } from "./setup-bits";
import { folderSwatch, searchHaystack, type PlaybookEntry, type SetupSummary } from "./model";
import { setupTypeLabel } from "@/i18n/ns/dataCodes";
import { playbookI18n } from "@/i18n/ns/playbook";
const pt = playbookI18n.t; // called at render time only
import { commonI18n } from "@/i18n/ns/common";

export type QuickAction = { id: string; label: string; icon: LucideIcon; hint?: string; run: () => void };

const itemCls =
  "flex cursor-pointer select-none items-center gap-3 rounded-xl px-3 py-2 text-sm outline-none data-[selected=true]:bg-[var(--glass-hover-bg)] data-[selected=true]:text-foreground";
const groupCls = "[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground";

export function QuickFind({
  open, onOpenChange, entries, summary, folderColors, recentIds, actions, onPick,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  entries: PlaybookEntry[];
  summary: Map<number, SetupSummary>;
  folderColors: Record<string, number>;
  recentIds: number[];
  actions: QuickAction[];
  onPick: (id: number) => void;
}) {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);

  const results = useMemo(() => {
    if (!query) return [];
    const terms = query.split(/\s+/).filter(Boolean);
    const scored: { e: PlaybookEntry; score: number }[] = [];
    for (const e of entries) {
      const hay = searchHaystack(e);
      if (!terms.every((t) => hay.includes(t))) continue;
      const name = e.name.toLowerCase();
      let score = 0;
      if (name.startsWith(query)) score += 100;
      else if (name.includes(query)) score += 60;
      if ((e.ticker ?? "").toLowerCase() === query) score += 80;
      if ((e.setupType ?? "").toLowerCase().includes(query)) score += 20;
      if ((e.tags ?? "").toLowerCase().includes(query)) score += 15;
      if ((e.folder ?? "").toLowerCase().includes(query)) score += 10;
      score += Math.min(10, summary.get(e.id)?.tradeCount ?? 0);
      scored.push({ e, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, 40).map((x) => x.e);
  }, [entries, query, summary]);

  const recent = useMemo(() => recentIds.map((id) => byId.get(id)).filter(Boolean).slice(0, 6) as PlaybookEntry[], [recentIds, byId]);
  const shownActions = actions.filter((a) => !query || a.label.toLowerCase().includes(query));

  const close = () => { onOpenChange(false); setQ(""); };
  const pick = (id: number) => { close(); onPick(id); };

  const Row = (e: PlaybookEntry, withSnippet: boolean) => {
    const nameHit = e.name.toLowerCase().includes(query);
    const snip = withSnippet && !nameHit ? snippet(e.conditions, q) ?? snippet(e.notes, q) ?? snippet(e.checklist, q) ?? snippet(e.tags, q) : null;
    return (
      <CommandPrimitive.Item key={e.id} value={`setup-${e.id}`} onSelect={() => pick(e.id)} className={itemCls}>
        <span className={cn("h-2 w-2 shrink-0 rounded-full", folderSwatch(e.folder, folderColors).bg)} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-foreground"><Highlight text={e.name} query={withSnippet ? q : ""} /></span>
          <span className="block truncate text-xs text-muted-foreground">
            {snip ? <Highlight text={snip} query={q} /> : [e.folder ?? commonI18n.t("fields.noFolder"), e.setupType ? setupTypeLabel(e.setupType) : null, e.ticker].filter(Boolean).join(" · ")}
          </span>
        </span>
        <EdgeMini s={summary.get(e.id)} className="hidden shrink-0 sm:inline-flex" />
      </CommandPrimitive.Item>
    );
  };

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(true) : close())}>
      <DialogContent className="top-[12%] max-w-xl translate-y-0 gap-0 overflow-hidden p-0" aria-describedby={undefined}>
        <DialogTitle className="sr-only">{pt("quickFind.title")}</DialogTitle>
        <CommandPrimitive shouldFilter={false} loop className="flex flex-col" label={pt("quickFind.title")}>
          <div className="flex items-center gap-2 border-b border-border/60 px-4">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <CommandPrimitive.Input
              value={q}
              onValueChange={setQ}
              placeholder={pt("quickFind.placeholder")}
              aria-label={pt("quickFind.aria")}
              className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <CommandPrimitive.List className="max-h-[min(60vh,440px)] overflow-y-auto p-2">
            <CommandPrimitive.Empty className="px-3 py-8 text-center text-sm text-muted-foreground">{pt("quickFind.nothingFor", { query: q })}</CommandPrimitive.Empty>
            {query ? (
              results.length > 0 && (
                <CommandPrimitive.Group heading={pt("quickFind.setups", { count: results.length })} className={groupCls}>
                  {results.map((e) => Row(e, true))}
                </CommandPrimitive.Group>
              )
            ) : (
              recent.length > 0 && (
                <CommandPrimitive.Group heading={pt("quickFind.recent")} className={groupCls}>
                  {recent.map((e) => Row(e, false))}
                </CommandPrimitive.Group>
              )
            )}
            {shownActions.length > 0 && (
              <CommandPrimitive.Group heading={pt("quickFind.actions")} className={groupCls}>
                {shownActions.map((a) => (
                  <CommandPrimitive.Item key={a.id} value={`action-${a.id}`} onSelect={() => { close(); a.run(); }} className={itemCls}>
                    <a.icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="flex-1">{a.label}</span>
                    {a.hint && <kbd className="rounded border border-border px-1.5 text-xs text-muted-foreground">{a.hint}</kbd>}
                  </CommandPrimitive.Item>
                ))}
              </CommandPrimitive.Group>
            )}
            {!query && recent.length === 0 && (
              <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
                <Clock className="h-3.5 w-3.5" aria-hidden="true" /> {pt("quickFind.recentHint")}
              </div>
            )}
          </CommandPrimitive.List>
          <div className="flex items-center gap-3 border-t border-border/60 px-4 py-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1"><kbd className="rounded border border-border px-1">↑↓</kbd> {pt("quickFind.keySelect")}</span>
            <span className="inline-flex items-center gap-1"><kbd className="rounded border border-border px-1"><CornerDownLeft className="inline h-3 w-3" aria-hidden="true" /></kbd> {pt("quickFind.keyOpen")}</span>
            <span className="inline-flex items-center gap-1"><kbd className="rounded border border-border px-1">Esc</kbd> {pt("quickFind.keyClose")}</span>
            <span className="ml-auto inline-flex items-center gap-1"><FileText className="h-3 w-3" aria-hidden="true" />{entries.length}</span>
          </div>
        </CommandPrimitive>
      </DialogContent>
    </Dialog>
  );
}
