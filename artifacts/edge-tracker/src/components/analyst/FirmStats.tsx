import * as React from "react";
import { Building2, Info, Scale, Search } from "lucide-react";
import { DataTable, Delta, EmptyState, Panel, ProgressRing, SortableTh, TermTooltip, useTableSort } from "@/components/ds";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { FirmStat, FirmStatsResponse, FirmWeightResponse, FirmWeightRow } from "./api";
import { isTopFirm, WEIGHT_MIN_N, type FirmWeightLite } from "./lib";
import { fmtPct, fmtRate } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { analystI18n } from "@/i18n/ns/analyst";

/** Translator reference (called at render time, never at module scope). */
const tf = analystI18n.t;
const days = (n: number) => commonI18n.t("units.days", { count: n });

/** Edge of a firm's confirmation rate over the street's base rate, in percentage points. */
function edgePp(f: FirmStat, base: number | null): number | null {
  if (f.confirmRate == null || base == null || f.evaluated < 5) return null;
  return (f.confirmRate - base) * 100;
}

function confirmTone(f: FirmStat, base: number | null) {
  const e = edgePp(f, base);
  if (e == null) return "neutral" as const;
  return e >= 3 ? ("up" as const) : e <= -3 ? ("down" as const) : ("accent" as const);
}

/** Compact bento tile: most active firms in the window with their confirmation rate. */
export function FirmStatsPanel({
  data,
  isLoading,
  activeFirm,
  windowCounts,
  onPickFirm,
  onOpenAll,
}: {
  data: FirmStatsResponse | null | undefined;
  isLoading: boolean;
  activeFirm: string | null;
  /** Actions per firm inside the current window — ranks the list by what is relevant now. */
  windowCounts: Map<string, number>;
  onPickFirm: (firm: string) => void;
  onOpenAll: () => void;
}) {
  const base = data?.baseRate ?? null;
  const top = React.useMemo(() => {
    if (!data) return [];
    const byName = new Map(data.firms.map((f) => [f.firm, f]));
    const ranked = Array.from(windowCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([firm, n]) => ({ stat: byName.get(firm), firm, n }))
      .filter((x) => x.stat)
      .slice(0, 7);
    return ranked.length ? ranked : data.firms.slice(0, 7).map((f) => ({ stat: f, firm: f.firm, n: 0 }));
  }, [data, windowCounts]);

  return (
    <Panel
      title={tf("firms.reliability")}
      description={data ? tf("firms.reliabilityDescription", { days: days(data.followDays), base: fmtRate(base) }) : tf("firms.confirmation")}
      icon={Building2}
      actions={
        data ? (
          <Button variant="ghost" size="sm" onClick={onOpenAll}>{tf("firms.all")}</Button>
        ) : undefined
      }
    >
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full rounded-xl" />)}
        </div>
      ) : !data ? (
        <p className="text-xs text-muted-foreground">{tf("firms.apiLater")}</p>
      ) : top.length === 0 ? (
        <p className="text-xs text-muted-foreground">{tf("firms.notEnough")}</p>
      ) : (
        <ul className="flex flex-col gap-1" aria-label={tf("firms.activeAria")}>
          {top.map(({ stat, firm, n }) => {
            const f = stat!;
            const e = edgePp(f, base);
            const active = activeFirm === firm;
            return (
              <li key={firm}>
                <button
                  type="button"
                  onClick={() => onPickFirm(firm)}
                  aria-pressed={active}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-[var(--glass-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active && "bg-primary/10 ring-1 ring-primary/30",
                  )}
                >
                  <ProgressRing value={f.confirmRate ?? 0} max={1} size={34} stroke={3} tone={confirmTone(f, base)} ariaLabel={tf("firms.confirmAria", { value: fmtRate(f.confirmRate) })} label={f.confirmRate == null ? "—" : Math.round(f.confirmRate * 100)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground" title={firm}>{firm}</span>
                    <span className="block truncate text-2xs text-muted-foreground tabular-nums">
                      {n ? tf("firms.inPeriod", { count: n }) : ""}▲{f.upgrades} ▼{f.downgrades} · {tf("firms.totalIn", { total: f.total, days: days(data.days) })}
                    </span>
                  </span>
                  {e != null && (
                    <span title={tf("firms.edgeTitle")}>
                      <Delta value={e} suffix={tf("firms.pp")} precision={0} showIcon={false} />
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/**
 * «Вес фирм»: whose rating calls actually move stocks (avg |day move| / typical day, from daily candles).
 * Ranked by weight among firms with ≥ 5 measured rating calls; «В ленте» = firms active in the current window.
 */
export function FirmWeightPanel({
  data,
  isLoading,
  activeFirm,
  windowCounts,
  onPickFirm,
  onOpenAll,
}: {
  data: FirmWeightResponse;
  isLoading: boolean;
  activeFirm: string | null;
  windowCounts: Map<string, number>;
  onPickFirm: (firm: string) => void;
  onOpenAll: () => void;
}) {
  const [mode, setMode] = React.useState<"now" | "all">("now");
  const ranked = React.useMemo(() => {
    const ok = data.firms.filter((f) => f.rating.n >= WEIGHT_MIN_N && f.rating.avgRatio != null);
    const list = mode === "now" ? ok.filter((f) => windowCounts.has(f.firm)) : ok;
    return [...list].sort((a, b) => (b.rating.avgRatio ?? 0) - (a.rating.avgRatio ?? 0)).slice(0, 7);
  }, [data, mode, windowCounts]);
  const max = Math.max(2, ...ranked.map((f) => f.rating.avgRatio ?? 0));
  const cov = data.coverage;
  return (
    <Panel
      icon={Scale}
      title={
        <span className="inline-flex items-center gap-1.5">
          {tf("firms.weight")}
          <TermTooltip term="firmWeight" icon />
        </span>
      }
      description={tf("firms.weightDescription", { years: Math.round(data.days / 365), ratio: data.street.avgRatio?.toFixed(1) ?? "—" })}
      actions={<Button variant="ghost" size="sm" onClick={onOpenAll}>{tf("firms.all")}</Button>}
      footer={
        <span className="tabular-nums">
          {tf("firms.coverage", { tickers: cov.tickers, total: cov.ratedTickers })}{cov.warming ? tf("firms.warming") : ""}
        </span>
      }
      bodyClassName="min-h-[220px]"
    >
      <div className="mb-2 flex gap-1" role="group" aria-label={tf("firms.modeAria")}>
        {(["now", "all"] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => setMode(m)}
            className={cn(
              "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
              mode === m ? "bg-primary/12 text-accent-soft" : "text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground",
            )}
          >
            {m === "now" ? tf("firms.modeNow") : tf("firms.modeAll")}
          </button>
        ))}
      </div>
      {isLoading ? (
        <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-9 w-full rounded-xl" />)}</div>
      ) : ranked.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {mode === "now" ? tf("firms.fewNow") : tf("firms.fewAll")}
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5" aria-label={tf("firms.byWeightAria")}>
          {ranked.map((f) => {
            const r = f.rating.avgRatio ?? 0;
            const active = activeFirm === f.firm;
            const inFeed = windowCounts.get(f.firm) ?? 0;
            return (
              <li key={f.firm}>
                <button
                  type="button"
                  onClick={() => onPickFirm(f.firm)}
                  aria-pressed={active}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-[var(--glass-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active && "bg-primary/10 ring-1 ring-primary/30",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-foreground" title={f.firm}>{f.firm}</span>
                      {inFeed > 0 && <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">{tf("firms.inFeed", { count: inFeed })}</span>}
                    </span>
                    <span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-[var(--glass-bg)]" aria-hidden="true">
                      <span className={cn("block h-full rounded-full", r >= 1.5 ? "bg-purple" : "bg-muted-foreground")} style={{ width: `${Math.min(100, (r / max) * 100)}%` }} />
                    </span>
                  </span>
                  <span className="w-16 shrink-0 text-right tabular-nums">
                    <span className={cn("block text-sm font-semibold", r >= 1.5 ? "text-purple" : "text-foreground")}>×{r.toFixed(1)}</span>
                    <span className="block text-2xs text-muted-foreground">
                      {f.rating.hitRate != null ? `${fmtRate(f.rating.hitRate)} · ` : ""}n={f.rating.n}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

type SortKey = "total" | "confirm" | "rating" | "pt" | "pre" | "firm" | "weight" | "hit";

/** Full sortable table of firms in a side sheet. */
export function FirmStatsSheet({
  open,
  onOpenChange,
  data,
  activeFirm,
  onPickFirm,
  weights,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  data: FirmStatsResponse | null | undefined;
  activeFirm: string | null;
  onPickFirm: (firm: string) => void;
  /** Firm weight from candles (null on older API builds — columns hidden). */
  weights?: FirmWeightResponse | null;
}) {
  const wMap = React.useMemo(() => {
    const m = new Map<string, FirmWeightRow>();
    for (const f of weights?.firms ?? []) m.set(f.firm, f);
    return m;
  }, [weights]);
  const hasW = wMap.size > 0;
  const lite = (f: FirmWeightRow | undefined): FirmWeightLite | null =>
    f ? { n: f.rating.n, ratio: f.rating.avgRatio, hit: f.rating.hitRate, avgSignedDay: f.rating.avgSignedDay } : null;
  const [q, setQ] = React.useState("");
  const base = data?.baseRate ?? null;
  const rows = React.useMemo(() => {
    const list = data?.firms ?? [];
    const s = q.trim().toLowerCase();
    return s ? list.filter((f) => f.firm.toLowerCase().includes(s)) : list;
  }, [data, q]);
  const accessors = React.useMemo<Record<SortKey, (f: FirmStat) => number | string | null>>(() => ({
    total: (f) => f.total,
    confirm: (f) => (f.evaluated >= 5 ? f.confirmRate : null),
    rating: (f) => (f.ratingEvaluated >= 3 ? f.ratingConfirmRate : null),
    pt: (f) => f.avgPtChange,
    pre: (f) => f.premarketShare,
    firm: (f) => f.firm,
    weight: (f) => { const w = wMap.get(f.firm); return w && w.rating.n >= WEIGHT_MIN_N ? w.rating.avgRatio : null; },
    hit: (f) => { const w = wMap.get(f.firm); return w && w.rating.n >= WEIGHT_MIN_N ? w.rating.hitRate : null; },
  }), [wMap]);
  const { rows: sorted, thProps } = useTableSort(rows, accessors, "total");

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-3xl xl:max-w-4xl [&>*]:shrink-0">
        <SheetHeader>
          <SheetTitle>{tf("firms.sheetTitle")}</SheetTitle>
          <SheetDescription>
            {data ? tf("firms.sheetDescription", { days: days(data.days), actions: tf("firms.actionsCount", { count: data.totalActions }), base: fmtRate(base) }) : commonI18n.t("states.loading")}
          </SheetDescription>
        </SheetHeader>
        <div className="glass-panel flex items-start gap-2 rounded-xl p-3 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>
            <span className="font-medium text-foreground">{tf("firms.helpConfirm")}</span> {tf("firms.helpConfirmText", { days: days(data?.followDays ?? 30) })}
            {hasW && <> <span className="font-medium text-foreground">{tf("firms.helpWeight")}</span> {tf("firms.helpWeightText", { min: WEIGHT_MIN_N })}</>}
            {" "}{tf("firms.helpClick")}
          </p>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tf("firms.find")} aria-label={tf("firms.find")} className="pl-9" />
        </div>
        {!data ? (
          <Skeleton className="h-64 w-full rounded-xl" />
        ) : sorted.length === 0 ? (
          <EmptyState icon={Building2} title={tf("firms.notFound")} />
        ) : (
          <DataTable className="min-h-[280px] flex-1" ariaLabel={tf("firms.tableAria")} stickyFirstCol>
            <table>
              <thead>
                <tr>
                  <SortableTh {...thProps("firm")}>{tf("firms.colFirm")}</SortableTh>
                  <SortableTh {...thProps("total")} align="right">{tf("firms.colActions")}</SortableTh>
                  <SortableTh {...thProps("confirm")} align="right">{tf("firms.colConfirm")}</SortableTh>
                  <SortableTh {...thProps("rating")} align="right">{tf("firms.colRatings")}</SortableTh>
                  <SortableTh {...thProps("pt")} align="right">{tf("firms.colPt")}</SortableTh>
                  <SortableTh {...thProps("pre")} align="right">{tf("firms.colPre")}</SortableTh>
                  {hasW && <SortableTh {...thProps("weight")} align="right">{tf("firms.colWeight")}</SortableTh>}
                  {hasW && <SortableTh {...thProps("hit")} align="right">{tf("firms.colHit")}</SortableTh>}
                </tr>
              </thead>
              <tbody>
                {sorted.map((f) => {
                  const e = edgePp(f, base);
                  const w = wMap.get(f.firm);
                  const wOk = !!w && w.rating.n >= WEIGHT_MIN_N;
                  return (
                    <tr key={f.firm} className={cn(activeFirm === f.firm && "bg-primary/10")}>
                      <td className="max-w-[11rem]">
                        <button
                          type="button"
                          onClick={() => { onPickFirm(f.firm); onOpenChange(false); }}
                          title={f.firm}
                          className="max-w-full truncate text-left font-medium text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                        >
                          {f.firm}
                        </button>
                        <div className="text-2xs text-muted-foreground">
                          ▲{f.upgrades} ▼{f.downgrades} · {tf("firms.tickersShort", { count: f.tickers })}{isTopFirm(f.firm, lite(w)) ? tf("firms.top") : ""}
                        </div>
                      </td>
                      <td className="text-right">{f.total}</td>
                      <td className="text-right">
                        <div className="font-medium">{f.evaluated >= 5 ? fmtRate(f.confirmRate) : "—"}</div>
                        {e != null && <Delta value={e} suffix={tf("firms.pp")} precision={0} showIcon={false} bare className="text-2xs" />}
                      </td>
                      <td className="text-right">
                        {f.ratingEvaluated >= 3 ? (
                          <span>{fmtRate(f.ratingConfirmRate)} <span className="text-2xs text-muted-foreground">n={f.ratingEvaluated}</span></span>
                        ) : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="text-right"><Delta value={f.avgPtChange} suffix="%" bare showIcon={false} /></td>
                      <td className="text-right">{fmtRate(f.premarketShare)}</td>
                      {hasW && (
                        <td className="text-right">
                          {wOk ? (
                            <span className={cn("font-medium", (w!.rating.avgRatio ?? 0) >= 1.5 && "text-purple")}>
                              ×{w!.rating.avgRatio?.toFixed(1) ?? "—"} <span className="text-2xs font-normal text-muted-foreground">n={w!.rating.n}</span>
                            </span>
                          ) : <span className="text-muted-foreground">—</span>}
                        </td>
                      )}
                      {hasW && (
                        <td className="text-right" title={wOk ? tf("firms.avgSigned", { value: fmtPct(w!.rating.avgSignedDay, 1) }) : undefined}>
                          {wOk ? fmtRate(w!.rating.hitRate) : <span className="text-muted-foreground">—</span>}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </DataTable>
        )}
      </SheetContent>
    </Sheet>
  );
}
