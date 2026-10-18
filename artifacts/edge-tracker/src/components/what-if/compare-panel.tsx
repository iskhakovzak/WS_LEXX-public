import { ArrowRight } from "lucide-react";
import { Pill, TermTooltip, type TermKey, type Tone, toneOf } from "@/components/ds";
import { cn } from "@/lib/utils";
import { fmtCount, fmtNum, fmtR, fmtRate, fmtRatio, fmtUsd } from "@/lib/format";

import { commonI18n } from "@/i18n/ns/common";
import { whatIfI18n } from "@/i18n/ns/whatIf";
import type { BootstrapSummary, Metrics } from "./api";

const pp = (d: number) => commonI18n.t("units.percentPoints", { value: fmtNum(d * 100, { decimals: 1, signed: true }) });

const TONE_CLASS: Record<string, string> = { up: "text-up", down: "text-down", neutral: "text-muted-foreground" };
function deltaOf(a: number | null, b: number | null) {
  return a != null && b != null ? b - a : null;
}
function toneFor(d: number | null, invert = false): Tone {
  if (d == null || Math.abs(d) < 1e-9) return "neutral";
  return toneOf(invert ? -d : d);
}


/**
 * Result first: «было → стало» in $ and in R (when the trades have R), the difference big, and a plain-language
 * reliability verdict. Without a scenario it shows the period as it was and a prompt to ask a question.
 */
export function DeltaHeadline({ baseline, scenario, hasScenario, bootstrap }: { baseline: Metrics; scenario: Metrics; hasScenario: boolean; bootstrap: BootstrapSummary | null }) {
  const { t } = whatIfI18n.useT();
  const d = scenario.net - baseline.net;
  const ofTrades = t("compare.ofTrades", { trades: commonI18n.t("units.trades", { count: scenario.trades }), total: baseline.trades });
  const rA = baseline.totalR ?? null, rB = scenario.totalR ?? null;
  const showR = rA != null && (baseline.rCount ?? 0) >= 3;
  const dR = showR && rB != null ? rB - rA : null;
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
        <div>
          <p className="text-xs text-muted-foreground">{t("compare.before")}</p>
          <p className={cn("text-2xl font-semibold tabular-nums tracking-tight", TONE_CLASS[toneOf(baseline.net)])}>{fmtUsd(baseline.net, { signed: true, decimals: "auto" })}</p>
          {showR && <p className={cn("text-sm tabular-nums", TONE_CLASS[toneOf(rA)])}>{fmtR(rA, 1)}</p>}
        </div>
        <ArrowRight className="mb-3 h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <div>
          <p className="text-xs text-muted-foreground">{t("compare.after")}</p>
          <p className={cn("text-2xl font-semibold tabular-nums tracking-tight", hasScenario ? TONE_CLASS[toneOf(scenario.net)] : "text-muted-foreground")}>{hasScenario ? fmtUsd(scenario.net, { signed: true, decimals: "auto" }) : "—"}</p>
          {showR && <p className={cn("text-sm tabular-nums", hasScenario && rB != null ? TONE_CLASS[toneOf(rB)] : "text-muted-foreground")}>{hasScenario && rB != null ? fmtR(rB, 1) : "—"}</p>}
        </div>
        {hasScenario ? (
          <div className="rounded-2xl bg-[hsl(var(--muted-foreground)/0.08)] px-4 py-2">
            <p className="text-xs text-muted-foreground">{t("compare.diff")}</p>
            <p className={cn("text-4xl font-semibold leading-tight tabular-nums tracking-tight", TONE_CLASS[toneOf(d)])}>{fmtUsd(d, { signed: true, decimals: "auto" })}</p>
            {dR != null && <p className={cn("text-sm font-medium tabular-nums", TONE_CLASS[toneOf(dR)])}>{fmtR(dR, 1)} · {ofTrades}</p>}
            {dR == null && <p className="text-sm tabular-nums text-muted-foreground">{ofTrades}</p>}
          </div>
        ) : (
          <p className="max-w-xs pb-1 text-sm text-muted-foreground">{t("compare.prompt")}</p>
        )}
      </div>
      {hasScenario && <Reliability b={bootstrap} />}
    </div>
  );
}

function Reliability({ b }: { b: BootstrapSummary | null }) {
  const { t } = whatIfI18n.useT();
  if (!b) return <Pill tone="neutral">{t("compare.fewDays")}</Pill>;
  const { lo, hi, mean } = b.diffTotal;
  const robust = b.significant;
  const tone: Tone = robust ? (mean > 0 ? "up" : "down") : "warn";
  const text = robust ? (mean > 0 ? t("compare.robustBetter") : t("compare.robustWorse")) : t("compare.maybeChance");
  return (
    <div className="flex flex-col items-end gap-1 text-right">
      <Pill tone={tone}>{text}{b.smallSample ? ` ${t("compare.fewDaysShort")}` : ""}</Pill>
      <span className="text-xs text-muted-foreground tabular-nums" title={t("compare.ciTitle")}>
        {t("compare.ci95", { lo: fmtUsd(lo, { signed: true, decimals: "auto" }), hi: fmtUsd(hi, { signed: true, decimals: "auto" }) })}
      </span>
    </div>
  );
}

type KeyDef = { id: string; label: string; term?: TermKey; a: number | null; b: number | null; fmt: (v: number | null) => string; delta: (d: number) => string; invert?: boolean };

/** Strip of key metrics «факт → сценарий» (6 numbers, always the same height). */
export function KeyMetrics({ baseline, scenario, hasScenario }: { baseline: Metrics; scenario: Metrics; hasScenario: boolean }) {
  const { t } = whatIfI18n.useT();
  const usd = (v: number | null) => (v == null ? "—" : fmtUsd(v, { signed: true, decimals: "auto" }));
  const items: KeyDef[] = [
    { id: "net", label: t("compare.metric.net"), term: "net", a: baseline.net, b: scenario.net, fmt: usd, delta: (d) => fmtUsd(d, { signed: true, decimals: "auto" }) },
    { id: "fees", label: t("compare.metric.fees"), term: "fees", a: baseline.fees, b: scenario.fees, fmt: (v) => (v == null ? "—" : fmtUsd(v, { decimals: 0 })), delta: (d) => fmtUsd(d, { signed: true, decimals: "auto" }), invert: true },
    { id: "trades", label: t("compare.metric.trades"), a: baseline.trades, b: scenario.trades, fmt: (v) => (v == null ? "—" : String(v)), delta: (d) => fmtNum(d, { decimals: 0, signed: true }) },
    { id: "winRate", label: t("compare.metric.winRate"), term: "winrate", a: baseline.winRate, b: scenario.winRate, fmt: (v) => fmtRate(v, 1), delta: pp },
    { id: "pf", label: t("compare.metric.pf"), term: "pf", a: baseline.profitFactor, b: scenario.profitFactor, fmt: fmtRatio, delta: (d) => fmtNum(d, { decimals: 2, signed: true }) },
    { id: "maxDd", label: t("compare.metric.maxDd"), term: "drawdown", a: baseline.maxDrawdown, b: scenario.maxDrawdown, fmt: usd, delta: (d) => fmtUsd(d, { signed: true, decimals: "auto" }) },
  ];
  return (
    <dl className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-2">
      {items.map((it) => {
        const d = hasScenario ? deltaOf(it.a, it.b) : null;
        const tone = toneFor(d, it.invert);
        return (
          <div key={it.id} className="flex min-w-0 flex-col gap-0.5 rounded-xl bg-[var(--glass-bg)] px-3 py-2.5">
            <dt className="flex items-center gap-1 text-xs text-muted-foreground">
              {it.term ? <TermTooltip term={it.term}>{it.label}</TermTooltip> : it.label}
            </dt>
            <dd className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 tabular-nums">
              <span className={cn("text-sm", hasScenario ? "text-muted-foreground" : "font-semibold text-foreground")}>{it.fmt(it.a)}</span>
              {hasScenario && (
                <>
                  <ArrowRight className="h-3 w-3 shrink-0 self-center text-muted-foreground" aria-label={t("compare.becameAria")} />
                  <span className="text-sm font-semibold text-foreground">{it.fmt(it.b)}</span>
                </>
              )}
            </dd>
            <span className={cn("min-h-4 text-xs tabular-nums", TONE_CLASS[tone])}>{d == null ? " " : Math.abs(d) < 1e-9 ? t("compare.noChange") : it.delta(d)}</span>
          </div>
        );
      })}
    </dl>
  );
}

type RowDef = { id: string; label: string; a: number | null; b: number | null; fmt: (v: number | null) => string; delta?: (d: number) => string; invert?: boolean; hint?: string };

/** Full side-by-side table (inside «Все показатели»). */
export function MetricsTable({ baseline, scenario, hasScenario }: { baseline: Metrics; scenario: Metrics; hasScenario: boolean }) {
  const { t } = whatIfI18n.useT();
  const usd = (v: number | null) => fmtUsd(v, { signed: true, decimals: "auto" });
  const rows: RowDef[] = [
    { id: "net", label: t("compare.metric.net"), a: baseline.net, b: scenario.net, fmt: usd, hint: t("compare.hint.net") },
    { id: "gross", label: t("compare.metric.gross"), a: baseline.gross, b: scenario.gross, fmt: usd },
    { id: "fees", label: t("compare.metric.fees"), a: baseline.fees, b: scenario.fees, fmt: (v) => (v == null ? "—" : fmtUsd(Math.abs(v))), invert: true },
    { id: "trades", label: t("compare.metric.trades"), a: baseline.trades, b: scenario.trades, fmt: (v) => (v == null ? "—" : String(v)), delta: (d) => fmtNum(d, { decimals: 0, signed: true }) },
    { id: "winRate", label: t("compare.metric.winRate"), a: baseline.winRate, b: scenario.winRate, fmt: (v) => fmtRate(v, 1), delta: pp, hint: t("compare.hint.winRate") },
    { id: "pf", label: t("compare.metric.profitFactor"), a: baseline.profitFactor, b: scenario.profitFactor, fmt: fmtRatio, delta: (d) => fmtNum(d, { decimals: 2, signed: true }), hint: t("compare.hint.profitFactor") },
    { id: "expectancy", label: t("compare.metric.expectancy"), a: baseline.expectancy, b: scenario.expectancy, fmt: usd },
    { id: "avgWin", label: t("compare.metric.avgWin"), a: baseline.avgWin, b: scenario.avgWin, fmt: usd },
    { id: "avgLoss", label: t("compare.metric.avgLoss"), a: baseline.avgLoss, b: scenario.avgLoss, fmt: usd },
    { id: "maxDd", label: t("compare.metric.maxDd"), a: baseline.maxDrawdown, b: scenario.maxDrawdown, fmt: usd, hint: t("compare.hint.maxDd") },
    { id: "worstDay", label: t("compare.metric.worstDay"), a: baseline.worstDay?.net ?? null, b: scenario.worstDay?.net ?? null, fmt: usd },
    { id: "bestDay", label: t("compare.metric.bestDay"), a: baseline.bestDay?.net ?? null, b: scenario.bestDay?.net ?? null, fmt: usd },
    { id: "lossStreak", label: t("compare.metric.lossStreak"), a: baseline.maxLossStreak, b: scenario.maxLossStreak, fmt: (v) => (v == null ? "—" : String(v)), delta: (d) => fmtNum(d, { decimals: 0, signed: true }), invert: true },
    { id: "days", label: t("compare.metric.days"), a: baseline.days, b: scenario.days, fmt: (v) => (v == null ? "—" : String(v)), delta: (d) => fmtNum(d, { decimals: 0, signed: true }) },
  ];
  return (
    <table className="w-full text-sm tabular-nums">
      <thead>
        <tr className="text-xs text-muted-foreground">
          <th className="py-1.5 text-left font-medium">{t("compare.colMetric")}</th>
          <th className="py-1.5 text-right font-medium">{hasScenario ? t("compare.colBefore") : t("compare.colValue")}</th>
          {hasScenario && <th className="py-1.5 text-right font-medium">{t("compare.colAfter")}</th>}
          {hasScenario && <th className="py-1.5 text-right font-medium">{t("compare.colDiff")}</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const d = hasScenario ? deltaOf(r.a, r.b) : null;
          const tone = toneFor(d, r.invert);
          return (
            <tr key={r.id} className="border-t border-border/50">
              <td className="py-1.5" title={r.hint}>{r.label}</td>
              <td className={cn("py-1.5 text-right", hasScenario ? "text-muted-foreground" : "font-medium")}>{r.fmt(r.a)}</td>
              {hasScenario && <td className="py-1.5 text-right font-medium">{r.fmt(r.b)}</td>}
              {hasScenario && <td className={cn("py-1.5 text-right", TONE_CLASS[tone])}>{d == null ? "—" : r.delta ? r.delta(d) : fmtUsd(d, { signed: true, decimals: "auto" })}</td>}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Bootstrap details in plain words (inside «Все показатели»). */
export function BootstrapDetails({ b }: { b: BootstrapSummary | null }) {
  const { t } = whatIfI18n.useT();
  if (!b) return <p className="text-sm text-muted-foreground">{t("compare.bootTooFew")}</p>;
  const u = (v: number) => fmtUsd(v, { signed: true, decimals: "auto" });
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="rounded-xl bg-[var(--glass-bg)] p-3">
          <p className="text-xs text-muted-foreground">{t("compare.diff")}</p>
          <p className={cn("text-lg font-semibold tabular-nums", TONE_CLASS[b.significant ? toneOf(b.diffTotal.mean) : "neutral"])}>{fmtUsd(b.diffTotal.mean, { signed: true, decimals: "auto" })}</p>
          <p className="text-xs text-muted-foreground tabular-nums">{t("compare.ciRange", { lo: u(b.diffTotal.lo), hi: u(b.diffTotal.hi) })}</p>
        </div>
        <div className="rounded-xl bg-[var(--glass-bg)] p-3">
          <p className="text-xs text-muted-foreground">{t("compare.perDay")}</p>
          <p className="text-sm tabular-nums"><span className="text-muted-foreground">{t("compare.was")} </span>{fmtUsd(b.dailyExpectancy.base.mean, { signed: true, decimals: "auto" })} <span className="text-xs text-muted-foreground">({fmtUsd(b.dailyExpectancy.base.lo, { signed: true, decimals: "auto" })} … {fmtUsd(b.dailyExpectancy.base.hi, { signed: true, decimals: "auto" })})</span></p>
          <p className="text-sm tabular-nums"><span className="text-muted-foreground">{t("compare.became")} </span>{fmtUsd(b.dailyExpectancy.scenario.mean, { signed: true, decimals: "auto" })} <span className="text-xs text-muted-foreground">({fmtUsd(b.dailyExpectancy.scenario.lo, { signed: true, decimals: "auto" })} … {fmtUsd(b.dailyExpectancy.scenario.hi, { signed: true, decimals: "auto" })})</span></p>
        </div>
        <div className="rounded-xl bg-[var(--glass-bg)] p-3">
          <p className="text-xs text-muted-foreground">{t("compare.month")}</p>
          <p className="text-sm tabular-nums">{t("compare.monthScenario", { median: u(b.month.p50), pct: Math.round(b.month.probPositive * 100) })}</p>
          <p className="text-xs text-muted-foreground tabular-nums">{t("compare.monthBase", { median: u(b.monthBase.p50), pct: Math.round(b.monthBase.probPositive * 100) })}</p>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t("compare.how", { iters: fmtCount(b.iters), days: b.days })}</p>
    </div>
  );
}

export function tradesHint(m: Metrics) {
  return whatIfI18n.t("compare.tradesDays", { trades: commonI18n.t("units.trades", { count: m.trades }), days: m.days });
}
