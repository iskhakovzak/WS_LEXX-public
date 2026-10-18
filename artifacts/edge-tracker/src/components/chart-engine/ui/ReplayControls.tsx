import * as React from "react";
import { ChevronLeft, ChevronRight, LogIn, LogOut, Pause, Play, RotateCcw, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Segmented } from "@/components/ds";
import { cn } from "@/lib/utils";
import type { ExecutionKind } from "../types";
import { REPLAY_SPEEDS, replayStarts, type ReplaySpeed, type ReplayStart } from "../lib/replay-clock";
import { chartI18n } from "@/i18n/ns/chart";

export type ReplayMark = { idx: number; kind: ExecutionKind; label: string };

const OPENING = (k: ExecutionKind) => k === "entry" || k === "add";

/**
 * Replay transport under the chart: restart · step back · play · step forward · scrubber with fill marks, then speed
 * (1×–60× bars per second), where to start, jumps to the entry / exit / next fill and «пауза на исполнениях».
 * Training hides everything that would hint at the real trade (fill marks, jumps) and cannot seek or step back:
 * time only moves forward, like in the market.
 */
export function ReplayDock({
  playing, speed, cursor, start, end, training, marks, timeLabel, startLabel, endLabel,
  startPreset, onStartPreset, hasEntry, intraday, hasExit, nextFillLabel, pauseOnFills, onPauseOnFills, atLimit,
  onToggle, onStep, onSpeed, onSeek, onNextFill, onEntry, onExit, onRestart, className,
}: {
  playing: boolean;
  speed: ReplaySpeed;
  cursor: number;
  start: number;
  /** Right edge of the scrubber. */
  end: number;
  training: boolean;
  marks: ReplayMark[];
  timeLabel: string;
  startLabel: string;
  endLabel: string;
  startPreset: ReplayStart;
  onStartPreset: (s: ReplayStart) => void;
  hasEntry: boolean;
  intraday: boolean;
  hasExit: boolean;
  nextFillLabel: string | null;
  pauseOnFills: boolean;
  onPauseOnFills: (v: boolean) => void;
  /** The cursor is on the last bar it may reach (end of data / end of the training session). */
  atLimit: boolean;
  onToggle: () => void;
  onStep: (delta: number) => void;
  onSpeed: (s: ReplaySpeed) => void;
  onSeek: (idx: number) => void;
  onNextFill: () => void;
  onEntry: () => void;
  onExit: () => void;
  onRestart: () => void;
  className?: string;
}) {
  const { t } = chartI18n.useT();
  return (
    <div className={cn("@container flex shrink-0 flex-col gap-2 rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-bg)] px-2.5 py-2", className)} role="group" aria-label={training ? t("replay.groupTraining") : t("replay.group")}>
      <div className="flex items-center gap-1.5">
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label={t("replay.restart")} title={t("replay.restartTitle")} onClick={onRestart}><RotateCcw /></Button>
        {!training && <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label={t("replay.back")} title={t("replay.backTitle")} onClick={() => onStep(-1)} disabled={cursor <= start}><ChevronLeft /></Button>}
        <button
          type="button"
          onClick={onToggle}
          disabled={atLimit && !playing && training}
          aria-label={playing ? t("replay.pause") : t("replay.play")}
          title={playing ? t("replay.pauseTitle") : atLimit ? t("replay.againTitle") : t("replay.playTitle")}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary-solid text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.25)] transition-opacity duration-[var(--dur-1)] hover:opacity-90 disabled:opacity-40"
        >
          {playing ? <Pause className="h-5 w-5" aria-hidden="true" /> : <Play className="ml-0.5 h-5 w-5" aria-hidden="true" />}
        </button>
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label={t("replay.forward")} title={t("replay.forwardTitle")} onClick={() => onStep(1)} disabled={atLimit}><ChevronRight /></Button>
        <Scrubber cursor={cursor} start={start} end={Math.max(cursor, end)} canSeek={!training} marks={training ? [] : marks} onSeek={onSeek} timeLabel={timeLabel} startLabel={startLabel} endLabel={endLabel} />
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <Segmented size="sm" ariaLabel={t("replay.speed")} value={String(speed)} onChange={(v) => onSpeed(Number(v) as ReplaySpeed)} options={REPLAY_SPEEDS.map((s) => ({ value: String(s), label: `${s}×` }))} />
        {intraday && (
          <Segmented<ReplayStart>
            size="sm"
            ariaLabel={t("replay.start")}
            value={startPreset}
            onChange={onStartPreset}
            options={replayStarts().map((o) => ({ value: o.value, label: o.label, title: o.title, disabled: o.value !== "pre" && o.value !== "open" && !hasEntry }))}
          />
        )}
        {!training && (
          <div className="inline-flex items-center gap-0.5" role="group" aria-label={t("replay.jumps")}>
            <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" title={t("replay.toEntryTitle")} onClick={onEntry} disabled={!hasEntry}><LogIn className="h-3.5 w-3.5" /> {t("replay.entry")}</Button>
            <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" title={nextFillLabel ? t("replay.nextFillTitle", { label: nextFillLabel }) : t("replay.noFillsAhead")} onClick={onNextFill} disabled={!nextFillLabel}><SkipForward className="h-3.5 w-3.5" /> {t("replay.fill")}</Button>
            <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" title={t("replay.toExitTitle")} onClick={onExit} disabled={!hasExit}><LogOut className="h-3.5 w-3.5" /> {t("replay.exit")}</Button>
          </div>
        )}
        {!training && marks.length > 0 && (
          <label className="ml-auto inline-flex cursor-pointer items-center gap-2 text-xs text-muted-foreground" title={t("replay.pauseOnFillsTitle")}>
            <Switch checked={pauseOnFills} onCheckedChange={onPauseOnFills} aria-label={t("replay.pauseOnFills")} />
            {t("replay.pauseOnFillsLabel")}
          </label>
        )}
      </div>
    </div>
  );
}

function Scrubber({ cursor, start, end, canSeek, marks, onSeek, timeLabel, startLabel, endLabel }: {
  cursor: number; start: number; end: number; canSeek: boolean; marks: ReplayMark[]; onSeek: (idx: number) => void; timeLabel: string; startLabel: string; endLabel: string;
}) {
  const { t } = chartI18n.useT();
  const trackRef = React.useRef<HTMLDivElement | null>(null);
  const dragging = React.useRef(false);
  const span = Math.max(1, end - start);
  const pos = (i: number) => `${(Math.max(0, Math.min(span, i - start)) / span) * 100}%`;
  const seek = (clientX: number) => {
    const el = trackRef.current;
    if (!el || !canSeek) return;
    const r = el.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
    const i = start + Math.round(frac * span);
    if (i !== cursor) onSeek(i);
  };
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5 pl-1">
      <div
        ref={trackRef}
        role="slider"
        tabIndex={canSeek ? 0 : -1}
        aria-label={t("replay.position")}
        aria-valuemin={start}
        aria-valuemax={end}
        aria-valuenow={cursor}
        aria-valuetext={timeLabel}
        aria-disabled={!canSeek}
        className={cn("relative h-5 touch-none select-none rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", canSeek ? "cursor-pointer" : "cursor-default")}
        onPointerDown={(e) => { if (!canSeek) return; dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); seek(e.clientX); }}
        onPointerMove={(e) => { if (dragging.current) seek(e.clientX); }}
        onPointerUp={(e) => { dragging.current = false; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}
        onPointerCancel={() => { dragging.current = false; }}
      >
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-[hsl(var(--muted-foreground)/0.2)]" />
        <div className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-primary" style={{ width: pos(cursor) }} aria-hidden="true" />
        {spread(marks.filter((m) => m.idx >= start && m.idx <= end)).map(({ m, dx }, i) => (
          <span
            key={`${m.idx}-${i}`}
            className={cn("absolute top-1/2 h-3 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-background", OPENING(m.kind) ? "bg-primary" : "bg-purple")}
            style={{ left: `calc(${pos(m.idx)} + ${dx}px)` }}
            title={m.label}
            aria-hidden="true"
          />
        ))}
        <span className="pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-background shadow-sm" style={{ left: pos(cursor) }} aria-hidden="true" />
      </div>
      <div className="flex items-center justify-between gap-2 whitespace-nowrap text-2xs tabular-nums text-muted-foreground">
        <span>{startLabel}</span>
        <span className="text-xs font-medium text-foreground">{timeLabel}</span>
        <span>{endLabel}</span>
      </div>
    </div>
  );
}

/** Fills on the same bar are fanned out a few pixels so each stays visible. */
function spread(marks: ReplayMark[]): { m: ReplayMark; dx: number }[] {
  const count = new Map<number, number>();
  for (const m of marks) count.set(m.idx, (count.get(m.idx) ?? 0) + 1);
  const seen = new Map<number, number>();
  return marks.map((m) => {
    const n = count.get(m.idx) ?? 1;
    const k = seen.get(m.idx) ?? 0;
    seen.set(m.idx, k + 1);
    return { m, dx: (k - (n - 1) / 2) * 6 };
  });
}
