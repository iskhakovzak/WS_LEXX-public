/**
 * Статистика для «Поведения и сетапов» — чистые функции без I/O.
 *   wilson()        — 95% доверительный интервал Уилсона для доли (win rate = W/(W+L)).
 *   bootstrapMean() — 95% перцентильный бутстрап-интервал среднего (ожидание $ на сделку).
 * Бутстрап детерминирован (mulberry32 с сидом от ключа): одинаковые данные → одинаковый интервал при каждом запросе.
 */

export const SMALL_SAMPLE = 20;

/** Интервал Уилсона для k успехов из n (z = 1.96 → 95%). null при n = 0. */
export function wilson(k: number, n: number, z = 1.96): { low: number; high: number } | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** Детерминированный PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedOf(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * 95% бутстрап-интервал среднего: `iters` повторных выборок с возвращением, перцентили 2.5 / 97.5.
 * null при n < 2 (интервал не определён).
 */
export function bootstrapMean(values: number[], key = "", iters = 2000): { low: number; high: number } | null {
  const n = values.length;
  if (n < 2) return null;
  const rnd = mulberry32(seedOf(`${key}|${n}`));
  const means = new Float64Array(iters);
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += values[(rnd() * n) | 0];
    means[i] = s / n;
  }
  means.sort();
  const at = (q: number) => means[Math.min(iters - 1, Math.max(0, Math.round(q * (iters - 1))))];
  return { low: round2(at(0.025)), high: round2(at(0.975)) };
}

export const round2 = (v: number) => Math.round(v * 100) / 100;
