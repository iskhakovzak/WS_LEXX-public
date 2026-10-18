import { Globe2, ShieldAlert, Target } from "lucide-react";
import { Pill } from "@/components/ds";
import { InPlayCard, FocusBanner } from "./plan-briefing";
import { MediaGallery } from "./plan-media";
import { MARKET_BIAS, type PlanDoc } from "./types";
import { fmtUsd } from "@/lib/format";
import { gpI18n } from "@/i18n/ns/gamePlan";
import { dailyI18n } from "@/i18n/ns/daily";
import { mistakeLabel } from "@/components/shared/mistake-labels";

/** Read-only rendering of a personal plan (trader's own read mode and the curator's «Трейдеры» view). */
export function PlanDocView({ doc, compactTickers }: { doc: Partial<PlanDoc>; compactTickers?: boolean }) {
  const { t } = gpI18n.useT();
  const { t: td } = dailyI18n.useT();
  const bias = MARKET_BIAS[doc.bias ?? "neutral"] ?? MARKET_BIAS.neutral;
  const tickers = doc.inPlay ?? [];
  const hasRisk = doc.maxLossUsd != null || doc.maxTrades != null || !!doc.riskNotes?.trim() || !!doc.ownRule;
  const hasMarket = !!doc.marketView?.trim() || !!doc.media?.length || !!doc.tvLinks?.length;
  const empty = !hasRisk && !hasMarket && tickers.length === 0 && !doc.focus?.trim();

  if (empty) return <p className="text-sm text-muted-foreground">{t("doc.empty")}</p>;

  return (
    <div className="flex flex-col gap-[var(--grid-gap)]">
      <FocusBanner focus={doc.focus} />

      {hasMarket && (
        <section aria-label={t("doc.market")} className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Globe2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <h3 className="text-sm font-semibold">{t("doc.market")}</h3>
            <Pill tone={bias.tone} dot>
              {bias.label}
            </Pill>
          </div>
          {doc.marketView?.trim() && <p className="whitespace-pre-wrap text-sm leading-relaxed">{doc.marketView}</p>}
          <MediaGallery media={doc.media} tvLinks={doc.tvLinks} />
        </section>
      )}

      {hasRisk && (
        <section aria-label={t("doc.risk")} className="flex flex-col gap-2 rounded-xl border border-[var(--field-border)] bg-[var(--glass-bg)] p-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="flex items-center gap-1.5 text-sm font-semibold">
              <ShieldAlert className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              {t("doc.risk")}
            </span>
            {doc.maxLossUsd != null && (
              <span className="text-sm">
                <span className="text-muted-foreground">{t("doc.maxLoss")} </span>
                <span className="font-semibold tabular-nums">{fmtUsd(doc.maxLossUsd, { decimals: 0 })}</span>
              </span>
            )}
            {doc.maxTrades != null && (
              <span className="text-sm">
                <span className="text-muted-foreground">{t("doc.maxTrades")} </span>
                <span className="font-semibold tabular-nums">{doc.maxTrades}</span>
              </span>
            )}
            {doc.ownRule && (
              <span className="text-sm">
                <span className="text-muted-foreground">{td("ownRule.label")}: </span>
                <span className="font-semibold">{mistakeLabel(doc.ownRule)}</span>
              </span>
            )}
          </div>
          {doc.riskNotes?.trim() && <p className="whitespace-pre-wrap text-sm leading-relaxed">{doc.riskNotes}</p>}
        </section>
      )}

      {tickers.length > 0 && (
        <section aria-label={t("doc.tickers")} className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Target className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <h3 className="text-sm font-semibold">
              {t("doc.tickers")} <span className="tabular-nums text-muted-foreground">{tickers.length}</span>
            </h3>
          </div>
          <div className={compactTickers ? "grid gap-[var(--grid-gap)] xl:grid-cols-2" : "grid gap-[var(--grid-gap)] md:grid-cols-2 2xl:grid-cols-3"}>
            {tickers.map((t, i) => (
              <InPlayCard key={`${t.ticker}-${i}`} item={t} index={i} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
