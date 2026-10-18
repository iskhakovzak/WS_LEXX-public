/**
 * Drawing tools: data model + localStorage persistence (best effort, never throws). Pure except
 * for the storage helpers, which guard every access.
 */
import type { Drawing, DrawingPoint, DrawingType } from "../types";
import { chartI18n } from "@/i18n/ns/chart";

export const FIB_LEVELS: readonly number[] = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

export const DRAWING_LABEL: Readonly<Record<DrawingType, string>> = {
  get hline() { return chartI18n.t("drawing.hline"); },
  get trend() { return chartI18n.t("drawing.trend"); },
  get rect() { return chartI18n.t("drawing.rect"); },
  get fib() { return chartI18n.t("drawing.fib"); },
};

/** Points a tool needs before it is complete. */
export const DRAWING_POINTS: Record<DrawingType, number> = { hline: 1, trend: 2, rect: 2, fib: 2 };

const KEY_PREFIX = "ws-chart:drawings:v1:";
const VERSION = 1;

type Stored = { v: number; items: Drawing[] };

export function newDrawingId(): string {
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function makeDrawing(type: DrawingType, points: DrawingPoint[], color?: string): Drawing {
  return { id: newDrawingId(), type, points: points.map((p) => ({ time: p.time, price: p.price })), color, createdAt: Date.now() };
}

export function isValidDrawing(d: unknown): d is Drawing {
  if (!d || typeof d !== "object") return false;
  const x = d as Record<string, unknown>;
  if (typeof x.id !== "string" || typeof x.type !== "string" || !(x.type in DRAWING_POINTS)) return false;
  if (!Array.isArray(x.points) || x.points.length < DRAWING_POINTS[x.type as DrawingType]) return false;
  return x.points.every((p: unknown) => p && typeof p === "object" && Number.isFinite((p as DrawingPoint).time) && Number.isFinite((p as DrawingPoint).price));
}

export function serializeDrawings(items: readonly Drawing[]): string {
  const payload: Stored = { v: VERSION, items: items.filter(isValidDrawing) };
  return JSON.stringify(payload);
}

export function parseDrawings(raw: string | null | undefined): Drawing[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Partial<Stored> | Drawing[];
    const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : [];
    return items.filter(isValidDrawing);
  } catch {
    return [];
  }
}

export function drawingsStorageKey(tradeId: number | string): string {
  return `${KEY_PREFIX}${tradeId}`;
}

export function loadDrawings(tradeId: number | string): Drawing[] {
  try {
    if (typeof localStorage === "undefined") return [];
    return parseDrawings(localStorage.getItem(drawingsStorageKey(tradeId)));
  } catch {
    return [];
  }
}

export function saveDrawings(tradeId: number | string, items: readonly Drawing[]): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    const key = drawingsStorageKey(tradeId);
    if (!items.length) localStorage.removeItem(key);
    else localStorage.setItem(key, serializeDrawings(items));
    return true;
  } catch {
    return false;
  }
}

/** Geometry helper: distance from point to segment (in pixels), used by hit-testing. */
export function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}
