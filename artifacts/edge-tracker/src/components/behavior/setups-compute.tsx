/**
 * «Посчитать всё» для авто-классификатора: прогресс по пакетам (по 30 за запрос), отмена.
 * Сам цикл — useComputeAll в ./api (сервер ограничивает пакет, параллельность и обращения к Yahoo).
 */
import * as React from "react";
import { Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { type ComputeAllState } from "./api";
import { commonI18n } from "@/i18n/ns/common";
import { behaviorI18n } from "@/i18n/ns/behavior";

export const ComputeAllBar = React.memo(function ComputeAllBar({
  state, pending, canRun, onRun, onCancel,
}: {
  state: ComputeAllState;
  pending: number;
  canRun: boolean;
  onRun: () => void;
  onCancel: () => void;
}) {
  const running = state.status === "running";
  const total = state.start || 0;
  const doneCount = total ? Math.max(0, total - state.pending) : 0;
  const pct = total ? Math.round((doneCount / total) * 100) : 0;
  // Грубая оценка: пакет 30 сделок ≤ 12 с на сервере + пауза.
  const etaMin = Math.max(1, Math.ceil(((running ? state.pending : pending) / 30) * 8 / 60));

  if (!running && pending === 0 && state.status !== "done" && state.status !== "stalled" && state.status !== "error") return null;

  return (
    <div className="tile flex flex-col gap-2 p-3" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {running ? (
          <span className="tabular-nums text-foreground">
            {behaviorI18n.t("compute.running", { done: doneCount, total, batch: state.batches + 1, eta: etaMin })}
          </span>
        ) : state.status === "done" ? (
          <span className="text-foreground">{behaviorI18n.t("compute.done", { trades: commonI18n.t("units.trades", { count: state.done }) })}</span>
        ) : state.status === "cancelled" ? (
          <span className="text-muted-foreground">{behaviorI18n.t("compute.stopped", { done: state.done, pending })}</span>
        ) : state.status === "stalled" ? (
          <span className="text-muted-foreground">{behaviorI18n.t("compute.stuck", { pending: state.pending })}</span>
        ) : state.status === "error" ? (
          <span className="text-down">{behaviorI18n.t("compute.error", { error: state.error ?? "" })}</span>
        ) : (
          <span className="text-muted-foreground">
            {behaviorI18n.t("compute.pending", { trades: commonI18n.t("units.trades", { count: pending }), eta: etaMin })}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {running ? (
            <Button size="sm" variant="outline" onClick={onCancel}>
              <Square className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> {behaviorI18n.t("compute.cancel")}
            </Button>
          ) : (
            canRun && pending > 0 && (
              <Button size="sm" onClick={onRun}>
                <Play className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> {behaviorI18n.t("compute.computeAll")}
              </Button>
            )
          )}
        </div>
      </div>
      {(running || state.status === "cancelled" || state.status === "stalled") && total > 0 && (
        <div
          role="progressbar"
          aria-label={behaviorI18n.t("compute.progressAria")}

          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={doneCount}
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted/40"
        >
          <div
            className={cn("h-full rounded-full bg-primary transition-[width] duration-[var(--dur-3)] motion-reduce:transition-none", !running && "bg-muted-foreground")}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
});
