import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { StatCard, StatGrid, toneOf, type Tone } from "@/components/ds";
import { fmtValue, type Kpis, type Metric } from "./metrics";
import { fmtCount, fmtNum, fmtRate, fmtRatio } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { statsI18n } from "@/i18n/ns/stats";

type DeltaKind = "value" | "pct" | "count" | "ratio";

function Delta({ cur, prev, kind, metric }: {
  cur: number | null; prev: number | null; kind: DeltaKind; metric: Metric;
}) {
  const { t } = statsI18n.useT();
  if (cur == null || prev == null || !Number.isFinite(cur) || !Number.isFinite(prev)) return null;
  const d = cur - prev;
  const text =
    kind === "pct" ? commonI18n.t("units.percentPoints", { value: `${d > 0 ? "+" : d < 0 ? "−" : ""}${Math.abs(Math.round(d * 100))}` })
    : kind === "count" ? `${d > 0 ? "+" : d < 0 ? "−" : ""}${Math.abs(Math.round(d))}`
    : kind === "ratio" ? fmtNum(d, { signed: true })
    : d === 0 ? fmtValue(0, metric, { sign: false }) : fmtValue(d, metric);
  const Icon = d > 0 ? ArrowUpRight : d < 0 ? ArrowDownRight : null;
  return (
    <span className="inline-flex items-center gap-0.5" title={t("kpi.vsPrev")}>
      {Icon && <Icon className="h-3 w-3" aria-hidden="true" />}
      {text}
      <span className="sr-only">{t("kpi.vsPrevSr")}</span>
    </span>
  );
}

function deltaTone(cur: number | null, prev: number | null, higherBetter = true, neutral = false): Tone {
  if (neutral || cur == null || prev == null || !Number.isFinite(cur) || !Number.isFinite(prev) || cur === prev) return "neutral";
  return (cur > prev) === higherBetter ? "up" : "down";
}

const finite = (v: number | null) => (v != null && Number.isFinite(v) ? v : null);

export function KpiGrid({ k, prev, metric }: { k: Kpis; prev: Kpis | null; metric: Metric }) {
  const { t } = statsI18n.useT();
  const p = prev && prev.total > 0 ? prev : null;
  const unit = metric === "r" ? "R" : "$";

  const cards: {
    key: string;
    label: string;
    title: string;
    value: string;
    tone: Tone;
    hint?: string;
    cur: number | null;
    prev: number | null;
    kind: DeltaKind;
    higherBetter?: boolean;
    neutralDelta?: boolean;
  }[] = [
    {
      key: "net", label: metric === "net" ? t("kpi.netNet") : metric === "usd" ? t("kpi.netGross") : t("kpi.netR"), title: t("kpi.netTitle"),
      value: fmtValue(k.net, metric), tone: toneOf(k.net),
      hint: k.missing > 0 ? t("kpi.missing", { count: k.missing, unit }) : undefined,
      cur: k.net, prev: p?.net ?? null, kind: "value",
    },
    {
      key: "wr", label: "Win rate", title: t("kpi.wrTitle"),
      value: fmtRate(k.winRate), tone: k.winRate == null ? "neutral" : k.winRate >= 0.5 ? "up" : "down",
      hint: `${k.wins}W · ${k.losses}L${k.breakeven ? ` · ${k.breakeven}BE` : ""}`,
      cur: k.winRate, prev: p?.winRate ?? null, kind: "pct",
    },
    {
      key: "trades", label: t("kpi.trades"), title: t("kpi.tradesTitle"),
      value: fmtCount(k.total), tone: "neutral",
      hint: k.open ? t("kpi.openDays", { open: k.open, days: commonI18n.t("units.days", { count: k.tradingDays }) }) : t("kpi.tradingDays", { count: k.tradingDays }),
      cur: k.total, prev: p?.total ?? null, kind: "count", neutralDelta: true,
    },
    {
      key: "exp", label: metric === "r" ? t("kpi.expR") : t("kpi.exp"), title: t("kpi.expTitle"),
      value: fmtValue(k.expectancy, metric), tone: toneOf(k.expectancy),
      hint: t("kpi.perTrade"),
      cur: k.expectancy, prev: p?.expectancy ?? null, kind: "value",
    },
    {
      key: "pf", label: "Profit factor", title: t("kpi.pfTitle"),
      value: fmtRatio(k.profitFactor),
      tone: k.profitFactor == null ? "neutral" : k.profitFactor >= 1 ? "up" : "down",
      hint: k.payoff != null ? `payoff ${fmtNum(k.payoff)}` : undefined,
      cur: finite(k.profitFactor), prev: finite(p?.profitFactor ?? null), kind: "ratio",
    },
    {
      key: "avgwin", label: t("kpi.avgWin"), title: t("kpi.avgWinTitle"),
      value: fmtValue(k.avgWin, metric), tone: k.avgWin == null ? "neutral" : "up",
      hint: k.bestTrade != null && k.bestTrade > 0 ? t("kpi.max", { value: fmtValue(k.bestTrade, metric) }) : undefined,
      cur: k.avgWin, prev: p?.avgWin ?? null, kind: "value",
    },
    {
      key: "avgloss", label: t("kpi.avgLoss"), title: t("kpi.avgLossTitle"),
      value: fmtValue(k.avgLoss, metric), tone: k.avgLoss == null ? "neutral" : "down",
      hint: k.worstTrade != null && k.worstTrade < 0 ? t("kpi.min", { value: fmtValue(k.worstTrade, metric) }) : undefined,
      cur: k.avgLoss, prev: p?.avgLoss ?? null, kind: "value",
    },
    {
      key: "dd", label: t("kpi.dd"), title: t("kpi.ddTitle"),
      value: k.maxDrawdown == null ? "—" : k.maxDrawdown === 0 ? fmtValue(0, metric, { sign: false }) : fmtValue(k.maxDrawdown, metric),
      tone: k.maxDrawdown != null && k.maxDrawdown < 0 ? "down" : "neutral",
      hint: k.tradingDays ? t("kpi.greenRed", { green: k.greenDays, red: k.redDays }) : undefined,
      cur: k.maxDrawdown, prev: p?.maxDrawdown ?? null, kind: "value",
    },
    {
      key: "wstreak", label: t("kpi.bestStreak"), title: t("kpi.bestStreakTitle"),
      value: commonI18n.t("units.wins", { count: k.longestWin }), tone: k.longestWin ? "up" : "neutral",
      hint: k.current.kind === "win" && k.current.len > 0 ? t("kpi.nowInRow", { count: k.current.len }) : undefined,
      cur: k.longestWin, prev: p?.longestWin ?? null, kind: "count",
    },
    {
      key: "lstreak", label: t("kpi.worstStreak"), title: t("kpi.worstStreakTitle"),
      value: commonI18n.t("units.losses", { count: k.longestLoss }), tone: k.longestLoss ? "down" : "neutral",
      hint: k.current.kind === "loss" && k.current.len > 0 ? t("kpi.nowInRow", { count: k.current.len }) : undefined,

      cur: k.longestLoss, prev: p?.longestLoss ?? null, kind: "count", higherBetter: false,
    },
  ];

  return (
    <StatGrid className="md:grid-cols-3 lg:grid-cols-5 xl:grid-cols-5">
      {cards.map((c) => {
        const delta = p ? <Delta cur={c.cur} prev={c.prev} kind={c.kind} metric={metric} /> : null;
        const hasDelta = p && c.cur != null && c.prev != null;
        return (
          <StatCard
            key={c.key}
            label={<span title={c.title}>{c.label}</span>}
            value={c.value}
            tone={c.tone}
            hint={c.hint}
            delta={hasDelta ? delta : undefined}
            deltaTone={deltaTone(c.cur, c.prev, c.higherBetter ?? true, c.neutralDelta)}
          />
        );
      })}
    </StatGrid>
  );
}

export function KpiGridSkeleton() {
  return (
    <StatGrid className="md:grid-cols-3 lg:grid-cols-5 xl:grid-cols-5">
      {Array.from({ length: 10 }).map((_, i) => (
        <div key={i} className="glass-panel flex h-[104px] flex-col gap-2 rounded-2xl p-4">
          <div className="h-3 w-20 animate-pulse rounded-full bg-[var(--glass-hover-bg)]" />
          <div className="h-7 w-24 animate-pulse rounded-lg bg-[var(--glass-hover-bg)]" />
          <div className="h-4 w-16 animate-pulse rounded-full bg-[var(--glass-hover-bg)]" />
        </div>
      ))}
    </StatGrid>
  );
}
