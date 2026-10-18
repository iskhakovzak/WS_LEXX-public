import { useMemo, useState } from "react";
import { AlertTriangle, ArrowDownUp, CheckCheck, ClipboardCheck, Clock, Inbox } from "lucide-react";
import { EmptyState, Panel, Pill, Segmented, toneOf, toneText } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { fmtDate, fmtUsd } from "@/lib/format";
import { comparePersonNames, personName } from "@/i18n";
import { commonI18n } from "@/i18n/ns/common";
import { eodI18n } from "@/i18n/ns/eod";
import { DISCIPLINE_LABELS, MOOD_LABELS, hoursText, slaText, useEodQueue, useEodReviewed, type QueueItem } from "./eod-api";
import { EodReviewSheet } from "./EodReviewSheet";
import { PersonSelect } from "@/components/people/person-select";

type Tab = "pending" | "reviewed";
type Sort = "oldest" | "newest";

/**
 * Curator queue: closed days awaiting review (SLA 24 h, oldest first) and the last 7 days of reviews.
 * Filters: trader, «только просроченные», sort. A row opens the review sheet (read-only day + comment + score).
 */
export function EodQueuePanel({ enabled }: { enabled: boolean }) {
  const { t } = eodI18n.useT();
  const { t: tc } = commonI18n.useT();
  const pendingQ = useEodQueue(enabled);
  const [tab, setTab] = useState<Tab>("pending");
  const reviewedQ = useEodReviewed(enabled && tab === "reviewed");
  const [trader, setTrader] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [sort, setSort] = useState<Sort>("oldest");
  const [current, setCurrent] = useState<QueueItem | null>(null);

  const sla = pendingQ.data?.slaHours ?? 24;
  const pending = pendingQ.data?.items ?? [];
  const reviewed = reviewedQ.data?.items ?? [];
  const source = tab === "pending" ? pending : reviewed;

  const traders = useMemo(
    () => Array.from(new Set([...pending, ...reviewed].map((i) => i.trader))).sort(comparePersonNames),
    [pending, reviewed],
  );

  const items = useMemo(() => {
    let rows = source.filter((i) => (!trader || i.trader === trader) && (tab !== "pending" || !overdueOnly || i.overdue));
    const ts = (i: QueueItem) => (tab === "pending" ? i.closedAt : i.reviewedAt ?? i.closedAt) ?? i.date;
    rows = [...rows].sort((a, b) => (ts(a) < ts(b) ? -1 : ts(a) > ts(b) ? 1 : 0));
    // Pending: oldest first by default (SLA order). Reviewed: newest first by default.
    const asc = tab === "pending" ? sort === "oldest" : sort !== "oldest";
    return asc ? rows : rows.reverse();
  }, [source, trader, overdueOnly, sort, tab]);

  const kpi = useMemo(() => {
    const overdue = pending.filter((i) => i.overdue).length;
    const avgWait = pending.length ? pending.reduce((s, i) => s + i.hoursWaiting, 0) / pending.length : null;
    const avgReview = reviewed.length ? reviewed.reduce((s, i) => s + i.hoursWaiting, 0) / reviewed.length : null;
    const inSla = reviewed.length ? reviewed.filter((i) => i.hoursWaiting <= sla).length / reviewed.length : null;
    return { overdue, avgWait, avgReview, inSla };
  }, [pending, reviewed, sla]);

  if (!enabled) return null;
  const loading = tab === "pending" ? pendingQ.isLoading : reviewedQ.isLoading;
  const unavailable = tab === "pending" ? pendingQ.data === null : reviewedQ.data === null && !reviewedQ.isLoading;

  return (
    <>
      <Panel
        title={t("queue.title")}
        icon={ClipboardCheck}
        description={t("queue.desc", { sla })}
        actions={
          <Segmented<Tab>
            size="sm"
            ariaLabel={t("queue.sectionAria")}
            value={tab}
            onChange={setTab}
            options={[
              { value: "pending", label: t("queue.pending"), count: pending.length },
              { value: "reviewed", label: t("queue.reviewed7") },
            ]}
          />
        }
      >
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
            <Kpi label={t("queue.inQueue")} value={pending.length} />
            <Kpi label={t("queue.overdueKpi", { sla })} value={kpi.overdue} tone={kpi.overdue ? "text-warn" : undefined} />
            <Kpi label={t("queue.avgWait")} value={kpi.avgWait != null ? hoursText(kpi.avgWait) : "—"} />
            <Kpi
              label={t("queue.inSla")}
              value={kpi.inSla != null ? `${Math.round(kpi.inSla * 100)}%` : tab === "reviewed" ? "—" : "…"}
              hint={kpi.avgReview != null ? t("queue.avgReview", { time: hoursText(kpi.avgReview) }) : undefined}
            />
          </dl>

          <div className="flex flex-wrap items-center gap-2">
            <PersonSelect value={trader} onValueChange={setTrader} options={traders} allLabel={tc("fields.allTraders")} ariaLabel={tc("fields.trader")} className="h-8 w-44 px-3 text-xs" />
            {tab === "pending" && (
              <button
                type="button"
                aria-pressed={overdueOnly}
                onClick={() => setOverdueOnly((v) => !v)}
                className={cn("chip inline-flex min-h-8 items-center gap-1.5 px-3 text-xs font-medium", overdueOnly && "!border-transparent !bg-warn/15 !text-warn")}
              >
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />{t("queue.overdueOnly")}{kpi.overdue ? ` · ${kpi.overdue}` : ""}
              </button>
            )}
            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setSort((s) => (s === "oldest" ? "newest" : "oldest"))}>
              <ArrowDownUp aria-hidden="true" />{(sort === "oldest") === (tab === "pending") ? t("queue.oldestFirst") : t("queue.newestFirst")}
            </Button>
          </div>

          {loading ? (
            <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-14 w-full rounded-xl" />)}</div>
          ) : unavailable ? (
            <p className="text-sm text-muted-foreground">{t("queue.afterUpdate")}</p>
          ) : items.length === 0 ? (
            <EmptyState
              icon={tab === "pending" ? Inbox : CheckCheck}
              title={tab === "pending" ? (source.length ? t("queue.noMatch") : t("queue.empty")) : t("queue.noReviews")}
              description={tab === "pending" && !source.length ? t("queue.allReviewed") : undefined}
              compact
            />
          ) : (
            <ul className="space-y-1.5">
              {items.map((it) => (
                <QueueRow key={it.id} it={it} sla={sla} mode={tab} onOpen={() => setCurrent(it)} />
              ))}
            </ul>
          )}
        </div>
      </Panel>
      <EodReviewSheet item={current} onClose={() => setCurrent(null)} onNext={(n) => setCurrent(n)} />
    </>
  );
}

function QueueRow({ it, sla, mode, onOpen }: { it: QueueItem; sla: number; mode: Tab; onOpen: () => void }) {
  const { t } = eodI18n.useT();
  const pct = Math.min(100, (it.hoursWaiting / sla) * 100);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          "tile tile-interactive grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-3 py-2.5 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          mode === "pending" && it.overdue && "!border-warn/50",
        )}
      >
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold">{personName(it.trader)}</span>
          <span className="tabular-nums text-muted-foreground">{fmtDate(it.date, "dayMonth")}</span>
          <span className="tabular-nums">{commonI18n.t("units.trades", { count: it.trades })}</span>
          {it.net != null && <span className={cn("tabular-nums font-medium", toneText(toneOf(it.net)))}>{fmtUsd(it.net, { signed: true, decimals: "auto" })}</span>}
          {it.discipline != null && (
            <Pill tone={it.discipline >= 4 ? "up" : it.discipline <= 2 ? "down" : "neutral"} title={DISCIPLINE_LABELS[it.discipline - 1]}>{t("queue.disc", { n: it.discipline })}</Pill>
          )}
          {it.mood != null && <span className="text-muted-foreground">{MOOD_LABELS[it.mood - 1]}</span>}
        </span>
        <span className="flex items-center gap-2">
          {mode === "pending" ? (
            <>
              {it.overdue && <Pill tone="warn">{t("queue.overdue")}</Pill>}
              <span className="tabular-nums text-muted-foreground">
                <Clock className="mr-1 inline h-3 w-3" aria-hidden="true" />{hoursText(it.hoursWaiting)}
              </span>
              <span className="whitespace-nowrap rounded-full bg-primary-solid px-3 py-1 font-medium text-primary-foreground">{t("queue.review")}</span>
            </>
          ) : (
            <>
              {it.curatorScore != null && <Pill tone={it.curatorScore >= 4 ? "up" : it.curatorScore <= 2 ? "down" : "accent"}>{it.curatorScore}/5</Pill>}
              <span className="text-muted-foreground">{personName(it.reviewedBy)}</span>
              <span className={cn("tabular-nums", it.hoursWaiting > sla ? "text-warn" : "text-muted-foreground")}>{t("queue.reviewedIn", { time: hoursText(it.hoursWaiting) })}</span>
            </>
          )}
        </span>
        {mode === "pending" && (
          <span className="col-span-2 flex items-center gap-2">
            <span className="h-1 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
              <span
                className={cn("block h-full rounded-full", it.overdue ? "bg-warn" : pct > 66 ? "bg-warn/60" : "bg-primary/60")}
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className={cn("text-2xs tabular-nums", it.overdue ? "text-warn" : "text-muted-foreground")}>{slaText(it.hoursWaiting, sla)}</span>
          </span>
        )}
      </button>
    </li>
  );
}

function Kpi({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-2xs text-muted-foreground">{label}</dt>
      <dd className={cn("text-lg font-semibold tabular-nums", tone)}>{value}</dd>
      {hint && <dd className="text-2xs text-muted-foreground">{hint}</dd>}
    </div>
  );
}
