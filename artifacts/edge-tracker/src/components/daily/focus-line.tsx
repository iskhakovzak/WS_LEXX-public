import { Link } from "wouter";
import { CheckCircle2, ChevronRight, Crosshair } from "lucide-react";
import { Pill } from "@/components/ds";
import { mistakeLabel, parseMistake } from "@/components/shared/mistake-labels";
import type { DailyFocus, TradeRef } from "@/lib/daily/types";
import { links } from "@/lib/links";
import { fmtDate, fmtUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { dailyI18n } from "@/i18n/ns/daily";

/** «14 окт» without the abbreviation dot (dense captions). */
export function dayShort(ymd: string): string {
  return fmtDate(ymd.slice(0, 10), "dayMonth").replace(".", "");
}

/** Trade chips → the trade sheet. Never shows another trader's money: these are always the viewer's own trades. */
export function TradeChips({ trades, max = 3, className }: { trades: TradeRef[]; max?: number; className?: string }) {
  const { t } = dailyI18n.useT();
  if (trades.length === 0) return null;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1.5", className)}>
      {trades.slice(0, max).map((x) => (
        <Link
          key={x.tradeId}
          href={links.trade(x.tradeId)}
          aria-label={t("focus.exampleAria", { ticker: x.ticker, date: dayShort(x.date) })}
          className="chip inline-flex min-h-7 items-center gap-1 px-2.5 text-xs font-medium tabular-nums"
        >
          {x.ticker}
          {x.net != null && <span className={x.net < 0 ? "text-down" : "text-up"}>{fmtUsd(x.net, { signed: true, decimals: 0 })}</span>}
        </Link>
      ))}
      {trades.length > max && <span className="text-xs text-muted-foreground">+{trades.length - max}</span>}
    </span>
  );
}

/** Where «Примеры» leads when the focus carries no trade refs: the behaviour page for patterns, else the trades list. */
function examplesHref(f: DailyFocus): string {
  const { group } = parseMistake(f.mistake ?? "");
  return group === "behavior" ? links.behavior({ trader: f.trader, from: f.window.from, to: f.window.to }) : links.trades({ from: f.window.from, to: f.window.to });
}

/**
 * Morning focus: the costliest repeating mistake of the last two weeks, in one line — what, how much, how often, and
 * where to see it. «none» is good news, said in one short line.
 */
export function FocusLine({ focus, compact }: { focus: DailyFocus; compact?: boolean }) {
  const { t } = dailyI18n.useT();
  if (focus.source === "none" || !focus.mistake) {
    return (
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-up/15 text-up">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <div className="micro-label">{t("focus.title")}</div>
          <p className="text-sm font-semibold leading-5">{t("focus.none")}</p>
          {!compact && <p className="text-xs text-muted-foreground">{t("focus.noneHint")}</p>}
        </div>
      </div>
    );
  }
  // The contract may carry trade refs later (top examples); use them when present.
  const examples = (focus as DailyFocus & { examples?: TradeRef[] }).examples ?? [];
  const stats = [
    focus.costNet != null ? t("focus.cost", { cost: fmtUsd(focus.costNet, { signed: true, decimals: 0 }) }) : null,
    focus.count > 0 ? t("focus.times", { count: focus.count }) : null,
  ].filter(Boolean);
  return (
    <div className="flex min-w-0 items-start gap-3">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-warn/15 text-warn">
        <Crosshair className="h-4 w-4" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="micro-label">{t("focus.title")}</span>
          {focus.source === "curator" && <Pill tone="purple">{t("focus.fromCurator")}</Pill>}
        </div>
        <p className="text-base font-semibold leading-6 [overflow-wrap:anywhere]">{mistakeLabel(focus.mistake)}</p>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {stats.length > 0 && (
            <span className="tabular-nums" title={t("focus.window", { from: dayShort(focus.window.from), to: dayShort(focus.window.to) })}>
              {stats.join(" · ")}
            </span>
          )}
          {examples.length > 0 ? (
            <TradeChips trades={examples} />
          ) : (
            <Link href={examplesHref(focus)} className="inline-flex items-center gap-0.5 font-medium text-foreground/80 hover:text-foreground">
              {t("focus.examples")}
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
