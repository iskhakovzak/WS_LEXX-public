import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CheckCheck, RefreshCw, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Panel, Pill } from "@/components/ds";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { gpApi, gpKeys, type GamePlan, type GamePlanResponse } from "./types";
import { fmtDate } from "@/lib/format";
import { gpI18n } from "@/i18n/ns/gamePlan";
import { personInitials, personName } from "@/i18n";
import { commonI18n } from "@/i18n/ns/common";

/** Trader-side: "Отметить прочитанным" / read confirmation (optimistic). */
export function MarkReadButton({
  plan,
  myReadAt,
  date,
  primary,
}: {
  plan: GamePlan;
  myReadAt: string | null;
  date: string;
  primary: boolean;
}) {
  const { t } = gpI18n.useT();
  const qc = useQueryClient();
  const stale = !!myReadAt && new Date(myReadAt) < new Date(plan.updatedAt);
  const m = useMutation({
    mutationFn: () => gpApi.markRead(plan.id),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: gpKeys.day(date) });
      const prev = qc.getQueryData<GamePlanResponse>(gpKeys.day(date));
      if (prev?.plan) {
        qc.setQueryData<GamePlanResponse>(gpKeys.day(date), {
          ...prev,
          myReadAt: new Date().toISOString(),
          plan: { ...prev.plan, readCount: prev.myReadAt ? prev.plan.readCount : prev.plan.readCount + 1 },
        });
      }
      return { prev };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(gpKeys.day(date), ctx.prev);
      toast({ title: t("reads.markFailed"), description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: gpKeys.day(date) });
      qc.invalidateQueries({ queryKey: gpKeys.reads(plan.id) });
    },
  });

  if (myReadAt && !stale) {
    return (
      <Pill tone="up" className="px-3 py-1.5 text-sm">
        <CheckCheck className="h-4 w-4" aria-hidden="true" />
        {t("reads.readAt", { time: fmtDate(myReadAt, "time") })}
      </Pill>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant={primary ? "default" : "outline"} onClick={() => m.mutate()} disabled={m.isPending}>
        {stale ? <RefreshCw aria-hidden="true" /> : <Check aria-hidden="true" />}
        {stale ? t("reads.reread") : t("reads.markRead")}
      </Button>
      {stale && <span className="text-xs text-[hsl(var(--chart-3))]">{t("reads.updatedAfter")}</span>}
    </div>
  );
}

/** Curator-side: who has and hasn't read the plan. */
export function ReadStatusPanel({ planId }: { planId: number }) {
  const { t } = gpI18n.useT();
  const q = useQuery({
    queryKey: gpKeys.reads(planId),
    queryFn: () => gpApi.reads(planId),
    refetchInterval: 60_000,
  });
  const d = q.data;
  const pct = d && d.total ? Math.round((d.readCount / d.total) * 100) : 0;
  return (
    <Panel title={t("reads.title")} icon={Users} description={t("reads.desc")} aria-live="polite">
      {q.isLoading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-8 w-24 rounded-xl" />
          <Skeleton className="h-2 w-full rounded-full" />
          <div className="flex gap-1.5">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-8 rounded-full" />
            ))}
          </div>
        </div>
      ) : q.isError || !d ? (
        <p className="text-sm text-muted-foreground">{t("reads.unavailable")}</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold tabular-nums">
              {d.readCount}
              <span className="text-muted-foreground">/{d.total}</span>
            </span>
            <span className="text-xs text-muted-foreground">{t("reads.readPct", { pct })}</span>
          </div>
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--glass-bg)]"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-label={t("reads.progressAria")}
          >
            <div className="h-full rounded-full bg-up transition-[width] duration-300" style={{ width: `${pct}%` }} />
          </div>
          {d.read.length > 0 && (
            <div>
              <p className="micro-label mb-2">{t("reads.read")}</p>
              <ul className="flex flex-wrap gap-1.5">
                {d.read.map((r) => (
                  <li key={r.trader}>
                    <Avatar name={r.trader} state={r.stale ? "stale" : "read"} hint={`${personName(r.trader)} · ${fmtDate(r.readAt, "time")}${r.stale ? t("reads.beforeUpdate") : ""}`} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {d.unread.length > 0 && (
            <div>
              <p className="micro-label mb-2">{t("reads.unread")}</p>
              <ul className="flex flex-wrap gap-1.5">
                {d.unread.map((r) => (
                  <li key={r.trader}>
                    <Avatar name={r.trader} state="unread" hint={`${personName(r.trader)} · ${commonI18n.t(r.role === "trader" ? "roles.trader" : r.role === "curator" ? "roles.curator" : "roles.admin")}`} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

function Avatar({ name, state, hint }: { name: string; state: "read" | "stale" | "unread"; hint: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          aria-label={hint}
          className={cn(
            "grid h-8 w-8 place-items-center rounded-full text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            state === "read" && "bg-up/15 text-up ring-1 ring-up/40",
            state === "stale" && "bg-[hsl(var(--chart-3)/0.15)] text-[hsl(var(--chart-3))] ring-1 ring-[hsl(var(--chart-3)/0.4)]",
            state === "unread" && "border border-dashed border-[var(--field-border)] text-muted-foreground",
          )}
        >
          {personInitials(name)}
        </span>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}
