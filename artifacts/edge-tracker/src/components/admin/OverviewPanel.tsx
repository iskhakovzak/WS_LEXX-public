import { motion, useReducedMotion } from "framer-motion";
import { Link } from "wouter";
import {
  AlertTriangle, ArrowRight, BookX, CheckCircle2, ClipboardCheck, Clock, Database, Flag, Gauge, Link2, ListChecks,
  Plug, ScrollText, ServerCrash, ShieldAlert, Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { EmptyState, Panel, Pill, StatCard, StatGrid, StatRow, type Tone } from "@/components/ds";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import { timeAgo, type DeskPulse, type Overview, type RiskDeskLite } from "./api";
import { actorName, describeAudit } from "./audit-text";
import type { DataCheck, EodStatus, HealthData } from "./console-api";
import type { TraderFilter } from "./TradersTable";
import { fmtCount, fmtDate } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { adminI18n } from "@/i18n/ns/admin";
import { personName } from "@/i18n";

export type AdminTab = "overview" | "people" | "moderation" | "roles" | "data" | "audit" | "errors";

/** People (display names) or accounts (unchanged: personName leaves non-names as they are). */
function names(raw: string[], max = 4) {
  const list = raw.map(personName);
  if (list.length <= max) return list.join(", ");
  return adminI18n.t("namesMore", { names: list.slice(0, max).join(", "), count: list.length - max });
}

type Go = (tab: AdminTab, filter?: TraderFilter) => void;
type QueueCount = { count: number; overdue: number; slaHours: number } | null | undefined;

/**
 * Traders who traded on the EOD date (last finished trading day) but have not closed it — same rule as the curator
 * cabinet. With `pulse`, only desk traders count (staff who trade don't close an EOD).
 */
export function eodNotClosed(eod: EodStatus | null | undefined, pulse?: DeskPulse): string[] {
  if (!eod) return [];
  const staff = new Set((pulse?.users ?? []).filter((u) => u.role !== "trader").map((u) => u.name));
  return eod.traders.filter((t) => t.status === "open" && t.trades > 0 && !staff.has(t.trader)).map((t) => t.trader);
}

/** Four desk KPIs — short labels so nothing truncates at 1280–1440 px. */
export function KpiRow({
  pulse, risk, eod, queue, loading, onGo,
}: {
  pulse: DeskPulse | undefined;
  risk: RiskDeskLite | null | undefined;
  eod: EodStatus | null | undefined;
  queue: QueueCount;
  loading: boolean;
  onGo: Go;
}) {
  const { t } = adminI18n.useT();
  const s = pulse?.summary;
  const notClosed = eodNotClosed(eod, pulse);
  return (
    <StatGrid cols={4}>
      <StatCard
        loading={loading && !s}
        label={t("kpi.activeToday")}
        icon={Users}
        value={s ? <span>{s.activeToday}<span className="text-base font-medium text-muted-foreground"> / {s.deskTraders}</span></span> : "—"}
        tone={s && s.deskTraders && s.activeToday === s.deskTraders ? "up" : "neutral"}
        hint={s ? t("kpi.tradesToday", { trades: commonI18n.t("units.trades", { count: s.tradesToday }) }) : undefined}
        onClick={() => onGo("people", "traders")}
      />
      <StatCard
        loading={eod === undefined}
        label={t("kpi.dayNotClosed")}
        icon={BookX}
        value={eod ? notClosed.length : "—"}
        tone={!eod ? "neutral" : notClosed.length ? "warn" : "up"}
        hint={!eod ? t("kpi.eodUnavailable") : notClosed.length ? t("kpi.eodNames", { date: eod.date, names: names(notClosed, 2) }) : t("kpi.eodAllClosed", { date: eod.date })}
      />
      <StatCard
        loading={queue === undefined}
        label={t("kpi.review")}
        icon={ClipboardCheck}
        value={queue ? queue.count : "—"}
        tone={!queue ? "neutral" : queue.overdue ? "down" : queue.count ? "warn" : "up"}
        delta={queue?.overdue ? t("kpi.overdue", { count: queue.overdue }) : undefined}
        deltaTone="down"
        hint={queue ? (queue.count ? t("kpi.sla", { hours: queue.slaHours }) : t("kpi.queueEmpty")) : t("kpi.queueUnavailable")}
      />
      <StatCard
        loading={risk === undefined}
        label={t("kpi.risk")}
        icon={Gauge}
        value={risk ? risk.summary.breach : "—"}
        tone={!risk ? "neutral" : risk.summary.breach > 0 ? "down" : risk.summary.warn > 0 ? "warn" : "up"}
        delta={risk && risk.summary.warn > 0 ? t("kpi.near", { count: risk.summary.warn }) : undefined}
        deltaTone="warn"
        hint={!risk ? t("kpi.riskUnavailable") : risk.summary.breach > 0 ? t("kpi.breaches", { count: risk.summary.breach }) : t("kpi.noBreaches")}
      />
    </StatGrid>
  );
}

type AttentionItem = {
  key: string;
  tone: Tone;
  icon: typeof Flag;
  title: string;
  detail?: string;
  action?: { label: string; go?: () => void; href?: string };
};

function buildItems({
  pulse, overview, risk, health, eod, queue, quality, onGo,
}: {
  pulse: DeskPulse | undefined; overview: Overview | undefined; risk: RiskDeskLite | null | undefined; health: HealthData | undefined;
  eod: EodStatus | null | undefined; queue: QueueCount; quality: DataCheck[] | null | undefined; onGo: Go;
}): AttentionItem[] {
  const t = adminI18n.t;
  type ActionKey = "review" | "riskDesk" | "queue" | "journal" | "details" | "integrations" | "map" | "reconcile" | "check" | "show" | "list";
  const A = (k: ActionKey) => t(`attention.action.${k}`);
  const items: AttentionItem[] = [];
  const s = pulse?.summary;
  const reports = s?.openReports ?? overview?.openReports ?? 0;
  if (reports > 0) items.push({ key: "reports", tone: "down", icon: Flag, title: t("attention.reports", { count: reports }), action: { label: A("review"), go: () => onGo("moderation") } });

  const breach = risk?.traders.filter((t) => t.status === "breach").map((t) => t.trader) ?? [];
  if (breach.length) items.push({ key: "risk", tone: "down", icon: Gauge, title: t("attention.riskBreach", { count: breach.length }), detail: names(breach), action: { label: A("riskDesk"), href: links.risk() } });

  if (queue?.overdue) items.push({ key: "sla", tone: "down", icon: ClipboardCheck, title: t("attention.slaOverdue", { count: queue.overdue }), detail: t("attention.slaDetail", { hours: queue.slaHours, count: queue.count }), action: { label: A("queue"), href: "/journal?view=queue" } });
  else if (queue?.count) items.push({ key: "queue", tone: "warn", icon: ClipboardCheck, title: t("attention.queueWaiting", { count: queue.count }), detail: t("kpi.sla", { hours: queue.slaHours }), action: { label: A("queue"), href: "/journal?view=queue" } });

  const notClosed = eodNotClosed(eod, pulse);
  if (notClosed.length) items.push({ key: "eod", tone: "warn", icon: BookX, title: t("attention.eodOpen", { date: eod!.date, count: notClosed.length }), detail: names(notClosed), action: { label: A("journal"), href: "/journal" } });

  if (health) {
    const sy = health.sync;
    if (health.errors24h.count) items.push({ key: "errors", tone: "down", icon: ServerCrash, title: t("attention.errors24h", { count: health.errors24h.count }), detail: health.errors24h.items[0]?.text, action: { label: A("details"), go: () => onGo("data") } });
    if (sy.lastRun && (sy.lastRun.status === "error" || sy.lastRun.status === "partial")) {
      items.push({ key: "sync-failed", tone: "down", icon: Plug, title: sy.lastRun.status === "error" ? t("attention.syncFailed") : t("attention.syncPartial"), detail: sy.lastRun.errorText ?? undefined, action: { label: A("integrations"), href: "/integrations?tab=history" } });
    }
    const unmatched = sy.unmatched.length + sy.accounts.unmapped.length;
    if (unmatched) items.push({ key: "accounts", tone: "warn", icon: Link2, title: t("attention.unmappedAccounts", { count: unmatched }), detail: names([...sy.unmatched, ...sy.accounts.unmapped]), action: { label: A("map"), go: () => onGo("people") } });
    if (sy.pending) items.push({ key: "pending", tone: "warn", icon: Database, title: t("attention.pending", { count: sy.pending }), detail: t("attention.pendingDetail"), action: { label: A("reconcile"), href: "/integrations?tab=reconcile" } });
    const lastAt = sy.lastRun?.startedAt ?? sy.lastSyncedAt;
    const staleDays = lastAt ? Math.floor((Date.now() - Date.parse(lastAt)) / 86_400_000) : null;
    if (!lastAt) items.push({ key: "nosync", tone: "warn", icon: Plug, title: t("attention.noSync"), action: { label: A("integrations"), href: "/integrations" } });
    else if (staleDays != null && staleDays >= 3) items.push({ key: "stale-sync", tone: "warn", icon: Plug, title: t("attention.staleSync", { days: staleDays }), detail: sy.configured ? t("attention.staleConfigured") : t("attention.staleManual"), action: { label: A("integrations"), href: "/integrations" } });
  }

  const high = (quality ?? []).filter((c) => c.severity === "high" && c.count > 0);
  if (high.length) items.push({ key: "quality", tone: "warn", icon: AlertTriangle, title: t("attention.quality", { items: high.map((c) => t("attention.qualityItem", { label: c.label.toLowerCase(), count: c.count })).join("; ") }), action: { label: A("check"), go: () => onGo("data") } });

  if (pulse) {
    const violToday = pulse.users.filter((u) => u.violationsToday > 0).map((u) => u.name);
    if (violToday.length) items.push({ key: "viol", tone: "warn", icon: ShieldAlert, title: t("attention.violationsToday", { count: violToday.length }), detail: names(violToday), action: { label: A("show"), go: () => onGo("people", "violations") } });
    if (s && s.stale.length) items.push({ key: "stale", tone: "neutral", icon: Clock, title: t("attention.stale", { count: s.stale.length }), detail: names(s.stale), action: { label: A("list"), go: () => onGo("people", "stale") } });
  }
  return items;
}

function AttentionRow({ it, i, reduce }: { it: AttentionItem; i: number; reduce: boolean | null }) {
  const Icon = it.icon;
  return (
    <motion.li
      initial={reduce ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: reduce ? 0 : i * 0.03, ease: [0.2, 0.8, 0.2, 1] }}
      className="flex items-center gap-3 rounded-xl bg-[var(--glass-bg)] p-3"
    >
      <span className={cn(
        "grid h-9 w-9 shrink-0 place-items-center rounded-lg",
        it.tone === "down" ? "bg-down/15 text-down" : it.tone === "warn" ? "bg-[hsl(var(--chart-3)/0.15)] text-[hsl(var(--chart-3))]" : "bg-[var(--glass-bg)] text-muted-foreground",
      )}>
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{it.title}</div>
        {it.detail && <div className="truncate text-xs text-muted-foreground" title={it.detail}>{it.detail}</div>}
      </div>
      {it.action && (it.action.href ? (
        <Button asChild variant="ghost" size="sm" className="shrink-0">
          <Link href={it.action.href}>{it.action.label} <ArrowRight /></Link>
        </Button>
      ) : (
        <Button variant="ghost" size="sm" onClick={it.action.go} className="shrink-0">
          {it.action.label} <ArrowRight />
        </Button>
      ))}
    </motion.li>
  );
}

function SyncPanel({ health, error, onGo }: { health: HealthData | undefined; error: unknown; onGo: Go }) {
  const { t } = adminI18n.useT();
  const sy = health?.sync;
  const run = sy?.lastRun;
  const runTone: Tone = !run ? "neutral" : run.status === "ok" ? "up" : run.status === "running" ? "accent" : "down";
  const runLabel = !run ? "—" : t(`sync.status.${run.status === "ok" || run.status === "running" || run.status === "partial" ? run.status : "error"}`);
  return (
    <Panel
      title="PropReports"
      icon={Plug}
      description={t("sync.description")}
      actions={<Button asChild variant="ghost" size="sm"><Link href="/integrations">{t("attention.action.integrations")} <ArrowRight /></Link></Button>}
    >
      {error ? (
        <p className="py-2 text-sm text-muted-foreground">{t("sync.unavailable")}</p>
      ) : !sy ? (
        <div className="flex flex-col gap-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-6 w-full rounded-lg" />)}</div>
      ) : (
        <div className="flex flex-col">
          <StatRow
            label={t("sync.lastSync")}
            value={run ? (
              <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
                <Pill tone={runTone} dot>{runLabel}</Pill>
                <span className="tabular-nums" title={run.startedAt ? fmtDate(run.startedAt, "shortDateTimeSeconds") : undefined}>{timeAgo(run.startedAt)}</span>
              </span>
            ) : t("sync.never")}
          />
          {run && (
            <StatRow
              label={run.source === "file" ? t("sync.fromFile") : t("sync.viaApi")}
              value={<span className="tabular-nums">{t("sync.runCounts", { inserted: fmtCount(Number(run.inserted)), updated: fmtCount(Number(run.updated)) })}{run.conflicts ? t("sync.runConflicts", { count: run.conflicts }) : ""}</span>}
            />
          )}
          <StatRow label={t("sync.imported")} value={<span className="tabular-nums">{fmtCount(Number(sy.imported))}</span>} />
          <StatRow
            label={t("sync.accounts")}
            value={<span className="tabular-nums">{t("sync.accountsMapped", { mapped: sy.accounts.mapped, total: sy.accounts.total })}{sy.unmatched.length ? t("sync.accountsNew", { count: sy.unmatched.length }) : ""}</span>}
            tone={sy.accounts.unmapped.length || sy.unmatched.length ? "warn" : "neutral"}
          />
          <StatRow
            label={t("sync.auto")}
            value={sy.scheduler.enabled
              ? `${t("sync.autoEvery", { minutes: sy.scheduler.minutes ?? 0 })}${sy.scheduler.nextRunAt ? t("sync.autoNext", { at: fmtDate(sy.scheduler.nextRunAt, "numericDateTime") }) : ""}`
              : sy.configured ? t("sync.autoOff") : t("sync.autoNotSet")}
            tone={sy.scheduler.enabled ? "up" : "neutral"}
          />
          <StatRow
            label={t("sync.errors24h")}
            value={health!.errors24h.count ? <button type="button" className="text-down underline-offset-2 hover:underline" onClick={() => onGo("data")}>{health!.errors24h.count}</button> : t("sync.errorsNone")}
            tone={health!.errors24h.count ? "down" : "up"}
          />
        </div>
      )}
    </Panel>
  );
}

export function OverviewPanel({
  pulse, overview, risk, health, eod, queue, quality, pulseError, healthError, overviewError, onRetry, onGo, tierNames,
}: {
  pulse: DeskPulse | undefined;
  overview: Overview | undefined;
  risk: RiskDeskLite | null | undefined;
  health: HealthData | undefined;
  eod: EodStatus | null | undefined;
  queue: QueueCount;
  quality: DataCheck[] | null | undefined;
  pulseError: unknown;
  healthError: unknown;
  overviewError: unknown;
  onRetry: () => void;
  onGo: Go;
  tierNames?: Record<string, string>;
}) {
  const { t } = adminI18n.useT();
  const reduce = useReducedMotion();
  const items = buildItems({ pulse, overview, risk, health, eod, queue, quality, onGo });
  const loading = !pulse && !pulseError && !health && !healthError;

  return (
    // items-start: the right column must not stretch to the height of the attention list (empty glass bug).
    <div className="grid grid-cols-1 items-start gap-[var(--grid-gap)] lg:grid-cols-5">
      <Panel title={t("attention.title")} icon={ListChecks} className="lg:col-span-3" description={t("attention.description")}>
        {pulseError && !health ? (
          <QueryError error={pulseError} onRetry={onRetry} />
        ) : loading ? (
          <div className="flex flex-col gap-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 w-full rounded-xl" />)}</div>
        ) : items.length === 0 ? (
          <EmptyState icon={CheckCircle2} title={t("attention.allClear")} description={t("attention.allClearHint")} className="py-8" />
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((it, i) => <AttentionRow key={it.key} it={it} i={i} reduce={reduce} />)}
          </ul>
        )}
      </Panel>

      <div className="flex flex-col gap-[var(--grid-gap)] lg:col-span-2">
        <SyncPanel health={health} error={healthError} onGo={onGo} />

        <Panel
          title={t("recent.title")}
          icon={ScrollText}
          actions={<Button variant="ghost" size="sm" onClick={() => onGo("audit")}>{t("recent.all")} <ArrowRight /></Button>}
        >
          {overviewError ? (
            <QueryError error={overviewError} onRetry={onRetry} />
          ) : !overview ? (
            <div className="flex flex-col gap-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-9 w-full rounded-xl" />)}</div>
          ) : overview.recent.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">{t("recent.empty")}</p>
          ) : (
            <ul className="-my-1 divide-y divide-border/50">
              {overview.recent.slice(0, 6).map((e) => {
                const x = describeAudit(e, tierNames);
                return (
                  <li key={e.id} className="flex items-start gap-3 py-2.5">
                    <span className="w-20 shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground" title={fmtDate(e.createdAt, "shortDateTimeSeconds")}>
                      {timeAgo(e.createdAt)}
                    </span>
                    <div className="min-w-0 flex-1 text-sm">
                      <span className="font-medium">{actorName(e.actor)}</span> <span className="text-foreground/90">{x.text}</span>
                      {x.detail && <div className="truncate text-xs text-muted-foreground" title={x.detail}>{x.detail}</div>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
