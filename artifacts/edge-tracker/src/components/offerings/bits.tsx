import { Briefcase, Eye } from "lucide-react";
import { Pill, toneText, type Tone } from "@/components/ds";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  DEAL_TYPE_HINT, DEAL_TYPE_LABEL, DEAL_TYPE_TONE, SCORE_LEVEL_LABEL, SCORE_LEVEL_TONE,
  dealTypeOf, dilutionScore, type DilutionScore,
} from "./score";
import { HORIZON_LABEL, type Exposure, type Offering } from "./types";
import { fmtPct, fmtPrice } from "@/lib/format";
import { offeringsI18n } from "@/i18n/ns/offerings";

export const BAR_FILL: Record<Tone, string> = {
  up: "bg-up",
  down: "bg-down",
  warn: "bg-[hsl(var(--chart-3))]",
  accent: "bg-primary",
  purple: "bg-[hsl(var(--chart-5))]",
  neutral: "bg-muted-foreground/60",
};

/** Thin horizontal bar, value clamped to [0, max]. */
export function MiniBar({ value, max = 100, tone = "accent", className, label }: { value: number | null | undefined; max?: number; tone?: Tone; className?: string; label?: string }) {
  const pct = value == null || !Number.isFinite(value) ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-[var(--glass-bg)]", className)} role="img" aria-label={label ?? `${Math.round(pct)}%`}>
      <div className={cn("h-full rounded-full transition-[width] duration-[var(--dur-2)] motion-reduce:transition-none", BAR_FILL[tone])} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Tone for "size as % of market cap". */
export function pctTone(p: number | null | undefined): Tone {
  if (p == null) return "neutral";
  if (p > 20) return "down";
  if (p > 7) return "warn";
  return "neutral";
}

/** Signed percent coloured by sign (gap, move of the day). */
export function SignedPct({ value, digits = 1, className }: { value: number | null | undefined; digits?: number; className?: string }) {
  if (value == null || !Number.isFinite(value)) return <span className={cn("text-muted-foreground", className)}>—</span>;
  return <span className={cn("tabular-nums", value > 0 ? "text-up" : value < 0 ? "text-down" : "text-muted-foreground", className)}>{fmtPct(value, digits)}</span>;
}

export function DealTypePill({ o, className }: { o: Offering; className?: string }) {
  const t = dealTypeOf(o);
  return (
    <span title={DEAL_TYPE_HINT[t]} className={className}>
      <Pill tone={DEAL_TYPE_TONE[t]} className="px-1.5 text-2xs">{DEAL_TYPE_LABEL[t]}</Pill>
    </span>
  );
}

/** Score parts as rows with bars: used in the tooltip and in the detail sheet. */
export function ScoreBreakdown({ s, className }: { s: DilutionScore; className?: string }) {
  const { t } = offeringsI18n.useT();
  return (
    <div className={cn("space-y-1.5", className)}>
      {s.parts.map((p) => (
        <div key={p.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5">
          <span className="truncate text-xs text-foreground">{p.label}</span>
          <span className="text-xs font-medium tabular-nums text-foreground">{p.points}<span className="text-muted-foreground">/{p.max}</span></span>
          <span className="col-span-2 flex items-center gap-2">
            <MiniBar value={p.points} max={p.max} tone={p.points / p.max >= 0.66 ? "down" : p.points / p.max >= 0.4 ? "warn" : "neutral"} className="w-16 shrink-0" label={t("bits.ofMax", { value: p.points, max: p.max })} />
            <span className="min-w-0 truncate text-2xs text-muted-foreground" title={p.detail}>{p.detail}</span>
          </span>
        </div>
      ))}
      {s.missing.length > 0 && (
        <p className="pt-0.5 text-2xs text-muted-foreground">{t("bits.missing", { list: s.missing.join(", ").toLowerCase() })}</p>
      )}
    </div>
  );
}

/**
 * Dilution score chip (0–100) with the breakdown on hover/focus. Keyboard-accessible: the trigger is a button.
 */
export function ScoreBadge({ o, s: given, className }: { o: Offering; s?: DilutionScore; className?: string }) {
  const { t } = offeringsI18n.useT();
  const s = given ?? dilutionScore(o);
  const tone = SCORE_LEVEL_TONE[s.level];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          aria-label={t("bits.scoreAria", { score: s.score, level: SCORE_LEVEL_LABEL[s.level].toLowerCase() })}
          className={cn("inline-flex w-[4.5rem] cursor-help flex-col gap-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}
        >
          <span className={cn("text-sm font-semibold leading-none tabular-nums", toneText(tone))}>
            {s.score}{s.rough && <span className="text-2xs font-normal text-muted-foreground"> ≈</span>}
          </span>
          <MiniBar value={s.score} tone={tone} label={t("bits.ofMax", { value: s.score, max: 100 })} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="w-72 max-w-[18rem] p-3">
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <span className="text-xs font-semibold text-foreground">{t("bits.scoreTitle")}</span>
          <span className={cn("text-sm font-semibold tabular-nums", toneText(tone))}>{s.score}/100 · {SCORE_LEVEL_LABEL[s.level].toLowerCase()}</span>
        </div>
        <ScoreBreakdown s={s} />
        <p className="mt-2 border-t border-[var(--glass-border)] pt-2 text-2xs text-muted-foreground">
          {t("bits.scoreSum")}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

/** Visual scale with offer and current price markers (detail sheet). */
export function OfferGauge({ o }: { o: Offering }) {
  const { t } = offeringsI18n.useT();
  if (o.offerPrice == null || o.currentPrice == null) return null;
  const lo = Math.min(o.offerPrice, o.currentPrice, o.prevClose ?? Infinity) * 0.95;
  const hi = Math.max(o.offerPrice, o.currentPrice, o.prevClose ?? -Infinity) * 1.05;
  const pos = (v: number) => ((v - lo) / (hi - lo || 1)) * 100;
  const above = o.currentPrice >= o.offerPrice;
  const a = pos(Math.min(o.offerPrice, o.currentPrice));
  const b = pos(Math.max(o.offerPrice, o.currentPrice));
  return (
    <div className="space-y-2" aria-label={t("bits.gaugeAria", { price: fmtPrice(o.currentPrice, { dollar: true }), offer: fmtPrice(o.offerPrice, { dollar: true }) })} role="img">
      <div className="relative h-2 rounded-full bg-[var(--glass-bg)]">
        <div className={cn("absolute inset-y-0 rounded-full", above ? "bg-up/40" : "bg-down/40")} style={{ left: `${a}%`, width: `${Math.max(1, b - a)}%` }} />
        {o.prevClose != null && <span className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-muted-foreground/60" style={{ left: `${pos(o.prevClose)}%` }} title={t("bits.closeBefore")} />}
        <span className="absolute top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-muted-foreground" style={{ left: `${pos(o.offerPrice)}%` }} />
        <span className={cn("absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background", above ? "bg-up" : "bg-down")} style={{ left: `${pos(o.currentPrice)}%` }} />
      </div>
      <div className="flex justify-between gap-2 text-xs tabular-nums text-muted-foreground">
        <span>{o.prevClose != null
          ? t("bits.offerClose", { price: fmtPrice(o.offerPrice, { dollar: true }), close: fmtPrice(o.prevClose, { dollar: true }) })
          : t("bits.offer", { price: fmtPrice(o.offerPrice, { dollar: true }) })}</span>
        <span className={above ? "text-up" : "text-down"}>{t("bits.now", { price: fmtPrice(o.currentPrice, { dollar: true }), pct: fmtPct(o.priceChangePct, 1) })}</span>
      </div>
    </div>
  );
}

/** "В позиции" / "В вотчлисте" marker. */
export function ExposureBadge({ e, className, compact }: { e: Exposure | undefined; className?: string; compact?: boolean }) {
  const { t } = offeringsI18n.useT();
  if (!e || (!e.held.length && !e.watched)) return null;
  if (e.held.length) {
    const horizons = Array.from(new Set(e.held.map((h) => HORIZON_LABEL[h.horizon ?? "intraday"] ?? HORIZON_LABEL.intraday)));
    return (
      <span className={className} title={t("bits.positionsTitle", { count: e.held.length, horizons: horizons.join(", ") })}>
        <Pill tone="down" className="px-1.5 text-2xs">
          <Briefcase className="h-3 w-3" aria-hidden="true" />
          {compact ? <span className="sr-only">{t("bits.inPosition")}</span> : t("bits.inPosition")}
        </Pill>
      </span>
    );
  }
  return (
    <span className={className} title={t("bits.myWatchlist")}>
      <Pill tone="accent" className="px-1.5 text-2xs">
        <Eye className="h-3 w-3" aria-hidden="true" />
        {compact ? <span className="sr-only">{t("bits.inWatchlist")}</span> : t("bits.watchlist")}
      </Pill>
    </span>
  );
}
