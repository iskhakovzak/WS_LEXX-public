import { useMemo, useState } from "react";
import type { Trade } from "@workspace/api-client-react";
import { BarChart3 } from "lucide-react";
import { Panel, Segmented, EmptyState, toneOf, toneText } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  type Metric, type ValueFn, type GroupBreakdown,
  TIME_BUCKETS, dayOfWeekOptions, buildGroupBreakdown, timeBucketFor, dayOfWeek,
} from "@/lib/analytics-pro";
import { fmtVal, loadPref, savePref } from "./pro-format";
import { fmtRate } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { analyticsProI18n } from "@/i18n/ns/analyticsPro";

type Dim = "setup" | "time" | "weekday" | "ticker" | "side";
type Mode = "net" | "profit" | "loss";
const DIMS = ["setup", "time", "weekday", "ticker", "side"] as const;
const DIM_KEY = "analyticsPro.breakdownDim";
const LIMIT = 14;

const tp = analyticsProI18n.t;
const dimLabel = (d: Dim) => tp(`breakdown.dim.${d}`);

type Row = GroupBreakdown & { winRate: number | null; order: number };

function bucketFor(dim: Dim) {
  return (t: Trade): { id: string; label: string } => {
    switch (dim) {
      case "setup": return { id: t.setup || "—", label: t.setup || tp("breakdown.noSetup") };
      case "ticker": return { id: t.ticker || "—", label: t.ticker || "—" };
      case "side": {
        const s = (t.side ?? "").toLowerCase();
        return s.startsWith("s") ? { id: "short", label: commonI18n.t("trading.short") } : s.startsWith("l") ? { id: "long", label: commonI18n.t("trading.long") } : { id: "—", label: tp("breakdown.sideNotSet") };
      }
      case "time": {
        const id = timeBucketFor(t);
        return { id, label: TIME_BUCKETS.find((b) => b.id === id)?.label ?? id };
      }
      case "weekday": {
        const d = String(dayOfWeek(t));
        return { id: d, label: dayOfWeekOptions().find((o) => o.id === d)?.label ?? "—" };
      }
    }
  };
}

/** Totals by setup / time / weekday / ticker / side with diverging bars. */
export function BreakdownPanel({ trades, metric, val }: { trades: Trade[]; metric: Metric; val: ValueFn }) {
  const [dim, setDim] = useState<Dim>(() => loadPref(DIM_KEY, DIMS) ?? "setup");
  const [mode, setMode] = useState<Mode>("net");
  const [showAll, setShowAll] = useState(false);

  const rows: Row[] = useMemo(() => {
    const bucket = bucketFor(dim);
    const base = buildGroupBreakdown(trades, bucket, val);
    const wins = new Map<string, { w: number; n: number }>();
    for (const t of trades) {
      const v = val(t);
      if (v == null) continue;
      const id = bucket(t).id;
      const r = wins.get(id) ?? { w: 0, n: 0 };
      r.n += 1;
      if (v > 0) r.w += 1;
      wins.set(id, r);
    }
    const orderOf = (key: string) => {
      if (dim === "time") return TIME_BUCKETS.findIndex((b) => b.id === key);
      if (dim === "weekday") return dayOfWeekOptions().findIndex((o) => o.id === key);
      return 0;
    };
    return base.map((r) => {
      const w = wins.get(r.key);
      return { ...r, winRate: w && w.n ? w.w / w.n : null, order: orderOf(r.key) };
    });
  }, [trades, dim, val]);

  const all = useMemo(() => {
    const natural = dim === "time" || dim === "weekday";
    if (mode === "profit") return rows.filter((r) => r.profit > 0).sort((a, b) => b.profit - a.profit);
    if (mode === "loss") return rows.filter((r) => r.loss < 0).sort((a, b) => a.loss - b.loss);
    return natural ? [...rows].sort((a, b) => a.order - b.order) : [...rows].sort((a, b) => b.net - a.net);
  }, [rows, mode, dim]);
  // Top 14 by default; tickers / setups often have more groups — «Показать все» reveals the rest.
  const shown = showAll ? all : all.slice(0, LIMIT);

  const valueOf = (r: Row) => (mode === "profit" ? r.profit : mode === "loss" ? r.loss : r.net);
  const max = Math.max(0, ...shown.map((r) => Math.abs(valueOf(r))));
  const diverging = mode === "net" && shown.some((r) => r.net < 0) && shown.some((r) => r.net > 0);

  return (
    <Panel
      icon={BarChart3}
      title={tp("breakdown.title")}
      description={tp("breakdown.hint")}
      actions={
        <Segmented<Mode>
          size="sm"
          ariaLabel={tp("breakdown.modeAria")}
          value={mode}
          onChange={setMode}
          options={[{ value: "net", label: tp("breakdown.mode.net") }, { value: "profit", label: tp("breakdown.mode.profit") }, { value: "loss", label: tp("breakdown.mode.loss") }]}
        />
      }
    >
      <Segmented
        size="sm"
        className="mb-3"
        ariaLabel={tp("breakdown.groupAria")}
        value={dim}
        onChange={(d) => { setDim(d); savePref(DIM_KEY, d); setShowAll(false); }}
        options={DIMS.map((d) => ({ value: d, label: dimLabel(d) }))}
      />
      {shown.length === 0 ? (
        <EmptyState
          icon={BarChart3}
          title={mode === "profit" ? tp("breakdown.noProfit") : mode === "loss" ? tp("breakdown.noLoss") : tp("breakdown.noData")}
          description={metric === "pnl" ? tp("breakdown.tryR") : undefined}
          className="py-8"
        />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {shown.map((r) => {
            const v = valueOf(r);
            const pct = max ? (Math.abs(v) / max) * 100 : 0;
            return (
              <li key={r.key} className="grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)_auto] items-center gap-2 text-sm sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto_auto]">
                <span className="truncate" title={r.label}>{r.label}</span>
                <div className="relative h-5" aria-hidden="true">
                  {diverging ? (
                    <>
                      <span className="absolute inset-y-0 left-1/2 w-px bg-border" />
                      <span
                        className={cn("absolute inset-y-0.5 rounded-full", v >= 0 ? "left-1/2 bg-up/70" : "right-1/2 bg-down/70")}
                        style={{ width: `${pct / 2}%` }}
                      />
                    </>
                  ) : (
                    <span
                      className={cn("absolute inset-y-0.5 left-0 rounded-full", v >= 0 ? "bg-up/70" : "bg-down/70", v === 0 && "bg-border")}
                      style={{ width: `${Math.max(pct, v === 0 ? 0 : 2)}%` }}
                    />
                  )}
                </div>
                <span className={cn("w-[4.75rem] text-right font-semibold tabular-nums", toneText(toneOf(v)))}>
                  {fmtVal(metric, v, { compact: true, sign: true })}
                </span>
                <span className="hidden w-[6.5rem] text-right text-xs tabular-nums text-muted-foreground sm:inline">
                  {r.count} · {fmtRate(r.winRate)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {all.length > LIMIT && (
        <Button variant="ghost" size="sm" className="mt-2 rounded-full" onClick={() => setShowAll((v) => !v)}>
          {showAll ? tp("breakdown.collapse") : tp("breakdown.showAll", { count: all.length })}
        </Button>
      )}
      {shown.length > 0 && (
        <p className="mt-3 hidden text-2xs text-muted-foreground sm:block">{tp("breakdown.legend")}</p>

      )}
    </Panel>
  );
}
