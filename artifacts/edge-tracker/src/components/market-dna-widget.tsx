import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dna, RefreshCw, Target, Info } from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { http } from "@/lib/api/http";
import { humanizeApiError } from "@/lib/api/errors";
import { STALE } from "@/lib/api/keys";
import { Skeleton } from "@/components/ui/skeleton";
import { Segmented, Pill, TermTooltip, type Tone } from "@/components/ds";
import { cn } from "@/lib/utils";
import { WidgetShell, IconAction, WidgetError, num, useStoredState } from "@/components/widgets/widget-kit";
import { fmtPct, fmtR } from "@/lib/format";
import { marketWidgetsI18n } from "@/i18n/ns/marketWidgets";
import { commonI18n } from "@/i18n/ns/common";

const mt = marketWidgetsI18n.t;

type Bucket = {
  regime?: string;
  bucket?: string;
  trend_day?: string;
  sample: number;
  winRate: number | null;
  avgRMultiple: number | null;
  /** Net P&L; null when no trade in the bucket has a P&L (server: lib/tradeMath). */
  totalPnl?: number | null;
};

// winRate = W/(W+L) (null when nothing decided), avgRMultiple = signed R (null without stops), totalPnl = net or null
type SetupRegime = { scope: string; sample: number; value: { winRate: number | null; avgRMultiple: number | null; totalPnl: number | null } };

type Ctx = {
  spy?: { changePct: number | null; trend5d: number | null } | null;
  qqq?: { changePct: number | null; trend5d: number | null } | null;
  vix?: { value: number | null; changePct: number | null; bucket: string | null } | null;
  trendDay?: { spy: boolean | null; qqq: boolean | null } | null;
  events?: Array<{ date: string; type: string; name: string; importance: string }>;
  isFomcWeek?: boolean;
  isEarningsSeason?: boolean;
  marketRegime?: string | null;
} | null;

type Dna = {
  currentContext: Ctx;
  byRegime: Bucket[];
  byVixBucket: Bucket[];
  byTrendDay: Bucket[];
  bestSetupRegime: SetupRegime[];
  worstSetupRegime: SetupRegime[];
  sample?: number;
};

/** Regime code → label in the UI language (unknown codes stay as delivered). */
const regimeLabel = (k: string): string => (k === "risk_off" ? "Risk-off" : k === "unknown" ? "—" : marketWidgetsI18n.tryT(`dna.regime.${k}`) ?? k);
const REGIME_TONE: Record<string, Tone> = {
  trend_up: "up",
  trend_down: "down",
  high_vol: "warn",
  risk_off: "down",
  low_vol_chop: "neutral",
  neutral: "neutral",
};
const VIX_LABEL: Record<string, string> = {
  very_low: "VIX < 13",
  low: "VIX 13–17",
  normal: "VIX 17–22",
  elevated: "VIX 22–28",
  high: "VIX ≥ 28",
};
const trendLabel = (k: string): string => marketWidgetsI18n.tryT(`dna.trend.${k}`) ?? k;

type Dim = "regime" | "vix" | "trend";
const DIMS = ["regime", "vix", "trend"] as const;

const bucketKey = (b: Bucket, dim: Dim) => (dim === "regime" ? b.regime : dim === "vix" ? b.bucket : b.trend_day) ?? "";
const bucketLabel = (k: string, dim: Dim) => (dim === "regime" ? regimeLabel(k) : dim === "vix" ? VIX_LABEL[k] ?? k : trendLabel(k));

// API scope is "<setup> · <regime_key>"
function splitScope(scope: string): { setup: string; regime: string } {
  const idx = scope.lastIndexOf(" · ");
  if (idx < 0) return { setup: scope, regime: "" };
  return { setup: scope.slice(0, idx), regime: scope.slice(idx + 3) };
}

const wrPct = (wr: number | null) => (wr == null ? "—" : `${Math.round(wr * 100)}%`);

function EdgeRow({ label, b, overall }: { label: string; b: Bucket | undefined; overall: number | null }) {
  const diff = b?.winRate != null && overall != null ? Math.round((b.winRate - overall) * 100) : null;
  return (
    <li className="flex items-center gap-2 py-1.5 text-sm">
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{label}</span>
      {b && b.sample > 0 ? (
        <>
          <span className="font-semibold tabular-nums">{wrPct(b.winRate)}</span>
          <span className="w-14 text-right text-xs tabular-nums text-muted-foreground">{fmtR(b.avgRMultiple)}</span>
          <span className="w-10 text-right text-2xs tabular-nums text-muted-foreground">n={b.sample}</span>
          {diff != null && Math.abs(diff) >= 3 ? (
            <Pill tone={diff > 0 ? "up" : "down"} className="w-16 justify-center">
              {mt("dna.pp", { value: `${diff > 0 ? "+" : "−"}${Math.abs(diff)}` })}
            </Pill>
          ) : (
            <span className="w-16" />
          )}
        </>
      ) : (
        <span className="text-xs text-muted-foreground">{mt("dna.noTrades")}</span>
      )}
    </li>
  );
}

export function MarketDnaWidget() {
  const { t } = marketWidgetsI18n.useT();
  const { user } = useAuth();
  const userKey = user?.role === "trader" ? user.traderName ?? "" : "";
  const [dim, setDim] = useStoredState<Dim>("market_dna_dim", "regime", DIMS);

  const q = useQuery<Dna>({
    queryKey: ["market-dna", userKey],
    queryFn: ({ signal }) => http.get<Dna>("/api/market-conditions/dna", { query: { userKey }, signal }),
    staleTime: STALE.long,
    retry: 1,
  });

  const dna = q.data;
  const ctx = dna?.currentContext ?? null;
  const regime = ctx?.marketRegime ?? null;
  const vixBucket = ctx?.vix?.bucket ?? null;
  const trendKey = ctx?.trendDay?.spy === true ? "trend" : ctx?.trendDay?.spy === false ? "chop" : null;

  const overall = useMemo(() => {
    const rows = dna?.byRegime ?? [];
    let n = 0;
    let w = 0;
    for (const b of rows) {
      if (b.winRate == null) continue;
      n += b.sample;
      w += b.winRate * b.sample;
    }
    return { n, wr: n > 0 ? w / n : null };
  }, [dna]);

  const buckets = useMemo(() => {
    const src = dim === "regime" ? dna?.byRegime : dim === "vix" ? dna?.byVixBucket : dna?.byTrendDay;
    return [...(src ?? [])].sort((a, b) => b.sample - a.sample).slice(0, 7);
  }, [dna, dim]);
  const currentKey = dim === "regime" ? regime : dim === "vix" ? vixBucket : trendKey;

  const hasData = !!dna && (dna.byRegime.length > 0 || dna.bestSetupRegime.length > 0);
  const regimeTone = regime ? REGIME_TONE[regime] ?? "neutral" : "neutral";

  return (
    <WidgetShell
      icon={Dna}
      title={t("dna.title")}
      meta={overall.n > 0 ? t("dna.trades", { count: overall.n }) : undefined}
      actions={<IconAction icon={RefreshCw} label={t("dna.refresh")} spinning={q.isFetching} disabled={q.isFetching} onClick={() => q.refetch()} />}
      data-testid="market-dna-widget"
    >
      {q.isLoading ? (
        <div className="space-y-3" data-testid="market-dna-skeleton" aria-busy="true" aria-label={t("dna.loading")}>
          <Skeleton className="h-6 w-32 rounded-full" />
          <div className="grid grid-cols-3 gap-2">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 rounded-xl" />)}
          </div>
          <Skeleton className="h-20 w-full rounded-xl" />
        </div>
      ) : q.isError && !dna ? (
        <WidgetError message={humanizeApiError(q.error, commonI18n.t("states.loadFailed"))} onRetry={() => q.refetch()} />
      ) : (
        <div className="space-y-3">
          {/* Today's context */}
          {ctx && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted-foreground">{t("dna.regimeToday")}</span>
                <Pill tone={regimeTone} dot>{regime ? regimeLabel(regime) : t("dna.undetermined")}</Pill>
                {ctx.isFomcWeek && <Pill tone="warn">{t("dna.fomcWeek")}</Pill>}
                {ctx.isEarningsSeason && <Pill tone="purple">{t("dna.earningsSeason")}</Pill>}
                {(ctx.events ?? []).slice(0, 2).map((e) => (
                  <Pill key={`${e.type}-${e.date}`} tone={e.importance === "high" ? "down" : "neutral"}>{e.name}</Pill>
                ))}
              </div>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { k: "SPY", v: fmtPct(ctx.spy?.changePct), c: num(ctx.spy?.changePct) },
                  { k: "QQQ", v: fmtPct(ctx.qqq?.changePct), c: num(ctx.qqq?.changePct) },
                  { k: "VIX", v: num(ctx.vix?.value)?.toFixed(2) ?? "—", c: null, sub: ctx.vix?.changePct != null ? fmtPct(ctx.vix.changePct, 1) : undefined },
                ].map((t) => (
                  <div key={t.k} className="min-w-0 rounded-xl bg-foreground/[0.04] px-2.5 py-1.5">
                    <div className="text-2xs text-muted-foreground">{t.k === "VIX" ? <TermTooltip term="vix" /> : t.k}</div>
                    <div className={cn("text-sm font-semibold tabular-nums", t.c == null ? "text-foreground" : t.c >= 0 ? "text-up" : "text-down")}>{t.v}</div>
                    {"sub" in t && t.sub && <div className="text-2xs tabular-nums text-muted-foreground">{t.sub}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {!hasData ? (
            <div className="flex items-start gap-2 rounded-xl bg-foreground/[0.04] px-3 py-2.5 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{t("dna.emptyHint")}</span>
            </div>
          ) : (
            <>
              {/* Your edge in today's conditions */}
              <div>
                <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-foreground">
                  <Target className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                  {t("dna.yourResult")}
                  {overall.wr != null && <span className="font-normal text-muted-foreground">{t("dna.avg", { value: wrPct(overall.wr) })}</span>}
                </div>
                <ul className="divide-y divide-border/40">
                  <EdgeRow label={regime ? regimeLabel(regime) : t("dna.regimeLabel")} b={dna!.byRegime.find((b) => b.regime === regime)} overall={overall.wr} />
                  {vixBucket && <EdgeRow label={VIX_LABEL[vixBucket] ?? vixBucket} b={dna!.byVixBucket.find((b) => b.bucket === vixBucket)} overall={overall.wr} />}
                  {trendKey && <EdgeRow label={trendLabel(trendKey)} b={dna!.byTrendDay.find((b) => b.trend_day === trendKey)} overall={overall.wr} />}
                </ul>
              </div>

              {/* Breakdown by dimension */}
              <div className="space-y-2">
                <Segmented<Dim>
                  ariaLabel={t("dna.sliceAria")}
                  size="sm"
                  value={dim}
                  onChange={setDim}
                  options={[
                    { value: "regime", label: t("dna.sliceRegime") },
                    { value: "vix", label: "VIX" },
                    { value: "trend", label: t("dna.sliceTrend") },
                  ]}
                />
                {buckets.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t("dna.noSlice")}</p>
                ) : (
                  <ul className="space-y-1">
                    {buckets.map((b) => {
                      const k = bucketKey(b, dim);
                      const isNow = !!currentKey && k === currentKey;
                      const wr = b.winRate; // null ⇒ no decided trades: empty bar, «—»
                      return (
                        <li
                          key={k}
                          className={cn(
                            "grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)_2.75rem_3.25rem] items-center gap-2 rounded-lg px-1.5 py-1 text-xs",
                            isNow && "bg-primary/10",
                          )}
                        >
                          <span className={cn("truncate", isNow ? "font-semibold text-primary" : "text-foreground/90")}>
                            {bucketLabel(k, dim)}
                          </span>
                          <span className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.07]" aria-hidden="true">
                            {wr != null && (
                              <span
                                className={cn("block h-full rounded-full", wr >= 0.55 ? "bg-up" : wr >= 0.45 ? "bg-[hsl(var(--chart-3))]" : "bg-down")}
                                style={{ width: `${Math.round(wr * 100)}%` }}
                              />
                            )}
                          </span>
                          <span className="text-right font-medium tabular-nums">{wrPct(b.winRate)}</span>
                          <span className="text-right tabular-nums text-muted-foreground">{fmtR(b.avgRMultiple)}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              {/* Best / worst setup × regime */}
              {(dna!.bestSetupRegime.length > 0 || dna!.worstSetupRegime.length > 0) && (
                <div className="grid gap-3 sm:grid-cols-2">
                  {[
                    { title: t("dna.best"), rows: dna!.bestSetupRegime.slice(0, 3), tone: "up" as Tone },
                    { title: t("dna.worst"), rows: dna!.worstSetupRegime.slice(0, 3), tone: "down" as Tone },
                  ].map((g) => (
                    <div key={g.title} className="min-w-0">
                      <div className="micro-label mb-1">{g.title}</div>
                      <ul className="space-y-0.5">
                        {g.rows.map((s) => {
                          const { setup, regime: r } = splitScope(String(s.scope ?? ""));
                          const fits = !!regime && r === regime;
                          return (
                            <li key={s.scope} className="flex items-center justify-between gap-2 text-xs" title={s.scope}>
                              <span className="min-w-0 truncate">
                                <span className="font-medium">{setup}</span>
                                <span className="text-muted-foreground"> · {regimeLabel(r)}</span>
                                {fits && <span className="ml-1 text-primary">{t("dna.today")}</span>}
                              </span>
                              <span className={cn("shrink-0 tabular-nums", g.tone === "up" ? "text-up" : "text-down")}>
                                {wrPct(s.value?.winRate ?? null)} <span className="text-muted-foreground">n={s.sample}</span>
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </WidgetShell>
  );
}
