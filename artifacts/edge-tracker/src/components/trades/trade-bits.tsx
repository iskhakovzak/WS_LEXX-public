
import { ArrowDownRight, ArrowUpRight, Check, ChevronDown, Database } from "lucide-react";
import { Pill, toneOf, toneText } from "@/components/ds";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { Trade } from "@workspace/api-client-react";
import { HORIZON_LABEL, RESULTS, RESULT_LABEL, isBrokerTrade, netPnl, resultKey, resultTone, splitTags, type Horizon } from "./trade-utils";
import { fmtR, fmtRelative, fmtUsd } from "@/lib/format";
import { tradesI18n } from "@/i18n/ns/trades";
import { commonI18n } from "@/i18n/ns/common";

export function SidePill({ side, compact }: { side?: string | null; compact?: boolean }) {
  const { t } = tradesI18n.useT();
  const { t: tc } = commonI18n.useT();
  if (!side) return <span className="text-muted-foreground">—</span>;
  const isLong = side === "Long";
  const Icon = isLong ? ArrowUpRight : ArrowDownRight;
  return (
    // Direction is not a result: neutral tone, the arrow carries the meaning (design audit).
    <Pill tone="neutral" className={compact ? "px-1.5" : undefined}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {compact ? t(isLong ? "bits.longShort.long" : "bits.longShort.short") : isLong ? tc("trading.long") : side === "Short" ? tc("trading.short") : side}
      {compact && <span className="sr-only">{side}</span>}
    </Pill>
  );
}

export function ResultPill({ result, className }: { result: string; className?: string }) {
  const k = resultKey(result);
  return (
    <Pill tone={resultTone(result)} dot className={className}>
      {RESULT_LABEL[k] ?? result}
    </Pill>
  );
}

/** Result pill that opens a menu to change the result in place. */
export function ResultMenu({
  result,
  onChange,
  disabled,
  ticker,
}: {
  result: string;
  onChange: (r: string) => void;
  disabled?: boolean;
  ticker: string;
}) {
  const { t } = tradesI18n.useT();
  if (disabled) return <ResultPill result={result} />;
  const cur = resultKey(result);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          aria-label={t("bits.resultMenu", { ticker, result: RESULT_LABEL[cur] })}
          className="group inline-flex items-center gap-0.5 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ResultPill result={result} />
          <ChevronDown className="h-3 w-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" onClick={(e) => e.stopPropagation()}>
        {RESULTS.map((r) => (
          <DropdownMenuItem key={r} onSelect={() => r !== cur && onChange(r)} className="gap-2">
            <ResultPill result={r} />
            {r === cur && <Check className="ml-auto h-3.5 w-3.5 text-primary" aria-hidden="true" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TagChips({ tags, max = 2, className }: { tags?: string | null; max?: number; className?: string }) {
  const { t } = tradesI18n.useT();
  const chips = splitTags(tags);
  if (!chips.length) return null;
  const hidden = chips.length - max;
  return (
    <div className={cn("flex flex-wrap gap-1", className)} title={hidden > 0 ? chips.join(", ") : undefined}>
      {chips.slice(0, max).map((tag) => (
        <span key={tag} className="whitespace-nowrap rounded-full bg-primary/10 px-2 py-px text-2xs font-medium text-primary">
          {tag}
        </span>
      ))}
      {hidden > 0 && (
        <span className="whitespace-nowrap rounded-full border border-border px-1.5 py-px text-2xs text-muted-foreground">
          +{hidden}
          <span className="sr-only"> {t("bits.moreTags", { tags: chips.slice(max).join(", ") })}</span>
        </span>
      )}
    </div>
  );
}

/** R value with a centred bar (left = loss, right = gain), scaled to `maxAbs`. */
export function RBar({ r, derived, maxAbs }: { r: number | null; derived?: boolean; maxAbs: number }) {
  const { t } = tradesI18n.useT();
  if (r == null) return <span className="text-muted-foreground">—</span>;
  const pct = Math.min(1, Math.abs(r) / Math.max(maxAbs, 0.5)) * 50;
  const tone = toneOf(r);
  return (
    <div className="flex items-center gap-2" title={derived ? t("bits.derivedR") : undefined}>
      <div className="relative hidden h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-[var(--glass-bg)] lg:block" aria-hidden="true">
        <span className="absolute inset-y-0 left-1/2 w-px bg-border" />
        <span
          className={cn("absolute inset-y-0 rounded-full", r >= 0 ? "bg-up" : "bg-down")}
          style={r >= 0 ? { left: "50%", width: `${pct}%` } : { right: "50%", width: `${pct}%` }}
        />
      </div>
      <span className={cn("font-medium tabular-nums", toneText(tone))}>
        {derived && <span className="text-muted-foreground">≈</span>}
        {fmtR(r, 1)}
      </span>
    </div>
  );
}

export function ConvictionDots({ value }: { value: number | null | undefined }) {
  const { t } = tradesI18n.useT();
  if (value == null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center gap-1" aria-label={t("bits.conviction", { value })}>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className={cn("h-1.5 w-3 rounded-full", i < value ? "bg-primary" : "bg-[var(--glass-bg)] border border-border")} />
      ))}
      <span className="ml-1 tabular-nums text-xs text-muted-foreground">{value}/5</span>
    </span>
  );
}

/** Horizon pill; intraday is the default and is hidden unless `showIntraday`. */
export function HorizonPill({ horizon, showIntraday }: { horizon: Horizon; showIntraday?: boolean }) {
  if (horizon === "intraday" && !showIntraday) return null;
  return (
    <Pill tone={horizon === "swing" ? "purple" : horizon === "overnight" ? "warn" : "neutral"} className="px-1.5 text-2xs">
      {HORIZON_LABEL[horizon]}
    </Pill>
  );
}

/** Net P&L (gross − |fees|, shared formula) with the gross/fees breakdown in the tooltip. */
export function NetPnl({ trade, className }: { trade: Trade; className?: string }) {
  const { t } = tradesI18n.useT();
  const net = netPnl(trade);
  const title = trade.pnl != null && trade.fees
    ? t("bits.pnlTitle", { gross: fmtUsd(trade.pnl, { signed: true, decimals: "auto" }), fees: fmtUsd(-Math.abs(trade.fees), { signed: true, decimals: "auto" }), net: fmtUsd(net, { signed: true, decimals: "auto" }) })
    : undefined;
  return (
    <span title={title} className={cn("tabular-nums", net == null ? "text-muted-foreground" : toneText(toneOf(net)), className)}>
      {fmtUsd(net, { signed: true, decimals: "auto" })}
    </span>
  );
}

/** «5 минут назад» (current language) for broker-sourced trades. */
export function syncedAgo(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return fmtRelative(Math.min(t, now), { now });
}

/** Source badge: shown only for broker-sourced (PropReports) trades. */
export function SourceBadge({ trade, withSync, className }: { trade: Pick<Trade, "source" | "syncedAt" | "brokerAccount">; withSync?: boolean; className?: string }) {
  const { t } = tradesI18n.useT();
  if (!isBrokerTrade(trade)) return null;
  const ago = syncedAgo(trade.syncedAt);
  const title = [
    t("bits.sourceTitle"),
    trade.brokerAccount ? t("bits.accountTitle", { account: trade.brokerAccount }) : null,
    ago ? t("bits.syncedTitle", { ago }) : null,
  ].filter(Boolean).join("\n");
  return (
    <span className={cn("inline-flex items-center gap-1", className)} title={title}>
      <Pill tone="accent" className="px-1.5 text-2xs">
        <Database className="h-3 w-3" aria-hidden="true" />
        PropReports
      </Pill>
      {withSync && ago && <span className="text-2xs text-muted-foreground">{t("bits.synced", { ago })}</span>}
    </span>
  );
}

/** Gross / fees / net in one compact row (for the detail sheet). */
export function PnlBreakdown({ trade, className }: { trade: Trade; className?: string }) {
  const { t: tc } = commonI18n.useT();
  const net = netPnl(trade);
  if (trade.pnl == null) return <span className={cn("text-muted-foreground", className)}>—</span>;
  return (
    <span className={cn("inline-flex items-center gap-2 tabular-nums text-xs", className)}>
      <span title={tc("trading.gross")}>{fmtUsd(trade.pnl, { signed: true, decimals: "auto" })}</span>
      <span className="text-muted-foreground">−</span>
      <span className="text-muted-foreground" title={tc("trading.fees")}>{fmtUsd(Math.abs(trade.fees ?? 0), { signed: true, decimals: "auto" }).replace(/^[+−]/, "")}</span>
      <span className="text-muted-foreground">=</span>
      <span className={cn("font-semibold", net == null ? "text-muted-foreground" : toneText(toneOf(net)))} title={tc("trading.net")}>{fmtUsd(net, { signed: true, decimals: "auto" })}</span>
    </span>
  );
}
