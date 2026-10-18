/**
 * Chart-lab «Тренировка»: where random tasks come from and which ones — a popover next to «Случайная задача».
 * Source (own trades / the desk's trades / any ticker-day), the finest bars a task must have (with how many tasks
 * each option has, from GET /api/training/pool) and filters (side, result, ticker, period). Settings live in this
 * browser. A task never reveals the trader, side or result before the reveal — the filters only narrow the pool.
 */
import * as React from "react";
import { Dices, SlidersHorizontal } from "lucide-react";
import { Segmented } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  DEFAULT_TASK_SETTINGS, RES_LABEL, SOURCE_LABEL, activeFilterCount, countFor, noTasksMessage,
  type PoolCounts, type TaskRes, type TaskSettings, type TaskSource,
} from "@/lib/training-tasks";
import { chartLabI18n } from "@/i18n/ns/chartLab";
import { commonI18n } from "@/i18n/ns/common";

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="text-2xs leading-snug text-muted-foreground">{hint}</span>}
    </div>
  );
}


export function TaskSettingsButton({
  settings, onChange, counts, member, loading, error, onPick, picking,
}: {
  settings: TaskSettings;
  onChange: (patch: Partial<TaskSettings>) => void;
  counts: PoolCounts | null;
  /** Signed-in member (trade sources available); false for guests. */
  member: boolean;
  loading: boolean;
  /** The pool could not be loaded (e.g. the API server lacks /api/training). */
  error?: string | null;
  onPick: () => void;
  picking: boolean;
}) {
  const { t } = chartLabI18n.useT();
  const [open, setOpen] = React.useState(false);
  const filters = activeFilterCount(settings);
  const available = countFor(counts, settings.res);
  const dayOnly = settings.source === "day";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-9 shrink-0 gap-1.5 px-2.5" aria-label={t("tasks.settingsAria")} title={t("tasks.settingsTitle")}>
          <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
          <span className="hidden md:inline">{t(`tasks.sourceShort.${settings.source}`)}</span>
          {filters > 0 && <span className="grid h-4 min-w-4 place-items-center rounded-full bg-primary/15 px-1 text-2xs font-semibold tabular-nums text-primary">{filters}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-3 p-3">
        <Row label={t("tasks.from")}>
          <Segmented
            size="sm" ariaLabel={t("tasks.sourceAria")} value={settings.source} onChange={(v) => onChange({ source: v })} className="w-full"
            options={(["mine", "desk", "day"] as TaskSource[]).map((s) => ({
              value: s, label: t(`tasks.sourceTab.${s}`),
              disabled: s !== "day" && !member, title: s !== "day" && !member ? t("tasks.afterLogin") : SOURCE_LABEL[s],
            }))}
          />
        </Row>
        <p className="-mt-1.5 text-2xs leading-snug text-muted-foreground">
          {t(`tasks.hint.${settings.source}`)}
        </p>

        <Row label={t("tasks.bars")} hint={t("tasks.barsHint")}>
          <Segmented
            size="sm" ariaLabel={t("tasks.barsAria")} value={settings.res} onChange={(v) => onChange({ res: v })} className="w-full"
            options={(["1m", "5m", "any"] as TaskRes[]).map((r) => ({ value: r, label: RES_LABEL[r], count: counts ? countFor(counts, r) : undefined }))}
          />
        </Row>

        <div className="grid grid-cols-[5.5rem_1fr] items-center gap-x-2 gap-y-2">
          <span className={cn("text-2xs font-semibold uppercase tracking-wide text-muted-foreground", dayOnly && "opacity-50")}>{t("tasks.side")}</span>
          <Segmented
            size="sm" ariaLabel={t("tasks.sideAria")} value={settings.side ?? "any"} onChange={(v) => onChange({ side: v === "any" ? null : (v as "long" | "short") })}
            options={[{ value: "any", label: t("tasks.all"), disabled: dayOnly }, { value: "long", label: t("tasks.long"), disabled: dayOnly }, { value: "short", label: t("tasks.short"), disabled: dayOnly }]}
            className="justify-self-start"
          />
          <span className={cn("text-2xs font-semibold uppercase tracking-wide text-muted-foreground", dayOnly && "opacity-50")}>{t("tasks.result")}</span>
          <Segmented
            size="sm" ariaLabel={t("tasks.resultAria")} value={settings.result ?? "any"} onChange={(v) => onChange({ result: v === "any" ? null : (v as "win" | "loss") })}
            options={[{ value: "any", label: t("tasks.all"), disabled: dayOnly }, { value: "win", label: t("tasks.win"), disabled: dayOnly }, { value: "loss", label: t("tasks.loss"), disabled: dayOnly }]}
            className="justify-self-start"
          />
          <label htmlFor="task-ticker" className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">{t("tasks.ticker")}</label>
          <Input id="task-ticker" className="h-8 w-28 uppercase placeholder:normal-case" placeholder={t("tasks.tickerAny")} value={settings.ticker} maxLength={11} onChange={(e) => onChange({ ticker: e.target.value.toUpperCase().replace(/[^A-Z0-9.\-]/g, "") })} />
          <span className="col-span-2 -mb-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">{t("tasks.period")}</span>
          <div className="col-span-2 flex min-w-0 items-center gap-1">
            <Input type="date" aria-label={t("tasks.fromAria")} className="h-8 min-w-0 flex-1 px-1.5 text-xs" value={settings.from} max={settings.to || undefined} onChange={(e) => onChange({ from: e.target.value })} />
            <span className="text-muted-foreground" aria-hidden="true">–</span>
            <Input type="date" aria-label={t("tasks.toAria")} className="h-8 min-w-0 flex-1 px-1.5 text-xs" value={settings.to} min={settings.from || undefined} onChange={(e) => onChange({ to: e.target.value })} />
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-[var(--glass-border)] pt-2.5">
          <span className="min-w-0 flex-1 text-xs text-muted-foreground" role="status">
            {loading ? t("tasks.counting") : error ? <span className="text-destructive">{error}</span> : available ? <>{t("tasks.fits")} <b className="tabular-nums text-foreground">{available}</b></> : <span className="text-[hsl(var(--chart-3))]">{noTasksMessage(settings, counts)}</span>}
          </span>
          <Button variant="ghost" size="sm" className="h-8 shrink-0 px-2" onClick={() => onChange({ ...DEFAULT_TASK_SETTINGS, source: member ? DEFAULT_TASK_SETTINGS.source : "day" })}>{commonI18n.t("actions.reset")}</Button>
          <Button size="sm" className="h-8 shrink-0 gap-1.5" disabled={(!available && !error) || picking} onClick={() => { setOpen(false); onPick(); }}>
            <Dices className="h-4 w-4" aria-hidden="true" /> {t("tasks.task")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
