/**
 * Start screen of the own mode («Мои худшие дни»): which of the player's losses to replay (the worst of 30 days or a
 * random one) with the trade that will open, prefilled from GET /api/sim/own/candidates. One choice, one Play button
 * (the panel's own) — the ticker and date are not secret here, and the note says so.
 */
import { Dices, Info, TrendingDown } from "lucide-react";
import { ListSkeleton } from "@/components/ds";
import { fmtDate, fmtUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { simOwnI18n } from "@/i18n/ns/simOwn";
import { mistakeLabel } from "@/components/shared/mistake-labels";
import type { OwnCandidates, OwnPick } from "./api";

export type OwnStartPick = Exclude<OwnPick, "trade">;
const PICKS: OwnStartPick[] = ["worst", "random"];

/** Display label of a mistake id (daily-loop ids, lib/daily/types) — the desk-wide labels. */
export const ownMistakeLabel = (id: string): string => mistakeLabel(id);

export function OwnPicker({ data, loading, pick, setPick }: { data: OwnCandidates | undefined; loading: boolean; pick: OwnStartPick; setPick: (p: OwnStartPick) => void }) {
  const { t } = simOwnI18n.useT();
  if (loading) return <ListSkeleton rows={2} />;
  const trades = data?.trades ?? [];
  if (!trades.length) return <p className="tile rounded-xl p-3 text-sm text-muted-foreground">{t("none")}</p>;
  const worst = trades.find((x) => x.tradeId === data?.worst) ?? null;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium text-muted-foreground">{t("pickLabel")}</p>
      <div role="radiogroup" aria-label={t("pickLabel")} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {PICKS.map((p) => {
          const on = p === pick;
          const Icon = p === "worst" ? TrendingDown : Dices;
          return (
            <button
              key={p} type="button" role="radio" aria-checked={on} onClick={() => setPick(p)}
              className={cn(
                "tile flex min-h-[92px] flex-col items-start gap-1 rounded-xl p-3 text-left transition-[box-shadow,background-color] duration-[var(--dur-1)]",
                on ? "ring-2 ring-primary" : "hover:bg-[var(--tile-hover-bg)]",
              )}
            >
              <span className="flex w-full items-center justify-between gap-2">
                <span className="text-sm font-semibold">{p === "worst" ? t("pick.worst", { days: data?.windowDays ?? 30 }) : t("pick.random")}</span>
                <Icon className={cn("h-4 w-4", p === "worst" ? "text-down" : "text-muted-foreground")} aria-hidden="true" />
              </span>
              <span className="text-xs text-muted-foreground">{p === "worst" ? t("pick.worstHint") : t("pick.randomHint")}</span>
              {p === "worst" && worst && (
                <span className="mt-auto text-2xs tabular-nums text-foreground/80">
                  {t("next", { ticker: worst.ticker, date: fmtDate(worst.date, "dayMonth"), net: fmtUsd(worst.net, { signed: true }) })}
                  {worst.mistakes[0] ? ` · ${ownMistakeLabel(worst.mistakes[0])}` : ""}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <p className="text-2xs text-muted-foreground">{t("ready", { count: trades.length })}</p>
      <p className="flex items-start gap-1.5 text-2xs text-muted-foreground"><Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />{t("fair")}</p>
    </div>
  );
}
