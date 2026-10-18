/**
 * «Что сделал vs что было можно» — a pure summary of one real trade for the analysis panel and the end of a
 * replay. Per-share and R figures come from prices only (safe to show for anyone's trade); $ is passed in by the
 * caller and only for trades whose money the viewer may see (the API already nulls it otherwise).
 */
import { fmtUsd } from "@/lib/format";
import type { ExcursionResult, Side } from "../types";

export type TradeSummary = {
  side: Side;
  avgEntry: number | null;
  avgExit: number | null;
  /** Realised move per share, side-adjusted (+ = in the trade's favour). */
  perShare: number | null;
  pct: number | null;
  r: number | null;
  /** $ result (own / staff only; null otherwise). */
  pnlUsd: number | null;
  mfePerShare: number | null;
  maePerShare: number | null;
  mfeR: number | null;
  maeR: number | null;
  /** Best exit while in the trade: price and time of the MFE. */
  bestExitPrice: number | null;
  bestExitTime: number | null;
  /** Share of the MFE kept (0–1+, null without MFE); negative when the trade lost. */
  capture: number | null;
  /** MFE − realised per share (≥ 0): what was left on the table. */
  leftPerShare: number | null;
  holdSec: number | null;
  /** MFE/MAE are approximate (entry/exit bar extremes excluded). */
  approximate: boolean;
};

export function buildTradeSummary(input: {
  side: Side;
  avgEntry: number | null;
  avgExit: number | null;
  risk: number | null;
  excursion: ExcursionResult | null;
  entryTime: number | null;
  exitTime: number | null;
  pnlUsd: number | null;
}): TradeSummary {
  const { side, avgEntry, avgExit, risk, excursion: x } = input;
  const dir = side === "short" ? -1 : 1;
  const perShare = avgEntry != null && avgExit != null ? dir * (avgExit - avgEntry) : null;
  const pct = perShare != null && avgEntry ? (perShare / avgEntry) * 100 : null;
  const r = perShare != null && risk ? perShare / risk : null;
  const mfe = x ? x.mfe : null;
  const capture = perShare != null && mfe != null && mfe > 1e-9 ? perShare / mfe : null;
  return {
    side, avgEntry, avgExit, perShare, pct, r,
    pnlUsd: input.pnlUsd,
    mfePerShare: mfe,
    maePerShare: x ? x.mae : null,
    mfeR: x?.mfeR ?? (mfe != null && risk ? mfe / risk : null),
    maeR: x?.maeR ?? (x && risk ? x.mae / risk : null),
    bestExitPrice: x?.mfePrice ?? null,
    bestExitTime: x?.mfeAt ?? null,
    capture,
    leftPerShare: perShare != null && mfe != null ? Math.max(0, mfe - perShare) : null,
    holdSec: input.entryTime != null && input.exitTime != null && input.exitTime >= input.entryTime ? input.exitTime - input.entryTime : null,
    approximate: !!x?.approximate,
  };
}

/** «+12¢» / «−$1.35» per share. */
export function fmtPerShare(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  const a = Math.abs(n);
  return a < 1 ? `${sign}${(a * 100).toFixed(a * 100 >= 10 ? 0 : 1)}¢` : fmtUsd(n, { signed: true });
}
