/**
 * Setup card (right column of the playbook): header with space / author / sharing state and actions,
 * one status line of $ stats, and tabs «Описание · Эталоны · Статистика · История».
 * «Описание» opens with the living part (highlights.tsx): Tier 1 showcase, Tier 3 «Типичные ошибки», related setups.
 */
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, ArrowUpFromLine, Building2, CheckCircle2, ChevronRight, Circle, Columns2, Copy, CopyPlus, FileText, History,
  Link as LinkIcon, ListChecks, MoreHorizontal, Pencil, Plus, Send, Share2, Trash2, Trophy, Undo2, User, Users, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Pill, SectionTabs, StatRow, TermLabel, toneText } from "@/components/ds";
import { IconAction } from "@/components/playbook-sub/bits";
import { MarkChecklist, ChecklistProbabilityBadge } from "@/components/playbook-checklist-marks";
import { PlaybookEdgeBlock } from "@/components/playbook-edge-block";
import { PlaybookAICritiqueButton } from "@/components/playbook-ai-critique";
import { PlaybookRevisionsButton } from "@/components/playbook-revisions";
import { useAuth } from "@/contexts/auth-context";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { invalidatePlaybook, notLiveMessage, useSetupExamples } from "./api";
import { http } from "@/lib/api/http";
import { ConfidenceMeter, DocSection, redactedAggHint, SetupTypePill, TagChips } from "./setup-bits";
import { ExamplesBoard } from "./examples-board";
import { ExamplesSection } from "./examples-section";
import { LinkedTradesSection } from "./linked-trades-section";
import { SubSetupsSection } from "./sub-setups-section";
import { RelatedSetupsSection, SetupHighlights } from "./highlights";
import { MoveToFolderButton } from "./move-to-folder";
import { SetupStatsPanel } from "./setup-stats";
import { StructuredDescription } from "./structured-editor";
import {
  HORIZON_LABEL, SOURCE_LABELS, accessOf, timeOfDayLabel, folderSwatch, moneyTone, timeAgo,
  type PlaybookEntry, type SetupAccess, type SetupSummary, type ViewerLike,
} from "./model";
import { fmtDate, fmtR, fmtRate, fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { playbookSetupI18n } from "@/i18n/ns/playbookSetup";

import { personName } from "@/i18n";
const st = playbookSetupI18n.t; // called at render / call time only
/** «Copy from …»: a person (Latin name in EN/UZ) or the office space, which the API stores as the label «Офис». */
const OFFICE_AUTHOR = "Офис"; // i18n-ignore (stored copied_from_author of the office space)
const copiedFromLabel = (author: string) => (author === OFFICE_AUTHOR ? st("view.spaceOffice") : personName(author));

export type SetupTab = "about" | "examples" | "stats" | "history";
export const SETUP_TABS: SetupTab[] = ["about", "examples", "stats", "history"];

export function SetupView({
  entry, allEntries, summary, folders, folderColors, viewer, live, tab, onTab,
  onOpen, onClose, onEdit, onDuplicate, onCreateChild, onDelete, onCompare, onFolderClick, onAddExamples, onShare,
}: {
  entry: PlaybookEntry;
  allEntries: PlaybookEntry[];
  summary: Map<number, SetupSummary>;
  folders: string[];
  folderColors: Record<string, number>;
  viewer: ViewerLike;
  /** New API is running (spaces / examples / stats endpoints exist). */
  live: boolean;
  tab: SetupTab;
  onTab: (t: SetupTab) => void;
  onOpen: (id: number) => void;
  onClose: () => void;
  onEdit: (e: PlaybookEntry) => void;
  onDuplicate: (e: PlaybookEntry) => void;
  onCreateChild: (parent: PlaybookEntry) => void;
  onDelete: (e: PlaybookEntry) => void;
  onCompare: (e: PlaybookEntry) => void;
  onFolderClick: (folder: string | null) => void;
  onAddExamples: (e: PlaybookEntry) => void;
  onShare: (e: PlaybookEntry) => void;
}) {
  const { t } = playbookSetupI18n.useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { isCurator } = useAuth();
  const topRef = React.useRef<HTMLDivElement>(null);
  const access = accessOf(entry, viewer);
  const parent = React.useMemo(() => (entry.parentId ? allEntries.find((e) => e.id === entry.parentId) ?? null : null), [entry.parentId, allEntries]);
  const s = summary.get(entry.id);
  const examplesQ = useSetupExamples(entry.id, live);
  const exampleCount = examplesQ.data?.length ?? s?.exampleCount;
  const tier1 = examplesQ.data ? examplesQ.data.filter((x) => x.tier === 1).length : s?.tier1Count;
  const swatch = folderSwatch(entry.folder, folderColors);
  const moveTargets = React.useMemo(() => allEntries.filter((e) => accessOf(e, viewer).canAddExamples), [allEntries, viewer]);

  React.useEffect(() => { topRef.current?.scrollIntoView({ block: "nearest" }); }, [entry.id]);

  const reviewedMut = useMutation({
    mutationFn: (reviewed: boolean) => http.post(`/api/playbook/${entry.id}/reviewed`, { reviewed }),
    onMutate: async (reviewed) => {
      await qc.cancelQueries({ queryKey: ["playbook"] });
      const prev = qc.getQueryData<PlaybookEntry[]>(["playbook"]);
      qc.setQueryData<PlaybookEntry[]>(["playbook"], (old = []) => old.map((e) => (e.id === entry.id ? { ...e, reviewed } : e)));
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(["playbook"], ctx.prev); toast({ title: st("view.reviewFailed"), variant: "destructive" }); },
    onSettled: () => qc.invalidateQueries({ queryKey: ["playbook"] }),
  });

  const [proposeOpen, setProposeOpen] = React.useState(false);
  const [proposeNote, setProposeNote] = React.useState("");
  const action = useMutation({
    mutationFn: async (kind: "copy" | "propose" | "unpropose" | "decline" | "promote") => {
      const note = proposeNote.trim();
      if (kind === "copy") return http.post<{ id: number; name: string }>(`/api/playbook/${entry.id}/copy`, {});
      if (kind === "propose") return http.post(`/api/playbook/${entry.id}/propose`, note ? { note } : {});
      if (kind === "unpropose" || kind === "decline") return http.del(`/api/playbook/${entry.id}/propose`);
      return http.post<{ id: number }>(`/api/playbook/${entry.id}/promote`, {});
    },
    onSuccess: (r: any, kind) => {
      invalidatePlaybook(qc, entry.id);
      if (kind === "copy") { toast({ title: st("view.copied"), description: st("view.copiedDesc") }); if (r?.id) onOpen(r.id); }
      if (kind === "propose") { setProposeOpen(false); setProposeNote(""); toast({ title: st("view.proposed"), description: st("view.proposedDesc") }); }
      if (kind === "unpropose") toast({ title: st("view.unproposed") });
      if (kind === "decline") toast({ title: st("view.declined"), description: st("view.declinedDesc") });
      if (kind === "promote") { toast({ title: st("view.promoted"), description: st("view.promotedDesc") }); if (r?.id) onOpen(r.id); }
    },
    onError: (e) => toast({ title: st("view.actionFailed"), description: notLiveMessage(e) ?? (e as Error)?.message, variant: "destructive" }),
  });

  function copyLink() {
    const url = `${window.location.origin}${window.location.pathname}?id=${entry.id}`;
    navigator.clipboard?.writeText(url).then(
      () => toast({ title: st("view.linkCopied") }),
      () => toast({ title: st("view.linkCopyFailed"), variant: "destructive" }),
    );
  }

  const author = access.space === "office" ? null : personName(entry.trader ?? entry.createdBy) || null;
  const proposed = !!entry.officeProposedAt;
  const canCopy = live && !access.mine && viewer.canEdit && !!viewer.name;

  return (
    <article ref={topRef} className="flex min-w-0 scroll-mt-20 flex-col gap-[var(--grid-gap)]" aria-labelledby="pb-doc-title" data-entry-id={entry.id}>
      <header className="glass-panel rounded-2xl p-[var(--panel-p)]">
        <div className="flex items-start gap-2">
          <IconAction aria-label={t("view.backToList")} onClick={onClose} className="-ml-1 lg:hidden"><ArrowLeft /></IconAction>
          <nav aria-label={t("view.path")} className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-xs text-muted-foreground">
            <SpaceBadge access={access} author={author} />
            <ChevronRight className="h-3 w-3" aria-hidden="true" />
            <button type="button" onClick={() => onFolderClick(entry.folder)} className="inline-flex min-h-6 items-center gap-1.5 rounded-full px-1.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <span className={cn("h-2 w-2 rounded-full", swatch.bg)} aria-hidden="true" />
              {entry.folder ?? commonI18n.t("fields.noFolder")}
            </button>
            {parent && (
              <>
                <ChevronRight className="h-3 w-3" aria-hidden="true" />
                <button type="button" onClick={() => onOpen(parent.id)} className="min-h-6 truncate rounded-full px-1.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{parent.name}</button>
              </>
            )}
          </nav>
          <IconAction aria-label={t("view.close")} title={t("view.close")} onClick={onClose} className="hidden lg:inline-grid"><X /></IconAction>
        </div>

        <h2 id="pb-doc-title" className="mt-2 text-2xl font-semibold tracking-tight text-foreground [overflow-wrap:anywhere]">{entry.name}</h2>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <SetupTypePill type={entry.setupType} />
          {entry.horizon && <Pill tone="neutral">{HORIZON_LABEL[entry.horizon] ?? entry.horizon}</Pill>}
          {entry.timeOfDay && <Pill tone="neutral">{timeOfDayLabel(entry.timeOfDay)}</Pill>}
          {entry.ticker && <Pill tone="neutral">{entry.ticker}</Pill>}
          {access.shared && <Pill tone="accent"><Users className="h-3 w-3" aria-hidden="true" /> {entry.visibility === "all" ? t("view.openToOffice") : t("view.openToSelected")}</Pill>}
          {proposed && access.space === "personal" && (
            <Pill tone="warn" title={entry.officeProposedNote ?? undefined}><Send className="h-3 w-3" aria-hidden="true" /> {entry.officeProposedBy && !access.mine ? t("view.proposedPillBy", { name: personName(entry.officeProposedBy) }) : t("view.proposedPill")}</Pill>
          )}
          {entry.copiedFromAuthor && <Pill tone="neutral" title={entry.copiedFromId ? t("view.copyOf", { id: entry.copiedFromId }) : undefined}>{t("view.copyPill", { author: copiedFromLabel(entry.copiedFromAuthor) })}</Pill>}
          {entry.sourceType && <Pill tone="neutral">{SOURCE_LABELS[entry.sourceType] || entry.sourceType}</Pill>}
          {access.space === "office" && (isCurator ? (
            <button
              type="button"
              aria-pressed={entry.reviewed}
              onClick={() => reviewedMut.mutate(!entry.reviewed)}
              className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title={entry.reviewed ? (entry.reviewedBy ? t("view.reviewedByTitle", { name: personName(entry.reviewedBy) }) : t("view.reviewedTitle")) : t("view.markReviewed")}
            >
              <Pill tone={entry.reviewed ? "up" : "neutral"}>
                {entry.reviewed ? <CheckCircle2 className="h-3 w-3" aria-hidden="true" /> : <Circle className="h-3 w-3" aria-hidden="true" />}
                {entry.reviewed ? t("view.reviewed") : t("view.notReviewed")}
              </Pill>
            </button>
          ) : entry.reviewed ? <Pill tone="up"><CheckCircle2 className="h-3 w-3" aria-hidden="true" /> {t("view.reviewed")}</Pill> : null)}
          <ConfidenceMeter level={entry.confidenceLevel} showLabel />
        </div>
        {entry.tags && <div className="mt-2"><TagChips tags={entry.tags} /></div>}
        {proposed && access.canPromote && entry.officeProposedNote && (
          <p className="mt-2 rounded-xl border border-[hsl(var(--chart-3)/0.3)] bg-[hsl(var(--chart-3)/0.08)] px-3 py-2 text-sm text-foreground">
            <span className="text-muted-foreground">{t("view.proposalComment")} </span>{entry.officeProposedNote}
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {access.canAddExamples && live && (
            <Button size="sm" onClick={() => onAddExamples(entry)} aria-keyshortcuts="a" title={t("view.addExamplesTitle")}><Plus className="h-4 w-4" aria-hidden="true" /> {t("view.addExamples")}</Button>
          )}
          {access.canShare && live && (
            <Button size="sm" variant="outline" onClick={() => onShare(entry)}><Share2 className="h-4 w-4" aria-hidden="true" /> {access.shared ? t("view.access") : t("view.share")}</Button>
          )}
          {canCopy && (
            <Button size="sm" variant="outline" onClick={() => action.mutate("copy")} disabled={action.isPending} title={t("view.copyToMineTitle")}><CopyPlus className="h-4 w-4" aria-hidden="true" /> {t("view.copyToMine")}</Button>
          )}
          {live && access.mine && !access.canPromote && (
            proposed
              ? <Button size="sm" variant="ghost" onClick={() => action.mutate("unpropose")} disabled={action.isPending}><Undo2 className="h-4 w-4" aria-hidden="true" /> {t("view.unpropose")}</Button>
              : (
                <Popover open={proposeOpen} onOpenChange={setProposeOpen}>
                  <PopoverTrigger asChild>
                    <Button size="sm" variant="ghost" disabled={action.isPending}><Send className="h-4 w-4" aria-hidden="true" /> {t("view.propose")}</Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-80">
                    <form
                      className="flex flex-col gap-2"
                      onSubmit={(e) => { e.preventDefault(); action.mutate("propose"); }}
                    >
                      <label htmlFor="pb-propose-note" className="text-sm font-medium text-foreground">{t("view.proposeLabel")}</label>
                      <Textarea
                        id="pb-propose-note"
                        value={proposeNote}
                        onChange={(e) => setProposeNote(e.target.value)}
                        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); action.mutate("propose"); } }}
                        rows={3}
                        maxLength={2000}
                        autoFocus
                        placeholder={t("view.proposePlaceholder")}
                        className="resize-y text-sm"
                      />
                      <p className="text-xs text-muted-foreground">{t("view.proposeHint")}</p>
                      <div className="flex justify-end gap-2">
                        <Button type="button" size="sm" variant="ghost" onClick={() => setProposeOpen(false)}>{commonI18n.t("actions.cancel")}</Button>
                        <Button type="submit" size="sm" disabled={action.isPending}>{commonI18n.t("actions.send")}</Button>
                      </div>
                    </form>
                  </PopoverContent>
                </Popover>
              )
          )}
          {live && access.canPromote && (
            <Button size="sm" variant="outline" onClick={() => action.mutate("promote")} disabled={action.isPending} title={t("view.promoteTitle")}>
              <ArrowUpFromLine className="h-4 w-4" aria-hidden="true" /> {t("view.promote")}
            </Button>
          )}
          {live && access.canPromote && proposed && !access.mine && (
            <Button size="sm" variant="ghost" onClick={() => action.mutate("decline")} disabled={action.isPending} title={t("view.declineTitle")}>
              <X className="h-4 w-4" aria-hidden="true" /> {commonI18n.t("actions.reject")}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => onCompare(entry)}><Columns2 className="h-4 w-4" aria-hidden="true" /> {t("view.compare")}</Button>
          {access.canEdit && <MoveToFolderButton entry={entry} folders={folders} folderColors={folderColors} />}
          <span className="ml-auto flex items-center gap-1">
            {access.canEdit && <PlaybookAICritiqueButton playbookId={entry.id} playbookName={entry.name} />}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconAction aria-label={commonI18n.t("actions.moreActions")} title={commonI18n.t("actions.moreActions")}><MoreHorizontal /></IconAction>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {access.canEdit && <DropdownMenuItem onSelect={() => onEdit(entry)}><Pencil className="h-4 w-4" aria-hidden="true" /> {t("view.editAll")} <span className="ml-auto text-xs text-muted-foreground">E</span></DropdownMenuItem>}
                {viewer.canEdit && <DropdownMenuItem onSelect={() => onDuplicate(entry)}><Copy className="h-4 w-4" aria-hidden="true" /> {t("view.duplicate")}</DropdownMenuItem>}
                {access.canEdit && <DropdownMenuItem onSelect={() => onCreateChild(entry)}><FileText className="h-4 w-4" aria-hidden="true" /> {t("view.newVariant")}</DropdownMenuItem>}
                <DropdownMenuItem onSelect={copyLink}><LinkIcon className="h-4 w-4" aria-hidden="true" /> {t("view.copyLink")}</DropdownMenuItem>
                {access.canEdit && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => onDelete(entry)} className="text-down focus:text-down"><Trash2 className="h-4 w-4" aria-hidden="true" /> {commonI18n.t("actions.delete")}</DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </div>

        <StatusLine s={s} exampleCount={exampleCount} tier1={tier1} onStats={() => onTab("stats")} onExamples={() => onTab("examples")} />
      </header>

      <SectionTabs<SetupTab>
        ariaLabel={t("view.tabsAria")}
        value={tab}
        onChange={onTab}
        tabs={[
          { value: "about", label: t("view.tabs.about"), icon: FileText },
          { value: "examples", label: t("view.tabs.examples"), icon: Trophy, count: exampleCount || undefined },
          { value: "stats", label: t("view.tabs.stats"), icon: ListChecks },
          { value: "history", label: t("view.tabs.history"), icon: History },
        ]}
      />

      <div className="min-h-[420px]">
        {tab === "about" && (
          <div className="flex flex-col gap-[var(--grid-gap)]">
            {live && (
              <SetupHighlights
                entry={entry}
                allEntries={allEntries}
                summary={summary}
                viewer={viewer}
                examples={examplesQ.data}
                canAdd={access.canAddExamples}
                onAdd={() => onAddExamples(entry)}
                onExamples={() => onTab("examples")}
                onOpen={onOpen}
              />
            )}
            <StructuredDescription entry={entry} canEdit={access.canEdit} live={live} aside={<AboutAside key={entry.id} entry={entry} parent={parent} access={access} />} />
            <SubSetupsSection entry={entry} allEntries={allEntries} summary={summary} onOpen={onOpen} onCreateChild={() => onCreateChild(entry)} />
            {live && <RelatedSetupsSection entry={entry} allEntries={allEntries} summary={summary} viewer={viewer} onOpen={onOpen} />}
          </div>
        )}
        {tab === "examples" && (
          <div className="flex flex-col gap-[var(--grid-gap)]">
            {live ? (
              <ExamplesBoard entry={entry} access={access} viewerName={viewer.name} targets={moveTargets} onAddExamples={() => onAddExamples(entry)} />
            ) : (
              <p className="rounded-xl border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">{t("view.boardNotLive")}</p>
            )}
            <ExamplesSection entryId={entry.id} />
          </div>
        )}
        {tab === "stats" && (
          <SetupStatsPanel setupId={entry.id} summary={s}>
            <LinkedTradesSection entry={entry} />
            <details className="glass-panel rounded-2xl p-[var(--panel-p)]">
              <summary className="cursor-pointer text-sm font-semibold text-foreground">{t("view.edgeByConditions")}</summary>
              <div className="mt-3"><PlaybookEdgeBlock playbookId={entry.id} /></div>
            </details>
          </SetupStatsPanel>
        )}
        {tab === "history" && <HistoryPanel entry={entry} />}
      </div>
    </article>
  );
}

/* ───────────────────────── pieces ───────────────────────── */

function SpaceBadge({ access, author }: { access: SetupAccess; author: string | null }) {
  if (access.space === "office") return <span className="inline-flex items-center gap-1 font-medium text-foreground"><Building2 className="h-3.5 w-3.5" aria-hidden="true" /> {st("view.spaceOffice")}</span>;
  if (access.mine) return <span className="inline-flex items-center gap-1 font-medium text-foreground"><User className="h-3.5 w-3.5" aria-hidden="true" /> {st("view.spaceMine")}</span>;
  return <span className="inline-flex items-center gap-1 font-medium text-foreground"><Users className="h-3.5 w-3.5" aria-hidden="true" /> {author ?? commonI18n.t("roles.trader")}</span>;
}

/** One line instead of a row of empty KPI tiles. */
function StatusLine({
  s, exampleCount, tier1, onStats, onExamples,
}: { s: SetupSummary | undefined; exampleCount?: number; tier1?: number; onStats: () => void; onExamples: () => void }) {
  const ex = (
    <button type="button" onClick={onExamples} className="hover:text-foreground">
      {tier1 ? st("status.examplesT1", { count: exampleCount ?? 0, t1: tier1 }) : st("status.examples", { count: exampleCount ?? 0 })}
    </button>
  );
  if (!s || s.tradeCount === 0) {
    return (
      <p className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 pt-3 text-sm text-muted-foreground">
        <span>{exampleCount ? st("status.noStatsYet") : st("status.noTrades")}</span>
        <span aria-hidden="true">·</span>
        {ex}
      </p>
    );
  }
  const exp = s.expectancyUsd ?? (s.netPnl != null && s.tradeCount ? s.netPnl / s.tradeCount : null);
  return (
    <p className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 pt-3 text-sm tabular-nums text-muted-foreground">
      <button type="button" onClick={onStats} className="hover:text-foreground">{s.tradeCount < 10 ? st("status.fewTrades", { trades: commonI18n.t("units.trades", { count: s.tradeCount }) }) : commonI18n.t("units.trades", { count: s.tradeCount })}</button>
      <span aria-hidden="true">·</span>
      <span>WR <span className="text-foreground">{fmtRate(s.winrate)}</span></span>
      <span aria-hidden="true">·</span>
      {s.redacted ? (
        // $ hidden by the server (other traders' trades) → expectancy in R instead.
        <span title={redactedAggHint()}><span className={toneText(moneyTone(s.expectancy))}>{fmtR(s.expectancy)}</span> {st("status.perTradeHidden")}</span>
      ) : (
        <>
          <span>{st("status.net")} <span className={toneText(moneyTone(s.netPnl))}>{fmtUsd(s.netPnl, { signed: true, decimals: 0 })}</span></span>
          <span aria-hidden="true">·</span>
          <span><span className={toneText(moneyTone(exp))}>{fmtUsd(exp, { signed: true, decimals: 2 })}</span> {st("status.perTrade")}</span>
        </>
      )}
      <span aria-hidden="true">·</span>
      {ex}
      {s.lastTradeDate && (<><span aria-hidden="true">·</span><span>{st("status.last", { date: fmtDate(s.lastTradeDate, "dayMonthNumeric") })}</span></>)}
    </p>
  );
}

function AboutAside({ entry, parent, access }: { entry: PlaybookEntry; parent: PlaybookEntry | null; access: SetupAccess }) {
  const [editingChecklist, setEditingChecklist] = React.useState(false);
  const checklistText = entry.checklist || parent?.checklist || null;
  const checklistItems = entry.checklist ? entry.checklistItems : null;
  const fundamentals: [string, string | number | null][] = [
    [commonI18n.t("trading.sector"), entry.sector], [commonI18n.t("trading.marketCap"), entry.marketCap], ["Float", entry.float], ["ADV", entry.adv],
    ["ATR", entry.atr], ["Rel. volume", entry.relativeVolume], ["Beta", entry.beta], [st("aside.shortInterest"), entry.shortInterest],
  ];
  const hasFundamentals = fundamentals.some(([, v]) => v != null && v !== "");
  return (
    <>
      <DocSection
        title={st("aside.checklist")}
        icon={ListChecks}
        actions={
          <>
            {checklistText && !editingChecklist && <ChecklistProbabilityBadge playbookId={entry.id} items={checklistItems} text={checklistText} />}
            {access.canEdit && checklistText && !editingChecklist && (
              <IconAction aria-label={st("aside.editChecklist")} title={st("aside.editChecklist")} onClick={() => setEditingChecklist(true)}><Pencil /></IconAction>
            )}
          </>
        }
      >
        {editingChecklist ? (
          <ChecklistInlineEditor entry={entry} onDone={() => setEditingChecklist(false)} />
        ) : checklistText ? (
          <>
            {!entry.checklist && parent?.checklist && <p className="mb-2 text-xs text-muted-foreground">{st("aside.inherited", { name: parent.name })}</p>}
            <MarkChecklist playbookId={entry.id} items={checklistItems} text={checklistText} />
          </>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">{st("aside.noChecklist")}</p>
            {access.canEdit && <Button size="sm" variant="outline" onClick={() => setEditingChecklist(true)}><Plus className="h-4 w-4" aria-hidden="true" /> {st("aside.addChecklist")}</Button>}
          </div>
        )}
      </DocSection>
      {(entry.ticker || hasFundamentals) && (
        <DocSection title={entry.ticker ? st("aside.profileTicker", { ticker: entry.ticker }) : st("aside.profile")}>
          {entry.longName && <p className="mb-1 text-sm text-foreground">{entry.longName}</p>}
          <div className="divide-y divide-border/60">
            {fundamentals.filter(([, v]) => v != null && v !== "").map(([k, v]) => <StatRow key={k} label={<TermLabel text={k} />} value={String(v)} />)}
          </div>
        </DocSection>
      )}
    </>
  );
}

/** Checklist edited in place — one item per line; Ctrl+Enter saves, Esc cancels. Same PATCH as the full form. */
function ChecklistInlineEditor({ entry, onDone }: { entry: PlaybookEntry; onDone: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [text, setText] = React.useState(entry.checklist ?? "");
  const [saving, setSaving] = React.useState(false);
  const lines = text.split("\n").map((l) => l.replace(/^[-•*]\s*/, "").trim()).filter(Boolean).length;
  async function save() {
    if (saving) return;
    const next = text.trim();
    if (next === (entry.checklist ?? "").trim()) { onDone(); return; }
    setSaving(true);
    try {
      await http.patch(`/api/playbook/${entry.id}`, { checklist: next || null });
      invalidatePlaybook(qc, entry.id);
      toast({ title: next ? st("checklistEditor.saved") : st("checklistEditor.cleared") });
      onDone();
    } catch (e) {
      toast({ title: st("checklistEditor.failed"), description: notLiveMessage(e) ?? (e as Error)?.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        aria-label={st("checklistEditor.aria")}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") { e.preventDefault(); onDone(); }
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
        }}
        rows={Math.min(14, Math.max(5, text.split("\n").length + 1))}
        placeholder={st("checklistEditor.placeholder")}
        autoFocus
        className="resize-y text-sm"
      />
      <div className="flex items-center gap-2">
        <span className="mr-auto text-xs tabular-nums text-muted-foreground">{lines ? commonI18n.t("units.items", { count: lines }) : st("checklistEditor.perLine")} · Ctrl+Enter</span>
        <Button size="sm" variant="ghost" onClick={onDone} disabled={saving}>{commonI18n.t("actions.cancel")}</Button>
        <Button size="sm" onClick={save} disabled={saving}>{saving ? st("checklistEditor.saving") : commonI18n.t("actions.save")}</Button>
      </div>
    </div>
  );
}

type ActivityRow = { id: number; action: string; section: string; entityId?: string | null; entityTitle?: string; trader?: string; details?: string; createdAt: string };

function HistoryPanel({ entry }: { entry: PlaybookEntry }) {
  const q = useQuery<ActivityRow[]>({
    queryKey: ["playbook-activity", "setup", entry.id],
    queryFn: async () => {
      // The setup's own journal (any reader of the setup). Older API → the global feed, filtered here.
      const own = await http.get<ActivityRow[]>(`/api/playbook/${entry.id}/activity`).catch(() => undefined);
      if (own !== undefined) return Array.isArray(own) ? own : [];
      const all = await http.get<ActivityRow[]>("/api/activity").catch(() => []);
      return (Array.isArray(all) ? all : [])
        .filter((a) => a.section === "playbook" && (String(a.entityId ?? "") === String(entry.id) || (!a.entityId && a.entityTitle === entry.name)))
        .slice(0, 50);
    },
    staleTime: 30_000,
  });
  const facts: [string, string][] = [
    [st("history.created"), `${fmtDate(entry.createdAt, "long")}${entry.createdBy ? ` · ${personName(entry.createdBy)}` : entry.trader ? ` · ${personName(entry.trader)}` : ""}`],
  ];
  if (entry.updatedAt) facts.push([st("history.updated"), timeAgo(entry.updatedAt) ?? ""]);
  if (entry.copiedFromAuthor) facts.push([st("history.copiedFrom"), `${copiedFromLabel(entry.copiedFromAuthor)}${entry.copiedFromId ? ` (#${entry.copiedFromId})` : ""}`]);
  if (entry.promotedFromId) facts.push([st("history.promotedFrom"), `#${entry.promotedFromId}`]);
  if (entry.sharedAt && entry.visibility && entry.visibility !== "private") facts.push([st("history.shared"), `${fmtDate(entry.sharedAt, "short")}${entry.sharedBy ? ` · ${personName(entry.sharedBy)}` : ""}`]);
  if (entry.officeProposedAt) facts.push([st("history.proposed"), `${fmtDate(entry.officeProposedAt, "short")}${entry.officeProposedBy ? ` · ${personName(entry.officeProposedBy)}` : ""}`]);
  if (entry.reviewed && entry.reviewedBy) facts.push([st("history.reviewedBy"), personName(entry.reviewedBy)]);

  return (
    <div className="grid gap-[var(--grid-gap)] xl:grid-cols-[minmax(0,1fr)_340px]">
      <DocSection title={st("history.journal")} icon={History} actions={<PlaybookRevisionsButton playbookId={entry.id} currentSnapshot={entry as unknown as Record<string, unknown>} />}>
        {q.isLoading ? (
          <div className="flex flex-col gap-2">{[0, 1, 2].map((i) => <div key={i} className="h-10 animate-pulse rounded-lg bg-[var(--glass-bg)] motion-reduce:animate-none" />)}</div>
        ) : !q.data?.length ? (
          <p className="text-sm text-muted-foreground">{st("history.empty")}</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {q.data.map((a) => (
              <li key={a.id} className="flex items-start gap-3 text-sm">
                <time dateTime={a.createdAt} className="w-24 shrink-0 text-xs tabular-nums text-muted-foreground">{fmtDate(a.createdAt, "numericDateTime")}</time>
                <span className="min-w-0 flex-1">
                  <span className="text-foreground">{activityText(a)}</span>
                  {a.trader && <span className="text-muted-foreground"> · {personName(a.trader)}</span>}
                </span>
              </li>
            ))}
          </ol>
        )}
      </DocSection>
      <DocSection title={st("history.origin")}>
        <div className="divide-y divide-border/60">
          {facts.map(([k, v]) => <StatRow key={k} label={k} value={v} />)}
        </div>
      </DocSection>
    </div>
  );
}

/**
 * «Создан — Мой · папка: X» instead of a bare «Мой · папка: X» (the create log stores only the space / folder).
 * `details` is server-written text (stored, not translated here); the action label follows the UI language.
 */
function activityText(a: ActivityRow): string {
  const label = playbookSetupI18n.tryT(`history.action.${a.action}`) ?? a.action;
  if (!a.details) return label;
  return a.action === "created" && /^(Мой|Офис)(\s|$)/.test(a.details) ? st("history.createdWith", { label, details: a.details }) : a.details; // i18n-ignore (matches stored server text)
}
