// Offerings table filters: one plain object, persisted per user, with saved presets.
import { dealTypeOf, dilutionScore, discountOf, type DealType } from "./score";
import { pctOfMcap, type Offering } from "./types";
import { offeringsI18n } from "@/i18n/ns/offerings";

export type OfferingFilters = {
  types: DealType[];
  /** Deal size ≥ X % of market cap. */
  minPctMcap: number | null;
  /** Discount to the last close ≥ X % (absolute). */
  minDiscount: number | null;
  priceMin: number | null;
  priceMax: number | null;
  /** Float ≤ X million shares. */
  floatMaxM: number | null;
  /** Market cap ≤ $X M. */
  mcapMaxM: number | null;
  minScore: number | null;
  mine: boolean;
};

export const EMPTY_FILTERS: OfferingFilters = {
  types: [],
  minPctMcap: null,
  minDiscount: null,
  priceMin: null,
  priceMax: null,
  floatMaxM: null,
  mcapMaxM: null,
  minScore: null,
  mine: false,
};

export type FilterPreset = { id: string; readonly name: string; filters: OfferingFilters; builtin?: boolean };

/** Built-in preset names follow the UI language (getters); user presets keep the name they typed. */
export const BUILTIN_PRESETS: FilterPreset[] = [
  {
    id: "short",
    get name() { return offeringsI18n.t("filters.presetShort"); },
    builtin: true,
    filters: { ...EMPTY_FILTERS, types: ["spo", "direct", "pipe", "atm"], minPctMcap: 10, priceMin: 1, mcapMaxM: 2000, minScore: 50 },
  },
  {
    id: "small",
    get name() { return offeringsI18n.t("filters.presetSmall"); },
    builtin: true,
    filters: { ...EMPTY_FILTERS, mcapMaxM: 300, priceMax: 20 },
  },
  {
    id: "big",
    get name() { return offeringsI18n.t("filters.presetBig"); },
    builtin: true,
    filters: { ...EMPTY_FILTERS, minPctMcap: 20, types: ["spo", "direct", "pipe", "atm", "s1"] },
  },
];

const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Sanitise a stored object (older versions, hand-edited storage). */
export function normalizeFilters(raw: unknown): OfferingFilters {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof OfferingFilters, unknown>>;
  const types = Array.isArray(r.types) ? r.types.filter((t): t is DealType => ["spo", "direct", "pipe", "atm", "shelf", "s1", "ipo"].includes(String(t))) : [];
  return {
    types,
    minPctMcap: numOrNull(r.minPctMcap),
    minDiscount: numOrNull(r.minDiscount),
    priceMin: numOrNull(r.priceMin),
    priceMax: numOrNull(r.priceMax),
    floatMaxM: numOrNull(r.floatMaxM),
    mcapMaxM: numOrNull(r.mcapMaxM),
    minScore: numOrNull(r.minScore),
    mine: r.mine === true,
  };
}

export function activeFilterCount(f: OfferingFilters): number {
  let n = 0;
  if (f.types.length) n++;
  if (f.minPctMcap != null) n++;
  if (f.minDiscount != null) n++;
  if (f.priceMin != null || f.priceMax != null) n++;
  if (f.floatMaxM != null) n++;
  if (f.mcapMaxM != null) n++;
  if (f.minScore != null) n++;
  if (f.mine) n++;
  return n;
}

export function sameFilters(a: OfferingFilters, b: OfferingFilters): boolean {
  return JSON.stringify(normalizeFilters(a)) === JSON.stringify(normalizeFilters(b));
}

/**
 * Keep rows that pass every set filter. A row with no value for a numeric filter fails it
 * (a «мкап ≤ 300M» filter must not show names whose cap is unknown).
 */
export function matchesFilters(o: Offering, f: OfferingFilters, isMine: (ticker: string) => boolean): boolean {
  if (f.mine && !isMine(o.ticker)) return false;
  if (f.types.length && !f.types.includes(dealTypeOf(o))) return false;
  if (f.minPctMcap != null) {
    const p = pctOfMcap(o);
    if (p == null || p < f.minPctMcap) return false;
  }
  if (f.minDiscount != null) {
    const d = discountOf(o);
    if (d == null || -d < f.minDiscount) return false;
  }
  const price = o.currentPrice ?? o.offerPrice;
  if (f.priceMin != null && (price == null || price < f.priceMin)) return false;
  if (f.priceMax != null && (price == null || price > f.priceMax)) return false;
  if (f.floatMaxM != null && (o.floatShares == null || o.floatShares / 1e6 > f.floatMaxM)) return false;
  if (f.mcapMaxM != null && (o.marketCapM == null || o.marketCapM > f.mcapMaxM)) return false;
  if (f.minScore != null && dilutionScore(o).score < f.minScore) return false;
  return true;
}

/** Short human summary of the set filters (preset tooltip, empty-state hint). */
export function describeFilters(f: OfferingFilters): string {
  const t = offeringsI18n.t;
  const parts: string[] = [];
  if (f.types.length) parts.push(f.types.map((x) => x.toUpperCase()).join("/"));
  if (f.minPctMcap != null) parts.push(t("filters.descPctMcap", { value: f.minPctMcap }));
  if (f.minDiscount != null) parts.push(t("filters.descDiscount", { value: f.minDiscount }));
  if (f.priceMin != null || f.priceMax != null) parts.push(t("filters.descPrice", { min: f.priceMin ?? 0, max: f.priceMax ?? "∞" }));
  if (f.floatMaxM != null) parts.push(t("filters.descFloat", { value: f.floatMaxM }));
  if (f.mcapMaxM != null) parts.push(t("filters.descMcap", { value: f.mcapMaxM }));
  if (f.minScore != null) parts.push(t("filters.descScore", { value: f.minScore }));
  if (f.mine) parts.push(t("filters.descMine"));
  return parts.join(" · ") || t("filters.descNone");
}
