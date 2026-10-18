import { Activity, Gauge, TrendingUp } from "lucide-react";
import { Panel, TermTooltip, type TermKey, type Tone } from "@/components/ds";
import { cn } from "@/lib/utils";
import type { Axis, Driver, Regime } from "./engine";
import { indicatorsI18n } from "@/i18n/ns/indicators";

/** Drivers whose label is a desk-glossary term get the shared explanation on hover/focus. */
const DRIVER_TERM: Partial<Record<string, TermKey>> = { vix: "vix", vixTerm: "vixTerm", vixChg5: "vix", rsp: "breadth", atr: "atr" };

const AXIS_ICON: Record<Axis, typeof Gauge> = { trend: TrendingUp, vol: Activity, risk: Gauge };

/** Tone of a driver/axis: trend & risk read bullish = up; volatility reads "more" = warn. */
function impactTone(axis: Axis, v: number): Tone {
  if (Math.abs(v) < 0.15) return "neutral";
  if (axis === "vol") return v > 0 ? "warn" : "accent";
  return v > 0 ? "up" : "down";
}
const BAR_BG: Record<Tone, string> = { up: "bg-up", down: "bg-down", warn: "bg-warn", accent: "bg-primary", purple: "bg-purple", neutral: "bg-foreground/40" };
const TEXT: Record<Tone, string> = { up: "text-up", down: "text-down", warn: "text-warn", accent: "text-accent-soft", purple: "text-purple", neutral: "text-foreground" };

function ImpactBar({ axis, v, className }: { axis: Axis; v: number; className?: string }) {
  const t = impactTone(axis, v);
  const w = Math.min(50, Math.abs(v) * 50);
  return (
    <span className={cn("relative block h-1.5 rounded-full bg-[var(--glass-hover-bg)]", className)} aria-hidden="true">
      <span className="absolute inset-y-0 left-1/2 w-px bg-border" />
      <span className={cn("absolute inset-y-0 rounded-full", BAR_BG[t])} style={v >= 0 ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }} />
    </span>
  );
}

function AxisBlock({ axis, label, score, keyName, drivers }: { axis: Axis; label: string; score: number; keyName: string; drivers: Driver[] }) {
  const { t: tt } = indicatorsI18n.useT();
  const Icon = AXIS_ICON[axis];
  const title = tt(`regime.axis.${axis}`);
  const t = impactTone(axis, score);
  const meaning = indicatorsI18n.tryT(`regime.meaning.${axis}.${keyName}`) ?? "";
  return (
    <div className="tile flex min-w-0 flex-col gap-2.5 p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {title}
      </div>
      <div className={cn("text-base font-semibold leading-tight", TEXT[t])}>{label}</div>
      <p className="text-xs leading-snug text-muted-foreground">{meaning}</p>
      <ul className="mt-auto flex flex-col gap-1.5 border-t border-border/50 pt-2.5" aria-label={tt("regime.drivers", { axis: title })}>
        {drivers.map((d) => (
          <li key={d.id} className="flex flex-col gap-1 text-xs">
            {/* Label and reading share a line when they fit; a long reading («20.0 · 81-й перцентиль») drops under the label instead of squeezing it. */}
            <span className="flex flex-wrap items-baseline justify-between gap-x-2">
              <span className="min-w-0 leading-snug text-muted-foreground">
                {DRIVER_TERM[d.id] ? <TermTooltip term={DRIVER_TERM[d.id]!} className="text-left">{d.label}</TermTooltip> : d.label}
              </span>
              <span className="ml-auto whitespace-nowrap font-medium tabular-nums">{d.reading}</span>
            </span>
            <ImpactBar axis={axis} v={d.impact} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RegimePanel({ regime, asOf }: { regime: Regime; asOf: string }) {
  const { t } = indicatorsI18n.useT();
  const by = (a: Axis) => regime.drivers.filter((d) => d.axis === a).sort((x, y) => Math.abs(y.impact * y.weight) - Math.abs(x.impact * x.weight));
  return (
    <Panel title={t("regime.title")} description={asOf} icon={Gauge} fill>
      <p className="mb-3 text-xl font-semibold leading-tight tracking-tight">{regime.headline}</p>
      <div className="grid gap-[var(--grid-gap)] md:grid-cols-3">
        <AxisBlock axis="trend" label={regime.trend.label} score={regime.trend.score} keyName={regime.trend.key} drivers={by("trend")} />
        <AxisBlock axis="vol" label={regime.vol.label} score={regime.vol.score} keyName={regime.vol.key} drivers={by("vol")} />
        <AxisBlock axis="risk" label={regime.risk.label} score={regime.risk.score} keyName={regime.risk.key} drivers={by("risk")} />
      </div>
      <p className="mt-3 text-xs text-muted-foreground">{t("regime.footnote")}</p>
    </Panel>
  );
}
