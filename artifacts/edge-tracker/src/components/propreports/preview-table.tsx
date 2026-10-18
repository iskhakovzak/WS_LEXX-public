/**
 * Dry-run preview: summary tiles + per-trip diff table (new / updated / unchanged / adopt / conflict / skip).
 * Used by both the file import zone and the API "run now" dialog.
 */
import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { DataTable, Pill, Segmented, SortableTh, StatCard, StatGrid, useTableSort, type Tone } from "@/components/ds";
import { cn } from "@/lib/utils";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  actionLabel, feeLabel, fieldLabel, horizonLabel, orderedFeeKeys, reasonLabel, resultLabel, sessionLabel,
  fmtPrice, type ApplyResult, type IntegrationsTab, type PlanAction, type PlanItemView, type Preview, type TripView,
} from "./api";
import { fmtUsd } from "@/lib/format";
import { propreportsI18n } from "@/i18n/ns/propreports";
import { commonI18n } from "@/i18n/ns/common";
import { personName } from "@/i18n";

const ACTION_TONE: Record<PlanAction, Tone> = { insert: "up", update: "accent", unchanged: "neutral", adopt: "purple", conflict: "warn", skip: "down" };
type Filter = "all" | PlanAction;

// Action order mirrors the filter chips: what will change first, no-ops last.
const ACTION_RANK: Record<PlanAction, number> = { insert: 0, update: 1, adopt: 2, conflict: 3, unchanged: 4, skip: 5 };
const HORIZON_RANK: Record<string, number> = { intraday: 0, overnight: 1, swing: 2 };
const RESULT_RANK: Record<string, number> = { win: 0, breakeven: 1, loss: 2, open: 3 };
const PREVIEW_ACCESSORS = {
  action: (it: PlanItemView) => ACTION_RANK[it.action] ?? null,
  account: (it: PlanItemView) => it.trader ?? it.account,
  date: (it: PlanItemView) => it.trip.openedAt || it.trip.date,
  symbol: (it: PlanItemView) => it.trip.symbol,
  side: (it: PlanItemView) => it.trip.side,
  qty: (it: PlanItemView) => it.trip.qty,
  entry: (it: PlanItemView) => it.trip.avgEntry,
  exit: (it: PlanItemView) => it.trip.avgExit,
  gross: (it: PlanItemView) => it.trip.grossPnl,
  fees: (it: PlanItemView) => it.trip.totalFees,
  net: (it: PlanItemView) => it.trip.netPnl,
  horizon: (it: PlanItemView) => HORIZON_RANK[it.trip.horizon] ?? null,
  hold: (it: PlanItemView) => (it.trip.closedAt && it.trip.openedAt ? (Date.parse(it.trip.closedAt) - Date.parse(it.trip.openedAt)) || null : null),
  result: (it: PlanItemView) => RESULT_RANK[it.trip.result] ?? null,
};
const PREVIEW_FIRST_DIR = { action: "asc", account: "asc", symbol: "asc", side: "asc", horizon: "asc", result: "asc" } as const;

export function resultTone(r: TripView["result"]): Tone {
  return r === "win" ? "up" : r === "loss" ? "down" : r === "open" ? "accent" : "neutral";
}

export function FeesBreakdown({ fees, total }: { fees: Record<string, number>; total: number }) {
  const parts = orderedFeeKeys(fees).filter((k) => Math.abs(fees[k] ?? 0) >= 0.005);
  if (!parts.length) return <span className="text-muted-foreground">{fmtUsd(total)}</span>;
  return (
    <span title={parts.map((k) => `${feeLabel(k)}: ${fmtUsd(fees[k])}`).join("\n")} className="cursor-help underline decoration-dotted underline-offset-2">
      {fmtUsd(total)}
    </span>
  );
}

export function ExecutionsList({ trip }: { trip: TripView }) {
  const { t } = propreportsI18n.useT();
  return (
    <div className="grid gap-1 text-xs tabular-nums">
      {trip.executions.map((e, i) => (
        <div key={i} className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <span className="w-20 text-muted-foreground">{propreportsI18n.tryT(`preview.exec.${e.kind}`) ?? e.kind}</span>
          <span className={cn("w-8 font-medium", e.side === "B" || e.side === "C" ? "text-up" : "text-down")}>{e.side}</span>
          <span className="w-14 text-right">{e.qty}</span>
          <span className="w-20 text-right">@ {fmtPrice(e.price)}</span>
          <span className="text-muted-foreground">{e.at.replace("T", " ")}</span>
          {e.fees ? <span className="text-muted-foreground">{t("preview.execFee", { value: fmtUsd(e.fees) })}</span> : null}
          {e.fillId && <span className="text-2xs text-muted-foreground">#{e.fillId}</span>}
        </div>
      ))}
      {trip.open && <div className="text-muted-foreground">{t("preview.stillOpen", { count: trip.openQty })}</div>}
    </div>
  );
}

function ChangeList({ changes }: { changes: PlanItemView["changes"] }) {
  if (!changes.length) return null;
  const show = (v: unknown) => (v == null || v === "" ? "—" : typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : String(v));
  return (
    <ul className="grid gap-0.5 text-xs">
      {changes.map((c) => (
        <li key={c.field} className="flex flex-wrap gap-1.5">
          <span className="text-muted-foreground">{fieldLabel(c.field)}:</span>
          <span className="line-through opacity-70">{show(c.from)}</span>
          <span>→</span>
          <span className="font-medium">{show(c.to)}</span>
        </li>
      ))}
    </ul>
  );
}

/** After a write: the next step (reconcile the conflicts, map new accounts), so the run doesn't end in a dead end. */
export function NextSteps({ result, onGoTab }: { result: Pick<ApplyResult, "conflicts" | "unmappedAccounts">; onGoTab?: (tab: IntegrationsTab) => void }) {
  const { t } = propreportsI18n.useT();
  if (!onGoTab || (!result.conflicts && !result.unmappedAccounts.length)) return null;
  return (
    <div className="flex w-full flex-wrap gap-2">
      {result.conflicts > 0 && (
        <Button size="sm" variant="outline" onClick={() => onGoTab("reconcile")}>{t("next.reconcile", { count: result.conflicts })} <ArrowRight className="ml-1 h-3.5 w-3.5" aria-hidden="true" /></Button>
      )}
      {result.unmappedAccounts.length > 0 && (
        <Button size="sm" variant="outline" onClick={() => onGoTab("accounts")}>{t("next.accounts", { count: result.unmappedAccounts.length })} <ArrowRight className="ml-1 h-3.5 w-3.5" aria-hidden="true" /></Button>
      )}
    </div>
  );
}

export function PreviewSummary({ preview }: { preview: Preview }) {
  const { t } = propreportsI18n.useT();
  const s = preview.summary;
  const c = preview.counts;
  return (
    <div className="grid gap-3">
      <StatGrid>
        <StatCard label={t("preview.trips")} value={s.trips} hint={t("preview.tripsHint", { closed: s.closed, open: s.open, days: s.tradingDays })} />
        <StatCard label={t("preview.net")} value={fmtUsd(s.net, { signed: true })} tone={s.net > 0 ? "up" : s.net < 0 ? "down" : "neutral"} hint={t("preview.netHint", { gross: fmtUsd(s.gross, { signed: true }), fees: fmtUsd(s.fees) })} />
        <StatCard label={t("preview.newUpdated")} value={`${c.insert} / ${c.update}`} tone={c.insert ? "up" : "neutral"} hint={t("preview.newUpdatedHint", { unchanged: c.unchanged, adopt: c.adopt })} />
        <StatCard label={t("preview.conflictSkip")} value={`${c.conflict} / ${c.skip}`} tone={c.conflict ? "warn" : c.skip ? "down" : "neutral"} hint={t("preview.horizonHint", { intraday: s.byHorizon.intraday, overnight: s.byHorizon.overnight, swing: s.byHorizon.swing })} />
      </StatGrid>
      <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
        {preview.kind === "fills" && preview.fills != null && <Pill tone="neutral">{preview.skippedRows ? t("preview.fillsCancelled", { count: preview.fills, cancelled: preview.skippedRows }) : t("preview.fills", { count: preview.fills })}</Pill>}
        {preview.reportRows != null && <Pill tone="neutral">{t("preview.reportRows", { count: preview.reportRows })}</Pill>}
        {!!preview.unmappedAccounts.length && <Pill tone="warn" dot>{t("preview.unmapped", { list: preview.unmappedAccounts.join(", ") })}</Pill>}
        {!!preview.inactiveAccounts.length && <Pill tone="neutral">{t("preview.inactive", { list: preview.inactiveAccounts.join(", ") })}</Pill>}
        {!!preview.orphanCount && <Pill tone="warn">{t("preview.orphans", { count: preview.orphanCount })}</Pill>}
        {!!preview.issueCount && <Pill tone="down">{t("preview.issues", { count: preview.issueCount })}</Pill>}
        {preview.truncated && <Pill tone="warn">{t("preview.truncated")}</Pill>}
      </div>
      {!!preview.issues?.length && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">{t("preview.problemRows")}</summary>
          <ul className="mt-1 grid gap-0.5">{preview.issues.map((i, n) => <li key={n}>{t("preview.row", { line: i.line, message: i.message })}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

export function PreviewTable({ preview }: { preview: Preview }) {
  const { t } = propreportsI18n.useT();
  const [filter, setFilter] = React.useState<Filter>("all");
  const [open, setOpen] = React.useState<Set<string>>(() => new Set());
  const filtered = React.useMemo(() => (filter === "all" ? preview.items : preview.items.filter((i) => i.action === filter)), [filter, preview.items]);
  const sort = useTableSort(filtered, PREVIEW_ACCESSORS, "date", "asc", PREVIEW_FIRST_DIR);
  const items = sort.rows;
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const options: Array<{ value: Filter; label: string; count: number }> = [
    { value: "all", label: t("preview.all"), count: preview.items.length },
    ...(["insert", "update", "adopt", "conflict", "unchanged", "skip"] as PlanAction[]).filter((a) => preview.counts[a]).map((a) => ({ value: a as Filter, label: actionLabel(a), count: preview.counts[a] })),
  ];
  return (
    <div className="grid gap-3">
      <Segmented ariaLabel={t("preview.filterAria")} size="sm" value={filter} onChange={setFilter} options={options} />
      <DataTable maxHeight="70vh" ariaLabel={t("preview.tableAria")}>
        <table>
          <thead>
            <tr>
              <th className="w-6" />
              <SortableTh {...sort.thProps("action")}>{t("preview.col.action")}</SortableTh>
              <SortableTh {...sort.thProps("account")}>{t("preview.col.account")}</SortableTh>
              <SortableTh {...sort.thProps("date")}>{t("preview.col.date")}</SortableTh>
              <SortableTh {...sort.thProps("symbol")}>{t("preview.col.symbol")}</SortableTh>
              <SortableTh {...sort.thProps("side")}>{t("preview.col.side")}</SortableTh>
              <SortableTh {...sort.thProps("qty")} align="right">{t("preview.col.qty")}</SortableTh>
              <SortableTh {...sort.thProps("entry")} align="right">{t("preview.col.entry")}</SortableTh>
              <SortableTh {...sort.thProps("exit")} align="right">{t("preview.col.exit")}</SortableTh>
              <SortableTh {...sort.thProps("gross")} align="right">{t("preview.col.gross")}</SortableTh>
              <SortableTh {...sort.thProps("fees")} align="right">{t("preview.col.fees")}</SortableTh>
              <SortableTh {...sort.thProps("net")} align="right">{t("preview.col.net")}</SortableTh>
              <SortableTh {...sort.thProps("horizon")}>{t("preview.col.horizon")}</SortableTh>
              <SortableTh {...sort.thProps("hold")}>{t("preview.col.hold")}</SortableTh>
              <SortableTh {...sort.thProps("result")}>{t("preview.col.result")}</SortableTh>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              const tr = it.trip;
              const isOpen = open.has(it.externalId);
              return (
                <React.Fragment key={it.externalId}>
                  <tr className={cn(it.action === "conflict" && "bg-[hsl(var(--chart-3))]/5", it.action === "skip" && "opacity-60")}>
                    <td>
                      <button type="button" onClick={() => toggle(it.externalId)} aria-expanded={isOpen} aria-label={t("preview.showExec")} className="rounded p-0.5 text-muted-foreground hover:text-foreground">
                        {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                      </button>
                    </td>
                    <td>
                      <Pill tone={ACTION_TONE[it.action]}>{actionLabel(it.action)}</Pill>
                      {it.reason && <div className="text-2xs text-muted-foreground">{reasonLabel(it.reason)}</div>}
                    </td>
                    <td className="whitespace-nowrap">
                      <div className="text-xs">{it.account}</div>
                      <div className={cn("text-2xs", it.trader ? "text-muted-foreground" : "text-[hsl(var(--chart-3))]")}>{it.trader ? personName(it.trader) : t("notMapped")}</div>
                    </td>
                    <td className="whitespace-nowrap">{tr.date}{tr.exitDate && tr.exitDate !== tr.date ? <span className="text-muted-foreground"> → {tr.exitDate}</span> : null}</td>
                    <td className="font-medium">{tr.symbol}</td>
                    <td><span className={tr.side === "Long" ? "text-up" : "text-down"}>{commonI18n.t(tr.side === "Long" ? "trading.long" : "trading.short")}</span></td>
                    <td className="text-right">{tr.qty}{tr.open && tr.openQty ? <span className="text-muted-foreground"> {t("preview.openQty", { count: tr.openQty })}</span> : null}</td>
                    <td className="text-right">{fmtPrice(tr.avgEntry)}</td>
                    <td className="text-right">{fmtPrice(tr.avgExit)}</td>
                    <td className={cn("text-right", tr.grossPnl > 0 ? "text-up" : tr.grossPnl < 0 ? "text-down" : "")}>{fmtUsd(tr.grossPnl, { signed: true })}</td>
                    <td className="text-right"><FeesBreakdown fees={tr.fees} total={tr.totalFees} /></td>
                    <td className={cn("text-right font-medium", tr.netPnl > 0 ? "text-up" : tr.netPnl < 0 ? "text-down" : "")}>{fmtUsd(tr.netPnl, { signed: true })}</td>
                    <td className="whitespace-nowrap text-xs">{horizonLabel(tr.horizon)} <span className="text-muted-foreground">· {sessionLabel(tr.session)}</span></td>
                    <td className="whitespace-nowrap text-xs">{tr.holdTime ?? "—"}</td>
                    <td><Pill tone={resultTone(tr.result)}>{resultLabel(tr.result)}</Pill></td>
                  </tr>
                  {(isOpen || it.changes.length > 0 || it.candidates.length > 0) && (
                    <tr>
                      <td />
                      <td colSpan={14} className="!py-2">
                        <div className="grid gap-2">
                          {it.changes.length > 0 && <ChangeList changes={it.changes} />}
                          {it.candidates.length > 0 && (
                            <div className="text-xs">
                              <span className="text-[hsl(var(--chart-3))]">{t("preview.matchesManual")}</span>{" "}
                              {it.candidates.map((c) => `#${c.id} ${c.ticker} ${c.side ?? ""} ${c.date}${c.pnl != null ? ` (${fmtUsd(c.pnl, { signed: true })})` : ""}`).join("; ")}
                              <span className="text-muted-foreground">{t("preview.matchesHint")}</span>
                            </div>
                          )}
                          {isOpen && <ExecutionsList trip={tr} />}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
            {!items.length && (
              <tr><td colSpan={15} className="py-6 text-center text-sm text-muted-foreground">{t("preview.empty")}</td></tr>
            )}
          </tbody>
        </table>
      </DataTable>
    </div>
  );
}
