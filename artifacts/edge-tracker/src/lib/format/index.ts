/**
 * The one formatting module (ARCHITECTURE.md §1 rule 6). Feature code imports formatters from "@/lib/format" only;
 * no local fmtUsd / fmtPct / fmtR / plural copies, no "ru-RU", no module-level `new Intl.*` with the UI locale.
 *
 * Trading format, identical in RU / EN / UZ (en-US digits, U+2212 minus):
 *   fmtUsd(1234.5)                          → "$1,234.50"
 *   fmtUsd(1234.5, { signed: true })        → "+$1,234.50"      (P&L)
 *   fmtUsd(-1234.5, { decimals: "auto" })   → "−$1,235"         (no cents from $1,000)
 *   fmtUsd(500, { decimals: "trim" })       → "$500"            (no cents for whole dollars)
 *   fmtUsd(12345, { compact: true })        → "$12.3K"          (compact: 10_000 → only from $10,000)
 *   fmtPct(1.234)                           → "+1.23%"          (value in percent, signed)
 *   fmtRate(0.571)                          → "57%"             (share 0…1: win rate, progress)
 *   fmtR(0.214)                             → "+0.21R"
 *   fmtPrice(920.74) / fmtPrice(0.4521)     → "920.74" / "0.4521"
 *   fmtNum(1.857) / fmtRatio(Infinity)      → "1.86" / "∞"      (PF, ratios)
 *   fmtCompact(3_400_000)                   → "3.4M"            (volume, shares)
 * Follow the UI language (read at call time):
 *   fmtCount(1234)                          → "1 234" / "1,234"
 *   fmtDate(d, "dayMonth"), fmtMonth, fmtWeekday, fmtRelative, fmtTimeNY, fmtDateCustom
 * Plurals: commonI18n.t("units.trades", { count }) for common units; pluralRu(n, one, few, many) for feature
 * nouns until the translation wave (see plural.ts).
 * Every formatter returns "—" (or `fallback`) for null / "" / NaN / ±Infinity, and never "−0".
 */
export { fmtUsd, type MoneyOptions, type MoneyDecimals } from "./money";
export { fmtPct, fmtRate, type PctOptions } from "./percent";
export { fmtR, type ROptions } from "./r";
export { fmtPrice, type PriceOptions } from "./price";
export { fmtNum, fmtRatio, fmtCompact, fmtCount, type NumOptions } from "./number";
export * from "./date";
export { pluralRu } from "./plural";
export { MINUS, toNum, type NumLike } from "./internal";
