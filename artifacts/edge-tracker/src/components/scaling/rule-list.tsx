import * as React from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Check, Minus, X } from "lucide-react";
import { Pill } from "@/components/ds";
import { cn } from "@/lib/utils";
import type { MetricMeta, RuleResult } from "./use-scaling";
import { OP_LABEL, STATUS_TONE, fmtMetric, fmtThreshold, ruleStatusLabel } from "./format";
import { fmtRate } from "@/lib/format";
import { scalingI18n } from "@/i18n/ns/scaling";

const ICON = { pass: Check, fail: X, na: Minus } as const;
const ICON_CLS = { pass: "bg-up/15 text-up", fail: "bg-down/15 text-down", na: "bg-[var(--glass-bg)] text-muted-foreground" } as const;
const BAR_CLS = { pass: "bg-up", fail: "bg-[hsl(var(--chart-3))]", na: "bg-muted-foreground/40" } as const;

/**
 * Rule checklist: each row = status icon, label, actual vs. threshold and a progress bar to passing.
 * Demotion rules invert the wording ("triggered" when the condition is met).
 */
export function RuleList({
  rules,
  metrics,
  emptyText,
  className,
}: {
  rules: RuleResult[];
  metrics: MetricMeta[];
  emptyText?: string;
  className?: string;
}) {
  const { t } = scalingI18n.useT();
  const reduce = useReducedMotion();
  const meta = React.useMemo(() => new Map(metrics.map((m) => [m.key, m])), [metrics]);
  if (!rules.length) return <p className={cn("text-sm text-muted-foreground", className)}>{emptyText ?? t("rules.empty")}</p>;
  return (
    <ul className={cn("flex flex-col gap-2", className)}>
      {rules.map((r) => {
        const m = meta.get(r.metric);
        const unit = m?.unit ?? "count";
        const demote = r.kind === "demote";
        const Icon = demote && r.status === "pass" ? X : ICON[r.status];
        const iconCls = demote && r.status === "pass" ? ICON_CLS.fail : demote && r.status === "fail" ? ICON_CLS.pass : ICON_CLS[r.status];
        const statusLabel = demote
          ? r.status === "pass" ? t("ruleStatus.triggered") : r.status === "fail" ? t("ruleStatus.ok") : ruleStatusLabel("na")
          : ruleStatusLabel(r.status);
        const statusTone = demote ? (r.status === "pass" ? "down" : r.status === "fail" ? "up" : "neutral") : STATUS_TONE[r.status];
        const pct = Math.round(r.progress * 100);
        return (
          <li key={r.ruleId} className="glass-panel flex flex-col gap-2 rounded-xl px-3 py-2.5">
            <div className="flex items-start gap-3">
              <span className={cn("mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full", iconCls)} aria-hidden="true">
                <Icon className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <span className="text-sm font-medium text-foreground" title={m?.hint}>{r.label}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    <span className={cn("font-semibold", r.actual == null ? "text-muted-foreground" : "text-foreground")}>{fmtMetric(unit, r.actual)}</span>
                    {" "}{OP_LABEL[r.op]} {fmtThreshold(unit, r.rawValue, r.unit, r.threshold)}
                  </span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
                  <Pill tone={statusTone} className="text-2xs">{statusLabel}</Pill>
                  <span>{t("rules.windowDays", { count: r.windowDays })}</span>
                  {r.basis === "r" && unit !== "r" && <span>{t("rules.byR")}</span>}
                  {r.status === "na" && <span className="truncate" title={r.text}>{r.text.split(": ").slice(1).join(": ")}</span>}
                </div>
              </div>
            </div>
            {!demote && r.status !== "na" && (
              <div
                role="meter"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
                aria-label={t("progress.toPass", { label: r.label, value: fmtRate(r.progress) })}
                className="relative h-1.5 w-full overflow-hidden rounded-full bg-[var(--glass-bg)] ring-1 ring-inset ring-[var(--glass-border)]"
              >
                <motion.div
                  className={cn("h-full w-full rounded-full", BAR_CLS[r.status])}
                  initial={reduce ? false : { x: "-100%" }}
                  animate={{ x: `${pct - 100}%` }}
                  transition={{ duration: reduce ? 0 : 0.45, ease: [0.2, 0.8, 0.2, 1] }}
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
