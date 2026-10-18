/**
 * «Описание» → the living part of a setup: Tier 1 showcase first (how it looks when played by plan),
 * Tier 3 «Типичные ошибки» (notes from trades that went wrong). Related setups (same folder / type, same space) are a
 * separate section the setup view puts under the card.
 * Pure data from the examples query already loaded by SetupView — no extra requests.
 */
import * as React from "react";
import { AlertTriangle, Plus, Shapes, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toneText } from "@/components/ds";
import { cn } from "@/lib/utils";
import { ExampleCard, checklistOf, exampleFigure } from "./examples-board";
import { DocSection, EdgeMini } from "./setup-bits";
import { spaceTabOf, type PlaybookEntry, type SetupExample, type SetupSummary, type ViewerLike } from "./model";
import { fmtDate } from "@/lib/format";
import { playbookI18n } from "@/i18n/ns/playbook";
const pt = playbookI18n.t; // called at render time only
import { commonI18n } from "@/i18n/ns/common";

import { personName } from "@/i18n";
/** Related setups: same space, same folder or same type; not the setup itself / its parent / its variants. Best-tested first. */
export function relatedSetups(entry: PlaybookEntry, all: PlaybookEntry[], summary: Map<number, SetupSummary>, viewer: ViewerLike, max = 6): PlaybookEntry[] {
  const space = spaceTabOf(entry, viewer);
  const score = (e: PlaybookEntry) => (entry.folder && e.folder === entry.folder ? 2 : 0) + (entry.setupType && e.setupType === entry.setupType ? 1 : 0);
  return all
    .filter((e) => e.id !== entry.id && e.id !== entry.parentId && e.parentId !== entry.id && spaceTabOf(e, viewer) === space && score(e) > 0)
    .sort((a, b) => score(b) - score(a) || (summary.get(b.id)?.tradeCount ?? 0) - (summary.get(a.id)?.tradeCount ?? 0) || a.name.localeCompare(b.name, "ru"))
    .slice(0, max);
}

export function SetupHighlights({
  entry, allEntries, summary, viewer, examples, canAdd, onAdd, onExamples, onOpen,
}: {
  entry: PlaybookEntry;
  allEntries: PlaybookEntry[];
  summary: Map<number, SetupSummary>;
  viewer: ViewerLike;
  examples: SetupExample[] | undefined;
  canAdd: boolean;
  onAdd: () => void;
  onExamples: () => void;
  onOpen: (id: number) => void;
}) {
  const t1 = React.useMemo(() => (examples ?? []).filter((x) => x.tier === 1).slice(0, 3), [examples]);
  const t1Total = (examples ?? []).filter((x) => x.tier === 1).length;
  const t3 = React.useMemo(() => (examples ?? []).filter((x) => x.tier === 3), [examples]);
  const checklist = React.useMemo(() => checklistOf(entry), [entry]);
  if (!examples) return null;

  return (
    <>
      <DocSection
        title={<>{pt("highlights.tier1")} <span className="font-normal tabular-nums text-muted-foreground">{t1Total}</span></>}
        icon={Trophy}
        actions={
          <>
            {canAdd && <Button size="sm" variant="ghost" className="h-8" onClick={onAdd}><Plus className="h-4 w-4" aria-hidden="true" /> {commonI18n.t("actions.add")}</Button>}
            {examples.length > 0 && <Button size="sm" variant="ghost" className="h-8" onClick={onExamples}>{pt("highlights.allExamples", { count: examples.length })}</Button>}
          </>
        }
      >
        {t1.length ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
            {t1.map((ex) => <ExampleCard key={ex.id} ex={ex} setupId={entry.id} checklist={checklist} editable={false} compact />)}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {canAdd ? pt("highlights.noTier1Editor") : pt("highlights.noTier1Reader")}
          </p>
        )}
      </DocSection>

      {t3.length > 0 && (
        <DocSection title={<>{pt("highlights.mistakes")} <span className="font-normal tabular-nums text-muted-foreground">{t3.length}</span></>} icon={AlertTriangle}>
          <ul className="divide-y divide-border/60">
            {t3.slice(0, 8).map((ex) => {
              const fig = exampleFigure(ex);
              return (
                <li key={ex.id}>
                  <button
                    type="button"
                    onClick={onExamples}
                    className="flex w-full min-w-0 items-start gap-3 rounded-lg px-1 py-2 text-left hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="w-28 shrink-0 text-sm tabular-nums">
                      <span className="font-medium text-foreground">{ex.ticker}</span>
                      <span className="block text-xs text-muted-foreground">{fmtDate(ex.closeDate ?? ex.date, "dayMonthNumeric")}{ex.trader ? ` · ${personName(ex.trader)}` : ""}</span>
                    </span>
                    <span className={cn("w-16 shrink-0 text-sm tabular-nums", toneText(fig.tone))}>{fig.text}</span>
                    <span className={cn("min-w-0 flex-1 text-sm [overflow-wrap:anywhere]", ex.note ? "text-foreground" : "italic text-muted-foreground")}>
                      {ex.note || pt("highlights.noNote")}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {t3.length > 8 && <Button size="sm" variant="ghost" className="mt-1 h-8" onClick={onExamples}>{pt("highlights.more", { count: t3.length - 8 })}</Button>}
        </DocSection>
      )}

    </>
  );
}

/** «Похожие сетапы» — rendered under the card (it is a pointer elsewhere, not part of the setup itself). */
export function RelatedSetupsSection({
  entry, allEntries, summary, viewer, onOpen,
}: {
  entry: PlaybookEntry;
  allEntries: PlaybookEntry[];
  summary: Map<number, SetupSummary>;
  viewer: ViewerLike;
  onOpen: (id: number) => void;
}) {
  const related = React.useMemo(() => relatedSetups(entry, allEntries, summary, viewer), [entry, allEntries, summary, viewer]);
  return (
    <>
      {related.length > 0 && (
        <DocSection title={pt("highlights.related")} icon={Shapes}>
          <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {related.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() => onOpen(e.id)}
                  className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={e.name}>{e.name}</span>
                  <EdgeMini s={summary.get(e.id)} className="shrink-0" />
                </button>
              </li>
            ))}
          </ul>
        </DocSection>
      )}
    </>
  );
}
