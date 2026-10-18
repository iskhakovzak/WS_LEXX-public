import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, ArrowRight, CheckCircle2, Database, Download, FileJson, History, Plug, RefreshCw, Settings2, ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { DataTable, EmptyState, FilterChip, ListSkeleton, Panel, Pill, StatRow, type Tone } from "@/components/ds";
import { useToast } from "@/hooks/use-toast";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import { useRuns, useStatus } from "@/components/propreports/api";
import { http } from "@/lib/api/http";
import { adminUrl, downloadBlob, timeAgo } from "./api";
import { useDataQuality, useHealth, type DataCheck } from "./console-api";
import { fmtCount, fmtDate } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { adminJobsI18n } from "@/i18n/ns/adminJobs";
import { adminI18n } from "@/i18n/ns/admin";
import { actorName } from "./audit-text";
import { personName } from "@/i18n";
import { JobsPanel } from "./JobsPanel";

/** Export table keys (sent to the server as is; labels: adminI18n `data.exportTables.*`). */
const EXPORT_TABLES = [
  "trades", "playbook", "tradeIdeas", "watchlist", "marketEvents", "research", "tradingRules",
  "big7Tickers", "big7Levels", "big7Catalysts", "users",
] as const;

/**
 * «Данные и интеграции»: PropReports status/schedule (read-only — imports, account mapping and reconciliation
 * live on /integrations, the single place for PropReports operations), import history, data-quality checks,
 * exports and backups.
 */
export function DataPanel({ actor, isAdmin }: { actor: string; isAdmin: boolean }) {
  const { t } = adminI18n.useT();
  return (
    <div className="flex flex-col gap-[var(--grid-gap)]">
      <div className="grid grid-cols-1 gap-[var(--grid-gap)] xl:grid-cols-2">
        <IntegrationStatusCard />
        <ImportHistoryCard />
      </div>
      <DataQualityCard />
      <JobsPanel isAdmin={isAdmin} />
      <div className="grid grid-cols-1 gap-[var(--grid-gap)] xl:grid-cols-2">
        <ExportCard actor={actor} />
        <BackupsCard actor={actor} isAdmin={isAdmin} />
      </div>
      <Panel title={t("data.tools.title")} icon={Settings2}>
        <ul className="grid grid-cols-1 gap-x-4 md:grid-cols-3">
          {[
            { href: "/integrations", label: t("data.tools.integrations"), desc: t("data.tools.integrationsHint") },
            { href: "/error-tracker", label: t("data.tools.rules"), desc: t("data.tools.rulesHint") },
            { href: "/scaling", label: t("data.tools.scaling"), desc: t("data.tools.scalingHint") },
          ].map((it) => (
            <li key={it.href}>
              <Link href={it.href} className="group flex items-center gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-[var(--glass-bg)]">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{it.label}</div>
                  <div className="text-xs text-muted-foreground">{it.desc}</div>
                </div>
                <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

function IntegrationStatusCard() {
  const { t } = adminI18n.useT();
  const status = useStatus();
  const health = useHealth();
  const st = status.data;
  const errors = health.data?.errors24h;
  return (
    <Panel
      title={t("data.status.title")}
      icon={Plug}
      fill
      description={t("data.status.description")}
      actions={<Button asChild variant="outline" size="sm"><Link href="/integrations">{t("data.tools.integrations")} <ArrowRight /></Link></Button>}
    >
      {status.isError ? (
        <QueryError error={status.error} onRetry={() => status.refetch()} />
      ) : !st ? (
        <ListSkeleton rows={5} dense />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col">
            <StatRow
              label={t("data.status.api")}
              value={st.config.configured
                ? <Pill tone="up" dot>{t("data.status.configured", { mode: st.config.authMode === "token" ? t("data.status.token") : t("data.status.login") })}</Pill>
                : <Pill tone="neutral">{t("data.status.notConfigured")}</Pill>}
            />
            {!st.config.configured && st.config.missing.length > 0 && (
              <p className="pb-1 text-xs text-muted-foreground">
                {t("data.status.missingEnv", { vars: st.config.missing.join(", ") })}
              </p>
            )}
            <StatRow
              label={t("data.status.schedule")}
              value={st.scheduler.enabled
                ? t("data.status.every", { minutes: st.scheduler.minutes ?? 0 })
                : st.config.syncMinutes ? t("data.status.everyStopped", { minutes: st.config.syncMinutes }) : t("data.status.off")}
              tone={st.scheduler.enabled ? "up" : "neutral"}
            />
            {st.scheduler.enabled && (
              <StatRow label={t("data.status.next")} value={st.scheduler.running ? t("data.status.runningNow") : st.scheduler.nextRunAt ? fmtDate(st.scheduler.nextRunAt, "numericDateTime") : "—"} />
            )}
            <StatRow label={t("data.status.lastSync")} value={st.lastRun ? t("data.status.lastSyncValue", { ago: timeAgo(st.lastRun.startedAt), source: st.lastRun.source === "file" ? t("data.status.file") : "API" }) : t("data.status.never")} />
            <StatRow label={t("data.status.imported")} value={fmtCount(Number(st.trades.imported))} />
            <StatRow
              label={t("data.status.accounts")}
              value={`${t("data.status.accountsValue", { mapped: st.accounts.mapped, total: st.accounts.total })}${st.settings.unmatched.length ? t("data.status.accountsNew", { count: st.settings.unmatched.length }) : ""}`}
              tone={st.accounts.unmapped.length || st.settings.unmatched.length ? "warn" : "neutral"}
            />
            <StatRow label={t("data.status.pending")} value={st.pendingCount} tone={st.pendingCount ? "warn" : "neutral"} />
            <StatRow label={t("data.status.fees")} value={st.settings.feesConfirmedAt ? t("data.status.feesConfirmed") : t("data.status.feesNotConfirmed")} tone={st.settings.feesConfirmedAt ? "neutral" : "warn"} />
          </div>
          <div className="rounded-xl bg-[var(--glass-bg)] p-3">
            <div className="mb-1 flex items-center justify-between gap-2 text-xs">
              <span className="font-medium text-foreground">{t("data.status.errors24h")}</span>
              <Pill tone={errors?.count ? "down" : "up"}>{errors ? errors.count : "—"}</Pill>
            </div>
            {errors && errors.items.length > 0 ? (
              <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
                {errors.items.slice(0, 5).map((e, i) => (
                  <li key={i} className="break-words">{e.at ? `${fmtDate(e.at, "numericDateTime")} · ` : ""}{e.text}</li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">{t("data.status.noErrors")}</p>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}

const RUN_TONE: Record<string, Tone> = { ok: "up", partial: "warn", error: "down", running: "accent" };

function ImportHistoryCard() {
  const { t } = adminI18n.useT();
  const runs = useRuns(10);
  return (
    <Panel
      title={t("data.history.title")}
      icon={History}
      fill
      description={t("data.history.description")}
      actions={<Button asChild variant="ghost" size="sm"><Link href="/integrations?tab=history">{t("data.history.all")} <ArrowRight /></Link></Button>}
    >
      {runs.isError ? (
        <QueryError error={runs.error} onRetry={() => runs.refetch()} />
      ) : runs.isLoading ? (
        <ListSkeleton rows={4} dense />
      ) : !runs.data?.length ? (
        <EmptyState compact icon={History} title={t("data.history.empty")} description={t("data.history.emptyHint")} />
      ) : (
        <DataTable ariaLabel={t("data.history.title")} maxHeight={360}>
          <table>
            <thead>
              <tr>
                <th scope="col">{t("data.history.col.when")}</th>
                <th scope="col">{t("data.history.col.result")}</th>
                <th scope="col" className="text-right" title={t("data.history.colTitle.inserted")}>{t("data.history.col.inserted")}</th>
                <th scope="col" className="text-right" title={t("data.history.colTitle.updated")}>{t("data.history.col.updated")}</th>
                <th scope="col" className="text-right" title={t("data.history.colTitle.conflicts")}>{t("data.history.col.conflicts")}</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.map((r) => {
                const s = { label: adminI18n.tryT(`data.runStatus.${r.status}`) ?? r.status, tone: RUN_TONE[r.status] ?? ("neutral" as Tone) };
                return (
                  <tr key={r.id}>
                    <td className="max-w-[11rem]">
                      <div className="whitespace-nowrap tabular-nums" title={fmtDate(r.startedAt, "shortDateTimeSeconds")}>{fmtDate(r.startedAt, "numericDateTime")}</div>
                      <div className="truncate text-2xs text-muted-foreground" title={[r.fileName, r.actor ? actorName(r.actor) : null].filter(Boolean).join(" · ") || undefined}>
                        {r.source === "file" ? (r.fileName ?? t("data.history.file")) : "API"}{r.actor ? ` · ${actorName(r.actor)}` : ""}
                      </div>
                    </td>
                    <td>
                      <Pill tone={s.tone} dot>{s.label}</Pill>
                      {r.errorText && <div className="max-w-[20rem] whitespace-normal break-words text-2xs text-down">{r.errorText}</div>}
                    </td>
                    <td className="text-right tabular-nums">{r.inserted}</td>
                    <td className="text-right tabular-nums">{r.updated}</td>
                    <td className="text-right tabular-nums">{r.conflicts || <span className="text-muted-foreground">0</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </DataTable>
      )}
    </Panel>
  );
}

const SEVERITY_TONE: Record<DataCheck["severity"], Tone> = { high: "down", medium: "warn", low: "neutral" };

const CHECK_LINK: Record<string, { href: string; label: "linkAccounts" | "linkReconcile" }> = {
  no_trader: { href: "/integrations?tab=accounts", label: "linkAccounts" },
  unmapped_account: { href: "/integrations?tab=accounts", label: "linkAccounts" },
  unknown_trader: { href: "/integrations?tab=accounts", label: "linkAccounts" },
  duplicates: { href: "/integrations?tab=reconcile", label: "linkReconcile" },
  pending_reconcile: { href: "/integrations?tab=reconcile", label: "linkReconcile" },
};

function sampleText(row: Record<string, unknown>): string {
  const t = adminI18n.t;
  if (Array.isArray(row.ids)) return t("data.quality.sampleDup", { trader: row.trader ? personName(String(row.trader)) : "?", ticker: String(row.ticker ?? ""), date: String(row.date ?? ""), count: Number(row.n) || 0, ids: `#${(row.ids as unknown[]).join(", #")}` });
  if (row.account && row.n != null) return t("data.quality.sampleAccount", { account: String(row.account), trades: commonI18n.t("units.trades", { count: Number(row.n) }) });
  const parts = [row.date, row.ticker, row.trader ? personName(String(row.trader)) : t("data.quality.noTrader")];
  if (row.openedDate) parts.push(t("data.quality.opened", { date: String(row.openedDate) }));
  if (row.exitDate) parts.push(t("data.quality.exit", { date: String(row.exitDate) }));
  return parts.filter(Boolean).map(String).join(" · ");
}

function DataQualityCard() {
  const { t } = adminI18n.useT();
  const quality = useDataQuality();
  const [showAll, setShowAll] = useState(false);
  const checks = quality.data?.checks ?? [];
  const problems = checks.filter((c) => c.count > 0);
  const visible = showAll ? checks : problems;
  return (
    <Panel
      title={t("data.quality.title")}
      icon={ShieldCheck}
      description={t("data.quality.description")}
      actions={
        <>
          {checks.length > 0 && <FilterChip active={showAll} onClick={() => setShowAll((v) => !v)}>{t("data.quality.allChecks")}</FilterChip>}
          <Button variant="outline" size="icon" className="h-8 w-8" aria-label={t("data.quality.recheck")} onClick={() => quality.refetch()} disabled={quality.isFetching}>
            <RefreshCw className={cn(quality.isFetching && "animate-spin motion-reduce:animate-none")} />
          </Button>
        </>
      }
    >
      {quality.isError ? (
        <QueryError error={quality.error} onRetry={() => quality.refetch()} />
      ) : quality.isLoading ? (
        <ListSkeleton rows={4} />
      ) : quality.data === null || quality.data === undefined ? (
        <EmptyState compact icon={AlertTriangle} title={t("data.quality.notConnected")} description={t("data.quality.notConnectedHint")} />
      ) : visible.length === 0 ? (
        <EmptyState compact icon={CheckCircle2} title={t("data.quality.clean")} description={t("data.quality.cleanHint", { count: checks.length, at: fmtDate(quality.data.generatedAt, "numericDateTime") })} />
      ) : (
        <ul className="flex flex-col gap-2">
          {visible.map((c) => {
            const sevKey = SEVERITY_TONE[c.severity] ? c.severity : "low";
            const sev = { tone: SEVERITY_TONE[sevKey], label: t(`data.quality.severity.${sevKey}`) };
            const link = CHECK_LINK[c.key];
            return (
              <li key={c.key} className="rounded-xl bg-[var(--glass-bg)] p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{c.label}</span>
                  <Pill tone={c.count ? sev.tone : "up"}>{c.count ? (c.groups ? t("data.quality.inGroups", { count: c.count, groups: c.groups }) : c.count) : t("data.quality.ok")}</Pill>
                  {c.count > 0 && <span className="text-2xs uppercase tracking-wide text-muted-foreground">{sev.label}</span>}
                  {link && c.count > 0 && (
                    <Button asChild variant="ghost" size="sm" className="ml-auto h-7">
                      <Link href={link.href}>{t(`data.quality.${link.label}`)} <ArrowRight /></Link>
                    </Button>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">{c.hint}</p>
                {c.sample.length > 0 && (
                  <details className="mt-1.5 text-xs">
                    <summary className="cursor-pointer text-muted-foreground hover:text-foreground">{t("data.quality.examples", { count: Math.min(c.sample.length, 25) })}</summary>
                    <ul className="mt-1 flex flex-col gap-0.5 tabular-nums">
                      {c.sample.slice(0, 25).map((row, i) => (
                        <li key={i} className="break-words">
                          {typeof row.id === "number"
                            ? <Link href={links.trade(row.id)} className="text-primary underline-offset-2 hover:underline">#{row.id}</Link>
                            : null}{" "}
                          {sampleText(row)}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function ExportCard({ actor }: { actor: string }) {
  const { toast } = useToast();
  const { t } = adminI18n.useT();
  const qc = useQueryClient();
  const [picked, setPicked] = useState<Set<string>>(() => new Set(EXPORT_TABLES));
  const [busy, setBusy] = useState(false);
  const all = picked.size === EXPORT_TABLES.length;

  const toggle = (k: string) => setPicked((s) => {
    const n = new Set(s);
    if (n.has(k)) n.delete(k); else n.add(k);
    return n;
  });

  async function run() {
    if (!picked.size) return;
    setBusy(true);
    try {
      const text = (await http.get<string | null>(adminUrl("/admin/db-export", actor, { tables: all ? undefined : [...picked].join(",") }), { responseType: "text" })) ?? "";
      const day = new Date().toISOString().slice(0, 10);
      downloadBlob(text, `ws-lexx-${all ? "backup" : "export"}-${day}.json`, "application/json");
      let summary = "";
      try {
        const j = JSON.parse(text) as { summary?: Record<string, number> };
        const total = Object.values(j.summary ?? {}).reduce((s, v) => s + v, 0);
        summary = commonI18n.t("units.entries", { count: total });
      } catch { /* ignore */ }
      qc.invalidateQueries({ queryKey: ["admin-audit"] });
      toast({ title: t("data.export.done"), description: summary || undefined });
    } catch (e) {
      toast({ title: t("data.export.failed"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title={t("data.export.title")}
      description={t("data.export.description")}
      icon={FileJson}
      fill
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("data.export.tablesAria")}>
          <FilterChip active={all} onClick={() => setPicked(all ? new Set() : new Set(EXPORT_TABLES))}>{t("data.export.all")}</FilterChip>
          {EXPORT_TABLES.map((k) => (
            <FilterChip key={k} active={picked.has(k)} onClick={() => toggle(k)}>{t(`data.exportTables.${k}`)}</FilterChip>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            {all ? t("data.export.full") : t("data.export.some", { count: picked.size, total: EXPORT_TABLES.length })} · {t("data.export.note")}
          </span>
          <Button onClick={run} disabled={busy || !picked.size}>
            <Download /> {busy ? t("data.export.preparing") : t("data.export.download")}
          </Button>
        </div>
      </div>
    </Panel>
  );
}

/** `file` = name + extension (.dump for pg_dump -Fc, .sql.gz for older backups); absent on older API builds. */
interface BackupMeta { name: string; objectName: string; file?: string; createdAt: string; sizeKb: number }

function fmtMsk(iso: string) {
  try {
    return adminI18n.t("data.backups.msk", { date: fmtDate(iso, "shortDateTime", { timeZone: "Europe/Moscow" }) });
  } catch { return iso; }
}

function BackupsCard({ actor, isAdmin }: { actor: string; isAdmin: boolean }) {
  const { t: tj } = adminJobsI18n.useT();
  const { t } = adminI18n.useT();
  const { toast } = useToast();
  const [triggering, setTriggering] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const { data: backups, isLoading, isError, error, refetch, isFetching } = useQuery<BackupMeta[]>({
    queryKey: ["admin-backups", actor],
    queryFn: ({ signal }) => http.get<BackupMeta[]>(adminUrl("/admin/backups", actor), { signal }),
    retry: false,
  });

  async function trigger() {
    setTriggering(true);
    try {
      const d = await http.post<{ name: string; sizeKb: number }>(adminUrl("/admin/backups/trigger", actor));
      toast({ title: t("data.backups.created"), description: `${d.name} · ${t("data.backups.size", { size: fmtCount(d.sizeKb) })}` });
      refetch();
    } catch (e) {
      toast({ title: commonI18n.t("states.error"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setTriggering(false);
    }
  }

  async function download(name: string, file: string) {
    setDownloading(name);
    try {
      const d = await http.get<{ url: string }>(adminUrl(`/admin/backups/${encodeURIComponent(name)}/download`, actor));
      const a = document.createElement("a");
      a.href = d.url;
      a.download = file;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (e) {
      toast({ title: t("data.backups.downloadFailed"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setDownloading(null);
    }
  }

  return (
    <Panel
      title={t("data.backups.title")}
      description={tj("backups.description")}
      icon={Database}
      fill
      actions={
        <>
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t("data.backups.refresh")} onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={cn(isFetching && "animate-spin motion-reduce:animate-none")} />
          </Button>
          {isAdmin && (
            <Button variant="outline" size="sm" onClick={trigger} disabled={triggering} data-testid="button-trigger-backup">
              {triggering ? t("data.backups.creating") : t("data.backups.create")}
            </Button>
          )}
        </>
      }
    >
      {isLoading ? (
        <div className="flex flex-col gap-2">{[0, 1].map((i) => <Skeleton key={i} className="h-11 w-full rounded-xl" />)}</div>
      ) : isError ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-down">
          {error instanceof Error ? error.message : t("data.backups.loadFailed")}
          <Button variant="link" size="sm" onClick={() => refetch()}>{commonI18n.t("actions.retry")}</Button>
        </div>
      ) : !backups || backups.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {tj("backups.empty")}{isAdmin ? ` ${tj("backups.emptyAdmin")}` : ""} {tj("backups.emptyHint")}
          {!isAdmin && <span className="mt-1 block text-xs">{t("data.backups.adminOnly")}</span>}
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          <ul className="flex flex-col">
            {backups.map((b, i) => (
              <li key={b.name} className="flex items-center justify-between gap-2 rounded-xl px-2 py-2 hover:bg-[var(--glass-bg)]">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm tabular-nums">
                    {fmtMsk(b.createdAt)}
                    {i === 0 && <Pill tone="up">{t("data.backups.latest")}</Pill>}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">{t("data.backups.size", { size: fmtCount(b.sizeKb) })} · {b.file ?? `${b.name}.sql.gz`}</div>
                </div>
                {isAdmin && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => download(b.name, b.file ?? `${b.name}.sql.gz`)}
                    disabled={downloading === b.name}
                    aria-label={t("data.backups.downloadAria", { name: b.name })}
                    data-testid={`button-download-backup-${b.name}`}
                  >
                    <Download /> {downloading === b.name ? "…" : "SQL.GZ"}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <p className="px-2 pt-1 text-xs text-muted-foreground">{t("data.backups.restore")} <code>pg_restore</code> {t("data.backups.or")} <code>psql</code></p>
        </div>
      )}
    </Panel>
  );
}
