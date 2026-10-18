/**
 * Playbook home blocks (right pane of the library when no setup is open):
 *   PlaybookInbox — «Разобрать сделки»: the viewer's recent trades that are not an example of any setup yet, with a
 *                   suggested setup + tier; one click «В плейбук» per row, or select several → one dialog.
 *                   Doubles as the weekly nudge (count for the last 7 days in the header).
 *   Tier1Strip    — the newest Tier 1 examples of the current space, «Вся галерея» → gallery view.
 * Data: GET /api/playbook-tools/inbox, GET /api/playbook-tools/gallery?tier=1.
 */
import * as React from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { BookOpen, CheckCircle2, EyeOff, Inbox, Sparkles, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ToastAction } from "@/components/ui/toast";
import { IconAction } from "@/components/playbook-sub/bits";
import { useToast } from "@/hooks/use-toast";
import { Panel, Pill, Segmented, SortableTh, toneText, useTableSort } from "@/components/ds";
import { addDays, nyDate } from "@/lib/trading-date";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import { notLiveMessage, useGallery, usePlaybookInbox, type InboxTrade } from "./api";
import { http } from "@/lib/api/http";
import { ExampleCard, checklistOf } from "./examples-board";
import { AddTradesToPlaybookDialog } from "./quick-add";
import { moneyTone, tierMeta, type PlaybookEntry, type SpaceTab } from "./model";
import { fmtDate, fmtR, fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { playbookI18n } from "@/i18n/ns/playbook";

import { personName } from "@/i18n";
type Days = "7" | "14" | "30";

const ACCESSORS = {
  date: (t: InboxTrade) => t.closeDate ?? t.date,
  ticker: (t: InboxTrade) => t.ticker,
  setup: (t: InboxTrade) => t.setup ?? t.autoSetup ?? null,
  suggestion: (t: InboxTrade) => t.suggestion?.name ?? null,
  r: (t: InboxTrade) => t.signedR,
  net: (t: InboxTrade) => (t.redacted ? null : t.netPnl),
};
type SortKey = keyof typeof ACCESSORS;

export function PlaybookInbox({ onNewSetup }: {
  /** «Новый сетап из сделки»: the page opens its setup form; the trade is attached as an example on save. */
  onNewSetup?: (t: InboxTrade) => void;
} = {}) {
  const { t: tr } = playbookI18n.useT();
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [days, setDays] = React.useState<Days>("14");
  const q = usePlaybookInbox(Number(days));
  const data = q.data;
  const trades = React.useMemo(() => data?.trades ?? [], [data]);
  const { rows, thProps } = useTableSort<InboxTrade, SortKey>(trades, ACCESSORS, "date", "desc", { ticker: "asc", setup: "asc", suggestion: "asc" });
  const [selected, setSelected] = React.useState<Set<number>>(new Set());
  const [dialog, setDialog] = React.useState<{ ids: number[]; preset: number | null } | null>(null);
  React.useEffect(() => { setSelected((prev) => new Set([...prev].filter((id) => trades.some((t) => t.id === id)))); }, [trades]);

  const weekFrom = addDays(nyDate(), -7);
  const week = trades.filter((t) => (t.closeDate ?? t.date).slice(0, 10) >= weekFrom).length;
  const allOn = rows.length > 0 && rows.every((t) => selected.has(t.id));

  // Older API (no inbox) or nobody to review for (staff without own trades): hide the block entirely.
  if (data === null || (data && !data.trader)) return null;
  // Nothing to review in the default window: stay out of the way (switching the period still shows the empty line).
  if (data && data.total === 0 && days === "14") return null;
  if (q.isError) return null;

  const openOne = (t: InboxTrade) => setDialog({ ids: [t.id], preset: t.suggestion?.id ?? null });
  /** «Не для плейбука»: the trade leaves the inbox (server-side mark), with an undo in the toast. */
  async function dismiss(ids: number[]) {
    if (!ids.length) return;
    const call = (method: "POST" | "DELETE") => http.send(method, "/api/playbook-tools/inbox/dismiss", { tradeIds: ids });
    try {
      await call("POST");
      setSelected((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
      qc.invalidateQueries({ queryKey: ["playbook-inbox"] });
      toast({
        title: ids.length === 1 ? tr("inbox.hiddenOne") : tr("inbox.hiddenMany", { count: ids.length }),
        description: tr("inbox.hiddenDesc"),
        action: (
          <ToastAction
            altText={tr("inbox.undoAlt")}
            onClick={async () => {
              try { await call("DELETE"); qc.invalidateQueries({ queryKey: ["playbook-inbox"] }); }
              catch (e) { toast({ title: tr("inbox.undoFailed"), description: (e as Error)?.message, variant: "destructive" }); }
            }}
          >
            {tr("inbox.undo")}
          </ToastAction>
        ),
      });
    } catch (e) {
      toast({ title: tr("inbox.hideFailed"), description: notLiveMessage(e) ?? (e as Error)?.message, variant: "destructive" });
    }
  }
  const openSelected = () => {
    const ids = rows.filter((t) => selected.has(t.id)).map((t) => t.id);
    if (!ids.length) return;
    const sug = new Set(rows.filter((t) => selected.has(t.id)).map((t) => t.suggestion?.id ?? 0));
    setDialog({ ids, preset: sug.size === 1 ? [...sug][0] || null : null });
  };

  return (
    <Panel
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          {tr("inbox.title")}
          {data && data.total > 0 && <Pill tone="accent">{data.total}</Pill>}
        </span>
      }
      description={
        data && data.total > 0
          ? week > 0 && days !== "7"
            ? tr("inbox.descWithWeek", { trades: commonI18n.t("units.trades", { count: week }) })
            : tr("inbox.descWithTrades")
          : tr("inbox.descEmpty")
      }
      icon={Inbox}
      actions={<Segmented<Days> ariaLabel={tr("inbox.periodAria")} size="sm" value={days} onChange={setDays} options={(["7", "14", "30"] as Days[]).map((d) => ({ value: d, label: tr("inbox.days", { count: d }) }))} />}
      footer={selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm tabular-nums text-muted-foreground">{tr("inbox.selected", { count: selected.size })}</span>
          <Button size="sm" className="ml-auto h-9 bg-primary-solid" onClick={openSelected}>
            <BookOpen className="h-4 w-4" aria-hidden="true" /> {tr("inbox.toPlaybookN", { count: selected.size })}
          </Button>
          <Button size="sm" variant="outline" className="h-9" onClick={() => dismiss(rows.filter((t) => selected.has(t.id)).map((t) => t.id))} title={tr("inbox.dismissSelectedTitle")}>
            <EyeOff className="h-4 w-4" aria-hidden="true" /> {tr("inbox.notForPlaybook")}
          </Button>
          <Button size="sm" variant="ghost" className="h-9" onClick={() => setSelected(new Set())}>{tr("inbox.clearSelection")}</Button>
        </div>
      ) : undefined}
    >
      {q.isLoading ? (
        <div className="flex flex-col gap-1.5" aria-busy="true">
          {Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-11 animate-pulse rounded-xl bg-[var(--glass-bg)] motion-reduce:animate-none" />)}
        </div>
      ) : !trades.length ? (
        <p className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
          <CheckCircle2 className="h-4 w-4 text-up" aria-hidden="true" /> {tr("inbox.allDone", { count: days })}
        </p>
      ) : (
        <div className="-mx-[var(--panel-p)] max-h-[min(62dvh,560px)] overflow-auto overscroll-contain">
          <table className="w-full min-w-[560px] border-separate border-spacing-0 text-sm tabular-nums">
            <thead className="[&_th]:sticky [&_th]:top-0 [&_th]:z-raised [&_th]:border-b [&_th]:border-[var(--glass-border)] [&_th]:bg-surface-solid [&_th]:px-2 [&_th]:py-2 [&_th]:text-left [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
              <tr>
                <th className="w-10 !pl-[var(--panel-p)]">
                  <Checkbox aria-label={allOn ? tr("inbox.deselectAll") : tr("inbox.selectAll")} checked={allOn} onCheckedChange={() => setSelected(allOn ? new Set() : new Set(rows.map((t) => t.id)))} />
                </th>
                <SortableTh {...thProps("date")}>{tr("inbox.colDate")}</SortableTh>
                <SortableTh {...thProps("ticker")}>{tr("inbox.colTicker")}</SortableTh>
                <SortableTh {...thProps("setup")} className="hidden 2xl:table-cell">{tr("inbox.colLabel")}</SortableTh>
                <SortableTh {...thProps("suggestion")}>{tr("inbox.colSuggestion")}</SortableTh>
                <SortableTh {...thProps("r")} align="right">R</SortableTh>
                <SortableTh {...thProps("net")} align="right">{tr("inbox.colNet")}</SortableTh>
                <th className="!pr-[var(--panel-p)] text-right"><span className="sr-only">{tr("inbox.colAction")}</span></th>
              </tr>
            </thead>
            <tbody className="[&_td]:border-b [&_td]:border-border/40 [&_td]:px-2 [&_td]:py-1.5 [&_tr:last-child_td]:border-b-0">
              {rows.map((t) => {
                const on = selected.has(t.id);
                const tier = tierMeta(t.suggestedTier);
                const short = (t.side ?? "").toLowerCase().startsWith("s");
                return (
                  <tr key={t.id} className={cn("transition-colors hover:bg-[var(--tile-hover-bg)]", on && "bg-primary/5")}>
                    <td className="!pl-[var(--panel-p)]">
                      <Checkbox
                        aria-label={tr("inbox.selectRow", { ticker: t.ticker, date: fmtDate(t.closeDate ?? t.date, "dayMonthNumeric") })}
                        checked={on}
                        onCheckedChange={() => setSelected((prev) => { const n = new Set(prev); if (n.has(t.id)) n.delete(t.id); else n.add(t.id); return n; })}
                      />
                    </td>
                    <td className="whitespace-nowrap text-muted-foreground">{fmtDate(t.closeDate ?? t.date, "dayMonthNumeric")}</td>
                    <td className="max-w-[200px] whitespace-nowrap">
                      <button type="button" className="max-w-[160px] truncate align-bottom font-semibold text-foreground hover:underline" onClick={() => navigate(links.trade(t.id))} title={tr("inbox.openTrade", { ticker: t.ticker })}>
                        {t.ticker}
                      </button>
                      {t.side && <span className={cn("ml-1.5 text-xs", short ? "text-down" : "text-up")}>{short ? "S" : "L"}</span>}
                    </td>
                    <td className="hidden max-w-[180px] truncate text-xs text-muted-foreground 2xl:table-cell" title={t.autoSetup ? tr("inbox.autoSetup", { setup: t.autoSetup }) : undefined}>
                      {t.setup ?? t.autoSetup ?? "—"}
                    </td>
                    <td className="max-w-[260px]">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className={cn("shrink-0 text-xs font-semibold", toneText(tier.tone))} title={tier.hint}>{tier.short}</span>
                        {t.suggestion ? (
                          <span className="min-w-0 truncate text-xs text-foreground" title={t.suggestion.reason}>
                            <Sparkles className="mr-1 inline h-3 w-3 text-primary" aria-hidden="true" />{t.suggestion.name}
                          </span>
                        ) : <span className="text-xs text-muted-foreground">{tr("inbox.pickSetup")}</span>}
                      </span>
                    </td>
                    <td className={cn("whitespace-nowrap text-right font-medium", toneText(moneyTone(t.signedR)))}>{fmtR(t.signedR)}</td>
                    <td className={cn("whitespace-nowrap text-right", toneText(moneyTone(t.redacted ? null : t.netPnl)))}>{t.redacted ? "—" : fmtUsd(t.netPnl, { signed: true, decimals: 0 })}</td>
                    <td className="!pr-[var(--panel-p)] text-right">
                      <span className="inline-flex items-center justify-end gap-1">
                        <IconAction
                          aria-label={tr("inbox.rowDismissAria", { ticker: t.ticker })}
                          title={tr("inbox.rowDismissTitle")}
                          onClick={() => dismiss([t.id])}
                          className="h-8 w-8 [&_svg]:h-3.5 [&_svg]:w-3.5"
                        >
                          <EyeOff />
                        </IconAction>
                        <Button size="sm" variant="outline" className="h-8 gap-1.5 px-2.5" onClick={() => openOne(t)} aria-label={tr("inbox.rowAddAria", { ticker: t.ticker })} title={tr("inbox.rowAddAria", { ticker: t.ticker })}>
                          <BookOpen className="h-3.5 w-3.5" aria-hidden="true" /> <span className="hidden 2xl:inline">{tr("inbox.toPlaybook")}</span>
                        </Button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {data && data.total > trades.length && (
            <p className="px-[var(--panel-p)] pt-2 text-xs text-muted-foreground">{tr("inbox.shownOf", { shown: trades.length, total: data.total })}</p>
          )}
        </div>
      )}
      <AddTradesToPlaybookDialog
        open={!!dialog}
        onOpenChange={(v) => { if (!v) setDialog(null); }}
        tradeIds={dialog?.ids ?? []}
        presetSetupId={dialog?.preset ?? null}
        onDone={() => setSelected(new Set())}
        onNewSetup={onNewSetup && dialog?.ids.length === 1 ? () => { const t = trades.find((x) => x.id === dialog.ids[0]); if (t) onNewSetup(t); } : undefined}
      />
    </Panel>
  );
}

function serverSpace(scope: SpaceTab): string | null {
  return scope === "office" ? "office" : scope === "mine" ? "personal" : scope === "shared" ? "shared" : null;
}

export function Tier1Strip({
  scope, entries, viewerName, onOpenSetup, onOpenGallery,
}: {
  scope: SpaceTab;
  entries: PlaybookEntry[];
  viewerName: string | null;
  onOpenSetup: (id: number) => void;
  onOpenGallery: () => void;
}) {
  const { t } = playbookI18n.useT();
  const q = useGallery({ tier: 1, space: serverSpace(scope), limit: 24 });
  const byId = React.useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);
  const items = React.useMemo(() => {
    const all = q.data ?? [];
    return (scope === "team" ? all.filter((x) => x.setupSpace === "personal" && x.setupOwner !== viewerName) : all).slice(0, 6);
  }, [q.data, scope, viewerName]);
  if (q.isError || (!q.isLoading && !items.length)) return null;
  return (
    <Panel
      title={t("tier1Strip.title")}
      description={t("tier1Strip.description")}
      icon={Trophy}
      actions={<Button variant="ghost" size="sm" className="h-8" onClick={onOpenGallery}>{t("tier1Strip.allGallery")}</Button>}
    >
      {q.isLoading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-3" aria-busy="true">
          {[0, 1, 2].map((i) => <div key={i} className="h-44 animate-pulse rounded-xl bg-[var(--glass-bg)] motion-reduce:animate-none" />)}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-3">
          {items.map((ex) => {
            const setup = byId.get(ex.playbookId);
            return (
              <ExampleCard
                key={ex.id}
                ex={ex}
                setupId={ex.playbookId}
                checklist={setup ? checklistOf(setup) : []}
                editable={false}
                compact
                header={
                  <button
                    type="button"
                    onClick={() => onOpenSetup(ex.playbookId)}
                    className="-mx-1 truncate rounded px-1 text-left text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {ex.setupName ?? setup?.name ?? t("setupN", { id: ex.playbookId })}
                    {ex.setupSpace === "personal" && ex.setupOwner && ex.setupOwner !== viewerName && <span className="font-normal text-muted-foreground"> · {personName(ex.setupOwner)}</span>}
                  </button>
                }
              />
            );
          })}
        </div>
      )}
    </Panel>
  );
}
