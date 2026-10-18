import { Link } from "wouter";
import { ChevronDown, Crown, Medal, ShieldAlert, Star } from "lucide-react";
import { Pill, ProgressRing, Sparkline, toneOf, toneText } from "@/components/ds";
import { KPI_FORMULAS } from "@/lib/trade-math";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import { TraderAvatar } from "./trader-avatar";
import { fmtCount, fmtNum, fmtR, fmtRate, fmtUsd } from "@/lib/format";
import { teamI18n } from "@/i18n/ns/team";
import { personName } from "@/i18n";
import { METRIC_LABEL, SCORE_PART_LABEL, metricValue, type Metric, type ScorePart, type TraderRow } from "./leaderboard";

/** Scaling tier keys from the API → the desk ladder names. */
const tierName = (t: string) => teamI18n.tryT(`tier.${t}`) ?? t;

export function fmtMetric(v: number | null | undefined, metric: Metric): string {
  if (v == null || !Number.isFinite(v)) return "—";
  switch (metric) {
    case "net": return fmtUsd(v, { signed: true });
    case "r":
    case "expectancy": return fmtR(v);
    case "pf": return fmtNum(v);
    case "consistency":
    case "winrate": return fmtRate(v);
    case "drawdown": return Number.isInteger(v) || Math.abs(v) >= 50 ? fmtUsd(v, { signed: true }) : fmtR(v);
    default: return fmtNum(v, 1);
  }
}

/** Drawdown is "less negative is better": tone by sign still works (0 = neutral, negative = down). */
function metricTone(v: number | null, metric: Metric) {
  if (v == null) return "neutral" as const;
  if (metric === "score") return v >= 70 ? ("up" as const) : v >= 45 ? ("warn" as const) : ("down" as const);
  if (metric === "pf") return v > 1 ? ("up" as const) : v < 1 ? ("down" as const) : ("neutral" as const);
  if (metric === "winrate" || metric === "consistency") return v >= 0.5 ? ("up" as const) : ("warn" as const);
  return toneOf(v);
}

export function ScoreRing({ score, size = 44 }: { score: number | null; size?: number }) {
  const tone = score == null ? "neutral" : score >= 70 ? "up" : score >= 45 ? "warn" : "down";
  return (
    <ProgressRing
      value={score ?? 0}
      max={100}
      size={size}
      stroke={4}
      tone={tone}
      label={score == null ? "—" : Math.round(score)}
      ariaLabel={score == null ? teamI18n.t("scoreNone") : teamI18n.t("scoreOf", { score: Math.round(score) })}
    />
  );
}

const PLACE_STYLE = [
  { ring: "ring-[hsl(var(--chart-3))]", badge: "bg-[hsl(var(--chart-3))] text-background", place: 1, height: "sm:pt-8" },
  { ring: "ring-[hsl(var(--muted-foreground)/0.6)]", badge: "bg-muted-foreground text-background", place: 2, height: "sm:pt-4" },
  { ring: "ring-[hsl(var(--chart-5))]", badge: "bg-[hsl(var(--chart-5))] text-background", place: 3, height: "sm:pt-2" },
];

/** Top-3 podium (qualified rows only). Desktop order 2-1-3 with 1st raised. */
export function Podium({ rows, metric, onSelect }: { rows: TraderRow[]; metric: Metric; onSelect: (trader: string) => void }) {
  const { t } = teamI18n.useT();
  const top = rows.filter((r) => r.qualified).slice(0, 3);
  const order = ["sm:order-2", "sm:order-1", "sm:order-3"];
  if (!top.length) return null;
  return (
    <ol className="grid grid-cols-1 items-end gap-3 sm:grid-cols-3" aria-label={t("podiumAria")}>
      {top.map((r, i) => {
        const st = PLACE_STYLE[i];
        const v = metricValue(r, metric);
        return (
          <li key={r.trader} className={cn("min-w-0", order[i], st.height)}>
            <div className={cn("glass-panel relative flex flex-col items-center gap-2 rounded-2xl px-4 pb-4 pt-5 text-center", i === 0 && "ring-1 ring-[hsl(var(--chart-3)/0.5)]")}>
              <span className={cn("absolute left-3 top-3 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold", st.badge)}>
                {i === 0 ? <Crown className="h-3 w-3" aria-hidden="true" /> : <Medal className="h-3 w-3" aria-hidden="true" />}
                {i + 1}
                <span className="sr-only"> {t("place", { n: st.place })}</span>
              </span>
              {r.deltaScore != null && r.deltaScore !== 0 && (
                <span className="absolute right-3 top-3">
                  <RankDelta delta={r.deltaScore} suffix={t("pointsDelta")} />
                </span>
              )}
              <button
                type="button"
                onClick={() => onSelect(r.trader)}
                className="flex flex-col items-center gap-2 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={t("showDetails", { name: personName(r.trader) })}
              >
                <TraderAvatar name={r.trader} size="lg" className={cn("ring-2 ring-offset-2 ring-offset-background", st.ring)} />
                <span className="max-w-full truncate text-base font-semibold" title={personName(r.trader)}>{personName(r.trader)}</span>
              </button>
              <div className="flex items-center gap-3">
                <ScoreRing score={r.score} size={48} />
                <div className="flex flex-col items-start">
                  <span className={cn("text-xl font-semibold tabular-nums tracking-tight", toneText(metricTone(v, metric)))}>{fmtMetric(v, metric)}</span>
                  <span className="text-2xs text-muted-foreground">{METRIC_LABEL[metric]}</span>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground tabular-nums">
                <span>{r.net != null ? t("netSuffix", { value: fmtUsd(r.net, { signed: true }) }) : fmtR(r.totalR)}</span>
                <span aria-hidden="true">·</span>
                <span>{t("closedShort", { count: r.closed })}</span>
                <span aria-hidden="true">·</span>
                <span title={KPI_FORMULAS.winRate}>WR {fmtRate(r.winRate)}</span>
                {r.tier && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{tierName(r.tier)}</span>
                  </>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const PART_ORDER: ScorePart[] = ["expectancy", "profitFactor", "net", "consistency", "drawdown", "discipline"];

function ScoreParts({ r, weights }: { r: TraderRow; weights: Record<ScorePart, number> }) {
  const { t } = teamI18n.useT();
  return (
    <ul className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3" aria-label={t("partsAria")}>
      {PART_ORDER.map((k) => {
        const v = r.scoreParts[k];
        return (
          <li key={k} className="flex min-w-0 flex-col gap-0.5">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="truncate text-muted-foreground" title={SCORE_PART_LABEL[k]}>
                {SCORE_PART_LABEL[k]} <span className="tabular-nums">· {fmtRate(weights[k])}</span>
              </span>
              <span className="tabular-nums font-medium">{v == null ? "—" : Math.round(v * 100)}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-[var(--glass-bg)]" aria-hidden="true">
              <div className={cn("h-full rounded-full", v == null ? "" : v >= 0.7 ? "bg-up/70" : v >= 0.4 ? "bg-[hsl(var(--chart-3)/0.7)]" : "bg-down/70")} style={{ width: `${Math.round((v ?? 0) * 100)}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Cell({ label, value, tone, title }: { label: string; value: string; tone?: "up" | "down" | "accent" | "warn" | "purple" | "neutral"; title?: string }) {
  return (
    <div className="flex min-w-0 flex-col" title={title}>
      <span className="truncate text-2xs text-muted-foreground">{label}</span>
      <span className={cn("truncate text-sm font-medium tabular-nums", tone ? toneText(tone) : "")}>{value}</span>
    </div>
  );
}

/** Ranked list; rows expand into the score breakdown, KPIs and cross-links. */
export function LeaderboardList({
  rows,
  metric,
  weights,
  expanded,
  onToggle,
  from,
  to,
}: {
  rows: TraderRow[];
  metric: Metric;
  weights: Record<ScorePart, number>;
  expanded: Set<string>;
  onToggle: (trader: string) => void;
  from: string;
  to: string;
}) {
  const { t } = teamI18n.useT();
  const values = rows.map((r) => metricValue(r, metric) ?? 0);
  const maxAbs = Math.max(1e-9, ...values.map((v) => Math.abs(v)));
  return (
    <ul className="flex flex-col divide-y divide-border" aria-label={t("listAria")}>
      {rows.map((r) => {
        const open = expanded.has(r.trader);
        const v = metricValue(r, metric);
        const pct = Math.min(100, (Math.abs(v ?? 0) / maxAbs) * 100);
        const pos = (v ?? 0) >= 0;
        const dd = r.maxDrawdownNet ?? r.maxDrawdownR;
        return (
          <li key={r.trader} id={`lb-${encodeURIComponent(r.trader)}`} className="scroll-mt-24">
            <button
              type="button"
              aria-expanded={open}
              onClick={() => onToggle(r.trader)}
              className="grid w-full grid-cols-[1.75rem_auto_minmax(0,1fr)_auto_auto] items-center gap-3 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-[var(--glass-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-[1.75rem_auto_minmax(0,11rem)_minmax(0,1fr)_auto_auto_1rem]"
            >
              <span className="text-center text-sm tabular-nums text-muted-foreground">{r.rank ?? "—"}</span>
              <TraderAvatar name={r.trader} size="sm" />
              <span className="min-w-0">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-sm font-medium" title={personName(r.trader)}>{personName(r.trader)}</span>
                  {!r.qualified && (
                    <span title={t("unqualifiedTitle", { count: r.minTrades })}>
                      <Pill tone="neutral" className="px-1.5 text-2xs">{t("unqualified")}</Pill>
                    </span>
                  )}
                  {r.violations > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-2xs text-down" title={t("violationsTitle", { count: r.violations })}>
                      <ShieldAlert className="h-3 w-3" aria-hidden="true" />
                      {r.violations}
                    </span>
                  )}
                  <RankDelta delta={r.deltaScore} suffix="" />
                </span>
                {(() => {
                  // Same line as text and as the tooltip: it truncates on narrow rows (UZ / EN labels are longer).
                  const meta = `${t("closedShort", { count: r.closed })} · WR ${fmtRate(r.winRate)} · ${r.net != null ? t("netSuffix", { value: fmtUsd(r.net, { signed: true }) }) : fmtR(r.totalR)}${r.tier ? ` · ${tierName(r.tier)}` : ""}`;
                  return <span className="block truncate text-xs text-muted-foreground tabular-nums" title={meta}>{meta}</span>;
                })()}
              </span>
              <span className="relative hidden h-2 sm:block" aria-hidden="true">
                <span className="absolute inset-y-0 left-1/2 w-px bg-border" />
                <span className={cn("absolute inset-y-0 rounded-full", pos ? "left-1/2 bg-up/70" : "right-1/2 bg-down/70")} style={{ width: `${pct / 2}%` }} />
              </span>
              <ScoreRing score={r.score} size={36} />
              <span className={cn("min-w-[4.5rem] text-right text-sm font-semibold tabular-nums", toneText(metricTone(v, metric)))}>{fmtMetric(v, metric)}</span>
              <ChevronDown className={cn("hidden h-4 w-4 text-muted-foreground transition-transform sm:block", open && "rotate-180")} aria-hidden="true" />
            </button>
            {open && (
              <div className="mx-2 mb-3 flex flex-col gap-3 rounded-xl border border-border p-3">
                <div className="grid grid-cols-3 gap-x-4 gap-y-2 md:grid-cols-6">
                  <Cell label={t("cell.net")} value={fmtUsd(r.net, { signed: true })} tone={toneOf(r.net)} title={r.gross != null ? t("cell.netTitle", { formula: KPI_FORMULAS.netPnl, gross: fmtUsd(r.gross, { signed: true }), fees: fmtUsd(-Math.abs(r.fees ?? 0), { signed: true }) }) : KPI_FORMULAS.netPnl} />
                  <Cell label={t("cell.totalR")} value={fmtR(r.totalR)} tone={toneOf(r.totalR)} />
                  <Cell label={t("cell.expectancy")} value={fmtR(r.expectancyR)} tone={toneOf(r.expectancyR)} title={KPI_FORMULAS.expectancyR} />
                  <Cell label="Profit factor" value={r.profitFactorR != null ? fmtNum(r.profitFactorR) : r.losses === 0 && r.wins > 0 ? t("cell.noLosses") : "—"} title={KPI_FORMULAS.profitFactorR} />
                  <Cell label="Win rate" value={`${fmtRate(r.winRate)} · ${r.wins}W/${r.losses}L`} title={KPI_FORMULAS.winRate} />
                  <Cell label={t("cell.greenDays")} value={t("cell.greenDaysValue", { green: fmtCount(r.greenDays), total: fmtCount(r.tradingDays) })} />
                  <Cell label={r.maxDrawdownNet != null ? t("cell.maxDdNet") : t("cell.maxDdR")} value={r.maxDrawdownNet != null ? fmtUsd(r.maxDrawdownNet, { signed: true }) : fmtR(r.maxDrawdownR)} tone={toneOf(dd)} title={KPI_FORMULAS.maxDrawdown} />
                  <Cell label={t("cell.bestWorstR")} value={`${fmtR(r.bestR)} / ${fmtR(r.worstR)}`} />
                  <Cell label={t("cell.streaks")} value={`+${r.bestStreak} / ${r.worstStreak}`} title={t("cell.streaksTitle")} />
                  <Cell label={t("cell.violationsPerWeek")} value={fmtNum(r.violationsPerWeek, 1)} tone={r.violations > 0 ? "down" : "neutral"} />
                  <Cell label={t("cell.mentorRating")} value={r.rating ? `${fmtNum(r.rating.avg, 1)} · ${r.rating.n}` : "—"} tone={r.rating ? "purple" : "neutral"} />
                  <Cell label={t("cell.limits")} value={r.dailyLossLimit != null ? t("cell.dayLimit", { amount: fmtUsd(-r.dailyLossLimit, { signed: true }) }) : t("cell.limitsNotSet")} />
                </div>
                {r.sparkR.length > 1 && (
                  <div className="flex items-center gap-3">
                    <Sparkline data={r.sparkR} tone="auto" width={240} height={28} ariaLabel={t("sparkAria")} />
                    <span className="text-2xs text-muted-foreground">{t("sparkCaption")}</span>
                  </div>
                )}
                <ScoreParts r={r} weights={weights} />
                <nav className="flex flex-wrap gap-1.5" aria-label={t("linksAria", { name: personName(r.trader) })}>
                  <Link href={`${links.trades({ from, to })}&trader=${encodeURIComponent(r.trader)}`} className="chip inline-flex min-h-7 items-center px-2.5 text-xs">
                    {t("link.trades")}
                  </Link>
                  {r.lastTradeDate && (
                    <Link href={links.journalDay(r.lastTradeDate, r.trader)} className="chip inline-flex min-h-7 items-center px-2.5 text-xs">
                      {t("link.journal", { date: r.lastTradeDate })}
                    </Link>
                  )}
                  <Link href={links.risk(r.trader)} className="chip inline-flex min-h-7 items-center px-2.5 text-xs">
                    {t("link.risk")}
                  </Link>
                  <Link href={links.weeklyReview({ trader: r.trader })} className="chip inline-flex min-h-7 items-center px-2.5 text-xs">
                    {t("link.weekly")}
                  </Link>
                  <Link href={`/ratings?trader=${encodeURIComponent(r.trader)}`} className="chip inline-flex min-h-7 items-center gap-1 px-2.5 text-xs">
                    <Star className="h-3 w-3" aria-hidden="true" />
                    {t("link.ratings")}
                  </Link>
                  <Link href={links.scaling(r.trader)} className="chip inline-flex min-h-7 items-center px-2.5 text-xs">
                    {t("link.scaling")}
                  </Link>
                </nav>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function RankDelta({ delta, suffix = "" }: { delta: number | null; suffix?: string }) {
  if (delta == null || delta === 0) return null;
  const abs = Math.abs(delta);
  const txt = Number.isInteger(abs) ? String(abs) : abs.toFixed(1);
  return (
    <Pill tone={delta > 0 ? "up" : "down"} className="px-1.5 text-2xs">
      <span aria-hidden="true">{delta > 0 ? `▲${txt}${suffix}` : `▼${txt}${suffix}`}</span>
      <span className="sr-only">{delta > 0 ? teamI18n.t("deltaUp", { value: txt }) : teamI18n.t("deltaDown", { value: txt })}</span>
    </Pill>
  );
}
