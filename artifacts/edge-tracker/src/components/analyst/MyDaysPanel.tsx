/**
 * «Мои сделки в дни рейтингов»: net / WR of my trades on a ticker on the day the market reacts to an analyst
 * action vs normal days. Answers «стоит ли мне вообще торговать апгрейды/даунгрейды».
 */
import * as React from "react";
import { UserRound } from "lucide-react";
import { EmptyState, Panel, TermTooltip } from "@/components/ds";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { DayBucket, MyDaysResponse } from "./api";
import { fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { analystI18n } from "@/i18n/ns/analyst";

const MIN_TRADES = 5;

function BucketRow({ label, b, hint, strong }: { label: React.ReactNode; b: DayBucket; hint?: string; strong?: boolean }) {
  const wr = b.winRate != null ? Math.round(b.winRate * 100) : null;
  return (
    <tr className={cn(strong && "font-medium")}>
      <th scope="row" className="py-1.5 pr-2 text-left text-xs font-normal text-muted-foreground" title={hint}>{label}</th>
      <td className="py-1.5 text-right text-xs tabular-nums text-foreground">{b.trades}</td>
      <td className={cn("py-1.5 text-right text-xs tabular-nums", b.trades ? (b.net >= 0 ? "text-up" : "text-down") : "text-muted-foreground")}>
        {b.trades ? fmtUsd(b.net, { signed: true, decimals: "auto" }) : "—"}
      </td>
      <td className="py-1.5 text-right text-xs tabular-nums text-foreground">{wr != null ? `${wr}%` : "—"}</td>
      <td className={cn("py-1.5 text-right text-xs tabular-nums", b.avgNet == null ? "text-muted-foreground" : b.avgNet >= 0 ? "text-up" : "text-down")}>
        {b.avgNet != null ? fmtUsd(b.avgNet, { signed: true, decimals: "auto" }) : "—"}
      </td>
    </tr>
  );
}

function insight(d: MyDaysResponse): string | null {
  const t = analystI18n.t;
  const { rating, none, withCall, againstCall } = d.buckets;
  const parts: string[] = [];
  if (rating.trades >= MIN_TRADES && none.trades >= MIN_TRADES && rating.avgNet != null && none.avgNet != null) {
    const diff = rating.avgNet - none.avgNet;
    if (Math.abs(diff) >= 1) {
      parts.push(
        diff > 0
          ? t("myDays.better", { amount: fmtUsd(diff, { decimals: "auto" }) })
          : t("myDays.worse", { amount: fmtUsd(-diff, { decimals: "auto" }) }),
      );
    }
  }
  if (withCall.trades >= MIN_TRADES && againstCall.trades >= MIN_TRADES && withCall.avgNet != null && againstCall.avgNet != null) {
    parts.push(
      withCall.avgNet >= againstCall.avgNet
        ? t("myDays.withBetter")
        : t("myDays.againstBetter"),
    );
  }
  return parts.length ? parts.join(" ") : null;
}

export function MyDaysPanel({
  data, isLoading, scopeLabel,
}: {
  data: MyDaysResponse | null | undefined;
  isLoading: boolean;
  scopeLabel: string;
}) {
  const { t } = analystI18n.useT();
  const text = data ? insight(data) : null;
  const total = data ? data.buckets.rating.trades + data.buckets.target.trades + data.buckets.none.trades : 0;
  return (
    <Panel
      icon={UserRound}
      title={
        <span className="inline-flex items-center gap-1.5">
          {t("myDays.title")}
          <TermTooltip term="reactionDay" icon />
        </span>
      }
      description={data ? t("myDays.description", { scope: scopeLabel, days: commonI18n.t("units.days", { count: data.days }), trades: commonI18n.t("units.trades", { count: total }) }) : scopeLabel}
      bodyClassName="min-h-[176px]"
    >
      {isLoading ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-7 w-full rounded-lg" />)}
        </div>
      ) : data === null ? (
        <p className="text-xs text-muted-foreground">{t("myDays.apiLater")}</p>
      ) : !data || total === 0 ? (
        <EmptyState compact icon={UserRound} title={t("myDays.emptyTitle")} description={t("myDays.emptyText")} />
      ) : (
        <div className="flex flex-col gap-3">
          <table className="w-full table-fixed border-separate border-spacing-0">
            <colgroup>
              <col />
              <col style={{ width: 40 }} />
              <col style={{ width: 78 }} />
              <col style={{ width: 44 }} />
              <col style={{ width: 66 }} />
            </colgroup>
            <thead>
              <tr className="text-2xs text-muted-foreground">
                <th scope="col" className="pb-1 text-left font-medium">{t("myDays.colDay")}</th>
                <th scope="col" className="pb-1 text-right font-medium">{t("myDays.colTrades")}</th>
                <th scope="col" className="pb-1 text-right font-medium"><TermTooltip term="net" /></th>
                <th scope="col" className="pb-1 text-right font-medium"><TermTooltip term="winrate">WR</TermTooltip></th>
                <th scope="col" className="pb-1 text-right font-medium">{t("myDays.colAvg")}</th>
              </tr>
            </thead>
            <tbody className="[&_tr+tr_th]:border-t [&_tr+tr_td]:border-t [&_th]:border-border/50 [&_td]:border-border/50">
              <BucketRow label={t("myDays.rating")} b={data.buckets.rating} hint={t("myDays.ratingHint")} strong />
              <BucketRow label={t("myDays.target")} b={data.buckets.target} hint={t("myDays.targetHint")} />
              <BucketRow label={t("myDays.none")} b={data.buckets.none} hint={t("myDays.noneHint")} />
              {data.buckets.withCall.trades + data.buckets.againstCall.trades > 0 && (
                <>
                  <BucketRow label={<TermTooltip term="ratingHit">{t("myDays.withCall")}</TermTooltip>} b={data.buckets.withCall} hint={t("myDays.withCallHint")} />
                  <BucketRow label={t("myDays.againstCall")} b={data.buckets.againstCall} hint={t("myDays.againstCallHint")} />
                </>
              )}
            </tbody>
          </table>
          {text ? (
            <p className="rounded-lg bg-[var(--glass-bg)] px-2.5 py-2 text-xs text-foreground">{text}</p>
          ) : data.buckets.rating.trades < MIN_TRADES ? (
            <p className="text-xs text-muted-foreground">{t("myDays.fewTrades", { count: data.buckets.rating.trades })}</p>
          ) : null}
        </div>
      )}
    </Panel>
  );
}
