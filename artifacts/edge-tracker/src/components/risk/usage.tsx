import { Link } from "wouter";
import { AlertOctagon, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { links } from "@/lib/links";
import type { RiskAlert } from "./use-risk";
import { fmtPct, fmtUsd } from "@/lib/format";
import { riskI18n } from "@/i18n/ns/risk";
import { alertLabel, positionsCount } from "./labels";

const isCount = (kind: string) => kind === "positions" || kind === "overnight_not_allowed" || kind === "swing_not_allowed";
const isBan = (kind: string) => kind === "overnight_not_allowed" || kind === "swing_not_allowed";

/** «$450 из $500 · AAPL», «2 позиции · AAPL, TSLA». Call at render time. */
export function alertValue(a: RiskAlert): string {
  if (isBan(a.kind)) return [positionsCount(a.used), a.detail].filter(Boolean).join(" · ");
  const f = (v: number) => (isCount(a.kind) ? String(v) : fmtUsd(v, { decimals: 0, compact: 10_000 }));
  const value = a.limit != null ? riskI18n.t("alert.value", { used: f(a.used), limit: f(a.limit) }) : f(a.used);
  return [value, a.detail].filter(Boolean).join(" · ");
}

/**
 * Compact list of warn/breach alerts for one trader: icon + limit name + state word + «used of limit» + %.
 * Alerts about a single trade (risk per trade, position size) link to that trade.
 */
export function AlertList({ alerts, className }: { alerts: RiskAlert[]; className?: string }) {
  const { t } = riskI18n.useT();
  return (
    <ul className={cn("flex flex-col gap-1.5", className)}>
      {alerts.map((a, i) => {
        const breach = a.level === "breach";
        const Icon = breach ? AlertOctagon : AlertTriangle;
        const value = alertValue(a);
        return (
          <li
            key={`${a.kind}-${i}`}
            className={cn("flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-xl px-3 py-2 text-sm", breach ? "bg-down/10" : "bg-warn/10")}
          >
            <Icon className={cn("h-4 w-4 shrink-0", breach ? "text-down" : "text-warn")} aria-hidden="true" />
            <span className="font-medium">{alertLabel(a)}</span>
            {!isBan(a.kind) && (
              <span className={cn("text-xs", breach ? "font-medium text-down" : "text-warn")}>{breach ? t("alert.breach") : t("alert.warn")}</span>
            )}
            <span className="ml-auto min-w-0 text-right text-xs text-muted-foreground tabular-nums" title={value}>
              {a.tradeId != null ? <Link href={links.trade(a.tradeId)} className="hover:text-primary hover:underline">{value}</Link> : value}
            </span>
            {a.pct != null && (
              <span className={cn("shrink-0 text-xs font-semibold tabular-nums", breach ? "text-down" : "text-warn")}>{fmtPct(a.pct, { decimals: 0, signed: false })}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
