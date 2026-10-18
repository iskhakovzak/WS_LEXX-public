import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/auth-context";
import { http } from "@/lib/api/http";
import { AlertTriangle, ChevronDown, LineChart, RefreshCw } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Pill, Segmented, toneOf, toneText, type Tone } from "@/components/ds";
import { Ring, Bar, winrateTone, lsGet, lsSet } from "@/components/playbook-sub/bits";
import { byCloseDate, isOpen, netPnl, resultOf, signedR } from "@/lib/trade-math";
import { commonI18n } from "@/i18n/ns/common";
import { fmtNum, fmtR, fmtRate, fmtUsd } from "@/lib/format";
import { playbookToolsI18n } from "@/i18n/ns/playbookTools";
import { HORIZON_LABEL } from "@/components/playbook/model";
import { redactedAggHint } from "@/components/playbook/setup-bits";

/** Mirror of api-server lib/playbookEdge.ts EdgeStats (shared trade math; every ratio is null without data). */
type EdgeStats = {
  count: number; wins: number; losses: number; be: number; open: number;
  /** W / (W + L), break-even excluded. */
  winrate: number | null;
  avgR: number | null; expectancy: number | null;
  /** ΣR⁺ / |ΣR⁻|; null when there is no losing R (never ∞). */
  profitFactor: number | null;
  /** Peak-to-trough on cumulative NET $. */
  maxDrawdown: number | null;
  sharpe: number | null;
  /** Σ net P&L (gross − |fees|). */
  totalPnl: number | null;
  totalPnlGross: number | null;
  /** null when the server hid the $ (see EdgeResponse.redacted). */
  fees: number | null; pnlCount: number; rCount: number;
};

type EdgeResponse = {
  trader: string | null;
  /** $ fields (totalPnl / gross / fees / drawdown) are null: other traders' trades, viewer is not staff. */
  redacted?: boolean;
  overall: EdgeStats;
  byRegime: Record<string, EdgeStats>;
  bySession: Record<string, EdgeStats>;
  byVix: Record<string, EdgeStats>;
  byScore: Record<string, EdgeStats>;
  byHorizon: Record<string, EdgeStats>;
};

type LinkedTrade = {
  id: number; ticker: string; date: string; exitDate?: string | null; result: string;
  pnl: number | null; fees?: number | null; netPnl?: number | null;
  rMultiple: number | null; signedR?: number | null;
  entry?: number | null; exit?: number | null; stop?: number | null; side?: string | null; riskUsd?: number | null;
  trader?: string | null; createdAt?: string | null;
  /** $ facts hidden by the server (someone else's trade). */
  redacted?: boolean;
};

/** Sample size below which stats are treated as statistically unreliable. */
const MIN_SAMPLE = 20;



/** Server R first (computed before $ redaction), else the shared client math. */
const rOfTrade = (t: LinkedTrade): number | null => (t.signedR != null && Number.isFinite(t.signedR) ? t.signedR : signedR(t));

type Dim = "byRegime" | "bySession" | "byVix" | "byScore" | "byHorizon";
const DIM_KEYS: Dim[] = ["bySession", "byHorizon", "byRegime", "byVix", "byScore"];

/** Bucket label of a breakdown: server codes (session, horizon, market regime) are translated; ranges / "—" as is. */
function bucketLabel(dim: Dim, k: string): string {
  if (dim === "byHorizon") return HORIZON_LABEL[k] ?? k;
  if (dim === "byRegime") return playbookToolsI18n.tryT(`edge.regime.${k}`) ?? k;
  if (dim === "bySession") {
    if (k === "premarket") return commonI18n.t("trading.premarket");
    if (k === "regular") return commonI18n.t("trading.regularSession");
    if (k === "afterhours" || k === "postmarket") return commonI18n.t("trading.afterHours");
  }
  return k;
}

/** Mini equity sparkline (pure SVG). */
function Sparkline({ values, tone }: { values: number[]; tone: Tone }) {
  const w = 240, h = 48, pad = 3;
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;
  const x = (i: number) => pad + (i / Math.max(1, values.length - 1)) * (w - pad * 2);
  const y = (v: number) => pad + (1 - (v - min) / span) * (h - pad * 2);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${x(0)},${y(0)} ${pts} ${x(values.length - 1)},${y(0)}`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={cn("h-12 w-full", toneText(tone === "neutral" ? "accent" : tone))} aria-hidden="true">
      <line x1={pad} x2={w - pad} y1={y(0)} y2={y(0)} stroke="hsl(var(--border))" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      <polygon points={area} fill="currentColor" opacity={0.12} />
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Metric({ label, value, tone = "neutral", hint }: { label: string; value: string; tone?: Tone; hint?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg)] px-3 py-2" title={hint}>
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className={cn("truncate text-base font-semibold tabular-nums", value === "—" ? "text-muted-foreground" : toneText(tone))}>{value}</div>
    </div>
  );
}

function Breakdown({ data, dim }: { data: Record<string, EdgeStats>; dim: Dim }) {
  const { t } = playbookToolsI18n.useT();
  const rows = Object.entries(data ?? {}).filter(([, s]) => s && s.count >= 1).sort((a, b) => b[1].count - a[1].count);
  if (rows.length === 0) {
    return <p className="py-3 text-center text-xs text-muted-foreground">{t("edge.noData")}</p>;
  }
  const best = rows.filter(([, s]) => s.count >= 3 && s.expectancy != null).sort((a, b) => (b[1].expectancy ?? 0) - (a[1].expectancy ?? 0))[0]?.[0];
  return (
    <ul className="divide-y divide-[var(--glass-border)]">
      {rows.map(([k, s]) => {
        const wrTone = winrateTone(s.winrate ?? 0, s.wins + s.losses);
        return (
          <li key={k} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-2 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto_auto]">
            <span className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
              <span className="truncate" title={bucketLabel(dim, k)}>{bucketLabel(dim, k)}</span>
              {k === best && rows.length > 1 && <Pill tone="up">{t("edge.best")}</Pill>}
            </span>
            <span className="order-last col-span-2 flex items-center gap-2 sm:order-none sm:col-span-1">
              <Bar value={s.winrate ?? 0} tone={wrTone} />
              <span className={cn("w-9 shrink-0 text-right text-xs tabular-nums", toneText(wrTone))}>{fmtRate(s.winrate)}</span>
            </span>
            <span className={cn("text-right text-xs font-medium tabular-nums", toneText(toneOf(s.expectancy)))}>{fmtR(s.expectancy)}</span>
            <span className="hidden text-right text-xs tabular-nums text-muted-foreground sm:inline">n={s.count}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function PlaybookEdgeBlock({ playbookId, defaultExpanded }: { playbookId: number; defaultExpanded?: boolean }) {
  const { t } = playbookToolsI18n.useT();
  const { user } = useAuth();
  // The API scopes trades by the session (traders only ever see their own); the key separates caches per viewer.
  const userKey = user?.role === "trader" && user.traderName ? user.traderName : null;
  const [expanded, setExpanded] = useState<boolean>(() => defaultExpanded ?? lsGet("pb-edge-expanded", false));
  const [dim, setDim] = useState<Dim>(() => lsGet<Dim>("pb-edge-dim", "bySession"));

  const { data, isLoading, isError, refetch } = useQuery<EdgeResponse>({
    queryKey: ["playbook-edge", playbookId, userKey],
    queryFn: ({ signal }) => http.get<EdgeResponse>(`/api/playbook/${playbookId}/edge`, { signal }),
  });

  // Same key + endpoint as the linked-trades list on the playbook page → shared cache, no extra request.
  const { data: trades = [] } = useQuery<LinkedTrade[]>({
    queryKey: ["playbook-trades", playbookId],
    queryFn: ({ signal }) => http.get<LinkedTrade[]>(`/api/playbook/${playbookId}/trades`, { signal }),
    enabled: !!data?.overall?.count,
  });

  const derived = useMemo(() => {
    // Shared trade math: signed R and NET P&L, chronological by close date (exit date for multi-day holds).
    const mine = byCloseDate((Array.isArray(trades) ? trades : []).filter((t) => !userKey || !t.trader || t.trader === userKey))
      .filter((t) => !isOpen(t));
    const withR = mine.map(rOfTrade).filter((r): r is number => r != null);
    // A $ curve over only the visible (own) rows of a partly redacted sample would mislead — R or the W/L strip instead.
    const anyRedacted = mine.some((t) => t.redacted);
    const withPnl = anyRedacted ? [] : mine.map((t) => netPnl(t)).filter((p): p is number => p != null);
    let curve: number[] = [];
    let unit: "R" | "$" | null = null;
    if (withR.length >= 2) {
      unit = "R";
      let c = 0;
      curve = [0, ...withR.map((r) => (c += r))];
    } else if (withPnl.length >= 2) {
      unit = "$";
      let c = 0;
      curve = [0, ...withPnl.map((p) => (c += p))];
    }
    // Current streak (most recent first).
    let streak = 0;
    let streakKind: "win" | "loss" | null = null;
    for (let i = mine.length - 1; i >= 0; i--) {
      const r = resultOf(mine[i]);
      if (r !== "win" && r !== "loss") break;
      if (streakKind == null) streakKind = r;
      if (r !== streakKind) break;
      streak++;
    }
    return { mine, rCount: withR.length, pnlCount: withPnl.length, curve, unit, streak, streakKind, last: mine.slice(-20) };
  }, [trades, userKey]);

  if (isLoading) {
    return (
      <div className="rounded-xl border border-[var(--glass-border)] p-3">
        <div className="flex items-center gap-3">
          <Skeleton className="h-14 w-14 rounded-full" />
          <div className="grid flex-1 grid-cols-2 gap-2 sm:grid-cols-3">
            <Skeleton className="h-12 rounded-xl" />
            <Skeleton className="h-12 rounded-xl" />
            <Skeleton className="hidden h-12 rounded-xl sm:block" />
          </div>
        </div>
      </div>
    );
  }
  if (isError) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-down/30 bg-down/10 px-3 py-2 text-sm text-down" role="alert">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="flex-1">{t("edge.loadFailed")}</span>
        <button
          type="button"
          onClick={() => refetch()}
          className="inline-flex min-h-8 items-center gap-1 rounded-full px-3 text-xs font-medium hover:bg-down/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> {commonI18n.t("actions.retry")}
        </button>
      </div>
    );
  }
  if (!data?.overall || data.overall.count === 0) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-dashed border-[var(--field-border)] px-3 py-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[var(--glass-bg)] text-muted-foreground">
          <LineChart className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{t("edge.emptyTitle")}</p>
          <p className="text-xs text-muted-foreground">{t("edge.emptyDesc")}</p>
        </div>
      </div>
    );
  }

  const o = data.overall;
  const n = o.count;
  const lowSample = n < MIN_SAMPLE;
  const hasR = o.rCount > 0 || derived.rCount > 0;
  const moneyHidden = !!data.redacted;
  const hasPnl = !moneyHidden && (o.pnlCount > 0 || derived.pnlCount > 0);
  const decided = o.wins + o.losses;
  const wrTone = winrateTone(o.winrate ?? 0, decided);
  const be = o.be ?? Math.max(0, n - o.wins - o.losses - (o.open ?? 0));
  const curveLast = derived.curve.length ? derived.curve[derived.curve.length - 1] : 0;

  function toggleExpanded() {
    setExpanded((v) => { lsSet("pb-edge-expanded", !v); return !v; });
  }

  return (
    <section className="rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg)] p-3" aria-label={t("edge.aria")}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="micro-label">{t("edge.aria")}</span>
        <span className="text-xs tabular-nums text-muted-foreground">{commonI18n.t("units.trades", { count: n })}</span>
        {lowSample && (
          <Pill tone="warn" className="gap-1">
            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
            {t("edge.lowSample")}
          </Pill>
        )}
        {derived.streak >= 2 && derived.streakKind && (
          <Pill tone={derived.streakKind === "win" ? "up" : "down"}>
            {t("edge.streak", { count: derived.streak, kind: derived.streakKind === "win" ? "W" : "L" })}
          </Pill>
        )}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
        <div className="flex items-center gap-3">
          <Ring value={o.winrate ?? 0} size={64} stroke={6} tone={wrTone} label={t("edge.winrateRing", { wr: fmtRate(o.winrate) })}>
            <div className="text-center leading-none">
              <div className={cn("text-sm font-semibold tabular-nums", toneText(wrTone))}>{fmtRate(o.winrate)}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{t("edge.winrate")}</div>
            </div>
          </Ring>
          <div className="text-xs tabular-nums text-muted-foreground sm:hidden">
            <span className="text-up">{o.wins}W</span> · <span className="text-down">{o.losses}L</span>{be > 0 && <> · {be} BE</>}
          </div>
        </div>

        <div className="grid flex-1 grid-cols-2 gap-2 sm:grid-cols-3">
          <Metric label={t("edge.avgR")} value={hasR ? fmtR(o.avgR) : "—"} tone={toneOf(o.avgR)} hint={hasR ? t("edge.rOf", { count: o.rCount, total: n }) : t("edge.noR")} />
          <Metric label={t("edge.expectancy")} value={hasR ? fmtR(o.expectancy) : "—"} tone={toneOf(o.expectancy)} hint={t("edge.expectancyHint")} />
          <Metric label="Profit factor" value={fmtNum(o.profitFactor)} tone={o.profitFactor == null ? "neutral" : o.profitFactor >= 1.5 ? "up" : o.profitFactor >= 1 ? "warn" : "down"} hint={o.profitFactor == null ? t("edge.pfUndefined") : "ΣR⁺ / |ΣR⁻|"} />
        </div>
      </div>

      {/* Equity sparkline or W/L strip */}
      <div className="mt-3">
        {derived.curve.length >= 3 ? (
          <div>
            <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
              <span>{t(derived.unit === "R" ? "edge.curveR" : "edge.curvePnl", { trades: commonI18n.t("units.trades", { count: derived.curve.length - 1 }) })}</span>
              <span className={cn("font-medium tabular-nums", toneText(toneOf(curveLast)))}>
                {derived.unit === "R" ? fmtR(curveLast) : fmtUsd(curveLast, { signed: true, decimals: 0 })}
              </span>
            </div>
            <Sparkline values={derived.curve} tone={toneOf(curveLast)} />
          </div>
        ) : derived.last.length > 0 ? (
          <div>
            <div className="mb-1 text-xs text-muted-foreground">{t("edge.lastTrades", { trades: commonI18n.t("units.trades", { count: derived.last.length }) })}</div>
            <div className="flex flex-wrap gap-1" aria-label={t("edge.lastAria")}>
              {derived.last.map((tr) => (
                <span
                  key={tr.id}
                  title={`${tr.ticker} · ${tr.date} · ${resultOf(tr) === "win" ? commonI18n.t("trading.win") : resultOf(tr) === "loss" ? commonI18n.t("trading.loss") : commonI18n.t("trading.breakeven")}`}
                  className={cn(
                    "grid h-5 min-w-5 place-items-center rounded-md px-1 text-xs font-semibold",
                    resultOf(tr) === "win" ? "bg-up/15 text-up" : resultOf(tr) === "loss" ? "bg-down/15 text-down" : "bg-[var(--glass-hover-bg)] text-muted-foreground",
                  )}
                >
                  {resultOf(tr) === "win" ? "W" : resultOf(tr) === "loss" ? "L" : "·"}
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <button
        type="button"
        onClick={toggleExpanded}
        aria-expanded={expanded}
        className="mt-3 inline-flex min-h-8 items-center gap-1 rounded-full px-2 text-xs font-medium text-muted-foreground hover:bg-[var(--glass-hover-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDown className={cn("h-3.5 w-3.5 motion-safe:transition-transform", expanded && "rotate-180")} aria-hidden="true" />
        {expanded ? t("edge.hideDetails") : t("edge.showDetails")}
      </button>

      {expanded && (
        <div className="mt-2 space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric label={t("edge.winLoss")} value={`${o.wins} / ${o.losses}`} hint={be > 0 || o.open ? t("edge.beOpen", { be, open: o.open ?? 0 }) : undefined} />
            <Metric label={t("edge.netPnl")} value={hasPnl ? fmtUsd(o.totalPnl, { signed: true, decimals: 0 }) : "—"} tone={toneOf(o.totalPnl)} hint={moneyHidden ? redactedAggHint() : hasPnl ? t("edge.pnlHint", { gross: fmtUsd(o.totalPnlGross, { signed: true, decimals: 0 }), fees: fmtUsd(o.fees ?? 0, { decimals: 0 }), count: o.pnlCount, total: n }) : t("edge.noPnl")} />
            <Metric label={t("edge.maxDd")} value={o.maxDrawdown != null ? fmtUsd(-o.maxDrawdown, { signed: true, decimals: 0 }) : "—"} tone={(o.maxDrawdown ?? 0) > 0 ? "down" : "neutral"} />
            <Metric label="Sharpe (R)" value={fmtNum(o.sharpe)} tone={toneOf(o.sharpe)} />
          </div>
          <div>
            <Segmented
              ariaLabel={t("edge.breakdownAria")}
              size="sm"
              options={DIM_KEYS.map((value) => ({ value, label: t(`edge.dim.${value}`) }))}
              value={dim}
              onChange={(v) => { setDim(v); lsSet("pb-edge-dim", v); }}
            />
            <div className="mt-1">
              <Breakdown data={data[dim] ?? {}} dim={dim} />
            </div>
          </div>
          {lowSample && (
            <p className="text-xs text-muted-foreground">
              {t("edge.lowSampleNote", { min: MIN_SAMPLE, count: n })}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
