/**
 * Compact «Брокерская статистика» summary for a trader (latest PropReports Trade Performance report).
 * Renders nothing when the trader has no report, so it can sit on any page (dashboard, analytics,
 * profile, leaderboard) without empty noise. Full report: /stats?trader=<name>.
 */
import { Link } from "wouter";
import { ArrowRight, Building2 } from "lucide-react";
import { Panel, StatCard, StatGrid, type Tone } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { usePerformance } from "./api";
import { fmtCount, fmtDate, fmtPct, fmtUsd } from "@/lib/format";
import { propreportsI18n } from "@/i18n/ns/propreports";
import { commonI18n } from "@/i18n/ns/common";
import { personName } from "@/i18n";

const toneOf = (v: number | null | undefined): Tone => (v == null || v === 0 ? "neutral" : v > 0 ? "up" : "down");

/** Latest broker report for a trader (null while loading / none). */
export function useBrokerReport(trader: string | null | undefined) {
  const q = usePerformance(trader || null);
  const latest = trader ? q.data?.latest ?? null : null;
  return { latest, isLoading: q.isLoading };
}

export function BrokerStatsCard({ trader, title, className }: { trader: string | null | undefined; title?: string; className?: string }) {
  const { latest } = useBrokerReport(trader);
  const { t } = propreportsI18n.useT();
  if (!trader || !latest) return null;
  const s = latest.summary;
  const longNet = latest.data?.bySide?.long?.totals?.net ?? null;
  const shortNet = latest.data?.bySide?.short?.totals?.net ?? null;
  return (
    <Panel
      title={title ?? t("broker.title")}
      description={`${t("broker.period", { account: latest.account, from: fmtDate(latest.periodFrom, "medium"), to: fmtDate(latest.periodTo, "medium") })}${latest.traderName ? ` · ${personName(latest.traderName)}` : ""}`}
      icon={Building2}
      className={className}
      actions={
        <Button variant="ghost" size="sm" className="rounded-full" asChild>
          <Link href={`/stats?trader=${encodeURIComponent(trader)}`}>
            {t("broker.full")} <ArrowRight className="ml-1 h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </Button>
      }
    >
      <StatGrid className="md:grid-cols-3 xl:grid-cols-6">
        <StatCard label={commonI18n.t("trading.netPnl")} value={fmtUsd(s.net, { signed: true })} tone={toneOf(s.net)} hint={t("broker.grossHint", { value: fmtUsd(s.gross, { signed: true }) })} />
        <StatCard label={commonI18n.t("trading.fees")} value={fmtUsd(s.fees)} tone={s.feesPctOfGross != null && s.feesPctOfGross > 50 ? "warn" : "neutral"}
          hint={s.feesPctOfGross != null ? t("broker.feesShare", { pct: fmtPct(s.feesPctOfGross, { decimals: 0, signed: false }) }) : undefined} />
        <StatCard label={t("broker.trades")} value={fmtCount(s.trades)} hint={`${s.wins} W / ${s.losses} L`} />
        <StatCard label="Win rate" value={fmtPct(s.winRate, { decimals: 1, signed: false })} tone={s.winRate != null && s.winRate >= 50 ? "up" : "neutral"} />
        <StatCard label={t("broker.longNet")} value={fmtUsd(longNet, { signed: true })} tone={toneOf(longNet)} />
        <StatCard label={t("broker.shortNet")} value={fmtUsd(shortNet, { signed: true })} tone={toneOf(shortNet)} />
      </StatGrid>
    </Panel>
  );
}

export default BrokerStatsCard;
