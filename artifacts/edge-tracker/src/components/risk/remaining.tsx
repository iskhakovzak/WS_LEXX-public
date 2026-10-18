import { cn } from "@/lib/utils";
import { useReducedMotion } from "framer-motion";
import { OctagonX } from "lucide-react";
import type { RiskLimits, RiskMetrics } from "./use-risk";
import { usageColor, usageText } from "./primitives";
import { fmtPct, fmtUsd } from "@/lib/format";
import { riskI18n } from "@/i18n/ns/risk";
import { commonI18n } from "@/i18n/ns/common";

type Item = { key: string; label: string; used: number; limit: number | null; pnlText: string };

function items(m: RiskMetrics, L: RiskLimits | null): Item[] {
  const t = riskI18n.t;
  const pnl = (v: number | null) => fmtUsd(v, { signed: true, decimals: 0 });
  return [
    { key: "day", label: t("remaining.day"), used: Math.max(0, -(m.today.pnlNet ?? 0)), limit: L?.dailyLossLimit ?? null, pnlText: t("remaining.pnlDay", { pnl: pnl(m.today.pnlNet) }) },
    { key: "week", label: t("remaining.week"), used: Math.max(0, -(m.week.pnlNet ?? 0)), limit: L?.weeklyLossLimit ?? null, pnlText: t("remaining.pnlWeek", { pnl: pnl(m.week.pnlNet) }) },
    { key: "dd", label: t("remaining.dd"), used: Math.max(0, m.drawdown.currentUsd), limit: L?.maxDrawdown ?? null, pnlText: t("remaining.pnlPeak", { pnl: pnl(m.drawdown.currentUsd ? -m.drawdown.currentUsd : 0) }) },
  ];
}

function Cell({ it, big }: { it: Item; big: boolean }) {
  const reduce = useReducedMotion();
  const { t } = riskI18n.useT();
  if (it.limit == null || it.limit <= 0) {
    return (
      <div className="flex flex-col gap-1 rounded-xl bg-[var(--glass-bg)] p-3 ring-1 ring-inset ring-[var(--field-border)]">
        <span className="text-xs text-muted-foreground">{it.label}</span>
        <span className="text-sm text-muted-foreground">{commonI18n.t("trading.limitNotSet")}</span>
        <span className="text-xs text-muted-foreground tabular-nums">{it.pnlText}</span>
      </div>
    );
  }
  const pct = (it.used / it.limit) * 100;
  const remaining = Math.max(0, it.limit - it.used);
  const remainingPct = Math.max(0, 100 - pct);
  const over = pct >= 100;
  return (
    <div className={cn("flex flex-col gap-1.5 rounded-xl p-3 ring-1 ring-inset", over ? "bg-down/10 ring-down/40" : pct >= 70 ? "bg-warn/10 ring-warn/30" : "bg-[var(--glass-bg)] ring-[var(--field-border)]")}>
      <span className="text-xs text-muted-foreground">{it.label}</span>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 tabular-nums">
        <span className={cn("inline-flex items-center gap-1.5 font-semibold", big ? "text-2xl" : "text-lg", over ? "text-down" : usageText(pct))}>
          {over && <OctagonX className={big ? "h-5 w-5" : "h-4 w-4"} aria-hidden="true" />}
          {over ? t("remaining.stop") : fmtUsd(remaining, { decimals: 0 })}
        </span>
        <span className={cn("text-xs", over ? "font-medium text-down" : "text-muted-foreground")}>
          {over
            ? t("remaining.over", { amount: fmtUsd(it.used - it.limit, { decimals: 0 }) })
            : t("remaining.leftPct", { pct: fmtPct(remainingPct, { decimals: 0, signed: false }) })}
        </span>
      </div>
      <div
        className="relative h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={t("remaining.aria", { label: it.label, pct: fmtPct(pct, { decimals: 0, signed: false }) })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, Math.round(pct))}
      >
        <div
          className={cn("h-full rounded-full", !reduce && "transition-[width] duration-[var(--dur-4)]")}
          style={{ width: `${Math.min(100, Math.max(it.used > 0 ? 2 : 0, pct))}%`, background: usageColor(pct) }}
        />
        <span className="absolute inset-y-0 w-px bg-foreground/30" style={{ left: "70%" }} aria-hidden="true" />
      </div>
      <span className="text-xs text-muted-foreground tabular-nums">
        {t("remaining.pnlWithLimit", { pnl: it.pnlText, limit: fmtUsd(it.limit, { decimals: 0 }) })}
      </span>
    </div>
  );
}

export function StopRemaining({ m, limits, big = false, className }: { m: RiskMetrics; limits: RiskLimits | null; big?: boolean; className?: string }) {
  riskI18n.useT();
  return (
    <div className={cn("grid grid-cols-1 gap-3 sm:grid-cols-3", className)}>
      {items(m, limits).map((it) => <Cell key={it.key} it={it} big={big} />)}
    </div>
  );
}
