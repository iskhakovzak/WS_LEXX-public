import { useMemo, useState } from "react";
import { Link } from "wouter";
import type { Trade } from "@workspace/api-client-react";
import { ArrowRight, Check, FlaskConical, Receipt } from "lucide-react";
import { Panel, EmptyState, Pill, toneOf } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { type AnalyticsFilters, type Unit, NONE } from "./metrics";
import { fmtNum, fmtR, fmtRate, fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { analyticsI18n } from "@/i18n/ns/analytics";
import { encodeRules, type Rule } from "@/components/shared/what-if-rules";
import { toSimTrades } from "./edge-api";
import { applyWhatIf, kpisOf, WHAT_IF_RULE_IDS, type WhatIfRuleId, type ValueKpis } from "./edge-stats";
import { CostsSummary } from "./CostsTab";

/**
 * Compact «Что если» tab of /analytics. The full simulator (server engine, own rules, suggestions, saved scenarios,
 * tariffs) is /what-if; this tab keeps what only the analytics page can do — quick discipline rules on the trades
 * under the page filters, in R or $ — plus the gross → net fee strip, and links into /what-if with the same scope.
 */

/** Analytics rule → the equivalent /what-if rule (null: the rule exists only here). */
function toWhatIfRule(id: WhatIfRuleId, worstSetup: string | null): Rule | null {
  switch (id) {
    case "dropWorstSetup": return worstSetup && worstSetup !== NONE ? { type: "excludeSetups", setups: [worstSetup] } : null;
    case "onlyAGrade": return { type: "minGrade", grade: "A" };
    case "noEarly": return { type: "timeWindow", from: "09:45", to: null };
    case "stopAfter2Losses": return { type: "stopAfterLosses", n: 2 };
    default: return null;
  }
}
const ONLY_HERE: ReadonlySet<WhatIfRuleId> = new Set(["capLoss1R", "noOvernight"]);

/** /what-if link with the same trader and period (7 days has no twin there → 30 days). */
export function whatIfHref(filters: AnalyticsFilters, rules: Rule[] = [], hash = ""): string {
  const sp = new URLSearchParams();
  const r = encodeRules(rules);
  if (r) sp.set("r", r);
  const p = filters.period === "7d" ? "30d" : filters.period;
  if (p !== "all") sp.set("p", p);
  // No trader picked here = the whole scope; /what-if reads "__all__" as «Вся команда» (ignored for traders).
  sp.set("trader", filters.trader || "__all__");
  const q = sp.toString();
  return `/what-if${q ? `?${q}` : ""}${hash}`;
}

export function WhatIfTab({ trades, unit, filters }: { trades: Trade[]; unit: Unit | null; filters: AnalyticsFilters }) {
  const { t } = analyticsI18n.useT();
  const u: Unit = unit ?? "r";
  const [rules, setRules] = useState<Set<WhatIfRuleId>>(new Set());
  const sim = useMemo(() => toSimTrades(trades), [trades]);

  const base = useMemo(() => {
    const values = sim.map((s) => (u === "r" ? s.r : s.net)).filter((v): v is number => v != null);
    return { values, kpis: kpisOf(values) };
  }, [sim, u]);
  const alt = useMemo(() => {
    const r = applyWhatIf(sim, rules, u);
    return { ...r, kpis: kpisOf(r.values) };
  }, [sim, rules, u]);
  /** Each rule on its own: Δ total and why it could not apply. */
  const single = useMemo(() => {
    const out = new Map<WhatIfRuleId, { delta: number | null; skip: string | null; worstSetup: string | null }>();
    for (const id of WHAT_IF_RULE_IDS) {
      const r = applyWhatIf(sim, new Set([id]), u);
      const skip = r.skipped[0]?.reason ?? null;
      out.set(id, { delta: skip ? null : kpisOf(r.values).total - base.kpis.total, skip, worstSetup: r.worstSetup });
    }
    return out;
  }, [sim, u, base.kpis.total]);

  const fmt = (v: number | null | undefined, digits = 2) => (u === "r" ? fmtR(v, digits) : fmtUsd(v, { signed: true, decimals: "auto" }));
  const toggle = (id: WhatIfRuleId) => setRules((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const mapped = [...rules].map((id) => toWhatIfRule(id, single.get(id)?.worstSetup ?? null)).filter((r): r is Rule => r != null);
  const openHref = whatIfHref(filters, mapped);
  const setupLabel = (s: string) => (s === NONE ? t("bucket.noSetup") : s);

  const rows: { id: string; label: string; a: number | null; b: number | null; fmt: (v: number | null) => string; delta: (d: number) => string; invert?: boolean }[] = [
    { id: "total", label: t("whatIf.rowTotal", { unit: u === "r" ? "R" : t("unit.usdShort") }), a: base.kpis.total, b: alt.kpis.total, fmt: (v) => fmt(v, 1), delta: (d) => fmt(d, 2) },
    { id: "trades", label: t("whatIf.rowTrades"), a: base.kpis.n, b: alt.kpis.n, fmt: (v) => (v == null ? "—" : String(v)), delta: (d) => fmtNum(d, { decimals: 0, signed: true }) },
    { id: "winRate", label: t("whatIf.rowWinRate"), a: base.kpis.winRate, b: alt.kpis.winRate, fmt: (v) => fmtRate(v), delta: (d) => commonI18n.t("units.percentPoints", { value: fmtNum(d * 100, { decimals: 0, signed: true }) }) },
    { id: "expectancy", label: t("whatIf.rowExpectancy"), a: base.kpis.expectancy, b: alt.kpis.expectancy, fmt: (v) => fmt(v), delta: (d) => fmt(d, 2) },
    { id: "maxDd", label: t("whatIf.rowMaxDd"), a: base.kpis.maxDrawdown, b: alt.kpis.maxDrawdown, fmt: (v) => fmt(v, 1), delta: (d) => fmt(d, 2) },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title={t("whatIf.quickTitle")}
        description={t("whatIf.quickHint", { unit: u === "r" ? t("unit.r") : t("unit.usd") })}
        icon={FlaskConical}
        actions={
          <Button asChild size="sm" className="rounded-full">
            <Link href={openHref}>
              {mapped.length ? t("whatIf.openWithRules", { count: mapped.length }) : t("whatIf.open")} <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        }
      >
        {base.values.length === 0 ? (
          <EmptyState icon={FlaskConical} title={t("whatIf.nothing")} description={u === "r" ? t("whatIf.nothingR") : t("whatIf.nothingUsd")} className="py-6" />
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
            <ul className="flex flex-col gap-1.5 lg:col-span-3">
              {WHAT_IF_RULE_IDS.map((id) => {
                const on = rules.has(id);
                const one = single.get(id);
                const skipped = alt.skipped.find((s) => s.rule === id);
                const worst = id === "dropWorstSetup" ? one?.worstSetup ?? null : null;
                const ruleLabel = t(`whatIf.rule.${id}.label`);
                return (
                  <li key={id}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      onClick={() => toggle(id)}
                      className={cn("flex w-full items-start gap-2 rounded-xl px-3 py-2 text-left transition-colors", on ? "bg-primary/10 ring-1 ring-primary/40" : "bg-[var(--glass-bg)] hover:bg-primary/5")}
                    >
                      <span className={cn("mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border", on ? "border-primary bg-primary text-primary-foreground" : "border-border")} aria-hidden="true">
                        {on && <Check className="h-3 w-3" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">{worst ? t("whatIf.worstSetup", { label: ruleLabel, setup: setupLabel(worst) }) : ruleLabel}</span>
                        <span className="block text-2xs text-muted-foreground">
                          {skipped ? t("whatIf.notApplied", { reason: t(`whatIf.skip.${skipped.reason}`) }) : t(`whatIf.rule.${id}.hint`)}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-0.5">
                        {one?.delta != null && (
                          <span className={cn("text-xs font-medium tabular-nums", Math.abs(one.delta) < 1e-9 ? "text-muted-foreground" : one.delta > 0 ? "text-up" : "text-down")} title={t("whatIf.alone", { value: fmt(one.delta) })}>
                            {fmt(one.delta)}
                          </span>
                        )}
                        {ONLY_HERE.has(id) && <span className="text-2xs text-muted-foreground" title={t("whatIf.onlyHereHint")}>{t("whatIf.onlyHere")}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            <div className="flex flex-col gap-2 lg:col-span-2">
              <KpiCompare rows={rows} t={t} />
              <div className="flex flex-wrap gap-1.5">
                {rules.size > 0 && alt.removed > 0 && <Pill tone="neutral">{t("whatIf.removed", { trades: commonI18n.t("units.trades", { count: alt.removed }) })}</Pill>}
                {rules.size > 0 && alt.modified > 0 && <Pill tone="neutral">{t("whatIf.trimmed", { trades: commonI18n.t("units.trades", { count: alt.modified }) })}</Pill>}
                {rules.size > 0 && alt.removed === 0 && alt.modified === 0 && <Pill tone="neutral">{t("whatIf.nothingChanged")}</Pill>}
              </div>
              <p className="text-2xs text-muted-foreground">{t("whatIf.footnote")}</p>
            </div>
          </div>
        )}
        <p className="mt-3 border-t border-border/50 pt-3 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{t("whatIf.bridgeTitle")}.</span> {t("whatIf.bridgeText")}
        </p>
      </Panel>

      <Panel
        title={t("whatIf.feesTitle")}
        description={t("whatIf.feesHint")}
        icon={Receipt}
        actions={
          <Link href={whatIfHref(filters, [], "#fees")} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
            {t("whatIf.feesLink")} <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        }
      >
        <CostsSummary filters={filters} />
      </Panel>
    </div>
  );
}

function KpiCompare({ rows, t }: {
  rows: { id: string; label: string; a: number | null; b: number | null; fmt: (v: number | null) => string; delta: (d: number) => string; invert?: boolean }[];
  t: ReturnType<typeof analyticsI18n.useT>["t"];
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs text-muted-foreground">
          <th className="py-1.5 text-left font-medium">{t("whatIf.colMetric")}</th>
          <th className="py-1.5 text-right font-medium">{t("whatIf.colFact")}</th>
          <th className="py-1.5 text-right font-medium">{t("whatIf.colWhatIf")}</th>
          <th className="py-1.5 text-right font-medium">Δ</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const d = r.a != null && r.b != null ? r.b - r.a : null;
          const tone = d == null || Math.abs(d) < 1e-9 ? "neutral" : toneOf(r.invert ? -d : d);
          return (
            <tr key={r.id} className="border-t border-border/50 tabular-nums">
              <td className="py-1.5">{r.label}</td>
              <td className="py-1.5 text-right text-muted-foreground">{r.fmt(r.a)}</td>
              <td className="py-1.5 text-right font-medium">{r.fmt(r.b)}</td>
              <td className={cn("py-1.5 text-right", tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-muted-foreground")}>{d == null ? "—" : r.delta(d)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export type { ValueKpis };
