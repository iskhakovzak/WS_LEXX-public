/**
 * History of limit breaches for one trader: alerts the desk recorded live (risk_alert_log) merged with a
 * retrospective pass over daily net P&L against the trader's CURRENT limits (days / weeks / drawdown).
 */
import * as React from "react";
import { Link } from "wouter";
import { AlertTriangle, OctagonX, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { links } from "@/lib/links";
import { Skeleton } from "@/components/ui/skeleton";
import type { RiskAlertRecord, RiskLimits } from "./use-risk";
import { useRiskAlerts, useRiskHistory } from "./use-risk";
import { breachHistory } from "./risk-math";
import { fmtDate, fmtPct, fmtUsd } from "@/lib/format";
import { riskI18n } from "@/i18n/ns/risk";
import { commonI18n } from "@/i18n/ns/common";

export type BreachRow = {
  key: string;
  date: string;
  kind: "daily" | "weekly" | "drawdown" | "near";
  level: "breach" | "warn";
  used: number | null;
  limit: number | null;
  pct: number | null;
  /** true = the desk recorded it live; false = found retrospectively against current limits. */
  logged: boolean;
  message?: string;
};

const BREACH_DAYS = 250;

function fromLog(a: RiskAlertRecord): BreachRow {
  const kind: BreachRow["kind"] = a.kind === "stop" ? "daily" : a.kind === "weekly" ? "weekly" : a.kind === "drawdown" ? "drawdown" : "near";
  return {
    key: `log-${a.id}`,
    date: a.date,
    kind,
    level: a.level,
    used: a.used,
    limit: a.limit,
    pct: a.used != null && a.limit ? Math.round((a.used / a.limit) * 1000) / 10 : null,
    logged: true,
    message: a.message,
  };
}

/** Merged, newest-first breach list + loading state. Retro rows that duplicate a logged alert (same day & kind) are dropped. */
export function useBreaches(trader: string | null, limits: RiskLimits | null | undefined, enabled = true) {
  const hist = useRiskHistory(enabled ? trader : null, BREACH_DAYS);
  const log = useRiskAlerts(trader, 180, enabled && !!trader);
  const rows = React.useMemo(() => {
    const logged = (log.data?.alerts ?? []).map(fromLog);
    const L = limits ?? hist.data?.limits ?? null;
    const retro = hist.data?.unit === "usd"
      ? breachHistory(hist.data.points.map((p) => ({ date: p.date, pnl: p.pnl, drawdown: p.drawdown })), L)
      : [];
    const seen = new Set(logged.map((r) => `${r.date}|${r.kind === "near" ? "warn" : r.kind}`));
    const merged: BreachRow[] = [...logged];
    for (const b of retro) {
      if (seen.has(`${b.date}|${b.kind}`) || (b.level === "warn" && seen.has(`${b.date}|warn`))) continue;
      merged.push({ key: `retro-${b.kind}-${b.date}-${b.level}`, date: b.date, kind: b.kind, level: b.level, used: b.used, limit: b.limit, pct: b.pct, logged: false });
    }
    return merged.sort((a, b) => b.date.localeCompare(a.date) || (a.level === b.level ? 0 : a.level === "breach" ? -1 : 1));
  }, [log.data, hist.data, limits]);
  const hasLimits = !!(limits ?? hist.data?.limits);
  return { rows, hasLimits, isLoading: hist.isLoading || log.isLoading, days: BREACH_DAYS };
}

export function BreachSummary({ rows }: { rows: BreachRow[] }) {
  const { t } = riskI18n.useT();
  const breaches = rows.filter((r) => r.level === "breach");
  const n = (k: BreachRow["kind"]) => breaches.filter((r) => r.kind === k).length;
  const parts = [
    n("daily") ? t("breach.summaryDaily", { count: n("daily") }) : null,
    n("weekly") ? t("breach.summaryWeekly", { count: n("weekly") }) : null,
    n("drawdown") ? t("breach.summaryDrawdown", { count: n("drawdown") }) : null,
  ].filter(Boolean);
  const warns = rows.length - breaches.length;
  return (
    <p className="text-xs text-muted-foreground tabular-nums">
      {parts.length ? <span className="font-medium text-down">{t("breach.summary", { list: parts.join(", ") })}</span> : <span className="text-up">{t("breach.noStops")}</span>}
      {warns > 0 && <span> · {t("breach.nearTimes", { count: warns })}</span>}
    </p>
  );
}

export function BreachList({ rows, trader, max, className }: { rows: BreachRow[]; trader: string; max?: number; className?: string }) {
  const { t } = riskI18n.useT();
  const [all, setAll] = React.useState(false);
  const shown = max != null && !all ? rows.slice(0, max) : rows;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <ul className="flex flex-col gap-1.5">
        {shown.map((r) => {
          const breach = r.level === "breach";
          const Icon = breach ? OctagonX : AlertTriangle;
          return (
            <li key={r.key} className={cn("flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-xl px-3 py-2 text-sm", breach ? "bg-down/10" : "bg-warn/10")}>
              <Icon className={cn("h-4 w-4 shrink-0", breach ? "text-down" : "text-warn")} aria-hidden="true" />
              <Link href={links.journalDay(r.date, trader)} className="w-16 shrink-0 text-xs tabular-nums text-muted-foreground hover:text-primary" title={t("breach.journalDay")}>
                {fmtDate(r.date.slice(0, 10), "shortYY")}
              </Link>
              <span className="min-w-0 flex-1">
                <span className="font-medium">{t(`breach.kind.${r.kind}`)}</span>
                <span className={breach ? "text-down" : "text-muted-foreground"}> · {breach ? t("breach.exceeded") : t("breach.nearPct")}</span>
                {r.logged && <span className="ml-1.5 text-xs text-muted-foreground" title={t("breach.loggedHint")}>{t("breach.logged")}</span>}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {r.used != null ? fmtUsd(-r.used, { decimals: 0 }) : "—"}{r.limit != null ? ` / ${fmtUsd(r.limit, { decimals: 0 })}` : ""}
              </span>
              {r.pct != null && <span className={cn("w-11 shrink-0 text-right text-xs font-semibold tabular-nums", breach ? "text-down" : "text-warn")}>{fmtPct(r.pct, { decimals: 0, signed: false })}</span>}
            </li>
          );
        })}
      </ul>
      {max != null && rows.length > max && (
        <button type="button" onClick={() => setAll((v) => !v)} className="self-start text-xs text-primary hover:underline">
          {all ? commonI18n.t("actions.collapse") : t("breach.showMore", { count: rows.length - max })}
        </button>
      )}
    </div>
  );
}

/** Full block: summary + list, or a short reason why there is nothing. */
export function BreachHistory({ trader, limits, max }: { trader: string; limits: RiskLimits | null | undefined; max?: number }) {
  const { t } = riskI18n.useT();
  const b = useBreaches(trader, limits);
  if (b.isLoading) return <Skeleton className="h-24 rounded-xl" />;
  if (!b.rows.length) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <ShieldCheck className="h-4 w-4 shrink-0 text-up" aria-hidden="true" />
        {b.hasLimits ? t("breach.none", { count: b.days }) : t("breach.noLimits")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <BreachSummary rows={b.rows} />
      <BreachList rows={b.rows} trader={trader} max={max} />
      <p className="text-xs text-muted-foreground">{t("breach.footnote", { count: b.days })}</p>
    </div>
  );
}
