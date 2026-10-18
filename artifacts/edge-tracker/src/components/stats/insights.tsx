import { Link } from "wouter";
import type { Trade } from "@workspace/api-client-react";
import { AlertTriangle, ArrowRight, Flame, Lightbulb, Target, TrendingDown, TrendingUp, Trophy } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { EmptyState, Panel, type Tone, toneText } from "@/components/ds";
import { cn } from "@/lib/utils";
import { TradeLinkRow } from "./trade-link-row";
import { dayKey, fmtValue, groupBy, isClosed, valueOf, weekdayIdx, weekdayLabel, type Kpis, type Metric } from "./metrics";
import { fmtNum, fmtRate } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { statsI18n } from "@/i18n/ns/stats";

export type Insight = { id: string; tone: Tone; icon: LucideIcon; text: string; href?: string; cta?: string };

export function buildInsights(trades: Trade[], k: Kpis, metric: Metric): Insight[] {
  const t = statsI18n.t;
  const out: Insight[] = [];
  const unit = metric === "r" ? "R" : "P&L";

  if (k.current.kind && k.current.len >= 2) {
    const win = k.current.kind === "win";
    out.push({
      id: "streak",
      tone: win ? "up" : "down",
      icon: Flame,
      text: win ? t("insights.streakWin", { count: k.current.len }) : t("insights.streakLoss", { count: k.current.len }),
    });
  }

  if (k.payoff != null && k.winRate != null) {
    const need = 1 / (1 + k.payoff);
    out.push({
      id: "edge",
      tone: k.winRate >= need ? "up" : "down",
      icon: Target,
      text: t(k.winRate >= need ? "insights.edgeOk" : "insights.edgeLow", { payoff: fmtNum(k.payoff), need: fmtRate(need), wr: fmtRate(k.winRate) }),
    });
  }

  const closed = trades.filter(isClosed);
  const byDay = groupBy(closed, (tr) => weekdayLabel(weekdayIdx(dayKey(tr))), metric).filter((g) => g.valued >= 2 && g.value != null);
  if (byDay.length >= 2) {
    const best = byDay.reduce((a, b) => ((b.value ?? 0) > (a.value ?? 0) ? b : a));
    const worst = byDay.reduce((a, b) => ((b.value ?? 0) < (a.value ?? 0) ? b : a));
    if ((best.value ?? 0) > 0) out.push({ id: "bestday", tone: "up", icon: TrendingUp, text: t("insights.bestDay", { day: best.key, value: fmtValue(best.value, metric), trades: commonI18n.t("units.trades", { count: best.count }) }) });
    if ((worst.value ?? 0) < 0 && worst.key !== best.key) out.push({ id: "worstday", tone: "down", icon: TrendingDown, text: t("insights.worstDay", { day: worst.key, value: fmtValue(worst.value, metric) }) });
  }

  const bySetup = groupBy(closed, (tr) => tr.setup || tr.eventType, metric).filter((g) => g.key !== "—" && g.valued >= 2 && g.value != null);
  if (bySetup.length) {
    const best = bySetup.reduce((a, b) => ((b.value ?? 0) > (a.value ?? 0) ? b : a));
    const worst = bySetup.reduce((a, b) => ((b.value ?? 0) < (a.value ?? 0) ? b : a));
    if ((best.value ?? 0) > 0) out.push({ id: "bestsetup", tone: "up", icon: Trophy, text: t("insights.bestSetup", { setup: best.key, value: fmtValue(best.value, metric), wr: fmtRate(best.winRate) }), href: "/playbook", cta: t("insights.playbook") });
    if ((worst.value ?? 0) < 0 && worst.key !== best.key) out.push({ id: "worstsetup", tone: "down", icon: AlertTriangle, text: t("insights.worstSetup", { setup: worst.key, value: fmtValue(worst.value, metric), trades: commonI18n.t("units.trades", { count: worst.count }) }), href: "/analytics?tab=edge", cta: t("insights.review") });
  }

  if (k.missing > 0) {
    out.push({
      id: "missing",
      tone: "warn",
      icon: AlertTriangle,
      text: t("insights.missing", { count: k.missing, unit }),
      href: "/trades",
      cta: t("insights.toTrades"),
    });
  }
  if (k.open > 0) {
    out.push({
      id: "open",
      tone: "accent",
      icon: Lightbulb,
      text: t("insights.open2", { count: k.open }),
      href: "/trades",
      cta: t("insights.close"),
    });
  }
  return out;
}

export function InsightsPanel({ insights }: { insights: Insight[] }) {
  const { t } = statsI18n.useT();
  return (
    <Panel title={t("insights.title")} icon={Lightbulb} description={t("insights.hint")}>
      {insights.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("insights.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {insights.map((i) => (
            <li key={i.id} className="flex items-start gap-3 rounded-xl bg-[var(--glass-bg)] px-3 py-2.5">
              <i.icon className={cn("mt-0.5 h-4 w-4 shrink-0", toneText(i.tone))} aria-hidden="true" />
              <span className="min-w-0 flex-1 text-sm text-foreground">{i.text}</span>
              {i.href && (
                <Link href={i.href} className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {i.cta ?? t("insights.open")} <ArrowRight className="h-3 w-3" aria-hidden="true" />
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** Best / worst trades of the period — each row opens the trade in the journal. */
export function ExtremesPanel({ trades, metric }: { trades: Trade[]; metric: Metric }) {
  const { t } = statsI18n.useT();
  const valued = trades.filter((t) => isClosed(t) && valueOf(t, metric) != null);
  const best = valued.filter((t) => valueOf(t, metric)! > 0).sort((a, b) => valueOf(b, metric)! - valueOf(a, metric)!).slice(0, 5);
  const worst = valued.filter((t) => valueOf(t, metric)! < 0).sort((a, b) => valueOf(a, metric)! - valueOf(b, metric)!).slice(0, 5);
  const unit = metric === "r" ? "R" : "P&L";

  const List = ({ title, icon: Icon, tone, items, empty }: { title: string; icon: LucideIcon; tone: Tone; items: Trade[]; empty: string }) => (
    <div className="min-w-0">
      <div className="mb-1 flex items-center gap-2 px-2">
        <Icon className={cn("h-4 w-4", toneText(tone))} aria-hidden="true" />
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      {items.length ? (
        <ol className="flex flex-col">
          {items.map((t, i) => <TradeLinkRow key={t.id} trade={t} metric={metric} rank={i + 1} />)}
        </ol>
      ) : (
        <p className="px-2 py-4 text-sm text-muted-foreground">{empty}</p>
      )}
    </div>
  );

  return (
    <Panel title={t("extremes.title")} description={t("extremes.hint", { unit })}>
      {valued.length === 0 ? (
        <EmptyState icon={Trophy} title={t("extremes.empty", { unit })} description={t("extremes.emptyHint")} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <List title={t("extremes.best")} icon={Trophy} tone="up" items={best} empty={t("extremes.noBest")} />
          <List title={t("extremes.worst")} icon={AlertTriangle} tone="down" items={worst} empty={t("extremes.noWorst")} />

        </div>
      )}
    </Panel>
  );
}
