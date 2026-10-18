import * as React from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlarmClock, Archive, ArrowRight, BookCheck, CalendarX, ClipboardList, History, Inbox, Layers, ListChecks, ShieldAlert, Users,
} from "lucide-react";
import { BentoGrid, EmptyState, FilterChip, LimitBar, Panel, Pill, StatCard, StatGrid, Tile, usePersistentState } from "@/components/ds";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { UndoToast } from "@/components/undo-toast";
import { curatorApi, curatorKeys, type QueueKind, type Scope, type TodayPayload } from "./api";
import { useCuratorEodReview, type EodTarget } from "./eod-review";
import { QUEUE_LABEL, QUEUE_TONE, curatorLinks, profileHref, riskTone, waitLabel } from "./curator-math";
import { fmtDate, fmtUsd } from "@/lib/format";
import { TemplateDialog } from "./template-dialog";
import { AttentionPanel } from "./attention-panel";
import { curatorI18n } from "@/i18n/ns/curator";
import { personName } from "@/i18n";
import { commonI18n } from "@/i18n/ns/common";

/** Which limit the risk tile should show: the one that triggered the state (drawdown / week), otherwise the daily one. */
function riskBar(r: TodayPayload["risk"]["halted"][number]): { label: string; pct: number | null } {
  const t = curatorI18n.t;
  if (r.state === "drawdown") return { label: t("today.bar.drawdown"), pct: r.drawdownPct };
  if (r.state === "weekly") return { label: t("today.bar.weekly"), pct: r.weeklyPct };
  const worst = [
    { label: t("today.bar.daily"), pct: r.dailyPct },
    { label: t("today.bar.weekly"), pct: r.weeklyPct },
    { label: t("today.bar.drawdown"), pct: r.drawdownPct },
  ].reduce((m, x) => ((x.pct ?? -1) > (m.pct ?? -1) ? x : m));
  return worst.pct != null ? worst : { label: t("today.bar.daily"), pct: r.dailyPct };
}

/** «Сегодня»: what needs the curator now — risk, discipline gaps, the review queue and next steps. */
export function TodayView({ data, scope = "auto", onOpenTrader }: { data: TodayPayload; scope?: Scope | "auto"; onOpenTrader: (trader: string, tab?: string) => void }) {
  const [templateFor, setTemplateFor] = React.useState<string[] | null>(null);
  const [showOld, setShowOld] = React.useState(false);
  const [confirmArchive, setConfirmArchive] = React.useState(false);
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t } = curatorI18n.useT();
  const tc = commonI18n.useT().t;
  const win = data.queueWindow;
  const oldQ = useQuery({ queryKey: curatorKeys.todayOld(scope), queryFn: () => curatorApi.today(scope, true), enabled: showOld, staleTime: 30_000 });
  const fullQueue = showOld && oldQ.data ? oldQ.data.queue : data.queue;
  // Тип элементов очереди — фильтр запоминается (куратор обычно разбирает «сначала все дни» или «сначала нарушения»).
  const [kindFilter, setKindFilter] = usePersistentState<QueueKind | "all">("curator.queueKind", "all");
  const kindCounts = React.useMemo(() => {
    const m: Record<QueueKind, number> = { breach: 0, eod: 0, weekly: 0, academy: 0 };
    for (const q of fullQueue) m[q.kind] += 1;
    return m;
  }, [fullQueue]);
  const activeKind = kindFilter !== "all" && kindCounts[kindFilter] > 0 ? kindFilter : "all";
  const queue = activeKind === "all" ? fullQueue : fullQueue.filter((q) => q.kind === activeKind);
  // Закрытые дни разбираются прямо здесь, в шторке; «Сохранить и следующий» идёт по этой же очереди.
  const eodTargets = React.useMemo<EodTarget[]>(
    () => queue.flatMap((q) => (q.kind === "eod" && q.eodId && q.date ? [{ eodId: q.eodId, trader: q.trader, date: q.date, closedAt: q.since, hoursWaiting: q.hoursWaiting }] : [])),
    [queue],
  );
  const review = useCuratorEodReview(eodTargets);
  const [undo, setUndo] = React.useState<{ ids: string[]; n: number } | null>(null);
  const [restoring, setRestoring] = React.useState(false);
  const archiveOld = useMutation({
    mutationFn: () => curatorApi.archiveOldQueue(scope, win?.days),
    onSuccess: (r) => {
      setShowOld(false);
      if (r.archived && r.ids?.length) setUndo({ ids: r.ids, n: r.archived });
      else toast({ title: r.archived ? t("today.archived", { count: r.archived }) : t("today.nothingOld") });
      void qc.invalidateQueries({ queryKey: curatorKeys.all });
    },
    onError: (e) => toast({ title: t("today.archiveFailed"), description: (e as Error).message, variant: "destructive" }),
  });
  const restore = async () => {
    if (!undo) return;
    setRestoring(true);
    try {
      const r = await curatorApi.restoreQueue(undo.ids);
      toast({ title: t("today.restored", { count: r.restored }) });
    } catch (e) {
      toast({ title: t("today.restoreFailed"), description: (e as Error).message, variant: "destructive" });
    } finally {
      setRestoring(false);
      setUndo(null);
      void qc.invalidateQueries({ queryKey: curatorKeys.all });
    }
  };
  const [showAll, setShowAll] = React.useState<{ queue?: boolean; overdue?: boolean; risk?: boolean }>({});
  const expand = (k: keyof typeof showAll) => setShowAll((s) => ({ ...s, [k]: !s[k] }));
  const c = data.counts;
  const riskCount = c.halted + c.nearStop;
  const riskRows = [...data.risk.halted, ...data.risk.nearStop];

  return (
    <div className="flex flex-col gap-[var(--grid-gap)]">
      <StatGrid cols={6}>
        <StatCard label={t("today.trading")} value={t("today.tradingValue", { n: c.trading, total: c.traders })} icon={Users} hint={data.phase === "weekend" ? t("today.weekend") : undefined} />
        <StatCard
          label={t("today.stopNear")}
          value={`${c.halted} / ${c.nearStop}`}
          tone={c.halted ? "down" : c.nearStop ? "warn" : "neutral"}
          icon={ShieldAlert}
          hint={c.noLimits ? t("today.noLimitsCount", { count: c.noLimits }) : t("today.allHaveLimits")}
        />
        <StatCard
          label={t("today.reviews")}
          value={c.queue}
          tone={c.queueOverdue ? "down" : c.queue ? "accent" : "neutral"}
          icon={Inbox}
          hint={c.queueOverdue ? t("today.overdueSla", { count: c.queueOverdue }) : t("today.withinSla")}
        />
        <StatCard
          label={t("today.dayNotClosed")}
          value={c.missingEod}
          tone={c.missingEod ? "warn" : "neutral"}
          icon={CalendarX}
          hint={t("today.forDate", { date: fmtDate(data.prevDay, "dayMonth") })}
        />
        <StatCard
          label={t("today.noPlan")}
          value={data.plansAvailable ? c.missingPlan : "—"}
          tone={data.plansAvailable && c.missingPlan ? "warn" : "neutral"}
          icon={ClipboardList}
          hint={data.plansAvailable ? (data.phase === "weekend" ? t("today.weekend") : t("today.planHint")) : t("today.noData")}
        />
        <StatCard
          label={t("today.overdue11")}
          value={c.overdueActions}
          tone={c.overdueActions ? "warn" : "neutral"}
          icon={AlarmClock}
          hint={c.overdueActions ? t("today.agreements") : t("today.noOverdue")}
        />
      </StatGrid>

      <BentoGrid>
        <AttentionPanel data={data} onOpenTrader={onOpenTrader} onTemplate={setTemplateFor} />

        <Panel
          className="lg:col-span-5"
          fill
          title={t("today.riskTitle")}
          icon={ShieldAlert}
          description={t("today.riskHint")}
          actions={<Button asChild size="sm" variant="ghost"><Link href="/risk">{t("today.riskDesk")} <ArrowRight className="h-3.5 w-3.5" /></Link></Button>}
        >
          <div className="flex flex-col gap-3">
            {riskCount === 0 && <p className="text-sm text-muted-foreground">{t("today.nobodyAtStop")}</p>}
            {(showAll.risk ? riskRows : riskRows.slice(0, RISK_VISIBLE)).map((r) => {
              const bar = riskBar(r);
              return (
                <Tile key={r.trader} onClick={() => onOpenTrader(r.trader, "risk")} className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{personName(r.trader)}</span>
                    <Pill tone={riskTone(r.state)} dot>{r.label}</Pill>
                    <span className={cn("ml-auto text-sm tabular-nums", (r.pnlNet ?? 0) < 0 ? "text-down" : "text-muted-foreground")} title={t("today.pnlToday")}>
                      {r.pnlNet == null ? t("today.noTradesToday") : fmtUsd(r.pnlNet, { signed: true, decimals: 0 })}
                    </span>
                  </div>
                  <LimitBar size="sm" used={Math.min(bar.pct ?? 0, 100)} limit={100} warnAt={0.7} showValues={false} label={bar.label} hint={bar.pct != null ? `${Math.round(bar.pct)}%` : undefined} />
                  <p className="text-xs text-muted-foreground">{r.message}</p>
                </Tile>
              );
            })}
            {riskRows.length > RISK_VISIBLE && <ShowMore open={!!showAll.risk} rest={riskRows.length - RISK_VISIBLE} onClick={() => expand("risk")} />}
            {data.trading.length > 0 && (
              <div className="flex flex-col gap-1">
                <span className="micro-label">{t("today.tradingNow")}</span>
                <ul className="flex flex-col">
                  {data.trading.map((x) => (
                    <li key={x.trader} className="flex items-center gap-2 border-b border-border/50 py-1.5 text-sm last:border-b-0">
                      <button type="button" className="min-w-0 flex-1 truncate text-left text-foreground hover:text-primary" onClick={() => onOpenTrader(x.trader)} title={personName(x.trader)}>{personName(x.trader)}</button>
                      <span className="text-xs tabular-nums text-muted-foreground">{t("tradesShort", { count: x.trades })}{x.openPositions ? ` · ${t("openShort", { count: x.openPositions })}` : ""}</span>
                      <span className={cn("w-20 text-right tabular-nums", (x.pnlNet ?? 0) > 0 ? "text-up" : (x.pnlNet ?? 0) < 0 ? "text-down" : "text-foreground")}>{fmtUsd(x.pnlNet, { signed: true, decimals: 0 })}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {data.risk.noLimits.length > 0 && (
              <div className="flex flex-col gap-2 rounded-xl border border-warn/30 bg-warn/5 p-3">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-medium text-warn">{t("today.noLimitsCountTitle", { count: data.risk.noLimits.length })}</span>
                  <Button type="button" size="sm" variant="outline" className="ml-auto" onClick={() => setTemplateFor(data.risk.noLimits)}>
                    <Layers className="h-3.5 w-3.5" /> {t("today.applyTemplate")}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">{t("today.noLimitsHint", { names: data.risk.noLimits.map(personName).join(", ") })}</p>
              </div>
            )}
          </div>
        </Panel>

        <Panel
          className="lg:col-span-7"
          fill
          title={t("today.queueTitle")}
          icon={Inbox}
          description={win && !showOld ? t("today.queueHintWindow", { days: win.days }) : t("today.queueHint")}
          actions={<Button asChild size="sm" variant="ghost"><Link href={curatorLinks.journalQueue()}>{t("today.dayQueue")} <ArrowRight className="h-3.5 w-3.5" /></Link></Button>}
        >
          {win && win.old > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <History className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1">
                {showOld
                  ? t("today.oldShown", { count: win.old, days: win.days })
                  : !win.oldOverdue
                    ? t("today.oldHidden", { count: win.old, days: win.days })
                    : win.oldOverdue === win.old
                      ? t("today.oldHiddenAllOverdue", { count: win.old, days: win.days })
                      : t("today.oldHiddenSomeOverdue", { count: win.old, days: win.days, overdue: win.oldOverdue })}
              </span>
              <Button type="button" size="sm" variant="ghost" className="h-7" onClick={() => setShowOld((v) => !v)} disabled={showOld && oldQ.isFetching}>
                {showOld ? (oldQ.isFetching ? tc("states.loading") : t("today.onlyFresh")) : t("today.showOld")}
              </Button>
              <Button type="button" size="sm" variant="outline" className="h-7" onClick={() => setConfirmArchive(true)} disabled={archiveOld.isPending}>
                <Archive className="h-3.5 w-3.5" /> {t("today.archiveOld")}
              </Button>
            </div>
          )}
          {fullQueue.length > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-1.5" role="group" aria-label={t("today.kindAria")}>
              <FilterChip size="sm" active={activeKind === "all"} onClick={() => setKindFilter("all")} count={fullQueue.length}>{t("today.all")}</FilterChip>
              {QUEUE_KIND_ORDER.filter((k) => kindCounts[k] > 0).map((k) => (
                <FilterChip key={k} size="sm" active={activeKind === k} onClick={() => setKindFilter(activeKind === k ? "all" : k)} count={kindCounts[k]}>
                  {t(`queueFilter.${k}`)}
                </FilterChip>
              ))}
              {activeKind === "eod" && eodTargets.length > 1 && (
                <Button type="button" size="sm" className="ml-auto h-8" onClick={() => review.open(eodTargets[0])}>
                  <BookCheck className="h-3.5 w-3.5" /> {t("today.reviewInOrder")}
                </Button>
              )}
            </div>
          )}
          {queue.length === 0 ? (
            <EmptyState
              compact
              icon={BookCheck}
              title={t("today.queueEmpty")}
              description={win?.old ? t("today.queueEmptyOld") : t("today.queueEmptyAll")}
            />
          ) : (
            <ul className="flex flex-col gap-1.5">
              {(showAll.queue ? queue : queue.slice(0, 12)).map((q) => (
                <li key={q.id} className="tile grid min-w-0 grid-cols-[7rem_minmax(0,8rem)_minmax(0,1fr)_5rem_auto] items-center gap-x-3 px-3 py-1.5">
                  <Pill tone={QUEUE_TONE[q.kind]} className="w-full min-w-0 justify-center" title={QUEUE_LABEL[q.kind]}><span className="truncate">{QUEUE_LABEL[q.kind]}</span></Pill>
                  <span className="truncate text-sm font-medium text-foreground" title={personName(q.trader)}>{personName(q.trader)}</span>
                  <span className="truncate text-sm text-muted-foreground" title={q.title}>{q.title.replace(/\d{4}-\d{2}-\d{2}/g, (d) => fmtDate(d, "dayMonth"))}</span>
                  <span
                    className={cn("text-right text-xs tabular-nums", q.overdue ? "font-medium text-down" : "text-muted-foreground")}
                    title={q.overdue ? t("today.overdueTitle", { hours: q.slaHours }) : t("today.waitingTitle", { hours: q.slaHours })}
                  >
                    {waitLabel(q.hoursWaiting)}{q.overdue && <span className="sr-only">{t("today.overdueSr")}</span>}
                  </span>
                  {q.kind === "eod" && q.eodId && q.date ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="shrink-0"
                      title={t("today.reviewHere")}
                      onClick={() => review.open({ eodId: q.eodId!, trader: q.trader, date: q.date!, closedAt: q.since, hoursWaiting: q.hoursWaiting })}
                    >
                      {t("review")}
                    </Button>
                  ) : (
                    <Button asChild size="sm" variant="ghost" className="shrink-0"><Link href={q.href}>{t("review")}</Link></Button>
                  )}
                </li>
              ))}
              {queue.length > 12 && <li><ShowMore open={!!showAll.queue} rest={queue.length - 12} onClick={() => expand("queue")} /></li>}
            </ul>
          )}
          <AlertDialog open={confirmArchive} onOpenChange={setConfirmArchive}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("today.archiveTitle")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {win ? t("today.archiveCount", { count: win.old, days: win.days }) : ""}
                  {t("today.archiveHint")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{tc("actions.cancel")}</AlertDialogCancel>
                <AlertDialogAction onClick={() => archiveOld.mutate()}>{t("today.archive")}</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </Panel>

        <Panel className="lg:col-span-5" fill title={t("today.disciplineTitle")} icon={ListChecks} description={t("today.disciplineHint")}>
          <div className="flex flex-col gap-4">
            <GapList
              title={t("today.notClosedOn", { date: fmtDate(data.prevDay, "dayMonth") })}
              empty={t("today.allClosed")}
              items={data.missingEod.map((m) => ({ key: m.trader, label: personName(m.trader), href: curatorLinks.journalDay(m.trader, m.date) }))}
            />
            {data.openToday.length > 0 && (
              <GapList title={t("today.openToday")} items={data.openToday.map((m) => ({ key: m.trader, label: personName(m.trader), href: curatorLinks.journalDay(m.trader, m.date) }))} />
            )}
            {data.plansAvailable && data.phase !== "weekend" && (
              <GapList
                title={t("today.noPlanToday")}
                empty={t("today.allPlans")}
                items={data.missingPlan.map((m) => ({ key: m.trader, label: personName(m.trader), meta: m.status === "draft" ? t("today.draft") : undefined }))}
                onOpen={(t) => onOpenTrader(t, "journal")}
              />
            )}
            <div className="flex flex-col gap-1.5">
              <span className="micro-label">{t("today.overdueAgreements")}</span>
              {data.overdueActions.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("today.noOverdueAgreements")}</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {(showAll.overdue ? data.overdueActions : data.overdueActions.slice(0, 6)).map((a) => (
                    <li key={a.id} className="flex min-w-0 items-center gap-2 text-sm">
                      <button type="button" title={personName(a.trader)} className="w-24 shrink-0 truncate text-left font-medium text-foreground hover:text-primary" onClick={() => onOpenTrader(a.trader, "academy")}>{personName(a.trader)}</button>
                      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={a.title}>{a.title}</span>
                      <span className="shrink-0 text-xs tabular-nums text-down">{t("today.overdueDays", { count: a.daysOverdue })}</span>
                    </li>
                  ))}
                  {data.overdueActions.length > 6 && <li><ShowMore open={!!showAll.overdue} rest={data.overdueActions.length - 6} onClick={() => expand("overdue")} /></li>}
                </ul>
              )}
            </div>
          </div>
        </Panel>
      </BentoGrid>

      <TemplateDialog open={!!templateFor} onOpenChange={(v) => { if (!v) setTemplateFor(null); }} traders={templateFor ?? []} />
      {review.sheet}
      {undo && (
        <UndoToast
          label={t("today.undoLabel", { count: undo.n })}
          actionText={t("today.undoAction")}
          restoring={restoring}
          onUndo={() => void restore()}
          onDismiss={() => setUndo(null)}
        />
      )}
    </div>
  );
}

const RISK_VISIBLE = 4;
const QUEUE_KIND_ORDER: QueueKind[] = ["breach", "eod", "weekly", "academy"];

function GapList({ title, items, empty, onOpen }: {
  title: string;
  items: { key: string; label: string; href?: string; meta?: string }[];
  empty?: string;
  onOpen?: (trader: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="micro-label">{title}{items.length ? ` · ${items.length}` : ""}</span>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((i) => {
            const body = <>{i.label}{i.meta && <span className="text-muted-foreground"> · {i.meta}</span>}</>;
            if (i.href) return <Link key={i.key} href={i.href} className="chip inline-flex min-h-7 items-center px-2.5 text-xs font-medium">{body}</Link>;
            return (
              <button key={i.key} type="button" onClick={() => onOpen?.(i.key)} className="chip inline-flex min-h-7 items-center px-2.5 text-xs font-medium">
                {body}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export { profileHref };

function ShowMore({ open, rest, onClick }: { open: boolean; rest: number; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="px-1 text-xs text-primary hover:underline">
      {open ? commonI18n.t("actions.collapse") : curatorI18n.t("showMore", { count: rest })}
    </button>
  );
}
