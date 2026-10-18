/**
 * «Сверка с брокером» — journal vs PropReports, from GET /api/reconcile (engine: api-server lib/reconcile.ts).
 *
 * Self-contained: <ReconcilePanel /> (curators pick a trader; traders always see their own book),
 * <ReconcilePanel trader="Ориф" />, <ReconcilePanel trader="Ориф" compact /> for /stats next to PerformanceReportPanel.
 */
import * as React from "react";
import { Link } from "wouter";
import { ChevronDown, ChevronRight, Download, RefreshCw, Scale } from "lucide-react";
import { DataTable, EmptyState, Panel, Pill, SortableTh, StatCard, StatGrid, useTableSort, type Tone } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/contexts/auth-context";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import { isNotFound } from "@/lib/api/errors";
import {
  feeRoundingLabel, discrepanciesCsv, downloadText, useReconcile,
  type Compare, type CompareStatus, type DayRow, type Issue, type ReportCheck, type Severity,
} from "./reconcile-api";
import { PersonSelect } from "@/components/people/person-select";
import { fmtUsd } from "@/lib/format";
import { propreportsI18n } from "@/i18n/ns/propreports";
import { commonI18n } from "@/i18n/ns/common";

const ALL = "__all__";

const toneOfMoney = (v: number | null | undefined): Tone => (v == null || Math.abs(v) < 0.005 ? "neutral" : v > 0 ? "up" : "down");

const STATUS_META: Record<Severity, { icon: string; tone: Tone; text: string }> = {
  ok: { icon: "✓", tone: "up", text: "text-up" },
  warn: { icon: "⚠", tone: "warn", text: "text-[hsl(var(--chart-3))]" },
  error: { icon: "✗", tone: "down", text: "text-down" },
};

function StatusMark({ status, className }: { status: CompareStatus; className?: string }) {
  const { t } = propreportsI18n.useT();
  if (status === "na") return <span className={cn("text-muted-foreground", className)} aria-label={t("reconcile.status.na")}>—</span>;
  const m = STATUS_META[status];
  const label = t(`reconcile.status.${status}`);
  return (
    <span className={cn("font-semibold", m.text, className)} role="img" aria-label={label} title={label}>
      {m.icon}
    </span>
  );
}

function issueHref(i: Issue): string | null {
  if (i.tradeIds.length === 1) return links.trade(i.tradeIds[0]);
  if (i.tradeIds.length > 1) return links.trades({ ids: i.tradeIds });
  if (i.ticker) return links.trades({ ticker: i.ticker });
  if (i.date) return links.trades({ date: i.date });
  return null;
}

function IssueItem({ issue, trader }: { issue: Issue; trader: string | null }) {
  const { t } = propreportsI18n.useT();
  const href = issueHref(issue);
  return (
    <li className="flex items-start gap-2 rounded-xl border border-border/50 px-3 py-2 text-sm">
      <StatusMark status={issue.severity} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="text-foreground">{issue.message}</div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {issue.cause === "fee_rounding" && <Pill tone="accent" title={issue.hint}>{feeRoundingLabel()}</Pill>}
          {issue.diff != null && <span className="tabular-nums">{t("reconcile.diff", { value: fmtUsd(issue.diff, { signed: true }) })}</span>}
          {href && (
            <Link href={href} className="text-primary underline-offset-2 hover:underline">
              {issue.tradeIds.length === 1 ? t("reconcile.trade", { id: issue.tradeIds[0]! }) : issue.tradeIds.length > 1 ? t("reconcile.tradesN", { count: issue.tradeIds.length }) : issue.ticker ? t("reconcile.tradesTicker", { ticker: issue.ticker }) : t("reconcile.tradesDay")}
            </Link>
          )}
          {issue.date && (
            <Link href={links.journalDay(issue.date, issue.trader ?? trader ?? undefined)} className="text-primary underline-offset-2 hover:underline">
              {t("reconcile.journalDate", { date: issue.date })}
            </Link>
          )}
        </div>
        {issue.hint && issue.cause !== "fee_rounding" && <div className="mt-1 text-xs text-muted-foreground">{issue.hint}</div>}
      </div>
    </li>
  );
}

function CompareTable({ rows, caption }: { rows: Compare[]; caption: string }) {
  const { t } = propreportsI18n.useT();
  if (!rows.length) return null;
  const isCount = (k: string) => k === "trades" || k === "wins" || k === "losses";
  return (
    <DataTable ariaLabel={caption}>
      <table>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr><th scope="col">{t("reconcile.compare.metric")}</th><th scope="col" className="text-right">{t("reconcile.compare.journal")}</th><th scope="col" className="text-right">{t("reconcile.compare.broker")}</th><th scope="col" className="text-right">{t("reconcile.compare.diff")}</th><th scope="col">{t("reconcile.compare.status")}</th></tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.key}>
              <td>{c.label}</td>
              <td className="text-right">{isCount(c.key) ? c.journal ?? "—" : fmtUsd(c.journal)}</td>
              <td className="text-right">{isCount(c.key) ? c.broker ?? "—" : fmtUsd(c.broker)}</td>
              <td className="text-right">{c.diff == null ? "—" : isCount(c.key) ? (c.diff > 0 ? `+${c.diff}` : c.diff) : fmtUsd(c.diff, { signed: true })}</td>
              <td>
                <span className="inline-flex items-center gap-2">
                  <StatusMark status={c.status} />
                  {c.cause === "fee_rounding" ? <Pill tone="accent">{feeRoundingLabel()}</Pill> : c.note ? <span className="text-xs text-muted-foreground">{c.note}</span> : null}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </DataTable>
  );
}

function ReportBlock({ rep }: { rep: ReportCheck }) {
  const { t } = propreportsI18n.useT();
  const badGroups = rep.groups.filter((g) => g.status !== "ok");
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusMark status={rep.status} />
        <span className="font-medium">{t("reconcile.report")}</span>
        <span className="text-muted-foreground">{t("reconcile.reportMeta", { account: rep.account ?? "—", from: rep.periodFrom, to: rep.periodTo })}</span>
      </div>
      <CompareTable rows={rep.compares} caption={t("reconcile.totalsCaption")} />
      {rep.feeTypes.length > 0 && (
        <details className="rounded-xl border border-border/50 px-3 py-2">
          <summary className="cursor-pointer text-sm">{t("reconcile.feeTypes", { count: rep.feeTypes.filter((c) => c.status !== "ok").length })}</summary>
          <p className="mt-1 text-xs text-muted-foreground">{t("reconcile.feeTypesNote")}</p>
          <div className="mt-2"><CompareTable rows={rep.feeTypes} caption={t("reconcile.feeTypesCaption")} /></div>
        </details>
      )}
      <div className="text-xs text-muted-foreground">
        {t("reconcile.groups", { count: rep.groups.length, bad: badGroups.length })}
        {rep.symbolsMissingInJournal.length > 0 && <> · {t("reconcile.missingJournal", { list: rep.symbolsMissingInJournal.join(", ") })}</>}
        {rep.symbolsMissingInReport.length > 0 && <> · {t("reconcile.missingBroker", { list: rep.symbolsMissingInReport.join(", ") })}</>}
        {rep.manualInPeriod.trades > 0 && <> · {t("reconcile.manualInPeriod", { count: rep.manualInPeriod.trades, net: fmtUsd(rep.manualInPeriod.net, { signed: true }) })}</>}
      </div>
    </div>
  );
}

const SEVERITY_RANK: Record<Severity, number> = { ok: 0, warn: 1, error: 2 };
const dayDiff = (d: DayRow) => (d.broker ? d.journal.net - d.broker.net : null);
const DAY_ACCESSORS = {
  date: (d: DayRow) => d.date,
  status: (d: DayRow) => SEVERITY_RANK[d.status] * 10_000 + d.issueIds.length,
  trades: (d: DayRow) => d.journal.trades,
  gross: (d: DayRow) => d.journal.gross,
  fees: (d: DayRow) => d.journal.fees,
  net: (d: DayRow) => d.journal.net,
  brokerNet: (d: DayRow) => d.broker?.net ?? null,
  // biggest discrepancy first regardless of sign
  diff: (d: DayRow) => { const v = dayDiff(d); return v == null ? null : Math.abs(v); },
  manual: (d: DayRow) => d.manual.trades || null,
};

function DayDetails({ day, issues, trader }: { day: DayRow; issues: Issue[]; trader: string | null }) {
  const { t } = propreportsI18n.useT();
  return (
    <div className="grid gap-3 py-2">
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        <span>{t("reconcile.brokerSource", { source: day.brokerSource === "report-days" ? t("reconcile.srcReport") : day.brokerSource === "snapshot" ? t("reconcile.srcSnapshot") : t("reconcile.srcNone") })}</span>
        <span>{t("reconcile.dayFills", { with: day.fills.withFills, without: day.fills.withoutFills })}</span>
        {day.manual.trades > 0 && <span>{t("reconcile.dayManual", { count: day.manual.trades, net: fmtUsd(day.manual.net, { signed: true }) })}</span>}
        <Link href={links.trades({ date: day.date })} className="text-primary hover:underline">{t("reconcile.dayTrades")}</Link>
        <Link href={links.journalDay(day.date, trader ?? undefined)} className="text-primary hover:underline">{t("reconcile.dayJournal")}</Link>
      </div>
      {day.compares.length > 0 && <CompareTable rows={day.compares} caption={t("reconcile.dayCaption", { date: day.date })} />}
      {issues.length > 0 ? (
        <ul className="grid gap-2">{issues.map((i) => <IssueItem key={i.id} issue={i} trader={trader} />)}</ul>
      ) : (
        <p className="text-xs text-muted-foreground">{t("reconcile.dayNoIssues")}</p>
      )}
    </div>
  );
}

export function ReconcilePanel({ trader: traderProp, compact = false }: { trader?: string; compact?: boolean }) {
  const { isCurator, isAdmin, dbUsers, user } = useAuth();
  const { t, lang } = propreportsI18n.useT();
  const staff = isCurator || isAdmin;
  const [picked, setPicked] = React.useState<string>(traderProp ?? (staff ? ALL : user?.traderName ?? ""));
  React.useEffect(() => { if (traderProp) setPicked(traderProp); }, [traderProp]);
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [onlyBad, setOnlyBad] = React.useState(true);
  const [open, setOpen] = React.useState<Set<string>>(() => new Set());
  const [issueFilter, setIssueFilter] = React.useState<"all" | "error" | "warn">("all");

  const trader = traderProp ?? (staff ? (picked === ALL ? null : picked) : null);
  const q = useReconcile({ trader, from: from || null, to: to || null });
  const data = q.data;

  const issueById = React.useMemo(() => new Map((data?.issues ?? []).map((i) => [i.id, i])), [data]);
  const traders = React.useMemo(() => dbUsers.filter((u) => u.active && u.role !== "guest").map((u) => u.name).sort((a, b) => a.localeCompare(b, lang)), [dbUsers, lang]);
  const scopeName = data?.scope ?? trader;

  const exportCsv = () => {
    if (!data) return;
    downloadText(t("reconcile.fileName", { scope: scopeName ?? t("reconcile.fileDesk"), from: from || t("reconcile.fileAll"), to: to || t("reconcile.fileAll") }).replace(/[\\/:*?"<>|\s]+/g, "_"), discrepanciesCsv(data.issues));
  };

  const toggle = (date: string) => setOpen((s) => { const n = new Set(s); if (n.has(date)) n.delete(date); else n.add(date); return n; });

  const s = data?.summary;
  const rep = data?.reports[0] ?? null;
  const repNet = rep?.compares.find((c) => c.key === "net") ?? null;
  const statusTone: Tone = !s ? "neutral" : s.discrepancies === 0 ? "up" : s.status === "error" ? "down" : "warn";

  const pill = s ? (
    <Pill tone={statusTone} dot title={s.discrepancies ? `✗ ${s.counts.error} · ⚠ ${s.counts.warn}` : undefined}>
      {s.discrepancies === 0 ? t("reconcile.allMatch") : s.label}
    </Pill>
  ) : null;

  const actions = (
    <>
      {pill}
      {!compact && (
        <>
          <Button type="button" variant="outline" size="sm" onClick={exportCsv} disabled={!data || !s?.discrepancies} aria-label={t("reconcile.csvAria")}>
            <Download className="mr-1 h-4 w-4" aria-hidden="true" /> CSV
          </Button>
          <Button type="button" variant="ghost" size="icon" onClick={() => q.refetch()} disabled={q.isFetching} aria-label={t("reconcile.recalc")}>
            <RefreshCw className={cn("h-4 w-4", q.isFetching && "animate-spin")} aria-hidden="true" />
          </Button>
        </>
      )}
    </>
  );

  const days = React.useMemo(() => (data?.days ?? []).filter((d) => !onlyBad || d.status !== "ok"), [data, onlyBad]);
  const daySort = useTableSort(days, DAY_ACCESSORS, "date", "desc");
  const issues = (data?.issues ?? []).filter((i) => i.severity !== "ok" && (issueFilter === "all" || i.severity === issueFilter));

  return (
    <Panel
      title={t("reconcile.title")}
      description={compact ? undefined : t("reconcile.description")}
      icon={Scale}
      actions={actions}
      aria-busy={q.isFetching}
    >
      {!compact && (
        <div className="mb-4 flex flex-wrap items-end gap-3">
          {staff && !traderProp && (
            <div className="grid gap-1">
              <label className="text-xs text-muted-foreground" id="rc-trader-label">{t("reconcile.trader")}</label>
              <PersonSelect value={picked} onValueChange={setPicked} allValue={ALL} allLabel={commonI18n.t("fields.wholeDesk")} options={traders} ariaLabel={t("reconcile.trader")} className="h-9 w-48" />
            </div>
          )}
          <div className="grid gap-1">
            <label htmlFor="rc-from" className="text-xs text-muted-foreground">{t("reconcile.from")}</label>
            <Input id="rc-from" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="h-9 w-40" />
          </div>
          <div className="grid gap-1">
            <label htmlFor="rc-to" className="text-xs text-muted-foreground">{t("reconcile.to")}</label>
            <Input id="rc-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="h-9 w-40" />
          </div>
          {(from || to) && <Button type="button" variant="ghost" size="sm" onClick={() => { setFrom(""); setTo(""); }}>{t("reconcile.allPeriod")}</Button>}
        </div>
      )}

      {q.isLoading ? (
        <div className="grid gap-3" aria-label={t("reconcile.loadingAria")}><Skeleton className="h-20 w-full" /><Skeleton className="h-40 w-full" /></div>
      ) : q.isError ? (
        <EmptyState
          icon={Scale}
          title={isNotFound(q.error) ? t("reconcile.notConnected") : t("reconcile.failed")}
          description={q.error instanceof Error ? q.error.message : String(q.error)}
          action={<Button type="button" variant="outline" size="sm" onClick={() => q.refetch()}>{commonI18n.t("actions.retry")}</Button>}
        />
      ) : !data || !s || s.tradesChecked === 0 ? (
        <EmptyState icon={Scale} title={t("reconcile.noTrades")} description={t("reconcile.noTradesHint")} />
      ) : compact ? (
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <div><div className="text-xs text-muted-foreground">{t("reconcile.journalNet")}</div><div className={cn("font-semibold tabular-nums", toneOfMoney(s.journal.net) === "up" ? "text-up" : toneOfMoney(s.journal.net) === "down" ? "text-down" : "")}>{fmtUsd(s.journal.net, { signed: true })}</div></div>
            <div><div className="text-xs text-muted-foreground">{t("reconcile.brokerNet")}</div><div className="font-semibold tabular-nums">{repNet ? fmtUsd(repNet.broker, { signed: true }) : "—"}</div></div>
            <div><div className="text-xs text-muted-foreground">{t("reconcile.diffLabel")}</div><div className="font-semibold tabular-nums">{repNet ? fmtUsd(repNet.diff, { signed: true }) : "—"}</div></div>
            <div><div className="text-xs text-muted-foreground">{t("reconcile.daysWithIssues")}</div><div className="font-semibold tabular-nums">{s.daysWithIssues} / {s.days}</div></div>
          </div>
          {issues.length > 0 && <ul className="grid gap-2">{issues.slice(0, 4).map((i) => <IssueItem key={i.id} issue={i} trader={scopeName} />)}</ul>}
          {issues.length > 4 && <p className="text-xs text-muted-foreground">{t("reconcile.more", { count: issues.length - 4 })}</p>}
        </div>
      ) : (
        <div className="grid gap-5">
          <StatGrid>
            <StatCard label={t("reconcile.journalNetFull")} value={fmtUsd(s.journal.net, { signed: true })} tone={toneOfMoney(s.journal.net)} hint={t("reconcile.journalHint", { gross: fmtUsd(s.journal.gross), fees: fmtUsd(s.journal.fees) })} />
            <StatCard label={t("reconcile.brokerNetFull")} value={repNet ? fmtUsd(repNet.broker, { signed: true }) : "—"} hint={rep ? `${rep.periodFrom} — ${rep.periodTo}` : t("reconcile.noReport")} />
            <StatCard
              label={t("reconcile.diffBroker")}
              value={repNet ? fmtUsd(repNet.diff, { signed: true }) : "—"}
              tone={!repNet || repNet.status === "ok" ? "neutral" : repNet.status === "error" ? "down" : "warn"}
              hint={repNet?.cause === "fee_rounding" ? feeRoundingLabel() : repNet?.note}
            />
            <StatCard label={t("reconcile.checked")} value={t("reconcile.checkedValue", { count: s.tradesChecked })} hint={s.manual.trades ? t("reconcile.checkedHintManual", { days: s.days, with: s.fills.withFills, without: s.fills.withoutFills, manual: s.manual.trades }) : t("reconcile.checkedHint", { days: s.days, with: s.fills.withFills, without: s.fills.withoutFills })} />
          </StatGrid>

          {s.roundingIssues > 0 && (
            <p className="rounded-xl border border-border/50 px-3 py-2 text-xs text-muted-foreground">
              <Pill tone="accent">{feeRoundingLabel()}</Pill>{" "}
              {t("reconcile.rounding", { count: s.roundingIssues, total: s.discrepancies })}
            </p>
          )}

          {data.reports.length > 0 ? (
            data.reports.map((r) => <ReportBlock key={r.reportId} rep={r} />)
          ) : (
            <p className="text-xs text-muted-foreground">{t("reconcile.noReportText")}</p>
          )}

          <section aria-labelledby="rc-days-title" className="grid gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id="rc-days-title" className="text-sm font-semibold">{t("reconcile.byDays")} <span className="font-normal text-muted-foreground">{t("reconcile.byDaysCount", { bad: s.daysWithIssues, total: s.days })}</span></h3>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" checked={onlyBad} onChange={(e) => setOnlyBad(e.target.checked)} /> {t("reconcile.onlyBad")}
              </label>
            </div>
            {days.length === 0 ? (
              <p className="text-xs text-muted-foreground">{onlyBad ? t("reconcile.allDaysOk") : t("reconcile.noDays")}</p>
            ) : (
              <DataTable maxHeight="75vh" ariaLabel={t("reconcile.daysAria")}>
                <table>
                  <thead>
                    <tr>
                      <th scope="col" className="w-8"><span className="sr-only">{t("reconcile.expand")}</span></th>
                      <SortableTh {...daySort.thProps("date")}>{t("reconcile.col.date")}</SortableTh>
                      <SortableTh {...daySort.thProps("status")}>{t("reconcile.col.status")}</SortableTh>
                      <SortableTh {...daySort.thProps("trades")} align="right">{t("reconcile.col.trades")}</SortableTh>
                      <SortableTh {...daySort.thProps("gross")} align="right">{t("reconcile.col.gross")}</SortableTh>
                      <SortableTh {...daySort.thProps("fees")} align="right">{t("reconcile.col.fees")}</SortableTh>
                      <SortableTh {...daySort.thProps("net")} align="right">{t("reconcile.col.net")}</SortableTh>
                      <SortableTh {...daySort.thProps("brokerNet")} align="right">{t("reconcile.col.brokerNet")}</SortableTh>
                      <SortableTh {...daySort.thProps("diff")} align="right">{t("reconcile.col.diff")}</SortableTh>
                      <SortableTh {...daySort.thProps("manual")} align="right">{t("reconcile.col.manual")}</SortableTh>
                    </tr>
                  </thead>
                  <tbody>
                    {daySort.rows.map((d) => {
                      const isOpen = open.has(d.date);
                      const diff = dayDiff(d);
                      const dayIssues = d.issueIds.map((id) => issueById.get(id)).filter((x): x is Issue => !!x);
                      return (
                        <React.Fragment key={d.date}>
                          <tr className="cursor-pointer" onClick={() => toggle(d.date)}>
                            <td>
                              <button type="button" className="grid h-6 w-6 place-items-center rounded hover:bg-[var(--glass-bg)]" aria-expanded={isOpen} aria-label={isOpen ? t("reconcile.collapseDay", { date: d.date }) : t("reconcile.expandDay", { date: d.date })} onClick={(e) => { e.stopPropagation(); toggle(d.date); }}>
                                {isOpen ? <ChevronDown className="h-4 w-4" aria-hidden="true" /> : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
                              </button>
                            </td>
                            <td className="whitespace-nowrap">{d.date}</td>
                            <td><span className="inline-flex items-center gap-1"><StatusMark status={d.status} />{dayIssues.length > 0 && <span className="text-xs text-muted-foreground">{dayIssues.length}</span>}</span></td>
                            <td className="text-right">{d.journal.trades}</td>
                            <td className="text-right">{fmtUsd(d.journal.gross)}</td>
                            <td className="text-right">{fmtUsd(d.journal.fees)}</td>
                            <td className={cn("text-right font-medium", toneOfMoney(d.journal.net) === "up" ? "text-up" : toneOfMoney(d.journal.net) === "down" ? "text-down" : "")}>{fmtUsd(d.journal.net, { signed: true })}</td>
                            <td className="text-right">{d.broker ? fmtUsd(d.broker.net, { signed: true }) : "—"}</td>
                            <td className="text-right">{diff == null ? "—" : fmtUsd(Math.round(diff * 100) / 100, { signed: true })}</td>
                            <td className="text-right text-muted-foreground">{d.manual.trades || ""}</td>
                          </tr>
                          {isOpen && (
                            <tr>
                              <td colSpan={10} className="bg-[var(--glass-bg)]"><DayDetails day={d} issues={dayIssues} trader={scopeName} /></td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </DataTable>
            )}
          </section>

          <section aria-labelledby="rc-issues-title" className="grid gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id="rc-issues-title" className="text-sm font-semibold">{t("reconcile.issues")} <span className="font-normal text-muted-foreground">(✗ {s.counts.error} · ⚠ {s.counts.warn})</span></h3>
              <div className="flex gap-1" role="group" aria-label={t("reconcile.issuesFilterAria")}>
                {(["all", "error", "warn"] as const).map((f) => (
                  <Button key={f} type="button" size="sm" variant={issueFilter === f ? "secondary" : "ghost"} aria-pressed={issueFilter === f} onClick={() => setIssueFilter(f)}>
                    {t(`reconcile.filter.${f}`)}
                  </Button>
                ))}
              </div>
            </div>
            {issues.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("reconcile.noIssues")}</p>
            ) : (
              <ul className="grid max-h-[75vh] gap-2 overflow-auto pr-1">{issues.slice(0, 300).map((i) => <IssueItem key={i.id} issue={i} trader={scopeName} />)}</ul>
            )}
            {(issues.length > 300 || data.issuesTruncated) && <p className="text-xs text-muted-foreground">{t("reconcile.first300")}</p>}
          </section>
        </div>
      )}
    </Panel>
  );
}

export default ReconcilePanel;
