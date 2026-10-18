/**
 * Replay clock — pure helpers for the bar-by-bar replay (no React, no DOM, no timers).
 *
 * Speed is in BARS PER SECOND of wall time (1× = one bar a second, 60× = an hour of 1-minute bars a second).
 * The component drives a requestAnimationFrame loop and asks `clockTick` how many whole
 * bars the elapsed time is worth; the fractional rest is carried to the next frame so the pace is exact at any
 * frame rate. `planAdvance` then moves the cursor, stopping on the end of the data or (optionally) on a fill.
 */
import type { Candle } from "../types";
import { chartI18n } from "@/i18n/ns/chart";
import { etParts, RTH_OPEN_MIN, PRE_OPEN_MIN, RTH_CLOSE_MIN } from "./time";

export const REPLAY_SPEEDS = [1, 2, 5, 10, 30, 60] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

export function isReplaySpeed(v: unknown): v is ReplaySpeed {
  return (REPLAY_SPEEDS as readonly number[]).includes(Number(v));
}

/** Next faster / slower speed in the ladder (clamped at both ends). */
export function stepSpeed(cur: number, dir: 1 | -1): ReplaySpeed {
  if (dir > 0) return REPLAY_SPEEDS.find((s) => s > cur) ?? REPLAY_SPEEDS[REPLAY_SPEEDS.length - 1];
  for (let i = REPLAY_SPEEDS.length - 1; i >= 0; i--) if (REPLAY_SPEEDS[i] < cur) return REPLAY_SPEEDS[i];
  return REPLAY_SPEEDS[0];
}

/** Longest frame gap honoured (a background tab must not fast-forward the replay when it comes back). */
export const MAX_FRAME_MS = 250;

/** Whole bars earned by `dtMs` of wall time at `speed` bars/second, plus the carry (ms) for the next frame. */
export function clockTick(carryMs: number, dtMs: number, speed: number): { steps: number; carry: number } {
  if (!(speed > 0)) return { steps: 0, carry: 0 };
  const per = 1000 / speed;
  const total = Math.max(0, carryMs) + Math.max(0, Math.min(MAX_FRAME_MS, dtMs));
  const steps = Math.floor(total / per);
  return { steps, carry: total - steps * per };
}

export type AdvanceResult = { next: number; stopped: "end" | "fill" | "limit" | null };

/**
 * Move the cursor `steps` bars forward from `cur`. Stops early (and reports why) on `last`, on a hard `limit`
 * (training: the end of the exercise window) or — when `pauseOn` is given — exactly on the first of those indices
 * strictly after `cur`.
 */
export function planAdvance(cur: number, steps: number, opts: { last: number; limit?: number | null; pauseOn?: readonly number[] | null }): AdvanceResult {
  const end = Math.min(opts.last, opts.limit ?? Infinity);
  if (cur >= end) return { next: Math.min(cur, opts.last), stopped: cur >= opts.last ? "end" : "limit" };
  let next = Math.min(end, cur + Math.max(0, steps));
  let stopped: AdvanceResult["stopped"] = null;
  if (opts.pauseOn?.length) {
    let hit: number | null = null;
    for (const i of opts.pauseOn) if (i > cur && i <= next && (hit == null || i < hit)) hit = i;
    if (hit != null) { next = hit; stopped = "fill"; }
  }
  if (stopped == null && next >= end) stopped = next >= opts.last ? "end" : "limit";
  return { next, stopped };
}

/** Where the replay starts. */
export type ReplayStart = "pre" | "open" | "30" | "15" | "5";
export const REPLAY_START_VALUES: readonly ReplayStart[] = ["pre", "open", "30", "15", "5"];
const START_KEY = { pre: "pre", open: "open", "30": "m30", "15": "m15", "5": "m5" } as const;
/** Start presets with labels in the UI language (call at render time). */
export function replayStarts(): { value: ReplayStart; label: string; title: string }[] {
  return REPLAY_START_VALUES.map((value) => {
    const k = START_KEY[value];
    return { value, label: chartI18n.t(`replay.starts.${k}`), title: chartI18n.t(`replay.starts.${k}Title`) };
  });
}
export function isReplayStart(v: unknown): v is ReplayStart {
  return v === "pre" || v === "open" || v === "30" || v === "15" || v === "5";
}

/** First bar of `dayKey` (ET) at or after `minOfDay`, or −1. */
export function firstBarOfDayAt(bars: readonly Candle[], dayKey: string, minOfDay: number): number {
  for (let i = 0; i < bars.length; i++) {
    const p = etParts(bars[i].t);
    if (p.dayKey === dayKey && p.mod >= minOfDay) return i;
    if (p.dayKey > dayKey) break;
  }
  return -1;
}

/**
 * Start index of the replay for a preset. Minutes-before presets need an entry (index or exact time); without one
 * (a ticker + day without a trade) they fall back to the session open. Never after the entry.
 */
export function replayStartIndex(
  bars: readonly Candle[],
  preset: ReplayStart,
  ctx: { dayKey: string; entryIdx: number | null; entryTime: number | null },
): number {
  if (!bars.length) return 0;
  const cap = (i: number) => Math.max(0, ctx.entryIdx != null ? Math.min(i, ctx.entryIdx) : i);
  const pre = firstBarOfDayAt(bars, ctx.dayKey, PRE_OPEN_MIN);
  const open = firstBarOfDayAt(bars, ctx.dayKey, RTH_OPEN_MIN);
  if (preset === "pre") return cap(pre >= 0 ? pre : open >= 0 ? open : 0);
  if (preset === "open" || ctx.entryIdx == null) return cap(open >= 0 ? open : pre >= 0 ? pre : 0);
  const anchor = ctx.entryTime ?? bars[ctx.entryIdx].t;
  const target = anchor - Number(preset) * 60;
  let i = ctx.entryIdx;
  while (i > 0 && bars[i - 1].t >= target) i--;
  return cap(i);
}

/** Last regular-session bar of `dayKey` (or the last bar of that day, or of the data). Training never looks further. */
export function sessionEndIndex(bars: readonly Candle[], dayKey: string): number {
  let lastOfDay = -1, lastRth = -1;
  for (let i = 0; i < bars.length; i++) {
    const p = etParts(bars[i].t);
    if (p.dayKey !== dayKey) { if (p.dayKey > dayKey) break; continue; }
    lastOfDay = i;
    if (p.mod < RTH_CLOSE_MIN) lastRth = i;
  }
  return lastRth >= 0 ? lastRth : lastOfDay >= 0 ? lastOfDay : bars.length - 1;
}
