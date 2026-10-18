/**
 * Simulator — pure client logic (no React, no DOM): wire bars, the fake clock, order sizing, the automatic bracket
 * on entry, keyboard mapping and autoplay speeds. The server decides everything that counts; this only prepares
 * requests and reads answers.
 */
import type { Candle } from "@/components/chart-engine";
import type { WireBar } from "./api";

export const fromWire = (w: WireBar): Candle => ({ t: w[0], o: w[1], h: w[2], l: w[3], c: w[4], v: w[5] });

/** Autoplay speeds, bars per second. */
export const SPEEDS = [1, 2, 4, 8, 16] as const;
export type Speed = (typeof SPEEDS)[number];
export const isSpeed = (v: unknown): v is Speed => SPEEDS.includes(v as Speed);
export function nextSpeed(s: Speed, dir: 1 | -1): Speed {
  const i = SPEEDS.indexOf(s);
  return SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, i + dir))];
}

/** Cents above $1, 4 decimals below (sub-dollar names). */
export function roundPrice(p: number): number {
  const k = Math.abs(p) >= 1 ? 100 : 10000;
  return Math.round(p * k) / k;
}

export type SizePreset = "half" | "base" | "double";
export function presetQty(base: number, p: SizePreset): number {
  const q = p === "half" ? base / 2 : p === "double" ? base * 2 : base;
  return Math.max(1, Math.round(q));
}

export function maxQtyFor(maxNotional: number, price: number): number {
  return price > 0 ? Math.floor(maxNotional / price) : 0;
}

/** Signed position after an order (mirrors the server's orderDelta). */
export function positionAfter(pos: number, kind: "buy" | "sell" | "flat", qty: number): number {
  if (kind === "flat") return 0;
  const q = Math.max(0, Math.floor(qty));
  return pos + (kind === "buy" ? q : -q);
}

/**
 * Stop / target to send with an order that opens a position or flips it: 1R (the risk unit) beyond the price,
 * the target at 2R. Undefined when the order only adds / reduces (the open bracket stays) or nothing is wanted.
 */
export function entryBracket(
  pos: number,
  next: number,
  price: number,
  riskUnit: number,
  opts: { autoStop: boolean; autoTarget: boolean },
): { stop: number | null; target: number | null } | undefined {
  const opens = next !== 0 && (pos === 0 || Math.sign(pos) !== Math.sign(next));
  if (!opens || (!opts.autoStop && !opts.autoTarget)) return undefined;
  const dir = Math.sign(next);
  const stop = opts.autoStop ? roundPrice(price - dir * riskUnit) : null;
  const target = opts.autoTarget ? roundPrice(price + dir * 2 * riskUnit) : null;
  return { stop: stop != null && stop > 0 ? stop : null, target: target != null && target > 0 ? target : null };
}

/** A typed price: "12,5" / "12.50" → 12.5; empty / invalid → null. */
export function parsePrice(s: string): number | null {
  const v = Number(s.trim().replace(",", "."));
  return s.trim() !== "" && Number.isFinite(v) && v > 0 ? v : null;
}

export type KeyAction = "buy" | "sell" | "flat" | "next" | "auto" | "faster" | "slower" | "undo" | "again";

/** Game keys (layout-independent: KeyboardEvent.code, so B/S/F work on a Russian layout too). */
export function keyAction(e: { code: string; key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): KeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (e.code) {
    case "KeyB": return "buy";
    case "KeyS": return "sell";
    case "KeyF": case "KeyX": return "flat";
    case "Space": case "ArrowRight": return "next";
    case "KeyA": return "auto";
    case "BracketRight": case "Equal": case "NumpadAdd": return "faster";
    case "BracketLeft": case "Minus": case "NumpadSubtract": return "slower";
    case "KeyZ": return "undo";
    case "Enter": case "NumpadEnter": return "again";
    default: return null;
  }
}

/* ─────────────────────────── Fake clock ─────────────────────────── */

const FAKE_DAY0 = Date.UTC(2001, 0, 10) / 1000;
const SWING_DAY0 = Date.UTC(2001, 0, 1) / 1000;

/** Intraday fake time → day offset (0 = the play day, −1 = the day before) and New York minutes. */
export function fakeClock(t: number): { day: number; min: number } {
  const rel = t - FAKE_DAY0;
  const day = Math.floor(rel / 86400);
  const min = Math.round((rel - day * 86400) / 60) - 300;
  return { day, min };
}

export function hhmm(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Swing fake time → bar index from the first bar. */
export function swingIndex(t: number): number {
  return Math.round((t - SWING_DAY0) / 86400);
}

/* ─────────────────────────── Errors ─────────────────────────── */

export type StepError = { reason: "buyingPower" | "stop" | "target" | "qty" | "generic"; maxQty?: number };

/** The server's VALIDATION details ({ reason, maxQty }) → what to tell the player. */
export function stepErrorOf(err: unknown): StepError {
  const details = (err as { body?: { details?: unknown } } | null)?.body?.details;
  const d = details && typeof details === "object" && !Array.isArray(details) ? (details as { reason?: unknown; maxQty?: unknown }) : null;
  const reason = d?.reason;
  if (reason === "buyingPower") return { reason, maxQty: typeof d?.maxQty === "number" ? d.maxQty : undefined };
  if (reason === "stop" || reason === "target" || reason === "qty") return { reason };
  return { reason: "generic" };
}
