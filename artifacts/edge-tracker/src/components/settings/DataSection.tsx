import * as React from "react";
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  AlertTriangle, Archive, BookOpen, CalendarDays, CheckCircle2, Database, Download, FileJson, FileSearch, Info,
  LineChart, ListChecks, MessagesSquare, Newspaper, ScrollText, Target, Upload, XCircle, Eye,
} from "lucide-react";
import { useListDailyFeed, useListDiscussions, useListEvents, useListResearch, useListTrades } from "@workspace/api-client-react";
import { useTradesBookFacets } from "@/hooks/use-trades-window";
import { Panel, Pill, Segmented, SortableTh, StatCard, useTableSort } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/contexts/auth-context";
import { useToast } from "@/hooks/use-toast";
import { ApiError, http } from "@/lib/api/http";
import { STALE } from "@/lib/api/keys";
import { downloadBlob } from "@/lib/download";
import { cn } from "@/lib/utils";
import { Callout } from "./shared";
import { fmtCount, fmtDate } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { settingsI18n } from "@/i18n/ns/settings";

/** Serialises an array of flat-ish JSON records to CSV (RFC 4180 quoting, UTF-8 BOM for Excel). */
function toCsv(rows: Record<string, unknown>[]): string {
  const headers: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!headers.includes(k)) headers.push(k);
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(cell).join(","), ...rows.map((r) => headers.map((h) => cell(r[h])).join(","))];
  return "﻿" + lines.join("\r\n");
}

function saveText(text: string, mime: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  downloadBlob(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type Period = "all" | "30" | "90" | "365";

type ExportKey = "trades" | "events" | "research" | "dailyfeed" | "discussions" | "watchlist" | "playbook" | "errors" | "big7";
const EXPORTS: { key: ExportKey; endpoint: string; filename: string; icon: React.ElementType }[] = [
  { key: "trades", endpoint: "/trades", filename: "trades", icon: LineChart },
  { key: "events", endpoint: "/events", filename: "events", icon: CalendarDays },
  { key: "research", endpoint: "/research", filename: "research", icon: FileSearch },
  { key: "dailyfeed", endpoint: "/dailyfeed", filename: "dailyfeed", icon: Newspaper },
  { key: "discussions", endpoint: "/discussions", filename: "discussions", icon: MessagesSquare },
  { key: "watchlist", endpoint: "/watchlist", filename: "watchlist", icon: Eye },
  { key: "playbook", endpoint: "/playbook", filename: "playbook", icon: BookOpen },
  { key: "errors", endpoint: "/errors", filename: "trading-errors", icon: ListChecks },
  { key: "big7", endpoint: "/big7levels", filename: "big7-levels", icon: Target },
];

function cutoffFor(p: Period): string | null {
  if (p === "all") return null;
  const d = new Date();
  d.setDate(d.getDate() - Number(p));
  return d.toISOString().slice(0, 10);
}

function ExportTile({ item, period, count }: { item: (typeof EXPORTS)[number]; period: Period; count?: number }) {
  const { t } = settingsI18n.useT();
  const label = t(`data.exports.${item.key}`);
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  async function run() {
    setLoading(true);
    try {
      let data: unknown;
      try {
        data = await http.get<unknown>(`/api${item.endpoint}`);
      } catch (e) {
        if (e instanceof ApiError && e.status >= 400) {
          toast({ title: t("data.downloadFailed", { name: label }), description: e.message, variant: "destructive" });
          return;
        }
        throw e;
      }
      if (!Array.isArray(data)) throw new Error("bad shape");
      const cutoff = cutoffFor(period);
      const rows = (data as Record<string, unknown>[]).filter((r) => {
        if (!cutoff) return true;
        const d = r.date ?? r.createdAt ?? r.created_at;
        return typeof d !== "string" || d.slice(0, 10) >= cutoff;
      });
      if (rows.length === 0) { toast({ title: t("data.noDataForPeriod", { name: label }) }); return; }
      const suffix = period === "all" ? "" : `-${period}d`;
      const filename = `${item.filename}${suffix}-${new Date().toISOString().slice(0, 10)}.csv`;
      saveText(toCsv(rows), "text/csv;charset=utf-8", filename);
      toast({ title: t("data.downloaded", { file: filename }), description: t("data.rows", { count: rows.length }) });
    } catch {
      toast({ title: t("data.exportError"), description: t("data.exportFailed", { name: label }), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }
  return (
    <button type="button" onClick={run} disabled={loading} aria-label={t("data.downloadCsvAria", { name: label })}
      className="lift group flex items-center gap-3 rounded-xl bg-[var(--glass-bg)] px-3 py-3 text-left hover:bg-[var(--glass-hover-bg)] disabled:opacity-60">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--glass-thick-bg)] text-muted-foreground group-hover:text-primary">
        <item.icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{label}</span>
        <span className="block text-xs text-muted-foreground tabular-nums">{count != null ? commonI18n.t("units.entries", { count }) : "CSV"}</span>
      </span>
      <Download className={cn("h-4 w-4 shrink-0 text-muted-foreground", loading && "motion-safe:animate-pulse")} aria-hidden="true" />
    </button>
  );
}

// ─── Backup inspector (dry run, local) ───────────────────────────────────────

type TableCheck = { key: string; rows: number; ids: number; duplicateIds: number; missingIds: number; minId: number | null; maxId: number | null };
type Inspection = {
  fileName: string;
  sizeKb: number;
  format: "db-export" | "legacy";
  exportedAt: string | null;
  database: string | null;
  tables: TableCheck[];
  summaryMismatch: string[];
  unknownKeys: string[];
};

/** Backup table key → name in the UI language (unknown tables show their key). */
const tableLabel = (key: string) => settingsI18n.tryT(`data.tables.${key}`) ?? key;

function checkTable(key: string, rows: unknown[]): TableCheck {
  const seen = new Set<number>();
  let dup = 0, missing = 0, min: number | null = null, max: number | null = null;
  for (const r of rows) {
    const id = r && typeof r === "object" ? Number((r as Record<string, unknown>).id) : NaN;
    if (!Number.isFinite(id)) { missing++; continue; }
    if (seen.has(id)) dup++;
    seen.add(id);
    min = min == null ? id : Math.min(min, id);
    max = max == null ? id : Math.max(max, id);
  }
  return { key, rows: rows.length, ids: seen.size, duplicateIds: dup, missingIds: missing, minId: min, maxId: max };
}

function inspect(fileName: string, size: number, data: unknown): Inspection {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(settingsI18n.t("data.notBackupObject"));
  const obj = data as Record<string, unknown>;
  const isDbExport = !!obj.tables && typeof obj.tables === "object" && !Array.isArray(obj.tables);
  const source = (isDbExport ? obj.tables : obj) as Record<string, unknown>;
  const tables: TableCheck[] = [];
  const unknownKeys: string[] = [];
  for (const [k, v] of Object.entries(source)) {
    if (Array.isArray(v)) tables.push(checkTable(k, v));
    else if (isDbExport) unknownKeys.push(k);
  }
  if (tables.length === 0) throw new Error(settingsI18n.t("data.noTables"));
  const summaryMismatch: string[] = [];
  if (isDbExport && obj.summary && typeof obj.summary === "object") {
    for (const [k, v] of Object.entries(obj.summary as Record<string, unknown>)) {
      const t = tables.find((x) => x.key === k);
      if (typeof v === "number" && (!t || t.rows !== v)) summaryMismatch.push(settingsI18n.t("data.summaryMismatch", { table: tableLabel(k), expected: v, actual: t?.rows ?? 0 }));
    }
  }
  return {
    fileName, sizeKb: Math.round(size / 1024), format: isDbExport ? "db-export" : "legacy",
    exportedAt: typeof obj.exportedAt === "string" ? obj.exportedAt : null,
    database: typeof obj.database === "string" ? obj.database : null,
    tables: tables.sort((a, b) => b.rows - a.rows), summaryMismatch, unknownKeys,
  };
}

const NO_TABLES: TableCheck[] = [];

function BackupInspector({ current }: { current: Record<string, number | undefined> }) {
  const { t } = settingsI18n.useT();
  const [result, setResult] = useState<Inspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const accessors = React.useMemo(() => ({
    name: (t: TableCheck) => tableLabel(t.key),
    rows: (t: TableCheck) => t.rows,
    now: (t: TableCheck) => current[t.key] ?? null,
    // problems first when sorted desc
    check: (t: TableCheck) => t.duplicateIds * 2 + t.missingIds,
  }), [current]);
  const sort = useTableSort(result?.tables ?? NO_TABLES, accessors, "rows", "desc", { name: "asc" });

  function readFile(file: File) {
    setError(null);
    setResult(null);
    if (file.size > 200 * 1024 * 1024) { setError(t("data.tooBig")); return; }
    const reader = new FileReader();
    reader.onload = (ev) => {
      try { setResult(inspect(file.name, file.size, JSON.parse(String(ev.target?.result ?? "")))); }
      catch (e) { setError(e instanceof SyntaxError ? t("data.notJson") : e instanceof Error ? e.message : t("data.parseFailed")); }
      if (fileRef.current) fileRef.current.value = "";
    };
    reader.onerror = () => setError(t("data.readFailed"));
    reader.readAsText(file, "utf-8");
  }

  const totalRows = result?.tables.reduce((a, t) => a + t.rows, 0) ?? 0;
  const issues = result ? result.tables.filter((t) => t.duplicateIds || t.missingIds).length + result.summaryMismatch.length : 0;

  return (
    <div className="flex flex-col gap-3">
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) readFile(f); }}
        className={cn("flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-6 text-center transition-colors",
          drag ? "border-primary bg-primary/10" : "border-border")}
      >
        <FileJson className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm text-foreground">{t("data.dropHere")}</p>
        <p className="text-xs text-muted-foreground">{t("data.localOnly")}</p>
        <input ref={fileRef} id="backup-inspect-input" type="file" accept=".json,application/json" className="sr-only"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); }} />
        <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()} className="gap-1.5">
          <Upload className="h-3.5 w-3.5" aria-hidden="true" /> {t("data.chooseFile")}
        </Button>
      </div>

      {error && <Callout tone="down" icon={XCircle}>{error}</Callout>}

      {result && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{result.fileName}</span>
            <Pill>{t("data.kb", { size: fmtCount(result.sizeKb) })}</Pill>
            <Pill tone={result.format === "db-export" ? "accent" : "warn"}>{result.format === "db-export" ? t("data.fullBackup") : t("data.oldFormat")}</Pill>
            {result.exportedAt && <span>{t("data.from", { date: fmtDate(result.exportedAt) })}</span>}
            {result.database && <span>{t("data.database", { name: result.database })}</span>}
          </div>
          <Callout tone={issues ? "warn" : "up"} icon={issues ? AlertTriangle : CheckCircle2}>
            {issues
              ? t("data.issues", { count: issues })
              : t("data.fileOk", { tables: t("data.tablesCount", { count: result.tables.length }), rows: t("data.rows", { count: totalRows }) })}
          </Callout>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <SortableTh {...sort.thProps("name")} className="py-2 pr-3 font-normal">{t("data.colTable")}</SortableTh>
                  <SortableTh {...sort.thProps("rows")} align="right" className="py-2 pr-3 font-normal">{t("data.colInFile")}</SortableTh>
                  <SortableTh {...sort.thProps("now")} align="right" className="py-2 pr-3 font-normal">{t("data.colNow")}</SortableTh>
                  <th scope="col" className="py-2 pr-3 font-normal">id</th>
                  <SortableTh {...sort.thProps("check")} className="py-2 font-normal">{t("data.colCheck")}</SortableTh>
                </tr>
              </thead>
              <tbody>
                {sort.rows.map((t) => {
                  const now = current[t.key];
                  const ok = !t.duplicateIds && !t.missingIds;
                  return (
                    <tr key={t.key} className="border-b border-border/60 last:border-0">
                      <th scope="row" className="py-2 pr-3 text-left font-medium text-foreground">{tableLabel(t.key)}</th>
                      <td className="py-2 pr-3 text-right tabular-nums">{fmtCount(t.rows)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
                        {now != null ? (
                          <span className={cn(now < t.rows && "text-down")}>{fmtCount(now)}</span>
                        ) : "—"}
                      </td>
                      <td className="whitespace-nowrap py-2 pr-3 text-xs tabular-nums text-muted-foreground">{t.minId != null ? `${t.minId}–${t.maxId}` : "—"}</td>
                      <td className="py-2">
                        {ok ? <Pill tone="up">{settingsI18n.t("data.ok")}</Pill> : (
                          <span className="flex flex-wrap gap-1">
                            {t.duplicateIds > 0 && <Pill tone="down">{settingsI18n.t("data.dupIds", { count: t.duplicateIds })}</Pill>}
                            {t.missingIds > 0 && <Pill tone="warn">{settingsI18n.t("data.noIds", { count: t.missingIds })}</Pill>}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {result.summaryMismatch.length > 0 && (
            <Callout tone="warn" icon={AlertTriangle}><ul className="space-y-0.5">{result.summaryMismatch.map((m) => <li key={m}>{m}</li>)}</ul></Callout>
          )}
          <p className="text-xs text-muted-foreground">{t("data.nowHint")}</p>
        </div>
      )}
    </div>
  );
}

type ServerBackup = { name: string; createdAt: string; sizeKb: number };

function ServerSnapshots() {
  const { t } = settingsI18n.useT();
  const { data, isLoading, isError } = useQuery<ServerBackup[]>({
    queryKey: ["admin", "backups", "settings"],
    queryFn: ({ signal }) => http.get<ServerBackup[]>("/api/admin/backups", { signal }),
    staleTime: STALE.long,
    retry: false,
  });
  const latest = data?.[0];
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[var(--glass-bg)] px-3 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <Archive className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{t("data.snapshots")}</div>
          <div className="text-xs text-muted-foreground">
            {isLoading ? <Skeleton className="mt-1 h-3 w-40 rounded-full" />
              : isError ? t("data.unavailable")
              : latest ? t("data.snapshotsInfo", { count: data!.length, date: fmtDate(latest.createdAt), size: fmtCount(latest.sizeKb) })
              : t("data.noSnapshots")}
          </div>
        </div>
      </div>
      <Button asChild size="sm" variant="outline"><Link href="/admin">{t("data.openAdmin")}</Link></Button>
    </div>
  );
}

export function DataSection() {
  const { t } = settingsI18n.useT();
  const { t: tc } = commonI18n.useT();
  const { can } = useAuth();
  const { toast } = useToast();
  const [period, setPeriod] = useState<Period>("all");
  const [fullLoading, setFullLoading] = useState(false);
  // P1-5: the counter needs only the size of the book — /trades/page?limit=1 (summary.total). The legacy full
  // list is fetched only if that endpoint is unavailable. CSV export (ExportTile) still downloads the full list.
  const facets = useTradesBookFacets();
  const legacyTrades = useListTrades(undefined, { query: { queryKey: ["/api/trades"], enabled: facets.isFetched && facets.data == null } });
  const l1 = facets.isLoading || (facets.data == null && legacyTrades.isLoading);
  const tradesCount = facets.data?.total ?? legacyTrades.data?.length ?? 0;
  const { data: events = [], isLoading: l2 } = useListEvents();
  const { data: research = [], isLoading: l3 } = useListResearch();
  const { data: feed = [], isLoading: l4 } = useListDailyFeed();
  const { data: discussions = [], isLoading: l5 } = useListDiscussions();
  const loading = l1 || l2 || l3 || l4 || l5;
  const total = tradesCount + events.length + research.length + feed.length + discussions.length;

  const counts: Record<string, number | undefined> = {
    trades: l1 ? undefined : tradesCount, events: l2 ? undefined : events.length, research: l3 ? undefined : research.length,
    dailyfeed: l4 ? undefined : feed.length, discussions: l5 ? undefined : discussions.length,
  };
  // Keys used by the db-export format → current counts for the backup comparison.
  const currentForBackup: Record<string, number | undefined> = loading ? {} : {
    trades: tradesCount, marketEvents: events.length, events: events.length, research: research.length,
    dailyFeed: feed.length, discussions: discussions.length,
  };

  async function fullBackup() {
    setFullLoading(true);
    try {
      let text: string;
      try {
        text = await http.get<string>("/api/admin/db-export", { responseType: "text" });
      } catch (e) {
        if (e instanceof ApiError && e.status >= 400) {
          toast({ title: t("data.backupFailed"), description: e.message, variant: "destructive" });
          return;
        }
        throw e;
      }
      const filename = `ws-lexx-backup-${new Date().toISOString().slice(0, 10)}.json`;
      saveText(text, "application/json;charset=utf-8", filename);
      toast({ title: t("data.downloaded", { file: filename }), description: t("data.kb", { size: fmtCount(Math.round(text.length / 1024)) }) });
    } catch {
      toast({ title: tc("states.networkError"), variant: "destructive" });
    } finally {
      setFullLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" aria-busy={loading}>
        {/* Each tile shows its number as soon as its own list arrives — the trade count (/trades/page summary) is
            the slow one and used to hold every tile on a skeleton. */}
        <StatCard label={t("data.totalRecords")} value={fmtCount(total)} tone="accent" icon={Database} loading={loading} />
        <StatCard label={t("data.exports.trades")} value={fmtCount(tradesCount)} loading={l1} />
        <StatCard label={t("data.exports.events")} value={fmtCount(events.length)} loading={l2} />
        <StatCard label={t("data.exports.research")} value={fmtCount(research.length)} loading={l3} />
        <StatCard label={t("data.exports.dailyfeed")} value={fmtCount(feed.length)} loading={l4} />
        <StatCard label={t("data.exports.discussions")} value={fmtCount(discussions.length)} loading={l5} />
      </div>

      <Panel title={t("data.exportCsv")} description={t("data.exportCsvDesc")} icon={Download}
        actions={<Segmented<Period> ariaLabel={t("data.exportPeriod")} size="sm" value={period} onChange={setPeriod}
          options={[{ value: "all", label: t("data.periodAll") }, { value: "30", label: t("data.period30") }, { value: "90", label: t("data.period90") }, { value: "365", label: t("data.periodYear") }]} />}>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {EXPORTS.map((e) => <ExportTile key={e.key} item={e} period={period} count={period === "all" ? counts[e.key] : undefined} />)}
        </div>
        {period !== "all" && <p className="mt-3 text-xs text-muted-foreground">{t("data.periodHint")}</p>}
      </Panel>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {can("admin.backups.read") && (
          <Panel title={t("data.fullBackupTitle")} description={t("data.fullBackupDesc")} icon={Archive}>
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[var(--glass-bg)] px-3 py-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">{t("data.downloadDb")}</div>
                  <div className="text-xs text-muted-foreground">{t("data.downloadDbHint")}</div>
                </div>
                <Button size="sm" variant="secondary" onClick={fullBackup} disabled={fullLoading} className="gap-1.5">
                  <Download className="h-3.5 w-3.5" aria-hidden="true" /> {fullLoading ? t("data.preparing") : tc("actions.download")}
                </Button>
              </div>
              <ServerSnapshots />
            </div>
          </Panel>
        )}

        <Panel title={t("data.checkBackup")} description={t("data.checkBackupDesc")} icon={ScrollText}>
          <BackupInspector current={currentForBackup} />
        </Panel>
      </div>

      <Callout icon={Info}>
        <strong className="font-medium text-foreground">{t("data.importOffTitle")}</strong> {t("data.importOff")}
      </Callout>
    </div>
  );
}
