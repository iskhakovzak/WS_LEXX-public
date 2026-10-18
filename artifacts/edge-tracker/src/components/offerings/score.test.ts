import { describe, expect, it } from "vitest";
import { cleanUnderwriter, dealTypeOf, dilutionScore, discountOf, advMultiple, pctOfFloat } from "./score";
import { EMPTY_FILTERS, activeFilterCount, matchesFilters, normalizeFilters } from "./filters";
import { fmtPctCap, type Offering } from "./types";

function off(p: Partial<Offering> = {}): Offering {
  return {
    ticker: "ABC", company: "Abc Inc", type: "Follow-on", date: "2026-10-16",
    offerPrice: 4, currentPrice: 4.2, priceChangePct: 5, dealSizeM: 20, sharesOffered: 5_000_000,
    sharesOutstandingBefore: null, sharesOutstandingAfter: null, dilutionPct: null,
    sellerType: "company", insiderShares: null, companyShares: null, underwriter: null, lockupDays: null,
    volume: null, avgVolume: 2_500_000, relVol: null, marketCapM: 80, sector: null,
    rating: 50, ratingFactors: [], status: "trading", source: "edgar",
    kind: "424B", form: "424B5", dealFlags: [], ...p,
  };
}

describe("dealTypeOf", () => {
  it("maps kinds and flags", () => {
    expect(dealTypeOf(off())).toBe("spo");
    expect(dealTypeOf(off({ dealFlags: ["Registered direct"] }))).toBe("direct");
    expect(dealTypeOf(off({ dealFlags: ["Частное размещение"] }))).toBe("pipe");
    expect(dealTypeOf(off({ kind: "ATM" }))).toBe("atm");
    expect(dealTypeOf(off({ kind: "S-3" }))).toBe("shelf");
    expect(dealTypeOf(off({ kind: "IPO", type: "IPO" }))).toBe("ipo");
  });
});

describe("derived numbers", () => {
  it("ADV multiple, % float, discount", () => {
    expect(advMultiple(off())).toBe(2);
    expect(pctOfFloat(off({ floatShares: 20_000_000 }))).toBe(25);
    expect(discountOf(off({ prevClose: 5 }))).toBe(-20);
    expect(discountOf(off({ prevClose: 5, discountPct: null }))).toBeNull(); // server rejected it
    expect(discountOf(off({ prevClose: 1 }))).toBeNull(); // +300%: garbage offer price
  });
  it("caps absurd % of market cap", () => {
    expect(fmtPctCap(42496.6)).toBe(">1000%");
    expect(fmtPctCap(250.4)).toBe("250%");
    expect(fmtPctCap(12.34)).toBe("12.3%");
  });
});

describe("dilutionScore", () => {
  it("big discounted direct with warrants from a cash-poor serial issuer scores high", () => {
    const s = dilutionScore(off({
      dealSizeM: 40, marketCapM: 80, prevClose: 5.5, floatShares: 15_000_000,
      dealFlags: ["Registered direct", "Варранты"], priorOfferings12m: 3, runwayMonths: 4, cashM: 6,
    }));
    expect(s.level).toBe("high");
    expect(s.score).toBeGreaterThanOrEqual(85);
    expect(s.missing).toEqual([]);
    expect(s.parts.map((p) => p.key)).toEqual(["size", "liquidity", "discount", "type", "frequency", "cash"]);
  });
  it("small premium SPO from a cash-positive company scores low", () => {
    const s = dilutionScore(off({ dealSizeM: 10, marketCapM: 2000, prevClose: 3.9, priorOfferings12m: 0, burnM: 0, avgVolume: 50_000_000 }));
    expect(s.level).toBe("low");
    expect(s.score).toBeLessThan(40);
  });
  it("missing parts drop out and the rest is rescaled", () => {
    const s = dilutionScore(off({ marketCapM: null, dealSizeM: null, sharesOffered: null, avgVolume: null }));
    expect(s.missing).toContain("Размер к капитализации");
    expect(s.parts.map((p) => p.key)).toEqual(["type"]);
    expect(s.rough).toBe(true);
    expect(s.score).toBe(60); // 12 / 20
  });
  it("shelf capacity counts half", () => {
    const shelf = dilutionScore(off({ kind: "S-3", dealSizeM: null, shelfCapacityM: 100, marketCapM: 100, offerPctOfMcap: 100 }));
    const size = shelf.parts.find((p) => p.key === "size")!;
    expect(size.points).toBe(18);
  });
});

describe("cleanUnderwriter", () => {
  it("keeps names, drops fragments", () => {
    expect(cleanUnderwriter("H.C. Wainwright & Co.")).toBe("H.C. Wainwright & Co.");
    expect(cleanUnderwriter("Placement Agent fees and expenses")).toBeNull();
    expect(cleanUnderwriter("September Placement")).toBeNull();
    expect(cleanUnderwriter("the underwriters")).toBeNull();
    expect(cleanUnderwriter(null)).toBeNull();
  });
});

describe("filters", () => {
  const mine = (t: string) => t === "ABC";
  it("unknown values fail numeric filters", () => {
    expect(matchesFilters(off({ marketCapM: null }), { ...EMPTY_FILTERS, mcapMaxM: 300 }, mine)).toBe(false);
    expect(matchesFilters(off(), { ...EMPTY_FILTERS, mcapMaxM: 300 }, mine)).toBe(true);
  });
  it("type, discount, price, mine", () => {
    const o = off({ prevClose: 5 });
    expect(matchesFilters(o, { ...EMPTY_FILTERS, types: ["atm"] }, mine)).toBe(false);
    expect(matchesFilters(o, { ...EMPTY_FILTERS, minDiscount: 15 }, mine)).toBe(true);
    expect(matchesFilters(o, { ...EMPTY_FILTERS, minDiscount: 25 }, mine)).toBe(false);
    expect(matchesFilters(o, { ...EMPTY_FILTERS, priceMax: 3 }, mine)).toBe(false);
    expect(matchesFilters(off({ ticker: "XYZ" }), { ...EMPTY_FILTERS, mine: true }, mine)).toBe(false);
  });
  it("normalize + count", () => {
    const f = normalizeFilters({ types: ["spo", "bogus"], minScore: "50", mine: true });
    expect(f.types).toEqual(["spo"]);
    expect(f.minScore).toBeNull();
    expect(activeFilterCount(f)).toBe(2);
  });
});
