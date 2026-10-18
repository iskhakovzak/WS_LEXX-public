import { useMemo } from "react";
import { Info, ShieldCheck, TrendingDown, TrendingUp } from "lucide-react";
import { EmptyState, Panel, Pill, Segmented, usePersistentState } from "@/components/ds";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { MIN_DAYS, type BucketStats, type Dimension, type IndicatorDef } from "./engine";
import { toneOfMoney, usd } from "./format";
import { fmtRate } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { indicatorsI18n } from "@/i18n/ns/indicators";

export type DimResult = { dim: Pick<Dimension, "id" | "label" | "explain" | "when">; buckets: BucketStats[]; today: string | null; todayNote?: string };

type View = "indicator" | "pre" | "day";

export function reliability(b: BucketStats): { label: string; tone: "up" | "neutral" | "warn" } | null {
  if (b.days < MIN_DAYS) return { label: indicatorsI18n.t("edge.unreliable"), tone: "warn" };
  if (b.t != null && Math.abs(b.t) >= 2) return { label: indicatorsI18n.t("edge.solid"), tone: "up" };
  return null;
}

/** Diverging bar: net per day, centred at zero, scaled to `max`. */
export function NetBar({ v, max, dim }: { v: number; max: number; dim?: boolean }) {
  const w = max > 0 ? Math.min(50, (Math.abs(v) / max) * 50) : 0;
  return (
    <span className={cn("relative block h-2 w-full rounded-full bg-[var(--glass-hover-bg)]", dim && "opacity-50")} aria-hidden="true">
      <span className="absolute inset-y-0 left-1/2 w-px bg-border" />
      <span
        className={cn("absolute inset-y-0 rounded-full", v >= 0 ? "bg-up" : "bg-down")}
        style={v >= 0 ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }}
      />
    </span>
  );
}

function DimHeader({ r }: { r: DimResult }) {
  const { t } = indicatorsI18n.useT();
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <h3 className="truncate text-sm font-medium text-foreground">{r.dim.label}</h3>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" aria-label={t("edge.howCounted", { label: r.dim.label })} className="inline-grid h-5 w-5 shrink-0 place-items-center rounded-full text-muted-foreground hover:text-foreground">
            <Info className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top"><span className="block max-w-[18rem] text-xs">{r.dim.explain}</span></TooltipContent>
      </Tooltip>
    </div>
  );
}

function DimTable({ r, max }: { r: DimResult; max: number }) {
  const { t } = indicatorsI18n.useT();
  return (
    <div className="flex flex-col gap-1.5">
      <DimHeader r={r} />
      <div role="table" aria-label={r.dim.label} className="flex flex-col">
        <div role="row" className="grid grid-cols-[minmax(0,1.5fr)_3.5rem_minmax(5rem,1.2fr)_5rem_3.5rem_4.5rem] items-center gap-3 px-2 pb-1 text-xs text-muted-foreground">
          <span role="columnheader">{t("edge.colCondition")}</span>
          <span role="columnheader" className="text-right">{t("edge.colDays")}</span>
          <span role="columnheader" className="text-center">{t("edge.colNetPerDay")}</span>
          <span role="columnheader" className="text-right">{t("edge.colPerDay")}</span>
          <span role="columnheader" className="text-right">WR</span>
          <span role="columnheader" className="text-right">{t("edge.colPerTrade")}</span>
        </div>
        {r.buckets.map((b) => {
          const rel = reliability(b);
          const isToday = r.today === b.id;
          const small = b.days < MIN_DAYS;
          return (
            <div
              key={b.id}
              role="row"
              className={cn(
                "grid grid-cols-[minmax(0,1.5fr)_3.5rem_minmax(5rem,1.2fr)_5rem_3.5rem_4.5rem] items-center gap-3 rounded-lg px-2 py-1.5 text-sm tabular-nums",
                isToday ? "bg-primary/10" : "hover:bg-[var(--tile-hover-bg)]",
              )}
            >
              <span role="cell" className="flex min-w-0 items-center gap-1.5">
                <span className={cn("truncate", small && "text-muted-foreground")}>{b.label}</span>
                {isToday && <Pill tone="accent" className="shrink-0" title={r.todayNote}>{t("edge.today")}</Pill>}
                {rel && <Pill tone={rel.tone} className="shrink-0">{rel.tone === "up" && <ShieldCheck className="h-3 w-3" aria-hidden="true" />}{rel.label}</Pill>}
              </span>
              <span role="cell" className="text-right text-muted-foreground">{b.days}</span>
              <span role="cell">{b.days ? <NetBar v={b.netPerDay} max={max} dim={small} /> : null}</span>
              <span role="cell" className={cn("text-right font-medium", b.days ? toneText(b.netPerDay) : "text-muted-foreground")}>{b.days ? usd(b.netPerDay) : "—"}</span>
              <span role="cell" className="text-right text-muted-foreground">{fmtRate(b.winRate)}</span>
              <span role="cell" className="text-right text-muted-foreground">{b.perTrade != null ? usd(b.perTrade) : "—"}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
const toneText = (v: number) => ({ up: "text-up", down: "text-down", neutral: "text-foreground" } as const)[toneOfMoney(v) as "up" | "down" | "neutral"];

type Finding = { r: DimResult; b: BucketStats; diff: number };

/** Best / worst conditions vs the trader's average day (only buckets with enough sessions). */
export function findings(results: DimResult[], base: number): { good: Finding[]; bad: Finding[] } {
  const all: Finding[] = [];
  for (const r of results) for (const b of r.buckets) if (b.days >= MIN_DAYS) all.push({ r, b, diff: b.netPerDay - base });
  const sorted = [...all].sort((a, b) => b.diff - a.diff);
  return {
    good: sorted.filter((f) => f.diff > 0 && f.b.netPerDay > 0).slice(0, 2),
    bad: [...sorted].reverse().filter((f) => f.diff < 0 && f.b.netPerDay < 0).slice(0, 2),
  };
}

function FindingRow({ f, kind }: { f: Finding; kind: "good" | "bad" }) {
  const { t } = indicatorsI18n.useT();
  const rel = t(f.b.t != null && Math.abs(f.b.t) >= 2 ? "edge.solid" : f.b.t != null && Math.abs(f.b.t) >= 1 ? "edge.likely" : "edge.random");
  const Icon = kind === "good" ? TrendingUp : TrendingDown;
  return (
    <li className="tile flex min-w-0 items-start gap-2.5 p-3">
      <span className={cn("mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full", kind === "good" ? "bg-up/15 text-up" : "bg-down/15 text-down")}>
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <p className="text-sm">
          <span className="text-muted-foreground">{f.r.dim.label}: </span>
          <span className="font-medium">{f.b.label}</span>
        </p>
        <p className="text-xs text-muted-foreground tabular-nums">
          <span className={cn("font-medium", kind === "good" ? "text-up" : "text-down")}>{t("edge.perDay", { value: usd(f.b.netPerDay) })}</span>
          {" · "}{commonI18n.t("units.days", { count: f.b.days })} · WR {fmtRate(f.b.winRate)} · {rel}
        </p>
      </div>
    </li>
  );
}

export function EdgeByRegime({
  focusDef, focusResult, pre, day, base, totalDays, totalTrades,
}: {
  focusDef: IndicatorDef;
  focusResult: DimResult | null;
  pre: DimResult[];
  day: DimResult[];
  base: BucketStats;
  totalDays: number;
  totalTrades: number;
}) {
  const { t } = indicatorsI18n.useT();
  const [view, setView] = usePersistentState<View>("indicators.edge.view", "pre");
  const shown: DimResult[] = view === "indicator" ? (focusResult ? [focusResult] : []) : view === "pre" ? pre : day;
  const max = useMemo(() => Math.max(1, ...shown.flatMap((r) => r.buckets.filter((b) => b.days).map((b) => Math.abs(b.netPerDay)))), [shown]);
  const { good, bad } = useMemo(() => findings([...pre, ...day, ...(focusResult ? [focusResult] : [])], base.netPerDay), [pre, day, focusResult, base.netPerDay]);

  return (
    <Panel
      title={t("edge.title")}
      description={t("edge.description", {
        days: commonI18n.t("units.days", { count: totalDays }),
        trades: commonI18n.t("units.trades", { count: totalTrades }),
        avg: usd(base.netPerDay),
      })}
      actions={
        <Segmented
          size="sm"
          ariaLabel={t("edge.viewAria")}
          value={view}
          onChange={setView}
          options={[
            { value: "pre", label: t("edge.viewPre") },
            { value: "day", label: t("edge.viewDay") },
            { value: "indicator", label: focusDef.label },
          ]}
        />
      }
      fill
    >
      {(good.length > 0 || bad.length > 0) && (
        <div className="mb-4 grid gap-[var(--grid-gap)] md:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-2">
            <p className="text-xs font-medium text-muted-foreground">{t("edge.goodTitle")}</p>
            {good.length ? <ul className="flex flex-col gap-2">{good.map((f) => <FindingRow key={`${f.r.dim.id}-${f.b.id}`} f={f} kind="good" />)}</ul> : <p className="text-xs text-muted-foreground">{t("edge.goodEmpty")}</p>}
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <p className="text-xs font-medium text-muted-foreground">{t("edge.badTitle")}</p>
            {bad.length ? <ul className="flex flex-col gap-2">{bad.map((f) => <FindingRow key={`${f.r.dim.id}-${f.b.id}`} f={f} kind="bad" />)}</ul> : <p className="text-xs text-muted-foreground">{t("edge.badEmpty")}</p>}
          </div>
        </div>
      )}

      <p className="mb-3 text-xs text-muted-foreground">
        {view === "pre" && t("edge.hintPre")}
        {view === "day" && t("edge.hintDay")}
        {view === "indicator" && t("edge.hintIndicator", { label: focusDef.label })}
      </p>

      {shown.length === 0 ? (
        <EmptyState compact icon={Info} title={t("edge.fewTitle")} description={t("edge.fewText", { count: MIN_DAYS * 3, label: focusDef.label })} />
      ) : (
        <div className="flex flex-col gap-5">
          {shown.map((r) => <DimTable key={r.dim.id} r={r} max={max} />)}
        </div>
      )}
    </Panel>
  );
}
