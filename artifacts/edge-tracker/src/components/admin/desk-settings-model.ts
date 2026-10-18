/**
 * Desk settings form — pure model (unit-tested in desk-settings-model.test.ts). Shapes mirror the server
 * (artifacts/api-server/src/lib/settings: registry.ts + store.ts SettingState); the form never hard-codes keys, it
 * renders whatever GET /api/admin/settings returns.
 *
 *   inputOf / parseInput   number ⇄ input text (ratio shown as %, 0.5 ⇄ "50")
 *   checkValue             the server's checks (lib/settings/validate.ts), for inline errors before saving
 *   normalize              a value equal to the default is sent as null («по умолчанию»: no stored override)
 *   nyToTashkent           "16:30" NY → "01:30" Tashkent, +1 day (today's DST offsets)
 */
export type SettingUnit = "usd" | "pct" | "days" | "points" | "minutes" | "count" | "ratio";
type Base = { group: string; unit?: SettingUnit };
export type SettingDef =
  | (Base & { type: "number"; default: number; min: number; max: number; step?: number })
  | (Base & { type: "time"; default: string })
  | (Base & { type: "boolean"; default: boolean })
  | (Base & { type: "select"; default: string; options: readonly string[] });
export type SettingValue = number | boolean | string;

export interface SettingRow {
  key: string;
  def: SettingDef;
  value: SettingValue | null;
  effective: SettingValue;
  default: SettingValue;
  updatedBy: string | null;
  updatedAt: string | null;
}

export type ProblemKind = "empty" | "type" | "range" | "integer" | "time" | "option" | "unknown" | "duplicate";
export interface Problem { key: string; kind: ProblemKind; min?: number; max?: number; options?: readonly string[] }

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Groups in display order; a group the page does not know goes last, in registry order. */
export const GROUP_ORDER = ["daily", "discipline", "rewards", "telegram", "curator", "privacy"] as const;

export function groupRows(rows: readonly SettingRow[]): { group: string; rows: SettingRow[] }[] {
  const by = new Map<string, SettingRow[]>();
  for (const r of rows) {
    const g = r.def.group || "other";
    const l = by.get(g);
    if (l) l.push(r); else by.set(g, [r]);
  }
  const known = GROUP_ORDER.filter((g) => by.has(g));
  const rest = [...by.keys()].filter((g) => !(GROUP_ORDER as readonly string[]).includes(g));
  return [...known, ...rest].map((group) => ({ group, rows: by.get(group)! }));
}

const isRatio = (d: SettingDef) => d.type === "number" && d.unit === "ratio";
const round = (v: number, dp = 6) => Math.round(v * 10 ** dp) / 10 ** dp;

/** Number as shown in the input / text (ratio → percent). */
export function shownNumber(def: SettingDef, v: number): number {
  return isRatio(def) ? round(v * 100, 4) : v;
}

/** Bounds and step as shown (ratio → percent). */
export function shownBounds(def: Extract<SettingDef, { type: "number" }>): { min: number; max: number; step: number } {
  const k = isRatio(def) ? 100 : 1;
  return { min: round(def.min * k, 4), max: round(def.max * k, 4), step: round((def.step ?? (isRatio(def) ? 0.01 : 1)) * k, 4) };
}

export function inputOf(def: SettingDef, v: SettingValue): string {
  return def.type === "number" && typeof v === "number" ? String(shownNumber(def, v)) : String(v);
}

/** Input text → stored number (ratio: percent → share) or a problem. */
export function parseInput(key: string, def: SettingDef, text: string): { ok: true; value: number } | { ok: false; problem: Problem } {
  const s = text.trim().replace(",", ".").replace("−", "-");
  if (!s) return { ok: false, problem: { key, kind: "empty" } };
  if (!/^-?\d+(\.\d+)?$/.test(s)) return { ok: false, problem: { key, kind: "type" } };
  const n = Number(s);
  return { ok: true, value: isRatio(def) ? round(n / 100) : n };
}

/** The server's validation (lib/settings/validate.ts); bounds in the problem are as shown (percent for ratios). */
export function checkValue(key: string, def: SettingDef, v: SettingValue): Problem | null {
  switch (def.type) {
    case "number": {
      if (typeof v !== "number" || !Number.isFinite(v)) return { key, kind: "type" };
      if (v < def.min || v > def.max) {
        const b = shownBounds(def);
        return { key, kind: "range", min: b.min, max: b.max };
      }
      if (def.step != null && Number.isInteger(def.step) && !Number.isInteger(v)) return { key, kind: "integer" };
      return null;
    }
    case "time":
      return typeof v === "string" && TIME_RE.test(v) ? null : { key, kind: "time" };
    case "boolean":
      return typeof v === "boolean" ? null : { key, kind: "type" };
    case "select":
      return typeof v === "string" && def.options.includes(v) ? null : { key, kind: "option" };
  }
}

/** A server problem's bounds converted to what the field shows (ratio → percent). */
export function shownProblem(def: SettingDef | undefined, p: Problem): Problem {
  if (!def || !isRatio(def) || p.kind !== "range") return p;
  return { ...p, min: p.min == null ? p.min : round(p.min * 100, 4), max: p.max == null ? p.max : round(p.max * 100, 4) };
}

/** null when the value is the default («по умолчанию»), else the value. */
export function normalize(row: SettingRow, v: SettingValue | null): SettingValue | null {
  return v === null || v === row.default ? null : v;
}

/** Draft entries that differ from what is stored, as the PUT batch. */
export function changesOf(rows: readonly SettingRow[], draft: Readonly<Record<string, SettingValue | null>>): { key: string; value: SettingValue | null }[] {
  const out: { key: string; value: SettingValue | null }[] = [];
  for (const r of rows) {
    if (!(r.key in draft)) continue;
    const v = normalize(r, draft[r.key]);
    if (v !== r.value) out.push({ key: r.key, value: v });
  }
  return out;
}

// ─── New York → Tashkent ────────────────────────────────────────────────────

/** Minutes east of UTC of `timeZone` at `at`. */
export function tzOffsetMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(at);
  const get = (t: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"));
  return Math.round((asUtc - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000);
}

/** "HH:MM" New York → Tashkent time on the day of `at` (today's offsets): { time, dayShift: −1 | 0 | 1 }. */
export function nyToTashkent(hhmm: string, at: Date = new Date()): { time: string; dayShift: number } | null {
  if (!TIME_RE.test(hhmm)) return null;
  const ny = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const t = ny - tzOffsetMinutes("America/New_York", at) + tzOffsetMinutes("Asia/Tashkent", at);
  const dayShift = Math.floor(t / 1440);
  const m = ((t % 1440) + 1440) % 1440;
  return { time: `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`, dayShift };
}
