/**
 * @workspace/text-search — cross-script (RU / EN / UZ) name search shared by the web app and the API.
 *
 *   searchItems(people, "zokir", (p) => [p.name, p.nameLatin])   → ranked hits (exact > prefix > substring > fuzzy)
 *   matchesAny("Rakhmatullo", "Рахматулло")                       → true
 *   matchText("Pfrbh", "Закир")                                   → keyboard-layout slip, matched
 */
export { literal, translit, translitVariants, latinizeName, skeleton, tokenize, hasCyrillic, hasLatin, type Token } from "./normalize";
export { switchLayout } from "./layout";
export { damerauLevenshtein } from "./distance";
export {
  prepareQuery, prepareText, matchText, matchesAny, searchItems, highlightSegments, TIER_RANK,
  type MatchTier, type MatchResult, type PreparedQuery, type PreparedText, type SearchField, type SearchHit,
} from "./match";
