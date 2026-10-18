import { AlertTriangle, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Pill } from "@/components/ds";
import { DEAL_TYPE_LABEL, SCORE_LEVEL_TONE, dealTypeOf, dilutionScore, discountOf } from "./score";
import {
  HORIZON_LABEL, fmtM, fmtPctCap, pctOfMcap,
  type Exposure, type Offering,
} from "./types";
import { fmtPrice } from "@/lib/format";
import { offeringsI18n } from "@/i18n/ns/offerings";

import { personName } from "@/i18n";
type Match = { o: Offering; e: Exposure };

function holdLine(e: Exposure): string {
  const tr = offeringsI18n.t;
  if (!e.held.length) return tr("holdings.inWatch");
  const parts = e.held.slice(0, 3).map((t) => {
    // Side is stored as a code or legacy Russian text — parse both.
    const side = t.side ? (/short|шорт/i.test(t.side) ? tr("holdings.short") : tr("holdings.long")) : null; // i18n-ignore
    const hz = HORIZON_LABEL[t.horizon ?? "intraday"] ?? HORIZON_LABEL.intraday;
    return [side, hz, t.trader ? personName(t.trader) : null].filter(Boolean).join(" · ");
  });
  return tr("holdings.position", { list: `${parts.join("; ")}${e.held.length > 3 ? ` +${e.held.length - 3}` : ""}` });
}

function whyLine(o: Offering): string {
  const t = offeringsI18n.t;
  const bits: string[] = [DEAL_TYPE_LABEL[dealTypeOf(o)]];
  const size = o.dealSizeM ?? o.shelfCapacityM;
  if (size != null) bits.push(fmtM(size));
  const p = pctOfMcap(o);
  if (p != null) bits.push(t("watch.pctMcap", { pct: fmtPctCap(p, 0) }));
  const d = discountOf(o);
  if (d != null) bits.push(t("watch.discount", { pct: Math.abs(d).toFixed(1) }));
  if (o.offerPrice != null) bits.push(t("watch.offer", { price: fmtPrice(o.offerPrice, { dollar: true }) }));
  return bits.join(" · ");
}

/**
 * Top-of-page warning: a fresh filing on a ticker with an open position (gap risk).
 * Watchlist-only hits are marked in the table instead — no banner for them.
 */
export function HoldingsAlert({
  offerings,
  exposure,
  onOpen,
}: {
  offerings: Offering[];
  exposure: Map<string, Exposure>;
  onOpen: (o: Offering) => void;
}) {
  const { t } = offeringsI18n.useT();
  const matches: Match[] = [];
  for (const o of offerings) {
    if (o.status === "withdrawn") continue;
    const e = exposure.get(o.ticker.toUpperCase());
    if (e && e.held.length) matches.push({ o, e });
  }
  if (!matches.length) return null;
  matches.sort((a, b) => dilutionScore(b.o).score - dilutionScore(a.o).score);

  const held = matches;
  const carry = held.filter((m) => m.e.held.some((t) => t.horizon === "overnight" || t.horizon === "swing"));
  const severe = true;

  return (
    <section
      role="alert"
      aria-label={t("holdings.aria")}
      className={cn(
        "glass-panel rounded-2xl border p-4 sm:p-5",
        severe ? "border-down/40 bg-down/[0.06]" : "border-[hsl(var(--chart-3)/0.4)] bg-[hsl(var(--chart-3)/0.06)]",
      )}
    >
      <div className="flex flex-wrap items-start gap-3">
        <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-xl", severe ? "bg-down/15 text-down" : "bg-[hsl(var(--chart-3)/0.15)] text-[hsl(var(--chart-3))]")}>
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-foreground">
            {severe
              ? t("holdings.titleHeld", { tickers: held.map((m) => m.o.ticker).join(", ") })
              : t("holdings.titleWatch", { tickers: matches.map((m) => m.o.ticker).join(", ") })}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {carry.length
              ? t("holdings.carry")
              : severe
                ? t("holdings.intraday")
                : t("holdings.watch")}
          </p>
        </div>
      </div>
      <ul className="mt-3 grid gap-2 md:grid-cols-2">
        {matches.slice(0, 6).map(({ o, e }) => (
          <li key={`${o.ticker}-${o.form ?? o.type}`}>
            <button
              type="button"
              onClick={() => onOpen(o)}
              className="lift flex w-full items-center gap-3 rounded-xl bg-[var(--glass-bg)] px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="text-sm font-semibold tabular-nums text-foreground">{o.ticker}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs text-foreground">{whyLine(o)}</span>
                <span className="block truncate text-xs text-muted-foreground">{holdLine(e)}</span>
              </span>
              <Pill tone={SCORE_LEVEL_TONE[dilutionScore(o).level]} className="text-2xs" title={t("holdings.scoreTitle")}>{dilutionScore(o).score}</Pill>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
