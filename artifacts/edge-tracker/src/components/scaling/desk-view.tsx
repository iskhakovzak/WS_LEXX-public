import * as React from "react";
import { ArrowDownRight, ArrowUpRight, Inbox, Search, TrendingUp, Users } from "lucide-react";
import { DataTable, EmptyState, FilterChip, Panel, Pill, SortableTh, StatCard, StatGrid, Toolbar, useTableSort } from "@/components/ds";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { cn } from "@/lib/utils";
import { fmtRate } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { scalingI18n } from "@/i18n/ns/scaling";
import { personName } from "@/i18n";
import type { Action, Evaluation, TraderEval } from "./use-scaling";
import { useEvaluation, useProposals } from "./use-scaling";
import { ProposalCard } from "./proposal-card";
import { TraderSheet } from "./trader-sheet";
import { ProposeButton, TierPopover } from "./curator-actions";
import { ACTION_TONE, actionLabel, fmtMetric, tierLabel } from "./format";

type Filter = "all" | "action" | "pending";
const FILTERS: readonly Filter[] = ["all", "action", "pending"];

const ACCESSORS = {
  trader: (r: TraderEval) => personName(r.trader),
  tier: (r: TraderEval) => r.tier?.order ?? -1,
  action: (r: TraderEval) => ({ demote: 0, promote: 1, assign: 2, hold: 3 } as Record<Action, number>)[r.recommendation.action],
  progress: (r: TraderEval) => r.progress,
  net: (r: TraderEval) => metric(r, "net_pnl") ?? metric(r, "net_r"),
  pf: (r: TraderEval) => metric(r, "profit_factor"),
  dd: (r: TraderEval) => metric(r, "max_dd_pct"),
  discipline: (r: TraderEval) => metric(r, "discipline"),
  breaches: (r: TraderEval) => metric(r, "limit_breaches"),
};

function metric(r: TraderEval, key: string): number | null {
  const w = r.windows.find((x) => x.windowDays === 20) ?? r.windows[0];
  return w?.values[key]?.value ?? null;
}

function MiniBar({ value }: { value: number | null }) {
  const { t } = scalingI18n.useT();
  if (value == null) return <span className="text-xs text-muted-foreground">—</span>;
  const pct = Math.round(value * 100);
  const label = fmtRate(value);
  return (
    <div className="flex items-center gap-2" title={t("progress.meterTitle", { value: label })}>
      <div role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={t("progress.aria")} className="h-1.5 w-20 overflow-hidden rounded-full bg-[var(--glass-bg)] ring-1 ring-inset ring-[var(--glass-border)]">
        <div className={cn("h-full rounded-full", pct >= 100 ? "bg-up" : "bg-primary")} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground">{label}</span>
    </div>
  );
}

export function DeskView({ onUpdatedAt, focusTrader = null }: {
  onUpdatedAt?: (ts: number) => void;
  /** Deep link ?trader=X: open that trader's card once the evaluation has loaded. */
  focusTrader?: string | null;
}) {
  const { t } = scalingI18n.useT();
  const { t: tc } = commonI18n.useT();
  const ev = useEvaluation(null);
  const pending = useProposals("pending", null);
  const [filter, setFilter] = React.useState<Filter>("all");
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState<string | null>(focusTrader);
  React.useEffect(() => { if (focusTrader) setSelected(focusTrader); }, [focusTrader]);
  const searchRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => { if (ev.dataUpdatedAt) onUpdatedAt?.(ev.dataUpdatedAt); }, [ev.dataUpdatedAt, onUpdatedAt]);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !e.ctrlKey && !e.metaKey && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const data: Evaluation | undefined = ev.data;
  const all = data?.traders ?? [];
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((r) => {
      if (q && !r.trader.toLowerCase().includes(q) && !personName(r.trader).toLowerCase().includes(q)) return false;
      if (filter === "action") return r.recommendation.action !== "hold" || r.recommendation.warning;
      if (filter === "pending") return !!r.pendingProposal;
      return true;
    });
  }, [all, query, filter]);
  const { rows, thProps } = useTableSort(filtered, ACCESSORS, "action", "asc");
  const metricsMeta = React.useMemo(() => new Map((data?.meta.metrics ?? []).map((m) => [m.key, m])), [data]);
  const selectedRow = all.find((r) => r.trader === selected) ?? null;
  const pendingList = pending.data?.proposals ?? [];

  if (ev.isError) {
    return <Panel><QueryError error={ev.error} onRetry={() => ev.refetch()} title={t("desk.loadFailed")} /></Panel>;
  }

  const s = data?.summary;
  const actionCount = all.filter((r) => r.recommendation.action !== "hold" || r.recommendation.warning).length;
  const filterLabel = (f: Filter) => (f === "all" ? tc("states.all") : f === "action" ? t("desk.filterAction") : t("desk.filterPending"));

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <StatGrid>
        {ev.isLoading || !s ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[92px] rounded-2xl" />)
        ) : (
          <>
            <StatCard label={t("desk.statTraders")} value={s.traders} icon={Users} hint={s.assign ? t("desk.statNoTier", { count: s.assign }) : t("desk.statAllHaveTier")} />
            <StatCard label={t("desk.statPromote")} value={s.promote} tone={s.promote ? "up" : "neutral"} icon={ArrowUpRight} hint={t("desk.statPromoteHint")} onClick={() => setFilter("action")} />
            <StatCard label={t("desk.statDemote")} value={s.demote + s.warnings} tone={s.demote + s.warnings ? "down" : "neutral"} icon={ArrowDownRight} hint={s.warnings ? t("desk.statDemoteBottom", { count: s.warnings }) : t("desk.statDemoteHint")} onClick={() => setFilter("action")} />
            <StatCard label={t("desk.statPending")} value={s.pending} tone={s.pending ? "warn" : "neutral"} icon={Inbox} hint={t("desk.statPendingHint")} onClick={() => setFilter("pending")} />
          </>
        )}
      </StatGrid>

      {(pending.isLoading || pendingList.length > 0) && (
        <Panel title={t("desk.queueTitle")} description={t("desk.queueDesc")} icon={Inbox}>
          {pending.isLoading ? (
            <div className="grid gap-2 md:grid-cols-2">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>
          ) : (
            <div className="grid gap-2 md:grid-cols-2">
              {pendingList.map((p) => (
                <ProposalCard key={p.id} proposal={p} tiers={data?.tiers ?? []} canDecide={!!data?.canEdit} onOpenTrader={setSelected} />
              ))}
            </div>
          )}
        </Panel>
      )}

      <Toolbar>
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("desk.searchPlaceholder")} aria-label={t("desk.searchAria")} className="pl-9" />
        </div>
        {FILTERS.map((f) => (
          <FilterChip key={f} active={filter === f} onClick={() => setFilter(f)} count={f === "all" ? all.length : f === "action" ? actionCount : s?.pending}>
            {filterLabel(f)}
          </FilterChip>
        ))}
      </Toolbar>

      <Panel padded={false} title={tc("trading.desk")} description={t("desk.tableDesc")} icon={TrendingUp}>
        {ev.isLoading ? (
          <div className="flex flex-col gap-2 p-4">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-11 rounded-xl" />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState icon={Users} title={all.length ? t("desk.emptyFiltered") : t("desk.emptyNone")} description={all.length ? t("desk.emptyFilteredHint") : t("desk.emptyNoneHint")} />
        ) : (
          <DataTable maxHeight="60vh" ariaLabel={t("desk.tableAria")}>
            <table>
              <thead>
                <tr>
                  <SortableTh {...thProps("trader")}>{tc("fields.trader")}</SortableTh>
                  <SortableTh {...thProps("tier")}>{tc("tiers.tier")}</SortableTh>
                  <SortableTh {...thProps("action")}>{t("desk.colRecommendation")}</SortableTh>
                  <SortableTh {...thProps("progress")}><span title={t("desk.colProgressFull")}>{t("desk.colProgress")}</span></SortableTh>
                  <SortableTh {...thProps("net")} align="right">{tc("trading.netPnl")} / R</SortableTh>
                  <SortableTh {...thProps("pf")} align="right">PF</SortableTh>
                  <SortableTh {...thProps("dd")} align="right">{tc("trading.drawdown")}</SortableTh>
                  <SortableTh {...thProps("discipline")} align="right"><span title={t("desk.colDisciplineFull")}>{t("desk.colDiscipline")}</span></SortableTh>
                  <SortableTh {...thProps("breaches")} align="right"><span title={t("desk.colBreachesFull")}>{t("desk.colBreaches")}</span></SortableTh>
                  <th scope="col" className="text-right"><span className="sr-only">{t("desk.colActions")}</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const action = r.recommendation.action;
                  const net = metric(r, "net_pnl");
                  const netR = metric(r, "net_r");
                  const pf = metric(r, "profit_factor");
                  const dd = metric(r, "max_dd_pct");
                  const disc = metric(r, "discipline");
                  const br = metric(r, "limit_breaches");
                  return (
                    <tr key={r.trader} className="group">
                      <td>
                        <button type="button" className="font-medium text-foreground hover:underline" onClick={() => setSelected(r.trader)}>{personName(r.trader)}</button>
                      </td>
                      <td><Pill tone="purple">{tierLabel(r.tier)}</Pill></td>
                      <td>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Pill tone={ACTION_TONE[action]} dot>{actionLabel(action)}{r.recommendation.toTier ? ` → ${tierLabel(r.recommendation.toTier)}` : ""}</Pill>
                          {r.recommendation.warning && <Pill tone="warn">{t("desk.review")}</Pill>}
                          {r.pendingProposal && <Pill tone="warn">{t("desk.queued")}</Pill>}
                        </div>
                      </td>
                      <td><MiniBar value={r.progress} /></td>
                      <td className={cn("whitespace-nowrap text-right", (net ?? netR ?? 0) > 0 ? "text-up" : (net ?? netR ?? 0) < 0 ? "text-down" : "")}>
                        {net != null ? fmtMetric("usd", net) : netR != null ? fmtMetric("r", netR) : "—"}
                      </td>
                      <td className="text-right">{fmtMetric("x", pf)}</td>
                      <td className={cn("text-right", dd != null && dd >= 100 ? "text-down" : dd != null && dd >= 50 ? "text-[hsl(var(--chart-3))]" : "")} title={metricsMeta.get("max_dd_pct")?.hint}>
                        {dd != null ? fmtMetric("pct", dd) : fmtMetric("usd", metric(r, "max_dd_usd"))}
                      </td>
                      <td className="text-right">{fmtMetric("score", disc)}</td>
                      <td className={cn("text-right", br ? "text-down" : "")}>{fmtMetric("count", br)}</td>
                      <td className="text-right">
                        {data?.canEdit && (
                          <div className="flex justify-end gap-1.5 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
                            {action === "assign" ? <TierPopover row={r} tiers={data.tiers} mode="assign" /> : <ProposeButton row={r} />}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </DataTable>
        )}
      </Panel>

      {data && <TraderSheet row={selectedRow} evaluation={data} open={!!selectedRow} onOpenChange={(o) => !o && setSelected(null)} />}
    </div>
  );
}
