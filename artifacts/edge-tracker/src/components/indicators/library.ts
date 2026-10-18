/**
 * Indicator library for a prop desk. Extends the base list in `@/data/indicators` (ids/tags kept so trade matching
 * stays compatible) with horizons, combos and a sparkline kind. All human text (name, timeframe, summary, desk usage,
 * settings, signals, pitfalls) lives in the `indicatorLibrary` namespace and is read through getters, so it follows
 * the UI language at render time. A few desk-specific tools are added on top.
 */
import { INDICATORS as BASE } from "@/data/indicators";
import type { Tone } from "@/components/ds";
import { indicatorLibraryI18n } from "@/i18n/ns/indicatorLibrary";
import { indicatorsI18n } from "@/i18n/ns/indicators";

export type LibCategory = "trend" | "momentum" | "volume" | "volatility" | "levels" | "pattern";
export type Horizon = "intraday" | "overnight" | "swing";
export type HorizonFit = Record<Horizon, 0 | 1 | 2 | 3>;

export type SparkKind =
  | "ma" | "ema" | "osc" | "macd" | "vwap" | "avwap" | "bands" | "atr" | "vprofile" | "fib" | "levels"
  | "volume" | "obv" | "rvol" | "rs" | "hammer" | "engulfing" | "doji" | "hs" | "dtdb" | "flag" | "gap" | "orb" | "pm";

export interface LibIndicator {
  id: string;
  shortName: string;
  name: string;
  enName: string;
  category: LibCategory;
  strength: 1 | 2 | 3 | 4 | 5;
  tags: string[];
  timeframe: string;
  horizons: HorizonFit;
  summary: string;
  deskUse: string;
  settings: { label: string; value: string }[];
  signals: { long: string; short: string; avoid: string };
  pitfalls: string[];
  combos: string[];
  spark: SparkKind;
  playbookQuery: string;
}

type CategoryMeta = { readonly label: string; tone: Tone };
const CATEGORY_TONE: Record<LibCategory, Tone> = {
  trend: "accent", momentum: "purple", volume: "up", volatility: "warn", levels: "neutral", pattern: "down",
};
/** Label + tone per category; labels are getters (UI language at read time). */
export const CATEGORY_META = Object.fromEntries(
  (Object.keys(CATEGORY_TONE) as LibCategory[]).map((c): [LibCategory, CategoryMeta] => [
    c,
    { get label() { return indicatorsI18n.t(`category.${c}`); }, tone: CATEGORY_TONE[c] },
  ]),
) as Record<LibCategory, CategoryMeta>;
export const CATEGORY_ORDER: LibCategory[] = ["trend", "momentum", "volume", "volatility", "levels", "pattern"];

type HorizonMeta = { readonly label: string; readonly short: string; readonly hint: string };
export const HORIZONS: Horizon[] = ["intraday", "overnight", "swing"];
export const HORIZON_META = Object.fromEntries(
  HORIZONS.map((h): [Horizon, HorizonMeta] => [h, {
    get label() { return indicatorsI18n.t(`horizon.${h}.label`); },
    get short() { return indicatorsI18n.t(`horizon.${h}.short`); },
    get hint() { return indicatorsI18n.t(`horizon.${h}.hint`); },
  }]),
) as Record<Horizon, HorizonMeta>;

/** Fit word for a 0..3 horizon fit. */
export function fitWord(v: number): string {
  const key = (["none", "weak", "good", "great"] as const)[Math.max(0, Math.min(3, v))];
  return indicatorsI18n.t(`fit.${key}`);
}

type Entry = Pick<LibIndicator, "id" | "shortName" | "category" | "spark" | "playbookQuery" | "horizons" | "combos"> & {
  tags?: string[];
  enName?: string;
  strength?: LibIndicator["strength"];
};

const ENTRIES: Entry[] = [
  {
    id: "vwap", shortName: "VWAP", category: "volume", spark: "vwap", playbookQuery: "VWAP",
    horizons: { intraday: 3, overnight: 1, swing: 0 },
    combos: ["rvol", "ema", "orb"],
  },
  {
    id: "avwap", shortName: "AVWAP", enName: "Anchored VWAP", category: "volume", spark: "avwap", playbookQuery: "AVWAP", strength: 4,
    tags: ["avwap", "anchored vwap", "anchored"],
    horizons: { intraday: 2, overnight: 3, swing: 3 },
    combos: ["vwap", "gap", "volume-profile"],
  },
  {
    id: "rvol", shortName: "RVOL", category: "volume", spark: "rvol", playbookQuery: "RVOL",
    horizons: { intraday: 3, overnight: 2, swing: 1 },
    combos: ["gap", "pm", "vwap"],
  },
  {
    id: "pm", shortName: "PM H/L", enName: "Premarket High / Low", category: "levels", spark: "pm", playbookQuery: "премаркет", strength: 4, // i18n-ignore (playbook search query over user content)
    tags: ["pm", "premarket", "premarket high", "pmh", "pml", "премаркет"], // i18n-ignore (trade tag synonyms)
    horizons: { intraday: 3, overnight: 1, swing: 0 },
    combos: ["rvol", "orb", "gap"],
  },
  {
    id: "orb", shortName: "ORB", enName: "Opening Range Breakout", category: "levels", spark: "orb", playbookQuery: "ORB", strength: 4,
    tags: ["orb", "opening range", "opening range breakout"],
    horizons: { intraday: 3, overnight: 0, swing: 0 },
    combos: ["pm", "vwap", "rvol"],
  },
  {
    id: "rs", shortName: "RS", enName: "Relative Strength vs index", category: "momentum", spark: "rs", playbookQuery: "relative strength", strength: 4,
    tags: ["rs", "relative strength", "rs vs spy", "rs/rw"],
    horizons: { intraday: 3, overnight: 2, swing: 3 },
    combos: ["vwap", "ema", "ma"],
  },
  {
    id: "ema", shortName: "EMA", category: "trend", spark: "ema", playbookQuery: "EMA",
    horizons: { intraday: 3, overnight: 2, swing: 2 },
    combos: ["vwap", "rvol", "atr"],
  },
  {
    id: "ma", shortName: "SMA", category: "trend", spark: "ma", playbookQuery: "SMA",
    horizons: { intraday: 1, overnight: 2, swing: 3 },
    combos: ["rs", "atr", "volume-profile"],
  },
  {
    id: "rsi", shortName: "RSI", category: "momentum", spark: "osc", playbookQuery: "RSI",
    horizons: { intraday: 2, overnight: 1, swing: 2 },
    combos: ["bollinger", "support-resistance", "volume"],
  },
  {
    id: "macd", shortName: "MACD", category: "momentum", spark: "macd", playbookQuery: "MACD",
    horizons: { intraday: 1, overnight: 2, swing: 2 },
    combos: ["rsi", "ema", "volume"],
  },
  {
    id: "bollinger", shortName: "BB", category: "volatility", spark: "bands", playbookQuery: "Bollinger",
    horizons: { intraday: 2, overnight: 1, swing: 2 },
    combos: ["rsi", "atr", "rvol"],
  },
  {
    id: "atr", shortName: "ATR", category: "volatility", spark: "atr", playbookQuery: "ATR",
    horizons: { intraday: 3, overnight: 3, swing: 3 },
    combos: ["bollinger", "vwap", "gap"],
  },
  {
    id: "volume-profile", shortName: "VP", category: "volume", spark: "vprofile", playbookQuery: "volume profile",
    horizons: { intraday: 2, overnight: 2, swing: 3 },
    combos: ["avwap", "support-resistance", "vwap"],
  },
  {
    id: "stochastic", shortName: "Stoch", category: "momentum", spark: "osc", playbookQuery: "Stochastic",
    horizons: { intraday: 1, overnight: 1, swing: 2 },
    combos: ["ema", "support-resistance", "rsi"],
  },
  {
    id: "fibonacci", shortName: "Fib", category: "levels", spark: "fib", playbookQuery: "Fibonacci",
    horizons: { intraday: 1, overnight: 2, swing: 2 },
    combos: ["vwap", "support-resistance", "volume"],
  },
  {
    id: "support-resistance", shortName: "S/R", category: "levels", spark: "levels", playbookQuery: "уровень", // i18n-ignore (playbook search query over user content)
    horizons: { intraday: 3, overnight: 3, swing: 3 },
    combos: ["volume-profile", "pm", "atr"],
  },
  {
    id: "volume", shortName: "Vol", enName: "Volume", category: "volume", spark: "volume", playbookQuery: "объём", strength: 4, // i18n-ignore (playbook search query over user content)
    tags: ["volume", "vol", "объём"], // i18n-ignore (trade tag synonyms)
    horizons: { intraday: 3, overnight: 2, swing: 3 },
    combos: ["vwap", "rvol", "flag-pennant"],
  },
  {
    id: "obv", shortName: "OBV", category: "volume", spark: "obv", playbookQuery: "OBV",
    horizons: { intraday: 1, overnight: 1, swing: 2 },
    combos: ["ma", "rs", "volume-profile"],
  },
  {
    id: "gap", shortName: "Gap", category: "pattern", spark: "gap", playbookQuery: "gap",
    horizons: { intraday: 3, overnight: 3, swing: 2 },
    combos: ["rvol", "pm", "atr"],
  },
  {
    id: "flag-pennant", shortName: "Flag", category: "pattern", spark: "flag", playbookQuery: "flag",
    horizons: { intraday: 3, overnight: 1, swing: 3 },
    combos: ["volume", "ema", "vwap"],
  },
  {
    id: "hammer", shortName: "Hammer", category: "pattern", spark: "hammer", playbookQuery: "hammer",
    horizons: { intraday: 2, overnight: 1, swing: 2 },
    combos: ["support-resistance", "volume", "vwap"],
  },
  {
    id: "engulfing", shortName: "Engulf", category: "pattern", spark: "engulfing", playbookQuery: "engulfing",
    horizons: { intraday: 2, overnight: 1, swing: 2 },
    combos: ["support-resistance", "volume", "ma"],
  },
  {
    id: "doji", shortName: "Doji", category: "pattern", spark: "doji", playbookQuery: "doji",
    horizons: { intraday: 1, overnight: 1, swing: 1 },
    combos: ["support-resistance", "rsi", "volume"],
  },
  {
    id: "head-shoulders", shortName: "H&S", category: "pattern", spark: "hs", playbookQuery: "head and shoulders",
    horizons: { intraday: 1, overnight: 2, swing: 3 },
    combos: ["volume", "support-resistance", "ma"],
  },
  {
    id: "double-top-bottom", shortName: "DT/DB", category: "pattern", spark: "dtdb", playbookQuery: "double",
    horizons: { intraday: 2, overnight: 1, swing: 2 },
    combos: ["volume", "vwap", "rsi"],
  },
];

const BASE_BY_ID = new Map(BASE.map((b) => [b.id, b]));

const SETTING_KEYS = ["s1", "s2", "s3", "s4", "s5"] as const;
const PITFALL_KEYS = ["p1", "p2", "p3", "p4", "p5"] as const;

/** Text of one library entry in the current language (`fallback` when the key is missing). */
function txt(id: string, path: string, fallback = ""): string {
  return indicatorLibraryI18n.tryT(`${id}.${path}`) ?? fallback;
}

export const LIBRARY: LibIndicator[] = ENTRIES.map((e) => {
  const base = BASE_BY_ID.get(e.id);
  const tags = Array.from(new Set([...(base?.tags ?? []), ...(e.tags ?? []), e.shortName.toLowerCase()]));
  const id = e.id;
  return {
    id,
    shortName: e.shortName,
    category: e.category,
    spark: e.spark,
    playbookQuery: e.playbookQuery,
    horizons: e.horizons,
    combos: e.combos,
    enName: e.enName ?? base?.name ?? e.shortName,
    strength: e.strength ?? base?.signalStrength ?? 3,
    tags,
    get name() { return txt(id, "name", e.shortName); },
    get timeframe() { return txt(id, "timeframe"); },
    get summary() { return txt(id, "summary"); },
    get deskUse() { return txt(id, "deskUse"); },
    get settings() {
      const out: { label: string; value: string }[] = [];
      for (const k of SETTING_KEYS) {
        const label = indicatorLibraryI18n.tryT(`${id}.settings.${k}.label`);
        if (label === undefined) break;
        out.push({ label, value: txt(id, `settings.${k}.value`) });
      }
      return out;
    },
    get signals() {
      return { long: txt(id, "signals.long", "—"), short: txt(id, "signals.short", "—"), avoid: txt(id, "signals.avoid", "—") };
    },
    get pitfalls() {
      const out: string[] = [];
      for (const k of PITFALL_KEYS) {
        const p = indicatorLibraryI18n.tryT(`${id}.pitfalls.${k}`);
        if (p === undefined) break;
        out.push(p);
      }
      return out;
    },
  };
});

// Base entries without a library profile are still shown (never drop data). The base list is English reference data.
for (const b of BASE) {
  if (LIBRARY.some((l) => l.id === b.id)) continue;
  LIBRARY.push({
    id: b.id, shortName: b.shortName, name: b.name, enName: b.name,
    category: b.category === "pattern" ? "pattern" : b.category,
    strength: b.signalStrength, tags: b.tags, timeframe: b.bestTimeframe,
    horizons: { intraday: 2, overnight: 1, swing: 2 },
    summary: b.description, deskUse: b.description, settings: [],
    signals: { long: b.useCases[0] ?? "—", short: b.useCases[1] ?? "—", avoid: b.commonMistakes[0] ?? "—" },
    pitfalls: b.commonMistakes, combos: [], spark: "ma", playbookQuery: b.shortName,
  });
}

export const LIB_BY_ID = new Map(LIBRARY.map((l) => [l.id, l]));

export type DeskPresetId = "gap-go" | "overnight" | "swing";
export type DeskPreset = { id: DeskPresetId; readonly label: string; horizon: Horizon; readonly description: string; ids: string[] };
const PRESET_DEFS: { id: DeskPresetId; horizon: Horizon; ids: string[] }[] = [
  { id: "gap-go", horizon: "intraday", ids: ["rvol", "pm", "vwap", "orb", "ema"] },
  { id: "overnight", horizon: "overnight", ids: ["atr", "avwap", "gap", "support-resistance", "volume-profile"] },
  { id: "swing", horizon: "swing", ids: ["ma", "rs", "atr", "flag-pennant", "volume"] },
];
/** Ready-made desk presets that can be merged into the trader's set. */
export const DESK_PRESETS: DeskPreset[] = PRESET_DEFS.map((p) => ({
  ...p,
  get label() { return indicatorsI18n.t(`presets.${p.id}.label`); },
  get description() { return indicatorsI18n.t(`presets.${p.id}.description`); },
}));
