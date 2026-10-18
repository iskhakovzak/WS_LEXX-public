/**
 * «Брокерская статистика (PropReports)» — aggregate Trade Performance reports stored via
 * POST /api/propreports/import (kind=performance) and read from GET /api/propreports/performance.
 *
 * Reusable: <PerformanceReportPanel trader="Ориф" /> on a trader profile / analytics page,
 * or without `trader` on /integrations (curators see every trader, with a filter).
 */
import * as React from "react";
import { BarChart3, Trash2 } from "lucide-react";
import { DataTable, EmptyState, Panel, Pill, SortableTh, StatCard, StatGrid, StatRow, Segmented, useTableSort, type Tone } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { ApiError } from "@/lib/api/http";

const TIGHT = "xl:p-3";
import {
  feeLabel, orderedFeeKeys, useDeletePerformance, usePerformance,
  type PerfRow, type PerformanceReport, type PerformanceReportRow,
} from "./api";
import { fmtDate, fmtNum, fmtPct, fmtUsd, fmtWeekday } from "@/lib/format";
import { PersonSelect } from "@/components/people/person-select";
import { propreportsI18n } from "@/i18n/ns/propreports";
import { commonI18n } from "@/i18n/ns/common";
import { personName } from "@/i18n";

const WEEKDAY_IDX: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

function toneOf(v: number | null | undefined): Tone {
  if (v == null || v === 0) return "neutral";
  return v > 0 ? "up" : "down";
}

export function fmtHold(seconds: number | null | undefined, raw?: string | null): string {
  if (seconds == null) return raw ?? "—";
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  if (h > 0) return propreportsI18n.t("perf.hold.h", { h, m });
  if (m > 0) return propreportsI18n.t("perf.hold.m", { m, s });
  return propreportsI18n.t("perf.hold.s", { s });
}

/** Win rate already in percent (PropReports): "57.1%". */
const pct = (v: number | null | undefined, digits = 1) => fmtPct(v, { decimals: digits, signed: false });

function periodText(r: { periodFrom: string; periodTo: string }): string {
  return `${r.periodFrom} — ${r.periodTo}`;
}

/* ── bars ─────────────────────────────────────────────────────────────────── */

function NetBars({ rows, labelOf, title }: { rows: PerfRow[]; labelOf: (label: string) => string; title: string }) {
  const { t } = propreportsI18n.useT();
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.totals.net)));
  if (!rows.length) return null;
  return (
    <div className="grid gap-2">
      <div className="text-xs font-medium text-muted-foreground">{title}</div>
      <div className="grid gap-1.5" role="list" aria-label={title}>
        {rows.map((r) => {
          const w = Math.max(2, Math.round((Math.abs(r.totals.net) / max) * 100));
          const up = r.totals.net >= 0;
          return (
            <div key={r.label} role="listitem" className="grid grid-cols-[88px_1fr_auto] items-center gap-2 text-xs" title={t("perf.barTitle", { label: labelOf(r.label), trades: commonI18n.t("units.trades", { count: r.trades }), winRate: pct(r.totals.winRate), gross: fmtUsd(r.totals.gross), fees: fmtUsd(r.totals.fees) })}>
              <span className="truncate text-muted-foreground">{labelOf(r.label)}</span>
              <div className="relative h-4 rounded bg-[var(--glass-bg)]">
                <div
                  className={cn("absolute inset-y-0 rounded", up ? "bg-up/70" : "bg-down/70")}
                  style={{ left: up ? "50%" : `${50 - w / 2}%`, width: `${w / 2}%` }}
                  aria-hidden="true"
                />
                <div className="absolute inset-y-0 left-1/2 w-px bg-border" aria-hidden="true" />
              </div>
              <span className={cn("w-24 text-right font-medium tabular-nums", up ? "text-up" : "text-down")}>{fmtUsd(r.totals.net, { signed: true })}</span>
              <span className="sr-only">{commonI18n.t("units.trades", { count: r.trades })}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── side comparison ──────────────────────────────────────────────────────── */

function SideCard({ title, row }: { title: string; row: PerfRow | null }) {
  const { t } = propreportsI18n.useT();
  if (!row) return null;
  return (
    <div className="rounded-xl border border-[var(--glass-border)] p-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-sm font-semibold">{title}</span>
        <Pill tone={toneOf(row.totals.net)}>{t("perf.netPill", { value: fmtUsd(row.totals.net, { signed: true }) })}</Pill>
      </div>
      <StatRow label={t("perf.trades")} value={t("perf.tradesWL", { count: row.trades, wins: row.wins.count, losses: row.losses.count })} />
      <StatRow label="Win rate" value={pct(row.totals.winRate)} tone={row.totals.winRate != null && row.totals.winRate >= 50 ? "up" : "neutral"} />
      <StatRow label="Gross" value={fmtUsd(row.totals.gross, { signed: true })} tone={toneOf(row.totals.gross)} />
      <StatRow label={t("perf.fees")} value={fmtUsd(row.totals.fees)} />
      <StatRow label={t("perf.avgWinLoss")} value={`${fmtUsd(row.wins.avgGross)} / ${fmtUsd(row.losses.avgGross)}`} />
      <StatRow label="W/L ratio" value={fmtNum(row.totals.wlRatio)} />
      <StatRow label={t("perf.avgHold")} value={fmtHold(row.totals.avgHoldSeconds, row.totals.avgHold)} />
    </div>
  );
}

/* ── symbol table ─────────────────────────────────────────────────────────── */

const SYMBOL_ACCESSORS = {
  label: (r: PerfRow) => r.label,
  trades: (r: PerfRow) => r.trades,
  winRate: (r: PerfRow) => r.totals.winRate,
  gross: (r: PerfRow) => r.totals.gross,
  fees: (r: PerfRow) => r.totals.fees,
  net: (r: PerfRow) => r.totals.net,
  avgWin: (r: PerfRow) => r.wins.avgGross,
  avgLoss: (r: PerfRow) => r.losses.avgGross,
  hold: (r: PerfRow) => r.totals.avgHoldSeconds,
};

function SymbolTable({ rows }: { rows: PerfRow[] }) {
  const { t } = propreportsI18n.useT();
  const [mode, setMode] = React.useState<"all" | "best" | "worst">("all");
  const sorted = useTableSort(rows, SYMBOL_ACCESSORS, "net");
  const visible = React.useMemo(() => {
    if (mode === "all") return sorted.rows;
    const byNet = [...rows].sort((a, b) => b.totals.net - a.totals.net);
    const pick = new Set(mode === "best" ? byNet.slice(0, 15) : byNet.slice(-15));
    // the subset is chosen by net, but displayed in the column order the user picked
    return sorted.rows.filter((r) => pick.has(r));
  }, [mode, rows, sorted.rows]);
  const best = rows.length ? Math.max(...rows.map((r) => r.totals.net)) : 0;
  const worst = rows.length ? Math.min(...rows.map((r) => r.totals.net)) : 0;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-medium text-muted-foreground">{t("perf.bySymbol", { count: rows.length })}</div>
        <Segmented
          ariaLabel={t("perf.symbolFilterAria")}
          value={mode}
          onChange={(m) => {
            setMode(m);
            if (m !== "all") { sorted.setSortKey("net"); sorted.setSortDir(m === "best" ? "desc" : "asc"); }
          }}
          options={[{ value: "all", label: t("perf.all") }, { value: "best", label: t("perf.best") }, { value: "worst", label: t("perf.worst") }]}
        />
      </div>
      <DataTable maxHeight="70vh" stickyFirstCol ariaLabel={t("perf.symbolTableAria")}>
        <table>
          <thead>
            <tr>
              <SortableTh {...sorted.thProps("label")}>{t("perf.col.ticker")}</SortableTh>
              <SortableTh {...sorted.thProps("trades")} align="right">{t("perf.col.trades")}</SortableTh>
              <SortableTh {...sorted.thProps("winRate")} align="right">Win rate</SortableTh>
              <SortableTh {...sorted.thProps("gross")} align="right">Gross</SortableTh>
              <SortableTh {...sorted.thProps("fees")} align="right">{t("perf.col.fees")}</SortableTh>
              <SortableTh {...sorted.thProps("net")} align="right">Net</SortableTh>
              <SortableTh {...sorted.thProps("avgWin")} align="right">{t("perf.col.avgWin")}</SortableTh>
              <SortableTh {...sorted.thProps("avgLoss")} align="right">{t("perf.col.avgLoss")}</SortableTh>
              <SortableTh {...sorted.thProps("hold")} align="right">{t("perf.col.hold")}</SortableTh>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.label} className={cn(r.totals.net === best && rows.length > 1 && "bg-up/5", r.totals.net === worst && rows.length > 1 && "bg-down/5")}>
                <td className="font-medium">{r.label}</td>
                <td className="text-right">{r.trades}</td>
                <td className="text-right">{pct(r.totals.winRate, 0)}</td>
                <td className={cn("text-right", r.totals.gross > 0 ? "text-up" : r.totals.gross < 0 ? "text-down" : "")}>{fmtUsd(r.totals.gross, { signed: true })}</td>
                <td className="text-right text-muted-foreground">{fmtUsd(r.totals.fees)}</td>
                <td className={cn("text-right font-medium", r.totals.net > 0 ? "text-up" : r.totals.net < 0 ? "text-down" : "")}>{fmtUsd(r.totals.net, { signed: true })}</td>
                <td className="text-right">{r.wins.count ? fmtUsd(r.wins.avgGross) : "—"}</td>
                <td className="text-right">{r.losses.count ? fmtUsd(r.losses.avgGross) : "—"}</td>
                <td className="text-right text-muted-foreground">{fmtHold(r.totals.avgHoldSeconds, r.totals.avgHold)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataTable>
    </div>
  );
}

/* ── report body (shared by the panel and the import preview) ─────────────── */

export function PerformanceReportBody({ data, compact = false }: { data: PerformanceReport; compact?: boolean }) {
  const { t } = propreportsI18n.useT();
  const s = data.summary;
  const timeLabel = (l: string) => propreportsI18n.tryT(`perf.time.${l.toLowerCase()}`) ?? l;
  const dayLabel = (l: string) => {
    const i = WEEKDAY_IDX[l.toLowerCase()];
    if (i == null) return l;
    const w = fmtWeekday(i, "short");
    return w.charAt(0).toUpperCase() + w.slice(1);
  };
  return (
    <div className="grid gap-4">
      {/* Seven cards in one row from 1600 px (tighter padding); below that 4 + 3, so long EN/UZ values («20 daq 12 s») never truncate. */}
      <StatGrid className="md:grid-cols-4 min-[1600px]:grid-cols-7">
        <StatCard className={TIGHT} label={t("perf.trades")} value={s.trades} hint={`${s.wins} W / ${s.losses} L`} />
        <StatCard className={TIGHT} label="Win rate" value={pct(s.winRate)} tone={s.winRate != null && s.winRate >= 50 ? "up" : "neutral"} />
        <StatCard className={TIGHT} label="Gross P&L" value={fmtUsd(s.gross, { signed: true })} tone={toneOf(s.gross)} />
        <StatCard className={TIGHT} label={t("perf.fees")} value={fmtUsd(s.fees)} tone={s.feesPctOfGross != null && s.feesPctOfGross > 50 ? "warn" : "neutral"} hint={s.feesPctOfGross != null ? t("perf.feesHint", { pct: fmtPct(s.feesPctOfGross, { decimals: 0, signed: false }) }) : undefined} />
        <StatCard className={TIGHT} label="Net P&L" value={fmtUsd(s.net, { signed: true })} tone={toneOf(s.net)} />
        <StatCard className={TIGHT} label="W/L ratio" value={fmtNum(s.wlRatio)} hint={`${fmtUsd(s.avgWin)} / ${fmtUsd(s.avgLoss)}`} />
        <StatCard className={TIGHT} label={t("perf.avgHoldShort")} value={fmtHold(s.avgHoldSeconds, s.avgHold)} />
      </StatGrid>

      {s.feesPctOfGross != null && s.feesPctOfGross >= 50 && (
        <div className="rounded-xl border border-[hsl(var(--chart-3)/0.4)] bg-[hsl(var(--chart-3)/0.08)] px-3 py-2 text-xs">
          {t("perf.feesWarn", { pct: fmtPct(s.feesPctOfGross, { decimals: 0, signed: false }), count: s.trades, fee: fmtUsd(s.trades ? s.fees / s.trades : 0), net: fmtUsd(s.trades ? s.net / s.trades : 0) })}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <SideCard title="Long" row={data.bySide.long} />
        <SideCard title="Short" row={data.bySide.short} />
      </div>

      {!compact && (
        <div className="grid gap-4 lg:grid-cols-2">
          <NetBars rows={data.byTime} labelOf={timeLabel} title={t("perf.byTime")} />
          <NetBars rows={data.byWeekday} labelOf={dayLabel} title={t("perf.byWeekday")} />
        </div>
      )}

      {!compact && data.bySymbol.length > 0 && <SymbolTable rows={data.bySymbol} />}

      {data.perTradeAverages.length > 0 && (
        <div className="grid gap-2">
          <div className="text-xs font-medium text-muted-foreground">{t("perf.perTrade")}</div>
          {data.perTradeAverages.map((a) => {
            const keys = orderedFeeKeys(a.fees);
            const total = keys.reduce((x, k) => x + (a.fees[k] ?? 0), 0);
            return (
              <div key={a.group} className="flex flex-wrap items-center gap-2 text-xs">
                <Pill tone="accent">{a.group}</Pill>
                {a.qty != null && <Pill tone="neutral">{t("perf.shares", { count: Math.round(a.qty) })}</Pill>}
                {a.held && <Pill tone="neutral">{fmtHold(a.heldSeconds, a.held)}</Pill>}
                {keys.filter((k) => (a.fees[k] ?? 0) !== 0).map((k) => (
                  <span key={k} className="rounded-full border border-[var(--glass-border)] px-2 py-0.5 tabular-nums">{feeLabel(k)} {fmtUsd(a.fees[k], { decimals: 4 })}</span>
                ))}
                <span className="font-medium tabular-nums">{t("perf.perTradeTotal", { value: fmtUsd(total, { decimals: 4 }) })}</span>
              </div>
            );
          })}
        </div>
      )}

      {data.issues.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">{t("perf.issues", { count: data.issues.length })}</summary>
          <ul className="mt-1 list-disc pl-4">{data.issues.map((i, k) => <li key={k}>{i}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

/* ── panel ────────────────────────────────────────────────────────────────── */

export function PerformanceReportPanel({ trader, staff = false, compact = false, className }: { trader?: string | null; staff?: boolean; compact?: boolean; className?: string }) {
  const { toast } = useToast();
  const { t } = propreportsI18n.useT();
  const [traderFilter, setTraderFilter] = React.useState<string>("");
  const [reportId, setReportId] = React.useState<number | null>(null);
  const effectiveTrader = trader ?? (traderFilter || null);
  const q = usePerformance(effectiveTrader, reportId);
  const del = useDeletePerformance();

  const reports: PerformanceReportRow[] = q.data?.reports ?? [];
  const traders = React.useMemo(() => [...new Set(reports.map((r) => r.traderName).filter((x): x is string => !!x))].sort(), [reports]);
  const latest = q.data?.latest ?? null;
  // when the filter changes the chosen id may vanish → fall back to the newest report
  React.useEffect(() => { if (reportId && !reports.some((r) => r.id === reportId)) setReportId(null); }, [reports, reportId]);

  const err = q.error instanceof ApiError ? q.error : null;
  const title = t("perf.title");
  const description = latest
    ? [
        t("perf.descReport"),
        t("perf.descAccount", { account: latest.account }),
        periodText(latest),
        latest.traderName ?? "",
        latest.uploadedBy ? t("perf.descUploadedBy", { date: fmtDate(latest.uploadedAt, "short"), by: personName(latest.uploadedBy) }) : t("perf.descUploaded", { date: fmtDate(latest.uploadedAt, "short") }),
      ].filter(Boolean).join(" · ")
    : t("perf.descEmpty");

  return (
    <Panel
      title={title}
      description={description}
      icon={BarChart3}
      className={className}
      actions={
        <>
          {!trader && traders.length > 1 && (
            <PersonSelect value={traderFilter || ""} onValueChange={(v) => { setTraderFilter(v); setReportId(null); }} options={traders} allLabel={commonI18n.t("fields.allTraders")} ariaLabel={t("perf.traderAria")} className="h-8 w-44 text-xs" />
          )}
          {reports.length > 1 && (
            <Select value={String(latest?.id ?? reports[0]?.id ?? "")} onValueChange={(v) => setReportId(Number(v))}>
              <SelectTrigger className="h-8 w-64 text-xs" aria-label={t("perf.periodAria")}><SelectValue placeholder={t("perf.periodPlaceholder")} /></SelectTrigger>
              <SelectContent>
                {reports.map((r) => <SelectItem key={r.id} value={String(r.id)}>{periodText(r)} · {r.account}{r.traderName ? ` · ${personName(r.traderName)}` : ""}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          {staff && latest && (
            <Button
              variant="ghost" size="icon" aria-label={t("perf.deleteAria")} disabled={del.isPending}
              onClick={async () => {
                if (!window.confirm(t("perf.confirmDelete", { account: latest.account, period: periodText(latest) }))) return;
                try { await del.mutateAsync(latest.id); setReportId(null); toast({ title: t("perf.deleted") }); }
                catch (e) { toast({ title: commonI18n.t("states.deleteFailed"), description: e instanceof Error ? e.message : String(e), variant: "destructive" }); }
              }}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
        </>
      }
    >
      {q.isLoading ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : err ? (
        <EmptyState icon={BarChart3} title={t("perf.loadFailed")} description={err.message} />
      ) : !latest ? (
        <EmptyState
          icon={BarChart3}
          title={t("perf.emptyTitle")}
          description={trader ? t("perf.emptyTrader", { name: personName(trader) }) : t("perf.emptyStaff")}
        />
      ) : (
        <PerformanceReportBody data={latest.data} compact={compact} />
      )}
    </Panel>
  );
}

export default PerformanceReportPanel;
