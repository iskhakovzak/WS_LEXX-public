/** Small presentational pieces for the playbook page. Token colours only. */
import * as React from "react";
import { EyeOff, type LucideIcon } from "lucide-react";
import { Pill, toneText, type Tone } from "@/components/ds";
import { cn } from "@/lib/utils";
import { setupTone, splitTags, moneyTone, usdEdge, type SetupSummary } from "./model";
import { fmtR, fmtRate, fmtUsd } from "@/lib/format";
import { winrateTone } from "@/components/playbook-sub/bits";
import { setupTypeLabel } from "@/i18n/ns/dataCodes";
import { commonI18n } from "@/i18n/ns/common";
import { playbookI18n } from "@/i18n/ns/playbook";

export function SetupTypePill({ type, className }: { type: string | null | undefined; className?: string }) {
  if (!type) return null;
  return <Pill tone={setupTone(type)} className={className}>{setupTypeLabel(type)}</Pill>;
}

export function confidenceTone(level: number): Tone {
  if (level >= 85) return "up";
  if (level >= 70) return "accent";
  if (level >= 50) return "warn";
  return "down";
}

/** "Уверенность 70%" as a slim meter + number. */
export function ConfidenceMeter({ level, className, showLabel }: { level: number | null; className?: string; showLabel?: boolean }) {
  const { t } = playbookI18n.useT();
  if (level == null) return null;
  const tone = confidenceTone(level);
  return (
    <span className={cn("inline-flex items-center gap-2 text-xs tabular-nums", className)} title={t("bits.confidenceTitle", { level })}>
      {showLabel && <span className="text-muted-foreground">{t("bits.confidence")}</span>}
      <span className="relative h-1.5 w-12 overflow-hidden rounded-full bg-[hsl(var(--border))]" aria-hidden="true">
        <span className={cn("absolute inset-y-0 left-0 rounded-full bg-current", toneText(tone))} style={{ width: `${Math.max(0, Math.min(100, level))}%` }} />
      </span>
      <span className={cn("font-semibold", toneText(tone))}>{level}%</span>
    </span>
  );
}

export function TagChips({ tags, max, onTagClick, active }: { tags?: string | null; max?: number; onTagClick?: (t: string) => void; active?: string[] }) {
  const chips = splitTags(tags);
  if (!chips.length) return null;
  const shown = max ? chips.slice(0, max) : chips;
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((tag) =>
        onTagClick ? (
          <button
            key={tag}
            type="button"
            aria-pressed={active?.includes(tag) ?? false}
            onClick={(e) => { e.stopPropagation(); onTagClick(tag); }}
            className="chip min-h-6 px-2 text-xs"
          >
            #{tag}
          </button>
        ) : (
          <span key={tag} className="rounded-full bg-[var(--glass-bg)] px-2 py-0.5 text-xs text-muted-foreground">#{tag}</span>
        ),
      )}
      {max && chips.length > max && <span className="px-1 text-xs text-muted-foreground">+{chips.length - max}</span>}
    </div>
  );
}

/** Compact edge line for list rows: "12 · 58% · +$42" ($ net per trade first; R only when there is no $). */
export function EdgeMini({ s, className }: { s: SetupSummary | undefined; className?: string }) {
  const { t } = playbookI18n.useT();
  if (!s || s.tradeCount === 0) return <span className={cn("text-xs text-muted-foreground", className)}>{t("bits.noTrades")}</span>;
  const wrTone = winrateTone(s.winrate ?? 0, s.tradeCount);
  const usd = usdEdge(s);
  const expTone: Tone = s.expectancy == null ? "neutral" : s.expectancy > 0 ? "up" : s.expectancy < 0 ? "down" : "neutral";
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs tabular-nums", className)}>
      <span className="text-muted-foreground" title={t("bits.tradesTitle")}>{s.tradeCount}</span>
      <span aria-hidden="true" className="text-muted-foreground">·</span>
      <span className={toneText(wrTone)} title="Win rate">{fmtRate(s.winrate)}</span>
      {usd != null ? (
        <>
          <span aria-hidden="true" className="text-muted-foreground">·</span>
          <span className={toneText(moneyTone(usd))} title={t("bits.expectancyNetTitle")}>{fmtUsd(usd, { signed: true, decimals: 0 })}</span>
        </>
      ) : s.expectancy != null ? (
        <>
          <span aria-hidden="true" className="text-muted-foreground">·</span>
          <span className={toneText(expTone)} title={t("bits.expectancyRTitle")}>{fmtR(s.expectancy)}</span>
        </>
      ) : null}
    </span>
  );
}

/** Highlights query matches inside text. */
export function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < text.length) {
    const j = lower.indexOf(ql, i);
    if (j < 0) { parts.push(text.slice(i)); break; }
    if (j > i) parts.push(text.slice(i, j));
    parts.push(<mark key={k++} className="rounded-sm bg-primary/20 px-0.5 text-foreground">{text.slice(j, j + q.length)}</mark>);
    i = j + q.length;
  }
  return <>{parts}</>;
}

/** Snippet of `text` around the first match of `query` (for search results). */
export function snippet(text: string | null | undefined, query: string, radius = 48): string | null {
  if (!text) return null;
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const idx = text.toLowerCase().indexOf(q);
  if (idx < 0) return null;
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + q.length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`;
}

/** Document section: tiny label + optional actions + body, inside an inner tile. */
export function DocSection({
  title, icon: Icon, actions, children, className, id,
}: {
  title: React.ReactNode; icon?: LucideIcon; actions?: React.ReactNode; children: React.ReactNode; className?: string; id?: string;
}) {
  return (
    <section id={id} className={cn("glass-panel rounded-2xl p-[var(--panel-p)]", className)}>
      <div className="mb-3 flex min-h-8 flex-wrap items-center justify-between gap-2">
        <h3 className="flex shrink-0 items-center gap-2 text-sm font-semibold text-foreground">
          {Icon && <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
          {title}
        </h3>
        {actions && <div className="flex min-w-0 flex-wrap items-center justify-end gap-1">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** Small inline "error + retry" line. */
export function InlineError({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="flex items-center gap-2 py-2 text-xs text-down">
      {text}
      {onRetry && <button type="button" onClick={onRetry} className="underline underline-offset-2 hover:opacity-80">{commonI18n.t("actions.retry")}</button>}
    </div>
  );
}

/** $-privacy (server-side, lib/playbookPrivacy.ts): someone else's trade — net / pnl / fees / qty come back null. */
export const redactedHint = () => playbookI18n.t("bits.redacted");
/** Same for aggregates built over several traders' trades. */
export const redactedAggHint = () => playbookI18n.t("bits.redactedAgg");
/**
 * @deprecated Frozen RU text kept only for components/trades/TradeDetailSheet.tsx (TRADES agent): use `redactedHint()`.
 */
export const REDACTED_HINT = "Суммы скрыты — сделка другого трейдера"; // i18n-ignore (deprecated, see redactedHint)

/** One muted caption per block (never per row) explaining why $ show as «—». `agg`: over several traders' trades. */
export function RedactedHint({ text, agg, className }: { text?: string; agg?: boolean; className?: string }) {
  const { t } = playbookI18n.useT();
  text ??= agg ? t("bits.redactedAgg") : t("bits.redacted");
  return (
    <p className={cn("flex items-center gap-1.5 text-xs text-muted-foreground", className)}>
      <EyeOff className="h-3 w-3 shrink-0" aria-hidden="true" />
      {text}
    </p>
  );
}
