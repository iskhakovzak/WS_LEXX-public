/**
 * What-if rule contract shared by the what-if page and the analytics «Что если» tab: the rule shapes and the
 * URL encoding used by «Открыть Что если» links (?rules=…). The rule engine and editors live in components/what-if.
 */

export type Side = "long" | "short";

export type CommissionPlan = { type: "commissionPlan"; perShare: number; minPerOrder: number; ecnPerShare: number; keepRegulatory?: boolean };

export type Rule =
  | { type: "dailyLossLimit"; usd: number }
  | { type: "maxTradesPerDay"; n: number }
  | { type: "stopAfterLosses"; n: number }
  | { type: "timeWindow"; from?: string | null; to?: string | null }
  | { type: "priceRange"; min?: number | null; max?: number | null }
  | { type: "minHold"; seconds: number }
  | { type: "excludeTickers"; tickers: string[] }
  | { type: "excludeSide"; side: Side }
  | CommissionPlan
  | { type: "capLoss"; usd: number }
  | { type: "sizeRange"; min?: number | null; max?: number | null }
  | { type: "afterLoss"; minutes: number }
  | { type: "excludeSetups"; setups: string[] }
  | { type: "minGrade"; grade: Grade };

export const GRADES = ["A+", "A", "B", "C"] as const;
export type Grade = (typeof GRADES)[number];

/** Rules → compact URL-safe string (base64url of JSON). Empty list → "". */
export function encodeRules(rules: Rule[]): string {
  if (!rules.length) return "";
  const json = JSON.stringify(rules);
  const b64 = typeof btoa === "function" ? btoa(unescape(encodeURIComponent(json))) : Buffer.from(json, "utf8").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
