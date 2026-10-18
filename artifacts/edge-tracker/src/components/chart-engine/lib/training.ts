import type { Side } from "../types";
import { chartI18n } from "@/i18n/ns/chart";

/**
 * Exit score for the training mode, 0–100.
 *
 * Window: from the entry bar up to max(chosen exit bar, real exit bar) — the bars the trader could
 * reasonably have exited on. The score is where the chosen exit price sits between the worst and the best
 * close in that window (for the trade's side). 100 = the best close in the window, 0 = the worst.
 * Returns null when there is nothing to compare (no entry, empty window, flat window).
 */
export function computeExitScore(
  closes: readonly number[],
  entryIdx: number | null,
  userIdx: number,
  exitIdx: number | null,
  side: Side,
  userExitPrice: number,
): number | null {
  if (entryIdx == null || entryIdx < 0 || !closes.length) return null;
  const to = Math.min(closes.length - 1, Math.max(userIdx, exitIdx ?? userIdx));
  if (to < entryIdx) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = entryIdx; i <= to; i++) {
    const c = closes[i];
    if (!Number.isFinite(c)) continue;
    if (c < lo) lo = c;
    if (c > hi) hi = c;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  // The chosen price is a bar close too, but clamp in case the window is slightly different.
  lo = Math.min(lo, userExitPrice);
  hi = Math.max(hi, userExitPrice);
  const range = hi - lo;
  if (range <= 1e-9) return null;
  const frac = side === "short" ? (hi - userExitPrice) / range : (userExitPrice - lo) / range;
  return Math.round(Math.max(0, Math.min(1, frac)) * 100);
}

export type ScoreVerdict = { label: string; tone: "up" | "neutral" | "warn" | "down" };

export function scoreVerdict(score: number | null | undefined): ScoreVerdict | null {
  if (score == null) return null;
  if (score >= 85) return { label: chartI18n.t("training.exitVerdict.perfect"), tone: "up" };
  if (score >= 65) return { label: chartI18n.t("training.exitVerdict.good"), tone: "up" };
  if (score >= 40) return { label: chartI18n.t("training.exitVerdict.average"), tone: "neutral" };
  if (score >= 20) return { label: chartI18n.t("training.exitVerdict.weak"), tone: "warn" };
  return { label: chartI18n.t("training.exitVerdict.worst"), tone: "down" };
}
