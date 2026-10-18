import { Flame, Snowflake, Zap } from "lucide-react";
import { Panel } from "@/components/ds";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { dashboardI18n } from "@/i18n/ns/dashboard";
import { commonI18n } from "@/i18n/ns/common";
import type { DashboardToday } from "./use-dashboard";

function Mini({ label, value, unit }: { label: string; value: number; unit: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-xs text-muted-foreground" title={label}>{label}</div>
      <div className="text-sm font-medium tabular-nums">
        {value} <span className="text-xs font-normal text-muted-foreground">{unit}</span>
      </div>
    </div>
  );
}

/** Rhythm: current streak, records and the last 20 results as a strip. */
export function StreaksPanel({ data, isLoading, fill }: { data: DashboardToday | undefined; isLoading: boolean; fill?: boolean }) {
  const { t } = dashboardI18n.useT();
  if (isLoading && !data) {
    return (
      <Panel title={t("streaks.title")} icon={Zap} fill={fill}>
        <div className="flex flex-col gap-3" role="status" aria-label={commonI18n.t("states.loading")}>
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-6 w-full rounded-md" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      </Panel>
    );
  }
  if (!data) return null;
  const s = data.streaks;
  const cur = s.current;
  const isWin = cur.type === "win";
  const isLoss = cur.type === "loss";
  const CurIcon = isLoss ? Snowflake : Flame;

  return (
    <Panel title={t("streaks.title")} icon={Zap} fill={fill} description={data.scope === "team" ? t("streaks.team") : t("streaks.mine")}>
      <div className="flex flex-1 flex-col gap-4">
        <div className={cn("flex items-center gap-3 rounded-xl p-3", isWin ? "bg-up/10" : isLoss ? "bg-down/10" : "tile")}>
          <span
            className={cn(
              "grid h-10 w-10 shrink-0 place-items-center rounded-full",
              isWin ? "bg-up/20 text-up" : isLoss ? "bg-down/20 text-down" : "bg-[var(--glass-hover-bg)] text-muted-foreground",
            )}
          >
            <CurIcon className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="text-xs text-muted-foreground">{t("streaks.current")}</div>
            <div className={cn("text-xl font-semibold tabular-nums", isWin ? "text-up" : isLoss ? "text-down" : "")}>
              {cur.count > 0
                ? t(isWin ? "streaks.winStreak" : "streaks.lossStreak", { count: cur.count })
                : t("streaks.none")}
            </div>
          </div>
        </div>

        <div>
          <div className="mb-1.5 text-xs text-muted-foreground">
            {s.recent.length === 1 ? t("streaks.lastOne") : t("streaks.lastN", { count: s.recent.length || 20 })}
          </div>
          {s.recent.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("streaks.noClosed")}</p>
          ) : (
            <ol className="grid grid-cols-[repeat(20,minmax(0,1fr))] gap-1" aria-label={t("streaks.stripAria")}>
              {s.recent.map((r, i) => (
                <li
                  key={i}
                  title={r === "win" ? t("streaks.win") : r === "loss" ? t("streaks.loss") : t("streaks.be")}
                  className={cn("h-6 rounded", r === "win" ? "bg-up/50" : r === "loss" ? "bg-down/55" : "bg-[var(--glass-hover-bg)]")}
                >
                  <span className="sr-only">{r === "win" ? t("streaks.win") : r === "loss" ? t("streaks.loss") : t("streaks.be")}</span>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="mt-auto grid grid-cols-3 gap-3">
          <Mini label={t("streaks.bestWin")} value={s.bestWin} unit={t("streaks.inARow")} />
          <Mini label={t("streaks.worstLoss")} value={s.bestLoss} unit={t("streaks.inARow")} />
          <Mini label={t("streaks.greenDays")} value={s.greenDays} unit={t("streaks.inARow")} />
        </div>
      </div>
    </Panel>
  );
}
