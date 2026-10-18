/**
 * Ranked fuzzy matching of a query against short texts (people's names, aliases, labels).
 *
 * Every query word must match some word of the text. Per word the best of:
 *   tier   exact (4) > word prefix (3) > substring / initial (2) > fuzzy (1)
 *   level  literal (+4, same script) > translit (+2, cross-script) > skeleton (+0, phonetic)
 * Fuzzy = Damerau–Levenshtein on skeletons: ≤1 for words of ≥4 letters, ≤2 for ≥8.
 * The query is also tried in the other keyboard layout («Pfrbh» → «закир») with a small penalty.
 */
import { damerauLevenshtein } from "./distance";
import { switchLayout } from "./layout";
import { literal, skeleton, tokenize, translitVariants } from "./normalize";

export type MatchTier = "exact" | "prefix" | "substring" | "fuzzy";
const TIER_NAME: Record<number, MatchTier> = { 4: "exact", 3: "prefix", 2: "substring", 1: "fuzzy" };
export const TIER_RANK: Record<MatchTier, number> = { exact: 4, prefix: 3, substring: 2, fuzzy: 1 };

type PWord = { start: number; end: number; lit: string; tr: string[]; sk: string[] };
export type PreparedText = { text: string; words: PWord[] };
type QWord = { lit: string; tr: string[]; sk: string[]; len: number };
type QVariant = { words: QWord[]; penalty: number };
export type PreparedQuery = { raw: string; variants: QVariant[]; empty: boolean };

export type MatchResult = {
  /** Higher is better. Comparable across texts for the same query. */
  score: number;
  /** Weakest word's tier (the whole match is only as good as its worst word). */
  tier: MatchTier;
  /** [start, end) of the matched words in the original text — for highlighting. */
  ranges: [number, number][];
};

const LAYOUT_PENALTY = 3;
const LEVEL_BONUS = { lit: 4, tr: 2, sk: 0 } as const;

function prepWord(text: string, start = 0, end = text.length): PWord {
  const tr = translitVariants(text).filter(Boolean);
  return { start, end, lit: literal(text), tr, sk: [...new Set(tr.map(skeleton))] };
}

const textCache = new Map<string, PreparedText>();
const CACHE_MAX = 5000;

/** Tokenised + normalised text (memoised: the same names are matched on every keystroke). */
export function prepareText(text: string): PreparedText {
  const hit = textCache.get(text);
  if (hit) return hit;
  const p: PreparedText = { text, words: tokenize(text).map((t) => prepWord(t.text, t.start, t.end)) };
  if (textCache.size >= CACHE_MAX) textCache.clear();
  textCache.set(text, p);
  return p;
}

function qVariant(s: string, penalty: number): QVariant | null {
  const words = tokenize(s).map((t) => {
    const w = prepWord(t.text);
    return { lit: w.lit, tr: w.tr, sk: w.sk, len: Math.max(w.lit.length, w.tr[0]?.length ?? 0) };
  }).filter((w) => w.lit || w.tr.length);
  return words.length ? { words, penalty } : null;
}

/** Normalise a query once, then match it against many texts. */
export function prepareQuery(raw: string): PreparedQuery {
  const q = raw.trim().slice(0, 200);
  const variants: QVariant[] = [];
  const main = qVariant(q, 0);
  if (main) variants.push(main);
  const switched = switchLayout(q);
  if (switched) {
    const v = qVariant(switched, LAYOUT_PENALTY);
    if (v) variants.push(v);
  }
  return { raw: q, variants, empty: variants.length === 0 };
}

function tierOf(q: string, c: string, allowSubstring: boolean, allowInitial = false): number {
  if (!q || !c) return 0;
  if (q === c) return 4;
  if (c.startsWith(q)) return 3;
  if (allowSubstring && q.length >= 2 && c.includes(q)) return 2;
  // Initial: «Н» in «Ольга Н.» answers «Николаева»; «B» in «Kirill B.» answers «Bondarenko».
  // Only for a later query word, so «Арт» never lands on «Глеб А.».
  if (allowInitial && c.length === 1 && q.length > 1 && q.startsWith(c)) return 2;
  return 0;
}

function maxDistance(len: number): number {
  return len >= 8 ? 2 : len >= 4 ? 1 : 0;
}

/** Best score of one query word against one text word (0 = no match). */
function wordScore(q: QWord, c: PWord, allowInitial: boolean): number {
  let best = 0;
  const consider = (tier: number, bonus: number) => {
    if (tier) best = Math.max(best, tier * 10 + bonus);
  };
  // Substring needs at least two typed letters (one keystroke «я» → translit «ya» must not hit «Илья»).
  const sub = q.lit.length >= 2;
  consider(tierOf(q.lit, c.lit, sub, allowInitial), LEVEL_BONUS.lit);
  for (const a of q.tr) for (const b of c.tr) consider(tierOf(a, b, sub, allowInitial), LEVEL_BONUS.tr);
  // Phonetic keys are loose: for 1–2 letter queries only an exact key counts (no «ал» → «Ольга»).
  const short = q.len < 3;
  for (const a of q.sk) for (const b of c.sk) {
    const t = tierOf(a, b, !short);
    consider(short && t !== 4 ? 0 : t, LEVEL_BONUS.sk);
  }
  if (best >= 20) return best;
  const maxD = maxDistance(q.len);
  if (!maxD) return best;
  for (const a of q.sk) for (const b of c.sk) {
    let d = damerauLevenshtein(a, b, maxD);
    // Still typing: compare with the start of a longer word («Рахмту» ≈ «Рахмат…»).
    if (d > maxD && b.length > a.length) d = Math.min(d, damerauLevenshtein(a, b.slice(0, a.length), maxD), damerauLevenshtein(a, b.slice(0, a.length + 1), maxD));
    if (d <= maxD) best = Math.max(best, 10 + (maxD - d) * 2 - (d > 0 ? 1 : 0));
  }
  return best;
}

function matchVariant(v: QVariant, t: PreparedText): MatchResult | null {
  let min = Infinity;
  let sum = 0;
  const ranges: [number, number][] = [];
  for (const [qi, q] of v.words.entries()) {
    let best = 0;
    let at: PWord | null = null;
    for (const c of t.words) {
      const s = wordScore(q, c, qi > 0);
      if (s > best) { best = s; at = c; }
    }
    if (!best || !at) return null;
    min = Math.min(min, best);
    sum += best;
    if (!ranges.some(([s]) => s === at!.start)) ranges.push([at.start, at.end]);
  }
  const tier = TIER_NAME[Math.floor(min / 10)] ?? "fuzzy";
  ranges.sort((a, b) => a[0] - b[0]);
  return { score: min + sum / v.words.length / 100 - v.penalty, tier, ranges };
}

/** Match a (prepared) query against one text. Empty query → null (callers decide whether to show everything). */
export function matchText(query: PreparedQuery | string, text: string | null | undefined): MatchResult | null {
  const q = typeof query === "string" ? prepareQuery(query) : query;
  if (q.empty || !text) return null;
  const t = prepareText(text);
  if (!t.words.length) return null;
  let best: MatchResult | null = null;
  for (const v of q.variants) {
    const r = matchVariant(v, t);
    if (r && (!best || r.score > best.score)) best = r;
  }
  return best;
}

/** True when the query is empty or matches any of the texts — drop-in for `name.toLowerCase().includes(q)` filters. */
export function matchesAny(query: PreparedQuery | string, ...texts: (string | null | undefined)[]): boolean {
  const q = typeof query === "string" ? prepareQuery(query) : query;
  if (q.empty) return true;
  return texts.some((t) => matchText(q, t) != null);
}

export type SearchField = string | null | undefined | { text: string | null | undefined; weight?: number };

export type SearchHit<T> = MatchResult & {
  item: T;
  /** Index of the field that matched best (0 = primary). */
  field: number;
};

/**
 * Rank items by their best field. `fields(item)` lists texts in priority order; a field may carry a weight
 * (default 1; secondary fields such as curator / tier usually 0.5). Non-matching items are dropped;
 * an empty query returns every item in input order with score 0.
 */
export function searchItems<T>(
  items: readonly T[],
  query: PreparedQuery | string,
  fields: (item: T) => SearchField[],
  opts: { limit?: number; minTier?: MatchTier } = {},
): SearchHit<T>[] {
  const q = typeof query === "string" ? prepareQuery(query) : query;
  if (q.empty) {
    const all = items.map((item) => ({ item, score: 0, tier: "exact" as MatchTier, ranges: [], field: -1 }));
    return opts.limit ? all.slice(0, opts.limit) : all;
  }
  const minRank = opts.minTier ? TIER_RANK[opts.minTier] : 1;
  const hits: (SearchHit<T> & { order: number })[] = [];
  items.forEach((item, order) => {
    let best: SearchHit<T> | null = null;
    fields(item).forEach((f, i) => {
      const text = typeof f === "object" && f !== null ? f.text : f;
      const weight = typeof f === "object" && f !== null ? f.weight ?? 1 : 1;
      const r = matchText(q, text);
      if (!r || TIER_RANK[r.tier] < minRank) return;
      const score = r.score * weight;
      if (!best || score > best.score) best = { ...r, score, item, field: i };
    });
    if (best) hits.push({ ...(best as SearchHit<T>), order });
  });
  hits.sort((a, b) => b.score - a.score || a.order - b.order);
  const out = hits.map(({ order: _o, ...h }) => h);
  return opts.limit ? out.slice(0, opts.limit) : out;
}

/** Split a text into plain / highlighted segments using match ranges. */
export function highlightSegments(text: string, ranges: readonly [number, number][] | null | undefined): { text: string; hit: boolean }[] {
  if (!ranges?.length) return [{ text, hit: false }];
  const out: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const [s, e] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (s > at) out.push({ text: text.slice(at, s), hit: false });
    if (e > Math.max(s, at)) out.push({ text: text.slice(Math.max(s, at), e), hit: true });
    at = Math.max(at, e);
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}
